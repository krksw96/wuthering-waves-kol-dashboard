import {
  buildFeishuRow,
  kstDayBounds,
  metricsFromSoftconItem,
  planDailyBlock,
  previousCompletedKstDate,
} from "./feishu-daily-sync-lib.mjs";

export function resolveRunOptions({
  argv = process.argv.slice(2),
  env = process.env,
  now = new Date(),
} = {}) {
  const writeRequested = argv.includes("--write");
  const dateArgument = argv.find((argument) => argument.startsWith("--date="));
  const targetDate = dateArgument ? dateArgument.slice("--date=".length) : previousCompletedKstDate(now);
  kstDayBounds(targetDate);
  if (writeRequested && env.FEISHU_WRITE_ENABLED !== "true") {
    throw new Error("Write mode requires FEISHU_WRITE_ENABLED=true as well as --write.");
  }
  return { targetDate, write: writeRequested };
}

export async function runDailySync({
  feishu,
  softcon,
  youtube,
  sheetId,
  targetDate,
  write = false,
  onBackup,
}) {
  if (!feishu || !softcon || !youtube) throw new Error("Feishu, Softcon, and YouTube clients are required.");
  if (!sheetId || !targetDate) throw new Error("sheetId and targetDate are required.");

  const matrix = await feishu.readMatrix(`${sheetId}!A:K`);
  const plan = planDailyBlock(matrix, targetDate, sheetId);
  if (plan.action === "noop") {
    return { ...plan, targetDate, rowCount: 20 };
  }
  if (write && typeof onBackup !== "function") {
    throw new Error("Feishu write mode requires a completed backup callback before insertion.");
  }

  const ranking = await softcon.fetchDailyRanking(targetDate);
  validateRanking(ranking);
  const rows = await Promise.all(ranking.map(async (item) => {
    const creatorName = String(item.creator?.name || "").trim();
    const [youtubeMetrics, sourceUrl] = await Promise.all([
      youtube.fetchChannelMetrics(creatorName),
      softcon.fetchSourceLink(item.creator, targetDate),
    ]);
    const metrics = metricsFromSoftconItem(item);
    return buildFeishuRow({
      date: targetDate,
      rank: item.rank,
      creatorName,
      youtubeUrl: youtubeMetrics.url,
      subscriberCount: youtubeMetrics.subscriberCount,
      youtubeAverageViews: youtubeMetrics.averageViews,
      recentVideoTitles: youtubeMetrics.recentVideoTitles,
      ...metrics,
      sourceUrl,
    });
  }));

  if (!write) {
    return {
      action: "dry-run",
      targetDate,
      rowCount: rows.length,
      rows,
      plan,
    };
  }

  const currentMatrix = await feishu.readMatrix(`${sheetId}!A:K`);
  if (JSON.stringify(currentMatrix) !== JSON.stringify(matrix)) {
    throw new Error("Feishu sheet changed during data collection; refusing to insert rows.");
  }
  await onBackup({ matrix: currentMatrix, plan, sheetId, targetDate });
  await feishu.insertRows(plan.dimensionRange, "AFTER");
  try {
    await feishu.writeRange(plan.writeRange, rows);
    const verifiedRows = await feishu.readMatrix(plan.writeRange);
    const verifiedCells = assertRowsMatch(rows, verifiedRows);
    return {
      action: "written",
      targetDate,
      rowCount: rows.length,
      verifiedCells,
      rows,
      plan,
    };
  } catch (error) {
    await feishu.deleteRows(plan.dimensionRange);
    throw error;
  }
}

function assertRowsMatch(expectedRows, actualRows) {
  if (!Array.isArray(actualRows) || actualRows.length !== expectedRows.length) {
    throw new Error(`Feishu verification row count mismatch: expected ${expectedRows.length}, received ${actualRows?.length ?? "invalid"}.`);
  }
  let verifiedCells = 0;
  expectedRows.forEach((expectedRow, rowIndex) => {
    const actualRow = actualRows[rowIndex];
    if (!Array.isArray(actualRow) || actualRow.length !== expectedRow.length) {
      throw new Error(`Feishu verification column count mismatch at row ${rowIndex + 1}.`);
    }
    expectedRow.forEach((expectedCell, columnIndex) => {
      const expected = displayValue(expectedCell);
      const actual = displayValue(actualRow[columnIndex]);
      const matches = typeof expected === "number"
        ? Number(actual) === expected
        : String(actual) === String(expected);
      if (!matches) {
        throw new Error(`Feishu verification mismatch at row ${rowIndex + 1}, column ${columnIndex + 1}.`);
      }
      verifiedCells += 1;
    });
  });
  return verifiedCells;
}

function displayValue(cell) {
  if (cell && typeof cell === "object") return cell.text ?? cell.value ?? "";
  return cell ?? "";
}

function validateRanking(ranking) {
  if (!Array.isArray(ranking) || ranking.length !== 20) {
    throw new Error(`Expected exactly 20 Softcon ranking rows; received ${ranking?.length ?? "invalid"}.`);
  }
  const names = new Set();
  ranking.forEach((item, index) => {
    const name = String(item?.creator?.name || "").trim();
    if (!name) throw new Error(`Softcon rank ${index + 1} has no creator name.`);
    if (names.has(name)) throw new Error(`Softcon ranking contains duplicate creator: ${name}.`);
    names.add(name);
    if (Number(item.rank) !== index + 1) {
      throw new Error(`Softcon ranking is not sequential at position ${index + 1}.`);
    }
  });
}
