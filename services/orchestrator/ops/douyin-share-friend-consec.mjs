#!/usr/bin/env node
/**
 * 人控等价：连续 N 条同一逻辑全成功才算「可上脚本」。
 * 逻辑：开帖 → 分享 → 按名点天才较瘦(已选中) → 飞书全字段附言 → 发送 → 左上角返回队列
 *
 * node ops/douyin-share-friend-consec.mjs --alias 01 --session-file <ctx> --keyword "禾木 live图" --need 5
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ROOT = "C:/Users/Public/xhs-registry";
const args = process.argv.slice(2);
function opt(k, d) {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
}
const alias = opt("--alias", "01");
const sessionFile = opt("--session-file");
const keyword = opt("--keyword", "禾木 live图");
const need = Math.max(1, Number(opt("--need", "5")) || 5);
if (!sessionFile) {
  console.log("need --session-file");
  process.exit(4);
}

// 复用完整 harvest（按名选人 + 飞书全字段 + 左上角回队列）
// fail-stop=2：分享失败 2 次就停，逼近「连续成功」
const r = spawnSync(
  "node",
  [
    "ops/douyin-share-friend-harvest.mjs",
    "--alias",
    alias,
    "--session-file",
    sessionFile,
    "--keyword",
    keyword,
    "--need",
    String(need),
    "--fail-stop",
    "2",
  ],
  {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, XHS_LOCAL: "1" },
    timeout: 0,
    maxBuffer: 50 * 1024 * 1024,
  },
);
process.stdout.write(r.stdout || "");
process.stderr.write(r.stderr || "");
const code = r.status ?? 1;
try {
  const sum = JSON.parse(
    readFileSync(`${ROOT}/runtime/xj-live-pipeline/harvest-links/share-friend-summary.json`, "utf8"),
  );
  // 连续门禁：凑满 need，且分享失败未熔断；attempts 允许少量 open_retry
  const consecOk = sum.got >= need && !sum.stopReason && code === 0;
  console.log(
    JSON.stringify({
      gate: "consec_same_logic",
      need,
      got: sum.got,
      attempts: sum.attempts,
      elapsedSec: sum.elapsedSec,
      secPerPost: sum.secPerPost,
      stopReason: sum.stopReason,
      consecOk,
      message: consecOk
        ? `连续 ${need} 条同一逻辑成功 → 可标脚本稳定点`
        : `未过连续门禁 got=${sum.got}/${need} stop=${sum.stopReason}`,
    }),
  );
  process.exit(consecOk ? 0 : 2);
} catch {
  process.exit(code || 2);
}
