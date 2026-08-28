import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  XhsRoutineRunner,
  createControlPlaneRoutineDriver,
} from "../scripts/lib/xhs-routine-runner.mjs";
import { readBoundUtf8Artifact } from "../ops/_xhs-routine-explorer-runtime.mjs";
import {
  listRoutineTraces,
  readRoutineTrace,
  writeRoutineTrace,
} from "../scripts/lib/xhs-routine-run-store.mjs";

const FEED_FOCUS = {
  package: "com.xingin.xhs",
  activity: "com.xingin.xhs.index.v2.IndexActivityV2",
};
const DETAIL_FOCUS = {
  package: "com.xingin.xhs",
  activity: "com.xingin.xhs.note.NoteDetailActivity",
};
const FEED_XML = '<node class="android.widget.ImageView" content-desc="笔记 攀岩入门三条路线 来自小岩 123赞" text="" clickable="true" bounds="[40,400][500,900]"/>'
  + '<node class="android.widget.ImageView" content-desc="笔记 海边路线 来自小海 80赞" text="" clickable="true" bounds="[560,400][1020,900]"/>';
const DETAIL_XML = '<node class="android.widget.TextView" content-desc="点赞" text="" bounds="[40,2200][140,2300]"/>'
  + '<node class="android.widget.TextView" content-desc="评论 3" text="" bounds="[240,2200][340,2300]"/>'
  + '<node class="android.widget.TextView" text="小岩" bounds="[40,600][120,660]"/>'
  + '<node class="android.widget.TextView" text="路线讲解清楚" bounds="[40,680][900,740]"/>';

function cpFixture() {
  let page = "feed";
  const leases = [{ leaseId: "lease-03", sessionId: "session-03", deviceId: "device-03" }];
  const calls = [];
  let released = 0;
  return {
    calls,
    get released() { return released; },
    async createSession({ placement }) {
      assert.deepEqual(placement, { alias: "03" });
      return {
        sessionId: "session-03",
        leaseId: "lease-03",
        token: "secret-session-token",
        deviceId: "device-03",
      };
    },
    async executeSessionAction(_sessionId, _token, action) {
      calls.push(action.params);
      const primitive = action.params.primitive;
      let output = { ok: true };
      if (primitive === "focus") output = { ok: true, ...(page === "feed" ? FEED_FOCUS : DETAIL_FOCUS) };
      if (primitive === "dump_ui") output = { ok: true, path: `C:\\trusted\\${page}.xml`, bytes: 123 };
      if (primitive === "tap") page = "detail";
      if (primitive === "back" || primitive === "launch_app") page = "feed";
      return { jobId: `job-${calls.length}`, status: "succeeded", result: { output } };
    },
    async heartbeatSession() {
      return { ok: true };
    },
    async releaseSession() {
      released += 1;
      leases.splice(0, leases.length);
      return { released: true };
    },
    listLeases() {
      return [...leases];
    },
    readDumpArtifact({ path }) {
      return String(path).endsWith("detail.xml") ? DETAIL_XML : FEED_XML;
    },
    getDevice() {
      return { alias: "03", metadata: { width: 1080, height: 2400 } };
    },
  };
}

test("routine runner owns one formal CP 03 session, executes refresh, and reports authoritative cleanup", async () => {
  const cp = cpFixture();
  const runner = new XhsRoutineRunner({
    ...cp,
    sleepFn: async () => {},
    now: () => 1_780_000_000_000,
  });
  const run = await runner.start({
    actorId: "agent:rpa-03",
    templateId: "xhs.feed-play.v1",
    params: { items: 1, dwell: "2:2", commentScreens: 0, seed: "cp-readonly" },
  });

  assert.equal(run.alias, "03");
  assert.equal(run.status, "SUCCEEDED");
  assert.equal(run.serverVerified, true);
  assert.equal(run.receipt.cleanup.activeLeases, 0);
  assert.equal(run.receipt.cleanup.restored, true);
  assert.equal(run.receipt.cleanup.authorityRef, "control-plane:StateStore.listLeases");
  assert.equal(cp.released, 1);
  assert.equal("sessionToken" in run, false);
  assert.ok(cp.calls.some((params) => params.primitive === "swipe"), "refresh must issue a session-bound swipe");
  const refresh = cp.calls.find((params) => params.primitive === "swipe");
  assert.deepEqual(
    { x1: refresh.x1, y1: refresh.y1, x2: refresh.x2, y2: refresh.y2 },
    { x1: 540, y1: 672, x2: 540, y2: 1728 },
    "refresh coordinates come from the authoritative 1080x2400 device profile",
  );
  assert.ok(cp.calls.some((params) => params.primitive === "tap"), "bound feed card is opened once");
});

test("aggregate trace preserves per-primitive CP metadata (jobId/status/output.ok/evidenceRef)", async () => {
  const cp = cpFixture();
  const runner = new XhsRoutineRunner({
    ...cp,
    sleepFn: async () => {},
    now: () => 1_780_000_000_000,
  });
  const run = await runner.start({
    actorId: "agent:rpa-03",
    templateId: "xhs.feed-play.v1",
    params: { items: 1, dwell: "2:2", commentScreens: 0, seed: "cp-trace" },
  });
  assert.equal(run.status, "SUCCEEDED");
  const trace = run.primitiveTrace;
  assert.ok(Array.isArray(trace) && trace.length > 0, "aggregate run carries a primitive trace");
  // every issued primitive appears in the trace, in order, with its CP metadata
  assert.equal(trace.length, cp.calls.length, "no primitive is dropped from the trace");
  cp.calls.forEach((params, i) => {
    const entry = trace[i];
    assert.equal(entry.seq, i + 1);
    assert.equal(entry.primitive, params.primitive);
    assert.equal(entry.jobId, `job-${i + 1}`, "CP jobId survives unwrapping");
    assert.equal(entry.status, "succeeded");
    assert.equal(entry.outputOk, true);
    assert.ok("evidenceRef" in entry, "evidenceRef field is present (null when absent)");
  });
  // dump primitives keep their artifact linkage as evidence
  const dumpEntry = trace.find((entry) => entry.primitive === "dump_ui");
  assert.ok(dumpEntry, "dump_ui primitives are recorded");
});

test("routine runner defaults to 03 and rejects social plans before session creation", async () => {
  const cp = cpFixture();
  let creates = 0;
  const runner = new XhsRoutineRunner({
    ...cp,
    createSession: async (...args) => {
      creates += 1;
      return cp.createSession(...args);
    },
    sleepFn: async () => {},
  });

  const plan = runner.plan({ templateId: "xhs.feed-play.v1", params: { items: 1 } });
  assert.equal(plan.alias, "03");
  assert.deepEqual(plan.placement.aliases, ["03"]);

  await assert.rejects(
    runner.start({ templateId: "xhs.nurture-lite.v1", params: { items: 1 } }),
    (error) => error.code === "ROUTINE_SOCIAL_AUTHORITY_UNAVAILABLE",
  );
  await assert.rejects(
    runner.start({
      templateId: "xhs.feed-play.v1",
      params: { items: 1 },
      executionRequest: { mode: "parallel", aliases: ["03"] },
    }),
    (error) => error.code === "ROUTINE_EXECUTION_REQUEST_TAMPERED",
  );
  assert.equal(creates, 0, "unsupported authority paths create zero sessions/leases");
});

test("release is retried inside the owned driver and a transient failure does not leak the lease", async () => {
  const cp = cpFixture();
  let attempts = 0;
  const runner = new XhsRoutineRunner({
    ...cp,
    releaseSession: async (...args) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("transient"), { code: "TRANSIENT_RELEASE" });
      return cp.releaseSession(...args);
    },
    sleepFn: async () => {},
  });
  const run = await runner.start({
    templateId: "xhs.feed-play.v1",
    params: { items: 1, dwell: "2:2", commentScreens: 0 },
  });
  assert.equal(run.status, "SUCCEEDED");
  assert.equal(run.ok, true);
  assert.equal(attempts, 2);
  assert.equal(run.receipt.cleanup.activeLeases, 0);
});

test("persistent release failure stays BLOCKED, reports the owned lease, and keeps alias 03 fenced", async () => {
  const cp = cpFixture();
  let attempts = 0;
  const runner = new XhsRoutineRunner({
    ...cp,
    releaseSession: async () => {
      attempts += 1;
      throw Object.assign(new Error("release down"), { code: "RELEASE_DOWN" });
    },
    sleepFn: async () => {},
  });
  const run = await runner.start({
    templateId: "xhs.feed-play.v1",
    params: { items: 1, dwell: "2:2", commentScreens: 0 },
  });
  assert.equal(run.status, "BLOCKED");
  assert.equal(run.ok, false);
  assert.equal(run.serverVerified, false);
  assert.equal(run.cleanupRecovery.activeOwnedLeases, 1);
  assert.equal(attempts, 3, "two driver attempts plus one runner-finally attempt");
  await assert.rejects(
    runner.start({ templateId: "xhs.feed-play.v1", params: { items: 1 } }),
    (error) => error.code === "ROUTINE_ALIAS_BUSY",
  );
});

test("missing or non-succeeded primitive status is never treated as a verified action", async () => {
  for (const status of [undefined, "queued", "failed"]) {
    const cp = cpFixture();
    const runner = new XhsRoutineRunner({
      ...cp,
      executeSessionAction: async () => ({ status, result: { output: { ok: true } } }),
      sleepFn: async () => {},
    });
    const run = await runner.start({
      templateId: "xhs.feed-play.v1",
      params: { items: 1, dwell: "2:2", commentScreens: 0 },
    });
    assert.equal(run.ok, false, `status ${status ?? "missing"}`);
    assert.equal(run.serverVerified, false);
    assert.notEqual(run.status, "SUCCEEDED");
  }
});

test("card drift at the pre-tap recheck yields zero tap and no successful run", async () => {
  const cp = cpFixture();
  let feedReads = 0;
  const driftedFeed = '<node class="android.widget.ImageView" content-desc="笔记 已换成另一张卡 来自其他人 1赞" text="" clickable="true" bounds="[40,400][500,900]"/>';
  const runner = new XhsRoutineRunner({
    ...cp,
    readDumpArtifact: ({ path }) => {
      if (String(path).endsWith("detail.xml")) return DETAIL_XML;
      feedReads += 1;
      return feedReads >= 5 ? driftedFeed : FEED_XML;
    },
    sleepFn: async () => {},
  });
  const run = await runner.start({
    templateId: "xhs.feed-play.v1",
    params: { items: 1, dwell: "2:2", commentScreens: 0 },
  });
  assert.equal(run.status, "BLOCKED");
  assert.equal(run.ok, false);
  assert.equal(run.error.code, "ROUTINE_NO_VERIFIED_ITEM");
  assert.equal(cp.calls.filter((params) => params.primitive === "tap").length, 0);
});

test("driver refuses to exist without formal session/lease/token/device binding", () => {
  assert.throws(
    () => createControlPlaneRoutineDriver({
      execution: { executionRunId: "xe_" + "1".repeat(32), routineRunId: "rr_" + "2".repeat(32) },
      session: { sessionId: "s", leaseId: "l", token: "", deviceId: "d" },
      executeSessionAction() {},
      releaseSession() {},
      listLeases() { return []; },
      readDumpArtifact() { return "<hierarchy/>"; },
    }),
    /formal session\/lease\/token\/device binding/,
  );
});

test("dump artifact reader accepts only XML realpath inside the exact CP-owned run", (t) => {
  const root = mkdtempSync(join(tmpdir(), "xhs-routine-artifact-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runsRoot = join(root, "runs");
  const runRoot = join(runsRoot, "run-1");
  mkdirSync(runRoot, { recursive: true });
  const inside = join(runRoot, "dump-ui.xml");
  const outside = join(root, "outside.xml");
  writeFileSync(inside, "<hierarchy><node/></hierarchy>", "utf8");
  writeFileSync(outside, "<hierarchy><forged/></hierarchy>", "utf8");
  const storage = { runDirectory: runRoot };
  assert.equal(
    readBoundUtf8Artifact({ runId: "run-1", path: inside, storage }),
    "<hierarchy><node/></hierarchy>",
  );
  assert.throws(
    () => readBoundUtf8Artifact({ runId: "run-1", path: outside, storage }),
    (error) => error.code === "ROUTINE_ARTIFACT_PATH_INVALID",
  );
});

test("durable trace is plan/run-bound, queryable, and rejects secret-bearing fields", (t) => {
  const root = mkdtempSync(join(tmpdir(), "xhs-routine-trace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const planHash = "a".repeat(64);
  const plan = { planHash, template: "xhs.feed-play.v1", alias: "03" };
  const routineRun = {
    executionRunId: `xe_${"1".repeat(32)}`,
    routineRunId: `rr_${"2".repeat(32)}`,
    planHash,
    alias: "03",
    status: "SUCCEEDED",
    serverVerified: true,
    receipt: { cleanup: { verified: true } },
  };
  assert.throws(
    () => writeRoutineTrace({ plan, routineRun: { ...routineRun, sessionToken: "forbidden" }, root }),
    (error) => error.code === "ROUTINE_TRACE_SECRET_FORBIDDEN",
  );
  const written = writeRoutineTrace({ plan, routineRun, root });
  assert.equal(written.trace.executionRunId, routineRun.executionRunId);
  assert.equal(readRoutineTrace(routineRun.executionRunId, { root }).trace.planHash, planHash);
  assert.deepEqual(listRoutineTraces({ root }), [{
    executionRunId: routineRun.executionRunId,
    routineRunId: routineRun.routineRunId,
    planHash,
    template: "xhs.feed-play.v1",
    alias: "03",
    status: "SUCCEEDED",
    serverVerified: true,
    recordedAt: written.trace.recordedAt,
    stopReason: null,
  }]);
});

test("video-surface dump failures retry with patience instead of aborting the run", async () => {
  const cp = cpFixture();
  let page = "feed";
  let detailDumpFailures = 0;
  const runner = new XhsRoutineRunner({
    ...cp,
    executeSessionAction: async (sessionId, token, action) => {
      const params = action.params;
      if (params.primitive === "tap") page = "detail";
      if (params.primitive === "back" || params.primitive === "launch_app") page = "feed";
      if (params.primitive === "dump_ui" && page === "detail") {
        // the first two dumps on the video detail fail exactly like the live
        // DetailFeedActivity idle-starvation; the third succeeds
        detailDumpFailures += 1;
        if (detailDumpFailures <= 2) {
          throw Object.assign(new Error("dump missing hierarchy"), { code: "EXPLORER_DUMP_INVALID" });
        }
      }
      return cp.executeSessionAction(sessionId, token, action);
    },
    sleepFn: async () => {},
  });
  const run = await runner.start({
    actorId: "agent:rpa-03",
    templateId: "xhs.feed-play.v1",
    params: { items: 1, dwell: "2:2", commentScreens: 0, seed: "dump-retry" },
  });
  assert.equal(run.status, "SUCCEEDED", `run should survive transient dump failures, got ${run.error?.code}`);
  assert.equal(detailDumpFailures >= 3, true, "dump retried until observation succeeded");
  const failedDumps = run.primitiveTrace.filter((p) => p.primitive === "dump_ui" && !p.outputOk);
  assert.equal(failedDumps.length >= 2, true, "failed dump attempts stay in the authoritative trace");
});

test("non-dump primitive failures are never retried as observations", async () => {
  const cp = cpFixture();
  let tapAttempts = 0;
  const runner = new XhsRoutineRunner({
    ...cp,
    executeSessionAction: async (sessionId, token, action) => {
      if (action.params.primitive === "tap") {
        tapAttempts += 1;
        throw Object.assign(new Error("tap rejected"), { code: "EXPLORER_TAP_REJECTED" });
      }
      return cp.executeSessionAction(sessionId, token, action);
    },
    sleepFn: async () => {},
  });
  const run = await runner.start({
    actorId: "agent:rpa-03",
    templateId: "xhs.feed-play.v1",
    params: { items: 1, dwell: "2:2", commentScreens: 0, seed: "no-retry" },
  });
  assert.notEqual(run.status, "SUCCEEDED");
  assert.equal(tapAttempts, 1, "transport failure on a non-observation primitive stays fatal");
});

test("catch-path failures keep the original error code (no ReferenceError mask)", async () => {
  const cp = cpFixture();
  const runner = new XhsRoutineRunner({
    ...cp,
    getDevice: async () => {
      throw Object.assign(new Error("device profile unavailable"), { code: "DEVICE_PROFILE_DOWN" });
    },
    sleepFn: async () => {},
  });
  const run = await runner.start({
    actorId: "agent:rpa-03",
    templateId: "xhs.feed-play.v1",
    params: { items: 1, dwell: "2:2", commentScreens: 0, seed: "catch-trace" },
  });
  // the original error must surface verbatim — never a "driver is not
  // defined" ReferenceError raised by the failure path itself
  assert.equal(run.error.code, "DEVICE_PROFILE_DOWN");
  assert.equal(run.status, "FAILED");
});

// --- production social lane (plan V2 §8.1.3) ---------------------------------
// The runner registers the CP-owned authority on its formal session, routes
// machine effects through the typed surface, and closes the authority with
// the outcome reason. The CP here is a fake ONLY at the RPC boundary — the
// surface/identity/cap logic under test is the production code.

import {
  createRoutineEffectsSurface,
  createRoutineAuthorityRuntime,
} from "../scripts/lib/xhs-routine-authority.mjs";

function authorityFixture({ effectOutcome = "verified" } = {}) {
  const authorityCalls = [];
  const runtime = createRoutineAuthorityRuntime({
    async register(fields) {
      authorityCalls.push({ kind: "register", fields });
      return {
        authorityId: "auth-1",
        executionRunId: fields.executionRunId,
        routineRunId: fields.routineRunId,
        planHash: fields.planHash,
        alias: fields.alias,
        effectCaps: fields.effectCaps,
        status: "active",
        canaryPolicy: { granted: true, transport: { like: fields.effectCaps.like, comment: fields.effectCaps.comment } },
      };
    },
    async commitEffect(input) {
      authorityCalls.push({ kind: "commit", ...input });
      if (effectOutcome === "malformed") {
        // production contract (ops/_xhs-routine-explorer-runtime.mjs): the
        // explorer runtime unwraps the HTTP envelope and THROWS on a malformed
        // effect payload — the seam below receives the effect object itself
        throw Object.assign(
          new Error("effect commit response is malformed"),
          { code: "ROUTINE_AUTHORITY_RESPONSE_INVALID", status: 502 },
        );
      }
      return {
        outcome: effectOutcome,
        transported: effectOutcome === "verified" || effectOutcome === "ambiguous",
        effectId: "effect-1",
      };
    },
    async reconcileComments(input) {
      authorityCalls.push({ kind: "reconcile", ...input });
      return [];
    },
    async closeAuthority(input) {
      authorityCalls.push({ kind: "close", ...input });
      return { status: "closed" };
    },
  });
  return { authorityCalls, runtime };
}

test("social run registers the authority on its session, transports one like via the typed surface, and closes with the outcome reason", async () => {
  const cp = cpFixture();
  const { authorityCalls, runtime } = authorityFixture();
  const runner = new XhsRoutineRunner({
    ...cp,
    registerRoutineAuthority: runtime.register,
    commitRoutineAuthorityEffect: runtime.commitEffect,
    reconcileRoutineAuthorityComments: runtime.reconcileComments,
    closeRoutineAuthority: runtime.closeAuthority,
    sleepFn: async () => {},
    now: () => 1_780_000_000_000,
  });
  const run = await runner.start({
    actorId: "agent:rpa-03",
    templateId: "xhs.nurture-lite.v1",
    params: { items: 1, dwell: "2:2", commentScreens: 1, likeMax: 1, seed: "social-live" },
    canaryAuthorized: true,
  });

  assert.equal(run.status, "SUCCEEDED");
  assert.equal(run.authorityId, "auth-1");
  assert.equal(run.authorityClosed, true);

  const register = authorityCalls.find((c) => c.kind === "register");
  assert.ok(register, "authority must be registered");
  assert.equal(register.fields.alias, "03");
  assert.equal(register.fields.sessionId, "session-03");
  assert.equal(register.fields.routineRunId, run.routineRunId);
  assert.equal(register.fields.planHash, run.planHash);
  assert.deepEqual(register.fields.effectCaps, { like: 1, comment: 0 });
  assert.equal(register.fields.canaryAuthorized, true);

  const commit = authorityCalls.find((c) => c.kind === "commit");
  assert.ok(commit, "like must commit through the typed effect RPC");
  assert.equal(commit.authorityId, "auth-1");
  assert.equal(commit.intent.action, "like");
  assert.match(commit.intent.targetFingerprint, /^[0-9a-f]{64}$/);
  assert.ok(commit.intent.observationHash, "like intent binds the fresh detail observation");
  assert.equal(commit.intent.x, undefined, "no coordinate ever leaves the machine seam");

  const close = authorityCalls.find((c) => c.kind === "close");
  assert.equal(close.reason, "run-succeeded");
  assert.equal(close.sessionId, "session-03");

  // run budget: exactly one transported like, no comment budget for lite
  assert.equal(run.receipt.effects.like.transported, 1);
  assert.equal(run.receipt.effects.comment.transported, 0);
  assert.equal(run.transport?.count ?? run.receipt.transport?.count, 1);
});

test("sealed canary request can stay false: registration still records the transport-sealed policy", async () => {
  const cp = cpFixture();
  const { authorityCalls, runtime } = authorityFixture({ effectOutcome: "skipped:sealed" });
  const runner = new XhsRoutineRunner({
    ...cp,
    registerRoutineAuthority: runtime.register,
    commitRoutineAuthorityEffect: runtime.commitEffect,
    reconcileRoutineAuthorityComments: runtime.reconcileComments,
    closeRoutineAuthority: runtime.closeAuthority,
    sleepFn: async () => {},
    now: () => 1_780_000_000_000,
  });
  const run = await runner.start({
    actorId: "agent:rpa-03",
    templateId: "xhs.nurture-lite.v1",
    params: { items: 1, dwell: "2:2", commentScreens: 1, likeMax: 1, seed: "social-sealed" },
  });
  const register = authorityCalls.find((c) => c.kind === "register");
  assert.equal(register.fields.canaryAuthorized, false);
  assert.equal(run.status, "SUCCEEDED");
  assert.equal(run.receipt.effects.like.transported, 0, "sealed transport means zero like transport");
});

test("effects surface fails closed on machine identity mismatch, coordinates, and unwired actions", async () => {
  const { runtime } = authorityFixture();
  const authority = {
    authorityId: "auth-1",
    routineRunId: "rr-1",
    planHash: "plan-1",
    status: "active",
  };
  const surface = createRoutineEffectsSurface({
    authority,
    runtime,
    sessionId: "session-03",
    token: "secret-session-token",
  });

  await assert.rejects(
    surface.commitRoutineEffect({
      plan: { planHash: "tampered" },
      run: { routineRunId: "rr-1" },
      intent: { action: "like", targetFingerprint: "t", observationHash: "o" },
    }),
    (error) => error.code === "ROUTINE_EFFECT_IDENTITY_MISMATCH",
  );
  await assert.rejects(
    surface.commitRoutineEffect({
      plan: { planHash: "plan-1" },
      run: { routineRunId: "rr-evil" },
      intent: { action: "like", targetFingerprint: "t", observationHash: "o" },
    }),
    (error) => error.code === "ROUTINE_EFFECT_IDENTITY_MISMATCH",
  );
  assert.deepEqual(
    await surface.commitRoutineEffect({
      plan: { planHash: "plan-1" },
      run: { routineRunId: "rr-1" },
      intent: { action: "like", targetFingerprint: "t", observationHash: "o", x: 1000, y: 1830 },
    }),
    { outcome: "rejected:coordinate_surface", transported: false },
  );
  assert.deepEqual(
    await surface.commitRoutineEffect({
      plan: { planHash: "plan-1" },
      run: { routineRunId: "rr-1" },
      intent: { action: "publish", targetFingerprint: "t", observationHash: "o" },
    }),
    { outcome: "rejected:action_not_wired", transported: false },
  );
});

test("malformed CP effect responses fail closed as a thrown typed error, never as a transport", async () => {
  const { runtime } = authorityFixture({ effectOutcome: "malformed" });
  const authority = { authorityId: "auth-1", routineRunId: "rr-1", planHash: "plan-1" };
  const surface = createRoutineEffectsSurface({ authority, runtime, sessionId: "s", token: "t" });
  await assert.rejects(
    surface.commitRoutineEffect({
      plan: { planHash: "plan-1" },
      run: { routineRunId: "rr-1" },
      intent: { action: "like", targetFingerprint: "t", observationHash: "o" },
    }),
    (error) => error.code === "ROUTINE_AUTHORITY_RESPONSE_INVALID",
  );
});

// Regression (live S2 wave 2, 2026-08-28): the seam re-extracted `.effect`
// from the already-unwrapped effect object, so a real transported like
// (CP ledger: status "ambiguous", reservation_consumed=1) surfaced to the
// machine as "bridge_error" with the transported flag lost.
test("transported effects pass through to the machine verbatim, flags intact", async () => {
  const { runtime } = authorityFixture({ effectOutcome: "ambiguous" });
  const authority = { authorityId: "auth-1", routineRunId: "rr-1", planHash: "plan-1" };
  const surface = createRoutineEffectsSurface({ authority, runtime, sessionId: "s", token: "t" });
  const res = await surface.commitRoutineEffect({
    plan: { planHash: "plan-1" },
    run: { routineRunId: "rr-1" },
    intent: { action: "like", targetFingerprint: "t", observationHash: "o" },
  });
  assert.deepEqual(res, { outcome: "ambiguous", transported: true, effectId: "effect-1" });
});

test("vision mode is a sealed enum: unknown values are tamper, never a degradation", async () => {
  const cp = cpFixture();
  const runner = new XhsRoutineRunner({ ...cp, sleepFn: async () => {}, now: () => 1_780_000_000_000 });
  await assert.rejects(
    () => runner.start({
      templateId: "xhs.feed-play.v1",
      params: { items: 1, dwell: "2:2", commentScreens: 0, seed: "vision-enum" },
      visionMode: "auto",
    }),
    (error) => error.code === "ROUTINE_VISION_MODE_INVALID",
  );
  assert.equal(cp.calls.length, 0, "an invalid vision mode creates no session and issues no primitive");
});

test("non-fallback vision requires the production navigator factory and screen-artifact reader", async () => {
  const cp = cpFixture();
  const runner = new XhsRoutineRunner({ ...cp, sleepFn: async () => {}, now: () => 1_780_000_000_000 });
  await assert.rejects(
    () => runner.start({
      templateId: "xhs.feed-play.v1",
      params: { items: 1, dwell: "2:2", commentScreens: 0, seed: "vision-transport" },
      visionMode: "shadow",
    }),
    (error) => error.code === "ROUTINE_VISION_TRANSPORT_UNAVAILABLE",
  );
  assert.equal(cp.calls.length, 0);
});

test("canary vision builds the run-scoped navigator from the owning driver and records the mode", async () => {
  const cp = cpFixture();
  const factoryCalls = [];
  const navigator = {
    mode: "canary",
    authorizeR0Navigation: async () => ({ ok: false, reason: "VISION_SHADOW_NO_TAP" }),
    observePage: async () => ({ ok: false, reason: "VISION_DETAIL_UNSAFE_OR_UNKNOWN" }),
  };
  const runner = new XhsRoutineRunner({
    ...cp,
    readScreenArtifact: ({ path }) => Buffer.from(path),
    createVisionNavigator: ({ mode, execution, driver }) => {
      factoryCalls.push({
        mode,
        executionRunId: execution?.executionRunId,
        hasScreenshot: typeof driver?.screenshot === "function",
        hasVisualTapCount: typeof driver?.getVisualTapCount === "function",
      });
      return navigator;
    },
    sleepFn: async () => {},
    now: () => 1_780_000_000_000,
  });
  const run = await runner.start({
    templateId: "xhs.feed-play.v1",
    params: { items: 1, dwell: "2:2", commentScreens: 0, seed: "vision-canary" },
    visionMode: "canary",
  });
  assert.equal(run.status, "SUCCEEDED");
  assert.equal(run.visionMode, "canary");
  assert.equal(run.visualTaps, 0, "a dump-clean run issues no visual tap");
  assert.equal(factoryCalls.length, 1);
  assert.equal(factoryCalls[0].mode, "canary");
  assert.equal(factoryCalls[0].executionRunId, run.executionRunId);
  assert.equal(factoryCalls[0].hasScreenshot, true);
  assert.equal(factoryCalls[0].hasVisualTapCount, true);
});

test("fallback vision (default) never builds a navigator", async () => {
  const cp = cpFixture();
  let factoryCalls = 0;
  const runner = new XhsRoutineRunner({
    ...cp,
    readScreenArtifact: () => Buffer.alloc(1),
    createVisionNavigator: () => {
      factoryCalls += 1;
      return null;
    },
    sleepFn: async () => {},
    now: () => 1_780_000_000_000,
  });
  const run = await runner.start({
    templateId: "xhs.feed-play.v1",
    params: { items: 1, dwell: "2:2", commentScreens: 0, seed: "vision-fallback" },
  });
  assert.equal(run.status, "SUCCEEDED");
  assert.equal(run.visionMode, "fallback");
  assert.equal(factoryCalls, 0);
});

function cpBatchFixture() {
  const pages = { "03": "feed", "04": "feed" };
  const leases = [
    { leaseId: "lease-03", sessionId: "session-03", deviceId: "device-03" },
    { leaseId: "lease-04", sessionId: "session-04", deviceId: "device-04" },
  ];
  let released = 0;
  return {
    get released() { return released; },
    async createSession({ placement }) {
      const alias = placement?.alias;
      assert.ok(alias === "03" || alias === "04");
      return { sessionId: `session-${alias}`, leaseId: `lease-${alias}`, token: "t", deviceId: `device-${alias}` };
    },
    async executeSessionAction(sessionId, _token, action) {
      const state = pages[sessionId === "session-04" ? "04" : "03"];
      const primitive = action.params.primitive;
      let output = { ok: true };
      if (primitive === "focus") output = { ok: true, ...(state === "feed" ? FEED_FOCUS : DETAIL_FOCUS) };
      if (primitive === "dump_ui") output = { ok: true, path: `C:\\trusted\\${state}.xml`, bytes: 1 };
      if (primitive === "tap") pages[sessionId === "session-04" ? "04" : "03"] = "detail";
      if (primitive === "back" || primitive === "launch_app") pages[sessionId === "session-04" ? "04" : "03"] = "feed";
      return { jobId: "job", status: "succeeded", result: { output } };
    },
    async heartbeatSession() { return { ok: true }; },
    async releaseSession(sessionId) {
      released += 1;
      const index = leases.findIndex((lease) => lease.sessionId === sessionId);
      if (index >= 0) leases.splice(index, 1);
      return { released: true };
    },
    listLeases() { return [...leases]; },
    readDumpArtifact: ({ path }) => (String(path).includes("detail") ? DETAIL_XML : FEED_XML),
    async getDevice() { return { metadata: { width: 1080, height: 2400 } }; },
  };
}

test("parallel batch is read-only: a social plan never reaches the coordinator", async () => {
  const cp = cpBatchFixture();
  const runner = new XhsRoutineRunner({ ...cp, sleepFn: async () => {}, now: () => 1_780_000_000_000 });
  await assert.rejects(
    () => runner.start({
      templateId: "xhs.nurture-lite.v1",
      params: { items: 1, dwell: "2:2", commentScreens: 0, seed: "batch-social" },
      parallel: 2,
      canaryAuthorized: true,
    }),
    (error) => error.code === "ROUTINE_SECONDARY_EFFECT_CLASS_FORBIDDEN",
  );
  assert.equal(cp.released, 0, "no session was ever acquired");
});

test("parallel batch acquires 03 then 04, runs both lanes, and aggregates all-settled", async () => {
  const cp = cpBatchFixture();
  const runner = new XhsRoutineRunner({ ...cp, sleepFn: async () => {}, now: () => 1_780_000_000_000 });
  const run = await runner.start({
    templateId: "xhs.feed-play.v1",
    params: { items: 1, dwell: "2:2", commentScreens: 0, seed: "batch-happy" },
    parallel: 2,
  });
  assert.equal(run.status, "SUCCEEDED", JSON.stringify(run, null, 1));
  assert.equal(run.ok, true);
  assert.equal(run.serverVerified, true);
  assert.deepEqual(run.aliases, ["03", "04"]);
  assert.equal(run.children.length, 2);
  const [child03, child04] = run.children;
  assert.equal(child03.executionRunId, run.executionRunId, "children share the batch executionRunId");
  assert.equal(child04.executionRunId, run.executionRunId);
  assert.notEqual(child03.routineRunId, child04.routineRunId);
  assert.equal(child03.effectClass, "none");
  assert.equal(child04.effectClass, "none");
  assert.equal(child04.status, "SUCCEEDED");
  assert.equal(child03.cleanupRecovery.activeOwnedLeases, 0);
  assert.equal(child04.cleanupRecovery.activeOwnedLeases, 0);
  assert.equal(cp.released, 2, "both leases released");
  assert.equal(runner.activeAliases.size, 0, "no alias stays busy after closeout");
});

test("a failing lane BLOCKs the aggregate even when the other lane succeeds cleanly", async () => {
  const cp = cpBatchFixture();
  // starve 04's dumps: they succeed but yield an empty xml, so the machine
  // cannot recognize the feed and the child terminal-blocks (cleanup stays fine)
  const originalAction = cp.executeSessionAction;
  const originalRead = cp.readDumpArtifact;
  cp.executeSessionAction = async (sessionId, token, action) => {
    if (sessionId === "session-04" && action.params.primitive === "dump_ui") {
      return { jobId: "job-04", status: "succeeded", result: { output: { ok: true, path: "C:\\trusted\\starved.xml", bytes: 1 } } };
    }
    return originalAction(sessionId, token, action);
  };
  cp.readDumpArtifact = ({ path }) => (String(path).includes("starved") ? "" : originalRead({ path }));
  const runner = new XhsRoutineRunner({ ...cp, sleepFn: async () => {}, now: () => 1_780_000_000_000 });
  const run = await runner.start({
    templateId: "xhs.feed-play.v1",
    params: { items: 1, dwell: "2:2", commentScreens: 0, seed: "batch-partial" },
    parallel: 2,
  });
  assert.equal(run.status, "BLOCKED");
  assert.equal(run.ok, false);
  assert.equal(run.children.length, 2);
  const child04 = run.children.find((child) => child.alias === "04");
  const child03 = run.children.find((child) => child.alias === "03");
  assert.notEqual(child03.status, "FAILED", "the healthy lane still finishes cleanly");
  assert.notEqual(child04.status, "SUCCEEDED");
  assert.equal(child04.cleanupRecovery.activeOwnedLeases, 0, "the failing lane still cleans up");
  assert.equal(run.receipt.cleanup.verified, false);
});

test("parallel alias-busy fails closed before any session", async () => {
  const cp = cpBatchFixture();
  const runner = new XhsRoutineRunner({ ...cp, sleepFn: async () => {}, now: () => 1_780_000_000_000 });
  runner.activeAliases.set("03", "xe-elsewhere");
  await assert.rejects(
    () => runner.start({
      templateId: "xhs.feed-play.v1",
      params: { items: 1, dwell: "2:2", commentScreens: 0, seed: "batch-busy" },
      parallel: 2,
    }),
    (error) => error.code === "ROUTINE_ALIAS_BUSY" && error.status === 423,
  );
  assert.equal(cp.released, 0);
});
