#!/usr/bin/env node
/**
 * Idempotent `/xw start` coordinator.
 *
 * Converges infrastructure and requested devices in at most two passes:
 * exact-release service reconciliation, formal audited recovery for quarantined
 * devices, then R0 readiness jobs. ADB health is authoritative only on Xiaowei's
 * control-plane port 5038; 5037 is sampled as diagnostic evidence so a device
 * on the wrong daemon is reported as wrong_port, never merged into health. It
 * never writes control.db, bypasses a lease,
 * toggles USB/PnP devices, or executes an external-effect capability.
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  XW_START_ADB_PORT,
  XW_START_ALIASES,
  XW_START_READINESS_CAPABILITY,
  annotatePrimaryAdbSnapshot,
  buildStableAdbSnapshot,
  buildRecoveryAnalysisEnvelope,
  buildXwStartPlan,
  classifyRecoveryPass,
  classifyXwStartFinal,
  normalizeStartAliases,
  parseAdbDevicesOutput,
  summarizeCapabilityLimits,
} from "../scripts/lib/xw-start.mjs";

const execFileAsync = promisify(execFile);
const REGISTRY = (process.env.XHS_REGISTRY_URL || "http://127.0.0.1:17930").replace(/\/$/, "");
const CONTROL = (process.env.XHS_CONTROL_URL || "http://127.0.0.1:17920").replace(/\/$/, "");
const ROUTING_ROOT = process.env.XHS_ROUTING_ROOT || "C:\\Users\\Public\\xhs-routing-v1-1";
const CONTROL_TASK = `${ROUTING_ROOT}\\scripts\\control-plane-task.ps1`;
const SERVE_TASK = `${ROUTING_ROOT}\\scripts\\fast-operator-serve-task.ps1`;
const TASK_LAUNCH = "C:\\Users\\Public\\xhs-agent-control\\task-launch.json";
const SERVE_STATE_ROOT = "C:\\Users\\Public\\xhs-agent-control\\fast-operator";
const REGISTRY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IDENTITIES_SEED = join(REGISTRY_ROOT, "identities.seed.json");
const ADB_PATH = process.env.ADB_PATH || "C:\\Program Files (x86)\\xiaowei_android\\tools\\adb.exe";
const ADB_PORT = XW_START_ADB_PORT;
const RUNS_ROOT = resolve(process.env.XHS_AGENT_RUNS_ROOT || "C:\\Users\\Public\\xhs-agent-runs");
const VISUAL_RESOLVER_ROOT = resolve(process.env.XW_VISUAL_LOCATOR_ROOT
  || "C:\\Users\\Public\\xhs-registry-visual-tap\\experiments\\visual-tap-resolver");
const VISUAL_RESOLVER_PYTHON = resolve(process.env.XW_VISUAL_LOCATOR_PYTHON
  || join(VISUAL_RESOLVER_ROOT, ".venv-ocr", "Scripts", "python.exe"));
const VISUAL_RESOLVER_SCRIPT = join(VISUAL_RESOLVER_ROOT, "visual_tap_demo.py");
const TERMINAL_JOB_STATES = new Set(["succeeded", "failed", "ambiguous", "cancelled", "recovery_required"]);

function usage() {
  return "Usage: node ops/xw-start.mjs [01,02|01 02] [--check] [--actor ID] [--json]";
}

export function parseXwStartArgs(argv) {
  const positional = [];
  let check = false;
  let json = false;
  let actor = null;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--check") check = true;
    else if (value === "--json") json = true;
    else if (value === "--actor") {
      actor = argv[index + 1];
      if (!actor || actor.startsWith("--")) throw new Error("--actor requires a value");
      index += 1;
    } else if (["--help", "-h"].includes(value)) return { help: true };
    else if (value.startsWith("--")) throw new Error(`unknown option: ${value}`);
    else positional.push(value);
  }
  return { help: false, check, json, actor, aliases: normalizeStartAliases(positional) };
}

function log(message) {
  process.stderr.write(`[xw-start] ${message}\n`);
}

function truthyFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

async function runFile(file, args, options = {}) {
  try {
    return await execFileAsync(file, args, {
      cwd: options.cwd,
      env: options.env || process.env,
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

async function runPowerShellScript(path, args) {
  const { stdout } = await runFile("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path, ...args,
  ], { timeout: 45_000 });
  return parseLastJson(stdout);
}

async function registryTaskStatus() {
  const command = [
    "$t=Get-ScheduledTask -TaskName 'XhsDeviceRegistry' -ErrorAction SilentlyContinue",
    "$o=@{installed=($null -ne $t);taskState=$(if($null -ne $t){[string]$t.State}else{'Missing'})}",
    "$o|ConvertTo-Json -Compress",
  ].join(";");
  const { stdout } = await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]);
  return parseLastJson(stdout);
}

async function startRegistryTask() {
  await runFile("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "Start-ScheduledTask -TaskName 'XhsDeviceRegistry' -ErrorAction Stop",
  ]);
}

async function fetchJson(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) },
    signal: AbortSignal.timeout(options.timeoutMs || 4_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = payload?.error?.code || `HTTP_${response.status}`;
    const message = payload?.error?.message || `request failed: ${path}`;
    const error = new Error(`${code}: ${message}`);
    error.code = code;
    error.details = payload?.error?.details || null;
    throw error;
  }
  return payload;
}

async function reachable(base, path) {
  try {
    await fetchJson(base, path, { timeoutMs: 2_000 });
    return true;
  } catch {
    return false;
  }
}

async function waitReachable(base, path, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await reachable(base, path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function readJson(path) {
  return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
}

async function releaseGate() {
  if (truthyFlag(process.env.MISSION_AUTO_APPROVAL_ENABLED) || truthyFlag(process.env.STANDING_GRANT_ENABLED)) {
    return { ok: false, reason: "unsafe_feature_flag_enabled" };
  }
  try {
    const { stdout } = await runFile(process.execPath, ["scripts/assert-release-gates.mjs", "."], {
      cwd: ROUTING_ROOT,
      env: {
        ...process.env,
        XHS_REQUIRE_TEST_RECEIPT: "1",
        XHS_REQUIRE_MAIN_ORIGIN: "1",
      },
      timeout: 60_000,
    });
    const gate = parseLastJson(stdout);
    const taskLaunch = await readJson(TASK_LAUNCH);
    const ok = gate?.ok === true && gate?.head === gate?.originMain && taskLaunch.gitCommit === gate.head;
    return { ok, reason: ok ? null : "release_identity_mismatch", head: gate?.head || null, taskCommit: taskLaunch.gitCommit || null };
  } catch (error) {
    return { ok: false, reason: "release_gate_failed", error: error.message };
  }
}

async function serveStatus(alias) {
  const status = await runPowerShellScript(SERVE_TASK, ["-Action", "Status", "-Alias", alias]);
  let launchCommit = null;
  try {
    launchCommit = (await readJson(`${SERVE_STATE_ROOT}\\serve-launch-${alias}.json`)).gitCommit || null;
  } catch { /* missing/stale launch config is handled by the planner */ }
  return { ...status, healthy: status.listening === true, launchCommit };
}

async function serveTaskBindingOk(alias) {
  const taskName = `XhsFastOperator${alias}Live`;
  const worker = `${ROUTING_ROOT}\\scripts\\fast-operator-serve-worker.ps1`;
  const launchConfig = `${SERVE_STATE_ROOT}\\serve-launch-${alias}.json`;
  const command = [
    `$t=Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue`,
    "$a=$(if($null -ne $t){@($t.Actions)[0]}else{$null})",
    "$o=@{installed=($null -ne $t);execute=$(if($null -ne $a){[string]$a.Execute}else{''});arguments=$(if($null -ne $a){[string]$a.Arguments}else{''})}",
    "$o|ConvertTo-Json -Compress",
  ].join(";");
  const { stdout } = await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]);
  const binding = parseLastJson(stdout);
  const executableOk = String(binding.execute || "").toLowerCase().endsWith("\\powershell.exe");
  const taskArgs = String(binding.arguments || "").toLowerCase();
  return binding.installed === true
    && executableOk
    && taskArgs.includes(`-file \"${worker.toLowerCase()}\"`)
    && taskArgs.includes(`-launchconfig \"${launchConfig.toLowerCase()}\"`);
}

export async function reconcileStoppedServe({
  alias,
  launchCommit,
  desiredCommit,
  install,
  inspectPartialInstall,
  start,
}) {
  let rebindAction = null;
  let installWarning = null;
  if (launchCommit !== desiredCommit) {
    try {
      await install();
      rebindAction = "rebound";
    } catch (error) {
      const after = await inspectPartialInstall();
      const safelyRebound = after?.installed === true
        && after?.listening === false
        && after?.launchCommit === desiredCommit
        && after?.taskBindingOk === true;
      if (!safelyRebound) throw error;
      rebindAction = "rebound_existing_task";
      installWarning = error.message;
    }
  }
  const started = await start();
  if (started?.listening !== true) throw new Error(`serve ${alias} did not listen`);
  return { started, rebindAction, installWarning };
}

function devicesFromEntry(entry) {
  return Object.fromEntries((entry?.devices || []).map((device) => [String(device.alias), {
    stateKnown: true,
    online: device?.state?.online === true,
    ready: device?.state?.ready === true,
    leaseFree: device?.state?.leaseFree === true,
    quarantined: device?.state?.quarantined === true,
    hasUnresolvedFailure: device?.state?.hasUnresolvedFailure === true,
    unresolvedJobId: device?.jobStatus?.unresolvedFailure?.jobId || null,
    serial: device?.serial || device?.control?.serial || null,
  }]));
}

function activeBlockersFromEntry(entry) {
  if (Array.isArray(entry?.blockers)) return entry.blockers;
  return Array.isArray(entry?.blockers?.active) ? entry.blockers.active : [];
}

async function hydrateActiveBlockers(blockers) {
  return Promise.all((blockers || []).map(async (blocker) => {
    if (!blocker?.id) return blocker;
    try {
      const payload = await fetchJson(REGISTRY, `/api/knowledge/${encodeURIComponent(blocker.id)}`);
      return { ...blocker, ...(payload?.knowledge || {}) };
    } catch {
      return blocker;
    }
  }));
}

async function loadSeedSerials() {
  try {
    const seed = await readJson(IDENTITIES_SEED);
    return Object.fromEntries((seed.identities || []).map((item) => [String(item.alias), String(item.serial || "").trim() || null]));
  } catch {
    return {};
  }
}

function serialByAliasFrom(entryDevices, seedSerials, aliases) {
  const out = {};
  for (const alias of aliases) {
    out[alias] = entryDevices?.[alias]?.serial || seedSerials?.[alias] || null;
  }
  return out;
}

async function inspectPnpPresence(aliases, serialByAlias) {
  const command = [
    "$ids=@(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | ForEach-Object {[string]$_.InstanceId})",
    "$ids|ConvertTo-Json -Compress",
  ].join(";");
  try {
    const { stdout } = await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]);
    const parsed = JSON.parse(String(stdout || "[]").replace(/^\uFEFF/, "").trim() || "[]");
    const ids = (Array.isArray(parsed) ? parsed : [parsed]).map((value) => String(value).toLowerCase());
    return Object.fromEntries(aliases.map((alias) => {
      const serial = String(serialByAlias?.[alias] || "").toLowerCase();
      return [alias, Boolean(serial) && ids.some((id) => id.endsWith(`\\${serial}`))];
    }));
  } catch {
    return Object.fromEntries(aliases.map((alias) => [alias, false]));
  }
}

async function inspectListeningAdbPorts() {
  const command = [
    "$ports=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue",
    "| Where-Object {$_.LocalPort -in 5037,5038}",
    "| ForEach-Object {[string]$_.LocalPort} | Sort-Object -Unique)",
    ";$ports|ConvertTo-Json -Compress",
  ].join(" ");
  try {
    const { stdout } = await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]);
    const parsed = JSON.parse(String(stdout || "[]").replace(/^\uFEFF/, "").trim() || "[]");
    return (Array.isArray(parsed) ? parsed : [parsed]).map(String);
  } catch {
    return [];
  }
}

async function inspectAdb(aliases, serialByAlias) {
  const pnpPresentByAlias = await inspectPnpPresence(aliases, serialByAlias);
  const listeningPorts = await inspectListeningAdbPorts();
  const snapshots = [];
  for (const port of [...new Set([ADB_PORT, "5037"])].filter((value) => listeningPorts.includes(value))) {
    try {
      const samples = [];
      for (let index = 0; index < 3; index += 1) {
        const { stdout } = await runFile(ADB_PATH, ["devices", "-l"], {
          timeout: 12_000,
          env: { ...process.env, ANDROID_ADB_SERVER_PORT: port },
        });
        samples.push(parseAdbDevicesOutput(stdout));
        if (index < 2) await new Promise((resolve) => setTimeout(resolve, 400));
      }
      snapshots.push(buildStableAdbSnapshot({ aliases, serialByAlias, samples, pnpPresentByAlias, port, adbPath: ADB_PATH }));
    } catch (error) {
      snapshots.push(buildStableAdbSnapshot({
        aliases, serialByAlias, samples: [], pnpPresentByAlias, port, adbPath: ADB_PATH, error: error.message,
      }));
    }
  }
  const primary = snapshots.find((snapshot) => snapshot.port === ADB_PORT)
    || buildStableAdbSnapshot({
      aliases,
      serialByAlias,
      samples: [],
      pnpPresentByAlias,
      port: ADB_PORT,
      adbPath: ADB_PATH,
      error: "primary_adb_server_not_listening",
    });
  const diagnostics = snapshots.filter((snapshot) => snapshot.port !== ADB_PORT);
  return {
    ...annotatePrimaryAdbSnapshot(primary, diagnostics),
    primaryPort: ADB_PORT,
    probedPorts: snapshots.map((item) => ({ port: item.port, ok: item.ok, missing: item.missing })),
  };
}

async function inspect({ aliases, gate = null } = {}) {
  const [registryTask, controlTask, registryHealthy, controlHealthy, seedSerials] = await Promise.all([
    registryTaskStatus(),
    runPowerShellScript(CONTROL_TASK, ["-Action", "Status"]),
    reachable(REGISTRY, "/api/health"),
    reachable(CONTROL, "/control/v1/health"),
    loadSeedSerials(),
  ]);
  const effectiveGate = gate || await releaseGate();
  const serveEntries = await Promise.all(aliases.map(async (alias) => {
    try { return [alias, await serveStatus(alias)]; }
    catch (error) { return [alias, { installed: false, listening: false, launchCommit: null, error: error.message }]; }
  }));
  const serves = Object.fromEntries(serveEntries);

  let entry = null;
  let deep = null;
  let leases = [];
  if (registryHealthy) {
    [entry, deep] = await Promise.all([
      fetchJson(REGISTRY, "/api/agent-entry", { timeoutMs: 20_000 }).catch(() => null),
      fetchJson(REGISTRY, "/api/health?deep=1", { timeoutMs: 10_000 }).catch(() => null),
    ]);
  }
  if (controlHealthy) {
    leases = (await fetchJson(CONTROL, "/control/v1/leases").catch(() => ({ leases: [] }))).leases || [];
  }
  const desiredCommit = effectiveGate.head || (await readJson(TASK_LAUNCH).catch(() => ({}))).gitCommit || "";
  const activeBlockers = await hydrateActiveBlockers(activeBlockersFromEntry(entry));
  const capabilityLimits = summarizeCapabilityLimits(activeBlockers);
  const devices = devicesFromEntry(entry);
  const serialByAlias = serialByAliasFrom(devices, seedSerials, aliases);
  const adb = await inspectAdb(aliases, serialByAlias);
  return {
    registry: { installed: registryTask.installed === true, healthy: registryHealthy, taskState: registryTask.taskState },
    controlPlane: { installed: controlTask.installed === true, healthy: controlHealthy, taskState: controlTask.taskState },
    releaseGate: effectiveGate,
    desiredCommit,
    activeLeases: entry?.controlPlane?.activeLeases ?? leases.length,
    runningJobs: entry?.jobs?.active?.length ?? 0,
    pendingApprovals: deep?.approvals?.pendingCount ?? 0,
    activeBlockers: activeBlockers.length,
    blockerSummaries: activeBlockers.map((blocker) => blocker.summary || blocker.title || blocker.id).filter(Boolean),
    capabilityLimits,
    serves,
    stateKnown: entry !== null,
    devices,
    adb,
    entry,
  };
}

async function ensureBaseServices(initial, gate, actions) {
  if (!gate.ok) throw new Error(`release gate closed: ${gate.reason}`);
  if (!initial.controlPlane.healthy) {
    if (!initial.controlPlane.installed) throw new Error("control-plane scheduled task is missing");
    log("starting control plane");
    await runPowerShellScript(CONTROL_TASK, ["-Action", "Start"]);
    if (!await waitReachable(CONTROL, "/control/v1/health")) throw new Error("control plane did not become healthy");
    actions.push({ kind: "service", service: "control-plane", action: "started" });
  }
  if (!initial.registry.healthy) {
    if (!initial.registry.installed) throw new Error("registry scheduled task is missing");
    log("starting registry");
    await startRegistryTask();
    if (!await waitReachable(REGISTRY, "/api/health")) throw new Error("registry did not become healthy");
    actions.push({ kind: "service", service: "registry", action: "started" });
  }
}

async function ensureServes(snapshot, aliases, actions) {
  if (snapshot.activeLeases > 0 || snapshot.runningJobs > 0) {
    throw new Error("active work present; refusing to change serve tasks");
  }
  const results = [];
  for (const alias of aliases) {
    const serve = snapshot.serves[alias];
    if (serve?.listening === true) {
      if (serve.launchCommit !== snapshot.desiredCommit) {
        try {
          log(`stopping stale serve ${alias} for exact-release rebind`);
          await runPowerShellScript(SERVE_TASK, ["-Action", "Stop", "-Alias", alias]);
          actions.push({ kind: "serve", alias, action: "stopped_for_rebind" });
          const stopped = await serveStatus(alias);
          if (stopped.listening === true) throw new Error(`serve ${alias} did not stop`);
          const reconciled = await reconcileStoppedServe({
            alias,
            launchCommit: stopped.launchCommit,
            desiredCommit: snapshot.desiredCommit,
            install: () => runPowerShellScript(SERVE_TASK, ["-Action", "Install", "-Alias", alias]),
            inspectPartialInstall: async () => ({
              ...await serveStatus(alias),
              taskBindingOk: await serveTaskBindingOk(alias),
            }),
            start: () => runPowerShellScript(SERVE_TASK, ["-Action", "Start", "-Alias", alias]),
          });
          actions.push({ kind: "serve", alias, action: reconciled.rebindAction || "rebound", gitCommit: snapshot.desiredCommit });
          actions.push({ kind: "serve", alias, action: "started", port: reconciled.started.port });
          results.push({ alias, status: "ready", action: "rebind_restart", port: reconciled.started.port });
        } catch (error) {
          results.push({ alias, status: "failed", reason: error.message });
        }
      } else {
        results.push({ alias, status: "ready", action: "none" });
      }
      continue;
    }
    if (serve?.installed !== true) {
      results.push({ alias, status: "blocked", reason: "task_missing" });
      continue;
    }
    try {
      const stale = serve.launchCommit !== snapshot.desiredCommit;
      if (stale) {
        log(`rebinding serve ${alias} to deployed commit`);
      }
      const reconciled = await reconcileStoppedServe({
        alias,
        launchCommit: serve.launchCommit,
        desiredCommit: snapshot.desiredCommit,
        install: () => runPowerShellScript(SERVE_TASK, ["-Action", "Install", "-Alias", alias]),
        inspectPartialInstall: async () => ({
          ...await serveStatus(alias),
          taskBindingOk: await serveTaskBindingOk(alias),
        }),
        start: async () => {
          log(`starting serve ${alias}`);
          return runPowerShellScript(SERVE_TASK, ["-Action", "Start", "-Alias", alias]);
        },
      });
      const { started } = reconciled;
      if (reconciled.rebindAction) {
        actions.push({
          kind: "serve",
          alias,
          action: reconciled.rebindAction,
          gitCommit: snapshot.desiredCommit,
          ...(reconciled.installWarning ? { note: "existing exact-bound task reused after task registration was denied" } : {}),
        });
      }
      actions.push({ kind: "serve", alias, action: "started", port: started.port });
      results.push({ alias, status: "ready", action: "started", port: started.port });
    } catch (error) {
      results.push({ alias, status: "failed", reason: error.message });
    }
  }
  return results;
}

async function observeLeasesUntil(stopSignal, snapshots) {
  while (!stopSignal.stop) {
    try {
      const result = await fetchJson(CONTROL, "/control/v1/leases", { timeoutMs: 1_500 });
      snapshots.push(...(result.leases || []));
    } catch { /* terminal job status remains authoritative; visibility is recorded separately */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function runReadinessJob(alias, physicalLabel, actor) {
  const request = {
    actorId: actor,
    capabilityId: XW_START_READINESS_CAPABILITY,
    params: {},
    canary: false,
    placement: { alias, physicalLabel },
  };
  const route = await fetchJson(CONTROL, "/control/v1/routes/plan", {
    method: "POST", body: JSON.stringify(request), timeoutMs: 5_000,
  });
  if (route?.route?.decision !== "dispatchable") throw new Error(`route for ${alias} is ${route?.route?.decision || "unknown"}`);
  if (route?.route?.authorization?.decision !== "allow" || route?.route?.externalEffect === true || route?.route?.approvalRequired === true) {
    throw new Error(`R0 route authorization rejected for ${alias}`);
  }
  if (route?.route?.selectedDevice?.alias !== alias) throw new Error(`route alias mismatch for ${alias}`);

  const leaseSnapshots = [];
  const stopSignal = { stop: false };
  const observer = observeLeasesUntil(stopSignal, leaseSnapshots);
  let job;
  try {
    const submission = await fetchJson(CONTROL, "/control/v1/jobs", {
      method: "POST",
      body: JSON.stringify({
        ...request,
        idempotencyKey: `xw-start-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${alias}-${randomUUID().slice(0, 8)}`,
      }),
      timeoutMs: 5_000,
    });
    job = submission.job;
    if (job?.capability?.risk !== "R0" || job?.externalEffect === true || job?.approvalRequired === true) {
      throw new Error(`submitted readiness job is not autonomous R0 for ${alias}`);
    }
    const deadline = Date.now() + 30_000;
    while (!TERMINAL_JOB_STATES.has(job.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = (await fetchJson(CONTROL, `/control/v1/jobs/${encodeURIComponent(job.jobId)}`, { timeoutMs: 3_000 })).job;
    }
    if (!TERMINAL_JOB_STATES.has(job.status)) throw new Error(`readiness job timed out for ${alias}`);
  } finally {
    stopSignal.stop = true;
    await observer;
  }
  const leaseObserved = leaseSnapshots.some((lease) => lease.jobId === job.jobId);
  return {
    alias,
    capabilityId: XW_START_READINESS_CAPABILITY,
    jobId: job.jobId,
    runId: job.runId,
    status: job.status,
    leaseObserved,
    verificationOk: job?.result?.verification?.ok === true,
    restorationOk: job?.result?.restoration?.ok !== false,
  };
}

async function waitDeviceReady(alias, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entry = await fetchJson(REGISTRY, "/api/agent-entry", { timeoutMs: 4_000 });
    const device = entry.devices?.find((item) => String(item.alias) === alias);
    if (device?.state?.ready === true && device?.state?.leaseFree === true && device?.state?.hasUnresolvedFailure !== true) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export function requireRunsEvidencePath(value, runId, { runsRoot = RUNS_ROOT } = {}) {
  const normalizedRunId = String(runId || "");
  if (!/^run_[A-Za-z0-9-]{8,80}$/.test(normalizedRunId)) {
    throw new Error("recovery inspection runId is invalid");
  }
  const raw = String(value || "");
  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(runsRoot, normalizedRunId, raw);
  const rel = relative(resolve(runsRoot), candidate);
  if (!raw || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("recovery screenshot is outside the configured runs root");
  }
  return candidate;
}

async function analyzeRecoveryScreenshot(inspection) {
  const screenshotPath = requireRunsEvidencePath(inspection?.screenshot?.path, inspection?.runId);
  const bytes = await readFile(screenshotPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== inspection?.screenshot?.sha256) {
    throw new Error("recovery screenshot sha256 does not match the audited inspection");
  }
  await stat(VISUAL_RESOLVER_PYTHON);
  await stat(VISUAL_RESOLVER_SCRIPT);
  const workDir = await mkdtemp(join(tmpdir(), "xw-start-recovery-"));
  try {
    await runFile(VISUAL_RESOLVER_PYTHON, [
      VISUAL_RESOLVER_SCRIPT,
      "vision-pack",
      "--input", screenshotPath,
      "--output-dir", workDir,
      "--query", "确认当前画面是否为安全主页",
      "--max-side", "1280",
      "--max-blocks", "256",
      "--ocr",
    ], { cwd: VISUAL_RESOLVER_ROOT, timeout: 180_000 });
    const blocksDocument = await readJson(join(workDir, "blocks.json"));
    if (blocksDocument?.input?.sha256 !== sha256) {
      throw new Error("visual analysis was not bound to the audited screenshot");
    }
    return buildRecoveryAnalysisEnvelope({
      screenshot: { sha256, bytes: bytes.length },
      blocksDocument,
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function runAuditedRecovery({ alias, jobId, actor, attempt = 1 }) {
  const nonce = `${alias}-${randomUUID().slice(0, 12)}`;
  const inspected = await fetchJson(CONTROL, `/control/v1/jobs/${encodeURIComponent(jobId)}/recover/inspect`, {
    method: "POST",
    body: JSON.stringify({ actorId: actor, idempotencyKey: `xw-start-inspect-${nonce}` }),
    timeoutMs: 45_000,
  });
  const inspection = inspected?.inspection || inspected;
  if (!inspection?.inspectionId || inspection?.stoppedBeforeAction !== true) {
    throw new Error(`audited recovery inspection was incomplete for ${alias}`);
  }
  const analysis = await analyzeRecoveryScreenshot(inspection);
  const recorded = await fetchJson(
    CONTROL,
    `/control/v1/jobs/${encodeURIComponent(jobId)}/recover/inspect/${encodeURIComponent(inspection.inspectionId)}/analysis`,
    {
      method: "POST",
      body: JSON.stringify({
        actorId: actor,
        idempotencyKey: `xw-start-analysis-${nonce}`,
        analysis,
      }),
      timeoutMs: 45_000,
    },
  );
  const analysisResult = recorded?.analysis || recorded;
  const page = analysisResult?.pageClassification || {};
  const pass = classifyRecoveryPass(page, attempt);
  if (pass === "human_required") {
    return {
      alias,
      jobId,
      status: "human_required",
      reason: "main_safe_not_verified",
      inspectionId: inspection.inspectionId,
      pageClassification: page,
    };
  }
  let recovered;
  try {
    recovered = await fetchJson(CONTROL, `/control/v1/jobs/${encodeURIComponent(jobId)}/recover`, {
      method: "POST",
      body: JSON.stringify({ actorId: actor, idempotencyKey: `xw-start-recover-${nonce}` }),
      timeoutMs: 45_000,
    });
  } catch (error) {
    if (error.code === "RECOVERY_FAILED"
      && error.details?.causeCode === "RECOVERY_VISUAL_CONFIRMATION_REQUIRED"
      && attempt === 1) {
      return {
        alias,
        jobId,
        status: "recovery_action_applied",
        reason: "fresh_visual_confirmation_required",
        inspectionId: inspection.inspectionId,
        pageClassification: page,
      };
    }
    throw error;
  }
  const recovery = recovered?.recovery || recovered;
  if (pass !== "clear_quarantine" && recovery?.quarantineCleared === true) {
    throw new Error(`unsafe recovery cleared quarantine without fresh main-safe proof for ${alias}`);
  }
  if (pass !== "clear_quarantine") {
    return {
      alias,
      jobId,
      status: "recovery_action_applied",
      reason: "fresh_visual_confirmation_required",
      inspectionId: inspection.inspectionId,
      pageClassification: page,
    };
  }
  if (recovery?.quarantineCleared !== true) {
    throw new Error(`audited recovery did not clear quarantine for ${alias}`);
  }
  return {
    alias,
    jobId,
    status: "recovered",
    inspectionId: inspection.inspectionId,
    pageClassification: page,
    quarantineCleared: true,
  };
}

async function ensureRecoveries(snapshot, aliases, actor, actions, attemptCounts = new Map()) {
  const results = [];
  for (const alias of aliases) {
    const state = snapshot.devices[alias];
    const attempt = (attemptCounts.get(alias) || 0) + 1;
    if (state?.quarantined !== true || attempt > 2) continue;
    attemptCounts.set(alias, attempt);
    if (state?.online !== true || state?.leaseFree !== true || !state?.unresolvedJobId) {
      results.push({
        alias,
        status: "human_required",
        reason: state?.online !== true ? "offline" : (state?.leaseFree !== true ? "lease_busy" : "recovery_job_missing"),
      });
      continue;
    }
    log(`running formal audited recovery for ${alias}`);
    try {
      const result = await runAuditedRecovery({ alias, jobId: state.unresolvedJobId, actor, attempt });
      results.push(result);
      actions.push({ kind: "audited_recovery", ...result });
    } catch (error) {
      const result = { alias, status: "human_required", reason: error.message };
      results.push(result);
      actions.push({ kind: "audited_recovery", ...result });
    }
  }
  return results;
}

async function ensureReadiness(snapshot, aliases, actor, actions) {
  const controlDevices = (await fetchJson(CONTROL, "/control/v1/devices")).devices || [];
  const byAlias = new Map(controlDevices.map((device) => [String(device.alias), device]));
  const results = [];
  for (const alias of aliases) {
    const state = snapshot.devices[alias];
    if (state?.ready === true && state?.hasUnresolvedFailure !== true) continue;
    if (state?.quarantined === true) {
      results.push({ alias, status: "blocked", reason: "audited_recovery_required" });
      continue;
    }
    if (state?.online !== true || state?.leaseFree !== true) {
      results.push({ alias, status: "blocked", reason: state?.online !== true ? "offline" : "lease_busy" });
      continue;
    }
    const device = byAlias.get(alias);
    if (!device?.physicalLabel) {
      results.push({ alias, status: "blocked", reason: "placement_identity_missing" });
      continue;
    }
    log(`submitting formal R0 readiness job for ${alias}`);
    try {
      const result = await runReadinessJob(alias, device.physicalLabel, actor);
      result.readyObserved = result.status === "succeeded" ? await waitDeviceReady(alias) : false;
      results.push(result);
      actions.push({ kind: "readiness", ...result });
    } catch (error) {
      results.push({ alias, status: "failed", reason: error.message });
    }
  }
  return results;
}

async function defaultKillOrphanDaemon() {
  await runFile(ADB_PATH, ["-P", "5037", "kill-server"], { timeout: 15_000 });
  // Give the authoritative 5038 daemon a moment to re-register the USB devices.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

/**
 * Return devices parked on the orphan 5037 daemon back to Xiaowei's
 * authoritative 5038 by killing only that daemon. Never touches 5038, never
 * runs while active work is present, and re-inspection happens on the next
 * loop pass so a failed move degrades to human_required instead of being
 * merged into health.
 */
export async function ensureAdbRepair(snapshot, actions, { kill = defaultKillOrphanDaemon } = {}) {
  const wrongPortAliases = Array.isArray(snapshot?.adb?.wrongPortAliases) ? snapshot.adb.wrongPortAliases : [];
  if (wrongPortAliases.length === 0) return { status: "none", aliases: [] };
  if (snapshot.activeLeases > 0 || snapshot.runningJobs > 0) {
    return { status: "blocked", reason: "active_work", aliases: wrongPortAliases };
  }
  log(`killing orphan ADB daemon on 5037 to return ${wrongPortAliases.join(",")} to 5038`);
  try {
    await kill();
    actions.push({ kind: "adb", action: "kill_orphan_daemon", port: "5037", aliases: wrongPortAliases });
    return { status: "repaired", aliases: wrongPortAliases };
  } catch (error) {
    actions.push({
      kind: "adb", action: "kill_orphan_daemon_failed", port: "5037", aliases: wrongPortAliases, error: error.message,
    });
    return { status: "failed", reason: error.message, aliases: wrongPortAliases };
  }
}

function chooseActor(explicit, controlHealth) {
  if (explicit) return explicit;
  const fromEnv = String(process.env.XHS_ACTOR || "").trim();
  if (fromEnv) return fromEnv;
  const actors = controlHealth?.policyMode?.pilotActors || [];
  if (controlHealth?.policyMode?.pilotOnly === true && actors.length === 1) return actors[0];
  return "xw-start";
}

async function main(argv = process.argv.slice(2)) {
  const options = parseXwStartArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const gate = await releaseGate();
  const initial = await inspect({ aliases: options.aliases, gate });
  const plan = buildXwStartPlan(initial, { aliases: options.aliases });
  if (options.check) {
    const blockers = Number(initial.activeBlockers) || 0;
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: "check",
      ready: plan.mutationCount === 0 && plan.blockerCount === 0,
      adbOk: plan.adb?.ok === true,
      allHealthy: plan.mutationCount === 0 && plan.blockerCount === 0 && plan.adb?.ok === true && blockers === 0,
      releaseGate: gate,
      adb: initial.adb,
      capabilityLimits: initial.capabilityLimits,
      plan,
    }, null, 2)}\n`);
    return;
  }
  if (!gate.ok) throw new Error(`release gate closed: ${gate.reason}`);

  const actions = [];
  await ensureBaseServices(initial, gate, actions);
  let current = await inspect({ aliases: options.aliases, gate });
  if (current.activeLeases > 0 || current.runningJobs > 0) throw new Error("active work present; start is fail-closed");
  const controlHealth = await fetchJson(CONTROL, "/control/v1/health");
  const actor = chooseActor(options.actor, controlHealth);
  const serveResults = [];
  const adbRepairResults = [];
  const recoveryResults = [];
  const readinessJobs = [];
  const cycles = [];
  const recoveryAttemptCounts = new Map();
  let finalSnapshot = current;
  for (let cycle = 1; cycle <= 2; cycle += 1) {
    const actionsBefore = actions.length;
    if (current.activeLeases > 0 || current.runningJobs > 0) {
      throw new Error("active work appeared during start convergence; stopping fail-closed");
    }
    const cyclePlan = buildXwStartPlan(current, { aliases: options.aliases });
    serveResults.push(...await ensureServes(current, options.aliases, actions));
    adbRepairResults.push(await ensureAdbRepair(current, actions));
    current = await inspect({ aliases: options.aliases, gate });
    recoveryResults.push(...await ensureRecoveries(current, options.aliases, actor, actions, recoveryAttemptCounts));
    current = await inspect({ aliases: options.aliases, gate });
    readinessJobs.push(...await ensureReadiness(current, options.aliases, actor, actions));
    finalSnapshot = await inspect({ aliases: options.aliases, gate });
    const cycleFinal = classifyXwStartFinal(finalSnapshot, { aliases: options.aliases });
    cycles.push({
      cycle,
      plannedMutations: cyclePlan.mutationCount,
      appliedActions: actions.length - actionsBefore,
      status: cycleFinal.status,
      readyAliases: cycleFinal.readyAliases,
      humanRequiredAliases: cycleFinal.humanRequiredAliases,
    });
    if (cycleFinal.ok || actions.length === actionsBefore) break;
    current = finalSnapshot;
  }
  const final = classifyXwStartFinal(finalSnapshot, { aliases: options.aliases });
  const output = {
    ok: final.ok,
    mode: "start",
    actor,
    plan,
    actions,
    convergence: { maxCycles: 2, cycles },
    adb: finalSnapshot.adb,
    serveResults,
    adbRepairResults,
    recoveryResults,
    readinessJobs,
    final: { ...final, blockerSummaries: finalSnapshot.blockerSummaries },
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!final.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, status: "BLOCKED", error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
