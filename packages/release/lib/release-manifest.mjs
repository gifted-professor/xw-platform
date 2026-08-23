// M3-R1 Release Foundation：不可变 release 的构建 / 物化 / 校验。
// 纯离线工具：只读 git 仓库、只写 outDir 指定目录；不 deploy、不 restart、不碰现场。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const RELEASE_MANIFEST_SCHEMA_ID = "xw.runtime.release-manifest.v1";
export const RELEASE_MANIFEST_FILENAME = "release-manifest.v1.json";
export const SOURCE_REPO = "gifted-professor/xw-platform";
export const DEFAULT_RUNTIME_PROFILE = "legacy_compat";
export const RUNTIME_CUTOVER_ALLOWED = false;

const SERVICE_TREES = Object.freeze({
  orchestrator: "services/orchestrator",
  controlPlane: "services/control-plane",
});
const REGULAR_GIT_MODES = new Set(["100644", "100755"]);
const RELEASE_MANIFEST_KEYS = Object.freeze([
  "files", "nodeVersion", "npmVersion", "releaseId", "runtimeCutoverAllowed",
  "runtimeProfile", "schemaId", "services", "sourceCommit", "sourceRepo", "sourceTreeSha",
]);
const RELEASE_FILE_KEYS = Object.freeze(["gitBlobOid", "gitMode", "path", "sha256"]);
const RELEASE_SERVICE_KEYS = Object.freeze(["path", "treeSha256"]);

function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()));
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function listGitTreeEntries(root, commit = "HEAD") {
  const out = execFileSync(
    "git",
    ["ls-tree", "-r", "-z", "--full-tree", commit],
    { cwd: root, encoding: "utf8" },
  );
  return out.split("\0").filter(Boolean).map((record) => {
    const tab = record.indexOf("\t");
    if (tab < 0) throw new Error("RELEASE_GIT_TREE_INVALID: malformed ls-tree record");
    const [mode, type, objectId] = record.slice(0, tab).split(" ");
    return { mode, type, objectId, path: record.slice(tab + 1) };
  }).filter((entry) => !entry.path.startsWith(".git/") && entry.path !== ".git");
}

export function listTrackedFiles(root, commit = "HEAD") {
  return listGitTreeEntries(root, commit).map((entry) => entry.path);
}

function hashBuffer(algorithm, buffer) {
  return createHash(algorithm).update(buffer).digest("hex");
}

function sha256Buffer(buffer) {
  return hashBuffer("sha256", buffer);
}

function sha256File(path) {
  return sha256Buffer(readFileSync(path));
}

function gitObjectId(type, bytes) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return hashBuffer("sha1", Buffer.concat([
    Buffer.from(`${type} ${body.length}\0`, "utf8"),
    body,
  ]));
}

function gitBlobObjectId(bytes) {
  return gitObjectId("blob", bytes);
}

function gitBlob(root, objectId) {
  return execFileSync("git", ["cat-file", "blob", objectId], { cwd: root, encoding: null });
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function validReleasePath(path) {
  return typeof path === "string" && path !== "" && path.length <= 1024
    && !path.includes("\0") && !path.includes("\\") && !path.startsWith("/") && !/^[A-Za-z]:/u.test(path)
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function forbiddenReleasePath(path) {
  const parts = path.split("/").map((part) => part.toLowerCase());
  return path.toLowerCase() === RELEASE_MANIFEST_FILENAME
    || parts.includes(".git") || parts.includes("node_modules");
}

function sameFsPath(left, right) {
  const normalize = (value) => process.platform === "win32"
    ? resolve(value).toLowerCase()
    : resolve(value);
  return normalize(left) === normalize(right);
}

function gitTreeObjectId(entries) {
  const root = { children: new Map() };
  for (const entry of entries) {
    if (!validReleasePath(entry.path) || !REGULAR_GIT_MODES.has(entry.gitMode)
      || !/^[0-9a-f]{40}$/u.test(entry.gitBlobOid || "")) {
      throw new Error(`RELEASE_GIT_TREE_ENTRY_INVALID: ${entry.path ?? "<unknown>"}`);
    }
    const parts = entry.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const present = node.children.get(part);
      if (present?.kind === "blob") throw new Error(`RELEASE_GIT_TREE_PATH_CONFLICT: ${entry.path}`);
      if (!present) node.children.set(part, { kind: "tree", children: new Map() });
      node = node.children.get(part);
    }
    const name = parts.at(-1);
    if (node.children.has(name)) throw new Error(`RELEASE_GIT_TREE_PATH_CONFLICT: ${entry.path}`);
    node.children.set(name, {
      kind: "blob",
      gitMode: entry.gitMode,
      objectId: entry.gitBlobOid,
    });
  }

  function hashTree(node) {
    const children = [...node.children.entries()].map(([name, child]) => {
      if (child.kind === "tree") {
        return { name, kind: "tree", gitMode: "40000", objectId: hashTree(child) };
      }
      return { name, ...child };
    }).sort((left, right) => compareUtf8(
      `${left.name}${left.kind === "tree" ? "/" : ""}`,
      `${right.name}${right.kind === "tree" ? "/" : ""}`,
    ));
    const body = Buffer.concat(children.flatMap((entry) => [
      Buffer.from(`${entry.gitMode} ${entry.name}\0`, "utf8"),
      Buffer.from(entry.objectId, "hex"),
    ]));
    return gitObjectId("tree", body);
  }

  return hashTree(root);
}

function assertCleanReleaseSource(root) {
  const sourceRoot = resolve(root);
  const stat = lstatSync(sourceRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("RELEASE_SOURCE_REPARSE: source root must be a non-symlink directory");
  }
  const status = execFileSync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"],
    { cwd: sourceRoot, encoding: null },
  );
  if (status.length > 0) {
    const sample = status.toString("utf8").split("\0").filter(Boolean).slice(0, 3).join(", ");
    throw new Error(`RELEASE_SOURCE_DIRTY: tracked/index/untracked drift is forbidden${sample ? ` (${sample})` : ""}`);
  }
}

function assertSourceWorktreeTypes(root, files) {
  const sourceRoot = resolve(root);
  const canonicalRoot = realpathSync(sourceRoot);
  const inspected = new Set();
  for (const entry of files) {
    const parts = entry.path.split("/");
    for (let index = 0; index < parts.length; index += 1) {
      const relativePath = parts.slice(0, index + 1).join("/");
      if (inspected.has(relativePath)) continue;
      inspected.add(relativePath);
      const target = join(sourceRoot, ...parts.slice(0, index + 1));
      let stat;
      try {
        stat = lstatSync(target);
      } catch {
        throw new Error(`RELEASE_SOURCE_DRIFT: committed path is unavailable: ${relativePath}`);
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`RELEASE_SOURCE_REPARSE: committed path traverses a symlink/reparse point: ${relativePath}`);
      }
      const expectedDirectory = index < parts.length - 1;
      if ((expectedDirectory && !stat.isDirectory()) || (!expectedDirectory && !stat.isFile())) {
        throw new Error(`RELEASE_SOURCE_TYPE_DRIFT: committed path has the wrong filesystem type: ${relativePath}`);
      }
      const expectedRealPath = join(canonicalRoot, ...parts.slice(0, index + 1));
      if (!sameFsPath(realpathSync(target), expectedRealPath)) {
        throw new Error(`RELEASE_SOURCE_REPARSE: committed path resolves through a reparse point: ${relativePath}`);
      }
    }
  }
}

function inspectMaterializedTree(root) {
  const base = resolve(root);
  let rootStat;
  try {
    rootStat = lstatSync(base);
  } catch (error) {
    return { rootType: "missing", entries: [], errors: [{ path: "", error: error.message }] };
  }
  if (rootStat.isSymbolicLink()) return { rootType: "symlink", entries: [], errors: [] };
  if (!rootStat.isDirectory()) return { rootType: "non-directory", entries: [], errors: [] };
  const canonicalRoot = realpathSync(base);
  const entries = [];
  const errors = [];

  function walk(directory) {
    let children;
    try {
      children = readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => compareUtf8(left.name, right.name));
    } catch (error) {
      errors.push({ path: relative(base, directory).split(sep).join("/"), error: error.message });
      return;
    }
    for (const child of children) {
      const target = join(directory, child.name);
      const path = relative(base, target).split(sep).join("/");
      let stat;
      try {
        stat = lstatSync(target);
      } catch (error) {
        entries.push({ path, type: "unreadable" });
        errors.push({ path, error: error.message });
        continue;
      }
      if (stat.isSymbolicLink()) {
        entries.push({ path, type: "symlink", stat });
        continue;
      }
      if (!stat.isDirectory() && !stat.isFile()) {
        entries.push({ path, type: "non-regular", stat });
        continue;
      }
      if (stat.isFile() && stat.nlink !== 1) {
        entries.push({ path, type: "hardlink", stat });
        continue;
      }
      let actualRealPath;
      try {
        actualRealPath = realpathSync(target);
      } catch (error) {
        entries.push({ path, type: "unreadable", stat });
        errors.push({ path, error: error.message });
        continue;
      }
      const expectedRealPath = join(canonicalRoot, ...path.split("/"));
      if (!sameFsPath(actualRealPath, expectedRealPath)) {
        entries.push({ path, type: "reparse", stat });
        continue;
      }
      if (stat.isDirectory()) {
        entries.push({ path, type: "directory", stat });
        walk(target);
      } else {
        entries.push({ path, type: "file", stat });
      }
    }
  }

  walk(base);
  return { rootType: "directory", entries, errors };
}

function subtreeSha256(files, prefix) {
  const hash = createHash("sha256");
  for (const entry of files) {
    if (!entry.path.startsWith(`${prefix}/`)) continue;
    hash.update(`${entry.path}:${entry.sha256}\n`, "utf8");
  }
  return hash.digest("hex");
}

export function detectNpmVersion() {
  try {
    return execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export function defaultReleaseId(sourceCommit, now = new Date()) {
  const stamp = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `xw-${stamp}-${sourceCommit.slice(0, 7)}`;
}

export function buildReleaseManifest({ root, releaseId = null } = {}) {
  if (!root) throw new Error("RELEASE_BUILD: root is required");
  const sourceCommit = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const sourceTreeSha = git(root, ["rev-parse", "--verify", `${sourceCommit}^{tree}`]);
  const files = listGitTreeEntries(root, sourceCommit).map(({ mode, type, objectId, path }) => {
    if (!validReleasePath(path) || forbiddenReleasePath(path)) {
      throw new Error(`RELEASE_SOURCE_PATH_FORBIDDEN: ${path}`);
    }
    if (type !== "blob" || !REGULAR_GIT_MODES.has(mode)) {
      throw new Error(`RELEASE_SOURCE_ENTRY_UNSUPPORTED: ${path} (${mode} ${type})`);
    }
    const bytes = gitBlob(root, objectId);
    const actualObjectId = gitBlobObjectId(bytes);
    if (actualObjectId !== objectId) {
      throw new Error(`RELEASE_GIT_BLOB_OID_MISMATCH: ${path}`);
    }
    return {
      path,
      gitMode: mode,
      gitBlobOid: objectId,
      sha256: sha256Buffer(bytes),
    };
  }).sort((left, right) => compareUtf8(left.path, right.path));
  const actualTreeSha = gitTreeObjectId(files);
  if (actualTreeSha !== sourceTreeSha) {
    throw new Error(`RELEASE_GIT_TREE_OID_MISMATCH: expected ${sourceTreeSha}, reconstructed ${actualTreeSha}`);
  }
  const services = {};
  for (const [name, prefix] of Object.entries(SERVICE_TREES)) {
    services[name] = { path: prefix, treeSha256: subtreeSha256(files, prefix) };
  }
  return {
    schemaId: RELEASE_MANIFEST_SCHEMA_ID,
    releaseId: releaseId || defaultReleaseId(sourceCommit),
    sourceRepo: SOURCE_REPO,
    sourceCommit,
    sourceTreeSha,
    runtimeProfile: DEFAULT_RUNTIME_PROFILE,
    nodeVersion: process.versions.node,
    npmVersion: detectNpmVersion(),
    services,
    files,
    runtimeCutoverAllowed: RUNTIME_CUTOVER_ALLOWED,
  };
}

export function writeRelease({ root, outDir, releaseId = null } = {}) {
  if (!root || !outDir) throw new Error("RELEASE_WRITE: root and outDir are required");
  assertCleanReleaseSource(root);
  const manifest = buildReleaseManifest({ root, releaseId });
  assertSourceWorktreeTypes(root, manifest.files);
  assertCleanReleaseSource(root);
  if (!/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(manifest.releaseId)) {
    throw new Error("RELEASE_ID_INVALID: releaseId must be a bounded opaque directory name");
  }
  const releaseDir = join(outDir, "releases", manifest.releaseId);
  if (existsSync(releaseDir)) {
    throw new Error(`RELEASE_IMMUTABLE: ${releaseDir} already exists`);
  }
  mkdirSync(releaseDir, { recursive: true });
  for (const entry of manifest.files) {
    const target = join(releaseDir, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    const bytes = gitBlob(root, entry.gitBlobOid);
    if (sha256Buffer(bytes) !== entry.sha256 || gitBlobObjectId(bytes) !== entry.gitBlobOid) {
      throw new Error(`RELEASE_GIT_BLOB_DRIFT: ${entry.path}`);
    }
    writeFileSync(target, bytes, { mode: entry.gitMode === "100755" ? 0o755 : 0o644 });
  }
  const manifestPath = join(releaseDir, RELEASE_MANIFEST_FILENAME);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  const verified = verifyReleaseManifest({ manifestPath, root: releaseDir });
  if (!verified.ok) {
    throw new Error(`RELEASE_SELF_VERIFY_FAILED: ${JSON.stringify(verified.mismatches)}`);
  }
  return manifest;
}

export function verifyReleaseManifest({ manifestPath, root } = {}) {
  if (!manifestPath || !root) throw new Error("RELEASE_VERIFY: manifestPath and root are required");
  const mismatches = [];
  const releaseRoot = resolve(root);
  const expectedManifestPath = join(releaseRoot, RELEASE_MANIFEST_FILENAME);
  if (!sameFsPath(resolve(manifestPath), expectedManifestPath)) {
    return {
      ok: false,
      mismatches: [{ path: manifestPath, kind: "manifestLocation", expected: expectedManifestPath, actual: resolve(manifestPath) }],
    };
  }

  const materialized = inspectMaterializedTree(releaseRoot);
  if (materialized.rootType !== "directory") {
    return {
      ok: false,
      mismatches: [{ path: releaseRoot, kind: "rootType", expected: "non-symlink directory", actual: materialized.rootType }],
    };
  }
  const actualByPath = new Map(materialized.entries.map((entry) => [entry.path, entry]));
  const manifestEntry = actualByPath.get(RELEASE_MANIFEST_FILENAME);
  if (!manifestEntry || manifestEntry.type !== "file") {
    return {
      ok: false,
      mismatches: [{ path: RELEASE_MANIFEST_FILENAME, kind: "manifestType", expected: "regular file", actual: manifestEntry?.type ?? null }],
    };
  }

  let manifest;
  let manifestText;
  try {
    manifestText = readFileSync(expectedManifestPath, "utf8");
    manifest = JSON.parse(manifestText);
  } catch (error) {
    return {
      ok: false,
      mismatches: [{ path: RELEASE_MANIFEST_FILENAME, kind: "manifestJson", expected: "valid JSON", actual: error.message }],
    };
  }
  if (!exactObject(manifest, RELEASE_MANIFEST_KEYS)) {
    mismatches.push({ path: RELEASE_MANIFEST_FILENAME, kind: "manifestSchema", expected: RELEASE_MANIFEST_KEYS, actual: Object.keys(manifest || {}).sort() });
  }
  if (manifestText !== `${JSON.stringify(manifest, null, 2)}\n`) {
    mismatches.push({ path: RELEASE_MANIFEST_FILENAME, kind: "manifestEncoding", expected: "canonical pretty JSON with LF", actual: "non-canonical bytes" });
  }
  if (manifest.schemaId !== RELEASE_MANIFEST_SCHEMA_ID) {
    mismatches.push({ path: RELEASE_MANIFEST_FILENAME, kind: "schemaId", expected: RELEASE_MANIFEST_SCHEMA_ID, actual: manifest.schemaId ?? null });
    return { ok: false, mismatches };
  }
  if (!/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(manifest.releaseId || "")
    || basename(releaseRoot) !== manifest.releaseId) {
    mismatches.push({ path: RELEASE_MANIFEST_FILENAME, kind: "releaseId", expected: basename(releaseRoot), actual: manifest.releaseId ?? null });
  }
  if (!/^[0-9a-f]{40}$/u.test(manifest.sourceCommit || "")
    || !/^[0-9a-f]{40}$/u.test(manifest.sourceTreeSha || "")
    || manifest.sourceRepo !== SOURCE_REPO) {
    mismatches.push({ path: RELEASE_MANIFEST_FILENAME, kind: "sourceIdentity", expected: SOURCE_REPO, actual: manifest.sourceRepo ?? null });
  }
  if (manifest.runtimeProfile !== DEFAULT_RUNTIME_PROFILE
    || typeof manifest.nodeVersion !== "string" || manifest.nodeVersion === ""
    || !(manifest.npmVersion === null || (typeof manifest.npmVersion === "string" && manifest.npmVersion !== ""))) {
    mismatches.push({
      path: RELEASE_MANIFEST_FILENAME,
      kind: "runtimeIdentity",
      expected: { runtimeProfile: DEFAULT_RUNTIME_PROFILE, nodeVersion: "non-empty string", npmVersion: "null or non-empty string" },
      actual: { runtimeProfile: manifest.runtimeProfile ?? null, nodeVersion: manifest.nodeVersion ?? null, npmVersion: manifest.npmVersion ?? null },
    });
  }
  const expectedServiceNames = Object.keys(SERVICE_TREES).sort();
  if (!exactObject(manifest.services, expectedServiceNames)) {
    mismatches.push({ path: RELEASE_MANIFEST_FILENAME, kind: "servicesSchema", expected: expectedServiceNames, actual: Object.keys(manifest.services || {}).sort() });
  }
  for (const [name, expectedPath] of Object.entries(SERVICE_TREES)) {
    const service = manifest.services?.[name];
    if (!exactObject(service, RELEASE_SERVICE_KEYS) || service.path !== expectedPath
      || !/^[0-9a-f]{64}$/u.test(service.treeSha256 || "")) {
      mismatches.push({ path: expectedPath, kind: "serviceSchema", service: name, expected: { path: expectedPath, keys: RELEASE_SERVICE_KEYS }, actual: service ?? null });
    }
  }

  const declaredFiles = Array.isArray(manifest.files) ? manifest.files : [];
  if (!Array.isArray(manifest.files)) {
    mismatches.push({ path: RELEASE_MANIFEST_FILENAME, kind: "inventory", expected: "files array", actual: manifest.files ?? null });
  }
  const files = [];
  const declaredByPath = new Map();
  const caseFoldedPaths = new Set();
  for (const entry of declaredFiles) {
    const caseFoldedPath = process.platform === "win32" && typeof entry?.path === "string"
      ? entry.path.toLowerCase() : entry?.path;
    if (!exactObject(entry, RELEASE_FILE_KEYS)
      || !validReleasePath(entry?.path) || forbiddenReleasePath(entry.path)
      || !REGULAR_GIT_MODES.has(entry?.gitMode)
      || !/^[0-9a-f]{40}$/u.test(entry?.gitBlobOid || "")
      || !/^[0-9a-f]{64}$/u.test(entry?.sha256 || "")
      || declaredByPath.has(entry.path) || caseFoldedPaths.has(caseFoldedPath)) {
      mismatches.push({
        path: entry?.path ?? null,
        kind: "inventory",
        expected: "canonical unique safe path + gitMode + gitBlobOid + sha256",
        actual: entry ?? null,
      });
      continue;
    }
    declaredByPath.set(entry.path, entry);
    caseFoldedPaths.add(caseFoldedPath);
    files.push(entry);
  }
  const canonicalPaths = [...files].sort((left, right) => compareUtf8(left.path, right.path)).map((entry) => entry.path);
  if (files.length === declaredFiles.length
    && canonicalPaths.some((path, index) => path !== declaredFiles[index].path)) {
    mismatches.push({
      path: RELEASE_MANIFEST_FILENAME,
      kind: "inventoryOrder",
      expected: canonicalPaths,
      actual: declaredFiles.map((entry) => entry.path),
    });
  }

  const expectedDirectories = new Set();
  for (const entry of files) {
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      expectedDirectories.add(parts.slice(0, index).join("/"));
    }
  }

  for (const error of materialized.errors) {
    mismatches.push({ path: error.path, kind: "unreadable", expected: "readable", actual: error.error });
  }
  for (const entry of materialized.entries) {
    if (entry.type === "symlink") {
      mismatches.push({ path: entry.path, kind: "symlink", expected: "regular file or directory", actual: "symlink/reparse" });
    } else if (entry.type === "reparse") {
      mismatches.push({ path: entry.path, kind: "reparse", expected: "non-reparse file or directory", actual: "reparse" });
    } else if (entry.type === "hardlink") {
      mismatches.push({ path: entry.path, kind: "hardlink", expected: "link count 1", actual: entry.stat?.nlink ?? null });
    } else if (entry.type === "non-regular" || entry.type === "unreadable") {
      mismatches.push({ path: entry.path, kind: "entryType", expected: "regular file or directory", actual: entry.type });
    }
    if (entry.path.split("/").some((part) => part.toLowerCase() === "node_modules")) {
      mismatches.push({ path: entry.path, kind: "nodeModules", expected: "absent from immutable release", actual: entry.type });
    }
  }

  for (const entry of files) {
    const actualEntry = actualByPath.get(entry.path);
    if (!actualEntry) {
      mismatches.push({ path: entry.path, kind: "missing", expected: "regular file", actual: null });
    } else if (actualEntry.type !== "file") {
      mismatches.push({ path: entry.path, kind: "fileType", expected: "regular file", actual: actualEntry.type });
    }
  }
  for (const path of expectedDirectories) {
    const actualEntry = actualByPath.get(path);
    if (!actualEntry) {
      mismatches.push({ path, kind: "missingDirectory", expected: "directory", actual: null });
    } else if (actualEntry.type !== "directory") {
      mismatches.push({ path, kind: "directoryType", expected: "directory", actual: actualEntry.type });
    }
  }
  for (const entry of materialized.entries) {
    if (entry.path === RELEASE_MANIFEST_FILENAME) continue;
    if (entry.type === "file" && !declaredByPath.has(entry.path)) {
      mismatches.push({ path: entry.path, kind: "extra", expected: null, actual: sha256File(join(releaseRoot, ...entry.path.split("/"))) });
    }
    if (entry.type === "directory" && !expectedDirectories.has(entry.path)) {
      mismatches.push({ path: entry.path, kind: "extraDirectory", expected: null, actual: "directory" });
    }
  }

  const actualTreeEntries = [];
  let actualTreeComplete = true;
  for (const entry of materialized.entries) {
    if (entry.path === RELEASE_MANIFEST_FILENAME || entry.type === "directory") continue;
    if (entry.type !== "file") {
      actualTreeComplete = false;
      continue;
    }
    let bytes;
    try {
      bytes = readFileSync(join(releaseRoot, ...entry.path.split("/")));
    } catch (error) {
      mismatches.push({ path: entry.path, kind: "unreadable", expected: "readable regular file", actual: error.message });
      actualTreeComplete = false;
      continue;
    }
    const actualSha256 = sha256Buffer(bytes);
    const actualBlobOid = gitBlobObjectId(bytes);
    const declared = declaredByPath.get(entry.path);
    const observedMode = process.platform === "win32"
      ? (declared?.gitMode ?? "100644")
      : ((entry.stat.mode & 0o111) !== 0 ? "100755" : "100644");
    actualTreeEntries.push({ path: entry.path, gitMode: observedMode, gitBlobOid: actualBlobOid });
    if (!declared) continue;
    if (actualSha256 !== declared.sha256) {
      mismatches.push({ path: entry.path, kind: "blob", expected: declared.sha256, actual: actualSha256 });
    }
    if (actualBlobOid !== declared.gitBlobOid) {
      mismatches.push({ path: entry.path, kind: "gitBlobOid", expected: declared.gitBlobOid, actual: actualBlobOid });
    }
    if (observedMode !== declared.gitMode) {
      mismatches.push({ path: entry.path, kind: "gitMode", expected: declared.gitMode, actual: observedMode });
    }
  }
  if (actualTreeComplete) {
    let actualTreeSha = null;
    try {
      actualTreeSha = gitTreeObjectId(actualTreeEntries);
    } catch (error) {
      mismatches.push({ path: RELEASE_MANIFEST_FILENAME, kind: "sourceTree", expected: manifest.sourceTreeSha, actual: error.message });
    }
    if (actualTreeSha && actualTreeSha !== manifest.sourceTreeSha) {
      mismatches.push({ path: RELEASE_MANIFEST_FILENAME, kind: "sourceTree", expected: manifest.sourceTreeSha, actual: actualTreeSha });
    }
  }

  for (const [name, servicePath] of Object.entries(SERVICE_TREES)) {
    const service = manifest.services?.[name];
    if (!exactObject(service, RELEASE_SERVICE_KEYS) || service.path !== servicePath) continue;
    const actual = subtreeSha256(files, servicePath);
    if (actual !== service.treeSha256) {
      mismatches.push({ path: servicePath, kind: "serviceTree", service: name, expected: service.treeSha256, actual });
    }
  }
  if (manifest.runtimeCutoverAllowed !== false) {
    mismatches.push({ path: RELEASE_MANIFEST_FILENAME, kind: "runtimeCutoverAllowed", expected: false, actual: manifest.runtimeCutoverAllowed });
  }
  return { ok: mismatches.length === 0, mismatches };
}
