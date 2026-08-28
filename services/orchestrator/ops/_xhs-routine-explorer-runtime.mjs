import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, relative } from "node:path";

import {
  DEFAULT_CONTROL_BASE,
  DEFAULT_REGISTRY_BASE,
  EXPLORER_CAPABILITY_ID,
  acquireExplorerSession,
  defaultExplorerSessionRoot,
  readExplorerSessionContext,
  releaseExplorerSession,
  verifyExplorerSession,
} from "./_explore-lease.mjs";
import { executeExplorerSessionAction } from "./_explore-session-action.mjs";

function runtimeError(code, message, status = 409, details = {}) {
  return Object.assign(new Error(message), { code, status, details });
}

function normalizeLoopbackBase(value, fallback, { allowTestEndpoints = false } = {}) {
  const base = String(value || fallback).trim().replace(/\/$/, "");
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    throw runtimeError("ROUTINE_ENDPOINT_INVALID", "routine endpoint must be a loopback HTTP origin", 400);
  }
  if (parsed.protocol !== "http:"
    || !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)
    || parsed.username || parsed.password || parsed.pathname !== "/"
    || parsed.search || parsed.hash
    || (!allowTestEndpoints && base !== fallback)) {
    throw runtimeError("ROUTINE_ENDPOINT_INVALID", `production routine endpoint is fixed at ${fallback}`, 400);
  }
  return base;
}

async function requestJson(url, { fetchImpl, timeoutMs = 15_000 } = {}) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw runtimeError("ROUTINE_AUTHORITY_UNREACHABLE", `authority request failed: ${error?.message || error}`, 503);
  }
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { /* rejected below */ }
  if (!response.ok) {
    throw runtimeError(
      payload?.error?.code || "ROUTINE_AUTHORITY_REJECTED",
      payload?.error?.message || `authority rejected request (${response.status})`,
      response.status,
    );
  }
  return payload;
}

function sameSecret(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !left || !right) return false;
  const a = createHash("sha256").update(left, "utf8").digest();
  const b = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(a, b);
}

function requireOwnedContext(contexts, sessionId, token) {
  const owned = contexts.get(String(sessionId || ""));
  if (!owned || !sameSecret(owned.token, token)) {
    throw runtimeError("ROUTINE_SESSION_BINDING_INVALID", "routine does not own this Explorer session", 403);
  }
  return owned;
}

function readBoundUtf8Artifact({ path, runId, storage, maxBytes = 8 * 1024 * 1024 } = {}) {
  if (typeof runId !== "string" || !runId || typeof path !== "string" || !path) {
    throw runtimeError("ROUTINE_ARTIFACT_BINDING_INVALID", "dump artifact needs path and owning runId", 409);
  }
  const declaredRunRoot = storage?.runDirectory;
  if (typeof declaredRunRoot !== "string" || !declaredRunRoot) {
    throw runtimeError("ROUTINE_ARTIFACT_BINDING_INVALID", "dump artifact needs its CP runDirectory", 409);
  }
  let runRoot;
  let artifact;
  try {
    runRoot = realpathSync(declaredRunRoot);
    artifact = realpathSync(path);
  } catch {
    throw runtimeError("ROUTINE_ARTIFACT_MISSING", "dump artifact is absent", 409);
  }
  if (basename(runRoot) !== runId) {
    throw runtimeError("ROUTINE_ARTIFACT_BINDING_INVALID", "CP runDirectory does not match the primitive runId", 409);
  }
  const inside = relative(runRoot, artifact);
  if (!inside || inside.startsWith("..") || isAbsolute(inside) || extname(artifact).toLowerCase() !== ".xml") {
    throw runtimeError("ROUTINE_ARTIFACT_PATH_INVALID", "dump artifact escapes its CP run or is not XML", 409);
  }
  const stats = statSync(artifact);
  if (!stats.isFile() || stats.size <= 0 || stats.size > maxBytes) {
    throw runtimeError("ROUTINE_ARTIFACT_INVALID", "dump artifact is empty, oversized, or not a regular file", 409, { maxBytes });
  }
  return readFileSync(artifact, "utf8");
}

/**
 * Adapt the existing formal Explorer APIs into XhsRoutineRunner dependencies.
 * No ADB/vendor port is opened here, and no caller-selected module is loaded.
 */
export function createExplorerRoutineRuntime({
  controlBase = DEFAULT_CONTROL_BASE,
  registryBase = DEFAULT_REGISTRY_BASE,
  fetchImpl = globalThis.fetch,
  contextRoot = defaultExplorerSessionRoot(),
  allowTestEndpoints = false,
  skipAclHardening = false,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("createExplorerRoutineRuntime requires fetch");
  const control = normalizeLoopbackBase(controlBase, DEFAULT_CONTROL_BASE, { allowTestEndpoints });
  const registry = normalizeLoopbackBase(registryBase, DEFAULT_REGISTRY_BASE, { allowTestEndpoints });
  const contexts = new Map();

  return {
    async createSession({ actorId, capabilityId, canary, placement } = {}) {
      if (capabilityId !== EXPLORER_CAPABILITY_ID || canary !== true || !placement?.alias) {
        throw runtimeError("ROUTINE_SESSION_REQUEST_INVALID", "routine requires a canary Explorer session with exact alias", 400);
      }
      const contextPath = join(contextRoot, `xhs-routine-${randomUUID()}-${placement.alias}.json`);
      const acquired = await acquireExplorerSession({
        alias: placement.alias,
        actor: actorId,
        contextPath,
        controlBase: control,
        registryBase: registry,
        fetchImpl,
        allowTestEndpoints,
        contextRoot,
        skipAclHardening,
      });
      const { context } = readExplorerSessionContext(acquired.path, { contextRoot });
      contexts.set(context.sessionId, { contextPath: acquired.path, ...context });
      return {
        sessionId: context.sessionId,
        leaseId: context.leaseId,
        token: context.token,
        deviceId: context.deviceId,
        actorId: context.actorId,
        scopeCapabilityId: context.capabilityId,
        canary: true,
        routeDecision: { selectedDevice: { alias: context.alias, deviceId: context.deviceId } },
      };
    },

    async executeSessionAction(sessionId, token, action) {
      const owned = requireOwnedContext(contexts, sessionId, token);
      return executeExplorerSessionAction({
        contextPath: owned.contextPath,
        alias: owned.alias,
        params: action?.params,
        idempotencyKey: action?.idempotencyKey,
        controlBase: control,
        registryBase: registry,
        fetchImpl,
        allowTestEndpoints,
        contextRoot,
      });
    },

    async heartbeatSession(sessionId, token) {
      const owned = requireOwnedContext(contexts, sessionId, token);
      return verifyExplorerSession({
        contextPath: owned.contextPath,
        alias: owned.alias,
        controlBase: control,
        registryBase: registry,
        fetchImpl,
        allowTestEndpoints,
        contextRoot,
      });
    },

    async releaseSession(sessionId, token) {
      const owned = requireOwnedContext(contexts, sessionId, token);
      const released = await releaseExplorerSession({
        contextPath: owned.contextPath,
        controlBase: control,
        fetchImpl,
        allowTestEndpoints,
        contextRoot,
      });
      if (released.released || released.alreadyExpired) contexts.delete(sessionId);
      return { ...released, released: released.released || released.alreadyExpired };
    },

    async listLeases() {
      const payload = await requestJson(`${control}/control/v1/leases`, { fetchImpl });
      if (!Array.isArray(payload?.leases)) {
        throw runtimeError("ROUTINE_LEASE_AUTHORITY_INVALID", "Control Plane lease response is malformed", 502);
      }
      return payload.leases;
    },

    readDumpArtifact(input) {
      return readBoundUtf8Artifact(input);
    },

    async getDevice(deviceId) {
      const payload = await requestJson(`${registry}/api/agent-entry`, { fetchImpl });
      const device = (Array.isArray(payload?.devices) ? payload.devices : []).find((row) => (
        row?.control?.deviceId === deviceId || row?.deviceId === deviceId
      ));
      if (!device) throw runtimeError("ROUTINE_DEVICE_BINDING_MISSING", "Registry no longer exposes the session device", 409);
      return device;
    },
  };
}

export { readBoundUtf8Artifact };
