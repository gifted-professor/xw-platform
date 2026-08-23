import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { writeRelease } from "../../../packages/release/lib/release-manifest.mjs";

import {
  M6_LIVE_RUNTIME_SOURCE_PATHS,
  inspectM6LiveRuntimeDependencyLocks,
  materializeM6LiveRuntimeDependencyLayer,
  verifyM6LiveRuntimeDependencyLayer,
} from "../src/live-runtime-dependency-layer.mjs";
import {
  deriveLiveModelProfileHash,
  loadContentAddressedLiveModelProfile,
  validateQualifiedLiveModelProfile,
} from "../src/live-model-profile.mjs";
import {
  sealedM6LiveChildSpec,
  validateM6LiveDependencyEnvironment,
} from "../src/live-process-adapter.mjs";

const repositoryRoot = resolve(new URL("../../../", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/u, ""));
const ROOT_DEPENDENCIES = Object.freeze({
  "@deepseek-ai/dsh": "0.1.0-rc.7",
  "@deepseek-ai/dsh-llm-deepseek": "0.1.0-rc.8",
  "@deepseek-ai/dsh-sdk-client": "0.1.0-rc.7",
  "@deepseek-ai/dsh-sdk-jsonrpc-server": "0.1.0-rc.7",
});

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function makeRelease() {
  const workspace = mkdtempSync(join(tmpdir(), "xw-m6-live-release-"));
  const sourceRoot = join(workspace, "source");
  mkdirSync(sourceRoot, { recursive: true });
  for (const path of M6_LIVE_RUNTIME_SOURCE_PATHS) {
    const target = join(sourceRoot, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(repositoryRoot, ...path.split("/")), target);
  }
  const packagePath = join(sourceRoot, "integrations/dsh-xw/package.json");
  writeFileSync(packagePath, `${JSON.stringify({
    name: "@xw/dsh-replay-adapter",
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: ROOT_DEPENDENCIES,
  }, null, 2)}\n`);
  const packages = { "": { name: "@xw/dsh-replay-adapter", version: "0.0.0", dependencies: ROOT_DEPENDENCIES } };
  for (const [name, version] of Object.entries(ROOT_DEPENDENCIES)) {
    packages[`node_modules/${name}`] = {
      version,
      resolved: `https://registry.npmjs.org/${name.replace("/", "%2f")}/-/${name.split("/").at(-1)}-${version}.tgz`,
      integrity: "sha512-Zml4dHVyZS1pbnRlZ3JpdHk=",
      license: "MIT",
    };
  }
  writeFileSync(join(sourceRoot, "integrations/dsh-xw/package-lock.json"), `${JSON.stringify({
    name: "@xw/dsh-replay-adapter",
    version: "0.0.0",
    lockfileVersion: 3,
    requires: true,
    packages,
  }, null, 2)}\n`);
  write(join(sourceRoot, "docs/release-closure-sentinel.txt"), "tracked but outside the runtime-source copy allowlist\n");
  const git = (...args) => execFileSync("git", args, { cwd: sourceRoot, stdio: "pipe", windowsHide: true });
  git("init", "--quiet");
  git("config", "core.autocrlf", "false");
  git("config", "user.name", "M6 Dependency Fixture");
  git("config", "user.email", "m6-dependency-fixture@example.invalid");
  git("add", "--all");
  git("commit", "--quiet", "-m", "sealed dependency fixture");
  const releaseId = "xw-m6-c1-dependency-test";
  writeRelease({ root: sourceRoot, outDir: join(workspace, "materialized"), releaseId });
  return Object.freeze({
    releaseRoot: join(workspace, "materialized", "releases", releaseId),
    workspace,
  });
}

function fakeInstall({ integrationRoot }) {
  for (const [name, version] of Object.entries(ROOT_DEPENDENCIES)) {
    const packageRoot = join(integrationRoot, "node_modules", ...name.split("/"));
    write(join(packageRoot, "package.json"), `${JSON.stringify({ name, version, license: "MIT", type: "module" })}\n`);
  }
  write(join(integrationRoot, "node_modules/@deepseek-ai/dsh/lib/bin.js"), "// sealed test DSH CLI\n");
  write(join(integrationRoot, "node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js"), "export default {};\n");
  write(join(integrationRoot, "node_modules/@deepseek-ai/dsh-llm-deepseek/LICENSE"), "MIT fixture license\n");
}

function materializeFixture(t) {
  const release = makeRelease();
  const releaseRoot = release.releaseRoot;
  const layersRoot = mkdtempSync(join(tmpdir(), "xw-m6-live-layers-"));
  t.after(() => rmSync(release.workspace, { recursive: true, force: true }));
  t.after(() => rmSync(layersRoot, { recursive: true, force: true }));
  const result = materializeM6LiveRuntimeDependencyLayer({ releaseRoot, layersRoot, install: fakeInstall });
  return { releaseRoot, layersRoot, result };
}

test("checked-in production DSH dependencies are exact registry-integrity pins", () => {
  const lock = inspectM6LiveRuntimeDependencyLocks({ integrationRoot: join(repositoryRoot, "integrations/dsh-xw") });
  assert.equal(lock.ok, true);
  assert.equal(lock.dshVersion, "0.1.0-rc.7");
  assert.equal(lock.rootDependencies["@deepseek-ai/dsh-llm-deepseek"], "0.1.0-rc.8");
  assert.match(lock.dshCommit, /^[0-9a-f]{40}$/u);
});

test("materializer delegates exact Git-tree identity and full release closure to the hardened verifier", (t) => {
  const extraRelease = makeRelease();
  const oidRelease = makeRelease();
  const layersRoot = mkdtempSync(join(tmpdir(), "xw-m6-live-hardened-release-"));
  t.after(() => rmSync(extraRelease.workspace, { recursive: true, force: true }));
  t.after(() => rmSync(oidRelease.workspace, { recursive: true, force: true }));
  t.after(() => rmSync(layersRoot, { recursive: true, force: true }));

  const manifestPath = join(extraRelease.releaseRoot, "release-manifest.v1.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.ok(manifest.files.length > M6_LIVE_RUNTIME_SOURCE_PATHS.length);
  assert.deepEqual(Object.keys(manifest.files[0]).sort(), ["gitBlobOid", "gitMode", "path", "sha256"]);
  write(join(extraRelease.releaseRoot, "unmanifested-extra.txt"), "must invalidate the full directory closure\n");
  assert.throws(() => materializeM6LiveRuntimeDependencyLayer({
    releaseRoot: extraRelease.releaseRoot,
    layersRoot,
    install: fakeInstall,
  }), { code: "M6_LIVE_SOURCE_RELEASE_DRIFT" });

  const oidManifestPath = join(oidRelease.releaseRoot, "release-manifest.v1.json");
  const oidManifest = JSON.parse(readFileSync(oidManifestPath, "utf8"));
  oidManifest.files[0].gitBlobOid = "0".repeat(40);
  writeFileSync(oidManifestPath, `${JSON.stringify(oidManifest, null, 2)}\n`);
  assert.throws(() => materializeM6LiveRuntimeDependencyLayer({
    releaseRoot: oidRelease.releaseRoot,
    layersRoot,
    install: fakeInstall,
  }), { code: "M6_LIVE_SOURCE_RELEASE_DRIFT" });
});

test("runtime dependencies materialize outside the immutable release and reproduce from exact locks", (t) => {
  const { releaseRoot, result } = materializeFixture(t);
  assert.equal(existsSync(join(releaseRoot, "integrations/dsh-xw/node_modules")), false);
  assert.equal(result.ok, true);
  assert.equal(result.layerRoot.endsWith(result.layerHash), true);
  assert.equal(result.manifest.lock.packageLockSha256, hash(readFileSync(join(releaseRoot, "integrations/dsh-xw/package-lock.json"))));
  assert.equal(result.manifest.sourceBindings.length, M6_LIVE_RUNTIME_SOURCE_PATHS.length);
  assert.deepEqual(Object.keys(result.manifest.sourceBindings[0]).sort(), ["gitBlobOid", "gitMode", "path", "sha256", "size"]);
  assert.ok(result.manifest.sourceBindings.every((entry) => /^[0-9a-f]{40}$/u.test(entry.gitBlobOid)
    && ["100644", "100755"].includes(entry.gitMode)));
  assert.equal(result.manifest.installScriptsExecuted, false);
  assert.equal(result.manifest.providerHealthEvaluated, false);
  assert.equal(result.qualification.status, "DEPENDENCY_LAYER_QUALIFIED");
  assert.equal(result.qualification.secretMaterialPresent, false);
  assert.equal(result.qualification.gateFEligible, false);
  assert.match(result.qualification.qualificationHash, /^[0-9a-f]{64}$/u);

  const reproduced = verifyM6LiveRuntimeDependencyLayer({
    layerRoot: result.layerRoot,
    expectedLayerHash: result.layerHash,
    sourceRoot: releaseRoot,
  });
  assert.equal(reproduced.qualification.qualificationHash, result.qualification.qualificationHash);
  const runtimeEnv = {
    XW_M6_LIVE_PROVIDER_BASE_URL: "https://provider.example.invalid",
    XW_M6_LIVE_MODEL_PROFILE_HASH: "a".repeat(64),
    XW_M6_LIVE_MODEL_PROFILE_ROOT: join(result.layersRoot ?? dirname(result.layerRoot), "model-profile"),
    XW_DSH_PERSISTENCE_ROOT: join(result.layersRoot ?? dirname(result.layerRoot), "persistence"),
  };
  assert.deepEqual(sealedM6LiveChildSpec(reproduced, runtimeEnv), {
    command: process.execPath,
    args: [
      "--permission",
      `--allow-fs-read=${reproduced.layerRoot}`,
      `--allow-fs-read=${runtimeEnv.XW_M6_LIVE_MODEL_PROFILE_ROOT}`,
      `--allow-fs-read=${runtimeEnv.XW_DSH_PERSISTENCE_ROOT}`,
      `--allow-fs-write=${runtimeEnv.XW_DSH_PERSISTENCE_ROOT}`,
      "--import",
      pathToFileURL(reproduced.liveNetworkGuard).href,
      reproduced.dshCli,
      "--profile",
      "live",
    ],
    cwd: reproduced.integrationRoot,
  });
  assert.deepEqual(validateM6LiveDependencyEnvironment({
    XW_M6_LIVE_DEPENDENCY_ROOT: result.layerRoot,
    XW_M6_LIVE_DEPENDENCY_LAYER_HASH: result.layerHash,
  }), {
    XW_M6_LIVE_DEPENDENCY_ROOT: result.layerRoot,
    XW_M6_LIVE_DEPENDENCY_LAYER_HASH: result.layerHash,
  });
});

test("runtime dependency verification rejects tamper, extra content and release rebinding", (t) => {
  const { releaseRoot, result } = materializeFixture(t);
  write(join(result.layerRoot, "integrations/dsh-xw/node_modules/extra.js"), "unsealed\n");
  assert.throws(() => verifyM6LiveRuntimeDependencyLayer({
    layerRoot: result.layerRoot,
    expectedLayerHash: result.layerHash,
    sourceRoot: releaseRoot,
  }), { code: "M6_LIVE_DEPENDENCY_INVENTORY_DRIFT" });
  assert.throws(() => validateM6LiveDependencyEnvironment({
    XW_M6_LIVE_DEPENDENCY_ROOT: result.layerRoot,
    XW_M6_LIVE_DEPENDENCY_LAYER_HASH: "not-a-hash",
  }), { code: "M6_LIVE_DEPENDENCY_ENV_INVALID" });
  assert.throws(() => sealedM6LiveChildSpec({ ok: true, dshCli: "relative", integrationRoot: result.integrationRoot }), {
    code: "M6_LIVE_DEPENDENCY_LAYER_UNVERIFIED",
  });
});

test("external model qualification is canonical, layer-attested and remains outside immutable roots", (t) => {
  const { result } = materializeFixture(t);
  const qualificationRoot = mkdtempSync(join(tmpdir(), "xw-m6-live-model-qualification-"));
  t.after(() => rmSync(qualificationRoot, { recursive: true, force: true }));
  const H = "a".repeat(64);
  const raw = {
    schemaId: "xw.m6-live-model-profile.v1",
    status: "QUALIFIED",
    provider: "deepseek-official",
    model: "deepseek-model-qualified",
    exactVersion: "owner-qualified-version",
    adapterPackage: result.installedAdapter.packageName,
    adapterVersion: result.installedAdapter.packageVersion,
    contextWindow: 64_000,
    maxTokens: 4_096,
    streamIdleTimeoutMs: 30_000,
    thinking: "disabled",
    reasoningEffort: "off",
    credentialRef: "DEEPSEEK_API_KEY",
    license: result.installedAdapter.license,
    secretMaterialPresent: false,
    deploymentSecretInjectionRequired: true,
    adapterIntegrityHash: result.installedAdapter.integrityHash,
    adapterSourceHash: result.installedAdapter.sourceHash,
    licenseHash: result.installedAdapter.licenseHash,
    endpointHash: H,
    provenanceHash: H,
    qualificationHash: H,
    toolCallHealthHash: H,
    warmHealthHash: H,
    coldHealthHash: H,
    ttlHealthHash: H,
    secretInjectionAttestationHash: H,
    runtimeAttestationHashes: [H, result.qualification.qualificationHash],
    gateFEligible: true,
  };
  const profile = { ...raw, contentHash: deriveLiveModelProfileHash(raw) };
  write(join(qualificationRoot, `${profile.contentHash}.json`), `${JSON.stringify(profile, null, 2)}\n`);
  const loaded = loadContentAddressedLiveModelProfile({ qualificationRoot, expectedContentHash: profile.contentHash });
  assert.deepEqual(loaded, profile);
  assert.equal(validateQualifiedLiveModelProfile(loaded, {
    installed: result.installedAdapter,
    requiredRuntimeAttestationHash: result.qualification.qualificationHash,
  }).ok, true);
  assert.ok(validateQualifiedLiveModelProfile({ ...loaded, runtimeAttestationHashes: [H] }, {
    installed: result.installedAdapter,
    requiredRuntimeAttestationHash: result.qualification.qualificationHash,
  }).errors.includes("M6_LIVE_DEPENDENCY_ATTESTATION_MISMATCH"));
  assert.throws(() => loadContentAddressedLiveModelProfile({ qualificationRoot, expectedContentHash: "b".repeat(64) }), {
    code: "M6_LIVE_PROFILE_ARTIFACT_UNAVAILABLE",
  });
});
