import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const EXECUTION_ID_RE = /^xe_[a-f0-9]{32}$/u;

export function defaultRoutineRunStoreRoot() {
  const runtimeRoot = process.env.XW_RUNTIME_ROOT
    || (process.platform === "win32" ? "C:\\Users\\Public\\xw-runtime" : resolve("xw-runtime"));
  return join(runtimeRoot, "state", "orchestrator", "xhs-routine-runs");
}

function storeError(code, message) {
  return Object.assign(new Error(message), { code });
}

function assertExecutionId(value) {
  const id = String(value || "");
  if (!EXECUTION_ID_RE.test(id)) throw storeError("ROUTINE_TRACE_ID_INVALID", "executionRunId is malformed");
  return id;
}

function tracePath(root, executionRunId) {
  return join(resolve(root), `${assertExecutionId(executionRunId)}.json`);
}

function assertNoSecretKeys(value, path = "trace") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretKeys(item, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    const lowered = key.toLowerCase();
    if (["token", "secret", "password", "credential"].some((word) => lowered.includes(word))) {
      throw storeError("ROUTINE_TRACE_SECRET_FORBIDDEN", `secret-bearing field is forbidden in trace: ${path}.${key}`);
    }
    assertNoSecretKeys(nested, `${path}.${key}`);
  }
}

export function writeRoutineTrace({ plan, routineRun, recordedAt = new Date().toISOString(), root = defaultRoutineRunStoreRoot() } = {}) {
  const executionRunId = assertExecutionId(routineRun?.executionRunId);
  if (!plan?.planHash || routineRun?.planHash !== plan.planHash) {
    throw storeError("ROUTINE_TRACE_BINDING_INVALID", "trace planHash does not match the routine run");
  }
  assertNoSecretKeys({ plan, routineRun });
  const directory = resolve(root);
  mkdirSync(directory, { recursive: true });
  const target = tracePath(directory, executionRunId);
  if (existsSync(target)) throw storeError("ROUTINE_TRACE_EXISTS", `trace already exists for ${executionRunId}`);
  const trace = {
    schemaId: "xw.xhs.routine-trace.v1",
    schemaVersion: 1,
    executionRunId,
    routineRunId: routineRun.routineRunId,
    planHash: plan.planHash,
    alias: routineRun.alias,
    status: routineRun.status,
    recordedAt,
    plan,
    routineRun,
  };
  const temp = join(directory, `.${executionRunId}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(trace, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return { path: target, trace };
}

export function readRoutineTrace(executionRunId, { root = defaultRoutineRunStoreRoot() } = {}) {
  const path = tracePath(root, executionRunId);
  let trace;
  try {
    trace = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw storeError(
      error?.code === "ENOENT" ? "ROUTINE_TRACE_NOT_FOUND" : "ROUTINE_TRACE_INVALID",
      error?.code === "ENOENT" ? `trace not found for ${executionRunId}` : `invalid trace: ${error?.message || error}`,
    );
  }
  if (trace?.schemaId !== "xw.xhs.routine-trace.v1"
    || trace?.schemaVersion !== 1
    || trace?.executionRunId !== executionRunId
    || trace?.routineRun?.executionRunId !== executionRunId
    || trace?.planHash !== trace?.plan?.planHash
    || trace?.planHash !== trace?.routineRun?.planHash) {
    throw storeError("ROUTINE_TRACE_INVALID", `trace binding is invalid for ${executionRunId}`);
  }
  return { path, trace };
}

export function listRoutineTraces({ root = defaultRoutineRunStoreRoot(), limit = 20 } = {}) {
  const bounded = Math.max(1, Math.min(Number(limit) || 20, 100));
  const directory = resolve(root);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^xe_[a-f0-9]{32}\.json$/u.test(entry.name))
    .map((entry) => {
      try {
        return readRoutineTrace(entry.name.slice(0, -5), { root: directory }).trace;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => String(right.recordedAt).localeCompare(String(left.recordedAt)))
    .slice(0, bounded)
    .map((trace) => ({
      executionRunId: trace.executionRunId,
      routineRunId: trace.routineRunId,
      planHash: trace.planHash,
      template: trace.plan?.template ?? null,
      alias: trace.alias,
      status: trace.status,
      serverVerified: trace.routineRun?.serverVerified === true,
      recordedAt: trace.recordedAt,
      stopReason: trace.routineRun?.receipt?.stopReason ?? null,
    }));
}
