// Static tool-call surface validation for the M6 model-facing tool bridge.
// The model may only call the fixed M6 tool allowlist with opaque refs and structured
// blocks; raw coordinates, ADB transport, shell, URLs, tokens, lease mutation, DB
// access, payment values/credentials and raw screenshot base64 are rejected at both
// the schema layer (unknown arg keys) and by a recursive field/value scan (unknown
// nesting). Pure functions only: no device IO, no network, deterministic.
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

export const M6_TOOL_SURFACE = Object.freeze({
  phone_observe: Object.freeze(["sessionRef"]),
  phone_ground: Object.freeze(["frameRef", "blockId", "intent"]),
  phone_act: Object.freeze(["groundingDecisionRef", "operationKey"]),
  phone_verify: Object.freeze(["actionReceiptRef", "expectation"]),
  checkpoint_save: Object.freeze(["stateRefs"]),
  trace_query: Object.freeze(["traceId"]),
  wait_human: Object.freeze(["reason", "evidenceRefs"]),
  worker_start: Object.freeze(["workerRunRef"]),
  worker_continue: Object.freeze(["workerRunRef", "checkpointRef"]),
  worker_complete: Object.freeze(["workerRunRef", "outcome"]),
});

export const M6_TOOL_NAMES = Object.freeze(Object.keys(M6_TOOL_SURFACE));

const FORBIDDEN_FIELD_NAMES = new Set([
  "x", "y", "px", "py",
  "normalizedx", "normalizedy", "normalizedcoordinate", "normalizedcoordinates",
  "bounds", "rect", "rectangle", "coordinate", "coordinates",
  "adbserial", "adbserver", "adbport", "serial", "server", "port",
  "shell", "cmd", "command", "exec",
  "url", "httpurl", "httpsurl", "endpoint",
  "token", "accesstoken", "secret", "password", "credential", "credentials",
  "leasemutation", "mutatelease", "revokelease", "releaselease", "acquirelease",
  "dbpath", "databasepath", "database", "query", "sql",
  "paymentvalue", "amount", "price", "cardnumber", "paymentcredential",
  "screenshotbase64", "imagebase64", "base64", "rawscreenshot",
]);

const HTTP_URL_PATTERN = /^https?:\/\//i;
const ADB_SERIAL_PATTERN = /^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/;
const BASE64_BLOB_PATTERN = /^[A-Za-z0-9+/=]{512,}$/;

function scanForbidden(value, path, errors, code) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbidden(item, `${path}[${index}]`, errors, code));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_FIELD_NAMES.has(key.toLowerCase())) {
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
  const allowedArgs = M6_TOOL_SURFACE[tool];
  const actualArgs = args === undefined ? {} : args;
  if (!actualArgs || typeof actualArgs !== "object" || Array.isArray(actualArgs)) {
    fail(errors, code, "args must be an object");
    return { ok: false, errors };
  }
  for (const key of Object.keys(actualArgs)) {
    if (!allowedArgs.includes(key)) {
      fail(errors, code, `argument not allowed for ${tool}: ${key}`);
    }
  }
  scanForbidden(actualArgs, "$.args", errors, code);
  return { ok: errors.length === 0, errors };
}
