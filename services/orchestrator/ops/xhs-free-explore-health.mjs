#!/usr/bin/env node
/**
 * Health check for free-explore paced run (alias 04 etc).
 * stdout: HEALTH=OK|PROBLEM + JSON summary. Exit 0 even on PROBLEM (caller decides).
 *
 *   node ops/xhs-free-explore-health.mjs
 *   node ops/xhs-free-explore-health.mjs --alias 04 --stale-sec 240 --fail-streak 3
 */
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./_explore-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log("用法: node ops/xhs-free-explore-health.mjs [--alias 04] [--stale-sec 240] [--fail-streak 3]");
  process.exit(0);
}

const alias = opt("--alias", "04");
const staleSec = Math.max(90, Number(opt("--stale-sec", "240")) || 240);
const failStreakMax = Math.max(2, Number(opt("--fail-streak", "3")) || 3);
const logDir = join(ROOT, "runtime", "free-explore");
mkdirSync(logDir, { recursive: true });

function readLatestLogPath() {
  const latest = join(logDir, "latest.txt");
  if (!existsSync(latest)) return null;
  const m = readFileSync(latest, "utf8").match(/^log=(.+)$/m);
  return m ? m[1].trim() : null;
}

function loadRows(logPath) {
  if (!logPath || !existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split(/\n/)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function curl(url) {
  try {
    const r = spawnSync("curl.exe", ["-s", "-m", "12", url], { encoding: "utf8" });
    return r.stdout || "";
  } catch {
    return "";
  }
}

function focusAlias() {
  try {
    const r = spawnSync("node", ["ops/focus.mjs", "--alias", alias], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, XHS_LOCAL: "1" },
      timeout: 25000,
    });
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    const m = out.match(/FOCUS=([^\r\n]+)/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

function exploreRunning() {
  try {
    const r = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'xhs-free-explore-paced' } | Select-Object -ExpandProperty ProcessId",
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    const ids = String(r.stdout || "")
      .split(/\s+/)
      .map((x) => x.trim())
      .filter(Boolean);
    return ids;
  } catch {
    return [];
  }
}

const logPath = readLatestLogPath();
const rows = loadRows(logPath);
const ops = rows.filter((r) => r.op && !["recover", "abort"].includes(r.op));
const last = ops[ops.length - 1] || null;
let failStreak = 0;
for (let i = ops.length - 1; i >= 0; i--) {
  if (ops[i].outcome === "fail") failStreak++;
  else break;
}
const ok = ops.filter((r) => r.outcome === "okish" || r.outcome === "skip").length;
const fail = ops.filter((r) => r.outcome === "fail").length;
const lastAgeSec = last?.ts ? Math.round((Date.now() - Date.parse(last.ts)) / 1000) : 99999;

const entry = curl("http://127.0.0.1:17930/agent-entry.md");
const line = (entry.split(/\n/).find((l) => l.includes(`- ${alias} |`)) || "").trim();
const ready = /ready=yes/.test(line);
const online = /online=yes/.test(line);
const leaseFree = /lease=free/.test(line);
const quarantined = /quarantined=yes/.test(line);

const pids = exploreRunning();
const focus = focusAlias();
const problems = [];

if (!pids.length) {
  // only problem if expected still running (minutes not elapsed). Check latest-summary age vs started.
  const latestTxt = existsSync(join(logDir, "latest.txt")) ? readFileSync(join(logDir, "latest.txt"), "utf8") : "";
  const startedM = latestTxt.match(/^started=(.+)$/m);
  const minutesM = latestTxt.match(/^minutes=(\d+)/m);
  const started = startedM ? Date.parse(startedM[1]) : NaN;
  const minutes = minutesM ? Number(minutesM[1]) : 0;
  const stillExpected = Number.isFinite(started) && Date.now() < started + minutes * 60 * 1000 - 30000;
  if (stillExpected) problems.push("explore_process_dead");
}
if (!online) problems.push("device_offline");
if (!ready) problems.push("device_not_ready");
if (quarantined) problems.push("device_quarantined");
if (!leaseFree && /lease=/.test(line)) problems.push("lease_busy");
if (failStreak >= failStreakMax) problems.push(`fail_streak_${failStreak}`);
if (pids.length && lastAgeSec > staleSec) problems.push(`stale_op_${lastAgeSec}s`);
if (/验证码|风控|登录|captcha|risk/i.test(focus)) problems.push("focus_risk_or_login");
if (/GlobalSearchActivity/i.test(focus) && last?.op === "like" && last?.outcome === "fail") {
  // soft: already recovered usually
}

const status = problems.length ? "PROBLEM" : "OK";
const summary = {
  status,
  alias,
  pids,
  ready,
  online,
  leaseFree,
  quarantined,
  ops: ops.length,
  ok,
  fail,
  failStreak,
  lastOp: last ? `${last.op}/${last.outcome}/${last.REASON || ""}` : "none",
  lastAgeSec,
  focus,
  problems,
  logPath,
  ts: new Date().toISOString(),
};

writeFileSync(join(logDir, "health-latest.json"), JSON.stringify(summary, null, 2));
appendFileSync(join(logDir, "health.jsonl"), JSON.stringify(summary) + "\n");
console.log(`HEALTH=${status}`);
console.log(JSON.stringify(summary));
process.exit(0);
