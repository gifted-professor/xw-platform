import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  deriveM64ExpectedStateArtifact,
  deriveM64IndependentEffectObservation,
} from "../../../packages/kernel/lib/m6-live-evidence.mjs";
import { deriveTargetEnvironmentAttestation } from "../../../packages/kernel/lib/m6-live-grounding.mjs";
import { canonicalJson, sha256 } from "../control-plane/lib/canonical.mjs";
import {
  M64_CURRENT_STATE_GUARD_POLICY_SCHEMA_ID,
  M64_EXPECTATION_ENVELOPE_SCHEMA_ID,
  M64_EXPECTATION_INDEX_SCHEMA_ID,
  M64_FRESH_STATE_CAPTURE_SCHEMA_ID,
  M64_INDEPENDENT_ORACLE_POLICY_SCHEMA_ID,
  M64_OBSERVATION_ENVELOPE_SCHEMA_ID,
  M64_OBSERVATION_LOCATOR_SCHEMA_ID,
  M64_PRODUCTION_DEPENDENCY_BINDING_SCHEMA_ID,
  M64_TARGET_SELECTOR_POLICY_SCHEMA_ID,
  canonicalM64ExpectationEnvelopeSigningBytes,
  canonicalM64ObservationEnvelopeSigningBytes,
  deriveM64CurrentStateGuardPolicyHash,
  deriveM64ExpectationIndexHash,
  deriveM64ExpectationLookupHash,
  deriveM64FreshStateCaptureHash,
  deriveM64IndependentActorHash,
  deriveM64IndependentOraclePolicyHash,
  deriveM64ObservationLocatorHash,
  deriveM64ObservationRequestHash,
  deriveM64ProductionDependencyBindingHash,
  deriveM64SourceEvidenceHash,
  deriveM64TargetSelectorPolicyHash,
  loadM64ProductionDependencies,
} from "../control-plane/lib/m6-live-production-dependencies.mjs";

const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const H = (value) => sha256(value);
const STATE_FIELDS = [
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
];

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

function keyPair(keyId) {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  return Object.freeze({ keyId, publicKey, privateKey: pair.privateKey, actorHash: deriveM64IndependentActorHash(publicKey) });
}

function baseState(environmentAttestationHash, overrides = {}) {
  return Object.freeze({
    slotSpecHash: H("slot-spec"),
    frameId: H("frame"),
    blockId: H("block"),
    uiStateGeneration: 4,
    appPackageHash: H("package"),
    focusHash: H("focus"),
    pageFingerprint: H("page"),
    rotation: 0,
    displayHash: H("display"),
    environmentAttestationHash,
    ...overrides,
  });
}

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), "m64-production-deps-"));
  const releaseRoot = join(root, "release");
  const artifactRoot = join(root, "runtime-artifacts");
  mkdirSync(releaseRoot, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });

  const boundary = JSON.parse(readFileSync(
    new URL("../../../artifacts/m6-4/cohort-manifests/xw.m6-effect-boundary.v1.json", import.meta.url),
    "utf8",
  ));
  const family = boundary.families.find((entry) => entry.primaryFamily === "tab-back");
  const environmentAttestation = deriveTargetEnvironmentAttestation({
    appPackageHash: H("env-package"),
    appBuildHash: H("env-build"),
    signingHash: H("env-signing"),
    osBuildHash: H("env-os"),
    displayHash: H("display"),
    localeThemeHash: H("env-locale"),
    imeHash: H("env-ime"),
    accessibilityHash: H("env-accessibility"),
    accountIsolationHash: H("env-account"),
    capturedAt: "2029-12-31T23:30:00.000Z",
    expiresAt: "2030-01-01T01:00:00.000Z",
  });
  const environmentQualification = Object.freeze({
    schemaId: "xw.m6-environment-qualification.v1",
    status: "QUALIFIED",
    gateFEligible: true,
    alias: "01",
    effectBoundary: "READ_ONLY",
    commandRegistryHash: H("commands"),
    qualifiedAttestationHashes: [environmentAttestation.attestationHash],
    sampleCount: 2,
    capturedAt: environmentAttestation.capturedAt,
    expiresAt: environmentAttestation.expiresAt,
    secretMaterialPresent: false,
    rawDeviceIdentityPresent: false,
    actionCount: 0,
  });
  const environmentAttestationRef = writeJson(join(artifactRoot, "environment", "attestation.json"), environmentAttestation);
  const environmentQualificationRef = writeJson(join(artifactRoot, "environment", "qualification.json"), environmentQualification);
  const boundaryRef = writeJson(join(artifactRoot, "policy", "effect-boundary.json"), boundary);

  const author = keyPair("expectation-author-1");
  const observer = keyPair("observer-1");
  const authority = Object.freeze({
    purpose: "M6_4_ACTION_SMOKE",
    manifestHash: H("manifest"),
    scenarioKey: "m6_4_action_smoke-01",
    primaryFamily: "tab-back",
    oracleHash: family.oracleHash,
    effectBoundaryHash: boundary.boundaryHash,
    environmentAttestationHash: environmentAttestation.attestationHash,
    accountIsolationHash: environmentAttestation.accountIsolationHash,
    liveAuthorizationIssuedAt: "2029-12-31T23:59:00.000Z",
    liveAuthorizationExpiresAt: "2030-01-01T00:30:00.000Z",
  });
  const expectation = deriveM64ExpectedStateArtifact({
    schemaId: "xw.m6-4-independent-expected-state.v1",
    ...Object.fromEntries([
      "purpose",
      "manifestHash",
      "scenarioKey",
      "primaryFamily",
      "oracleHash",
      "effectBoundaryHash",
      "environmentAttestationHash",
      "accountIsolationHash",
    ].map((key) => [key, authority[key]])),
    expectedStateHash: H("expected-business-state"),
    independentAuthorHash: author.actorHash,
    sourceClass: "INDEPENDENT_PRE_DISPATCH",
    selfDerived: false,
    authoredAt: "2029-12-31T23:50:00.000Z",
    expiresAt: "2030-01-01T00:45:00.000Z",
  });
  const expectationUnsigned = {
    schemaId: M64_EXPECTATION_ENVELOPE_SCHEMA_ID,
    authorKeyId: author.keyId,
    signatureAlgorithm: "Ed25519",
    expectation,
  };
  const expectationEnvelope = Object.freeze({
    ...expectationUnsigned,
    signature: sign(null, canonicalM64ExpectationEnvelopeSigningBytes(expectationUnsigned), author.privateKey).toString("base64"),
  });
  const expectationRef = writeJson(join(artifactRoot, "expectations", "expectation.json"), expectationEnvelope);
  const expectationIndex = withHash({
    schemaId: M64_EXPECTATION_INDEX_SCHEMA_ID,
    entries: [{
      lookupHash: deriveM64ExpectationLookupHash(authority),
      expectationEnvelope: expectationRef,
    }],
  }, deriveM64ExpectationIndexHash, "indexHash");
  const expectationIndexRef = writeJson(join(artifactRoot, "expectations", "index.json"), expectationIndex);

  const observationRoot = join(artifactRoot, "independent-observer");
  mkdirSync(join(observationRoot, "requests"), { recursive: true });
  mkdirSync(join(observationRoot, "observations"), { recursive: true });
  const oraclePolicy = withHash({
    schemaId: M64_INDEPENDENT_ORACLE_POLICY_SCHEMA_ID,
    effectBoundaryHash: boundary.boundaryHash,
    expectationIndex: expectationIndexRef,
    expectationAuthorKeyId: author.keyId,
    expectationAuthorPublicKey: author.publicKey,
    independentAuthorHash: author.actorHash,
    observationRoot,
    observationObserverKeyId: observer.keyId,
    observationObserverPublicKey: observer.publicKey,
    independentObserverHash: observer.actorHash,
    allowedSourceKinds: ["ACCOUNT_READ_SNAPSHOT", "DEVICE_READ_SNAPSHOT", "BACKEND_READ_SNAPSHOT"],
    requiredSourceKinds: ["ACCOUNT_READ_SNAPSHOT", "DEVICE_READ_SNAPSHOT", "BACKEND_READ_SNAPSHOT"],
    forbiddenSourceKinds: [
      "BROKER_ACK",
      "CONTROL_PLANE_LEDGER",
      "DSH_RESULT",
      "GROUNDED_ACTION_RECEIPT",
      "MODEL_OUTPUT",
      "SUT_RECEIPT",
      "TRANSPORT_RESULT",
    ],
    maxObservationAgeMs: 5_000,
  }, deriveM64IndependentOraclePolicyHash, "policyHash");
  const oraclePolicyRef = writeJson(join(artifactRoot, "policy", "oracle.json"), oraclePolicy);

  const slotAuthority = Object.freeze({
    targetKind: "block",
    slotAuthorityHash: H("slot-authority"),
    targetEligibilityHash: H("target-eligibility"),
  });
  const selectedResourceHash = H("resource:selected");
  const selectorPolicy = withHash({
    schemaId: M64_TARGET_SELECTOR_POLICY_SCHEMA_ID,
    effectBoundaryHash: boundary.boundaryHash,
    rules: [{
      scenarioKey: authority.scenarioKey,
      slotAuthorityHash: slotAuthority.slotAuthorityHash,
      targetEligibilityHash: slotAuthority.targetEligibilityHash,
      requiredFeatures: { resourceHash: selectedResourceHash },
    }],
  }, deriveM64TargetSelectorPolicyHash, "policyHash");
  const selectorPolicyRef = writeJson(join(artifactRoot, "policy", "target-selector.json"), selectorPolicy);
  const guardPolicy = withHash({
    schemaId: M64_CURRENT_STATE_GUARD_POLICY_SCHEMA_ID,
    allowedSourceClass: "SERVER_OWNED_FRESH_CAPTURE",
    allowedSourceKind: "CONTROL_PLANE_FRAME_GUARD",
    maxCaptureAgeMs: 250,
    requiredStateFields: STATE_FIELDS,
  }, deriveM64CurrentStateGuardPolicyHash, "policyHash");
  const guardPolicyRef = writeJson(join(artifactRoot, "policy", "current-state-guard.json"), guardPolicy);

  const dependencyBinding = withHash({
    schemaId: M64_PRODUCTION_DEPENDENCY_BINDING_SCHEMA_ID,
    releaseId: "release-m64-production",
    sourceCommit: "a".repeat(40),
    environmentAttestation: environmentAttestationRef,
    environmentQualification: environmentQualificationRef,
    effectBoundary: boundaryRef,
    independentOraclePolicy: oraclePolicyRef,
    targetSelectorPolicy: selectorPolicyRef,
    currentStateGuardPolicy: guardPolicyRef,
  }, deriveM64ProductionDependencyBindingHash, "bindingHash");
  const dependencyBindingRef = writeJson(join(artifactRoot, "binding", "production-dependencies.json"), dependencyBinding);
  const runtimeBinding = Object.freeze({
    schemaId: "xw.runtime.m6-c1-runtime.v1",
    releaseId: dependencyBinding.releaseId,
    sourceCommit: dependencyBinding.sourceCommit,
    sourceReleaseRoot: releaseRoot,
    productionDependencyBindingPath: dependencyBindingRef.path,
    productionDependencyBindingHash: dependencyBindingRef.sha256,
    targetEnvironmentAttestationPath: environmentAttestationRef.path,
    targetEnvironmentAttestationHash: environmentAttestation.attestationHash,
    environmentQualificationPath: environmentQualificationRef.path,
    environmentQualificationSha256: environmentQualificationRef.sha256,
  });

  let freshCaptureOverride = null;
  const expectedState = baseState(environmentAttestation.attestationHash);
  const readFreshCapture = async ({ runRef, frameRef }) => {
    const freshState = Object.freeze({
      ...expectedState,
      frameId: H("fresh-frame"),
      blockId: H("fresh-block"),
    });
    const raw = {
      schemaId: M64_FRESH_STATE_CAPTURE_SCHEMA_ID,
      sourceClass: "SERVER_OWNED_FRESH_CAPTURE",
      sourceKind: "CONTROL_PLANE_FRAME_GUARD",
      runRef,
      requestFrameRef: frameRef,
      capturedAt: new Date(NOW).toISOString(),
      state: freshState,
      ...(freshCaptureOverride || {}),
    };
    return Object.freeze({ ...raw, captureHash: deriveM64FreshStateCaptureHash(raw) });
  };

  function load(overrides = {}) {
    return loadM64ProductionDependencies({
      runtimeBinding: overrides.runtimeBinding || runtimeBinding,
      readFreshCapture: Object.hasOwn(overrides, "readFreshCapture") ? overrides.readFreshCapture : readFreshCapture,
      now: overrides.now || (() => NOW),
    });
  }

  function writeObservation({ phase, actualStateHash, sourceEvidence = null, observedAt = null, mutate = null }) {
    const observationAuthority = Object.freeze({
      ...authority,
      phase,
      expectedArtifactHash: expectation.expectedArtifactHash,
      independentAuthorHash: expectation.independentAuthorHash,
    });
    const requestHash = deriveM64ObservationRequestHash(observationAuthority);
    const sources = sourceEvidence || [
      { kind: "ACCOUNT_READ_SNAPSHOT", sha256: H(`account:${phase}`) },
      { kind: "DEVICE_READ_SNAPSHOT", sha256: H(`device:${phase}`) },
      { kind: "BACKEND_READ_SNAPSHOT", sha256: H(`backend:${phase}`) },
    ];
    const observation = deriveM64IndependentEffectObservation({
      schemaId: "xw.m6-4-independent-effect-observation.v1",
      phase,
      sourceClass: "INDEPENDENT_POST_DISPATCH",
      selfDerived: false,
      scenarioKey: authority.scenarioKey,
      primaryFamily: authority.primaryFamily,
      oracleHash: authority.oracleHash,
      effectBoundaryHash: authority.effectBoundaryHash,
      environmentAttestationHash: authority.environmentAttestationHash,
      accountIsolationHash: authority.accountIsolationHash,
      expectedArtifactHash: expectation.expectedArtifactHash,
      independentObserverHash: observer.actorHash,
      actualStateHash,
      sourceEvidenceHash: deriveM64SourceEvidenceHash(sources),
      observedEffects: [],
      resetResults: Object.fromEntries(family.resetObligations.map((item) => [item, true])),
      counters: {
        forbiddenEffectCount: 0,
        publicEffectCount: 0,
        paymentAttemptCount: 0,
        deleteAttemptCount: 0,
        misclickCount: 0,
        staleActionCount: 0,
        duplicateActionCount: 0,
        unknownReplayCount: 0,
        riskChallengeCount: 0,
        unknownEffectCount: 0,
        actionApprovalPromptCount: 0,
        humanInterventionCount: 0,
      },
      observedAt: observedAt || new Date(NOW).toISOString(),
    });
    const unsigned = {
      schemaId: M64_OBSERVATION_ENVELOPE_SCHEMA_ID,
      observerKeyId: observer.keyId,
      signatureAlgorithm: "Ed25519",
      requestHash,
      sourceEvidence: sources,
      observation,
    };
    let envelope = {
      ...unsigned,
      signature: sign(null, canonicalM64ObservationEnvelopeSigningBytes(unsigned), observer.privateKey).toString("base64"),
    };
    if (mutate) envelope = mutate(envelope);
    const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    const envelopeSha256 = sha256(bytes);
    writeBytes(join(observationRoot, "observations", `${envelopeSha256}.json`), bytes);
    const locator = withHash({
      schemaId: M64_OBSERVATION_LOCATOR_SCHEMA_ID,
      requestHash,
      envelopeSha256,
    }, deriveM64ObservationLocatorHash, "locatorHash");
    writeJson(join(observationRoot, "requests", `${requestHash}.json`), locator);
    return Object.freeze({ authority: observationAuthority, observation, requestHash, envelopeSha256 });
  }

  function blockSet({ duplicateMatch = false } = {}) {
    const matching = {
      blockId: H("selected-block"),
      boundsRef: H("bounds"),
      nodeFingerprint: H("node"),
      classHash: H("class"),
      resourceHash: selectedResourceHash,
      textHash: H("text"),
      descriptionHash: null,
      packageHash: H("package"),
      structureHash: H("structure"),
      flags: { clickable: true, scrollable: false, editable: false, system: false, sensitive: false, advertisement: false, keyboard: false },
      safeRegion: true,
    };
    const blocks = [matching, {
      ...matching,
      blockId: H("other-block"),
      boundsRef: H("other-bounds"),
      resourceHash: duplicateMatch ? selectedResourceHash : H("resource:other"),
    }];
    const core = {
      schemaId: "xw.visual-block-set.v2",
      frameId: H("frame"),
      environmentAttestationHash: environmentAttestation.attestationHash,
      pageFingerprint: H("block-page"),
      blocks,
    };
    return Object.freeze({ ...core, integritySha256: H(`xw.visual-block-set.v2:${canonicalJson(core)}`) });
  }

  return {
    root,
    artifactRoot,
    authority,
    boundary,
    dependencyBindingRef,
    environmentAttestation,
    expectation,
    expectedState,
    readFreshCapture,
    load,
    runtimeBinding,
    slotAuthority,
    writeObservation,
    blockSet,
    setFreshCaptureOverride(value) { freshCaptureOverride = value; },
  };
}

test("production dependency loader assembles sealed environment/oracle/selector/guard dependencies", async () => {
  const fixture = buildFixture();
  const dependencies = fixture.load();
  assert.equal(dependencies.environmentAttestation.attestationHash, fixture.environmentAttestation.attestationHash);
  assert.equal(dependencies.effectBoundary.boundaryHash, fixture.boundary.boundaryHash);
  const expected = await dependencies.independentOracle.loadExpectation(fixture.authority);
  assert.equal(expected.expectedArtifactHash, fixture.expectation.expectedArtifactHash);

  const beforeFixture = fixture.writeObservation({ phase: "before", actualStateHash: H("before-business-state") });
  const afterFixture = fixture.writeObservation({ phase: "after", actualStateHash: fixture.expectation.expectedStateHash });
  const before = await dependencies.independentOracle.observe(beforeFixture.authority);
  const after = await dependencies.independentOracle.observe(afterFixture.authority);
  const match = await dependencies.independentOracle.compare({
    expectedStateHash: expected.expectedStateHash,
    expectedArtifactHash: expected.expectedArtifactHash,
    independentAuthorHash: expected.independentAuthorHash,
    beforeObservationHash: before.observationHash,
    afterObservationHash: after.observationHash,
    slotAuthorityHash: fixture.slotAuthority.slotAuthorityHash,
  });
  assert.equal(match.matched, true);
  assert.equal(match.selfDerived, false);

  const selected = await dependencies.targetSelector({
    scenarioKey: fixture.authority.scenarioKey,
    slotAuthority: fixture.slotAuthority,
    blockSet: fixture.blockSet(),
    dumpXml: "<hierarchy/>",
  });
  assert.equal(selected, H("selected-block"));

  const state = await dependencies.currentStateGuard({
    runRef: "run:m64-production",
    frameRef: H("frame"),
    environmentAttestationHash: fixture.environmentAttestation.attestationHash,
    expectedState: fixture.expectedState,
  });
  assert.notEqual(state.frameId, fixture.expectedState.frameId);
  assert.notEqual(state.blockId, fixture.expectedState.blockId);
  assert.deepEqual(
    Object.fromEntries(STATE_FIELDS.filter((field) => !["frameId", "blockId"].includes(field)).map((field) => [field, state[field]])),
    Object.fromEntries(STATE_FIELDS.filter((field) => !["frameId", "blockId"].includes(field)).map((field) => [field, fixture.expectedState[field]])),
  );
});

test("production dependency loader supports deferred per-action fresh-state guard construction", async () => {
  const fixture = buildFixture();
  const dependencies = fixture.load({ readFreshCapture: null });
  assert.equal(dependencies.currentStateGuard, null);
  assert.equal(dependencies.createCurrentStateGuard.maxCaptureAgeMs, 250);
  const guard = dependencies.createCurrentStateGuard({ readFreshCapture: fixture.readFreshCapture });
  const state = await guard({
    runRef: "run:m64-production-dependency",
    frameRef: H("grounding-frame"),
    environmentAttestationHash: fixture.environmentAttestation.attestationHash,
    expectedState: fixture.expectedState,
  });
  assert.notEqual(state.frameId, H("grounding-frame"));
  assert.equal(state.slotSpecHash, fixture.expectedState.slotSpecHash);
});

test("loader rejects tampered and symlinked dependency artifacts", (t) => {
  const tampered = buildFixture();
  writeFileSync(tampered.dependencyBindingRef.path, "{}\n", "utf8");
  assert.throws(() => tampered.load(), (error) => error?.code === "M6_LIVE_DEPENDENCY_ARTIFACT_HASH_MISMATCH");

  const linked = buildFixture();
  const linkPath = join(linked.root, "production-dependencies-link.json");
  try {
    symlinkSync(linked.dependencyBindingRef.path, linkPath, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.diagnostic(`symlink probe skipped: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.throws(() => linked.load({
    runtimeBinding: { ...linked.runtimeBinding, productionDependencyBindingPath: linkPath },
  }), (error) => error?.code === "M6_LIVE_DEPENDENCY_ARTIFACT_NOT_PLAIN");
});

test("production dependency externality rejects a hard-link alias to release-owned bytes", () => {
  const fixture = buildFixture();
  const externalPath = fixture.dependencyBindingRef.path;
  const bytes = readFileSync(externalPath);
  const releaseOwnedPath = join(fixture.root, "release", "rebound-production-dependencies.json");
  unlinkSync(externalPath);
  writeFileSync(releaseOwnedPath, bytes);
  linkSync(releaseOwnedPath, externalPath);
  assert.throws(() => fixture.load(), {
    code: "M6_LIVE_DEPENDENCY_ARTIFACT_NOT_PLAIN",
  });
});

test("independent oracle fails closed for unavailable, stale, circular, or SUT-derived observations", async () => {
  const unavailable = buildFixture();
  const unavailableDependencies = unavailable.load();
  await unavailableDependencies.independentOracle.loadExpectation(unavailable.authority);
  const missingAuthority = {
    ...unavailable.authority,
    phase: "before",
    expectedArtifactHash: unavailable.expectation.expectedArtifactHash,
    independentAuthorHash: unavailable.expectation.independentAuthorHash,
  };
  await assert.rejects(
    unavailableDependencies.independentOracle.observe(missingAuthority),
    (error) => error?.code === "M6_LIVE_DEPENDENCY_ARTIFACT_UNAVAILABLE",
  );

  const stale = buildFixture();
  const staleDependencies = stale.load();
  await staleDependencies.independentOracle.loadExpectation(stale.authority);
  const staleObservation = stale.writeObservation({
    phase: "before",
    actualStateHash: H("stale-state"),
    observedAt: new Date(NOW - 6_000).toISOString(),
  });
  await assert.rejects(
    staleDependencies.independentOracle.observe(staleObservation.authority),
    (error) => error?.code === "M6_LIVE_ORACLE_OBSERVATION_INVALID",
  );

  const forged = buildFixture();
  const forgedDependencies = forged.load();
  await forgedDependencies.independentOracle.loadExpectation(forged.authority);
  const forgedObservation = forged.writeObservation({
    phase: "before",
    actualStateHash: H("forged-state"),
    mutate: (envelope) => ({ ...envelope, signature: Buffer.alloc(64).toString("base64") }),
  });
  await assert.rejects(
    forgedDependencies.independentOracle.observe(forgedObservation.authority),
    (error) => error?.code === "M6_LIVE_ORACLE_OBSERVATION_SIGNATURE_INVALID",
  );

  for (const sourceFactory of [
    () => [
      { kind: "TRANSPORT_RESULT", sha256: H("transport") },
      { kind: "DEVICE_READ_SNAPSHOT", sha256: H("device") },
      { kind: "BACKEND_READ_SNAPSHOT", sha256: H("backend") },
    ],
    (fixture) => [
      { kind: "ACCOUNT_READ_SNAPSHOT", sha256: H("account") },
      { kind: "DEVICE_READ_SNAPSHOT", sha256: H("device") },
      { kind: "BACKEND_READ_SNAPSHOT", sha256: fixture.expectation.expectedArtifactHash },
    ],
  ]) {
    const fixture = buildFixture();
    const dependencies = fixture.load();
    await dependencies.independentOracle.loadExpectation(fixture.authority);
    const observation = fixture.writeObservation({
      phase: "before",
      actualStateHash: H("state"),
      sourceEvidence: sourceFactory(fixture),
    });
    await assert.rejects(
      dependencies.independentOracle.observe(observation.authority),
      (error) => error?.code === "M6_LIVE_ORACLE_SOURCE_NOT_INDEPENDENT",
    );
  }
});

test("semantic selector and fresh-state guard reject ambiguity, stale capture, and model-shaped capture sources", async () => {
  const fixture = buildFixture();
  const dependencies = fixture.load();
  await assert.rejects(dependencies.targetSelector({
    scenarioKey: fixture.authority.scenarioKey,
    slotAuthority: fixture.slotAuthority,
    blockSet: fixture.blockSet({ duplicateMatch: true }),
  }), (error) => error?.code === "M6_LIVE_TARGET_SELECTOR_AMBIGUOUS");

  fixture.setFreshCaptureOverride({
    sourceClass: "MODEL_OUTPUT",
    sourceKind: "RAW_SHELL",
  });
  await assert.rejects(dependencies.currentStateGuard({
    runRef: "run:m64-production",
    frameRef: H("frame"),
    environmentAttestationHash: fixture.environmentAttestation.attestationHash,
    expectedState: fixture.expectedState,
  }), (error) => error?.code === "M6_LIVE_CURRENT_STATE_CAPTURE_INVALID");

  fixture.setFreshCaptureOverride({ state: fixture.expectedState });
  await assert.rejects(dependencies.currentStateGuard({
    runRef: "run:m64-production",
    frameRef: H("frame"),
    environmentAttestationHash: fixture.environmentAttestation.attestationHash,
    expectedState: fixture.expectedState,
  }), (error) => error?.code === "M6_LIVE_CURRENT_STATE_CAPTURE_INVALID");

  fixture.setFreshCaptureOverride({ capturedAt: new Date(NOW - 251).toISOString() });
  await assert.rejects(dependencies.currentStateGuard({
    runRef: "run:m64-production",
    frameRef: H("frame"),
    environmentAttestationHash: fixture.environmentAttestation.attestationHash,
    expectedState: fixture.expectedState,
  }), (error) => error?.code === "M6_LIVE_CURRENT_STATE_CAPTURE_STALE");
});

test("loader refuses a final binding that omits its external dependency manifest", () => {
  const fixture = buildFixture();
  const runtimeBinding = { ...fixture.runtimeBinding };
  delete runtimeBinding.productionDependencyBindingHash;
  assert.throws(() => fixture.load({ runtimeBinding }), (error) => error?.code === "M6_LIVE_PRODUCTION_RUNTIME_BINDING_INVALID");
});
