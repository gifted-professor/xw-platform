import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

import { sha256 } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";

function unavailable(message) {
  throw new ControlPlaneError("STANDING_GRANT_ISSUER_UNAVAILABLE", message, { status: 503 });
}

function invalidProof(message) {
  throw new ControlPlaneError("GRANT_PROOF_INVALID", message, { status: 403 });
}

function normalizeAllowlist(value) {
  if (!value || typeof value !== "object" || !Number.isInteger(value.version) || value.version < 1 || !Array.isArray(value.keys)) {
    unavailable("standing grant issuer allowlist is malformed");
  }
  const keys = new Map();
  for (const item of value.keys) {
    if (!item || typeof item !== "object" || typeof item.keyId !== "string" || typeof item.subject !== "string" || typeof item.publicKey !== "string") {
      unavailable("standing grant issuer allowlist contains an invalid key");
    }
    try { createPublicKey(item.publicKey); } catch { unavailable("standing grant issuer allowlist contains an invalid public key"); }
    if (keys.has(item.keyId)) unavailable("standing grant issuer allowlist contains duplicate key ids");
    keys.set(item.keyId, Object.freeze({
      keyId: item.keyId,
      subject: item.subject,
      publicKey: item.publicKey,
      status: item.status || "revoked",
    }));
  }
  return Object.freeze({ version: value.version, keys });
}

export class TrustedHumanIssuer {
  constructor({ allowlist } = {}) {
    this.allowlist = normalizeAllowlist(allowlist);
  }

  static fromFile(path) {
    if (typeof path !== "string" || path.trim() === "") unavailable("standing grant issuer allowlist path is required");
    try { return new TrustedHumanIssuer({ allowlist: JSON.parse(readFileSync(path, "utf8")) }); } catch (error) {
      if (error instanceof ControlPlaneError) throw error;
      unavailable("standing grant issuer allowlist cannot be loaded");
    }
  }

  hasActiveKey(keyId, subject = "user:a1234") {
    const key = this.allowlist.keys.get(keyId);
    return Boolean(key && key.status === "active" && key.subject === subject);
  }

  verifyIssue({ payload, bytes, proof }) {
    if (!proof || typeof proof !== "object" || typeof proof.keyId !== "string" || !Number.isInteger(proof.allowlistVersion) || typeof proof.signature !== "string") {
      invalidProof("signed issuer proof is required");
    }
    if (payload.subject !== "user:a1234" || proof.allowlistVersion !== this.allowlist.version || payload.allowlistVersion !== this.allowlist.version) {
      invalidProof("issuer proof does not match the active allowlist version");
    }
    const key = this.allowlist.keys.get(proof.keyId);
    if (!key || key.status !== "active" || key.subject !== "user:a1234") unavailable("standing grant issuer key is unavailable");
    let valid = false;
    try { valid = verify(null, Buffer.from(bytes), createPublicKey(key.publicKey), Buffer.from(proof.signature, "base64")); } catch { valid = false; }
    if (!valid) invalidProof("issuer signature verification failed");
    return Object.freeze({ subject: key.subject, keyId: key.keyId, allowlistVersion: this.allowlist.version, proofHash: sha256(proof.signature) });
  }
}
