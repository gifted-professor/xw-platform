#!/usr/bin/env node

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";

import {
  M64_LIVE_WINDOW_RUNTIME_BINDING_FIELDS,
  selectM64LiveWindowRuntimeBinding,
} from "../../packages/kernel/lib/m6-4-live-window-authorization.mjs";
import { verifyReleaseManifest } from "../../packages/release/lib/release-manifest.mjs";
import { canonicalJson } from "../../services/control-plane/control-plane/lib/canonical.mjs";
import {
  CURRENT_CONTROL_SCHEMA_VERSION,
} from "../../services/control-plane/control-plane/lib/state-store.mjs";
import {
  M6_GATE_F_ARTIFACT_CATALOG_PURPOSES,
  createM6GateFOperations,
  loadM6GateFArtifactCatalog,
  selectM6GateFArtifactInventory,
} from "../../services/control-plane/control-plane/lib/m6-gate-f-operations.mjs";
import { loadM6Gate } from "../../services/control-plane/control-plane/lib/m6-gate-loader.mjs";
import { assertM6FileDbPointerConsistency } from "../../services/control-plane/control-plane/lib/m6-gate-promoter.mjs";
import { acquireM6C1StoppedRuntimeGuard } from "../../services/control-plane/control-plane/lib/m6-c1-runtime-owner-lock.mjs";
import {
  publishRecoverableCreateOnly,
  recoverPublishedCreateOnlyBytes,
  RecoverablePublicationError,
} from "./lib/recoverable-create-only-publication.mjs";

const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const ID = /^[A-Za-z0-9._-]{1,128}$/u;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const FINAL_BINDING_FILE = "m6-c1-runtime.v1.json";
const FINAL_BINDING_SCHEMA = "xw.runtime.m6-c1-runtime.v1";
const HISTORY_DIRECTORY = "m6-live-window-runtime-bindings";
const INTERNAL_PREFLIGHT_TOKEN = "m6-stage-window-local-preflight-only";

export const M64_FINAL_RUNTIME_BINDING_FIELDS = Object.freeze([
  "schemaId", "releaseId", "sourceCommit", "sourceReleaseRoot", "releaseManifestSha256",
  "dependencyRoot", "dependencyLayerHash", "modelProfileRoot", "modelProfileHash",
  "providerBaseUrl", "manifestRoot", "runtimeSnapshotPath", "dshPersistenceRoot", "gateId",
  "gateIssuerAllowlistPath", "liveAuthorizationIssuerAllowlistPath",
  "gateFArtifactCatalogPath", "gateFArtifactCatalogHash", "gateFArtifactCatalogSha256",
  "targetEnvironmentAttestationPath", "targetEnvironmentAttestationHash",
  "environmentQualificationPath", "environmentQualificationSha256",
  "productionDependencyBindingPath", "productionDependencyBindingHash",
]);

function stageError(code, message, details = {}) {
  throw Object.assign(new Error(`${code}: ${message}`), { code, details });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function exactObject(value, fields) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...fields].sort()));
}

function normalizedPath(value) {
  const path = resolve(value);
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function within(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sameIdentity(left, right) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && String(left.mode) === String(right.mode)
    && String(left.nlink) === String(right.nlink)
    && String(left.size) === String(right.size)
    && String(left.mtimeNs ?? left.mtimeMs) === String(right.mtimeNs ?? right.mtimeMs);
}

function assertPlainDirectory(path, label) {
  const target = resolve(path);
  let stat;
  let real;
  try {
    stat = lstatSync(target);
    real = realpathSync(target);
  } catch (cause) {
    stageError("M64_STAGE_PATH_UNAVAILABLE", `${label} directory is unavailable`, { cause: cause?.code ?? null });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || normalizedPath(real) !== normalizedPath(target)) {
    stageError("M64_STAGE_PATH_REPARSE", `${label} must be a plain directory without a symlink or junction`);
  }
  return target;
}

function assertPlainAncestors(path, label) {
  const target = resolve(path);
  const volumeRoot = parse(target).root;
  let cursor = dirname(target);
  while (cursor && cursor !== volumeRoot) {
    assertPlainDirectory(cursor, `${label} ancestor`);
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
}

function readPlainBytes(path, label) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    stageError("M64_STAGE_PATH_INVALID", `${label} path must be absolute`);
  }
  const target = resolve(path);
  assertPlainAncestors(target, label);
  let fd;
  try {
    const before = lstatSync(target, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size < 2n || before.size > BigInt(MAX_JSON_BYTES)
      || normalizedPath(realpathSync(target)) !== normalizedPath(target)) {
      stageError("M64_STAGE_PATH_INVALID", `${label} must be one bounded single-link plain file`);
    }
    fd = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const descriptor = fstatSync(fd, { bigint: true });
    const bytes = readFileSync(fd);
    const after = lstatSync(target, { bigint: true });
    if (!sameIdentity(before, descriptor) || !sameIdentity(descriptor, after)
      || after.size !== BigInt(bytes.length) || after.isSymbolicLink()) {
      stageError("M64_STAGE_PATH_RACE", `${label} changed while it was read`);
    }
    return bytes;
  } catch (cause) {
    if (cause?.code?.startsWith?.("M64_STAGE_")) throw cause;
    stageError("M64_STAGE_PATH_UNAVAILABLE", `${label} cannot be read`, { cause: cause?.code ?? null });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertPlainFilePath(path, label) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    stageError("M64_STAGE_PATH_INVALID", `${label} path must be absolute`);
  }
  const target = resolve(path);
  assertPlainAncestors(target, label);
  let stat;
  try {
    stat = lstatSync(target, { bigint: true });
  } catch (cause) {
    stageError("M64_STAGE_PATH_UNAVAILABLE", `${label} is unavailable`, { cause: cause?.code ?? null });
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
    || normalizedPath(realpathSync(target)) !== normalizedPath(target)) {
    stageError("M64_STAGE_PATH_INVALID", `${label} must be one single-link plain file`);
  }
  return target;
}

function readPlainJson(path, label) {
  const bytes = readPlainBytes(path, label);
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    stageError("M64_STAGE_JSON_INVALID", `${label} is malformed JSON`);
  }
}

function assertHash(value, label) {
  if (!HASH.test(value ?? "") || /^0{64}$/u.test(value)) {
    stageError("M64_STAGE_BINDING_INVALID", `${label} must be a nonzero SHA-256 hash`);
  }
}

function publicArm(row) {
  if (!row) return null;
  const iso = (value) => value === null || value === undefined ? null : new Date(Number(value)).toISOString();
  return Object.freeze({
    schemaId: "xw.m6-gate-safety-close-arm.v1",
    gateId: row.gate_id,
    purpose: row.purpose,
    activeEpochHash: row.active_epoch_hash,
    closeEpochHash: row.close_epoch_hash,
    packageHash: row.package_hash,
    activationProofHash: row.activation_proof_hash,
    proofHash: row.proof_hash,
    reasonCode: row.reason_code,
    expiresAt: iso(row.expires_at),
    authorizationExpiresAt: iso(row.authorization_expires_at),
    packageExpiresAt: iso(row.package_expires_at),
    package: JSON.parse(row.package_json),
    armedGeneration: Number(row.armed_generation),
    status: row.status,
    armedAt: iso(row.armed_at),
    terminalEpochHash: row.terminal_epoch_hash ?? null,
    terminalProofHash: row.terminal_proof_hash ?? null,
    terminalizedAt: iso(row.terminalized_at),
  });
}

export function openM64ReadOnlyGateState({ dbPath, nowMs = Date.now() } = {}) {
  if (!Number.isFinite(nowMs)) stageError("M64_STAGE_CLOCK_INVALID", "stage verifier requires a finite clock");
  const target = resolve(dbPath ?? "");
  assertPlainFilePath(target, "control-plane database");
  const openedIdentity = lstatSync(target, { bigint: true });
  let db;
  try {
    db = new DatabaseSync(target, { readOnly: true });
    const version = Number(db.prepare("PRAGMA user_version").get().user_version);
    if (version !== CURRENT_CONTROL_SCHEMA_VERSION) {
      stageError(
        "M64_STAGE_DB_SCHEMA_INVALID",
        "stage verifier requires the exact current control-plane database schema",
        { version, expectedVersion: CURRENT_CONTROL_SCHEMA_VERSION },
      );
    }
  } catch (cause) {
    try { db?.close(); } catch {}
    if (cause?.code?.startsWith?.("M64_STAGE_")) throw cause;
    stageError("M64_STAGE_DB_UNAVAILABLE", "control-plane database cannot be opened read-only", { cause: cause?.code ?? null });
  }
  const count = (sql, ...params) => Number(db.prepare(sql).get(...params).count);
  return Object.freeze({
    now: () => nowMs,
    m6RuntimeMode: "FINAL",
    getM6GateFence() {
      const row = db.prepare("SELECT * FROM m6_gate_fence WHERE marker='M6'").get();
      return row ? {
        gateId: row.gate_id,
        epochHash: row.epoch_hash,
        generation: Number(row.generation),
        mode: row.mode,
        purpose: row.purpose,
        allowlist: JSON.parse(row.allowlist_json),
        expiresAt: row.expires_at,
        releaseId: row.release_id,
        sourceCommit: row.source_commit,
        locksHash: row.locks_hash,
        updatedAt: new Date(Number(row.updated_at)).toISOString(),
      } : null;
    },
    getM6GateFResourceCounts() {
      return Object.freeze({
        jobs: count("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued','waiting_approval','running','verifying','restoring')"),
        sessions: count("SELECT COUNT(*) AS count FROM sessions WHERE expires_at>?", nowMs),
        leases: count("SELECT COUNT(*) AS count FROM leases WHERE expires_at>?", nowMs),
        actionCount: count("SELECT COUNT(*) AS count FROM device_session_actions WHERE execution_mode='m6-grounded-live-v2' AND status IN ('ASSESSED','EXECUTING','EXECUTED')"),
      });
    },
    getM6GateSafetyCloseArm(activeEpochHash) {
      return publicArm(db.prepare("SELECT * FROM m6_gate_safety_close_arms WHERE active_epoch_hash=?").get(activeEpochHash));
    },
    getM6GateSafetyCloseArmByTerminalEpoch(terminalEpochHash) {
      return publicArm(db.prepare("SELECT * FROM m6_gate_safety_close_arms WHERE terminal_epoch_hash=?").get(terminalEpochHash));
    },
    getM64LiveWindowAuthorizationConsumption(authorizationId) {
      const row = db.prepare("SELECT consumption_receipt_json FROM m6_live_window_authorization_consumptions WHERE authorization_id=?").get(authorizationId);
      return row ? JSON.parse(row.consumption_receipt_json) : null;
    },
    getM6EmergencyCloseConsumption(nonce) {
      const row = db.prepare("SELECT * FROM m6_emergency_close_consumptions WHERE nonce=?").get(nonce);
      return row ? {
        nonce: row.nonce,
        authorizationHash: row.authorization_hash,
        reasonCode: row.reason_code,
        consumedAt: new Date(Number(row.consumed_at)).toISOString(),
      } : null;
    },
    assertUnchanged() {
      let currentIdentity;
      try { currentIdentity = lstatSync(target, { bigint: true }); } catch (cause) {
        stageError("M64_STAGE_DB_CHANGED", "control-plane database disappeared during staging", { cause: cause?.code ?? null });
      }
      if (!sameIdentity(openedIdentity, currentIdentity)
        || currentIdentity.isSymbolicLink() || currentIdentity.nlink !== 1n
        || normalizedPath(realpathSync(target)) !== normalizedPath(target)) {
        stageError("M64_STAGE_DB_CHANGED", "control-plane database identity changed during staging");
      }
      return true;
    },
    close() { db.close(); },
  });
}

function validateFinalBinding({ bindingPath, runtimeSnapshotPath, gateIssuerAllowlistPath, liveIssuerAllowlistPath }) {
  const bindingRecord = readPlainJson(bindingPath, "FINAL runtime binding");
  const binding = bindingRecord.value;
  if (!exactObject(binding, M64_FINAL_RUNTIME_BINDING_FIELDS)
    || binding.schemaId !== FINAL_BINDING_SCHEMA || !ID.test(binding.releaseId ?? "")
    || !COMMIT.test(binding.sourceCommit ?? "") || !ID.test(binding.gateId ?? "")) {
    stageError("M64_STAGE_FINAL_BINDING_INVALID", "FINAL runtime binding must contain the exact 25-key production shape");
  }
  for (const field of [
    "releaseManifestSha256", "dependencyLayerHash", "modelProfileHash",
    "gateFArtifactCatalogHash", "gateFArtifactCatalogSha256",
    "targetEnvironmentAttestationHash", "environmentQualificationSha256",
    "productionDependencyBindingHash",
  ]) assertHash(binding[field], `FINAL binding ${field}`);
  const pathFields = [
    "sourceReleaseRoot", "dependencyRoot", "modelProfileRoot", "manifestRoot", "runtimeSnapshotPath",
    "dshPersistenceRoot", "gateIssuerAllowlistPath", "liveAuthorizationIssuerAllowlistPath",
    "gateFArtifactCatalogPath", "targetEnvironmentAttestationPath", "environmentQualificationPath",
    "productionDependencyBindingPath",
  ];
  if (pathFields.some((field) => typeof binding[field] !== "string" || !isAbsolute(binding[field]))) {
    stageError("M64_STAGE_FINAL_BINDING_INVALID", "FINAL runtime binding contains a non-absolute production path");
  }
  const bindingTarget = resolve(bindingPath);
  if (basename(bindingTarget).toLowerCase() !== FINAL_BINDING_FILE
    || basename(dirname(bindingTarget)).toLowerCase() !== "config") {
    stageError("M64_STAGE_FINAL_BINDING_PATH_INVALID", "FINAL binding must be runtimeRoot/config/m6-c1-runtime.v1.json");
  }
  const runtimeRoot = resolve(bindingTarget, "..", "..");
  if (!samePath(binding.runtimeSnapshotPath, runtimeSnapshotPath)
    || !samePath(binding.gateIssuerAllowlistPath, gateIssuerAllowlistPath)
    || !samePath(binding.liveAuthorizationIssuerAllowlistPath, liveIssuerAllowlistPath)) {
    stageError("M64_STAGE_FINAL_BINDING_REBOUND", "stage inputs must match the exact paths sealed by the FINAL binding");
  }
  if (!within(join(runtimeRoot, "state"), binding.runtimeSnapshotPath)
    || within(binding.sourceReleaseRoot, binding.runtimeSnapshotPath)
    || samePath(binding.runtimeSnapshotPath, join(runtimeRoot, "state"))) {
    stageError("M64_STAGE_SNAPSHOT_PATH_ESCAPE", "runtime snapshot must remain in mutable runtime state and outside the release");
  }
  assertPlainDirectory(runtimeRoot, "runtime root");
  assertPlainDirectory(join(runtimeRoot, "state"), "runtime state root");
  assertPlainDirectory(dirname(binding.runtimeSnapshotPath), "runtime snapshot parent");
  assertPlainDirectory(binding.sourceReleaseRoot, "source release root");
  for (const field of ["dependencyRoot", "modelProfileRoot", "manifestRoot", "dshPersistenceRoot"]) {
    assertPlainDirectory(binding[field], field);
  }

  const manifestPath = join(binding.sourceReleaseRoot, "release-manifest.v1.json");
  const manifestRecord = readPlainJson(manifestPath, "release manifest");
  if (sha256(manifestRecord.bytes) !== binding.releaseManifestSha256
    || manifestRecord.value?.releaseId !== binding.releaseId
    || manifestRecord.value?.sourceCommit !== binding.sourceCommit) {
    stageError("M64_STAGE_RELEASE_BINDING_INVALID", "FINAL binding does not identify the exact release manifest");
  }
  const releaseVerification = verifyReleaseManifest({ manifestPath, root: binding.sourceReleaseRoot });
  if (!releaseVerification.ok) {
    stageError("M64_STAGE_RELEASE_INVALID", "deployed release verification failed", { mismatches: releaseVerification.mismatches });
  }
  const catalogRecord = readPlainJson(binding.gateFArtifactCatalogPath, "Gate F artifact catalog");
  if (sha256(catalogRecord.bytes) !== binding.gateFArtifactCatalogSha256) {
    stageError("M64_STAGE_CATALOG_RAW_HASH_MISMATCH", "Gate F catalog bytes differ from the FINAL binding");
  }
  const catalog = loadM6GateFArtifactCatalog({
    path: binding.gateFArtifactCatalogPath,
    expectedHash: binding.gateFArtifactCatalogHash,
    expectedReleaseRoot: binding.sourceReleaseRoot,
    expectedReleaseManifestPath: manifestPath,
  });
  if (catalog.release.releaseId !== binding.releaseId || catalog.release.sourceCommit !== binding.sourceCommit) {
    stageError("M64_STAGE_CATALOG_RELEASE_MISMATCH", "Gate F catalog crosses the FINAL release boundary");
  }
  const qualificationBytes = readPlainBytes(binding.environmentQualificationPath, "environment qualification");
  const dependencyBindingBytes = readPlainBytes(binding.productionDependencyBindingPath, "production dependency binding");
  if (sha256(qualificationBytes) !== binding.environmentQualificationSha256
    || sha256(dependencyBindingBytes) !== binding.productionDependencyBindingHash) {
    stageError("M64_STAGE_FINAL_BINDING_HASH_MISMATCH", "FINAL external dependency bytes differ from their binding hashes");
  }
  readPlainJson(binding.targetEnvironmentAttestationPath, "target environment attestation");
  readPlainJson(binding.gateIssuerAllowlistPath, "gate issuer allowlist");
  readPlainJson(binding.liveAuthorizationIssuerAllowlistPath, "live-window issuer allowlist");
  const layer = readPlainJson(join(binding.dependencyRoot, "m6-live-runtime-dependency-layer.v1.json"), "runtime dependency layer").value;
  if (layer?.schemaId !== "xw.m6-live-runtime-dependency-layer.v1"
    || layer.layerHash !== binding.dependencyLayerHash
    || layer.sourceRelease?.releaseId !== binding.releaseId
    || layer.sourceRelease?.sourceCommit !== binding.sourceCommit
    || layer.sourceRelease?.manifestSha256 !== binding.releaseManifestSha256) {
    stageError("M64_STAGE_DEPENDENCY_LAYER_MISMATCH", "runtime dependency layer is rebound from the FINAL release");
  }
  return Object.freeze({
    binding,
    bindingSha256: sha256(bindingRecord.bytes),
    catalog,
    manifestPath,
    runtimeRoot,
  });
}

function assertCandidateSequence({ loaded, fence, candidate, authorization, binding }) {
  assertM6FileDbPointerConsistency({ loaded, fence, pointer: loaded.currentPointer });
  const tail = loaded.chain.at(-1);
  if (!tail || tail.mode !== "CLOSED" || tail.status !== "closed" || fence.mode !== "CLOSED"
    || candidate.operation !== "ACTIVATE" || !candidate.safetyClosePackage) {
    stageError("M64_STAGE_CURRENT_GATE_NOT_CLOSED", "stage-window requires one exact CLOSED triple and an activation package with safety close");
  }
  const completed = loaded.chain.filter((epoch) => epoch.schemaId === "xw.m6-live-gate.v2" && epoch.mode !== "CLOSED");
  const completedPurposes = completed.map((epoch) => epoch.purpose);
  const expectedPrefix = M6_GATE_F_ARTIFACT_CATALOG_PURPOSES.slice(0, completedPurposes.length);
  if (canonicalJson(completedPurposes) !== canonicalJson(expectedPrefix)
    || completedPurposes.length >= M6_GATE_F_ARTIFACT_CATALOG_PURPOSES.length) {
    stageError("M64_STAGE_WINDOW_ORDER_INVALID", "verified gate history is not a strict prefix of the five-window order");
  }
  const expectedPurpose = M6_GATE_F_ARTIFACT_CATALOG_PURPOSES[completedPurposes.length];
  const expectedPhase = expectedPurpose === "M6_4_SHADOW" ? "GROUNDING_ONLY" : "GROUNDED_ACTION";
  const expectedMode = expectedPhase === "GROUNDING_ONLY" ? "OBSERVE_ONLY" : "GROUNDED_ACTION";
  if (candidate.phase !== expectedPhase || candidate.epoch?.purpose !== expectedPurpose
    || candidate.epoch?.mode !== expectedMode || authorization.purpose !== expectedPurpose) {
    stageError("M64_STAGE_WINDOW_ORDER_INVALID", `next live window must be ${expectedPurpose}/${expectedPhase}`);
  }
  if (candidate.epoch.parentEpochHash !== tail.epochHash
    || authorization.gateGeneration !== fence.generation + 1
    || authorization.gateEpochHash !== candidate.epoch.epochHash) {
    stageError("M64_STAGE_GENERATION_INVALID", "candidate parent, epoch, or generation does not append to the current CLOSED triple");
  }
  if (candidate.epoch.gateId !== binding.gateId || candidate.epoch.gateId !== fence.gateId
    || candidate.epoch.releaseId !== binding.releaseId || candidate.epoch.sourceCommit !== binding.sourceCommit
    || authorization.gateId !== binding.gateId || authorization.releaseId !== binding.releaseId
    || authorization.sourceCommit !== binding.sourceCommit || authorization.releaseHash !== binding.releaseManifestSha256
    || authorization.alias !== "01" || canonicalJson(candidate.epoch.allowlist) !== canonicalJson(["01"])
    || authorization.effectBoundary !== "BOUNDED_READ_TRACE") {
    stageError("M64_STAGE_RUNTIME_BINDING_MISMATCH", "candidate is rebound from alias 01, FINAL release, Gate, or effect boundary");
  }
  return Object.freeze({ expectedPurpose, tail });
}

function validateSelectedInventory({ catalog, loaded, candidate, authorization, binding, manifestPath }) {
  const lockSet = loaded.lockSets?.[candidate.epoch.lockSetRef?.id] ?? null;
  const inventory = selectM6GateFArtifactInventory({
    catalog,
    authorization,
    epoch: candidate.epoch,
    lockSet,
    expectedReleaseRoot: binding.sourceReleaseRoot,
    expectedReleaseManifestPath: manifestPath,
  });
  if (!samePath(inventory.lockArtifacts.modelProfile.path, binding.modelProfileRoot)
    || !within(binding.manifestRoot, inventory.lockArtifacts.scenarioManifest.path)
    || !samePath(inventory.lockArtifacts.environmentQualification.path, binding.environmentQualificationPath)
    || !samePath(inventory.runtimeArtifacts.environmentAttestation.path, binding.targetEnvironmentAttestationPath)
    || authorization.modelProfileHash !== binding.modelProfileHash
    || authorization.environmentAttestationHash !== binding.targetEnvironmentAttestationHash) {
    stageError("M64_STAGE_INVENTORY_BINDING_MISMATCH", "selected inventory is rebound from the FINAL model, manifest, or environment paths");
  }
  return inventory;
}

function ensureChildDirectory(parent, name) {
  const root = assertPlainDirectory(parent, "stage history parent");
  const child = join(root, name);
  try { mkdirSync(child, { mode: 0o700 }); } catch (cause) {
    if (cause?.code !== "EEXIST") stageError("M64_STAGE_WRITE_FAILED", `cannot create ${name}`, { cause: cause?.code ?? null });
  }
  const verified = assertPlainDirectory(child, name);
  syncDirectory(root);
  return verified;
}

function syncDirectory(path) {
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY);
    fsyncSync(fd);
  } catch (cause) {
    // Windows does not permit fsync on directory handles opened through the
    // ordinary file API. The file itself is still fsynced before publication.
    if (process.platform !== "win32") {
      stageError("M64_STAGE_WRITE_FAILED", "stage directory fsync failed", { cause: cause?.code ?? null });
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function mapStagePublicationError(error, { collisionCode, collisionMessage, label }) {
  if (!(error instanceof RecoverablePublicationError)) throw error;
  if (error.reason === "TARGET_DIFFERENT") {
    stageError(collisionCode, collisionMessage);
  }
  if (/^(?:PARENT|TARGET|PENDING)_(?:UNSAFE|EXTERNAL_HARDLINK|RACE)$/u.test(error.reason)) {
    stageError("M64_STAGE_PATH_INVALID", `${label} publication topology is unsafe`, { reason: error.reason });
  }
  stageError("M64_STAGE_WRITE_FAILED", `${label} recoverable create-only publication failed`, {
    reason: error.reason,
    cause: error.causeCode,
  });
}

function immutableWrite(path, bytes, { faultAfter = () => {}, label = "immutable stage artifact" } = {}) {
  const target = resolve(path);
  try {
    return publishRecoverableCreateOnly({ targetPath: target, bytes, faultAfter }).created;
  } catch (error) {
    mapStagePublicationError(error, {
      collisionCode: "M64_STAGE_IMMUTABLE_COLLISION",
      collisionMessage: "immutable stage artifact address contains different bytes",
      label,
    });
  }
}

function atomicCreate(path, bytes, { faultAfter = () => {}, label = "stable runtime snapshot" } = {}) {
  const target = resolve(path);
  try {
    return publishRecoverableCreateOnly({ targetPath: target, bytes, faultAfter }).created;
  } catch (error) {
    mapStagePublicationError(error, {
      collisionCode: "M64_STAGE_STABLE_SNAPSHOT_EXISTS",
      collisionMessage: "stable runtime snapshot already exists with different bytes",
      label,
    });
  }
}

function recoverStagePublicationBytes(path, label) {
  try {
    return recoverPublishedCreateOnlyBytes({ targetPath: path }).bytes;
  } catch (error) {
    mapStagePublicationError(error, {
      collisionCode: "M64_STAGE_IMMUTABLE_COLLISION",
      collisionMessage: `${label} contains different bytes`,
      label,
    });
  }
}

function recoverStagePublicationJson(path, label) {
  const bytes = recoverStagePublicationBytes(path, label);
  try { return { bytes, value: JSON.parse(bytes.toString("utf8")) }; } catch {
    stageError("M64_STAGE_JSON_INVALID", `${label} is malformed JSON`);
  }
}

function receiptWithHash(schemaId, body) {
  const receiptHash = sha256(`${schemaId}:${canonicalJson(body)}`);
  return Object.freeze({ ...body, receiptHash });
}

function verifiedReceipts(receiptsRoot) {
  if (!existsSync(receiptsRoot)) return [];
  const names = readdirSync(receiptsRoot).filter((name) => name.endsWith(".json")).sort();
  if (names.length > 1024) stageError("M64_STAGE_JOURNAL_INVALID", "stage receipt journal exceeds its bounded cardinality");
  return names.map((name) => {
    const value = recoverStagePublicationJson(join(receiptsRoot, name), "stage receipt").value;
    const { receiptHash, ...body } = value ?? {};
    if (!HASH.test(receiptHash ?? "") || receiptHash !== sha256(`${value?.schemaId}:${canonicalJson(body)}`)
      || name !== `${receiptHash}.json`) {
      stageError("M64_STAGE_JOURNAL_INVALID", "stage receipt is not self-addressed");
    }
    return value;
  });
}

function findStageReceipt(receipts, runtimeSnapshotSha256) {
  const matches = receipts.filter((receipt) => receipt.schemaId === "xw.m6-4-live-window-stage-receipt.v1"
    && receipt.runtimeSnapshotSha256 === runtimeSnapshotSha256);
  if (matches.length > 1) stageError("M64_STAGE_JOURNAL_INVALID", "runtime snapshot has duplicate stage receipts");
  return matches[0] ?? null;
}

function assertPriorSnapshotTerminalized({ prior, priorSha256, receipts, loaded, fence }) {
  if (!exactObject(prior, M64_LIVE_WINDOW_RUNTIME_BINDING_FIELDS)
    || !findStageReceipt(receipts, priorSha256)) {
    stageError("M64_STAGE_STALE_SNAPSHOT", "different stable snapshot has no verified append-only stage receipt");
  }
  const active = loaded.chain.at(-2);
  const closed = loaded.chain.at(-1);
  if (fence.generation !== prior.gateGeneration + 1
    || active?.epochHash !== prior.gateEpochHash || active?.mode === "CLOSED"
    || closed?.mode !== "CLOSED" || closed?.parentEpochHash !== prior.gateEpochHash
    || closed?.purpose !== prior.purpose || fence.epochHash !== closed.epochHash) {
    stageError("M64_STAGE_STALE_SNAPSHOT", "different stable snapshot is not the immediately terminalized prior live window");
  }
  return closed;
}

export async function acquireM64StoppedControlPlaneGuard({
  runtimeRoot,
  host = "127.0.0.1",
  port = 17920,
} = {}) {
  try {
    return await acquireM6C1StoppedRuntimeGuard({
      runtimeRoot,
      ownerKind: "STAGE_LIVE_WINDOW",
      host,
      port,
    });
  } catch (cause) {
    const code = cause?.code === "M6_C1_RUNTIME_NOT_STOPPED"
      ? "M64_STAGE_CONTROL_PLANE_NOT_STOPPED"
      : "M64_STAGE_CONCURRENT_STAGER";
    stageError(code, "M6-C1 runtime is active, concurrently owned, or blocked by a stale crash lock", { cause: cause?.code ?? null });
  }
}

function persistStage({
  runtime,
  binding,
  authorization,
  candidate,
  catalog,
  preflight,
  loaded,
  fence,
  nowMs,
  publicationFaultAfter = () => {},
}) {
  const publicationCut = (label) => (point, context) => {
    publicationFaultAfter(`publication:${label}:${point}`, context);
  };
  const snapshotBytes = jsonBytes(runtime);
  const snapshotSha256 = sha256(snapshotBytes);
  const stablePath = resolve(binding.runtimeSnapshotPath);
  const historyRoot = ensureChildDirectory(dirname(stablePath), HISTORY_DIRECTORY);
  const contentRoot = ensureChildDirectory(historyRoot, "content");
  const receiptsRoot = ensureChildDirectory(historyRoot, "receipts");
  const intentsRoot = ensureChildDirectory(historyRoot, "intents");
  const tombstonesRoot = ensureChildDirectory(historyRoot, "tombstones");
  const contentPath = join(contentRoot, `${snapshotSha256}.json`);
  immutableWrite(contentPath, snapshotBytes, {
    label: "runtime snapshot content",
    faultAfter: publicationCut("content"),
  });
  const receipts = verifiedReceipts(receiptsRoot);
  const intents = verifiedReceipts(intentsRoot);
  const priorStageReceipt = findStageReceipt(receipts, snapshotSha256);
  const preflightHash = sha256(`xw.m6-gate-f-promotion-preflight.v1:${canonicalJson(preflight)}`);
  const stageBody = {
    schemaId: "xw.m6-4-live-window-stage-receipt.v1",
    releaseId: binding.releaseId,
    sourceCommit: binding.sourceCommit,
    gateId: binding.gateId,
    currentClosedEpochHash: fence.epochHash,
    currentGeneration: fence.generation,
    candidateEpochHash: candidate.epoch.epochHash,
    candidateGeneration: authorization.gateGeneration,
    purpose: authorization.purpose,
    authorizationEnvelopeHash: authorization.envelopeHash,
    artifactCatalogHash: catalog.catalogHash,
    artifactInventoryHash: preflight.artifactInventoryHash,
    runtimeSnapshotSha256: snapshotSha256,
    preflightHash,
    stagedAt: authorization.issuedAt,
    secretMaterialPresent: false,
  };
  const receipt = receiptWithHash(stageBody.schemaId, stageBody);
  if (priorStageReceipt && canonicalJson(priorStageReceipt) !== canonicalJson(receipt)) {
    stageError(
      "M64_STAGE_REPLAY_AUTHORIZATION_MISMATCH",
      "existing runtime snapshot receipt is not bound to this exact authorization/candidate/preflight",
    );
  }
  let rotated = false;

  if (existsSync(stablePath)) {
    const stableRecord = recoverStagePublicationJson(stablePath, "stable runtime snapshot");
    const stableSha256 = sha256(stableRecord.bytes);
    if (stableRecord.bytes.equals(snapshotBytes)) {
      if (priorStageReceipt) return Object.freeze({ receipt: priorStageReceipt, replay: true, rotated: false });
      // A crash may occur after the stable write and before the receipt write.
    } else {
      const terminal = assertPriorSnapshotTerminalized({
        prior: stableRecord.value,
        priorSha256: stableSha256,
        receipts,
        loaded,
        fence,
      });
      const terminalBody = {
        schemaId: "xw.m6-4-live-window-terminalization-receipt.v1",
        priorRuntimeSnapshotSha256: stableSha256,
        priorGateEpochHash: stableRecord.value.gateEpochHash,
        priorGateGeneration: stableRecord.value.gateGeneration,
        purpose: stableRecord.value.purpose,
        terminalEpochHash: terminal.epochHash,
        terminalGeneration: fence.generation,
        observedAt: terminal.issuedAt,
        secretMaterialPresent: false,
      };
      const terminalReceipt = receiptWithHash(terminalBody.schemaId, terminalBody);
      immutableWrite(join(receiptsRoot, `${terminalReceipt.receiptHash}.json`), jsonBytes(terminalReceipt), {
        label: "terminalization receipt",
        faultAfter: publicationCut("terminalization-receipt"),
      });
      const intentBody = {
        schemaId: "xw.m6-4-live-window-stage-intent.v1",
        priorRuntimeSnapshotSha256: stableSha256,
        runtimeSnapshotSha256: snapshotSha256,
        currentClosedEpochHash: fence.epochHash,
        currentGeneration: fence.generation,
        candidateEpochHash: candidate.epoch.epochHash,
        candidateGeneration: authorization.gateGeneration,
        purpose: authorization.purpose,
        terminalizationReceiptHash: terminalReceipt.receiptHash,
        secretMaterialPresent: false,
      };
      const intent = receiptWithHash(intentBody.schemaId, intentBody);
      immutableWrite(join(intentsRoot, `${intent.receiptHash}.json`), jsonBytes(intent), {
        label: "stage intent",
        faultAfter: publicationCut("intent"),
      });
      publicationFaultAfter("intent");
      const tombstonePath = join(tombstonesRoot, `${stableSha256}.${terminal.epochHash}.json`);
      const latestStable = recoverStagePublicationJson(stablePath, "stable runtime snapshot before rotation");
      if (latestStable.bytes.equals(snapshotBytes)) {
        // Another identical stager completed the atomic switch after our
        // preflight. Its append-only artifacts are the same deterministic bytes.
        rotated = true;
      } else {
        if (!latestStable.bytes.equals(stableRecord.bytes) || existsSync(tombstonePath)) {
          stageError("M64_STAGE_CONCURRENT_UPDATE", "stable runtime snapshot changed during audited rotation");
        }
        renameSync(stablePath, tombstonePath);
        syncDirectory(dirname(stablePath));
        syncDirectory(tombstonesRoot);
        publicationFaultAfter("tombstone");
        if (!readPlainBytes(tombstonePath, "runtime snapshot tombstone").equals(stableRecord.bytes)) {
          stageError("M64_STAGE_WRITE_FAILED", "runtime snapshot tombstone changed during rotation");
        }
        atomicCreate(stablePath, snapshotBytes, {
          label: "stable runtime snapshot",
          faultAfter: publicationCut("stable"),
        });
        publicationFaultAfter("stable");
        rotated = true;
      }
    }
  } else {
    const priorStageReceipts = receipts.filter((receipt) => receipt.schemaId === "xw.m6-4-live-window-stage-receipt.v1");
    if (priorStageReceipts.length > 0) {
      const matchingIntents = intents.filter((intent) => intent.schemaId === "xw.m6-4-live-window-stage-intent.v1"
        && intent.runtimeSnapshotSha256 === snapshotSha256
        && HASH.test(intent.priorRuntimeSnapshotSha256 ?? "")
        && intent.currentClosedEpochHash === fence.epochHash
        && intent.currentGeneration === fence.generation
        && intent.candidateEpochHash === candidate.epoch.epochHash
        && intent.candidateGeneration === authorization.gateGeneration
        && intent.purpose === authorization.purpose);
      if (matchingIntents.length !== 1) {
        stageError("M64_STAGE_STALE_SNAPSHOT", "missing stable snapshot has no unique crash-recovery intent");
      }
      const intent = matchingIntents[0];
      const tombstonePath = join(tombstonesRoot, `${intent.priorRuntimeSnapshotSha256}.${fence.epochHash}.json`);
      const tombstone = readPlainJson(tombstonePath, "runtime snapshot tombstone");
      if (sha256(tombstone.bytes) !== intent.priorRuntimeSnapshotSha256
        || !receipts.some((receipt) => receipt.receiptHash === intent.terminalizationReceiptHash)) {
        stageError("M64_STAGE_STALE_SNAPSHOT", "crash-recovery intent is missing its prior tombstone or terminalization receipt");
      }
      assertPriorSnapshotTerminalized({
        prior: tombstone.value,
        priorSha256: intent.priorRuntimeSnapshotSha256,
        receipts,
        loaded,
        fence,
      });
      atomicCreate(stablePath, snapshotBytes, {
        label: "stable runtime snapshot",
        faultAfter: publicationCut("stable"),
      });
      publicationFaultAfter("stable");
      rotated = true;
    } else {
      const intentBody = {
        schemaId: "xw.m6-4-live-window-stage-intent.v1",
        priorRuntimeSnapshotSha256: null,
        runtimeSnapshotSha256: snapshotSha256,
        currentClosedEpochHash: fence.epochHash,
        currentGeneration: fence.generation,
        candidateEpochHash: candidate.epoch.epochHash,
        candidateGeneration: authorization.gateGeneration,
        purpose: authorization.purpose,
        terminalizationReceiptHash: null,
        secretMaterialPresent: false,
      };
      const intent = receiptWithHash(intentBody.schemaId, intentBody);
      immutableWrite(join(intentsRoot, `${intent.receiptHash}.json`), jsonBytes(intent), {
        label: "stage intent",
        faultAfter: publicationCut("intent"),
      });
      publicationFaultAfter("intent");
      atomicCreate(stablePath, snapshotBytes, {
        label: "stable runtime snapshot",
        faultAfter: publicationCut("stable"),
      });
      publicationFaultAfter("stable");
    }
  }

  immutableWrite(join(receiptsRoot, `${receipt.receiptHash}.json`), jsonBytes(receipt), {
    label: "stage receipt",
    faultAfter: publicationCut("stage-receipt"),
  });
  return Object.freeze({ receipt, replay: false, rotated });
}

export async function stageM64LiveWindow({
  finalBindingPath,
  authorizationPath,
  candidateActivationPackagePath,
  gateIssuerAllowlistPath,
  liveIssuerAllowlistPath,
  runtimeSnapshotPath,
  execute = false,
  nowMs = Date.now(),
} = {}, {
  operationsFactory = createM6GateFOperations,
  openReadOnlyState = openM64ReadOnlyGateState,
  acquireStoppedGuard = acquireM64StoppedControlPlaneGuard,
  publicationFaultAfter = () => {},
} = {}) {
  if (!Number.isFinite(nowMs)) stageError("M64_STAGE_CLOCK_INVALID", "stage verifier requires a finite clock");
  const inputPaths = {
    finalBindingPath,
    authorizationPath,
    candidateActivationPackagePath,
    gateIssuerAllowlistPath,
    liveIssuerAllowlistPath,
    runtimeSnapshotPath,
  };
  if (Object.values(inputPaths).some((value) => typeof value !== "string" || !isAbsolute(value))) {
    stageError("M64_STAGE_ARGUMENT_INVALID", "all stage-window paths must be explicit absolute paths");
  }
  const final = validateFinalBinding({
    bindingPath: finalBindingPath,
    runtimeSnapshotPath,
    gateIssuerAllowlistPath,
    liveIssuerAllowlistPath,
  });
  const authorizationRecord = readPlainJson(authorizationPath, "owner live-window authorization");
  const candidateRecord = readPlainJson(candidateActivationPackagePath, "candidate activation package");
  const authorization = authorizationRecord.value;
  const candidate = candidateRecord.value;
  if (!candidate || canonicalJson(candidate.authorization) !== canonicalJson(authorization)) {
    stageError("M64_STAGE_AUTHORIZATION_REBOUND", "candidate package must embed the exact externally supplied owner authorization");
  }
  const dbPath = join(final.runtimeRoot, "state", "control-plane", "control.db");
  let guard = null;
  let state = null;
  let primaryError = null;
  let stateCleanupProven = true;
  try {
    if (execute) {
      guard = await acquireStoppedGuard({ runtimeRoot: final.runtimeRoot });
      if (!guard || typeof guard.assertOwned !== "function" || typeof guard.release !== "function"
        || typeof guard.retainStaleLock !== "function") {
        stageError("M64_STAGE_OWNER_GUARD_INVALID", "stage-window requires a held shared M6-C1 runtime owner guard");
      }
      await guard.assertOwned();
    }
    if (execute) stateCleanupProven = false;
    state = openReadOnlyState({ dbPath, nowMs });
    const loaded = loadM6Gate({
      m6Root: final.runtimeRoot,
      gateId: final.binding.gateId,
      issuerAllowlistPath: final.binding.gateIssuerAllowlistPath,
      requireLocks: true,
    });
    const fence = state.getM6GateFence();
    const sequence = assertCandidateSequence({ loaded, fence, candidate, authorization, binding: final.binding });
    validateSelectedInventory({
      catalog: final.catalog,
      loaded,
      candidate,
      authorization,
      binding: final.binding,
      manifestPath: final.manifestPath,
    });
    const operations = operationsFactory({
      state,
      config: {
        runtimeMode: "FINAL",
        internalToken: INTERNAL_PREFLIGHT_TOKEN,
        m6Root: final.runtimeRoot,
        gateId: final.binding.gateId,
        issuerAllowlistPath: final.binding.gateIssuerAllowlistPath,
        liveWindowIssuerAllowlistPath: final.binding.liveAuthorizationIssuerAllowlistPath,
        artifactCatalogPath: final.binding.gateFArtifactCatalogPath,
        artifactCatalogHash: final.binding.gateFArtifactCatalogHash,
        sourceReleaseRoot: final.binding.sourceReleaseRoot,
        sourceReleaseManifestPath: final.manifestPath,
      },
      now: () => nowMs,
      activeRunCount: () => 0,
      faultAfterForOperation: () => stageError("M64_STAGE_MUTATION_FORBIDDEN", "stage-window must never request Gate mutation"),
    });
    if (!operations || typeof operations.preflight !== "function") {
      stageError("M64_STAGE_VERIFIER_UNAVAILABLE", "production Gate F preflight verifier is unavailable");
    }
    const preflight = operations.preflight(candidate);
    if (preflight?.status !== "SEALED_PREFLIGHT"
      || preflight.operation !== "ACTIVATE"
      || preflight.candidateEpochHash !== candidate.epoch.epochHash
      || preflight.expectedGeneration !== authorization.gateGeneration
      || preflight.purpose !== sequence.expectedPurpose
      || preflight.artifactCatalogHash !== final.catalog.catalogHash) {
      stageError("M64_STAGE_PREFLIGHT_MISMATCH", "production Gate F preflight did not return the exact candidate identity");
    }
    const runtime = Object.freeze(selectM64LiveWindowRuntimeBinding(authorization));
    if (!exactObject(runtime, M64_LIVE_WINDOW_RUNTIME_BINDING_FIELDS)) {
      stageError("M64_STAGE_RUNTIME_BINDING_INVALID", "owner authorization did not select the exact 23-field runtime binding");
    }
    if (!execute) {
      return Object.freeze({
        ok: true,
        schemaId: "xw.m6-4-live-window-stage-preflight.v1",
        executed: false,
        releaseId: final.binding.releaseId,
        sourceCommit: final.binding.sourceCommit,
        gateId: final.binding.gateId,
        currentClosedEpochHash: fence.epochHash,
        currentGeneration: fence.generation,
        candidateEpochHash: candidate.epoch.epochHash,
        candidateGeneration: authorization.gateGeneration,
        purpose: authorization.purpose,
        artifactCatalogHash: final.catalog.catalogHash,
        artifactInventoryHash: preflight.artifactInventoryHash,
        runtimeSnapshotSha256: sha256(jsonBytes(runtime)),
        writesPerformed: 0,
        gateMutationPerformed: false,
        deviceAccessed: false,
        networkAccessed: false,
      });
    }
    const resources = state.getM6GateFResourceCounts();
    if (Object.values(resources).some((count) => !Number.isSafeInteger(count) || count !== 0)) {
      stageError("M64_STAGE_RESOURCES_NOT_ZERO", "snapshot publication requires zero jobs, sessions, leases, and unresolved actions", { resources });
    }
    const finalPreflight = operations.preflight(candidate);
    if (canonicalJson(finalPreflight) !== canonicalJson(preflight)) {
      stageError("M64_STAGE_CONCURRENT_INPUT_CHANGE", "production preflight identity changed before snapshot publication");
    }
    const finalLoaded = loadM6Gate({
      m6Root: final.runtimeRoot,
      gateId: final.binding.gateId,
      issuerAllowlistPath: final.binding.gateIssuerAllowlistPath,
      requireLocks: true,
    });
    const finalFence = state.getM6GateFence();
    assertCandidateSequence({ loaded: finalLoaded, fence: finalFence, candidate, authorization, binding: final.binding });
    if (canonicalJson(finalFence) !== canonicalJson(fence)
      || finalLoaded.tailEpochHash !== loaded.tailEpochHash
      || canonicalJson(finalLoaded.currentPointer) !== canonicalJson(loaded.currentPointer)) {
      stageError("M64_STAGE_CONCURRENT_GATE_CHANGE", "Gate file/DB/pointer state changed after production preflight");
    }
    const finalResources = state.getM6GateFResourceCounts();
    if (Object.values(finalResources).some((count) => !Number.isSafeInteger(count) || count !== 0)
      || canonicalJson(finalResources) !== canonicalJson(resources)) {
      stageError("M64_STAGE_RESOURCES_NOT_ZERO", "resource state changed before snapshot publication", { resources: finalResources });
    }
    state.assertUnchanged?.();
    if (sha256(readPlainBytes(finalBindingPath, "FINAL runtime binding final check")) !== final.bindingSha256
      || sha256(readPlainBytes(authorizationPath, "owner live-window authorization final check")) !== sha256(authorizationRecord.bytes)
      || sha256(readPlainBytes(candidateActivationPackagePath, "candidate activation package final check")) !== sha256(candidateRecord.bytes)
      || sha256(readPlainBytes(final.binding.gateFArtifactCatalogPath, "Gate F artifact catalog final check")) !== final.binding.gateFArtifactCatalogSha256
      || sha256(readPlainBytes(final.manifestPath, "release manifest final check")) !== final.binding.releaseManifestSha256
      || sha256(readPlainBytes(final.binding.environmentQualificationPath, "environment qualification final check")) !== final.binding.environmentQualificationSha256
      || sha256(readPlainBytes(final.binding.productionDependencyBindingPath, "production dependency binding final check")) !== final.binding.productionDependencyBindingHash) {
      stageError("M64_STAGE_CONCURRENT_INPUT_CHANGE", "sealed stage inputs changed before snapshot publication");
    }
    await guard.assertOwned();
    const persisted = persistStage({
      runtime,
      binding: final.binding,
      authorization,
      candidate,
      catalog: final.catalog,
      preflight,
      loaded: finalLoaded,
      fence: finalFence,
      nowMs,
      publicationFaultAfter,
    });
    return Object.freeze({
      ok: true,
      schemaId: "xw.m6-4-live-window-stage-result.v1",
      executed: true,
      status: persisted.replay ? "EXACT_REPLAY" : persisted.rotated ? "ROTATED" : "STAGED",
      receipt: persisted.receipt,
      runtimeSnapshotPath: final.binding.runtimeSnapshotPath,
      gateMutationPerformed: false,
      deviceAccessed: false,
      networkAccessed: false,
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError = null;
    if (state) {
      try {
        state.close();
        state = null;
        stateCleanupProven = true;
      } catch (error) {
        cleanupError = error;
      }
    }
    if (guard) {
      try {
        if (stateCleanupProven) await guard.release();
        else await guard.retainStaleLock();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (!primaryError && cleanupError) throw cleanupError;
  }
}

export function parseM64StageWindowArgs(argv) {
  const out = { execute: false };
  const names = new Map([
    ["--final-binding", "finalBindingPath"],
    ["--authorization", "authorizationPath"],
    ["--candidate-activation-package", "candidateActivationPackagePath"],
    ["--gate-issuer-allowlist", "gateIssuerAllowlistPath"],
    ["--live-issuer-allowlist", "liveIssuerAllowlistPath"],
    ["--runtime-snapshot", "runtimeSnapshotPath"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") {
      if (out.execute) stageError("M64_STAGE_ARGUMENT_INVALID", "--execute may appear only once");
      out.execute = true;
      continue;
    }
    const key = names.get(arg);
    if (!key || out[key] !== undefined || index + 1 >= argv.length) {
      stageError("M64_STAGE_ARGUMENT_INVALID", `unknown, duplicate, or incomplete argument: ${arg}`);
    }
    out[key] = argv[++index];
  }
  if ([...names.values()].some((key) => out[key] === undefined)) {
    stageError("M64_STAGE_ARGUMENT_INVALID", "all six explicit path arguments are required");
  }
  return Object.freeze(out);
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const result = await stageM64LiveWindow(parseM64StageWindowArgs(argv));
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify({ ok: false, code: error?.code ?? "M64_STAGE_FAILED", message: error?.message ?? String(error) })}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
