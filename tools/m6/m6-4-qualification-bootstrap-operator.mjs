#!/usr/bin/env node

// Production operator for the release-specific M6-C1 qualification bootstrap.
//
// The default command is a read-only preflight.  --execute is the only path
// that may snapshot/migrate the control DB or publish immutable runtime
// artifacts.  This module never loads or creates a private key, never contacts
// a provider, and never touches a device.
import { DatabaseSync } from "node:sqlite";
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
} from "node:fs";
import {
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
  deriveM6AggregateSealHash,
  deriveM6ResourceSnapshotSha256,
} from "../../packages/kernel/lib/m6-aggregate-closeout.mjs";
import { snapshotDatabase } from "../../packages/cutover/lib/db.mjs";
import {
  RELEASE_MANIFEST_FILENAME,
  verifyReleaseManifest,
} from "../../packages/release/lib/release-manifest.mjs";
import { canonicalJson, sha256 } from "../../services/control-plane/control-plane/lib/canonical.mjs";
import {
  acquireM6C1StoppedRuntimeGuard,
} from "../../services/control-plane/control-plane/lib/m6-c1-runtime-owner-lock.mjs";
import {
  M6_GROUNDED_RUN_CAPABILITY_ID,
  verifyM6GroundedRunCapabilitySeal,
} from "../../services/control-plane/control-plane/lib/m6-grounded-run-capability-seal.mjs";
import {
  bootstrapM6Qualification,
  buildM6QualificationBootstrapBinding,
  deriveM6QualificationBootstrapPackageHash,
  deriveM6QualificationBootstrapScenarioManifestHash,
  isM6QualificationCleanupVerifiedError,
  M6_QUALIFICATION_BOOTSTRAP_PACKAGE_SCHEMA_ID,
  M6_QUALIFICATION_BOOTSTRAP_SCENARIO_SCHEMA_ID,
  validateM6QualificationBootstrapPackage,
} from "../../services/control-plane/control-plane/lib/m6-qualification-bootstrap.mjs";
import {
  deriveM6CloseoutHash,
  deriveM6EpochHash,
} from "../../services/control-plane/control-plane/lib/m6-live-gate.mjs";
import {
  inspectRecoverableCreateOnlyPublication,
  publishRecoverableCreateOnly,
  recoverablePublicationPendingPath,
  RecoverablePublicationError,
} from "./lib/recoverable-create-only-publication.mjs";

export const M64_QUALIFICATION_OPERATOR_RECEIPT_SCHEMA_ID =
  "xw.m6-c1-qualification-bootstrap-operator-receipt.v1";
export const M64_QUALIFICATION_SIGNING_DRAFT_SCHEMA_ID =
  "xw.m6-c1-qualification-bootstrap-signing-draft.v1";
export const M64_QUALIFICATION_INVENTORY_SENTINEL_HASH = sha256(
  "xw.m6-c1-qualification-bootstrap.inventory-unavailable.v1",
);

const HASH = /^(?!0{64}$)[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const OPAQUE_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const BINDING_RELATIVE_PATH = join("config", "m6-c1-qualification-bootstrap.v1.json");
const SENTINEL_RELATIVE_PATH = join("qualification-bootstrap", "final-inventory-unavailable.json");
const LIVE_ISSUER_SENTINEL_RELATIVE_PATH = join(
  "qualification-bootstrap",
  "live-window-owner-keys-unavailable.json",
);
const RECEIPT_DIRECTORY = join("qualification-bootstrap", "receipts");
const DRAFT_INPUT_KEYS = Object.freeze([
  "actor", "closedIssuedAt", "closeoutCommittedAt", "expiresAt", "gateId",
  "issuerAllowlistSha256", "locksRecord", "promotedAt", "releaseId",
  "rootIssuedAt", "sourceCommit",
]);
const LOCK_KEYS = Object.freeze(["groundingRuntime", "hardRedlinePolicy", "runtimeProfile"]);
const PROOF_KEYS = Object.freeze(["algorithm", "allowlistVersion", "keyId", "signature", "subject"]);
const DRAFT_KEYS = Object.freeze([
  "aggregate", "closedEpoch", "closeout", "draftHash", "gateId", "issuerAllowlistSha256",
  "locksRecord", "promotedAt", "releaseId", "resourceSnapshot", "rootEpoch",
  "scenarioManifest", "schemaId", "signingRequests", "sourceCommit",
]);
const SECRET_KEY = /^(?:api[_-]?key|access[_-]?token|bearer[_-]?token|password|private[_-]?key|secret|credential(?:value)?)$/iu;
const PRIVATE_KEY_VALUE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/u;

const DEFAULT_DEPENDENCIES = Object.freeze({
  acquireStoppedRuntimeGuard: acquireM6C1StoppedRuntimeGuard,
  bootstrapQualification: bootstrapM6Qualification,
  snapshotDatabase,
  validatePackage: validateM6QualificationBootstrapPackage,
  verifyCapabilitySeal: verifyM6GroundedRunCapabilitySeal,
  verifyReleaseManifest,
});

function operatorError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function exactObject(value, keys, code, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    operatorError(code, `${label} must contain only its exact frozen fields`);
  }
  return value;
}

function without(value, key) {
  const { [key]: _ignored, ...rest } = value || {};
  return rest;
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

function absolutePath(value, label) {
  if (typeof value !== "string" || value.length < 3 || value.length > 32_767
    || value.includes("\0") || !isAbsolute(value)) {
    operatorError("M64_QUALIFICATION_OPERATOR_PATH_INVALID", `${label} must be one bounded absolute path`);
  }
  return resolve(value);
}

function assertPlainAncestors(path, label, { allowMissing = false, includeTarget = false } = {}) {
  const target = resolve(path);
  const volumeRoot = parse(target).root;
  let cursor = includeTarget ? target : dirname(target);
  while (cursor && normalizedPath(cursor) !== normalizedPath(volumeRoot)) {
    if (!existsSync(cursor)) {
      if (!allowMissing) {
        operatorError("M64_QUALIFICATION_OPERATOR_PATH_UNAVAILABLE", `${label} is unavailable`);
      }
      const next = dirname(cursor);
      if (next === cursor) break;
      cursor = next;
      continue;
    }
    let stat;
    let real;
    try {
      stat = lstatSync(cursor, { bigint: true });
      real = realpathSync.native(cursor);
    } catch (cause) {
      operatorError("M64_QUALIFICATION_OPERATOR_PATH_UNAVAILABLE", `${label} is unavailable`, {
        cause: cause?.code ?? null,
      });
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(real, cursor)) {
      operatorError(
        "M64_QUALIFICATION_OPERATOR_PATH_REPARSE",
        `${label} must not traverse a symlink, junction, reparse point, or non-directory ancestor`,
      );
    }
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  return target;
}

function assertPlainDirectory(path, label) {
  const target = absolutePath(path, label);
  assertPlainAncestors(target, label, { includeTarget: true });
  return target;
}

function readPlainBytes(path, label, { controlledRoot = null, maxBytes = MAX_JSON_BYTES } = {}) {
  const target = absolutePath(path, label);
  assertPlainAncestors(target, label);
  if (controlledRoot !== null && !within(controlledRoot, target)) {
    operatorError("M64_QUALIFICATION_OPERATOR_PATH_ESCAPE", `${label} escapes its controlled root`);
  }
  let fd;
  try {
    const before = lstatSync(target, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size < 1n || before.size > BigInt(maxBytes)) {
      operatorError(
        "M64_QUALIFICATION_OPERATOR_FILE_INVALID",
        `${label} must be one bounded single-link regular file`,
      );
    }
    fd = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd, { bigint: true });
    const afterOpen = lstatSync(target, { bigint: true });
    if (!sameIdentity(before, opened) || !sameIdentity(opened, afterOpen)) {
      operatorError("M64_QUALIFICATION_OPERATOR_FILE_RACE", `${label} changed while it was opened`);
    }
    const bytes = readFileSync(fd);
    const afterRead = fstatSync(fd, { bigint: true });
    const pathAfterRead = lstatSync(target, { bigint: true });
    if (!sameIdentity(opened, afterRead) || !sameIdentity(afterRead, pathAfterRead)
      || pathAfterRead.isSymbolicLink() || pathAfterRead.nlink !== 1n
      || pathAfterRead.size !== BigInt(bytes.byteLength)) {
      operatorError("M64_QUALIFICATION_OPERATOR_FILE_RACE", `${label} changed while it was read`);
    }
    return Object.freeze({ bytes, path: target, sha256: sha256(bytes) });
  } catch (error) {
    if (error?.code?.startsWith?.("M64_QUALIFICATION_")) throw error;
    operatorError("M64_QUALIFICATION_OPERATOR_FILE_UNAVAILABLE", `${label} is unavailable`, {
      cause: error?.code ?? error?.message ?? null,
    });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readPlainJson(path, label, options = {}) {
  const file = readPlainBytes(path, label, options);
  try {
    return Object.freeze({ ...file, value: JSON.parse(file.bytes.toString("utf8")) });
  } catch {
    operatorError("M64_QUALIFICATION_OPERATOR_JSON_INVALID", `${label} is not valid JSON`);
  }
}

function assertNoSecretMaterial(value, label) {
  const visit = (item) => {
    if (typeof item === "string") {
      if (PRIVATE_KEY_VALUE.test(item)) {
        operatorError("M64_QUALIFICATION_OPERATOR_SECRET_FORBIDDEN", `${label} contains private-key material`);
      }
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (SECRET_KEY.test(key)) {
        operatorError("M64_QUALIFICATION_OPERATOR_SECRET_FORBIDDEN", `${label} contains forbidden secret field ${key}`);
      }
      visit(child);
    }
  };
  visit(value);
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureControlledDirectory(root, relativePath) {
  const target = resolve(root, relativePath);
  if (!within(root, target)) {
    operatorError("M64_QUALIFICATION_OPERATOR_PATH_ESCAPE", "runtime publication directory escapes runtime root");
  }
  assertPlainAncestors(target, "runtime publication directory", { allowMissing: true, includeTarget: true });
  mkdirSync(target, { recursive: true });
  assertPlainAncestors(target, "runtime publication directory", { includeTarget: true });
  return target;
}

function mapPublicationError(error, driftCode, label) {
  if (!(error instanceof RecoverablePublicationError)) throw error;
  if (error.reason === "TARGET_DIFFERENT") {
    operatorError(driftCode, `existing ${label} differs from the exact planned bytes`);
  }
  if (/^(?:PARENT|TARGET|PENDING)_(?:UNSAFE|EXTERNAL_HARDLINK|RACE)$/u.test(error.reason)) {
    operatorError("M64_QUALIFICATION_OPERATOR_FILE_INVALID", `${label} publication topology is unsafe`, {
      reason: error.reason,
    });
  }
  operatorError("M64_QUALIFICATION_OPERATOR_WRITE_FAILED", `recoverable ${label} publication failed`, {
    reason: error.reason,
    cause: error.causeCode,
  });
}

function writeExactCreateOnly(path, bytes, { controlledRoot, faultAfter = () => {}, driftCode }) {
  const target = resolve(path);
  if (!within(controlledRoot, target)) {
    operatorError("M64_QUALIFICATION_OPERATOR_PATH_ESCAPE", "immutable runtime artifact escapes runtime root");
  }
  assertPlainAncestors(target, "immutable runtime artifact");
  try {
    const publication = publishRecoverableCreateOnly({ targetPath: target, bytes, faultAfter });
    return Object.freeze({
      path: target,
      replay: publication.replay,
      sha256: publication.sha256,
    });
  } catch (error) {
    mapPublicationError(error, driftCode ?? "M64_QUALIFICATION_OPERATOR_ARTIFACT_DRIFT", "immutable runtime artifact");
  }
}

function verifyReleaseAndTcb({ releaseRoot, package: input }, dependencies) {
  const root = assertPlainDirectory(releaseRoot, "immutable release root");
  const manifestPath = join(root, RELEASE_MANIFEST_FILENAME);
  const manifestFile = readPlainJson(manifestPath, "immutable release manifest", { controlledRoot: root });
  const verified = dependencies.verifyReleaseManifest({ root, manifestPath });
  if (!verified?.ok) {
    operatorError("M64_QUALIFICATION_OPERATOR_RELEASE_INVALID", "immutable release manifest verification failed", {
      mismatches: verified?.mismatches ?? [],
    });
  }
  if (manifestFile.value?.releaseId !== input.releaseId
    || manifestFile.value?.sourceCommit !== input.sourceCommit) {
    operatorError(
      "M64_QUALIFICATION_OPERATOR_RELEASE_REBOUND",
      "bootstrap package release/source differs from the immutable release",
    );
  }
  const capabilityFile = readPlainJson(
    join(root, "services", "control-plane", "apps", "xiaowei", "capabilities.json"),
    "grounded-run capability catalog",
    { controlledRoot: root },
  );
  const matches = capabilityFile.value?.capabilities?.filter?.(
    (item) => item?.id === M6_GROUNDED_RUN_CAPABILITY_ID,
  ) ?? [];
  if (matches.length !== 1) {
    operatorError(
      "M64_QUALIFICATION_OPERATOR_TCB_INVALID",
      "immutable release must contain exactly one grounded-run capability",
    );
  }
  const seal = dependencies.verifyCapabilitySeal({ capability: matches[0], rootDir: root });
  if (seal?.capabilityId !== M6_GROUNDED_RUN_CAPABILITY_ID
    || !HASH.test(seal?.implementationClosureHash ?? "")
    || typeof seal?.tcbManifestRef !== "string" || seal.tcbManifestRef === "") {
    operatorError("M64_QUALIFICATION_OPERATOR_TCB_INVALID", "grounded-run TCB seal did not reproduce exactly");
  }
  const finalVerification = dependencies.verifyReleaseManifest({ root, manifestPath });
  if (!finalVerification?.ok) {
    operatorError("M64_QUALIFICATION_OPERATOR_RELEASE_RACE", "immutable release changed during verification");
  }
  return Object.freeze({
    root,
    manifestPath,
    manifestSha256: manifestFile.sha256,
    manifest: manifestFile.value,
    seal,
  });
}

function tableCount(db, tables, table, where = "") {
  if (!tables.has(table)) return 0;
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"${where}`).get().count);
}

function inspectControlDatabase(dbPath, nowMs) {
  const file = readPlainBytes(dbPath, "control database", { maxBytes: 4 * 1024 * 1024 * 1024 });
  // A plain sqlite read-only open may still create -shm/-wal sidecars.  The
  // default operator must be byte-for-byte read-only, so reject a live or
  // uncheckpointed WAL boundary and inspect a proven standalone DB through an
  // immutable mode=ro URI.
  if (existsSync(`${file.path}-wal`) || existsSync(`${file.path}-shm`)) {
    operatorError(
      "M64_QUALIFICATION_OPERATOR_DB_WAL_PRESENT",
      "read-only preflight requires a stopped, fully checkpointed control database without WAL/SHM sidecars",
    );
  }
  const immutableUri = `${pathToFileURL(file.path).href}?mode=ro&immutable=1`;
  const db = new DatabaseSync(immutableUri, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
    const userVersion = Number(db.prepare("PRAGMA user_version").get().user_version);
    if (integrity !== "ok" || ![18, 20].includes(userVersion)) {
      operatorError(
        "M64_QUALIFICATION_OPERATOR_DB_INVALID",
        "qualification bootstrap requires one intact v18 source or exact v20 replay database",
        { integrity, userVersion },
      );
    }
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name),
    );
    const resources = Object.freeze({
      jobs: tableCount(db, tables, "jobs", " WHERE status IN ('queued','waiting_approval','running','verifying','restoring')"),
      sessions: tableCount(db, tables, "sessions", ` WHERE expires_at>${Number(nowMs)}`),
      leases: tableCount(db, tables, "leases", ` WHERE expires_at>${Number(nowMs)}`),
      actionCount: tableCount(db, tables, "device_session_actions", " WHERE execution_mode='m6-grounded-live-v2'"),
    });
    const durableM6Tables = [
      "m6_emergency_close_consumptions", "m6_grounding_permits", "m6_action_claims",
      "m6_grounded_action_details", "m6_live_window_authorization_consumptions",
      "m6_live_scenario_claims", "m6_gate_safety_close_arms",
    ];
    const durableResidue = Object.freeze(Object.fromEntries(
      durableM6Tables.map((table) => [table, tableCount(db, tables, table)]),
    ));
    if (Object.values(resources).some((count) => !Number.isSafeInteger(count) || count !== 0)
      || Object.values(durableResidue).some((count) => !Number.isSafeInteger(count) || count !== 0)) {
      operatorError(
        "M64_QUALIFICATION_OPERATOR_RESOURCES_NOT_ZERO",
        "qualification bootstrap requires zero active resources and zero M6 residue",
        { resources, durableResidue },
      );
    }
    const after = readPlainBytes(file.path, "control database", { maxBytes: 4 * 1024 * 1024 * 1024 });
    if (after.sha256 !== file.sha256 || existsSync(`${file.path}-wal`) || existsSync(`${file.path}-shm`)) {
      operatorError(
        "M64_QUALIFICATION_OPERATOR_DB_RACE",
        "control database changed or acquired a WAL boundary during read-only preflight",
      );
    }
    return Object.freeze({
      path: file.path,
      sha256: file.sha256,
      userVersion,
      resources,
      durableResidue,
    });
  } finally {
    db.close();
  }
}

function validateSnapshotRoot({ snapshotRoot, runtimeRoot, dbPath }) {
  const root = absolutePath(snapshotRoot, "snapshot backup root");
  const dbRoot = dirname(dbPath);
  if (within(runtimeRoot, root) || within(root, runtimeRoot)
    || within(dbRoot, root) || within(root, dbRoot)) {
    operatorError(
      "M64_QUALIFICATION_OPERATOR_SNAPSHOT_ROOT_INVALID",
      "snapshot backup root must be disjoint from the mutable runtime and control DB directory",
    );
  }
  assertPlainAncestors(join(root, "prospective.snapshot.db"), "snapshot backup root", { allowMissing: true });
  return root;
}

function expectedRuntimePaths(runtimeRoot) {
  return Object.freeze({
    bindingPath: join(runtimeRoot, BINDING_RELATIVE_PATH),
    controlDbPath: join(runtimeRoot, "state", "control-plane", "control.db"),
    liveIssuerSentinelPath: join(runtimeRoot, LIVE_ISSUER_SENTINEL_RELATIVE_PATH),
    receiptRoot: join(runtimeRoot, RECEIPT_DIRECTORY),
    sentinelPath: join(runtimeRoot, SENTINEL_RELATIVE_PATH),
  });
}

function assertSentinelsUnavailable(paths) {
  for (const [label, path] of [
    ["Gate-F inventory sentinel", paths.sentinelPath],
    ["live-window issuer sentinel", paths.liveIssuerSentinelPath],
  ]) {
    assertPlainAncestors(path, label, { allowMissing: true });
    if (existsSync(path)) {
      operatorError(
        "M64_QUALIFICATION_OPERATOR_SENTINEL_PRESENT",
        `${label} must remain absent in QUALIFICATION_ONLY mode`,
      );
    }
  }
}

export function planM64QualificationBootstrap({
  bootstrapPackagePath,
  issuerAllowlistPath,
  releaseRoot,
  runtimeRoot,
  snapshotRoot,
  nowMs = Date.now(),
} = {}, dependencies = {}) {
  if (!Number.isFinite(nowMs)) {
    operatorError("M64_QUALIFICATION_OPERATOR_CLOCK_INVALID", "preflight requires one finite clock");
  }
  const deps = Object.freeze({ ...DEFAULT_DEPENDENCIES, ...dependencies });
  const runtime = assertPlainDirectory(runtimeRoot, "runtime root");
  const paths = expectedRuntimePaths(runtime);
  const packageFile = readPlainJson(bootstrapPackagePath, "externally signed bootstrap package");
  assertNoSecretMaterial(packageFile.value, "externally signed bootstrap package");
  const issuerPath = absolutePath(issuerAllowlistPath, "gate issuer allowlist");
  if (!within(runtime, issuerPath)) {
    operatorError(
      "M64_QUALIFICATION_OPERATOR_ISSUER_REBOUND",
      "gate issuer allowlist must be rooted in the exact runtime",
    );
  }
  const issuerFile = readPlainJson(issuerPath, "gate issuer allowlist", { controlledRoot: runtime });
  assertNoSecretMaterial(issuerFile.value, "gate issuer allowlist");
  const verifiedPackage = deps.validatePackage({
    package: packageFile.value,
    issuerAllowlistPath: issuerPath,
    m6Root: runtime,
    nowMs,
  });
  const issuerAfterValidation = readPlainBytes(issuerPath, "gate issuer allowlist", {
    controlledRoot: runtime,
  });
  if (!issuerAfterValidation.bytes.equals(issuerFile.bytes)) {
    operatorError(
      "M64_QUALIFICATION_OPERATOR_ISSUER_RACE",
      "gate issuer allowlist changed while the externally signed package was verified",
    );
  }
  const release = verifyReleaseAndTcb({ releaseRoot, package: verifiedPackage.package }, deps);
  const database = inspectControlDatabase(paths.controlDbPath, nowMs);
  const backupRoot = validateSnapshotRoot({
    snapshotRoot,
    runtimeRoot: runtime,
    dbPath: paths.controlDbPath,
  });
  assertSentinelsUnavailable(paths);
  const binding = buildM6QualificationBootstrapBinding({
    package: verifiedPackage.package,
    sourceReleaseRoot: release.root,
    releaseManifestSha256: release.manifestSha256,
    gateIssuerAllowlistPath: issuerPath,
    gateFArtifactInventoryPath: paths.sentinelPath,
    gateFArtifactInventoryHash: M64_QUALIFICATION_INVENTORY_SENTINEL_HASH,
  });
  const bindingBytes = jsonBytes(binding);
  const bindingSha256 = sha256(bindingBytes);
  let bindingPresent = false;
  let bindingNeedsRecovery = false;
  const pendingBindingPath = recoverablePublicationPendingPath(paths.bindingPath, bindingBytes);
  if (existsSync(paths.bindingPath) || existsSync(pendingBindingPath)) {
    try {
      const publication = inspectRecoverableCreateOnlyPublication({
        targetPath: paths.bindingPath,
        bytes: bindingBytes,
      });
      bindingPresent = publication.exactFinal;
      bindingNeedsRecovery = publication.needsRecovery;
    } catch (error) {
      mapPublicationError(error, "M64_QUALIFICATION_OPERATOR_BINDING_DRIFT", "qualification runtime binding");
    }
  } else {
    assertPlainAncestors(paths.bindingPath, "qualification runtime binding", { allowMissing: true });
  }
  if (bindingPresent && database.userVersion === 18) {
    operatorError(
      "M64_QUALIFICATION_OPERATOR_BINDING_AHEAD",
      "qualification binding may not be published before the v18 bootstrap fence",
    );
  }
  const snapshotLabel = `m6-c1-${verifiedPackage.package.packageHash.slice(0, 16)}`;
  const planBody = {
    ok: true,
    schemaId: "xw.m6-c1-qualification-bootstrap-operator-preflight.v1",
    executed: false,
    releaseId: verifiedPackage.package.releaseId,
    sourceCommit: verifiedPackage.package.sourceCommit,
    gateId: verifiedPackage.package.gateId,
    packageHash: verifiedPackage.package.packageHash,
    releaseManifestSha256: release.manifestSha256,
    implementationClosureHash: release.seal.implementationClosureHash,
    tcbManifestRef: release.seal.tcbManifestRef,
    databaseVersion: database.userVersion,
    resourceCounts: database.resources,
    bindingPath: paths.bindingPath,
    bindingSha256,
    bindingPresent,
    bindingNeedsRecovery,
    gateFArtifactInventoryPath: paths.sentinelPath,
    gateFArtifactInventoryHash: M64_QUALIFICATION_INVENTORY_SENTINEL_HASH,
    snapshotRoot: backupRoot,
    snapshotLabel,
    writesPerformed: 0,
    privateKeyAccessed: false,
    providerAccessed: false,
    deviceAccessed: false,
    networkAccessed: false,
  };
  return Object.freeze({
    ...planBody,
    preflightHash: sha256(`${planBody.schemaId}:${canonicalJson(planBody)}`),
    binding,
    package: verifiedPackage.package,
    paths,
  });
}

function deriveOperatorReceipt({ plan, result, bindingSha256 }) {
  const body = {
    schemaId: M64_QUALIFICATION_OPERATOR_RECEIPT_SCHEMA_ID,
    releaseId: plan.releaseId,
    sourceCommit: plan.sourceCommit,
    gateId: plan.gateId,
    packageHash: plan.packageHash,
    rootEpochHash: plan.package.rootEpochRecord.epochHash,
    closedEpochHash: result.epochHash,
    generation: result.generation,
    mode: result.mode,
    locksHash: result.locksHash,
    releaseManifestSha256: plan.releaseManifestSha256,
    implementationClosureHash: plan.implementationClosureHash,
    tcbManifestRef: plan.tcbManifestRef,
    bootstrapResultHash: result.resultHash,
    dbSnapshotReceiptHash: result.dbSnapshotReceipt.receiptHash,
    snapshotSha256: result.dbSnapshotReceipt.snapshotSha256,
    bindingPath: plan.paths.bindingPath,
    bindingSha256,
    gateFArtifactInventoryPath: plan.paths.sentinelPath,
    gateFArtifactInventoryHash: M64_QUALIFICATION_INVENTORY_SENTINEL_HASH,
    actionCount: result.actionCount,
    resourceCounts: result.resourceCounts,
    privateKeyAccessed: false,
    secretMaterialPresent: false,
    providerAccessed: false,
    deviceAccessed: false,
    networkAccessed: false,
  };
  return Object.freeze({
    ...body,
    receiptHash: sha256(`${M64_QUALIFICATION_OPERATOR_RECEIPT_SCHEMA_ID}:${canonicalJson(body)}`),
  });
}

export async function operateM64QualificationBootstrap(input = {}, {
  execute = false,
  dependencies = {},
  publicationFaultAfter = () => {},
} = {}) {
  const deps = Object.freeze({ ...DEFAULT_DEPENDENCIES, ...dependencies });
  if (!execute) return planM64QualificationBootstrap(input, deps);
  const runtimeRoot = absolutePath(input.runtimeRoot, "runtime root");
  let guard = null;
  let primaryError = null;
  let bootstrapCleanupProven = true;
  try {
    guard = await deps.acquireStoppedRuntimeGuard({
      runtimeRoot,
      ownerKind: "QUALIFICATION_BOOTSTRAP",
      host: "127.0.0.1",
      port: 17920,
    });
    if (!guard || typeof guard.assertOwned !== "function" || typeof guard.release !== "function"
      || typeof guard.retainStaleLock !== "function") {
      operatorError(
        "M64_QUALIFICATION_OPERATOR_OWNER_GUARD_INVALID",
        "shared M6-C1 stopped-runtime guard is unavailable",
      );
    }
    guard.assertOwned();
    const plan = planM64QualificationBootstrap(input, deps);
    guard.assertOwned();
    bootstrapCleanupProven = false;
    let result;
    try {
      result = await deps.bootstrapQualification({
        package: plan.package,
        m6Root: runtimeRoot,
        dbPath: plan.paths.controlDbPath,
        issuerAllowlistPath: absolutePath(input.issuerAllowlistPath, "gate issuer allowlist"),
        snapshotDatabase: deps.snapshotDatabase,
        snapshotDirectory: plan.snapshotRoot,
        snapshotLabel: plan.snapshotLabel,
        activeRunCount: () => 0,
        now: () => Number(input.nowMs ?? Date.now()),
      });
      bootstrapCleanupProven = true;
    } catch (error) {
      bootstrapCleanupProven = isM6QualificationCleanupVerifiedError(error);
      throw error;
    }
    publicationFaultAfter("bootstrap");
    guard.assertOwned();
    assertSentinelsUnavailable(plan.paths);
    const postPlan = planM64QualificationBootstrap(input, deps);
    if (postPlan.packageHash !== plan.packageHash
      || postPlan.releaseManifestSha256 !== plan.releaseManifestSha256
      || postPlan.implementationClosureHash !== plan.implementationClosureHash
      || postPlan.bindingSha256 !== plan.bindingSha256) {
      operatorError(
        "M64_QUALIFICATION_OPERATOR_CONCURRENT_CHANGE",
        "release/package/runtime binding changed during qualification bootstrap",
      );
    }
    ensureControlledDirectory(runtimeRoot, dirname(BINDING_RELATIVE_PATH));
    const bindingPublication = writeExactCreateOnly(
      plan.paths.bindingPath,
      jsonBytes(plan.binding),
      {
        controlledRoot: runtimeRoot,
        driftCode: "M64_QUALIFICATION_OPERATOR_BINDING_DRIFT",
        faultAfter: (point, context) => publicationFaultAfter(`binding:${point}`, context),
      },
    );
    publicationFaultAfter("binding");
    guard.assertOwned();
    assertSentinelsUnavailable(plan.paths);
    const receipt = deriveOperatorReceipt({
      plan,
      result,
      bindingSha256: bindingPublication.sha256,
    });
    const receiptRoot = ensureControlledDirectory(runtimeRoot, RECEIPT_DIRECTORY);
    const receiptPath = join(receiptRoot, `${receipt.receiptHash}.json`);
    const receiptPublication = writeExactCreateOnly(
      receiptPath,
      jsonBytes(receipt),
      {
        controlledRoot: runtimeRoot,
        driftCode: "M64_QUALIFICATION_OPERATOR_ARTIFACT_DRIFT",
        faultAfter: (point, context) => publicationFaultAfter(`receipt:${point}`, context),
      },
    );
    publicationFaultAfter("receipt");
    guard.assertOwned();
    assertSentinelsUnavailable(plan.paths);
    const status = receiptPublication.replay
      ? "EXACT_REPLAY"
      : bindingPublication.replay
        ? "RECOVERED_RECEIPT"
        : plan.databaseVersion === 20
          ? "RECOVERED_AFTER_BOOTSTRAP"
          : "BOOTSTRAPPED";
    return Object.freeze({
      ok: true,
      schemaId: "xw.m6-c1-qualification-bootstrap-operator-result.v1",
      executed: true,
      status,
      releaseId: plan.releaseId,
      sourceCommit: plan.sourceCommit,
      gateId: plan.gateId,
      receiptPath,
      receipt,
      bindingPath: plan.paths.bindingPath,
      snapshotPath: result.dbSnapshotReceipt.snapshotPath,
      privateKeyAccessed: false,
      providerAccessed: false,
      deviceAccessed: false,
      networkAccessed: false,
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (guard) {
      try {
        if (bootstrapCleanupProven) await guard.release();
        else await guard.retainStaleLock();
      } catch (releaseError) {
        if (!primaryError) throw releaseError;
      }
    }
  }
}

// Pure, secret-free preparation for an external signing service.  The signing
// payload is the exact 32-byte epoch hash (hex-decoded), matching verifyEpochProof.
export function buildM64QualificationBootstrapSigningDraft(input = {}) {
  exactObject(
    input,
    DRAFT_INPUT_KEYS,
    "M64_QUALIFICATION_DRAFT_INVALID",
    "qualification signing draft input",
  );
  assertNoSecretMaterial(input, "qualification signing draft input");
  exactObject(input.locksRecord, ["lockHashes", "releaseId", "schemaId", "sourceCommit"],
    "M64_QUALIFICATION_DRAFT_INVALID", "locksRecord");
  exactObject(input.locksRecord.lockHashes, LOCK_KEYS,
    "M64_QUALIFICATION_DRAFT_INVALID", "locksRecord.lockHashes");
  if (!OPAQUE_ID.test(input.releaseId ?? "") || !COMMIT.test(input.sourceCommit ?? "")
    || !OPAQUE_ID.test(input.gateId ?? "") || !HASH.test(input.issuerAllowlistSha256 ?? "")
    || input.locksRecord.schemaId !== "xw.m6-locks.v1"
    || input.locksRecord.releaseId !== input.releaseId
    || input.locksRecord.sourceCommit !== input.sourceCommit
    || LOCK_KEYS.some((key) => !HASH.test(input.locksRecord.lockHashes[key] ?? ""))
    || typeof input.actor !== "string" || input.actor.length < 1 || input.actor.length > 200) {
    operatorError("M64_QUALIFICATION_DRAFT_INVALID", "draft authority identity/locks are invalid");
  }
  const times = [
    input.rootIssuedAt,
    input.closeoutCommittedAt,
    input.closedIssuedAt,
    input.promotedAt,
    input.expiresAt,
  ].map((value) => Date.parse(value));
  if (!times.every(Number.isFinite)
    || times[0] > times[1] || times[1] > times[2] || times[2] > times[3]
    || times[4] <= times[3]) {
    operatorError("M64_QUALIFICATION_DRAFT_INVALID", "draft chronology or expiry is invalid");
  }
  const rootRaw = {
    schemaId: "xw.m6-live-gate.v1",
    gateId: input.gateId,
    mode: "OBSERVE_ONLY",
    status: "active",
    releaseId: input.releaseId,
    sourceCommit: input.sourceCommit,
    actor: input.actor,
    lockHashes: { ...input.locksRecord.lockHashes },
    allowlist: ["01"],
    issuedAt: input.rootIssuedAt,
    expiresAt: input.expiresAt,
    parentEpochHash: null,
    closeoutRef: null,
    aggregateSealRef: null,
    rollbackTargetEpochHash: null,
  };
  const rootEpoch = Object.freeze({ ...rootRaw, epochHash: deriveM6EpochHash(rootRaw) });
  const scenarioRaw = {
    schemaId: M6_QUALIFICATION_BOOTSTRAP_SCENARIO_SCHEMA_ID,
    epochHash: rootEpoch.epochHash,
    allowlist: ["01"],
    attemptCount: 0,
    scenarios: [],
  };
  const scenarioManifest = Object.freeze({
    ...scenarioRaw,
    manifestSha256: deriveM6QualificationBootstrapScenarioManifestHash(scenarioRaw),
  });
  const zeroPoint = Object.freeze({
    activeActions: 0,
    activeJobs: 0,
    activeLeases: 0,
    activeRuns: 0,
    activeSessions: 0,
  });
  const resourceRaw = {
    schemaId: "xw.m6-resource-snapshot.v1",
    epochHash: rootEpoch.epochHash,
    before: { ...zeroPoint },
    after: { ...zeroPoint },
    actionCount: 0,
  };
  const resourceSnapshot = Object.freeze({
    ...resourceRaw,
    snapshotSha256: deriveM6ResourceSnapshotSha256(resourceRaw),
  });
  const sealPayload = Object.freeze({
    epochHash: rootEpoch.epochHash,
    allowlist: ["01"],
    scenarioManifestSha256: scenarioManifest.manifestSha256,
    resourceSnapshotSha256: resourceSnapshot.snapshotSha256,
    attempts: [],
  });
  const sealHash = deriveM6AggregateSealHash(sealPayload);
  const aggregate = Object.freeze({
    schemaId: "xw.m6-aggregate-closeout.v1",
    epochHash: rootEpoch.epochHash,
    sealPayload,
    sealHash,
    attemptCount: 0,
    aliases: ["01"],
  });
  const closeoutRaw = {
    closeoutId: `qualification-bootstrap-${rootEpoch.epochHash.slice(0, 20)}`,
    epochHash: rootEpoch.epochHash,
    actor: input.actor,
    reason: "seal never-activated qualification bootstrap root",
    committedAt: input.closeoutCommittedAt,
  };
  const closeout = Object.freeze({ ...closeoutRaw, closeoutHash: deriveM6CloseoutHash(closeoutRaw) });
  const closedRaw = {
    ...rootRaw,
    mode: "CLOSED",
    status: "closed",
    issuedAt: input.closedIssuedAt,
    parentEpochHash: rootEpoch.epochHash,
    closeoutRef: { id: closeout.closeoutId, sha256: closeout.closeoutHash },
    aggregateSealRef: { id: sealHash, sha256: sealHash },
  };
  const closedEpoch = Object.freeze({ ...closedRaw, epochHash: deriveM6EpochHash(closedRaw) });
  const signingRequests = Object.freeze([
    Object.freeze({
      role: "ROOT",
      algorithm: "ed25519",
      subject: input.actor,
      epochHash: rootEpoch.epochHash,
      payloadEncoding: "raw-32-byte-epoch-hash",
      payloadHex: rootEpoch.epochHash,
    }),
    Object.freeze({
      role: "CLOSED",
      algorithm: "ed25519",
      subject: input.actor,
      epochHash: closedEpoch.epochHash,
      payloadEncoding: "raw-32-byte-epoch-hash",
      payloadHex: closedEpoch.epochHash,
    }),
  ]);
  const body = {
    schemaId: M64_QUALIFICATION_SIGNING_DRAFT_SCHEMA_ID,
    gateId: input.gateId,
    releaseId: input.releaseId,
    sourceCommit: input.sourceCommit,
    issuerAllowlistSha256: input.issuerAllowlistSha256,
    locksRecord: input.locksRecord,
    rootEpoch,
    closedEpoch,
    closeout,
    aggregate,
    scenarioManifest,
    resourceSnapshot,
    promotedAt: input.promotedAt,
    signingRequests,
  };
  return Object.freeze({
    ...body,
    draftHash: sha256(`${M64_QUALIFICATION_SIGNING_DRAFT_SCHEMA_ID}:${canonicalJson(body)}`),
  });
}

export function assembleM64QualificationBootstrapPackage({
  draft,
  rootProof,
  closedProof,
  issuerAllowlistPath,
  runtimeRoot,
  nowMs = Date.now(),
} = {}, dependencies = {}) {
  const deps = Object.freeze({ ...DEFAULT_DEPENDENCIES, ...dependencies });
  exactObject(draft, DRAFT_KEYS, "M64_QUALIFICATION_DRAFT_INVALID", "qualification signing draft");
  const expectedDraftHash = sha256(
    `${M64_QUALIFICATION_SIGNING_DRAFT_SCHEMA_ID}:${canonicalJson(without(draft, "draftHash"))}`,
  );
  if (draft.schemaId !== M64_QUALIFICATION_SIGNING_DRAFT_SCHEMA_ID
    || draft.draftHash !== expectedDraftHash) {
    operatorError("M64_QUALIFICATION_DRAFT_INVALID", "qualification signing draft hash is invalid");
  }
  exactObject(rootProof, PROOF_KEYS, "M64_QUALIFICATION_PROOF_INVALID", "root proof");
  exactObject(closedProof, PROOF_KEYS, "M64_QUALIFICATION_PROOF_INVALID", "CLOSED proof");
  assertNoSecretMaterial({ rootProof, closedProof }, "external epoch proofs");
  const raw = {
    schemaId: M6_QUALIFICATION_BOOTSTRAP_PACKAGE_SCHEMA_ID,
    gateId: draft.gateId,
    releaseId: draft.releaseId,
    sourceCommit: draft.sourceCommit,
    locksRecord: draft.locksRecord,
    issuerAllowlistSha256: draft.issuerAllowlistSha256,
    rootEpochRecord: { ...draft.rootEpoch, proof: rootProof },
    closedEpochRecord: { ...draft.closedEpoch, proof: closedProof },
    closeout: draft.closeout,
    aggregate: draft.aggregate,
    scenarioManifest: draft.scenarioManifest,
    resourceSnapshot: draft.resourceSnapshot,
    promotedAt: draft.promotedAt,
  };
  const packageRecord = Object.freeze({
    ...raw,
    packageHash: deriveM6QualificationBootstrapPackageHash(raw),
  });
  const resolvedRuntimeRoot = absolutePath(runtimeRoot, "runtime root");
  const resolvedIssuerPath = absolutePath(issuerAllowlistPath, "gate issuer allowlist");
  if (!within(resolvedRuntimeRoot, resolvedIssuerPath)) {
    operatorError(
      "M64_QUALIFICATION_OPERATOR_ISSUER_REBOUND",
      "gate issuer allowlist must be rooted in the exact runtime",
    );
  }
  const issuerFile = readPlainJson(resolvedIssuerPath, "gate issuer allowlist", {
    controlledRoot: resolvedRuntimeRoot,
  });
  assertNoSecretMaterial(issuerFile.value, "gate issuer allowlist");
  deps.validatePackage({
    package: packageRecord,
    issuerAllowlistPath: resolvedIssuerPath,
    m6Root: resolvedRuntimeRoot,
    nowMs,
  });
  return packageRecord;
}

export function parseM64QualificationOperatorArgs(argv) {
  const out = { execute: false };
  const names = new Map([
    ["--bootstrap-package", "bootstrapPackagePath"],
    ["--issuer-allowlist", "issuerAllowlistPath"],
    ["--release-root", "releaseRoot"],
    ["--runtime-root", "runtimeRoot"],
    ["--snapshot-root", "snapshotRoot"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") {
      if (out.execute) {
        operatorError("M64_QUALIFICATION_OPERATOR_ARGUMENT_INVALID", "--execute may appear only once");
      }
      out.execute = true;
      continue;
    }
    const key = names.get(arg);
    if (!key || out[key] !== undefined || index + 1 >= argv.length) {
      operatorError(
        "M64_QUALIFICATION_OPERATOR_ARGUMENT_INVALID",
        `unknown, duplicate, or incomplete argument: ${arg}`,
      );
    }
    out[key] = argv[++index];
  }
  if ([...names.values()].some((key) => out[key] === undefined)) {
    operatorError(
      "M64_QUALIFICATION_OPERATOR_ARGUMENT_INVALID",
      "all five explicit path arguments are required",
    );
  }
  return Object.freeze(out);
}

export async function main(argv = process.argv.slice(2), {
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const parsed = parseM64QualificationOperatorArgs(argv);
    const { execute, ...input } = parsed;
    const result = await operateM64QualificationBootstrap(input, { execute });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code ?? "M64_QUALIFICATION_OPERATOR_FAILED",
      message: error?.message ?? String(error),
    })}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
