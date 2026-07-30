import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ControlPlaneError, asControlError } from "./errors.mjs";
import { fingerprint } from "./canonical.mjs";
import { validateJsonSchema } from "./json-schema-validator.mjs";
import { DiscoverySessionRuntime } from "./discovery-session.mjs";
import { evaluateCapabilityPolicy } from "./policy.mjs";
import { inspectTransportLock } from "./xiaowei-transport.mjs";
import { normalizeRecoveryVisualAnalysis } from "./recovery-inspection.mjs";
import { MissionRuntime } from "./mission-runtime.mjs";
import { DeviceRunRuntime } from "./device-run.mjs";
import { EffectFirewall } from "./effect-firewall.mjs";
import { EffectLedger } from "./effect-ledger.mjs";
import { EffectCommitProtocol } from "./effect-commit-protocol.mjs";
import { ProtectedHumanCommit } from "./protected-human-commit.mjs";
import { acquireTransportLock as defaultAcquireTransportLock } from "./xiaowei-transport.mjs";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(moduleDir, "..", "..");
const EFFECT_INTENT_SCHEMA_PATH = join(moduleDir, "..", "schema", "effect-intent.schema.json");
const DEFAULT_ADR_0008_PATH = join(REPO_ROOT, "docs", "adr", "0008-mission-driven-exploration-authorization.md");
const DEFAULT_ADR_0010_PATH = join(REPO_ROOT, "docs", "adr", "0010-standing-grant-discovery-session.md");

// Load the canonical effect-intent envelope schema once at module load so the runtime
// validation is driven by the schema file (the source of truth), not a parallel copy.
let EFFECT_INTENT_SCHEMA = null;
try {
  if (existsSync(EFFECT_INTENT_SCHEMA_PATH)) {
    EFFECT_INTENT_SCHEMA = JSON.parse(readFileSync(EFFECT_INTENT_SCHEMA_PATH, "utf8"));
  }
} catch {
  // A missing/unreadable schema must fail closed for envelopes, handled per-call below.
  EFFECT_INTENT_SCHEMA = null;
}

// ADR 0008 acceptance is decided OUTSIDE code review (by the authorized decision maker). The
// guard reads the ADR's Status line so enabling the automatic-R2 Mission path requires a real
// accepted ADR on disk, not a code change. A missing ADR (still Proposed / not yet written) is
// treated as not accepted. Tests may inject adrAccepted to exercise the enabled branch without
// touching the ADR file.
function readAdrStatusAccepted(adrPath) {
  try {
    if (!existsSync(adrPath)) return false;
    const text = readFileSync(adrPath, "utf8");
    return /^\s*(?:[-*]\s*)?Status:\s*Accepted\b/im.test(text);
  } catch {
    return false;
  }
}

function collectEvidenceFiles(...values) {
  return values.flatMap((value) => Array.isArray(value?.evidenceFiles) ? value.evidenceFiles : []);
}

function boundedAdapterCode(error) {
  const value = error?.details?.adapterCode;
  return typeof value === "string" && /^[A-Z0-9_]{1,96}$/.test(value) ? value : null;
}

function boundedTransportEvidence(value) {
  if (!value || typeof value !== "object") return undefined;
  const counters = ["httpTapAttempts", "httpTapSucceeded", "gatewayTapFallbacks"];
  if (value.mode !== "typed-http"
    || value.httpReady !== true
    || counters.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)) return undefined;
  return {
    mode: "typed-http",
    httpReady: true,
    httpTapAttempts: value.httpTapAttempts,
    httpTapSucceeded: value.httpTapSucceeded,
    gatewayTapFallbacks: value.gatewayTapFallbacks,
  };
}

function resultSummary(execution, verification, restoration, error = null) {
  const out = execution?.output;
  const transportEvidence = boundedTransportEvidence(out?.transportEvidence);
  return {
    vendorCode: execution?.vendorCode ?? null,
    // 执行细节摘要（ok/step/verified/counts/text），便于 VERIFICATION_FAILED 时回溯，不落完整 dump
    output: out && typeof out === "object"
      ? Object.fromEntries(
        ["ok", "step", "verified", "verifyMethod", "beforeCount", "afterCount", "text", "diagnostic"]
          .filter((k) => out[k] !== undefined)
          .map((k) => [k, out[k]]),
      )
      : null,
    ...(transportEvidence ? { transportEvidence } : {}),
    error: error
      ? { code: error.code || null, message: String(error.message || error), details: error.details ?? null }
      : null,
    verification: verification ? {
      ok: verification.ok !== false,
      mode: verification.mode || null,
      hash: verification.hash || null,
    } : null,
    restoration: restoration ? { ok: restoration.ok !== false } : null,
  };
}

export class AdapterRegistry {
  constructor(adapters = []) {
    this.adapters = new Map();
    for (const adapter of adapters) {
      if (!adapter?.id) throw new TypeError("adapter.id is required");
      if (this.adapters.has(adapter.id)) throw new TypeError(`duplicate adapter ${adapter.id}`);
      if (typeof adapter.execute !== "function") throw new TypeError(`${adapter.id}.execute is required`);
      this.adapters.set(adapter.id, adapter);
    }
  }

  require(id) {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new ControlPlaneError("ADAPTER_NOT_FOUND", `adapter ${id} is not installed`, { status: 503 });
    }
    return adapter;
  }
}

export class ControlPlane {
  constructor({
    state,
    capabilities,
    adapters,
    evidence,
    authorityNodeId = "DESKTOP-3I1EVHE",
    operatorControlUrl = process.env.CONTROL_PLANE_INTERNAL_URL || "http://127.0.0.1:17920",
    transportStatus = inspectTransportLock,
    schedulerIntervalMs = 100,
    leaseTtlMs = 60000,
    leaseHeartbeatMs = 10000,
    missions = null,
    acquireTransportLock = null,
    missionAutoApprovalEnabled = process.env.MISSION_AUTO_APPROVAL_ENABLED === "1",
    standingGrantEnabled = process.env.STANDING_GRANT_ENABLED === "1",
    discoveryIssuerReady = false,
    adrAccepted = null,
    adrPath = DEFAULT_ADR_0008_PATH,
    discoveryAdrAccepted = null,
    discoveryAdrPath = DEFAULT_ADR_0010_PATH,
    effectIntentSchema = EFFECT_INTENT_SCHEMA,
  }) {
    this.state = state;
    this.capabilities = capabilities;
    this.adapters = adapters instanceof AdapterRegistry ? adapters : new AdapterRegistry(adapters);
    this.evidence = evidence;
    this.authorityNodeId = authorityNodeId;
    this.operatorControlUrl = operatorControlUrl;
    this.transportStatus = transportStatus;
    this.schedulerIntervalMs = schedulerIntervalMs;
    if (!Number.isFinite(leaseTtlMs) || !Number.isFinite(leaseHeartbeatMs)
      || leaseTtlMs <= 0 || leaseHeartbeatMs <= 0 || leaseHeartbeatMs >= leaseTtlMs) {
      throw new TypeError("leaseHeartbeatMs must be positive and less than leaseTtlMs");
    }
    this.leaseTtlMs = leaseTtlMs;
    this.leaseHeartbeatMs = leaseHeartbeatMs;
    this.activeJobs = new Map();
    this.started = false;
    this.pumping = false;
    this.missions = missions instanceof MissionRuntime ? missions : new MissionRuntime({ state });
    this.deviceRuns = new DeviceRunRuntime({
      state,
      missions: this.missions,
      authorityNodeId,
      leaseTtlMs,
      leaseHeartbeatMs,
    });
    this.firewall = new EffectFirewall();
    this.effectLedger = new EffectLedger({ state });
    this.acquireTransportLock = typeof acquireTransportLock === "function"
      ? acquireTransportLock
      : defaultAcquireTransportLock;
    // Mission automatic-R2 gating (ADR 0008). Default false: the manual per-effect gate stays
    // intact until the authorized decision maker accepts ADR 0008 outside code review AND the
    // flag is enabled. adrAccepted===null reads the ADR file lazily; an explicit boolean
    // override is for tests only and never mutates the ADR file.
    this.missionAutoApprovalEnabled = Boolean(missionAutoApprovalEnabled);
    this.standingGrantEnabled = Boolean(standingGrantEnabled);
    this.discoveryIssuerReady = Boolean(discoveryIssuerReady);
    this.adrAcceptedOverride = adrAccepted;
    this.adrPath = adrPath;
    this.discoveryAdrAcceptedOverride = discoveryAdrAccepted;
    this.discoveryAdrPath = discoveryAdrPath;
    this.effectIntentSchema = effectIntentSchema;
    this.discoverySessions = new DiscoverySessionRuntime({
      state,
      authorityNodeId,
      leaseTtlMs,
      gates: () => ({
        missionAutoApprovalEnabled: this.missionAutoApprovalEnabled,
        standingGrantEnabled: this.standingGrantEnabled,
        adrAccepted: this.isAdr0010Accepted(),
        issuerReady: this.discoveryIssuerReady,
      }),
    });
    state.upsertNode({
      nodeId: authorityNodeId,
      status: "online",
      authority: true,
      dispatchMode: "local",
    });
    state.syncCapabilities(capabilities);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.scheduler = setInterval(() => this.pump().catch(() => {}), this.schedulerIntervalMs);
    this.scheduler.unref?.();
    // Defense-in-depth: never let the initial pump become an unhandled rejection
    // (e.g. quarantined/offline devices with leftover queued jobs after restart).
    void this.pump().catch(() => {});
  }

  async stop() {
    this.started = false;
    clearInterval(this.scheduler);
    for (const deviceRunId of [...this.deviceRuns.heartbeats.keys()]) {
      this.deviceRuns.stopRunnerHeartbeat(deviceRunId);
    }
    await Promise.allSettled([...this.activeJobs.values()]);
  }

  // Mission-bound DeviceRun entry point. The runner auto-heartbeats its lease server-side
  // once the control loop is started, so normal progress does not depend on a caller.
  openDeviceRun(input) {
    const run = this.deviceRuns.openDeviceRun(input);
    if (this.started) this.deviceRuns.startRunnerHeartbeat(run.deviceRunId, run.token);
    return run;
  }

  assertControlTuple(tuple) {
    return this.deviceRuns.assertControlTuple(tuple);
  }

  openDiscoveryRun(input) {
    return this.discoverySessions.openDiscoveryRun(input);
  }

  heartbeatDiscoveryRun(input) {
    return this.discoverySessions.heartbeatDiscoveryRun(input);
  }

  sealDiscoveryRun(input) {
    return this.discoverySessions.sealDiscoveryRun(input);
  }

  abortDiscoveryRun(input) {
    return this.discoverySessions.abortDiscoveryRun(input);
  }

  getDiscoveryRun(discoveryRunId) {
    return this.discoverySessions.getDiscoveryRun(discoveryRunId);
  }

  markControlLost(deviceRunId, input) {
    const run = this.deviceRuns.markControlLost(deviceRunId, input);
    this.deviceRuns.stopRunnerHeartbeat(deviceRunId);
    return run;
  }

  // Internal-only control-plane ingestion point. No router exposes this method: callers must
  // already hold the full fenced tuple for a control-plane-owned DeviceRun before a hash-only
  // observation can become authority for a later Standing Grant Mission.
  recordAuthoritativeObservation({ tuple, observation }) {
    const run = this.assertControlTuple(tuple);
    const mission = this.missions.requireActiveMission(run.missionId);
    if (!observation || observation.app !== mission.app || observation.accountFingerprint !== mission.account) {
      throw new ControlPlaneError("AUTHORITATIVE_OBSERVATION_MISMATCH", "observation does not match the controlled Mission", { status: 409 });
    }
    return this.state.recordAuthoritativeObservation(observation);
  }

  createEffectCommitProtocol(handlers) {
    return new EffectCommitProtocol({
      state: this.state,
      ledger: this.effectLedger,
      deviceRuns: this.deviceRuns,
      missions: this.missions,
      ...handlers,
    });
  }

  createProtectedHumanCommit(handlers) {
    return new ProtectedHumanCommit({
      state: this.state,
      audit: (event) => {
        if (event?.missionId) {
          this.state.appendMissionEvent({
            missionId: event.missionId,
            type: event.type,
            payload: { commitId: event.commitId, action: event.action, actorId: event.actorId || null },
          });
        }
      },
      ...handlers,
    });
  }

  // ADR 0008 acceptance is read out-of-band from the ADR file unless a boolean override was
  // injected (tests). The file remains the source of truth; this method never mutates it.
  isAdr0008Accepted() {
    if (this.adrAcceptedOverride !== null && this.adrAcceptedOverride !== undefined) {
      return Boolean(this.adrAcceptedOverride);
    }
    return readAdrStatusAccepted(this.adrPath);
  }

  // DiscoverySession has its own rollout decision. ADR 0008 authorizes the Mission
  // auto-approval lane only; it must never open pre-Mission discovery by implication.
  isAdr0010Accepted() {
    if (this.discoveryAdrAcceptedOverride !== null && this.discoveryAdrAcceptedOverride !== undefined) {
      return Boolean(this.discoveryAdrAcceptedOverride);
    }
    return readAdrStatusAccepted(this.discoveryAdrPath);
  }

  // The automatic-R2 Mission path requires BOTH the feature flag AND an accepted ADR 0008.
  // On either failure it must block before any DeviceRun/lease/Session/effect is allocated and
  // never degrade to legacy manual-per-effect handling. The single failure code is
  // ADR_0008_NOT_ACCEPTED so callers cannot tell "flag off" from "ADR not accepted" and
  // infer a partial rollout state.
  #missionAutoApprovalGate() {
    if (!this.missionAutoApprovalEnabled || !this.isAdr0008Accepted()) {
      return { ok: false, code: "ADR_0008_NOT_ACCEPTED" };
    }
    return { ok: true };
  }

  #standingGrantGate() {
    if (!this.standingGrantEnabled || !this.missionAutoApprovalEnabled || !this.isAdr0008Accepted()) {
      return { ok: false, code: "STANDING_GRANT_NOT_ENABLED" };
    }
    return { ok: true };
  }

  // The one authenticated command that creates/reuses the immutable Mission and runs it. It
  // never accepts a client-selected private runtime/device id (placement is server-side). With
  // the gate closed it persists only a blocked Mission/audit event and returns
  // ADR_0008_NOT_ACCEPTED before any run/lease/Session/effect row exists. With the gate open an
  // in-scope social Mission opens its atomic DeviceRun with no whole-Mission or per-job
  // approval; payment and unreleased publish/delete still route to the PHC at effect time.
  submitMission({ actor, idempotencyKey, policy, parentGrantId = null, controllerAgent, placement = {} }) {
    if (typeof actor !== "string" || actor.trim() === "") {
      throw new ControlPlaneError("ACTOR_REQUIRED", "actor is required", { status: 400 });
    }
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") {
      throw new ControlPlaneError("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required", { status: 400 });
    }
    if (!policy || typeof policy !== "object") {
      throw new ControlPlaneError("MISSION_POLICY_INVALID", "policy is required", { status: 400 });
    }
    // The bound device runtime is selected by the control plane, never by the caller. Rejecting
    // a client-supplied runtimeId/deviceId keeps a private runtime anchor from being spoofed.
    if (policy.runtimeId !== undefined || policy.deviceId !== undefined) {
      throw new ControlPlaneError(
        "CLIENT_RUNTIME_FORBIDDEN",
        "mission submit does not accept a client-selected private runtime or device id",
        { status: 400 },
      );
    }
    const controller = (typeof controllerAgent === "string" && controllerAgent.trim())
      ? controllerAgent.trim()
      : "agent:runner";
    const controllers = (Array.isArray(policy.controllers) && policy.controllers.length)
      ? policy.controllers
      : [controller];
    if (parentGrantId && policy.issuer !== undefined) {
      throw new ControlPlaneError("CLIENT_ISSUER_FORBIDDEN", "a parent-grant Mission cannot select its issuer", { status: 400 });
    }
    const missionInput = {
      ...policy,
      issuer: { actorId: actor.trim() },
      idempotencyKey: idempotencyKey.trim(),
      controllers,
    };
    const { mission, reused } = parentGrantId
      ? this.missions.createMissionFromGrant({ parentGrantId, input: missionInput })
      : this.missions.createMission(missionInput);
    const gate = parentGrantId ? this.#standingGrantGate() : this.#missionAutoApprovalGate();
    if (!gate.ok) {
      this.state.appendMissionEvent({
        missionId: mission.missionId,
        type: "mission.submit.blocked",
        payload: { code: gate.code, actorId: actor.trim(), controllerAgent: controller },
      });
      return { status: "blocked", reason: gate.code, mission, reused, approvalRequired: false };
    }
    const run = this.openDeviceRun({ missionId: mission.missionId, controllerAgent: controller, placement });
    this.state.appendMissionEvent({
      missionId: mission.missionId,
      type: "mission.submitted",
      payload: { actorId: actor.trim(), deviceRunId: run.deviceRunId, controllerAgent: controller },
    });
    return { status: "running", mission, reused, run, approvalRequired: false };
  }

  showMission(missionId) {
    const mission = this.state.getMission(missionId);
    if (!mission) throw new ControlPlaneError("MISSION_NOT_FOUND", `unknown mission ${missionId}`, { status: 404 });
    return {
      mission,
      deviceRuns: this.state.listDeviceRuns({ missionId }),
      events: this.state.listMissionEvents(missionId),
    };
  }

  missionStatus(missionId) {
    const mission = this.state.getMission(missionId);
    if (!mission) throw new ControlPlaneError("MISSION_NOT_FOUND", `unknown mission ${missionId}`, { status: 404 });
    const deviceRuns = this.state.listDeviceRuns({ missionId });
    return {
      missionId,
      status: mission.status,
      deviceRunCount: deviceRuns.length,
      effectCount: this.state.listMissionEffects(missionId).length,
    };
  }

  // revoke cancels further work: the mission flips to revoked so every later primitive/effect
  // is blocked by the classifier. It makes no claim that an already-ambiguous external effect
  // was undone (terminal effects stay terminal). It does not fabricate a human approval.
  revokeMission(missionId, { actorId, reason = null } = {}) {
    return this.missions.revokeMission(missionId, { actorId, reason });
  }

  // Mission-bound Explorer primitive. Validates the complete control tuple, classifies the
  // effect-intent envelope against the fresh observed surface, takes the shared transport lock,
  // records a durable primitive event, and releases the lock. No typed action ID, actionId, or
  // Workflow DSL is required. The verdict drives the ECP/PHC (Task 4); a blocked verdict is
  // recorded and returned, never silently dropped or disguised as an approval.
  async executeMissionPrimitive(tuple, { primitive, envelope }) {
    if (typeof primitive !== "string" || primitive.trim() === "") {
      throw new ControlPlaneError("PRIMITIVE_REQUIRED", "primitive is required", { status: 400 });
    }
    if (!envelope || typeof envelope !== "object") {
      throw new ControlPlaneError("ENVELOPE_REQUIRED", "effect-intent envelope is required", { status: 400 });
    }
    // Validate the envelope against the canonical effect-intent schema. The primitive is part
    // of the envelope contract, so it is merged in before validation; this keeps existing
    // callers (which pass primitive separately) compliant without changing their payloads.
    // A schema-invalid envelope is rejected before any tuple check, classification, or effect.
    const mergedEnvelope = { schemaVersion: 1, primitive, ...envelope };
    if (!this.effectIntentSchema) {
      throw new ControlPlaneError(
        "EFFECT_INTENT_SCHEMA_UNAVAILABLE",
        "effect-intent schema is unavailable; Mission primitives are blocked",
        { status: 503 },
      );
    }
    const errors = validateJsonSchema(mergedEnvelope, this.effectIntentSchema);
    if (errors.length > 0) {
      throw new ControlPlaneError(
        "ENVELOPE_SCHEMA_INVALID",
        "effect-intent envelope does not match the runtime schema",
        { status: 400, details: { errors: errors.slice(0, 10) } },
      );
    }
    const run = this.assertControlTuple(tuple);
    const mission = this.missions.requireActiveMission(tuple.missionId);
    const verdict = this.firewall.classify(mergedEnvelope, mission);
    const release = await this.acquireTransportLock();
    try {
      const payload = {
        deviceRunId: run.deviceRunId,
        primitive,
        verdict: {
          code: verdict.code,
          decision: verdict.decision,
          surface: verdict.surface ?? null,
          reason: verdict.reason,
          ...(verdict.effectAction ? { effectAction: verdict.effectAction } : {}),
        },
      };
      this.state.appendMissionEvent({ missionId: tuple.missionId, type: "mission.primitive", payload });
      this.state.appendEvent({ runId: run.deviceRunId, type: "mission.primitive", payload });
      try {
        this.evidence.appendEvent(run.deviceRunId, {
          type: "mission.primitive",
          primitive,
          verdict: payload.verdict,
          createdAt: new Date().toISOString(),
        });
      } catch {
        // SQLite is the durable audit authority; JSONL evidence mirroring is best-effort.
      }
      return { deviceRunId: run.deviceRunId, primitive, verdict, recorded: true };
    } finally {
      try { release(); } catch {}
    }
  }

  submitJob({
    idempotencyKey,
    actorId,
    deviceId = null,
    placement = {},
    capabilityId,
    params = {},
    canary = false,
  }) {
    const capability = this.capabilities.validateParams(capabilityId, params);
    const policy = evaluateCapabilityPolicy(capability, { canary, invocation: "job" });
    this.evidence.assertCapacity({ externalEffect: policy.externalEffect });
    const created = this.state.createJob({
      idempotencyKey,
      actorId,
      authorityNodeId: this.authorityNodeId,
      deviceId,
      placement,
      capability,
      params,
      canary,
      status: policy.approvalRequired ? "waiting_approval" : "queued",
      approvalRequired: policy.approvalRequired,
      externalEffect: policy.externalEffect,
    });
    if (!created.reused) {
      const device = this.state.requireDevice(created.job.deviceId);
      this.evidence.initializeRun({ job: created.job, device });
      if (created.job.status === "queued") queueMicrotask(() => void this.pump());
    }
    return {
      ...created,
      storage: this.evidence.storageForRun(created.job.runId),
    };
  }

  planRoute({
    actorId,
    capabilityId,
    params = {},
    canary = false,
    deviceId = null,
    placement = {},
    invocation = "job",
  }) {
    if (typeof actorId !== "string" || actorId.trim() === "") {
      throw new ControlPlaneError("ACTOR_REQUIRED", "actorId is required");
    }
    try {
      const capability = this.capabilities.validateParams(capabilityId, params);
      const policy = evaluateCapabilityPolicy(capability, { canary, invocation });
      const route = this.state.planPlacement({
        authorityNodeId: this.authorityNodeId,
        capability,
        deviceId,
        placement,
        invocation,
        canary,
      });
      return {
        ...route,
        approvalRequired: policy.approvalRequired,
        externalEffect: policy.externalEffect,
        transport: capability.resources.includes("transport:xiaowei:22222")
          ? this.transportStatus()
          : { status: "not_required", ageMs: null },
      };
    } catch (error) {
      if (["NO_ELIGIBLE_DEVICE", "NODE_UNAVAILABLE", "PLACEMENT_CONFLICT", "DEVICE_BUSY"].includes(error?.code)) {
        return {
          decision: "blocked",
          advisory: true,
          error: {
            code: error.code,
            message: error.message,
            details: error.details || {},
          },
        };
      }
      throw error;
    }
  }

  listNodes() {
    const transport = this.transportStatus();
    return this.state.listNodes().map((node) => ({
      ...node,
      transport: node.nodeId === this.authorityNodeId ? transport : { status: "unknown", ageMs: null },
    }));
  }

  decideApproval(jobId, input) {
    const job = this.state.decideApproval(jobId, input);
    if (job.status === "queued") queueMicrotask(() => void this.pump());
    return job;
  }

  cancelJob(jobId) {
    return this.state.cancelJob(jobId);
  }

  async recoverJob({ jobId, actorId, idempotencyKey }) {
    if (typeof actorId !== "string" || actorId.trim() === "") {
      throw new ControlPlaneError("ACTOR_REQUIRED", "actorId is required");
    }
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") {
      throw new ControlPlaneError("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required");
    }
    const job = this.state.requireJob(jobId);
    const prior = this.state.listJobEvents(jobId).find((event) =>
      ["job.recovery.succeeded", "job.recovery.failed"].includes(event.type)
      && event.payload?.idempotencyKey === idempotencyKey);
    if (prior?.type === "job.recovery.succeeded") {
      return { ...prior.payload.recovery, reused: true };
    }
    if (prior?.type === "job.recovery.failed") {
      throw new ControlPlaneError(
        "RECOVERY_PREVIOUSLY_FAILED",
        "this recovery idempotency key already failed; inspect evidence before using a new key",
        { status: 409, details: { jobId, deviceId: job.deviceId } },
      );
    }
    if (job.status !== "recovery_required") {
      throw new ControlPlaneError("RECOVERY_NOT_REQUIRED", "job is not recovery_required", {
        status: 409,
        details: { jobId, status: job.status },
      });
    }
    const device = this.state.requireDevice(job.deviceId, {
      includeRuntime: true,
      requireReady: false,
    });
    if (!device.online) {
      throw new ControlPlaneError("DEVICE_OFFLINE", `${device.alias} is offline`, { status: 409 });
    }
    if (!device.quarantined) {
      throw new ControlPlaneError("DEVICE_NOT_QUARANTINED", `${device.alias} is not quarantined`, {
        status: 409,
      });
    }
    const capability = this.capabilities.require(job.capabilityId);
    const adapter = this.adapters.require(capability.implementation.adapter);
    if (typeof adapter.restore !== "function") {
      throw new ControlPlaneError("RECOVERY_UNAVAILABLE", "capability adapter has no restoration path", {
        status: 409,
      });
    }

    let lease = this.state.acquireLease({
      deviceId: job.deviceId,
      kind: "recovery",
      holderId: `recovery:${actorId.trim()}`,
      jobId: job.jobId,
      ttlMs: this.leaseTtlMs,
      allowQuarantined: true,
    });
    let heartbeatError = null;
    const heartbeat = setInterval(() => {
      try {
        this.state.heartbeatLease(lease.leaseId, lease.token, this.leaseTtlMs);
      } catch (error) {
        heartbeatError = error;
      }
    }, this.leaseHeartbeatMs);
    heartbeat.unref?.();
    const appendRecoveryEvent = (type, payload) => {
      const eventId = this.state.appendEvent({ jobId: job.jobId, runId: job.runId, type, payload });
      try {
        this.evidence.appendEvent(job.runId, {
          type,
          jobId: job.jobId,
          createdAt: new Date().toISOString(),
          ...payload,
        });
      } catch {
        // SQLite is the durable audit authority; JSONL mirroring is best-effort.
      }
      return eventId;
    };
    try {
      const recoveryStartedEventId = appendRecoveryEvent("job.recovery.started", {
        actorId: actorId.trim(),
        idempotencyKey,
        deviceId: job.deviceId,
      });
      const restoration = await adapter.restore({
        job,
        capability,
        device,
        params: job.params,
        evidenceDirectory: this.evidence.runDirectory(job.runId),
        leaseAuthorization: {
          leaseId: lease.leaseId,
          token: lease.token,
          deviceId: job.deviceId,
          controlUrl: this.operatorControlUrl,
        },
        execution: null,
        verification: null,
        error: null,
        recoveryAttempt: true,
      });
      if (heartbeatError) throw heartbeatError;
      const attached = [];
      for (const file of collectEvidenceFiles(restoration)) {
        attached.push(await this.evidence.attachFile({
          job,
          sourcePath: file.path,
          kind: file.kind || "adapter",
          label: file.label,
        }));
      }
      if (restoration?.evidenceRequired === true
        && !attached.some((item) => item.kind === "screenshot")) {
        throw new ControlPlaneError(
          "RECOVERY_SCREENSHOT_MISSING",
          "device recovery must attach a fresh screenshot before clearing quarantine",
          { status: 500 },
        );
      }
      if (restoration?.ok !== true) {
        throw new ControlPlaneError("RESTORATION_FAILED", "adapter restoration did not verify a safe state", {
          status: 409,
        });
      }
      let visualConfirmation = null;
      if (restoration?.visualConfirmationRequired === true) {
        const events = this.state.listJobEvents(job.jobId);
        const safeAnalysis = events.findLast((event) => event.type === "job.recovery.analysis.recorded"
          && event.eventId < recoveryStartedEventId
          && event.payload?.analysisResult?.pageClassification?.pageType === "main-safe"
          && event.payload?.analysisResult?.pageClassification?.safeStateVerified === true);
        const analysisAgeMs = safeAnalysis ? Date.now() - Date.parse(safeAnalysis.createdAt) : Infinity;
        const interveningRecovery = safeAnalysis && events.some((event) =>
          event.type === "job.recovery.started"
          && event.eventId > safeAnalysis.eventId
          && event.eventId < recoveryStartedEventId);
        if (restoration.zeroActionVerified !== true || !safeAnalysis
          || !Number.isFinite(analysisAgeMs) || analysisAgeMs < 0 || analysisAgeMs > 5 * 60 * 1000
          || interveningRecovery) {
          throw new ControlPlaneError(
            "RECOVERY_VISUAL_CONFIRMATION_REQUIRED",
            "fresh visual main-page confirmation and a zero-action recovery are required before clearing quarantine",
            {
              status: 409,
              details: {
                zeroActionVerified: restoration.zeroActionVerified === true,
                safeAnalysisFound: Boolean(safeAnalysis),
                analysisFresh: Number.isFinite(analysisAgeMs) && analysisAgeMs >= 0
                  && analysisAgeMs <= 5 * 60 * 1000,
                interveningRecovery: Boolean(interveningRecovery),
              },
            },
          );
        }
        visualConfirmation = {
          inspectionId: safeAnalysis.payload.analysisResult.inspectionId,
          imageSha256: safeAnalysis.payload.analysisResult.imageSha256,
          confidence: safeAnalysis.payload.analysisResult.pageClassification.confidence,
          analysisEvidenceId: safeAnalysis.payload.analysisResult.analysisEvidence?.evidenceId || null,
        };
      }
      clearInterval(heartbeat);
      this.state.releaseLease(lease.leaseId, lease.token);
      lease = null;
      const recovery = {
        ok: true,
        reused: false,
        jobId: job.jobId,
        runId: job.runId,
        deviceId: job.deviceId,
        restoration: {
          ok: true,
          step: restoration.step || null,
          safeStateVerified: restoration.safeStateVerified === true,
          evidenceIds: attached.map((item) => item.evidenceId),
          visualConfirmation,
        },
        quarantineCleared: true,
      };
      const successPayload = {
        actorId: actorId.trim(),
        idempotencyKey,
        deviceId: job.deviceId,
        recovery,
      };
      this.state.completeDeviceRecovery({
        deviceId: job.deviceId,
        jobId: job.jobId,
        runId: job.runId,
        payload: successPayload,
      });
      try {
        this.evidence.appendEvent(job.runId, {
          type: "job.recovery.succeeded",
          jobId: job.jobId,
          createdAt: new Date().toISOString(),
          ...successPayload,
        });
      } catch {
        // The transactional SQLite event remains authoritative.
      }
      return recovery;
    } catch (error) {
      const cause = asControlError(error, "RECOVERY_FAILED");
      appendRecoveryEvent("job.recovery.failed", {
        actorId: actorId.trim(),
        idempotencyKey,
        deviceId: job.deviceId,
        causeCode: cause.code,
        // 只落结构化诊断。原始 stdout/stderr 可能含 private runtime 或设备内容，禁止持久化。
        adapterCode: cause.details?.adapterCode ?? null,
        adapterExitCode: cause.details?.exitCode ?? null,
        adapterStderrPresent: cause.details?.stderrPresent === true,
      });
      throw new ControlPlaneError("RECOVERY_FAILED", "device recovery did not verify a safe state", {
        status: 409,
        details: { jobId: job.jobId, deviceId: job.deviceId, causeCode: cause.code },
        cause,
      });
    } finally {
      clearInterval(heartbeat);
      if (lease) {
        try {
          this.state.releaseLease(lease.leaseId, lease.token);
        } catch {
          // Lease expiry remains fail-closed; the device stays quarantined.
        }
      }
    }
  }

  async inspectRecovery({ jobId, actorId, idempotencyKey }) {
    if (typeof actorId !== "string" || actorId.trim() === "") {
      throw new ControlPlaneError("ACTOR_REQUIRED", "actorId is required");
    }
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") {
      throw new ControlPlaneError("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required");
    }
    const normalizedIdempotencyKey = idempotencyKey.trim();
    const job = this.state.requireJob(jobId);
    const prior = this.state.listJobEvents(jobId).find((event) =>
      ["job.recovery.inspect.succeeded", "job.recovery.inspect.failed"].includes(event.type)
      && event.payload?.idempotencyKey === normalizedIdempotencyKey);
    if (prior?.type === "job.recovery.inspect.succeeded") {
      return { ...prior.payload.inspection, reused: true };
    }
    if (prior?.type === "job.recovery.inspect.failed") {
      throw new ControlPlaneError(
        "RECOVERY_INSPECTION_PREVIOUSLY_FAILED",
        "this recovery inspection idempotency key already failed; inspect its evidence before using a new key",
        { status: 409, details: { jobId, deviceId: job.deviceId } },
      );
    }
    if (job.status !== "recovery_required") {
      throw new ControlPlaneError("RECOVERY_NOT_REQUIRED", "job is not recovery_required", {
        status: 409,
        details: { jobId, status: job.status },
      });
    }
    const device = this.state.requireDevice(job.deviceId, {
      includeRuntime: true,
      requireReady: false,
    });
    if (!device.online) {
      throw new ControlPlaneError("DEVICE_OFFLINE", `${device.alias} is offline`, { status: 409 });
    }
    if (!device.quarantined) {
      throw new ControlPlaneError("DEVICE_NOT_QUARANTINED", `${device.alias} is not quarantined`, {
        status: 409,
      });
    }
    const capability = this.capabilities.require(job.capabilityId);
    const adapter = this.adapters.require(capability.implementation.adapter);
    if (typeof adapter.inspectRecovery !== "function") {
      throw new ControlPlaneError(
        "RECOVERY_INSPECTION_UNAVAILABLE",
        "capability adapter has no read-only recovery inspection path",
        { status: 409 },
      );
    }

    let lease = this.state.acquireLease({
      deviceId: job.deviceId,
      kind: "recovery",
      holderId: `recovery-inspection:${actorId.trim()}`,
      jobId: job.jobId,
      ttlMs: this.leaseTtlMs,
      allowQuarantined: true,
    });
    let heartbeatError = null;
    const heartbeat = setInterval(() => {
      try {
        this.state.heartbeatLease(lease.leaseId, lease.token, this.leaseTtlMs);
      } catch (error) {
        heartbeatError = error;
      }
    }, this.leaseHeartbeatMs);
    heartbeat.unref?.();
    const appendInspectionEvent = (type, payload) => {
      const eventId = this.state.appendEvent({ jobId: job.jobId, runId: job.runId, type, payload });
      try {
        this.evidence.appendEvent(job.runId, {
          type,
          jobId: job.jobId,
          createdAt: new Date().toISOString(),
          ...payload,
        });
      } catch {
        // SQLite is the durable audit authority; JSONL mirroring is best-effort.
      }
      return eventId;
    };
    try {
      const startedEventId = appendInspectionEvent("job.recovery.inspect.started", {
        actorId: actorId.trim(),
        idempotencyKey: normalizedIdempotencyKey,
        deviceId: job.deviceId,
      });
      if (heartbeatError) throw heartbeatError;
      this.state.heartbeatLease(lease.leaseId, lease.token, this.leaseTtlMs);
      const output = await adapter.inspectRecovery({
        job,
        capability,
        device,
        params: job.params,
        evidenceDirectory: this.evidence.runDirectory(job.runId),
        leaseAuthorization: {
          leaseId: lease.leaseId,
          token: lease.token,
          deviceId: job.deviceId,
          controlUrl: this.operatorControlUrl,
        },
      });
      if (heartbeatError) throw heartbeatError;
      if (output?.ok !== true || output?.stoppedBeforeAction !== true) {
        throw new ControlPlaneError(
          "RECOVERY_INSPECTION_REJECTED",
          "adapter did not produce a verified read-only recovery inspection",
          { status: 409, details: { step: output?.step || null } },
        );
      }

      const attached = [];
      for (const file of collectEvidenceFiles(output)) {
        attached.push(await this.evidence.attachFile({
          job,
          sourcePath: file.path,
          kind: file.kind || "adapter",
          label: file.label,
        }));
      }
      const screenshot = attached.find((item) => item.kind === "screenshot");
      if (!screenshot) {
        throw new ControlPlaneError(
          "RECOVERY_INSPECTION_SCREENSHOT_MISSING",
          "recovery inspection must attach a screenshot",
          { status: 500 },
        );
      }
      const pageClassification = output?.observation?.pageClassification || {
        schemaVersion: 1,
        pageType: "unknown",
        confidence: 0,
        safeStateVerified: false,
        reasons: ["visual analysis pending"],
      };
      const inspectionId = `inspection_${startedEventId}`;
      const record = this.evidence.writeJson({
        job,
        kind: "recovery_inspection",
        label: `recovery-inspection-${inspectionId}`,
        value: {
          schemaVersion: 1,
          inspectionId,
          jobId: job.jobId,
          runId: job.runId,
          deviceId: job.deviceId,
          stoppedBeforeAction: true,
          quarantineCleared: false,
          screenshot: {
            evidenceId: screenshot.evidenceId,
            path: screenshot.path,
            sha256: screenshot.sha256,
            bytes: screenshot.bytes,
          },
          observation: output.observation || {},
          analysis: {
            status: pageClassification.pageType === "unknown" ? "pending" : "semantic_hint_only",
            requiredImageSha256: screenshot.sha256,
            protocol: "xhs.visual-elements.v1",
          },
        },
      });
      const inspection = {
        ok: true,
        reused: false,
        inspectionId,
        jobId: job.jobId,
        runId: job.runId,
        deviceId: job.deviceId,
        stoppedBeforeAction: true,
        quarantineCleared: false,
        screenshot: {
          evidenceId: screenshot.evidenceId,
          kind: screenshot.kind,
          path: screenshot.path,
          sha256: screenshot.sha256,
          bytes: screenshot.bytes,
        },
        inspectionEvidence: {
          evidenceId: record.evidenceId,
          path: record.path,
          sha256: record.sha256,
        },
        pageClassification,
        focus: {
          package: String(output?.observation?.focus?.package || "").slice(0, 160),
          activity: String(output?.observation?.focus?.activity || "").slice(0, 240),
        },
        analysis: {
          status: pageClassification.pageType === "unknown" ? "pending" : "semantic_hint_only",
          requiredImageSha256: screenshot.sha256,
          protocol: "xhs.visual-elements.v1",
        },
      };
      appendInspectionEvent("job.recovery.inspect.succeeded", {
        actorId: actorId.trim(),
        idempotencyKey: normalizedIdempotencyKey,
        deviceId: job.deviceId,
        inspection,
      });
      return inspection;
    } catch (error) {
      const cause = asControlError(error, "RECOVERY_INSPECTION_FAILED");
      const adapterCode = boundedAdapterCode(cause);
      appendInspectionEvent("job.recovery.inspect.failed", {
        actorId: actorId.trim(),
        idempotencyKey: normalizedIdempotencyKey,
        deviceId: job.deviceId,
        causeCode: cause.code,
        adapterCode,
        step: cause.details?.step || null,
      });
      throw new ControlPlaneError(
        "RECOVERY_INSPECTION_FAILED",
        "read-only recovery inspection did not produce durable evidence",
        {
          status: 409,
          details: { jobId: job.jobId, deviceId: job.deviceId, causeCode: cause.code, adapterCode },
          cause,
        },
      );
    } finally {
      clearInterval(heartbeat);
      if (lease) {
        try {
          this.state.releaseLease(lease.leaseId, lease.token);
        } catch (releaseError) {
          try {
            appendInspectionEvent("job.recovery.inspect.lease_release_failed", {
              actorId: actorId.trim(),
              idempotencyKey: normalizedIdempotencyKey,
              deviceId: job.deviceId,
              causeCode: releaseError?.code || "LEASE_RELEASE_FAILED",
            });
          } catch {
            // Lease expiry and quarantine remain fail-closed even if audit mirroring also fails.
          }
        }
      }
    }
  }

  async recordRecoveryInspectionAnalysis({
    jobId,
    inspectionId,
    actorId,
    idempotencyKey,
    analysis,
  }) {
    if (typeof actorId !== "string" || actorId.trim() === "") {
      throw new ControlPlaneError("ACTOR_REQUIRED", "actorId is required");
    }
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") {
      throw new ControlPlaneError("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required");
    }
    if (typeof inspectionId !== "string" || inspectionId.trim() === "") {
      throw new ControlPlaneError("RECOVERY_INSPECTION_ID_REQUIRED", "inspectionId is required", { status: 400 });
    }
    const normalizedIdempotencyKey = idempotencyKey.trim();
    const normalizedInspectionId = inspectionId.trim();
    let analysisRequestHash;
    try {
      analysisRequestHash = fingerprint({ inspectionId: normalizedInspectionId, analysis });
    } catch {
      throw new ControlPlaneError(
        "RECOVERY_ANALYSIS_SCHEMA_INVALID",
        "analysis must be JSON-serializable",
        { status: 400 },
      );
    }
    const job = this.state.requireJob(jobId);
    const prior = this.state.listJobEvents(jobId).find((event) =>
      event.type === "job.recovery.analysis.recorded"
      && event.payload?.idempotencyKey === normalizedIdempotencyKey);
    if (prior) {
      if (prior.payload?.analysisRequestHash !== analysisRequestHash
        || prior.payload?.inspectionId !== normalizedInspectionId) {
        throw new ControlPlaneError(
          "IDEMPOTENCY_KEY_CONFLICT",
          "idempotency key was already used with a different recovery analysis request",
          { status: 409, details: { jobId, inspectionId: normalizedInspectionId } },
        );
      }
      return { ...prior.payload.analysisResult, reused: true };
    }
    if (job.status !== "recovery_required") {
      throw new ControlPlaneError("RECOVERY_NOT_REQUIRED", "job is not recovery_required", {
        status: 409,
        details: { jobId, status: job.status },
      });
    }
    const inspectionEvent = this.state.listJobEvents(jobId).find((event) =>
      event.type === "job.recovery.inspect.succeeded"
      && event.payload?.inspection?.inspectionId === normalizedInspectionId);
    if (!inspectionEvent) {
      throw new ControlPlaneError(
        "RECOVERY_INSPECTION_NOT_FOUND",
        "analysis must reference a successful audited recovery inspection",
        { status: 404, details: { jobId, inspectionId: normalizedInspectionId } },
      );
    }
    const inspection = inspectionEvent.payload.inspection;
    try {
      const normalized = normalizeRecoveryVisualAnalysis(analysis, {
        expectedImageSha256: inspection.screenshot.sha256,
        focus: inspection.focus,
      });
      const evidence = this.evidence.writeJson({
        job,
        kind: "recovery_analysis",
        label: `recovery-analysis-${normalizedInspectionId}`,
        value: {
          inspectionId: normalizedInspectionId,
          jobId: job.jobId,
          runId: job.runId,
          deviceId: job.deviceId,
          stoppedBeforeAction: true,
          quarantineCleared: false,
          ...normalized,
        },
      });
      const analysisResult = {
        ok: true,
        reused: false,
        inspectionId: normalizedInspectionId,
        jobId: job.jobId,
        runId: job.runId,
        deviceId: job.deviceId,
        stoppedBeforeAction: true,
        quarantineCleared: false,
        imageSha256: normalized.image.sha256,
        analyzer: normalized.analyzer,
        elementCount: normalized.elementCount,
        pageClassification: normalized.pageClassification,
        analysisEvidence: {
          evidenceId: evidence.evidenceId,
          path: evidence.path,
          sha256: evidence.sha256,
        },
      };
      const payload = {
        actorId: actorId.trim(),
        idempotencyKey: normalizedIdempotencyKey,
        deviceId: job.deviceId,
        inspectionId: normalizedInspectionId,
        analysisRequestHash,
        analysisResult,
      };
      this.state.appendEvent({
        jobId: job.jobId,
        runId: job.runId,
        type: "job.recovery.analysis.recorded",
        payload,
      });
      try {
        this.evidence.appendEvent(job.runId, {
          type: "job.recovery.analysis.recorded",
          jobId: job.jobId,
          createdAt: new Date().toISOString(),
          ...payload,
        });
      } catch {
        // SQLite is the durable audit authority; JSONL mirroring is best-effort.
      }
      return analysisResult;
    } catch (error) {
      const cause = asControlError(error, "RECOVERY_ANALYSIS_REJECTED");
      const payload = {
        actorId: actorId.trim(),
        idempotencyKey: normalizedIdempotencyKey,
        deviceId: job.deviceId,
        inspectionId: normalizedInspectionId,
        analysisRequestHash,
        causeCode: cause.code,
      };
      this.state.appendEvent({
        jobId: job.jobId,
        runId: job.runId,
        type: "job.recovery.analysis.rejected",
        payload,
      });
      try {
        this.evidence.appendEvent(job.runId, {
          type: "job.recovery.analysis.rejected",
          jobId: job.jobId,
          createdAt: new Date().toISOString(),
          ...payload,
        });
      } catch {
        // SQLite is the durable audit authority; JSONL mirroring is best-effort.
      }
      throw new ControlPlaneError(
        "RECOVERY_ANALYSIS_REJECTED",
        "visual analysis did not match the audited recovery screenshot contract",
        {
          status: 409,
          details: { jobId: job.jobId, inspectionId: normalizedInspectionId, causeCode: cause.code },
          cause,
        },
      );
    }
  }

  createSession({
    actorId,
    deviceId = null,
    placement = {},
    capabilityId = null,
    canary = false,
  }) {
    const capability = capabilityId ? this.capabilities.require(capabilityId) : null;
    if (capability) evaluateCapabilityPolicy(capability, { canary, invocation: "session" });
    return this.state.createSession({
      actorId,
      authorityNodeId: this.authorityNodeId,
      deviceId,
      placement,
      capability,
      canary,
      ttlMs: this.leaseTtlMs,
    });
  }

  heartbeatSession(sessionId, token) {
    return this.state.heartbeatSession(sessionId, token, this.leaseTtlMs);
  }

  releaseSession(sessionId, token) {
    const session = this.state.validateSession(sessionId, token);
    if (this.activeJobs.has(session.deviceId)) {
      throw new ControlPlaneError(
        "SESSION_ACTION_RUNNING",
        "cannot release a session while its action is running",
        { status: 423, details: { sessionId } },
      );
    }
    return this.state.releaseSession(sessionId, token);
  }

  async executeSessionAction(sessionId, token, {
    idempotencyKey,
    capabilityId,
    params = {},
  }) {
    const session = this.state.validateSession(sessionId, token);
    if (session.scopeCapabilityId && session.scopeCapabilityId !== capabilityId) {
      throw new ControlPlaneError(
        "SESSION_CAPABILITY_MISMATCH",
        `session is scoped to ${session.scopeCapabilityId}`,
        { status: 409, details: { scopeCapabilityId: session.scopeCapabilityId } },
      );
    }
    const capability = this.capabilities.validateParams(capabilityId, params);
    const policy = evaluateCapabilityPolicy(capability, { canary: session.canary, invocation: "session" });
    if (policy.approvalRequired) {
      throw new ControlPlaneError(
        "APPROVAL_REQUIRED",
        "external effects must be submitted as an approvable job",
        { status: 403 },
      );
    }
    if (this.activeJobs.has(session.deviceId)) {
      throw new ControlPlaneError(
        "DEVICE_BUSY",
        "device already has an action in progress",
        { status: 423, details: { sessionId } },
      );
    }
    this.evidence.assertCapacity({ externalEffect: false });
    const created = this.state.createJob({
      idempotencyKey,
      actorId: session.actorId,
      authorityNodeId: this.authorityNodeId,
      deviceId: session.deviceId,
      placement: {},
      capability,
      params,
      canary: session.canary,
      sessionId,
      status: "queued",
      approvalRequired: false,
      externalEffect: false,
    });
    if (created.reused) {
      if (created.job.sessionId !== sessionId) {
        throw new ControlPlaneError(
          "IDEMPOTENCY_CONFLICT",
          "idempotency key belongs to a different session",
          { status: 409, details: { jobId: created.job.jobId } },
        );
      }
      return {
        ...created.job,
        storage: this.evidence.storageForRun(created.job.runId),
      };
    }
    const device = this.state.requireDevice(session.deviceId);
    this.evidence.initializeRun({ job: created.job, device });
    const promise = this.#runJob(created.job, {
      lease: { leaseId: session.leaseId, token },
      releaseLease: false,
    }).finally(() => {
      if (this.activeJobs.get(session.deviceId) === promise) {
        this.activeJobs.delete(session.deviceId);
      }
      if (this.started) queueMicrotask(() => void this.pump());
    });
    this.activeJobs.set(session.deviceId, promise);
    const job = await promise;
    return {
      ...job,
      storage: this.evidence.storageForRun(job.runId),
    };
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (const job of this.state.nextQueuedJobs()) {
        if (this.activeJobs.has(job.deviceId)) continue;
        let lease;
        try {
          lease = this.state.acquireLease({
            deviceId: job.deviceId,
            kind: "job",
            holderId: `job:${job.jobId}`,
            jobId: job.jobId,
            ttlMs: this.leaseTtlMs,
          });
        } catch (error) {
          // Skip jobs that cannot acquire a lease right now; leave them queued so they
          // retry after the device recovers (busy / quarantined / offline).
          if (["DEVICE_BUSY", "DEVICE_QUARANTINED", "DEVICE_OFFLINE"].includes(error?.code)) {
            continue;
          }
          throw error;
        }
        const promise = this.#runJob(job, { lease, releaseLease: true })
          .finally(() => {
            this.activeJobs.delete(job.deviceId);
            if (this.started) queueMicrotask(() => void this.pump());
          });
        this.activeJobs.set(job.deviceId, promise);
      }
    } finally {
      this.pumping = false;
    }
  }

  async waitForJob(jobId, { timeoutMs = 5000, pollMs = 10 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const job = this.state.requireJob(jobId);
      if (["succeeded", "failed", "ambiguous", "recovery_required", "cancelled", "waiting_approval"].includes(job.status)) {
        return job;
      }
      if (Date.now() >= deadline) {
        throw new ControlPlaneError("JOB_WAIT_TIMEOUT", `timed out waiting for ${jobId}`, { status: 504 });
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  async #runJob(initialJob, { lease, releaseLease }) {
    let job = this.state.requireJob(initialJob.jobId);
    let execution;
    let verification;
    let restoration;
    let primaryError;
    let restoreError;
    let heartbeatError;
    const capability = job.capability;
    const adapter = this.adapters.require(capability.implementation.adapter);
    const device = this.state.requireDevice(job.deviceId, { includeRuntime: true });
    const context = {
      job,
      capability,
      device,
      params: job.params,
      evidenceDirectory: this.evidence.runDirectory(job.runId),
    };
    const authorizedContext = {
      ...context,
      leaseAuthorization: {
        leaseId: lease.leaseId,
        token: lease.token,
        deviceId: job.deviceId,
        controlUrl: this.operatorControlUrl,
      },
    };
    const heartbeat = setInterval(() => {
      try {
        this.state.heartbeatLease(lease.leaseId, lease.token, this.leaseTtlMs);
      } catch (error) {
        heartbeatError = error;
      }
    }, this.leaseHeartbeatMs);
    heartbeat.unref?.();

    try {
      job = this.state.transitionJob(job.jobId, "running");
      this.evidence.appendEvent(job.runId, { type: "job.running", jobId: job.jobId, createdAt: new Date().toISOString() });
      execution = await adapter.execute(authorizedContext);
      if (heartbeatError) throw heartbeatError;

      job = this.state.transitionJob(job.jobId, "verifying");
      this.evidence.appendEvent(job.runId, { type: "job.verifying", jobId: job.jobId, createdAt: new Date().toISOString() });
      verification = adapter.verify
        ? await adapter.verify({ ...context, execution })
        : { ok: true, mode: "none" };
      if (verification?.ok === false) {
        const error = new ControlPlaneError("VERIFICATION_FAILED", "capability postcondition was not verified", {
          status: 409,
          details: { mode: verification.mode || capability.verification.mode },
        });
        error.ambiguous = Boolean(verification.ambiguous);
        throw error;
      }
    } catch (error) {
      primaryError = asControlError(error);
      if (error?.sent) primaryError.sent = true;
      if (error?.ambiguous) primaryError.ambiguous = true;
    }

    try {
      job = this.state.transitionJob(job.jobId, "restoring", {
        payload: { required: capability.restoration.required },
      });
      this.evidence.appendEvent(job.runId, { type: "job.restoring", jobId: job.jobId, createdAt: new Date().toISOString() });
      restoration = adapter.restore
        ? await adapter.restore({ ...authorizedContext, execution, verification, error: primaryError })
        : { ok: !capability.restoration.required };
      if (capability.restoration.required && restoration?.ok === false) {
        throw new ControlPlaneError("RESTORATION_FAILED", "adapter restoration failed", { status: 409 });
      }
    } catch (error) {
      restoreError = asControlError(error, "RESTORATION_FAILED");
    }

    try {
      for (const file of collectEvidenceFiles(execution, verification, restoration)) {
        await this.evidence.attachFile({
          job,
          sourcePath: file.path,
          kind: file.kind || "adapter",
          label: file.label,
        });
      }
      const summary = resultSummary(execution, verification, restoration, primaryError);
      this.evidence.writeJson({ job, kind: "result", label: "result", value: summary });
      if (restoreError || heartbeatError) {
        const code = restoreError?.code || heartbeatError?.code || "RECOVERY_REQUIRED";
        this.state.quarantineDevice(job.deviceId, code);
        job = this.state.transitionJob(job.jobId, "recovery_required", { errorCode: code, result: summary });
      } else if (primaryError) {
        const ambiguous = !primaryError.notSent
          && (primaryError.sent
            || primaryError.ambiguous
            || capability.idempotency === "ambiguous_on_timeout");
        job = this.state.transitionJob(job.jobId, ambiguous ? "ambiguous" : "failed", {
          errorCode: primaryError.code,
          result: summary,
        });
      } else {
        job = this.state.transitionJob(job.jobId, "succeeded", { result: summary });
      }
      this.evidence.appendEvent(job.runId, {
        type: `job.${job.status}`,
        jobId: job.jobId,
        errorCode: job.errorCode,
        createdAt: new Date().toISOString(),
      });
      return job;
    } finally {
      clearInterval(heartbeat);
      if (releaseLease) {
        try { this.state.releaseLease(lease.leaseId, lease.token); } catch {}
      }
    }
  }
}
