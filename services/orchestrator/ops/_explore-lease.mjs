import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

export const EXPLORER_SESSION_SCHEMA = "xhs.explorer-session-context.v1";
export const EXPLORER_CAPABILITY_ID = "xiaowei.explorer.primitive";
export const DEFAULT_CONTROL_BASE = "http://127.0.0.1:17920";
export const DEFAULT_REGISTRY_BASE = "http://127.0.0.1:17930";

export function defaultExplorerSessionRoot() {
  return join(homedir(), ".xhs-explorer-sessions");
}

export function explorerSessionIdentity(authorization) {
  return {
    contextId: authorization?.contextId,
    sessionId: authorization?.session?.sessionId,
    leaseId: authorization?.lease?.leaseId,
    actorId: authorization?.actorId,
    deviceId: authorization?.deviceId,
  };
}

export function assertExplorerSessionIdentity(expected, authorization) {
  const current = explorerSessionIdentity(authorization);
  if (!expected || Object.keys(current).some((key) => !current[key] || expected[key] !== current[key])) {
    throw leaseError("EXPLORER_SESSION_IDENTITY_CHANGED", "Explorer session identity changed after helper startup", 409);
  }
  return current;
}

function leaseError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function cleanBase(value, fallback, { allowTestEndpoints = false } = {}) {
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
  if (!allowTestEndpoints && base !== fallback) {
    throw leaseError("CONTROL_BASE_INVALID", `Explorer production endpoint is fixed at ${fallback}`);
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
  return join(defaultExplorerSessionRoot(), `${safeActor}-${validateAlias(alias)}.json`);
}

function ensureSafeContextRoot(rootValue) {
  const root = resolve(String(rootValue));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  const physical = realpathSync(root);
  const sameRoot = process.platform === "win32"
    ? physical.toLowerCase() === root.toLowerCase()
    : physical === root;
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameRoot) {
    throw leaseError("EXPLORER_CONTEXT_PATH_INVALID", "session context root must be a physical directory");
  }
  return root;
}

export function resolveContextPath(value, {
  alias,
  actor,
  contextRoot = defaultExplorerSessionRoot(),
} = {}) {
  const selected = value || defaultExplorerSessionPath(alias, actor);
  if (!isAbsolute(String(selected))) {
    throw leaseError("EXPLORER_CONTEXT_PATH_INVALID", "session context path must be absolute");
  }
  const path = resolve(String(selected));
  const root = ensureSafeContextRoot(contextRoot);
  const sameParent = process.platform === "win32"
    ? dirname(path).toLowerCase() === root.toLowerCase()
    : dirname(path) === root;
  if (!sameParent) {
    throw leaseError("EXPLORER_CONTEXT_PATH_INVALID", `session context must be directly under ${root}`);
  }
  return path;
}

export function readExplorerSessionContext(pathValue, { contextRoot = defaultExplorerSessionRoot() } = {}) {
  const path = resolveContextPath(pathValue, { contextRoot });
  let context;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw leaseError("EXPLORER_SESSION_CONTEXT_INVALID", "Explorer session context must be a regular file", 400);
    }
    context = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "EXPLORER_SESSION_CONTEXT_INVALID") throw error;
    throw leaseError(
      error?.code === "ENOENT" ? "EXPLORER_SESSION_CONTEXT_REQUIRED" : "EXPLORER_SESSION_CONTEXT_INVALID",
      error?.code === "ENOENT" ? `Explorer session context is missing: ${path}` : `invalid Explorer session context: ${error.message}`,
      error?.code === "ENOENT" ? 423 : 400,
    );
  }
  const required = ["sessionId", "leaseId", "token", "actorId", "deviceId", "alias"];
  if (Object.hasOwn(context || {}, "controlBase") || Object.hasOwn(context || {}, "registryBase")) {
    throw leaseError(
      "EXPLORER_SESSION_CONTEXT_INVALID",
      "Explorer session context must not select control or registry endpoints",
      400,
    );
  }
  if (context?.schemaId !== EXPLORER_SESSION_SCHEMA || required.some((key) => typeof context[key] !== "string" || !context[key])) {
    throw leaseError("EXPLORER_SESSION_CONTEXT_INVALID", "Explorer session context is incomplete", 400);
  }
  validateAlias(context.alias);
  validateActor(context.actorId);
  return { path, context };
}

function hardenContextPermissions(path, { skipAclHardening = false } = {}) {
  if (skipAclHardening) return;
  if (process.platform !== "win32") {
    chmodSync(path, 0o600);
    return;
  }
  const username = String(process.env.USERNAME || "").trim();
  const domain = String(process.env.USERDOMAIN || "").trim();
  if (!username) throw leaseError("EXPLORER_CONTEXT_ACL_FAILED", "USERNAME is required to secure session context", 500);
  const principal = domain ? `${domain}\\${username}` : username;
  try {
    execFileSync("icacls.exe", [path, "/inheritance:r", "/grant:r", `${principal}:(F)`], {
      windowsHide: true,
      stdio: "ignore",
    });
  } catch (error) {
    throw leaseError("EXPLORER_CONTEXT_ACL_FAILED", `failed to secure session context ACL: ${error.message}`, 500);
  }
}

function writeContextExclusive(path, context, options = {}) {
  writeFileSync(path, `${JSON.stringify(context, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    hardenContextPermissions(path, options);
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
}

export async function acquireExplorerSession({
  alias,
  actor,
  contextPath,
  controlBase = DEFAULT_CONTROL_BASE,
  registryBase = DEFAULT_REGISTRY_BASE,
  fetchImpl = globalThis.fetch,
  allowTestEndpoints = false,
  contextRoot = defaultExplorerSessionRoot(),
  skipAclHardening = false,
} = {}) {
  const requestedAlias = validateAlias(alias);
  const actorId = validateActor(actor);
  const path = resolveContextPath(contextPath, { alias: requestedAlias, actor: actorId, contextRoot });
  if (existsSync(path)) {
    throw leaseError("EXPLORER_SESSION_CONTEXT_EXISTS", `refusing to replace existing session context: ${path}`, 409);
  }
  const registry = cleanBase(registryBase, DEFAULT_REGISTRY_BASE, { allowTestEndpoints });
  const control = cleanBase(controlBase, DEFAULT_CONTROL_BASE, { allowTestEndpoints });
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
    || session.actorId !== actorId || selectedAlias !== requestedAlias
    || session.routeDecision?.selectedDevice?.deviceId !== session.deviceId) {
    if (session?.sessionId && session?.token) {
      await requestJson(`${control}/control/v1/sessions/${encodeURIComponent(session.sessionId)}/release`, {
        method: "POST", body: { token: session.token }, fetchImpl,
      }).catch(() => {});
    }
    throw leaseError("EXPLORER_SESSION_BINDING_INVALID", "control returned an incorrectly bound Explorer session", 409);
  }
  let leasePayload;
  try {
    leasePayload = await requestJson(`${control}/control/v1/leases`, { fetchImpl });
  } catch (error) {
    await requestJson(`${control}/control/v1/sessions/${encodeURIComponent(session.sessionId)}/release`, {
      method: "POST", body: { token: session.token }, fetchImpl,
    }).catch(() => {});
    throw error;
  }
  const visibleLease = (leasePayload.leases || []).find((item) => item.leaseId === session.leaseId);
  if (!visibleLease || visibleLease.deviceId !== session.deviceId || visibleLease.kind !== "interactive"
    || visibleLease.holderId !== actorId) {
    await requestJson(`${control}/control/v1/sessions/${encodeURIComponent(session.sessionId)}/release`, {
      method: "POST", body: { token: session.token }, fetchImpl,
    }).catch(() => {});
    throw leaseError("EXPLORER_LEASE_NOT_VISIBLE", "new Explorer lease is not visible in the control plane", 423);
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
  };
  try {
    writeContextExclusive(path, context, { skipAclHardening });
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
  controlBase = DEFAULT_CONTROL_BASE,
  registryBase = DEFAULT_REGISTRY_BASE,
  fetchImpl = globalThis.fetch,
  allowTestEndpoints = false,
  contextRoot = defaultExplorerSessionRoot(),
} = {}) {
  const { path, context } = readExplorerSessionContext(contextPath, { contextRoot });
  if (alias !== null && validateAlias(alias) !== context.alias) {
    throw leaseError("EXPLORER_SESSION_ALIAS_MISMATCH", `session is for ${context.alias}, not ${alias}`, 409);
  }
  const control = cleanBase(controlBase, DEFAULT_CONTROL_BASE, { allowTestEndpoints });
  const registry = cleanBase(registryBase, DEFAULT_REGISTRY_BASE, { allowTestEndpoints });
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
  if (!device || entryDeviceId !== context.deviceId || !device.serial || device.state?.online !== true
    || device.state?.quarantined === true) {
    throw leaseError("EXPLORER_DEVICE_BINDING_CHANGED", "alias/device/serial binding changed while session was active", 409);
  }
  return {
    path,
    contextId: context.contextId,
    session: { ...session, token: undefined },
    lease,
    alias: context.alias,
    actorId: context.actorId,
    deviceId: context.deviceId,
    serial: device.serial,
  };
}

export async function releaseExplorerSession({
  contextPath,
  controlBase = DEFAULT_CONTROL_BASE,
  fetchImpl = globalThis.fetch,
  allowTestEndpoints = false,
  contextRoot = defaultExplorerSessionRoot(),
} = {}) {
  const { path, context } = readExplorerSessionContext(contextPath, { contextRoot });
  const control = cleanBase(controlBase, DEFAULT_CONTROL_BASE, { allowTestEndpoints });
  let released = false;
  let alreadyExpired = false;
  try {
    const payload = await requestJson(
      `${control}/control/v1/sessions/${encodeURIComponent(context.sessionId)}/release`,
      { method: "POST", body: { token: context.token }, fetchImpl },
    );
    released = payload.released === true;
    if (!released) {
      throw leaseError("EXPLORER_RELEASE_NOT_CONFIRMED", "control did not confirm Explorer session release", 409);
    }
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
  controlBase = DEFAULT_CONTROL_BASE,
  registryBase = DEFAULT_REGISTRY_BASE,
  fetchImpl = globalThis.fetch,
  allowTestEndpoints = false,
  contextRoot = defaultExplorerSessionRoot(),
  expectedContextId = null,
  expectedSessionId = null,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
} = {}) {
  const started = Date.now();
  while (Date.now() - started < maxDurationMs) {
    if (!existsSync(contextPath)) return { stopped: "context_removed" };
    const current = readExplorerSessionContext(contextPath, { contextRoot }).context;
    if ((expectedContextId && current.contextId !== expectedContextId)
      || (expectedSessionId && current.sessionId !== expectedSessionId)) {
      throw leaseError("EXPLORER_KEEPALIVE_IDENTITY_CHANGED", "session context identity changed", 409);
    }
    await verifyExplorerSession({
      contextPath,
      controlBase,
      registryBase,
      fetchImpl,
      allowTestEndpoints,
      contextRoot,
    });
    await sleep(intervalMs);
  }
  return { stopped: "max_duration" };
}
