import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/payment-tripwire/cases.json", import.meta.url), "utf8"));

test("target-bound classifier holds verified final controls without keyword blanket blocking", async () => {
  const module = await import("../control-plane/lib/financial-commit-classifier.mjs").catch(() => null);
  assert.ok(module?.classifyFinancialCommit, "RED: financial commit classifier is not implemented");
  for (const fixture of fixtures.positive) {
    assert.equal(module.classifyFinancialCommit(fixture).actionClass, "financial_commit", fixture.name);
  }
  for (const fixture of fixtures.negative) {
    assert.notEqual(module.classifyFinancialCommit(fixture).actionClass, "financial_commit", fixture.name);
  }
});

test("typed and raw final-payment inputs dispatch zero transport without a bound approval", async () => {
  const { createFinancialCommitTripwire } = await import("../control-plane/lib/financial-commit-classifier.mjs");
  let transportCalls = 0;
  let observationCalls = 0;
  const tripwire = createFinancialCommitTripwire({
    transport: async () => { transportCalls += 1; return { ok: true }; },
    observeCandidate: async () => { observationCalls += 1; return {}; }
  });
  for (const primitive of ["typed-capability", "tap", "input", "shell"]) {
    const result = await tripwire.dispatch({
      primitive,
      app: "fixture-pay",
      accountRef: "redacted:account",
      deviceId: "fixture-device",
      snapshotHash: "a".repeat(64),
      ...fixtures.positive[0]
    });
    assert.equal(result.decision, "wait_financial_commit", primitive);
    assert.equal(result.transportDispatched, false, primitive);
  }
  assert.equal(transportCalls, 0);
  assert.equal(observationCalls, 0);
});

test("ordinary inputs never invoke synchronous observation and payment candidates invoke it once", async () => {
  const { createFinancialCommitTripwire } = await import("../control-plane/lib/financial-commit-classifier.mjs");
  let transportCalls = 0;
  let observationCalls = 0;
  const tripwire = createFinancialCommitTripwire({
    transport: async () => { transportCalls += 1; return { ok: true }; },
    observeCandidate: async ({ input }) => {
      observationCalls += 1;
      return {
        target: { ...input.target, verifiedFinalControl: true },
        context: { ...input.context, amount: "8.00", currency: "CNY", payeeRef: "redacted:merchant" }
      };
    }
  });
  const ordinary = await tripwire.dispatch(fixtures.negative[2]);
  assert.equal(ordinary.transportDispatched, true);
  assert.equal(ordinary.synchronousObservationCount, 0);
  assert.equal(observationCalls, 0);

  const candidate = await tripwire.dispatch({
    target: { text: "确认支付" },
    context: { stage: "final" }
  });
  assert.equal(candidate.decision, "wait_financial_commit");
  assert.equal(candidate.transportDispatched, false);
  assert.equal(candidate.synchronousObservationCount, 1);
  assert.equal(observationCalls, 1);
  assert.equal(transportCalls, 1);
});
