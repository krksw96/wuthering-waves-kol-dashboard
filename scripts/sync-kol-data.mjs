import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outputFile = path.join(root, "data", "kol-data.js");

const env = {
  apiKey: process.env.KURO_API_KEY || "",
  baseUrl: trimSlash(process.env.KURO_BASE_URL || "https://ai-gateway.kurogames.com"),
  dataUrl: process.env.KOL_DATA_URL || "",
  feishuAppId: process.env.FEISHU_APP_ID || "",
  feishuAppSecret: process.env.FEISHU_APP_SECRET || "",
  spreadsheetToken: process.env.FEISHU_SPREADSHEET_TOKEN || "V9C1sSLU4hOweEtvDRdcBnENnMh",
  sheetId: process.env.FEISHU_SHEET_ID || "8KTfQn",
  range: process.env.FEISHU_RANGE || "A:Z",
};

async function main() {
  const rows = await loadRows();
  const records = normalizeRows(rows);
  if (!records.length) {
    throw new Error("No KOL records were produced from the sheet response.");
  }
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, `window.KOL_RECORDS = ${JSON.stringify(records)};\n`, "utf8");
  console.log(`Wrote ${records.length} KOL records to data/kol-data.js`);
}

async function loadRows() {
  if (env.dataUrl) {
    const response = await authedFetch(env.dataUrl);
    const text = await response.text();
    if (!response.ok) throw new Error(`KOL_DATA_URL request failed: ${response.status} ${text.slice(0, 180)}`);
    if (looksLikeJson(response, text)) return rowsFromJson(JSON.parse(text));
    return rowsFromCsv(text);
  }

  if (env.feishuAppId && env.feishuAppSecret) {
    return loadRowsFromFeishuOpenApi();
  }

  throw new Error(
    "Missing sheet source. Set KOL_DATA_URL, or set FEISHU_APP_ID and FEISHU_APP_SECRET for Feishu OpenAPI.",
  );
}

async function loadRowsFromFeishuOpenApi() {
  const tokenResponse = await fetch(`${env.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...apiKeyHeader(),
    },
    body: JSON.stringify({
      app_id: env.feishuAppId,
      app_secret: env.feishuAppSecret,
    }),
  });
  const tokenPayload = await tokenResponse.json();
  if (!tokenResponse.ok || tokenPayload.code !== 0) {
    throw new Error(`Feishu token request failed: ${JSON.stringify(redact(tokenPayload)).slice(0, 240)}`);
  }

  const valueRange = encodeURIComponent(`${env.sheetId}!${env.range}`);
  const valuesUrl = `${env.baseUrl}/open-apis/sheets/v2/spreadsheets/${env.spreadsheetToken}/values/${valueRange}`;
  const valuesResponse = await fetch(valuesUrl, {
    headers: {
      Authorization: `Bearer ${tokenPayload.tenant_access_token}`,
      ...apiKeyHeader(),
    },
  });
  const valuesPayload = await valuesResponse.json();
  if (!valuesResponse.ok || valuesPayload.code !== 0) {
    throw new Error(`Feishu values request failed: ${JSON.stringify(redact(valuesPayload)).slice(0, 240)}`);
  }
  return rowsFromJson(valuesPayload);
}

async function authedFetch(url) {
  return fetch(url, {
    headers: apiKeyHeader(),
  });
}

function apiKeyHeader() {
  if (!env.apiKey) return {};
  return {
    Authorization: `Bearer ${env.apiKey}`,
    "X-API-Key": env.apiKey,
  };
}

function rowsFromJson(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.records)) return payload.records;
  if (Array.isArray(payload.rows)) return payload.rows;
  if (Array.isArray(payload.values)) return tableToObjects(payload.values);
  if (Array.isArray(payload?.data?.values)) return tableToObjects(payload.data.values);
  if (Array.isArray(payload?.data?.valueRange?.values)) return tableToObjects(payload.data.valueRange.values);
  throw new Error("Unsupported sheet JSON response shape.");
}

function tableToObjects(values) {
  const [headers = [], ...rows] = values;
  return rows
    .filter((row) => row.some((cell) => String(cell ?? "").trim()))
    .map((row) =>
      Object.fromEntries(headers.map((header, index) => [String(header || `col_${index + 1}`).trim(), row[index] ?? ""])),
    );
}

function rowsFromCsv(csv) {
  const rows = parseCsv(csv);
  return tableToObjects(rows);
}

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    const next = csv[i + 1];
    if (quoted && char === '"' && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ",") {
      row.push(cell);
      cell = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

function normalizeRows(rows) {
  return rows
    .map((row, index) => normalizeRecord(row, index))
    .filter((record) => record.creator);
}

function normalizeRecord(row, index) {
  const get = (...names) => {
    for (const name of names) {
      if (row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== "") return row[name];
    }
    const normalized = Object.fromEntries(
      Object.entries(row).map(([key, value]) => [normalizeKey(key), value]),
    );
    for (const name of names) {
      const value = normalized[normalizeKey(name)];
      if (value !== undefined && value !== null && String(value).trim() !== "") return value;
    }
    return "";
  };

  const creator = text(get("creator", "KOL", "KOL 이름", "이름", "닉네임", "主播", "达人", "kol_name"));
  return {
    creator,
    platform: text(get("platform", "플랫폼", "平台")) || "Feishu",
    streams: number(get("streams", "Play", "플레이 횟수", "플레이", "방송 횟수")),
    playHours: number(get("playHours", "Hours", "플레이 시간", "방송 시간", "시간")),
    maxViewers: number(get("maxViewers", "Peak", "최고 시청자", "최고시청자", "최고")),
    avgViewers: number(get("avgViewers", "Average", "평균 시청자", "평균시청자", "평균")),
    viewershipTotal: number(get("viewershipTotal", "Viewership", "뷰어십", "누적 뷰어십")),
    viewershipRank: number(get("viewershipRank", "Rank", "랭크", "순위")) || index + 1,
    notes: text(get("notes", "메모", "비고", "备注")),
    updatedAt: text(get("updatedAt", "업데이트", "갱신일")) || new Date().toISOString(),
    latestDate: text(get("latestDate", "Latest", "최근 방송", "최근방송", "날짜")),
    youtube: text(get("youtube", "YouTube", "유튜브")),
    youtubeAvgViews: text(get("youtubeAvgViews", "평균 조회수", "평균조회수", "YouTube Average")),
  };
}

function text(value) {
  return String(value ?? "").trim();
}

function number(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value ?? "").replace(/,/g, "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[\s_()[\]{}:./-]/g, "");
}

function trimSlash(value) {
  return value.replace(/\/+$/, "");
}

function looksLikeJson(response, text) {
  return response.headers.get("content-type")?.includes("json") || text.trim().startsWith("{") || text.trim().startsWith("[");
}

function redact(payload) {
  const clone = JSON.parse(JSON.stringify(payload));
  for (const key of ["tenant_access_token", "app_secret", "api_key", "Authorization"]) {
    if (clone[key]) clone[key] = "[redacted]";
  }
  return clone;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
