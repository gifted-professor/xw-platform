import assert from "node:assert/strict";
import test from "node:test";

import { bindTaskPlanToLiveCapabilities } from "../scripts/lib/task-plan-capability-binding.mjs";
import { createTaskPlanV2 } from "../scripts/lib/task-plan-v2.mjs";
import { buildRunManifest } from "../scripts/lib/orchestration-store.mjs";
import {
  assertResumeIntegrity,
  recheckImplementationIntegrity,
} from "../scripts/lib/runtime-integrity.mjs";
import {
  createWorkReceipt,
  createWorkReceiptV2,
  readWorkReceipt,
} from "../scripts/lib/work-receipt.mjs";
import { createFakeTypedTransport, createInjectedAdapter } from "../scripts/lib/typed-transport.mjs";

const closureA = "a".repeat(64);
const closureB = "b".repeat(64);
const contractA = "c".repeat(64);

const catalog = [
  {
    id: "xianyu.publish.full_dry_run",
    appId: "xianyu",
    capabilityContractHash: contractA,
    capabilityContractHashAlgorithm: "xhs.capability-contract.sha256-canonical-json.v2",
    implementationClosureHash: closureA,
    tcbManifestRef: "tcb.xianyu.prepare",
    normalizedEffect: { class: "publish", phase: "prepare", commitBoundary: "automatic" },
    idempotency: "replay_safe",
    availability: "implemented",
  },
];

function assignmentFixture(over = {}) {
  return {
    taskRunId: "run_pr2",
    planHash: "1".repeat(64),
    executionPlanHash: "2".repeat(64),
    capabilityContractHash: contractA,
    capabilityContractHashAlgorithm: "xhs.capability-contract.sha256-canonical-json.v2",
    implementationClosureHash: closureA,
    operationKey: "m2:run_pr2:shard",
    authorizationDecisionId: "auth_1",
    boundNode: {
      nodeId: "n1",
      capabilityContractHash: contractA,
      capabilityContractHashAlgorithm: "xhs.capability-contract.sha256-canonical-json.v2",
      implementationClosureHash: closureA,
    },
    node: {
      nodeId: "n1",
      nodeIndex: 0,
      executor: { capabilityId: "xianyu.publish.full_dry_run", appId: "xianyu" },
    },
    shard: { shardId: "s0", shardIndex: 0, shardKey: "shard" },
    attemptId: "att_1",
    attemptIndex: 0,
    workerId: "worker_1",
    alias: "01",
    ...over,
  };
}

test("RI-03: ExecutionPlan and run-manifest share implementationClosureHash", () => {
  const raw = createTaskPlanV2({
    goal: "prepare",
    requestKey: "pr2-bind-1",
    nodes: [{
      nodeId: "n1",
      executor: {
        kind: "typed_job",
        capabilityId: "xianyu.publish.full_dry_run",
        appId: "xianyu",
        effectClass: "external_effect",
        replaySafety: "replay_safe",
      },
      shards: [{ shardIndex: 0, params: { saveDraft: false }, placement: { alias: "01" } }],
    }],
  });
  const { executionPlan, executionPlanHash } = bindTaskPlanToLiveCapabilities(raw, catalog);
  assert.equal(executionPlan.nodes[0].implementationClosureHash, closureA);
  assert.equal(executionPlan.nodes[0].capabilityContractHash, contractA);
  const plan = { ...raw, planHash: raw.planHash || "p".repeat(64) };
  if (!plan.planHash) plan.planHash = "p".repeat(64);
  // createTaskPlanV2 already sets planHash
  const manifest = buildRunManifest({
    taskRunId: "run_pr2",
    plan,
    executionPlan,
    executionPlanHash,
  });
  assert.equal(manifest.workUnits[0].implementationClosureHash, closureA);
  assert.equal(manifest.workUnits[0].capabilityContractHash, contractA);
});

test("RI-04: resume integrity fails closed on drift", () => {
  assert.throws(
    () => assertResumeIntegrity({
      boundNode: { capabilityId: "xianyu.publish.full_dry_run", capabilityContractHash: contractA, implementationClosureHash: closureA },
      liveCapability: { id: "xianyu.publish.full_dry_run", capabilityContractHash: contractA, implementationClosureHash: closureB },
    }),
    (e) => e.code === "IMPLEMENTATION_CONTRACT_CHANGED" && e.details?.notSent === true,
  );
  const ok = recheckImplementationIntegrity({
    boundCapability: { capabilityContractHash: contractA, implementationClosureHash: closureA },
    liveCapability: { capabilityContractHash: contractA, implementationClosureHash: closureA },
  });
  assert.equal(ok.ok, true);

  const asymmetric = recheckImplementationIntegrity({
    boundCapability: { capabilityContractHash: contractA, implementationClosureHash: null },
    liveCapability: { capabilityContractHash: contractA, implementationClosureHash: closureA },
  });
  assert.equal(asymmetric.ok, false);
  assert.equal(asymmetric.details.notSent, true);
});

test("RI-05: WorkReceipt v1 still validates; v2 carries integrity proof", () => {
  const assignment = assignmentFixture();
  const v1 = createWorkReceipt({
    assignment,
    technicalStatus: "succeeded",
    businessStatus: "accepted",
    job: { jobId: "job_1", runId: "cp_run_1" },
    startedAt: "2026-08-08T00:00:00.000Z",
    finishedAt: "2026-08-08T00:00:01.000Z",
  });
  assert.equal(v1.schemaId, "xhs.work-receipt.v1");
  assert.equal(readWorkReceipt(v1).schemaVersion, 1);

  const v2 = createWorkReceiptV2({
    assignment,
    technicalStatus: "succeeded",
    businessStatus: "accepted",
    job: { jobId: "job_1", runId: "cp_run_1", authorization: { decisionId: "auth_1" } },
    startedAt: "2026-08-08T00:00:00.000Z",
    finishedAt: "2026-08-08T00:00:01.000Z",
  });
  assert.equal(v2.schemaId, "xhs.work-receipt.v2");
  assert.equal(v2.implementationClosureHash, closureA);
  assert.equal(v2.capabilityContractHash, contractA);
  assert.equal(v2.capabilityContractHashAlgorithm, "xhs.capability-contract.sha256-canonical-json.v2");
  assert.equal(v2.reconcileRequired, false);
  assert.equal(readWorkReceipt(v2).controlPlaneRunId, "cp_run_1");

  const notSent = createWorkReceiptV2({
    assignment,
    technicalStatus: "failed",
    businessStatus: "not_evaluated",
    job: {},
    error: { code: "IMPLEMENTATION_CONTRACT_CHANGED", notSent: true, details: { notSent: true, phase: "resume" } },
    startedAt: "2026-08-08T00:00:00.000Z",
    finishedAt: "2026-08-08T00:00:01.000Z",
    integrity: { jobId: null, controlPlaneRunId: null, authorizationDecisionId: "unbound" },
  });
  assert.equal(notSent.jobId, null);
  assert.equal(notSent.controlPlaneRunId, null);
});

test("TypedTransport fake injection works without raw device channel", async () => {
  const transport = createFakeTypedTransport();
  const adapter = createInjectedAdapter({ transport });
  const out = await adapter.execute({ action: "screen", purpose: "observe", params: { alias: "01" } });
  assert.equal(out.ok, true);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].purpose, "observe");
});
