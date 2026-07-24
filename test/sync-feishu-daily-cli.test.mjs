import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("../scripts/sync-feishu-daily.mjs", import.meta.url));

test("daily sync CLI exposes safe help without requiring credentials", () => {
  const result = spawnSync(process.execPath, [scriptPath, "--help"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH || "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--date=YYYY-MM-DD/);
  assert.match(result.stdout, /--write/);
  assert.doesNotMatch(result.stdout, /app_secret|api[_ -]?key/i);
});
