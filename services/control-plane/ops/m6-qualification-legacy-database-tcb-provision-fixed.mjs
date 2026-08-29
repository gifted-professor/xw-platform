#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyReleaseManifest } from "../../../packages/release/lib/release-manifest.mjs";
import { canonicalJson, sha256 } from "../control-plane/lib/canonical.mjs";
import {
  buildSystemTcbAclPlan,
  createSystemTcbAclController,
} from "../control-plane/lib/windows-system-tcb-acl.mjs";

export const M64_QUALIFICATION_LEGACY_DATABASE_TCB_RUNTIME_ROOT =
  "C:\\Users\\Public\\xw-runtime";
export const M64_QUALIFICATION_LEGACY_DATABASE_TCB_SELF_RELEASE_PATH =
  "services/control-plane/ops/m6-qualification-legacy-database-tcb-provision-fixed.mjs";

const RELEASE_MANIFEST_SCHEMA_ID = "xw.runtime.release-manifest.v1";
const RECEIPT_SCHEMA_ID = "xw.runtime.m6-qualification-legacy-database-tcb-fixed-provision.v1";
const HASH = /^(?!0{64}$)[0-9a-f]{64}$/u;
const COMMIT = /^(?!0{40}$)[0-9a-f]{40}$/u;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/u;
const DATABASE_TARGETS = Object.freeze([
  Object.freeze({
    key: "controlDb",
    parentKey: "controlState",
    segments: Object.freeze(["state", "control-plane", "control.db"]),
  }),
  Object.freeze({
    key: "registryDb",
    parentKey: "registryState",
    segments: Object.freeze(["state", "orchestrator", "registry.db"]),
  }),
]);
const SIDECAR_SUFFIXES = Object.freeze([
  Object.freeze({ keySuffix: "Wal", suffix: "-wal" }),
  Object.freeze({ keySuffix: "Shm", suffix: "-shm" }),
]);
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024 * 1024;

function fail(code, message, causeCode = null) {
  throw Object.assign(new Error(`${code}: ${message}`), {
    code,
    ...(causeCode === null ? {} : { causeCode }),
  });
}

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function withinOrSame(root, candidate) {
  const value = relative(resolve(root), resolve(candidate));
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function plainBytes(path, code, label, maxBytes = 64 * 1024 * 1024) {
  let stat;
  try { stat = lstatSync(path); }
  catch { fail(code, `${label} is unavailable`); }
  if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink ?? 1) !== 1
    || stat.size < 1 || stat.size > maxBytes) {
    fail(code, `${label} is not one bounded plain file`);
  }
  return readFileSync(path);
}

function plainDirectory(path, code, label) {
  let stat;
  try { stat = lstatSync(path); }
  catch { fail(code, `${label} is unavailable`); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(path), path)) {
    fail(code, `${label} is not one plain directory`);
  }
  return resolve(path);
}

function verifyManifestSnapshot({ releaseRoot, releasesRoot, verifyManifest, code, label }) {
  const root = plainDirectory(releaseRoot, code, `${label} root`);
  const store = plainDirectory(releasesRoot, code, "fixed formal release store");
  if (basename(store).toLowerCase() !== "releases" || !samePath(dirname(root), store)) {
    fail(code, `${label} is not one direct formal release slot`);
  }
  const manifestPath = join(root, "release-manifest.v1.json");
  const bytes = plainBytes(manifestPath, code, `${label} manifest`);
  let manifest;
  try { manifest = JSON.parse(bytes.toString("utf8")); }
  catch { fail(code, `${label} manifest is malformed`); }
  if (manifest?.schemaId !== RELEASE_MANIFEST_SCHEMA_ID
    || !RELEASE_ID.test(manifest.releaseId ?? "")
    || !COMMIT.test(manifest.sourceCommit ?? "")
    || !COMMIT.test(manifest.sourceTreeSha ?? "")
    || manifest.releaseId !== basename(root)
    || !Array.isArray(manifest.files)) {
    fail(code, `${label} manifest identity is invalid`);
  }
  let verified;
  try { verified = verifyManifest({ manifestPath, root }); }
  catch { fail(code, `${label} manifest/tree verification failed`); }
  if (verified?.ok !== true) fail(code, `${label} manifest/tree verification failed`);
  return Object.freeze({
    root,
    releaseId: manifest.releaseId,
    sourceCommit: manifest.sourceCommit,
    sourceTreeSha: manifest.sourceTreeSha,
    manifestSha256: sha256(bytes),
    fileCount: manifest.files.length,
    manifest,
  });
}

function assertSameReleaseSnapshot(before, after, code) {
  if (!samePath(before.root, after.root)
    || before.releaseId !== after.releaseId
    || before.sourceCommit !== after.sourceCommit
    || before.sourceTreeSha !== after.sourceTreeSha
    || before.manifestSha256 !== after.manifestSha256
    || before.fileCount !== after.fileCount) {
    fail(code, "legacy current manifest identity changed during database TCB provisioning");
  }
}

function resolveCurrentTarget(runtimeRoot, code) {
  const currentPath = join(runtimeRoot, "current");
  let stat;
  try { stat = lstatSync(currentPath); }
  catch { fail(code, "current junction is absent"); }
  if (!stat.isSymbolicLink()) fail(code, "current must be one release junction");
  let target;
  try { target = realpathSync(currentPath); }
  catch { fail(code, "current junction cannot be resolved"); }
  const releasesRoot = join(runtimeRoot, "releases");
  if (!withinOrSame(releasesRoot, target) || !samePath(dirname(target), releasesRoot)) {
    fail(code, "current escaped the direct formal release store");
  }
  return Object.freeze({ currentPath, target: resolve(target) });
}

function assertCurrentTarget(runtimeRoot, expectedTarget) {
  const observed = resolveCurrentTarget(
    runtimeRoot,
    "M64_QUALIFICATION_LEGACY_DATABASE_TCB_CURRENT_DRIFT",
  );
  if (!samePath(observed.target, expectedTarget)) {
    fail(
      "M64_QUALIFICATION_LEGACY_DATABASE_TCB_CURRENT_DRIFT",
      "current changed during legacy database TCB provisioning",
    );
  }
}

function fileIdentity(stat) {
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    birthtimeNs: String(stat.birthtimeNs),
  });
}

function sameFileIdentity(left, right) {
  return left.device === right.device
    && left.inode === right.inode
    && left.birthtimeNs === right.birthtimeNs;
}

function inspectOpenFile(path, key, { requireNonEmpty = true } = {}) {
  const code = "M64_QUALIFICATION_LEGACY_DATABASE_TCB_TARGET_INVALID";
  let pathStat;
  try { pathStat = lstatSync(path, { bigint: true }); }
  catch { fail(code, `${key} is unavailable`); }
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1n
    || (requireNonEmpty && pathStat.size < 1n) || pathStat.size > BigInt(MAX_SNAPSHOT_BYTES)
    || !samePath(realpathSync(path), path)) {
    fail(code, `${key} is not one bounded plain file`);
  }
  let fd;
  try { fd = openSync(path, "r"); }
  catch { fail(code, `${key} could not be opened read-only`); }
  try {
    const openStat = fstatSync(fd, { bigint: true });
    if (!openStat.isFile() || openStat.nlink !== 1n
      || !sameFileIdentity(fileIdentity(pathStat), fileIdentity(openStat))) {
      fail(code, `${key} changed while its read-only handle was opened`);
    }
    return Object.freeze({ fd, key, path: resolve(path), identity: fileIdentity(openStat) });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function assertOpenDatabaseIdentity(handle) {
  const code = "M64_QUALIFICATION_LEGACY_DATABASE_TCB_TARGET_DRIFT";
  let pathStat;
  let openStat;
  try {
    pathStat = lstatSync(handle.path, { bigint: true });
    openStat = fstatSync(handle.fd, { bigint: true });
  } catch { fail(code, `${handle.key} disappeared during TCB provisioning`); }
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1n
    || !openStat.isFile() || openStat.nlink !== 1n
    || !samePath(realpathSync(handle.path), handle.path)
    || !sameFileIdentity(handle.identity, fileIdentity(pathStat))
    || !sameFileIdentity(handle.identity, fileIdentity(openStat))) {
    fail(code, `${handle.key} file identity changed during TCB provisioning`);
  }
}

function contentSnapshot(handle, { requireSqliteHeader = false } = {}) {
  const code = "M64_QUALIFICATION_LEGACY_DATABASE_TCB_CONTENT_DRIFT";
  assertOpenDatabaseIdentity(handle);
  const before = fstatSync(handle.fd, { bigint: true });
  if (before.size < 0n || before.size > BigInt(MAX_SNAPSHOT_BYTES)) {
    fail(code, `${handle.key} exceeds the bounded snapshot size`);
  }
  const size = Number(before.size);
  const digest = createHash("sha256");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  const header = Buffer.alloc(16);
  let headerLength = 0;
  let position = 0;
  while (position < size) {
    const length = Math.min(chunk.length, size - position);
    let bytesRead;
    try { bytesRead = readSync(handle.fd, chunk, 0, length, position); }
    catch { fail(code, `${handle.key} could not be hashed through its read-only handle`); }
    if (bytesRead < 1) fail(code, `${handle.key} ended during its content snapshot`);
    if (headerLength < header.length) {
      const copyLength = Math.min(bytesRead, header.length - headerLength);
      chunk.copy(header, headerLength, 0, copyLength);
      headerLength += copyLength;
    }
    digest.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  const after = fstatSync(handle.fd, { bigint: true });
  const beforeIdentity = fileIdentity(before);
  const afterIdentity = fileIdentity(after);
  if (!sameFileIdentity(handle.identity, beforeIdentity)
    || !sameFileIdentity(beforeIdentity, afterIdentity)
    || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
    fail(code, `${handle.key} changed while its content snapshot was read`);
  }
  if (requireSqliteHeader
    && (headerLength !== header.length || !header.equals(Buffer.from("SQLite format 3\0", "binary")))) {
    fail(code, `${handle.key} is not a SQLite database`);
  }
  return Object.freeze({
    identity: beforeIdentity,
    size: String(before.size),
    mtimeNs: String(before.mtimeNs),
    sha256: digest.digest("hex"),
  });
}

function inspectOptionalSidecar(path, key) {
  try { lstatSync(path); }
  catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ key, path: resolve(path), present: false });
    fail("M64_QUALIFICATION_LEGACY_DATABASE_TCB_TARGET_INVALID", `${key} state is unavailable`);
  }
  const handle = inspectOpenFile(path, key, { requireNonEmpty: false });
  try {
    return Object.freeze({
      key,
      path: handle.path,
      present: true,
      handle,
      snapshot: contentSnapshot(handle),
    });
  } catch (error) {
    try { closeSync(handle.fd); } catch {}
    throw error;
  }
}

function assertFileState(state) {
  const code = "M64_QUALIFICATION_LEGACY_DATABASE_TCB_CONTENT_DRIFT";
  if (state.present === false) {
    try { lstatSync(state.path); }
    catch (error) {
      if (error?.code === "ENOENT") return;
      fail(code, `${state.key} state became unreadable`);
    }
    fail(code, `${state.key} appeared during TCB provisioning`);
  }
  const observed = contentSnapshot(state.handle, {
    requireSqliteHeader: state.key === "controlDb" || state.key === "registryDb",
  });
  if (!sameFileIdentity(state.snapshot.identity, observed.identity)
    || state.snapshot.size !== observed.size
    || state.snapshot.mtimeNs !== observed.mtimeNs
    || state.snapshot.sha256 !== observed.sha256) {
    fail(code, `${state.key} bytes or identity changed during TCB provisioning`);
  }
}

function assertFileStates(states) {
  for (const state of states) assertFileState(state);
}

export function parseM64QualificationLegacyDatabaseTcbProvisionFixedArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    fail(
      "M64_QUALIFICATION_LEGACY_DATABASE_TCB_CLI_INVALID",
      "fixed legacy-database TCB provision accepts no paths, roots, identities, or options",
    );
  }
  return Object.freeze({ provision: true });
}

export function resolveM64QualificationLegacyDatabaseTcbExecutingRelease({
  runtimeRoot = M64_QUALIFICATION_LEGACY_DATABASE_TCB_RUNTIME_ROOT,
  operatorPath = fileURLToPath(import.meta.url),
  verifyManifest = verifyReleaseManifest,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const code = "M64_QUALIFICATION_LEGACY_DATABASE_TCB_EXECUTING_RELEASE_INVALID";
  const runtime = resolve(runtimeRoot);
  const releasesRoot = join(runtime, "releases");
  const executingPath = resolve(operatorPath);
  if (!withinOrSame(releasesRoot, executingPath)) {
    fail(code, "executing provisioner escaped the fixed release store");
  }
  const parts = relative(releasesRoot, executingPath).split(/[\\/]/u);
  const releaseId = parts.shift();
  if (!RELEASE_ID.test(releaseId ?? "")
    || parts.join("/") !== M64_QUALIFICATION_LEGACY_DATABASE_TCB_SELF_RELEASE_PATH) {
    fail(code, "executing provisioner is not in one exact formal release slot");
  }
  const release = verifyManifestSnapshot({
    releaseRoot: join(releasesRoot, releaseId),
    releasesRoot,
    verifyManifest,
    code,
    label: "executing formal release",
  });
  const selfPath = join(release.root, ...M64_QUALIFICATION_LEGACY_DATABASE_TCB_SELF_RELEASE_PATH.split("/"));
  const matches = release.manifest.files.filter(
    (entry) => entry?.path === M64_QUALIFICATION_LEGACY_DATABASE_TCB_SELF_RELEASE_PATH,
  );
  if (!samePath(selfPath, executingPath) || matches.length !== 1
    || !HASH.test(matches[0].sha256 ?? "")
    || sha256(plainBytes(selfPath, code, "tracked fixed provisioner")) !== matches[0].sha256) {
    fail(code, "executing provisioner differs from its formal release manifest");
  }
  const plan = buildSystemTcbAclPlan({
    boundaryPath: runtime,
    targetPath: release.root,
    recursive: true,
  });
  try { tcbAclController.verify(plan); }
  catch (error) {
    fail(code, "executing formal release TCB verification failed", error?.code ?? null);
  }
  return Object.freeze({ ...release, runtimeRoot: runtime });
}

export function provisionM64QualificationLegacyDatabaseTcbFixed({
  runtimeRoot = M64_QUALIFICATION_LEGACY_DATABASE_TCB_RUNTIME_ROOT,
  operatorPath = fileURLToPath(import.meta.url),
  verifyManifest = verifyReleaseManifest,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const executing = resolveM64QualificationLegacyDatabaseTcbExecutingRelease({
    runtimeRoot,
    operatorPath,
    verifyManifest,
    tcbAclController,
  });
  const runtime = executing.runtimeRoot;
  const current = resolveCurrentTarget(runtime, "M64_QUALIFICATION_LEGACY_DATABASE_TCB_CURRENT_INVALID");
  if (samePath(current.target, executing.root)) {
    fail(
      "M64_QUALIFICATION_LEGACY_DATABASE_TCB_CURRENT_INVALID",
      "legacy current must differ from the executing successor release",
    );
  }
  const before = verifyManifestSnapshot({
    releaseRoot: current.target,
    releasesRoot: join(runtime, "releases"),
    verifyManifest,
    code: "M64_QUALIFICATION_LEGACY_DATABASE_TCB_CURRENT_INVALID",
    label: "legacy current release",
  });
  const currentPlan = buildSystemTcbAclPlan({
    boundaryPath: runtime,
    targetPath: before.root,
    recursive: true,
  });
  try { tcbAclController.verify(currentPlan); }
  catch (error) {
    fail(
      "M64_QUALIFICATION_LEGACY_DATABASE_TCB_CURRENT_INVALID",
      "legacy current release TCB verification failed",
      error?.code ?? null,
    );
  }

  if (typeof tcbAclController.verify !== "function"
    || typeof tcbAclController.protect !== "function"
    || typeof tcbAclController.verifyTarget !== "function"
    || typeof tcbAclController.protectTarget !== "function") {
    fail(
      "M64_QUALIFICATION_LEGACY_DATABASE_TCB_CONTROLLER_INVALID",
      "fixed database TCB controller lacks the required closure and target-only operations",
    );
  }

  const handles = [];
  try {
    const fileStates = [];
    const rows = [];
    for (const target of DATABASE_TARGETS) {
      const handle = inspectOpenFile(join(runtime, ...target.segments), target.key);
      handles.push(handle);
      fileStates.push(Object.freeze({
        key: target.key,
        path: handle.path,
        present: true,
        handle,
        snapshot: contentSnapshot(handle, { requireSqliteHeader: true }),
      }));
      for (const sidecar of SIDECAR_SUFFIXES) {
        const state = inspectOptionalSidecar(`${handle.path}${sidecar.suffix}`, `${target.key}${sidecar.keySuffix}`);
        fileStates.push(state);
        if (state.present) handles.push(state.handle);
      }
      const parentPlan = buildSystemTcbAclPlan({
        boundaryPath: runtime,
        targetPath: dirname(handle.path),
        recursive: false,
      });
      const targetPlan = buildSystemTcbAclPlan({
        boundaryPath: runtime,
        targetPath: handle.path,
        recursive: false,
      });
      rows.push({ handle, parentKey: target.parentKey, parentPlan, targetPlan });
    }

    const directoryRows = [];
    for (const row of rows) {
      let normalize = false;
      try { tcbAclController.verify(row.parentPlan); }
      catch (error) {
        if (error?.code !== "SYSTEM_TCB_ACL_TARGET_DACL_INVALID") {
          fail(
            "M64_QUALIFICATION_LEGACY_DATABASE_TCB_VERIFICATION_FAILED",
            `${row.parentKey} closure failed outside the exact migration condition`,
            error?.code ?? null,
          );
        }
        normalize = true;
      }
      directoryRows.push({ key: row.parentKey, plan: row.parentPlan, normalize });
    }
    for (const row of rows) {
      let normalize = false;
      try { tcbAclController.verifyTarget(row.targetPlan); }
      catch (error) {
        if (error?.code !== "SYSTEM_TCB_ACL_TARGET_DACL_INVALID") {
          fail(
            "M64_QUALIFICATION_LEGACY_DATABASE_TCB_VERIFICATION_FAILED",
            `${row.handle.key} failed outside the exact target migration condition`,
            error?.code ?? null,
          );
        }
        normalize = true;
      }
      row.normalize = normalize;
    }

    assertCurrentTarget(runtime, before.root);
    assertFileStates(fileStates);
    for (const row of directoryRows.filter((candidate) => candidate.normalize)) {
      assertCurrentTarget(runtime, before.root);
      assertFileStates(fileStates);
      try { tcbAclController.protect(row.plan); }
      catch (error) {
        fail(
          "M64_QUALIFICATION_LEGACY_DATABASE_TCB_PROTECTION_FAILED",
          `${row.key} closure protection failed closed`,
          error?.code ?? null,
        );
      }
      assertCurrentTarget(runtime, before.root);
      assertFileStates(fileStates);
    }

    const verifiedDirectories = [];
    for (const row of directoryRows) {
      let receipt;
      try { receipt = tcbAclController.verify(row.plan); }
      catch (error) {
        fail(
          "M64_QUALIFICATION_LEGACY_DATABASE_TCB_VERIFICATION_FAILED",
          `${row.key} closure did not verify after provisioning`,
          error?.code ?? null,
        );
      }
      if (!Number.isSafeInteger(receipt?.entryCount) || receipt.entryCount < 1) {
        fail(
          "M64_QUALIFICATION_LEGACY_DATABASE_TCB_RECEIPT_INVALID",
          `${row.key} native verification receipt is invalid`,
        );
      }
      verifiedDirectories.push(Object.freeze({
        key: row.key,
        status: "VERIFIED",
        normalized: row.normalize,
        entryCount: receipt.entryCount,
      }));
    }

    for (const row of rows.filter((candidate) => candidate.normalize)) {
      assertCurrentTarget(runtime, before.root);
      assertFileStates(fileStates);
      try { tcbAclController.verify(row.parentPlan); }
      catch (error) {
        fail(
          "M64_QUALIFICATION_LEGACY_DATABASE_TCB_VERIFICATION_FAILED",
          `${row.parentKey} closure drifted before target protection`,
          error?.code ?? null,
        );
      }
      try { tcbAclController.protectTarget(row.targetPlan); }
      catch (error) {
        fail(
          "M64_QUALIFICATION_LEGACY_DATABASE_TCB_PROTECTION_FAILED",
          `${row.handle.key} target-only TCB protection failed closed`,
          error?.code ?? null,
        );
      }
      assertCurrentTarget(runtime, before.root);
      assertFileStates(fileStates);
    }

    const verifiedRows = [];
    for (const row of rows) {
      assertFileStates(fileStates);
      let receipt;
      try { receipt = tcbAclController.verify(row.targetPlan); }
      catch (error) {
        fail(
          "M64_QUALIFICATION_LEGACY_DATABASE_TCB_VERIFICATION_FAILED",
          `${row.handle.key} did not verify after provisioning`,
          error?.code ?? null,
        );
      }
      if (!Number.isSafeInteger(receipt?.entryCount) || receipt.entryCount < 1) {
        fail(
          "M64_QUALIFICATION_LEGACY_DATABASE_TCB_RECEIPT_INVALID",
          `${row.handle.key} native verification receipt is invalid`,
        );
      }
      verifiedRows.push(Object.freeze({
        key: row.handle.key,
        status: "VERIFIED",
        normalized: row.normalize,
        entryCount: receipt.entryCount,
      }));
    }

    const after = verifyManifestSnapshot({
      releaseRoot: before.root,
      releasesRoot: join(runtime, "releases"),
      verifyManifest,
      code: "M64_QUALIFICATION_LEGACY_DATABASE_TCB_POSTVERIFY_FAILED",
      label: "post-provision legacy current release",
    });
    assertSameReleaseSnapshot(before, after, "M64_QUALIFICATION_LEGACY_DATABASE_TCB_POSTVERIFY_FAILED");
    assertCurrentTarget(runtime, before.root);
    assertFileStates(fileStates);

    const body = Object.freeze({
      schemaId: RECEIPT_SCHEMA_ID,
      status: "VERIFIED",
      operatorReleaseId: executing.releaseId,
      operatorSourceCommit: executing.sourceCommit,
      legacyReleaseId: after.releaseId,
      legacySourceCommit: after.sourceCommit,
      legacySourceTreeSha: after.sourceTreeSha,
      legacyManifestSha256: after.manifestSha256,
      directoryClosureCount: verifiedDirectories.length,
      normalizedDirectoryClosureCount: verifiedDirectories.filter((row) => row.normalized).length,
      directoryClosures: Object.freeze(verifiedDirectories),
      databaseCount: verifiedRows.length,
      normalizedCount: verifiedRows.filter((row) => row.normalized).length,
      databases: Object.freeze(verifiedRows),
    });
    return Object.freeze({
      ...body,
      receiptHash: sha256(`${RECEIPT_SCHEMA_ID}:${canonicalJson(body)}`),
    });
  } finally {
    for (const handle of handles.reverse()) {
      try { closeSync(handle.fd); } catch {}
    }
  }
}

export function main(argv = process.argv.slice(2), {
  stdout = process.stdout,
  dependencies = {},
} = {}) {
  parseM64QualificationLegacyDatabaseTcbProvisionFixedArgs(argv);
  const result = provisionM64QualificationLegacyDatabaseTcbFixed(dependencies);
  stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : null;
if (entry === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    process.stderr.write(
      `${error?.code ?? "M64_QUALIFICATION_LEGACY_DATABASE_TCB_FAILED"}: fixed legacy-database TCB provision failed\n`,
    );
    process.exitCode = 1;
  }
}
