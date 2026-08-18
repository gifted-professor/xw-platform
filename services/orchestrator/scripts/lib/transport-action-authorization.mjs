/**
 * transportActionAuthorization (Foundation PR3 / INV-02) — registry twin of
 * routing control-plane/lib/transport-action-authorization.mjs.
 * Kernel only (issue/consume/bypass); durable StateStore lives on Windows CP.
 */

import { createHash, randomBytes } from "node:crypto";

export const TRANSPORT_AUTH_PROTOCOL_VERSION = "xhs.transport-action-auth.v1";
export const TRANSPORT_AUTH_KINDS = Object.freeze(["capability_job", "mission_device_run"]);
export const TRANSPORT_AUTH_PURPOSES = Object.freeze(["execute", "verify", "restore", "return_home", "observe"]);
export const WRITE_PURPOSES = Object.freeze(new Set(["execute", "restore", "return_home"]));

export const PURPOSE_ALLOWED_JOB_STATUS = Object.freeze({
  execute: Object.freeze(["running"]),
  verify: Object.freeze(["running", "verifying"]),
  restore: Object.freeze(["restoring"]),
  return_home: Object.freeze(["restoring"]),
  observe: Object.freeze(["running", "verifying", "restoring"]),
});

export const FORBIDDEN_WRITE_AUTHORITY_SOURCES = Object.freeze([
  "session",
  "explorer",
  "recovery",
  "bypass",
  "lab_bypass",
]);

function fail(code, message, status = 400, details = undefined) {
  return Object.assign(new Error(message), { code, status, details });
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonicalize(value[k])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function nowIso(now = Date.now) {
  return new Date(now()).toISOString();
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw fail("TRANSPORT_AUTH_INVALID", `${label} is required`);
  }
  return value;
}

function requireHex64(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw fail("TRANSPORT_AUTH_INVALID", `${label} must be 64 hex`);
  }
  return value;
}

export function isWritePurpose(purpose) {
  return WRITE_PURPOSES.has(purpose);
}

export function assertTransportAuthKind(kind) {
  if (!TRANSPORT_AUTH_KINDS.includes(kind)) {
    throw fail(
      "TRANSPORT_AUTH_KIND_FORBIDDEN",
      `authority kind must be capability_job|mission_device_run (got ${kind})`,
      403,
      { kind },
    );
  }
  return kind;
}

export function assertPurposeAllowedForJobStatus(purpose, jobStatus) {
  if (!TRANSPORT_AUTH_PURPOSES.includes(purpose)) {
    throw fail("TRANSPORT_AUTH_PURPOSE_INVALID", `unsupported purpose ${purpose}`);
  }
  const allowed = PURPOSE_ALLOWED_JOB_STATUS[purpose] || [];
  if (!allowed.includes(jobStatus)) {
    throw fail(
      "TRANSPORT_AUTH_PURPOSE_STATUS_MISMATCH",
      `purpose ${purpose} not allowed in job status ${jobStatus}`,
      409,
      { purpose, jobStatus, allowed },
    );
  }
  return true;
}

export function assertWritableAuthoritySource({ kind, source = null, purpose }) {
  assertTransportAuthKind(kind);
  if (!isWritePurpose(purpose)) return true;
  const src = source == null ? null : String(source);
  if (src && FORBIDDEN_WRITE_AUTHORITY_SOURCES.includes(src)) {
    throw fail(
      "TRANSPORT_AUTH_WRITE_FORBIDDEN",
      `source ${src} cannot mint write transport authority`,
      403,
      { source: src, purpose, kind },
    );
  }
  return true;
}

function mintNonce() {
  return randomBytes(24).toString("hex");
}

function hashNonce(nonce) {
  return sha256(nonce);
}

export function issueTransportActionAuthorization({
  kind,
  purpose,
  jobId = null,
  runId = null,
  missionId = null,
  deviceRunId = null,
  leaseId,
  deviceId,
  operationKey,
  capabilityContractHash,
  implementationClosureHash = null,
  jobStatus = null,
  source = null,
  ttlMs = 60_000,
  now = Date.now,
} = {}) {
  assertWritableAuthoritySource({ kind, source, purpose });
  if (kind === "capability_job") {
    requireText(jobId, "jobId");
    if (jobStatus) assertPurposeAllowedForJobStatus(purpose, jobStatus);
  } else {
    requireText(missionId, "missionId");
    requireText(deviceRunId, "deviceRunId");
  }
  requireText(leaseId, "leaseId");
  requireText(deviceId, "deviceId");
  requireText(operationKey, "operationKey");
  requireHex64(capabilityContractHash, "capabilityContractHash");
  if (implementationClosureHash != null) requireHex64(implementationClosureHash, "implementationClosureHash");

  const nonce = mintNonce();
  const issuedAt = nowIso(now);
  const expiresAt = new Date(now() + ttlMs).toISOString();
  const authorizationId = `tauth_${createHash("sha256").update(`${nonce}:${issuedAt}`).digest("hex").slice(0, 24)}`;

  const record = {
    schemaId: TRANSPORT_AUTH_PROTOCOL_VERSION,
    authorizationId,
    kind,
    purpose,
    jobId,
    runId,
    missionId,
    deviceRunId,
    leaseId,
    deviceId,
    operationKey,
    capabilityContractHash,
    implementationClosureHash,
    nonceHash: hashNonce(nonce),
    issuedAt,
    expiresAt,
    consumedAt: null,
    source: source || null,
  };

  return {
    authorization: record,
    token: {
      authorizationId,
      nonce,
      purpose,
      kind,
      deviceId,
      leaseId,
      expiresAt,
      protocolVersion: TRANSPORT_AUTH_PROTOCOL_VERSION,
    },
  };
}

export function consumeTransportActionAuthorization({
  stored,
  token,
  expectedPurpose,
  expectedDeviceId,
  expectedLeaseId,
  now = Date.now,
} = {}) {
  if (!stored || typeof stored !== "object") {
    throw fail("TRANSPORT_AUTH_NOT_FOUND", "authorization missing", 404);
  }
  if (!token?.nonce || !token?.authorizationId) {
    throw fail("TRANSPORT_AUTH_TOKEN_INVALID", "token authorizationId+nonce required");
  }
  if (stored.authorizationId !== token.authorizationId) {
    throw fail("TRANSPORT_AUTH_TOKEN_MISMATCH", "authorizationId mismatch", 403);
  }
  if (stored.consumedAt) {
    throw fail("TRANSPORT_AUTH_REPLAY", "authorization nonce already consumed", 409, {
      authorizationId: stored.authorizationId,
    });
  }
  if (hashNonce(token.nonce) !== stored.nonceHash) {
    throw fail("TRANSPORT_AUTH_NONCE_INVALID", "nonce mismatch", 403);
  }
  if (expectedPurpose && stored.purpose !== expectedPurpose) {
    throw fail("TRANSPORT_AUTH_PURPOSE_MISMATCH", "purpose mismatch", 403, {
      expected: expectedPurpose,
      actual: stored.purpose,
    });
  }
  if (expectedDeviceId && stored.deviceId !== expectedDeviceId) {
    throw fail("TRANSPORT_AUTH_DEVICE_MISMATCH", "deviceId mismatch", 403);
  }
  if (expectedLeaseId && stored.leaseId !== expectedLeaseId) {
    throw fail("TRANSPORT_AUTH_LEASE_MISMATCH", "leaseId mismatch", 403);
  }
  const exp = Date.parse(stored.expiresAt);
  if (Number.isFinite(exp) && now() >= exp) {
    throw fail("TRANSPORT_AUTH_EXPIRED", "authorization expired", 409);
  }

  return {
    ...stored,
    consumedAt: nowIso(now),
  };
}

export function transportAuthorizationFingerprint(authorization) {
  return sha256(canonicalJson({
    kind: authorization.kind,
    purpose: authorization.purpose,
    jobId: authorization.jobId,
    missionId: authorization.missionId,
    deviceRunId: authorization.deviceRunId,
    leaseId: authorization.leaseId,
    deviceId: authorization.deviceId,
    operationKey: authorization.operationKey,
    capabilityContractHash: authorization.capabilityContractHash,
    implementationClosureHash: authorization.implementationClosureHash,
    nonceHash: authorization.nonceHash,
  }));
}

export function assertProductionBypassClosed({
  env = process.env,
  purpose = "execute",
} = {}) {
  if (env.XHS_ALLOW_BYPASS === "1" && isWritePurpose(purpose)) {
    throw fail(
      "TRANSPORT_BYPASS_DISABLED_P0",
      "XHS_ALLOW_BYPASS cannot mint write transport authority in Foundation P0-B/PR3",
      403,
      { purpose, bypassEnabled: false },
    );
  }
  return { bypassEnabled: false };
}
