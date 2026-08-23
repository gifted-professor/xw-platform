import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  RELEASE_MANIFEST_FILENAME,
  RELEASE_MANIFEST_SCHEMA_ID,
  verifyReleaseManifest,
} from "../../../packages/release/lib/release-manifest.mjs";
import { canonicalJson } from "./canonical-json.mjs";
import {
  SEALED_ADAPTER_PACKAGE,
  SEALED_ADAPTER_VERSION,
  computeInstalledLiveAdapterIntegrity,
} from "./live-model-profile.mjs";

export const M6_LIVE_DEPENDENCY_LAYER_SCHEMA_ID = "xw.m6-live-runtime-dependency-layer.v1";
export const M6_LIVE_DEPENDENCY_LAYER_MANIFEST_FILENAME = "m6-live-runtime-dependency-layer.v1.json";
export const M6_LIVE_DEPENDENCY_QUALIFICATION_SCHEMA_ID = "xw.m6-live-runtime-dependency-qualification.v1";

export const M6_LIVE_RUNTIME_SOURCE_PATHS = Object.freeze([
  "integrations/dsh-xw/package.json",
  "integrations/dsh-xw/package-lock.json",
  "integrations/dsh-xw/lock.json",
  "integrations/dsh-xw/profiles/live/package.json",
  "integrations/dsh-xw/profiles/live/cordis.yml",
  "integrations/dsh-xw/profiles/live/cordis.patch.yml",
  "integrations/dsh-xw/profiles/live/model-manifest.json",
  "integrations/dsh-xw/src/canonical-json.mjs",
  "integrations/dsh-xw/src/live-model-profile.mjs",
  "integrations/dsh-xw/src/live-network-guard.mjs",
  "integrations/dsh-xw/src/live-pipe-client.mjs",
  "integrations/dsh-xw/src/live-runtime-dependency-layer.mjs",
  "integrations/dsh-xw/src/live-runtime-plugin.mjs",
  "integrations/dsh-xw/src/live-tools.mjs",
  "integrations/dsh-xw/src/xw-protocol-server.mjs",
  "packages/harness-protocol/locks/dsh.lock.v1.json",
  "packages/release/lib/release-manifest.mjs",
  "services/orchestrator/scripts/lib/m6/m6-live-tool-surface.mjs",
]);

const H40 = /^[0-9a-f]{40}$/u;
const H64 = /^[0-9a-f]{64}$/u;
const GIT_MODE = new Set(["100644", "100755"]);
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const REQUIRED_ROOT_DEPENDENCIES = Object.freeze({
  "@deepseek-ai/dsh": "0.1.0-rc.7",
  [SEALED_ADAPTER_PACKAGE]: SEALED_ADAPTER_VERSION,
  "@deepseek-ai/dsh-sdk-client": "0.1.0-rc.7",
  "@deepseek-ai/dsh-sdk-jsonrpc-server": "0.1.0-rc.7",
});
const DSH_CLI_PATH = "integrations/dsh-xw/node_modules/@deepseek-ai/dsh/lib/bin.js";
const LIVE_RUNTIME_ENTRY_PATH = "integrations/dsh-xw/src/live-runtime-plugin.mjs";
const LIVE_NETWORK_GUARD_PATH = "integrations/dsh-xw/src/live-network-guard.mjs";
const MODEL_MANIFEST_PATH = "integrations/dsh-xw/profiles/live/model-manifest.json";

function layerError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function gitBlobOid(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return createHash("sha1").update(Buffer.concat([
    Buffer.from(`blob ${bytes.length}\0`, "utf8"),
    bytes,
  ])).digest("hex");
}

function safeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\\")) return false;
  if (isAbsolute(value) || value.startsWith("/") || value.split("/").some((part) => part === "" || part === "." || part === "..")) return false;
  return true;
}

function inside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertPlainRoot(root, code) {
  const absolute = resolve(root);
  if (!existsSync(absolute) || !lstatSync(absolute).isDirectory() || lstatSync(absolute).isSymbolicLink()) {
    throw layerError(code, `${absolute} must be an existing non-symlink directory`);
  }
  return absolute;
}

function readJson(path, code) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw layerError(code, `${path} is missing or malformed`, cause);
  }
}

function validateLockfiles(integrationRoot) {
  const packagePath = join(integrationRoot, "package.json");
  const lockPath = join(integrationRoot, "package-lock.json");
  const packageJson = readJson(packagePath, "M6_LIVE_DEPENDENCY_PACKAGE_INVALID");
  const packageLock = readJson(lockPath, "M6_LIVE_DEPENDENCY_LOCK_INVALID");
  const dependencies = packageJson?.dependencies;
  const lockDependencies = packageLock?.packages?.[""]?.dependencies;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)
    || !lockDependencies || typeof lockDependencies !== "object" || Array.isArray(lockDependencies)
    || packageLock.lockfileVersion !== 3
    || canonicalJson(dependencies) !== canonicalJson(lockDependencies)) {
    throw layerError("M6_LIVE_DEPENDENCY_LOCK_INVALID", "package.json and package-lock.json root dependencies are not exact mirrors");
  }
  for (const [name, version] of Object.entries(dependencies)) {
    if (!EXACT_VERSION.test(version)) {
      throw layerError("M6_LIVE_DEPENDENCY_VERSION_UNSEALED", `${name} is not pinned to an exact version`);
    }
  }
  if (canonicalJson(dependencies) !== canonicalJson(REQUIRED_ROOT_DEPENDENCIES)) {
    throw layerError("M6_LIVE_DEPENDENCY_ROOT_SET_INVALID", "the production DSH runtime must contain exactly the reviewed root dependency set");
  }
  for (const [name, version] of Object.entries(REQUIRED_ROOT_DEPENDENCIES)) {
    if (dependencies[name] !== version || packageLock?.packages?.[`node_modules/${name}`]?.version !== version) {
      throw layerError("M6_LIVE_DEPENDENCY_PIN_MISMATCH", `${name} must be sealed to ${version}`);
    }
  }
  for (const [path, entry] of Object.entries(packageLock.packages)) {
    if (path === "") continue;
    if (entry?.link === true || typeof entry?.resolved !== "string" || typeof entry?.integrity !== "string" || typeof entry?.license !== "string" || entry.license.length === 0
      || !entry.resolved.startsWith("https://registry.npmjs.org/") || !entry.integrity.startsWith("sha512-")) {
      throw layerError("M6_LIVE_DEPENDENCY_PROVENANCE_UNSEALED", `lock entry ${path} is not an integrity-pinned npm registry artifact`);
    }
  }
  const provenance = Object.freeze(Object.entries(packageLock.packages)
    .filter(([path]) => path !== "")
    .map(([path, entry]) => Object.freeze({
      path,
      version: entry.version,
      resolved: entry.resolved,
      integrity: entry.integrity,
      license: entry.license,
      optional: entry.optional === true,
    }))
    .sort((a, b) => a.path.localeCompare(b.path, "en")));
  return Object.freeze({
    packageJson,
    packageLock,
    dependencies: Object.freeze({ ...dependencies }),
    packageJsonSha256: sha256File(packagePath),
    packageLockSha256: sha256File(lockPath),
    packageCount: provenance.length,
    packageProvenanceHash: sha256(`xw.m6-live-runtime-dependency-provenance.v1:${canonicalJson(provenance)}`),
  });
}

function validateDshSourceLocks(layerRoot) {
  const integrationLock = readJson(join(layerRoot, "integrations/dsh-xw/lock.json"), "M6_LIVE_DSH_LOCK_INVALID");
  const harnessLock = readJson(join(layerRoot, "packages/harness-protocol/locks/dsh.lock.v1.json"), "M6_LIVE_DSH_LOCK_INVALID");
  if (integrationLock.version !== REQUIRED_ROOT_DEPENDENCIES["@deepseek-ai/dsh"]
    || integrationLock.version !== harnessLock.version
    || integrationLock.commit !== harnessLock.commit
    || integrationLock.tree !== harnessLock.tree
    || !H40.test(integrationLock.commit ?? "")
    || !H40.test(integrationLock.tree ?? "")) {
    throw layerError("M6_LIVE_DSH_LOCK_DRIFT", "the integration DSH source lock does not match the canonical harness lock");
  }
  return Object.freeze({
    version: integrationLock.version,
    commit: integrationLock.commit,
    tree: integrationLock.tree,
    integrationLockSha256: sha256File(join(layerRoot, "integrations/dsh-xw/lock.json")),
    harnessLockSha256: sha256File(join(layerRoot, "packages/harness-protocol/locks/dsh.lock.v1.json")),
  });
}

function validateRelease(releaseRoot) {
  const root = assertPlainRoot(releaseRoot, "M6_LIVE_SOURCE_RELEASE_INVALID");
  const manifestPath = join(root, RELEASE_MANIFEST_FILENAME);
  let manifestBytes;
  try {
    manifestBytes = readFileSync(manifestPath);
  } catch (cause) {
    throw layerError("M6_LIVE_SOURCE_RELEASE_INVALID", "source release manifest is unavailable", cause);
  }
  let verification;
  try {
    verification = verifyReleaseManifest({ manifestPath, root });
  } catch (cause) {
    throw layerError("M6_LIVE_SOURCE_RELEASE_INVALID", "hardened source release verification failed", cause);
  }
  if (verification.ok !== true) {
    const driftKinds = new Set([
      "blob", "directoryType", "entryType", "extra", "extraDirectory", "fileType", "gitBlobOid", "gitMode",
      "manifestType", "missing", "missingDirectory", "reparse", "sourceTree", "symlink", "unreadable",
    ]);
    const code = verification.mismatches.some((entry) => entry.kind === "nodeModules")
      ? "M6_LIVE_IMMUTABLE_RELEASE_DEPENDENCY_WRITE"
      : verification.mismatches.some((entry) => driftKinds.has(entry.kind))
        ? "M6_LIVE_SOURCE_RELEASE_DRIFT"
        : "M6_LIVE_SOURCE_RELEASE_INVALID";
    const summary = verification.mismatches.slice(0, 3)
      .map((entry) => `${entry.kind}:${entry.path ?? RELEASE_MANIFEST_FILENAME}`).join(",");
    throw layerError(code, `hardened source release verification rejected the exact Git tree${summary ? ` (${summary})` : ""}`);
  }
  let manifestBytesAfterVerification;
  try {
    manifestBytesAfterVerification = readFileSync(manifestPath);
  } catch (cause) {
    throw layerError("M6_LIVE_SOURCE_RELEASE_DRIFT", "source release manifest disappeared after hardened verification", cause);
  }
  if (!manifestBytes.equals(manifestBytesAfterVerification)) {
    throw layerError("M6_LIVE_SOURCE_RELEASE_DRIFT", "source release manifest changed during hardened verification");
  }
  const manifest = readJson(manifestPath, "M6_LIVE_SOURCE_RELEASE_INVALID");
  if (manifest.schemaId !== RELEASE_MANIFEST_SCHEMA_ID) {
    throw layerError("M6_LIVE_SOURCE_RELEASE_INVALID", "source release schema changed after hardened verification");
  }
  const byPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const sourceBindings = M6_LIVE_RUNTIME_SOURCE_PATHS.map((path) => {
    const entry = byPath.get(path);
    if (!entry) throw layerError("M6_LIVE_RUNTIME_SOURCE_MISSING", `source release does not contain ${path}`);
    const file = join(root, ...path.split("/"));
    let size;
    try { size = statSync(file).size; } catch (cause) {
      throw layerError("M6_LIVE_SOURCE_RELEASE_DRIFT", `source release file disappeared after verification: ${path}`, cause);
    }
    return Object.freeze({
      path,
      gitMode: entry.gitMode,
      gitBlobOid: entry.gitBlobOid,
      sha256: entry.sha256,
      size,
    });
  });
  return Object.freeze({
    root,
    manifest,
    manifestSha256: sha256(manifestBytes),
    sourceBindings: Object.freeze(sourceBindings),
  });
}

function assertSafeSymlink(root, path) {
  const target = readlinkSync(path);
  if (isAbsolute(target) || target.includes("\0")) throw layerError("M6_LIVE_DEPENDENCY_SYMLINK_ESCAPE", "dependency layer contains an absolute symlink");
  let real;
  try { real = realpathSync.native(path); } catch (cause) {
    throw layerError("M6_LIVE_DEPENDENCY_SYMLINK_INVALID", "dependency layer contains a broken symlink", cause);
  }
  if (!inside(root, real)) throw layerError("M6_LIVE_DEPENDENCY_SYMLINK_ESCAPE", "dependency layer symlink escapes its content root");
  return target.replaceAll("\\", "/");
}

function collectInventory(root) {
  const absoluteRoot = assertPlainRoot(root, "M6_LIVE_DEPENDENCY_LAYER_INVALID");
  const entries = [];
  const visit = (directory, prefix = "") => {
    const children = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const child of children) {
      const path = join(directory, child.name);
      const rel = prefix ? `${prefix}/${child.name}` : child.name;
      if (rel === M6_LIVE_DEPENDENCY_LAYER_MANIFEST_FILENAME) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        entries.push(Object.freeze({ path: rel, type: "symlink", target: assertSafeSymlink(absoluteRoot, path) }));
      } else if (stat.isDirectory()) {
        visit(path, rel);
      } else if (stat.isFile()) {
        entries.push(Object.freeze({ path: rel, type: "file", size: stat.size, sha256: sha256File(path) }));
      } else {
        throw layerError("M6_LIVE_DEPENDENCY_ENTRY_INVALID", `dependency layer contains unsupported entry ${rel}`);
      }
    }
  };
  visit(absoluteRoot);
  return Object.freeze(entries.sort((a, b) => a.path.localeCompare(b.path, "en")));
}

function deriveInventoryHash(files) {
  return sha256(`${M6_LIVE_DEPENDENCY_LAYER_SCHEMA_ID}:inventory:${canonicalJson(files)}`);
}

function deriveLayerHash(body) {
  return sha256(`${M6_LIVE_DEPENDENCY_LAYER_SCHEMA_ID}:${canonicalJson(body)}`);
}

function deriveQualificationHash(body) {
  return sha256(`${M6_LIVE_DEPENDENCY_QUALIFICATION_SCHEMA_ID}:${canonicalJson(body)}`);
}

function buildQualification(manifest, installedAdapter) {
  const body = {
    schemaId: M6_LIVE_DEPENDENCY_QUALIFICATION_SCHEMA_ID,
    status: "DEPENDENCY_LAYER_QUALIFIED",
    scope: "M6_C1_RUNTIME_DEPENDENCIES_ONLY",
    layerHash: manifest.layerHash,
    inventoryHash: manifest.inventoryHash,
    releaseId: manifest.sourceRelease.releaseId,
    sourceCommit: manifest.sourceRelease.sourceCommit,
    sourceReleaseManifestSha256: manifest.sourceRelease.manifestSha256,
    packageLockSha256: manifest.lock.packageLockSha256,
    packageCount: manifest.lock.packageCount,
    packageProvenanceHash: manifest.lock.packageProvenanceHash,
    dshCommit: manifest.lock.dshCommit,
    nodeVersion: manifest.runtime.nodeVersion,
    nodeExecutableSha256: manifest.runtime.nodeExecutableSha256,
    platform: manifest.runtime.platform,
    arch: manifest.runtime.arch,
    adapterPackage: installedAdapter.packageName,
    adapterVersion: installedAdapter.packageVersion,
    adapterIntegrityHash: installedAdapter.integrityHash,
    installScriptsExecuted: false,
    providerHealthEvaluated: false,
    secretMaterialPresent: false,
    gateFEligible: false,
  };
  return Object.freeze({ ...body, qualificationHash: deriveQualificationHash(body) });
}

function npmInvocation(npmExecutable) {
  const candidate = npmExecutable ?? process.env.npm_execpath;
  if (typeof candidate === "string" && candidate.endsWith(".js") && existsSync(candidate)) {
    return Object.freeze({ command: process.execPath, prefix: Object.freeze([candidate]) });
  }
  if (process.platform === "win32") {
    const cli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (!existsSync(cli)) throw layerError("M6_LIVE_NPM_UNAVAILABLE", "npm-cli.js is not installed beside the exact Node runtime");
    return Object.freeze({ command: process.execPath, prefix: Object.freeze([cli]) });
  }
  return Object.freeze({ command: npmExecutable ?? "npm", prefix: Object.freeze([]) });
}

function defaultInstall({ integrationRoot, npmExecutable }) {
  const emptyUserConfig = join(dirname(integrationRoot), `.npmrc-empty-${randomUUID()}`);
  writeFileSync(emptyUserConfig, "");
  const allowed = ["PATH", "Path", "SystemRoot", "WINDIR", "PATHEXT", "ComSpec", "TEMP", "TMP", "LANG", "LC_ALL", "TZ"];
  const env = Object.fromEntries(allowed.filter((key) => typeof process.env[key] === "string").map((key) => [key, process.env[key]]));
  Object.assign(env, {
    npm_config_userconfig: emptyUserConfig,
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  });
  try {
    const npm = npmInvocation(npmExecutable);
    execFileSync(npm.command, [...npm.prefix, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: integrationRoot,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
  } finally {
    rmSync(emptyUserConfig, { force: true });
  }
}

function copyRuntimeSources(release, stageRoot) {
  for (const entry of release.sourceBindings) {
    const source = join(release.root, ...entry.path.split("/"));
    const destination = join(stageRoot, ...entry.path.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    if (sha256File(destination) !== entry.sha256) throw layerError("M6_LIVE_RUNTIME_SOURCE_COPY_DRIFT", `copied runtime source drifted: ${entry.path}`);
  }
}

function verifyRuntimeSourceBindings(root, sourceBindings) {
  for (const entry of sourceBindings) {
    if (!safeRelativePath(entry?.path) || !GIT_MODE.has(entry?.gitMode) || !H40.test(entry?.gitBlobOid ?? "")
      || !H64.test(entry?.sha256 ?? "") || !Number.isSafeInteger(entry?.size) || entry.size < 0) {
      throw layerError("M6_LIVE_RUNTIME_SOURCE_BINDING_INVALID", "dependency layer contains a malformed runtime source binding");
    }
    const path = join(root, ...entry.path.split("/"));
    let bytes;
    try { bytes = readFileSync(path); } catch { bytes = null; }
    if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()
      || statSync(path).size !== entry.size || !bytes || sha256(bytes) !== entry.sha256 || gitBlobOid(bytes) !== entry.gitBlobOid) {
      throw layerError("M6_LIVE_RUNTIME_SOURCE_DRIFT", `dependency installer or runtime changed sealed source ${entry.path}`);
    }
  }
}

function nodeExecutableSha256() {
  return sha256File(process.execPath);
}

function detectNpmVersion(npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm") {
  const npm = npmInvocation(npmExecutable);
  return execFileSync(npm.command, [...npm.prefix, "--version"], { encoding: "utf8", windowsHide: true }).trim();
}

export function inspectM6LiveRuntimeDependencyLocks({ integrationRoot } = {}) {
  if (typeof integrationRoot !== "string" || !isAbsolute(integrationRoot)) {
    throw layerError("M6_LIVE_DEPENDENCY_PATH_INVALID", "integrationRoot must be absolute");
  }
  const root = assertPlainRoot(integrationRoot, "M6_LIVE_DEPENDENCY_PACKAGE_INVALID");
  const lock = validateLockfiles(root);
  const dshLock = validateDshSourceLocks(resolve(root, "../.."));
  return Object.freeze({
    ok: true,
    packageJsonSha256: lock.packageJsonSha256,
    packageLockSha256: lock.packageLockSha256,
    rootDependencies: lock.dependencies,
    dshVersion: dshLock.version,
    dshCommit: dshLock.commit,
    dshTree: dshLock.tree,
  });
}

export function materializeM6LiveRuntimeDependencyLayer({
  releaseRoot,
  layersRoot,
  install = defaultInstall,
  npmExecutable,
} = {}) {
  if (typeof releaseRoot !== "string" || typeof layersRoot !== "string" || !isAbsolute(releaseRoot) || !isAbsolute(layersRoot)) {
    throw layerError("M6_LIVE_DEPENDENCY_PATH_INVALID", "releaseRoot and layersRoot must be absolute paths");
  }
  const release = validateRelease(releaseRoot);
  const absoluteLayersRoot = resolve(layersRoot);
  if (inside(release.root, absoluteLayersRoot)) {
    throw layerError("M6_LIVE_IMMUTABLE_RELEASE_WRITE_FORBIDDEN", "the dependency layer root must be outside the immutable source release");
  }
  mkdirSync(absoluteLayersRoot, { recursive: true });
  const stageRoot = mkdtempSync(join(absoluteLayersRoot, ".m6-live-deps-stage-"));
  if (!inside(absoluteLayersRoot, stageRoot)) throw layerError("M6_LIVE_DEPENDENCY_STAGE_ESCAPE", "dependency staging path escaped its root");
  try {
    copyRuntimeSources(release, stageRoot);
    const integrationRoot = join(stageRoot, "integrations/dsh-xw");
    const lock = validateLockfiles(integrationRoot);
    const dshLock = validateDshSourceLocks(stageRoot);
    install({ integrationRoot, npmExecutable });
    verifyRuntimeSourceBindings(stageRoot, release.sourceBindings);
    const installedAdapter = computeInstalledLiveAdapterIntegrity({ dependencyRoot: stageRoot });
    const requiredEntries = [DSH_CLI_PATH, LIVE_RUNTIME_ENTRY_PATH, MODEL_MANIFEST_PATH];
    for (const entry of requiredEntries) {
      const file = join(stageRoot, ...entry.split("/"));
      if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) {
        throw layerError("M6_LIVE_DEPENDENCY_ENTRY_MISSING", `sealed dependency layer is missing ${entry}`);
      }
    }
    const files = collectInventory(stageRoot);
    const body = {
      schemaId: M6_LIVE_DEPENDENCY_LAYER_SCHEMA_ID,
      sourceRelease: {
        releaseId: release.manifest.releaseId,
        sourceCommit: release.manifest.sourceCommit,
        sourceTreeSha: release.manifest.sourceTreeSha,
        manifestSha256: release.manifestSha256,
      },
      lock: {
        packageJsonSha256: lock.packageJsonSha256,
        packageLockSha256: lock.packageLockSha256,
        packageCount: lock.packageCount,
        packageProvenanceHash: lock.packageProvenanceHash,
        rootDependencies: lock.dependencies,
        dshVersion: dshLock.version,
        dshCommit: dshLock.commit,
        dshTree: dshLock.tree,
        integrationDshLockSha256: dshLock.integrationLockSha256,
        harnessDshLockSha256: dshLock.harnessLockSha256,
        registry: "https://registry.npmjs.org/",
      },
      runtime: {
        nodeVersion: process.version,
        nodeExecutableSha256: nodeExecutableSha256(),
        npmVersion: detectNpmVersion(npmExecutable),
        platform: process.platform,
        arch: process.arch,
      },
      entrypoints: {
        dshCli: DSH_CLI_PATH,
        liveRuntimePlugin: LIVE_RUNTIME_ENTRY_PATH,
        liveNetworkGuard: LIVE_NETWORK_GUARD_PATH,
        modelManifest: MODEL_MANIFEST_PATH,
      },
      sourceBindings: release.sourceBindings,
      inventoryHash: deriveInventoryHash(files),
      files,
      installScriptsExecuted: false,
      providerHealthEvaluated: false,
      secretMaterialPresent: false,
    };
    const manifest = Object.freeze({ ...body, layerHash: deriveLayerHash(body) });
    writeFileSync(join(stageRoot, M6_LIVE_DEPENDENCY_LAYER_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`);
    const targetRoot = join(absoluteLayersRoot, manifest.layerHash);
    if (existsSync(targetRoot)) {
      const existing = verifyM6LiveRuntimeDependencyLayer({
        layerRoot: targetRoot,
        expectedLayerHash: manifest.layerHash,
        sourceRoot: release.root,
      });
      rmSync(stageRoot, { recursive: true, force: true });
      return Object.freeze({ ...existing, reused: true });
    }
    renameSync(stageRoot, targetRoot);
    return Object.freeze({
      ...verifyM6LiveRuntimeDependencyLayer({ layerRoot: targetRoot, expectedLayerHash: manifest.layerHash, sourceRoot: release.root }),
      reused: false,
    });
  } catch (error) {
    if (existsSync(stageRoot) && inside(absoluteLayersRoot, stageRoot)) rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

export function verifyM6LiveRuntimeDependencyLayer({
  layerRoot,
  expectedLayerHash,
  sourceRoot = null,
  enforceRuntime = true,
} = {}) {
  if (typeof layerRoot !== "string" || !isAbsolute(layerRoot)) {
    throw layerError("M6_LIVE_DEPENDENCY_PATH_INVALID", "dependency layer root must be absolute");
  }
  const root = assertPlainRoot(layerRoot, "M6_LIVE_DEPENDENCY_LAYER_INVALID");
  const manifestPath = join(root, M6_LIVE_DEPENDENCY_LAYER_MANIFEST_FILENAME);
  const manifest = readJson(manifestPath, "M6_LIVE_DEPENDENCY_MANIFEST_INVALID");
  const { layerHash: claimedLayerHash, ...body } = manifest;
  const computedLayerHash = deriveLayerHash(body);
  if (manifest.schemaId !== M6_LIVE_DEPENDENCY_LAYER_SCHEMA_ID || !H64.test(claimedLayerHash ?? "")
    || claimedLayerHash !== computedLayerHash
    || (expectedLayerHash !== undefined && claimedLayerHash !== expectedLayerHash)
    || resolve(dirname(root), claimedLayerHash) !== root) {
    throw layerError("M6_LIVE_DEPENDENCY_LAYER_HASH_MISMATCH", "dependency layer manifest, expected hash, or content-addressed directory does not match");
  }
  const files = collectInventory(root);
  if (deriveInventoryHash(files) !== manifest.inventoryHash || canonicalJson(files) !== canonicalJson(manifest.files)) {
    throw layerError("M6_LIVE_DEPENDENCY_INVENTORY_DRIFT", "dependency layer inventory has missing, extra, or changed content");
  }
  if (manifest.installScriptsExecuted !== false || manifest.providerHealthEvaluated !== false || manifest.secretMaterialPresent !== false) {
    throw layerError("M6_LIVE_DEPENDENCY_PROVENANCE_INVALID", "dependency layer provenance flags are unsafe");
  }
  const lock = validateLockfiles(join(root, "integrations/dsh-xw"));
  const dshLock = validateDshSourceLocks(root);
  if (lock.packageJsonSha256 !== manifest.lock?.packageJsonSha256
    || lock.packageLockSha256 !== manifest.lock?.packageLockSha256
    || lock.packageCount !== manifest.lock?.packageCount
    || lock.packageProvenanceHash !== manifest.lock?.packageProvenanceHash
    || canonicalJson(lock.dependencies) !== canonicalJson(manifest.lock?.rootDependencies)
    || dshLock.commit !== manifest.lock?.dshCommit
    || dshLock.tree !== manifest.lock?.dshTree
    || dshLock.integrationLockSha256 !== manifest.lock?.integrationDshLockSha256
    || dshLock.harnessLockSha256 !== manifest.lock?.harnessDshLockSha256) {
    throw layerError("M6_LIVE_DEPENDENCY_LOCK_DRIFT", "dependency layer lock binding drifted");
  }
  for (const [name, expected] of Object.entries({
    dshCli: DSH_CLI_PATH,
    liveRuntimePlugin: LIVE_RUNTIME_ENTRY_PATH,
    liveNetworkGuard: LIVE_NETWORK_GUARD_PATH,
    modelManifest: MODEL_MANIFEST_PATH,
  })) {
    if (manifest.entrypoints?.[name] !== expected || !existsSync(join(root, ...expected.split("/")))) {
      throw layerError("M6_LIVE_DEPENDENCY_ENTRY_MISSING", `dependency layer entrypoint ${name} is missing or rebound`);
    }
  }
  if (enforceRuntime && (manifest.runtime?.nodeVersion !== process.version
    || manifest.runtime?.nodeExecutableSha256 !== nodeExecutableSha256()
    || manifest.runtime?.platform !== process.platform
    || manifest.runtime?.arch !== process.arch)) {
    throw layerError("M6_LIVE_DEPENDENCY_RUNTIME_DRIFT", "dependency layer was not qualified for this exact Node runtime and platform");
  }
  if (!Array.isArray(manifest.sourceBindings)
    || canonicalJson(manifest.sourceBindings.map(({ path }) => path)) !== canonicalJson(M6_LIVE_RUNTIME_SOURCE_PATHS)) {
    throw layerError("M6_LIVE_RUNTIME_SOURCE_BINDING_INVALID", "dependency layer source allowlist is not exact");
  }
  verifyRuntimeSourceBindings(root, manifest.sourceBindings);
  if (sourceRoot !== null) {
    const release = validateRelease(sourceRoot);
    if (manifest.sourceRelease?.releaseId !== release.manifest.releaseId
      || manifest.sourceRelease?.sourceCommit !== release.manifest.sourceCommit
      || manifest.sourceRelease?.sourceTreeSha !== release.manifest.sourceTreeSha
      || manifest.sourceRelease?.manifestSha256 !== release.manifestSha256
      || canonicalJson(manifest.sourceBindings) !== canonicalJson(release.sourceBindings)) {
      throw layerError("M6_LIVE_DEPENDENCY_SOURCE_RELEASE_MISMATCH", "dependency layer is not bound to the executing immutable source release");
    }
  }
  const installedAdapter = computeInstalledLiveAdapterIntegrity({ dependencyRoot: root });
  const qualification = buildQualification(manifest, installedAdapter);
  return Object.freeze({
    ok: true,
    layerRoot: root,
    layerHash: manifest.layerHash,
    manifestPath,
    manifest: Object.freeze(manifest),
    integrationRoot: join(root, "integrations/dsh-xw"),
    dshCli: join(root, ...DSH_CLI_PATH.split("/")),
    liveRuntimePlugin: join(root, ...LIVE_RUNTIME_ENTRY_PATH.split("/")),
    liveNetworkGuard: join(root, ...LIVE_NETWORK_GUARD_PATH.split("/")),
    modelManifest: join(root, ...MODEL_MANIFEST_PATH.split("/")),
    installedAdapter,
    qualification,
  });
}
