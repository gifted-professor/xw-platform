// xw-xhs-routine-accept.test.mjs — offline tests for the read-only acceptance
// tool (plan V2 §5.3): before/after snapshotting, authoritative run-store
// trace binding, lease-delta and cleanup assertions, and the wave receipt.
// All authorities are fakes via XW_RUNTIME_ROOT + a stubbed snapshot; zero
// device I/O and no real CP/Registry contact.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cmdBeforeForTest, cmdAfterForTest } from "../ops/xw-xhs-routine-accept.mjs";

function withRuntimeRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "xhs-accept-"));
  process.env.XW_RUNTIME_ROOT = root;
  return Promise.resolve(fn(root)).finally(() => {
    delete process.env.XW_RUNTIME_ROOT;
    rmSync(root, { recursive: true, force: true });
  });
}

/** Stub the fleet snapshot authority so tests never touch loopback HTTP. */
function stubSnapshot(leases) {
  const real = cmdBeforeForTest.snapshotImpl;
  cmdBeforeForTest.snapshotImpl = async ({ aliases }) => ({
    capturedAt: "2026-08-28T00:00:00.000Z",
    aliases,
    globalActiveLeases: leases.length,
    leasesByAlias: Object.fromEntries(aliases.map((alias) => [
      alias,
      leases.filter((l) => l.alias === alias).map((l) => l.leaseId),
    ])),
    leaseIds: leases.map((l) => l.leaseId).sort(),
  });
  return () => { cmdBeforeForTest.snapshotImpl = real; };
}

function seedTrace(root, {
  executionRunId,
  status = "SUCCEEDED",
  cleanup = null,
  primitiveTrace = null,
  alias = "03",
  leaseId = "lease-03",
}) {
  const plan = {
    planHash: "a".repeat(64),
    template: "xhs.feed-play.v1",
    alias,
    schemaId: "xw.xhs.routine-plan.v1",
    schemaVersion: 1,
    ok: true,
  };
  const routineRun = {
    executionRunId,
    routineRunId: `rr_${"b".repeat(16)}`,
    planHash: plan.planHash,
    alias,
    leaseId,
    status,
    serverVerified: status === "SUCCEEDED",
    receipt: {
      stopReason: status === "SUCCEEDED" ? "ITEMS_BOUND_REACHED" : "CLEANUP_NOT_VERIFIED",
      cleanup: cleanup ?? {
        verified: status === "SUCCEEDED",
        activeLeases: status === "SUCCEEDED" ? 0 : 1,
        restored: status === "SUCCEEDED",
        authorityRef: "control-plane:StateStore.listLeases",
      },
    },
    primitiveTrace,
  };
  const dir = join(root, "state", "orchestrator", "xhs-routine-runs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${executionRunId}.json`),
    `${JSON.stringify({
      schemaId: "xw.xhs.routine-trace.v1",
      schemaVersion: 1,
      executionRunId,
      routineRunId: routineRun.routineRunId,
      planHash: plan.planHash,
      alias,
      status,
      recordedAt: "2026-08-28T00:00:00.000Z",
      plan,
      routineRun,
    }, null, 2)}\n`,
  );
  return routineRun;
}

test("before persists a snapshot; after binds it and emits a PASS receipt for a clean run", async () => {
  await withRuntimeRoot(async (root) => {
    const restore = stubSnapshot([{ leaseId: "lease-03", alias: "03" }]);
    try {
      await cmdBeforeForTest({ wave: "S1", aliases: ["03"] });
      assert.ok(existsSync(join(root, "state", "orchestrator", "xhs-routine-acceptance", "S1-before.json")));

      const executionRunId = `xe_${"c".repeat(32)}`;
      seedTrace(root, {
        executionRunId,
        primitiveTrace: [{ seq: 1, primitive: "focus", jobId: "job-1", status: "succeeded", outputOk: true, evidenceRef: "run-1" }],
      });
      // clean run: the run lease is gone after the run
      const restoreAfter = stubSnapshot([]);
      const result = await cmdAfterForTest({ wave: "S1", runId: executionRunId, aliases: ["03"] });
      assert.equal(result.ok, true);
      assert.equal(result.verdict, "PASS");
      assert.equal(result.assertions.cleanupVerified, true);
      assert.equal(result.assertions.ownedLeaseReleased, true);
      assert.equal(result.assertions.primitiveTracePresent, true);
      const receipt = JSON.parse(readFileSync(
        join(root, "state", "orchestrator", "xhs-routine-acceptance", `S1-${executionRunId}-receipt.json`),
        "utf8",
      ));
      assert.equal(receipt.schemaId, "xw.xhs.routine-live-wave-receipt.v1");
      assert.equal(receipt.primitives[0].jobId, "job-1");
      restoreAfter();
    } finally {
      restore();
    }
  });
});

test("after fails closed when the run lease survives or cleanup is unverified", async () => {
  await withRuntimeRoot(async (root) => {
    const restore = stubSnapshot([{ leaseId: "lease-03", alias: "03" }]);
    try {
      await cmdBeforeForTest({ wave: "S2", aliases: ["03"] });
      const executionRunId = `xe_${"d".repeat(32)}`;
      seedTrace(root, {
        executionRunId,
        status: "BLOCKED",
        cleanup: { verified: false, activeLeases: 1, restored: false, authorityRef: "cp" },
        primitiveTrace: [{ seq: 1, primitive: "focus", jobId: "job-1", status: "succeeded", outputOk: true, evidenceRef: null }],
      });
      // lease still active after the run
      const result = await cmdAfterForTest({ wave: "S2", runId: executionRunId, aliases: ["03"] });
      assert.equal(result.ok, false);
      assert.equal(result.verdict, "FAIL");
      assert.equal(result.assertions.runSucceeded, false);
      assert.equal(result.assertions.cleanupVerified, false);
      assert.equal(result.assertions.ownedLeaseReleased, false);
    } finally {
      restore();
    }
  });
});

test("a lease that appears after 'before' and is not the run's own is a hard new-lease delta", async () => {
  await withRuntimeRoot(async (root) => {
    const restore = stubSnapshot([]);
    try {
      await cmdBeforeForTest({ wave: "S3", aliases: ["03"] });
      const executionRunId = `xe_${"e".repeat(32)}`;
      seedTrace(root, { executionRunId, leaseId: "lease-03" });
      const restoreAfter = stubSnapshot([{ leaseId: "lease-foreign", alias: "03" }]);
      const result = await cmdAfterForTest({ wave: "S3", runId: executionRunId, aliases: ["03"] });
      restoreAfter();
      assert.equal(result.ok, false);
      assert.equal(result.assertions.noNewLeases, false);
      // the run lease itself is released, but a foreign lease appeared
      assert.equal(result.assertions.ownedLeaseReleased, true);
    } finally {
      restore();
    }
  });
});

test("missing before snapshot or malformed run id fails closed with a stable code", async () => {
  await withRuntimeRoot(async () => {
    await assert.rejects(
      cmdAfterForTest({ wave: "S4", runId: `xe_${"f".repeat(32)}`, aliases: ["03"] }),
      (error) => error.code === "ACCEPT_BEFORE_SNAPSHOT_MISSING",
    );
  });
});

test("after stamps releaseIdentity (flags beat XW_RELEASE_MANIFEST; identity absent stays null)", async () => {
  await withRuntimeRoot(async (root) => {
    const restore = stubSnapshot([]);
    const prevManifest = process.env.XW_RELEASE_MANIFEST;
    try {
      await cmdBeforeForTest({ wave: "S1", aliases: ["03"] });
      const executionRunId = `xe_${"1".repeat(32)}`;
      seedTrace(root, { executionRunId, primitiveTrace: [{ seq: 1, primitive: "focus", jobId: "job-1", status: "succeeded", outputOk: true, evidenceRef: null }] });
      // 1. identity absent: receipt carries releaseIdentity:null (stale-refusal contract)
      let result = await cmdAfterForTest({ wave: "S1", runId: executionRunId, aliases: ["03"] });
      assert.equal(result.ok, true);
      let disk = JSON.parse(readFileSync(result.receiptPath, "utf8"));
      assert.equal(disk.releaseIdentity, null);

      // 2. XW_RELEASE_MANIFEST provides the identity
      const manifestPath = join(root, "release-manifest.v1.json");
      writeFileSync(manifestPath, `${JSON.stringify({ releaseId: "xw-xhs-routine-b4-test-manifest", sourceCommit: "abc1234567890" })}\n`);
      process.env.XW_RELEASE_MANIFEST = manifestPath;
      result = await cmdAfterForTest({ wave: "S1", runId: executionRunId, aliases: ["03"] });
      disk = JSON.parse(readFileSync(result.receiptPath, "utf8"));
      assert.deepEqual(disk.releaseIdentity, { releaseId: "xw-xhs-routine-b4-test-manifest", sourceCommit: "abc1234567890" });

      // 3. explicit flags beat the manifest
      result = await cmdAfterForTest({ wave: "S1", runId: executionRunId, aliases: ["03"], releaseId: "xw-xhs-routine-b4-8aaba01", sourceCommit: "8aaba01bcbb2e7109d9b42e80dd319da74b91c81" });
      disk = JSON.parse(readFileSync(result.receiptPath, "utf8"));
      assert.deepEqual(disk.releaseIdentity, { releaseId: "xw-xhs-routine-b4-8aaba01", sourceCommit: "8aaba01bcbb2e7109d9b42e80dd319da74b91c81" });
    } finally {
      if (prevManifest === undefined) delete process.env.XW_RELEASE_MANIFEST;
      else process.env.XW_RELEASE_MANIFEST = prevManifest;
      restore();
    }
  });
});

test("parallel-batch acceptance asserts lanes, not the single-run cleanup shape", async () => {
  await withRuntimeRoot(async (root) => {
    const restore = stubSnapshot([{ leaseId: "lease-03", alias: "03" }]);
    try {
      await cmdBeforeForTest({ wave: "PARALLEL", aliases: ["03", "04"] });
      const executionRunId = `xe_${"2".repeat(32)}`;
      // seed a parallel-batch trace: parent cleanup.verified, two lanes, no
      // parent primitiveTrace (parallel receipts never carry one)
      const dir = join(root, "state", "orchestrator", "xhs-routine-runs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${executionRunId}.json`), `${JSON.stringify({
        schemaId: "xw.xhs.routine-trace.v1",
        schemaVersion: 1,
        executionRunId,
        routineRunId: `rr_${"c".repeat(16)}`,
        planHash: "a".repeat(64),
        alias: "03",
        status: "SUCCEEDED",
        recordedAt: "2026-08-29T00:00:00.000Z",
        plan: { planHash: "a".repeat(64), template: "xhs.feed-play.v1", alias: "03" },
        routineRun: {
          schemaId: "xw.xhs.routine-parallel-receipt.v1",
          mode: "parallel-batch",
          executionRunId,
          routineRunId: `rr_${"c".repeat(16)}`,
          planHash: "a".repeat(64),
          alias: "03",
          aliases: ["03", "04"],
          status: "SUCCEEDED",
          serverVerified: true,
          leaseId: null,
          receipt: {
            schemaId: "xw.xhs.routine-parallel-receipt.v1",
            cleanup: { verified: true },
            children: [
              { alias: "03", routineRunId: "rr_c1", status: "SUCCEEDED", opened: 1 },
              { alias: "04", routineRunId: "rr_c2", status: "SUCCEEDED", opened: 1 },
            ],
          },
        },
      }, null, 2)}\n`);
      const restoreAfter = stubSnapshot([]);
      const result = await cmdAfterForTest({ wave: "PARALLEL", runId: executionRunId, aliases: ["03", "04"] });
      restoreAfter();
      assert.equal(result.ok, true, JSON.stringify(result.assertions ?? {}));
      assert.equal(result.assertions.cleanupVerified, true);
      assert.equal(result.assertions.childLanesSucceeded, true);
      assert.equal(result.assertions.primitiveTracePresent, true);

      // one failed lane -> FAIL
      const bad = JSON.parse(readFileSync(join(dir, `${executionRunId}.json`), "utf8"));
      bad.routineRun.receipt.children[1].status = "FAILED";
      bad.routineRun.receipt.cleanup.verified = false;
      bad.routineRun.status = "BLOCKED";
      bad.routineRun.serverVerified = false;
      writeFileSync(join(dir, `${executionRunId}.json`), JSON.stringify(bad, null, 2));
      const failResult = await cmdAfterForTest({ wave: "PARALLEL", runId: executionRunId, aliases: ["03", "04"] });
      assert.equal(failResult.ok, false);
      assert.equal(failResult.assertions.childLanesSucceeded, false);
    } finally {
      restore();
    }
  });
});