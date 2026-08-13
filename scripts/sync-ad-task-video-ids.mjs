import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outputFile = path.join(root, "data", "ad-task-video-ids.json");
const baseUrl = String(process.env.KURO_BASE_URL || "https://ai-gateway.kurogames.com").replace(/\/$/, "");
const apiKey = process.env.KURO_API_KEY || "";
const appId = process.env.FEISHU_APP_ID || "";
const appSecret = process.env.FEISHU_APP_SECRET || "";
const spreadsheetToken = process.env.FEISHU_SPREADSHEET_TOKEN || "V9C1sSLU4hOweEtvDRdcBnENnMh";
const sheetId = process.env.FEISHU_AD_SHEET_ID || "0GfgFb";
const range = process.env.FEISHU_AD_RANGE || "B:K";

const gatewayHeaders = apiKey ? { "X-API-Key": apiKey } : {};
let values;
if (process.env.AD_TASK_SNAPSHOT_FILE) {
  const snapshot = JSON.parse((await fs.readFile(process.env.AD_TASK_SNAPSHOT_FILE, "utf8")).replace(/^\uFEFF/, ""));
  values = parseCsv(snapshot?.data?.annotated_csv || "");
} else {
  if (!appId || !appSecret) throw new Error("FEISHU_APP_ID and FEISHU_APP_SECRET are required");
  const tokenResponse = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", ...gatewayHeaders },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const tokenPayload = await tokenResponse.json();
  if (!tokenResponse.ok || tokenPayload.code !== 0 || !tokenPayload.tenant_access_token) {
    throw new Error(`Feishu token request failed (${tokenResponse.status}/${tokenPayload.code ?? "unknown"})`);
  }
  const valueRange = encodeURIComponent(`${sheetId}!${range}`);
  const response = await fetch(`${baseUrl}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${valueRange}`, {
    headers: { Authorization: `Bearer ${tokenPayload.tenant_access_token}`, ...gatewayHeaders },
  });
  const payload = await response.json();
  if (!response.ok || payload.code !== 0) throw new Error(`Feishu values request failed (${response.status}/${payload.code ?? "unknown"})`);
  values = payload?.data?.valueRange?.values || payload?.data?.values || payload?.values || [];
}
const youtubeIdFrom = (value) => {
  const text = String(value ?? "").trim();
  if (/^[\w-]{11}$/.test(text)) return text;
  return text.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|live\/))([\w-]{11})/i)?.[1] || "";
};

// B:K => video ID=B(0), link=G(5), channel=I(7), title=K(9).
const rows = values.slice(2).map((row) => ({
  youtubeId: youtubeIdFrom(row[5]) || youtubeIdFrom(row[0]),
  link: String(row[5] || "").trim(),
  channelTitle: String(row[7] || "").trim(),
  title: String(row[9] || "").trim(),
})).filter((row) => row.youtubeId);
const uniqueRows = [...new Map(rows.map((row) => [row.youtubeId, row])).values()];
if (!uniqueRows.length) throw new Error("Advertising-task sheet returned no YouTube links");

// Some manually entered hyperlink cells are visible to users but occasionally
// arrive blank through the app OpenAPI. Preserve previously confirmed links so
// a scheduled sync cannot silently remove their advertising-task tags.
const previous = JSON.parse(await fs.readFile(outputFile, "utf8").catch(() => '{"rows":[]}'));
const mergedRows = [...new Map([
  ...(previous.rows || []).map((row) => [row.youtubeId, row]),
  ...uniqueRows.map((row) => [row.youtubeId, row]),
]).values()];

await fs.mkdir(path.dirname(outputFile), { recursive: true });
await fs.writeFile(outputFile, `${JSON.stringify({
  meta: { syncedAt: new Date().toISOString(), spreadsheetToken, sheetId, range, resultCount: mergedRows.length },
  rows: mergedRows,
}, null, 2)}\n`, "utf8");
console.log(`Wrote ${mergedRows.length} advertising-task video IDs to ${outputFile}`);

function parseCsv(csv) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i], next = csv[i + 1];
    if (quoted && char === '"' && next === '"') { cell += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === ",") { row.push(cell); cell = ""; }
    else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += char;
  }
  row.push(cell); if (row.some(Boolean)) rows.push(row);
  return rows.map((values) => {
    values[0] = String(values[0] || "").replace(/^\[row=\d+\]\s*/, "");
    return values;
  });
}
