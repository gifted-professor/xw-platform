/**
 * Listener-owned M5 cleanup oracle for the XHS RPA manual-once bridge.
 *
 * It never releases a lease.  The formal R4 runner owns cleanup; this module
 * independently snapshots active StateStore lease identities around that one
 * aggregate and fails closed if any new/changed lease survives.  The dormant
 * recurring-task name is also queried through the fixed Windows binary with
 * shell execution disabled.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export const XHS_RPA_M5_RUNTIME_SCHEMA_ID = "xw.m5.task-plan-v2-runtime.v1";
export const XHS_RPA_RESERVED_RECURRING_TASK_NAME = "XW Platform XHS RPA Wake";
export const XHS_RPA_SCHTASKS_PATH = "C:\\Windows\\System32\\schtasks.exe";

const TICK_ID = /^tick_[0-9a-f]{32}$/u;
const LEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const ABSENT_TASK = /(?:cannot find|could not find|not exist|找不到|不存在)/iu;

function fail(code, message, details = {}) {
  throw Object.assign(new Error(`${code}: ${message}`), { code, details });
}

function exact(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key)));
}

function request(input, code) {
  if (!exact(input, ["tickId"]) || !TICK_ID.test(String(input.tickId ?? ""))) {
    fail(code, "lease audit accepts only one scheduler-issued opaque tickId");
  }
  return input.tickId;
}

function completeRequest(input) {
  if (!exact(input, ["tickId", "baselineLeaseHash"])
    || !TICK_ID.test(String(input.tickId ?? ""))
    || !/^[0-9a-f]{64}$/u.test(String(input.baselineLeaseHash ?? ""))) {
    fail("XHS_RPA_LEASE_AUDIT_INPUT_INVALID", "completion requires tickId plus listener-issued baseline hash");
  }
  return input;
}

function leaseIdentity(lease) {
  if (!lease || typeof lease !== "object" || Array.isArray(lease)
    || !LEASE_ID.test(String(lease.leaseId ?? ""))) {
    fail("XHS_RPA_LEASE_SNAPSHOT_INVALID", "StateStore returned a malformed active lease");
  }
  // Expiry/heartbeat are intentionally excluded: they may advance without
  // transferring ownership.  Every stable ownership dimension remains bound.
  return JSON.stringify({
    leaseId: lease.leaseId,
    deviceId: lease.deviceId ?? null,
    kind: lease.kind ?? null,
    holderId: lease.holderId ?? null,
    jobId: lease.jobId ?? null,
    ownerDeviceRunId: lease.ownerDeviceRunId ?? null,
  });
}

function snapshot(state) {
  let rows;
  try {
    rows = state.listLeases();
  } catch (error) {
    fail("XHS_RPA_LEASE_SNAPSHOT_UNAVAILABLE", "active leases could not be read", {
      causeCode: String(error?.code ?? "UNKNOWN"),
    });
  }
  if (!Array.isArray(rows)) {
    fail("XHS_RPA_LEASE_SNAPSHOT_INVALID", "StateStore lease snapshot is not an array");
  }
  const byId = new Map();
  for (const row of rows) {
    const identity = leaseIdentity(row);
    if (byId.has(row.leaseId)) fail("XHS_RPA_LEASE_SNAPSHOT_INVALID", "active lease ids are not unique");
    byId.set(row.leaseId, Object.freeze({ identity, row: Object.freeze({ ...row }) }));
  }
  return byId;
}

function diffOwned(baseline, current) {
  return Object.freeze([...current.values()]
    .filter(({ row, identity }) => baseline.get(row.leaseId)?.identity !== identity)
    .map(({ row }) => row));
}

function leaseSetHash(values) {
  const identities = [...values].map((value) => value.identity ?? leaseIdentity(value)).sort();
  return createHash("sha256").update(JSON.stringify(identities), "utf8").digest("hex");
}

/** Fixed, no-shell Windows Task Scheduler probe. */
export function queryFixedXhsRpaRecurringTask({
  spawnSyncFn = spawnSync,
  executablePath = XHS_RPA_SCHTASKS_PATH,
} = {}) {
  if (executablePath !== XHS_RPA_SCHTASKS_PATH || typeof spawnSyncFn !== "function") {
    fail("XHS_RPA_RECURRING_ORACLE_INVALID", "Task Scheduler oracle binary is not the fixed System32 path");
  }
  const result = spawnSyncFn(executablePath, [
    "/Query", "/TN", XHS_RPA_RESERVED_RECURRING_TASK_NAME, "/XML",
  ], {
    windowsHide: true,
    shell: false,
    timeout: 5_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result?.error) {
    fail("XHS_RPA_RECURRING_ORACLE_UNAVAILABLE", "Task Scheduler query failed to start", {
      causeCode: String(result.error.code ?? "UNKNOWN"),
    });
  }
  if (result?.status === 0) {
    const xml = Buffer.isBuffer(result.stdout)
      ? Buffer.from(result.stdout)
      : Buffer.from(String(result.stdout ?? ""), "utf8");
    if (xml.length < 2 || xml.length > 2 * 1024 * 1024) {
      fail("XHS_RPA_RECURRING_ORACLE_INVALID", "reserved task query returned malformed XML");
    }
    return Object.freeze([Object.freeze({
      taskName: XHS_RPA_RESERVED_RECURRING_TASK_NAME,
      xmlSha256: createHash("sha256").update(xml).digest("hex"),
    })]);
  }
  const diagnosticBytes = Buffer.concat([result?.stdout ? Buffer.from(result.stdout) : Buffer.alloc(0),
    Buffer.from("\n"), result?.stderr ? Buffer.from(result.stderr) : Buffer.alloc(0)]);
  const diagnostic = `${diagnosticBytes.toString("utf8")}\n${diagnosticBytes.toString("utf16le")}`;
  if (result?.status === 1 && ABSENT_TASK.test(diagnostic)) return Object.freeze([]);
  fail("XHS_RPA_RECURRING_ORACLE_UNAVAILABLE", "Task Scheduler could not prove reserved-task absence", {
    exitStatus: result?.status ?? null,
  });
}

/**
 * Create the exact collaborator consumed by the approved M5 bridge.  Tests may
 * inject only the fixed-name scheduler probe implementation at construction;
 * operation-time calls accept no path, task name, lease id, or release data.
 */
export function createXhsRpaM5RuntimeOracle({
  state,
  queryRecurringTask = queryFixedXhsRpaRecurringTask,
} = {}) {
  if (!state || typeof state.listLeases !== "function" || typeof queryRecurringTask !== "function") {
    fail("XHS_RPA_M5_RUNTIME_INVALID", "StateStore and recurring-task oracle are required");
  }
  const audits = new Map();

  function requireAudit(tickId) {
    const audit = audits.get(tickId);
    if (!audit) fail("XHS_RPA_LEASE_AUDIT_MISSING", "tick has no listener-owned pre-I/O lease snapshot");
    return audit;
  }

  return Object.freeze({
    schemaId: XHS_RPA_M5_RUNTIME_SCHEMA_ID,
    async beginLeaseAudit(input = {}) {
      const tickId = request(input, "XHS_RPA_LEASE_AUDIT_INPUT_INVALID");
      const prior = audits.get(tickId);
      if (prior) return Object.freeze({ ok: true, tickId, baselineLeaseHash: prior.baselineLeaseHash });
      const baseline = snapshot(state);
      const baselineLeaseHash = leaseSetHash(baseline.values());
      audits.set(tickId, { baseline, baselineLeaseHash, completed: false });
      return Object.freeze({ ok: true, tickId, baselineLeaseHash });
    },
    async completeLeaseAudit(input = {}) {
      const { tickId, baselineLeaseHash } = completeRequest(input);
      const audit = requireAudit(tickId);
      if (baselineLeaseHash !== audit.baselineLeaseHash) {
        fail("XHS_RPA_LEASE_AUDIT_REBOUND", "completion baseline differs from the listener-owned pre-I/O snapshot");
      }
      const owned = diffOwned(audit.baseline, snapshot(state));
      audit.completed = true;
      return Object.freeze({
        ok: true,
        tickId,
        baselineLeaseHash,
        freshLeaseCount: owned.length,
        freshLeaseHash: leaseSetHash(owned),
      });
    },
    async restoreOwnedResources(input = {}) {
      const tickId = request(input, "XHS_RPA_LEASE_AUDIT_INPUT_INVALID");
      const audit = requireAudit(tickId);
      if (!audit.completed) {
        fail("XHS_RPA_LEASE_AUDIT_INCOMPLETE", "post-R4 lease snapshot was not completed");
      }
      const owned = diffOwned(audit.baseline, snapshot(state));
      return Object.freeze({ restored: owned.length === 0, ownedLeaseCount: owned.length });
    },
    async listOwnedLeases(input = {}) {
      const tickId = request(input, "XHS_RPA_LEASE_AUDIT_INPUT_INVALID");
      const audit = requireAudit(tickId);
      if (!audit.completed) {
        fail("XHS_RPA_LEASE_AUDIT_INCOMPLETE", "post-R4 lease snapshot was not completed");
      }
      return diffOwned(audit.baseline, snapshot(state));
    },
    async listRecurringTasks() {
      const tasks = await queryRecurringTask();
      if (!Array.isArray(tasks)) {
        fail("XHS_RPA_RECURRING_ORACLE_INVALID", "recurring-task oracle did not return an array");
      }
      return Object.freeze(tasks.map((task) => Object.freeze({ ...task })));
    },
  });
}
