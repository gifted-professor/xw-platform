#!/usr/bin/env node
/**
 * XHS: open one feed note → like → verify via dump → back home.
 *
 *   node ops/xhs-like-one.mjs --alias 01
 *   node ops/xhs-like-one.mjs --alias 02 --no-force-stop
 *   node ops/xhs-like-one.mjs --alias 03 --dry-run   # enter+locate like only, no tap
 *
 * Requires human authorization for real likes (not --dry-run).
 * Explorer lab via 22222 ops — not control-plane job.
 *
 * 常驻 session：一条 ssh channel + 一个 node repl 进程复用全部子动作，
 * 单动作 ~50ms（vs 单发 ~1.2s）。dump 仍需 scp 回本地解析（走复用 TCP，便宜）。
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, openWinXwSession, scpFrom } from "./_explore-lib.mjs";
import { bizRecord } from "./_biz-trace.mjs";
import {
  parseFeedCards,
  pickFeedCard,
  parseBottomBar,
  likeState,
  isHomeFocus,
  isDetailFocus,
} from "./_xhs-parse.mjs";

const PKG = "com.xingin.xhs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/xhs-like-one.mjs --alias <01-04> [--dry-run] [--no-force-stop] [--ssh xhs-windows]
stdout: LIKE=ok|skip|fail 等 KV`);
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let s; // session，module-scope 便于 fail() 关闭
let t0 = Date.now(); // 业务动作起点（module-scope，fail/catch 也能引用）

function fail(reason, extra = {}) {
  console.log(`LIKE=fail`);
  console.log(`REASON=${reason}`);
  for (const [k, v] of Object.entries(extra)) {
    if (v != null && v !== "") console.log(`${k}=${v}`);
  }
  console.log(`ALIAS=${alias}`);
  try { s && s.close(); } catch { /* */ }
  // biz trace：终态同步落盘（SSH 路径同步 execFileSync），落完再 exit
  bizRecord({ op: "like", outcome: "fail", reason, extra, alias, serial: (s && s.serial) || null, startMs: t0 });
  process.exit(2);
}

// ---- session 动作封装（取代 runOps 子进程）----
async function focusNow() {
  const r = await s.cmd({ op: "focus" }, 30000);
  if (!r.ok) return { code: 2, FOCUS: "" };
  const FOCUS = r.package && r.activity ? `${r.package}/${r.activity}` : (r.raw || "");
  return { code: 0, FOCUS };
}

async function dumpNow() {
  const ts = Date.now();
  const remote = `C:/Users/Public/xhs-agent-runs/_explore/dump-${alias}-${ts}.xml`;
  const localOut = join(tmpdir(), "xhs-explore", `dump-${alias}-${ts}.xml`);
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

async function main() {
  t0 = Date.now();
  s = openWinXwSession(ssh, alias);
  await s.ready;

  // 1 launch
  const L = await launch();
  if (L.code !== 0) fail("launch", { DETAIL: L.FOCUS || "" });
  await sleep(2800);

  let f = await focusNow();
  if (!isHomeFocus(f.FOCUS)) {
    console.log(`WARN_FOCUS=${f.FOCUS || ""}`); // sometimes marketing interstitial
  }

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
  console.log(`CARD_LIKES=${card.likes ?? ""}`);
  console.log(`CARD_XY=${card.cx},${card.cy}`);

  // 3 open note
  let t = await tap(card.cx, card.cy);
  if (t.code !== 0) fail("tap_card");
  await sleep(2800);
  f = await focusNow();
  if (!isDetailFocus(f.FOCUS)) {
    // one fallback percentage tap left column
    await tap(274, 700);
    await sleep(2500);
    f = await focusNow();
  }
  if (!isDetailFocus(f.FOCUS)) fail("not_detail", { FOCUS: f.FOCUS || "" });
  console.log(`FOCUS_DETAIL=${f.FOCUS}`);

  // 4 dump detail bar
  d = await dumpNow();
  if (d.code !== 0 || !d.DUMP || !existsSync(d.DUMP)) fail("dump_detail");
  xml = readFileSync(d.DUMP, "utf8");
  let bar = parseBottomBar(xml);
  if (!bar.like) {
    // video / overlay: tap center pause
    await tap(540, 900);
    await sleep(800);
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) {
      xml = readFileSync(d.DUMP, "utf8");
      bar = parseBottomBar(xml);
    }
  }
  if (!bar.like) fail("like_btn_missing");

  const before = likeState(bar.like);
  const beforeDesc = bar.like.desc;
  console.log(`LIKE_BEFORE=${beforeDesc}`);
  console.log(`LIKE_XY=${bar.like.x},${bar.like.y}`);
  console.log(`COLLECT=${bar.collect?.desc || ""}`);
  console.log(`COMMENT=${bar.comment?.desc || ""}`);

  if (before === "liked") {
    console.log(`LIKE=skip`);
    console.log(`REASON=already-liked`);
    await back();
    await sleep(1200);
    f = await focusNow();
    console.log(`BACK_HOME=${isHomeFocus(f.FOCUS) ? "yes" : "no"}`);
    console.log(`FOCUS=${f.FOCUS || ""}`);
    console.log(`ALIAS=${alias}`);
    bizRecord({ op: "like", outcome: "skip", reason: "already-liked", alias, serial: (s && s.serial) || null, startMs: t0 });
    s.close();
    process.exit(0);
  }

  if (dryRun) {
    console.log(`LIKE=dry-run`);
    console.log(`REASON=located-not-tapped`);
    await back();
    console.log(`ALIAS=${alias}`);
    bizRecord({ op: "like", outcome: "dry-run", reason: "located-not-tapped", alias, serial: (s && s.serial) || null, startMs: t0 });
    s.close();
    process.exit(0);
  }

  // 5 tap like
  t = await tap(bar.like.x, bar.like.y);
  if (t.code !== 0) fail("tap_like");
  await sleep(1600);

  // 6 verify
  d = await dumpNow();
  if (d.code !== 0 || !d.DUMP || !existsSync(d.DUMP)) fail("dump_after_like");
  xml = readFileSync(d.DUMP, "utf8");
  bar = parseBottomBar(xml);
  const afterDesc = bar.like?.desc || "";
  const after = likeState(bar.like);
  console.log(`LIKE_AFTER=${afterDesc}`);

  const ok =
    after === "liked" ||
    (afterDesc && beforeDesc && afterDesc !== beforeDesc) ||
    /已点赞/.test(afterDesc);

  // 7 back home
  let home = false;
  for (let i = 0; i < 3; i += 1) {
    await back();
    await sleep(1200);
    f = await focusNow();
    if (isHomeFocus(f.FOCUS)) {
      home = true;
      break;
    }
  }
  console.log(`BACK_HOME=${home ? "yes" : "no"}`);
  console.log(`FOCUS=${f.FOCUS || ""}`);

  if (!ok) fail("like_not_confirmed", { LIKE_BEFORE: beforeDesc, LIKE_AFTER: afterDesc });
  if (!home) {
    console.log(`LIKE=ok`);
    console.log(`WARN=back_not_home`);
    console.log(`ALIAS=${alias}`);
    bizRecord({ op: "like", outcome: "ok", alias, serial: (s && s.serial) || null, startMs: t0 });
    s.close();
    process.exit(0);
  }
  console.log(`LIKE=ok`);
  console.log(`ALIAS=${alias}`);
  bizRecord({ op: "like", outcome: "ok", alias, serial: (s && s.serial) || null, startMs: t0 });
  s.close();
  process.exit(0);
}

main().catch((e) => {
  console.log(`LIKE=fail`);
  console.log(`REASON=exception`);
  console.log(`DETAIL=${String(e.message || e).slice(0, 300)}`);
  console.log(`ALIAS=${alias}`);
  try { s && s.close(); } catch { /* */ }
  bizRecord({ op: "like", outcome: "fail", reason: "exception", extra: { detail: String(e.message || e).slice(0, 300) }, alias, serial: (s && s.serial) || null, startMs: t0 });
  process.exit(4);
});