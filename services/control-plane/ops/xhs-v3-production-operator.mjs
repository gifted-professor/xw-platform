#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { loadReleaseIdentity } from "../../../packages/release/lib/release-identity.mjs";
import {
  buildSystemTcbAclPlan,
  createSystemTcbAclController,
} from "../control-plane/lib/windows-system-tcb-acl.mjs";
import {
  XHS_V3_BLIND_REVIEW_ACL_RECEIPT_SCHEMA_ID,
  XHS_V3_BLIND_REVIEW_ROOT,
  buildXhsV3BlindReviewAclPlan,
  createXhsV3BlindReviewAclController,
} from "../control-plane/lib/windows-xhs-blind-review-acl.mjs";
import {
  XHS_V3_FIXED_OPERATOR_AUTH_HEADER,
  XHS_V3_FIXED_OPERATOR_GATE_HEADER,
  XHS_V3_FIXED_OPERATOR_NONCE_HEADER,
  XHS_V3_FIXED_OPERATOR_RELEASE_PATH,
  XHS_V3_FIXED_OPERATOR_RUNTIME_ROOT,
  XHS_V3_FIXED_OPERATOR_TIMESTAMP_HEADER,
  canonicalXhsV3FixedOperatorJson,
  createXhsV3FixedOperatorRequestSigner,
  loadXhsV3FixedOperatorAuthority,
  loadXhsV3FixedOperatorReleaseBinding,
} from "../control-plane/lib/xhs-v3-fixed-operator-auth.mjs";
import {
  GATE_F_CUTOVER_TUPLE_FILENAME,
  GATE_F_TARGET_REFERENCE_FILENAME,
  GATE_F_TARGET_REFERENCE_SCHEMA_ID,
  verifyGateFCutoverTuple,
} from "./gate-f-cutover-operator.mjs";

export const XHS_V3_PRODUCTION_OPERATOR_SCHEMA_ID =
  "xw.xhs.v3-production-fixed-operator.v1";
export const XHS_V3_PRODUCTION_OPERATOR_EVENT_SCHEMA_ID =
  "xw.xhs.v3-production-fixed-operator-event.v1";
export const XHS_V3_BLIND_REVIEW_TEMPLATE_SCHEMA_ID =
  "xw.xhs.v3-fixed-blind-review-template.v1";
export const XHS_V3_BLIND_REVIEW_HUMAN_RESPONSE_SCHEMA_ID =
  "xw.xhs.v3-fixed-blind-review-human-response.v1";
export const XHS_V3_BLIND_REVIEW_ACCESS_ATTESTATION_SCHEMA_ID =
  "xw.xhs.v3-blind-review-access-attestation.v1";
export const XHS_V3_BLIND_REVIEW_SESSION_SCHEMA_ID =
  "xw.xhs.v3-blind-review-session.v1";
export const XHS_V3_PROVIDER_IMPLEMENTER_ID =
  "xhs-v3-provider-implementer-r03";
export const XHS_V3_PRODUCTION_OPERATOR_ORIGIN = "http://127.0.0.1:17920";

const HASH = /^(?!0{64}$)[0-9a-f]{64}$/u;
const HEX40 = /^(?!0{40}$)[0-9a-f]{40}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;
const REVIEWER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u;
const PROGRAM_ID = /^xrp_[a-z0-9][a-z0-9._-]{2,63}$/u;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;
const PHASES = Object.freeze(["R0", "R1", "R2", "R3", "R4"]);
const EXPECTED_OUTCOMES = new Set(["SAFE_UNIQUE", "NO_FALLBACK_EXPECTED", "REJECT"]);
const DUMP_VERDICTS = new Set([
  "COMPLETE_SAFE_UNIQUE", "AMBIGUOUS_SAFE", "ABSENT_OR_INVALID", "FORBIDDEN_OR_RISKY",
]);
const PROTECTED_KINDS = new Set([
  "STATUS_BAR", "TOP_CHROME", "BOTTOM_NAV", "SOCIAL_ACTIONS", "COMMENT_COMPOSER",
]);
const REVIEW_ROW_KEYS = Object.freeze([
  "captureReceiptHash", "captureMode", "phase", "pageClass", "evaluationRole",
  "dumpVerdict", "pngHash", "alias", "laneRole",
]);
const GATE_KEYS = Object.freeze([
  "schemaId", "mode", "phase", "purpose", "epochHash", "generation", "locksHash",
  "tripleConsistent", "errors", "activeAuthorizationCount", "actionCount", "resourceCounts",
]);
const EVENT_NAMES = Object.freeze([
  "R0_PREPARED", "R0_COMPLETED",
  "R1_PREPARED", "R1_COMPLETED",
  "R2_PREPARED", "R2_COMPLETED",
  "REVIEW_PREPARED", "REVIEW_SUBMITTED", "CORPUS_ASSEMBLED",
  "CORPUS_EVALUATED", "E_SEALED",
  "R3_PREPARED", "R3_COMPLETED",
  "R4_PREPARED", "R4_COMPLETED",
  "P6_PASS",
]);

const FIXED_PATHS = Object.freeze({
  status: "/control/v1/internal/m6/gate-f/status",
  health: "/control/v1/health",
  prepareInvocation: "/control/v1/internal/xhs/exploration/prepare-invocation",
  run: "/control/v1/internal/xhs/exploration/run",
  prepareReview: "/control/v1/internal/xhs/exploration/prepare-corpus-review",
  submitReview: "/control/v1/internal/xhs/exploration/submit-corpus-review",
  assemble: "/control/v1/internal/xhs/exploration/assemble-corpus-set",
  evaluate: "/control/v1/internal/xhs/exploration/evaluate-corpus-set",
  sealE: "/control/v1/internal/xhs/exploration/seal-e-corpus",
  closeoutP6: "/control/v1/internal/xhs/exploration/closeout-p6",
  rpaHealth: "/control/v1/internal/xhs/rpa/health",
  rpaPlan: "/control/v1/internal/xhs/rpa/plan",
  rpaStatus: "/control/v1/internal/xhs/rpa/status",
  rpaManual: "/control/v1/internal/xhs/rpa/manual-once",
  rpaDisable: "/control/v1/internal/xhs/rpa/disable",
});

const DEFAULT_FS = Object.freeze({
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
});

const BLIND_REVIEW_CLIENT_PATH = fileURLToPath(new URL("./xhs-v3-blind-review-submit.mjs", import.meta.url));

function operatorError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function fail(code, message) {
  throw operatorError(code, message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exact(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()));
}

function prettyBytes(value) {
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
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function assertSafeId(value, code = "XHS_V3_OPERATOR_ARGUMENT_INVALID") {
  if (!SAFE_ID.test(String(value ?? "")) || String(value).includes("..")) {
    fail(code, "opaque identifier is invalid");
  }
  return String(value);
}

function assertHash(value, code = "XHS_V3_OPERATOR_ARGUMENT_INVALID") {
  if (!HASH.test(String(value ?? ""))) fail(code, "content hash is invalid");
  return String(value);
}

function assertGeneration(value) {
  const generation = Number(value);
  if (!/^[1-9][0-9]{0,9}$/u.test(String(value ?? ""))
    || !Number.isSafeInteger(generation) || generation < 1) {
    fail("XHS_V3_OPERATOR_ARGUMENT_INVALID", "generation is invalid");
  }
  return generation;
}

function rejectOptionLike(argv) {
  if (argv.some((value) => typeof value !== "string" || value === ""
    || value.startsWith("-") || /[\\/\0\r\n]/u.test(value))) {
    fail("XHS_V3_OPERATOR_ARGUMENT_INVALID", "flags, paths, and control characters are forbidden");
  }
}

export function parseXhsV3ProductionOperatorCommand(argv) {
  if (!Array.isArray(argv)) fail("XHS_V3_OPERATOR_ARGUMENT_INVALID", "arguments must be an array");
  rejectOptionLike(argv);
  if (argv.length === 1 && argv[0] === "health-fixed") return Object.freeze({ kind: "health" });
  if (argv.length === 1 && argv[0] === "verify-blind-review-runtime-fixed") {
    return Object.freeze({ kind: "verify-blind-review-runtime" });
  }
  if (argv.length === 3 && ["prepare-fixed", "run-fixed"].includes(argv[0])
    && PHASES.includes(argv[1])) {
    return Object.freeze({
      kind: argv[0] === "prepare-fixed" ? "prepare" : "run",
      phase: argv[1],
      runSetId: assertSafeId(argv[2]),
    });
  }
  if (argv.length === 3 && argv[0] === "prepare-review-fixed") {
    return Object.freeze({ kind: "prepare-review", runSetId: assertSafeId(argv[1]), corpusSetId: assertSafeId(argv[2]) });
  }
  if (argv.length === 4 && argv[0] === "submit-review-fixed") {
    return Object.freeze({
      kind: "submit-review",
      runSetId: assertSafeId(argv[1]),
      corpusSetId: assertSafeId(argv[2]),
      responseHash: assertHash(argv[3]),
    });
  }
  if (argv.length === 3 && [
    "assemble-fixed", "evaluate-fixed", "seal-e-fixed",
  ].includes(argv[0])) {
    return Object.freeze({
      kind: argv[0].replace("-fixed", ""),
      runSetId: assertSafeId(argv[1]),
      corpusSetId: assertSafeId(argv[2]),
    });
  }
  if (argv.length === 2 && argv[0] === "closeout-p6-fixed") {
    return Object.freeze({ kind: "closeout-p6", runSetId: assertSafeId(argv[1]) });
  }
  if (argv.length === 2 && ["rpa-plan-fixed", "rpa-status-fixed"].includes(argv[0])
    && PROGRAM_ID.test(argv[1])) {
    return Object.freeze({ kind: argv[0].replace("-fixed", ""), programId: argv[1] });
  }
  if (argv.length === 3 && argv[0] === "rpa-disable-fixed" && PROGRAM_ID.test(argv[1])) {
    return Object.freeze({ kind: "rpa-disable", programId: argv[1], generation: assertGeneration(argv[2]) });
  }
  if (argv.length === 4 && argv[0] === "rpa-manual-once-fixed"
    && PROGRAM_ID.test(argv[1]) && IDEMPOTENCY.test(argv[3])) {
    return Object.freeze({
      kind: "rpa-manual-once",
      programId: argv[1],
      generation: assertGeneration(argv[2]),
      idempotencyKey: argv[3],
    });
  }
  fail("XHS_V3_OPERATOR_ARGUMENT_INVALID", "command does not match the fixed grammar");
}

function readPlainBytes(path, { fsImpl = DEFAULT_FS, maximumBytes, code }) {
  try {
    const stat = fsImpl.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || !Number.isSafeInteger(stat.size) || stat.size < 2 || stat.size > maximumBytes
      || !samePath(fsImpl.realpathSync(path), path)) {
      fail(code, "private material is linked, reparsed, or outside its size bound");
    }
    return Buffer.from(fsImpl.readFileSync(path));
  } catch (error) {
    if (error?.code?.startsWith?.("XHS_V3_")) throw error;
    fail(code, "private material is unavailable");
  }
}

function readJson(bytes, code) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(code, "private material is not valid UTF-8 JSON");
  }
}

function assertPlainDirectory(path, fsImpl, code) {
  try {
    const stat = fsImpl.lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fsImpl.realpathSync(path), path)) {
      fail(code, "private directory is linked or reparsed");
    }
  } catch (error) {
    if (error?.code?.startsWith?.("XHS_V3_")) throw error;
    fail(code, "private directory is unavailable");
  }
}

function assertGateClosed(gate) {
  if (!exact(gate, GATE_KEYS)
    || gate.schemaId !== "xw.m6-gate-f-operations-status.v1"
    || gate.mode !== "CLOSED" || gate.phase !== "CLOSED" || gate.purpose !== null
    || gate.tripleConsistent !== true || !Array.isArray(gate.errors) || gate.errors.length !== 0
    || gate.activeAuthorizationCount !== 0 || gate.actionCount !== 0
    || !HASH.test(String(gate.epochHash ?? "")) || !HASH.test(String(gate.locksHash ?? ""))
    || !Number.isSafeInteger(gate.generation) || gate.generation < 0
    || !exact(gate.resourceCounts, ["jobs", "leases", "runs", "sessions"])
    || Object.values(gate.resourceCounts).some((value) => value !== 0)) {
    fail("XHS_V3_OPERATOR_GATE_F_NOT_CLOSED", "operation requires exact CLOSED zero-resource Gate F");
  }
  return Object.freeze({
    status: "CLOSED",
    epochHash: gate.epochHash,
    generation: gate.generation,
    locksHash: gate.locksHash,
  });
}

function safeServerError(value, status) {
  const code = value?.error?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{3,128}$/u.test(code)) return code;
  return status >= 500 ? "XHS_V3_OPERATOR_REMOTE_UNAVAILABLE" : "XHS_V3_OPERATOR_REMOTE_REJECTED";
}

async function boundedResponseBytes(response, maximumBytes = 16 * 1024 * 1024) {
  const length = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > maximumBytes) {
    fail("XHS_V3_OPERATOR_REMOTE_RESPONSE_INVALID", "remote response exceeds its fixed bound");
  }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maximumBytes) fail("XHS_V3_OPERATOR_REMOTE_RESPONSE_INVALID", "remote response exceeds its fixed bound");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      fail("XHS_V3_OPERATOR_REMOTE_RESPONSE_INVALID", "remote response exceeds its fixed bound");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

function assertNoRecurringTrue(value) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) assertNoRecurringTrue(child);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (["recurringEnabled", "RPA_RECURRING_ENABLED"].includes(key) && child !== false) {
      fail("XHS_V3_OPERATOR_RPA_RECURRING_FORBIDDEN", "RPA recurring state must remain false");
    }
    assertNoRecurringTrue(child);
  }
}

function inputBinding(command) {
  return Object.freeze(Object.fromEntries(Object.entries(command)
    .filter(([key]) => key !== "kind")
    .sort(([left], [right]) => left.localeCompare(right))));
}

function eventFileName(index, name) {
  return `${String(index).padStart(2, "0")}-${name.toLowerCase().replaceAll("_", "-")}.v1.json`;
}

function eventHash(body) {
  return sha256(Buffer.from(canonicalXhsV3FixedOperatorJson(body), "utf8"));
}

function validateStoredEvent(value, index, name, binding) {
  const keys = [
    "schemaId", "schemaVersion", "sequence", "event", "releaseId", "sourceCommit",
    "operatorSha256", "runSetId", "input", "result", "eventHash",
  ];
  if (!exact(value, keys) || value.schemaId !== XHS_V3_PRODUCTION_OPERATOR_EVENT_SCHEMA_ID
    || value.schemaVersion !== 1 || value.sequence !== index || value.event !== name
    || value.releaseId !== binding.releaseId || value.sourceCommit !== binding.sourceCommit
    || value.operatorSha256 !== binding.operatorSha256 || !SAFE_ID.test(value.runSetId || "")
    || !HASH.test(value.eventHash || "")) {
    fail("XHS_V3_OPERATOR_LEDGER_DRIFT", "operator event identity drifted");
  }
  const { eventHash: observed, ...body } = value;
  if (eventHash(body) !== observed) fail("XHS_V3_OPERATOR_LEDGER_DRIFT", "operator event hash drifted");
  return value;
}

function validateReviewRequest(value, { corpusSetId, binding }) {
  if (!exact(value, ["schemaId", "schemaVersion", "corpusSetId", "runtime", "receipts"])
    || value.schemaId !== "xw.xhs.v3-corpus-review-request.v1" || value.schemaVersion !== 1
    || value.corpusSetId !== corpusSetId
    || !exact(value.runtime, ["releaseId", "sourceCommit", "providerBundleDigest", "digestKeyId"])
    || value.runtime.releaseId !== binding.releaseId || value.runtime.sourceCommit !== binding.sourceCommit
    || !HASH.test(value.runtime.providerBundleDigest || "")
    || !SAFE_ID.test(value.runtime.digestKeyId || "")
    || !Array.isArray(value.receipts) || value.receipts.length === 0 || value.receipts.length > 10_000) {
    fail("XHS_V3_OPERATOR_REVIEW_REQUEST_INVALID", "fixed blind review request drifted");
  }
  const seen = new Set();
  for (const row of value.receipts) {
    if (!exact(row, REVIEW_ROW_KEYS) || !HASH.test(row.captureReceiptHash || "")
      || seen.has(row.captureReceiptHash) || row.captureMode !== "CP_BOUND_R1_R2"
      || !["R1", "R2"].includes(row.phase) || !HASH.test(row.pngHash || "")
      || !SAFE_ID.test(row.pageClass || "") || !SAFE_ID.test(row.evaluationRole || "")
      || !DUMP_VERDICTS.has(row.dumpVerdict) || !SAFE_ID.test(row.alias || "")
      || !SAFE_ID.test(row.laneRole || "")) {
      fail("XHS_V3_OPERATOR_REVIEW_REQUEST_INVALID", "blind review receipt row drifted");
    }
    seen.add(row.captureReceiptHash);
  }
  return value;
}

function validateBounds(bounds) {
  return Array.isArray(bounds) && bounds.length === 4
    && bounds.every((value) => Number.isInteger(value) && value >= 0 && value <= 100_000)
    && bounds[2] > bounds[0] && bounds[3] > bounds[1];
}

export function validateXhsV3BlindReviewHumanResponse(value, {
  request, session, accessAttestationHash, responseHash, rawBytes,
}) {
  if (!exact(value, [
    "schemaId", "schemaVersion", "corpusSetId", "sessionId", "challenge",
    "reviewRequestHash", "accessAttestationHash", "annotations",
  ])
    || value.schemaId !== XHS_V3_BLIND_REVIEW_HUMAN_RESPONSE_SCHEMA_ID
    || value.schemaVersion !== 1 || value.corpusSetId !== request.corpusSetId
    || value.reviewRequestHash !== sha256(rawBytes.request)
    || value.sessionId !== session.sessionId || value.challenge !== session.challenge
    || value.accessAttestationHash !== accessAttestationHash
    || !Array.isArray(value.annotations) || value.annotations.length !== request.receipts.length
    || sha256(rawBytes.response) !== responseHash
    || rawBytes.response.toString("utf8") !== prettyBytes(value).toString("utf8")) {
    fail("XHS_V3_OPERATOR_REVIEW_RESPONSE_INVALID", "human response schema/hash/binding drifted");
  }
  for (let index = 0; index < value.annotations.length; index += 1) {
    const annotation = value.annotations[index];
    const mapping = session.rows[index];
    const row = request.receipts[index];
    if (!exact(annotation, ["rowId", "expectedOutcome", "positiveRegions", "protectedRegions"])
      || annotation.rowId !== mapping.rowId
      || !EXPECTED_OUTCOMES.has(annotation.expectedOutcome)
      || !Array.isArray(annotation.positiveRegions) || !Array.isArray(annotation.protectedRegions)) {
      fail("XHS_V3_OPERATOR_REVIEW_RESPONSE_INVALID", "human annotation schema/order drifted");
    }
    for (const region of annotation.positiveRegions) {
      if (!exact(region, ["role", "bounds"]) || region.role !== row.evaluationRole
        || !validateBounds(region.bounds)) {
        fail("XHS_V3_OPERATOR_REVIEW_RESPONSE_INVALID", "positive region is invalid");
      }
    }
    for (const region of annotation.protectedRegions) {
      if (!exact(region, ["kind", "bounds"]) || !PROTECTED_KINDS.has(region.kind)
        || !validateBounds(region.bounds)) {
        fail("XHS_V3_OPERATOR_REVIEW_RESPONSE_INVALID", "protected region is invalid");
      }
    }
    if (annotation.expectedOutcome === "SAFE_UNIQUE" && annotation.positiveRegions.length === 0) {
      fail("XHS_V3_OPERATOR_REVIEW_RESPONSE_INVALID", "SAFE_UNIQUE requires human-supplied geometry");
    }
    if (row.dumpVerdict === "COMPLETE_SAFE_UNIQUE"
      && (annotation.expectedOutcome !== "NO_FALLBACK_EXPECTED"
        || annotation.positiveRegions.length !== 0)) {
      fail("XHS_V3_OPERATOR_REVIEW_RESPONSE_INVALID", "complete DUMP verdict cannot be promoted or relabelled");
    }
    if (row.dumpVerdict === "FORBIDDEN_OR_RISKY"
      && (annotation.expectedOutcome !== "REJECT" || annotation.positiveRegions.length !== 0)) {
      fail("XHS_V3_OPERATOR_REVIEW_RESPONSE_INVALID", "forbidden DUMP verdict must remain rejected");
    }
    if (["AMBIGUOUS_SAFE", "ABSENT_OR_INVALID"].includes(row.dumpVerdict)
      && !["SAFE_UNIQUE", "REJECT"].includes(annotation.expectedOutcome)) {
      fail("XHS_V3_OPERATOR_REVIEW_RESPONSE_INVALID", "fallback-required DUMP verdict cannot bypass blind pixels");
    }
  }
  return value;
}

function safeRunProjection(value, phase) {
  if (!value || value.ok !== true || value.status !== "SUCCEEDED" || value.phase !== phase
    || !HASH.test(String(value.receiptHash ?? ""))) {
    fail("XHS_V3_OPERATOR_RUN_RECEIPT_INVALID", "task run did not produce one safe success receipt");
  }
  const captureReceiptCount = Array.isArray(value.captureReceiptHashes)
    ? value.captureReceiptHashes.length
    : 0;
  if (Array.isArray(value.captureReceiptHashes)
    && value.captureReceiptHashes.some((hash) => !HASH.test(String(hash)))) {
    fail("XHS_V3_OPERATOR_RUN_RECEIPT_INVALID", "task run capture receipt list is malformed");
  }
  return Object.freeze({ status: "SUCCEEDED", phase, receiptHash: value.receiptHash, captureReceiptCount });
}

function safeCode(error) {
  const code = error?.code;
  return typeof code === "string" && /^[A-Z0-9_]{3,128}$/u.test(code)
    ? code
    : "XHS_V3_OPERATOR_FAILED";
}

export function createXhsV3ProductionOperatorForTest({
  runtimeRoot,
  binding,
  gateToken,
  signer,
  fetchImpl,
  fsImpl = DEFAULT_FS,
  aclController,
  reviewAclController,
  reviewWorkspaceRoot,
  providerBundleDigest = "e".repeat(64),
  taskOwnershipHash = "f".repeat(64),
  now = Date.now,
  randomBytesFn = randomBytes,
  intentOwnerId = randomBytes(32).toString("hex"),
  intentOwnerPid = process.pid,
  isIntentOwnerActive = ({ ownerPid }) => {
    try { process.kill(ownerPid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; }
  },
} = {}) {
  if (typeof runtimeRoot !== "string" || !isAbsolute(runtimeRoot)
    || !binding || !HASH.test(binding.operatorSha256 || "")
    || !HEX40.test(binding.sourceCommit || "") || !SAFE_ID.test(binding.releaseId || "")
    || typeof gateToken !== "string" || gateToken.length < 32
    || !signer || typeof signer.sign !== "function" || typeof fetchImpl !== "function"
    || !aclController || typeof aclController.protect !== "function" || typeof aclController.verify !== "function"
    || !reviewAclController || typeof reviewAclController.protect !== "function"
    || typeof reviewAclController.verify !== "function" || typeof reviewAclController.restore !== "function"
    || typeof reviewAclController.close !== "function"
    || typeof reviewAclController.admitResponse !== "function"
    || typeof reviewWorkspaceRoot !== "string" || !isAbsolute(reviewWorkspaceRoot)
    || !HASH.test(providerBundleDigest)
    || !HASH.test(taskOwnershipHash) || typeof now !== "function" || typeof randomBytesFn !== "function"
    || !HASH.test(intentOwnerId) || !Number.isSafeInteger(intentOwnerPid) || intentOwnerPid < 1
    || typeof isIntentOwnerActive !== "function") {
    fail("XHS_V3_OPERATOR_CONTEXT_INVALID", "fixed operator context is incomplete");
  }
  const root = resolve(runtimeRoot);
  const privateRoot = join(root, "private", "xhs-v3");
  const acceptanceRoot = join(privateRoot, "acceptance");
  const operatorRoot = join(acceptanceRoot, "fixed-operator");
  const corpusRoot = join(privateRoot, "corpus-sets");
  const captureRoot = join(privateRoot, "captures");
  const eCorpusArtifactRoot = join(root, "state", "orchestrator", "e-corpus-pass");
  const reviewerRoot = resolve(reviewWorkspaceRoot);
  const deployedReleaseRoot = join(root, "releases", binding.releaseId);
  const privateProviderRoot = join("C:\\", "Program Files", "XW Platform", "providers");
  const fixedSourceRoot = join("C:\\", "Users", "Public", "xw-fusion", "xw-platform");
  const intentOwnerIdHash = sha256(Buffer.from(intentOwnerId, "utf8"));
  const activeEvents = new Set();

  function acl(path, recursive = false, operation = "verify") {
    const plan = buildSystemTcbAclPlan({ boundaryPath: root, targetPath: path, recursive });
    return aclController[operation](plan);
  }

  function createDirectory(path) {
    if (!within(root, path)) fail("XHS_V3_OPERATOR_PATH_ESCAPE", "fixed private path escaped runtime root");
    if (!fsImpl.existsSync(path)) fsImpl.mkdirSync(path, { recursive: true, mode: 0o700 });
    assertPlainDirectory(path, fsImpl, "XHS_V3_OPERATOR_PRIVATE_ROOT_INVALID");
    acl(path, true, "protect");
    acl(path, true, "verify");
  }

  function ensureRunBinding(runSetId) {
    createDirectory(operatorRoot);
    const bindingsRoot = join(operatorRoot, "run-bindings");
    createDirectory(bindingsRoot);
    const key = sha256(Buffer.from(runSetId, "utf8"));
    const path = join(bindingsRoot, `${key}.v1.json`);
    const value = Object.freeze({
      schemaId: "xw.xhs.v3-fixed-operator-run-binding.v1",
      runSetId,
      releaseId: binding.releaseId,
      sourceCommit: binding.sourceCommit,
      operatorSha256: binding.operatorSha256,
    });
    const bytes = prettyBytes(value);
    if (fsImpl.existsSync(path)) {
      acl(path, false, "verify");
      const existing = readPlainBytes(path, { fsImpl, maximumBytes: 64 * 1024, code: "XHS_V3_OPERATOR_RUN_RELEASE_DRIFT" });
      if (!existing.equals(bytes)) fail("XHS_V3_OPERATOR_RUN_RELEASE_DRIFT", "run set is already bound to another FINAL release");
    } else {
      fsImpl.writeFileSync(path, bytes, { flag: "wx", mode: 0o600, flush: true });
      acl(path, false, "protect");
      acl(path, false, "verify");
    }
  }

  function runRoot(runSetId) {
    ensureRunBinding(runSetId);
    const releaseKey = sha256(Buffer.from(`${binding.releaseId}:${binding.sourceCommit}`, "utf8"));
    const releasesRoot = join(operatorRoot, "releases");
    createDirectory(releasesRoot);
    const releaseRoot = join(releasesRoot, releaseKey);
    createDirectory(releaseRoot);
    const path = join(releaseRoot, runSetId);
    createDirectory(path);
    return path;
  }

  function loadEvents(runSetId) {
    const path = runRoot(runSetId);
    const names = fsImpl.readdirSync(path).sort();
    if (names.length > EVENT_NAMES.length) fail("XHS_V3_OPERATOR_LEDGER_DRIFT", "operator ledger has too many events");
    const values = [];
    for (let index = 0; index < names.length; index += 1) {
      const expectedName = eventFileName(index, EVENT_NAMES[index]);
      if (names[index] !== expectedName) fail("XHS_V3_OPERATOR_LEDGER_DRIFT", "operator ledger is not contiguous");
      const eventPath = join(path, names[index]);
      acl(eventPath, false, "verify");
      const bytes = readPlainBytes(eventPath, { fsImpl, maximumBytes: 1024 * 1024, code: "XHS_V3_OPERATOR_LEDGER_DRIFT" });
      const value = readJson(bytes, "XHS_V3_OPERATOR_LEDGER_DRIFT");
      if (!bytes.equals(prettyBytes(value))) fail("XHS_V3_OPERATOR_LEDGER_DRIFT", "operator event bytes are noncanonical");
      values.push(validateStoredEvent(value, index, EVENT_NAMES[index], binding));
    }
    return { path, values };
  }

  function acquireIntent(command, eventName, index) {
    const releaseKey = sha256(Buffer.from(`${binding.releaseId}:${binding.sourceCommit}`, "utf8"));
    const eventRoot = join(
      operatorRoot,
      "intents",
      releaseKey,
      command.runSetId,
      `${String(index).padStart(2, "0")}-${eventName.toLowerCase().replaceAll("_", "-")}`,
    );
    createDirectory(eventRoot);
    const names = fsImpl.readdirSync(eventRoot).sort();
    if (names.length > 64 || names.some((name, attempt) => name !== `attempt-${String(attempt).padStart(3, "0")}.v1.json`)) {
      fail("XHS_V3_OPERATOR_INTENT_DRIFT", "operator intent ledger is not contiguous and bounded");
    }
    let prior = null;
    if (names.length > 0) {
      const priorPath = join(eventRoot, names.at(-1));
      acl(priorPath, false, "verify");
      const bytes = readPlainBytes(priorPath, {
        fsImpl, maximumBytes: 256 * 1024, code: "XHS_V3_OPERATOR_INTENT_DRIFT",
      });
      prior = readJson(bytes, "XHS_V3_OPERATOR_INTENT_DRIFT");
      if (!bytes.equals(prettyBytes(prior)) || !exact(prior, [
        "schemaId", "schemaVersion", "attempt", "event", "releaseId", "sourceCommit",
        "operatorSha256", "runSetId", "input", "ownerPid", "ownerIdHash", "startedAtMs", "intentHash",
      ])
        || prior.schemaId !== "xw.xhs.v3-fixed-operator-intent.v1"
        || prior.schemaVersion !== 1 || prior.attempt !== names.length - 1
        || prior.event !== eventName || prior.releaseId !== binding.releaseId
        || prior.sourceCommit !== binding.sourceCommit || prior.operatorSha256 !== binding.operatorSha256
        || prior.runSetId !== command.runSetId || !HASH.test(prior.ownerIdHash || "")
        || !Number.isSafeInteger(prior.ownerPid) || prior.ownerPid < 1
        || !Number.isSafeInteger(prior.startedAtMs) || !HASH.test(prior.intentHash || "")) {
        fail("XHS_V3_OPERATOR_INTENT_DRIFT", "operator intent identity drifted");
      }
      const { intentHash, ...priorBody } = prior;
      if (eventHash(priorBody) !== intentHash
        || canonicalXhsV3FixedOperatorJson(prior.input)
          !== canonicalXhsV3FixedOperatorJson(inputBinding(command))) {
        fail("XHS_V3_OPERATOR_REPLAY_INPUT_DRIFT", "incomplete event is bound to different opaque input");
      }
      const activeKey = `${command.runSetId}:${eventName}`;
      if (activeEvents.has(activeKey)
        || (prior.ownerIdHash !== intentOwnerIdHash && isIntentOwnerActive(prior) === true)) {
        fail("XHS_V3_OPERATOR_OPERATION_IN_PROGRESS", "another fixed operator still owns this event");
      }
    }
    const attempt = names.length;
    if (attempt >= 64) fail("XHS_V3_OPERATOR_INTENT_EXHAUSTED", "operator recovery attempt bound is exhausted");
    const startedAtMs = Number(now());
    if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) {
      fail("XHS_V3_OPERATOR_CLOCK_INVALID", "operator intent clock is invalid");
    }
    const body = Object.freeze({
      schemaId: "xw.xhs.v3-fixed-operator-intent.v1",
      schemaVersion: 1,
      attempt,
      event: eventName,
      releaseId: binding.releaseId,
      sourceCommit: binding.sourceCommit,
      operatorSha256: binding.operatorSha256,
      runSetId: command.runSetId,
      input: inputBinding(command),
      ownerPid: intentOwnerPid,
      ownerIdHash: intentOwnerIdHash,
      startedAtMs,
    });
    const value = Object.freeze({ ...body, intentHash: eventHash(body) });
    const path = join(eventRoot, `attempt-${String(attempt).padStart(3, "0")}.v1.json`);
    try {
      fsImpl.writeFileSync(path, prettyBytes(value), { flag: "wx", mode: 0o600, flush: true });
    } catch {
      fail("XHS_V3_OPERATOR_OPERATION_IN_PROGRESS", "another fixed operator acquired this event");
    }
    acl(path, false, "protect");
    acl(path, false, "verify");
    const activeKey = `${command.runSetId}:${eventName}`;
    activeEvents.add(activeKey);
    return Object.freeze({
      activeKey,
      attempt,
      hadPriorIntent: prior !== null,
      priorIntentHash: prior?.intentHash ?? null,
    });
  }

  function beginEvent(command, eventName) {
    const index = EVENT_NAMES.indexOf(eventName);
    if (index < 0) fail("XHS_V3_OPERATOR_EVENT_INVALID", "operator event is unknown");
    const ledger = loadEvents(command.runSetId);
    if (ledger.values.length === index + 1) {
      const last = ledger.values[index];
      if (canonicalXhsV3FixedOperatorJson(last.input)
        !== canonicalXhsV3FixedOperatorJson(inputBinding(command))) {
        fail("XHS_V3_OPERATOR_REPLAY_INPUT_DRIFT", "completed event is bound to different opaque input");
      }
      return Object.freeze({ replay: last.result, index, path: ledger.path, activeKey: null });
    }
    if (ledger.values.length !== index) {
      fail("XHS_V3_OPERATOR_PHASE_ORDER_INVALID", "command is outside the fixed R0-R4/P6 order");
    }
    const acquired = acquireIntent(command, eventName, index);
    return Object.freeze({ replay: null, index, path: ledger.path, ...acquired });
  }

  function assertCorpusBinding(runSetId, corpusSetId) {
    const events = loadEvents(runSetId).values;
    const preparedCorpusSetId = events[6]?.input?.corpusSetId;
    if (preparedCorpusSetId !== corpusSetId) {
      fail("XHS_V3_OPERATOR_CORPUS_BINDING_DRIFT", "corpus operation differs from the prepared blind-review set");
    }
  }

  function commitEvent(command, eventName, begun, result) {
    const body = Object.freeze({
      schemaId: XHS_V3_PRODUCTION_OPERATOR_EVENT_SCHEMA_ID,
      schemaVersion: 1,
      sequence: begun.index,
      event: eventName,
      releaseId: binding.releaseId,
      sourceCommit: binding.sourceCommit,
      operatorSha256: binding.operatorSha256,
      runSetId: command.runSetId,
      input: inputBinding(command),
      result,
    });
    const value = Object.freeze({ ...body, eventHash: eventHash(body) });
    const path = join(begun.path, eventFileName(begun.index, eventName));
    fsImpl.writeFileSync(path, prettyBytes(value), { flag: "wx", mode: 0o600, flush: true });
    acl(path, false, "protect");
    acl(path, false, "verify");
    return result;
  }

  async function fetchJson(path, { method = "GET", body, operatorAuthorized = false } = {}) {
    const headers = { accept: "application/json", [XHS_V3_FIXED_OPERATOR_GATE_HEADER]: gateToken };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (operatorAuthorized) Object.assign(headers, signer.sign({ method, path, body }));
    let response;
    try {
      response = await fetchImpl(`${XHS_V3_PRODUCTION_OPERATOR_ORIGIN}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
      });
    } catch {
      fail("XHS_V3_OPERATOR_REMOTE_UNAVAILABLE", "fixed loopback listener is unavailable");
    }
    const bytes = await boundedResponseBytes(response);
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch {
      fail("XHS_V3_OPERATOR_REMOTE_RESPONSE_INVALID", "fixed loopback listener returned invalid JSON");
    }
    if (!response.ok) fail(safeServerError(value, response.status), "fixed loopback listener rejected the request");
    return value;
  }

  async function gate() {
    const value = await fetchJson(FIXED_PATHS.status);
    return assertGateClosed(value?.gate);
  }

  async function invoke(path, body, method = "POST") {
    const before = await gate();
    const value = await fetchJson(path, { method, body, operatorAuthorized: true });
    const after = await gate();
    if (before.epochHash !== after.epochHash || before.generation !== after.generation
      || before.locksHash !== after.locksHash) {
      fail("XHS_V3_OPERATOR_GATE_F_DRIFT", "Gate F changed across one fixed operation");
    }
    return value;
  }

  function reviewPaths(corpusSetId) {
    const setRoot = join(corpusRoot, corpusSetId);
    if (!within(corpusRoot, setRoot)) fail("XHS_V3_OPERATOR_PATH_ESCAPE", "corpus set escaped its fixed root");
    const releaseKey = sha256(Buffer.from(
      `${binding.releaseId}:${binding.sourceCommit}:${binding.operatorSha256}`, "utf8",
    ));
    const workflowRoot = join(reviewerRoot, releaseKey, corpusSetId);
    if (!within(reviewerRoot, workflowRoot)) {
      fail("XHS_V3_OPERATOR_PATH_ESCAPE", "review workspace escaped its fixed independent root");
    }
    return Object.freeze({
      setRoot,
      requestPath: join(setRoot, "review-request.v1.json"),
      accessAttestationPath: join(setRoot, "review-access-attestation.v1.json"),
      privateSessionPath: join(setRoot, "review-session.v1.json"),
      workflowRoot,
      inputsRoot: join(workflowRoot, "inputs"),
      templatesRoot: join(workflowRoot, "templates"),
      inboxRoot: join(workflowRoot, "inbox"),
      responseDraftPath: join(workflowRoot, "human-response.draft.v1.json"),
      workspaceManifestPath: join(workflowRoot, "blind-review-workspace.v1.json"),
      workspaceSessionPath: join(workflowRoot, "review-session.v1.json"),
    });
  }

  function createReviewerDirectory(path) {
    if (!within(reviewerRoot, path)) {
      fail("XHS_V3_OPERATOR_PATH_ESCAPE", "review workspace escaped its fixed independent root");
    }
    if (!fsImpl.existsSync(path)) fsImpl.mkdirSync(path, { recursive: true, mode: 0o700 });
    assertPlainDirectory(path, fsImpl, "XHS_V3_OPERATOR_REVIEW_WORKSPACE_INVALID");
  }

  function publishExact(path, bytes, { mode = 0o400, maximumBytes = 64 * 1024 * 1024 } = {}) {
    if (!within(reviewerRoot, path) || !Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > maximumBytes) {
      fail("XHS_V3_OPERATOR_REVIEW_WORKSPACE_INVALID", "review export is outside its fixed bounds");
    }
    if (fsImpl.existsSync(path)) {
      const existing = readPlainBytes(path, {
        fsImpl, maximumBytes, code: "XHS_V3_OPERATOR_REVIEW_WORKSPACE_DRIFT",
      });
      if (!existing.equals(bytes)) {
        fail("XHS_V3_OPERATOR_REVIEW_WORKSPACE_DRIFT", "content-addressed review export drifted");
      }
      return;
    }
    fsImpl.writeFileSync(path, bytes, { flag: "wx", mode, flush: true });
  }

  function reviewAclPlan(paths) {
    return buildXhsV3BlindReviewAclPlan({
      reviewRoot: reviewerRoot,
      workspaceRoot: paths.workflowRoot,
      inboxRoot: paths.inboxRoot,
      privateRoot,
      providerRoot: privateProviderRoot,
      releaseRoot: deployedReleaseRoot,
      sourceRoot: fixedSourceRoot,
    });
  }

  function assertExactReviewTree(paths, manifest, responseHash = null, requireAdmission = false) {
    const exactNames = (path, expected) => {
      const actual = fsImpl.readdirSync(path).sort();
      if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
        fail("XHS_V3_OPERATOR_REVIEW_WORKSPACE_DRIFT", "blind-review workspace contains an unexpected entry");
      }
    };
    exactNames(paths.workflowRoot, [
      "blind-review-workspace.v1.json", "human-response.draft.v1.json", "inbox", "inputs",
      "review-session.v1.json", "templates",
    ]);
    exactNames(paths.inputsRoot, manifest.inputs.flatMap((row) => [row.frameName, row.dumpReviewName]));
    exactNames(paths.templatesRoot, [
      `${manifest.templateHash}.review-response-template.v1.json`, "xhs-v3-blind-review-submit.mjs",
    ]);
    const inbox = fsImpl.readdirSync(paths.inboxRoot).sort();
    if (responseHash === null) {
      if (inbox.length !== 0) fail("XHS_V3_OPERATOR_REVIEW_WORKSPACE_DRIFT", "blind-review inbox was not empty at publication");
      return;
    }
    const responseName = `${responseHash}.review-response.v1.json`;
    const receiptName = `${manifest.sessionId}.admission-receipt.v1.json`;
    const allowed = requireAdmission
      ? [[receiptName, responseName].sort()]
      : [[], [responseName], [receiptName, responseName].sort()];
    if (!allowed.some((names) => JSON.stringify(names) === JSON.stringify(inbox))) {
      fail("XHS_V3_OPERATOR_REVIEW_WORKSPACE_DRIFT", "blind-review inbox contains an unexpected entry");
    }
  }

  function assertExactReviewStagingTree(paths, manifest) {
    const rootNames = fsImpl.readdirSync(paths.workflowRoot).sort();
    const fullNames = [
      "blind-review-workspace.v1.json", "human-response.draft.v1.json", "inbox", "inputs",
      "review-session.v1.json", "templates",
    ].sort();
    if (JSON.stringify(rootNames) === JSON.stringify(fullNames)) {
      assertExactReviewTree(paths, manifest);
      return;
    }
    if (JSON.stringify(rootNames) !== JSON.stringify([
      "blind-review-workspace.v1.json", "inbox", "inputs", "templates",
    ].sort())
      || JSON.stringify(fsImpl.readdirSync(paths.inputsRoot).sort())
        !== JSON.stringify(manifest.inputs.flatMap((row) => [row.frameName, row.dumpReviewName]).sort())
      || JSON.stringify(fsImpl.readdirSync(paths.templatesRoot).sort())
        !== JSON.stringify([
          `${manifest.templateHash}.review-response-template.v1.json`, "xhs-v3-blind-review-submit.mjs",
        ].sort())
      || fsImpl.readdirSync(paths.inboxRoot).length !== 0) {
      fail("XHS_V3_OPERATOR_REVIEW_WORKSPACE_DRIFT", "blind-review staging tree contains an unexpected entry");
    }
  }

  function loadOrCreateReviewSession(loaded) {
    const validate = (value) => {
      if (!exact(value, [
        "schemaId", "schemaVersion", "corpusSetId", "reviewRequestHash", "sessionId", "challenge", "rows",
      ]) || value.schemaId !== XHS_V3_BLIND_REVIEW_SESSION_SCHEMA_ID || value.schemaVersion !== 1
        || value.corpusSetId !== loaded.request.corpusSetId || value.reviewRequestHash !== loaded.hash
        || !HASH.test(value.sessionId || "") || !HASH.test(value.challenge || "")
        || !Array.isArray(value.rows) || value.rows.length !== loaded.request.receipts.length) {
        fail("XHS_V3_OPERATOR_REVIEW_SESSION_INVALID", "blind-review session drifted");
      }
      for (let index = 0; index < value.rows.length; index += 1) {
        const row = value.rows[index];
        if (!exact(row, ["rowId", "captureReceiptHash"])
          || !SAFE_ID.test(row.rowId || "")
          || row.captureReceiptHash !== loaded.request.receipts[index].captureReceiptHash) {
          fail("XHS_V3_OPERATOR_REVIEW_SESSION_INVALID", "blind-review row binding drifted");
        }
      }
      return Object.freeze(value);
    };
    if (fsImpl.existsSync(loaded.paths.privateSessionPath)) {
      acl(loaded.paths.privateSessionPath, false, "verify");
      return validate(readJson(readPlainBytes(loaded.paths.privateSessionPath, {
        fsImpl, maximumBytes: 16 * 1024 * 1024, code: "XHS_V3_OPERATOR_REVIEW_SESSION_INVALID",
      }), "XHS_V3_OPERATOR_REVIEW_SESSION_INVALID"));
    }
    const challenge = Buffer.from(randomBytesFn(32)).toString("hex");
    if (!HASH.test(challenge)) fail("XHS_V3_OPERATOR_REVIEW_SESSION_INVALID", "session entropy source failed");
    const sessionId = sha256(Buffer.from(`xhs-v3-blind-review:${loaded.hash}:${challenge}`, "utf8"));
    const value = Object.freeze({
      schemaId: XHS_V3_BLIND_REVIEW_SESSION_SCHEMA_ID,
      schemaVersion: 1,
      corpusSetId: loaded.request.corpusSetId,
      reviewRequestHash: loaded.hash,
      sessionId,
      challenge,
      rows: Object.freeze(loaded.request.receipts.map((row) => Object.freeze({
        rowId: `row-${sha256(Buffer.from(`${challenge}:${row.captureReceiptHash}`, "utf8")).slice(0, 24)}`,
        captureReceiptHash: row.captureReceiptHash,
      }))),
    });
    fsImpl.writeFileSync(loaded.paths.privateSessionPath, Buffer.from(canonicalXhsV3FixedOperatorJson(value), "utf8"), {
      flag: "wx", mode: 0o600, flush: true,
    });
    acl(loaded.paths.privateSessionPath, false, "protect");
    acl(loaded.paths.privateSessionPath, false, "verify");
    return validate(value);
  }

  function validateReviewAclReceipt(receipt) {
    if (!receipt || receipt.ok !== undefined && receipt.ok !== true
      || receipt.schemaId !== XHS_V3_BLIND_REVIEW_ACL_RECEIPT_SCHEMA_ID
      || !["protect-and-verify", "verify"].includes(receipt.operation)
      || !HASH.test(String(receipt.reviewerPrincipalHash ?? ""))
      || !HASH.test(String(receipt.workspaceAclHash ?? ""))
      || !HASH.test(String(receipt.isolationAclHash ?? ""))
      || !HASH.test(String(receipt.networkPolicyHash ?? ""))
      || !Number.isSafeInteger(receipt.entryCount) || receipt.entryCount < 1
      || receipt.providerOutputAccess !== "DENIED_BY_ACL"
      || receipt.implementationAnswerAccess !== "DENIED_BY_ACL"
      || receipt.networkAccess !== "DENIED_BY_FIXED_OFFLINE_ACCOUNT"
      || !HASH.test(String(receipt.receiptHash ?? ""))) {
      fail("XHS_V3_OPERATOR_REVIEW_ACCESS_INVALID", "blind-review ACL receipt is malformed");
    }
    return receipt;
  }

  function verifyReviewAccess(paths) {
    // These exact TCB checks establish that provider output and deployed
    // implementation answers are not reachable by the non-admin reviewer.
    acl(privateRoot, true, "verify");
    acl(deployedReleaseRoot, true, "verify");
    return validateReviewAclReceipt(reviewAclController.verify(reviewAclPlan(paths)));
  }

  function blindReviewRuntimeReceipt() {
    const releaseKey = sha256(Buffer.from(canonicalXhsV3FixedOperatorJson({
      releaseId: binding.releaseId,
      sourceCommit: binding.sourceCommit,
      operatorSha256: binding.operatorSha256,
      providerBundleDigest,
    }), "utf8"));
    const receiptRoot = join(privateRoot, "blind-review-runtime-verification", releaseKey);
    const sessionPath = join(receiptRoot, "session.v1.json");
    const receiptPath = join(receiptRoot, "receipt.v1.json");

    const validateReceipt = (value) => {
      if (!exact(value, [
        "schemaId", "schemaVersion", "status", "releaseId", "sourceCommit", "operatorSha256",
        "providerBundleDigest", "sessionId", "reviewRequestHash", "accessAttestationHash",
        "responseHash", "callerPrincipalHash", "isolationProbeHash", "taskExecutionHash", "networkPolicyHash",
        "workspaceAclHash", "isolationAclHash", "sourceAclRestorationHash",
        "closedWorkspaceAclHash", "receiptHash",
      ]) || value.schemaId !== "xw.xhs.v3-blind-review-runtime-verification.v1"
        || value.schemaVersion !== 1 || value.status !== "PASS"
        || value.releaseId !== binding.releaseId || value.sourceCommit !== binding.sourceCommit
        || value.operatorSha256 !== binding.operatorSha256
        || value.providerBundleDigest !== providerBundleDigest
        || [
          value.sessionId, value.reviewRequestHash, value.accessAttestationHash, value.responseHash,
          value.callerPrincipalHash, value.isolationProbeHash, value.taskExecutionHash, value.networkPolicyHash,
          value.workspaceAclHash, value.isolationAclHash, value.sourceAclRestorationHash,
          value.closedWorkspaceAclHash, value.receiptHash,
        ].some((hash) => !HASH.test(hash || ""))) {
        fail("XHS_V3_OPERATOR_BLIND_REVIEW_RUNTIME_INVALID", "blind-review runtime receipt is malformed");
      }
      const { receiptHash, ...body } = value;
      if (sha256(Buffer.from(canonicalXhsV3FixedOperatorJson(body), "utf8")) !== receiptHash) {
        fail("XHS_V3_OPERATOR_BLIND_REVIEW_RUNTIME_INVALID", "blind-review runtime receipt hash drifted");
      }
      return Object.freeze(value);
    };

    createDirectory(receiptRoot);
    if (fsImpl.existsSync(receiptPath)) {
      const bytes = readPlainBytes(receiptPath, {
        fsImpl, maximumBytes: 256 * 1024, code: "XHS_V3_OPERATOR_BLIND_REVIEW_RUNTIME_INVALID",
      });
      const value = validateReceipt(readJson(bytes, "XHS_V3_OPERATOR_BLIND_REVIEW_RUNTIME_INVALID"));
      if (!bytes.equals(prettyBytes(value))) {
        fail("XHS_V3_OPERATOR_BLIND_REVIEW_RUNTIME_INVALID", "blind-review runtime receipt is noncanonical");
      }
      acl(receiptPath, false, "protect");
      acl(receiptPath, false, "verify");
      return value;
    }

    const expectedReviewRequestHash = sha256(Buffer.from(canonicalXhsV3FixedOperatorJson({
      schemaId: "xw.xhs.v3-blind-review-runtime-request.v1",
      releaseId: binding.releaseId,
      sourceCommit: binding.sourceCommit,
      operatorSha256: binding.operatorSha256,
      providerBundleDigest,
    }), "utf8"));
    let session;
    if (fsImpl.existsSync(sessionPath)) {
      const bytes = readPlainBytes(sessionPath, {
        fsImpl, maximumBytes: 64 * 1024, code: "XHS_V3_OPERATOR_BLIND_REVIEW_RUNTIME_INVALID",
      });
      session = readJson(bytes, "XHS_V3_OPERATOR_BLIND_REVIEW_RUNTIME_INVALID");
      if (!bytes.equals(prettyBytes(session))) {
        fail("XHS_V3_OPERATOR_BLIND_REVIEW_RUNTIME_INVALID", "blind-review runtime session is noncanonical");
      }
      acl(sessionPath, false, "protect");
      acl(sessionPath, false, "verify");
    } else {
      const challenge = Buffer.from(randomBytesFn(32)).toString("hex");
      if (!HASH.test(challenge)) fail("XHS_V3_OPERATOR_BLIND_REVIEW_RUNTIME_INVALID", "runtime verifier entropy failed");
      session = Object.freeze({
        schemaId: "xw.xhs.v3-blind-review-runtime-session.v1",
        schemaVersion: 1,
        sessionId: sha256(Buffer.from(`xw.xhs.v3-blind-review-runtime.v1\0${expectedReviewRequestHash}\0${challenge}`, "utf8")),
        challenge,
        reviewRequestHash: expectedReviewRequestHash,
      });
      fsImpl.writeFileSync(sessionPath, prettyBytes(session), { flag: "wx", mode: 0o600, flush: true });
      acl(sessionPath, false, "protect");
      acl(sessionPath, false, "verify");
    }
    if (!exact(session, ["schemaId", "schemaVersion", "sessionId", "challenge", "reviewRequestHash"])
      || session.schemaId !== "xw.xhs.v3-blind-review-runtime-session.v1" || session.schemaVersion !== 1
      || !HASH.test(session.sessionId || "") || !HASH.test(session.challenge || "")
      || session.reviewRequestHash !== expectedReviewRequestHash
      || session.sessionId !== sha256(Buffer.from(
        `xw.xhs.v3-blind-review-runtime.v1\0${expectedReviewRequestHash}\0${session.challenge}`, "utf8",
      ))) {
      fail("XHS_V3_OPERATOR_BLIND_REVIEW_RUNTIME_INVALID", "blind-review runtime session drifted");
    }

    const workflowRoot = join(reviewerRoot, "runtime-verification", releaseKey, session.sessionId);
    const inboxRoot = join(workflowRoot, "inbox");
    const templatesRoot = join(workflowRoot, "templates");
    for (const path of [workflowRoot, inboxRoot, templatesRoot]) createReviewerDirectory(path);
    const plan = buildXhsV3BlindReviewAclPlan({
      reviewRoot: reviewerRoot,
      workspaceRoot: workflowRoot,
      inboxRoot,
      privateRoot,
      providerRoot: privateProviderRoot,
      releaseRoot: deployedReleaseRoot,
      sourceRoot: fixedSourceRoot,
    });
    let closed = false;
    let primaryError = null;
    try {
      const staged = reviewAclController.close(plan);
      if (!HASH.test(staged?.restoredSourceAclHash || "") || !HASH.test(staged?.closedWorkspaceAclHash || "")) {
        fail("XHS_V3_OPERATOR_BLIND_REVIEW_RUNTIME_INVALID", "runtime staging closure receipt is malformed");
      }
      const preProtectRoot = fsImpl.readdirSync(workflowRoot).sort();
      const preProtectTemplates = fsImpl.readdirSync(templatesRoot).sort();
      const preProtectInbox = fsImpl.readdirSync(inboxRoot).sort();
      if (![JSON.stringify(["inbox", "templates"]), JSON.stringify([
        "human-response.draft.v1.json", "inbox", "templates",
      ])].includes(JSON.stringify(preProtectRoot))
        || ![JSON.stringify([]), JSON.stringify(["xhs-v3-blind-review-submit.mjs"])]
          .includes(JSON.stringify(preProtectTemplates))
        || preProtectInbox.length > 2
        || preProtectInbox.some((name) => name !== `${session.sessionId}.admission-receipt.v1.json`
          && !/^[0-9a-f]{64}\.review-response\.v1\.json$/u.test(name))) {
        fail("XHS_V3_OPERATOR_BLIND_REVIEW_RUNTIME_INVALID", "pre-Protect runtime tree contains an unexpected entry");
      }
      for (const name of preProtectInbox) fsImpl.unlinkSync(join(inboxRoot, name));
      const staleClientPath = join(templatesRoot, "xhs-v3-blind-review-submit.mjs");
      const staleDraftPath = join(workflowRoot, "human-response.draft.v1.json");
      if (fsImpl.existsSync(staleClientPath)) fsImpl.unlinkSync(staleClientPath);
      if (fsImpl.existsSync(staleDraftPath)) fsImpl.unlinkSync(staleDraftPath);
      if (JSON.stringify(fsImpl.readdirSync(workflowRoot).sort()) !== JSON.stringify(["inbox", "templates"])
        || fsImpl.readdirSync(inboxRoot).length !== 0 || fsImpl.readdirSync(templatesRoot).length !== 0) {
        fail("XHS_V3_OPERATOR_BLIND_REVIEW_RUNTIME_INVALID", "runtime staging tree was not empty before Protect");
      }
      const initialAcl = validateReviewAclReceipt(reviewAclController.protect(plan));
      const accessAttestationHash = sha256(Buffer.from(canonicalXhsV3FixedOperatorJson({
        schemaId: "xw.xhs.v3-blind-review-runtime-access.v1",
        releaseId: binding.releaseId,
        sourceCommit: binding.sourceCommit,
        operatorSha256: binding.operatorSha256,
        providerBundleDigest,
        reviewerPrincipalHash: initialAcl.reviewerPrincipalHash,
        workspaceAclHash: initialAcl.workspaceAclHash,
        isolationAclHash: initialAcl.isolationAclHash,
        networkPolicyHash: initialAcl.networkPolicyHash,
      }), "utf8"));
      const response = Object.freeze({
        schemaId: XHS_V3_BLIND_REVIEW_HUMAN_RESPONSE_SCHEMA_ID,
        schemaVersion: 1,
        corpusSetId: "runtime-verification",
        sessionId: session.sessionId,
        challenge: session.challenge,
        reviewRequestHash: session.reviewRequestHash,
        accessAttestationHash,
        annotations: Object.freeze([Object.freeze({})]),
      });
      const responseBytes = Buffer.from(canonicalXhsV3FixedOperatorJson(response), "utf8");
      const responseHash = sha256(responseBytes);
      const draftPath = join(workflowRoot, "human-response.draft.v1.json");
      const clientPath = join(templatesRoot, "xhs-v3-blind-review-submit.mjs");
      const clientBytes = readPlainBytes(BLIND_REVIEW_CLIENT_PATH, {
        fsImpl, maximumBytes: 2 * 1024 * 1024, code: "XHS_V3_OPERATOR_BLIND_REVIEW_RUNTIME_INVALID",
      });
      publishExact(draftPath, responseBytes, { mode: 0o600, maximumBytes: 16 * 1024 * 1024 });
      publishExact(clientPath, clientBytes, { mode: 0o400, maximumBytes: 2 * 1024 * 1024 });
      const finalName = `${responseHash}.review-response.v1.json`;
      const admissionName = `${session.sessionId}.admission-receipt.v1.json`;
      const runtimeRootNames = fsImpl.readdirSync(workflowRoot).sort();
      const runtimeTemplateNames = fsImpl.readdirSync(templatesRoot).sort();
      const runtimeInboxNames = fsImpl.readdirSync(inboxRoot).sort();
      if (JSON.stringify(runtimeRootNames) !== JSON.stringify([
        "human-response.draft.v1.json", "inbox", "templates",
      ]) || JSON.stringify(runtimeTemplateNames) !== JSON.stringify(["xhs-v3-blind-review-submit.mjs"])
        || ![[], [finalName], [admissionName, finalName].sort()].some(
          (names) => JSON.stringify(names) === JSON.stringify(runtimeInboxNames),
        )) {
        fail("XHS_V3_OPERATOR_BLIND_REVIEW_RUNTIME_INVALID", "runtime verification workspace has an unexpected entry");
      }
      const activeAcl = validateReviewAclReceipt(reviewAclController.protect(plan));
      validateReviewAclReceipt(reviewAclController.verify(plan));
      const admissionBinding = {
        sessionId: session.sessionId,
        challenge: session.challenge,
        reviewRequestHash: session.reviewRequestHash,
        accessAttestationHash,
        responseHash,
      };
      const admitted = reviewAclController.admitResponse(plan, admissionBinding);
      const admissionPath = join(inboxRoot, `${session.sessionId}.admission-receipt.v1.json`);
      fsImpl.unlinkSync(admissionPath);
      const adopted = reviewAclController.admitResponse(plan, admissionBinding);
      const replayed = reviewAclController.admitResponse(plan, admissionBinding);
      for (const value of [admitted, adopted, replayed]) {
        if (value?.responseHash !== responseHash || !HASH.test(value.callerPrincipalHash || "")
          || !HASH.test(value.isolationProbeHash || "") || !HASH.test(value.taskExecutionHash || "")) {
          fail("XHS_V3_OPERATOR_BLIND_REVIEW_RUNTIME_INVALID", "S4U broker admission evidence drifted");
        }
      }
      if (canonicalXhsV3FixedOperatorJson(admitted) !== canonicalXhsV3FixedOperatorJson(adopted)
        || canonicalXhsV3FixedOperatorJson(admitted) !== canonicalXhsV3FixedOperatorJson(replayed)) {
        fail("XHS_V3_OPERATOR_BLIND_REVIEW_RUNTIME_INVALID", "broker adoption/replay receipt drifted");
      }
      if (JSON.stringify(fsImpl.readdirSync(inboxRoot).sort())
        !== JSON.stringify([admissionName, finalName].sort())) {
        fail("XHS_V3_OPERATOR_BLIND_REVIEW_RUNTIME_INVALID", "runtime verification inbox drifted");
      }
      const closure = reviewAclController.close(plan);
      closed = true;
      const body = Object.freeze({
        schemaId: "xw.xhs.v3-blind-review-runtime-verification.v1",
        schemaVersion: 1,
        status: "PASS",
        releaseId: binding.releaseId,
        sourceCommit: binding.sourceCommit,
        operatorSha256: binding.operatorSha256,
        providerBundleDigest,
        sessionId: session.sessionId,
        reviewRequestHash: session.reviewRequestHash,
        accessAttestationHash,
        responseHash,
        callerPrincipalHash: admitted.callerPrincipalHash,
        isolationProbeHash: admitted.isolationProbeHash,
        taskExecutionHash: admitted.taskExecutionHash,
        networkPolicyHash: activeAcl.networkPolicyHash,
        workspaceAclHash: activeAcl.workspaceAclHash,
        isolationAclHash: activeAcl.isolationAclHash,
        sourceAclRestorationHash: closure.restoredSourceAclHash,
        closedWorkspaceAclHash: closure.closedWorkspaceAclHash,
      });
      const value = validateReceipt(Object.freeze({
        ...body,
        receiptHash: sha256(Buffer.from(canonicalXhsV3FixedOperatorJson(body), "utf8")),
      }));
      fsImpl.writeFileSync(receiptPath, prettyBytes(value), { flag: "wx", mode: 0o600, flush: true });
      acl(receiptPath, false, "protect");
      acl(receiptPath, false, "verify");
      return value;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (!closed) {
        try { reviewAclController.close(plan); } catch (cleanupError) {
          if (primaryError === null) throw cleanupError;
        }
      }
    }
  }

  function loadReviewRequest(corpusSetId, expectedHash = null) {
    const paths = reviewPaths(corpusSetId);
    acl(paths.setRoot, true, "verify");
    const bytes = readPlainBytes(paths.requestPath, {
      fsImpl, maximumBytes: 16 * 1024 * 1024, code: "XHS_V3_OPERATOR_REVIEW_REQUEST_INVALID",
    });
    const hash = sha256(bytes);
    if (expectedHash !== null && hash !== expectedHash) {
      fail("XHS_V3_OPERATOR_REVIEW_REQUEST_DRIFT", "review request hash changed");
    }
    const request = validateReviewRequest(readJson(bytes, "XHS_V3_OPERATOR_REVIEW_REQUEST_INVALID"), {
      corpusSetId, binding,
    });
    return Object.freeze({ paths, bytes, hash, request });
  }

  function prepareReviewWorkflow(corpusSetId, expectedHash) {
    const loaded = loadReviewRequest(corpusSetId, expectedHash);
    const session = loadOrCreateReviewSession(loaded);
    createReviewerDirectory(loaded.paths.workflowRoot);
    createReviewerDirectory(loaded.paths.inputsRoot);
    createReviewerDirectory(loaded.paths.templatesRoot);
    createReviewerDirectory(loaded.paths.inboxRoot);
    // Seal the empty directory chain before any review-visible bytes exist.
    // Subsequent files inherit this protected DACL; the second protect pass
    // grants WriteData only to the already-created fixed draft.
    const plan = reviewAclPlan(loaded.paths);
    let prepared = false;
    let primaryError = null;
    try {
      const stagingClosure = reviewAclController.close(plan);
      if (!HASH.test(stagingClosure?.restoredSourceAclHash || "")
        || !HASH.test(stagingClosure?.closedWorkspaceAclHash || "")) {
        fail("XHS_V3_OPERATOR_REVIEW_ACCESS_INVALID", "blind-review staging closure receipt is malformed");
      }
    const template = Object.freeze({
      schemaId: XHS_V3_BLIND_REVIEW_HUMAN_RESPONSE_SCHEMA_ID,
      schemaVersion: 1,
      corpusSetId,
      sessionId: session.sessionId,
      challenge: session.challenge,
      reviewRequestHash: loaded.hash,
      accessAttestationHash: null,
      annotations: Object.freeze(session.rows.map((mapping) => Object.freeze({
        rowId: mapping.rowId,
        expectedOutcome: null,
        positiveRegions: Object.freeze([]),
        protectedRegions: Object.freeze([]),
      }))),
    });
    const bytes = prettyBytes(template);
    const templateHash = sha256(bytes);
    const path = join(loaded.paths.templatesRoot, `${templateHash}.review-response-template.v1.json`);
    publishExact(path, bytes, { maximumBytes: 16 * 1024 * 1024 });
    const reviewClientBytes = readPlainBytes(join(
      dirname(fileURLToPath(import.meta.url)), "xhs-v3-blind-review-submit.mjs",
    ), {
      maximumBytes: 1024 * 1024, code: "XHS_V3_OPERATOR_REVIEW_CLIENT_INVALID",
    });
    const reviewClientHash = sha256(reviewClientBytes);
    publishExact(join(loaded.paths.templatesRoot, "xhs-v3-blind-review-submit.mjs"), reviewClientBytes, {
      maximumBytes: 1024 * 1024,
    });

    const inputs = loaded.request.receipts.map((row, index) => {
      const rowId = session.rows[index].rowId;
      const captureDirectory = join(captureRoot, row.captureReceiptHash);
      acl(captureDirectory, true, "verify");
      const frameBytes = readPlainBytes(join(captureDirectory, "frame.png"), {
        fsImpl, maximumBytes: 32 * 1024 * 1024, code: "XHS_V3_OPERATOR_REVIEW_INPUT_INVALID",
      });
      if (sha256(frameBytes) !== row.pngHash) {
        fail("XHS_V3_OPERATOR_REVIEW_INPUT_INVALID", "review frame differs from the signed request hash");
      }
      const frameName = `${rowId}.frame.png`;
      publishExact(join(loaded.paths.inputsRoot, frameName), frameBytes, {
        maximumBytes: 32 * 1024 * 1024,
      });
      const dumpReview = Object.freeze({
        schemaId: "xw.xhs.v3-blind-dump-review-input.v1",
        schemaVersion: 1,
        rowId,
        pageClass: row.pageClass,
        evaluationRole: row.evaluationRole,
        dumpVerdict: row.dumpVerdict,
        pngHash: row.pngHash,
      });
      const dumpBytes = prettyBytes(dumpReview);
      const dumpReviewHash = sha256(dumpBytes);
      const dumpReviewName = `${rowId}.dump-review.v1.json`;
      publishExact(join(loaded.paths.inputsRoot, dumpReviewName), dumpBytes, {
        maximumBytes: 1024 * 1024,
      });
      return Object.freeze({
        rowId,
        frameName,
        frameHash: row.pngHash,
        dumpReviewName,
        dumpReviewHash,
      });
    }
    );
    const workspaceManifest = Object.freeze({
      schemaId: "xw.xhs.v3-blind-review-workspace.v1",
      schemaVersion: 1,
      corpusSetId,
      sessionId: session.sessionId,
      challenge: session.challenge,
      reviewRequestHash: loaded.hash,
      templateHash,
      reviewClientHash,
      inputs: Object.freeze(inputs),
    });
    const workspaceManifestBytes = prettyBytes(workspaceManifest);
    const workspaceManifestHash = sha256(workspaceManifestBytes);
    publishExact(loaded.paths.workspaceManifestPath, workspaceManifestBytes, {
      maximumBytes: 16 * 1024 * 1024,
    });

    assertExactReviewStagingTree(loaded.paths, workspaceManifest);
    validateReviewAclReceipt(reviewAclController.protect(plan));
    const access = verifyReviewAccess(loaded.paths);
    const attestation = Object.freeze({
      schemaId: XHS_V3_BLIND_REVIEW_ACCESS_ATTESTATION_SCHEMA_ID,
      schemaVersion: 1,
      releaseId: binding.releaseId,
      sourceCommit: binding.sourceCommit,
      operatorSha256: binding.operatorSha256,
      corpusSetId,
      reviewRequestHash: loaded.hash,
      workspaceManifestHash,
      templateHash,
      reviewerPrincipalHash: access.reviewerPrincipalHash,
      workspaceAclHash: access.workspaceAclHash,
      isolationAclHash: access.isolationAclHash,
      networkPolicyHash: access.networkPolicyHash,
      providerOutputAccess: "DENIED_BY_ACL",
      implementationAnswerAccess: "DENIED_BY_ACL",
      reviewerNetworkAccess: "DENIED_BY_FIXED_OFFLINE_ACCOUNT",
      sessionBindingHash: sha256(Buffer.from(canonicalXhsV3FixedOperatorJson(session), "utf8")),
    });
    const attestationBytes = Buffer.from(canonicalXhsV3FixedOperatorJson(attestation), "utf8");
    const accessAttestationHash = sha256(attestationBytes);
    if (fsImpl.existsSync(loaded.paths.accessAttestationPath)) {
      acl(loaded.paths.accessAttestationPath, false, "verify");
      const existing = readPlainBytes(loaded.paths.accessAttestationPath, {
        fsImpl, maximumBytes: 1024 * 1024, code: "XHS_V3_OPERATOR_REVIEW_ACCESS_DRIFT",
      });
      if (!existing.equals(attestationBytes)) {
        fail("XHS_V3_OPERATOR_REVIEW_ACCESS_DRIFT", "blind-review access attestation drifted");
      }
    } else {
      fsImpl.writeFileSync(loaded.paths.accessAttestationPath, attestationBytes, {
        flag: "wx", mode: 0o600, flush: true,
      });
      acl(loaded.paths.accessAttestationPath, false, "protect");
      acl(loaded.paths.accessAttestationPath, false, "verify");
    }
    const publicSession = Object.freeze({
      schemaId: XHS_V3_BLIND_REVIEW_SESSION_SCHEMA_ID,
      schemaVersion: 1,
      corpusSetId,
      sessionId: session.sessionId,
      challenge: session.challenge,
      reviewRequestHash: loaded.hash,
      accessAttestationHash,
      responsePipeName: `xw-xhs-v3-review-${session.sessionId}`,
    });
    publishExact(loaded.paths.workspaceSessionPath, prettyBytes(publicSession), { maximumBytes: 1024 * 1024 });
    publishExact(loaded.paths.responseDraftPath, prettyBytes(Object.freeze({
      ...template,
      accessAttestationHash,
    })), { maximumBytes: 16 * 1024 * 1024 });
    assertExactReviewTree(loaded.paths, workspaceManifest);
    validateReviewAclReceipt(reviewAclController.protect(plan));
    const finalAccess = verifyReviewAccess(loaded.paths);
    if (finalAccess.reviewerPrincipalHash !== access.reviewerPrincipalHash
      || finalAccess.workspaceAclHash !== access.workspaceAclHash
      || finalAccess.isolationAclHash !== access.isolationAclHash
      || finalAccess.networkPolicyHash !== access.networkPolicyHash) {
      fail("XHS_V3_OPERATOR_REVIEW_ACCESS_DRIFT", "blind-review ACL changed while publishing its session");
    }
      prepared = true;
      return Object.freeze({
      status: "AWAITING_BLIND_HUMAN_RESPONSE",
      reviewRequestHash: loaded.hash,
      templateHash,
      workspaceManifestHash,
      accessAttestationHash,
      sessionId: session.sessionId,
      challenge: session.challenge,
      receiptCount: loaded.request.receipts.length,
      });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (!prepared) {
        try { reviewAclController.close(plan); } catch (cleanupError) {
          if (primaryError === null) throw cleanupError;
        }
      }
    }
  }

  function loadHumanResponse(corpusSetId, responseHash, expectedReviewHash) {
    const loaded = loadReviewRequest(corpusSetId, expectedReviewHash);
    // A prior failed submit restores the source ACL. Reacquire the same
    // create-only lease before revalidating or launching the reviewer task.
    validateReviewAclReceipt(reviewAclController.protect(reviewAclPlan(loaded.paths)));
    const attestationBytes = readPlainBytes(loaded.paths.accessAttestationPath, {
      fsImpl, maximumBytes: 1024 * 1024, code: "XHS_V3_OPERATOR_REVIEW_ACCESS_INVALID",
    });
    const attestation = readJson(attestationBytes, "XHS_V3_OPERATOR_REVIEW_ACCESS_INVALID");
    if (!exact(attestation, [
      "schemaId", "schemaVersion", "releaseId", "sourceCommit", "operatorSha256",
      "corpusSetId", "reviewRequestHash", "workspaceManifestHash", "templateHash",
      "reviewerPrincipalHash", "workspaceAclHash", "isolationAclHash",
      "networkPolicyHash", "providerOutputAccess", "implementationAnswerAccess", "reviewerNetworkAccess",
      "sessionBindingHash",
    ])
      || attestation.schemaId !== XHS_V3_BLIND_REVIEW_ACCESS_ATTESTATION_SCHEMA_ID
      || attestation.schemaVersion !== 1 || attestation.releaseId !== binding.releaseId
      || attestation.sourceCommit !== binding.sourceCommit
      || attestation.operatorSha256 !== binding.operatorSha256
      || attestation.corpusSetId !== corpusSetId || attestation.reviewRequestHash !== loaded.hash
      || !HASH.test(attestation.workspaceManifestHash || "")
      || !HASH.test(attestation.templateHash || "")
      || !HASH.test(attestation.sessionBindingHash || "")
      || attestation.providerOutputAccess !== "DENIED_BY_ACL"
      || attestation.implementationAnswerAccess !== "DENIED_BY_ACL"
      || attestation.reviewerNetworkAccess !== "DENIED_BY_FIXED_OFFLINE_ACCOUNT"
      || attestationBytes.toString("utf8") !== canonicalXhsV3FixedOperatorJson(attestation)) {
      fail("XHS_V3_OPERATOR_REVIEW_ACCESS_INVALID", "blind-review access attestation is invalid");
    }
    const workspaceManifestBytes = readPlainBytes(loaded.paths.workspaceManifestPath, {
      fsImpl, maximumBytes: 16 * 1024 * 1024, code: "XHS_V3_OPERATOR_REVIEW_WORKSPACE_DRIFT",
    });
    const workspaceManifest = readJson(workspaceManifestBytes, "XHS_V3_OPERATOR_REVIEW_WORKSPACE_DRIFT");
    const session = loadOrCreateReviewSession(loaded);
    if (sha256(workspaceManifestBytes) !== attestation.workspaceManifestHash
      || !exact(workspaceManifest, [
        "schemaId", "schemaVersion", "corpusSetId", "sessionId", "challenge", "reviewRequestHash",
        "templateHash", "reviewClientHash", "inputs",
      ]) || workspaceManifest.schemaId !== "xw.xhs.v3-blind-review-workspace.v1"
      || workspaceManifest.schemaVersion !== 1 || workspaceManifest.corpusSetId !== corpusSetId
      || workspaceManifest.sessionId !== session.sessionId || workspaceManifest.challenge !== session.challenge
      || workspaceManifest.reviewRequestHash !== loaded.hash || workspaceManifest.templateHash !== attestation.templateHash
      || sha256(Buffer.from(canonicalXhsV3FixedOperatorJson(session), "utf8")) !== attestation.sessionBindingHash
      || !Array.isArray(workspaceManifest.inputs) || workspaceManifest.inputs.length !== session.rows.length) {
      fail("XHS_V3_OPERATOR_REVIEW_WORKSPACE_DRIFT", "blind-review workspace inputs drifted");
    }
    const clientBytes = readPlainBytes(join(loaded.paths.templatesRoot, "xhs-v3-blind-review-submit.mjs"), {
      fsImpl, maximumBytes: 1024 * 1024, code: "XHS_V3_OPERATOR_REVIEW_WORKSPACE_DRIFT",
    });
    if (sha256(clientBytes) !== workspaceManifest.reviewClientHash) {
      fail("XHS_V3_OPERATOR_REVIEW_WORKSPACE_DRIFT", "blind-review client drifted");
    }
    for (let index = 0; index < workspaceManifest.inputs.length; index += 1) {
      const input = workspaceManifest.inputs[index];
      if (!exact(input, ["rowId", "frameName", "frameHash", "dumpReviewName", "dumpReviewHash"])
        || input.rowId !== session.rows[index].rowId
        || input.frameName !== `${input.rowId}.frame.png`
        || input.dumpReviewName !== `${input.rowId}.dump-review.v1.json`
        || !HASH.test(input.frameHash || "") || !HASH.test(input.dumpReviewHash || "")) {
        fail("XHS_V3_OPERATOR_REVIEW_WORKSPACE_DRIFT", "blind-review input manifest drifted");
      }
      const frameBytes = readPlainBytes(join(loaded.paths.inputsRoot, input.frameName), {
        fsImpl, maximumBytes: 32 * 1024 * 1024, code: "XHS_V3_OPERATOR_REVIEW_WORKSPACE_DRIFT",
      });
      const dumpBytes = readPlainBytes(join(loaded.paths.inputsRoot, input.dumpReviewName), {
        fsImpl, maximumBytes: 1024 * 1024, code: "XHS_V3_OPERATOR_REVIEW_WORKSPACE_DRIFT",
      });
      if (sha256(frameBytes) !== input.frameHash || sha256(dumpBytes) !== input.dumpReviewHash) {
        fail("XHS_V3_OPERATOR_REVIEW_WORKSPACE_DRIFT", "blind-review exported bytes drifted");
      }
    }
    assertExactReviewTree(loaded.paths, workspaceManifest, responseHash);
    const access = verifyReviewAccess(loaded.paths);
    if (access.reviewerPrincipalHash !== attestation.reviewerPrincipalHash
      || access.workspaceAclHash !== attestation.workspaceAclHash
      || access.isolationAclHash !== attestation.isolationAclHash
      || access.networkPolicyHash !== attestation.networkPolicyHash) {
      fail("XHS_V3_OPERATOR_REVIEW_ACCESS_DRIFT", "blind-review ACL isolation changed before sealing");
    }
    const admission = reviewAclController.admitResponse(reviewAclPlan(loaded.paths), {
      sessionId: session.sessionId,
      challenge: session.challenge,
      reviewRequestHash: loaded.hash,
      accessAttestationHash: sha256(attestationBytes),
      responseHash,
    });
    if (admission?.callerPrincipalHash !== attestation.reviewerPrincipalHash
      || !HASH.test(admission?.isolationProbeHash || "")
      || !HASH.test(admission?.taskExecutionHash || "")) {
      fail("XHS_V3_OPERATOR_REVIEW_IDENTITY_INVALID", "response was not admitted from the fixed reviewer principal");
    }
    assertExactReviewTree(loaded.paths, workspaceManifest, responseHash, true);
    const path = join(loaded.paths.inboxRoot, `${responseHash}.review-response.v1.json`);
    const responseBytes = readPlainBytes(path, {
      fsImpl, maximumBytes: 16 * 1024 * 1024, code: "XHS_V3_OPERATOR_REVIEW_RESPONSE_INVALID",
    });
    const response = readJson(responseBytes, "XHS_V3_OPERATOR_REVIEW_RESPONSE_INVALID");
    validateXhsV3BlindReviewHumanResponse(response, {
      request: loaded.request,
      session,
      accessAttestationHash: sha256(attestationBytes),
      responseHash,
      rawBytes: { request: loaded.bytes, response: responseBytes },
    });
    return Object.freeze({ loaded, session, response, attestation, admission, accessAttestationHash: sha256(attestationBytes) });
  }

  function adoptPreparedInvocation(phase, invocationId, expectedECorpusArtifactHash = null) {
    const path = join(privateRoot, "invocations", `${invocationId}.v1.json`);
    if (!fsImpl.existsSync(path)) return null;
    acl(path, false, "verify");
    const bytes = readPlainBytes(path, {
      fsImpl, maximumBytes: 4 * 1024 * 1024, code: "XHS_V3_OPERATOR_PREPARE_RECEIPT_INVALID",
    });
    const value = readJson(bytes, "XHS_V3_OPERATOR_PREPARE_RECEIPT_INVALID");
    if (bytes.toString("utf8") !== canonicalXhsV3FixedOperatorJson(value)
      || !exact(value, ["schemaId", "plan", "privatePayload"])
      || value.schemaId !== "xw.xhs.v3-task-invocation.v1"
      || value.plan?.mission?.vision?.rolloutPhase !== phase) {
      fail("XHS_V3_OPERATOR_PREPARE_RECEIPT_INVALID", "persisted task invocation cannot be adopted");
    }
    const artifactHash = value.plan?.mission?.vision?.eCorpusPassRef?.artifactHash ?? null;
    if ((phase === "R3" && artifactHash !== expectedECorpusArtifactHash)
      || (phase !== "R3" && artifactHash !== null)) {
      fail("XHS_V3_OPERATOR_PREPARE_RECEIPT_INVALID", "persisted task invocation E binding drifted");
    }
    return Object.freeze({
      ok: true,
      phase,
      invocationId,
      invocationHash: sha256(bytes),
    });
  }

  function adoptRunRecord(phase, invocationId, expectedInvocationHash, expectedECorpusArtifactHash = null) {
    const path = join(privateRoot, "runs", `${invocationId}.v1.json`);
    if (!fsImpl.existsSync(path)) return null;
    acl(path, false, "verify");
    const bytes = readPlainBytes(path, {
      fsImpl, maximumBytes: 32 * 1024 * 1024, code: "XHS_V3_OPERATOR_RUN_RECEIPT_INVALID",
    });
    const value = readJson(bytes, "XHS_V3_OPERATOR_RUN_RECEIPT_INVALID");
    if (bytes.toString("utf8") !== canonicalXhsV3FixedOperatorJson(value)
      || !exact(value, [
        "schemaId", "schemaVersion", "phase", "invocationId", "invocationHash",
        "planHash", "missionHash", "eCorpusPassRef", "taskBinding", "runtimeBinding", "result",
      ])
      || value.schemaId !== "xw.xhs.v3-task-run-record.v1" || value.schemaVersion !== 1
      || value.phase !== phase || value.invocationId !== invocationId
      || value.invocationHash !== expectedInvocationHash
      || !HASH.test(String(value.planHash ?? "")) || !HASH.test(String(value.missionHash ?? ""))
      || !exact(value.taskBinding, ["taskName", "taskBindingHash", "launcherHash", "callerPathHash"])
      || value.taskBinding.taskName !== "XW Platform Control Plane"
      || ["taskBindingHash", "launcherHash", "callerPathHash"]
        .some((key) => !HASH.test(String(value.taskBinding[key] ?? "")))
      || !exact(value.runtimeBinding, [
        "releaseId", "sourceCommit", "providerBundleDigest", "digestKeyId", "accountFingerprint",
      ])
      || value.runtimeBinding.releaseId !== binding.releaseId
      || value.runtimeBinding.sourceCommit !== binding.sourceCommit
      || !HASH.test(String(value.runtimeBinding.providerBundleDigest ?? ""))
      || !SAFE_ID.test(String(value.runtimeBinding.digestKeyId ?? ""))
      || !HASH.test(String(value.runtimeBinding.accountFingerprint ?? ""))
      || !value.result || typeof value.result !== "object" || Array.isArray(value.result)) {
      fail("XHS_V3_OPERATOR_RUN_RECEIPT_INVALID", "persisted task run record cannot be adopted");
    }
    const artifactHash = value.eCorpusPassRef?.artifactHash ?? null;
    if ((phase === "R3" && artifactHash !== expectedECorpusArtifactHash)
      || (phase !== "R3" && artifactHash !== null)) {
      fail("XHS_V3_OPERATOR_RUN_RECEIPT_INVALID", "persisted task run record E binding drifted");
    }
    return safeRunProjection(value.result, phase);
  }

  function adoptSubmittedReview(corpusSetId, humanResponse, accessAttestationHash) {
    const path = join(corpusRoot, corpusSetId, "review-response.v1.json");
    if (!fsImpl.existsSync(path)) return null;
    acl(path, false, "verify");
    const bytes = readPlainBytes(path, {
      fsImpl, maximumBytes: 16 * 1024 * 1024, code: "XHS_V3_OPERATOR_REVIEW_SUBMIT_RECEIPT_INVALID",
    });
    const value = readJson(bytes, "XHS_V3_OPERATOR_REVIEW_SUBMIT_RECEIPT_INVALID");
    if (bytes.toString("utf8") !== canonicalXhsV3FixedOperatorJson(value)
      || !exact(value, [
        "schemaId", "schemaVersion", "corpusSetId", "reviewRequestHash", "reviewerId",
        "providerImplementerId", "annotationsSealedAt", "providerOutputDisclosedAt",
        "accessAttestationHash", "annotations",
      ])
      || value.schemaId !== "xw.xhs.v3-corpus-review-response.v1" || value.schemaVersion !== 1
      || value.corpusSetId !== corpusSetId || value.reviewRequestHash !== humanResponse.reviewRequestHash
      || value.reviewerId !== humanResponse.reviewerId
      || value.providerImplementerId !== XHS_V3_PROVIDER_IMPLEMENTER_ID
      || value.providerOutputDisclosedAt !== null
      || value.accessAttestationHash !== accessAttestationHash
      || !Number.isFinite(Date.parse(String(value.annotationsSealedAt ?? "")))
      || canonicalXhsV3FixedOperatorJson(value.annotations)
        !== canonicalXhsV3FixedOperatorJson(humanResponse.annotations)) {
      fail("XHS_V3_OPERATOR_REVIEW_SUBMIT_RECEIPT_INVALID", "persisted blind response cannot be adopted");
    }
    return Object.freeze({
      corpusSetId,
      status: "REVIEW_RESPONSE_SEALED",
      reviewResponseHash: sha256(bytes),
      annotationCount: value.annotations.length,
    });
  }

  function adoptSealedCorpus(corpusSetId) {
    const path = join(corpusRoot, corpusSetId, "sealed-corpus.v1.json");
    if (!fsImpl.existsSync(path)) return null;
    acl(path, false, "verify");
    const bytes = readPlainBytes(path, {
      fsImpl, maximumBytes: 64 * 1024 * 1024, code: "XHS_V3_OPERATOR_CORPUS_RECEIPT_INVALID",
    });
    const value = readJson(bytes, "XHS_V3_OPERATOR_CORPUS_RECEIPT_INVALID");
    const rows = value?.publicManifest?.rows;
    if (bytes.toString("utf8") !== canonicalXhsV3FixedOperatorJson(value)
      || value?.schemaId !== "xw.xhs.exploration-corpus-sealed-bundle.v1"
      || !Array.isArray(rows) || rows.length === 0) {
      fail("XHS_V3_OPERATOR_CORPUS_RECEIPT_INVALID", "persisted sealed corpus cannot be adopted");
    }
    const countingRows = rows.filter((row) => row?.provenance?.countingEligible === true).length;
    if (countingRows < 1) fail("XHS_V3_OPERATOR_CORPUS_RECEIPT_INVALID", "persisted corpus has no counting rows");
    return Object.freeze({
      corpusSetId,
      status: "AWAITING_TASK_EVALUATOR_OUTCOME",
      sealedCorpusHash: sha256(bytes),
      countingRows,
    });
  }

  function adoptEvaluatorOutcome(corpusSetId) {
    const path = join(corpusRoot, corpusSetId, "production-evaluator-outcome.v1.json");
    if (!fsImpl.existsSync(path)) return null;
    acl(path, false, "verify");
    const bytes = readPlainBytes(path, {
      fsImpl, maximumBytes: 16 * 1024 * 1024, code: "XHS_V3_OPERATOR_EVALUATOR_RECEIPT_INVALID",
    });
    const value = readJson(bytes, "XHS_V3_OPERATOR_EVALUATOR_RECEIPT_INVALID");
    if (bytes.toString("utf8") !== canonicalXhsV3FixedOperatorJson(value)
      || !exact(value, [
        "schemaId", "schemaVersion", "corpusSetId", "runtime", "corpus",
        "providerOracleCases", "adverseMutationCases", "safety",
      ])
      || value.schemaId !== "xw.xhs.v3-task-evaluator-outcome.v1" || value.schemaVersion !== 1
      || value.corpusSetId !== corpusSetId || value.runtime?.releaseId !== binding.releaseId
      || value.runtime?.sourceCommit !== binding.sourceCommit
      || !Array.isArray(value.providerOracleCases) || value.providerOracleCases.length < 1
      || !Array.isArray(value.adverseMutationCases) || value.adverseMutationCases.length < 1
      || [...value.providerOracleCases, ...value.adverseMutationCases]
        .some((row) => row?.passed !== true)
      || !exact(value.safety, [
        "socialTransport", "effectTransport", "visualIssued", "visualConsumed", "visualPhysical",
      ]) || Object.values(value.safety).some((count) => count !== 0)) {
      fail("XHS_V3_OPERATOR_EVALUATOR_RECEIPT_INVALID", "persisted evaluator outcome cannot be adopted");
    }
    return Object.freeze({
      corpusSetId,
      status: "PASS",
      evaluatorOutcomeHash: sha256(bytes),
      providerOracleCaseCount: value.providerOracleCases.length,
      adverseMutationCaseCount: value.adverseMutationCases.length,
    });
  }

  function adoptSealedECorpus(corpusSetId) {
    const locatorPath = join(corpusRoot, corpusSetId, "e-corpus-seal-locator.v1.json");
    if (!fsImpl.existsSync(locatorPath)) return null;
    acl(locatorPath, false, "verify");
    const locatorBytes = readPlainBytes(locatorPath, {
      fsImpl, maximumBytes: 4 * 1024 * 1024, code: "XHS_V3_OPERATOR_E_CORPUS_RECEIPT_INVALID",
    });
    const locator = readJson(locatorBytes, "XHS_V3_OPERATOR_E_CORPUS_RECEIPT_INVALID");
    if (locatorBytes.toString("utf8") !== canonicalXhsV3FixedOperatorJson(locator)
      || !exact(locator, [
        "schemaId", "schemaVersion", "locatorHash", "corpusSetId", "expiryPolicy",
        "runtime", "taskOwner", "gateEpoch", "ref", "binding", "testReportHash",
      ])
      || locator.schemaId !== "xw.xhs.e-corpus-seal-locator.v1" || locator.schemaVersion !== 1
      || locator.corpusSetId !== corpusSetId || locator.expiryPolicy !== "GATE_F_SHORT"
      || locator.runtime?.releaseId !== binding.releaseId
      || locator.runtime?.sourceCommit !== binding.sourceCommit
      || !HASH.test(String(locator.ref?.artifactHash ?? ""))
      || !HASH.test(String(locator.testReportHash ?? ""))
      || locator.binding?.testReportHash !== locator.testReportHash
      || locator.binding?.releaseId !== binding.releaseId
      || locator.binding?.sourceCommit !== binding.sourceCommit
      || locator.ref?.gateEpoch !== locator.gateEpoch
      || locator.binding?.gateEpoch !== locator.gateEpoch
      || !HASH.test(String(locator.locatorHash ?? ""))) {
      fail("XHS_V3_OPERATOR_E_CORPUS_RECEIPT_INVALID", "persisted E locator cannot be adopted");
    }
    const { locatorHash, ...locatorBody } = locator;
    if (eventHash(locatorBody) !== locatorHash) {
      fail("XHS_V3_OPERATOR_E_CORPUS_RECEIPT_INVALID", "persisted E locator hash drifted");
    }
    const artifactPath = join(
      eCorpusArtifactRoot,
      locator.ref.artifactHash,
      "xw.xhs.e-corpus-pass.v1.json",
    );
    if (!within(eCorpusArtifactRoot, artifactPath)) {
      fail("XHS_V3_OPERATOR_E_CORPUS_RECEIPT_INVALID", "persisted E artifact escaped its fixed root");
    }
    acl(join(eCorpusArtifactRoot, locator.ref.artifactHash), true, "verify");
    const artifactBytes = readPlainBytes(artifactPath, {
      fsImpl, maximumBytes: 32 * 1024 * 1024, code: "XHS_V3_OPERATOR_E_CORPUS_RECEIPT_INVALID",
    });
    const artifact = readJson(artifactBytes, "XHS_V3_OPERATOR_E_CORPUS_RECEIPT_INVALID");
    if (artifactBytes.toString("utf8") !== canonicalXhsV3FixedOperatorJson(artifact)
      || !exact(artifact, [
        "schemaId", "schemaVersion", "status", "issuedAtMs", "expiresAtMs",
        "owner", "binding", "artifactHash", "seal",
      ])
      || artifact.schemaId !== "xw.xhs.e-corpus-pass.v1" || artifact.schemaVersion !== 1
      || artifact.status !== "PASS" || artifact.artifactHash !== locator.ref.artifactHash
      || canonicalXhsV3FixedOperatorJson(artifact.binding)
        !== canonicalXhsV3FixedOperatorJson(locator.binding)
      || !Number.isSafeInteger(artifact.issuedAtMs) || !Number.isSafeInteger(artifact.expiresAtMs)
      || artifact.issuedAtMs > Number(now()) || artifact.expiresAtMs <= Number(now())) {
      fail("XHS_V3_OPERATOR_E_CORPUS_RECEIPT_INVALID", "persisted E artifact cannot be adopted");
    }
    const unsigned = Object.freeze({
      schemaId: artifact.schemaId,
      schemaVersion: artifact.schemaVersion,
      status: artifact.status,
      issuedAtMs: artifact.issuedAtMs,
      expiresAtMs: artifact.expiresAtMs,
      owner: artifact.owner,
      binding: artifact.binding,
    });
    if (eventHash(unsigned) !== artifact.artifactHash) {
      fail("XHS_V3_OPERATOR_E_CORPUS_RECEIPT_INVALID", "persisted E artifact body hash drifted");
    }
    return Object.freeze({
      ok: true,
      status: "PASS",
      ref: locator.ref,
      testReportHash: locator.testReportHash,
    });
  }

  function verifyP6Pass({ requireEvent = true, expectedRunSetId = null } = {}) {
    const currentPath = join(acceptanceRoot, "p6-current.v1.json");
    acl(currentPath, false, "verify");
    const locatorBytes = readPlainBytes(currentPath, {
      fsImpl, maximumBytes: 1024 * 1024, code: "XHS_V3_OPERATOR_P6_PASS_REQUIRED",
    });
    const locator = readJson(locatorBytes, "XHS_V3_OPERATOR_P6_PASS_REQUIRED");
    if (!exact(locator, ["schemaId", "schemaVersion", "artifactHash", "artifactSchemaId", "relativePath"])
      || locator.schemaId !== "xw.xhs.v3-p6-current.v1" || locator.schemaVersion !== 1
      || locator.artifactSchemaId !== "xw.xhs.v3-free-exploration-pass.v1"
      || !HASH.test(locator.artifactHash || "")
      || locator.relativePath !== `p6-artifacts/${locator.artifactHash}/xhs-v3-p6-pass.v1.json`) {
      fail("XHS_V3_OPERATOR_P6_PASS_REQUIRED", "P6 current locator is invalid");
    }
    const artifactPath = join(acceptanceRoot, ...locator.relativePath.split("/"));
    if (!within(acceptanceRoot, artifactPath)) fail("XHS_V3_OPERATOR_P6_PASS_REQUIRED", "P6 artifact escaped acceptance root");
    acl(artifactPath, false, "verify");
    const bytes = readPlainBytes(artifactPath, {
      fsImpl, maximumBytes: 32 * 1024 * 1024, code: "XHS_V3_OPERATOR_P6_PASS_REQUIRED",
    });
    const artifact = readJson(bytes, "XHS_V3_OPERATOR_P6_PASS_REQUIRED");
    if (sha256(bytes) !== locator.artifactHash
      || artifact?.schemaId !== locator.artifactSchemaId || artifact?.status !== "PASS"
      || artifact?.verificationMarker !== "XHS_V3_FREE_EXPLORATION_VERIFIED=true"
      || artifact?.XHS_V3_FREE_EXPLORATION_VERIFIED !== true
      || !SAFE_ID.test(artifact?.runSetId || "")
      || artifact?.runtime?.releaseId !== binding.releaseId
      || artifact?.runtime?.sourceCommit !== binding.sourceCommit) {
      fail("XHS_V3_OPERATOR_P6_PASS_REQUIRED", "task-owned P6 PASS is absent or rebound");
    }
    if (expectedRunSetId !== null && artifact.runSetId !== expectedRunSetId) {
      fail("XHS_V3_OPERATOR_P6_PASS_REQUIRED", "P6 PASS belongs to another run set");
    }
    if (requireEvent) {
      const events = loadEvents(artifact.runSetId).values;
      const p6Event = events[EVENT_NAMES.length - 1];
      if (events.length !== EVENT_NAMES.length || p6Event.event !== "P6_PASS"
        || p6Event.result?.status !== "PASS" || p6Event.result?.verified !== true
        || p6Event.result?.artifactHash !== locator.artifactHash) {
        fail("XHS_V3_OPERATOR_P6_PASS_REQUIRED", "fixed operator P6 event is absent or rebound");
      }
    }
    return Object.freeze({ status: "PASS", artifactHash: locator.artifactHash, runSetId: artifact.runSetId });
  }

  async function eventOperation(command, name, operation) {
    const eventGateBefore = await gate();
    const begun = beginEvent(command, name);
    if (begun.replay) {
      const eventGateAfter = await gate();
      if (eventGateBefore.epochHash !== eventGateAfter.epochHash
        || eventGateBefore.generation !== eventGateAfter.generation
        || eventGateBefore.locksHash !== eventGateAfter.locksHash) {
        fail("XHS_V3_OPERATOR_GATE_F_DRIFT", "Gate F changed across fixed event replay");
      }
      return Object.freeze({ ok: true, replayed: true, ...begun.replay });
    }
    try {
      const result = await operation(begun);
      const eventGateAfter = await gate();
      if (eventGateBefore.epochHash !== eventGateAfter.epochHash
        || eventGateBefore.generation !== eventGateAfter.generation
        || eventGateBefore.locksHash !== eventGateAfter.locksHash) {
        fail("XHS_V3_OPERATOR_GATE_F_DRIFT", "Gate F changed across fixed event operation");
      }
      return Object.freeze({ ok: true, replayed: false, ...commitEvent(command, name, begun, result) });
    } finally {
      activeEvents.delete(begun.activeKey);
    }
  }

  return Object.freeze({
    binding,
    taskOwnershipHash,
    async execute(command) {
      if (!command || typeof command !== "object") fail("XHS_V3_OPERATOR_ARGUMENT_INVALID", "parsed command is required");
      if (command.kind === "verify-blind-review-runtime") {
        const before = await gate();
        const receipt = blindReviewRuntimeReceipt();
        const after = await gate();
        if (before.epochHash !== after.epochHash || before.generation !== after.generation
          || before.locksHash !== after.locksHash) {
          fail("XHS_V3_OPERATOR_GATE_F_DRIFT", "Gate F changed across blind-review runtime verification");
        }
        return Object.freeze({ ok: true, ...receipt });
      }
      if (command.kind === "health") {
        const gateStatus = await gate();
        const health = await fetchJson(FIXED_PATHS.health);
        if (health?.releaseId !== binding.releaseId || health?.sourceCommit !== binding.sourceCommit
          || health?.m6RuntimeMode !== "FINAL" || health?.xhsV3TaskBootstrap?.taskOwned !== true
          || health?.xhsV3TaskBootstrap?.status !== "READY_R0_R4") {
          fail("XHS_V3_OPERATOR_HEALTH_INVALID", "FINAL task-owned listener health is invalid");
        }
        const rpa = (await invoke(FIXED_PATHS.rpaHealth, undefined, "GET"))?.rpa;
        assertNoRecurringTrue(rpa);
        return Object.freeze({
          ok: true,
          status: "READY_DISABLED",
          releaseId: binding.releaseId,
          sourceCommit: binding.sourceCommit,
          operatorSha256: binding.operatorSha256,
          taskOwnershipHash,
          gateEpochHash: gateStatus.epochHash,
          gateGeneration: gateStatus.generation,
          rpaRecurringEnabled: false,
        });
      }
      if (command.kind === "prepare") {
        const index = PHASES.indexOf(command.phase);
        const eventName = `${command.phase}_PREPARED`;
        if (index < 0) fail("XHS_V3_OPERATOR_ARGUMENT_INVALID", "phase is invalid");
        return eventOperation(command, eventName, async () => {
          if (command.phase === "R1") blindReviewRuntimeReceipt();
          const invocationId = `${command.runSetId}-${command.phase.toLowerCase()}`;
          const events = loadEvents(command.runSetId).values;
          const eCorpusArtifactHash = command.phase === "R3"
            ? events[EVENT_NAMES.indexOf("E_SEALED")]?.result?.artifactHash
            : null;
          if (command.phase === "R3" && !HASH.test(String(eCorpusArtifactHash ?? ""))) {
            fail("XHS_V3_OPERATOR_E_CORPUS_RECEIPT_INVALID", "R3 requires this run set's exact E artifact hash");
          }
          const request = command.phase === "R3"
            ? { phase: command.phase, invocationId, eCorpusArtifactHash }
            : { phase: command.phase, invocationId };
          const value = adoptPreparedInvocation(command.phase, invocationId, eCorpusArtifactHash)
            ?? (await invoke(FIXED_PATHS.prepareInvocation, request))?.invocation;
          if (value?.ok !== true || value.phase !== command.phase || value.invocationId !== invocationId
            || !HASH.test(String(value.invocationHash ?? ""))) {
            fail("XHS_V3_OPERATOR_PREPARE_RECEIPT_INVALID", "invocation preparation receipt is invalid");
          }
          return Object.freeze({ status: "PREPARED", phase: command.phase, invocationHash: value.invocationHash });
        });
      }
      if (command.kind === "run") {
        return eventOperation(command, `${command.phase}_COMPLETED`, async (begun) => {
          const invocationId = `${command.runSetId}-${command.phase.toLowerCase()}`;
          const events = loadEvents(command.runSetId).values;
          const preparedEvent = events.at(-1);
          const expectedInvocationHash = preparedEvent?.event === `${command.phase}_PREPARED`
            ? preparedEvent.result?.invocationHash
            : null;
          const eCorpusArtifactHash = command.phase === "R3"
            ? events[EVENT_NAMES.indexOf("E_SEALED")]?.result?.artifactHash
            : null;
          if (!HASH.test(String(expectedInvocationHash ?? ""))
            || (command.phase === "R3" && !HASH.test(String(eCorpusArtifactHash ?? "")))) {
            fail("XHS_V3_OPERATOR_RUN_RECEIPT_INVALID", "run lacks its exact prepared invocation binding");
          }
          const adopted = adoptRunRecord(
            command.phase, invocationId, expectedInvocationHash, eCorpusArtifactHash,
          );
          if (adopted) return adopted;
          if (begun.hadPriorIntent) {
            fail(
              "XHS_V3_OPERATOR_RUN_OUTCOME_UNCERTAIN",
              "an earlier run intent has no fixed final record; device I/O will not be repeated",
            );
          }
          return safeRunProjection((await invoke(FIXED_PATHS.run, {
            phase: command.phase, invocationId,
          }))?.run, command.phase);
        });
      }
      if (command.kind === "prepare-review") {
        return eventOperation(command, "REVIEW_PREPARED", async () => {
          blindReviewRuntimeReceipt();
          let review = null;
          const existingRequestPath = reviewPaths(command.corpusSetId).requestPath;
          if (!fsImpl.existsSync(existingRequestPath)) {
            try {
              review = (await invoke(FIXED_PATHS.prepareReview, { corpusSetId: command.corpusSetId }))?.review;
            } catch (error) {
              if (error?.code !== "XHS_V3_CORPUS_SET_EXISTS") throw error;
            }
          }
          if (review !== null && (review.corpusSetId !== command.corpusSetId
            || !HASH.test(String(review.reviewRequestHash ?? ""))
            || !Number.isSafeInteger(review.receiptCount) || review.receiptCount < 1
            || review.privateMaterial !== "TASK_OWNED_OFFLINE_REVIEW_REQUIRED")) {
            fail("XHS_V3_OPERATOR_REVIEW_REQUEST_INVALID", "review preparation receipt is invalid");
          }
          const loaded = loadReviewRequest(command.corpusSetId, review?.reviewRequestHash ?? null);
          const result = prepareReviewWorkflow(command.corpusSetId, loaded.hash);
          if (review && result.receiptCount !== review.receiptCount) {
            fail("XHS_V3_OPERATOR_REVIEW_REQUEST_INVALID", "review receipt count drifted");
          }
          return result;
        });
      }
      if (command.kind === "submit-review") {
        assertCorpusBinding(command.runSetId, command.corpusSetId);
        return eventOperation(command, "REVIEW_SUBMITTED", async () => {
          const events = loadEvents(command.runSetId).values;
          const expectedReviewHash = events[6]?.result?.reviewRequestHash;
          if (!HASH.test(String(expectedReviewHash ?? ""))) fail("XHS_V3_OPERATOR_REVIEW_REQUEST_INVALID", "prepared review hash is absent");
          const sourceLeasePlan = reviewAclPlan(reviewPaths(command.corpusSetId));
          let closed = false;
          let sealed = false;
          try {
            const { response, session, attestation, admission, accessAttestationHash } = loadHumanResponse(
              command.corpusSetId, command.responseHash, expectedReviewHash,
            );
          const responseHandoffHash = sha256(Buffer.from(canonicalXhsV3FixedOperatorJson({
            sessionId: session.sessionId,
            challenge: session.challenge,
            responseHash: command.responseHash,
            accessAttestationHash,
            callerPrincipalHash: admission.callerPrincipalHash,
            isolationProbeHash: admission.isolationProbeHash,
            taskExecutionHash: admission.taskExecutionHash,
          }), "utf8"));
          const reviewerId = `blind-session-${responseHandoffHash.slice(0, 32)}`;
          const annotations = response.annotations.map((annotation, index) => Object.freeze({
            captureReceiptHash: session.rows[index].captureReceiptHash,
            expectedOutcome: annotation.expectedOutcome,
            positiveRegions: annotation.positiveRegions,
            protectedRegions: annotation.protectedRegions,
          }));
          const sealedResponse = Object.freeze({
            reviewRequestHash: response.reviewRequestHash,
            reviewerId,
            annotations,
          });
          const review = adoptSubmittedReview(command.corpusSetId, sealedResponse, accessAttestationHash)
            ?? (await invoke(FIXED_PATHS.submitReview, {
              corpusSetId: command.corpusSetId,
              reviewRequestHash: response.reviewRequestHash,
              reviewerId,
              providerImplementerId: XHS_V3_PROVIDER_IMPLEMENTER_ID,
              annotationsSealedAt: new Date(now()).toISOString(),
              providerOutputDisclosedAt: null,
              accessAttestationHash,
              annotations,
            }))?.review;
          if (review?.corpusSetId !== command.corpusSetId || review.status !== "REVIEW_RESPONSE_SEALED"
            || !HASH.test(String(review.reviewResponseHash ?? ""))
            || review.annotationCount !== annotations.length) {
            fail("XHS_V3_OPERATOR_REVIEW_SUBMIT_RECEIPT_INVALID", "review submission receipt is invalid");
          }
            sealed = true;
            const closure = reviewAclController.close(sourceLeasePlan);
            closed = true;
            return Object.freeze({
              status: review.status,
              responseHash: command.responseHash,
              accessAttestationHash,
              reviewResponseHash: review.reviewResponseHash,
              annotationCount: review.annotationCount,
              responseHandoffHash,
              sourceAclRestorationHash: closure.restoredSourceAclHash,
              closedWorkspaceAclHash: closure.closedWorkspaceAclHash,
            });
          } finally {
            if (!closed) {
              if (sealed) reviewAclController.close(sourceLeasePlan);
              else reviewAclController.restore(sourceLeasePlan);
            }
          }
        });
      }
      if (command.kind === "assemble") {
        assertCorpusBinding(command.runSetId, command.corpusSetId);
        return eventOperation(command, "CORPUS_ASSEMBLED", async () => {
          const corpus = adoptSealedCorpus(command.corpusSetId)
            ?? (await invoke(FIXED_PATHS.assemble, { corpusSetId: command.corpusSetId }))?.corpus;
          if (corpus?.corpusSetId !== command.corpusSetId
            || corpus.status !== "AWAITING_TASK_EVALUATOR_OUTCOME"
            || !HASH.test(String(corpus.sealedCorpusHash ?? ""))
            || !Number.isSafeInteger(corpus.countingRows) || corpus.countingRows < 1) {
            fail("XHS_V3_OPERATOR_CORPUS_RECEIPT_INVALID", "corpus assembly receipt is invalid");
          }
          return Object.freeze({ status: corpus.status, sealedCorpusHash: corpus.sealedCorpusHash, countingRows: corpus.countingRows });
        });
      }
      if (command.kind === "evaluate") {
        assertCorpusBinding(command.runSetId, command.corpusSetId);
        return eventOperation(command, "CORPUS_EVALUATED", async (begun) => {
          const evaluator = adoptEvaluatorOutcome(command.corpusSetId)
            ?? (begun.hadPriorIntent
              ? fail(
                "XHS_V3_OPERATOR_EVALUATOR_OUTCOME_UNCERTAIN",
                "an earlier provider-evaluator intent has no fixed final outcome; provider work will not be repeated",
              )
              : (await invoke(FIXED_PATHS.evaluate, { corpusSetId: command.corpusSetId }))?.evaluator);
          if (evaluator?.corpusSetId !== command.corpusSetId || evaluator.status !== "PASS"
            || !HASH.test(String(evaluator.evaluatorOutcomeHash ?? ""))
            || !Number.isSafeInteger(evaluator.providerOracleCaseCount) || evaluator.providerOracleCaseCount < 1
            || !Number.isSafeInteger(evaluator.adverseMutationCaseCount) || evaluator.adverseMutationCaseCount < 1) {
            fail("XHS_V3_OPERATOR_EVALUATOR_RECEIPT_INVALID", "production evaluator did not PASS");
          }
          return Object.freeze({
            status: "PASS",
            evaluatorOutcomeHash: evaluator.evaluatorOutcomeHash,
            providerOracleCaseCount: evaluator.providerOracleCaseCount,
            adverseMutationCaseCount: evaluator.adverseMutationCaseCount,
          });
        });
      }
      if (command.kind === "seal-e") {
        assertCorpusBinding(command.runSetId, command.corpusSetId);
        return eventOperation(command, "E_SEALED", async (begun) => {
          let eCorpus = adoptSealedECorpus(command.corpusSetId);
          if (eCorpus === null && begun.hadPriorIntent) {
            fail(
              "XHS_V3_OPERATOR_E_CORPUS_OUTCOME_UNCERTAIN",
              "an earlier E-seal intent has no fixed locator/artifact; E authority will not be reminted",
            );
          }
          eCorpus ??= (await invoke(FIXED_PATHS.sealE, {
            corpusSetId: command.corpusSetId, expiryPolicy: "GATE_F_SHORT",
          }))?.eCorpus;
          if (eCorpus?.ok !== true || eCorpus.status !== "PASS"
            || !HASH.test(String(eCorpus.ref?.artifactHash ?? ""))
            || !HASH.test(String(eCorpus.testReportHash ?? ""))) {
            fail("XHS_V3_OPERATOR_E_CORPUS_RECEIPT_INVALID", "E-Corpus did not produce a task-owned PASS");
          }
          return Object.freeze({ status: "PASS", artifactHash: eCorpus.ref.artifactHash, testReportHash: eCorpus.testReportHash });
        });
      }
      if (command.kind === "closeout-p6") {
        return eventOperation(command, "P6_PASS", async (begun) => {
          let closeout = null;
          try {
            const adopted = verifyP6Pass({ requireEvent: false, expectedRunSetId: command.runSetId });
            closeout = {
              status: "PASS",
              verified: true,
              artifactHash: adopted.artifactHash,
              verificationMarker: "XHS_V3_FREE_EXPLORATION_VERIFIED=true",
            };
          } catch (error) {
            if (error?.code !== "XHS_V3_OPERATOR_P6_PASS_REQUIRED") throw error;
          }
          if (closeout === null && begun.hadPriorIntent) {
            fail(
              "XHS_V3_OPERATOR_P6_OUTCOME_UNCERTAIN",
              "an earlier P6 closeout intent has no fixed PASS artifact; closeout will not be repeated",
            );
          }
          closeout ??= (await invoke(FIXED_PATHS.closeoutP6, { runSetId: command.runSetId }))?.closeout;
          if (closeout?.status !== "PASS" || closeout.verified !== true
            || !HASH.test(String(closeout.artifactHash ?? ""))
            || closeout.verificationMarker !== "XHS_V3_FREE_EXPLORATION_VERIFIED=true") {
            fail("XHS_V3_OPERATOR_P6_CLOSEOUT_FAILED", "P6 closeout is not PASS");
          }
          const verified = verifyP6Pass({ requireEvent: false, expectedRunSetId: command.runSetId });
          if (verified.artifactHash !== closeout.artifactHash) {
            fail("XHS_V3_OPERATOR_P6_CLOSEOUT_FAILED", "P6 current locator differs from closeout");
          }
          return Object.freeze({ status: "PASS", verified: true, artifactHash: closeout.artifactHash, verificationMarker: closeout.verificationMarker });
        });
      }
      if (command.kind === "rpa-plan") {
        const p6 = verifyP6Pass();
        const plan = (await invoke(FIXED_PATHS.rpaPlan, { programId: command.programId }))?.plan;
        assertNoRecurringTrue(plan);
        if (plan?.status === "BLOCKED_CATALOG") {
          if (plan.programId !== command.programId
            || !HASH.test(String(plan.catalogSnapshotHash ?? ""))
            || !Array.isArray(plan.blockers) || plan.blockers.length < 1
            || plan.stateMutations !== 0 || plan.ioOperations !== 0
            || plan.recurringEnabled !== false) {
            fail("XHS_V3_OPERATOR_RPA_PLAN_INVALID", "blocked RPA plan projection is malformed");
          }
          return Object.freeze({
            ok: true,
            status: "BLOCKED_CATALOG",
            programId: command.programId,
            generation: null,
            releaseId: binding.releaseId,
            sourceCommit: binding.sourceCommit,
            p6ArtifactHash: p6.artifactHash,
            catalogSnapshotHash: plan.catalogSnapshotHash,
            blockers: Object.freeze([...plan.blockers]),
            recurringEnabled: false,
          });
        }
        const program = plan?.program;
        if (program?.programId !== command.programId
          || !Number.isSafeInteger(program?.generation) || program.generation < 1
          || !HASH.test(String(program?.programHash ?? ""))
          || !HASH.test(String(program?.taskPlanHash ?? ""))
          || program?.runtime?.releaseId !== binding.releaseId
          || program?.runtime?.sourceCommit !== binding.sourceCommit
          || program?.enabled !== false || program?.recurringEnabled !== false
          || plan?.stateMutations !== 0 || plan?.ioOperations !== 0) {
          fail("XHS_V3_OPERATOR_RPA_PLAN_INVALID", "RPA plan is not the sealed disabled target-release program");
        }
        return Object.freeze({
          ok: true,
          status: "PLANNED",
          programId: program.programId,
          generation: program.generation,
          releaseId: program.runtime.releaseId,
          sourceCommit: program.runtime.sourceCommit,
          p6ArtifactHash: p6.artifactHash,
          programHash: program.programHash,
          planHash: program.taskPlanHash,
          recurringEnabled: false,
        });
      }
      if (command.kind === "rpa-status") {
        const p6 = verifyP6Pass();
        const rpa = (await invoke(FIXED_PATHS.rpaStatus, { programId: command.programId }))?.rpa;
        assertNoRecurringTrue(rpa);
        if (rpa?.sealStatus === "BLOCKED_CATALOG") {
          if (rpa.programId !== command.programId
            || rpa.sealedProgramId !== null || rpa.sealedGeneration !== null
            || rpa.generation !== null || rpa.programHash !== null || rpa.taskPlanHash !== null
            || !Array.isArray(rpa.blockers) || rpa.blockers.length < 1
            || rpa.registered !== false || rpa.disabled !== false || rpa.disabledAtMs !== null) {
            fail("XHS_V3_OPERATOR_RPA_STATUS_INVALID", "blocked RPA status projection is malformed");
          }
          return Object.freeze({
            ok: true,
            status: "BLOCKED_CATALOG",
            programId: command.programId,
            generation: null,
            releaseId: binding.releaseId,
            sourceCommit: binding.sourceCommit,
            p6ArtifactHash: p6.artifactHash,
            blockers: Object.freeze([...rpa.blockers]),
            registered: false,
            disabled: false,
            recurringEnabled: false,
          });
        }
        if (rpa?.sealedProgramId !== command.programId
          || !Number.isSafeInteger(rpa?.sealedGeneration) || rpa.sealedGeneration < 1
          || !Number.isSafeInteger(rpa?.generation) || rpa.generation < rpa.sealedGeneration
          || !HASH.test(String(rpa?.programHash ?? ""))
          || !HASH.test(String(rpa?.taskPlanHash ?? ""))
          || rpa?.releaseId !== binding.releaseId || rpa?.sourceCommit !== binding.sourceCommit
          || typeof rpa?.registered !== "boolean" || typeof rpa?.disabled !== "boolean"
          || (rpa.disabled && (!rpa.registered || !Number.isSafeInteger(rpa.disabledAtMs)))
          || (!rpa.disabled && rpa.disabledAtMs !== null)) {
          fail("XHS_V3_OPERATOR_RPA_STATUS_INVALID", "RPA status is not bound to the sealed target-release program");
        }
        return Object.freeze({
          ok: true,
          status: rpa.disabled ? "DISABLED" : rpa.sealStatus,
          programId: command.programId,
          sealedGeneration: rpa.sealedGeneration,
          generation: rpa.generation,
          releaseId: rpa.releaseId,
          sourceCommit: rpa.sourceCommit,
          p6ArtifactHash: p6.artifactHash,
          programHash: rpa.programHash,
          planHash: rpa.taskPlanHash,
          registered: rpa.registered,
          disabled: rpa.disabled,
          disabledAtMs: rpa.disabledAtMs,
          activeTickCount: Number.isSafeInteger(rpa?.activeTickCount) ? rpa.activeTickCount : null,
          recoveryRequired: rpa?.recoveryRequired === true,
          recurringEnabled: false,
        });
      }
      if (command.kind === "rpa-disable") {
        const p6 = verifyP6Pass();
        const rpa = (await invoke(FIXED_PATHS.rpaDisable, {
          programId: command.programId, generation: command.generation,
        }))?.rpa;
        assertNoRecurringTrue(rpa);
        if (rpa?.programId !== command.programId
          || rpa?.enabled !== false || rpa?.recurringEnabled !== false
          || !Number.isSafeInteger(rpa?.generation)
          || ![command.generation, command.generation + 1].includes(rpa.generation)
          || !Number.isSafeInteger(rpa?.disabledAtMs)
          || !HASH.test(String(rpa?.programHash ?? ""))
          || !HASH.test(String(rpa?.taskPlanHash ?? ""))
          || rpa?.releaseId !== binding.releaseId || rpa?.sourceCommit !== binding.sourceCommit) {
          fail("XHS_V3_OPERATOR_RPA_DISABLE_FAILED", "RPA program did not become disabled");
        }
        return Object.freeze({
          ok: true,
          status: "DISABLED",
          programId: command.programId,
          requestedGeneration: command.generation,
          generation: rpa.generation,
          releaseId: rpa.releaseId,
          sourceCommit: rpa.sourceCommit,
          p6ArtifactHash: p6.artifactHash,
          programHash: rpa.programHash,
          planHash: rpa.taskPlanHash,
          disabledAtMs: rpa.disabledAtMs,
          activeTickCount: rpa.activeTicks,
          recurringEnabled: false,
        });
      }
      if (command.kind === "rpa-manual-once") {
        const p6 = verifyP6Pass();
        const rpa = (await invoke(FIXED_PATHS.rpaManual, {
          programId: command.programId,
          generation: command.generation,
          idempotencyKey: command.idempotencyKey,
        }))?.rpa;
        assertNoRecurringTrue(rpa);
        if (rpa?.result?.status !== "SUCCEEDED" || rpa.result?.receipt?.committed !== true
          || !HASH.test(String(rpa.result.receipt.receiptHash ?? ""))
          || rpa?.closeout?.RPA_FOUNDATION_VERIFIED !== true
          || rpa?.closeout?.RPA_RECURRING_ENABLED !== false
          || !HASH.test(String(rpa.closeout.closeoutHash ?? ""))) {
          fail("XHS_V3_OPERATOR_RPA_MANUAL_FAILED", "manual-once did not produce the closed P7 PASS");
        }
        return Object.freeze({
          ok: true,
          status: "SUCCEEDED",
          programId: command.programId,
          generation: command.generation,
          p6ArtifactHash: p6.artifactHash,
          receiptHash: rpa.result.receipt.receiptHash,
          closeoutHash: rpa.closeout.closeoutHash,
          RPA_FOUNDATION_VERIFIED: true,
          RPA_RECURRING_ENABLED: false,
        });
      }
      fail("XHS_V3_OPERATOR_ARGUMENT_INVALID", "command kind is not in the fixed grammar");
    },
  });
}

async function verifyActiveProductionContext({
  runtimeRoot = XHS_V3_FIXED_OPERATOR_RUNTIME_ROOT,
  executingOperatorPath = fileURLToPath(import.meta.url),
  tupleVerifier = verifyGateFCutoverTuple,
  aclController = createSystemTcbAclController(),
} = {}) {
  const releaseIdentity = loadReleaseIdentity({ startDir: dirname(executingOperatorPath) });
  const binding = loadXhsV3FixedOperatorReleaseBinding({
    runtimeRoot,
    releaseIdentity,
    executingOperatorPath,
  });
  const referencePath = join(
    runtimeRoot,
    "cutover-targets",
    binding.releaseId,
    binding.sourceCommit,
    GATE_F_TARGET_REFERENCE_FILENAME,
  );
  aclController.verify(buildSystemTcbAclPlan({ boundaryPath: runtimeRoot, targetPath: referencePath, recursive: false }));
  const referenceBytes = readPlainBytes(referencePath, {
    maximumBytes: 1024 * 1024,
    code: "XHS_V3_OPERATOR_TASK_OWNERSHIP_INVALID",
  });
  const reference = readJson(referenceBytes, "XHS_V3_OPERATOR_TASK_OWNERSHIP_INVALID");
  if (!exact(reference, ["schemaId", "releaseId", "sourceCommit", "tuple"])
    || reference.schemaId !== GATE_F_TARGET_REFERENCE_SCHEMA_ID
    || reference.releaseId !== binding.releaseId || reference.sourceCommit !== binding.sourceCommit
    || !exact(reference.tuple, ["path", "sha256"]) || !HASH.test(reference.tuple.sha256 || "")
    || !samePath(reference.tuple.path, join(
      runtimeRoot, "cutover-tuples", reference.tuple.sha256, GATE_F_CUTOVER_TUPLE_FILENAME,
    ))) {
    fail("XHS_V3_OPERATOR_TASK_OWNERSHIP_INVALID", "active target reference drifted");
  }
  const verified = await tupleVerifier({
    tuplePath: reference.tuple.path,
    expectedTupleSha256: reference.tuple.sha256,
    expectedRuntimeRoot: runtimeRoot,
    requireActive: true,
  });
  if (verified?.ok !== true || verified.active !== true
    || verified.releaseId !== binding.releaseId || verified.sourceCommit !== binding.sourceCommit
    || !verified.taskProcessClosure) {
    fail("XHS_V3_OPERATOR_TASK_OWNERSHIP_INVALID", "FINAL release is not owned by the fixed task closure");
  }
  return Object.freeze({
    binding,
    providerBundleDigest: verified.tuple.runtimeBindings.provider.providerBundleDigest,
    taskOwnershipHash: sha256(Buffer.from(canonicalXhsV3FixedOperatorJson(verified.taskProcessClosure), "utf8")),
    aclController,
  });
}

export async function createFixedXhsV3ProductionOperator({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") fail("XHS_V3_OPERATOR_CONTEXT_INVALID", "fixed loopback HTTP client is unavailable");
  const context = await verifyActiveProductionContext({});
  const authority = loadXhsV3FixedOperatorAuthority({});
  const signer = createXhsV3FixedOperatorRequestSigner({
    liveEntryToken: authority.liveEntryToken,
    binding: context.binding,
  });
  return createXhsV3ProductionOperatorForTest({
    runtimeRoot: XHS_V3_FIXED_OPERATOR_RUNTIME_ROOT,
    binding: context.binding,
    gateToken: authority.gateToken,
    signer,
    fetchImpl,
    aclController: context.aclController,
    reviewAclController: createXhsV3BlindReviewAclController(),
    reviewWorkspaceRoot: XHS_V3_BLIND_REVIEW_ROOT,
    providerBundleDigest: context.providerBundleDigest,
    taskOwnershipHash: context.taskOwnershipHash,
  });
}

export async function runXhsV3ProductionOperatorCli(argv, options = {}) {
  const command = parseXhsV3ProductionOperatorCommand(argv);
  const operator = options.operator ?? await createFixedXhsV3ProductionOperator(options);
  return operator.execute(command);
}

if (process.argv[1] && samePath(fileURLToPath(import.meta.url), process.argv[1])) {
  try {
    const result = await runXhsV3ProductionOperatorCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code: safeCode(error) } })}\n`);
    process.exitCode = 1;
  }
}

// The only authorization-bearing headers are constructed internally. Keeping
// these names referenced here also makes accidental CLI/header passthrough
// mechanically visible to release checks without ever printing their values.
void XHS_V3_FIXED_OPERATOR_AUTH_HEADER;
void XHS_V3_FIXED_OPERATOR_TIMESTAMP_HEADER;
void XHS_V3_FIXED_OPERATOR_NONCE_HEADER;
void XHS_V3_FIXED_OPERATOR_RELEASE_PATH;
