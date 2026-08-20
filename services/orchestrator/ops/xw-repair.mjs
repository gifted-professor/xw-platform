#!/usr/bin/env node
/**
 * Semi-automatic infrastructure repair entrypoint for the xw-runtime world.
 *
 * --check is strictly read-only: it reports which device serials sit on the
 * 5037/5038 ADB daemons, the four FastOperator serve ports and task states,
 * and the release identity seen by the control plane and orchestrator,
 * distilled into issues[] (for example wrong_port: alias 02 在 5037).
 *
 * --fix rp-0001 handles exactly one known failure class: wrong_port (devices
 * parked on the orphan 5037 daemon). Without --confirm it only prints the
 * repair plan and exits non-zero. With --confirm it kills the non-5038 adb
 * server, restarts the affected `XW Platform FastOperator NN` scheduled tasks,
 * waits for the serve ports, and re-verifies. It refuses to run while an
 * active lease or running job exists. Unknown rp ids and unknown symptoms are
 * reported, never acted on.
 *
 * Every run (including --check) appends one JSONL record to
 * xw-runtime/logs/repair/repair-log.jsonl; a logging failure only warns.
 */

import { execFile } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { buildChildEnv } from "../scripts/lib/node-runtime.mjs";
import {
  XW_START_ADB_PORT,
  XW_START_ALIASES,
  parseAdbDevicesOutput,
} from "../scripts/lib/xw-start.mjs";

const execFileAsync = promisify(execFile);
const REGISTRY = (process.env.XHS_REGISTRY_URL || "http://127.0.0.1:17930").replace(/\/$/, "");
const CONTROL = (process.env.XHS_CONTROL_URL || "http://127.0.0.1:17920").replace(/\/$/, "");
const XW_RUNTIME_ROOT = resolve(process.env.XW_RUNTIME_ROOT || "C:\\Users\\Public\\xw-runtime");
const REPAIR_LOG = join(XW_RUNTIME_ROOT, "logs", "repair", "repair-log.jsonl");
const ADB_PATH = process.env.ADB_PATH || "C:\\Program Files (x86)\\xiaowei_android\\tools\\adb.exe";
const ADB_PORT = XW_START_ADB_PORT;
const ADB_PORTS = [...new Set([ADB_PORT, "5037"])];
const serveTaskName = (alias) => `XW Platform FastOperator ${alias}`;
const SERVE_PORTS = (() => {
  const defaults = { "01": 17895, "02": 17897, "03": 17898, "04": 17896 };
  try {
    return { ...defaults, ...(process.env.XW_SERVE_PORTS_JSON ? JSON.parse(process.env.XW_SERVE_PORTS_JSON) : {}) };
  } catch {
    return defaults;
  }
})();
const servePortFor = (alias) => Number(SERVE_PORTS[alias]);
const KNOWN_FIXES = new Set(["rp-0001"]);

function usage() {
  return "Usage: node ops/xw-repair.mjs --check [--json] | node ops/xw-repair.mjs --fix rp-0001 [--confirm] [--json]";
}

export function parseXwRepairArgs(argv) {
  let check = false;
  let fix = null;
  let confirm = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--check") check = true;
    else if (value === "--confirm") confirm = true;
    else if (value === "--json") json = true;
    else if (value === "--fix") {
      fix = argv[index + 1];
      if (!fix || fix.startsWith("--")) throw new Error("--fix requires a value");
      index += 1;
    } else if (["--help", "-h"].includes(value)) return { help: true };
    else throw new Error(`unknown option: ${value}`);
  }
  if (check && fix) throw new Error("--check and --fix are mutually exclusive");
  if (!check && !fix) return { help: true };
  return { help: false, check, fix, confirm, json };
}

function log(message) {
  process.stderr.write(`[xw-repair] ${message}\n`);
}

async function runFile(file, args, options = {}) {
  try {
    return await execFileAsync(file, args, {
      cwd: options.cwd,
      env: buildChildEnv(options.env || process.env),
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeout || 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error).trim();
    throw new Error(`${file} ${args.join(" ")} failed: ${detail}`);
  }
}

function parseLastJson(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch { /* keep looking */ }
  }
  throw new Error("command did not return JSON");
}

async function fetchJson(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { accept: "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(options.timeoutMs || 4_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = payload?.error?.code || `HTTP_${response.status}`;
    const message = payload?.error?.message || `request failed: ${path}`;
    const error = new Error(`${code}: ${message}`);
    error.code = code;
    throw error;
  }
  return payload;
}

async function scheduledTaskStatus(taskName) {
  const command = [
    `$t=Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue`,
    "$o=@{installed=($null -ne $t);taskState=$(if($null -ne $t){[string]$t.State}else{'Missing'})}",
    "$o|ConvertTo-Json -Compress",
  ].join(";");
  const { stdout } = await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]);
  return parseLastJson(stdout);
}

/** netstat probe, same cost profile as xw-start's inspectUsbAndAdbPorts. */
async function portListening(port) {
  const command = [
    "$found=$false",
    `foreach($line in netstat -ano -p TCP){ if($line -match ':${port}\\s+\\S+\\s+LISTENING'){ $found=$true; break } }`,
    "@{ listening = $found } | ConvertTo-Json -Compress",
  ].join(";");
  try {
    const { stdout } = await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]);
    return parseLastJson(stdout).listening === true;
  } catch {
    return false;
  }
}

async function waitPortListening(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portListening(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** Ask one specific adb daemon for its device list without touching the other. */
async function adbDevicesOn(port) {
  if (!await portListening(port)) {
    return { port, listening: false, devices: {}, error: "adb_server_not_listening" };
  }
  try {
    const { stdout } = await runFile(ADB_PATH, ["devices", "-l"], {
      timeout: 12_000,
      env: { ...process.env, ANDROID_ADB_SERVER_PORT: String(port) },
    });
    return { port, listening: true, devices: parseAdbDevicesOutput(stdout), error: null };
  } catch (error) {
    return { port, listening: true, devices: {}, error: error.message };
  }
}

async function loadSerialAlias() {
  const entry = await fetchJson(REGISTRY, "/api/agent-entry", { timeoutMs: 10_000 });
  const serialToAlias = {};
  const aliasToSerial = {};
  for (const device of entry?.devices || []) {
    const alias = String(device?.alias || "").trim();
    const serial = String(device?.serial || device?.control?.serial || "").trim();
    if (!alias || !serial) continue;
    serialToAlias[serial] = alias;
    aliasToSerial[alias] = serial;
  }
  return { serialToAlias, aliasToSerial };
}

async function gatherCheck() {
  const [adbSnapshots, serialMaps, controlHealth, registryHealth] = await Promise.all([
    Promise.all(ADB_PORTS.map((port) => adbDevicesOn(port))),
    loadSerialAlias().catch((error) => ({ serialToAlias: {}, aliasToSerial: {}, error: error.message })),
    fetchJson(CONTROL, "/control/v1/health").catch((error) => ({ error: error.message })),
    fetchJson(REGISTRY, "/api/health").catch((error) => ({ error: error.message })),
  ]);
  const serves = Object.fromEntries(await Promise.all(XW_START_ALIASES.map(async (alias) => {
    const port = servePortFor(alias);
    const [task, listening] = await Promise.all([scheduledTaskStatus(serveTaskName(alias)), portListening(port)]);
    return [alias, {
      port,
      installed: task.installed === true,
      taskState: task.taskState,
      listening,
    }];
  })));

  const { serialToAlias, aliasToSerial } = serialMaps;
  const issues = [];
  const adb = {};
  for (const snapshot of adbSnapshots) {
    const devices = Object.entries(snapshot.devices || {}).map(([serial, state]) => ({
      serial,
      alias: serialToAlias[serial] || null,
      state,
    }));
    adb[snapshot.port] = { ...snapshot, devices };
    if (snapshot.error && snapshot.listening) {
      issues.push({ code: "adb_query_failed", port: snapshot.port, message: `adb_query_failed: 端口 ${snapshot.port} 查询失败` });
    }
    for (const device of devices) {
      if (device.alias && String(snapshot.port) !== ADB_PORT && device.state === "device") {
        issues.push({
          code: "wrong_port",
          alias: device.alias,
          serial: device.serial,
          port: String(snapshot.port),
          message: `wrong_port: alias ${device.alias} 在 ${snapshot.port}`,
        });
      }
    }
  }
  for (const alias of XW_START_ALIASES) {
    const serve = serves[alias];
    if (serve.installed !== true) {
      issues.push({ code: "task_missing", alias, message: `task_missing: 请先注册 XW Platform FastOperator ${alias} 计划任务` });
    } else if (serve.listening !== true) {
      issues.push({ code: "serve_not_listening", alias, port: serve.port, taskState: serve.taskState, message: `serve_not_listening: alias ${alias} 端口 ${serve.port} 未监听` });
    }
  }
  const controlRelease = controlHealth?.releaseId || null;
  const registryRelease = registryHealth?.releaseId || null;
  if (controlRelease && registryRelease && controlRelease !== registryRelease) {
    issues.push({
      code: "release_identity_mismatch",
      control: controlRelease,
      registry: registryRelease,
      message: `release_identity_mismatch: control=${controlRelease} registry=${registryRelease}`,
    });
  }

  return {
    ok: true,
    mode: "check",
    adbPort: ADB_PORT,
    adb,
    serialByAlias: aliasToSerial,
    serves,
    release: {
      controlPlane: { releaseId: controlRelease, sourceCommit: controlHealth?.sourceCommit || null },
      orchestrator: { releaseId: registryRelease, sourceCommit: registryHealth?.sourceCommit || null },
    },
    issues,
  };
}

async function appendRepairLog(record) {
  try {
    await mkdir(dirname(REPAIR_LOG), { recursive: true });
    await appendFile(REPAIR_LOG, `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`, "utf8");
  } catch (error) {
    log(`warning: repair log write failed: ${error.message}`);
  }
}

async function countActiveWork() {
  const leases = await fetchJson(CONTROL, "/control/v1/leases", { timeoutMs: 4_000 }).catch(() => null);
  const entry = await fetchJson(REGISTRY, "/api/agent-entry", { timeoutMs: 10_000 }).catch(() => null);
  const activeLeases = Array.isArray(leases?.leases) ? leases.leases.length : null;
  const runningJobs = Array.isArray(entry?.jobs?.active) ? entry.jobs.active.length : null;
  return { activeLeases, runningJobs };
}

async function runFixWrongPort({ confirm }) {
  const before = await gatherCheck();
  const wrongPort = before.issues.filter((issue) => issue.code === "wrong_port");
  if (wrongPort.length === 0) {
    const other = before.issues.map((issue) => issue.code);
    return {
      output: {
        ok: other.length === 0,
        fix: "rp-0001",
        status: other.length === 0 ? "nothing_to_fix" : "unsupported_symptoms",
        reason: other.length === 0 ? null : `存在 rp-0001 无法处理的症状（${[...new Set(other)].join(",")}），只报告不动作`,
        issues: before.issues,
      },
      exitCode: other.length === 0 ? 0 : 1,
    };
  }
  const work = await countActiveWork();
  if (work.activeLeases === null || work.runningJobs === null || work.activeLeases > 0 || work.runningJobs > 0) {
    return {
      output: {
        ok: false,
        fix: "rp-0001",
        status: "refused",
        reason: work.activeLeases === null || work.runningJobs === null
          ? "active lease/running job 状态不可得，拒绝执行"
          : `存在 active lease(${work.activeLeases}) 或 running job(${work.runningJobs})，拒绝执行`,
        issues: before.issues,
      },
      exitCode: 1,
    };
  }
  const killPorts = [...new Set(wrongPort.map((issue) => issue.port))].filter((port) => port !== ADB_PORT);
  const restartAliases = [...new Set(wrongPort.map((issue) => issue.alias))];
  const plan = {
    killAdbServers: killPorts.map((port) => ({ port, command: `"${ADB_PATH}" -P ${port} kill-server` })),
    restartTasks: restartAliases.map((alias) => ({ alias, taskName: serveTaskName(alias), servePort: servePortFor(alias) })),
    affectedDevices: wrongPort.map((issue) => ({ alias: issue.alias, serial: issue.serial, port: issue.port })),
  };
  if (!confirm) {
    return {
      output: {
        ok: false,
        fix: "rp-0001",
        status: "plan_only",
        reason: "默认只打印修复计划；确认无误后加 --confirm 执行",
        plan,
        issues: before.issues,
      },
      exitCode: 1,
    };
  }
  const actions = [];
  for (const port of killPorts) {
    log(`killing adb server on ${port}`);
    await runFile(ADB_PATH, ["-P", String(port), "kill-server"], { timeout: 15_000 });
    actions.push({ kind: "adb", action: "kill_server", port });
  }
  // Give the authoritative 5038 daemon a moment to re-register the USB devices.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  for (const alias of restartAliases) {
    const taskName = serveTaskName(alias);
    const task = await scheduledTaskStatus(taskName);
    if (task.installed !== true) {
      throw new Error(`计划任务不存在，请先注册 XW Platform FastOperator ${alias} 计划任务`);
    }
    log(`restarting ${taskName}`);
    await runFile("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `Stop-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue; Start-ScheduledTask -TaskName '${taskName}' -ErrorAction Stop`,
    ]);
    const port = servePortFor(alias);
    const listening = await waitPortListening(port);
    actions.push({ kind: "serve", alias, action: "restarted", port, listening });
  }
  const after = await gatherCheck();
  const remaining = after.issues.filter((issue) => issue.code === "wrong_port");
  const restartsOk = actions.filter((action) => action.kind === "serve").every((action) => action.listening === true);
  return {
    output: {
      ok: remaining.length === 0 && restartsOk,
      fix: "rp-0001",
      status: remaining.length === 0 && restartsOk ? "repaired" : "incomplete",
      plan,
      actions,
      remainingIssues: after.issues,
    },
    exitCode: remaining.length === 0 && restartsOk ? 0 : 1,
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseXwRepairArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.check) {
    const output = await gatherCheck();
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    await appendRepairLog({ mode: "check", ok: output.ok, issueCount: output.issues.length, issues: output.issues });
    return;
  }
  if (!KNOWN_FIXES.has(options.fix)) {
    const output = { ok: false, fix: options.fix, status: "unknown_repair", reason: `未知修复编号 ${options.fix}，只报告不动作` };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    await appendRepairLog({ mode: "fix", fix: options.fix, status: output.status });
    process.exitCode = 1;
    return;
  }
  const { output, exitCode } = await runFixWrongPort({ confirm: options.confirm });
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  await appendRepairLog({
    mode: "fix",
    fix: options.fix,
    confirm: options.confirm,
    status: output.status,
    issueCount: (output.issues || output.remainingIssues || []).length,
    actions: output.actions || [],
  });
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, status: "BLOCKED", error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
