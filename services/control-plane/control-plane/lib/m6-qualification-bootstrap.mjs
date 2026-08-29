// M6-4 production qualification bootstrap.
//
// This module installs an externally signed, release-specific v1 gate chain
// whose OBSERVE_ONLY root was never independently activated and whose only
// published pointer is a generation-0 CLOSED tail.  It does not mint epochs,
// sign bytes, load private keys, contact a provider, or touch a device.
import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import {
  deriveM6AggregateSealHash,
  deriveM6ResourceSnapshotSha256,
} from "../../../../packages/kernel/lib/m6-aggregate-closeout.mjs";
import { canonicalJson, sha256 } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";
import { validateJsonSchema } from "./json-schema-validator.mjs";
import {
  loadEpochSchema,
  loadM6Gate,
  writeImmutableJson,
} from "./m6-gate-loader.mjs";
import { assertM6FileDbPointerConsistency } from "./m6-gate-promoter.mjs";
import {
  normalizeGateIssuerAllowlist,
  verifyEpochProof,
} from "./m6-issuer-allowlist.mjs";
import {
  deriveM6CloseoutHash,
  deriveM6EpochHash,
  evaluateM6Gate,
} from "./m6-live-gate.mjs";
import { CURRENT_CONTROL_SCHEMA_VERSION, StateStore } from "./state-store.mjs";

export const M6_QUALIFICATION_BOOTSTRAP_PACKAGE_SCHEMA_ID = "xw.m6-c1-qualification-bootstrap-package.v1";
export const M6_QUALIFICATION_BOOTSTRAP_SCENARIO_SCHEMA_ID = "xw.m6-c1-qualification-bootstrap-scenario-manifest.v1";
export const M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_SCHEMA_ID = "xw.m6-c1-qualification-bootstrap-db-snapshot-receipt.v1";

const HEX40 = /^[0-9a-f]{40}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const GATE_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const EPOCH_KEYS = Object.freeze([
  "actor", "aggregateSealRef", "allowlist", "closeoutRef", "epochHash", "expiresAt",
  "gateId", "issuedAt", "lockHashes", "mode", "parentEpochHash", "proof", "releaseId",
  "rollbackTargetEpochHash", "schemaId", "sourceCommit", "status",
]);
const PROOF_KEYS = Object.freeze(["algorithm", "allowlistVersion", "keyId", "signature", "subject"]);
const LOCK_KINDS = Object.freeze(["groundingRuntime", "hardRedlinePolicy", "runtimeProfile"]);
const ZERO_POINT_KEYS = Object.freeze(["activeActions", "activeJobs", "activeLeases", "activeRuns", "activeSessions"]);
const PACKAGE_KEYS = Object.freeze([
  "aggregate", "closedEpochRecord", "closeout", "gateId", "issuerAllowlistSha256",
  "locksRecord", "packageHash", "promotedAt", "releaseId", "resourceSnapshot",
  "rootEpochRecord", "scenarioManifest", "schemaId", "sourceCommit",
]);
const SNAPSHOT_RECEIPT_KEYS = Object.freeze([
  "gateId", "integrityCheck", "legacyState", "method", "packageHash", "receiptHash",
  "releaseId", "schemaId", "snapshotPath", "snapshotSha256", "snapshotSizeBytes",
  "snapshotUserVersion", "snapshottedAt", "sourceDbPath", "sourceDbSha256", "sourceLogicalStateHash",
  "sourceUserVersion", "sourceCommit",
]);
const QUALIFICATION_BINDING_KEYS = Object.freeze([
  "gateFArtifactInventoryHash", "gateFArtifactInventoryPath", "gateId", "gateIssuerAllowlistPath",
  "releaseId", "releaseManifestSha256", "schemaId", "sourceCommit", "sourceReleaseRoot",
]);
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_DB_BYTES = 4 * 1024 * 1024 * 1024;
const CLEANUP_VERIFIED_ERRORS = new WeakSet();
const CLEANUP_UNPROVEN_ERRORS = new WeakSet();

export function isM6QualificationCleanupVerifiedError(error) {
  return error instanceof Error && CLEANUP_VERIFIED_ERRORS.has(error);
}

function boundedErrorCode(error) {
  const value = error?.code ?? error?.name ?? "UNKNOWN";
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(value)
    ? value
    : "UNKNOWN";
}

function cleanupUnprovenError(primaryError, cleanupError = null) {
  const error = new ControlPlaneError(
    "M6_QUALIFICATION_BOOTSTRAP_CLEANUP_UNPROVEN",
    "qualification bootstrap cleanup could not be proven; the runtime owner lock must be retained",
    {
      status: 503,
      details: {
        primaryErrorCode: boundedErrorCode(primaryError),
        cleanupErrorCode: cleanupError ? boundedErrorCode(cleanupError) : "CLEANUP_AUTHORITY_UNAVAILABLE",
      },
      cause: cleanupError ?? primaryError,
    },
  );
  CLEANUP_UNPROVEN_ERRORS.add(error);
  return error;
}

function cleanupVerifiedError(error) {
  const normalized = error instanceof Error
    ? error
    : new ControlPlaneError(
      "M6_QUALIFICATION_BOOTSTRAP_FAILED",
      "qualification bootstrap failed after verified cleanup",
      { status: 503, cause: error },
    );
  CLEANUP_VERIFIED_ERRORS.add(normalized);
  return normalized;
}

function fail(code, message, details = {}) {
  throw new ControlPlaneError(code, message, { status: 409, details });
}

function exactObject(value, keys, code, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    fail(code, `${label} must contain only its exact frozen fields`);
  }
  return value;
}

function without(value, key) {
  const { [key]: _ignored, ...rest } = value || {};
  return rest;
}

function within(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sameFilesystemIdentity(left, right) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && String(left.mode) === String(right.mode)
    && String(left.nlink) === String(right.nlink)
    && String(left.size) === String(right.size)
    && String(left.mtimeNs ?? left.mtimeMs) === String(right.mtimeNs ?? right.mtimeMs);
}

function assertAbsolutePath(value, code, label) {
  if (typeof value !== "string" || value.length < 3 || value.length > 32_767 || value.includes("\0") || !isAbsolute(value)) {
    fail(code, `${label} must be a bounded absolute path`);
  }
  return resolve(value);
}

function assertPlainAncestors(filePath, code, label, { allowMissing = false } = {}) {
  const target = assertAbsolutePath(filePath, code, label);
  const volumeRoot = parse(target).root;
  let cursor = dirname(target);
  while (cursor && cursor !== volumeRoot) {
    if (!existsSync(cursor)) {
      if (!allowMissing) fail(code, `${label} parent directory is unavailable`);
      const next = dirname(cursor);
      if (next === cursor) break;
      cursor = next;
      continue;
    }
    let stat;
    try { stat = lstatSync(cursor, { bigint: true }); } catch { fail(code, `${label} parent directory is unavailable`); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail(code, `${label} must not traverse a symlink, junction, reparse point, or non-directory parent`);
    }
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  return target;
}

export function deriveM6QualificationBootstrapPackageHash(value) {
  return sha256(`${M6_QUALIFICATION_BOOTSTRAP_PACKAGE_SCHEMA_ID}:${canonicalJson(without(value, "packageHash"))}`);
}

export function deriveM6QualificationBootstrapScenarioManifestHash(value) {
  return sha256(`${M6_QUALIFICATION_BOOTSTRAP_SCENARIO_SCHEMA_ID}:${canonicalJson(without(value, "manifestSha256"))}`);
}

export function deriveM6QualificationBootstrapDbSnapshotReceiptHash(value) {
  return sha256(`${M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_SCHEMA_ID}:${canonicalJson(without(value, "receiptHash"))}`);
}

// Pure handoff for the later production assembler.  Keeping this here makes
// the qualification runtime's exact nine-field contract explicit without
// letting bootstrap invent the release manifest or final Gate-F inventory.
export function buildM6QualificationBootstrapBinding({
  package: input,
  sourceReleaseRoot,
  releaseManifestSha256,
  gateIssuerAllowlistPath,
  gateFArtifactInventoryPath,
  gateFArtifactInventoryHash,
} = {}) {
  const value = {
    schemaId: "xw.runtime.m6-c1-qualification-bootstrap.v1",
    releaseId: input?.releaseId,
    sourceCommit: input?.sourceCommit,
    sourceReleaseRoot,
    releaseManifestSha256,
    gateId: input?.gateId,
    gateIssuerAllowlistPath,
    gateFArtifactInventoryPath,
    gateFArtifactInventoryHash,
  };
  exactObject(value, QUALIFICATION_BINDING_KEYS, "M6_QUALIFICATION_BOOTSTRAP_BINDING_INVALID", "qualification binding");
  if (input?.schemaId !== M6_QUALIFICATION_BOOTSTRAP_PACKAGE_SCHEMA_ID
    || typeof value.releaseId !== "string" || value.releaseId === "" || !HEX40.test(value.sourceCommit ?? "")
    || !GATE_ID.test(value.gateId ?? "") || !HEX64.test(value.releaseManifestSha256 ?? "")
    || !HEX64.test(value.gateFArtifactInventoryHash ?? "")) {
    fail("M6_QUALIFICATION_BOOTSTRAP_BINDING_INVALID", "qualification binding hashes/identity are invalid");
  }
  for (const [key, path] of Object.entries({ sourceReleaseRoot, gateIssuerAllowlistPath, gateFArtifactInventoryPath })) {
    assertAbsolutePath(path, "M6_QUALIFICATION_BOOTSTRAP_BINDING_INVALID", key);
  }
  return Object.freeze(value);
}

function readRegularBytes(filePath, code = "M6_QUALIFICATION_BOOTSTRAP_ARTIFACT_INVALID", {
  controlledRoot = null,
  maxBytes = MAX_JSON_BYTES,
} = {}) {
  const target = assertPlainAncestors(filePath, code, "bootstrap artifact");
  if (controlledRoot !== null) {
    const root = assertAbsolutePath(controlledRoot, code, "controlled artifact root");
    if (!within(root, target)) fail(code, `artifact escapes its controlled root: ${target}`);
  }
  let fd;
  try {
    const before = lstatSync(target, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size < 1n || before.size > BigInt(maxBytes)) {
      fail(code, `required artifact is not one bounded single-link regular file: ${target}`);
    }
    fd = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd, { bigint: true });
    const afterOpen = lstatSync(target, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || afterOpen.isSymbolicLink()
      || !sameFilesystemIdentity(before, opened) || !sameFilesystemIdentity(opened, afterOpen)) {
      fail(code, `artifact changed while it was opened: ${target}`);
    }
    const bytes = readFileSync(fd);
    const afterRead = fstatSync(fd, { bigint: true });
    const pathAfterRead = lstatSync(target, { bigint: true });
    if (!sameFilesystemIdentity(opened, afterRead) || !sameFilesystemIdentity(afterRead, pathAfterRead)
      || pathAfterRead.isSymbolicLink() || pathAfterRead.size !== BigInt(bytes.length)) {
      fail(code, `artifact changed while it was read: ${target}`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    fail(code, `required regular artifact is unavailable: ${target}`, { cause: error?.message ?? null });
  } finally { if (fd !== undefined) closeSync(fd); }
}

function readRegularJson(filePath, code, options = {}) {
  try { return JSON.parse(readRegularBytes(filePath, code, options).toString("utf8")); } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    fail(code, `artifact is not valid JSON: ${resolve(filePath)}`);
  }
}

function assertExactExistingOrAbsent(path, expected, code = "M6_QUALIFICATION_BOOTSTRAP_ARTIFACT_DRIFT") {
  if (!existsSync(path)) return false;
  const actual = readRegularJson(path, code);
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(code, `existing immutable artifact differs: ${resolve(path)}`);
  return true;
}

function writeExactImmutable(path, record) {
  assertPlainAncestors(path, "M6_QUALIFICATION_BOOTSTRAP_ARTIFACT_DRIFT", "immutable bootstrap artifact", { allowMissing: true });
  if (assertExactExistingOrAbsent(path, record)) return resolve(path);
  let written;
  try { written = writeImmutableJson(path, record); } catch (error) {
    if (error?.code !== "M6_GATE_IMMUTABLE" || !assertExactExistingOrAbsent(path, record)) throw error;
    written = resolve(path);
  }
  assertExactExistingOrAbsent(path, record);
  return written;
}

function assertNoUnexpectedJson(dir, allowed) {
  const target = assertPlainAncestors(dir, "M6_QUALIFICATION_BOOTSTRAP_ARTIFACT_DRIFT", "bootstrap artifact directory", { allowMissing: true });
  if (!existsSync(target)) return;
  const before = lstatSync(target, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) fail("M6_QUALIFICATION_BOOTSTRAP_ARTIFACT_DRIFT", `artifact directory is not a real directory: ${target}`);
  const names = readdirSync(target);
  const after = lstatSync(target, { bigint: true });
  if (before.isSymbolicLink() || after.isSymbolicLink()
    || String(before.dev) !== String(after.dev) || String(before.ino) !== String(after.ino)
    || String(before.mode) !== String(after.mode)) {
    fail("M6_QUALIFICATION_BOOTSTRAP_ARTIFACT_DRIFT", `artifact directory changed during enumeration: ${target}`);
  }
  for (const name of names) {
    if (name.endsWith(".json") && !allowed.has(name)) {
      fail("M6_QUALIFICATION_BOOTSTRAP_ARTIFACT_DRIFT", `unexpected bootstrap JSON artifact: ${join(target, name)}`);
    }
  }
}

function validateProofRecord(record, label, issuerAllowlist) {
  exactObject(record, EPOCH_KEYS, "M6_QUALIFICATION_BOOTSTRAP_PACKAGE_INVALID", label);
  exactObject(record.proof, PROOF_KEYS, "M6_QUALIFICATION_BOOTSTRAP_PACKAGE_INVALID", `${label}.proof`);
  const { proof, ...epoch } = record;
  const errors = validateJsonSchema(epoch, loadEpochSchema());
  if (errors.length > 0 || deriveM6EpochHash(epoch) !== epoch.epochHash) {
    fail("M6_QUALIFICATION_BOOTSTRAP_EPOCH_INVALID", `${label} is not a schema-valid self-addressed v1 epoch`, { errors });
  }
  verifyEpochProof({ epoch, epochHash: epoch.epochHash, proof, allowlist: issuerAllowlist });
  return { epoch, proof };
}

function assertZeroPoint(value, label) {
  exactObject(value, ZERO_POINT_KEYS, "M6_QUALIFICATION_BOOTSTRAP_RESOURCE_SNAPSHOT_INVALID", label);
  if (ZERO_POINT_KEYS.some((key) => !Number.isSafeInteger(value[key]) || value[key] !== 0)) {
    fail("M6_QUALIFICATION_BOOTSTRAP_RESOURCE_SNAPSHOT_INVALID", `${label} must be an exact zero jobs/sessions/leases/runs/actions snapshot`);
  }
}

export function validateM6QualificationBootstrapPackage({
  package: input,
  issuerAllowlistPath,
  m6Root = null,
  nowMs = Date.now(),
  issuerReadObserver = null,
} = {}) {
  exactObject(input, PACKAGE_KEYS, "M6_QUALIFICATION_BOOTSTRAP_PACKAGE_INVALID", "qualification bootstrap package");
  if (input.schemaId !== M6_QUALIFICATION_BOOTSTRAP_PACKAGE_SCHEMA_ID
    || !GATE_ID.test(input.gateId ?? "") || typeof input.releaseId !== "string" || input.releaseId === ""
    || !HEX40.test(input.sourceCommit ?? "") || !HEX64.test(input.packageHash ?? "")
    || deriveM6QualificationBootstrapPackageHash(input) !== input.packageHash
    || !Number.isFinite(nowMs) || !Number.isFinite(Date.parse(input.promotedAt ?? ""))) {
    fail("M6_QUALIFICATION_BOOTSTRAP_PACKAGE_INVALID", "qualification bootstrap package identity/hash/time is invalid");
  }
  const promotedAtMs = Date.parse(input.promotedAt);
  if (promotedAtMs > nowMs) fail("M6_QUALIFICATION_BOOTSTRAP_PACKAGE_INVALID", "promotedAt may not be in the future");

  exactObject(input.locksRecord, ["lockHashes", "releaseId", "schemaId", "sourceCommit"], "M6_QUALIFICATION_BOOTSTRAP_LOCKS_INVALID", "locksRecord");
  exactObject(input.locksRecord.lockHashes, LOCK_KINDS, "M6_QUALIFICATION_BOOTSTRAP_LOCKS_INVALID", "locksRecord.lockHashes");
  if (input.locksRecord.schemaId !== "xw.m6-locks.v1" || input.locksRecord.releaseId !== input.releaseId
    || input.locksRecord.sourceCommit !== input.sourceCommit
    || LOCK_KINDS.some((kind) => !HEX64.test(input.locksRecord.lockHashes[kind] ?? ""))) {
    fail("M6_QUALIFICATION_BOOTSTRAP_LOCKS_INVALID", "locksRecord is not the exact release/source v1 lock set");
  }

  const issuerBytes = readRegularBytes(issuerAllowlistPath, "M6_QUALIFICATION_BOOTSTRAP_ISSUER_INVALID", {
    controlledRoot: m6Root === null ? dirname(assertAbsolutePath(issuerAllowlistPath, "M6_QUALIFICATION_BOOTSTRAP_ISSUER_INVALID", "issuer allowlist")) : m6Root,
  });
  if (sha256(issuerBytes) !== input.issuerAllowlistSha256) {
    fail("M6_QUALIFICATION_BOOTSTRAP_ISSUER_INVALID", "issuer allowlist bytes do not match the package pin");
  }
  if (issuerReadObserver !== null && typeof issuerReadObserver !== "function") {
    fail("M6_QUALIFICATION_BOOTSTRAP_INPUT_INVALID", "issuerReadObserver must be a function when provided");
  }
  issuerReadObserver?.(Object.freeze({
    path: resolve(issuerAllowlistPath),
    sha256: input.issuerAllowlistSha256,
    byteLength: issuerBytes.byteLength,
  }));
  let issuerRecord;
  try {
    issuerRecord = JSON.parse(issuerBytes.toString("utf8"));
  } catch {
    fail("M6_QUALIFICATION_BOOTSTRAP_ISSUER_INVALID", "issuer allowlist pinned bytes are not valid JSON");
  }
  // Proof verification must consume the exact same strict-read bytes whose
  // raw SHA-256 was pinned by the externally signed package.  Reopening the
  // path here would permit a swap between hash verification and key lookup.
  const issuerAllowlist = normalizeGateIssuerAllowlist(issuerRecord);
  const root = validateProofRecord(input.rootEpochRecord, "rootEpochRecord", issuerAllowlist).epoch;
  const closed = validateProofRecord(input.closedEpochRecord, "closedEpochRecord", issuerAllowlist).epoch;
  const sameAuthority = root.gateId === input.gateId && closed.gateId === input.gateId
    && root.releaseId === input.releaseId && closed.releaseId === input.releaseId
    && root.sourceCommit === input.sourceCommit && closed.sourceCommit === input.sourceCommit
    && root.actor === closed.actor && typeof root.actor === "string" && root.actor !== ""
    && canonicalJson(root.lockHashes) === canonicalJson(input.locksRecord.lockHashes)
    && canonicalJson(closed.lockHashes) === canonicalJson(input.locksRecord.lockHashes)
    && canonicalJson(root.allowlist) === canonicalJson(["01"])
    && canonicalJson(closed.allowlist) === canonicalJson(["01"])
    && root.expiresAt === closed.expiresAt;
  if (!sameAuthority || root.mode !== "OBSERVE_ONLY" || root.status !== "active" || root.parentEpochHash !== null
    || root.closeoutRef !== null || root.aggregateSealRef !== null || root.rollbackTargetEpochHash !== null
    || closed.mode !== "CLOSED" || closed.status !== "closed" || closed.parentEpochHash !== root.epochHash
    || closed.rollbackTargetEpochHash !== null) {
    fail("M6_QUALIFICATION_BOOTSTRAP_CHAIN_INVALID", "package must contain one unactivated alias-01 OBSERVE_ONLY root followed directly by one CLOSED tail");
  }
  const rootIssuedAt = Date.parse(root.issuedAt);
  const closedIssuedAt = Date.parse(closed.issuedAt);
  const expiresAt = Date.parse(root.expiresAt);
  if (![rootIssuedAt, closedIssuedAt, expiresAt].every(Number.isFinite)
    || rootIssuedAt > closedIssuedAt || closedIssuedAt > promotedAtMs || expiresAt <= nowMs) {
    fail("M6_QUALIFICATION_BOOTSTRAP_CHAIN_INVALID", "bootstrap epoch chronology/TTL is invalid or expired");
  }

  exactObject(input.closeout, ["actor", "closeoutHash", "closeoutId", "committedAt", "epochHash", "reason"], "M6_QUALIFICATION_BOOTSTRAP_CLOSEOUT_INVALID", "closeout");
  if (input.closeout.epochHash !== root.epochHash || input.closeout.actor !== root.actor
    || typeof input.closeout.closeoutId !== "string" || input.closeout.closeoutId === ""
    || typeof input.closeout.reason !== "string" || input.closeout.reason === ""
    || deriveM6CloseoutHash(input.closeout) !== input.closeout.closeoutHash
    || canonicalJson(closed.closeoutRef) !== canonicalJson({ id: input.closeout.closeoutId, sha256: input.closeout.closeoutHash })) {
    fail("M6_QUALIFICATION_BOOTSTRAP_CLOSEOUT_INVALID", "closeout is not an exact content-addressed seal of the unactivated root");
  }
  const committedAt = Date.parse(input.closeout.committedAt);
  if (!Number.isFinite(committedAt) || committedAt < rootIssuedAt || committedAt > closedIssuedAt) {
    fail("M6_QUALIFICATION_BOOTSTRAP_CLOSEOUT_INVALID", "closeout chronology does not bind the root-to-CLOSED transition");
  }

  exactObject(input.scenarioManifest, ["allowlist", "attemptCount", "epochHash", "manifestSha256", "scenarios", "schemaId"], "M6_QUALIFICATION_BOOTSTRAP_SCENARIO_INVALID", "scenarioManifest");
  if (input.scenarioManifest.schemaId !== M6_QUALIFICATION_BOOTSTRAP_SCENARIO_SCHEMA_ID
    || input.scenarioManifest.epochHash !== root.epochHash
    || canonicalJson(input.scenarioManifest.allowlist) !== canonicalJson(["01"])
    || input.scenarioManifest.attemptCount !== 0 || !Array.isArray(input.scenarioManifest.scenarios)
    || input.scenarioManifest.scenarios.length !== 0
    || deriveM6QualificationBootstrapScenarioManifestHash(input.scenarioManifest) !== input.scenarioManifest.manifestSha256) {
    fail("M6_QUALIFICATION_BOOTSTRAP_SCENARIO_INVALID", "bootstrap scenario manifest must prove an exact empty attempt set for alias 01");
  }

  exactObject(input.resourceSnapshot, ["actionCount", "after", "before", "epochHash", "schemaId", "snapshotSha256"], "M6_QUALIFICATION_BOOTSTRAP_RESOURCE_SNAPSHOT_INVALID", "resourceSnapshot");
  assertZeroPoint(input.resourceSnapshot.before, "resourceSnapshot.before");
  assertZeroPoint(input.resourceSnapshot.after, "resourceSnapshot.after");
  if (input.resourceSnapshot.schemaId !== "xw.m6-resource-snapshot.v1"
    || input.resourceSnapshot.epochHash !== root.epochHash || input.resourceSnapshot.actionCount !== 0
    || deriveM6ResourceSnapshotSha256(input.resourceSnapshot) !== input.resourceSnapshot.snapshotSha256) {
    fail("M6_QUALIFICATION_BOOTSTRAP_RESOURCE_SNAPSHOT_INVALID", "resource snapshot does not re-derive as an exact zero snapshot");
  }

  exactObject(input.aggregate, ["aliases", "attemptCount", "epochHash", "schemaId", "sealHash", "sealPayload"], "M6_QUALIFICATION_BOOTSTRAP_AGGREGATE_INVALID", "aggregate");
  exactObject(input.aggregate.sealPayload, ["allowlist", "attempts", "epochHash", "resourceSnapshotSha256", "scenarioManifestSha256"], "M6_QUALIFICATION_BOOTSTRAP_AGGREGATE_INVALID", "aggregate.sealPayload");
  const sealPayload = input.aggregate.sealPayload;
  if (input.aggregate.schemaId !== "xw.m6-aggregate-closeout.v1" || input.aggregate.epochHash !== root.epochHash
    || input.aggregate.attemptCount !== 0 || canonicalJson(input.aggregate.aliases) !== canonicalJson(["01"])
    || sealPayload.epochHash !== root.epochHash || canonicalJson(sealPayload.allowlist) !== canonicalJson(["01"])
    || !Array.isArray(sealPayload.attempts) || sealPayload.attempts.length !== 0
    || sealPayload.scenarioManifestSha256 !== input.scenarioManifest.manifestSha256
    || sealPayload.resourceSnapshotSha256 !== input.resourceSnapshot.snapshotSha256
    || deriveM6AggregateSealHash(sealPayload) !== input.aggregate.sealHash
    || canonicalJson(closed.aggregateSealRef) !== canonicalJson({ id: input.aggregate.sealHash, sha256: input.aggregate.sealHash })) {
    fail("M6_QUALIFICATION_BOOTSTRAP_AGGREGATE_INVALID", "CLOSED tail aggregate is not the exact zero-attempt/bootstrap-resource seal");
  }

  const evaluation = evaluateM6Gate({
    chain: [root, closed],
    closeouts: { [input.closeout.closeoutId]: input.closeout },
    aggregates: { [input.aggregate.sealHash]: input.aggregate },
    nowMs,
    expectedRelease: { releaseId: input.releaseId, sourceCommit: input.sourceCommit },
    lockHashes: input.locksRecord.lockHashes,
  });
  if (evaluation.mode !== "CLOSED" || evaluation.activeEpochHash !== closed.epochHash || evaluation.errors.length !== 0) {
    fail("M6_QUALIFICATION_BOOTSTRAP_CHAIN_INVALID", "verified bootstrap chain does not evaluate to one error-free CLOSED tail", { errors: evaluation.errors });
  }
  return Object.freeze({ package: input, rootEpoch: root, closedEpoch: closed, issuerAllowlist });
}

function normalizeSqlValue(value) {
  if (Buffer.isBuffer(value)) return { type: "blob", base64: value.toString("base64") };
  if (typeof value === "bigint") return { type: "bigint", value: value.toString(10) };
  return value;
}

function inspectLogicalState(dbPath, referenceTables = null) {
  const db = new DatabaseSync(resolve(dbPath), { readOnly: true });
  try {
    const integrityCheck = db.prepare("PRAGMA integrity_check").get().integrity_check;
    if (integrityCheck !== "ok") fail("M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_INVALID", "database integrity_check failed", { integrityCheck });
    const userVersion = Number(db.prepare("PRAGMA user_version").get().user_version);
    const presentTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
    const selected = referenceTables ? referenceTables.map((entry) => entry.name) : presentTables.filter((name) => !name.startsWith("m6_"));
    const descriptors = [];
    for (const name of selected) {
      if (!presentTables.includes(name)) fail("M6_QUALIFICATION_BOOTSTRAP_LEGACY_STATE_DRIFT", `legacy table disappeared during migration: ${name}`);
      const escapedTable = name.replaceAll('"', '""');
      const available = db.prepare(`PRAGMA table_info("${escapedTable}")`).all().map((row) => row.name);
      const reference = referenceTables?.find((entry) => entry.name === name);
      const columns = reference ? reference.columns : available;
      if (columns.some((column) => !available.includes(column))) fail("M6_QUALIFICATION_BOOTSTRAP_LEGACY_STATE_DRIFT", `legacy column disappeared during migration: ${name}`);
      const projection = columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(",");
      const rows = db.prepare(`SELECT ${projection} FROM "${escapedTable}"`).all().map((row) => canonicalJson(
        columns.map((column) => [column, normalizeSqlValue(row[column])]),
      )).sort();
      descriptors.push(Object.freeze({
        name,
        columns: Object.freeze([...columns]),
        rowCount: rows.length,
        rowHash: sha256(`xw.m6-c1-qualification-bootstrap-table.v1:${canonicalJson(rows)}`),
      }));
    }
    const tables = Object.freeze(descriptors);
    return Object.freeze({
      integrityCheck,
      userVersion,
      tables,
      logicalStateHash: sha256(`xw.m6-c1-qualification-bootstrap-legacy-state.v1:${canonicalJson(tables)}`),
      m6Tables: Object.freeze(presentTables.filter((name) => name.startsWith("m6_"))),
    });
  } finally { db.close(); }
}

function inspectV18BootstrapResources(dbPath, nowMs) {
  const db = new DatabaseSync(resolve(dbPath), { readOnly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    const count = (table, sql) => tables.has(table) ? Number(db.prepare(sql).get().count) : 0;
    return Object.freeze({
      jobs: count("jobs", "SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued','waiting_approval','running','verifying','restoring')"),
      sessions: count("sessions", `SELECT COUNT(*) AS count FROM sessions WHERE expires_at>${Number(nowMs)}`),
      leases: count("leases", `SELECT COUNT(*) AS count FROM leases WHERE expires_at>${Number(nowMs)}`),
      actions: count("device_session_actions", "SELECT COUNT(*) AS count FROM device_session_actions WHERE execution_mode='m6-grounded-live-v2'"),
    });
  } finally { db.close(); }
}

function capturePlainSingleLinkDatabase(dbPath) {
  const target = assertPlainAncestors(dbPath, "M6_QUALIFICATION_BOOTSTRAP_DB_PATH_INVALID", "control DB");
  let stat;
  try { stat = lstatSync(target, { bigint: true }); } catch {
    fail("M6_QUALIFICATION_BOOTSTRAP_DB_PATH_INVALID", "control DB is unavailable");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    fail("M6_QUALIFICATION_BOOTSTRAP_DB_PATH_INVALID", "control DB must be one plain single-link regular file");
  }
  return Object.freeze({ path: target, stat });
}

function assertDatabaseIdentity(expected, { allowContentChange = false } = {}) {
  const current = capturePlainSingleLinkDatabase(expected.path);
  const stable = String(current.stat.dev) === String(expected.stat.dev)
    && String(current.stat.ino) === String(expected.stat.ino)
    && String(current.stat.mode) === String(expected.stat.mode)
    && current.stat.nlink === 1n;
  const contentStable = String(current.stat.size) === String(expected.stat.size)
    && String(current.stat.mtimeNs ?? current.stat.mtimeMs) === String(expected.stat.mtimeNs ?? expected.stat.mtimeMs);
  if (!stable || (!allowContentChange && !contentStable)) {
    fail("M6_QUALIFICATION_BOOTSTRAP_DB_PATH_RACE", "control DB path identity changed during qualification bootstrap");
  }
  return current;
}

function buildSnapshotBindingReceipt({
  raw,
  package: input,
  dbPath,
  snapshotDirectory,
  snapshotLabel,
  sourceFileSha256,
  expectedSourceState,
}) {
  if (!raw || raw.ok !== true || raw.integrityCheck !== "ok" || raw.userVersion !== 18
    || raw.label !== snapshotLabel || resolve(raw.source?.path ?? "") !== resolve(dbPath) || !raw.snapshot?.path
    || raw.source?.sha256 !== sourceFileSha256
    || !Number.isFinite(Date.parse(raw.snapshottedAt ?? ""))) {
    fail("M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_INVALID", "snapshot callback did not return a verified v18 source/snapshot receipt");
  }
  const snapshotPath = resolve(raw.snapshot.path);
  const expectedSnapshotPath = join(resolve(snapshotDirectory), `${snapshotLabel}.snapshot.db`);
  if (snapshotPath !== expectedSnapshotPath) {
    fail("M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_INVALID", "snapshot callback wrote outside the exact requested destination");
  }
  const snapshotBytes = readRegularBytes(snapshotPath, "M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_INVALID", {
    controlledRoot: snapshotDirectory,
    maxBytes: MAX_DB_BYTES,
  });
  if (sha256(snapshotBytes) !== raw.snapshot.sha256) fail("M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_INVALID", "snapshot bytes do not match callback receipt");
  const sourceState = inspectLogicalState(dbPath);
  const snapshotState = inspectLogicalState(snapshotPath);
  if (sourceState.userVersion !== 18 || snapshotState.userVersion !== 18 || sourceState.m6Tables.length !== 0
    || snapshotState.m6Tables.length !== 0 || sourceState.logicalStateHash !== snapshotState.logicalStateHash) {
    fail("M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_INVALID", "snapshot is not an exact restorable v18 logical copy without M6 authority tables");
  }
  if (expectedSourceState && (sourceState.logicalStateHash !== expectedSourceState.logicalStateHash
    || canonicalJson(sourceState.tables) !== canonicalJson(expectedSourceState.tables))) {
    fail("M6_QUALIFICATION_BOOTSTRAP_DB_PATH_RACE", "control DB logical rows changed while the snapshot callback ran");
  }
  const body = {
    schemaId: M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_SCHEMA_ID,
    packageHash: input.packageHash,
    gateId: input.gateId,
    releaseId: input.releaseId,
    sourceCommit: input.sourceCommit,
    sourceDbPath: resolve(dbPath),
    sourceDbSha256: sourceFileSha256,
    sourceUserVersion: 18,
    sourceLogicalStateHash: sourceState.logicalStateHash,
    snapshotPath,
    snapshotSha256: raw.snapshot.sha256,
    snapshotSizeBytes: snapshotBytes.byteLength,
    snapshotUserVersion: 18,
    integrityCheck: "ok",
    method: String(raw.method || "unknown"),
    snapshottedAt: raw.snapshottedAt,
    legacyState: { tables: snapshotState.tables, logicalStateHash: snapshotState.logicalStateHash },
  };
  return Object.freeze({ ...body, receiptHash: deriveM6QualificationBootstrapDbSnapshotReceiptHash(body) });
}

function verifySnapshotBindingReceipt({ receipt, package: input, dbPath, sourceVersion, snapshotDirectory, snapshotLabel }) {
  exactObject(receipt, SNAPSHOT_RECEIPT_KEYS, "M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_INVALID", "DB snapshot binding receipt");
  if (receipt.schemaId !== M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_SCHEMA_ID
    || receipt.packageHash !== input.packageHash || receipt.gateId !== input.gateId
    || receipt.releaseId !== input.releaseId || receipt.sourceCommit !== input.sourceCommit
    || resolve(receipt.sourceDbPath) !== resolve(dbPath) || receipt.sourceUserVersion !== 18
    || receipt.snapshotUserVersion !== 18 || receipt.integrityCheck !== "ok"
    || deriveM6QualificationBootstrapDbSnapshotReceiptHash(receipt) !== receipt.receiptHash
    || !HEX64.test(receipt.sourceDbSha256 ?? "") || !HEX64.test(receipt.snapshotSha256 ?? "") || !Number.isSafeInteger(receipt.snapshotSizeBytes)
    || !Number.isFinite(Date.parse(receipt.snapshottedAt ?? ""))) {
    fail("M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_INVALID", "DB snapshot binding receipt identity/hash is invalid");
  }
  if (resolve(receipt.snapshotPath) !== join(resolve(snapshotDirectory), `${snapshotLabel}.snapshot.db`)) {
    fail("M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_INVALID", "persisted snapshot path is outside the exact requested destination");
  }
  const bytes = readRegularBytes(receipt.snapshotPath, "M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_INVALID", {
    controlledRoot: snapshotDirectory,
    maxBytes: MAX_DB_BYTES,
  });
  if (bytes.byteLength !== receipt.snapshotSizeBytes || sha256(bytes) !== receipt.snapshotSha256) {
    fail("M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_INVALID", "persisted DB snapshot bytes drifted from their receipt");
  }
  const snapshotState = inspectLogicalState(receipt.snapshotPath);
  const receiptLegacy = receipt.legacyState;
  if (!receiptLegacy || !Array.isArray(receiptLegacy.tables) || snapshotState.userVersion !== 18
    || snapshotState.m6Tables.length !== 0
    || snapshotState.logicalStateHash !== receiptLegacy.logicalStateHash
    || snapshotState.logicalStateHash !== receipt.sourceLogicalStateHash
    || canonicalJson(snapshotState.tables) !== canonicalJson(receiptLegacy.tables)) {
    fail("M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_INVALID", "persisted snapshot no longer reproduces the bound legacy row hashes");
  }
  if (sourceVersion === 18) {
    const sourceBytes = readRegularBytes(dbPath, "M6_QUALIFICATION_BOOTSTRAP_DB_PATH_INVALID", { maxBytes: MAX_DB_BYTES });
    const sourceState = inspectLogicalState(dbPath);
    if (sha256(sourceBytes) !== receipt.sourceDbSha256 || sourceState.m6Tables.length !== 0
      || sourceState.logicalStateHash !== receipt.sourceLogicalStateHash) {
      fail("M6_QUALIFICATION_BOOTSTRAP_LEGACY_STATE_DRIFT", "v18 source changed after its bound snapshot was created");
    }
  }
  return receipt;
}

function artifactPaths(m6Root, verified) {
  const input = verified.package;
  const gateDir = join(resolve(m6Root), "m6-gate", input.gateId);
  const qualificationDir = join(gateDir, "qualification-bootstrap");
  return Object.freeze({
    locks: join(gateDir, "locks.v1.json"),
    gateDir,
    qualificationDir,
    snapshotReceipt: join(qualificationDir, "db-snapshot-receipt.json"),
    rootEpoch: join(gateDir, "epochs", `${verified.rootEpoch.epochHash}.json`),
    closedEpoch: join(gateDir, "epochs", `${verified.closedEpoch.epochHash}.json`),
    closeout: join(gateDir, "closeouts", `${input.closeout.closeoutId}.json`),
    aggregate: join(gateDir, "aggregate", `${input.aggregate.sealHash}.json`),
    scenario: join(qualificationDir, `${input.scenarioManifest.manifestSha256}.scenario-manifest.json`),
    resource: join(qualificationDir, `${input.resourceSnapshot.snapshotSha256}.resource-snapshot.json`),
    package: join(qualificationDir, `${input.packageHash}.package.json`),
    current: join(gateDir, "current.json"),
  });
}

function assertArtifactNamespaces(paths, verified, { includeReceipt = true } = {}) {
  const input = verified.package;
  assertNoUnexpectedJson(join(paths.gateDir, "epochs"), new Set([
    `${verified.rootEpoch.epochHash}.json`, `${verified.closedEpoch.epochHash}.json`,
  ]));
  assertNoUnexpectedJson(join(paths.gateDir, "closeouts"), new Set([`${input.closeout.closeoutId}.json`]));
  assertNoUnexpectedJson(join(paths.gateDir, "aggregate"), new Set([`${input.aggregate.sealHash}.json`]));
  assertNoUnexpectedJson(paths.qualificationDir, new Set([
    `${input.scenarioManifest.manifestSha256}.scenario-manifest.json`,
    `${input.resourceSnapshot.snapshotSha256}.resource-snapshot.json`,
    `${input.packageHash}.package.json`,
    ...(includeReceipt ? ["db-snapshot-receipt.json"] : []),
  ]));
}

function installArtifacts(paths, verified) {
  const input = verified.package;
  writeExactImmutable(paths.locks, input.locksRecord);
  writeExactImmutable(paths.closeout, input.closeout);
  writeExactImmutable(paths.aggregate, input.aggregate);
  writeExactImmutable(paths.scenario, input.scenarioManifest);
  writeExactImmutable(paths.resource, input.resourceSnapshot);
  writeExactImmutable(paths.rootEpoch, input.rootEpochRecord);
  writeExactImmutable(paths.closedEpoch, input.closedEpochRecord);
  writeExactImmutable(paths.package, input);
  assertArtifactNamespaces(paths, verified);
}

function expectedPointer(verified) {
  return Object.freeze({
    chain: Object.freeze([verified.rootEpoch.epochHash, verified.closedEpoch.epochHash]),
    tailEpochHash: verified.closedEpoch.epochHash,
    generation: 0,
    promotedAt: verified.package.promotedAt,
  });
}

function injectedFault(stage) {
  fail("M6_QUALIFICATION_BOOTSTRAP_FAULT", `injected failure after ${stage}`);
}

function bootstrapM6QualificationInternal({
  package: input,
  m6Root,
  dbPath,
  issuerAllowlistPath = join(resolve(m6Root || "."), "m6-gate", "issuer-keys.json"),
  snapshotDatabase = null,
  snapshotDirectory,
  snapshotLabel = null,
  dbSnapshotReceipt = null,
  activeRunCount = null,
  now = Date.now,
  faultAfter = null,
  stateFactory = (options) => new StateStore(options),
} = {}) {
  if (typeof m6Root !== "string" || m6Root === "" || typeof dbPath !== "string" || dbPath === ""
    || typeof now !== "function" || typeof activeRunCount !== "function" || typeof stateFactory !== "function") {
    fail("M6_QUALIFICATION_BOOTSTRAP_INPUT_INVALID", "m6Root, dbPath, now, activeRunCount, and stateFactory are required");
  }
  const runtimeRoot = assertAbsolutePath(m6Root, "M6_QUALIFICATION_BOOTSTRAP_INPUT_INVALID", "m6Root");
  const initialDbIdentity = capturePlainSingleLinkDatabase(assertAbsolutePath(dbPath, "M6_QUALIFICATION_BOOTSTRAP_INPUT_INVALID", "dbPath"));
  const controlDbPath = initialDbIdentity.path;
  const backupRoot = assertAbsolutePath(snapshotDirectory, "M6_QUALIFICATION_BOOTSTRAP_INPUT_INVALID", "snapshotDirectory");
  const resolvedSnapshotLabel = snapshotLabel ?? `m6-c1-${input?.packageHash?.slice(0, 16) ?? "invalid"}`;
  if (!/^[A-Za-z0-9._-]{1,96}$/u.test(resolvedSnapshotLabel)) {
    fail("M6_QUALIFICATION_BOOTSTRAP_INPUT_INVALID", "snapshotLabel must be one bounded filesystem-safe label");
  }
  if (within(runtimeRoot, backupRoot) || within(dirname(controlDbPath), backupRoot)) {
    fail("M6_QUALIFICATION_BOOTSTRAP_INPUT_INVALID", "snapshotDirectory must be outside the mutable runtime and control DB directory");
  }
  assertPlainAncestors(join(backupRoot, `${resolvedSnapshotLabel}.snapshot.db`), "M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_INVALID", "snapshot destination", { allowMissing: true });
  const nowMs = Number(now());
  const verified = validateM6QualificationBootstrapPackage({ package: input, issuerAllowlistPath, m6Root: runtimeRoot, nowMs });
  const paths = artifactPaths(runtimeRoot, verified);
  assertArtifactNamespaces(paths, verified);
  const pointer = expectedPointer(verified);
  const existingPointer = existsSync(paths.current)
    ? readRegularJson(paths.current, "M6_QUALIFICATION_BOOTSTRAP_POINTER_DRIFT")
    : null;
  if (existingPointer && canonicalJson(existingPointer) !== canonicalJson(pointer)) {
    fail("M6_QUALIFICATION_BOOTSTRAP_POINTER_DRIFT", "existing current pointer differs from the exact generation-0 bootstrap pointer");
  }
  if (activeRunCount() !== 0) fail("M6_QUALIFICATION_BOOTSTRAP_RESOURCES_NOT_ZERO", "qualification bootstrap requires zero in-memory runs before migration");

  const initialSourceState = inspectLogicalState(controlDbPath);
  const sourceVersion = initialSourceState.userVersion;
  if (![18, CURRENT_CONTROL_SCHEMA_VERSION].includes(sourceVersion)) {
    fail("M6_QUALIFICATION_BOOTSTRAP_DB_VERSION_INVALID",
      `qualification bootstrap requires the production v18 source or an exact v${CURRENT_CONTROL_SCHEMA_VERSION} replay`);
  }
  if (sourceVersion === 18 && existingPointer) {
    fail("M6_QUALIFICATION_BOOTSTRAP_POINTER_AHEAD", "generation-0 pointer may never be published before the DB fence");
  }
  const preMigrationResources = inspectV18BootstrapResources(controlDbPath, nowMs);
  if (Object.values(preMigrationResources).some((count) => !Number.isSafeInteger(count) || count !== 0)) {
    fail(
      "M6_QUALIFICATION_BOOTSTRAP_RESOURCES_NOT_ZERO",
      "read-only pre-migration resource audit found active jobs/sessions/leases/actions",
      { preMigrationResources },
    );
  }
  let snapshotReceipt = existsSync(paths.snapshotReceipt)
    ? readRegularJson(paths.snapshotReceipt, "M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_INVALID")
    : dbSnapshotReceipt;
  if (existsSync(paths.snapshotReceipt) && dbSnapshotReceipt
    && canonicalJson(snapshotReceipt) !== canonicalJson(dbSnapshotReceipt)) {
    fail("M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_INVALID", "provided DB snapshot receipt differs from the immutable persisted receipt");
  }
  if (!snapshotReceipt) {
    if (sourceVersion !== 18 || typeof snapshotDatabase !== "function") {
      fail("M6_QUALIFICATION_BOOTSTRAP_DB_SNAPSHOT_REQUIRED", "a verified pre-migration v18 DB snapshot is required before StateStore may open");
    }
    const sourceFileSha256 = sha256(readRegularBytes(controlDbPath, "M6_QUALIFICATION_BOOTSTRAP_DB_PATH_INVALID", { maxBytes: MAX_DB_BYTES }));
    const raw = snapshotDatabase({
      sourcePath: controlDbPath,
      destDir: backupRoot,
      label: resolvedSnapshotLabel,
      packageHash: input.packageHash,
      gateId: input.gateId,
      releaseId: input.releaseId,
      sourceCommit: input.sourceCommit,
    });
    assertDatabaseIdentity(initialDbIdentity);
    snapshotReceipt = buildSnapshotBindingReceipt({
      raw,
      package: input,
      dbPath: controlDbPath,
      snapshotDirectory: backupRoot,
      snapshotLabel: resolvedSnapshotLabel,
      sourceFileSha256,
      expectedSourceState: initialSourceState,
    });
  }
  verifySnapshotBindingReceipt({
    receipt: snapshotReceipt,
    package: input,
    dbPath: controlDbPath,
    sourceVersion,
    snapshotDirectory: backupRoot,
    snapshotLabel: resolvedSnapshotLabel,
  });
  writeExactImmutable(paths.snapshotReceipt, snapshotReceipt);
  if (faultAfter === "snapshotReceipt") injectedFault("snapshotReceipt");

  installArtifacts(paths, verified);
  if (faultAfter === "artifacts") injectedFault("artifacts");

  let state = null;
  let stateFactoryStarted = false;
  try {
    assertDatabaseIdentity(initialDbIdentity);
    stateFactoryStarted = true;
    state = stateFactory({ dbPath: controlDbPath, now, m6RuntimeMode: "QUALIFICATION_ONLY" });
    assertDatabaseIdentity(initialDbIdentity, { allowContentChange: true });
    const migrated = inspectLogicalState(controlDbPath, snapshotReceipt.legacyState.tables);
    if (migrated.userVersion !== CURRENT_CONTROL_SCHEMA_VERSION
      || migrated.logicalStateHash !== snapshotReceipt.legacyState.logicalStateHash
      || canonicalJson(migrated.tables) !== canonicalJson(snapshotReceipt.legacyState.tables)) {
      fail("M6_QUALIFICATION_BOOTSTRAP_LEGACY_STATE_DRIFT",
        `v18-to-v${CURRENT_CONTROL_SCHEMA_VERSION} migration changed legacy table rows`);
    }
    if (faultAfter === "migration") injectedFault("migration");

    const fenceBefore = state.getM6GateFence();
    if (existingPointer && !fenceBefore) {
      fail("M6_QUALIFICATION_BOOTSTRAP_POINTER_AHEAD", "published generation-0 pointer has no matching DB fence");
    }
    const locksHash = sha256(`xw.m6-locks.v1:${canonicalJson(verified.closedEpoch.lockHashes)}`);
    const fence = state.seedM6QualificationBootstrapFence({ epoch: verified.closedEpoch, locksHash });
    if (faultAfter === "dbFence") injectedFault("dbFence");

    if (!existingPointer) writeExactImmutable(paths.current, pointer);
    if (faultAfter === "pointer") injectedFault("pointer");

    const loaded = loadM6Gate({
      m6Root: resolve(m6Root),
      gateId: input.gateId,
      issuerAllowlistPath,
      requireLocks: true,
    });
    assertM6FileDbPointerConsistency({ loaded, fence, pointer: loaded.currentPointer });
    const evaluation = evaluateM6Gate({
      ...loaded,
      nowMs: Number(now()),
      expectedRelease: { releaseId: input.releaseId, sourceCommit: input.sourceCommit },
      lockHashes: input.locksRecord.lockHashes,
    });
    const resources = state.getM6GateFResourceCounts();
    if (evaluation.mode !== "CLOSED" || evaluation.errors.length !== 0
      || activeRunCount() !== 0 || Object.values(resources).some((count) => count !== 0)) {
      fail("M6_QUALIFICATION_BOOTSTRAP_FINAL_ASSERTION_FAILED", "bootstrap did not converge to one CLOSED triple-consistent zero-resource generation", {
        errors: evaluation.errors,
        resources,
      });
    }
    assertDatabaseIdentity(initialDbIdentity, { allowContentChange: true });
    const resultBody = {
      schemaId: "xw.m6-c1-qualification-bootstrap-result.v1",
      packageHash: input.packageHash,
      dbSnapshotReceiptHash: snapshotReceipt.receiptHash,
      gateId: input.gateId,
      epochHash: fence.epochHash,
      generation: fence.generation,
      locksHash: fence.locksHash,
      releaseId: fence.releaseId,
      sourceCommit: fence.sourceCommit,
      mode: fence.mode,
      resourceCounts: { jobs: resources.jobs, leases: resources.leases, runs: 0, sessions: resources.sessions },
      actionCount: resources.actionCount,
    };
    const result = Object.freeze({
      ...resultBody,
      resultHash: sha256(`xw.m6-c1-qualification-bootstrap-result.v1:${canonicalJson(resultBody)}`),
      dbSnapshotReceipt: snapshotReceipt,
    });
    try {
      state.close();
    } catch (cleanupError) {
      throw cleanupUnprovenError(null, cleanupError);
    }
    state = null;
    return result;
  } catch (error) {
    if (CLEANUP_UNPROVEN_ERRORS.has(error)) throw error;
    if (!state && stateFactoryStarted) {
      throw cleanupUnprovenError(error);
    }
    if (state) {
      try {
        state.close();
        state = null;
      } catch (cleanupError) {
        throw cleanupUnprovenError(error, cleanupError);
      }
    }
    throw cleanupVerifiedError(error);
  }
}

export function bootstrapM6Qualification(input = {}) {
  try {
    return bootstrapM6QualificationInternal(input);
  } catch (error) {
    if (CLEANUP_UNPROVEN_ERRORS.has(error) || CLEANUP_VERIFIED_ERRORS.has(error)) throw error;
    // Every throw outside the StateStore lifetime is cleanup-safe by
    // construction: no StateStore cleanup authority has been acquired yet.
    throw cleanupVerifiedError(error);
  }
}
