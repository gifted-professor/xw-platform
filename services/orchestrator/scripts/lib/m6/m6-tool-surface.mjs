// Static tool-call surface validation for the M6 model-facing tool bridge.
// Every tool has a closed parameter spec: exact required keys, no additional keys,
// and per-value type/format checks (opaque refs, 64-hex ids, bounded text/arrays).
// On top of that, a recursive forbidden scan rejects raw coordinates, ADB transport,
// shell, URLs, tokens, lease mutation, DB access, payment values/credentials and raw
// screenshot base64 — key names are normalized (NFKC, lowercase, separators stripped)
// before matching so snake_case/camelCase/kebab variants like payment_value, adbPort
// or adb-port cannot slip through. Pure functions only: deterministic, no IO.
import { fail } from "./m6-contracts.mjs";

// The eight tool classes from the M6 task brief §6. Tests must import this constant
// rather than restating tool name strings.
export const M6_TOOL_CLASSES = Object.freeze([
  "phone_observe",
  "phone_ground",
  "phone_act",
  "phone_verify",
  "checkpoint_save",
  "trace_query",
  "wait_human",
  "worker_lifecycle",
]);

const OPAQUE_REF_PATTERN = /^[a-z0-9][a-z0-9:_-]{7,127}$/;
const HASH64_PATTERN = /^[0-9a-f]{64}$/;
const INTENT_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;
const OUTCOMES = Object.freeze(["SUCCEEDED", "FAILED", "AMBIGUOUS"]);

function checkField(kind, value, path, errors, code) {
  switch (kind) {
    case "opaqueRef":
      if (typeof value !== "string" || !OPAQUE_REF_PATTERN.test(value)) {
        fail(errors, code, `${path} must be an opaque ref matching ${OPAQUE_REF_PATTERN}`);
      }
      break;
    case "hash64":
      if (typeof value !== "string" || !HASH64_PATTERN.test(value)) {
        fail(errors, code, `${path} must be a 64-char lowercase hex hash`);
      }
      break;
    case "intent":
      if (typeof value !== "string" || !INTENT_PATTERN.test(value)) {
        fail(errors, code, `${path} must be an intent token matching ${INTENT_PATTERN}`);
      }
      break;
    case "text":
      if (typeof value !== "string" || value.length < 1 || value.length > 500) {
        fail(errors, code, `${path} must be a string of 1..500 chars`);
      }
      break;
    case "refArray":
      if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
        fail(errors, code, `${path} must be an array of 1..100 opaque refs`);
        break;
      }
      value.forEach((item, index) => checkField("opaqueRef", item, `${path}[${index}]`, errors, code));
      break;
    case "outcome":
      if (!OUTCOMES.includes(value)) {
        fail(errors, code, `${path} must be one of ${OUTCOMES.join("|")}`);
      }
      break;
    default:
      fail(errors, code, `${path}: unknown field kind ${kind}`);
  }
}

// Closed per-tool parameter specs: every listed key is required, no others allowed.
const TOOL_ARG_SPECS = Object.freeze({
  phone_observe: Object.freeze({ sessionRef: "opaqueRef" }),
  phone_ground: Object.freeze({ frameRef: "hash64", blockId: "hash64", intent: "intent" }),
  phone_act: Object.freeze({ groundingDecisionRef: "hash64", operationKey: "opaqueRef" }),
  phone_verify: Object.freeze({ actionReceiptRef: "opaqueRef", expectation: "text" }),
  checkpoint_save: Object.freeze({ stateRefs: "refArray" }),
  trace_query: Object.freeze({ traceId: "opaqueRef" }),
  wait_human: Object.freeze({ reason: "text", evidenceRefs: "refArray" }),
  worker_start: Object.freeze({ workerRunRef: "opaqueRef" }),
  worker_continue: Object.freeze({ workerRunRef: "opaqueRef", checkpointRef: "opaqueRef" }),
  worker_complete: Object.freeze({ workerRunRef: "opaqueRef", outcome: "outcome" }),
});

export const M6_TOOL_SURFACE = Object.freeze(
  Object.fromEntries(Object.entries(TOOL_ARG_SPECS).map(([tool, spec]) => [tool, Object.freeze(Object.keys(spec))])),
);

export const M6_TOOL_NAMES = Object.freeze(Object.keys(TOOL_ARG_SPECS));

// Forbidden key detection after normalization (NFKC → lowercase → strip -/_):
// exact matches catch bare coordinate keys, the pattern catches x1/y2-style pairs,
// and substring terms catch every separator/casing variant (payment_value, adbPort…).
const FORBIDDEN_EXACT_KEYS = new Set(["x", "y", "px", "py"]);
const FORBIDDEN_COORD_KEY = /^[xy]\d*([xy]\d*)?$/;
const FORBIDDEN_KEY_PARTS = Object.freeze([
  "coordinate", "normalized", "bounds", "rect",
  "adb", "serial", "server", "port",
  "shell", "cmd", "command", "exec",
  "url", "http", "endpoint",
  "token", "secret", "password", "credential", "cookie",
  "lease",
  "db", "sql", "database", "query",
  "payment", "amount", "price", "cardnumber",
  "base64", "screenshot",
]);

const HTTP_URL_PATTERN = /^https?:\/\//i;
const ADB_SERIAL_PATTERN = /^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/;
const BASE64_BLOB_PATTERN = /^[A-Za-z0-9+/=]{512,}$/;

function normalizeKey(key) {
  return String(key).normalize("NFKC").toLowerCase().replace(/[-_]/g, "");
}

function isForbiddenKey(key) {
  const normalized = normalizeKey(key);
  if (FORBIDDEN_EXACT_KEYS.has(normalized)) return true;
  if (FORBIDDEN_COORD_KEY.test(normalized)) return true;
  return FORBIDDEN_KEY_PARTS.some((part) => normalized.includes(part));
}

function scanForbidden(value, path, errors, code) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbidden(item, `${path}[${index}]`, errors, code));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (isForbiddenKey(key)) {
        fail(errors, code, `forbidden field at ${path}: ${key}`);
        continue;
      }
      scanForbidden(child, `${path}.${key}`, errors, code);
    }
    return;
  }
  if (typeof value === "string") {
    if (HTTP_URL_PATTERN.test(value)) fail(errors, code, `forbidden HTTP URL value at ${path}`);
    if (ADB_SERIAL_PATTERN.test(value)) fail(errors, code, `forbidden ADB serial value at ${path}`);
    if (BASE64_BLOB_PATTERN.test(value)) fail(errors, code, `forbidden raw base64 blob at ${path}`);
  }
}

export function validateToolCall({ tool, args } = {}) {
  const code = "INVALID_M6_TOOL_CALL";
  const errors = [];
  if (typeof tool !== "string" || !M6_TOOL_NAMES.includes(tool)) {
    fail(errors, code, `tool is not in the M6 tool allowlist: ${tool}`);
    return { ok: false, errors };
  }
  const spec = TOOL_ARG_SPECS[tool];
  const actualArgs = args === undefined ? {} : args;
  if (!actualArgs || typeof actualArgs !== "object" || Array.isArray(actualArgs)) {
    fail(errors, code, "args must be an object");
    return { ok: false, errors };
  }
  for (const key of Object.keys(spec)) {
    if (actualArgs[key] === undefined) fail(errors, code, `missing required argument for ${tool}: ${key}`);
  }
  for (const key of Object.keys(actualArgs)) {
    if (!Object.hasOwn(spec, key)) {
      fail(errors, code, `argument not allowed for ${tool}: ${key}`);
      continue;
    }
    checkField(spec[key], actualArgs[key], `$.args.${key}`, errors, code);
  }
  scanForbidden(actualArgs, "$.args", errors, code);
  return { ok: errors.length === 0, errors };
}
