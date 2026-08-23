import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import test from "node:test";

import {
  RECOVERABLE_PUBLICATION_CUTS,
} from "./lib/recoverable-create-only-publication.mjs";
import {
  LIVE_MODEL_COLD_HEALTH_SCHEMA_ID,
  LIVE_MODEL_QUALIFICATION_SCHEMA_ID,
  LIVE_MODEL_TOOL_HEALTH_SCHEMA_ID,
  LIVE_MODEL_TTL_HEALTH_SCHEMA_ID,
  LIVE_MODEL_WARM_HEALTH_SCHEMA_ID,
  SEALED_ADAPTER_PACKAGE,
  SEALED_ADAPTER_VERSION,
  SEALED_CREDENTIAL_REF,
  SEALED_LIVE_MODEL,
  SEALED_LIVE_PROVIDER,
  SEALED_LIVE_PROVIDER_BASE_URL,
  SEALED_LIVE_PROVIDER_REQUEST_URL,
  deriveLiveModelProfileHash,
} from "../../integrations/dsh-xw/src/live-model-profile.mjs";
import { deriveTargetEnvironmentAttestation } from "../../packages/kernel/lib/m6-live-grounding.mjs";
import {
  deriveM64TargetEnvironmentCommandRegistryHash,
} from "../../services/control-plane/apps/xiaowei/m6-target-environment-qualification.mjs";
import { canonicalJson, sha256 } from "../../services/control-plane/control-plane/lib/canonical.mjs";
import {
  M64_CURRENT_STATE_GUARD_POLICY_SCHEMA_ID,
  M64_EXPECTATION_INDEX_SCHEMA_ID,
  M64_INDEPENDENT_ORACLE_POLICY_SCHEMA_ID,
  M64_TARGET_SELECTOR_POLICY_SCHEMA_ID,
  deriveM64CurrentStateGuardPolicyHash,
  deriveM64ExpectationIndexHash,
  deriveM64IndependentActorHash,
  deriveM64IndependentOraclePolicyHash,
  deriveM64TargetSelectorPolicyHash,
  loadM64ProductionDependencies,
} from "../../services/control-plane/control-plane/lib/m6-live-production-dependencies.mjs";
import {
  loadM6GateFArtifactCatalog,
  loadM6GateFArtifactInventory,
  validateM6GateFArtifactCatalogCandidate,
} from "../../services/control-plane/control-plane/lib/m6-gate-f-operations.mjs";
import { M6_GATE_V2_LOCK_KINDS } from "../../services/control-plane/control-plane/lib/m6-live-gate-v2.mjs";
import {
  M64_FINAL_ASSEMBLER_INPUT_SCHEMA_ID,
  M64_FINAL_RUNTIME_BINDING_KEYS,
  assembleM64FinalProductionArtifacts,
  parseM64FinalAssemblerArgs,
  planM64FinalProductionArtifacts,
} from "./m6-4-production-release-assembler.mjs";

const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const CAPTURED_AT = "2029-12-31T23:30:00.000Z";
const EXPIRES_AT = "2030-01-01T05:30:00.000Z";
const RELEASE_ID = "m6-c1-final-test";
const SOURCE_COMMIT = "a".repeat(40);
const CLOSURE_HASH = "b".repeat(64);
const H = (value) => sha256(String(value));
const PURPOSE_FILES = Object.freeze([
  ["M6_4_SHADOW", "m6_4_shadow.json"],
  ["M6_4_HOT_CLOSE", "m6_4_hot_close.json"],
  ["M6_4_ACTION_SMOKE", "m6_4_action_smoke.json"],
  ["M6_4_RELIABILITY", "m6_4_reliability.json"],
  ["M6_4_SMOOTH", "m6_4_smooth.json"],
]);
const STATE_FIELDS = Object.freeze([
  "appPackageHash", "blockId", "displayHash", "environmentAttestationHash", "focusHash",
  "frameId", "pageFingerprint", "rotation", "slotSpecHash", "uiStateGeneration",
]);

function writeBytes(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return Object.freeze({ path, sha256: sha256(bytes) });
}

function writeJson(path, value) {
  return writeBytes(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

function withHash(raw, derive, key) {
  return Object.freeze({ ...raw, [key]: derive(raw) });
}

function sealModelRecord(body) {
  return Object.freeze({ ...body, contentHash: sha256(`${body.schemaId}:${canonicalJson(body)}`) });
}

function writeQualifiedModelBundle({ root, targetEnvironmentAttestationHash }) {
  const endpointHash = H(SEALED_LIVE_PROVIDER_BASE_URL);
  const requestEndpointHash = H(SEALED_LIVE_PROVIDER_REQUEST_URL);
  const runtimeDependencyQualificationHash = H("runtime-dependency-qualification");
  const adapterIntegrityHash = H("adapter-integrity");
  const provenanceHash = H("adapter-provenance");
  const secretInjectionAttestationHash = sha256(`xw.m6-live-model-secret-injection.v1:${canonicalJson({
    credentialRef: SEALED_CREDENTIAL_REF,
    injection: "PROCESS_ENVIRONMENT_ONLY",
    observed: true,
    persisted: false,
  })}`);
  const common = {
    status: "PASS",
    provider: SEALED_LIVE_PROVIDER,
    model: SEALED_LIVE_MODEL,
    endpointHash,
    requestEndpointHash,
    secretMaterialPresent: false,
    capturedAt: CAPTURED_AT,
    expiresAt: EXPIRES_AT,
  };
  const warmSamples = Array.from({ length: 100 }, (_, sampleIndex) => ({
    sampleIndex,
    latencyMs: 10,
    responseHash: H(`warm-${sampleIndex}`),
  }));
  const coldHealth = sealModelRecord({
    schemaId: LIVE_MODEL_COLD_HEALTH_SCHEMA_ID,
    ...common,
    sampleCount: 1,
    latencyMs: 10,
    responseHash: H("cold"),
  });
  const warmHealth = sealModelRecord({
    schemaId: LIVE_MODEL_WARM_HEALTH_SCHEMA_ID,
    ...common,
    sampleCount: 100,
    p95LatencyMs: 10,
    maxLatencyMs: 10,
    samples: warmSamples,
  });
  const ttlHealth = sealModelRecord({
    schemaId: LIVE_MODEL_TTL_HEALTH_SCHEMA_ID,
    ...common,
    sampleCount: 100,
    frameTtlMs: 5_000,
    minimumRequiredRemainingTtlMs: 1_000,
    minimumObservedRemainingTtlMs: 4_990,
    samples: warmSamples.map((item) => ({ ...item, remainingTtlMs: 4_990 })),
  });
  const toolCallHealth = sealModelRecord({
    schemaId: LIVE_MODEL_TOOL_HEALTH_SCHEMA_ID,
    ...common,
    sampleCount: 1,
    latencyMs: 10,
    responseHash: H("tool"),
    toolName: "xw_qualification_noop",
    toolEffect: "NONE_NOT_EXECUTED",
    deviceAccessed: false,
    cpBrokerAccessed: false,
  });
  const qualification = sealModelRecord({
    schemaId: LIVE_MODEL_QUALIFICATION_SCHEMA_ID,
    status: "QUALIFIED",
    provider: SEALED_LIVE_PROVIDER,
    model: SEALED_LIVE_MODEL,
    endpointHash,
    requestEndpointHash,
    adapterIntegrityHash,
    provenanceHash,
    runtimeDependencyQualificationHash,
    targetEnvironmentAttestationHash,
    coldHealthHash: coldHealth.contentHash,
    warmHealthHash: warmHealth.contentHash,
    ttlHealthHash: ttlHealth.contentHash,
    toolCallHealthHash: toolCallHealth.contentHash,
    secretInjectionAttestationHash,
    secretMaterialPresent: false,
    gateFEligible: true,
    capturedAt: CAPTURED_AT,
    expiresAt: EXPIRES_AT,
  });
  const profileBody = {
    schemaId: "xw.m6-live-model-profile.v1",
    status: "QUALIFIED",
    provider: SEALED_LIVE_PROVIDER,
    model: SEALED_LIVE_MODEL,
    exactVersion: SEALED_LIVE_MODEL,
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
    adapterIntegrityHash,
    adapterSourceHash: H("adapter-source"),
    licenseHash: H("license"),
    endpointHash,
    requestEndpointHash,
    provenanceHash,
    qualificationHash: qualification.contentHash,
    toolCallHealthHash: toolCallHealth.contentHash,
    warmHealthHash: warmHealth.contentHash,
    coldHealthHash: coldHealth.contentHash,
    ttlHealthHash: ttlHealth.contentHash,
    secretInjectionAttestationHash,
    runtimeDependencyQualificationHash,
    targetEnvironmentAttestationHash,
    runtimeAttestationHashes: [runtimeDependencyQualificationHash, targetEnvironmentAttestationHash],
    capturedAt: CAPTURED_AT,
    expiresAt: EXPIRES_AT,
    gateFEligible: true,
  };
  const profile = Object.freeze({ ...profileBody, contentHash: deriveLiveModelProfileHash(profileBody) });
  for (const record of [coldHealth, warmHealth, ttlHealth, toolCallHealth, qualification, profile]) {
    writeJson(join(root, `${record.contentHash}.json`), record);
  }
  return profile;
}

function publicKey(label) {
  const pair = generateKeyPairSync("ed25519");
  const pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  return Object.freeze({ keyId: label, pem, actorHash: deriveM64IndependentActorHash(pem) });
}

function testDependencies(overrides = {}) {
  return Object.freeze({
    verifyReleaseManifest: () => Object.freeze({ ok: true, mismatches: [] }),
    verifyCapabilitySeal: () => Object.freeze({
      capabilityId: "xiaowei.m6.grounded_run",
      implementationClosureHash: CLOSURE_HASH,
      tcbManifestRef: "xw.m6-grounded-run.tcb.v1",
      pathCount: 1,
    }),
    ...overrides,
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "m64-final-assembler-"));
  const releaseRoot = join(root, "immutable-release", RELEASE_ID);
  const artifactsRoot = join(root, "public-artifacts");
  const manifestRoot = join(artifactsRoot, "cohort-manifests");
  const outputRoot = join(root, "runtime-root");
  mkdirSync(releaseRoot, { recursive: true });
  mkdirSync(artifactsRoot, { recursive: true });

  writeJson(join(releaseRoot, "services", "control-plane", "apps", "xiaowei", "capabilities.json"), {
    schemaVersion: 1,
    capabilities: [{
      id: "xiaowei.m6.grounded_run",
      implementation: {
        adapter: "xiaowei",
        action: "m6_grounded_run",
        implementationClosureHash: CLOSURE_HASH,
        tcbManifestRef: "xw.m6-grounded-run.tcb.v1",
      },
    }],
  });
  const releaseManifestRef = writeJson(join(releaseRoot, "release-manifest.v1.json"), {
    schemaId: "xw.runtime.release-manifest.v1",
    releaseId: RELEASE_ID,
    sourceCommit: SOURCE_COMMIT,
  });

  const environmentAttestation = deriveTargetEnvironmentAttestation({
    appPackageHash: H("env-package"),
    appBuildHash: H("env-build"),
    signingHash: H("env-signing"),
    osBuildHash: H("env-os"),
    displayHash: H("env-display"),
    localeThemeHash: H("env-locale"),
    imeHash: H("env-ime"),
    accessibilityHash: H("env-accessibility"),
    accountIsolationHash: H("env-account"),
    capturedAt: CAPTURED_AT,
    expiresAt: EXPIRES_AT,
  });
  const environmentAttestationRef = writeJson(join(artifactsRoot, "environment", "attestation.json"), environmentAttestation);
  const environmentQualification = Object.freeze({
    schemaId: "xw.m6-environment-qualification.v1",
    status: "QUALIFIED",
    gateFEligible: true,
    alias: "01",
    effectBoundary: "READ_ONLY",
    commandRegistryHash: deriveM64TargetEnvironmentCommandRegistryHash(),
    qualifiedAttestationHashes: [environmentAttestation.attestationHash],
    sampleCount: 2,
    capturedAt: CAPTURED_AT,
    expiresAt: EXPIRES_AT,
    secretMaterialPresent: false,
    rawDeviceIdentityPresent: false,
    actionCount: 0,
  });
  const environmentQualificationRef = writeJson(join(artifactsRoot, "environment", "qualification.json"), environmentQualification);

  const boundary = JSON.parse(readFileSync(
    new URL("../../artifacts/m6-4/cohort-manifests/xw.m6-effect-boundary.v1.json", import.meta.url),
    "utf8",
  ));
  const boundaryRef = writeJson(join(artifactsRoot, "policy", "effect-boundary.json"), boundary);
  const expectationAuthor = publicKey("expectation-author-1");
  const observationActor = publicKey("observation-actor-1");
  const placeholderEnvelopeRef = writeJson(join(artifactsRoot, "expectations", "placeholder.json"), { schemaId: "test.placeholder.v1" });
  const expectationIndex = withHash({
    schemaId: M64_EXPECTATION_INDEX_SCHEMA_ID,
    entries: [{ lookupHash: H("expectation-lookup"), expectationEnvelope: placeholderEnvelopeRef }],
  }, deriveM64ExpectationIndexHash, "indexHash");
  const expectationIndexRef = writeJson(join(artifactsRoot, "expectations", "index.json"), expectationIndex);
  const observationRoot = join(artifactsRoot, "independent-observer");
  mkdirSync(join(observationRoot, "requests"), { recursive: true });
  mkdirSync(join(observationRoot, "observations"), { recursive: true });
  const oraclePolicy = withHash({
    schemaId: M64_INDEPENDENT_ORACLE_POLICY_SCHEMA_ID,
    effectBoundaryHash: boundary.boundaryHash,
    expectationIndex: expectationIndexRef,
    expectationAuthorKeyId: expectationAuthor.keyId,
    expectationAuthorPublicKey: expectationAuthor.pem,
    independentAuthorHash: expectationAuthor.actorHash,
    observationRoot,
    observationObserverKeyId: observationActor.keyId,
    observationObserverPublicKey: observationActor.pem,
    independentObserverHash: observationActor.actorHash,
    allowedSourceKinds: ["ACCOUNT_READ_SNAPSHOT", "DEVICE_READ_SNAPSHOT", "BACKEND_READ_SNAPSHOT"],
    requiredSourceKinds: ["ACCOUNT_READ_SNAPSHOT", "DEVICE_READ_SNAPSHOT", "BACKEND_READ_SNAPSHOT"],
    forbiddenSourceKinds: [
      "BROKER_ACK", "CONTROL_PLANE_LEDGER", "DSH_RESULT", "GROUNDED_ACTION_RECEIPT",
      "MODEL_OUTPUT", "SUT_RECEIPT", "TRANSPORT_RESULT",
    ],
    maxObservationAgeMs: 5_000,
  }, deriveM64IndependentOraclePolicyHash, "policyHash");
  const oraclePolicyRef = writeJson(join(artifactsRoot, "policy", "oracle.json"), oraclePolicy);

  const actionSmoke = JSON.parse(readFileSync(
    new URL("../../artifacts/m6-4/cohort-manifests/m6_4_action_smoke.json", import.meta.url),
    "utf8",
  ));
  const actionSlot = actionSmoke.scenarios[0].actionPlan.slots[0];
  const selectorPolicy = withHash({
    schemaId: M64_TARGET_SELECTOR_POLICY_SCHEMA_ID,
    effectBoundaryHash: boundary.boundaryHash,
    rules: [{
      scenarioKey: actionSmoke.scenarios[0].scenarioKey,
      slotAuthorityHash: actionSlot.slotAuthorityHash,
      targetEligibilityHash: actionSlot.targetEligibilityHash,
      requiredFeatures: { resourceHash: H("selected-resource") },
    }],
  }, deriveM64TargetSelectorPolicyHash, "policyHash");
  const selectorPolicyRef = writeJson(join(artifactsRoot, "policy", "target-selector.json"), selectorPolicy);
  const guardPolicy = withHash({
    schemaId: M64_CURRENT_STATE_GUARD_POLICY_SCHEMA_ID,
    allowedSourceClass: "SERVER_OWNED_FRESH_CAPTURE",
    allowedSourceKind: "CONTROL_PLANE_FRAME_GUARD",
    maxCaptureAgeMs: 250,
    requiredStateFields: STATE_FIELDS,
  }, deriveM64CurrentStateGuardPolicyHash, "policyHash");
  const guardPolicyRef = writeJson(join(artifactsRoot, "policy", "current-state-guard.json"), guardPolicy);

  const modelProfileRoot = join(artifactsRoot, "model-profile");
  const modelProfile = writeQualifiedModelBundle({
    root: modelProfileRoot,
    targetEnvironmentAttestationHash: environmentAttestation.attestationHash,
  });
  const rawLockDescriptors = {};
  for (const kind of M6_GATE_V2_LOCK_KINDS) {
    if (["modelProfile", "scenarioManifest", "environmentQualification"].includes(kind)) continue;
    const ref = writeBytes(join(artifactsRoot, "locks", `${kind}.txt`), Buffer.from(`public:${kind}\n`, "utf8"));
    rawLockDescriptors[kind] = { mode: "RAW_SHA256", path: ref.path, expectedHash: ref.sha256 };
  }
  const operatorRef = writeJson(join(artifactsRoot, "runtime", "operator.json"), { schemaId: "xw.m6-4-production-operator.v1" });
  const resetRef = writeJson(join(artifactsRoot, "runtime", "reset-obligations.json"), { schemaId: "xw.m6-4-reset-obligations.v1" });
  const windows = PURPOSE_FILES.map(([purpose, filename]) => {
    const manifest = JSON.parse(readFileSync(new URL(`../../artifacts/m6-4/cohort-manifests/${filename}`, import.meta.url), "utf8"));
    const manifestRef = writeJson(join(manifestRoot, filename), manifest);
    return {
      purpose,
      lockArtifacts: {
        ...rawLockDescriptors,
        modelProfile: { mode: "LIVE_MODEL_PROFILE", path: modelProfileRoot, expectedHash: modelProfile.contentHash },
        scenarioManifest: { mode: "M6_COHORT_MANIFEST", path: manifestRef.path, expectedHash: manifest.manifestHash },
        environmentQualification: { mode: "ENVIRONMENT_QUALIFICATION", path: environmentQualificationRef.path, expectedHash: environmentQualificationRef.sha256 },
      },
      runtimeArtifacts: {
        environmentAttestation: { mode: "TARGET_ENV_ATTESTATION", path: environmentAttestationRef.path, expectedHash: environmentAttestation.attestationHash },
        independentOracle: { mode: "RAW_SHA256", path: oraclePolicyRef.path, expectedHash: oraclePolicyRef.sha256 },
        operator: { mode: "RAW_SHA256", path: operatorRef.path, expectedHash: operatorRef.sha256 },
        resetObligations: { mode: "RAW_SHA256", path: resetRef.path, expectedHash: resetRef.sha256 },
      },
    };
  });

  const dependencyRoot = join(artifactsRoot, "dependency-layer");
  const dependencyLayerHash = H("dependency-layer");
  writeJson(join(dependencyRoot, "m6-live-runtime-dependency-layer.v1.json"), {
    schemaId: "xw.m6-live-runtime-dependency-layer.v1",
    layerHash: dependencyLayerHash,
    sourceRelease: { releaseId: RELEASE_ID, sourceCommit: SOURCE_COMMIT, manifestSha256: releaseManifestRef.sha256 },
  });
  mkdirSync(join(outputRoot, "config"), { recursive: true });
  mkdirSync(join(outputRoot, "state", "control-plane"), { recursive: true });
  const runtimeSnapshotPath = join(outputRoot, "state", "control-plane", "m6-c1-live-window-runtime.v1.json");
  const gateIssuerRef = writeJson(join(artifactsRoot, "issuers", "gate.json"), { schemaId: "xw.m6-gate-issuer-allowlist.v1", keys: [] });
  const liveIssuerRef = writeJson(join(artifactsRoot, "issuers", "live-window.json"), { schemaId: "xw.m6-4-live-window-issuer-allowlist.v1", keys: [] });
  const persistenceRoot = join(artifactsRoot, "dsh-persistence");
  mkdirSync(persistenceRoot, { recursive: true });

  const input = {
    schemaId: M64_FINAL_ASSEMBLER_INPUT_SCHEMA_ID,
    release: {
      root: releaseRoot,
      manifestPath: releaseManifestRef.path,
      manifestSha256: releaseManifestRef.sha256,
      releaseId: RELEASE_ID,
      sourceCommit: SOURCE_COMMIT,
      capabilityId: "xiaowei.m6.grounded_run",
      implementationClosureHash: CLOSURE_HASH,
      tcbManifestRef: "xw.m6-grounded-run.tcb.v1",
    },
    outputs: {
      inventoryRoot: join(outputRoot, "state", "control-plane", "gate-f-artifacts", "inventories"),
      artifactCatalogPath: join(outputRoot, "state", "control-plane", "gate-f-artifacts", "gate-f-artifact-catalog.json"),
      productionDependencyBindingPath: join(outputRoot, "config", "m6-4-production-dependency-binding.v1.json"),
      runtimeBindingPath: join(outputRoot, "config", "m6-c1-runtime.v1.json"),
      receiptRoot: join(outputRoot, "receipts"),
    },
    runtime: {
      dependencyRoot,
      dependencyLayerHash,
      modelProfileRoot,
      modelProfileHash: modelProfile.contentHash,
      providerBaseUrl: SEALED_LIVE_PROVIDER_BASE_URL,
      manifestRoot,
      runtimeSnapshotPath,
      dshPersistenceRoot: persistenceRoot,
      gateId: "m6-c1-final-gate",
      gateIssuerAllowlistPath: gateIssuerRef.path,
      liveAuthorizationIssuerAllowlistPath: liveIssuerRef.path,
    },
    productionDependencies: {
      environmentAttestation: environmentAttestationRef,
      environmentQualification: environmentQualificationRef,
      effectBoundary: boundaryRef,
      independentOraclePolicy: oraclePolicyRef,
      targetSelectorPolicy: selectorPolicyRef,
      currentStateGuardPolicy: guardPolicyRef,
    },
    windows,
  };
  return Object.freeze({
    root,
    outputRoot,
    input,
    dependencies: testDependencies(),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  });
}

function assertNoAssemblerArtifacts(f) {
  for (const path of [
    f.input.outputs.inventoryRoot,
    f.input.outputs.artifactCatalogPath,
    f.input.outputs.productionDependencyBindingPath,
    f.input.outputs.runtimeBindingPath,
    f.input.outputs.receiptRoot,
    f.input.runtime.runtimeSnapshotPath,
  ]) assert.equal(existsSync(path), false, `unexpected assembler/stage artifact: ${path}`);
}

test("final assembler preflights real production loaders without writes and separates raw/domain hashes", () => {
  const f = fixture();
  try {
    const plan = assembleM64FinalProductionArtifacts({ input: f.input, now: () => NOW, dependencies: f.dependencies });
    assert.equal(plan.mode, "PREFLIGHT");
    assert.equal(plan.writesPerformed, false);
    assertNoAssemblerArtifacts(f);
    assert.deepEqual(Object.keys(plan.finalBinding).sort(), [...M64_FINAL_RUNTIME_BINDING_KEYS].sort());
    assert.equal(plan.dependencyBinding.fixture, undefined);
    assert.notEqual(plan.receipt.artifactCatalog.catalogHash, plan.receipt.artifactCatalog.sha256);
    assert.notEqual(
      plan.receipt.productionDependencyBinding.bindingHash,
      plan.receipt.productionDependencyBinding.sha256,
    );
    for (const inventory of plan.receipt.inventories) assert.notEqual(inventory.inventoryHash, inventory.sha256);
    assert.deepEqual(plan.receipt.inventories.map((item) => item.purpose), PURPOSE_FILES.map(([purpose]) => purpose));
    assert.equal(plan.receipt.privateKeyMaterialRead, false);
    assert.equal(plan.receipt.secretMaterialPresent, false);
    assert.equal(plan.receipt.signatureGenerated, false);
  } finally { f.cleanup(); }
});

test("final assembler CLI defaults to preflight and requires one absolute input", () => {
  const inputPath = join(tmpdir(), "m6-4-final-assembler-input.json");
  assert.deepEqual(parseM64FinalAssemblerArgs(["--input", inputPath]), { execute: false, inputPath });
  assert.deepEqual(parseM64FinalAssemblerArgs(["--execute", "--input", inputPath]), { execute: true, inputPath });
  assert.throws(() => parseM64FinalAssemblerArgs(["--input", "relative.json"]), {
    code: "M64_FINAL_ASSEMBLER_CLI_INVALID",
  });
  assert.throws(() => parseM64FinalAssemblerArgs(["--execute", "--execute", "--input", inputPath]), {
    code: "M64_FINAL_ASSEMBLER_CLI_INVALID",
  });
});

test("final assembler execute is create-only, exact replay idempotent, and refuses different bytes", () => {
  const f = fixture();
  try {
    const first = assembleM64FinalProductionArtifacts({ input: f.input, execute: true, now: () => NOW, dependencies: f.dependencies });
    assert.equal(first.writesPerformed, true);
    assert.equal(first.exactReplay, false);
    assert.ok(existsSync(first.receiptPath));
    assert.equal(existsSync(f.input.runtime.runtimeSnapshotPath), false, "assembler must leave the stable stage target absent");
    const second = assembleM64FinalProductionArtifacts({ input: f.input, execute: true, now: () => NOW, dependencies: f.dependencies });
    assert.equal(second.writesPerformed, false);
    assert.equal(second.exactReplay, true);
    assert.equal(existsSync(f.input.runtime.runtimeSnapshotPath), false, "exact replay must not materialize a stage snapshot");
    writeFileSync(f.input.outputs.runtimeBindingPath, "different\n", "utf8");
    assert.throws(
      () => planM64FinalProductionArtifacts({ input: f.input, now: () => NOW, dependencies: f.dependencies }),
      { code: "M64_FINAL_ASSEMBLER_REFUSE_DIFFERENT" },
    );
  } finally { f.cleanup(); }
});

test("final assembler recovers every create-only receipt cut and never advertises a paired nlink=2 replay", async (t) => {
  for (const cut of RECOVERABLE_PUBLICATION_CUTS) {
    await t.test(cut, () => {
      const f = fixture();
      let pendingPath = null;
      try {
        const initial = planM64FinalProductionArtifacts({
          input: f.input,
          now: () => NOW,
          dependencies: f.dependencies,
        });
        const receiptIndex = initial.artifacts.length - 1;
        const crash = Object.assign(new Error(`receipt publication crash:${cut}`), {
          code: `TEST_ASSEMBLER_${cut}`,
        });
        assert.throws(() => assembleM64FinalProductionArtifacts({
          input: f.input,
          execute: true,
          now: () => NOW,
          dependencies: f.dependencies,
          publicationProtocolFaultAfter(info) {
            if (info.artifactIndex === receiptIndex && info.point === cut) {
              pendingPath = info.pendingPath;
              throw crash;
            }
          },
        }), { code: crash.code });
        assert.equal(typeof pendingPath, "string");

        const crashedPlan = planM64FinalProductionArtifacts({
          input: f.input,
          now: () => NOW,
          dependencies: f.dependencies,
        });
        const alreadySingleLink = new Set(["PENDING_UNLINKED", "DIRECTORY_FSYNCED"]).has(cut);
        assert.equal(crashedPlan.exactReplayAvailable, alreadySingleLink);
        if (cut === "FINAL_PUBLISHED") {
          assert.equal(lstatSync(initial.receiptPath, { bigint: true }).nlink, 2n);
          assert.equal(lstatSync(pendingPath, { bigint: true }).nlink, 2n);
          assert.equal(crashedPlan.exactReplayAvailable, false);
        }

        const recovered = assembleM64FinalProductionArtifacts({
          input: f.input,
          execute: true,
          now: () => NOW,
          dependencies: f.dependencies,
        });
        assert.equal(readFileSync(initial.receiptPath).equals(initial.artifacts.at(-1).bytes), true);
        assert.equal(lstatSync(initial.receiptPath, { bigint: true }).nlink, 1n);
        assert.equal(existsSync(pendingPath), false);
        assert.equal(
          planM64FinalProductionArtifacts({ input: f.input, now: () => NOW, dependencies: f.dependencies })
            .exactReplayAvailable,
          true,
        );
        assert.equal(recovered.outcomes.at(-1).outcome, alreadySingleLink || cut === "FINAL_PUBLISHED"
          ? "REPLAYED" : "CREATED");
      } finally { f.cleanup(); }
    });
  }
});

test("final assembler resumes exact partial materialization and commits the receipt last", () => {
  const f = fixture();
  try {
    const plan = planM64FinalProductionArtifacts({ input: f.input, now: () => NOW, dependencies: f.dependencies });
    const preReceiptBoundary = plan.artifacts.length - 1;
    assert.throws(() => assembleM64FinalProductionArtifacts({
      input: f.input,
      execute: true,
      now: () => NOW,
      dependencies: f.dependencies,
      publicationFaultAfter: preReceiptBoundary,
    }), { code: "M64_FINAL_ASSEMBLER_PUBLICATION_FAULT_INJECTED" });
    for (const artifact of plan.artifacts.slice(0, -1)) assert.ok(existsSync(artifact.path));
    assert.equal(existsSync(plan.receiptPath), false);
    const result = assembleM64FinalProductionArtifacts({ input: f.input, execute: true, now: () => NOW, dependencies: f.dependencies });
    assert.ok(result.outcomes.slice(0, -1).every((item) => item.outcome === "REPLAYED"));
    assert.equal(result.outcomes.at(-1).path, result.receiptPath);
    assert.equal(result.outcomes.at(-1).outcome, "CREATED");
    assert.ok(existsSync(result.receiptPath));
    assert.deepEqual(result.receipt.publicationDurability, {
      createOnly: true,
      fileFsyncBeforeNextArtifact: true,
      parentDirectoryFsyncBeforeNextArtifact: "REQUIRED_OR_EXPLICITLY_UNSUPPORTED_ON_WINDOWS",
      receiptWrittenLast: true,
    });
  } finally { f.cleanup(); }
});

test("final assembler refuses a receipt that precedes any required artifact", () => {
  const f = fixture();
  try {
    const plan = planM64FinalProductionArtifacts({ input: f.input, now: () => NOW, dependencies: f.dependencies });
    const receiptArtifact = plan.artifacts.at(-1);
    writeBytes(receiptArtifact.path, receiptArtifact.bytes);
    assert.throws(
      () => planM64FinalProductionArtifacts({ input: f.input, now: () => NOW, dependencies: f.dependencies }),
      { code: "M64_FINAL_ASSEMBLER_PREMATURE_RECEIPT" },
    );
  } finally { f.cleanup(); }
});

test("candidate verification APIs do not weaken production disk loaders", () => {
  const f = fixture();
  try {
    const plan = planM64FinalProductionArtifacts({ input: f.input, now: () => NOW, dependencies: f.dependencies });
    const inventoryArtifact = plan.artifacts[0];
    assert.throws(() => loadM6GateFArtifactInventory({
      path: inventoryArtifact.path,
      expectedHash: plan.receipt.inventories[0].inventoryHash,
      candidateBytes: inventoryArtifact.bytes,
    }), { code: "M6_GATE_F_INVENTORY_CANDIDATE_FORBIDDEN" });
    assert.throws(() => loadM6GateFArtifactInventory(Object.assign(
      Object.create({ candidateBytes: inventoryArtifact.bytes }),
      {
        path: inventoryArtifact.path,
        expectedHash: plan.receipt.inventories[0].inventoryHash,
      },
    )), { code: "M6_GATE_F_INVENTORY_CANDIDATE_FORBIDDEN" });
    assert.throws(() => loadM6GateFArtifactCatalog({
      path: f.input.outputs.artifactCatalogPath,
      expectedHash: plan.catalog.catalogHash,
      expectedReleaseRoot: f.input.release.root,
      expectedReleaseManifestPath: f.input.release.manifestPath,
      candidateBytes: plan.artifacts[5].bytes,
      inventoryCandidateBytes: new Map(),
    }), { code: "M6_GATE_F_CATALOG_CANDIDATE_FORBIDDEN" });
    assert.throws(() => loadM6GateFArtifactCatalog(Object.assign(
      Object.create({
        candidateBytes: plan.artifacts[5].bytes,
        inventoryCandidateBytes: new Map(),
      }),
      {
        path: f.input.outputs.artifactCatalogPath,
        expectedHash: plan.catalog.catalogHash,
        expectedReleaseRoot: f.input.release.root,
        expectedReleaseManifestPath: f.input.release.manifestPath,
      },
    )), { code: "M6_GATE_F_CATALOG_CANDIDATE_FORBIDDEN" });
    const inventoryArtifacts = plan.artifacts.slice(0, 5);
    const normalizedAlias = `${dirname(inventoryArtifacts[0].path)}${sep}candidate-alias${sep}..${sep}${basename(inventoryArtifacts[0].path)}`;
    const normalizedMap = new Map(inventoryArtifacts.map((artifact, index) => [
      index === 0 ? normalizedAlias : artifact.path,
      artifact.bytes,
    ]));
    assert.equal(validateM6GateFArtifactCatalogCandidate({
      path: f.input.outputs.artifactCatalogPath,
      expectedHash: plan.catalog.catalogHash,
      expectedReleaseRoot: f.input.release.root,
      expectedReleaseManifestPath: f.input.release.manifestPath,
      candidateBytes: plan.artifacts[5].bytes,
      inventoryCandidateBytes: normalizedMap,
    }).catalogHash, plan.catalog.catalogHash);
    const duplicateNormalizedMap = new Map([
      [inventoryArtifacts[0].path, inventoryArtifacts[0].bytes],
      [normalizedAlias, inventoryArtifacts[0].bytes],
      ...inventoryArtifacts.slice(1, 4).map((artifact) => [artifact.path, artifact.bytes]),
    ]);
    assert.throws(() => validateM6GateFArtifactCatalogCandidate({
      path: f.input.outputs.artifactCatalogPath,
      expectedHash: plan.catalog.catalogHash,
      expectedReleaseRoot: f.input.release.root,
      expectedReleaseManifestPath: f.input.release.manifestPath,
      candidateBytes: plan.artifacts[5].bytes,
      inventoryCandidateBytes: duplicateNormalizedMap,
    }), { code: "M6_GATE_F_CATALOG_INVENTORY_CANDIDATES_INVALID" });
    const dependencyBytes = plan.artifacts.find((item) => item.path === f.input.outputs.productionDependencyBindingPath).bytes;
    assert.throws(() => loadM64ProductionDependencies({
      runtimeBinding: plan.finalBinding,
      productionDependencyBindingBytes: dependencyBytes,
      now: () => NOW,
    }), { code: "M6_LIVE_PRODUCTION_DEPENDENCY_CANDIDATE_FORBIDDEN" });
    assert.throws(() => loadM64ProductionDependencies(Object.assign(
      Object.create({ productionDependencyBindingBytes: dependencyBytes }),
      { runtimeBinding: plan.finalBinding, now: () => NOW },
    )), { code: "M6_LIVE_PRODUCTION_DEPENDENCY_CANDIDATE_FORBIDDEN" });
    assert.throws(() => loadM64ProductionDependencies({
      runtimeBinding: plan.finalBinding,
      now: () => NOW,
    }), { code: "M6_LIVE_DEPENDENCY_ARTIFACT_UNAVAILABLE" });
  } finally { f.cleanup(); }
});

test("final assembler rejects hard-link artifacts and symlink/junction ancestors", async (t) => {
  await t.test("hard-link artifact", () => {
    const f = fixture();
    try {
      const input = structuredClone(f.input);
      const source = input.windows[0].runtimeArtifacts.operator.path;
      const alias = join(f.root, "hardlink-alias", basename(source));
      mkdirSync(dirname(alias), { recursive: true });
      linkSync(source, alias);
      input.windows[0].runtimeArtifacts.operator.path = alias;
      assert.throws(
        () => planM64FinalProductionArtifacts({ input, now: () => NOW, dependencies: f.dependencies }),
        { code: "M64_FINAL_ASSEMBLER_PATH_NOT_PLAIN" },
      );
      assertNoAssemblerArtifacts(f);
    } finally { f.cleanup(); }
  });

  await t.test("hard-link output artifact", () => {
    const f = fixture();
    try {
      const initial = planM64FinalProductionArtifacts({ input: f.input, now: () => NOW, dependencies: f.dependencies });
      const inventory = initial.artifacts[0];
      const source = join(f.root, "hardlink-output-source.json");
      writeFileSync(source, inventory.bytes);
      mkdirSync(dirname(inventory.path), { recursive: true });
      linkSync(source, inventory.path);
      assert.throws(
        () => planM64FinalProductionArtifacts({ input: f.input, now: () => NOW, dependencies: f.dependencies }),
        { code: "M64_FINAL_ASSEMBLER_PATH_NOT_PLAIN" },
      );
    } finally { f.cleanup(); }
  });

  await t.test("hard-link stable snapshot target", () => {
    const f = fixture();
    try {
      const source = join(f.root, "hardlink-snapshot-source.json");
      writeFileSync(source, "{}\n", "utf8");
      linkSync(source, f.input.runtime.runtimeSnapshotPath);
      assert.throws(
        () => planM64FinalProductionArtifacts({ input: f.input, now: () => NOW, dependencies: f.dependencies }),
        { code: "M64_FINAL_ASSEMBLER_PATH_NOT_PLAIN" },
      );
    } finally { f.cleanup(); }
  });

  await t.test("junction/symlink input ancestor", (subtest) => {
    const f = fixture();
    try {
      const input = structuredClone(f.input);
      const source = input.windows[0].runtimeArtifacts.operator.path;
      const link = join(f.root, "operator-parent-link");
      try {
        symlinkSync(dirname(source), link, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
          subtest.skip(`symlink/junction probe unavailable: ${error.code}`);
          return;
        }
        throw error;
      }
      input.windows[0].runtimeArtifacts.operator.path = join(link, basename(source));
      assert.throws(
        () => planM64FinalProductionArtifacts({ input, now: () => NOW, dependencies: f.dependencies }),
        { code: "M64_FINAL_ASSEMBLER_PATH_NOT_PLAIN" },
      );
      assertNoAssemblerArtifacts(f);
    } finally { f.cleanup(); }
  });

  await t.test("junction/symlink output ancestor", (subtest) => {
    const f = fixture();
    try {
      const input = structuredClone(f.input);
      const actualOutputParent = join(f.root, "actual-output-parent");
      mkdirSync(actualOutputParent, { recursive: true });
      const link = join(f.root, "output-parent-link");
      try {
        symlinkSync(actualOutputParent, link, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
          subtest.skip(`symlink/junction probe unavailable: ${error.code}`);
          return;
        }
        throw error;
      }
      input.outputs.artifactCatalogPath = join(link, "catalog.json");
      assert.throws(
        () => planM64FinalProductionArtifacts({ input, now: () => NOW, dependencies: f.dependencies }),
        { code: "M64_FINAL_ASSEMBLER_PATH_NOT_PLAIN" },
      );
      assertNoAssemblerArtifacts(f);
    } finally { f.cleanup(); }
  });
});

test("final assembler rejects purpose/order, hash, path, duplicate, secret, and TCB/release drift", async (t) => {
  const cases = [
    {
      name: "purpose-order",
      code: "M64_FINAL_ASSEMBLER_PURPOSE_ORDER_INVALID",
      mutate(input) { [input.windows[0], input.windows[1]] = [input.windows[1], input.windows[0]]; },
    },
    {
      name: "domain-hash-drift",
      code: "M6_GATE_F_SCENARIO_MANIFEST_INVALID",
      mutate(input) { input.windows[0].lockArtifacts.scenarioManifest.expectedHash = H("wrong-scenario"); },
    },
    {
      name: "relative-artifact-path",
      code: "M64_FINAL_ASSEMBLER_PATH_INVALID",
      mutate(input) { input.windows[0].runtimeArtifacts.operator.path = "relative/operator.json"; },
    },
    {
      name: "duplicate-production-dependency",
      code: "M64_FINAL_ASSEMBLER_DEPENDENCY_DUPLICATE",
      mutate(input) { input.productionDependencies.targetSelectorPolicy = input.productionDependencies.effectBoundary; },
    },
    {
      name: "output-input-path-collision",
      code: "M64_FINAL_ASSEMBLER_OUTPUT_COLLISION",
      mutate(input) { input.outputs.artifactCatalogPath = input.windows[0].runtimeArtifacts.operator.path; },
    },
    {
      name: "inventory-output-input-path-collision",
      code: "M64_FINAL_ASSEMBLER_OUTPUT_COLLISION",
      mutate(input) {
        const collisionRoot = dirname(input.windows[0].runtimeArtifacts.operator.path);
        const collisionPath = join(collisionRoot, "1-m6-4-shadow.inventory.v1.json");
        const collisionRef = writeJson(collisionPath, { schemaId: "xw.public.collision-probe.v1" });
        input.outputs.inventoryRoot = collisionRoot;
        input.windows[0].runtimeArtifacts.operator = {
          mode: "RAW_SHA256",
          path: collisionRef.path,
          expectedHash: collisionRef.sha256,
        };
      },
    },
    {
      name: "output-runtime-allowlist-path-collision",
      code: "M64_FINAL_ASSEMBLER_OUTPUT_COLLISION",
      mutate(input) { input.outputs.artifactCatalogPath = input.runtime.gateIssuerAllowlistPath; },
    },
    {
      name: "receipt-output-inside-consumed-directory",
      code: "M64_FINAL_ASSEMBLER_OUTPUT_COLLISION",
      mutate(input) { input.outputs.receiptRoot = input.runtime.modelProfileRoot; },
    },
    {
      name: "nested-output-files",
      code: "M64_FINAL_ASSEMBLER_OUTPUT_COLLISION",
      mutate(input) {
        input.outputs.artifactCatalogPath = join(dirname(input.outputs.artifactCatalogPath), "nested-output");
        input.outputs.productionDependencyBindingPath = join(input.outputs.artifactCatalogPath, "binding.json");
      },
    },
    {
      name: "secret-shaped-input",
      code: "M64_FINAL_ASSEMBLER_SECRET_MATERIAL_FORBIDDEN",
      mutate(input) { input.runtime.providerBaseUrl = "Bearer abcdefghijklmnop"; },
    },
    {
      name: "runtime-snapshot-target-outside-state",
      code: "M64_FINAL_ASSEMBLER_RUNTIME_SNAPSHOT_ESCAPE",
      mutate(input) { input.runtime.runtimeSnapshotPath = join(input.outputs.runtimeBindingPath, "..", "..", "snapshot.json"); },
    },
    {
      name: "raw-hash-drift",
      code: "M64_FINAL_ASSEMBLER_RAW_HASH_MISMATCH",
      mutate(input) { input.productionDependencies.effectBoundary.sha256 = H("wrong-raw"); },
    },
    {
      name: "release-manifest-drift",
      code: "M64_FINAL_ASSEMBLER_RELEASE_BINDING_INVALID",
      mutate(input) { input.release.manifestSha256 = H("wrong-manifest"); },
    },
    {
      name: "tcb-seal-drift",
      code: "M64_FINAL_ASSEMBLER_TCB_SEAL_MISMATCH",
      dependencies: testDependencies({
        verifyCapabilitySeal: () => ({
          capabilityId: "xiaowei.m6.grounded_run",
          implementationClosureHash: H("wrong-closure"),
          tcbManifestRef: "xw.m6-grounded-run.tcb.v1",
        }),
      }),
      mutate() {},
    },
  ];
  for (const item of cases) {
    await t.test(item.name, () => {
      const f = fixture();
      try {
        const input = structuredClone(f.input);
        item.mutate(input);
        assert.throws(
          () => planM64FinalProductionArtifacts({
            input,
            now: () => NOW,
            dependencies: item.dependencies ?? f.dependencies,
          }),
          { code: item.code },
        );
        assertNoAssemblerArtifacts(f);
      } finally { f.cleanup(); }
    });
  }
});
