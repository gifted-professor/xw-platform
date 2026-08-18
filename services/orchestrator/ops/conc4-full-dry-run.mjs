#!/usr/bin/env node
// 4 机 full_dry_run 并发一键入口（油门，不是刹车）
//
// Mac 客户端：读 fixture + 跑 devicectl；业务执行码在 Windows main（经 --ssh）。
// 不新增审批/硬闸；手拼 devicectl 仍可用。非 ready 才 fail-closed。
//
// 用法：
//   node ops/conc4-full-dry-run.mjs --actor hermes-conc4
//   node ops/conc4-full-dry-run.mjs --actor mimo-conc4 --dry-run
//
// 退出码：
//   0  四台 succeeded 且 restoration 未失败
//   1  部分失败 / recovery_required / verification 不绿
//   2  预检未过（fleet 不干净）
//   3  超时
//   4  客户端 / SSH / 解析错误

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const argv = process.argv.slice(2);
const opt = (n, fb = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : fb;
};
const flag = (n) => argv.includes(n);

if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/conc4-full-dry-run.mjs --actor <id> [选项]

必填:
  --actor <id>          例 hermes-conc4 / mimo-conc4 / grok-conc4

选项:
  --ssh <host>          默认 xhs-windows
  --capability <id>     默认 xianyu.publish.full_dry_run
  --fixtures <dir>      默认 <repo>/campaign/fixtures
  --gpfs <path>         默认 GPFS 路由仓（devicectl 所在）
  --aliases 01,02,03,04 默认四台
  --timeout-s <n>       默认 1200（02 的 5×2 可能 ~12min）
  --poll-s <n>          默认 20
  --dry-run             只预检+打印将 submit 的内容，不发 job
  --keep-log <dir>      落 submit/status JSON

环境契约:
  Mac = 本脚本 + fixture + devicectl 客户端
  Windows = 业务执行码 (xhs-routing-v1-1 @ main) + 17920/17930
  禁止 curl Mac localhost:17930

退出码: 0 全绿 | 1 部分失败 | 2 预检失败 | 3 超时 | 4 客户端错误`);
  process.exit(0);
}

const ACTOR = opt("--actor");
const SSH = opt("--ssh", "xhs-windows");
const CAP = opt("--capability", "xianyu.publish.full_dry_run");
const FIXTURES = opt("--fixtures", join(ROOT, "campaign/fixtures"));
const GPFS = opt("--gpfs", "/Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-device-agent-routing-v1-1");
const ALIASES = (opt("--aliases", "01,02,03,04") || "01,02,03,04").split(",").map((s) => s.trim()).filter(Boolean);
const TIMEOUT_S = Number(opt("--timeout-s", "1200")) || 1200;
const POLL_S = Number(opt("--poll-s", "20")) || 20;
const DRY = flag("--dry-run");
const KEEP_LOG = opt("--keep-log", null);

if (!ACTOR || !String(ACTOR).trim()) {
  console.log("✗ 需要 --actor <id>（例 hermes-conc4）。见 --help");
  process.exit(4);
}

const DEVICTL = join(GPFS, "control-plane/devicectl.mjs");
const TS = Date.now();
const logDir = KEEP_LOG || join("/tmp", `conc4-${TS}`);
if (KEEP_LOG) mkdirSync(KEEP_LOG, { recursive: true });

const log = (m) => console.log(m);

function parseJsonBlob(stdout) {
  const s = String(stdout);
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b < 0 || b < a) throw new Error("no JSON in output: " + s.slice(0, 240));
  return JSON.parse(s.slice(a, b + 1));
}

function runNode(args, opts = {}) {
  try {
    return execFileSync("node", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
  } catch (e) {
    const out = `${e.stdout || ""}${e.stderr || ""}${e.message || ""}`;
    const err = new Error(out.slice(0, 800));
    err.cause = e;
    throw err;
  }
}

function sshCurl(path) {
  try {
    return execFileSync(
      "ssh",
      [SSH, "curl.exe", "-s", "-m", "15", `http://127.0.0.1:17930${path}`],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    throw new Error(`ssh curl registry failed: ${(e.stderr || e.message || "").toString().slice(0, 300)}`);
  }
}

function loadFixture(alias) {
  const p = join(FIXTURES, `${alias}-full.json`);
  if (!existsSync(p)) throw new Error(`fixture 不存在: ${p}`);
  return { path: p, params: JSON.parse(readFileSync(p, "utf8")) };
}

function deviceFromEntry(entry, alias) {
  const devices = entry.devices || [];
  const d = devices.find((x) => x.alias === alias);
  if (!d) return null;
  const state = d.state || {};
  const control = d.control || {};
  const deviceId = control.deviceId || d.deviceId || null;
  const quarantined = state.quarantined ?? control.quarantined ?? null;
  const ready = state.ready;
  const leaseFree = state.leaseFree ?? (control.lease == null || control.lease === null);
  const online = state.online ?? control.online;
  return {
    alias,
    deviceId,
    ready,
    quarantined,
    leaseFree,
    online,
    serial: d.serial || control.serial || null,
  };
}

function preflight() {
  if (!existsSync(DEVICTL)) {
    throw Object.assign(new Error(`devicectl 不存在: ${DEVICTL}（GPFS 未挂载？用 --gpfs 覆盖）`), { code: 4 });
  }
  let entry;
  try {
    entry = JSON.parse(sshCurl("/api/agent-entry"));
  } catch (e) {
    throw Object.assign(new Error(e.message), { code: 4 });
  }
  if (!entry.ok && entry.ok !== undefined) {
    // some payloads always ok; ignore
  }
  const cp = entry.controlPlane || {};
  const activeLeases = cp.activeLeases ?? entry.activeLeases;
  const rows = [];
  const problems = [];
  for (const alias of ALIASES) {
    const row = deviceFromEntry(entry, alias);
    if (!row) {
      problems.push(`${alias}: 不在 agent-entry.devices`);
      continue;
    }
    if (!row.deviceId) problems.push(`${alias}: 无 deviceId`);
    if (row.ready !== true) problems.push(`${alias}: ready=${row.ready}`);
    if (row.quarantined === true) problems.push(`${alias}: quarantined`);
    if (row.leaseFree === false) problems.push(`${alias}: lease 占用中`);
    if (row.online === false) problems.push(`${alias}: offline`);
    rows.push(row);
  }
  if (activeLeases != null && Number(activeLeases) > 0) {
    problems.push(`controlPlane.activeLeases=${activeLeases}（非 0，暂不并发）`);
  }
  const blockers = entry.blockers?.active || entry.blockers?.active_blockers || [];
  return { entry, rows, problems, activeLeases, blockers };
}

function submitOne(alias, deviceId, params) {
  const idem = `conc4-${alias}-${TS}`;
  const paramsStr = JSON.stringify(params);
  const out = runNode([
    DEVICTL,
    "--ssh",
    SSH,
    "job",
    "submit",
    "--actor",
    ACTOR,
    "--capability",
    CAP,
    "--device",
    deviceId,
    "--idempotency-key",
    idem,
    "--params",
    paramsStr,
  ]);
  const j = parseJsonBlob(out);
  const job = j.job || j;
  const jobId = job.jobId || j.jobId;
  if (!jobId) throw new Error(`${alias}: submit 无 jobId: ${out.slice(0, 300)}`);
  if (KEEP_LOG || true) {
    try {
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, `submit-${alias}.json`), JSON.stringify(j, null, 2));
    } catch { /* ignore */ }
  }
  return { alias, jobId, idem, raw: j };
}

function statusOne(jobId) {
  const out = runNode([DEVICTL, "--ssh", SSH, "job", "status", "--job", jobId]);
  const j = parseJsonBlob(out);
  const job = j.job || j;
  return job;
}

function summarizeJob(job) {
  const result = job.result || {};
  const verification = result.verification || job.verification || {};
  const restoration = result.restoration || job.restoration || {};
  const output = result.output || job.output || {};
  return {
    status: job.status || "?",
    errorCode: job.errorCode || null,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    outputOk: output.ok === true || result?.output?.ok === true,
    verificationOk: verification.ok !== false && (verification.ok === true || verification.ok == null),
    restorationOk: restoration.ok !== false && (restoration.ok === true || restoration.ok == null || restoration.ok === undefined),
    // prefer explicit false as fail
    restorationFailed: restoration.ok === false,
    verificationFailed: verification.ok === false,
  };
}

function isTerminal(status) {
  return ["succeeded", "failed", "recovery_required", "cancelled", "denied", "ambiguous"].includes(status);
}

function sleepSync(seconds) {
  // macOS/Linux sleep; avoid Atomics/SharedArrayBuffer quirks
  try {
    execFileSync("sleep", [String(seconds)], { stdio: "ignore" });
  } catch {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) { /* spin fallback */ }
  }
}

// --- main ---
let pre;
try {
  log(`[conc4] actor=${ACTOR} capability=${CAP} ssh=${SSH} dryRun=${DRY}`);
  log(`[conc4] gpfs=${GPFS}`);
  log(`[conc4] fixtures=${FIXTURES}`);
  pre = preflight();
} catch (e) {
  console.log(`✗ 客户端错误: ${e.message}`);
  process.exit(e.code === 2 ? 2 : 4);
}

log(`[conc4] activeLeases=${pre.activeLeases} blockers.active=${(pre.blockers || []).length}`);
for (const r of pre.rows) {
  log(`  ${r.alias} deviceId=${r.deviceId} ready=${r.ready} q=${r.quarantined} leaseFree=${r.leaseFree} online=${r.online}`);
}

if (pre.problems.length) {
  console.log("✗ 预检未过（fleet 不干净）:");
  for (const p of pre.problems) console.log(`  - ${p}`);
  console.log("  先恢复/释放 lease 后再跑；或手拼单机调试。");
  process.exit(2);
}

const plans = [];
try {
  for (const alias of ALIASES) {
    const row = pre.rows.find((r) => r.alias === alias);
    const fix = loadFixture(alias);
    const sku = fix.params.skuSpecs ? JSON.stringify(fix.params.skuSpecs) : "{}";
    plans.push({
      alias,
      deviceId: row.deviceId,
      fixture: fix.path,
      params: fix.params,
      skuHint: sku.slice(0, 80),
    });
  }
} catch (e) {
  console.log(`✗ fixture/解析错误: ${e.message}`);
  process.exit(4);
}

if (DRY) {
  log("\n[dry-run] 将提交：");
  for (const p of plans) {
    log(`  ${p.alias} → ${p.deviceId}`);
    log(`    fixture=${p.fixture}`);
    log(`    skuSpecs≈${p.skuHint}`);
    log(`    idempotency-key=conc4-${p.alias}-${TS}`);
  }
  log("\n✓ dry-run 预检通过（未 submit）");
  process.exit(0);
}

// parallel submits via sequential is ok (fast); use Promise-less sync for simplicity & clearer errors
const jobs = [];
log("\n[conc4] submitting…");
for (const p of plans) {
  try {
    const s = submitOne(p.alias, p.deviceId, p.params);
    jobs.push(s);
    log(`  ${p.alias} jobId=${s.jobId} idem=${s.idem}`);
  } catch (e) {
    console.log(`✗ submit ${p.alias} 失败: ${e.message}`);
    process.exit(4);
  }
}

const byAlias = Object.fromEntries(jobs.map((j) => [j.alias, j]));
const deadline = Date.now() + TIMEOUT_S * 1000;
log(`\n[conc4] polling (timeout=${TIMEOUT_S}s poll=${POLL_S}s)…`);

const final = {};
while (Date.now() < deadline) {
  let allDone = true;
  const line = [];
  for (const alias of ALIASES) {
    const { jobId } = byAlias[alias];
    let job;
    try {
      job = statusOne(jobId);
    } catch (e) {
      allDone = false;
      line.push(`${alias}=?`);
      continue;
    }
    const sum = summarizeJob(job);
    final[alias] = { jobId, ...sum, job };
    line.push(`${alias}=${sum.status}`);
    if (!isTerminal(sum.status)) allDone = false;
    try {
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, `status-${alias}.json`), JSON.stringify(job, null, 2));
    } catch { /* ignore */ }
  }
  log(`[poll] ${line.join(" | ")}`);
  if (allDone) break;
  sleepSync(POLL_S);
}

// table
log("\n=== FINAL ===");
log(
  ["alias", "jobId", "status", "out", "rest", "ver", "err"].map((h) => h.padEnd(h === "jobId" ? 40 : 12)).join(" "),
);
let anyNonTerminal = false;
let anyBad = false;
for (const alias of ALIASES) {
  const f = final[alias];
  if (!f || !isTerminal(f.status)) {
    anyNonTerminal = true;
    log(`${alias.padEnd(12)} ${(f?.jobId || "?").padEnd(40)} TIMEOUT/pending`);
    continue;
  }
  const rest = f.restorationFailed ? "fail" : f.restorationOk ? "ok" : "?";
  const ver = f.verificationFailed ? "fail" : f.verificationOk ? "ok" : "?";
  const out = f.outputOk ? "ok" : "?";
  if (f.status !== "succeeded" || f.restorationFailed || f.verificationFailed) anyBad = true;
  log(
    `${alias.padEnd(12)} ${f.jobId.padEnd(40)} ${String(f.status).padEnd(12)} ${out.padEnd(12)} ${rest.padEnd(12)} ${ver.padEnd(12)} ${f.errorCode || ""}`,
  );
}
log(`\nlogDir=${logDir}`);

if (anyNonTerminal) {
  console.log("✗ 超时：仍有 job 非终态");
  process.exit(3);
}
if (anyBad) {
  console.log("✗ 未全绿（部分 failed/recovery_required 或 verification/restoration 失败）");
  process.exit(1);
}
console.log("✓ 4 机全绿 succeeded + restoration/verification 未失败");
process.exit(0);
