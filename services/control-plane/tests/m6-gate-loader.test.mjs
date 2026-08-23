// M6-2 W8 #3 — the production M6 gate config loader (m6-gate-loader.mjs).
//
// In production the M6 live gate is materialized from immutable, content-
// addressed epoch files on disk. This test proves the loader reconstructs the
// chain, re-derives every epoch hash, validates the shared schema, verifies
// every epoch's ed25519 issuer signature against the gate issuer allowlist, and
// reads the pinned lock hashes — and fails closed on tampering, bad
// signatures, revoked keys, subject mismatch, missing locks, or a symlink that
// tries to escape its directory. No device I/O; the gate stays CLOSED.
//
// Ed25519 keypairs are generated in-test (generateKeyPairSync); no private key
// is ever committed. The allowlist public key uses the repo's established
// encoding (spki PEM, like trusted-human-issuer.mjs).
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signSignature } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import { deriveM6EpochHash } from "../control-plane/lib/m6-live-gate.mjs";
import {
  deriveM6ActionEpochBindingHash,
  deriveM6EmergencyCloseAuthorizationHash,
  deriveM6V2EpochHash,
  deriveM6V2LockSetHash,
  evaluateM6MixedGate,
  M6_GATE_V2_LOCK_KINDS,
} from "../control-plane/lib/m6-live-gate-v2.mjs";
import {
  loadM6Gate,
  loadM6Locks,
  writeImmutableJson,
  M6_LOCKS_SCHEMA_ID,
} from "../control-plane/lib/m6-gate-loader.mjs";
import {
  loadGateIssuerAllowlist,
  verifyEpochProof,
  M6_GATE_ISSUER_ALLOWLIST_SCHEMA_ID,
} from "../control-plane/lib/m6-issuer-allowlist.mjs";

const tempBase = join(tmpdir(), "m6-gate-loader-test");
mkdirSync(tempBase, { recursive: true });

const HEX40 = "a".repeat(40);
const LOCKS = Object.freeze({
  runtimeProfile: "11".repeat(32),
  hardRedlinePolicy: "22".repeat(32),
  groundingRuntime: "33".repeat(32),
});
const GATE_ID = "gate-loader";
const ACTOR = "operator:loader";
const KEY_ID = "key-1";
const ALLOWLIST_VERSION = 1;

function newRoot() {
  return mkdtempSync(join(tempBase, "root-"));
}

// Build a schema-valid OBSERVE_ONLY epoch (hash derived, never hand-filled).
function buildEpoch(overrides = {}) {
  const raw = {
    schemaId: "xw.m6-live-gate.v1",
    gateId: GATE_ID,
    mode: "OBSERVE_ONLY",
    status: "active",
    releaseId: "release-loader",
    sourceCommit: HEX40,
    actor: ACTOR,
    lockHashes: { ...LOCKS },
    allowlist: ["01", "02"],
    issuedAt: "2026-08-22T00:00:00.000Z",
    expiresAt: "2026-08-23T00:00:00.000Z",
    parentEpochHash: null,
    closeoutRef: null,
    aggregateSealRef: null,
    rollbackTargetEpochHash: null,
    ...overrides,
  };
  return { ...raw, epochHash: deriveM6EpochHash(raw) };
}

// Sign the epochHash bytes with an operator private key (detached ed25519).
function signEpoch(epoch, privateKey, { keyId = KEY_ID, subject = ACTOR, allowlistVersion = ALLOWLIST_VERSION } = {}) {
  const signature = signSignature(null, Buffer.from(epoch.epochHash, "hex"), privateKey).toString("base64");
  return { keyId, subject, allowlistVersion, signature, algorithm: "ed25519" };
}

function writeLocks(m6Root, lockOverrides = {}) {
  const record = {
    schemaId: M6_LOCKS_SCHEMA_ID,
    releaseId: "release-loader",
    sourceCommit: HEX40,
    lockHashes: { ...LOCKS, ...lockOverrides },
  };
  return writeImmutableJson(join(m6Root, "m6-gate", "locks.v1.json"), record);
}

function writeAllowlist(m6Root, keys) {
  const record = { schemaId: M6_GATE_ISSUER_ALLOWLIST_SCHEMA_ID, version: ALLOWLIST_VERSION, keys };
  return writeImmutableJson(join(m6Root, "m6-gate", "issuer-keys.json"), record);
}

function writeGate(m6Root, epochs, { allowlistKeys } = {}) {
  const gateDir = join(m6Root, "m6-gate", GATE_ID);
  const chain = [];
  for (const { epoch, proof } of epochs) {
    writeImmutableJson(join(gateDir, "epochs", `${epoch.epochHash}.json`), { ...epoch, proof });
    chain.push(epoch.epochHash);
  }
  const tail = epochs[epochs.length - 1].epoch.epochHash;
  writeImmutableJson(join(gateDir, "current.json"), { chain, tailEpochHash: tail, promotedAt: "2026-08-22T00:00:00.000Z" });
  return gateDir;
}

function issuerKeysPath(m6Root) {
  return join(m6Root, "m6-gate", "issuer-keys.json");
}

// Probe whether the platform can create a symlink (Windows without dev-mode/
// admin cannot). Tests that need a symlink skip gracefully when this is false.
function canSymlink() {
  const dir = mkdtempSync(join(tempBase, "sym-probe-"));
  try {
    writeFileSync(join(dir, "real.txt"), "x");
    symlinkSync(join(dir, "real.txt"), join(dir, "link.txt"));
    return true;
  } catch { return false; } finally { rmSync(dir, { recursive: true, force: true }); }
}

function clean(...roots) {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}

test("loadM6Gate dispatches a signed v2 epoch and loads content-addressed locks/emergency authorization", () => {
  const m6Root = newRoot();
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeAllowlist(m6Root, [{ keyId: KEY_ID, subject: ACTOR, publicKey: publicKey.export({ type: "spki", format: "pem" }), status: "active" }]);
    writeLocks(m6Root);
    const lockRaw = {
      schemaId: "xw.m6-locks.v2",
      lockSetId: "locks-v2-test",
      lockHashes: Object.fromEntries(M6_GATE_V2_LOCK_KINDS.map((kind, index) => [kind, String(index % 10).repeat(64)])),
    };
    const lockSet = { ...lockRaw, lockSetHash: deriveM6V2LockSetHash(lockRaw) };
    writeImmutableJson(join(m6Root, "m6-gate", "locks.v2", `${lockSet.lockSetId}.json`), lockSet);
    const epochBase = {
      schemaId: "xw.m6-live-gate.v2",
      gateId: GATE_ID,
      mode: "GROUNDED_ACTION",
      purpose: "M6_4_ACTION_SMOKE",
      status: "active",
      releaseId: "release-loader",
      sourceCommit: HEX40,
      actor: ACTOR,
      lockSetRef: { id: lockSet.lockSetId, sha256: lockSet.lockSetHash },
      allowlist: ["01"],
      issuedAt: "2026-08-22T00:00:00.000Z",
      expiresAt: "2026-08-23T01:00:00.000Z",
      parentEpochHash: null,
      closeoutRef: null,
      aggregateSealRef: null,
      rollbackTargetEpochHash: null,
    };
    const authRaw = {
      schemaId: "xw.m6-emergency-close-authorization.v1",
      authorizationId: "emergency-v2-test",
      expectedCurrentEpochHash: null,
      expectedParentEpochHash: null,
      actionEpochBindingHash: deriveM6ActionEpochBindingHash(epochBase),
      releaseId: "release-loader",
      planHash: "b".repeat(64),
      contractHash: "c".repeat(64),
      alias: "01",
      operator: ACTOR,
      reasonCodeAllowlist: ["SAFETY_STOP"],
      nonce: "loader-test-nonce",
      expiresAt: "2026-08-23T01:31:00.000Z",
    };
    const auth = { ...authRaw, authorizationHash: deriveM6EmergencyCloseAuthorizationHash(authRaw) };
    const epochRaw = {
      ...epochBase,
      emergencyCloseAuthorizationRef: { id: auth.authorizationId, sha256: auth.authorizationHash },
    };
    const epoch = { ...epochRaw, epochHash: deriveM6V2EpochHash(epochRaw) };
    writeImmutableJson(join(m6Root, "m6-gate", GATE_ID, "emergency-close", `${auth.authorizationId}.json`), auth);
    writeGate(m6Root, [{ epoch, proof: signEpoch(epoch, privateKey) }]);
    const loaded = loadM6Gate({ m6Root, gateId: GATE_ID, issuerAllowlistPath: issuerKeysPath(m6Root) });
    assert.equal(loaded.chain[0].schemaId, "xw.m6-live-gate.v2");
    assert.equal(loaded.lockSets[lockSet.lockSetId].lockSetHash, lockSet.lockSetHash);
    assert.equal(loaded.emergencyCloseAuthorizations[auth.authorizationId].authorizationHash, auth.authorizationHash);
    const result = evaluateM6MixedGate({
      ...loaded,
      v1LockHashes: loaded.lockHashes,
      nowMs: Date.parse("2026-08-22T12:00:00.000Z"),
      expectedRelease: { releaseId: "release-loader", sourceCommit: HEX40 },
    });
    assert.equal(result.mode, "GROUNDED_ACTION");
  } finally { clean(m6Root); }
});

test("loadM6Gate loads a signed valid epoch chain and the pinned locks", () => {
  const m6Root = newRoot();
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeAllowlist(m6Root, [{ keyId: KEY_ID, subject: ACTOR, publicKey: publicKey.export({ type: "spki", format: "pem" }), status: "active" }]);
    writeLocks(m6Root);
    const epoch = buildEpoch();
    const proof = signEpoch(epoch, privateKey);
    writeGate(m6Root, [{ epoch, proof }]);

    const loaded = loadM6Gate({ m6Root, gateId: GATE_ID, issuerAllowlistPath: issuerKeysPath(m6Root) });
    assert.equal(loaded.chain.length, 1);
    assert.equal(loaded.chain[0].epochHash, epoch.epochHash);
    assert.equal(loaded.tailEpochHash, epoch.epochHash);
    assert.deepEqual(loaded.lockHashes, { ...LOCKS });
    // The loaded epoch must NOT carry the proof sibling (stripped on load).
    assert.equal(loaded.chain[0].proof, undefined);
  } finally { clean(m6Root); }
});

test("loadM6Locks returns frozen pinned lock hashes and rejects a malformed file", () => {
  const m6Root = newRoot();
  try {
    writeLocks(m6Root);
    const locks = loadM6Locks(m6Root);
    assert.deepEqual(locks, { ...LOCKS });
    assert.ok(Object.isFrozen(locks));
    // A non-64-hex value fails closed.
    const m6Root2 = newRoot();
    try {
      writeLocks(m6Root2, { runtimeProfile: "not-hex" });
      assert.throws(() => loadM6Locks(m6Root2), { code: "M6_LOCKS_INVALID" });
    } finally { clean(m6Root2); }
    // A wrong schemaId fails closed.
    const m6Root3 = newRoot();
    try {
      writeImmutableJson(join(m6Root3, "m6-gate", "locks.v1.json"), { schemaId: "xw.something-else.v1", lockHashes: { ...LOCKS } });
      assert.throws(() => loadM6Locks(m6Root3), { code: "M6_LOCKS_INVALID" });
    } finally { clean(m6Root3); }
  } finally { clean(m6Root); }
});

test("missing locks.v1.json with requireLocks fails closed (M6_LOCKS_MISSING); absent with requireLocks:false returns null", () => {
  const m6Root = newRoot();
  try {
    assert.throws(() => loadM6Locks(m6Root), { code: "M6_LOCKS_MISSING" });
    assert.equal(loadM6Locks(m6Root, { requireLocks: false }), null);
  } finally { clean(m6Root); }
});

test("a forged epoch signature fails closed (M6_GATE_ISSUER_SIGNATURE_INVALID)", () => {
  const m6Root = newRoot();
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeAllowlist(m6Root, [{ keyId: KEY_ID, subject: ACTOR, publicKey: publicKey.export({ type: "spki", format: "pem" }), status: "active" }]);
    writeLocks(m6Root);
    const epoch = buildEpoch();
    // Sign with a DIFFERENT keypair → valid ed25519, but not the allowlist key.
    const other = generateKeyPairSync("ed25519");
    const forgedProof = signEpoch(epoch, other.privateKey);
    writeGate(m6Root, [{ epoch, proof: forgedProof }]);

    assert.throws(
      () => loadM6Gate({ m6Root, gateId: GATE_ID, issuerAllowlistPath: issuerKeysPath(m6Root) }),
      { code: "M6_GATE_ISSUER_SIGNATURE_INVALID" },
    );
  } finally { clean(m6Root); }
});

test("a revoked issuer key fails closed (M6_GATE_ISSUER_KEY_REVOKED)", () => {
  const m6Root = newRoot();
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeAllowlist(m6Root, [{ keyId: KEY_ID, subject: ACTOR, publicKey: publicKey.export({ type: "spki", format: "pem" }), status: "revoked" }]);
    writeLocks(m6Root);
    const epoch = buildEpoch();
    const proof = signEpoch(epoch, privateKey);
    writeGate(m6Root, [{ epoch, proof }]);

    assert.throws(
      () => loadM6Gate({ m6Root, gateId: GATE_ID, issuerAllowlistPath: issuerKeysPath(m6Root) }),
      { code: "M6_GATE_ISSUER_KEY_REVOKED" },
    );
  } finally { clean(m6Root); }
});

test("a subject/actor mismatch fails closed (M6_GATE_ISSUER_SUBJECT_MISMATCH)", () => {
  const m6Root = newRoot();
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeAllowlist(m6Root, [{ keyId: KEY_ID, subject: ACTOR, publicKey: publicKey.export({ type: "spki", format: "pem" }), status: "active" }]);
    writeLocks(m6Root);
    // Epoch declares a different actor than the signing key's subject.
    const epoch = buildEpoch({ actor: "operator:someone-else" });
    const proof = signEpoch(epoch, privateKey, { subject: ACTOR });
    writeGate(m6Root, [{ epoch, proof }]);

    assert.throws(
      () => loadM6Gate({ m6Root, gateId: GATE_ID, issuerAllowlistPath: issuerKeysPath(m6Root) }),
      { code: "M6_GATE_ISSUER_SUBJECT_MISMATCH" },
    );
  } finally { clean(m6Root); }
});

test("a tampered epoch payload (self-hash mismatch) fails closed (M6_GATE_EPOCH_FORGED)", () => {
  const m6Root = newRoot();
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeAllowlist(m6Root, [{ keyId: KEY_ID, subject: ACTOR, publicKey: publicKey.export({ type: "spki", format: "pem" }), status: "active" }]);
    writeLocks(m6Root);
    const epoch = buildEpoch();
    const proof = signEpoch(epoch, privateKey);
    // Mutate a payload field AFTER hashing — the embedded epochHash no longer
    // matches the re-derived hash.
    const tampered = { ...epoch, allowlist: ["01", "02", "03"], proof };
    const gateDir = join(m6Root, "m6-gate", GATE_ID);
    writeImmutableJson(join(gateDir, "epochs", `${epoch.epochHash}.json`), tampered);
    writeImmutableJson(join(gateDir, "current.json"), { chain: [epoch.epochHash], tailEpochHash: epoch.epochHash, promotedAt: "2026-08-22T00:00:00.000Z" });

    assert.throws(
      () => loadM6Gate({ m6Root, gateId: GATE_ID, issuerAllowlistPath: issuerKeysPath(m6Root) }),
      { code: "M6_GATE_EPOCH_FORGED" },
    );
  } finally { clean(m6Root); }
});

test("a missing gate directory yields an empty chain (CLOSED) but still loads locks", () => {
  const m6Root = newRoot();
  try {
    writeLocks(m6Root);
    writeAllowlist(m6Root, [{ keyId: KEY_ID, subject: ACTOR, publicKey: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }), status: "active" }]);
    const loaded = loadM6Gate({ m6Root, gateId: "absent-gate", issuerAllowlistPath: issuerKeysPath(m6Root) });
    assert.equal(loaded.chain.length, 0);
    assert.equal(loaded.tailEpochHash, null);
    assert.deepEqual(loaded.lockHashes, { ...LOCKS });
  } finally { clean(m6Root); }
});

test("a current.json with an empty/missing chain yields an empty chain", () => {
  const m6Root = newRoot();
  try {
    writeLocks(m6Root);
    const { publicKey } = generateKeyPairSync("ed25519");
    writeAllowlist(m6Root, [{ keyId: KEY_ID, subject: ACTOR, publicKey: publicKey.export({ type: "spki", format: "pem" }), status: "active" }]);
    const gateDir = join(m6Root, "m6-gate", GATE_ID);
    writeImmutableJson(join(gateDir, "current.json"), { chain: [], tailEpochHash: null, promotedAt: "2026-08-22T00:00:00.000Z" });
    const loaded = loadM6Gate({ m6Root, gateId: GATE_ID, issuerAllowlistPath: issuerKeysPath(m6Root) });
    assert.equal(loaded.chain.length, 0);
  } finally { clean(m6Root); }
});

test("a two-epoch chain is loaded in current.json order and the tail resolves", () => {
  const m6Root = newRoot();
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeAllowlist(m6Root, [{ keyId: KEY_ID, subject: ACTOR, publicKey: publicKey.export({ type: "spki", format: "pem" }), status: "active" }]);
    writeLocks(m6Root);
    const first = buildEpoch();
    const second = buildEpoch({ parentEpochHash: first.epochHash, issuedAt: "2026-08-22T01:00:00.000Z" });
    writeGate(m6Root, [
      { epoch: first, proof: signEpoch(first, privateKey) },
      { epoch: second, proof: signEpoch(second, privateKey) },
    ]);

    const loaded = loadM6Gate({ m6Root, gateId: GATE_ID, issuerAllowlistPath: issuerKeysPath(m6Root) });
    assert.equal(loaded.chain.length, 2);
    assert.equal(loaded.chain[0].epochHash, first.epochHash);
    assert.equal(loaded.chain[1].epochHash, second.epochHash);
    assert.equal(loaded.tailEpochHash, second.epochHash);
  } finally { clean(m6Root); }
});

test("an epoch file whose address does not match its hash fails closed (M6_GATE_EPOCH_ADDRESS_MISMATCH)", () => {
  const m6Root = newRoot();
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeAllowlist(m6Root, [{ keyId: KEY_ID, subject: ACTOR, publicKey: publicKey.export({ type: "spki", format: "pem" }), status: "active" }]);
    writeLocks(m6Root);
    const epoch = buildEpoch();
    const proof = signEpoch(epoch, privateKey);
    // Write under a WRONG filename (a different 64-hex address).
    const wrongAddr = "ff".repeat(32);
    const gateDir = join(m6Root, "m6-gate", GATE_ID);
    writeImmutableJson(join(gateDir, "epochs", `${wrongAddr}.json`), { ...epoch, proof });
    writeImmutableJson(join(gateDir, "current.json"), { chain: [wrongAddr], tailEpochHash: wrongAddr, promotedAt: "2026-08-22T00:00:00.000Z" });

    assert.throws(
      () => loadM6Gate({ m6Root, gateId: GATE_ID, issuerAllowlistPath: issuerKeysPath(m6Root) }),
      { code: "M6_GATE_EPOCH_ADDRESS_MISMATCH" },
    );
  } finally { clean(m6Root); }
});

test("a symlinked epoch file is rejected (M6_GATE_PATH_SYMLINK)", (t) => {
  if (!canSymlink()) { t.skip("symlinks unavailable on this platform"); return; }
  const m6Root = newRoot();
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeAllowlist(m6Root, [{ keyId: KEY_ID, subject: ACTOR, publicKey: publicKey.export({ type: "spki", format: "pem" }), status: "active" }]);
    writeLocks(m6Root);
    const epoch = buildEpoch();
    const proof = signEpoch(epoch, privateKey);
    const gateDir = join(m6Root, "m6-gate", GATE_ID);
    mkdirSync(join(gateDir, "epochs"), { recursive: true });
    // Write the real epoch outside the epochs dir, then symlink it in. The
    // loader must refuse a symlinked artifact path (realpath-escape defense).
    const realFile = join(m6Root, "m6-gate", "real-epoch.json");
    writeFileSync(realFile, JSON.stringify({ ...epoch, proof }));
    symlinkSync(realFile, join(gateDir, "epochs", `${epoch.epochHash}.json`));
    writeImmutableJson(join(gateDir, "current.json"), { chain: [epoch.epochHash], tailEpochHash: epoch.epochHash, promotedAt: "2026-08-22T00:00:00.000Z" });

    assert.throws(
      () => loadM6Gate({ m6Root, gateId: GATE_ID, issuerAllowlistPath: issuerKeysPath(m6Root) }),
      { code: "M6_GATE_PATH_SYMLINK" },
    );
  } finally { clean(m6Root); }
});

test("verifyEpochProof and loadGateIssuerAllowlist round-trip a signed epoch", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const m6Root = newRoot();
  try {
    writeAllowlist(m6Root, [{ keyId: KEY_ID, subject: ACTOR, publicKey: publicKey.export({ type: "spki", format: "pem" }), status: "active" }]);
    const loaded = loadGateIssuerAllowlist(issuerKeysPath(m6Root));
    assert.equal(loaded.version, ALLOWLIST_VERSION);
    assert.equal(loaded.keys.get(KEY_ID).subject, ACTOR);

    const epoch = buildEpoch();
    const proof = signEpoch(epoch, privateKey);
    const result = verifyEpochProof({ epoch, epochHash: epoch.epochHash, proof, allowlist: loaded });
    assert.equal(result.keyId, KEY_ID);
    assert.equal(result.subject, ACTOR);
    assert.equal(result.allowlistVersion, ALLOWLIST_VERSION);

    // A proof with the wrong allowlistVersion is rejected.
    assert.throws(
      () => verifyEpochProof({ epoch, epochHash: epoch.epochHash, proof: { ...proof, allowlistVersion: 999 }, allowlist: loaded }),
      { code: "M6_GATE_ISSUER_PROOF_INVALID" },
    );
    // A proof referencing an unknown key is rejected.
    assert.throws(
      () => verifyEpochProof({ epoch, epochHash: epoch.epochHash, proof: { ...proof, keyId: "no-such-key" }, allowlist: loaded }),
      { code: "M6_GATE_ISSUER_KEY_UNKNOWN" },
    );
  } finally { clean(m6Root); }
});

test("writeImmutableJson refuses to overwrite an existing artifact (M6_GATE_IMMUTABLE)", () => {
  const m6Root = newRoot();
  try {
    const path = join(m6Root, "m6-gate", "locks.v1.json");
    writeLocks(m6Root);
    assert.throws(() => writeImmutableJson(path, { schemaId: M6_LOCKS_SCHEMA_ID, lockHashes: { ...LOCKS } }), { code: "M6_GATE_IMMUTABLE" });
  } finally { clean(m6Root); }
});

test("a malformed allowlist file fails closed", () => {
  const m6Root = newRoot();
  try {
    writeLocks(m6Root);
    writeImmutableJson(join(m6Root, "m6-gate", "issuer-keys.json"), { schemaId: "xw.wrong.v1", version: 1, keys: [] });
    // The gate dir must exist so the loader reaches the allowlist load (it
    // returns early with an empty chain only when the dir is absent).
    mkdirSync(join(m6Root, "m6-gate", GATE_ID), { recursive: true });
    assert.throws(
      () => loadM6Gate({ m6Root, gateId: GATE_ID, issuerAllowlistPath: issuerKeysPath(m6Root) }),
      { code: "M6_GATE_ISSUER_ALLOWLIST_MALFORMED" },
    );
  } finally { clean(m6Root); }
});

test("an invalid gateId is rejected (M6_GATE_ID_INVALID)", () => {
  const m6Root = newRoot();
  try {
    writeLocks(m6Root);
    assert.throws(
      () => loadM6Gate({ m6Root, gateId: "bad gate id with spaces", issuerAllowlistPath: issuerKeysPath(m6Root) }),
      { code: "M6_GATE_ID_INVALID" },
    );
  } finally { clean(m6Root); }
});
