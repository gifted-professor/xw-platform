#!/usr/bin/env node
/**
 * Douyin collect — 推荐 Feed 右侧栏定位收藏按钮；--dry-run 只定位不点。
 * 对齐能力地图：desc「未选中，收藏N，按钮」/「已选中，…」。
 *
 *   node ops/douyin-collect.mjs --alias 01 --dry-run
 *   node ops/douyin-collect.mjs --alias 01                 # 真收藏
 *   node ops/douyin-collect.mjs --alias 01 --dry-run --no-force-stop
 *
 * stdout: DOUYIN_COLLECT=ok|skip|dry-run|fail ...
 * biz trace: op="douyin-collect"，runOps 型 serial=null。
 */
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./_explore-lib.mjs";
import { bizRecord } from "./_biz-trace.mjs";
import { decodeEntities } from "./_xhs-parse.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PKG = "com.ss.android.ugc.aweme";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/douyin-collect.mjs --alias <01-04> [--dry-run] [--no-force-stop]
stdout: DOUYIN_COLLECT=ok|skip|dry-run|fail COLLECT_XY=… COLLECT_BEFORE=…
推荐 Feed 右侧栏定位收藏；--dry-run 只定位不点。不加 --dry-run 会真收藏。`);
  process.exit(0);
}

const alias = opt("--alias");
const ssh = opt("--ssh", "xhs-windows");
const dryRun = flag("--dry-run");
const forceStop = !flag("--no-force-stop");
if (!alias) {
  console.log("✗ need --alias");
  process.exit(4);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runOps(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn("node", args, { cwd: ROOT });
    let out = "";
    const timer = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch { /* */ }
      resolve({ code: 124, out, ms: Date.now() - t0 });
    }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out: out.trim(), ms: Date.now() - t0 });
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

let t0 = Date.now();

function fail(reason, extra = {}) {
  console.log(`DOUYIN_COLLECT=fail`);
  console.log(`REASON=${reason}`);
  for (const [k, v] of Object.entries(extra)) if (v != null) console.log(`${k}=${String(v).slice(0, 220)}`);
  console.log(`ALIAS=${alias}`);
  bizRecord({ op: "douyin-collect", outcome: "fail", reason, extra, alias, serial: null, startMs: t0 });
  process.exit(2);
}

function allNodes(xml) {
  const out = [];
  const re = /<node\b[^>]*>/g;
  let m;
  while ((m = re.exec(xml))) {
    const tag = m[0];
    const b = tag.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!b) continue;
    out.push({
      L: +b[1], T: +b[2], R: +b[3], B: +b[4],
      cx: Math.round((+b[1] + +b[3]) / 2),
      cy: Math.round((+b[2] + +b[4]) / 2),
      text: decodeEntities((tag.match(/text="([^"]*)"/) || [])[1] || ""),
      desc: decodeEntities((tag.match(/content-desc="([^"]*)"/) || [])[1] || ""),
      clickable: /clickable="true"/.test(tag),
    });
  }
  return out;
}

/** 右侧栏收藏：desc 含「收藏」+「按钮」，cx>850 */
function findCollectBtn(xml) {
  const ns = allNodes(xml);
  const hits = ns.filter((n) =>
    /收藏/.test(n.desc) && /按钮/.test(n.desc) && n.cx > 850 && n.cy > 400 && n.cy < 2100
  );
  hits.sort((a, b) => (b.B - b.T) - (a.B - a.T) || a.cy - b.cy);
  return hits[0] || null;
}

function collectState(btn) {
  const d = (btn && btn.desc) || "";
  if (/已选中/.test(d)) return "collected";
  if (/未选中/.test(d)) return "uncollected";
  if (/收藏/.test(d)) return "unknown";
  return "missing";
}

async function dumpNow() {
  const r = await runOps(["ops/dump-ui.mjs", "--alias", alias, "--ssh", ssh], 50000);
  return { ...r, ...kv(r.out) };
}
async function tapXY(x, y) {
  return runOps(["ops/tap.mjs", "--alias", alias, "--x", String(x), "--y", String(y), "--ssh", ssh], 20000);
}
async function focusNow() {
  const r = await runOps(["ops/focus.mjs", "--alias", alias, "--ssh", ssh], 30000);
  return { ...r, ...kv(r.out) };
}

async function main() {
  t0 = Date.now();
  const launchArgs = ["ops/launch-app.mjs", "--alias", alias, "--package", PKG, "--ssh", ssh];
  if (forceStop) launchArgs.push("--force-stop");
  let r = await runOps(launchArgs, 45000);
  if (r.code !== 0) fail("launch", { DETAIL: r.out.slice(0, 160) });
  await sleep(5500);

  const f = await focusNow();
  console.log(`FOCUS=${f.FOCUS || ""}`);
  if (!/aweme/i.test(f.FOCUS || "")) fail("not_douyin", { FOCUS: f.FOCUS || "" });

  let d = null;
  let xml = "";
  for (let i = 0; i < 4; i++) {
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) {
      xml = readFileSync(d.DUMP, "utf8");
      if (xml.includes("<hierarchy") && findCollectBtn(xml)) break;
    }
    await sleep(2000 + i * 1000);
  }
  if (!d?.DUMP || !existsSync(d.DUMP)) fail("dump_feed");
  xml = readFileSync(d.DUMP, "utf8");

  const btn = findCollectBtn(xml);
  if (!btn) fail("collect_btn_missing", { DUMP: d.DUMP });
  const before = collectState(btn);
  console.log(`COLLECT_BEFORE=${btn.desc}`);
  console.log(`COLLECT_XY=${btn.cx},${btn.cy}`);
  console.log(`COLLECT_STATE=${before}`);
  console.log(`DUMP=${d.DUMP}`);

  if (before === "collected") {
    console.log(`DOUYIN_COLLECT=skip`);
    console.log(`REASON=already-collected`);
    console.log(`ALIAS=${alias}`);
    bizRecord({
      op: "douyin-collect",
      outcome: "skip",
      reason: "already-collected",
      extra: { desc: btn.desc },
      alias,
      serial: null,
      startMs: t0,
    });
    process.exit(0);
  }

  if (dryRun) {
    console.log(`DOUYIN_COLLECT=dry-run`);
    console.log(`REASON=located-not-tapped`);
    console.log(`ALIAS=${alias}`);
    bizRecord({
      op: "douyin-collect",
      outcome: "dry-run",
      reason: "located-not-tapped",
      extra: { desc: btn.desc, x: btn.cx, y: btn.cy },
      alias,
      serial: null,
      startMs: t0,
    });
    process.exit(0);
  }

  r = await tapXY(btn.cx, btn.cy);
  if (r.code !== 0) fail("tap_collect");
  await sleep(2200);

  // 点后偶发空 dump（同 swipe 坑）—— settle 重试
  let afterBtn = null;
  for (let i = 0; i < 4; i++) {
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) {
      xml = readFileSync(d.DUMP, "utf8");
      afterBtn = findCollectBtn(xml);
      if (afterBtn) break;
    }
    await sleep(2000 + i * 1000);
  }
  if (!afterBtn) fail("dump_after_collect");
  const afterDesc = afterBtn.desc || "";
  const after = collectState(afterBtn);
  console.log(`COLLECT_AFTER=${afterDesc}`);
  console.log(`COLLECT_STATE_AFTER=${after}`);

  const ok =
    after === "collected" ||
    (afterDesc && btn.desc && afterDesc !== btn.desc) ||
    /已选中/.test(afterDesc);
  if (!ok) fail("collect_not_confirmed", { COLLECT_BEFORE: btn.desc, COLLECT_AFTER: afterDesc });

  console.log(`DOUYIN_COLLECT=ok`);
  console.log(`ALIAS=${alias}`);
  bizRecord({
    op: "douyin-collect",
    outcome: "ok",
    extra: { before: btn.desc, after: afterDesc },
    alias,
    serial: null,
    startMs: t0,
  });
  process.exit(0);
}

main().catch((e) => {
  console.log(`DOUYIN_COLLECT=fail`);
  console.log(`REASON=exception`);
  console.log(`DETAIL=${String(e.message || e).slice(0, 300)}`);
  console.log(`ALIAS=${alias}`);
  bizRecord({
    op: "douyin-collect",
    outcome: "fail",
    reason: "exception",
    extra: { detail: String(e.message || e).slice(0, 300) },
    alias,
    serial: null,
    startMs: t0,
  });
  process.exit(4);
});
