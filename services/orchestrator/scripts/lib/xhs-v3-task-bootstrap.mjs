/**
 * Formal XHS V3 task bootstrap.
 *
 * The production constructor has no path, endpoint, alias, provider, role, or
 * evidence override.  It is created once inside the Gate-F-owned Control Plane
 * listener.  Per-request authority is deliberately limited to a rollout phase
 * plus an opaque invocation id, or an opaque corpus-set id plus a closed expiry
 * policy.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { createDigestKeyring } from
  "../../../control-plane/control-plane/lib/xhs-evidence-digest-keyring.mjs";
import {
  XHS_E_CORPUS_PASS_ARTIFACT_NAME,
  createECorpusPassStore,
  createStoreBackedECorpusInterlock,
  eCorpusArtifactRef,
} from "../../../control-plane/control-plane/lib/xhs-e-corpus-pass.mjs";
import {
  buildSystemTcbAclPlan,
  createSystemTcbAclController,
} from "../../../control-plane/control-plane/lib/windows-system-tcb-acl.mjs";
import { createExplorerRoutineRuntime } from "../../ops/_xhs-routine-explorer-runtime.mjs";
import {
  EXPLORATION_VISION_FIXED_PROVIDER_BUNDLE_DIGEST,
  EXPLORATION_VISION_CONFIG_PATH,
} from "../../ops/xw-xhs-vision-pin.mjs";
import {
  XHS_E_CORPUS_PASS_ROOT,
  createTaskOwnedXhsECorpusRegistry,
  deriveVerifiedECorpusPassMaterial,
} from "./xhs-e-corpus-registry.mjs";
import {
  XHS_CORPUS_ZERO_RESOURCES,
  canonicalJson,
  createFixtureCorpusAdapter,
  createOfflineCorpusOperator,
  sealBlindLabels,
  sealCorpusBundle,
  sha256Hex,
  validateSealedCorpusBundle,
  verifyCaptureReceipt,
} from "./xhs-exploration-corpus-operator.mjs";
import {
  XHS_EXPLORATION_VISION_CORPUS_MIN_FRAMES_PER_ROUTE,
  XHS_EXPLORATION_VISION_CORPUS_ROUTES,
  XHS_EXPLORATION_VISION_CORPUS_SCHEMA_ID,
  XHS_EXPLORATION_VISION_CORPUS_GATE_E_PROVENANCE,
  buildVisionCorpusDumpReceipt,
  createVisionCorpusProcessProviderAdapter,
  deriveVisionCorpusAnnotationHash,
  evaluateVisionCorpusGate,
} from "./xhs-exploration-vision-corpus.mjs";
import { compileExplorationMission } from "./xhs-exploration-mission.mjs";
import {
  XHS_V3_R0_RESULT_SCHEMA_ID,
  XHS_V3_TASK_INVOCATION_SCHEMA_ID,
  createTaskOwnedCpCaptureAuthority,
  createXhsV3ProductionRunner,
} from "./xhs-exploration-production-runner.mjs";
import { createXhsV3PostECorpusProductionRunner } from
  "./xhs-v3-post-e-production-runner.mjs";
import { verifyResolvedPrivateProviderConfig } from "./xhs-exploration-private-runtime.mjs";
import { createPinnedExplorationVisionAnalyzer } from "./xhs-exploration-vision-process.mjs";
import { resolvePinnedVisionConfig } from "./xhs-exploration-vision.mjs";
import { verifyPersistedSharedExplorationBudgetProof } from
  "./xhs-exploration-shared-budget.mjs";
import { planExplorationGoalRoutine } from "./xhs-routine-plan.mjs";

export const XHS_V3_TASK_BOOTSTRAP_SCHEMA_ID = "xw.xhs.v3-task-bootstrap.v1";
export const XHS_V3_GATE_F_IDENTITY_SCHEMA_ID = "xw.xhs.v3-gate-f-identity.v1";
export const XHS_V3_TASK_EVALUATOR_OUTCOME_SCHEMA_ID =
  "xw.xhs.v3-task-evaluator-outcome.v1";
export const XHS_V3_CORPUS_REVIEW_REQUEST_SCHEMA_ID =
  "xw.xhs.v3-corpus-review-request.v1";
export const XHS_V3_CORPUS_REVIEW_RESPONSE_SCHEMA_ID =
  "xw.xhs.v3-corpus-review-response.v1";
export const XHS_V3_TASK_RUN_RECORD_SCHEMA_ID = "xw.xhs.v3-task-run-record.v1";
export const XHS_V3_TASK_RUN_ATTEMPT_SCHEMA_ID = "xw.xhs.v3-task-run-attempt.v1";
export const XHS_V3_FREE_EXPLORATION_PASS_SCHEMA_ID =
  "xw.xhs.v3-free-exploration-pass.v1";
export const XHS_V3_FREE_EXPLORATION_PARTIAL_SCHEMA_ID =
  "xw.xhs.v3-free-exploration-closeout-partial.v1";
export const XHS_V3_P6_CURRENT_SCHEMA_ID = "xw.xhs.v3-p6-current.v1";
export const XHS_V3_TASK_NAME = "XW Platform Control Plane";
export const XHS_V3_EXPIRY_POLICIES = Object.freeze({
  GATE_F_SHORT: 60 * 60 * 1000,
});

export const XHS_V3_RUNTIME_ROOT = join("C:\\", "Users", "Public", "xw-runtime");
export const XHS_V3_TASK_PRIVATE_ROOT = join(
  XHS_V3_RUNTIME_ROOT,
  "private",
  "xhs-v3",
);
export const XHS_V3_TASK_INVOCATION_ROOT = join(XHS_V3_TASK_PRIVATE_ROOT, "invocations");
export const XHS_V3_TASK_CAPTURE_ROOT = join(XHS_V3_TASK_PRIVATE_ROOT, "captures");
export const XHS_V3_TASK_CORPUS_SET_ROOT = join(XHS_V3_TASK_PRIVATE_ROOT, "corpus-sets");
export const XHS_V3_TASK_RUN_ROOT = join(XHS_V3_TASK_PRIVATE_ROOT, "runs");
export const XHS_V3_TASK_ACCEPTANCE_ROOT = join(XHS_V3_TASK_PRIVATE_ROOT, "acceptance");
const XHS_V3_E_SEAL_INTENT_NAME = "e-corpus-seal-intent.v1.json";
const XHS_V3_E_SEAL_LOCATOR_NAME = "e-corpus-seal-locator.v1.json";
const XHS_V3_E_ARTIFACT_LOCATOR_NAME = "xw.xhs.e-corpus-task-locator.v1.json";
const XHS_V3_E_SEAL_INTENT_SCHEMA_ID = "xw.xhs.e-corpus-seal-intent.v1";
const XHS_V3_E_SEAL_LOCATOR_SCHEMA_ID = "xw.xhs.e-corpus-seal-locator.v1";
export const XHS_V3_TASK_KEYRING_PATH = join(
  XHS_V3_RUNTIME_ROOT,
  "secrets",
  "xhs-evidence-digest-keyring.v1.json",
);

const FIXED_BOOTSTRAP_ENV = Object.freeze({
  enabled: "XW_XHS_V3_TASK_BOOTSTRAP_ENABLED",
  taskName: "XW_XHS_V3_TASK_NAME",
  taskBindingHash: "XW_XHS_V3_TASK_BINDING_HASH",
  launcherHash: "XW_XHS_V3_LAUNCHER_HASH",
  callerPathHash: "XW_XHS_V3_CALLER_PATH_HASH",
  releaseId: "XW_XHS_V3_RELEASE_ID",
  sourceCommit: "XW_XHS_V3_SOURCE_COMMIT",
  providerBundleDigest: "XHS_EXPLORATION_VISION_PROVIDER_BUNDLE_DIGEST",
  providerConfigSha256: "XW_XHS_V3_PROVIDER_CONFIG_SHA256",
  digestKeyringSha256: "XW_XHS_V3_DIGEST_KEYRING_SHA256",
  accountFingerprint: "XW_M6_ACCOUNT_ISOLATION_BINDING_HASH",
});
const IDENTITY_KEYS = Object.freeze([
  "schemaId", "taskName", "taskBindingHash", "launcherHash", "callerPathHash",
  "releaseId", "sourceCommit", "providerBundleDigest", "providerConfigSha256",
  "digestKeyringSha256", "accountFingerprint",
]);
const OWNER_KEYS = Object.freeze(["taskName", "taskBindingHash", "launcherHash", "callerPathHash"]);
const RUNTIME_KEYS = Object.freeze([
  "releaseId", "sourceCommit", "providerBundleDigest", "digestKeyId", "accountFingerprint",
]);
const INVOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HEX40 = /^(?!0{40}$)[0-9a-f]{40}$/u;
const HEX64 = /^(?!0{64}$)[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const MAX_INVOCATION_BYTES = 4 * 1024 * 1024;
const MAX_CORPUS_BYTES = 64 * 1024 * 1024;
const BUILTIN_BENIGN_GOAL = "有界浏览公开的早餐与城市旅行内容";
const BUILTIN_BENIGN_QUERIES = Object.freeze(["城市旅行攻略"]);
const GATE_STATUS_KEYS = Object.freeze([
  "schemaId", "mode", "phase", "purpose", "epochHash", "generation", "locksHash",
  "tripleConsistent", "errors", "activeAuthorizationCount", "actionCount", "resourceCounts",
]);

const DEFAULT_FS = Object.freeze({
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
});

function fail(code, message, details = {}) {
  throw Object.assign(new Error(`${code}: ${message}`), { code, details });
}

function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key)));
}

function fixedObject(value, keys, code) {
  if (!exactObject(value, keys)) fail(code, "object fields drifted from the fixed schema");
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

function within(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertPlainDirectory(path, fsImpl, code) {
  let stat;
  try {
    stat = fsImpl.lstatSync(path);
  } catch {
    fail(code, "private directory is absent or unreadable");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || resolve(fsImpl.realpathSync(path)) !== resolve(path)) {
    fail(code, "private directory is linked or reparsed");
  }
}

function readPlainFile(path, {
  fsImpl = DEFAULT_FS,
  maximumBytes,
  code,
} = {}) {
  let stat;
  try {
    stat = fsImpl.lstatSync(path);
  } catch {
    fail(code, "private file is absent or unreadable");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || !Number.isSafeInteger(stat.size) || stat.size < 2 || stat.size > maximumBytes
    || resolve(fsImpl.realpathSync(path)) !== resolve(path)) {
    fail(code, "private file is linked, reparsed, or outside its size bound");
  }
  return Buffer.from(fsImpl.readFileSync(path));
}

function parseCanonicalPrivateJson(bytes, code) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(code, "private file is not valid UTF-8 JSON");
  }
  if (bytes.toString("utf8") !== canonicalJson(value)) {
    fail(code, "private file bytes are not canonical JSON");
  }
  return value;
}

function writeExactCreateOnlyPrivateFile(path, value, {
  fsImpl = DEFAULT_FS,
  sealPrivateTree = () => true,
  maximumBytes = 4 * 1024 * 1024,
  code,
} = {}) {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  if (bytes.length > maximumBytes) fail(code, "private journal value exceeds its size bound");
  const acceptExisting = () => {
    const existing = readPlainFile(path, { fsImpl, maximumBytes, code });
    if (!existing.equals(bytes)) fail(code, "create-only private journal bytes drifted");
    sealPrivateTree(path);
    return value;
  };
  if (fsImpl.existsSync(path)) return acceptExisting();
  try {
    fsImpl.writeFileSync(path, bytes, { flag: "wx", mode: 0o600, flush: true });
    sealPrivateTree(path);
    return value;
  } catch (error) {
    if (error?.code?.startsWith?.("XHS_V3_")) throw error;
    if (fsImpl.existsSync(path)) return acceptExisting();
    fail(code, "create-only private journal could not be persisted");
  }
}

function eCorpusSealLocatorHash(locator) {
  const { locatorHash: _locatorHash, ...body } = locator;
  return sha256Bytes(Buffer.from(canonicalJson(body), "utf8"));
}

/**
 * Create-only publication of the two fixed locator copies. Tests inject a
 * filesystem that fails the second write to prove a restart accepts the first
 * exact copy and completes the pair without replacement.
 */
export function persistTaskOwnedECorpusLocatorPair({
  locator,
  artifactRoot,
  corpusSetRoot,
  fsImpl = DEFAULT_FS,
  sealPrivateTree = () => true,
} = {}) {
  if (typeof artifactRoot !== "string" || !isAbsolute(artifactRoot)
    || typeof corpusSetRoot !== "string" || !isAbsolute(corpusSetRoot)
    || typeof sealPrivateTree !== "function"
    || !exactObject(locator, [
      "schemaId", "schemaVersion", "locatorHash", "corpusSetId", "expiryPolicy",
      "runtime", "taskOwner", "gateEpoch", "ref", "binding", "testReportHash",
    ])
    || locator.schemaId !== XHS_V3_E_SEAL_LOCATOR_SCHEMA_ID || locator.schemaVersion !== 1
    || eCorpusSealLocatorHash(locator) !== locator.locatorHash
    || !INVOCATION_ID.test(String(locator.corpusSetId ?? ""))
    || String(locator.corpusSetId).includes("..")
    || !HEX64.test(String(locator.ref?.artifactHash ?? ""))) {
    fail("XHS_V3_E_CORPUS_LOCATOR_INVALID", "locator pair input is malformed");
  }
  const artifactLocatorPath = join(
    artifactRoot,
    locator.ref.artifactHash,
    XHS_V3_E_ARTIFACT_LOCATOR_NAME,
  );
  const corpusLocatorPath = join(
    corpusSetRoot,
    locator.corpusSetId,
    XHS_V3_E_SEAL_LOCATOR_NAME,
  );
  if (!within(artifactRoot, artifactLocatorPath) || !within(corpusSetRoot, corpusLocatorPath)) {
    fail("XHS_V3_E_CORPUS_PATH_ESCAPE", "locator pair escaped its fixed roots");
  }
  for (const path of [artifactLocatorPath, corpusLocatorPath]) {
    writeExactCreateOnlyPrivateFile(path, locator, {
      fsImpl,
      sealPrivateTree,
      maximumBytes: 4 * 1024 * 1024,
      code: "XHS_V3_E_CORPUS_LOCATOR_WRITE_FAILED",
    });
  }
  return Object.freeze({ artifactLocatorPath, corpusLocatorPath });
}

function validateIdentity(identity) {
  const fixed = fixedObject(identity, IDENTITY_KEYS, "XHS_V3_GATE_F_IDENTITY_INVALID");
  if (fixed.schemaId !== XHS_V3_GATE_F_IDENTITY_SCHEMA_ID
    || fixed.taskName !== XHS_V3_TASK_NAME
    || !HEX64.test(String(fixed.taskBindingHash ?? ""))
    || !HEX64.test(String(fixed.launcherHash ?? ""))
    || !HEX64.test(String(fixed.callerPathHash ?? ""))
    || !SAFE_ID.test(String(fixed.releaseId ?? ""))
    || !HEX40.test(String(fixed.sourceCommit ?? ""))
    || !HEX64.test(String(fixed.providerBundleDigest ?? ""))
    || !HEX64.test(String(fixed.providerConfigSha256 ?? ""))
    || !HEX64.test(String(fixed.digestKeyringSha256 ?? ""))
    || !HEX64.test(String(fixed.accountFingerprint ?? ""))) {
    fail("XHS_V3_GATE_F_IDENTITY_INVALID", "Gate-F identity is malformed");
  }
  if (fixed.providerBundleDigest !== EXPLORATION_VISION_FIXED_PROVIDER_BUNDLE_DIGEST) {
    fail("XHS_V3_PROVIDER_DRIFT", "Gate-F identity differs from the immutable provider bundle");
  }
  return fixed;
}

/** Read only the non-secret identity values injected by the verified launcher. */
export function loadXhsV3GateFIdentityFromEnv({ env = process.env, releaseIdentity = null } = {}) {
  if (env[FIXED_BOOTSTRAP_ENV.enabled] !== "1") {
    fail("XHS_V3_TASK_BOOTSTRAP_DISABLED", "formal task bootstrap is not enabled by Gate F");
  }
  const value = {
    schemaId: XHS_V3_GATE_F_IDENTITY_SCHEMA_ID,
    taskName: env[FIXED_BOOTSTRAP_ENV.taskName],
    taskBindingHash: env[FIXED_BOOTSTRAP_ENV.taskBindingHash],
    launcherHash: env[FIXED_BOOTSTRAP_ENV.launcherHash],
    callerPathHash: env[FIXED_BOOTSTRAP_ENV.callerPathHash],
    releaseId: env[FIXED_BOOTSTRAP_ENV.releaseId],
    sourceCommit: env[FIXED_BOOTSTRAP_ENV.sourceCommit],
    providerBundleDigest: env[FIXED_BOOTSTRAP_ENV.providerBundleDigest],
    providerConfigSha256: env[FIXED_BOOTSTRAP_ENV.providerConfigSha256],
    digestKeyringSha256: env[FIXED_BOOTSTRAP_ENV.digestKeyringSha256],
    accountFingerprint: env[FIXED_BOOTSTRAP_ENV.accountFingerprint],
  };
  const identity = validateIdentity(value);
  if (releaseIdentity
    && (releaseIdentity.releaseId !== identity.releaseId
      || releaseIdentity.sourceCommit !== identity.sourceCommit)) {
    fail("XHS_V3_RELEASE_IDENTITY_DRIFT", "loaded release differs from the verified launcher identity");
  }
  return identity;
}

/** The exact zero-resource CLOSED Gate snapshot required before each task operation. */
export function assertXhsV3GateFReadySnapshot(gate) {
  const resourceKeys = ["jobs", "leases", "runs", "sessions"];
  if (!exactObject(gate, GATE_STATUS_KEYS)
    || gate.schemaId !== "xw.m6-gate-f-operations-status.v1"
    || gate.mode !== "CLOSED" || gate.phase !== "CLOSED" || gate.purpose !== null
    || gate.tripleConsistent !== true
    || !Array.isArray(gate.errors) || gate.errors.length !== 0
    || gate.activeAuthorizationCount !== 0 || gate.actionCount !== 0
    || !Number.isSafeInteger(gate.generation) || gate.generation < 0
    || !HEX64.test(String(gate.epochHash ?? ""))
    || !HEX64.test(String(gate.locksHash ?? ""))
    || !exactObject(gate.resourceCounts, resourceKeys)
    || Object.values(gate.resourceCounts).some((count) => !Number.isSafeInteger(count) || count !== 0)) {
    fail("XHS_V3_GATE_F_NOT_READY", "task operation requires one exact CLOSED, consistent, zero-resource Gate F");
  }
  return Object.freeze({
    epochHash: gate.epochHash,
    generation: gate.generation,
    locksHash: gate.locksHash,
  });
}

function validateInvocation(value) {
  if (!exactObject(value, ["schemaId", "plan", "privatePayload"])
    || value.schemaId !== XHS_V3_TASK_INVOCATION_SCHEMA_ID) {
    fail("XHS_V3_TASK_INVOCATION_INVALID", "task invocation exact schema drifted");
  }
  return value;
}

/** Dependency-injected file loader used by the fixed production wrapper and tests. */
export function createTaskOwnedInvocationLoader({ root, fsImpl = DEFAULT_FS } = {}) {
  if (typeof root !== "string" || !isAbsolute(root)) {
    fail("XHS_V3_TASK_INVOCATION_ROOT_INVALID", "invocation root must be absolute");
  }
  const fixedRoot = resolve(root);
  return async function loadTaskInvocation(invocationId) {
    if (!INVOCATION_ID.test(String(invocationId ?? "")) || String(invocationId).includes("..")) {
      fail("XHS_V3_TASK_INVOCATION_ID_INVALID", "invocation id must be one opaque filename token");
    }
    const path = join(fixedRoot, `${invocationId}.v1.json`);
    if (!within(fixedRoot, path)) {
      fail("XHS_V3_TASK_INVOCATION_PATH_ESCAPE", "invocation id escaped the task-owned root");
    }
    const bytes = readPlainFile(path, {
      fsImpl,
      maximumBytes: MAX_INVOCATION_BYTES,
      code: "XHS_V3_TASK_INVOCATION_INVALID",
    });
    return validateInvocation(parseCanonicalPrivateJson(bytes, "XHS_V3_TASK_INVOCATION_INVALID"));
  };
}

/** Create-only writer paired with the fixed invocation loader. */
export function createTaskOwnedInvocationWriter({
  root,
  fsImpl = DEFAULT_FS,
  randomUUIDFn = randomUUID,
  sealPrivateTree = () => true,
} = {}) {
  if (typeof root !== "string" || !isAbsolute(root)
    || typeof randomUUIDFn !== "function" || typeof sealPrivateTree !== "function") {
    fail("XHS_V3_TASK_INVOCATION_ROOT_INVALID", "fixed invocation writer is unavailable");
  }
  const fixedRoot = resolve(root);
  return async function persistTaskInvocation(input = {}) {
    if (!exactObject(input, ["phase", "invocationId", "value"])
      || !["R0", "R1", "R2", "R3", "R4"].includes(input.phase)
      || !INVOCATION_ID.test(String(input.invocationId ?? ""))
      || String(input.invocationId).includes("..")) {
      fail("XHS_V3_TASK_INVOCATION_WRITE_INVALID", "writer accepts only phase, opaque id, and task-built value");
    }
    const value = validateInvocation(input.value);
    if (value.plan?.mission?.vision?.rolloutPhase !== input.phase) {
      fail("XHS_V3_TASK_INVOCATION_PHASE_DRIFT", "task-built mission phase differs from its immutable filename request");
    }
    assertPlainDirectory(fixedRoot, fsImpl, "XHS_V3_TASK_INVOCATION_ROOT_INVALID");
    const finalPath = join(fixedRoot, `${input.invocationId}.v1.json`);
    const stagePath = join(fixedRoot, `.pending-${randomUUIDFn()}.json`);
    if (!within(fixedRoot, finalPath) || !within(fixedRoot, stagePath)) {
      fail("XHS_V3_TASK_INVOCATION_PATH_ESCAPE", "task invocation escaped the fixed private root");
    }
    const bytes = Buffer.from(canonicalJson(value), "utf8");
    const receipt = Object.freeze({
      invocationId: input.invocationId,
      phase: input.phase,
      invocationHash: sha256Bytes(bytes),
    });
    const acceptExactExisting = () => {
      const existing = readPlainFile(finalPath, {
        fsImpl,
        maximumBytes: MAX_INVOCATION_BYTES,
        code: "XHS_V3_TASK_INVOCATION_EXISTS",
      });
      if (!existing.equals(bytes)) {
        fail("XHS_V3_TASK_INVOCATION_EXISTS", "task invocation id is already bound to different bytes");
      }
      sealPrivateTree(finalPath);
      return receipt;
    };
    if (fsImpl.existsSync(finalPath)) return acceptExactExisting();
    let stageCreated = false;
    try {
      fsImpl.writeFileSync(stagePath, bytes, { flag: "wx", mode: 0o600, flush: true });
      stageCreated = true;
      sealPrivateTree(stagePath);
      // Hard-link publication gives the destination true create-only
      // semantics on Windows; a same-id retry may only reproduce exact bytes.
      fsImpl.linkSync(stagePath, finalPath);
      fsImpl.unlinkSync(stagePath);
      stageCreated = false;
      sealPrivateTree(finalPath);
      return receipt;
    } catch (error) {
      if (stageCreated) {
        try { fsImpl.rmSync(stagePath, { force: true }); } catch { /* best effort */ }
      }
      if (error?.code?.startsWith?.("XHS_V3_")) throw error;
      if (fsImpl.existsSync(finalPath)) return acceptExactExisting();
      fail("XHS_V3_TASK_INVOCATION_WRITE_FAILED", "task invocation could not be sealed create-only");
    }
  };
}

function normalizeExpectedRuntime(runtime) {
  const keys = ["releaseId", "sourceCommit", "providerBundleDigest", "digestKeyId"];
  const fixed = fixedObject(runtime, keys, "XHS_V3_RUNTIME_BINDING_INVALID");
  if (!SAFE_ID.test(String(fixed.releaseId ?? ""))
    || !HEX40.test(String(fixed.sourceCommit ?? ""))
    || !HEX64.test(String(fixed.providerBundleDigest ?? ""))
    || !SAFE_ID.test(String(fixed.digestKeyId ?? ""))) {
    fail("XHS_V3_RUNTIME_BINDING_INVALID", "corpus runtime binding is malformed");
  }
  return fixed;
}

function readPersistedCapture(captureRoot, hash, fsImpl) {
  if (!HEX64.test(String(hash ?? ""))) {
    fail("XHS_V3_E_CORPUS_CAPTURE_INVALID", "capture hash is malformed");
  }
  return storedCaptureReceipt(captureRoot, hash, fsImpl);
}

function listPersistedCaptureHashes(captureRoot, fsImpl) {
  assertPlainDirectory(captureRoot, fsImpl, "XHS_V3_CAPTURE_STORE_INVALID");
  const hashes = [];
  for (const entry of fsImpl.readdirSync(captureRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !HEX64.test(entry.name)) {
      fail("XHS_V3_CAPTURE_STORE_DRIFT", "private capture store contains an unexpected entry");
    }
    hashes.push(entry.name);
  }
  return hashes.sort();
}

function publicReviewRow(receipt, captureReceiptHash) {
  if (receipt.captureMode !== "CP_BOUND_R1_R2"
    || !["R1", "R2"].includes(receipt.provenance?.phase)) {
    fail("XHS_V3_CORPUS_REVIEW_RECEIPT_INVALID", "review export accepts only persisted CP-bound R1/R2 receipts");
  }
  return Object.freeze({
    captureReceiptHash,
    captureMode: receipt.captureMode,
    phase: receipt.provenance.phase,
    pageClass: receipt.classification?.pageClass,
    evaluationRole: receipt.classification?.evaluationRole,
    dumpVerdict: receipt.classification?.dumpVerdict,
    pngHash: receipt.evidence?.pngHash,
    alias: receipt.placement?.alias,
    laneRole: receipt.placement?.laneRole,
  });
}

/**
 * Fixed offline human-review protocol. It exports only hashes/immutable
 * classification metadata, then assembles a sealed corpus exclusively from
 * persisted CP receipts and a response placed at the fixed private filename.
 */
export function createTaskOwnedCorpusAssembler({
  captureRoot,
  corpusRoot,
  signingKey,
  digestKeyId,
  expectedRuntime,
  fsImpl = DEFAULT_FS,
  sealPrivateTree = () => true,
} = {}) {
  if (typeof captureRoot !== "string" || !isAbsolute(captureRoot)
    || typeof corpusRoot !== "string" || !isAbsolute(corpusRoot)
    || !Buffer.isBuffer(signingKey) || signingKey.length !== 32
    || typeof sealPrivateTree !== "function") {
    fail("XHS_V3_CORPUS_ASSEMBLER_INVALID", "fixed private corpus assembler is unavailable");
  }
  const captures = resolve(captureRoot);
  const corpora = resolve(corpusRoot);
  const runtime = normalizeExpectedRuntime(expectedRuntime);
  if (runtime.digestKeyId !== digestKeyId) {
    fail("XHS_V3_CORPUS_ASSEMBLER_INVALID", "corpus key id differs from the task runtime");
  }
  const key = Buffer.from(signingKey);

  function setRoot(corpusSetId) {
    if (!INVOCATION_ID.test(String(corpusSetId ?? "")) || String(corpusSetId).includes("..")) {
      fail("XHS_V3_CORPUS_SET_ID_INVALID", "corpus set id must be opaque");
    }
    const path = join(corpora, corpusSetId);
    if (!within(corpora, path)) fail("XHS_V3_E_CORPUS_PATH_ESCAPE", "corpus set escaped its fixed root");
    return path;
  }

  async function prepareReview(input = {}) {
    if (!exactObject(input, ["corpusSetId"])) {
      fail("XHS_V3_CORPUS_REVIEW_REQUEST_INVALID", "review preparation accepts only corpusSetId");
    }
    assertPlainDirectory(corpora, fsImpl, "XHS_V3_CORPUS_SET_ROOT_INVALID");
    const root = setRoot(input.corpusSetId);
    if (fsImpl.existsSync(root)) fail("XHS_V3_CORPUS_SET_EXISTS", "corpus set is create-only");
    const receiptRows = listPersistedCaptureHashes(captures, fsImpl).map((hash) => {
      const receipt = readPersistedCapture(captures, hash, fsImpl);
      const actualRuntime = {
        releaseId: receipt.runtime?.releaseId,
        sourceCommit: receipt.runtime?.sourceCommit,
        providerBundleDigest: receipt.runtime?.providerBundleDigest,
        digestKeyId: receipt.runtime?.digestKeyId,
      };
      if (canonicalJson(actualRuntime) !== canonicalJson(runtime)) {
        fail("XHS_V3_CORPUS_REVIEW_RUNTIME_DRIFT", "persisted capture differs from the active task runtime");
      }
      return publicReviewRow(receipt, hash);
    });
    if (receiptRows.length === 0) {
      fail("XHS_V3_CORPUS_REVIEW_EMPTY", "no persisted R1/R2 receipts are available for review");
    }
    const request = Object.freeze({
      schemaId: XHS_V3_CORPUS_REVIEW_REQUEST_SCHEMA_ID,
      schemaVersion: 1,
      corpusSetId: input.corpusSetId,
      runtime,
      receipts: Object.freeze(receiptRows),
    });
    const bytes = Buffer.from(canonicalJson(request), "utf8");
    try {
      fsImpl.mkdirSync(root, { recursive: false, mode: 0o700 });
      fsImpl.writeFileSync(join(root, "review-request.v1.json"), bytes, {
        flag: "wx", mode: 0o600, flush: true,
      });
      sealPrivateTree(root);
    } catch (error) {
      if (error?.code?.startsWith?.("XHS_V3_")) throw error;
      fail("XHS_V3_CORPUS_REVIEW_WRITE_FAILED", "review request could not be sealed create-only");
    }
    return Object.freeze({
      corpusSetId: input.corpusSetId,
      reviewRequestHash: sha256Bytes(bytes),
      receiptCount: receiptRows.length,
      privateMaterial: "TASK_OWNED_OFFLINE_REVIEW_REQUIRED",
    });
  }

  async function assemble(input = {}) {
    if (!exactObject(input, ["corpusSetId"])) {
      fail("XHS_V3_CORPUS_ASSEMBLE_REQUEST_INVALID", "corpus assembly accepts only corpusSetId");
    }
    const root = setRoot(input.corpusSetId);
    assertPlainDirectory(root, fsImpl, "XHS_V3_CORPUS_SET_INVALID");
    sealPrivateTree(root);
    const requestBytes = readPlainFile(join(root, "review-request.v1.json"), {
      fsImpl,
      maximumBytes: 16 * 1024 * 1024,
      code: "XHS_V3_CORPUS_REVIEW_REQUEST_INVALID",
    });
    const request = parseCanonicalPrivateJson(requestBytes, "XHS_V3_CORPUS_REVIEW_REQUEST_INVALID");
    if (!exactObject(request, ["schemaId", "schemaVersion", "corpusSetId", "runtime", "receipts"])
      || request.schemaId !== XHS_V3_CORPUS_REVIEW_REQUEST_SCHEMA_ID
      || request.schemaVersion !== 1 || request.corpusSetId !== input.corpusSetId
      || canonicalJson(request.runtime) !== canonicalJson(runtime)
      || !Array.isArray(request.receipts) || request.receipts.length === 0) {
      fail("XHS_V3_CORPUS_REVIEW_REQUEST_INVALID", "persisted review request drifted");
    }
    const response = parseCanonicalPrivateJson(readPlainFile(join(root, "review-response.v1.json"), {
      fsImpl,
      maximumBytes: 16 * 1024 * 1024,
      code: "XHS_V3_CORPUS_REVIEW_RESPONSE_INVALID",
    }), "XHS_V3_CORPUS_REVIEW_RESPONSE_INVALID");
    const responseKeys = [
      "schemaId", "schemaVersion", "corpusSetId", "reviewRequestHash", "reviewerId",
      "providerImplementerId", "annotationsSealedAt", "providerOutputDisclosedAt",
      "accessAttestationHash", "annotations",
    ];
    if (!exactObject(response, responseKeys)
      || response.schemaId !== XHS_V3_CORPUS_REVIEW_RESPONSE_SCHEMA_ID
      || response.schemaVersion !== 1 || response.corpusSetId !== input.corpusSetId
      || response.reviewRequestHash !== sha256Bytes(requestBytes)
      || !Array.isArray(response.annotations) || response.annotations.length === 0) {
      fail("XHS_V3_CORPUS_REVIEW_RESPONSE_INVALID", "offline review response is malformed or rebound");
    }
    const allowed = new Set(request.receipts.map((row) => row.captureReceiptHash));
    const selected = response.annotations.map((annotation) => {
      if (!allowed.has(annotation?.captureReceiptHash)) {
        fail("XHS_V3_CORPUS_REVIEW_RESPONSE_INVALID", "review response references a non-exported capture");
      }
      return readPersistedCapture(captures, annotation.captureReceiptHash, fsImpl);
    });
    const labels = sealBlindLabels({
      receipts: selected,
      annotations: response.annotations,
      reviewerId: response.reviewerId,
      providerImplementerId: response.providerImplementerId,
      annotationsSealedAt: response.annotationsSealedAt,
      providerOutputDisclosedAt: response.providerOutputDisclosedAt,
      accessAttestationHash: response.accessAttestationHash,
      signingKey: key,
      digestKeyId,
    });
    const sealed = sealCorpusBundle({
      receipts: selected,
      annotationManifest: labels.annotationManifest,
      labelSession: labels.labelSession,
      signingKey: key,
      digestKeyId,
      expectedRuntime: runtime,
    });
    if (sealed.passed !== true || !sealed.bundle || sealed.coverage?.complete !== true) {
      fail("XHS_V3_CORPUS_ASSEMBLE_FAILED", "reviewed persisted receipts do not reproduce a complete corpus");
    }
    const bytes = Buffer.from(canonicalJson(sealed.bundle), "utf8");
    try {
      fsImpl.writeFileSync(join(root, "sealed-corpus.v1.json"), bytes, {
        flag: "wx", mode: 0o600, flush: true,
      });
      sealPrivateTree(root);
    } catch (error) {
      if (error?.code?.startsWith?.("XHS_V3_")) throw error;
      fail("XHS_V3_CORPUS_ASSEMBLE_WRITE_FAILED", "sealed corpus could not be persisted create-only");
    }
    return Object.freeze({
      corpusSetId: input.corpusSetId,
      sealedCorpusHash: sha256Bytes(bytes),
      countingRows: sealed.coverage.countingRows,
      status: "AWAITING_TASK_EVALUATOR_OUTCOME",
    });
  }

  async function submitReview(input = {}) {
    const keys = [
      "corpusSetId", "reviewRequestHash", "reviewerId", "providerImplementerId",
      "annotationsSealedAt", "providerOutputDisclosedAt", "accessAttestationHash", "annotations",
    ];
    if (!exactObject(input, keys)) {
      fail(
        "XHS_V3_CORPUS_REVIEW_RESPONSE_INVALID",
        "review import accepts only the bound blind-annotation response fields",
      );
    }
    const root = setRoot(input.corpusSetId);
    assertPlainDirectory(root, fsImpl, "XHS_V3_CORPUS_SET_INVALID");
    const requestBytes = readPlainFile(join(root, "review-request.v1.json"), {
      fsImpl,
      maximumBytes: 16 * 1024 * 1024,
      code: "XHS_V3_CORPUS_REVIEW_REQUEST_INVALID",
    });
    const request = parseCanonicalPrivateJson(requestBytes, "XHS_V3_CORPUS_REVIEW_REQUEST_INVALID");
    if (!exactObject(request, ["schemaId", "schemaVersion", "corpusSetId", "runtime", "receipts"])
      || request.schemaId !== XHS_V3_CORPUS_REVIEW_REQUEST_SCHEMA_ID
      || request.schemaVersion !== 1 || request.corpusSetId !== input.corpusSetId
      || canonicalJson(request.runtime) !== canonicalJson(runtime)
      || input.reviewRequestHash !== sha256Bytes(requestBytes)
      || !HEX64.test(String(input.accessAttestationHash ?? ""))
      || !Array.isArray(request.receipts) || request.receipts.length === 0
      || !Array.isArray(input.annotations)) {
      fail("XHS_V3_CORPUS_REVIEW_RESPONSE_INVALID", "review response is not bound to the task export");
    }
    const attestationBytes = readPlainFile(join(root, "review-access-attestation.v1.json"), {
      fsImpl,
      maximumBytes: 1024 * 1024,
      code: "XHS_V3_CORPUS_REVIEW_ACCESS_ATTESTATION_INVALID",
    });
    const attestation = parseCanonicalPrivateJson(
      attestationBytes, "XHS_V3_CORPUS_REVIEW_ACCESS_ATTESTATION_INVALID",
    );
    if (sha256Bytes(attestationBytes) !== input.accessAttestationHash
      || !exactObject(attestation, [
        "schemaId", "schemaVersion", "releaseId", "sourceCommit", "operatorSha256",
        "corpusSetId", "reviewRequestHash", "workspaceManifestHash", "templateHash",
        "reviewerPrincipalHash", "workspaceAclHash", "isolationAclHash",
        "networkPolicyHash", "providerOutputAccess", "implementationAnswerAccess", "reviewerNetworkAccess",
        "sessionBindingHash",
      ])
      || attestation.schemaId !== "xw.xhs.v3-blind-review-access-attestation.v1"
      || attestation.schemaVersion !== 1 || attestation.releaseId !== runtime.releaseId
      || attestation.sourceCommit !== runtime.sourceCommit
      || attestation.corpusSetId !== input.corpusSetId
      || attestation.reviewRequestHash !== input.reviewRequestHash
      || !HEX64.test(String(attestation.operatorSha256 ?? ""))
      || !HEX64.test(String(attestation.workspaceManifestHash ?? ""))
      || !HEX64.test(String(attestation.templateHash ?? ""))
      || !HEX64.test(String(attestation.reviewerPrincipalHash ?? ""))
      || !HEX64.test(String(attestation.workspaceAclHash ?? ""))
      || !HEX64.test(String(attestation.isolationAclHash ?? ""))
      || !HEX64.test(String(attestation.networkPolicyHash ?? ""))
      || !HEX64.test(String(attestation.sessionBindingHash ?? ""))
      || attestation.providerOutputAccess !== "DENIED_BY_ACL"
      || attestation.implementationAnswerAccess !== "DENIED_BY_ACL"
      || attestation.reviewerNetworkAccess !== "DENIED_BY_FIXED_OFFLINE_ACCOUNT") {
      fail(
        "XHS_V3_CORPUS_REVIEW_ACCESS_ATTESTATION_INVALID",
        "blind review did not preserve the fixed ACL-separated access attestation",
      );
    }
    const allowed = new Set(request.receipts.map((row) => row.captureReceiptHash));
    const selected = input.annotations.map((annotation) => {
      if (!allowed.has(annotation?.captureReceiptHash)) {
        fail("XHS_V3_CORPUS_REVIEW_RESPONSE_INVALID", "review response references a non-exported capture");
      }
      return readPersistedCapture(captures, annotation.captureReceiptHash, fsImpl);
    });
    // Execute the real blind-label validator before any bytes are admitted to
    // the private corpus set. This rejects extra fields, immutable capture
    // claims, duplicate/missing rows, invalid geometry, identity overlap and
    // temporal disclosure drift without trusting the later assembler.
    try {
      sealBlindLabels({
        receipts: selected,
        annotations: input.annotations,
        reviewerId: input.reviewerId,
        providerImplementerId: input.providerImplementerId,
        annotationsSealedAt: input.annotationsSealedAt,
        providerOutputDisclosedAt: input.providerOutputDisclosedAt,
        accessAttestationHash: input.accessAttestationHash,
        signingKey: key,
        digestKeyId,
      });
    } catch {
      fail("XHS_V3_CORPUS_REVIEW_RESPONSE_INVALID", "blind review response failed the closed label protocol");
    }
    const response = Object.freeze({
      schemaId: XHS_V3_CORPUS_REVIEW_RESPONSE_SCHEMA_ID,
      schemaVersion: 1,
      ...input,
    });
    const bytes = Buffer.from(canonicalJson(response), "utf8");
    try {
      fsImpl.writeFileSync(join(root, "review-response.v1.json"), bytes, {
        flag: "wx", mode: 0o600, flush: true,
      });
      sealPrivateTree(root);
    } catch (error) {
      if (error?.code?.startsWith?.("XHS_V3_")) throw error;
      fail("XHS_V3_CORPUS_REVIEW_RESPONSE_WRITE_FAILED", "blind review response is create-only");
    }
    return Object.freeze({
      corpusSetId: input.corpusSetId,
      reviewResponseHash: sha256Bytes(bytes),
      annotationCount: input.annotations.length,
      status: "REVIEW_RESPONSE_SEALED",
    });
  }

  return Object.freeze({ prepareReview, submitReview, assemble });
}

const CORPUS_PROTECTED_KIND_TO_DUMP_KIND = Object.freeze({
  STATUS_BAR: "status_bar",
  TOP_CHROME: "top_chrome",
  BOTTOM_NAV: "bottom_nav",
  SOCIAL_ACTIONS: "social_actions",
  COMMENT_COMPOSER: "comment_composer",
});
const EVALUATOR_ZERO_SAFETY = Object.freeze({
  socialTransport: 0,
  effectTransport: 0,
  visualIssued: 0,
  visualConsumed: 0,
  visualPhysical: 0,
});

function boundsToRect(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4
    || bounds.some((value) => !Number.isInteger(value))
    || bounds[0] < 0 || bounds[1] < 0 || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) {
    fail("XHS_V3_EVALUATOR_CORPUS_INVALID", "blind annotation contains invalid geometry");
  }
  return Object.freeze({
    x: bounds[0],
    y: bounds[1],
    w: bounds[2] - bounds[0],
    h: bounds[3] - bounds[1],
  });
}

function readCaptureEvidence(captureRoot, receiptHash, fsImpl) {
  const root = join(captureRoot, receiptHash);
  assertPlainDirectory(root, fsImpl, "XHS_V3_EVALUATOR_CAPTURE_INVALID");
  const receipt = storedCaptureReceipt(captureRoot, receiptHash, fsImpl);
  const files = Object.freeze({
    "receipt.v1.json": Buffer.from(canonicalJson(receipt), "utf8"),
    "frame.png": readPlainFile(join(root, "frame.png"), {
      fsImpl, maximumBytes: 32 * 1024 * 1024, code: "XHS_V3_EVALUATOR_CAPTURE_INVALID",
    }),
    "dump.xml": readPlainFile(join(root, "dump.xml"), {
      fsImpl, maximumBytes: 32 * 1024 * 1024, code: "XHS_V3_EVALUATOR_CAPTURE_INVALID",
    }),
    "focus.json": readPlainFile(join(root, "focus.json"), {
      fsImpl, maximumBytes: 1024 * 1024, code: "XHS_V3_EVALUATOR_CAPTURE_INVALID",
    }),
  });
  const manifest = parseCanonicalPrivateJson(readPlainFile(join(root, "capture-manifest.v1.json"), {
    fsImpl, maximumBytes: 1024 * 1024, code: "XHS_V3_EVALUATOR_CAPTURE_INVALID",
  }), "XHS_V3_EVALUATOR_CAPTURE_INVALID");
  if (!exactObject(manifest, ["schemaId", "captureReceiptHash", "files"])
    || manifest.schemaId !== "xw.xhs.v3-private-capture-manifest.v1"
    || manifest.captureReceiptHash !== receiptHash
    || !exactObject(manifest.files, [
      "receipt.v1.json", "frame.png", "dump.xml", "focus.json",
    ])
    || Object.entries(files).some(([name, bytes]) => manifest.files[name] !== sha256Bytes(bytes))
    || receipt.evidence?.pngHash !== sha256Bytes(files["frame.png"])
    || receipt.evidence?.dumpHash !== sha256Bytes(files["dump.xml"])
    || receipt.evidence?.focusHash !== sha256Bytes(files["focus.json"])) {
    fail("XHS_V3_EVALUATOR_CAPTURE_INVALID", "private capture tree no longer reproduces its receipt");
  }
  return Object.freeze({ receipt, frameBytes: files["frame.png"] });
}

function buildTaskVisionCorpus(bundle, captureRoot, fsImpl) {
  if (!Array.isArray(bundle?.publicManifest?.rows)
    || !Array.isArray(bundle?.annotationManifest?.rows)
    || !Array.isArray(bundle?.privateIndex?.captureReceiptHashes)) {
    fail("XHS_V3_EVALUATOR_CORPUS_INVALID", "sealed corpus lacks the fixed public/private indexes");
  }
  const annotations = new Map(bundle.annotationManifest.rows.map((row) => [row.captureReceiptHash, row]));
  const evidenceBySource = new Map();
  const dumpByHash = new Map();
  let completeRowCount = 0;
  let providerRowCount = 0;
  const rows = bundle.publicManifest.rows.map((publicRow) => {
    const receiptHash = String(publicRow.receiptRef ?? "").replace(/^receipt:/u, "");
    const annotation = annotations.get(receiptHash);
    const capture = readCaptureEvidence(captureRoot, receiptHash, fsImpl);
    const fallbackEligible = ["AMBIGUOUS_SAFE", "ABSENT_OR_INVALID"].includes(publicRow.dumpVerdict);
    const dumpResolved = publicRow.dumpVerdict === "COMPLETE_SAFE_UNIQUE";
    const forbidden = publicRow.dumpVerdict === "FORBIDDEN_OR_RISKY";
    if (!annotation
      || (dumpResolved && annotation.expectedOutcome !== "NO_FALLBACK_EXPECTED")
      || (forbidden && annotation.expectedOutcome !== "REJECT")
      || (fallbackEligible && !["SAFE_UNIQUE", "REJECT"].includes(annotation.expectedOutcome))) {
      fail(
        "XHS_V3_EVALUATOR_CORPUS_INVALID",
        "every production row must preserve its sealed DUMP/expected-outcome classification",
      );
    }
    // Full-bundle validation above owns coverage and verifies every sealed
    // receipt. Forbidden/calibration rows never count, and a fallback row
    // labelled REJECT is not a provider-positive oracle case.
    if (forbidden || publicRow.provenance?.countingEligible !== true
      || (fallbackEligible && annotation.expectedOutcome !== "SAFE_UNIQUE")) return null;
    if (!dumpResolved && (!fallbackEligible
      || annotation.positiveRegions.length !== 1 || annotation.protectedRegions.length === 0)) {
      fail(
        "XHS_V3_EVALUATOR_CORPUS_INVALID",
        "fallback-positive provider rows require blind SAFE_UNIQUE positive/protected geometry",
      );
    }
    const positiveRegion = dumpResolved ? null : {
      role: annotation.positiveRegions[0].role,
      ...boundsToRect(annotation.positiveRegions[0].bounds),
    };
    const protectedZones = (dumpResolved ? [] : annotation.protectedRegions).map((region) => {
      const kind = CORPUS_PROTECTED_KIND_TO_DUMP_KIND[region.kind];
      if (!kind) fail("XHS_V3_EVALUATOR_CORPUS_INVALID", "protected region kind is outside the fixed DUMP map");
      return Object.freeze({ kind, ...boundsToRect(region.bounds) });
    });
    if (fallbackEligible) {
      const capturedRegions = [
        { kind: "positive", ...positiveRegion },
        ...protectedZones.map((zone) => ({ kind: `protected:${zone.kind}`, ...zone })),
      ];
      if (sha256Hex(Buffer.from(canonicalJson(capturedRegions), "utf8"))
        !== capture.receipt.classification?.dumpRegionsHash) {
        fail("XHS_V3_EVALUATOR_DUMP_GEOMETRY_DRIFT", "blind geometry differs from the signed CP DUMP regions");
      }
    }
    const dumpReceipt = buildVisionCorpusDumpReceipt({
      frameHash: capture.receipt.evidence.pngHash,
      pageClass: publicRow.pageClass,
      requestedRole: publicRow.evaluationRole,
      dumpDecision: {
        verdict: publicRow.dumpVerdict,
        page: publicRow.pageClass,
        navigationRole: publicRow.evaluationRole,
        visionEligible: fallbackEligible,
        positiveRegion,
        protectedZones,
        reasons: [`capture-reasons-sha256:${capture.receipt.classification.dumpReasonsHash}`],
      },
      evidenceHash: capture.receipt.evidence.dumpHash,
    });
    const dumpBytes = Buffer.from(canonicalJson(dumpReceipt), "utf8");
    const row = {
      id: publicRow.id,
      sourceRef: publicRow.sourceRef,
      frame: {
        sha256: capture.receipt.evidence.pngHash,
        width: capture.receipt.evidence.width,
        height: capture.receipt.evidence.height,
        alias: capture.receipt.placement.alias,
        receiptHash: sha256Bytes(dumpBytes),
      },
      pageClass: publicRow.pageClass,
      dumpVerdict: publicRow.dumpVerdict,
      positiveRoles: [publicRow.evaluationRole],
      geometry: {
        positiveRegions: dumpResolved ? [] : annotation.positiveRegions,
        protectedRegions: dumpResolved ? [] : annotation.protectedRegions,
      },
    };
    row.annotationHash = deriveVisionCorpusAnnotationHash(row);
    evidenceBySource.set(row.sourceRef, capture.frameBytes);
    dumpByHash.set(row.frame.receiptHash, dumpBytes);
    if (dumpResolved) completeRowCount += 1;
    else providerRowCount += 1;
    return Object.freeze(row);
  }).filter(Boolean);
  const distinctFramesByRoute = Object.fromEntries(
    XHS_EXPLORATION_VISION_CORPUS_ROUTES.map((route) => [
      route,
      new Set(rows.filter((row) => row.pageClass === route).map((row) => row.frame.sha256)).size,
    ]),
  );
  const verifiedRoutes = XHS_EXPLORATION_VISION_CORPUS_ROUTES.filter(
    (route) => distinctFramesByRoute[route] >= XHS_EXPLORATION_VISION_CORPUS_MIN_FRAMES_PER_ROUTE,
  );
  const missingRoutes = XHS_EXPLORATION_VISION_CORPUS_ROUTES.filter(
    (route) => !verifiedRoutes.includes(route),
  );
  const fallbackRowsByRoute = Object.fromEntries(
    XHS_EXPLORATION_VISION_CORPUS_ROUTES.map((route) => [
      route,
      rows.filter((row) => row.pageClass === route
        && ["AMBIGUOUS_SAFE", "ABSENT_OR_INVALID"].includes(row.dumpVerdict)).length,
    ]),
  );
  if (missingRoutes.length > 0
    || Object.values(fallbackRowsByRoute).some((count) => count < 1)) {
    fail(
      "XHS_V3_EVALUATOR_CORPUS_INVALID",
      "counting COMPLETE+fallback rows must preserve full coverage and at least one provider oracle per route",
    );
  }
  const manifest = Object.freeze({
    schemaId: XHS_EXPLORATION_VISION_CORPUS_SCHEMA_ID,
    schemaVersion: 1,
    requiredRoutes: XHS_EXPLORATION_VISION_CORPUS_ROUTES,
    minimumDistinctFramesPerRoute: XHS_EXPLORATION_VISION_CORPUS_MIN_FRAMES_PER_ROUTE,
    provenance: XHS_EXPLORATION_VISION_CORPUS_GATE_E_PROVENANCE,
    coverage: Object.freeze({
      complete: missingRoutes.length === 0,
      distinctFramesByRoute: Object.freeze(distinctFramesByRoute),
      verifiedRoutes: Object.freeze(verifiedRoutes),
      missingRoutes: Object.freeze(missingRoutes),
    }),
    rows: Object.freeze(rows),
  });
  return Object.freeze({
    manifest,
    evidenceBySource,
    dumpByHash,
    completeRowCount,
    providerRowCount,
    fallbackRowsByRoute: Object.freeze(fallbackRowsByRoute),
  });
}

/** Run and persist the fixed real-provider oracle; callers cannot submit PASS. */
export function createTaskOwnedCorpusEvaluator({
  captureRoot,
  corpusRoot,
  signingKey,
  digestKeyId,
  expectedRuntime,
  providerConfig,
  analyzerFactory = createPinnedExplorationVisionAnalyzer,
  fsImpl = DEFAULT_FS,
  sealPrivateTree = () => true,
} = {}) {
  if (typeof captureRoot !== "string" || !isAbsolute(captureRoot)
    || typeof corpusRoot !== "string" || !isAbsolute(corpusRoot)
    || !Buffer.isBuffer(signingKey) || signingKey.length !== 32
    || typeof analyzerFactory !== "function" || typeof sealPrivateTree !== "function"
    || !providerConfig || !providerConfig.provider) {
    fail("XHS_V3_TASK_EVALUATOR_INVALID", "fixed corpus evaluator is unavailable");
  }
  const captures = resolve(captureRoot);
  const corpora = resolve(corpusRoot);
  const runtime = normalizeExpectedRuntime(expectedRuntime);
  if (runtime.digestKeyId !== digestKeyId) {
    fail("XHS_V3_TASK_EVALUATOR_INVALID", "evaluator key differs from the task runtime");
  }
  const key = Buffer.from(signingKey);

  return async function evaluateCorpusSet(input = {}) {
    if (!exactObject(input, ["corpusSetId"])
      || !INVOCATION_ID.test(String(input.corpusSetId ?? ""))
      || String(input.corpusSetId).includes("..")) {
      fail("XHS_V3_TASK_EVALUATOR_REQUEST_INVALID", "evaluator accepts only an opaque corpusSetId");
    }
    const root = join(corpora, input.corpusSetId);
    if (!within(corpora, root)) fail("XHS_V3_E_CORPUS_PATH_ESCAPE", "corpus set escaped its fixed root");
    assertPlainDirectory(root, fsImpl, "XHS_V3_CORPUS_SET_INVALID");
    sealPrivateTree(root);
    const bundle = parseCanonicalPrivateJson(readPlainFile(join(root, "sealed-corpus.v1.json"), {
      fsImpl, maximumBytes: MAX_CORPUS_BYTES, code: "XHS_V3_EVALUATOR_CORPUS_INVALID",
    }), "XHS_V3_EVALUATOR_CORPUS_INVALID");
    const validation = validateSealedCorpusBundle(bundle, {
      signingKey: key,
      digestKeyId,
      expectedRuntime: runtime,
    });
    if (validation.passed !== true || validation.coverage?.complete !== true) {
      fail("XHS_V3_EVALUATOR_CORPUS_INVALID", "sealed corpus did not reproduce before provider evaluation");
    }
    const taskCorpus = buildTaskVisionCorpus(bundle, captures, fsImpl);
    const stagingRoot = join(root, "provider-evaluation-work");
    const analyzer = analyzerFactory(providerConfig, { stagingRoot });
    if (!analyzer || typeof analyzer.analyze !== "function") {
      fail("XHS_V3_TASK_EVALUATOR_INVALID", "pinned provider analyzer is unavailable");
    }
    const provider = createVisionCorpusProcessProviderAdapter({
      analyzer,
      providerIdentity: providerConfig.provider,
    });
    const loadFrame = async (sourceRef) => {
      const bytes = taskCorpus.evidenceBySource.get(sourceRef);
      if (!bytes) fail("XHS_V3_EVALUATOR_CAPTURE_INVALID", "oracle requested an unknown private frame");
      return Buffer.from(bytes);
    };
    const loadDumpReceipt = async (hash) => {
      const bytes = taskCorpus.dumpByHash.get(hash);
      if (!bytes) fail("XHS_V3_EVALUATOR_CAPTURE_INVALID", "oracle requested an unknown DUMP receipt");
      return Buffer.from(bytes);
    };
    try {
      const real = await evaluateVisionCorpusGate({
        manifest: taskCorpus.manifest,
        loadFrame,
        loadDumpReceipt,
        provider,
        expectedProviderIdentity: providerConfig.provider,
      });
      if (real.passed !== true || real.complete !== true
        || real.providerInvocationCount !== taskCorpus.providerRowCount
        || real.tapCount !== taskCorpus.providerRowCount
        || real.rows.some((row) => row.passed !== true
          || (row.dumpVerdict === "COMPLETE_SAFE_UNIQUE"
            ? row.expectedOutcome !== "NO_FALLBACK_EXPECTED"
              || row.providerInvocations !== 0 || row.tapAuthorized !== false
            : row.expectedOutcome !== "SAFE_UNIQUE"
              || row.providerInvocations !== 1 || row.tapAuthorized !== true))) {
        fail(
          "XHS_V3_PROVIDER_ORACLE_FAILED",
          "fallback provider rows and COMPLETE no-fallback rows did not preserve their exact oracle outcomes",
        );
      }

      const annotationMutation = structuredClone(taskCorpus.manifest);
      annotationMutation.rows[0].annotationHash = "f".repeat(64);
      const annotationRejected = await evaluateVisionCorpusGate({
        manifest: annotationMutation, loadFrame, loadDumpReceipt, provider,
        expectedProviderIdentity: providerConfig.provider,
      });
      const frameRejected = await evaluateVisionCorpusGate({
        manifest: taskCorpus.manifest,
        loadFrame: async () => Buffer.from("mutated-private-frame", "utf8"),
        loadDumpReceipt,
        provider,
        expectedProviderIdentity: providerConfig.provider,
      });
      const dumpRejected = await evaluateVisionCorpusGate({
        manifest: taskCorpus.manifest,
        loadFrame,
        loadDumpReceipt: async () => Buffer.from("{}", "utf8"),
        provider,
        expectedProviderIdentity: providerConfig.provider,
      });
      const identityMutation = {
        ...providerConfig.provider,
        configHash: providerConfig.provider.configHash === "f".repeat(64)
          ? "e".repeat(64) : "f".repeat(64),
      };
      const identityRejected = await evaluateVisionCorpusGate({
        manifest: taskCorpus.manifest, loadFrame, loadDumpReceipt, provider,
        expectedProviderIdentity: identityMutation,
      });
      const rejected = [annotationRejected, frameRejected, dumpRejected, identityRejected];
      if (rejected.some((result) => result.passed !== false || result.tapCount !== 0)) {
        fail("XHS_V3_EVALUATOR_MUTATION_FAILED", "one required adverse mutation was not rejected");
      }
      const corpusManifestHash = sha256Hex(Buffer.from(canonicalJson(bundle.publicManifest), "utf8"));
      const privateIndexDigest = sha256Hex(Buffer.from(canonicalJson(bundle.privateIndex), "utf8"));
      const outcome = Object.freeze({
        schemaId: XHS_V3_TASK_EVALUATOR_OUTCOME_SCHEMA_ID,
        schemaVersion: 1,
        corpusSetId: input.corpusSetId,
        runtime,
        corpus: Object.freeze({ corpusManifestHash, privateIndexDigest }),
        providerOracleCases: Object.freeze([
          Object.freeze({ id: "pinned-provider-fallback-safe-unique", passed: true }),
          ...(taskCorpus.completeRowCount > 0 ? [Object.freeze({
            id: "complete-no-fallback-provider-invocations-0",
            passed: true,
          })] : []),
        ]),
        adverseMutationCases: Object.freeze([
          Object.freeze({ id: "annotation-binding-mutation-rejected", passed: true }),
          Object.freeze({ id: "private-frame-mutation-rejected", passed: true }),
          Object.freeze({ id: "dump-receipt-mutation-rejected", passed: true }),
          Object.freeze({ id: "provider-identity-mutation-rejected", passed: true }),
        ]),
        safety: EVALUATOR_ZERO_SAFETY,
      });
      const bytes = Buffer.from(canonicalJson(outcome), "utf8");
      try {
        fsImpl.writeFileSync(join(root, "production-evaluator-outcome.v1.json"), bytes, {
          flag: "wx", mode: 0o600, flush: true,
        });
        sealPrivateTree(root);
      } catch (error) {
        if (error?.code?.startsWith?.("XHS_V3_")) throw error;
        fail("XHS_V3_EVALUATOR_OUTCOME_WRITE_FAILED", "evaluator outcome is create-only");
      }
      return Object.freeze({
        corpusSetId: input.corpusSetId,
        status: "PASS",
        evaluatorOutcomeHash: sha256Bytes(bytes),
        providerOracleCaseCount: outcome.providerOracleCases.length,
        adverseMutationCaseCount: outcome.adverseMutationCases.length,
      });
    } finally {
      await analyzer.close?.();
    }
  };
}

function validateCaptureInput(input) {
  if (!exactObject(input, ["receipt", "captureReceiptHash", "raw"])
    || !HEX64.test(String(input.captureReceiptHash ?? ""))
    || input.captureReceiptHash !== sha256Hex(Buffer.from(canonicalJson(input.receipt), "utf8"))
    || !exactObject(input.raw, ["pngBytes", "dumpBytes", "focusBytes"])) {
    fail("XHS_V3_CAPTURE_PERSIST_INPUT_INVALID", "capture persistence input is malformed");
  }
  const raw = Object.fromEntries(Object.entries(input.raw).map(([key, value]) => {
    if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
      fail("XHS_V3_CAPTURE_PERSIST_INPUT_INVALID", `${key} must be exact private bytes`);
    }
    const bytes = Buffer.from(value);
    if (bytes.length === 0 || bytes.length > 32 * 1024 * 1024) {
      fail("XHS_V3_CAPTURE_PERSIST_INPUT_INVALID", `${key} is outside the private size bound`);
    }
    return [key, bytes];
  }));
  return { receipt: input.receipt, captureReceiptHash: input.captureReceiptHash, raw };
}

/**
 * Create-only, content-addressed private capture persistence.  `sealPrivateTree`
 * is fixed at bootstrap and production uses one recursive native ACL operation
 * per capture directory (never a per-file PowerShell loop).
 */
export function createTaskOwnedCapturePersistence({
  root,
  fsImpl = DEFAULT_FS,
  randomUUIDFn = randomUUID,
  sealPrivateTree = () => true,
} = {}) {
  if (typeof root !== "string" || !isAbsolute(root)
    || typeof randomUUIDFn !== "function" || typeof sealPrivateTree !== "function") {
    fail("XHS_V3_CAPTURE_STORE_INVALID", "fixed private capture store is unavailable");
  }
  const fixedRoot = resolve(root);
  return async function persistCapture(rawInput) {
    const input = validateCaptureInput(rawInput);
    assertPlainDirectory(fixedRoot, fsImpl, "XHS_V3_CAPTURE_STORE_INVALID");
    const finalDirectory = join(fixedRoot, input.captureReceiptHash);
    const stageDirectory = join(fixedRoot, `.pending-${randomUUIDFn()}`);
    if (!within(fixedRoot, finalDirectory) || !within(fixedRoot, stageDirectory)
      || fsImpl.existsSync(finalDirectory)) {
      fail("XHS_V3_CAPTURE_ALREADY_PERSISTED", "capture receipt is create-only");
    }
    let stageCreated = false;
    try {
      fsImpl.mkdirSync(stageDirectory, { recursive: false, mode: 0o700 });
      stageCreated = true;
      const receiptBytes = Buffer.from(canonicalJson(input.receipt), "utf8");
      const rows = [
        ["receipt.v1.json", receiptBytes],
        ["frame.png", input.raw.pngBytes],
        ["dump.xml", input.raw.dumpBytes],
        ["focus.json", input.raw.focusBytes],
      ];
      const manifest = {
        schemaId: "xw.xhs.v3-private-capture-manifest.v1",
        captureReceiptHash: input.captureReceiptHash,
        files: Object.fromEntries(rows.map(([name, bytes]) => [name, sha256Bytes(bytes)])),
      };
      rows.push(["capture-manifest.v1.json", Buffer.from(canonicalJson(manifest), "utf8")]);
      for (const [name, bytes] of rows) {
        fsImpl.writeFileSync(join(stageDirectory, name), bytes, {
          flag: "wx",
          mode: 0o600,
          flush: true,
        });
      }
      fsImpl.renameSync(stageDirectory, finalDirectory);
      stageCreated = false;
      sealPrivateTree(finalDirectory);
      return Object.freeze({ receiptRef: `receipt:${input.captureReceiptHash}` });
    } catch (error) {
      if (stageCreated) {
        try { fsImpl.rmSync(stageDirectory, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      if (error?.code?.startsWith?.("XHS_V3_")) throw error;
      fail("XHS_V3_CAPTURE_PERSIST_FAILED", "private capture could not be sealed create-only");
    }
  };
}

/** Execute the immutable built-in exact-pair fixture; it owns no live adapter. */
export function createDeployedR0FixtureRunner({ runtimeBinding, signingKey, digestKeyId } = {}) {
  const fixedRuntime = fixedObject(runtimeBinding, RUNTIME_KEYS, "XHS_V3_RUNTIME_BINDING_INVALID");
  if (!Buffer.isBuffer(signingKey) || signingKey.length !== 32
    || fixedRuntime.digestKeyId !== digestKeyId) {
    fail("XHS_V3_R0_FIXTURE_IDENTITY_INVALID", "R0 fixture key/runtime binding drifted");
  }
  const key = Buffer.from(signingKey);
  return async function runDeployedR0Fixture() {
    const adapter = createFixtureCorpusAdapter();
    const operator = createOfflineCorpusOperator({ adapter, signingKey: key, digestKeyId });
    const preflight = await operator.preflight();
    const traversal = await operator.traverse();
    if (preflight.passed !== true || preflight.productionWiring !== false
      || traversal.passed !== true || traversal.coverage?.complete !== true
      || canonicalJson(preflight.resources) !== canonicalJson(XHS_CORPUS_ZERO_RESOURCES)
      || canonicalJson(traversal.resources) !== canonicalJson(XHS_CORPUS_ZERO_RESOURCES)) {
      fail("XHS_V3_R0_FIXTURE_FAILED", "deployed immutable offline fixture did not prove zero live resources");
    }
    return Object.freeze({
      schemaId: XHS_V3_R0_RESULT_SCHEMA_ID,
      phase: "CALIBRATION_ONLY",
      captureMode: "OFFLINE_FIXTURE_ONLY",
      runtime: fixedRuntime,
      resources: XHS_CORPUS_ZERO_RESOURCES,
      status: "PASS",
    });
  };
}

/** Fixed future seam for R3/R4. No HTTP or CLI caller can replace these handlers. */
export function createPostECorpusRoutineAdapter({ runR3, runR4 } = {}) {
  if (typeof runR3 !== "function" || typeof runR4 !== "function") {
    fail("XHS_V3_POST_E_CORPUS_RUNNER_INVALID", "R3 and R4 fixed handlers are required together");
  }
  return Object.freeze({
    async run(input) {
      if (!exactObject(input, ["phase", "plan", "privatePayload", "eCorpusInterlock"])
        || !["R3", "R4"].includes(input.phase)) {
        fail("XHS_V3_POST_E_CORPUS_INVOCATION_INVALID", "post-E runner input is not the fixed seam");
      }
      return input.phase === "R3" ? runR3(input) : runR4(input);
    },
  });
}

/** Closed benign invocation compiler used by the production preparation API. */
export function createBuiltInTaskInvocationBuilder({
  identity,
  providerBinding,
  signingKey,
  digestKeyId,
} = {}) {
  const fixedIdentity = validateIdentity(identity);
  const providerKeys = [
    "providerBundleDigest", "pythonHash", "modelHash", "scriptHash", "configHash",
  ];
  const provider = fixedObject(providerBinding, providerKeys, "XHS_V3_PROVIDER_BINDING_INVALID");
  if (providerKeys.some((key) => !HEX64.test(String(provider[key] ?? "")))
    || provider.providerBundleDigest !== fixedIdentity.providerBundleDigest
    || !Buffer.isBuffer(signingKey) || signingKey.length !== 32
    || !SAFE_ID.test(String(digestKeyId ?? ""))) {
    fail("XHS_V3_TASK_INVOCATION_BUILDER_INVALID", "benign profile builder identity is malformed");
  }
  const key = Buffer.from(signingKey);
  return async function buildTaskInvocation(phase, sealedContext = {}) {
    if (!["R0", "R1", "R2", "R3", "R4"].includes(phase)) {
      fail("XHS_V3_TASK_PREPARE_REQUEST_INVALID", "task phase must be R0..R4");
    }
    let vision = { mode: "off" };
    let eCorpusPassRef = null;
    let eCorpusVerifier = null;
    if (phase === "R2") vision = { mode: "shadow", provider };
    if (phase === "R3") {
      if (!exactObject(sealedContext, ["eCorpusPassRef", "eCorpusInterlock"])
        || !sealedContext.eCorpusPassRef
        || typeof sealedContext.eCorpusInterlock?.verifyR3 !== "function") {
        fail("XHS_V3_E_CORPUS_PASS_NOT_TASK_OWNED", "R3 invocation preparation requires its exact persisted PASS");
      }
      vision = { mode: "canary1", provider };
      eCorpusPassRef = sealedContext.eCorpusPassRef;
      eCorpusVerifier = ({ ref }) => sealedContext.eCorpusInterlock.verifyR3({
        ref,
        releaseId: fixedIdentity.releaseId,
        sourceCommit: fixedIdentity.sourceCommit,
        providerBundleDigest: fixedIdentity.providerBundleDigest,
      });
    }
    const compiled = compileExplorationMission({
      goal: BUILTIN_BENIGN_GOAL,
      queries: BUILTIN_BENIGN_QUERIES,
      budgets: {
        missionDurationSec: 180,
        reservedPrimitives: 32,
        novelOpens: 2,
        sealedQueries: 1,
        resultScreensPerQuery: 1,
        commentScreens: 1,
        consecutiveNavigationFailures: 2,
        noNovelScreens: 2,
        visionAnalysisAttempts: phase === "R2" || phase === "R3" ? 6 : 0,
        visionMaxIssuedPermits: phase === "R3" ? 1 : 0,
        visionMaxPhysicalTaps: phase === "R3" ? 1 : 0,
        providerDecisionDeadlineMs: 8000,
        frameMaxAgeMs: 10000,
        permitTtlMs: 5000,
        perDeviceConcurrency: 1,
      },
      vision,
      rolloutPhase: phase,
      eCorpusPassRef,
      eCorpusVerifier,
      releaseIdRef: fixedIdentity.releaseId,
      accountFingerprintRef: fixedIdentity.accountFingerprint,
      digestKeyId,
      digestKey: key,
      seed: `xhs-v3-${phase.toLowerCase()}`,
    });
    const planned = planExplorationGoalRoutine({ mission: compiled.mission });
    const { templateSpec: _templateSpec, ...plan } = planned;
    return Object.freeze({
      schemaId: XHS_V3_TASK_INVOCATION_SCHEMA_ID,
      plan,
      privatePayload: compiled.privatePayload,
    });
  };
}

function normalizeTaskRunRuntime(runtime) {
  const fixed = fixedObject(runtime, RUNTIME_KEYS, "XHS_V3_RUNTIME_BINDING_INVALID");
  if (!SAFE_ID.test(String(fixed.releaseId ?? ""))
    || !HEX40.test(String(fixed.sourceCommit ?? ""))
    || !HEX64.test(String(fixed.providerBundleDigest ?? ""))
    || !SAFE_ID.test(String(fixed.digestKeyId ?? ""))
    || !HEX64.test(String(fixed.accountFingerprint ?? ""))) {
    fail("XHS_V3_RUNTIME_BINDING_INVALID", "task run runtime binding is malformed");
  }
  return fixed;
}

/** Create-only public-result journal under the task private root. */
export function createTaskOwnedRunRecordStore({
  root,
  taskBinding,
  runtimeBinding,
  fsImpl = DEFAULT_FS,
  sealPrivateTree = () => true,
} = {}) {
  if (typeof root !== "string" || !isAbsolute(root) || typeof sealPrivateTree !== "function") {
    fail("XHS_V3_TASK_RUN_STORE_INVALID", "fixed task run store is unavailable");
  }
  const runs = resolve(root);
  const owner = fixedObject(taskBinding, OWNER_KEYS, "XHS_V3_TASK_RUN_STORE_INVALID");
  if (owner.taskName !== XHS_V3_TASK_NAME
    || OWNER_KEYS.slice(1).some((key) => !HEX64.test(String(owner[key] ?? "")))) {
    fail("XHS_V3_TASK_RUN_STORE_INVALID", "task run owner binding is malformed");
  }
  const runtime = normalizeTaskRunRuntime(runtimeBinding);

  function pathFor(invocationId) {
    if (!INVOCATION_ID.test(String(invocationId ?? "")) || String(invocationId).includes("..")) {
      fail("XHS_V3_TASK_INVOCATION_ID_INVALID", "run record invocation id must be opaque");
    }
    const path = join(runs, `${invocationId}.v1.json`);
    if (!within(runs, path)) fail("XHS_V3_TASK_RUN_PATH_ESCAPE", "run record escaped its fixed root");
    return path;
  }

  function attemptPathFor(invocationId) {
    pathFor(invocationId);
    const path = join(runs, `${invocationId}.attempt.v1.json`);
    if (!within(runs, path)) fail("XHS_V3_TASK_RUN_PATH_ESCAPE", "run attempt escaped its fixed root");
    return path;
  }

  function buildAttempt({ phase, invocationId, invocation }) {
    const value = validateInvocation(invocation);
    if (value.plan?.mission?.vision?.rolloutPhase !== phase) {
      fail("XHS_V3_TASK_RUN_ATTEMPT_INVALID", "run attempt phase differs from its sealed invocation");
    }
    const attempt = Object.freeze({
      schemaId: XHS_V3_TASK_RUN_ATTEMPT_SCHEMA_ID,
      schemaVersion: 1,
      state: "AMBIGUOUS_UNTIL_FINAL",
      phase,
      invocationId,
      invocationHash: sha256Bytes(Buffer.from(canonicalJson(value), "utf8")),
      planHash: value.plan?.planHash ?? null,
      missionHash: value.plan?.mission?.missionHash ?? null,
      eCorpusPassRef: value.plan?.mission?.vision?.eCorpusPassRef ?? null,
      taskBinding: owner,
      runtimeBinding: runtime,
    });
    if (!HEX64.test(String(attempt.planHash ?? ""))
      || !HEX64.test(String(attempt.missionHash ?? ""))) {
      fail("XHS_V3_TASK_RUN_ATTEMPT_INVALID", "run attempt lacks sealed plan/mission hashes");
    }
    return attempt;
  }

  async function loadAttempt({ phase, invocationId } = {}) {
    const bytes = readPlainFile(attemptPathFor(invocationId), {
      fsImpl, maximumBytes: 4 * 1024 * 1024, code: "XHS_V3_TASK_RUN_ATTEMPT_INVALID",
    });
    const attempt = parseCanonicalPrivateJson(bytes, "XHS_V3_TASK_RUN_ATTEMPT_INVALID");
    const keys = [
      "schemaId", "schemaVersion", "state", "phase", "invocationId", "invocationHash",
      "planHash", "missionHash", "eCorpusPassRef", "taskBinding", "runtimeBinding",
    ];
    if (!exactObject(attempt, keys)
      || attempt.schemaId !== XHS_V3_TASK_RUN_ATTEMPT_SCHEMA_ID
      || attempt.schemaVersion !== 1 || attempt.state !== "AMBIGUOUS_UNTIL_FINAL"
      || attempt.phase !== phase || attempt.invocationId !== invocationId
      || !HEX64.test(String(attempt.invocationHash ?? ""))
      || !HEX64.test(String(attempt.planHash ?? ""))
      || !HEX64.test(String(attempt.missionHash ?? ""))
      || canonicalJson(attempt.taskBinding) !== canonicalJson(owner)
      || canonicalJson(attempt.runtimeBinding) !== canonicalJson(runtime)) {
      fail("XHS_V3_TASK_RUN_ATTEMPT_INVALID", "persisted run attempt identity drifted");
    }
    return Object.freeze({ attempt, attemptHash: sha256Bytes(bytes) });
  }

  async function loadAttemptIfPresent({ phase, invocationId } = {}) {
    if (!fsImpl.existsSync(attemptPathFor(invocationId))) return null;
    return loadAttempt({ phase, invocationId });
  }

  async function beginAttempt(input = {}) {
    if (!exactObject(input, ["phase", "invocationId", "invocation"])
      || !["R0", "R1", "R2", "R3", "R4"].includes(input.phase)) {
      fail("XHS_V3_TASK_RUN_ATTEMPT_INVALID", "run attempt input is malformed");
    }
    assertPlainDirectory(runs, fsImpl, "XHS_V3_TASK_RUN_STORE_INVALID");
    const attempt = buildAttempt(input);
    const bytes = Buffer.from(canonicalJson(attempt), "utf8");
    const path = attemptPathFor(input.invocationId);
    try {
      fsImpl.writeFileSync(path, bytes, { flag: "wx", mode: 0o600, flush: true });
      sealPrivateTree(path);
      return Object.freeze({
        phase: input.phase,
        invocationId: input.invocationId,
        attemptHash: sha256Bytes(bytes),
        created: true,
      });
    } catch (error) {
      if (error?.code?.startsWith?.("XHS_V3_")) throw error;
      if (!fsImpl.existsSync(path)) {
        fail("XHS_V3_TASK_RUN_ATTEMPT_WRITE_FAILED", "run attempt could not be sealed create-only");
      }
      const existing = await loadAttempt({ phase: input.phase, invocationId: input.invocationId });
      if (canonicalJson(existing.attempt) !== canonicalJson(attempt)) {
        fail("XHS_V3_TASK_RUN_ATTEMPT_EXISTS", "run attempt id is bound to different invocation bytes");
      }
      return Object.freeze({
        phase: input.phase,
        invocationId: input.invocationId,
        attemptHash: existing.attemptHash,
        created: false,
      });
    }
  }

  async function persist(input = {}) {
    if (!exactObject(input, ["phase", "invocationId", "invocation", "result"])
      || !["R0", "R1", "R2", "R3", "R4"].includes(input.phase)
      || !input.result || typeof input.result !== "object" || Array.isArray(input.result)) {
      fail("XHS_V3_TASK_RUN_RECORD_INVALID", "run record input is malformed");
    }
    const invocation = validateInvocation(input.invocation);
    if (invocation.plan?.mission?.vision?.rolloutPhase !== input.phase) {
      fail("XHS_V3_TASK_RUN_RECORD_INVALID", "run result phase differs from its sealed invocation");
    }
    assertPlainDirectory(runs, fsImpl, "XHS_V3_TASK_RUN_STORE_INVALID");
    const record = Object.freeze({
      schemaId: XHS_V3_TASK_RUN_RECORD_SCHEMA_ID,
      schemaVersion: 1,
      phase: input.phase,
      invocationId: input.invocationId,
      invocationHash: sha256Bytes(Buffer.from(canonicalJson(invocation), "utf8")),
      planHash: invocation.plan?.planHash ?? null,
      missionHash: invocation.plan?.mission?.missionHash ?? null,
      eCorpusPassRef: invocation.plan?.mission?.vision?.eCorpusPassRef ?? null,
      taskBinding: owner,
      runtimeBinding: runtime,
      result: input.result,
    });
    if (!HEX64.test(String(record.planHash ?? "")) || !HEX64.test(String(record.missionHash ?? ""))) {
      fail("XHS_V3_TASK_RUN_RECORD_INVALID", "run record lacks sealed plan/mission hashes");
    }
    const bytes = Buffer.from(canonicalJson(record), "utf8");
    const path = pathFor(input.invocationId);
    try {
      fsImpl.writeFileSync(path, bytes, { flag: "wx", mode: 0o600, flush: true });
      sealPrivateTree(path);
    } catch (error) {
      if (error?.code?.startsWith?.("XHS_V3_")) throw error;
      fail("XHS_V3_TASK_RUN_RECORD_WRITE_FAILED", "task run record is create-only");
    }
    return Object.freeze({
      invocationId: input.invocationId,
      phase: input.phase,
      runRecordHash: sha256Bytes(bytes),
    });
  }

  async function load({ phase, invocationId } = {}) {
    const bytes = readPlainFile(pathFor(invocationId), {
      fsImpl, maximumBytes: 32 * 1024 * 1024, code: "XHS_V3_TASK_RUN_RECORD_INVALID",
    });
    const record = parseCanonicalPrivateJson(bytes, "XHS_V3_TASK_RUN_RECORD_INVALID");
    const keys = [
      "schemaId", "schemaVersion", "phase", "invocationId", "invocationHash",
      "planHash", "missionHash", "eCorpusPassRef", "taskBinding", "runtimeBinding", "result",
    ];
    if (!exactObject(record, keys)
      || record.schemaId !== XHS_V3_TASK_RUN_RECORD_SCHEMA_ID || record.schemaVersion !== 1
      || record.phase !== phase || record.invocationId !== invocationId
      || !HEX64.test(String(record.invocationHash ?? ""))
      || !HEX64.test(String(record.planHash ?? "")) || !HEX64.test(String(record.missionHash ?? ""))
      || canonicalJson(record.taskBinding) !== canonicalJson(owner)
      || canonicalJson(record.runtimeBinding) !== canonicalJson(runtime)) {
      fail("XHS_V3_TASK_RUN_RECORD_INVALID", "persisted run record identity drifted");
    }
    return Object.freeze({ record, runRecordHash: sha256Bytes(bytes) });
  }

  async function loadIfPresent({ phase, invocationId } = {}) {
    const path = pathFor(invocationId);
    if (!fsImpl.existsSync(path)) return null;
    return load({ phase, invocationId });
  }

  return Object.freeze({
    beginAttempt,
    loadAttempt,
    loadAttemptIfPresent,
    persist,
    load,
    loadIfPresent,
    taskBinding: owner,
    runtimeBinding: runtime,
  });
}

function closeoutLaneBlockers(phase, record, blockers) {
  const result = record?.result;
  const prefix = `${phase}:`;
  if (result?.ok !== true || result?.status !== "SUCCEEDED") blockers.push(`${prefix}RUN_NOT_SUCCEEDED`);
  if (result?.phase !== phase) blockers.push(`${prefix}PHASE_DRIFT`);
  if (!Array.isArray(result?.children) || result.children.length !== 2
    || canonicalJson(result.children.map((child) => child.alias)) !== canonicalJson(["03", "04"])
    || canonicalJson(result.children.map((child) => child.laneRole))
      !== canonicalJson(["feed_lane", "search_lane"])) {
    blockers.push(`${prefix}EXACT_PAIR_MISSING`);
    return;
  }
  for (const child of result.children) {
    if (child.status !== "COMPLETED" || child.committed !== true
      || !HEX64.test(String(child.receiptHash ?? ""))) blockers.push(`${prefix}LANE_${child.alias}_UNCOMMITTED`);
    if (child.receipt?.restored?.restored !== true) blockers.push(`${prefix}LANE_${child.alias}_NOT_RESTORED`);
    if (child.receipt?.safety?.socialTransport !== 0
      || child.receipt?.safety?.effectTransport !== 0) blockers.push(`${prefix}LANE_${child.alias}_EFFECT_NONZERO`);
  }
  if (result.cleanup?.authorityClosed?.ok !== true) blockers.push(`${prefix}AUTHORITY_NOT_CLOSED`);
  if (result.cleanup?.leaseOracle?.checked !== true || result.cleanup?.leaseOracle?.ok !== true
    || result.cleanup?.leaseOracle?.activeLeaseCount !== 0) blockers.push(`${prefix}OWNED_LEASES_NONZERO`);
  if (!Array.isArray(result.cleanup?.releases) || result.cleanup.releases.length !== 2
    || result.cleanup.releases.some((row) => row?.ok !== true)) blockers.push(`${prefix}SESSION_RELEASE_INCOMPLETE`);
  if (result.safety?.socialTransport !== 0 || result.safety?.effectTransport !== 0) {
    blockers.push(`${prefix}EFFECT_TRANSPORT_NONZERO`);
  }
  const visual = ["visualIssued", "visualConsumed", "visualPhysical"]
    .map((key) => Number(result.safety?.[key]));
  if (phase === "R3") {
    if (visual.some((value) => !Number.isSafeInteger(value) || value < 0)
      || visual[0] > 1 || visual[1] > visual[0] || visual[2] > visual[1] || visual[2] > 1) {
      blockers.push(`${prefix}VISUAL_ONE_SHOT_EXCEEDED`);
    }
  } else if (visual.some((value) => value !== 0)) blockers.push(`${prefix}VISUAL_HARD_ZERO_FAILED`);
  try {
    verifyPersistedSharedExplorationBudgetProof({
      result,
      phase,
      missionHash: record?.missionHash,
    });
  } catch {
    blockers.push(`${prefix}SHARED_BUDGET_PROOF_INVALID`);
  }
}

/** Reproduce the full P6 acceptance result only from task-persisted records. */
export function createTaskOwnedP6Closeout({
  runRecordStore,
  captureRoot,
  acceptanceRoot,
  signingKey,
  digestKeyId,
  verifyECorpusPass,
  fsImpl = DEFAULT_FS,
  sealPrivateTree = () => true,
  now = Date.now,
} = {}) {
  if (!runRecordStore || typeof runRecordStore.load !== "function"
    || typeof captureRoot !== "string" || !isAbsolute(captureRoot)
    || typeof acceptanceRoot !== "string" || !isAbsolute(acceptanceRoot)
    || !Buffer.isBuffer(signingKey) || signingKey.length !== 32
    || typeof verifyECorpusPass !== "function"
    || typeof sealPrivateTree !== "function" || typeof now !== "function") {
    fail("XHS_V3_P6_CLOSEOUT_INVALID", "task-owned P6 closeout dependencies are incomplete");
  }
  const captures = resolve(captureRoot);
  const acceptance = resolve(acceptanceRoot);
  const taskBinding = runRecordStore.taskBinding;
  const runtime = runRecordStore.runtimeBinding;
  if (runtime.digestKeyId !== digestKeyId) fail("XHS_V3_P6_CLOSEOUT_INVALID", "closeout digest key drifted");
  const key = Buffer.from(signingKey);

  function persistArtifact(schemaId, fileName, artifact, bucket) {
    assertPlainDirectory(acceptance, fsImpl, "XHS_V3_P6_ACCEPTANCE_ROOT_INVALID");
    const bytes = Buffer.from(canonicalJson(artifact), "utf8");
    const artifactHash = sha256Bytes(bytes);
    const bucketRoot = join(acceptance, bucket);
    if (!fsImpl.existsSync(bucketRoot)) fsImpl.mkdirSync(bucketRoot, { recursive: false, mode: 0o700 });
    assertPlainDirectory(bucketRoot, fsImpl, "XHS_V3_P6_ACCEPTANCE_ROOT_INVALID");
    const root = join(bucketRoot, artifactHash);
    const path = join(root, fileName);
    if (!within(acceptance, path)) fail("XHS_V3_P6_PATH_ESCAPE", "P6 artifact escaped acceptance root");
    if (fsImpl.existsSync(root)) {
      const existing = readPlainFile(path, {
        fsImpl, maximumBytes: 32 * 1024 * 1024, code: "XHS_V3_P6_ARTIFACT_DRIFT",
      });
      if (!existing.equals(bytes)) fail("XHS_V3_P6_ARTIFACT_DRIFT", "content-addressed P6 artifact bytes drifted");
    } else {
      fsImpl.mkdirSync(root, { recursive: false, mode: 0o700 });
      fsImpl.writeFileSync(path, bytes, { flag: "wx", mode: 0o600, flush: true });
      sealPrivateTree(root);
    }
    return Object.freeze({ schemaId, artifactHash, relativePath: `${bucket}/${artifactHash}/${fileName}` });
  }

  return async function closeout(input = {}) {
    if (!exactObject(input, ["runSetId"])
      || !INVOCATION_ID.test(String(input.runSetId ?? ""))
      || String(input.runSetId).includes("..") || String(input.runSetId).length > 120) {
      fail("XHS_V3_P6_CLOSEOUT_REQUEST_INVALID", "closeout accepts only one opaque runSetId");
    }
    const blockers = [];
    const phases = {};
    const loaded = {};
    for (const phase of ["R0", "R1", "R2", "R3", "R4"]) {
      const invocationId = `${input.runSetId}-${phase.toLowerCase()}`;
      try {
        loaded[phase] = await runRecordStore.load({ phase, invocationId });
        const { record, runRecordHash } = loaded[phase];
        phases[phase] = Object.freeze({
          invocationId,
          runRecordHash,
          resultReceiptHash: record.result?.receiptHash ?? null,
        });
      } catch (error) {
        blockers.push(`${phase}:RUN_RECORD_${String(error?.code ?? "MISSING")}`);
      }
    }
    const r0 = loaded.R0?.record?.result;
    if (r0 && (r0.ok !== true || r0.status !== "SUCCEEDED" || r0.phase !== "R0"
      || r0.captureMode !== "OFFLINE_FIXTURE_ONLY"
      || canonicalJson(r0.resources) !== canonicalJson({ jobs: 0, sessions: 0, leases: 0, deviceIo: 0 })
      || !HEX64.test(String(r0.receiptHash ?? "")))) blockers.push("R0:OFFLINE_FIXTURE_PASS_MISSING");

    for (const phase of ["R1", "R2", "R3", "R4"]) {
      if (loaded[phase]) closeoutLaneBlockers(phase, loaded[phase].record, blockers);
    }
    const r3ECorpusRef = loaded.R3?.record?.eCorpusPassRef;
    if (r3ECorpusRef == null) blockers.push("R3:E_CORPUS_PASS_REF_MISSING");
    else {
      try {
        const verified = await verifyECorpusPass(r3ECorpusRef);
        if (!exactObject(verified, [
          "ok", "status", "artifactHash", "ref", "binding", "owner", "effectiveVisualPermitBudget",
        ])
          || verified.ok !== true || verified.status !== "PASS"
          || verified.artifactHash !== r3ECorpusRef.artifactHash
          || canonicalJson(verified.ref) !== canonicalJson(r3ECorpusRef)
          || verified.effectiveVisualPermitBudget !== 1
          || canonicalJson(verified.owner) !== canonicalJson(taskBinding)
          || verified.binding?.releaseId !== runtime.releaseId
          || verified.binding?.sourceCommit !== runtime.sourceCommit
          || verified.binding?.providerBundleDigest !== runtime.providerBundleDigest
          || verified.binding?.digestKeyId !== runtime.digestKeyId) {
          blockers.push("R3:E_CORPUS_PASS_INVALID");
        }
      } catch {
        blockers.push("R3:E_CORPUS_PASS_INVALID");
      }
    }
    if (loaded.R4?.record?.eCorpusPassRef != null) blockers.push("R4:DORMANT_E_CORPUS_AUTHORITY");

    const framesByRoute = Object.fromEntries(XHS_EXPLORATION_VISION_CORPUS_ROUTES.map((route) => [route, new Set()]));
    for (const phase of ["R1", "R2"]) {
      const hashes = loaded[phase]?.record?.result?.captureReceiptHashes;
      if (!Array.isArray(hashes) || hashes.length === 0) {
        blockers.push(`${phase}:CAPTURE_RECEIPTS_MISSING`);
        continue;
      }
      for (const hash of hashes) {
        try {
          const receipt = storedCaptureReceipt(captures, hash, fsImpl);
          const verified = verifyCaptureReceipt(receipt, {
            signingKey: key,
            expectedDigestKeyId: digestKeyId,
            expectedRuntime: runtime,
          });
          if (!verified.valid || verified.receiptHash !== hash
            || receipt.provenance?.phase !== phase || receipt.captureMode !== "CP_BOUND_R1_R2"
            || receipt.safety?.socialTransport !== 0 || receipt.safety?.effectTransport !== 0) {
            blockers.push(`${phase}:CAPTURE_RECEIPT_INVALID`);
            continue;
          }
          framesByRoute[receipt.classification.pageClass]?.add(receipt.evidence.pngHash);
        } catch {
          blockers.push(`${phase}:CAPTURE_RECEIPT_INVALID`);
        }
      }
    }
    const distinctFramesByRoute = Object.fromEntries(
      Object.entries(framesByRoute).map(([route, hashes]) => [route, hashes.size]),
    );
    for (const [route, count] of Object.entries(distinctFramesByRoute)) {
      if (count < 3) blockers.push(`COVERAGE:${route}_LT_3`);
    }
    const uniqueBlockers = [...new Set(blockers)].sort();
    const createdAtMs = Number(now());
    if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) fail("XHS_V3_CLOCK_INVALID", "closeout clock is invalid");
    if (uniqueBlockers.length > 0) {
      const partial = Object.freeze({
        schemaId: XHS_V3_FREE_EXPLORATION_PARTIAL_SCHEMA_ID,
        schemaVersion: 1,
        status: "CLOSEOUT_PARTIAL",
        runSetId: input.runSetId,
        taskBinding,
        runtime,
        phases: Object.freeze(phases),
        blockers: Object.freeze(uniqueBlockers),
        reproducedAtMs: createdAtMs,
      });
      const persisted = persistArtifact(
        XHS_V3_FREE_EXPLORATION_PARTIAL_SCHEMA_ID,
        "xhs-v3-p6-partial.v1.json",
        partial,
        "p6-partials",
      );
      return Object.freeze({
        status: "CLOSEOUT_PARTIAL",
        artifactHash: persisted.artifactHash,
        blockers: Object.freeze(uniqueBlockers),
      });
    }

    const pass = Object.freeze({
      schemaId: XHS_V3_FREE_EXPLORATION_PASS_SCHEMA_ID,
      schemaVersion: 1,
      status: "PASS",
      verificationMarker: "XHS_V3_FREE_EXPLORATION_VERIFIED=true",
      XHS_V3_FREE_EXPLORATION_VERIFIED: true,
      runSetId: input.runSetId,
      taskBinding,
      runtime,
      placement: Object.freeze({
        aliases: Object.freeze(["03", "04"]),
        laneRoles: Object.freeze(["feed_lane", "search_lane"]),
      }),
      phases: Object.freeze(phases),
      coverage: Object.freeze({
        requiredRoutes: XHS_EXPLORATION_VISION_CORPUS_ROUTES,
        minimumDistinctFramesPerRoute: 3,
        distinctFramesByRoute: Object.freeze(distinctFramesByRoute),
      }),
      safety: Object.freeze({
        socialTransport: 0,
        effectTransport: 0,
        r3VisualIssued: loaded.R3.record.result.safety.visualIssued,
        r3VisualConsumed: loaded.R3.record.result.safety.visualConsumed,
        r3VisualPhysical: loaded.R3.record.result.safety.visualPhysical,
        allOtherVisualHardZero: true,
      }),
      sharedBudgets: Object.freeze(Object.fromEntries(
        ["R1", "R2", "R3", "R4"].map((phase) => [phase, Object.freeze({
          proofHash: loaded[phase].record.result.sharedBudget.proofHash,
          ledgerHash: loaded[phase].record.result.sharedBudget.ledgerHash,
          caps: loaded[phase].record.result.sharedBudget.caps,
          used: loaded[phase].record.result.sharedBudget.used,
        })]),
      )),
      cleanup: Object.freeze({
        semanticRestoreAllLanes: true,
        authorityClosedAllWaves: true,
        sessionReleaseAllSettled: true,
        zeroOwnedLeases: true,
      }),
    });
    const persisted = persistArtifact(
      XHS_V3_FREE_EXPLORATION_PASS_SCHEMA_ID,
      "xhs-v3-p6-pass.v1.json",
      pass,
      "p6-artifacts",
    );
    const locator = Object.freeze({
      schemaId: XHS_V3_P6_CURRENT_SCHEMA_ID,
      schemaVersion: 1,
      artifactHash: persisted.artifactHash,
      artifactSchemaId: XHS_V3_FREE_EXPLORATION_PASS_SCHEMA_ID,
      relativePath: persisted.relativePath,
    });
    const locatorBytes = Buffer.from(canonicalJson(locator), "utf8");
    const locatorPath = join(acceptance, "p6-current.v1.json");
    if (fsImpl.existsSync(locatorPath)) {
      const existing = readPlainFile(locatorPath, {
        fsImpl, maximumBytes: 1024 * 1024, code: "XHS_V3_P6_CURRENT_DRIFT",
      });
      if (!existing.equals(locatorBytes)) fail("XHS_V3_P6_CURRENT_DRIFT", "P6 current locator is immutable");
    } else {
      fsImpl.writeFileSync(locatorPath, locatorBytes, { flag: "wx", mode: 0o600, flush: true });
      sealPrivateTree(locatorPath);
    }
    return Object.freeze({
      status: "PASS",
      verified: true,
      artifactHash: persisted.artifactHash,
      verificationMarker: pass.verificationMarker,
    });
  };
}

/**
 * Pure listener-owned request surface.  It deliberately accepts fully built
 * dependencies only once; neither `.runTask` nor `.sealECorpus` accepts a
 * dependency, path, provider, alias, role, mission, or evidence bundle.
 */
export function createXhsV3TaskBootstrap({
  runner,
  loadTaskInvocation,
  buildTaskInvocation,
  persistTaskInvocation,
  corpusAssembler,
  evaluateCorpusSet,
  runRecordStore,
  closeoutAcceptance,
  createCorpusSealer,
  openECorpusArtifact = null,
  assertGateFReady,
  postECorpusRunner = null,
  now = Date.now,
  identityView = null,
} = {}) {
  if (!runner || typeof runner.run !== "function"
    || typeof loadTaskInvocation !== "function"
    || typeof buildTaskInvocation !== "function"
    || typeof persistTaskInvocation !== "function"
    || !corpusAssembler || typeof corpusAssembler.prepareReview !== "function"
    || typeof corpusAssembler.submitReview !== "function"
    || typeof corpusAssembler.assemble !== "function"
    || typeof evaluateCorpusSet !== "function"
    || !runRecordStore || typeof runRecordStore.persist !== "function"
    || typeof runRecordStore.loadIfPresent !== "function"
    || typeof runRecordStore.beginAttempt !== "function"
    || typeof runRecordStore.loadAttemptIfPresent !== "function"
    || typeof closeoutAcceptance !== "function"
    || typeof createCorpusSealer !== "function"
    || typeof assertGateFReady !== "function"
    || typeof now !== "function") {
    fail("XHS_V3_TASK_BOOTSTRAP_INVALID", "fixed runner/loaders/sealer are required");
  }
  if (postECorpusRunner !== null && typeof postECorpusRunner.run !== "function") {
    fail("XHS_V3_POST_E_CORPUS_RUNNER_INVALID", "post-E runner is malformed");
  }
  if (openECorpusArtifact !== null && typeof openECorpusArtifact !== "function") {
    fail("XHS_V3_E_CORPUS_OPENER_INVALID", "persistent E-Corpus opener is malformed");
  }
  const inFlight = new Set();

  function openExactECorpusArtifact(artifactHash) {
    if (!HEX64.test(String(artifactHash ?? "")) || typeof openECorpusArtifact !== "function") {
      fail("XHS_V3_E_CORPUS_PASS_NOT_TASK_OWNED", "exact persisted E-Corpus authority is unavailable");
    }
    const opened = openECorpusArtifact(artifactHash);
    if (opened && typeof opened.then === "function") {
      fail("XHS_V3_E_CORPUS_OPENER_INVALID", "E-Corpus opener must synchronously close the authority check");
    }
    if (!exactObject(opened, ["ref", "interlock", "verification"])
      || opened.ref?.artifactHash !== artifactHash
      || typeof opened.interlock?.verifyR3 !== "function"
      || opened.verification?.status !== "PASS"
      || opened.verification?.artifactHash !== artifactHash) {
      fail("XHS_V3_E_CORPUS_OPENER_INVALID", "persistent E-Corpus opener returned a malformed closure");
    }
    return opened;
  }

  async function prepareInvocation(input = {}) {
    const validPhase = ["R0", "R1", "R2", "R3", "R4"].includes(input.phase);
    const fields = input.phase === "R3"
      ? ["phase", "invocationId", "eCorpusArtifactHash"]
      : ["phase", "invocationId"];
    if (!validPhase || !exactObject(input, fields)
      || !INVOCATION_ID.test(String(input.invocationId ?? ""))
      || String(input.invocationId).includes("..")
      || (input.phase === "R3" && !HEX64.test(String(input.eCorpusArtifactHash ?? "")))) {
      fail("XHS_V3_TASK_PREPARE_REQUEST_INVALID", "prepare accepts an opaque id and, only for R3, its exact E artifact hash");
    }
    await assertGateFReady();
    const sealedContext = input.phase === "R3"
      ? (() => {
        const opened = openExactECorpusArtifact(input.eCorpusArtifactHash);
        return Object.freeze({
          eCorpusPassRef: opened.ref,
          eCorpusInterlock: opened.interlock,
        });
      })()
      : Object.freeze({});
    const value = validateInvocation(await buildTaskInvocation(input.phase, sealedContext));
    const persisted = await persistTaskInvocation({
      phase: input.phase,
      invocationId: input.invocationId,
      value,
    });
    if (!exactObject(persisted, ["invocationId", "phase", "invocationHash"])
      || persisted.invocationId !== input.invocationId || persisted.phase !== input.phase
      || !HEX64.test(String(persisted.invocationHash ?? ""))) {
      fail("XHS_V3_TASK_PREPARE_RECEIPT_INVALID", "fixed invocation writer returned a malformed receipt");
    }
    return Object.freeze({ ok: true, ...persisted });
  }

  async function runTask(input = {}) {
    if (!exactObject(input, ["phase", "invocationId"])
      || !["R0", "R1", "R2", "R3", "R4"].includes(input.phase)
      || !INVOCATION_ID.test(String(input.invocationId ?? ""))
      || String(input.invocationId).includes("..")) {
      fail("XHS_V3_TASK_REQUEST_INVALID", "run accepts only phase R0..R4 and one opaque invocationId");
    }
    const key = `${input.phase}:${input.invocationId}`;
    if (inFlight.has(key)) fail("XHS_V3_TASK_ALREADY_RUNNING", "task invocation is already in flight");
    inFlight.add(key);
    try {
      await assertGateFReady();
      const loaded = validateInvocation(await loadTaskInvocation(input.invocationId));
      if (loaded.plan?.mission?.vision?.rolloutPhase !== input.phase) {
        fail("XHS_V3_TASK_INVOCATION_PHASE_DRIFT", "run phase differs from the immutable invocation");
      }
      let openedECorpus = null;
      if (input.phase === "R3") {
        const ref = loaded.plan?.mission?.vision?.eCorpusPassRef;
        openedECorpus = openExactECorpusArtifact(ref?.artifactHash);
        if (canonicalJson(openedECorpus.ref) !== canonicalJson(ref)) {
          fail("XHS_V3_E_CORPUS_REF_DRIFT", "persisted invocation reference differs from the reopened E artifact");
        }
      }
      const prior = await runRecordStore.loadIfPresent({
        phase: input.phase,
        invocationId: input.invocationId,
      });
      if (prior !== null) {
        const expectedInvocationHash = sha256Bytes(Buffer.from(canonicalJson(loaded), "utf8"));
        if (!exactObject(prior, ["record", "runRecordHash"])
          || !HEX64.test(String(prior.runRecordHash ?? ""))
          || prior.record?.phase !== input.phase
          || prior.record?.invocationId !== input.invocationId
          || prior.record?.invocationHash !== expectedInvocationHash
          || !prior.record.result || typeof prior.record.result !== "object"
          || Array.isArray(prior.record.result)) {
          fail("XHS_V3_TASK_RUN_REPLAY_INVALID", "persisted run result does not match the sealed invocation");
        }
        return prior.record.result;
      }
      const priorAttempt = await runRecordStore.loadAttemptIfPresent({
        phase: input.phase,
        invocationId: input.invocationId,
      });
      if (priorAttempt !== null) {
        fail(
          "XHS_V3_TASK_RUN_AMBIGUOUS",
          "a durable pre-I/O attempt exists without a final record; fixed evidence adoption is required",
          { phase: input.phase, invocationId: input.invocationId },
        );
      }
      if (["R3", "R4"].includes(input.phase) && !postECorpusRunner) {
        fail("XHS_V3_POST_E_CORPUS_RUNNER_UNAVAILABLE", "R3/R4 fixed routine adapter is not installed");
      }
      const attempt = await runRecordStore.beginAttempt({
        phase: input.phase,
        invocationId: input.invocationId,
        invocation: loaded,
      });
      if (!exactObject(attempt, ["phase", "invocationId", "attemptHash", "created"])
        || attempt.phase !== input.phase || attempt.invocationId !== input.invocationId
        || !HEX64.test(String(attempt.attemptHash ?? "")) || attempt.created !== true) {
        fail("XHS_V3_TASK_RUN_AMBIGUOUS", "run attempt was not uniquely created before physical I/O");
      }
      let result;
      if (["R0", "R1", "R2"].includes(input.phase)) {
        result = await runner.run({
          phase: input.phase,
          plan: loaded.plan,
          privatePayload: loaded.privatePayload,
        });
      } else {
        let eCorpusInterlock = null;
        if (input.phase === "R3") {
          eCorpusInterlock = openedECorpus.interlock;
        }
        result = await postECorpusRunner.run({
          phase: input.phase,
          plan: loaded.plan,
          privatePayload: loaded.privatePayload,
          eCorpusInterlock,
        });
      }
      const persisted = await runRecordStore.persist({
        phase: input.phase,
        invocationId: input.invocationId,
        invocation: loaded,
        result,
      });
      if (!exactObject(persisted, ["invocationId", "phase", "runRecordHash"])
        || persisted.invocationId !== input.invocationId || persisted.phase !== input.phase
        || !HEX64.test(String(persisted.runRecordHash ?? ""))) {
        fail("XHS_V3_TASK_RUN_RECORD_INVALID", "task run store returned a malformed receipt");
      }
      return result;
    } finally {
      inFlight.delete(key);
    }
  }

  async function sealECorpus(input = {}) {
    if (!exactObject(input, ["corpusSetId", "expiryPolicy"])
      || !INVOCATION_ID.test(String(input.corpusSetId ?? ""))
      || String(input.corpusSetId).includes("..")
      || !Object.hasOwn(XHS_V3_EXPIRY_POLICIES, input.expiryPolicy)) {
      fail("XHS_V3_E_CORPUS_REQUEST_INVALID", "seal accepts only an opaque corpusSetId and closed expiry policy");
    }
    await assertGateFReady();
    const issuedAtMs = Number(now());
    if (!Number.isInteger(issuedAtMs)) fail("XHS_V3_CLOCK_INVALID", "task clock is invalid");
    const registry = await createCorpusSealer(input.corpusSetId, Object.freeze({
      expiryPolicy: input.expiryPolicy,
      requestedAtMs: issuedAtMs,
    }));
    if (!registry || typeof registry.sealPass !== "function") {
      fail("XHS_V3_E_CORPUS_SEALER_INVALID", "task-owned E-Corpus sealer is unavailable");
    }
    const expiresAtMs = registry.expiresAtMs === undefined
      ? issuedAtMs + XHS_V3_EXPIRY_POLICIES[input.expiryPolicy]
      : Number(registry.expiresAtMs);
    if (!Number.isInteger(expiresAtMs) || expiresAtMs <= issuedAtMs
      || expiresAtMs - issuedAtMs > XHS_V3_EXPIRY_POLICIES[input.expiryPolicy]) {
      fail("XHS_V3_E_CORPUS_SEAL_INTENT_STALE", "persisted E-Corpus seal intent is expired or overlong");
    }
    const sealed = await registry.sealPass({
      expiresAtMs,
    });
    if (!sealed?.ref || !HEX64.test(String(sealed.ref.artifactHash ?? ""))) {
      fail("XHS_V3_E_CORPUS_SEAL_INVALID", "registry returned a malformed PASS reference");
    }
    return Object.freeze({
      ok: true,
      status: "PASS",
      ref: sealed.ref,
      testReportHash: sealed.evaluation?.testReportHash ?? null,
    });
  }

  // ControlPlane's R3 authority gate receives only the signed ref. Reopen the
  // exact content-addressed artifact on every check so restart and interleaved
  // run sets cannot fall back to process-local "latest" state.
  function verifyECorpusR3(input = {}) {
    const opened = openExactECorpusArtifact(input?.ref?.artifactHash);
    if (canonicalJson(opened.ref) !== canonicalJson(input?.ref)) {
      fail("XHS_V3_E_CORPUS_REF_DRIFT", "CP reference differs from the reopened E artifact");
    }
    return opened.interlock.verifyR3(input);
  }

  async function prepareCorpusReview(input = {}) {
    if (!exactObject(input, ["corpusSetId"])) {
      fail("XHS_V3_CORPUS_REVIEW_REQUEST_INVALID", "review export accepts only corpusSetId");
    }
    await assertGateFReady();
    return corpusAssembler.prepareReview(input);
  }

  async function assembleCorpusSet(input = {}) {
    if (!exactObject(input, ["corpusSetId"])) {
      fail("XHS_V3_CORPUS_ASSEMBLE_REQUEST_INVALID", "corpus assembly accepts only corpusSetId");
    }
    await assertGateFReady();
    return corpusAssembler.assemble(input);
  }

  async function submitCorpusReview(input = {}) {
    const keys = [
      "corpusSetId", "reviewRequestHash", "reviewerId", "providerImplementerId",
      "annotationsSealedAt", "providerOutputDisclosedAt", "accessAttestationHash", "annotations",
    ];
    if (!exactObject(input, keys)) {
      fail(
        "XHS_V3_CORPUS_REVIEW_RESPONSE_INVALID",
        "review import accepts only the exported hash and closed blind labels",
      );
    }
    await assertGateFReady();
    return corpusAssembler.submitReview(input);
  }

  async function evaluateCorpus(input = {}) {
    if (!exactObject(input, ["corpusSetId"])) {
      fail("XHS_V3_TASK_EVALUATOR_REQUEST_INVALID", "evaluator accepts only corpusSetId");
    }
    await assertGateFReady();
    return evaluateCorpusSet(input);
  }

  async function closeoutP6(input = {}) {
    if (!exactObject(input, ["runSetId"])) {
      fail("XHS_V3_P6_CLOSEOUT_REQUEST_INVALID", "closeout accepts only runSetId");
    }
    await assertGateFReady();
    return closeoutAcceptance(input);
  }

  return Object.freeze({
    prepareInvocation,
    runTask,
    prepareCorpusReview,
    submitCorpusReview,
    assembleCorpusSet,
    evaluateCorpus,
    closeoutP6,
    sealECorpus,
    verifyECorpusR3,
    health() {
      return Object.freeze({
        schemaId: XHS_V3_TASK_BOOTSTRAP_SCHEMA_ID,
        status: postECorpusRunner ? "READY_R0_R4" : "READY_R0_R2",
        releaseId: identityView?.releaseId ?? null,
        providerBundleDigest: identityView?.providerBundleDigest ?? null,
        taskOwned: true,
      });
    },
  });
}

function storedCaptureReceipt(captureRoot, hash, fsImpl) {
  const path = join(captureRoot, hash, "receipt.v1.json");
  const bytes = readPlainFile(path, {
    fsImpl,
    maximumBytes: 2 * 1024 * 1024,
    code: "XHS_V3_E_CORPUS_CAPTURE_MISSING",
  });
  const receipt = parseCanonicalPrivateJson(bytes, "XHS_V3_E_CORPUS_CAPTURE_INVALID");
  if (sha256Hex(Buffer.from(canonicalJson(receipt), "utf8")) !== hash) {
    fail("XHS_V3_E_CORPUS_CAPTURE_INVALID", "persisted capture receipt hash drifted");
  }
  return receipt;
}

function validateEvaluatorOutcome(outcome, { corpusSetId, runtime, corpusManifestHash, privateIndexDigest }) {
  const keys = [
    "schemaId", "schemaVersion", "corpusSetId", "runtime", "corpus",
    "providerOracleCases", "adverseMutationCases", "safety",
  ];
  if (!exactObject(outcome, keys)
    || outcome.schemaId !== XHS_V3_TASK_EVALUATOR_OUTCOME_SCHEMA_ID
    || outcome.schemaVersion !== 1
    || outcome.corpusSetId !== corpusSetId
    || canonicalJson(outcome.runtime) !== canonicalJson(runtime)
    || !exactObject(outcome.corpus, ["corpusManifestHash", "privateIndexDigest"])
    || outcome.corpus.corpusManifestHash !== corpusManifestHash
    || outcome.corpus.privateIndexDigest !== privateIndexDigest
    || !exactObject(outcome.safety, [
      "socialTransport", "effectTransport", "visualIssued", "visualConsumed", "visualPhysical",
    ])
    || Object.values(outcome.safety).some((value) => value !== 0)) {
    fail("XHS_V3_EVALUATOR_OUTCOME_INVALID", "persisted production evaluator outcome drifted");
  }
  return Object.freeze({
    providerOracleCases: outcome.providerOracleCases,
    adverseMutationCases: outcome.adverseMutationCases,
    safety: outcome.safety,
  });
}

/**
 * Re-open the task-owned E-PASS from its fixed content-addressed store for P6.
 * The run record contributes only the opaque signed ref; the path, owner,
 * expected binding, key ring and ACL boundary all remain listener-owned.
 */
function createFixedP6ECorpusVerifier({
  keyring,
  taskBinding,
  runtimeBinding,
  privateAcl,
  fsImpl = DEFAULT_FS,
  now = Date.now,
} = {}) {
  if (!keyring || typeof keyring.verify !== "function"
    || !privateAcl || typeof privateAcl.verify !== "function") {
    fail("XHS_V3_P6_E_CORPUS_VERIFIER_INVALID", "fixed E-Corpus verifier dependencies are incomplete");
  }
  const store = createECorpusPassStore({
    artifactRoot: XHS_E_CORPUS_PASS_ROOT,
    canonicalArtifactRoot: XHS_E_CORPUS_PASS_ROOT,
    owner: taskBinding,
    keyring,
    now,
    fsImpl,
    aclChecker({ path, stat }) {
      let lstat;
      try {
        lstat = fsImpl.lstatSync(path);
      } catch {
        return false;
      }
      if (!within(XHS_V3_RUNTIME_ROOT, path)
        || lstat.isSymbolicLink()
        || resolve(fsImpl.realpathSync(path)) !== resolve(path)
        || (!stat.isDirectory() && !stat.isFile())
        || (stat.isFile() && stat.nlink !== 1)) return false;
      privateAcl.verify(buildSystemTcbAclPlan({
        boundaryPath: XHS_V3_RUNTIME_ROOT,
        targetPath: path,
        recursive: false,
      }));
      return true;
    },
  });
  return async function verifyECorpusPass(ref) {
    if (!exactObject(ref, ["schemaId", "artifactHash", "bindingHash", "gateEpoch", "expiresAtMs"])
      || !HEX64.test(String(ref.artifactHash ?? ""))) {
      fail("XHS_V3_P6_E_CORPUS_REF_INVALID", "R3 run record contains a malformed E-Corpus reference");
    }
    const artifactPath = join(
      XHS_E_CORPUS_PASS_ROOT,
      ref.artifactHash,
      XHS_E_CORPUS_PASS_ARTIFACT_NAME,
    );
    if (!within(XHS_E_CORPUS_PASS_ROOT, artifactPath)) {
      fail("XHS_V3_P6_E_CORPUS_PATH_ESCAPE", "E-Corpus reference escaped its fixed store");
    }
    const artifact = parseCanonicalPrivateJson(readPlainFile(artifactPath, {
      fsImpl,
      maximumBytes: 4 * 1024 * 1024,
      code: "XHS_V3_P6_E_CORPUS_ARTIFACT_INVALID",
    }), "XHS_V3_P6_E_CORPUS_ARTIFACT_INVALID");
    const verified = store.verify({ ref, expectedBinding: artifact.binding, caller: taskBinding });
    if (verified.binding.releaseId !== runtimeBinding.releaseId
      || verified.binding.sourceCommit !== runtimeBinding.sourceCommit
      || verified.binding.providerBundleDigest !== runtimeBinding.providerBundleDigest
      || verified.binding.digestKeyId !== runtimeBinding.digestKeyId) {
      fail("XHS_V3_P6_E_CORPUS_BINDING_DRIFT", "E-Corpus PASS differs from the accepted runtime");
    }
    return verified;
  };
}

/**
 * Production-only constructor. Its only collaborators are already-owned
 * in-process Gate-F state and an optional release-linked post-E adapter. It
 * exposes no caller-selected filesystem/network/provider surface.
 */
export function createFixedXhsV3TaskBootstrap({
  gateFOperations,
  releaseIdentity,
  postECorpusRunner = null,
} = {}) {
  if (!gateFOperations || typeof gateFOperations.status !== "function") {
    fail("XHS_V3_GATE_F_OPERATIONS_REQUIRED", "Gate-F state is required in the owning listener");
  }
  const identity = loadXhsV3GateFIdentityFromEnv({ releaseIdentity });
  const fsImpl = DEFAULT_FS;
  const privateAcl = createSystemTcbAclController();
  privateAcl.verify(buildSystemTcbAclPlan({
    boundaryPath: XHS_V3_RUNTIME_ROOT,
    targetPath: XHS_V3_TASK_PRIVATE_ROOT,
    recursive: true,
  }));

  const keyringBytes = readPlainFile(XHS_V3_TASK_KEYRING_PATH, {
    fsImpl,
    maximumBytes: 1024 * 1024,
    code: "XHS_V3_DIGEST_KEYRING_INVALID",
  });
  if (sha256Bytes(keyringBytes) !== identity.digestKeyringSha256) {
    fail("XHS_V3_DIGEST_KEYRING_DRIFT", "active task keyring differs from Gate F");
  }
  const keyring = createDigestKeyring({ path: XHS_V3_TASK_KEYRING_PATH });
  const loadedKeys = keyring.load();
  const activeKey = loadedKeys.keys.get(loadedKeys.activeKeyId);
  if (!activeKey || activeKey.status !== "active") {
    fail("XHS_V3_DIGEST_KEYRING_INVALID", "active task key is unavailable");
  }

  const providerBytes = readPlainFile(EXPLORATION_VISION_CONFIG_PATH, {
    fsImpl,
    maximumBytes: 16 * 1024 * 1024,
    code: "XHS_V3_PROVIDER_CONFIG_INVALID",
  });
  if (sha256Bytes(providerBytes) !== identity.providerConfigSha256) {
    fail("XHS_V3_PROVIDER_CONFIG_DRIFT", "provider config differs from Gate F");
  }
  const provider = resolvePinnedVisionConfig(EXPLORATION_VISION_CONFIG_PATH);
  verifyResolvedPrivateProviderConfig(provider);
  if (provider.provider.providerBundleDigest !== identity.providerBundleDigest) {
    fail("XHS_V3_PROVIDER_DRIFT", "verified provider closure differs from Gate F");
  }

  const runtimeBinding = Object.freeze({
    releaseId: identity.releaseId,
    sourceCommit: identity.sourceCommit,
    providerBundleDigest: identity.providerBundleDigest,
    digestKeyId: loadedKeys.activeKeyId,
    accountFingerprint: identity.accountFingerprint,
  });
  const taskBinding = Object.freeze(Object.fromEntries(
    OWNER_KEYS.map((key) => [key, identity[key]]),
  ));
  const persistCapture = createTaskOwnedCapturePersistence({
    root: XHS_V3_TASK_CAPTURE_ROOT,
    sealPrivateTree(path) {
      privateAcl.protect(buildSystemTcbAclPlan({
        boundaryPath: XHS_V3_RUNTIME_ROOT,
        targetPath: path,
        recursive: true,
      }));
    },
  });
  const captureAuthority = createTaskOwnedCpCaptureAuthority({
    signingKey: activeKey.keyBytes,
    digestKeyId: loadedKeys.activeKeyId,
    runtimeBinding,
    persistCapture,
  });
  const runRecordStore = createTaskOwnedRunRecordStore({
    root: XHS_V3_TASK_RUN_ROOT,
    taskBinding: Object.freeze(Object.fromEntries(
      OWNER_KEYS.map((key) => [key, identity[key]]),
    )),
    runtimeBinding,
    sealPrivateTree(path) {
      privateAcl.protect(buildSystemTcbAclPlan({
        boundaryPath: XHS_V3_RUNTIME_ROOT,
        targetPath: path,
        recursive: false,
      }));
    },
  });
  const closeoutAcceptance = createTaskOwnedP6Closeout({
    runRecordStore,
    captureRoot: XHS_V3_TASK_CAPTURE_ROOT,
    acceptanceRoot: XHS_V3_TASK_ACCEPTANCE_ROOT,
    signingKey: activeKey.keyBytes,
    digestKeyId: loadedKeys.activeKeyId,
    verifyECorpusPass: createFixedP6ECorpusVerifier({
      keyring,
      taskBinding,
      runtimeBinding,
      privateAcl,
      fsImpl,
    }),
    sealPrivateTree(path) {
      privateAcl.protect(buildSystemTcbAclPlan({
        boundaryPath: XHS_V3_RUNTIME_ROOT,
        targetPath: path,
        recursive: true,
      }));
    },
  });
  const routineRuntime = createExplorerRoutineRuntime();
  const runner = createXhsV3ProductionRunner({
    runtime: routineRuntime,
    captureAuthority,
    r0FixtureRunner: createDeployedR0FixtureRunner({
      runtimeBinding,
      signingKey: activeKey.keyBytes,
      digestKeyId: loadedKeys.activeKeyId,
    }),
  });
  const resolvedPostECorpusRunner = postECorpusRunner ?? createXhsV3PostECorpusProductionRunner({
    runtime: routineRuntime,
    captureAuthority,
  });
  const loadTaskInvocation = createTaskOwnedInvocationLoader({
    root: XHS_V3_TASK_INVOCATION_ROOT,
  });
  const persistTaskInvocation = createTaskOwnedInvocationWriter({
    root: XHS_V3_TASK_INVOCATION_ROOT,
    sealPrivateTree(path) {
      privateAcl.protect(buildSystemTcbAclPlan({
        boundaryPath: XHS_V3_RUNTIME_ROOT,
        targetPath: path,
        recursive: false,
      }));
    },
  });
  const evaluatorSourceBytes = readFileSync(fileURLToPath(import.meta.url));
  const expectedRuntime = Object.freeze({
    releaseId: runtimeBinding.releaseId,
    sourceCommit: runtimeBinding.sourceCommit,
    providerBundleDigest: runtimeBinding.providerBundleDigest,
    digestKeyId: runtimeBinding.digestKeyId,
  });
  const corpusAssembler = createTaskOwnedCorpusAssembler({
    captureRoot: XHS_V3_TASK_CAPTURE_ROOT,
    corpusRoot: XHS_V3_TASK_CORPUS_SET_ROOT,
    signingKey: activeKey.keyBytes,
    digestKeyId: loadedKeys.activeKeyId,
    expectedRuntime,
    sealPrivateTree(path) {
      privateAcl.protect(buildSystemTcbAclPlan({
        boundaryPath: XHS_V3_RUNTIME_ROOT,
        targetPath: path,
        recursive: true,
      }));
    },
  });
  const evaluateCorpusSet = createTaskOwnedCorpusEvaluator({
    captureRoot: XHS_V3_TASK_CAPTURE_ROOT,
    corpusRoot: XHS_V3_TASK_CORPUS_SET_ROOT,
    signingKey: activeKey.keyBytes,
    digestKeyId: loadedKeys.activeKeyId,
    expectedRuntime,
    providerConfig: provider,
    sealPrivateTree(path) {
      privateAcl.protect(buildSystemTcbAclPlan({
        boundaryPath: XHS_V3_RUNTIME_ROOT,
        targetPath: path,
        recursive: true,
      }));
    },
  });

  const buildTaskInvocation = createBuiltInTaskInvocationBuilder({
    identity,
    providerBinding: provider.provider,
    signingKey: activeKey.keyBytes,
    digestKeyId: loadedKeys.activeKeyId,
  });

  function sealPrivateFile(path) {
    privateAcl.protect(buildSystemTcbAclPlan({
      boundaryPath: XHS_V3_RUNTIME_ROOT,
      targetPath: path,
      recursive: false,
    }));
  }

  function eCorpusAclVerified({ path, stat }) {
    let lstat;
    try {
      lstat = fsImpl.lstatSync(path);
    } catch {
      return false;
    }
    if (!within(XHS_V3_RUNTIME_ROOT, path)
      || lstat.isSymbolicLink()
      || resolve(fsImpl.realpathSync(path)) !== resolve(path)
      || (!stat.isDirectory() && !stat.isFile())
      || (stat.isFile() && stat.nlink !== 1)) return false;
    privateAcl.verify(buildSystemTcbAclPlan({
      boundaryPath: XHS_V3_RUNTIME_ROOT,
      targetPath: path,
      recursive: false,
    }));
    return true;
  }

  const eCorpusArtifactStore = createECorpusPassStore({
    artifactRoot: XHS_E_CORPUS_PASS_ROOT,
    canonicalArtifactRoot: XHS_E_CORPUS_PASS_ROOT,
    owner: taskBinding,
    keyring,
    fsImpl,
    aclChecker: eCorpusAclVerified,
  });

  function loadFixedCorpusInputs(corpusSetId) {
    const setRoot = join(XHS_V3_TASK_CORPUS_SET_ROOT, corpusSetId);
    if (!within(XHS_V3_TASK_CORPUS_SET_ROOT, setRoot)) {
      fail("XHS_V3_E_CORPUS_PATH_ESCAPE", "corpus set escaped its fixed private root");
    }
    const bundlePath = join(setRoot, "sealed-corpus.v1.json");
    const evaluatorPath = join(setRoot, "production-evaluator-outcome.v1.json");
    const bundle = parseCanonicalPrivateJson(readPlainFile(bundlePath, {
      fsImpl,
      maximumBytes: MAX_CORPUS_BYTES,
      code: "XHS_V3_E_CORPUS_BUNDLE_INVALID",
    }), "XHS_V3_E_CORPUS_BUNDLE_INVALID");
    if (!Array.isArray(bundle.captureReceipts) || !Array.isArray(bundle.privateIndex?.captureReceiptHashes)
      || bundle.captureReceipts.length !== bundle.privateIndex.captureReceiptHashes.length) {
      fail("XHS_V3_E_CORPUS_BUNDLE_INVALID", "sealed corpus does not bind persisted capture receipts");
    }
    const persisted = new Map(bundle.privateIndex.captureReceiptHashes.map((hash) => [
      hash,
      storedCaptureReceipt(XHS_V3_TASK_CAPTURE_ROOT, hash, fsImpl),
    ]));
    for (const receipt of bundle.captureReceipts) {
      const hash = sha256Hex(Buffer.from(canonicalJson(receipt), "utf8"));
      if (canonicalJson(persisted.get(hash)) !== canonicalJson(receipt)) {
        fail("XHS_V3_E_CORPUS_CAPTURE_INVALID", "sealed corpus receipt was not loaded from task persistence");
      }
    }
    const evaluatorOutcome = parseCanonicalPrivateJson(readPlainFile(evaluatorPath, {
      fsImpl,
      maximumBytes: 16 * 1024 * 1024,
      code: "XHS_V3_EVALUATOR_OUTCOME_INVALID",
    }), "XHS_V3_EVALUATOR_OUTCOME_INVALID");
    return Object.freeze({ setRoot, bundle, evaluatorOutcome });
  }

  function deriveFixedECorpusMaterial(corpusSetId, gateEpoch) {
    const fixed = loadFixedCorpusInputs(corpusSetId);
    const corpusManifestHash = sha256Hex(Buffer.from(
      canonicalJson(fixed.bundle.publicManifest),
      "utf8",
    ));
    const privateIndexDigest = sha256Hex(Buffer.from(
      canonicalJson(fixed.bundle.privateIndex),
      "utf8",
    ));
    const evaluatorOutcome = validateEvaluatorOutcome(fixed.evaluatorOutcome, {
      corpusSetId,
      runtime: expectedRuntime,
      corpusManifestHash,
      privateIndexDigest,
    });
    return Object.freeze({
      ...fixed,
      material: deriveVerifiedECorpusPassMaterial({
        sealedCorpus: fixed.bundle,
        evaluatorOutcome,
        expectedRuntime,
        gateEpoch,
        corpusSigningKey: activeKey.keyBytes,
        evaluatorSourceBytes,
      }),
    });
  }

  function loadOrCreateSealIntent(corpusSetId, context, gateIdentity) {
    if (!exactObject(context, ["expiryPolicy", "requestedAtMs"])
      || !Object.hasOwn(XHS_V3_EXPIRY_POLICIES, context.expiryPolicy)
      || !Number.isInteger(context.requestedAtMs)) {
      fail("XHS_V3_E_CORPUS_SEAL_INTENT_INVALID", "fixed seal context is malformed");
    }
    const { setRoot } = loadFixedCorpusInputs(corpusSetId);
    const path = join(setRoot, XHS_V3_E_SEAL_INTENT_NAME);
    const validate = (intent) => {
      const keys = [
        "schemaId", "schemaVersion", "corpusSetId", "expiryPolicy", "issuedAtMs",
        "expiresAtMs", "runtime", "taskOwner", "gateEpoch",
      ];
      if (!exactObject(intent, keys)
        || intent.schemaId !== XHS_V3_E_SEAL_INTENT_SCHEMA_ID || intent.schemaVersion !== 1
        || intent.corpusSetId !== corpusSetId || intent.expiryPolicy !== context.expiryPolicy
        || !Number.isInteger(intent.issuedAtMs) || !Number.isInteger(intent.expiresAtMs)
        || intent.issuedAtMs > context.requestedAtMs
        || intent.expiresAtMs - intent.issuedAtMs
          !== XHS_V3_EXPIRY_POLICIES[context.expiryPolicy]
        || canonicalJson(intent.runtime) !== canonicalJson(expectedRuntime)
        || canonicalJson(intent.taskOwner) !== canonicalJson(taskBinding)
        || intent.gateEpoch !== gateIdentity.epochHash) {
        fail("XHS_V3_E_CORPUS_SEAL_INTENT_DRIFT", "persisted seal intent differs from this release/gate/corpus request");
      }
      return Object.freeze(intent);
    };
    if (fsImpl.existsSync(path)) {
      return validate(parseCanonicalPrivateJson(readPlainFile(path, {
        fsImpl,
        maximumBytes: 1024 * 1024,
        code: "XHS_V3_E_CORPUS_SEAL_INTENT_INVALID",
      }), "XHS_V3_E_CORPUS_SEAL_INTENT_INVALID"));
    }
    const intent = Object.freeze({
      schemaId: XHS_V3_E_SEAL_INTENT_SCHEMA_ID,
      schemaVersion: 1,
      corpusSetId,
      expiryPolicy: context.expiryPolicy,
      issuedAtMs: context.requestedAtMs,
      expiresAtMs: context.requestedAtMs + XHS_V3_EXPIRY_POLICIES[context.expiryPolicy],
      runtime: expectedRuntime,
      taskOwner: taskBinding,
      gateEpoch: gateIdentity.epochHash,
    });
    writeExactCreateOnlyPrivateFile(path, intent, {
      fsImpl,
      sealPrivateTree: sealPrivateFile,
      maximumBytes: 1024 * 1024,
      code: "XHS_V3_E_CORPUS_SEAL_INTENT_WRITE_FAILED",
    });
    return validate(intent);
  }

  function validateECorpusLocator(locator, artifactHash = null) {
    const keys = [
      "schemaId", "schemaVersion", "locatorHash", "corpusSetId", "expiryPolicy",
      "runtime", "taskOwner", "gateEpoch", "ref", "binding", "testReportHash",
    ];
    if (!exactObject(locator, keys)
      || locator.schemaId !== XHS_V3_E_SEAL_LOCATOR_SCHEMA_ID || locator.schemaVersion !== 1
      || eCorpusSealLocatorHash(locator) !== locator.locatorHash
      || !INVOCATION_ID.test(String(locator.corpusSetId ?? ""))
      || String(locator.corpusSetId).includes("..")
      || !Object.hasOwn(XHS_V3_EXPIRY_POLICIES, locator.expiryPolicy)
      || canonicalJson(locator.runtime) !== canonicalJson(expectedRuntime)
      || canonicalJson(locator.taskOwner) !== canonicalJson(taskBinding)
      || !HEX64.test(String(locator.gateEpoch ?? ""))
      || !HEX64.test(String(locator.ref?.artifactHash ?? ""))
      || (artifactHash !== null && locator.ref.artifactHash !== artifactHash)
      || locator.ref.gateEpoch !== locator.gateEpoch
      || locator.binding?.gateEpoch !== locator.gateEpoch
      || locator.binding?.testReportHash !== locator.testReportHash
      || !HEX64.test(String(locator.testReportHash ?? ""))) {
      fail("XHS_V3_E_CORPUS_LOCATOR_INVALID", "content-addressed E-Corpus locator is malformed or drifted");
    }
    return Object.freeze(locator);
  }

  function persistECorpusLocator({ corpusSetId, intent, sealed }) {
    const body = {
      schemaId: XHS_V3_E_SEAL_LOCATOR_SCHEMA_ID,
      schemaVersion: 1,
      corpusSetId,
      expiryPolicy: intent.expiryPolicy,
      runtime: expectedRuntime,
      taskOwner: taskBinding,
      gateEpoch: intent.gateEpoch,
      ref: sealed.ref,
      binding: sealed.artifact?.binding,
      testReportHash: sealed.evaluation?.testReportHash,
    };
    const locator = validateECorpusLocator(Object.freeze({
      ...body,
      locatorHash: sha256Bytes(Buffer.from(canonicalJson(body), "utf8")),
    }), sealed.ref?.artifactHash);
    persistTaskOwnedECorpusLocatorPair({
      locator,
      artifactRoot: XHS_E_CORPUS_PASS_ROOT,
      corpusSetRoot: XHS_V3_TASK_CORPUS_SET_ROOT,
      fsImpl,
      sealPrivateTree: sealPrivateFile,
    });
    return locator;
  }

  async function createCorpusSealer(corpusSetId, context) {
    const gateIdentity = assertXhsV3GateFReadySnapshot(gateFOperations.status());
    const intent = loadOrCreateSealIntent(corpusSetId, context, gateIdentity);
    const fixed = loadFixedCorpusInputs(corpusSetId);
    const registry = createTaskOwnedXhsECorpusRegistry({
      keyring,
      taskBinding,
      expectedRuntime,
      gateEpoch: intent.gateEpoch,
      corpusSigningKey: activeKey.keyBytes,
      now: () => intent.issuedAtMs,
      loadSealedCorpus: async () => fixed.bundle,
      evaluatorSourceBytes,
      evaluateCorpus: async ({ corpusManifestHash, privateIndexDigest }) => (
        validateEvaluatorOutcome(fixed.evaluatorOutcome, {
          corpusSetId,
          runtime: expectedRuntime,
          corpusManifestHash,
          privateIndexDigest,
        })
      ),
      aclChecker({ path, stat }) {
        if (!within(XHS_V3_RUNTIME_ROOT, path)
          || (!stat.isDirectory() && !stat.isFile())
          || (stat.isFile() && stat.nlink !== 1)) return false;
        privateAcl.protect(buildSystemTcbAclPlan({
          boundaryPath: XHS_V3_RUNTIME_ROOT,
          targetPath: path,
          recursive: stat.isDirectory(),
        }));
        return true;
      },
    });
    return Object.freeze({
      expiresAtMs: intent.expiresAtMs,
      async sealPass(input = {}) {
        if (!exactObject(input, ["expiresAtMs"]) || input.expiresAtMs !== intent.expiresAtMs) {
          fail("XHS_V3_E_CORPUS_SEAL_INTENT_DRIFT", "seal expiry differs from its persisted intent");
        }
        const sealed = await registry.sealPass(input);
        persistECorpusLocator({ corpusSetId, intent, sealed });
        return sealed;
      },
      createInterlock: registry.createInterlock,
    });
  }

  function openECorpusArtifact(artifactHash) {
    if (!HEX64.test(String(artifactHash ?? ""))) {
      fail("XHS_V3_E_CORPUS_REF_INVALID", "E-Corpus artifact hash is malformed");
    }
    const locatorPath = join(
      XHS_E_CORPUS_PASS_ROOT,
      artifactHash,
      XHS_V3_E_ARTIFACT_LOCATOR_NAME,
    );
    if (!within(XHS_E_CORPUS_PASS_ROOT, locatorPath)) {
      fail("XHS_V3_E_CORPUS_PATH_ESCAPE", "E-Corpus locator escaped its fixed store");
    }
    const locator = validateECorpusLocator(parseCanonicalPrivateJson(readPlainFile(locatorPath, {
      fsImpl,
      maximumBytes: 4 * 1024 * 1024,
      code: "XHS_V3_E_CORPUS_LOCATOR_INVALID",
    }), "XHS_V3_E_CORPUS_LOCATOR_INVALID"), artifactHash);
    if (!eCorpusAclVerified({ path: locatorPath, stat: fsImpl.statSync(locatorPath) })) {
      fail("XHS_V3_E_CORPUS_LOCATOR_INVALID", "E-Corpus locator ACL/ownership is not exact");
    }
    const gateIdentity = assertXhsV3GateFReadySnapshot(gateFOperations.status());
    if (gateIdentity.epochHash !== locator.gateEpoch) {
      fail("XHS_V3_E_CORPUS_GATE_DRIFT", "E-Corpus locator belongs to a different CLOSED Gate epoch");
    }
    const fixed = deriveFixedECorpusMaterial(locator.corpusSetId, locator.gateEpoch);
    if (canonicalJson(fixed.material.binding) !== canonicalJson(locator.binding)
      || fixed.material.evaluation.testReportHash !== locator.testReportHash) {
      fail("XHS_V3_E_CORPUS_BINDING_DRIFT", "corpus/evaluator reproduction differs from the locator");
    }
    const artifactPath = join(
      XHS_E_CORPUS_PASS_ROOT,
      artifactHash,
      XHS_E_CORPUS_PASS_ARTIFACT_NAME,
    );
    const artifact = parseCanonicalPrivateJson(readPlainFile(artifactPath, {
      fsImpl,
      maximumBytes: 4 * 1024 * 1024,
      code: "XHS_V3_E_CORPUS_ARTIFACT_INVALID",
    }), "XHS_V3_E_CORPUS_ARTIFACT_INVALID");
    const ref = eCorpusArtifactRef(artifact);
    if (canonicalJson(ref) !== canonicalJson(locator.ref)) {
      fail("XHS_V3_E_CORPUS_REF_DRIFT", "artifact body/path/reference triple differs from its locator");
    }
    const verification = eCorpusArtifactStore.verify({
      ref,
      expectedBinding: fixed.material.binding,
      caller: taskBinding,
    });
    const interlock = createStoreBackedECorpusInterlock({
      store: eCorpusArtifactStore,
      expectedBinding: fixed.material.binding,
      taskCaller: taskBinding,
    });
    interlock.verifyR3({
      ref,
      releaseId: expectedRuntime.releaseId,
      sourceCommit: expectedRuntime.sourceCommit,
      providerBundleDigest: expectedRuntime.providerBundleDigest,
    });
    return Object.freeze({ ref, interlock, verification });
  }

  return createXhsV3TaskBootstrap({
    runner,
    loadTaskInvocation,
    buildTaskInvocation,
    persistTaskInvocation,
    corpusAssembler,
    evaluateCorpusSet,
    runRecordStore,
    closeoutAcceptance,
    createCorpusSealer,
    openECorpusArtifact,
    assertGateFReady() {
      const gateIdentity = assertXhsV3GateFReadySnapshot(gateFOperations.status());
      const currentIdentity = loadXhsV3GateFIdentityFromEnv({ releaseIdentity });
      if (canonicalJson(currentIdentity) !== canonicalJson(identity)
        || sha256Bytes(readPlainFile(XHS_V3_TASK_KEYRING_PATH, {
          fsImpl,
          maximumBytes: 1024 * 1024,
          code: "XHS_V3_DIGEST_KEYRING_INVALID",
        })) !== identity.digestKeyringSha256
        || sha256Bytes(readPlainFile(EXPLORATION_VISION_CONFIG_PATH, {
          fsImpl,
          maximumBytes: 16 * 1024 * 1024,
          code: "XHS_V3_PROVIDER_CONFIG_INVALID",
        })) !== identity.providerConfigSha256) {
        fail("XHS_V3_GATE_F_IDENTITY_DRIFT", "active task release/provider/key identity drifted after startup");
      }
      return gateIdentity;
    },
    postECorpusRunner: resolvedPostECorpusRunner,
    identityView: identity,
  });
}
