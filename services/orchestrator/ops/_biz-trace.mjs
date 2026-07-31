// 业务层终态 trace：每次业务动作（like/comment/follow/collect/search/engage/dm/publish）落一行到 per-day trace 目录。
//   机械层失败（_win-xiaowei dispatch）已有 traceRecord；本模块补业务层（LIKE=fail 等）——两者同文件，
//   用 kind:"biz" 区分（旧行无 kind ⇒ 机械行）。
//
// 双宿主：
//   Windows 本机（XHS_LOCAL=1 / --local / win32 自动）→ 本地 appendFileSync
//   Mac SSH 驱动（isLocalMode()===false）→ execFileSync ssh 远端 node -e append（base64 参数，无 shell 引号问题）
//
// 规则：
//   - bizRecord 同步写完再让调用方 process.exit（SSH 路径用同步 execFileSync），保证终态行不丢
//   - best-effort，永不 throw，只用 console.log（stderr = SSH bridge 判死信号）
//   - 跳过 help / 缺 --alias 等参数校验早退：那不是业务终态，由各脚本头注释统一说明
//   - TRACE_DIR 可用环境变量 XHS_TRACE_DIR 覆盖（测试用；默认 Windows 部署路径）
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isLocalMode, SSH_OPTS } from "./_explore-lib.mjs";

const TRACE_DIR = "C:/Users/Public/xhs-agent-runs/ops-trace";
export function traceDir() {
  return process.env.XHS_TRACE_DIR || TRACE_DIR;
}

// 从 process.argv[1] 取调用脚本名（如 xhs-like-one），作为行的 tag。
function callerTag() {
  try {
    const p = process.argv[1];
    if (!p) return null;
    return String(p).split(/[\\/]/).pop().replace(/\.mjs$/, "") || null;
  } catch { return null; }
}

// 脱敏，镜像 _win-xiaowei scrubReq：不落 base64 原文、长文本预览。
export function scrub(extra) {
  if (!extra) return undefined;
  const r = { ...extra };
  delete r.textB64;
  delete r.cmdB64;
  for (const k of Object.keys(r)) {
    if (typeof r[k] === "string" && r[k].length > 30) r[k] = `${r[k].slice(0, 30)}…`;
  }
  return r;
}

/**
 * bizRecord({ op, outcome, reason, extra, serial, alias, startMs })
 *   op       业务 op：like/comment/collect/follow/search/engage/dm/dm_user/publish_draft/publish_entry
 *   outcome  "ok" | "fail" | "skip" | "dry-run"（skip/dry-run 是终态但非真实尝试）
 *   reason   失败原因（like_btn_missing 等）；ok/skip/dry-run 传 null
 *   extra    附加信息（dryRun/forceStop/子动作状态等），会走 scrub
 *   serial   best-effort：like/follow 作用域内有（openWinXwSession 返回的 s.serial）；runOps 型传 null
 *   alias    设备槽位 01-04
 *   startMs  main() 入口的 Date.now()，记 durationMs
 */
export function bizRecord({ op, outcome, reason = null, extra = {}, serial = null, alias = null, startMs = null }) {
  try {
    const ts = new Date();
    const row = {
      ts: ts.toISOString(),
      kind: "biz",
      serial: serial ?? null,
      alias: alias ?? null,
      tag: callerTag(),
      pid: process.pid,
      op,
      ok: outcome === "ok",
      outcome,
      reason: outcome === "fail" ? String(reason || "biz-fail") : null,
      durationMs: startMs ? Math.max(0, Date.now() - startMs) : 0,
      req: scrub(extra),
      error: outcome === "fail" ? String(reason || extra?.error || "biz-fail").slice(0, 500) : undefined,
    };
    const line = JSON.stringify(row) + "\n";
    const date = ts.toISOString().slice(0, 10);
    if (isLocalMode()) {
      mkdirSync(traceDir(), { recursive: true });
      appendFileSync(join(traceDir(), `${date}.jsonl`), line, "utf8");
    } else {
      remoteAppend(traceDir(), date, row);
    }
  } catch { /* best-effort，绝不炸业务主流程 */ }
}

// Mac SSH 驱动时的远端 append：base64 参数 + node -e，无 shell 引号/编码问题。
// 注意：execFileSync 的 env: 不会转发到远端，trace 目录必须走命令行参数。
function remoteAppend(td, date, row) {
  const b64 = Buffer.from(JSON.stringify(row)).toString("base64");
  const script =
    "const fs=require('fs');" +
    "const td=process.argv[1],d=process.argv[2],b=process.argv[3];" +
    "const p=td+'/'+d+'.jsonl';" +
    "fs.mkdirSync(td,{recursive:true});" +
    "fs.appendFileSync(p,Buffer.from(b,'base64').toString()+String.fromCharCode(10));";
  execFileSync("ssh", [...SSH_OPTS, "xhs-windows", "node", "-e", script, td, date, b64], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
  });
}
