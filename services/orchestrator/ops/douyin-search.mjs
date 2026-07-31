#!/usr/bin/env node
/**
 * Douyin search — 抖音搜索关键词，进结果页，记录 Tabs + 卡片粗计数，back 回 Splash 壳。
 * 首个抖音业务 ops 脚本（v0.1，对齐 2026-07-31 01 烟测 SMOKE=ok）。
 * 只读探索型：不点开卡片、不进详情、不翻页（留 v0.2）。
 *
 *   node ops/douyin-search.mjs --alias 01 --keyword 阿勒泰
 *   node ops/douyin-search.mjs --alias 01 --keyword 阿勒泰 --no-force-stop
 *
 * stdout: DOUYIN_SEARCH=ok TABS=综合,视频,用户,图文,直播,团购 COUNT=N FOCUS=SearchResultActivity ...
 * biz trace: op="douyin-search"，runOps 型 serial=null。
 *
 * 依赖：node:fs/child_process/path/url；_explore-lib（parseArgs）；_biz-trace（bizRecord）；
 *   _xhs-parse（decodeEntities，App 无关）；ops/launch-app|dump-ui|tap|input-text|focus|back。
 * 禁 console.error（Windows bridge stderr=判死信号）；零第三方依赖。
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
const TAB_NAMES = ["综合", "视频", "用户", "图文", "直播", "团购"];

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/douyin-search.mjs --alias <01-04> --keyword <词> [--no-force-stop]
stdout: DOUYIN_SEARCH=ok TABS=综合,视频,用户,图文,直播,团购 COUNT=N FOCUS=SearchResultActivity
只搜索+记录 Tabs/卡片数，不点开卡片、不翻页；back 回 Splash 壳。`);
  process.exit(0);
}

const alias = opt("--alias");
const keyword = opt("--keyword") || opt("--text");
const ssh = opt("--ssh", "xhs-windows");
const forceStop = !flag("--no-force-stop");
if (!alias || !keyword) {
  console.log("✗ need --alias --keyword");
  process.exit(4);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runOps(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn("node", args, { cwd: ROOT });
    let out = "";
    const timer = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch {}
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
  console.log(`DOUYIN_SEARCH=fail`);
  console.log(`REASON=${reason}`);
  for (const [k, v] of Object.entries(extra)) if (v != null) console.log(`${k}=${String(v).slice(0, 220)}`);
  console.log(`ALIAS=${alias}`);
  // biz trace：终态同步落盘（SSH 路径同步 execFileSync），落完再 exit
  bizRecord({ op: "douyin-search", outcome: "fail", reason, extra, alias, serial: null, startMs: t0 });
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
      w: +b[3] - +b[1], h: +b[4] - +b[2],
      text: decodeEntities((tag.match(/text="([^"]*)"/) || [])[1] || ""),
      desc: decodeEntities((tag.match(/content-desc="([^"]*)"/) || [])[1] || ""),
      clickable: /clickable="true"/.test(tag),
      cls: ((tag.match(/class="([^"]*)"/) || [])[1] || "").split(".").pop(),
    });
  }
  return out;
}

// 首页顶栏搜索入口：text/desc 含「搜索」且在顶栏（y<250）；fallback 右上角（smoke 实测 1009,145）
function findSearchEntry(xml) {
  const ns = allNodes(xml);
  const hit = ns.find((n) => (/搜索/.test(n.text) || /搜索/.test(n.desc)) && n.cy < 250);
  if (hit) return { ...hit, matched: hit.text || hit.desc };
  return { cx: 1009, cy: 145, matched: "fallback-top-right" };
}

// 搜索建议页输入框：EditText 类且在顶栏；fallback 中心顶栏输入区（dump 实测 521,144）
function findSearchInput(xml) {
  const ns = allNodes(xml);
  const hit = ns.find((n) => /EditText|AutoCompleteTextView/.test(n.cls) && n.cy < 250);
  if (hit) return { ...hit, matched: "edittext" };
  return { cx: 521, cy: 144, matched: "fallback-edittext" };
}

// 结果页 Tabs：text 命中 TAB_NAMES 且在顶栏区（y<350），按 x 排序去重
function extractTabs(xml) {
  const ns = allNodes(xml);
  const tabs = ns.filter((n) => TAB_NAMES.includes(n.text) && n.cy < 350).sort((a, b) => a.cx - b.cx);
  const seen = new Set();
  const ordered = [];
  for (const n of tabs) {
    if (!seen.has(n.text)) { seen.add(n.text); ordered.push(n); }
  }
  return ordered;
}

// 结果区卡片粗计数：clickable + 较大 + 结果区 y>240；启发式，仅参考（smoke CARDISH=10）
function countCards(xml) {
  const ns = allNodes(xml);
  return ns.filter((n) => n.clickable && n.w >= 400 && n.h >= 120 && n.cy > 240 && n.cy < 2200).length;
}

// 抖音四 Tab 都挂 SplashActivity，回壳只验 SplashActivity（不验具体 Tab，避免四 Tab 都中招的歧义）
function isSplashFocus(focus) { return /SplashActivity/i.test(focus || ""); }
function isSearchFocus(focus) { return /SearchResultActivity/i.test(focus || ""); }

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
async function back() {
  return runOps(["ops/back.mjs", "--alias", alias, "--ssh", ssh], 15000);
}

async function main() {
  t0 = Date.now();
  const launchArgs = ["ops/launch-app.mjs", "--alias", alias, "--package", PKG, "--ssh", ssh];
  if (forceStop) launchArgs.push("--force-stop");
  let r = await runOps(launchArgs, 45000);
  if (r.code !== 0) fail("launch", { DETAIL: r.out.slice(0, 160) });
  await sleep(5500); // 抖音 settle 比 XHS 慢（探索笔记：等 5-6s 再 dump）

  // 首页 → 顶栏搜索入口
  let d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_home");
  let xml = readFileSync(d.DUMP, "utf8");
  const entry = findSearchEntry(xml);
  console.log(`SEARCH_ENTRY=${entry.matched}@${entry.cx},${entry.cy}`);
  await tapXY(entry.cx, entry.cy);
  await sleep(2200);

  // 搜索建议页 → 输入框 → input-text --enter 触发搜索
  d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_search_suggest");
  xml = readFileSync(d.DUMP, "utf8");
  const input = findSearchInput(xml);
  console.log(`INPUT_XY=${input.cx},${input.cy}`);
  r = await runOps(
    [
      "ops/input-text.mjs", "--alias", alias, "--text", keyword,
      "--x", String(input.cx), "--y", String(input.cy), "--enter", "--ssh", ssh,
    ],
    60000,
  );
  if (r.code !== 0) fail("input_keyword", { DETAIL: r.out.slice(0, 200) });
  await sleep(3800);

  // 结果页：focus 验 SearchResultActivity → 提取 Tabs + 卡片数
  const f = await focusNow();
  console.log(`FOCUS=${f.FOCUS || ""}`);
  if (!isSearchFocus(f.FOCUS)) fail("not_search_result", { FOCUS: f.FOCUS || "" });
  d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_results");
  xml = readFileSync(d.DUMP, "utf8");
  const tabs = extractTabs(xml);
  const count = countCards(xml);
  const tabNames = tabs.map((t) => t.text).join(",");
  console.log(`TABS=${tabNames}`);
  console.log(`TAB_COUNT=${tabs.length}`);
  console.log(`COUNT=${count}`);
  console.log(`DUMP=${d.DUMP}`);

  // back 回 Splash 壳（结果页无底栏，back ≥1-2）
  let backHome = false;
  for (let i = 0; i < 3; i++) {
    await back();
    await sleep(1200);
    const fb = await focusNow();
    if (isSplashFocus(fb.FOCUS)) { backHome = true; break; }
  }
  console.log(`BACK_HOME=${backHome ? "yes" : "no"}`);

  console.log(`DOUYIN_SEARCH=ok`);
  console.log(`ALIAS=${alias}`);
  bizRecord({
    op: "douyin-search",
    outcome: "ok",
    reason: backHome ? null : "back-warn",
    extra: { tabs: tabNames, count, backHome },
    alias,
    serial: null,
    startMs: t0,
  });
  process.exit(0);
}

main().catch((e) => {
  console.log(`DOUYIN_SEARCH=fail`);
  console.log(`REASON=exception`);
  console.log(`DETAIL=${String(e.message || e).slice(0, 300)}`);
  console.log(`ALIAS=${alias}`);
  bizRecord({
    op: "douyin-search",
    outcome: "fail",
    reason: "exception",
    extra: { detail: String(e.message || e).slice(0, 300) },
    alias,
    serial: null,
    startMs: t0,
  });
  process.exit(4);
});