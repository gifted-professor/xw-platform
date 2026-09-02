import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  COLLECT_LOOP_PLAN_TEMPLATE,
  COLLECT_RISK_PATTERNS,
  classifyRecipeRun,
  createCollectLoop,
  createHttpCollectCp,
} from "../scripts/lib/xhs-collect-loop.mjs";
import { listRoutineTraces, writeRoutineTrace } from "../scripts/lib/xhs-routine-run-store.mjs";

const ALIASES = ["04", "05", "06", "07"];

function okRun({ alias, verifiedSteps = 8 } = {}) {
  return {
    schemaId: "xw.single-device.recipe-run.v1",
    recipeRunId: `rr_${alias}_ok`,
    recipeId: "xhs.note.read.fixed",
    revision: 1,
    status: "SUCCEEDED",
    alias,
    steps: [],
    receipt: {
      schemaId: "xw.single-device.recipe-receipt.v1",
      ok: true,
      serverVerified: true,
      verifiedSteps,
      stepCount: verifiedSteps,
      stepResults: [],
    },
  };
}

function failedRun({ alias, status = "FAILED", error = { code: "STEP_ASSERTION_FAILED" }, receipt = {} } = {}) {
  return {
    schemaId: "xw.single-device.recipe-run.v1",
    recipeRunId: `rr_${alias}_fail`,
    recipeId: "xhs.note.read.fixed",
    revision: 1,
    status,
    alias,
    steps: [],
    error,
    receipt: {
      schemaId: "xw.single-device.recipe-receipt.v1",
      ok: false,
      serverVerified: true,
      verifiedSteps: 0,
      stepResults: [],
      ...receipt,
    },
  };
}

function fakeCp(alias, { script = [], leasesAfterBatch = [], now = () => null } = {}) {
  // script: queued runRecipe responses (value or thrown error); when exhausted, okRun.
  const queue = [...script];
  const calls = [];
  return {
    alias,
    calls,
    async runRecipe(request) {
      calls.push({ alias, request, at: now() });
      const next = queue.shift();
      if (next === undefined) return okRun({ alias });
      if (next instanceof Error) throw next;
      return next;
    },
    async listLeases() {
      calls.push({ alias, leaseProbe: true });
      return [...leasesAfterBatch];
    },
  };
}

function loopFixtures({ batches, perCp = {}, interBatchMs = 100, maxRetries = 1, traceRoot = null, now } = {}) {
  const clock = now || (() => 1_780_000_000_000);
  const devices = ALIASES.map((alias) => {
    const spec = perCp[alias] || {};
    const cp = fakeCp(alias, { ...spec, now: spec.now || clock });
    return { alias, cp };
  });
  const sleeps = [];
  const loop = createCollectLoop({
    devices,
    recipeId: "xhs.note.read.fixed",
    revision: 1,
    batches,
    interBatchMs,
    maxRetries,
    sleepFn: async (ms) => sleeps.push(ms),
    now: clock,
    traceRoot,
  });
  return { loop, devices, sleeps };
}

function batchConcurrencyNow() {
  // Clock advances only between batches, so all in-batch fan-out reads share
  // one timestamp — a serial executor would produce distinct ones.
  let tick = 1_780_000_000_000;
  return () => tick;
}

test("collect loop fans out one batch to 4 fake CPs concurrently and sleeps between batches", async () => {
  const { loop, devices, sleeps } = loopFixtures({
    batches: 3,
    interBatchMs: 5000,
    now: batchConcurrencyNow(),
  });
  const summary = await loop.run();

  assert.equal(summary.batchesExecuted, 3);
  assert.equal(summary.notesSucceeded, 12);
  assert.equal(summary.stoppedBy, null);
  assert.deepEqual(summary.failureCounts, {
    transientRetried: 0, transientFailed: 0, repairIsolated: 0, leaseFenced: 0,
  });
  // concurrency: the 4 devices of batch 1 share one clock reading
  const calls = devices.flatMap((device) => device.cp.calls);
  const batchOne = calls.filter((call) => call.request?.batchIndex === 1);
  assert.equal(batchOne.length, 4);
  assert.equal(new Set(batchOne.map((call) => call.at)).size, 1, "all four devices start in the same tick");
  // pacing: N-1 sleeps of interBatchMs, one per gap
  assert.deepEqual(sleeps, [5000, 5000]);
  assert.equal(calls.filter((call) => call.leaseProbe).length, 12, "listLeases probed once per device per batch");
});

test("transient failure is retried within the batch up to maxRetries and counted", async () => {
  const { loop, devices } = loopFixtures({
    batches: 1,
    perCp: {
      "05": { script: [failedRun({ alias: "05" }), okRun({ alias: "05" })] },
    },
  });
  const summary = await loop.run();

  assert.equal(summary.notesSucceeded, 4);
  assert.equal(summary.failureCounts.transientRetried, 1);
  assert.equal(summary.failureCounts.transientFailed, 0);
  const aliasCp = devices.find((device) => device.alias === "05").cp;
  assert.equal(aliasCp.calls.filter((call) => !call.leaseProbe).length, 2, "exactly one retry for alias 05");
  assert.equal(summary.devices["05"].attempts, 2);
});

test("REPAIR_REQUIRED is never retried and isolates the device for later batches", async () => {
  const { loop, devices } = loopFixtures({
    batches: 3,
    perCp: {
      "06": { script: [failedRun({ alias: "06", status: "REPAIR_REQUIRED" })] },
    },
  });
  const summary = await loop.run();

  assert.equal(summary.failureCounts.repairIsolated, 1);
  assert.equal(summary.devices["06"].isolated, 1);
  assert.equal(summary.stoppedBy, null, "other devices keep collecting");
  assert.equal(summary.notesSucceeded, 9, "3 batches × (04,05,07); 06 only its failed first attempt");
  const aliasCp = devices.find((device) => device.alias === "06").cp;
  const runCalls = aliasCp.calls.filter((call) => !call.leaseProbe);
  assert.equal(runCalls.length, 1, "no retry and no further batches for the isolated device");
  assert.equal(runCalls[0].request.batchIndex, 1);
});

test("a dirty lease after a batch fences the alias from subsequent batches", async () => {
  const { loop, devices } = loopFixtures({
    batches: 2,
    perCp: {
      "07": { leasesAfterBatch: [{ leaseId: "lease-07", sessionId: "session-07" }] },
    },
  });
  const summary = await loop.run();

  assert.equal(summary.failureCounts.leaseFenced, 1);
  assert.equal(summary.devices["07"].fenced, 1);
  const aliasCp = devices.find((device) => device.alias === "07").cp;
  const runCalls = aliasCp.calls.filter((call) => !call.leaseProbe);
  assert.equal(runCalls.length, 1, "fenced alias runs exactly one batch then is skipped");
  assert.equal(summary.notesSucceeded, 7, "4 in batch 1 + 3 in batch 2 (07 fenced)");
});

test("risk-control signal in a receipt stops the whole fleet after the current batch", async () => {
  const { loop } = loopFixtures({
    batches: 5,
    perCp: {
      "06": {
        script: [okRun({ alias: "06" }), failedRun({
          alias: "06",
          status: "FAILED",
          receipt: { stepResults: [{ id: "dump_detail", observation: { text: "操作太频繁，请稍后再试" } }] },
        })],
      },
    },
  });
  const summary = await loop.run();

  assert.equal(summary.stoppedBy, "risk-control");
  assert.equal(summary.batchesExecuted, 2, "current batch finishes, then the loop halts");
  assert.equal(summary.riskSignal.alias, "06");
  assert.equal(summary.riskSignal.signal, "操作太频繁");
  assert.equal(summary.notesSucceeded, 4 + 3, "batch 1 full + batch 2 without 06");
  assert.equal(summary.failureCounts.transientRetried, 0, "risk signal is not retried");
});

test("batch and summary traces persist to the trace root and list back", async () => {
  const traceRoot = mkdtempSync(join(tmpdir(), "xhs-collect-loop-trace-"));
  try {
    const { loop } = loopFixtures({ batches: 2, traceRoot });
    const summary = await loop.run();

    assert.equal(summary.persistenceErrors.length, 0);
    assert.equal(summary.batchExecutionRunIds.length, 2);
    const traces = listRoutineTraces({ root: traceRoot, limit: 10 });
    assert.equal(traces.length, 3, "2 batch traces + 1 summary trace");
    assert.ok(traces.every((trace) => trace.planHash && trace.executionRunId.startsWith("xe_")));
    const statuses = traces.map((trace) => trace.status).sort();
    assert.deepEqual(statuses, ["COMPLETED", "SUCCEEDED", "SUCCEEDED"].sort());
  } finally {
    rmSync(traceRoot, { recursive: true, force: true });
  }
});

test("trace store still refuses secret-bearing collect records", () => {
  const traceRoot = mkdtempSync(join(tmpdir(), "xhs-collect-loop-secret-"));
  try {
    const plan = { planHash: "a".repeat(64), template: COLLECT_LOOP_PLAN_TEMPLATE };
    assert.throws(
      () => writeRoutineTrace({
        plan,
        routineRun: {
          executionRunId: `xe_${"b".repeat(32)}`,
          routineRunId: "cl_poison",
          planHash: plan.planHash,
          alias: "04",
          status: "FAILED",
          receipt: { sessionToken: "should-not-persist" },
        },
        root: traceRoot,
      }),
      (error) => error.code === "ROUTINE_TRACE_SECRET_FORBIDDEN",
    );
  } finally {
    rmSync(traceRoot, { recursive: true, force: true });
  }
});

test("classifyRecipeRun separates ok / repair / transient / risk-control", () => {
  assert.equal(classifyRecipeRun(okRun({})).outcome, "ok");
  assert.equal(classifyRecipeRun(failedRun({ status: "REPAIR_REQUIRED" })).outcome, "repair");
  assert.equal(classifyRecipeRun(failedRun({})).outcome, "transient");
  assert.equal(classifyRecipeRun(null).outcome, "transient");
  const risk = classifyRecipeRun(failedRun({
    receipt: { stepResults: [{ observation: { text: "请输入验证码" } }] },
  }));
  assert.equal(risk.outcome, "risk-control");
  assert.equal(risk.signal, "验证码");
  assert.ok(COLLECT_RISK_PATTERNS.includes("滑块"));
});

test("HTTP adapter drives the per-alias recipe-runs surface over fetch and rejects non-loopback", async () => {
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    if (init.method === "POST" && parsed.pathname === "/control/v1/recipe-runs") {
      posts.push({ origin: parsed.origin, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        recipeRun: okRun({ alias: "04" }),
      }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (init.method === "GET" && parsed.pathname === "/control/v1/leases") {
      return new Response(JSON.stringify({ leases: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: { code: "UNEXPECTED_ROUTE" } }), { status: 500 });
  };
  const cps = ["19121", "19122", "19123", "19124"].map((port) => createHttpCollectCp({
    controlBase: `http://127.0.0.1:${port}`,
    fetchImpl,
  }));
  assert.equal(cps.length, 4);
  const run = await cps[2].runRecipe({ recipeId: "xhs.note.read.fixed", revision: 1, params: {}, actorId: "agent:test" });
  assert.equal(run.status, "SUCCEEDED");
  assert.equal((await cps[0].listLeases()).length, 0);
  assert.deepEqual(
    posts.map((post) => post.origin),
    ["http://127.0.0.1:19123"],
    "each adapter posts only to its own per-alias CP origin",
  );
  assert.equal(posts[0].body.recipeId, "xhs.note.read.fixed");
  assert.equal(posts[0].body.dryRun, false);

  assert.throws(
    () => createHttpCollectCp({ controlBase: "http://10.0.0.5:17921", fetchImpl }),
    (error) => error.code === "COLLECT_ENDPOINT_INVALID",
  );
});

test("HTTP adapter failure of one CP is transient and retried, not a crash", async () => {
  let attempts = 0;
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    if (init.method === "POST" && parsed.pathname === "/control/v1/recipe-runs") {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ error: { code: "RECIPE_RUN_ACTIVE", message: "busy" } }), { status: 423 });
      }
      return new Response(JSON.stringify({ recipeRun: okRun({ alias: "04" }) }), { status: 201 });
    }
    if (init.method === "GET" && parsed.pathname === "/control/v1/leases") {
      return new Response(JSON.stringify({ leases: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { code: "UNEXPECTED_ROUTE" } }), { status: 500 });
  };
  const traceRoot = mkdtempSync(join(tmpdir(), "xhs-collect-loop-http-"));
  try {
    const loop = createCollectLoop({
      devices: [{ alias: "04", cp: createHttpCollectCp({ controlBase: "http://127.0.0.1:19121", fetchImpl }) }],
      batches: 1,
      maxRetries: 1,
      sleepFn: async () => {},
      traceRoot,
    });
    const summary = await loop.run();
    assert.equal(summary.notesSucceeded, 1);
    assert.equal(summary.failureCounts.transientRetried, 1);
    assert.equal(attempts, 2);
  } finally {
    rmSync(traceRoot, { recursive: true, force: true });
  }
});