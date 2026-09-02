import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { deriveTargetEnvironmentAttestation } from "../packages/kernel/lib/m6-live-grounding.mjs";
import { deriveM64TargetEnvironmentCommandRegistryHash } from "../services/control-plane/apps/xiaowei/m6-target-environment-qualification.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const repositoryRoot = resolve(new URL("../", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/u, ""));

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function gitObjectId(type, bytes) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return createHash("sha1").update(Buffer.concat([
    Buffer.from(`${type} ${body.length}\0`, "utf8"), body,
  ])).digest("hex");
}

function gitTreeOid(entries) {
  const root = { children: new Map() };
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.children.has(part)) node.children.set(part, { kind: "tree", children: new Map() });
      node = node.children.get(part);
    }
    node.children.set(parts.at(-1), { kind: "blob", gitMode: entry.gitMode, objectId: entry.gitBlobOid });
  }
  const seal = (node) => {
    const children = [...node.children.entries()].map(([name, child]) => child.kind === "tree"
      ? { name, kind: "tree", gitMode: "40000", objectId: seal(child) }
      : { name, ...child })
      .sort((left, right) => Buffer.compare(
        Buffer.from(`${left.name}${left.kind === "tree" ? "/" : ""}`, "utf8"),
        Buffer.from(`${right.name}${right.kind === "tree" ? "/" : ""}`, "utf8"),
      ));
    return gitObjectId("tree", Buffer.concat(children.flatMap((entry) => [
      Buffer.from(`${entry.gitMode} ${entry.name}\0`, "utf8"),
      Buffer.from(entry.objectId, "hex"),
    ])));
  };
  return seal(root);
}

function releaseServiceTreeSha(files, prefix) {
  const digest = createHash("sha256");
  for (const entry of files) {
    if (entry.path.startsWith(`${prefix}/`)) digest.update(`${entry.path}:${entry.sha256}\n`, "utf8");
  }
  return digest.digest("hex");
}

function writeJson(path, value) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function m6RuntimeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "xw-m6-c1-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contract = JSON.parse(read("config/runtime/xw-runtime.v1.json"));
  contract.runtimeRoot = root;
  contract.m6C1.nodeExecutable = process.execPath;
  contract.m6C1.nodeVersion = process.versions.node;
  for (const directory of contract.directories) mkdirSync(join(root, ...directory.split("/")), { recursive: true });

  const releaseId = "m6-c1-test-release";
  const sourceCommit = "a".repeat(40);
  const releaseRoot = join(root, "releases", releaseId);
  mkdirSync(releaseRoot, { recursive: true });
  const releaseSources = [
    {
      path: "services/control-plane/control-plane/server.mjs",
      gitMode: "100644",
      bytes: Buffer.from([
        "import { writeFileSync } from \"node:fs\";",
        "const names = [\"XW_M6_TARGET_ENVIRONMENT_ATTESTATION_PATH\", \"XW_M6_TARGET_ENVIRONMENT_ATTESTATION_HASH\", \"XW_M6_ENVIRONMENT_QUALIFICATION_PATH\", \"XW_M6_ENVIRONMENT_QUALIFICATION_SHA256\"];",
        "if (process.env.XW_M6_TEST_CAPTURE_ENV_PATH) writeFileSync(process.env.XW_M6_TEST_CAPTURE_ENV_PATH, JSON.stringify(Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]))));",
        "",
      ].join("\n"), "utf8"),
    },
    {
      path: "services/orchestrator/campaign/fixture.sh",
      gitMode: "100755",
      bytes: Buffer.from("#!/bin/sh\nexit 0\n", "utf8"),
    },
  ];
  const releaseFiles = releaseSources.map((entry) => {
    const path = join(releaseRoot, ...entry.path.split("/"));
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, entry.bytes);
    return {
      path: entry.path,
      gitMode: entry.gitMode,
      gitBlobOid: gitObjectId("blob", entry.bytes),
      sha256: createHash("sha256").update(entry.bytes).digest("hex"),
    };
  }).sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const sourceTreeSha = gitTreeOid(releaseFiles);
  const manifestPath = writeJson(join(releaseRoot, "release-manifest.v1.json"), {
    schemaId: "xw.runtime.release-manifest.v1",
    releaseId,
    sourceRepo: "gifted-professor/xw-platform",
    sourceCommit,
    sourceTreeSha,
    runtimeProfile: contract.runtimeProfile,
    nodeVersion: process.versions.node,
    npmVersion: "test",
    services: {
      orchestrator: {
        path: "services/orchestrator",
        treeSha256: releaseServiceTreeSha(releaseFiles, "services/orchestrator"),
      },
      controlPlane: {
        path: "services/control-plane",
        treeSha256: releaseServiceTreeSha(releaseFiles, "services/control-plane"),
      },
    },
    files: releaseFiles,
    runtimeCutoverAllowed: false,
  });
  symlinkSync(releaseRoot, join(root, "current"), "junction");
  const releaseManifestSha256 = sha256(manifestPath);

  const dependencyLayerHash = "c".repeat(64);
  const dependencyRoot = join(root, "layers", dependencyLayerHash);
  writeJson(join(dependencyRoot, "m6-live-runtime-dependency-layer.v1.json"), {
    schemaId: "xw.m6-live-runtime-dependency-layer.v1",
    layerHash: dependencyLayerHash,
    sourceRelease: { releaseId, sourceCommit, manifestSha256: releaseManifestSha256 },
  });
  const capturedAtMs = Date.now() - 1_000;
  const capturedAt = new Date(capturedAtMs).toISOString();
  const expiresAt = new Date(capturedAtMs + (6 * 60 * 60 * 1_000)).toISOString();
  const targetEnvironment = deriveTargetEnvironmentAttestation({
    appPackageHash: "1".repeat(64),
    appBuildHash: "2".repeat(64),
    signingHash: "3".repeat(64),
    osBuildHash: "4".repeat(64),
    displayHash: "5".repeat(64),
    localeThemeHash: "6".repeat(64),
    imeHash: "7".repeat(64),
    accessibilityHash: "8".repeat(64),
    accountBindingHash: "e".repeat(64),
    accountIsolationHash: "9".repeat(64),
    capturedAt,
    expiresAt,
  });
  const targetEnvironmentAttestationHash = targetEnvironment.attestationHash;
  const targetEnvironmentAttestationPath = writeJson(
    join(root, "environment", `${targetEnvironmentAttestationHash}.json`),
    targetEnvironment,
  );
  const environmentQualificationPath = writeJson(join(root, "environment", "qualification.json"), {
    schemaId: "xw.m6-environment-qualification.v1",
    status: "QUALIFIED",
    gateFEligible: true,
    alias: "01",
    effectBoundary: "READ_ONLY",
    commandRegistryHash: deriveM64TargetEnvironmentCommandRegistryHash(),
    sampleCount: 2,
    actionCount: 0,
    secretMaterialPresent: false,
    rawDeviceIdentityPresent: false,
    qualifiedAttestationHashes: [targetEnvironmentAttestationHash],
    capturedAt,
    expiresAt,
  });
  const environmentQualificationSha256 = sha256(environmentQualificationPath);
  const modelProfileHash = "d".repeat(64);
  const modelProfileRoot = join(root, "model-qualification");
  writeJson(join(modelProfileRoot, `${modelProfileHash}.json`), {
    schemaId: "xw.m6-live-model-profile.v1",
    status: "QUALIFIED",
    gateFEligible: true,
    provider: "deepseek-official",
    contentHash: modelProfileHash,
    targetEnvironmentAttestationHash,
    expiresAt,
  });
  const manifestRoot = join(root, "cohort-manifests");
  const persistenceRoot = join(root, "state", "control-plane", "dsh-live");
  mkdirSync(manifestRoot, { recursive: true });
  mkdirSync(persistenceRoot, { recursive: true });
  const runtimeSnapshotPath = writeJson(join(root, "state", "control-plane", "runtime-snapshot.json"), { sealed: true });
  const gateIssuerAllowlistPath = writeJson(join(root, "m6-gate", "issuer-keys.json"), { schemaId: "test" });
  const liveAuthorizationIssuerAllowlistPath = writeJson(join(root, "m6-gate", "live-window-owner-keys.json"), { schemaId: "test" });
  const gateArtifactRoot = join(root, "gate-f-artifacts");
  const dummyLockPath = writeJson(join(gateArtifactRoot, "dummy-lock.json"), { sealed: true });
  const dummyRuntimePath = writeJson(join(gateArtifactRoot, "dummy-runtime.json"), { sealed: true });
  const catalogPurposes = [
    ["M6_4_SHADOW", "artifacts/m6-4/cohort-manifests/m6_4_shadow.json"],
    ["M6_4_HOT_CLOSE", "artifacts/m6-4/cohort-manifests/m6_4_hot_close.json"],
    ["M6_4_ACTION_SMOKE", "artifacts/m6-4/cohort-manifests/m6_4_action_smoke.json"],
    ["M6_4_RELIABILITY", "artifacts/m6-4/cohort-manifests/m6_4_reliability.json"],
    ["M6_4_SMOOTH", "artifacts/m6-4/cohort-manifests/m6_4_smooth.json"],
  ];
  const lockKinds = [
    "runtimeProfile", "hardRedlinePolicy", "groundingRuntime", "dshSource", "dshProfile",
    "liveToolSpec", "modelProfile", "liveProvider", "grantActionPolicy", "brokerProtocol",
    "typedTransport", "scenarioManifest", "environmentQualification",
  ];
  const baseLockArtifacts = Object.fromEntries(lockKinds.map((kind) => [kind, {
    mode: kind === "modelProfile" ? "LIVE_MODEL_PROFILE"
      : kind === "scenarioManifest" ? "M6_COHORT_MANIFEST"
        : kind === "environmentQualification" ? "ENVIRONMENT_QUALIFICATION" : "RAW_SHA256",
    path: kind === "modelProfile" ? modelProfileRoot
      : kind === "environmentQualification" ? environmentQualificationPath : dummyLockPath,
  }]));
  const catalogEntries = catalogPurposes.map(([purpose, sourcePath], index) => {
    const scenarioManifest = JSON.parse(read(sourcePath));
    const scenarioManifestPath = writeJson(join(manifestRoot, `${index + 1}-${purpose.toLowerCase()}.json`), scenarioManifest);
    const inventoryBody = {
      schemaId: "xw.m6-gate-f-artifact-inventory.v1",
      release: { root: releaseRoot, manifestPath },
      lockArtifacts: {
        ...baseLockArtifacts,
        scenarioManifest: { mode: "M6_COHORT_MANIFEST", path: scenarioManifestPath },
      },
      runtimeArtifacts: {
        environmentAttestation: { mode: "TARGET_ENV_ATTESTATION", path: targetEnvironmentAttestationPath },
        independentOracle: { mode: "RAW_SHA256", path: dummyRuntimePath },
        operator: { mode: "RAW_SHA256", path: dummyRuntimePath },
        resetObligations: { mode: "RAW_SHA256", path: dummyRuntimePath },
      },
    };
    const inventoryHash = hashText(
      `xw.m6-gate-f-artifact-inventory.v1:${JSON.stringify(canonicalize(inventoryBody))}`,
    );
    const inventoryPath = writeJson(join(root, "state", "control-plane", `gate-f-inventory-${index + 1}.json`), {
      ...inventoryBody,
      inventoryHash,
    });
    return {
      purpose,
      scenarioManifestHash: scenarioManifest.manifestHash,
      inventoryPath,
      inventorySha256: sha256(inventoryPath),
      inventoryHash,
    };
  });
  const catalogBody = {
    schemaId: "xw.m6-gate-f-artifact-catalog.v1",
    release: { releaseId, sourceCommit },
    entries: catalogEntries,
  };
  const gateFArtifactCatalogHash = hashText(
    `xw.m6-gate-f-artifact-catalog.v1:${JSON.stringify(canonicalize(catalogBody))}`,
  );
  const gateFArtifactCatalogPath = writeJson(join(root, "state", "control-plane", "gate-f-catalog.json"), {
    ...catalogBody,
    catalogHash: gateFArtifactCatalogHash,
  });
  const gateFArtifactCatalogSha256 = sha256(gateFArtifactCatalogPath);
  const productionDependencyBindingPath = writeJson(
    join(root, "production-dependencies", "production-dependency-binding.json"),
    { schemaId: "xw.m6-4-production-dependency-binding.v1", fixture: true },
  );
  const productionDependencyBindingHash = sha256(productionDependencyBindingPath);
  const bindingPath = join(root, ...contract.m6C1.bindingPath.split("/"));
  const binding = {
    schemaId: contract.m6C1.bindingSchemaId,
    releaseId,
    sourceCommit,
    sourceReleaseRoot: releaseRoot,
    releaseManifestSha256,
    dependencyRoot,
    dependencyLayerHash,
    modelProfileRoot,
    modelProfileHash,
    providerBaseUrl: contract.m6C1.providerBaseUrl,
    manifestRoot,
    runtimeSnapshotPath,
    dshPersistenceRoot: persistenceRoot,
    gateId: "m6-c1-test-gate",
    gateIssuerAllowlistPath,
    liveAuthorizationIssuerAllowlistPath,
    gateFArtifactCatalogPath,
    gateFArtifactCatalogHash,
    gateFArtifactCatalogSha256,
    targetEnvironmentAttestationPath,
    targetEnvironmentAttestationHash,
    environmentQualificationPath,
    environmentQualificationSha256,
    productionDependencyBindingPath,
    productionDependencyBindingHash,
  };
  writeJson(bindingPath, binding);
  const qualificationBindingPath = join(root, ...contract.m6C1.qualificationBindingPath.split("/"));
  const qualificationBinding = {
    schemaId: contract.m6C1.qualificationBindingSchemaId,
    releaseId,
    sourceCommit,
    sourceReleaseRoot: releaseRoot,
    releaseManifestSha256,
    gateId: "m6-c1-test-gate",
    gateIssuerAllowlistPath,
    gateFArtifactInventoryPath: join(root, "qualification-bootstrap", "final-inventory-unavailable.json"),
    gateFArtifactInventoryHash: "2".repeat(64),
  };
  writeJson(qualificationBindingPath, qualificationBinding);
  writeJson(join(root, "secrets", "control-plane.devices.json"), {
    schemaVersion: 1,
    nodeId: "DESKTOP-3I1EVHE",
    devices: [{ deviceId: "public-device-01", alias: "01", online: true, quarantined: false }],
  });
  const contractPath = writeJson(join(root, "xw-runtime.v1.json"), contract);
  const secrets = {
    DEEPSEEK_API_KEY: "sk-test-runtime-secret",
    XW_M6_GATE_F_OPERATIONS_TOKEN: "gate-f-test-token-that-is-at-least-32-bytes",
    XW_M6_LIVE_ENTRY_TOKEN: "live-entry-test-token-at-least-32-bytes",
    XW_M6_ACCOUNT_ISOLATION_BINDING_HASH: "e".repeat(64),
  };
  return {
    root, contractPath, bindingPath, binding, qualificationBindingPath, qualificationBinding, secrets,
    gateFArtifactCatalogPath, catalogEntries, manifestPath, releaseRoot, releaseFiles,
  };
}

function resealCatalogFixture(fixture, mutate) {
  const catalog = JSON.parse(readFileSync(fixture.gateFArtifactCatalogPath, "utf8"));
  mutate(catalog);
  catalog.catalogHash = hashText(`xw.m6-gate-f-artifact-catalog.v1:${JSON.stringify(canonicalize(
    Object.fromEntries(Object.entries(catalog).filter(([key]) => key !== "catalogHash")),
  ))}`);
  writeJson(fixture.gateFArtifactCatalogPath, catalog);
  fixture.binding.gateFArtifactCatalogHash = catalog.catalogHash;
  fixture.binding.gateFArtifactCatalogSha256 = sha256(fixture.gateFArtifactCatalogPath);
  writeJson(fixture.bindingPath, fixture.binding);
}

function resealReleaseManifestFixture(fixture, mutate) {
  const manifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8"));
  mutate(manifest);
  writeJson(fixture.manifestPath, manifest);
  const releaseManifestSha256 = sha256(fixture.manifestPath);
  fixture.binding.releaseManifestSha256 = releaseManifestSha256;
  fixture.qualificationBinding.releaseManifestSha256 = releaseManifestSha256;
  writeJson(fixture.bindingPath, fixture.binding);
  writeJson(fixture.qualificationBindingPath, fixture.qualificationBinding);
  const layerPath = join(fixture.binding.dependencyRoot, "m6-live-runtime-dependency-layer.v1.json");
  const layer = JSON.parse(readFileSync(layerPath, "utf8"));
  layer.sourceRelease.manifestSha256 = releaseManifestSha256;
  writeJson(layerPath, layer);
}

function runPowerShell(script, args, env) {
  return spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(repositoryRoot, ...script.split("/")), ...args,
  ], { cwd: repositoryRoot, encoding: "utf8", env: { ...process.env, ...env } });
}

test("FastOperator installer registers SYSTEM tasks with an AtStartup trigger", () => {
  const source = read("services/control-plane/scripts/fast-operator-serve-task.ps1");
  assert.match(source, /New-ScheduledTaskTrigger\s+-AtStartup/);
  assert.match(source, /Register-ScheduledTask[^\r\n]+-Trigger\s+\$trigger/);
  assert.match(source, /New-ScheduledTaskPrincipal\s+-UserId\s+"SYSTEM"/);
});

test("runtime checker requires enabled healthy tasks, exact principal, run level and trigger", () => {
  const source = read("tools/check-xw-runtime.ps1");
  for (const signal of ["$enabled", "$stateOk", "$principalOk", "$runLevelOk", "$triggerOk"]) {
    assert.match(source, new RegExp(`\\${signal}\\b`));
  }
  const contract = JSON.parse(read("config/runtime/xw-runtime.v1.json"));
  assert.ok(contract.directories.includes("state/orchestrator/trace"));
  assert.equal(contract.scheduledTasks.length, 6);
  for (const task of contract.scheduledTasks) {
    assert.equal(task.principal, "SYSTEM");
    assert.equal(task.requiredTrigger, "MSFT_TaskBootTrigger");
    assert.ok(["Limited", "Highest"].includes(task.runLevel));
  }
  assert.equal(contract.m6C1.schemaId, "xw.runtime.m6-c1-launch-contract.v1");
  assert.equal(contract.m6C1.bindingSchemaId, "xw.runtime.m6-c1-runtime.v1");
  assert.equal(contract.m6C1.qualificationBindingSchemaId, "xw.runtime.m6-c1-qualification-bootstrap.v1");
  assert.deepEqual(contract.m6C1.runtimeModes, ["QUALIFICATION_ONLY", "FINAL"]);
  assert.deepEqual([...contract.m6C1.requiredSecretEnvironment].sort(), [
    "DEEPSEEK_API_KEY", "XW_M6_GATE_F_OPERATIONS_TOKEN", "XW_M6_LIVE_ENTRY_TOKEN",
  ]);
  assert.deepEqual(contract.m6C1.requiredOpaqueEnvironment, ["XW_M6_ACCOUNT_ISOLATION_BINDING_HASH"]);
  assert.deepEqual(contract.m6C1.qualificationRequiredSecretEnvironment, ["XW_M6_GATE_F_OPERATIONS_TOKEN"]);
  assert.deepEqual(contract.m6C1.qualificationRequiredOpaqueEnvironment, ["XW_M6_ACCOUNT_ISOLATION_BINDING_HASH"]);
  assert.ok(contract.runtimeFiles.some((entry) => entry.path === contract.m6C1.bindingPath
    && entry.kind === "non-secret-runtime-binding" && entry.required === true));
});

test("M6-C1 qualification-only launcher breaks the bootstrap cycle without final or provider authority", {
  skip: process.platform !== "win32",
}, (t) => {
  const fixture = m6RuntimeFixture(t);
  rmSync(fixture.bindingPath);
  const environment = {
    ...fixture.secrets,
    DEEPSEEK_API_KEY: "",
    XW_M6_LIVE_ENTRY_TOKEN: "",
  };
  const result = runPowerShell("services/control-plane/scripts/xw-control-plane-runtime.ps1", [
    "-RuntimeRoot", fixture.root, "-ContractPath", fixture.contractPath,
    "-Mode", "QUALIFICATION_ONLY", "-ValidateOnly",
  ], environment);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.runtimeMode, "QUALIFICATION_ONLY");
  assert.deepEqual(receipt.routeSet, [
    "health", "gate-status", "alias01-device-binding", "qualification-job-submit", "qualification-job-status",
  ]);
  assert.equal(receipt.gateFArtifactInventory, "deliberately-unavailable-for-mutations");
  assert.equal(JSON.stringify(receipt).includes("DEEPSEEK_API_KEY"), false);
  const checked = runPowerShell("tools/check-xw-runtime.ps1", [
    "-ContractPath", fixture.contractPath, "-Mode", "QUALIFICATION_ONLY",
    "-M6C1Only", "-SkipHealthCheck",
  ], environment);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).runtimeMode, "QUALIFICATION_ONLY");
  for (const secret of Object.values(fixture.secrets)) {
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}\n${checked.stdout}\n${checked.stderr}`, new RegExp(secret, "u"));
  }
});

test("M6-C1 FINAL launcher rejects a credential shared by Gate-F and live-entry authorities", {
  skip: process.platform !== "win32",
}, (t) => {
  const fixture = m6RuntimeFixture(t);
  const shared = "shared-final-authority-token-that-is-at-least-32-bytes";
  const result = runPowerShell("services/control-plane/scripts/xw-control-plane-runtime.ps1", [
    "-RuntimeRoot", fixture.root, "-ContractPath", fixture.contractPath,
    "-Mode", "FINAL", "-ValidateOnly",
  ], {
    ...fixture.secrets,
    XW_M6_GATE_F_OPERATIONS_TOKEN: shared,
    XW_M6_LIVE_ENTRY_TOKEN: shared,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /M6_C1_AUTHORITY_TOKEN_SEPARATION_REQUIRED/u);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(shared, "u"));
});

test("M6-C1 qualification-only launcher rejects an activation-capable inventory and missing route token", {
  skip: process.platform !== "win32",
}, async (t) => {
  await t.test("inventory-sentinel-must-remain-absent", (subtest) => {
    const fixture = m6RuntimeFixture(subtest);
    writeJson(fixture.qualificationBinding.gateFArtifactInventoryPath, { forbidden: true });
    const result = runPowerShell("services/control-plane/scripts/xw-control-plane-runtime.ps1", [
      "-RuntimeRoot", fixture.root, "-ContractPath", fixture.contractPath,
      "-Mode", "QUALIFICATION_ONLY", "-ValidateOnly",
    ], fixture.secrets);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /M6_C1_QUALIFICATION_SENTINEL_INVALID/u);
  });
  await t.test("operations-token-required", (subtest) => {
    const fixture = m6RuntimeFixture(subtest);
    const result = runPowerShell("services/control-plane/scripts/xw-control-plane-runtime.ps1", [
      "-RuntimeRoot", fixture.root, "-ContractPath", fixture.contractPath,
      "-Mode", "QUALIFICATION_ONLY", "-ValidateOnly",
    ], { ...fixture.secrets, XW_M6_GATE_F_OPERATIONS_TOKEN: "" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /M6_C1_REQUIRED_ENVIRONMENT_UNAVAILABLE:XW_M6_GATE_F_OPERATIONS_TOKEN/u);
  });
});

test("M6-C1 launcher maps every non-secret bootstrap input while health remains release-bound", () => {
  const launcher = read("services/control-plane/scripts/xw-control-plane-runtime.ps1");
  for (const name of [
    "M6_ENABLED", "M6_LIVE_ENTRY_ENABLED", "M6_GATE_F_OPERATIONS_ENABLED", "XW_RUNTIME_ROOT",
    "XW_GATE_ID", "XW_GATE_ISSUER_KEYS_PATH", "XW_M6_SOURCE_RELEASE_ROOT",
    "XW_M6_LIVE_DEPENDENCY_ROOT", "XW_M6_LIVE_DEPENDENCY_LAYER_HASH",
    "XW_M6_LIVE_PROVIDER_BASE_URL", "XW_M6_LIVE_MODEL_PROFILE_ROOT", "XW_M6_LIVE_MODEL_PROFILE_HASH",
    "XW_M6_LIVE_MANIFEST_ROOT", "XW_M6_LIVE_RUNTIME_SNAPSHOT_PATH", "XW_DSH_PERSISTENCE_ROOT",
    "XW_M6_LIVE_AUTH_ISSUER_KEYS_PATH", "XW_M6_GATE_F_ARTIFACT_INVENTORY_PATH",
    "XW_M6_GATE_F_ARTIFACT_INVENTORY_HASH", "XW_M6_GATE_F_ARTIFACT_CATALOG_PATH",
    "XW_M6_GATE_F_ARTIFACT_CATALOG_HASH", "XW_M6_PRODUCTION_DEPENDENCY_BINDING_PATH",
    "XW_M6_PRODUCTION_DEPENDENCY_BINDING_HASH",
    "XW_M6_TARGET_ENVIRONMENT_ATTESTATION_PATH", "XW_M6_TARGET_ENVIRONMENT_ATTESTATION_HASH",
    "XW_M6_ENVIRONMENT_QUALIFICATION_PATH", "XW_M6_ENVIRONMENT_QUALIFICATION_SHA256",
  ]) {
    assert.match(launcher, new RegExp(`\\$env:${name}\\s*=`, "u"));
  }
  for (const name of [
    "XW_M6_TARGET_ENVIRONMENT_ATTESTATION_PATH", "XW_M6_TARGET_ENVIRONMENT_ATTESTATION_HASH",
    "XW_M6_ENVIRONMENT_QUALIFICATION_PATH", "XW_M6_ENVIRONMENT_QUALIFICATION_SHA256",
  ]) {
    assert.match(launcher, new RegExp(`Clear-ProcessEnvironment[\\s\\S]+"${name}"`, "u"));
  }
  for (const secretName of [
    "DEEPSEEK_API_KEY", "XW_M6_GATE_F_OPERATIONS_TOKEN", "XW_M6_LIVE_ENTRY_TOKEN",
    "XW_M6_ACCOUNT_ISOLATION_BINDING_HASH",
  ]) {
    assert.doesNotMatch(launcher, new RegExp(`\\$env:${secretName}\\s*=`, "u"));
    assert.match(launcher, new RegExp(`Assert-RequiredEnvironment\\s+"${secretName}"`, "u"));
  }
  const checker = read("tools/check-xw-runtime.ps1");
  assert.match(checker, /Invoke-RestMethod[^\r\n]+\/control\/v1\/health|Invoke-RestMethod[^\r\n]+\$m6\.healthUrl/u);
  for (const signal of [
    "$health.releaseId", "$health.sourceCommit", "$health.runtimeProfile",
    "$health.m6RuntimeMode",
    "$health.m6LiveEntry.status", "$health.m6GateFOperations.status",
    "$health.m6LiveEntry.activeRuns", "$health.m6GateFOperations.actionCount",
  ]) {
    assert.ok(checker.includes(signal));
  }
});

test("M6-C1 launcher injects verified target evidence only in FINAL and clears it in QUALIFICATION_ONLY", {
  skip: process.platform !== "win32",
}, async (t) => {
  const names = [
    "XW_M6_TARGET_ENVIRONMENT_ATTESTATION_PATH", "XW_M6_TARGET_ENVIRONMENT_ATTESTATION_HASH",
    "XW_M6_ENVIRONMENT_QUALIFICATION_PATH", "XW_M6_ENVIRONMENT_QUALIFICATION_SHA256",
  ];
  await t.test("final-injects-exact-binding", (subtest) => {
    const fixture = m6RuntimeFixture(subtest);
    const capturePath = join(fixture.root, "state", "final-target-evidence-env.json");
    const result = runPowerShell("services/control-plane/scripts/xw-control-plane-runtime.ps1", [
      "-RuntimeRoot", fixture.root, "-ContractPath", fixture.contractPath,
    ], { ...fixture.secrets, XW_M6_TEST_CAPTURE_ENV_PATH: capturePath });
    assert.equal(result.status, 0, result.stderr);
    const captured = JSON.parse(readFileSync(capturePath, "utf8"));
    assert.equal(captured.XW_M6_TARGET_ENVIRONMENT_ATTESTATION_HASH, fixture.binding.targetEnvironmentAttestationHash);
    assert.equal(captured.XW_M6_ENVIRONMENT_QUALIFICATION_SHA256, fixture.binding.environmentQualificationSha256);
    for (const [actual, expected] of [
      [captured.XW_M6_TARGET_ENVIRONMENT_ATTESTATION_PATH, fixture.binding.targetEnvironmentAttestationPath],
      [captured.XW_M6_ENVIRONMENT_QUALIFICATION_PATH, fixture.binding.environmentQualificationPath],
    ]) {
      const actualStat = statSync(actual, { bigint: true });
      const expectedStat = statSync(expected, { bigint: true });
      assert.equal(actualStat.dev, expectedStat.dev);
      assert.equal(actualStat.ino, expectedStat.ino);
    }
  });
  await t.test("qualification-clears-inherited-final-evidence", (subtest) => {
    const fixture = m6RuntimeFixture(subtest);
    const capturePath = join(fixture.root, "state", "qualification-target-evidence-env.json");
    const inherited = Object.fromEntries(names.map((name, index) => [name, `${index + 1}`.repeat(64)]));
    const result = runPowerShell("services/control-plane/scripts/xw-control-plane-runtime.ps1", [
      "-RuntimeRoot", fixture.root, "-ContractPath", fixture.contractPath, "-Mode", "QUALIFICATION_ONLY",
    ], { ...fixture.secrets, ...inherited, XW_M6_TEST_CAPTURE_ENV_PATH: capturePath });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(capturePath, "utf8")), Object.fromEntries(names.map((name) => [name, null])));
  });
});

test("M6-C1 launcher owns the immutable verifier and runs it before release binding or server loading", () => {
  const launcher = read("services/control-plane/scripts/xw-control-plane-runtime.ps1");
  const verifierCall = launcher.indexOf("Assert-ImmutableSourceRelease $trustedNodeExecutable");
  assert.ok(verifierCall > 0);
  assert.ok(launcher.indexOf("$trustedNodeExecutable =") > 0);
  assert.ok(launcher.indexOf("$trustedNodeExecutable =") < verifierCall);
  assert.ok(verifierCall < launcher.indexOf("$contract ="));
  assert.ok(verifierCall < launcher.indexOf("$bindingRelative ="));
  assert.ok(verifierCall < launcher.indexOf("$serverPath ="));
  assert.match(launcher, /const \{ createHash \} = require\("node:crypto"\);/u);
  assert.match(launcher, /gitTreeOid\(declared\) !== manifest\.sourceTreeSha/u);
  assert.doesNotMatch(launcher, /Assert-ImmutableSourceRelease[\s\S]+(?:import\(|packages\/release|release-manifest\.mjs)/u);
  assert.equal([...Buffer.from(launcher, "utf8")].some((byte) => byte > 0x7f), false);
});

test("M6-C1 release verification cannot be delegated to a contract-selected executable", {
  skip: process.platform !== "win32",
}, (t) => {
  const fixture = m6RuntimeFixture(t);
  const markerPath = join(fixture.root, "state", "untrusted-node-executed.txt");
  const fakeNodePath = join(fixture.root, "state", "untrusted-node.cmd");
  writeFileSync(fakeNodePath, `@echo off\r\necho executed>"${markerPath}"\r\nexit /b 0\r\n`);
  const contract = JSON.parse(readFileSync(fixture.contractPath, "utf8"));
  contract.m6C1.nodeExecutable = fakeNodePath;
  contract.m6C1.nodeVersion = "forged";
  writeJson(fixture.contractPath, contract);
  const result = runPowerShell("services/control-plane/scripts/xw-control-plane-runtime.ps1", [
    "-RuntimeRoot", fixture.root, "-ContractPath", fixture.contractPath, "-VerifyReleaseOnly",
  ], fixture.secrets);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(markerPath), false);
});

test("M6-C1 external immutable verifier rejects release tree and manifest mutations", {
  skip: process.platform !== "win32",
}, async (t) => {
  const cases = [
    {
      name: "modified-javascript",
      mutate(fixture) {
        const path = join(fixture.releaseRoot, "services", "control-plane", "control-plane", "server.mjs");
        writeFileSync(path, "export const immutableFixture = false;\n");
      },
      checkWithRuntimeChecker: true,
    },
    {
      name: "extra-file",
      mutate(fixture) {
        writeFileSync(join(fixture.releaseRoot, "services", "control-plane", "unlisted.mjs"), "export {};\n");
      },
    },
    {
      name: "missing-file",
      mutate(fixture) {
        rmSync(join(fixture.releaseRoot, "services", "orchestrator", "campaign", "fixture.sh"));
      },
    },
    {
      name: "forged-manifest-schema",
      mutate(fixture) {
        resealReleaseManifestFixture(fixture, (manifest) => { manifest.forged = true; });
      },
    },
    {
      name: "forged-source-tree",
      mutate(fixture) {
        resealReleaseManifestFixture(fixture, (manifest) => { manifest.sourceTreeSha = "f".repeat(40); });
      },
    },
    {
      name: "forged-git-blob-oid",
      mutate(fixture) {
        resealReleaseManifestFixture(fixture, (manifest) => { manifest.files[0].gitBlobOid = "f".repeat(40); });
      },
    },
    {
      name: "forged-git-mode",
      mutate(fixture) {
        resealReleaseManifestFixture(fixture, (manifest) => {
          manifest.files[0].gitMode = manifest.files[0].gitMode === "100644" ? "100755" : "100644";
        });
      },
    },
    {
      name: "forged-git-path",
      mutate(fixture) {
        resealReleaseManifestFixture(fixture, (manifest) => { manifest.files[0].path += ".forged"; });
      },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, (subtest) => {
      const fixture = m6RuntimeFixture(subtest);
      item.mutate(fixture);
      const result = runPowerShell("services/control-plane/scripts/xw-control-plane-runtime.ps1", [
        "-RuntimeRoot", fixture.root, "-ContractPath", fixture.contractPath, "-ValidateOnly",
      ], fixture.secrets);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /M6_C1_IMMUTABLE_RELEASE_INVALID/u);
      if (item.checkWithRuntimeChecker) {
        const checked = runPowerShell("tools/check-xw-runtime.ps1", [
          "-ContractPath", fixture.contractPath, "-M6C1Only", "-SkipHealthCheck",
        ], fixture.secrets);
        assert.notEqual(checked.status, 0);
        const receipt = JSON.parse(checked.stdout);
        assert.equal(receipt.checks.find((entry) => entry.name === "m6-c1:external-immutable-release")?.ok, false);
      }
    });
  }

  await t.test("parent-junction", (subtest) => {
    const fixture = m6RuntimeFixture(subtest);
    const parent = join(fixture.releaseRoot, "services", "orchestrator");
    const target = join(fixture.root, "outside-release-orchestrator");
    renameSync(parent, target);
    try {
      symlinkSync(target, parent, "junction");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return subtest.skip(`junction unsupported: ${error.code}`);
      throw error;
    }
    const result = runPowerShell("services/control-plane/scripts/xw-control-plane-runtime.ps1", [
      "-RuntimeRoot", fixture.root, "-ContractPath", fixture.contractPath, "-ValidateOnly",
    ], fixture.secrets);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /M6_C1_IMMUTABLE_RELEASE_INVALID/u);
  });

  await t.test("leaf-symlink", (subtest) => {
    const fixture = m6RuntimeFixture(subtest);
    const leaf = join(fixture.releaseRoot, "services", "control-plane", "control-plane", "server.mjs");
    const target = join(fixture.root, "outside-release-server.mjs");
    writeFileSync(target, readFileSync(leaf));
    rmSync(leaf);
    try {
      symlinkSync(target, leaf, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return subtest.skip(`symlink unsupported: ${error.code}`);
      throw error;
    }
    const result = runPowerShell("services/control-plane/scripts/xw-control-plane-runtime.ps1", [
      "-RuntimeRoot", fixture.root, "-ContractPath", fixture.contractPath, "-ValidateOnly",
    ], fixture.secrets);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /M6_C1_IMMUTABLE_RELEASE_INVALID/u);
  });

  await t.test("external-hardlink-alias", (subtest) => {
    const fixture = m6RuntimeFixture(subtest);
    const victim = join(fixture.releaseRoot, "services", "control-plane", "control-plane", "server.mjs");
    linkSync(victim, join(fixture.root, "state", "external-hardlink-alias.mjs"));
    const result = runPowerShell("services/control-plane/scripts/xw-control-plane-runtime.ps1", [
      "-RuntimeRoot", fixture.root, "-ContractPath", fixture.contractPath, "-VerifyReleaseOnly",
    ], fixture.secrets);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /M6_C1_IMMUTABLE_RELEASE_INVALID/u);
  });
});

test("M6-C1 launcher and checker bind a secret-free runtime contract without launching", {
  skip: process.platform !== "win32",
}, (t) => {
  const fixture = m6RuntimeFixture(t);
  const launcher = runPowerShell("services/control-plane/scripts/xw-control-plane-runtime.ps1", [
    "-RuntimeRoot", fixture.root, "-ContractPath", fixture.contractPath, "-ValidateOnly",
  ], fixture.secrets);
  assert.equal(launcher.status, 0, launcher.stderr);
  const receipt = JSON.parse(launcher.stdout);
  assert.equal(receipt.schemaId, "xw.runtime.m6-c1-launch-validation.v1");
  assert.equal(receipt.ok, true);
  assert.equal(receipt.gateFArtifactCatalogHash, fixture.binding.gateFArtifactCatalogHash);
  assert.equal(receipt.productionDependencyBindingHash, fixture.binding.productionDependencyBindingHash);
  assert.deepEqual(new Set(Object.values(receipt.requiredEnvironment)), new Set(["present"]));

  const checker = runPowerShell("tools/check-xw-runtime.ps1", [
    "-ContractPath", fixture.contractPath, "-M6C1Only", "-SkipHealthCheck",
  ], fixture.secrets);
  assert.equal(checker.status, 0, checker.stderr);
  const checked = JSON.parse(checker.stdout);
  assert.equal(checked.ok, true);
  for (const secret of Object.values(fixture.secrets)) {
    assert.doesNotMatch(`${launcher.stdout}\n${launcher.stderr}\n${checker.stdout}\n${checker.stderr}`, new RegExp(secret, "u"));
  }
});

test("M6-C1 FINAL launcher rejects five-window catalog order, raw bytes, and cross-release drift", {
  skip: process.platform !== "win32",
}, async (t) => {
  const cases = [
    {
      name: "order-drift",
      mutate(fixture) {
        resealCatalogFixture(fixture, (catalog) => {
          [catalog.entries[0], catalog.entries[1]] = [catalog.entries[1], catalog.entries[0]];
        });
      },
    },
    {
      name: "inventory-raw-drift",
      mutate(fixture) {
        writeFileSync(fixture.catalogEntries[2].inventoryPath, Buffer.concat([
          readFileSync(fixture.catalogEntries[2].inventoryPath), Buffer.from("\n"),
        ]));
      },
    },
    {
      name: "cross-release",
      mutate(fixture) {
        resealCatalogFixture(fixture, (catalog) => { catalog.release.releaseId = "cross-release"; });
      },
    },
    {
      name: "self-consistent-physical-release-rebinding",
      mutate(fixture) {
        const reboundRoot = join(fixture.root, "rebound-release");
        const reboundManifestPath = join(reboundRoot, "release-manifest.v1.json");
        mkdirSync(reboundRoot, { recursive: true });
        writeFileSync(reboundManifestPath, readFileSync(fixture.manifestPath));

        const catalog = JSON.parse(readFileSync(fixture.gateFArtifactCatalogPath, "utf8"));
        for (const entry of catalog.entries) {
          const inventory = JSON.parse(readFileSync(entry.inventoryPath, "utf8"));
          inventory.release = { root: reboundRoot, manifestPath: reboundManifestPath };
          const { inventoryHash: discarded, ...inventoryBody } = inventory;
          inventory.inventoryHash = hashText(
            `xw.m6-gate-f-artifact-inventory.v1:${JSON.stringify(canonicalize(inventoryBody))}`,
          );
          writeJson(entry.inventoryPath, inventory);
          entry.inventoryHash = inventory.inventoryHash;
          entry.inventorySha256 = sha256(entry.inventoryPath);
        }
        const { catalogHash: discarded, ...catalogBody } = catalog;
        catalog.catalogHash = hashText(
          `xw.m6-gate-f-artifact-catalog.v1:${JSON.stringify(canonicalize(catalogBody))}`,
        );
        writeJson(fixture.gateFArtifactCatalogPath, catalog);
        fixture.binding.gateFArtifactCatalogHash = catalog.catalogHash;
        fixture.binding.gateFArtifactCatalogSha256 = sha256(fixture.gateFArtifactCatalogPath);
        writeJson(fixture.bindingPath, fixture.binding);
      },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, (subtest) => {
      const fixture = m6RuntimeFixture(subtest);
      item.mutate(fixture);
      const result = runPowerShell("services/control-plane/scripts/xw-control-plane-runtime.ps1", [
        "-RuntimeRoot", fixture.root, "-ContractPath", fixture.contractPath, "-ValidateOnly",
      ], fixture.secrets);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /M6_C1_GATE_F_CATALOG_INVALID/u);
    });
  }
});

test("M6-C1 launcher fails closed on absent inherited authority without disclosing credentials", {
  skip: process.platform !== "win32",
}, (t) => {
  const fixture = m6RuntimeFixture(t);
  const { XW_M6_GATE_F_OPERATIONS_TOKEN: omitted, ...environment } = fixture.secrets;
  const result = runPowerShell("services/control-plane/scripts/xw-control-plane-runtime.ps1", [
    "-RuntimeRoot", fixture.root, "-ContractPath", fixture.contractPath, "-ValidateOnly",
  ], { ...environment, XW_M6_GATE_F_OPERATIONS_TOKEN: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /M6_C1_REQUIRED_ENVIRONMENT_UNAVAILABLE:XW_M6_GATE_F_OPERATIONS_TOKEN/u);
  for (const secret of Object.values(fixture.secrets)) {
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret, "u"));
  }
});

test("M6-C1 launcher names each missing release, layer, model, environment and account boundary", {
  skip: process.platform !== "win32",
}, async (t) => {
  const cases = [
    {
      name: "release",
      expected: /M6_C1_RELEASE_BINDING_INVALID/u,
      mutate(fixture) { fixture.binding.sourceCommit = "f".repeat(40); },
    },
    {
      name: "dependency-layer",
      expected: /M6_C1_DEPENDENCY_ROOT_INVALID/u,
      mutate(fixture) { fixture.binding.dependencyRoot = join(fixture.root, "missing-layer"); },
    },
    {
      name: "model-profile",
      expected: /M6_C1_MODEL_PROFILE_INVALID/u,
      mutate(fixture) { fixture.binding.modelProfileHash = "f".repeat(64); },
    },
    {
      name: "environment-snapshot",
      expected: /M6_C1_RUNTIME_SNAPSHOT_INVALID/u,
      mutate(fixture) { fixture.binding.runtimeSnapshotPath = join(fixture.root, "missing-runtime-snapshot.json"); },
    },
    {
      name: "environment-qualification-rebinding",
      expected: /M6_C1_ENVIRONMENT_BINDING_INVALID/u,
      mutate(fixture) { fixture.binding.targetEnvironmentAttestationHash = "9".repeat(64); },
    },
    {
      name: "production-dependency-binding",
      expected: /M6_C1_PRODUCTION_DEPENDENCY_BINDING_INVALID/u,
      mutate(fixture) { fixture.binding.productionDependencyBindingPath = join(fixture.root, "missing-production-dependencies.json"); },
    },
    {
      name: "account-isolation",
      expected: /M6_C1_REQUIRED_ENVIRONMENT_UNAVAILABLE:XW_M6_ACCOUNT_ISOLATION_BINDING_HASH/u,
      mutate(fixture) { fixture.secrets.XW_M6_ACCOUNT_ISOLATION_BINDING_HASH = ""; },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, (subtest) => {
      const fixture = m6RuntimeFixture(subtest);
      item.mutate(fixture);
      writeJson(fixture.bindingPath, fixture.binding);
      const result = runPowerShell("services/control-plane/scripts/xw-control-plane-runtime.ps1", [
        "-RuntimeRoot", fixture.root, "-ContractPath", fixture.contractPath, "-ValidateOnly",
      ], fixture.secrets);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, item.expected);
      for (const secret of Object.values(fixture.secrets).filter(Boolean)) {
        assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret, "u"));
      }
    });
  }
});

test("M6-C1 runtime binding rejects secret-shaped extra fields before launch", {
  skip: process.platform !== "win32",
}, (t) => {
  const fixture = m6RuntimeFixture(t);
  writeJson(fixture.bindingPath, { ...fixture.binding, token: fixture.secrets.XW_M6_GATE_F_OPERATIONS_TOKEN });
  const result = runPowerShell("services/control-plane/scripts/xw-control-plane-runtime.ps1", [
    "-RuntimeRoot", fixture.root, "-ContractPath", fixture.contractPath, "-ValidateOnly",
  ], fixture.secrets);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /M6_C1_BINDING_SECRET_MATERIAL_FORBIDDEN/u);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(fixture.secrets.XW_M6_GATE_F_OPERATIONS_TOKEN, "u"));
});

test("skill install validates staging before swapping and preserves a rollback backup", () => {
  const source = read("tools/sync-xw-skill.ps1");
  assert.match(source, /Assert-SafeManagedTarget/);
  assert.match(source, /Assert-FileSet\s+\$source\s+\$staging/);
  assert.match(source, /Move-Item\s+-LiteralPath\s+\$target\s+-Destination\s+\$backup/);
  assert.match(source, /Move-Item\s+-LiteralPath\s+\$backup\s+-Destination\s+\$target/);
});
