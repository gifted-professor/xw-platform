// M3-R1 Release Foundation：不可变 release 的构建 / 物化 / 校验。
// 纯离线工具：只读 git 仓库、只写 outDir 指定目录；不 deploy、不 restart、不碰现场。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const RELEASE_MANIFEST_SCHEMA_ID = "xw.runtime.release-manifest.v1";
export const RELEASE_MANIFEST_FILENAME = "release-manifest.v1.json";
export const SOURCE_REPO = "gifted-professor/xw-platform";
export const DEFAULT_RUNTIME_PROFILE = "legacy_compat";
export const RUNTIME_CUTOVER_ALLOWED = false;

const SERVICE_TREES = Object.freeze({
  orchestrator: "services/orchestrator",
  controlPlane: "services/control-plane",
});

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

export function listTrackedFiles(root) {
  // git ls-files -z 以 NUL 分隔；其本身不含 .git 内部文件，再防御一次。
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  return out
    .split("\0")
    .filter((line) => line.length > 0)
    .filter((p) => !p.startsWith(".git/") && p !== ".git");
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function sha256File(path) {
  return sha256Buffer(readFileSync(path));
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
  const sourceCommit = git(root, ["rev-parse", "HEAD"]);
  const sourceTreeSha = git(root, ["rev-parse", "HEAD^{tree}"]);
  const files = listTrackedFiles(root)
    .sort()
    .map((path) => ({ path, sha256: sha256File(join(root, path)) }));
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
  const manifest = buildReleaseManifest({ root, releaseId });
  const releaseDir = join(outDir, "releases", manifest.releaseId);
  if (existsSync(releaseDir)) {
    throw new Error(`RELEASE_IMMUTABLE: ${releaseDir} already exists`);
  }
  mkdirSync(releaseDir, { recursive: true });
  for (const entry of manifest.files) {
    const target = join(releaseDir, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, entry.path), target);
  }
  writeFileSync(join(releaseDir, RELEASE_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function verifyReleaseManifest({ manifestPath, root } = {}) {
  if (!manifestPath || !root) throw new Error("RELEASE_VERIFY: manifestPath and root are required");
  const mismatches = [];
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schemaId !== RELEASE_MANIFEST_SCHEMA_ID) {
    mismatches.push({ path: manifestPath, kind: "schemaId", expected: RELEASE_MANIFEST_SCHEMA_ID, actual: manifest.schemaId ?? null });
    return { ok: false, mismatches };
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  for (const entry of files) {
    const target = join(root, entry.path);
    if (!existsSync(target)) {
      mismatches.push({ path: entry.path, kind: "missing", expected: entry.sha256, actual: null });
      continue;
    }
    const actual = sha256File(target);
    if (actual !== entry.sha256) {
      mismatches.push({ path: entry.path, kind: "blob", expected: entry.sha256, actual });
    }
  }
  for (const [name, service] of Object.entries(manifest.services || {})) {
    const actual = subtreeSha256(files, service.path);
    if (actual !== service.treeSha256) {
      mismatches.push({ path: service.path, kind: "serviceTree", service: name, expected: service.treeSha256, actual });
    }
  }
  if (manifest.runtimeCutoverAllowed !== false) {
    mismatches.push({ path: manifestPath, kind: "runtimeCutoverAllowed", expected: false, actual: manifest.runtimeCutoverAllowed });
  }
  return { ok: mismatches.length === 0, mismatches };
}
