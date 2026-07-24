export const HEADERS = [
  "방송 날짜",
  "순위",
  "이름",
  "유튜브",
  "유튜브 평균 조회수",
  "최근 유튜브 내용 요약",
  "방송 시간",
  "최고 시청자",
  "평균 시청자",
  "뷰어십",
  "데이터 링크",
];

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const KOREAN_WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

export function previousCompletedKstDate(now = new Date()) {
  const shifted = new Date(now.getTime() + KST_OFFSET_MS - DAY_MS);
  return shifted.toISOString().slice(0, 10);
}

export function kstDayBounds(date) {
  assertIsoDate(date);
  const start = new Date(`${date}T00:00:00.000+09:00`);
  return {
    startDateTime: start.toISOString(),
    endDateTime: new Date(start.getTime() + DAY_MS - 1).toISOString(),
  };
}

export function formatSheetDate(date) {
  assertIsoDate(date);
  const localNoon = new Date(`${date}T12:00:00.000+09:00`);
  const weekday = KOREAN_WEEKDAYS[localNoon.getUTCDay()];
  return `${date.slice(5, 7)}.${date.slice(8, 10)} (${weekday})`;
}

export function metricsFromSoftconItem(item) {
  const sumLiveViews = finiteNumber(item?.sumLiveViews, "sumLiveViews");
  const sumCount = finiteNumber(item?.sumCount, "sumCount");
  const average = finiteNumber(item?.avgLiveViews, "avgLiveViews");
  const peak = finiteNumber(item?.maxLiveViews, "maxLiveViews");
  return {
    airTime: Math.round(sumCount) / 10,
    peakViewers: Math.round(peak),
    averageViewers: Math.round(average),
    viewership: Math.round(sumLiveViews / 10),
  };
}

export function rankSoftconItems(items, limit = 20) {
  if (!Array.isArray(items)) throw new TypeError("Softcon items must be an array.");
  return items
    .filter((item) => Number.isFinite(Number(item?.sumLiveViews)) && Number(item.sumLiveViews) > 0)
    .sort((left, right) => {
      const viewershipDifference = Number(right.sumLiveViews) - Number(left.sumLiveViews);
      if (viewershipDifference) return viewershipDifference;
      const peakDifference = Number(right.maxLiveViews || 0) - Number(left.maxLiveViews || 0);
      if (peakDifference) return peakDifference;
      return String(left?.creator?.name || "").localeCompare(String(right?.creator?.name || ""), "ko");
    })
    .slice(0, limit)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

export function formatSubscriberCount(value) {
  const number = finiteNumber(value, "subscriberCount");
  if (number >= 10_000) return `${trimDecimals(number / 10_000)}w`;
  if (number >= 1_000) return `${trimDecimals(number / 1_000)}k`;
  return String(Math.round(number));
}

export function summarizeRecentTitles(titles, maxLength = 500) {
  const summary = (Array.isArray(titles) ? titles : [])
    .map((title) => safeSpreadsheetText(String(title || "").trim()))
    .filter(Boolean)
    .slice(0, 6)
    .join(" / ");
  if (summary.length <= maxLength) return summary;
  return `${summary.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function buildFeishuRow({
  date,
  rank,
  creatorName,
  youtubeUrl,
  subscriberCount,
  youtubeAverageViews,
  recentVideoTitles,
  airTime,
  peakViewers,
  averageViewers,
  viewership,
  sourceUrl,
}) {
  return [
    formatSheetDate(date),
    Math.round(finiteNumber(rank, "rank")),
    safeSpreadsheetText(String(creatorName || "").trim()),
    urlCell(formatSubscriberCount(subscriberCount), youtubeUrl),
    Math.round(finiteNumber(youtubeAverageViews, "youtubeAverageViews")),
    summarizeRecentTitles(recentVideoTitles),
    finiteNumber(airTime, "airTime"),
    Math.round(finiteNumber(peakViewers, "peakViewers")),
    Math.round(finiteNumber(averageViewers, "averageViewers")),
    Math.round(finiteNumber(viewership, "viewership")),
    urlCell("LINK", sourceUrl),
  ];
}

export function planDailyBlock(matrix, targetDate, sheetId) {
  assertIsoDate(targetDate);
  if (!sheetId) throw new Error("sheetId is required.");
  if (!Array.isArray(matrix) || !matrix.length) throw new Error("Sheet matrix is empty.");

  const headerRowIndex = matrix.findIndex((row) => {
    const values = new Set((Array.isArray(row) ? row : []).map(cellText));
    return HEADERS.every((header) => values.has(header));
  });
  if (headerRowIndex < 0) throw new Error("Expected Feishu headers were not found.");

  const headers = matrix[headerRowIndex].map(cellText);
  const dateColumn = headers.indexOf("방송 날짜");
  const rankColumn = headers.indexOf("순위");
  const targetLabel = formatSheetDate(targetDate);
  const matches = [];

  for (let index = headerRowIndex + 1; index < matrix.length; index += 1) {
    const row = Array.isArray(matrix[index]) ? matrix[index] : [];
    if (cellText(row[dateColumn]) === targetLabel) {
      matches.push({ index, rank: Number(cellText(row[rankColumn])) });
    }
  }

  if (matches.length) {
    const contiguous = matches.every((match, index) => match.index === matches[0].index + index);
    const completeRanks = matches.length === 20 && matches.every((match, index) => match.rank === index + 1);
    if (!contiguous || !completeRanks) {
      throw new Error(`Existing ${targetLabel} block is incomplete; refusing to overwrite it.`);
    }
    return {
      action: "noop",
      reason: "date-already-complete",
      startRow: matches[0].index + 1,
    };
  }

  const firstDataRow = matrix
    .slice(headerRowIndex + 1)
    .find((row) => cellText(Array.isArray(row) ? row[dateColumn] : ""));
  if (firstDataRow) {
    const latestDate = parseSheetDate(cellText(firstDataRow[dateColumn]), targetDate.slice(0, 4));
    if (latestDate && targetDate <= latestDate) {
      throw new Error(`Historical gap detected for ${targetDate}; refusing an out-of-order insert.`);
    }
  }

  return {
    action: "insert",
    dimensionRange: {
      sheetId,
      majorDimension: "ROWS",
      startIndex: headerRowIndex + 1,
      endIndex: headerRowIndex + 21,
    },
    writeRange: `${sheetId}!A${headerRowIndex + 2}:K${headerRowIndex + 21}`,
  };
}

function urlCell(text, link) {
  const normalized = String(link || "").trim();
  if (!/^https:\/\//i.test(normalized)) throw new Error(`Expected an HTTPS link for ${text}.`);
  return { text: String(text), link: normalized, type: "url" };
}

function safeSpreadsheetText(value) {
  if (/^[=+\-@]/.test(value)) return `'${value}`;
  return value;
}

function parseSheetDate(value, year) {
  const match = /^(\d{2})\.(\d{2})/.exec(value);
  return match ? `${year}-${match[1]}-${match[2]}` : "";
}

function cellText(value) {
  if (value == null) return "";
  if (typeof value === "object") {
    return cellText(value.text ?? value.value ?? value.name ?? value.label ?? "");
  }
  return String(value).trim();
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number.`);
  return number;
}

function trimDecimals(value) {
  return value.toFixed(2).replace(/\.0+$|(?<=\.[0-9])0$/, "");
}

function assertIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new Error(`Invalid ISO date: ${value}`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid ISO date: ${value}`);
  }
}
