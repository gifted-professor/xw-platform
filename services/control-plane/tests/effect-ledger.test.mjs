import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { DeviceRunRuntime } from "../control-plane/lib/device-run.mjs";
import { EffectLedger } from "../control-plane/lib/effect-ledger.mjs";
import { MissionRuntime } from "../control-plane/lib/mission-runtime.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";

const AUTHORITY = "DESKTOP-3I1EVHE";

function missionInput(overrides = {}) {
  return {
    issuer: { actorId: "human:operator" },
    idempotencyKey: `ledger-${Math.random()}`,
    app: "xhs",
    account: "local-alias",
    parallelism: 1,
    controllers: ["agent:runner"],
    scope: {
      actions: ["follow", "like", "collect", "comment", "dm"],
      targets: { kind: "fingerprint", values: ["target-a", "target-b"] },
      totalCount: 1,
      perTargetCount: 1,
      frequency: { count: 1, windowSeconds: 3600 },
    },
    validity: { expiresAt: "2099-07-29T16:00:00Z" },
    policy: { publish: "confirm", delete: "confirm" },
    ...overrides,
  };
}

function setup(path) {
  const state = new StateStore({ dbPath: path });
  const missions = new MissionRuntime({ state });
  const runs = new DeviceRunRuntime({ state, missions, authorityNodeId: AUTHORITY });
  state.upsertNode({ nodeId: AUTHORITY, authority: true });
  state.upsertDevice({
    alias: "01",
    physicalLabel: "rack-01",
    nodeId: AUTHORITY,
    runtimeId: "private-runtime-01",
    routingProfile: { enabled: true, tags: ["slot:01"], capabilityIds: [] },
  });
  const { mission } = missions.createMission(missionInput());
  const run = runs.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:runner" });
  return { state, mission, run };
}

test("beginEffect atomically reserves not_sent work; only the send boundary persists effect_started", () => {
  const root = mkdtempSync(join(tmpdir(), "effect-ledger-"));
  const { state, mission, run } = setup(join(root, "control.db"));
  try {
    const ledger = new EffectLedger({ state });
    const first = ledger.beginEffect({
      mission,
      deviceRunId: run.deviceRunId,
      action: "follow",
      target: "target-a",
      intent: { surface: "social-effect" },
      idempotencyKey: "follow-target-a",
    });
    assert.equal(first.status, "not_sent");
    assert.equal(first.reservation.total, 1);
    assert.equal(state.listMissionEffects(mission.missionId)[0].status, "not_sent");
    assert.equal(ledger.startEffectForExecution(first.effectId).status, "started");
    assert.throws(() => ledger.beginEffect({
      mission,
      deviceRunId: run.deviceRunId,
      action: "follow",
      target: "target-b",
      intent: { surface: "social-effect" },
      idempotencyKey: "follow-target-b",
    }), { code: "BUDGET_EXCEEDED" });
    assert.equal(state.listMissionEffects(mission.missionId).length, 1);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ambiguous consumes and blocks retry; notSent keeps a reservation until explicit abandon", () => {
  const root = mkdtempSync(join(tmpdir(), "effect-ledger-"));
  const { state, mission, run } = setup(join(root, "control.db"));
  try {
    const ledger = new EffectLedger({ state });
    const started = ledger.beginEffect({
      mission, deviceRunId: run.deviceRunId, action: "follow", target: "target-a",
      intent: { surface: "social-effect" }, idempotencyKey: "ambiguous-target-a",
    });
    const ambiguous = ledger.recordOutcome(started.effectId, { status: "ambiguous", evidenceRefs: ["evidence-hash"] });
    assert.equal(ambiguous.reservationConsumed, true);
    assert.throws(() => ledger.beginEffect({
      mission, deviceRunId: run.deviceRunId, action: "follow", target: "target-a",
      intent: { surface: "social-effect" }, idempotencyKey: "ambiguous-target-a-retry",
    }), { code: "AMBIGUOUS_NO_RETRY" });

    state.releaseSession(run.sessionId, run.token);
    const secondMission = new MissionRuntime({ state }).createMission(missionInput({
      idempotencyKey: "ledger-not-sent", account: "second-local-alias",
    })).mission;
    const secondRun = new DeviceRunRuntime({ state, missions: new MissionRuntime({ state }), authorityNodeId: AUTHORITY })
      .openDeviceRun({ missionId: secondMission.missionId, controllerAgent: "agent:runner" });
    const notSent = ledger.beginEffect({
      mission: secondMission, deviceRunId: secondRun.deviceRunId, action: "follow", target: "target-a",
      intent: { surface: "social-effect" }, idempotencyKey: "not-sent-target-a",
    });
    ledger.recordOutcome(notSent.effectId, { status: "not_sent" });
    assert.equal(ledger.retryNotSent(notSent.effectId, { rechecked: true }).reservationRetained, true);
    ledger.recordOutcome(notSent.effectId, { status: "not_sent" });
    assert.equal(ledger.abandonNotSent(notSent.effectId).reservationReleased, true);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart recovery makes started reserved effects terminal ambiguous without replay", () => {
  const root = mkdtempSync(join(tmpdir(), "effect-ledger-"));
  const path = join(root, "control.db");
  let state;
  try {
    const fixture = setup(path);
    state = fixture.state;
    const started = new EffectLedger({ state }).beginEffect({
      mission: fixture.mission, deviceRunId: fixture.run.deviceRunId, action: "follow", target: "target-a",
      intent: { surface: "social-effect" }, idempotencyKey: "restart-target-a",
    });
    new EffectLedger({ state }).startEffectForExecution(started.effectId);
    state.close();
    state = new StateStore({ dbPath: path });
    const recovered = state.listMissionEffects(fixture.mission.missionId).find((effect) => effect.effectId === started.effectId);
    assert.equal(recovered.status, "ambiguous");
    assert.equal(recovered.retryBlocked, true);
    assert.equal(recovered.reservationConsumed, true);
    assert.ok(state.listMissionEvents(fixture.mission.missionId).some((event) => event.type === "effect.recovered_ambiguous"));
  } finally {
    try { state?.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("beginEffect never persists raw private text, target identity, tokens, or unredacted snapshots", () => {
  const root = mkdtempSync(join(tmpdir(), "effect-ledger-"));
  const { state, mission, run } = setup(join(root, "control.db"));
  try {
    const ledger = new EffectLedger({ state });
    ledger.beginEffect({
      mission, deviceRunId: run.deviceRunId, action: "follow", target: "target-a",
      intent: {
        surface: "social-effect",
        effectAction: "follow",
        pageFingerprint: "page-hash-aaa",
        runtimeId: "private-runtime-xyz",
        token: "private-token-xyz",
        serial: "device-serial-xyz",
        authorization: "bearer-secret-xyz",
        rawText: "用户的真实昵称",
        snapshot: { pageText: "敏感页面文本", token: "private-token-xyz" },
      },
      idempotencyKey: "redact-intent",
    });
    const rows = state.db.prepare("SELECT * FROM mission_effects WHERE mission_id=?").all(mission.missionId);
    const blob = JSON.stringify(rows);
    // the bound target is already a fingerprint; raw credentials, runtime IDs, serials,
    // and unredacted snapshot text must never reach the durable ledger.
    assert.doesNotMatch(blob, /private-runtime-xyz|private-token-xyz|device-serial-xyz|bearer-secret-xyz|用户的真实昵称|敏感页面文本/);
    const effects = state.listMissionEffects(mission.missionId);
    const publicBlob = JSON.stringify(effects);
    assert.doesNotMatch(publicBlob, /private-runtime-xyz|private-token-xyz|device-serial-xyz|bearer-secret-xyz|用户的真实昵称|敏感页面文本/);
    // only the allowlisted, redacted intent summary is persisted
    assert.deepEqual(effects[0].intent, { surface: "social-effect", effectAction: "follow", pageFingerprint: "page-hash-aaa" });
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── REX Phase 5 §8.4 (P5b): count/frequency budget 软预算 ─────────────────────────
// plan B3 line 828-829：count/frequency/expiry 软预算。nonpayment_v1 下 totalCount/perTarget/
// frequency 预算耗尽不再抛 BUDGET_*，而是继续预留 + debtSink 记 budget_debt；legacy 恒抛。
test("REX P5b: nonpayment_v1 ledger soft-fences an exhausted budget with budget debt; legacy still throws", () => {
  const root = mkdtempSync(join(tmpdir(), "effect-ledger-budget-soft-"));
  const { state, mission, run } = setup(join(root, "control.db"));
  const debt = [];
  try {
    const nonpayLedger = new EffectLedger({ state, policyMode: { active: true }, debtSink: (entry) => debt.push(entry) });
    const first = nonpayLedger.beginEffect({ mission, deviceRunId: run.deviceRunId, action: "follow", target: "target-a", intent: { surface: "social-effect" }, idempotencyKey: "nonpay-budget-1" });
    assert.equal(first.status, "not_sent");
    // totalCount=1 is now exhausted; nonpayment reserves past the budget and records budget debt
    const over = nonpayLedger.beginEffect({ mission, deviceRunId: run.deviceRunId, action: "follow", target: "target-b", intent: { surface: "social-effect" }, idempotencyKey: "nonpay-budget-2" });
    assert.ok(over.effectId);
    assert.equal(debt.length, 1);
    assert.equal(debt[0].kind, "budget_debt");
    assert.equal(debt[0].code, "BUDGET_EXCEEDED");

    // legacy ledger on the same state still throws — fail-closed unchanged
    const legacyLedger = new EffectLedger({ state });
    assert.throws(() => legacyLedger.beginEffect({ mission, deviceRunId: run.deviceRunId, action: "follow", target: "target-a", intent: { surface: "social-effect" }, idempotencyKey: "legacy-budget-3" }), { code: "BUDGET_EXCEEDED" });
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
