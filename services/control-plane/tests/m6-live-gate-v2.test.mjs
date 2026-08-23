import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveM6ActionEpochBindingHash,
  deriveM6EmergencyCloseAuthorizationHash,
  deriveM6V2EpochHash,
  deriveM6V2LockSetHash,
  evaluateM6MixedGate,
  M6_GATE_V2_LOCK_KINDS,
} from "../control-plane/lib/m6-live-gate-v2.mjs";

const H = (char) => char.repeat(64);
const RELEASE = { releaseId: "m6-4-test", sourceCommit: "a".repeat(40) };

function lockSet(overrides = {}) {
  const raw = {
    schemaId: "xw.m6-locks.v2",
    lockSetId: "m6-4-test-locks",
    lockHashes: Object.fromEntries(M6_GATE_V2_LOCK_KINDS.map((kind, index) => [kind, (index % 10).toString().repeat(64)])),
    ...overrides,
  };
  return { ...raw, lockSetHash: deriveM6V2LockSetHash(raw) };
}

function emergency({ parent = null, alias = "01", expiresAt = "2030-01-01T01:31:00Z", actionEpochBindingHash } = {}) {
  const raw = {
    schemaId: "xw.m6-emergency-close-authorization.v1",
    authorizationId: "emergency-test",
    expectedCurrentEpochHash: parent,
    expectedParentEpochHash: parent,
    actionEpochBindingHash,
    releaseId: RELEASE.releaseId,
    planHash: H("b"),
    contractHash: H("c"),
    alias,
    operator: "operator:test",
    reasonCodeAllowlist: ["HOT_CLOSE_DRILL", "SAFETY_STOP"],
    nonce: "nonce-test",
    expiresAt,
  };
  return { ...raw, authorizationHash: deriveM6EmergencyCloseAuthorizationHash(raw) };
}

function activePair({ mode = "GROUNDED_ACTION", parent = null, locks, allowlist = ["01"], schemaId = "xw.m6-live-gate.v2", alias = allowlist[0], authExpiresAt } = {}) {
  const base = {
    schemaId,
    gateId: "m6-gate",
    mode,
    purpose: mode === "OBSERVE_ONLY" ? "M6_4_SHADOW" : "M6_4_ACTION_SMOKE",
    status: "active",
    ...RELEASE,
    actor: "operator:test",
    lockSetRef: { id: locks.lockSetId, sha256: locks.lockSetHash },
    allowlist,
    issuedAt: "2030-01-01T00:00:00Z",
    expiresAt: "2030-01-01T01:00:00Z",
    parentEpochHash: parent,
    closeoutRef: null,
    aggregateSealRef: null,
    rollbackTargetEpochHash: null,
  };
  const auth = emergency({
    parent,
    alias,
    ...(authExpiresAt ? { expiresAt: authExpiresAt } : {}),
    actionEpochBindingHash: deriveM6ActionEpochBindingHash(base),
  });
  const raw = { ...base, emergencyCloseAuthorizationRef: { id: auth.authorizationId, sha256: auth.authorizationHash } };
  return { auth, epoch: { ...raw, epochHash: deriveM6V2EpochHash(raw) } };
}

function evaluate(epoch, locks, auth) {
  return evaluateM6MixedGate({
    chain: [epoch],
    lockSets: { [locks.lockSetId]: locks },
    emergencyCloseAuthorizations: { [auth.authorizationId]: auth },
    nowMs: Date.parse("2030-01-01T00:30:00Z"),
    expectedRelease: RELEASE,
  });
}

test("v2 grounded action opens only for exact alias 01 with complete locks and covering emergency close", () => {
  const locks = lockSet();
  const { auth, epoch } = activePair({ locks });
  const result = evaluate(epoch, locks, auth);
  assert.equal(result.mode, "GROUNDED_ACTION");
  assert.equal(result.purpose, "M6_4_ACTION_SMOKE");
  assert.deepEqual(result.errors, []);
});

test("v2 fails closed on action allowlist drift", () => {
  const locks = lockSet();
  const { auth, epoch } = activePair({ locks, allowlist: ["02"], alias: "02" });
  const result = evaluate(epoch, locks, auth);
  assert.equal(result.mode, "CLOSED");
  assert.equal(result.errors[0].code, "M6_GATE_ACTION_ALLOWLIST_INVALID");
});

test("v2 fails closed on forged lock set and insufficient emergency-close coverage", () => {
  const locks = lockSet();
  const { auth, epoch } = activePair({ locks, authExpiresAt: "2030-01-01T01:29:59Z" });
  const short = evaluate(epoch, locks, auth);
  assert.equal(short.errors[0].code, "M6_GATE_EMERGENCY_CLOSE_INVALID");
  const forged = { ...locks, lockHashes: { ...locks.lockHashes, runtimeProfile: H("f") } };
  const drift = evaluate(epoch, forged, auth);
  assert.equal(drift.errors[0].code, "M6_GATE_LOCK_MISMATCH");
});

test("mixed evaluator rejects unknown schema and v2-to-v1 downgrade", () => {
  const locks = lockSet();
  const { auth, epoch: v2 } = activePair({ locks });
  const unknown = evaluateM6MixedGate({ chain: [{ ...v2, schemaId: "xw.m6-live-gate.v3" }], nowMs: Date.now() });
  assert.equal(unknown.errors[0].code, "M6_GATE_SCHEMA_UNKNOWN");
  const fakeV1 = { schemaId: "xw.m6-live-gate.v1", epochHash: H("1") };
  const downgrade = evaluateM6MixedGate({ chain: [v2, fakeV1], nowMs: Date.parse("2030-01-01T00:30:00Z") });
  assert.equal(downgrade.errors[0].code, "M6_GATE_SCHEMA_DOWNGRADE");
});
