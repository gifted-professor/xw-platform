#!/usr/bin/env node

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyReleaseManifest } from "../../../packages/release/lib/release-manifest.mjs";
import { canonicalJson, sha256 } from "../control-plane/lib/canonical.mjs";
import {
  buildSystemTcbAclPlan,
  createSystemTcbAclController,
} from "../control-plane/lib/windows-system-tcb-acl.mjs";

export const M64_QUALIFICATION_LEGACY_CURRENT_TCB_RUNTIME_ROOT =
  "C:\\Users\\Public\\xw-runtime";
export const M64_QUALIFICATION_LEGACY_CURRENT_TCB_SELF_RELEASE_PATH =
  "services/control-plane/ops/m6-qualification-legacy-current-tcb-provision-fixed.mjs";

const RELEASE_MANIFEST_SCHEMA_ID = "xw.runtime.release-manifest.v1";
const RECEIPT_SCHEMA_ID = "xw.runtime.m6-qualification-legacy-current-tcb-fixed-provision.v1";
const HASH = /^(?!0{64}$)[0-9a-f]{64}$/u;
const COMMIT = /^(?!0{40}$)[0-9a-f]{40}$/u;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/u;

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

function assertSameSnapshot(before, after, code) {
  if (!samePath(before.root, after.root)
    || before.releaseId !== after.releaseId
    || before.sourceCommit !== after.sourceCommit
    || before.sourceTreeSha !== after.sourceTreeSha
    || before.manifestSha256 !== after.manifestSha256
    || before.fileCount !== after.fileCount) {
    fail(code, "legacy current manifest identity changed during TCB provisioning");
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

function assertCurrentCas(runtimeRoot, expectedTarget) {
  const observed = resolveCurrentTarget(
    runtimeRoot,
    "M64_QUALIFICATION_LEGACY_CURRENT_TCB_CURRENT_DRIFT",
  );
  if (!samePath(observed.target, expectedTarget)) {
    fail(
      "M64_QUALIFICATION_LEGACY_CURRENT_TCB_CURRENT_DRIFT",
      "current changed during legacy release TCB provisioning",
    );
  }
}

export function parseM64QualificationLegacyCurrentTcbProvisionFixedArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    fail(
      "M64_QUALIFICATION_LEGACY_CURRENT_TCB_CLI_INVALID",
      "fixed legacy-current TCB provision accepts no paths, roots, identities, or options",
    );
  }
  return Object.freeze({ provision: true });
}

export function resolveM64QualificationLegacyCurrentTcbExecutingRelease({
  runtimeRoot = M64_QUALIFICATION_LEGACY_CURRENT_TCB_RUNTIME_ROOT,
  operatorPath = fileURLToPath(import.meta.url),
  verifyManifest = verifyReleaseManifest,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const code = "M64_QUALIFICATION_LEGACY_CURRENT_TCB_EXECUTING_RELEASE_INVALID";
  const runtime = resolve(runtimeRoot);
  const releasesRoot = join(runtime, "releases");
  const executingPath = resolve(operatorPath);
  if (!withinOrSame(releasesRoot, executingPath)) {
    fail(code, "executing provisioner escaped the fixed release store");
  }
  const parts = relative(releasesRoot, executingPath).split(/[\\/]/u);
  const releaseId = parts.shift();
  if (!RELEASE_ID.test(releaseId ?? "")
    || parts.join("/") !== M64_QUALIFICATION_LEGACY_CURRENT_TCB_SELF_RELEASE_PATH) {
    fail(code, "executing provisioner is not in one exact formal release slot");
  }
  const release = verifyManifestSnapshot({
    releaseRoot: join(releasesRoot, releaseId),
    releasesRoot,
    verifyManifest,
    code,
    label: "executing formal release",
  });
  const selfPath = join(release.root, ...M64_QUALIFICATION_LEGACY_CURRENT_TCB_SELF_RELEASE_PATH.split("/"));
  const matches = release.manifest.files.filter(
    (entry) => entry?.path === M64_QUALIFICATION_LEGACY_CURRENT_TCB_SELF_RELEASE_PATH,
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

export function provisionM64QualificationLegacyCurrentTcbFixed({
  runtimeRoot = M64_QUALIFICATION_LEGACY_CURRENT_TCB_RUNTIME_ROOT,
  operatorPath = fileURLToPath(import.meta.url),
  verifyManifest = verifyReleaseManifest,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const executing = resolveM64QualificationLegacyCurrentTcbExecutingRelease({
    runtimeRoot,
    operatorPath,
    verifyManifest,
    tcbAclController,
  });
  const runtime = executing.runtimeRoot;
  const current = resolveCurrentTarget(runtime, "M64_QUALIFICATION_LEGACY_CURRENT_TCB_CURRENT_INVALID");
  if (samePath(current.target, executing.root)) {
    fail(
      "M64_QUALIFICATION_LEGACY_CURRENT_TCB_CURRENT_INVALID",
      "legacy current must differ from the executing successor release",
    );
  }

  const before = verifyManifestSnapshot({
    releaseRoot: current.target,
    releasesRoot: join(runtime, "releases"),
    verifyManifest,
    code: "M64_QUALIFICATION_LEGACY_CURRENT_TCB_CURRENT_INVALID",
    label: "legacy current release",
  });
  const plan = buildSystemTcbAclPlan({
    boundaryPath: runtime,
    targetPath: before.root,
    recursive: true,
  });
  let normalized = false;
  let aclReceipt;
  try {
    aclReceipt = tcbAclController.verify(plan);
  } catch (error) {
    if (error?.code !== "SYSTEM_TCB_ACL_TARGET_DACL_INVALID") {
      fail(
        "M64_QUALIFICATION_LEGACY_CURRENT_TCB_VERIFICATION_FAILED",
        "legacy current TCB verification failed outside the exact migration condition",
        error?.code ?? null,
      );
    }
    assertCurrentCas(runtime, before.root);
    try { aclReceipt = tcbAclController.protect(plan); }
    catch (protectError) {
      fail(
        "M64_QUALIFICATION_LEGACY_CURRENT_TCB_PROTECTION_FAILED",
        "legacy current TCB protection failed closed",
        protectError?.code ?? null,
      );
    }
    normalized = true;
  }

  try { aclReceipt = tcbAclController.verify(plan); }
  catch (error) {
    fail(
      "M64_QUALIFICATION_LEGACY_CURRENT_TCB_VERIFICATION_FAILED",
      "legacy current TCB did not verify after provisioning",
      error?.code ?? null,
    );
  }
  const after = verifyManifestSnapshot({
    releaseRoot: before.root,
    releasesRoot: join(runtime, "releases"),
    verifyManifest,
    code: "M64_QUALIFICATION_LEGACY_CURRENT_TCB_POSTVERIFY_FAILED",
    label: "post-provision legacy current release",
  });
  assertSameSnapshot(before, after, "M64_QUALIFICATION_LEGACY_CURRENT_TCB_POSTVERIFY_FAILED");
  assertCurrentCas(runtime, before.root);
  if (!Number.isSafeInteger(aclReceipt?.entryCount) || aclReceipt.entryCount < 1) {
    fail(
      "M64_QUALIFICATION_LEGACY_CURRENT_TCB_RECEIPT_INVALID",
      "native TCB verification returned an invalid public receipt",
    );
  }
  const body = Object.freeze({
    schemaId: RECEIPT_SCHEMA_ID,
    status: "VERIFIED",
    operatorReleaseId: executing.releaseId,
    operatorSourceCommit: executing.sourceCommit,
    legacyReleaseId: after.releaseId,
    legacySourceCommit: after.sourceCommit,
    legacySourceTreeSha: after.sourceTreeSha,
    legacyManifestSha256: after.manifestSha256,
    entryCount: aclReceipt.entryCount,
    normalized,
  });
  return Object.freeze({
    ...body,
    receiptHash: sha256(`${RECEIPT_SCHEMA_ID}:${canonicalJson(body)}`),
  });
}

export function main(argv = process.argv.slice(2), {
  stdout = process.stdout,
  dependencies = {},
} = {}) {
  parseM64QualificationLegacyCurrentTcbProvisionFixedArgs(argv);
  const result = provisionM64QualificationLegacyCurrentTcbFixed(dependencies);
  stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : null;
if (entry === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    process.stderr.write(
      `${error?.code ?? "M64_QUALIFICATION_LEGACY_CURRENT_TCB_FAILED"}: fixed legacy-current TCB provision failed\n`,
    );
    process.exitCode = 1;
  }
}
