import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MissionWorkerRouter,
  SessionWorkflowWorker,
  actionIdempotencyKey,
  validateWorkflowBusinessOutput,
} from "../scripts/lib/session-workflow-worker.mjs";
import { createTaskPlanV2 } from "../scripts/lib/task-plan-v2.mjs";
import { compileWorkflowNodeAuthoring, getWorkflow } from "../scripts/lib/workflow-catalog.mjs";
import { OrchestrationStore } from "../scripts/lib/orchestration-store.mjs";
import { runTaskOrchestrator } from "../scripts/lib/task-orchestrator.mjs";
import { resetExplorerSessionActionPinsForTests } from "../ops/_explore-session-action.mjs";
import {
  assertExplorerSessionIdentity,
  explorerSessionIdentity,
} from "../ops/_explore-lease.mjs";

function fakeSessionClient({ balancesByAlias = {}, failReleaseAlias = null } = {}) {
  const sessions = new Map();
  const leases = new Map();
  let seq = 0;
  return {
    sessions,
    leases,
    async acquireSession({ actorId, alias, capabilityId }) {
      seq += 1;
      const sessionId = `sess_${alias}_${seq}`;
      const leaseId = `lease_${alias}_${seq}`;
      const token = `tok_${alias}_${seq}`;
      sessions.set(sessionId, { alias, actorId, capabilityId, token, leaseId });
      leases.set(leaseId, { leaseId, holderId: actorId, alias, kind: "interactive" });
      return { sessionId, leaseId, token, alias, deviceId: `dev_${alias}` };
    },
    async assertLeaseVisible(leaseId) {
      if (!leases.has(leaseId)) throw Object.assign(new Error("not visible"), { code: "EXPLORER_LEASE_NOT_VISIBLE" });
      return leases.get(leaseId);
    },
    async sessionAction({ sessionId, token, alias, params, idempotencyKey }) {
      const session = sessions.get(sessionId);
      if (!session || session.token !== token) throw Object.assign(new Error("bad session"), { code: "SESSION_INVALID" });
      seq += 1;
      const amount = balancesByAlias[alias];
      const output = {
        packageName: "com.tencent.mm",
        activity: "com.tencent.mm.plugin.mall.ui.WalletBalance",
        paymentTransport: 0,
        finalCommit: false,
        ...(amount != null
          ? {
              amountCny: amount,
              currency: "CNY",
              capturedAt: "2026-08-08T00:00:00.000Z",
              amountCandidates: [amount],
            }
          : {}),
        primitive: params.primitive,
        idempotencyKey,
      };
      return {
        jobId: `job_${alias}_${seq}`,
        runId: `run_${alias}_${seq}`,
        status: "succeeded",
        output,
        frame: { width: 1080, height: 2400 },
      };
    },
    async releaseSession({ sessionId, token }) {
      const session = sessions.get(sessionId);
      if (!session || session.token !== token) throw Object.assign(new Error("bad release"), { code: "SESSION_INVALID" });
      if (failReleaseAlias && session.alias === failReleaseAlias) {
        throw Object.assign(new Error("release failed"), { code: "RELEASE_FAILED" });
      }
      sessions.delete(sessionId);
      leases.delete(session.leaseId);
      return { ok: true };
    },
  };
}

test("action idempotency keys are stable for the same attempt", () => {
  const a = actionIdempotencyKey({
    taskRunId: "run_x",
    shardKey: "a".repeat(64),
    actionIndex: 0,
    attemptIndex: 1,
    actionId: "launch_wechat",
  });
  const b = actionIdempotencyKey({
    taskRunId: "run_x",
    shardKey: "a".repeat(64),
    actionIndex: 0,
    attemptIndex: 1,
    actionId: "launch_wechat",
  });
  assert.equal(a, b);
  assert.match(a, /^m2:run_x:/);
});

test("workflow business validator accepts focus.package and enforces payment zeros", () => {
  assert.equal(validateWorkflowBusinessOutput({
    acceptance: {
      requiredFields: ["amountCny", "currency", "capturedAt"],
      amountMustBeUniqueOnScreen: true,
      paymentTransport: 0,
      finalCommit: false,
    },
    expectedApp: { package: "com.tencent.mm", activityIncludes: ["Mall", "Wallet", "balance"] },
    output: {
      amountCny: "12.34",
      currency: "CNY",
      capturedAt: "t",
      paymentTransport: 0,
      finalCommit: false,
      amountCandidates: ["12.34"],
      focus: { package: "com.tencent.mm", activity: "com.tencent.mm.plugin.mall.ui.MallIndexUIv2" },
    },
  }).ok, true);
  assert.equal(validateWorkflowBusinessOutput({
    acceptance: {
      requiredFields: ["amountCny", "currency", "capturedAt"],
      amountMustBeUniqueOnScreen: true,
      paymentTransport: 0,
      finalCommit: false,
    },
    output: {
      amountCny: "12.34",
      currency: "CNY",
      capturedAt: "t",
      paymentTransport: 0,
      finalCommit: false,
      amountCandidates: ["12.34"],
    },
  }).ok, true);
  assert.equal(validateWorkflowBusinessOutput({
    acceptance: { paymentTransport: 0, finalCommit: false, requiredFields: ["amountCny"] },
    output: { amountCny: "1", paymentTransport: 1, finalCommit: false },
  }).ok, false);
  assert.equal(validateWorkflowBusinessOutput({
    acceptance: { amountMustBeUniqueOnScreen: true, requiredFields: [] },
    output: { amountCandidates: ["1", "2"] },
  }).code, "AMOUNT_NOT_UNIQUE");
});

test("SessionWorkflowWorker JIT acquires, runs actions, releases, and accepts balance output", async () => {
  const client = fakeSessionClient({ balancesByAlias: { "01": "88.00" } });
  const worker = new SessionWorkflowWorker({ client, actorId: "fixture-actor" });
  const workflow = getWorkflow("workflow.wechat.balance-read.v1");
  const node = compileWorkflowNodeAuthoring(workflow, { aliases: ["01"], nodeId: "bal" });
  const plan = createTaskPlanV2({
    goal: "单机微信余额",
    requestKey: "sw-worker-single",
    nodes: [node],
  });
  const assignment = {
    taskRunId: "run_sw_1",
    planHash: plan.planHash,
    node: plan.nodes[0],
    shard: plan.nodes[0].shards[0],
    attemptId: "att_1",
    attemptIndex: 1,
    workerId: "w1",
    alias: "01",
  };
  const receipt = await worker.execute(assignment);
  assert.equal(receipt.technicalStatus, "succeeded");
  assert.equal(receipt.businessStatus, "accepted");
  assert.equal(receipt.output.amountCny, "88.00");
  assert.equal(receipt.output.paymentTransport, 0);
  assert.equal(receipt.output.finalCommit, false);
  assert.equal(receipt.output.sessionReleased, true);
  assert.equal(client.sessions.size, 0);
  assert.equal(client.leases.size, 0);
  assert.equal(receipt.output.actions.length, workflow.actions.length);
});

test("SessionWorkflowWorker always releases on failure and blocks unauthorized tap", async () => {
  const client = fakeSessionClient({ balancesByAlias: { "02": "1.00" } });
  const worker = new SessionWorkflowWorker({
    client,
    actorId: "fixture-actor",
    workflowResolver: () => ({
      ...getWorkflow("workflow.wechat.balance-read.v1"),
      actions: [
        { actionId: "tap_wallet", primitive: "tap", params: { x: 1, y: 2 } },
      ],
      tapAuthorized: false,
    }),
  });
  const plan = createTaskPlanV2({
    goal: "tap blocked",
    requestKey: "sw-tap-block",
    nodes: [compileWorkflowNodeAuthoring(getWorkflow("workflow.wechat.balance-read.v1"), { aliases: ["02"] })],
  });
  // override executor actions via params
  plan.nodes[0].shards[0].params = { actions: [{ actionId: "tap_wallet", primitive: "tap", params: { x: 1, y: 2 } }] };
  const receipt = await worker.execute({
    taskRunId: "run_sw_tap",
    planHash: plan.planHash,
    node: plan.nodes[0],
    shard: plan.nodes[0].shards[0],
    attemptId: "att_tap",
    attemptIndex: 1,
    workerId: "w2",
    alias: "02",
  });
  assert.equal(receipt.technicalStatus, "failed");
  assert.equal(receipt.error.code, "TAP_NOT_AUTHORIZED");
  assert.equal(client.sessions.size, 0);
});

test("four concurrent session workers use distinct sessions without identity pin collision", async () => {
  resetExplorerSessionActionPinsForTests();
  const pins = new Map();
  // Simulate the fixed per-session pin logic used by executeExplorerSessionAction
  function pin(auth) {
    const id = explorerSessionIdentity(auth);
    const prev = pins.get(auth.session.sessionId);
    if (!prev) pins.set(auth.session.sessionId, id);
    else assertExplorerSessionIdentity(prev, auth);
  }
  const auths = ["01", "02", "03", "04"].map((alias) => ({
    contextId: `ctx_${alias}`,
    session: { sessionId: `sess_${alias}` },
    lease: { leaseId: `lease_${alias}` },
    actorId: "actor",
    deviceId: `dev_${alias}`,
  }));
  for (const auth of auths) pin(auth);
  for (const auth of auths) pin(auth); // re-pin same session ok
  assert.equal(pins.size, 4);
  assert.throws(() => {
    assertExplorerSessionIdentity(pins.get("sess_01"), {
      ...auths[0],
      session: { sessionId: "sess_01" },
      lease: { leaseId: "lease_OTHER" },
    });
  }, /IDENTITY_CHANGED|identity changed/i);

  const client = fakeSessionClient({
    balancesByAlias: { "01": "1", "02": "2", "03": "3", "04": "4" },
  });
  const worker = new SessionWorkflowWorker({ client, actorId: "conc-actor" });
  const node = compileWorkflowNodeAuthoring(getWorkflow("workflow.wechat.balance-read.v1"));
  const plan = createTaskPlanV2({
    goal: "四机余额",
    requestKey: "sw-four",
    nodes: [node],
  });
  const root = mkdtempSync(join(tmpdir(), "xw-sw-"));
  try {
    const store = new OrchestrationStore({ taskRunId: "run_sw_four", workRoot: root });
    const typedStub = { execute: async () => { throw new Error("typed should not run"); } };
    const router = new MissionWorkerRouter({ typedJobWorker: typedStub, sessionWorkflowWorker: worker });
    const result = await runTaskOrchestrator({
      taskRunId: "run_sw_four",
      plan,
      fleetProvider: () => ["01", "02", "03", "04"].map((alias) => ({
        alias,
        online: true,
        ready: true,
        lease: "free",
        quarantined: false,
        unresolvedFailure: null,
        capabilityIds: ["xiaowei.explorer.primitive"],
      })),
      worker: router,
      store,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.summary?.accepted, 4);
    assert.equal(result.summary?.failed, 0);
    assert.equal(client.sessions.size, 0);
    assert.equal(client.leases.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
