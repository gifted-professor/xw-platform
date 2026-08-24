#!/usr/bin/env node

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  M64_OBSERVATION_ENVELOPE_SCHEMA_ID,
  M64_OBSERVATION_LOCATOR_SCHEMA_ID,
  canonicalM64ObservationEnvelopeSigningBytes,
  deriveM64IndependentActorHash,
  deriveM64ObservationLocatorHash,
  deriveM64ObservationRequestHash,
  deriveM64SourceEvidenceHash,
} from "../../services/control-plane/control-plane/lib/m6-live-production-dependencies.mjs";
import {
  M64_DEVICE_READ_SNAPSHOT_SCHEMA_ID,
  M64_DEVICE_READ_TICKET_SCHEMA_ID,
  M64_OBSERVATION_WORK_REQUEST_SCHEMA_ID,
  M64_SIGNED_DEVICE_READ_REQUEST_SCHEMA_ID,
  canonicalM64SignedDeviceReadRequestBytes,
  deriveM64DeviceReadSnapshotSha256,
} from "../../services/control-plane/control-plane/lib/m6-device-read-snapshot.mjs";
import {
  M64_LIVE_COUNTER_FIELDS,
  deriveM64IndependentEffectObservation,
} from "../../packages/kernel/lib/m6-live-evidence.mjs";
import {
  loadM64ResourceObserverPolicy,
  parseM64SealedDescriptorSpec,
} from "./m6-4-production-operator-bridge.mjs";
import { canonicalJson, sha256 } from "../../services/control-plane/control-plane/lib/canonical.mjs";

export { M64_DEVICE_READ_SNAPSHOT_SCHEMA_ID, M64_OBSERVATION_WORK_REQUEST_SCHEMA_ID, deriveM64DeviceReadSnapshotSha256 };

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
const SECRET_SHAPE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|api[_-]?key|access[_-]?token|refresh[_-]?token)/iu;

export class M64ObservationWorkerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "M64ObservationWorkerError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new M64ObservationWorkerError(code, message, details);
}

function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()));
}

function exactJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function plainFileBytes(path, label, { maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!isAbsolute(path || "")) fail("M64_OBSERVATION_WORKER_PATH_INVALID", `${label} must be an absolute file`);
  const target = resolve(path);
  let fd;
  try {
    const before = lstatSync(target, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maxBytes)) {
      fail("M64_OBSERVATION_WORKER_PATH_INVALID", `${label} must be one bounded single-link plain file`);
    }
    fd = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd, { bigint: true });
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== after.dev || opened.ino !== after.ino
      || opened.size !== after.size || after.size !== BigInt(bytes.length)) {
      fail("M64_OBSERVATION_WORKER_PATH_RACE", `${label} changed while it was read`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof M64ObservationWorkerError) throw error;
    fail("M64_OBSERVATION_WORKER_PATH_INVALID", `${label} is unavailable`, { cause: error?.code ?? null });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function atomicCreateExact(path, value) {
  const target = resolve(path);
  const bytes = exactJsonBytes(value);
  if (SECRET_SHAPE.test(bytes.toString("utf8"))) fail("M64_OBSERVATION_WORKER_SECRET_MATERIAL", "published observation contains secret-shaped material");
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) {
    const existing = plainFileBytes(target, "existing observation artifact");
    if (!existing.equals(bytes)) fail("M64_OBSERVATION_WORKER_PUBLICATION_CONFLICT", "content-addressed output already has different bytes");
    return Object.freeze({ path: realpathSync.native(target), sha256: sha256(existing), status: "EXACT_EXISTS" });
  }
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch {}
    if (existsSync(target)) return atomicCreateExact(target, value);
    fail("M64_OBSERVATION_WORKER_PUBLICATION_FAILED", "observation artifact could not be atomically published", { cause: error?.code ?? null });
  }
  const readback = plainFileBytes(target, "published observation artifact");
  if (!readback.equals(bytes)) fail("M64_OBSERVATION_WORKER_PUBLICATION_FAILED", "published observation failed exact readback");
  return Object.freeze({ path: realpathSync.native(target), sha256: sha256(readback), status: "CREATED" });
}

function requestAuthority(request) {
  return Object.freeze({
    purpose: request.purpose,
    manifestHash: request.manifestHash,
    scenarioKey: request.scenarioKey,
    primaryFamily: request.primaryFamily,
    oracleHash: request.oracleHash,
    effectBoundaryHash: request.effectBoundaryHash,
    environmentAttestationHash: request.environmentAttestationHash,
    accountIsolationHash: request.accountIsolationHash,
    expectedArtifactHash: request.expectedArtifactHash,
    independentAuthorHash: request.independentAuthorHash,
    phase: request.phase,
  });
}

export function validateM64ObservationWorkRequest(request) {
  if (!exactObject(request, REQUEST_KEYS) || request.schemaId !== M64_OBSERVATION_WORK_REQUEST_SCHEMA_ID
    || !PHASES.has(request.phase) || typeof request.purpose !== "string" || typeof request.primaryFamily !== "string"
    || typeof request.scenarioKey !== "string" || request.scenarioKey.length === 0
    || ![request.manifestHash, request.oracleHash, request.effectBoundaryHash, request.environmentAttestationHash,
      request.accountIsolationHash, request.expectedArtifactHash, request.expectedStateHash, request.independentAuthorHash,
      request.requestHash].every((item) => HASH.test(item || ""))
    || request.requestHash !== deriveM64ObservationRequestHash(requestAuthority(request))) {
    fail("M64_OBSERVATION_WORK_REQUEST_INVALID", "observation work request is malformed or rebound");
  }
  return Object.freeze({ ...request });
}

export function validateM64DeviceReadSnapshot(snapshot, { request, policy, nowMs = Date.now() } = {}) {
  if (!exactObject(snapshot, SNAPSHOT_KEYS) || snapshot.schemaId !== M64_DEVICE_READ_SNAPSHOT_SCHEMA_ID
    || snapshot.sourceKind !== "DEVICE_READ_SNAPSHOT" || snapshot.requestHash !== request?.requestHash
    || !HASH.test(snapshot.snapshotSha256 || "") || snapshot.snapshotSha256 !== deriveM64DeviceReadSnapshotSha256(snapshot)
    || ![snapshot.actualStateHash, snapshot.captureEvidenceSha256, snapshot.frameRef, snapshot.gateEpochHash]
      .every((item) => HASH.test(item || ""))
    || snapshot.actualStateHash !== request?.expectedStateHash
    || !Number.isSafeInteger(snapshot.actionCount) || snapshot.actionCount !== 0
    || !Number.isSafeInteger(snapshot.transportCount) || snapshot.transportCount !== 0
    || !Array.isArray(snapshot.observedEffects) || snapshot.observedEffects.length !== 0
    || !snapshot.resetResults || typeof snapshot.resetResults !== "object" || Array.isArray(snapshot.resetResults)
    || Object.values(snapshot.resetResults).some((item) => item !== true)
    || !exactObject(snapshot.counters, M64_LIVE_COUNTER_FIELDS)
    || M64_LIVE_COUNTER_FIELDS.some((field) => snapshot.counters[field] !== 0)) {
    fail("M64_DEVICE_READ_SNAPSHOT_INVALID", "Control Plane device-read snapshot is malformed, active, or rebound");
  }
  const observedAtMs = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(observedAtMs) || observedAtMs > nowMs + 5_000
    || nowMs - observedAtMs > policy.maxObservationAgeMs) {
    fail("M64_DEVICE_READ_SNAPSHOT_STALE", "Control Plane device-read snapshot is outside the frozen freshness window");
  }
  if (canonicalJson(policy.allowedSourceKinds) !== canonicalJson(["DEVICE_READ_SNAPSHOT"])
    || canonicalJson(policy.requiredSourceKinds) !== canonicalJson(["DEVICE_READ_SNAPSHOT"])) {
    fail("M64_DEVICE_READ_SNAPSHOT_POLICY_INVALID", "frozen oracle policy is not DEVICE_READ_SNAPSHOT-only");
  }
  return Object.freeze({ ...snapshot, counters: Object.freeze({ ...snapshot.counters }) });
}

export function loadM64ObservationSigner(privateKeyPath, observerPolicy) {
  const bytes = plainFileBytes(privateKeyPath, "observation observer private key", { maxBytes: 64 * 1024 });
  let privateKey;
  try { privateKey = createPrivateKey(bytes); } catch {
    fail("M64_OBSERVATION_SIGNER_INVALID", "observation observer private key is not parseable");
  } finally { bytes.fill(0); }
  if (privateKey.asymmetricKeyType !== "ed25519") fail("M64_OBSERVATION_SIGNER_INVALID", "observation observer private key must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  if (deriveM64IndependentActorHash(publicKey) !== observerPolicy.observerHash
    || publicKey.export({ type: "spki", format: "der" }).compare(observerPolicy.publicKey.export({ type: "spki", format: "der" })) !== 0) {
    fail("M64_OBSERVATION_SIGNER_REBOUND", "private key does not match the frozen observation observer identity");
  }
  return privateKey;
}

export function publishM64IndependentObservation({ request, snapshot, observerPolicy, privateKey, nowMs = Date.now() } = {}) {
  const boundRequest = validateM64ObservationWorkRequest(request);
  const source = validateM64DeviceReadSnapshot(snapshot, { request: boundRequest, policy: observerPolicy.policy, nowMs });
  const sourceEvidence = Object.freeze([{ kind: "DEVICE_READ_SNAPSHOT", sha256: source.snapshotSha256 }]);
  const observation = deriveM64IndependentEffectObservation({
    schemaId: "xw.m6-4-independent-effect-observation.v1",
    phase: boundRequest.phase,
    sourceClass: "INDEPENDENT_POST_DISPATCH",
    selfDerived: false,
    scenarioKey: boundRequest.scenarioKey,
    primaryFamily: boundRequest.primaryFamily,
    oracleHash: boundRequest.oracleHash,
    effectBoundaryHash: boundRequest.effectBoundaryHash,
    environmentAttestationHash: boundRequest.environmentAttestationHash,
    accountIsolationHash: boundRequest.accountIsolationHash,
    expectedArtifactHash: boundRequest.expectedArtifactHash,
    independentObserverHash: observerPolicy.observerHash,
    actualStateHash: source.actualStateHash,
    sourceEvidenceHash: deriveM64SourceEvidenceHash(sourceEvidence),
    observedEffects: source.observedEffects,
    resetResults: source.resetResults,
    counters: source.counters,
    observedAt: source.observedAt,
  });
  const unsigned = Object.freeze({
    schemaId: M64_OBSERVATION_ENVELOPE_SCHEMA_ID,
    observerKeyId: observerPolicy.keyId,
    signatureAlgorithm: "Ed25519",
    requestHash: boundRequest.requestHash,
    sourceEvidence,
    observation,
  });
  const envelope = Object.freeze({
    ...unsigned,
    signature: sign(null, canonicalM64ObservationEnvelopeSigningBytes(unsigned), privateKey).toString("base64"),
  });
  const envelopeBytes = exactJsonBytes(envelope);
  const envelopeSha256 = sha256(envelopeBytes);
  const envelopeArtifact = atomicCreateExact(join(observerPolicy.observationsRoot, `${envelopeSha256}.json`), envelope);
  const locatorRaw = Object.freeze({
    schemaId: M64_OBSERVATION_LOCATOR_SCHEMA_ID,
    requestHash: boundRequest.requestHash,
    envelopeSha256,
  });
  const locator = Object.freeze({ ...locatorRaw, locatorHash: deriveM64ObservationLocatorHash(locatorRaw) });
  const locatorArtifact = atomicCreateExact(join(observerPolicy.requestsRoot, `${boundRequest.requestHash}.json`), locator);
  return Object.freeze({
    ok: true,
    requestHash: boundRequest.requestHash,
    phase: boundRequest.phase,
    observationHash: observation.observationHash,
    envelopeSha256,
    envelopePath: envelopeArtifact.path,
    locatorPath: locatorArtifact.path,
    actionCount: 0,
    transportCount: 0,
  });
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function validateTicket(ticket) {
  if (!exactObject(ticket, ["expiresAt", "gateEpochHash", "nonce", "request", "requestedAt", "schemaId", "ticketHash"])
    || ticket.schemaId !== M64_DEVICE_READ_TICKET_SCHEMA_ID || !HASH.test(ticket.ticketHash || "")
    || !HASH.test(ticket.gateEpochHash || "") || typeof ticket.nonce !== "string"
    || !Number.isFinite(Date.parse(ticket.requestedAt || "")) || !Number.isFinite(Date.parse(ticket.expiresAt || ""))) {
    fail("M64_DEVICE_READ_TICKET_INVALID", "device-read work ticket is malformed");
  }
  const request = validateM64ObservationWorkRequest(ticket.request);
  const { ticketHash, ...raw } = ticket;
  if (ticketHash !== sha256(`${M64_DEVICE_READ_TICKET_SCHEMA_ID}:${canonicalJson(raw)}`)) {
    fail("M64_DEVICE_READ_TICKET_INVALID", "device-read work ticket hash is invalid");
  }
  return Object.freeze({ ...ticket, request });
}

export async function requestM64DeviceReadSnapshot(ticket, observerPolicy, privateKey, controlPlaneUrl, fetchImpl = globalThis.fetch) {
  const origin = new URL(controlPlaneUrl);
  if (!/^https?:$/u.test(origin.protocol) || origin.username || origin.password || origin.pathname !== "/"
    || origin.search || origin.hash || typeof fetchImpl !== "function") {
    fail("M64_OBSERVATION_CONTROL_PLANE_INVALID", "Control Plane URL must be one credential-free HTTP(S) origin");
  }
  const unsigned = Object.freeze({
    schemaId: M64_SIGNED_DEVICE_READ_REQUEST_SCHEMA_ID,
    observerKeyId: observerPolicy.keyId,
    signatureAlgorithm: "Ed25519",
    requestHash: ticket.request.requestHash,
    ticketHash: ticket.ticketHash,
  });
  const signed = Object.freeze({
    ...unsigned,
    signature: sign(null, canonicalM64SignedDeviceReadRequestBytes(unsigned), privateKey).toString("base64"),
  });
  const response = await fetchImpl(new URL("/control/v1/m6/device-read-snapshot", origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(signed),
  });
  if (!response?.ok) fail("M64_DEVICE_READ_SNAPSHOT_UNAVAILABLE", "Control Plane refused the pending signed device-read request", { status: response?.status ?? null });
  let value;
  try { value = await response.json(); } catch { fail("M64_DEVICE_READ_SNAPSHOT_INVALID", "Control Plane snapshot response is not JSON"); }
  return value?.snapshot;
}

export async function main(argv = process.argv.slice(2), { fetchImpl = globalThis.fetch } = {}) {
  const mode = option(argv, "--mode") || "dry-run";
  const policyDescriptor = parseM64SealedDescriptorSpec(option(argv, "--policy"), "independent oracle policy");
  const observerPolicy = loadM64ResourceObserverPolicy(policyDescriptor, {
    releaseRoot: option(argv, "--release-root") || "C:\\Users\\Public\\xw-runtime\\current",
  });
  const privateKey = loadM64ObservationSigner(option(argv, "--observer-key-file"), observerPolicy);
  if (mode === "dry-run") {
    return Object.freeze({
      ok: true,
      status: "DRY_RUN_READY",
      policyHash: observerPolicy.policyHash,
      observerHash: observerPolicy.observerHash,
      sourceKinds: Object.freeze(["DEVICE_READ_SNAPSHOT"]),
      publicationPerformed: false,
      deviceAccessed: false,
      gateMutationPerformed: false,
      providerDispatchPerformed: false,
      actionCount: 0,
      transportCount: 0,
    });
  }
  if (mode !== "once") fail("M64_OBSERVATION_WORKER_MODE_INVALID", "mode must be dry-run or once");
  const ticket = validateTicket(JSON.parse(plainFileBytes(option(argv, "--ticket"), "device-read work ticket").toString("utf8")));
  const snapshot = await requestM64DeviceReadSnapshot(
    ticket,
    observerPolicy,
    privateKey,
    option(argv, "--control-plane-url") || "http://127.0.0.1:17920/",
    fetchImpl,
  );
  return publishM64IndependentObservation({ request: ticket.request, snapshot, observerPolicy, privateKey });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      code: /^[A-Z0-9_]{3,96}$/u.test(error?.code || "") ? error.code : "M64_OBSERVATION_WORKER_FAILED_CLOSED",
      actionCount: 0,
      transportCount: 0,
    })}\n`);
    process.exitCode = 1;
  });
}
