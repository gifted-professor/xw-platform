import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import { MissionRuntime } from "../control-plane/lib/mission-runtime.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";
import { ControlPlaneError } from "../control-plane/lib/errors.mjs";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "mission-runtime-"));
}

const base = {
  issuer: { actorId: "human:operator" },
  idempotencyKey: "freedom-20260729-01",
  app: "xhs",
  account: "local-alias",
  parallelism: 1,
  controllers: ["agent:runner"],
  scope: {
    actions: ["follow", "like", "collect", "comment", "dm"],
    targets: { kind: "fingerprint", values: ["target-hash-aaa"] },
    totalCount: 5,
    perTargetCount: 1,
    frequency: { count: 1, windowSeconds: 3600 },
  },
  validity: { expiresAt: "2099-07-29T16:00:00Z" },
};

function setup(path) {
  const state = new StateStore({ dbPath: path });
  const runtime = new MissionRuntime({ state });
  return { state, runtime };
}

test("createMission is idempotent and returns one immutable mission", () => {
  const root = tempRoot();
  const { state, runtime } = setup(join(root, "control.db"));
  try {
    const first = runtime.createMission(base);
    const second = runtime.createMission(base);
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(second.mission.missionId, first.mission.missionId);
    assert.equal(second.mission.version, 1);
    assert.equal(second.mission.missionHash, first.mission.missionHash);
    assert.ok(first.mission.missionHash && /^[0-9a-f]{64}$/.test(first.mission.missionHash));
    // the stored policy is frozen: no setter mutates scope
    assert.deepEqual(first.mission.scope.actions, base.scope.actions);
    assert.deepEqual(first.mission.controllers, ["agent:runner"]);
    assert.equal(first.mission.status, "active");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("createMission stores app/account/scope/budget/validity/controller policy fields", () => {
  const root = tempRoot();
  const { state, runtime } = setup(join(root, "control.db"));
  try {
    const { mission } = runtime.createMission(base);
    assert.equal(mission.app, "xhs");
    assert.equal(mission.account, "local-alias");
    assert.equal(mission.parallelism, 1);
    assert.deepEqual(mission.scope.targets, { kind: "fingerprint", values: ["target-hash-aaa"] });
    assert.equal(mission.scope.totalCount, 5);
    assert.equal(mission.scope.perTargetCount, 1);
    assert.deepEqual(mission.scope.frequency, { count: 1, windowSeconds: 3600 });
    assert.equal(mission.validity.expiresAt, "2099-07-29T16:00:00Z");
    assert.deepEqual(mission.controllers, ["agent:runner"]);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("MVP schema fixes parallelism to 1 and rejects any larger value", () => {
  const root = tempRoot();
  const { state, runtime } = setup(join(root, "control.db"));
  try {
    assert.throws(
      () => runtime.createMission({ ...base, idempotencyKey: "p2", parallelism: 2 }),
      { code: "PARALLELISM_UNSUPPORTED" },
    );
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("payment can never be released and is rejected at mission creation", () => {
  const root = tempRoot();
  const { state, runtime } = setup(join(root, "control.db"));
  try {
    assert.throws(
      () => runtime.createMission({ ...base, idempotencyKey: "pay", policy: { payment: "allow_within_scope" } }),
      { code: "PAYMENT_POLICY_INVALID" },
    );
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("publish/delete default to confirm but a Mission may explicitly release them", () => {
  const root = tempRoot();
  const { state, runtime } = setup(join(root, "control.db"));
  try {
    const { mission: locked } = runtime.createMission({ ...base, idempotencyKey: "locked" });
    assert.equal(locked.policy.publish, "confirm");
    assert.equal(locked.policy.delete, "confirm");
    assert.equal(locked.policy.payment, "confirm");

    const { mission: released } = runtime.createMission({
      ...base,
      idempotencyKey: "released",
      scope: { ...base.scope, actions: ["follow", "publish", "delete"] },
      policy: { publish: "allow_within_scope", delete: "allow_within_scope" },
    });
    assert.equal(released.policy.publish, "allow_within_scope");
    assert.equal(released.policy.delete, "allow_within_scope");
    assert.equal(released.policy.payment, "confirm");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("evaluateMissionEffect classifies scope and policy without typed action IDs", () => {
  const root = tempRoot();
  const { state, runtime } = setup(join(root, "control.db"));
  try {
    const { mission } = runtime.createMission(base);
    const target = "target-hash-aaa";
    assert.deepEqual(runtime.evaluateMissionEffect(mission, { action: "follow", target }), {
      decision: "ecp",
      reason: "IN_SCOPE_SOCIAL_EFFECT",
    });
    assert.equal(runtime.evaluateMissionEffect(mission, { action: "payment", target }).decision, "phc");
    assert.equal(runtime.evaluateMissionEffect(mission, { action: "publish", target }).decision, "phc");
    assert.equal(runtime.evaluateMissionEffect(mission, { action: "delete", target }).decision, "phc");
    assert.equal(runtime.evaluateMissionEffect(mission, { action: "follow", target: "other" }).decision, "scope_violation");
    assert.equal(runtime.evaluateMissionEffect(mission, { action: "payment", target: "other" }).decision, "phc");
    assert.equal(runtime.evaluateMissionEffect(mission, { action: "reboot", target }).decision, "scope_violation");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicitly released publish/delete run the ECP, not the PHC", () => {
  const root = tempRoot();
  const { state, runtime } = setup(join(root, "control.db"));
  try {
    const { mission } = runtime.createMission({
      ...base,
      idempotencyKey: "released-eval",
      scope: { ...base.scope, actions: ["follow", "publish", "delete"] },
      policy: { publish: "allow_within_scope", delete: "allow_within_scope" },
    });
    const target = "target-hash-aaa";
    assert.equal(runtime.evaluateMissionEffect(mission, { action: "publish", target }).decision, "ecp");
    assert.equal(runtime.evaluateMissionEffect(mission, { action: "delete", target }).decision, "ecp");
    assert.equal(runtime.evaluateMissionEffect(mission, { action: "publish", target: "other" }).decision, "scope_violation");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("expired or revoked missions block rather than request wider authority", () => {
  const root = tempRoot();
  let state;
  try {
    state = new StateStore({ dbPath: join(root, "control.db"), now: () => 1_000_000_000_000 });
    const runtime = new MissionRuntime({ state });
    const { mission } = runtime.createMission({
      ...base,
      idempotencyKey: "expiry",
      validity: { expiresAt: "2001-01-01T00:00:00Z" },
    });
    assert.equal(runtime.evaluateMissionEffect(mission, { action: "follow", target: "target-hash-aaa" }).decision, "blocked");

    const { mission: live } = runtime.createMission(base);
    runtime.revokeMission(live.missionId, { actorId: "human:operator", reason: "user-revoke" });
    assert.equal(runtime.evaluateMissionEffect(live, { action: "follow", target: "target-hash-aaa" }).decision, "blocked");
    assert.throws(() => runtime.requireActiveMission(live.missionId), { code: "MISSION_REVOKED" });
  } finally {
    try { state?.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("a material scope expansion needs a new hash rather than mutating the original", () => {
  const root = tempRoot();
  const { state, runtime } = setup(join(root, "control.db"));
  try {
    const first = runtime.createMission(base);
    const expanded = runtime.createMission({
      ...base,
      idempotencyKey: "freedom-20260729-02",
      scope: { ...base.scope, totalCount: 50 },
    });
    assert.notEqual(expanded.mission.missionHash, first.mission.missionHash);
    assert.notEqual(expanded.mission.missionId, first.mission.missionId);
    // original is immutable
    assert.equal(runtime.requireActiveMission(first.mission.missionId).scope.totalCount, 5);

    // same idempotency key with different content conflicts, never silently mutates
    assert.throws(
      () => runtime.createMission({ ...base, scope: { ...base.scope, totalCount: 50 } }),
      { code: "IDEMPOTENCY_CONFLICT" },
    );
    assert.equal(runtime.requireActiveMission(first.mission.missionId).scope.totalCount, 5);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing jobs have no Mission association and legacy state shapes are retained", () => {
  const root = tempRoot();
  const { state, runtime } = setup(join(root, "control.db"));
  try {
    const { mission } = runtime.createMission(base);
    assert.ok(mission.missionId);
    // missions table is additive: device/job/session public shapes are unchanged
    assert.equal(Object.hasOwn(state.listDevices(), "length"), true);
    assert.equal(state.listLeases().length, 0);
    // no missionId field leaks onto the legacy job public shape
    state.upsertNode({ nodeId: "DESKTOP-3I1EVHE", authority: true });
    const device = state.upsertDevice({
      alias: "01",
      physicalLabel: "rack-01",
      nodeId: "DESKTOP-3I1EVHE",
      runtimeId: "rt",
      routingProfile: { enabled: true, tags: [], capabilityIds: [] },
    });
    assert.equal(Object.hasOwn(device, "missionId"), false);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("requireActiveMission fails closed for unknown ids", () => {
  const root = tempRoot();
  const { state, runtime } = setup(join(root, "control.db"));
  try {
    assert.throws(() => runtime.requireActiveMission("mission_missing"), { code: "MISSION_NOT_FOUND" });
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── REX Phase 5 §8.4 (P5b): delegation-grant 退热路径成可选 provenance ────────────────
// plan B3 line 827-828：parent grant 缺失/过期不阻断非支付，记 provenance debt。nonpayment_v1
// 下 verifyParentGrant 的非 MISSION_REVOKED 失败返回 soft:true；requireActiveMission 软通过并
// 经 debtSink 记 provenance_debt。MISSION_REVOKED（显式撤销/级联撤销）任何模式都硬。
test("REX P5b: nonpayment_v1 soft-fences an expired parent grant with provenance debt; legacy and revoke stay hard", () => {
  const root = tempRoot();
  let now = Date.now();
  const state = new StateStore({ dbPath: join(root, "control.db"), now: () => now });
  const runtime = new MissionRuntime({ state, now: () => now });
  const NONPAY = { active: true };
  const debt = [];
  try {
    const grant = {
      grantId: "grant-provenance-expiry", issuanceNonce: "n1", app: "xhs", accountFingerprint: "local-alias",
      controllers: ["agent:runner"],
      authorization: { primitives: [], socialActions: ["follow", "like", "collect", "comment", "dm"], missionOnlyActions: [], prohibitedActions: [] },
      targets: { mode: "explicit_fingerprints", values: ["target-hash-aaa"] },
      budget: { maxima: { totalCount: 5, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } }, defaults: { totalCount: 5, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } } },
      validity: { expiresAt: new Date(now + 1000).toISOString() },
    };
    state.issueDelegationGrant({ grant, grantHash: "grant-provenance-hash", proofHash: "proof", issuerSubject: "user:a1234", issuerKeyId: "test", allowlistVersion: 1 });
    const { mission } = runtime.createMission({ ...base, idempotencyKey: "provenance-expiry" }, { parentGrantId: grant.grantId, parentGrantHash: "grant-provenance-hash" });

    // while the parent is live both modes verify ok
    assert.equal(runtime.verifyParentGrant(mission, { action: "follow", target: "target-hash-aaa" }).ok, true);
    assert.equal(runtime.verifyParentGrant(mission, { action: "follow", target: "target-hash-aaa" }, { policyMode: NONPAY }).ok, true);

    // parent expires → legacy hard-fences, nonpayment soft-fences with provenance debt
    now += 1001;
    assert.equal(runtime.verifyParentGrant(mission, { action: "follow", target: "target-hash-aaa" }).ok, false);
    const softParent = runtime.verifyParentGrant(mission, { action: "follow", target: "target-hash-aaa" }, { policyMode: NONPAY });
    assert.equal(softParent.ok, false);
    assert.equal(softParent.code, "PARENT_GRANT_EXPIRED");
    assert.equal(softParent.soft, true);
    assert.throws(() => runtime.requireActiveMission(mission.missionId), { code: "PARENT_GRANT_EXPIRED" });
    const resolved = runtime.requireActiveMission(mission.missionId, { policyMode: NONPAY, debtSink: (entry) => debt.push(entry) });
    assert.equal(resolved.missionId, mission.missionId);
    assert.equal(debt.length, 1);
    assert.equal(debt[0].kind, "provenance_debt");
    assert.equal(debt[0].code, "PARENT_GRANT_EXPIRED");

    // MISSION_REVOKED (explicit revoke) stays hard under nonpayment — the one human-cancel fence
    runtime.revokeMission(mission.missionId, { actorId: "human:operator", reason: "user-revoke" });
    const revoked = runtime.verifyParentGrant(mission, { action: "follow", target: "target-hash-aaa" }, { policyMode: NONPAY });
    assert.equal(revoked.ok, false);
    assert.equal(revoked.code, "MISSION_REVOKED");
    assert.equal(revoked.soft, undefined);
    assert.throws(() => runtime.requireActiveMission(mission.missionId, { policyMode: NONPAY }), { code: "MISSION_REVOKED" });
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── REX Phase 5 §8.4 (P5b): expiry 软预算 ───────────────────────────────────────
// plan B3 line 828-829：count/frequency/expiry 软预算。MISSION_EXPIRED（子任务过期）在
// nonpayment_v1 下 soft-fence 成 budget_debt（requireActiveMission + verifyParentGrant），
// legacy 仍 MISSION_EXPIRED 硬。MISSION_REVOKED 仍是唯一人类撤销硬栅栏。
test("REX P5b: nonpayment_v1 soft-fences an expired child mission with budget debt; legacy stays hard", () => {
  const root = tempRoot();
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const runtime = new MissionRuntime({ state });
  const NONPAY = { active: true };
  const debt = [];
  try {
    const grant = {
      grantId: "grant-expiry-child", issuanceNonce: "n1", app: "xhs", accountFingerprint: "local-alias",
      controllers: ["agent:runner"],
      authorization: { primitives: [], socialActions: ["follow", "like", "collect", "comment", "dm"], missionOnlyActions: [], prohibitedActions: [] },
      targets: { mode: "explicit_fingerprints", values: ["target-hash-aaa"] },
      budget: { maxima: { totalCount: 5, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } }, defaults: { totalCount: 5, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } } },
      validity: { expiresAt: "2099-07-29T16:00:00Z" }, // parent grant stays live
    };
    state.issueDelegationGrant({ grant, grantHash: "grant-expiry-child-hash", proofHash: "proof", issuerSubject: "user:a1234", issuerKeyId: "test", allowlistVersion: 1 });
    const { mission } = runtime.createMission(
      { ...base, idempotencyKey: "expired-child", validity: { expiresAt: "2001-01-01T00:00:00Z" } },
      { parentGrantId: grant.grantId, parentGrantHash: "grant-expiry-child-hash" },
    );

    // legacy: child expiry is a hard fence at both gates
    assert.equal(runtime.verifyParentGrant(mission).ok, false);
    assert.equal(runtime.verifyParentGrant(mission).code, "MISSION_EXPIRED");
    assert.throws(() => runtime.requireActiveMission(mission.missionId), { code: "MISSION_EXPIRED" });

    // nonpayment: child expiry soft-fences with budget debt (kind budget_debt, code MISSION_EXPIRED)
    const softParent = runtime.verifyParentGrant(mission, {}, { policyMode: NONPAY });
    assert.equal(softParent.ok, false);
    assert.equal(softParent.code, "MISSION_EXPIRED");
    assert.equal(softParent.soft, true);
    const resolved = runtime.requireActiveMission(mission.missionId, { policyMode: NONPAY, debtSink: (entry) => debt.push(entry) });
    assert.equal(resolved.missionId, mission.missionId);
    assert.equal(debt.length, 1);
    assert.equal(debt[0].kind, "budget_debt");
    assert.equal(debt[0].code, "MISSION_EXPIRED");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});