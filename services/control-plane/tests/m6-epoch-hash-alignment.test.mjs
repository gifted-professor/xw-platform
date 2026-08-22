// M6-2 W8 #1 — gate contract ↔ runtime epoch-hash parity.
//
// The runtime `deriveM6EpochHash` (control-plane) and the contract
// `deriveM6LiveGateEpochHash` (orchestrator) MUST derive the identical hash for the
// same schema-valid epoch, so an epoch minted by one side is accepted by the
// other. They agree on the strip (only `epochHash` is removed), the canonical
// serialization (`canonicalJson` ≡ `stableStringify`), and — after the W8 fix —
// the hash prefix (`xw.m6-live-gate.v1:`). Before W8 the runtime used the prefix
// `xw.m6-live-gate.v1:epoch:` and rejected every contract-minted epoch as
// M6_GATE_EPOCH_FORGED.
//
// This is a cross-layer test: it imports the orchestrator contract validators
// (tests may cross layers; the authority/fusion gates skip `tests/` dirs and do
// not analyze import trees). It is the canonical place to assert parity.
import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, sha256 } from "../control-plane/lib/canonical.mjs";
import { deriveM6EpochHash, evaluateM6Gate } from "../control-plane/lib/m6-live-gate.mjs";
import {
  deriveM6LiveGateEpochHash,
  validateM6LiveGate,
} from "../../orchestrator/scripts/lib/m6/m6-contracts.mjs";

const HEX40 = "a".repeat(40);
const HEX64 = "b".repeat(64);
const LOCKS = {
  runtimeProfile: HEX64,
  hardRedlinePolicy: HEX64,
  groundingRuntime: HEX64,
};

// Build a schema-valid OBSERVE_ONLY epoch (no epochHash yet — both sides derive it).
function rawEpoch(overrides = {}) {
  return {
    schemaId: "xw.m6-live-gate.v1",
    gateId: "gate-parity",
    mode: "OBSERVE_ONLY",
    status: "active",
    releaseId: "release-parity",
    sourceCommit: HEX40,
    actor: "operator:parity",
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
}

function withHash(raw, hash) {
  return { ...raw, epochHash: hash };
}

test("runtime and contract derive the identical epoch hash for a schema-valid epoch", () => {
  const raw = rawEpoch();
  const runtimeHash = deriveM6EpochHash(raw);
  const contractHash = deriveM6LiveGateEpochHash(raw);
  assert.equal(runtimeHash, contractHash);
  assert.match(runtimeHash, /^[0-9a-f]{64}$/);
});

test("an epoch minted by the contract is accepted by the runtime gate", () => {
  const raw = rawEpoch();
  const epoch = withHash(raw, deriveM6LiveGateEpochHash(raw));
  // Runtime self-hash must agree with the embedded contract hash.
  assert.equal(deriveM6EpochHash(epoch), epoch.epochHash);
  const gate = evaluateM6Gate({
    chain: [epoch],
    closeouts: {},
    nowMs: Date.parse("2026-08-22T12:00:00.000Z"),
    expectedRelease: { releaseId: epoch.releaseId, sourceCommit: epoch.sourceCommit },
    lockHashes: LOCKS,
  });
  assert.equal(gate.mode, "OBSERVE_ONLY");
  assert.equal(gate.activeEpochHash, epoch.epochHash);
  assert.deepEqual(gate.errors, []);
});

test("an epoch minted by the runtime is accepted by the contract validator", () => {
  const raw = rawEpoch();
  const epoch = withHash(raw, deriveM6EpochHash(raw));
  // Contract self-hash must agree with the embedded runtime hash.
  assert.equal(deriveM6LiveGateEpochHash(epoch), epoch.epochHash);
  const result = validateM6LiveGate(epoch);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("a one-byte payload mutation moves both hashes equally (parity is structural)", () => {
  const raw = rawEpoch();
  const mutated = rawEpoch({ actor: "operator:parity-x" });
  assert.notEqual(deriveM6EpochHash(raw), deriveM6EpochHash(mutated));
  assert.notEqual(deriveM6LiveGateEpochHash(raw), deriveM6LiveGateEpochHash(mutated));
  // The two sides still agree on the mutated hash.
  assert.equal(deriveM6EpochHash(mutated), deriveM6LiveGateEpochHash(mutated));
});

test("regression: an old `:epoch:`-prefix hash is now rejected as forged", () => {
  const raw = rawEpoch();
  const { epochHash: _ignored, ...payload } = raw;
  const oldPrefixHash = sha256(`xw.m6-live-gate.v1:epoch:${canonicalJson(payload)}`);
  // Sanity: the old-prefix hash differs from the aligned hash.
  assert.notEqual(oldPrefixHash, deriveM6EpochHash(raw));
  const forged = withHash(raw, oldPrefixHash);
  const gate = evaluateM6Gate({
    chain: [forged],
    closeouts: {},
    nowMs: Date.parse("2026-08-22T12:00:00.000Z"),
    expectedRelease: { releaseId: forged.releaseId, sourceCommit: forged.sourceCommit },
    lockHashes: LOCKS,
  });
  assert.equal(gate.mode, "CLOSED");
  assert.ok(gate.errors.some((e) => e.code === "M6_GATE_EPOCH_FORGED"), JSON.stringify(gate.errors));
});

test("closeoutRef is part of the hashed payload (chain binding is total)", () => {
  const raw = rawEpoch();
  const sealed = rawEpoch({
    mode: "CLOSED",
    status: "closed",
    closeoutRef: { id: "closeout-1", sha256: "c".repeat(64) },
  });
  // Adding/changing closeoutRef changes the hash on both sides.
  assert.notEqual(deriveM6EpochHash(raw), deriveM6EpochHash(sealed));
  assert.equal(deriveM6EpochHash(sealed), deriveM6LiveGateEpochHash(sealed));
});
