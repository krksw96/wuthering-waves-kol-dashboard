import { kstDayBounds, rankSoftconItems } from "./feishu-daily-sync-lib.mjs";

const DEFAULT_API_BASE_URL = "https://v2-api-viewership.softc.one";
const DEFAULT_WEB_BASE_URL = "https://viewership.softc.one";
const DEFAULT_CATEGORY = "명조:워더링 웨이브";

export function createSoftconClient({
  apiBaseUrl = DEFAULT_API_BASE_URL,
  webBaseUrl = DEFAULT_WEB_BASE_URL,
  category = DEFAULT_CATEGORY,
  fetchImpl = globalThis.fetch,
  retryAttempts = 3,
  retryDelayMs = 1_000,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");

  async function fetchDailyRanking(date) {
    const { startDateTime, endDateTime } = kstDayBounds(date);
    const url = new URL("/creators/streamslogsummary/ranking", apiBaseUrl);
    setQuery(url, {
      categories: category,
      startDateTime,
      endDateTime,
      sort: "viewership:desc",
      page: "1",
      count: "100",
    });
    const payload = await fetchPayload(url);
    const ranked = rankSoftconItems(payload, 20);
    if (ranked.length !== 20) {
      throw new Error(`Softcon returned ${ranked.length} ranked creators; expected 20.`);
    }
    return ranked;
  }

  async function fetchSourceLink(creator, date) {
    const { id, type } = creatorIdentity(creator);
    if (!id || !type) throw new Error("Softcon creator id and type are required.");
    const { startDateTime, endDateTime } = kstDayBounds(date);
    const identity = encodeURIComponent(`${id},${type}`);
    const url = new URL(`/streamslog/group/streamid/${identity}`, apiBaseUrl);
    setQuery(url, {
      startDateTime,
      endDateTime,
      sort: "startedAt:desc",
      page: "1",
      count: "100",
    });
    const payload = await fetchPayload(url);
    const matching = payload
      .filter((stream) => Array.isArray(stream?.categories) && stream.categories.includes(category))
      .sort((left, right) => streamWeight(right) - streamWeight(left));
    const streamId = String(matching[0]?.streamId || matching[0]?.streamid || "").trim();
    const channelUrl = `${webBaseUrl.replace(/\/$/, "")}/channel/${encodeURIComponent(type)}/${encodeURIComponent(id)}/streams`;
    return streamId ? `${channelUrl}/${encodeURIComponent(streamId)}` : channelUrl;
  }

  async function fetchPayload(url) {
    for (let attempt = 0; attempt < retryAttempts; attempt += 1) {
      try {
        const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
        const body = await response.text();
        let data;
        try {
          data = JSON.parse(body);
        } catch {
          throw new Error(`Softcon returned non-JSON HTTP ${response.status}.`);
        }
        if (response.ok) {
          const payload = data?.payload;
          if (!Array.isArray(payload)) throw new Error("Softcon response did not contain a payload array.");
          return payload;
        }
        if (response.status !== 429 && response.status < 500) {
          throw new Error(`Softcon API failed with HTTP ${response.status}.`);
        }
      } catch (error) {
        if (attempt + 1 >= retryAttempts) throw error;
      }
      await delay(retryDelayMs * (2 ** attempt));
    }
    throw new Error("Softcon request failed after retries.");
  }

  return { fetchDailyRanking, fetchSourceLink };
}

function creatorIdentity(creator) {
  const combined = String(creator?.userId || "").trim();
  const separator = combined.lastIndexOf(",");
  const combinedId = separator > 0 ? combined.slice(0, separator).trim() : "";
  const combinedType = separator > 0 ? combined.slice(separator + 1).trim() : "";
  return {
    id: String(creator?.id || combinedId).trim(),
    type: String(creator?.type || creator?.platform || combinedType).trim(),
  };
}

function setQuery(url, values) {
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
}

function streamWeight(stream) {
  const viewership = Number(stream?.viewership);
  if (Number.isFinite(viewership)) return viewership;
  const sumLiveViews = Number(stream?.sumLiveViews);
  return Number.isFinite(sumLiveViews) ? sumLiveViews / 10 : 0;
}

function delay(milliseconds) {
  if (!milliseconds) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
