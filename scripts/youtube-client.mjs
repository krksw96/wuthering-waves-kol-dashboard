const API_BASE_URL = "https://www.googleapis.com/youtube/v3/";

export function createYouTubeClient({
  apiKey,
  channelMap = {},
  fetchImpl = globalThis.fetch,
  retryAttempts = 3,
  retryDelayMs = 1_000,
} = {}) {
  if (!apiKey) throw new Error("YouTube apiKey is required.");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");

  async function resolveChannel(creatorName) {
    const mapping = normalizeMapping(channelMap[creatorName]);
    let preserveMappedUrl = false;
    if (mapping?.channelId) {
      return {
        channelId: mapping.channelId,
        url: mapping.url || `https://www.youtube.com/channel/${mapping.channelId}`,
        title: creatorName,
        source: "mapping",
      };
    }
    if (mapping?.url) {
      try {
        const query = channelLookupQuery(mapping);
        if (query.id) {
          return {
            channelId: query.id,
            url: mapping.url,
            title: creatorName,
            source: "mapping",
          };
        }
      } catch (error) {
        const path = new URL(mapping.url).pathname;
        if (!path.startsWith("/c/")) throw error;
        preserveMappedUrl = true;
      }
    }

    const payload = await api("search", {
      part: "snippet",
      q: creatorName,
      type: "channel",
      maxResults: "10",
      regionCode: "KR",
      relevanceLanguage: "ko",
    });
    const normalizedName = normalizeChannelTitle(creatorName);
    const matches = (payload.items || []).filter((item) => (
      normalizeChannelTitle(item?.snippet?.channelTitle) === normalizedName
      && item?.id?.channelId
    ));
    if (matches.length !== 1) {
      throw new Error(`No unique exact YouTube channel match for ${creatorName}.`);
    }
    const match = matches[0];
    const channelId = String(match.id.channelId);
    return {
      channelId,
      url: preserveMappedUrl ? mapping.url : `https://www.youtube.com/channel/${channelId}`,
      title: String(match.snippet.channelTitle),
      source: preserveMappedUrl ? "mapping-custom-search-exact" : "search-exact",
    };
  }

  async function fetchChannelMetrics(creatorName) {
    let mapping = normalizeMapping(channelMap[creatorName]);
    if (!mapping) {
      const resolved = await resolveChannel(creatorName);
      mapping = { url: resolved.url, channelId: resolved.channelId };
    }

    const channelQuery = channelLookupQuery(mapping);
    const channelPayload = await api("channels", {
      part: "snippet,statistics,contentDetails",
      ...channelQuery,
      maxResults: "1",
    });
    const channel = channelPayload.items?.[0];
    const channelId = String(channel?.id || "");
    const uploadsPlaylist = String(channel?.contentDetails?.relatedPlaylists?.uploads || "");
    if (!channelId || !uploadsPlaylist) {
      throw new Error(`YouTube channel metadata is incomplete for ${creatorName}.`);
    }

    const playlistPayload = await api("playlistItems", {
      part: "snippet,contentDetails",
      playlistId: uploadsPlaylist,
      maxResults: "50",
    });
    const uploadIds = (playlistPayload.items || [])
      .map((item) => item?.contentDetails?.videoId || item?.snippet?.resourceId?.videoId)
      .filter(Boolean);
    if (!uploadIds.length) throw new Error(`YouTube uploads playlist is empty for ${creatorName}.`);

    const videoPayload = await api("videos", {
      part: "snippet,statistics,status,liveStreamingDetails",
      id: uploadIds.slice(0, 50).join(","),
      maxResults: "50",
    });
    const byId = new Map((videoPayload.items || []).map((item) => [item.id, item]));
    const recent = uploadIds
      .map((id) => byId.get(id))
      .filter(isEligibleVideo)
      .slice(0, 6);
    if (recent.length < 6) {
      throw new Error(`YouTube returned only ${recent.length} eligible recent videos for ${creatorName}.`);
    }

    const views = recent.map((item) => Number(item.statistics.viewCount));
    return {
      channelId,
      url: mapping.url || `https://www.youtube.com/channel/${channelId}`,
      subscriberCount: channel.statistics?.hiddenSubscriberCount
        ? 0
        : Number(channel.statistics?.subscriberCount || 0),
      averageViews: Math.round(views.reduce((sum, value) => sum + value, 0) / views.length),
      recentVideoTitles: recent.map((item) => String(item.snippet?.title || "")),
      videoIds: recent.map((item) => item.id),
    };
  }

  async function api(resource, params) {
    const url = new URL(resource, API_BASE_URL);
    for (const [key, value] of Object.entries({ ...params, key: apiKey })) {
      url.searchParams.set(key, String(value));
    }

    for (let attempt = 0; attempt < retryAttempts; attempt += 1) {
      try {
        const response = await fetchImpl(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(30_000),
        });
        const text = await response.text();
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          throw youtubeError(`YouTube ${resource} returned non-JSON HTTP ${response.status}.`);
        }
        if (response.ok) return payload;
        const transient = response.status === 429 || response.status >= 500;
        if (!transient || attempt + 1 >= retryAttempts) {
          throw youtubeError(`YouTube ${resource} failed: ${payload?.error?.message || `HTTP ${response.status}`}`);
        }
      } catch (error) {
        if (error?.name === "YouTubeApiError" || attempt + 1 >= retryAttempts) throw error;
      }
      await delay(retryDelayMs * (2 ** attempt));
    }
    throw new Error(`YouTube ${resource} failed after retries.`);
  }

  return { fetchChannelMetrics, resolveChannel };
}

function normalizeChannelTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ko")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function normalizeMapping(value) {
  if (!value) return null;
  if (typeof value === "string") return { url: value };
  if (typeof value !== "object") return null;
  return {
    url: String(value.url || value.youtubeUrl || "").trim(),
    channelId: String(value.channelId || "").trim(),
  };
}

function channelLookupQuery(mapping) {
  if (mapping.channelId) return { id: mapping.channelId };
  let url;
  try {
    url = new URL(mapping.url);
  } catch {
    throw new Error(`Invalid YouTube channel URL: ${mapping.url}`);
  }
  if (!/(^|\.)youtube\.com$/i.test(url.hostname)) {
    throw new Error(`Unsupported YouTube hostname: ${url.hostname}`);
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0]?.startsWith("@")) return { forHandle: segments[0].slice(1) };
  if (segments[0] === "channel" && segments[1]) return { id: segments[1] };
  if (segments[0] === "user" && segments[1]) return { forUsername: segments[1] };
  throw new Error(`Unsupported YouTube channel URL: ${mapping.url}`);
}

function isEligibleVideo(item) {
  if (!item || item.status?.privacyStatus !== "public") return false;
  if (item.liveStreamingDetails) return false;
  if (item.snippet?.liveBroadcastContent && item.snippet.liveBroadcastContent !== "none") return false;
  const views = Number(item.statistics?.viewCount);
  return Number.isFinite(views) && views >= 0;
}

function youtubeError(message) {
  const error = new Error(message);
  error.name = "YouTubeApiError";
  return error;
}

function delay(milliseconds) {
  if (!milliseconds) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
