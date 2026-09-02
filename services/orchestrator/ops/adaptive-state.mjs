// adaptive-state.mjs — 04 快车道状态机的纯函数核心（plan §3.3 / §4）
// route 选择本身是 Claude 的判断；失败计数与 STOP 阈值是确定性规则，单独可测。
// 不导入设备/IO，零副作用，供离线测试。

export const STOP_THRESHOLD = 2;

export const ROUTES = new Set(["RECIPE", "DUMP", "VISION", "STOP"]);

/**
 * 失败计数递增。被动刷新（fresh dump/screenshot/focus）不计数，故只有明确失败原因才 +1。
 * 返回新计数（不原地改）。
 */
export function incFailure(count, reasonCode) {
  const next = Math.max(0, Math.trunc(Number(count) || 0)) + 1;
  return { count: next, reasonCode: String(reasonCode || "SECOND_FAILURE") };
}

/**
 * 是否到达 STOP。红线优先于计数：任一红线立即停。
 */
export function shouldStop({ count, redline = false }) {
  if (redline) return true;
  return Math.trunc(Number(count) || 0) >= STOP_THRESHOLD;
}

/**
 * 给定本轮观察，归一出一个 route 决策的 reasonCode（不含 Claude 的语义判断，只做硬规则归约）。
 * recipeMatch/dumpUnique/dumpSparse/dumpFailed 是 Claude 已判定的布尔输入。
 */
export function reduceReason({ recipeMatch, dumpUnique, dumpSparse, dumpFailed, redline }) {
  if (redline) return "REDLINE";
  if (recipeMatch) return "EXACT_RECIPE";
  if (dumpFailed) return "DUMP_FAILED";
  if (dumpUnique) return "UNIQUE_DUMP";
  if (dumpSparse) return "DUMP_SPARSE";
  return "AMBIGUOUS";
}

/**
 * mandatory postcondition：assertion.pass=false 的 run 不计入历史成功，失败计数 +1。
 */
export function postconditionFailed(count) {
  return incFailure(count, "POSTCONDITION_FAILED");
}