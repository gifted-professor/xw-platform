#!/usr/bin/env node
/**
 * Douyin free explore — long continuous paced run with mixed plays.
 * ≤1 business op / minute; between ops may browse-swipe.
 *
 *   node ops/douyin-free-explore-paced.mjs --alias 01 --minutes 180
 *
 * Mix includes like/collect/follow/comment + save_album/clear_screen/
 * visual_search/watch_later/share_probe/longpress_probe/browse/speed.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./_explore-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PKG = "com.ss.android.ugc.aweme";

const WEIGHTS = [
  ["like", 14],
  ["collect", 12],
  ["follow", 8],
  ["comment", 8],
  ["save_album", 12],
  ["clear_screen", 8],
  ["visual_search", 8],
  ["watch_later", 8],
  ["share_probe", 6],
  ["longpress_probe", 5],
  ["browse", 7],
  ["speed", 4],
];

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/douyin-free-explore-paced.mjs --alias <01-04> [--minutes 180] [--interval-sec 60]
玩法权重: ${WEIGHTS.map(([k, w]) => k + ":" + w).join(" ")}`);
  process.exit(0);
}

const alias = opt("--alias");
const minutes = Math.max(1, Number(opt("--minutes", "180")) || 180);
const intervalSec = Math.max(60, Number(opt("--interval-sec", "60")) || 60);
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
const logPath = join(logDir, `douyin-paced-${alias}-${stamp}.jsonl`);

function log(row) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...row });
  appendFileSync(logPath, line + "\n");
  console.log(line);
}

function pickKind(recent) {
  // avoid 3 identical in a row
  const total = WEIGHTS.reduce((s, [, w]) => s + w, 0);
  for (let attempt = 0; attempt < 8; attempt++) {
    let r = Math.random() * total;
    let kind = WEIGHTS[0][0];
    for (const [k, w] of WEIGHTS) {
      r -= w;
      if (r <= 0) {
        kind = k;
        break;
      }
    }
    if (recent.length >= 2 && recent[recent.length - 1] === kind && recent[recent.length - 2] === kind) continue;
    return kind;
  }
  return "browse";
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
    "PLAY",
    "OUTCOME",
    "REASON",
    "DOUYIN_LIKE",
    "DOUYIN_COLLECT",
    "DOUYIN_FOLLOW",
    "COMMENT",
    "COPIED_TEXT",
    "COPIED_LIKES",
    "LLM_VERDICT",
    "LLM_REASON",
    "DISCOVERED",
    "PATH",
    "ITEMS",
    "FOCUS",
  ];
  const o = {};
  for (const line of String(out || "").split(/\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && keys.includes(m[1])) o[m[1]] = m[2].slice(0, 200);
  }
  return o;
}

async function feedNudge() {
  const n = 1 + (Math.random() < 0.5 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    await runNode(["ops/swipe.mjs", "--alias", alias, "--up"], 20000);
    await sleep(700 + Math.floor(Math.random() * 900));
  }
}

async function main() {
  console.log(`START app=douyin alias=${alias} minutes=${minutes} intervalSec=${intervalSec} mode=mixed-play`);
  console.log(`LOG=${logPath}`);
  writeFileSync(
    join(logDir, "douyin-latest.txt"),
    `alias=${alias}\nlog=${logPath}\nstarted=${new Date(startedAt).toISOString()}\nminutes=${minutes}\nmode=mixed-play\n`,
  );

  await runNode(["ops/launch-app.mjs", "--alias", alias, "--package", PKG], 45000);
  await sleep(5500);

  let i = 0;
  let lastOpAt = 0;
  const recent = [];
  const byKind = {};
  const results = { ok: 0, skip: 0, observe: 0, fail: 0 };
  let consecutiveFails = 0;
  const discoveries = new Set();

  while (Date.now() < deadline) {
    if (deadline - Date.now() < 25000) break;

    const since = Date.now() - lastOpAt;
    if (lastOpAt && since < intervalSec * 1000) {
      const wait = intervalSec * 1000 - since;
      console.log(`WAIT_MS=${wait} (pace)`);
      await sleep(wait);
    }
    if (Date.now() >= deadline) break;

    const kind = pickKind(recent);
    recent.push(kind);
    if (recent.length > 6) recent.shift();
    i += 1;
    byKind[kind] = (byKind[kind] || 0) + 1;

    if (i > 1) await feedNudge();

    const timeoutMs = kind === "comment" ? 320000 : kind === "share_probe" || kind === "save_album" ? 240000 : 200000;
    console.log(`OP=${kind} #${i} remainMin=${(Math.max(0, deadline - Date.now()) / 60000).toFixed(1)}`);
    const r = await runNode(["ops/douyin-play-once.mjs", "--alias", alias, "--kind", kind, "--no-force-stop"], timeoutMs);
    lastOpAt = Date.now();
    const kv = summarize(r.out);
    let outcome = kv.OUTCOME || "";
    if (!outcome) {
      if (kv.DOUYIN_LIKE === "ok" || kv.DOUYIN_COLLECT === "ok" || kv.DOUYIN_FOLLOW === "ok" || kv.COMMENT === "ok") outcome = "ok";
      else if (kv.DOUYIN_LIKE === "skip" || kv.DOUYIN_COLLECT === "skip" || kv.DOUYIN_FOLLOW === "skip") outcome = "skip";
      else if (r.code === 0) outcome = "ok";
      else outcome = "fail";
    }
    if (outcome === "ok") results.ok += 1;
    else if (outcome === "skip") results.skip += 1;
    else if (outcome === "observe") results.observe += 1;
    else results.fail += 1;

    if (outcome === "fail") consecutiveFails += 1;
    else consecutiveFails = 0;

    if (kv.DISCOVERED) {
      for (const part of kv.DISCOVERED.split("|")) if (part) discoveries.add(part);
    }
    if (kv.ITEMS) {
      for (const part of kv.ITEMS.split("|")) if (part) discoveries.add(part);
    }

    log({
      op: kind,
      index: i,
      code: r.code,
      ms: r.ms,
      outcome,
      ...kv,
      tail: String(r.out || "").split(/\n/).slice(-6).join(" | ").slice(0, 360),
    });

    if (/验证码|风控|captcha|login.?wall/i.test(r.out)) {
      log({ op: "abort", reason: "risk_or_captcha", results, byKind });
      break;
    }
    if (consecutiveFails >= 5) {
      log({ op: "abort", reason: "too_many_fails", results, byKind });
      // soft recover: force-stop relaunch once
      await runNode(["ops/launch-app.mjs", "--alias", alias, "--package", PKG, "--force-stop"], 45000);
      await sleep(6000);
      consecutiveFails = 0;
    }
  }

  const summary = {
    app: "douyin",
    mode: "mixed-play",
    alias,
    minutes,
    intervalSec,
    elapsedSec: Math.round((Date.now() - startedAt) / 1000),
    opsAttempted: i,
    results,
    byKind,
    discoveries: [...discoveries].slice(0, 80),
    logPath,
  };
  console.log(`DONE ${JSON.stringify(summary)}`);
  writeFileSync(join(logDir, "douyin-latest-summary.json"), JSON.stringify(summary, null, 2));
  process.exit(results.fail > results.ok + results.skip + results.observe ? 1 : 0);
}

main().catch((e) => {
  console.log(`FATAL=${e?.message || e}`);
  process.exit(2);
});
