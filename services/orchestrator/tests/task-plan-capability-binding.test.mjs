import assert from "node:assert/strict";
import test from "node:test";
import { bindTaskPlanToLiveCapabilities } from "../scripts/lib/task-plan-capability-binding.mjs";
import { createTaskPlanV2 } from "../scripts/lib/task-plan-v2.mjs";

const catalog = [
  {
    id: "xianyu.publish.full_dry_run",
    appId: "xianyu",
    capabilityContractHash: "a".repeat(64),
    normalizedEffect: { class: "publish", phase: "prepare", commitBoundary: "automatic" },
    idempotency: "replay_safe",
    availability: "implemented",
  },
  {
    id: "xhs.comment.send",
    appId: "xhs",
    capabilityContractHash: "b".repeat(64),
    normalizedEffect: { class: "social", phase: "final", commitBoundary: "automatic" },
    idempotency: "external_effect",
    availability: "implemented",
  },
];

test("binder produces actor-independent ExecutionPlan with placement constraint only", () => {
  const raw = createTaskPlanV2({
    goal: "prepare only",
    requestKey: "pr1-bind-prepare-1",
    nodes: [
      {
        nodeId: "n1",
        executor: {
          kind: "typed_job",
          capabilityId: "xianyu.publish.full_dry_run",
          appId: "xianyu",
          effectClass: "external_effect",
          replaySafety: "replay_safe",
        },
        shards: [{ shardIndex: 0, params: { saveDraft: false }, placement: { alias: "01" } }],
      },
    ],
  });
  const { executionPlan, executionPlanHash } = bindTaskPlanToLiveCapabilities(raw, catalog);
  assert.equal(executionPlan.schemaId, "xhs.execution-plan.v2");
  assert.equal(executionPlanHash.length, 64);
  assert.equal(executionPlan.nodes[0].placementConstraint.alias, "01");
  assert.equal(executionPlan.nodes[0].deviceId, undefined);
  assert.equal(executionPlan.nodes[0].capabilityContractHash, "a".repeat(64));
  assert.equal(executionPlan.constraints.maxWorkers, 1);

  const again = bindTaskPlanToLiveCapabilities(raw, catalog);
  assert.equal(again.executionPlanHash, executionPlanHash);
});

test("forged none effect against business live contract is PLAN_CONTRACT_MISMATCH", () => {
  const raw = createTaskPlanV2({
    goal: "forge",
    requestKey: "pr1-bind-forge-1",
    nodes: [
      {
        nodeId: "n1",
        executor: {
          kind: "typed_job",
          capabilityId: "xhs.comment.send",
          appId: "xhs",
          effectClass: "none",
          replaySafety: "read_only",
        },
        shards: [{ shardIndex: 0, params: { text: "hi" }, placement: { alias: "01" } }],
      },
    ],
  });
  assert.throws(
    () => bindTaskPlanToLiveCapabilities(raw, catalog),
    (e) => e.code === "PLAN_CONTRACT_MISMATCH",
  );
});

test("workflow params.actions injection is unbound", () => {
  const raw = createTaskPlanV2({
    goal: "wf",
    requestKey: "pr1-bind-wf-1",
    nodes: [
      {
        nodeId: "w1",
        executor: {
          kind: "session_workflow",
          workflowId: "workflow.wechat.balance-read.v1",
          capabilityId: "xiaowei.explorer.primitive",
          appId: "wechat",
          effectClass: "none",
          replaySafety: "read_only",
        },
        shards: [{ shardIndex: 0, params: { actions: [{ type: "tap" }] }, placement: { alias: "01" } }],
      },
    ],
  });
  assert.throws(
    () => bindTaskPlanToLiveCapabilities(raw, catalog),
    (e) => e.code === "WORKFLOW_CONTRACT_UNBOUND",
  );
});
