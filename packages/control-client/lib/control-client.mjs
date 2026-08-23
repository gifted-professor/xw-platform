// Upper-layer Control Plane client. This is the only package Gateway/CLI may use
// to talk to device sessions. It never opens durable authority storage or a raw device transport.

export class ControlClient {
  constructor({ baseUrl, token, fetchImpl = fetch } = {}) {
    if (!baseUrl) throw new Error("control-client requires baseUrl");
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.token = token || null;
    this.fetchImpl = fetchImpl;
  }

  #headers(extra = {}) {
    const headers = { "content-type": "application/json", ...extra };
    if (this.token) headers["x-control-token"] = this.token;
    return headers;
  }

  async #request(method, path, { body, token } = {}) {
    const headers = this.#headers(token ? { "x-control-token": token } : {});
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const error = new Error(parsed?.error?.message || parsed?.message || `control-plane ${response.status}`);
      error.code = parsed?.error?.code || "CONTROL_CLIENT_HTTP";
      error.status = response.status;
      error.details = parsed?.error?.details || parsed;
      throw error;
    }
    return parsed;
  }

  createDeviceSession(input) {
    return this.#request("POST", "/control/v1/device-sessions", { body: input });
  }

  getDeviceSession(sessionId, token) {
    return this.#request("GET", `/control/v1/device-sessions/${encodeURIComponent(sessionId)}`, { token });
  }

  observe(sessionId, token, input = {}) {
    return this.#request("POST", `/control/v1/device-sessions/${encodeURIComponent(sessionId)}/observe`, { body: input, token });
  }

  act(sessionId, token, request) {
    return this.#request("POST", `/control/v1/device-sessions/${encodeURIComponent(sessionId)}/actions`, { body: request, token });
  }

  events(sessionId, token, after = 0) {
    return this.#request("GET", `/control/v1/device-sessions/${encodeURIComponent(sessionId)}/events?after=${Number(after) || 0}`, { token });
  }

  release(sessionId, token) {
    return this.#request("POST", `/control/v1/device-sessions/${encodeURIComponent(sessionId)}/release`, { body: {}, token });
  }

  // --- M6-2 closed frame capture namespace --------------------------------
  // These are the ONLY M6 client methods. The server enforces input closure
  // (closedM6Input) and gate/profile fail-closed; the client just forwards the
  // alias + scenarioLabel + idempotencyKey the caller typed. Never a coordinate,
  // action token, or session token — the receipt carries no device secret.
  m6Preflight(input = {}) {
    return this.#request("POST", "/control/v1/m6/frames/preflight", { body: input });
  }

  m6Capture(input = {}) {
    return this.#request("POST", "/control/v1/m6/frames/capture", { body: input });
  }

  m6Status(attemptId) {
    return this.#request("GET", `/control/v1/m6/frames/status?attemptId=${encodeURIComponent(attemptId)}`);
  }

  m6Closeout(input = {}) {
    return this.#request("POST", "/control/v1/m6/frames/closeout", { body: input });
  }

  // --- M6 Gate-F operator namespace ---------------------------------------
  // This remains an HTTP-only client. It never opens durable authority storage and never
  // writes an epoch, fence, or current.json pointer locally.
  m6GateFStatus() {
    return this.#request("GET", "/control/v1/internal/m6/gate-f/status");
  }

  m6GateFPreflight(input = {}) {
    return this.#request("POST", "/control/v1/internal/m6/gate-f/preflight", { body: input });
  }

  m6GateFActivate(input = {}) {
    return this.#request("POST", "/control/v1/internal/m6/gate-f/activate", { body: input });
  }

  m6GateFClose(input = {}) {
    return this.#request("POST", "/control/v1/internal/m6/gate-f/close", { body: input });
  }

  m6GateFReconcile(input = {}) {
    return this.#request("POST", "/control/v1/internal/m6/gate-f/reconcile", { body: input });
  }
}
