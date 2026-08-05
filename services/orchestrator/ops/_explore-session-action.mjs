import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  DEFAULT_CONTROL_BASE,
  EXPLORER_CAPABILITY_ID,
  assertExplorerSessionIdentity,
  explorerSessionIdentity,
  readExplorerSessionContext,
  verifyExplorerSession,
} from "./_explore-lease.mjs";

const ALLOWED_PRIMITIVES = new Set([
  "screen",
  "dump_ui",
  "focus",
  "tap",
  "swipe",
  "back",
  "launch_app",
  "input_text",
]);

let pinnedIdentity = null;

function actionError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

async function requestJson(url, { method = "GET", body, fetchImpl = globalThis.fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw actionError("EXPLORER_CONTROL_UNREACHABLE", `request failed: ${error.message}`, 503);
  }
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { /* handled below */ }
  if (!response.ok) {
    const code = payload?.error?.code || payload?.code || "EXPLORER_CONTROL_REJECTED";
    const message = payload?.error?.message || payload?.error || payload?.message || text.slice(0, 200);
    throw actionError(code, `control rejected ${response.status}: ${message}`, response.status);
  }
  return payload;
}

/**
 * Map legacy helper op payload → bounded Explorer primitive params.
 * Arbitrary shell is intentionally rejected.
 */
export function mapExplorerOpToPrimitive(opPayload) {
  const op = String(opPayload?.op || "").trim();
  switch (op) {
    case "tap":
      return { primitive: "tap", x: Math.round(Number(opPayload.x)), y: Math.round(Number(opPayload.y)) };
    case "swipe":
      return {
        primitive: "swipe",
        x1: Math.round(Number(opPayload.x1)),
        y1: Math.round(Number(opPayload.y1)),
        x2: Math.round(Number(opPayload.x2)),
        y2: Math.round(Number(opPayload.y2)),
        ...(opPayload.ms != null ? { durationMs: Math.round(Number(opPayload.ms)) } : {}),
      };
    case "back":
      return { primitive: "back", ...(opPayload.times != null ? { times: Math.round(Number(opPayload.times)) } : {}) };
    case "focus":
      return { primitive: "focus" };
    case "dump":
      return { primitive: "dump_ui" };
    case "start":
      return {
        primitive: "launch_app",
        package: String(opPayload.package || ""),
        ...(opPayload.activity ? { activity: String(opPayload.activity) } : {}),
        ...(opPayload.forceStop ? { forceStop: true } : {}),
      };
    case "inputText":
      return {
        primitive: "input_text",
        text: opPayload.textB64
          ? Buffer.from(String(opPayload.textB64), "base64").toString("utf8")
          : String(opPayload.text || ""),
        ...(opPayload.refocusX != null ? { refocusX: Math.round(Number(opPayload.refocusX)) } : {}),
        ...(opPayload.refocusY != null ? { refocusY: Math.round(Number(opPayload.refocusY)) } : {}),
        ...(opPayload.clearFirst ? { clearFirst: true } : {}),
        ...(opPayload.enter ? { enter: true } : {}),
        ...(opPayload.deferRestore ? { deferRestore: true } : {}),
      };
    case "screen":
      return { primitive: "screen" };
    case "shell":
      throw actionError(
        "EXPLORER_SHELL_NOT_BOUNDED",
        "arbitrary shell is not an Explorer primitive; use bounded session actions only",
        403,
      );
    default:
      throw actionError("EXPLORER_PRIMITIVE_UNKNOWN", `unknown Explorer op ${op || "<empty>"}`, 400);
  }
}

/**
 * POST /control/v1/sessions/:id/actions for one bounded Explorer primitive.
 * Device I/O happens inside the control-plane adapter; this client never opens 22222/ADB.
 */
export async function executeExplorerSessionAction({
  contextPath,
  alias = null,
  params,
  idempotencyKey = null,
  controlBase = DEFAULT_CONTROL_BASE,
  registryBase = undefined,
  fetchImpl = globalThis.fetch,
  allowTestEndpoints = false,
  contextRoot = undefined,
} = {}) {
  if (!params || typeof params !== "object" || !ALLOWED_PRIMITIVES.has(params.primitive)) {
    throw actionError("EXPLORER_PRIMITIVE_INVALID", "params.primitive must be a bounded Explorer primitive", 400);
  }
  const authorization = await verifyExplorerSession({
    contextPath,
    alias,
    controlBase,
    ...(registryBase ? { registryBase } : {}),
    fetchImpl,
    allowTestEndpoints,
    ...(contextRoot ? { contextRoot } : {}),
  });
  const { context } = readExplorerSessionContext(contextPath, contextRoot ? { contextRoot } : {});
  if (context.capabilityId !== EXPLORER_CAPABILITY_ID) {
    throw actionError(
      "EXPLORER_SESSION_CAPABILITY_MISMATCH",
      `session scoped to ${context.capabilityId}, expected ${EXPLORER_CAPABILITY_ID}`,
      409,
    );
  }
  if (!context.token) {
    throw actionError("EXPLORER_SESSION_TOKEN_MISSING", "session context is missing token", 400);
  }
  const identity = explorerSessionIdentity(authorization);
  if (pinnedIdentity === null) pinnedIdentity = identity;
  else assertExplorerSessionIdentity(pinnedIdentity, authorization);

  const key = idempotencyKey || `explorer-${params.primitive}-${randomUUID()}`;
  const control = String(controlBase || DEFAULT_CONTROL_BASE).replace(/\/$/, "");
  const payload = await requestJson(
    `${control}/control/v1/sessions/${encodeURIComponent(authorization.session.sessionId)}/actions`,
    {
      method: "POST",
      body: {
        token: context.token,
        capabilityId: EXPLORER_CAPABILITY_ID,
        idempotencyKey: key,
        params,
      },
      fetchImpl,
    },
  );
  const job = payload.job || payload;
  if (!job?.jobId) {
    throw actionError("EXPLORER_ACTION_RESPONSE_INVALID", "session action response missing job", 502);
  }
  if (job.status && job.status !== "succeeded") {
    const code = job.errorCode || job.result?.error?.code || "EXPLORER_ACTION_FAILED";
    const message = job.result?.error?.message || `session action ended status=${job.status}`;
    throw actionError(code, message, 409);
  }
  return {
    ok: true,
    jobId: job.jobId,
    runId: job.runId,
    status: job.status || "succeeded",
    output: job.result?.output || {},
    storage: job.storage || null,
    authorization: {
      alias: authorization.alias,
      serial: authorization.serial,
      deviceId: authorization.deviceId,
      sessionId: authorization.session.sessionId,
      leaseId: authorization.lease.leaseId,
    },
  };
}

export function copyExplorerEvidence(result, relativeName, localOut) {
  const evidenceDir = result?.storage?.evidenceDirectory;
  if (!evidenceDir) {
    throw actionError("EXPLORER_EVIDENCE_MISSING", "session action did not return evidenceDirectory", 502);
  }
  const source = `${String(evidenceDir).replace(/[/\\]+$/, "")}/${relativeName}`.replace(/\//g, "\\");
  if (!existsSync(source)) {
    // also try posix join for non-Windows test fixtures
    const alt = `${String(evidenceDir).replace(/[/\\]+$/, "")}/${relativeName}`;
    if (!existsSync(alt)) {
      throw actionError("EXPLORER_EVIDENCE_MISSING", `evidence file missing: ${relativeName}`, 502);
    }
    mkdirSync(dirname(localOut), { recursive: true });
    copyFileSync(alt, localOut);
    return localOut;
  }
  mkdirSync(dirname(localOut), { recursive: true });
  copyFileSync(source, localOut);
  return localOut;
}

/** Reset pinned identity between tests. */
export function resetExplorerActionPin() {
  pinnedIdentity = null;
}
