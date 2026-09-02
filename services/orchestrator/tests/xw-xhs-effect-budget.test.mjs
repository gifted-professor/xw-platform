// xw-xhs-effect-budget.test.mjs — F3 strict-mission budget invariants
// (executable-plan W4, contract F3).
//
// The dispatcher's `effectBudget` is the pure plan-time expression of the strict
// Mission contract (plan V2 §5). The existing dispatcher test covers the basic
// shape; this file nails the F3-specific invariants that the live canary
// acceptance ("already-true skip; false->true exactly once transport; concurrent
// / replay do not break the budget") depends on:
//
//   * every social mission is perTargetCount=1 — exactly one transport per target
//   * comment/reply are single-shot (totalCount=1, capped)
//   * like/collect/follow totalCount follows the bounded count param (1..20)
//   * operationKey is deferred at plan time (target unknown) but deterministic
//     once bound — a collision on (action,target,payload) IS the replay boundary
//     ("ambiguous same mission/action/target 禁盲重试")
//   * payloadHash is content-bound and deterministic (the "body hash already sent"
//     stop condition basis)
//   * nurture is browse-only by default, one mission per explicit social count
//   * the budget and every mission are frozen (tamper-evident)
import assert from "node:assert/strict";
import test from "node:test";

import {
  bindOperationKey,
  effectBudget,
  normalizeParams,
  planAction,
  XHS_ACTION_CATALOG,
} from "../scripts/lib/xw-xhs-dispatcher.mjs";

function budgetOf(actionId, params) {
  return planAction({ actionId, params }).budget;
}

// --- F3: perTargetCount=1 is the "exactly one transport per target" invariant --

test("F3 budget: every social mission has perTargetCount=1 (exactly one transport per target)", () => {
  for (const id of ["like", "collect", "follow"]) {
    for (const count of [1, 2, 5, 20]) {
      const b = budgetOf(id, { keyword: "攀岩", count });
      assert.equal(b.effectClass, "social");
      assert.equal(b.missions.length, 1);
      assert.equal(b.missions[0].perTargetCount, 1, `${id} count=${count} perTargetCount=1`);
      assert.equal(b.missions[0].totalCount, count, `${id} count=${count} totalCount`);
      assert.equal(b.missions[0].capabilityId, `xhs.${id}.ensure`);
    }
  }
  // comment + reply are single-shot social effects.
  for (const [id, params] of [["comment", { keyword: "攀岩", text: "好" }], ["reply", { thread: "t1", text: "好" }]]) {
    const b = budgetOf(id, params);
    assert.equal(b.effectClass, "social");
    assert.equal(b.missions[0].perTargetCount, 1, `${id} perTargetCount=1`);
    assert.equal(b.missions[0].totalCount, 1, `${id} single-shot totalCount=1`);
  }
});

test("F3 budget: like/collect/follow count is bounded 1..20 (default 1)", () => {
  for (const id of ["like", "collect", "follow"]) {
    const def = budgetOf(id, { keyword: "x" });
    assert.equal(def.missions[0].totalCount, 1, `${id} default count=1`);
    // count above the catalog max (20) is rejected at normalizeParams, so the
    // budget never sees an over-ceiling totalCount — the ceiling is enforced
    // before the budget, at the param boundary.
    assert.throws(
      () => planAction({ actionId: id, params: { keyword: "x", count: 21 } }),
      (e) => e.code === "PARAMS_INVALID",
      `${id} count=21 rejected at param boundary`,
    );
    assert.throws(
      () => planAction({ actionId: id, params: { keyword: "x", count: 0 } }),
      (e) => e.code === "PARAMS_INVALID",
      `${id} count=0 rejected at param boundary`,
    );
  }
});

test("F3 budget: comment is capped at count=1 (single note, no multi-send)", () => {
  // comment count max=1 in the catalog; requesting 2 is rejected pre-budget.
  assert.throws(
    () => planAction({ actionId: "comment", params: { keyword: "x", text: "好", count: 2 } }),
    (e) => e.code === "PARAMS_INVALID",
  );
  const b = budgetOf("comment", { keyword: "x", text: "好" });
  assert.equal(b.missions[0].totalCount, 1);
});

// --- F3: operationKey deferred at plan time; deterministic + replay boundary --

test("F3 budget: social missions defer operationKey (target unknown at plan time)", () => {
  for (const id of ["like", "collect", "follow", "comment", "reply", "nurture"]) {
    const b = budgetOf(id, id === "nurture" ? { minutes: 20, likes: 1 } : minimalParams(id));
    assert.equal(b.operationKeyDeferred, true, `${id} operationKey deferred`);
    // No mission carries a pre-bound operationKey or targetFingerprint.
    for (const m of b.missions) {
      assert.equal("operationKey" in m, false, `${id} mission must not pre-bind operationKey`);
      assert.equal("targetFingerprint" in m, false, `${id} mission must not pre-bind targetFingerprint`);
    }
  }
});

test("F3 operationKey: collision on (action,target,payload) is the replay boundary (no blind retry)", () => {
  const base = { actionRunId: "ar_abc", action: "like", targetFingerprint: "fp_target_1", payloadHash: "h1" };
  const k1 = bindOperationKey(base);
  const k2 = bindOperationKey({ ...base }); // identical inputs -> same key (REPLAY)
  assert.equal(k1, k2, "same (action,target,payload) -> same operationKey = replay detected");
  assert.match(k1, /^[0-9a-f]{64}$/);

  // Different target -> different key (a NEW target is allowed, not a retry).
  const kOtherTarget = bindOperationKey({ ...base, targetFingerprint: "fp_target_2" });
  assert.notEqual(k1, kOtherTarget, "different target -> different operationKey");

  // Different action -> different key.
  const kOtherAction = bindOperationKey({ ...base, action: "collect" });
  assert.notEqual(k1, kOtherAction, "different action -> different operationKey");

  // Different payload -> different key (re-send of different body is distinct).
  const kOtherPayload = bindOperationKey({ ...base, payloadHash: "h2" });
  assert.notEqual(k1, kOtherPayload, "different payload -> different operationKey");

  // null payloadHash is accepted (like/collect/follow carry no text payload).
  const kNoPayload = bindOperationKey({ actionRunId: "ar_abc", action: "like", targetFingerprint: "fp1", payloadHash: null });
  assert.match(kNoPayload, /^[0-9a-f]{64}$/);
});

// --- F3: payloadHash determinism (the "body hash already sent" basis) --------

test("F3 budget: comment/reply payloadHash is content-bound and deterministic", () => {
  const c1 = budgetOf("comment", { keyword: "x", text: "好内容" });
  const c2 = budgetOf("comment", { keyword: "x", text: "好内容" });
  const c3 = budgetOf("comment", { keyword: "x", text: "不同内容" });
  assert.equal(c1.missions[0].payloadHash, c2.missions[0].payloadHash, "same text -> same payloadHash");
  assert.notEqual(c1.missions[0].payloadHash, c3.missions[0].payloadHash, "different text -> different payloadHash");

  // reply payloadHash binds text + thread (changing the thread changes the hash).
  const r1 = budgetOf("reply", { thread: "t1", text: "好" });
  const r2 = budgetOf("reply", { thread: "t2", text: "好" });
  assert.notEqual(r1.missions[0].payloadHash, r2.missions[0].payloadHash, "reply payloadHash binds thread");

  // like/collect/follow carry NO text payload -> payloadHash is null.
  for (const id of ["like", "collect", "follow"]) {
    const b = budgetOf(id, { keyword: "x", count: 1 });
    assert.equal(b.missions[0].payloadHash, null, `${id} has no text payload`);
  }
});

// --- F3: nurture composition + browse-only default + per-action ceiling ------

test("F3 budget: nurture is browse-only by default; one mission per explicit social count", () => {
  const def = budgetOf("nurture", { minutes: 20 });
  assert.equal(def.effectClass, "social");
  assert.equal(def.missions.length, 0, "default nurture = browse-only (no social effect)");

  const full = budgetOf("nurture", { minutes: 20, likes: 3, collects: 2, follows: 1 });
  assert.equal(full.missions.length, 3);
  const byAction = Object.fromEntries(full.missions.map((m) => [m.action, m]));
  assert.equal(byAction.like.totalCount, 3);
  assert.equal(byAction.collect.totalCount, 2);
  assert.equal(byAction.follow.totalCount, 1);
  for (const m of full.missions) assert.equal(m.perTargetCount, 1, "nurture sub-mission perTargetCount=1");

  // Each social count is bounded at the param boundary (max 20).
  assert.throws(
    () => planAction({ actionId: "nurture", params: { minutes: 20, likes: 21 } }),
    (e) => e.code === "PARAMS_INVALID",
    "nurture likes ceiling 20",
  );
});

// --- F3: frozen budget (tamper-evident) -------------------------------------

test("F3 budget: the budget and every mission are frozen (tamper-evident)", () => {
  for (const id of ["like", "comment", "reply", "nurture", "search", "publish send"]) {
    const b = budgetOf(id, minimalParams(id));
    assert.equal(Object.isFrozen(b), true, `${id} budget frozen`);
    for (const m of b.missions) assert.equal(Object.isFrozen(m), true, `${id} mission frozen`);
  }
});

// --- F3: none/publish invariants --------------------------------------------

test("F3 budget: none actions have zero missions + deferred key; publish is a single protected commit", () => {
  for (const id of ["search", "browse", "inbox", "read", "publish prepare"]) {
    const b = budgetOf(id, minimalParams(id));
    assert.equal(b.effectClass, "none");
    assert.deepEqual(b.missions, []);
    assert.equal(b.operationKeyDeferred, true);
  }
  const p = budgetOf("publish send", { run: "r1" });
  assert.equal(p.effectClass, "publish");
  assert.equal(p.missions.length, 1);
  assert.equal(p.missions[0].protectedCommit, true);
  assert.equal(p.missions[0].totalCount, 1);
  assert.equal(p.missions[0].perTargetCount, 1);
});

// --- helper -----------------------------------------------------------------

function minimalParams(actionId) {
  switch (actionId) {
    case "search": return { keyword: "x" };
    case "browse": return {};
    case "inbox": return {};
    case "read": return { thread: "t1" };
    case "like": case "collect": case "follow": return { keyword: "x" };
    case "comment": return { keyword: "x", text: "好" };
    case "reply": return { thread: "t1", text: "好" };
    case "nurture": return { minutes: 20 };
    case "publish prepare": return { title: "t", body: "b" };
    case "publish send": return { run: "r1" };
    default: return {};
  }
}