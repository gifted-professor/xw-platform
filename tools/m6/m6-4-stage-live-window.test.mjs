import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  M64_LIVE_WINDOW_AUTHORIZATION_SCHEMA_ID,
  canonicalM64LiveWindowAuthorizationSigningBytes,
  deriveM64LiveWindowAuthorizationBodyHash,
  deriveM64LiveWindowAuthorizationEnvelopeHash,
  selectM64LiveWindowRuntimeBinding,
} from "../../packages/kernel/lib/m6-4-live-window-authorization.mjs";
import { deriveM6AggregateSealHash } from "../../packages/kernel/lib/m6-aggregate-closeout.mjs";
import { canonicalJson, sha256, writeImmutableJson } from "../../services/control-plane/control-plane/lib/m6-gate-loader.mjs";
import { deriveM6CloseoutHash, deriveM6EpochHash } from "../../services/control-plane/control-plane/lib/m6-live-gate.mjs";
import {
  deriveM6V2EpochHash,
  deriveM6V2LockSetHash,
  M6_GATE_V2_LOCK_KINDS,
} from "../../services/control-plane/control-plane/lib/m6-live-gate-v2.mjs";
import { loadGateIssuerAllowlist, verifyEpochProof } from "../../services/control-plane/control-plane/lib/m6-issuer-allowlist.mjs";
import {
  loadM64LiveWindowIssuerAllowlist,
  verifyM64LiveWindowAuthorization,
} from "../../services/control-plane/control-plane/lib/m6-live-window-authorization.mjs";
import {
  acquireM6C1StoppedRuntimeGuard,
  m6C1RuntimeOwnerLockPath,
} from "../../services/control-plane/control-plane/lib/m6-c1-runtime-owner-lock.mjs";
import { StateStore } from "../../services/control-plane/control-plane/lib/state-store.mjs";
import {
  deriveM6GateFArtifactCatalogHash,
  deriveM6GateFArtifactInventoryHash,
} from "../../services/control-plane/control-plane/lib/m6-gate-f-operations.mjs";
import {
  RECOVERABLE_PUBLICATION_CUTS,
} from "./lib/recoverable-create-only-publication.mjs";
import {
  acquireM64StoppedControlPlaneGuard,
  openM64ReadOnlyGateState,
  stageM64LiveWindow,
} from "./m6-4-stage-live-window.mjs";
import {
  assembleM64FinalProductionArtifacts,
  M64_FINAL_ASSEMBLER_INPUT_SCHEMA_ID,
} from "./m6-4-production-release-assembler.mjs";

const NOW_MS = Date.parse("2030-01-01T00:00:10Z");
const RELEASE = "m6-stage-window-release";
const COMMIT = "a".repeat(40);
const GATE = "m6-stage-window-gate";
const ACTOR = "operator:m6-stage-window-test";
const H = (char) => char.repeat(64);
const PURPOSES = Object.freeze([
  "M6_4_SHADOW", "M6_4_HOT_CLOSE", "M6_4_ACTION_SMOKE", "M6_4_RELIABILITY", "M6_4_SMOOTH",
]);
const MANIFESTS = Object.freeze({
  M6_4_SHADOW: fileURLToPath(new URL("../../artifacts/m6-4/cohort-manifests/m6_4_shadow.json", import.meta.url)),
  M6_4_HOT_CLOSE: fileURLToPath(new URL("../../artifacts/m6-4/cohort-manifests/m6_4_hot_close.json", import.meta.url)),
  M6_4_ACTION_SMOKE: fileURLToPath(new URL("../../artifacts/m6-4/cohort-manifests/m6_4_action_smoke.json", import.meta.url)),
  M6_4_RELIABILITY: fileURLToPath(new URL("../../artifacts/m6-4/cohort-manifests/m6_4_reliability.json", import.meta.url)),
  M6_4_SMOOTH: fileURLToPath(new URL("../../artifacts/m6-4/cohort-manifests/m6_4_smooth.json", import.meta.url)),
});

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

function hashFile(path) {
  return sha256(readFileSync(path));
}

function gateProof(epoch, privateKey) {
  return {
    keyId: "m6-stage-gate-key",
    subject: ACTOR,
    allowlistVersion: 1,
    signature: sign(null, Buffer.from(epoch.epochHash, "hex"), privateKey).toString("base64"),
    algorithm: "ed25519",
  };
}

function signAuthorization(body, privateKey) {
  const withBodyHash = { ...body, bodyHash: deriveM64LiveWindowAuthorizationBodyHash(body) };
  const withSignature = {
    ...withBodyHash,
    signature: sign(null, canonicalM64LiveWindowAuthorizationSigningBytes(withBodyHash), privateKey).toString("base64"),
  };
  return { ...withSignature, envelopeHash: deriveM64LiveWindowAuthorizationEnvelopeHash(withSignature) };
}

function seedRelease(root) {
  const releaseRoot = join(root, "releases", RELEASE);
  mkdirSync(releaseRoot, { recursive: true });
  const payloadPath = join(releaseRoot, "runtime.txt");
  writeFileSync(payloadPath, "sealed test runtime\n", "utf8");
  const manifestPath = writeJson(join(releaseRoot, "release-manifest.v1.json"), {
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
      sha256: hashFile(payloadPath),
    }],
    runtimeCutoverAllowed: false,
  });
  return { releaseRoot, manifestPath, manifestSha256: hashFile(manifestPath) };
}

function seedGate(root, state, gateKeys) {
  const v1Locks = { runtimeProfile: H("1"), hardRedlinePolicy: H("2"), groundingRuntime: H("3") };
  writeJson(join(root, "m6-gate", "locks.v1.json"), {
    schemaId: "xw.m6-locks.v1", releaseId: RELEASE, sourceCommit: COMMIT, lockHashes: v1Locks,
  });
  const observedHash = H("4");
  const closeoutRaw = {
    closeoutId: "seed-closeout", epochHash: observedHash, actor: ACTOR,
    reason: "SEED_CLOSED", committedAt: "2030-01-01T00:00:00Z",
  };
  const closeout = { ...closeoutRaw, closeoutHash: deriveM6CloseoutHash(closeoutRaw) };
  writeJson(join(root, "m6-gate", GATE, "closeouts", "seed-closeout.json"), closeout);
  const sealPayload = { epochHash: observedHash, attempts: [], allowlist: ["01"] };
  const sealHash = deriveM6AggregateSealHash(sealPayload);
  writeJson(join(root, "m6-gate", GATE, "aggregate", `${sealHash}.json`), {
    schemaId: "xw.m6-aggregate-closeout.v1", epochHash: observedHash,
    sealPayload, sealHash, attemptCount: 0, aliases: ["01"],
  });
  const raw = {
    schemaId: "xw.m6-live-gate.v1", gateId: GATE, mode: "CLOSED", status: "closed",
    releaseId: RELEASE, sourceCommit: COMMIT, actor: ACTOR, lockHashes: v1Locks, allowlist: ["01"],
    issuedAt: "2030-01-01T00:00:00Z", expiresAt: "2030-01-02T00:00:00Z", parentEpochHash: null,
    closeoutRef: { id: closeout.closeoutId, sha256: closeout.closeoutHash },
    aggregateSealRef: { id: sealHash, sha256: sealHash }, rollbackTargetEpochHash: null,
  };
  const seed = { ...raw, epochHash: deriveM6EpochHash(raw) };
  writeImmutableJson(join(root, "m6-gate", GATE, "epochs", `${seed.epochHash}.json`), {
    ...seed, proof: gateProof(seed, gateKeys.privateKey),
  });
  writeJson(join(root, "m6-gate", GATE, "current.json"), {
    chain: [seed.epochHash], tailEpochHash: seed.epochHash, generation: 0, promotedAt: "2030-01-01T00:00:00Z",
  });
  state.seedM6GateFence({
    epoch: seed,
    locksHash: sha256(`xw.m6-locks.v1:${canonicalJson(seed.lockHashes)}`),
  });
  return seed;
}

function seedArtifacts(root, release) {
  const artifactRoot = join(root, "state", "control-plane", "gate-f-artifacts");
  const manifestRoot = join(root, "state", "control-plane", "cohort-manifests");
  const modelProfileRoot = join(root, "state", "control-plane", "model-profiles");
  mkdirSync(modelProfileRoot, { recursive: true });
  const commonLocks = {};
  const commonDescriptors = {};
  for (const kind of M6_GATE_V2_LOCK_KINDS) {
    if (["scenarioManifest", "modelProfile", "environmentQualification"].includes(kind)) continue;
    const path = join(artifactRoot, "locks", `${kind}.json`);
    writeJson(path, { schemaId: `xw.test.${kind}.v1`, sealed: true });
    commonDescriptors[kind] = { mode: "RAW_SHA256", path };
    commonLocks[kind] = hashFile(path);
  }
  commonDescriptors.modelProfile = { mode: "LIVE_MODEL_PROFILE", path: modelProfileRoot };
  commonLocks.modelProfile = H("d");
  const targetEnvironmentAttestationPath = writeJson(join(artifactRoot, "environment-attestation.json"), {
    schemaId: "xw.m6-target-environment-attestation.v1", attestationHash: H("e"), sealed: true,
  });
  const environmentQualificationPath = writeJson(join(artifactRoot, "environment-qualification.json"), {
    schemaId: "xw.m6-environment-qualification.v1", status: "QUALIFIED", sealed: true,
  });
  commonDescriptors.environmentQualification = { mode: "ENVIRONMENT_QUALIFICATION", path: environmentQualificationPath };
  commonLocks.environmentQualification = hashFile(environmentQualificationPath);
  const runtimeArtifacts = {
    environmentAttestation: { mode: "TARGET_ENV_ATTESTATION", path: targetEnvironmentAttestationPath },
  };
  const runtimeHashes = {};
  for (const kind of ["operator", "independentOracle", "resetObligations"]) {
    const path = writeJson(join(artifactRoot, `${kind}.json`), { schemaId: `xw.test.${kind}.v1`, sealed: true });
    runtimeArtifacts[kind] = { mode: "RAW_SHA256", path };
    runtimeHashes[kind] = hashFile(path);
  }
  const stages = new Map();
  for (const [index, purpose] of PURPOSES.entries()) {
    const manifestPath = join(manifestRoot, `${purpose.toLowerCase()}.json`);
    mkdirSync(dirname(manifestPath), { recursive: true });
    cpSync(MANIFESTS[purpose], manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const lockArtifacts = {
      ...commonDescriptors,
      scenarioManifest: { mode: "M6_COHORT_MANIFEST", path: manifestPath },
    };
    const lockHashes = { ...commonLocks, scenarioManifest: manifest.manifestHash };
    const lockRaw = { schemaId: "xw.m6-locks.v2", lockSetId: `stage-window-${index + 1}`, lockHashes };
    const lockSet = { ...lockRaw, lockSetHash: deriveM6V2LockSetHash(lockRaw) };
    writeJson(join(root, "m6-gate", "locks.v2", `${lockSet.lockSetId}.json`), lockSet);
    const inventoryRaw = {
      schemaId: "xw.m6-gate-f-artifact-inventory.v1",
      release: { root: release.releaseRoot, manifestPath: release.manifestPath },
      lockArtifacts,
      runtimeArtifacts,
    };
    const inventory = { ...inventoryRaw, inventoryHash: deriveM6GateFArtifactInventoryHash(inventoryRaw) };
    const inventoryPath = writeJson(join(artifactRoot, `inventory-${index + 1}.json`), inventory);
    stages.set(purpose, { inventory, inventoryPath, lockSet, manifest });
  }
  const catalogRaw = {
    schemaId: "xw.m6-gate-f-artifact-catalog.v1",
    release: { releaseId: RELEASE, sourceCommit: COMMIT },
    entries: PURPOSES.map((purpose) => {
      const stage = stages.get(purpose);
      return {
        purpose,
        scenarioManifestHash: stage.manifest.manifestHash,
        inventoryPath: stage.inventoryPath,
        inventorySha256: hashFile(stage.inventoryPath),
        inventoryHash: stage.inventory.inventoryHash,
      };
    }),
  };
  const catalog = { ...catalogRaw, catalogHash: deriveM6GateFArtifactCatalogHash(catalogRaw) };
  const catalogPath = writeJson(join(artifactRoot, "catalog.json"), catalog);
  return {
    stages, catalog, catalogPath, manifestRoot, modelProfileRoot,
    targetEnvironmentAttestationPath, environmentQualificationPath, runtimeHashes,
  };
}

function makeActivation(f, purpose) {
  const stage = f.artifacts.stages.get(purpose);
  const parent = f.state.getM6GateFence();
  const label = purpose.toLowerCase();
  const epochRaw = {
    schemaId: "xw.m6-live-gate.v2", gateId: GATE,
    mode: purpose === "M6_4_SHADOW" ? "OBSERVE_ONLY" : "GROUNDED_ACTION",
    purpose, status: "active", releaseId: RELEASE, sourceCommit: COMMIT, actor: ACTOR,
    lockSetRef: { id: stage.lockSet.lockSetId, sha256: stage.lockSet.lockSetHash }, allowlist: ["01"],
    issuedAt: "2030-01-01T00:00:01Z", expiresAt: "2030-01-01T03:00:00Z",
    parentEpochHash: parent.epochHash, closeoutRef: null, aggregateSealRef: null,
    rollbackTargetEpochHash: null,
    emergencyCloseAuthorizationRef: { id: `${label}-emergency`, sha256: H("9") },
  };
  const epoch = { ...epochRaw, epochHash: deriveM6V2EpochHash(epochRaw) };
  const authorization = signAuthorization({
    schemaId: M64_LIVE_WINDOW_AUTHORIZATION_SCHEMA_ID,
    authorizationId: `${label}-authorization`, issuer: "owner:m6-stage-window-test",
    keyId: "m6-stage-owner-key", allowlistVersion: 1, signatureAlgorithm: "ed25519",
    nonce: `${label}-nonce-0000000001`, alias: "01", releaseId: RELEASE,
    releaseHash: f.release.manifestSha256, sourceCommit: COMMIT, gateId: GATE,
    gateEpochHash: epoch.epochHash, gateGeneration: parent.generation + 1, purpose,
    scenarioManifestHash: stage.lockSet.lockHashes.scenarioManifest,
    runtimeProfileHash: stage.lockSet.lockHashes.runtimeProfile,
    modelProfileHash: stage.lockSet.lockHashes.modelProfile,
    providerHash: stage.lockSet.lockHashes.liveProvider,
    toolProfileHash: stage.lockSet.lockHashes.liveToolSpec,
    policyHash: stage.lockSet.lockHashes.grantActionPolicy,
    locksHash: stage.lockSet.lockSetHash,
    environmentAttestationHash: H("e"), operatorHash: f.artifacts.runtimeHashes.operator,
    emergencyCloseAuthorizationHash: H("9"),
    emergencyCloseReasonCodeAllowlist: ["NORMAL_COMPLETE", "SAFETY_STOP"],
    closeoutGraceMs: 60 * 60 * 1000, effectBoundary: "BOUNDED_READ_TRACE",
    independentOracleHash: f.artifacts.runtimeHashes.independentOracle,
    resetObligationsHash: f.artifacts.runtimeHashes.resetObligations,
    issuedAt: "2030-01-01T00:00:00Z", expiresAt: "2030-01-01T01:00:00Z",
  }, f.ownerKeys.privateKey);
  const closeRaw = {
    schemaId: "xw.m6-live-gate.v2", gateId: GATE, mode: "CLOSED", purpose, status: "closed",
    releaseId: RELEASE, sourceCommit: COMMIT, actor: ACTOR, lockSetRef: epoch.lockSetRef, allowlist: ["01"],
    issuedAt: "2030-01-01T00:30:00Z", expiresAt: "2030-01-01T05:00:00Z",
    parentEpochHash: epoch.epochHash,
    closeoutRef: { id: `${label}-safety-closeout`, sha256: H("7") },
    aggregateSealRef: { id: H("8"), sha256: H("8") }, rollbackTargetEpochHash: null,
    emergencyCloseAuthorizationRef: null,
  };
  const closeEpoch = { ...closeRaw, epochHash: deriveM6V2EpochHash(closeRaw) };
  const safetyClosePackage = {
    authorization: null,
    epoch: closeEpoch,
    operation: "EMERGENCY_CLOSE",
    phase: null,
    proof: gateProof(closeEpoch, f.gateKeys.privateKey),
    reasonCode: "SAFETY_STOP",
  };
  return {
    epoch,
    proof: gateProof(epoch, f.gateKeys.privateKey),
    authorization,
    safetyClosePackage,
    package: {
      authorization, epoch, operation: "ACTIVATE",
      phase: purpose === "M6_4_SHADOW" ? "GROUNDING_ONLY" : "GROUNDED_ACTION",
      proof: gateProof(epoch, f.gateKeys.privateKey), reasonCode: null, safetyClosePackage,
    },
  };
}

function writeInputs(f, action) {
  writeJson(f.authorizationPath, action.authorization);
  writeJson(f.candidatePath, action.package);
}

function writeFinalBinding(f) {
  f.binding.gateFArtifactCatalogHash = f.artifacts.catalog.catalogHash;
  f.binding.gateFArtifactCatalogSha256 = hashFile(f.artifacts.catalogPath);
  writeJson(f.finalBindingPath, f.binding);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "m6-stage-window-"));
  mkdirSync(join(root, "state", "control-plane"), { recursive: true });
  const state = new StateStore({ dbPath: join(root, "state", "control-plane", "control.db"), now: () => NOW_MS });
  const gateKeys = generateKeyPairSync("ed25519");
  const ownerKeys = generateKeyPairSync("ed25519");
  const gateIssuerAllowlistPath = writeJson(join(root, "m6-gate", "issuer-keys.json"), {
    schemaId: "xw.m6-gate-issuer-allowlist.v1", version: 1,
    keys: [{
      keyId: "m6-stage-gate-key", subject: ACTOR,
      publicKey: gateKeys.publicKey.export({ type: "spki", format: "pem" }), status: "active",
    }],
  });
  const liveIssuerAllowlistPath = writeJson(join(root, "m6-gate", "live-window-owner-keys.json"), {
    schemaId: "xw.m6-4-live-window-issuer-allowlist.v1", version: 1,
    keys: [{
      issuer: "owner:m6-stage-window-test", keyId: "m6-stage-owner-key",
      publicKey: ownerKeys.publicKey.export({ type: "spki", format: "pem" }), status: "active",
    }],
  });
  const release = seedRelease(root);
  seedGate(root, state, gateKeys);
  const artifacts = seedArtifacts(root, release);
  const dependencyRoot = join(root, "state", "control-plane", "dependency-layer");
  const dependencyLayerHash = H("c");
  writeJson(join(dependencyRoot, "m6-live-runtime-dependency-layer.v1.json"), {
    schemaId: "xw.m6-live-runtime-dependency-layer.v1", layerHash: dependencyLayerHash,
    sourceRelease: { releaseId: RELEASE, sourceCommit: COMMIT, manifestSha256: release.manifestSha256 },
  });
  const dshPersistenceRoot = join(root, "state", "control-plane", "dsh-live");
  mkdirSync(dshPersistenceRoot, { recursive: true });
  const productionDependencyBindingPath = writeJson(join(root, "state", "control-plane", "production-dependencies.json"), {
    schemaId: "xw.m6-4-production-dependency-binding.v1", sealed: true,
  });
  const runtimeSnapshotPath = join(root, "state", "control-plane", "runtime-snapshot.json");
  const finalBindingPath = join(root, "config", "m6-c1-runtime.v1.json");
  const binding = {
    schemaId: "xw.runtime.m6-c1-runtime.v1", releaseId: RELEASE, sourceCommit: COMMIT,
    sourceReleaseRoot: release.releaseRoot, releaseManifestSha256: release.manifestSha256,
    dependencyRoot, dependencyLayerHash, modelProfileRoot: artifacts.modelProfileRoot,
    modelProfileHash: H("d"), providerBaseUrl: "https://api.deepseek.com",
    manifestRoot: artifacts.manifestRoot, runtimeSnapshotPath, dshPersistenceRoot, gateId: GATE,
    gateIssuerAllowlistPath, liveAuthorizationIssuerAllowlistPath: liveIssuerAllowlistPath,
    gateFArtifactCatalogPath: artifacts.catalogPath, gateFArtifactCatalogHash: artifacts.catalog.catalogHash,
    gateFArtifactCatalogSha256: hashFile(artifacts.catalogPath),
    targetEnvironmentAttestationPath: artifacts.targetEnvironmentAttestationPath,
    targetEnvironmentAttestationHash: H("e"), environmentQualificationPath: artifacts.environmentQualificationPath,
    environmentQualificationSha256: hashFile(artifacts.environmentQualificationPath),
    productionDependencyBindingPath, productionDependencyBindingHash: hashFile(productionDependencyBindingPath),
  };
  const authorizationPath = join(root, "stage-inputs", "authorization.json");
  const candidatePath = join(root, "stage-inputs", "candidate.json");
  const out = {
    root, state, gateKeys, ownerKeys, release, artifacts, binding, finalBindingPath,
    authorizationPath, candidatePath, gateIssuerAllowlistPath, liveIssuerAllowlistPath, runtimeSnapshotPath,
  };
  writeFinalBinding(out);
  const action = makeActivation(out, "M6_4_SHADOW");
  writeInputs(out, action);
  out.action = action;
  out.args = () => ({
    finalBindingPath, authorizationPath, candidateActivationPackagePath: candidatePath,
    gateIssuerAllowlistPath, liveIssuerAllowlistPath, runtimeSnapshotPath, nowMs: NOW_MS,
  });
  out.cleanup = () => {
    try { state.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  };
  return out;
}

function verifyingOperations(metrics = { preflight: 0, apply: 0 }) {
  return ({ config, now }) => ({
    preflight(candidate) {
      metrics.preflight += 1;
      const assertEpoch = (epoch, proof) => {
        if (deriveM6V2EpochHash(epoch) !== epoch.epochHash) {
          throw Object.assign(new Error("candidate epoch hash mismatch"), { code: "M6_GATE_EPOCH_FORGED" });
        }
        verifyEpochProof({
          epoch,
          epochHash: epoch.epochHash,
          proof,
          allowlist: loadGateIssuerAllowlist(config.issuerAllowlistPath),
        });
      };
      assertEpoch(candidate.epoch, candidate.proof);
      assertEpoch(candidate.safetyClosePackage.epoch, candidate.safetyClosePackage.proof);
      verifyM64LiveWindowAuthorization({
        authorization: candidate.authorization,
        issuerAllowlist: loadM64LiveWindowIssuerAllowlist(config.liveWindowIssuerAllowlistPath),
        runtime: selectM64LiveWindowRuntimeBinding(candidate.authorization),
        nowMs: now(),
      });
      const catalog = JSON.parse(readFileSync(config.artifactCatalogPath, "utf8"));
      const entry = catalog.entries.find((item) => item.purpose === candidate.epoch.purpose);
      return {
        schemaId: "xw.m6-gate-f-promotion-preflight.v1", status: "SEALED_PREFLIGHT",
        operation: "ACTIVATE", candidateEpochHash: candidate.epoch.epochHash,
        expectedGeneration: candidate.authorization.gateGeneration, purpose: candidate.epoch.purpose,
        artifactCatalogHash: catalog.catalogHash, artifactInventoryHash: entry.inventoryHash,
      };
    },
    apply() {
      metrics.apply += 1;
      throw new Error("mutation must never be called");
    },
  });
}

function assemblerInputForStageFixture(f) {
  const implementationClosureHash = H("6");
  const tcbManifestRef = "xw.m6-grounded-run.tcb.v1";
  writeJson(join(f.release.releaseRoot, "services", "control-plane", "apps", "xiaowei", "capabilities.json"), {
    schemaVersion: 1,
    capabilities: [{
      id: "xiaowei.m6.grounded_run",
      implementation: {
        adapter: "xiaowei",
        action: "m6_grounded_run",
        implementationClosureHash,
        tcbManifestRef,
      },
    }],
  });
  const dependency = (name, existingPath = null) => {
    const path = existingPath ?? writeJson(join(f.root, "assembler-inputs", `${name}.json`), {
      schemaId: `xw.test.${name}.v1`,
      secretMaterialPresent: false,
    });
    return { path, sha256: hashFile(path) };
  };
  const environmentAttestation = dependency("environment-attestation", f.artifacts.targetEnvironmentAttestationPath);
  const environmentQualification = dependency("environment-qualification", f.artifacts.environmentQualificationPath);
  const independentOraclePolicy = dependency("independent-oracle", f.artifacts.stages.get(PURPOSES[0]).inventory.runtimeArtifacts.independentOracle.path);
  const productionDependencies = {
    currentStateGuardPolicy: dependency("current-state-guard"),
    effectBoundary: dependency("effect-boundary"),
    environmentAttestation,
    environmentQualification,
    independentOraclePolicy,
    targetSelectorPolicy: dependency("target-selector"),
  };
  const windows = PURPOSES.map((purpose) => {
    const stage = f.artifacts.stages.get(purpose);
    return {
      purpose,
      lockArtifacts: Object.fromEntries(Object.entries(stage.inventory.lockArtifacts).map(([kind, descriptor]) => [
        kind,
        { ...descriptor, expectedHash: stage.lockSet.lockHashes[kind] },
      ])),
      runtimeArtifacts: Object.fromEntries(Object.entries(stage.inventory.runtimeArtifacts).map(([kind, descriptor]) => [
        kind,
        {
          ...descriptor,
          expectedHash: kind === "environmentAttestation" ? H("e") : f.artifacts.runtimeHashes[kind],
        },
      ])),
    };
  });
  const artifactCatalogPath = join(f.root, "state", "control-plane", "assembled-gate-f", "catalog.json");
  const productionDependencyBindingPath = join(f.root, "config", "m6-4-production-dependency-binding.v1.json");
  rmSync(f.finalBindingPath, { force: true });
  return {
    input: {
      schemaId: M64_FINAL_ASSEMBLER_INPUT_SCHEMA_ID,
      release: {
        root: f.release.releaseRoot,
        manifestPath: f.release.manifestPath,
        manifestSha256: f.release.manifestSha256,
        releaseId: RELEASE,
        sourceCommit: COMMIT,
        capabilityId: "xiaowei.m6.grounded_run",
        implementationClosureHash,
        tcbManifestRef,
      },
      outputs: {
        inventoryRoot: join(f.root, "state", "control-plane", "assembled-gate-f", "inventories"),
        artifactCatalogPath,
        productionDependencyBindingPath,
        runtimeBindingPath: f.finalBindingPath,
        receiptRoot: join(f.root, "receipts", "assembler"),
      },
      runtime: {
        dependencyRoot: f.binding.dependencyRoot,
        dependencyLayerHash: f.binding.dependencyLayerHash,
        modelProfileRoot: f.binding.modelProfileRoot,
        modelProfileHash: f.binding.modelProfileHash,
        providerBaseUrl: f.binding.providerBaseUrl,
        manifestRoot: f.binding.manifestRoot,
        runtimeSnapshotPath: f.runtimeSnapshotPath,
        dshPersistenceRoot: f.binding.dshPersistenceRoot,
        gateId: GATE,
        gateIssuerAllowlistPath: f.gateIssuerAllowlistPath,
        liveAuthorizationIssuerAllowlistPath: f.liveIssuerAllowlistPath,
      },
      productionDependencies,
      windows,
    },
    dependencies: {
      verifyReleaseManifest() {
        return Object.freeze({ ok: true, mismatches: [] });
      },
      verifyCapabilitySeal() {
        return { capabilityId: "xiaowei.m6.grounded_run", implementationClosureHash, tcbManifestRef };
      },
      recomputeArtifact(descriptor, expectedHash) {
        if (descriptor.mode === "M6_COHORT_MANIFEST") {
          return { hash: expectedHash, value: JSON.parse(readFileSync(descriptor.path, "utf8")) };
        }
        if (descriptor.mode === "LIVE_MODEL_PROFILE") {
          return {
            hash: expectedHash,
            value: { profile: { targetEnvironmentAttestationHash: H("e"), expiresAt: "2030-01-02T00:00:00Z" } },
          };
        }
        if (descriptor.mode === "TARGET_ENV_ATTESTATION") {
          return { hash: expectedHash, value: { expiresAt: "2030-02-01T00:00:00Z" } };
        }
        return { hash: expectedHash, value: JSON.parse(readFileSync(descriptor.path, "utf8")) };
      },
      validateProductionDependencyCandidate() {
        return Object.freeze({ ok: true });
      },
    },
    artifactCatalogPath,
  };
}

const noGuard = async () => ({
  assertOwned() { return true; },
  async release() {},
  async retainStaleLock() {},
});

function advanceToClosed(f, action) {
  const current = f.state.getM6GateFence();
  writeImmutableJson(join(f.root, "m6-gate", GATE, "epochs", `${action.epoch.epochHash}.json`), {
    ...action.epoch, proof: action.proof,
  });
  f.state.promoteM6GateFence({
    expectedEpochHash: current.epochHash,
    expectedGeneration: current.generation,
    next: {
      gateId: GATE, epochHash: action.epoch.epochHash, mode: action.epoch.mode,
      purpose: action.epoch.purpose, allowlist: ["01"], expiresAt: action.epoch.expiresAt,
      releaseId: RELEASE, sourceCommit: COMMIT, locksHash: action.epoch.lockSetRef.sha256,
    },
  });
  const pointerPath = join(f.root, "m6-gate", GATE, "current.json");
  const pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
  pointer.chain.push(action.epoch.epochHash);
  pointer.tailEpochHash = action.epoch.epochHash;
  pointer.generation += 1;
  pointer.promotedAt = "2030-01-01T00:00:01Z";
  writeJson(pointerPath, pointer);

  const close = action.safetyClosePackage.epoch;
  writeImmutableJson(join(f.root, "m6-gate", GATE, "epochs", `${close.epochHash}.json`), {
    ...close, proof: action.safetyClosePackage.proof,
  });
  f.state.promoteM6GateFence({
    expectedEpochHash: action.epoch.epochHash,
    expectedGeneration: current.generation + 1,
    next: {
      gateId: GATE, epochHash: close.epochHash, mode: "CLOSED", purpose: close.purpose,
      allowlist: ["01"], expiresAt: close.expiresAt, releaseId: RELEASE, sourceCommit: COMMIT,
      locksHash: close.lockSetRef.sha256,
    },
  });
  pointer.chain.push(close.epochHash);
  pointer.tailEpochHash = close.epochHash;
  pointer.generation += 1;
  pointer.promotedAt = "2030-01-01T00:30:00Z";
  writeJson(pointerPath, pointer);
}

test("preflight is pure-read and calls only the production-style verifier seam", async () => {
  const f = fixture();
  const metrics = { preflight: 0, apply: 0 };
  try {
    const before = readdirSync(join(f.root, "state", "control-plane")).sort();
    const result = await stageM64LiveWindow(f.args(), {
      operationsFactory: verifyingOperations(metrics),
      acquireStoppedGuard: async () => { throw new Error("preflight must not acquire mutation guard"); },
    });
    assert.equal(result.executed, false);
    assert.equal(result.writesPerformed, 0);
    assert.equal(result.deviceAccessed, false);
    assert.equal(result.networkAccessed, false);
    assert.equal(metrics.preflight, 1);
    assert.equal(metrics.apply, 0);
    assert.equal(existsSync(f.runtimeSnapshotPath), false);
    assert.deepEqual(readdirSync(join(f.root, "state", "control-plane")).sort(), before);
  } finally { f.cleanup(); }
});

test("first execute creates exact 23-field stable/content snapshots and exact replay is idempotent", async () => {
  const f = fixture();
  let acquired = 0;
  let released = 0;
  const guard = async () => {
    acquired += 1;
    return {
      assertOwned() { return true; },
      async release() { released += 1; },
      async retainStaleLock() { throw new Error("healthy close must not retain the owner lock"); },
    };
  };
  try {
    const first = await stageM64LiveWindow({ ...f.args(), execute: true }, {
      operationsFactory: verifyingOperations(), acquireStoppedGuard: guard,
    });
    assert.equal(first.status, "STAGED");
    assert.deepEqual(JSON.parse(readFileSync(f.runtimeSnapshotPath, "utf8")), selectM64LiveWindowRuntimeBinding(f.action.authorization));
    const history = join(dirname(f.runtimeSnapshotPath), "m6-live-window-runtime-bindings");
    assert.equal(readdirSync(join(history, "content")).length, 1);
    assert.equal(readdirSync(join(history, "receipts")).length, 1);
    assert.equal(JSON.stringify(first.receipt).includes(f.action.authorization.signature), false);
    assert.equal(first.receipt.secretMaterialPresent, false);
    const replay = await stageM64LiveWindow({ ...f.args(), execute: true }, {
      operationsFactory: verifyingOperations(), acquireStoppedGuard: guard,
    });
    assert.equal(replay.status, "EXACT_REPLAY");
    assert.equal(readdirSync(join(history, "content")).length, 1);
    assert.equal(readdirSync(join(history, "receipts")).length, 1);
    assert.equal(acquired, 2);
    assert.equal(released, 2);
  } finally { f.cleanup(); }
});

test("stage recovers every immutable-content and stable-pointer publication cut", async (t) => {
  for (const publication of ["content", "stable"]) {
    for (const cut of RECOVERABLE_PUBLICATION_CUTS) {
      await t.test(`${publication}:${cut}`, async () => {
        const f = fixture();
        let pendingPath = null;
        let targetPath = null;
        try {
          const crash = Object.assign(new Error(`${publication} publication crash:${cut}`), {
            code: `TEST_STAGE_${publication.toUpperCase()}_${cut}`,
          });
          await assert.rejects(() => stageM64LiveWindow({ ...f.args(), execute: true }, {
            operationsFactory: verifyingOperations(),
            acquireStoppedGuard: noGuard,
            publicationFaultAfter(point, context) {
              if (point === `publication:${publication}:${cut}`) {
                pendingPath = context.pendingPath;
                targetPath = context.targetPath;
                throw crash;
              }
            },
          }), { code: crash.code });
          assert.equal(typeof pendingPath, "string");
          assert.equal(typeof targetPath, "string");
          if (cut === "FINAL_PUBLISHED") {
            assert.equal(lstatSync(targetPath, { bigint: true }).nlink, 2n);
            assert.equal(lstatSync(pendingPath, { bigint: true }).nlink, 2n);
          }

          const recovered = await stageM64LiveWindow({ ...f.args(), execute: true }, {
            operationsFactory: verifyingOperations(),
            acquireStoppedGuard: noGuard,
          });
          assert.equal(recovered.status, "STAGED");
          assert.equal(lstatSync(targetPath, { bigint: true }).nlink, 1n);
          assert.equal(existsSync(pendingPath), false);
          assert.deepEqual(
            JSON.parse(readFileSync(f.runtimeSnapshotPath, "utf8")),
            selectM64LiveWindowRuntimeBinding(f.action.authorization),
          );
        } finally { f.cleanup(); }
      });
    }
  }
});

test("exact runtime bytes from a different valid authorization envelope never replay an old receipt", async () => {
  const f = fixture();
  try {
    const first = await stageM64LiveWindow({ ...f.args(), execute: true }, {
      operationsFactory: verifyingOperations(), acquireStoppedGuard: noGuard,
    });
    const body = {
      ...f.action.authorization,
      authorizationId: `${f.action.authorization.authorizationId}-alternate`,
      nonce: `${f.action.authorization.nonce}-alternate`,
    };
    delete body.bodyHash;
    delete body.signature;
    delete body.envelopeHash;
    const authorization = signAuthorization(body, f.ownerKeys.privateKey);
    assert.deepEqual(
      selectM64LiveWindowRuntimeBinding(authorization),
      selectM64LiveWindowRuntimeBinding(f.action.authorization),
    );
    f.action = {
      ...f.action,
      authorization,
      package: { ...f.action.package, authorization },
    };
    writeInputs(f, f.action);
    await assert.rejects(() => stageM64LiveWindow({ ...f.args(), execute: true }, {
      operationsFactory: verifyingOperations(), acquireStoppedGuard: noGuard,
    }), { code: "M64_STAGE_REPLAY_AUTHORIZATION_MISMATCH" });
    const receiptsRoot = join(dirname(f.runtimeSnapshotPath), "m6-live-window-runtime-bindings", "receipts");
    assert.deepEqual(readdirSync(receiptsRoot), [`${first.receipt.receiptHash}.json`]);
  } finally { f.cleanup(); }
});

test("stage retains the production owner lock when read-only state close is unproven", async () => {
  const f = fixture();
  const lockPath = m6C1RuntimeOwnerLockPath(f.root);
  try {
    await assert.rejects(() => stageM64LiveWindow({ ...f.args(), execute: true }, {
      operationsFactory: verifyingOperations(),
      acquireStoppedGuard: ({ runtimeRoot }) => acquireM64StoppedControlPlaneGuard({ runtimeRoot, port: 0 }),
      openReadOnlyState(args) {
        const state = openM64ReadOnlyGateState(args);
        return Object.freeze({
          ...state,
          close() {
            state.close();
            throw Object.assign(new Error("state close proof unavailable"), { code: "TEST_STAGE_CLOSE_UNPROVEN" });
          },
        });
      },
    }), { code: "TEST_STAGE_CLOSE_UNPROVEN" });
    assert.equal(existsSync(lockPath), true);
    await assert.rejects(() => acquireM6C1StoppedRuntimeGuard({
      runtimeRoot: f.root,
      ownerKind: "QUALIFICATION_BOOTSTRAP",
      port: 0,
    }), { code: "M6_C1_RUNTIME_OWNER_LOCKED" });
  } finally { f.cleanup(); }
});

test("assembler execute leaves the stable target absent and first stage creates it", async () => {
  const f = fixture();
  try {
    const assembled = assemblerInputForStageFixture(f);
    const assembly = assembleM64FinalProductionArtifacts({
      input: assembled.input,
      execute: true,
      now: () => NOW_MS,
      dependencies: assembled.dependencies,
    });
    assert.equal(assembly.mode, "EXECUTE");
    assert.equal(existsSync(f.finalBindingPath), true);
    assert.equal(existsSync(assembled.artifactCatalogPath), true);
    assert.equal(existsSync(f.runtimeSnapshotPath), false, "assembler must not create the stage-owned stable target");
    rmSync(join(f.release.releaseRoot, "services"), { recursive: true, force: true });

    const staged = await stageM64LiveWindow({ ...f.args(), execute: true }, {
      operationsFactory: verifyingOperations(),
      acquireStoppedGuard: noGuard,
    });
    assert.equal(staged.status, "STAGED");
    assert.equal(existsSync(f.runtimeSnapshotPath), true);
    assert.deepEqual(
      JSON.parse(readFileSync(f.runtimeSnapshotPath, "utf8")),
      selectM64LiveWindowRuntimeBinding(f.action.authorization),
    );
  } finally { f.cleanup(); }
});

test("five-window order, generation, parent, signature, hash, expiry, and stale snapshot fail closed", async (t) => {
  const cases = [
    {
      name: "wrong purpose/order",
      mutate(f) { f.action = makeActivation(f, "M6_4_HOT_CLOSE"); writeInputs(f, f.action); },
      code: "M64_STAGE_WINDOW_ORDER_INVALID",
    },
    {
      name: "wrong generation",
      mutate(f) {
        const body = { ...f.action.authorization, gateGeneration: 9 };
        delete body.bodyHash; delete body.signature; delete body.envelopeHash;
        const authorization = signAuthorization(body, f.ownerKeys.privateKey);
        f.action = { ...f.action, authorization, package: { ...f.action.package, authorization } };
        writeInputs(f, f.action);
      },
      code: "M64_STAGE_GENERATION_INVALID",
    },
    {
      name: "wrong parent",
      mutate(f) {
        const raw = { ...f.action.epoch, parentEpochHash: H("f") };
        delete raw.epochHash;
        const epoch = { ...raw, epochHash: deriveM6V2EpochHash(raw) };
        const authBody = { ...f.action.authorization, gateEpochHash: epoch.epochHash };
        delete authBody.bodyHash; delete authBody.signature; delete authBody.envelopeHash;
        const authorization = signAuthorization(authBody, f.ownerKeys.privateKey);
        f.action = {
          ...f.action, epoch, authorization,
          package: { ...f.action.package, epoch, proof: gateProof(epoch, f.gateKeys.privateKey), authorization },
        };
        writeInputs(f, f.action);
      },
      code: "M64_STAGE_GENERATION_INVALID",
    },
    {
      name: "bad owner signature",
      mutate(f) {
        const signature = Buffer.from(f.action.authorization.signature, "base64");
        signature[0] ^= 0xff;
        const authorization = { ...f.action.authorization, signature: signature.toString("base64") };
        f.action = { ...f.action, authorization, package: { ...f.action.package, authorization } };
        writeInputs(f, f.action);
      },
      code: "M64_LIVE_AUTH_SIGNATURE_INVALID",
    },
    {
      name: "bad body hash",
      mutate(f) {
        const authorization = { ...f.action.authorization, bodyHash: H("0") };
        f.action = { ...f.action, authorization, package: { ...f.action.package, authorization } };
        writeInputs(f, f.action);
      },
      code: "M64_LIVE_AUTH_BODY_HASH_INVALID",
    },
    {
      name: "expired",
      mutate() {},
      nowMs: Date.parse("2030-01-01T02:00:00Z"),
      code: "M64_LIVE_AUTH_EXPIRED",
    },
    {
      name: "unaudited stale snapshot",
      mutate(f) { writeJson(f.runtimeSnapshotPath, { ...selectM64LiveWindowRuntimeBinding(f.action.authorization), gateGeneration: 0 }); },
      execute: true,
      code: "M64_STAGE_STALE_SNAPSHOT",
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const f = fixture();
      try {
        item.mutate(f);
        await assert.rejects(() => stageM64LiveWindow({
          ...f.args(),
          nowMs: item.nowMs ?? NOW_MS,
          execute: item.execute ?? false,
        }, {
          operationsFactory: verifyingOperations(), acquireStoppedGuard: noGuard,
        }), { code: item.code });
      } finally { f.cleanup(); }
    });
  }
});

test("catalog order and snapshot path escape/reparse are rejected before publication", async (t) => {
  await t.test("catalog order", async () => {
    const f = fixture();
    try {
      [f.artifacts.catalog.entries[0], f.artifacts.catalog.entries[1]] = [f.artifacts.catalog.entries[1], f.artifacts.catalog.entries[0]];
      f.artifacts.catalog.catalogHash = deriveM6GateFArtifactCatalogHash(f.artifacts.catalog);
      writeJson(f.artifacts.catalogPath, f.artifacts.catalog);
      writeFinalBinding(f);
      await assert.rejects(() => stageM64LiveWindow(f.args(), { operationsFactory: verifyingOperations() }), {
        code: "M6_GATE_F_CATALOG_ORDER_INVALID",
      });
    } finally { f.cleanup(); }
  });
  await t.test("path escape", async () => {
    const f = fixture();
    try {
      const escaped = join(f.root, "escaped-snapshot.json");
      f.binding.runtimeSnapshotPath = escaped;
      writeFinalBinding(f);
      await assert.rejects(() => stageM64LiveWindow({ ...f.args(), runtimeSnapshotPath: escaped }, {
        operationsFactory: verifyingOperations(),
      }), { code: "M64_STAGE_SNAPSHOT_PATH_ESCAPE" });
    } finally { f.cleanup(); }
  });
  await t.test("junction parent", async (st) => {
    const f = fixture();
    const outside = mkdtempSync(join(tmpdir(), "m6-stage-window-outside-"));
    try {
      const link = join(f.root, "state", "linked");
      try { symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir"); } catch (error) {
        if (process.platform === "win32" && error?.code === "EPERM") { st.skip("Windows symlink privilege unavailable"); return; }
        throw error;
      }
      const linkedSnapshot = join(link, "runtime-snapshot.json");
      f.binding.runtimeSnapshotPath = linkedSnapshot;
      writeFinalBinding(f);
      await assert.rejects(() => stageM64LiveWindow({ ...f.args(), runtimeSnapshotPath: linkedSnapshot }, {
        operationsFactory: verifyingOperations(),
      }), { code: "M64_STAGE_PATH_REPARSE" });
    } finally {
      f.cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("terminalized prior window rotates append-only history and recovers an after-tombstone crash", async () => {
  const f = fixture();
  const deps = { operationsFactory: verifyingOperations(), acquireStoppedGuard: noGuard };
  try {
    await stageM64LiveWindow({ ...f.args(), execute: true }, deps);
    const firstBytes = readFileSync(f.runtimeSnapshotPath);
    advanceToClosed(f, f.action);
    f.action = makeActivation(f, "M6_4_HOT_CLOSE");
    writeInputs(f, f.action);
    await assert.rejects(() => stageM64LiveWindow({ ...f.args(), execute: true }, {
      ...deps,
      publicationFaultAfter(point) {
        if (point === "tombstone") throw Object.assign(new Error("injected crash"), { code: "TEST_CRASH_AFTER_TOMBSTONE" });
      },
    }), { code: "TEST_CRASH_AFTER_TOMBSTONE" });
    assert.equal(existsSync(f.runtimeSnapshotPath), false);
    const recovered = await stageM64LiveWindow({ ...f.args(), execute: true }, deps);
    assert.equal(recovered.status, "ROTATED");
    assert.deepEqual(JSON.parse(readFileSync(f.runtimeSnapshotPath, "utf8")), selectM64LiveWindowRuntimeBinding(f.action.authorization));
    const history = join(dirname(f.runtimeSnapshotPath), "m6-live-window-runtime-bindings");
    assert.equal(readdirSync(join(history, "content")).length, 2);
    assert.equal(readdirSync(join(history, "tombstones")).length, 1);
    assert.equal(readFileSync(join(history, "tombstones", readdirSync(join(history, "tombstones"))[0])).equals(firstBytes), true);
    assert.ok(readdirSync(join(history, "receipts")).length >= 3);
  } finally { f.cleanup(); }
});

test("real owner guard serializes concurrent stagers and stale lock remains fail-closed", async () => {
  const f = fixture();
  const acquireStageGuard = ({ runtimeRoot }) => acquireM64StoppedControlPlaneGuard({ runtimeRoot, port: 0 });
  let held;
  try {
    held = await acquireM6C1StoppedRuntimeGuard({
      runtimeRoot: f.root,
      ownerKind: "QUALIFICATION_BOOTSTRAP",
      port: 0,
    });
    await assert.rejects(() => stageM64LiveWindow({ ...f.args(), execute: true }, {
      operationsFactory: verifyingOperations(),
      acquireStoppedGuard: acquireStageGuard,
    }), { code: "M64_STAGE_CONCURRENT_STAGER" });
    await held.release();
    held = null;
    const first = await stageM64LiveWindow({ ...f.args(), execute: true }, {
      operationsFactory: verifyingOperations(),
      acquireStoppedGuard: acquireStageGuard,
    });
    assert.equal(first.status, "STAGED");
    const lockPath = m6C1RuntimeOwnerLockPath(f.root);
    writeJson(lockPath, { schemaId: "stale-owner-lock" });
    await assert.rejects(() => stageM64LiveWindow({ ...f.args(), execute: true }, {
      operationsFactory: verifyingOperations(),
      acquireStoppedGuard: acquireStageGuard,
    }), { code: "M64_STAGE_CONCURRENT_STAGER" });
    assert.equal(existsSync(lockPath), true);
  } finally {
    if (held) await held.release();
    f.cleanup();
  }
});
