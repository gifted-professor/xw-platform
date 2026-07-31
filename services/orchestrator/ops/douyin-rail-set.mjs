#!/usr/bin/env node
/**
 * Douyin rail-set — 右侧栏三连 dry-run：like + collect + follow，按机串行。
 * 默认 aliases=01,02（已登录机；04 未登录勿加）。
 *
 *   node ops/douyin-rail-set.mjs
 *   node ops/douyin-rail-set.mjs --aliases 01,02
 *
 * biz: op="douyin-rail-set"
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./_explore-lib.mjs";
import { bizRecord } from "./_biz-trace.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const OPS = [
  { script: "ops/douyin-like.mjs", key: "DOUYIN_LIKE", xy: "LIKE_XY", name: "like" },
  { script: "ops/douyin-collect.mjs", key: "DOUYIN_COLLECT", xy: "COLLECT_XY", name: "collect" },
  { script: "ops/douyin-follow.mjs", key: "DOUYIN_FOLLOW", xy: "FOLLOW_XY", name: "follow" },
];

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/douyin-rail-set.mjs [--aliases 01,02] [--no-force-stop]
每机串行 like→collect→follow --dry-run；汇总 PASS/FAIL。默认 aliases=01,02。`);
  process.exit(0);
}

const ssh = opt("--ssh", "xhs-windows");
const forceStop = !flag("--no-force-stop");
const aliases = String(opt("--aliases", "01,02"))
  .split(/[,:\s]+/)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => s.padStart(2, "0"));

if (!aliases.length) {
  console.log("✗ need --aliases");
  process.exit(4);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t0 = Date.now();

function runOps(args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn("node", args, { cwd: ROOT });
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
  console.log(`OPS=like,collect,follow`);
  console.log(`FORCE_STOP=${forceStop ? "yes" : "no"}`);

  const rows = [];
  for (const alias of aliases) {
    console.log(`=== alias=${alias} ===`);
    for (const op of OPS) {
      const args = [op.script, "--alias", alias, "--dry-run", "--ssh", ssh];
      // 每 op 都 force-stop：同机连跑否则 a11y/dump 易死（01 实测）
      if (!forceStop) args.push("--no-force-stop");
      const r = await runOps(args, 180000);
      const k = kv(r.out);
      const result = k[op.key] || (r.code === 0 ? "ok" : "fail");
      const pass = result === "dry-run" || result === "skip" || result === "ok";
      const xy = k[op.xy] || "";
      const reason = k.REASON || (r.code === 124 ? "timeout" : "");
      rows.push({ alias, op: op.name, result, reason, xy, pass, ms: r.ms });
      console.log(
        `ROW alias=${alias} OP=${op.name} RESULT=${result}` +
          (xy ? ` XY=${xy}` : "") +
          (reason ? ` REASON=${reason}` : "") +
          ` MS=${r.ms}`,
      );
      await sleep(1500);
    }
    await sleep(2000);
  }

  const passN = rows.filter((r) => r.pass).length;
  const failN = rows.length - passN;
  const setOutcome = failN === 0 ? "ok" : passN === 0 ? "fail" : "partial";

  console.log(`PASS=${passN}`);
  console.log(`FAIL=${failN}`);
  console.log(`DOUYIN_RAIL_SET=${setOutcome}`);
  console.log(`ALIASES=${aliases.join(",")}`);

  bizRecord({
    op: "douyin-rail-set",
    outcome: setOutcome === "fail" ? "fail" : "ok",
    reason: setOutcome === "fail" ? `set-fail:pass=${passN}/fail=${failN}` : null,
    extra: {
      aliases: aliases.join(","),
      set: setOutcome,
      pass: passN,
      fail: failN,
      rows: rows.map((r) => `${r.alias}/${r.op}:${r.result}${r.reason ? "/" + r.reason : ""}`).join(";"),
    },
    alias: aliases[0] || null,
    serial: null,
    startMs: t0,
  });

  process.exit(setOutcome === "fail" ? 2 : 0);
}

main().catch((e) => {
  console.log(`DOUYIN_RAIL_SET=fail`);
  console.log(`REASON=exception`);
  console.log(`DETAIL=${String(e.message || e).slice(0, 300)}`);
  bizRecord({
    op: "douyin-rail-set",
    outcome: "fail",
    reason: "exception",
    extra: { detail: String(e.message || e).slice(0, 300) },
    alias: aliases[0] || null,
    serial: null,
    startMs: t0,
  });
  process.exit(4);
});
