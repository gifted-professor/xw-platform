import { canonicalJson, sha256 } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";
import { assertM6FileDbPointerConsistency } from "./m6-gate-promoter.mjs";
import { loadM6Gate } from "./m6-gate-loader.mjs";
import { M6_LIVE_TOOL_NAMES, validateLiveToolCall, validateLiveToolResult } from "../../../orchestrator/scripts/lib/m6/m6-live-tool-surface.mjs";

function reject(code, message, details = {}) {
  throw new ControlPlaneError(code, message, { status: 409, details });
}

function sameBinding(expected, actual) {
  return expected && actual && canonicalJson(expected) === canonicalJson(actual);
}

function assertFence(state, binding, authorizationId, nowMs, readGateSnapshot) {
  const fence = state.getM6GateFence();
  const requiredFenceMode = binding.purpose === "M6_4_SHADOW" ? "OBSERVE_ONLY" : "GROUNDED_ACTION";
  const matches = fence
    && fence.mode === requiredFenceMode
    && fence.epochHash === binding.gateEpochHash
    && fence.generation === binding.generation
    && fence.purpose === binding.purpose
    && canonicalJson(fence.allowlist) === canonicalJson(["01"])
    && Date.parse(fence.expiresAt) > nowMs;
  if (!matches) reject("M6_LIVE_BROKER_GATE_FENCE_MISMATCH", "current DB fence no longer authorizes this child binding", {
    expectedEpochHash: binding.gateEpochHash,
    actualEpochHash: fence?.epochHash ?? null,
    expectedGeneration: binding.generation,
    actualGeneration: fence?.generation ?? null,
  });
  const loaded = readGateSnapshot();
  assertM6FileDbPointerConsistency({ loaded, fence, pointer: loaded?.currentPointer });
  const consumption = state.getM64LiveWindowAuthorizationConsumption(authorizationId);
  if (!consumption
    || consumption.envelopeHash !== binding.liveWindowAuthorizationHash
    || consumption.gateId !== fence.gateId
    || consumption.gateEpochHash !== binding.gateEpochHash
    || consumption.gateGeneration !== binding.generation
    || consumption.purpose !== binding.purpose
    || Date.parse(consumption.expiresAt) <= nowMs) {
    reject("M6_LIVE_BROKER_AUTH_CONSUMPTION_MISMATCH", "the one-time live-window authorization is absent, expired, or rebound");
  }
  return { fence, consumption };
}

export function createM6LiveBrokerHandler({
  state,
  runManager,
  binding,
  authorizationId,
  now = Date.now,
  m6Root,
  gateId,
  issuerAllowlistPath,
  loadGateSnapshot = null,
} = {}) {
  if (!state || typeof state.getM6GateFence !== "function" || typeof state.getM64LiveWindowAuthorizationConsumption !== "function") {
    throw new TypeError("M6 live broker requires StateStore v20 gate and authorization APIs");
  }
  if (!runManager || typeof runManager.handleToolCall !== "function" || typeof runManager.getRunBinding !== "function") {
    throw new TypeError("M6 live broker requires a production run manager");
  }
  if (!binding || typeof authorizationId !== "string" || authorizationId === "") throw new TypeError("M6 live broker requires exact binding and authorizationId");
  const readGateSnapshot = typeof loadGateSnapshot === "function"
    ? loadGateSnapshot
    : () => {
      if (typeof m6Root !== "string" || typeof gateId !== "string" || typeof issuerAllowlistPath !== "string") {
        throw new TypeError("M6 live broker requires the sealed gate root, gateId, and issuer allowlist path");
      }
      return loadM6Gate({ m6Root, gateId, issuerAllowlistPath, requireLocks: true });
    };

  return async function handleM6LiveToolCall(input = {}) {
    const method = input.method;
    const params = input.params;
    const callBinding = input.binding;
    if (!M6_LIVE_TOOL_NAMES.includes(method)) reject("M6_LIVE_TOOL_FORBIDDEN", "method is outside the exact ten-tool inventory");
    const callValidation = validateLiveToolCall({ tool: method, args: params });
    if (!callValidation.ok) reject(callValidation.errors[0], `live tool input rejected: ${callValidation.errors.join(",")}`);
    if (!sameBinding(binding, callBinding) || !sameBinding(binding, runManager.getRunBinding(binding.runId))) {
      reject("M6_LIVE_BROKER_RUN_BINDING_MISMATCH", "broker, child and server-owned run bindings differ");
    }
    const linearization = assertFence(state, binding, authorizationId, now(), readGateSnapshot);
    const result = await runManager.handleToolCall({
      method,
      params,
      binding,
      fence: linearization.fence,
      authorizationConsumption: linearization.consumption,
      signal: input.signal,
    });
    const resultValidation = validateLiveToolResult({ tool: method, result });
    if (!resultValidation.ok) reject(resultValidation.errors[0], `live tool result rejected: ${resultValidation.errors.join(",")}`);
    return result;
  };
}

export function deriveM6LiveBrokerErrorRef(code, bindingHash) {
  return sha256(`xw.m6-live-broker-error.v1:${code}:${bindingHash}`);
}
