import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { deriveTargetEnvironmentAttestation } from "../../packages/kernel/lib/m6-live-grounding.mjs";
import {
  M6_TARGET_ENVIRONMENT_QUALIFICATION_TTL_MS,
  deriveM64TargetEnvironmentCommandRegistryHash,
} from "../../services/control-plane/apps/xiaowei/m6-target-environment-qualification.mjs";
import {
  M6_GROUNDED_RUN_CAPABILITY_ID,
} from "../../services/control-plane/control-plane/lib/m6-grounded-run-capability-seal.mjs";
import {
  recomputeM6GateFArtifact,
} from "../../services/control-plane/control-plane/lib/m6-gate-f-operations.mjs";
import { deriveM64IndependentActorHash } from "../../services/control-plane/control-plane/lib/m6-live-production-dependencies.mjs";
import { sha256 } from "../../services/control-plane/control-plane/lib/canonical.mjs";
import {
  M64_FRESH_ASSEMBLER_INPUT_BUILD_SCHEMA_ID,
  M64_ORACLE_ACTOR_TRUST_ROOT_RELEASE_PATH,
  M64_ORACLE_ACTOR_TRUST_ROOT_SHA256,
  buildM64FreshProductionAssemblerInput,
  parseM64FreshAssemblerInputBuilderArgs,
  planM64FreshProductionAssemblerInput,
} from "./m6-4-production-assembler-input-builder.mjs";
import {
  planM64FinalProductionArtifacts,
} from "./m6-4-production-release-assembler.mjs";

const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const CAPTURED_AT = "2029-12-31T23:30:00.000Z";
const EXPIRES_AT = new Date(Date.parse(CAPTURED_AT) + M6_TARGET_ENVIRONMENT_QUALIFICATION_TTL_MS).toISOString();
const RELEASE_ID = "xw-fresh-input-test";
const SOURCE_COMMIT = "a".repeat(40);
const SOURCE_SHORT = SOURCE_COMMIT.slice(0, 7);
const CLOSURE_HASH = "b".repeat(64);
const H = (value) => sha256(String(value));
const SOURCE_LOCK_PATHS = Object.freeze([
  "packages/kernel/contracts/runtime-profile.v1.json",
  "integrations/dsh-xw/config/hard-redline-policy.v1.json",
  "artifacts/m6-4/tcb-manifests/xw.m6-grounded-run.tcb.v1.json",
  "integrations/dsh-xw/src/live-worker-driver.mjs",
  "integrations/dsh-xw/src/live-model-profile.mjs",
  "integrations/dsh-xw/src/live-tools.mjs",
  "integrations/dsh-xw/src/live-network-guard.mjs",
  "packages/kernel/lib/m6-4-live-window-authorization.mjs",
  "integrations/dsh-xw/src/live-parent-broker.mjs",
  "services/control-plane/control-plane/lib/m6-typed-transport.mjs",
]);
const COHORT_FILES = Object.freeze([
  "xw.m6-effect-boundary.v1.json",
  "m6_4_shadow.json",
  "m6_4_hot_close.json",
  "m6_4_action_smoke.json",
  "m6_4_reliability.json",
  "m6_4_smooth.json",
]);

function writeBytes(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return Object.freeze({ path, bytes, sha256: sha256(bytes) });
}

function writeJson(path, value) {
  return writeBytes(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "m64-fresh-input-"));
  const runtimeRoot = join(root, "runtime");
  const releaseRoot = join(runtimeRoot, "releases", RELEASE_ID);
  mkdirSync(releaseRoot, { recursive: true });
  const oracleKeyRoot = join(runtimeRoot, "secrets", "oracle-actor-keys");
  const oracleActors = [
    ["EXPECTATION_AUTHOR", "expectation-author-01"],
    ["OBSERVATION_OBSERVER", "observation-observer-01"],
  ].map(([role, keyId]) => {
    const pair = generateKeyPairSync("ed25519");
    writeBytes(
      join(oracleKeyRoot, `${keyId}.pkcs8.pem`),
      Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })),
    );
    const publicKey = pair.publicKey;
    return Object.freeze({
      role,
      keyId,
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      actorHash: deriveM64IndependentActorHash(publicKey),
      publicKeyFingerprintSha256: sha256(publicKey.export({ type: "spki", format: "der" })),
    });
  });
  const actorTrustRoot = writeJson(
    join(releaseRoot, ...M64_ORACLE_ACTOR_TRUST_ROOT_RELEASE_PATH.split("/")),
    {
      schemaId: "xw.m6-4-independent-oracle-actor-registry.v1",
      actors: oracleActors,
    },
  );
  const releaseManifest = writeJson(join(releaseRoot, "release-manifest.v1.json"), {
    schemaId: "xw.runtime.release-manifest.v1",
    releaseId: RELEASE_ID,
    sourceCommit: SOURCE_COMMIT,
    files: [{
      path: M64_ORACLE_ACTOR_TRUST_ROOT_RELEASE_PATH,
      sha256: actorTrustRoot.sha256,
    }],
  });
  writeJson(join(releaseRoot, "services", "control-plane", "apps", "xiaowei", "capabilities.json"), {
    schemaVersion: 1,
    capabilities: [{
      id: M6_GROUNDED_RUN_CAPABILITY_ID,
      implementation: {
        adapter: "xiaowei",
        action: "m6_grounded_run",
        implementationClosureHash: CLOSURE_HASH,
        tcbManifestRef: "xw.m6-grounded-run.tcb.v1",
      },
    }],
  });
  for (const relativePath of SOURCE_LOCK_PATHS) {
    writeBytes(join(releaseRoot, ...relativePath.split("/")), Buffer.from(`fixture:${relativePath}\n`, "utf8"));
  }
  const releaseCohortRoot = join(releaseRoot, "artifacts", "m6-4", "cohort-manifests");
  for (const filename of COHORT_FILES) {
    writeBytes(
      join(releaseCohortRoot, filename),
      readFileSync(new URL(`../../artifacts/m6-4/cohort-manifests/${filename}`, import.meta.url)),
    );
  }

  const accountIsolationBindingHash = H("account-isolation");
  const attestation = deriveTargetEnvironmentAttestation({
    appPackageHash: H("package"),
    appBuildHash: H("build"),
    signingHash: H("signing"),
    osBuildHash: H("os"),
    displayHash: H("display"),
    localeThemeHash: H("locale"),
    imeHash: H("ime"),
    accessibilityHash: H("accessibility"),
    accountIsolationHash: accountIsolationBindingHash,
    capturedAt: CAPTURED_AT,
    expiresAt: EXPIRES_AT,
  });
  const targetRoot = join(runtimeRoot, "m6-audit", `m6-c1-target-environment-${SOURCE_SHORT}`);
  const attestationRef = writeJson(
    join(targetRoot, "attestations", `${attestation.attestationHash}.json`), attestation,
  );
  const qualification = Object.freeze({
    schemaId: "xw.m6-environment-qualification.v1",
    status: "QUALIFIED",
    gateFEligible: true,
    alias: "01",
    effectBoundary: "READ_ONLY",
    commandRegistryHash: deriveM64TargetEnvironmentCommandRegistryHash(),
    qualifiedAttestationHashes: [attestation.attestationHash],
    sampleCount: 2,
    capturedAt: CAPTURED_AT,
    expiresAt: EXPIRES_AT,
    secretMaterialPresent: false,
    rawDeviceIdentityPresent: false,
    actionCount: 0,
  });
  const qualificationBytes = Buffer.from(`${JSON.stringify(qualification, null, 2)}\n`, "utf8");
  const qualificationSha256 = sha256(qualificationBytes);
  writeBytes(join(targetRoot, "qualifications", `${qualificationSha256}.json`), qualificationBytes);

  const dependencyLayerHash = H("dependency-layer");
  const dependencyRoot = join(runtimeRoot, "m6-runtime-layers", dependencyLayerHash);
  writeJson(join(dependencyRoot, "m6-live-runtime-dependency-layer.v1.json"), {
    schemaId: "xw.m6-live-runtime-dependency-layer.v1",
    layerHash: dependencyLayerHash,
    sourceRelease: {
      releaseId: RELEASE_ID,
      sourceCommit: SOURCE_COMMIT,
      manifestSha256: releaseManifest.sha256,
    },
  });
  const runtimeDependencyQualificationHash = H("runtime-dependency-qualification");
  const modelProfileHash = H("model-profile");
  const modelRoot = join(runtimeRoot, "m6-audit", `m6-c1-live-model-qualification-${SOURCE_SHORT}`);
  mkdirSync(modelRoot, { recursive: true });
  const modelBundle = Object.freeze({
    profile: Object.freeze({
      contentHash: modelProfileHash,
      runtimeDependencyQualificationHash,
      targetEnvironmentAttestationHash: attestation.attestationHash,
      capturedAt: CAPTURED_AT,
      expiresAt: EXPIRES_AT,
    }),
    qualification: Object.freeze({
      runtimeDependencyQualificationHash,
      targetEnvironmentAttestationHash: attestation.attestationHash,
      capturedAt: CAPTURED_AT,
      expiresAt: EXPIRES_AT,
    }),
  });

  writeJson(join(runtimeRoot, "m6-gate", "issuer-keys.json"), {
    schemaId: "xw.m6-gate-issuer-allowlist.v1", keys: [],
  });
  writeJson(join(runtimeRoot, "m6-gate", "live-window-owner-keys.json"), {
    schemaId: "xw.m6-4-live-window-issuer-allowlist.v1", keys: [],
  });
  mkdirSync(join(runtimeRoot, "state", "control-plane", "dsh-persistence"), { recursive: true });

  const verifyRelease = () => Object.freeze({ ok: true, mismatches: [] });
  const verifySeal = () => Object.freeze({
    capabilityId: M6_GROUNDED_RUN_CAPABILITY_ID,
    implementationClosureHash: CLOSURE_HASH,
    tcbManifestRef: "xw.m6-grounded-run.tcb.v1",
    pathCount: 1,
  });
  const verifyDependencyLayer = () => Object.freeze({
    ok: true,
    layerRoot: dependencyRoot,
    layerHash: dependencyLayerHash,
    installedAdapter: Object.freeze({ packageName: "fixture" }),
    qualification: Object.freeze({
      qualificationHash: runtimeDependencyQualificationHash,
      releaseId: RELEASE_ID,
      sourceCommit: SOURCE_COMMIT,
      sourceReleaseManifestSha256: releaseManifest.sha256,
    }),
  });
  const loadModelBundle = (input) => {
    assert.equal(input.qualificationRoot, modelRoot);
    assert.equal(input.expectedProfileHash, modelProfileHash);
    assert.equal(input.requiredRuntimeDependencyQualificationHash, runtimeDependencyQualificationHash);
    assert.equal(input.requiredTargetEnvironmentAttestationHash, attestation.attestationHash);
    return modelBundle;
  };
  const recomputeArtifact = (descriptor, expectedHash, options) => {
    if (descriptor.mode === "LIVE_MODEL_PROFILE") {
      return Object.freeze({ hash: expectedHash, value: modelBundle });
    }
    return recomputeM6GateFArtifact(descriptor, expectedHash, options);
  };
  const assemblerDependencies = Object.freeze({
    verifyReleaseManifest: verifyRelease,
    verifyCapabilitySeal: verifySeal,
    recomputeArtifact,
  });
  const protectedPathChecks = [];
  const dependencies = Object.freeze({
    verifyReleaseManifest: verifyRelease,
    verifyCapabilitySeal: verifySeal,
    verifyDependencyLayer,
    loadModelBundle,
    recomputeArtifact,
    verifyProtectedPath: (input) => {
      protectedPathChecks.push(Object.freeze({ operation: "verify", ...input }));
      return Object.freeze({ ok: true });
    },
    protectProtectedPath: (input) => {
      protectedPathChecks.push(Object.freeze({ operation: "protect", ...input }));
      return Object.freeze({ ok: true });
    },
    actorTrustRootSha256: actorTrustRoot.sha256,
    assemblerDependencies,
  });
  const options = Object.freeze({
    releaseId: RELEASE_ID,
    sourceCommit: SOURCE_COMMIT,
    runtimeRoot,
    targetEnvironmentAttestationHash: attestation.attestationHash,
    environmentQualificationSha256: qualificationSha256,
    dependencyLayerHash,
    modelProfileHash,
    accountIsolationBindingHash,
    now: () => NOW,
    dependencies,
  });
  return Object.freeze({
    root,
    runtimeRoot,
    releaseRoot,
    oracleKeyRoot,
    actorTrustRoot,
    protectedPathChecks,
    attestation,
    attestationRef,
    qualificationSha256,
    dependencyLayerHash,
    modelProfileHash,
    accountIsolationBindingHash,
    modelBundle,
    dependencies,
    options,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  });
}

function fixedCliArgs(f, operation = "preflight-fixed") {
  return [
    operation,
    RELEASE_ID,
    SOURCE_COMMIT,
    f.attestation.attestationHash,
    f.qualificationSha256,
    f.dependencyLayerHash,
    f.modelProfileHash,
    f.accountIsolationBindingHash,
  ];
}

test("tracked public actor trust root preserves the three-build historical byte identity", () => {
  const bytes = readFileSync(new URL(
    `../../${M64_ORACLE_ACTOR_TRUST_ROOT_RELEASE_PATH}`,
    import.meta.url,
  ));
  assert.equal(bytes.length, 923);
  assert.equal(sha256(bytes), M64_ORACLE_ACTOR_TRUST_ROOT_SHA256);
  const value = JSON.parse(bytes.toString("utf8"));
  assert.deepEqual(value.actors.map(({ role, keyId, actorHash }) => ({ role, keyId, actorHash })), [
    {
      role: "EXPECTATION_AUTHOR",
      keyId: "expectation-author-01",
      actorHash: "28a740fab10170c1004f7844ee157abf2f09ee27f76249a8ce4fa45059555715",
    },
    {
      role: "OBSERVATION_OBSERVER",
      keyId: "observation-observer-01",
      actorHash: "4e92de303de052c1281e8058c03ce0090c45bd7bdd8bc400f69b0c91f6a2deef",
    },
  ]);
});

test("fresh builder derives one fixed, content-addressed assembler input without caller JSON or writes", () => {
  const f = fixture();
  try {
    const plan = planM64FreshProductionAssemblerInput(f.options);
    assert.equal(plan.schemaId, M64_FRESH_ASSEMBLER_INPUT_BUILD_SCHEMA_ID);
    assert.equal(plan.mode, "PREFLIGHT");
    assert.equal(plan.writesPerformed, false);
    assert.equal(plan.input.windows.length, 5);
    assert.equal(plan.expectationCount, 59);
    assert.equal(plan.input.release.root, f.releaseRoot);
    assert.equal(plan.input.runtime.dependencyLayerHash, f.dependencyLayerHash);
    assert.equal(plan.input.runtime.modelProfileHash, f.modelProfileHash);
    assert.equal(plan.input.runtime.providerBaseUrl, "https://api.deepseek.com");
    assert.equal(plan.authority.oracleActorTrustRootSha256, f.actorTrustRoot.sha256);
    assert.equal(basename(plan.inputArtifact.path), `${plan.inputSha256}.json`);
    assert.equal(plan.inputArtifact.sha256, plan.inputSha256);
    assert.equal(Object.hasOwn(plan, "actors"), false);
    assert.ok(f.protectedPathChecks.some((item) => item.targetPath === f.releaseRoot && item.recursive === true));
    assert.ok(f.protectedPathChecks.some((item) => item.targetPath === join(
      f.oracleKeyRoot, "expectation-author-01.pkcs8.pem",
    )));
    assert.equal(existsSync(plan.bundleRoot), false);
    assert.equal(existsSync(plan.assemblerRoot), false);
    const parsed = parseM64FreshAssemblerInputBuilderArgs(fixedCliArgs(f));
    assert.equal(parsed.releaseId, RELEASE_ID);
    assert.equal(parsed.sourceCommit, SOURCE_COMMIT);
    assert.equal(parsed.execute, false);
    for (const rejected of [
      ["--runtime-root", "C:\\attacker"],
      ["--release-root", "C:\\attacker"],
      ["--input", join(f.root, "caller.json")],
      ["--path", "C:\\attacker"],
      ["C:\\attacker"],
      [...fixedCliArgs(f), "C:\\attacker"],
    ]) {
      assert.throws(
        () => parseM64FreshAssemblerInputBuilderArgs(rejected),
        (error) => error.code === "M64_FRESH_CLI_INVALID",
      );
    }
    for (const window of plan.input.windows) {
      assert.equal(window.lockArtifacts.modelProfile.expectedHash, f.modelProfileHash);
      assert.equal(window.lockArtifacts.environmentQualification.expectedHash, f.qualificationSha256);
      assert.equal(
        window.runtimeArtifacts.environmentAttestation.expectedHash,
        f.attestation.attestationHash,
      );
    }
    const expectations = plan.artifacts
      .filter((item) => item.label.endsWith("signed expectation"))
      .map((item) => JSON.parse(item.bytes.toString("utf8")).expectation);
    assert.equal(expectations.length, 59);
    assert.equal(new Set(expectations.map((item) => item.environmentAttestationHash)).size, 1);
    assert.equal(new Set(expectations.map((item) => item.accountIsolationHash)).size, 1);
    assert.equal(new Set(expectations.map((item) => item.authoredAt)).size, 1);
    assert.equal(new Set(expectations.map((item) => item.expiresAt)).size, 1);
    assert.equal(expectations[0].environmentAttestationHash, f.attestation.attestationHash);
    assert.equal(expectations[0].accountIsolationHash, f.accountIsolationBindingHash);
  } finally { f.cleanup(); }
});

test("execute publishes dependencies then the assembler-validated input create-only and exact replay is idempotent", () => {
  const f = fixture();
  try {
    const first = buildM64FreshProductionAssemblerInput({ ...f.options, execute: true });
    assert.equal(first.mode, "EXECUTE");
    assert.equal(first.writesPerformed, true);
    assert.equal(first.exactReplay, false);
    assert.equal(first.privateKeyMaterialRead, true);
    assert.equal(first.privateKeyMaterialPublished, false);
    assert.equal(first.secretMaterialPublished, false);
    assert.doesNotMatch(JSON.stringify(first), /(?:signature|BEGIN (?:PUBLIC|PRIVATE) KEY)/u);
    assert.ok(existsSync(first.assemblerInputPath));
    assert.ok(existsSync(first.assemblerReceiptPath));
    assert.equal(basename(first.assemblerReceiptPath), `${first.assemblerReceiptHash}.json`);
    assert.equal(sha256(readFileSync(first.assemblerReceiptPath)), first.assemblerReceiptSha256);
    assert.equal(first.assemblerArtifactsPublished, 9);
    const installedActorTrustRoot = join(f.runtimeRoot, "m6-gate", "oracle-actor-keys.json");
    assert.equal(sha256(readFileSync(installedActorTrustRoot)), f.actorTrustRoot.sha256);
    const inputBytes = readFileSync(first.assemblerInputPath);
    assert.equal(sha256(inputBytes), first.assemblerInputSha256);
    const input = JSON.parse(inputBytes.toString("utf8"));
    const assemblerPlan = planM64FinalProductionArtifacts({
      input,
      now: () => NOW,
      dependencies: f.dependencies.assemblerDependencies,
    });
    assert.equal(assemblerPlan.writesPerformed, false);
    assert.equal(assemblerPlan.exactReplayAvailable, true);
    assert.equal(assemblerPlan.receiptPath, first.assemblerReceiptPath);
    assert.equal(assemblerPlan.receipt.receiptHash, first.assemblerReceiptHash);
    const second = buildM64FreshProductionAssemblerInput({ ...f.options, execute: true });
    assert.equal(second.exactReplay, true);
    assert.equal(second.assemblerInputPath, first.assemblerInputPath);
    assert.equal(second.assemblerInputSha256, first.assemblerInputSha256);
    assert.equal(second.assemblerReceiptHash, first.assemblerReceiptHash);
  } finally { f.cleanup(); }
});

test("builder fails closed on cross-account, stale, model/dependency, release identity, and signer rebound", () => {
  const f = fixture();
  try {
    const { actorTrustRootSha256: ignoredTestTrustRoot, ...productionTrustDependencies } = f.dependencies;
    assert.ok(ignoredTestTrustRoot);
    assert.throws(
      () => planM64FreshProductionAssemblerInput({
        ...f.options,
        dependencies: productionTrustDependencies,
      }),
      (error) => error.code === "M64_FRESH_ACTOR_TRUST_ROOT_INVALID",
    );
    assert.throws(
      () => planM64FreshProductionAssemblerInput({
        ...f.options,
        dependencies: {
          ...f.dependencies,
          verifyProtectedPath: () => { throw Object.assign(new Error("fixture ACL drift"), { code: "ACL_DRIFT" }); },
        },
      }),
      (error) => error.code === "M64_FRESH_TCB_ACL_INVALID",
    );
    assert.throws(
      () => planM64FreshProductionAssemblerInput({
        ...f.options,
        accountIsolationBindingHash: H("another-account"),
      }),
      (error) => error.code === "M64_FRESH_ENVIRONMENT_BINDING_INVALID",
    );
    assert.throws(
      () => planM64FreshProductionAssemblerInput({
        ...f.options,
        now: () => Date.parse(EXPIRES_AT) + 1,
      }),
      (error) => ["M6_GATE_F_ENVIRONMENT_ATTESTATION_INVALID", "M64_FRESH_ENVIRONMENT_BINDING_INVALID"].includes(error.code),
    );
    assert.throws(
      () => planM64FreshProductionAssemblerInput({
        ...f.options,
        dependencies: {
          ...f.dependencies,
          loadModelBundle: () => ({
            ...f.modelBundle,
            profile: { ...f.modelBundle.profile, targetEnvironmentAttestationHash: H("wrong-target") },
          }),
        },
      }),
      (error) => error.code === "M64_FRESH_MODEL_BINDING_INVALID",
    );
    assert.throws(
      () => planM64FreshProductionAssemblerInput({ ...f.options, releaseId: "xw-rebound-release" }),
      (error) => ["M64_FRESH_PATH_UNAVAILABLE", "M64_FRESH_RELEASE_BINDING_INVALID"].includes(error.code),
    );
    const reboundPair = generateKeyPairSync("ed25519");
    writeFileSync(
      join(f.oracleKeyRoot, "expectation-author-01.pkcs8.pem"),
      reboundPair.privateKey.export({ type: "pkcs8", format: "pem" }),
    );
    assert.throws(
      () => planM64FreshProductionAssemblerInput(f.options),
      (error) => error.code === "M64_FRESH_SIGNER_REBOUND",
    );
    assert.equal(existsSync(join(f.runtimeRoot, "m6-audit", "m6-c1-final-builds")), false);
  } finally { f.cleanup(); }
});

test("content-addressed input refuses different bytes instead of replacing them", () => {
  const f = fixture();
  try {
    const first = buildM64FreshProductionAssemblerInput({ ...f.options, execute: true });
    writeFileSync(first.assemblerInputPath, Buffer.from("{}\n", "utf8"));
    assert.throws(
      () => buildM64FreshProductionAssemblerInput({ ...f.options, execute: true }),
      (error) => error.code === "M64_FRESH_REFUSE_DIFFERENT",
    );
  } finally { f.cleanup(); }
});
