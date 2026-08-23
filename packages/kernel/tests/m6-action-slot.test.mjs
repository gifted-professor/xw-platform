import assert from "node:assert/strict";
import test from "node:test";

import { deriveM6ActionSlotSpec, deriveM6LogicalActionIdentity, deriveM6TrustedParameterHash, assertM6ActionSlotDispatch } from "../lib/m6-action-slot.mjs";
import { m6LiveSha256 as H } from "../lib/m6-live-grounding.mjs";

function slotInput() {
  return {
    scenarioManifestHash: H("manifest"), scenarioId: "scenario-1", logicalStepId: "step-1", actionSlotOrdinal: 0,
    alias: "01", primitive: "tap", actionFamily: "open_public_note", intentRef: H("intent"), intentPolicyHash: H("intent-policy"),
    targetKind: "block", targetEligibilityHash: H("eligibility"), trustedParameterHash: deriveM6TrustedParameterHash({}), allowedStateHash: H("states"),
    effectBoundaryHash: H("effects"), budgetPolicyHash: H("budget"), redlinePolicyHash: H("redline"), verificationPolicyHash: H("verify"),
  };
}

test("content-addressed action slot participates in stable logical action identity", () => {
  const spec = deriveM6ActionSlotSpec(slotInput());
  assert.deepEqual(deriveM6LogicalActionIdentity({ planHash: H("plan"), actionSlotSpec: spec }), deriveM6LogicalActionIdentity({ planHash: H("plan"), actionSlotSpec: spec }));
});

test("same family primitive, intent, and trusted parameter substitutions fail before dispatch", () => {
  const spec = deriveM6ActionSlotSpec(slotInput());
  for (const dispatch of [
    { intent: { targetKind: "block", intentRef: spec.intentRef }, manifestStep: { primitive: "back", trustedParameterHash: spec.trustedParameterHash, trustedParams: {} } },
    { intent: { targetKind: "block", intentRef: H("other") }, manifestStep: { primitive: "tap", trustedParameterHash: spec.trustedParameterHash, trustedParams: {} } },
    { intent: { targetKind: "block", intentRef: spec.intentRef }, manifestStep: { primitive: "tap", trustedParameterHash: H("other"), trustedParams: {} } },
    { intent: { targetKind: "block", intentRef: spec.intentRef }, manifestStep: { primitive: "tap", trustedParameterHash: spec.trustedParameterHash, trustedParams: { x: 1 } } },
  ]) assert.throws(() => assertM6ActionSlotDispatch({ actionSlotSpec: spec, ...dispatch }), { code: "M6_ACTION_SLOT_INVALID" });
});
