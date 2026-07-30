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

function setupControl({ acquireTransportLock } = {}) {
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
  assert.equal(firewall.classify({ declaredIntent: "tap", snapshot: freshSurface("publish"), observedTargetFingerprint: boundTarget }, mission).decision, "ecp");
  assert.equal(firewall.classify({ declaredIntent: "tap", snapshot: freshSurface("delete"), observedTargetFingerprint: boundTarget }, mission).decision, "phc");
  assert.equal(firewall.classify({ declaredIntent: "tap", snapshot: freshSurface("risk-control"), observedTargetFingerprint: boundTarget }, mission).decision, "blocked");
  assert.equal(firewall.classify({ declaredIntent: "tap", snapshot: freshSurface("captcha"), observedTargetFingerprint: boundTarget }, mission).decision, "blocked");

  // out-of-scope target on a social surface is a scope violation, never an approval
  assert.equal(firewall.classify({ declaredIntent: "tap", snapshot: freshSurface("social-effect", { effectAction: "follow" }), observedTargetFingerprint: "other" }, mission).code, "SCOPE_VIOLATION");
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
