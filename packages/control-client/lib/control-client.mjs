// Upper-layer Control Plane client. This is the only package Gateway/CLI may use
// to talk to device sessions. It never opens the control database, ADB, or the transport port.

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
}
