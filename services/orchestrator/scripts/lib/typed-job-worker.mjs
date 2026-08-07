import { createWorkReceipt } from "./work-receipt.mjs";

const TERMINAL = new Set(["succeeded", "failed", "ambiguous", "recovery_required", "cancelled", "waiting_approval"]);
const STOP_CODES = /CAPTCHA|RISK|LOGIN|APPROVAL|RECOVERY_REQUIRED|UNKNOWN_EXTERNAL_EFFECT|UNEXPECTED_EXTERNAL_EFFECT|PLACEMENT_MISMATCH|CAPABILITY_MISMATCH|CAPABILITY_NOT_PROVEN|POLICY_MISMATCH|ROUTE_NOT_PROVEN|ROUTE_POLICY_MISMATCH/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unwrapJob(result) {
  return result?.job || result?.data?.job || result;
}

function jobOutput(job) {
  return job?.output ?? job?.result?.output ?? job?.resultSummary?.output ?? job?.result ?? null;
}

function jobError(job) {
  const error = job?.error || job?.result?.error || job?.resultSummary?.error || null;
  const code = error?.code || job?.errorCode || null;
  if (!error && !code) return null;
  return {
    ...(error && typeof error === "object" ? error : {}),
    code,
    message: error?.message || `job failed with ${code}`,
  };
}

function valueAt(object, path) {
  let current = object;
  for (const part of String(path).split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

function outputItems(output) {
  if (Array.isArray(output)) return output;
  for (const key of ["items", "posts", "cards", "results"]) {
    if (Array.isArray(output?.[key])) return output[key];
  }
  return [];
}

export function validateExpectedApp(expectedApp, output) {
  if (!expectedApp || typeof expectedApp !== "object") return { ok: true };
  const packageName = output?.packageName
    || output?.pkg
    || output?.package
    || output?.focus?.packageName
    || output?.focus?.package
    || output?.focus?.pkg
    || output?.currentApp?.packageName;
  const activity = output?.activity || output?.focus?.activity || output?.currentApp?.activity;
  const appId = output?.appId || output?.currentApp?.appId;
  if (expectedApp.appId && appId !== expectedApp.appId) {
    return { ok: false, code: "EXPECTED_APP_ID_MISMATCH", message: `expected appId ${expectedApp.appId}, got ${appId || "unknown"}` };
  }
  if (expectedApp.packageName && packageName !== expectedApp.packageName) {
    return { ok: false, code: "EXPECTED_APP_MISMATCH", message: `expected package ${expectedApp.packageName}, got ${packageName || "unknown"}` };
  }
  if (expectedApp.activity && activity !== expectedApp.activity) {
    return { ok: false, code: "EXPECTED_ACTIVITY_MISMATCH", message: `expected activity ${expectedApp.activity}, got ${activity || "unknown"}` };
  }
  return { ok: true };
}

export function validateBusinessOutput({ acceptance, output }) {
  if (!acceptance || typeof acceptance !== "object" || Object.keys(acceptance).length === 0) return { ok: true };
  const items = outputItems(output);
  if (Number.isInteger(acceptance.minItems) && items.length < acceptance.minItems) {
    return { ok: false, code: "MIN_ITEMS_NOT_MET", message: `expected at least ${acceptance.minItems} items, got ${items.length}` };
  }
  if (Array.isArray(acceptance.requiredFields)) {
    for (const [index, item] of items.entries()) {
      for (const field of acceptance.requiredFields) {
        const value = valueAt(item, field);
        if (value == null || value === "") return { ok: false, code: "REQUIRED_FIELD_MISSING", message: `item ${index} missing ${field}` };
      }
    }
  }
  if (Array.isArray(acceptance.rejectPageKinds) && acceptance.rejectPageKinds.includes(output?.pageKind)) {
    return { ok: false, code: "REJECTED_PAGE_KIND", message: `page kind ${output.pageKind} is not a business result` };
  }
  return { ok: true };
}

export class ControlPlaneHttpClient {
  constructor({ baseUrl = "http://127.0.0.1:17920/", requestTimeoutMs = 15000 } = {}) {
    this.baseUrl = baseUrl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async request(method, path, body) {
    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result?.error?.message || `control plane request failed (${response.status})`);
      error.code = result?.error?.code || "CONTROL_REQUEST_FAILED";
      error.details = result?.error?.details;
      throw error;
    }
    return result;
  }

  routePlan(input) {
    return this.request("POST", "/control/v1/routes/plan", input);
  }

  submitJob(input) {
    return this.request("POST", "/control/v1/jobs", input);
  }

  getJob(jobId) {
    return this.request("GET", `/control/v1/jobs/${encodeURIComponent(jobId)}`);
  }

  getDevices() {
    return this.request("GET", "/control/v1/devices");
  }

  getCapabilities() {
    return this.request("GET", "/control/v1/capabilities");
  }

  acquireSession(input) {
    return this.request("POST", "/control/v1/sessions", {
      actorId: input.actorId,
      capabilityId: input.capabilityId,
      canary: input.canary !== false,
      placement: { alias: input.alias },
      ...(input.workflowId ? { metadata: { workflowId: input.workflowId } } : {}),
    }).then((payload) => {
      const session = payload?.session || payload;
      return {
        sessionId: session.sessionId,
        leaseId: session.leaseId,
        token: session.token,
        deviceId: session.deviceId,
        alias: session.routeDecision?.selectedDevice?.alias || input.alias,
        expiresAt: session.expiresAt,
        raw: payload,
      };
    });
  }

  sessionAction(input) {
    return this.request(
      "POST",
      `/control/v1/sessions/${encodeURIComponent(input.sessionId)}/actions`,
      {
        token: input.token,
        capabilityId: input.capabilityId,
        idempotencyKey: input.idempotencyKey,
        params: input.params,
      },
    ).then((payload) => {
      const job = payload?.job || payload;
      return {
        jobId: job.jobId || job.id,
        runId: job.runId || null,
        status: job.status,
        output: job.result?.output || job.output || {},
        frame: job.result?.frame || job.frame || null,
        raw: payload,
      };
    });
  }

  releaseSession(input) {
    return this.request(
      "POST",
      `/control/v1/sessions/${encodeURIComponent(input.sessionId)}/release`,
      { token: input.token },
    );
  }

  getLeases() {
    return this.request("GET", "/control/v1/leases");
  }

  async assertLeaseVisible(leaseId, { actorId } = {}) {
    const payload = await this.getLeases();
    const leases = payload?.leases || payload?.data?.leases || [];
    const found = leases.find((item) => item.leaseId === leaseId);
    if (!found) {
      throw Object.assign(new Error(`lease ${leaseId} not visible`), { code: "EXPLORER_LEASE_NOT_VISIBLE" });
    }
    if (actorId && found.holderId && found.holderId !== actorId) {
      throw Object.assign(new Error(`lease holder mismatch`), { code: "EXPLORER_LEASE_HOLDER_MISMATCH" });
    }
    return found;
  }

  async assertLeaseAbsent(leaseId) {
    const payload = await this.getLeases();
    const leases = payload?.leases || payload?.data?.leases || [];
    if (leases.some((item) => item.leaseId === leaseId)) {
      throw Object.assign(new Error(`lease ${leaseId} still visible after release`), { code: "LEASE_STILL_VISIBLE" });
    }
    return true;
  }
}

export class TypedJobWorker {
  constructor({ client, actorId, pollMs = 1000, pollTimeoutMs = 15 * 60 * 1000, businessValidators = {} } = {}) {
    if (!client) throw new Error("client is required");
    if (!actorId) throw new Error("actorId is required");
    this.client = client;
    this.actorId = actorId;
    this.pollMs = pollMs;
    this.pollTimeoutMs = pollTimeoutMs;
    this.businessValidators = businessValidators;
  }

  async assertLiveCapability(executor) {
    if (typeof this.client.getCapabilities !== "function") {
      throw Object.assign(new Error("client cannot prove the live capability catalog"), { code: "CAPABILITY_NOT_PROVEN" });
    }
    const response = await this.client.getCapabilities();
    const capability = (response?.capabilities || response?.data?.capabilities || []).find((item) => item.id === executor.capabilityId);
    if (!capability) throw Object.assign(new Error(`capability ${executor.capabilityId} is not in the live catalog`), { code: "CAPABILITY_NOT_PROVEN" });
    const safe = capability.availability === "implemented"
      && ["read_only", "replay_safe"].includes(capability.idempotency)
      && capability.automationPolicy?.mode === "automatic"
      && !["R2", "R3"].includes(capability.risk);
    if (!safe || capability.appId !== executor.appId) {
      throw Object.assign(new Error(`capability ${executor.capabilityId} is not P0-safe or app binding changed`), { code: "POLICY_MISMATCH" });
    }
    return capability;
  }

  assertSafeRoute(routeResponse, assignment) {
    const route = routeResponse?.route || routeResponse?.data?.route;
    if (!route) throw Object.assign(new Error("route plan did not return a route"), { code: "ROUTE_NOT_PROVEN" });
    const selectedAlias = route.selectedDevice?.alias || route.alias || null;
    const safe = route.decision === "dispatchable"
      && selectedAlias === assignment.alias
      && route.externalEffect === false
      && route.approvalRequired === false
      && route.activeLease === false;
    if (!safe) {
      throw Object.assign(new Error(`route plan is not P0-dispatchable for alias ${assignment.alias}`), { code: "ROUTE_POLICY_MISMATCH" });
    }
    return route;
  }

  async execute(assignment) {
    const startedAt = new Date().toISOString();
    let job = {};
    let phase = "pre_submit";
    try {
      const capabilityId = assignment.node.executor.capabilityId;
      const liveCapability = await this.assertLiveCapability(assignment.node.executor);
      const common = {
        actorId: this.actorId,
        capabilityId,
        params: assignment.shard.params,
        placement: { alias: assignment.alias },
      };
      if (assignment.resumeJobId) {
        phase = "submitted";
        job = unwrapJob(await this.client.getJob(assignment.resumeJobId));
      } else {
        // A resumed attempt without a bound job still crosses a fresh submit
        // boundary. Re-check the current route in case policy, placement, or
        // device occupancy changed while the Lead was down.
        this.assertSafeRoute(await this.client.routePlan(common), assignment);
        phase = "submitting";
        const submitted = await this.client.submitJob({
          ...common,
          idempotencyKey: `m2:${assignment.taskRunId}:${assignment.shard.shardKey.slice(0, 20)}:a${assignment.attemptIndex}`,
        });
        job = unwrapJob(submitted);
        phase = "submitted";
      }
      const jobId = job.jobId || job.id;
      if (!jobId) throw Object.assign(new Error("control plane did not return jobId"), { code: "JOB_ID_MISSING" });
      await assignment.onProgress?.({ type: "job_bound", jobId, runId: job.runId || null, status: job.status || null });
      const selectedAlias = job.routeDecision?.selectedDevice?.alias || job.selectedDevice?.alias || null;
      if (selectedAlias && selectedAlias !== assignment.alias) {
        throw Object.assign(new Error(`control plane selected alias ${selectedAlias}, expected ${assignment.alias}`), { code: "PLACEMENT_MISMATCH" });
      }
      if (job.capabilityId && job.capabilityId !== capabilityId) {
        throw Object.assign(new Error(`control plane returned capability ${job.capabilityId}, expected ${capabilityId}`), { code: "CAPABILITY_MISMATCH" });
      }
      if (job.externalEffect === true || job.approvalRequired === true) {
        throw Object.assign(new Error("P0 worker refuses external-effect or approval-gated jobs"), { code: "UNEXPECTED_EXTERNAL_EFFECT" });
      }

      const pollDeadline = Date.now() + this.pollTimeoutMs;
      let lastPollError = null;
      while (!TERMINAL.has(job.status)) {
        if (Date.now() >= pollDeadline) {
          const finishedAt = new Date().toISOString();
          return createWorkReceipt({
            assignment,
            technicalStatus: "ambiguous",
            businessStatus: "ambiguous",
            retryable: false,
            job,
            output: jobOutput(job),
            error: { code: "JOB_POLL_TIMEOUT", message: lastPollError?.message || "job did not reach a terminal state before the worker deadline" },
            startedAt,
            finishedAt,
          });
        }
        await sleep(this.pollMs);
        try {
          job = unwrapJob(await this.client.getJob(jobId));
          lastPollError = null;
        } catch (pollError) {
          lastPollError = pollError;
        }
      }

      const finishedAt = new Date().toISOString();
      const output = jobOutput(job);
      if (job.status === "ambiguous" || job.status === "recovery_required") {
        const terminalError = jobError(job);
        return createWorkReceipt({
          assignment,
          technicalStatus: "ambiguous",
          businessStatus: "ambiguous",
          retryable: false,
          job,
          output,
          error: terminalError || { code: String(job.status).toUpperCase(), message: `job ended ${job.status}` },
          startedAt,
          finishedAt,
        });
      }
      if (job.status !== "succeeded") {
        const terminalError = jobError(job);
        const code = terminalError?.code || String(job.status).toUpperCase();
        const replaySafe = ["read_only", "replay_safe"].includes(assignment.node.executor.replaySafety);
        return createWorkReceipt({
          assignment,
          technicalStatus: job.status === "waiting_approval" ? "blocked" : "failed",
          businessStatus: "not_evaluated",
          retryable: replaySafe && !STOP_CODES.test(code),
          job,
          output,
          error: terminalError || { code, message: `job ended ${job.status}` },
          startedAt,
          finishedAt,
        });
      }

      const verification = job.verification ?? job.result?.verification;
      const restoration = job.restoration ?? job.result?.restoration;
      if (verification?.ok === false || restoration?.ok === false) {
        return createWorkReceipt({
          assignment,
          technicalStatus: "failed",
          businessStatus: "not_evaluated",
          retryable: ["read_only", "replay_safe"].includes(assignment.node.executor.replaySafety),
          job,
          output,
          error: { code: verification?.ok === false ? "VERIFICATION_FAILED" : "RESTORATION_FAILED", message: "control-plane verification/restoration failed" },
          startedAt,
          finishedAt,
        });
      }

      const uiEvidenceRequired = /foreground|focus|activity|page|screen|前台|页面/i.test(liveCapability.verification?.description || "");
      const expectedApp = assignment.node.executor.expectedApp || (uiEvidenceRequired
        ? (liveCapability.packageName ? { packageName: liveCapability.packageName } : { appId: liveCapability.appId })
        : null);
      const appCheck = validateExpectedApp(expectedApp, output);
      const acceptance = { ...(assignment.node.acceptance || {}), ...(assignment.shard.acceptance || {}) };
      const validator = this.businessValidators[capabilityId];
      const businessCheck = appCheck.ok
        ? (validator ? await validator({ assignment, output, job, acceptance }) : validateBusinessOutput({ acceptance, output }))
        : appCheck;
      return createWorkReceipt({
        assignment,
        technicalStatus: "succeeded",
        businessStatus: businessCheck.ok ? "accepted" : "rejected",
        retryable: !businessCheck.ok && ["read_only", "replay_safe"].includes(assignment.node.executor.replaySafety),
        job,
        output,
        error: businessCheck.ok ? null : businessCheck,
        startedAt,
        finishedAt,
      });
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const code = error?.code || "WORKER_EXCEPTION";
      const replaySafe = ["read_only", "replay_safe"].includes(assignment.node.executor.replaySafety);
      const crossedUncertainSubmitBoundary = phase === "submitting" || phase === "submitted";
      return createWorkReceipt({
        assignment,
        technicalStatus: crossedUncertainSubmitBoundary ? "ambiguous" : "failed",
        businessStatus: crossedUncertainSubmitBoundary ? "ambiguous" : "not_evaluated",
        retryable: !crossedUncertainSubmitBoundary && replaySafe && !STOP_CODES.test(code),
        job,
        output: jobOutput(job),
        error: { code: crossedUncertainSubmitBoundary ? "JOB_SUBMIT_UNCERTAIN" : code, message: error?.message || String(error) },
        startedAt,
        finishedAt,
      });
    }
  }
}
