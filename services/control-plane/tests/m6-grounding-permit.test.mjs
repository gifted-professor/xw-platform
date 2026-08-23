import assert from "node:assert/strict";
import test from "node:test";

import { StateStore } from "../control-plane/lib/state-store.mjs";

const H = (char) => char.repeat(64);

function decision(suffix = "a") {
  return {
    schemaId: "xw.grounding-decision.v2",
    decisionRef: H(suffix),
    operationKey: `operation-${suffix}`,
    disposition: "ALLOW_ONCE",
    target: { kind: "block", frameId: H("1"), blockId: H("2") },
    bindings: {
      runId: "run-1", sessionId: "session-1", leaseId: "lease-1",
      gateEpochHash: H("3"), gateGeneration: 1, grantHash: H("4"), stepId: "step-1",
      environmentAttestationHash: H("5"),
    },
  };
}

function slot() {
  return {
    slotSpecHash: H("6"),
    frameId: H("1"),
    blockId: H("2"),
    uiStateGeneration: 7,
    appPackageHash: H("7"),
    focusHash: H("8"),
    pageFingerprint: H("9"),
    rotation: 0,
    displayHash: H("b"),
    environmentAttestationHash: H("5"),
  };
}

test("durable grounding permit is one-shot and consumption receipt preserves every binding with >=1s TTL", () => {
  let now = 10_000;
  const state = new StateStore({ now: () => now });
  try {
    const d = decision();
    const s = slot();
    const permit = state.issueM6GroundingPermit({
      decision: d,
      slot: s,
      timing: { issuedAtMs: now, expiresAtMs: now + 5_000, dispatchDeadlineMonoMs: 50_000 },
    });
    assert.match(permit.permitHash, /^[0-9a-f]{64}$/);
    const receipt = state.consumeM6GroundingPermit({
      permitId: permit.permitId,
      expected: { operationKey: d.operationKey, target: d.target, bindings: d.bindings, slot: s },
      nowMonoMs: 46_000,
    });
    assert.equal(receipt.remainingTtlMs, 5_000);
    assert.equal(receipt.remainingMonoMs, 4_000);
    assert.deepEqual(receipt.slot, s);
    assert.throws(() => state.consumeM6GroundingPermit({
      permitId: permit.permitId,
      expected: { operationKey: d.operationKey, target: d.target, bindings: d.bindings, slot: s },
      nowMonoMs: 46_001,
    }), { code: "M6_GROUNDING_PERMIT_REPLAY" });
  } finally { state.close(); }
});

test("decision replay, binding drift, coordinates, and <1s TTL fail before consumption", () => {
  let now = 20_000;
  const state = new StateStore({ now: () => now });
  try {
    const d = decision("c");
    const s = slot();
    const permit = state.issueM6GroundingPermit({ decision: d, slot: s, timing: { issuedAtMs: now, expiresAtMs: now + 5_000, dispatchDeadlineMonoMs: 60_000 } });
    assert.throws(() => state.issueM6GroundingPermit({ decision: d, slot: s, timing: { issuedAtMs: now, expiresAtMs: now + 5_000, dispatchDeadlineMonoMs: 60_000 } }), {
      code: "M6_GROUNDING_DECISION_REPLAY",
    });
    assert.throws(() => state.consumeM6GroundingPermit({
      permitId: permit.permitId,
      expected: { operationKey: d.operationKey, target: d.target, bindings: d.bindings, slot: { ...s, uiStateGeneration: 8 } },
      nowMonoMs: 56_000,
    }), { code: "M6_GROUNDING_PERMIT_BINDING_MISMATCH" });
    now += 4_001;
    assert.throws(() => state.consumeM6GroundingPermit({
      permitId: permit.permitId,
      expected: { operationKey: d.operationKey, target: d.target, bindings: d.bindings, slot: s },
      nowMonoMs: 59_001,
    }), { code: "M6_GROUNDING_PERMIT_STALE" });
    assert.throws(() => state.issueM6GroundingPermit({
      decision: decision("d"),
      slot: { ...s, bounds: { x: 1, y: 2 } },
      timing: { issuedAtMs: now, expiresAtMs: now + 5_000, dispatchDeadlineMonoMs: 70_000 },
    }), { code: "M6_GROUNDING_PERMIT_INVALID" });
  } finally { state.close(); }
});
