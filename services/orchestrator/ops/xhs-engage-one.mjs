#!/usr/bin/env node
/**
 * XHS combined engage recipe:
 *   optional search → open one note → like/collect/comment (flags) → back home
 *
 *   node ops/xhs-engage-one.mjs --alias 01 --like
 *   node ops/xhs-engage-one.mjs --alias 02 --keyword 穿搭 --like --collect
 *   node ops/xhs-engage-one.mjs --alias 03 --comment "学到了" --like
 *   node ops/xhs-engage-one.mjs --alias 04 --keyword 夏日 --like --collect --comment "学到了"
 *
 * Default source = feed. With --keyword uses search results.
 * Real comment/like/collect need prior human authorization in session.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./_explore-lib.mjs";
import { bizRecord } from "./_biz-trace.mjs";
import {
  parseFeedCards,
  parseSearchResults,
  pickFeedCard,
  parseBottomBar,
  likeState,
  findSendBtn,
  findEditText,
  isHomeFocus,
  isDetailFocus,
} from "./_xhs-parse.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PKG = "com.xingin.xhs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/xhs-engage-one.mjs --alias <01-04> [选项]
  --keyword <词>     从搜索进笔记（默认信息流）
  --like             点赞
  --collect          收藏
  --comment <文案>   发评论
  --dry-run          只进详定位底栏，不互动
  --no-force-stop
stdout: ENGAGE=ok|fail 及分项 KV`);
  process.exit(0);
}

const alias = opt("--alias");
const ssh = opt("--ssh", "xhs-windows");
const keyword = opt("--keyword");
const commentText = opt("--comment");
const doLike = flag("--like");
const doCollect = flag("--collect");
const dryRun = flag("--dry-run");
const forceStop = !flag("--no-force-stop");
if (!alias) {
  console.log("✗ need --alias");
  process.exit(4);
}
if (!dryRun && !doLike && !doCollect && !commentText) {
  console.log("✗ need at least one of --like --collect --comment <text> (or --dry-run)");
  process.exit(4);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runOps(args, timeoutMs = 360000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn("node", args, { cwd: ROOT });
    let out = "";
    const timer = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {}
      resolve({ code: 124, out: out + "\n[timeout]", ms: Date.now() - t0 });
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

let t0 = Date.now(); // 业务动作起点（module-scope，fail/catch 也能引用）

function fail(reason, extra = {}) {
  console.log(`ENGAGE=fail`);
  console.log(`REASON=${reason}`);
  for (const [k, v] of Object.entries(extra)) if (v != null && v !== "") console.log(`${k}=${String(v).slice(0, 200)}`);
  console.log(`ALIAS=${alias}`);
  // biz trace：终态同步落盘（SSH 路径同步 execFileSync），落完再 exit；partial 子失败记在 reason/extra
  bizRecord({ op: "engage", outcome: "fail", reason, extra, alias, serial: null, startMs: t0 });
  process.exit(2);
}

async function focusNow() {
  const r = await runOps(["ops/focus.mjs", "--alias", alias, "--ssh", ssh], 30000);
  return { ...r, ...kv(r.out) };
}
async function dumpNow() {
  const r = await runOps(["ops/dump-ui.mjs", "--alias", alias, "--ssh", ssh], 50000);
  return { ...r, ...kv(r.out) };
}
async function tapXY(x, y) {
  return runOps(["ops/tap.mjs", "--alias", alias, "--x", String(x), "--y", String(y), "--ssh", ssh], 20000);
}
async function backHome(max = 4) {
  for (let i = 0; i < max; i++) {
    await runOps(["ops/back.mjs", "--alias", alias, "--ssh", ssh], 15000);
    await sleep(1100);
    const f = await focusNow();
    if (isHomeFocus(f.FOCUS)) return true;
  }
  return false;
}

function collectState(desc) {
  if (!desc) return "missing";
  if (/已收藏/.test(desc)) return "collected";
  if (/收藏/.test(desc)) return "uncollected";
  return "unknown";
}

async function openFromFeed() {
  const launchArgs = ["ops/launch-app.mjs", "--alias", alias, "--package", PKG, "--ssh", ssh];
  if (forceStop) launchArgs.push("--force-stop");
  let r = await runOps(launchArgs, 45000);
  if (r.code !== 0) fail("launch");
  await sleep(2600);
  let d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_feed");
  let cards = parseFeedCards(readFileSync(d.DUMP, "utf8"));
  let card = pickFeedCard(cards, { prefer: "note", avoidWan: true });
  if (!card) {
    await runOps(["ops/swipe.mjs", "--alias", alias, "--up", "--ssh", ssh], 20000);
    await sleep(900);
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) {
      cards = parseFeedCards(readFileSync(d.DUMP, "utf8"));
      card = pickFeedCard(cards, { prefer: "note", avoidWan: false });
    }
  }
  if (!card) fail("no_feed_card");
  console.log(`SOURCE=feed`);
  console.log(`CARD_TITLE=${card.title.slice(0, 80)}`);
  console.log(`CARD_AUTHOR=${card.author || ""}`);
  console.log(`CARD_XY=${card.cx},${card.cy}`);
  r = await tapXY(card.cx, card.cy);
  if (r.code !== 0) fail("tap_card");
  await sleep(2800);
}

async function openFromSearch(kw) {
  const args = ["ops/xhs-search.mjs", "--alias", alias, "--keyword", kw, "--ssh", ssh];
  if (!forceStop) args.push("--no-force-stop");
  let r = await runOps(args, 180000);
  const k = kv(r.out);
  if (r.code !== 0 || k.SEARCH !== "ok") fail("search", { DETAIL: r.out.slice(0, 200) });
  console.log(`SOURCE=search`);
  console.log(`KEYWORD=${kw}`);
  console.log(`SEARCH_COUNT=${k.COUNT || 0}`);
  // prefer CARD1 coords
  let x = 274;
  let y = 977;
  let title = "";
  if (k.CARD1) {
    try {
      const c = JSON.parse(k.CARD1);
      if (c.xy) {
        x = c.xy[0];
        y = c.xy[1];
      }
      title = c.title || "";
    } catch {}
  } else if (k.DUMP && existsSync(k.DUMP)) {
    const parsed = parseSearchResults(readFileSync(k.DUMP, "utf8"));
    if (parsed.cards[0]) {
      x = parsed.cards[0].cx;
      y = parsed.cards[0].cy;
      title = parsed.cards[0].title;
    }
  }
  console.log(`CARD_TITLE=${String(title).slice(0, 80)}`);
  console.log(`CARD_XY=${x},${y}`);
  r = await tapXY(x, y);
  if (r.code !== 0) {
    // one retry — 22222 contention can flake
    await sleep(800);
    r = await tapXY(x, y);
  }
  if (r.code !== 0) fail("tap_search_card", { DETAIL: r.out?.slice?.(0, 120) || "" });
  await sleep(3000);
  // if still not detail, try slightly lower on card body
  let fchk = await focusNow();
  if (!isDetailFocus(fchk.FOCUS)) {
    await tapXY(x, Math.min(y + 80, 1400));
    await sleep(2800);
  }
}

async function ensureDetailBar() {
  let f = await focusNow();
  if (!isDetailFocus(f.FOCUS)) {
    // one more wait
    await sleep(1500);
    f = await focusNow();
  }
  if (!isDetailFocus(f.FOCUS)) fail("not_detail", { FOCUS: f.FOCUS || "" });
  console.log(`FOCUS_DETAIL=${f.FOCUS}`);
  let d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_detail");
  let xml = readFileSync(d.DUMP, "utf8");
  let bar = parseBottomBar(xml);
  if (!bar.like && !bar.collect) {
    await tapXY(540, 900);
    await sleep(800);
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) {
      xml = readFileSync(d.DUMP, "utf8");
      bar = parseBottomBar(xml);
    }
  }
  return { bar, xml, dump: d.DUMP };
}

async function doLikeAction(bar) {
  if (!bar.like) return { ok: false, reason: "like-missing" };
  const before = bar.like.desc;
  if (likeState(before) === "liked") return { ok: true, skip: true, before, after: before };
  await tapXY(bar.like.x, bar.like.y);
  await sleep(1500);
  const d = await dumpNow();
  const xml = d.DUMP && existsSync(d.DUMP) ? readFileSync(d.DUMP, "utf8") : "";
  const bar2 = xml ? parseBottomBar(xml) : {};
  const after = bar2.like?.desc || "";
  const ok = likeState(after) === "liked" || (after && after !== before);
  return { ok, before, after, bar: bar2 };
}

async function doCollectAction(bar) {
  if (!bar.collect) return { ok: false, reason: "collect-missing" };
  const before = bar.collect.desc;
  if (collectState(before) === "collected") return { ok: true, skip: true, before, after: before };
  await tapXY(bar.collect.x, bar.collect.y);
  await sleep(1500);
  const d = await dumpNow();
  const xml = d.DUMP && existsSync(d.DUMP) ? readFileSync(d.DUMP, "utf8") : "";
  const bar2 = xml ? parseBottomBar(xml) : {};
  const after = bar2.collect?.desc || "";
  const ok = collectState(after) === "collected" || (after && after !== before);
  return { ok, before, after, bar: bar2 };
}

async function doCommentAction(bar, text) {
  const box = bar.commentBox || bar.comment;
  if (!box) return { ok: false, reason: "comment-box-missing" };
  await tapXY(box.x, box.y);
  await sleep(2000);
  let d = await dumpNow();
  let xml = d.DUMP && existsSync(d.DUMP) ? readFileSync(d.DUMP, "utf8") : "";
  if (!findEditText(xml) && !findSendBtn(xml)) {
    await tapXY(box.x, box.y);
    await sleep(1800);
    d = await dumpNow();
    xml = d.DUMP && existsSync(d.DUMP) ? readFileSync(d.DUMP, "utf8") : "";
  }
  const edit = findEditText(xml);
  const ix = edit?.x ?? box.x;
  const iy = edit?.y ?? box.y;
  let r = await runOps(
    [
      "ops/input-text.mjs",
      "--alias",
      alias,
      "--text",
      text,
      "--x",
      String(ix),
      "--y",
      String(iy),
      "--clear-first",
      "--keep-ime",
      "--ssh",
      ssh,
    ],
    60000,
  );
  if (r.code !== 0) return { ok: false, reason: "input-fail", detail: r.out.slice(0, 120) };
  await sleep(1200);
  d = await dumpNow();
  xml = d.DUMP && existsSync(d.DUMP) ? readFileSync(d.DUMP, "utf8") : "";
  let send = findSendBtn(xml);
  const editAfter = findEditText(xml);
  if (!send || !(editAfter?.text || "").includes(text)) {
    // one retry
    await tapXY(box.x, box.y);
    await sleep(1200);
    r = await runOps(
      [
        "ops/input-text.mjs",
        "--alias",
        alias,
        "--text",
        text,
        "--x",
        String(ix),
        "--y",
        String(iy),
        "--clear-first",
        "--keep-ime",
        "--ssh",
        ssh,
      ],
      60000,
    );
    await sleep(1200);
    d = await dumpNow();
    xml = d.DUMP && existsSync(d.DUMP) ? readFileSync(d.DUMP, "utf8") : "";
    send = findSendBtn(xml);
  }
  if (!send) return { ok: false, reason: "send-missing" };
  await tapXY(send.x, send.y);
  await sleep(2200);
  d = await dumpNow();
  xml = d.DUMP && existsSync(d.DUMP) ? readFileSync(d.DUMP, "utf8") : "";
  let verify = "none";
  if (xml.includes(text)) verify = "text-in-dump";
  else if (!findSendBtn(xml) && !/text="发送"/.test(xml)) verify = "composer-closed";
  return { ok: verify !== "none", verify, editAfter: editAfter?.text || "" };
}

async function main() {
  t0 = Date.now();
  if (keyword) await openFromSearch(keyword);
  else await openFromFeed();

  let { bar } = await ensureDetailBar();
  console.log(`BAR_LIKE=${bar.like?.desc || ""}`);
  console.log(`BAR_COLLECT=${bar.collect?.desc || ""}`);
  console.log(`BAR_COMMENT=${bar.comment?.desc || ""}`);

  if (dryRun) {
    console.log(`ENGAGE=dry-run`);
    await backHome();
    console.log(`ALIAS=${alias}`);
    bizRecord({ op: "engage", outcome: "dry-run", alias, serial: null, startMs: t0 });
    process.exit(0);
  }

  const results = {};
  if (doLike) {
    const r = await doLikeAction(bar);
    results.like = r;
    console.log(`LIKE=${r.ok ? (r.skip ? "skip" : "ok") : "fail"}`);
    if (r.before) console.log(`LIKE_BEFORE=${r.before}`);
    if (r.after) console.log(`LIKE_AFTER=${r.after}`);
    if (r.bar) bar = r.bar;
  }
  if (doCollect) {
    // refresh bar if needed
    if (!bar.collect) {
      const d = await dumpNow();
      if (d.DUMP && existsSync(d.DUMP)) bar = parseBottomBar(readFileSync(d.DUMP, "utf8"));
    }
    const r = await doCollectAction(bar);
    results.collect = r;
    console.log(`COLLECT=${r.ok ? (r.skip ? "skip" : "ok") : "fail"}`);
    if (r.before) console.log(`COLLECT_BEFORE=${r.before}`);
    if (r.after) console.log(`COLLECT_AFTER=${r.after}`);
    if (r.bar) bar = r.bar;
  }
  if (commentText) {
    const d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) bar = parseBottomBar(readFileSync(d.DUMP, "utf8"));
    const r = await doCommentAction(bar, commentText);
    results.comment = r;
    console.log(`COMMENT=${r.ok ? "ok" : "fail"}`);
    if (r.verify) console.log(`COMMENT_VERIFY=${r.verify}`);
    if (r.reason) console.log(`COMMENT_REASON=${r.reason}`);
  }

  const home = await backHome();
  console.log(`BACK_HOME=${home ? "yes" : "no"}`);
  const f = await focusNow();
  console.log(`FOCUS=${f.FOCUS || ""}`);

  const parts = [];
  if (doLike) parts.push(results.like?.ok);
  if (doCollect) parts.push(results.collect?.ok);
  if (commentText) parts.push(results.comment?.ok);
  const ok = parts.length ? parts.every(Boolean) : true;
  if (!ok) fail("partial", { LIKE: results.like?.ok, COLLECT: results.collect?.ok, COMMENT: results.comment?.ok });
  console.log(`ENGAGE=ok`);
  console.log(`ALIAS=${alias}`);
  bizRecord({ op: "engage", outcome: "ok", alias, serial: null, startMs: t0 });
  process.exit(0);
}

main().catch((e) => {
  console.log(`ENGAGE=fail`);
  console.log(`REASON=exception`);
  console.log(`DETAIL=${String(e.message || e).slice(0, 300)}`);
  console.log(`ALIAS=${alias}`);
  bizRecord({ op: "engage", outcome: "fail", reason: "exception", extra: { detail: String(e.message || e).slice(0, 300) }, alias, serial: null, startMs: t0 });
  process.exit(4);
});
