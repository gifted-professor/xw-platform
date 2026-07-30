import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalGrantIssueSigningBytes, delegationGrantContentHash } from "../control-plane/lib/delegation-grant-policy.mjs";
import { DelegationGrantRuntime } from "../control-plane/lib/delegation-grant-runtime.mjs";
import { TrustedHumanIssuer } from "../control-plane/lib/trusted-human-issuer.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";

function draft() { return { schemaVersion: 1, grantId: "grant_test_001", issuanceNonce: "nonce_test_001", issuer: { subject: "user:a1234", keyId: "test-key" }, app: "xhs", accountFingerprint: "account-fingerprint", controllers: ["agent:runner"], maxParallelism: 1, authorization: { primitives: ["screenshot"], socialActions: ["collect"], missionOnlyActions: ["delete"], prohibitedActions: ["payment", "publish"] }, targets: { mode: "verified_discovery" }, budget: { maxima: { totalCount: 2, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } }, defaults: { totalCount: 1, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } } }, validity: { expiresAt: null }, redaction: { publicFields: ["alias"] } }; }

function signedProof({ grant, privateKey, keyId = "test-key", allowlistVersion = 1 }) {
  const grantHash = delegationGrantContentHash(grant);
  const payload = { subject: "user:a1234", grantId: grant.grantId, issuanceNonce: grant.issuanceNonce, allowlistVersion, grantHash, grant };
  return { keyId, allowlistVersion, signature: sign(null, Buffer.from(canonicalGrantIssueSigningBytes(payload)), privateKey).toString("base64") };
}

test("verified issue is durable, idempotent, and rejects nonce replay", () => {
  const root = mkdtempSync(join(tmpdir(), "grant-runtime-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const state = new StateStore({ dbPath: join(root, "control.db") });
  try {
    const grant = draft();
    const proof = signedProof({ grant, privateKey });
    const runtime = new DelegationGrantRuntime({ state, issuer: new TrustedHumanIssuer({ allowlist: { version: 1, keys: [{ keyId: "test-key", subject: "user:a1234", publicKey: publicKey.export({ type: "spki", format: "pem" }), status: "active" }] } }) });
    assert.equal(runtime.issue({ grant, proof }).reused, false);
    assert.equal(runtime.issue({ grant, proof }).reused, true);
    const replay = { ...grant, grantId: "grant_test_002" };
    assert.throws(() => runtime.issue({ grant: replay, proof: signedProof({ grant: replay, privateKey }) }), { code: "ISSUANCE_NONCE_REPLAY" });
    assert.equal(state.getDelegationGrant(grant.grantId).status, "active");
  } finally { state.close(); rmSync(root, { recursive: true, force: true }); }
});

test("proof failures write no rows, revoked grants remain revoked, and key reconciliation is durable", () => {
  const root = mkdtempSync(join(tmpdir(), "grant-runtime-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const state = new StateStore({ dbPath: join(root, "control.db") });
  try {
    const grant = draft();
    const active = { version: 1, keys: [{ keyId: "test-key", subject: "user:a1234", publicKey: publicKey.export({ type: "spki", format: "pem" }), status: "active" }] };
    const runtime = new DelegationGrantRuntime({ state, issuer: new TrustedHumanIssuer({ allowlist: active }) });
    assert.throws(() => runtime.issue({ grant }), { code: "GRANT_PROOF_INVALID" });
    assert.throws(() => runtime.issue({ grant, proof: { ...signedProof({ grant, privateKey }), signature: "forged" } }), { code: "GRANT_PROOF_INVALID" });
    assert.equal(state.listDelegationGrants().length, 0);
    runtime.issue({ grant, proof: signedProof({ grant, privateKey }) });
    state.revokeDelegationGrant(grant.grantId, { reason: "offline_revocation" });
    assert.throws(() => runtime.issue({ grant, proof: signedProof({ grant, privateKey }) }), { code: "GRANT_REVOKED" });
    assert.equal(state.listDelegationGrantEvents(grant.grantId).at(-1).type, "delegation_grant.revoked");
    const activeGrant = { ...draft(), grantId: "grant_test_002", issuanceNonce: "nonce_test_002" };
    runtime.issue({ grant: activeGrant, proof: signedProof({ grant: activeGrant, privateKey }) });
    state.close();
    const reopened = new StateStore({ dbPath: join(root, "control.db") });
    try {
      const revokedIssuer = new TrustedHumanIssuer({ allowlist: { ...active, keys: [{ ...active.keys[0], status: "revoked" }] } });
      const recovered = new DelegationGrantRuntime({ state: reopened, issuer: revokedIssuer });
      assert.equal(recovered.reconcileIssuerKeys().length, 1);
      assert.equal(reopened.getDelegationGrant(grant.grantId).status, "revoked");
      assert.equal(reopened.getDelegationGrant(activeGrant.grantId).status, "revoked");
      assert.equal(reopened.listDelegationGrantEvents(activeGrant.grantId).at(-1).type, "delegation_grant.revoked");
    } finally { reopened.close(); }
  } finally { try { state.close(); } catch {} rmSync(root, { recursive: true, force: true }); }
});
