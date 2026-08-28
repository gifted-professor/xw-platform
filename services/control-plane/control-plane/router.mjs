import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ControlPlaneError } from "./lib/errors.mjs";
import { canonicalJson, sha256 } from "./lib/canonical.mjs";
import { RUNTIME_POLICY_VERSION } from "./lib/nonpayment-autonomy-policy.mjs";
import { LIVE_PROGRESS_CACHE_MS, readLiveProgressTail } from "../scripts/lib/stall-progress.mjs";
import { loadReleaseIdentity } from "../../../packages/release/lib/release-identity.mjs";

const HASH = /^[0-9a-f]{64}$/u;
const QUALIFICATION_CAPABILITY_ID = "xiaowei.m6.qualify_environment";
const QUALIFICATION_ACTOR_ID = "operator:m6-target-environment-qualification";
const QUALIFICATION_JOB_KEYS = Object.freeze([
  "actorId", "canary", "capabilityId", "deviceId", "expectedGateEpochHash",
  "expectedGateGeneration", "expectedGateLocksHash", "idempotencyKey", "params",
]);

function exactKeys(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()));
}

// M3-R1：health 统一暴露 sourceRepo/sourceCommit/releaseId/runtimeProfile。
// 优先级见 packages/release/lib/release-identity.mjs；加载失败不阻塞 health。
let cachedIdentity;
function releaseIdentity() {
  if (cachedIdentity === undefined) {
    try {
      cachedIdentity = loadReleaseIdentity({ startDir: dirname(fileURLToPath(import.meta.url)) });
    } catch {
      cachedIdentity = { sourceRepo: null, sourceCommit: null, releaseId: null, runtimeProfile: null };
    }
  }
  return cachedIdentity;
}

function requireBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ControlPlaneError("BODY_REQUIRED", "JSON object body is required");
  }
  return body;
}

function tokenOf(body, headers = {}) {
  return headers["x-control-token"] || headers["X-Control-Token"] || body?.token;
}

function deviceSessionToken(headers = {}) {
  const token = headers["x-control-token"] || headers["X-Control-Token"];
  if (typeof token !== "string" || token.trim() === "") {
    throw new ControlPlaneError(
      "SESSION_TOKEN_INVALID",
      "device-sessions require X-Control-Token",
      { status: 403 },
    );
  }
  return token;
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

export function publicTransportLock(lock) {
  const status = lock && typeof lock === "object" ? lock : {};
  return {
    resource: "transport:xiaowei:22222",
    status: typeof status.status === "string" ? status.status : "unknown",
    ageMs: Number.isFinite(status.ageMs) ? Number(status.ageMs) : null,
    exclusive: true,
    trueSplit: false,
    reason: "single-vendor-ws-and-payment-overlap",
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
  constructor({ control, state, capabilities, evidence, delegationGrants = null, canaryEvidenceAuthorizer = null, nodeId = "DESKTOP-3I1EVHE", m6 = null, m6DeviceReadSnapshot = null, m6GateFOperations = null, m6LiveEntry = null, m6RuntimeMode = "STANDARD", m6StartupRecovery = null }) {
    this.control = control;
    this.state = state;
    this.capabilities = capabilities;
    this.evidence = evidence;
    this.delegationGrants = delegationGrants;
    this.canaryEvidenceAuthorizer = canaryEvidenceAuthorizer;
    this.nodeId = nodeId;
    this.m6 = m6;
    this.m6DeviceReadSnapshot = m6DeviceReadSnapshot;
    this.m6GateFOperations = m6GateFOperations;
    this.m6LiveEntry = m6LiveEntry;
    this.m6RuntimeMode = m6RuntimeMode;
    this.m6StartupRecovery = m6StartupRecovery;
    this.liveProgressCache = new Map();
  }

  assertStartupRecoveryRouteAllowed(method, path) {
    if (this.m6StartupRecovery?.required !== true) return;
    const allowed = (method === "GET" && new Set([
      "/control/v1/internal/m6/gate-f/status",
      "/control/v1/internal/m6/live/status",
    ]).has(path)) || (method === "POST" && new Set([
      "/control/v1/internal/m6/gate-f/recover-armed-active",
      "/control/v1/internal/m6/live/recover-epoch",
    ]).has(path));
    if (!allowed) {
      throw new ControlPlaneError(
        "M6_STARTUP_RECOVERY_ONLY",
        "FINAL runtime is latched to authenticated M6 recovery; a recovered or terminal canary cannot resume",
        {
          status: 503,
          details: {
            recoveryStatus: this.m6StartupRecovery.status,
            schedulerAllowed: false,
            externalResourceState: "NOT_ASSERTED",
          },
        },
      );
    }
  }

  qualificationGateStatus({ requireZeroResources }) {
    if (!this.m6GateFOperations) {
      throw new ControlPlaneError("M6_QUALIFICATION_GATE_STATUS_UNAVAILABLE", "qualification-only mode requires sealed Gate-F status", { status: 503 });
    }
    const gate = this.m6GateFOperations.status();
    const resourceCounts = gate?.resourceCounts;
    const zeroResources = resourceCounts?.jobs === 0 && resourceCounts?.leases === 0
      && resourceCounts?.runs === 0 && resourceCounts?.sessions === 0;
    if (gate?.schemaId !== "xw.m6-gate-f-operations-status.v1"
      || gate.mode !== "CLOSED" || gate.phase !== "CLOSED" || gate.purpose !== null
      || gate.tripleConsistent !== true || !Array.isArray(gate.errors) || gate.errors.length !== 0
      || gate.activeAuthorizationCount !== 0 || gate.actionCount !== 0
      || !HASH.test(gate.epochHash ?? "") || !HASH.test(gate.locksHash ?? "")
      || !Number.isInteger(gate.generation) || gate.generation < 0
      || (requireZeroResources && !zeroResources)) {
      throw new ControlPlaneError(
        "M6_QUALIFICATION_GATE_NOT_CLOSED",
        "qualification-only execution requires one exact CLOSED Gate generation",
        { status: 409 },
      );
    }
    return gate;
  }

  assertQualificationAuthorized(headers) {
    if (!this.m6GateFOperations?.assertAuthorized) {
      throw new ControlPlaneError("M6_QUALIFICATION_AUTHORITY_UNAVAILABLE", "qualification-only authority is unavailable", { status: 503 });
    }
    this.m6GateFOperations.assertAuthorized(headers);
  }

  qualificationDevice() {
    const matches = this.state.listDevices().filter((device) => device?.alias === "01"
      && device.online === true && device.quarantined !== true);
    if (matches.length !== 1 || typeof matches[0].deviceId !== "string" || matches[0].deviceId === "") {
      throw new ControlPlaneError("M6_ENV_ALIAS01_BINDING_INVALID", "qualification-only mode requires one online alias-01 binding", { status: 409 });
    }
    const device = matches[0];
    return Object.freeze({ deviceId: device.deviceId, alias: "01", online: true, quarantined: false });
  }

  async handleQualificationOnly({ method, path, body, headers }) {
    this.assertQualificationAuthorized(headers);
    if (method === "GET" && path === "/control/v1/internal/m6/gate-f/status") {
      return { status: 200, body: { gate: this.qualificationGateStatus({ requireZeroResources: false }) } };
    }
    if (method === "GET" && path === "/control/v1/devices") {
      return { status: 200, body: { devices: [this.qualificationDevice()] } };
    }
    const jobMatch = path.match(/^\/control\/v1\/jobs\/([^/]+)$/u);
    if (method === "GET" && jobMatch) {
      const job = this.state.requireJob(decodeURIComponent(jobMatch[1]));
      if (job?.capabilityId !== QUALIFICATION_CAPABILITY_ID || job?.canary !== true) {
        throw new ControlPlaneError("M6_QUALIFICATION_JOB_SCOPE_INVALID", "only formal qualification jobs are visible in qualification-only mode", { status: 403 });
      }
      return { status: 200, body: { job: this.attachTransportLock(publicJob(job)) } };
    }
    if (method === "POST" && path === "/control/v1/jobs") {
      const input = requireBody(body);
      if (!exactKeys(input, QUALIFICATION_JOB_KEYS) || !exactKeys(input.params, [
        "accountIsolationBindingHash", "gateEpochHash", "gateGeneration", "gateLocksHash",
      ])
        || input.actorId !== QUALIFICATION_ACTOR_ID || input.capabilityId !== QUALIFICATION_CAPABILITY_ID
        || input.canary !== true || !HASH.test(input.params.accountIsolationBindingHash ?? "")
        || !HASH.test(input.params.gateEpochHash ?? "") || !HASH.test(input.params.gateLocksHash ?? "")
        || !Number.isInteger(input.params.gateGeneration) || input.params.gateGeneration < 0
        || !HASH.test(input.expectedGateEpochHash ?? "") || !HASH.test(input.expectedGateLocksHash ?? "")
        || !Number.isInteger(input.expectedGateGeneration) || input.expectedGateGeneration < 0) {
        throw new ControlPlaneError("M6_QUALIFICATION_JOB_INPUT_CLOSED", "qualification job input is not the exact sealed form", { status: 400 });
      }
      const device = this.qualificationDevice();
      const before = this.qualificationGateStatus({ requireZeroResources: true });
      if (input.deviceId !== device.deviceId || input.expectedGateEpochHash !== before.epochHash
        || input.expectedGateGeneration !== before.generation || input.expectedGateLocksHash !== before.locksHash
        || input.params.gateEpochHash !== before.epochHash || input.params.gateGeneration !== before.generation
        || input.params.gateLocksHash !== before.locksHash) {
        throw new ControlPlaneError("M6_QUALIFICATION_GATE_REBOUND", "qualification job does not bind the current CLOSED Gate generation", { status: 409 });
      }
      const requestHash = sha256(`xw.m6-target-environment-job.v1:${canonicalJson({
        accountIsolationBindingHash: input.params.accountIsolationBindingHash,
        deviceId: device.deviceId,
        gateEpochHash: before.epochHash,
        gateGeneration: before.generation,
        gateLocksHash: before.locksHash,
      })}`);
      if (input.idempotencyKey !== `m6-env-${requestHash}`) {
        throw new ControlPlaneError("M6_QUALIFICATION_JOB_BINDING_INVALID", "qualification idempotency key is not bound to the CLOSED Gate generation", { status: 409 });
      }
      if (typeof this.control.submitM6QualificationJob !== "function") {
        throw new ControlPlaneError("M6_QUALIFICATION_AUTHORITY_UNAVAILABLE", "formal qualification job creator is unavailable", { status: 503 });
      }
      const created = this.control.submitM6QualificationJob({
        actorId: input.actorId,
        capabilityId: input.capabilityId,
        idempotencyKey: input.idempotencyKey,
        params: input.params,
        canary: true,
        deviceId: device.deviceId,
      });
      try {
        const after = this.qualificationGateStatus({ requireZeroResources: false });
        if (after.epochHash !== before.epochHash || after.generation !== before.generation
          || after.locksHash !== before.locksHash) {
          throw new ControlPlaneError("M6_QUALIFICATION_GATE_DRIFT", "Gate generation changed while the qualification job was submitted", { status: 409 });
        }
      } catch (error) {
        try { this.control.cancelJob(created?.job?.jobId); } catch { /* fail closed below */ }
        throw error;
      }
      return { status: 202, body: { ...created, job: publicJob(created.job) } };
    }
    throw new ControlPlaneError(
      "M6_QUALIFICATION_ONLY_ROUTE_FORBIDDEN",
      `${method} ${path} is outside the qualification-only route set`,
      { status: 403 },
    );
  }

  // M6-2 W5 closed input envelope: the M6 namespace accepts ONLY alias +
  // scenarioLabel + idempotencyKey (+ attemptId for status/closeout, + optional
  // closeout reason). Any other key — coordinates, shell text, URLs, device ids,
  // session ids, tokens — is rejected before it can reach the facade. attemptId
  // is an opaque server-issued reference, never a coordinate or device id.
  closedM6Input(body) {
    const input = requireBody(body);
    const allowed = new Set(["alias", "scenarioLabel", "idempotencyKey", "attemptId", "reason"]);
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) {
        throw new ControlPlaneError("M6_INPUT_CLOSED", `M6 requests accept only ${[...allowed].join(", ")}; got '${key}'`, { status: 400 });
      }
    }
    return input;
  }

  attachLiveProgress(job, nowMs = Date.now()) {
    if (!job?.runId || !this.evidence?.runDirectory) {
      return job ? { ...job, liveProgress: null } : job;
    }
    try {
      const cached = this.liveProgressCache.get(job.runId);
      if (cached && nowMs - cached.at < LIVE_PROGRESS_CACHE_MS) {
        return { ...job, liveProgress: cached.value };
      }
      const liveProgress = readLiveProgressTail(this.evidence.runDirectory(job.runId), { nowMs });
      this.liveProgressCache.set(job.runId, { at: nowMs, value: liveProgress });
      return { ...job, liveProgress };
    } catch {
      return { ...job, liveProgress: null };
    }
  }

  attachTransportLock(job) {
    let snapshot = { status: "unknown", ageMs: null };
    try {
      if (typeof this.control?.transportStatus === "function") {
        snapshot = this.control.transportStatus() || snapshot;
      }
    } catch {
      snapshot = { status: "unknown", ageMs: null };
    }
    return job ? { ...job, transportLock: publicTransportLock(snapshot) } : job;
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
          capabilities: this.m6RuntimeMode === "QUALIFICATION_ONLY" ? 1 : this.capabilities.capabilities.length,
          activeLeases: this.state.listLeases().length,
          evidenceFreeBytes: freeBytes,
          externalEffectsBlockedForLowDisk: freeBytes < this.evidence.minExternalEffectFreeBytes,
          // REX Phase 5 B7: 暴露运行时策略模式与 release id（部署时由 worker 从 launch config 注入）。
          // Phase 6 B: 有策略模式时同时暴露运行时策略 schema 版本（legacy 不声称非支付策略）。
          policyMode: this.control?.policyMode ?? null,
          ...(this.control?.policyMode ? { runtimePolicyVersion: RUNTIME_POLICY_VERSION } : {}),
          // M3-R1：统一 release identity（可为 null）；releaseId 保持旧 env 向后兼容。
          sourceRepo: releaseIdentity().sourceRepo,
          sourceCommit: releaseIdentity().sourceCommit,
          runtimeProfile: releaseIdentity().runtimeProfile,
          releaseId: releaseIdentity().releaseId ?? process.env.CONTROL_PLANE_RELEASE_ID ?? null,
          m6RuntimeMode: this.m6RuntimeMode,
          // M6-2 W8 #3: read-only M6 live-gate snapshot. Omitted entirely when
          // the facade is not installed (M6 disabled). No device I/O.
          ...(this.m6 ? { m6: this.m6.health() } : {}),
          ...(this.m6GateFOperations ? { m6GateFOperations: this.m6GateFOperations.health() } : {}),
          // M6-C1 internal production entry readiness contains blocker codes
          // and resource counts only. It never exposes the internal token,
          // provider credential, child command, paths, or raw device identity.
          ...(this.m6LiveEntry ? { m6LiveEntry: this.m6LiveEntry.health() } : {}),
          ...(this.m6StartupRecovery ? { m6StartupRecovery: this.m6StartupRecovery } : {}),
        },
      };
    }

    this.assertStartupRecoveryRouteAllowed(method, path);

    if (this.m6RuntimeMode === "QUALIFICATION_ONLY") {
      return this.handleQualificationOnly({ method, path, body, headers });
    }

    // Gate-F operator mutations have one Control-Plane-owned path. The CLI is
    // deliberately unable to open the DB or rewrite the file pointer itself.
    if (path.startsWith("/control/v1/internal/m6/gate-f/")) {
      if (!this.m6GateFOperations) {
        throw new ControlPlaneError(
          "M6_GATE_F_OPERATIONS_UNAVAILABLE",
          "M6 Gate-F operations are not installed in this runtime",
          { status: 503 },
        );
      }
      this.m6GateFOperations.assertAuthorized(headers);
      if (method === "GET" && path === "/control/v1/internal/m6/gate-f/status") {
        return { status: 200, body: { gate: this.m6GateFOperations.status() } };
      }
      if (method === "POST" && path === "/control/v1/internal/m6/gate-f/preflight") {
        return { status: 200, body: { preflight: this.m6GateFOperations.preflight(body) } };
      }
      if (method === "POST" && path === "/control/v1/internal/m6/gate-f/activate") {
        if (body?.operation !== "ACTIVATE") {
          throw new ControlPlaneError("M6_GATE_F_INPUT_INVALID", "activate route accepts only ACTIVATE packages", { status: 400 });
        }
        return { status: 200, body: { promotion: this.m6GateFOperations.apply(body) } };
      }
      if (method === "POST" && path === "/control/v1/internal/m6/gate-f/close") {
        if (!new Set(["NORMAL_CLOSE", "EMERGENCY_CLOSE"]).has(body?.operation)) {
          throw new ControlPlaneError("M6_GATE_F_INPUT_INVALID", "close route accepts only normal/emergency close packages", { status: 400 });
        }
        return { status: 200, body: { promotion: this.m6GateFOperations.apply(body) } };
      }
      if (method === "POST" && path === "/control/v1/internal/m6/gate-f/reconcile") {
        return { status: 200, body: { reconciliation: this.m6GateFOperations.reconcile(body) } };
      }
      if (method === "POST" && path === "/control/v1/internal/m6/gate-f/recover-armed-active") {
        return { status: 200, body: this.m6GateFOperations.recoverArmedActive(body) };
      }
      throw new ControlPlaneError("ROUTE_NOT_FOUND", `${method} ${path} not found`, { status: 404 });
    }

    // M6-C1 has one loopback-only internal namespace. Authentication is
    // header-only; exact request bodies reject token/device/raw fields before
    // preflight can inspect any sealed artifact or create any resource.
    if (path.startsWith("/control/v1/internal/m6/live/")) {
      if (!this.m6LiveEntry) {
        throw new ControlPlaneError(
          "M6_LIVE_ENTRY_UNAVAILABLE",
          "M6 production live entry is not installed in this runtime",
          { status: 503 },
        );
      }
      this.m6LiveEntry.assertAuthorized(headers);
      if (method === "POST" && path === "/control/v1/internal/m6/live/recover-epoch") {
        return { status: 200, body: { recovery: await this.m6LiveEntry.recoverEpoch(body) } };
      }
      if (method === "POST" && path === "/control/v1/internal/m6/live/preflight") {
        return { status: 200, body: { preflight: this.m6LiveEntry.preflight(body) } };
      }
      if (method === "POST" && path === "/control/v1/internal/m6/live/start") {
        return { status: 202, body: { run: await this.m6LiveEntry.start(body) } };
      }
      if (method === "GET" && path === "/control/v1/internal/m6/live/status") {
        return { status: 200, body: { run: this.m6LiveEntry.status(Object.fromEntries(query.entries())) } };
      }
      if (method === "POST" && path === "/control/v1/internal/m6/live/close") {
        return { status: 200, body: { run: await this.m6LiveEntry.close(body) } };
      }
      throw new ControlPlaneError("ROUTE_NOT_FOUND", `${method} ${path} not found`, { status: 404 });
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
      return {
        status: 200,
        body: { job: this.attachTransportLock(this.attachLiveProgress(publicJob(this.state.requireJob(decodeURIComponent(match[1]))))) },
      };
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

    // --- Direct-routine plan V2 §8.1: CP-owned routine authority + effects ----
    if (method === "POST" && path === "/control/v1/routine-authority") {
      const input = requireBody(body);
      const authority = this.control.registerRoutineAuthority({
        sessionId: input.sessionId,
        token: tokenOf(input, headers),
        executionRunId: input.executionRunId,
        routineRunId: input.routineRunId,
        planHash: input.planHash,
        alias: input.alias,
        effectCaps: input.effectCaps ?? {},
        canaryAuthorized: input.canaryAuthorized === true,
        accountFingerprint: input.accountFingerprint ?? null,
      });
      return { status: 201, body: { authority } };
    }
    match = path.match(/^\/control\/v1\/routine-authority\/([^/]+)\/effects$/);
    if (method === "POST" && match) {
      const input = requireBody(body);
      return {
        status: 200,
        body: {
          effect: await this.control.commitRoutineAuthorityEffect({
            authorityId: decodeURIComponent(match[1]),
            token: tokenOf(input, headers),
            intent: input.intent ?? null,
          }),
        },
      };
    }
    match = path.match(/^\/control\/v1\/routine-authority\/([^/]+)\/reconcile$/);
    if (method === "POST" && match) {
      const input = requireBody(body);
      return {
        status: 200,
        body: {
          reconciles: await this.control.reconcileRoutineAuthorityComments({
            authorityId: decodeURIComponent(match[1]),
            token: tokenOf(input, headers),
            targetFingerprint: input.targetFingerprint ?? null,
          }),
        },
      };
    }
    match = path.match(/^\/control\/v1\/routine-authority\/([^/]+)$/);
    if (method === "POST" && match) {
      // explicit close (the owning session's release also closes implicitly)
      const input = requireBody(body);
      return {
        status: 200,
        body: {
          authority: this.control.closeRoutineAuthorityViaRpc(decodeURIComponent(match[1]), tokenOf(input, headers), input.reason ?? "closed"),
        },
      };
    }

    if (method === "POST" && path === "/control/v1/device-sessions") {
      const input = requireBody(body);
      const { faultAfter: _ignoredFaultAfter, ...safe } = input;
      return { status: 201, body: this.control.createDeviceSession(safe) };
    }
    match = path.match(/^\/control\/v1\/device-sessions\/([^/]+)\/actions$/);
    if (method === "POST" && match) {
      const input = requireBody(body);
      return {
        status: 200,
        body: await this.control.executeDeviceSessionAction(
          decodeURIComponent(match[1]),
          deviceSessionToken(headers),
          input,
        ),
      };
    }
    match = path.match(/^\/control\/v1\/device-sessions\/([^/]+)\/observe$/);
    if (method === "POST" && match) {
      const input = body && typeof body === "object" ? body : {};
      return {
        status: 200,
        body: await this.control.observeDeviceSession(
          decodeURIComponent(match[1]),
          deviceSessionToken(headers),
          input,
        ),
      };
    }
    match = path.match(/^\/control\/v1\/device-sessions\/([^/]+)\/heartbeat$/);
    if (method === "POST" && match) {
      return {
        status: 200,
        body: this.control.heartbeatDeviceSession(decodeURIComponent(match[1]), deviceSessionToken(headers)),
      };
    }
    match = path.match(/^\/control\/v1\/device-sessions\/([^/]+)\/release$/);
    if (method === "POST" && match) {
      return {
        status: 200,
        body: this.control.releaseDeviceSession(decodeURIComponent(match[1]), deviceSessionToken(headers)),
      };
    }
    match = path.match(/^\/control\/v1\/device-sessions\/([^/]+)\/events$/);
    if (method === "GET" && match) {
      const after = Number(query.get("after") || 0);
      return {
        status: 200,
        body: {
          events: this.control.listDeviceSessionEvents(
            decodeURIComponent(match[1]),
            deviceSessionToken(headers),
            Number.isFinite(after) ? after : 0,
          ),
        },
      };
    }
    match = path.match(/^\/control\/v1\/device-sessions\/([^/]+)$/);
    if (method === "GET" && match) {
      return {
        status: 200,
        body: this.control.getDeviceSession(decodeURIComponent(match[1]), deviceSessionToken(headers)),
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

    // PR1 Single-Device Recipe Runner — server-side recipe-runs (no Agent Gateway yet).
    if (method === "POST" && path === "/control/v1/recipe-runs") {
      const input = requireBody(body);
      const run = await this.control.startRecipeRun(input);
      return { status: 201, body: { recipeRun: run } };
    }
    if (method === "POST" && path === "/control/v1/recipe-runs/plan") {
      const input = requireBody(body);
      return { status: 200, body: { plan: this.control.planRecipeRun(input) } };
    }
    if (method === "GET" && path === "/control/v1/recipe-runs") {
      return { status: 200, body: { recipeRuns: this.control.listRecipeRuns() } };
    }
    match = path.match(/^\/control\/v1\/recipe-runs\/([^/]+)\/cancel$/);
    if (method === "POST" && match) {
      return {
        status: 200,
        body: { recipeRun: await this.control.cancelRecipeRun(decodeURIComponent(match[1])) },
      };
    }
    match = path.match(/^\/control\/v1\/recipe-runs\/([^/]+)$/);
    if (method === "GET" && match) {
      return {
        status: 200,
        body: { recipeRun: this.control.getRecipeRun(decodeURIComponent(match[1])) },
      };
    }

    // M6-2 W5 — the ONLY M6 public surface: closed observe capture. These four
    // routes accept no coordinates, shell text, URLs, device ids, session ids,
    // or tokens; the facade resolves the alias server-side and every other
    // failure is fail-closed. When the facade is not installed, the whole M6
    // namespace refuses (503) — never a degraded fallback.
    if (this.m6 && method === "POST" && path === "/control/v1/m6/frames/preflight") {
      return { status: 200, body: { preflight: this.m6.preflight(this.closedM6Input(body)) } };
    }
    if (this.m6 && method === "POST" && path === "/control/v1/m6/frames/capture") {
      return { status: 200, body: { receipt: await this.m6.capture(this.closedM6Input(body)) } };
    }
    if (this.m6 && method === "GET" && path === "/control/v1/m6/frames/status") {
      return { status: 200, body: this.m6.status({ attemptId: query.get("attemptId") || "" }) };
    }
    if (this.m6 && method === "POST" && path === "/control/v1/m6/frames/closeout") {
      return { status: 200, body: this.m6.closeout(this.closedM6Input(body)) };
    }
    if (this.m6DeviceReadSnapshot && method === "POST" && path === "/control/v1/m6/device-read-snapshot") {
      return { status: 200, body: { snapshot: await this.m6DeviceReadSnapshot.consume(requireBody(body)) } };
    }
    if (path.startsWith("/control/v1/m6/")) {
      throw new ControlPlaneError(
        this.m6 ? "ROUTE_NOT_FOUND" : "M6_FACADE_UNAVAILABLE",
        this.m6 ? `${method} ${path} not found` : "M6 frame capture is not installed in this runtime",
        { status: this.m6 ? 404 : 503 },
      );
    }

    throw new ControlPlaneError("ROUTE_NOT_FOUND", `${method} ${path} not found`, { status: 404 });
  }
}
