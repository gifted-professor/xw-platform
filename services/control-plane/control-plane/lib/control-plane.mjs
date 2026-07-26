import { ControlPlaneError, asControlError } from "./errors.mjs";
import { fingerprint } from "./canonical.mjs";
import { evaluateCapabilityPolicy } from "./policy.mjs";
import { inspectTransportLock } from "./xiaowei-transport.mjs";
import { normalizeRecoveryVisualAnalysis } from "./recovery-inspection.mjs";

function collectEvidenceFiles(...values) {
  return values.flatMap((value) => Array.isArray(value?.evidenceFiles) ? value.evidenceFiles : []);
}

function boundedAdapterCode(error) {
  const value = error?.details?.adapterCode;
  return typeof value === "string" && /^[A-Z0-9_]{1,96}$/.test(value) ? value : null;
}

function resultSummary(execution, verification, restoration, error = null) {
  const out = execution?.output;
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
