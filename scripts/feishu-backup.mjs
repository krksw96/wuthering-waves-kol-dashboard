import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeFeishuBackup(path, payload, now = new Date()) {
  if (!path) throw new Error("Feishu backup path is required.");
  if (!Array.isArray(payload?.matrix)) throw new Error("Feishu backup matrix is required.");
  for (const name of ["spreadsheetToken", "sheetId", "targetDate"]) {
    if (!String(payload?.[name] || "").trim()) {
      throw new Error(`Feishu backup ${name} is required.`);
    }
  }

  const backup = {
    version: 1,
    createdAt: now.toISOString(),
    spreadsheetToken: payload.spreadsheetToken,
    sheetId: payload.sheetId,
    targetDate: payload.targetDate,
    plan: payload.plan,
    matrix: payload.matrix,
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(backup, null, 2)}\n`, "utf8");
}
