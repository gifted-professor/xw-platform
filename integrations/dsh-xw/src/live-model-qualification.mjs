import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { deriveTargetEnvironmentAttestation } from "../../../packages/kernel/lib/m6-live-grounding.mjs";
import { canonicalJson } from "./canonical-json.mjs";
import {
  computeInstalledLiveAdapterIntegrity,
  deriveLiveModelProfileHash,
  SEALED_ADAPTER_PACKAGE,
  SEALED_ADAPTER_VERSION,
  SEALED_CREDENTIAL_REF,
  SEALED_LIVE_PROVIDER,
  validateQualifiedLiveModelBundle,
  validateQualifiedLiveModelProfile,
} from "./live-model-profile.mjs";

export const M6_LIVE_MODEL_QUALIFICATION_SCHEMA_ID = "xw.m6-live-model-qualification.v1";
export const DEEPSEEK_OPENAI_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_OPENAI_CHAT_COMPLETIONS_ENDPOINT = "https://api.deepseek.com/chat/completions";
export const DEEPSEEK_QUALIFIED_MODEL = "deepseek-v4-flash";
export const M6_LIVE_MODEL_WARM_SAMPLE_COUNT = 100;
export const M6_LIVE_MODEL_FRAME_TTL_MS = 5_000;
export const M6_LIVE_MODEL_MIN_REMAINING_TTL_MS = 1_000;
export const M6_LIVE_MODEL_WARM_P95_MAX_MS = 2_500;
export const M6_LIVE_MODEL_REQUEST_TIMEOUT_MS = 30_000;
export const M6_LIVE_MODEL_DUMMY_TOOL_NAME = "xw_qualification_noop";

const RUNTIME_QUALIFICATION_SCHEMA_ID = "xw.m6-live-runtime-dependency-qualification.v1";
const TARGET_ATTESTATION_SCHEMA_ID = "xw.m6-target-environment-attestation.v1";
const ADAPTER_REPOSITORY = "git+https://github.com/deepseek-ai/deepseek-harness.git";
const ADAPTER_REPOSITORY_DIRECTORY = "packages/llm/llm-deepseek";
const H64 = /^[0-9a-f]{64}$/u;
const ZERO_HASH = "0".repeat(64);
const API_KEY = /^[^\0\r\n]{8,4096}$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fail(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  throw error;
}

function hasOnlyKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function seal(schemaId, body) {
  return Object.freeze({ ...body, contentHash: sha256(`${schemaId}:${canonicalJson(body)}`) });
}

function percentile(values, quantile) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)];
}

function assertHash(value, code, message) {
  if (!validHash(value)) fail(code, message);
  return value;
}

function validHash(value) {
  return H64.test(value ?? "") && value !== ZERO_HASH;
}

function validateApiKey(environment) {
  if (!hasOnlyKeys(environment, [SEALED_CREDENTIAL_REF]) || !API_KEY.test(environment?.[SEALED_CREDENTIAL_REF] ?? "")) {
    fail("M6_LIVE_MODEL_CREDENTIAL_INVALID", "execute requires only a valid DEEPSEEK_API_KEY environment injection");
  }
  return environment[SEALED_CREDENTIAL_REF];
}

export function deriveRuntimeDependencyQualificationHash(qualification) {
  if (!qualification || typeof qualification !== "object" || Array.isArray(qualification)) return null;
  const { qualificationHash: _ignored, ...body } = qualification;
  return sha256(`${RUNTIME_QUALIFICATION_SCHEMA_ID}:${canonicalJson(body)}`);
}

export function validateLiveModelQualificationBindings({
  dependencyRoot,
  runtimeDependencyQualification,
  targetEnvironmentAttestation,
  now = Date.now,
} = {}) {
  if (typeof dependencyRoot !== "string" || !isAbsolute(dependencyRoot)) {
    fail("M6_LIVE_MODEL_DEPENDENCY_ROOT_INVALID", "dependencyRoot must be absolute");
  }
  if (lstatSync(dependencyRoot).isSymbolicLink()) fail("M6_LIVE_MODEL_DEPENDENCY_ROOT_INVALID", "dependencyRoot must not be a symbolic link");
  const root = realpathSync(dependencyRoot);
  const installed = computeInstalledLiveAdapterIntegrity({ dependencyRoot: root });
  const packagePath = join(root, "integrations", "dsh-xw", "node_modules", ...SEALED_ADAPTER_PACKAGE.split("/"), "package.json");
  for (const path of [packagePath, join(resolve(packagePath, ".."), "lib", "index.js"), join(resolve(packagePath, ".."), "LICENSE")]) {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
      fail("M6_LIVE_MODEL_ADAPTER_PROVENANCE_INVALID", "installed adapter provenance files must be plain files");
    }
  }
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  if (installed.packageName !== SEALED_ADAPTER_PACKAGE
    || installed.packageVersion !== SEALED_ADAPTER_VERSION
    || installed.license !== "MIT"
    || packageJson.repository?.url !== ADAPTER_REPOSITORY
    || packageJson.repository?.directory !== ADAPTER_REPOSITORY_DIRECTORY) {
    fail("M6_LIVE_MODEL_ADAPTER_PROVENANCE_INVALID", "installed adapter package, exact version, license, or repository provenance is not sealed");
  }
  const dependencyHash = runtimeDependencyQualification?.qualificationHash;
  if (runtimeDependencyQualification?.schemaId !== RUNTIME_QUALIFICATION_SCHEMA_ID
    || runtimeDependencyQualification?.status !== "DEPENDENCY_LAYER_QUALIFIED"
    || runtimeDependencyQualification?.secretMaterialPresent !== false
    || runtimeDependencyQualification?.providerHealthEvaluated !== false
    || runtimeDependencyQualification?.adapterPackage !== installed.packageName
    || runtimeDependencyQualification?.adapterVersion !== installed.packageVersion
    || runtimeDependencyQualification?.adapterIntegrityHash !== installed.integrityHash
    || Object.entries(runtimeDependencyQualification ?? {})
      .some(([key, value]) => key.endsWith("Hash") && !validHash(value))
    || !validHash(dependencyHash)
    || deriveRuntimeDependencyQualificationHash(runtimeDependencyQualification) !== dependencyHash) {
    fail("M6_LIVE_MODEL_DEPENDENCY_QUALIFICATION_INVALID", "runtime dependency qualification is malformed, drifted, or not bound to the installed adapter");
  }

  let derivedAttestation;
  try {
    const { attestationHash: _ignored, ...attestationBody } = targetEnvironmentAttestation ?? {};
    derivedAttestation = deriveTargetEnvironmentAttestation(attestationBody);
  } catch (cause) {
    fail("M6_LIVE_MODEL_TARGET_ATTESTATION_INVALID", "target environment attestation is malformed", cause);
  }
  const nowMs = Number(now());
  if (targetEnvironmentAttestation?.schemaId !== TARGET_ATTESTATION_SCHEMA_ID
    || Object.entries(targetEnvironmentAttestation ?? {})
      .some(([key, value]) => key.endsWith("Hash") && !validHash(value))
    || !validHash(targetEnvironmentAttestation?.attestationHash)
    || derivedAttestation.attestationHash !== targetEnvironmentAttestation.attestationHash
    || !Number.isFinite(nowMs)
    || Date.parse(targetEnvironmentAttestation.capturedAt) > nowMs
    || Date.parse(targetEnvironmentAttestation.expiresAt) <= nowMs) {
    fail("M6_LIVE_MODEL_TARGET_ATTESTATION_INVALID", "target environment attestation is drifted, future-dated, or expired");
  }

  const provenanceBody = {
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
  return Object.freeze({
    dependencyRoot: root,
    installed,
    runtimeDependencyQualificationHash: dependencyHash,
    targetEnvironmentAttestationHash: targetEnvironmentAttestation.attestationHash,
    provenanceHash: sha256(`xw.m6-live-model-adapter-provenance.v1:${canonicalJson(provenanceBody)}`),
  });
}

function contentDigest(message) {
  return sha256(`xw.m6-live-model-provider-content.v1:${message}`);
}

async function providerRequest({ fetchImpl, apiKey, model, kind, sample, monotonicNow, requestTimeoutMs }) {
  const nonce = sha256(`xw.m6-live-model-qualification-nonce.v1:${kind}:${sample}`);
  const isTool = kind === "tool";
  const request = {
    model,
    messages: [{
      role: "user",
      content: isTool
        ? `Call ${M6_LIVE_MODEL_DUMMY_TOOL_NAME} exactly once with nonce ${nonce}. Do not answer in natural language.`
        : `Reply with exactly XW_M6_QUALIFICATION_OK_${sample}.`,
    }],
    temperature: 0,
    thinking: { type: "disabled" },
    max_tokens: isTool ? 128 : 32,
    stream: false,
    ...(isTool ? {
      tools: [{
        type: "function",
        function: {
          name: M6_LIVE_MODEL_DUMMY_TOOL_NAME,
          description: "Provider qualification no-op. It has no implementation and causes no external effect.",
          strict: true,
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { nonce: { type: "string", enum: [nonce] } },
            required: ["nonce"],
          },
        },
      }],
      tool_choice: { type: "function", function: { name: M6_LIVE_MODEL_DUMMY_TOOL_NAME } },
    } : {}),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  timer.unref?.();
  const started = monotonicNow();
  let response;
  try {
    response = await fetchImpl(DEEPSEEK_OPENAI_CHAT_COMPLETIONS_ENDPOINT, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } catch {
    // Transport errors are deliberately not retained as `cause`: fetch
    // implementations may include authorization headers in their error text.
    clearTimeout(timer);
    fail("M6_LIVE_MODEL_HTTP_FAILURE", "DeepSeek qualification request failed");
  }
  if (!response || response.url !== DEEPSEEK_OPENAI_CHAT_COMPLETIONS_ENDPOINT) {
    clearTimeout(timer);
    fail("M6_LIVE_MODEL_ENDPOINT_MISMATCH", "provider response was not bound to the exact official endpoint");
  }
  if (response.status !== 200) {
    clearTimeout(timer);
    fail("M6_LIVE_MODEL_HTTP_FAILURE", `DeepSeek qualification request returned HTTP ${Number(response.status) || 0}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    clearTimeout(timer);
    fail("M6_LIVE_MODEL_HTTP_FAILURE", "DeepSeek qualification response was not valid JSON");
  }
  clearTimeout(timer);
  const latencyMs = monotonicNow() - started;
  if (!Number.isFinite(latencyMs) || latencyMs < 0) fail("M6_LIVE_MODEL_CLOCK_INVALID", "qualification monotonic clock is invalid");
  if (payload?.model !== model) fail("M6_LIVE_MODEL_MODEL_MISMATCH", "DeepSeek response model did not match the sealed requested model");
  const message = payload?.choices?.[0]?.message;
  if (!message || typeof message !== "object") fail("M6_LIVE_MODEL_RESPONSE_INVALID", "DeepSeek response omitted the assistant message");
  if (isTool) {
    const calls = message.tool_calls;
    if (!Array.isArray(calls) || calls.length !== 1 || calls[0]?.type !== "function"
      || calls[0]?.function?.name !== M6_LIVE_MODEL_DUMMY_TOOL_NAME) {
      fail("M6_LIVE_MODEL_TOOL_MISMATCH", "DeepSeek response did not select the exact zero-effect qualification function");
    }
    let args;
    try { args = JSON.parse(calls[0].function.arguments); } catch { /* handled below */ }
    if (!hasOnlyKeys(args, ["nonce"]) || args.nonce !== nonce) {
      fail("M6_LIVE_MODEL_TOOL_MISMATCH", "DeepSeek qualification function arguments were not exact");
    }
    return Object.freeze({ model, latencyMs, responseHash: contentDigest(calls[0].function.arguments), zeroEffect: true });
  }
  if (typeof message.content !== "string" || message.content.trim() !== `XW_M6_QUALIFICATION_OK_${sample}` || message.tool_calls !== undefined) {
    fail("M6_LIVE_MODEL_RESPONSE_INVALID", "DeepSeek health response content was invalid");
  }
  return Object.freeze({ model, latencyMs, responseHash: contentDigest(message.content) });
}

function evidenceBody(kind, details, { capturedAt, expiresAt }) {
  return {
    schemaId: `xw.m6-live-model-${kind}-health.v1`,
    status: "PASS",
    provider: SEALED_LIVE_PROVIDER,
    model: DEEPSEEK_QUALIFIED_MODEL,
    endpointHash: sha256(DEEPSEEK_OPENAI_BASE_URL),
    requestEndpointHash: sha256(DEEPSEEK_OPENAI_CHAT_COMPLETIONS_ENDPOINT),
    secretMaterialPresent: false,
    capturedAt,
    expiresAt,
    ...details,
  };
}

export async function qualifyDeepSeekLiveModel({
  execute = false,
  dependencyRoot,
  runtimeDependencyQualification,
  targetEnvironmentAttestation,
  environment = {},
  fetchImpl = globalThis.fetch,
  monotonicNow = () => performance.now(),
  now = Date.now,
  warmSampleCount = M6_LIVE_MODEL_WARM_SAMPLE_COUNT,
  requestTimeoutMs = M6_LIVE_MODEL_REQUEST_TIMEOUT_MS,
} = {}) {
  const bindings = validateLiveModelQualificationBindings({
    dependencyRoot, runtimeDependencyQualification, targetEnvironmentAttestation, now,
  });
  if (!execute) {
    return Object.freeze({
      status: "PREFLIGHT_PASS",
      executeRequired: true,
      networkAccessed: false,
      provider: SEALED_LIVE_PROVIDER,
      model: DEEPSEEK_QUALIFIED_MODEL,
      endpointHash: sha256(DEEPSEEK_OPENAI_BASE_URL),
      requestEndpointHash: sha256(DEEPSEEK_OPENAI_CHAT_COMPLETIONS_ENDPOINT),
      credentialRef: SEALED_CREDENTIAL_REF,
      runtimeDependencyQualificationHash: bindings.runtimeDependencyQualificationHash,
      targetEnvironmentAttestationHash: bindings.targetEnvironmentAttestationHash,
      adapterIntegrityHash: bindings.installed.integrityHash,
    });
  }
  if (warmSampleCount !== M6_LIVE_MODEL_WARM_SAMPLE_COUNT) {
    fail("M6_LIVE_MODEL_SAMPLE_COUNT_INVALID", `live qualification requires exactly ${M6_LIVE_MODEL_WARM_SAMPLE_COUNT} warm samples`);
  }
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < M6_LIVE_MODEL_FRAME_TTL_MS || requestTimeoutMs > 60_000) {
    fail("M6_LIVE_MODEL_TIMEOUT_INVALID", "provider request timeout is outside the sealed qualification bounds");
  }
  if (typeof fetchImpl !== "function") fail("M6_LIVE_MODEL_HTTP_INVALID", "execute requires an HTTP fetch implementation");
  const apiKey = validateApiKey(environment);
  const cold = await providerRequest({
    fetchImpl, apiKey, model: DEEPSEEK_QUALIFIED_MODEL, kind: "cold", sample: 0, monotonicNow, requestTimeoutMs,
  });
  const warm = [];
  for (let sample = 0; sample < warmSampleCount; sample += 1) {
    warm.push(await providerRequest({
      fetchImpl, apiKey, model: DEEPSEEK_QUALIFIED_MODEL, kind: "warm", sample, monotonicNow, requestTimeoutMs,
    }));
  }
  const tool = await providerRequest({
    fetchImpl, apiKey, model: DEEPSEEK_QUALIFIED_MODEL, kind: "tool", sample: 0, monotonicNow, requestTimeoutMs,
  });
  const warmLatencies = warm.map(({ latencyMs }) => latencyMs);
  const warmP95Ms = percentile(warmLatencies, 0.95);
  const maxWarmLatencyMs = Math.max(...warmLatencies);
  const remainingTtlMs = warmLatencies.map((latencyMs) => M6_LIVE_MODEL_FRAME_TTL_MS - latencyMs);
  const minRemainingTtlMs = Math.min(...remainingTtlMs);
  if (warmP95Ms > M6_LIVE_MODEL_WARM_P95_MAX_MS) {
    fail("M6_LIVE_MODEL_LATENCY_BOUND_EXCEEDED", "DeepSeek warm p95 exceeded the sealed provider latency bound");
  }
  if (minRemainingTtlMs < M6_LIVE_MODEL_MIN_REMAINING_TTL_MS) {
    fail("M6_LIVE_MODEL_TTL_BOUND_EXCEEDED", "DeepSeek warm qualification left less than the required frame TTL");
  }
  if (cold.latencyMs > requestTimeoutMs || tool.latencyMs > M6_LIVE_MODEL_FRAME_TTL_MS - M6_LIVE_MODEL_MIN_REMAINING_TTL_MS) {
    fail("M6_LIVE_MODEL_LATENCY_BOUND_EXCEEDED", "DeepSeek cold or tool-call health exceeded its sealed latency bound");
  }
  const capturedAtMs = Number(now());
  const expiresAtMs = Date.parse(targetEnvironmentAttestation.expiresAt);
  if (!Number.isFinite(capturedAtMs) || !Number.isFinite(expiresAtMs) || capturedAtMs >= expiresAtMs) {
    fail("M6_LIVE_MODEL_TARGET_ATTESTATION_INVALID", "target environment attestation expired during provider qualification");
  }
  const capturedAt = new Date(capturedAtMs).toISOString();
  const expiresAt = new Date(expiresAtMs).toISOString();
  const evidenceLifetime = Object.freeze({ capturedAt, expiresAt });

  const coldHealth = seal("xw.m6-live-model-cold-health.v1", evidenceBody("cold", {
    sampleCount: 1, latencyMs: cold.latencyMs, responseHash: cold.responseHash,
  }, evidenceLifetime));
  const warmHealth = seal("xw.m6-live-model-warm-health.v1", evidenceBody("warm", {
    sampleCount: warm.length,
    p95LatencyMs: warmP95Ms,
    maxLatencyMs: maxWarmLatencyMs,
    samples: warm.map(({ latencyMs, responseHash }, sampleIndex) => Object.freeze({
      sampleIndex, latencyMs, responseHash,
    })),
  }, evidenceLifetime));
  const ttlHealth = seal("xw.m6-live-model-ttl-health.v1", evidenceBody("ttl", {
    sampleCount: warm.length,
    frameTtlMs: M6_LIVE_MODEL_FRAME_TTL_MS,
    minimumRequiredRemainingTtlMs: M6_LIVE_MODEL_MIN_REMAINING_TTL_MS,
    minimumObservedRemainingTtlMs: minRemainingTtlMs,
    samples: warm.map(({ latencyMs, responseHash }, sampleIndex) => Object.freeze({
      sampleIndex,
      latencyMs,
      remainingTtlMs: M6_LIVE_MODEL_FRAME_TTL_MS - latencyMs,
      responseHash,
    })),
  }, evidenceLifetime));
  const toolCallHealth = seal("xw.m6-live-model-tool-call-health.v1", evidenceBody("tool-call", {
    sampleCount: 1,
    latencyMs: tool.latencyMs,
    responseHash: tool.responseHash,
    toolName: M6_LIVE_MODEL_DUMMY_TOOL_NAME,
    toolEffect: "NONE_NOT_EXECUTED",
    deviceAccessed: false,
    cpBrokerAccessed: false,
  }, evidenceLifetime));
  const secretInjectionAttestationHash = sha256(`xw.m6-live-model-secret-injection.v1:${canonicalJson({
    credentialRef: SEALED_CREDENTIAL_REF,
    injection: "PROCESS_ENVIRONMENT_ONLY",
    observed: true,
    persisted: false,
  })}`);
  const qualificationBody = {
    schemaId: M6_LIVE_MODEL_QUALIFICATION_SCHEMA_ID,
    status: "QUALIFIED",
    provider: SEALED_LIVE_PROVIDER,
    model: DEEPSEEK_QUALIFIED_MODEL,
    endpointHash: sha256(DEEPSEEK_OPENAI_BASE_URL),
    requestEndpointHash: sha256(DEEPSEEK_OPENAI_CHAT_COMPLETIONS_ENDPOINT),
    adapterIntegrityHash: bindings.installed.integrityHash,
    provenanceHash: bindings.provenanceHash,
    runtimeDependencyQualificationHash: bindings.runtimeDependencyQualificationHash,
    targetEnvironmentAttestationHash: bindings.targetEnvironmentAttestationHash,
    coldHealthHash: coldHealth.contentHash,
    warmHealthHash: warmHealth.contentHash,
    ttlHealthHash: ttlHealth.contentHash,
    toolCallHealthHash: toolCallHealth.contentHash,
    secretInjectionAttestationHash,
    secretMaterialPresent: false,
    gateFEligible: true,
    capturedAt,
    expiresAt,
  };
  const qualification = seal(M6_LIVE_MODEL_QUALIFICATION_SCHEMA_ID, qualificationBody);
  const profileBody = {
    schemaId: "xw.m6-live-model-profile.v1",
    status: "QUALIFIED",
    provider: SEALED_LIVE_PROVIDER,
    model: DEEPSEEK_QUALIFIED_MODEL,
    exactVersion: DEEPSEEK_QUALIFIED_MODEL,
    adapterPackage: SEALED_ADAPTER_PACKAGE,
    adapterVersion: SEALED_ADAPTER_VERSION,
    contextWindow: 64_000,
    maxTokens: 4_096,
    streamIdleTimeoutMs: 30_000,
    thinking: "disabled",
    reasoningEffort: "off",
    credentialRef: SEALED_CREDENTIAL_REF,
    license: "MIT",
    secretMaterialPresent: false,
    deploymentSecretInjectionRequired: true,
    adapterIntegrityHash: bindings.installed.integrityHash,
    adapterSourceHash: bindings.installed.sourceHash,
    licenseHash: bindings.installed.licenseHash,
    endpointHash: qualificationBody.endpointHash,
    requestEndpointHash: qualificationBody.requestEndpointHash,
    provenanceHash: bindings.provenanceHash,
    qualificationHash: qualification.contentHash,
    toolCallHealthHash: toolCallHealth.contentHash,
    warmHealthHash: warmHealth.contentHash,
    coldHealthHash: coldHealth.contentHash,
    ttlHealthHash: ttlHealth.contentHash,
    secretInjectionAttestationHash,
    runtimeDependencyQualificationHash: bindings.runtimeDependencyQualificationHash,
    targetEnvironmentAttestationHash: bindings.targetEnvironmentAttestationHash,
    runtimeAttestationHashes: [
      bindings.runtimeDependencyQualificationHash,
      bindings.targetEnvironmentAttestationHash,
    ],
    capturedAt,
    expiresAt,
    gateFEligible: true,
  };
  const profile = Object.freeze({ ...profileBody, contentHash: deriveLiveModelProfileHash(profileBody) });
  const validation = validateQualifiedLiveModelProfile(profile, {
    installed: bindings.installed,
    runtimeEndpoint: DEEPSEEK_OPENAI_BASE_URL,
    expectedContentHash: profile.contentHash,
    requiredRuntimeAttestationHash: bindings.runtimeDependencyQualificationHash,
  });
  if (!validation.ok) fail("M6_LIVE_MODEL_PROFILE_INVALID", `generated live model profile failed validation: ${validation.errors.join(",")}`);
  const result = Object.freeze({ status: "QUALIFIED", networkAccessed: true, coldHealth, warmHealth, ttlHealth, toolCallHealth, qualification, profile });
  const bundleValidation = validateQualifiedLiveModelBundle({
    profile, qualification, coldHealth, warmHealth, ttlHealth, toolCallHealth,
  }, {
    installed: bindings.installed,
    runtimeEndpoint: DEEPSEEK_OPENAI_BASE_URL,
    expectedProfileHash: profile.contentHash,
    requiredRuntimeDependencyQualificationHash: bindings.runtimeDependencyQualificationHash,
    requiredTargetEnvironmentAttestationHash: bindings.targetEnvironmentAttestationHash,
    now: capturedAtMs,
  });
  if (!bundleValidation.ok) {
    fail("M6_LIVE_MODEL_BUNDLE_INVALID", `generated live model evidence failed deep validation: ${bundleValidation.errors.join(",")}`);
  }
  if (JSON.stringify(result).includes(apiKey)) fail("M6_LIVE_MODEL_SECRET_LEAK", "qualification output contained credential material");
  return result;
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function writeLiveModelQualificationArtifacts({ outputRoot, dependencyRoot, result } = {}) {
  if (typeof outputRoot !== "string" || !isAbsolute(outputRoot) || result?.status !== "QUALIFIED") {
    fail("M6_LIVE_MODEL_OUTPUT_INVALID", "qualified artifacts require an absolute output root and a completed result");
  }
  const root = resolve(outputRoot);
  const immutableRoot = realpathSync(dependencyRoot);
  if (inside(immutableRoot, root)) fail("M6_LIVE_MODEL_OUTPUT_INVALID", "qualification artifacts must remain outside the dependency layer");
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) fail("M6_LIVE_MODEL_OUTPUT_INVALID", "qualification output root must not be a symbolic link");
  mkdirSync(root, { recursive: true });
  const realRoot = realpathSync(root);
  const records = [result.coldHealth, result.warmHealth, result.ttlHealth, result.toolCallHealth, result.qualification, result.profile];
  const paths = {};
  for (const record of records) {
    assertHash(record.contentHash, "M6_LIVE_MODEL_OUTPUT_INVALID", "artifact content hash is invalid");
    const { contentHash, ...body } = record;
    if (sha256(`${record.schemaId}:${canonicalJson(body)}`) !== contentHash) {
      fail("M6_LIVE_MODEL_OUTPUT_INVALID", "artifact body does not match its content hash");
    }
    const path = join(realRoot, `${record.contentHash}.json`);
    const serialized = `${JSON.stringify(record, null, 2)}\n`;
    if (/"(?:apiKey|authorization|credentialValue|secretValue)"\s*:|\bBearer\s+/iu.test(serialized)) {
      fail("M6_LIVE_MODEL_SECRET_LEAK", "qualification artifact contained credential-shaped material");
    }
    if (existsSync(path)) {
      if (readFileSync(path, "utf8") !== serialized) fail("M6_LIVE_MODEL_OUTPUT_COLLISION", "content-addressed artifact already exists with different bytes");
    } else {
      writeFileSync(path, serialized, { flag: "wx", mode: 0o600 });
    }
    paths[record.schemaId] = path;
  }
  return Object.freeze({ root: realRoot, profileHash: result.profile.contentHash, paths: Object.freeze(paths) });
}
