import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

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
import {
  createProductionExplorationVisionNavigator,
  EXPLORATION_VISION_PROVIDER_CONFIG_PATH,
} from "./_xhs-routine-vision-factory.mjs";

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

async function postJson(url, body, { fetchImpl, timeoutMs = 30_000 } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
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

function readBoundArtifact({ path, runId, storage, extensions, maxBytes = 12 * 1024 * 1024, encoding = null } = {}) {
  if (typeof runId !== "string" || !runId || typeof path !== "string" || !path) {
    throw runtimeError("ROUTINE_ARTIFACT_BINDING_INVALID", "artifact needs path and owning runId", 409);
  }
  const declaredRunRoot = storage?.runDirectory;
  if (typeof declaredRunRoot !== "string" || !declaredRunRoot) {
    throw runtimeError("ROUTINE_ARTIFACT_BINDING_INVALID", "artifact needs its CP runDirectory", 409);
  }
  let runRoot;
  let artifact;
  try {
    runRoot = realpathSync(declaredRunRoot);
    artifact = realpathSync(path);
  } catch {
    throw runtimeError("ROUTINE_ARTIFACT_MISSING", "artifact is absent", 409);
  }
  if (basename(runRoot) !== runId) {
    throw runtimeError("ROUTINE_ARTIFACT_BINDING_INVALID", "CP runDirectory does not match the primitive runId", 409);
  }
  const inside = relative(runRoot, artifact);
  const ext = extname(artifact).toLowerCase();
  if (!inside || inside.startsWith("..") || isAbsolute(inside) || !extensions.includes(ext)) {
    throw runtimeError("ROUTINE_ARTIFACT_PATH_INVALID", `artifact escapes its CP run or is not ${extensions.join("/")}`, 409);
  }
  const stats = statSync(artifact);
  if (!stats.isFile() || stats.size <= 0 || stats.size > maxBytes) {
    throw runtimeError("ROUTINE_ARTIFACT_INVALID", "artifact is empty, oversized, or not a regular file", 409, { maxBytes });
  }
  return readFileSync(artifact, encoding);
}

function readBoundUtf8Artifact(input = {}) {
  return readBoundArtifact({ ...input, extensions: [".xml"], maxBytes: 8 * 1024 * 1024, encoding: "utf8" });
}

function readBoundPngArtifact(input = {}) {
  return readBoundArtifact({ ...input, extensions: [".png"], encoding: null });
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
  explorationVisionFactory = createProductionExplorationVisionNavigator,
  explorationVisionConfigPath = EXPLORATION_VISION_PROVIDER_CONFIG_PATH,
  now = () => Date.now(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("createExplorerRoutineRuntime requires fetch");
  const control = normalizeLoopbackBase(controlBase, DEFAULT_CONTROL_BASE, { allowTestEndpoints });
  const registry = normalizeLoopbackBase(registryBase, DEFAULT_REGISTRY_BASE, { allowTestEndpoints });
  if (typeof explorationVisionConfigPath !== "string" || !explorationVisionConfigPath) {
    throw runtimeError("EXPLORATION_VISION_CONFIG_MISSING", "exploration vision config path is required", 400);
  }
  if (!allowTestEndpoints
    && resolve(explorationVisionConfigPath) !== resolve(EXPLORATION_VISION_PROVIDER_CONFIG_PATH)) {
    throw runtimeError(
      "EXPLORATION_VISION_CONFIG_OVERRIDE_FORBIDDEN",
      `production exploration vision config is fixed at ${EXPLORATION_VISION_PROVIDER_CONFIG_PATH}`,
      400,
    );
  }
  if (!allowTestEndpoints && explorationVisionFactory !== createProductionExplorationVisionNavigator) {
    throw runtimeError(
      "EXPLORATION_VISION_FACTORY_OVERRIDE_FORBIDDEN",
      "production exploration vision factory is fixed",
      400,
    );
  }
  if (typeof explorationVisionFactory !== "function") {
    throw new TypeError("createExplorerRoutineRuntime requires an exploration vision factory");
  }
  const contexts = new Map();

  function explorationUrl(authorityId, suffix = "") {
    if (typeof authorityId !== "string" || !authorityId) {
      throw runtimeError("EXPLORATION_AUTHORITY_ID_REQUIRED", "exploration RPC requires an authorityId", 400);
    }
    return `${control}/control/v1/exploration-authority/${encodeURIComponent(authorityId)}${suffix}`;
  }

  async function postOwnedExploration(authorityId, suffix, {
    sessionId,
    token,
    ...body
  } = {}) {
    requireOwnedContext(contexts, sessionId, token);
    return postJson(explorationUrl(authorityId, suffix), { sessionId, token, ...body }, { fetchImpl });
  }

  async function reserveExplorationBudgetRpc({
    sessionId,
    token,
    authorityId,
    alias = null,
    kind,
    amount = 1,
    detail = null,
  } = {}) {
    const payload = await postOwnedExploration(authorityId, "/budget", {
      sessionId, token, alias, kind, amount, detail,
    });
    if (!payload?.reservation) {
      throw runtimeError("EXPLORATION_BUDGET_RESPONSE_INVALID", "exploration budget response is malformed", 502);
    }
    return payload.reservation;
  }

  async function settleExplorationReservationRpc({
    sessionId,
    token,
    authorityId,
    reservationId,
    outcome,
  } = {}) {
    const payload = await postOwnedExploration(authorityId, "/budget", {
      sessionId, token, action: "settle", reservationId, outcome,
    });
    if (!payload?.reservation) {
      throw runtimeError("EXPLORATION_BUDGET_RESPONSE_INVALID", "exploration reservation settlement response is malformed", 502);
    }
    return payload.reservation;
  }

  async function reserveExplorationVisionAnalysisRpc({
    sessionId,
    token,
    authorityId,
    detail = null,
  } = {}) {
    const payload = await postOwnedExploration(authorityId, "/vision-analysis", {
      sessionId,
      token,
      detail,
    });
    if (!payload?.reservation) {
      throw runtimeError(
        "EXPLORATION_BUDGET_RESPONSE_INVALID",
        "exploration vision analysis reservation response is malformed",
        502,
      );
    }
    return payload.reservation;
  }

  async function settleExplorationVisionAnalysisRpc({
    sessionId,
    token,
    authorityId,
    reservationId,
    outcome,
    result = null,
  } = {}) {
    const payload = await postOwnedExploration(authorityId, "/vision-analysis", {
      sessionId,
      token,
      action: "settle",
      reservationId,
      outcome,
      result,
    });
    if (!payload?.reservation) {
      throw runtimeError(
        "EXPLORATION_BUDGET_RESPONSE_INVALID",
        "exploration vision analysis settlement response is malformed",
        502,
      );
    }
    return payload.reservation;
  }

  async function appendExplorationLaneRecordRpc({
    sessionId,
    token,
    authorityId,
    alias = null,
    type,
    payload = {},
  } = {}) {
    const result = await postOwnedExploration(authorityId, "/journal", {
      sessionId, token, alias, type, payload,
    });
    if (!/^[0-9a-f]{64}$/.test(String(result?.recordHash || ""))) {
      throw runtimeError("EXPLORATION_JOURNAL_RESPONSE_INVALID", "exploration journal response is malformed", 502);
    }
    return { recordHash: result.recordHash };
  }

  async function captureExplorationFrameRpc({
    sessionId,
    token,
    routineRunId,
    signal = null,
  } = {}) {
    const owned = requireOwnedContext(contexts, sessionId, token);
    if (typeof routineRunId !== "string" || !routineRunId) {
      throw runtimeError("EXPLORATION_FRAME_BINDING_INVALID", "frame capture requires a routineRunId", 400);
    }
    if (signal?.aborted) {
      throw runtimeError("EXPLORATION_VISION_CANCELLED", "frame capture was cancelled before device I/O", 499);
    }
    // Conservatively anchor age before the screen action: the reported frame is
    // never younger than its real capture, even if the vendor call is slow.
    const capturedAt = now();
    const result = await executeExplorerSessionAction({
      contextPath: owned.contextPath,
      alias: owned.alias,
      params: { primitive: "screen" },
      idempotencyKey: `xhs-exploration:${routineRunId}:screen:${randomUUID()}`,
      controlBase: control,
      registryBase: registry,
      fetchImpl,
      allowTestEndpoints,
      contextRoot,
    });
    if (signal?.aborted) {
      throw runtimeError("EXPLORATION_VISION_CANCELLED", "frame capture was cancelled", 499);
    }
    if (result?.authorization?.sessionId !== sessionId
      || result?.authorization?.alias !== owned.alias) {
      throw runtimeError("EXPLORATION_FRAME_CROSS_SESSION", "screen result drifted from the owning exploration session", 409);
    }
    const pngPath = result?.output?.path;
    if (typeof pngPath !== "string" || !pngPath) {
      throw runtimeError("EXPLORATION_FRAME_UNAVAILABLE", "screen result has no CP-bound PNG artifact", 409);
    }
    const bytes = readBoundPngArtifact({
      path: pngPath,
      runId: result.runId,
      storage: result.storage,
    });
    const frameHash = createHash("sha256").update(bytes).digest("hex");
    const frameId = createHash("sha256")
      .update(`${routineRunId}:${owned.alias}:${result.jobId}:${result.runId}:${frameHash}`, "utf8")
      .digest("hex");
    return Object.freeze({
      frameId,
      pngPath,
      bytes,
      frameHash,
      capturedAt,
      runId: result.runId,
      jobId: result.jobId,
    });
  }

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

    readScreenArtifact(input) {
      return readBoundPngArtifact(input);
    },

    async getDevice(deviceId) {
      const payload = await requestJson(`${registry}/api/agent-entry`, { fetchImpl });
      const device = (Array.isArray(payload?.devices) ? payload.devices : []).find((row) => (
        row?.control?.deviceId === deviceId || row?.deviceId === deviceId
      ));
      if (!device) throw runtimeError("ROUTINE_DEVICE_BINDING_MISSING", "Registry no longer exposes the session device", 409);
      return device;
    },

    // --- V3 exploration authority -----------------------------------------

    async registerExplorationAuthority({
      sessions,
      executionRunId,
      routineRunId,
      mission,
      planHash,
      releaseId = null,
      sourceCommit = null,
      accountFingerprint = null,
    } = {}) {
      if (!Array.isArray(sessions) || sessions.length !== 2) {
        throw runtimeError("EXPLORATION_SESSION_PAIR_REQUIRED", "exploration authority requires the exact [03,04] session pair", 400);
      }
      const bound = sessions.map((session) => {
        const owned = requireOwnedContext(contexts, session?.sessionId, session?.token);
        if (session.alias !== owned.alias || !["03", "04"].includes(owned.alias)) {
          throw runtimeError("EXPLORATION_SESSION_ALIAS_DRIFT", "exploration session alias differs from its owned context", 409);
        }
        return { alias: owned.alias, sessionId: session.sessionId, token: session.token };
      }).sort((a, b) => a.alias.localeCompare(b.alias));
      if (bound[0]?.alias !== "03" || bound[1]?.alias !== "04") {
        throw runtimeError("EXPLORATION_SESSION_PAIR_REQUIRED", "exploration authority requires exact aliases [03,04]", 400);
      }
      const payload = await postJson(`${control}/control/v1/exploration-authority`, {
        sessions: bound,
        executionRunId,
        routineRunId,
        mission,
        planHash,
        releaseId,
        sourceCommit,
        accountFingerprint,
      }, { fetchImpl });
      if (!payload?.authority?.authorityId) {
        throw runtimeError("EXPLORATION_AUTHORITY_RESPONSE_INVALID", "exploration authority registration response is malformed", 502);
      }
      return payload.authority;
    },

    async getExplorationAuthorityView({ sessionId, token, authorityId } = {}) {
      const payload = await postOwnedExploration(authorityId, "", { sessionId, token });
      if (!payload?.authority || !payload?.lanes) {
        throw runtimeError("EXPLORATION_AUTHORITY_RESPONSE_INVALID", "exploration authority view is malformed", 502);
      }
      return payload;
    },

    async issueExplorationPermit({
      sessionId,
      token,
      authorityId,
      navigationRole,
      page,
      evidenceHash,
      resolvedPayload,
      ttlMs,
      visualProof = null,
    } = {}) {
      const payload = await postOwnedExploration(authorityId, "/permits", {
        sessionId, token, navigationRole, page, evidenceHash, resolvedPayload, ttlMs, visualProof,
      });
      if (!payload?.permit?.permitId) {
        throw runtimeError("EXPLORATION_PERMIT_RESPONSE_INVALID", "exploration permit issuance response is malformed", 502);
      }
      return payload.permit;
    },

    async consumeExplorationPermit({
      sessionId,
      token,
      authorityId,
      permitId,
      payload,
      freshObservation,
    } = {}) {
      if (typeof permitId !== "string" || !permitId) {
        throw runtimeError("EXPLORATION_PERMIT_ID_REQUIRED", "permit consumption requires a permitId", 400);
      }
      const result = await postOwnedExploration(
        authorityId,
        `/permits/${encodeURIComponent(permitId)}/consume`,
        { sessionId, token, payload, freshObservation },
      );
      if (!result?.permit?.permitId || !result?.job?.jobId
        || !result?.budgetReservation?.reservationId) {
        throw runtimeError("EXPLORATION_PERMIT_RESPONSE_INVALID", "exploration permit consumption response is malformed", 502);
      }
      return {
        permit: result.permit,
        job: result.job,
        budgetReservation: result.budgetReservation,
      };
    },

    reserveExplorationBudget(input) {
      return reserveExplorationBudgetRpc(input);
    },

    reserveExplorationVisionAnalysis(input) {
      return reserveExplorationVisionAnalysisRpc(input);
    },

    settleExplorationVisionAnalysis(input) {
      return settleExplorationVisionAnalysisRpc(input);
    },

    settleExplorationReservation(input) {
      return settleExplorationReservationRpc(input);
    },

    async claimExplorationTarget({
      sessionId,
      token,
      authorityId,
      keyKind,
      keyValue,
      alias = null,
    } = {}) {
      const payload = await postOwnedExploration(authorityId, "/targets/claim", {
        sessionId, token, keyKind, keyValue, alias,
      });
      if (!payload?.target) {
        throw runtimeError("EXPLORATION_TARGET_RESPONSE_INVALID", "exploration target claim response is malformed", 502);
      }
      return payload.target;
    },

    async confirmExplorationTarget({
      sessionId,
      token,
      authorityId,
      targetId,
      stableKeyValue = null,
    } = {}) {
      const payload = await postOwnedExploration(authorityId, "/targets/claim", {
        sessionId, token, action: "confirm", targetId, stableKeyValue,
      });
      if (!payload?.target) {
        throw runtimeError("EXPLORATION_TARGET_RESPONSE_INVALID", "exploration target confirmation response is malformed", 502);
      }
      return payload.target;
    },

    async markExplorationTargetUnknown({ sessionId, token, authorityId, targetId } = {}) {
      const payload = await postOwnedExploration(authorityId, "/targets/claim", {
        sessionId, token, action: "unknown", targetId,
      });
      if (!payload?.target) {
        throw runtimeError("EXPLORATION_TARGET_RESPONSE_INVALID", "exploration target unknown response is malformed", 502);
      }
      return payload.target;
    },

    appendExplorationLaneRecord(input) {
      return appendExplorationLaneRecordRpc(input);
    },

    async commitExplorationLane({ sessionId, token, authorityId } = {}) {
      const payload = await postOwnedExploration(authorityId, "/journal", {
        sessionId, token, action: "commit",
      });
      if (!payload?.lane?.receiptHash) {
        throw runtimeError("EXPLORATION_JOURNAL_RESPONSE_INVALID", "exploration lane commit response is malformed", 502);
      }
      return payload.lane;
    },

    async closeExplorationAuthority({ sessionId, token, authorityId, reason = "run-finished" } = {}) {
      const payload = await postOwnedExploration(authorityId, "", {
        sessionId, token, action: "close", reason,
      });
      if (!payload?.authority) {
        throw runtimeError("EXPLORATION_AUTHORITY_RESPONSE_INVALID", "exploration authority close response is malformed", 502);
      }
      return payload.authority;
    },

    captureExplorationFrame(input) {
      return captureExplorationFrameRpc(input);
    },

    createExplorationVisionNavigator({
      mode,
      providerBinding,
      authorityId,
      sessionId,
      token,
      routineRunId,
      signal = null,
      clock = { nowMs: now },
      journalAppend = null,
    } = {}) {
      const owned = requireOwnedContext(contexts, sessionId, token);
      if (!authorityId) {
        throw runtimeError("EXPLORATION_AUTHORITY_ID_REQUIRED", "vision navigator requires its exploration authority", 400);
      }
      const append = journalAppend || (async (record = {}) => {
        const { type, ...payload } = record;
        return appendExplorationLaneRecordRpc({
          sessionId,
          token,
          authorityId,
          alias: owned.alias,
          type: type || "VISION_DECISION",
          payload,
        });
      });
      return explorationVisionFactory({
        mode,
        alias: owned.alias,
        providerBinding,
        captureFrame: () => captureExplorationFrameRpc({
          sessionId, token, routineRunId, signal,
        }),
        reserveAnalysisAttempt: (detail = null) => reserveExplorationVisionAnalysisRpc({
          sessionId,
          token,
          authorityId,
          detail,
        }),
        settleAnalysisAttempt: ({ reservationId, outcome, result = null } = {}) => settleExplorationVisionAnalysisRpc({
          sessionId, token, authorityId, reservationId, outcome, result,
        }),
        journalAppend: append,
        signal,
        clock,
        configPath: explorationVisionConfigPath,
        allowTestConfigOverride: allowTestEndpoints,
      });
    },

    // --- routine authority (plan V2 §8.1.3): the formal session is the ONLY
    // key that may register/commit/close; the CP seals the canary policy and
    // re-validates every cap server-side. The token travels in the body like
    // every other session RPC and never leaves this process otherwise.

    async registerRoutineAuthority({
      sessionId,
      token,
      executionRunId,
      routineRunId,
      planHash,
      effectCaps = {},
      canaryAuthorized = false,
      accountFingerprint = null,
    } = {}) {
      const owned = requireOwnedContext(contexts, sessionId, token);
      // sessionId MUST travel in the body: the CP router keys registration off
      // input.sessionId (the token alone only authenticates it server-side)
      const payload = await postJson(`${control}/control/v1/routine-authority`, {
        token,
        sessionId,
        executionRunId,
        routineRunId,
        planHash,
        alias: owned.alias,
        effectCaps,
        canaryAuthorized,
        accountFingerprint,
      }, { fetchImpl });
      if (!payload?.authority?.authorityId) {
        throw runtimeError("ROUTINE_AUTHORITY_RESPONSE_INVALID", "authority registration response is malformed", 502);
      }
      return payload.authority;
    },

    async commitRoutineAuthorityEffect({ sessionId, token, authorityId, intent }) {
      requireOwnedContext(contexts, sessionId, token);
      if (!authorityId || typeof authorityId !== "string") {
        throw runtimeError("ROUTINE_AUTHORITY_RESPONSE_INVALID", "commitRoutineAuthorityEffect requires an authorityId", 400);
      }
      const payload = await postJson(
        `${control}/control/v1/routine-authority/${encodeURIComponent(authorityId)}/effects`,
        { token, intent: intent ?? {} },
        { fetchImpl },
      );
      if (!payload?.effect || typeof payload.effect.outcome !== "string") {
        throw runtimeError("ROUTINE_AUTHORITY_RESPONSE_INVALID", "effect commit response is malformed", 502);
      }
      return payload.effect;
    },

    async reconcileRoutineAuthorityComments({ sessionId, token, authorityId, targetFingerprint = null } = {}) {
      requireOwnedContext(contexts, sessionId, token);
      if (!authorityId || typeof authorityId !== "string") {
        throw runtimeError("ROUTINE_AUTHORITY_RESPONSE_INVALID", "reconcile requires an authorityId", 400);
      }
      const payload = await postJson(
        `${control}/control/v1/routine-authority/${encodeURIComponent(authorityId)}/reconcile`,
        { token, targetFingerprint },
        { fetchImpl },
      );
      return Array.isArray(payload?.reconciles) ? payload.reconciles : [];
    },

    async closeRoutineAuthority({ sessionId, token, authorityId, reason = "run-finished" } = {}) {
      requireOwnedContext(contexts, sessionId, token);
      if (!authorityId || typeof authorityId !== "string") {
        throw runtimeError("ROUTINE_AUTHORITY_RESPONSE_INVALID", "close requires an authorityId", 400);
      }
      const payload = await postJson(
        `${control}/control/v1/routine-authority/${encodeURIComponent(authorityId)}`,
        { token, reason },
        { fetchImpl },
      );
      return payload?.authority ?? null;
    },
  };
}

export { readBoundUtf8Artifact, readBoundPngArtifact };
