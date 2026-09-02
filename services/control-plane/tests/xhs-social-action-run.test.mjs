// xhs-social-action-run.test.mjs — F3 strict-mission social effect run invariants
// (executable-plan W4, contract F3).
//
// The budget test (`xw-xhs-effect-budget.test.mjs`) nails the pure plan-time
// expression of the strict Mission contract. This file nails the RUN-time half:
// what the control-plane StateStore actually enforces when two effects compete
// for the same target, when an ambiguous outcome poisons a (mission,action,
// target) triple against a blind retry, and when a re-run arrives for an
// already-completed target. Three probes, against the real StateStore +
// MissionRuntime + DeviceRunRuntime (no mocks):
//
//   Probe 1 — concurrent reservation competition (perTargetCount=1):
//     the first like on a target reserves it; a second like on the SAME target
//     is BUDGET_PER_TARGET_EXCEEDED even before the first is released — exactly one
//     transport per target. A different target proceeds; once totalCount live
//     reservations exist, any further target is BUDGET_EXCEEDED.
//
//   Probe 2 — forged-binding / no-retry fence (AMBIGUOUS_NO_RETRY):
//     an ambiguous outcome sets retry_blocked=1 on (missionId,action,targetHash).
//     A retry on the SAME triple is AMBIGUOUS_NO_RETRY (409) — checked before the
//     budget gate, so a poisoned triple can never sneak back in via a fresh
//     idempotency key. A different target, or a different action on a fresh
//     target, still proceeds — the fence is per-triple, not a mission-wide lock.
//
//   Probe 3 — replay idempotency + already-true skip:
//     the same idempotencyKey returns reused:true with the original effect and
//     creates NO second row (a re-run is a no-op, not a double-send). The
//     already-true skip (social-verifiers) short-circuits an already-liked /
//     already-collected / already-followed target BEFORE the ECP reservation —
//     so perTargetCount=1 is never consumed against an already-completed target.
//
// The idempotencyKey fed to beginMissionEffect is derived from the dispatcher's
// bindOperationKey — that is the W4 wiring (operationKey -> ECP idempotencyKey)
// the live canary exercises.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { DeviceRunRuntime } from "../control-plane/lib/device-run.mjs";
import { ControlPlaneError } from "../control-plane/lib/errors.mjs";
import { MissionRuntime } from "../control-plane/lib/mission-runtime.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";
import { bindOperationKey } from "../../orchestrator/scripts/lib/xw-xhs-dispatcher.mjs";
import {
  collectState,
  followState,
  isAlreadyTrue,
  likeState,
  socialEffectDecision,
} from "../apps/xhs/social-verifiers.mjs";

const AUTHORITY = "DESKTOP-F3-PROBE";

// operationKey -> ECP idempotencyKey. The live canary derives the idempotencyKey
// from the dispatcher operationKey so a replay of the same (action,target,payload)
// collides on the same key and is deduped by the StateStore.
function idk({ actionRunId = "ar_f3", action, target, payloadHash = null } = {}) {
  return bindOperationKey({ actionRunId, action, targetFingerprint: target, payloadHash });
}

function setupMission({ actions, targets, totalCount, perTargetCount = 1 }) {
  const root = mkdtempSync(join(tmpdir(), "f3-social-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const missions = new MissionRuntime({ state });
  const runs = new DeviceRunRuntime({ state, missions, authorityNodeId: AUTHORITY });
  state.upsertNode({ nodeId: AUTHORITY, authority: true });
  state.upsertDevice({
    alias: "04", physicalLabel: "rack-04", nodeId: AUTHORITY, runtimeId: "private-runtime-04",
    routingProfile: { enabled: true, tags: ["slot:04"], capabilityIds: [] },
  });
  const { mission } = missions.createMission({
    issuer: { actorId: "human:operator" },
    idempotencyKey: `f3-${Math.random()}`,
    app: "xhs", account: "local-alias-04", parallelism: 1, controllers: ["agent:runner"],
    scope: {
      actions, targets: { kind: "fingerprint", values: targets },
      totalCount, perTargetCount,
      frequency: { count: 100, windowSeconds: 3600 },
    },
    validity: { expiresAt: "2099-07-29T16:00:00Z" },
    policy: { publish: "confirm", delete: "confirm" },
  });
  const run = runs.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:runner" });
  return { root, state, mission, run, runs, cleanup: () => { state.close(); rmSync(root, { recursive: true, force: true }); } };
}

function begin(state, mission, run, { action, target, idempotencyKey }) {
  return state.beginMissionEffect({
    mission, deviceRunId: run.tuple.deviceRunId, action, targetHash: target,
    intent: { surface: "social-effect" }, idempotencyKey,
  });
}

function expectCode(fn, code) {
  try {
    fn();
  } catch (e) {
    if (e instanceof ControlPlaneError && e.code === code) return e;
    assert.fail(`expected ${code}, got ${e?.code ?? e?.message ?? String(e)}`);
  }
  assert.fail(`expected ${code} to be thrown`);
}

// --- Probe 1: concurrent reservation competition (perTargetCount=1) ------------

test("F3 probe 1: perTargetCount=1 = exactly one transport per target; totalCount caps distinct targets", () => {
  const f = setupMission({ actions: ["like", "collect", "follow"], targets: ["fp-a", "fp-b", "fp-c"], totalCount: 2, perTargetCount: 1 });
  try {
    // first like on fp-a reserves it.
    const r1 = begin(f.state, f.mission, f.run, { action: "like", target: "fp-a", idempotencyKey: idk({ action: "like", target: "fp-a", payloadHash: "p1" }) });
    assert.equal(r1.reused, false);
    assert.equal(r1.effect.action, "like");
    assert.equal(r1.effect.targetFingerprint, "fp-a");

    // a SECOND like on the SAME target — different idempotencyKey — is rejected:
    // exactly one transport per target, even before the first is released.
    const blocked = expectCode(
      () => begin(f.state, f.mission, f.run, { action: "like", target: "fp-a", idempotencyKey: idk({ action: "like", target: "fp-a", payloadHash: "p1-diff" }) }),
      "BUDGET_PER_TARGET_EXCEEDED",
    );
    assert.equal(blocked.status, 409);

    // a different target proceeds.
    const r2 = begin(f.state, f.mission, f.run, { action: "like", target: "fp-b", idempotencyKey: idk({ action: "like", target: "fp-b", payloadHash: "p2" }) });
    assert.equal(r2.reused, false);
    assert.equal(r2.effect.targetFingerprint, "fp-b");

    // totalCount=2 reached (fp-a + fp-b live) — any further target is BUDGET_EXCEEDED.
    const total = expectCode(
      () => begin(f.state, f.mission, f.run, { action: "follow", target: "fp-c", idempotencyKey: idk({ action: "follow", target: "fp-c", payloadHash: "p3" }) }),
      "BUDGET_EXCEEDED",
    );
    assert.equal(total.status, 409);

    // exactly two effects exist — no leaked reservation from the blocked attempts.
    const effects = f.state.listMissionEffects(f.mission.missionId);
    assert.equal(effects.length, 2);
  } finally {
    f.cleanup();
  }
});

// --- Probe 2: forged-binding / no-retry fence (AMBIGUOUS_NO_RETRY) -------------

test("F3 probe 2: ambiguous outcome poisons (mission,action,target) against blind retry; different triple proceeds", () => {
  const f = setupMission({ actions: ["like", "collect", "follow"], targets: ["fp-x", "fp-y", "fp-z"], totalCount: 5, perTargetCount: 1 });
  try {
    // like fp-x, then mark the outcome ambiguous -> retry_blocked=1 on (mission,like,fp-x).
    const r1 = begin(f.state, f.mission, f.run, { action: "like", target: "fp-x", idempotencyKey: idk({ action: "like", target: "fp-x", payloadHash: "px" }) });
    const ambiguous = f.state.recordMissionEffectOutcome(r1.effect.effectId, { status: "ambiguous" });
    assert.equal(ambiguous.retryBlocked, true, "ambiguous -> retry_blocked=1");

    // a retry on the SAME triple with a FRESH idempotencyKey is AMBIGUOUS_NO_RETRY.
    // The retry-block fence is checked before the budget gate, so a poisoned triple
    // cannot sneak back in via a new key.
    const fenced = expectCode(
      () => begin(f.state, f.mission, f.run, { action: "like", target: "fp-x", idempotencyKey: idk({ action: "like", target: "fp-x", payloadHash: "px-retry" }) }),
      "AMBIGUOUS_NO_RETRY",
    );
    assert.equal(fenced.status, 409);

    // a different target on the same action proceeds (the fence is per-triple, not mission-wide).
    const r2 = begin(f.state, f.mission, f.run, { action: "like", target: "fp-y", idempotencyKey: idk({ action: "like", target: "fp-y", payloadHash: "py" }) });
    assert.equal(r2.reused, false);

    // a different action on a fresh target proceeds.
    const r3 = begin(f.state, f.mission, f.run, { action: "collect", target: "fp-z", idempotencyKey: idk({ action: "collect", target: "fp-z", payloadHash: "pz" }) });
    assert.equal(r3.reused, false);

    // three effects total: the ambiguous one + two new ones. No fourth from the fenced retry.
    assert.equal(f.state.listMissionEffects(f.mission.missionId).length, 3);
  } finally {
    f.cleanup();
  }
});

// --- Probe 3: replay idempotency + already-true skip --------------------------

test("F3 probe 3a: same idempotencyKey is a no-op replay (reused:true, no second effect)", () => {
  const f = setupMission({ actions: ["like"], targets: ["fp-r"], totalCount: 1, perTargetCount: 1 });
  try {
    const key = idk({ action: "like", target: "fp-r", payloadHash: "pr" });
    const r1 = begin(f.state, f.mission, f.run, { action: "like", target: "fp-r", idempotencyKey: key });
    assert.equal(r1.reused, false);

    // same operationKey -> same idempotencyKey -> reused:true, SAME effectId, no new row.
    const r2 = begin(f.state, f.mission, f.run, { action: "like", target: "fp-r", idempotencyKey: key });
    assert.equal(r2.reused, true);
    assert.equal(r2.effect.effectId, r1.effect.effectId);
    assert.equal(f.state.listMissionEffects(f.mission.missionId).length, 1, "replay creates no second effect");
  } finally {
    f.cleanup();
  }
});

test("F3 probe 3b: already-true skip short-circuits before the ECP reservation (social-verifiers)", () => {
  // The state classifiers are faithful to the ops originals: 已* (terminal) is
  // checked before the bare verb because the terminal contains the verb substring.
  assert.equal(likeState("已点赞"), "liked");
  assert.equal(likeState("点赞"), "unliked");
  assert.equal(likeState(""), "missing");
  assert.equal(likeState("别的"), "unknown");

  assert.equal(collectState("已收藏"), "collected");
  assert.equal(collectState("收藏"), "uncollected");
  assert.equal(collectState(""), "missing");

  // followState checks 已关注|相互关注 FIRST, then 关注|回关.
  assert.equal(followState("已关注"), "followed");
  assert.equal(followState("相互关注"), "followed");
  assert.equal(followState("关注"), "unfollowed");
  assert.equal(followState("回关"), "unfollowed");
  assert.equal(followState(""), "missing");
  // a label containing 关注 but not a follow button (e.g. 关注的话题) is "unfollowed"
  // by the regex — the caller-side exact-set locator (FOLLOW_LABELS) is what prevents
  // the false positive; the classifier itself is documented substring-only.
  assert.equal(followState("关注的话题"), "unfollowed");

  // isAlreadyTrue guard.
  assert.equal(isAlreadyTrue("like", "liked"), true);
  assert.equal(isAlreadyTrue("collect", "collected"), true);
  assert.equal(isAlreadyTrue("follow", "followed"), true);
  assert.equal(isAlreadyTrue("like", "unliked"), false);

  // socialEffectDecision: already-true -> skip, no transport, no ECP reservation.
  for (const [action, terminal] of [["like", "liked"], ["collect", "collected"], ["follow", "followed"]]) {
    const d = socialEffectDecision({ action, beforeState: terminal });
    assert.equal(d.skip, true, `${action} already-true skips`);
    assert.equal(d.transport, 0, `${action} already-true zero transport`);
    assert.equal(d.reason, `already-${action}`);
  }

  // actionable pre-state -> proceed (one transport).
  assert.deepEqual(socialEffectDecision({ action: "like", beforeState: "unliked" }), { skip: false, reason: "proceed", transport: 1 });
  assert.deepEqual(socialEffectDecision({ action: "collect", beforeState: "uncollected" }), { skip: false, reason: "proceed", transport: 1 });
  assert.deepEqual(socialEffectDecision({ action: "follow", beforeState: "unfollowed" }), { skip: false, reason: "proceed", transport: 1 });

  // missing / unknown -> do NOT blind-tap; re-observe (REPLAN), not skip.
  for (const action of ["like", "collect", "follow"]) {
    const dMissing = socialEffectDecision({ action, beforeState: "missing" });
    assert.equal(dMissing.skip, false, `${action} missing is NOT a skip`);
    assert.equal(dMissing.transport, 0, `${action} missing zero transport (no blind tap)`);
    assert.equal(dMissing.reason, "unknown-state");
    const dUnknown = socialEffectDecision({ action, beforeState: "unknown" });
    assert.equal(dUnknown.skip, false);
    assert.equal(dUnknown.transport, 0);
  }

  // unknown action -> not a skip, zero transport.
  const dBad = socialEffectDecision({ action: "bogus", beforeState: "liked" });
  assert.equal(dBad.skip, false);
  assert.equal(dBad.transport, 0);
  assert.equal(dBad.reason, "unknown-action");
});

test("F3 probe 3c: already-true target never enters the ECP — perTargetCount=1 is preserved for a genuine transition", () => {
  // A re-run of an already-completed like is decided BEFORE the reservation: the
  // skip means beginMissionEffect is never called, so the per-target budget of 1
  // is not consumed against an already-liked target. Simulate the run-time ladder:
  //   observe beforeState -> socialEffectDecision -> only proceed calls begin.
  const f = setupMission({ actions: ["like", "collect"], targets: ["fp-s"], totalCount: 1, perTargetCount: 1 });
  try {
    const decide = socialEffectDecision({ action: "like", beforeState: "liked" });
    assert.equal(decide.skip, true);
    // because it skips, no reservation is opened — the budget is untouched.
    assert.equal(f.state.listMissionEffects(f.mission.missionId).length, 0);

    // a genuine transition (unliked -> like) DOES open the reservation.
    const proceed = socialEffectDecision({ action: "like", beforeState: "unliked" });
    assert.equal(proceed.skip, false);
    const r = begin(f.state, f.mission, f.run, { action: "like", target: "fp-s", idempotencyKey: idk({ action: "like", target: "fp-s", payloadHash: "ps" }) });
    assert.equal(r.reused, false);
    assert.equal(f.state.listMissionEffects(f.mission.missionId).length, 1);
  } finally {
    f.cleanup();
  }
});