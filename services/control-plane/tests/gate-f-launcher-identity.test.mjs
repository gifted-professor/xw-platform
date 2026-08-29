import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  FORMAL_CONTROL_PLANE_TASK_NAME,
  installGateFLauncherArtifacts,
  sha256File,
  verifyGateFLauncherIdentity,
} from "../ops/gate-f-launcher-identity.mjs";
import {
  buildPinnedVisionConfig,
  EXPLORATION_VISION_FIXED_PROVIDER_BUNDLE_DIGEST,
  resolveFixedReleaseProviderInputs,
} from "../../orchestrator/ops/xw-xhs-vision-pin.mjs";
import { stageExplorationVisionProviderBundle } from "../../orchestrator/scripts/lib/xhs-exploration-provider-bundle.mjs";
import {
  validateControlPlaneSecretEnvironmentBytes,
  validateDigestKeyringBytes,
} from "../ops/control-plane-private-material.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const SOURCE_COMMIT = "a".repeat(40);
const RELEASE_ID = "xw-xhs-v3-p5-a1b2c3d";
const SECRET_MARKERS = Object.freeze({
  provider: "fixture-provider-api-key-do-not-print",
  gate: "fixture-gate-token-1234567890-abcdefghij",
  live: "fixture-live-token-1234567890-abcdefghij",
  account: "8".repeat(64),
  key: Buffer.alloc(32, 17).toString("base64"),
});
const SOURCE_PATHS = Object.freeze([
  "services/control-plane/ops/launch-control-plane.ps1",
  "services/control-plane/scripts/xw-control-plane-runtime.ps1",
  "config/runtime/xw-runtime.v1.json",
]);
let fixedProviderCache = null;
let fixedProviderConfigCache = null;

function fixedProvider() {
  fixedProviderCache ??= resolveFixedReleaseProviderInputs();
  return fixedProviderCache;
}

function fixedProviderConfig() {
  if (!fixedProviderConfigCache) {
    const fixed = fixedProvider();
    fixedProviderConfigCache = buildPinnedVisionConfig({
      python: fixed.python,
      script: fixed.script,
      model: fixed.model,
      dataFiles: fixed.dataFiles,
      bundleManifest: fixed.manifestPath,
    });
  }
  return structuredClone(fixedProviderConfigCache);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function inspectFixtureProviderConfig(runtimeRoot) {
  const path = join(runtimeRoot, "state", "orchestrator", "xhs-exploration-vision-provider.v1.json");
  let config;
  try { config = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("GATE_F_PROVIDER_CONFIG_INVALID"); }
  const fixed = fixedProvider();
  const manifestFiles = fixed.closure.manifest.files;
  const descriptors = Object.fromEntries(manifestFiles.map((row) => [row.logicalPath, row]));
  const expectedData = fixed.dataFiles.map((row) => ({
    logicalPath: row.logicalPath,
    path: resolve(row.path),
    sha256: descriptors[row.logicalPath]?.sha256,
  }));
  const actualData = Array.isArray(config?.pin?.data) ? config.pin.data.map((row) => ({
    logicalPath: row.logicalPath,
    path: resolve(row.path),
    sha256: row.sha256,
  })) : [];
  if (config?.bundle?.providerBundleDigest !== EXPLORATION_VISION_FIXED_PROVIDER_BUNDLE_DIGEST
    || config?.bundle?.manifest?.sha256 !== EXPLORATION_VISION_FIXED_PROVIDER_BUNDLE_DIGEST
    || sha256File(config?.bundle?.manifest?.path) !== EXPLORATION_VISION_FIXED_PROVIDER_BUNDLE_DIGEST
    || resolve(config?.pin?.python?.path ?? "") !== resolve(fixed.python)
    || sha256File(config.pin.python.path) !== config.pin.python.sha256
    || sha256File(config?.pin?.script?.path) !== config.pin.script.sha256
    || sha256File(config?.pin?.model?.path) !== config.pin.model.sha256
    || JSON.stringify(actualData) !== JSON.stringify(expectedData)) {
    throw new Error("GATE_F_PROVIDER_BUNDLE_IDENTITY_MISMATCH");
  }
  return {
    path,
    sha256: sha256File(path),
    providerBundleDigest: config.bundle.providerBundleDigest,
  };
}

function inspectFixturePrivateMaterial({ runtimeRoot }) {
  try {
    const secretPath = join(runtimeRoot, "secrets", "control-plane-secret-environment.v1.json");
    const keyringPath = join(runtimeRoot, "secrets", "xhs-evidence-digest-keyring.v1.json");
    const secretBytes = readFileSync(secretPath);
    const keyringBytes = readFileSync(keyringPath);
    const secret = validateControlPlaneSecretEnvironmentBytes(secretBytes);
    const keyring = validateDigestKeyringBytes(keyringBytes);
    return {
      secretEnvironment: {
        path: secretPath,
        sha256: sha256(secretBytes),
        requiredEnvironment: secret.requiredEnvironment,
      },
      digestKeyring: {
        path: keyringPath,
        sha256: sha256(keyringBytes),
        activeKeyId: keyring.activeKeyId,
        keyMaterial: keyring.keyMaterial,
      },
    };
  } catch (error) {
    if (/^GATE_F_/u.test(error?.message || "")) throw error;
    throw new Error("GATE_F_PRIVATE_MATERIAL_UNAVAILABLE");
  }
}

function installFixtureArtifacts(options) {
  return installGateFLauncherArtifacts({
    ...options,
    providerConfigInspector: inspectFixtureProviderConfig,
    privateMaterialInspector: inspectFixturePrivateMaterial,
  });
}

function verifyFixtureArtifacts(options) {
  return verifyGateFLauncherIdentity({
    ...options,
    providerConfigInspector: inspectFixtureProviderConfig,
    privateMaterialInspector: inspectFixturePrivateMaterial,
  });
}

function materializeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "xw-gate-f-launcher-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, "runtime");
  const releaseRoot = join(runtimeRoot, "releases", RELEASE_ID);
  mkdirSync(releaseRoot, { recursive: true });
  const secretsRoot = join(runtimeRoot, "secrets");
  mkdirSync(secretsRoot, { recursive: true });
  const secretEnvironmentPath = join(secretsRoot, "control-plane-secret-environment.v1.json");
  const digestKeyringPath = join(secretsRoot, "xhs-evidence-digest-keyring.v1.json");
  writeFileSync(secretEnvironmentPath, canonicalJson({
    schemaId: "xw.runtime.control-plane-secret-environment.v1",
    variables: {
      DEEPSEEK_API_KEY: SECRET_MARKERS.provider,
      XW_M6_ACCOUNT_ISOLATION_BINDING_HASH: SECRET_MARKERS.account,
      XW_M6_GATE_F_OPERATIONS_TOKEN: SECRET_MARKERS.gate,
      XW_M6_LIVE_ENTRY_TOKEN: SECRET_MARKERS.live,
    },
  }));
  writeFileSync(digestKeyringPath, canonicalJson({
    schemaId: "xw.digest-keyring.v1",
    activeKeyId: "ka-fixture",
    createdAt: "2026-08-30T00:00:00.000Z",
    keys: [{
      keyId: "ka-fixture",
      keyBase64: SECRET_MARKERS.key,
      algorithm: "HMAC-SHA-256",
      status: "active",
      createdAt: "2026-08-30T00:00:00.000Z",
    }],
  }));
  const providerRoot = join(runtimeRoot, "provider-fixture");
  mkdirSync(providerRoot, { recursive: true });
  const fixed = fixedProvider();
  const pythonPath = fixed.python;
  const scriptPath = join(providerRoot, "analyze.py");
  const modelPath = join(providerRoot, "model.bin");
  copyFileSync(fixed.script, scriptPath);
  copyFileSync(fixed.model, modelPath);
  const providerManifestPath = join(providerRoot, "provider-bundle.v1.json");
  copyFileSync(fixed.manifestPath, providerManifestPath);
  const dataFiles = fixed.dataFiles.map((row) => ({ ...row }));
  const providerConfigPath = join(
    runtimeRoot,
    "state",
    "orchestrator",
    "xhs-exploration-vision-provider.v1.json",
  );
  mkdirSync(dirname(providerConfigPath), { recursive: true });
  const providerConfig = fixedProviderConfig();
  providerConfig.bundle.manifest.path = providerManifestPath;
  providerConfig.pin.python.path = pythonPath;
  providerConfig.pin.script.path = scriptPath;
  providerConfig.pin.model.path = modelPath;
  providerConfig.pin.data = dataFiles.map((row, index) => ({
    logicalPath: row.logicalPath,
    path: row.path,
    sha256: providerConfig.pin.data[index].sha256,
  }));
  writeFileSync(providerConfigPath, canonicalJson(providerConfig));
  for (const relativePath of SOURCE_PATHS) {
    const source = join(REPO_ROOT, ...relativePath.split("/"));
    const target = join(releaseRoot, ...relativePath.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  const files = SOURCE_PATHS.map((path) => ({
    path,
    gitMode: "100644",
    gitBlobOid: "b".repeat(40),
    sha256: sha256File(join(releaseRoot, ...path.split("/"))),
  }));
  const manifest = {
    schemaId: "xw.runtime.release-manifest.v1",
    releaseId: RELEASE_ID,
    sourceRepo: "gifted-professor/xw-platform",
    sourceCommit: SOURCE_COMMIT,
    sourceTreeSha: "c".repeat(40),
    runtimeProfile: "legacy_compat",
    nodeVersion: "24.11.1",
    npmVersion: "11.6.2",
    services: {
      orchestrator: { path: "services/orchestrator", treeSha256: "d".repeat(64) },
      controlPlane: { path: "services/control-plane", treeSha256: "e".repeat(64) },
    },
    files,
    runtimeCutoverAllowed: false,
  };
  const manifestPath = join(releaseRoot, "release-manifest.v1.json");
  writeFileSync(manifestPath, canonicalJson(manifest));
  const releaseManifestSha256 = sha256File(manifestPath);
  const fixtureHash = "1".repeat(64);
  const m6FinalBindingPath = writeFixtureFile(
    join(runtimeRoot, "config"),
    "m6-c1-runtime.v1.json",
    canonicalJson({
      schemaId: "xw.runtime.m6-c1-runtime.v1",
      releaseId: RELEASE_ID,
      sourceCommit: SOURCE_COMMIT,
      sourceReleaseRoot: releaseRoot,
      releaseManifestSha256,
      dependencyRoot: join(runtimeRoot, "dependencies"),
      dependencyLayerHash: fixtureHash,
      modelProfileRoot: join(runtimeRoot, "model-profile"),
      modelProfileHash: fixtureHash,
      providerBaseUrl: "https://api.deepseek.com",
      manifestRoot: join(runtimeRoot, "manifests"),
      runtimeSnapshotPath: join(runtimeRoot, "state", "runtime-snapshot.json"),
      dshPersistenceRoot: join(runtimeRoot, "state", "dsh"),
      gateId: "gate-f-fixture",
      gateIssuerAllowlistPath: join(runtimeRoot, "config", "gate-issuers.json"),
      liveAuthorizationIssuerAllowlistPath: join(runtimeRoot, "config", "live-issuers.json"),
      gateFArtifactCatalogPath: join(runtimeRoot, "state", "gate-f-catalog.json"),
      gateFArtifactCatalogHash: fixtureHash,
      gateFArtifactCatalogSha256: fixtureHash,
      targetEnvironmentAttestationPath: join(runtimeRoot, "state", "target-attestation.json"),
      targetEnvironmentAttestationHash: fixtureHash,
      environmentQualificationPath: join(runtimeRoot, "state", "environment-qualification.json"),
      environmentQualificationSha256: fixtureHash,
      productionDependencyBindingPath: join(runtimeRoot, "state", "production-dependencies.json"),
      productionDependencyBindingHash: fixtureHash,
    }),
  );
  const fastOperatorState = join(runtimeRoot, "state", "control-plane", "fast-operator");
  const serveLaunch = (alias) => canonicalJson({
    schemaVersion: 2,
    runtimeRoot,
    nodeExe: "D:\\Program Files\\Node\\node.exe",
    releaseId: RELEASE_ID,
    sourceCommit: SOURCE_COMMIT,
    deviceConfig: join(runtimeRoot, "secrets", "control-plane.devices.json"),
    alias,
  });
  const serveLaunch03Path = writeFixtureFile(fastOperatorState, "serve-launch-03.json", serveLaunch("03"));
  const serveLaunch04Path = writeFixtureFile(fastOperatorState, "serve-launch-04.json", serveLaunch("04"));
  const currentPath = join(runtimeRoot, "current");
  symlinkSync(releaseRoot, currentPath, "junction");
  return {
    root, runtimeRoot, releaseRoot, currentPath, manifestPath, manifest,
    secretEnvironmentPath, digestKeyringPath,
    providerConfigPath, providerManifestPath, providerScriptPath: scriptPath,
    providerBundleDigest: EXPLORATION_VISION_FIXED_PROVIDER_BUNDLE_DIGEST,
    m6FinalBindingPath, serveLaunch03Path, serveLaunch04Path,
  };
}

function writeFixtureFile(root, filename, bytes) {
  mkdirSync(root, { recursive: true });
  const path = join(root, filename);
  writeFileSync(path, bytes);
  return path;
}

function installFixture(t) {
  const fixture = materializeFixture(t);
  const receipt = installFixtureArtifacts({
    runtimeRoot: fixture.runtimeRoot,
    expectedReleaseId: RELEASE_ID,
    expectedSourceCommit: SOURCE_COMMIT,
  });
  return { ...fixture, receipt };
}

test("Gate F installs the tracked launcher body at its immutable SHA-256 address", (t) => {
  const { receipt } = installFixture(t);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.launcher.sourceSha256, receipt.launcher.bodySha256);
  assert.equal(sha256File(receipt.launcher.sourcePath), receipt.launcher.sourceSha256);
  assert.equal(sha256File(receipt.launcher.bodyPath), receipt.launcher.bodySha256);
  assert.match(
    receipt.launcher.bodyPath.replaceAll("\\", "/"),
    new RegExp(`/launchers/${receipt.launcher.bodySha256}/launch-control-plane\\.ps1$`, "u"),
  );
  assert.match(
    receipt.binding.path.replaceAll("\\", "/"),
    new RegExp(`/launcher-bindings/${receipt.binding.sha256}/control-plane-launcher-binding\\.v1\\.json$`, "u"),
  );
  assert.match(
    receipt.task.xmlPath.replaceAll("\\", "/"),
    new RegExp(`/task-bindings/${receipt.task.xmlSha256}/xw-platform-control-plane\\.xml$`, "u"),
  );
});

test("formal SYSTEM task action pins launcher, binding, release and 40-hex source without a legacy action", (t) => {
  const { receipt } = installFixture(t);
  const xml = readFileSync(receipt.task.xmlPath, "utf8");
  assert.match(xml, /<UserId>SYSTEM<\/UserId>/u);
  assert.match(xml, /<LogonType>ServiceAccount<\/LogonType>/u);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/u);
  assert.match(xml, /-Mode FINAL/u);
  assert.match(xml, new RegExp(`-ExpectedLauncherSha256 ${receipt.launcher.bodySha256}`, "u"));
  assert.match(xml, new RegExp(`-ExpectedBindingSha256 ${receipt.binding.sha256}`, "u"));
  assert.match(xml, new RegExp(`-ExpectedReleaseId ${RELEASE_ID}`, "u"));
  assert.match(xml, new RegExp(`-ExpectedSourceCommit ${SOURCE_COMMIT}`, "u"));
  assert.doesNotMatch(xml, /\.simple/iu);
  assert.doesNotMatch(
    xml,
    /DEEPSEEK_API_KEY|XW_M6_(?:GATE_F_OPERATIONS_TOKEN|LIVE_ENTRY_TOKEN|ACCOUNT_ISOLATION_BINDING_HASH)|providerBundleDigest/iu,
  );
  for (const marker of Object.values(SECRET_MARKERS)) assert.equal(xml.includes(marker), false);
  assert.deepEqual(receipt.task.registration, {
    executable: "schtasks.exe",
    arguments: ["/Create", "/TN", FORMAL_CONTROL_PLANE_TASK_NAME, "/XML", receipt.task.xmlPath],
    overwrite: false,
  });
  assert.equal(receipt.task.registration.arguments.includes("/F"), false);
});

test("manifest, current, binding and explicit source identities are the same non-zero 40-hex commit", (t) => {
  const { receipt } = installFixture(t);
  assert.deepEqual(receipt.identity, {
    source: SOURCE_COMMIT,
    binding: SOURCE_COMMIT,
    current: SOURCE_COMMIT,
    manifest: SOURCE_COMMIT,
  });
  assert.deepEqual(new Set(Object.values(receipt.identity)), new Set([SOURCE_COMMIT]));
  for (const commit of Object.values(receipt.identity)) assert.match(commit, /^(?!0{40}$)[0-9a-f]{40}$/u);
});

test("formal launcher preserves FINAL and adds only the identity-sealed qualification mode", () => {
  const source = readFileSync(
    join(REPO_ROOT, "services", "control-plane", "ops", "launch-control-plane.ps1"),
    "utf8",
  );
  for (const token of [
    "ExpectedLauncherSha256", "ExpectedBindingSha256", "ExpectedReleaseId",
    "ExpectedSourceCommit", "IdentityBindingPath", "ValidateOnly",
    "Assert-SystemAdministratorsPrivateAcl", "Invoke-ProviderClosureVerifier",
    "Assert-FixedRuntimeSemanticBindings", "xw-xhs-vision-pin.mjs", "VerifyReleaseOnly",
    "Import-ControlPlanePrivateMaterial", "xw.runtime.control-plane-launcher-validation.v1",
    "GATE_F_DELEGATE_SECRET_OUTPUT_FORBIDDEN", "XW_XHS_V3_TASK_BOOTSTRAP_ENABLED",
    "XW_XHS_RPA_TASK_BOOTSTRAP_ENABLED",
  ]) assert.match(source, new RegExp(`\\$?${token}`, "u"));
  assert.match(source, /\[ValidateSet\("FINAL", "QUALIFICATION_ONLY"\)\]/u);
  assert.match(source, /M6_QUALIFICATION_SYSTEM_IDENTITY_REQUIRED/u);
  assert.match(source, /Import-QualificationPrivateMaterial/u);
  assert.match(source, /& \$runtimeEntryPath @delegateArguments/u);
  assert.doesNotMatch(source, /Register-ScheduledTask|Start-ScheduledTask|Stop-ScheduledTask|schtasks(?:\.exe)?/iu);
});

test("M6 FINAL and serve 03/04 semantic rebinding is rejected before artifact creation", async (t) => {
  const mutations = [
    ["M6 source release", ({ m6FinalBindingPath }) => {
      const value = JSON.parse(readFileSync(m6FinalBindingPath, "utf8"));
      value.sourceReleaseRoot = dirname(value.sourceReleaseRoot);
      writeFileSync(m6FinalBindingPath, canonicalJson(value));
    }],
    ["serve 03 alias", ({ serveLaunch03Path }) => {
      const value = JSON.parse(readFileSync(serveLaunch03Path, "utf8"));
      value.alias = "04";
      writeFileSync(serveLaunch03Path, canonicalJson(value));
    }],
    ["serve 04 source", ({ serveLaunch04Path }) => {
      const value = JSON.parse(readFileSync(serveLaunch04Path, "utf8"));
      value.sourceCommit = "f".repeat(40);
      writeFileSync(serveLaunch04Path, canonicalJson(value));
    }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, (st) => {
      const fixture = materializeFixture(st);
      mutate(fixture);
      assert.throws(() => installFixtureArtifacts({
        runtimeRoot: fixture.runtimeRoot,
        expectedReleaseId: RELEASE_ID,
        expectedSourceCommit: SOURCE_COMMIT,
      }), /GATE_F_/u);
    });
  }
});

test("Gate F installer rejects structurally valid private files with loose Windows ACLs", {
  skip: process.platform !== "win32",
}, (t) => {
  const fixture = materializeFixture(t);
  assert.throws(() => installGateFLauncherArtifacts({
    runtimeRoot: fixture.runtimeRoot,
    expectedReleaseId: RELEASE_ID,
    expectedSourceCommit: SOURCE_COMMIT,
    providerConfigInspector: inspectFixtureProviderConfig,
  }), /GATE_F_|KEYRING_ACL_INVALID/u);
});

test("installer is create-only and never overwrites an addressed artifact", (t) => {
  const fixture = installFixture(t);
  assert.throws(
    () => installFixtureArtifacts({
      runtimeRoot: fixture.runtimeRoot,
      expectedReleaseId: RELEASE_ID,
      expectedSourceCommit: SOURCE_COMMIT,
    }),
    /GATE_F_CREATE_ONLY_CONFLICT/u,
  );
  assert.equal(sha256File(fixture.receipt.launcher.bodyPath), fixture.receipt.launcher.bodySha256);
});

test("launcher body, binding, task XML, tracked source and manifest drift all fail closed", async (t) => {
  const mutations = [
    ["launcher body", ({ receipt }) => writeFileSync(receipt.launcher.bodyPath, "drift")],
    ["binding", ({ receipt }) => writeFileSync(receipt.binding.path, "{}\n")],
    ["task XML", ({ receipt }) => writeFileSync(receipt.task.xmlPath, "<Task />\n")],
    ["tracked launcher source", ({ releaseRoot }) => writeFileSync(
      join(releaseRoot, "services", "control-plane", "ops", "launch-control-plane.ps1"),
      "drift",
    )],
    ["release manifest", ({ manifestPath, manifest }) => writeFileSync(
      manifestPath,
      canonicalJson({ ...manifest, sourceCommit: "f".repeat(40) }),
    )],
    ["secret environment", ({ secretEnvironmentPath }) => writeFileSync(secretEnvironmentPath, "{}\n")],
    ["digest keyring", ({ digestKeyringPath }) => writeFileSync(digestKeyringPath, "{}\n")],
    ["provider config", ({ providerConfigPath }) => writeFileSync(providerConfigPath, "{}\n")],
    ["provider config raw bytes", ({ providerConfigPath }) => writeFileSync(
      providerConfigPath,
      `${readFileSync(providerConfigPath, "utf8")} `,
    )],
    ["provider manifest", ({ providerManifestPath }) => writeFileSync(providerManifestPath, "{}\n")],
    ["provider transitive script", ({ providerScriptPath }) => writeFileSync(providerScriptPath, "drift\n")],
    ["M6 FINAL binding", ({ m6FinalBindingPath }) => writeFileSync(m6FinalBindingPath, "{}\n")],
    ["serve 03 launch binding", ({ serveLaunch03Path }) => writeFileSync(serveLaunch03Path, "{}\n")],
    ["serve 04 launch binding", ({ serveLaunch04Path }) => writeFileSync(serveLaunch04Path, "{}\n")],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, (st) => {
      const fixture = installFixture(st);
      mutate(fixture);
      assert.throws(
        () => verifyFixtureArtifacts({
          bindingPath: fixture.receipt.binding.path,
          taskXmlPath: fixture.receipt.task.xmlPath,
          expectedReleaseId: RELEASE_ID,
          expectedSourceCommit: SOURCE_COMMIT,
        }),
        /GATE_F_/u,
      );
    });
  }
});

test("source or release rebinding is rejected before artifact creation", (t) => {
  const fixture = materializeFixture(t);
  assert.throws(
    () => installFixtureArtifacts({
      runtimeRoot: fixture.runtimeRoot,
      expectedReleaseId: RELEASE_ID,
      expectedSourceCommit: "1".repeat(40),
    }),
    /GATE_F_SOURCE_IDENTITY_MISMATCH/u,
  );
  assert.throws(
    () => installFixtureArtifacts({
      runtimeRoot: fixture.runtimeRoot,
      expectedReleaseId: "different-release",
      expectedSourceCommit: SOURCE_COMMIT,
    }),
    /GATE_F_CURRENT_RELEASE_INVALID/u,
  );
});

test("secret absence and provider closure drift reject before launcher artifacts are created", async (t) => {
  const mutations = [
    ["missing secret environment", ({ secretEnvironmentPath }) => unlinkSync(secretEnvironmentPath)],
    ["provider bundle bytes", ({ providerScriptPath }) => writeFileSync(providerScriptPath, "changed-provider\n")],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, (st) => {
      const fixture = materializeFixture(st);
      mutate(fixture);
      assert.throws(() => installFixtureArtifacts({
        runtimeRoot: fixture.runtimeRoot,
        expectedReleaseId: RELEASE_ID,
        expectedSourceCommit: SOURCE_COMMIT,
      }), /GATE_F_/u);
    });
  }
});

test("a valid caller-retuned provider bundle cannot replace the fixed P4A digest", (t) => {
  const fixture = materializeFixture(t);
  const config = JSON.parse(readFileSync(fixture.providerConfigPath, "utf8"));
  writeFileSync(fixture.providerScriptPath, "print('retuned but structurally valid')\n");
  const alternateManifest = join(dirname(fixture.providerManifestPath), "alternate-provider-bundle.v1.json");
  const staged = stageExplorationVisionProviderBundle({
    manifestPath: alternateManifest,
    python: config.pin.python.path,
    script: fixture.providerScriptPath,
    model: config.pin.model.path,
    dataFiles: config.pin.data.map((row) => ({ logicalPath: row.logicalPath, path: row.path })),
  });
  assert.notEqual(staged.providerBundleDigest, EXPLORATION_VISION_FIXED_PROVIDER_BUNDLE_DIGEST);
  writeFileSync(fixture.providerConfigPath, canonicalJson(buildPinnedVisionConfig({
    python: config.pin.python.path,
    script: fixture.providerScriptPath,
    model: config.pin.model.path,
    dataFiles: config.pin.data.map((row) => ({ logicalPath: row.logicalPath, path: row.path })),
    bundleManifest: alternateManifest,
  })));
  assert.throws(() => installFixtureArtifacts({
    runtimeRoot: fixture.runtimeRoot,
    expectedReleaseId: RELEASE_ID,
    expectedSourceCommit: SOURCE_COMMIT,
  }), /GATE_F_PROVIDER_BUNDLE_IDENTITY_MISMATCH/u);
});

test("launcher receipt and binding expose only hashes/presence, never private values", (t) => {
  const { receipt } = installFixture(t);
  const binding = readFileSync(receipt.binding.path, "utf8");
  const output = JSON.stringify(receipt);
  assert.equal(receipt.provider.closure, "verified");
  assert.equal(receipt.provider.providerBundleDigest.length, 64);
  for (const marker of Object.values(SECRET_MARKERS)) {
    assert.equal(binding.includes(marker), false);
    assert.equal(output.includes(marker), false);
  }
  assert.deepEqual(new Set(Object.values(receipt.privateMaterial.secretEnvironment.requiredEnvironment)), new Set(["present"]));
  assert.equal(receipt.privateMaterial.digestKeyring.keyMaterial, "present");
});

test("launcher CLI has no task mutation surface", () => {
  const cli = readFileSync(
    join(REPO_ROOT, "services", "control-plane", "ops", "install-control-plane-launcher.mjs"),
    "utf8",
  );
  assert.match(cli, /Creates immutable launcher\/binding\/task-XML artifacts only\./u);
  assert.doesNotMatch(cli, /execFile|spawn|Register-ScheduledTask|Start-ScheduledTask|schtasks/iu);
  assert.doesNotMatch(cli, /--provider|--config|--bundle|--secret|--keyring|--mode/iu);
  assert.equal(sha256(Buffer.from(cli, "utf8")).length, 64);
});

test("formal launcher and secret bootstrap parse under Windows PowerShell 5.1 grammar", { skip: process.platform !== "win32" }, () => {
  const files = [
    join(REPO_ROOT, "services", "control-plane", "ops", "launch-control-plane.ps1"),
    join(REPO_ROOT, "services", "control-plane", "ops", "provision-control-plane-secrets.ps1"),
  ];
  const command = [
    "$ErrorActionPreference='Stop'",
    "$files=$env:XW_PARSE_FILES | ConvertFrom-Json",
    "foreach($file in $files){$tokens=$null;$errors=$null;[Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count-ne 0){exit 23}}",
  ].join(";");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    env: { ...process.env, XW_PARSE_FILES: JSON.stringify(files) },
    stdio: "pipe",
    windowsHide: true,
  });
});
