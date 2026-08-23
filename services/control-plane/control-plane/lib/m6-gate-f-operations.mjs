import { createHash, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import {
  loadContentAddressedLiveModelQualificationBundle,
  validateQualifiedLiveModelBundle,
} from "../../../../integrations/dsh-xw/src/live-model-profile.mjs";
import {
  deriveM64TargetEnvironmentCommandRegistryHash,
  M6_TARGET_ENVIRONMENT_QUALIFICATION_TTL_MS,
} from "../../apps/xiaowei/m6-target-environment-qualification.mjs";
import { validateM64CohortAggregate, validateM64CohortManifest } from "../../../../packages/kernel/lib/m6-4-cohort.mjs";
import { selectM64LiveWindowRuntimeBinding } from "../../../../packages/kernel/lib/m6-4-live-window-authorization.mjs";
import { deriveTargetEnvironmentAttestation } from "../../../../packages/kernel/lib/m6-live-grounding.mjs";
import { verifyReleaseManifest } from "../../../../packages/release/lib/release-manifest.mjs";
import { canonicalJson, sha256 } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";
import {
  loadM64LiveWindowIssuerAllowlist,
  verifyM64LiveWindowAuthorization,
} from "./m6-live-window-authorization.mjs";
import {
  assertM6FileDbPointerConsistency,
  preflightM6GateEpochPromotion,
  promoteM6GateEpoch,
  reconcileM6GateEpochPromotion,
} from "./m6-gate-promoter.mjs";
import {
  assertM6GateFSafetyCloseArmMatchesPackage,
  createM6GateFSafetyCloseLoadAuthority,
} from "./m6-gate-safety-close-arm.mjs";
import { loadM6Gate } from "./m6-gate-loader.mjs";
import {
  deriveM6EmergencyCloseAuthorizationHash,
  deriveM6V2LockSetHash,
  evaluateM6MixedGate,
  M6_GATE_V2_LOCK_KINDS,
} from "./m6-live-gate-v2.mjs";

const HASH = /^[0-9a-f]{64}$/u;
const NONZERO_HASH = /^(?!0{64}$)[0-9a-f]{64}$/u;
const PHASES = Object.freeze(new Set(["GROUNDING_ONLY", "GROUNDED_ACTION"]));
const OPERATIONS = Object.freeze(new Set(["ACTIVATE", "NORMAL_CLOSE", "EMERGENCY_CLOSE"]));
const PACKAGE_KEYS = Object.freeze(["authorization", "epoch", "operation", "phase", "proof", "reasonCode"]);
const ACTIVATION_PACKAGE_KEYS = Object.freeze([...PACKAGE_KEYS, "safetyClosePackage"]);
const INVENTORY_KEYS = Object.freeze(["inventoryHash", "lockArtifacts", "release", "runtimeArtifacts", "schemaId"]);
const CATALOG_KEYS = Object.freeze(["catalogHash", "entries", "release", "schemaId"]);
const CATALOG_RELEASE_KEYS = Object.freeze(["releaseId", "sourceCommit"]);
const CATALOG_ENTRY_KEYS = Object.freeze([
  "inventoryHash", "inventoryPath", "inventorySha256", "purpose", "scenarioManifestHash",
]);
const RELEASE_KEYS = Object.freeze(["manifestPath", "root"]);
const RUNTIME_ARTIFACT_KEYS = Object.freeze([
  "environmentAttestation", "independentOracle", "operator", "resetObligations",
]);
const DESCRIPTOR_KEYS = Object.freeze(["mode", "path"]);
const ENVIRONMENT_QUALIFICATION_KEYS = Object.freeze([
  "actionCount", "alias", "capturedAt", "commandRegistryHash", "effectBoundary",
  "expiresAt", "gateFEligible", "qualifiedAttestationHashes", "rawDeviceIdentityPresent",
  "sampleCount", "schemaId", "secretMaterialPresent", "status",
]);
const ARTIFACT_MODES = Object.freeze(new Set([
  "RAW_SHA256", "TREE_SHA256", "LIVE_MODEL_PROFILE", "M6_COHORT_MANIFEST",
  "TARGET_ENV_ATTESTATION", "ENVIRONMENT_QUALIFICATION",
]));
const GROUNDING_PURPOSES = Object.freeze(new Set(["M6_4_SHADOW"]));
const ACTION_PURPOSES = Object.freeze(new Set([
  "M6_4_HOT_CLOSE", "M6_4_ACTION_SMOKE", "M6_4_RELIABILITY", "M6_4_SMOOTH",
]));
const MAX_GATE_F_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const M6_GATE_F_ARTIFACT_CATALOG_PURPOSES = Object.freeze([
  "M6_4_SHADOW",
  "M6_4_HOT_CLOSE",
  "M6_4_ACTION_SMOKE",
  "M6_4_RELIABILITY",
  "M6_4_SMOOTH",
]);

function fail(code, message, { status = 409, details = {}, cause } = {}) {
  throw new ControlPlaneError(code, message, { status, details, cause });
}

function exactObject(value, keys, code, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    fail(code, `${label} must contain exactly ${keys.join(", ")}`, { status: 400 });
  }
  return value;
}

function normalizedPath(value) {
  const path = resolve(value);
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function sameFilesystemIdentity(left, right) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && String(left.mode) === String(right.mode)
    && String(left.nlink) === String(right.nlink)
    && String(left.size) === String(right.size)
    && String(left.mtimeNs ?? left.mtimeMs) === String(right.mtimeNs ?? right.mtimeMs);
}

function assertPlainArtifactAncestors(path, label) {
  const target = resolve(path);
  const volumeRoot = parse(target).root;
  let cursor = dirname(target);
  while (cursor && cursor !== volumeRoot) {
    let stat;
    let actual;
    try {
      stat = lstatSync(cursor);
      actual = realpathSync(cursor);
    } catch (cause) {
      fail("M6_GATE_F_ARTIFACT_UNAVAILABLE", `${label} parent directory is unavailable`, { status: 503, cause });
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || normalizedPath(actual) !== normalizedPath(cursor)) {
      fail("M6_GATE_F_ARTIFACT_PATH_INVALID", `${label} must not traverse a symlink, junction, reparse point, or non-directory parent`, { status: 503 });
    }
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
}

function safeRegularBytes(path, label) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    fail("M6_GATE_F_ARTIFACT_PATH_INVALID", `${label} path must be absolute`, { status: 503 });
  }
  const target = resolve(path);
  assertPlainArtifactAncestors(target, label);
  let fd;
  try {
    const before = lstatSync(target, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size < 1n || before.size > BigInt(MAX_GATE_F_ARTIFACT_BYTES)
      || normalizedPath(realpathSync(target)) !== normalizedPath(target)) {
      fail("M6_GATE_F_ARTIFACT_PATH_INVALID", `${label} must be one bounded single-link plain regular file`, { status: 503 });
    }
    fd = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd, { bigint: true });
    const afterOpen = lstatSync(target, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || afterOpen.isSymbolicLink()
      || !sameFilesystemIdentity(before, opened) || !sameFilesystemIdentity(opened, afterOpen)) {
      fail("M6_GATE_F_ARTIFACT_RACE", `${label} changed while it was opened`, { status: 503 });
    }
    const bytes = readFileSync(fd);
    const afterRead = fstatSync(fd, { bigint: true });
    const pathAfterRead = lstatSync(target, { bigint: true });
    if (!sameFilesystemIdentity(opened, afterRead) || !sameFilesystemIdentity(afterRead, pathAfterRead)
      || pathAfterRead.isSymbolicLink() || pathAfterRead.size !== BigInt(bytes.length)) {
      fail("M6_GATE_F_ARTIFACT_RACE", `${label} changed while it was read`, { status: 503 });
    }
    return bytes;
  } catch (cause) {
    if (cause instanceof ControlPlaneError) throw cause;
    fail("M6_GATE_F_ARTIFACT_UNAVAILABLE", `${label} is unavailable`, { status: 503, cause });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function safeJson(path, label) {
  try {
    return JSON.parse(safeRegularBytes(path, label).toString("utf8"));
  } catch (cause) {
    if (cause instanceof ControlPlaneError) throw cause;
    fail("M6_GATE_F_ARTIFACT_INVALID", `${label} is malformed JSON`, { status: 503, cause });
  }
}

function pathInside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function treeSha256(rootPath) {
  if (typeof rootPath !== "string" || !isAbsolute(rootPath)) {
    fail("M6_GATE_F_ARTIFACT_PATH_INVALID", "tree artifact path must be absolute", { status: 503 });
  }
  assertPlainArtifactAncestors(resolve(rootPath), "tree artifact");
  let root;
  try {
    const stat = lstatSync(rootPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail("M6_GATE_F_ARTIFACT_PATH_INVALID", "tree artifact must be a non-symlink directory", { status: 503 });
    }
    root = realpathSync(rootPath);
    if (normalizedPath(root) !== normalizedPath(rootPath)) {
      fail("M6_GATE_F_ARTIFACT_PATH_INVALID", "tree artifact must not traverse a junction or reparse point", { status: 503 });
    }
  } catch (cause) {
    if (cause instanceof ControlPlaneError) throw cause;
    fail("M6_GATE_F_ARTIFACT_UNAVAILABLE", "tree artifact is unavailable", { status: 503, cause });
  }
  const files = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const target = join(dir, name);
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) fail("M6_GATE_F_ARTIFACT_PATH_INVALID", "tree artifact contains a symbolic link", { status: 503 });
      if (stat.isDirectory()) {
        if (normalizedPath(realpathSync(target)) !== normalizedPath(target)) {
          fail("M6_GATE_F_ARTIFACT_PATH_INVALID", "tree artifact contains a junction or reparse directory", { status: 503 });
        }
        visit(target);
      }
      else if (stat.isFile()) {
        const realTarget = realpathSync(target);
        if (!pathInside(root, realTarget)) fail("M6_GATE_F_ARTIFACT_PATH_INVALID", "tree artifact escaped its root", { status: 503 });
        files.push({
          path: relative(root, realTarget).split(sep).join("/"),
          sha256: sha256(safeRegularBytes(realTarget, "tree artifact file")),
        });
      } else {
        fail("M6_GATE_F_ARTIFACT_PATH_INVALID", "tree artifact contains a non-regular entry", { status: 503 });
      }
    }
  };
  visit(root);
  return sha256(`xw.m6-gate-f-tree.v1:${canonicalJson(files)}`);
}

function validateDescriptor(value, label) {
  const descriptor = exactObject(value, DESCRIPTOR_KEYS, "M6_GATE_F_INVENTORY_INVALID", label);
  if (!ARTIFACT_MODES.has(descriptor.mode) || typeof descriptor.path !== "string" || !isAbsolute(descriptor.path)) {
    fail("M6_GATE_F_INVENTORY_INVALID", `${label} has an unsupported mode or non-absolute path`, { status: 503 });
  }
  return descriptor;
}

export function deriveM6GateFArtifactInventoryHash(inventory) {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) return null;
  const { inventoryHash: _ignored, ...body } = inventory;
  return sha256(`xw.m6-gate-f-artifact-inventory.v1:${canonicalJson(body)}`);
}

export function loadM6GateFArtifactInventory({ path, expectedHash } = {}) {
  if (!HASH.test(expectedHash ?? "")) {
    fail("M6_GATE_F_INVENTORY_HASH_REQUIRED", "a content-addressed Gate-F artifact inventory hash is required", { status: 503 });
  }
  const inventory = safeJson(path, "Gate-F artifact inventory");
  exactObject(inventory, INVENTORY_KEYS, "M6_GATE_F_INVENTORY_INVALID", "Gate-F artifact inventory");
  if (inventory.schemaId !== "xw.m6-gate-f-artifact-inventory.v1"
    || inventory.inventoryHash !== expectedHash
    || deriveM6GateFArtifactInventoryHash(inventory) !== expectedHash) {
    fail("M6_GATE_F_INVENTORY_HASH_MISMATCH", "Gate-F artifact inventory does not match its configured content hash", { status: 503 });
  }
  exactObject(inventory.release, RELEASE_KEYS, "M6_GATE_F_INVENTORY_INVALID", "release binding");
  if (!isAbsolute(inventory.release.root) || !isAbsolute(inventory.release.manifestPath)
    || !pathInside(inventory.release.root, inventory.release.manifestPath)) {
    fail("M6_GATE_F_INVENTORY_INVALID", "release root and manifest must be absolute and nested", { status: 503 });
  }
  exactObject(inventory.lockArtifacts, M6_GATE_V2_LOCK_KINDS, "M6_GATE_F_INVENTORY_INVALID", "lock artifact bindings");
  for (const kind of M6_GATE_V2_LOCK_KINDS) validateDescriptor(inventory.lockArtifacts[kind], `lockArtifacts.${kind}`);
  exactObject(inventory.runtimeArtifacts, RUNTIME_ARTIFACT_KEYS, "M6_GATE_F_INVENTORY_INVALID", "runtime artifact bindings");
  for (const kind of RUNTIME_ARTIFACT_KEYS) validateDescriptor(inventory.runtimeArtifacts[kind], `runtimeArtifacts.${kind}`);
  if (inventory.lockArtifacts.modelProfile.mode !== "LIVE_MODEL_PROFILE"
    || inventory.lockArtifacts.scenarioManifest.mode !== "M6_COHORT_MANIFEST"
    || inventory.lockArtifacts.environmentQualification.mode !== "ENVIRONMENT_QUALIFICATION"
    || inventory.runtimeArtifacts.environmentAttestation.mode !== "TARGET_ENV_ATTESTATION"
    || ["independentOracle", "operator", "resetObligations"]
      .some((kind) => inventory.runtimeArtifacts[kind].mode !== "RAW_SHA256")) {
    fail("M6_GATE_F_INVENTORY_INVALID", "semantic Gate-F artifacts must use their dedicated verifier modes", { status: 503 });
  }
  return Object.freeze(inventory);
}

export function deriveM6GateFArtifactCatalogHash(catalog) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) return null;
  const { catalogHash: _ignored, ...body } = catalog;
  return sha256(`xw.m6-gate-f-artifact-catalog.v1:${canonicalJson(body)}`);
}

function canonicalPathKey(path) {
  const real = realpathSync(path);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

function loadCatalogEntryInventory(entry, catalogRelease, {
  expectedReleaseRoot,
  expectedReleaseManifestPath,
} = {}) {
  const bytes = safeRegularBytes(entry.inventoryPath, `Gate-F inventory for ${entry.purpose}`);
  if (sha256(bytes) !== entry.inventorySha256) {
    fail("M6_GATE_F_CATALOG_INVENTORY_RAW_HASH_MISMATCH", `raw inventory bytes for ${entry.purpose} do not match the catalog`, { status: 503 });
  }
  const inventory = loadM6GateFArtifactInventory({
    path: entry.inventoryPath,
    expectedHash: entry.inventoryHash,
  });
  const manifest = safeJson(inventory.lockArtifacts.scenarioManifest.path, `M6-4 cohort manifest for ${entry.purpose}`);
  const validation = validateM64CohortManifest(manifest);
  if (!validation.ok || manifest.purpose !== entry.purpose || manifest.manifestHash !== entry.scenarioManifestHash) {
    fail("M6_GATE_F_CATALOG_SCENARIO_MISMATCH", `inventory for ${entry.purpose} is rebound to another scenario manifest`, {
      status: 503,
      details: { errors: validation.errors },
    });
  }
  const releaseManifest = safeJson(inventory.release.manifestPath, `release manifest for ${entry.purpose}`);
  if (releaseManifest?.releaseId !== catalogRelease.releaseId
    || releaseManifest?.sourceCommit !== catalogRelease.sourceCommit) {
    fail("M6_GATE_F_CATALOG_RELEASE_MISMATCH", `inventory for ${entry.purpose} crosses the catalog release boundary`, { status: 503 });
  }
  const releaseManifestPathKey = canonicalPathKey(inventory.release.manifestPath);
  const releaseRootPathKey = canonicalPathKey(inventory.release.root);
  if (releaseRootPathKey !== canonicalPathKey(expectedReleaseRoot)
    || releaseManifestPathKey !== canonicalPathKey(expectedReleaseManifestPath)) {
    fail("M6_GATE_F_CATALOG_RELEASE_PROVENANCE_MISMATCH", `inventory for ${entry.purpose} is not bound to the launcher-verified deployed release`, { status: 503 });
  }
  return Object.freeze({
    inventory,
    inventoryPathKey: canonicalPathKey(entry.inventoryPath),
    releaseManifestPathKey,
    releaseRootPathKey,
  });
}

export function loadM6GateFArtifactCatalog({
  path,
  expectedHash,
  expectedReleaseRoot,
  expectedReleaseManifestPath,
} = {}) {
  if (!NONZERO_HASH.test(expectedHash ?? "")) {
    fail("M6_GATE_F_CATALOG_HASH_REQUIRED", "a nonzero content-addressed Gate-F artifact catalog hash is required", { status: 503 });
  }
  if (typeof expectedReleaseRoot !== "string" || !isAbsolute(expectedReleaseRoot)
    || typeof expectedReleaseManifestPath !== "string" || !isAbsolute(expectedReleaseManifestPath)
    || !pathInside(expectedReleaseRoot, expectedReleaseManifestPath)) {
    fail("M6_GATE_F_CATALOG_RELEASE_PROVENANCE_REQUIRED", "Gate-F catalog requires the exact launcher-verified release root and manifest", { status: 503 });
  }
  const catalog = safeJson(path, "Gate-F artifact catalog");
  exactObject(catalog, CATALOG_KEYS, "M6_GATE_F_CATALOG_INVALID", "Gate-F artifact catalog");
  exactObject(catalog.release, CATALOG_RELEASE_KEYS, "M6_GATE_F_CATALOG_INVALID", "Gate-F catalog release binding");
  if (catalog.schemaId !== "xw.m6-gate-f-artifact-catalog.v1"
    || catalog.catalogHash !== expectedHash
    || deriveM6GateFArtifactCatalogHash(catalog) !== expectedHash) {
    fail("M6_GATE_F_CATALOG_HASH_MISMATCH", "Gate-F artifact catalog does not match its configured content hash", { status: 503 });
  }
  if (typeof catalog.release.releaseId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(catalog.release.releaseId)
    || typeof catalog.release.sourceCommit !== "string" || !/^[0-9a-f]{40}$/u.test(catalog.release.sourceCommit)
    || !Array.isArray(catalog.entries)
    || catalog.entries.length !== M6_GATE_F_ARTIFACT_CATALOG_PURPOSES.length) {
    fail("M6_GATE_F_CATALOG_INVALID", "Gate-F artifact catalog release or entry cardinality is invalid", { status: 503 });
  }

  const inventoryHashes = new Set();
  const inventoryPaths = new Set();
  const manifestHashes = new Set();
  let releaseManifestPathKey = null;
  let releaseRootPathKey = null;
  for (let index = 0; index < catalog.entries.length; index += 1) {
    const expectedPurpose = M6_GATE_F_ARTIFACT_CATALOG_PURPOSES[index];
    const entry = exactObject(catalog.entries[index], CATALOG_ENTRY_KEYS, "M6_GATE_F_CATALOG_INVALID", `Gate-F catalog entry ${index}`);
    if (entry.purpose !== expectedPurpose
      || !NONZERO_HASH.test(entry.scenarioManifestHash ?? "")
      || !NONZERO_HASH.test(entry.inventoryHash ?? "")
      || !NONZERO_HASH.test(entry.inventorySha256 ?? "")
      || typeof entry.inventoryPath !== "string" || !isAbsolute(entry.inventoryPath)) {
      fail("M6_GATE_F_CATALOG_ORDER_INVALID", "Gate-F artifact catalog must contain the exact five purposes in frozen order", { status: 503 });
    }
    const loaded = loadCatalogEntryInventory(entry, catalog.release, {
      expectedReleaseRoot,
      expectedReleaseManifestPath,
    });
    if (inventoryHashes.has(entry.inventoryHash) || inventoryPaths.has(loaded.inventoryPathKey)
      || manifestHashes.has(entry.scenarioManifestHash)) {
      fail("M6_GATE_F_CATALOG_DUPLICATE", "Gate-F artifact catalog contains a duplicate inventory or scenario binding", { status: 503 });
    }
    inventoryHashes.add(entry.inventoryHash);
    inventoryPaths.add(loaded.inventoryPathKey);
    manifestHashes.add(entry.scenarioManifestHash);
    releaseManifestPathKey ??= loaded.releaseManifestPathKey;
    releaseRootPathKey ??= loaded.releaseRootPathKey;
    if (loaded.releaseManifestPathKey !== releaseManifestPathKey || loaded.releaseRootPathKey !== releaseRootPathKey) {
      fail("M6_GATE_F_CATALOG_RELEASE_MISMATCH", "all Gate-F inventories must bind the same deployed release root and manifest", { status: 503 });
    }
  }
  return Object.freeze(catalog);
}

export function selectM6GateFArtifactInventory({
  catalog,
  authorization,
  epoch,
  lockSet,
  expectedReleaseRoot,
  expectedReleaseManifestPath,
} = {}) {
  if (!catalog || !authorization || !epoch || !lockSet
    || catalog.release.releaseId !== epoch.releaseId
    || catalog.release.sourceCommit !== epoch.sourceCommit
    || authorization.releaseId !== epoch.releaseId
    || authorization.sourceCommit !== epoch.sourceCommit) {
    fail("M6_GATE_F_CATALOG_RELEASE_MISMATCH", "signed activation, epoch, and artifact catalog must bind one release", { status: 503 });
  }
  if (authorization.purpose !== epoch.purpose
    || authorization.scenarioManifestHash !== lockSet.lockHashes?.scenarioManifest) {
    fail("M6_GATE_F_CATALOG_SELECTION_INVALID", "signed activation purpose and scenario manifest do not match the candidate locks", { status: 503 });
  }
  const matches = catalog.entries.filter((entry) => entry.purpose === authorization.purpose
    && entry.scenarioManifestHash === authorization.scenarioManifestHash);
  if (matches.length !== 1) {
    fail("M6_GATE_F_CATALOG_SELECTION_INVALID", "signed activation must select exactly one catalog inventory", { status: 503 });
  }
  return loadCatalogEntryInventory(matches[0], catalog.release, {
    expectedReleaseRoot,
    expectedReleaseManifestPath,
  }).inventory;
}

function recomputeArtifact(descriptor, expectedHash, { nowMs } = {}) {
  if (!HASH.test(expectedHash ?? "")) fail("M6_GATE_F_LOCK_INVALID", "expected artifact hash is not SHA-256", { status: 503 });
  if (descriptor.mode === "RAW_SHA256") return { hash: sha256(safeRegularBytes(descriptor.path, descriptor.path)) };
  if (descriptor.mode === "TREE_SHA256") return { hash: treeSha256(descriptor.path) };
  if (descriptor.mode === "LIVE_MODEL_PROFILE") {
    let bundle;
    try {
      bundle = loadContentAddressedLiveModelQualificationBundle({
        qualificationRoot: descriptor.path,
        expectedProfileHash: expectedHash,
        now: nowMs,
      });
    } catch (cause) {
      fail("M6_GATE_F_MODEL_PROFILE_UNQUALIFIED", "model profile and its linked health evidence are not deeply Gate-F qualified", {
        status: 503,
        details: { errors: cause?.errors ?? [cause?.code ?? "M6_LIVE_MODEL_BUNDLE_INVALID"] },
        cause,
      });
    }
    return { hash: bundle.profile.contentHash, value: bundle };
  }
  if (descriptor.mode === "M6_COHORT_MANIFEST") {
    const manifest = safeJson(descriptor.path, "M6-4 cohort manifest");
    const validation = validateM64CohortManifest(manifest);
    if (!validation.ok || manifest.manifestHash !== expectedHash) {
      fail("M6_GATE_F_SCENARIO_MANIFEST_INVALID", "scenario manifest is invalid or does not match locks.v2", { status: 503, details: { errors: validation.errors } });
    }
    return { hash: manifest.manifestHash, value: manifest };
  }
  if (descriptor.mode === "TARGET_ENV_ATTESTATION") {
    const record = safeJson(descriptor.path, "target environment attestation");
    const { attestationHash: _ignored, ...body } = record;
    const derived = deriveTargetEnvironmentAttestation(body);
    if (record.attestationHash !== derived.attestationHash || Date.parse(record.expiresAt) <= nowMs) {
      fail("M6_GATE_F_ENVIRONMENT_ATTESTATION_INVALID", "target environment attestation is forged or expired", { status: 503 });
    }
    return { hash: derived.attestationHash, value: record };
  }
  if (descriptor.mode === "ENVIRONMENT_QUALIFICATION") {
    const bytes = safeRegularBytes(descriptor.path, "environment qualification");
    let record;
    try { record = JSON.parse(bytes.toString("utf8")); } catch (cause) {
      fail("M6_GATE_F_ENVIRONMENT_QUALIFICATION_INVALID", "environment qualification is malformed", { status: 503, cause });
    }
    const capturedAtMs = Date.parse(record?.capturedAt ?? "");
    const expiresAtMs = Date.parse(record?.expiresAt ?? "");
    if (canonicalJson(Object.keys(record ?? {}).sort()) !== canonicalJson([...ENVIRONMENT_QUALIFICATION_KEYS].sort())
      || record?.schemaId !== "xw.m6-environment-qualification.v1"
      || record.status !== "QUALIFIED" || record.gateFEligible !== true
      || record.alias !== "01" || record.effectBoundary !== "READ_ONLY"
      || record.commandRegistryHash !== deriveM64TargetEnvironmentCommandRegistryHash()
      || !Array.isArray(record.qualifiedAttestationHashes)
      || record.qualifiedAttestationHashes.length !== 1
      || record.qualifiedAttestationHashes.some((hash) => !HASH.test(hash))
      || new Set(record.qualifiedAttestationHashes).size !== record.qualifiedAttestationHashes.length
      || record.sampleCount !== 2 || record.secretMaterialPresent !== false
      || record.rawDeviceIdentityPresent !== false || record.actionCount !== 0
      || !Number.isFinite(capturedAtMs) || !Number.isFinite(expiresAtMs)
      || capturedAtMs > nowMs || expiresAtMs <= capturedAtMs || expiresAtMs <= nowMs
      || expiresAtMs - capturedAtMs !== M6_TARGET_ENVIRONMENT_QUALIFICATION_TTL_MS) {
      fail("M6_GATE_F_ENVIRONMENT_QUALIFICATION_INVALID", "environment qualification is not the exact unexpired read-only double-sample record", { status: 503 });
    }
    return { hash: sha256(bytes), value: record };
  }
  fail("M6_GATE_F_ARTIFACT_MODE_INVALID", "unsupported Gate-F artifact verifier mode", { status: 503 });
}

function verifyReleaseBinding(release, epoch) {
  const manifestBytes = safeRegularBytes(release.manifestPath, "release manifest");
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch (cause) {
    fail("M6_GATE_F_RELEASE_INVALID", "release manifest is malformed", { status: 503, cause });
  }
  const verification = verifyReleaseManifest({ manifestPath: release.manifestPath, root: release.root });
  if (!verification.ok || manifest.releaseId !== epoch.releaseId || manifest.sourceCommit !== epoch.sourceCommit) {
    fail("M6_GATE_F_RELEASE_MISMATCH", "deployed release content does not match the candidate epoch", { status: 503, details: { mismatches: verification.mismatches } });
  }
  return Object.freeze({ manifest, releaseHash: sha256(manifestBytes) });
}

function verifyActualArtifacts({ inventory, lockSet, epoch, authorization, nowMs }) {
  if (!lockSet || lockSet.lockSetHash !== epoch.lockSetRef?.sha256
    || deriveM6V2LockSetHash(lockSet) !== lockSet.lockSetHash) {
    fail("M6_GATE_F_LOCK_MISMATCH", "candidate locks.v2 record is absent, forged, or rebound", { status: 503 });
  }
  const computed = {};
  let qualification;
  for (const kind of M6_GATE_V2_LOCK_KINDS) {
    const result = recomputeArtifact(inventory.lockArtifacts[kind], lockSet.lockHashes?.[kind], { nowMs });
    if (result.hash !== lockSet.lockHashes[kind]) {
      fail("M6_GATE_F_LOCK_MISMATCH", `actual ${kind} artifact does not match locks.v2`, { status: 503 });
    }
    computed[kind] = result;
    if (kind === "environmentQualification") qualification = result.value;
  }
  const environment = recomputeArtifact(inventory.runtimeArtifacts.environmentAttestation, "0".repeat(64), { nowMs });
  if (!qualification.qualifiedAttestationHashes.includes(environment.hash)
    || qualification.capturedAt !== environment.value.capturedAt
    || qualification.expiresAt !== environment.value.expiresAt) {
    fail("M6_GATE_F_ENVIRONMENT_NOT_QUALIFIED", "current target environment is outside the frozen qualification set", { status: 503 });
  }
  const modelBundle = computed.modelProfile?.value;
  const modelValidation = validateQualifiedLiveModelBundle(modelBundle, {
    expectedProfileHash: lockSet.lockHashes.modelProfile,
    requiredTargetEnvironmentAttestationHash: environment.hash,
    requiredLiveWindowExpiresAt: authorization?.expiresAt,
    now: nowMs,
  });
  if (!modelValidation.ok) {
    fail("M6_GATE_F_MODEL_PROFILE_UNQUALIFIED", "model qualification is stale or rebound from the exact target environment/live window", {
      status: 503,
      details: { errors: modelValidation.errors },
    });
  }
  const release = verifyReleaseBinding(inventory.release, epoch);
  const operatorHash = recomputeArtifact(inventory.runtimeArtifacts.operator, sha256(safeRegularBytes(inventory.runtimeArtifacts.operator.path, "operator artifact")), { nowMs }).hash;
  const independentOracleHash = recomputeArtifact(inventory.runtimeArtifacts.independentOracle, sha256(safeRegularBytes(inventory.runtimeArtifacts.independentOracle.path, "independent oracle")), { nowMs }).hash;
  const resetObligationsHash = recomputeArtifact(inventory.runtimeArtifacts.resetObligations, sha256(safeRegularBytes(inventory.runtimeArtifacts.resetObligations.path, "reset obligations")), { nowMs }).hash;
  return Object.freeze({
    computed,
    environmentAttestationHash: environment.hash,
    independentOracleHash,
    operatorHash,
    release,
    resetObligationsHash,
  });
}

function closeBinding(loaded, epoch, reasonCode) {
  const closeout = loaded.closeouts?.[epoch.closeoutRef?.id];
  const aggregate = loaded.aggregates?.[epoch.aggregateSealRef?.id];
  if (!closeout || !aggregate || closeout.closeoutHash !== epoch.closeoutRef?.sha256
    || aggregate.sealHash !== epoch.aggregateSealRef?.sha256
    || closeout.epochHash !== epoch.parentEpochHash
    || aggregate.epochHash !== epoch.parentEpochHash
    || closeout.reason !== reasonCode) {
    fail("M6_GATE_F_CLOSEOUT_MISMATCH", "CLOSED candidate is not bound to the active epoch, exact reason, and aggregate", { status: 409 });
  }
  return { aggregate, closeout };
}

function verifyNormalCloseAggregate({ aggregate, authorization, lockSet, parent, parentGeneration, state, issuerAllowlistPath }) {
  const cohort = aggregate.sealPayload?.cohortAggregate;
  const validation = validateM64CohortAggregate(cohort);
  const consumption = state.getM64LiveWindowAuthorizationConsumption?.(authorization?.authorizationId);
  if (!consumption) {
    fail("M6_GATE_F_NORMAL_CLOSE_AUTHORIZATION_MISSING", "normal close requires the exact durably consumed live-window authorization");
  }
  verifyM64LiveWindowAuthorization({
    authorization,
    issuerAllowlist: loadM64LiveWindowIssuerAllowlist(issuerAllowlistPath),
    runtime: selectM64LiveWindowRuntimeBinding(authorization),
    nowMs: Date.parse(consumption.consumedAt),
  });
  if (!validation.ok || consumption.bodyHash !== authorization.bodyHash
    || consumption.envelopeHash !== authorization.envelopeHash
    || consumption.gateEpochHash !== parent.epochHash
    || consumption.gateGeneration !== parentGeneration
    || consumption.purpose !== parent.purpose
    || consumption.locksHash !== parent.lockSetRef.sha256
    || cohort?.purpose !== parent.purpose || cohort?.alias !== "01"
    || cohort?.manifestHash !== lockSet.lockHashes.scenarioManifest
    || cohort?.gateEpochHash !== parent.epochHash
    || cohort?.liveAuthorizationHash !== authorization.envelopeHash) {
    fail("M6_GATE_F_NORMAL_CLOSE_AGGREGATE_INVALID", "normal close aggregate is invalid or cross-bound", {
      details: { errors: validation.errors },
    });
  }
}

function publicStage(epoch) {
  if (!epoch || epoch.mode === "CLOSED") return "CLOSED";
  return epoch.mode === "OBSERVE_ONLY" ? "GROUNDING_ONLY" : "GROUNDED_ACTION";
}

export function loadM6GateFOperationsConfigFromEnv({ env = process.env } = {}) {
  return Object.freeze({
    runtimeMode: env.XW_M6_RUNTIME_MODE ?? null,
    internalToken: env.XW_M6_GATE_F_OPERATIONS_TOKEN ?? null,
    m6Root: env.XW_RUNTIME_ROOT ?? null,
    gateId: env.XW_GATE_ID ?? null,
    issuerAllowlistPath: env.XW_GATE_ISSUER_KEYS_PATH ?? null,
    liveWindowIssuerAllowlistPath: env.XW_M6_LIVE_AUTH_ISSUER_KEYS_PATH ?? null,
    artifactCatalogPath: env.XW_M6_GATE_F_ARTIFACT_CATALOG_PATH ?? null,
    artifactCatalogHash: env.XW_M6_GATE_F_ARTIFACT_CATALOG_HASH ?? null,
    sourceReleaseRoot: env.XW_M6_SOURCE_RELEASE_ROOT ?? null,
    sourceReleaseManifestPath: env.XW_RELEASE_MANIFEST ?? null,
    artifactInventoryPath: env.XW_M6_GATE_F_ARTIFACT_INVENTORY_PATH ?? null,
    artifactInventoryHash: env.XW_M6_GATE_F_ARTIFACT_INVENTORY_HASH ?? null,
  });
}

export function createM6GateFOperations({
  state,
  config = {},
  now = Date.now,
  faultAfterForOperation = () => null,
  activeRunCount = () => 0,
} = {}) {
  const blockers = [];
  const finalRuntime = config.runtimeMode === "FINAL" || state?.m6RuntimeMode === "FINAL";
  if (!state || typeof state.getM6GateFence !== "function"
    || typeof state.getM6GateFResourceCounts !== "function") blockers.push("M6_GATE_F_STATE_STORE_UNAVAILABLE");
  if (finalRuntime && typeof state?.getM6GateSafetyCloseArm !== "function") {
    blockers.push("M6_GATE_F_SAFETY_CLOSE_ARM_UNAVAILABLE");
  }
  if (typeof activeRunCount !== "function") blockers.push("M6_GATE_F_RUN_AUDIT_UNAVAILABLE");
  if (typeof config.internalToken !== "string" || config.internalToken.length < 32 || /[\0\r\n]/u.test(config.internalToken)) {
    blockers.push("M6_GATE_F_OPERATIONS_TOKEN_UNAVAILABLE");
  }
  for (const [name, value] of Object.entries({
    m6Root: config.m6Root,
    issuerAllowlistPath: config.issuerAllowlistPath,
    liveWindowIssuerAllowlistPath: config.liveWindowIssuerAllowlistPath,
  })) {
    if (typeof value !== "string" || !isAbsolute(value)) blockers.push(`M6_GATE_F_${name.replace(/[A-Z]/gu, (c) => `_${c}`).toUpperCase()}_UNAVAILABLE`);
  }
  if (typeof config.gateId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(config.gateId)) blockers.push("M6_GATE_F_GATE_ID_UNAVAILABLE");
  const catalogConfigured = config.artifactCatalogPath !== undefined && config.artifactCatalogPath !== null
    || config.artifactCatalogHash !== undefined && config.artifactCatalogHash !== null;
  const legacyInventoryConfigured = config.artifactInventoryPath !== undefined && config.artifactInventoryPath !== null
    || config.artifactInventoryHash !== undefined && config.artifactInventoryHash !== null;
  if (catalogConfigured && legacyInventoryConfigured) blockers.push("M6_GATE_F_ARTIFACT_SOURCE_AMBIGUOUS");
  if (finalRuntime && legacyInventoryConfigured) blockers.push("M6_GATE_F_ARTIFACT_CATALOG_REQUIRED");
  if (catalogConfigured) {
    if (typeof config.artifactCatalogPath !== "string" || !isAbsolute(config.artifactCatalogPath)) blockers.push("M6_GATE_F_ARTIFACT_CATALOG_PATH_UNAVAILABLE");
    if (!NONZERO_HASH.test(config.artifactCatalogHash ?? "")) blockers.push("M6_GATE_F_ARTIFACT_CATALOG_HASH_UNAVAILABLE");
    if (typeof config.sourceReleaseRoot !== "string" || !isAbsolute(config.sourceReleaseRoot)) blockers.push("M6_GATE_F_SOURCE_RELEASE_ROOT_UNAVAILABLE");
    if (typeof config.sourceReleaseManifestPath !== "string" || !isAbsolute(config.sourceReleaseManifestPath)
      || (typeof config.sourceReleaseRoot === "string" && isAbsolute(config.sourceReleaseRoot)
        && !pathInside(config.sourceReleaseRoot, config.sourceReleaseManifestPath))) {
      blockers.push("M6_GATE_F_SOURCE_RELEASE_MANIFEST_UNAVAILABLE");
    }
  } else if (legacyInventoryConfigured) {
    if (typeof config.artifactInventoryPath !== "string" || !isAbsolute(config.artifactInventoryPath)) blockers.push("M6_GATE_F_ARTIFACT_INVENTORY_PATH_UNAVAILABLE");
    if (!HASH.test(config.artifactInventoryHash ?? "")) blockers.push("M6_GATE_F_ARTIFACT_INVENTORY_HASH_UNAVAILABLE");
  } else {
    blockers.push("M6_GATE_F_ARTIFACT_SOURCE_UNAVAILABLE");
  }

  function assertSealed() {
    if (blockers.length > 0) fail("M6_GATE_F_OPERATIONS_UNSEALED", "Gate-F operations are not sealed", {
      status: 503,
      details: { blockers: [...new Set(blockers)].sort(), resourceCount: 0 },
    });
  }

  function assertAuthorized(headers = {}) {
    const expected = config.internalToken;
    if (typeof expected !== "string" || expected.length < 32 || /[\0\r\n]/u.test(expected)) {
      fail("M6_GATE_F_OPERATIONS_UNSEALED", "Gate-F operations token is unavailable", { status: 503, details: { resourceCount: 0 } });
    }
    const actual = headers["x-control-token"] ?? headers["X-Control-Token"];
    if (typeof actual !== "string") fail("M6_GATE_F_ACCESS_DENIED", "Gate-F operations require X-Control-Token", { status: 403 });
    const left = createHash("sha256").update(expected).digest();
    const right = createHash("sha256").update(actual).digest();
    if (!timingSafeEqual(left, right)) fail("M6_GATE_F_ACCESS_DENIED", "Gate-F operations token is invalid", { status: 403 });
    return true;
  }

  function loadCurrent({
    safetyClosePackage = null,
    activationRecoveryPackage = null,
    allowTerminalArmFallback = false,
  } = {}) {
    assertSealed();
    const fence = state.getM6GateFence();
    try {
      const loaded = loadM6Gate({
        m6Root: config.m6Root,
        gateId: config.gateId,
        issuerAllowlistPath: config.issuerAllowlistPath,
        requireLocks: true,
      });
      return { loaded, fence };
    } catch (cause) {
      if (!String(cause?.code ?? "").startsWith("M6_GATE_ISSUER_")) throw cause;
      const activationRecoveryArm = activationRecoveryPackage
        && fence?.epochHash === activationRecoveryPackage?.epoch?.epochHash
        ? state.getM6GateSafetyCloseArm?.(activationRecoveryPackage.epoch.epochHash)
        : null;
      const fallbackArm = safetyClosePackage
        ? state.getM6GateSafetyCloseArm?.(safetyClosePackage?.epoch?.parentEpochHash)
        : activationRecoveryArm
          ? activationRecoveryArm
          : allowTerminalArmFallback
            ? (fence?.mode === "CLOSED"
              ? state.getM6GateSafetyCloseArmByTerminalEpoch?.(fence.epochHash)
              : state.getM6GateSafetyCloseArm?.(fence?.epochHash))
            : null;
      if (!fallbackArm) throw cause;
      const fallbackStatuses = safetyClosePackage
        ? (fence?.epochHash === safetyClosePackage?.epoch?.epochHash ? ["CONSUMED"] : ["ARMED"])
        : activationRecoveryArm ? ["ARMED"]
          : fence?.mode === "CLOSED" ? ["CONSUMED", "RELEASED"] : ["ARMED"];
      const safetyCloseLoadAuthority = createM6GateFSafetyCloseLoadAuthority(fallbackArm, {
        allowStatuses: fallbackStatuses,
        activationRecovery: activationRecoveryArm
          ? { epoch: activationRecoveryPackage.epoch, proof: activationRecoveryPackage.proof }
          : null,
      });
      const loaded = loadM6Gate({
        m6Root: config.m6Root,
        gateId: config.gateId,
        issuerAllowlistPath: config.issuerAllowlistPath,
        requireLocks: true,
        safetyCloseLoadAuthority,
      });
      if (safetyClosePackage) {
        assertM6GateFSafetyCloseArmMatchesPackage(fallbackArm, safetyClosePackage, {
          allowStatuses: fallbackStatuses,
        });
        const pointerTail = loaded.chain.at(-1);
        const dbAheadOfPointer = fence?.epochHash === safetyClosePackage.epoch.epochHash
          && pointerTail?.epochHash === safetyClosePackage.epoch.parentEpochHash
          && fence.generation === loaded.currentPointer?.generation + 1
          && fence.gateId === safetyClosePackage.epoch.gateId
          && fence.mode === "CLOSED"
          && fence.purpose === safetyClosePackage.epoch.purpose
          && fence.releaseId === safetyClosePackage.epoch.releaseId
          && fence.sourceCommit === safetyClosePackage.epoch.sourceCommit
          && fence.locksHash === safetyClosePackage.epoch.lockSetRef?.sha256
          && canonicalJson(fence.allowlist) === canonicalJson(safetyClosePackage.epoch.allowlist);
        if (!dbAheadOfPointer) {
          assertM6FileDbPointerConsistency({ loaded, fence, pointer: loaded.currentPointer });
        }
        return { loaded, fence };
      }
      if (activationRecoveryArm) {
        assertM6GateFSafetyCloseArmMatchesPackage(
          activationRecoveryArm,
          activationRecoveryPackage.safetyClosePackage,
          { allowStatuses: ["ARMED"] },
        );
        const pointerTail = loaded.chain.at(-1);
        const epoch = activationRecoveryPackage.epoch;
        const dbAheadOfPointer = pointerTail?.epochHash === epoch.parentEpochHash
          && fence.generation === loaded.currentPointer?.generation + 1
          && fence.gateId === epoch.gateId
          && fence.epochHash === epoch.epochHash
          && fence.mode === epoch.mode
          && fence.purpose === epoch.purpose
          && fence.releaseId === epoch.releaseId
          && fence.sourceCommit === epoch.sourceCommit
          && fence.locksHash === epoch.lockSetRef?.sha256
          && canonicalJson(fence.allowlist) === canonicalJson(epoch.allowlist);
        if (!dbAheadOfPointer) {
          fail("M6_GATE_SAFETY_CLOSE_LOAD_AUTHORITY_MISMATCH", "activation recovery arm does not bind the DB-ahead Gate fence", { status: 503 });
        }
        return { loaded, fence };
      }
      if (allowTerminalArmFallback) {
        assertM6FileDbPointerConsistency({ loaded, fence, pointer: loaded.currentPointer });
        const tail = loaded.chain.at(-1);
        const activeEpoch = tail?.mode === "CLOSED" ? loaded.chain.at(-2) : tail;
        const arm = fallbackArm;
        const trusted = tail?.mode === "CLOSED"
          ? ["CONSUMED", "RELEASED"].includes(arm?.status) && arm.terminalEpochHash === tail.epochHash
          : arm?.status === "ARMED" && arm.activeEpochHash === tail?.epochHash;
        if (trusted) return { loaded, fence };
      }
      throw cause;
    }
  }

  function resourceAudit() {
    const persistedResources = state.getM6GateFResourceCounts();
    const runs = activeRunCount();
    if (![persistedResources?.jobs, persistedResources?.leases, persistedResources?.sessions,
      persistedResources?.actionCount, runs].every((value) => Number.isSafeInteger(value) && value >= 0)) {
      fail("M6_GATE_F_RESOURCE_AUDIT_INVALID", "Gate-F resource audit did not return exact non-negative counters", { status: 503 });
    }
    return Object.freeze({
      actionCount: persistedResources.actionCount,
      resourceCounts: Object.freeze({
        jobs: persistedResources.jobs,
        leases: persistedResources.leases,
        runs,
        sessions: persistedResources.sessions,
      }),
    });
  }

  function status() {
    let { loaded, fence } = loadCurrent({ allowTerminalArmFallback: true });
    const audit = resourceAudit();
    let evaluationNowMs = now();
    const initialTail = loaded.chain.at(-1) ?? null;
    const terminalArm = initialTail?.mode === "CLOSED"
      ? state.getM6GateSafetyCloseArmByTerminalEpoch?.(initialTail.epochHash) ?? null
      : null;
    if (terminalArm) {
      // A terminal arm is a durable reduction of authority. Re-load through
      // its proof-hash authority even while issuers are still active, so status
      // cannot silently stop checking the activation/terminal proofs. An
      // emergency close is evaluated at its verified arm time because expiry
      // after arming must never resurrect or make ambiguous an already CLOSED
      // generation.
      const terminalAuthority = createM6GateFSafetyCloseLoadAuthority(terminalArm, {
        allowStatuses: ["CONSUMED", "RELEASED"],
      });
      loaded = loadM6Gate({
        m6Root: config.m6Root,
        gateId: config.gateId,
        issuerAllowlistPath: config.issuerAllowlistPath,
        requireLocks: true,
        safetyCloseLoadAuthority: terminalAuthority,
      });
      evaluationNowMs = Date.parse(
        terminalArm.status === "CONSUMED" ? terminalArm.armedAt : terminalArm.terminalizedAt,
      );
      if (!Number.isFinite(evaluationNowMs)) {
        fail("M6_GATE_SAFETY_CLOSE_TERMINAL_MISMATCH", "terminal safety-close arm has no valid verification clock");
      }
    }
    let tripleConsistent = false;
    let tripleError = null;
    try {
      assertM6FileDbPointerConsistency({ loaded, fence, pointer: loaded.currentPointer });
      tripleConsistent = true;
    } catch (error) { tripleError = error?.code ?? "M6_GATE_TRIPLE_MISMATCH"; }
    const tail = loaded.chain.at(-1) ?? null;
    const evaluation = tripleConsistent ? evaluateM6MixedGate({
      ...loaded,
      nowMs: evaluationNowMs,
      expectedRelease: tail ? { releaseId: tail.releaseId, sourceCommit: tail.sourceCommit } : null,
      v1LockHashes: loaded.lockHashes,
    }) : { mode: "CLOSED", purpose: null, errors: [{ code: tripleError }] };
    return Object.freeze({
      schemaId: "xw.m6-gate-f-operations-status.v1",
      mode: tripleConsistent && evaluation.errors.length === 0 ? evaluation.mode : "CLOSED",
      phase: tripleConsistent && evaluation.errors.length === 0 ? publicStage(tail) : "FAIL_CLOSED",
      purpose: tripleConsistent && evaluation.errors.length === 0 ? evaluation.purpose : null,
      epochHash: tripleConsistent ? tail?.epochHash ?? null : null,
      generation: tripleConsistent ? fence?.generation ?? null : null,
      locksHash: tripleConsistent ? fence?.locksHash ?? null : null,
      tripleConsistent,
      errors: evaluation.errors,
      activeAuthorizationCount: tail?.mode === "CLOSED" ? 0 : 1,
      actionCount: audit.actionCount,
      resourceCounts: audit.resourceCounts,
    });
  }

  function normalizePackage(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail("M6_GATE_F_INPUT_CLOSED", "Gate-F operation package must be an object", { status: 400 });
    }
    const hasSafetyClosePackage = Object.hasOwn(value, "safetyClosePackage");
    const expectedKeys = value.operation === "ACTIVATE" && hasSafetyClosePackage
      ? ACTIVATION_PACKAGE_KEYS
      : PACKAGE_KEYS;
    const input = exactObject(value, expectedKeys, "M6_GATE_F_INPUT_CLOSED", "Gate-F operation package");
    if (!OPERATIONS.has(input.operation) || (input.phase !== null && !PHASES.has(input.phase))
      || !input.epoch || typeof input.epoch !== "object" || Array.isArray(input.epoch)
      || !input.proof || typeof input.proof !== "object" || Array.isArray(input.proof)) {
      fail("M6_GATE_F_INPUT_INVALID", "Gate-F operation package has invalid operation, phase, epoch, or proof", { status: 400 });
    }
    const active = input.operation === "ACTIVATE";
    const normalClose = input.operation === "NORMAL_CLOSE";
    const authorizationRequired = active || normalClose;
    if (authorizationRequired !== Boolean(input.authorization && typeof input.authorization === "object" && !Array.isArray(input.authorization))
      || active !== (input.reasonCode === null) || active !== PHASES.has(input.phase)
      || (!active && input.phase !== null)) {
      fail("M6_GATE_F_INPUT_INVALID", "ACTIVATE requires phase+owner authorization; NORMAL_CLOSE requires the consumed owner authorization; EMERGENCY_CLOSE requires no owner envelope", { status: 400 });
    }
    if (!active && (typeof input.reasonCode !== "string"
      || !/^[A-Z][A-Z0-9_]{2,63}$/u.test(input.reasonCode))) {
      fail("M6_GATE_F_INPUT_INVALID", "close reasonCode must be a bounded uppercase code", { status: 400 });
    }
    if (active && hasSafetyClosePackage
      && (!input.safetyClosePackage || typeof input.safetyClosePackage !== "object" || Array.isArray(input.safetyClosePackage))) {
      fail("M6_GATE_SAFETY_CLOSE_PACKAGE_INVALID", "ACTIVATE safetyClosePackage must be an exact object", { status: 400 });
    }
    if (active && finalRuntime && !hasSafetyClosePackage) {
      fail("M6_GATE_SAFETY_CLOSE_REQUIRED", "FINAL ACTIVATE requires a pre-signed safetyClosePackage", { status: 400 });
    }
    return input;
  }

  function prepare(value, { reconcile = false } = {}) {
    assertSealed();
    const input = normalizePackage(value);
    const { loaded, fence } = loadCurrent({
      safetyClosePackage: input.operation === "EMERGENCY_CLOSE" ? input : null,
      activationRecoveryPackage: reconcile && input.operation === "ACTIVATE" ? input : null,
    });
    if (!reconcile) assertM6FileDbPointerConsistency({ loaded, fence, pointer: loaded.currentPointer });
    const pointerHasCandidate = loaded.tailEpochHash === input.epoch.epochHash;
    const recoveringCommittedActivation = reconcile && input.operation === "ACTIVATE"
      && fence.epochHash === input.epoch.epochHash;
    const parent = pointerHasCandidate ? loaded.chain.at(-2) : loaded.chain.at(-1);
    if (!parent || parent.epochHash !== input.epoch.parentEpochHash) {
      fail("M6_GATE_F_TRANSITION_INVALID", "candidate does not append to the verified current epoch");
    }
    const safetyCloseArm = input.operation === "EMERGENCY_CLOSE"
      ? state.getM6GateSafetyCloseArm?.(parent.epochHash)
      : null;
    if (safetyCloseArm) {
      assertM6GateFSafetyCloseArmMatchesPackage(safetyCloseArm, input, {
        allowStatuses: fence.epochHash === input.epoch.epochHash ? ["CONSUMED"] : ["ARMED"],
      });
    }
    if (input.operation === "ACTIVATE") {
      const expectedMode = input.phase === "GROUNDING_ONLY" ? "OBSERVE_ONLY" : "GROUNDED_ACTION";
      const allowedPurpose = input.phase === "GROUNDING_ONLY" ? GROUNDING_PURPOSES : ACTION_PURPOSES;
      const parentModeAllowed = parent.mode === "CLOSED"
        || (input.phase === "GROUNDED_ACTION" && parent.mode === "OBSERVE_ONLY");
      if (input.epoch.mode !== expectedMode || !allowedPurpose.has(input.epoch.purpose)
        || !parentModeAllowed || canonicalJson(input.epoch.allowlist) !== canonicalJson(["01"])) {
        fail("M6_GATE_F_TRANSITION_INVALID", `${input.phase} candidate violates the frozen mode/purpose/alias transition`);
      }
      if (!recoveringCommittedActivation) {
        const audit = resourceAudit();
        if (audit.actionCount !== 0 || Object.values(audit.resourceCounts).some((count) => count !== 0)) {
          fail("M6_GATE_F_RESOURCES_NOT_ZERO", "Gate-F activation requires zero jobs, sessions, leases, runs, and unresolved actions", {
            status: 409,
            details: { actionCount: audit.actionCount, resourceCounts: audit.resourceCounts },
          });
        }
      }
    } else {
      if (input.epoch.mode !== "CLOSED" || parent.mode === "CLOSED"
        || input.epoch.purpose !== parent.purpose
        || input.epoch.lockSetRef?.sha256 !== parent.lockSetRef?.sha256
        || input.epoch.releaseId !== parent.releaseId
        || input.epoch.sourceCommit !== parent.sourceCommit
        || input.epoch.actor !== parent.actor
        || canonicalJson(input.epoch.allowlist) !== canonicalJson(parent.allowlist)) {
        fail("M6_GATE_F_TRANSITION_INVALID", "close candidate must seal the exact active purpose and locks.v2 generation");
      }
    }
    const lockSet = loaded.lockSets?.[input.epoch.lockSetRef?.id] ?? null;
    if (!lockSet || lockSet.lockSetHash !== input.epoch.lockSetRef?.sha256
      || deriveM6V2LockSetHash(lockSet) !== lockSet.lockSetHash) {
      fail("M6_GATE_F_LOCK_MISMATCH", "candidate locks.v2 record is absent, forged, or rebound", { status: 503 });
    }
    if (input.operation !== "ACTIVATE") {
      const close = closeBinding(loaded, input.epoch, input.reasonCode);
      if (input.operation === "NORMAL_CLOSE") {
        const parentGeneration = pointerHasCandidate
          ? loaded.currentPointer.generation - 1
          : loaded.currentPointer.generation;
        verifyNormalCloseAggregate({
          aggregate: close.aggregate,
          authorization: input.authorization,
          lockSet,
          parent,
          parentGeneration,
          state,
          issuerAllowlistPath: config.liveWindowIssuerAllowlistPath,
        });
      }
    }
    let catalog = null;
    let inventory = null;
    if (input.operation === "ACTIVATE" && !recoveringCommittedActivation) {
      if (catalogConfigured && !legacyInventoryConfigured) {
        catalog = loadM6GateFArtifactCatalog({
          path: config.artifactCatalogPath,
          expectedHash: config.artifactCatalogHash,
          expectedReleaseRoot: config.sourceReleaseRoot,
          expectedReleaseManifestPath: config.sourceReleaseManifestPath,
        });
        inventory = selectM6GateFArtifactInventory({
          catalog,
          authorization: input.authorization,
          epoch: input.epoch,
          lockSet,
          expectedReleaseRoot: config.sourceReleaseRoot,
          expectedReleaseManifestPath: config.sourceReleaseManifestPath,
        });
      } else {
        inventory = loadM6GateFArtifactInventory({
          path: config.artifactInventoryPath,
          expectedHash: config.artifactInventoryHash,
        });
      }
    }
    // Emergency close must remain executable when a provider, model, target
    // environment, or qualification artifact has failed. Full actual-artifact
    // closure is therefore an activation precondition, never a close dependency.
    const actual = input.operation === "ACTIVATE" && !recoveringCommittedActivation
      ? verifyActualArtifacts({ inventory, lockSet, epoch: input.epoch, authorization: input.authorization, nowMs: now() })
      : null;
    const emergencyRef = input.operation === "ACTIVATE" ? input.epoch.emergencyCloseAuthorizationRef : parent.emergencyCloseAuthorizationRef;
    const emergency = loaded.emergencyCloseAuthorizations?.[emergencyRef?.id] ?? null;
    if (!emergency || emergency.authorizationHash !== emergencyRef?.sha256
      || deriveM6EmergencyCloseAuthorizationHash(emergency) !== emergency.authorizationHash) {
      fail("M6_GATE_EMERGENCY_CLOSE_INVALID", "active transition lacks an exact immutable emergency-close authorization");
    }
    if (input.operation === "ACTIVATE" && input.safetyClosePackage) {
      closeBinding(loaded, input.safetyClosePackage.epoch, input.safetyClosePackage.reasonCode);
    }
    const generation = fence.epochHash === input.epoch.epochHash
      ? fence.generation
      : loaded.currentPointer.generation + 1;
    const runtime = recoveringCommittedActivation
      ? Object.freeze(selectM64LiveWindowRuntimeBinding(input.authorization))
      : input.operation === "ACTIVATE" ? Object.freeze({
        alias: "01",
        releaseId: input.epoch.releaseId,
        releaseHash: actual.release.releaseHash,
        sourceCommit: input.epoch.sourceCommit,
        gateId: input.epoch.gateId,
        gateEpochHash: input.epoch.epochHash,
        gateGeneration: generation,
        purpose: input.epoch.purpose,
        scenarioManifestHash: lockSet.lockHashes.scenarioManifest,
        runtimeProfileHash: lockSet.lockHashes.runtimeProfile,
        modelProfileHash: lockSet.lockHashes.modelProfile,
        providerHash: lockSet.lockHashes.liveProvider,
        toolProfileHash: lockSet.lockHashes.liveToolSpec,
        policyHash: lockSet.lockHashes.grantActionPolicy,
        locksHash: lockSet.lockSetHash,
        environmentAttestationHash: actual.environmentAttestationHash,
        operatorHash: actual.operatorHash,
        emergencyCloseAuthorizationHash: emergency.authorizationHash,
        emergencyCloseReasonCodeAllowlist: emergency.reasonCodeAllowlist,
        closeoutGraceMs: Date.parse(emergency.expiresAt) - Date.parse(input.epoch.expiresAt),
        effectBoundary: "BOUNDED_READ_TRACE",
        independentOracleHash: actual.independentOracleHash,
        resetObligationsHash: actual.resetObligationsHash,
      }) : null;
    const candidateChain = pointerHasCandidate ? loaded.chain : [...loaded.chain, input.epoch];
    // Expiry is an arming-time qualification for the exact pre-signed close
    // package. Once atomically armed, replaying that exact close is a reduction
    // of authority and must remain possible even if the active window runs past
    // its deadline. Evaluate the immutable candidate at the verified arm time;
    // every unarmed/legacy transition continues to use the current clock.
    const evaluationNowMs = safetyCloseArm ? Date.parse(safetyCloseArm.armedAt ?? "") : now();
    if (!Number.isFinite(evaluationNowMs)) {
      fail("M6_GATE_SAFETY_CLOSE_ARM_INVALID", "safety-close arm has no valid activation-time verification clock");
    }
    const evaluation = evaluateM6MixedGate({
      ...loaded,
      chain: candidateChain,
      nowMs: evaluationNowMs,
      expectedRelease: { releaseId: input.epoch.releaseId, sourceCommit: input.epoch.sourceCommit },
      v1LockHashes: loaded.lockHashes,
    });
    if (evaluation.errors.length > 0 || evaluation.mode !== input.epoch.mode) {
      fail("M6_GATE_F_CANDIDATE_INVALID", "candidate chain does not evaluate to its signed mode", { details: { errors: evaluation.errors } });
    }
    const promoterInput = {
      state,
      m6Root: config.m6Root,
      gateId: config.gateId,
      epoch: input.epoch,
      proof: input.proof,
      issuerAllowlistPath: config.issuerAllowlistPath,
      promotedAt: new Date(now()).toISOString(),
      emergencyClose: input.operation === "EMERGENCY_CLOSE" ? { reasonCode: input.reasonCode } : null,
      liveWindowAuthorization: input.authorization,
      liveWindowIssuerAllowlistPath: config.liveWindowIssuerAllowlistPath,
      liveWindowRuntime: runtime,
      safetyClosePackage: input.operation === "ACTIVATE"
        ? input.safetyClosePackage ?? null
        : input.operation === "EMERGENCY_CLOSE" ? input : null,
      requireSafetyCloseArm: finalRuntime,
    };
    return Object.freeze({ catalog, input, inventory, promoterInput, runtime });
  }

  function preflight(value) {
    const prepared = prepare(value);
    const result = preflightM6GateEpochPromotion(prepared.promoterInput);
    return Object.freeze({
      ...result,
      requestedPhase: prepared.input.phase,
      operation: prepared.input.operation,
      artifactCatalogHash: prepared.catalog?.catalogHash ?? config.artifactCatalogHash ?? null,
      artifactInventoryHash: prepared.inventory?.inventoryHash ?? config.artifactInventoryHash ?? null,
      status: "SEALED_PREFLIGHT",
    });
  }

  function apply(value) {
    const prepared = prepare(value);
    const result = promoteM6GateEpoch({
      ...prepared.promoterInput,
      faultAfter: faultAfterForOperation(prepared.input.operation),
    });
    const final = status();
    if (!final.tripleConsistent || final.epochHash !== prepared.input.epoch.epochHash) {
      fail("M6_GATE_F_POSTCONDITION_FAILED", "Gate-F promotion did not finish in one triple-consistent generation", { status: 503 });
    }
    return Object.freeze({ ...result, phase: final.phase, tripleConsistent: true });
  }

  function reconcile(value) {
    const prepared = prepare(value, { reconcile: true });
    const result = reconcileM6GateEpochPromotion(prepared.promoterInput);
    const final = status();
    if (!final.tripleConsistent || final.epochHash !== prepared.input.epoch.epochHash) {
      fail("M6_GATE_F_RECONCILE_FAILED", "Gate-F reconcile did not restore exact file/DB/pointer consistency", { status: 503 });
    }
    return Object.freeze({ ...result, phase: final.phase, tripleConsistent: true });
  }

  function health() {
    return Object.freeze({
      installed: true,
      status: blockers.length === 0 ? "PREFLIGHT_REQUIRED" : "UNSEALED",
      blockers: [...new Set(blockers)].sort(),
      actionCount: 0,
    });
  }

  function unsafeRecovery(cause, message = "Gate-F armed-active recovery cannot prove one safe transition") {
    if (cause?.code === "M6_GATE_F_UNSAFE_RECOVERY_REQUIRED") throw cause;
    fail("M6_GATE_F_UNSAFE_RECOVERY_REQUIRED", message, {
      status: 409,
      details: {
        causeCode: typeof cause?.code === "string" ? cause.code : "M6_GATE_F_RECOVERY_STATE_INVALID",
        resourceCount: 0,
      },
    });
  }

  function assertExactClosedRecoveryStatus(gate) {
    if (gate?.schemaId !== "xw.m6-gate-f-operations-status.v1"
      || gate.mode !== "CLOSED" || gate.phase !== "CLOSED"
      || gate.tripleConsistent !== true || !HASH.test(gate.epochHash ?? "")
      || !Number.isSafeInteger(gate.generation) || gate.generation < 0
      || gate.activeAuthorizationCount !== 0
      || !Array.isArray(gate.errors) || gate.errors.length !== 0) {
      unsafeRecovery(null, "Gate-F recovery did not prove an exact CLOSED file/DB/pointer triple");
    }
    return gate;
  }

  function recoverArmedActive(value) {
    exactObject(value, [], "M6_GATE_F_RECOVERY_INPUT_INVALID", "Gate-F armed-active recovery body");
    assertSealed();
    if (!finalRuntime) {
      unsafeRecovery(null, "Gate-F armed-active recovery is available only in the FINAL runtime");
    }

    const initialFence = state.getM6GateFence();
    if (!initialFence) unsafeRecovery(null, "Gate-F armed-active recovery found no durable fence");
    if (initialFence.mode === "CLOSED") {
      let gate;
      let terminalArm = null;
      try {
        gate = assertExactClosedRecoveryStatus(status());
        terminalArm = state.getM6GateSafetyCloseArmByTerminalEpoch?.(gate.epochHash) ?? null;
        if (terminalArm) {
          createM6GateFSafetyCloseLoadAuthority(terminalArm, {
            allowStatuses: ["CONSUMED", "RELEASED"],
          });
          if (terminalArm.terminalEpochHash !== gate.epochHash
            || (terminalArm.status === "CONSUMED" && terminalArm.closeEpochHash !== gate.epochHash)
            || terminalArm.gateId !== initialFence.gateId
            || terminalArm.purpose !== initialFence.purpose
            || terminalArm.package?.epoch?.parentEpochHash !== terminalArm.activeEpochHash
            || terminalArm.package?.epoch?.gateId !== terminalArm.gateId
            || terminalArm.package?.epoch?.purpose !== terminalArm.purpose) {
            unsafeRecovery(null, "Gate-F CLOSED recovery terminal arm is rebound from its active predecessor");
          }
        }
      } catch (cause) {
        unsafeRecovery(cause, "Gate-F CLOSED recovery state is not one exact file/DB/pointer triple");
      }
      return Object.freeze({
        recovery: Object.freeze({
          schemaId: "xw.m6-gate-f-armed-active-recovery.v1",
          recovered: false,
          priorEpochHash: terminalArm?.activeEpochHash ?? gate.epochHash,
          terminalEpochHash: gate.epochHash,
          tripleConsistent: true,
          status: "ALREADY_CLOSED",
        }),
        gate,
      });
    }

    if (!new Set(["OBSERVE_ONLY", "GROUNDED_ACTION"]).has(initialFence.mode)
      || !HASH.test(initialFence.epochHash ?? "")
      || !Number.isSafeInteger(initialFence.generation) || initialFence.generation < 1) {
      unsafeRecovery(null, "Gate-F recovery fence is neither exact ACTIVE nor exact CLOSED");
    }

    const priorEpochHash = initialFence.epochHash;
    const arm = state.getM6GateSafetyCloseArm?.(priorEpochHash) ?? null;
    try {
      assertM6GateFSafetyCloseArmMatchesPackage(arm, arm?.package, { allowStatuses: ["ARMED"] });
      if (arm.gateId !== initialFence.gateId
        || arm.purpose !== initialFence.purpose
        || arm.activeEpochHash !== priorEpochHash
        || arm.armedGeneration !== initialFence.generation
        || arm.package?.epoch?.parentEpochHash !== priorEpochHash
        || arm.package?.epoch?.gateId !== initialFence.gateId
        || arm.package?.epoch?.purpose !== initialFence.purpose) {
        unsafeRecovery(null, "Gate-F durable safety-close arm is rebound from the ACTIVE fence");
      }

      // Always select the active chain through authority derived from the
      // durable arm. This pins the activation proof hash even when the issuer
      // is still active, and preserves the fail-safe after revocation/expiry.
      const safetyCloseLoadAuthority = createM6GateFSafetyCloseLoadAuthority(arm, {
        allowStatuses: ["ARMED"],
      });
      const loaded = loadM6Gate({
        m6Root: config.m6Root,
        gateId: config.gateId,
        issuerAllowlistPath: config.issuerAllowlistPath,
        requireLocks: true,
        safetyCloseLoadAuthority,
      });
      assertM6FileDbPointerConsistency({ loaded, fence: initialFence, pointer: loaded.currentPointer });
      const tail = loaded.chain.at(-1);
      if (tail?.schemaId !== "xw.m6-live-gate.v2"
        || tail.status !== "active" || tail.mode !== initialFence.mode
        || tail.epochHash !== priorEpochHash
        || tail.gateId !== arm.gateId || tail.purpose !== arm.purpose) {
        unsafeRecovery(null, "Gate-F durable arm does not bind the exact ACTIVE chain tail");
      }

      // `prepare(..., reconcile:true)` is the mutation-free recovery
      // preflight. It checks the exact closeout/aggregate/emergency authority
      // and the activation-time arm clock without consulting a mutable inbox.
      prepare(arm.package, { reconcile: true });
    } catch (cause) {
      unsafeRecovery(cause, "Gate-F armed-active recovery preflight found an unsafe binding");
    }

    const closeEpochPath = join(
      config.m6Root,
      "m6-gate",
      config.gateId,
      "epochs",
      `${arm.closeEpochHash}.json`,
    );
    try {
      if (existsSync(closeEpochPath)) {
        // A prior close may have stopped after immutable append. Reconcile is
        // idempotent and verifies the existing bytes before committing DB or
        // pointer state.
        reconcile(arm.package);
      } else {
        preflight(arm.package);
        try {
          apply(arm.package);
        } catch (cause) {
          if (!new Set(["M6_GATE_IMMUTABLE", "M6_GATE_PROMOTE_FAULT"]).has(cause?.code)) throw cause;
          reconcile(arm.package);
        }
      }
    } catch (cause) {
      unsafeRecovery(cause, "Gate-F armed emergency close could not reach a safe terminal triple");
    }

    let gate;
    try {
      gate = assertExactClosedRecoveryStatus(status());
      const terminalArm = state.getM6GateSafetyCloseArm?.(priorEpochHash) ?? null;
      assertM6GateFSafetyCloseArmMatchesPackage(terminalArm, arm.package, { allowStatuses: ["CONSUMED"] });
      if (gate.epochHash !== arm.closeEpochHash
        || terminalArm.terminalEpochHash !== arm.closeEpochHash
        || terminalArm.terminalProofHash !== null) {
        unsafeRecovery(null, "Gate-F recovery terminal state is not the exact armed emergency close");
      }
    } catch (cause) {
      unsafeRecovery(cause, "Gate-F recovery postcondition is not one exact CLOSED triple");
    }

    return Object.freeze({
      recovery: Object.freeze({
        schemaId: "xw.m6-gate-f-armed-active-recovery.v1",
        recovered: true,
        priorEpochHash,
        terminalEpochHash: gate.epochHash,
        tripleConsistent: true,
        status: "EMERGENCY_CLOSED",
      }),
      gate,
    });
  }

  return Object.freeze({ assertAuthorized, preflight, apply, reconcile, recoverArmedActive, status, health });
}
