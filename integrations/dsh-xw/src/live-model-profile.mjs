import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { canonicalJson } from "./canonical-json.mjs";

export const LIVE_MODEL_PROFILE_SCHEMA_ID = "xw.m6-live-model-profile.v1";
export const LIVE_MODEL_QUALIFICATION_SCHEMA_ID = "xw.m6-live-model-qualification.v1";
export const LIVE_MODEL_COLD_HEALTH_SCHEMA_ID = "xw.m6-live-model-cold-health.v1";
export const LIVE_MODEL_WARM_HEALTH_SCHEMA_ID = "xw.m6-live-model-warm-health.v1";
export const LIVE_MODEL_TTL_HEALTH_SCHEMA_ID = "xw.m6-live-model-ttl-health.v1";
export const LIVE_MODEL_TOOL_HEALTH_SCHEMA_ID = "xw.m6-live-model-tool-call-health.v1";
export const SEALED_LIVE_PROVIDER = "deepseek-official";
export const SEALED_LIVE_MODEL = "deepseek-v4-flash";
export const SEALED_LIVE_PROVIDER_BASE_URL = "https://api.deepseek.com";
export const SEALED_LIVE_PROVIDER_REQUEST_URL = "https://api.deepseek.com/chat/completions";
export const SEALED_ADAPTER_PACKAGE = "@deepseek-ai/dsh-llm-deepseek";
export const SEALED_ADAPTER_VERSION = "0.1.0-rc.8";
export const SEALED_CREDENTIAL_REF = "DEEPSEEK_API_KEY";

const H64 = /^[0-9a-f]{64}$/u;
const ZERO_HASH = "0".repeat(64);
const MODEL_ID = /^[a-z0-9][a-z0-9._:-]{1,127}$/u;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const WARM_SAMPLE_COUNT = 100;
const FRAME_TTL_MS = 5_000;
const MIN_REMAINING_TTL_MS = 1_000;
const WARM_P95_MAX_MS = 2_500;
const REQUEST_TIMEOUT_MS = 30_000;
const ADAPTER_REPOSITORY = "git+https://github.com/deepseek-ai/deepseek-harness.git";
const ADAPTER_REPOSITORY_DIRECTORY = "packages/llm/llm-deepseek";
const BUNDLE_KEYS = Object.freeze([
  "profile", "qualification", "coldHealth", "warmHealth", "ttlHealth", "toolCallHealth",
]);
const PROFILE_KEYS = Object.freeze([
  "schemaId", "status", "provider", "model", "exactVersion", "adapterPackage", "adapterVersion",
  "contextWindow", "maxTokens", "streamIdleTimeoutMs", "thinking", "reasoningEffort", "credentialRef",
  "license", "secretMaterialPresent", "deploymentSecretInjectionRequired", "adapterIntegrityHash",
  "adapterSourceHash", "licenseHash", "endpointHash", "requestEndpointHash", "provenanceHash",
  "qualificationHash", "toolCallHealthHash", "warmHealthHash", "coldHealthHash", "ttlHealthHash",
  "secretInjectionAttestationHash", "runtimeDependencyQualificationHash",
  "targetEnvironmentAttestationHash", "runtimeAttestationHashes", "capturedAt", "expiresAt",
  "gateFEligible", "contentHash",
]);
const QUALIFICATION_KEYS = Object.freeze([
  "schemaId", "status", "provider", "model", "endpointHash", "requestEndpointHash",
  "adapterIntegrityHash", "provenanceHash", "runtimeDependencyQualificationHash",
  "targetEnvironmentAttestationHash", "coldHealthHash", "warmHealthHash", "ttlHealthHash",
  "toolCallHealthHash", "secretInjectionAttestationHash", "secretMaterialPresent", "gateFEligible",
  "capturedAt", "expiresAt", "contentHash",
]);
const HEALTH_COMMON_KEYS = Object.freeze([
  "schemaId", "status", "provider", "model", "endpointHash", "requestEndpointHash",
  "secretMaterialPresent", "capturedAt", "expiresAt", "contentHash",
]);
const COLD_HEALTH_KEYS = Object.freeze([
  ...HEALTH_COMMON_KEYS, "sampleCount", "latencyMs", "responseHash",
]);
const WARM_HEALTH_KEYS = Object.freeze([
  ...HEALTH_COMMON_KEYS, "sampleCount", "p95LatencyMs", "maxLatencyMs", "samples",
]);
const TTL_HEALTH_KEYS = Object.freeze([
  ...HEALTH_COMMON_KEYS, "sampleCount", "frameTtlMs", "minimumRequiredRemainingTtlMs",
  "minimumObservedRemainingTtlMs", "samples",
]);
const TOOL_HEALTH_KEYS = Object.freeze([
  ...HEALTH_COMMON_KEYS, "sampleCount", "latencyMs", "responseHash", "toolName", "toolEffect",
  "deviceAccessed", "cpBrokerAccessed",
]);
const WARM_SAMPLE_KEYS = Object.freeze(["sampleIndex", "latencyMs", "responseHash"]);
const TTL_SAMPLE_KEYS = Object.freeze(["sampleIndex", "latencyMs", "remainingTtlMs", "responseHash"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function validHash(value) {
  return H64.test(value ?? "") && value !== ZERO_HASH;
}

function finiteNonnegative(value) {
  return Number.isFinite(value) && value >= 0 && !Object.is(value, -0);
}

function canonicalIso(value) {
  const milliseconds = Date.parse(value);
  return typeof value === "string" && Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString() === value;
}

function validIso(value) {
  return typeof value === "string" && ISO_DATE_TIME.test(value) && Number.isFinite(Date.parse(value));
}

function percentile(values, quantile) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)];
}

function deriveContentHash(record) {
  if (!isRecord(record) || typeof record.schemaId !== "string") return null;
  const { contentHash: _ignored, ...body } = record;
  return sha256(`${record.schemaId}:${canonicalJson(body)}`);
}

function deriveExpectedProvenanceHash(installed) {
  const body = {
    schemaId: "xw.m6-live-model-adapter-provenance.v1",
    packageName: installed.packageName,
    packageVersion: installed.packageVersion,
    license: installed.license,
    licenseHash: installed.licenseHash,
    sourceHash: installed.sourceHash,
    integrityHash: installed.integrityHash,
    repository: ADAPTER_REPOSITORY,
    repositoryDirectory: ADAPTER_REPOSITORY_DIRECTORY,
  };
  return sha256(`xw.m6-live-model-adapter-provenance.v1:${canonicalJson(body)}`);
}

function deriveExpectedSecretInjectionAttestationHash() {
  return sha256(`xw.m6-live-model-secret-injection.v1:${canonicalJson({
    credentialRef: SEALED_CREDENTIAL_REF,
    injection: "PROCESS_ENVIRONMENT_ONLY",
    observed: true,
    persisted: false,
  })}`);
}

export function deriveLiveModelProfileHash(profile) {
  if (!isRecord(profile)) return null;
  const { contentHash: _ignored, ...body } = profile;
  return sha256(`${LIVE_MODEL_PROFILE_SCHEMA_ID}:${canonicalJson(body)}`);
}

function profileError(code, message, cause, errors = undefined) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  if (errors !== undefined) error.errors = Object.freeze([...errors]);
  return error;
}

function resolvePlainQualificationRoot(qualificationRoot) {
  if (typeof qualificationRoot !== "string" || !isAbsolute(qualificationRoot)) {
    throw profileError("M6_LIVE_PROFILE_ARTIFACT_BINDING_INVALID", "model qualification root must be absolute");
  }
  try {
    const stat = lstatSync(qualificationRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw profileError("M6_LIVE_PROFILE_ARTIFACT_SYMLINK", "model qualification root must be one plain directory");
    }
    const root = realpathSync(qualificationRoot);
    const realStat = lstatSync(root);
    if (!realStat.isDirectory() || realStat.isSymbolicLink()) {
      throw profileError("M6_LIVE_PROFILE_ARTIFACT_SYMLINK", "model qualification root must resolve to one plain directory");
    }
    return root;
  } catch (cause) {
    if (cause?.code?.startsWith?.("M6_")) throw cause;
    throw profileError("M6_LIVE_PROFILE_ARTIFACT_UNAVAILABLE", "model qualification root is unavailable", cause);
  }
}

function loadContentAddressedRecord(root, expectedContentHash) {
  if (!validHash(expectedContentHash)) {
    throw profileError("M6_LIVE_PROFILE_ARTIFACT_BINDING_INVALID", "model qualification artifact hash must be a non-zero SHA-256 value");
  }
  const target = resolve(root, `${expectedContentHash}.json`);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw profileError("M6_LIVE_PROFILE_ARTIFACT_BINDING_INVALID", "model qualification artifact escaped its sealed root");
  }
  let record;
  try {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw profileError("M6_LIVE_PROFILE_ARTIFACT_SYMLINK", "model qualification artifact must be one plain file");
    }
    const realTarget = realpathSync(target);
    const realRel = relative(root, realTarget);
    if (!realRel || realRel.startsWith("..") || isAbsolute(realRel)) {
      throw profileError("M6_LIVE_PROFILE_ARTIFACT_BINDING_INVALID", "model qualification artifact real path escaped its sealed root");
    }
    record = JSON.parse(readFileSync(realTarget, "utf8"));
  } catch (cause) {
    if (cause?.code?.startsWith?.("M6_")) throw cause;
    throw profileError("M6_LIVE_PROFILE_ARTIFACT_UNAVAILABLE", "model qualification artifact is unavailable or malformed", cause);
  }
  if (!isRecord(record) || record.contentHash !== expectedContentHash
    || deriveContentHash(record) !== expectedContentHash) {
    throw profileError("M6_LIVE_PROFILE_CONTENT_MISMATCH", "model qualification artifact is not stored under its canonical content hash");
  }
  return record;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function loadContentAddressedLiveModelProfile({ qualificationRoot, expectedContentHash } = {}) {
  const root = resolvePlainQualificationRoot(qualificationRoot);
  const profile = loadContentAddressedRecord(root, expectedContentHash);
  if (profile.schemaId !== LIVE_MODEL_PROFILE_SCHEMA_ID
    || deriveLiveModelProfileHash(profile) !== expectedContentHash) {
    throw profileError("M6_LIVE_PROFILE_CONTENT_MISMATCH", "model qualification artifact is not a canonical live-model profile");
  }
  return deepFreeze(profile);
}

export function computeInstalledLiveAdapterIntegrity({ dependencyRoot = null } = {}) {
  const packageJsonPath = dependencyRoot === null
    ? createRequire(import.meta.url).resolve(`${SEALED_ADAPTER_PACKAGE}/package.json`)
    : join(dependencyRoot, "integrations", "dsh-xw", "node_modules", ...SEALED_ADAPTER_PACKAGE.split("/"), "package.json");
  const packageRoot = dirname(packageJsonPath);
  const packageJsonBytes = readFileSync(packageJsonPath);
  const sourceBytes = readFileSync(join(packageRoot, "lib", "index.js"));
  const licenseBytes = readFileSync(join(packageRoot, "LICENSE"));
  const packageJson = JSON.parse(packageJsonBytes.toString("utf8"));
  const integrityHash = sha256(Buffer.concat([
    Buffer.from(`${SEALED_ADAPTER_PACKAGE}\0${packageJson.version}\0`, "utf8"),
    packageJsonBytes,
    Buffer.from("\0", "utf8"),
    sourceBytes,
    Buffer.from("\0", "utf8"),
    licenseBytes,
  ]));
  return Object.freeze({
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    license: packageJson.license,
    licenseHash: sha256(licenseBytes),
    sourceHash: sha256(sourceBytes),
    integrityHash,
  });
}

export function validateQualifiedLiveModelProfile(profile, {
  installed = null,
  runtimeEndpoint = null,
  expectedContentHash = null,
  requiredRuntimeAttestationHash = null,
  requiredTargetEnvironmentAttestationHash = null,
  now = null,
  requiredLiveWindowExpiresAt = null,
} = {}) {
  const errors = [];
  if (!isRecord(profile) || profile.schemaId !== LIVE_MODEL_PROFILE_SCHEMA_ID) errors.push("M6_LIVE_PROFILE_SCHEMA_INVALID");
  if (profile?.status !== "QUALIFIED" || profile?.gateFEligible !== true) errors.push("M6_LIVE_PROFILE_UNQUALIFIED");
  if (profile?.provider !== SEALED_LIVE_PROVIDER || !MODEL_ID.test(profile?.model || "")
    || typeof profile?.exactVersion !== "string" || profile.exactVersion.length < 1) errors.push("M6_LIVE_PROVIDER_UNSEALED");
  if (!Number.isSafeInteger(profile?.contextWindow) || profile.contextWindow < 1
    || !Number.isSafeInteger(profile?.maxTokens) || profile.maxTokens < 1 || profile.maxTokens > profile.contextWindow
    || !Number.isFinite(profile?.streamIdleTimeoutMs) || profile.streamIdleTimeoutMs < 1 || profile.streamIdleTimeoutMs > 300_000
    || !["enabled", "disabled"].includes(profile?.thinking)
    || (profile.thinking === "enabled" && !["low", "high", "max"].includes(profile?.reasoningEffort))
    || (profile.thinking === "disabled" && profile?.reasoningEffort !== "off")) errors.push("M6_LIVE_MODEL_LIMITS_INVALID");
  if (profile?.adapterPackage !== SEALED_ADAPTER_PACKAGE || profile?.adapterVersion !== SEALED_ADAPTER_VERSION
    || profile?.credentialRef !== SEALED_CREDENTIAL_REF) errors.push("M6_LIVE_PROVIDER_UNSEALED");
  if (profile?.license !== "MIT" || profile?.secretMaterialPresent !== false
    || profile?.deploymentSecretInjectionRequired !== true) errors.push("M6_LIVE_PROVIDER_PROVENANCE_INVALID");
  for (const key of [
    "adapterIntegrityHash", "adapterSourceHash", "licenseHash", "endpointHash",
    "provenanceHash", "qualificationHash", "toolCallHealthHash", "warmHealthHash",
    "coldHealthHash", "ttlHealthHash", "secretInjectionAttestationHash", "contentHash",
  ]) if (!validHash(profile?.[key])) errors.push("M6_LIVE_PROFILE_HASH_INVALID");
  if (profile?.requestEndpointHash !== undefined && !validHash(profile.requestEndpointHash)) errors.push("M6_LIVE_PROFILE_HASH_INVALID");
  if (!Array.isArray(profile?.runtimeAttestationHashes) || profile.runtimeAttestationHashes.length === 0
    || profile.runtimeAttestationHashes.some((value) => !validHash(value))) errors.push("M6_LIVE_ENVIRONMENT_UNQUALIFIED");
  if (profile?.runtimeDependencyQualificationHash !== undefined
    && (!validHash(profile.runtimeDependencyQualificationHash)
      || profile.runtimeAttestationHashes?.[0] !== profile.runtimeDependencyQualificationHash)) {
    errors.push("M6_LIVE_DEPENDENCY_ATTESTATION_MISMATCH");
  }
  if (profile?.targetEnvironmentAttestationHash !== undefined
    && (!validHash(profile.targetEnvironmentAttestationHash)
      || !profile.runtimeAttestationHashes?.includes(profile.targetEnvironmentAttestationHash))) {
    errors.push("M6_LIVE_TARGET_ATTESTATION_MISMATCH");
  }
  if (requiredRuntimeAttestationHash !== null && (!validHash(requiredRuntimeAttestationHash)
    || !profile?.runtimeAttestationHashes?.includes(requiredRuntimeAttestationHash))) errors.push("M6_LIVE_DEPENDENCY_ATTESTATION_MISMATCH");
  if (requiredTargetEnvironmentAttestationHash !== null
    && (!validHash(requiredTargetEnvironmentAttestationHash)
      || profile?.targetEnvironmentAttestationHash !== requiredTargetEnvironmentAttestationHash)) {
    errors.push("M6_LIVE_TARGET_ATTESTATION_MISMATCH");
  }
  if (deriveLiveModelProfileHash(profile) !== profile?.contentHash
    || (expectedContentHash !== null && profile?.contentHash !== expectedContentHash)) errors.push("M6_LIVE_PROFILE_CONTENT_MISMATCH");
  if (runtimeEndpoint !== null && sha256(runtimeEndpoint) !== profile?.endpointHash) errors.push("M6_LIVE_PROVIDER_ENDPOINT_MISMATCH");
  if (installed !== null && (
    installed.packageName !== profile?.adapterPackage
    || installed.packageVersion !== profile?.adapterVersion
    || installed.license !== profile?.license
    || installed.licenseHash !== profile?.licenseHash
    || installed.sourceHash !== profile?.adapterSourceHash
    || installed.integrityHash !== profile?.adapterIntegrityHash
  )) errors.push("M6_LIVE_PROVIDER_INTEGRITY_MISMATCH");
  if (now !== null) {
    const nowMs = Number(typeof now === "function" ? now() : now);
    const capturedAtMs = Date.parse(profile?.capturedAt);
    const expiresAtMs = Date.parse(profile?.expiresAt);
    if (!Number.isFinite(nowMs) || !canonicalIso(profile?.capturedAt) || !canonicalIso(profile?.expiresAt)
      || capturedAtMs > nowMs || expiresAtMs <= capturedAtMs || expiresAtMs <= nowMs) {
      errors.push("M6_LIVE_PROFILE_STALE");
    }
    if (requiredLiveWindowExpiresAt !== null) {
      const liveWindowExpiresAtMs = Date.parse(requiredLiveWindowExpiresAt);
      if (!validIso(requiredLiveWindowExpiresAt) || liveWindowExpiresAtMs <= nowMs
        || liveWindowExpiresAtMs > expiresAtMs) errors.push("M6_LIVE_WINDOW_EXCEEDS_MODEL_QUALIFICATION");
    }
  }
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze([...new Set(errors)]) });
}

function validateHealthEnvelope(record, schemaId, keys, qualification, errors) {
  if (!hasExactKeys(record, keys) || record.schemaId !== schemaId || record.status !== "PASS"
    || record.provider !== qualification?.provider || record.model !== qualification?.model
    || record.endpointHash !== qualification?.endpointHash
    || record.requestEndpointHash !== qualification?.requestEndpointHash
    || record.secretMaterialPresent !== false
    || record.capturedAt !== qualification?.capturedAt || record.expiresAt !== qualification?.expiresAt) {
    errors.push("M6_LIVE_MODEL_EVIDENCE_SCHEMA_INVALID");
  }
}

export function validateQualifiedLiveModelBundle(bundle, {
  installed = null,
  runtimeEndpoint = null,
  expectedProfileHash = null,
  requiredRuntimeDependencyQualificationHash = null,
  requiredTargetEnvironmentAttestationHash = null,
  requiredLiveWindowExpiresAt = null,
  now = Date.now,
} = {}) {
  const errors = [];
  if (!hasExactKeys(bundle, BUNDLE_KEYS)) errors.push("M6_LIVE_MODEL_BUNDLE_SCHEMA_INVALID");
  const profile = bundle?.profile;
  const qualification = bundle?.qualification;
  const coldHealth = bundle?.coldHealth;
  const warmHealth = bundle?.warmHealth;
  const ttlHealth = bundle?.ttlHealth;
  const toolCallHealth = bundle?.toolCallHealth;

  if (!hasExactKeys(profile, PROFILE_KEYS) || !hasExactKeys(qualification, QUALIFICATION_KEYS)) {
    errors.push("M6_LIVE_MODEL_BUNDLE_SCHEMA_INVALID");
  }
  const profileValidation = validateQualifiedLiveModelProfile(profile, {
    installed,
    runtimeEndpoint,
    expectedContentHash: expectedProfileHash,
    requiredRuntimeAttestationHash: requiredRuntimeDependencyQualificationHash,
    requiredTargetEnvironmentAttestationHash,
  });
  errors.push(...profileValidation.errors);

  for (const record of [profile, qualification, coldHealth, warmHealth, ttlHealth, toolCallHealth]) {
    if (!isRecord(record) || !validHash(record.contentHash) || deriveContentHash(record) !== record.contentHash) {
      errors.push("M6_LIVE_MODEL_BUNDLE_CONTENT_MISMATCH");
    }
  }

  if (qualification?.schemaId !== LIVE_MODEL_QUALIFICATION_SCHEMA_ID || qualification?.status !== "QUALIFIED"
    || qualification?.provider !== SEALED_LIVE_PROVIDER || qualification?.model !== SEALED_LIVE_MODEL
    || qualification?.endpointHash !== sha256(SEALED_LIVE_PROVIDER_BASE_URL)
    || qualification?.requestEndpointHash !== sha256(SEALED_LIVE_PROVIDER_REQUEST_URL)
    || qualification?.secretMaterialPresent !== false || qualification?.gateFEligible !== true
    || ![
      qualification?.adapterIntegrityHash, qualification?.provenanceHash,
      qualification?.runtimeDependencyQualificationHash, qualification?.targetEnvironmentAttestationHash,
      qualification?.coldHealthHash, qualification?.warmHealthHash, qualification?.ttlHealthHash,
      qualification?.toolCallHealthHash, qualification?.secretInjectionAttestationHash,
    ].every(validHash)) {
    errors.push("M6_LIVE_MODEL_QUALIFICATION_INVALID");
  }
  if (profile?.provider !== SEALED_LIVE_PROVIDER || profile?.model !== SEALED_LIVE_MODEL
    || profile?.exactVersion !== SEALED_LIVE_MODEL || profile?.endpointHash !== qualification?.endpointHash
    || profile?.contextWindow !== 64_000 || profile?.maxTokens !== 4_096
    || profile?.streamIdleTimeoutMs !== 30_000 || profile?.thinking !== "disabled"
    || profile?.reasoningEffort !== "off"
    || profile?.requestEndpointHash !== qualification?.requestEndpointHash
    || profile?.qualificationHash !== qualification?.contentHash
    || profile?.adapterIntegrityHash !== qualification?.adapterIntegrityHash
    || profile?.provenanceHash !== qualification?.provenanceHash
    || profile?.runtimeDependencyQualificationHash !== qualification?.runtimeDependencyQualificationHash
    || profile?.targetEnvironmentAttestationHash !== qualification?.targetEnvironmentAttestationHash
    || profile?.coldHealthHash !== qualification?.coldHealthHash
    || profile?.warmHealthHash !== qualification?.warmHealthHash
    || profile?.ttlHealthHash !== qualification?.ttlHealthHash
    || profile?.toolCallHealthHash !== qualification?.toolCallHealthHash
    || profile?.secretInjectionAttestationHash !== qualification?.secretInjectionAttestationHash
    || profile?.capturedAt !== qualification?.capturedAt || profile?.expiresAt !== qualification?.expiresAt
    || !Array.isArray(profile?.runtimeAttestationHashes) || profile.runtimeAttestationHashes.length !== 2
    || profile.runtimeAttestationHashes[0] !== qualification?.runtimeDependencyQualificationHash
    || profile.runtimeAttestationHashes[1] !== qualification?.targetEnvironmentAttestationHash) {
    errors.push("M6_LIVE_MODEL_BUNDLE_BINDING_MISMATCH");
  }
  const expectedSecretInjectionAttestationHash = deriveExpectedSecretInjectionAttestationHash();
  if (qualification?.secretInjectionAttestationHash !== expectedSecretInjectionAttestationHash
    || profile?.secretInjectionAttestationHash !== expectedSecretInjectionAttestationHash) {
    errors.push("M6_LIVE_MODEL_SECRET_INJECTION_ATTESTATION_INVALID");
  }
  if (installed !== null) {
    const expectedProvenanceHash = deriveExpectedProvenanceHash(installed);
    if (qualification?.provenanceHash !== expectedProvenanceHash || profile?.provenanceHash !== expectedProvenanceHash) {
      errors.push("M6_LIVE_PROVIDER_PROVENANCE_INVALID");
    }
  }
  if (qualification?.coldHealthHash !== coldHealth?.contentHash
    || qualification?.warmHealthHash !== warmHealth?.contentHash
    || qualification?.ttlHealthHash !== ttlHealth?.contentHash
    || qualification?.toolCallHealthHash !== toolCallHealth?.contentHash) {
    errors.push("M6_LIVE_MODEL_BUNDLE_BINDING_MISMATCH");
  }

  validateHealthEnvelope(coldHealth, LIVE_MODEL_COLD_HEALTH_SCHEMA_ID, COLD_HEALTH_KEYS, qualification, errors);
  validateHealthEnvelope(warmHealth, LIVE_MODEL_WARM_HEALTH_SCHEMA_ID, WARM_HEALTH_KEYS, qualification, errors);
  validateHealthEnvelope(ttlHealth, LIVE_MODEL_TTL_HEALTH_SCHEMA_ID, TTL_HEALTH_KEYS, qualification, errors);
  validateHealthEnvelope(toolCallHealth, LIVE_MODEL_TOOL_HEALTH_SCHEMA_ID, TOOL_HEALTH_KEYS, qualification, errors);

  if (coldHealth?.sampleCount !== 1 || !finiteNonnegative(coldHealth?.latencyMs)
    || coldHealth.latencyMs > REQUEST_TIMEOUT_MS || !validHash(coldHealth?.responseHash)) {
    errors.push("M6_LIVE_MODEL_COLD_EVIDENCE_INVALID");
  }
  const warmSamplesValid = Array.isArray(warmHealth?.samples)
    && warmHealth.samples.length === WARM_SAMPLE_COUNT
    && warmHealth.samples.every((sample, index) => hasExactKeys(sample, WARM_SAMPLE_KEYS)
      && sample.sampleIndex === index && finiteNonnegative(sample.latencyMs) && validHash(sample.responseHash));
  if (warmHealth?.sampleCount !== WARM_SAMPLE_COUNT || !warmSamplesValid) {
    errors.push("M6_LIVE_MODEL_WARM_EVIDENCE_INVALID");
  } else {
    const latencies = warmHealth.samples.map((sample) => sample.latencyMs);
    if (warmHealth.p95LatencyMs !== percentile(latencies, 0.95)
      || warmHealth.maxLatencyMs !== Math.max(...latencies)
      || warmHealth.p95LatencyMs > WARM_P95_MAX_MS) {
      errors.push("M6_LIVE_MODEL_WARM_AGGREGATE_MISMATCH");
    }
  }
  const ttlSamplesValid = Array.isArray(ttlHealth?.samples)
    && ttlHealth.samples.length === WARM_SAMPLE_COUNT
    && ttlHealth.samples.every((sample, index) => hasExactKeys(sample, TTL_SAMPLE_KEYS)
      && sample.sampleIndex === index && finiteNonnegative(sample.latencyMs)
      && finiteNonnegative(sample.remainingTtlMs) && validHash(sample.responseHash));
  if (ttlHealth?.sampleCount !== WARM_SAMPLE_COUNT || ttlHealth?.frameTtlMs !== FRAME_TTL_MS
    || ttlHealth?.minimumRequiredRemainingTtlMs !== MIN_REMAINING_TTL_MS || !ttlSamplesValid) {
    errors.push("M6_LIVE_MODEL_TTL_EVIDENCE_INVALID");
  } else if (warmSamplesValid) {
    const reconstructedRemaining = ttlHealth.samples.map((sample, index) => {
      const warmSample = warmHealth.samples[index];
      if (sample.latencyMs !== warmSample.latencyMs || sample.responseHash !== warmSample.responseHash
        || sample.remainingTtlMs !== FRAME_TTL_MS - warmSample.latencyMs) {
        errors.push("M6_LIVE_MODEL_SAMPLE_BINDING_MISMATCH");
      }
      return FRAME_TTL_MS - warmSample.latencyMs;
    });
    if (ttlHealth.minimumObservedRemainingTtlMs !== Math.min(...reconstructedRemaining)
      || ttlHealth.minimumObservedRemainingTtlMs < MIN_REMAINING_TTL_MS) {
      errors.push("M6_LIVE_MODEL_TTL_AGGREGATE_MISMATCH");
    }
  }
  if (toolCallHealth?.sampleCount !== 1 || !finiteNonnegative(toolCallHealth?.latencyMs)
    || toolCallHealth.latencyMs > FRAME_TTL_MS - MIN_REMAINING_TTL_MS
    || !validHash(toolCallHealth?.responseHash)
    || toolCallHealth?.toolName !== "xw_qualification_noop"
    || toolCallHealth?.toolEffect !== "NONE_NOT_EXECUTED"
    || toolCallHealth?.deviceAccessed !== false || toolCallHealth?.cpBrokerAccessed !== false) {
    errors.push("M6_LIVE_MODEL_TOOL_EVIDENCE_INVALID");
  }

  const nowMs = Number(typeof now === "function" ? now() : now);
  const capturedAtMs = Date.parse(profile?.capturedAt);
  const expiresAtMs = Date.parse(profile?.expiresAt);
  if (!Number.isFinite(nowMs) || !canonicalIso(profile?.capturedAt) || !canonicalIso(profile?.expiresAt)
    || capturedAtMs > nowMs || expiresAtMs <= capturedAtMs || expiresAtMs <= nowMs) {
    errors.push("M6_LIVE_PROFILE_STALE");
  }
  if (requiredRuntimeDependencyQualificationHash !== null
    && (!validHash(requiredRuntimeDependencyQualificationHash)
      || qualification?.runtimeDependencyQualificationHash !== requiredRuntimeDependencyQualificationHash)) {
    errors.push("M6_LIVE_DEPENDENCY_ATTESTATION_MISMATCH");
  }
  if (requiredTargetEnvironmentAttestationHash !== null
    && (!validHash(requiredTargetEnvironmentAttestationHash)
      || qualification?.targetEnvironmentAttestationHash !== requiredTargetEnvironmentAttestationHash)) {
    errors.push("M6_LIVE_TARGET_ATTESTATION_MISMATCH");
  }
  if (requiredLiveWindowExpiresAt !== null) {
    const liveWindowExpiresAtMs = Date.parse(requiredLiveWindowExpiresAt);
    if (!validIso(requiredLiveWindowExpiresAt) || liveWindowExpiresAtMs <= nowMs
      || liveWindowExpiresAtMs > expiresAtMs) errors.push("M6_LIVE_WINDOW_EXCEEDS_MODEL_QUALIFICATION");
  }
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze([...new Set(errors)]) });
}

export function loadContentAddressedLiveModelQualificationBundle({
  qualificationRoot,
  expectedProfileHash = null,
  expectedContentHash = null,
  installed = null,
  runtimeEndpoint = null,
  requiredRuntimeDependencyQualificationHash = null,
  requiredTargetEnvironmentAttestationHash = null,
  requiredLiveWindowExpiresAt = null,
  now = Date.now,
} = {}) {
  const profileHash = expectedProfileHash ?? expectedContentHash;
  if (expectedProfileHash !== null && expectedContentHash !== null && expectedProfileHash !== expectedContentHash) {
    throw profileError("M6_LIVE_PROFILE_ARTIFACT_BINDING_INVALID", "conflicting expected model profile hashes were supplied");
  }
  const root = resolvePlainQualificationRoot(qualificationRoot);
  const profile = loadContentAddressedRecord(root, profileHash);
  if (profile.schemaId !== LIVE_MODEL_PROFILE_SCHEMA_ID || deriveLiveModelProfileHash(profile) !== profileHash) {
    throw profileError("M6_LIVE_PROFILE_CONTENT_MISMATCH", "root model qualification artifact is not a canonical profile");
  }
  for (const key of ["qualificationHash", "coldHealthHash", "warmHealthHash", "ttlHealthHash", "toolCallHealthHash"]) {
    if (!validHash(profile[key])) {
      throw profileError("M6_LIVE_PROFILE_HASH_INVALID", "model profile contains a missing, zero, or malformed evidence hash");
    }
  }
  const qualification = loadContentAddressedRecord(root, profile.qualificationHash);
  const coldHealth = loadContentAddressedRecord(root, profile.coldHealthHash);
  const warmHealth = loadContentAddressedRecord(root, profile.warmHealthHash);
  const ttlHealth = loadContentAddressedRecord(root, profile.ttlHealthHash);
  const toolCallHealth = loadContentAddressedRecord(root, profile.toolCallHealthHash);
  const bundle = { profile, qualification, coldHealth, warmHealth, ttlHealth, toolCallHealth };
  const validation = validateQualifiedLiveModelBundle(bundle, {
    installed,
    runtimeEndpoint,
    expectedProfileHash: profileHash,
    requiredRuntimeDependencyQualificationHash,
    requiredTargetEnvironmentAttestationHash,
    requiredLiveWindowExpiresAt,
    now,
  });
  if (!validation.ok) {
    throw profileError(validation.errors[0], `live model qualification bundle failed deep validation: ${validation.errors.join(",")}`, undefined, validation.errors);
  }
  return deepFreeze(bundle);
}
