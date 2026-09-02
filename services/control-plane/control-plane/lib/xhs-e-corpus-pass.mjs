/**
 * xhs-e-corpus-pass.mjs — canonical, task-owned V3 E-Corpus gate artifact.
 *
 * The artifact is not a caller assertion.  A SYSTEM task that holds the
 * deployment digest key seals one immutable PASS body into a fixed,
 * content-addressed directory.  Consumers name only the artifact hash; this
 * module derives the path, re-validates canonical bytes, HMAC, active key,
 * owner, time window, and every release/provider/corpus/evaluator binding.
 *
 * No API accepts an arbitrary artifact path.  This is deliberate: accepting
 * a caller path would turn a copied historical PASS into live authority.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { canonicalJson, sha256 } from "./canonical.mjs";

export const XHS_E_CORPUS_PASS_SCHEMA_ID = "xw.xhs.e-corpus-pass.v1";
export const XHS_E_CORPUS_PASS_SCHEMA_VERSION = 1;
export const XHS_E_CORPUS_PASS_REF_SCHEMA_ID = "xw.xhs.e-corpus-pass-ref.v1";
export const XHS_E_CORPUS_PASS_ARTIFACT_NAME = "xw.xhs.e-corpus-pass.v1.json";
export const XHS_E_CORPUS_PASS_SEAL_KIND = "xhs-e-corpus-pass-artifact";
export const XHS_E_CORPUS_PASS_MAX_VALIDITY_MS = 24 * 60 * 60 * 1000;

const HEX_64 = /^[a-f0-9]{64}$/;
const HEX_40 = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/;
const SAFE_KEY_ID = /^[A-Za-z0-9-]{1,64}$/;
const ARTIFACT_KEYS = new Set([
  "schemaId", "schemaVersion", "status", "issuedAtMs", "expiresAtMs",
  "owner", "binding", "artifactHash", "seal",
]);
const OWNER_KEYS = Object.freeze([
  "taskName", "taskBindingHash", "launcherHash", "callerPathHash",
]);
const BINDING_KEYS = Object.freeze([
  "releaseId", "sourceCommit", "providerBundleDigest", "corpusManifestHash",
  "privateIndexDigest", "evaluatorSourceHash", "testReportHash",
  "digestKeyId", "gateEpoch",
]);
const REF_KEYS = new Set([
  "schemaId", "artifactHash", "bindingHash", "gateEpoch", "expiresAtMs",
]);

const BINDING_MISMATCH_CODES = Object.freeze({
  releaseId: "ECORPUS_RELEASE_MISMATCH",
  sourceCommit: "ECORPUS_SOURCE_MISMATCH",
  providerBundleDigest: "ECORPUS_PROVIDER_MISMATCH",
  corpusManifestHash: "ECORPUS_CORPUS_MISMATCH",
  privateIndexDigest: "ECORPUS_PRIVATE_INDEX_MISMATCH",
  evaluatorSourceHash: "ECORPUS_EVALUATOR_MISMATCH",
  testReportHash: "ECORPUS_TEST_REPORT_MISMATCH",
  digestKeyId: "ECORPUS_KEY_MISMATCH",
  gateEpoch: "ECORPUS_REPLAY_REJECTED",
});

export class ECorpusPassError extends Error {
  constructor(code, message, { status = 409, details = {} } = {}) {
    super(message);
    this.name = "ECorpusPassError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function fail(code, message, options) {
  throw new ECorpusPassError(code, message, options);
}

function assertExactKeys(value, expected, code, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${label} must be an object`, { status: 400 });
  }
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    fail(code, `${label} has missing or caller-authority fields`, {
      status: 400,
      details: { actual: [...actual].sort(), expected: [...expected].sort() },
    });
  }
}

function normalizeOwner(owner) {
  assertExactKeys(owner, OWNER_KEYS, "ECORPUS_OWNER_INVALID", "artifact owner");
  if (!SAFE_TASK_NAME.test(String(owner.taskName ?? ""))) {
    fail("ECORPUS_OWNER_INVALID", "taskName is missing or malformed", { status: 400 });
  }
  for (const key of OWNER_KEYS.slice(1)) {
    if (!HEX_64.test(String(owner[key] ?? ""))) {
      fail("ECORPUS_OWNER_INVALID", `${key} must be 64-hex`, { status: 400 });
    }
  }
  return Object.freeze(Object.fromEntries(OWNER_KEYS.map((key) => [key, String(owner[key])])));
}

export function normalizeECorpusBinding(binding) {
  assertExactKeys(binding, BINDING_KEYS, "ECORPUS_BINDING_INVALID", "E-Corpus binding");
  if (!SAFE_ID.test(String(binding.releaseId ?? ""))) {
    fail("ECORPUS_BINDING_INVALID", "releaseId is missing or malformed", { status: 400 });
  }
  if (!HEX_40.test(String(binding.sourceCommit ?? ""))) {
    fail("ECORPUS_BINDING_INVALID", "sourceCommit must be full 40-hex", { status: 400 });
  }
  for (const key of [
    "providerBundleDigest", "corpusManifestHash", "privateIndexDigest",
    "evaluatorSourceHash", "testReportHash", "gateEpoch",
  ]) {
    if (!HEX_64.test(String(binding[key] ?? ""))) {
      fail("ECORPUS_BINDING_INVALID", `${key} must be 64-hex`, { status: 400 });
    }
  }
  if (!SAFE_KEY_ID.test(String(binding.digestKeyId ?? ""))) {
    fail("ECORPUS_BINDING_INVALID", "digestKeyId is missing or malformed", { status: 400 });
  }
  return Object.freeze(Object.fromEntries(BINDING_KEYS.map((key) => [key, String(binding[key])])));
}

function assertSameOwner(actual, expected) {
  for (const key of OWNER_KEYS) {
    if (actual[key] !== expected[key]) {
      fail(
        key === "callerPathHash" ? "ECORPUS_CALLER_PATH_FORBIDDEN" : "ECORPUS_TASK_OWNER_MISMATCH",
        `E-Corpus owner ${key} differs from the task-owned binding`,
        { status: 403, details: { field: key } },
      );
    }
  }
}

function assertSameBinding(actual, expected) {
  for (const key of BINDING_KEYS) {
    if (actual[key] !== expected[key]) {
      fail(BINDING_MISMATCH_CODES[key] ?? "ECORPUS_BINDING_MISMATCH", `E-Corpus ${key} binding differs`, {
        status: 403,
        details: { field: key },
      });
    }
  }
}

function normalizeRef(ref) {
  assertExactKeys(ref, [...REF_KEYS], "ECORPUS_REF_INVALID", "E-Corpus reference");
  if (ref.schemaId !== XHS_E_CORPUS_PASS_REF_SCHEMA_ID
    || !HEX_64.test(String(ref.artifactHash ?? ""))
    || !HEX_64.test(String(ref.bindingHash ?? ""))
    || !HEX_64.test(String(ref.gateEpoch ?? ""))
    || !Number.isInteger(ref.expiresAtMs) || ref.expiresAtMs <= 0) {
    fail("ECORPUS_REF_INVALID", "E-Corpus reference is malformed", { status: 400 });
  }
  return Object.freeze({
    schemaId: XHS_E_CORPUS_PASS_REF_SCHEMA_ID,
    artifactHash: ref.artifactHash,
    bindingHash: ref.bindingHash,
    gateEpoch: ref.gateEpoch,
    expiresAtMs: ref.expiresAtMs,
  });
}

export function validateECorpusPassRef(ref) {
  return normalizeRef(ref);
}

export function eCorpusArtifactRef(artifact) {
  return Object.freeze({
    schemaId: XHS_E_CORPUS_PASS_REF_SCHEMA_ID,
    artifactHash: artifact.artifactHash,
    bindingHash: sha256(canonicalJson(artifact.binding)),
    gateEpoch: artifact.binding.gateEpoch,
    expiresAtMs: artifact.expiresAtMs,
  });
}

function validateArtifactShape(artifact) {
  assertExactKeys(artifact, [...ARTIFACT_KEYS], "ECORPUS_ARTIFACT_INVALID", "E-Corpus artifact");
  if (artifact.schemaId !== XHS_E_CORPUS_PASS_SCHEMA_ID
    || artifact.schemaVersion !== XHS_E_CORPUS_PASS_SCHEMA_VERSION) {
    fail("ECORPUS_SCHEMA_INVALID", "E-Corpus artifact schema mismatch", { status: 400 });
  }
  if (artifact.status !== "PASS") {
    fail("ECORPUS_STATUS_NOT_PASS", "only an exact E-Corpus PASS artifact can unlock R3", { status: 403 });
  }
  if (!Number.isInteger(artifact.issuedAtMs) || !Number.isInteger(artifact.expiresAtMs)
    || artifact.issuedAtMs < 0 || artifact.expiresAtMs <= artifact.issuedAtMs) {
    fail("ECORPUS_TIME_INVALID", "E-Corpus validity window is malformed", { status: 400 });
  }
  const owner = normalizeOwner(artifact.owner);
  const binding = normalizeECorpusBinding(artifact.binding);
  if (!HEX_64.test(String(artifact.artifactHash ?? ""))) {
    fail("ECORPUS_ARTIFACT_HASH_INVALID", "artifactHash must be 64-hex", { status: 400 });
  }
  assertExactKeys(artifact.seal, ["algorithm", "digestKeyId", "digest"], "ECORPUS_SEAL_INVALID", "E-Corpus seal");
  if (artifact.seal.algorithm !== "HMAC-SHA-256"
    || !SAFE_KEY_ID.test(String(artifact.seal.digestKeyId ?? ""))
    || !HEX_64.test(String(artifact.seal.digest ?? ""))) {
    fail("ECORPUS_SEAL_INVALID", "E-Corpus seal is malformed", { status: 400 });
  }
  return { owner, binding };
}

function artifactUnsignedBody(artifact) {
  return {
    schemaId: artifact.schemaId,
    schemaVersion: artifact.schemaVersion,
    status: artifact.status,
    issuedAtMs: artifact.issuedAtMs,
    expiresAtMs: artifact.expiresAtMs,
    owner: artifact.owner,
    binding: artifact.binding,
  };
}

function assertTaskCaller(caller, owner) {
  const normalized = normalizeOwner(caller);
  assertSameOwner(normalized, owner);
  return normalized;
}

function assertFixedRoot({ artifactRoot, canonicalArtifactRoot }) {
  if (!isAbsolute(artifactRoot) || !isAbsolute(canonicalArtifactRoot)
    || resolve(artifactRoot) !== resolve(canonicalArtifactRoot)) {
    fail(
      "ECORPUS_CALLER_PATH_FORBIDDEN",
      "E-Corpus storage must use the fixed task-owned artifact root",
      { status: 403 },
    );
  }
}

/**
 * Create the task-owned registry/store.  Production supplies a fixed root,
 * task binding, key ring, and ACL verifier from startup configuration.  Tests
 * may inject filesystem primitives but cannot introduce a path parameter to
 * seal/verify.
 */
export function createECorpusPassStore({
  artifactRoot,
  canonicalArtifactRoot = artifactRoot,
  owner,
  keyring,
  aclChecker,
  now = Date.now,
  maxValidityMs = XHS_E_CORPUS_PASS_MAX_VALIDITY_MS,
  acceptExactExisting = false,
  fsImpl = { mkdirSync, readFileSync, statSync, writeFileSync },
} = {}) {
  if (!artifactRoot || typeof artifactRoot !== "string") {
    fail("ECORPUS_ARTIFACT_ROOT_REQUIRED", "fixed E-Corpus artifact root is required", { status: 500 });
  }
  assertFixedRoot({ artifactRoot, canonicalArtifactRoot });
  const fixedRoot = resolve(artifactRoot);
  const fixedOwner = normalizeOwner(owner);
  if (!keyring || typeof keyring.activeKeyId !== "function"
    || typeof keyring.sign !== "function" || typeof keyring.verify !== "function") {
    fail("ECORPUS_KEYRING_REQUIRED", "E-Corpus store requires the production digest key ring", { status: 500 });
  }
  if (typeof aclChecker !== "function") {
    fail("ECORPUS_ACL_CHECKER_REQUIRED", "E-Corpus store requires a deny-by-default ACL verifier", { status: 500 });
  }
  if (!Number.isInteger(maxValidityMs) || maxValidityMs <= 0
    || maxValidityMs > XHS_E_CORPUS_PASS_MAX_VALIDITY_MS) {
    fail("ECORPUS_VALIDITY_POLICY_INVALID", "E-Corpus max validity exceeds the fixed 24-hour ceiling", { status: 500 });
  }
  if (typeof acceptExactExisting !== "boolean") {
    fail("ECORPUS_REPLAY_POLICY_INVALID", "exact-existing replay policy must be boolean", { status: 500 });
  }

  function checkAcl(path, kind) {
    let ok = false;
    try {
      ok = aclChecker({ path, kind, stat: fsImpl.statSync(path) }) === true;
    } catch (error) {
      fail("ECORPUS_ACL_UNVERIFIABLE", `cannot verify ${kind} ACL: ${error?.message || error}`, { status: 503 });
    }
    if (!ok) fail("ECORPUS_ACL_INVALID", `${kind} is not task-owned/deny-by-default`, { status: 503 });
  }

  function pathForHash(artifactHash) {
    if (!HEX_64.test(String(artifactHash ?? ""))) {
      fail("ECORPUS_REF_INVALID", "artifact hash must be 64-hex", { status: 400 });
    }
    return join(fixedRoot, artifactHash, XHS_E_CORPUS_PASS_ARTIFACT_NAME);
  }

  function seal(input = {}) {
    assertExactKeys(input, ["binding", "expiresAtMs", "caller"], "ECORPUS_CALLER_FIELDS_FORBIDDEN", "E-Corpus seal request");
    const { binding, expiresAtMs, caller } = input;
    assertTaskCaller(caller, fixedOwner);
    const normalizedBinding = normalizeECorpusBinding(binding);
    const activeKeyId = keyring.activeKeyId();
    if (normalizedBinding.digestKeyId !== activeKeyId) {
      fail("ECORPUS_KEY_MISMATCH", "sealer binding is not pinned to the active production key", { status: 403 });
    }
    const issuedAtMs = Number(now());
    if (!Number.isInteger(issuedAtMs) || !Number.isInteger(expiresAtMs)
      || expiresAtMs <= issuedAtMs || expiresAtMs - issuedAtMs > maxValidityMs) {
      fail("ECORPUS_TIME_INVALID", "E-Corpus artifact must have a positive validity window within 24 hours", { status: 400 });
    }
    const body = {
      schemaId: XHS_E_CORPUS_PASS_SCHEMA_ID,
      schemaVersion: XHS_E_CORPUS_PASS_SCHEMA_VERSION,
      status: "PASS",
      issuedAtMs,
      expiresAtMs,
      owner: fixedOwner,
      binding: normalizedBinding,
    };
    const artifactHash = sha256(canonicalJson(body));
    const signed = keyring.sign({ kind: XHS_E_CORPUS_PASS_SEAL_KIND, value: artifactHash });
    if (signed.digestKeyId !== activeKeyId || !HEX_64.test(String(signed.digest ?? ""))) {
      fail("ECORPUS_SEAL_INVALID", "key ring returned a malformed or drifted seal", { status: 503 });
    }
    const artifact = Object.freeze({
      ...body,
      artifactHash,
      seal: Object.freeze({ algorithm: "HMAC-SHA-256", digestKeyId: activeKeyId, digest: signed.digest }),
    });
    validateArtifactShape(artifact);
    const artifactBytes = canonicalJson(artifact);
    fsImpl.mkdirSync(fixedRoot, { recursive: true, mode: 0o700 });
    checkAcl(fixedRoot, "artifact-root");
    const directory = join(fixedRoot, artifactHash);
    try {
      fsImpl.mkdirSync(directory, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (!acceptExactExisting || error?.code !== "EEXIST") {
        fail("ECORPUS_ARTIFACT_EXISTS", `refusing to overwrite/re-mint E-Corpus artifact ${artifactHash}: ${error?.code || error}`, { status: 409 });
      }
    }
    const artifactPath = pathForHash(artifactHash);
    try {
      fsImpl.writeFileSync(artifactPath, artifactBytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!acceptExactExisting || error?.code !== "EEXIST") {
        fail("ECORPUS_ARTIFACT_EXISTS", `refusing to overwrite/re-mint E-Corpus artifact ${artifactHash}: ${error?.code || error}`, { status: 409 });
      }
      let existing;
      try {
        existing = fsImpl.readFileSync(artifactPath, "utf8");
      } catch (readError) {
        fail("ECORPUS_ARTIFACT_EXISTS", `existing E-Corpus artifact cannot be verified: ${readError?.code || readError}`, { status: 409 });
      }
      if (existing !== artifactBytes) {
        fail("ECORPUS_ARTIFACT_EXISTS", "existing E-Corpus artifact bytes differ from the exact retry", { status: 409 });
      }
    }
    checkAcl(directory, "artifact-directory");
    checkAcl(artifactPath, "artifact-file");
    return { artifact, ref: eCorpusArtifactRef(artifact), path: artifactPath };
  }

  function verify(input = {}) {
    assertExactKeys(input, ["ref", "expectedBinding", "caller"], "ECORPUS_CALLER_FIELDS_FORBIDDEN", "E-Corpus verify request");
    const { ref, expectedBinding, caller } = input;
    assertTaskCaller(caller, fixedOwner);
    const normalizedRef = normalizeRef(ref);
    const expected = normalizeECorpusBinding(expectedBinding);
    const artifactPath = pathForHash(normalizedRef.artifactHash);
    let raw;
    try {
      raw = fsImpl.readFileSync(artifactPath, "utf8");
    } catch (error) {
      fail("ECORPUS_ARTIFACT_ABSENT", "task-owned E-Corpus artifact is absent", { status: 403 });
    }
    checkAcl(fixedRoot, "artifact-root");
    checkAcl(join(fixedRoot, normalizedRef.artifactHash), "artifact-directory");
    checkAcl(artifactPath, "artifact-file");
    let artifact;
    try {
      artifact = JSON.parse(raw);
    } catch (error) {
      fail("ECORPUS_ARTIFACT_INVALID", `E-Corpus artifact is not JSON: ${error?.message || error}`, { status: 400 });
    }
    if (raw !== canonicalJson(artifact)) {
      fail("ECORPUS_NONCANONICAL_BYTES", "E-Corpus file bytes are not canonical", { status: 409 });
    }
    const { owner: actualOwner, binding: actualBinding } = validateArtifactShape(artifact);
    assertSameOwner(actualOwner, fixedOwner);
    assertSameBinding(actualBinding, expected);
    const recomputedHash = sha256(canonicalJson(artifactUnsignedBody(artifact)));
    if (artifact.artifactHash !== recomputedHash || artifact.artifactHash !== normalizedRef.artifactHash) {
      fail("ECORPUS_ARTIFACT_HASH_MISMATCH", "E-Corpus body/path/reference hash mismatch", { status: 403 });
    }
    const expectedRef = eCorpusArtifactRef(artifact);
    if (canonicalJson(expectedRef) !== canonicalJson(normalizedRef)) {
      fail("ECORPUS_REPLAY_REJECTED", "E-Corpus reference was copied or rebound", { status: 403 });
    }
    const nowMs = Number(now());
    if (!Number.isInteger(nowMs) || artifact.issuedAtMs > nowMs
      || artifact.expiresAtMs <= nowMs
      || artifact.expiresAtMs - artifact.issuedAtMs > maxValidityMs) {
      fail("ECORPUS_ARTIFACT_STALE", "E-Corpus artifact is future-dated, expired, or overlong", { status: 403 });
    }
    const activeKeyId = keyring.activeKeyId();
    if (artifact.binding.digestKeyId !== artifact.seal.digestKeyId
      || artifact.seal.digestKeyId !== activeKeyId) {
      fail("ECORPUS_KEY_MISMATCH", "E-Corpus artifact is not sealed by the current active deployment key", { status: 403 });
    }
    let verified;
    try {
      verified = keyring.verify({
        digestKeyId: artifact.seal.digestKeyId,
        kind: XHS_E_CORPUS_PASS_SEAL_KIND,
        value: artifact.artifactHash,
        digest: artifact.seal.digest,
      });
    } catch (error) {
      fail("ECORPUS_SEAL_INVALID", `E-Corpus seal could not be verified: ${error?.code || error}`, { status: 403 });
    }
    if (verified?.ok !== true || verified?.keyStatus !== "active") {
      fail("ECORPUS_SEAL_INVALID", "E-Corpus HMAC is forged or uses a retained key", { status: 403 });
    }
    return Object.freeze({
      ok: true,
      status: "PASS",
      artifactHash: artifact.artifactHash,
      ref: expectedRef,
      binding: actualBinding,
      owner: actualOwner,
      effectiveVisualPermitBudget: 1,
    });
  }

  return Object.freeze({
    artifactRoot: fixedRoot,
    owner: fixedOwner,
    seal,
    verify,
  });
}

/** A default CP interlock: all phases are locked until startup injects a store-backed verifier. */
export function createLockedECorpusInterlock() {
  return Object.freeze({
    verifyR3() {
      fail("ECORPUS_INTERLOCK_NOT_CONFIGURED", "R3 visual authority is locked: no task-owned E-Corpus verifier is configured", { status: 503 });
    },
  });
}

/** Bind a fixed store/expected tuple once at task startup; callers supply no paths or bindings. */
export function createStoreBackedECorpusInterlock({ store, expectedBinding, taskCaller } = {}) {
  if (!store || typeof store.verify !== "function") {
    fail("ECORPUS_STORE_REQUIRED", "store-backed interlock requires a task-owned store", { status: 500 });
  }
  const fixedExpected = normalizeECorpusBinding(expectedBinding);
  const fixedCaller = normalizeOwner(taskCaller);
  return Object.freeze({
    verifyR3(input = {}) {
      assertExactKeys(
        input,
        ["ref", "releaseId", "sourceCommit", "providerBundleDigest"],
        "ECORPUS_CALLER_FIELDS_FORBIDDEN",
        "R3 E-Corpus verification request",
      );
      const { ref, releaseId, sourceCommit, providerBundleDigest } = input;
      if (releaseId !== fixedExpected.releaseId) {
        fail("ECORPUS_RELEASE_MISMATCH", "runtime release differs from the Gate-E binding", { status: 403 });
      }
      if (sourceCommit !== fixedExpected.sourceCommit) {
        fail("ECORPUS_SOURCE_MISMATCH", "runtime source differs from the Gate-E binding", { status: 403 });
      }
      if (providerBundleDigest !== fixedExpected.providerBundleDigest) {
        fail("ECORPUS_PROVIDER_MISMATCH", "runtime provider differs from the Gate-E binding", { status: 403 });
      }
      return store.verify({ ref, expectedBinding: fixedExpected, caller: fixedCaller });
    },
  });
}
