import {
  canonicalGrantIssueSigningBytes,
  canonicalGrantRevokeSigningBytes,
  delegationGrantContentHash,
  grantIssueSigningPayload,
  grantRevokeSigningPayload,
  validateDelegationGrantDraft,
} from "./delegation-grant-policy.mjs";
import { ControlPlaneError } from "./errors.mjs";

export class DelegationGrantRuntime {
  constructor({ state, issuer }) {
    this.state = state;
    this.issuer = issuer;
  }

  issue({ grant, proof }) {
    if (!proof || !Number.isInteger(proof.allowlistVersion)) {
      throw new ControlPlaneError("GRANT_PROOF_INVALID", "signed issuer proof is required", { status: 403 });
    }
    const normalizedGrant = validateDelegationGrantDraft(grant);
    if (proof.keyId !== normalizedGrant.issuer.keyId) {
      throw new ControlPlaneError("ISSUER_KEY_MISMATCH", "proof keyId must match the signed grant issuer keyId", { status: 403 });
    }
    const grantHash = delegationGrantContentHash(normalizedGrant);
    const payload = grantIssueSigningPayload({
      subject: normalizedGrant.issuer.subject,
      grantId: normalizedGrant.grantId,
      issuanceNonce: normalizedGrant.issuanceNonce,
      allowlistVersion: proof?.allowlistVersion,
      grantHash,
      grant: normalizedGrant,
    });
    const receipt = this.issuer.verifyIssue({ payload, bytes: canonicalGrantIssueSigningBytes(payload), proof });
    return this.state.issueDelegationGrant({
      grant: normalizedGrant,
      grantHash,
      proofHash: receipt.proofHash,
      issuerSubject: receipt.subject,
      issuerKeyId: receipt.keyId,
      allowlistVersion: receipt.allowlistVersion,
    });
  }

  list() {
    return this.state.listDelegationGrants();
  }

  show(grantId) {
    const grant = this.state.getDelegationGrant(grantId);
    if (!grant) throw new ControlPlaneError("GRANT_NOT_FOUND", `unknown delegation grant ${grantId}`, { status: 404 });
    return grant;
  }

  prepareRevoke(grantId, { revocationNonce, reason, allowlistVersion } = {}) {
    const record = this.state.getDelegationGrantRecord(grantId);
    if (!record) throw new ControlPlaneError("GRANT_NOT_FOUND", `unknown delegation grant ${grantId}`, { status: 404 });
    if (record.status !== "active") throw new ControlPlaneError("GRANT_REVOKED", "revoked delegation grants cannot start another ceremony", { status: 409 });
    if (allowlistVersion !== this.issuer.allowlistVersion) throw new ControlPlaneError("GRANT_PROOF_INVALID", "revocation allowlist version is not current", { status: 403 });
    const payload = grantRevokeSigningPayload({ subject: record.issuer.subject, grantId: record.grantId, grantHash: record.grantHash, revocationNonce, allowlistVersion, reason });
    return { grantId: record.grantId, grantHash: record.grantHash, revocationNonce: payload.revocationNonce, reason: payload.reason, allowlistVersion, signingBytesBase64: Buffer.from(canonicalGrantRevokeSigningBytes(payload), "utf8").toString("base64") };
  }

  revoke(grantId, { revocationNonce, reason, proof } = {}) {
    const record = this.state.getDelegationGrantRecord(grantId);
    if (!record) throw new ControlPlaneError("GRANT_NOT_FOUND", `unknown delegation grant ${grantId}`, { status: 404 });
    if (!proof || proof.keyId !== record.issuer.keyId || !Number.isInteger(proof.allowlistVersion)) {
      throw new ControlPlaneError("GRANT_PROOF_INVALID", "signed issuer revocation proof is required", { status: 403 });
    }
    const payload = grantRevokeSigningPayload({
      subject: record.issuer.subject,
      grantId: record.grantId,
      grantHash: record.grantHash,
      revocationNonce,
      allowlistVersion: proof.allowlistVersion,
      reason,
    });
    const receipt = this.issuer.verifyRevoke({ payload, bytes: canonicalGrantRevokeSigningBytes(payload), proof });
    return this.state.revokeDelegationGrant(grantId, { reason, revocationNonce, proofHash: receipt.proofHash });
  }

  reconcileIssuerKeys() {
    const revoked = [];
    for (const grant of this.state.listDelegationGrants()) {
      if (grant.status === "active" && !this.issuer.hasActiveKey(grant.issuer.keyId, grant.issuer.subject)) {
        revoked.push(this.state.revokeDelegationGrant(grant.grantId, { reason: "issuer_key_unavailable" }));
      }
    }
    return revoked;
  }
}
