import { ControlPlaneError, asControlError } from "./errors.mjs";
import { evaluateCapabilityPolicy } from "./policy.mjs";
import { inspectTransportLock } from "./xiaowei-transport.mjs";

function collectEvidenceFiles(...values) {
  return values.flatMap((value) => Array.isArray(value?.evidenceFiles) ? value.evidenceFiles : []);
}

function resultSummary(execution, verification, restoration, error = null) {
  const out = execution?.output;
  return {
    vendorCode: execution?.vendorCode ?? null,
    // 执行细节摘要（ok/step/verified/counts/text），便于 VERIFICATION_FAILED 时回溯，不落完整 dump
    output: out && typeof out === "object"
      ? Object.fromEntries(
        ["ok", "step", "verified", "verifyMethod", "beforeCount", "afterCount", "text"]
          .filter((k) => out[k] !== undefined)
          .map((k) => [k, out[k]]),
      )
      : null,
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
    transportStatus = inspectTransportLock,
    schedulerIntervalMs = 100,
    leaseTtlMs = 60000,
    leaseHeartbeatMs = 10000,
  }) {
    this.state = state;
    this.capabilities = capabilities;
    this.adapters = adapters instanceof AdapterRegistry ? adapters : new AdapterRegistry(adapters);
    this.evidence = evidence;
    this.authorityNodeId = authorityNodeId;
    this.transportStatus = transportStatus;
    this.schedulerIntervalMs = schedulerIntervalMs;
    this.leaseTtlMs = leaseTtlMs;
    this.leaseHeartbeatMs = leaseHeartbeatMs;
    this.activeJobs = new Map();
    this.started = false;
    this.pumping = false;
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
    void this.pump();
  }

  async stop() {
    this.started = false;
    clearInterval(this.scheduler);
    await Promise.allSettled([...this.activeJobs.values()]);
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
      return {
        ...created.job,
        storage: this.evidence.storageForRun(created.job.runId),
      };
    }
    const device = this.state.requireDevice(session.deviceId);
    this.evidence.initializeRun({ job: created.job, device });
    const job = await this.#runJob(created.job, {
      lease: { leaseId: session.leaseId, token },
      releaseLease: false,
    });
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
          if (error?.code === "DEVICE_BUSY") continue;
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
      execution = await adapter.execute(context);
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
        ? await adapter.restore({ ...context, execution, verification, error: primaryError })
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
