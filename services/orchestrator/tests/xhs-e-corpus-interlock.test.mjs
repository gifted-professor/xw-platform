import assert from "node:assert/strict";
import test from "node:test";

import {
  XhsECorpusInterlockError,
  resolveEffectiveVisualPermitPolicy,
} from "../scripts/lib/xhs-e-corpus-interlock.mjs";

const ref = Object.freeze({
  schemaId: "xw.xhs.e-corpus-pass-ref.v1",
  artifactHash: "1".repeat(64),
  bindingHash: "2".repeat(64),
  gateEpoch: "3".repeat(64),
  expiresAtMs: 9_999_999_999_999,
});

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof XhsECorpusInterlockError && error.code === code);
}

test("R0/R1/R2 persist effective issued/physical visual budget zero", () => {
  for (const [phase, visionMode] of [["R0", "off"], ["R1", "off"], ["R2", "shadow"]]) {
    const policy = resolveEffectiveVisualPermitPolicy({ visionMode, requestedPhase: phase });
    assert.equal(policy.phase, phase);
    assert.equal(policy.effectiveVisualPermitBudget, 0);
    assert.equal(policy.effectiveVisualPhysicalTapBudget, 0);
    assert.equal(policy.eCorpusPassRef, null);
    expectCode(
      () => resolveEffectiveVisualPermitPolicy({
        visionMode,
        requestedPhase: phase,
        requestedIssuedPermits: 1,
      }),
      "EXPLORATION_VISUAL_BUDGET_LOCKED",
    );
  }
});

test("R3 alone recovers the exact parent cap one after exact PASS verification", () => {
  let calls = 0;
  const policy = resolveEffectiveVisualPermitPolicy({
    visionMode: "canary1",
    requestedPhase: "R3",
    eCorpusPassRef: ref,
    verifyR3({ ref: actual }) {
      calls += 1;
      assert.deepEqual(actual, ref);
      return {
        ok: true,
        status: "PASS",
        artifactHash: ref.artifactHash,
        effectiveVisualPermitBudget: 1,
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(policy.effectiveVisualPermitBudget, 1);
  assert.equal(policy.effectiveVisualPhysicalTapBudget, 1);
  expectCode(
    () => resolveEffectiveVisualPermitPolicy({
      visionMode: "canary1",
      requestedPhase: "R3",
      eCorpusPassRef: ref,
    }),
    "ECORPUS_INTERLOCK_NOT_CONFIGURED",
  );
  expectCode(
    () => resolveEffectiveVisualPermitPolicy({
      visionMode: "canary1",
      requestedPhase: "R3",
      eCorpusPassRef: ref,
      requestedIssuedPermits: 0,
      verifyR3: () => ({ ok: true }),
    }),
    "EXPLORATION_VISION_BUDGET_INVALID",
  );
});

test("phase/mode mismatch and dormant/caller-forged PASS refs reject", () => {
  expectCode(
    () => resolveEffectiveVisualPermitPolicy({ visionMode: "shadow", requestedPhase: "R3", eCorpusPassRef: ref }),
    "EXPLORATION_ROLLOUT_MODE_MISMATCH",
  );
  expectCode(
    () => resolveEffectiveVisualPermitPolicy({ visionMode: "shadow", requestedPhase: "R2", eCorpusPassRef: ref }),
    "ECORPUS_REF_PHASE_FORBIDDEN",
  );
  expectCode(
    () => resolveEffectiveVisualPermitPolicy({
      visionMode: "canary1",
      requestedPhase: "R3",
      eCorpusPassRef: { ...ref, artifactPath: "C:\\caller\\pass.json" },
      verifyR3: () => ({ ok: true }),
    }),
    "ECORPUS_REF_INVALID",
  );
});
