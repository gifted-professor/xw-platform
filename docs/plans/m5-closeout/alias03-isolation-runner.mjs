#!/usr/bin/env node
// M5 closeout: one-shot alias 03 serve-stop isolation acceptance runner.
// Composes only existing public modules; does not modify the repo or device capabilities.
// Fault model: wraps worker.execute(assignment). When the first alias "03" assignment
// arrives, its WorkerAssigned/SkillStarted trace events are already persisted by
// task-orchestrator.mjs (traceBridge.skillStarted(...) -> worker.execute(...) on adjacent
// lines). The wrapper stops scheduled task 'XW Platform FastOperator 03' and confirms
// port 17898 is no longer listening BEFORE delegating to the real worker, so the real
// worker still submits the formal job against a stopped serve. The serve stays stopped
// for the whole mission (retries re-assert the stop). finally{} always restores the task.
//
// Usage:
//   node alias03-isolation-runner.mjs --run <closeout-run-id> --trace-id <id> --actor <actor>
//       [--goal <text>] [--aliases 01,02,03,04] [--evidence-dir <dir>]

import { writeFileSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

// This file is executed from a runtime evidence directory, so all repository
// modules are imported dynamically against an explicit repo root.
const REPO_ROOT = resolve(process.env.XW_REPO_ROOT || required(process.argv.slice(2), "--repo-root"));
async function repoModule(rel) {
  return import(pathToFileURL(join(REPO_ROOT, rel)).href);
}
const { OrchestrationStore } = await repoModule("services/orchestrator/scripts/lib/orchestration-store.mjs");
const { ControlPlaneHttpClient, TypedJobWorker } = await repoModule("services/orchestrator/scripts/lib/typed-job-worker.mjs");
const { MissionWorkerRouter, SessionWorkflowWorker } = await repoModule("services/orchestrator/scripts/lib/session-workflow-worker.mjs");
const { executeM5Goal } = await repoModule("services/orchestrator/scripts/lib/m5-orchestration-runtime.mjs");
const { loadLiveFleet, reconcileLiveCapabilityCatalog } = await repoModule("services/orchestrator/ops/xw-mission.mjs");
const { TraceStore } = await repoModule("packages/harness-protocol/lib/trace-store.mjs");
const { acquireExplorerSession, releaseExplorerSession } = await repoModule("services/orchestrator/ops/_explore-lease.mjs");
const { executeExplorerSessionAction } = await repoModule("services/orchestrator/ops/_explore-session-action.mjs");

const execFileAsync = promisify(execFile);
const RUNTIME_ROOT = resolve(process.env.XW_RUNTIME_ROOT || "C:\\Users\\Public\\xw-runtime");
const WORK_ROOT = join(RUNTIME_ROOT, "state", "orchestrator", "outbox", "work");
const TASK_NAME = "XW Platform FastOperator 03";
const PORT_03 = 17898;
const STOP_CONFIRM_BUDGET_MS = 15000;
const PORT_POLL_MS = 100;
const MISSION_BUDGET_MS = 120000;
const RESTORE_CONFIRM_BUDGET_MS = 30000;
const FOCUS_HANDOFF_BUDGET_MS = 2000;
const XHS_FOCUS = { package: "com.xingin.xhs", activity: /index\.v2\.IndexActivityV2/ };

function option(argv, name, fallback = undefined) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}
function required(argv, name) {
  const value = option(argv, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const mono = () => Number(process.hrtime.bigint()) / 1e6; // monotonic ms

async function ps(command) {
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { timeout: 30000 });
  return String(stdout).trim();
}

async function portListening() {
  const out = await ps(`if (Get-NetTCPConnection -LocalPort ${PORT_03} -State Listen -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`);
  return out === "yes";
}

async function stopServe03(evidence) {
  await ps(`Stop-ScheduledTask -TaskName '${TASK_NAME}'`);
  evidence.stopIssuedAt = { mono: mono(), iso: new Date().toISOString() };
  const deadline = mono() + STOP_CONFIRM_BUDGET_MS;
  while (mono() < deadline) {
    if (!(await portListening())) {
      evidence.portClosedAt = { mono: mono(), iso: new Date().toISOString() };
      return;
    }
    await new Promise((r) => setTimeout(r, PORT_POLL_MS));
  }
  throw new Error(`port ${PORT_03} still listening ${STOP_CONFIRM_BUDGET_MS}ms after Stop-ScheduledTask`);
}

async function restoreServe03(evidence) {
  await ps(`Start-ScheduledTask -TaskName '${TASK_NAME}'`);
  evidence.startIssuedAt = { mono: mono(), iso: new Date().toISOString() };
  const deadline = mono() + RESTORE_CONFIRM_BUDGET_MS;
  while (mono() < deadline) {
    if (await portListening()) {
      evidence.portRestoredAt = { mono: mono(), iso: new Date().toISOString() };
      return true;
    }
    await new Promise((r) => setTimeout(r, PORT_POLL_MS));
  }
  return false;
}

// Prove one alias' XHS foreground via a formal Explorer session/lease; the session
// is always released in finally. Returns captured focus evidence.
async function proveAliasFocus(alias, actorId) {
  const proof = { alias };
  const { path: contextPath } = await acquireExplorerSession({ alias, actor: actorId });
  try {
    const result = await executeExplorerSessionAction({ contextPath, params: { primitive: "focus" } });
    proof.focus = { package: result.output?.package ?? null, activity: result.output?.activity ?? null };
    proof.readAt = { mono: mono(), iso: new Date().toISOString() };
    if (proof.focus.package !== XHS_FOCUS.package || !XHS_FOCUS.activity.test(String(proof.focus.activity || ""))) {
      throw Object.assign(new Error(`alias ${alias} focus is not XHS index: ${JSON.stringify(proof.focus)}`), { code: "M5_DRILL_FOCUS_MISMATCH" });
    }
    return proof;
  } finally {
    await releaseExplorerSession({ contextPath }).catch((error) => {
      proof.releaseError = error?.message || String(error);
    });
    proof.releasedAt = { mono: mono(), iso: new Date().toISOString() };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const taskRunId = required(argv, "--run");
  const traceId = required(argv, "--trace-id");
  const actorId = required(argv, "--actor");
  const goal = option(argv, "--goal", "四台机器各刷一次首页并汇总卡片数");
  const aliases = String(option(argv, "--aliases", "01,02,03,04")).split(/[,:\s]+/).filter(Boolean);
  const evidenceDir = required(argv, "--evidence-dir");
  mkdirSync(evidenceDir, { recursive: true });

  const registryUrl = "http://127.0.0.1:17930/";
  const client = new ControlPlaneHttpClient({ baseUrl: "http://127.0.0.1:17920/" });
  const typedJobWorker = new TypedJobWorker({ client, actorId, pollMs: 1000 });
  const sessionWorkflowWorker = new SessionWorkflowWorker({ client, actorId, pollMs: 0 });
  const router = new MissionWorkerRouter({ typedJobWorker, sessionWorkflowWorker });

  const evidence = { taskName: TASK_NAME, port: PORT_03, alias03Attempts: 0, injections: [] };

  const wrappedWorker = {
    async execute(assignment) {
      if (assignment?.alias === "03") {
        evidence.alias03Attempts += 1;
        const injection = { attemptId: assignment.attemptId, attemptIndex: assignment.attemptIndex };
        evidence.injections.push(injection);
        // Keep 03 serve stopped for the whole mission, including safe retries.
        if (await portListening()) await stopServe03(evidence);
        injection.delegatingAt = { mono: mono(), iso: new Date().toISOString() };
      }
      return router.execute(assignment);
    },
  };

  const store = new OrchestrationStore({ taskRunId, workRoot: WORK_ROOT });
  const [registryCatalog, controlCatalogResponse] = await Promise.all([
    (async () => {
      const response = await fetch(new URL("api/capabilities", registryUrl), { signal: AbortSignal.timeout(10000) });
      const result = await response.json();
      if (!response.ok || result?.ok === false) throw new Error(result?.error?.message || `registry catalog failed ${response.status}`);
      return result;
    })(),
    client.getCapabilities(),
  ]);
  const liveCatalog = reconcileLiveCapabilityCatalog(
    registryCatalog,
    controlCatalogResponse?.capabilities || controlCatalogResponse?.data?.capabilities || [],
  );

  let missionResult = null;
  let missionError = null;
  let restored = false;

  // F3 precheck 6.1.3: formal Explorer-session focus proof on every alias, sessions
  // released in finally; then a fresh formal re-read right before dispatch. If any
  // alias focus mismatches, or the release->dispatch handoff exceeds 2s, abort
  // BEFORE executeM5Goal so no fault is ever injected.
  try {
    evidence.focusProofRound1 = [];
    for (const alias of aliases) evidence.focusProofRound1.push(await proveAliasFocus(alias, actorId));
    evidence.focusProofRound2 = [];
    for (const alias of aliases) evidence.focusProofRound2.push(await proveAliasFocus(alias, actorId));
    const lastReleaseMono = evidence.focusProofRound2[evidence.focusProofRound2.length - 1].releasedAt.mono;
    evidence.dispatchHandoffMs = mono() - lastReleaseMono;
    if (evidence.dispatchHandoffMs > FOCUS_HANDOFF_BUDGET_MS) {
      throw Object.assign(new Error(`focus handoff ${evidence.dispatchHandoffMs.toFixed(1)}ms exceeds ${FOCUS_HANDOFF_BUDGET_MS}ms budget`), { code: "M5_DRILL_HANDOFF_EXCEEDED" });
    }
  } catch (error) {
    // Abort before dispatch: no fault was injected; verify 03 serve is still up as a safeguard.
    restored = await portListening().catch(() => false);
    if (!restored) restored = await restoreServe03(evidence).catch(() => false);
    evidence.abortedBeforeDispatch = true;
    const output = { ok: false, restored, evidence, missionError: { code: error?.code || "M5_DRILL_ABORTED", message: error?.message || String(error) }, result: null };
    writeFileSync(join(evidenceDir, "alias03-isolation-result.json"), JSON.stringify(output, null, 2));
    console.log(JSON.stringify(output, null, 2));
    process.exit(4);
  }

  try {
    const mission = executeM5Goal({
      goal,
      aliases,
      traceId,
      taskRunId,
      liveCatalog,
      fleetProvider: () => loadLiveFleet({ registryUrl }),
      worker: wrappedWorker,
      store,
      traceStore: new TraceStore(),
    });
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error("mission budget exceeded"), { code: "M5_DRILL_TIMEOUT" })), MISSION_BUDGET_MS),
    );
    missionResult = await Promise.race([mission, timeout]);
  } catch (error) {
    missionError = { code: error?.code || "M5_DRILL_FAILED", message: error?.message || String(error) };
  } finally {
    restored = await restoreServe03(evidence);
  }

  const output = { ok: !missionError, restored, evidence, missionError, result: missionResult };
  writeFileSync(join(evidenceDir, "alias03-isolation-result.json"), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  if (!restored) {
    console.error("WARNING: alias 03 serve did not restore within budget; run formal xw-start recovery");
    process.exit(3);
  }
  if (missionError) process.exit(2);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: { code: error?.code || "M5_DRILL_RUNNER_FAILED", message: error?.message || String(error) } }, null, 2));
  process.exit(1);
});
