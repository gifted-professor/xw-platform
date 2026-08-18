/**
 * TypedTransport interface + fake + authorized wrapper (Foundation PR2/PR3).
 * Registry twin — durable CP mint/consume lives on Windows routing StateStore.
 */

import {
  TRANSPORT_AUTH_PURPOSES,
  isWritePurpose,
} from "./transport-action-authorization.mjs";

export const TYPED_TRANSPORT_PURPOSES = TRANSPORT_AUTH_PURPOSES;

function fail(code, message, status = 400, details = undefined) {
  return Object.assign(new Error(message), { code, status, details });
}

/**
 * @typedef {object} TypedTransport
 * @property {(req: { purpose: string, action: string, params?: object }) => Promise<object>} invoke
 */

export function assertTypedTransport(transport) {
  if (!transport || typeof transport.invoke !== "function") {
    throw fail("TYPED_TRANSPORT_REQUIRED", "TypedTransport.invoke is required");
  }
  return transport;
}

/**
 * Wrap an underlying invoke with one-time transport auth consumption.
 */
export function createAuthorizedTypedTransport({
  consume,
  underlyingInvoke,
  defaultDeviceId = null,
  defaultLeaseId = null,
} = {}) {
  if (typeof consume !== "function") {
    throw fail("TYPED_TRANSPORT_REQUIRED", "consume(callback) is required");
  }
  if (typeof underlyingInvoke !== "function") {
    throw fail("TYPED_TRANSPORT_REQUIRED", "underlyingInvoke is required");
  }

  return assertTypedTransport({
    async invoke(request = {}) {
      const purpose = request.purpose;
      if (!TRANSPORT_AUTH_PURPOSES.includes(purpose)) {
        throw fail("TYPED_TRANSPORT_PURPOSE", `unsupported purpose ${purpose}`);
      }
      const token = request.transportToken || request.token;
      if (!token?.authorizationId || !token?.nonce) {
        throw fail(
          "TRANSPORT_AUTH_TOKEN_INVALID",
          "typed transport requires transportToken { authorizationId, nonce }",
          403,
          { purpose, write: isWritePurpose(purpose) },
        );
      }
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

/** In-memory fake for offline Adapter injection tests. */
export function createFakeTypedTransport({ handler } = {}) {
  const calls = [];
  const transport = {
    calls,
    async invoke(request) {
      if (!request || typeof request !== "object") {
        throw fail("TYPED_TRANSPORT_INVALID", "transport request required");
      }
      if (!TYPED_TRANSPORT_PURPOSES.includes(request.purpose)) {
        throw fail("TYPED_TRANSPORT_PURPOSE", `unsupported purpose ${request.purpose}`);
      }
      calls.push({ ...request, at: new Date().toISOString() });
      if (typeof handler === "function") return handler(request, calls);
      return { ok: true, purpose: request.purpose, action: request.action, echo: request.params || null };
    },
  };
  return assertTypedTransport(transport);
}

/**
 * Minimal Adapter shell that refuses raw device channels and only uses injected transport.
 */
export function createInjectedAdapter({ transport, actionHandlers = {} }) {
  const typed = assertTypedTransport(transport);
  return {
    transport: typed,
    async execute({ action, params = {}, purpose = "execute" } = {}) {
      if (typeof action !== "string" || !action) {
        throw fail("ADAPTER_ACTION_REQUIRED", "action required");
      }
      if (Object.prototype.hasOwnProperty.call(actionHandlers, action)) {
        return actionHandlers[action]({ params, purpose, transport: typed });
      }
      return typed.invoke({ purpose, action, params });
    },
  };
}
