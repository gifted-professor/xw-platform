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

// Mission policy is authoritative control-plane state, but not a public API payload. In
// particular, account aliases, target fingerprints, controller identities, idempotency keys,
// and policy/redaction internals must not leave the control-plane boundary through list, submit,
// show, or revoke responses.
function publicMissionView(mission) {
  if (!mission) return mission;
  const {
    missionId,
    version,
    missionHash,
    app,
    status,
    createdAt,
    updatedAt,
    expiresAt,
    revokedAt,
    revokedReason,
  } = mission;
  const sourceScope = mission.scope && typeof mission.scope === "object" ? mission.scope : {};
  const sourceTargets = sourceScope.targets && typeof sourceScope.targets === "object" ? sourceScope.targets : {};
  const frequency = sourceScope.frequency && typeof sourceScope.frequency === "object" ? sourceScope.frequency : {};
  return {
    missionId,
    version,
    missionHash,
    app,
    status,
    createdAt,
    updatedAt,
    expiresAt,
    revokedAt,
    revokedReason,
    scope: {
      actions: Array.isArray(sourceScope.actions) ? sourceScope.actions.filter((action) => typeof action === "string") : [],
      targetKind: typeof sourceTargets.kind === "string" ? sourceTargets.kind : null,
      targetCount: Array.isArray(sourceTargets.values) ? sourceTargets.values.length : 0,
      totalCount: Number.isSafeInteger(sourceScope.totalCount) ? sourceScope.totalCount : 0,
      perTargetCount: Number.isSafeInteger(sourceScope.perTargetCount) ? sourceScope.perTargetCount : 0,
      frequency: {
        count: Number.isSafeInteger(frequency.count) ? frequency.count : 0,
        windowSeconds: Number.isSafeInteger(frequency.windowSeconds) ? frequency.windowSeconds : 0,
      },
    },
  };
}

function publicMissionSubmission(result) {
  const { mission, run, ...safe } = result;
  return {
    ...safe,
    mission: publicMissionView(mission),
    ...(run ? {
      run: {
        deviceRunId: run.deviceRunId,
        missionId: run.missionId,
        phase: run.phase,
        createdAt: run.createdAt,
      },
    } : {}),
  };
}

function publicGrantView(grant) {
  if (!grant) return grant;
  const {
    grantId,
    grantHash,
    status,
    createdAt,
    updatedAt,
    expiresAt,
    revokedAt,
    revokedReason,
  } = grant;
  return { grantId, grantHash, status, createdAt, updatedAt, expiresAt, revokedAt, revokedReason };
}

export class ControlRouter {
  constructor({ control, state, capabilities, evidence, delegationGrants = null, canaryEvidenceAuthorizer = null, nodeId = "DESKTOP-3I1EVHE" }) {
    this.control = control;
    this.state = state;
    this.capabilities = capabilities;
    this.evidence = evidence;
    this.delegationGrants = delegationGrants;
    this.canaryEvidenceAuthorizer = canaryEvidenceAuthorizer;
    this.nodeId = nodeId;
  }

  async handle({ method, path, query = new URLSearchParams(), body, headers = {} }) {
    let match;
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
          // REX Phase 5 B7: 暴露运行时策略模式与 release id（部署时由 worker 从 launch config 注入）。
          policyMode: this.control?.policyMode ?? null,
          ...(process.env.CONTROL_PLANE_RELEASE_ID ? { releaseId: process.env.CONTROL_PLANE_RELEASE_ID } : {}),
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

    if (method === "POST" && path === "/control/v1/grants") {
      if (!this.delegationGrants) throw new ControlPlaneError("STANDING_GRANT_ISSUER_UNAVAILABLE", "signed Standing Grant installation is unavailable", { status: 503 });
      const result = this.delegationGrants.issue(requireBody(body));
      return { status: result.reused ? 200 : 201, body: { grant: publicGrantView(result.grant), reused: result.reused } };
    }
    if (method === "GET" && path === "/control/v1/grants") {
      const grants = this.delegationGrants ? this.delegationGrants.list() : this.state.listDelegationGrants();
      return { status: 200, body: { grants: grants.map(publicGrantView) } };
    }
    match = path.match(/^\/control\/v1\/grants\/([^/]+)$/);
    if (method === "GET" && match) {
      const grantId = decodeURIComponent(match[1]);
      const grant = this.delegationGrants ? this.delegationGrants.show(grantId) : this.state.getDelegationGrant(grantId);
      if (!grant) throw new ControlPlaneError("GRANT_NOT_FOUND", `unknown delegation grant ${grantId}`, { status: 404 });
      return { status: 200, body: { grant: publicGrantView(grant) } };
    }
    match = path.match(/^\/control\/v1\/grants\/([^/]+)\/revoke$/);
    if (method === "POST" && match) {
      if (!this.delegationGrants) throw new ControlPlaneError("STANDING_GRANT_ISSUER_UNAVAILABLE", "signed Standing Grant revocation is unavailable", { status: 503 });
      return { status: 200, body: { grant: publicGrantView(this.delegationGrants.revoke(decodeURIComponent(match[1]), requireBody(body))) } };
    }
    if (method === "POST" && path === "/control/v1/leases/authorize") {
      const input = requireBody(body);
      const lease = this.state.authorizeLease({
        leaseId: input.leaseId,
        token: tokenOf(input, headers),
        deviceId: input.deviceId,
        runtimeId: input.runtimeId,
      });
      return {
        status: 200,
        body: {
          ok: true,
          authorized: true,
          lease: {
            leaseId: lease.leaseId,
            deviceId: lease.deviceId,
            kind: lease.kind,
            expiresAt: lease.expiresAt,
          },
        },
      };
    }

    match = path.match(/^\/control\/v1\/jobs\/([^/]+)$/);
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
      const marker = this.state.getStandingGrantCanary?.();
      const canaryJob = marker?.collect_job_id ? this.state.getJob?.(marker.collect_job_id) : null;
      if (canaryJob?.runId === runId && (!this.canaryEvidenceAuthorizer || !this.canaryEvidenceAuthorizer({ runId, headers }))) {
        throw new ControlPlaneError("EVIDENCE_ACCESS_DENIED", "canary evidence requires server-authenticated owner or reviewer access", { status: 403 });
      }
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
    match = path.match(/^\/control\/v1\/jobs\/([^/]+)\/recover$/);
    if (method === "POST" && match) {
      const input = requireBody(body);
      return {
        status: 200,
        body: {
          recovery: await this.control.recoverJob({
            jobId: decodeURIComponent(match[1]),
            actorId: input.actorId,
            idempotencyKey: input.idempotencyKey,
          }),
        },
      };
    }
    match = path.match(/^\/control\/v1\/jobs\/([^/]+)\/recover\/inspect$/);
    if (method === "POST" && match) {
      const input = requireBody(body);
      return {
        status: 200,
        body: {
          inspection: await this.control.inspectRecovery({
            jobId: decodeURIComponent(match[1]),
            actorId: input.actorId,
            idempotencyKey: input.idempotencyKey,
          }),
        },
      };
    }
    match = path.match(/^\/control\/v1\/jobs\/([^/]+)\/recover\/inspect\/([^/]+)\/analysis$/);
    if (method === "POST" && match) {
      const input = requireBody(body);
      return {
        status: 200,
        body: {
          analysis: await this.control.recordRecoveryInspectionAnalysis({
            jobId: decodeURIComponent(match[1]),
            inspectionId: decodeURIComponent(match[2]),
            actorId: input.actorId,
            idempotencyKey: input.idempotencyKey,
            analysis: input.analysis,
          }),
        },
      };
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

    if (method === "POST" && path === "/control/v1/missions/primitives") {
      const input = requireBody(body);
      const result = await this.control.executeMissionPrimitive(input.tuple, {
        primitive: input.primitive,
        envelope: input.envelope,
      });
      return { status: 200, body: { ...result } };
    }
    if (method === "POST" && path === "/control/v1/missions/submit") {
      const input = requireBody(body);
      const result = this.control.submitMission(input);
      return { status: result.status === "blocked" ? 200 : 201, body: publicMissionSubmission(result) };
    }
    if (method === "POST" && path === "/control/v1/missions/collect-canary") {
      return { status: 200, body: await this.control.runStandingGrantCollectCanary(requireBody(body)) };
    }
    if (method === "GET" && path === "/control/v1/missions") {
      return { status: 200, body: { missions: this.state.listMissions().map(publicMissionView) } };
    }
    match = path.match(/^\/control\/v1\/missions\/([^/]+)$/);
    if (method === "GET" && match) {
      const result = this.control.showMission(decodeURIComponent(match[1]));
      return { status: 200, body: { ...result, mission: publicMissionView(result.mission) } };
    }
    match = path.match(/^\/control\/v1\/missions\/([^/]+)\/status$/);
    if (method === "GET" && match) {
      return { status: 200, body: { ...this.control.missionStatus(decodeURIComponent(match[1])) } };
    }
    match = path.match(/^\/control\/v1\/missions\/([^/]+)\/device-runs$/);
    if (method === "GET" && match) {
      return {
        status: 200,
        body: {
          deviceRuns: this.control.deviceRuns.listDeviceRuns({ missionId: decodeURIComponent(match[1]) }),
        },
      };
    }
    match = path.match(/^\/control\/v1\/missions\/([^/]+)\/revoke$/);
    if (method === "POST" && match) {
      const input = requireBody(body);
      return {
        status: 200,
        body: { mission: publicMissionView(this.control.revokeMission(decodeURIComponent(match[1]), input)) },
      };
    }

    match = path.match(/^\/control\/v1\/approvals\/([^/]+)$/);
    if (method === "POST" && match) {
      return {
        status: 200,
        body: { job: publicJob(this.control.decideApproval(decodeURIComponent(match[1]), requireBody(body))) },
      };
    }

    // REX Phase 2 收尾: payment control surface. list is read-only (no secrets in the DTO);
    // decide is the only path that can terminal a financial_commit. transport stays 0 until an
    // Ed25519-verified human approval is presented for the exact binding.
    if (method === "GET" && path === "/control/v1/payment-commits") {
      return { status: 200, body: { paymentCommits: this.control.listPaymentCommits() } };
    }
    match = path.match(/^\/control\/v1\/payment-commits\/([^/]+)\/decide$/);
    if (method === "POST" && match) {
      const input = requireBody(body);
      const result = await this.control.decidePaymentCommit(decodeURIComponent(match[1]), {
        decision: input.decision,
        approval: input.approval ?? null,
        actorId: input.actorId ?? null,
      });
      return { status: 200, body: { paymentCommit: result } };
    }

    throw new ControlPlaneError("ROUTE_NOT_FOUND", `${method} ${path} not found`, { status: 404 });
  }
}
