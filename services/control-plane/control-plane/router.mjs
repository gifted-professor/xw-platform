import { ControlPlaneError } from "./lib/errors.mjs";

function requireBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ControlPlaneError("BODY_REQUIRED", "JSON object body is required");
  }
  return body;
}

function tokenOf(body, headers = {}) {
  return headers["x-control-token"] || headers["X-Control-Token"] || body?.token;
}

function publicJob(job) {
  if (!job) return job;
  const { params, capability, ...safe } = job;
  return {
    ...safe,
    paramKeys: Object.keys(params || {}).sort(),
    capability: capability ? {
      id: capability.id,
      appId: capability.appId,
      maturity: capability.maturity,
      risk: capability.risk,
      verification: capability.verification,
      restoration: capability.restoration,
    } : null,
  };
}

export class ControlRouter {
  constructor({ control, state, capabilities, evidence, nodeId = "DESKTOP-3I1EVHE" }) {
    this.control = control;
    this.state = state;
    this.capabilities = capabilities;
    this.evidence = evidence;
    this.nodeId = nodeId;
  }

  async handle({ method, path, query = new URLSearchParams(), body, headers = {} }) {
    if (method === "GET" && path === "/control/v1/health") {
      const freeBytes = this.evidence.freeBytes();
      return {
        status: 200,
        body: {
          ok: true,
          nodeId: this.nodeId,
          authority: true,
          node: process.versions.node,
          sqlite: "node:sqlite",
          devices: this.state.listDevices().length,
          capabilities: this.capabilities.capabilities.length,
          activeLeases: this.state.listLeases().length,
          evidenceFreeBytes: freeBytes,
          externalEffectsBlockedForLowDisk: freeBytes < this.evidence.minExternalEffectFreeBytes,
        },
      };
    }
    if (method === "GET" && path === "/control/v1/devices") {
      return { status: 200, body: { devices: this.state.listDevices() } };
    }
    if (method === "GET" && path === "/control/v1/nodes") {
      return { status: 200, body: { nodes: this.control.listNodes() } };
    }
    if (method === "GET" && path === "/control/v1/capabilities") {
      return { status: 200, body: { capabilities: this.capabilities.listPublic() } };
    }
    if (method === "GET" && path === "/control/v1/leases") {
      return { status: 200, body: { leases: this.state.listLeases() } };
    }

    let match = path.match(/^\/control\/v1\/jobs\/([^/]+)$/);
    if (method === "GET" && match) {
      return { status: 200, body: { job: publicJob(this.state.requireJob(decodeURIComponent(match[1]))) } };
    }
    match = path.match(/^\/control\/v1\/jobs\/([^/]+)\/events$/);
    if (method === "GET" && match) {
      const after = Number(query.get("after") || 0);
      return {
        status: 200,
        body: { events: this.state.listJobEvents(decodeURIComponent(match[1]), Number.isFinite(after) ? after : 0) },
      };
    }
    match = path.match(/^\/control\/v1\/runs\/([^/]+)\/evidence$/);
    if (method === "GET" && match) {
      const runId = decodeURIComponent(match[1]);
      return {
        status: 200,
        body: { manifest: this.evidence.getManifest(runId), evidence: this.state.listEvidence(runId) },
      };
    }

    if (method === "POST" && path === "/control/v1/jobs") {
      const created = this.control.submitJob(requireBody(body));
      return { status: 202, body: { ...created, job: publicJob(created.job) } };
    }
    if (method === "POST" && path === "/control/v1/routes/plan") {
      return { status: 200, body: { route: this.control.planRoute(requireBody(body)) } };
    }
    if (method === "POST" && path === "/control/v1/legacy-events") {
      const input = requireBody(body);
      const eventId = this.state.appendEvent({
        type: "legacy.ui_route",
        payload: {
          source: String(input.source || "unknown").slice(0, 80),
          action: String(input.action || "unknown").slice(0, 80),
          actorPresent: Boolean(input.actorPresent),
          mode: String(input.mode || "audit").slice(0, 20),
        },
      });
      return { status: 202, body: { accepted: true, eventId } };
    }
    match = path.match(/^\/control\/v1\/jobs\/([^/]+)\/cancel$/);
    if (method === "POST" && match) {
      return { status: 200, body: { job: publicJob(this.control.cancelJob(decodeURIComponent(match[1]))) } };
    }

    if (method === "POST" && path === "/control/v1/sessions") {
      return { status: 201, body: { session: this.control.createSession(requireBody(body)) } };
    }
    match = path.match(/^\/control\/v1\/sessions\/([^/]+)\/heartbeat$/);
    if (method === "POST" && match) {
      const input = requireBody(body);
      return {
        status: 200,
        body: { session: this.control.heartbeatSession(decodeURIComponent(match[1]), tokenOf(input, headers)) },
      };
    }
    match = path.match(/^\/control\/v1\/sessions\/([^/]+)\/release$/);
    if (method === "POST" && match) {
      const input = requireBody(body);
      return {
        status: 200,
        body: this.control.releaseSession(decodeURIComponent(match[1]), tokenOf(input, headers)),
      };
    }
    match = path.match(/^\/control\/v1\/sessions\/([^/]+)\/actions$/);
    if (method === "POST" && match) {
      const input = requireBody(body);
      const { token, ...action } = input;
      return {
        status: 200,
        body: { job: publicJob(await this.control.executeSessionAction(decodeURIComponent(match[1]), tokenOf(input, headers), action)) },
      };
    }

    match = path.match(/^\/control\/v1\/approvals\/([^/]+)$/);
    if (method === "POST" && match) {
      return {
        status: 200,
        body: { job: publicJob(this.control.decideApproval(decodeURIComponent(match[1]), requireBody(body))) },
      };
    }
    throw new ControlPlaneError("ROUTE_NOT_FOUND", `${method} ${path} not found`, { status: 404 });
  }
}
