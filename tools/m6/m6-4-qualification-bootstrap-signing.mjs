#!/usr/bin/env node

// Tracked, bounded signing orchestration for the M6-C1 qualification
// bootstrap.  Private-key selection is deliberately not a CLI option: the
// active issuer is selected from the fixed runtime allowlist and its key path
// is derived below the protected runtime secret boundary.
import {
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";

import {
  RELEASE_MANIFEST_FILENAME,
  verifyReleaseManifest,
} from "../../packages/release/lib/release-manifest.mjs";
import { canonicalJson, sha256 } from
  "../../services/control-plane/control-plane/lib/canonical.mjs";
import { normalizeGateIssuerAllowlist } from
  "../../services/control-plane/control-plane/lib/m6-issuer-allowlist.mjs";
import {
  buildSystemTcbAclPlan,
  createSystemTcbAclController,
} from "../../services/control-plane/control-plane/lib/windows-system-tcb-acl.mjs";
import {
  verifyM64QualificationTcbProvisionReceipt,
} from "../../services/control-plane/control-plane/lib/m6-qualification-tcb.mjs";
import {
  assembleM64QualificationBootstrapPackage,
  buildM64QualificationBootstrapSigningDraft,
  validateM64QualificationBootstrapSigningDraft,
} from "./m6-4-qualification-bootstrap-operator.mjs";

const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
const KEY_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/u;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;
const PRIVATE_KEY_PEM = /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/u;
const FIXED_CHRONOLOGY_STEP_MS = 1_000;
const FIXED_QUALIFICATION_TTL_MS = 48 * 60 * 60 * 1_000;

export const M64_QUALIFICATION_FORMAL_RUNTIME_ROOT = "C:\\Users\\Public\\xw-runtime";
export const M64_QUALIFICATION_AUDIT_PREFIX = "m6-c1-qualification-bootstrap";
export const M64_QUALIFICATION_RELEASE_LOCK_PATHS = Object.freeze({
  runtimeProfile: "packages/kernel/contracts/runtime-profile.v1.json",
  hardRedlinePolicy: "integrations/dsh-xw/config/hard-redline-policy.v1.json",
  groundingRuntime: "artifacts/m6-4/tcb-manifests/xw.m6-grounded-run.tcb.v1.json",
});

function fail(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function within(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function absolutePath(value, label) {
  if (typeof value !== "string" || value.length < 3 || value.length > 32_767
    || value.includes("\0") || !isAbsolute(value)) {
    fail("M64_QUALIFICATION_SIGNING_PATH_INVALID", `${label} must be one bounded absolute path`);
  }
  return resolve(value);
}

function assertPlainAncestors(path, { includeTarget = false, allowMissing = false } = {}) {
  const target = resolve(path);
  const root = parse(target).root;
  let cursor = includeTarget ? target : dirname(target);
  while (cursor && !samePath(cursor, root)) {
    if (!existsSync(cursor)) {
      if (!allowMissing) {
        fail("M64_QUALIFICATION_SIGNING_PATH_UNAVAILABLE", "signing path ancestor is unavailable");
      }
    } else {
      const stat = lstatSync(cursor, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync.native(cursor), cursor)) {
        fail(
          "M64_QUALIFICATION_SIGNING_PATH_REPARSE",
          "signing paths may not traverse symlinks, junctions, or non-directory ancestors",
        );
      }
    }
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
}

function ensureFixedPlainDirectory(runtimeRoot, ...segments) {
  const runtime = absolutePath(runtimeRoot, "runtime root");
  assertPlainAncestors(runtime, { includeTarget: true });
  let cursor = runtime;
  for (const segment of segments) {
    if (typeof segment !== "string" || segment.length < 1 || segment.length > 180
      || segment === "." || segment === ".." || /[\\/:\0]/u.test(segment)) {
      fail("M64_QUALIFICATION_SIGNING_PATH_INVALID", "fixed audit path segment is invalid");
    }
    const next = join(cursor, segment);
    if (!within(runtime, next)) {
      fail("M64_QUALIFICATION_SIGNING_PATH_INVALID", "fixed audit path escaped runtime root");
    }
    if (!existsSync(next)) {
      try {
        mkdirSync(next, { recursive: false });
      } catch (cause) {
        if (cause?.code !== "EEXIST") {
          fail("M64_QUALIFICATION_SIGNING_WRITE_FAILED", "fixed audit directory could not be created", {
            cause: cause?.code ?? cause?.message ?? null,
          });
        }
      }
    }
    assertPlainAncestors(next, { includeTarget: true });
    cursor = next;
  }
  return cursor;
}

export function deriveM64QualificationFixedAuditPaths({
  releaseId,
  sourceCommit,
  packageHash = null,
  runtimeRoot = M64_QUALIFICATION_FORMAL_RUNTIME_ROOT,
} = {}) {
  if (!RELEASE_ID.test(releaseId ?? "") || !SOURCE_COMMIT.test(sourceCommit ?? "")
    || (packageHash !== null && !/^(?!0{64}$)[0-9a-f]{64}$/u.test(packageHash))) {
    fail(
      "M64_QUALIFICATION_FIXED_IDENTITY_INVALID",
      "fixed qualification release/source/package identity is invalid",
    );
  }
  const runtime = absolutePath(runtimeRoot, "runtime root");
  const sourceShort = sourceCommit.slice(0, 7);
  const auditRoot = join(runtime, "m6-audit", `${M64_QUALIFICATION_AUDIT_PREFIX}-${sourceShort}`);
  const packageRoot = join(auditRoot, "packages");
  return Object.freeze({
    runtimeRoot: runtime,
    releaseRoot: join(runtime, "releases", releaseId),
    issuerAllowlistPath: fixedAllowlistPath(runtime),
    auditRoot,
    draftRoot: join(auditRoot, "drafts"),
    proofRoot: join(auditRoot, "proofs"),
    packageRoot,
    packagePath: packageHash === null ? null : join(packageRoot, `${packageHash}.package.json`),
    sourceShort,
  });
}

function readPlainBytes(path, label, maxBytes = MAX_JSON_BYTES) {
  const target = absolutePath(path, label);
  assertPlainAncestors(target);
  let fd;
  try {
    const before = lstatSync(target, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size < 1n || before.size > BigInt(maxBytes)
      || !samePath(realpathSync.native(target), target)) {
      fail("M64_QUALIFICATION_SIGNING_FILE_INVALID", `${label} is not one bounded plain file`);
    }
    fd = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd, { bigint: true });
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (String(before.dev) !== String(opened.dev) || String(before.ino) !== String(opened.ino)
      || String(opened.dev) !== String(after.dev) || String(opened.ino) !== String(after.ino)
      || after.nlink !== 1n || after.size !== BigInt(bytes.byteLength)) {
      fail("M64_QUALIFICATION_SIGNING_FILE_RACE", `${label} changed while it was read`);
    }
    return Object.freeze({ path: target, bytes, sha256: sha256(bytes) });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readPlainJson(path, label) {
  const file = readPlainBytes(path, label);
  try {
    return Object.freeze({ ...file, value: JSON.parse(file.bytes.toString("utf8")) });
  } catch {
    fail("M64_QUALIFICATION_SIGNING_JSON_INVALID", `${label} is not valid JSON`);
  }
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeCreateOnlyJson(path, value, label) {
  const target = absolutePath(path, label);
  assertPlainAncestors(target);
  const bytes = jsonBytes(value);
  if (existsSync(target)) {
    const existing = readPlainBytes(target, label);
    if (!existing.bytes.equals(bytes)) {
      fail("M64_QUALIFICATION_SIGNING_OUTPUT_DRIFT", `${label} already contains different bytes`);
    }
    return Object.freeze({ path: target, sha256: existing.sha256, replay: true });
  }
  let fd;
  try {
    fd = openSync(target, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } catch (cause) {
    fail("M64_QUALIFICATION_SIGNING_WRITE_FAILED", `${label} could not be published create-only`, {
      cause: cause?.code ?? cause?.message ?? null,
    });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const result = readPlainBytes(target, label);
  if (!result.bytes.equals(bytes)) {
    fail("M64_QUALIFICATION_SIGNING_WRITE_FAILED", `${label} failed readback`);
  }
  return Object.freeze({ path: target, sha256: result.sha256, replay: false });
}

function defaultProtectedSigner({ keyPath, payload }) {
  const keyFile = readPlainBytes(keyPath, "protected issuer private key", MAX_PRIVATE_KEY_BYTES);
  if (!PRIVATE_KEY_PEM.test(keyFile.bytes.subarray(0, 96).toString("ascii"))) {
    keyFile.bytes.fill(0);
    fail(
      "M64_QUALIFICATION_SIGNING_PRIVATE_KEY_INVALID",
      "protected issuer key is not one PKCS8 private key",
    );
  }
  try {
    const privateKey = createPrivateKey(keyFile.bytes);
    const publicKey = createPublicKey(privateKey);
    return Object.freeze({
      signature: signBytes(null, payload, privateKey),
      publicKeyDer: publicKey.export({ format: "der", type: "spki" }),
    });
  } catch {
    fail(
      "M64_QUALIFICATION_SIGNING_PRIVATE_KEY_INVALID",
      "protected issuer key could not sign the fixed Ed25519 domain",
    );
  } finally {
    keyFile.bytes.fill(0);
  }
}

function fixedAllowlistPath(runtimeRoot) {
  return join(runtimeRoot, "m6-gate", "issuer-keys.json");
}

export function createM64QualificationSigningDraftFile({ inputPath, outputPath } = {}) {
  const input = readPlainJson(inputPath, "qualification signing draft input");
  const draft = buildM64QualificationBootstrapSigningDraft(input.value);
  const publication = writeCreateOnlyJson(outputPath, draft, "qualification signing draft");
  return Object.freeze({
    ok: true,
    schemaId: "xw.m6-c1-qualification-bootstrap-draft-publication.v1",
    draftPath: publication.path,
    draftHash: draft.draftHash,
    draftSha256: publication.sha256,
    signingRoles: Object.freeze(draft.signingRequests.map((request) => request.role)),
    replay: publication.replay,
  });
}

function signM64QualificationDraftRecordsWithProtectedLocalIssuer({
  draft,
  runtimeRoot,
  keyId,
} = {}, {
  aclController = createSystemTcbAclController(),
  protectedSigner = defaultProtectedSigner,
} = {}) {
  const runtime = absolutePath(runtimeRoot, "runtime root");
  assertPlainAncestors(runtime, { includeTarget: true });
  if (!KEY_ID.test(keyId ?? "")) {
    fail("M64_QUALIFICATION_SIGNING_ISSUER_INVALID", "issuer keyId is invalid");
  }
  const allowlistPath = fixedAllowlistPath(runtime);
  const allowlistFile = readPlainJson(allowlistPath, "fixed gate issuer allowlist");
  const allowlist = normalizeGateIssuerAllowlist(allowlistFile.value);
  const issuer = allowlist.keys.get(keyId);
  if (!issuer || issuer.status !== "active") {
    fail(
      "M64_QUALIFICATION_SIGNING_ISSUER_INVALID",
      "issuer must be one active key from the fixed runtime allowlist",
    );
  }
  const verifiedDraft = validateM64QualificationBootstrapSigningDraft(draft);
  if (verifiedDraft.rootEpoch.actor !== issuer.subject
    || verifiedDraft.closedEpoch.actor !== issuer.subject) {
    fail(
      "M64_QUALIFICATION_SIGNING_SUBJECT_MISMATCH",
      "draft actor does not match the selected runtime issuer",
    );
  }
  const secretBoundary = join(runtime, "secrets");
  const keyPath = join(secretBoundary, "operator-keys", `${keyId}.pkcs8.pem`);
  if (!samePath(keyPath, join(runtime, "secrets", "operator-keys", `${keyId}.pkcs8.pem`))) {
    fail("M64_QUALIFICATION_SIGNING_PRIVATE_KEY_INVALID", "derived private-key path escaped");
  }
  if (!aclController || typeof aclController.verify !== "function") {
    fail("M64_QUALIFICATION_SIGNING_ACL_UNAVAILABLE", "SYSTEM/Admin ACL verifier is required");
  }
  const acl = aclController.verify(buildSystemTcbAclPlan({
    boundaryPath: secretBoundary,
    targetPath: keyPath,
    recursive: false,
  }));
  if (!acl || acl.ok !== true) {
    fail("M64_QUALIFICATION_SIGNING_ACL_UNAVAILABLE", "protected private-key ACL was not verified");
  }
  const expectedPublicKey = createPublicKey(issuer.publicKey);
  const expectedPublicKeyDer = expectedPublicKey.export({ format: "der", type: "spki" });
  const proofRecords = [];
  for (const request of verifiedDraft.signingRequests) {
    const payload = Buffer.from(request.payloadHex, "hex");
    const signed = protectedSigner({ keyPath, payload, role: request.role, keyId });
    let signatureBase64;
    try {
      if (!signed || !Buffer.isBuffer(signed.signature) || signed.signature.byteLength !== 64
        || !Buffer.isBuffer(signed.publicKeyDer)
        || !signed.publicKeyDer.equals(expectedPublicKeyDer)
        || !verifyBytes(null, payload, expectedPublicKey, signed.signature)) {
        fail(
          "M64_QUALIFICATION_SIGNING_PRIVATE_KEY_MISMATCH",
          "protected issuer key did not match the allowlist public key or signature domain",
        );
      }
      signatureBase64 = signed.signature.toString("base64");
    } finally {
      if (Buffer.isBuffer(signed?.signature)) signed.signature.fill(0);
    }
    proofRecords.push(Object.freeze({
      algorithm: "ed25519",
      allowlistVersion: allowlist.version,
      keyId,
      signature: signatureBase64,
      subject: issuer.subject,
    }));
  }
  return Object.freeze({
    draftHash: verifiedDraft.draftHash,
    issuer: Object.freeze({
      keyId,
      subject: issuer.subject,
      allowlistVersion: allowlist.version,
      allowlistSha256: allowlistFile.sha256,
    }),
    proofRecords: Object.freeze(proofRecords),
  });
}

export function signM64QualificationDraftWithProtectedLocalIssuer({
  draftPath,
  runtimeRoot,
  keyId,
  rootProofPath,
  closedProofPath,
} = {}, dependencies = {}) {
  const draftFile = readPlainJson(draftPath, "qualification signing draft");
  const signed = signM64QualificationDraftRecordsWithProtectedLocalIssuer({
    draft: draftFile.value,
    runtimeRoot,
    keyId,
  }, dependencies);
  const proofPaths = [rootProofPath, closedProofPath];
  const outputs = signed.proofRecords.map((proof, index) => {
    const request = draftFile.value.signingRequests[index];
    const publication = writeCreateOnlyJson(
      proofPaths[index],
      proof,
      `${request.role} external epoch proof`,
    );
    return Object.freeze({
      role: request.role,
      path: publication.path,
      sha256: publication.sha256,
      replay: publication.replay,
    });
  });
  return Object.freeze({
    ok: true,
    schemaId: "xw.m6-c1-qualification-bootstrap-local-signing-result.v1",
    draftHash: signed.draftHash,
    issuer: signed.issuer,
    proofs: Object.freeze(outputs),
  });
}

export function assembleM64QualificationBootstrapPackageFile({
  draftPath,
  runtimeRoot,
  rootProofPath,
  closedProofPath,
  outputPath,
} = {}, dependencies = {}) {
  const runtime = absolutePath(runtimeRoot, "runtime root");
  assertPlainAncestors(runtime, { includeTarget: true });
  const draft = readPlainJson(draftPath, "qualification signing draft");
  const rootProof = readPlainJson(rootProofPath, "ROOT external epoch proof");
  const closedProof = readPlainJson(closedProofPath, "CLOSED external epoch proof");
  const packageRecord = assembleM64QualificationBootstrapPackage({
    draft: draft.value,
    rootProof: rootProof.value,
    closedProof: closedProof.value,
    issuerAllowlistPath: fixedAllowlistPath(runtime),
    runtimeRoot: runtime,
  }, dependencies);
  const publication = writeCreateOnlyJson(
    outputPath,
    packageRecord,
    "qualification bootstrap package",
  );
  return Object.freeze({
    ok: true,
    schemaId: "xw.m6-c1-qualification-bootstrap-package-publication.v1",
    packagePath: publication.path,
    packageHash: packageRecord.packageHash,
    packageSha256: publication.sha256,
    draftHash: draft.value.draftHash,
    proofRefs: Object.freeze([
      Object.freeze({ role: "ROOT", path: rootProof.path, sha256: rootProof.sha256 }),
      Object.freeze({ role: "CLOSED", path: closedProof.path, sha256: closedProof.sha256 }),
    ]),
    replay: publication.replay,
  });
}

function verifyFixedFormalRelease({ releaseId, sourceCommit, runtimeRoot }, verifyManifest) {
  const paths = deriveM64QualificationFixedAuditPaths({
    releaseId,
    sourceCommit,
    runtimeRoot,
  });
  assertPlainAncestors(paths.releaseRoot, { includeTarget: true });
  const manifest = readPlainJson(
    join(paths.releaseRoot, RELEASE_MANIFEST_FILENAME),
    "formal release manifest",
  );
  if (manifest.value?.releaseId !== releaseId || manifest.value?.sourceCommit !== sourceCommit
    || !samePath(paths.releaseRoot, join(paths.runtimeRoot, "releases", releaseId))) {
    fail(
      "M64_QUALIFICATION_FIXED_RELEASE_INVALID",
      "formal release manifest does not match the fixed release/source identity",
    );
  }
  const verification = verifyManifest({
    root: paths.releaseRoot,
    manifestPath: manifest.path,
  });
  if (!verification?.ok) {
    fail(
      "M64_QUALIFICATION_FIXED_RELEASE_INVALID",
      "formal release manifest verification failed",
      { mismatches: verification?.mismatches ?? [] },
    );
  }
  return Object.freeze({ paths, manifest });
}

export function packageM64QualificationBootstrapFixed({
  releaseId,
  sourceCommit,
} = {}, {
  runtimeRoot = M64_QUALIFICATION_FORMAL_RUNTIME_ROOT,
  now = Date.now,
  verifyManifest = verifyReleaseManifest,
  aclController = createSystemTcbAclController(),
  protectedSigner = defaultProtectedSigner,
  verifyTcbProvisionReceipt = verifyM64QualificationTcbProvisionReceipt,
  packageDependencies = {},
} = {}) {
  if (typeof now !== "function" || typeof verifyManifest !== "function"
    || typeof verifyTcbProvisionReceipt !== "function") {
    fail("M64_QUALIFICATION_FIXED_DEPENDENCY_INVALID", "fixed clock and manifest verifier are required");
  }
  const { paths, manifest } = verifyFixedFormalRelease({
    releaseId,
    sourceCommit,
    runtimeRoot,
  }, verifyManifest);
  const tcbReceipt = verifyTcbProvisionReceipt({ runtimeRoot, releaseId, sourceCommit });
  if (tcbReceipt?.releaseId !== releaseId || tcbReceipt?.sourceCommit !== sourceCommit
    || !/^(?!0{64}$)[0-9a-f]{64}$/u.test(tcbReceipt?.receiptHash ?? "")) {
    fail(
      "M64_QUALIFICATION_TCB_RECEIPT_INVALID",
      "package-fixed requires the current release/source qualification TCB receipt",
    );
  }
  const promotedAtMs = Number(now());
  if (!Number.isSafeInteger(promotedAtMs)
    || promotedAtMs < 0
    || promotedAtMs > Date.parse("9999-12-31T23:59:55.000Z")) {
    fail("M64_QUALIFICATION_FIXED_CLOCK_INVALID", "fixed qualification clock is invalid");
  }
  const issuerFile = readPlainJson(paths.issuerAllowlistPath, "fixed gate issuer allowlist");
  const allowlist = normalizeGateIssuerAllowlist(issuerFile.value);
  const activeIssuers = [...allowlist.keys.values()].filter((issuer) => issuer.status === "active");
  if (activeIssuers.length !== 1) {
    fail(
      "M64_QUALIFICATION_FIXED_ISSUER_INVALID",
      "fixed gate issuer allowlist must contain exactly one active issuer",
    );
  }
  const rootIssuedAtMs = promotedAtMs - (3 * FIXED_CHRONOLOGY_STEP_MS);
  const locksRecord = Object.freeze({
    schemaId: "xw.m6-locks.v1",
    releaseId,
    sourceCommit,
    lockHashes: Object.freeze(Object.fromEntries(
      Object.entries(M64_QUALIFICATION_RELEASE_LOCK_PATHS).map(([kind, relativePath]) => [
        kind,
        readPlainBytes(join(paths.releaseRoot, ...relativePath.split("/")), `${kind} release lock`).sha256,
      ]),
    )),
  });
  const draft = buildM64QualificationBootstrapSigningDraft({
    actor: activeIssuers[0].subject,
    closedIssuedAt: new Date(promotedAtMs - FIXED_CHRONOLOGY_STEP_MS).toISOString(),
    closeoutCommittedAt: new Date(promotedAtMs - (2 * FIXED_CHRONOLOGY_STEP_MS)).toISOString(),
    expiresAt: new Date(rootIssuedAtMs + FIXED_QUALIFICATION_TTL_MS).toISOString(),
    gateId: `m6-4-gate-f-${paths.sourceShort}`,
    issuerAllowlistSha256: issuerFile.sha256,
    locksRecord,
    promotedAt: new Date(promotedAtMs).toISOString(),
    releaseId,
    rootIssuedAt: new Date(rootIssuedAtMs).toISOString(),
    sourceCommit,
  });
  const signed = signM64QualificationDraftRecordsWithProtectedLocalIssuer({
    draft,
    runtimeRoot: paths.runtimeRoot,
    keyId: activeIssuers[0].keyId,
  }, { aclController, protectedSigner });
  const [rootProof, closedProof] = signed.proofRecords;
  const packageRecord = assembleM64QualificationBootstrapPackage({
    draft,
    rootProof,
    closedProof,
    issuerAllowlistPath: paths.issuerAllowlistPath,
    runtimeRoot: paths.runtimeRoot,
    nowMs: promotedAtMs,
  }, packageDependencies);
  ensureFixedPlainDirectory(
    paths.runtimeRoot,
    "m6-audit",
    `${M64_QUALIFICATION_AUDIT_PREFIX}-${paths.sourceShort}`,
    "drafts",
  );
  ensureFixedPlainDirectory(
    paths.runtimeRoot,
    "m6-audit",
    `${M64_QUALIFICATION_AUDIT_PREFIX}-${paths.sourceShort}`,
    "proofs",
  );
  ensureFixedPlainDirectory(
    paths.runtimeRoot,
    "m6-audit",
    `${M64_QUALIFICATION_AUDIT_PREFIX}-${paths.sourceShort}`,
    "packages",
  );
  const draftPublication = writeCreateOnlyJson(
    join(paths.draftRoot, `${draft.draftHash}.draft.json`),
    draft,
    "fixed qualification signing draft",
  );
  for (let index = 0; index < signed.proofRecords.length; index += 1) {
    const proof = signed.proofRecords[index];
    const proofSha256 = sha256(jsonBytes(proof));
    writeCreateOnlyJson(
      join(paths.proofRoot, `${proofSha256}.proof.json`),
      proof,
      `${draft.signingRequests[index].role} fixed qualification proof`,
    );
  }
  const fixedPaths = deriveM64QualificationFixedAuditPaths({
    releaseId,
    sourceCommit,
    packageHash: packageRecord.packageHash,
    runtimeRoot: paths.runtimeRoot,
  });
  const publication = writeCreateOnlyJson(
    fixedPaths.packagePath,
    packageRecord,
    "fixed qualification bootstrap package",
  );
  if (!samePath(publication.path, fixedPaths.packagePath)
    || packageRecord.releaseId !== manifest.value.releaseId
    || packageRecord.sourceCommit !== manifest.value.sourceCommit
    || draftPublication.sha256 !== sha256(jsonBytes(draft))) {
    fail("M64_QUALIFICATION_FIXED_PUBLICATION_INVALID", "fixed qualification publication did not read back exactly");
  }
  return Object.freeze({
    ok: true,
    schemaId: "xw.m6-c1-qualification-bootstrap-fixed-package-ref.v1",
    packageHash: packageRecord.packageHash,
    packageRef: publication.path,
    replay: publication.replay,
  });
}

export function parseM64QualificationPackageFixedArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 3 || argv[0] !== "package-fixed"
    || !RELEASE_ID.test(argv[1] ?? "") || !SOURCE_COMMIT.test(argv[2] ?? "")
    || argv.some((value) => typeof value !== "string" || value.startsWith("--"))) {
    fail(
      "M64_QUALIFICATION_SIGNING_ARGUMENT_INVALID",
      "usage: package-fixed <releaseId> <sourceCommit>; paths, inputs, keys, tokens, and PIDs are forbidden",
    );
  }
  return Object.freeze({ releaseId: argv[1], sourceCommit: argv[2] });
}

export async function main(argv = process.argv.slice(2), {
  stdout = process.stdout,
  stderr = process.stderr,
  fixedDependencies = {},
} = {}) {
  try {
    const parsed = parseM64QualificationPackageFixedArgs(argv);
    const result = packageM64QualificationBootstrapFixed(parsed, fixedDependencies);
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code ?? "M64_QUALIFICATION_SIGNING_FAILED",
      message: error?.message ?? String(error),
    })}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
