#!/usr/bin/env node
/**
 * Douyin follow — 推荐 Feed 右侧栏定位「关注」按钮；--dry-run 只定位不点。
 *
 *   node ops/douyin-follow.mjs --alias 01 --dry-run
 *   node ops/douyin-follow.mjs --alias 01
 *
 * biz: op="douyin-follow"
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
  console.log(`用法: node ops/douyin-follow.mjs --alias <01-04> [--dry-run] [--no-force-stop]
stdout: DOUYIN_FOLLOW=ok|skip|dry-run|fail ...
Feed 右侧栏关注；--dry-run 只定位不点。`);
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
  console.log(`DOUYIN_FOLLOW=fail`);
  console.log(`REASON=${reason}`);
  for (const [k, v] of Object.entries(extra)) if (v != null) console.log(`${k}=${String(v).slice(0, 220)}`);
  console.log(`ALIAS=${alias}`);
  bizRecord({ op: "douyin-follow", outcome: "fail", reason, extra, alias, serial: null, startMs: t0 });
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
    });
  }
  return out;
}

/** 右侧栏「关注」：desc 精确为「关注」或含关注且小按钮，cx>850，排除顶栏关注 Tab */
function findFollowBtn(xml) {
  const ns = allNodes(xml);
  const hits = ns.filter((n) => {
    if (n.cx < 850 || n.cy < 400 || n.cy > 1600) return false;
    if (n.desc === "关注") return true;
    if (/^关注$/.test(n.text) && n.cy > 800) return true;
    return false;
  });
  // 头像下的关注通常在 like 上方，取 cy 较小者
  hits.sort((a, b) => a.cy - b.cy);
  return hits[0] || null;
}

function followState(btn) {
  const d = ((btn && btn.desc) || "") + ((btn && btn.text) || "");
  if (/已关注|互相关注/.test(d)) return "followed";
  if (/关注/.test(d)) return "unfollowed";
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
      if (xml.includes("<hierarchy") && findFollowBtn(xml)) break;
    }
    await sleep(2000 + i * 1000);
  }
  if (!d?.DUMP || !existsSync(d.DUMP)) fail("dump_feed");
  xml = readFileSync(d.DUMP, "utf8");

  const btn = findFollowBtn(xml);
  if (!btn) fail("follow_btn_missing", { DUMP: d.DUMP });
  const before = followState(btn);
  console.log(`FOLLOW_BEFORE=${btn.desc || btn.text}`);
  console.log(`FOLLOW_XY=${btn.cx},${btn.cy}`);
  console.log(`FOLLOW_STATE=${before}`);
  console.log(`DUMP=${d.DUMP}`);

  if (before === "followed") {
    console.log(`DOUYIN_FOLLOW=skip`);
    console.log(`REASON=already-followed`);
    console.log(`ALIAS=${alias}`);
    bizRecord({
      op: "douyin-follow",
      outcome: "skip",
      reason: "already-followed",
      extra: { desc: btn.desc || btn.text },
      alias,
      serial: null,
      startMs: t0,
    });
    process.exit(0);
  }

  if (dryRun) {
    console.log(`DOUYIN_FOLLOW=dry-run`);
    console.log(`REASON=located-not-tapped`);
    console.log(`ALIAS=${alias}`);
    bizRecord({
      op: "douyin-follow",
      outcome: "dry-run",
      reason: "located-not-tapped",
      extra: { desc: btn.desc || btn.text, x: btn.cx, y: btn.cy },
      alias,
      serial: null,
      startMs: t0,
    });
    process.exit(0);
  }

  r = await tapXY(btn.cx, btn.cy);
  if (r.code !== 0) fail("tap_follow");
  await sleep(2200);

  let afterBtn = null;
  for (let i = 0; i < 4; i++) {
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) {
      xml = readFileSync(d.DUMP, "utf8");
      afterBtn = findFollowBtn(xml);
      // 关注后按钮可能消失或变已关注——也扫「已关注」
      if (!afterBtn) {
        const ns = allNodes(xml).filter((n) => n.cx > 850 && /已关注|互相关注/.test(n.desc + n.text));
        afterBtn = ns[0] || null;
      }
      if (afterBtn || /已关注/.test(xml)) break;
    }
    await sleep(2000 + i * 1000);
  }
  const afterDesc = afterBtn ? (afterBtn.desc || afterBtn.text) : "";
  const after = afterBtn ? followState(afterBtn) : (/已关注/.test(xml || "") ? "followed" : "missing");
  console.log(`FOLLOW_AFTER=${afterDesc}`);
  console.log(`FOLLOW_STATE_AFTER=${after}`);

  const ok = after === "followed" || (afterDesc && (btn.desc || btn.text) && afterDesc !== (btn.desc || btn.text));
  if (!ok) fail("follow_not_confirmed", { FOLLOW_BEFORE: btn.desc || btn.text, FOLLOW_AFTER: afterDesc });

  console.log(`DOUYIN_FOLLOW=ok`);
  console.log(`ALIAS=${alias}`);
  bizRecord({
    op: "douyin-follow",
    outcome: "ok",
    extra: { before: btn.desc || btn.text, after: afterDesc },
    alias,
    serial: null,
    startMs: t0,
  });
  process.exit(0);
}

main().catch((e) => {
  console.log(`DOUYIN_FOLLOW=fail`);
  console.log(`REASON=exception`);
  console.log(`DETAIL=${String(e.message || e).slice(0, 300)}`);
  console.log(`ALIAS=${alias}`);
  bizRecord({
    op: "douyin-follow",
    outcome: "fail",
    reason: "exception",
    extra: { detail: String(e.message || e).slice(0, 300) },
    alias,
    serial: null,
    startMs: t0,
  });
  process.exit(4);
});
