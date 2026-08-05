#!/usr/bin/env node
/**
 * XHS: open one feed note → follow author → verify via re-dump → back home.
 *
 *   node ops/xhs-follow-one.mjs --alias 01
 *   node ops/xhs-follow-one.mjs --alias 02 --no-force-stop
 *   node ops/xhs-follow-one.mjs --alias 03 --dry-run   # locate follow btn only, no tap
 *
 * Requires human authorization for real follows (not --dry-run).
 * Explorer lab via 22222 ops — not control-plane job.
 *
 * 常驻 session（同 xhs-like-one）：一条 ssh channel + 一个 repl 进程复用全部子动作。
 * 关注按钮在 detail 页上部、坐标会漂，用 findFollowBtn 按节点定位，禁硬编码。
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeExplorerLease, parseArgs, openWinXwSession, scpFrom } from "./_explore-lib.mjs";
import { bizRecord } from "./_biz-trace.mjs";
import {
  parseFeedCards,
  pickFeedCard,
  isHomeFocus,
  isDetailFocus,
  findFollowBtn,
  followState,
} from "./_xhs-parse.mjs";

const PKG = "com.xingin.xhs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/xhs-follow-one.mjs --alias <01-04> --session-file <context.json> [--dry-run] [--no-force-stop]
stdout: FOLLOW=ok|skip|fail 等 KV`);
  process.exit(0);
}

const alias = opt("--alias");
const ssh = opt("--ssh", "xhs-windows");
const sessionFile = opt("--session-file");
const dryRun = flag("--dry-run");
const forceStop = !flag("--no-force-stop");
if (!alias) {
  console.log("✗ need --alias");
  process.exit(4);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let s;
let t0 = Date.now(); // 业务动作起点（module-scope，fail/catch 也能引用）

function fail(reason, extra = {}) {
  console.log(`FOLLOW=fail`);
  console.log(`REASON=${reason}`);
  for (const [k, v] of Object.entries(extra)) {
    if (v != null && v !== "") console.log(`${k}=${v}`);
  }
  console.log(`ALIAS=${alias}`);
  try { s && s.close(); } catch { /* */ }
  // biz trace：终态同步落盘（SSH 路径同步 execFileSync），落完再 exit
  bizRecord({ op: "follow", outcome: "fail", reason, extra, alias, serial: (s && s.serial) || null, startMs: t0 });
  process.exit(2);
}

async function focusNow() {
  const r = await s.cmd({ op: "focus" }, 30000);
  if (!r.ok) return { code: 2, FOCUS: "" };
  const FOCUS = r.package && r.activity ? `${r.package}/${r.activity}` : (r.raw || "");
  return { code: 0, FOCUS };
}

async function dumpNow() {
  const ts = Date.now();
  const remote = `C:/Users/Public/xhs-agent-runs/_explore/follow-${alias}-${ts}.xml`;
  const localOut = join(tmpdir(), "xhs-explore", `follow-${alias}-${ts}.xml`);
  const r = await s.cmd({ op: "dump", out: remote }, 50000);
  if (!r.ok) return { code: 2 };
  mkdirSync(join(tmpdir(), "xhs-explore"), { recursive: true });
  try { scpFrom(ssh, remote, localOut); } catch { return { code: 4 }; }
  if (!existsSync(localOut)) return { code: 4 };
  return { code: 0, DUMP: localOut };
}

async function tap(x, y) {
  const r = await s.cmd({ op: "tap", x: Math.round(Number(x)), y: Math.round(Number(y)) }, 20000);
  return { code: r.ok ? 0 : 2 };
}

async function back() {
  const r = await s.cmd({ op: "back" }, 15000);
  return { code: r.ok ? 0 : 2 };
}

async function swipeUp() {
  const r = await s.cmd({ op: "swipe", x1: 540, y1: 1800, x2: 540, y2: 700, ms: 350 }, 20000);
  return { code: r.ok ? 0 : 2 };
}

async function launch() {
  const r = await s.cmd({ op: "start", package: PKG, forceStop }, 45000);
  if (!r.ok) return { code: 2, FOCUS: "" };
  const f = r.focus || {};
  const FOCUS = f.package && f.activity ? `${f.package}/${f.activity}` : (f.raw || "");
  return { code: 0, FOCUS };
}

async function backHome() {
  for (let i = 0; i < 3; i += 1) {
    await back();
    await sleep(1200);
    const f = await focusNow();
    if (isHomeFocus(f.FOCUS)) return true;
  }
  return false;
}

async function main() {
  t0 = Date.now();
  await authorizeExplorerLease(ssh, alias, sessionFile);
  s = openWinXwSession(ssh, alias);
  await s.ready;

  // 1 launch
  const L = await launch();
  if (L.code !== 0) fail("launch", { DETAIL: L.FOCUS || "" });
  await sleep(2800);

  let f = await focusNow();
  if (!isHomeFocus(f.FOCUS)) console.log(`WARN_FOCUS=${f.FOCUS || ""}`);

  // 2 dump feed + pick card
  let d = await dumpNow();
  if (d.code !== 0 || !d.DUMP || !existsSync(d.DUMP)) fail("dump_feed");
  let xml = readFileSync(d.DUMP, "utf8");
  let cards = parseFeedCards(xml);
  let card = pickFeedCard(cards, { prefer: "note", avoidWan: true });
  if (!card) {
    await swipeUp();
    await sleep(1200);
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) {
      xml = readFileSync(d.DUMP, "utf8");
      cards = parseFeedCards(xml);
      card = pickFeedCard(cards, { prefer: "note", avoidWan: false });
    }
  }
  if (!card) fail("no_feed_card", { CARDS: String(cards.length) });

  console.log(`CARD_KIND=${card.kind}`);
  console.log(`CARD_TITLE=${card.title.slice(0, 80)}`);
  console.log(`CARD_AUTHOR=${card.author}`);
  console.log(`CARD_XY=${card.cx},${card.cy}`);

  // 3 open note
  let t = await tap(card.cx, card.cy);
  if (t.code !== 0) fail("tap_card");
  await sleep(2800);
  f = await focusNow();
  if (!isDetailFocus(f.FOCUS)) {
    await tap(274, 700); // fallback percentage tap left column
    await sleep(2500);
    f = await focusNow();
  }
  if (!isDetailFocus(f.FOCUS)) fail("not_detail", { FOCUS: f.FOCUS || "" });
  console.log(`FOCUS_DETAIL=${f.FOCUS}`);

  // 4 locate follow button（坐标会漂，按节点定位）
  d = await dumpNow();
  if (d.code !== 0 || !d.DUMP || !existsSync(d.DUMP)) fail("dump_detail");
  xml = readFileSync(d.DUMP, "utf8");
  let btn = findFollowBtn(xml);
  if (!btn) {
    // 偶尔首屏 dump 没渲染出上部，等一拍重 dump
    await sleep(1000);
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) {
      xml = readFileSync(d.DUMP, "utf8");
      btn = findFollowBtn(xml);
    }
  }
  if (!btn) fail("follow_btn_missing");

  const before = followState(btn.matched);
  const beforeDesc = btn.matched;
  console.log(`FOLLOW_BEFORE=${beforeDesc}`);
  console.log(`FOLLOW_XY=${btn.x},${btn.y}`);

  if (before === "followed") {
    console.log(`FOLLOW=skip`);
    console.log(`REASON=already-followed`);
    await backHome();
    console.log(`ALIAS=${alias}`);
    bizRecord({ op: "follow", outcome: "skip", reason: "already-followed", alias, serial: (s && s.serial) || null, startMs: t0 });
    s.close();
    process.exit(0);
  }

  if (dryRun) {
    console.log(`FOLLOW=dry-run`);
    console.log(`REASON=located-not-tapped`);
    await back();
    console.log(`ALIAS=${alias}`);
    bizRecord({ op: "follow", outcome: "dry-run", reason: "located-not-tapped", alias, serial: (s && s.serial) || null, startMs: t0 });
    s.close();
    process.exit(0);
  }

  // 5 tap follow
  t = await tap(btn.x, btn.y);
  if (t.code !== 0) fail("tap_follow");
  await sleep(1800);

  // 6 verify（label 有翻转滞后：未确认则再等一拍重 dump，同 collect-one 范式）
  const verdict = (desc) =>
    followState(desc) === "followed" ||
    (desc && beforeDesc && desc !== beforeDesc);

  d = await dumpNow();
  let afterDesc = "";
  if (d.DUMP && existsSync(d.DUMP)) {
    xml = readFileSync(d.DUMP, "utf8");
    afterDesc = findFollowBtn(xml)?.matched || "";
  }
  let ok = verdict(afterDesc);

  if (!ok) {
    await sleep(1200);
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) {
      xml = readFileSync(d.DUMP, "utf8");
      afterDesc = findFollowBtn(xml)?.matched || "";
      ok = verdict(afterDesc);
    }
  }
  console.log(`FOLLOW_AFTER=${afterDesc}`);

  // 7 back home
  const home = await backHome();
  console.log(`BACK_HOME=${home ? "yes" : "no"}`);
  f = await focusNow();
  console.log(`FOCUS=${f.FOCUS || ""}`);

  if (!ok) fail("follow_not_confirmed", { FOLLOW_BEFORE: beforeDesc, FOLLOW_AFTER: afterDesc });
  console.log(`FOLLOW=ok`);
  console.log(`ALIAS=${alias}`);
  bizRecord({ op: "follow", outcome: "ok", alias, serial: (s && s.serial) || null, startMs: t0 });
  s.close();
  process.exit(0);
}

main().catch((e) => {
  console.log(`FOLLOW=fail`);
  console.log(`REASON=exception`);
  console.log(`DETAIL=${String(e.message || e).slice(0, 300)}`);
  console.log(`ALIAS=${alias}`);
  try { s && s.close(); } catch { /* */ }
  bizRecord({ op: "follow", outcome: "fail", reason: "exception", extra: { detail: String(e.message || e).slice(0, 300) }, alias, serial: (s && s.serial) || null, startMs: t0 });
  process.exit(4);
});
