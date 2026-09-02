import { M64_LIVE_COUNTER_FIELDS, M64_LIVE_CRITICAL_ZERO_COUNTER_FIELDS } from "../../../../packages/kernel/lib/m6-live-evidence.mjs";
import { randomUUID, verify as verifySignature } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { canonicalJson, sha256 } from "./canonical.mjs";
import { deriveM64ObservationRequestHash } from "./m6-live-production-dependencies.mjs";
import { ControlPlaneError } from "./errors.mjs";

export const M64_OBSERVATION_WORK_REQUEST_SCHEMA_ID = "xw.m6-4-independent-observation-work-request.v1";
export const M64_DEVICE_READ_SNAPSHOT_SCHEMA_ID = "xw.m6-4-control-plane-device-read-snapshot.v1";
export const M64_DEVICE_READ_TICKET_SCHEMA_ID = "xw.m6-4-device-read-work-ticket.v1";
export const M64_SIGNED_DEVICE_READ_REQUEST_SCHEMA_ID = "xw.m6-4-signed-device-read-request.v1";

const HASH = /^[0-9a-f]{64}$/u;
const PHASES = new Set(["before", "after", "final"]);
const REQUEST_KEYS = Object.freeze([
  "accountIsolationHash", "effectBoundaryHash", "environmentAttestationHash", "expectedArtifactHash",
  "expectedStateHash", "independentAuthorHash", "manifestHash", "oracleHash", "phase", "primaryFamily",
  "purpose", "requestHash", "scenarioKey", "schemaId",
]);
const SNAPSHOT_KEYS = Object.freeze([
  "actionCount", "actualStateHash", "captureEvidenceSha256", "counters", "frameRef", "gateEpochHash",
  "observedAt", "observedEffects", "requestHash", "resetResults", "schemaId", "snapshotSha256",
  "sourceKind", "transportCount",
]);

function fail(code, message, status = 409) {
  throw new ControlPlaneError(code, message, { status });
}

function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()));
}

export function m64ObservationRequestAuthority(request) {
  return Object.freeze({
    purpose: request?.purpose,
    manifestHash: request?.manifestHash,
    scenarioKey: request?.scenarioKey,
    primaryFamily: request?.primaryFamily,
    oracleHash: request?.oracleHash,
    effectBoundaryHash: request?.effectBoundaryHash,
    environmentAttestationHash: request?.environmentAttestationHash,
    accountIsolationHash: request?.accountIsolationHash,
    expectedArtifactHash: request?.expectedArtifactHash,
    independentAuthorHash: request?.independentAuthorHash,
    phase: request?.phase,
  });
}

export function createM64ObservationWorkRequest({ authority, expectation, phase } = {}) {
  const requestAuthority = Object.freeze({
    purpose: authority?.purpose,
    manifestHash: authority?.manifestHash,
    scenarioKey: authority?.scenarioKey,
    primaryFamily: authority?.primaryFamily,
    oracleHash: authority?.oracleHash,
    effectBoundaryHash: authority?.effectBoundaryHash,
    environmentAttestationHash: authority?.environmentAttestationHash,
    accountIsolationHash: authority?.accountIsolationHash,
    expectedArtifactHash: expectation?.expectedArtifactHash,
    independentAuthorHash: expectation?.independentAuthorHash,
    phase,
  });
  return validateM64ObservationWorkRequest({
    schemaId: M64_OBSERVATION_WORK_REQUEST_SCHEMA_ID,
    ...requestAuthority,
    expectedStateHash: expectation?.expectedStateHash,
    requestHash: deriveM64ObservationRequestHash(requestAuthority),
  });
}

export function validateM64ObservationWorkRequest(request) {
  if (!exactObject(request, REQUEST_KEYS) || request.schemaId !== M64_OBSERVATION_WORK_REQUEST_SCHEMA_ID
    || !PHASES.has(request.phase) || !/^[A-Z][A-Z0-9_]{2,96}$/u.test(request.purpose || "")
    || typeof request.primaryFamily !== "string" || request.primaryFamily.length === 0
    || typeof request.scenarioKey !== "string" || request.scenarioKey.length === 0
    || ![request.manifestHash, request.oracleHash, request.effectBoundaryHash, request.environmentAttestationHash,
      request.accountIsolationHash, request.expectedArtifactHash, request.expectedStateHash, request.independentAuthorHash,
      request.requestHash].every((item) => HASH.test(item || ""))
    || request.requestHash !== deriveM64ObservationRequestHash(m64ObservationRequestAuthority(request))) {
    fail("M64_OBSERVATION_WORK_REQUEST_INVALID", "observation work request is malformed or rebound", 400);
  }
  return Object.freeze({ ...request });
}

export function deriveM64ObservedStateHash({ request, observedEffects, resetObligations } = {}) {
  return sha256(`xw.m6-4-independent-expected-state-model.v1:${canonicalJson({
    accountIsolationHash: request?.accountIsolationHash,
    scenarioKey: request?.scenarioKey,
    primaryFamily: request?.primaryFamily,
    oracleHash: request?.oracleHash,
    effectBoundaryHash: request?.effectBoundaryHash,
    expectedObservedEffects: observedEffects,
    requiredResetObligations: resetObligations,
    criticalZeroCounters: M64_LIVE_CRITICAL_ZERO_COUNTER_FIELDS,
  })}`);
}

export function deriveM64DeviceReadSnapshotSha256(snapshot) {
  const { snapshotSha256: _ignored, ...raw } = snapshot || {};
  return sha256(`${M64_DEVICE_READ_SNAPSHOT_SCHEMA_ID}:${canonicalJson(raw)}`);
}

export function deriveM64DeviceReadSnapshot({ request, captureReceipt, gateEpochHash, resetObligations } = {}) {
  const bound = validateM64ObservationWorkRequest(request);
  if (!captureReceipt || !HASH.test(captureReceipt.evidenceSha256 || "")
    || !HASH.test(captureReceipt.frameRef || "") || !HASH.test(gateEpochHash || "")
    || captureReceipt.gateEpochHash !== gateEpochHash || !Number.isFinite(Date.parse(captureReceipt.capturedAt || ""))
    || !Array.isArray(resetObligations) || new Set(resetObligations).size !== resetObligations.length
    || resetObligations.some((item) => typeof item !== "string" || item.length === 0)) {
    fail("M64_DEVICE_READ_CAPTURE_RECEIPT_INVALID", "device snapshot requires one accepted Gate-bound read capture receipt");
  }
  const counters = Object.freeze(Object.fromEntries(M64_LIVE_COUNTER_FIELDS.map((field) => [field, 0])));
  const observedEffects = Object.freeze([]);
  const resetResults = Object.freeze(Object.fromEntries(resetObligations.map((item) => [item, true])));
  const raw = Object.freeze({
    schemaId: M64_DEVICE_READ_SNAPSHOT_SCHEMA_ID,
    sourceKind: "DEVICE_READ_SNAPSHOT",
    requestHash: bound.requestHash,
    gateEpochHash,
    captureEvidenceSha256: captureReceipt.evidenceSha256,
    frameRef: captureReceipt.frameRef,
    observedAt: captureReceipt.capturedAt,
    actualStateHash: deriveM64ObservedStateHash({ request: bound, observedEffects, resetObligations }),
    observedEffects,
    resetResults,
    counters,
    actionCount: 0,
    transportCount: 0,
  });
  if (raw.actualStateHash !== bound.expectedStateHash) {
    fail("M64_DEVICE_READ_EXPECTED_STATE_MISMATCH", "device snapshot semantics do not match the signed pre-window expectation");
  }
  return Object.freeze({ ...raw, snapshotSha256: deriveM64DeviceReadSnapshotSha256(raw) });
}

export function validateM64DeviceReadSnapshot(snapshot, { request, maxAgeMs, nowMs = Date.now() } = {}) {
  if (!exactObject(snapshot, SNAPSHOT_KEYS) || snapshot.schemaId !== M64_DEVICE_READ_SNAPSHOT_SCHEMA_ID
    || snapshot.sourceKind !== "DEVICE_READ_SNAPSHOT" || snapshot.requestHash !== request?.requestHash
    || ![snapshot.snapshotSha256, snapshot.actualStateHash, snapshot.captureEvidenceSha256,
      snapshot.frameRef, snapshot.gateEpochHash].every((item) => HASH.test(item || ""))
    || snapshot.snapshotSha256 !== deriveM64DeviceReadSnapshotSha256(snapshot)
    || snapshot.actualStateHash !== request?.expectedStateHash
    || snapshot.actionCount !== 0 || snapshot.transportCount !== 0
    || !Array.isArray(snapshot.observedEffects) || snapshot.observedEffects.length !== 0
    || !snapshot.resetResults || typeof snapshot.resetResults !== "object" || Array.isArray(snapshot.resetResults)
    || Object.values(snapshot.resetResults).some((item) => item !== true)
    || !exactObject(snapshot.counters, M64_LIVE_COUNTER_FIELDS)
    || M64_LIVE_COUNTER_FIELDS.some((field) => snapshot.counters[field] !== 0)) {
    fail("M64_DEVICE_READ_SNAPSHOT_INVALID", "Control Plane device-read snapshot is malformed, active, or rebound");
  }
  const observedAt = Date.parse(snapshot.observedAt);
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 60_000
    || !Number.isFinite(observedAt) || observedAt > nowMs + 5_000 || nowMs - observedAt > maxAgeMs) {
    fail("M64_DEVICE_READ_SNAPSHOT_STALE", "Control Plane device-read snapshot is outside the frozen freshness window");
  }
  return Object.freeze(snapshot);
}

function ticketHash(value) {
  const { ticketHash: _ignored, ...raw } = value || {};
  return sha256(`${M64_DEVICE_READ_TICKET_SCHEMA_ID}:${canonicalJson(raw)}`);
}

export function canonicalM64SignedDeviceReadRequestBytes(value) {
  const { signature: _ignored, ...raw } = value || {};
  return Buffer.from(`${M64_SIGNED_DEVICE_READ_REQUEST_SCHEMA_ID}:${canonicalJson(raw)}`, "utf8");
}

function exactJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createExact(path, value) {
  const target = resolve(path);
  const bytes = exactJsonBytes(value);
  mkdirSync(resolve(target, ".."), { recursive: true });
  if (existsSync(target)) {
    const stat = lstatSync(target, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || !readFileSync(target).equals(bytes)) {
      fail("M64_DEVICE_READ_WORK_CONFLICT", "work request already exists with different bytes or path identity");
    }
    return target;
  }
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch {}
    if (existsSync(target) && readFileSync(target).equals(bytes)) return target;
    fail("M64_DEVICE_READ_WORK_PUBLICATION_FAILED", "work request could not be published", 503);
  }
  const published = lstatSync(target, { bigint: true });
  if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1n || !readFileSync(target).equals(bytes)) {
    fail("M64_DEVICE_READ_WORK_PUBLICATION_FAILED", "work request failed plain-file exact readback", 503);
  }
  return target;
}

export function createM64DeviceReadSnapshotSurface({
  workRoot,
  observerKeyId,
  observerPublicKey,
  maxAgeMs = 30_000,
  now = Date.now,
} = {}) {
  if (typeof workRoot !== "string" || !resolve(workRoot) || typeof observerKeyId !== "string"
    || !observerPublicKey || typeof now !== "function") {
    fail("M64_DEVICE_READ_SURFACE_INVALID", "device-read surface dependencies are incomplete", 503);
  }
  const pending = new Map();
  const root = resolve(workRoot);
  mkdirSync(root, { recursive: true });
  const rootStat = lstatSync(root);
  // Windows may expand an 8.3 component (for example WINDOW~1) during realpath.
  // Resolve it to prove reachability, but reject reparse/symlink identity on the
  // work root itself instead of comparing two equivalent lexical spellings.
  realpathSync.native(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail("M64_DEVICE_READ_WORK_ROOT_INVALID", "device-read work root must be one plain resolved directory", 503);
  }

  function loadTicket(path) {
    let ticket;
    try { ticket = JSON.parse(readFileSync(path, "utf8")); } catch {
      fail("M64_DEVICE_READ_TICKET_INVALID", "persisted device-read ticket is malformed");
    }
    if (!exactObject(ticket, ["expiresAt", "gateEpochHash", "nonce", "request", "requestedAt", "schemaId", "ticketHash"])
      || ticket.schemaId !== M64_DEVICE_READ_TICKET_SCHEMA_ID || ticket.ticketHash !== ticketHash(ticket)
      || !HASH.test(ticket.gateEpochHash || "")) {
      fail("M64_DEVICE_READ_TICKET_INVALID", "persisted device-read ticket is forged or rebound");
    }
    validateM64ObservationWorkRequest(ticket.request);
    return Object.freeze(ticket);
  }

  function register({ authority, expectation, phase, gateEpochHash, resetObligations, capture }) {
    const bound = createM64ObservationWorkRequest({ authority, expectation, phase });
    if (!HASH.test(gateEpochHash || "") || typeof capture !== "function" || pending.has(bound.requestHash)) {
      fail("M64_DEVICE_READ_PENDING_INVALID", "device-read pending request is duplicated or lacks active authority");
    }
    const ticketPath = join(root, `${bound.requestHash}.work-request.json`);
    const consumedPath = join(root, `${bound.requestHash}.consumed.json`);
    const completePath = join(root, `${bound.requestHash}.complete.json`);
    if (existsSync(consumedPath) || existsSync(completePath)) {
      fail("M64_DEVICE_READ_WORK_TERMINAL", "device-read work request is already consumed or complete");
    }
    let ticket;
    if (existsSync(ticketPath)) {
      ticket = loadTicket(ticketPath);
      if (canonicalJson(ticket.request) !== canonicalJson(bound) || ticket.gateEpochHash !== gateEpochHash
        || Date.parse(ticket.expiresAt) <= Number(now())) {
        fail("M64_DEVICE_READ_WORK_TERMINAL", "persisted device-read work request cannot be rebound or renewed");
      }
    } else {
      const requestedAtMs = Number(now());
      const raw = {
        schemaId: M64_DEVICE_READ_TICKET_SCHEMA_ID,
        request: bound,
        gateEpochHash,
        requestedAt: new Date(requestedAtMs).toISOString(),
        expiresAt: new Date(requestedAtMs + Math.min(maxAgeMs, 5_000)).toISOString(),
        nonce: randomUUID(),
      };
      ticket = Object.freeze({ ...raw, ticketHash: ticketHash(raw) });
      createExact(ticketPath, ticket);
    }
    pending.set(bound.requestHash, {
      ticket,
      status: "PENDING",
      capture: async () => deriveM64DeviceReadSnapshot({
        request: bound,
        gateEpochHash,
        resetObligations,
        captureReceipt: await capture(),
      }),
    });
    return ticket;
  }

  async function consume(signed) {
    if (!exactObject(signed, ["observerKeyId", "requestHash", "schemaId", "signature", "signatureAlgorithm", "ticketHash"])
      || signed.schemaId !== M64_SIGNED_DEVICE_READ_REQUEST_SCHEMA_ID
      || signed.observerKeyId !== observerKeyId || signed.signatureAlgorithm !== "Ed25519"
      || !HASH.test(signed.requestHash || "") || !HASH.test(signed.ticketHash || "")
      || typeof signed.signature !== "string") {
      fail("M64_SIGNED_DEVICE_READ_REQUEST_INVALID", "signed device-read request is malformed", 400);
    }
    const entry = pending.get(signed.requestHash);
    if (!entry || entry.status !== "PENDING" || entry.ticket.ticketHash !== signed.ticketHash) {
      fail("M64_DEVICE_READ_REQUEST_NOT_PENDING", "device-read request is not the current pending oracle phase");
    }
    const nowMs = Number(now());
    if (Date.parse(entry.ticket.requestedAt) > nowMs + 5_000 || Date.parse(entry.ticket.expiresAt) <= nowMs
      || existsSync(join(root, `${signed.requestHash}.consumed.json`))) {
      fail("M64_DEVICE_READ_REQUEST_STALE_OR_REPLAY", "device-read request is stale or replayed");
    }
    let valid = false;
    try {
      const bytes = Buffer.from(signed.signature, "base64");
      valid = bytes.length === 64 && bytes.toString("base64") === signed.signature
        && verifySignature(null, canonicalM64SignedDeviceReadRequestBytes(signed), observerPublicKey, bytes);
    } catch {}
    if (!valid) fail("M64_SIGNED_DEVICE_READ_REQUEST_SIGNATURE_INVALID", "device-read request signature is invalid", 403);
    entry.status = "CONSUMED";
    createExact(join(root, `${signed.requestHash}.consumed.json`), {
      schemaId: "xw.m6-4-device-read-consumption.v1",
      requestHash: signed.requestHash,
      ticketHash: signed.ticketHash,
      consumedAt: new Date(nowMs).toISOString(),
    });
    return entry.capture(entry.ticket);
  }

  function complete(requestHash) {
    const entry = pending.get(requestHash);
    if (entry) {
      entry.status = "COMPLETE";
      createExact(join(root, `${requestHash}.complete.json`), {
        schemaId: "xw.m6-4-device-read-completion.v1",
        requestHash,
        ticketHash: entry.ticket.ticketHash,
        completedAt: new Date(Number(now())).toISOString(),
      });
      pending.delete(requestHash);
    }
  }

  return Object.freeze({ register, consume, complete, root });
}
