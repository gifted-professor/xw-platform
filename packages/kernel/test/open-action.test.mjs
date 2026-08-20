import assert from "node:assert/strict";
import test from "node:test";
import {
  EFFECT_POLICY,
  FORBIDDEN_PUBLIC_PRIMITIVES,
  PUBLIC_PRIMITIVES,
  loadKernelJson,
  validateDeviceSession,
  validateEffectAssessment,
  validateObservation,
  validatePrimitiveAction,
} from "../lib/open-action.mjs";

test("payment_credential cannot ALLOW_WITH_TRACE", () => {
  const r = validateEffectAssessment({
    category: "payment_credential",
    decision: "ALLOW_WITH_TRACE",
    authority: "control_plane",
    reasons: [],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === "PAYMENT_CREDENTIAL_HOLD"));
});

test("payment_final_commit cannot ALLOW_WITH_TRACE", () => {
  const r = validateEffectAssessment({
    category: "payment_final_commit",
    decision: "ALLOW_WITH_TRACE",
    authority: "control_plane",
    reasons: [],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === "PAYMENT_FINAL_COMMIT_REQUIRED"));
});

test("payment_context_uncertain cannot execute directly", () => {
  const allow = validateEffectAssessment({
    category: "payment_context_uncertain",
    decision: "ALLOW_WITH_TRACE",
    authority: "control_plane",
    reasons: [],
  });
  assert.equal(allow.ok, false);
  assert.ok(allow.errors.some((e) => e.code === "PAYMENT_CONTEXT_UNCERTAIN"));
  const ok = validateEffectAssessment({
    category: "payment_context_uncertain",
    decision: "REOBSERVE_REQUIRED",
    authority: "control_plane",
    reasons: ["unclear pay wall"],
  });
  assert.equal(ok.ok, true);
});

test("nonpayment allows ALLOW_WITH_TRACE and policy table is frozen", () => {
  assert.equal(EFFECT_POLICY.nonpayment, "ALLOW_WITH_TRACE");
  assert.equal(EFFECT_POLICY.payment_credential, "HUMAN_REQUIRED");
  assert.equal(EFFECT_POLICY.payment_final_commit, "HUMAN_REQUIRED");
  assert.equal(EFFECT_POLICY.payment_context_uncertain, "REOBSERVE_REQUIRED");
  const r = validateEffectAssessment({
    category: "nonpayment",
    decision: "ALLOW_WITH_TRACE",
    authority: "control_plane",
    reasons: [],
  });
  assert.equal(r.ok, true);
});

test("mutating action missing basedOnObservationId is invalid", () => {
  const r = validatePrimitiveAction({
    schemaId: "xw.open-action.primitive.v1",
    schemaVersion: 1,
    kind: "tap",
    actionId: "a1",
    idempotencyKey: "k1",
    target: { normalizedCoordinate: { x: 0.5, y: 0.5 } },
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === "STALE_OBSERVATION"));
});

test("mutating action missing idempotencyKey is invalid", () => {
  const r = validatePrimitiveAction({
    kind: "swipe",
    actionId: "a1",
    basedOnObservationId: "obs-1",
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.message.includes("idempotencyKey")));
});

test("target selectors cannot combine exclusive locators", () => {
  const r = validatePrimitiveAction({
    kind: "tap",
    actionId: "a1",
    idempotencyKey: "k1",
    basedOnObservationId: "obs-1",
    target: {
      text: "确定",
      normalizedCoordinate: { x: 0.2, y: 0.8 },
    },
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.message.includes("exclusive")));
});

test("raw_adb and shell are not public primitives", () => {
  for (const kind of ["raw_adb", "shell"]) {
    const r = validatePrimitiveAction({ kind, actionId: "a", idempotencyKey: "k", basedOnObservationId: "o" });
    assert.equal(r.ok, false, kind);
    assert.ok(r.errors.some((e) => e.code === "PRIMITIVE_NOT_SUPPORTED"));
    assert.ok(FORBIDDEN_PUBLIC_PRIMITIVES.includes(kind));
    assert.ok(!PUBLIC_PRIMITIVES.includes(kind));
  }
});

test("observe does not require mutating fields", () => {
  const r = validatePrimitiveAction({ kind: "observe" });
  assert.equal(r.ok, true);
});

test("valid coordinate tap is accepted", () => {
  const r = validatePrimitiveAction({
    kind: "tap",
    actionId: "a1",
    idempotencyKey: "k1",
    basedOnObservationId: "obs-1",
    target: { normalizedCoordinate: { x: 0.4, y: 0.6 } },
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("observation must use evidence refs not inline bytes", () => {
  const r = validateObservation({
    observationId: "obs-1",
    screenshotBytes: "AAAA",
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === "OBSERVATION_INCOMPLETE"));
});

test("open_action session does not require capabilityId", () => {
  const open = validateDeviceSession({ sessionKind: "open_action", capabilityId: null });
  assert.equal(open.ok, true);
  const cap = validateDeviceSession({ sessionKind: "capability" });
  assert.equal(cap.ok, false);
});

test("event and error catalogs contain the M3-A names", () => {
  const events = loadKernelJson("event-protocol/events.v1.json");
  const errors = loadKernelJson("error-codes/error-codes.v1.json");
  const manifest = loadKernelJson("contracts/manifest.v1.json");
  for (const name of [
    "device_session.created",
    "effect.assessed",
    "payment.hold_created",
    "primitive.executed",
  ]) {
    assert.ok(events.events.includes(name), name);
  }
  for (const code of [
    "STALE_OBSERVATION",
    "INVALID_ACTION",
    "PAYMENT_CREDENTIAL_HOLD",
    "PAYMENT_FINAL_COMMIT_REQUIRED",
    "PAYMENT_CONTEXT_UNCERTAIN",
    "OBSERVATION_BINDING_MISMATCH",
  ]) {
    assert.ok(errors.codes.includes(code), code);
  }
  assert.equal(manifest.openAction.length, 7);
  assert.ok(manifest.openAction.includes("contracts/open-action/action-request.v1.schema.json"));
  assert.ok(manifest.openAction.includes("contracts/open-action/action-ledger.v1.schema.json"));
  for (const code of ["ACTION_IN_FLIGHT", "ACTION_AMBIGUOUS", "SESSION_ACTION_RUNNING"]) {
    assert.ok(errors.codes.includes(code), code);
  }
  assert.equal(manifest.sharedCopies.length, 6);
  assert.deepEqual(manifest.orchestrationContracts, [
    "contracts/orchestration/skill-catalog.v1.schema.json",
    "contracts/orchestration/task-classification.v1.schema.json",
    "contracts/orchestration/dag.v1.schema.json",
  ]);
});
