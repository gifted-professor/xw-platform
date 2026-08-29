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
} from "node:fs";
import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify as verifySignature,
} from "node:crypto";
import {
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
import {
  M64_LIVE_CRITICAL_ZERO_COUNTER_FIELDS,
  deriveM64ExpectedStateArtifact,
  validateM64ExpectedStateArtifact,
} from "../../packages/kernel/lib/m6-live-evidence.mjs";
import {
  m6LiveSha256,
} from "../../packages/kernel/lib/m6-live-grounding.mjs";
import {
  validateM64CohortManifest,
} from "../../packages/kernel/lib/m6-4-cohort.mjs";
import { validateM64EffectBoundary } from "../../packages/kernel/lib/m6-effect-boundary.mjs";
import {
  SEALED_LIVE_PROVIDER_BASE_URL,
  loadContentAddressedLiveModelQualificationBundle,
} from "../../integrations/dsh-xw/src/live-model-profile.mjs";
import {
  verifyM6LiveRuntimeDependencyLayer,
} from "../../integrations/dsh-xw/src/live-runtime-dependency-layer.mjs";
import {
  M6_GATE_F_ARTIFACT_CATALOG_PURPOSES,
  recomputeM6GateFArtifact,
} from "../../services/control-plane/control-plane/lib/m6-gate-f-operations.mjs";
import {
  M6_GROUNDED_RUN_CAPABILITY_ID,
  verifyM6GroundedRunCapabilitySeal,
} from "../../services/control-plane/control-plane/lib/m6-grounded-run-capability-seal.mjs";
import {
  M64_CURRENT_STATE_GUARD_POLICY_SCHEMA_ID,
  M64_EXPECTATION_ENVELOPE_SCHEMA_ID,
  M64_EXPECTATION_INDEX_SCHEMA_ID,
  M64_INDEPENDENT_ORACLE_POLICY_SCHEMA_ID,
  M64_TARGET_SELECTOR_POLICY_SCHEMA_ID,
  canonicalM64ExpectationEnvelopeSigningBytes,
  deriveM64CurrentStateGuardPolicyHash,
  deriveM64ExpectationIndexHash,
  deriveM64ExpectationLookupHash,
  deriveM64IndependentActorHash,
  deriveM64IndependentOraclePolicyHash,
  deriveM64TargetSelectorPolicyHash,
} from "../../services/control-plane/control-plane/lib/m6-live-production-dependencies.mjs";
import {
  deriveM64ObservedStateHash,
} from "../../services/control-plane/control-plane/lib/m6-device-read-snapshot.mjs";
import {
  M6_TARGET_ENVIRONMENT_QUALIFICATION_TTL_MS,
  deriveM64TargetEnvironmentCommandRegistryHash,
} from "../../services/control-plane/apps/xiaowei/m6-target-environment-qualification.mjs";
import { canonicalJson, sha256 } from "../../services/control-plane/control-plane/lib/canonical.mjs";
import { M6_GATE_V2_LOCK_KINDS } from "../../services/control-plane/control-plane/lib/m6-live-gate-v2.mjs";
import {
  buildSystemTcbAclPlan,
  createSystemTcbAclController,
} from "../../services/control-plane/control-plane/lib/windows-system-tcb-acl.mjs";
import {
  M64_FINAL_ASSEMBLER_INPUT_SCHEMA_ID,
  M64_FINAL_ASSEMBLER_RECEIPT_SCHEMA_ID,
  assembleM64FinalProductionArtifacts,
  planM64FinalProductionArtifacts,
} from "./m6-4-production-release-assembler.mjs";
import {
  publishRecoverableCreateOnly,
  RecoverablePublicationError,
} from "./lib/recoverable-create-only-publication.mjs";

export const M64_FRESH_ASSEMBLER_INPUT_BUILD_SCHEMA_ID =
  "xw.m6-4-fresh-production-assembler-input-build.v1";
export const M64_FRESH_ASSEMBLER_INPUT_AUTHORITY_SCHEMA_ID =
  "xw.m6-4-fresh-production-assembler-input-authority.v1";
export const M64_FORMAL_RUNTIME_ROOT = "C:\\Users\\Public\\xw-runtime";
export const M64_ORACLE_ACTOR_TRUST_ROOT_RELEASE_PATH =
  "artifacts/m6-4/trust-roots/oracle-actors.v1.json";
export const M64_ORACLE_ACTOR_TRUST_ROOT_SHA256 =
  "c1d21303b846706243796603aecb676643e003d4dc06542aa6ceb8adf5c5d7da";

const HASH = /^(?!0{64}$)[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/u;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_EXPECTATIONS = 256;
const EXPECTATION_AUTHOR_KEY_ID = "expectation-author-01";
const OBSERVATION_OBSERVER_KEY_ID = "observation-observer-01";
const ORACLE_ACTOR_REGISTRY_SCHEMA_ID = "xw.m6-4-independent-oracle-actor-registry.v1";
const ORACLE_ACTOR_REGISTRY_KEYS = Object.freeze(["actors", "schemaId"]);
const ORACLE_ACTOR_KEYS = Object.freeze([
  "actorHash", "keyId", "publicKey", "publicKeyFingerprintSha256", "role",
]);
const PUBLIC_XHS_PACKAGE = "com.xingin.xhs";
const PUBLIC_SETTINGS_PACKAGE = "com.android.settings";
const STATE_FIELDS = Object.freeze([
  "appPackageHash", "blockId", "displayHash", "environmentAttestationHash", "focusHash",
  "frameId", "pageFingerprint", "rotation", "slotSpecHash", "uiStateGeneration",
]);
const FORBIDDEN_ORACLE_SOURCE_KINDS = Object.freeze([
  "BROKER_ACK", "CONTROL_PLANE_LEDGER", "DSH_RESULT", "GROUNDED_ACTION_RECEIPT",
  "MODEL_OUTPUT", "SUT_RECEIPT", "TRANSPORT_RESULT",
]);
const ENVIRONMENT_QUALIFICATION_KEYS = Object.freeze([
  "actionCount", "alias", "capturedAt", "commandRegistryHash", "effectBoundary",
  "expiresAt", "gateFEligible", "qualifiedAttestationHashes", "rawDeviceIdentityPresent",
  "sampleCount", "schemaId", "secretMaterialPresent", "status",
]);
const COHORT_FILENAMES = Object.freeze({
  M6_4_SHADOW: "m6_4_shadow.json",
  M6_4_HOT_CLOSE: "m6_4_hot_close.json",
  M6_4_ACTION_SMOKE: "m6_4_action_smoke.json",
  M6_4_RELIABILITY: "m6_4_reliability.json",
  M6_4_SMOOTH: "m6_4_smooth.json",
});
const SOURCE_LOCK_PATHS = Object.freeze({
  runtimeProfile: "packages/kernel/contracts/runtime-profile.v1.json",
  hardRedlinePolicy: "integrations/dsh-xw/config/hard-redline-policy.v1.json",
  groundingRuntime: "artifacts/m6-4/tcb-manifests/xw.m6-grounded-run.tcb.v1.json",
  dshSource: "integrations/dsh-xw/src/live-worker-driver.mjs",
  dshProfile: "integrations/dsh-xw/src/live-model-profile.mjs",
  liveToolSpec: "integrations/dsh-xw/src/live-tools.mjs",
  liveProvider: "integrations/dsh-xw/src/live-network-guard.mjs",
  grantActionPolicy: "packages/kernel/lib/m6-4-live-window-authorization.mjs",
  brokerProtocol: "integrations/dsh-xw/src/live-parent-broker.mjs",
  typedTransport: "services/control-plane/control-plane/lib/m6-typed-transport.mjs",
});
const SECRET_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{6,})/u;

const DEFAULT_TCB_ACL_CONTROLLER = createSystemTcbAclController();

function verifyProtectedPath({ runtimeRoot, targetPath, recursive = false }) {
  return DEFAULT_TCB_ACL_CONTROLLER.verify(buildSystemTcbAclPlan({
    boundaryPath: runtimeRoot,
    targetPath,
    recursive,
  }));
}

function protectProtectedPath({ runtimeRoot, targetPath, recursive = false }) {
  return DEFAULT_TCB_ACL_CONTROLLER.protect(buildSystemTcbAclPlan({
    boundaryPath: runtimeRoot,
    targetPath,
    recursive,
  }));
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  verifyReleaseManifest,
  verifyCapabilitySeal: verifyM6GroundedRunCapabilitySeal,
  verifyDependencyLayer: verifyM6LiveRuntimeDependencyLayer,
  loadModelBundle: loadContentAddressedLiveModelQualificationBundle,
  recomputeArtifact: recomputeM6GateFArtifact,
  verifyProtectedPath,
  protectProtectedPath,
  actorTrustRootSha256: M64_ORACLE_ACTOR_TRUST_ROOT_SHA256,
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
    fail("M64_FRESH_INPUT_INVALID", `${label} must contain exactly ${keys.join(", ")}`);
  }
  return value;
}

function normalizedPath(path) {
  const full = resolve(path);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function within(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertAbsolute(path, label) {
  if (typeof path !== "string" || path.length < 3 || path.length > 32_767
    || path.includes("\0") || !isAbsolute(path)) {
    fail("M64_FRESH_PATH_INVALID", `${label} must be one bounded absolute path`);
  }
  return resolve(path);
}

function sameFilesystemObject(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function assertPlainExisting(path, label, { directory, maxBytes = MAX_SOURCE_BYTES } = {}) {
  const target = assertAbsolute(path, label);
  let stat;
  let real;
  let realStat;
  try {
    stat = lstatSync(target, { bigint: true });
    real = realpathSync.native(target);
    realStat = lstatSync(real, { bigint: true });
  } catch (cause) {
    fail("M64_FRESH_PATH_UNAVAILABLE", `${label} is unavailable`, { cause: cause?.code ?? cause?.message });
  }
  if (stat.isSymbolicLink() || !sameFilesystemObject(stat, realStat)
    || (directory ? !stat.isDirectory() : (!stat.isFile() || stat.nlink !== 1n
      || stat.size < 1n || stat.size > BigInt(maxBytes)))) {
    fail("M64_FRESH_PATH_NOT_PLAIN", `${label} must be one plain ${directory ? "directory" : "single-link bounded file"}`);
  }
  return target;
}

function assertPlainAncestors(path, label, { allowMissing = false } = {}) {
  const target = assertAbsolute(path, label);
  const volumeRoot = parse(target).root;
  let cursor = dirname(target);
  while (cursor && !samePath(cursor, volumeRoot)) {
    if (!existsSync(cursor)) {
      if (!allowMissing) fail("M64_FRESH_PATH_UNAVAILABLE", `${label} parent is unavailable`);
      cursor = dirname(cursor);
      continue;
    }
    assertPlainExisting(cursor, `${label} parent`, { directory: true });
    cursor = dirname(cursor);
  }
  return target;
}

function readPlainBytes(path, label, { maxBytes = MAX_SOURCE_BYTES } = {}) {
  assertPlainAncestors(path, label);
  const target = assertPlainExisting(path, label, { directory: false, maxBytes });
  let descriptor;
  try {
    const before = lstatSync(target, { bigint: true });
    descriptor = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor, { bigint: true });
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n
      || !sameFilesystemObject(before, opened) || !sameFilesystemObject(opened, after)
      || opened.size !== after.size || after.size !== BigInt(bytes.length)) {
      fail("M64_FRESH_PATH_RACE", `${label} changed while it was read`);
    }
    return Object.freeze({ path: target, bytes, sha256: sha256(bytes) });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readJson(path, label, options = {}) {
  const file = readPlainBytes(path, label, { maxBytes: options.maxBytes ?? MAX_JSON_BYTES });
  let value;
  try { value = JSON.parse(file.bytes.toString("utf8")); } catch (cause) {
    fail("M64_FRESH_JSON_INVALID", `${label} is malformed JSON`, { cause: cause?.message });
  }
  return Object.freeze({ ...file, value });
}

function prettyBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertSecretFree(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_JSON_BYTES
    || SECRET_VALUE.test(bytes.toString("utf8"))) {
    fail("M64_FRESH_SECRET_MATERIAL_FORBIDDEN", `${label} contains secret-shaped material or exceeds the byte bound`);
  }
}

function artifact(path, bytes, label) {
  assertSecretFree(bytes, label);
  return Object.freeze({ path: resolve(path), bytes, label, sha256: sha256(bytes) });
}

function jsonArtifact(path, value, label) {
  return artifact(path, prettyBytes(value), label);
}

function verifyRelease(releaseId, sourceCommit, runtimeRoot, dependencies) {
  if (!RELEASE_ID.test(releaseId ?? "") || !COMMIT.test(sourceCommit ?? "")) {
    fail("M64_FRESH_RELEASE_BINDING_INVALID", "releaseId/sourceCommit must be one exact formal-release identity");
  }
  const runtime = assertPlainExisting(runtimeRoot, "formal runtime root", { directory: true });
  const releaseRoot = join(runtime, "releases", releaseId);
  const root = assertPlainExisting(releaseRoot, "immutable formal release root", { directory: true });
  assertProtectedPath(
    { runtimeRoot: runtime }, dependencies, root, "immutable formal release root", { recursive: true },
  );
  const manifestFile = readJson(join(root, "release-manifest.v1.json"), "immutable release manifest");
  if (manifestFile.value?.releaseId !== releaseId || manifestFile.value?.sourceCommit !== sourceCommit
    || !samePath(root, join(runtime, "releases", releaseId))) {
    fail("M64_FRESH_RELEASE_BINDING_INVALID", "formal release manifest does not match the requested release/source identity");
  }
  const verification = dependencies.verifyReleaseManifest({ root, manifestPath: manifestFile.path });
  if (!verification?.ok) {
    fail("M64_FRESH_RELEASE_INVALID", "formal release manifest verification failed", {
      mismatches: verification?.mismatches ?? [],
    });
  }
  const capabilities = readJson(
    join(root, "services", "control-plane", "apps", "xiaowei", "capabilities.json"),
    "grounded-run capability catalog",
  ).value;
  const matches = capabilities?.capabilities?.filter?.((item) => item?.id === M6_GROUNDED_RUN_CAPABILITY_ID) ?? [];
  if (matches.length !== 1) {
    fail("M64_FRESH_TCB_SEAL_INVALID", "release must contain exactly one grounded-run capability seal");
  }
  const seal = dependencies.verifyCapabilitySeal({ capability: matches[0], rootDir: root });
  if (seal?.capabilityId !== M6_GROUNDED_RUN_CAPABILITY_ID
    || !HASH.test(seal?.implementationClosureHash ?? "")
    || typeof seal?.tcbManifestRef !== "string" || seal.tcbManifestRef.length < 3) {
    fail("M64_FRESH_TCB_SEAL_INVALID", "grounded-run capability seal is incomplete");
  }
  return Object.freeze({
    runtimeRoot: runtime,
    root,
    manifestPath: manifestFile.path,
    manifestSha256: manifestFile.sha256,
    manifest: Object.freeze(manifestFile.value),
    releaseId,
    sourceCommit,
    sourceShort: sourceCommit.slice(0, 7),
    seal,
  });
}

function verifyEnvironment({ release, attestationHash, qualificationSha256, accountIsolationBindingHash, nowMs, dependencies }) {
  if (![attestationHash, qualificationSha256, accountIsolationBindingHash].every((value) => HASH.test(value ?? ""))) {
    fail("M64_FRESH_ENVIRONMENT_BINDING_INVALID", "environment/account content addresses must be nonzero SHA-256 values");
  }
  const root = assertPlainExisting(
    join(release.runtimeRoot, "m6-audit", `m6-c1-target-environment-${release.sourceShort}`),
    "fixed target-environment qualification root",
    { directory: true },
  );
  const attestationPath = join(root, "attestations", `${attestationHash}.json`);
  const qualificationPath = join(root, "qualifications", `${qualificationSha256}.json`);
  const attestationFile = readJson(attestationPath, "fresh target-environment attestation");
  const qualificationFile = readJson(qualificationPath, "fresh target-environment qualification");
  if (attestationFile.value?.attestationHash !== attestationHash
    || qualificationFile.sha256 !== qualificationSha256) {
    fail("M64_FRESH_ENVIRONMENT_BINDING_INVALID", "environment artifacts are not stored under their exact content addresses");
  }
  const attestationResult = dependencies.recomputeArtifact(
    { mode: "TARGET_ENV_ATTESTATION", path: attestationPath }, attestationHash, { nowMs },
  );
  const qualificationResult = dependencies.recomputeArtifact(
    { mode: "ENVIRONMENT_QUALIFICATION", path: qualificationPath }, qualificationSha256, { nowMs },
  );
  const qualification = exactObject(
    qualificationResult.value, ENVIRONMENT_QUALIFICATION_KEYS, "environment qualification",
  );
  if (attestationResult.hash !== attestationHash || qualificationResult.hash !== qualificationSha256
    || attestationResult.value.accountIsolationHash !== accountIsolationBindingHash
    || canonicalJson(qualification.qualifiedAttestationHashes) !== canonicalJson([attestationHash])
    || qualification.capturedAt !== attestationResult.value.capturedAt
    || qualification.expiresAt !== attestationResult.value.expiresAt
    || qualification.commandRegistryHash !== deriveM64TargetEnvironmentCommandRegistryHash()
    || Date.parse(qualification.expiresAt) - Date.parse(qualification.capturedAt)
      !== M6_TARGET_ENVIRONMENT_QUALIFICATION_TTL_MS
    || Date.parse(qualification.capturedAt) >= nowMs) {
    fail("M64_FRESH_ENVIRONMENT_BINDING_INVALID", "target environment is stale, cross-account, or not the exact read-only qualification");
  }
  return Object.freeze({
    root,
    attestationPath,
    attestationRawSha256: attestationFile.sha256,
    attestation: Object.freeze(attestationResult.value),
    qualificationPath,
    qualificationSha256,
    qualification: Object.freeze(qualification),
  });
}

function verifyDependencyAndModel({ release, dependencyLayerHash, modelProfileHash, environment, nowMs, dependencies }) {
  if (!HASH.test(dependencyLayerHash ?? "") || !HASH.test(modelProfileHash ?? "")) {
    fail("M64_FRESH_MODEL_BINDING_INVALID", "dependency/model content addresses must be nonzero SHA-256 values");
  }
  const dependencyRoot = assertPlainExisting(
    join(release.runtimeRoot, "m6-runtime-layers", dependencyLayerHash),
    "fixed runtime dependency layer",
    { directory: true },
  );
  const dependency = dependencies.verifyDependencyLayer({
    layerRoot: dependencyRoot,
    expectedLayerHash: dependencyLayerHash,
    sourceRoot: release.root,
  });
  if (!dependency?.ok || dependency.layerHash !== dependencyLayerHash
    || !HASH.test(dependency?.qualification?.qualificationHash ?? "")
    || dependency.qualification.releaseId !== release.releaseId
    || dependency.qualification.sourceCommit !== release.sourceCommit
    || dependency.qualification.sourceReleaseManifestSha256 !== release.manifestSha256) {
    fail("M64_FRESH_DEPENDENCY_LAYER_REBOUND", "dependency layer is not qualified for the exact formal release");
  }
  const modelRoot = assertPlainExisting(
    join(release.runtimeRoot, "m6-audit", `m6-c1-live-model-qualification-${release.sourceShort}`),
    "fixed live-model qualification root",
    { directory: true },
  );
  let model;
  try {
    model = dependencies.loadModelBundle({
      qualificationRoot: modelRoot,
      expectedProfileHash: modelProfileHash,
      installed: dependency.installedAdapter,
      runtimeEndpoint: SEALED_LIVE_PROVIDER_BASE_URL,
      requiredRuntimeDependencyQualificationHash: dependency.qualification.qualificationHash,
      requiredTargetEnvironmentAttestationHash: environment.attestation.attestationHash,
      now: nowMs,
    });
  } catch (cause) {
    fail("M64_FRESH_MODEL_BINDING_INVALID", "live-model qualification is stale or rebound", {
      cause: cause?.code ?? cause?.message,
      errors: cause?.errors ?? [],
    });
  }
  if (model?.profile?.contentHash !== modelProfileHash
    || model.profile.runtimeDependencyQualificationHash !== dependency.qualification.qualificationHash
    || model.profile.targetEnvironmentAttestationHash !== environment.attestation.attestationHash
    || model.qualification?.runtimeDependencyQualificationHash !== dependency.qualification.qualificationHash
    || model.qualification?.targetEnvironmentAttestationHash !== environment.attestation.attestationHash
    || Date.parse(model.profile.expiresAt) > Date.parse(environment.attestation.expiresAt)
    || Date.parse(model.profile.capturedAt) < Date.parse(environment.attestation.capturedAt)
    || Date.parse(model.profile.expiresAt) <= nowMs) {
    fail("M64_FRESH_MODEL_BINDING_INVALID", "model profile does not bind the fresh environment and exact dependency qualification");
  }
  return Object.freeze({ dependencyRoot, dependencyLayerHash, dependency, modelRoot, modelProfileHash, model });
}

function assertProtectedPath(release, dependencies, targetPath, label, { recursive = false } = {}) {
  try {
    const receipt = dependencies.verifyProtectedPath({
      runtimeRoot: release.runtimeRoot,
      targetPath,
      recursive,
    });
    if (receipt?.ok !== true) fail("M64_FRESH_TCB_ACL_INVALID", `${label} is not under the fixed SYSTEM TCB ACL`);
  } catch (cause) {
    if (cause?.code === "M64_FRESH_TCB_ACL_INVALID") throw cause;
    fail("M64_FRESH_TCB_ACL_INVALID", `${label} SYSTEM TCB ACL verification failed closed`, {
      cause: cause?.code ?? cause?.message,
    });
  }
}

function validateTrustedPublicActor(raw, expectedRole, expectedKeyId) {
  const value = exactObject(raw, ORACLE_ACTOR_KEYS, `${expectedRole} public trust-root actor`);
  if (value.role !== expectedRole || value.keyId !== expectedKeyId
    || !HASH.test(value.actorHash ?? "") || !HASH.test(value.publicKeyFingerprintSha256 ?? "")
    || typeof value.publicKey !== "string" || value.publicKey.length > 4096) {
    fail("M64_FRESH_ACTOR_TRUST_ROOT_INVALID", `${expectedRole} public trust-root identity is malformed or rebound`);
  }
  let publicKey;
  try { publicKey = createPublicKey(value.publicKey); } catch {
    fail("M64_FRESH_ACTOR_TRUST_ROOT_INVALID", `${expectedRole} public trust-root key is not parseable`);
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    fail("M64_FRESH_ACTOR_TRUST_ROOT_INVALID", `${expectedRole} public trust-root key must be Ed25519`);
  }
  const canonicalPublicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  if (canonicalPublicPem !== value.publicKey
    || deriveM64IndependentActorHash(publicKey) !== value.actorHash
    || sha256(publicDer) !== value.publicKeyFingerprintSha256) {
    fail("M64_FRESH_ACTOR_TRUST_ROOT_INVALID", `${expectedRole} public identity does not match its pinned hashes`);
  }
  return Object.freeze({ ...value, publicKeyObject: publicKey });
}

function loadFixedActor(privateKeyPath, trusted, release, dependencies) {
  assertProtectedPath(release, dependencies, privateKeyPath, `${trusted.role} private key`);
  const file = readPlainBytes(privateKeyPath, `${trusted.role} private key`, { maxBytes: 64 * 1024 });
  let privateKey;
  try {
    privateKey = createPrivateKey(file.bytes);
  } catch {
    fail("M64_FRESH_SIGNER_INVALID", `${trusted.role} private key is not parseable`);
  } finally {
    file.bytes.fill(0);
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    fail("M64_FRESH_SIGNER_INVALID", `${trusted.role} private key must be Ed25519`);
  }
  const publicKey = createPublicKey(privateKey);
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  const actorHash = deriveM64IndependentActorHash(publicKey);
  const publicKeyFingerprintSha256 = sha256(publicDer);
  if (publicPem !== trusted.publicKey || actorHash !== trusted.actorHash
    || publicKeyFingerprintSha256 !== trusted.publicKeyFingerprintSha256) {
    fail("M64_FRESH_SIGNER_REBOUND", `${trusted.role} private key does not derive the pinned formal-release public identity`);
  }
  return Object.freeze({
    role: trusted.role,
    keyId: trusted.keyId,
    privateKey,
    publicKey,
    publicPem,
    actorHash,
    publicKeyFingerprintSha256,
  });
}

function loadActors(release, dependencies) {
  const expectedTrustRootSha256 = dependencies.actorTrustRootSha256;
  if (!HASH.test(expectedTrustRootSha256 ?? "")) {
    fail("M64_FRESH_ACTOR_TRUST_ROOT_INVALID", "fixed actor trust-root hash is invalid");
  }
  const registryPath = join(
    release.root, ...M64_ORACLE_ACTOR_TRUST_ROOT_RELEASE_PATH.split("/"),
  );
  const manifestEntries = Array.isArray(release.manifest.files)
    ? release.manifest.files.filter((entry) => entry?.path === M64_ORACLE_ACTOR_TRUST_ROOT_RELEASE_PATH)
    : [];
  if (manifestEntries.length !== 1 || manifestEntries[0].sha256 !== expectedTrustRootSha256) {
    fail("M64_FRESH_ACTOR_TRUST_ROOT_INVALID", "formal release manifest does not pin the exact oracle actor trust root");
  }
  assertProtectedPath(release, dependencies, registryPath, "formal-release oracle actor trust root");
  const registryFile = readJson(registryPath, "formal-release oracle actor trust root", { maxBytes: 64 * 1024 });
  if (registryFile.sha256 !== expectedTrustRootSha256) {
    fail("M64_FRESH_ACTOR_TRUST_ROOT_INVALID", "oracle actor trust-root bytes differ from the pinned historical identity");
  }
  const registry = exactObject(
    registryFile.value, ORACLE_ACTOR_REGISTRY_KEYS, "formal-release oracle actor trust root",
  );
  if (registry.schemaId !== ORACLE_ACTOR_REGISTRY_SCHEMA_ID
    || !Array.isArray(registry.actors) || registry.actors.length !== 2) {
    fail("M64_FRESH_ACTOR_TRUST_ROOT_INVALID", "oracle actor trust root must contain exactly the two fixed public identities");
  }
  const trustedAuthor = validateTrustedPublicActor(
    registry.actors[0], "EXPECTATION_AUTHOR", EXPECTATION_AUTHOR_KEY_ID,
  );
  const trustedObserver = validateTrustedPublicActor(
    registry.actors[1], "OBSERVATION_OBSERVER", OBSERVATION_OBSERVER_KEY_ID,
  );
  if (trustedAuthor.actorHash === trustedObserver.actorHash) {
    fail("M64_FRESH_SIGNER_NOT_INDEPENDENT", "pinned expectation and observation public actors must be distinct");
  }
  const keyRoot = join(release.runtimeRoot, "secrets", "oracle-actor-keys");
  const author = loadFixedActor(
    join(keyRoot, `${EXPECTATION_AUTHOR_KEY_ID}.pkcs8.pem`), trustedAuthor, release, dependencies,
  );
  const observer = loadFixedActor(
    join(keyRoot, `${OBSERVATION_OBSERVER_KEY_ID}.pkcs8.pem`), trustedObserver, release, dependencies,
  );
  if (author.actorHash === observer.actorHash) {
    fail("M64_FRESH_SIGNER_NOT_INDEPENDENT", "expectation author and observation observer must be distinct actors");
  }
  const gateRoot = assertPlainExisting(join(release.runtimeRoot, "m6-gate"), "fixed M6 Gate root", {
    directory: true,
  });
  assertProtectedPath(release, dependencies, gateRoot, "fixed M6 Gate root");
  const runtimeRegistryPath = join(gateRoot, "oracle-actor-keys.json");
  if (existsSync(runtimeRegistryPath)) {
    assertProtectedPath(release, dependencies, runtimeRegistryPath, "runtime oracle actor trust root");
    const installed = readPlainBytes(runtimeRegistryPath, "runtime oracle actor trust root", { maxBytes: 64 * 1024 });
    if (installed.sha256 !== registryFile.sha256 || !installed.bytes.equals(registryFile.bytes)) {
      fail("M64_FRESH_ACTOR_TRUST_ROOT_REBOUND", "runtime oracle actor trust root differs from the formal-release pinned bytes");
    }
  }
  return Object.freeze({
    author,
    observer,
    registryFile,
    runtimeRegistryPath,
  });
}

function readCohortSources(release) {
  const sourceRoot = join(release.root, "artifacts", "m6-4", "cohort-manifests");
  const boundaryFile = readJson(join(sourceRoot, "xw.m6-effect-boundary.v1.json"), "release effect boundary");
  const boundaryValidation = validateM64EffectBoundary(boundaryFile.value);
  if (!boundaryValidation.ok) {
    fail("M64_FRESH_EFFECT_BOUNDARY_INVALID", "release effect boundary is invalid", {
      errors: boundaryValidation.errors,
    });
  }
  const manifests = M6_GATE_F_ARTIFACT_CATALOG_PURPOSES.map((purpose) => {
    const filename = COHORT_FILENAMES[purpose];
    if (!filename) fail("M64_FRESH_COHORT_SET_INVALID", `no frozen cohort filename for ${purpose}`);
    const file = readJson(join(sourceRoot, filename), `${purpose} release cohort manifest`);
    const validation = validateM64CohortManifest(file.value);
    if (!validation.ok || file.value.purpose !== purpose
      || file.value.scenarios?.some((scenario) => scenario.effectBoundaryHash !== boundaryFile.value.boundaryHash)) {
      fail("M64_FRESH_COHORT_SET_INVALID", `${purpose} release cohort is invalid or rebound`, {
        errors: validation.errors,
      });
    }
    return Object.freeze({ purpose, filename, file, manifest: Object.freeze(file.value) });
  });
  const scenarioCount = manifests.reduce((sum, item) => sum + item.manifest.scenarios.length, 0);
  if (scenarioCount < 1 || scenarioCount > MAX_EXPECTATIONS) {
    fail("M64_FRESH_COHORT_SET_INVALID", "five-window scenario count exceeds the bounded expectation envelope");
  }
  return Object.freeze({
    sourceRoot,
    boundaryFile,
    boundary: Object.freeze(boundaryFile.value),
    manifests: Object.freeze(manifests),
    scenarioCount,
  });
}

function authorityHash({ release, environment, qualified, actors }) {
  const authority = Object.freeze({
    schemaId: M64_FRESH_ASSEMBLER_INPUT_AUTHORITY_SCHEMA_ID,
    releaseId: release.releaseId,
    sourceCommit: release.sourceCommit,
    releaseManifestSha256: release.manifestSha256,
    implementationClosureHash: release.seal.implementationClosureHash,
    environmentAttestationHash: environment.attestation.attestationHash,
    environmentQualificationSha256: environment.qualificationSha256,
    accountIsolationBindingHash: environment.attestation.accountIsolationHash,
    dependencyLayerHash: qualified.dependencyLayerHash,
    runtimeDependencyQualificationHash: qualified.dependency.qualification.qualificationHash,
    modelProfileHash: qualified.modelProfileHash,
    oracleActorTrustRootSha256: actors.registryFile.sha256,
    expectationAuthorHash: actors.author.actorHash,
    observationObserverHash: actors.observer.actorHash,
  });
  return Object.freeze({
    authority,
    hash: sha256(`${M64_FRESH_ASSEMBLER_INPUT_AUTHORITY_SCHEMA_ID}:${canonicalJson(authority)}`),
  });
}

function sourceLockArtifacts({ release, bundleRoot }) {
  const artifacts = [];
  const descriptors = {};
  for (const [kind, relativePath] of Object.entries(SOURCE_LOCK_PATHS)) {
    const sourcePath = join(release.root, ...relativePath.split("/"));
    if (!within(release.root, sourcePath)) fail("M64_FRESH_SOURCE_LOCK_INVALID", `${kind} escaped the release root`);
    const source = readPlainBytes(sourcePath, `${kind} frozen release source`);
    const value = Object.freeze({
      schemaId: "xw.m6-4-frozen-source-lock.v1",
      kind,
      releaseId: release.releaseId,
      sourceCommit: release.sourceCommit,
      sourcePath,
      sourceSha256: source.sha256,
    });
    const output = jsonArtifact(join(bundleRoot, "locks", `${kind}.lock.json`), value, `${kind} source lock`);
    artifacts.push(output);
    descriptors[kind] = Object.freeze({ mode: "RAW_SHA256", path: output.path, expectedHash: output.sha256 });
  }
  const rawKinds = M6_GATE_V2_LOCK_KINDS.filter((kind) => ![
    "modelProfile", "scenarioManifest", "environmentQualification",
  ].includes(kind));
  if (canonicalJson(Object.keys(descriptors).sort()) !== canonicalJson([...rawKinds].sort())) {
    fail("M64_FRESH_SOURCE_LOCK_INVALID", "fixed source-lock mapping is not the exact Gate-v2 raw lock set");
  }
  return Object.freeze({ artifacts: Object.freeze(artifacts), descriptors: Object.freeze(descriptors) });
}

function resetObligationsFor(boundary, primaryFamily) {
  const matches = boundary.families.filter((entry) => entry.primaryFamily === primaryFamily);
  if (matches.length !== 1 || !Array.isArray(matches[0].resetObligations)) {
    fail("M64_FRESH_EFFECT_BOUNDARY_INVALID", `effect boundary has no unique family ${primaryFamily}`);
  }
  return [...matches[0].resetObligations];
}

function buildDependencyArtifacts({ release, environment, qualified, actors, cohorts, bundleRoot, nowMs }) {
  const artifacts = [];
  const cohortDescriptors = new Map();
  let effectBoundaryArtifact = null;
  for (const item of cohorts.manifests) {
    const copied = artifact(
      join(bundleRoot, "cohort-manifests", item.filename), item.file.bytes,
      `${item.purpose} copied cohort manifest`,
    );
    artifacts.push(copied);
    cohortDescriptors.set(item.purpose, Object.freeze({
      mode: "M6_COHORT_MANIFEST", path: copied.path, expectedHash: item.manifest.manifestHash,
    }));
  }
  effectBoundaryArtifact = artifact(
    join(bundleRoot, "cohort-manifests", "xw.m6-effect-boundary.v1.json"),
    cohorts.boundaryFile.bytes,
    "copied effect boundary",
  );
  artifacts.push(effectBoundaryArtifact);

  const authoredAt = environment.attestation.capturedAt;
  const expiresAtMs = Math.min(
    Date.parse(environment.attestation.expiresAt),
    Date.parse(environment.qualification.expiresAt),
    Date.parse(qualified.model.profile.expiresAt),
    Date.parse(qualified.model.qualification.expiresAt),
  );
  if (!Number.isFinite(expiresAtMs) || Date.parse(authoredAt) >= nowMs || expiresAtMs <= nowMs) {
    fail("M64_FRESH_EXPECTATION_WINDOW_INVALID", "fresh qualification window cannot bound pre-authored expectations");
  }
  const expiresAt = new Date(expiresAtMs).toISOString();
  const expectationEntries = [];
  const selectorRules = [];
  const seenLookups = new Set();
  const seenSelectorRules = new Set();
  for (const item of cohorts.manifests) {
    for (const scenario of item.manifest.scenarios) {
      const resetObligations = resetObligationsFor(cohorts.boundary, scenario.primaryFamily);
      const expectedStateHash = deriveM64ObservedStateHash({
        request: {
          accountIsolationHash: environment.attestation.accountIsolationHash,
          scenarioKey: scenario.scenarioKey,
          primaryFamily: scenario.primaryFamily,
          oracleHash: scenario.oracleHash,
          effectBoundaryHash: scenario.effectBoundaryHash,
        },
        observedEffects: [],
        resetObligations,
      });
      const expectation = deriveM64ExpectedStateArtifact({
        schemaId: "xw.m6-4-independent-expected-state.v1",
        purpose: item.purpose,
        manifestHash: item.manifest.manifestHash,
        scenarioKey: scenario.scenarioKey,
        primaryFamily: scenario.primaryFamily,
        oracleHash: scenario.oracleHash,
        effectBoundaryHash: scenario.effectBoundaryHash,
        environmentAttestationHash: environment.attestation.attestationHash,
        accountIsolationHash: environment.attestation.accountIsolationHash,
        expectedStateHash,
        independentAuthorHash: actors.author.actorHash,
        sourceClass: "INDEPENDENT_PRE_DISPATCH",
        selfDerived: false,
        authoredAt,
        expiresAt,
      });
      const validation = validateM64ExpectedStateArtifact(expectation, { nowMs });
      if (!validation.ok) {
        fail("M64_FRESH_EXPECTATION_INVALID", `${scenario.scenarioKey} expectation is invalid`, {
          errors: validation.errors,
        });
      }
      const unsigned = Object.freeze({
        schemaId: M64_EXPECTATION_ENVELOPE_SCHEMA_ID,
        authorKeyId: actors.author.keyId,
        expectation,
        signatureAlgorithm: "Ed25519",
      });
      const signature = sign(
        null, canonicalM64ExpectationEnvelopeSigningBytes(unsigned), actors.author.privateKey,
      ).toString("base64");
      const envelope = Object.freeze({ ...unsigned, signature });
      if (!verifySignature(
        null, canonicalM64ExpectationEnvelopeSigningBytes(envelope), actors.author.publicKey,
        Buffer.from(signature, "base64"),
      )) {
        fail("M64_FRESH_EXPECTATION_SIGNATURE_INVALID", "generated expectation signature failed readback verification");
      }
      const lookupHash = deriveM64ExpectationLookupHash(expectation);
      if (seenLookups.has(lookupHash)) fail("M64_FRESH_EXPECTATION_DUPLICATE", "expectation lookup hash is duplicated");
      seenLookups.add(lookupHash);
      const envelopeArtifact = jsonArtifact(
        join(bundleRoot, "expectations", `${lookupHash}.expectation.json`),
        envelope,
        `${scenario.scenarioKey} signed expectation`,
      );
      artifacts.push(envelopeArtifact);
      expectationEntries.push(Object.freeze({
        lookupHash,
        expectationEnvelope: Object.freeze({ path: envelopeArtifact.path, sha256: envelopeArtifact.sha256 }),
      }));

      for (const slot of scenario.actionPlan.slots) {
        if (slot.targetKind !== "block") continue;
        const selectorKey = `${scenario.scenarioKey}:${slot.slotAuthorityHash}`;
        if (seenSelectorRules.has(selectorKey)) {
          fail("M64_FRESH_SELECTOR_POLICY_INVALID", "semantic target selector rule is duplicated");
        }
        seenSelectorRules.add(selectorKey);
        selectorRules.push(Object.freeze({
          scenarioKey: scenario.scenarioKey,
          slotAuthorityHash: slot.slotAuthorityHash,
          targetEligibilityHash: slot.targetEligibilityHash,
          requiredFeatures: Object.freeze({
            packageHash: m6LiveSha256(
              scenario.primaryFamily === "settings-nav" ? PUBLIC_SETTINGS_PACKAGE : PUBLIC_XHS_PACKAGE,
            ),
          }),
        }));
      }
    }
  }
  if (expectationEntries.length !== cohorts.scenarioCount || selectorRules.length < 1) {
    fail("M64_FRESH_DEPENDENCY_SET_INVALID", "expectation or target-selector cardinality is not closed");
  }
  expectationEntries.sort((left, right) => left.lookupHash.localeCompare(right.lookupHash, "en"));
  const indexRaw = Object.freeze({ schemaId: M64_EXPECTATION_INDEX_SCHEMA_ID, entries: expectationEntries });
  const expectationIndex = Object.freeze({
    ...indexRaw,
    indexHash: deriveM64ExpectationIndexHash(indexRaw),
  });
  const expectationIndexArtifact = jsonArtifact(
    join(bundleRoot, "expectations", "expectation-index.v1.json"),
    expectationIndex,
    "expectation index",
  );
  artifacts.push(expectationIndexArtifact);

  const observationRoot = join(bundleRoot, "independent-observer");
  const oracleRaw = Object.freeze({
    schemaId: M64_INDEPENDENT_ORACLE_POLICY_SCHEMA_ID,
    effectBoundaryHash: cohorts.boundary.boundaryHash,
    expectationIndex: Object.freeze({ path: expectationIndexArtifact.path, sha256: expectationIndexArtifact.sha256 }),
    expectationAuthorKeyId: actors.author.keyId,
    expectationAuthorPublicKey: actors.author.publicPem,
    independentAuthorHash: actors.author.actorHash,
    observationRoot,
    observationObserverKeyId: actors.observer.keyId,
    observationObserverPublicKey: actors.observer.publicPem,
    independentObserverHash: actors.observer.actorHash,
    allowedSourceKinds: Object.freeze(["DEVICE_READ_SNAPSHOT"]),
    requiredSourceKinds: Object.freeze(["DEVICE_READ_SNAPSHOT"]),
    forbiddenSourceKinds: FORBIDDEN_ORACLE_SOURCE_KINDS,
    maxObservationAgeMs: 30_000,
  });
  const oraclePolicy = Object.freeze({
    ...oracleRaw,
    policyHash: deriveM64IndependentOraclePolicyHash(oracleRaw),
  });
  const oraclePolicyArtifact = jsonArtifact(
    join(bundleRoot, "policies", "independent-oracle-policy.v1.json"),
    oraclePolicy,
    "independent oracle policy",
  );
  artifacts.push(oraclePolicyArtifact);

  const selectorRaw = Object.freeze({
    schemaId: M64_TARGET_SELECTOR_POLICY_SCHEMA_ID,
    effectBoundaryHash: cohorts.boundary.boundaryHash,
    rules: Object.freeze(selectorRules),
  });
  const selectorPolicy = Object.freeze({
    ...selectorRaw,
    policyHash: deriveM64TargetSelectorPolicyHash(selectorRaw),
  });
  const selectorPolicyArtifact = jsonArtifact(
    join(bundleRoot, "policies", "target-selector-policy.v1.json"),
    selectorPolicy,
    "target-selector policy",
  );
  artifacts.push(selectorPolicyArtifact);

  const guardRaw = Object.freeze({
    schemaId: M64_CURRENT_STATE_GUARD_POLICY_SCHEMA_ID,
    allowedSourceClass: "SERVER_OWNED_FRESH_CAPTURE",
    allowedSourceKind: "CONTROL_PLANE_FRAME_GUARD",
    maxCaptureAgeMs: 250,
    requiredStateFields: STATE_FIELDS,
  });
  const guardPolicy = Object.freeze({
    ...guardRaw,
    policyHash: deriveM64CurrentStateGuardPolicyHash(guardRaw),
  });
  const guardPolicyArtifact = jsonArtifact(
    join(bundleRoot, "policies", "current-state-guard-policy.v1.json"),
    guardPolicy,
    "current-state guard policy",
  );
  artifacts.push(guardPolicyArtifact);

  const operatorArtifact = jsonArtifact(
    join(bundleRoot, "runtime-artifacts", "operator.v1.json"),
    Object.freeze({
      schemaId: "xw.m6-4-production-operator.v1",
      alias: "01",
      controlPlane: "LOOPBACK_ONLY",
      orderedPurposes: M6_GATE_F_ARTIFACT_CATALOG_PURPOSES,
      secretMaterialPresent: false,
    }),
    "production operator",
  );
  artifacts.push(operatorArtifact);
  const resetArtifact = jsonArtifact(
    join(bundleRoot, "runtime-artifacts", "reset-obligations.v1.json"),
    Object.freeze({
      schemaId: "xw.m6-4-reset-obligations.v1",
      effectBoundaryHash: cohorts.boundary.boundaryHash,
      families: cohorts.boundary.families.map((family) => Object.freeze({
        primaryFamily: family.primaryFamily,
        resetObligations: Object.freeze([...family.resetObligations]),
      })),
      criticalZeroCounters: M64_LIVE_CRITICAL_ZERO_COUNTER_FIELDS,
    }),
    "reset obligations",
  );
  artifacts.push(resetArtifact);
  const actorRegistryArtifact = artifact(
    join(bundleRoot, "trust-roots", `${actors.registryFile.sha256}.oracle-actors.json`),
    actors.registryFile.bytes,
    "formal-release public oracle actor trust root",
  );
  artifacts.push(actorRegistryArtifact);
  const runtimeActorRegistryArtifact = Object.freeze({
    ...artifact(
      actors.runtimeRegistryPath,
      actors.registryFile.bytes,
      "fixed runtime public oracle actor trust root",
    ),
    requiresTcbProtection: true,
  });
  artifacts.push(runtimeActorRegistryArtifact);
  return Object.freeze({
    artifacts: Object.freeze(artifacts),
    cohortDescriptors,
    effectBoundaryArtifact,
    oraclePolicyArtifact,
    selectorPolicyArtifact,
    guardPolicyArtifact,
    operatorArtifact,
    resetArtifact,
    actorRegistryArtifact,
    runtimeActorRegistryArtifact,
    observationRoot,
    expectationCount: expectationEntries.length,
    authoredAt,
    expiresAt,
  });
}

function buildAssemblerInput({ release, environment, qualified, cohorts, locks, dependencies, bundleRoot, assemblerRoot }) {
  const outputRuntimeRoot = assemblerRoot;
  const input = Object.freeze({
    schemaId: M64_FINAL_ASSEMBLER_INPUT_SCHEMA_ID,
    release: Object.freeze({
      root: release.root,
      manifestPath: release.manifestPath,
      manifestSha256: release.manifestSha256,
      releaseId: release.releaseId,
      sourceCommit: release.sourceCommit,
      capabilityId: release.seal.capabilityId,
      implementationClosureHash: release.seal.implementationClosureHash,
      tcbManifestRef: release.seal.tcbManifestRef,
    }),
    outputs: Object.freeze({
      inventoryRoot: join(outputRuntimeRoot, "state", "control-plane", "gate-f-artifacts", "inventories"),
      artifactCatalogPath: join(outputRuntimeRoot, "state", "control-plane", "gate-f-artifacts", "gate-f-artifact-catalog.json"),
      productionDependencyBindingPath: join(outputRuntimeRoot, "config", "m6-4-production-dependency-binding.v1.json"),
      runtimeBindingPath: join(outputRuntimeRoot, "config", "m6-c1-runtime.v1.json"),
      receiptRoot: join(outputRuntimeRoot, "receipts"),
    }),
    runtime: Object.freeze({
      dependencyRoot: qualified.dependencyRoot,
      dependencyLayerHash: qualified.dependencyLayerHash,
      modelProfileRoot: qualified.modelRoot,
      modelProfileHash: qualified.modelProfileHash,
      providerBaseUrl: SEALED_LIVE_PROVIDER_BASE_URL,
      manifestRoot: join(bundleRoot, "cohort-manifests"),
      runtimeSnapshotPath: join(outputRuntimeRoot, "state", "control-plane", "m6-c1-live-window-runtime.v1.json"),
      dshPersistenceRoot: join(release.runtimeRoot, "state", "control-plane", "dsh-persistence"),
      gateId: `m6-4-gate-f-${release.sourceShort}`,
      gateIssuerAllowlistPath: join(release.runtimeRoot, "m6-gate", "issuer-keys.json"),
      liveAuthorizationIssuerAllowlistPath: join(release.runtimeRoot, "m6-gate", "live-window-owner-keys.json"),
    }),
    productionDependencies: Object.freeze({
      environmentAttestation: Object.freeze({
        path: environment.attestationPath,
        sha256: environment.attestationRawSha256,
      }),
      environmentQualification: Object.freeze({
        path: environment.qualificationPath,
        sha256: environment.qualificationSha256,
      }),
      effectBoundary: Object.freeze({
        path: dependencies.effectBoundaryArtifact.path,
        sha256: dependencies.effectBoundaryArtifact.sha256,
      }),
      independentOraclePolicy: Object.freeze({
        path: dependencies.oraclePolicyArtifact.path,
        sha256: dependencies.oraclePolicyArtifact.sha256,
      }),
      targetSelectorPolicy: Object.freeze({
        path: dependencies.selectorPolicyArtifact.path,
        sha256: dependencies.selectorPolicyArtifact.sha256,
      }),
      currentStateGuardPolicy: Object.freeze({
        path: dependencies.guardPolicyArtifact.path,
        sha256: dependencies.guardPolicyArtifact.sha256,
      }),
    }),
    windows: Object.freeze(cohorts.manifests.map((item) => Object.freeze({
      purpose: item.purpose,
      lockArtifacts: Object.freeze({
        ...locks.descriptors,
        modelProfile: Object.freeze({
          mode: "LIVE_MODEL_PROFILE", path: qualified.modelRoot, expectedHash: qualified.modelProfileHash,
        }),
        scenarioManifest: dependencies.cohortDescriptors.get(item.purpose),
        environmentQualification: Object.freeze({
          mode: "ENVIRONMENT_QUALIFICATION",
          path: environment.qualificationPath,
          expectedHash: environment.qualificationSha256,
        }),
      }),
      runtimeArtifacts: Object.freeze({
        environmentAttestation: Object.freeze({
          mode: "TARGET_ENV_ATTESTATION",
          path: environment.attestationPath,
          expectedHash: environment.attestation.attestationHash,
        }),
        independentOracle: Object.freeze({
          mode: "RAW_SHA256",
          path: dependencies.oraclePolicyArtifact.path,
          expectedHash: dependencies.oraclePolicyArtifact.sha256,
        }),
        operator: Object.freeze({
          mode: "RAW_SHA256", path: dependencies.operatorArtifact.path,
          expectedHash: dependencies.operatorArtifact.sha256,
        }),
        resetObligations: Object.freeze({
          mode: "RAW_SHA256", path: dependencies.resetArtifact.path,
          expectedHash: dependencies.resetArtifact.sha256,
        }),
      }),
    }))),
  });
  return input;
}

function assertFixedRuntimeInputs(input, release, assemblerRoot) {
  for (const [path, label] of [
    [input.runtime.dshPersistenceRoot, "DSH persistence root"],
    [input.runtime.gateIssuerAllowlistPath, "Gate issuer allowlist"],
    [input.runtime.liveAuthorizationIssuerAllowlistPath, "live-window issuer allowlist"],
  ]) {
    assertPlainExisting(path, label, { directory: label.endsWith("root") });
  }
  if (!samePath(assemblerRoot, join(
    release.runtimeRoot, "cutover-m6-assembler", release.releaseId, release.sourceCommit,
  ))) {
    fail("M64_FRESH_OUTPUT_ROOT_INVALID", "assembler output root escaped its release/source fixed slot");
  }
}

function ensurePlainDirectory(path, boundaryRoot, label) {
  const target = assertAbsolute(path, label);
  if (!within(boundaryRoot, target) || samePath(boundaryRoot, target)) {
    fail("M64_FRESH_OUTPUT_ROOT_INVALID", `${label} escaped the fixed runtime root`);
  }
  assertPlainAncestors(join(target, "sentinel"), label, { allowMissing: true });
  mkdirSync(target, { recursive: true, mode: 0o700 });
  return assertPlainExisting(target, label, { directory: true });
}

function publishArtifact(item, runtimeRoot) {
  if (!within(runtimeRoot, item.path)) {
    fail("M64_FRESH_OUTPUT_ROOT_INVALID", `${item.label} escaped the fixed runtime root`);
  }
  ensurePlainDirectory(dirname(item.path), runtimeRoot, `${item.label} parent`);
  try {
    const result = publishRecoverableCreateOnly({ targetPath: item.path, bytes: item.bytes });
    const readback = readPlainBytes(item.path, `${item.label} readback`, { maxBytes: MAX_JSON_BYTES });
    if (readback.sha256 !== item.sha256 || !readback.bytes.equals(item.bytes)) {
      fail("M64_FRESH_PUBLICATION_FAILED", `${item.label} failed exact create-only readback`);
    }
    return result.status;
  } catch (error) {
    if (error instanceof RecoverablePublicationError) {
      const code = error.reason === "TARGET_DIFFERENT"
        ? "M64_FRESH_REFUSE_DIFFERENT" : "M64_FRESH_PUBLICATION_FAILED";
      fail(code, `${item.label} create-only publication failed`, { reason: error.reason, cause: error.causeCode });
    }
    throw error;
  }
}

export function planM64FreshProductionAssemblerInput({
  releaseId,
  sourceCommit,
  runtimeRoot = M64_FORMAL_RUNTIME_ROOT,
  targetEnvironmentAttestationHash,
  environmentQualificationSha256,
  dependencyLayerHash,
  modelProfileHash,
  accountIsolationBindingHash,
  now = Date.now,
  dependencies = {},
} = {}) {
  const nowMs = Number(typeof now === "function" ? now() : now);
  if (!Number.isFinite(nowMs)) fail("M64_FRESH_CLOCK_INVALID", "builder clock must be finite");
  const deps = Object.freeze({ ...DEFAULT_DEPENDENCIES, ...dependencies });
  const release = verifyRelease(releaseId, sourceCommit, runtimeRoot, deps);
  const environment = verifyEnvironment({
    release,
    attestationHash: targetEnvironmentAttestationHash,
    qualificationSha256: environmentQualificationSha256,
    accountIsolationBindingHash,
    nowMs,
    dependencies: deps,
  });
  const qualified = verifyDependencyAndModel({
    release,
    dependencyLayerHash,
    modelProfileHash,
    environment,
    nowMs,
    dependencies: deps,
  });
  const actors = loadActors(release, deps);
  const cohorts = readCohortSources(release);
  const binding = authorityHash({ release, environment, qualified, actors });
  const bundleRoot = join(
    release.runtimeRoot, "m6-audit", "m6-c1-final-builds", binding.hash,
  );
  const assemblerRoot = join(
    release.runtimeRoot, "cutover-m6-assembler", release.releaseId, release.sourceCommit,
  );
  assertPlainAncestors(join(bundleRoot, "sentinel"), "fixed dependency bundle root", { allowMissing: true });
  assertPlainAncestors(join(assemblerRoot, "sentinel"), "fixed assembler root", { allowMissing: true });
  if (within(release.root, bundleRoot) || within(release.root, assemblerRoot)
    || within(bundleRoot, assemblerRoot) || within(assemblerRoot, bundleRoot)) {
    fail("M64_FRESH_OUTPUT_ROOT_INVALID", "dependency and assembler roots must be external, distinct, and non-nested");
  }
  const locks = sourceLockArtifacts({ release, bundleRoot });
  const dependencyArtifacts = buildDependencyArtifacts({
    release, environment, qualified, actors, cohorts, bundleRoot, nowMs,
  });
  const input = buildAssemblerInput({
    release, environment, qualified, cohorts, locks, dependencies: dependencyArtifacts,
    bundleRoot, assemblerRoot,
  });
  assertFixedRuntimeInputs(input, release, assemblerRoot);
  const artifacts = Object.freeze([
    dependencyArtifacts.runtimeActorRegistryArtifact,
    ...locks.artifacts,
    ...dependencyArtifacts.artifacts.filter(
      (item) => item !== dependencyArtifacts.runtimeActorRegistryArtifact,
    ),
  ]);
  if (new Set(artifacts.map((item) => normalizedPath(item.path))).size !== artifacts.length) {
    fail("M64_FRESH_OUTPUT_COLLISION", "planned dependency artifact paths are not unique");
  }
  const inputBytes = prettyBytes(input);
  assertSecretFree(inputBytes, "assembler input");
  const inputSha256 = sha256(inputBytes);
  const inputArtifact = artifact(
    join(bundleRoot, "assembler-inputs", `${inputSha256}.json`),
    inputBytes,
    "content-addressed assembler input",
  );
  return Object.freeze({
    schemaId: M64_FRESH_ASSEMBLER_INPUT_BUILD_SCHEMA_ID,
    mode: "PREFLIGHT",
    writesPerformed: false,
    release,
    environment,
    qualified,
    cohorts,
    authority: binding.authority,
    authorityHash: binding.hash,
    bundleRoot,
    assemblerRoot,
    artifacts,
    dependencyArtifacts,
    input,
    inputArtifact,
    inputSha256,
    expectationCount: dependencyArtifacts.expectationCount,
    freshnessExpiresAt: dependencyArtifacts.expiresAt,
    nowMs,
    assemblerDependencies: dependencies.assemblerDependencies ?? {},
  });
}

export function buildM64FreshProductionAssemblerInput(options = {}) {
  const execute = options.execute ?? false;
  if (typeof execute !== "boolean") fail("M64_FRESH_INPUT_INVALID", "execute must be boolean");
  const plan = planM64FreshProductionAssemblerInput(options);
  if (!execute) return plan;
  const protection = Object.freeze({ ...DEFAULT_DEPENDENCIES, ...(options.dependencies ?? {}) });
  const statuses = [];
  for (const item of plan.artifacts) {
    const status = publishArtifact(item, plan.release.runtimeRoot);
    if (item.requiresTcbProtection === true) {
      try {
        const receipt = status === "CREATED"
          ? protection.protectProtectedPath({
            runtimeRoot: plan.release.runtimeRoot, targetPath: item.path, recursive: false,
          })
          : protection.verifyProtectedPath({
            runtimeRoot: plan.release.runtimeRoot, targetPath: item.path, recursive: false,
          });
        if (receipt?.ok !== true) fail("M64_FRESH_TCB_ACL_INVALID", `${item.label} protection failed closed`);
      } catch (cause) {
        if (cause?.code === "M64_FRESH_TCB_ACL_INVALID") throw cause;
        fail("M64_FRESH_TCB_ACL_INVALID", `${item.label} protection failed closed`, {
          cause: cause?.code ?? cause?.message,
        });
      }
    }
    statuses.push(Object.freeze({ path: item.path, status }));
  }
  for (const path of [
    plan.dependencyArtifacts.observationRoot,
    join(plan.dependencyArtifacts.observationRoot, "requests"),
    join(plan.dependencyArtifacts.observationRoot, "observations"),
    join(plan.assemblerRoot, "config"),
    join(plan.assemblerRoot, "state", "control-plane"),
    join(plan.assemblerRoot, "receipts"),
  ]) ensurePlainDirectory(path, plan.release.runtimeRoot, "fixed builder output directory");
  const assemblerPreflight = planM64FinalProductionArtifacts({
    input: plan.input,
    now: () => plan.nowMs,
    dependencies: plan.assemblerDependencies,
  });
  const inputStatus = publishArtifact(plan.inputArtifact, plan.release.runtimeRoot);
  statuses.push(Object.freeze({ path: plan.inputArtifact.path, status: inputStatus }));
  const assemblerExecution = assembleM64FinalProductionArtifacts({
    input: plan.input,
    execute: true,
    now: () => plan.nowMs,
    dependencies: plan.assemblerDependencies,
  });
  const assemblerReceiptHash = assemblerExecution.receipt?.receiptHash;
  const { receiptHash: ignoredReceiptHash, ...assemblerReceiptBody } = assemblerExecution.receipt ?? {};
  if (assemblerExecution.mode !== "EXECUTE" || !Array.isArray(assemblerExecution.outcomes)
    || ignoredReceiptHash !== assemblerReceiptHash
    || assemblerReceiptBody.schemaId !== M64_FINAL_ASSEMBLER_RECEIPT_SCHEMA_ID
    || !HASH.test(assemblerReceiptHash ?? "")
    || sha256(`${M64_FINAL_ASSEMBLER_RECEIPT_SCHEMA_ID}:${canonicalJson(assemblerReceiptBody)}`)
      !== assemblerReceiptHash) {
    fail("M64_FRESH_ASSEMBLER_RECEIPT_INVALID", "final assembler did not return one content-addressed receipt hash");
  }
  const expectedReceiptPath = join(plan.assemblerRoot, "receipts", `${assemblerReceiptHash}.json`);
  if (!samePath(assemblerPreflight.receiptPath, expectedReceiptPath)
    || !samePath(assemblerExecution.receiptPath, expectedReceiptPath)
    || assemblerExecution.receipt?.release?.releaseId !== plan.release.releaseId
    || assemblerExecution.receipt?.release?.sourceCommit !== plan.release.sourceCommit) {
    fail("M64_FRESH_ASSEMBLER_RECEIPT_INVALID", "final assembler receipt escaped or rebound the fixed release/source root");
  }
  const receiptReadback = readPlainBytes(
    expectedReceiptPath, "final assembler content-addressed receipt", { maxBytes: MAX_JSON_BYTES },
  );
  const expectedReceiptBytes = prettyBytes(assemblerExecution.receipt);
  if (!receiptReadback.bytes.equals(expectedReceiptBytes)) {
    fail("M64_FRESH_ASSEMBLER_RECEIPT_INVALID", "final assembler receipt readback differs from the returned receipt");
  }
  return Object.freeze({
    schemaId: M64_FRESH_ASSEMBLER_INPUT_BUILD_SCHEMA_ID,
    mode: "EXECUTE",
    writesPerformed: statuses.some((item) => item.status === "CREATED")
      || assemblerExecution.writesPerformed,
    exactReplay: statuses.every((item) => item.status === "REPLAYED")
      && assemblerExecution.exactReplay,
    releaseId: plan.release.releaseId,
    sourceCommit: plan.release.sourceCommit,
    authorityHash: plan.authorityHash,
    bundleRoot: plan.bundleRoot,
    assemblerRoot: plan.assemblerRoot,
    assemblerInputPath: plan.inputArtifact.path,
    assemblerInputSha256: plan.inputSha256,
    assemblerReceiptPath: expectedReceiptPath,
    assemblerReceiptHash,
    assemblerReceiptSha256: receiptReadback.sha256,
    expectationCount: plan.expectationCount,
    freshnessExpiresAt: plan.freshnessExpiresAt,
    artifactsPublished: statuses.length,
    assemblerArtifactsPublished: assemblerExecution.outcomes.length,
    privateKeyMaterialRead: true,
    privateKeyMaterialPublished: false,
    secretMaterialPublished: false,
    expectationSignaturesGenerated: true,
  });
}

export function parseM64FreshAssemblerInputBuilderArgs(argv) {
  if (argv.length === 1 && argv[0] === "--help") return Object.freeze({ help: true });
  if (argv.length !== 8 || !["preflight-fixed", "execute-fixed"].includes(argv[0])) {
    fail(
      "M64_FRESH_CLI_INVALID",
      "builder requires one fixed operation plus release/source and five opaque content bindings; paths, JSON, endpoints, and options are forbidden",
    );
  }
  const result = {
    operation: argv[0].slice(0, -"-fixed".length),
    execute: argv[0] === "execute-fixed",
    releaseId: argv[1],
    sourceCommit: argv[2],
    targetEnvironmentAttestationHash: argv[3],
    environmentQualificationSha256: argv[4],
    dependencyLayerHash: argv[5],
    modelProfileHash: argv[6],
    accountIsolationBindingHash: argv[7],
  };
  if (!RELEASE_ID.test(result.releaseId ?? "") || !COMMIT.test(result.sourceCommit ?? "")) {
    fail("M64_FRESH_CLI_INVALID", "releaseId/sourceCommit must be one exact formal-release identity");
  }
  for (const key of [
    "targetEnvironmentAttestationHash", "environmentQualificationSha256", "dependencyLayerHash",
    "modelProfileHash", "accountIsolationBindingHash",
  ]) {
    if (!HASH.test(result[key] ?? "")) fail("M64_FRESH_CLI_INVALID", `${key} must be a nonzero SHA-256`);
  }
  return Object.freeze(result);
}

function publicResult(output) {
  if (output.mode === "EXECUTE") return output;
  return Object.freeze({
    schemaId: output.schemaId,
    mode: output.mode,
    writesPerformed: output.writesPerformed,
    releaseId: output.release.releaseId,
    sourceCommit: output.release.sourceCommit,
    authorityHash: output.authorityHash,
    bundleRoot: output.bundleRoot,
    assemblerRoot: output.assemblerRoot,
    assemblerInputPath: output.inputArtifact.path,
    assemblerInputSha256: output.inputSha256,
    expectationCount: output.expectationCount,
    freshnessExpiresAt: output.freshnessExpiresAt,
    privateKeyMaterialRead: true,
    privateKeyMaterialPublished: false,
    secretMaterialPublished: false,
  });
}

export function main(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const parsed = parseM64FreshAssemblerInputBuilderArgs(argv);
  if (parsed.help) {
    stdout.write([
      "M6-4 fresh production assembler-input builder",
      "",
      "Fixed preflight (validates fresh bindings; writes nothing):",
      "  node tools/m6/m6-4-production-assembler-input-builder.mjs preflight-fixed RELEASE_ID SOURCE_COMMIT TARGET_ENV_SHA256 ENV_QUAL_SHA256 DEPENDENCY_SHA256 MODEL_SHA256 ACCOUNT_SHA256",
      "",
      "Fixed create-only publication:",
      "  node tools/m6/m6-4-production-assembler-input-builder.mjs execute-fixed RELEASE_ID SOURCE_COMMIT TARGET_ENV_SHA256 ENV_QUAL_SHA256 DEPENDENCY_SHA256 MODEL_SHA256 ACCOUNT_SHA256",
      "",
      `Runtime is fixed to ${M64_FORMAL_RUNTIME_ROOT}. No caller-supplied JSON, root, or artifact path is accepted.`,
    ].join("\n") + "\n");
    return null;
  }
  const output = buildM64FreshProductionAssemblerInput({
    ...parsed,
    runtimeRoot: M64_FORMAL_RUNTIME_ROOT,
  });
  stdout.write(`${JSON.stringify(publicResult(output), null, 2)}\n`);
  return output;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : null;
if (entry === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`${error?.code ?? "M64_FRESH_INPUT_BUILD_FAILED"}: ${error?.message ?? "fresh assembler input build failed"}\n`);
    process.exitCode = 1;
  }
}
