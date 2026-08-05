#!/usr/bin/env node
/**
 * Douyin collect-set — 多机收藏 dry-run 集合（串行，默认 01,02）。
 * 只跑定位不点；单机失败不阻断其余机，汇总出口。
 *
 *   node ops/douyin-collect-set.mjs
 *   node ops/douyin-collect-set.mjs --aliases 01,02,04
 *   node ops/douyin-collect-set.mjs --aliases 01,02 --no-force-stop
 *
 * stdout:
 *   ROW alias=01 RESULT=dry-run ...
 *   DOUYIN_COLLECT_SET=ok|partial|fail PASS=N FAIL=N ALIASES=...
 * biz: op="douyin-collect-set"
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./_explore-lib.mjs";
import { bizRecord } from "./_biz-trace.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/douyin-collect-set.mjs --session-dir <contexts-dir> [--aliases 01,02] [--no-force-stop]
多机串行 douyin-collect --dry-run；汇总 PASS/FAIL。默认 aliases=01,02（04 常被青少年模式挡，需显式加入）。`);
  process.exit(0);
}

const ssh = opt("--ssh", "xhs-windows");
const sessionDir = opt("--session-dir");
if (!sessionDir) { console.log("✗ need --session-dir containing <alias>.json contexts"); process.exit(4); }
const forceStop = !flag("--no-force-stop");
const aliasesRaw = opt("--aliases", "01,02");
const aliases = String(aliasesRaw)
  .split(/[,:\s]+/)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => s.padStart(2, "0")); // 1 → 01，防 PowerShell 数字吞零

if (!aliases.length) {
  console.log("✗ need --aliases");
  process.exit(4);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t0 = Date.now();

function runOps(args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn("node", args, { cwd: ROOT, encoding: "utf8" });
    let out = "";
    const timer = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch { /* */ }
      resolve({ code: 124, out, ms: Date.now() - started });
    }, timeoutMs);
    p.stdout.setEncoding("utf8");
    p.stderr.setEncoding("utf8");
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out: out.trim(), ms: Date.now() - started });
    });
  });
}

function kv(t) {
  const o = {};
  for (const line of String(t || "").split(/\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) o[m[1]] = m[2];
  }
  return o;
}

async function main() {
  t0 = Date.now();
  console.log(`ALIASES=${aliases.join(",")}`);
  console.log(`MODE=dry-run`);
  console.log(`FORCE_STOP=${forceStop ? "yes" : "no"}`);

  const rows = [];
  for (const alias of aliases) {
    console.log(`--- alias=${alias} ---`);
    const args = [
      "ops/douyin-collect.mjs",
      "--alias", alias,
      "--session-file", resolve(sessionDir, `${alias}.json`),
      "--dry-run",
      "--ssh", ssh,
    ];
    if (!forceStop) args.push("--no-force-stop");
    const r = await runOps(args, 180000);
    const k = kv(r.out);
    const result = k.DOUYIN_COLLECT || (r.code === 0 ? "ok" : "fail");
    const pass = result === "dry-run" || result === "skip" || result === "ok";
    const row = {
      alias,
      result,
      reason: k.REASON || (r.code === 124 ? "timeout" : ""),
      xy: k.COLLECT_XY || "",
      before: k.COLLECT_BEFORE || "",
      state: k.COLLECT_STATE || "",
      pass,
      code: r.code,
      ms: r.ms,
    };
    rows.push(row);
    console.log(
      `ROW alias=${alias} RESULT=${result}` +
        (row.xy ? ` COLLECT_XY=${row.xy}` : "") +
        (row.reason ? ` REASON=${row.reason}` : "") +
        ` MS=${row.ms}`,
    );
    // 机间歇，减轻 22222 / a11y 抖动
    await sleep(2000);
  }

  const passN = rows.filter((r) => r.pass).length;
  const failN = rows.length - passN;
  let setOutcome = "ok";
  if (failN === 0) setOutcome = "ok";
  else if (passN === 0) setOutcome = "fail";
  else setOutcome = "partial";

  console.log(`PASS=${passN}`);
  console.log(`FAIL=${failN}`);
  console.log(`DOUYIN_COLLECT_SET=${setOutcome}`);
  console.log(`ALIASES=${aliases.join(",")}`);

  // biz outcome 仅 ok|fail|skip|dry-run；集合 partial 记 ok + reason/extra.set
  const bizOutcome = setOutcome === "fail" ? "fail" : "ok";
  const rowSummary = rows
    .map((r) => `${r.alias}:${r.result}${r.reason ? "/" + r.reason : ""}`)
    .join(";");
  bizRecord({
    op: "douyin-collect-set",
    outcome: bizOutcome,
    reason: setOutcome === "fail" ? `set-fail:pass=${passN}/fail=${failN}` : null,
    extra: {
      aliases: aliases.join(","),
      set: setOutcome,
      pass: passN,
      fail: failN,
      rows: rowSummary,
    },
    alias: aliases[0] || null,
    serial: null,
    startMs: t0,
  });

  // partial/ok → exit 0；全灭 → 2
  process.exit(setOutcome === "fail" ? 2 : 0);
}

main().catch((e) => {
  console.log(`DOUYIN_COLLECT_SET=fail`);
  console.log(`REASON=exception`);
  console.log(`DETAIL=${String(e.message || e).slice(0, 300)}`);
  bizRecord({
    op: "douyin-collect-set",
    outcome: "fail",
    reason: "exception",
    extra: { detail: String(e.message || e).slice(0, 300) },
    alias: aliases[0] || null,
    serial: null,
    startMs: t0,
  });
  process.exit(4);
});
