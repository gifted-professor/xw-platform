#!/usr/bin/env node
/**
 * validate-run-bundle — REX Phase 3 §5.2 item 5 / A2：离线验证 evidence bundle。
 *
 *   node scripts/validate-run-bundle.mjs <bundleDir> [<bundleDir>...]
 *
 * 纯离线：读 events.jsonl + manifest.json + bundle.seal，校验 seal == sha256(canonicalJsonL)，
 * 报告 schema/事件数/legacy 残留/debt。绝不调用 Windows/设备/控制面，绝不改写源文件。
 * 退出码：全部 ok=0，任一 fail=1，目录缺失=2。
 *
 * 复用 scripts/lib/evidence-contract.mjs 的 readBundle/verifyBundleSeal，保证 A 仓
 * review/validate 走同一套 reader（四种 legacy/v1 组合都可读）。
 */
import { readBundle, verifyBundleSeal, summarizeBundle } from "./lib/evidence-contract.mjs";

export function validateBundle(dir) {
  const bundle = readBundle(dir);
  const verify = verifyBundleSeal(bundle);
  return {
    dir,
    kind: bundle.kind,
    ok: verify.ok && bundle.debt.length === 0,
    sealOk: verify.ok,
    sealReason: verify.reason ?? null,
    debt: bundle.debt,
    summary: summarizeBundle(bundle),
  };
}

// CLI 入口
if (process.argv[1] && process.argv[1].endsWith("validate-run-bundle.mjs")) {
  const dirs = process.argv.slice(2);
  if (!dirs.length) {
    console.log("用法: node scripts/validate-run-bundle.mjs <bundleDir> [<bundleDir>...]\n离线校验 evidence bundle 的 seal/schema/debt，不触达 Windows/设备。");
    process.exit(4);
  }
  let allOk = true;
  let anyMissing = false;
  for (const dir of dirs) {
    const result = validateBundle(dir);
    if (result.kind === "missing") anyMissing = true;
    if (!result.ok) allOk = false;
    console.log(result.summary);
    console.log("");
  }
  process.exit(anyMissing ? 2 : allOk ? 0 : 1);
}