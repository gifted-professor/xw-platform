#!/usr/bin/env node
/**
 * Quiet health probe for douyin free-explore paced run.
 * stdout: HEALTH=ok|warn|bad ... (machine-readable)
 *
 *   node ops/douyin-explore-watch.mjs --alias 01
 */
import { existsSync, readFileSync, readdirSync, statSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseArgs } from "./_explore-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const { opt } = parseArgs(process.argv.slice(2));
const alias = opt("--alias", "01");
const logDir = join(ROOT, "runtime", "free-explore");
const watchDir = join(ROOT, "runtime", "explore-watch");
mkdirSync(watchDir, { recursive: true });
const watchLog = join(watchDir, `watch-${alias}.jsonl`);

function latestJsonl() {
  if (!existsSync(logDir)) return null;
  const files = readdirSync(logDir)
    .filter((f) => f.startsWith(`douyin-paced-${alias}-`) && f.endsWith(".jsonl"))
    .map((f) => ({ f, t: statSync(join(logDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files[0] ? join(logDir, files[0].f) : null;
}

function tailRows(path, n = 12) {
  if (!path || !existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").trim().split(/\n/).filter(Boolean);
  return lines.slice(-n).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function curl(url) {
  const r = spawnSync("curl.exe", ["-s", "--max-time", "8", url], { encoding: "utf8" });
  return r.status === 0 ? r.stdout : "";
}

function runnerAlive() {
  // PowerShell-less: look at latest.txt + jsonl mtime freshness
  const latestTxt = join(logDir, "douyin-latest.txt");
  const jsonl = latestJsonl();
  let mtimeAgeSec = null;
  if (jsonl && existsSync(jsonl)) {
    mtimeAgeSec = Math.round((Date.now() - statSync(jsonl).mtimeMs) / 1000);
  }
  let started = null;
  if (existsSync(latestTxt)) {
    const t = readFileSync(latestTxt, "utf8");
    const m = t.match(/started=(.+)/);
    if (m) started = m[1].trim();
  }
  return { jsonl, mtimeAgeSec, started, latestTxt: existsSync(latestTxt) };
}

const issues = [];
const notes = [];
let level = "ok";

const entry = curl("http://127.0.0.1:17930/agent-entry.md");
const line01 = entry.split(/\n/).find((l) => l.includes("| 01 |") || /^\s*- 01 \|/.test(l)) || "";
const ready = /ready=yes/.test(line01);
const online = /online=yes/.test(line01);
const quarantined = /quarantined=yes/.test(line01);
if (!entry) {
  issues.push("agent_entry_unreachable");
  level = "bad";
} else {
  if (!online) {
    issues.push("01_offline");
    level = "bad";
  }
  if (!ready) {
    issues.push("01_not_ready");
    level = "bad";
  }
  if (quarantined) {
    issues.push("01_quarantined");
    level = "bad";
  }
}

const run = runnerAlive();
const rows = tailRows(run.jsonl, 15);
const recent = rows.filter((r) => r.op && r.op !== "abort");
const fails = recent.filter((r) => r.outcome === "fail");
const abort = rows.find((r) => r.op === "abort");
const risk = rows.some((r) => /验证码|风控|captcha|login/i.test(JSON.stringify(r)));

if (!run.jsonl) {
  issues.push("no_paced_log");
  level = "bad";
} else if (run.mtimeAgeSec != null && run.mtimeAgeSec > 200) {
  // paced interval 60s + op up to ~3min → stale >200s is suspicious; >360 bad
  if (run.mtimeAgeSec > 360) {
    issues.push(`runner_stale_${run.mtimeAgeSec}s`);
    level = "bad";
  } else {
    issues.push(`runner_slow_${run.mtimeAgeSec}s`);
    if (level === "ok") level = "warn";
  }
}

if (abort) {
  issues.push(`abort:${abort.reason || "?"}`);
  level = "bad";
}
if (risk) {
  issues.push("risk_or_captcha_in_log");
  level = "bad";
}

const failRate = recent.length ? fails.length / recent.length : 0;
if (recent.length >= 5 && failRate >= 0.6) {
  issues.push(`high_fail_rate_${fails.length}/${recent.length}`);
  if (level === "ok") level = "warn";
  if (failRate >= 0.8) level = "bad";
}

const last = recent[recent.length - 1];
notes.push(`last_op=${last?.op || "-"}`);
notes.push(`last_outcome=${last?.outcome || "-"}`);
notes.push(`ops_tail=${recent.length}`);
notes.push(`fail_tail=${fails.length}`);
notes.push(`mtimeAgeSec=${run.mtimeAgeSec ?? "-"}`);

const focus = curl("http://127.0.0.1:17930/api/health");
if (!focus) {
  issues.push("registry_health_fail");
  level = "bad";
}

const report = {
  ts: new Date().toISOString(),
  alias,
  level,
  issues,
  notes,
  lastOp: last?.op || null,
  lastOutcome: last?.outcome || null,
  lastReason: last?.REASON || last?.reason || null,
  jsonl: run.jsonl,
};
appendFileSync(watchLog, JSON.stringify(report) + "\n");

console.log(`HEALTH=${level}`);
console.log(`ISSUES=${issues.join(",") || "none"}`);
console.log(`NOTES=${notes.join(";")}`);
console.log(`LAST_OP=${last?.op || "-"}`);
console.log(`LAST_OUTCOME=${last?.outcome || "-"}`);
console.log(`LAST_REASON=${last?.REASON || last?.reason || "-"}`);
console.log(`JSONL=${run.jsonl || ""}`);
console.log(`WATCHLOG=${watchLog}`);
process.exit(level === "bad" ? 2 : level === "warn" ? 1 : 0);
