import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectFeishuValues,
  logFeishuSheetInspection,
} from "../scripts/feishu-sheet-inspection.mjs";

test("inspection preserves object-valued headers, links, and ignores blank trailing rows", () => {
  const linkCell = { link: "https://example.com/creator", text: "Creator page" };
  const values = [
    [{ text: "Creator" }, { value: [{ text: "Channel" }] }],
    ["Alpha", { link: "https://example.com/alpha", text: "Alpha channel" }],
    ["Beta", linkCell],
    ["", null],
    [],
  ];

  assert.deepEqual(inspectFeishuValues(values), {
    headers: [
      { value: { text: "Creator" }, text: "Creator" },
      { value: { value: [{ text: "Channel" }] }, text: "Channel" },
    ],
    columnCount: 2,
    nonemptyDataRowCount: 2,
    lastNonemptyRowIndex: 2,
    lastRows: [
      ["Alpha", { link: "https://example.com/alpha", text: "Alpha channel" }],
      ["Beta", linkCell],
    ],
  });
});

test("disabled inspection does not log", () => {
  const lines = [];

  logFeishuSheetInspection([["Creator"], ["Alpha"]], {
    enabled: false,
    log: (line) => lines.push(line),
  });

  assert.deepEqual(lines, []);
});

test("enabled inspection logs one compact prefixed JSON line", () => {
  const lines = [];

  logFeishuSheetInspection([["Creator"], ["Alpha"]], {
    enabled: true,
    log: (line) => lines.push(line),
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0], /^FEISHU_SHEET_INSPECTION=\{.*\}$/);
  assert.equal(lines[0].includes("\n"), false);
});
