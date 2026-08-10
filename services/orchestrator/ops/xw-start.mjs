#!/usr/bin/env node
/**
 * Idempotent `/xw start` coordinator.
 *
 * Starts only missing infrastructure, reconciles stopped stale FastOperator
 * launch configs after exact release gates, and refreshes canonical device
 * readiness through formal R0 control-plane jobs. It never writes control.db,
 * calls a device operator directly, or executes an external-effect capability.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  XW_START_ALIASES,
  XW_START_READINESS_CAPABILITY,
  buildXwStartPlan,
  classifyXwStartFinal,
  normalizeStartAliases,
} from "../scripts/lib/xw-start.mjs";

const execFileAsync = promisify(execFile);
const REGISTRY = (process.env.XHS_REGISTRY_URL || "http://127.0.0.1:17930").replace(/\/$/, "");
const CONTROL = (process.env.XHS_CONTROL_URL || "http://127.0.0.1:17920").replace(/\/$/, "");
const ROUTING_ROOT = process.env.XHS_ROUTING_ROOT || "C:\\Users\\Public\\xhs-routing-v1-1";
const CONTROL_TASK = `${ROUTING_ROOT}\\scripts\\control-plane-task.ps1`;
const SERVE_TASK = `${ROUTING_ROOT}\\scripts\\fast-operator-serve-task.ps1`;
const TASK_LAUNCH = "C:\\Users\\Public\\xhs-agent-control\\task-launch.json";
const SERVE_STATE_ROOT = "C:\\Users\\Public\\xhs-agent-control\\fast-operator";
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
    throw new Error(`${code}: ${message}`);
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
  }]));
}

function activeBlockersFromEntry(entry) {
  if (Array.isArray(entry?.blockers)) return entry.blockers;
  return Array.isArray(entry?.blockers?.active) ? entry.blockers.active : [];
}

async function inspect({ aliases, gate = null } = {}) {
  const [registryTask, controlTask, registryHealthy, controlHealthy] = await Promise.all([
    registryTaskStatus(),
    runPowerShellScript(CONTROL_TASK, ["-Action", "Status"]),
    reachable(REGISTRY, "/api/health"),
    reachable(CONTROL, "/control/v1/health"),
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
  const activeBlockers = activeBlockersFromEntry(entry);
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
    serves,
    stateKnown: entry !== null,
    devices: devicesFromEntry(entry),
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
        results.push({ alias, status: "blocked", reason: "stale_running_serve" });
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

function chooseActor(explicit, controlHealth) {
  if (explicit) return explicit;
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
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: "check",
      ready: plan.mutationCount === 0 && plan.blockerCount === 0,
      releaseGate: gate,
      plan,
    }, null, 2)}\n`);
    return;
  }
  if (!gate.ok) throw new Error(`release gate closed: ${gate.reason}`);

  if (plan.mutationCount === 0) {
    const controlHealth = options.actor ? null : await fetchJson(CONTROL, "/control/v1/health");
    const actor = chooseActor(options.actor, controlHealth);
    const final = classifyXwStartFinal(initial, { aliases: options.aliases });
    process.stdout.write(`${JSON.stringify({
      ok: final.ok,
      mode: "start",
      actor,
      plan,
      actions: [],
      serveResults: options.aliases.map((alias) => ({
        alias,
        status: plan.services.serves[alias]?.reason === "listening" ? "ready" : "blocked",
        action: "none",
        ...(plan.services.serves[alias]?.reason === "listening" ? {} : { reason: plan.services.serves[alias]?.reason || "unknown" }),
      })),
      readinessJobs: [],
      final: { ...final, blockerSummaries: initial.blockerSummaries },
    }, null, 2)}\n`);
    if (!final.ok) process.exitCode = 1;
    return;
  }

  const actions = [];
  await ensureBaseServices(initial, gate, actions);
  let current = await inspect({ aliases: options.aliases, gate });
  if (current.activeLeases > 0 || current.runningJobs > 0) throw new Error("active work present; start is fail-closed");
  const serveResults = await ensureServes(current, options.aliases, actions);
  current = await inspect({ aliases: options.aliases, gate });
  const controlHealth = await fetchJson(CONTROL, "/control/v1/health");
  const actor = chooseActor(options.actor, controlHealth);
  const readinessJobs = await ensureReadiness(current, options.aliases, actor, actions);
  const finalSnapshot = await inspect({ aliases: options.aliases, gate });
  const final = classifyXwStartFinal(finalSnapshot, { aliases: options.aliases });
  const output = {
    ok: final.ok,
    mode: "start",
    actor,
    plan,
    actions,
    serveResults,
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
