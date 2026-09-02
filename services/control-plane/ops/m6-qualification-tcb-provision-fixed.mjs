#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyReleaseManifest } from "../../../packages/release/lib/release-manifest.mjs";
import {
  inspectM64QualificationTcbClosure,
  M64_QUALIFICATION_TCB_RUNTIME_ROOT,
  publishM64QualificationTcbReceipt,
} from "../control-plane/lib/m6-qualification-tcb.mjs";

const SELF_RELEASE_PATH = "services/control-plane/ops/m6-qualification-tcb-provision-fixed.mjs";
const CLOSURE_RELEASE_PATH = "services/control-plane/control-plane/lib/m6-qualification-tcb.mjs";
const SYSTEM_TCB_RELEASE_PATH = "services/control-plane/control-plane/lib/windows-system-tcb-acl.mjs";
const HASH = /^(?!0{64}$)[0-9a-f]{64}$/u;
const COMMIT = /^(?!0{40}$)[0-9a-f]{40}$/u;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/u;

function fail(code, message) {
  throw Object.assign(new Error(`${code}: ${message}`), { code });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function within(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function plainBytes(path, label) {
  let stat;
  try { stat = lstatSync(path); }
  catch { fail("M64_QUALIFICATION_TCB_RELEASE_INVALID", `${label} is unavailable`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.size < 1 || stat.size > 64 * 1024 * 1024) {
    fail("M64_QUALIFICATION_TCB_RELEASE_INVALID", `${label} is not one bounded plain file`);
  }
  return readFileSync(path);
}

export function parseM64QualificationTcbProvisionFixedArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    fail(
      "M64_QUALIFICATION_TCB_CLI_INVALID",
      "fixed qualification TCB provision accepts no paths, keys, roots, identities, or options",
    );
  }
  return Object.freeze({ provision: true });
}

export function resolveM64QualificationTcbExecutingRelease({
  runtimeRoot = M64_QUALIFICATION_TCB_RUNTIME_ROOT,
  operatorPath = fileURLToPath(import.meta.url),
  verifyManifest = verifyReleaseManifest,
} = {}) {
  const runtime = resolve(runtimeRoot);
  const releasesRoot = join(runtime, "releases");
  const executingPath = resolve(operatorPath);
  if (!within(releasesRoot, executingPath)) {
    fail("M64_QUALIFICATION_TCB_RELEASE_INVALID", "executing provisioner escaped the fixed release store");
  }
  const parts = relative(releasesRoot, executingPath).split(/[\\/]/u);
  const releaseId = parts.shift();
  if (!RELEASE_ID.test(releaseId ?? "") || parts.join("/") !== SELF_RELEASE_PATH) {
    fail("M64_QUALIFICATION_TCB_RELEASE_INVALID", "executing provisioner is not in one formal release slot");
  }
  const releaseRoot = join(releasesRoot, releaseId);
  const manifestPath = join(releaseRoot, "release-manifest.v1.json");
  let manifest;
  try { manifest = JSON.parse(plainBytes(manifestPath, "formal release manifest").toString("utf8")); }
  catch (error) {
    if (error?.code) throw error;
    fail("M64_QUALIFICATION_TCB_RELEASE_INVALID", "formal release manifest is malformed");
  }
  if (manifest.releaseId !== releaseId || !COMMIT.test(manifest.sourceCommit ?? "")
    || verifyManifest({ root: releaseRoot, manifestPath })?.ok !== true) {
    fail("M64_QUALIFICATION_TCB_RELEASE_INVALID", "formal release identity failed verification");
  }
  for (const releasePath of [SELF_RELEASE_PATH, CLOSURE_RELEASE_PATH, SYSTEM_TCB_RELEASE_PATH]) {
    const matches = manifest.files?.filter?.((row) => row?.path === releasePath) ?? [];
    const target = join(releaseRoot, ...releasePath.split("/"));
    if (matches.length !== 1 || !HASH.test(matches[0].sha256 ?? "")
      || sha256(plainBytes(target, releasePath)) !== matches[0].sha256
      || (releasePath === SELF_RELEASE_PATH && !samePath(target, executingPath))) {
      fail("M64_QUALIFICATION_TCB_RELEASE_DRIFT", "fixed provision closure differs from the formal manifest");
    }
  }
  return Object.freeze({ runtimeRoot: runtime, releaseRoot, releaseId, sourceCommit: manifest.sourceCommit });
}

export function provisionM64QualificationTcbFixed(dependencies = {}) {
  const deps = {
    resolveRelease: resolveM64QualificationTcbExecutingRelease,
    inspectClosure: inspectM64QualificationTcbClosure,
    publishReceipt: publishM64QualificationTcbReceipt,
    ...dependencies,
  };
  const release = deps.resolveRelease({ runtimeRoot: M64_QUALIFICATION_TCB_RUNTIME_ROOT });
  const closure = deps.inspectClosure({
    runtimeRoot: M64_QUALIFICATION_TCB_RUNTIME_ROOT,
    allowNormalize: true,
  });
  const publication = deps.publishReceipt({
    runtimeRoot: M64_QUALIFICATION_TCB_RUNTIME_ROOT,
    releaseId: release.releaseId,
    sourceCommit: release.sourceCommit,
    closure,
  });
  if (publication?.receipt?.releaseId !== release.releaseId
    || publication.receipt.sourceCommit !== release.sourceCommit
    || publication.receipt.closureHash !== closure.closureHash
    || !HASH.test(publication.receipt.receiptHash ?? "")) {
    fail("M64_QUALIFICATION_TCB_RECEIPT_INVALID", "published TCB receipt escaped the executing release identity");
  }
  return Object.freeze({
    schemaId: "xw.runtime.m6-qualification-tcb-fixed-provision.v1",
    status: "VERIFIED",
    releaseId: release.releaseId,
    sourceCommit: release.sourceCommit,
    closureHash: closure.closureHash,
    receiptHash: publication.receipt.receiptHash,
    replay: publication.replay,
    normalizedTargetCount: closure.normalized.length,
  });
}

export function main(argv = process.argv.slice(2), {
  stdout = process.stdout,
  dependencies = {},
} = {}) {
  parseM64QualificationTcbProvisionFixedArgs(argv);
  const result = provisionM64QualificationTcbFixed(dependencies);
  stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : null;
if (entry === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${error?.code ?? "M64_QUALIFICATION_TCB_FAILED"}: fixed qualification TCB provision failed\n`);
    process.exitCode = 1;
  }
}
