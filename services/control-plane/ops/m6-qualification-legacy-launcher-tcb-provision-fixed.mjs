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

export const M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_RUNTIME_ROOT =
  "C:\\Users\\Public\\xw-runtime";
export const M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_SELF_RELEASE_PATH =
  "services/control-plane/ops/m6-qualification-legacy-launcher-tcb-provision-fixed.mjs";

const RELEASE_MANIFEST_SCHEMA_ID = "xw.runtime.release-manifest.v1";
const RECEIPT_SCHEMA_ID = "xw.runtime.m6-qualification-legacy-launcher-tcb-fixed-provision.v1";
const HASH = /^(?!0{64}$)[0-9a-f]{64}$/u;
const COMMIT = /^(?!0{40}$)[0-9a-f]{40}$/u;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/u;
const MAX_SCRIPT_BYTES = 16 * 1024 * 1024;
const ANCESTOR_CLOSURE_KEY = "runtimeBoundary";
const LAUNCHER_TARGETS = Object.freeze([
  Object.freeze({ key: "controlPlaneLauncher", filename: "launch-control-plane.simple.ps1" }),
  Object.freeze({ key: "orchestratorLauncher", filename: "launch-orchestrator.current-user.ps1" }),
]);

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

function assertSameReleaseSnapshot(before, after, code, label) {
  if (!samePath(before.root, after.root)
    || before.releaseId !== after.releaseId
    || before.sourceCommit !== after.sourceCommit
    || before.sourceTreeSha !== after.sourceTreeSha
    || before.manifestSha256 !== after.manifestSha256
    || before.fileCount !== after.fileCount) {
    fail(code, `${label} manifest identity changed during launcher TCB provisioning`);
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
    "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_CURRENT_DRIFT",
  );
  if (!samePath(observed.target, expectedTarget)) {
    fail(
      "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_CURRENT_DRIFT",
      "current changed during legacy launcher TCB provisioning",
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

function inspectOpenLauncher(path, key) {
  const code = "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_TARGET_INVALID";
  let pathStat;
  try { pathStat = lstatSync(path, { bigint: true }); }
  catch { fail(code, `${key} is unavailable`); }
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1n
    || pathStat.size < 1n || pathStat.size > BigInt(MAX_SCRIPT_BYTES)
    || !samePath(realpathSync(path), path)) {
    fail(code, `${key} is not one bounded plain launcher file`);
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
    try { closeSync(fd); } catch {}
    throw error;
  }
}

function assertOpenLauncherIdentity(handle) {
  const code = "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_TARGET_DRIFT";
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

function contentSnapshot(handle) {
  const code = "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_CONTENT_DRIFT";
  assertOpenLauncherIdentity(handle);
  const before = fstatSync(handle.fd, { bigint: true });
  if (before.size < 1n || before.size > BigInt(MAX_SCRIPT_BYTES)) {
    fail(code, `${handle.key} exceeds the bounded launcher snapshot size`);
  }
  const size = Number(before.size);
  const digest = createHash("sha256");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < size) {
    const length = Math.min(chunk.length, size - position);
    let bytesRead;
    try { bytesRead = readSync(handle.fd, chunk, 0, length, position); }
    catch { fail(code, `${handle.key} could not be hashed through its read-only handle`); }
    if (bytesRead < 1) fail(code, `${handle.key} ended during its content snapshot`);
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
  return Object.freeze({
    identity: beforeIdentity,
    size: String(before.size),
    mtimeNs: String(before.mtimeNs),
    sha256: digest.digest("hex"),
  });
}

function assertLauncherState(state) {
  const code = "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_CONTENT_DRIFT";
  const observed = contentSnapshot(state.handle);
  if (!sameFileIdentity(state.snapshot.identity, observed.identity)
    || state.snapshot.size !== observed.size
    || state.snapshot.mtimeNs !== observed.mtimeNs
    || state.snapshot.sha256 !== observed.sha256) {
    fail(code, `${state.key} bytes or identity changed during TCB provisioning`);
  }
}

function assertLauncherStates(states) {
  for (const state of states) assertLauncherState(state);
}

export function parseM64QualificationLegacyLauncherTcbProvisionFixedArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    fail(
      "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_CLI_INVALID",
      "fixed legacy-launcher TCB provision accepts no paths, roots, identities, or options",
    );
  }
  return Object.freeze({ provision: true });
}

export function resolveM64QualificationLegacyLauncherTcbExecutingRelease({
  runtimeRoot = M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_RUNTIME_ROOT,
  operatorPath = fileURLToPath(import.meta.url),
  verifyManifest = verifyReleaseManifest,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const code = "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_EXECUTING_RELEASE_INVALID";
  const runtime = resolve(runtimeRoot);
  const releasesRoot = join(runtime, "releases");
  const executingPath = resolve(operatorPath);
  if (!withinOrSame(releasesRoot, executingPath)) {
    fail(code, "executing provisioner escaped the fixed release store");
  }
  const parts = relative(releasesRoot, executingPath).split(/[\\/]/u);
  const releaseId = parts.shift();
  if (!RELEASE_ID.test(releaseId ?? "")
    || parts.join("/") !== M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_SELF_RELEASE_PATH) {
    fail(code, "executing provisioner is not in one exact formal release slot");
  }
  const release = verifyManifestSnapshot({
    releaseRoot: join(releasesRoot, releaseId),
    releasesRoot,
    verifyManifest,
    code,
    label: "executing formal release",
  });
  const selfPath = join(release.root, ...M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_SELF_RELEASE_PATH.split("/"));
  const matches = release.manifest.files.filter(
    (entry) => entry?.path === M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_SELF_RELEASE_PATH,
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

export function provisionM64QualificationLegacyLauncherTcbFixed({
  runtimeRoot = M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_RUNTIME_ROOT,
  operatorPath = fileURLToPath(import.meta.url),
  verifyManifest = verifyReleaseManifest,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const executing = resolveM64QualificationLegacyLauncherTcbExecutingRelease({
    runtimeRoot,
    operatorPath,
    verifyManifest,
    tcbAclController,
  });
  const runtime = executing.runtimeRoot;
  const releasesRoot = join(runtime, "releases");
  const current = resolveCurrentTarget(runtime, "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_CURRENT_INVALID");
  if (samePath(current.target, executing.root)) {
    fail(
      "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_CURRENT_INVALID",
      "legacy current must differ from the executing successor release",
    );
  }
  const before = verifyManifestSnapshot({
    releaseRoot: current.target,
    releasesRoot,
    verifyManifest,
    code: "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_CURRENT_INVALID",
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
      "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_CURRENT_INVALID",
      "legacy current release TCB verification failed",
      error?.code ?? null,
    );
  }
  if (typeof tcbAclController.verify !== "function"
    || typeof tcbAclController.protect !== "function"
    || typeof tcbAclController.verifyTarget !== "function"
    || typeof tcbAclController.protectTarget !== "function") {
    fail(
      "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_CONTROLLER_INVALID",
      "fixed launcher TCB controller lacks the required closure and target-only operations",
    );
  }

  const handles = [];
  try {
    const states = [];
    const rows = [];
    for (const target of LAUNCHER_TARGETS) {
      const handle = inspectOpenLauncher(join(runtime, target.filename), target.key);
      handles.push(handle);
      const snapshot = contentSnapshot(handle);
      const state = Object.freeze({
        key: target.key,
        handle,
        snapshot,
      });
      states.push(state);
      rows.push({
        key: target.key,
        handle,
        snapshot,
        plan: buildSystemTcbAclPlan({
          boundaryPath: runtime,
          targetPath: handle.path,
          recursive: false,
        }),
        normalize: false,
      });
    }
    const closurePlan = buildSystemTcbAclPlan({
      boundaryPath: runtime,
      targetPath: runtime,
      recursive: false,
    });
    let normalizeClosure = false;
    try { tcbAclController.verify(closurePlan); }
    catch (error) {
      if (error?.code !== "SYSTEM_TCB_ACL_TARGET_DACL_INVALID") {
        fail(
          "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_VERIFICATION_FAILED",
          "fixed runtime ancestor closure failed outside the exact migration condition",
          error?.code ?? null,
        );
      }
      normalizeClosure = true;
    }
    for (const row of rows) {
      try { tcbAclController.verifyTarget(row.plan); }
      catch (error) {
        if (error?.code !== "SYSTEM_TCB_ACL_TARGET_DACL_INVALID") {
          fail(
            "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_VERIFICATION_FAILED",
            `${row.key} failed outside the exact target migration condition`,
            error?.code ?? null,
          );
        }
        row.normalize = true;
      }
    }

    assertCurrentTarget(runtime, before.root);
    assertLauncherStates(states);
    if (normalizeClosure) {
      assertCurrentTarget(runtime, before.root);
      assertLauncherStates(states);
      try { tcbAclController.protect(closurePlan); }
      catch (error) {
        fail(
          "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_PROTECTION_FAILED",
          "fixed runtime ancestor closure protection failed closed",
          error?.code ?? null,
        );
      }
      assertCurrentTarget(runtime, before.root);
      assertLauncherStates(states);
    }

    let closureReceipt;
    try { closureReceipt = tcbAclController.verify(closurePlan); }
    catch (error) {
      fail(
        "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_VERIFICATION_FAILED",
        "fixed runtime ancestor closure did not verify after provisioning",
        error?.code ?? null,
      );
    }
    if (closureReceipt?.entryCount !== 1) {
      fail(
        "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_RECEIPT_INVALID",
        "fixed runtime ancestor closure verification receipt is invalid",
      );
    }

    for (const row of rows.filter((candidate) => candidate.normalize)) {
      assertCurrentTarget(runtime, before.root);
      assertLauncherStates(states);
      try { tcbAclController.verify(closurePlan); }
      catch (error) {
        fail(
          "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_VERIFICATION_FAILED",
          "fixed runtime ancestor closure drifted before target protection",
          error?.code ?? null,
        );
      }
      try { tcbAclController.protectTarget(row.plan); }
      catch (error) {
        fail(
          "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_PROTECTION_FAILED",
          `${row.key} target-only TCB protection failed closed`,
          error?.code ?? null,
        );
      }
      assertCurrentTarget(runtime, before.root);
      assertLauncherStates(states);
    }

    const verifiedRows = [];
    for (const row of rows) {
      assertCurrentTarget(runtime, before.root);
      assertLauncherStates(states);
      let receipt;
      try { receipt = tcbAclController.verifyTarget(row.plan); }
      catch (error) {
        fail(
          "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_VERIFICATION_FAILED",
          `${row.key} did not verify after provisioning`,
          error?.code ?? null,
        );
      }
      if (receipt?.entryCount !== 1) {
        fail(
          "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_RECEIPT_INVALID",
          `${row.key} target-only verification receipt is invalid`,
        );
      }
      verifiedRows.push(Object.freeze({
        key: row.key,
        sha256: row.snapshot.sha256,
        normalized: row.normalize,
        entryCount: receipt.entryCount,
      }));
    }

    const after = verifyManifestSnapshot({
      releaseRoot: before.root,
      releasesRoot,
      verifyManifest,
      code: "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_POSTVERIFY_FAILED",
      label: "post-provision legacy current release",
    });
    assertSameReleaseSnapshot(
      before,
      after,
      "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_POSTVERIFY_FAILED",
      "legacy current",
    );
    const executingAfter = verifyManifestSnapshot({
      releaseRoot: executing.root,
      releasesRoot,
      verifyManifest,
      code: "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_POSTVERIFY_FAILED",
      label: "post-provision executing formal release",
    });
    assertSameReleaseSnapshot(
      executing,
      executingAfter,
      "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_POSTVERIFY_FAILED",
      "executing formal release",
    );
    assertCurrentTarget(runtime, before.root);
    assertLauncherStates(states);

    const closureRow = Object.freeze({
      key: ANCESTOR_CLOSURE_KEY,
      normalized: normalizeClosure,
      entryCount: closureReceipt.entryCount,
    });
    const body = Object.freeze({
      schemaId: RECEIPT_SCHEMA_ID,
      status: "VERIFIED",
      operatorReleaseId: executingAfter.releaseId,
      operatorSourceCommit: executingAfter.sourceCommit,
      operatorManifestSha256: executingAfter.manifestSha256,
      legacyReleaseId: after.releaseId,
      legacySourceCommit: after.sourceCommit,
      legacySourceTreeSha: after.sourceTreeSha,
      legacyManifestSha256: after.manifestSha256,
      ancestorClosureCount: 1,
      normalizedAncestorClosureCount: normalizeClosure ? 1 : 0,
      ancestorClosures: Object.freeze([closureRow]),
      launcherCount: verifiedRows.length,
      normalizedCount: verifiedRows.filter((row) => row.normalized).length,
      launchers: Object.freeze(verifiedRows),
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
  parseM64QualificationLegacyLauncherTcbProvisionFixedArgs(argv);
  const result = provisionM64QualificationLegacyLauncherTcbFixed(dependencies);
  stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : null;
if (entry === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    process.stderr.write(
      `${error?.code ?? "M64_QUALIFICATION_LEGACY_LAUNCHER_TCB_FAILED"}: fixed legacy-launcher TCB provision failed\n`,
    );
    process.exitCode = 1;
  }
}
