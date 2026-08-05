#!/usr/bin/env node
/**
 * Douyin like — 推荐 Feed 右侧栏定位点赞按钮；默认 --dry-run 只定位不点。
 * 对齐 2026-07-31 01 dump：desc「未点赞，喜欢N，按钮」/「已点赞，…」。
 *
 *   node ops/douyin-like.mjs --alias 01 --dry-run
 *   node ops/douyin-like.mjs --alias 01                 # 真点赞（自主，慎用）
 *   node ops/douyin-like.mjs --alias 01 --dry-run --no-force-stop
 *
 * stdout: DOUYIN_LIKE=ok|skip|dry-run|fail ...
 * biz trace: op="douyin-like"，runOps 型 serial=null。
 *
 * 依赖：_explore-lib / _biz-trace / _xhs-parse(decodeEntities)；ops/launch-app|dump-ui|tap|focus。
 * 禁 console.error；零第三方依赖。
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
  console.log(`用法: node ops/douyin-like.mjs --alias <01-04> --session-file <context.json> [--dry-run] [--no-force-stop]
stdout: DOUYIN_LIKE=ok|skip|dry-run|fail LIKE_XY=… LIKE_BEFORE=…
推荐 Feed 右侧栏定位点赞；--dry-run 只定位不点。不加 --dry-run 会真点赞。`);
  process.exit(0);
}

const alias = opt("--alias");
const ssh = opt("--ssh", "xhs-windows");
const sessionFile = opt("--session-file");
if (!sessionFile) { console.log("✗ need --session-file"); process.exit(4); }
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
    const childArgs = args.includes("--session-file") ? args : [...args, "--session-file", sessionFile];
    const p = spawn("node", childArgs, { cwd: ROOT });
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
  console.log(`DOUYIN_LIKE=fail`);
  console.log(`REASON=${reason}`);
  for (const [k, v] of Object.entries(extra)) if (v != null) console.log(`${k}=${String(v).slice(0, 220)}`);
  console.log(`ALIAS=${alias}`);
  bizRecord({ op: "douyin-like", outcome: "fail", reason, extra, alias, serial: null, startMs: t0 });
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

/** 右侧栏点赞：desc 含「喜欢」+「按钮」，且偏右（cx>850） */
function findLikeBtn(xml) {
  const ns = allNodes(xml);
  const hits = ns.filter((n) =>
    /喜欢/.test(n.desc) && /按钮/.test(n.desc) && n.cx > 850 && n.cy > 400 && n.cy < 2000
  );
  // 优先带「未点赞/已点赞」的主按钮（通常更高更完整）
  hits.sort((a, b) => (b.B - b.T) - (a.B - a.T) || a.cy - b.cy);
  return hits[0] || null;
}

function likeState(btn) {
  const d = (btn && btn.desc) || "";
  if (/已点赞/.test(d)) return "liked";
  if (/未点赞/.test(d)) return "unliked";
  if (/喜欢/.test(d)) return "unknown";
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

  // dump 可空：settle 重试
  let d = null;
  let xml = "";
  for (let i = 0; i < 4; i++) {
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) {
      xml = readFileSync(d.DUMP, "utf8");
      if (xml.includes("<hierarchy") && findLikeBtn(xml)) break;
    }
    await sleep(2000 + i * 1000);
  }
  if (!d?.DUMP || !existsSync(d.DUMP)) fail("dump_feed");
  xml = readFileSync(d.DUMP, "utf8");

  const btn = findLikeBtn(xml);
  if (!btn) fail("like_btn_missing", { DUMP: d.DUMP });
  const before = likeState(btn);
  console.log(`LIKE_BEFORE=${btn.desc}`);
  console.log(`LIKE_XY=${btn.cx},${btn.cy}`);
  console.log(`LIKE_STATE=${before}`);
  console.log(`DUMP=${d.DUMP}`);

  if (before === "liked") {
    console.log(`DOUYIN_LIKE=skip`);
    console.log(`REASON=already-liked`);
    console.log(`ALIAS=${alias}`);
    bizRecord({
      op: "douyin-like",
      outcome: "skip",
      reason: "already-liked",
      extra: { desc: btn.desc },
      alias,
      serial: null,
      startMs: t0,
    });
    process.exit(0);
  }

  if (dryRun) {
    console.log(`DOUYIN_LIKE=dry-run`);
    console.log(`REASON=located-not-tapped`);
    console.log(`ALIAS=${alias}`);
    bizRecord({
      op: "douyin-like",
      outcome: "dry-run",
      reason: "located-not-tapped",
      extra: { desc: btn.desc, x: btn.cx, y: btn.cy },
      alias,
      serial: null,
      startMs: t0,
    });
    process.exit(0);
  }

  // 真点赞
  r = await tapXY(btn.cx, btn.cy);
  if (r.code !== 0) fail("tap_like");
  await sleep(2200);

  // 点后偶发空 dump —— settle 重试
  let afterBtn = null;
  for (let i = 0; i < 4; i++) {
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) {
      xml = readFileSync(d.DUMP, "utf8");
      afterBtn = findLikeBtn(xml);
      if (afterBtn) break;
    }
    await sleep(2000 + i * 1000);
  }
  if (!afterBtn) fail("dump_after_like");
  const afterDesc = afterBtn.desc || "";
  const after = likeState(afterBtn);
  console.log(`LIKE_AFTER=${afterDesc}`);
  console.log(`LIKE_STATE_AFTER=${after}`);

  const ok =
    after === "liked" ||
    (afterDesc && btn.desc && afterDesc !== btn.desc) ||
    /已点赞/.test(afterDesc);
  if (!ok) fail("like_not_confirmed", { LIKE_BEFORE: btn.desc, LIKE_AFTER: afterDesc });

  console.log(`DOUYIN_LIKE=ok`);
  console.log(`ALIAS=${alias}`);
  bizRecord({
    op: "douyin-like",
    outcome: "ok",
    extra: { before: btn.desc, after: afterDesc },
    alias,
    serial: null,
    startMs: t0,
  });
  process.exit(0);
}

main().catch((e) => {
  console.log(`DOUYIN_LIKE=fail`);
  console.log(`REASON=exception`);
  console.log(`DETAIL=${String(e.message || e).slice(0, 300)}`);
  console.log(`ALIAS=${alias}`);
  bizRecord({
    op: "douyin-like",
    outcome: "fail",
    reason: "exception",
    extra: { detail: String(e.message || e).slice(0, 300) },
    alias,
    serial: null,
    startMs: t0,
  });
  process.exit(4);
});
