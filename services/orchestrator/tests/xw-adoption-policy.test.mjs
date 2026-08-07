import assert from "node:assert/strict";
import test from "node:test";
import { evaluateWindowsAdoption } from "../scripts/lib/xw-adoption-policy.mjs";

function closeout(overrides = {}) {
  return {
    closure: { status: "completed", blockers: [], remainingWork: [] },
    checks: [{ id: "check", status: "pass" }],
    effects: [{ payment: { involved: false, transportCount: 0, finalCommit: false } }],
    evidenceDebt: [],
    candidates: [{ candidateId: "candidate_workflow", kind: "recipe" }],
    ...overrides,
  };
}

function cleanSignal(overrides = {}) {
  return {
    requestedCount: 60,
    completedCount: 60,
    activeLeaseCount: 0,
    runningJobCount: 0,
    residualProcessCount: 0,
    unresolvedFailureCount: 0,
    userConfirmed: false,
    ...overrides,
  };
}

test("100 percent clean completion auto-adopts without Mac review", () => {
  const decision = evaluateWindowsAdoption(closeout(), cleanSignal());
  assert.equal(decision.status, "accepted");
  assert.equal(decision.macReview, "not_required");
});

test("user confirmation accepts a clean 95 percent completion", () => {
  const decision = evaluateWindowsAdoption(closeout(), cleanSignal({ completedCount: 57, userConfirmed: true }));
  assert.equal(decision.status, "accepted");
});

test("residual process forces review", () => {
  const decision = evaluateWindowsAdoption(closeout(), cleanSignal({ residualProcessCount: 1, userConfirmed: true }));
  assert.equal(decision.status, "review_required");
  assert.ok(decision.reasons.includes("residual_process_present"));
});

test("payment can never be auto-adopted", () => {
  const decision = evaluateWindowsAdoption(
    closeout({ effects: [{ payment: { involved: true, transportCount: 1, finalCommit: true } }] }),
    cleanSignal({ userConfirmed: true }),
  );
  assert.equal(decision.status, "review_required");
  assert.ok(decision.reasons.includes("payment_or_money_transport_present"));
});

test("failed checks and material evidence debt force review", () => {
  const decision = evaluateWindowsAdoption(
    closeout({
      checks: [{ id: "check", status: "fail" }],
      evidenceDebt: [{ severity: "medium" }],
    }),
    cleanSignal({ userConfirmed: true }),
  );
  assert.equal(decision.status, "review_required");
  assert.ok(decision.reasons.includes("checks_not_all_passed"));
  assert.ok(decision.reasons.includes("material_evidence_debt"));
});

