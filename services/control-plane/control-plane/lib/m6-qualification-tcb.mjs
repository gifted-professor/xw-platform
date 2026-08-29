import {
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { canonicalJson, sha256 } from "./canonical.mjs";
import { normalizeGateIssuerAllowlist } from "./m6-issuer-allowlist.mjs";
import {
  buildSystemTcbAclPlan,
  createSystemTcbAclController,
} from "./windows-system-tcb-acl.mjs";

export const M64_QUALIFICATION_TCB_RECEIPT_SCHEMA_ID =
  "xw.runtime.m6-qualification-tcb-provision-receipt.v1";
export const M64_QUALIFICATION_TCB_RUNTIME_ROOT = "C:\\Users\\Public\\xw-runtime";
export const M64_QUALIFICATION_TCB_INVENTORY_SENTINEL_HASH = sha256(
  "xw.m6-c1-qualification-bootstrap.inventory-unavailable.v1",
);

const HASH = /^(?!0{64}$)[0-9a-f]{64}$/u;
const COMMIT = /^(?!0{40}$)[0-9a-f]{40}$/u;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/u;
const KEY_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const GATE_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const NORMALIZABLE_ACL_CODES = new Set(["SYSTEM_TCB_ACL_TARGET_DACL_INVALID"]);
const BOOTSTRAP_BINDING_KEYS = Object.freeze([
  "gateFArtifactInventoryHash", "gateFArtifactInventoryPath", "gateId",
  "gateIssuerAllowlistPath", "releaseId", "releaseManifestSha256", "schemaId",
  "sourceCommit", "sourceReleaseRoot",
]);
const RECEIPT_KEYS = Object.freeze([
  "activeIssuerKeyId", "bootstrapBindingSha256", "closureHash",
  "issuerAllowlistSha256", "operatorPublicKeySha256", "receiptHash",
  "releaseId", "schemaId", "sourceCommit", "status",
]);

function fail(code, message) {
  throw Object.assign(new Error(`${code}: ${message}`), { code });
}

function pathKey(value) {
  const full = resolve(value);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function within(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()));
}

function plainDirectory(path, code, label) {
  let stat;
  try { stat = lstatSync(path); }
  catch { fail(code, `${label} is unavailable`); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(path), path)) {
    fail(code, `${label} is linked, reparsed, or not a directory`);
  }
  return resolve(path);
}

function readPlainBytes(path, code, label, maximumBytes = MAX_FILE_BYTES) {
  const target = resolve(path);
  let before;
  let fd;
  try {
    before = lstatSync(target, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size < 1n || before.size > BigInt(maximumBytes)
      || !samePath(realpathSync(target), target)) {
      fail(code, `${label} is linked, reparsed, or not one bounded plain file`);
    }
    fd = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd, { bigint: true });
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (String(before.dev) !== String(opened.dev) || String(before.ino) !== String(opened.ino)
      || String(opened.dev) !== String(after.dev) || String(opened.ino) !== String(after.ino)
      || after.nlink !== 1n || after.size !== BigInt(bytes.byteLength)) {
      fail(code, `${label} changed while it was read`);
    }
    return Object.freeze({ path: target, bytes, sha256: sha256(bytes) });
  } catch (error) {
    if (error?.code?.startsWith?.("M64_QUALIFICATION_TCB_")) throw error;
    fail(code, `${label} is unavailable`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readPlainJson(path, code, label) {
  const file = readPlainBytes(path, code, label);
  try { return Object.freeze({ ...file, value: JSON.parse(file.bytes.toString("utf8")) }); }
  catch { fail(code, `${label} is not valid JSON`); }
}

function pathsFor(runtimeRoot) {
  if (typeof runtimeRoot !== "string" || !isAbsolute(runtimeRoot)) {
    fail("M64_QUALIFICATION_TCB_RUNTIME_INVALID", "runtime root must be absolute");
  }
  const runtime = resolve(runtimeRoot);
  return Object.freeze({
    runtime,
    secretsRoot: join(runtime, "secrets"),
    operatorKeysRoot: join(runtime, "secrets", "operator-keys"),
    gateRoot: join(runtime, "m6-gate"),
    issuerAllowlistPath: join(runtime, "m6-gate", "issuer-keys.json"),
    configRoot: join(runtime, "config"),
    bootstrapBindingPath: join(runtime, "config", "m6-c1-qualification-bootstrap.v1.json"),
    receiptRoot: join(runtime, "qualification-tcb"),
  });
}

function verifyProtectedRuntimeRoot(paths, controller) {
  plainDirectory(paths.runtime, "M64_QUALIFICATION_TCB_RUNTIME_INVALID", "formal runtime root");
  return controller.verify(buildSystemTcbAclPlan({
    boundaryPath: paths.runtime,
    targetPath: paths.runtime,
    recursive: false,
  }));
}

function normalizeFixedPlan({ boundaryPath, targetPath, controller, allowNormalize }) {
  const plan = buildSystemTcbAclPlan({ boundaryPath, targetPath, recursive: false });
  try {
    controller.verify(plan);
    return false;
  } catch (error) {
    if (!allowNormalize || !NORMALIZABLE_ACL_CODES.has(error?.code)) throw error;
  }
  controller.protect(plan);
  controller.verify(plan);
  return true;
}

function activeIssuer(allowlistValue) {
  let allowlist;
  try { allowlist = normalizeGateIssuerAllowlist(allowlistValue); }
  catch { fail("M64_QUALIFICATION_TCB_ISSUER_INVALID", "issuer allowlist is malformed"); }
  const active = [...allowlist.keys.values()].filter((row) => row.status === "active");
  if (active.length !== 1 || !KEY_ID.test(active[0]?.keyId ?? "")) {
    fail(
      "M64_QUALIFICATION_TCB_ISSUER_INVALID",
      "issuer allowlist must contain exactly one active path-safe key",
    );
  }
  return active[0];
}

function validateBootstrapBinding(value, paths) {
  const pathFields = [
    value?.sourceReleaseRoot,
    value?.gateIssuerAllowlistPath,
    value?.gateFArtifactInventoryPath,
  ];
  if (!exactObject(value, BOOTSTRAP_BINDING_KEYS)
    || value.schemaId !== "xw.runtime.m6-c1-qualification-bootstrap.v1"
    || !RELEASE_ID.test(value.releaseId ?? "") || !COMMIT.test(value.sourceCommit ?? "")
    || !HASH.test(value.releaseManifestSha256 ?? "") || !GATE_ID.test(value.gateId ?? "")
    || pathFields.some((path) => typeof path !== "string" || !isAbsolute(path))
    || value.gateFArtifactInventoryHash !== M64_QUALIFICATION_TCB_INVENTORY_SENTINEL_HASH) {
    fail(
      "M64_QUALIFICATION_TCB_BOOTSTRAP_INVALID",
      "qualification bootstrap binding does not satisfy the exact nine-field contract",
    );
  }
  const releasesRoot = plainDirectory(
    join(paths.runtime, "releases"),
    "M64_QUALIFICATION_TCB_BOOTSTRAP_INVALID",
    "formal releases root",
  );
  const releaseRoot = join(releasesRoot, value.releaseId);
  if (!within(releasesRoot, releaseRoot) || basename(releaseRoot) !== value.releaseId
    || !samePath(value.sourceReleaseRoot, releaseRoot)
    || !samePath(value.gateIssuerAllowlistPath, paths.issuerAllowlistPath)
    || !samePath(
      value.gateFArtifactInventoryPath,
      join(paths.runtime, "qualification-bootstrap", "final-inventory-unavailable.json"),
    )) {
    fail(
      "M64_QUALIFICATION_TCB_BOOTSTRAP_INVALID",
      "qualification bootstrap binding escaped or rebound a fixed runtime path",
    );
  }
  plainDirectory(
    releaseRoot,
    "M64_QUALIFICATION_TCB_BOOTSTRAP_INVALID",
    "bound formal release root",
  );
  const manifest = readPlainJson(
    join(releaseRoot, "release-manifest.v1.json"),
    "M64_QUALIFICATION_TCB_BOOTSTRAP_INVALID",
    "bound formal release manifest",
  );
  if (manifest.sha256 !== value.releaseManifestSha256
    || manifest.value?.schemaId !== "xw.runtime.release-manifest.v1"
    || manifest.value.releaseId !== value.releaseId
    || manifest.value.sourceCommit !== value.sourceCommit
    || !Array.isArray(manifest.value.files)
    || manifest.value.nodeVersion !== "24.11.1"
    || existsSync(value.gateFArtifactInventoryPath)
    || existsSync(join(
      paths.runtime,
      "qualification-bootstrap",
      "live-window-owner-keys-unavailable.json",
    ))) {
    fail(
      "M64_QUALIFICATION_TCB_BOOTSTRAP_INVALID",
      "qualification bootstrap release identity, manifest hash, or sentinel-only surface drifted",
    );
  }
}

function matchingPublicKey(active, privateBytes) {
  try {
    const expected = createPublicKey(active.publicKey).export({ format: "der", type: "spki" });
    const actual = createPublicKey(createPrivateKey(privateBytes)).export({ format: "der", type: "spki" });
    if (!Buffer.isBuffer(expected) || !Buffer.isBuffer(actual) || !expected.equals(actual)) {
      fail(
        "M64_QUALIFICATION_TCB_PRIVATE_KEY_MISMATCH",
        "protected operator key does not match the sole active issuer",
      );
    }
    return sha256(expected);
  } catch (error) {
    if (error?.code === "M64_QUALIFICATION_TCB_PRIVATE_KEY_MISMATCH") throw error;
    fail("M64_QUALIFICATION_TCB_PRIVATE_KEY_INVALID", "operator key is not one usable private key");
  }
}

export function inspectM64QualificationTcbClosure({
  runtimeRoot = M64_QUALIFICATION_TCB_RUNTIME_ROOT,
  allowNormalize = false,
} = {}, {
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  if (typeof allowNormalize !== "boolean"
    || typeof tcbAclController?.verify !== "function"
    || typeof tcbAclController?.protect !== "function") {
    fail("M64_QUALIFICATION_TCB_INPUT_INVALID", "TCB inspection dependencies are invalid");
  }
  const paths = pathsFor(runtimeRoot);
  verifyProtectedRuntimeRoot(paths, tcbAclController);
  const normalized = [];

  if (normalizeFixedPlan({
    boundaryPath: plainDirectory(paths.gateRoot, "M64_QUALIFICATION_TCB_ISSUER_INVALID", "M6 gate root"),
    targetPath: paths.issuerAllowlistPath,
    controller: tcbAclController,
    allowNormalize,
  })) normalized.push("issuerAllowlist");
  const issuerFile = readPlainJson(
    paths.issuerAllowlistPath,
    "M64_QUALIFICATION_TCB_ISSUER_INVALID",
    "issuer allowlist",
  );
  const issuer = activeIssuer(issuerFile.value);

  const keyPath = join(paths.operatorKeysRoot, `${issuer.keyId}.pkcs8.pem`);
  if (!within(paths.operatorKeysRoot, keyPath)
    || basename(keyPath) !== `${issuer.keyId}.pkcs8.pem`) {
    fail("M64_QUALIFICATION_TCB_PRIVATE_KEY_INVALID", "derived operator key escaped its fixed root");
  }
  if (normalizeFixedPlan({
    boundaryPath: plainDirectory(paths.secretsRoot, "M64_QUALIFICATION_TCB_PRIVATE_KEY_INVALID", "secret boundary"),
    targetPath: keyPath,
    controller: tcbAclController,
    allowNormalize,
  })) normalized.push("operatorPrivateKey");

  if (normalizeFixedPlan({
    boundaryPath: plainDirectory(paths.configRoot, "M64_QUALIFICATION_TCB_BOOTSTRAP_INVALID", "config root"),
    targetPath: paths.bootstrapBindingPath,
    controller: tcbAclController,
    allowNormalize,
  })) normalized.push("qualificationBootstrapBinding");
  const bindingFile = readPlainJson(
    paths.bootstrapBindingPath,
    "M64_QUALIFICATION_TCB_BOOTSTRAP_INVALID",
    "qualification bootstrap binding",
  );
  validateBootstrapBinding(bindingFile.value, paths);

  const keyFile = readPlainBytes(
    keyPath,
    "M64_QUALIFICATION_TCB_PRIVATE_KEY_INVALID",
    "protected operator private key",
    64 * 1024,
  );
  let operatorPublicKeySha256;
  try { operatorPublicKeySha256 = matchingPublicKey(issuer, keyFile.bytes); }
  finally { keyFile.bytes.fill(0); }
  const identity = Object.freeze({
    activeIssuerKeyId: issuer.keyId,
    issuerAllowlistSha256: issuerFile.sha256,
    bootstrapBindingSha256: bindingFile.sha256,
    operatorPublicKeySha256,
  });
  return Object.freeze({
    ...identity,
    closureHash: sha256(`xw.runtime.m6-qualification-tcb-closure.v1:${canonicalJson(identity)}`),
    normalized: Object.freeze(normalized),
    paths: Object.freeze({ ...paths, keyPath }),
  });
}

export function normalizeM64QualificationBootstrapBindingTcb({
  runtimeRoot = M64_QUALIFICATION_TCB_RUNTIME_ROOT,
} = {}, {
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const paths = pathsFor(runtimeRoot);
  verifyProtectedRuntimeRoot(paths, tcbAclController);
  normalizeFixedPlan({
    boundaryPath: plainDirectory(paths.configRoot, "M64_QUALIFICATION_TCB_BOOTSTRAP_INVALID", "config root"),
    targetPath: paths.bootstrapBindingPath,
    controller: tcbAclController,
    allowNormalize: true,
  });
  const binding = readPlainJson(
    paths.bootstrapBindingPath,
    "M64_QUALIFICATION_TCB_BOOTSTRAP_INVALID",
    "qualification bootstrap binding",
  );
  validateBootstrapBinding(binding.value, paths);
  return Object.freeze({
    path: binding.path,
    sha256: binding.sha256,
    protectedDacl: true,
  });
}

function receiptBody({ releaseId, sourceCommit, closure }) {
  if (!RELEASE_ID.test(releaseId ?? "") || !COMMIT.test(sourceCommit ?? "")
    || !HASH.test(closure?.closureHash ?? "")) {
    fail("M64_QUALIFICATION_TCB_RECEIPT_INVALID", "release/source/closure identity is invalid");
  }
  return Object.freeze({
    schemaId: M64_QUALIFICATION_TCB_RECEIPT_SCHEMA_ID,
    status: "VERIFIED",
    releaseId,
    sourceCommit,
    activeIssuerKeyId: closure.activeIssuerKeyId,
    issuerAllowlistSha256: closure.issuerAllowlistSha256,
    bootstrapBindingSha256: closure.bootstrapBindingSha256,
    operatorPublicKeySha256: closure.operatorPublicKeySha256,
    closureHash: closure.closureHash,
  });
}

function materializeReceipt(value) {
  const body = receiptBody(value);
  return Object.freeze({
    ...body,
    receiptHash: sha256(`${M64_QUALIFICATION_TCB_RECEIPT_SCHEMA_ID}:${canonicalJson(body)}`),
  });
}

function ensureReceiptDirectory(paths, sourceCommit) {
  const segments = [paths.receiptRoot, join(paths.receiptRoot, "receipts"),
    join(paths.receiptRoot, "receipts", sourceCommit)];
  for (const target of segments) {
    if (!existsSync(target)) mkdirSync(target, { recursive: false });
    plainDirectory(target, "M64_QUALIFICATION_TCB_RECEIPT_INVALID", "TCB receipt directory");
  }
  return segments.at(-1);
}

export function publishM64QualificationTcbReceipt({
  runtimeRoot = M64_QUALIFICATION_TCB_RUNTIME_ROOT,
  releaseId,
  sourceCommit,
  closure,
} = {}, {
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const paths = pathsFor(runtimeRoot);
  verifyProtectedRuntimeRoot(paths, tcbAclController);
  const receipt = materializeReceipt({ releaseId, sourceCommit, closure });
  const sourceRoot = ensureReceiptDirectory(paths, sourceCommit);
  const target = join(sourceRoot, `${receipt.receiptHash}.json`);
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  let replay = false;
  if (existsSync(target)) {
    const existing = readPlainBytes(
      target,
      "M64_QUALIFICATION_TCB_RECEIPT_INVALID",
      "TCB provision receipt",
    );
    if (!existing.bytes.equals(bytes)) {
      fail("M64_QUALIFICATION_TCB_RECEIPT_DRIFT", "TCB receipt address contains different bytes");
    }
    replay = true;
  } else {
    writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
  }
  normalizeFixedPlan({
    boundaryPath: paths.receiptRoot,
    targetPath: target,
    controller: tcbAclController,
    allowNormalize: true,
  });
  return Object.freeze({ receipt, path: target, replay });
}

function validateReceipt(value) {
  if (!exactObject(value, RECEIPT_KEYS)
    || value.schemaId !== M64_QUALIFICATION_TCB_RECEIPT_SCHEMA_ID
    || value.status !== "VERIFIED" || !RELEASE_ID.test(value.releaseId ?? "")
    || !COMMIT.test(value.sourceCommit ?? "") || !KEY_ID.test(value.activeIssuerKeyId ?? "")
    || ![value.issuerAllowlistSha256, value.bootstrapBindingSha256,
      value.operatorPublicKeySha256, value.closureHash, value.receiptHash].every((row) => HASH.test(row ?? ""))) {
    fail("M64_QUALIFICATION_TCB_RECEIPT_INVALID", "TCB provision receipt is malformed");
  }
  const { receiptHash: _ignored, ...body } = value;
  if (value.receiptHash !== sha256(`${M64_QUALIFICATION_TCB_RECEIPT_SCHEMA_ID}:${canonicalJson(body)}`)) {
    fail("M64_QUALIFICATION_TCB_RECEIPT_INVALID", "TCB provision receipt hash is invalid");
  }
  return value;
}

export function verifyM64QualificationTcbProvisionReceipt({
  runtimeRoot = M64_QUALIFICATION_TCB_RUNTIME_ROOT,
  releaseId,
  sourceCommit,
} = {}, {
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  if (!RELEASE_ID.test(releaseId ?? "") || !COMMIT.test(sourceCommit ?? "")) {
    fail("M64_QUALIFICATION_TCB_RECEIPT_INVALID", "expected release/source identity is invalid");
  }
  const closure = inspectM64QualificationTcbClosure({ runtimeRoot, allowNormalize: false }, {
    tcbAclController,
  });
  const paths = pathsFor(runtimeRoot);
  const sourceRoot = join(paths.receiptRoot, "receipts", sourceCommit);
  plainDirectory(sourceRoot, "M64_QUALIFICATION_TCB_RECEIPT_MISSING", "source-bound TCB receipt root");
  tcbAclController.verify(buildSystemTcbAclPlan({
    boundaryPath: paths.receiptRoot,
    targetPath: sourceRoot,
    recursive: true,
  }));
  const matches = readdirSync(sourceRoot)
    .filter((name) => /^(?!0{64})[0-9a-f]{64}\.json$/u.test(name))
    .map((name) => readPlainJson(
      join(sourceRoot, name),
      "M64_QUALIFICATION_TCB_RECEIPT_INVALID",
      "source-bound TCB provision receipt",
    ))
    .map((file) => ({ file, value: validateReceipt(file.value) }))
    .filter(({ file, value }) => basename(file.path) === `${value.receiptHash}.json`
      && value.releaseId === releaseId && value.sourceCommit === sourceCommit
      && value.closureHash === closure.closureHash
      && value.activeIssuerKeyId === closure.activeIssuerKeyId
      && value.issuerAllowlistSha256 === closure.issuerAllowlistSha256
      && value.bootstrapBindingSha256 === closure.bootstrapBindingSha256
      && value.operatorPublicKeySha256 === closure.operatorPublicKeySha256);
  if (matches.length !== 1) {
    fail(
      "M64_QUALIFICATION_TCB_RECEIPT_MISSING",
      "exactly one current-closure TCB receipt is required for this release/source",
    );
  }
  return Object.freeze({ ...matches[0].value, path: matches[0].file.path });
}
