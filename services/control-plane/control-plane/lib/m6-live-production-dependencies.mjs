import {
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
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
} from "node:path";

import {
  M64_LIVE_CRITICAL_ZERO_COUNTER_FIELDS,
  validateM64ExpectedStateArtifact,
  validateM64IndependentEffectObservation,
} from "../../../../packages/kernel/lib/m6-live-evidence.mjs";
import { validateM64EffectBoundary } from "../../../../packages/kernel/lib/m6-effect-boundary.mjs";
import { deriveTargetEnvironmentAttestation } from "../../../../packages/kernel/lib/m6-live-grounding.mjs";
import { canonicalJson, sha256 } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";
import { validateJsonSchema } from "./json-schema-validator.mjs";

export const M64_PRODUCTION_DEPENDENCY_BINDING_SCHEMA_ID = "xw.m6-4-production-dependency-binding.v1";
export const M64_INDEPENDENT_ORACLE_POLICY_SCHEMA_ID = "xw.m6-4-independent-oracle-policy.v1";
export const M64_EXPECTATION_INDEX_SCHEMA_ID = "xw.m6-4-expectation-index.v1";
export const M64_EXPECTATION_ENVELOPE_SCHEMA_ID = "xw.m6-4-independent-expectation-envelope.v1";
export const M64_OBSERVATION_ENVELOPE_SCHEMA_ID = "xw.m6-4-independent-observation-envelope.v1";
export const M64_OBSERVATION_LOCATOR_SCHEMA_ID = "xw.m6-4-independent-observation-locator.v1";
export const M64_TARGET_SELECTOR_POLICY_SCHEMA_ID = "xw.m6-4-target-selector-policy.v1";
export const M64_CURRENT_STATE_GUARD_POLICY_SCHEMA_ID = "xw.m6-4-current-state-guard-policy.v1";
export const M64_FRESH_STATE_CAPTURE_SCHEMA_ID = "xw.m6-4-server-current-state-capture.v1";

export const M64_PRODUCTION_DEPENDENCY_RUNTIME_FIELDS = Object.freeze([
  "productionDependencyBindingPath",
  "productionDependencyBindingHash",
]);

export const M64_FORBIDDEN_ORACLE_SOURCE_KINDS = Object.freeze([
  "BROKER_ACK",
  "CONTROL_PLANE_LEDGER",
  "DSH_RESULT",
  "GROUNDED_ACTION_RECEIPT",
  "MODEL_OUTPUT",
  "SUT_RECEIPT",
  "TRANSPORT_RESULT",
]);

const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const KEY_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const ARTIFACT_REF_KEYS = Object.freeze(["path", "sha256"]);
const DEPENDENCY_BINDING_KEYS = Object.freeze([
  "bindingHash",
  "currentStateGuardPolicy",
  "effectBoundary",
  "environmentAttestation",
  "environmentQualification",
  "independentOraclePolicy",
  "releaseId",
  "schemaId",
  "sourceCommit",
  "targetSelectorPolicy",
]);
const ORACLE_POLICY_KEYS = Object.freeze([
  "allowedSourceKinds",
  "effectBoundaryHash",
  "expectationAuthorKeyId",
  "expectationAuthorPublicKey",
  "expectationIndex",
  "forbiddenSourceKinds",
  "independentAuthorHash",
  "independentObserverHash",
  "maxObservationAgeMs",
  "observationObserverKeyId",
  "observationObserverPublicKey",
  "observationRoot",
  "policyHash",
  "requiredSourceKinds",
  "schemaId",
]);
const INDEX_KEYS = Object.freeze(["entries", "indexHash", "schemaId"]);
const INDEX_ENTRY_KEYS = Object.freeze(["expectationEnvelope", "lookupHash"]);
const EXPECTATION_ENVELOPE_KEYS = Object.freeze([
  "authorKeyId",
  "expectation",
  "schemaId",
  "signature",
  "signatureAlgorithm",
]);
const OBSERVATION_ENVELOPE_KEYS = Object.freeze([
  "observation",
  "observerKeyId",
  "requestHash",
  "schemaId",
  "signature",
  "signatureAlgorithm",
  "sourceEvidence",
]);
const SOURCE_EVIDENCE_KEYS = Object.freeze(["kind", "sha256"]);
const LOCATOR_KEYS = Object.freeze(["envelopeSha256", "locatorHash", "requestHash", "schemaId"]);
const SELECTOR_POLICY_KEYS = Object.freeze(["effectBoundaryHash", "policyHash", "rules", "schemaId"]);
const SELECTOR_RULE_KEYS = Object.freeze([
  "requiredFeatures",
  "scenarioKey",
  "slotAuthorityHash",
  "targetEligibilityHash",
]);
const SELECTOR_FEATURE_KEYS = new Set([
  "classHash",
  "descriptionHash",
  "packageHash",
  "resourceHash",
  "structureHash",
  "textHash",
]);
const GUARD_POLICY_KEYS = Object.freeze([
  "allowedSourceClass",
  "allowedSourceKind",
  "maxCaptureAgeMs",
  "policyHash",
  "requiredStateFields",
  "schemaId",
]);
const STATE_FIELDS = Object.freeze([
  "appPackageHash",
  "blockId",
  "displayHash",
  "environmentAttestationHash",
  "focusHash",
  "frameId",
  "pageFingerprint",
  "rotation",
  "slotSpecHash",
  "uiStateGeneration",
]);
const DISPATCH_COMPARABLE_STATE_FIELDS = Object.freeze([
  "uiStateGeneration",
  "appPackageHash",
  "focusHash",
  "pageFingerprint",
  "rotation",
  "displayHash",
  "environmentAttestationHash",
]);
const FRESH_CAPTURE_KEYS = Object.freeze([
  "captureHash",
  "capturedAt",
  "requestFrameRef",
  "runRef",
  "schemaId",
  "sourceClass",
  "sourceKind",
  "state",
]);
const MATCH_KEYS = Object.freeze([
  "schemaId",
  "matched",
  "selfDerived",
  "expectedStateHash",
  "beforeObservationHash",
  "afterObservationHash",
  "slotAuthorityHash",
  "independentAuthorHash",
  "matchHash",
]);
const SECRET_KEY = /^(?:api[_-]?key|access[_-]?token|bearer[_-]?token|password|private[_-]?key|secret|credential(?:value)?)$/iu;
const SECRET_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{8,})/u;
const DEPENDENCY_BINDING_SCHEMA_URL = new URL(
  "../../../../packages/kernel/contracts/orchestration/m6/xw.m6-4-production-dependency-binding.v1.schema.json",
  import.meta.url,
);

function fail(code, message, { status = 503, details = {}, cause } = {}) {
  throw new ControlPlaneError(code, message, { status, details, cause });
}

function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()));
}

function nonemptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function hashObject(schemaId, value, hashKey) {
  const raw = Object.fromEntries(Object.entries(value || {}).filter(([key]) => key !== hashKey));
  return sha256(`${schemaId}:${canonicalJson(raw)}`);
}

function cloneFrozen(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneFrozen));
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneFrozen(item)])));
  }
  return value;
}

function normalizedPath(path) {
  const full = resolve(path);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

function within(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function fileIdentity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.nlink]
    .map((value) => String(value)).join(":");
}

function assertPlainAncestors(path, label) {
  const full = resolve(path);
  const volumeRoot = parse(full).root;
  let cursor = dirname(full);
  while (cursor && normalizedPath(cursor) !== normalizedPath(volumeRoot)) {
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (cause) {
      fail("M6_LIVE_DEPENDENCY_PATH_UNAVAILABLE", `${label} parent directory is unavailable`, { cause });
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail("M6_LIVE_DEPENDENCY_PATH_NOT_PLAIN", `${label} must not traverse a symlink or non-directory parent`);
    }
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
}

function assertPlainDirectory(path, label, { outsideReleaseRoot = null } = {}) {
  if (!nonemptyString(path) || !isAbsolute(path)) {
    fail("M6_LIVE_DEPENDENCY_PATH_INVALID", `${label} must be an absolute directory`);
  }
  assertPlainAncestors(join(resolve(path), "sentinel"), label);
  let stat;
  try {
    stat = lstatSync(resolve(path));
  } catch (cause) {
    fail("M6_LIVE_DEPENDENCY_PATH_UNAVAILABLE", `${label} is unavailable`, { cause });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("M6_LIVE_DEPENDENCY_PATH_NOT_PLAIN", `${label} must be one plain directory`);
  }
  const real = realpathSync.native(resolve(path));
  if (outsideReleaseRoot && within(outsideReleaseRoot, real)) {
    fail("M6_LIVE_DEPENDENCY_NOT_EXTERNAL", `${label} must be external to the source release`);
  }
  return real;
}

function safeReadBytes(path, expectedSha256, label, { outsideReleaseRoot = null } = {}) {
  if (!nonemptyString(path) || !isAbsolute(path)) {
    fail("M6_LIVE_DEPENDENCY_PATH_INVALID", `${label} must be an absolute file`);
  }
  const target = resolve(path);
  assertPlainAncestors(target, label);
  let before;
  try {
    before = lstatSync(target, { bigint: true });
  } catch (cause) {
    fail("M6_LIVE_DEPENDENCY_ARTIFACT_UNAVAILABLE", `${label} is unavailable`, { cause });
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.size < 2n || before.size > BigInt(MAX_ARTIFACT_BYTES)) {
    fail("M6_LIVE_DEPENDENCY_ARTIFACT_NOT_PLAIN", `${label} must be one bounded single-link plain file`);
  }
  const real = realpathSync.native(target);
  if (outsideReleaseRoot && within(outsideReleaseRoot, real)) {
    fail("M6_LIVE_DEPENDENCY_NOT_EXTERNAL", `${label} must be external to the source release`);
  }
  let descriptor;
  try {
    descriptor = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor, { bigint: true });
    const pathAfterOpen = lstatSync(target, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || pathAfterOpen.isSymbolicLink()
      || fileIdentity(before) !== fileIdentity(opened)
      || fileIdentity(opened) !== fileIdentity(pathAfterOpen)) {
      fail("M6_LIVE_DEPENDENCY_ARTIFACT_RACE", `${label} changed while it was opened`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfterRead = lstatSync(target, { bigint: true });
    if (fileIdentity(after) !== fileIdentity(opened)
      || fileIdentity(pathAfterRead) !== fileIdentity(opened)
      || after.size !== BigInt(bytes.length) || pathAfterRead.size !== BigInt(bytes.length)) {
      fail("M6_LIVE_DEPENDENCY_ARTIFACT_RACE", `${label} changed while it was read`);
    }
    const actualHash = sha256(bytes);
    if (expectedSha256 !== null && (!HASH.test(expectedSha256 || "") || actualHash !== expectedSha256)) {
      fail("M6_LIVE_DEPENDENCY_ARTIFACT_HASH_MISMATCH", `${label} does not match its content address`);
    }
    return Object.freeze({ bytes, sha256: actualHash, path: real });
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    fail("M6_LIVE_DEPENDENCY_ARTIFACT_UNAVAILABLE", `${label} cannot be read`, { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertSecretFree(value, raw, label) {
  if (SECRET_VALUE.test(raw)) {
    fail("M6_LIVE_DEPENDENCY_SECRET_MATERIAL", `${label} contains secret-shaped material`);
  }
  const visit = (item) => {
    if (Array.isArray(item)) return item.forEach(visit);
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (SECRET_KEY.test(key)) {
        fail("M6_LIVE_DEPENDENCY_SECRET_MATERIAL", `${label} contains a forbidden secret field`);
      }
      visit(child);
    }
  };
  visit(value);
}

function readJsonArtifact(ref, label, { outsideReleaseRoot = null } = {}) {
  if (!exactObject(ref, ARTIFACT_REF_KEYS) || !isAbsolute(ref?.path || "") || !HASH.test(ref?.sha256 || "")) {
    fail("M6_LIVE_DEPENDENCY_ARTIFACT_REF_INVALID", `${label} must carry one absolute path and SHA-256`);
  }
  const file = safeReadBytes(ref.path, ref.sha256, label, { outsideReleaseRoot });
  let value;
  try {
    value = JSON.parse(file.bytes.toString("utf8"));
  } catch (cause) {
    fail("M6_LIVE_DEPENDENCY_ARTIFACT_JSON_INVALID", `${label} is not valid JSON`, { cause });
  }
  assertSecretFree(value, file.bytes.toString("utf8"), label);
  return Object.freeze({ ...file, value });
}

function parsePublicEd25519(value, label) {
  if (!nonemptyString(value) || /PRIVATE KEY/u.test(value)) {
    fail("M6_LIVE_DEPENDENCY_PUBLIC_KEY_INVALID", `${label} must be a public Ed25519 key`);
  }
  let key;
  try {
    key = createPublicKey(value);
  } catch (cause) {
    fail("M6_LIVE_DEPENDENCY_PUBLIC_KEY_INVALID", `${label} cannot be parsed`, { cause });
  }
  if (key.asymmetricKeyType !== "ed25519") {
    fail("M6_LIVE_DEPENDENCY_PUBLIC_KEY_INVALID", `${label} must be Ed25519`);
  }
  return key;
}

function canonicalSignature(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === 64 && bytes.toString("base64") === value ? bytes : null;
}

function assertSignature({ publicKey, signature, bytes, code, label }) {
  const signatureBytes = canonicalSignature(signature);
  let valid = false;
  if (signatureBytes) {
    try { valid = verifySignature(null, bytes, publicKey, signatureBytes); } catch {}
  }
  if (!valid) fail(code, `${label} Ed25519 signature is invalid`, { status: 409 });
}

export function deriveM64IndependentActorHash(publicKey) {
  const key = typeof publicKey === "string" ? parsePublicEd25519(publicKey, "independent actor key") : publicKey;
  const der = key.export({ type: "spki", format: "der" });
  return sha256(Buffer.concat([Buffer.from("xw.m6-4-independent-actor.v1:", "utf8"), der]));
}

export function deriveM64ProductionDependencyBindingHash(value) {
  return hashObject(M64_PRODUCTION_DEPENDENCY_BINDING_SCHEMA_ID, value, "bindingHash");
}

export function loadM64ProductionDependencyBindingSchema() {
  return JSON.parse(readFileSync(DEPENDENCY_BINDING_SCHEMA_URL, "utf8"));
}

export function deriveM64IndependentOraclePolicyHash(value) {
  return hashObject(M64_INDEPENDENT_ORACLE_POLICY_SCHEMA_ID, value, "policyHash");
}

export function deriveM64ExpectationIndexHash(value) {
  return hashObject(M64_EXPECTATION_INDEX_SCHEMA_ID, value, "indexHash");
}

export function deriveM64TargetSelectorPolicyHash(value) {
  return hashObject(M64_TARGET_SELECTOR_POLICY_SCHEMA_ID, value, "policyHash");
}

export function deriveM64CurrentStateGuardPolicyHash(value) {
  return hashObject(M64_CURRENT_STATE_GUARD_POLICY_SCHEMA_ID, value, "policyHash");
}

export function deriveM64ObservationLocatorHash(value) {
  return hashObject(M64_OBSERVATION_LOCATOR_SCHEMA_ID, value, "locatorHash");
}

export function deriveM64FreshStateCaptureHash(value) {
  return hashObject(M64_FRESH_STATE_CAPTURE_SCHEMA_ID, value, "captureHash");
}

function oracleAuthority(value) {
  return Object.freeze({
    purpose: value?.purpose,
    manifestHash: value?.manifestHash,
    scenarioKey: value?.scenarioKey,
    primaryFamily: value?.primaryFamily,
    oracleHash: value?.oracleHash,
    effectBoundaryHash: value?.effectBoundaryHash,
    environmentAttestationHash: value?.environmentAttestationHash,
    accountIsolationHash: value?.accountIsolationHash,
  });
}

function observationBindings(value) {
  return Object.freeze({
    scenarioKey: value?.scenarioKey,
    primaryFamily: value?.primaryFamily,
    oracleHash: value?.oracleHash,
    effectBoundaryHash: value?.effectBoundaryHash,
    environmentAttestationHash: value?.environmentAttestationHash,
    accountIsolationHash: value?.accountIsolationHash,
  });
}

export function deriveM64ExpectationLookupHash(value) {
  return sha256(`xw.m6-4-expectation-lookup.v1:${canonicalJson(oracleAuthority(value))}`);
}

export function deriveM64ObservationRequestHash(value) {
  return sha256(`xw.m6-4-observation-request.v1:${canonicalJson({
    ...oracleAuthority(value),
    expectedArtifactHash: value?.expectedArtifactHash,
    independentAuthorHash: value?.independentAuthorHash,
    phase: value?.phase,
  })}`);
}

export function deriveM64SourceEvidenceHash(value) {
  return sha256(`xw.m6-4-independent-source-evidence.v1:${canonicalJson(value)}`);
}

export function canonicalM64ExpectationEnvelopeSigningBytes(envelope) {
  const { signature: _ignored, ...body } = envelope || {};
  return Buffer.from(`${M64_EXPECTATION_ENVELOPE_SCHEMA_ID}:${canonicalJson(body)}`, "utf8");
}

export function canonicalM64ObservationEnvelopeSigningBytes(envelope) {
  const { signature: _ignored, ...body } = envelope || {};
  return Buffer.from(`${M64_OBSERVATION_ENVELOPE_SCHEMA_ID}:${canonicalJson(body)}`, "utf8");
}

function validateEnvironment(attestation, qualification, runtimeBinding, nowMs) {
  let rebound;
  try {
    const { attestationHash: _ignored, ...raw } = attestation || {};
    rebound = deriveTargetEnvironmentAttestation(raw);
  } catch {
    fail("M6_LIVE_DEPENDENCY_ENVIRONMENT_INVALID", "target environment attestation is invalid");
  }
  if (attestation?.attestationHash !== rebound.attestationHash
    || runtimeBinding.targetEnvironmentAttestationHash !== rebound.attestationHash
    || qualification?.schemaId !== "xw.m6-environment-qualification.v1"
    || qualification.status !== "QUALIFIED" || qualification.gateFEligible !== true
    || qualification.alias !== "01" || qualification.effectBoundary !== "READ_ONLY"
    || qualification.actionCount !== 0 || qualification.secretMaterialPresent !== false
    || qualification.rawDeviceIdentityPresent !== false || qualification.sampleCount !== 2
    || !Array.isArray(qualification.qualifiedAttestationHashes)
    || canonicalJson(qualification.qualifiedAttestationHashes) !== canonicalJson([rebound.attestationHash])
    || Date.parse(rebound.expiresAt) <= nowMs || Date.parse(qualification.expiresAt) <= nowMs) {
    fail("M6_LIVE_DEPENDENCY_ENVIRONMENT_INVALID", "target environment artifacts are stale, rebound, or unqualified");
  }
  return Object.freeze({ environmentAttestation: rebound, environmentQualification: cloneFrozen(qualification) });
}

function validateOraclePolicy(value, effectBoundaryHash, outsideReleaseRoot) {
  if (!exactObject(value, ORACLE_POLICY_KEYS)
    || value.schemaId !== M64_INDEPENDENT_ORACLE_POLICY_SCHEMA_ID
    || value.policyHash !== deriveM64IndependentOraclePolicyHash(value)
    || value.effectBoundaryHash !== effectBoundaryHash
    || !KEY_ID.test(value.expectationAuthorKeyId || "")
    || !KEY_ID.test(value.observationObserverKeyId || "")
    || !Number.isSafeInteger(value.maxObservationAgeMs)
    || value.maxObservationAgeMs < 1 || value.maxObservationAgeMs > 60_000
    || !Array.isArray(value.allowedSourceKinds) || value.allowedSourceKinds.length === 0
    || !Array.isArray(value.requiredSourceKinds) || value.requiredSourceKinds.length === 0
    || !Array.isArray(value.forbiddenSourceKinds)) {
    fail("M6_LIVE_ORACLE_POLICY_INVALID", "independent oracle policy is malformed or rebound");
  }
  for (const list of [value.allowedSourceKinds, value.requiredSourceKinds, value.forbiddenSourceKinds]) {
    if (new Set(list).size !== list.length || list.some((item) => !/^[A-Z][A-Z0-9_]{2,96}$/u.test(item || ""))) {
      fail("M6_LIVE_ORACLE_POLICY_INVALID", "independent oracle source classes are invalid");
    }
  }
  if (value.requiredSourceKinds.some((kind) => !value.allowedSourceKinds.includes(kind))
    || value.allowedSourceKinds.some((kind) => value.forbiddenSourceKinds.includes(kind))
    || M64_FORBIDDEN_ORACLE_SOURCE_KINDS.some((kind) => !value.forbiddenSourceKinds.includes(kind))) {
    fail("M6_LIVE_ORACLE_POLICY_CIRCULAR", "independent oracle policy allows a SUT-derived truth source");
  }
  const authorKey = parsePublicEd25519(value.expectationAuthorPublicKey, "expectation author key");
  const observerKey = parsePublicEd25519(value.observationObserverPublicKey, "observation observer key");
  const authorHash = deriveM64IndependentActorHash(authorKey);
  const observerHash = deriveM64IndependentActorHash(observerKey);
  if (value.independentAuthorHash !== authorHash || value.independentObserverHash !== observerHash
    || authorHash === observerHash) {
    fail("M6_LIVE_ORACLE_POLICY_NOT_INDEPENDENT", "expectation author and observation observer identities are not independently bound");
  }
  const observationRoot = assertPlainDirectory(value.observationRoot, "independent observer root", { outsideReleaseRoot });
  const requestsRoot = assertPlainDirectory(join(observationRoot, "requests"), "independent observer request root", { outsideReleaseRoot });
  const observationsRoot = assertPlainDirectory(join(observationRoot, "observations"), "independent observer artifact root", { outsideReleaseRoot });
  return Object.freeze({
    policy: cloneFrozen(value),
    authorKey,
    observerKey,
    observationRoot,
    requestsRoot,
    observationsRoot,
  });
}

function validateExpectationIndex(value) {
  if (!exactObject(value, INDEX_KEYS) || value.schemaId !== M64_EXPECTATION_INDEX_SCHEMA_ID
    || value.indexHash !== deriveM64ExpectationIndexHash(value)
    || !Array.isArray(value.entries) || value.entries.length === 0) {
    fail("M6_LIVE_EXPECTATION_INDEX_INVALID", "expectation index is missing, malformed, or rebound");
  }
  const seen = new Set();
  for (const entry of value.entries) {
    if (!exactObject(entry, INDEX_ENTRY_KEYS) || !HASH.test(entry.lookupHash || "")
      || !exactObject(entry.expectationEnvelope, ARTIFACT_REF_KEYS) || seen.has(entry.lookupHash)) {
      fail("M6_LIVE_EXPECTATION_INDEX_INVALID", "expectation index contains a malformed or duplicate entry");
    }
    seen.add(entry.lookupHash);
  }
  return cloneFrozen(value);
}

function validateSelectorPolicy(value, effectBoundaryHash) {
  if (!exactObject(value, SELECTOR_POLICY_KEYS) || value.schemaId !== M64_TARGET_SELECTOR_POLICY_SCHEMA_ID
    || value.policyHash !== deriveM64TargetSelectorPolicyHash(value)
    || value.effectBoundaryHash !== effectBoundaryHash || !Array.isArray(value.rules) || value.rules.length === 0) {
    fail("M6_LIVE_TARGET_SELECTOR_POLICY_INVALID", "target-selector policy is malformed or rebound");
  }
  const seen = new Set();
  for (const rule of value.rules) {
    if (!exactObject(rule, SELECTOR_RULE_KEYS) || !nonemptyString(rule.scenarioKey)
      || !HASH.test(rule.slotAuthorityHash || "") || !HASH.test(rule.targetEligibilityHash || "")
      || !rule.requiredFeatures || typeof rule.requiredFeatures !== "object" || Array.isArray(rule.requiredFeatures)) {
      fail("M6_LIVE_TARGET_SELECTOR_POLICY_INVALID", "target-selector rule is invalid");
    }
    const featureKeys = Object.keys(rule.requiredFeatures);
    if (featureKeys.length === 0 || featureKeys.some((key) => !SELECTOR_FEATURE_KEYS.has(key))
      || Object.values(rule.requiredFeatures).some((item) => item !== null && !HASH.test(item || ""))) {
      fail("M6_LIVE_TARGET_SELECTOR_POLICY_INVALID", "target-selector rules must use public semantic hashes only");
    }
    const key = `${rule.scenarioKey}:${rule.slotAuthorityHash}`;
    if (seen.has(key)) fail("M6_LIVE_TARGET_SELECTOR_POLICY_INVALID", "target-selector rule is duplicated");
    seen.add(key);
  }
  return cloneFrozen(value);
}

function validateGuardPolicy(value) {
  if (!exactObject(value, GUARD_POLICY_KEYS) || value.schemaId !== M64_CURRENT_STATE_GUARD_POLICY_SCHEMA_ID
    || value.policyHash !== deriveM64CurrentStateGuardPolicyHash(value)
    || value.allowedSourceClass !== "SERVER_OWNED_FRESH_CAPTURE"
    || value.allowedSourceKind !== "CONTROL_PLANE_FRAME_GUARD"
    || !Number.isSafeInteger(value.maxCaptureAgeMs) || value.maxCaptureAgeMs < 1 || value.maxCaptureAgeMs > 1_000
    || canonicalJson(value.requiredStateFields) !== canonicalJson(STATE_FIELDS)) {
    fail("M6_LIVE_CURRENT_STATE_POLICY_INVALID", "current-state guard policy is malformed or unsafe");
  }
  return cloneFrozen(value);
}

function assertRuntimeBinding(runtimeBinding) {
  if (!runtimeBinding || typeof runtimeBinding !== "object" || Array.isArray(runtimeBinding)
    || runtimeBinding.schemaId !== "xw.runtime.m6-c1-runtime.v1"
    || !nonemptyString(runtimeBinding.releaseId) || !COMMIT.test(runtimeBinding.sourceCommit || "")
    || !nonemptyString(runtimeBinding.sourceReleaseRoot) || !isAbsolute(runtimeBinding.sourceReleaseRoot)
    || !isAbsolute(runtimeBinding.productionDependencyBindingPath || "")
    || !HASH.test(runtimeBinding.productionDependencyBindingHash || "")
    || !isAbsolute(runtimeBinding.targetEnvironmentAttestationPath || "")
    || !HASH.test(runtimeBinding.targetEnvironmentAttestationHash || "")
    || !isAbsolute(runtimeBinding.environmentQualificationPath || "")
    || !HASH.test(runtimeBinding.environmentQualificationSha256 || "")) {
    fail("M6_LIVE_PRODUCTION_RUNTIME_BINDING_INVALID", "final runtime binding does not bind the production dependency manifest");
  }
}

function assertDependencyBinding(value, runtimeBinding) {
  const schemaErrors = validateJsonSchema(value, loadM64ProductionDependencyBindingSchema());
  if (schemaErrors.length > 0
    || !exactObject(value, DEPENDENCY_BINDING_KEYS)
    || value.schemaId !== M64_PRODUCTION_DEPENDENCY_BINDING_SCHEMA_ID
    || value.bindingHash !== deriveM64ProductionDependencyBindingHash(value)
    || value.releaseId !== runtimeBinding.releaseId || value.sourceCommit !== runtimeBinding.sourceCommit) {
    fail("M6_LIVE_PRODUCTION_DEPENDENCY_BINDING_INVALID", "production dependency manifest is malformed or cross-release rebound", {
      details: { schemaErrors },
    });
  }
  for (const key of [
    "environmentAttestation",
    "environmentQualification",
    "effectBoundary",
    "independentOraclePolicy",
    "targetSelectorPolicy",
    "currentStateGuardPolicy",
  ]) {
    if (!exactObject(value[key], ARTIFACT_REF_KEYS)) {
      fail("M6_LIVE_PRODUCTION_DEPENDENCY_BINDING_INVALID", `production dependency ${key} is not content addressed`);
    }
  }
}

function validateExpectationEnvelope(envelope, { authority, policy, authorKey, nowMs }) {
  if (!exactObject(envelope, EXPECTATION_ENVELOPE_KEYS)
    || envelope.schemaId !== M64_EXPECTATION_ENVELOPE_SCHEMA_ID
    || envelope.authorKeyId !== policy.expectationAuthorKeyId
    || envelope.signatureAlgorithm !== "Ed25519") {
    fail("M6_LIVE_EXPECTATION_ENVELOPE_INVALID", "expectation envelope is malformed or uses the wrong author", { status: 409 });
  }
  assertSignature({
    publicKey: authorKey,
    signature: envelope.signature,
    bytes: canonicalM64ExpectationEnvelopeSigningBytes(envelope),
    code: "M6_LIVE_EXPECTATION_SIGNATURE_INVALID",
    label: "expectation envelope",
  });
  const validation = validateM64ExpectedStateArtifact(envelope.expectation, {
    bindings: oracleAuthority(authority),
    authoredNoLaterThan: authority.liveAuthorizationIssuedAt,
    expiresNoEarlierThan: authority.liveAuthorizationExpiresAt,
    nowMs,
  });
  if (!validation.ok || envelope.expectation.independentAuthorHash !== policy.independentAuthorHash) {
    fail("M6_LIVE_EXPECTATION_ARTIFACT_INVALID", "pre-window expectation is stale, self-derived, or rebound", {
      status: 409,
      details: { errors: validation.errors },
    });
  }
  return cloneFrozen(envelope.expectation);
}

function validateSourceEvidence(sourceEvidence, policy, circularHashes) {
  if (!Array.isArray(sourceEvidence) || sourceEvidence.length === 0
    || sourceEvidence.some((entry) => !exactObject(entry, SOURCE_EVIDENCE_KEYS)
      || !policy.allowedSourceKinds.includes(entry.kind) || policy.forbiddenSourceKinds.includes(entry.kind)
      || !HASH.test(entry.sha256 || ""))
    || policy.requiredSourceKinds.some((kind) => !sourceEvidence.some((entry) => entry.kind === kind))
    || new Set(sourceEvidence.map((entry) => `${entry.kind}:${entry.sha256}`)).size !== sourceEvidence.length
    || new Set(sourceEvidence.map((entry) => entry.sha256)).size !== sourceEvidence.length
    || sourceEvidence.some((entry) => circularHashes.has(entry.sha256))) {
    fail("M6_LIVE_ORACLE_SOURCE_NOT_INDEPENDENT", "observation source evidence is missing, circular, or SUT-derived", { status: 409 });
  }
}

function validateObservationEnvelope(envelope, {
  authority,
  expectation,
  requestHash,
  policy,
  observerKey,
  effectBoundary,
  nowMs,
}) {
  if (!exactObject(envelope, OBSERVATION_ENVELOPE_KEYS)
    || envelope.schemaId !== M64_OBSERVATION_ENVELOPE_SCHEMA_ID
    || envelope.observerKeyId !== policy.observationObserverKeyId
    || envelope.signatureAlgorithm !== "Ed25519" || envelope.requestHash !== requestHash) {
    fail("M6_LIVE_ORACLE_OBSERVATION_ENVELOPE_INVALID", "independent observation envelope is malformed or rebound", { status: 409 });
  }
  const circularHashes = new Set([
    requestHash,
    expectation.expectedArtifactHash,
    authority.manifestHash,
    authority.oracleHash,
    authority.effectBoundaryHash,
    authority.environmentAttestationHash,
    authority.accountIsolationHash,
  ]);
  validateSourceEvidence(envelope.sourceEvidence, policy, circularHashes);
  if (envelope.observation?.sourceEvidenceHash !== deriveM64SourceEvidenceHash(envelope.sourceEvidence)) {
    fail("M6_LIVE_ORACLE_SOURCE_HASH_INVALID", "independent observation does not bind its source evidence", { status: 409 });
  }
  assertSignature({
    publicKey: observerKey,
    signature: envelope.signature,
    bytes: canonicalM64ObservationEnvelopeSigningBytes(envelope),
    code: "M6_LIVE_ORACLE_OBSERVATION_SIGNATURE_INVALID",
    label: "independent observation envelope",
  });
  const validation = validateM64IndependentEffectObservation(envelope.observation, {
    expectation,
    bindings: observationBindings(authority),
    phase: authority.phase,
    nowMs,
    boundary: effectBoundary,
    family: authority.primaryFamily,
  });
  const observedAtMs = Date.parse(envelope.observation?.observedAt);
  if (!validation.ok || envelope.observation.independentObserverHash !== policy.independentObserverHash
    || !Number.isFinite(observedAtMs) || nowMs - observedAtMs < -5_000
    || nowMs - observedAtMs > policy.maxObservationAgeMs) {
    fail("M6_LIVE_ORACLE_OBSERVATION_INVALID", "independent observation is stale, tampered, forbidden, or rebound", {
      status: 409,
      details: { errors: validation.errors },
    });
  }
  return cloneFrozen(envelope.observation);
}

function deriveMatch(input) {
  const raw = Object.fromEntries(MATCH_KEYS.filter((key) => key !== "matchHash").map((key) => [key, input[key]]));
  return Object.freeze({ ...raw, matchHash: sha256(`xw.m6-4-independent-oracle-match.v1:${canonicalJson(raw)}`) });
}

function assertBlockSet(blockSet) {
  if (!blockSet || blockSet.schemaId !== "xw.visual-block-set.v2" || !HASH.test(blockSet.frameId || "")
    || !HASH.test(blockSet.environmentAttestationHash || "") || !HASH.test(blockSet.pageFingerprint || "")
    || !Array.isArray(blockSet.blocks) || blockSet.blocks.length === 0) {
    fail("M6_LIVE_TARGET_BLOCK_SET_INVALID", "target selector requires one server-owned visual block set", { status: 409 });
  }
  const { integritySha256: _ignored, ...core } = blockSet;
  if (blockSet.integritySha256 !== sha256(`xw.visual-block-set.v2:${canonicalJson(core)}`)) {
    fail("M6_LIVE_TARGET_BLOCK_SET_INVALID", "server-owned visual block set integrity changed", { status: 409 });
  }
}

function validateFreshCapture(value, input, policy, nowMs) {
  if (!exactObject(value, FRESH_CAPTURE_KEYS) || value.schemaId !== M64_FRESH_STATE_CAPTURE_SCHEMA_ID
    || value.captureHash !== deriveM64FreshStateCaptureHash(value)
    || value.sourceClass !== policy.allowedSourceClass || value.sourceKind !== policy.allowedSourceKind
    || value.runRef !== input.runRef || value.requestFrameRef !== input.frameRef
    || !exactObject(value.state, policy.requiredStateFields)
    || value.state.environmentAttestationHash !== input.environmentAttestationHash
    || value.state.slotSpecHash !== input.expectedState?.slotSpecHash
    || !HASH.test(value.state.frameId || "") || value.state.frameId === input.frameRef
    || (value.state.blockId !== null && !HASH.test(value.state.blockId || ""))
    || !Number.isSafeInteger(value.state.uiStateGeneration)
    || !Number.isInteger(value.state.rotation) || value.state.rotation < 0 || value.state.rotation > 3
    || [value.state.appPackageHash, value.state.focusHash, value.state.pageFingerprint,
      value.state.displayHash, value.state.environmentAttestationHash].some((item) => !HASH.test(item || ""))) {
    fail("M6_LIVE_CURRENT_STATE_CAPTURE_INVALID", "current-state guard did not receive a sealed server-owned capture", { status: 409 });
  }
  const capturedAtMs = Date.parse(value.capturedAt);
  if (!Number.isFinite(capturedAtMs) || nowMs - capturedAtMs < -5_000 || nowMs - capturedAtMs > policy.maxCaptureAgeMs) {
    fail("M6_LIVE_CURRENT_STATE_CAPTURE_STALE", "current-state capture is not fresh", { status: 409 });
  }
  // frameId and blockId are content-addressed identities of the newly captured
  // frame and therefore must rotate. slotSpecHash binds the same authority;
  // the seven independently derived stable fields decide semantic drift.
  if (DISPATCH_COMPARABLE_STATE_FIELDS.some((field) => value.state[field] !== input.expectedState?.[field])) {
    fail("M6_LIVE_CURRENT_STATE_DRIFT", "fresh server-owned current state changed before dispatch", { status: 409 });
  }
  return cloneFrozen(value.state);
}

function loadM64ProductionDependenciesInternal({
  runtimeBinding,
  productionDependencyBindingBytes = null,
  readFreshCapture = null,
  now = Date.now,
} = {}) {
  assertRuntimeBinding(runtimeBinding);
  if (typeof now !== "function" || (readFreshCapture !== null && typeof readFreshCapture !== "function")) {
    throw new TypeError("M6 production dependencies require a clock and an optional server-owned fresh-capture reader");
  }
  const nowMs = Number(now());
  if (!Number.isFinite(nowMs)) throw new TypeError("M6 production dependency clock must be finite");
  const releaseRoot = assertPlainDirectory(runtimeBinding.sourceReleaseRoot, "source release root");
  let bindingFile;
  if (productionDependencyBindingBytes === null) {
    bindingFile = safeReadBytes(
      runtimeBinding.productionDependencyBindingPath,
      runtimeBinding.productionDependencyBindingHash,
      "production dependency manifest",
      { outsideReleaseRoot: releaseRoot },
    );
  } else {
    if (!Buffer.isBuffer(productionDependencyBindingBytes)
      || productionDependencyBindingBytes.length < 2
      || productionDependencyBindingBytes.length > MAX_ARTIFACT_BYTES
      || within(releaseRoot, runtimeBinding.productionDependencyBindingPath)
      || sha256(productionDependencyBindingBytes) !== runtimeBinding.productionDependencyBindingHash) {
      fail("M6_LIVE_PRODUCTION_DEPENDENCY_BINDING_INVALID", "production dependency candidate bytes are malformed, rebound, or not content addressed");
    }
    bindingFile = Object.freeze({
      bytes: productionDependencyBindingBytes,
      sha256: runtimeBinding.productionDependencyBindingHash,
      path: resolve(runtimeBinding.productionDependencyBindingPath),
    });
  }
  let dependencyBinding;
  try { dependencyBinding = JSON.parse(bindingFile.bytes.toString("utf8")); } catch (cause) {
    fail("M6_LIVE_PRODUCTION_DEPENDENCY_BINDING_INVALID", "production dependency manifest is not valid JSON", { cause });
  }
  assertSecretFree(dependencyBinding, bindingFile.bytes.toString("utf8"), "production dependency manifest");
  assertDependencyBinding(dependencyBinding, runtimeBinding);

  const refs = Object.values(dependencyBinding).filter((item) => exactObject(item, ARTIFACT_REF_KEYS));
  if (new Set(refs.map((ref) => normalizedPath(ref.path))).size !== refs.length
    || refs.some((ref) => normalizedPath(ref.path) === normalizedPath(bindingFile.path))) {
    fail("M6_LIVE_PRODUCTION_DEPENDENCY_BINDING_INVALID", "production dependency artifacts must use distinct external files");
  }

  const environmentAttestationArtifact = readJsonArtifact(
    dependencyBinding.environmentAttestation,
    "environment attestation",
    { outsideReleaseRoot: releaseRoot },
  );
  const environmentQualificationArtifact = readJsonArtifact(
    dependencyBinding.environmentQualification,
    "environment qualification",
    { outsideReleaseRoot: releaseRoot },
  );
  if (normalizedPath(environmentAttestationArtifact.path) !== normalizedPath(realpathSync.native(runtimeBinding.targetEnvironmentAttestationPath))
    || normalizedPath(environmentQualificationArtifact.path) !== normalizedPath(realpathSync.native(runtimeBinding.environmentQualificationPath))
    || environmentQualificationArtifact.sha256 !== runtimeBinding.environmentQualificationSha256) {
    fail("M6_LIVE_DEPENDENCY_ENVIRONMENT_REBOUND", "dependency manifest changed the final runtime environment binding");
  }
  const environment = validateEnvironment(
    environmentAttestationArtifact.value,
    environmentQualificationArtifact.value,
    runtimeBinding,
    nowMs,
  );

  const effectBoundaryArtifact = readJsonArtifact(dependencyBinding.effectBoundary, "effect boundary", { outsideReleaseRoot: releaseRoot });
  const effectBoundaryValidation = validateM64EffectBoundary(effectBoundaryArtifact.value);
  if (!effectBoundaryValidation.ok) {
    fail("M6_LIVE_DEPENDENCY_EFFECT_BOUNDARY_INVALID", "effect boundary is malformed or rebound", {
      details: { errors: effectBoundaryValidation.errors },
    });
  }
  const effectBoundary = cloneFrozen(effectBoundaryArtifact.value);

  const oraclePolicyArtifact = readJsonArtifact(
    dependencyBinding.independentOraclePolicy,
    "independent oracle policy",
    { outsideReleaseRoot: releaseRoot },
  );
  const oracle = validateOraclePolicy(oraclePolicyArtifact.value, effectBoundary.boundaryHash, releaseRoot);
  const expectationIndexArtifact = readJsonArtifact(
    oracle.policy.expectationIndex,
    "expectation index",
    { outsideReleaseRoot: releaseRoot },
  );
  const expectationIndex = validateExpectationIndex(expectationIndexArtifact.value);
  const selectorPolicyArtifact = readJsonArtifact(
    dependencyBinding.targetSelectorPolicy,
    "target-selector policy",
    { outsideReleaseRoot: releaseRoot },
  );
  const selectorPolicy = validateSelectorPolicy(selectorPolicyArtifact.value, effectBoundary.boundaryHash);
  const guardPolicyArtifact = readJsonArtifact(
    dependencyBinding.currentStateGuardPolicy,
    "current-state guard policy",
    { outsideReleaseRoot: releaseRoot },
  );
  const guardPolicy = validateGuardPolicy(guardPolicyArtifact.value);

  const expectations = new Map();
  const observations = new Map();

  const independentOracle = Object.freeze({
    async loadExpectation(authority) {
      const lookupHash = deriveM64ExpectationLookupHash(authority);
      const entries = expectationIndex.entries.filter((entry) => entry.lookupHash === lookupHash);
      if (entries.length !== 1) {
        fail("M6_LIVE_EXPECTATION_UNAVAILABLE", "exactly one pre-window expectation is required", { status: 409 });
      }
      const artifact = readJsonArtifact(entries[0].expectationEnvelope, "expectation envelope", { outsideReleaseRoot: releaseRoot });
      const expectation = validateExpectationEnvelope(artifact.value, {
        authority,
        policy: oracle.policy,
        authorKey: oracle.authorKey,
        nowMs: Number(now()),
      });
      expectations.set(expectation.expectedArtifactHash, expectation);
      return expectation;
    },

    async observe(authority) {
      const expectation = expectations.get(authority.expectedArtifactHash);
      if (!expectation || expectation.independentAuthorHash !== authority.independentAuthorHash) {
        fail("M6_LIVE_EXPECTATION_NOT_LOADED", "independent observation requires the exact loaded expectation", { status: 409 });
      }
      const requestHash = deriveM64ObservationRequestHash(authority);
      const locatorPath = join(oracle.requestsRoot, `${requestHash}.json`);
      const locatorFile = safeReadBytes(locatorPath, null, "independent observation locator", { outsideReleaseRoot: releaseRoot });
      let locator;
      try { locator = JSON.parse(locatorFile.bytes.toString("utf8")); } catch (cause) {
        fail("M6_LIVE_ORACLE_OBSERVATION_UNAVAILABLE", "independent observation locator is invalid", { status: 409, cause });
      }
      assertSecretFree(locator, locatorFile.bytes.toString("utf8"), "independent observation locator");
      if (!exactObject(locator, LOCATOR_KEYS) || locator.schemaId !== M64_OBSERVATION_LOCATOR_SCHEMA_ID
        || locator.requestHash !== requestHash || !HASH.test(locator.envelopeSha256 || "")
        || locator.locatorHash !== deriveM64ObservationLocatorHash(locator)) {
        fail("M6_LIVE_ORACLE_OBSERVATION_LOCATOR_INVALID", "independent observation locator is tampered or rebound", { status: 409 });
      }
      const envelopeFile = safeReadBytes(
        join(oracle.observationsRoot, `${locator.envelopeSha256}.json`),
        locator.envelopeSha256,
        "independent observation envelope",
        { outsideReleaseRoot: releaseRoot },
      );
      let envelope;
      try { envelope = JSON.parse(envelopeFile.bytes.toString("utf8")); } catch (cause) {
        fail("M6_LIVE_ORACLE_OBSERVATION_UNAVAILABLE", "independent observation envelope is invalid", { status: 409, cause });
      }
      assertSecretFree(envelope, envelopeFile.bytes.toString("utf8"), "independent observation envelope");
      const observation = validateObservationEnvelope(envelope, {
        authority,
        expectation,
        requestHash,
        policy: oracle.policy,
        observerKey: oracle.observerKey,
        effectBoundary,
        nowMs: Number(now()),
      });
      observations.set(observation.observationHash, observation);
      return observation;
    },

    async compare(input) {
      if (!input || !HASH.test(input.expectedArtifactHash || "") || !HASH.test(input.expectedStateHash || "")
        || !HASH.test(input.independentAuthorHash || "") || !HASH.test(input.beforeObservationHash || "")
        || !HASH.test(input.afterObservationHash || "") || !HASH.test(input.slotAuthorityHash || "")) {
        fail("M6_LIVE_ORACLE_COMPARE_INPUT_INVALID", "oracle compare input is incomplete", { status: 409 });
      }
      const expectation = expectations.get(input.expectedArtifactHash);
      const before = observations.get(input.beforeObservationHash);
      const after = observations.get(input.afterObservationHash);
      if (!expectation || !before || !after || before.phase !== "before" || after.phase !== "after"
        || before.observationHash === after.observationHash
        || expectation.expectedStateHash !== input.expectedStateHash
        || expectation.independentAuthorHash !== input.independentAuthorHash
        || after.expectedArtifactHash !== expectation.expectedArtifactHash
        || after.actualStateHash !== expectation.expectedStateHash
        || M64_LIVE_CRITICAL_ZERO_COUNTER_FIELDS.some((field) => after.counters?.[field] !== 0)) {
        fail("M6_LIVE_ORACLE_EXPECTED_STATE_MISMATCH", "independent before/after evidence did not match the pre-window expectation", { status: 409 });
      }
      return deriveMatch({
        schemaId: "xw.m6-4-independent-oracle-match.v1",
        matched: true,
        selfDerived: false,
        expectedStateHash: expectation.expectedStateHash,
        beforeObservationHash: before.observationHash,
        afterObservationHash: after.observationHash,
        slotAuthorityHash: input.slotAuthorityHash,
        independentAuthorHash: expectation.independentAuthorHash,
      });
    },
  });

  const targetSelector = async ({ scenarioKey, slotAuthority, candidateBlockId = null, blockSet }) => {
    assertBlockSet(blockSet);
    if (!slotAuthority || slotAuthority.targetKind !== "block" || !HASH.test(slotAuthority.slotAuthorityHash || "")
      || !HASH.test(slotAuthority.targetEligibilityHash || "")) {
      fail("M6_LIVE_TARGET_SELECTOR_INPUT_INVALID", "target selector requires one frozen block slot authority", { status: 409 });
    }
    const rules = selectorPolicy.rules.filter((rule) => rule.scenarioKey === scenarioKey
      && rule.slotAuthorityHash === slotAuthority.slotAuthorityHash
      && rule.targetEligibilityHash === slotAuthority.targetEligibilityHash);
    if (rules.length !== 1) {
      fail("M6_LIVE_TARGET_SELECTOR_RULE_MISSING", "target selector has no unique frozen semantic rule", { status: 409 });
    }
    const rule = rules[0];
    const matches = blockSet.blocks.filter((block) => block.safeRegion === true
      && block.flags?.sensitive !== true && block.flags?.advertisement !== true && block.flags?.keyboard !== true
      && Object.entries(rule.requiredFeatures).every(([key, expected]) => block[key] === expected));
    if (candidateBlockId !== null) {
      if (!HASH.test(candidateBlockId || "") || !matches.some((block) => block.blockId === candidateBlockId)) {
        fail("M6_LIVE_TARGET_SELECTOR_POLICY_MISMATCH", "model-selected target is outside the frozen safe semantic policy", { status: 409 });
      }
      return candidateBlockId;
    }
    if (matches.length !== 1 || !HASH.test(matches[0].blockId || "")) {
      fail("M6_LIVE_TARGET_SELECTOR_AMBIGUOUS", "semantic target rule did not resolve exactly one safe block", { status: 409 });
    }
    return matches[0].blockId;
  };

  const createCurrentStateGuard = ({ readFreshCapture: reader } = {}) => {
    if (typeof reader !== "function") {
      throw new TypeError("M6 current-state guard requires one server-owned fresh-capture reader");
    }
    return async (input) => {
      if (!input || !nonemptyString(input.runRef) || !HASH.test(input.frameRef || "")
        || !HASH.test(input.environmentAttestationHash || "") || !exactObject(input.expectedState, STATE_FIELDS)) {
        fail("M6_LIVE_CURRENT_STATE_INPUT_INVALID", "current-state guard input is not closed", { status: 409 });
      }
      const captured = await reader(Object.freeze({
        runRef: input.runRef,
        frameRef: input.frameRef,
        environmentAttestationHash: input.environmentAttestationHash,
        signal: input.signal ?? null,
      }));
      return validateFreshCapture(captured, input, guardPolicy, Number(now()));
    };
  };
  Object.defineProperty(createCurrentStateGuard, "maxCaptureAgeMs", {
    value: guardPolicy.maxCaptureAgeMs,
    enumerable: true,
  });
  const currentStateGuard = readFreshCapture ? createCurrentStateGuard({ readFreshCapture }) : null;

  return Object.freeze({
    dependencyBinding: cloneFrozen(dependencyBinding),
    environmentAttestation: environment.environmentAttestation,
    environmentQualification: environment.environmentQualification,
    effectBoundary,
    independentOracle,
    independentObservationAuthority: Object.freeze({
      keyId: oracle.policy.observationObserverKeyId,
      observerHash: oracle.policy.independentObserverHash,
      publicKey: oracle.observerKey,
      maxAgeMs: oracle.policy.maxObservationAgeMs,
      observationRoot: oracle.observationRoot,
    }),
    targetSelector,
    currentStateGuard,
    createCurrentStateGuard,
    dependencyHashes: Object.freeze({
      binding: runtimeBinding.productionDependencyBindingHash,
      effectBoundary: effectBoundary.boundaryHash,
      independentOraclePolicy: oracle.policy.policyHash,
      targetSelectorPolicy: selectorPolicy.policyHash,
      currentStateGuardPolicy: guardPolicy.policyHash,
    }),
  });
}

export function loadM64ProductionDependencies(options = {}) {
  if (Reflect.has(Object(options), "productionDependencyBindingBytes")) {
    fail(
      "M6_LIVE_PRODUCTION_DEPENDENCY_CANDIDATE_FORBIDDEN",
      "production runtime dependency loading requires the real on-disk binding",
    );
  }
  return loadM64ProductionDependenciesInternal({
    runtimeBinding: options.runtimeBinding,
    readFreshCapture: options.readFreshCapture,
    now: options.now,
  });
}

export function validateM64ProductionDependencyCandidate({
  runtimeBinding,
  productionDependencyBindingBytes,
  readFreshCapture = null,
  now = Date.now,
} = {}) {
  if (!Buffer.isBuffer(productionDependencyBindingBytes)) {
    fail(
      "M6_LIVE_PRODUCTION_DEPENDENCY_CANDIDATE_REQUIRED",
      "assembler dependency validation requires explicit candidate bytes",
    );
  }
  return loadM64ProductionDependenciesInternal({
    runtimeBinding,
    productionDependencyBindingBytes,
    readFreshCapture,
    now,
  });
}
