import assert from "node:assert/strict";
import test from "node:test";

import {
  HEADERS,
  buildFeishuRow,
  formatSheetDate,
  formatSubscriberCount,
  kstDayBounds,
  metricsFromSoftconItem,
  planDailyBlock,
  previousCompletedKstDate,
  rankSoftconItems,
  summarizeRecentTitles,
} from "../scripts/feishu-daily-sync-lib.mjs";

const expectedHeaders = [
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

test("uses the previous fully completed KST date", () => {
  assert.equal(previousCompletedKstDate(new Date("2026-07-24T14:59:59.000Z")), "2026-07-23");
  assert.equal(previousCompletedKstDate(new Date("2026-07-24T16:30:00.000Z")), "2026-07-24");
});

test("builds exact KST day boundaries without overlap", () => {
  assert.deepEqual(kstDayBounds("2026-07-23"), {
    startDateTime: "2026-07-22T15:00:00.000Z",
    endDateTime: "2026-07-23T14:59:59.999Z",
  });
  assert.equal(formatSheetDate("2026-07-23"), "07.23 (목)");
});

test("reproduces the existing Softcon rounding rules", () => {
  const metrics = metricsFromSoftconItem({
    sumLiveViews: 15269,
    sumCount: 31,
    avgLiveViews: 493.2,
    maxLiveViews: 2027,
  });
  assert.deepEqual(metrics, {
    airTime: 3.1,
    peakViewers: 2027,
    averageViewers: 493,
    viewership: 1527,
  });
});

test("sorts by precise viewership samples before assigning the top 20 ranks", () => {
  const items = Array.from({ length: 22 }, (_, index) => ({
    creator: { name: `Creator ${index + 1}`, id: `id-${index + 1}`, type: "naverchzzk" },
    sumLiveViews: index === 0 ? 1000 : 10000 - index,
    sumCount: 10,
    avgLiveViews: 100,
    maxLiveViews: 200,
  }));
  const ranked = rankSoftconItems(items);
  assert.equal(ranked.length, 20);
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[0].creator.name, "Creator 2");
  assert.equal(ranked[19].rank, 20);
  assert.equal(ranked.some((entry) => entry.creator.name === "Creator 1"), false);
});

test("formats subscriber counts in the sheet's existing w/k style", () => {
  assert.equal(formatSubscriberCount(2_530_000), "253w");
  assert.equal(formatSubscriberCount(484_000), "48.4w");
  assert.equal(formatSubscriberCount(5_810), "5.81k");
  assert.equal(formatSubscriberCount(478), "478");
});

test("builds the exact 11-column row with Feishu URL cell objects", () => {
  assert.deepEqual(HEADERS, expectedHeaders);
  const row = buildFeishuRow({
    date: "2026-07-23",
    rank: 1,
    creatorName: "쉐리",
    youtubeUrl: "https://www.youtube.com/@shelly",
    subscriberCount: 484_000,
    youtubeAverageViews: 157_000,
    recentVideoTitles: ["첫 영상", "둘째 영상"],
    airTime: 3.1,
    peakViewers: 2027,
    averageViewers: 493,
    viewership: 1527,
    sourceUrl: "https://viewership.softc.one/channel/naverchzzk/id/streams/stream-id",
  });

  assert.deepEqual(row, [
    "07.23 (목)",
    1,
    "쉐리",
    { text: "48.4w", link: "https://www.youtube.com/@shelly", type: "url" },
    157000,
    "첫 영상 / 둘째 영상",
    3.1,
    2027,
    493,
    1527,
    {
      text: "LINK",
      link: "https://viewership.softc.one/channel/naverchzzk/id/streams/stream-id",
      type: "url",
    },
  ]);
});

test("limits recent-title summaries and neutralizes formula-like titles", () => {
  const summary = summarizeRecentTitles(["=IMPORTXML('x')", "정상 제목", "세 번째"], 22);
  assert.equal(summary, "'=IMPORTXML('x') / 정상…");
});

test("plans an idempotent top insertion and refuses historical gaps", () => {
  const latestBlock = Array.from({ length: 20 }, (_, index) => ["07.23 (목)", index + 1]);
  const matrix = [HEADERS, ...latestBlock, ["07.22 (수)", 1]];

  assert.deepEqual(planDailyBlock(matrix, "2026-07-24", "8KTfQn"), {
    action: "insert",
    dimensionRange: { sheetId: "8KTfQn", majorDimension: "ROWS", startIndex: 1, endIndex: 21 },
    writeRange: "8KTfQn!A2:K21",
  });
  assert.deepEqual(planDailyBlock(matrix, "2026-07-23", "8KTfQn"), {
    action: "noop",
    reason: "date-already-complete",
    startRow: 2,
  });
  assert.throws(() => planDailyBlock(matrix, "2026-07-21", "8KTfQn"), /historical gap/i);
});
