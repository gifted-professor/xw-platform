#!/usr/bin/env node
/**
 * Free explore runner: paced ≤1 business op / minute.
 * Playbooks: basic (like/collect/comment) | rich (+search/follow/engage/draft/browse)
 *
 *   node ops/xhs-free-explore-paced.mjs --alias 01 --minutes 20
 *   node ops/xhs-free-explore-paced.mjs --alias 04 --minutes 120 --playbook rich
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./_explore-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PKG = "com.xingin.xhs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/xhs-free-explore-paced.mjs --alias <01-04> [--minutes 20] [--interval-sec 60] [--playbook basic|rich]`);
  process.exit(0);
}

const alias = opt("--alias");
const minutes = Math.max(1, Number(opt("--minutes", "20")) || 20);
const intervalSec = Math.max(60, Number(opt("--interval-sec", "60")) || 60);
const playbook = (opt("--playbook", minutes >= 60 ? "rich" : "basic") || "basic").toLowerCase();
if (!alias) {
  console.log("✗ need --alias");
  process.exit(4);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const startedAt = Date.now();
const deadline = startedAt + minutes * 60 * 1000;
const logDir = join(ROOT, "runtime", "free-explore");
mkdirSync(logDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logPath = join(logDir, `paced-${alias}-${stamp}.jsonl`);

const KEYWORDS = [
  "穿搭",
  "美食",
  "旅行",
  "护肤",
  "猫咪",
  "健身",
  "家居",
  "摄影",
  "咖啡",
  "夏天",
  "深圳",
  "探店",
];

function log(row) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...row });
  appendFileSync(logPath, line + "\n");
  console.log(line);
}

function runNode(args, timeoutMs) {
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

function summarize(out) {
  const keys = [
    "LIKE",
    "COLLECT",
    "COMMENT",
    "FOLLOW",
    "SEARCH",
    "ENGAGE",
    "PUBLISH",
    "PUBLISH_DRAFT",
    "PUBLISHED",
    "DRAFT",
    "BROWSE",
    "SHOT",
    "FOCUS",
    "REASON",
    "CARD_KIND",
    "CARD_TITLE",
    "COPIED_TEXT",
    "COPIED_LIKES",
    "VERIFY",
    "COUNT",
    "PAGES_DONE",
  ];
  const o = {};
  for (const line of String(out || "").split(/\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && keys.includes(m[1])) o[m[1]] = m[2].slice(0, 160);
  }
  return o;
}

function buildPlan() {
  const basic = ["like", "collect", "like", "comment", "collect", "like", "follow", "like", "collect", "comment"];
  const rich = [
    "like",
    "collect",
    "search",
    "like",
    "comment",
    "follow",
    "engage",
    "collect",
    "search_engage",
    "like",
    "browse",
    "comment",
    "follow",
    "like",
    "collect",
    "draft",
    "search",
    "engage",
    "like",
    "comment",
  ];
  const cycle = playbook === "rich" ? rich : basic;
  const plan = [];
  const slots = Math.ceil(minutes) + 4;
  while (plan.length < slots) plan.push(...cycle);
  return plan;
}

async function feedNudge() {
  await runNode(["ops/swipe.mjs", "--alias", alias, "--up"], 20000);
  await sleep(700);
}

async function recoverHome(force = false) {
  for (let i = 0; i < 4; i++) {
    await runNode(["ops/back.mjs", "--alias", alias], 15000);
    await sleep(800);
  }
  const launch = ["ops/launch-app.mjs", "--alias", alias, "--package", PKG];
  if (force) launch.push("--force-stop");
  await runNode(launch, 45000);
  await sleep(2200);
  const f = await runNode(["ops/focus.mjs", "--alias", alias], 20000);
  return f.out || "";
}

function pickKeyword(i) {
  return KEYWORDS[i % KEYWORDS.length];
}

function isOkish(kind, kv, code) {
  if (kv.LIKE === "ok" || kv.LIKE === "skip") return true;
  if (kv.COLLECT === "ok" || kv.COLLECT === "skip") return true;
  if (kv.FOLLOW === "ok" || kv.FOLLOW === "skip") return true;
  if (kv.COMMENT === "ok" || kv.COMMENT === "ambiguous" || kv.COMMENT === "skip" || kv.COMMENT === "dry-run") return true;
  if (kv.SEARCH === "ok") return true;
  if (kv.ENGAGE === "ok" || kv.ENGAGE === "partial") return true;
  if (kv.DRAFT === "ok" || kv.PUBLISH === "ok" || kv.PUBLISH_DRAFT === "ok" || kv.PUBLISHED === "no") return true;
  if (kind === "browse" && (kv.SHOT || kv.FOCUS || code === 0)) return true;
  if (code === 0) return true;
  return false;
}

function buildArgs(kind, index) {
  const kw = pickKeyword(index);
  const base = ["--alias", alias, "--no-force-stop"];
  switch (kind) {
    case "like":
      return { args: ["ops/xhs-like-one.mjs", ...base], timeoutMs: 180000, meta: {} };
    case "collect":
      return { args: ["ops/xhs-collect-one.mjs", ...base], timeoutMs: 180000, meta: {} };
    case "follow":
      return { args: ["ops/xhs-follow-one.mjs", ...base], timeoutMs: 180000, meta: {} };
    case "comment":
      return {
        args: ["ops/xhs-comment-copy-top.mjs", ...base, "--prefer", "any", "--screens", "3"],
        timeoutMs: 260000,
        meta: {},
      };
    case "search":
      return {
        args: ["ops/xhs-search.mjs", ...base, "--keyword", kw, "--pages", "2"],
        timeoutMs: 240000,
        meta: { keyword: kw },
      };
    case "engage":
      return {
        args: ["ops/xhs-engage-one.mjs", ...base, "--like", "--collect"],
        timeoutMs: 240000,
        meta: {},
      };
    case "search_engage":
      return {
        args: ["ops/xhs-engage-one.mjs", ...base, "--keyword", kw, "--like", "--collect"],
        timeoutMs: 300000,
        meta: { keyword: kw },
      };
    case "draft":
      return {
        args: [
          "ops/xhs-publish-draft.mjs",
          "--alias",
          alias,
          "--no-force-stop",
          "--caption",
          `探索草稿 ${new Date().toISOString().slice(0, 16)} 不发布`,
        ],
        timeoutMs: 300000,
        meta: { publish: false },
      };
    case "browse":
      return { args: null, timeoutMs: 120000, meta: { browse: true } };
    default:
      return { args: ["ops/xhs-like-one.mjs", ...base], timeoutMs: 180000, meta: {} };
  }
}

async function runBrowse() {
  const parts = [];
  let out = "";
  let code = 0;
  const f = await runNode(["ops/focus.mjs", "--alias", alias], 20000);
  out += f.out + "\n";
  if (f.code !== 0) code = f.code;
  const s = await runNode(["ops/screenshot-and-analyze.mjs", "--alias", alias], 90000);
  out += s.out + "\n";
  if (s.code !== 0) code = s.code;
  await feedNudge();
  await feedNudge();
  const d = await runNode(["ops/dump-ui.mjs", "--alias", alias], 50000);
  out += d.out + "\n";
  if (d.code !== 0) code = d.code;
  // normalize
  if (/SHOT=/.test(out)) parts.push("SHOT=yes");
  if (/FOCUS=/.test(out)) {
    const m = out.match(/FOCUS=([^\n]+)/);
    if (m) parts.push(`FOCUS=${m[1]}`);
  }
  if (code === 0) parts.push("BROWSE=ok");
  else parts.push("BROWSE=fail");
  return { code, out: parts.join("\n") + "\n" + out, ms: 0 };
}

async function main() {
  const plan = buildPlan();
  console.log(`START alias=${alias} minutes=${minutes} intervalSec=${intervalSec} playbook=${playbook}`);
  console.log(`LOG=${logPath}`);
  writeFileSync(
    join(logDir, "latest.txt"),
    `alias=${alias}\nlog=${logPath}\nstarted=${new Date(startedAt).toISOString()}\nplaybook=${playbook}\nminutes=${minutes}\n`,
  );

  await recoverHome(false);

  let i = 0;
  let lastOpAt = 0;
  let streakFail = 0;
  const results = {
    like: 0,
    collect: 0,
    comment: 0,
    follow: 0,
    search: 0,
    engage: 0,
    draft: 0,
    browse: 0,
    fail: 0,
    ok: 0,
    skip: 0,
  };

  while (Date.now() < deadline && i < plan.length) {
    const remainMs = deadline - Date.now();
    if (remainMs < 20000) break;

    const since = Date.now() - lastOpAt;
    if (lastOpAt && since < intervalSec * 1000) {
      const wait = intervalSec * 1000 - since;
      console.log(`WAIT_MS=${wait} (pace)`);
      await sleep(wait);
    }
    if (Date.now() >= deadline) break;

    const kind = plan[i++];
    if (i > 1 && kind !== "browse") await feedNudge();

    const built = buildArgs(kind, i);
    console.log(
      `OP=${kind} #${i} remainMin=${(Math.max(0, deadline - Date.now()) / 60000).toFixed(1)}${built.meta.keyword ? ` kw=${built.meta.keyword}` : ""}`,
    );

    let r;
    if (kind === "browse") r = await runBrowse();
    else r = await runNode(built.args, built.timeoutMs);
    lastOpAt = Date.now();
    const kv = summarize(r.out);
    const outcome = isOkish(kind, kv, r.code) ? (kv.COMMENT === "skip" || kv.LIKE === "skip" || kv.FOLLOW === "skip" || kv.COLLECT === "skip" ? "skip" : "okish") : "fail";

    if (outcome === "okish") results.ok += 1;
    else if (outcome === "skip") {
      results.skip += 1;
      results.ok += 1;
    } else results.fail += 1;

    if (results[kind] != null) results[kind] += 1;
    else if (kind === "search_engage") {
      results.search += 1;
      results.engage += 1;
    }

    if (outcome === "fail") streakFail += 1;
    else streakFail = 0;

    log({
      op: kind,
      index: i,
      code: r.code,
      ms: r.ms,
      outcome,
      playbook,
      ...built.meta,
      ...kv,
      tail: String(r.out || "").split(/\n/).slice(-10).join(" | ").slice(0, 500),
    });

    // search/draft 常停在非首页，下一拍赞/藏会 no_feed_card — 强制回首页
    if (kind === "search" || kind === "search_engage" || kind === "draft") {
      console.log(`RECOVER=after_${kind}`);
      await recoverHome(false);
      log({ op: "recover", reason: `after_${kind}`, streakFail });
    }

    // recover when stuck off-feed or consecutive fails
    if (
      outcome === "fail" &&
      /no_card|no_feed_card|not_detail|like_btn_missing|collect_btn_missing|comment_entry_missing|launch/i.test(
        `${kv.REASON || ""} ${r.out || ""}`,
      )
    ) {
      console.log(`RECOVER=home streakFail=${streakFail}`);
      await recoverHome(streakFail >= 2);
      log({ op: "recover", reason: kv.REASON || "stuck", streakFail });
    }

    if (streakFail >= 8) {
      log({ op: "abort", reason: "streak_fail_8", results });
      break;
    }
  }

  const summary = {
    alias,
    minutes,
    intervalSec,
    playbook,
    elapsedSec: Math.round((Date.now() - startedAt) / 1000),
    opsAttempted: i,
    results,
    logPath,
  };
  console.log(`DONE ${JSON.stringify(summary)}`);
  writeFileSync(join(logDir, "latest-summary.json"), JSON.stringify(summary, null, 2));
  process.exit(results.fail > results.ok ? 1 : 0);
}

main().catch((e) => {
  console.log(`FATAL=${e?.message || e}`);
  process.exit(2);
});
