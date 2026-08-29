import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

export const XHS_CORPUS_CAPTURE_RECEIPT_SCHEMA_ID =
  "xw.xhs.exploration-capture-receipt.v1";
export const XHS_CORPUS_BLIND_ANNOTATIONS_SCHEMA_ID =
  "xw.xhs.exploration-blind-annotations.v1";
export const XHS_CORPUS_LABEL_SESSION_SCHEMA_ID =
  "xw.xhs.exploration-label-session.v1";
export const XHS_CORPUS_PUBLIC_MANIFEST_SCHEMA_ID =
  "xw.xhs.exploration-corpus-public.v2";
export const XHS_CORPUS_PRIVATE_INDEX_SCHEMA_ID =
  "xw.xhs.exploration-corpus-private-index.v1";
export const XHS_CORPUS_SEALED_BUNDLE_SCHEMA_ID =
  "xw.xhs.exploration-corpus-sealed-bundle.v1";

export const XHS_CORPUS_REQUIRED_ROUTES = Object.freeze([
  "HOME_FEED",
  "SEARCH_RESULTS",
  "IMAGE_NOTE",
  "VIDEO_NOTE",
  "COMMENT_PANEL",
]);

export const XHS_CORPUS_DUMP_VERDICTS = Object.freeze([
  "COMPLETE_SAFE_UNIQUE",
  "AMBIGUOUS_SAFE",
  "ABSENT_OR_INVALID",
  "FORBIDDEN_OR_RISKY",
]);

export const XHS_CORPUS_CAPTURE_MODES = Object.freeze([
  "OFFLINE_FIXTURE_ONLY",
  "CP_BOUND_R1_R2",
]);

export const XHS_CORPUS_ZERO_RESOURCES = Object.freeze({
  jobs: 0,
  sessions: 0,
  leases: 0,
  deviceIo: 0,
});

export const XHS_CORPUS_ROUTE_VALIDATOR_ID =
  "xw.xhs.exact-pair-route-validator.v1";
export const XHS_CORPUS_DUMP_RECEIPT_SCHEMA_ID =
  "xw.xhs.exploration-dump-condition-receipt.v1";
export const XHS_CORPUS_TRANSITION_RECEIPT_SCHEMA_ID =
  "xw.xhs.exploration-dump-transition-receipt.v1";
export const XHS_CORPUS_LANE_JOURNAL_SCHEMA_ID =
  "xw.xhs.exploration-offline-lane-journal.v1";

export const XHS_CORPUS_EXACT_PAIR_BINDINGS = Object.freeze([
  Object.freeze({ alias: "03", laneRole: "FEED" }),
  Object.freeze({ alias: "04", laneRole: "SEARCH" }),
]);

export const XHS_CORPUS_TYPED_DUMP_ROLES = Object.freeze([
  "OPEN_SEARCH",
  "SUBMIT_SEARCH",
  "SCROLL_FEED",
  "SCROLL_RESULTS",
  "OPEN_CONTENT_CARD",
  "OPEN_COMMENT_PANEL",
  "BACK",
  "RESTORE",
]);

const ROUTE_ROLES = Object.freeze({
  HOME_FEED: Object.freeze(["OPEN_CONTENT_CARD"]),
  SEARCH_RESULTS: Object.freeze(["OPEN_CONTENT_CARD"]),
  IMAGE_NOTE: Object.freeze(["OPEN_COMMENT_PANEL"]),
  VIDEO_NOTE: Object.freeze(["PAUSE_VIDEO_SAFE_ZONE", "OPEN_COMMENT_PANEL"]),
  COMMENT_PANEL: Object.freeze(["BACK"]),
});
const PHASES = new Set(["CALIBRATION_ONLY", "R1", "R2"]);
const COUNTING_PHASES = new Set(["R1", "R2"]);
const CAPTURE_MODES = new Set(XHS_CORPUS_CAPTURE_MODES);
const DUMP_VERDICTS = new Set(XHS_CORPUS_DUMP_VERDICTS);
const EXPECTED_OUTCOMES = new Set([
  "SAFE_UNIQUE",
  "NO_FALLBACK_EXPECTED",
  "REJECT",
]);
const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_40 = /^[0-9a-f]{40}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const ROW_ID = /^row-[0-9]{3,6}$/;
const OPAQUE_REF = /^(?:src|receipt|wave|surface|label):[0-9a-f]{64}$/;
const PUBLIC_FORBIDDEN_KEY = /(?:path|file(?:name)?|ocr|text|serial|token|secret|password|session|lease|authority|job|runid|actor|raw)/i;
const PUBLIC_FORBIDDEN_VALUE = /(?:^[a-zA-Z]:[\\/]|^\\\\|^\/(?:home|users|var|tmp)\/|\b(?:session|lease|job|run)[_-][0-9a-f-]{8,}\b)/i;
const LABEL_IMMUTABLE_KEYS = new Set([
  "pageClass",
  "evaluationRole",
  "dumpVerdict",
  "frameHash",
  "pngHash",
  "dumpHash",
  "focusHash",
  "alias",
  "laneRole",
  "releaseId",
  "sourceCommit",
  "providerBundleDigest",
]);
const OFFLINE_ADAPTER_FORBIDDEN_KEYS = /(?:endpoint|baseurl|url|host|port|transport|fetch|request|connect|socket|adb|device|controlplane|registry)/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneCanonical(value, pointer = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`non-finite number at ${pointer}`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => cloneCanonical(item, `${pointer}[${index}]`));
  }
  if (!isPlainObject(value)) throw new TypeError(`non-JSON value at ${pointer}`);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new TypeError(`undefined value at ${pointer}.${key}`);
    output[key] = cloneCanonical(value[key], `${pointer}.${key}`);
  }
  return output;
}

export function canonicalJson(value) {
  return JSON.stringify(cloneCanonical(value));
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function asBuffer(value, field) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError(`${field} must be exact bytes`);
}

function normalizeHmacKey(key) {
  const bytes = asBuffer(key, "signing key");
  if (bytes.length < 32) throw new TypeError("fixture signing key must be at least 32 bytes");
  return bytes;
}

function hmacHex(key, domain, value) {
  return createHmac("sha256", key)
    .update(`${domain}\0`, "utf8")
    .update(value)
    .digest("hex");
}

function safeEqualHex(left, right) {
  if (!HEX_64.test(String(left ?? "")) || !HEX_64.test(String(right ?? ""))) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function opaqueRef(prefix, key, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${prefix} opaque source must be a non-empty string`);
  }
  return `${prefix}:${hmacHex(key, `xhs-corpus:${prefix}`, Buffer.from(value, "utf8"))}`;
}

function receiptPayload(receipt) {
  const { authentication: _authentication, ...payload } = receipt ?? {};
  return payload;
}

function issue(errors, code, message, rowId = null) {
  errors.push(rowId ? { code, rowId, message } : { code, message });
}

function hasExactKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function validResourceSnapshot(value) {
  return isPlainObject(value)
    && Object.keys(XHS_CORPUS_ZERO_RESOURCES).every((key) => Number.isInteger(value[key]) && value[key] >= 0)
    && Object.keys(value).every((key) => Object.hasOwn(XHS_CORPUS_ZERO_RESOURCES, key));
}

export function assertOfflineZeroResources(snapshot, stage = "P4A") {
  if (!validResourceSnapshot(snapshot)) {
    throw new Error(`XHS_CORPUS_RESOURCE_ORACLE_INVALID:${stage}`);
  }
  for (const [key, expected] of Object.entries(XHS_CORPUS_ZERO_RESOURCES)) {
    if (snapshot[key] !== expected) {
      throw new Error(`XHS_CORPUS_PHASE_BOUNDARY_VIOLATION:${stage}:${key}=${snapshot[key]}`);
    }
  }
  return Object.freeze({ ...XHS_CORPUS_ZERO_RESOURCES });
}

function validateOfflineAdapterShape(adapter) {
  if (!isPlainObject(adapter)
    || adapter.kind !== "fixture"
    || adapter.capability !== "OFFLINE_FIXTURE_ONLY"
    || typeof adapter.snapshotResources !== "function"
    || typeof adapter.readFixtureCaptures !== "function") {
    throw new Error("XHS_CORPUS_OFFLINE_ADAPTER_REQUIRED");
  }
  for (const key of Object.keys(adapter)) {
    if (OFFLINE_ADAPTER_FORBIDDEN_KEYS.test(key)) {
      throw new Error(`XHS_CORPUS_PRODUCTION_SURFACE_FORBIDDEN:${key}`);
    }
  }
}

export function createFixtureCorpusAdapter({
  captures = [],
  resources = XHS_CORPUS_ZERO_RESOURCES,
} = {}) {
  const frozenResources = Object.freeze({ ...resources });
  const traversal = createFixtureTraversalState();
  return Object.freeze({
    kind: "fixture",
    capability: "OFFLINE_FIXTURE_ONLY",
    snapshotResources() {
      return { ...frozenResources };
    },
    async readFixtureCaptures() {
      return [...captures];
    },
    readExactPairTraversal: traversal.readExactPairTraversal,
    openExactPairBarrier: traversal.openExactPairBarrier,
    reserveTypedTransition: traversal.reserveTypedTransition,
    commitTypedTransition: traversal.commitTypedTransition,
    releaseExactPairLane: traversal.releaseExactPairLane,
    snapshotTraversalAudit: traversal.snapshotTraversalAudit,
  });
}

function assertSafeId(value, field) {
  if (!SAFE_ID.test(String(value ?? ""))) throw new TypeError(`${field} is invalid`);
  return String(value);
}

function assertHash(value, field) {
  if (!HEX_64.test(String(value ?? ""))) throw new TypeError(`${field} must be lowercase sha256`);
  return String(value);
}

function assertRouteRole(pageClass, evaluationRole) {
  if (!Object.hasOwn(ROUTE_ROLES, pageClass)
    || !ROUTE_ROLES[pageClass].includes(evaluationRole)) {
    throw new TypeError("evaluationRole is outside the closed route matrix");
  }
}

function assertFixedLane(pageClass, alias, laneRole) {
  if (alias === "03" && laneRole !== "FEED") {
    throw new TypeError("alias 03 is permanently bound to the FEED lane");
  }
  if (alias === "04" && laneRole !== "SEARCH") {
    throw new TypeError("alias 04 is permanently bound to the SEARCH lane");
  }
  if (!new Set(["03", "04"]).has(alias)) {
    throw new TypeError("corpus capture is restricted to the exact [03,04] pair");
  }
  if (pageClass === "HOME_FEED" && alias !== "03") {
    throw new TypeError("HOME_FEED evidence must come from alias 03");
  }
  if (pageClass === "SEARCH_RESULTS" && alias !== "04") {
    throw new TypeError("SEARCH_RESULTS evidence must come from alias 04");
  }
}

function hashStructured(value) {
  return sha256Hex(Buffer.from(canonicalJson(value), "utf8"));
}

function normalizeDumpDecision(decision) {
  if (!isPlainObject(decision) || !DUMP_VERDICTS.has(decision.verdict)) {
    throw new TypeError("actual DUMP verdict is outside the closed four-verdict set");
  }
  if (!Array.isArray(decision.reasons)
    || decision.reasons.length === 0
    || decision.reasons.some((reason) => typeof reason !== "string" || !reason)) {
    throw new TypeError("actual DUMP decision requires non-empty reasons");
  }
  if (!Array.isArray(decision.regions)) {
    throw new TypeError("actual DUMP decision regions must be an array");
  }
  return Object.freeze({
    verdict: decision.verdict,
    reasonsHash: hashStructured(decision.reasons),
    regionsHash: hashStructured(decision.regions),
  });
}

function readPngDimensions(bytes) {
  if (bytes.length < 24
    || !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    || bytes.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function buildCaptureReceiptForMode(capture, {
  signingKey,
  digestKeyId,
  captureMode,
} = {}) {
  const key = normalizeHmacKey(signingKey);
  if (!CAPTURE_MODES.has(captureMode)) throw new TypeError("captureMode is invalid");
  const pngBytes = asBuffer(capture?.pngBytes, "pngBytes");
  const dumpBytes = asBuffer(capture?.dumpBytes, "dumpBytes");
  const focusBytes = asBuffer(capture?.focusBytes, "focusBytes");
  const dimensions = readPngDimensions(pngBytes);
  if (!dimensions) throw new TypeError("pngBytes must contain a PNG IHDR binding");
  const pageClass = String(capture?.pageClass ?? "");
  const evaluationRole = String(capture?.evaluationRole ?? "");
  assertRouteRole(pageClass, evaluationRole);
  const alias = String(capture?.alias ?? "");
  const laneRole = String(capture?.laneRole ?? "");
  assertFixedLane(pageClass, alias, laneRole);
  const phase = String(capture?.phase ?? "");
  if (!PHASES.has(phase)) throw new TypeError("capture phase must be CALIBRATION_ONLY, R1, or R2");
  if (captureMode === "OFFLINE_FIXTURE_ONLY" && phase !== "CALIBRATION_ONLY") {
    throw new TypeError("offline fixture capture must be CALIBRATION_ONLY and can never claim R1/R2");
  }
  if (captureMode === "CP_BOUND_R1_R2" && !COUNTING_PHASES.has(phase)) {
    throw new TypeError("CP-bound capture must come from R1 or R2");
  }
  const dump = normalizeDumpDecision(capture?.dumpDecision);
  const sourceCommit = String(capture?.sourceCommit ?? "");
  if (!HEX_40.test(sourceCommit)) throw new TypeError("sourceCommit must be a full lowercase 40-hex commit");
  const keyId = assertSafeId(digestKeyId, "digestKeyId");

  const payload = {
    schemaId: XHS_CORPUS_CAPTURE_RECEIPT_SCHEMA_ID,
    schemaVersion: 1,
    captureMode,
    evidence: {
      pngHash: sha256Hex(pngBytes),
      dumpHash: sha256Hex(dumpBytes),
      focusHash: sha256Hex(focusBytes),
      width: dimensions.width,
      height: dimensions.height,
    },
    classification: {
      pageClass,
      evaluationRole,
      dumpVerdict: dump.verdict,
      dumpReasonsHash: dump.reasonsHash,
      dumpRegionsHash: dump.regionsHash,
    },
    placement: {
      alias,
      laneRole,
    },
    provenance: {
      phase,
      sessionDigest: hmacHex(key, "xhs-corpus:session", Buffer.from(assertSafeId(capture?.sessionId, "sessionId"), "utf8")),
      leaseDigest: hmacHex(key, "xhs-corpus:lease", Buffer.from(assertSafeId(capture?.leaseId, "leaseId"), "utf8")),
      authorityDigest: hmacHex(key, "xhs-corpus:authority", Buffer.from(assertSafeId(capture?.authorityId, "authorityId"), "utf8")),
      waveDigest: hmacHex(key, "xhs-corpus:wave", Buffer.from(assertSafeId(capture?.waveId, "waveId"), "utf8")),
      surfaceClaimDigest: hmacHex(key, "xhs-corpus:surface", Buffer.from(assertSafeId(capture?.surfaceClaim, "surfaceClaim"), "utf8")),
    },
    runtime: {
      releaseId: assertSafeId(capture?.releaseId, "releaseId"),
      sourceCommit,
      providerBundleDigest: assertHash(capture?.providerBundleDigest, "providerBundleDigest"),
      digestKeyId: keyId,
    },
    safety: {
      socialTransport: 0,
      effectTransport: 0,
      visualIssued: 0,
      visualConsumed: 0,
      visualPhysical: 0,
    },
  };
  const canonical = Buffer.from(canonicalJson(payload), "utf8");
  const payloadHash = sha256Hex(canonical);
  const mac = hmacHex(key, "xhs-corpus:capture-receipt:v1", canonical);
  return Object.freeze({
    ...payload,
    authentication: Object.freeze({
      algorithm: "HMAC-SHA256",
      digestKeyId: keyId,
      payloadHash,
      mac,
    }),
  });
}

/**
 * P4A/R0 fixture receipt builder. It deliberately refuses R1/R2 provenance,
 * so an offline operator can exercise the oracle but cannot mint E coverage.
 */
export function buildOfflineFixtureCaptureReceipt(capture, options = {}) {
  return buildCaptureReceiptForMode(capture, {
    ...options,
    captureMode: "OFFLINE_FIXTURE_ONLY",
  });
}

/**
 * Canonical receipt builder for the formal CP task-owned R1/R2 capture path.
 * Production eligibility still requires verification with the fixed
 * production key/runtime by the task-owned E-Corpus sealer.
 */
export function buildCpBoundCaptureReceipt(capture, options = {}) {
  return buildCaptureReceiptForMode(capture, {
    ...options,
    captureMode: "CP_BOUND_R1_R2",
  });
}

function validateReceiptStructure(receipt, errors, receiptHash = null) {
  const topKeys = [
    "schemaId", "schemaVersion", "captureMode", "evidence", "classification",
    "placement", "provenance", "runtime", "safety", "authentication",
  ];
  if (!hasExactKeys(receipt, topKeys)
    || receipt.schemaId !== XHS_CORPUS_CAPTURE_RECEIPT_SCHEMA_ID
    || receipt.schemaVersion !== 1
    || !CAPTURE_MODES.has(receipt.captureMode)) {
    issue(errors, "CAPTURE_RECEIPT_SCHEMA_INVALID", "capture receipt schema/mode is invalid", receiptHash);
    return;
  }
  const evidence = receipt.evidence;
  if (!hasExactKeys(evidence, ["pngHash", "dumpHash", "focusHash", "width", "height"])
    || ![evidence.pngHash, evidence.dumpHash, evidence.focusHash].every((hash) => HEX_64.test(String(hash ?? "")))
    || !Number.isInteger(evidence.width) || evidence.width <= 0
    || !Number.isInteger(evidence.height) || evidence.height <= 0) {
    issue(errors, "CAPTURE_RECEIPT_EVIDENCE_INVALID", "capture evidence binding is invalid", receiptHash);
  }
  const classification = receipt.classification;
  if (!hasExactKeys(classification, ["pageClass", "evaluationRole", "dumpVerdict", "dumpReasonsHash", "dumpRegionsHash"])
    || !DUMP_VERDICTS.has(classification.dumpVerdict)
    || !HEX_64.test(String(classification.dumpReasonsHash ?? ""))
    || !HEX_64.test(String(classification.dumpRegionsHash ?? ""))) {
    issue(errors, "CAPTURE_RECEIPT_DUMP_INVALID", "actual DUMP binding is invalid", receiptHash);
  } else {
    try {
      assertRouteRole(classification.pageClass, classification.evaluationRole);
    } catch (error) {
      issue(errors, "CAPTURE_RECEIPT_ROLE_INVALID", error.message, receiptHash);
    }
  }
  if (!hasExactKeys(receipt.placement, ["alias", "laneRole"])) {
    issue(errors, "CAPTURE_RECEIPT_LANE_INVALID", "capture placement fields are invalid", receiptHash);
  }
  try {
    assertFixedLane(classification?.pageClass, receipt.placement?.alias, receipt.placement?.laneRole);
  } catch (error) {
    issue(errors, "CAPTURE_RECEIPT_LANE_INVALID", error.message, receiptHash);
  }
  const provenance = receipt.provenance;
  if (!hasExactKeys(provenance, ["phase", "sessionDigest", "leaseDigest", "authorityDigest", "waveDigest", "surfaceClaimDigest"])
    || !PHASES.has(provenance.phase)
    || ![provenance.sessionDigest, provenance.leaseDigest, provenance.authorityDigest,
      provenance.waveDigest, provenance.surfaceClaimDigest].every((hash) => HEX_64.test(String(hash ?? "")))) {
    issue(errors, "CAPTURE_RECEIPT_PROVENANCE_INVALID", "capture provenance is invalid", receiptHash);
  }
  if ((receipt.captureMode === "OFFLINE_FIXTURE_ONLY" && provenance?.phase !== "CALIBRATION_ONLY")
    || (receipt.captureMode === "CP_BOUND_R1_R2" && !COUNTING_PHASES.has(provenance?.phase))) {
    issue(errors, "CAPTURE_RECEIPT_MODE_PHASE_INVALID", "capture mode cannot claim this phase", receiptHash);
  }
  const runtime = receipt.runtime;
  if (!hasExactKeys(runtime, ["releaseId", "sourceCommit", "providerBundleDigest", "digestKeyId"])
    || !SAFE_ID.test(String(runtime.releaseId ?? ""))
    || !HEX_40.test(String(runtime.sourceCommit ?? ""))
    || !HEX_64.test(String(runtime.providerBundleDigest ?? ""))
    || !SAFE_ID.test(String(runtime.digestKeyId ?? ""))) {
    issue(errors, "CAPTURE_RECEIPT_RUNTIME_INVALID", "runtime identity binding is invalid", receiptHash);
  }
  const safety = receipt.safety;
  if (!hasExactKeys(safety, ["socialTransport", "effectTransport", "visualIssued", "visualConsumed", "visualPhysical"])
    || Object.values(safety).some((value) => value !== 0)) {
    issue(errors, "CAPTURE_RECEIPT_ZERO_SAFETY_INVALID", "capture counters must all be zero", receiptHash);
  }
}

export function verifyCaptureReceipt(receipt, {
  signingKey,
  expectedDigestKeyId = null,
  expectedRuntime = null,
} = {}) {
  const errors = [];
  const key = normalizeHmacKey(signingKey);
  const payload = receiptPayload(receipt);
  const canonical = Buffer.from(canonicalJson(payload), "utf8");
  const receiptHash = sha256Hex(Buffer.from(canonicalJson(receipt), "utf8"));
  validateReceiptStructure(receipt, errors, receiptHash);
  const auth = receipt?.authentication;
  if (!hasExactKeys(auth, ["algorithm", "digestKeyId", "payloadHash", "mac"])
    || auth.algorithm !== "HMAC-SHA256"
    || auth.digestKeyId !== receipt?.runtime?.digestKeyId
    || !safeEqualHex(auth.payloadHash, sha256Hex(canonical))
    || !safeEqualHex(auth.mac, hmacHex(key, "xhs-corpus:capture-receipt:v1", canonical))) {
    issue(errors, "CAPTURE_RECEIPT_AUTH_INVALID", "capture receipt HMAC/content binding failed", receiptHash);
  }
  if (expectedDigestKeyId !== null && receipt?.runtime?.digestKeyId !== expectedDigestKeyId) {
    issue(errors, "CAPTURE_RECEIPT_KEY_DRIFT", "capture receipt digest key differs from the expected key", receiptHash);
  }
  if (isPlainObject(expectedRuntime)) {
    for (const field of ["releaseId", "sourceCommit", "providerBundleDigest"]) {
      if (expectedRuntime[field] !== undefined && receipt?.runtime?.[field] !== expectedRuntime[field]) {
        issue(errors, "CAPTURE_RECEIPT_RUNTIME_DRIFT", `${field} differs from the expected runtime`, receiptHash);
      }
    }
  }
  return Object.freeze({ valid: errors.length === 0, receiptHash, errors });
}

function assertNoImmutableLabelFields(annotation, pointer) {
  for (const key of Object.keys(annotation ?? {})) {
    if (LABEL_IMMUTABLE_KEYS.has(key)) {
      throw new TypeError(`blind label cannot author capture field ${pointer}.${key}`);
    }
  }
}

function validBounds(bounds) {
  return Array.isArray(bounds)
    && bounds.length === 4
    && bounds.every(Number.isInteger)
    && bounds[0] >= 0
    && bounds[1] >= 0
    && bounds[2] > bounds[0]
    && bounds[3] > bounds[1];
}

function normalizeAnnotation(annotation, receiptByHash, index) {
  if (!isPlainObject(annotation)) throw new TypeError(`annotation[${index}] must be an object`);
  assertNoImmutableLabelFields(annotation, `annotation[${index}]`);
  const captureReceiptHash = assertHash(annotation.captureReceiptHash, "captureReceiptHash");
  const receipt = receiptByHash.get(captureReceiptHash);
  if (!receipt) {
    throw new TypeError(`annotation[${index}] references an unknown capture receipt`);
  }
  if (!EXPECTED_OUTCOMES.has(annotation.expectedOutcome)) {
    throw new TypeError(`annotation[${index}] expectedOutcome is invalid`);
  }
  const positiveRegions = Array.isArray(annotation.positiveRegions)
    ? annotation.positiveRegions.map((region) => {
      if (!isPlainObject(region)
        || !SAFE_ID.test(String(region.role ?? ""))
        || !validBounds(region.bounds)) throw new TypeError(`annotation[${index}] positive region is invalid`);
      return { role: region.role, bounds: [...region.bounds] };
    })
    : [];
  const protectedRegions = Array.isArray(annotation.protectedRegions)
    ? annotation.protectedRegions.map((region) => {
      if (!isPlainObject(region)
        || !SAFE_ID.test(String(region.kind ?? ""))
        || !validBounds(region.bounds)) throw new TypeError(`annotation[${index}] protected region is invalid`);
      return { kind: region.kind, bounds: [...region.bounds] };
    })
    : [];
  if (annotation.expectedOutcome === "SAFE_UNIQUE" && positiveRegions.length === 0) {
    throw new TypeError(`annotation[${index}] SAFE_UNIQUE requires positive geometry`);
  }
  if (positiveRegions.some((region) => region.role !== receipt.classification.evaluationRole)) {
    throw new TypeError(`annotation[${index}] geometry role differs from immutable evaluationRole`);
  }
  if (receipt.classification.dumpVerdict === "COMPLETE_SAFE_UNIQUE"
    && annotation.expectedOutcome !== "NO_FALLBACK_EXPECTED") {
    throw new TypeError(`annotation[${index}] COMPLETE DUMP must remain NO_FALLBACK_EXPECTED`);
  }
  if (receipt.classification.dumpVerdict === "FORBIDDEN_OR_RISKY"
    && annotation.expectedOutcome !== "REJECT") {
    throw new TypeError(`annotation[${index}] forbidden DUMP must remain REJECT`);
  }
  if (["AMBIGUOUS_SAFE", "ABSENT_OR_INVALID"].includes(receipt.classification.dumpVerdict)
    && annotation.expectedOutcome === "NO_FALLBACK_EXPECTED") {
    throw new TypeError(`annotation[${index}] fallback-positive DUMP cannot be relabelled COMPLETE`);
  }
  const allowed = new Set(["captureReceiptHash", "expectedOutcome", "positiveRegions", "protectedRegions"]);
  if (Object.keys(annotation).some((key) => !allowed.has(key))) {
    throw new TypeError(`annotation[${index}] contains an unsupported field`);
  }
  return {
    captureReceiptHash,
    expectedOutcome: annotation.expectedOutcome,
    positiveRegions,
    protectedRegions,
  };
}

export function sealBlindLabels({
  receipts,
  annotations,
  reviewerId,
  providerImplementerId,
  annotationsSealedAt,
  providerOutputDisclosedAt = null,
  accessAttestationHash,
  signingKey,
  digestKeyId,
} = {}) {
  const key = normalizeHmacKey(signingKey);
  const receiptEntries = (Array.isArray(receipts) ? receipts : []).map((receipt) => {
    const verification = verifyCaptureReceipt(receipt, {
      signingKey: key,
      expectedDigestKeyId: digestKeyId,
    });
    if (!verification.valid) throw new TypeError("cannot label an invalid capture receipt");
    return { receipt, hash: verification.receiptHash };
  });
  if (receiptEntries.length === 0) throw new TypeError("blind labels require capture receipts");
  if (!HEX_64.test(String(accessAttestationHash ?? ""))) {
    throw new TypeError("blind labels require one fixed ACL access attestation hash");
  }
  const receiptByHash = new Map(receiptEntries.map((entry) => [entry.hash, entry.receipt]));
  const receiptHashes = new Set(receiptByHash.keys());
  if (receiptHashes.size !== receiptEntries.length) throw new TypeError("duplicate capture receipt");
  const normalizedAnnotations = (Array.isArray(annotations) ? annotations : [])
    .map((annotation, index) => normalizeAnnotation(annotation, receiptByHash, index))
    .sort((left, right) => left.captureReceiptHash.localeCompare(right.captureReceiptHash));
  if (normalizedAnnotations.length !== receiptEntries.length
    || new Set(normalizedAnnotations.map((row) => row.captureReceiptHash)).size !== receiptEntries.length) {
    throw new TypeError("every capture receipt requires exactly one blind annotation");
  }
  const sealedMs = Date.parse(String(annotationsSealedAt ?? ""));
  if (!Number.isFinite(sealedMs)) throw new TypeError("annotationsSealedAt must be an ISO timestamp");
  let disclosure = null;
  if (providerOutputDisclosedAt !== null) {
    const disclosureMs = Date.parse(String(providerOutputDisclosedAt));
    if (!Number.isFinite(disclosureMs) || disclosureMs <= sealedMs) {
      throw new TypeError("provider output may be disclosed only after annotation sealing");
    }
    disclosure = new Date(disclosureMs).toISOString();
  }
  const reviewerRef = opaqueRef("label", key, assertSafeId(reviewerId, "reviewerId"));
  const implementerRef = opaqueRef("label", key, assertSafeId(providerImplementerId, "providerImplementerId"));
  if (reviewerRef === implementerRef) throw new TypeError("blind reviewer must be independent from provider implementer");
  const annotationManifest = {
    schemaId: XHS_CORPUS_BLIND_ANNOTATIONS_SCHEMA_ID,
    schemaVersion: 1,
    rows: normalizedAnnotations,
  };
  const annotationManifestHash = hashStructured(annotationManifest);
  const sessionPayload = {
    schemaId: XHS_CORPUS_LABEL_SESSION_SCHEMA_ID,
    schemaVersion: 1,
    reviewer: {
      reviewerRef,
      role: "INDEPENDENT_CORPUS_REVIEWER",
      providerImplementerRef: implementerRef,
    },
    isolation: {
      providerOutputAccess: "DENIED_UNTIL_SEAL",
      providerImplementationAnswerAccess: "DENIED",
      accessAttestationHash,
    },
    inputs: {
      captureReceiptHashes: [...receiptHashes].sort(),
    },
    seal: {
      annotationsSealedAt: new Date(sealedMs).toISOString(),
      annotationManifestHash,
      providerOutputDisclosedAt: disclosure,
    },
    digestKeyId: assertSafeId(digestKeyId, "digestKeyId"),
  };
  const canonical = Buffer.from(canonicalJson(sessionPayload), "utf8");
  const labelSession = {
    ...sessionPayload,
    authentication: {
      algorithm: "HMAC-SHA256",
      payloadHash: sha256Hex(canonical),
      mac: hmacHex(key, "xhs-corpus:label-session:v1", canonical),
    },
  };
  return Object.freeze({
    annotationManifest: Object.freeze(annotationManifest),
    annotationManifestHash,
    labelSession: Object.freeze(labelSession),
    labelSessionHash: hashStructured(labelSession),
  });
}

function verifyBlindLabels({ receipts, annotationManifest, labelSession, signingKey, digestKeyId }, errors) {
  const key = normalizeHmacKey(signingKey);
  const receiptByHash = new Map(receipts.map((receipt) => [hashStructured(receipt), receipt]));
  const receiptHashes = [...receiptByHash.keys()].sort();
  if (!isPlainObject(annotationManifest)
    || annotationManifest.schemaId !== XHS_CORPUS_BLIND_ANNOTATIONS_SCHEMA_ID
    || annotationManifest.schemaVersion !== 1
    || !Array.isArray(annotationManifest.rows)) {
    issue(errors, "LABEL_ANNOTATIONS_SCHEMA_INVALID", "blind annotation manifest is invalid");
    return;
  }
  const actualAnnotationHash = hashStructured(annotationManifest);
  const payload = receiptPayload(labelSession);
  const canonical = Buffer.from(canonicalJson(payload), "utf8");
  if (!isPlainObject(labelSession)
    || labelSession.schemaId !== XHS_CORPUS_LABEL_SESSION_SCHEMA_ID
    || labelSession.schemaVersion !== 1
    || labelSession.digestKeyId !== digestKeyId
    || !hasExactKeys(labelSession.isolation, [
      "providerOutputAccess", "providerImplementationAnswerAccess", "accessAttestationHash",
    ])
    || labelSession.isolation?.providerOutputAccess !== "DENIED_UNTIL_SEAL"
    || labelSession.isolation?.providerImplementationAnswerAccess !== "DENIED"
    || !HEX_64.test(String(labelSession.isolation?.accessAttestationHash ?? ""))
    || labelSession.reviewer?.role !== "INDEPENDENT_CORPUS_REVIEWER"
    || labelSession.reviewer?.reviewerRef === labelSession.reviewer?.providerImplementerRef
    || canonicalJson(labelSession.inputs?.captureReceiptHashes ?? null) !== canonicalJson(receiptHashes)
    || labelSession.seal?.annotationManifestHash !== actualAnnotationHash) {
    issue(errors, "LABEL_SESSION_BINDING_INVALID", "label session does not bind independent sealed inputs");
  }
  const sealedMs = Date.parse(String(labelSession?.seal?.annotationsSealedAt ?? ""));
  const disclosure = labelSession?.seal?.providerOutputDisclosedAt;
  if (!Number.isFinite(sealedMs)
    || (disclosure !== null && (!Number.isFinite(Date.parse(String(disclosure)))
      || Date.parse(String(disclosure)) <= sealedMs))) {
    issue(errors, "LABEL_SESSION_ORDER_INVALID", "provider output disclosure must follow label sealing");
  }
  const auth = labelSession?.authentication;
  if (!isPlainObject(auth)
    || auth.algorithm !== "HMAC-SHA256"
    || !safeEqualHex(auth.payloadHash, sha256Hex(canonical))
    || !safeEqualHex(auth.mac, hmacHex(key, "xhs-corpus:label-session:v1", canonical))) {
    issue(errors, "LABEL_SESSION_AUTH_INVALID", "label session HMAC/content binding failed");
  }
  const annotationHashes = (annotationManifest.rows ?? []).map((row) => row?.captureReceiptHash).sort();
  if (canonicalJson(annotationHashes) !== canonicalJson(receiptHashes)) {
    issue(errors, "LABEL_ANNOTATIONS_COVERAGE_INVALID", "blind labels must cover every capture exactly once");
  }
  for (const [index, annotation] of (annotationManifest.rows ?? []).entries()) {
    try {
      normalizeAnnotation(annotation, receiptByHash, index);
    } catch (error) {
      issue(errors, "LABEL_ANNOTATION_INVALID", error.message);
    }
  }
}

function publicRowFromReceipt(receipt, receiptHash, index, key, labelSessionHash) {
  const phase = receipt.provenance.phase;
  const captureMode = receipt.captureMode;
  const countingEligible = captureMode === "CP_BOUND_R1_R2"
    && COUNTING_PHASES.has(phase)
    && receipt.classification.dumpVerdict !== "FORBIDDEN_OR_RISKY";
  return {
    id: `row-${String(index + 1).padStart(3, "0")}`,
    sourceRef: opaqueRef("src", key, `${receiptHash}:${receipt.evidence.pngHash}`),
    receiptRef: `receipt:${receiptHash}`,
    frame: {
      sha256: receipt.evidence.pngHash,
      width: receipt.evidence.width,
      height: receipt.evidence.height,
      alias: receipt.placement.alias,
    },
    pageClass: receipt.classification.pageClass,
    evaluationRole: receipt.classification.evaluationRole,
    dumpVerdict: receipt.classification.dumpVerdict,
    provenance: {
      captureMode,
      phase,
      countingEligible,
      waveRef: `wave:${receipt.provenance.waveDigest}`,
    },
    surfaceClaimRef: `surface:${receipt.provenance.surfaceClaimDigest}`,
    labelSealHash: labelSessionHash,
  };
}

function emptyCoverage() {
  return Object.fromEntries(XHS_CORPUS_REQUIRED_ROUTES.map((route) => [route, 0]));
}

function deriveDiversity(rows, errors) {
  const counts = emptyCoverage();
  const pngByRoute = Object.fromEntries(XHS_CORPUS_REQUIRED_ROUTES.map((route) => [route, new Set()]));
  const phasesByRoute = Object.fromEntries(XHS_CORPUS_REQUIRED_ROUTES.map((route) => [route, new Set()]));
  const wavesByRoute = Object.fromEntries(XHS_CORPUS_REQUIRED_ROUTES.map((route) => [route, new Set()]));
  const surfacesByRoute = Object.fromEntries(XHS_CORPUS_REQUIRED_ROUTES.map((route) => [route, new Set()]));
  const perRouteWave = new Map();
  const globalFrames = new Set();
  const globalReceipts = new Set();
  for (const row of rows) {
    if (!row?.provenance?.countingEligible) continue;
    const rowId = row.id;
    const route = row.pageClass;
    if (!XHS_CORPUS_REQUIRED_ROUTES.includes(route)) continue;
    if (globalFrames.has(row.frame.sha256)) {
      issue(errors, "CORPUS_DIVERSITY_FRAME_REPLAY", "PNG hash is duplicated across counting rows", rowId);
    }
    globalFrames.add(row.frame.sha256);
    if (globalReceipts.has(row.receiptRef)) {
      issue(errors, "CORPUS_DIVERSITY_RECEIPT_REPLAY", "capture receipt is replayed", rowId);
    }
    globalReceipts.add(row.receiptRef);
    pngByRoute[route].add(row.frame.sha256);
    phasesByRoute[route].add(row.provenance.phase);
    wavesByRoute[route].add(row.provenance.waveRef);
    surfacesByRoute[route].add(row.surfaceClaimRef);
    const waveKey = `${route}\0${row.provenance.waveRef}`;
    const waveCount = (perRouteWave.get(waveKey) ?? 0) + 1;
    perRouteWave.set(waveKey, waveCount);
    if (waveCount > 2) {
      issue(errors, "CORPUS_DIVERSITY_WAVE_OVERREPRESENTED", "one route may count at most two rows from a wave", rowId);
    }
  }
  for (const route of XHS_CORPUS_REQUIRED_ROUTES) {
    counts[route] = pngByRoute[route].size;
    if (counts[route] < 3) {
      issue(errors, "CORPUS_DIVERSITY_ROUTE_INCOMPLETE", `${route} needs three distinct R1/R2 PNG hashes`);
    }
    if (!phasesByRoute[route].has("R1") || !phasesByRoute[route].has("R2")) {
      issue(errors, "CORPUS_DIVERSITY_PHASE_INCOMPLETE", `${route} must span both R1 and R2`);
    }
    if (wavesByRoute[route].size < 2) {
      issue(errors, "CORPUS_DIVERSITY_WAVE_INCOMPLETE", `${route} must span two exact-pair wave receipts`);
    }
    if (["IMAGE_NOTE", "VIDEO_NOTE", "COMMENT_PANEL"].includes(route)
      && surfacesByRoute[route].size < 2) {
      issue(errors, "CORPUS_DIVERSITY_SURFACE_INCOMPLETE", `${route} must span two opaque surface claims`);
    }
  }
  return {
    complete: errors.filter((error) => error.code.startsWith("CORPUS_DIVERSITY_")).length === 0,
    distinctFramesByRoute: counts,
    countingRows: rows.filter((row) => row?.provenance?.countingEligible).length,
    calibrationRows: rows.filter((row) => row?.provenance?.phase === "CALIBRATION_ONLY").length,
  };
}

export function validatePublicCorpusPrivacy(manifest) {
  const errors = [];
  function walk(value, pointer = "$") {
    if (typeof value === "string") {
      if (PUBLIC_FORBIDDEN_VALUE.test(value)) {
        issue(errors, "CORPUS_PUBLIC_VALUE_FORBIDDEN", `raw/private value at ${pointer}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${pointer}[${index}]`));
      return;
    }
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (PUBLIC_FORBIDDEN_KEY.test(key)) {
        issue(errors, "CORPUS_PUBLIC_KEY_FORBIDDEN", `raw/private key at ${pointer}.${key}`);
      }
      walk(child, `${pointer}.${key}`);
    }
  }
  walk(manifest);
  return Object.freeze({ valid: errors.length === 0, errors });
}

function validatePublicRows(rows, errors) {
  const ids = new Set();
  const sources = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const rowId = row?.id ?? null;
    if (!ROW_ID.test(String(rowId ?? "")) || ids.has(rowId)) {
      issue(errors, "CORPUS_PUBLIC_ROW_ID_INVALID", "row id must be unique and opaque", rowId);
    }
    ids.add(rowId);
    if (!OPAQUE_REF.test(String(row?.sourceRef ?? "")) || sources.has(row.sourceRef)) {
      issue(errors, "CORPUS_PUBLIC_SOURCE_REF_INVALID", "sourceRef must be a unique opaque ref", rowId);
    }
    sources.add(row?.sourceRef);
    if (!OPAQUE_REF.test(String(row?.receiptRef ?? ""))
      || !OPAQUE_REF.test(String(row?.provenance?.waveRef ?? ""))
      || !OPAQUE_REF.test(String(row?.surfaceClaimRef ?? ""))) {
      issue(errors, "CORPUS_PUBLIC_OPAQUE_REF_INVALID", "receipt/wave/surface refs must be opaque", rowId);
    }
    try {
      assertRouteRole(row?.pageClass, row?.evaluationRole);
      assertFixedLane(row?.pageClass, row?.frame?.alias, row?.frame?.alias === "03" ? "FEED" : "SEARCH");
    } catch (error) {
      issue(errors, "CORPUS_PUBLIC_ROUTE_BINDING_INVALID", error.message, rowId);
    }
    if (!DUMP_VERDICTS.has(row?.dumpVerdict)
      || !CAPTURE_MODES.has(row?.provenance?.captureMode)
      || !PHASES.has(row?.provenance?.phase)
      || (row?.provenance?.captureMode === "OFFLINE_FIXTURE_ONLY"
        && row?.provenance?.phase !== "CALIBRATION_ONLY")
      || (row?.provenance?.captureMode === "CP_BOUND_R1_R2"
        && !COUNTING_PHASES.has(row?.provenance?.phase))
      || row?.provenance?.countingEligible !== (row?.provenance?.captureMode === "CP_BOUND_R1_R2"
        && COUNTING_PHASES.has(row?.provenance?.phase)
        && row?.dumpVerdict !== "FORBIDDEN_OR_RISKY")
      || !HEX_64.test(String(row?.frame?.sha256 ?? ""))
      || !HEX_64.test(String(row?.labelSealHash ?? ""))) {
      issue(errors, "CORPUS_PUBLIC_ROW_BINDING_INVALID", "row evidence/provenance binding is invalid", rowId);
    }
  }
}

export function sealCorpusBundle({
  receipts,
  annotationManifest,
  labelSession,
  signingKey,
  digestKeyId,
  expectedRuntime = null,
} = {}) {
  const key = normalizeHmacKey(signingKey);
  const errors = [];
  const entries = (Array.isArray(receipts) ? receipts : []).map((receipt) => ({
    receipt,
    verification: verifyCaptureReceipt(receipt, {
      signingKey: key,
      expectedDigestKeyId: digestKeyId,
      expectedRuntime,
    }),
  }));
  for (const entry of entries) errors.push(...entry.verification.errors);
  if (entries.length === 0) issue(errors, "CORPUS_CAPTURE_RECEIPTS_MISSING", "capture receipts are required");
  const receiptHashes = entries.map((entry) => entry.verification.receiptHash);
  if (new Set(receiptHashes).size !== receiptHashes.length) {
    issue(errors, "CORPUS_CAPTURE_RECEIPT_DUPLICATE", "capture receipt hashes must be unique");
  }
  const runtimeBinding = entries[0]?.receipt?.runtime ?? null;
  for (const entry of entries.slice(1)) {
    if (canonicalJson(entry.receipt?.runtime ?? null) !== canonicalJson(runtimeBinding)) {
      issue(errors, "CORPUS_CAPTURE_RUNTIME_MIXED", "all capture receipts must bind one exact runtime/provider/key");
    }
  }
  verifyBlindLabels({ receipts, annotationManifest, labelSession, signingKey: key, digestKeyId }, errors);
  if (errors.length > 0) return Object.freeze({ passed: false, errors });

  const labelSessionHash = hashStructured(labelSession);
  const publicRows = entries
    .sort((left, right) => left.verification.receiptHash.localeCompare(right.verification.receiptHash))
    .map((entry, index) => publicRowFromReceipt(
      entry.receipt,
      entry.verification.receiptHash,
      index,
      key,
      labelSessionHash,
    ));
  const diversityErrors = [];
  const coverage = deriveDiversity(publicRows, diversityErrors);
  const publicManifest = {
    schemaId: XHS_CORPUS_PUBLIC_MANIFEST_SCHEMA_ID,
    schemaVersion: 2,
    requiredRoutes: [...XHS_CORPUS_REQUIRED_ROUTES],
    minimumDistinctFramesPerRoute: 3,
    rows: publicRows,
    coverage,
  };
  const privacy = validatePublicCorpusPrivacy(publicManifest);
  errors.push(...diversityErrors, ...privacy.errors);
  validatePublicRows(publicRows, errors);
  const publicManifestHash = hashStructured(publicManifest);
  const privateIndex = {
    schemaId: XHS_CORPUS_PRIVATE_INDEX_SCHEMA_ID,
    schemaVersion: 1,
    publicManifestHash,
    captureReceiptHashes: receiptHashes.sort(),
    annotationManifestHash: hashStructured(annotationManifest),
    labelSessionHash,
    runtime: runtimeBinding,
  };
  const bundle = {
    schemaId: XHS_CORPUS_SEALED_BUNDLE_SCHEMA_ID,
    schemaVersion: 1,
    publicManifest,
    privateIndex,
    captureReceipts: entries.map((entry) => entry.receipt),
    annotationManifest,
    labelSession,
  };
  return Object.freeze({
    passed: errors.length === 0 && coverage.complete,
    errors,
    coverage,
    bundle: Object.freeze(bundle),
  });
}

export function validateSealedCorpusBundle(bundle, {
  signingKey,
  digestKeyId,
  expectedRuntime = null,
} = {}) {
  const errors = [];
  if (!isPlainObject(bundle)
    || bundle.schemaId !== XHS_CORPUS_SEALED_BUNDLE_SCHEMA_ID
    || bundle.schemaVersion !== 1) {
    issue(errors, "CORPUS_SEALED_BUNDLE_SCHEMA_INVALID", "sealed corpus bundle schema is invalid");
    return Object.freeze({ passed: false, errors, coverage: null });
  }
  const resealed = sealCorpusBundle({
    receipts: bundle.captureReceipts,
    annotationManifest: bundle.annotationManifest,
    labelSession: bundle.labelSession,
    signingKey,
    digestKeyId,
    expectedRuntime,
  });
  if (!resealed.bundle) return resealed;
  if (canonicalJson(resealed.bundle.publicManifest) !== canonicalJson(bundle.publicManifest)) {
    issue(errors, "CORPUS_PUBLIC_MANIFEST_DRIFT", "public manifest does not reproduce from private receipts");
  }
  if (canonicalJson(resealed.bundle.privateIndex) !== canonicalJson(bundle.privateIndex)) {
    issue(errors, "CORPUS_PRIVATE_INDEX_DRIFT", "private index does not reproduce from sealed inputs");
  }
  errors.push(...resealed.errors);
  return Object.freeze({
    passed: errors.length === 0 && resealed.coverage?.complete === true,
    errors,
    coverage: resealed.coverage,
    publicManifestHash: resealed.bundle.privateIndex.publicManifestHash,
  });
}

const TRAVERSAL_PHASES = Object.freeze(["R1", "R2"]);
const TRAVERSAL_SAFE_PAGES = new Set([
  "HOME_FEED",
  "SEARCH_HOME",
  "SEARCH_RESULTS",
  "IMAGE_NOTE",
  "VIDEO_NOTE",
  "COMMENT_PANEL",
]);
const TRAVERSAL_ZERO_SAFETY = Object.freeze({
  socialTransport: 0,
  effectTransport: 0,
  visualIssued: 0,
  visualConsumed: 0,
  visualPhysical: 0,
});
const TRAVERSAL_PLAN = Object.freeze({
  "03": Object.freeze([
    Object.freeze({ edgeId: "03-restore-home", role: "RESTORE", prePage: "HOME_FEED", postPage: "HOME_FEED", argumentKind: "NONE" }),
    Object.freeze({ edgeId: "03-scroll-feed", role: "SCROLL_FEED", prePage: "HOME_FEED", postPage: "HOME_FEED", argumentKind: "NONE" }),
    Object.freeze({ edgeId: "03-open-image-note", role: "OPEN_CONTENT_CARD", prePage: "HOME_FEED", postPage: "IMAGE_NOTE", argumentKind: "CANDIDATE" }),
    Object.freeze({ edgeId: "03-open-image-comments", role: "OPEN_COMMENT_PANEL", prePage: "IMAGE_NOTE", postPage: "COMMENT_PANEL", argumentKind: "CANDIDATE" }),
    Object.freeze({ edgeId: "03-back-to-image-note", role: "BACK", prePage: "COMMENT_PANEL", postPage: "IMAGE_NOTE", argumentKind: "NONE" }),
    Object.freeze({ edgeId: "03-back-to-feed", role: "BACK", prePage: "IMAGE_NOTE", postPage: "HOME_FEED", argumentKind: "NONE" }),
  ]),
  "04": Object.freeze([
    Object.freeze({ edgeId: "04-restore-home", role: "RESTORE", prePage: "HOME_FEED", postPage: "HOME_FEED", argumentKind: "NONE" }),
    Object.freeze({ edgeId: "04-open-search", role: "OPEN_SEARCH", prePage: "HOME_FEED", postPage: "SEARCH_HOME", argumentKind: "CANDIDATE" }),
    Object.freeze({ edgeId: "04-submit-search", role: "SUBMIT_SEARCH", prePage: "SEARCH_HOME", postPage: "SEARCH_RESULTS", argumentKind: "QUERY" }),
    Object.freeze({ edgeId: "04-scroll-results", role: "SCROLL_RESULTS", prePage: "SEARCH_RESULTS", postPage: "SEARCH_RESULTS", argumentKind: "NONE" }),
    Object.freeze({ edgeId: "04-open-video-note", role: "OPEN_CONTENT_CARD", prePage: "SEARCH_RESULTS", postPage: "VIDEO_NOTE", argumentKind: "CANDIDATE" }),
    Object.freeze({ edgeId: "04-open-video-comments", role: "OPEN_COMMENT_PANEL", prePage: "VIDEO_NOTE", postPage: "COMMENT_PANEL", argumentKind: "CANDIDATE" }),
    Object.freeze({ edgeId: "04-back-to-video-note", role: "BACK", prePage: "COMMENT_PANEL", postPage: "VIDEO_NOTE", argumentKind: "NONE" }),
    Object.freeze({ edgeId: "04-back-to-results", role: "BACK", prePage: "VIDEO_NOTE", postPage: "SEARCH_RESULTS", argumentKind: "NONE" }),
  ]),
});

function traversalReject(code, message, details = {}) {
  const error = new Error(`${code}:${message}`);
  error.code = code;
  error.validator = XHS_CORPUS_ROUTE_VALIDATOR_ID;
  error.stage = "SCENARIO_VALIDATION";
  error.details = Object.freeze({ ...details });
  throw error;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function conditionFor({ phase, alias, edgeId, position, page, role, ordinal }) {
  return {
    phase,
    alias,
    edgeId,
    position,
    page,
    verdict: "COMPLETE_SAFE_UNIQUE",
    overlayState: "SAFE",
    resolvedRole: position === "PRE" ? role : null,
    resolvedTargetDigest: position === "PRE"
      ? sha256Hex(Buffer.from(`fixture-target\0${phase}\0${alias}\0${edgeId}`, "utf8"))
      : null,
    freshNonce: sha256Hex(Buffer.from(`fixture-dump\0${phase}\0${alias}\0${edgeId}\0${position}\0${ordinal}`, "utf8")),
  };
}

function createStandardTraversalScenario() {
  const sealedQueryDigest = sha256Hex(Buffer.from("xhs-v3-p4a-sealed-query-v1", "utf8"));
  let ordinal = 0;
  return {
    schemaId: "xw.xhs.exploration-exact-pair-fixture.v1",
    schemaVersion: 1,
    phases: [...TRAVERSAL_PHASES],
    sealedQueryDigest,
    lanesByPhase: TRAVERSAL_PHASES.map((phase) => ({
      phase,
      lanes: XHS_CORPUS_EXACT_PAIR_BINDINGS.map(({ alias, laneRole }) => ({
        alias,
        laneRole,
        steps: TRAVERSAL_PLAN[alias].map((plan) => {
          ordinal += 1;
          const sealedArgumentDigest = plan.argumentKind === "QUERY"
            ? sealedQueryDigest
            : plan.argumentKind === "CANDIDATE"
              ? sha256Hex(Buffer.from(`fixture-candidate\0${phase}\0${plan.edgeId}`, "utf8"))
              : null;
          return {
            edgeId: plan.edgeId,
            navigation: {
              permitKind: "CP_TYPED_SINGLE_USE",
              source: "DUMP",
              role: plan.role,
              sealedArgumentDigest,
            },
            pre: conditionFor({
              phase,
              alias,
              edgeId: plan.edgeId,
              position: "PRE",
              page: plan.prePage,
              role: plan.role,
              ordinal,
            }),
            post: conditionFor({
              phase,
              alias,
              edgeId: plan.edgeId,
              position: "POST",
              page: plan.postPage,
              role: plan.role,
              ordinal,
            }),
          };
        }),
      })),
    })),
  };
}

function findForbiddenTraversalInput(value, pointer = "$") {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenTraversalInput(value[index], `${pointer}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!isPlainObject(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    const at = `${pointer}.${key}`;
    if (/^(?:callerAlias|requestedAlias|endpoint|baseUrl|url|host|port|providerPath|path|module|requestedRole|callerRole)$/i.test(key)) {
      return { kind: "CALLER_FIELD", pointer: at };
    }
    if (/^(?:fixtureCoverageLabels?|declaredCoverage|pageLabels?)$/i.test(key)) {
      return { kind: "FIXTURE_LABEL", pointer: at };
    }
    if (/(?:coordinate|coords|point|bounds|payload|primitive|helper|command|shell|rawAction)/i.test(key)) {
      return { kind: /coordinate|coords|point|bounds/i.test(key) ? "GEOMETRY" : "RAW_HELPER", pointer: at };
    }
    if (typeof child === "string"
      && /(?:\badb\b|22222|\binput(?:_text|\s)|\bswipe\b|\btap\b|keyevent|\bshell\b|https?:\/\/|tcp:\/\/)/i.test(child)) {
      return { kind: "RAW_HELPER", pointer: at };
    }
    const found = findForbiddenTraversalInput(child, at);
    if (found) return found;
  }
  return null;
}

function assertTraversalExactKeys(value, keys, code, pointer) {
  if (!hasExactKeys(value, keys)) {
    traversalReject(code, `${pointer} has non-canonical fields`, { pointer });
  }
}

function validateDumpCondition(condition, {
  phase,
  alias,
  edgeId,
  position,
  expectedPage,
  expectedRole,
  seenNonces,
}) {
  assertTraversalExactKeys(
    condition,
    ["phase", "alias", "edgeId", "position", "page", "verdict", "overlayState", "resolvedRole", "resolvedTargetDigest", "freshNonce"],
    "XHS_CORPUS_TRAVERSAL_DUMP_SCHEMA_INVALID",
    `${phase}/${alias}/${edgeId}/${position}`,
  );
  if (condition.phase !== phase || condition.alias !== alias
    || condition.edgeId !== edgeId || condition.position !== position) {
    traversalReject("XHS_CORPUS_TRAVERSAL_DUMP_BINDING_DRIFT", "DUMP condition changed phase/lane/edge/position", { phase, alias, edgeId, position });
  }
  if (condition.verdict === "AMBIGUOUS_SAFE" || condition.verdict === "ABSENT_OR_INVALID") {
    traversalReject("XHS_CORPUS_TRAVERSAL_DUMP_NOT_UNIQUE", "DUMP navigation is not COMPLETE_SAFE_UNIQUE", { phase, alias, edgeId, position, verdict: condition.verdict });
  }
  if (condition.verdict === "FORBIDDEN_OR_RISKY") {
    traversalReject("XHS_CORPUS_TRAVERSAL_DUMP_RISK_STOP", "forbidden/risky DUMP stops the wave", { phase, alias, edgeId, position });
  }
  if (condition.verdict !== "COMPLETE_SAFE_UNIQUE" || condition.overlayState !== "SAFE") {
    traversalReject("XHS_CORPUS_TRAVERSAL_DUMP_INVALID", "DUMP condition is not a closed safe verdict", { phase, alias, edgeId, position });
  }
  if (!TRAVERSAL_SAFE_PAGES.has(condition.page) || condition.page !== expectedPage) {
    traversalReject("XHS_CORPUS_TRAVERSAL_ROUTE_DRIFT", "DUMP page differs from the fixed route matrix", { phase, alias, edgeId, position, expectedPage, actualPage: condition.page });
  }
  if (position === "PRE") {
    if (condition.resolvedRole !== expectedRole || !HEX_64.test(String(condition.resolvedTargetDigest ?? ""))) {
      traversalReject("XHS_CORPUS_TRAVERSAL_ROLE_DRIFT", "precondition does not resolve the fixed typed DUMP role", { phase, alias, edgeId, expectedRole });
    }
  } else if (condition.resolvedRole !== null || condition.resolvedTargetDigest !== null) {
    traversalReject("XHS_CORPUS_TRAVERSAL_POST_AUTHORITY_FORBIDDEN", "postcondition may assert a page but cannot mint the next action", { phase, alias, edgeId });
  }
  if (!HEX_64.test(String(condition.freshNonce ?? "")) || seenNonces.has(condition.freshNonce)) {
    traversalReject("XHS_CORPUS_TRAVERSAL_DUMP_NOT_FRESH", "pre/post DUMP nonce is absent or replayed", { phase, alias, edgeId, position });
  }
  seenNonces.add(condition.freshNonce);
}

/**
 * Production-shaped validator for the offline exact-pair trace. The complete
 * two-phase trace is validated before the fake acquire barrier or any fake
 * transition reservation. Fixture page labels and provider output are not an
 * accepted authority channel.
 */
export function validateExactPairTraversalScenario(input) {
  const forbidden = findForbiddenTraversalInput(input);
  if (forbidden?.kind === "CALLER_FIELD") {
    traversalReject("XHS_CORPUS_TRAVERSAL_CALLER_FIELD_FORBIDDEN", "caller-selected alias/endpoint/path/module/role is forbidden", forbidden);
  }
  if (forbidden?.kind === "FIXTURE_LABEL") {
    traversalReject("XHS_CORPUS_TRAVERSAL_FIXTURE_LABEL_AUTHORITY_FORBIDDEN", "fixture labels cannot satisfy route coverage", forbidden);
  }
  if (forbidden?.kind === "GEOMETRY") {
    traversalReject("XHS_CORPUS_TRAVERSAL_CALLER_GEOMETRY_FORBIDDEN", "caller coordinates/geometry are forbidden", forbidden);
  }
  if (forbidden?.kind === "RAW_HELPER") {
    traversalReject("XHS_CORPUS_TRAVERSAL_RAW_HELPER_FORBIDDEN", "raw ADB/22222/tap/swipe/input/back helpers are forbidden", forbidden);
  }
  assertTraversalExactKeys(
    input,
    ["schemaId", "schemaVersion", "phases", "sealedQueryDigest", "lanesByPhase"],
    "XHS_CORPUS_TRAVERSAL_SCHEMA_INVALID",
    "$",
  );
  if (input.schemaId !== "xw.xhs.exploration-exact-pair-fixture.v1" || input.schemaVersion !== 1
    || canonicalJson(input.phases) !== canonicalJson(TRAVERSAL_PHASES)
    || !HEX_64.test(String(input.sealedQueryDigest ?? ""))
    || !Array.isArray(input.lanesByPhase) || input.lanesByPhase.length !== 2) {
    traversalReject("XHS_CORPUS_TRAVERSAL_SCHEMA_INVALID", "exact R1/R2 traversal header is invalid");
  }
  const seenNonces = new Set();
  for (let phaseIndex = 0; phaseIndex < TRAVERSAL_PHASES.length; phaseIndex += 1) {
    const phase = TRAVERSAL_PHASES[phaseIndex];
    const wave = input.lanesByPhase[phaseIndex];
    assertTraversalExactKeys(wave, ["phase", "lanes"], "XHS_CORPUS_TRAVERSAL_WAVE_SCHEMA_INVALID", `$.lanesByPhase[${phaseIndex}]`);
    if (wave.phase !== phase || !Array.isArray(wave.lanes) || wave.lanes.length !== 2) {
      traversalReject("XHS_CORPUS_TRAVERSAL_WAVE_SCHEMA_INVALID", "wave must bind the exact R1/R2 phase and two lanes", { phase });
    }
    for (let laneIndex = 0; laneIndex < XHS_CORPUS_EXACT_PAIR_BINDINGS.length; laneIndex += 1) {
      const binding = XHS_CORPUS_EXACT_PAIR_BINDINGS[laneIndex];
      const lane = wave.lanes[laneIndex];
      assertTraversalExactKeys(lane, ["alias", "laneRole", "steps"], "XHS_CORPUS_TRAVERSAL_LANE_SCHEMA_INVALID", `${phase}/lane[${laneIndex}]`);
      if (lane.alias !== binding.alias || lane.laneRole !== binding.laneRole) {
        traversalReject("XHS_CORPUS_TRAVERSAL_LANE_DRIFT", "lane assignments must remain exactly 03=FEED and 04=SEARCH", { phase, laneIndex });
      }
      const plans = TRAVERSAL_PLAN[binding.alias];
      if (!Array.isArray(lane.steps) || lane.steps.length !== plans.length) {
        traversalReject("XHS_CORPUS_TRAVERSAL_ROUTE_MATRIX_INCOMPLETE", "lane step count differs from the fixed route matrix", { phase, alias: binding.alias });
      }
      for (let stepIndex = 0; stepIndex < plans.length; stepIndex += 1) {
        const plan = plans[stepIndex];
        const step = lane.steps[stepIndex];
        assertTraversalExactKeys(step, ["edgeId", "navigation", "pre", "post"], "XHS_CORPUS_TRAVERSAL_EDGE_SCHEMA_INVALID", `${phase}/${binding.alias}/step[${stepIndex}]`);
        assertTraversalExactKeys(step.navigation, ["permitKind", "source", "role", "sealedArgumentDigest"], "XHS_CORPUS_TRAVERSAL_NAVIGATION_SCHEMA_INVALID", `${phase}/${binding.alias}/${plan.edgeId}/navigation`);
        if (step.edgeId !== plan.edgeId) {
          traversalReject("XHS_CORPUS_TRAVERSAL_ROUTE_MATRIX_DRIFT", "edge order/id differs from the fixed route matrix", { phase, alias: binding.alias, stepIndex });
        }
        if (step.navigation.permitKind !== "CP_TYPED_SINGLE_USE") {
          traversalReject("XHS_CORPUS_TRAVERSAL_PERMIT_KIND_INVALID", "navigation must use a typed single-use CP permit", { phase, alias: binding.alias, edgeId: plan.edgeId });
        }
        if (step.navigation.source !== "DUMP") {
          traversalReject("XHS_CORPUS_TRAVERSAL_PROVIDER_AUTHORITY_FORBIDDEN", "only typed DUMP may source R1/R2 navigation", { phase, alias: binding.alias, edgeId: plan.edgeId, source: step.navigation.source });
        }
        if (!XHS_CORPUS_TYPED_DUMP_ROLES.includes(step.navigation.role)
          || step.navigation.role !== plan.role) {
          traversalReject("XHS_CORPUS_TRAVERSAL_ROLE_DRIFT", "navigation role differs from the fixed typed CP role", { phase, alias: binding.alias, edgeId: plan.edgeId, expectedRole: plan.role });
        }
        if (plan.argumentKind === "QUERY") {
          if (step.navigation.sealedArgumentDigest !== input.sealedQueryDigest) {
            traversalReject("XHS_CORPUS_TRAVERSAL_QUERY_DRIFT", "SUBMIT_SEARCH must use the exact sealed query digest", { phase, alias: binding.alias, edgeId: plan.edgeId });
          }
        } else if (plan.argumentKind === "CANDIDATE") {
          if (!HEX_64.test(String(step.navigation.sealedArgumentDigest ?? ""))) {
            traversalReject("XHS_CORPUS_TRAVERSAL_CANDIDATE_UNBOUND", "DUMP-resolved transition requires an opaque candidate digest", { phase, alias: binding.alias, edgeId: plan.edgeId });
          }
        } else if (step.navigation.sealedArgumentDigest !== null) {
          traversalReject("XHS_CORPUS_TRAVERSAL_ARGUMENT_FORBIDDEN", "this typed transition accepts no caller argument", { phase, alias: binding.alias, edgeId: plan.edgeId });
        }
        validateDumpCondition(step.pre, {
          phase,
          alias: binding.alias,
          edgeId: plan.edgeId,
          position: "PRE",
          expectedPage: plan.prePage,
          expectedRole: plan.role,
          seenNonces,
        });
        validateDumpCondition(step.post, {
          phase,
          alias: binding.alias,
          edgeId: plan.edgeId,
          position: "POST",
          expectedPage: plan.postPage,
          expectedRole: plan.role,
          seenNonces,
        });
      }
    }
  }
  const normalized = cloneJson(input);
  return deepFreeze({
    validatorId: XHS_CORPUS_ROUTE_VALIDATOR_ID,
    scenarioHash: hashStructured(normalized),
    scenario: normalized,
  });
}

function createFixtureTraversalState() {
  const scenario = createStandardTraversalScenario();
  const audit = {
    scenarioReads: 0,
    acquireBarriers: 0,
    reservations: 0,
    commits: 0,
    releases: 0,
    releaseAttempts: [],
  };
  const active = new Map();
  const tokens = new WeakSet();
  return {
    async readExactPairTraversal() {
      audit.scenarioReads += 1;
      return cloneJson(scenario);
    },
    async openExactPairBarrier({ phase, scenarioHash, bindings }) {
      audit.acquireBarriers += 1;
      if (!TRAVERSAL_PHASES.includes(phase)
        || !HEX_64.test(String(scenarioHash ?? ""))
        || canonicalJson(bindings) !== canonicalJson(XHS_CORPUS_EXACT_PAIR_BINDINGS)) {
        throw new Error("XHS_CORPUS_FAKE_BARRIER_BINDING_INVALID");
      }
      const authorityDigest = sha256Hex(Buffer.from(`fake-authority\0${phase}\0${scenarioHash}`, "utf8"));
      active.set(phase, new Map([
        ["03", TRAVERSAL_PLAN["03"][0].prePage],
        ["04", TRAVERSAL_PLAN["04"][0].prePage],
      ]));
      return deepFreeze({
        mode: "FAKE_EXACT_PAIR",
        phase,
        bindings: cloneJson(XHS_CORPUS_EXACT_PAIR_BINDINGS),
        authorityDigest,
        barrierDigest: hashStructured({ phase, bindings, authorityDigest, scenarioHash }),
      });
    },
    async reserveTypedTransition(proposal) {
      audit.reservations += 1;
      if (proposal?.validatorId !== XHS_CORPUS_ROUTE_VALIDATOR_ID
        || !HEX_64.test(String(proposal?.preconditionReceiptHash ?? ""))
        || proposal?.permitKind !== "CP_TYPED_SINGLE_USE"
        || proposal?.source !== "DUMP") {
        throw new Error("XHS_CORPUS_FAKE_RESERVATION_UNVALIDATED");
      }
      const token = Object.freeze({
        proposal,
        reservationDigest: hashStructured({
          proposal,
          reservationOrdinal: audit.reservations,
        }),
      });
      tokens.add(token);
      return token;
    },
    async commitTypedTransition(token) {
      if (!tokens.has(token)) throw new Error("XHS_CORPUS_FAKE_RESERVATION_TOKEN_INVALID");
      tokens.delete(token);
      const pages = active.get(token.proposal.phase);
      if (!pages || pages.get(token.proposal.alias) !== token.proposal.prePage) {
        throw new Error("XHS_CORPUS_FAKE_PRECONDITION_STATE_DRIFT");
      }
      pages.set(token.proposal.alias, token.proposal.postPage);
      audit.commits += 1;
      return deepFreeze({
        observedPage: token.proposal.postPage,
        reservationDigest: token.reservationDigest,
      });
    },
    async releaseExactPairLane({ phase, alias, authorityDigest }) {
      audit.releases += 1;
      audit.releaseAttempts.push({ phase, alias });
      if (!active.has(phase) || !HEX_64.test(String(authorityDigest ?? ""))) {
        throw new Error("XHS_CORPUS_FAKE_RELEASE_BINDING_INVALID");
      }
      return { alias, status: "RELEASED" };
    },
    snapshotTraversalAudit() {
      return cloneJson(audit);
    },
  };
}

function validateTraversalAdapterShape(adapter) {
  validateOfflineAdapterShape(adapter);
  for (const method of [
    "readExactPairTraversal",
    "openExactPairBarrier",
    "reserveTypedTransition",
    "commitTypedTransition",
    "releaseExactPairLane",
    "snapshotTraversalAudit",
  ]) {
    if (typeof adapter[method] !== "function") {
      throw new Error(`XHS_CORPUS_EXACT_PAIR_FAKE_ADAPTER_REQUIRED:${method}`);
    }
  }
}

function authenticatedArtifact(payload, { key, keyId, domain }) {
  const canonical = Buffer.from(canonicalJson(payload), "utf8");
  return deepFreeze({
    ...payload,
    authentication: {
      algorithm: "HMAC-SHA256",
      digestKeyId: keyId,
      payloadHash: sha256Hex(canonical),
      mac: hmacHex(key, domain, canonical),
    },
  });
}

function artifactHash(artifact) {
  return hashStructured(artifact);
}

function buildDumpConditionArtifact(condition, {
  authorityDigest,
  barrierDigest,
  ordinal,
  key,
  keyId,
}) {
  return authenticatedArtifact({
    schemaId: XHS_CORPUS_DUMP_RECEIPT_SCHEMA_ID,
    schemaVersion: 1,
    validatorId: XHS_CORPUS_ROUTE_VALIDATOR_ID,
    phase: condition.phase,
    alias: condition.alias,
    laneRole: condition.alias === "03" ? "FEED" : "SEARCH",
    edgeId: condition.edgeId,
    position: condition.position,
    sequence: ordinal,
    page: condition.page,
    verdict: condition.verdict,
    overlayState: condition.overlayState,
    resolvedRole: condition.resolvedRole,
    resolvedTargetDigest: condition.resolvedTargetDigest,
    freshNonce: condition.freshNonce,
    authorityDigest,
    barrierDigest,
    safety: { ...TRAVERSAL_ZERO_SAFETY },
  }, {
    key,
    keyId,
    domain: "xhs-corpus:dump-condition-receipt:v1",
  });
}

function buildTransitionArtifact({
  phase,
  alias,
  laneRole,
  edgeId,
  navigation,
  precondition,
  postcondition,
  reservationDigest,
  authorityDigest,
  barrierDigest,
  sequence,
  key,
  keyId,
}) {
  return authenticatedArtifact({
    schemaId: XHS_CORPUS_TRANSITION_RECEIPT_SCHEMA_ID,
    schemaVersion: 1,
    validatorId: XHS_CORPUS_ROUTE_VALIDATOR_ID,
    phase,
    alias,
    laneRole,
    edgeId,
    sequence,
    navigation: {
      permitKind: "CP_TYPED_SINGLE_USE",
      source: "DUMP",
      role: navigation.role,
      sealedArgumentDigest: navigation.sealedArgumentDigest,
    },
    preconditionReceiptHash: artifactHash(precondition),
    postconditionReceiptHash: artifactHash(postcondition),
    reservationDigest,
    authorityDigest,
    barrierDigest,
    safety: { ...TRAVERSAL_ZERO_SAFETY },
  }, {
    key,
    keyId,
    domain: "xhs-corpus:dump-transition-receipt:v1",
  });
}

export function verifyExactPairTransitionReceipt(receipt, {
  signingKey,
  digestKeyId,
} = {}) {
  const key = normalizeHmacKey(signingKey);
  const errors = [];
  const payload = receiptPayload(receipt);
  const canonical = Buffer.from(canonicalJson(payload), "utf8");
  if (!isPlainObject(receipt)
    || receipt.schemaId !== XHS_CORPUS_TRANSITION_RECEIPT_SCHEMA_ID
    || receipt.schemaVersion !== 1
    || receipt.validatorId !== XHS_CORPUS_ROUTE_VALIDATOR_ID
    || receipt.navigation?.permitKind !== "CP_TYPED_SINGLE_USE"
    || receipt.navigation?.source !== "DUMP"
    || !XHS_CORPUS_TYPED_DUMP_ROLES.includes(receipt.navigation?.role)
    || !TRAVERSAL_PHASES.includes(receipt.phase)
    || !XHS_CORPUS_EXACT_PAIR_BINDINGS.some((binding) => binding.alias === receipt.alias && binding.laneRole === receipt.laneRole)
    || Object.values(receipt.safety ?? {}).some((value) => value !== 0)) {
    errors.push({ code: "XHS_CORPUS_TRANSITION_RECEIPT_SCHEMA_INVALID" });
  }
  const auth = receipt?.authentication;
  if (!hasExactKeys(auth, ["algorithm", "digestKeyId", "payloadHash", "mac"])
    || auth.algorithm !== "HMAC-SHA256"
    || auth.digestKeyId !== digestKeyId
    || !safeEqualHex(auth.payloadHash, sha256Hex(canonical))
    || !safeEqualHex(auth.mac, hmacHex(key, "xhs-corpus:dump-transition-receipt:v1", canonical))) {
    errors.push({ code: "XHS_CORPUS_TRANSITION_RECEIPT_AUTH_INVALID" });
  }
  return deepFreeze({ valid: errors.length === 0, errors, receiptHash: artifactHash(receipt) });
}

function buildLaneJournal({ phase, lane, transitions, acquire, key, keyId }) {
  const transitionReceiptHashes = transitions.map((entry) => artifactHash(entry.receipt));
  return authenticatedArtifact({
    schemaId: XHS_CORPUS_LANE_JOURNAL_SCHEMA_ID,
    schemaVersion: 1,
    phase,
    alias: lane.alias,
    laneRole: lane.laneRole,
    authorityDigest: acquire.authorityDigest,
    barrierDigest: acquire.barrierDigest,
    status: "COMMITTED",
    transitionReceiptHashes,
    transitionCount: transitionReceiptHashes.length,
    safety: { ...TRAVERSAL_ZERO_SAFETY },
  }, {
    key,
    keyId,
    domain: "xhs-corpus:offline-lane-journal:v1",
  });
}

function routeAdmissibleFromTransition(entry) {
  const page = entry.postcondition.page;
  if (!XHS_CORPUS_REQUIRED_ROUTES.includes(page)) return false;
  if (page === "HOME_FEED") return entry.receipt.alias === "03";
  if (page === "SEARCH_RESULTS") return entry.receipt.alias === "04";
  return true;
}

/**
 * Execute the sealed R1 and R2 fake traversal. This is deliberately separate
 * from readFixtureCaptures(): route coverage is derived only from committed,
 * authenticated transition receipts.
 */
export async function executeExactPairFixtureTraversal({
  adapter,
  signingKey,
  digestKeyId,
} = {}) {
  validateTraversalAdapterShape(adapter);
  const key = normalizeHmacKey(signingKey);
  const keyId = assertSafeId(digestKeyId, "digestKeyId");
  assertOfflineZeroResources(adapter.snapshotResources(), "traverse:entry");
  const rawScenario = await adapter.readExactPairTraversal();
  const validated = validateExactPairTraversalScenario(rawScenario);
  assertOfflineZeroResources(adapter.snapshotResources(), "traverse:validated-before-barrier");
  const waves = [];
  let dumpOrdinal = 0;
  let transitionOrdinal = 0;

  for (const wave of validated.scenario.lanesByPhase) {
    const acquire = await adapter.openExactPairBarrier({
      phase: wave.phase,
      scenarioHash: validated.scenarioHash,
      bindings: XHS_CORPUS_EXACT_PAIR_BINDINGS,
    });
    if (!isPlainObject(acquire)
      || acquire.mode !== "FAKE_EXACT_PAIR"
      || acquire.phase !== wave.phase
      || canonicalJson(acquire.bindings) !== canonicalJson(XHS_CORPUS_EXACT_PAIR_BINDINGS)
      || !HEX_64.test(String(acquire.authorityDigest ?? ""))
      || !HEX_64.test(String(acquire.barrierDigest ?? ""))) {
      throw new Error("XHS_CORPUS_FAKE_BARRIER_RECEIPT_INVALID");
    }
    const laneResults = [];
    let cleanupResults = [];
    try {
      const settled = await Promise.allSettled(wave.lanes.map(async (lane) => {
        const transitions = [];
        for (const step of lane.steps) {
          dumpOrdinal += 1;
          const precondition = buildDumpConditionArtifact(step.pre, {
            authorityDigest: acquire.authorityDigest,
            barrierDigest: acquire.barrierDigest,
            ordinal: dumpOrdinal,
            key,
            keyId,
          });
          const proposal = deepFreeze({
            validatorId: XHS_CORPUS_ROUTE_VALIDATOR_ID,
            phase: wave.phase,
            alias: lane.alias,
            laneRole: lane.laneRole,
            edgeId: step.edgeId,
            source: "DUMP",
            permitKind: "CP_TYPED_SINGLE_USE",
            role: step.navigation.role,
            prePage: step.pre.page,
            postPage: step.post.page,
            preconditionReceiptHash: artifactHash(precondition),
            authorityDigest: acquire.authorityDigest,
            barrierDigest: acquire.barrierDigest,
          });
          const token = await adapter.reserveTypedTransition(proposal);
          const committed = await adapter.commitTypedTransition(token);
          if (committed?.observedPage !== step.post.page
            || committed?.reservationDigest !== token?.reservationDigest) {
            throw new Error("XHS_CORPUS_FAKE_COMMIT_POSTCONDITION_DRIFT");
          }
          dumpOrdinal += 1;
          const postcondition = buildDumpConditionArtifact(step.post, {
            authorityDigest: acquire.authorityDigest,
            barrierDigest: acquire.barrierDigest,
            ordinal: dumpOrdinal,
            key,
            keyId,
          });
          transitionOrdinal += 1;
          const receipt = buildTransitionArtifact({
            phase: wave.phase,
            alias: lane.alias,
            laneRole: lane.laneRole,
            edgeId: step.edgeId,
            navigation: step.navigation,
            precondition,
            postcondition,
            reservationDigest: token.reservationDigest,
            authorityDigest: acquire.authorityDigest,
            barrierDigest: acquire.barrierDigest,
            sequence: transitionOrdinal,
            key,
            keyId,
          });
          const verified = verifyExactPairTransitionReceipt(receipt, {
            signingKey: key,
            digestKeyId: keyId,
          });
          if (!verified.valid) throw new Error("XHS_CORPUS_TRANSITION_RECEIPT_SELF_CHECK_FAILED");
          transitions.push(deepFreeze({ precondition, postcondition, receipt }));
        }
        const journal = buildLaneJournal({ phase: wave.phase, lane, transitions, acquire, key, keyId });
        return deepFreeze({
          alias: lane.alias,
          laneRole: lane.laneRole,
          status: "COMMITTED",
          transitions,
          journal,
          journalHash: artifactHash(journal),
        });
      }));
      laneResults.push(...settled);
    } finally {
      cleanupResults = await Promise.allSettled(XHS_CORPUS_EXACT_PAIR_BINDINGS.map((binding) => (
        adapter.releaseExactPairLane({
          phase: wave.phase,
          alias: binding.alias,
          authorityDigest: acquire.authorityDigest,
        })
      )));
    }
    const cleanup = deepFreeze({
      mode: "PROMISE_ALL_SETTLED",
      allSettled: cleanupResults.length === 2,
      lanes: cleanupResults.map((result, index) => ({
        alias: XHS_CORPUS_EXACT_PAIR_BINDINGS[index].alias,
        status: result.status === "fulfilled" && result.value?.status === "RELEASED"
          ? "RELEASED"
          : "RELEASE_FAILED",
      })),
    });
    const laneFailure = laneResults.find((result) => result.status === "rejected");
    const cleanupFailure = cleanup.lanes.find((lane) => lane.status !== "RELEASED");
    if (laneFailure || cleanupFailure) {
      const error = laneFailure?.reason instanceof Error
        ? laneFailure.reason
        : new Error("XHS_CORPUS_EXACT_PAIR_CLEANUP_FAILED");
      error.cleanup = cleanup;
      error.laneSettled = laneResults.map((result, index) => ({
        alias: XHS_CORPUS_EXACT_PAIR_BINDINGS[index].alias,
        status: result.status,
      }));
      throw error;
    }
    const committedLanes = laneResults.map((result) => result.value);
    if (committedLanes.some((lane) => lane.status !== "COMMITTED")) {
      throw new Error("XHS_CORPUS_LANE_JOURNAL_UNCOMMITTED");
    }
    waves.push(deepFreeze({
      phase: wave.phase,
      authorityDigest: acquire.authorityDigest,
      barrierDigest: acquire.barrierDigest,
      lanes: committedLanes,
      cleanup,
      safety: { ...TRAVERSAL_ZERO_SAFETY },
    }));
    assertOfflineZeroResources(adapter.snapshotResources(), `traverse:${wave.phase}:after-cleanup`);
  }

  const routeReceiptHashes = Object.fromEntries(
    XHS_CORPUS_REQUIRED_ROUTES.map((route) => [route, []]),
  );
  for (const wave of waves) {
    for (const lane of wave.lanes) {
      if (lane.status !== "COMMITTED") continue;
      for (const transition of lane.transitions) {
        if (routeAdmissibleFromTransition(transition)) {
          routeReceiptHashes[transition.postcondition.page].push(artifactHash(transition.receipt));
        }
      }
    }
  }
  const reachedRoutes = XHS_CORPUS_REQUIRED_ROUTES.filter((route) => routeReceiptHashes[route].length > 0);
  if (canonicalJson(reachedRoutes) !== canonicalJson(XHS_CORPUS_REQUIRED_ROUTES)) {
    throw new Error(`XHS_CORPUS_TRAVERSAL_ROUTE_COVERAGE_INCOMPLETE:${reachedRoutes.join(",")}`);
  }
  return deepFreeze({
    passed: true,
    validatorId: XHS_CORPUS_ROUTE_VALIDATOR_ID,
    scenarioHash: validated.scenarioHash,
    phases: [...TRAVERSAL_PHASES],
    exactPairBindings: cloneJson(XHS_CORPUS_EXACT_PAIR_BINDINGS),
    coverage: {
      complete: true,
      reachedRoutes,
      evidenceSource: "COMMITTED_TRANSITION_RECEIPTS_ONLY",
      fixtureLabelsAccepted: false,
      routeReceiptHashes,
    },
    waves,
    safety: { ...TRAVERSAL_ZERO_SAFETY },
    resources: { ...XHS_CORPUS_ZERO_RESOURCES },
    audit: adapter.snapshotTraversalAudit(),
  });
}

function freezeResult(command, result, resources) {
  return Object.freeze({
    schemaId: "xw.xhs.exploration-corpus-offline-command-result.v1",
    schemaVersion: 1,
    command,
    mode: "OFFLINE_FIXTURE_ONLY",
    resources: Object.freeze({ ...resources }),
    ...result,
  });
}

/**
 * P4A entry point. Every command is wrapped by the local fixture resource
 * oracle. There is deliberately no production endpoint, HTTP client, device
 * transport, job/session acquisition, or dynamic adapter/module selection.
 */
export function createOfflineCorpusOperator({
  adapter,
  signingKey,
  digestKeyId,
  expectedRuntime = null,
} = {}) {
  validateOfflineAdapterShape(adapter);
  const key = normalizeHmacKey(signingKey);
  const keyId = assertSafeId(digestKeyId, "digestKeyId");

  async function run(command, input = {}) {
    if (!new Set(["preflight", "traverse", "capture", "seal", "evaluate"]).has(command)) {
      throw new Error(`XHS_CORPUS_COMMAND_INVALID:${command}`);
    }
    const before = assertOfflineZeroResources(adapter.snapshotResources(), `${command}:before`);
    try {
      let result;
      if (command === "preflight") {
        result = {
          passed: true,
          capabilities: Object.freeze(["preflight", "traverse", "capture", "seal", "evaluate"]),
          productionWiring: false,
        };
      } else if (command === "traverse") {
        result = await executeExactPairFixtureTraversal({
          adapter,
          signingKey: key,
          digestKeyId: keyId,
        });
      } else if (command === "capture") {
        const captures = await adapter.readFixtureCaptures();
        if (!Array.isArray(captures)) throw new Error("XHS_CORPUS_FIXTURE_CAPTURE_LIST_INVALID");
        result = {
          passed: true,
          receipts: captures.map((capture) => buildOfflineFixtureCaptureReceipt(capture, {
            signingKey: key,
            digestKeyId: keyId,
          })),
        };
      } else if (command === "seal") {
        const sealed = sealCorpusBundle({
          receipts: input.receipts,
          annotationManifest: input.annotationManifest,
          labelSession: input.labelSession,
          signingKey: key,
          digestKeyId: keyId,
          expectedRuntime,
        });
        result = sealed;
      } else {
        result = validateSealedCorpusBundle(input.bundle, {
          signingKey: key,
          digestKeyId: keyId,
          expectedRuntime,
        });
      }
      const after = assertOfflineZeroResources(adapter.snapshotResources(), `${command}:after`);
      return freezeResult(command, result, after);
    } catch (error) {
      assertOfflineZeroResources(adapter.snapshotResources(), `${command}:failure`);
      throw error;
    } finally {
      assertOfflineZeroResources(adapter.snapshotResources(), `${command}:finally`);
      assertOfflineZeroResources(before, `${command}:before-proof`);
    }
  }

  return Object.freeze({
    mode: "OFFLINE_FIXTURE_ONLY",
    preflight: (input) => run("preflight", input),
    traverse: (input) => run("traverse", input),
    capture: (input) => run("capture", input),
    seal: (input) => run("seal", input),
    evaluate: (input) => run("evaluate", input),
  });
}
