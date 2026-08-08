import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeTaskPlanHash, createTaskPlanV2, validateTaskPlanV2 } from "../scripts/lib/task-plan-v2.mjs";
import { createWorkReceipt } from "../scripts/lib/work-receipt.mjs";
import { OrchestrationStore } from "../scripts/lib/orchestration-store.mjs";
import { runTaskOrchestrator } from "../scripts/lib/task-orchestrator.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function executor(capabilityId, appId = capabilityId.split(".")[0]) {
  return {
    kind: "typed_job",
    capabilityId,
    appId,
    replaySafety: "read_only",
    effectClass: "none",
    resources: ["device"],
  };
}

function planWith({ nodes, requestKey = "fixture-request", execution = {} }) {
  return createTaskPlanV2({ goal: "orchestrator fixture", requestKey, nodes, execution });
}

function fleet(capabilities = ["cap.a", "cap.b", "cap.c", "cap.d"]) {
  return ["01", "02", "03", "04"].map((alias) => ({
    alias,
    online: true,
    ready: true,
    lease: "free",
    quarantined: false,
    unresolvedFailure: null,
    capabilityIds: capabilities,
  }));
}

function accepted(assignment, output = {}) {
  const now = new Date().toISOString();
  return createWorkReceipt({
    assignment,
    technicalStatus: "succeeded",
    businessStatus: "accepted",
    retryable: false,
    job: { jobId: `job_${assignment.attemptId}`, runId: `run_${assignment.attemptId}` },
    output,
    startedAt: now,
    finishedAt: now,
  });
}

async function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), "xw-orchestrator-"));
  try {
    return await fn(new OrchestrationStore({ taskRunId: "run_fixture", workRoot: root }), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("task plan v2 is deterministic and rejects tampering", () => {
  const input = {
    goal: "four work units",
    requestKey: "same-request",
    nodes: [{ nodeId: "fanout", executor: executor("cap.a"), shards: [{ params: { keyword: "a" } }] }],
  };
  const first = createTaskPlanV2(input);
  const second = createTaskPlanV2(input);
  assert.equal(first.planHash, second.planHash);
  assert.equal(first.nodes[0].shards[0].shardKey, second.nodes[0].shards[0].shardKey);
  assert.deepEqual(validateTaskPlanV2(first), []);
  first.nodes[0].shards[0].params.keyword = "changed";
  assert.match(JSON.stringify(validateTaskPlanV2(first)), /planHash/);
});

test("Foundation: raw plan may assert external_effect; worker count above four still fails", () => {
  // effectClass is a non-authoritative assertion; live Contract bind decides real effect.
  assert.doesNotThrow(() => planWith({
    nodes: [{ nodeId: "send", executor: { ...executor("cap.a"), effectClass: "external_effect" }, shards: [{ params: {} }] }],
  }));
  assert.throws(() => planWith({
    nodes: [{ nodeId: "read", executor: executor("cap.a"), shards: [{ params: {} }] }],
    execution: { maxWorkers: 5 },
  }), /maxWorkers/);
});

test("validator recomputes shard keys and rejects duplicates", () => {
  const plan = planWith({
    nodes: [{ nodeId: "keys", executor: executor("cap.a"), shards: [{ params: { value: 1 } }, { params: { value: 2 } }] }],
  });
  plan.nodes[0].shards[1].shardKey = plan.nodes[0].shards[0].shardKey;
  plan.planHash = computeTaskPlanHash(plan);
  plan.planId = `plan_${plan.planHash}`;
  const errors = validateTaskPlanV2(plan);
  assert.match(JSON.stringify(errors), /does not match/);
  assert.match(JSON.stringify(errors), /unique across/);
});

test("four heterogeneous work units overlap but reduce in plan order", async () => withStore(async (store) => {
  const plan = planWith({
    nodes: [
      { nodeId: "a", executor: executor("cap.a", "douyin"), shards: [{ params: { value: "A" } }] },
      { nodeId: "b", executor: executor("cap.b", "xhs"), shards: [{ params: { value: "B" } }] },
      { nodeId: "c", executor: executor("cap.c", "wechat"), shards: [{ params: { value: "C" } }] },
      { nodeId: "d", executor: executor("cap.d", "xianyu"), shards: [{ params: { value: "D" } }] },
    ],
  });
  let active = 0;
  let peak = 0;
  const result = await runTaskOrchestrator({
    taskRunId: "run_fixture",
    plan,
    fleetProvider: async () => fleet(),
    worker: {
      async execute(assignment) {
        active += 1;
        peak = Math.max(peak, active);
        await delay({ "01": 40, "02": 30, "03": 20, "04": 10 }[assignment.alias]);
        active -= 1;
        return accepted(assignment, { value: assignment.shard.params.value, items: [{ value: assignment.shard.params.value }] });
      },
    },
    store,
  });
  assert.equal(peak, 4);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.results.map((item) => item.output.value), ["A", "B", "C", "D"]);
  assert.deepEqual(result.orderedItems.map((entry) => entry.item.value), ["A", "B", "C", "D"]);
  assert.deepEqual(result.results.map((item) => item.alias), ["01", "02", "03", "04"]);
}));

test("same device never runs two heavy work units concurrently", async () => withStore(async (store) => {
  const plan = planWith({
    nodes: [{
      nodeId: "fanout",
      executor: executor("cap.a"),
      shards: Array.from({ length: 8 }, (_, index) => ({ params: { index } })),
    }],
  });
  const activeAliases = new Set();
  let duplicateAlias = false;
  const result = await runTaskOrchestrator({
    taskRunId: "run_fixture",
    plan,
    fleetProvider: async () => fleet(["cap.a"]),
    worker: {
      async execute(assignment) {
        if (activeAliases.has(assignment.alias)) duplicateAlias = true;
        activeAliases.add(assignment.alias);
        await delay(5);
        activeAliases.delete(assignment.alias);
        return accepted(assignment, { index: assignment.shard.params.index });
      },
    },
    store,
  });
  assert.equal(duplicateAlias, false);
  assert.equal(result.summary.accepted, 8);
}));

test("retryable failure is dynamically reassigned to another device", async () => withStore(async (store) => {
  const plan = planWith({
    nodes: [{ nodeId: "retry", executor: executor("cap.a"), shards: [{ params: {} }] }],
    execution: { maxWorkers: 4, allowReassign: true, maxAttemptsPerShard: 2 },
  });
  const aliases = [];
  const result = await runTaskOrchestrator({
    taskRunId: "run_fixture",
    plan,
    fleetProvider: async () => fleet(["cap.a"]),
    worker: {
      async execute(assignment) {
        aliases.push(assignment.alias);
        if (assignment.attemptIndex === 0) {
          const now = new Date().toISOString();
          return createWorkReceipt({
            assignment,
            technicalStatus: "failed",
            businessStatus: "not_evaluated",
            retryable: true,
            error: { code: "ADAPTER_HTTP_UNAVAILABLE", message: "fixture" },
            startedAt: now,
            finishedAt: now,
          });
        }
        return accepted(assignment, { retried: true });
      },
    },
    store,
  });
  assert.deepEqual(aliases, ["01", "02"]);
  assert.equal(result.status, "completed");
  assert.equal(result.results[0].attemptCount, 2);
}));

test("Lead learns capability-specific failure from receipts and avoids that device", async () => withStore(async (store) => {
  const plan = planWith({
    nodes: [{ nodeId: "learn", executor: executor("cap.a"), shards: [{ params: { index: 0 } }, { params: { index: 1 } }] }],
    execution: { maxWorkers: 1, allowReassign: true, maxAttemptsPerShard: 1 },
  });
  const aliases = [];
  const result = await runTaskOrchestrator({
    taskRunId: "run_fixture",
    plan,
    fleetProvider: async () => fleet(["cap.a"]),
    worker: {
      async execute(assignment) {
        aliases.push(assignment.alias);
        if (assignment.shard.params.index === 0) {
          const now = new Date().toISOString();
          return createWorkReceipt({
            assignment,
            technicalStatus: "failed",
            businessStatus: "not_evaluated",
            retryable: false,
            error: { code: "ADAPTER_HTTP_UNAVAILABLE", message: "capability not healthy on this alias" },
            startedAt: now,
            finishedAt: now,
          });
        }
        return accepted(assignment);
      },
    },
    store,
  });
  assert.deepEqual(aliases, ["01", "02"]);
  assert.equal(result.status, "partial");
  assert.deepEqual(store.loadState().capabilityBlocks.map((item) => [item.alias, item.capabilityId]), [["01", "cap.a"]]);
}));

test("capability readiness is required; device ready alone is not enough", async () => withStore(async (store) => {
  const plan = planWith({ nodes: [{ nodeId: "blocked", executor: executor("cap.missing"), shards: [{ params: {} }] }] });
  let executions = 0;
  const result = await runTaskOrchestrator({
    taskRunId: "run_fixture",
    plan,
    fleetProvider: async () => fleet(["cap.a"]),
    worker: { async execute() { executions += 1; throw new Error("must not execute"); } },
    store,
  });
  assert.equal(executions, 0);
  assert.equal(result.status, "blocked");
  assert.equal(result.results[0].error.code, "NO_ELIGIBLE_DEVICE");
}));

test("dependent node waits for all parent shards and blocks on rejected parent", async () => withStore(async (store) => {
  const plan = planWith({
    nodes: [
      { nodeId: "collect", executor: executor("cap.a"), shards: [{ params: { ok: true } }, { params: { ok: false } }] },
      { nodeId: "reduce", dependsOn: ["collect"], executor: executor("cap.b"), shards: [{ params: {} }] },
    ],
  });
  let reduceRan = false;
  const result = await runTaskOrchestrator({
    taskRunId: "run_fixture",
    plan,
    fleetProvider: async () => fleet(["cap.a", "cap.b"]),
    worker: {
      async execute(assignment) {
        if (assignment.node.nodeId === "reduce") reduceRan = true;
        if (assignment.shard.params.ok === false) {
          const now = new Date().toISOString();
          return createWorkReceipt({
            assignment,
            technicalStatus: "succeeded",
            businessStatus: "rejected",
            retryable: false,
            output: { items: [{ shouldNotEscape: true }] },
            error: { code: "BUSINESS_REJECTED", message: "fixture" },
            startedAt: now,
            finishedAt: now,
          });
        }
        return accepted(assignment);
      },
    },
    store,
  });
  assert.equal(reduceRan, false);
  assert.equal(result.status, "partial");
  assert.equal(result.results.at(-1).technicalStatus, "blocked");
  assert.equal(result.orderedItems.some((entry) => entry.item.shouldNotEscape), false);
}));

test("resume uses explicit receipt refs and does not repeat accepted work", async () => withStore(async (store) => {
  const plan = planWith({
    nodes: [{ nodeId: "resume", executor: executor("cap.a"), shards: [{ params: { index: 0 } }, { params: { index: 1 } }] }],
  });
  const firstShard = plan.nodes[0].shards[0];
  const firstAssignment = {
    taskRunId: "run_fixture",
    planHash: plan.planHash,
    node: plan.nodes[0],
    shard: firstShard,
    alias: "01",
    workerId: "worker-1",
    attemptIndex: 0,
    attemptId: "attempt_resume_0",
  };
  const state = store.init(plan);
  const ref = store.writeReceipt(accepted(firstAssignment, { items: [{ index: 0 }] }));
  state.workUnits = {
    [`resume:${firstShard.shardId}`]: {
      nodeId: "resume",
      nodeIndex: 0,
      shardId: firstShard.shardId,
      shardIndex: 0,
      shardKey: firstShard.shardKey,
      status: "succeeded",
      attemptCount: 1,
      attemptedAliases: ["01"],
      attempts: [{ attemptId: "attempt_resume_0", attemptIndex: 0, alias: "01", workerId: "worker-1" }],
      receiptRefs: [ref],
      lastError: null,
    },
  };
  state.receiptRefs = [ref];
  store.writeState(state);
  const executed = [];
  const result = await runTaskOrchestrator({
    taskRunId: "run_fixture",
    plan,
    fleetProvider: async () => fleet(["cap.a"]),
    worker: {
      async execute(nextAssignment) {
        executed.push(nextAssignment.shard.shardIndex);
        return accepted(nextAssignment, { items: [{ index: nextAssignment.shard.shardIndex }] });
      },
    },
    store,
  });
  assert.deepEqual(executed, [1]);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.orderedItems.map((entry) => entry.item.index), [0, 1]);
}));

test("crash recovery resumes the same in-flight attempt and bound job", async () => withStore(async (store) => {
  const plan = planWith({ nodes: [{ nodeId: "crash", executor: executor("cap.a"), shards: [{ params: {} }] }] });
  const shard = plan.nodes[0].shards[0];
  const state = store.init(plan);
  state.status = "running";
  state.workUnits = {
    [`crash:${shard.shardId}`]: {
      nodeId: "crash",
      nodeIndex: 0,
      shardId: shard.shardId,
      shardIndex: 0,
      shardKey: shard.shardKey,
      status: "running",
      attemptCount: 1,
      attemptedAliases: ["03"],
      receiptRefs: [],
      lastError: null,
      inflight: { attemptId: "attempt_crash_0", attemptIndex: 0, alias: "03" },
      attempts: [{ attemptId: "attempt_crash_0", attemptIndex: 0, alias: "03", workerId: "worker-1" }],
      activeJob: { jobId: "job_already_submitted", runId: "run_leaf", alias: "03", status: "running" },
    },
  };
  store.writeState(state);
  const observed = [];
  const result = await runTaskOrchestrator({
    taskRunId: "run_fixture",
    plan,
    fleetProvider: async () => [],
    worker: {
      async execute(nextAssignment) {
        observed.push({
          resume: nextAssignment.resume,
          resumeJobId: nextAssignment.resumeJobId,
          attemptId: nextAssignment.attemptId,
          attemptIndex: nextAssignment.attemptIndex,
          alias: nextAssignment.alias,
        });
        const receipt = accepted(nextAssignment);
        receipt.jobId = "job_already_submitted";
        receipt.runId = "run_leaf";
        return receipt;
      },
    },
    store,
  });
  assert.deepEqual(observed, [{ resume: true, resumeJobId: "job_already_submitted", attemptId: "attempt_crash_0", attemptIndex: 0, alias: "03" }]);
  assert.equal(result.status, "completed");
  assert.equal(store.loadState().workUnits[`crash:${shard.shardId}`].attemptCount, 1);
}));

test("ambiguous job keeps reconciliation binding and later resolves without resubmit", async () => withStore(async (store) => {
  const plan = planWith({ nodes: [{ nodeId: "reconcile", executor: executor("cap.a"), shards: [{ params: {} }] }] });
  const first = await runTaskOrchestrator({
    taskRunId: "run_fixture",
    plan,
    fleetProvider: async () => fleet(["cap.a"]),
    worker: {
      async execute(nextAssignment) {
        await nextAssignment.onProgress({ type: "job_bound", jobId: "job_still_running", runId: "run_leaf", status: "running" });
        const now = new Date().toISOString();
        return createWorkReceipt({
          assignment: nextAssignment,
          technicalStatus: "ambiguous",
          businessStatus: "ambiguous",
          retryable: false,
          job: { jobId: "job_still_running", runId: "run_leaf" },
          error: { code: "JOB_POLL_TIMEOUT", message: "fixture" },
          startedAt: now,
          finishedAt: now,
        });
      },
    },
    store,
  });
  assert.equal(first.status, "ambiguous");
  const pending = store.loadState().workUnits[`reconcile:${plan.nodes[0].shards[0].shardId}`];
  assert.equal(pending.activeJob.jobId, "job_still_running");
  assert.equal(pending.inflight.attemptIndex, 1);

  let resumedJobId = null;
  const second = await runTaskOrchestrator({
    taskRunId: "run_fixture",
    plan,
    fleetProvider: async () => [],
    worker: {
      async execute(nextAssignment) {
        resumedJobId = nextAssignment.resumeJobId;
        const receipt = accepted(nextAssignment);
        receipt.jobId = "job_still_running";
        receipt.runId = "run_leaf";
        return receipt;
      },
    },
    store,
  });
  assert.equal(resumedJobId, "job_still_running");
  assert.equal(second.status, "completed");
  assert.equal(second.results[0].selectedAttemptIndex, 1);
}));

test("same task run refuses a different plan hash", async () => withStore(async (store, root) => {
  const first = planWith({ nodes: [{ nodeId: "a", executor: executor("cap.a"), shards: [{ params: { v: 1 } }] }] });
  store.init(first);
  const second = planWith({ nodes: [{ nodeId: "a", executor: executor("cap.a"), shards: [{ params: { v: 2 } }] }] });
  assert.throws(() => store.init(second), /TASK_RUN_PLAN_CONFLICT/);
  const onDisk = JSON.parse(readFileSync(join(root, "run_fixture", "orchestration", "plan.v2.json"), "utf8"));
  assert.equal(onDisk.planHash, first.planHash);
}));

test("single Lead lock rejects concurrent parent writers", async () => withStore(async (store) => {
  const plan = planWith({ nodes: [{ nodeId: "a", executor: executor("cap.a"), shards: [{ params: {} }] }] });
  const release = store.acquireLeadLock(plan.planHash);
  try {
    await assert.rejects(
      runTaskOrchestrator({
        taskRunId: "run_fixture",
        plan,
        fleetProvider: async () => fleet(["cap.a"]),
        worker: { execute: async (nextAssignment) => accepted(nextAssignment) },
        store,
      }),
      /LEAD_ALREADY_RUNNING/,
    );
  } finally {
    release();
  }
}));

test("receipt fencing rejects forged assignment fields and job binding", async () => withStore(async (store) => {
  const plan = planWith({ nodes: [{ nodeId: "fence", executor: executor("cap.a"), shards: [{ params: {} }] }] });
  await assert.rejects(
    runTaskOrchestrator({
      taskRunId: "run_fixture",
      plan,
      fleetProvider: async () => fleet(["cap.a"]),
      worker: {
        async execute(nextAssignment) {
          await nextAssignment.onProgress({ type: "job_bound", jobId: "job_expected", runId: "run_expected", status: "running" });
          const receipt = accepted(nextAssignment);
          receipt.alias = "04";
          receipt.jobId = "job_forged";
          return receipt;
        },
      },
      store,
    }),
    /WORK_RECEIPT_FENCING_MISMATCH/,
  );
}));

test("attempt receipt is create-or-compare and cannot be overwritten", async () => withStore(async (store) => {
  const plan = planWith({ nodes: [{ nodeId: "receipt", executor: executor("cap.a"), shards: [{ params: {} }] }] });
  store.init(plan);
  const nextAssignment = {
    taskRunId: "run_fixture",
    planHash: plan.planHash,
    node: plan.nodes[0],
    shard: plan.nodes[0].shards[0],
    alias: "01",
    workerId: "worker-1",
    attemptIndex: 0,
    attemptId: "attempt_receipt_0",
  };
  const receipt = accepted(nextAssignment, { value: 1 });
  const first = store.writeReceipt(receipt);
  assert.equal(store.writeReceipt(receipt), first);
  assert.throws(() => store.writeReceipt({ ...receipt, output: { value: 2 } }), /ATTEMPT_RECEIPT_CONFLICT/);
}));
