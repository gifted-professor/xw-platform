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
