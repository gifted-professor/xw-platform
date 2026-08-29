import assert from "node:assert/strict";
import test from "node:test";

import {
  XHS_RPA_M5_RUNTIME_SCHEMA_ID,
  XHS_RPA_RESERVED_RECURRING_TASK_NAME,
  XHS_RPA_SCHTASKS_PATH,
  createXhsRpaM5RuntimeOracle,
  queryFixedXhsRpaRecurringTask,
} from "../control-plane/lib/xhs-rpa-m5-runtime.mjs";

const TICK = `tick_${"a".repeat(32)}`;

function lease(leaseId, holderId) {
  return {
    leaseId,
    deviceId: `device-${leaseId}`,
    kind: "exclusive",
    holderId,
    jobId: null,
    expiresAt: "2030-01-01T00:01:00.000Z",
    heartbeatAt: "2030-01-01T00:00:00.000Z",
  };
}

test("listener lease audit attributes only new/changed active identities to one RPA tick", async () => {
  let rows = [lease("lease-unrelated", "other-owner")];
  const runtime = createXhsRpaM5RuntimeOracle({
    state: { listLeases: () => structuredClone(rows) },
    queryRecurringTask: async () => [],
  });
  assert.equal(runtime.schemaId, XHS_RPA_M5_RUNTIME_SCHEMA_ID);
  const begun = await runtime.beginLeaseAudit({ tickId: TICK });
  assert.deepEqual(begun, {
    ok: true,
    tickId: TICK,
    baselineLeaseHash: begun.baselineLeaseHash,
  });
  assert.match(begun.baselineLeaseHash, /^[0-9a-f]{64}$/u);

  // Heartbeat/expiry drift is not ownership transfer and stays unrelated.
  rows[0].heartbeatAt = "2030-01-01T00:00:01.000Z";
  rows.push(lease("lease-created-by-r4", "r4-owner"));
  const completed = await runtime.completeLeaseAudit({
    tickId: TICK,
    baselineLeaseHash: begun.baselineLeaseHash,
  });
  assert.deepEqual(completed, {
    ok: true,
    tickId: TICK,
    baselineLeaseHash: begun.baselineLeaseHash,
    freshLeaseCount: 1,
    freshLeaseHash: completed.freshLeaseHash,
  });
  assert.match(completed.freshLeaseHash, /^[0-9a-f]{64}$/u);
  assert.equal((await runtime.listOwnedLeases({ tickId: TICK }))[0].leaseId, "lease-created-by-r4");
  assert.deepEqual(await runtime.restoreOwnedResources({ tickId: TICK }), {
    restored: false,
    ownedLeaseCount: 1,
  });

  rows = rows.filter((row) => row.leaseId !== "lease-created-by-r4");
  assert.deepEqual(await runtime.restoreOwnedResources({ tickId: TICK }), {
    restored: true,
    ownedLeaseCount: 0,
  });
  assert.deepEqual(await runtime.listOwnedLeases({ tickId: TICK }), []);
  assert.deepEqual(await runtime.beginLeaseAudit({ tickId: TICK }), begun);
});

test("lease audit rejects missing baselines, caller fields, duplicate ids and identity takeover", async () => {
  let rows = [lease("lease-one", "unrelated")];
  const runtime = createXhsRpaM5RuntimeOracle({
    state: { listLeases: () => structuredClone(rows) },
    queryRecurringTask: async () => [],
  });
  await assert.rejects(
    () => runtime.listOwnedLeases({ tickId: TICK }),
    (error) => error.code === "XHS_RPA_LEASE_AUDIT_MISSING",
  );
  await assert.rejects(
    () => runtime.beginLeaseAudit({ tickId: TICK, leaseId: "caller" }),
    (error) => error.code === "XHS_RPA_LEASE_AUDIT_INPUT_INVALID",
  );
  const begun = await runtime.beginLeaseAudit({ tickId: TICK });
  rows[0].holderId = "r4-takeover";
  assert.equal((await runtime.completeLeaseAudit({
    tickId: TICK,
    baselineLeaseHash: begun.baselineLeaseHash,
  })).freshLeaseCount, 1);
  await assert.rejects(
    () => runtime.completeLeaseAudit({ tickId: TICK, baselineLeaseHash: "0".repeat(64) }),
    (error) => error.code === "XHS_RPA_LEASE_AUDIT_REBOUND",
  );

  rows = [lease("same-id", "one"), lease("same-id", "two")];
  const duplicate = createXhsRpaM5RuntimeOracle({
    state: { listLeases: () => structuredClone(rows) },
    queryRecurringTask: async () => [],
  });
  await assert.rejects(
    () => duplicate.beginLeaseAudit({ tickId: TICK }),
    (error) => error.code === "XHS_RPA_LEASE_SNAPSHOT_INVALID",
  );
});

test("reserved recurring task query uses fixed schtasks path/name with shell disabled", () => {
  let call;
  const present = queryFixedXhsRpaRecurringTask({
    spawnSyncFn(executable, args, options) {
      call = { executable, args, options };
      return { status: 0, stdout: Buffer.from("<Task></Task>", "utf8"), stderr: Buffer.alloc(0) };
    },
  });
  assert.equal(call.executable, XHS_RPA_SCHTASKS_PATH);
  assert.deepEqual(call.args, ["/Query", "/TN", XHS_RPA_RESERVED_RECURRING_TASK_NAME, "/XML"]);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.deepEqual(present.map((row) => row.taskName), [XHS_RPA_RESERVED_RECURRING_TASK_NAME]);
  assert.match(present[0].xmlSha256, /^[0-9a-f]{64}$/u);

  const absent = queryFixedXhsRpaRecurringTask({
    spawnSyncFn: () => ({
      status: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("ERROR: The system cannot find the file specified.", "utf8"),
    }),
  });
  assert.deepEqual(absent, []);
  assert.throws(
    () => queryFixedXhsRpaRecurringTask({
      spawnSyncFn: () => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("Access is denied") }),
    }),
    (error) => error.code === "XHS_RPA_RECURRING_ORACLE_UNAVAILABLE",
  );
});
