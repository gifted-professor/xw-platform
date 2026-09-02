import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  deriveM64CohortAggregateHash,
  deriveM64CohortScenarioKeys,
} from "../../../packages/kernel/lib/m6-4-cohort.mjs";
import {
  M64_LIVE_WINDOW_AUTHORIZATION_SCHEMA_ID,
  canonicalM64LiveWindowAuthorizationSigningBytes,
  deriveM64LiveWindowAuthorizationBodyHash,
  deriveM64LiveWindowAuthorizationEnvelopeHash,
} from "../../../packages/kernel/lib/m6-4-live-window-authorization.mjs";
import { deriveM6AggregateSealHash } from "../../../packages/kernel/lib/m6-aggregate-closeout.mjs";
import { deriveTargetEnvironmentAttestation } from "../../../packages/kernel/lib/m6-live-grounding.mjs";
import {
  deriveLiveModelProfileHash,
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
} from "../../../integrations/dsh-xw/src/live-model-profile.mjs";
import { deriveM64TargetEnvironmentCommandRegistryHash } from "../apps/xiaowei/m6-target-environment-qualification.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";
import { canonicalJson, sha256, writeImmutableJson } from "../control-plane/lib/m6-gate-loader.mjs";
import { deriveM6CloseoutHash, deriveM6EpochHash } from "../control-plane/lib/m6-live-gate.mjs";
import {
  deriveM6ActionEpochBindingHash,
  deriveM6EmergencyCloseAuthorizationHash,
  deriveM6V2EpochHash,
  deriveM6V2LockSetHash,
  M6_GATE_V2_LOCK_KINDS,
} from "../control-plane/lib/m6-live-gate-v2.mjs";
import {
  assertM6FileDbPointerConsistency,
} from "../control-plane/lib/m6-gate-promoter.mjs";
import { deriveM6GateFSafetyCloseProofHash } from "../control-plane/lib/m6-gate-safety-close-arm.mjs";
import { loadM6Gate } from "../control-plane/lib/m6-gate-loader.mjs";
import {
  createM6GateFOperations,
  deriveM6GateFArtifactCatalogHash,
  deriveM6GateFArtifactInventoryHash,
  loadM6GateFArtifactInventory,
} from "../control-plane/lib/m6-gate-f-operations.mjs";
import { ControlRouter } from "../control-plane/router.mjs";

const GATE = "m6-gate-f-test";
const ACTOR = "operator:m6-gate-f-test";
const RELEASE = "m6-gate-f-release";
const COMMIT = "a".repeat(40);
const NOW_MS = Date.parse("2030-01-01T00:00:02Z");
const TOKEN = "gate-f-loopback-test-token-000000000001";
const H = (char) => char.repeat(64);
const MANIFESTS = Object.freeze({
  M6_4_SHADOW: fileURLToPath(new URL("../../../artifacts/m6-4/cohort-manifests/m6_4_shadow.json", import.meta.url)),
  M6_4_HOT_CLOSE: fileURLToPath(new URL("../../../artifacts/m6-4/cohort-manifests/m6_4_hot_close.json", import.meta.url)),
  M6_4_ACTION_SMOKE: fileURLToPath(new URL("../../../artifacts/m6-4/cohort-manifests/m6_4_action_smoke.json", import.meta.url)),
  M6_4_RELIABILITY: fileURLToPath(new URL("../../../artifacts/m6-4/cohort-manifests/m6_4_reliability.json", import.meta.url)),
  M6_4_SMOOTH: fileURLToPath(new URL("../../../artifacts/m6-4/cohort-manifests/m6_4_smooth.json", import.meta.url)),
});
const CATALOG_PURPOSES = Object.freeze([
  "M6_4_SHADOW", "M6_4_HOT_CLOSE", "M6_4_ACTION_SMOKE", "M6_4_RELIABILITY", "M6_4_SMOOTH",
]);

test("Gate-F artifact loader rejects hard-link aliases and parent junction traversal", (t) => {
  const root = mkdtempSync(join(tmpdir(), "m6-gate-f-artifact-path-"));
  const outside = mkdtempSync(join(tmpdir(), "m6-gate-f-artifact-outside-"));
  try {
    const artifact = writeJson(join(root, "plain", "inventory.json"), {});
    linkSync(artifact, join(outside, "inventory-hardlink.json"));
    assert.throws(() => loadM6GateFArtifactInventory({ path: artifact, expectedHash: H("a") }), {
      code: "M6_GATE_F_ARTIFACT_PATH_INVALID",
    });

    const outsideArtifact = writeJson(join(outside, "junction-inventory.json"), {});
    const junction = join(root, "junction-parent");
    try {
      symlinkSync(outside, junction, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (process.platform === "win32" && error?.code === "EPERM") {
        t.skip("Windows symlink privilege is unavailable (EPERM); hard-link assertion completed");
        return;
      }
      throw error;
    }
    assert.throws(() => loadM6GateFArtifactInventory({
      path: join(junction, outsideArtifact.split(/[\\/]/u).at(-1)),
      expectedHash: H("b"),
    }), { code: "M6_GATE_F_ARTIFACT_PATH_INVALID" });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

function hashFile(path) {
  return sha256(readFileSync(path));
}

function sealModelRecord(body) {
  return {
    ...body,
    contentHash: sha256(`${body.schemaId}:${canonicalJson(body)}`),
  };
}

function writeQualifiedModelBundle({ root, targetEnvironmentAttestationHash, capturedAt, expiresAt }) {
  const endpointHash = sha256(SEALED_LIVE_PROVIDER_BASE_URL);
  const requestEndpointHash = sha256(SEALED_LIVE_PROVIDER_REQUEST_URL);
  const runtimeDependencyQualificationHash = H("c");
  const adapterIntegrityHash = H("d");
  const provenanceHash = H("e");
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
    capturedAt,
    expiresAt,
  };
  const warmSamples = Array.from({ length: 100 }, (_, sampleIndex) => ({
    sampleIndex,
    latencyMs: 10,
    responseHash: sha256(`m6-gate-f-model-warm:${sampleIndex}`),
  }));
  const coldHealth = sealModelRecord({
    schemaId: LIVE_MODEL_COLD_HEALTH_SCHEMA_ID,
    ...common,
    sampleCount: 1,
    latencyMs: 10,
    responseHash: sha256("m6-gate-f-model-cold"),
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
    samples: warmSamples.map(({ sampleIndex, latencyMs, responseHash }) => ({
      sampleIndex,
      latencyMs,
      remainingTtlMs: 4_990,
      responseHash,
    })),
  });
  const toolCallHealth = sealModelRecord({
    schemaId: LIVE_MODEL_TOOL_HEALTH_SCHEMA_ID,
    ...common,
    sampleCount: 1,
    latencyMs: 10,
    responseHash: sha256("m6-gate-f-model-tool-call"),
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
    capturedAt,
    expiresAt,
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
    adapterSourceHash: H("f"),
    licenseHash: H("1"),
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
    capturedAt,
    expiresAt,
    gateFEligible: true,
  };
  const profile = { ...profileBody, contentHash: deriveLiveModelProfileHash(profileBody) };
  for (const record of [coldHealth, warmHealth, ttlHealth, toolCallHealth, qualification, profile]) {
    writeJson(join(root, `${record.contentHash}.json`), record);
  }
  return profile;
}

function gateProof(epoch, privateKey) {
  return {
    keyId: "m6-gate-f-key",
    subject: ACTOR,
    allowlistVersion: 1,
    signature: sign(null, Buffer.from(epoch.epochHash, "hex"), privateKey).toString("base64"),
    algorithm: "ed25519",
  };
}

function signLiveAuthorization(body, privateKey) {
  const withBodyHash = { ...body, bodyHash: deriveM64LiveWindowAuthorizationBodyHash(body) };
  const withSignature = {
    ...withBodyHash,
    signature: sign(null, canonicalM64LiveWindowAuthorizationSigningBytes(withBodyHash), privateKey).toString("base64"),
  };
  return { ...withSignature, envelopeHash: deriveM64LiveWindowAuthorizationEnvelopeHash(withSignature) };
}

function seedFixture() {
  const root = mkdtempSync(join(tmpdir(), "m6-gate-f-ops-"));
  const state = new StateStore({ dbPath: join(root, "control.db"), now: () => NOW_MS });
  const gateKeys = generateKeyPairSync("ed25519");
  const ownerKeys = generateKeyPairSync("ed25519");
  const issuerAllowlistPath = writeJson(join(root, "m6-gate", "issuer-keys.json"), {
    schemaId: "xw.m6-gate-issuer-allowlist.v1",
    version: 1,
    keys: [{
      keyId: "m6-gate-f-key",
      subject: ACTOR,
      publicKey: gateKeys.publicKey.export({ type: "spki", format: "pem" }),
      status: "active",
    }],
  });
  const liveWindowIssuerAllowlistPath = writeJson(join(root, "m6-gate", "live-window-owner-keys.json"), {
    schemaId: "xw.m6-4-live-window-issuer-allowlist.v1",
    version: 1,
    keys: [{
      issuer: "owner:m6-gate-f-test",
      keyId: "m6-gate-f-owner-key",
      publicKey: ownerKeys.publicKey.export({ type: "spki", format: "pem" }),
      status: "active",
    }],
  });

  const v1Locks = {
    runtimeProfile: H("1"),
    hardRedlinePolicy: H("2"),
    groundingRuntime: H("3"),
  };
  writeJson(join(root, "m6-gate", "locks.v1.json"), {
    schemaId: "xw.m6-locks.v1",
    releaseId: RELEASE,
    sourceCommit: COMMIT,
    lockHashes: v1Locks,
  });
  const observedHash = H("4");
  const seedCloseoutRaw = {
    closeoutId: "seed-closeout",
    epochHash: observedHash,
    actor: ACTOR,
    reason: "SEED_CLOSED",
    committedAt: "2030-01-01T00:00:00Z",
  };
  const seedCloseout = { ...seedCloseoutRaw, closeoutHash: deriveM6CloseoutHash(seedCloseoutRaw) };
  writeJson(join(root, "m6-gate", GATE, "closeouts", `${seedCloseout.closeoutId}.json`), seedCloseout);
  const seedSealPayload = { epochHash: observedHash, attempts: [], allowlist: ["01"] };
  const seedSealHash = deriveM6AggregateSealHash(seedSealPayload);
  writeJson(join(root, "m6-gate", GATE, "aggregate", `${seedSealHash}.json`), {
    schemaId: "xw.m6-aggregate-closeout.v1",
    epochHash: observedHash,
    sealPayload: seedSealPayload,
    sealHash: seedSealHash,
    attemptCount: 0,
    aliases: ["01"],
  });
  const seedRaw = {
    schemaId: "xw.m6-live-gate.v1",
    gateId: GATE,
    mode: "CLOSED",
    status: "closed",
    releaseId: RELEASE,
    sourceCommit: COMMIT,
    actor: ACTOR,
    lockHashes: v1Locks,
    allowlist: ["01"],
    issuedAt: "2030-01-01T00:00:00Z",
    expiresAt: "2030-01-02T00:00:00Z",
    parentEpochHash: null,
    closeoutRef: { id: seedCloseout.closeoutId, sha256: seedCloseout.closeoutHash },
    aggregateSealRef: { id: seedSealHash, sha256: seedSealHash },
    rollbackTargetEpochHash: null,
  };
  const seed = { ...seedRaw, epochHash: deriveM6EpochHash(seedRaw) };
  writeImmutableJson(join(root, "m6-gate", GATE, "epochs", `${seed.epochHash}.json`), {
    ...seed,
    proof: gateProof(seed, gateKeys.privateKey),
  });
  writeJson(join(root, "m6-gate", GATE, "current.json"), {
    chain: [seed.epochHash],
    tailEpochHash: seed.epochHash,
    generation: 0,
    promotedAt: "2030-01-01T00:00:00Z",
  });
  const seedLocksHash = sha256(`xw.m6-locks.v1:${canonicalJson(seed.lockHashes)}`);
  state.seedM6GateFence({ epoch: seed, locksHash: seedLocksHash });

  const releaseRoot = join(root, RELEASE);
  const releasePayloadPath = join(releaseRoot, "runtime.txt");
  mkdirSync(releaseRoot, { recursive: true });
  writeFileSync(releasePayloadPath, "sealed test runtime\n", "utf8");
  const releaseManifestPath = writeJson(join(releaseRoot, "release-manifest.v1.json"), {
    schemaId: "xw.runtime.release-manifest.v1",
    releaseId: RELEASE,
    sourceRepo: "gifted-professor/xw-platform",
    sourceCommit: COMMIT,
    sourceTreeSha: "46a38d24981d8c36428c6a851451363594afacd6",
    runtimeProfile: "legacy_compat",
    nodeVersion: process.versions.node,
    npmVersion: "test",
    services: {
      orchestrator: { path: "services/orchestrator", treeSha256: sha256("") },
      controlPlane: { path: "services/control-plane", treeSha256: sha256("") },
    },
    files: [{
      path: "runtime.txt",
      gitMode: "100644",
      gitBlobOid: "90f2297622947589527cacbcf9982f1c43e22d78",
      sha256: hashFile(releasePayloadPath),
    }],
    runtimeCutoverAllowed: false,
  });

  return {
    root,
    state,
    gateKeys,
    ownerKeys,
    issuerAllowlistPath,
    liveWindowIssuerAllowlistPath,
    releaseRoot,
    releaseManifestPath,
    releaseHash: hashFile(releaseManifestPath),
    seed,
    cleanup() {
      state.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function buildStageArtifacts(f, { purpose, label }) {
  const artifactRoot = join(f.root, "gate-f-artifacts", label);
  const lockArtifacts = {};
  const lockHashes = {};
  for (const kind of M6_GATE_V2_LOCK_KINDS) {
    if (["modelProfile", "scenarioManifest", "environmentQualification"].includes(kind)) continue;
    const path = join(artifactRoot, "locks", `${kind}.txt`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${label}:${kind}\n`, "utf8");
    lockArtifacts[kind] = { mode: "RAW_SHA256", path };
    lockHashes[kind] = hashFile(path);
  }

  const scenarioManifest = JSON.parse(readFileSync(MANIFESTS[purpose], "utf8"));
  const scenarioManifestPath = writeJson(join(artifactRoot, "cohort-manifest.json"), scenarioManifest);
  lockArtifacts.scenarioManifest = { mode: "M6_COHORT_MANIFEST", path: scenarioManifestPath };
  lockHashes.scenarioManifest = scenarioManifest.manifestHash;

  const environmentAttestation = deriveTargetEnvironmentAttestation({
    appPackageHash: H("1"),
    appBuildHash: H("2"),
    signingHash: H("3"),
    osBuildHash: H("4"),
    displayHash: H("5"),
    localeThemeHash: H("6"),
    imeHash: H("7"),
    accessibilityHash: H("8"),
    accountBindingHash: H("9"),
    accountIsolationHash: H("9"),
    capturedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T06:00:00.000Z",
  });
  const environmentAttestationPath = writeJson(join(artifactRoot, "environment-attestation.json"), environmentAttestation);
  const environmentQualificationPath = writeJson(join(artifactRoot, "environment-qualification.json"), {
    schemaId: "xw.m6-environment-qualification.v1",
    status: "QUALIFIED",
    gateFEligible: true,
    alias: "01",
    effectBoundary: "READ_ONLY",
    commandRegistryHash: deriveM64TargetEnvironmentCommandRegistryHash(),
    qualifiedAttestationHashes: [environmentAttestation.attestationHash],
    sampleCount: 2,
    capturedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T06:00:00.000Z",
    secretMaterialPresent: false,
    rawDeviceIdentityPresent: false,
    actionCount: 0,
  });
  lockArtifacts.environmentQualification = { mode: "ENVIRONMENT_QUALIFICATION", path: environmentQualificationPath };
  lockHashes.environmentQualification = hashFile(environmentQualificationPath);

  const modelProfileRoot = join(artifactRoot, "model-profiles");
  const modelProfile = writeQualifiedModelBundle({
    root: modelProfileRoot,
    targetEnvironmentAttestationHash: environmentAttestation.attestationHash,
    capturedAt: environmentAttestation.capturedAt,
    expiresAt: environmentAttestation.expiresAt,
  });
  lockArtifacts.modelProfile = { mode: "LIVE_MODEL_PROFILE", path: modelProfileRoot };
  lockHashes.modelProfile = modelProfile.contentHash;

  const runtimeArtifacts = {
    environmentAttestation: { mode: "TARGET_ENV_ATTESTATION", path: environmentAttestationPath },
  };
  const runtimeHashes = {};
  for (const kind of ["operator", "independentOracle", "resetObligations"]) {
    const path = join(artifactRoot, "runtime", `${kind}.json`);
    writeJson(path, { schemaId: `xw.m6-gate-f-${kind}.test.v1`, label });
    runtimeArtifacts[kind] = { mode: "RAW_SHA256", path };
    runtimeHashes[kind] = hashFile(path);
  }

  const lockSetRaw = {
    schemaId: "xw.m6-locks.v2",
    lockSetId: `${label}-locks-v2`,
    lockHashes,
  };
  const lockSet = { ...lockSetRaw, lockSetHash: deriveM6V2LockSetHash(lockSetRaw) };
  writeImmutableJson(join(f.root, "m6-gate", "locks.v2", `${lockSet.lockSetId}.json`), lockSet);

  const inventoryBody = {
    schemaId: "xw.m6-gate-f-artifact-inventory.v1",
    release: { root: f.releaseRoot, manifestPath: f.releaseManifestPath },
    lockArtifacts,
    runtimeArtifacts,
  };
  const inventory = { ...inventoryBody, inventoryHash: deriveM6GateFArtifactInventoryHash(inventoryBody) };
  const inventoryPath = writeJson(join(artifactRoot, "inventory.json"), inventory);
  return {
    lockSet,
    inventory,
    inventoryPath,
    environmentAttestationHash: environmentAttestation.attestationHash,
    operatorHash: runtimeHashes.operator,
    independentOracleHash: runtimeHashes.independentOracle,
    resetObligationsHash: runtimeHashes.resetObligations,
  };
}

function operationsFor(f, stage, { faultAfterForOperation = () => null, activeRunCount = () => 0 } = {}) {
  return createM6GateFOperations({
    state: f.state,
    config: {
      internalToken: TOKEN,
      m6Root: f.root,
      gateId: GATE,
      issuerAllowlistPath: f.issuerAllowlistPath,
      liveWindowIssuerAllowlistPath: f.liveWindowIssuerAllowlistPath,
      artifactInventoryPath: stage.inventoryPath,
      artifactInventoryHash: stage.inventory.inventoryHash,
    },
    now: () => NOW_MS,
    faultAfterForOperation,
    activeRunCount,
  });
}

function buildArtifactCatalog(f, selectedStage) {
  const selectedManifest = JSON.parse(readFileSync(selectedStage.inventory.lockArtifacts.scenarioManifest.path, "utf8"));
  const stages = [];
  for (const purpose of CATALOG_PURPOSES) {
    const stage = purpose === selectedManifest.purpose
      ? selectedStage
      : buildStageArtifacts(f, { purpose, label: `catalog-${purpose.toLowerCase()}` });
    stages.push(stage);
  }
  const body = {
    schemaId: "xw.m6-gate-f-artifact-catalog.v1",
    release: { releaseId: RELEASE, sourceCommit: COMMIT },
    entries: CATALOG_PURPOSES.map((purpose, index) => {
      const stage = stages[index];
      return {
        purpose,
        scenarioManifestHash: stage.lockSet.lockHashes.scenarioManifest,
        inventoryPath: stage.inventoryPath,
        inventorySha256: hashFile(stage.inventoryPath),
        inventoryHash: stage.inventory.inventoryHash,
      };
    }),
  };
  const catalog = { ...body, catalogHash: deriveM6GateFArtifactCatalogHash(body) };
  const catalogPath = writeJson(join(f.root, "gate-f-artifacts", "catalog.json"), catalog);
  return { catalog, catalogPath, stages };
}

function catalogOperationsFor(f, catalogStage, {
  faultAfterForOperation = () => null,
  activeRunCount = () => 0,
  runtimeMode = null,
  now = () => NOW_MS,
  sourceReleaseRoot = f.releaseRoot,
  sourceReleaseManifestPath = f.releaseManifestPath,
} = {}) {
  return createM6GateFOperations({
    state: f.state,
    config: {
      ...(runtimeMode ? { runtimeMode } : {}),
      internalToken: TOKEN,
      m6Root: f.root,
      gateId: GATE,
      issuerAllowlistPath: f.issuerAllowlistPath,
      liveWindowIssuerAllowlistPath: f.liveWindowIssuerAllowlistPath,
      artifactCatalogPath: catalogStage.catalogPath,
      artifactCatalogHash: catalogStage.catalog.catalogHash,
      sourceReleaseRoot,
      sourceReleaseManifestPath,
    },
    now,
    faultAfterForOperation,
    activeRunCount,
  });
}

function armActivationWithSafetyClose(f, action, label = "safety") {
  const safety = makeClose(f, action, {
    operation: "EMERGENCY_CLOSE",
    reasonCode: "SAFETY_STOP",
    label,
  });
  action.package = { ...action.package, safetyClosePackage: safety.package };
  return safety;
}

function makeActivation(f, { purpose, phase, label }) {
  const stage = buildStageArtifacts(f, { purpose, label });
  const parent = f.state.getM6GateFence();
  const base = {
    schemaId: "xw.m6-live-gate.v2",
    gateId: GATE,
    mode: phase === "GROUNDING_ONLY" ? "OBSERVE_ONLY" : "GROUNDED_ACTION",
    purpose,
    status: "active",
    releaseId: RELEASE,
    sourceCommit: COMMIT,
    actor: ACTOR,
    lockSetRef: { id: stage.lockSet.lockSetId, sha256: stage.lockSet.lockSetHash },
    allowlist: ["01"],
    issuedAt: "2030-01-01T00:00:01Z",
    expiresAt: "2030-01-01T03:00:00Z",
    parentEpochHash: parent.epochHash,
    closeoutRef: null,
    aggregateSealRef: null,
    rollbackTargetEpochHash: null,
  };
  const emergencyRaw = {
    schemaId: "xw.m6-emergency-close-authorization.v1",
    authorizationId: `${label}-emergency`,
    expectedCurrentEpochHash: parent.epochHash,
    expectedParentEpochHash: parent.epochHash,
    actionEpochBindingHash: deriveM6ActionEpochBindingHash(base),
    releaseId: RELEASE,
    planHash: H("b"),
    contractHash: H("c"),
    alias: "01",
    operator: ACTOR,
    reasonCodeAllowlist: ["NORMAL_COMPLETE", "SAFETY_STOP"],
    nonce: `${label}-emergency-nonce-0001`,
    expiresAt: "2030-01-01T04:00:00Z",
  };
  const emergency = { ...emergencyRaw, authorizationHash: deriveM6EmergencyCloseAuthorizationHash(emergencyRaw) };
  writeImmutableJson(join(f.root, "m6-gate", GATE, "emergency-close", `${emergency.authorizationId}.json`), emergency);
  const epochRaw = {
    ...base,
    emergencyCloseAuthorizationRef: { id: emergency.authorizationId, sha256: emergency.authorizationHash },
  };
  const epoch = { ...epochRaw, epochHash: deriveM6V2EpochHash(epochRaw) };
  const authorization = signLiveAuthorization({
    schemaId: M64_LIVE_WINDOW_AUTHORIZATION_SCHEMA_ID,
    authorizationId: `${label}-live-window`,
    issuer: "owner:m6-gate-f-test",
    keyId: "m6-gate-f-owner-key",
    allowlistVersion: 1,
    signatureAlgorithm: "ed25519",
    nonce: `${label}-live-window-nonce-0001`,
    alias: "01",
    releaseId: RELEASE,
    releaseHash: f.releaseHash,
    sourceCommit: COMMIT,
    gateId: GATE,
    gateEpochHash: epoch.epochHash,
    gateGeneration: parent.generation + 1,
    purpose,
    scenarioManifestHash: stage.lockSet.lockHashes.scenarioManifest,
    runtimeProfileHash: stage.lockSet.lockHashes.runtimeProfile,
    modelProfileHash: stage.lockSet.lockHashes.modelProfile,
    providerHash: stage.lockSet.lockHashes.liveProvider,
    toolProfileHash: stage.lockSet.lockHashes.liveToolSpec,
    policyHash: stage.lockSet.lockHashes.grantActionPolicy,
    locksHash: stage.lockSet.lockSetHash,
    environmentAttestationHash: stage.environmentAttestationHash,
    operatorHash: stage.operatorHash,
    emergencyCloseAuthorizationHash: emergency.authorizationHash,
    emergencyCloseReasonCodeAllowlist: emergency.reasonCodeAllowlist,
    closeoutGraceMs: 60 * 60 * 1000,
    effectBoundary: "BOUNDED_READ_TRACE",
    independentOracleHash: stage.independentOracleHash,
    resetObligationsHash: stage.resetObligationsHash,
    issuedAt: "2030-01-01T00:00:00Z",
    expiresAt: "2030-01-01T01:00:00Z",
  }, f.ownerKeys.privateKey);
  return {
    ...stage,
    epoch,
    proof: gateProof(epoch, f.gateKeys.privateKey),
    emergency,
    authorization,
    package: {
      authorization,
      epoch,
      operation: "ACTIVATE",
      phase,
      proof: gateProof(epoch, f.gateKeys.privateKey),
      reasonCode: null,
    },
  };
}

function makeClose(f, active, { operation, reasonCode, label, cohortOverrides = {} }) {
  const closeoutRaw = {
    closeoutId: `${label}-closeout`,
    epochHash: active.epoch.epochHash,
    actor: ACTOR,
    reason: reasonCode,
    committedAt: "2030-01-01T00:00:02Z",
  };
  const closeout = { ...closeoutRaw, closeoutHash: deriveM6CloseoutHash(closeoutRaw) };
  writeImmutableJson(join(f.root, "m6-gate", GATE, "closeouts", `${closeout.closeoutId}.json`), closeout);
  let cohortAggregate = null;
  if (operation === "NORMAL_CLOSE") {
    const scenarioKeys = deriveM64CohortScenarioKeys(active.epoch.purpose);
    const cohortRaw = {
      schemaId: "xw.m6-4-cohort-aggregate.v1",
      purpose: active.epoch.purpose,
      alias: "01",
      expectedScenarioKeys: scenarioKeys,
      attempts: scenarioKeys.map((scenarioKey) => ({
        scenarioKey,
        alias: "01",
        status: "SUCCEEDED",
        actionCount: active.epoch.purpose === "M6_4_SHADOW" ? 0 : 1,
        transportCount: active.epoch.purpose === "M6_4_SHADOW" ? 0 : 1,
        forbiddenEffectCount: 0,
        publicEffectCount: 0,
        paymentAttemptCount: 0,
        deleteAttemptCount: 0,
      })),
      manifestHash: active.lockSet.lockHashes.scenarioManifest,
      gateEpochHash: active.epoch.epochHash,
      liveAuthorizationHash: active.authorization.envelopeHash,
      ...cohortOverrides,
    };
    cohortAggregate = { ...cohortRaw, aggregateHash: deriveM64CohortAggregateHash(cohortRaw) };
  }
  const attempts = cohortAggregate?.attempts ?? [];
  const sealPayload = {
    epochHash: active.epoch.epochHash,
    attempts,
    allowlist: ["01"],
    ...(cohortAggregate ? { cohortAggregate } : {}),
  };
  const sealHash = deriveM6AggregateSealHash(sealPayload);
  writeImmutableJson(join(f.root, "m6-gate", GATE, "aggregate", `${sealHash}.json`), {
    schemaId: "xw.m6-aggregate-closeout.v1",
    epochHash: active.epoch.epochHash,
    sealPayload,
    sealHash,
    attemptCount: attempts.length,
    aliases: ["01"],
  });
  const epochRaw = {
    schemaId: "xw.m6-live-gate.v2",
    gateId: GATE,
    mode: "CLOSED",
    purpose: active.epoch.purpose,
    status: "closed",
    releaseId: active.epoch.releaseId,
    sourceCommit: active.epoch.sourceCommit,
    actor: active.epoch.actor,
    lockSetRef: active.epoch.lockSetRef,
    allowlist: active.epoch.allowlist,
    issuedAt: "2030-01-01T00:00:02Z",
    expiresAt: "2030-01-01T05:00:00Z",
    parentEpochHash: active.epoch.epochHash,
    closeoutRef: { id: closeout.closeoutId, sha256: closeout.closeoutHash },
    aggregateSealRef: { id: sealHash, sha256: sealHash },
    rollbackTargetEpochHash: null,
    emergencyCloseAuthorizationRef: null,
  };
  const epoch = { ...epochRaw, epochHash: deriveM6V2EpochHash(epochRaw) };
  return {
    epoch,
    proof: gateProof(epoch, f.gateKeys.privateKey),
    package: {
      authorization: operation === "NORMAL_CLOSE" ? active.authorization : null,
      epoch,
      operation,
      phase: null,
      proof: gateProof(epoch, f.gateKeys.privateKey),
      reasonCode,
    },
  };
}

function assertFinalTriple(f, expectedEpoch) {
  const loaded = loadM6Gate({
    m6Root: f.root,
    gateId: GATE,
    issuerAllowlistPath: f.issuerAllowlistPath,
    requireLocks: true,
  });
  const fence = f.state.getM6GateFence();
  assertM6FileDbPointerConsistency({ loaded, fence, pointer: loaded.currentPointer });
  assert.equal(loaded.chain.at(-1).epochHash, expectedEpoch.epochHash);
  assert.equal(fence.mode, "CLOSED");
  assert.equal(loaded.currentPointer.tailEpochHash, expectedEpoch.epochHash);
}

test("Gate-F official operations run CLOSED -> GROUNDING_ONLY -> normal CLOSED -> GROUNDED_ACTION -> emergency CLOSED", () => {
  const f = seedFixture();
  try {
    const grounding = makeActivation(f, {
      purpose: "M6_4_SHADOW",
      phase: "GROUNDING_ONLY",
      label: "grounding",
    });
    const groundingOps = operationsFor(f, grounding);
    const preflight = groundingOps.preflight(grounding.package);
    assert.equal(preflight.status, "SEALED_PREFLIGHT");
    assert.equal(preflight.resourceCount, 0);
    assert.equal(f.state.getM6GateFence().generation, 0);
    assert.equal(existsSync(join(f.root, "m6-gate", GATE, "epochs", `${grounding.epoch.epochHash}.json`)), false);

    const grounded = groundingOps.apply(grounding.package);
    assert.equal(grounded.phase, "GROUNDING_ONLY");
    assert.equal(f.state.getM64LiveWindowAuthorizationConsumption(grounding.authorization.authorizationId).envelopeHash, grounding.authorization.envelopeHash);

    const normalClose = makeClose(f, grounding, {
      operation: "NORMAL_CLOSE",
      reasonCode: "NORMAL_COMPLETE",
      label: "grounding-normal",
    });
    assert.equal(groundingOps.preflight(normalClose.package).operation, "NORMAL_CLOSE");
    assert.equal(groundingOps.apply(normalClose.package).phase, "CLOSED");
    assert.equal(f.state.getM6EmergencyCloseConsumption(grounding.emergency.nonce), null);

    const action = makeActivation(f, {
      purpose: "M6_4_ACTION_SMOKE",
      phase: "GROUNDED_ACTION",
      label: "action-smoke",
    });
    const actionOps = operationsFor(f, action);
    assert.equal(actionOps.apply(action.package).phase, "GROUNDED_ACTION");

    const emergencyClose = makeClose(f, action, {
      operation: "EMERGENCY_CLOSE",
      reasonCode: "SAFETY_STOP",
      label: "action-emergency",
    });
    assert.equal(actionOps.preflight(emergencyClose.package).operation, "EMERGENCY_CLOSE");
    assert.equal(actionOps.apply(emergencyClose.package).phase, "CLOSED");
    assert.deepEqual(f.state.getM6EmergencyCloseConsumption(action.emergency.nonce), {
      nonce: action.emergency.nonce,
      authorizationHash: action.emergency.authorizationHash,
      reasonCode: "SAFETY_STOP",
      consumedAt: "2030-01-01T00:00:02.000Z",
    });
    assertFinalTriple(f, emergencyClose.epoch);
    assert.equal(actionOps.status().activeAuthorizationCount, 0);
    assert.equal(actionOps.status().actionCount, 0);
    assert.deepEqual(actionOps.status().resourceCounts, { jobs: 0, leases: 0, runs: 0, sessions: 0 });

    const auditedOps = operationsFor(f, action, { activeRunCount: () => 1 });
    assert.deepEqual(auditedOps.status().resourceCounts, { jobs: 0, leases: 0, runs: 1, sessions: 0 });

    assert.throws(() => actionOps.apply(emergencyClose.package), {
      code: "M6_GATE_FENCE_CAS_MISMATCH",
    });
    assert.equal(f.state.getM6EmergencyCloseConsumption(action.emergency.nonce).authorizationHash, action.emergency.authorizationHash);
  } finally {
    f.cleanup();
  }
});

test("Gate-F catalog selects the one inventory bound by the signed purpose and scenario manifest", () => {
  const f = seedFixture();
  try {
    const action = makeActivation(f, {
      purpose: "M6_4_ACTION_SMOKE",
      phase: "GROUNDED_ACTION",
      label: "catalog-action-smoke",
    });
    const catalogStage = buildArtifactCatalog(f, action);
    const preflight = catalogOperationsFor(f, catalogStage).preflight(action.package);
    assert.equal(preflight.status, "SEALED_PREFLIGHT");
    assert.equal(preflight.artifactCatalogHash, catalogStage.catalog.catalogHash);
    assert.equal(preflight.artifactInventoryHash, action.inventory.inventoryHash);
    assert.equal(f.state.getM64LiveWindowAuthorizationConsumption(action.authorization.authorizationId), null);
  } finally {
    f.cleanup();
  }
});

test("Gate-F FINAL runtime refuses the legacy single-inventory compatibility seam", () => {
  const f = seedFixture();
  try {
    const action = makeActivation(f, {
      purpose: "M6_4_ACTION_SMOKE",
      phase: "GROUNDED_ACTION",
      label: "final-legacy-inventory",
    });
    const ops = createM6GateFOperations({
      state: f.state,
      config: {
        runtimeMode: "FINAL",
        internalToken: TOKEN,
        m6Root: f.root,
        gateId: GATE,
        issuerAllowlistPath: f.issuerAllowlistPath,
        liveWindowIssuerAllowlistPath: f.liveWindowIssuerAllowlistPath,
        artifactInventoryPath: action.inventoryPath,
        artifactInventoryHash: action.inventory.inventoryHash,
      },
      now: () => NOW_MS,
    });
    assert.ok(ops.health().blockers.includes("M6_GATE_F_ARTIFACT_CATALOG_REQUIRED"));
    assert.throws(() => ops.preflight(action.package), { code: "M6_GATE_F_OPERATIONS_UNSEALED" });
  } finally {
    f.cleanup();
  }
});

test("Gate-F FINAL refuses activation without an exact pre-signed safety-close package", () => {
  const f = seedFixture();
  try {
    const action = makeActivation(f, {
      purpose: "M6_4_ACTION_SMOKE",
      phase: "GROUNDED_ACTION",
      label: "final-safety-required",
    });
    const catalogStage = buildArtifactCatalog(f, action);
    const ops = catalogOperationsFor(f, catalogStage, { runtimeMode: "FINAL" });
    assert.throws(() => ops.preflight(action.package), { code: "M6_GATE_SAFETY_CLOSE_REQUIRED" });
    assert.equal(f.state.getM6GateFence().generation, 0);
    assert.equal(f.state.getM64LiveWindowAuthorizationConsumption(action.authorization.authorizationId), null);
    assert.equal(f.state.getM6GateSafetyCloseArm(action.epoch.epochHash), null);
  } finally {
    f.cleanup();
  }
});

test("Gate-F FINAL verifies then atomically arms the exact package and closes after issuer revocation", () => {
  const f = seedFixture();
  try {
    const action = makeActivation(f, {
      purpose: "M6_4_ACTION_SMOKE",
      phase: "GROUNDED_ACTION",
      label: "final-safety-arm",
    });
    const safety = armActivationWithSafetyClose(f, action, "final-safety-close");
    const catalogStage = buildArtifactCatalog(f, action);
    const ops = catalogOperationsFor(f, catalogStage, { runtimeMode: "FINAL" });

    assert.equal(ops.preflight(action.package).status, "SEALED_PREFLIGHT");
    assert.equal(f.state.getM6GateSafetyCloseArm(action.epoch.epochHash), null);
    assert.equal(ops.apply(action.package).phase, "GROUNDED_ACTION");
    const armed = f.state.getM6GateSafetyCloseArm(action.epoch.epochHash);
    assert.equal(armed.status, "ARMED");
    assert.equal(armed.closeEpochHash, safety.epoch.epochHash);
    assert.equal(armed.package.epoch.epochHash, safety.epoch.epochHash);
    assert.equal(armed.armedGeneration, 1);
    assert.equal(f.state.getM64LiveWindowAuthorizationConsumption(action.authorization.authorizationId).gateGeneration, 1);

    const substituted = {
      ...safety.package,
      proof: { ...safety.package.proof, signature: `${safety.package.proof.signature.slice(0, -2)}AA` },
    };
    assert.throws(() => ops.apply(substituted), { code: "M6_GATE_SAFETY_CLOSE_ARM_MISMATCH" });
    assert.equal(f.state.getM6GateFence().mode, "GROUNDED_ACTION");
    assert.equal(f.state.getM6EmergencyCloseConsumption(action.emergency.nonce), null);

    writeJson(f.issuerAllowlistPath, {
      schemaId: "xw.m6-gate-issuer-allowlist.v1",
      version: 2,
      keys: [{
        keyId: "m6-gate-f-key",
        subject: ACTOR,
        publicKey: f.gateKeys.publicKey.export({ type: "spki", format: "pem" }),
        status: "revoked",
      }],
    });
    assert.equal(ops.status().phase, "GROUNDED_ACTION");
    assert.equal(ops.apply(safety.package).phase, "CLOSED");
    const consumed = f.state.getM6GateSafetyCloseArm(action.epoch.epochHash);
    assert.equal(consumed.status, "CONSUMED");
    assert.equal(consumed.terminalEpochHash, safety.epoch.epochHash);
    assert.equal(f.state.getM6EmergencyCloseConsumption(action.emergency.nonce).reasonCode, "SAFETY_STOP");
    assert.equal(f.state.getM6GateFence().epochHash, safety.epoch.epochHash);
    const pointer = JSON.parse(readFileSync(join(f.root, "m6-gate", GATE, "current.json"), "utf8"));
    assert.equal(pointer.tailEpochHash, safety.epoch.epochHash);
    assert.equal(pointer.generation, f.state.getM6GateFence().generation);
  } finally {
    f.cleanup();
  }
});

test("Gate-F FINAL exact armed emergency close remains fail-safe after expiry and issuer revocation", () => {
  const f = seedFixture();
  try {
    const action = makeActivation(f, {
      purpose: "M6_4_ACTION_SMOKE",
      phase: "GROUNDED_ACTION",
      label: "final-expired-fail-safe",
    });
    const safety = armActivationWithSafetyClose(f, action, "final-expired-fail-safe-close");
    const catalogStage = buildArtifactCatalog(f, action);
    const healthy = catalogOperationsFor(f, catalogStage, { runtimeMode: "FINAL" });
    healthy.apply(action.package);
    const armed = f.state.getM6GateSafetyCloseArm(action.epoch.epochHash);
    assert.equal(armed.status, "ARMED");

    writeJson(f.issuerAllowlistPath, {
      schemaId: "xw.m6-gate-issuer-allowlist.v1",
      version: 2,
      keys: [{
        keyId: "m6-gate-f-key",
        subject: ACTOR,
        publicKey: f.gateKeys.publicKey.export({ type: "spki", format: "pem" }),
        status: "revoked",
      }],
    });
    const lateNowMs = Date.parse("2030-01-01T06:00:00Z");
    assert.ok(lateNowMs > Date.parse(armed.expiresAt));
    assert.ok(lateNowMs > Date.parse(action.emergency.expiresAt));
    assert.ok(lateNowMs > Date.parse(safety.epoch.expiresAt));

    const late = catalogOperationsFor(f, catalogStage, {
      runtimeMode: "FINAL",
      now: () => lateNowMs,
    });
    late.apply(safety.package);
    const consumed = f.state.getM6GateSafetyCloseArm(action.epoch.epochHash);
    assert.equal(consumed.status, "CONSUMED");
    assert.equal(consumed.terminalEpochHash, safety.epoch.epochHash);
    assert.equal(f.state.getM6GateFence().mode, "CLOSED");
    assert.equal(f.state.getM6GateFence().epochHash, safety.epoch.epochHash);
    assert.equal(f.state.getM6EmergencyCloseConsumption(action.emergency.nonce).reasonCode, "SAFETY_STOP");
    const pointer = JSON.parse(readFileSync(join(f.root, "m6-gate", GATE, "current.json"), "utf8"));
    assert.equal(pointer.tailEpochHash, safety.epoch.epochHash);
  } finally {
    f.cleanup();
  }
});

test("Gate-F FINAL startup recovery consumes only the durable arm and is CLOSED-idempotent after restart, revocation, and expiry", () => {
  const f = seedFixture();
  let reopened = null;
  try {
    const action = makeActivation(f, {
      purpose: "M6_4_ACTION_SMOKE",
      phase: "GROUNDED_ACTION",
      label: "final-startup-recovery",
    });
    const safety = armActivationWithSafetyClose(f, action, "final-startup-recovery-safety");
    const catalogStage = buildArtifactCatalog(f, action);
    const beforeActivation = catalogOperationsFor(f, catalogStage, { runtimeMode: "FINAL" })
      .recoverArmedActive({});
    assert.equal(beforeActivation.recovery.status, "ALREADY_CLOSED");
    assert.equal(beforeActivation.recovery.priorEpochHash, beforeActivation.recovery.terminalEpochHash,
      "a CLOSED generation without an exact terminal arm signals no predecessor by equal hashes");
    catalogOperationsFor(f, catalogStage, { runtimeMode: "FINAL" }).apply(action.package);
    assert.equal(f.state.getM6GateSafetyCloseArm(action.epoch.epochHash).status, "ARMED");
    assert.deepEqual(f.state.getM6GateFResourceCounts(), {
      actionCount: 0, jobs: 0, leases: 0, sessions: 0,
    });

    writeJson(f.issuerAllowlistPath, {
      schemaId: "xw.m6-gate-issuer-allowlist.v1",
      version: 2,
      keys: [{
        keyId: "m6-gate-f-key",
        subject: ACTOR,
        publicKey: f.gateKeys.publicKey.export({ type: "spki", format: "pem" }),
        status: "revoked",
      }],
    });
    f.state.close();
    reopened = new StateStore({ dbPath: join(f.root, "control.db"), now: () => Date.parse("2030-01-01T06:00:00Z") });
    const restartedFixture = { ...f, state: reopened };
    const restarted = catalogOperationsFor(restartedFixture, catalogStage, {
      runtimeMode: "FINAL",
      now: () => Date.parse("2030-01-01T06:00:00Z"),
    });

    const result = restarted.recoverArmedActive({});
    assert.deepEqual(Object.keys(result).sort(), ["gate", "recovery"]);
    assert.deepEqual(result.recovery, {
      schemaId: "xw.m6-gate-f-armed-active-recovery.v1",
      recovered: true,
      priorEpochHash: action.epoch.epochHash,
      terminalEpochHash: safety.epoch.epochHash,
      tripleConsistent: true,
      status: "EMERGENCY_CLOSED",
    });
    assert.equal(result.gate.phase, "CLOSED");
    assert.equal(result.gate.mode, "CLOSED");
    assert.equal(result.gate.tripleConsistent, true);
    assert.equal(result.gate.actionCount, 0);
    assert.deepEqual(result.gate.resourceCounts, { jobs: 0, leases: 0, runs: 0, sessions: 0 });
    assert.equal(JSON.stringify(result).includes("signature"), false);
    assert.equal(reopened.getM6GateSafetyCloseArm(action.epoch.epochHash).status, "CONSUMED");
    assert.equal(reopened.getM6EmergencyCloseConsumption(action.emergency.nonce).reasonCode, "SAFETY_STOP");

    const idempotent = restarted.recoverArmedActive({});
    assert.deepEqual(idempotent.recovery, {
      schemaId: "xw.m6-gate-f-armed-active-recovery.v1",
      recovered: false,
      priorEpochHash: action.epoch.epochHash,
      terminalEpochHash: safety.epoch.epochHash,
      tripleConsistent: true,
      status: "ALREADY_CLOSED",
    });
    assert.equal(idempotent.gate.epochHash, safety.epoch.epochHash);
  } finally {
    try { reopened?.close(); } catch {}
    try { f.state.close(); } catch {}
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Gate-F FINAL startup recovery reconciles an exact orphan immutable close without a new action", () => {
  const f = seedFixture();
  try {
    const action = makeActivation(f, {
      purpose: "M6_4_ACTION_SMOKE",
      phase: "GROUNDED_ACTION",
      label: "final-startup-orphan-close",
    });
    const safety = armActivationWithSafetyClose(f, action, "final-startup-orphan-close-safety");
    const catalogStage = buildArtifactCatalog(f, action);
    catalogOperationsFor(f, catalogStage, { runtimeMode: "FINAL" }).apply(action.package);
    const crashing = catalogOperationsFor(f, catalogStage, {
      runtimeMode: "FINAL",
      faultAfterForOperation: (operation) => operation === "EMERGENCY_CLOSE" ? "immutableEpoch" : null,
    });
    assert.throws(() => crashing.apply(safety.package), { code: "M6_GATE_PROMOTE_FAULT" });
    assert.equal(f.state.getM6GateFence().epochHash, action.epoch.epochHash);
    assert.equal(f.state.getM6GateSafetyCloseArm(action.epoch.epochHash).status, "ARMED");
    assert.equal(f.state.getM6GateFResourceCounts().actionCount, 0);

    const recovered = catalogOperationsFor(f, catalogStage, { runtimeMode: "FINAL" }).recoverArmedActive({});
    assert.equal(recovered.recovery.recovered, true);
    assert.equal(recovered.recovery.terminalEpochHash, safety.epoch.epochHash);
    assert.equal(recovered.gate.phase, "CLOSED");
    assert.equal(f.state.getM6GateFResourceCounts().actionCount, 0);
  } finally {
    f.cleanup();
  }
});

test("Gate-F HOT_CLOSE restart reports the exact active predecessor while a live run remains externally unproven", () => {
  const f = seedFixture();
  let reopened = null;
  try {
    const action = makeActivation(f, {
      purpose: "M6_4_HOT_CLOSE",
      phase: "GROUNDED_ACTION",
      label: "hot-close-gate-closed-live-active",
    });
    const safety = armActivationWithSafetyClose(f, action, "hot-close-gate-closed-live-active-safety");
    const catalogStage = buildArtifactCatalog(f, action);
    const active = catalogOperationsFor(f, catalogStage, { runtimeMode: "FINAL" });
    active.apply(action.package);
    active.apply(safety.package);
    assert.equal(f.state.getM6GateFence().mode, "CLOSED");
    assert.equal(f.state.getM6GateSafetyCloseArm(action.epoch.epochHash).status, "CONSUMED");

    f.state.close();
    reopened = new StateStore({ dbPath: join(f.root, "control.db") });
    const restarted = catalogOperationsFor({ ...f, state: reopened }, catalogStage, {
      runtimeMode: "FINAL",
      // The restarted live-entry process cannot reconstruct the external run;
      // this counter models only the still-known in-process case and must not
      // be converted into an external zero claim.
      activeRunCount: () => 1,
    });
    const probe = restarted.recoverArmedActive({});
    assert.deepEqual(probe.recovery, {
      schemaId: "xw.m6-gate-f-armed-active-recovery.v1",
      recovered: false,
      priorEpochHash: action.epoch.epochHash,
      terminalEpochHash: safety.epoch.epochHash,
      tripleConsistent: true,
      status: "ALREADY_CLOSED",
    });
    assert.equal(probe.gate.phase, "CLOSED");
    assert.equal(probe.gate.resourceCounts.runs, 1);
    assert.equal(JSON.stringify(probe).includes("package"), false);
    assert.equal(JSON.stringify(probe).includes("signature"), false);
  } finally {
    try { reopened?.close(); } catch {}
    try { f.state.close(); } catch {}
    rmSync(f.root, { recursive: true, force: true });
  }
});

for (const recoveryDrift of [
  {
    name: "missing arm",
    mutate(f, action) {
      f.state.db.prepare("DELETE FROM m6_gate_safety_close_arms WHERE active_epoch_hash=?").run(action.epoch.epochHash);
    },
  },
  {
    name: "tampered durable package",
    mutate(f, action) {
      const arm = f.state.getM6GateSafetyCloseArm(action.epoch.epochHash);
      f.state.db.prepare("UPDATE m6_gate_safety_close_arms SET package_json=? WHERE active_epoch_hash=?")
        .run(canonicalJson({ ...arm.package, reasonCode: "REBOUND_STOP" }), action.epoch.epochHash);
    },
  },
  {
    name: "wrong arm generation",
    mutate(f, action) {
      f.state.db.prepare("UPDATE m6_gate_safety_close_arms SET armed_generation=armed_generation+1 WHERE active_epoch_hash=?")
        .run(action.epoch.epochHash);
    },
  },
  {
    name: "active fence drift",
    mutate(f) {
      f.state.db.prepare("UPDATE m6_gate_fence SET purpose='M6_4_RELIABILITY' WHERE marker='M6'").run();
    },
  },
]) {
  test(`Gate-F FINAL startup recovery refuses ${recoveryDrift.name} without continuing`, () => {
    const f = seedFixture();
    try {
      const action = makeActivation(f, {
        purpose: "M6_4_ACTION_SMOKE",
        phase: "GROUNDED_ACTION",
        label: `final-startup-drift-${recoveryDrift.name.replaceAll(" ", "-")}`,
      });
      const safety = armActivationWithSafetyClose(
        f,
        action,
        `final-startup-drift-close-${recoveryDrift.name.replaceAll(" ", "-")}`,
      );
      const catalogStage = buildArtifactCatalog(f, action);
      const operations = catalogOperationsFor(f, catalogStage, { runtimeMode: "FINAL" });
      operations.apply(action.package);
      recoveryDrift.mutate(f, action);

      assert.throws(() => operations.recoverArmedActive({}), {
        code: "M6_GATE_F_UNSAFE_RECOVERY_REQUIRED",
      });
      assert.equal(f.state.getM6GateFence().mode, "GROUNDED_ACTION");
      assert.equal(f.state.getM6EmergencyCloseConsumption(action.emergency.nonce), null);
      assert.equal(existsSync(join(f.root, "m6-gate", GATE, "epochs", `${safety.epoch.epochHash}.json`)), false);
      assert.equal(f.state.getM6GateFResourceCounts().actionCount, 0);
    } finally {
      f.cleanup();
    }
  });
}

test("Gate-F armed-active recovery route is token-gated, accepts only exact {}, and returns no arm package", async () => {
  const f = seedFixture();
  try {
    const action = makeActivation(f, {
      purpose: "M6_4_ACTION_SMOKE",
      phase: "GROUNDED_ACTION",
      label: "final-startup-recovery-route",
    });
    armActivationWithSafetyClose(f, action, "final-startup-recovery-route-safety");
    const catalogStage = buildArtifactCatalog(f, action);
    const operations = catalogOperationsFor(f, catalogStage, { runtimeMode: "FINAL" });
    operations.apply(action.package);
    const router = new ControlRouter({
      control: null,
      state: null,
      capabilities: null,
      evidence: null,
      m6GateFOperations: operations,
    });
    const request = {
      method: "POST",
      path: "/control/v1/internal/m6/gate-f/recover-armed-active",
      body: {},
      headers: { "x-control-token": TOKEN },
    };

    await assert.rejects(() => router.handle({ ...request, headers: {} }), { code: "M6_GATE_F_ACCESS_DENIED" });
    await assert.rejects(() => router.handle({ ...request, body: null }), { code: "M6_GATE_F_RECOVERY_INPUT_INVALID" });
    await assert.rejects(() => router.handle({ ...request, body: { operation: "RECOVER_ARMED_ACTIVE" } }), {
      code: "M6_GATE_F_RECOVERY_INPUT_INVALID",
    });
    assert.equal(f.state.getM6GateFence().mode, "GROUNDED_ACTION");

    const response = await router.handle(request);
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.body).sort(), ["gate", "recovery"]);
    assert.equal(response.body.recovery.recovered, true);
    assert.equal(response.body.gate.phase, "CLOSED");
    assert.equal(response.body.gate.tripleConsistent, true);
    assert.equal(JSON.stringify(response.body).includes("signature"), false);
  } finally {
    f.cleanup();
  }
});

test("Gate-F FINAL rejects a bad safety signature before immutable append or atomic arm", () => {
  const f = seedFixture();
  try {
    const action = makeActivation(f, {
      purpose: "M6_4_ACTION_SMOKE",
      phase: "GROUNDED_ACTION",
      label: "final-bad-safety-proof",
    });
    armActivationWithSafetyClose(f, action, "final-bad-safety-proof-close");
    action.package.safetyClosePackage = {
      ...action.package.safetyClosePackage,
      proof: { ...action.package.safetyClosePackage.proof, signature: Buffer.alloc(64, 7).toString("base64") },
    };
    const catalogStage = buildArtifactCatalog(f, action);
    const ops = catalogOperationsFor(f, catalogStage, { runtimeMode: "FINAL" });
    assert.throws(() => ops.preflight(action.package), { code: "M6_GATE_ISSUER_SIGNATURE_INVALID" });
    assert.equal(f.state.getM6GateFence().generation, 0);
    assert.equal(f.state.getM64LiveWindowAuthorizationConsumption(action.authorization.authorizationId), null);
    assert.equal(f.state.getM6GateSafetyCloseArm(action.epoch.epochHash), null);
    assert.equal(existsSync(join(f.root, "m6-gate", GATE, "epochs", `${action.epoch.epochHash}.json`)), false);
  } finally {
    f.cleanup();
  }
});

test("Gate-F FINAL normal close durably binds its proof for revoked-issuer status and reopen fallback", () => {
  const f = seedFixture();
  let reopened = null;
  try {
    const action = makeActivation(f, {
      purpose: "M6_4_ACTION_SMOKE",
      phase: "GROUNDED_ACTION",
      label: "final-normal-release",
    });
    const safety = armActivationWithSafetyClose(f, action, "final-normal-release-safety");
    const catalogStage = buildArtifactCatalog(f, action);
    const ops = catalogOperationsFor(f, catalogStage, { runtimeMode: "FINAL" });
    ops.apply(action.package);
    const normal = makeClose(f, action, {
      operation: "NORMAL_CLOSE",
      reasonCode: "NORMAL_COMPLETE",
      label: "final-normal-release-close",
    });
    assert.equal(ops.apply(normal.package).phase, "CLOSED");
    const released = f.state.getM6GateSafetyCloseArm(action.epoch.epochHash);
    assert.equal(released.status, "RELEASED");
    assert.equal(released.closeEpochHash, safety.epoch.epochHash);
    assert.equal(released.terminalEpochHash, normal.epoch.epochHash);
    const terminalProofHash = deriveM6GateFSafetyCloseProofHash(normal.package.proof);
    assert.equal(released.terminalProofHash, terminalProofHash);
    assert.equal(f.state.getM6EmergencyCloseConsumption(action.emergency.nonce), null);
    assert.throws(() => ops.apply(safety.package), { code: "M6_GATE_F_TRANSITION_INVALID" });

    writeJson(f.issuerAllowlistPath, {
      schemaId: "xw.m6-gate-issuer-allowlist.v1",
      version: 2,
      keys: [{
        keyId: "m6-gate-f-key",
        subject: ACTOR,
        publicKey: f.gateKeys.publicKey.export({ type: "spki", format: "pem" }),
        status: "revoked",
      }],
    });
    assert.equal(ops.status().phase, "CLOSED");

    reopened = new StateStore({ dbPath: join(f.root, "control.db"), now: () => NOW_MS });
    const reopenedOps = catalogOperationsFor({ ...f, state: reopened }, catalogStage, { runtimeMode: "FINAL" });
    assert.equal(reopenedOps.status().phase, "CLOSED");
    assert.equal(reopened.getM6GateSafetyCloseArm(action.epoch.epochHash).terminalProofHash, terminalProofHash);
    const recoveryProbe = reopenedOps.recoverArmedActive({});
    assert.equal(recoveryProbe.recovery.status, "ALREADY_CLOSED");
    assert.equal(recoveryProbe.recovery.priorEpochHash, action.epoch.epochHash);
    assert.equal(recoveryProbe.recovery.terminalEpochHash, normal.epoch.epochHash);

    reopened.db.prepare(`
      UPDATE m6_gate_safety_close_arms SET terminal_proof_hash=? WHERE active_epoch_hash=?
    `).run(H("f"), action.epoch.epochHash);
    assert.throws(() => reopenedOps.status(), { code: "M6_GATE_SAFETY_CLOSE_PROOF_DRIFT" });
    reopened.db.prepare(`
      UPDATE m6_gate_safety_close_arms SET terminal_proof_hash=? WHERE active_epoch_hash=?
    `).run(terminalProofHash, action.epoch.epochHash);

    reopened.db.prepare(`
      UPDATE m6_gate_safety_close_arms SET terminal_epoch_hash=? WHERE active_epoch_hash=?
    `).run(H("e"), action.epoch.epochHash);
    assert.throws(() => reopenedOps.status(), { code: "M6_GATE_ISSUER_PROOF_INVALID" });
    reopened.db.prepare(`
      UPDATE m6_gate_safety_close_arms SET terminal_epoch_hash=? WHERE active_epoch_hash=?
    `).run(normal.epoch.epochHash, action.epoch.epochHash);

    const terminalEpochPath = join(f.root, "m6-gate", GATE, "epochs", `${normal.epoch.epochHash}.json`);
    const terminalEpochFile = JSON.parse(readFileSync(terminalEpochPath, "utf8"));
    writeJson(terminalEpochPath, {
      ...terminalEpochFile,
      proof: { ...terminalEpochFile.proof, signature: Buffer.alloc(64, 9).toString("base64") },
    });
    assert.throws(() => reopenedOps.status(), { code: "M6_GATE_SAFETY_CLOSE_PROOF_DRIFT" });
  } finally {
    try { reopened?.close(); } catch {}
    f.cleanup();
  }
});

for (const cutpoint of ["immutableEpoch", "dbFence", "pointer"]) {
  test(`Gate-F FINAL activation reconcile preserves one atomic safety arm after ${cutpoint}`, () => {
    const f = seedFixture();
    try {
      const action = makeActivation(f, {
        purpose: "M6_4_ACTION_SMOKE",
        phase: "GROUNDED_ACTION",
        label: `final-arm-reconcile-${cutpoint}`,
      });
      armActivationWithSafetyClose(f, action, `final-arm-reconcile-close-${cutpoint}`);
      const catalogStage = buildArtifactCatalog(f, action);
      const faulting = catalogOperationsFor(f, catalogStage, {
        runtimeMode: "FINAL",
        faultAfterForOperation: (operation) => operation === "ACTIVATE" ? cutpoint : null,
      });
      assert.throws(() => faulting.apply(action.package), { code: "M6_GATE_PROMOTE_FAULT" });
      const afterFaultArm = f.state.getM6GateSafetyCloseArm(action.epoch.epochHash);
      if (cutpoint === "immutableEpoch") {
        assert.equal(afterFaultArm, null);
        assert.equal(f.state.getM64LiveWindowAuthorizationConsumption(action.authorization.authorizationId), null);
      } else {
        assert.equal(afterFaultArm.status, "ARMED");
        assert.equal(f.state.getM64LiveWindowAuthorizationConsumption(action.authorization.authorizationId).gateGeneration, 1);
      }
      assert.equal(faulting.reconcile(action.package).phase, "GROUNDED_ACTION");
      const recoveredArm = f.state.getM6GateSafetyCloseArm(action.epoch.epochHash);
      assert.equal(recoveredArm.status, "ARMED");
      assert.equal(recoveredArm.armedGeneration, 1);
    } finally {
      f.cleanup();
    }
  });
}

test("Gate-F FINAL repairs a DB-ahead armed activation after Gate and live-owner issuer revocation", () => {
  const f = seedFixture();
  try {
    const action = makeActivation(f, {
      purpose: "M6_4_ACTION_SMOKE",
      phase: "GROUNDED_ACTION",
      label: "final-activation-db-ahead-revoked",
    });
    const safety = armActivationWithSafetyClose(f, action, "final-activation-db-ahead-revoked-close");
    const catalogStage = buildArtifactCatalog(f, action);
    const faulting = catalogOperationsFor(f, catalogStage, {
      runtimeMode: "FINAL",
      faultAfterForOperation: (operation) => operation === "ACTIVATE" ? "dbFence" : null,
    });
    assert.throws(() => faulting.apply(action.package), { code: "M6_GATE_PROMOTE_FAULT" });
    assert.equal(f.state.getM6GateFence().epochHash, action.epoch.epochHash);
    assert.equal(f.state.getM6GateSafetyCloseArm(action.epoch.epochHash).status, "ARMED");
    assert.equal(f.state.getM64LiveWindowAuthorizationConsumption(action.authorization.authorizationId).gateGeneration, 1);

    writeJson(f.issuerAllowlistPath, {
      schemaId: "xw.m6-gate-issuer-allowlist.v1",
      version: 2,
      keys: [{
        keyId: "m6-gate-f-key",
        subject: ACTOR,
        publicKey: f.gateKeys.publicKey.export({ type: "spki", format: "pem" }),
        status: "revoked",
      }],
    });
    writeJson(f.liveWindowIssuerAllowlistPath, {
      schemaId: "xw.m6-4-live-window-issuer-allowlist.v1",
      version: 2,
      keys: [{
        issuer: "owner:m6-gate-f-test",
        keyId: "m6-gate-f-owner-key",
        publicKey: f.ownerKeys.publicKey.export({ type: "spki", format: "pem" }),
        status: "revoked",
      }],
    });

    const recovered = faulting.reconcile(action.package);
    assert.equal(recovered.phase, "GROUNDED_ACTION");
    assert.equal(recovered.reconciled, true);
    assert.equal(f.state.getM6GateSafetyCloseArm(action.epoch.epochHash).status, "ARMED");
    const pointer = JSON.parse(readFileSync(join(f.root, "m6-gate", GATE, "current.json"), "utf8"));
    assert.equal(pointer.tailEpochHash, action.epoch.epochHash);
    assert.equal(faulting.apply(safety.package).phase, "CLOSED");
    assert.equal(f.state.getM6GateSafetyCloseArm(action.epoch.epochHash).status, "CONSUMED");
  } finally {
    f.cleanup();
  }
});

test("Gate-F FINAL reconciles a DB-committed armed emergency close after issuer revocation", () => {
  const f = seedFixture();
  try {
    const action = makeActivation(f, {
      purpose: "M6_4_ACTION_SMOKE",
      phase: "GROUNDED_ACTION",
      label: "final-close-reconcile-revoked",
    });
    const safety = armActivationWithSafetyClose(f, action, "final-close-reconcile-revoked-safety");
    const catalogStage = buildArtifactCatalog(f, action);
    const healthy = catalogOperationsFor(f, catalogStage, { runtimeMode: "FINAL" });
    healthy.apply(action.package);
    const faulting = catalogOperationsFor(f, catalogStage, {
      runtimeMode: "FINAL",
      faultAfterForOperation: (operation) => operation === "EMERGENCY_CLOSE" ? "dbFence" : null,
    });
    assert.throws(() => faulting.apply(safety.package), { code: "M6_GATE_PROMOTE_FAULT" });
    assert.equal(f.state.getM6GateFence().epochHash, safety.epoch.epochHash);
    assert.equal(f.state.getM6GateSafetyCloseArm(action.epoch.epochHash).status, "CONSUMED");

    writeJson(f.issuerAllowlistPath, {
      schemaId: "xw.m6-gate-issuer-allowlist.v1",
      version: 2,
      keys: [{
        keyId: "m6-gate-f-key",
        subject: ACTOR,
        publicKey: f.gateKeys.publicKey.export({ type: "spki", format: "pem" }),
        status: "revoked",
      }],
    });
    assert.equal(faulting.reconcile(safety.package).phase, "CLOSED");
    const pointer = JSON.parse(readFileSync(join(f.root, "m6-gate", GATE, "current.json"), "utf8"));
    assert.equal(pointer.tailEpochHash, safety.epoch.epochHash);
    assert.equal(pointer.generation, f.state.getM6GateFence().generation);
  } finally {
    f.cleanup();
  }
});

test("Gate-F catalog rejects missing, extra, duplicate/order, raw, semantic, selection, and cross-release drift", async (t) => {
  const cases = [
    {
      name: "missing-purpose",
      expected: "M6_GATE_F_CATALOG_INVALID",
      mutate({ catalogStage }) { catalogStage.catalog.entries.pop(); },
    },
    {
      name: "extra-purpose",
      expected: "M6_GATE_F_CATALOG_INVALID",
      mutate({ catalogStage }) { catalogStage.catalog.entries.push({ ...catalogStage.catalog.entries.at(-1) }); },
    },
    {
      name: "duplicate-and-order-drift",
      expected: "M6_GATE_F_CATALOG_ORDER_INVALID",
      mutate({ catalogStage }) { catalogStage.catalog.entries[1].purpose = "M6_4_SHADOW"; },
    },
    {
      name: "order-drift",
      expected: "M6_GATE_F_CATALOG_ORDER_INVALID",
      mutate({ catalogStage }) {
        [catalogStage.catalog.entries[0], catalogStage.catalog.entries[1]] = [catalogStage.catalog.entries[1], catalogStage.catalog.entries[0]];
      },
    },
    {
      name: "inventory-raw-hash-drift",
      expected: "M6_GATE_F_CATALOG_INVENTORY_RAW_HASH_MISMATCH",
      mutate({ action }) { writeFileSync(action.inventoryPath, Buffer.concat([readFileSync(action.inventoryPath), Buffer.from("\n")])); },
      reseal: false,
    },
    {
      name: "inventory-semantic-hash-drift",
      expected: "M6_GATE_F_INVENTORY_HASH_MISMATCH",
      mutate({ catalogStage }) {
        catalogStage.catalog.entries.find((entry) => entry.purpose === "M6_4_ACTION_SMOKE").inventoryHash = H("f");
      },
    },
    {
      name: "signed-selection-drift",
      expected: "M6_GATE_F_CATALOG_SELECTION_INVALID",
      mutate({ action }) { action.package.authorization = { ...action.package.authorization, purpose: "M6_4_RELIABILITY" }; },
      reseal: false,
    },
    {
      name: "cross-release",
      expected: "M6_GATE_F_CATALOG_RELEASE_MISMATCH",
      mutate({ catalogStage }) { catalogStage.catalog.release.releaseId = "another-release"; },
    },
    {
      name: "self-consistent-release-root-rebound",
      expected: "M6_GATE_F_CATALOG_RELEASE_PROVENANCE_MISMATCH",
      mutate({ f, catalogStage }) {
        const reboundRoot = join(f.root, "rebound-release");
        const reboundManifestPath = writeJson(join(reboundRoot, "release-manifest.v1.json"), {
          schemaId: "xw.release.manifest.v1",
          releaseId: RELEASE,
          sourceCommit: COMMIT,
        });
        for (let index = 0; index < catalogStage.stages.length; index += 1) {
          const stage = catalogStage.stages[index];
          stage.inventory.release = { root: reboundRoot, manifestPath: reboundManifestPath };
          stage.inventory.inventoryHash = deriveM6GateFArtifactInventoryHash(stage.inventory);
          writeJson(stage.inventoryPath, stage.inventory);
          catalogStage.catalog.entries[index].inventoryHash = stage.inventory.inventoryHash;
          catalogStage.catalog.entries[index].inventorySha256 = hashFile(stage.inventoryPath);
        }
      },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, () => {
      const f = seedFixture();
      try {
        const action = makeActivation(f, {
          purpose: "M6_4_ACTION_SMOKE",
          phase: "GROUNDED_ACTION",
          label: `catalog-reject-${item.name}`,
        });
        const catalogStage = buildArtifactCatalog(f, action);
        item.mutate({ f, action, catalogStage });
        if (item.reseal !== false) {
          catalogStage.catalog.catalogHash = deriveM6GateFArtifactCatalogHash(catalogStage.catalog);
          writeJson(catalogStage.catalogPath, catalogStage.catalog);
        }
        const ops = catalogOperationsFor(f, catalogStage);
        assert.throws(() => ops.preflight(action.package), { code: item.expected });
        assert.equal(f.state.getM6GateFence().generation, 0);
        assert.equal(f.state.getM64LiveWindowAuthorizationConsumption(action.authorization.authorizationId), null);
      } finally {
        f.cleanup();
      }
    });
  }
});

test("Gate-F internal API is token-gated and route-closes activation versus close operations", async () => {
  const f = seedFixture();
  try {
    const action = makeActivation(f, {
      purpose: "M6_4_ACTION_SMOKE",
      phase: "GROUNDED_ACTION",
      label: "router-surface",
    });
    const ops = operationsFor(f, action);
    const router = new ControlRouter({
      control: null,
      state: null,
      capabilities: null,
      evidence: null,
      m6GateFOperations: ops,
    });
    await assert.rejects(() => router.handle({
      method: "POST",
      path: "/control/v1/internal/m6/gate-f/preflight",
      body: action.package,
      headers: {},
    }), { code: "M6_GATE_F_ACCESS_DENIED" });
    const preflight = await router.handle({
      method: "POST",
      path: "/control/v1/internal/m6/gate-f/preflight",
      body: action.package,
      headers: { "x-control-token": TOKEN },
    });
    assert.equal(preflight.status, 200);
    assert.equal(preflight.body.preflight.status, "SEALED_PREFLIGHT");
    await assert.rejects(() => router.handle({
      method: "POST",
      path: "/control/v1/internal/m6/gate-f/close",
      body: action.package,
      headers: { "x-control-token": TOKEN },
    }), { code: "M6_GATE_F_INPUT_INVALID" });
    const activation = await router.handle({
      method: "POST",
      path: "/control/v1/internal/m6/gate-f/activate",
      body: action.package,
      headers: { "x-control-token": TOKEN },
    });
    assert.equal(activation.status, 200);
    assert.equal(activation.body.promotion.phase, "GROUNDED_ACTION");
  } finally {
    f.cleanup();
  }
});

test("Gate-F activation rejects a wrong owner authorization before immutable append or atomic consumption", () => {
  const f = seedFixture();
  try {
    const action = makeActivation(f, {
      purpose: "M6_4_ACTION_SMOKE",
      phase: "GROUNDED_ACTION",
      label: "wrong-owner-auth",
    });
    const ops = operationsFor(f, action);
    const wrong = {
      ...action.package,
      authorization: { ...action.authorization, providerHash: H("f") },
    };
    assert.throws(() => ops.preflight(wrong), { code: "M64_LIVE_AUTH_BODY_HASH_INVALID" });
    assert.equal(f.state.getM6GateFence().generation, 0);
    assert.equal(f.state.getM64LiveWindowAuthorizationConsumption(action.authorization.authorizationId), null);
    assert.equal(existsSync(join(f.root, "m6-gate", GATE, "epochs", `${action.epoch.epochHash}.json`)), false);
  } finally {
    f.cleanup();
  }
});

test("Gate-F activation rejects an orphan active run before immutable append or authorization consumption", () => {
  const f = seedFixture();
  try {
    const action = makeActivation(f, {
      purpose: "M6_4_ACTION_SMOKE",
      phase: "GROUNDED_ACTION",
      label: "orphan-run",
    });
    const ops = operationsFor(f, action, { activeRunCount: () => 1 });
    assert.throws(() => ops.preflight(action.package), { code: "M6_GATE_F_RESOURCES_NOT_ZERO" });
    assert.equal(f.state.getM6GateFence().generation, 0);
    assert.equal(f.state.getM64LiveWindowAuthorizationConsumption(action.authorization.authorizationId), null);
    assert.equal(existsSync(join(f.root, "m6-gate", GATE, "epochs", `${action.epoch.epochHash}.json`)), false);
  } finally {
    f.cleanup();
  }
});

test("Gate-F activation recomputes locked artifacts, release contents, and qualified target membership", () => {
  const f = seedFixture();
  try {
    const action = makeActivation(f, {
      purpose: "M6_4_ACTION_SMOKE",
      phase: "GROUNDED_ACTION",
      label: "actual-artifact-drift",
    });
    const ops = operationsFor(f, action);
    const runtimeProfilePath = action.inventory.lockArtifacts.runtimeProfile.path;
    const originalRuntimeProfile = readFileSync(runtimeProfilePath);
    writeFileSync(runtimeProfilePath, "drifted runtime profile\n", "utf8");
    assert.throws(() => ops.preflight(action.package), { code: "M6_GATE_F_LOCK_MISMATCH" });
    writeFileSync(runtimeProfilePath, originalRuntimeProfile);

    const releasePayloadPath = join(f.releaseRoot, "runtime.txt");
    const originalReleasePayload = readFileSync(releasePayloadPath);
    writeFileSync(releasePayloadPath, "drifted release\n", "utf8");
    assert.throws(() => ops.preflight(action.package), { code: "M6_GATE_F_RELEASE_MISMATCH" });
    writeFileSync(releasePayloadPath, originalReleasePayload);

    const environmentPath = action.inventory.runtimeArtifacts.environmentAttestation.path;
    const originalEnvironment = readFileSync(environmentPath);
    const unqualifiedEnvironment = deriveTargetEnvironmentAttestation({
      appPackageHash: H("f"), appBuildHash: H("2"), signingHash: H("3"), osBuildHash: H("4"),
      displayHash: H("5"), localeThemeHash: H("6"), imeHash: H("7"), accessibilityHash: H("8"),
      accountBindingHash: H("9"),
      accountIsolationHash: H("9"), capturedAt: "2030-01-01T00:00:00Z", expiresAt: "2030-01-01T06:00:00Z",
    });
    writeJson(environmentPath, unqualifiedEnvironment);
    assert.throws(() => ops.preflight(action.package), { code: "M6_GATE_F_ENVIRONMENT_NOT_QUALIFIED" });
    writeFileSync(environmentPath, originalEnvironment);

    assert.equal(f.state.getM6GateFence().generation, 0);
    assert.equal(f.state.getM64LiveWindowAuthorizationConsumption(action.authorization.authorizationId), null);
  } finally {
    f.cleanup();
  }
});

test("Gate-F normal close rejects a validly hashed cohort aggregate rebound to another manifest", () => {
  const f = seedFixture();
  try {
    const grounding = makeActivation(f, {
      purpose: "M6_4_SHADOW",
      phase: "GROUNDING_ONLY",
      label: "normal-close-cross-bind",
    });
    const ops = operationsFor(f, grounding);
    ops.apply(grounding.package);
    const close = makeClose(f, grounding, {
      operation: "NORMAL_CLOSE",
      reasonCode: "NORMAL_COMPLETE",
      label: "normal-close-cross-bind",
      cohortOverrides: { manifestHash: H("f") },
    });
    assert.throws(() => ops.preflight(close.package), { code: "M6_GATE_F_NORMAL_CLOSE_AGGREGATE_INVALID" });
    assert.equal(f.state.getM6GateFence().epochHash, grounding.epoch.epochHash);
    assert.equal(f.state.getM6GateFence().mode, "OBSERVE_ONLY");
  } finally {
    f.cleanup();
  }
});

for (const cutpoint of ["immutableEpoch", "dbFence", "pointer"]) {
  test(`Gate-F reconcile repairs activation after ${cutpoint} cutpoint, consumes owner auth once, then emergency-closes`, () => {
    const f = seedFixture();
    try {
      const action = makeActivation(f, {
        purpose: "M6_4_ACTION_SMOKE",
        phase: "GROUNDED_ACTION",
        label: `activate-${cutpoint}`,
      });
      const faultingOps = operationsFor(f, action, {
        faultAfterForOperation: (operation) => operation === "ACTIVATE" ? cutpoint : null,
      });
      assert.throws(() => faultingOps.apply(action.package), { code: "M6_GATE_PROMOTE_FAULT" });
      const recovered = faultingOps.reconcile(action.package);
      assert.equal(recovered.phase, "GROUNDED_ACTION");
      assert.equal(recovered.reconciled, true);
      const ownerConsumption = f.state.getM64LiveWindowAuthorizationConsumption(action.authorization.authorizationId);
      assert.equal(ownerConsumption.envelopeHash, action.authorization.envelopeHash);
      assert.equal(ownerConsumption.gateGeneration, 1);

      const emergencyClose = makeClose(f, action, {
        operation: "EMERGENCY_CLOSE",
        reasonCode: "SAFETY_STOP",
        label: `activate-recovery-close-${cutpoint}`,
      });
      assert.equal(operationsFor(f, action).apply(emergencyClose.package).phase, "CLOSED");
      assertFinalTriple(f, emergencyClose.epoch);
    } finally {
      f.cleanup();
    }
  });
}

for (const cutpoint of ["immutableEpoch", "dbFence", "pointer"]) {
  test(`Gate-F reconcile repairs emergency close after ${cutpoint} cutpoint and leaves exact CLOSED triple`, () => {
    const f = seedFixture();
    try {
      const action = makeActivation(f, {
        purpose: "M6_4_ACTION_SMOKE",
        phase: "GROUNDED_ACTION",
        label: `cutpoint-${cutpoint}`,
      });
      const healthyOps = operationsFor(f, action);
      healthyOps.apply(action.package);
      const emergencyClose = makeClose(f, action, {
        operation: "EMERGENCY_CLOSE",
        reasonCode: "SAFETY_STOP",
        label: `close-${cutpoint}`,
      });
      const faultingOps = operationsFor(f, action, {
        faultAfterForOperation: (operation) => operation === "EMERGENCY_CLOSE" ? cutpoint : null,
      });
      assert.throws(() => faultingOps.apply(emergencyClose.package), { code: "M6_GATE_PROMOTE_FAULT" });

      const recovered = faultingOps.reconcile(emergencyClose.package);
      assert.equal(recovered.phase, "CLOSED");
      assert.equal(recovered.reconciled, true);
      assertFinalTriple(f, emergencyClose.epoch);
      assert.equal(f.state.getM6EmergencyCloseConsumption(action.emergency.nonce).reasonCode, "SAFETY_STOP");
    } finally {
      f.cleanup();
    }
  });
}
