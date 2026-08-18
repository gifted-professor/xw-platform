import assert from "node:assert/strict";
import test from "node:test";

import { decideProtectedCommit, mapProtectedToMissionPhc } from "../control-plane/lib/protected-commit-policy.mjs";
import {
  normalizeCapabilityEffect,
  computeCapabilityContractHash,
  attachNormalizedEffect,
  isBusinessEffectClass,
} from "../control-plane/lib/capability-effect.mjs";
import { decideRawPrimitivePolicy, assertRawPrimitiveAllowed } from "../control-plane/lib/raw-primitive-policy.mjs";
import { decideCapabilityPolicy, assertAuthorizationAllow } from "../control-plane/lib/authorization-decision.mjs";
import { evaluateMissionEffect } from "../control-plane/lib/mission-policy.mjs";
import { evaluateNonpaymentAutonomy } from "../control-plane/lib/nonpayment-autonomy-policy.mjs";
import { ControlPlaneError } from "../control-plane/lib/errors.mjs";

function baseCap(over = {}) {
  return {
    schemaVersion: 1,
    id: "test.cap.sample",
    appId: "test",
    packageName: "com.test",
    versionRange: "*",
    maturity: "E2",
    risk: "R0",
    resources: ["device"],
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    preconditions: [],
    verification: { mode: "none", description: "n" },
    restoration: { required: false, description: "n" },
    timeoutMs: 1000,
    idempotency: "read_only",
    automationPolicy: { mode: "automatic" },
    implementation: { adapter: "test", action: "noop" },
    evidence: [],
    availability: "implemented",
    ...over,
  };
}

test("INV-01: protected kernel covers publish/payment/delete final only", () => {
  assert.equal(decideProtectedCommit({ class: "publish", phase: "final" }).protected, true);
  assert.equal(decideProtectedCommit({ class: "payment", phase: "final" }).protected, true);
  assert.equal(decideProtectedCommit({ class: "delete", phase: "final" }).protected, true);
  assert.equal(decideProtectedCommit({ class: "publish", phase: "prepare" }).protected, false);
  assert.equal(decideProtectedCommit({ class: "social", phase: "final" }).protected, false);
  const phc = mapProtectedToMissionPhc(decideProtectedCommit({ class: "publish", phase: "final" }));
  assert.equal(phc.decision, "phc");
  assert.equal(phc.code, "PROTECTED_COMMIT_REQUIRED");
});

test("effect matrix accepts legal and rejects illegal combinations", () => {
  const ok = normalizeCapabilityEffect(baseCap({
    effect: { class: "publish", phase: "prepare", commitBoundary: "automatic" },
  }));
  assert.equal(ok.class, "publish");
  assert.equal(ok.legacyDerived, false);

  assert.throws(
    () => normalizeCapabilityEffect(baseCap({
      effect: { class: "publish", phase: "final", commitBoundary: "automatic" },
    })),
    (err) => err.code === "EFFECT_CONTRACT_MISMATCH",
  );
});

test("contract hash is stable for same capability", () => {
  const a = attachNormalizedEffect(baseCap({
    effect: { class: "none", phase: "na", commitBoundary: "automatic" },
  }));
  const b = attachNormalizedEffect(baseCap({
    effect: { class: "none", phase: "na", commitBoundary: "automatic" },
  }));
  assert.equal(a.capabilityContractHash, b.capabilityContractHash);
  assert.equal(a.capabilityContractHash.length, 64);
  const c = attachNormalizedEffect(baseCap({
    effect: { class: "social", phase: "final", commitBoundary: "automatic" },
    risk: "R2",
    idempotency: "external_effect",
  }));
  assert.notEqual(a.capabilityContractHash, c.capabilityContractHash);
  assert.equal(isBusinessEffectClass(c.normalizedEffect.class), true);
});

test("INV-05: raw public only allows readonly observations", () => {
  assert.equal(decideRawPrimitivePolicy("session", "screen").allowed, true);
  assert.equal(decideRawPrimitivePolicy("session", "dump_ui").allowed, true);
  assert.equal(decideRawPrimitivePolicy("session", "tap").allowed, false);
  assert.equal(decideRawPrimitivePolicy("session", "home").allowed, false);
  assert.equal(decideRawPrimitivePolicy("session", "launch_app").allowed, false);
  assert.equal(decideRawPrimitivePolicy("session", "back").allowed, false);
  assert.equal(decideRawPrimitivePolicy("session", "tap").reasonCode, "RAW_INTERACTIVE_PRIMITIVE_DISABLED_P0");
  assert.throws(() => assertRawPrimitiveAllowed("session", "home"), (e) => e instanceof ControlPlaneError);
});

test("authorization: shadow blocks business effect without ordinary approval", () => {
  const cap = attachNormalizedEffect(baseCap({
    risk: "R2",
    idempotency: "external_effect",
    effect: { class: "social", phase: "final", commitBoundary: "automatic" },
  }));
  const shadow = decideCapabilityPolicy(cap, { policyMode: { mode: "shadow", active: false } });
  assert.equal(shadow.decision, "block");
  assert.equal(shadow.reasonCode, "AUTONOMY_INACTIVE");
  assert.equal(shadow.approvalRequired, false);

  const active = decideCapabilityPolicy(cap, {
    policyMode: { mode: "nonpayment_v1", active: true, effectiveDecisionSource: "deployed-runtime", pilotScope: "in_scope" },
  });
  assert.equal(active.decision, "allow");
  assert.equal(active.reasonCode, "NONPAYMENT_AUTONOMY_ACTIVE");
});

test("authorization: protected final is wait_human_commit in any mode", () => {
  const cap = attachNormalizedEffect(baseCap({
    financialCommit: true,
  }));
  const auth = decideCapabilityPolicy(cap, {
    policyMode: { mode: "nonpayment_v1", active: true },
  });
  assert.equal(auth.decision, "wait_human_commit");
  assert.equal(auth.reasonCode, "PROTECTED_COMMIT_REQUIRED");
  assert.throws(() => assertAuthorizationAllow(auth), (e) => e.status === 409);
});

test("authorization: pilot out-of-scope is strict block", () => {
  const cap = attachNormalizedEffect(baseCap({
    effect: { class: "social", phase: "final", commitBoundary: "automatic" },
    risk: "R2",
    idempotency: "external_effect",
  }));
  const auth = decideCapabilityPolicy(cap, {
    policyMode: {
      mode: "nonpayment_v1",
      active: false,
      pilotOnly: true,
      pilotScope: "out_of_scope",
      effectiveDecisionSource: "shadow",
    },
  });
  assert.equal(auth.decision, "block");
  assert.equal(auth.reasonCode, "AUTONOMY_PILOT_SCOPE_MISS");
});

test("Mission publish/delete always phc even with allow_within_scope", () => {
  const mission = {
    status: "active",
    validity: { expiresAt: new Date(Date.now() + 3600_000).toISOString() },
    policy: { publish: "allow_within_scope", delete: "allow_within_scope" },
    scope: { actions: ["publish", "delete", "like"], targets: { values: [] } },
  };
  const pub = evaluateMissionEffect(mission, { action: "publish", target: null });
  assert.equal(pub.decision, "phc");
  assert.equal(pub.reason, "PROTECTED_COMMIT_REQUIRED");
  const del = evaluateMissionEffect(mission, { action: "delete", target: null });
  assert.equal(del.decision, "phc");
});

test("unknown nonpayment route requires typed capability, not interactive explorer", () => {
  const v = evaluateNonpaymentAutonomy({ actionClass: "unknown", knownCapability: false });
  assert.equal(v.decision, "typed_capability_required");
  assert.equal(v.reasonCode, "TYPED_CAPABILITY_REQUIRED");
  assert.equal(v.humanApprovalRequired, false);

  const ro = evaluateNonpaymentAutonomy({ actionClass: "observe", knownCapability: false, readonlyObservation: true });
  assert.equal(ro.decision, "dispatch_explorer_readonly");
});

test("hash helper export works", () => {
  const h = computeCapabilityContractHash(baseCap({
    effect: { class: "none", phase: "na", commitBoundary: "automatic" },
  }));
  assert.match(h, /^[0-9a-f]{64}$/);
});
