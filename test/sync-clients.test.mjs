import assert from "node:assert/strict";
import test from "node:test";

import { createFeishuClient } from "../scripts/feishu-client.mjs";
import { createSoftconClient } from "../scripts/softcon-client.mjs";
import { createYouTubeClient } from "../scripts/youtube-client.mjs";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Feishu client reads, inserts, writes, verifies, and deletes with exact v2 payloads", async () => {
  const requests = [];
  const responses = [
    { code: 0, tenant_access_token: "tenant-token" },
    { code: 0, data: { valueRange: { values: [["방송 날짜", "순위"]] } } },
    { code: 0, data: { updatedRange: "8KTfQn!2:21" } },
    { code: 0, data: { updatedCells: 220, updatedRange: "8KTfQn!A2:K21" } },
    { code: 0, data: { valueRange: { values: [["07.24 (금)", 1]] } } },
    { code: 0, data: { updatedRange: "8KTfQn!2:21" } },
  ];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return jsonResponse(responses.shift());
  };
  const client = createFeishuClient({
    appId: "app-id",
    appSecret: "app-secret",
    spreadsheetToken: "spreadsheet-token",
    baseUrl: "https://open.feishu.cn",
    fetchImpl,
    retryDelayMs: 0,
  });

  assert.deepEqual(await client.readMatrix("8KTfQn!A:K"), [["방송 날짜", "순위"]]);
  const dimension = { sheetId: "8KTfQn", majorDimension: "ROWS", startIndex: 1, endIndex: 21 };
  await client.insertRows(dimension, "BEFORE");
  await client.writeRange("8KTfQn!A2:K21", [["07.24 (금)", 1]]);
  assert.deepEqual(await client.readMatrix("8KTfQn!A2:K21"), [["07.24 (금)", 1]]);
  await client.deleteRows(dimension);

  assert.equal(requests[0].url, "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal");
  assert.equal(requests[0].options.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].options.body), { app_id: "app-id", app_secret: "app-secret" });
  assert.match(requests[1].url, /values\/8KTfQn!A%3AK$/);
  assert.equal(requests[1].options.headers.Authorization, "Bearer tenant-token");
  assert.equal(requests[2].options.method, "POST");
  assert.deepEqual(JSON.parse(requests[2].options.body), { dimension, inheritStyle: "BEFORE" });
  assert.equal(requests[3].options.method, "PUT");
  assert.deepEqual(JSON.parse(requests[3].options.body), {
    valueRange: { range: "8KTfQn!A2:K21", values: [["07.24 (금)", 1]] },
  });
  assert.equal(requests[5].options.method, "PUT");
  assert.deepEqual(JSON.parse(requests[5].options.body), { dimension });
});

test("Feishu client retries transient failures but not permission failures", async () => {
  let attempts = 0;
  const transientFetch = async () => {
    attempts += 1;
    if (attempts === 1) return jsonResponse({ code: 999, msg: "temporary" }, 503);
    return jsonResponse({ code: 0, tenant_access_token: "token" });
  };
  const retryingClient = createFeishuClient({
    appId: "id",
    appSecret: "secret",
    spreadsheetToken: "sheet",
    fetchImpl: transientFetch,
    retryDelayMs: 0,
  });
  await retryingClient.authenticate();
  assert.equal(attempts, 2);

  const deniedClient = createFeishuClient({
    appId: "id",
    appSecret: "secret",
    spreadsheetToken: "sheet",
    fetchImpl: async () => jsonResponse({ code: 99991672, msg: "Access denied" }, 400),
    retryDelayMs: 0,
  });
  await assert.rejects(() => deniedClient.authenticate(), /99991672.*Access denied/);
});

test("Softcon client requests a KST daily ranking and returns precise top 20", async () => {
  let requestedUrl = "";
  const payload = Array.from({ length: 21 }, (_, index) => ({
    creator: { name: `Creator ${index + 1}`, id: `id-${index + 1}`, type: "naverchzzk" },
    sumLiveViews: 10_000 - index,
    sumCount: 20,
    avgLiveViews: 500,
    maxLiveViews: 1000,
  }));
  const client = createSoftconClient({
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return jsonResponse({ payload, meta: { totalCount: 21 } });
    },
    retryDelayMs: 0,
  });

  const ranking = await client.fetchDailyRanking("2026-07-23");
  const url = new URL(requestedUrl);
  assert.equal(url.pathname, "/creators/streamslogsummary/ranking");
  assert.equal(url.searchParams.get("categories"), "명조:워더링 웨이브");
  assert.equal(url.searchParams.get("startDateTime"), "2026-07-22T15:00:00.000Z");
  assert.equal(url.searchParams.get("endDateTime"), "2026-07-23T14:59:59.999Z");
  assert.equal(url.searchParams.get("sort"), "viewership:desc");
  assert.equal(ranking.length, 20);
  assert.equal(ranking[0].rank, 1);
});

test("Softcon client selects the strongest matching stream source link", async () => {
  const client = createSoftconClient({
    fetchImpl: async () => jsonResponse({
      payload: [
        { streamId: "other", categories: ["다른 게임"], viewership: 9999 },
        { streamId: "weak", categories: ["명조:워더링 웨이브"], viewership: 100 },
        { streamId: "best", categories: ["명조:워더링 웨이브"], viewership: 500 },
      ],
    }),
    retryDelayMs: 0,
  });
  const link = await client.fetchSourceLink(
    { id: "creator-id", type: "naverchzzk" },
    "2026-07-23",
  );
  assert.equal(
    link,
    "https://viewership.softc.one/channel/naverchzzk/creator-id/streams/best",
  );
});

test("Softcon client parses the current creator.userId identity schema", async () => {
  let requestedUrl = "";
  const client = createSoftconClient({
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return jsonResponse({ payload: [{
        streamid: "live-stream",
        categories: ["명조:워더링 웨이브"],
        viewership: 123,
      }] });
    },
    retryDelayMs: 0,
  });
  const link = await client.fetchSourceLink(
    { userId: "creator-id,naverchzzk", type: "naverchzzk" },
    "2026-07-24",
  );
  assert.match(new URL(requestedUrl).pathname, /creator-id%2Cnaverchzzk$/i);
  assert.equal(
    link,
    "https://viewership.softc.one/channel/naverchzzk/creator-id/streams/live-stream",
  );
});

test("YouTube client averages the latest six public non-live uploads and keeps Shorts", async () => {
  const calls = [];
  const client = createYouTubeClient({
    apiKey: "yt-key",
    channelMap: { Creator: { url: "https://www.youtube.com/@creator" } },
    retryDelayMs: 0,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      calls.push(parsed);
      if (parsed.pathname.endsWith("/channels")) {
        return jsonResponse({ items: [{
          id: "channel-1",
          snippet: { title: "Creator" },
          statistics: { subscriberCount: "484000", hiddenSubscriberCount: false },
          contentDetails: { relatedPlaylists: { uploads: "uploads-1" } },
        }] });
      }
      if (parsed.pathname.endsWith("/playlistItems")) {
        return jsonResponse({
          items: Array.from({ length: 8 }, (_, index) => ({
            snippet: { resourceId: { videoId: `video-${index + 1}` } },
          })),
        });
      }
      if (parsed.pathname.endsWith("/videos")) {
        return jsonResponse({ items: Array.from({ length: 8 }, (_, index) => ({
          id: `video-${index + 1}`,
          snippet: {
            title: `Title ${index + 1}`,
            liveBroadcastContent: index === 6 ? "live" : "none",
          },
          statistics: { viewCount: String((index + 1) * 100) },
          status: { privacyStatus: index === 7 ? "private" : "public" },
          ...(index === 6 ? { liveStreamingDetails: { actualStartTime: "2026-07-01T00:00:00Z" } } : {}),
        })) });
      }
      throw new Error(`Unexpected YouTube resource: ${parsed.pathname}`);
    },
  });

  const metrics = await client.fetchChannelMetrics("Creator");
  assert.deepEqual(metrics, {
    channelId: "channel-1",
    url: "https://www.youtube.com/@creator",
    subscriberCount: 484000,
    averageViews: 350,
    recentVideoTitles: ["Title 1", "Title 2", "Title 3", "Title 4", "Title 5", "Title 6"],
    videoIds: ["video-1", "video-2", "video-3", "video-4", "video-5", "video-6"],
  });
  assert.equal(calls[0].searchParams.get("forHandle"), "creator");
  assert.equal(calls.every((url) => url.searchParams.get("key") === "yt-key"), true);
});

test("YouTube client returns zero metrics for a valid channel with no videos", async () => {
  let calls = 0;
  const client = createYouTubeClient({
    apiKey: "yt-key",
    channelMap: {
      "시아니클1945": {
        url: "https://www.youtube.com/channel/empty-channel",
        channelId: "empty-channel",
      },
    },
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ items: [{
        id: "empty-channel",
        snippet: { title: "시아니클" },
        statistics: { subscriberCount: "0", videoCount: "0" },
        contentDetails: { relatedPlaylists: { uploads: "missing-playlist" } },
      }] });
    },
  });

  assert.deepEqual(await client.fetchChannelMetrics("시아니클1945"), {
    channelId: "empty-channel",
    url: "https://www.youtube.com/channel/empty-channel",
    subscriberCount: 0,
    averageViews: 0,
    recentVideoTitles: [],
    videoIds: [],
  });
  assert.equal(calls, 1);
});

test("YouTube client resolves an unmapped creator only from an exact channel-title match", async () => {
  const client = createYouTubeClient({
    apiKey: "yt-key",
    channelMap: {},
    retryDelayMs: 0,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.pathname.endsWith("/search"), true);
      assert.equal(parsed.searchParams.get("q"), "유즈하 리코");
      return jsonResponse({ items: [
        { id: { channelId: "fan-channel" }, snippet: { channelTitle: "유즈하 리코 팬채널" } },
        { id: { channelId: "official-channel" }, snippet: { channelTitle: "유즈하 리코" } },
      ] });
    },
  });

  assert.deepEqual(await client.resolveChannel("유즈하 리코"), {
    channelId: "official-channel",
    url: "https://www.youtube.com/channel/official-channel",
    title: "유즈하 리코",
    source: "search-exact",
  });
});

test("YouTube client resolves a legacy custom /c/ mapping by exact-title search", async () => {
  const client = createYouTubeClient({
    apiKey: "yt-key",
    channelMap: { "마레 플로스": { url: "https://www.youtube.com/c/MareFlosCh" } },
    retryDelayMs: 0,
    fetchImpl: async () => jsonResponse({ items: [
      { id: { channelId: "mare-channel" }, snippet: { channelTitle: "마레 플로스" } },
    ] }),
  });

  assert.deepEqual(await client.resolveChannel("마레 플로스"), {
    channelId: "mare-channel",
    url: "https://www.youtube.com/c/MareFlosCh",
    title: "마레 플로스",
    source: "mapping-custom-search-exact",
  });
});
