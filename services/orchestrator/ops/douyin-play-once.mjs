#!/usr/bin/env node
/**
 * Douyin single play — one business op for free-explore mix.
 *
 *   node ops/douyin-play-once.mjs --alias 01 --kind like
 *   kinds: like|collect|follow|comment|save_album|clear_screen|visual_search|
 *          watch_later|share_probe|longpress_probe|browse|speed
 *
 * stdout: PLAY=<kind> OUTCOME=ok|skip|fail|observe ...
 * Red lines: no pay / shoot / DM friends / report submit / WeChat share.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./_explore-lib.mjs";
import { bizRecord } from "./_biz-trace.mjs";
import { decodeEntities } from "./_xhs-parse.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PKG = "com.ss.android.ugc.aweme";
const KINDS = [
  "like",
  "collect",
  "follow",
  "comment",
  "save_album",
  "clear_screen",
  "visual_search",
  "watch_later",
  "share_probe",
  "longpress_probe",
  "browse",
  "speed",
];

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/douyin-play-once.mjs --alias <01-04> --kind <${KINDS.join("|")}> [--no-force-stop]
stdout: PLAY=… OUTCOME=ok|skip|fail|observe`);
  process.exit(0);
}

const alias = opt("--alias");
const kind = opt("--kind");
const ssh = opt("--ssh", "xhs-windows");
const forceStop = !flag("--no-force-stop");
if (!alias || !kind || !KINDS.includes(kind)) {
  console.log("✗ need --alias and --kind in " + KINDS.join("|"));
  process.exit(4);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const discDir = join(ROOT, "runtime", "douyin-discover");
mkdirSync(discDir, { recursive: true });
const discLog = join(discDir, `discover-${alias}.jsonl`);

function runOps(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn("node", args, { cwd: ROOT, env: { ...process.env, XHS_LOCAL: "1" } });
    let out = "";
    const timer = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {}
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

function parseNodes(raw) {
  const nodes = [];
  for (const m of String(raw || "").matchAll(/<node ([^>]+)\/>/g)) {
    const a = m[1];
    const get = (k) => {
      const r = a.match(new RegExp(k + '="([^"]*)"'));
      return r ? decodeEntities(r[1]) : "";
    };
    const b = get("bounds").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) continue;
    nodes.push({
      text: get("text"),
      desc: get("content-desc"),
      cls: get("class"),
      enabled: /enabled="true"/.test(a),
      clickable: /clickable="true"/.test(a),
      x1: +b[1],
      y1: +b[2],
      x2: +b[3],
      y2: +b[4],
      cx: ((+b[1] + +b[3]) / 2) | 0,
      cy: ((+b[2] + +b[4]) / 2) | 0,
    });
  }
  return nodes;
}

function discover(items, source) {
  const row = { ts: new Date().toISOString(), source, items: items.slice(0, 40) };
  appendFileSync(discLog, JSON.stringify(row) + "\n");
  console.log(`DISCOVERED=${items.slice(0, 20).join("|")}`);
}

let t0 = Date.now();

function done(outcome, reason, extra = {}) {
  console.log(`PLAY=${kind}`);
  console.log(`OUTCOME=${outcome}`);
  if (reason) console.log(`REASON=${reason}`);
  for (const [k, v] of Object.entries(extra)) if (v != null) console.log(`${k}=${String(v).slice(0, 220)}`);
  console.log(`ALIAS=${alias}`);
  bizRecord({
    op: `douyin-play-${kind}`,
    outcome,
    reason: reason || null,
    extra,
    alias,
    serial: null,
    startMs: t0,
  });
  process.exit(outcome === "fail" ? 2 : 0);
}

async function dumpXml() {
  const r = await runOps(["ops/dump-ui.mjs", "--alias", alias, "--ssh", ssh], 50000);
  const k = kv(r.out);
  if (k.DUMP && existsSync(k.DUMP)) return readFileSync(k.DUMP, "utf8");
  return null;
}

async function tapXY(x, y) {
  return runOps(["ops/tap.mjs", "--alias", alias, "--x", String(x), "--y", String(y), "--ssh", ssh], 20000);
}
async function backOnce() {
  return runOps(["ops/back.mjs", "--alias", alias, "--ssh", ssh], 15000);
}
async function swipe(x1, y1, x2, y2, ms = 350) {
  return runOps(
    ["ops/swipe.mjs", "--alias", alias, "--x1", String(x1), "--y1", String(y1), "--x2", String(x2), "--y2", String(y2), "--ms", String(ms), "--ssh", ssh],
    20000,
  );
}
async function longPress(x = 400, y = 1100, ms = 1500) {
  return runOps(["ops/shell.mjs", "--alias", alias, "--cmd", `input swipe ${x} ${y} ${x} ${y} ${ms}`, "--ssh", ssh], 20000);
}
async function ensureFeed(swipes = 2) {
  for (let i = 0; i < swipes; i++) {
    const xml = await dumpXml();
    const ns = xml ? parseNodes(xml) : [];
    const rail = ns.find((n) => /喜欢|收藏|评论|分享/.test(n.desc) && /按钮/.test(n.desc) && n.cx > 850);
    if (rail) return xml;
    // dismiss sheets
    if (ns.some((n) => n.text === "取消" || n.desc === "关闭")) {
      const c = ns.find((n) => n.text === "取消") || ns.find((n) => n.desc === "关闭");
      if (c) await tapXY(c.cx, c.cy);
      else await backOnce();
      await sleep(800);
    }
    await swipe(540, 1600, 540, 700, 320);
    await sleep(1500);
  }
  return dumpXml();
}

function findRail(ns, re) {
  return ns
    .filter((n) => re.test(n.desc) && /按钮/.test(n.desc) && n.cx > 850 && n.cy > 400 && n.cy < 2100)
    .sort((a, b) => a.cy - b.cy)[0];
}

async function openShare(ns) {
  const share = findRail(ns, /分享/);
  if (!share) return false;
  await tapXY(share.cx, share.cy);
  await sleep(1800);
  return true;
}

async function findTextTap(pred, swipes = 4) {
  for (let i = 0; i < swipes; i++) {
    const xml = await dumpXml();
    const ns = xml ? parseNodes(xml) : [];
    const hit = ns.find(pred);
    if (hit) {
      await tapXY(hit.cx, hit.cy);
      return hit;
    }
    // share bottom bar is horizontal around y~2159
    await swipe(900, 2159, 200, 2159, 400);
    await sleep(700);
  }
  return null;
}

async function closePanels() {
  for (let i = 0; i < 3; i++) {
    const xml = await dumpXml();
    const ns = xml ? parseNodes(xml) : [];
    if (ns.some((n) => /喜欢/.test(n.desc) && /按钮/.test(n.desc) && n.cx > 850)) return;
    const cancel = ns.find((n) => n.text === "取消" || n.desc === "关闭" || n.text === "退出专注模式");
    if (cancel) await tapXY(cancel.cx, cancel.cy);
    else await backOnce();
    await sleep(700);
  }
}

async function playSaveAlbum() {
  let xml = await ensureFeed();
  let ns = xml ? parseNodes(xml) : [];
  if (!(await openShare(ns))) return done("fail", "share_btn_missing");

  xml = await dumpXml();
  ns = xml ? parseNodes(xml) : [];
  const labels = [...new Set(ns.map((n) => n.text || n.desc).filter((t) => t && t.length < 20))];
  discover(labels, "share_panel");

  // prefer 生成图片 → 保存至相册 (stable); try 保存本地 only if clearly present
  let hit = await findTextTap((n) => n.text === "生成图片" || n.desc === "生成图片", 5);
  if (!hit) {
    hit = await findTextTap((n) => n.text === "保存本地" || n.desc === "保存本地", 3);
    if (hit) {
      await sleep(1500);
      await closePanels();
      return done("ok", "save_local_tapped", { PATH: "保存本地" });
    }
    await closePanels();
    return done("fail", "gen_image_missing");
  }
  await sleep(1500);
  const album = await findTextTap((n) => n.text === "保存至相册" || n.desc === "保存至相册", 2);
  if (!album) {
    await closePanels();
    return done("fail", "save_album_missing");
  }
  await sleep(1500);
  await closePanels();
  return done("ok", "saved_album", { PATH: "生成图片→保存至相册" });
}

async function playLongpressMenu(actionText) {
  let xml = await ensureFeed();
  await longPress(400, 1100, 1500);
  await sleep(1200);
  xml = await dumpXml();
  let ns = xml ? parseNodes(xml) : [];
  // dismiss location permission
  const deny = ns.find((n) => n.text === "拒绝" || n.text === "不允许");
  if (deny) {
    await tapXY(deny.cx, deny.cy);
    await sleep(800);
    await longPress(400, 1100, 1500);
    await sleep(1200);
    xml = await dumpXml();
    ns = xml ? parseNodes(xml) : [];
  }
  const labels = [...new Set(ns.map((n) => n.text || n.desc).filter((t) => t && t.length < 24))];
  discover(labels, "longpress_menu");

  if (!actionText) {
    await closePanels();
    return done("observe", "menu_logged", { ITEMS: labels.slice(0, 15).join("|") });
  }

  const hit = ns.find((n) => n.text === actionText || n.desc === actionText || (n.text && n.text.includes(actionText)));
  if (!hit) {
    await closePanels();
    return done("fail", "action_missing", { WANT: actionText, ITEMS: labels.slice(0, 12).join("|") });
  }
  await tapXY(hit.cx, hit.cy);
  await sleep(1800);
  return { labels };
}

async function playClearScreen() {
  const r = await playLongpressMenu("清屏播放");
  if (r == null) return; // already exited via done()
  await sleep(2000);
  const xml = await dumpXml();
  const ns = xml ? parseNodes(xml) : [];
  discover(
    ns.map((n) => n.text || n.desc).filter((t) => t && /专注|倍速|全屏|暂停|退出/.test(t)),
    "clear_screen",
  );
  const exit = ns.find((n) => n.text === "退出专注模式" || n.desc === "退出专注模式");
  if (exit) await tapXY(exit.cx, exit.cy);
  else await backOnce();
  await sleep(800);
  await closePanels();
  return done("ok", "clear_screen_cycled");
}

async function playVisualSearch() {
  const r = await playLongpressMenu("识别图片");
  if (r == null) return;
  await sleep(2500);
  const xml = await dumpXml();
  const ns = xml ? parseNodes(xml) : [];
  const focus = await runOps(["ops/focus.mjs", "--alias", alias, "--ssh", ssh], 20000);
  const f = kv(focus.out).FOCUS || "";
  console.log(`FOCUS=${f}`);
  discover(
    ns.map((n) => n.text || n.desc).filter(Boolean).slice(0, 30),
    "visual_search",
  );
  await backOnce();
  await sleep(800);
  await closePanels();
  return done("ok", "visual_search_observed", { FOCUS: f });
}

async function playWatchLater() {
  const r = await playLongpressMenu("稍后再看");
  if (r == null) return;
  await sleep(1000);
  await closePanels();
  return done("ok", "watch_later");
}

async function playSpeed() {
  const r = await playLongpressMenu("倍速");
  if (r == null) return;
  await sleep(800);
  const xml = await dumpXml();
  const ns = xml ? parseNodes(xml) : [];
  discover(
    ns.map((n) => n.text).filter((t) => t && /倍|0\.|1\.|2\.|3\./.test(t)),
    "speed_sheet",
  );
  // pick 1.0 or close — don't leave weird speed
  const one = ns.find((n) => n.text === "1.0" || n.text === "1.0x" || n.text === "正常");
  if (one) await tapXY(one.cx, one.cy);
  else await backOnce();
  await sleep(600);
  await closePanels();
  return done("ok", "speed_probed");
}

async function playShareProbe() {
  let xml = await ensureFeed();
  let ns = xml ? parseNodes(xml) : [];
  if (!(await openShare(ns))) return done("fail", "share_btn_missing");
  const found = [];
  for (let i = 0; i < 5; i++) {
    xml = await dumpXml();
    ns = xml ? parseNodes(xml) : [];
    for (const n of ns) {
      const t = n.text || n.desc;
      if (t && t.length >= 2 && t.length <= 16) found.push(t);
    }
    await swipe(900, 2159, 200, 2159, 400);
    await sleep(600);
  }
  const uniq = [...new Set(found)];
  discover(uniq, "share_probe");
  writeFileSync(join(discDir, `share-probe-${alias}-latest.json`), JSON.stringify({ at: new Date().toISOString(), items: uniq }, null, 2));
  await closePanels();
  return done("observe", "share_scanned", { COUNT: String(uniq.length), ITEMS: uniq.slice(0, 18).join("|") });
}

async function playBrowse() {
  const n = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    await swipe(540, 1700, 540, 650, 320);
    await sleep(1200 + Math.floor(Math.random() * 800));
  }
  const xml = await dumpXml();
  const ns = xml ? parseNodes(xml) : [];
  const rail = ns.filter((n) => /按钮/.test(n.desc) && n.cx > 850).map((n) => n.desc);
  discover(rail.slice(0, 8), "browse_rail");
  return done("ok", "browsed", { SWIPES: String(n) });
}

async function delegateExisting(script, okKey) {
  const args = [script, "--alias", alias, "--no-force-stop"];
  if (script.includes("comment")) args.push("--screens", "3");
  const timeout = script.includes("comment") ? 300000 : 180000;
  const r = await runOps(args, timeout);
  const k = kv(r.out);
  console.log(r.out.split(/\n/).slice(-12).join("\n"));
  const val = k[okKey] || k.COMMENT || k.OUTCOME;
  if (val === "ok" || val === "skip" || val === "dry-run" || r.code === 0) {
    return done(val === "skip" ? "skip" : "ok", val || "delegated", k);
  }
  return done("fail", k.REASON || "delegate_fail", { DETAIL: r.out.slice(-200) });
}

async function main() {
  t0 = Date.now();
  if (["save_album", "clear_screen", "visual_search", "watch_later", "share_probe", "longpress_probe", "browse", "speed"].includes(kind)) {
    const launchArgs = ["ops/launch-app.mjs", "--alias", alias, "--package", PKG, "--ssh", ssh];
    if (forceStop) launchArgs.push("--force-stop");
    const r = await runOps(launchArgs, 45000);
    if (r.code !== 0) return done("fail", "launch");
    await sleep(forceStop ? 5000 : 1500);
  }

  if (kind === "like") return delegateExisting("ops/douyin-like.mjs", "DOUYIN_LIKE");
  if (kind === "collect") return delegateExisting("ops/douyin-collect.mjs", "DOUYIN_COLLECT");
  if (kind === "follow") return delegateExisting("ops/douyin-follow.mjs", "DOUYIN_FOLLOW");
  if (kind === "comment") return delegateExisting("ops/douyin-comment-copy-top.mjs", "COMMENT");
  if (kind === "save_album") return playSaveAlbum();
  if (kind === "clear_screen") return playClearScreen();
  if (kind === "visual_search") return playVisualSearch();
  if (kind === "watch_later") return playWatchLater();
  if (kind === "share_probe") return playShareProbe();
  if (kind === "longpress_probe") {
    await playLongpressMenu(null);
    return;
  }
  if (kind === "browse") return playBrowse();
  if (kind === "speed") return playSpeed();
  return done("fail", "unknown_kind");
}

main().catch((e) => {
  console.log(`PLAY=${kind}`);
  console.log(`OUTCOME=fail`);
  console.log(`REASON=exception`);
  console.log(`DETAIL=${String(e.message || e).slice(0, 300)}`);
  process.exit(4);
});
