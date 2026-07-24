export function inspectFeishuValues(rawValues) {
  const values = jsonSafe(Array.isArray(rawValues) ? rawValues : []);
  const [headerRow = [], ...dataRows] = values;
  const nonemptyRows = dataRows
    .map((row, index) => ({ row: Array.isArray(row) ? row : [], index: index + 1 }))
    .filter(({ row }) => row.some(isNonemptyCell));

  return {
    headers: headerRow.map((value) => ({ value, text: cellText(value) })),
    columnCount: headerRow.length,
    nonemptyDataRowCount: nonemptyRows.length,
    lastNonemptyRowIndex: nonemptyRows.at(-1)?.index ?? 0,
    lastRows: nonemptyRows.slice(-2).map(({ row }) => row),
  };
}

export function logFeishuSheetInspection(rawValues, { enabled, log = console.log } = {}) {
  if (!enabled) return;
  log(`FEISHU_SHEET_INSPECTION=` + JSON.stringify(inspectFeishuValues(rawValues)));
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function isNonemptyCell(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(isNonemptyCell);
  if (typeof value === "object") return Object.values(value).some(isNonemptyCell);
  return false;
}

function cellText(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  if (Array.isArray(value)) return value.map(cellText).filter(Boolean).join(" ").trim();
  if (typeof value === "object") {
    if (Array.isArray(value.rich_text)) return cellText(value.rich_text);
    if (Array.isArray(value.value)) return cellText(value.value);
    for (const key of ["text", "value", "name", "title", "label"]) {
      if (value[key] != null) return cellText(value[key]);
    }
  }
  return "";
}
