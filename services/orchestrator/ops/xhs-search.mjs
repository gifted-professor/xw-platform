#!/usr/bin/env node
/**
 * XHS search → dump result cards (no enter note by default)
 *
 *   node ops/xhs-search.mjs --alias 02 --keyword 穿搭
 *   node ops/xhs-search.mjs --alias 02 --keyword 穿搭 --open-first  # optional enter first card
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./_explore-lib.mjs";
import { bizRecord } from "./_biz-trace.mjs";
import { parseSearchResults, isHomeFocus } from "./_xhs-parse.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PKG = "com.xingin.xhs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/xhs-search.mjs --alias <01-04> --session-file <context.json> --keyword <词> [--open-first] [--pages N] [--no-force-stop]
stdout: SEARCH=ok COUNT=N PAGES_DONE=N ...`);
  process.exit(0);
}

const alias = opt("--alias");
const keyword = opt("--keyword") || opt("--text");
const ssh = opt("--ssh", "xhs-windows");
const sessionFile = opt("--session-file");
if (!sessionFile) { console.log("✗ need --session-file"); process.exit(4); }
const openFirst = flag("--open-first");
const pages = Math.max(1, Number(opt("--pages", "1")) || 1);
const forceStop = !flag("--no-force-stop");
if (!alias || !keyword) {
  console.log("✗ need --alias --keyword");
  process.exit(4);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let t0 = Date.now(); // 业务动作起点（module-scope，fail/catch 也能引用）

function runOps(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const childArgs = args.includes("--session-file") ? args : [...args, "--session-file", sessionFile];
    const p = spawn("node", childArgs, { cwd: ROOT });
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

function kv(text) {
  const o = {};
  for (const line of String(text || "").split(/\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) o[m[1]] = m[2];
  }
  return o;
}

function fail(reason, extra = {}) {
  console.log(`SEARCH=fail`);
  console.log(`REASON=${reason}`);
  for (const [k, v] of Object.entries(extra)) if (v != null) console.log(`${k}=${v}`);
  console.log(`ALIAS=${alias}`);
  // biz trace：终态同步落盘（SSH 路径同步 execFileSync），落完再 exit
  bizRecord({ op: "search", outcome: "fail", reason, extra, alias, serial: null, startMs: t0 });
  process.exit(2);
}

function findSearchBtn(xml) {
  const m =
    xml.match(/content-desc="(搜索[^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) ||
    xml.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*content-desc="(搜索[^"]*)"/);
  if (!m) return { x: 1005, y: 156, desc: "fallback" };
  if (String(m[1]).startsWith("搜索")) {
    return {
      desc: m[1],
      x: Math.round((+m[2] + +m[4]) / 2),
      y: Math.round((+m[3] + +m[5]) / 2),
    };
  }
  return {
    desc: m[5],
    x: Math.round((+m[1] + +m[3]) / 2),
    y: Math.round((+m[2] + +m[4]) / 2),
  };
}

function findSearchInput(xml) {
  let ix = 520;
  let iy = 160;
  const em =
    xml.match(/class="[^"]*EditText"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) ||
    xml.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*class="[^"]*EditText"/);
  if (em) {
    ix = Math.round((+em[1] + +em[3]) / 2);
    iy = Math.round((+em[2] + +em[4]) / 2);
  }
  const tm = xml.match(/text="[^"]*搜索[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (tm) {
    ix = Math.round((+tm[1] + +tm[3]) / 2);
    iy = Math.round((+tm[2] + +tm[4]) / 2);
  }
  return { x: ix, y: iy };
}

async function main() {
  t0 = Date.now();
  const launchArgs = ["ops/launch-app.mjs", "--alias", alias, "--package", PKG, "--ssh", ssh];
  if (forceStop) launchArgs.push("--force-stop");
  let r = await runOps(launchArgs, 45000);
  if (r.code !== 0) fail("launch", { DETAIL: r.out.slice(0, 160) });
  await sleep(2500);

  r = await runOps(["ops/dump-ui.mjs", "--alias", alias, "--ssh", ssh], 50000);
  let k = kv(r.out);
  if (!k.DUMP || !existsSync(k.DUMP)) fail("dump_home");
  let xml = readFileSync(k.DUMP, "utf8");
  const sbtn = findSearchBtn(xml);
  console.log(`SEARCH_BTN=${sbtn.x},${sbtn.y}`);
  r = await runOps(["ops/tap.mjs", "--alias", alias, "--x", String(sbtn.x), "--y", String(sbtn.y), "--ssh", ssh], 20000);
  if (r.code !== 0) fail("tap_search");
  await sleep(1800);

  r = await runOps(["ops/dump-ui.mjs", "--alias", alias, "--ssh", ssh], 50000);
  k = kv(r.out);
  if (!k.DUMP || !existsSync(k.DUMP)) fail("dump_search_page");
  xml = readFileSync(k.DUMP, "utf8");
  const inp = findSearchInput(xml);
  console.log(`INPUT_XY=${inp.x},${inp.y}`);

  r = await runOps(
    [
      "ops/input-text.mjs",
      "--alias",
      alias,
      "--text",
      keyword,
      "--x",
      String(inp.x),
      "--y",
      String(inp.y),
      "--enter",
      "--ssh",
      ssh,
    ],
    60000,
  );
  if (r.code !== 0) fail("input_keyword", { DETAIL: r.out.slice(0, 200) });
  console.log(`KEYWORD=${keyword}`);
  await sleep(3200);

  r = await runOps(["ops/focus.mjs", "--alias", alias, "--ssh", ssh], 30000);
  k = kv(r.out);
  console.log(`FOCUS=${k.FOCUS || ""}`);

  r = await runOps(["ops/dump-ui.mjs", "--alias", alias, "--ssh", ssh], 50000);
  k = kv(r.out);
  if (!k.DUMP || !existsSync(k.DUMP)) fail("dump_results");
  xml = readFileSync(k.DUMP, "utf8");
  const parsed = parseSearchResults(xml);
  let allCards = parsed.cards.slice();
  let pagesDone = 1;
  const focusFirst = k.FOCUS;
  console.log(`PAGE1_COUNT=${parsed.cards.length}`);

  // 翻页：swipe up 后仍 GlobalSearchActivity 且有新卡才继续；focus 漂走/无新卡即停。
  for (let p = 2; p <= pages; p += 1) {
    await runOps(["ops/swipe.mjs", "--alias", alias, "--up", "--ssh", ssh], 20000);
    await sleep(1200);
    const fr = await runOps(["ops/focus.mjs", "--alias", alias, "--ssh", ssh], 30000);
    const fk = kv(fr.out);
    if (!/GlobalSearchActivity/i.test(fk.FOCUS || "")) {
      console.log(`PAGE_STOP=focus-drift@${p} ${fk.FOCUS || ""}`);
      break;
    }
    const dr = await runOps(["ops/dump-ui.mjs", "--alias", alias, "--ssh", ssh], 50000);
    const dk = kv(dr.out);
    if (!dk.DUMP || !existsSync(dk.DUMP)) break;
    const pp = parseSearchResults(readFileSync(dk.DUMP, "utf8"));
    const seen = new Set(allCards.map((c) => `${c.title}|${c.author}`));
    const fresh = pp.cards.filter((c) => !seen.has(`${c.title}|${c.author}`));
    console.log(`PAGE${p}_COUNT=${pp.cards.length} fresh=${fresh.length}`);
    if (fresh.length === 0) break; // 没新卡，停
    allCards = allCards.concat(fresh);
    pagesDone = p;
  }

  const outJson = join(tmpdir(), "xhs-explore", `search-${alias}-${Date.now()}.json`);
  mkdirSync(dirname(outJson), { recursive: true });
  writeFileSync(outJson, JSON.stringify({ keyword, focus: focusFirst, tabs: parsed.tabs, cards: allCards, pages: pagesDone }, null, 2));

  console.log(`PAGES_DONE=${pagesDone}`);
  console.log(`COUNT=${allCards.length}`);
  console.log(`TABS=${parsed.tabs.map((t) => t.text).join(",")}`);
  console.log(`JSON=${outJson}`);
  console.log(`DUMP=${k.DUMP}`);
  allCards.slice(0, 5).forEach((c, i) => {
    console.log(`CARD${i + 1}=${JSON.stringify({ title: c.title.slice(0, 40), author: c.author, likes: c.likes, xy: [c.cx, c.cy] })}`);
  });

  if (openFirst && allCards[0]) {
    const c = allCards[0];
    await runOps(["ops/tap.mjs", "--alias", alias, "--x", String(c.cx), "--y", String(c.cy), "--ssh", ssh], 20000);
    await sleep(2500);
    r = await runOps(["ops/focus.mjs", "--alias", alias, "--ssh", ssh], 30000);
    console.log(`OPEN_FOCUS=${kv(r.out).FOCUS || ""}`);
  }

  if (allCards.length < 1) fail("no_cards");
  console.log(`SEARCH=ok`);
  console.log(`ALIAS=${alias}`);
  bizRecord({ op: "search", outcome: "ok", alias, serial: null, startMs: t0 });
  process.exit(0);
}

main().catch((e) => {
  console.log(`SEARCH=fail`);
  console.log(`REASON=exception`);
  console.log(`DETAIL=${String(e.message || e).slice(0, 300)}`);
  console.log(`ALIAS=${alias}`);
  bizRecord({ op: "search", outcome: "fail", reason: "exception", extra: { detail: String(e.message || e).slice(0, 300) }, alias, serial: null, startMs: t0 });
  process.exit(4);
});
