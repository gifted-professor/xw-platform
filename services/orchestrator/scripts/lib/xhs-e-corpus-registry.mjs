/**
 * Task-owned Registry facade for xw.xhs.e-corpus-pass.v1.
 *
 * A caller can request only an expiry. The fixed task loader supplies the
 * sealed corpus, the fixed release evaluator executes it, and this module
 * independently reproduces every hash in the PASS binding before asking the
 * production store to sign. No API accepts a corpus path, corpus bundle,
 * evaluator result, binding hash, owner, provider, or gate epoch.
 */
import { join } from "node:path";

import {
  createECorpusPassStore,
  createStoreBackedECorpusInterlock,
} from "../../../control-plane/control-plane/lib/xhs-e-corpus-pass.mjs";
import {
  XHS_CORPUS_REQUIRED_ROUTES,
  canonicalJson,
  sha256Hex,
  validateSealedCorpusBundle,
} from "./xhs-exploration-corpus-operator.mjs";

export const XHS_E_CORPUS_PASS_ROOT = join(
  "C:\\",
  "Users",
  "Public",
  "xw-runtime",
  "state",
  "orchestrator",
  "e-corpus-pass",
);
export const XHS_E_CORPUS_EVALUATION_REPORT_SCHEMA_ID =
  "xw.xhs.e-corpus-production-evaluation.v1";

const OWNER_FIELDS = ["taskName", "taskBindingHash", "launcherHash", "callerPathHash"];
const RUNTIME_FIELDS = ["releaseId", "sourceCommit", "providerBundleDigest", "digestKeyId"];
const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_40 = /^[0-9a-f]{40}$/;
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/;
const ZERO_SAFETY = Object.freeze({
  socialTransport: 0,
  effectTransport: 0,
  visualIssued: 0,
  visualConsumed: 0,
  visualPhysical: 0,
});

function fail(code, message) {
  throw Object.assign(new Error(`${code}: ${message}`), { code });
}

function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key)));
}

function fixedOwner(taskBinding) {
  if (!exactObject(taskBinding, OWNER_FIELDS)
    || !SAFE_TASK_NAME.test(String(taskBinding.taskName ?? ""))
    || OWNER_FIELDS.slice(1).some((key) => !HEX_64.test(String(taskBinding[key] ?? "")))) {
    fail("ECORPUS_TASK_OWNER_INVALID", "task binding must be the exact fixed owner tuple");
  }
  return Object.freeze(Object.fromEntries(OWNER_FIELDS.map((key) => [key, taskBinding[key]])));
}

function fixedRuntimeBinding(expectedRuntime) {
  if (!exactObject(expectedRuntime, RUNTIME_FIELDS)
    || !SAFE_ID.test(String(expectedRuntime.releaseId ?? ""))
    || !HEX_40.test(String(expectedRuntime.sourceCommit ?? ""))
    || !HEX_64.test(String(expectedRuntime.providerBundleDigest ?? ""))
    || !/^[A-Za-z0-9-]{1,64}$/.test(String(expectedRuntime.digestKeyId ?? ""))) {
    fail("ECORPUS_RUNTIME_BINDING_INVALID", "release/provider/key runtime tuple is invalid");
  }
  return Object.freeze(Object.fromEntries(RUNTIME_FIELDS.map((key) => [key, expectedRuntime[key]])));
}

function exactBytes(value, label) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  fail("ECORPUS_EVALUATOR_SOURCE_INVALID", `${label} must be exact bytes`);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeCases(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("ECORPUS_EVALUATION_FAILED", `${label} must contain at least one executed case`);
  }
  const ids = new Set();
  return value.map((entry) => {
    if (!exactObject(entry, ["id", "passed"])
      || !SAFE_ID.test(String(entry.id ?? "")) || ids.has(entry.id)
      || entry.passed !== true) {
      fail("ECORPUS_EVALUATION_FAILED", `${label} contains a failed, duplicate, or malformed case`);
    }
    ids.add(entry.id);
    return Object.freeze({ id: entry.id, passed: true });
  });
}

function normalizeEvaluationOutcome(outcome) {
  if (!exactObject(outcome, ["providerOracleCases", "adverseMutationCases", "safety"])
    || !exactObject(outcome.safety, Object.keys(ZERO_SAFETY))
    || Object.entries(ZERO_SAFETY).some(([key, expected]) => outcome.safety[key] !== expected)) {
    fail("ECORPUS_EVALUATION_FAILED", "production evaluator outcome is incomplete or violates hard zero");
  }
  return Object.freeze({
    providerOracleCases: Object.freeze(normalizeCases(outcome.providerOracleCases, "provider oracle")),
    adverseMutationCases: Object.freeze(normalizeCases(outcome.adverseMutationCases, "adverse mutations")),
    safety: ZERO_SAFETY,
  });
}

function assertCountingRowsAreCpBound(bundle) {
  const rows = bundle?.publicManifest?.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    fail("ECORPUS_CORPUS_INVALID", "sealed corpus has no public rows");
  }
  const counting = rows.filter((row) => row?.provenance?.countingEligible === true);
  if (counting.length === 0 || counting.some((row) => (
    row?.provenance?.captureMode !== "CP_BOUND_R1_R2"
      || !["R1", "R2"].includes(row?.provenance?.phase)
  ))) {
    fail("ECORPUS_CAPTURE_MODE_INVALID", "every counting row must be a CP-bound R1/R2 capture");
  }
}

/**
 * Reproduce the complete signed E-PASS binding from immutable corpus and
 * evaluator inputs.  The fixed listener uses this both before sealing and
 * when reopening an artifact after restart; no persisted artifact field is
 * treated as the expected corpus/evaluator tuple.
 */
export function deriveVerifiedECorpusPassMaterial({
  sealedCorpus,
  evaluatorOutcome,
  expectedRuntime,
  gateEpoch,
  corpusSigningKey,
  evaluatorSourceBytes,
} = {}) {
  const runtime = fixedRuntimeBinding(expectedRuntime);
  if (!HEX_64.test(String(gateEpoch ?? ""))) {
    fail("ECORPUS_GATE_EPOCH_INVALID", "fixed Gate-F epoch must be 64-hex");
  }
  const signingKey = exactBytes(corpusSigningKey, "corpus signing key");
  if (signingKey.length < 32) {
    fail("ECORPUS_SIGNING_KEY_INVALID", "corpus signing key must be at least 256 bits");
  }
  const validation = validateSealedCorpusBundle(sealedCorpus, {
    signingKey,
    digestKeyId: runtime.digestKeyId,
    expectedRuntime: runtime,
  });
  if (validation.passed !== true || validation.coverage?.complete !== true) {
    fail("ECORPUS_CORPUS_INVALID", "sealed corpus did not reproduce a complete PASS");
  }
  assertCountingRowsAreCpBound(sealedCorpus);
  const corpusManifestHash = sha256Hex(Buffer.from(
    canonicalJson(sealedCorpus.publicManifest),
    "utf8",
  ));
  if (corpusManifestHash !== validation.publicManifestHash
    || corpusManifestHash !== sealedCorpus.privateIndex?.publicManifestHash) {
    fail("ECORPUS_CORPUS_HASH_MISMATCH", "public corpus manifest hash did not reproduce");
  }
  const privateIndexDigest = sha256Hex(Buffer.from(
    canonicalJson(sealedCorpus.privateIndex),
    "utf8",
  ));
  const outcome = normalizeEvaluationOutcome(evaluatorOutcome);
  const evaluatorSourceHash = sha256Hex(exactBytes(evaluatorSourceBytes, "evaluator source"));
  const testReport = Object.freeze({
    schemaId: XHS_E_CORPUS_EVALUATION_REPORT_SCHEMA_ID,
    schemaVersion: 1,
    status: "PASS",
    runtime,
    corpus: Object.freeze({
      corpusManifestHash,
      privateIndexDigest,
      requiredRoutes: Object.freeze([...XHS_CORPUS_REQUIRED_ROUTES]),
      countingRows: validation.coverage.countingRows,
    }),
    evaluatorSourceHash,
    providerOracleCases: outcome.providerOracleCases,
    adverseMutationCases: outcome.adverseMutationCases,
    safety: outcome.safety,
  });
  const testReportHash = sha256Hex(Buffer.from(canonicalJson(testReport), "utf8"));
  const binding = Object.freeze({
    releaseId: runtime.releaseId,
    sourceCommit: runtime.sourceCommit,
    providerBundleDigest: runtime.providerBundleDigest,
    corpusManifestHash,
    privateIndexDigest,
    evaluatorSourceHash,
    testReportHash,
    digestKeyId: runtime.digestKeyId,
    gateEpoch,
  });
  return Object.freeze({
    binding,
    evaluation: Object.freeze({ testReport, testReportHash }),
  });
}

/**
 * Dependency-injected core used by the production facade and integration
 * tests. The store and all loaders/evaluators are fixed once; the returned
 * sealer accepts no evidence or binding material from its caller.
 */
export function createVerifiedECorpusSealer({
  store,
  taskBinding,
  expectedRuntime,
  gateEpoch,
  corpusSigningKey,
  loadSealedCorpus,
  evaluateCorpus,
  evaluatorSourceBytes,
} = {}) {
  if (!store || typeof store.seal !== "function") {
    fail("ECORPUS_STORE_REQUIRED", "task-owned E-Corpus store is required");
  }
  const taskCaller = fixedOwner(taskBinding);
  const runtime = fixedRuntimeBinding(expectedRuntime);
  if (!HEX_64.test(String(gateEpoch ?? ""))) {
    fail("ECORPUS_GATE_EPOCH_INVALID", "fixed Gate-F epoch must be 64-hex");
  }
  if (typeof loadSealedCorpus !== "function" || typeof evaluateCorpus !== "function") {
    fail("ECORPUS_FIXED_PIPELINE_REQUIRED", "fixed corpus loader and evaluator are required");
  }
  const signingKey = exactBytes(corpusSigningKey, "corpus signing key");
  if (signingKey.length < 32) {
    fail("ECORPUS_SIGNING_KEY_INVALID", "corpus signing key must be at least 256 bits");
  }
  exactBytes(evaluatorSourceBytes, "evaluator source");
  let sealedBinding = null;

  return Object.freeze({
    async sealPass(input = {}) {
      if (!exactObject(input, ["expiresAtMs"])) {
        fail("ECORPUS_CALLER_FIELDS_FORBIDDEN", "PASS caller may supply only expiresAtMs");
      }
      const bundle = await loadSealedCorpus();
      const validation = validateSealedCorpusBundle(bundle, {
        signingKey,
        digestKeyId: runtime.digestKeyId,
        expectedRuntime: runtime,
      });
      if (validation.passed !== true || validation.coverage?.complete !== true) {
        fail("ECORPUS_CORPUS_INVALID", "sealed corpus did not reproduce a complete PASS");
      }
      assertCountingRowsAreCpBound(bundle);
      const corpusManifestHash = sha256Hex(Buffer.from(canonicalJson(bundle.publicManifest), "utf8"));
      if (corpusManifestHash !== validation.publicManifestHash
        || corpusManifestHash !== bundle.privateIndex?.publicManifestHash) {
        fail("ECORPUS_CORPUS_HASH_MISMATCH", "public corpus manifest hash did not reproduce");
      }
      const privateIndexDigest = sha256Hex(Buffer.from(canonicalJson(bundle.privateIndex), "utf8"));
      const evaluatorInput = deepFreeze(structuredClone({
        bundle,
        runtime,
        corpusManifestHash,
        privateIndexDigest,
      }));
      const material = deriveVerifiedECorpusPassMaterial({
        sealedCorpus: bundle,
        evaluatorOutcome: await evaluateCorpus(evaluatorInput),
        expectedRuntime: runtime,
        gateEpoch,
        corpusSigningKey: signingKey,
        evaluatorSourceBytes,
      });
      const sealed = store.seal({
        binding: material.binding,
        expiresAtMs: input.expiresAtMs,
        caller: taskCaller,
      });
      sealedBinding = material.binding;
      return Object.freeze({
        ...sealed,
        evaluation: material.evaluation,
      });
    },
    createInterlock(input = {}) {
      if (!exactObject(input, [])) {
        fail("ECORPUS_CALLER_FIELDS_FORBIDDEN", "interlock accepts no caller binding or path");
      }
      if (!sealedBinding) {
        fail("ECORPUS_PASS_NOT_SEALED", "no verified task-owned PASS is available in this task lifetime");
      }
      return createStoreBackedECorpusInterlock({
        store,
        expectedBinding: sealedBinding,
        taskCaller,
      });
    },
  });
}

/** Production facade: the artifact root is constant and not an argument. */
export function createTaskOwnedXhsECorpusRegistry({
  keyring,
  taskBinding,
  aclChecker,
  now = Date.now,
  expectedRuntime,
  gateEpoch,
  corpusSigningKey,
  loadSealedCorpus,
  evaluateCorpus,
  evaluatorSourceBytes,
} = {}) {
  const taskCaller = fixedOwner(taskBinding);
  const store = createECorpusPassStore({
    artifactRoot: XHS_E_CORPUS_PASS_ROOT,
    canonicalArtifactRoot: XHS_E_CORPUS_PASS_ROOT,
    owner: taskCaller,
    keyring,
    aclChecker,
    now,
    acceptExactExisting: true,
  });
  const verified = createVerifiedECorpusSealer({
    store,
    taskBinding: taskCaller,
    expectedRuntime,
    gateEpoch,
    corpusSigningKey,
    loadSealedCorpus,
    evaluateCorpus,
    evaluatorSourceBytes,
  });
  return Object.freeze({
    ...verified,
    artifactRoot: XHS_E_CORPUS_PASS_ROOT,
  });
}
