import {
  canonicalGrantIssueSigningBytes,
  delegationGrantContentHash,
  grantIssueSigningPayload,
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

  revoke(grantId, { actor, reason } = {}) {
    const record = this.state.getDelegationGrantRecord(grantId);
    if (!record) throw new ControlPlaneError("GRANT_NOT_FOUND", `unknown delegation grant ${grantId}`, { status: 404 });
    if (typeof actor !== "string" || actor.trim() === "" || typeof reason !== "string" || reason.trim() === "") {
      throw new ControlPlaneError("GRANT_REVOKE_INVALID", "revocation actor and reason are required", { status: 400 });
    }
    return this.state.revokeDelegationGrant(grantId, { actor: actor.trim(), reason: reason.trim() });
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
