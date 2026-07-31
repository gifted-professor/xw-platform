#!/usr/bin/env node
/**
 * XHS publish entry explorer — open publish sheet / text editor.
 * NEVER taps final 发布 to go live.
 *
 *   node ops/xhs-publish-entry.mjs --alias 04
 *   node ops/xhs-publish-entry.mjs --alias 04 --text-note   # try 写文字 path
 *
 * Stops at album picker or text editor. Always leaves with BACK, no publish.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./_explore-lib.mjs";
import { bizRecord } from "./_biz-trace.mjs";
import { decodeEntities, isHomeFocus, findEditText } from "./_xhs-parse.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PKG = "com.xingin.xhs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/xhs-publish-entry.mjs --alias <01-04> [--text-note] [--no-force-stop]
只进发布入口/编辑页，绝不点最终发布。`);
  process.exit(0);
}

const alias = opt("--alias");
const ssh = opt("--ssh", "xhs-windows");
const textNote = flag("--text-note");
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

let t0 = Date.now(); // 业务动作起点（module-scope，fail/catch 也能引用）

function fail(reason, extra = {}) {
  console.log(`PUBLISH_ENTRY=fail`);
  console.log(`REASON=${reason}`);
  for (const [k, v] of Object.entries(extra)) if (v != null) console.log(`${k}=${String(v).slice(0, 220)}`);
  console.log(`ALIAS=${alias}`);
  // biz trace：终态同步落盘（SSH 路径同步 execFileSync），落完再 exit
  bizRecord({ op: "publish_entry", outcome: "fail", reason, extra, alias, serial: null, startMs: t0 });
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
      L: +b[1],
      T: +b[2],
      R: +b[3],
      B: +b[4],
      cx: Math.round((+b[1] + +b[3]) / 2),
      cy: Math.round((+b[2] + +b[4]) / 2),
      text: decodeEntities((tag.match(/text="([^"]*)"/) || [])[1] || ""),
      desc: decodeEntities((tag.match(/content-desc="([^"]*)"/) || [])[1] || ""),
      clickable: /clickable="true"/.test(tag),
    });
  }
  return out;
}

function findLabel(xml, patterns) {
  const nodes = allNodes(xml);
  for (const pat of patterns) {
    const re = typeof pat === "string" ? new RegExp(pat) : pat;
    const hit = nodes.find((n) => re.test(n.text || "") || re.test(n.desc || ""));
    if (hit) return { ...hit, matched: hit.text || hit.desc };
  }
  return null;
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

async function main() {
  t0 = Date.now();
  const launchArgs = ["ops/launch-app.mjs", "--alias", alias, "--package", PKG, "--ssh", ssh];
  if (forceStop) launchArgs.push("--force-stop");
  let r = await runOps(launchArgs, 45000);
  if (r.code !== 0) fail("launch");
  await sleep(2600);

  let d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_home");
  let xml = readFileSync(d.DUMP, "utf8");
  // bottom 发布 tab
  let pub = findLabel(xml, [/^发布$/, /content-desc="发布/, /^发布$/]);
  if (!pub) {
    // bottom center ~ 540, 2290
    pub = { cx: 540, cy: 2290, matched: "fallback-center-tab" };
  }
  console.log(`PUBLISH_TAB=${pub.matched || "发布"}@${pub.cx},${pub.cy}`);
  await tapXY(pub.cx, pub.cy);
  await sleep(2200);

  let f = await focusNow();
  console.log(`FOCUS_SHEET=${f.FOCUS || ""}`);
  d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_sheet");
  xml = readFileSync(d.DUMP, "utf8");
  const labels = allNodes(xml)
    .filter((n) => n.text || n.desc)
    .map((n) => n.text || n.desc)
    .filter((t) => /相册|相机|拍摄|直播|写文字|文字|视频|模板|发布/.test(t));
  console.log(`SHEET_LABELS=${[...new Set(labels)].slice(0, 20).join("|")}`);

  const album = findLabel(xml, [/从相册选择/, /相册/, /^相册$/]);
  const camera = findLabel(xml, [/^相机$/, /拍照/]);
  const writeText = findLabel(xml, [/写文字/, /^文字$/, /写文字/]);
  const live = findLabel(xml, [/拍摄与直播/, /直播/]);
  if (album) console.log(`OPT_ALBUM=${album.matched}@${album.cx},${album.cy}`);
  if (camera) console.log(`OPT_CAMERA=${camera.matched}@${camera.cx},${camera.cy}`);
  if (writeText) console.log(`OPT_TEXT=${writeText.matched}@${writeText.cx},${writeText.cy}`);
  if (live) console.log(`OPT_LIVE=${live.matched}@${live.cx},${live.cy}`);

  let stage = "sheet";
  if (textNote && writeText) {
    await tapXY(writeText.cx, writeText.cy);
    await sleep(2200);
    f = await focusNow();
    console.log(`FOCUS_TEXT=${f.FOCUS || ""}`);
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) {
      xml = readFileSync(d.DUMP, "utf8");
      const edit = findEditText(xml);
      const more = allNodes(xml)
        .filter((n) => n.text || n.desc)
        .map((n) => n.text || n.desc)
        .filter(Boolean)
        .slice(0, 25);
      console.log(`TEXT_HINTS=${more.join("|")}`);
      if (edit) console.log(`TEXT_EDIT=${edit.x},${edit.y}`);
      // safety: if we see a real 发布 button that posts, do NOT tap it
      const postBtn = findLabel(xml, [/^发布$/]);
      const nextBtn = findLabel(xml, [/^下一步$/]);
      if (postBtn) console.log(`POST_BTN_LOCATED_NOT_TAPPED=${postBtn.cx},${postBtn.cy}`);
      if (nextBtn) console.log(`NEXT_BTN_LOCATED_NOT_TAPPED=${nextBtn.cx},${nextBtn.cy}`);
      if (/Capa|Edit|capa/i.test(f.FOCUS || "") || edit || more.some((t) => /写想法|写长文|说点什么/.test(t))) {
        stage = "text-editor";
      } else {
        stage = "text-unknown";
      }
    }
  } else if (album) {
    await tapXY(album.cx, album.cy);
    await sleep(2200);
    f = await focusNow();
    console.log(`FOCUS_ALBUM=${f.FOCUS || ""}`);
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) {
      xml = readFileSync(d.DUMP, "utf8");
      const more = allNodes(xml)
        .filter((n) => n.text || n.desc)
        .map((n) => n.text || n.desc)
        .filter((t) => /相册|照片|视频|下一步|所有|最近|发布|取消/.test(t))
        .slice(0, 25);
      console.log(`ALBUM_HINTS=${[...new Set(more)].join("|")}`);
      const next = findLabel(xml, [/^下一步$/, /下一步/]);
      if (next) console.log(`NEXT_LOCATED_NOT_TAPPED=${next.cx},${next.cy}`);
      stage = "album-picker";
    }
  } else {
    stage = labels.length ? "sheet-options-visible" : "sheet-unknown";
  }

  // exit without publishing
  for (let i = 0; i < 4; i++) {
    await runOps(["ops/back.mjs", "--alias", alias, "--ssh", ssh], 15000);
    await sleep(900);
    f = await focusNow();
    if (isHomeFocus(f.FOCUS)) break;
  }
  f = await focusNow();
  console.log(`FOCUS_END=${f.FOCUS || ""}`);
  console.log(`STAGE=${stage}`);
  console.log(`PUBLISHED=no`);
  console.log(`PUBLISH_ENTRY=ok`);
  console.log(`ALIAS=${alias}`);
  bizRecord({ op: "publish_entry", outcome: "ok", reason: "entry-reached", alias, serial: null, startMs: t0 });
  process.exit(0);
}

main().catch((e) => {
  console.log(`PUBLISH_ENTRY=fail`);
  console.log(`REASON=exception`);
  console.log(`DETAIL=${String(e.message || e).slice(0, 300)}`);
  console.log(`ALIAS=${alias}`);
  bizRecord({ op: "publish_entry", outcome: "fail", reason: "exception", extra: { detail: String(e.message || e).slice(0, 300) }, alias, serial: null, startMs: t0 });
  process.exit(4);
});
