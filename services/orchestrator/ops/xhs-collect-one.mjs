#!/usr/bin/env node
/**
 * XHS: open one feed note → collect → verify via dump → back home.
 *
 *   node ops/xhs-collect-one.mjs --alias 03
 *   node ops/xhs-collect-one.mjs --alias 03 --dry-run
 */
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./_explore-lib.mjs";
import { bizRecord } from "./_biz-trace.mjs";
import {
  parseFeedCards,
  pickFeedCard,
  parseBottomBar,
  isHomeFocus,
  isDetailFocus,
} from "./_xhs-parse.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PKG = "com.xingin.xhs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/xhs-collect-one.mjs --alias <01-04> [--dry-run] [--no-force-stop]
stdout: COLLECT=ok|skip|fail`);
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
  console.log(`COLLECT=fail`);
  console.log(`REASON=${reason}`);
  for (const [k, v] of Object.entries(extra)) if (v != null && v !== "") console.log(`${k}=${v}`);
  console.log(`ALIAS=${alias}`);
  // biz trace：终态同步落盘（SSH 路径同步 execFileSync），落完再 exit
  bizRecord({ op: "collect", outcome: "fail", reason, extra, alias, serial: null, startMs: t0 });
  process.exit(2);
}

function collectState(desc) {
  if (!desc) return "missing";
  if (/已收藏/.test(desc)) return "collected";
  if (/收藏/.test(desc)) return "uncollected";
  return "unknown";
}

async function focusNow() {
  const r = await runOps(["ops/focus.mjs", "--alias", alias, "--ssh", ssh], 30000);
  return { ...r, ...kv(r.out) };
}
async function dumpNow() {
  const r = await runOps(["ops/dump-ui.mjs", "--alias", alias, "--ssh", ssh], 50000);
  return { ...r, ...kv(r.out) };
}
async function backHome() {
  for (let i = 0; i < 3; i++) {
    await runOps(["ops/back.mjs", "--alias", alias, "--ssh", ssh], 15000);
    await sleep(1200);
    const f = await focusNow();
    if (isHomeFocus(f.FOCUS)) return true;
  }
  return false;
}

async function main() {
  t0 = Date.now();
  const launchArgs = ["ops/launch-app.mjs", "--alias", alias, "--package", PKG, "--ssh", ssh];
  if (forceStop) launchArgs.push("--force-stop");
  let r = await runOps(launchArgs, 45000);
  if (r.code !== 0) fail("launch");
  await sleep(2800);

  let d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_feed");
  let xml = readFileSync(d.DUMP, "utf8");
  let cards = parseFeedCards(xml);
  let card = pickFeedCard(cards, { prefer: "note", avoidWan: true });
  if (!card) {
    await runOps(["ops/swipe.mjs", "--alias", alias, "--up", "--ssh", ssh], 20000);
    await sleep(1000);
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) {
      cards = parseFeedCards(readFileSync(d.DUMP, "utf8"));
      card = pickFeedCard(cards, { prefer: "note", avoidWan: false });
    }
  }
  if (!card) fail("no_card");
  console.log(`CARD_TITLE=${card.title.slice(0, 80)}`);
  console.log(`CARD_AUTHOR=${card.author}`);
  console.log(`CARD_XY=${card.cx},${card.cy}`);

  r = await runOps(
    ["ops/tap.mjs", "--alias", alias, "--x", String(card.cx), "--y", String(card.cy), "--ssh", ssh],
    20000,
  );
  if (r.code !== 0) fail("tap_card");
  await sleep(2800);
  let f = await focusNow();
  if (!isDetailFocus(f.FOCUS)) fail("not_detail", { FOCUS: f.FOCUS || "" });
  console.log(`FOCUS_DETAIL=${f.FOCUS}`);

  d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_detail");
  xml = readFileSync(d.DUMP, "utf8");
  let bar = parseBottomBar(xml);
  if (!bar.collect) {
    await runOps(["ops/tap.mjs", "--alias", alias, "--x", "540", "--y", "900", "--ssh", ssh], 20000);
    await sleep(800);
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) {
      xml = readFileSync(d.DUMP, "utf8");
      bar = parseBottomBar(xml);
    }
  }
  if (!bar.collect) fail("collect_btn_missing");

  const before = collectState(bar.collect.desc);
  const beforeDesc = bar.collect.desc;
  console.log(`COLLECT_BEFORE=${beforeDesc}`);
  console.log(`COLLECT_XY=${bar.collect.x},${bar.collect.y}`);
  console.log(`LIKE=${bar.like?.desc || ""}`);
  console.log(`COMMENT=${bar.comment?.desc || ""}`);

  if (before === "collected") {
    console.log(`COLLECT=skip`);
    console.log(`REASON=already-collected`);
    await backHome();
    console.log(`ALIAS=${alias}`);
    bizRecord({ op: "collect", outcome: "skip", reason: "already-collected", alias, serial: null, startMs: t0 });
    process.exit(0);
  }

  if (dryRun) {
    console.log(`COLLECT=dry-run`);
    console.log(`REASON=located-not-tapped`);
    await backHome();
    console.log(`ALIAS=${alias}`);
    bizRecord({ op: "collect", outcome: "dry-run", reason: "located-not-tapped", alias, serial: null, startMs: t0 });
    process.exit(0);
  }

  r = await runOps(
    [
      "ops/tap.mjs",
      "--alias",
      alias,
      "--x",
      String(bar.collect.x),
      "--y",
      String(bar.collect.y),
      "--ssh",
      ssh,
    ],
    20000,
  );
  if (r.code !== 0) fail("tap_collect");
  await sleep(1800);

  // verify：collect 翻转有 label 滞后（底栏 a11y desc 晚于服务端计数），
  // dump 抓到未翻转的底栏就误报 fail（实测 21→已收藏22 但脚本报 fail 即此）。
  // 修法：计数比对（21→22 即成功）+ 未确认则再等一拍重 dump 一次。
  const countOf = (s) => { const m = String(s || "").match(/(\d+)/); return m ? Number(m[1]) : null; };
  const beforeCount = countOf(beforeDesc);
  const verdict = (desc) =>
    collectState(desc) === "collected" ||
    (desc && beforeDesc && desc !== beforeDesc) ||
    /已收藏/.test(desc) ||
    (beforeCount != null && countOf(desc) != null && countOf(desc) > beforeCount);

  d = await dumpNow();
  if (!d.DUMP || !existsSync(d.DUMP)) fail("dump_after");
  xml = readFileSync(d.DUMP, "utf8");
  bar = parseBottomBar(xml);
  let afterDesc = bar.collect?.desc || "";
  let ok = verdict(afterDesc);

  if (!ok) {
    // 底栏 label 滞后或 dump 抓到动画中——再等一拍重 dump
    await sleep(1200);
    d = await dumpNow();
    if (d.DUMP && existsSync(d.DUMP)) {
      xml = readFileSync(d.DUMP, "utf8");
      bar = parseBottomBar(xml);
      afterDesc = bar.collect?.desc || "";
      ok = verdict(afterDesc);
    }
  }
  console.log(`COLLECT_AFTER=${afterDesc}`);

  const home = await backHome();
  console.log(`BACK_HOME=${home ? "yes" : "no"}`);
  f = await focusNow();
  console.log(`FOCUS=${f.FOCUS || ""}`);

  if (!ok) fail("collect_not_confirmed", { COLLECT_BEFORE: beforeDesc, COLLECT_AFTER: afterDesc });
  console.log(`COLLECT=ok`);
  console.log(`ALIAS=${alias}`);
  bizRecord({ op: "collect", outcome: "ok", alias, serial: null, startMs: t0 });
  process.exit(0);
}

main().catch((e) => {
  console.log(`COLLECT=fail`);
  console.log(`REASON=exception`);
  console.log(`DETAIL=${String(e.message || e).slice(0, 300)}`);
  console.log(`ALIAS=${alias}`);
  bizRecord({ op: "collect", outcome: "fail", reason: "exception", extra: { detail: String(e.message || e).slice(0, 300) }, alias, serial: null, startMs: t0 });
  process.exit(4);
});
