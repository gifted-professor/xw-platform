import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { TraceStore } from "../../../packages/harness-protocol/lib/trace-store.mjs";
import { executeM5Goal, lowerM5DagToTaskPlan, planM5Goal } from "../scripts/lib/m5-orchestration-runtime.mjs";
import { OrchestrationStore } from "../scripts/lib/orchestration-store.mjs";
import { createWorkReceipt } from "../scripts/lib/work-receipt.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const LIVE_CATALOG = [{
  id: "xhs.observe.feed",
  appId: "xhs",
  availability: "implemented",
  idempotency: "read_only",
  normalizedEffect: { class: "observe", phase: "read", commitBoundary: "automatic" },
}];

function fleet() {
  return ["01", "02", "03", "04"].map((alias) => ({
    alias,
    online: true,
    ready: true,
    lease: "free",
    quarantined: false,
    unresolvedFailure: null,
    capabilityIds: ["xhs.observe.feed"],
  }));
}

function receipt(assignment, output) {
  const at = new Date().toISOString();
  return createWorkReceipt({
    assignment,
    technicalStatus: "succeeded",
    businessStatus: "accepted",
    retryable: false,
    job: { jobId: `job_${assignment.alias}`, runId: `run_${assignment.alias}` },
    output,
    startedAt: at,
    finishedAt: at,
  });
}

async function withRuntime(fn) {
  const root = mkdtempSync(path.join(tmpdir(), "m5-runtime-"));
  try {
    const taskRunId = "run_m5_fixture";
    return await fn({
      root,
      taskRunId,
      store: new OrchestrationStore({ taskRunId, workRoot: path.join(root, "work") }),
      traceStore: new TraceStore({ traceRoot: path.join(root, "trace") }),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("dry planning uses the real registered catalog and lowers onto existing TaskPlanV2", async () => {
  const planned = await planM5Goal({
    goal: "四台机器各刷一次首页并汇总卡片数",
    aliases: ["01", "02", "03", "04"],
    repoRoot: ROOT,
  });
  assert.equal(planned.ok, true);
  assert.equal(planned.dag.nodes.filter(({ skillId }) => skillId === "xhs.observe.feed").length, 4);
  assert.equal(planned.dag.nodes.at(-1).skillId, "xw.validate.card-count");
  const lowered = lowerM5DagToTaskPlan({ dag: planned.dag, catalog: planned.catalog, goal: "fixture" });
  assert.equal(lowered.taskPlan.schemaId, "xhs.task-plan.v2");
  assert.equal(lowered.taskPlan.nodes.length, 4);
  assert.deepEqual(lowered.taskPlan.nodes.map((node) => node.shards[0].placement.alias), ["01", "02", "03", "04"]);
  assert.equal(lowered.validatorNode.skillId, "xw.validate.card-count");
});

test("fake four-device M5 E2E runs through the existing scheduler and validates card counts", async () => withRuntime(async ({ taskRunId, store, traceStore }) => {
  const result = await executeM5Goal({
    goal: "四台机器各刷一次首页并汇总卡片数",
    aliases: ["01", "02", "03", "04"],
    traceId: "trace-m5-e2e",
    taskRunId,
    liveCatalog: LIVE_CATALOG,
    fleetProvider: async () => fleet(),
    worker: { execute: async (assignment) => receipt(assignment, { cardCount: Number(assignment.alias) }) },
    store,
    traceStore,
    repoRoot: ROOT,
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.validation.byAlias, { "01": 1, "02": 2, "03": 3, "04": 4 });
  assert.equal(result.validation.totalCardCount, 10);
  const trace = traceStore.query("trace-m5-e2e");
  assert.equal(trace.events.filter(({ type }) => type === "WorkerAssigned").length, 4);
  assert.equal(trace.events.filter(({ type, status }) => type === "SkillFinished" && status === "succeeded").length, 5);
  assert.equal(trace.events.at(-1).type, "ValidationPassed");
  assert.equal(new Set(trace.events.map(({ traceId }) => traceId)).size, 1);
}));

test("validator failure changes mission status and never emits ValidationPassed", async () => withRuntime(async ({ taskRunId, store, traceStore }) => {
  const result = await executeM5Goal({
    goal: "四台机器各刷一次首页并汇总卡片数",
    aliases: ["01", "02", "03", "04"],
    traceId: "trace-m5-validation-fail",
    taskRunId,
    liveCatalog: LIVE_CATALOG,
    fleetProvider: async () => fleet(),
    worker: {
      execute: async (assignment) => receipt(assignment, assignment.alias === "03" ? {} : { cardCount: 1 }),
    },
    store,
    traceStore,
    repoRoot: ROOT,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.validation.code, "M5_VALIDATION_CARD_COUNT");
  const events = traceStore.read("trace-m5-validation-fail");
  assert.equal(events.some(({ type }) => type === "ValidationPassed"), false);
  assert.equal(events.at(-1).type, "SkillFinished");
  assert.equal(events.at(-1).status, "failed");
}));

test("one failed alias is isolated while the other three finish and trace the failure", async () => withRuntime(async ({ taskRunId, store, traceStore }) => {
  const result = await executeM5Goal({
    goal: "四台机器各刷一次首页并汇总卡片数",
    aliases: ["01", "02", "03", "04"],
    traceId: "trace-m5-one-failed",
    taskRunId,
    liveCatalog: LIVE_CATALOG,
    fleetProvider: async () => fleet(),
    worker: {
      async execute(assignment) {
        if (assignment.alias !== "03") return receipt(assignment, { cardCount: 2 });
        const at = new Date().toISOString();
        return createWorkReceipt({
          assignment,
          technicalStatus: "failed",
          businessStatus: "not_evaluated",
          retryable: false,
          error: { code: "ADAPTER_HTTP_UNAVAILABLE", message: "fixture serve unavailable" },
          startedAt: at,
          finishedAt: at,
        });
      },
    },
    store,
    traceStore,
    repoRoot: ROOT,
  });
  assert.equal(result.status, "partial");
  assert.deepEqual(result.results.filter(({ accepted }) => accepted).map(({ alias }) => alias), ["01", "02", "04"]);
  assert.equal(result.results.find(({ alias }) => alias === "03").error.code, "ADAPTER_HTTP_UNAVAILABLE");
  const events = traceStore.read("trace-m5-one-failed");
  const failed = events.find(({ type, alias }) => type === "SkillFinished" && alias === "03");
  assert.equal(failed.status, "failed");
  assert.equal(failed.payload.errorCode, "ADAPTER_HTTP_UNAVAILABLE");
  assert.equal(events.filter(({ type, status }) => type === "SkillFinished" && status === "succeeded").length, 3);
  assert.equal(events.some(({ type }) => type === "ValidationPassed"), false);
}));

test("unknown goal stays needs_human and cannot lower into an execution plan", async () => {
  const planned = await planM5Goal({ goal: "随便处理一下", repoRoot: ROOT });
  assert.equal(planned.ok, false);
  assert.equal(planned.classification.taskType, "needs_human");
  assert.equal(planned.dag, null);
});
