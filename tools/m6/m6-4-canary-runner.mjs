#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import {
  M6_4_COHORT_PURPOSES,
  validateM64CohortManifest,
} from "../../packages/kernel/lib/m6-4-cohort.mjs";
import {
  verifyM64LiveWindowAuthorization,
} from "../../services/control-plane/control-plane/lib/m6-live-window-authorization.mjs";

const LIVE_ENTRY_PATH = "/control/v1/internal/m6/live";
export const M64_CONTROL_PLANE_ORIGIN = "http://127.0.0.1:17920/";
export const M64_LOOPBACK_REQUEST_TIMEOUTS_MS = Object.freeze({
  "gate-f": Object.freeze({
    status: 5_000,
    preflight: 10_000,
    activate: 15_000,
    close: 15_000,
    reconcile: 15_000,
    // Startup recovery may verify and reconcile an already-appended immutable
    // emergency close before it can return the exact terminal Gate triple.
    "recover-armed-active": 30_000,
  }),
  "live-entry": Object.freeze({
    status: 5_000,
    preflight: 10_000,
    // Production start owns broker hello (1s), worker initialize (10s),
    // session/prompt acknowledgement (5s), plus bounded spawn/HTTP margin.
    start: 25_000,
    // Production close can spend 2s draining the call fence and up to four
    // sequential 20s cleanup steps.  Keep the HTTP deadline above that fixed
    // 82s server-side bound without admitting a CLI/env override.
    close: 90_000,
    // Epoch recovery permanently latches starts, settles admitted starts, and
    // may close more than one production run. The server closes each batch in
    // parallel, but the client owns one fixed end-to-end cleanup deadline.
    "recover-epoch": 300_000,
  }),
});

const M64_HASH = /^[0-9a-f]{64}$/u;
const M64_LIVE_RECOVERY_PURPOSES = new Set(M6_4_COHORT_PURPOSES);
const M64_LIVE_EPOCH_RECOVERY_KEYS = Object.freeze([
  "activeMatchingRuns", "attempted", "closeReceipts", "controlPlaneOwnedActiveRuns",
  "externalResourceState", "gateEpochHash", "inFlightStartsSettled", "purpose",
  "schemaId", "status", "stopNewStarts", "verifiedClosed",
]);
const M64_LIVE_EPOCH_RECOVERY_RECEIPT_KEYS = Object.freeze([
  "attemptEvidenceHash", "closeReceiptHash", "runId",
]);

function exactM64Object(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function failM64LiveEpochRecoveryResponse() {
  throw Object.assign(new Error("Control Plane live epoch recovery response is not the exact secret-free contract"), {
    code: "M64_LIVE_EPOCH_RECOVERY_RESPONSE_INVALID",
  });
}

export function validateM64LiveEpochRecoveryResponse(value, { gateEpochHash, purpose } = {}) {
  if (!exactM64Object(value, M64_LIVE_EPOCH_RECOVERY_KEYS)
    || value.schemaId !== "xw.m6-live-entry-epoch-recovery.v1"
    || value.status !== "RECOVERED"
    || value.stopNewStarts !== true
    || value.gateEpochHash !== gateEpochHash
    || value.purpose !== purpose
    || value.externalResourceState !== "NOT_ASSERTED"
    || !["inFlightStartsSettled", "attempted", "verifiedClosed", "activeMatchingRuns", "controlPlaneOwnedActiveRuns"]
      .every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)
    || value.activeMatchingRuns !== 0
    || value.attempted !== value.verifiedClosed
    || !Array.isArray(value.closeReceipts)
    || value.closeReceipts.length !== value.verifiedClosed) {
    failM64LiveEpochRecoveryResponse();
  }
  const runIds = new Set();
  for (const receipt of value.closeReceipts) {
    if (!exactM64Object(receipt, M64_LIVE_EPOCH_RECOVERY_RECEIPT_KEYS)
      || typeof receipt.runId !== "string" || !/^[a-z0-9][a-z0-9:_-]{7,127}$/u.test(receipt.runId)
      || !M64_HASH.test(receipt.closeReceiptHash ?? "")
      || !(receipt.attemptEvidenceHash === null || M64_HASH.test(receipt.attemptEvidenceHash ?? ""))
      || runIds.has(receipt.runId)) {
      failM64LiveEpochRecoveryResponse();
    }
    runIds.add(receipt.runId);
  }
  return value;
}

export function resolveM64LoopbackRequestTimeoutMs(authority, operation) {
  const timeoutMs = M64_LOOPBACK_REQUEST_TIMEOUTS_MS[authority]?.[operation];
  if (!Number.isSafeInteger(timeoutMs)) {
    throw Object.assign(new Error("loopback request authority/operation is not allowlisted"), {
      code: "M64_LOOPBACK_REQUEST_INVALID",
    });
  }
  return timeoutMs;
}

export async function withM64LoopbackRequestDeadline(authority, operation, task) {
  if (typeof task !== "function") {
    throw Object.assign(new Error("loopback request task is unavailable"), { code: "M64_LOOPBACK_REQUEST_INVALID" });
  }
  const timeoutMs = resolveM64LoopbackRequestTimeoutMs(authority, operation);
  const label = `Control Plane ${authority} ${operation}`;
  const controller = new AbortController();
  const timeoutError = Object.assign(
    new Error(`${label} exceeded the fixed loopback request deadline`),
    { code: "M64_LOOPBACK_REQUEST_TIMEOUT", details: { authority, operation, timeoutMs } },
  );
  let timeoutId;
  const deadline = new Promise((_, rejectDeadline) => {
    timeoutId = setTimeout(() => {
      controller.abort(timeoutError);
      rejectDeadline(timeoutError);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => task(controller.signal)),
      deadline,
    ]);
  } catch (error) {
    if (controller.signal.aborted) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function option(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

export function validateM64LoopbackControlPlaneUrl(value) {
  let url;
  try { url = new URL(value); } catch {
    throw Object.assign(new Error("Control Plane URL is invalid"), { code: "M64_CONTROL_PLANE_URL_INVALID" });
  }
  if (url.origin !== M64_CONTROL_PLANE_ORIGIN.slice(0, -1)
    || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port !== "17920"
    || url.username || url.password
    || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw Object.assign(new Error("M6-4 execute requires the exact sealed credential-free Control Plane origin"), { code: "M64_CONTROL_PLANE_NOT_LOOPBACK" });
  }
  return url;
}

export async function requestM64LiveEntry({
  fetchImpl,
  controlPlaneUrl,
  token,
  operation,
  body = null,
  query = null,
} = {}) {
  if (typeof fetchImpl !== "function") throw Object.assign(new Error("fetch implementation is unavailable"), { code: "M64_LIVE_ENTRY_CLIENT_UNAVAILABLE" });
  if (typeof token !== "string" || token.length < 32 || /[\0\r\n]/u.test(token)) {
    throw Object.assign(new Error("XW_M6_LIVE_ENTRY_TOKEN must be injected through the environment"), { code: "M64_LIVE_ENTRY_TOKEN_REQUIRED" });
  }
  if (!["preflight", "start", "status", "close", "recover-epoch"].includes(operation)) {
    throw Object.assign(new Error("live-entry operation is not allowlisted"), { code: "M64_LIVE_ENTRY_OPERATION_INVALID" });
  }
  if (operation === "recover-epoch"
    && (!exactM64Object(body, ["gateEpochHash", "purpose"])
      || !M64_HASH.test(body.gateEpochHash ?? "")
      || !M64_LIVE_RECOVERY_PURPOSES.has(body.purpose))) {
    throw Object.assign(new Error("live epoch recovery requires exactly one Gate epoch hash and bounded purpose"), {
      code: "M64_LIVE_EPOCH_RECOVERY_INPUT_INVALID",
    });
  }
  const loopback = validateM64LoopbackControlPlaneUrl(controlPlaneUrl);
  const url = new URL(`${LIVE_ENTRY_PATH}/${operation}`, loopback);
  const method = operation === "status" ? "GET" : "POST";
  if (method === "GET") {
    if (!query || typeof query.runId !== "string") {
      throw Object.assign(new Error("live-entry status requires one opaque runId"), { code: "M64_LIVE_ENTRY_REFS_INVALID" });
    }
    url.searchParams.set("runId", query.runId);
  }
  const { response, payload } = await withM64LoopbackRequestDeadline("live-entry", operation, async (signal) => {
    const response = await fetchImpl(url, {
      method,
      headers: {
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        "x-control-token": token,
      },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      signal,
    });
    let payload;
    try { payload = await response.json(); } catch (cause) {
      if (signal.aborted) throw cause;
      throw Object.assign(new Error(`Control Plane ${operation} returned non-JSON`), { code: "M64_LIVE_ENTRY_RESPONSE_INVALID" });
    }
    return { response, payload };
  });
  const containsToken = (value) => typeof value === "string"
    ? value.includes(token)
    : Array.isArray(value)
      ? value.some(containsToken)
      : value && typeof value === "object"
        ? Object.entries(value).some(([key, nested]) => key.includes(token) || containsToken(nested))
        : false;
  if (containsToken(payload)) {
    throw Object.assign(new Error("Control Plane echoed the internal token"), { code: "M64_LIVE_ENTRY_TOKEN_ECHO" });
  }
  if (!response.ok) {
    throw Object.assign(new Error(payload?.error?.message || `Control Plane ${operation} rejected the request`), {
      code: payload?.error?.code || "M64_LIVE_ENTRY_REJECTED",
      details: payload?.error?.details,
    });
  }
  return payload;
}

export async function preflightM64LiveEntry(input = {}) {
  const payload = await requestM64LiveEntry({ ...input, operation: "preflight" });
  return payload.preflight;
}

export async function startM64LiveEntry(input = {}) {
  const payload = await requestM64LiveEntry({ ...input, operation: "start" });
  return payload.run;
}

export async function statusM64LiveEntry({ runId, ...input } = {}) {
  const payload = await requestM64LiveEntry({ ...input, operation: "status", query: { runId } });
  return payload.run;
}

export async function closeM64LiveEntry({ runId, reasonCode, ...input } = {}) {
  const payload = await requestM64LiveEntry({ ...input, operation: "close", body: { reasonCode, runId } });
  return payload.run;
}

export async function recoverM64LiveEntryEpoch({ gateEpochHash, purpose, ...input } = {}) {
  const payload = await requestM64LiveEntry({
    ...input,
    operation: "recover-epoch",
    body: { gateEpochHash, purpose },
  });
  if (!exactM64Object(payload, ["recovery"])) failM64LiveEpochRecoveryResponse();
  return validateM64LiveEpochRecoveryResponse(payload.recovery, { gateEpochHash, purpose });
}

export function validateM64LiveWindowAuthorization(value, {
  manifest,
  modelManifest,
  issuerAllowlist,
  runtime,
  nowMs = Date.now(),
} = {}) {
  const errors = [];
  if (value?.scenarioManifestHash !== manifest?.manifestHash) errors.push("M64_LIVE_AUTH_MANIFEST_MISMATCH");
  if (value?.modelProfileHash !== modelManifest?.contentHash || modelManifest?.gateFEligible !== true || modelManifest?.status !== "QUALIFIED") errors.push("M64_LIVE_MODEL_UNQUALIFIED");
  if (runtime?.scenarioManifestHash !== manifest?.manifestHash || runtime?.modelProfileHash !== modelManifest?.contentHash) {
    errors.push("M64_LIVE_RUNTIME_INVENTORY_MISMATCH");
  }
  try {
    verifyM64LiveWindowAuthorization({ authorization: value, issuerAllowlist, runtime, nowMs });
  } catch (error) {
    errors.push(error?.code || "M64_LIVE_AUTH_INVALID");
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export async function runM64Canary(argv = process.argv.slice(2), { env = process.env, fetchImpl = globalThis.fetch, nowMs = Date.now() } = {}) {
  const manifestPath = option(argv, "--manifest");
  const execute = argv.includes("--execute");
  if (!manifestPath) throw Object.assign(new Error("--manifest is required"), { code: "M64_CANARY_MANIFEST_REQUIRED" });
  const manifest = JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
  const manifestValidation = validateM64CohortManifest(manifest);
  if (!manifestValidation.ok) throw Object.assign(new Error(manifestValidation.errors.join(",")), { code: "M64_CANARY_MANIFEST_INVALID" });
  if (!execute) return { ok: true, mode: "PREFLIGHT_ONLY", gateFEligible: false, actionCount: 0, manifestHash: manifest.manifestHash };
  // This legacy single-scenario runner cannot own the mandatory Gate lifecycle,
  // exact 5/1/3/20/30 sequence, emergency close, or resource-zero seal.  Live
  // execution is therefore available only through m6-4-production-operator-bridge.
  throw Object.assign(new Error("standalone live start is forbidden; use the staged production operator bridge"), {
    code: "M64_STANDALONE_EXECUTE_FORBIDDEN",
  });
}

if (process.argv[1] && basename(process.argv[1]).toLowerCase() === "m6-4-canary-runner.mjs") {
  runM64Canary().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
    const code = typeof error?.code === "string" && /^[A-Z0-9_]{3,96}$/u.test(error.code)
      ? error.code : "M64_CANARY_FAILED_CLOSED";
    process.stderr.write(`${JSON.stringify({ ok: false, code }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
