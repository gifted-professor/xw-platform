import { createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256 } from "./canonical.mjs";
import { validateJsonSchema } from "./json-schema-validator.mjs";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(moduleDir, "..", "schema", "payment-approval.schema.json");
const BINDING_FIELDS = Object.freeze([
  "commitId",
  "runId",
  "effectId",
  "app",
  "accountRef",
  "payeeRef",
  "amount",
  "currency",
  "targetControlFingerprint",
  "snapshotHash",
  "deviceId",
  "createdAt",
  "expiresAt",
]);

let defaultSchema = null;
try {
  if (existsSync(schemaPath)) defaultSchema = JSON.parse(readFileSync(schemaPath, "utf8"));
} catch {
  defaultSchema = null;
}

function normalizeAllowlist(value) {
  if (!value || !Number.isInteger(value.version) || value.version < 1 || !Array.isArray(value.keys)) {
    throw new TypeError("payment approval allowlist is malformed");
  }
  const keys = new Map();
  for (const item of value.keys) {
    if (!item || typeof item.keyId !== "string" || typeof item.subject !== "string"
      || item.role !== "human" || typeof item.publicKey !== "string"
      || !Array.isArray(item.purposes) || !item.purposes.includes("financial_commit")) {
      throw new TypeError("payment approval key must be a human financial_commit key");
    }
    if (keys.has(item.keyId)) throw new TypeError("duplicate payment approval key id");
    keys.set(item.keyId, Object.freeze({
      keyId: item.keyId,
      subject: item.subject,
      role: item.role,
      status: item.status || "revoked",
      publicKey: createPublicKey(item.publicKey),
      purposes: Object.freeze([...item.purposes]),
    }));
  }
  return Object.freeze({ version: value.version, keys });
}

export function canonicalPaymentApprovalBytes(approval) {
  const { signature: _signature, ...unsigned } = approval || {};
  return Buffer.from(canonicalJson(unsigned));
}

function failure(code) {
  return Object.freeze({ ok: false, code });
}

export class PaymentApprovalVerifier {
  constructor({ allowlist, schema = defaultSchema, now = Date.now } = {}) {
    this.allowlist = normalizeAllowlist(allowlist);
    this.schema = schema;
    this.now = now;
  }

  verify({ approval, binding } = {}) {
    if (!this.schema) return failure("PAYMENT_APPROVAL_SCHEMA_UNAVAILABLE");
    if (validateJsonSchema(approval, this.schema).length > 0) {
      return failure("PAYMENT_APPROVAL_SCHEMA_INVALID");
    }
    if (!binding || typeof binding !== "object") return failure("PAYMENT_APPROVAL_BINDING_REQUIRED");
    for (const field of BINDING_FIELDS) {
      if (approval[field] !== binding[field]) return failure("PAYMENT_APPROVAL_BINDING_MISMATCH");
    }
    const createdAt = Date.parse(approval.createdAt);
    const expiresAt = Date.parse(approval.expiresAt);
    const nowMs = this.now();
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)
      || createdAt > nowMs || expiresAt <= createdAt || nowMs >= expiresAt) {
      return failure("PAYMENT_APPROVAL_EXPIRED");
    }
    const issuer = approval.issuer;
    if (issuer.allowlistVersion !== this.allowlist.version) {
      return failure("PAYMENT_APPROVAL_ALLOWLIST_MISMATCH");
    }
    const key = this.allowlist.keys.get(issuer.keyId);
    if (!key || key.status !== "active" || key.subject !== issuer.subject
      || key.role !== "human" || issuer.role !== "human"
      || !key.purposes.includes("financial_commit")) {
      return failure("PAYMENT_APPROVAL_ISSUER_INVALID");
    }
    let signatureValid = false;
    try {
      signatureValid = verify(
        null,
        canonicalPaymentApprovalBytes(approval),
        key.publicKey,
        Buffer.from(approval.signature, "base64"),
      );
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) return failure("PAYMENT_APPROVAL_SIGNATURE_INVALID");
    return Object.freeze({
      ok: true,
      code: "PAYMENT_APPROVAL_VERIFIED",
      subject: key.subject,
      keyId: key.keyId,
      proofHash: sha256(approval.signature),
    });
  }
}
