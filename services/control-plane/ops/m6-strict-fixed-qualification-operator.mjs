#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RELEASE_MANIFEST_FILENAME,
  verifyReleaseManifest,
} from "../../../packages/release/lib/release-manifest.mjs";
import {
  materializeM6LiveRuntimeDependencyLayer,
} from "../../../integrations/dsh-xw/src/live-runtime-dependency-layer.mjs";
import {
  qualifyDeepSeekLiveModel,
  writeLiveModelQualificationArtifacts,
} from "../../../integrations/dsh-xw/src/live-model-qualification.mjs";
import {
  runM64TargetEnvironmentQualification,
} from "../apps/xiaowei/m6-target-environment-qualification-runtime.mjs";
import { canonicalJson, sha256 } from "../control-plane/lib/canonical.mjs";
import {
  validateM6QualificationBootstrapPackage,
} from "../control-plane/lib/m6-qualification-bootstrap.mjs";
import {
  CONTROL_PLANE_REQUIRED_PRIVATE_ENVIRONMENT,
  inspectControlPlanePrivateMaterial,
  validateControlPlaneSecretEnvironmentBytes,
} from "./control-plane-private-material.mjs";

export const M64_STRICT_FIXED_RUNTIME_ROOT = "C:\\Users\\Public\\xw-runtime";
export const M64_STRICT_FIXED_OPERATION_RECEIPT_SCHEMA_ID =
  "xw.m6-strict-fixed-qualification-operation.v1";

const HASH = /^(?!0{64}$)[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/u;
const GATE_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const INVENTORY_SENTINEL_HASH = sha256(
  "xw.m6-c1-qualification-bootstrap.inventory-unavailable.v1",
);
const RECEIPT_SCHEMAS = new Set([
  "xw.m6-c1-qualification-bootstrap-operator-receipt.v1",
  "xw.m6-c1-qualification-bootstrap-rotation-receipt.v1",
]);
const OPERATION_RECEIPT_KEYS = Object.freeze([
  "actionCount", "authorityHash", "dependencyLayerHash", "environmentQualificationSha256",
  "modelProfileHash", "operationHash", "releaseId", "runtimeDependencyQualificationHash",
  "schemaId", "secretMaterialPresent", "sourceCommit", "status",
  "targetEnvironmentAttestationHash",
]);
const BINDING_KEYS = Object.freeze([
  "gateFArtifactInventoryHash", "gateFArtifactInventoryPath", "gateId",
  "gateIssuerAllowlistPath", "releaseId", "releaseManifestSha256", "schemaId",
  "sourceCommit", "sourceReleaseRoot",
]);

function fail(code, message) {
  throw Object.assign(new Error(`${code}: ${message}`), { code });
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function within(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()));
}

function plainFile(path, label, maximumBytes = 64 * 1024 * 1024) {
  let stat;
  try { stat = lstatSync(path); } catch { fail("M64_STRICT_FIXED_ARTIFACT_INVALID", `${label} is unavailable`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.size < 1 || stat.size > maximumBytes) {
    fail("M64_STRICT_FIXED_ARTIFACT_INVALID", `${label} is not one bounded plain file`);
  }
  return readFileSync(path);
}

function plainDirectory(path, label) {
  let stat;
  try { stat = lstatSync(path); } catch { fail("M64_STRICT_FIXED_ARTIFACT_INVALID", `${label} is unavailable`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("M64_STRICT_FIXED_ARTIFACT_INVALID", `${label} is not one plain directory`);
  }
  return resolve(path);
}

function readJson(path, label) {
  const bytes = plainFile(path, label);
  try { return Object.freeze({ path: resolve(path), bytes, sha256: hash(bytes), value: JSON.parse(bytes.toString("utf8")) }); }
  catch { fail("M64_STRICT_FIXED_ARTIFACT_INVALID", `${label} is malformed`); }
}

function exactZeroObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length > 0
    && Object.values(value).every((count) => Number.isSafeInteger(count) && count === 0));
}

function assertPackageZero(packageRecord) {
  const pointKeys = ["activeActions", "activeJobs", "activeLeases", "activeRuns", "activeSessions"];
  const snapshot = packageRecord?.resourceSnapshot;
  if (snapshot?.actionCount !== 0 || packageRecord?.scenarioManifest?.attemptCount !== 0
    || packageRecord?.aggregate?.attemptCount !== 0
    || !exactObject(snapshot?.before, pointKeys) || !exactObject(snapshot?.after, pointKeys)
    || !pointKeys.every((key) => snapshot.before[key] === 0 && snapshot.after[key] === 0)) {
    fail("M64_STRICT_FIXED_RESOURCES_NOT_ZERO", "qualification package is not an exact zero-resource closeout");
  }
}

export function parseM64StrictFixedQualificationArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== "execute-fixed") {
    fail(
      "M64_STRICT_FIXED_CLI_INVALID",
      "usage: execute-fixed; paths, endpoints, tokens, models, aliases, hashes, and options are forbidden",
    );
  }
  return Object.freeze({ execute: true });
}

export function resolveM64CurrentFormalRelease({
  runtimeRoot = M64_STRICT_FIXED_RUNTIME_ROOT,
  verifyManifest = verifyReleaseManifest,
} = {}) {
  const runtime = plainDirectory(runtimeRoot, "formal runtime root");
  const currentPath = join(runtime, "current");
  let currentStat;
  try { currentStat = lstatSync(currentPath); } catch {
    fail("M64_STRICT_FIXED_RELEASE_INVALID", "current formal release pointer is unavailable");
  }
  if (!currentStat.isSymbolicLink()) {
    fail("M64_STRICT_FIXED_RELEASE_INVALID", "current formal release pointer is not a junction");
  }
  const releaseRoot = realpathSync(currentPath);
  const releasesRoot = join(runtime, "releases");
  if (!within(releasesRoot, releaseRoot) || samePath(releasesRoot, releaseRoot)) {
    fail("M64_STRICT_FIXED_RELEASE_INVALID", "current release escaped the fixed releases store");
  }
  plainDirectory(releaseRoot, "current formal release");
  const manifestPath = join(releaseRoot, RELEASE_MANIFEST_FILENAME);
  const manifestFile = readJson(manifestPath, "current formal release manifest");
  const manifest = manifestFile.value;
  if (!RELEASE_ID.test(manifest?.releaseId ?? "") || !COMMIT.test(manifest?.sourceCommit ?? "")
    || !samePath(releaseRoot, join(releasesRoot, manifest.releaseId))
    || verifyManifest({ root: releaseRoot, manifestPath })?.ok !== true) {
    fail("M64_STRICT_FIXED_RELEASE_INVALID", "current release identity or manifest verification failed");
  }
  return Object.freeze({
    runtimeRoot: runtime,
    currentPath,
    releaseRoot,
    releaseId: manifest.releaseId,
    sourceCommit: manifest.sourceCommit,
    sourceShort: manifest.sourceCommit.slice(0, 7),
    manifestPath,
    manifestSha256: manifestFile.sha256,
    manifest: Object.freeze(manifest),
  });
}

function receiptBody(value) {
  const { receiptHash: _ignored, ...body } = value;
  return body;
}

export function resolveM64StrictFixedQualificationAuthority({
  runtimeRoot = M64_STRICT_FIXED_RUNTIME_ROOT,
  now = Date.now,
  verifyManifest = verifyReleaseManifest,
  validatePackage = validateM6QualificationBootstrapPackage,
} = {}) {
  const release = resolveM64CurrentFormalRelease({ runtimeRoot, verifyManifest });
  const bindingPath = join(release.runtimeRoot, "config", "m6-c1-qualification-bootstrap.v1.json");
  const bindingFile = readJson(bindingPath, "qualification runtime binding");
  const binding = bindingFile.value;
  const issuerAllowlistPath = join(release.runtimeRoot, "m6-gate", "issuer-keys.json");
  const sentinelPath = join(release.runtimeRoot, "qualification-bootstrap", "final-inventory-unavailable.json");
  if (!exactObject(binding, BINDING_KEYS)
    || binding.schemaId !== "xw.runtime.m6-c1-qualification-bootstrap.v1"
    || binding.releaseId !== release.releaseId || binding.sourceCommit !== release.sourceCommit
    || binding.releaseManifestSha256 !== release.manifestSha256
    || !GATE_ID.test(binding.gateId ?? "")
    || !samePath(binding.sourceReleaseRoot, release.releaseRoot)
    || !samePath(binding.gateIssuerAllowlistPath, issuerAllowlistPath)
    || !samePath(binding.gateFArtifactInventoryPath, sentinelPath)
    || binding.gateFArtifactInventoryHash !== INVENTORY_SENTINEL_HASH) {
    fail("M64_STRICT_FIXED_RELEASE_DRIFT", "qualification binding drifted from the current formal release");
  }
  const packageRoot = plainDirectory(
    join(release.runtimeRoot, "m6-gate", binding.gateId, "qualification-bootstrap"),
    "qualification package store",
  );
  const packageNames = readdirSync(packageRoot).filter((name) => HASH.test(name.replace(/\.package\.json$/u, ""))
    && name.endsWith(".package.json"));
  if (packageNames.length !== 1) {
    fail("M64_STRICT_FIXED_PACKAGE_INVALID", "exactly one content-addressed qualification package is required");
  }
  const packageFile = readJson(join(packageRoot, packageNames[0]), "qualification package");
  const packageRecord = packageFile.value;
  if (basename(packageFile.path) !== `${packageRecord?.packageHash}.package.json`
    || packageRecord?.releaseId !== release.releaseId
    || packageRecord?.sourceCommit !== release.sourceCommit
    || packageRecord?.gateId !== binding.gateId) {
    fail("M64_STRICT_FIXED_PACKAGE_INVALID", "qualification package identity is rebound");
  }
  validatePackage({
    package: packageRecord,
    issuerAllowlistPath,
    m6Root: release.runtimeRoot,
    nowMs: Number(now()),
  });
  assertPackageZero(packageRecord);

  const receiptRoot = plainDirectory(
    join(release.runtimeRoot, "qualification-bootstrap", "receipts"),
    "qualification receipt store",
  );
  const matches = readdirSync(receiptRoot)
    .filter((name) => HASH.test(name.replace(/\.json$/u, "")) && name.endsWith(".json"))
    .map((name) => readJson(join(receiptRoot, name), "qualification operator receipt"))
    .filter((file) => file.value?.gateId === binding.gateId
      && file.value?.packageHash === packageRecord.packageHash);
  if (matches.length !== 1) {
    fail("M64_STRICT_FIXED_RECEIPT_INVALID", "exactly one matching content-addressed operator receipt is required");
  }
  const receiptFile = matches[0];
  const receipt = receiptFile.value;
  if (!RECEIPT_SCHEMAS.has(receipt.schemaId)
    || receipt.receiptHash !== sha256(`${receipt.schemaId}:${canonicalJson(receiptBody(receipt))}`)
    || basename(receiptFile.path) !== `${receipt.receiptHash}.json`
    || receipt.generation !== 0 || receipt.mode !== "CLOSED" || receipt.actionCount !== 0
    || !exactZeroObject(receipt.resourceCounts)
    || receipt.bindingSha256 !== bindingFile.sha256
    || receipt.releaseManifestSha256 !== release.manifestSha256
    || !samePath(receipt.bindingPath, bindingPath)
    || !samePath(receipt.gateFArtifactInventoryPath, sentinelPath)
    || receipt.gateFArtifactInventoryHash !== INVENTORY_SENTINEL_HASH
    || receipt.privateKeyAccessed !== false || receipt.providerAccessed !== false
    || receipt.deviceAccessed !== false || receipt.networkAccessed !== false) {
    fail("M64_STRICT_FIXED_RECEIPT_INVALID", "operator receipt hash, identity, or zero-resource proof is invalid");
  }
  const identity = Object.freeze({
    releaseId: release.releaseId,
    sourceCommit: release.sourceCommit,
    releaseManifestSha256: release.manifestSha256,
    gateId: binding.gateId,
    packageHash: packageRecord.packageHash,
    receiptHash: receipt.receiptHash,
  });
  return Object.freeze({
    ...release,
    identity,
    identityHash: sha256(`${M64_STRICT_FIXED_OPERATION_RECEIPT_SCHEMA_ID}:authority:${canonicalJson(identity)}`),
    bindingPath,
    bindingSha256: bindingFile.sha256,
    packagePath: packageFile.path,
    receiptPath: receiptFile.path,
    accountSecretPath: join(release.runtimeRoot, "secrets", "control-plane-secret-environment.v1.json"),
    targetRoot: join(release.runtimeRoot, "m6-audit", `m6-c1-target-environment-${release.sourceShort}`),
    dependencyLayersRoot: join(release.runtimeRoot, "m6-runtime-layers"),
    modelRoot: join(release.runtimeRoot, "m6-audit", `m6-c1-live-model-qualification-${release.sourceShort}`),
  });
}

export function loadM64StrictFixedSecrets(authority, inspector = inspectControlPlanePrivateMaterial) {
  const inspected = inspector({ runtimeRoot: authority.runtimeRoot });
  if (!samePath(inspected?.secretEnvironment?.path, authority.accountSecretPath)) {
    fail("M64_STRICT_FIXED_SECRET_INVALID", "private environment escaped the fixed runtime slot");
  }
  const bytes = plainFile(authority.accountSecretPath, "control-plane secret environment", 32 * 1024);
  if (hash(bytes) !== inspected.secretEnvironment.sha256) {
    bytes.fill(0);
    fail("M64_STRICT_FIXED_SECRET_INVALID", "private environment changed after ACL inspection");
  }
  validateControlPlaneSecretEnvironmentBytes(bytes);
  let parsed;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch {
    bytes.fill(0);
    fail("M64_STRICT_FIXED_SECRET_INVALID", "private environment is malformed");
  }
  return { bytes, variables: parsed.variables };
}

function ensureOperationReceiptRoot(authority) {
  let cursor = authority.runtimeRoot;
  for (const segment of [
    "m6-audit",
    `m6-c1-strict-fixed-qualification-${authority.sourceShort}`,
    "receipts",
  ]) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) mkdirSync(cursor, { recursive: false });
    plainDirectory(cursor, "strict-fixed operation receipt directory");
  }
  return cursor;
}

export function publishM64StrictFixedOperationReceipt(authority, receipt) {
  const root = ensureOperationReceiptRoot(authority);
  const path = join(root, `${receipt.operationHash}.json`);
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  if (existsSync(path)) {
    if (!plainFile(path, "strict-fixed operation receipt").equals(bytes)) {
      fail("M64_STRICT_FIXED_RECEIPT_DRIFT", "content-addressed operation receipt already has different bytes");
    }
    return Object.freeze({ path, replay: true });
  }
  try { writeFileSync(path, bytes, { flag: "wx", mode: 0o600 }); }
  catch { fail("M64_STRICT_FIXED_RECEIPT_WRITE_FAILED", "operation receipt could not be published create-only"); }
  if (!plainFile(path, "strict-fixed operation receipt").equals(bytes)) {
    fail("M64_STRICT_FIXED_RECEIPT_WRITE_FAILED", "operation receipt readback differs");
  }
  return Object.freeze({ path, replay: false });
}

function operationReceiptRoot(authority) {
  return join(
    authority.runtimeRoot,
    "m6-audit",
    `m6-c1-strict-fixed-qualification-${authority.sourceShort}`,
    "receipts",
  );
}

export function loadM64StrictFixedOperationReceiptIfPresent(authority) {
  const root = operationReceiptRoot(authority);
  let names;
  try { names = readdirSync(root).filter((name) => /^[0-9a-f]{64}\.json$/u.test(name)); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("M64_STRICT_FIXED_RECEIPT_INVALID", "operation receipt store is unreadable");
  }
  if (names.length === 0) return null;
  if (names.length !== 1) {
    fail("M64_STRICT_FIXED_RECEIPT_INVALID", "current release has multiple qualification operation receipts");
  }
  const file = readJson(join(root, names[0]), "strict-fixed operation receipt");
  const value = file.value;
  const { operationHash: _ignored, ...body } = value ?? {};
  if (!exactObject(value, OPERATION_RECEIPT_KEYS)
    || value.schemaId !== M64_STRICT_FIXED_OPERATION_RECEIPT_SCHEMA_ID
    || value.status !== "QUALIFIED" || value.releaseId !== authority.releaseId
    || value.sourceCommit !== authority.sourceCommit || value.authorityHash !== authority.identityHash
    || value.actionCount !== 0 || value.secretMaterialPresent !== false
    || ![
      value.authorityHash, value.targetEnvironmentAttestationHash,
      value.environmentQualificationSha256, value.dependencyLayerHash,
      value.runtimeDependencyQualificationHash, value.modelProfileHash, value.operationHash,
    ].every((item) => HASH.test(item ?? ""))
    || value.operationHash !== sha256(`${value.schemaId}:${canonicalJson(body)}`)
    || basename(file.path) !== `${value.operationHash}.json`) {
    fail("M64_STRICT_FIXED_RECEIPT_INVALID", "existing qualification operation receipt is invalid or rebound");
  }
  return Object.freeze(value);
}

function stableAuthority(before, after) {
  if (before.identityHash !== after.identityHash
    || !samePath(before.releaseRoot, after.releaseRoot)
    || !samePath(before.packagePath, after.packagePath)
    || !samePath(before.receiptPath, after.receiptPath)) {
    fail("M64_STRICT_FIXED_RELEASE_DRIFT", "release/package/receipt identity changed during qualification");
  }
}

function inspectTargetArtifacts(authority, target) {
  const attestation = readJson(
    join(authority.targetRoot, "attestations", `${target.attestationHash}.json`),
    "target environment attestation",
  );
  const qualification = readJson(
    join(authority.targetRoot, "qualifications", `${target.qualificationHash}.json`),
    "target environment qualification",
  );
  if (attestation.value?.attestationHash !== target.attestationHash
    || qualification.sha256 !== target.qualificationHash) {
    fail("M64_STRICT_FIXED_TARGET_INVALID", "target evidence escaped its content-addressed store");
  }
  return Object.freeze({ attestation: attestation.value, qualification: qualification.value });
}

export async function operateM64StrictFixedQualification({
  runtimeRoot = M64_STRICT_FIXED_RUNTIME_ROOT,
} = {}, dependencies = {}) {
  if (!samePath(runtimeRoot, M64_STRICT_FIXED_RUNTIME_ROOT)) {
    fail("M64_STRICT_FIXED_RUNTIME_INVALID", "formal runtime root is fixed");
  }
  const deps = {
    resolveAuthority: resolveM64StrictFixedQualificationAuthority,
    loadSecrets: loadM64StrictFixedSecrets,
    inspectPrivateMaterial: inspectControlPlanePrivateMaterial,
    runTarget: runM64TargetEnvironmentQualification,
    materializeDependency: materializeM6LiveRuntimeDependencyLayer,
    qualifyModel: qualifyDeepSeekLiveModel,
    writeModel: writeLiveModelQualificationArtifacts,
    inspectTargetArtifacts,
    publishReceipt: publishM64StrictFixedOperationReceipt,
    loadExistingReceipt: loadM64StrictFixedOperationReceiptIfPresent,
    ...dependencies,
  };
  const authority = deps.resolveAuthority({ runtimeRoot });
  const replay = deps.loadExistingReceipt(authority);
  if (replay) return replay;
  const secret = deps.loadSecrets(authority, deps.inspectPrivateMaterial);
  try {
    const variables = secret.variables;
    if (!CONTROL_PLANE_REQUIRED_PRIVATE_ENVIRONMENT.every((name) => typeof variables[name] === "string")) {
      fail("M64_STRICT_FIXED_SECRET_INVALID", "required private environment is incomplete");
    }
    const target = await deps.runTarget({
      execute: true,
      artifactRoot: authority.targetRoot,
      accountIsolationBindingHash: variables.XW_M6_ACCOUNT_ISOLATION_BINDING_HASH,
      controlPlaneUrl: "http://127.0.0.1:17920/",
      controlToken: variables.XW_M6_GATE_F_OPERATIONS_TOKEN,
    });
    if (!HASH.test(target?.attestationHash ?? "") || !HASH.test(target?.qualificationHash ?? "")
      || target.actionCount !== 0) {
      fail("M64_STRICT_FIXED_TARGET_INVALID", "target qualification did not produce exact zero-action content addresses");
    }
    const afterTarget = deps.resolveAuthority({ runtimeRoot });
    stableAuthority(authority, afterTarget);
    const targetArtifacts = deps.inspectTargetArtifacts(authority, target);

    const dependency = deps.materializeDependency({
      releaseRoot: authority.releaseRoot,
      layersRoot: authority.dependencyLayersRoot,
    });
    if (!HASH.test(dependency?.layerHash ?? "")
      || !samePath(dependency?.layerRoot, join(authority.dependencyLayersRoot, dependency.layerHash))
      || !HASH.test(dependency?.qualification?.qualificationHash ?? "")
      || dependency.qualification.releaseId !== authority.releaseId
      || dependency.qualification.sourceCommit !== authority.sourceCommit
      || dependency.qualification.sourceReleaseManifestSha256 !== authority.manifestSha256) {
      fail("M64_STRICT_FIXED_DEPENDENCY_INVALID", "runtime dependency layer is not content-addressed and qualified");
    }
    const afterDependency = deps.resolveAuthority({ runtimeRoot });
    stableAuthority(authority, afterDependency);

    const modelResult = await deps.qualifyModel({
      execute: true,
      dependencyRoot: dependency.layerRoot,
      runtimeDependencyQualification: dependency.qualification,
      targetEnvironmentAttestation: targetArtifacts.attestation,
      environment: { DEEPSEEK_API_KEY: variables.DEEPSEEK_API_KEY },
    });
    const modelArtifacts = deps.writeModel({
      outputRoot: authority.modelRoot,
      dependencyRoot: dependency.layerRoot,
      result: modelResult,
    });
    if (modelResult?.status !== "QUALIFIED" || !HASH.test(modelArtifacts?.profileHash ?? "")
      || !samePath(modelArtifacts?.root, authority.modelRoot)) {
      fail("M64_STRICT_FIXED_MODEL_INVALID", "live model qualification did not produce one content-addressed profile");
    }
    const afterModel = deps.resolveAuthority({ runtimeRoot });
    stableAuthority(authority, afterModel);

    const body = Object.freeze({
      schemaId: M64_STRICT_FIXED_OPERATION_RECEIPT_SCHEMA_ID,
      status: "QUALIFIED",
      releaseId: authority.releaseId,
      sourceCommit: authority.sourceCommit,
      authorityHash: authority.identityHash,
      targetEnvironmentAttestationHash: target.attestationHash,
      environmentQualificationSha256: target.qualificationHash,
      dependencyLayerHash: dependency.layerHash,
      runtimeDependencyQualificationHash: dependency.qualification.qualificationHash,
      modelProfileHash: modelArtifacts.profileHash,
      actionCount: 0,
      secretMaterialPresent: false,
    });
    const receipt = Object.freeze({
      ...body,
      operationHash: sha256(`${M64_STRICT_FIXED_OPERATION_RECEIPT_SCHEMA_ID}:${canonicalJson(body)}`),
    });
    deps.publishReceipt(authority, receipt);
    return receipt;
  } finally {
    for (const name of CONTROL_PLANE_REQUIRED_PRIVATE_ENVIRONMENT) secret.variables[name] = null;
    secret.bytes.fill(0);
  }
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, dependencies = {} } = {}) {
  parseM64StrictFixedQualificationArgs(argv);
  const result = await operateM64StrictFixedQualification({}, dependencies);
  stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : null;
if (entry === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "M64_STRICT_FIXED_FAILED"}: strict-fixed qualification failed\n`);
    process.exitCode = 1;
  });
}
