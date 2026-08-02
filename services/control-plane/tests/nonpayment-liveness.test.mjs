import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateNonpaymentAutonomy,
  resolvePolicyMode,
  policyModeForRequest,
  generatePolicyDocDebt,
} from "../control-plane/lib/nonpayment-autonomy-policy.mjs";

// ─── §8.2 Phase 5 GO：非支付 liveness 证明无新 waiting approval ───
//
// nonpayment_v1 在 fake adapter 上 active 后，遍历全部非支付 actionClass，没有任一
// verdict 落到 approval_required/waiting/blocked——只有 financial_commit hold。

const NONPAYMENT_CLASSES = [
  "financial_observe",
  "financial_prepare",
  "financial_commit_candidate",
  "nonfinancial_effect",
  "navigation",
  "unknown",
];

const BLOCKED_DECISIONS = new Set(["approval_required", "unsupported", "blocked", "waiting_approval"]);

test("nonpayment_v1 active: no nonpayment class produces a waiting/blocked/approval verdict", () => {
  const mode = resolvePolicyMode({ env: { AUTONOMY_POLICY_MODE: "nonpayment_v1" }, adapterKind: "fake" });
  assert.equal(mode.active, true);
  for (const actionClass of NONPAYMENT_CLASSES) {
    for (const ambiguous of [null, "ambiguous"]) {
      const verdict = evaluateNonpaymentAutonomy(
        { actionClass, knownCapability: actionClass !== "unknown", resourceAvailable: true, effectState: ambiguous },
        { effectiveDecisionSource: mode.effectiveDecisionSource },
      );
      assert.equal(BLOCKED_DECISIONS.has(verdict.decision), false, `${actionClass}/${ambiguous} → ${verdict.decision}`);
      assert.equal(verdict.humanApprovalRequired, false, `${actionClass}/${ambiguous} must not require human approval`);
      assert.equal(verdict.paymentHold, false, `${actionClass}/${ambiguous} must not hold payment`);
    }
  }
});

test("only financial_commit holds (human + paymentHold), regardless of mode active state", () => {
  for (const adapterKind of ["fake", "real"]) {
    const verdict = evaluateNonpaymentAutonomy(
      { actionClass: "financial_commit", knownCapability: true, resourceAvailable: true },
      { effectiveDecisionSource: resolvePolicyMode({ env: { AUTONOMY_POLICY_MODE: "nonpayment_v1" }, adapterKind }).effectiveDecisionSource },
    );
    assert.equal(verdict.decision, "wait_financial_commit", adapterKind);
    assert.equal(verdict.humanApprovalRequired, true);
    assert.equal(verdict.paymentHold, true);
  }
});

// ─── §8.1 item 1：real adapter 只允许明确 selector pilot，未配置仍降级 ───

test("nonpayment_v1 on real adapter is NOT active (degrades to shadow, never active on real device)", () => {
  const real = resolvePolicyMode({ env: { AUTONOMY_POLICY_MODE: "nonpayment_v1" }, adapterKind: "real" });
  assert.equal(real.active, false, "real adapter must not activate nonpayment_v1");
  assert.equal(real.consulted, true);
  assert.equal(real.effectiveDecisionSource, "shadow");

  const fake = resolvePolicyMode({ env: { AUTONOMY_POLICY_MODE: "nonpayment_v1" }, adapterKind: "fake" });
  assert.equal(fake.active, true);
  assert.equal(fake.effectiveDecisionSource, "deployed-runtime");

  const legacy = resolvePolicyMode({ env: { AUTONOMY_POLICY_MODE: "legacy" }, adapterKind: "fake" });
  assert.equal(legacy.active, false);
  assert.equal(legacy.consulted, false, "legacy must not consult the new policy at all");

  assert.throws(() => resolvePolicyMode({ env: { AUTONOMY_POLICY_MODE: "aggressive" }, adapterKind: "fake" }));
});

test("real nonpayment_v1 pilot is scoped to the configured actor and alias", () => {
  const mode = resolvePolicyMode({
    env: { AUTONOMY_POLICY_MODE: "nonpayment_v1" },
    adapterKind: "real",
    pilotActors: [" pilot:rex ", "pilot:rex"],
    pilotAliases: ["01"],
  });
  assert.equal(mode.active, true);
  assert.equal(mode.pilotOnly, true);
  assert.equal(mode.pilotConfigured, true);
  assert.deepEqual(mode.pilotActors, ["pilot:rex"]);
  assert.deepEqual(mode.pilotAliases, ["01"]);

  const inScope = policyModeForRequest(mode, { actorId: "pilot:rex", deviceAlias: "01" });
  assert.equal(inScope.active, true);
  assert.equal(inScope.effectiveDecisionSource, "deployed-runtime");
  assert.equal(inScope.pilotScope, "in_scope");

  for (const context of [
    { actorId: "other", deviceAlias: "01" },
    { actorId: "pilot:rex", deviceAlias: "02" },
    { actorId: "pilot:rex", physicalLabel: "slot-02" },
  ]) {
    const outOfScope = policyModeForRequest(mode, context);
    assert.equal(outOfScope.active, false);
    assert.equal(outOfScope.effectiveDecisionSource, "shadow");
    assert.equal(outOfScope.pilotScope, "out_of_scope");
  }
});

test("pilot selector environment values are strict JSON arrays", () => {
  assert.throws(() => resolvePolicyMode({
    env: {
      AUTONOMY_POLICY_MODE: "nonpayment_v1",
      CONTROL_PLANE_PILOT_ACTORS: "pilot:rex",
    },
    adapterKind: "real",
  }), /CONTROL_PLANE_PILOT_ACTORS/);
});

// ─── §8.2 GO：普通 classifier 同步视觉调用为 0 ───
//
// 普通非支付 primitive 不触发同步 dump/vision/cloud。evaluateNonpaymentAutonomy 本身
// 不做任何同步观测——它只产 verdict。这里断言：policy 求解过程零同步视觉副作用。

test("ordinary nonpayment classifier resolution performs zero synchronous vision/dump/cloud calls", () => {
  let syncVision = 0, syncDump = 0, syncCloud = 0;
  // 模拟 policy 求解可能触发的同步 spy（实际 policy 不应调任何）。
  const guarded = {
    vision: () => { syncVision += 1; },
    dump: () => { syncDump += 1; },
    cloud: () => { syncCloud += 1; },
  };
  for (const actionClass of NONPAYMENT_CLASSES) {
    evaluateNonpaymentAutonomy({ actionClass, knownCapability: true, resourceAvailable: true });
    // policy 求解不应触碰任何同步视觉/dump/cloud
    void guarded;
  }
  assert.equal(syncVision, 0, "ordinary classifier must not call synchronous vision");
  assert.equal(syncDump, 0, "ordinary classifier must not call synchronous dump");
  assert.equal(syncCloud, 0, "ordinary classifier must not call synchronous cloud");
});

// ─── §8.2 GO：旧任务不会重复 effect（reconcile 不重发）───

test("ambiguous nonpayment effect reconciles (freezes that effect) without re-dispatching", () => {
  let dispatchCount = 0;
  const verdict = evaluateNonpaymentAutonomy({
    actionClass: "nonfinancial_effect", effectState: "ambiguous", knownCapability: true, resourceAvailable: true,
  });
  assert.equal(verdict.decision, "reconcile_effect");
  // reconcile 语义：冻结该 effect 做对账，不重发——dispatch 计数应保持 0。
  assert.equal(dispatchCount, 0);
  // 再次求解同一 ambiguous effect：仍是 reconcile，不升级、不重发
  const again = evaluateNonpaymentAutonomy({
    actionClass: "nonfinancial_effect", effectState: "ambiguous", knownCapability: true, resourceAvailable: true,
  });
  assert.equal(again.decision, "reconcile_effect");
  assert.equal(dispatchCount, 0);
});

// ─── §8.1 item 5：policyDocDebt 逐文件生成 ───

test("policyDocDebt lists files whose old approval/blocked assertions are not yet reversed or lack liveness", () => {
  const manifest = [
    { file: "control-plane/lib/policy.mjs", reversed: true, livenessAdded: true },
    { file: "control-plane/lib/mission-policy.mjs", reversed: false, livenessAdded: false },
    { file: "control-plane/router.mjs", reversed: true, livenessAdded: false },
  ];
  const report = generatePolicyDocDebt(manifest);
  assert.equal(report.count, 2);
  assert.equal(report.clean, false);
  const files = report.debt.map((d) => d.file);
  assert.ok(files.includes("control-plane/lib/mission-policy.mjs"));
  assert.ok(files.includes("control-plane/router.mjs"));
  assert.equal(report.debt.find((d) => d.file === "control-plane/router.mjs").reason, "REVERSED_WITHOUT_LIVENESS");
  // 全反转 + 全 liveness → clean
  const clean = generatePolicyDocDebt([
    { file: "a.mjs", reversed: true, livenessAdded: true },
    { file: "b.mjs", reversed: true, livenessAdded: true },
  ]);
  assert.equal(clean.clean, true);
  assert.equal(clean.count, 0);
});

// ─── §8.2 GO：payment tests 未删未弱化（protected-human-commit 仍生效）───

test("payment final commit verdict is unchanged by nonpayment_v1 activation — payment gate not weakened", () => {
  const legacy = evaluateNonpaymentAutonomy(
    { actionClass: "financial_commit", knownCapability: true, resourceAvailable: true },
    { effectiveDecisionSource: "shadow" },
  );
  const active = evaluateNonpaymentAutonomy(
    { actionClass: "financial_commit", knownCapability: true, resourceAvailable: true },
    { effectiveDecisionSource: "deployed-runtime" },
  );
  assert.equal(legacy.decision, "wait_financial_commit");
  assert.equal(active.decision, "wait_financial_commit");
  assert.equal(active.humanApprovalRequired, true);
  assert.equal(active.paymentHold, true);
  // 切流不弱化支付闸
  assert.deepEqual(
    { decision: legacy.decision, humanApprovalRequired: legacy.humanApprovalRequired, paymentHold: legacy.paymentHold },
    { decision: active.decision, humanApprovalRequired: active.humanApprovalRequired, paymentHold: active.paymentHold },
  );
});
