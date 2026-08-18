import assert from "node:assert/strict";
import test from "node:test";
import { createTaskPlanV2 } from "../scripts/lib/task-plan-v2.mjs";
import { TypedJobWorker, validateBusinessOutput, validateExpectedApp } from "../scripts/lib/typed-job-worker.mjs";

function assignment({ acceptance, expectedApp } = {}) {
  const plan = createTaskPlanV2({
    goal: "worker fixture",
    requestKey: "worker-fixture",
    nodes: [{
      nodeId: "observe",
      executor: {
        kind: "typed_job",
        capabilityId: "xhs.observe.fixture",
        appId: "xhs",
        replaySafety: "read_only",
        effectClass: "none",
        resources: ["device"],
        ...(expectedApp ? { expectedApp } : {}),
      },
      shards: [{ params: { keyword: "fixture" }, ...(acceptance ? { acceptance } : {}) }],
    }],
  });
  return {
    taskRunId: "run_worker_fixture",
    planHash: plan.planHash,
    node: plan.nodes[0],
    shard: plan.nodes[0].shards[0],
    operationKey: `m2:run_worker_fixture:${plan.nodes[0].shards[0].shardKey}`,
    alias: "02",
    workerId: "worker-1",
    attemptIndex: 0,
    attemptId: "attempt_fixture_0",
  };
}

function safeClient(client) {
  return {
    ...client,
    async getCapabilities() {
      if (client.getCapabilities) return client.getCapabilities();
      return { capabilities: [{
        id: "xhs.observe.fixture",
        appId: "xhs",
        packageName: "com.xingin.xhs",
        availability: "implemented",
        idempotency: "read_only",
        risk: "R0",
        automationPolicy: { mode: "automatic" },
        verification: { description: "foreground package must match" },
      }] };
    },
    async routePlan(input) {
      const response = client.routePlan ? await client.routePlan(input) : null;
      const defaults = {
        decision: "dispatchable",
        selectedDevice: { alias: input.placement.alias },
        activeLease: false,
        authorization: { decision: "allow", decisionId: "auth_fixture_preview" },
      };
      return {
        route: {
          ...defaults,
          ...(response?.route || {}),
          selectedDevice: response?.route?.selectedDevice || defaults.selectedDevice,
          authorization: Object.prototype.hasOwnProperty.call(response?.route || {}, "authorization")
            ? response.route.authorization
            : defaults.authorization,
        },
      };
    },
    async submitJob(input) {
      const response = client.submitJob ? await client.submitJob(input) : { job: { jobId: "job_default", status: "succeeded" } };
      const job = response?.job || response;
      if (job && !job.authorization) {
        job.authorization = { decision: "allow", decisionId: "auth_job_fixture" };
      }
      if (job && !job.operationKey && input?.idempotencyKey) {
        job.operationKey = input.idempotencyKey;
      }
      return response?.job ? response : { job };
    },
    async getJob(jobId) {
      const response = client.getJob ? await client.getJob(jobId) : { job: { jobId, status: "succeeded" } };
      const job = response?.job || response;
      if (job && !job.authorization) {
        job.authorization = { decision: "allow", decisionId: "auth_job_fixture" };
      }
      return response?.job ? response : { job };
    },
  };
}

test("typed-job worker routes, submits, polls and business-validates", async () => {
  const calls = [];
  const client = {
    async routePlan(input) { calls.push(["route", input]); return { route: { alias: "02" } }; },
    async submitJob(input) {
      calls.push(["submit", input]);
      return {
        job: {
          jobId: "job_fixture",
          status: "queued",
          authorization: { decision: "allow", decisionId: "auth_job_fixture" },
          operationKey: input.idempotencyKey,
        },
      };
    },
    async getJob(jobId) {
      calls.push(["status", jobId]);
      return {
        job: {
          jobId,
          runId: "run_leaf_fixture",
          status: "succeeded",
          authorization: { decision: "allow", decisionId: "auth_job_fixture" },
          operationKey: `m2:run_worker_fixture:${assignment().shard.shardKey}`,
          verification: { ok: true },
          restoration: { ok: true },
          output: { packageName: "com.xingin.xhs", items: [{ postIdentity: "p1", title: "title", author: "author" }] },
        },
      };
    },
  };
  const worker = new TypedJobWorker({ client: safeClient(client), actorId: "fixture", pollMs: 0 });
  const next = assignment({ acceptance: { minItems: 1, requiredFields: ["postIdentity", "title", "author"] } });
  const receipt = await worker.execute(next);
  assert.equal(receipt.technicalStatus, "succeeded");
  assert.equal(receipt.businessStatus, "accepted");
  assert.equal(receipt.alias, "02");
  assert.equal(calls[0][1].placement.alias, "02");
  assert.equal(calls[1][1].idempotencyKey, next.operationKey);
  assert.equal(calls[1][1].idempotencyKey.includes(":a"), false);
});

test("technical success with wrong app is a business rejection", async () => {
  const client = {
    async routePlan() { return {}; },
    async submitJob() { return { job: { jobId: "job_wrong_app", status: "succeeded", output: { focus: { packageName: "com.tencent.mm" } } } }; },
  };
  const worker = new TypedJobWorker({ client: safeClient(client), actorId: "fixture", pollMs: 0 });
  const receipt = await worker.execute(assignment());
  assert.equal(receipt.technicalStatus, "succeeded");
  assert.equal(receipt.businessStatus, "rejected");
  assert.equal(receipt.error.code, "EXPECTED_APP_MISMATCH");
  assert.equal(receipt.retryable, true);
});

test("ambiguous and recovery-required terminal states never retry", async () => {
  for (const status of ["ambiguous", "recovery_required"]) {
    const client = {
      async routePlan() { return {}; },
      async submitJob() { return { job: { jobId: `job_${status}`, status } }; },
    };
    const worker = new TypedJobWorker({ client: safeClient(client), actorId: "fixture", pollMs: 0 });
    const receipt = await worker.execute(assignment());
    assert.equal(receipt.technicalStatus, "ambiguous", status);
    assert.equal(receipt.businessStatus, "ambiguous", status);
    assert.equal(receipt.retryable, false, status);
  }
});

test("worker preserves live control-plane errorCode for Lead capability health", async () => {
  const client = {
    async routePlan() { return {}; },
    async submitJob() {
      return {
        job: {
          jobId: "job_adapter_down",
          status: "failed",
          errorCode: "ADAPTER_HTTP_UNAVAILABLE",
          result: { error: { code: "ADAPTER_HTTP_UNAVAILABLE", message: "loopback adapter is unavailable" }, output: null },
        },
      };
    },
  };
  const worker = new TypedJobWorker({ client: safeClient(client), actorId: "fixture", pollMs: 0 });
  const receipt = await worker.execute(assignment());
  assert.equal(receipt.error.code, "ADAPTER_HTTP_UNAVAILABLE");
  assert.equal(receipt.retryable, true);
});

test("live capability gate proves catalog presence and appId; does not re-derive risk policy", async () => {
  let routed = false;
  const client = {
    async getCapabilities() {
      return { capabilities: [{
        id: "xhs.observe.fixture",
        appId: "xhs",
        availability: "implemented",
        idempotency: "ambiguous_on_timeout",
        risk: "R2",
        automationPolicy: { mode: "approval_required" },
      }] };
    },
    async routePlan() { routed = true; return {}; },
    async submitJob() {
      return {
        job: {
          jobId: "job_r2_allowed_by_cp",
          status: "succeeded",
          output: { packageName: "com.xingin.xhs", items: [{ id: 1 }] },
          verification: { ok: true },
          restoration: { ok: true },
        },
      };
    },
  };
  const worker = new TypedJobWorker({ client: safeClient(client), actorId: "fixture", pollMs: 0 });
  const receipt = await worker.execute(assignment());
  assert.equal(routed, true);
  assert.equal(receipt.technicalStatus, "succeeded");
  assert.equal(receipt.error, null);
});

test("missing live catalog and missing/blocked authorization stop before submit", async () => {
  let submitCalls = 0;
  const missingCatalog = new TypedJobWorker({
    client: {
      async routePlan() { return {}; },
      async submitJob() { submitCalls += 1; return {}; },
    },
    actorId: "fixture",
  });
  const noCatalogReceipt = await missingCatalog.execute(assignment());
  assert.equal(noCatalogReceipt.error.code, "CAPABILITY_NOT_PROVEN");
  assert.equal(submitCalls, 0);

  const missingAuth = new TypedJobWorker({
    client: safeClient({
      async routePlan(input) {
        return {
          route: {
            decision: "dispatchable",
            selectedDevice: { alias: input.placement.alias },
            activeLease: false,
            authorization: null,
          },
        };
      },
      async submitJob() { submitCalls += 1; return {}; },
    }),
    actorId: "fixture",
  });
  const missingAuthReceipt = await missingAuth.execute(assignment());
  assert.equal(missingAuthReceipt.error.code, "ROUTE_AUTHORIZATION_MISSING");
  assert.equal(submitCalls, 0);

  const blockedAuth = new TypedJobWorker({
    client: safeClient({
      async routePlan(input) {
        return {
          route: {
            decision: "dispatchable",
            selectedDevice: { alias: input.placement.alias },
            activeLease: false,
            authorization: { decision: "block", decisionId: "auth_blocked" },
          },
        };
      },
      async submitJob() { submitCalls += 1; return {}; },
    }),
    actorId: "fixture",
  });
  const blockedReceipt = await blockedAuth.execute(assignment());
  assert.equal(blockedReceipt.error.code, "ROUTE_POLICY_MISMATCH");
  assert.equal(submitCalls, 0);
});

test("uncertain submit and non-terminal poll timeout stop without retry", async () => {
  const submitWorker = new TypedJobWorker({
    client: safeClient({
      async routePlan() { return {}; },
      async submitJob() { throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" }); },
    }),
    actorId: "fixture",
    pollMs: 0,
  });
  const uncertain = await submitWorker.execute(assignment());
  assert.equal(uncertain.technicalStatus, "ambiguous");
  assert.equal(uncertain.error.code, "JOB_SUBMIT_UNCERTAIN");
  assert.equal(uncertain.retryable, false);

  const pollWorker = new TypedJobWorker({
    client: safeClient({
      async routePlan() { return {}; },
      async submitJob() { return { job: { jobId: "job_never_terminal", status: "queued" } }; },
      async getJob() { return { job: { jobId: "job_never_terminal", status: "running" } }; },
    }),
    actorId: "fixture",
    pollMs: 1,
    pollTimeoutMs: 5,
  });
  const timedOut = await pollWorker.execute(assignment());
  assert.equal(timedOut.technicalStatus, "ambiguous");
  assert.equal(timedOut.error.code, "JOB_POLL_TIMEOUT");
  assert.equal(timedOut.retryable, false);
});

test("resume polls a bound job without route or resubmit", async () => {
  let routeCalls = 0;
  let submitCalls = 0;
  const progress = [];
  const worker = new TypedJobWorker({
    client: safeClient({
      async routePlan() { routeCalls += 1; return {}; },
      async submitJob() { submitCalls += 1; return {}; },
      async getJob(jobId) {
        return { job: { jobId, runId: "run_leaf", status: "succeeded", output: { ok: true, packageName: "com.xingin.xhs" }, verification: { ok: true }, restoration: { ok: true } } };
      },
    }),
    actorId: "fixture",
    pollMs: 0,
  });
  const nextAssignment = assignment();
  nextAssignment.resume = true;
  nextAssignment.resumeJobId = "job_bound_before_crash";
  nextAssignment.onProgress = (event) => progress.push(event);
  const receipt = await worker.execute(nextAssignment);
  assert.equal(routeCalls, 0);
  assert.equal(submitCalls, 0);
  assert.equal(receipt.jobId, "job_bound_before_crash");
  assert.equal(receipt.businessStatus, "accepted");
  assert.equal(progress[0].jobId, "job_bound_before_crash");
});

test("resume without a bound job reuses the same attempt idempotency key and revalidates route", async () => {
  let routeCalls = 0;
  let submittedKey = null;
  const worker = new TypedJobWorker({
    client: safeClient({
      async routePlan() { routeCalls += 1; return {}; },
      async submitJob(input) {
        submittedKey = input.idempotencyKey;
        return { job: { jobId: "job_recovered_by_key", status: "succeeded", output: { ok: true, packageName: "com.xingin.xhs" }, verification: { ok: true }, restoration: { ok: true } } };
      },
    }),
    actorId: "fixture",
    pollMs: 0,
  });
  const nextAssignment = assignment();
  nextAssignment.resume = true;
  nextAssignment.resumeJobId = null;
  const receipt = await worker.execute(nextAssignment);
  assert.equal(routeCalls, 1);
  assert.equal(submittedKey, nextAssignment.operationKey);
  assert.equal(receipt.jobId, "job_recovered_by_key");
});

test("generic business validator rejects incomplete data and unsafe page kinds", () => {
  assert.equal(validateBusinessOutput({ acceptance: { minItems: 1 }, output: { items: [] } }).code, "MIN_ITEMS_NOT_MET");
  assert.equal(validateBusinessOutput({ acceptance: { requiredFields: ["id"] }, output: { items: [{}] } }).code, "REQUIRED_FIELD_MISSING");
  assert.equal(validateBusinessOutput({ acceptance: { rejectPageKinds: ["captcha"] }, output: { pageKind: "captcha" } }).code, "REJECTED_PAGE_KIND");
  assert.equal(validateExpectedApp({ packageName: "a" }, { packageName: "a" }).ok, true);
});
