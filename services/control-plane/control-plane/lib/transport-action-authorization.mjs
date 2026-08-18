/**
 * transportActionAuthorization (Foundation PR3 / INV-02).
 * Proves origin (job/mission + lease + device + contract + purpose + one-time nonce).
 * Does NOT prove action semantics (tap is not publish) — that remains TCB Adapter / Contract.
 */

import { createHash, randomBytes } from "node:crypto";

import { ControlPlaneError } from "./errors.mjs";
import { canonicalJson, nowIso, sha256 } from "./canonical.mjs";

export const TRANSPORT_AUTH_PROTOCOL_VERSION = "xhs.transport-action-auth.v1";
export const TRANSPORT_AUTH_KINDS = Object.freeze(["capability_job", "mission_device_run"]);
export const TRANSPORT_AUTH_PURPOSES = Object.freeze(["execute", "verify", "restore", "return_home", "observe"]);
export const WRITE_PURPOSES = Object.freeze(new Set(["execute", "restore", "return_home"]));

/** purpose → allowed job statuses (spec §4.4.3). */
export const PURPOSE_ALLOWED_JOB_STATUS = Object.freeze({
  execute: Object.freeze(["running"]),
  verify: Object.freeze(["running", "verifying"]),
  restore: Object.freeze(["restoring"]),
  return_home: Object.freeze(["restoring"]),
  observe: Object.freeze(["running", "verifying", "restoring"]),
});

/** Kinds that must never receive write transport authority. */
export const FORBIDDEN_WRITE_AUTHORITY_SOURCES = Object.freeze([
  "session",
  "explorer",
  "recovery",
  "bypass",
  "lab_bypass",
]);

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ControlPlaneError("TRANSPORT_AUTH_INVALID", `${label} is required`, { status: 400 });
  }
  return value;
}

function requireHex64(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new ControlPlaneError("TRANSPORT_AUTH_INVALID", `${label} must be 64 hex`, { status: 400 });
  }
  return value;
}

export function isWritePurpose(purpose) {
  return WRITE_PURPOSES.has(purpose);
}

export function assertTransportAuthKind(kind) {
  if (!TRANSPORT_AUTH_KINDS.includes(kind)) {
    throw new ControlPlaneError(
      "TRANSPORT_AUTH_KIND_FORBIDDEN",
      `authority kind must be capability_job|mission_device_run (got ${kind})`,
      { status: 403, details: { kind } },
    );
  }
  return kind;
}

export function assertPurposeAllowedForJobStatus(purpose, jobStatus) {
  if (!TRANSPORT_AUTH_PURPOSES.includes(purpose)) {
    throw new ControlPlaneError("TRANSPORT_AUTH_PURPOSE_INVALID", `unsupported purpose ${purpose}`, { status: 400 });
  }
  const allowed = PURPOSE_ALLOWED_JOB_STATUS[purpose] || [];
  if (!allowed.includes(jobStatus)) {
    throw new ControlPlaneError(
      "TRANSPORT_AUTH_PURPOSE_STATUS_MISMATCH",
      `purpose ${purpose} not allowed in job status ${jobStatus}`,
      { status: 409, details: { purpose, jobStatus, allowed } },
    );
  }
  return true;
}

/**
 * Reject session/recovery/bypass sources for write purposes (INV-02 / INV-04).
 */
export function assertWritableAuthoritySource({ kind, source = null, purpose }) {
  assertTransportAuthKind(kind);
  if (!isWritePurpose(purpose)) return true;
  const src = source == null ? null : String(source);
  if (src && FORBIDDEN_WRITE_AUTHORITY_SOURCES.includes(src)) {
    throw new ControlPlaneError(
      "TRANSPORT_AUTH_WRITE_FORBIDDEN",
      `source ${src} cannot mint write transport authority`,
      { status: 403, details: { source: src, purpose, kind } },
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

/**
 * Issue a one-time transport action authorization (in-memory shape).
 * Persistence into transport_action_authorizations is wired by StateStore later in PR3.
 */
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

  // Caller receives plaintext nonce once; only nonceHash is durable.
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

/**
 * Consume a presented token against a stored authorization row (one-time).
 */
export function consumeTransportActionAuthorization({
  stored,
  token,
  expectedPurpose,
  expectedDeviceId,
  expectedLeaseId,
  now = Date.now,
} = {}) {
  if (!stored || typeof stored !== "object") {
    throw new ControlPlaneError("TRANSPORT_AUTH_NOT_FOUND", "authorization missing", { status: 404 });
  }
  if (!token?.nonce || !token?.authorizationId) {
    throw new ControlPlaneError("TRANSPORT_AUTH_TOKEN_INVALID", "token authorizationId+nonce required", { status: 400 });
  }
  if (stored.authorizationId !== token.authorizationId) {
    throw new ControlPlaneError("TRANSPORT_AUTH_TOKEN_MISMATCH", "authorizationId mismatch", { status: 403 });
  }
  if (stored.consumedAt) {
    throw new ControlPlaneError("TRANSPORT_AUTH_REPLAY", "authorization nonce already consumed", {
      status: 409,
      details: { authorizationId: stored.authorizationId },
    });
  }
  if (hashNonce(token.nonce) !== stored.nonceHash) {
    throw new ControlPlaneError("TRANSPORT_AUTH_NONCE_INVALID", "nonce mismatch", { status: 403 });
  }
  if (expectedPurpose && stored.purpose !== expectedPurpose) {
    throw new ControlPlaneError("TRANSPORT_AUTH_PURPOSE_MISMATCH", "purpose mismatch", {
      status: 403,
      details: { expected: expectedPurpose, actual: stored.purpose },
    });
  }
  if (expectedDeviceId && stored.deviceId !== expectedDeviceId) {
    throw new ControlPlaneError("TRANSPORT_AUTH_DEVICE_MISMATCH", "deviceId mismatch", { status: 403 });
  }
  if (expectedLeaseId && stored.leaseId !== expectedLeaseId) {
    throw new ControlPlaneError("TRANSPORT_AUTH_LEASE_MISMATCH", "leaseId mismatch", { status: 403 });
  }
  const exp = Date.parse(stored.expiresAt);
  if (Number.isFinite(exp) && now() >= exp) {
    throw new ControlPlaneError("TRANSPORT_AUTH_EXPIRED", "authorization expired", { status: 409 });
  }

  return {
    ...stored,
    consumedAt: nowIso(now),
  };
}

/** Fingerprint of authority binding fields (for tests / ledger). */
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

/**
 * Production bypass must be closed (INV-02). Lab probe may only observe.
 */
export function assertProductionBypassClosed({
  env = process.env,
  purpose = "execute",
} = {}) {
  if (env.XHS_ALLOW_BYPASS === "1" && isWritePurpose(purpose)) {
    throw new ControlPlaneError(
      "TRANSPORT_BYPASS_DISABLED_P0",
      "XHS_ALLOW_BYPASS cannot mint write transport authority in Foundation P0-B/PR3",
      { status: 403, details: { purpose, bypassEnabled: false } },
    );
  }
  return { bypassEnabled: false };
}
