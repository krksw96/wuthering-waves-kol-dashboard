#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { createFeishuClient } from "./feishu-client.mjs";
import { createSoftconClient } from "./softcon-client.mjs";
import { resolveRunOptions, runDailySync } from "./sync-feishu-daily-lib.mjs";
import { createYouTubeClient } from "./youtube-client.mjs";

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  console.log(`Usage: node scripts/sync-feishu-daily.mjs [--date=YYYY-MM-DD] [--write]

Without --write, all APIs are queried but Feishu is not modified.
--write also requires FEISHU_WRITE_ENABLED=true.`);
  process.exit(0);
}

try {
  const options = resolveRunOptions({ argv, env: process.env });
  const appId = requiredEnvironment("FEISHU_APP_ID");
  const appSecret = requiredEnvironment("FEISHU_APP_SECRET");
  const youtubeApiKey = requiredEnvironment("YOUTUBE_API_KEY");
  const spreadsheetToken = process.env.FEISHU_SPREADSHEET_TOKEN || "V9C1sSLU4hOweEtvDRdcBnENnMh";
  const sheetId = process.env.FEISHU_SHEET_ID || "8KTfQn";
  const channelMap = JSON.parse(await readFile(
    new URL("../data/youtube-channels.json", import.meta.url),
    "utf8",
  ));

  const feishu = createFeishuClient({
    appId,
    appSecret,
    spreadsheetToken,
    baseUrl: process.env.FEISHU_API_BASE_URL || "https://open.feishu.cn",
  });
  const softcon = createSoftconClient();
  const youtube = createYouTubeClient({ apiKey: youtubeApiKey, channelMap });
  const result = await runDailySync({
    feishu,
    softcon,
    youtube,
    sheetId,
    targetDate: options.targetDate,
    write: options.write,
  });

  const summary = {
    action: result.action,
    targetDate: result.targetDate,
    rowCount: result.rowCount,
    ...(result.verifiedCells == null ? {} : { verifiedCells: result.verifiedCells }),
    creators: (result.rows || []).map((row) => row[2]),
  };
  console.log(`FEISHU_DAILY_SYNC=${JSON.stringify(summary)}`);
} catch (error) {
  console.error(`FEISHU_DAILY_SYNC_ERROR=${error?.message || String(error)}`);
  process.exitCode = 1;
}

function requiredEnvironment(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}
