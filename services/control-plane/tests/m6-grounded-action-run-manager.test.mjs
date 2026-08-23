import assert from "node:assert/strict";
import test from "node:test";

import { deriveM64ActionSlotAuthority, deriveM64ScenarioActionPlan } from "../../../packages/kernel/lib/m6-4-cohort.mjs";
import { deriveM6TrustedParameterHash } from "../../../packages/kernel/lib/m6-action-slot.mjs";
import { createM6GroundedActionRunManager } from "../control-plane/lib/m6-grounded-action-run-manager.mjs";

const H = (letter) => letter.repeat(64);
const binding = Object.freeze({ runId: "run:manager-test", workerId: "worker:manager-test", sessionId: "session:manager-test", alias: "01", processRef: "process:manager-test", gateEpochHash: H("a"), generation: 1, purpose: "M6_4_ACTION_SMOKE", scenarioManifestHash: H("b"), liveWindowAuthorizationHash: H("c"), bindingHash: H("d") });

function actionPlan(count = 2) {
  return deriveM64ScenarioActionPlan({
    slots: Array.from({ length: count }, (_, index) => deriveM64ActionSlotAuthority({
      schemaId: "xw.m6-action-slot-authority.v1",
      sequenceIndex: index,
      logicalStepId: `step-${index + 1}`,
      actionSlotOrdinal: index,
      primitive: index === 0 ? "tap" : "back",
      actionFamily: `test:${index + 1}`,
      intentRef: H(index === 0 ? "4" : "5"),
      intentPolicyHash: H("6"),
      targetKind: index === 0 ? "block" : "none",
      targetEligibilityHash: H("7"),
      trustedParams: {},
      trustedParameterHash: deriveM6TrustedParameterHash({}),
      allowedStateHash: H("8"),
      effectBoundaryHash: H("9"),
      budgetPolicyHash: H("a"),
      redlinePolicyHash: H("b"),
      resetPolicyHash: H("c"),
      oracleHash: H("d"),
      verificationPolicyHash: H("e"),
    })),
  });
}

function manager() {
  let sends = 0;
  const value = createM6GroundedActionRunManager({
    async observe() { return { externalEffect: false, actionCount: 0, frameRef: H("e") }; },
    async ground({ slotAuthority }) {
      const suffix = String(slotAuthority.sequenceIndex + 1);
      return { externalEffect: false, actionCount: 0, disposition: "ALLOW_ONCE", decisionRef: H(suffix === "1" ? "f" : "a"), operationKey: H(suffix) };
    },
    async act({ slotAuthority }) {
      sends += 1;
      return { externalEffect: true, actionCount: 1, effectStatus: "VERIFIED", actionReceiptRef: H(slotAuthority.sequenceIndex === 0 ? "2" : "7"), verificationRef: H("3") };
    },
    async verify() { return { externalEffect: false, actionCount: 0, verified: true, verificationRef: H("3") }; },
    async checkpointAudit() { return { externalEffect: false, actionCount: 0, checkpointRef: H("4") }; },
    async trace() { return { externalEffect: false, actionCount: 0, traceRefs: [H("5")] }; },
    async waitHuman() { return { externalEffect: false, actionCount: 0, status: "WAITING" }; },
    async complete({ run }) { return { externalEffect: false, actionCount: 0, workerRunRef: run.workerRunRef, status: "COMPLETED" }; },
    async close() { return { schemaId: "xw.m6-run-close.v1", verifiedClosed: true }; },
  });
  value.openRun({
    binding,
    authorizationId: "auth-1",
    workerRunRef: "worker:manager-test",
    context: { serverPrivate: true, scenario: { actionPlan: actionPlan(2) } },
  });
  return { value, sends: () => sends };
}

test("run manager preserves ordered slots, permits distinct actions, and rejects per-slot replay", async () => {
  const { value, sends } = manager();
  await value.handleToolCall({ method: "worker_start", params: { workerRunRef: "worker:manager-test" }, binding });
  const observed = await value.handleToolCall({ method: "phone_observe", params: { runRef: "run:manager-test", stepRef: "step:manager-test" }, binding });
  const grounded = await value.handleToolCall({ method: "phone_ground", params: { frameRef: observed.frameRef, intentRef: H("6") }, binding });
  const acted = await value.handleToolCall({ method: "phone_act", params: { decisionRef: grounded.decisionRef, operationKey: grounded.operationKey }, binding });
  assert.equal(acted.actionCount, 1);
  assert.equal(sends(), 1);
  await assert.rejects(() => value.handleToolCall({ method: "phone_act", params: { decisionRef: grounded.decisionRef, operationKey: grounded.operationKey }, binding }), { code: "M6_LIVE_ACTION_REPLAY" });
  assert.equal(sends(), 1);
  await value.handleToolCall({ method: "phone_verify", params: { actionReceiptRef: acted.actionReceiptRef, expectationRef: H("8") }, binding });
  const observed2 = await value.handleToolCall({ method: "phone_observe", params: { runRef: "run:manager-test", stepRef: "step:manager-test-2" }, binding });
  const grounded2 = await value.handleToolCall({ method: "phone_ground", params: { frameRef: observed2.frameRef, intentRef: H("8") }, binding });
  const acted2 = await value.handleToolCall({ method: "phone_act", params: { decisionRef: grounded2.decisionRef, operationKey: grounded2.operationKey }, binding });
  await value.handleToolCall({ method: "phone_verify", params: { actionReceiptRef: acted2.actionReceiptRef, expectationRef: H("8") }, binding });
  assert.equal(value.getRun(binding.runId).actionCount, 2);
  assert.equal(sends(), 2);
  await value.handleToolCall({ method: "worker_complete", params: { workerRunRef: "worker:manager-test", outcome: "SUCCEEDED" }, binding });
  await assert.rejects(
    () => value.handleToolCall({ method: "phone_observe", params: { runRef: binding.runId, stepRef: "step:after-complete" }, binding }),
    { code: "M6_LIVE_RUN_TERMINAL" },
  );
});

test("run manager refuses M6-5 resume and clears private context only after verified close", async () => {
  const { value } = manager();
  await assert.rejects(() => value.handleToolCall({ method: "worker_continue", params: { workerRunRef: "worker:manager-test", checkpointRef: H("7") }, binding }), { code: "M6_LIVE_RESUME_NOT_ENABLED" });
  const receipt = await value.closeRun(binding.runId, "test");
  assert.equal(receipt.verifiedClosed, true);
  assert.equal(value.getRun(binding.runId).closed, true);
  assert.equal(value.forgetClosedRun(binding.runId), true);
  assert.equal(value.getRun(binding.runId), null);
});

test("shadow and hot-close purposes reject phone_act before the physical callback", async () => {
  for (const purpose of ["M6_4_SHADOW", "M6_4_HOT_CLOSE"]) {
    let sends = 0;
    const currentBinding = Object.freeze({ ...binding, runId: `run:${purpose.toLowerCase()}`, purpose });
    const value = createM6GroundedActionRunManager({
      async observe() { return { externalEffect: false, actionCount: 0, frameRef: H("e") }; },
      async ground() { return { externalEffect: false, actionCount: 0, disposition: "ALLOW_ONCE", decisionRef: H("f"), operationKey: H("1") }; },
      async act() { sends += 1; return { externalEffect: true, actionCount: 1, effectStatus: "VERIFIED", actionReceiptRef: H("2"), verificationRef: H("3") }; },
      async verify() { return { externalEffect: false, actionCount: 0, verified: true, verificationRef: H("3") }; },
      async checkpointAudit() { return { externalEffect: false, actionCount: 0, checkpointRef: H("4") }; },
      async trace() { return { externalEffect: false, actionCount: 0, traceRefs: [H("5")] }; },
      async waitHuman() { return { externalEffect: false, actionCount: 0, status: "WAITING" }; },
      async complete({ run }) { return { externalEffect: false, actionCount: 0, workerRunRef: run.workerRunRef, status: "FAILED" }; },
      async close() { return { schemaId: "xw.m6-run-close.v1", verifiedClosed: true }; },
    });
    value.openRun({
      binding: currentBinding,
      authorizationId: `auth-${purpose}`,
      workerRunRef: "worker:manager-test",
      context: { scenario: { actionPlan: actionPlan(0) } },
    });
    await value.handleToolCall({ method: "worker_start", params: { workerRunRef: "worker:manager-test" }, binding: currentBinding });
    const observed = await value.handleToolCall({ method: "phone_observe", params: { runRef: currentBinding.runId, stepRef: "step:manager-test" }, binding: currentBinding });
    const grounded = await value.handleToolCall({ method: "phone_ground", params: { frameRef: observed.frameRef, intentRef: H("6") }, binding: currentBinding });
    await assert.rejects(
      () => value.handleToolCall({ method: "phone_act", params: { decisionRef: grounded.decisionRef, operationKey: grounded.operationKey }, binding: currentBinding }),
      { code: "M6_LIVE_ZERO_ACTION_PURPOSE" },
    );
    assert.equal(sends, 0);
  }
});
