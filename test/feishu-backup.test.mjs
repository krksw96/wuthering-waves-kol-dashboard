import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeFeishuBackup } from "../scripts/feishu-backup.mjs";

test("writes a restorable Feishu value backup before mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-backup-"));
  const path = join(directory, "nested", "backup.json");
  try {
    await writeFeishuBackup(path, {
      matrix: [["방송 날짜", "순위"], ["07.23 (목)", 1]],
      plan: { action: "insert", writeRange: "8KTfQn!A2:K21" },
      spreadsheetToken: "V9C1sSLU4hOweEtvDRdcBnENnMh",
      sheetId: "8KTfQn",
      targetDate: "2026-07-24",
    }, new Date("2026-07-24T16:30:00.000Z"));

    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      version: 1,
      createdAt: "2026-07-24T16:30:00.000Z",
      spreadsheetToken: "V9C1sSLU4hOweEtvDRdcBnENnMh",
      sheetId: "8KTfQn",
      targetDate: "2026-07-24",
      plan: { action: "insert", writeRange: "8KTfQn!A2:K21" },
      matrix: [["방송 날짜", "순위"], ["07.23 (목)", 1]],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
