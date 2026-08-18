/**
 * TypedTransport Phase 1 (Foundation PR3 / INV-08).
 * Adapters must use an injected transport; raw Gateway/Xiaowei stay behind this boundary.
 */

import { ControlPlaneError } from "./errors.mjs";
import { TRANSPORT_AUTH_PURPOSES, isWritePurpose } from "./transport-action-authorization.mjs";

export { TRANSPORT_AUTH_PURPOSES };

export function assertTypedTransport(transport) {
  if (!transport || typeof transport.invoke !== "function") {
    throw new ControlPlaneError("TYPED_TRANSPORT_REQUIRED", "TypedTransport.invoke is required", { status: 400 });
  }
  return transport;
}

/**
 * Wrap an underlying invoke with one-time transport auth consumption.
 * @param {{ consume: Function, underlyingInvoke: Function }} opts
 */
export function createAuthorizedTypedTransport({
  consume,
  underlyingInvoke,
  defaultDeviceId = null,
  defaultLeaseId = null,
} = {}) {
  if (typeof consume !== "function") {
    throw new ControlPlaneError("TYPED_TRANSPORT_REQUIRED", "consume(callback) is required", { status: 400 });
  }
  if (typeof underlyingInvoke !== "function") {
    throw new ControlPlaneError("TYPED_TRANSPORT_REQUIRED", "underlyingInvoke is required", { status: 400 });
  }

  return assertTypedTransport({
    async invoke(request = {}) {
      const purpose = request.purpose;
      if (!TRANSPORT_AUTH_PURPOSES.includes(purpose)) {
        throw new ControlPlaneError("TYPED_TRANSPORT_PURPOSE", `unsupported purpose ${purpose}`, { status: 400 });
      }
      const token = request.transportToken || request.token;
      if (!token?.authorizationId || !token?.nonce) {
        throw new ControlPlaneError(
          "TRANSPORT_AUTH_TOKEN_INVALID",
          "typed transport requires transportToken { authorizationId, nonce }",
          { status: 403, details: { purpose, write: isWritePurpose(purpose) } },
        );
      }
      // Consume before any device I/O — replay/expiry fail closed with 0 underlying call.
      await consume({
        authorizationId: token.authorizationId,
        token,
        expectedPurpose: purpose,
        expectedDeviceId: request.deviceId || defaultDeviceId,
        expectedLeaseId: request.leaseId || defaultLeaseId,
      });
      return underlyingInvoke({
        ...request,
        purpose,
        transportToken: undefined,
        token: undefined,
      });
    },
  });
}

/** Fake transport for offline Adapter tests (no device I/O). */
export function createFakeTypedTransport({ handler } = {}) {
  const calls = [];
  return assertTypedTransport({
    calls,
    async invoke(request) {
      if (!TRANSPORT_AUTH_PURPOSES.includes(request?.purpose)) {
        throw new ControlPlaneError("TYPED_TRANSPORT_PURPOSE", `unsupported purpose ${request?.purpose}`, { status: 400 });
      }
      calls.push({ ...request, at: new Date().toISOString() });
      if (typeof handler === "function") return handler(request, calls);
      return { ok: true, purpose: request.purpose, action: request.action, echo: request.params || null };
    },
  });
}
