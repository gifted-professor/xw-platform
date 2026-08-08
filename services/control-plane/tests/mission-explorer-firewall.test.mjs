import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import { AdapterRegistry, ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { EffectFirewall } from "../control-plane/lib/effect-firewall.mjs";
import { EvidenceStore } from "../control-plane/lib/evidence-store.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";

const AUTHORITY = "DESKTOP-3I1EVHE";
const MAX_AGE = 5000;

function nowMs() {
  return Date.now();
}
function freshSurface(surface, extra = {}) {
  const ts = new Date(nowMs()).toISOString();
  return { surface, createdAt: ts, observedAt: ts, ...extra };
}
function staleSurface(surface, extra = {}) {
  const old = new Date(nowMs() - 10 * MAX_AGE).toISOString();
  return { surface, createdAt: old, observedAt: old, ...extra };
}

const missionInput = {
  issuer: { actorId: "human:operator" },
  idempotencyKey: "freedom-explorer-01",
  app: "xhs",
  account: "local-alias",
  parallelism: 1,
  controllers: ["agent:runner"],
  scope: {
    actions: ["follow", "like", "collect", "comment", "dm", "publish", "delete"],
    targets: { kind: "fingerprint", values: ["target-hash-aaa"] },
    totalCount: 5,
    perTargetCount: 1,
    frequency: { count: 1, windowSeconds: 3600 },
  },
  validity: { expiresAt: "2099-07-29T16:00:00Z" },
  policy: { publish: "allow_within_scope", delete: "confirm" },
};

function setupControl({ acquireTransportLock, policyMode } = {}) {
  const root = mkdtempSync(join(tmpdir(), "explorer-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const evidence = new EvidenceStore({
    runsRoot: join(root, "runs"),
    state,
    minFreeBytes: 0,
    minExternalEffectFreeBytes: 0,
  });
  const control = new ControlPlane({
    state,
    capabilities: { capabilities: [] },
    adapters: new AdapterRegistry([]),
    evidence,
    authorityNodeId: AUTHORITY,
    schedulerIntervalMs: 50,
    leaseTtlMs: 60000,
    leaseHeartbeatMs: 5000,
    acquireTransportLock: acquireTransportLock || (() => Promise.resolve(() => {})),
    ...(policyMode ? { policyMode } : {}),
  });
  control.start();
  state.upsertNode({ nodeId: AUTHORITY, authority: true });
  const device = state.upsertDevice({
    alias: "01",
    physicalLabel: "rack-01",
    nodeId: AUTHORITY,
    runtimeId: "private-01",
    routingProfile: { enabled: true, tags: ["slot:01"], capabilityIds: [] },
  });
  const { mission } = control.missions.createMission(missionInput);
  return { root, state, evidence, control, device, mission, async close() {
    await control.stop();
    state.close();
    rmSync(root, { recursive: true, force: true });
  } };
}

test("Effect Firewall lets observed surface win over the agent hint", () => {
  const firewall = new EffectFirewall();
  const mission = { scope: missionInput.scope, policy: { publish: "confirm", delete: "confirm", payment: "confirm" }, validity: missionInput.validity, status: "active" };
  const boundTarget = "target-hash-aaa";

  // declared navigate but the observed surface is publish -> intent/surface mismatch
  assert.equal(firewall.classify({
    declaredIntent: "navigate", snapshot: freshSurface("publish"), target: boundTarget,
  }, mission).code, "INTENT_MISMATCH");

  // stale snapshot is rejected before any effect decision
  assert.equal(firewall.classify({
    declaredIntent: "follow", snapshot: staleSurface("social-effect"), target: boundTarget,
  }, mission).code, "SNAPSHOT_STALE");

  // the agent-claimed target must match the parser-observed fingerprint
  assert.equal(firewall.classify({
    declaredTarget: "agent-claimed", observedTargetFingerprint: "fresh-parser-target",
  }, mission).code, "TARGET_MISMATCH");

  // production unknown surface stops closed
  assert.equal(firewall.classify({
    declaredIntent: "tap", snapshot: freshSurface("unknown"), target: boundTarget,
  }, mission).code, "SURFACE_UNKNOWN");
});

test("Effect Firewall classifies reversible, social, payment, and stop surfaces", () => {
  const firewall = new EffectFirewall();
  const mission = { scope: missionInput.scope, policy: { publish: "allow_within_scope", delete: "confirm", payment: "confirm" }, validity: missionInput.validity, status: "active" };
  const boundTarget = "target-hash-aaa";

  assert.equal(firewall.classify({ declaredIntent: "back", snapshot: freshSurface("navigation"), target: boundTarget }, mission).decision, "auto");
  assert.equal(firewall.classify({ declaredIntent: "screenshot", snapshot: freshSurface("observation"), target: boundTarget }, mission).decision, "auto");
  assert.equal(firewall.classify({ declaredIntent: "tap", snapshot: freshSurface("social-effect", { effectAction: "follow" }), observedTargetFingerprint: boundTarget }, mission).decision, "ecp");
  assert.equal(firewall.classify({ declaredIntent: "tap", snapshot: freshSurface("payment"), observedTargetFingerprint: boundTarget }, mission).decision, "phc");
  assert.equal(firewall.classify({ declaredIntent: "tap", snapshot: freshSurface("publish"), observedTargetFingerprint: boundTarget }, mission).decision, "phc");
  assert.equal(firewall.classify({ declaredIntent: "tap", snapshot: freshSurface("delete"), observedTargetFingerprint: boundTarget }, mission).decision, "phc");
  assert.equal(firewall.classify({ declaredIntent: "tap", snapshot: freshSurface("risk-control"), observedTargetFingerprint: boundTarget }, mission).decision, "blocked");
  assert.equal(firewall.classify({ declaredIntent: "tap", snapshot: freshSurface("captcha"), observedTargetFingerprint: boundTarget }, mission).decision, "blocked");

  // out-of-scope target on a social surface is a scope violation, never an approval
  assert.equal(firewall.classify({ declaredIntent: "tap", snapshot: freshSurface("social-effect", { effectAction: "follow" }), observedTargetFingerprint: "other" }, mission).code, "SCOPE_VIOLATION");
});

test("Effect Firewall splits the four financial surfaces (REX Phase 5 B3 refinement)", () => {
  const firewall = new EffectFirewall();
  const mission = { scope: missionInput.scope, policy: { publish: "allow_within_scope", delete: "confirm", payment: "confirm" }, validity: missionInput.validity, status: "active" };
  const boundTarget = "target-hash-aaa";

  // observe/prepare never move money → reversible auto in every mode
  assert.equal(firewall.classify({ declaredIntent: "tap", snapshot: freshSurface("financial_observe"), observedTargetFingerprint: boundTarget }, mission).decision, "auto");
  assert.equal(firewall.classify({ declaredIntent: "tap", snapshot: freshSurface("financial_prepare"), observedTargetFingerprint: boundTarget }, mission).decision, "auto");

  // commit_candidate pauses only that gesture and re-observes (debt), never PHC
  const candidate = firewall.classify({ declaredIntent: "tap", snapshot: freshSurface("financial_commit_candidate"), observedTargetFingerprint: boundTarget }, mission);
  assert.equal(candidate.decision, "reobserve");
  assert.equal(candidate.debt, true);

  // financial_commit is the sole PHC — identical fail-closed to legacy payment (transport stays 0)
  const commit = firewall.classify({ declaredIntent: "tap", snapshot: freshSurface("financial_commit"), observedTargetFingerprint: boundTarget }, mission);
  assert.equal(commit.decision, "phc");
  assert.equal(commit.code, "PHC_PAYMENT");

  // legacy coarse payment surface stays unchanged
  assert.equal(firewall.classify({ declaredIntent: "tap", snapshot: freshSurface("payment"), observedTargetFingerprint: boundTarget }, mission).decision, "phc");

  // nonpayment_v1 mode keeps financial_commit fail-closed too (never relaxes to reobserve)
  const nonpayment = firewall.classify(
    { declaredIntent: "tap", snapshot: freshSurface("financial_commit"), observedTargetFingerprint: boundTarget },
    mission,
    { policyMode: { active: true } },
  );
  assert.equal(nonpayment.decision, "phc");
});

test("Discovery Firewall is strictly observed-surface R0 and never falls through to Mission decisions", () => {
  const firewall = new EffectFirewall();
  for (const surface of ["social-effect", "publish", "delete", "payment", "profile", "settings", "unknown", "risk-control", "login", "captcha"]) {
    assert.equal(
      firewall.classifyDiscovery({ declaredIntent: "screenshot", snapshot: freshSurface(surface) }).decision,
      "blocked",
      surface,
    );
  }
  assert.equal(
    firewall.classifyDiscovery({ declaredIntent: "screenshot", declaredTarget: "agent", observedTargetFingerprint: "parser", snapshot: freshSurface("observation") }).decision,
    "blocked",
  );
  assert.equal(firewall.classifyDiscovery({ declaredIntent: "screenshot", snapshot: freshSurface("observation") }).decision, "auto");
});

test("Explorer reversible primitives validate the tuple, take the transport lock, and record a primitive event", async () => {
  let lockAcquired = 0;
  const release = () => { lockAcquired -= 1; };
  const acquireTransportLock = async () => { lockAcquired += 1; return release; };
  const fixture = await setupControl({ acquireTransportLock });
  try {
    const run = fixture.control.openDeviceRun({ missionId: fixture.mission.missionId, controllerAgent: "agent:runner" });
    const tuple = run.tuple;
    for (const primitive of ["screenshot", "dump", "launch", "back", "home"]) {
      const result = await fixture.control.executeMissionPrimitive(tuple, {
        primitive,
        envelope: { declaredIntent: primitive, snapshot: freshSurface("navigation"), target: "target-hash-aaa" },
      });
      assert.equal(result.verdict.decision, "auto", `${primitive} should be reversible auto`);
      assert.equal(result.recorded, true);
      assert.equal(lockAcquired, 0, `${primitive} must release the transport lock`);
    }
    const events = fixture.state.listMissionEvents(fixture.mission.missionId);
    assert.ok(events.some((event) => event.type === "mission.primitive" && event.payload.primitive === "screenshot"));
  } finally {
    await fixture.close();
  }
});

test("Explorer tap/swipe/input require the envelope and are dispatched by observed surface", async () => {
  const fixture = await setupControl();
  try {
    const run = fixture.control.openDeviceRun({ missionId: fixture.mission.missionId, controllerAgent: "agent:runner" });
    const tuple = run.tuple;
    const boundTarget = "target-hash-aaa";

    const social = await fixture.control.executeMissionPrimitive(tuple, {
      primitive: "tap",
      envelope: { declaredIntent: "tap", snapshot: freshSurface("social-effect", { effectAction: "follow" }), observedTargetFingerprint: boundTarget },
    });
    assert.equal(social.verdict.decision, "ecp");
    assert.equal(social.verdict.surface, "social-effect");

    const payment = await fixture.control.executeMissionPrimitive(tuple, {
      primitive: "tap",
      envelope: { declaredIntent: "tap", snapshot: freshSurface("payment"), observedTargetFingerprint: boundTarget },
    });
    assert.equal(payment.verdict.decision, "phc");

    const blocked = await fixture.control.executeMissionPrimitive(tuple, {
      primitive: "tap",
      envelope: { declaredIntent: "tap", snapshot: freshSurface("unknown"), observedTargetFingerprint: boundTarget },
    });
    assert.equal(blocked.verdict.decision, "blocked");
    assert.equal(blocked.verdict.code, "SURFACE_UNKNOWN");
  } finally {
    await fixture.close();
  }
});

test("Explorer primitives reject a missing or stale control tuple and never execute", async () => {
  const fixture = await setupControl();
  try {
    const run = fixture.control.openDeviceRun({ missionId: fixture.mission.missionId, controllerAgent: "agent:runner" });
    const tuple = run.tuple;
    await assert.rejects(
      () => fixture.control.executeMissionPrimitive({ ...tuple, sessionId: undefined }, {
        primitive: "screenshot",
        envelope: { declaredIntent: "screenshot", snapshot: freshSurface("navigation"), target: "target-hash-aaa" },
      }),
      { code: "CONTROL_TUPLE_INCOMPLETE" },
    );
    await assert.rejects(
      () => fixture.control.executeMissionPrimitive({ ...tuple, controllerEpoch: 0 }, {
        primitive: "screenshot",
        envelope: { declaredIntent: "screenshot", snapshot: freshSurface("navigation"), target: "target-hash-aaa" },
      }),
      { code: "EPOCH_MISMATCH" },
    );
  } finally {
    await fixture.close();
  }
});

test("Explorer primitives do not require typed action IDs or a Workflow DSL", async () => {
  const fixture = await setupControl();
  try {
    const run = fixture.control.openDeviceRun({ missionId: fixture.mission.missionId, controllerAgent: "agent:runner" });
    const result = await fixture.control.executeMissionPrimitive(run.tuple, {
      primitive: "back",
      envelope: { declaredIntent: "back", snapshot: freshSurface("navigation"), target: "target-hash-aaa" },
    });
    assert.equal(result.verdict.decision, "auto");
    assert.equal(Object.hasOwn(result, "capabilityId"), false);
    assert.equal(Object.hasOwn(result, "actionId"), false);
  } finally {
    await fixture.close();
  }
});

// ── REX Phase 5 §8.4 (P5a): effect-firewall 非支付松绑 ─────────────────────────────
// nonpayment_v1 下 unknown / SNAPSHOT_STALE(有时间戳但过期) / INTENT_MISMATCH 从 hard
// blocked 改为自动重观察（decision:"reobserve" + debt 标记）；legacy 仍 blocked；payment /
// risk-control / login / captcha / publish / delete 仍 fail-closed；unknown 紧邻 payment 上下文
// 仍 fail-closed；SNAPSHOT_MISSING_TIMESTAMP（数据契约违规）不归 debt。
const NONPAY_POLICY = { active: true };
const activeMission = () => ({
  scope: missionInput.scope,
  policy: { publish: "allow_within_scope", delete: "confirm", payment: "confirm" },
  validity: missionInput.validity,
  status: "active",
});
const BOUND = "target-hash-aaa";

test("REX P5a: nonpayment_v1 reobserves unknown surface in non-payment context (debt, not block); legacy stays blocked", () => {
  const firewall = new EffectFirewall();
  const mission = activeMission();
  const v = firewall.classify({
    declaredIntent: "tap", snapshot: freshSurface("unknown"), observedTargetFingerprint: BOUND,
  }, mission, { policyMode: NONPAY_POLICY });
  assert.equal(v.decision, "reobserve");
  assert.equal(v.debt, true);

  // legacy (explicit null) still blocked
  assert.equal(firewall.classify({
    declaredIntent: "tap", snapshot: freshSurface("unknown"), observedTargetFingerprint: BOUND,
  }, mission, { policyMode: null }).decision, "blocked");
  // no policyMode option = legacy
  assert.equal(firewall.classify({
    declaredIntent: "tap", snapshot: freshSurface("unknown"), observedTargetFingerprint: BOUND,
  }, mission).decision, "blocked");
});

test("REX P5a: unknown surface adjacent to payment stays fail-closed under nonpayment_v1", () => {
  const firewall = new EffectFirewall();
  const mission = activeMission();
  // explicit payment-context signal on the snapshot
  assert.equal(firewall.classify({
    declaredIntent: "tap", snapshot: freshSurface("unknown", { paymentContext: true }), observedTargetFingerprint: BOUND,
  }, mission, { policyMode: NONPAY_POLICY }).decision, "blocked");
  // financial keyword in snapshot text near the unknown surface
  assert.equal(firewall.classify({
    declaredIntent: "tap", snapshot: freshSurface("unknown", { text: "立即支付 确认付款" }), observedTargetFingerprint: BOUND,
  }, mission, { policyMode: NONPAY_POLICY }).decision, "blocked");
  // financialSignal flag
  assert.equal(firewall.classify({
    declaredIntent: "tap", snapshot: freshSurface("unknown", { financialSignal: true }), observedTargetFingerprint: BOUND,
  }, mission, { policyMode: NONPAY_POLICY }).decision, "blocked");
});

test("REX P5a: nonpayment_v1 reobserves stale (has timestamps) snapshot; missing-timestamp stays fail-closed", () => {
  const firewall = new EffectFirewall();
  const mission = activeMission();
  // stale but has timestamps -> reobserve + debt
  const vStale = firewall.classify({
    declaredIntent: "follow", snapshot: staleSurface("social-effect"), target: BOUND,
  }, mission, { policyMode: NONPAY_POLICY });
  assert.equal(vStale.decision, "reobserve");
  assert.equal(vStale.debt, true);

  // missing timestamp -> still blocked even under nonpayment_v1 (data contract violation)
  const vMissing = firewall.classify({
    declaredIntent: "follow", snapshot: { surface: "social-effect" }, target: BOUND,
  }, mission, { policyMode: NONPAY_POLICY });
  assert.equal(vMissing.decision, "blocked");
  assert.equal(vMissing.reason, "SNAPSHOT_MISSING_TIMESTAMP");

  // legacy stale -> blocked
  assert.equal(firewall.classify({
    declaredIntent: "follow", snapshot: staleSurface("social-effect"), target: BOUND,
  }, mission, { policyMode: null }).decision, "blocked");
});

test("REX P5a: nonpayment_v1 reobserves intent mismatch (debt, not block); legacy stays blocked", () => {
  const firewall = new EffectFirewall();
  const mission = activeMission();
  const v = firewall.classify({
    declaredIntent: "navigate", snapshot: freshSurface("publish"), target: BOUND,
  }, mission, { policyMode: NONPAY_POLICY });
  assert.equal(v.decision, "reobserve");
  assert.equal(v.debt, true);

  assert.equal(firewall.classify({
    declaredIntent: "navigate", snapshot: freshSurface("publish"), target: BOUND,
  }, mission, { policyMode: null }).decision, "blocked");
});

test("REX P5a: payment/risk-control/login/captcha/publish/delete stay fail-closed under nonpayment_v1", () => {
  const firewall = new EffectFirewall();
  const mission = activeMission();
  assert.equal(firewall.classify({ declaredIntent: "tap", snapshot: freshSurface("payment"), observedTargetFingerprint: BOUND }, mission, { policyMode: NONPAY_POLICY }).decision, "phc");
  assert.equal(firewall.classify({ declaredIntent: "tap", snapshot: freshSurface("publish"), observedTargetFingerprint: BOUND }, mission, { policyMode: NONPAY_POLICY }).decision, "phc");
  assert.equal(firewall.classify({ declaredIntent: "tap", snapshot: freshSurface("delete"), observedTargetFingerprint: BOUND }, mission, { policyMode: NONPAY_POLICY }).decision, "phc");
  for (const s of ["risk-control", "login", "captcha"]) {
    assert.equal(
      firewall.classify({ declaredIntent: "tap", snapshot: freshSurface(s), observedTargetFingerprint: BOUND }, mission, { policyMode: NONPAY_POLICY }).decision,
      "blocked",
      `${s} must stay fail-closed under nonpayment_v1`,
    );
  }
});

test("REX P5a: ControlPlane records evidence debt when a primitive reobserves under nonpayment_v1", async () => {
  const fixture = await setupControl({ policyMode: NONPAY_POLICY });
  try {
    const run = fixture.control.openDeviceRun({ missionId: fixture.mission.missionId, controllerAgent: "agent:runner" });
    const result = await fixture.control.executeMissionPrimitive(run.tuple, {
      primitive: "tap",
      envelope: { declaredIntent: "tap", snapshot: freshSurface("unknown"), observedTargetFingerprint: BOUND },
    });
    assert.equal(result.verdict.decision, "reobserve");
    assert.equal(result.verdict.debt, true);
    assert.ok(fixture.control.evidenceDebt.length >= 1, "ControlPlane must record an evidence_debt entry for the reobserve");
    const entry = fixture.control.evidenceDebt.at(-1);
    assert.equal(entry.kind, "firewall_reobserve");
    assert.ok(entry.code && entry.surface === "unknown");
  } finally {
    await fixture.close();
  }
});

// ── REX Phase 5 §8.4 (P5b): mission-policy 软预算经 firewall/ControlPlane 生效 ────────────
// nonpayment_v1 下出 scope 的非支付 target 在 social-effect 面上 → 软 ecp（不 scope_violation），
// ControlPlane 记 firewall_reobserve debt（reason=TARGET_OUT_OF_SCOPE）；legacy 仍 scope_violation
// 且不记 debt。
test("REX P5b: ControlPlane returns soft ecp + debt when out-of-scope target explored under nonpayment_v1", async () => {
  const fixture = await setupControl({ policyMode: NONPAY_POLICY });
  try {
    const run = fixture.control.openDeviceRun({ missionId: fixture.mission.missionId, controllerAgent: "agent:runner" });
    const result = await fixture.control.executeMissionPrimitive(run.tuple, {
      primitive: "tap",
      envelope: { declaredIntent: "tap", snapshot: freshSurface("social-effect", { effectAction: "follow" }), observedTargetFingerprint: "outside-target" },
    });
    assert.equal(result.verdict.decision, "ecp");
    assert.equal(result.verdict.debt, true);
    assert.equal(result.verdict.code, "ECP_AUTO");
    const entry = fixture.control.evidenceDebt.at(-1);
    assert.equal(entry.kind, "firewall_reobserve");
    assert.equal(entry.reason, "TARGET_OUT_OF_SCOPE");
  } finally {
    await fixture.close();
  }
});

test("REX P5b: legacy ControlPlane still blocks out-of-scope target on social surface with no debt", async () => {
  const fixture = await setupControl();
  try {
    const run = fixture.control.openDeviceRun({ missionId: fixture.mission.missionId, controllerAgent: "agent:runner" });
    const result = await fixture.control.executeMissionPrimitive(run.tuple, {
      primitive: "tap",
      envelope: { declaredIntent: "tap", snapshot: freshSurface("social-effect", { effectAction: "follow" }), observedTargetFingerprint: "outside-target" },
    });
    assert.equal(result.verdict.decision, "scope_violation");
    assert.equal(result.verdict.code, "SCOPE_VIOLATION");
    assert.equal(fixture.control.evidenceDebt.length, 0, "legacy must not record evidence debt");
  } finally {
    await fixture.close();
  }
});

// ── REX Phase 5 §8.4 (P5b): ControlPlane dispatch 越过过期 parent grant（provenance debt）──
// plan B3 line 828：parent grant 过期不阻断非支付 dispatch。nonpayment_v1 下 executeMissionPrimitive
// 不再因 PARENT_GRANT_EXPIRED 抛错，继续 classify 并记 provenance_debt；legacy 仍抛。
test("REX P5b: ControlPlane dispatch proceeds past an expired parent grant under nonpayment_v1 with provenance debt", async () => {
  const fixture = await setupControl({ policyMode: NONPAY_POLICY });
  try {
    const grant = {
      grantId: "explorer-provenance-grant", issuanceNonce: "n1", app: "xhs", accountFingerprint: "local-alias-provenance",
      controllers: ["agent:runner"],
      authorization: { primitives: [], socialActions: ["follow", "like", "collect", "comment", "dm", "publish", "delete"], missionOnlyActions: [], prohibitedActions: [] },
      targets: { mode: "explicit_fingerprints", values: ["target-hash-aaa"] },
      budget: { maxima: { totalCount: 5, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } }, defaults: { totalCount: 5, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } } },
      validity: { expiresAt: new Date(Date.now() - 1000).toISOString() }, // already expired
    };
    fixture.state.issueDelegationGrant({ grant, grantHash: "explorer-provenance-hash", proofHash: "proof", issuerSubject: "user:a1234", issuerKeyId: "test", allowlistVersion: 1 });
    // account differs from the setupControl default mission so missionContentHash → a fresh
    // missionId that truly binds the expired parent grant (identical content would reuse the
    // parent-less default mission and never exercise the grant fence).
    const { mission } = fixture.control.missions.createMission(
      { ...missionInput, idempotencyKey: "freedom-explorer-provenance", account: "local-alias-provenance" },
      { parentGrantId: grant.grantId, parentGrantHash: "explorer-provenance-hash" },
    );
    const run = fixture.control.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:runner" });
    const result = await fixture.control.executeMissionPrimitive(run.tuple, {
      primitive: "tap",
      envelope: { declaredIntent: "tap", snapshot: freshSurface("social-effect", { effectAction: "follow" }), observedTargetFingerprint: BOUND },
    });
    assert.equal(result.verdict.decision, "ecp");
    const entry = fixture.control.evidenceDebt.at(-1);
    assert.equal(entry.kind, "provenance_debt");
    assert.equal(entry.code, "PARENT_GRANT_EXPIRED");
  } finally {
    await fixture.close();
  }
});

test("REX P5b: legacy ControlPlane dispatch still rejects an expired parent grant", async () => {
  const fixture = await setupControl();
  try {
    const grant = {
      grantId: "explorer-provenance-grant-legacy", issuanceNonce: "n2", app: "xhs", accountFingerprint: "local-alias-provenance-legacy",
      controllers: ["agent:runner"],
      authorization: { primitives: [], socialActions: ["follow"], missionOnlyActions: [], prohibitedActions: [] },
      targets: { mode: "explicit_fingerprints", values: ["target-hash-aaa"] },
      budget: { maxima: { totalCount: 5, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } }, defaults: { totalCount: 5, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } } },
      validity: { expiresAt: new Date(Date.now() - 1000).toISOString() },
    };
    fixture.state.issueDelegationGrant({ grant, grantHash: "explorer-provenance-hash-legacy", proofHash: "proof", issuerSubject: "user:a1234", issuerKeyId: "test", allowlistVersion: 1 });
    // distinct account so this mission binds the expired grant rather than reusing the default
    const { mission } = fixture.control.missions.createMission(
      { ...missionInput, idempotencyKey: "freedom-explorer-provenance-legacy", account: "local-alias-provenance-legacy" },
      { parentGrantId: grant.grantId, parentGrantHash: "explorer-provenance-hash-legacy" },
    );
    // legacy fences the expired grant at run-open (DeviceRun.openDeviceRun → requireActiveMission)
    assert.throws(
      () => fixture.control.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:runner" }),
      { code: "PARENT_GRANT_EXPIRED" },
    );
    assert.equal(fixture.control.evidenceDebt.length, 0, "legacy must not record provenance debt");
  } finally {
    await fixture.close();
  }
});
