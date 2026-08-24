import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { deriveTargetEnvironmentAttestation } from "../../../packages/kernel/lib/m6-live-grounding.mjs";
import { canonicalJson } from "../src/canonical-json.mjs";
import {
  DEEPSEEK_OPENAI_CHAT_COMPLETIONS_ENDPOINT,
  DEEPSEEK_QUALIFIED_MODEL,
  M6_LIVE_MODEL_DUMMY_TOOL_NAME,
  M6_LIVE_MODEL_WARM_SAMPLE_COUNT,
  deriveRuntimeDependencyQualificationHash,
  qualifyDeepSeekLiveModel,
  writeLiveModelQualificationArtifacts,
} from "../src/live-model-qualification.mjs";
import {
  computeInstalledLiveAdapterIntegrity,
  deriveLiveModelProfileHash,
  loadContentAddressedLiveModelQualificationBundle,
  loadContentAddressedLiveModelProfile,
  validateQualifiedLiveModelBundle,
  validateQualifiedLiveModelProfile,
} from "../src/live-model-profile.mjs";

const repositoryRoot = resolve(new URL("../../../", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/u, ""));
const SECRET = "sk-unit-test-secret-that-must-never-escape";
const H = "a".repeat(64);
const NOW = Date.parse("2026-08-23T16:00:00.000Z");

function fixtureBindings() {
  const installed = computeInstalledLiveAdapterIntegrity({ dependencyRoot: repositoryRoot });
  const body = {
    schemaId: "xw.m6-live-runtime-dependency-qualification.v1",
    status: "DEPENDENCY_LAYER_QUALIFIED",
    scope: "M6_C1_RUNTIME_DEPENDENCIES_ONLY",
    layerHash: H,
    adapterPackage: installed.packageName,
    adapterVersion: installed.packageVersion,
    adapterIntegrityHash: installed.integrityHash,
    providerHealthEvaluated: false,
    secretMaterialPresent: false,
    gateFEligible: false,
  };
  const runtimeDependencyQualification = {
    ...body,
    qualificationHash: deriveRuntimeDependencyQualificationHash(body),
  };
  const targetEnvironmentAttestation = deriveTargetEnvironmentAttestation({
    appPackageHash: H,
    appBuildHash: H,
    signingHash: H,
    osBuildHash: H,
    displayHash: H,
    localeThemeHash: H,
    imeHash: H,
    accessibilityHash: H,
    accountIsolationHash: H,
    capturedAt: "2026-08-23T15:59:00.000Z",
    expiresAt: "2026-08-23T16:10:00.000Z",
  });
  return { dependencyRoot: repositoryRoot, runtimeDependencyQualification, targetEnvironmentAttestation };
}

function providerFixture({
  latencyFor = () => 10,
  status = 200,
  responseModel = DEEPSEEK_QUALIFIED_MODEL,
  toolName = M6_LIVE_MODEL_DUMMY_TOOL_NAME,
  throwMessage = null,
  responseUrl = DEEPSEEK_OPENAI_CHAT_COMPLETIONS_ENDPOINT,
} = {}) {
  let clock = 0;
  let calls = 0;
  const requests = [];
  return {
    requests,
    monotonicNow: () => clock,
    async fetch(url, options) {
      const index = calls++;
      const request = JSON.parse(options.body);
      requests.push({ url, options, request });
      clock += latencyFor(index, request);
      if (throwMessage) throw new Error(throwMessage);
      const isTool = Array.isArray(request.tools);
      const nonce = request.tools?.[0]?.function?.parameters?.properties?.nonce?.enum?.[0];
      return {
        url: responseUrl,
        status,
        async json() {
          return {
            model: responseModel,
            choices: [{
              message: isTool ? {
                role: "assistant",
                content: null,
                tool_calls: [{
                  id: "call_qualification",
                  type: "function",
                  function: { name: toolName, arguments: JSON.stringify({ nonce }) },
                }],
              } : {
                role: "assistant",
                content: /XW_M6_QUALIFICATION_OK_(\d+)/u.exec(request.messages[0].content)?.[0],
              },
            }],
          };
        },
      };
    },
  };
}

async function executeWith(provider, overrides = {}) {
  return qualifyDeepSeekLiveModel({
    ...fixtureBindings(),
    execute: true,
    environment: { DEEPSEEK_API_KEY: SECRET },
    fetchImpl: provider.fetch,
    monotonicNow: provider.monotonicNow,
    now: () => NOW,
    ...overrides,
  });
}

function sealRecord(record, changes = {}) {
  const { contentHash: _ignored, ...body } = { ...record, ...changes };
  return Object.freeze({
    ...body,
    contentHash: createHash("sha256").update(`${body.schemaId}:${canonicalJson(body)}`).digest("hex"),
  });
}

function sealProfile(profile, changes = {}) {
  const { contentHash: _ignored, ...body } = { ...profile, ...changes };
  return Object.freeze({ ...body, contentHash: deriveLiveModelProfileHash(body) });
}

function resultBundle(result) {
  return {
    profile: result.profile,
    qualification: result.qualification,
    coldHealth: result.coldHealth,
    warmHealth: result.warmHealth,
    ttlHealth: result.ttlHealth,
    toolCallHealth: result.toolCallHealth,
  };
}

function rebindWarmEvidence(result, warmHealth) {
  const qualification = sealRecord(result.qualification, { warmHealthHash: warmHealth.contentHash });
  const profile = sealProfile(result.profile, {
    warmHealthHash: warmHealth.contentHash,
    qualificationHash: qualification.contentHash,
  });
  return { ...resultBundle(result), profile, qualification, warmHealth };
}

test("default preflight is local-only and validates exact adapter/dependency/environment bindings", async () => {
  let fetchCalls = 0;
  const result = await qualifyDeepSeekLiveModel({
    ...fixtureBindings(),
    fetchImpl: async () => { fetchCalls += 1; throw new Error("network forbidden"); },
    now: () => NOW,
  });
  assert.equal(result.status, "PREFLIGHT_PASS");
  assert.equal(result.networkAccessed, false);
  assert.equal(result.executeRequired, true);
  assert.equal(fetchCalls, 0);
  assert.doesNotMatch(JSON.stringify(result), /sk-|secret-that/u);
});

test("execute produces four independent health hashes and a validator-compatible content-addressed profile", async (t) => {
  const provider = providerFixture();
  const result = await executeWith(provider);
  assert.equal(provider.requests.length, M6_LIVE_MODEL_WARM_SAMPLE_COUNT + 2);
  assert.equal(new Set([
    result.coldHealth.contentHash,
    result.warmHealth.contentHash,
    result.ttlHealth.contentHash,
    result.toolCallHealth.contentHash,
  ]).size, 4);
  assert.equal(result.toolCallHealth.toolEffect, "NONE_NOT_EXECUTED");
  assert.equal(result.toolCallHealth.deviceAccessed, false);
  assert.equal(result.toolCallHealth.cpBrokerAccessed, false);
  assert.equal(validateQualifiedLiveModelProfile(result.profile).ok, true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET, "u"));
  for (const { url, options, request } of provider.requests) {
    assert.equal(url, DEEPSEEK_OPENAI_CHAT_COMPLETIONS_ENDPOINT);
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, `Bearer ${SECRET}`);
    assert.equal(request.model, DEEPSEEK_QUALIFIED_MODEL);
    assert.deepEqual(request.thinking, { type: "disabled" });
  }
  const toolRequest = provider.requests.at(-1).request;
  assert.deepEqual(toolRequest.tool_choice, { type: "function", function: { name: M6_LIVE_MODEL_DUMMY_TOOL_NAME } });
  assert.equal(toolRequest.tools.length, 1);

  const outputRoot = mkdtempSync(join(tmpdir(), "xw-m6-live-model-profile-"));
  t.after(() => rmSync(outputRoot, { recursive: true, force: true }));
  const written = writeLiveModelQualificationArtifacts({ outputRoot, dependencyRoot: repositoryRoot, result });
  const loaded = loadContentAddressedLiveModelProfile({ qualificationRoot: outputRoot, expectedContentHash: result.profile.contentHash });
  assert.deepEqual(loaded, result.profile);
  const bindings = fixtureBindings();
  const loadedBundle = loadContentAddressedLiveModelQualificationBundle({
    qualificationRoot: outputRoot,
    expectedProfileHash: result.profile.contentHash,
    installed: computeInstalledLiveAdapterIntegrity({ dependencyRoot: repositoryRoot }),
    runtimeEndpoint: "https://api.deepseek.com",
    requiredRuntimeDependencyQualificationHash: bindings.runtimeDependencyQualification.qualificationHash,
    requiredTargetEnvironmentAttestationHash: bindings.targetEnvironmentAttestation.attestationHash,
    requiredLiveWindowExpiresAt: "2026-08-23T16:09:00.000Z",
    now: () => NOW,
  });
  assert.deepEqual(loadedBundle, resultBundle(result));
  assert.equal(Object.isFrozen(loadedBundle.warmHealth.samples[0]), true);
  assert.equal(written.profileHash, result.profile.contentHash);
  for (const path of Object.values(written.paths)) {
    assert.doesNotMatch(readFileSync(path, "utf8"), new RegExp(SECRET, "u"));
  }
});

test("transport and HTTP failures redact credential material", async () => {
  const thrown = providerFixture({ throwMessage: `transport leaked ${SECRET}` });
  await assert.rejects(() => executeWith(thrown), (error) => {
    assert.equal(error.code, "M6_LIVE_MODEL_HTTP_FAILURE");
    assert.doesNotMatch(`${error.stack}\n${String(error.cause)}`, new RegExp(SECRET, "u"));
    return true;
  });
  await assert.rejects(() => executeWith(providerFixture({ status: 429 })), (error) => {
    assert.equal(error.code, "M6_LIVE_MODEL_HTTP_FAILURE");
    assert.match(error.message, /HTTP 429/u);
    assert.doesNotMatch(error.message, new RegExp(SECRET, "u"));
    return true;
  });
});

test("model and dummy-tool mismatches fail closed", async () => {
  await assert.rejects(() => executeWith(providerFixture({ responseModel: "deepseek-reasoner" })), {
    code: "M6_LIVE_MODEL_MODEL_MISMATCH",
  });
  await assert.rejects(() => executeWith(providerFixture({ toolName: "phone_act" })), {
    code: "M6_LIVE_MODEL_TOOL_MISMATCH",
  });
  await assert.rejects(() => executeWith(providerFixture({ responseUrl: "https://api.deepseek.com/v1/chat/completions" })), {
    code: "M6_LIVE_MODEL_ENDPOINT_MISMATCH",
  });
});

test("warm p95, per-sample TTL, timeout, and sample count remain frozen", async () => {
  await assert.rejects(() => executeWith(providerFixture({ latencyFor: () => 2_501 })), {
    code: "M6_LIVE_MODEL_LATENCY_BOUND_EXCEEDED",
  });
  await assert.rejects(() => executeWith(providerFixture({
    latencyFor: (index) => index === 50 ? 4_001 : 1,
  })), { code: "M6_LIVE_MODEL_TTL_BOUND_EXCEEDED" });
  await assert.rejects(() => executeWith(providerFixture(), { warmSampleCount: 99 }), {
    code: "M6_LIVE_MODEL_SAMPLE_COUNT_INVALID",
  });
  await assert.rejects(() => executeWith(providerFixture(), { requestTimeoutMs: 4_999 }), {
    code: "M6_LIVE_MODEL_TIMEOUT_INVALID",
  });
  await assert.rejects(() => executeWith(providerFixture({
    latencyFor: (index) => index === M6_LIVE_MODEL_WARM_SAMPLE_COUNT + 1 ? 4_001 : 1,
  })), { code: "M6_LIVE_MODEL_LATENCY_BOUND_EXCEEDED" });
});

test("content addressing detects mutation and binding validation rejects drift/expiry", async (t) => {
  const result = await executeWith(providerFixture());
  const outputRoot = mkdtempSync(join(tmpdir(), "xw-m6-live-model-addressing-"));
  t.after(() => rmSync(outputRoot, { recursive: true, force: true }));
  assert.throws(() => writeLiveModelQualificationArtifacts({
    outputRoot,
    dependencyRoot: repositoryRoot,
    result: { ...result, coldHealth: { ...result.coldHealth, sampleCount: 2 } },
  }), { code: "M6_LIVE_MODEL_OUTPUT_INVALID" });
  writeLiveModelQualificationArtifacts({ outputRoot, dependencyRoot: repositoryRoot, result });
  const profilePath = join(outputRoot, `${result.profile.contentHash}.json`);
  const original = JSON.parse(readFileSync(profilePath, "utf8"));
  writeFileSync(profilePath, `${JSON.stringify({ ...original, model: "mutated" })}\n`);
  assert.throws(() => loadContentAddressedLiveModelProfile({ qualificationRoot: outputRoot, expectedContentHash: result.profile.contentHash }), {
    code: "M6_LIVE_PROFILE_CONTENT_MISMATCH",
  });

  const bindings = fixtureBindings();
  await assert.rejects(() => qualifyDeepSeekLiveModel({
    ...bindings,
    runtimeDependencyQualification: { ...bindings.runtimeDependencyQualification, adapterVersion: "latest" },
    now: () => NOW,
  }), { code: "M6_LIVE_MODEL_DEPENDENCY_QUALIFICATION_INVALID" });
  await assert.rejects(() => qualifyDeepSeekLiveModel({
    ...bindings,
    now: () => Date.parse("2026-08-23T16:10:00.000Z"),
  }), { code: "M6_LIVE_MODEL_TARGET_ATTESTATION_INVALID" });
});

test("deep validation reconstructs warm and TTL aggregates and rejects consistently rehashed lies", async () => {
  const result = await executeWith(providerFixture({
    latencyFor: (index) => index > 0 && index <= M6_LIVE_MODEL_WARM_SAMPLE_COUNT ? index : 10,
  }));
  const bindings = fixtureBindings();
  const options = {
    installed: computeInstalledLiveAdapterIntegrity({ dependencyRoot: repositoryRoot }),
    runtimeEndpoint: "https://api.deepseek.com",
    expectedProfileHash: result.profile.contentHash,
    requiredRuntimeDependencyQualificationHash: bindings.runtimeDependencyQualification.qualificationHash,
    requiredTargetEnvironmentAttestationHash: bindings.targetEnvironmentAttestation.attestationHash,
    now: () => NOW,
  };
  assert.equal(validateQualifiedLiveModelBundle(resultBundle(result), options).ok, true);

  const wrongAggregate = sealRecord(result.warmHealth, {
    p95LatencyMs: result.warmHealth.p95LatencyMs + 1,
  });
  const aggregateBundle = rebindWarmEvidence(result, wrongAggregate);
  const aggregateValidation = validateQualifiedLiveModelBundle(aggregateBundle, {
    ...options,
    expectedProfileHash: aggregateBundle.profile.contentHash,
  });
  assert.equal(aggregateValidation.ok, false);
  assert.ok(aggregateValidation.errors.includes("M6_LIVE_MODEL_WARM_AGGREGATE_MISMATCH"));

  const wrongCount = sealRecord(result.warmHealth, { sampleCount: M6_LIVE_MODEL_WARM_SAMPLE_COUNT - 1 });
  const countBundle = rebindWarmEvidence(result, wrongCount);
  const countValidation = validateQualifiedLiveModelBundle(countBundle, {
    ...options,
    expectedProfileHash: countBundle.profile.contentHash,
  });
  assert.equal(countValidation.ok, false);
  assert.ok(countValidation.errors.includes("M6_LIVE_MODEL_WARM_EVIDENCE_INVALID"));

  const reboundTtl = sealRecord(result.ttlHealth, {
    samples: result.ttlHealth.samples.map((sample, index) => index === 50
      ? { ...sample, latencyMs: sample.latencyMs + 1, remainingTtlMs: sample.remainingTtlMs - 1 }
      : sample),
  });
  const reboundQualification = sealRecord(result.qualification, { ttlHealthHash: reboundTtl.contentHash });
  const reboundProfile = sealProfile(result.profile, {
    ttlHealthHash: reboundTtl.contentHash,
    qualificationHash: reboundQualification.contentHash,
  });
  const sampleValidation = validateQualifiedLiveModelBundle({
    ...resultBundle(result),
    profile: reboundProfile,
    qualification: reboundQualification,
    ttlHealth: reboundTtl,
  }, {
    ...options,
    expectedProfileHash: reboundProfile.contentHash,
  });
  assert.equal(sampleValidation.ok, false);
  assert.ok(sampleValidation.errors.includes("M6_LIVE_MODEL_SAMPLE_BINDING_MISMATCH"));
});

test("deep validation rejects zero hashes, target rebinding, stale evidence and secret-shaped extras", async () => {
  const result = await executeWith(providerFixture());
  const bindings = fixtureBindings();
  const installed = computeInstalledLiveAdapterIntegrity({ dependencyRoot: repositoryRoot });
  const baseOptions = {
    installed,
    runtimeEndpoint: "https://api.deepseek.com",
    requiredRuntimeDependencyQualificationHash: bindings.runtimeDependencyQualification.qualificationHash,
    requiredTargetEnvironmentAttestationHash: bindings.targetEnvironmentAttestation.attestationHash,
    now: () => NOW,
  };
  const ZERO = "0".repeat(64);
  const zeroQualification = sealRecord(result.qualification, { secretInjectionAttestationHash: ZERO });
  const zeroProfile = sealProfile(result.profile, {
    qualificationHash: zeroQualification.contentHash,
    secretInjectionAttestationHash: ZERO,
  });
  const zeroValidation = validateQualifiedLiveModelBundle({
    ...resultBundle(result), profile: zeroProfile, qualification: zeroQualification,
  }, { ...baseOptions, expectedProfileHash: zeroProfile.contentHash });
  assert.equal(zeroValidation.ok, false);
  assert.ok(zeroValidation.errors.includes("M6_LIVE_PROFILE_HASH_INVALID"));
  assert.ok(zeroValidation.errors.includes("M6_LIVE_MODEL_QUALIFICATION_INVALID"));

  const reboundTargetHash = "c".repeat(64);
  const targetQualification = sealRecord(result.qualification, {
    targetEnvironmentAttestationHash: reboundTargetHash,
  });
  const targetProfile = sealProfile(result.profile, {
    qualificationHash: targetQualification.contentHash,
    targetEnvironmentAttestationHash: reboundTargetHash,
    runtimeAttestationHashes: [result.profile.runtimeDependencyQualificationHash, reboundTargetHash],
  });
  const targetValidation = validateQualifiedLiveModelBundle({
    ...resultBundle(result), profile: targetProfile, qualification: targetQualification,
  }, { ...baseOptions, expectedProfileHash: targetProfile.contentHash });
  assert.equal(targetValidation.ok, false);
  assert.ok(targetValidation.errors.includes("M6_LIVE_TARGET_ATTESTATION_MISMATCH"));

  const staleValidation = validateQualifiedLiveModelBundle(resultBundle(result), {
    ...baseOptions,
    expectedProfileHash: result.profile.contentHash,
    now: () => Date.parse(result.profile.expiresAt),
  });
  assert.equal(staleValidation.ok, false);
  assert.ok(staleValidation.errors.includes("M6_LIVE_PROFILE_STALE"));

  const oversizedWindow = validateQualifiedLiveModelBundle(resultBundle(result), {
    ...baseOptions,
    expectedProfileHash: result.profile.contentHash,
    requiredLiveWindowExpiresAt: "2026-08-23T16:10:00.001Z",
  });
  assert.equal(oversizedWindow.ok, false);
  assert.ok(oversizedWindow.errors.includes("M6_LIVE_WINDOW_EXCEEDS_MODEL_QUALIFICATION"));

  const secretExtraWarm = sealRecord(result.warmHealth, { authorization: "Bearer forbidden" });
  const secretExtraBundle = rebindWarmEvidence(result, secretExtraWarm);
  const secretExtraValidation = validateQualifiedLiveModelBundle(secretExtraBundle, {
    ...baseOptions,
    expectedProfileHash: secretExtraBundle.profile.contentHash,
  });
  assert.equal(secretExtraValidation.ok, false);
  assert.ok(secretExtraValidation.errors.includes("M6_LIVE_MODEL_EVIDENCE_SCHEMA_INVALID"));
});

test("deep content-address loading fails closed on missing or mutated child evidence", async (t) => {
  const result = await executeWith(providerFixture());
  const missingRoot = mkdtempSync(join(tmpdir(), "xw-m6-live-model-missing-"));
  const mutatedRoot = mkdtempSync(join(tmpdir(), "xw-m6-live-model-mutated-"));
  t.after(() => {
    rmSync(missingRoot, { recursive: true, force: true });
    rmSync(mutatedRoot, { recursive: true, force: true });
  });
  writeLiveModelQualificationArtifacts({ outputRoot: missingRoot, dependencyRoot: repositoryRoot, result });
  rmSync(join(missingRoot, `${result.warmHealth.contentHash}.json`));
  assert.throws(() => loadContentAddressedLiveModelQualificationBundle({
    qualificationRoot: missingRoot,
    expectedProfileHash: result.profile.contentHash,
    now: () => NOW,
  }), { code: "M6_LIVE_PROFILE_ARTIFACT_UNAVAILABLE" });

  writeLiveModelQualificationArtifacts({ outputRoot: mutatedRoot, dependencyRoot: repositoryRoot, result });
  const warmPath = join(mutatedRoot, `${result.warmHealth.contentHash}.json`);
  writeFileSync(warmPath, `${JSON.stringify({ ...result.warmHealth, p95LatencyMs: 0 }, null, 2)}\n`);
  assert.throws(() => loadContentAddressedLiveModelQualificationBundle({
    qualificationRoot: mutatedRoot,
    expectedProfileHash: result.profile.contentHash,
    now: () => NOW,
  }), { code: "M6_LIVE_PROFILE_CONTENT_MISMATCH" });
});
