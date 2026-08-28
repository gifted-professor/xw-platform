// xhs-routine-canary-scope.test.mjs — deployed canary policy regression for
// the 03-first routine plan V2 §5.2: the production launch script pins
// pilotActors=["agent:xhs-routine"] and pilotAliases=["03"] so the routine
// runner can acquire a xiaowei.explorer.primitive session on alias 03 under
// nonpayment_v1. Any other actor/alias combination stays out_of_scope and
// blocks with AUTONOMY_PILOT_SCOPE_MISS — this file pins both sides so the
// allowlist cannot silently widen or regress.
import assert from "node:assert/strict";
import test from "node:test";

import {
  isPilotScope,
  policyModeForRequest,
  resolvePolicyMode,
} from "../control-plane/lib/nonpayment-autonomy-policy.mjs";
import { decideCapabilityPolicy } from "../control-plane/lib/authorization-decision.mjs";
import { attachNormalizedEffect } from "../control-plane/lib/capability-effect.mjs";

// The exact deployed selector from services/control-plane/scripts/xw-control-plane-runtime.ps1
const DEPLOYED_ENV = {
  AUTONOMY_POLICY_MODE: "nonpayment_v1",
  CONTROL_PLANE_PILOT_ACTORS: '["agent:xhs-routine"]',
  CONTROL_PLANE_PILOT_ALIASES: '["03"]',
};

const EXPLORER_PRIMITIVE_CAPABILITY = attachNormalizedEffect({
  schemaVersion: 1,
  id: "xiaowei.explorer.primitive",
  appId: "xiaowei",
  packageName: "com.xingin.xhs",
  versionRange: "*",
  maturity: "E2",
  risk: "R1",
  resources: ["device"],
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  preconditions: [],
  verification: { mode: "none", description: "bounded receipt" },
  restoration: { required: true, description: "session release restores feed" },
  timeoutMs: 60_000,
  idempotency: "read_only",
  automationPolicy: { mode: "automatic", canaryOnly: true },
  implementation: { adapter: "xiaowei", action: "explorer_primitive" },
  evidence: [],
  availability: "canary_only",
});

test("deployed launch selector resolves to the exact routine canary scope", () => {
  const mode = resolvePolicyMode({ env: DEPLOYED_ENV, adapterKind: "real" });
  assert.equal(mode.mode, "nonpayment_v1");
  assert.equal(mode.active, true, "real adapter with both selectors is active");
  assert.equal(mode.pilotOnly, true);
  assert.deepEqual(mode.pilotActors, ["agent:xhs-routine"]);
  assert.deepEqual(mode.pilotAliases, ["03"]);
});

test("routine runner actor on alias 03 is in scope; every other combination is not", () => {
  const mode = resolvePolicyMode({ env: DEPLOYED_ENV, adapterKind: "real" });
  assert.equal(isPilotScope(mode, { actorId: "agent:xhs-routine", deviceAlias: "03" }), true);
  for (const alias of ["01", "02", "04"]) {
    assert.equal(
      isPilotScope(mode, { actorId: "agent:xhs-routine", deviceAlias: alias }),
      false,
      `alias ${alias} must stay out of the routine pilot scope`,
    );
  }
  for (const actor of ["other", "claude-pilot-20260809", ""]) {
    assert.equal(
      isPilotScope(mode, { actorId: actor, deviceAlias: "03" }),
      false,
      `actor ${actor || "<empty>"} must stay out of the routine pilot scope`,
    );
  }
});

test("in-scope request derives an active deployed-runtime policy mode", () => {
  const mode = resolvePolicyMode({ env: DEPLOYED_ENV, adapterKind: "real" });
  const scoped = policyModeForRequest(mode, { actorId: "agent:xhs-routine", deviceAlias: "03" });
  assert.equal(scoped.active, true);
  assert.equal(scoped.pilotScope, "in_scope");
  assert.equal(scoped.effectiveDecisionSource, "deployed-runtime");
});

test("out-of-scope explorer session request blocks with AUTONOMY_PILOT_SCOPE_MISS (tap=0)", () => {
  const mode = resolvePolicyMode({ env: DEPLOYED_ENV, adapterKind: "real" });
  for (const context of [
    { actorId: "agent:xhs-routine", deviceAlias: "04" },
    { actorId: "some:other-actor", deviceAlias: "03" },
  ]) {
    const scoped = policyModeForRequest(mode, context);
    assert.equal(scoped.pilotScope, "out_of_scope");
    const decision = decideCapabilityPolicy(EXPLORER_PRIMITIVE_CAPABILITY, {
      policyMode: scoped,
      canary: true,
    });
    assert.equal(decision.decision, "block");
    assert.equal(decision.reasonCode, "AUTONOMY_PILOT_SCOPE_MISS");
    assert.equal(decision.approvalRequired, false, "scope miss is a block, not an approval path");
  }
});

test("in-scope explorer session request is not blocked by the pilot scope gate", () => {
  const mode = resolvePolicyMode({ env: DEPLOYED_ENV, adapterKind: "real" });
  const scoped = policyModeForRequest(mode, { actorId: "agent:xhs-routine", deviceAlias: "03" });
  const decision = decideCapabilityPolicy(EXPLORER_PRIMITIVE_CAPABILITY, {
    policyMode: scoped,
    canary: true,
  });
  assert.equal(decision.decision, "allow");
  assert.equal(decision.reasonCode, "NONPAYMENT_AUTONOMY_ACTIVE");
});

test("canary gate still requires the canary flag even when in scope", () => {
  const mode = resolvePolicyMode({ env: DEPLOYED_ENV, adapterKind: "real" });
  const scoped = policyModeForRequest(mode, { actorId: "agent:xhs-routine", deviceAlias: "03" });
  const decision = decideCapabilityPolicy(EXPLORER_PRIMITIVE_CAPABILITY, {
    policyMode: scoped,
    canary: false,
  });
  assert.equal(decision.decision, "block");
  assert.equal(decision.reasonCode, "CANARY_REQUIRED");
});