import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outputFile = path.join(root, "data", "kol-data.js");
const profileImagesFile = path.join(root, "data", "profile-images.json");

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
  const profileImages = await loadProfileImages();
  const records = applyProfileImages(normalizeRows(rows), profileImages);
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
    .filter((row) => row.some((cell) => text(cell)))
    .map((row) =>
      Object.fromEntries(headers.map((header, index) => [text(header) || "col_" + (index + 1), row[index] ?? ""])),
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
  const records = rows
    .map((row, index) => normalizeRecord(row, index))
    .filter((record) => record.creator);
  return aggregateRecords(records);
}

function normalizeRecord(row, index) {
  const normalized = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [normalizeKey(key), value]),
  );
  const get = (...names) => {
    for (const name of names) {
      if (row[name] !== undefined && row[name] !== null && text(row[name])) return row[name];
    }
    for (const name of names) {
      const value = normalized[normalizeKey(name)];
      if (value !== undefined && value !== null && text(value)) return value;
    }
    return "";
  };

  const creator = text(get("creator", "KOL", "KOL \uC774\uB984", "\uC774\uB984", "\uB2C9\uB124\uC784", "\u4E3B\u64AD", "\u8FBE\u4EBA", "kol_name"));
  const latestDate = text(get("latestDate", "Latest", "\uCD5C\uADFC \uBC29\uC1A1", "\uCD5C\uADFC\uBC29\uC1A1", "\uBC29\uC1A1 \uB0A0\uC9DC", "\uBC29\uC1A1\uB0A0\uC9DC", "\uB0A0\uC9DC"));
  const rawStreams = number(get("streams", "Play", "\uD50C\uB808\uC774 \uD69F\uC218", "\uD50C\uB808\uC774", "\uBC29\uC1A1 \uD69F\uC218", "\uBC29\uC1A1 \uC218", "\uBC29\uC1A1\uC218"));
  const isStreamRecord = Boolean(latestDate || text(get("\uB370\uC774\uD130 \uB9C1\uD06C", "data link", "streamLink")) || text(get("\uC21C\uC704", "Rank")));
  const youtubeCell = get("youtube", "YouTube", "\uC720\uD29C\uBE0C");
  const profileImageCell = get("profileImageUrl", "profileImage", "avatarUrl", "avatar", "\uD504\uB85C\uD544 \uC774\uBBF8\uC9C0", "\uD504\uB85C\uD544\uC0AC\uC9C4", "\uC774\uBBF8\uC9C0");
  return {
    creator,
    platform: text(get("platform", "\uD50C\uB7AB\uD3FC", "\u5E73\u53F0")) || "Feishu",
    streams: rawStreams || (isStreamRecord ? 1 : 0),
    playHours: number(get("playHours", "Hours", "\uD50C\uB808\uC774 \uC2DC\uAC04", "\uBC29\uC1A1 \uC2DC\uAC04", "\uC2DC\uAC04")),
    maxViewers: number(get("maxViewers", "Peak", "\uCD5C\uACE0 \uC2DC\uCCAD\uC790", "\uCD5C\uACE0\uC2DC\uCCAD\uC790", "\uCD5C\uACE0")),
    avgViewers: number(get("avgViewers", "Average", "\uD3C9\uADE0 \uC2DC\uCCAD\uC790", "\uD3C9\uADE0\uC2DC\uCCAD\uC790", "\uD3C9\uADE0")),
    viewershipTotal: number(get("viewershipTotal", "Viewership", "\uBDF0\uC5B4\uC2ED", "\uB204\uC801 \uBDF0\uC5B4\uC2ED")),
    viewershipRank: number(get("viewershipRank", "Rank", "\uC21C\uC704")) || index + 1,
    notes: text(get("notes", "\uBA54\uBAA8", "\uBE44\uACE0", "\u5907\u6CE8", "\uCD5C\uADFC \uC720\uD29C\uBE0C \uB0B4\uC6A9 \uC694\uC57D", "\uC720\uD29C\uBE0C \uB0B4\uC6A9 \uC694\uC57D", "\uC694\uC57D")),
    updatedAt: text(get("updatedAt", "\uC5C5\uB370\uC774\uD2B8", "\uAC31\uC2E0\uC77C")) || new Date().toISOString(),
    latestDate,
    youtube: text(youtubeCell),
    youtubeUrl: link(youtubeCell),
    youtubeAvgViews: text(get("youtubeAvgViews", "\uC720\uD29C\uBE0C \uD3C9\uADE0 \uC870\uD68C\uC218", "\uD3C9\uADE0 \uC870\uD68C\uC218", "\uD3C9\uADE0\uC870\uD68C\uC218", "YouTube Average")),
    profileImageUrl: url(profileImageCell),
  };
}

function aggregateRecords(records) {
  const byCreator = new Map();
  for (const record of records) {
    const current = byCreator.get(record.creator);
    if (!current) {
      byCreator.set(record.creator, { ...record });
      continue;
    }

    current.streams += record.streams || 0;
    current.playHours += record.playHours || 0;
    current.maxViewers = Math.max(current.maxViewers || 0, record.maxViewers || 0);
    current.viewershipTotal += record.viewershipTotal || 0;

    if (dateOrder(record.latestDate) >= dateOrder(current.latestDate)) {
      current.latestDate = record.latestDate || current.latestDate;
      current.updatedAt = record.updatedAt || current.updatedAt;
      current.notes = record.notes || current.notes;
      current.youtube = record.youtube || current.youtube;
      current.youtubeUrl = record.youtubeUrl || current.youtubeUrl;
      current.youtubeAvgViews = record.youtubeAvgViews || current.youtubeAvgViews;
      current.profileImageUrl = record.profileImageUrl || current.profileImageUrl;
    } else {
      current.notes ||= record.notes;
      current.youtube ||= record.youtube;
      current.youtubeUrl ||= record.youtubeUrl;
      current.youtubeAvgViews ||= record.youtubeAvgViews;
      current.profileImageUrl ||= record.profileImageUrl;
    }
  }

  return [...byCreator.values()]
    .map((record) => ({
      ...record,
      playHours: roundOne(record.playHours),
      avgViewers: record.playHours > 0 ? Math.round(record.viewershipTotal / record.playHours) : record.avgViewers,
    }))
    .sort((a, b) => (b.viewershipTotal || 0) - (a.viewershipTotal || 0))
    .map((record, index) => ({ ...record, viewershipRank: index + 1 }));
}

async function loadProfileImages() {
  try {
    return JSON.parse(await fs.readFile(profileImagesFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function applyProfileImages(records, profileImages) {
  return records.map((record) => ({
    ...record,
    profileImageUrl: record.profileImageUrl || profileImages[record.creator] || "",
  }));
}

function text(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(" ").trim();
  if (typeof value === "object") {
    if (Array.isArray(value.rich_text)) return text(value.rich_text);
    if (Array.isArray(value.value)) return text(value.value);
    for (const key of ["text", "value", "name", "title", "label"]) {
      if (value[key] != null) return text(value[key]);
    }
  }
  return "";
}

function link(value) {
  if (value == null) return "";
  if (typeof value === "string") return /https?:\/\//i.test(value) ? value.trim() : "";
  if (Array.isArray(value)) return value.map(link).find(Boolean) || "";
  if (typeof value === "object") {
    if (Array.isArray(value.rich_text)) return link(value.rich_text);
    if (Array.isArray(value.value)) return link(value.value);
    for (const key of ["link", "url", "href"]) {
      if (typeof value[key] === "string" && value[key]) return value[key].trim();
    }
  }
  return "";
}

function url(value) {
  const direct = link(value);
  if (direct) return direct;
  const raw = text(value);
  return /^https?:\/\//i.test(raw) ? raw : "";
}

function number(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(text(value).replace(/,/g, "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateOrder(label) {
  const match = String(label || "").match(new RegExp("(\\d{1,2})\\.(\\d{1,2})"));
  return match ? Number(match[1]) * 100 + Number(match[2]) : 0;
}

function roundOne(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
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
