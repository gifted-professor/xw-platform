import assert from "node:assert/strict";
import test from "node:test";

test("ambiguous nonpayment effect maps to reconciliation instead of approval", async () => {
  const module = await import("../control-plane/lib/nonpayment-autonomy-policy.mjs").catch(() => null);
  assert.ok(module?.evaluateNonpaymentAutonomy, "RED: nonpayment autonomy policy is not implemented");
  const verdict = module.evaluateNonpaymentAutonomy({
    actionClass: "nonfinancial_effect",
    effectState: "ambiguous",
    knownCapability: true,
    resourceAvailable: true
  });
  assert.equal(verdict.decision, "reconcile_effect");
  assert.equal(verdict.humanApprovalRequired, false);
});
