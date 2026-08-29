import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSystemTcbAclPlan,
  createSystemTcbAclController,
} from "../control-plane/lib/windows-system-tcb-acl.mjs";

export const FORMAL_RELEASE_MANIFEST_SCHEMA_ID = "xw.runtime.release-manifest.v1";
export const FORMAL_RELEASE_SOURCE_REPO = "gifted-professor/xw-platform";
export const FORMAL_RELEASE_REQUIRED_ANCESTOR = "5dab77f";
export const FORMAL_RELEASE_ID_PREFIX = "xw-xhs-v3-r03";
export const FORMAL_RUNTIME_ROOT = "C:\\Users\\Public\\xw-runtime";

const HEX40 = /^(?!0{40}$)[0-9a-f]{40}$/u;
const REGULAR_MODES = new Set(["100644", "100755"]);
const REQUIRED_RELEASE_PATHS = Object.freeze([
  "config/runtime/xw-runtime.v1.json",
  "package.json",
  "services/control-plane/control-plane/lib/xhs-v3-fixed-operator-auth.mjs",
  "services/control-plane/control-plane/lib/m6-qualification-tcb.mjs",
  "services/control-plane/control-plane/lib/windows-xhs-blind-review-acl.mjs",
  "services/control-plane/ops/gate-f-cutover-operator.mjs",
  "services/control-plane/ops/m6-qualification-legacy-current-tcb-provision-fixed.mjs",
  "services/control-plane/ops/m6-qualification-legacy-database-tcb-provision-fixed.mjs",
  "services/control-plane/ops/m6-qualification-legacy-window-operator.mjs",
  "services/control-plane/ops/m6-qualification-launcher-operator.mjs",
  "services/control-plane/ops/m6-qualification-tcb-provision-fixed.mjs",
  "services/control-plane/ops/m6-strict-fixed-qualification-operator.mjs",
  "services/control-plane/ops/m6-strict-fixed-assembler-bridge.mjs",
  "services/control-plane/ops/provision-control-plane-secrets-fixed.mjs",
  "services/control-plane/ops/provision-control-plane-secrets.ps1",
  "services/control-plane/ops/xhs-v3-production-operator.mjs",
  "services/control-plane/ops/xhs-v3-blind-review-submit.mjs",
  "services/control-plane/ops/launch-control-plane.ps1",
  "services/control-plane/scripts/xw-control-plane-runtime.ps1",
]);

function fail(code, message) {
  throw Object.assign(new Error(`${code}: ${message}`), { code });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitBlobOid(bytes) {
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, "utf8"), bytes]))
    .digest("hex");
}

function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function pathKey(value) {
  const full = resolve(value);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function within(root, candidate) {
  const value = relative(resolve(root), resolve(candidate));
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function validReleasePath(value) {
  if (typeof value !== "string" || value === "" || value.length > 1024 || value.includes("\0")
    || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/u.test(value)
    || /[\x00-\x1f\x7f]/u.test(value)) return false;
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  if (value.toLowerCase() === "release-manifest.v1.json"
    || parts.some((part) => [".git", "node_modules"].includes(part.toLowerCase()))) return false;
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
  return !parts.some((part) => /[<>:"|?*]/u.test(part) || /[. ]$/u.test(part) || reserved.test(part));
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function git(repoRoot, args, { encoding = "utf8", maxBuffer = 64 * 1024 * 1024 } = {}) {
  try {
    return execFileSync("git.exe", ["-C", repoRoot, ...args], {
      encoding,
      maxBuffer,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    fail("FORMAL_RELEASE_GIT_FAILED", String(error?.stderr || error?.message || "git failed").trim());
  }
}

function readGitBlobs(repoRoot, entries) {
  let output;
  try {
    output = execFileSync("git.exe", ["-C", repoRoot, "cat-file", "--batch"], {
      input: Buffer.from(`${entries.map((entry) => entry.gitBlobOid).join("\n")}\n`, "utf8"),
      encoding: null,
      maxBuffer: 512 * 1024 * 1024,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    fail("FORMAL_RELEASE_GIT_FAILED", String(error?.stderr || error?.message || "git cat-file failed").trim());
  }
  const blobs = [];
  let offset = 0;
  for (const entry of entries) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) fail("FORMAL_RELEASE_BLOB_BATCH_INVALID", "missing blob header");
    const header = output.subarray(offset, newline).toString("utf8");
    const match = /^([0-9a-f]{40}) blob ([0-9]+)$/u.exec(header);
    if (!match || match[1] !== entry.gitBlobOid) {
      fail("FORMAL_RELEASE_BLOB_BATCH_INVALID", `unexpected blob header for ${entry.path}`);
    }
    const size = Number(match[2]);
    const start = newline + 1;
    const end = start + size;
    if (!Number.isSafeInteger(size) || size < 0 || end >= output.length || output[end] !== 0x0a) {
      fail("FORMAL_RELEASE_BLOB_BATCH_INVALID", `invalid blob length for ${entry.path}`);
    }
    const bytes = Buffer.from(output.subarray(start, end));
    if (gitBlobOid(bytes) !== entry.gitBlobOid) {
      fail("FORMAL_RELEASE_BLOB_BATCH_INVALID", `blob hash drift for ${entry.path}`);
    }
    blobs.push(bytes);
    offset = end + 1;
  }
  if (offset !== output.length) fail("FORMAL_RELEASE_BLOB_BATCH_INVALID", "unexpected trailing batch output");
  return blobs;
}

function materializeGitTree(repoRoot, payloadRoot, entries) {
  const blobs = readGitBlobs(repoRoot, entries);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const target = join(payloadRoot, ...entry.path.split("/"));
    if (!within(payloadRoot, target)) fail("FORMAL_RELEASE_PATH_ESCAPE", entry.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, blobs[index], {
      flag: "wx",
      mode: entry.gitMode === "100755" ? 0o755 : 0o644,
    });
    if (process.platform !== "win32") chmodSync(target, entry.gitMode === "100755" ? 0o755 : 0o644);
  }
}

export function parseGitTree(bytes) {
  if (!Buffer.isBuffer(bytes)) fail("FORMAL_RELEASE_TREE_INVALID", "git tree output must be bytes");
  const entries = [];
  const seen = new Set();
  for (const record of bytes.toString("utf8").split("\0")) {
    if (!record) continue;
    const match = /^(\d{6}) ([a-z]+) ([0-9a-f]{40})\t([^\r\n]+)$/u.exec(record);
    if (!match) fail("FORMAL_RELEASE_TREE_INVALID", "git tree record is malformed");
    const [, gitMode, type, gitBlobOidValue, path] = match;
    const caseKey = process.platform === "win32" ? path.toLowerCase() : path;
    if (type !== "blob" || !REGULAR_MODES.has(gitMode) || !validReleasePath(path)
      || seen.has(caseKey)) {
      fail("FORMAL_RELEASE_TREE_INVALID", `unsupported, unsafe, or duplicate release entry: ${path}`);
    }
    seen.add(caseKey);
    entries.push({ path, gitMode, gitBlobOid: gitBlobOidValue });
  }
  entries.sort((left, right) => compareUtf8(left.path, right.path));
  if (entries.length === 0) fail("FORMAL_RELEASE_TREE_INVALID", "git tree is empty");
  return entries;
}

function serviceTreeSha(files, prefix) {
  const digest = createHash("sha256");
  for (const entry of files) {
    if (entry.path.startsWith(`${prefix}/`)) digest.update(`${entry.path}:${entry.sha256}\n`, "utf8");
  }
  return digest.digest("hex");
}

export function materializeReleaseManifest({
  payloadRoot,
  releaseId,
  sourceCommit,
  sourceTreeSha,
  treeEntries,
  nodeVersion = process.versions.node,
} = {}) {
  if (typeof payloadRoot !== "string" || !isAbsolute(payloadRoot)
    || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(releaseId || "")
    || !HEX40.test(sourceCommit || "") || !HEX40.test(sourceTreeSha || "")
    || !Array.isArray(treeEntries) || treeEntries.length === 0) {
    fail("FORMAL_RELEASE_INPUT_INVALID", "release root, identity, tree, and entries are required");
  }
  const root = resolve(payloadRoot);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || basename(root) !== releaseId) {
    fail("FORMAL_RELEASE_ROOT_INVALID", "payload root must be a plain release-id directory");
  }
  const files = [];
  for (const entry of treeEntries) {
    if (!validReleasePath(entry?.path) || !REGULAR_MODES.has(entry?.gitMode)
      || !HEX40.test(entry?.gitBlobOid || "")) {
      fail("FORMAL_RELEASE_TREE_INVALID", "tree entry is invalid");
    }
    const target = join(root, ...entry.path.split("/"));
    if (!within(root, target)) fail("FORMAL_RELEASE_PATH_ESCAPE", entry.path);
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || !samePath(realpathSync(target), target)) {
      fail("FORMAL_RELEASE_FILE_INVALID", entry.path);
    }
    const bytes = readFileSync(target);
    const actualBlob = gitBlobOid(bytes);
    if (actualBlob !== entry.gitBlobOid) {
      fail("FORMAL_RELEASE_BLOB_DRIFT", `${entry.path}:${entry.gitBlobOid}:${actualBlob}`);
    }
    files.push({
      path: entry.path,
      gitMode: entry.gitMode,
      gitBlobOid: entry.gitBlobOid,
      sha256: sha256(bytes),
    });
  }
  for (const requiredPath of REQUIRED_RELEASE_PATHS) {
    if (!files.some((entry) => entry.path === requiredPath)) {
      fail("FORMAL_RELEASE_REQUIRED_ARTIFACT_MISSING", requiredPath);
    }
  }
  const manifest = {
    schemaId: FORMAL_RELEASE_MANIFEST_SCHEMA_ID,
    releaseId,
    sourceRepo: FORMAL_RELEASE_SOURCE_REPO,
    sourceCommit,
    sourceTreeSha,
    runtimeProfile: "legacy_compat",
    nodeVersion,
    npmVersion: null,
    services: {
      orchestrator: {
        path: "services/orchestrator",
        treeSha256: serviceTreeSha(files, "services/orchestrator"),
      },
      controlPlane: {
        path: "services/control-plane",
        treeSha256: serviceTreeSha(files, "services/control-plane"),
      },
    },
    files,
    runtimeCutoverAllowed: false,
  };
  const bytes = canonicalJsonBytes(manifest);
  const manifestPath = join(root, "release-manifest.v1.json");
  writeFileSync(manifestPath, bytes, { flag: "wx", mode: 0o644 });
  return Object.freeze({
    manifest: Object.freeze(manifest),
    manifestPath,
    manifestSha256: sha256(bytes),
  });
}

export function buildFormalRelease({
  repoRoot,
  runtimeRoot = FORMAL_RUNTIME_ROOT,
  requiredAncestor = FORMAL_RELEASE_REQUIRED_ANCESTOR,
  releaseIdPrefix = FORMAL_RELEASE_ID_PREFIX,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const repo = resolve(repoRoot || fileURLToPath(new URL("../../..", import.meta.url)));
  const runtime = resolve(runtimeRoot);
  if (!isAbsolute(runtime) || !existsSync(join(repo, "package.json"))) {
    fail("FORMAL_RELEASE_INPUT_INVALID", "repository and absolute runtime roots are required");
  }
  if (typeof tcbAclController?.protect !== "function" || typeof tcbAclController?.verify !== "function") {
    fail("FORMAL_RELEASE_TCB_CONTROLLER_INVALID", "SYSTEM TCB ACL protect/verify controller is required");
  }
  const sourceCommit = String(git(repo, ["rev-parse", "HEAD"])).trim();
  const sourceTreeSha = String(git(repo, ["rev-parse", `${sourceCommit}^{tree}`])).trim();
  if (!HEX40.test(sourceCommit) || !HEX40.test(sourceTreeSha)) {
    fail("FORMAL_RELEASE_SOURCE_INVALID", "HEAD commit/tree identity is invalid");
  }
  const dirty = String(git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]));
  if (dirty !== "") fail("FORMAL_RELEASE_WORKTREE_DIRTY", "release build requires a clean exact HEAD");
  git(repo, ["merge-base", "--is-ancestor", requiredAncestor, sourceCommit]);

  const treeEntries = parseGitTree(git(repo, ["ls-tree", "-rz", "--full-tree", sourceCommit], { encoding: null }));
  const releaseId = `${releaseIdPrefix}-${sourceCommit.slice(0, 12)}`;
  if (!/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(releaseId)) {
    fail("FORMAL_RELEASE_ID_INVALID", "derived release id is invalid");
  }
  if (!existsSync(runtime)) {
    fail("FORMAL_RELEASE_TCB_ROOT_UNPROVISIONED", "runtime root must exist before a formal release is built");
  }
  const protect = (targetPath, recursive = false) => tcbAclController.protect(buildSystemTcbAclPlan({
    boundaryPath: runtime,
    targetPath,
    recursive,
  }));
  const verify = (targetPath, recursive = false) => tcbAclController.verify(buildSystemTcbAclPlan({
    boundaryPath: runtime,
    targetPath,
    recursive,
  }));
  // Seal the trust boundary before creating any attacker-raceable child.  The
  // Windows controller also rejects a delete-capable ancestor (for example a
  // public profile root); that condition requires relocating/provisioning the
  // runtime TCB and is never papered over by content hashes.
  protect(runtime, false);
  const releasesRoot = join(runtime, "releases");
  const stagingRoot = join(runtime, "release-staging");
  if (!existsSync(releasesRoot)) mkdirSync(releasesRoot, { recursive: false });
  if (!existsSync(stagingRoot)) mkdirSync(stagingRoot, { recursive: false });
  protect(releasesRoot, false);
  protect(stagingRoot, false);
  const finalRoot = join(runtime, "releases", releaseId);
  if (existsSync(finalRoot)) fail("FORMAL_RELEASE_EXISTS", "refusing to overwrite an existing release");
  const staging = join(stagingRoot, `build-${sourceCommit.slice(0, 12)}-${randomUUID()}`);
  const payloadRoot = join(staging, releaseId);
  try {
    mkdirSync(staging, { recursive: false });
    protect(staging, false);
    mkdirSync(payloadRoot, { recursive: false });
    protect(payloadRoot, false);
    materializeGitTree(repo, payloadRoot, treeEntries);
    const sealed = materializeReleaseManifest({
      payloadRoot,
      releaseId,
      sourceCommit,
      sourceTreeSha,
      treeEntries,
    });
    // Every executable/import/config byte receives an explicit protected DACL
    // and a second structural/ACL verification before the atomic publish.
    protect(payloadRoot, true);
    verify(payloadRoot, true);
    renameSync(payloadRoot, finalRoot);
    verify(finalRoot, true);
    return Object.freeze({
      ok: true,
      schemaId: "xw.runtime.formal-release-build-receipt.v1",
      releaseId,
      sourceCommit,
      sourceTreeSha,
      manifestSha256: sealed.manifestSha256,
      fileCount: treeEntries.length,
      releaseRoot: finalRoot,
      tcbAcl: Object.freeze({ status: "verified", protectedDacl: process.platform === "win32" }),
    });
  } finally {
    if (within(stagingRoot, staging)) {
      rmSync(staging, { recursive: true, force: true });
    }
  }
}

function usage() {
  return "node services/control-plane/ops/formal-release-builder.mjs build";
}

function main(argv) {
  if (argv.length === 1 && argv[0] === "build") {
    const receipt = buildFormalRelease({});
    const { releaseRoot: _privatePath, ...publicReceipt } = receipt;
    process.stdout.write(`${JSON.stringify(publicReceipt, null, 2)}\n`);
    return;
  }
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  fail("FORMAL_RELEASE_ARGUMENT_INVALID", usage());
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error?.code || "FORMAL_RELEASE_BUILD_FAILED"}\n`);
    process.exitCode = 1;
  }
}
