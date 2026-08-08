/**
 * TypedTransport interface + fake (Foundation PR2).
 * Real FastOperator/Gateway/Xiaowei wiring is PR3 — adapters must inject this boundary.
 */

export const TYPED_TRANSPORT_PURPOSES = Object.freeze([
  "execute",
  "verify",
  "restore",
  "return_home",
  "observe",
]);

/**
 * @typedef {object} TypedTransport
 * @property {(req: { purpose: string, action: string, params?: object }) => Promise<object>} invoke
 */

export function assertTypedTransport(transport) {
  if (!transport || typeof transport.invoke !== "function") {
    throw Object.assign(new Error("TypedTransport.invoke is required"), { code: "TYPED_TRANSPORT_REQUIRED" });
  }
  return transport;
}

/** In-memory fake for offline Adapter injection tests. */
export function createFakeTypedTransport({ handler } = {}) {
  const calls = [];
  const transport = {
    calls,
    async invoke(request) {
      if (!request || typeof request !== "object") {
        throw Object.assign(new Error("transport request required"), { code: "TYPED_TRANSPORT_INVALID" });
      }
      if (!TYPED_TRANSPORT_PURPOSES.includes(request.purpose)) {
        throw Object.assign(new Error(`unsupported purpose ${request.purpose}`), { code: "TYPED_TRANSPORT_PURPOSE" });
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
 * Production adapters in PR3 must follow the same injection shape.
 */
export function createInjectedAdapter({ transport, actionHandlers = {} }) {
  const typed = assertTypedTransport(transport);
  return {
    transport: typed,
    async execute({ action, params = {}, purpose = "execute" } = {}) {
      if (typeof action !== "string" || !action) {
        throw Object.assign(new Error("action required"), { code: "ADAPTER_ACTION_REQUIRED" });
      }
      if (Object.prototype.hasOwnProperty.call(actionHandlers, action)) {
        return actionHandlers[action]({ params, purpose, transport: typed });
      }
      return typed.invoke({ purpose, action, params });
    },
  };
}
