import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const EXPLORER_SESSION_SCHEMA = "xhs.explorer-session-context.v1";
export const EXPLORER_CAPABILITY_ID = "xiaowei.lab.raw";
export const DEFAULT_CONTROL_BASE = "http://127.0.0.1:17920";
export const DEFAULT_REGISTRY_BASE = "http://127.0.0.1:17930";

function leaseError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function cleanBase(value, fallback) {
  const base = String(value || fallback).trim().replace(/\/$/, "");
  const parsed = new URL(base);
  if (!(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname))) {
    throw leaseError("CONTROL_BASE_NOT_LOOPBACK", "Explorer lease endpoints must be loopback");
  }
  if (parsed.protocol !== "http:") {
    throw leaseError("CONTROL_BASE_INVALID", "Explorer lease endpoints must use loopback http");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw leaseError("CONTROL_BASE_INVALID", "Explorer lease base must not contain credentials, paths, query, or hash");
  }
  return base;
}

function validateAlias(alias) {
  const value = String(alias || "").trim();
  if (!/^(?:01|02|03|04)$/.test(value)) {
    throw leaseError("EXPLORER_ALIAS_INVALID", "alias must be 01, 02, 03, or 04", 400);
  }
  return value;
}

function validateActor(actor) {
  const value = String(actor || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,79}$/.test(value)) {
    throw leaseError("EXPLORER_ACTOR_INVALID", "actor must be a stable 3-80 character id", 400);
  }
  return value;
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
    throw leaseError("EXPLORER_CONTROL_UNREACHABLE", `request failed: ${error.message}`, 503);
  }
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { /* handled below */ }
  if (!response.ok) {
    const code = payload?.error?.code || payload?.code || "EXPLORER_CONTROL_REJECTED";
    const message = payload?.error?.message || payload?.error || payload?.message || text.slice(0, 200);
    throw leaseError(code, `control rejected ${response.status}: ${message}`, response.status);
  }
  return payload;
}

export function defaultExplorerSessionPath(alias, actor) {
  const safeActor = validateActor(actor).replace(/[^A-Za-z0-9._-]/g, "_");
  return join(homedir(), ".xhs-explorer-sessions", `${safeActor}-${validateAlias(alias)}.json`);
}

export function resolveContextPath(value, { alias, actor } = {}) {
  const selected = value || defaultExplorerSessionPath(alias, actor);
  if (!isAbsolute(String(selected))) {
    throw leaseError("EXPLORER_CONTEXT_PATH_INVALID", "session context path must be absolute");
  }
  const path = resolve(String(selected));
  return path;
}

export function readExplorerSessionContext(pathValue) {
  const path = resolve(String(pathValue || ""));
  let context;
  try { context = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    throw leaseError(
      error?.code === "ENOENT" ? "EXPLORER_SESSION_CONTEXT_REQUIRED" : "EXPLORER_SESSION_CONTEXT_INVALID",
      error?.code === "ENOENT" ? `Explorer session context is missing: ${path}` : `invalid Explorer session context: ${error.message}`,
      error?.code === "ENOENT" ? 423 : 400,
    );
  }
  const required = ["sessionId", "leaseId", "token", "actorId", "deviceId", "alias"];
  if (context?.schemaId !== EXPLORER_SESSION_SCHEMA || required.some((key) => typeof context[key] !== "string" || !context[key])) {
    throw leaseError("EXPLORER_SESSION_CONTEXT_INVALID", "Explorer session context is incomplete", 400);
  }
  validateAlias(context.alias);
  validateActor(context.actorId);
  return { path, context };
}

function writeContextExclusive(path, context) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(context, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

export async function acquireExplorerSession({
  alias,
  actor,
  contextPath,
  controlBase = DEFAULT_CONTROL_BASE,
  registryBase = DEFAULT_REGISTRY_BASE,
  fetchImpl = globalThis.fetch,
} = {}) {
  const requestedAlias = validateAlias(alias);
  const actorId = validateActor(actor);
  const path = resolveContextPath(contextPath, { alias: requestedAlias, actor: actorId });
  if (existsSync(path)) {
    throw leaseError("EXPLORER_SESSION_CONTEXT_EXISTS", `refusing to replace existing session context: ${path}`, 409);
  }
  const registry = cleanBase(registryBase, DEFAULT_REGISTRY_BASE);
  const control = cleanBase(controlBase, DEFAULT_CONTROL_BASE);
  const entry = await requestJson(`${registry}/api/agent-entry`, { fetchImpl });
  const device = (entry.devices || []).find((item) => item.alias === requestedAlias);
  if (!device) throw leaseError("EXPLORER_DEVICE_NOT_FOUND", `alias ${requestedAlias} is not registered`, 404);
  if (device.state?.leaseFree !== true) {
    throw leaseError("DEVICE_BUSY", `alias ${requestedAlias} already has an active lease`, 423);
  }
  if (device.state?.online !== true || device.state?.ready !== true || device.state?.quarantined === true) {
    throw leaseError("EXPLORER_DEVICE_NOT_READY", `alias ${requestedAlias} is not ready`, 423);
  }

  const payload = await requestJson(`${control}/control/v1/sessions`, {
    method: "POST",
    body: {
      actorId,
      capabilityId: EXPLORER_CAPABILITY_ID,
      canary: true,
      placement: { alias: requestedAlias },
    },
    fetchImpl,
  });
  const session = payload.session;
  const selectedAlias = session?.routeDecision?.selectedDevice?.alias;
  if (!session?.sessionId || !session?.leaseId || !session?.token || !session?.deviceId
    || session.scopeCapabilityId !== EXPLORER_CAPABILITY_ID || session.canary !== true
    || selectedAlias !== requestedAlias) {
    if (session?.sessionId && session?.token) {
      await requestJson(`${control}/control/v1/sessions/${encodeURIComponent(session.sessionId)}/release`, {
        method: "POST", body: { token: session.token }, fetchImpl,
      }).catch(() => {});
    }
    throw leaseError("EXPLORER_SESSION_BINDING_INVALID", "control returned an incorrectly bound Explorer session", 409);
  }
  const context = {
    schemaId: EXPLORER_SESSION_SCHEMA,
    schemaVersion: 1,
    contextId: `explorer_context_${randomUUID()}`,
    sessionId: session.sessionId,
    leaseId: session.leaseId,
    token: session.token,
    actorId,
    deviceId: session.deviceId,
    alias: requestedAlias,
    capabilityId: EXPLORER_CAPABILITY_ID,
    canary: true,
    createdAt: new Date().toISOString(),
    expiresAt: session.expiresAt,
    controlBase: control,
    registryBase: registry,
  };
  try {
    writeContextExclusive(path, context);
  } catch (error) {
    await requestJson(`${control}/control/v1/sessions/${encodeURIComponent(session.sessionId)}/release`, {
      method: "POST", body: { token: session.token }, fetchImpl,
    }).catch(() => {});
    throw error;
  }
  return { path, context: { ...context, token: undefined } };
}

export async function verifyExplorerSession({
  contextPath,
  alias = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const { path, context } = readExplorerSessionContext(contextPath);
  if (alias !== null && validateAlias(alias) !== context.alias) {
    throw leaseError("EXPLORER_SESSION_ALIAS_MISMATCH", `session is for ${context.alias}, not ${alias}`, 409);
  }
  const control = cleanBase(context.controlBase, DEFAULT_CONTROL_BASE);
  const registry = cleanBase(context.registryBase, DEFAULT_REGISTRY_BASE);
  const heartbeat = await requestJson(
    `${control}/control/v1/sessions/${encodeURIComponent(context.sessionId)}/heartbeat`,
    { method: "POST", body: { token: context.token }, fetchImpl },
  );
  const session = heartbeat.session;
  if (session?.leaseId !== context.leaseId || session?.deviceId !== context.deviceId
    || session?.actorId !== context.actorId || session?.scopeCapabilityId !== EXPLORER_CAPABILITY_ID
    || session?.canary !== true || session?.routeDecision?.selectedDevice?.alias !== context.alias) {
    throw leaseError("EXPLORER_SESSION_BINDING_CHANGED", "heartbeat session binding does not match context", 409);
  }
  const [leasePayload, entry] = await Promise.all([
    requestJson(`${control}/control/v1/leases`, { fetchImpl }),
    requestJson(`${registry}/api/agent-entry`, { fetchImpl }),
  ]);
  const lease = (leasePayload.leases || []).find((item) => item.leaseId === context.leaseId);
  if (!lease || lease.deviceId !== context.deviceId || lease.kind !== "interactive" || lease.holderId !== context.actorId) {
    throw leaseError("EXPLORER_LEASE_NOT_VISIBLE", "owned Explorer lease is not visible in the control plane", 423);
  }
  const device = (entry.devices || []).find((item) => item.alias === context.alias);
  const entryDeviceId = device?.control?.deviceId || device?.deviceId;
  if (!device || entryDeviceId !== context.deviceId || !device.serial || device.state?.online !== true) {
    throw leaseError("EXPLORER_DEVICE_BINDING_CHANGED", "alias/device/serial binding changed while session was active", 409);
  }
  return {
    path,
    session: { ...session, token: undefined },
    lease,
    alias: context.alias,
    actorId: context.actorId,
    deviceId: context.deviceId,
    serial: device.serial,
  };
}

export async function releaseExplorerSession({ contextPath, fetchImpl = globalThis.fetch } = {}) {
  const { path, context } = readExplorerSessionContext(contextPath);
  const control = cleanBase(context.controlBase, DEFAULT_CONTROL_BASE);
  let released = false;
  let alreadyExpired = false;
  try {
    const payload = await requestJson(
      `${control}/control/v1/sessions/${encodeURIComponent(context.sessionId)}/release`,
      { method: "POST", body: { token: context.token }, fetchImpl },
    );
    released = payload.released === true;
  } catch (error) {
    if (error.status === 404) alreadyExpired = true;
    else throw error;
  }
  rmSync(path, { force: true });
  return { released, alreadyExpired, sessionId: context.sessionId, leaseId: context.leaseId, alias: context.alias };
}

export async function keepExplorerSessionAlive({
  contextPath,
  intervalMs = 15_000,
  maxDurationMs = 40 * 60_000,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
} = {}) {
  const started = Date.now();
  while (Date.now() - started < maxDurationMs) {
    if (!existsSync(contextPath)) return { stopped: "context_removed" };
    await verifyExplorerSession({ contextPath, fetchImpl });
    await sleep(intervalMs);
  }
  return { stopped: "max_duration" };
}
