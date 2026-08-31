import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalM64LiveWindowAuthorizationSigningBytes,
  deriveM64LiveWindowAuthorizationBodyHash,
  deriveM64LiveWindowAuthorizationEnvelopeHash,
  selectM64LiveWindowRuntimeBinding,
} from "../../../packages/kernel/lib/m6-4-live-window-authorization.mjs";
import { deriveTargetEnvironmentAttestation } from "../../../packages/kernel/lib/m6-live-grounding.mjs";
import {
  assertM6AuthorityTokenSeparation,
  createControlPlaneRuntime,
  resolveM6LiveProductionDependencies,
} from "../control-plane/bootstrap.mjs";
import { loadM6LiveEntryConfigFromEnv } from "../control-plane/lib/m6-live-entry.mjs";
import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { AdapterRegistry } from "../control-plane/lib/control-plane.mjs";
import { EvidenceStore } from "../control-plane/lib/evidence-store.mjs";
import {
  M64_LIVE_WINDOW_ISSUER_ALLOWLIST_SCHEMA_ID,
  normalizeM64LiveWindowIssuerAllowlist,
} from "../control-plane/lib/m6-live-window-authorization.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";

const NOW = Date.parse("2030-01-01T00:10:00.000Z");
const H = (character) => character.repeat(64);
const TOKEN = "m6-live-production-bootstrap-token-32-bytes";

test("FINAL bootstrap rejects one credential shared by live-entry and Gate-F authorities", () => {
  assert.throws(() => assertM6AuthorityTokenSeparation({
    runtimeMode: "FINAL",
    liveEntryEnabled: true,
    gateFOperationsEnabled: true,
    liveEntryConfig: { internalToken: TOKEN },
    gateFConfig: { internalToken: TOKEN },
  }), { code: "M6_AUTHORITY_TOKEN_SEPARATION_REQUIRED" });
  assert.doesNotThrow(() => assertM6AuthorityTokenSeparation({
    runtimeMode: "QUALIFICATION_ONLY",
    liveEntryEnabled: false,
    gateFOperationsEnabled: true,
    liveEntryConfig: null,
    gateFConfig: { internalToken: TOKEN },
  }));
});

function signedPreflightFixture() {
  const manifest = JSON.parse(readFileSync(
    new URL("../../../artifacts/m6-4/cohort-manifests/m6_4_action_smoke.json", import.meta.url),
    "utf8",
  ));
  const owner = generateKeyPairSync("ed25519");
  const body = {
    schemaId: "xw.m6-4-live-window-authorization.v1",
    authorizationId: "m64-production-bootstrap-auth-0001",
    issuer: "owner:production-bootstrap-test",
    keyId: "owner-production-bootstrap-key",
    allowlistVersion: 1,
    signatureAlgorithm: "ed25519",
    nonce: "m64-production-bootstrap-nonce-0001",
    alias: "01",
    releaseId: "m64-production-bootstrap-release",
    releaseHash: H("1"),
    sourceCommit: "a".repeat(40),
    gateId: "m6-production-bootstrap-gate",
    gateEpochHash: H("2"),
    gateGeneration: 1,
    purpose: manifest.purpose,
    scenarioManifestHash: manifest.manifestHash,
    runtimeProfileHash: H("3"),
    modelProfileHash: H("4"),
    providerHash: H("5"),
    toolProfileHash: H("6"),
    policyHash: H("7"),
    locksHash: H("8"),
    environmentAttestationHash: H("9"),
    operatorHash: H("a"),
    emergencyCloseAuthorizationHash: H("b"),
    emergencyCloseReasonCodeAllowlist: ["SAFETY_STOP"],
    closeoutGraceMs: 30 * 60 * 1000,
    effectBoundary: "BOUNDED_READ_TRACE",
    independentOracleHash: H("c"),
    resetObligationsHash: H("d"),
    issuedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T01:00:00.000Z",
  };
  const withBodyHash = { ...body, bodyHash: deriveM64LiveWindowAuthorizationBodyHash(body) };
  const withSignature = {
    ...withBodyHash,
    signature: sign(null, canonicalM64LiveWindowAuthorizationSigningBytes(withBodyHash), owner.privateKey).toString("base64"),
  };
  const authorization = Object.freeze({
    ...withSignature,
    envelopeHash: deriveM64LiveWindowAuthorizationEnvelopeHash(withSignature),
  });
  const issuerAllowlist = normalizeM64LiveWindowIssuerAllowlist({
    schemaId: M64_LIVE_WINDOW_ISSUER_ALLOWLIST_SCHEMA_ID,
    version: 1,
    keys: [{
      issuer: body.issuer,
      keyId: body.keyId,
      publicKey: owner.publicKey.export({ type: "spki", format: "pem" }),
      status: "active",
    }],
  });
  return Object.freeze({
    authorization,
    issuerAllowlist,
    manifest,
    request: Object.freeze({
      manifestRef: "m6_4_action_smoke",
      manifestHash: manifest.manifestHash,
      scenarioKey: "m6_4_action_smoke-01",
      authorizationId: authorization.authorizationId,
      authorizationHash: authorization.envelopeHash,
      authorization,
    }),
  });
}

function groundedCapability() {
  const all = JSON.parse(readFileSync(new URL("../apps/xiaowei/capabilities.json", import.meta.url), "utf8"));
  return structuredClone(all.capabilities.find((entry) => entry.id === "xiaowei.m6.grounded_run"));
}

test("FINAL startup passes the exact environment and production-dependency bindings to the sealed loader", () => {
  const now = () => NOW;
  const config = loadM6LiveEntryConfigFromEnv({
    env: {
      CONTROL_PLANE_RELEASE_ID: "m64-final-release",
      CONTROL_PLANE_GIT_COMMIT: "a".repeat(40),
      XW_M6_SOURCE_RELEASE_ROOT: "C:\\release\\m64-final",
      XW_M6_PRODUCTION_DEPENDENCY_BINDING_PATH: "C:\\runtime\\m64-production-dependencies.json",
      XW_M6_PRODUCTION_DEPENDENCY_BINDING_HASH: H("1"),
      XW_M6_TARGET_ENVIRONMENT_ATTESTATION_PATH: "C:\\runtime\\m64-environment-attestation.json",
      XW_M6_TARGET_ENVIRONMENT_ATTESTATION_HASH: H("2"),
      XW_M6_ENVIRONMENT_QUALIFICATION_PATH: "C:\\runtime\\m64-environment-qualification.json",
      XW_M6_ENVIRONMENT_QUALIFICATION_SHA256: H("3"),
    },
  });
  const sealed = Object.freeze({ dependencyHashes: Object.freeze({ binding: H("4") }) });
  const calls = [];
  const resolved = resolveM6LiveProductionDependencies({
    runtimeMode: "FINAL",
    callbackOptions: { now },
    productionConfig: config,
    loader(input) {
      calls.push(input);
      return sealed;
    },
  });
  assert.equal(resolved, sealed);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].now, now);
  assert.deepEqual(calls[0].runtimeBinding, config.productionDependencyRuntimeBinding);
  assert.equal(calls[0].runtimeBinding.targetEnvironmentAttestationHash, H("2"));
  assert.equal(calls[0].runtimeBinding.environmentQualificationSha256, H("3"));
});

test("bootstrap adopts the production callback factory and reaches a zero-resource SEALED_PREFLIGHT", () => {
  const fixture = signedPreflightFixture();
  const testRoot = mkdtempSync(join(tmpdir(), "m6-live-production-bootstrap-"));
  const state = new StateStore({ dbPath: join(testRoot, "control.db"), now: () => NOW });
  const registry = new CapabilityRegistry([groundedCapability()]);
  const environmentAttestation = deriveTargetEnvironmentAttestation({
    appPackageHash: H("1"), appBuildHash: H("2"), signingHash: H("3"), osBuildHash: H("4"),
    displayHash: H("5"), localeThemeHash: H("6"), imeHash: H("7"), accessibilityHash: H("8"),
    accountBindingHash: H("9"),
    accountIsolationHash: H("9"), capturedAt: "2030-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:50:00.000Z",
  });
  const environmentQualification = Object.freeze({
    schemaId: "xw.m6-environment-qualification.v1",
    status: "QUALIFIED",
    gateFEligible: true,
    alias: "01",
    effectBoundary: "READ_ONLY",
    actionCount: 0,
    secretMaterialPresent: false,
    rawDeviceIdentityPresent: false,
    qualifiedAttestationHashes: [environmentAttestation.attestationHash],
    expiresAt: environmentAttestation.expiresAt,
  });
  const effectBoundary = JSON.parse(readFileSync(
    new URL("../../../artifacts/m6-4/cohort-manifests/xw.m6-effect-boundary.v1.json", import.meta.url),
    "utf8",
  ));
  try {
    const runtime = createControlPlaneRuntime({
      state,
      capabilities: registry,
      adapters: new AdapterRegistry([{
        id: "xiaowei",
        async execute() { return {}; },
        async verify() { return { ok: true }; },
        async restore() { return { ok: true }; },
      }]),
      evidence: new EvidenceStore({ runsRoot: join(testRoot, "runs"), state, minFreeBytes: 0, minExternalEffectFreeBytes: 0 }),
      deviceConfigPath: join(testRoot, "missing-devices.json"),
      m6LiveEntryEnabled: true,
      m6LiveEntryConfig: {
        internalToken: TOKEN,
        runtimeSnapshot: selectM64LiveWindowRuntimeBinding(fixture.authorization),
        issuerAllowlist: fixture.issuerAllowlist,
        qualification: { contentHash: fixture.authorization.modelProfileHash },
      },
      m6LiveProductionCallbacksOptions: {
        evidence: { commitFrame() { throw new Error("preflight must not capture"); } },
        environmentAttestation,
        environmentQualification,
        effectBoundary,
        independentOracle: {
          async loadExpectation() { throw new Error("preflight must not load an oracle"); },
          async observe() { throw new Error("preflight must not observe an oracle"); },
          async compare() { throw new Error("preflight must not compare an oracle"); },
        },
        targetSelector() { throw new Error("preflight must not select a target"); },
        currentStateGuard() { throw new Error("preflight must not inspect device state"); },
        evidenceDirectoryRoot: join(testRoot, "action-evidence"),
        auditStore: { commit() { throw new Error("preflight must not write audit evidence"); } },
        now: () => NOW,
      },
      m6LiveWorkerDriver: async () => { throw new Error("preflight must not launch a worker"); },
      m6LiveEntryFactories: {
        manifestLoader: () => fixture.manifest,
        qualifyLaunch: () => ({ authority: { qualificationStatus: "QUALIFIED" } }),
        processAdapterFactory: () => { throw new Error("preflight must not construct a process adapter"); },
        loadGateSnapshot: () => ({ chain: [], currentPointer: null }),
        now: () => NOW,
      },
    });
    assert.deepEqual(runtime.m6LiveEntry.health(), {
      installed: true,
      status: "PREFLIGHT_REQUIRED",
      activeRuns: 0,
      blockers: [],
    });
    runtime.m6LiveEntry.assertAuthorized({ "x-control-token": TOKEN });
    const preflight = runtime.m6LiveEntry.preflight(fixture.request);
    assert.equal(preflight.status, "SEALED_PREFLIGHT");
    assert.equal(preflight.resourceCount, 0);
    assert.equal(runtime.m6LiveEntry.health().activeRuns, 0);
    assert.deepEqual(state.getM6GateFResourceCounts(), { jobs: 0, leases: 0, sessions: 0, actionCount: 0 });
  } finally {
    state.close();
    rmSync(testRoot, { recursive: true, force: true });
  }
});
