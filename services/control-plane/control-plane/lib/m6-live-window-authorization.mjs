import { createPublicKey, verify as verifySignature } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import {
  M64_LIVE_WINDOW_AUTHORIZATION_SCHEMA_ID,
  M64_LIVE_WINDOW_AUTHORIZATION_SIGNATURE_ALGORITHM,
  M64_LIVE_WINDOW_RUNTIME_BINDING_FIELDS,
  canonicalM64LiveWindowAuthorizationSigningBytes,
  deriveM64LiveWindowAuthorizationBodyHash,
  deriveM64LiveWindowAuthorizationEnvelopeHash,
  equalM64LiveWindowRuntimeBinding,
  selectM64LiveWindowRuntimeBinding,
} from "../../../../packages/kernel/lib/m6-4-live-window-authorization.mjs";
import { ControlPlaneError } from "./errors.mjs";
import { validateJsonSchema } from "./json-schema-validator.mjs";

export const M64_LIVE_WINDOW_ISSUER_ALLOWLIST_SCHEMA_ID = "xw.m6-4-live-window-issuer-allowlist.v1";
const VERIFIED_AUTHORIZATIONS = new WeakSet();
const NORMALIZED_ISSUER_KEYS = new WeakMap();

const AUTHORIZATION_SCHEMA_URL = new URL(
  "../../../../packages/kernel/contracts/orchestration/m6/xw.m6-4-live-window-authorization.v1.schema.json",
  import.meta.url,
);

function fail(code, message, { status = 403, details = {} } = {}) {
  throw new ControlPlaneError(code, message, { status, details });
}

function readJsonSafe(path, codes) {
  const target = resolve(path);
  const dir = resolve(target, "..");
  try {
    if (!lstatSync(dir).isDirectory()) fail(codes.unavailable, "live-window issuer allowlist directory is missing", { status: 503 });
    if (lstatSync(target).isSymbolicLink()) fail(codes.symlink, "live-window issuer allowlist path must not be a symlink", { status: 503 });
    const realDir = realpathSync(dir);
    const realTarget = realpathSync(target);
    const rel = relative(realDir, realTarget);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      fail(codes.escape, "live-window issuer allowlist real path escapes its directory", { status: 503 });
    }
    return JSON.parse(readFileSync(realTarget, "utf8"));
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    fail(codes.unavailable, "live-window issuer allowlist cannot be loaded", { status: 503 });
  }
}

export function loadM64LiveWindowAuthorizationSchema() {
  return JSON.parse(readFileSync(AUTHORIZATION_SCHEMA_URL, "utf8"));
}

export function normalizeM64LiveWindowIssuerAllowlist(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schemaId !== M64_LIVE_WINDOW_ISSUER_ALLOWLIST_SCHEMA_ID
    || !Number.isInteger(value.version) || value.version < 1 || !Array.isArray(value.keys)) {
    fail("M64_LIVE_AUTH_ALLOWLIST_MALFORMED", "live-window issuer allowlist must carry schemaId, version>=1, and keys", { status: 503 });
  }
  const keys = new Map();
  for (const item of value.keys) {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || typeof item.issuer !== "string" || item.issuer === ""
      || typeof item.keyId !== "string" || item.keyId === ""
      || typeof item.publicKey !== "string" || item.publicKey === ""
      || /PRIVATE KEY/u.test(item.publicKey)
      || !["active", "revoked"].includes(item.status)
      || (item.notBefore !== undefined && !Number.isFinite(Date.parse(item.notBefore)))
      || (item.expiresAt !== undefined && !Number.isFinite(Date.parse(item.expiresAt)))) {
      fail("M64_LIVE_AUTH_ISSUER_KEY_INVALID", "live-window issuer allowlist contains an invalid key entry", { status: 503 });
    }
    let publicKey;
    try {
      publicKey = createPublicKey(item.publicKey);
    } catch {
      fail("M64_LIVE_AUTH_ISSUER_KEY_INVALID", "live-window issuer allowlist contains an unparseable public key", { status: 503 });
    }
    if (publicKey.asymmetricKeyType !== "ed25519") {
      fail("M64_LIVE_AUTH_ISSUER_KEY_INVALID", "live-window issuer key must be Ed25519", { status: 503 });
    }
    if (keys.has(item.keyId)) {
      fail("M64_LIVE_AUTH_ISSUER_KEY_DUPLICATE", `live-window issuer allowlist contains duplicate keyId ${item.keyId}`, { status: 503 });
    }
    keys.set(item.keyId, Object.freeze({
      issuer: item.issuer,
      keyId: item.keyId,
      publicKey,
      status: item.status,
      notBefore: item.notBefore ?? null,
      expiresAt: item.expiresAt ?? null,
    }));
  }
  const normalized = Object.freeze({
    schemaId: M64_LIVE_WINDOW_ISSUER_ALLOWLIST_SCHEMA_ID,
    version: value.version,
    // Expose only a compatibility snapshot. Verification reads the private
    // WeakMap copy, so mutating this Map cannot add a self-issued owner key.
    keys: new Map(keys),
  });
  NORMALIZED_ISSUER_KEYS.set(normalized, keys);
  return normalized;
}

export function loadM64LiveWindowIssuerAllowlist(path) {
  if (typeof path !== "string" || path.trim() === "") {
    fail("M64_LIVE_AUTH_ALLOWLIST_UNAVAILABLE", "live-window issuer allowlist path is required", { status: 503 });
  }
  const raw = readJsonSafe(path, {
    unavailable: "M64_LIVE_AUTH_ALLOWLIST_UNAVAILABLE",
    symlink: "M64_LIVE_AUTH_ALLOWLIST_SYMLINK",
    escape: "M64_LIVE_AUTH_ALLOWLIST_PATH_ESCAPE",
  });
  return normalizeM64LiveWindowIssuerAllowlist(raw);
}

function canonicalEd25519Signature(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === 64 && bytes.toString("base64") === value ? bytes : null;
}

function assertRuntimeBindingComplete(runtime) {
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    fail("M64_LIVE_AUTH_RUNTIME_BINDING_MISSING", "trusted live runtime binding is required");
  }
  const missing = M64_LIVE_WINDOW_RUNTIME_BINDING_FIELDS.filter((field) => runtime[field] === undefined);
  if (missing.length > 0) {
    fail("M64_LIVE_AUTH_RUNTIME_BINDING_MISSING", "trusted live runtime binding is incomplete", { details: { missing } });
  }
}

export function verifyM64LiveWindowAuthorization({
  authorization,
  issuerAllowlist,
  runtime,
  nowMs = Date.now(),
} = {}) {
  if (!Number.isFinite(nowMs)) fail("M64_LIVE_AUTH_CLOCK_INVALID", "live-window verifier requires a finite clock", { status: 500 });
  const schemaErrors = validateJsonSchema(authorization, loadM64LiveWindowAuthorizationSchema());
  if (schemaErrors.length > 0) {
    fail("M64_LIVE_AUTH_SCHEMA_INVALID", "live-window authorization does not match the canonical schema", { details: { schemaErrors } });
  }
  if (authorization.schemaId !== M64_LIVE_WINDOW_AUTHORIZATION_SCHEMA_ID
    || authorization.signatureAlgorithm !== M64_LIVE_WINDOW_AUTHORIZATION_SIGNATURE_ALGORITHM
    || !/^[0-9a-f]{40}$/.test(authorization.sourceCommit)) {
    fail("M64_LIVE_AUTH_SCHEMA_INVALID", "live-window authorization schema, algorithm, or source commit is invalid");
  }
  const derivedBodyHash = deriveM64LiveWindowAuthorizationBodyHash(authorization);
  if (authorization.bodyHash !== derivedBodyHash) {
    fail("M64_LIVE_AUTH_BODY_HASH_INVALID", "live-window canonical body hash mismatch");
  }
  const issuedAtMs = Date.parse(authorization.issuedAt);
  const expiresAtMs = Date.parse(authorization.expiresAt);
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= issuedAtMs) {
    fail("M64_LIVE_AUTH_TIME_INVALID", "live-window authorization time interval is invalid");
  }
  if (issuedAtMs > nowMs) {
    fail("M64_LIVE_AUTH_NOT_YET_VALID", "live-window authorization was issued in the future");
  }
  if (expiresAtMs <= nowMs) {
    fail("M64_LIVE_AUTH_EXPIRED", "live-window authorization is expired");
  }
  assertRuntimeBindingComplete(runtime);
  if (!equalM64LiveWindowRuntimeBinding(authorization, runtime)) {
    fail("M64_LIVE_AUTH_RUNTIME_BINDING_MISMATCH", "live-window authorization does not match the exact sealed runtime binding");
  }
  const allowlist = NORMALIZED_ISSUER_KEYS.has(issuerAllowlist)
    ? issuerAllowlist
    : normalizeM64LiveWindowIssuerAllowlist(issuerAllowlist);
  if (authorization.allowlistVersion !== allowlist.version) {
    fail("M64_LIVE_AUTH_ALLOWLIST_VERSION_MISMATCH", "live-window authorization does not use the active allowlist version");
  }
  const key = NORMALIZED_ISSUER_KEYS.get(allowlist).get(authorization.keyId);
  if (!key) fail("M64_LIVE_AUTH_ISSUER_UNKNOWN", "live-window authorization references an unknown owner key");
  if (key.status !== "active") fail("M64_LIVE_AUTH_ISSUER_REVOKED", "live-window authorization references a revoked owner key");
  if (key.issuer !== authorization.issuer) {
    fail("M64_LIVE_AUTH_ISSUER_MISMATCH", "live-window authorization issuer does not own the allowlisted key");
  }
  if ((key.notBefore && Date.parse(key.notBefore) > nowMs) || (key.expiresAt && Date.parse(key.expiresAt) <= nowMs)) {
    fail("M64_LIVE_AUTH_ISSUER_INACTIVE", "live-window authorization owner key is outside its active interval");
  }
  const signature = canonicalEd25519Signature(authorization.signature);
  let valid = false;
  if (signature) {
    try {
      valid = verifySignature(
        null,
        canonicalM64LiveWindowAuthorizationSigningBytes(authorization),
        key.publicKey,
        signature,
      );
    } catch {
      valid = false;
    }
  }
  if (!valid) fail("M64_LIVE_AUTH_SIGNATURE_INVALID", "live-window Ed25519 signature verification failed");
  const derivedEnvelopeHash = deriveM64LiveWindowAuthorizationEnvelopeHash(authorization);
  if (authorization.envelopeHash !== derivedEnvelopeHash) {
    fail("M64_LIVE_AUTH_ENVELOPE_HASH_INVALID", "live-window authorization envelope hash mismatch");
  }
  const verification = Object.freeze({
    schemaId: "xw.m6-4-live-window-authorization-verification.v1",
    authorizationId: authorization.authorizationId,
    nonce: authorization.nonce,
    bodyHash: authorization.bodyHash,
    envelopeHash: authorization.envelopeHash,
    issuer: authorization.issuer,
    keyId: authorization.keyId,
    allowlistVersion: authorization.allowlistVersion,
    issuedAt: authorization.issuedAt,
    expiresAt: authorization.expiresAt,
    runtimeBinding: Object.freeze(selectM64LiveWindowRuntimeBinding(authorization)),
    verifiedAt: new Date(nowMs).toISOString(),
  });
  VERIFIED_AUTHORIZATIONS.add(verification);
  return verification;
}

// StateStore uses this process-local brand so a caller cannot fabricate the
// plain verification receipt and bypass the Ed25519 verifier. Verification is
// intentionally not serializable: every process reopening the database must
// verify the canonical envelope again before attempting its durable consume.
export function isM64LiveWindowAuthorizationVerification(value) {
  return Boolean(value && typeof value === "object" && VERIFIED_AUTHORIZATIONS.has(value));
}
