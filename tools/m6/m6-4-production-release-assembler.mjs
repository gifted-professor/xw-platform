#!/usr/bin/env node

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
  realpathSync,
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
import { fileURLToPath } from "node:url";

import { verifyReleaseManifest } from "../../packages/release/lib/release-manifest.mjs";
import { canonicalJson, sha256 } from "../../services/control-plane/control-plane/lib/canonical.mjs";
import {
  M6_GATE_F_ARTIFACT_CATALOG_PURPOSES,
  deriveM6GateFArtifactCatalogHash,
  deriveM6GateFArtifactInventoryHash,
  recomputeM6GateFArtifact,
  validateM6GateFArtifactCatalogCandidate,
  validateM6GateFArtifactInventoryCandidate,
} from "../../services/control-plane/control-plane/lib/m6-gate-f-operations.mjs";
import {
  M6_GROUNDED_RUN_CAPABILITY_ID,
  verifyM6GroundedRunCapabilitySeal,
} from "../../services/control-plane/control-plane/lib/m6-grounded-run-capability-seal.mjs";
import {
  M64_PRODUCTION_DEPENDENCY_BINDING_SCHEMA_ID,
  deriveM64ProductionDependencyBindingHash,
  validateM64ProductionDependencyCandidate,
} from "../../services/control-plane/control-plane/lib/m6-live-production-dependencies.mjs";
import { M6_GATE_V2_LOCK_KINDS } from "../../services/control-plane/control-plane/lib/m6-live-gate-v2.mjs";
import {
  inspectRecoverableCreateOnlyPublication,
  publishRecoverableCreateOnly,
  recoverablePublicationPendingPath,
  RecoverablePublicationError,
} from "./lib/recoverable-create-only-publication.mjs";

export const M64_FINAL_ASSEMBLER_INPUT_SCHEMA_ID = "xw.m6-4-production-release-assembler-input.v1";
export const M64_FINAL_ASSEMBLER_RECEIPT_SCHEMA_ID = "xw.m6-4-production-release-assembler-receipt.v1";
export const M64_FINAL_RUNTIME_BINDING_SCHEMA_ID = "xw.runtime.m6-c1-runtime.v1";

export const M64_FINAL_RUNTIME_BINDING_KEYS = Object.freeze([
  "schemaId", "releaseId", "sourceCommit", "sourceReleaseRoot", "releaseManifestSha256",
  "dependencyRoot", "dependencyLayerHash", "modelProfileRoot", "modelProfileHash",
  "providerBaseUrl", "manifestRoot", "runtimeSnapshotPath", "dshPersistenceRoot", "gateId",
  "gateIssuerAllowlistPath", "liveAuthorizationIssuerAllowlistPath",
  "gateFArtifactCatalogPath", "gateFArtifactCatalogHash", "gateFArtifactCatalogSha256",
  "targetEnvironmentAttestationPath", "targetEnvironmentAttestationHash",
  "environmentQualificationPath", "environmentQualificationSha256",
  "productionDependencyBindingPath", "productionDependencyBindingHash",
]);

const HASH = /^(?!0{64}$)[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const OPAQUE_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const INPUT_KEYS = Object.freeze(["outputs", "productionDependencies", "release", "runtime", "schemaId", "windows"]);
const RELEASE_KEYS = Object.freeze([
  "capabilityId", "implementationClosureHash", "manifestPath", "manifestSha256", "releaseId",
  "root", "sourceCommit", "tcbManifestRef",
]);
const OUTPUT_KEYS = Object.freeze([
  "artifactCatalogPath", "inventoryRoot", "productionDependencyBindingPath", "receiptRoot", "runtimeBindingPath",
]);
const RUNTIME_KEYS = Object.freeze([
  "dependencyLayerHash", "dependencyRoot", "dshPersistenceRoot", "gateId", "gateIssuerAllowlistPath",
  "liveAuthorizationIssuerAllowlistPath", "manifestRoot", "modelProfileHash", "modelProfileRoot",
  "providerBaseUrl", "runtimeSnapshotPath",
]);
const DEPENDENCY_KEYS = Object.freeze([
  "currentStateGuardPolicy", "effectBoundary", "environmentAttestation", "environmentQualification",
  "independentOraclePolicy", "targetSelectorPolicy",
]);
const ARTIFACT_REF_KEYS = Object.freeze(["path", "sha256"]);
const WINDOW_KEYS = Object.freeze(["lockArtifacts", "purpose", "runtimeArtifacts"]);
const DESCRIPTOR_KEYS = Object.freeze(["expectedHash", "mode", "path"]);
const RUNTIME_ARTIFACT_KEYS = Object.freeze(["environmentAttestation", "independentOracle", "operator", "resetObligations"]);
const DIRECTORY_MODES = new Set(["LIVE_MODEL_PROFILE", "TREE_SHA256"]);
const SECRET_KEY = /^(?:api[_-]?key|access[_-]?token|bearer[_-]?token|password|private[_-]?key|secret|credential(?:value)?)$/iu;
const SECRET_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{8,})/u;

const DEFAULT_DEPENDENCIES = Object.freeze({
  verifyReleaseManifest,
  verifyCapabilitySeal: verifyM6GroundedRunCapabilitySeal,
  recomputeArtifact: recomputeM6GateFArtifact,
  validateInventoryCandidate: validateM6GateFArtifactInventoryCandidate,
  validateCatalogCandidate: validateM6GateFArtifactCatalogCandidate,
  validateProductionDependencyCandidate: validateM64ProductionDependencyCandidate,
});

function fail(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    fail("M64_FINAL_ASSEMBLER_INPUT_INVALID", `${label} must contain exactly ${keys.join(", ")}`);
  }
  return value;
}

function assertSecretFree(value, label) {
  const visit = (item) => {
    if (typeof item === "string") {
      if (SECRET_VALUE.test(item)) fail("M64_FINAL_ASSEMBLER_SECRET_MATERIAL_FORBIDDEN", `${label} contains secret-shaped material`);
      return;
    }
    if (Array.isArray(item)) return item.forEach(visit);
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (SECRET_KEY.test(key)) {
        fail("M64_FINAL_ASSEMBLER_SECRET_MATERIAL_FORBIDDEN", `${label} contains forbidden secret field ${key}`);
      }
      visit(child);
    }
  };
  visit(value);
}

function normalizedPath(path) {
  const full = resolve(path);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

function within(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function collectAbsolutePaths(...values) {
  const paths = new Set();
  const visit = (value) => {
    if (typeof value === "string") {
      if (isAbsolute(value)) paths.add(resolve(value));
      return;
    }
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    Object.values(value).forEach(visit);
  };
  values.forEach(visit);
  return paths;
}

function assertOutputIsolation(outputPaths, input) {
  const normalizedOutputs = outputPaths.map(normalizedPath);
  for (let left = 0; left < outputPaths.length; left += 1) {
    for (let right = left + 1; right < outputPaths.length; right += 1) {
      if (within(outputPaths[left], outputPaths[right]) || within(outputPaths[right], outputPaths[left])) {
        fail("M64_FINAL_ASSEMBLER_OUTPUT_COLLISION", "assembler output files must be distinct and non-nested");
      }
    }
  }
  const inputPaths = collectAbsolutePaths(input.release, input.runtime, input.productionDependencies, input.windows);
  for (const inputPath of inputPaths) {
    const inputKey = normalizedPath(inputPath);
    if (normalizedOutputs.includes(inputKey)) {
      fail("M64_FINAL_ASSEMBLER_OUTPUT_COLLISION", "assembler outputs must be distinct from every caller-supplied input path");
    }
    if (existsSync(inputPath)) {
      let stat;
      try { stat = lstatSync(inputPath); } catch (cause) {
        fail("M64_FINAL_ASSEMBLER_PATH_UNAVAILABLE", "an input path changed during output isolation", { cause: cause.message });
      }
      if (stat.isDirectory() && outputPaths.some((outputPath) => within(inputPath, outputPath))) {
        fail("M64_FINAL_ASSEMBLER_OUTPUT_COLLISION", "assembler outputs must remain outside every consumed input directory");
      }
    }
  }
}

function sameFilesystemObject(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function prospectiveRealPath(path) {
  let cursor = resolve(path);
  const suffix = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(cursor.slice(parent.length).replace(/^[\\/]+/u, ""));
    cursor = parent;
  }
  const real = existsSync(cursor) ? realpathSync.native(cursor) : cursor;
  return resolve(real, ...suffix);
}

function assertAbsolute(path, label) {
  if (typeof path !== "string" || path.length < 3 || path.length > 32_767 || path.includes("\0") || !isAbsolute(path)) {
    fail("M64_FINAL_ASSEMBLER_PATH_INVALID", `${label} must be one bounded absolute path`);
  }
  return resolve(path);
}

function assertPlainAncestors(path, label, { allowMissing = false } = {}) {
  const target = resolve(path);
  const volumeRoot = parse(target).root;
  let cursor = dirname(target);
  const missing = [];
  while (cursor && normalizedPath(cursor) !== normalizedPath(volumeRoot)) {
    if (!existsSync(cursor)) {
      if (!allowMissing) fail("M64_FINAL_ASSEMBLER_PATH_UNAVAILABLE", `${label} parent directory is unavailable`);
      missing.push(cursor);
      cursor = dirname(cursor);
      continue;
    }
    let stat;
    let real;
    let realStat;
    try {
      stat = lstatSync(cursor, { bigint: true });
      real = realpathSync.native(cursor);
      realStat = lstatSync(real, { bigint: true });
    } catch (cause) {
      fail("M64_FINAL_ASSEMBLER_PATH_UNAVAILABLE", `${label} parent directory is unavailable`, { cause: cause.message });
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !realStat.isDirectory()
      || !sameFilesystemObject(stat, realStat)) {
      fail("M64_FINAL_ASSEMBLER_PATH_NOT_PLAIN", `${label} must not traverse a symlink, junction, reparse point, or non-directory parent`);
    }
    cursor = dirname(cursor);
  }
  return missing;
}

function assertExternal(releaseRoot, target, label) {
  if (within(releaseRoot, target) || within(realpathSync.native(releaseRoot), prospectiveRealPath(target))) {
    fail("M64_FINAL_ASSEMBLER_RELEASE_ROOT_REBIND", `${label} must remain outside the immutable release root`);
  }
}

function assertExistingPlain(path, label, { directory, releaseRoot = null } = {}) {
  const target = assertAbsolute(path, label);
  assertPlainAncestors(target, label);
  let stat;
  let real;
  let realStat;
  try {
    stat = lstatSync(target, { bigint: true });
    real = realpathSync.native(target);
    realStat = lstatSync(real, { bigint: true });
  } catch (cause) {
    fail("M64_FINAL_ASSEMBLER_PATH_UNAVAILABLE", `${label} is unavailable`, { cause: cause.message });
  }
  if (stat.isSymbolicLink() || !sameFilesystemObject(stat, realStat)
    || (directory ? !stat.isDirectory() : (!stat.isFile() || stat.nlink !== 1n))) {
    fail("M64_FINAL_ASSEMBLER_PATH_NOT_PLAIN", `${label} must be one plain ${directory ? "directory" : "single-link regular file"}`);
  }
  if (releaseRoot !== null) assertExternal(releaseRoot, target, label);
  return target;
}

function safeReadPlainFile(path, label, { releaseRoot = null, maxBytes = MAX_JSON_BYTES } = {}) {
  const target = assertExistingPlain(path, label, { directory: false, releaseRoot });
  let descriptor;
  try {
    const before = lstatSync(target, { bigint: true });
    if (before.size < 1n || before.size > BigInt(maxBytes)) {
      fail("M64_FINAL_ASSEMBLER_FILE_INVALID", `${label} has an invalid size`);
    }
    descriptor = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (String(before.dev) !== String(opened.dev) || String(before.ino) !== String(opened.ino)
      || opened.nlink !== 1n || opened.size !== before.size) {
      fail("M64_FINAL_ASSEMBLER_FILE_RACE", `${label} changed while it was opened`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (String(opened.dev) !== String(after.dev) || String(opened.ino) !== String(after.ino)
      || after.size !== BigInt(bytes.length)) {
      fail("M64_FINAL_ASSEMBLER_FILE_RACE", `${label} changed while it was read`);
    }
    return Object.freeze({ bytes, path: target, sha256: sha256(bytes) });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readJson(path, label, options = {}) {
  const file = safeReadPlainFile(path, label, options);
  let value;
  try { value = JSON.parse(file.bytes.toString("utf8")); } catch (cause) {
    fail("M64_FINAL_ASSEMBLER_JSON_INVALID", `${label} is malformed JSON`, { cause: cause.message });
  }
  return Object.freeze({ ...file, value });
}

function prettyBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function artifactRef(input, label, releaseRoot) {
  exactObject(input, ARTIFACT_REF_KEYS, label);
  if (!HASH.test(input.sha256 ?? "")) {
    fail("M64_FINAL_ASSEMBLER_CONTENT_ADDRESS_INVALID", `${label} requires a nonzero raw SHA-256`);
  }
  const file = safeReadPlainFile(input.path, label, { releaseRoot });
  if (file.sha256 !== input.sha256) {
    fail("M64_FINAL_ASSEMBLER_RAW_HASH_MISMATCH", `${label} raw file SHA-256 changed`);
  }
  return Object.freeze({ path: file.path, sha256: file.sha256 });
}

function assertOutputPath(path, label, releaseRoot) {
  const target = assertAbsolute(path, label);
  assertExternal(releaseRoot, target, label);
  assertPlainAncestors(target, label, { allowMissing: true });
  if (existsSync(target)) {
    let stat;
    let realStat;
    try {
      stat = lstatSync(target, { bigint: true });
      realStat = lstatSync(realpathSync.native(target), { bigint: true });
    } catch (cause) {
      fail("M64_FINAL_ASSEMBLER_PATH_UNAVAILABLE", `${label} is unavailable`, { cause: cause.message });
    }
    // A process crash between hard-link publication and pending cleanup leaves
    // exactly two links to one inode. The byte-bound publication inspector
    // below accepts only the deterministic pending/final pair; every unrelated
    // hard link is still rejected.
    if (stat.isSymbolicLink() || !stat.isFile() || !sameFilesystemObject(stat, realStat)
      || stat.nlink < 1n || stat.nlink > 2n) {
      fail("M64_FINAL_ASSEMBLER_PATH_NOT_PLAIN", `${label} must be one plain recoverable publication file`);
    }
  }
  return target;
}

function descriptor(input, label, { releaseRoot, nowMs, dependencies }) {
  exactObject(input, DESCRIPTOR_KEYS, label);
  if (!HASH.test(input.expectedHash ?? "")) {
    fail("M64_FINAL_ASSEMBLER_CONTENT_ADDRESS_INVALID", `${label} requires one nonzero expected content hash`);
  }
  const path = assertExistingPlain(input.path, label, {
    directory: DIRECTORY_MODES.has(input.mode),
    releaseRoot,
  });
  const output = Object.freeze({ mode: input.mode, path });
  const recomputed = dependencies.recomputeArtifact(output, input.expectedHash, { nowMs });
  if (recomputed?.hash !== input.expectedHash) {
    fail("M64_FINAL_ASSEMBLER_DOMAIN_HASH_MISMATCH", `${label} domain/content hash changed`);
  }
  return Object.freeze({ descriptor: output, expectedHash: input.expectedHash, value: recomputed.value });
}

function findGroundedCapability(releaseRoot) {
  const capabilities = readJson(
    join(releaseRoot, "services", "control-plane", "apps", "xiaowei", "capabilities.json"),
    "grounded-run capability catalog",
  ).value;
  const matches = capabilities?.capabilities?.filter?.((item) => item?.id === M6_GROUNDED_RUN_CAPABILITY_ID) ?? [];
  if (matches.length !== 1) {
    fail("M64_FINAL_ASSEMBLER_TCB_SEAL_INVALID", "immutable release must contain exactly one grounded-run capability");
  }
  return matches[0];
}

function verifyRelease(input, dependencies) {
  exactObject(input, RELEASE_KEYS, "release");
  if (!OPAQUE_ID.test(input.releaseId ?? "") || !COMMIT.test(input.sourceCommit ?? "")
    || !HASH.test(input.manifestSha256 ?? "") || input.capabilityId !== M6_GROUNDED_RUN_CAPABILITY_ID
    || !HASH.test(input.implementationClosureHash ?? "") || typeof input.tcbManifestRef !== "string"
    || input.tcbManifestRef.length < 3) {
    fail("M64_FINAL_ASSEMBLER_RELEASE_BINDING_INVALID", "release identity or TCB expectation is invalid");
  }
  const root = assertExistingPlain(input.root, "immutable release root", { directory: true });
  const manifestFile = readJson(input.manifestPath, "immutable release manifest");
  if (!within(root, manifestFile.path) || manifestFile.sha256 !== input.manifestSha256) {
    fail("M64_FINAL_ASSEMBLER_RELEASE_BINDING_INVALID", "release manifest path or raw SHA-256 is rebound");
  }
  const verified = dependencies.verifyReleaseManifest({ root, manifestPath: manifestFile.path });
  if (!verified?.ok || manifestFile.value?.releaseId !== input.releaseId
    || manifestFile.value?.sourceCommit !== input.sourceCommit) {
    fail("M64_FINAL_ASSEMBLER_RELEASE_INVALID", "immutable release manifest verification failed", { mismatches: verified?.mismatches ?? [] });
  }
  const capability = findGroundedCapability(root);
  const seal = dependencies.verifyCapabilitySeal({ capability, rootDir: root });
  if (seal?.capabilityId !== input.capabilityId
    || seal?.implementationClosureHash !== input.implementationClosureHash
    || seal?.tcbManifestRef !== input.tcbManifestRef) {
    fail("M64_FINAL_ASSEMBLER_TCB_SEAL_MISMATCH", "grounded-run TCB seal differs from the pinned release expectation");
  }
  return Object.freeze({
    root,
    manifestPath: manifestFile.path,
    manifestSha256: manifestFile.sha256,
    manifest: manifestFile.value,
    seal,
  });
}

function validateRuntimeInput(input, release, outputs) {
  exactObject(input, RUNTIME_KEYS, "runtime");
  if (!HASH.test(input.dependencyLayerHash ?? "") || !HASH.test(input.modelProfileHash ?? "")
    || !OPAQUE_ID.test(input.gateId ?? "") || input.providerBaseUrl !== "https://api.deepseek.com") {
    fail("M64_FINAL_ASSEMBLER_RUNTIME_INPUT_INVALID", "runtime hashes, gate ID, or provider endpoint are invalid");
  }
  const runtimeSnapshotPath = assertAbsolute(input.runtimeSnapshotPath, "stable runtime snapshot target");
  assertExternal(release.root, runtimeSnapshotPath, "stable runtime snapshot target");
  const runtimeStateRoot = join(outputs.runtimeRoot, "state");
  if (!within(runtimeStateRoot, runtimeSnapshotPath)
    || normalizedPath(runtimeStateRoot) === normalizedPath(runtimeSnapshotPath)) {
    fail("M64_FINAL_ASSEMBLER_RUNTIME_SNAPSHOT_ESCAPE", "stable runtime snapshot target must remain below runtimeRoot/state");
  }
  assertExistingPlain(dirname(runtimeSnapshotPath), "stable runtime snapshot parent", {
    directory: true,
    releaseRoot: release.root,
  });
  if (existsSync(runtimeSnapshotPath)) {
    assertExistingPlain(runtimeSnapshotPath, "stable runtime snapshot target", {
      directory: false,
      releaseRoot: release.root,
    });
  }
  const result = {
    dependencyRoot: assertExistingPlain(input.dependencyRoot, "runtime dependency root", { directory: true, releaseRoot: release.root }),
    dependencyLayerHash: input.dependencyLayerHash,
    modelProfileRoot: assertExistingPlain(input.modelProfileRoot, "live model profile root", { directory: true, releaseRoot: release.root }),
    modelProfileHash: input.modelProfileHash,
    providerBaseUrl: input.providerBaseUrl,
    manifestRoot: assertExistingPlain(input.manifestRoot, "scenario manifest root", { directory: true, releaseRoot: release.root }),
    runtimeSnapshotPath,
    dshPersistenceRoot: assertExistingPlain(input.dshPersistenceRoot, "DSH persistence root", { directory: true, releaseRoot: release.root }),
    gateId: input.gateId,
    gateIssuerAllowlistPath: assertExistingPlain(input.gateIssuerAllowlistPath, "Gate issuer allowlist", { directory: false, releaseRoot: release.root }),
    liveAuthorizationIssuerAllowlistPath: assertExistingPlain(input.liveAuthorizationIssuerAllowlistPath, "live-window issuer allowlist", { directory: false, releaseRoot: release.root }),
  };
  const layer = readJson(join(result.dependencyRoot, "m6-live-runtime-dependency-layer.v1.json"), "runtime dependency layer manifest").value;
  if (layer?.schemaId !== "xw.m6-live-runtime-dependency-layer.v1"
    || layer?.layerHash !== result.dependencyLayerHash
    || layer?.sourceRelease?.releaseId !== release.manifest.releaseId
    || layer?.sourceRelease?.sourceCommit !== release.manifest.sourceCommit
    || layer?.sourceRelease?.manifestSha256 !== release.manifestSha256) {
    fail("M64_FINAL_ASSEMBLER_DEPENDENCY_LAYER_REBOUND", "runtime dependency layer is not bound to the exact immutable release");
  }
  return Object.freeze(result);
}

function validateOutputs(input, releaseRoot) {
  exactObject(input, OUTPUT_KEYS, "outputs");
  const inventoryRoot = assertAbsolute(input.inventoryRoot, "inventory output root");
  const receiptRoot = assertAbsolute(input.receiptRoot, "receipt output root");
  assertExternal(releaseRoot, inventoryRoot, "inventory output root");
  assertExternal(releaseRoot, receiptRoot, "receipt output root");
  assertPlainAncestors(join(inventoryRoot, "sentinel"), "inventory output root", { allowMissing: true });
  assertPlainAncestors(join(receiptRoot, "sentinel"), "receipt output root", { allowMissing: true });
  const result = Object.freeze({
    inventoryRoot,
    receiptRoot,
    artifactCatalogPath: assertOutputPath(input.artifactCatalogPath, "Gate-F catalog output", releaseRoot),
    productionDependencyBindingPath: assertOutputPath(input.productionDependencyBindingPath, "production dependency binding output", releaseRoot),
    runtimeBindingPath: assertOutputPath(input.runtimeBindingPath, "final runtime binding output", releaseRoot),
  });
  const paths = [result.artifactCatalogPath, result.productionDependencyBindingPath, result.runtimeBindingPath];
  if (new Set(paths.map(normalizedPath)).size !== paths.length) {
    fail("M64_FINAL_ASSEMBLER_OUTPUT_COLLISION", "final output paths must be distinct");
  }
  if (basename(result.runtimeBindingPath).toLowerCase() !== "m6-c1-runtime.v1.json"
    || basename(dirname(result.runtimeBindingPath)).toLowerCase() !== "config") {
    fail("M64_FINAL_ASSEMBLER_RUNTIME_BINDING_PATH_INVALID", "final runtime binding must be runtimeRoot/config/m6-c1-runtime.v1.json");
  }
  const runtimeRoot = dirname(dirname(result.runtimeBindingPath));
  assertExistingPlain(runtimeRoot, "runtime root", { directory: true, releaseRoot });
  assertExistingPlain(join(runtimeRoot, "state"), "runtime state root", { directory: true, releaseRoot });
  return Object.freeze({ ...result, runtimeRoot });
}

function checkExactExisting(path, bytes, label) {
  if (!existsSync(path) && !existsSync(recoverablePublicationPendingPath(path, bytes))) return false;
  try {
    const state = inspectRecoverableCreateOnlyPublication({ targetPath: path, bytes });
    return state.exactFinal && !state.needsRecovery;
  } catch (error) {
    mapPublicationError(error, label);
  }
}

function syncDirectory(path) {
  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY);
    fsyncSync(descriptor);
  } catch (cause) {
    const windowsUnsupported = process.platform === "win32"
      && new Set(["EACCES", "EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"]).has(cause?.code);
    if (!windowsUnsupported) {
      fail("M64_FINAL_ASSEMBLER_DURABILITY_FAILED", "parent directory fsync failed", { cause: cause?.code ?? cause?.message });
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function ensurePlainDirectory(path, releaseRoot, label) {
  assertExternal(releaseRoot, path, label);
  const missing = assertPlainAncestors(join(path, "sentinel"), label, { allowMissing: true });
  mkdirSync(path, { recursive: true });
  const verified = assertExistingPlain(path, label, { directory: true, releaseRoot });
  for (const created of missing.reverse()) {
    assertExistingPlain(created, label, { directory: true, releaseRoot });
    syncDirectory(created);
    syncDirectory(dirname(created));
  }
  return verified;
}

function mapPublicationError(error, label) {
  if (!(error instanceof RecoverablePublicationError)) throw error;
  if (error.reason === "TARGET_DIFFERENT") {
    fail("M64_FINAL_ASSEMBLER_REFUSE_DIFFERENT", `${label} already exists with different bytes`);
  }
  if (/^(?:PARENT|TARGET|PENDING)_(?:UNSAFE|EXTERNAL_HARDLINK|RACE)$/u.test(error.reason)) {
    fail("M64_FINAL_ASSEMBLER_PATH_NOT_PLAIN", `${label} publication state is not one recoverable plain-file topology`, {
      reason: error.reason,
    });
  }
  fail("M64_FINAL_ASSEMBLER_DURABILITY_FAILED", `${label} recoverable create-only publication failed`, {
    reason: error.reason,
    cause: error.causeCode,
  });
}

function createExact(path, bytes, label, releaseRoot, faultAfter = () => {}) {
  ensurePlainDirectory(dirname(path), releaseRoot, `${label} parent`);
  try {
    return publishRecoverableCreateOnly({ targetPath: path, bytes, faultAfter }).status;
  } catch (error) {
    mapPublicationError(error, label);
  }
}

function receiptHash(body) {
  return sha256(`${M64_FINAL_ASSEMBLER_RECEIPT_SCHEMA_ID}:${canonicalJson(body)}`);
}

export function planM64FinalProductionArtifacts({ input, now = Date.now, dependencies = {} } = {}) {
  exactObject(input, INPUT_KEYS, "assembler input");
  if (input.schemaId !== M64_FINAL_ASSEMBLER_INPUT_SCHEMA_ID) {
    fail("M64_FINAL_ASSEMBLER_INPUT_INVALID", "assembler input schema is invalid");
  }
  assertSecretFree(input, "assembler input");
  const nowMs = Number(typeof now === "function" ? now() : now);
  if (!Number.isFinite(nowMs)) fail("M64_FINAL_ASSEMBLER_CLOCK_INVALID", "assembler clock must be finite");
  const deps = Object.freeze({ ...DEFAULT_DEPENDENCIES, ...dependencies });
  const release = verifyRelease(input.release, deps);
  const outputs = validateOutputs(input.outputs, release.root);
  const runtime = validateRuntimeInput(input.runtime, release, outputs);

  exactObject(input.productionDependencies, DEPENDENCY_KEYS, "productionDependencies");
  const productionDependencies = Object.fromEntries(DEPENDENCY_KEYS.map((key) => [
    key, artifactRef(input.productionDependencies[key], `productionDependencies.${key}`, release.root),
  ]));
  if (new Set(Object.values(productionDependencies).map((ref) => normalizedPath(ref.path))).size !== DEPENDENCY_KEYS.length) {
    fail("M64_FINAL_ASSEMBLER_DEPENDENCY_DUPLICATE", "production dependency artifacts must be six distinct files");
  }

  if (!Array.isArray(input.windows) || input.windows.length !== M6_GATE_F_ARTIFACT_CATALOG_PURPOSES.length) {
    fail("M64_FINAL_ASSEMBLER_WINDOW_SET_INVALID", "assembler requires exactly five Gate-F windows");
  }
  const inventories = [];
  const scenarioHashes = new Set();
  const scenarioPaths = new Set();
  let targetEnvironment = null;
  let environmentQualification = null;
  let modelProfile = null;
  for (let index = 0; index < input.windows.length; index += 1) {
    const window = exactObject(input.windows[index], WINDOW_KEYS, `windows[${index}]`);
    const purpose = M6_GATE_F_ARTIFACT_CATALOG_PURPOSES[index];
    if (window.purpose !== purpose) {
      fail("M64_FINAL_ASSEMBLER_PURPOSE_ORDER_INVALID", "five Gate-F purposes must appear once in frozen order");
    }
    exactObject(window.lockArtifacts, M6_GATE_V2_LOCK_KINDS, `${purpose}.lockArtifacts`);
    exactObject(window.runtimeArtifacts, RUNTIME_ARTIFACT_KEYS, `${purpose}.runtimeArtifacts`);
    const lockArtifacts = {};
    const lockResults = {};
    for (const kind of M6_GATE_V2_LOCK_KINDS) {
      const result = descriptor(window.lockArtifacts[kind], `${purpose}.lockArtifacts.${kind}`, {
        releaseRoot: release.root, nowMs, dependencies: deps,
      });
      lockArtifacts[kind] = result.descriptor;
      lockResults[kind] = result;
    }
    const runtimeArtifacts = {};
    const runtimeResults = {};
    for (const kind of RUNTIME_ARTIFACT_KEYS) {
      const result = descriptor(window.runtimeArtifacts[kind], `${purpose}.runtimeArtifacts.${kind}`, {
        releaseRoot: release.root, nowMs, dependencies: deps,
      });
      runtimeArtifacts[kind] = result.descriptor;
      runtimeResults[kind] = result;
    }
    if (lockResults.scenarioManifest.value?.purpose !== purpose) {
      fail("M64_FINAL_ASSEMBLER_SCENARIO_PURPOSE_MISMATCH", `${purpose} scenario manifest is rebound`);
    }
    const scenarioHash = lockResults.scenarioManifest.expectedHash;
    const scenarioPath = normalizedPath(lockArtifacts.scenarioManifest.path);
    if (scenarioHashes.has(scenarioHash) || scenarioPaths.has(scenarioPath)) {
      fail("M64_FINAL_ASSEMBLER_SCENARIO_DUPLICATE", "the five scenario manifests must be distinct by path and domain hash");
    }
    scenarioHashes.add(scenarioHash);
    scenarioPaths.add(scenarioPath);

    const common = {
      targetEnvironment: runtimeResults.environmentAttestation,
      environmentQualification: lockResults.environmentQualification,
      modelProfile: lockResults.modelProfile,
    };
    if (index === 0) {
      ({ targetEnvironment, environmentQualification, modelProfile } = common);
    } else if (normalizedPath(common.targetEnvironment.descriptor.path) !== normalizedPath(targetEnvironment.descriptor.path)
      || common.targetEnvironment.expectedHash !== targetEnvironment.expectedHash
      || normalizedPath(common.environmentQualification.descriptor.path) !== normalizedPath(environmentQualification.descriptor.path)
      || common.environmentQualification.expectedHash !== environmentQualification.expectedHash
      || normalizedPath(common.modelProfile.descriptor.path) !== normalizedPath(modelProfile.descriptor.path)
      || common.modelProfile.expectedHash !== modelProfile.expectedHash) {
      fail("M64_FINAL_ASSEMBLER_FIVE_WINDOW_REBOUND", "all five windows must share the exact environment qualification and live model profile");
    }

    const body = {
      schemaId: "xw.m6-gate-f-artifact-inventory.v1",
      release: { root: release.root, manifestPath: release.manifestPath },
      lockArtifacts,
      runtimeArtifacts,
    };
    const inventory = Object.freeze({ ...body, inventoryHash: deriveM6GateFArtifactInventoryHash(body) });
    const bytes = prettyBytes(inventory);
    const path = assertOutputPath(
      join(outputs.inventoryRoot, `${index + 1}-${purpose.toLowerCase().replaceAll("_", "-")}.inventory.v1.json`),
      `${purpose} inventory output`,
      release.root,
    );
    deps.validateInventoryCandidate({ path, expectedHash: inventory.inventoryHash, candidateBytes: bytes });
    inventories.push(Object.freeze({
      purpose,
      path,
      bytes,
      inventory,
      inventoryHash: inventory.inventoryHash,
      sha256: sha256(bytes),
      scenarioManifestHash: scenarioHash,
    }));
  }
  if (new Set(inventories.map((item) => item.inventoryHash)).size !== inventories.length
    || new Set(inventories.map((item) => normalizedPath(item.path))).size !== inventories.length) {
    fail("M64_FINAL_ASSEMBLER_INVENTORY_DUPLICATE", "five inventories must be distinct by path and domain hash");
  }
  if (normalizedPath(modelProfile.descriptor.path) !== normalizedPath(runtime.modelProfileRoot)
    || modelProfile.expectedHash !== runtime.modelProfileHash
    || modelProfile.value?.profile?.targetEnvironmentAttestationHash !== targetEnvironment.expectedHash
    || Date.parse(modelProfile.value?.profile?.expiresAt ?? "") > Date.parse(targetEnvironment.value?.expiresAt ?? "")
    || normalizedPath(targetEnvironment.descriptor.path) !== normalizedPath(productionDependencies.environmentAttestation.path)
    || normalizedPath(environmentQualification.descriptor.path) !== normalizedPath(productionDependencies.environmentQualification.path)
    || environmentQualification.expectedHash !== productionDependencies.environmentQualification.sha256) {
    fail("M64_FINAL_ASSEMBLER_RUNTIME_ARTIFACT_REBOUND", "five-window environment/model artifacts differ from final runtime dependencies");
  }

  const catalogBody = {
    schemaId: "xw.m6-gate-f-artifact-catalog.v1",
    release: { releaseId: release.manifest.releaseId, sourceCommit: release.manifest.sourceCommit },
    entries: inventories.map((item) => ({
      purpose: item.purpose,
      scenarioManifestHash: item.scenarioManifestHash,
      inventoryPath: item.path,
      inventorySha256: item.sha256,
      inventoryHash: item.inventoryHash,
    })),
  };
  const catalog = Object.freeze({ ...catalogBody, catalogHash: deriveM6GateFArtifactCatalogHash(catalogBody) });
  const catalogBytes = prettyBytes(catalog);
  const catalogSha256 = sha256(catalogBytes);
  deps.validateCatalogCandidate({
    path: outputs.artifactCatalogPath,
    expectedHash: catalog.catalogHash,
    expectedReleaseRoot: release.root,
    expectedReleaseManifestPath: release.manifestPath,
    candidateBytes: catalogBytes,
    inventoryCandidateBytes: new Map(inventories.map((item) => [item.path, item.bytes])),
  });

  const dependencyBody = {
    schemaId: M64_PRODUCTION_DEPENDENCY_BINDING_SCHEMA_ID,
    releaseId: release.manifest.releaseId,
    sourceCommit: release.manifest.sourceCommit,
    ...productionDependencies,
  };
  const dependencyBinding = Object.freeze({
    ...dependencyBody,
    bindingHash: deriveM64ProductionDependencyBindingHash(dependencyBody),
  });
  const dependencyBindingBytes = prettyBytes(dependencyBinding);
  const dependencyBindingSha256 = sha256(dependencyBindingBytes);
  const finalBinding = Object.freeze({
    schemaId: M64_FINAL_RUNTIME_BINDING_SCHEMA_ID,
    releaseId: release.manifest.releaseId,
    sourceCommit: release.manifest.sourceCommit,
    sourceReleaseRoot: release.root,
    releaseManifestSha256: release.manifestSha256,
    ...runtime,
    gateFArtifactCatalogPath: outputs.artifactCatalogPath,
    gateFArtifactCatalogHash: catalog.catalogHash,
    gateFArtifactCatalogSha256: catalogSha256,
    targetEnvironmentAttestationPath: targetEnvironment.descriptor.path,
    targetEnvironmentAttestationHash: targetEnvironment.expectedHash,
    environmentQualificationPath: environmentQualification.descriptor.path,
    environmentQualificationSha256: environmentQualification.expectedHash,
    productionDependencyBindingPath: outputs.productionDependencyBindingPath,
    productionDependencyBindingHash: dependencyBindingSha256,
  });
  if (canonicalJson(Object.keys(finalBinding).sort()) !== canonicalJson([...M64_FINAL_RUNTIME_BINDING_KEYS].sort())) {
    fail("M64_FINAL_ASSEMBLER_RUNTIME_BINDING_INVALID", "final runtime binding is not the exact 25-key schema");
  }
  const finalBindingBytes = prettyBytes(finalBinding);
  const finalBindingSha256 = sha256(finalBindingBytes);
  deps.validateProductionDependencyCandidate({
    runtimeBinding: finalBinding,
    productionDependencyBindingBytes: dependencyBindingBytes,
    now: () => nowMs,
  });

  const receiptBody = {
    schemaId: M64_FINAL_ASSEMBLER_RECEIPT_SCHEMA_ID,
    release: {
      releaseId: release.manifest.releaseId,
      sourceCommit: release.manifest.sourceCommit,
      manifestPath: release.manifestPath,
      manifestSha256: release.manifestSha256,
      capabilityId: release.seal.capabilityId,
      implementationClosureHash: release.seal.implementationClosureHash,
      tcbManifestRef: release.seal.tcbManifestRef,
    },
    inventories: inventories.map((item) => ({
      purpose: item.purpose,
      path: item.path,
      scenarioManifestHash: item.scenarioManifestHash,
      inventoryHash: item.inventoryHash,
      sha256: item.sha256,
    })),
    artifactCatalog: {
      path: outputs.artifactCatalogPath,
      catalogHash: catalog.catalogHash,
      sha256: catalogSha256,
    },
    productionDependencyBinding: {
      path: outputs.productionDependencyBindingPath,
      bindingHash: dependencyBinding.bindingHash,
      sha256: dependencyBindingSha256,
    },
    runtimeBinding: { path: outputs.runtimeBindingPath, sha256: finalBindingSha256 },
    publicationDurability: {
      createOnly: true,
      fileFsyncBeforeNextArtifact: true,
      parentDirectoryFsyncBeforeNextArtifact: "REQUIRED_OR_EXPLICITLY_UNSUPPORTED_ON_WINDOWS",
      receiptWrittenLast: true,
    },
    privateKeyMaterialRead: false,
    secretMaterialPresent: false,
    signatureGenerated: false,
  };
  const receipt = Object.freeze({ ...receiptBody, receiptHash: receiptHash(receiptBody) });
  const receiptBytes = prettyBytes(receipt);
  const receiptPath = assertOutputPath(join(outputs.receiptRoot, `${receipt.receiptHash}.json`), "content-addressed receipt", release.root);
  assertOutputIsolation([
    ...inventories.map((item) => item.path),
    outputs.artifactCatalogPath,
    outputs.productionDependencyBindingPath,
    outputs.runtimeBindingPath,
    receiptPath,
  ], input);
  const artifacts = Object.freeze([
    ...inventories.map((item) => Object.freeze({ path: item.path, bytes: item.bytes, label: `${item.purpose} inventory` })),
    Object.freeze({ path: outputs.artifactCatalogPath, bytes: catalogBytes, label: "Gate-F artifact catalog" }),
    Object.freeze({ path: outputs.productionDependencyBindingPath, bytes: dependencyBindingBytes, label: "production dependency binding" }),
    Object.freeze({ path: outputs.runtimeBindingPath, bytes: finalBindingBytes, label: "final runtime binding" }),
    Object.freeze({ path: receiptPath, bytes: receiptBytes, label: "assembler receipt" }),
  ]);
  const replay = artifacts.map((artifact) => checkExactExisting(artifact.path, artifact.bytes, artifact.label));
  if (replay.at(-1) && replay.slice(0, -1).some((present) => !present)) {
    fail("M64_FINAL_ASSEMBLER_PREMATURE_RECEIPT", "an assembler receipt exists before every predecessor artifact");
  }
  return Object.freeze({
    schemaId: "xw.m6-4-production-release-assembler-plan.v1",
    mode: "PREFLIGHT",
    writesPerformed: false,
    exactReplayAvailable: replay.every(Boolean),
    receiptPath,
    receipt,
    catalog,
    dependencyBinding,
    finalBinding,
    artifacts,
    releaseRoot: release.root,
  });
}

export function assembleM64FinalProductionArtifacts({
  input,
  execute = false,
  now = Date.now,
  dependencies = {},
  publicationFaultAfter = null,
  publicationProtocolFaultAfter = null,
} = {}) {
  if (typeof execute !== "boolean") fail("M64_FINAL_ASSEMBLER_INPUT_INVALID", "execute must be boolean");
  const plan = planM64FinalProductionArtifacts({ input, now, dependencies });
  if (!execute) return plan;
  if (publicationFaultAfter !== null
    && (!Number.isInteger(publicationFaultAfter) || publicationFaultAfter < 0 || publicationFaultAfter >= plan.artifacts.length)) {
    fail("M64_FINAL_ASSEMBLER_INPUT_INVALID", "publicationFaultAfter must select a pre-receipt publication boundary");
  }
  if (publicationProtocolFaultAfter !== null && typeof publicationProtocolFaultAfter !== "function") {
    fail("M64_FINAL_ASSEMBLER_INPUT_INVALID", "publicationProtocolFaultAfter must be one function or null");
  }
  const outcomes = [];
  if (publicationFaultAfter === 0) {
    fail("M64_FINAL_ASSEMBLER_PUBLICATION_FAULT_INJECTED", "publication stopped at the requested crash boundary");
  }
  for (let index = 0; index < plan.artifacts.length; index += 1) {
    const artifact = plan.artifacts[index];
    outcomes.push({
      path: artifact.path,
      outcome: createExact(
        artifact.path,
        artifact.bytes,
        artifact.label,
        plan.releaseRoot,
        publicationProtocolFaultAfter === null
          ? () => {}
          : (point, context) => publicationProtocolFaultAfter(Object.freeze({
            artifactIndex: index,
            label: artifact.label,
            path: artifact.path,
            point,
            ...context,
          })),
      ),
    });
    if (publicationFaultAfter === outcomes.length) {
      fail("M64_FINAL_ASSEMBLER_PUBLICATION_FAULT_INJECTED", "publication stopped at the requested crash boundary");
    }
  }
  return Object.freeze({
    schemaId: "xw.m6-4-production-release-assembler-execution.v1",
    mode: "EXECUTE",
    writesPerformed: outcomes.some((item) => item.outcome === "CREATED"),
    exactReplay: outcomes.every((item) => item.outcome === "REPLAYED"),
    outcomes: Object.freeze(outcomes),
    receiptPath: plan.receiptPath,
    receipt: plan.receipt,
  });
}

export function parseM64FinalAssemblerArgs(argv) {
  const result = { execute: false, inputPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help") return Object.freeze({ help: true });
    if (token === "--execute") {
      if (result.execute) fail("M64_FINAL_ASSEMBLER_CLI_INVALID", "--execute was repeated");
      result.execute = true;
      continue;
    }
    if (token === "--input" && result.inputPath === null && typeof argv[index + 1] === "string"
      && !argv[index + 1].startsWith("--")) {
      result.inputPath = argv[index += 1];
      continue;
    }
    fail("M64_FINAL_ASSEMBLER_CLI_INVALID", "an argument was unknown, repeated, or missing its value");
  }
  if (!result.inputPath || !isAbsolute(result.inputPath)) {
    fail("M64_FINAL_ASSEMBLER_CLI_INVALID", "--input must be one absolute JSON path");
  }
  return Object.freeze(result);
}

export function main(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const parsed = parseM64FinalAssemblerArgs(argv);
  if (parsed.help) {
    stdout.write([
      "M6-4 final production artifact assembler",
      "",
      "Preflight (default; validates all inputs and writes nothing):",
      "  node tools/m6/m6-4-production-release-assembler.mjs --input ABS.json",
      "",
      "Create-only execution (exact replay is idempotent; different bytes are refused):",
      "  node tools/m6/m6-4-production-release-assembler.mjs --execute --input ABS.json",
      "",
      "The assembler never reads a credential, generates a key/signature, contacts a provider, or operates a device.",
    ].join("\n") + "\n");
    return null;
  }
  const inputFile = readJson(parsed.inputPath, "assembler input file");
  assertSecretFree(inputFile.value, "assembler input file");
  const output = assembleM64FinalProductionArtifacts({ input: inputFile.value, execute: parsed.execute });
  stdout.write(`${JSON.stringify(output, (key, value) => key === "artifacts" || key === "bytes" ? undefined : value, 2)}\n`);
  return output;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : null;
if (entry === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`${error?.code ?? "M64_FINAL_ASSEMBLER_FAILED"}: ${error?.message ?? "final assembly failed"}\n`);
    process.exitCode = 1;
  }
}
