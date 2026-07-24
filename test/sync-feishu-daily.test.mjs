import assert from "node:assert/strict";
import test from "node:test";

import { HEADERS } from "../scripts/feishu-daily-sync-lib.mjs";
import { resolveRunOptions, runDailySync } from "../scripts/sync-feishu-daily-lib.mjs";

function existingSheet(dateLabel = "07.23 (목)") {
  return [
    HEADERS,
    ...Array.from({ length: 20 }, (_, index) => [dateLabel, index + 1]),
    ["07.22 (수)", 1],
  ];
}

function rankingFixture() {
  return Array.from({ length: 20 }, (_, index) => ({
    rank: index + 1,
    creator: {
      name: `Creator ${index + 1}`,
      userId: `creator-${index + 1},naverchzzk`,
      type: "naverchzzk",
    },
    sumLiveViews: 20_000 - index * 100,
    sumCount: 31,
    avgLiveViews: 493.2,
    maxLiveViews: 2027,
  }));
}

test("daily sync dry-run collects exactly 20 complete rows without changing Feishu", async () => {
  const writes = [];
  const feishu = {
    readMatrix: async () => existingSheet(),
    insertRows: async (...args) => writes.push(["insert", ...args]),
    writeRange: async (...args) => writes.push(["write", ...args]),
    deleteRows: async (...args) => writes.push(["delete", ...args]),
  };
  const softcon = {
    fetchDailyRanking: async (date) => {
      assert.equal(date, "2026-07-24");
      return rankingFixture();
    },
    fetchSourceLink: async (creator, date) => (
      `https://viewership.softc.one/channel/${creator.type}/${creator.userId.split(",")[0]}/streams/${date}`
    ),
  };
  const youtube = {
    fetchChannelMetrics: async (creatorName) => ({
      channelId: `channel-${creatorName}`,
      url: `https://www.youtube.com/@${encodeURIComponent(creatorName)}`,
      subscriberCount: 484_000,
      averageViews: 157_000,
      recentVideoTitles: ["첫 영상", "둘째 영상", "셋째 영상", "넷째 영상", "다섯째 영상", "여섯째 영상"],
      videoIds: ["1", "2", "3", "4", "5", "6"],
    }),
  };

  const result = await runDailySync({
    feishu,
    softcon,
    youtube,
    sheetId: "8KTfQn",
    targetDate: "2026-07-24",
    write: false,
  });

  assert.equal(result.action, "dry-run");
  assert.equal(result.rowCount, 20);
  assert.equal(result.rows.length, 20);
  assert.equal(result.rows[0].length, 11);
  assert.deepEqual(result.rows[0].slice(0, 3), ["07.24 (금)", 1, "Creator 1"]);
  assert.equal(result.rows[0][10].text, "LINK");
  assert.deepEqual(writes, []);
});

test("daily sync inserts with AFTER style inheritance and verifies all 220 written cells", async () => {
  const calls = [];
  let writtenRows = null;
  let readCount = 0;
  const feishu = {
    readMatrix: async () => {
      readCount += 1;
      if (readCount === 1) return existingSheet();
      return writtenRows.map((row) => row.map((cell) => (
        cell && typeof cell === "object" ? cell.text : cell
      )));
    },
    insertRows: async (dimension, inheritStyle) => calls.push({ type: "insert", dimension, inheritStyle }),
    writeRange: async (range, rows) => {
      writtenRows = rows;
      calls.push({ type: "write", range });
    },
    deleteRows: async (dimension) => calls.push({ type: "delete", dimension }),
  };
  const softcon = {
    fetchDailyRanking: async () => rankingFixture(),
    fetchSourceLink: async (creator) => (
      `https://viewership.softc.one/channel/${creator.type}/${creator.userId.split(",")[0]}/streams/live`
    ),
  };
  const youtube = {
    fetchChannelMetrics: async (name) => ({
      channelId: `channel-${name}`,
      url: `https://www.youtube.com/@${encodeURIComponent(name)}`,
      subscriberCount: 10_000,
      averageViews: 1_000,
      recentVideoTitles: ["1", "2", "3", "4", "5", "6"],
      videoIds: ["1", "2", "3", "4", "5", "6"],
    }),
  };

  const result = await runDailySync({
    feishu,
    softcon,
    youtube,
    sheetId: "8KTfQn",
    targetDate: "2026-07-24",
    write: true,
  });

  assert.equal(result.action, "written");
  assert.equal(result.verifiedCells, 220);
  assert.deepEqual(calls.map((call) => call.type), ["insert", "write"]);
  assert.equal(calls[0].inheritStyle, "AFTER");
  assert.deepEqual(calls[0].dimension, {
    sheetId: "8KTfQn",
    majorDimension: "ROWS",
    startIndex: 1,
    endIndex: 21,
  });
  assert.equal(calls[1].range, "8KTfQn!A2:K21");
});

test("daily sync rolls back the inserted 20 rows when writing fails", async () => {
  const calls = [];
  const feishu = {
    readMatrix: async () => existingSheet(),
    insertRows: async (dimension, inheritStyle) => calls.push({ type: "insert", dimension, inheritStyle }),
    writeRange: async () => {
      calls.push({ type: "write" });
      throw new Error("simulated write failure");
    },
    deleteRows: async (dimension) => calls.push({ type: "delete", dimension }),
  };
  const softcon = {
    fetchDailyRanking: async () => rankingFixture(),
    fetchSourceLink: async (creator) => (
      `https://viewership.softc.one/channel/${creator.type}/${creator.userId.split(",")[0]}/streams/live`
    ),
  };
  const youtube = {
    fetchChannelMetrics: async (name) => ({
      url: `https://www.youtube.com/@${encodeURIComponent(name)}`,
      subscriberCount: 1,
      averageViews: 1,
      recentVideoTitles: ["1", "2", "3", "4", "5", "6"],
    }),
  };

  await assert.rejects(() => runDailySync({
    feishu,
    softcon,
    youtube,
    sheetId: "8KTfQn",
    targetDate: "2026-07-24",
    write: true,
  }), /simulated write failure/);

  assert.deepEqual(calls.map((call) => call.type), ["insert", "write", "delete"]);
  assert.deepEqual(calls[2].dimension, calls[0].dimension);
});

test("write mode requires both the CLI flag and an explicit environment gate", () => {
  const now = new Date("2026-07-24T16:30:00.000Z");
  assert.deepEqual(resolveRunOptions({ argv: [], env: {}, now }), {
    targetDate: "2026-07-24",
    write: false,
  });
  assert.throws(
    () => resolveRunOptions({ argv: ["--write"], env: {}, now }),
    /FEISHU_WRITE_ENABLED=true/,
  );
  assert.deepEqual(resolveRunOptions({
    argv: ["--write", "--date=2026-07-23"],
    env: { FEISHU_WRITE_ENABLED: "true" },
    now,
  }), {
    targetDate: "2026-07-23",
    write: true,
  });
});
