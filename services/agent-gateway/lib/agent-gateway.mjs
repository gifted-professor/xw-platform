import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { ControlClient } from "../../../packages/control-client/lib/control-client.mjs";

// Agent Gateway. Maps a harness session onto a Control Plane device session.
// Forbidden: opening the control database, holding leases, ADB, transport port, payment decisions.

const FORBIDDEN = Object.freeze({
  readsControlDb: false,
  holdsDeviceLease: false,
  callsAdb: false,
  connects22222: false,
  decidesPayment: false,
});

export class AgentGateway {
  constructor({ controlBaseUrl, fetchImpl = fetch } = {}) {
    this.client = new ControlClient({ baseUrl: controlBaseUrl, fetchImpl });
    this.sessions = new Map();
  }

  get invariants() {
    return FORBIDDEN;
  }

  #require(harnessSessionId) {
    const row = this.sessions.get(harnessSessionId);
    if (!row) {
      const error = new Error("unknown harness session");
      error.code = "SESSION_KIND_MISMATCH";
      error.status = 404;
      throw error;
    }
    return row;
  }

  async attach({ actorId, deviceId = null } = {}) {
    const created = await this.client.createDeviceSession({ actorId, deviceId });
    const harnessSessionId = `harness_${randomUUID()}`;
    const row = {
      harnessSessionId,
      deviceSessionId: created.session.sessionId,
      token: created.token,
      history: [],
    };
    this.sessions.set(harnessSessionId, row);
    return {
      harnessSessionId,
      deviceSession: created.session,
      expiresAt: created.expiresAt,
    };
  }

  async observe(harnessSessionId) {
    const row = this.#require(harnessSessionId);
    const observed = await this.client.observe(row.deviceSessionId, row.token, {});
    row.history.push({ type: "observe", observationId: observed.observation.observationId });
    return observed;
  }

  async act(harnessSessionId, request) {
    const row = this.#require(harnessSessionId);
    const acted = await this.client.act(row.deviceSessionId, row.token, request);
    row.history.push({ type: "act", actionId: request?.action?.actionId, reused: acted.reused });
    return acted;
  }

  async verify(harnessSessionId) {
    const row = this.#require(harnessSessionId);
    const events = await this.client.events(row.deviceSessionId, row.token, 0);
    const types = (events.events || []).map((event) => event.type);
    return {
      ok: types.includes("primitive.verified") || types.includes("primitive.rejected"),
      types,
      history: row.history,
    };
  }

  async trace(harnessSessionId) {
    const row = this.#require(harnessSessionId);
    const events = await this.client.events(row.deviceSessionId, row.token, 0);
    return { harnessSessionId, deviceSessionId: row.deviceSessionId, events: events.events || [], history: row.history };
  }

  async release(harnessSessionId) {
    const row = this.#require(harnessSessionId);
    const released = await this.client.release(row.deviceSessionId, row.token);
    this.sessions.delete(harnessSessionId);
    return released;
  }
}

export function createAgentGatewayServer({ gateway, host = "127.0.0.1", port = 0 } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, body) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    };
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      if (req.method === "POST" && url.pathname === "/agent/v1/sessions/attach") {
        return send(201, await gateway.attach(body));
      }
      const match = url.pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/(observe|act|verify|trace|release)$/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        if (match[2] === "observe") return send(200, await gateway.observe(id));
        if (match[2] === "act") return send(200, await gateway.act(id, body));
        if (match[2] === "verify") return send(200, await gateway.verify(id));
        if (match[2] === "trace") return send(200, await gateway.trace(id));
        if (match[2] === "release") return send(200, await gateway.release(id));
      }
      return send(404, { ok: false, error: { code: "NOT_FOUND" } });
    } catch (error) {
      return send(error.status || 500, {
        ok: false,
        error: { code: error.code || "GATEWAY_ERROR", message: error.message },
      });
    }
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}
