/**
 * PR2 wiring closure — forces integrity metadata through the real chain:
 * Raw TaskPlan → Binder → ExecutionPlan → assignment.boundNode → TypedJobWorker → fake CP
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CAPABILITY_CONTRACT_HASH_ALGORITHM_V2 } from "../scripts/lib/capability-contract-hash.mjs";
import { computeImplementationClosureFromFiles } from "../scripts/lib/implementation-closure.mjs";
import { OrchestrationStore } from "../scripts/lib/orchestration-store.mjs";
import { recheckImplementationIntegrity } from "../scripts/lib/runtime-integrity.mjs";
import { runTaskOrchestrator } from "../scripts/lib/task-orchestrator.mjs";
import { createTaskPlanV2 } from "../scripts/lib/task-plan-v2.mjs";
import { TypedJobWorker } from "../scripts/lib/typed-job-worker.mjs";
import { bindFixturePlan } from "./helpers/bind-fixture-plan.mjs";

const contractA = "c".repeat(64);
const contractB = "d".repeat(64);
const closureA = "a".repeat(64);
const closureB = "b".repeat(64);

function makePlan(requestKey = "wiring-e2e") {
  return createTaskPlanV2({
    goal: "wiring e2e",
    requestKey,
    nodes: [{
      nodeId: "n1",
      executor: {
        kind: "typed_job",
        capabilityId: "xhs.observe.fixture",
        appId: "xhs",
        effectClass: "none",
        replaySafety: "read_only",
      },
      shards: [{ params: { keyword: "wiring" }, placement: { alias: "01" } }],
    }],
  });
}

function catalog(hashes) {
  return {
    "xhs.observe.fixture": {
      capabilityContractHash: hashes.contract,
      capabilityContractHashAlgorithm: CAPABILITY_CONTRACT_HASH_ALGORITHM_V2,
      implementationClosureHash: hashes.closure,
      packageName: "com.xingin.xhs",
      verification: { description: "foreground package must match" },
    },
  };
}

function fakeCp({ liveHashes, onSubmit, onGetJob } = {}) {
  const calls = { route: 0, submit: 0, getJob: 0 };
  const live = {
    id: "xhs.observe.fixture",
    appId: "xhs",
    packageName: "com.xingin.xhs",
    capabilityContractHash: liveHashes.contract,
    capabilityContractHashAlgorithm: CAPABILITY_CONTRACT_HASH_ALGORITHM_V2,
    implementationClosureHash: liveHashes.closure,
    verification: { description: "foreground package must match" },
  };
  return {
    calls,
    client: {
      async getCapabilities() {
        return { capabilities: [live] };
      },
      async routePlan(input) {
        calls.route += 1;
        return {
          route: {
            decision: "dispatchable",
            selectedDevice: { alias: input.placement.alias },
            activeLease: false,
            authorization: { decision: "allow", decisionId: "auth_wiring_1" },
          },
        };
      },
      async submitJob(input) {
        calls.submit += 1;
        if (onSubmit) return onSubmit(input);
        return {
          job: {
            jobId: "job_wiring_1",
            runId: "cp_run_wiring_1",
            status: "succeeded",
            authorization: { decisionId: "auth_wiring_1" },
            verification: { ok: true },
            restoration: { ok: true },
            output: { packageName: "com.xingin.xhs", items: [{ id: "1" }] },
          },
        };
      },
      async getJob(jobId) {
        calls.getJob += 1;
        if (onGetJob) return onGetJob(jobId);
        return {
          job: {
            jobId,
            runId: "cp_run_wiring_1",
            status: "succeeded",
            verification: { ok: true },
            restoration: { ok: true },
            output: { packageName: "com.xingin.xhs", items: [{ id: "1" }] },
          },
        };
      },
    },
  };
}

test("orchestrator rejects raw plan without ExecutionPlan (0 assignment)", async () => {
  const plan = makePlan("raw-bypass");
  const root = mkdtempSync(join(tmpdir(), "wiring-raw-"));
  try {
    const store = new OrchestrationStore({ taskRunId: "run_raw", workRoot: root });
    let assignments = 0;
    await assert.rejects(
      () => runTaskOrchestrator({
        taskRunId: "run_raw",
        plan,
        executionPlan: null,
        fleetProvider: async () => [{ alias: "01", online: true, ready: true, lease: "free", capabilityIds: ["xhs.observe.fixture"] }],
        worker: { async execute() { assignments += 1; throw new Error("must not run"); } },
        store,
      }),
      (e) => e.code === "EXECUTION_PLAN_REQUIRED",
    );
    assert.equal(assignments, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orchestrator rejects ExecutionPlan from another plan", async () => {
  const plan = makePlan("src-a");
  const other = makePlan("src-b");
  const { executionPlan } = bindFixturePlan(other, catalog({ contract: contractA, closure: closureA }));
  const root = mkdtempSync(join(tmpdir(), "wiring-mismatch-"));
  try {
    const store = new OrchestrationStore({ taskRunId: "run_mismatch", workRoot: root });
    await assert.rejects(
      () => runTaskOrchestrator({
        taskRunId: "run_mismatch",
        plan,
        executionPlan,
        fleetProvider: async () => [],
        worker: { async execute() { throw new Error("must not run"); } },
        store,
      }),
      (e) => e.code === "EXECUTION_PLAN_SOURCE_MISMATCH",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake CP E2E normal: bound=live → one submit → WorkReceipt v2", async () => {
  const plan = makePlan("e2e-ok");
  const bound = bindFixturePlan(plan, catalog({ contract: contractA, closure: closureA }));
  assert.equal(bound.executionPlan.nodes[0].capabilityContractHashAlgorithm, CAPABILITY_CONTRACT_HASH_ALGORITHM_V2);
  const { client, calls } = fakeCp({ liveHashes: { contract: contractA, closure: closureA } });
  const worker = new TypedJobWorker({ client, actorId: "wiring", pollMs: 0 });
  const root = mkdtempSync(join(tmpdir(), "wiring-ok-"));
  try {
    const store = new OrchestrationStore({ taskRunId: "run_ok", workRoot: root });
    const result = await runTaskOrchestrator({
      taskRunId: "run_ok",
      plan,
      ...bound,
      fleetProvider: async () => [{
        alias: "01", online: true, ready: true, lease: "free",
        quarantined: false, unresolvedFailure: null,
        capabilityIds: ["xhs.observe.fixture"],
      }],
      worker,
      store,
    });
    assert.equal(result.status, "completed");
    assert.equal(calls.submit, 1);
    assert.equal(calls.getJob, 0);
    const receipts = store.loadReceipts();
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].schemaId, "xhs.work-receipt.v2");
    assert.equal(receipts[0].capabilityContractHash, contractA);
    assert.equal(receipts[0].implementationClosureHash, closureA);
    assert.equal(receipts[0].capabilityContractHashAlgorithm, CAPABILITY_CONTRACT_HASH_ALGORITHM_V2);
    assert.equal(receipts[0].jobId, "job_wiring_1");
    assert.equal(receipts[0].controlPlaneRunId, "cp_run_wiring_1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake CP E2E pre-submit drift: submit=0 getJob=0 notSent v2", async () => {
  const plan = makePlan("e2e-drift");
  const bound = bindFixturePlan(plan, catalog({ contract: contractA, closure: closureA }));
  const { client, calls } = fakeCp({ liveHashes: { contract: contractA, closure: closureB } });
  const worker = new TypedJobWorker({ client, actorId: "wiring", pollMs: 0 });
  const root = mkdtempSync(join(tmpdir(), "wiring-drift-"));
  try {
    const store = new OrchestrationStore({ taskRunId: "run_drift", workRoot: root });
    const result = await runTaskOrchestrator({
      taskRunId: "run_drift",
      plan,
      ...bound,
      fleetProvider: async () => [{
        alias: "01", online: true, ready: true, lease: "free",
        quarantined: false, unresolvedFailure: null,
        capabilityIds: ["xhs.observe.fixture"],
      }],
      worker,
      store,
    });
    assert.equal(calls.submit, 0);
    assert.equal(calls.getJob, 0);
    assert.equal(calls.route, 0);
    const receipts = store.loadReceipts();
    assert.equal(receipts[0].schemaId, "xhs.work-receipt.v2");
    assert.equal(receipts[0].error.code, "IMPLEMENTATION_CONTRACT_CHANGED");
    assert.equal(receipts[0].error.notSent ?? receipts[0].error.details?.notSent, true);
    assert.equal(receipts[0].jobId, null);
    assert.equal(receipts[0].controlPlaneRunId, null);
    assert.ok(["failed", "partial", "blocked"].includes(result.status));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake CP E2E resume drift: getJob=0 submit=0 notSent", async () => {
  const plan = makePlan("e2e-resume");
  const bound = bindFixturePlan(plan, catalog({ contract: contractA, closure: closureA }));
  const { client, calls } = fakeCp({ liveHashes: { contract: contractA, closure: closureB } });
  const worker = new TypedJobWorker({ client, actorId: "wiring", pollMs: 0 });
  const assignment = {
    taskRunId: "run_resume",
    planHash: plan.planHash,
    executionPlanHash: bound.executionPlanHash,
    node: plan.nodes[0],
    boundNode: bound.executionPlan.nodes[0],
    shard: plan.nodes[0].shards[0],
    capabilityContractHash: contractA,
    implementationClosureHash: closureA,
    capabilityContractHashAlgorithm: CAPABILITY_CONTRACT_HASH_ALGORITHM_V2,
    operationKey: `m2:run_resume:${plan.nodes[0].shards[0].shardKey}`,
    alias: "01",
    workerId: "worker-1",
    attemptIndex: 0,
    attemptId: "attempt_resume_drift",
    resumeJobId: "job_already_there",
  };
  const receipt = await worker.execute(assignment);
  assert.equal(calls.submit, 0);
  assert.equal(calls.getJob, 0);
  assert.equal(receipt.schemaId, "xhs.work-receipt.v2");
  assert.equal(receipt.error.code, "IMPLEMENTATION_CONTRACT_CHANGED");
  assert.equal(receipt.error.notSent ?? receipt.error.details?.notSent, true);
  assert.equal(receipt.jobId, null);
  assert.equal(receipt.controlPlaneRunId, null);
});

test("assignment carries boundNode from orchestrator (not raw hashes)", async () => {
  const plan = makePlan("bound-node");
  const bound = bindFixturePlan(plan, catalog({ contract: contractA, closure: closureA }));
  const root = mkdtempSync(join(tmpdir(), "wiring-bound-"));
  try {
    const store = new OrchestrationStore({ taskRunId: "run_bound", workRoot: root });
    let seen = null;
    await runTaskOrchestrator({
      taskRunId: "run_bound",
      plan,
      ...bound,
      fleetProvider: async () => [{
        alias: "01", online: true, ready: true, lease: "free",
        quarantined: false, unresolvedFailure: null,
        capabilityIds: ["xhs.observe.fixture"],
      }],
      worker: {
        async execute(assignment) {
          seen = assignment;
          const now = new Date().toISOString();
          const { createWorkReceipt } = await import("../scripts/lib/work-receipt.mjs");
          return createWorkReceipt({
            assignment,
            technicalStatus: "succeeded",
            businessStatus: "accepted",
            job: { jobId: "job_stub", runId: "run_stub" },
            startedAt: now,
            finishedAt: now,
          });
        },
      },
      store,
    });
    assert.ok(seen.boundNode);
    assert.equal(seen.boundNode.capabilityContractHash, contractA);
    assert.equal(seen.boundNode.implementationClosureHash, closureA);
    assert.equal(seen.node.capabilityContractHash, undefined);
    assert.equal(seen.executionPlanHash, bound.executionPlanHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("contract presence matrix is fail-closed on one-sided metadata", () => {
  const both = recheckImplementationIntegrity({
    boundCapability: { capabilityContractHash: contractA, implementationClosureHash: closureA },
    liveCapability: { capabilityContractHash: contractA, implementationClosureHash: closureA },
  });
  assert.equal(both.ok, true);
  assert.equal(both.legacy, false);

  const neither = recheckImplementationIntegrity({
    boundCapability: { capabilityContractHash: null, implementationClosureHash: null },
    liveCapability: { capabilityContractHash: null, implementationClosureHash: null },
  });
  assert.equal(neither.ok, true);
  assert.equal(neither.legacy, true);

  const boundOnly = recheckImplementationIntegrity({
    boundCapability: { capabilityContractHash: contractA, implementationClosureHash: null },
    liveCapability: { capabilityContractHash: null, implementationClosureHash: null },
  });
  assert.equal(boundOnly.ok, false);

  const liveOnly = recheckImplementationIntegrity({
    boundCapability: { capabilityContractHash: null, implementationClosureHash: null },
    liveCapability: { capabilityContractHash: contractB, implementationClosureHash: null },
  });
  assert.equal(liveOnly.ok, false);

  const mismatched = recheckImplementationIntegrity({
    boundCapability: { capabilityContractHash: contractA, implementationClosureHash: null },
    liveCapability: { capabilityContractHash: contractB, implementationClosureHash: null },
  });
  assert.equal(mismatched.ok, false);
});

test("closure rejects symlink entries fail-closed", () => {
  const root = mkdtempSync(join(tmpdir(), "closure-symlink-"));
  try {
    mkdirSync(join(root, "apps"), { recursive: true });
    const target = join(root, "apps", "real.mjs");
    writeFileSync(target, "export const x = 1;\n", "utf8");
    const link = join(root, "apps", "linked.mjs");
    try {
      symlinkSync(target, link);
    } catch (error) {
      // Windows may require elevated privileges for symlinks.
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        return;
      }
      throw error;
    }
    assert.throws(
      () => computeImplementationClosureFromFiles({ rootDir: root, paths: ["apps/linked.mjs"] }),
      (e) => e.code === "IMPLEMENTATION_CLOSURE_SYMLINK",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
