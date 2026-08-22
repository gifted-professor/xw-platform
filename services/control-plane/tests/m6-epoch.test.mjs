// M6-2 W8 #9 — operator epoch build/sign/immutable-IO + closeout + rollback.
//
// The M6 live gate is operator-minted and immutable. This test proves the build
// layer (m6-epoch.mjs) constructs schema-valid epochs whose hash is RE-DERIVED
// (never accepted from the caller), signs them with an operator ed25519 key,
// writes them immutably (refuse-overwrite), activates the chain, seals the gate
// closed via a closeout-bound CLOSED epoch, and rolls back via tombstones. No
// device I/O; the gate stays CLOSED/OBSERVE_ONLY on disk. No private key is
// committed — keypairs are generated in-test.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import { writeImmutableJson } from "../control-plane/lib/m6-gate-loader.mjs";
import {
  deriveM6CloseoutHash,
  deriveM6EpochHash,
  resolveM6Closeout,
} from "../control-plane/lib/m6-live-gate.mjs";
import {
  buildCloseoutRecord,
  buildEpochRecord,
  mintEpoch,
  writeCloseout,
  activateGate,
  readActiveGate,
  resolveLatestEpoch,
  rollbackGate,
  signEpochProof,
  evaluateM6Gate,
} from "../control-plane/lib/m6-epoch.mjs";
import {
  loadGateIssuerAllowlist,
  verifyEpochProof,
  M6_GATE_ISSUER_ALLOWLIST_SCHEMA_ID,
} from "../control-plane/lib/m6-issuer-allowlist.mjs";

const tempBase = join(tmpdir(), "m6-epoch-test");
mkdirSync(tempBase, { recursive: true });

const HEX40 = "a".repeat(40);
const LOCKS = Object.freeze({
  runtimeProfile: "11".repeat(32),
  hardRedlinePolicy: "22".repeat(32),
  groundingRuntime: "33".repeat(32),
});
const GATE_ID = "gate-epoch";
const ACTOR = "operator:epoch";
const KEY_ID = "key-1";
const ISSUED = "2026-08-22T00:00:00.000Z";
const EXPIRES = "2026-08-23T00:00:00.000Z";
const NOW = Date.parse("2026-08-22T08:00:00.000Z");

function newRoot() {
  return mkdtempSync(join(tempBase, "root-"));
}

function writeLocks(m6Root) {
  writeImmutableJson(join(m6Root, "m6-gate", "locks.v1.json"), {
    schemaId: "xw.m6-locks.v1", releaseId: "release-epoch", sourceCommit: HEX40, lockHashes: { ...LOCKS },
  });
}

function writeAllowlist(m6Root, keys) {
  writeImmutableJson(join(m6Root, "m6-gate", "issuer-keys.json"), {
    schemaId: M6_GATE_ISSUER_ALLOWLIST_SCHEMA_ID, version: 1, keys,
  });
}

function issuerKeysPath(m6Root) {
  return join(m6Root, "m6-gate", "issuer-keys.json");
}

function newKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  };
}

function baseEpoch(overrides = {}) {
  return buildEpochRecord({
    gateId: GATE_ID,
    mode: "OBSERVE_ONLY",
    releaseId: "release-epoch",
    sourceCommit: HEX40,
    actor: ACTOR,
    allowlist: ["01", "02"],
    lockHashes: LOCKS,
    issuedAt: ISSUED,
    expiresAt: EXPIRES,
    parentEpochHash: null,
    ...overrides,
  });
}

function setupGate(key) {
  const m6Root = newRoot();
  writeLocks(m6Root);
  writeAllowlist(m6Root, [{ keyId: KEY_ID, subject: ACTOR, publicKey: key.publicKeyPem, status: "active" }]);
  return m6Root;
}

function clean(...roots) {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}

test("buildEpochRecord derives epochHash (never accepts a caller-supplied hash) and is schema-valid", () => {
  const epoch = baseEpoch();
  assert.equal(epoch.epochHash, deriveM6EpochHash(epoch));
  assert.match(epoch.epochHash, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(epoch));
  // A caller-supplied epochHash is silently ignored — the record re-derives it.
  const injected = buildEpochRecord({
    gateId: GATE_ID, mode: "OBSERVE_ONLY", releaseId: "release-epoch", sourceCommit: HEX40,
    actor: ACTOR, allowlist: ["01", "02"], lockHashes: LOCKS, issuedAt: ISSUED, expiresAt: EXPIRES,
    parentEpochHash: null, epochHash: "deadbeef".repeat(8),
  });
  assert.notEqual(injected.epochHash, "deadbeef".repeat(8));
  assert.equal(injected.epochHash, deriveM6EpochHash(injected));
});

test("buildEpochRecord rejects invalid inputs (fail closed, no hand-crafted drift)", () => {
  assert.throws(() => baseEpoch({ sourceCommit: "not-hex" }), { code: "M6_EPOCH_INPUT_INVALID" });
  assert.throws(() => baseEpoch({ lockHashes: { ...LOCKS, runtimeProfile: "zz" } }), { code: "M6_EPOCH_INPUT_INVALID" });
  assert.throws(() => baseEpoch({ expiresAt: ISSUED }), { code: "M6_EPOCH_INPUT_INVALID" }); // expires <= issued
  assert.throws(() => baseEpoch({ allowlist: [] }), { code: "M6_EPOCH_INPUT_INVALID" });
  assert.throws(() => baseEpoch({ allowlist: ["01", "01"] }), { code: "M6_EPOCH_INPUT_INVALID" }); // not unique
  assert.throws(() => baseEpoch({ gateId: "bad gate" }), { code: "M6_EPOCH_INPUT_INVALID" });
  // CLOSED mode requires a closeoutRef; OBSERVE_ONLY must not carry one.
  assert.throws(() => baseEpoch({ mode: "CLOSED" }), { code: "M6_EPOCH_INPUT_INVALID" });
  assert.throws(() => baseEpoch({ closeoutRef: { id: "c1", sha256: "ff".repeat(32) } }), { code: "M6_EPOCH_INPUT_INVALID" });
  // A bad closeoutRef sha256 on a CLOSED epoch fails.
  assert.throws(() => baseEpoch({ mode: "CLOSED", closeoutRef: { id: "c1", sha256: "not-hex" } }), { code: "M6_EPOCH_INPUT_INVALID" });
});

test("buildCloseoutRecord re-derives closeoutHash and binds to the epoch", () => {
  const epoch = baseEpoch();
  const closeout = buildCloseoutRecord({ epochHash: epoch.epochHash, actor: ACTOR, reason: "release", committedAt: "2026-08-22T06:00:00.000Z" });
  assert.equal(closeout.closeoutHash, deriveM6CloseoutHash(closeout));
  assert.match(closeout.closeoutId, /^closeout_/);
  assert.throws(() => buildCloseoutRecord({ epochHash: "not-hex", actor: ACTOR, reason: "x", committedAt: ISSUED }), { code: "M6_EPOCH_INPUT_INVALID" });
});

test("signEpochProof signs the epochHash bytes and verifies against the allowlist", () => {
  const key = newKey();
  const m6Root = setupGate(key);
  try {
    const epoch = baseEpoch();
    const proof = signEpochProof(epoch, key.privateKeyPem, { keyId: KEY_ID, subject: ACTOR, allowlistVersion: 1 });
    assert.equal(proof.algorithm, "ed25519");
    assert.match(proof.signature, /^[A-Za-z0-9+/]+={0,2}$/);
    // Verify via the loader's verifyEpochProof (round-trip).
    const allowlist = loadGateIssuerAllowlist(issuerKeysPath(m6Root));
    const result = verifyEpochProof({ epoch, epochHash: epoch.epochHash, proof, allowlist });
    assert.equal(result.keyId, KEY_ID);
  } finally { clean(m6Root); }
});

test("signEpochProof fails closed on a missing/unreadable key file (M6_EPOCH_KEY_INVALID)", () => {
  const epoch = baseEpoch();
  assert.throws(
    () => signEpochProof(epoch, join(tempBase, "definitely-missing-key.pem"), { keyId: KEY_ID, subject: ACTOR, allowlistVersion: 1 }),
    { code: "M6_EPOCH_KEY_INVALID" },
  );
});

test("mint + activate + status: an OBSERVE_ONLY epoch opens the gate; immutable refuse-overwrite", () => {
  const key = newKey();
  const m6Root = setupGate(key);
  try {
    const epoch = baseEpoch();
    const proof = signEpochProof(epoch, key.privateKeyPem, { keyId: KEY_ID, subject: ACTOR, allowlistVersion: 1 });
    const path = mintEpoch({ m6Root, gateId: GATE_ID, epoch, proof });
    assert.ok(path.includes("epochs") && path.endsWith(`${epoch.epochHash}.json`));
    // Refuse-overwrite: minting the same epoch twice fails (M6_GATE_IMMUTABLE).
    assert.throws(() => mintEpoch({ m6Root, gateId: GATE_ID, epoch, proof }), { code: "M6_GATE_IMMUTABLE" });
    // Activate as the first epoch.
    activateGate({ m6Root, gateId: GATE_ID, chain: [epoch.epochHash], tailEpochHash: epoch.epochHash, promotedAt: ISSUED });
    const active = readActiveGate({ m6Root, gateId: GATE_ID, issuerAllowlistPath: issuerKeysPath(m6Root) });
    assert.equal(active.chain.length, 1);
    assert.equal(active.tailEpochHash, epoch.epochHash);
    // Evaluate (verifyEpochProof ran inside loadM6Gate already).
    const result = evaluateM6Gate({ chain: active.epochs, closeouts: active.closeouts, nowMs: NOW, lockHashes: active.lockHashes });
    assert.equal(result.mode, "OBSERVE_ONLY");
    assert.deepEqual(result.errors, []);
  } finally { clean(m6Root); }
});

test("close: a closeout-bound CLOSED epoch seals the gate CLOSED", () => {
  const key = newKey();
  const m6Root = setupGate(key);
  try {
    const epoch = baseEpoch();
    const proof = signEpochProof(epoch, key.privateKeyPem, { keyId: KEY_ID, subject: ACTOR, allowlistVersion: 1 });
    mintEpoch({ m6Root, gateId: GATE_ID, epoch, proof });
    activateGate({ m6Root, gateId: GATE_ID, chain: [epoch.epochHash], tailEpochHash: epoch.epochHash, promotedAt: ISSUED });

    const closeout = buildCloseoutRecord({ epochHash: epoch.epochHash, actor: ACTOR, reason: "release", committedAt: "2026-08-22T06:00:00.000Z" });
    const closedEpoch = baseEpoch({
      mode: "CLOSED",
      issuedAt: "2026-08-22T06:00:00.000Z",
      parentEpochHash: epoch.epochHash,
      closeoutRef: { id: closeout.closeoutId, sha256: closeout.closeoutHash },
    });
    const closedProof = signEpochProof(closedEpoch, key.privateKeyPem, { keyId: KEY_ID, subject: ACTOR, allowlistVersion: 1 });
    writeCloseout({ m6Root, gateId: GATE_ID, closeout });
    mintEpoch({ m6Root, gateId: GATE_ID, epoch: closedEpoch, proof: closedProof });
    activateGate({ m6Root, gateId: GATE_ID, chain: [epoch.epochHash, closedEpoch.epochHash], tailEpochHash: closedEpoch.epochHash, promotedAt: "2026-08-22T06:00:00.000Z" });

    const active = readActiveGate({ m6Root, gateId: GATE_ID, issuerAllowlistPath: issuerKeysPath(m6Root) });
    assert.equal(active.chain.length, 2);
    // The closeout registry holds the sealed closeout keyed by id.
    assert.ok(active.closeouts[closeout.closeoutId], "closeout registry holds the seal");
    const result = evaluateM6Gate({ chain: active.epochs, closeouts: active.closeouts, nowMs: NOW, lockHashes: active.lockHashes });
    assert.equal(result.mode, "CLOSED");
    assert.deepEqual(result.errors, []);
    // The seal resolves and its sha256 binding matches the closeout's hash.
    const seal = resolveM6Closeout(closedEpoch.closeoutRef, active.closeouts);
    assert.equal(seal.ok, true);
    assert.equal(seal.closeout.closeoutHash, closeout.closeoutHash);
  } finally { clean(m6Root); }
});

test("resolveLatestEpoch finds the unactivated epoch binding to the current tail", () => {
  const key = newKey();
  const m6Root = setupGate(key);
  try {
    const epoch = baseEpoch();
    const proof = signEpochProof(epoch, key.privateKeyPem, { keyId: KEY_ID, subject: ACTOR, allowlistVersion: 1 });
    mintEpoch({ m6Root, gateId: GATE_ID, epoch, proof });
    // Not yet activated: resolveLatestEpoch must return the minted hash (parent null).
    const latest = resolveLatestEpoch({ m6Root, gateId: GATE_ID, issuerAllowlistPath: issuerKeysPath(m6Root) });
    assert.equal(latest, epoch.epochHash);
    // After activation there is no unactivated candidate left.
    activateGate({ m6Root, gateId: GATE_ID, chain: [epoch.epochHash], tailEpochHash: epoch.epochHash, promotedAt: ISSUED });
    assert.throws(
      () => resolveLatestEpoch({ m6Root, gateId: GATE_ID, issuerAllowlistPath: issuerKeysPath(m6Root) }),
      { code: "M6_EPOCH_MISSING" },
    );
  } finally { clean(m6Root); }
});

test("rollback: restoring a tombstoned pointer returns the chain to the prior tail", () => {
  const key = newKey();
  const m6Root = setupGate(key);
  try {
    const e1 = baseEpoch();
    const p1 = signEpochProof(e1, key.privateKeyPem, { keyId: KEY_ID, subject: ACTOR, allowlistVersion: 1 });
    mintEpoch({ m6Root, gateId: GATE_ID, epoch: e1, proof: p1 });
    activateGate({ m6Root, gateId: GATE_ID, chain: [e1.epochHash], tailEpochHash: e1.epochHash, promotedAt: ISSUED });

    const e2 = baseEpoch({ parentEpochHash: e1.epochHash, issuedAt: "2026-08-22T01:00:00.000Z" });
    const p2 = signEpochProof(e2, key.privateKeyPem, { keyId: KEY_ID, subject: ACTOR, allowlistVersion: 1 });
    mintEpoch({ m6Root, gateId: GATE_ID, epoch: e2, proof: p2 });
    activateGate({ m6Root, gateId: GATE_ID, chain: [e1.epochHash, e2.epochHash], tailEpochHash: e2.epochHash, promotedAt: "2026-08-22T01:00:00.000Z" });
    // Activating e2 tombstoned the e1 pointer.
    let active = readActiveGate({ m6Root, gateId: GATE_ID, issuerAllowlistPath: issuerKeysPath(m6Root) });
    assert.equal(active.tailEpochHash, e2.epochHash);

    rollbackGate({ m6Root, gateId: GATE_ID, toTailEpochHash: e1.epochHash, promotedAt: "2026-08-22T02:00:00.000Z" });
    active = readActiveGate({ m6Root, gateId: GATE_ID, issuerAllowlistPath: issuerKeysPath(m6Root) });
    assert.equal(active.tailEpochHash, e1.epochHash);
    assert.deepEqual(active.chain, [e1.epochHash]);
  } finally { clean(m6Root); }
});

test("rollback to a nonexistent tail fails closed (M6_EPOCH_ROLLBACK_NO_TARGET)", () => {
  const key = newKey();
  const m6Root = setupGate(key);
  try {
    const epoch = baseEpoch();
    const proof = signEpochProof(epoch, key.privateKeyPem, { keyId: KEY_ID, subject: ACTOR, allowlistVersion: 1 });
    mintEpoch({ m6Root, gateId: GATE_ID, epoch, proof });
    activateGate({ m6Root, gateId: GATE_ID, chain: [epoch.epochHash], tailEpochHash: epoch.epochHash, promotedAt: ISSUED });
    assert.throws(
      () => rollbackGate({ m6Root, gateId: GATE_ID, toTailEpochHash: "ff".repeat(32), promotedAt: ISSUED }),
      { code: "M6_EPOCH_ROLLBACK_NO_TARGET" },
    );
  } finally { clean(m6Root); }
});

test("readActiveGate fails closed when pinned locks are absent (M6_LOCKS_MISSING)", () => {
  const key = newKey();
  const m6Root = newRoot();
  try {
    writeAllowlist(m6Root, [{ keyId: KEY_ID, subject: ACTOR, publicKey: key.publicKeyPem, status: "active" }]);
    // No locks.v1.json — the loader fail-closes before the gate can be read.
    assert.throws(
      () => readActiveGate({ m6Root, gateId: GATE_ID, issuerAllowlistPath: issuerKeysPath(m6Root) }),
      { code: "M6_LOCKS_MISSING" },
    );
  } finally { clean(m6Root); }
});