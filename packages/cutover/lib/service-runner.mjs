// M3-R2 rehearsal 服务编排：在隔离目录、替代端口上启动/停止两个服务的子进程。
// 硬约束：不连真实设备、不取真实 lease、不提交真实 job、不碰 22222/ADB、不碰支付。
// 这些约束的来源：两个服务启动期本就没有任何设备/lease/job 主动行为（见 receipt.safetyNotes）。
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";

import { RELEASE_MANIFEST_FILENAME } from "../../release/lib/release-manifest.mjs";
import { httpGetJson, waitFor } from "./util.mjs";

export function buildControlPlaneLaunch({ mode, releaseDir = null, legacyRoot = null, dbPath, runsRoot, stateDir, port }) {
  const script = mode === "release"
    ? join(releaseDir, "services/control-plane/control-plane/server.mjs")
    : join(legacyRoot, "control-plane/server.mjs");
  const env = {
    ...process.env,
    CONTROL_PLANE_HOST: "127.0.0.1",
    CONTROL_PLANE_PORT: String(port),
    CONTROL_PLANE_DB: dbPath,
    CONTROL_PLANE_RUNS_ROOT: runsRoot,
    CONTROL_PLANE_STATE_DIR: stateDir,
  };
  if (mode === "release") env.XW_RELEASE_MANIFEST = join(releaseDir, RELEASE_MANIFEST_FILENAME);
  else delete env.XW_RELEASE_MANIFEST;
  return { command: process.execPath, args: [script, "serve"], env, cwd: mode === "release" ? releaseDir : legacyRoot };
}

export function buildOrchestratorLaunch({ mode, releaseDir = null, legacyRoot = null, dbPath, controlDbPath, runsRoot, stateDir, port, controlPort }) {
  const script = mode === "release"
    ? join(releaseDir, "services/orchestrator/registry.mjs")
    : join(legacyRoot, "registry.mjs");
  const args = [
    script,
    "--port", String(port),
    "--host", "127.0.0.1",
    "--control", `http://127.0.0.1:${controlPort}`,
    "--db", dbPath,
    "--control-db", controlDbPath,
    "--runs-root", runsRoot,
  ];
  const env = {
    ...process.env,
    CONTROL_PLANE_STATE_DIR: stateDir,
    CONTROL_PLANE_RUNS_ROOT: runsRoot,
  };
  if (mode === "release") env.XW_RELEASE_MANIFEST = join(releaseDir, RELEASE_MANIFEST_FILENAME);
  else delete env.XW_RELEASE_MANIFEST;
  return { command: process.execPath, args, env, cwd: mode === "release" ? releaseDir : legacyRoot };
}

export function spawnService(launch, logPath) {
  mkdirSync(join(logPath, ".."), { recursive: true });
  const log = createWriteStream(logPath, { flags: "a" });
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return { child, logPath };
}

export async function stopService(handle, { timeoutMs = 10000 } = {}) {
  const { child } = handle;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function healthAndSmoke({ name, baseUrl, healthPath, smokePaths, validateIdentity, httpGet = httpGetJson, timeoutMs = 30000 }) {
  const ready = await waitFor(async () => {
    const result = await httpGet(`${baseUrl}${healthPath}`, { timeoutMs: 1500 });
    if (!result.reachable || !result.body?.ok) return { ok: false };
    if (validateIdentity) {
      const problems = validateIdentity(result.body);
      if (problems.length) return { ok: false, problems };
    }
    return { ok: true, body: result.body };
  }, { timeoutMs });
  const smoke = [];
  for (const path of smokePaths) {
    const result = await httpGet(`${baseUrl}${path}`, { timeoutMs: 3000 });
    const body = result.body || {};
    const listKey = Object.keys(body).find((key) => Array.isArray(body[key]));
    smoke.push({
      endpoint: path,
      ok: result.reachable && result.status === 200,
      status: result.status,
      itemCount: listKey ? body[listKey].length : "unknown",
    });
  }
  return { name, health: ready.body, smoke };
}

export function releaseIdentityValidator(expected) {
  return (body) => {
    const problems = [];
    for (const [key, want] of Object.entries(expected)) {
      if (body[key] !== want) problems.push(`${key}: expected ${want}, got ${body[key] ?? null}`);
    }
    return problems;
  };
}

// 启动一整套（control-plane 先，orchestrator 后），health + 只读冒烟，然后关闭。
// 返回 { controlPlane, orchestrator, failed }；任何一步失败都会尽力关掉已启动的进程。
export async function runStack({
  controlLaunch,
  orchestratorLaunch,
  logDir,
  ports,
  identity = null,
  httpGet = httpGetJson,
  spawnImpl = spawnService,
  healthTimeoutMs = 45000,
}) {
  const records = { controlPlane: null, orchestrator: null, failed: null };
  const controlBase = `http://127.0.0.1:${ports.control}`;
  const orchestratorBase = `http://127.0.0.1:${ports.orchestrator}`;
  const controlHandle = spawnImpl(controlLaunch, join(logDir, "control-plane.log"));
  try {
    records.controlPlane = await healthAndSmoke({
      name: "control-plane",
      baseUrl: controlBase,
      healthPath: "/control/v1/health",
      smokePaths: ["/control/v1/devices", "/control/v1/capabilities", "/control/v1/leases"],
      validateIdentity: identity
        ? (body) => (body.authority !== true ? ["authority !== true"] : []).concat(releaseIdentityValidator(identity)(body))
        : (body) => (body.authority !== true ? ["authority !== true"] : []),
      httpGet,
      timeoutMs: healthTimeoutMs,
    });
  } catch (error) {
    records.failed = { stage: "control-plane", error: error.message };
    await stopService(controlHandle);
    return records;
  }
  const orchestratorHandle = spawnImpl(orchestratorLaunch, join(logDir, "orchestrator.log"));
  try {
    records.orchestrator = await healthAndSmoke({
      name: "orchestrator",
      baseUrl: orchestratorBase,
      healthPath: "/api/health",
      smokePaths: ["/api/devices", "/api/capabilities"],
      validateIdentity: identity ? releaseIdentityValidator(identity) : null,
      httpGet,
      timeoutMs: healthTimeoutMs,
    });
  } catch (error) {
    records.failed = { stage: "orchestrator", error: error.message };
  }
  await stopService(orchestratorHandle);
  await stopService(controlHandle);
  return records;
}

export function smokeSummary(stackRecords) {
  const out = { ok: stackRecords.failed === null };
  for (const name of ["controlPlane", "orchestrator"]) {
    const record = stackRecords[name];
    if (!record) {
      out[name] = { ok: false };
      continue;
    }
    out[name] = {
      ok: record.smoke.every((item) => item.ok),
      healthOk: record.health?.ok === true,
      smoke: record.smoke,
      identity: record.health
        ? {
            sourceRepo: record.health.sourceRepo ?? null,
            sourceCommit: record.health.sourceCommit ?? null,
            releaseId: record.health.releaseId ?? null,
            runtimeProfile: record.health.runtimeProfile ?? null,
          }
        : null,
    };
  }
  out.ok = out.ok && out.controlPlane.ok && out.orchestrator.ok;
  if (stackRecords.failed) out.failed = stackRecords.failed;
  return out;
}
