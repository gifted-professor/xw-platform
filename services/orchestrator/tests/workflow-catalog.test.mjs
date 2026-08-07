import assert from "node:assert/strict";
import test from "node:test";

import {
  compileWorkflowNodeAuthoring,
  getWorkflow,
  loadWorkflows,
  validateWorkflowCatalog,
  workflowIsDirectlyRunnable,
} from "../scripts/lib/workflow-catalog.mjs";
import {
  createFixedAliasShards,
  createTaskPlanV2,
  validateTaskPlanV2,
} from "../scripts/lib/task-plan-v2.mjs";

test("workflow catalog loads wechat balance-read as canary_only session workflow", () => {
  const workflows = loadWorkflows();
  const balance = workflows.find((item) => item.workflowId === "workflow.wechat.balance-read.v1");
  assert.ok(balance);
  assert.equal(balance.entry, "session");
  assert.equal(balance.capabilityId, "xiaowei.explorer.primitive");
  assert.equal(balance.maturity, "canary_only");
  assert.equal(balance.status, "canary_only");
  assert.equal(balance.directRun, false);
  assert.equal(balance.tapAuthorized, false);
  assert.equal(balance.acceptance.paymentTransport, 0);
  assert.equal(balance.acceptance.finalCommit, false);
  assert.equal(balance.acceptance.privacy.publicKnowledge, false);
  assert.equal(balance.placement.allowReassign, false);
  assert.deepEqual(balance.placement.fixedAliases, ["01", "02", "03", "04"]);
  assert.equal(workflowIsDirectlyRunnable(balance), false);
});

test("workflow catalog rejects recipe-like effectful or reassignable descriptors", () => {
  const [good] = loadWorkflows();
  const bad = {
    schemaId: "xhs.workflow-catalog.v1",
    schemaVersion: 1,
    workflows: [
      {
        ...good,
        effectClass: "external_effect",
        placement: { ...good.placement, allowReassign: true },
        acceptance: { ...good.acceptance, paymentTransport: 1, finalCommit: true },
      },
    ],
  };
  const errors = validateWorkflowCatalog(bad);
  const text = JSON.stringify(errors);
  assert.match(text, /effectClass/);
  assert.match(text, /allowReassign/);
  assert.match(text, /paymentTransport/);
  assert.match(text, /finalCommit/);
});

test("compileWorkflowNodeAuthoring creates fixed 01-04 session_workflow shards", () => {
  const workflow = getWorkflow("workflow.wechat.balance-read.v1");
  const node = compileWorkflowNodeAuthoring(workflow, { nodeId: "wechat_balance" });
  assert.equal(node.executor.kind, "session_workflow");
  assert.equal(node.executor.workflowId, "workflow.wechat.balance-read.v1");
  assert.equal(node.shards.length, 4);
  assert.deepEqual(node.shards.map((s) => s.placement.alias), ["01", "02", "03", "04"]);

  const plan = createTaskPlanV2({
    goal: "四机微信余额只读",
    requestKey: "fixture-wechat-balance-p1b",
    nodes: [node],
  });
  assert.equal(plan.execution.allowReassign, false);
  assert.deepEqual(validateTaskPlanV2(plan), []);
  assert.equal(plan.nodes[0].executor.kind, "session_workflow");
  assert.ok(plan.nodes[0].shards.every((shard) => shard.placement.alias));
  // shard keys include alias: same params on different aliases must differ
  const keys = new Set(plan.nodes[0].shards.map((shard) => shard.shardKey));
  assert.equal(keys.size, 4);
});

test("session_workflow rejects reassignment and missing alias; typed_job still works", () => {
  assert.throws(() => createTaskPlanV2({
    goal: "bad reassign",
    requestKey: "fixture-sw-reassign",
    execution: { allowReassign: true },
    nodes: [{
      nodeId: "sw",
      executor: {
        kind: "session_workflow",
        workflowId: "workflow.wechat.balance-read.v1",
        capabilityId: "xiaowei.explorer.primitive",
        appId: "wechat",
        replaySafety: "read_only",
        effectClass: "none",
        resources: ["transport:xiaowei:22222"],
      },
      shards: createFixedAliasShards({ aliases: ["01"] }),
    }],
  }), /allowReassign/);

  assert.throws(() => createTaskPlanV2({
    goal: "missing alias",
    requestKey: "fixture-sw-no-alias",
    nodes: [{
      nodeId: "sw",
      executor: {
        kind: "session_workflow",
        workflowId: "workflow.wechat.balance-read.v1",
        capabilityId: "xiaowei.explorer.primitive",
        appId: "wechat",
        replaySafety: "read_only",
        effectClass: "none",
        resources: [],
      },
      shards: [{ params: {} }],
    }],
  }), /placement\.alias|session_workflow/);

  const typed = createTaskPlanV2({
    goal: "typed still ok",
    requestKey: "fixture-typed-still-ok",
    nodes: [{
      nodeId: "observe",
      executor: {
        kind: "typed_job",
        capabilityId: "xhs.observe.metrics",
        appId: "xhs",
        replaySafety: "read_only",
        effectClass: "none",
        resources: ["device"],
      },
      shards: [{ params: { k: 1 } }],
    }],
  });
  assert.equal(typed.nodes[0].executor.kind, "typed_job");
  assert.equal(typed.execution.allowReassign, true);
  assert.deepEqual(validateTaskPlanV2(typed), []);
});
