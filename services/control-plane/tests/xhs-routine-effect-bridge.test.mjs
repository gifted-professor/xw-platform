// xhs-routine-effect-bridge.test.mjs — S2 commitRoutineEffect bridge + hard
// routine budget (direct-routine plan V2 §6.3/§6.4/§7/§10.6/§10.7), offline:
//
//   ownership  — cross-session/lease/plan contexts are rejected before
//                transport; nested jobs, raw adapter/coordinate taps and
//                unwired actions never reach the ledger.
//   like state — fresh `liked` skips (no reservation), `unliked` transports
//                exactly once, `missing/unknown` re-observes once and then
//                STOP_EFFECT with zero transport; stale observations fail
//                closed. Never a blind toggle.
//   hard budget — like max=1/perTarget=1 and comment max=2/perTarget=1 are
//                enforced in the same SQLite transaction as the slot
//                reservation; concurrent + replayed reservations cannot break
//                the cap; there is NO soft path (nonpayment policyMode is not
//                consulted anywhere); ambiguous consumes its slot and poisons
//                the (run, action, target) triple against retry.
//   machine    — bridgeAsMachineEffects drives the S1 state machine: verified
//                like increments the run receipt, cap_reached/ambiguous close
//                the action, transport accounting matches the ledger.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { StateStore } from "../control-plane/lib/state-store.mjs";
import { ControlPlaneError } from "../control-plane/lib/errors.mjs";
import { createRoutineEffectBridge, bridgeAsMachineEffects, ROUTINE_EFFECT_BUDGET } from "../apps/xhs/routine-effect-bridge.mjs";
import { planRoutine, bindRoutineExecution } from "../../orchestrator/scripts/lib/xhs-routine-plan.mjs";
import { createRoutineRun } from "../../orchestrator/scripts/lib/xhs-feed-routine-machine.mjs";

const NOW = 1_700_000_000_000;
const CLOCK = { nowMs: () => NOW, sleep: async () => {} };
const OWNER = Object.freeze({
  sessionId: "sess-routine-1",
  leaseRef: "lease-04-r1",
  leaseAuthorization: "lat_04_r1",
  routineRunId: "rr_test000000000001",
  planHash: "a".repeat(64),
});
const TARGET = "fp_target_1";
const FRESH = { hash: "dh1", targetFingerprint: TARGET, likeLabel: "点赞", observedAt: NOW };

function ctx(over = {}) {
  return {
    sessionId: OWNER.sessionId,
    leaseRef: OWNER.leaseRef,
    leaseAuthorization: OWNER.leaseAuthorization,
    routineRunId: OWNER.routineRunId,
    planHash: OWNER.planHash,
    targetFingerprint: TARGET,
    observationHash: FRESH.hash,
    ...over,
  };
}

/**
 * Typed capability fake. observe() yields from a scripted label queue. The
 * bridge passes the claimed targetFingerprint into observe — by default the
 * fake echoes it (the CP dump binds to the same session position); pass
 * echoTarget:false to keep the observation pinned to FRESH.targetFingerprint
 * so the self-report fence can be exercised.
 */
function transport({ labels = ["点赞"], postLabel = "已点赞", commitOk = true, echoTarget = true } = {}) {
  const calls = { observe: [], commitLike: [] };
  let n = 0;
  return {
    calls,
    target: TARGET, // mutable: tests that vary targets set t.target before each call
    async observe(opts = {}) {
      calls.observe.push(opts.reason || "");
      const label = n < labels.length ? labels[n] : opts.reason === "post_like" ? postLabel : labels[labels.length - 1];
      n += 1;
      return {
        ...FRESH,
        likeLabel: label,
        observedAt: CLOCK.nowMs(),
        targetFingerprint: echoTarget ? (opts.targetFingerprint ?? this.target) : FRESH.targetFingerprint,
      };
    },
    async commitLike(args) {
      calls.commitLike.push(args);
      return { ok: commitOk };
    },
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "xhs-routine-bridge-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  return { root, state, cleanup: () => { state.close(); rmSync(root, { recursive: true, force: true }); } };
}

function expectCode(fn, code_) {
  try {
    fn();
  } catch (e) {
    if (e instanceof ControlPlaneError && e.code === code_) return e;
    assert.fail(`expected ${code_}, got ${e?.code ?? e?.message ?? String(e)}`);
  }
  assert.fail(`expected ${code_} to be thrown`);
}

// --- ownership / bypass fences (§6.4) ---------------------------------------

test("bridge requires a complete owner tuple and typed transport at construction", () => {
  const f = setup();
  try {
    assert.throws(() => createRoutineEffectBridge({ state: f.state, owner: { ...OWNER, leaseAuthorization: null }, transport: transport() }), TypeError);
    assert.throws(() => createRoutineEffectBridge({ state: f.state, owner: OWNER, transport: { commitLike: async () => ({ ok: true }) } }), TypeError);
  } finally { f.cleanup(); }
});

test("cross-session / cross-lease / cross-run contexts are rejected before any transport", async () => {
  const f = setup();
  try {
    const t = transport();
    const bridge = createRoutineEffectBridge({ state: f.state, owner: OWNER, transport: t, clock: CLOCK });
    for (const over of [
      { sessionId: "sess-other" },
      { leaseRef: "lease-other" },
      { leaseAuthorization: "lat-other" },
      { routineRunId: "rr_other" },
      { planHash: "b".repeat(64) },
      { observationHash: null },
    ]) {
      await assert.rejects(() => bridge.commitRoutineEffect(ctx(over), { action: "like" }), (e) => e instanceof ControlPlaneError);
      assert.equal(t.calls.commitLike.length, 0, "no transport for a foreign context");
    }
  } finally { f.cleanup(); }
});

test("nested-job and raw tap surfaces are rejected before the ledger", async () => {
  const f = setup();
  try {
    const t = transport();
    const bridge = createRoutineEffectBridge({ state: f.state, owner: OWNER, transport: t, clock: CLOCK });
    await assert.rejects(
      () => bridge.commitRoutineEffect(ctx(), { action: "like", jobId: "job-1" }),
      (e) => e.code === "NESTED_JOB_REJECTED",
    );
    await assert.rejects(
      () => bridge.commitRoutineEffect({ ...ctx(), asJob: true }, { action: "like" }),
      (e) => e.code === "NESTED_JOB_REJECTED",
    );
    await assert.rejects(
      () => bridge.commitRoutineEffect(ctx(), { action: "like", control: { x: 100, y: 200 } }),
      (e) => e.code === "EFFECT_TAP_SURFACE_REJECTED",
    );
    await assert.rejects(
      () => bridge.commitRoutineEffect(ctx(), { action: "like", x: 100, y: 200 }),
      (e) => e.code === "EFFECT_TAP_SURFACE_REJECTED",
    );
    // comment is S3 — unwired actions cannot smuggle through
    await assert.rejects(
      () => bridge.commitRoutineEffect(ctx(), { action: "comment" }),
      (e) => e.code === "ROUTINE_ACTION_NOT_WIRED",
    );
    assert.equal(t.calls.commitLike.length, 0);
    assert.equal(f.state.listRoutineEffects(OWNER.routineRunId).length, 0, "nothing reserved by rejected intents");
  } finally { f.cleanup(); }
});

test("caller-self-reported fingerprint not bound by the observation -> TARGET_BINDING_MISMATCH", async () => {
  const f = setup();
  try {
    const t = transport({ echoTarget: false });
    const bridge = createRoutineEffectBridge({ state: f.state, owner: OWNER, transport: t, clock: CLOCK });
    await assert.rejects(
      () => bridge.commitRoutineEffect(ctx({ targetFingerprint: "fp_self_reported" }), { action: "like" }),
      (e) => e.code === "TARGET_BINDING_MISMATCH",
    );
    assert.equal(t.calls.commitLike.length, 0);
  } finally { f.cleanup(); }
});

// --- like pre-state ladder (§7.7) --------------------------------------------

test("liked -> already-true skip: zero transport, no reservation", async () => {
  const f = setup();
  try {
    const t = transport({ labels: ["已点赞"] });
    const bridge = createRoutineEffectBridge({ state: f.state, owner: OWNER, transport: t, clock: CLOCK });
    const res = await bridge.commitRoutineEffect(ctx(), { action: "like" });
    assert.equal(res.outcome, "skipped:already_liked");
    assert.equal(res.transported, false);
    assert.equal(t.calls.commitLike.length, 0);
    assert.equal(f.state.listRoutineEffects(OWNER.routineRunId).length, 0);
  } finally { f.cleanup(); }
});

test("unliked -> exactly one transport, verified on liked post-state", async () => {
  const f = setup();
  try {
    const t = transport({ labels: ["点赞"], postLabel: "已点赞" });
    const bridge = createRoutineEffectBridge({ state: f.state, owner: OWNER, transport: t, clock: CLOCK });
    const res = await bridge.commitRoutineEffect(ctx(), { action: "like" });
    assert.equal(res.outcome, "verified");
    assert.equal(res.transported, true);
    assert.equal(t.calls.commitLike.length, 1);
    const effects = f.state.listRoutineEffects(OWNER.routineRunId);
    assert.equal(effects.length, 1);
    assert.equal(effects[0].status, "verified");
    assert.equal(effects[0].reservationConsumed, true);
    // stable operation key: sha256(routineRunId + action + target + payloadHash), no timestamps
    assert.match(effects[0].idempotencyKey, /^[a-f0-9]{64}$/);
  } finally { f.cleanup(); }
});

test("missing/unknown label re-observes once; still unprovable -> STOP_EFFECT, zero transport, no slot", async () => {
  const f = setup();
  try {
    for (const label of ["", "随便什么控件"]) {
      const t = transport({ labels: [label, label], postLabel: label });
      const bridge = createRoutineEffectBridge({ state: f.state, owner: OWNER, transport: t, clock: CLOCK });
      const res = await bridge.commitRoutineEffect(ctx(), { action: "like" });
      assert.equal(res.outcome, "stopped:effect_state_unprovable", `label=${JSON.stringify(label)}`);
      assert.equal(res.transported, false);
      assert.equal(t.calls.commitLike.length, 0);
      assert.equal(t.calls.observe.length, 2, "exactly one re-observe");
      assert.equal(f.state.listRoutineEffects(OWNER.routineRunId).length, 0);
    }
  } finally { f.cleanup(); }
});

test("stale observation (>5s) triggers a fresh re-observation; never transports on stale", async () => {
  const f = setup();
  try {
    let n = 0;
    const t = {
      calls: { observe: [], commitLike: [] },
      async observe(opts = {}) {
        n += 1;
        t.calls.observe.push(opts.reason || "");
        // first dump is 30s old (stale), later ones fresh; post_like reports liked
        const label = opts.reason === "post_like" ? "已点赞" : "点赞";
        const observedAt = n === 1 ? NOW - 30_000 : NOW;
        return { ...FRESH, likeLabel: label, observedAt, targetFingerprint: opts.targetFingerprint ?? TARGET };
      },
      async commitLike(args) { t.calls.commitLike.push(args); return { ok: true }; },
    };
    const bridge = createRoutineEffectBridge({ state: f.state, owner: OWNER, transport: t, clock: CLOCK });
    const res = await bridge.commitRoutineEffect(ctx(), { action: "like" });
    assert.equal(res.outcome, "verified");
    assert.equal(t.calls.observe.length, 3, "stale pre + fresh re-observation + post-state");
    assert.deepEqual(t.calls.observe, ["pre_like", "pre_like_refresh", "post_like"]);
    // permanently stale -> stopped, zero transport
    const t2 = transport();
    t2.observe = async () => ({ ...FRESH, likeLabel: "点赞", observedAt: NOW - 30_000 });
    const bridge2 = createRoutineEffectBridge({ state: f.state, owner: OWNER, transport: t2, clock: CLOCK });
    const res2 = await bridge2.commitRoutineEffect(ctx(), { action: "like" });
    assert.equal(res2.outcome, "stopped:observation_stale");
    assert.equal(res2.transported, false);
    assert.equal(t2.calls.commitLike.length, 0);
  } finally { f.cleanup(); }
});

test("post-state unclear -> ambiguous: slot consumed, no retry, same triple rejected", async () => {
  const f = setup();
  try {
    const t = transport({ labels: ["点赞"], postLabel: "点赞" }); // commit ok but post still unliked
    const bridge = createRoutineEffectBridge({ state: f.state, owner: OWNER, transport: t, clock: CLOCK });
    const res = await bridge.commitRoutineEffect(ctx(), { action: "like" });
    assert.equal(res.outcome, "ambiguous");
    assert.equal(res.transported, true);
    const effects = f.state.listRoutineEffects(OWNER.routineRunId);
    assert.equal(effects[0].status, "ambiguous");
    assert.equal(effects[0].retryBlocked, true);
    // a retry on the same triple with a FRESH operation key (different payload)
    // is fenced by the ledger's retry_blocked flag
    const t2 = transport({ labels: ["点赞"], postLabel: "已点赞" });
    const bridge2 = createRoutineEffectBridge({ state: f.state, owner: OWNER, transport: t2, clock: CLOCK });
    const res2 = await bridge2.commitRoutineEffect(ctx({ observationHash: "dh2", payloadHash: "retry-1" }), { action: "like" });
    assert.equal(res2.outcome, "ambiguous_no_retry");
    assert.equal(res2.transported, false);
    assert.equal(t2.calls.commitLike.length, 0, "poisoned triple can never re-transport");
  } finally { f.cleanup(); }
});

// --- server-hard budget (§7.2/§7.3, §10.6) -----------------------------------

test("hard budget: like max=1 per run; second distinct target is hard-rejected pre-transport", async () => {
  const f = setup();
  try {
    const t = transport({ labels: ["点赞"], postLabel: "已点赞" });
    const bridge = createRoutineEffectBridge({ state: f.state, owner: OWNER, transport: t, clock: CLOCK });
    const r1 = await bridge.commitRoutineEffect(ctx(), { action: "like" });
    assert.equal(r1.outcome, "verified");
    const r2 = await bridge.commitRoutineEffect(ctx({ targetFingerprint: "fp_target_2", observationHash: "dh2" }), { action: "like" });
    assert.equal(r2.outcome, "cap_reached");
    assert.equal(r2.transported, false);
    assert.equal(t.calls.commitLike.length, 1, "second like never transported");
    // like and comment count separately: the like cap does not touch comment
    const c = await bridge.commitRoutineEffect(ctx({ observationHash: "dh3" }), { action: "comment" }).catch((e) => ({ code: e.code }));
    assert.equal(c.code, "ROUTINE_ACTION_NOT_WIRED", "comment is S3 — unwired, not budget-softened");
  } finally { f.cleanup(); }
});

test("hard budget cannot be softened: nonpayment policyMode has no path here", async () => {
  const f = setup();
  try {
    const t = transport({ labels: ["点赞"], postLabel: "已点赞" });
    const bridge = createRoutineEffectBridge({ state: f.state, owner: OWNER, transport: t, clock: CLOCK });
    await bridge.commitRoutineEffect(ctx(), { action: "like" });
    // even handing the ledger a nonpayment policyMode + debtSink cannot soften:
    // beginRoutineEffect has no soft/debt parameters at all
    expectCode(
      () => f.state.beginRoutineEffect({
        routineRunId: OWNER.routineRunId,
        planHash: OWNER.planHash,
        action: "like",
        targetFingerprint: "fp_target_2",
        idempotencyKey: "k" + "0".repeat(63),
        budget: ROUTINE_EFFECT_BUDGET,
      }),
      "ROUTINE_BUDGET_EXCEEDED",
    );
    // and the policyMode object is inert if passed — the bridge never consults it
    assert.equal(t.calls.commitLike.length, 1);
    const effects = f.state.listRoutineEffects(OWNER.routineRunId);
    assert.equal(effects.length, 1, "exactly one transport across the whole run");
  } finally { f.cleanup(); }
});

test("beginRoutineEffect rejects mode!=hard, unknown actions, and caps above the schema", () => {
  const f = setup();
  try {
    const base = {
      routineRunId: OWNER.routineRunId,
      planHash: OWNER.planHash,
      action: "like",
      targetFingerprint: TARGET,
      idempotencyKey: "k" + "1".repeat(63),
    };
    expectCode(() => f.state.beginRoutineEffect({ ...base, budget: { mode: "soft", actions: { like: { max: 1, perTarget: 1 } } } }), "ROUTINE_BUDGET_MODE_HARD_REQUIRED");
    expectCode(() => f.state.beginRoutineEffect({ ...base, budget: ROUTINE_EFFECT_BUDGET, action: "follow" }), "ROUTINE_BUDGET_ACTION_UNKNOWN");
    expectCode(
      () => f.state.beginRoutineEffect({ ...base, budget: { mode: "hard", actions: { like: { max: 5, perTarget: 1 } } } }),
      "ROUTINE_BUDGET_CAP_EXCEEDED",
    );
  } finally { f.cleanup(); }
});

test("replay: the same stable operation key reuses the original receipt and never re-sends", async () => {
  const f = setup();
  try {
    const t = transport({ labels: ["点赞"], postLabel: "已点赞" });
    const bridge = createRoutineEffectBridge({ state: f.state, owner: OWNER, transport: t, clock: CLOCK });
    const r1 = await bridge.commitRoutineEffect(ctx(), { action: "like" });
    assert.equal(r1.outcome, "verified");
    const before = t.calls.commitLike.length;
    const r2 = await bridge.commitRoutineEffect(ctx(), { action: "like" });
    assert.equal(r2.outcome, "replayed");
    assert.equal(r2.transported, false);
    assert.equal(t.calls.commitLike.length, 1, "no second transport on replay");
    assert.equal(f.state.listRoutineEffects(OWNER.routineRunId).length, 1, "no second ledger row");
  } finally { f.cleanup(); }
});

test("concurrent reservations cannot break the hard budget (same SQLite transaction)", async () => {
  const f = setup();
  try {
    const t = transport({ labels: ["点赞"], postLabel: "已点赞" });
    const bridge = createRoutineEffectBridge({ state: f.state, owner: OWNER, transport: t, clock: CLOCK });
    // fire 4 concurrent like commits on distinct targets against like.max=1
    const results = await Promise.allSettled([
      bridge.commitRoutineEffect(ctx({ targetFingerprint: "fp_c1", observationHash: "dh1" }), { action: "like" }),
      bridge.commitRoutineEffect(ctx({ targetFingerprint: "fp_c2", observationHash: "dh2" }), { action: "like" }),
      bridge.commitRoutineEffect(ctx({ targetFingerprint: "fp_c3", observationHash: "dh3" }), { action: "like" }),
      bridge.commitRoutineEffect(ctx({ targetFingerprint: "fp_c4", observationHash: "dh4" }), { action: "like" }),
    ]);
    const verified = results.filter((r) => r.value?.outcome === "verified");
    const capped = results.filter((r) => r.value?.outcome === "cap_reached");
    const errors = results.filter((r) => r.status === "rejected" && r.reason?.code === "ROUTINE_BUDGET_EXCEEDED");
    assert.equal(verified.length, 1, "exactly one like transports");
    assert.equal(capped.length + errors.length, 3, "the other three are hard-rejected");
    assert.equal(t.calls.commitLike.length, 1);
    assert.equal(f.state.listRoutineEffects(OWNER.routineRunId).length, 1);
  } finally { f.cleanup(); }
});

// --- machine integration (S1 x S2 seam) --------------------------------------

const FEED_FOCUS = "com.xingin.xhs/com.xingin.xhs.index.v2.IndexActivityV2";
const NOTE_FOCUS = "com.xingin.xhs/com.xingin.xhs.note.NoteDetailActivity";
const NOTE_DESC = "笔记 攀岩入门三条路线 来自小岩 123赞";

/** Full fake driver wired to the same observation surface the bridge uses.
 *  Exposes the formal execution/cleanup interfaces the production machine
 *  requires: getExecutionBinding/refresh/release/getCleanupStatus (plan V2 §5.2). */
function machineDriver({ likeLabels = ["点赞", "已点赞"] } = {}) {
  const NOTE_DETAIL_XML = '<node class="android.widget.TextView" content-desc="点赞" text="" bounds="[40,2200][140,2300]"/>'
    + '<node class="android.widget.TextView" content-desc="评论 2" text="" bounds="[240,2200][340,2300]"/>';
  const FEED_XML = '<node class="android.widget.ImageView" content-desc="' + NOTE_DESC + '" text="" clickable="true" bounds="[40,400][500,900]"/>'
    + '<node class="android.widget.ImageView" content-desc="' + NOTE_DESC + '" text="" clickable="true" bounds="[560,400][1020,900]"/>';
  const state = { taps: 0, likeIdx: 0 };
  let released = false;
  let executionBinding = null;
  return {
    async getExecutionBinding({ alias } = {}) {
      released = false;
      executionBinding = {
        alias: String(alias),
        sessionId: `fixture-session-${alias}`,
        deviceId: `fixture-device-${alias}`,
      };
      return executionBinding;
    },
    async ensureFeed() { return { ok: true, activity: FEED_FOCUS }; },
    async refresh() { return { ok: true, activity: FEED_FOCUS }; },
    async dump({ label } = {}) {
      if (String(label || "").startsWith("detail")) {
        return { xml: NOTE_DETAIL_XML, focus: NOTE_FOCUS, pkg: "com.xingin.xhs", hash: `dh_detail_${label}` };
      }
      return { xml: FEED_XML, focus: FEED_FOCUS, pkg: "com.xingin.xhs", hash: `dh_feed_${label}` };
    },
    async tapAt() { state.taps += 1; return { ok: true, activity: NOTE_FOCUS }; },
    async back() { return { ok: true, focusVerified: true }; },
    async swipeComments({ screens }) { return { ok: true, screens }; },
    async waitFor() { return { ok: true }; },
    async release() {
      released = true;
      return { ok: true, released: true };
    },
    async getCleanupStatus() {
      return {
        activeLeases: released ? 0 : 1,
        restored: released,
        authorityRef: executionBinding?.sessionId ? "fixture:cleanup" : null,
        observedAtMs: NOW,
      };
    },
    // bridge observation surface: the like label evolves with each transport
    observeLikeLabel() { return likeLabels[Math.min(state.likeIdx, likeLabels.length - 1)]; },
    noteLikeAdvanced() { state.likeIdx += 1; },
    taps: state,
  };
}

test("machine x bridge: nurture-lite likeMax=1 end-to-end — one verified like, transport 1, receipt consistent", async () => {
  const f = setup();
  try {
    const plan = bindRoutineExecution(
      planRoutine({ templateId: "xhs.nurture-lite.v1", params: { items: 3, likeMax: 1, seed: "s2-e2e" } }),
      { alias: "03" },
    );
    const owner = Object.freeze({ ...OWNER, routineRunId: plan.routineRunId, planHash: plan.planHash });
    const driver = machineDriver();
    const t = {
      calls: { observe: [], commitLike: [] },
      async observe({ reason, targetFingerprint } = {}) {
        t.calls.observe.push(reason || "");
        return {
          hash: `obs_${reason}_${t.calls.observe.length}`,
          targetFingerprint,
          likeLabel: reason === "post_like" ? "已点赞" : driver.observeLikeLabel(),
          observedAt: CLOCK.nowMs(),
        };
      },
      async commitLike(args) {
        t.calls.commitLike.push(args);
        driver.noteLikeAdvanced();
        return { ok: true };
      },
    };
    const bridge = createRoutineEffectBridge({ state: f.state, owner, transport: t, clock: CLOCK });
    const machine = createRoutineRun({
      plan,
      driver,
      clock: CLOCK,
      effects: bridgeAsMachineEffects({ bridge, owner }),
    });
    const receipt = await machine.execute();
    assert.equal(receipt.status, "SUCCEEDED");
    assert.equal(receipt.transport.count, 1, "likeMax=1: exactly one transport");
    assert.equal(receipt.effects.like.transported, 1);
    assert.equal(t.calls.commitLike.length, 1);
    const effects = f.state.listRoutineEffects(owner.routineRunId);
    assert.equal(effects.length, 1);
    assert.equal(effects[0].status, "verified");
    assert.equal(effects[0].planHash, plan.planHash, "ledger row bound to the machine planHash");
    assert.equal(effects[0].routineRunId, plan.routineRunId);
    // remaining items capped by the plan, not re-attempted
    const capReached = receipt.items.filter((it) => /cap_reached/.test(it.effects.like)).length;
    assert.ok(capReached >= 1, "later items report cap_reached");
  } finally { f.cleanup(); }
});

test("machine x bridge: unprovable like state -> zero transport across the whole run", async () => {
  const f = setup();
  try {
    const plan = bindRoutineExecution(
      planRoutine({ templateId: "xhs.nurture-lite.v1", params: { items: 2, likeMax: 1, seed: "s2-unprovable" } }),
      { alias: "03" },
    );
    const owner = Object.freeze({ ...OWNER, routineRunId: plan.routineRunId, planHash: plan.planHash });
    const driver = machineDriver({ likeLabels: ["", ""] });
    const t = {
      calls: { observe: [], commitLike: [] },
      async observe({ reason, targetFingerprint } = {}) {
        t.calls.observe.push(reason || "");
        return {
          hash: `obs_${reason}_${t.calls.observe.length}`,
          targetFingerprint,
          likeLabel: "",
          observedAt: CLOCK.nowMs(),
        };
      },
      async commitLike(args) { t.calls.commitLike.push(args); return { ok: true }; },
    };
    const bridge = createRoutineEffectBridge({ state: f.state, owner, transport: t, clock: CLOCK });
    const receipt = await createRoutineRun({
      plan,
      driver,
      clock: CLOCK,
      effects: bridgeAsMachineEffects({ bridge, owner }),
    }).execute();
    assert.equal(receipt.status, "SUCCEEDED");
    assert.equal(receipt.transport.count, 0, "never a blind toggle");
    assert.equal(t.calls.commitLike.length, 0);
    assert.equal(f.state.listRoutineEffects(owner.routineRunId).length, 0, "no slot consumed");
  } finally { f.cleanup(); }
});
// --- V2.1: full account binding (P1-COMMENT-RECONCILE-LIFECYCLE) ----------------

test("V2.1: like effect rows bind the owner tuple's account fingerprint", async () => {
  const f = setup();
  try {
    const bridge = createRoutineEffectBridge({
      state: f.state,
      owner: { ...OWNER, accountFingerprint: "acct-like-03" },
      transport: transport(),
      clock: CLOCK,
    });
    const res = await bridge.commitRoutineEffect(ctx(), { action: "like" });
    assert.equal(res.outcome, "verified");
    const effect = f.state.listRoutineEffects(OWNER.routineRunId)[0];
    assert.equal(effect.accountFingerprint, "acct-like-03");
  } finally {
    f.cleanup();
  }
});
