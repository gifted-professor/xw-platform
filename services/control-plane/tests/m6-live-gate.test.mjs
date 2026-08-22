// M6-2 W5/W6 — live gate epoch chain unit tests (pure, no device/session/fs).
//
// The gate must fail closed to CLOSED for every invalid state and never produce
// a mode other than CLOSED or OBSERVE_ONLY. Nothing here reads a device, session,
// lease, or the filesystem — the module is deterministic over its inputs.
import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveM6CloseoutHash,
  deriveM6EpochHash,
  evaluateM6Gate,
  m6AliasAllowed,
  M6_GATE_LOCK_KINDS,
  M6_GATE_MAX_EPOCHS,
  M6_GATE_MODES,
  resolveM6Closeout,
} from "../control-plane/lib/m6-live-gate.mjs";

const RELEASE = { releaseId: "release-1", sourceCommit: "abc123" };
const NOW = Date.parse("2026-08-22T00:00:00Z");

function epoch(overrides = {}) {
  const raw = {
    schemaId: "xw.m6-live-gate.v1",
    gateId: "m6-gate-1",
    mode: "OBSERVE_ONLY",
    status: "active",
    releaseId: RELEASE.releaseId,
    sourceCommit: RELEASE.sourceCommit,
    actor: "operator",
    lockHashes: null,
    allowlist: ["alpha"],
    issuedAt: "2026-08-21T00:00:00.000Z",
    expiresAt: "2027-01-01T00:00:00.000Z",
    parentEpochHash: null,
    closeoutRef: null,
    ...overrides,
  };
  return { ...raw, epochHash: deriveM6EpochHash(raw) };
}

function closeout(overrides = {}) {
  const raw = {
    closeoutId: "closeout-1",
    epochHash: overrides.epochHash ?? null,
    actor: "ops",
    reason: "release",
    committedAt: "2026-08-21T12:00:00.000Z",
    ...overrides,
  };
  return { ...raw, closeoutHash: deriveM6CloseoutHash(raw) };
}

test("successfully produced modes are only CLOSED and OBSERVE_ONLY", () => {
  // OBSERVE_ONLY: active, unsealed (closeoutRef=null).
  const observe = epoch({ mode: "OBSERVE_ONLY" });
  const ro = evaluateM6Gate({ chain: [observe], nowMs: NOW });
  assert.equal(ro.mode, "OBSERVE_ONLY");
  assert.equal(ro.errors.length, 0);
  // CLOSED: sealed — status=closed plus a self-hashing closeout receipt that
  // binds to the epoch. Status is coupled to mode per the frozen contract.
  const closedEpoch = epoch({
    mode: "CLOSED",
    status: "closed",
    closeoutRef: { id: "closeout-closed", sha256: "0".repeat(64) },
  });
  const rec = closeout({ epochHash: closedEpoch.epochHash, closeoutId: "closeout-closed" });
  const rc = evaluateM6Gate({ chain: [closedEpoch], closeouts: { "closeout-closed": rec }, nowMs: NOW });
  assert.equal(rc.mode, "CLOSED");
  assert.equal(rc.errors.length, 0);
});

test("deriveM6EpochHash is deterministic and covers the payload (incl. closeoutRef)", () => {
  const e = epoch();
  assert.equal(deriveM6EpochHash(e), e.epochHash);
  assert.notEqual(
    deriveM6EpochHash({ ...e, allowlist: ["beta"] }),
    e.epochHash,
    "changing any whitelisted field must change the hash (forgery detection relies on it)",
  );
  // closeoutRef is in the hash domain (matches the frozen contract): tampering
  // with the closeout reference invalidates the epoch self-hash.
  assert.notEqual(
    deriveM6EpochHash({ ...e, closeoutRef: { id: "closeout-x", sha256: "0".repeat(64) } }),
    e.epochHash,
    "changing closeoutRef must change the epoch hash",
  );
});

test("status is coupled to mode: CLOSED requires status=closed + a closeout ref", () => {
  // CLOSED with the old active status now fails closed.
  assert.equal(
    evaluateM6Gate({ chain: [epoch({ mode: "CLOSED", status: "active" })], nowMs: NOW }).errors[0].code,
    "M6_GATE_EPOCH_NOT_CLOSED",
  );
  // CLOSED without a closeout ref fails closed (a CLOSED epoch is sealed).
  assert.equal(
    evaluateM6Gate({ chain: [epoch({ mode: "CLOSED", status: "closed" })], nowMs: NOW }).errors[0].code,
    "M6_GATE_CLOSEOUT_FORGED",
  );
});

test("fail-closed comparisons: absent required fields are drift, not a pass", () => {
  // Absent releaseId / sourceCommit fail when the runtime pins a release.
  assert.equal(
    evaluateM6Gate({ chain: [epoch({ releaseId: null })], nowMs: NOW, expectedRelease: RELEASE }).errors[0].code,
    "M6_GATE_RELEASE_MISMATCH",
  );
  assert.equal(
    evaluateM6Gate({ chain: [epoch({ sourceCommit: null })], nowMs: NOW, expectedRelease: RELEASE }).errors[0].code,
    "M6_GATE_RELEASE_MISMATCH",
  );
  // Absent lockHashes fail when the runtime supplies lock hashes.
  const pinned = { runtimeProfile: "f0".repeat(64), hardRedlinePolicy: null, groundingRuntime: null };
  assert.equal(
    evaluateM6Gate({ chain: [epoch({ lockHashes: null })], nowMs: NOW, lockHashes: pinned }).errors[0].code,
    "M6_GATE_LOCK_MISMATCH",
  );
  // Absent / empty expiresAt fails closed (never treated as "never expires").
  assert.equal(
    evaluateM6Gate({ chain: [epoch({ expiresAt: null })], nowMs: NOW }).errors[0].code,
    "M6_GATE_EXPIRED",
  );
  assert.equal(
    evaluateM6Gate({ chain: [epoch({ expiresAt: "" })], nowMs: NOW }).errors[0].code,
    "M6_GATE_EXPIRED",
  );
});

test("an unknown/empty chain fails closed to CLOSED", () => {
  assert.equal(evaluateM6Gate({ chain: [], nowMs: NOW }).errors[0].code, "M6_GATE_EMPTY");
  assert.equal(evaluateM6Gate({ chain: [], nowMs: NOW }).mode, "CLOSED");
  assert.equal(evaluateM6Gate({ nowMs: NOW }).errors[0].code, "M6_GATE_EMPTY");
});

test("a thrown clock (no nowMs) fails closed", () => {
  const r = evaluateM6Gate({ chain: [epoch()] });
  assert.equal(r.errors[0].code, "M6_GATE_CLOCK_INVALID");
  assert.equal(r.mode, "CLOSED");
});

test("expired epoch fails closed with M6_GATE_EXPIRED", () => {
  const expired = epoch({ expiresAt: "2026-08-01T00:00:00.000Z" });
  const r = evaluateM6Gate({ chain: [expired], nowMs: Date.parse("2026-08-21T00:00:00Z") });
  assert.equal(r.mode, "CLOSED");
  assert.equal(r.errors[0].code, "M6_GATE_EXPIRED");
});

test("forged self-hash (payload changed after sealing) fails closed", () => {
  const forged = { ...epoch(), allowlist: ["alpha", "public"] };
  const r = evaluateM6Gate({ chain: [forged], nowMs: NOW });
  assert.equal(r.errors[0].code, "M6_GATE_EPOCH_FORGED");
});

test("parent chain binds: a non-root epoch with a wrong parent fails closed", () => {
  const a = epoch();
  const b = epoch({ parentEpochHash: "0".repeat(64) });
  const r = evaluateM6Gate({ chain: [a, b], nowMs: NOW });
  assert.equal(r.errors[0].code, "M6_GATE_PARENT_MISMATCH");
});

test("a root epoch that claims a parent fails (root must have none)", () => {
  const root = epoch({ parentEpochHash: "0".repeat(64) });
  const r = evaluateM6Gate({ chain: [root], nowMs: NOW });
  assert.equal(r.errors[0].code, "M6_GATE_ROOT_PARENT_MISMATCH");
});

test("a duplicate epoch hash fails closed", () => {
  const e = epoch();
  const r = evaluateM6Gate({ chain: [e, e], nowMs: NOW });
  assert.equal(r.errors[0].code, "M6_GATE_EPOCH_DUPLICATE");
});

test("a chain longer than the cap fails closed", () => {
  const chain = [epoch()];
  for (let i = 0; i < M6_GATE_MAX_EPOCHS; i += 1) {
    chain.push(epoch({ parentEpochHash: chain[chain.length - 1].epochHash }));
  }
  const r = evaluateM6Gate({ chain, nowMs: NOW });
  assert.equal(r.errors[0].code, "M6_GATE_CHAIN_TOO_LONG");
});

test("a non-active epoch fails closed", () => {
  const r = evaluateM6Gate({ chain: [epoch({ status: "superseded" })], nowMs: NOW });
  assert.equal(r.errors[0].code, "M6_GATE_EPOCH_NOT_ACTIVE");
});

test("an unknown mode fails closed (never a degraded mode)", () => {
  const r = evaluateM6Gate({ chain: [epoch({ mode: "ACTIVATE" })], nowMs: NOW });
  assert.equal(r.errors[0].code, "M6_GATE_MODE_INVALID");
  assert.equal(r.mode, "CLOSED");
});

test("an invalid or empty allowlist fails closed", () => {
  assert.equal(evaluateM6Gate({ chain: [epoch({ allowlist: [] })], nowMs: NOW }).errors[0].code, "M6_GATE_ALLOWLIST_INVALID");
  assert.equal(evaluateM6Gate({ chain: [epoch({ allowlist: ["alpha", ""] })], nowMs: NOW }).errors[0].code, "M6_GATE_ALLOWLIST_INVALID");
  assert.equal(evaluateM6Gate({ chain: [epoch({ allowlist: null })], nowMs: NOW }).errors[0].code, "M6_GATE_ALLOWLIST_INVALID");
});

test("release drift fails closed to M6_GATE_RELEASE_MISMATCH", () => {
  const drift = epoch({ releaseId: "release-2" });
  const r = evaluateM6Gate({ chain: [drift], nowMs: NOW, expectedRelease: RELEASE });
  assert.equal(r.errors[0].code, "M6_GATE_RELEASE_MISMATCH");
});

test("lock hash drift fails closed to M6_GATE_LOCK_MISMATCH", () => {
  const e = epoch({ lockHashes: { runtimeProfile: "aka".repeat(64), hardRedlinePolicy: null, groundingRuntime: null } });
  const r = evaluateM6Gate({
    chain: [e],
    nowMs: NOW,
    lockHashes: { runtimeProfile: "f0".repeat(64), hardRedlinePolicy: null, groundingRuntime: null },
  });
  assert.equal(r.errors[0].code, "M6_GATE_LOCK_MISMATCH");
});

test("an issuedAt that is not a date-time fails closed", () => {
  const r = evaluateM6Gate({ chain: [epoch({ issuedAt: "not-a-date" })], nowMs: NOW });
  assert.equal(r.errors[0].code, "M6_GATE_ISSUED_AT_INVALID");
});

test("a valid closeout seals the epoch closed regardless of declared mode", () => {
  const sealed = epoch({ closeoutRef: { id: "closeout-1", sha256: "0".repeat(64) } });
  const rec = closeout({ epochHash: sealed.epochHash, closeoutId: "closeout-1" });
  const r = evaluateM6Gate({ chain: [sealed], closeouts: { "closeout-1": rec }, nowMs: NOW });
  assert.equal(r.mode, "CLOSED");
  assert.equal(r.errors.length, 0);
  assert.equal(r.activeEpochHash, sealed.epochHash);
});

test("a forged/missing closeout seal fails closed", () => {
  const sealed = epoch({ closeoutRef: { id: "closeout-missing", sha256: "0".repeat(64) } });
  assert.equal(evaluateM6Gate({ chain: [sealed], nowMs: NOW }).errors[0].code, "M6_GATE_CLOSEOUT_FORGED");
});

test("resolveM6Closeout: a bare self-hashing record or a registry record both resolve; a forged one does not", () => {
  const e = epoch();
  const rec = closeout({ epochHash: e.epochHash });
  assert.equal(resolveM6Closeout(rec, {}).ok, true); // self-verifying record, no registry needed
  assert.equal(resolveM6Closeout(rec.closeoutHash || rec, {}).ok, false); // not self-verifying
  assert.equal(resolveM6Closeout(null, {}).ok, false);
  assert.equal(resolveM6Closeout({ id: "nope", sha256: "0".repeat(64) }, {}).ok, false);
});

test("allowlist membership is a server-resolved handle test only", () => {
  const e = epoch();
  assert.equal(m6AliasAllowed("alpha", e), true);
  assert.equal(m6AliasAllowed("beta", e), false);
  assert.equal(m6AliasAllowed("", e), false);
  assert.equal(m6AliasAllowed("alpha", null), false);
  // Non-string / missing alias never matches.
  assert.equal(m6AliasAllowed(undefined, e), false);
  assert.equal(m6AliasAllowed(123, e), false);
});

test("the gate exposes exactly two modes and only lock kinds it can verify", () => {
  assert.deepEqual([...M6_GATE_MODES].sort(), ["CLOSED", "OBSERVE_ONLY"]);
  assert.ok(M6_GATE_LOCK_KINDS.includes("runtimeProfile"));
  assert.ok(M6_GATE_LOCK_KINDS.includes("hardRedlinePolicy"));
  assert.ok(M6_GATE_LOCK_KINDS.includes("groundingRuntime"));
});
