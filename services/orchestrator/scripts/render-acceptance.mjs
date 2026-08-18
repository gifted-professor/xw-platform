#!/usr/bin/env node
/**
 * render-acceptance — REX Phase 3 §5.2 item 5 / A2：从 manifest + review receipt 生成 Markdown 验收报告。
 *
 *   node scripts/render-acceptance.mjs <bundleDir> [<reviewReceipt.json>]
 *
 * 纯离线：读 bundle（v1/legacy/both/empty 都可，走 evidence-contract.readBundle），
 * 可选叠加一份 review receipt（JSON：{ verdict, confidence, debts, reviewer }），
 * 生成 Markdown 验收报告到 stdout。绝不调用 Windows/设备，绝不改写源文件，
 * 绝不影响下一任务派发（纯输出）。
 *
 * Review receipt 只表达 receipt/debt 判断，不构成对 dispatch 的指令（§5.4 GO）。
 */
import { readFileSync } from "node:fs";
import { readBundle, summarizeBundle, verifyBundleSeal } from "./lib/evidence-contract.mjs";

export function renderAcceptance({ bundle, receipt = null }) {
  const verify = verifyBundleSeal(bundle);
  const lines = [];
  lines.push(`# 验收报告 — run ${bundle.runId ?? "(no runId)"}`);
  lines.push("");
  lines.push(`- bundle kind: ${bundle.kind}`);
  lines.push(`- schemaVersion: ${bundle.schemaVersion ?? "—"}`);
  lines.push(`- v1 events: ${bundle.events.length} / legacy artifacts: ${bundle.legacyEvents?.length ?? 0}`);
  lines.push(`- seal: ${verify.ok ? "ok (" + (verify.sealHash ?? "").slice(0, 12) + ")" : "FAIL — " + (verify.reason ?? "")}`);
  lines.push(`- evidence debt: ${bundle.debt.length}`);
  lines.push("");
  lines.push(summarizeBundle(bundle));
  lines.push("");

  if (receipt) {
    lines.push(`## review receipt`);
    lines.push(`- verdict: ${receipt.verdict ?? "—"}`);
    lines.push(`- confidence: ${receipt.confidence ?? "—"}`);
    lines.push(`- reviewer: ${receipt.reviewer ?? "—"}`);
    if (receipt.debts?.length) {
      lines.push(`- debts:`);
      for (const d of receipt.debts) lines.push(`  - ${typeof d === "string" ? d : JSON.stringify(d)}`);
    }
    lines.push("");
    lines.push(`> receipt 只表达 receipt/debt 判断，不构成对下一任务派发的指令。`);
    lines.push("");
  }

  // 验收结论由 receipt 决定；无 receipt 时只报事实，不下结论。
  const conclusion = receipt?.verdict ?? "facts-only";
  lines.push(`## 结论: ${conclusion}`);
  return lines.join("\n");
}

// CLI 入口
if (process.argv[1] && process.argv[1].endsWith("render-acceptance.mjs")) {
  const [bundleDir, receiptPath] = process.argv.slice(2);
  if (!bundleDir) {
    console.log("用法: node scripts/render-acceptance.mjs <bundleDir> [<reviewReceipt.json>]\n从 manifest + review receipt 生成 Markdown 验收报告（离线，不改源）。");
    process.exit(4);
  }
  const bundle = readBundle(bundleDir);
  let receipt = null;
  if (receiptPath) {
    try { receipt = JSON.parse(readFileSync(receiptPath, "utf8")); } catch (error) {
      console.log(`> ⚠️ review receipt 读取失败（${error.message}），按 facts-only 渲染。\n`);
    }
  }
  console.log(renderAcceptance({ bundle, receipt }));
}