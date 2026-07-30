import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import { AdapterRegistry, ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { EvidenceStore } from "../control-plane/lib/evidence-store.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";

const AUTHORITY = "DESKTOP-3I1EVHE";

// A legacy R2 capability: external-effect risk keeps the legacy manual per-job gate so a
// non-Mission job stays waiting_approval exactly as before the Mission path existed.
function r2Capability(id = "xhs.follow.r2") {
  return {
    schemaVersion: 1,
    id,
    appId: "xhs",
    packageName: "local.xhs",
    versionRange: "*",
    maturity: "E3",
    risk: "R2",
    resources: ["device"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object" },
    preconditions: [],
    verification: { mode: "state", description: "r2 follow" },
    restoration: { required: false, description: "none" },
    timeoutMs: 1000,
    idempotency: "read_only",
    automationPolicy: { mode: "automatic" },
    implementation: { adapter: "stub", action: "follow" },
    evidence: [],
    availability: "implemented",
  };
}

function setup({
  missionAutoApprovalEnabled = false,
  standingGrantEnabled = false,
  adrAccepted = null,
  capabilities = [r2Capability()],
  effectIntentSchema = undefined,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "mission-cmd-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const registry = new CapabilityRegistry(capabilities);
  state.syncCapabilities(registry);
  state.upsertNode({ nodeId: AUTHORITY, authority: true });
  state.upsertDevice({
    alias: "01",
    physicalLabel: "rack-01",
    nodeId: AUTHORITY,
    runtimeId: "private-01",
    routingProfile: { enabled: true, tags: ["slot:01"], capabilityIds: capabilities.map((c) => c.id) },
  });
  const evidence = new EvidenceStore({
    runsRoot: join(root, "runs"),
    state,
    minFreeBytes: 0,
    minExternalEffectFreeBytes: 0,
  });
  const control = new ControlPlane({
    state,
    capabilities: registry,
    adapters: new AdapterRegistry([{
      id: "stub",
      async execute() { return {}; },
      async verify() { return { ok: true, mode: "state" }; },
      async restore() { return { ok: true }; },
    }]),
    evidence,
    authorityNodeId: AUTHORITY,
    schedulerIntervalMs: 50,
    leaseTtlMs: 60000,
    leaseHeartbeatMs: 5000,
    missionAutoApprovalEnabled,
    standingGrantEnabled,
    adrAccepted,
    effectIntentSchema,
    acquireTransportLock: () => Promise.resolve(() => {}),
  });
  control.start();
  return {
    root,
    state,
    registry,
    control,
    async close() {
      await control.stop();
      state.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const socialPolicy = {
  app: "xhs",
  account: "local-alias",
  parallelism: 1,
  scope: {
    actions: ["follow"],
    targets: { kind: "fingerprint", values: ["target-hash-aaa"] },
    totalCount: 1,
    perTargetCount: 1,
    frequency: { count: 1, windowSeconds: 3600 },
  },
  validity: { expiresAt: "2099-07-29T16:00:00Z" },
};

function standingGrant() {
  return {
    schemaVersion: 1,
    grantId: "grant_control_test_001",
    issuanceNonce: "nonce_control_test_001",
    issuer: { subject: "user:a1234", keyId: "test-key" },
    app: "xhs",
    accountFingerprint: "account-grant-test",
    controllers: ["agent:runner"],
    maxParallelism: 1,
    authorization: {
      primitives: ["screenshot"], socialActions: ["follow"], missionOnlyActions: ["delete"], prohibitedActions: ["payment", "publish"],
    },
    targets: { mode: "explicit_fingerprints", values: ["target-hash-aaa"] },
    budget: {
      maxima: { totalCount: 2, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } },
      defaults: { totalCount: 1, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } },
    },
    validity: { expiresAt: null },
    redaction: { publicFields: ["alias"] },
  };
}

function persistStandingGrant(state, grant = standingGrant()) {
  state.issueDelegationGrant({
    grant,
    grantHash: `hash-${grant.grantId}`,
    proofHash: `proof-${grant.grantId}`,
    issuerSubject: "user:a1234",
    issuerKeyId: "test-key",
    allowlistVersion: 1,
  });
  return grant;
}

test("a valid parent grant records a flag-off child Mission without allocating a run, lease, or effect", () => {
  const f = setup({ missionAutoApprovalEnabled: true, adrAccepted: true });
  try {
    const grant = persistStandingGrant(f.state);
    const result = f.control.submitMission({
      actor: "agent:runner",
      parentGrantId: grant.grantId,
      idempotencyKey: "grant-child-flag-off",
      policy: { ...socialPolicy, account: grant.accountFingerprint },
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "STANDING_GRANT_NOT_ENABLED");
    assert.equal(f.state.listDeviceRuns({ missionId: result.mission.missionId }).length, 0);
    assert.equal(f.state.listLeases().length, 0);
    assert.equal(f.state.listMissionEffects(result.mission.missionId).length, 0);
  } finally {
    f.close();
  }
});

test("a grant child is subset-compiled from immutable parent scope and only runs with both flags", () => {
  const f = setup({ missionAutoApprovalEnabled: true, standingGrantEnabled: true, adrAccepted: true });
  try {
    const grant = persistStandingGrant(f.state);
    const policy = { ...socialPolicy, account: grant.accountFingerprint };
    const result = f.control.submitMission({ actor: "agent:runner", parentGrantId: grant.grantId, idempotencyKey: "grant-child-on", policy });
    assert.equal(result.status, "running");
    assert.equal(result.mission.parentGrantId, grant.grantId);
    assert.equal(result.mission.issuer.actorId, "user:a1234");
    assert.equal(result.mission.scope.totalCount, grant.budget.defaults.totalCount);
    assert.equal(f.state.listDeviceRuns({ missionId: result.mission.missionId }).length, 1);

    const cases = [
      { policy: { ...policy, account: "other-account" } },
      { policy: { ...policy, controllers: ["agent:not-allowed"] } },
      { policy: { ...policy, scope: { ...policy.scope, totalCount: 3 } } },
      { policy: { ...policy, scope: { ...policy.scope, actions: ["payment"] } } },
      { policy: { ...policy, scope: { ...policy.scope, targets: { kind: "fingerprint", values: ["other-target"] } } } },
    ];
    for (const [index, item] of cases.entries()) {
      assert.throws(() => f.control.submitMission({ actor: "agent:runner", parentGrantId: grant.grantId, idempotencyKey: `grant-child-invalid-${index}`, policy: item.policy }), { code: "GRANT_SUBSET_INVALID" });
    }
    assert.throws(() => f.control.submitMission({ actor: "agent:runner", parentGrantId: grant.grantId, idempotencyKey: "grant-child-client-issuer", policy: { ...policy, issuer: { actorId: "human:spoof" } } }), { code: "CLIENT_ISSUER_FORBIDDEN" });
    f.state.revokeDelegationGrant(grant.grantId, { reason: "test" });
    assert.throws(() => f.control.submitMission({ actor: "agent:runner", parentGrantId: grant.grantId, idempotencyKey: "grant-child-revoked", policy }), { code: "PARENT_GRANT_INACTIVE" });
  } finally {
    f.close();
  }
});

function freshSnapshot(surface, extra = {}) {
  const ts = new Date().toISOString();
  return { surface, createdAt: ts, observedAt: ts, ...extra };
}

// Minimal PHC ECP stub for the payment human-commit assertion: payment is always PHC, so the
// stub prepares a protected effect without touching the real ledger (payment is never a
// scope.actions entry; the real ledger scope-check is exercised separately in Task 4 tests).
function stubPaymentEcp() {
  return {
    async prepare(input) {
      return { status: "prepared", effect: { effectId: `effect-${input.action}` }, rechecked: {}, policy: { decision: "phc" } };
    },
    markWaitingAuthorization(prepared) { return prepared; },
    async executePrepared() { return { status: "verified" }; },
    async restore() { return { ok: true }; },
    async cancelPrepared() { return { status: "cancelled" }; },
  };
}

test("mission submit with the default false flag blocks as ADR_0008_NOT_ACCEPTED before any run, lease, Session, or effect", () => {
  const f = setup(); // flag defaults false; ADR 0008 is not accepted
  try {
    const flagOffRun = f.control.submitMission({
      actor: "human:operator",
      idempotencyKey: "freedom-flag-off-01",
      policy: socialPolicy,
    });
    const missionId = flagOffRun.mission.missionId;
    assert.equal(flagOffRun.status, "blocked");
    assert.equal(flagOffRun.reason, "ADR_0008_NOT_ACCEPTED");
    assert.equal(f.state.listLeases().length, 0);
    assert.equal(f.state.listDeviceRuns({ missionId }).length, 0);
    assert.equal(f.state.listMissionEffects(missionId).length, 0);
    // the Mission itself is still durably created (reusable), only the automatic run is blocked
    assert.equal(flagOffRun.mission.status, "active");
    assert.equal(flagOffRun.approvalRequired, false);
    assert.ok(
      f.state.listMissionEvents(missionId).some((event) => event.type === "mission.submit.blocked"
        && event.payload.code === "ADR_0008_NOT_ACCEPTED"),
    );
    // a second submit with the same key reuses the mission and stays blocked
    const again = f.control.submitMission({
      actor: "human:operator",
      idempotencyKey: "freedom-flag-off-01",
      policy: socialPolicy,
    });
    assert.equal(again.reused, true);
    assert.equal(again.status, "blocked");
  } finally {
    f.close();
  }
});

test("mission submit rejects a client-selected private runtime/device id", () => {
  const f = setup();
  try {
    assert.throws(
      () => f.control.submitMission({
        actor: "human:operator",
        idempotencyKey: "freedom-rt-01",
        policy: { ...socialPolicy, runtimeId: "private-runtime-xyz" },
      }),
      { code: "CLIENT_RUNTIME_FORBIDDEN" },
    );
    assert.throws(
      () => f.control.submitMission({
        actor: "human:operator",
        idempotencyKey: "freedom-rt-02",
        policy: { ...socialPolicy, deviceId: "dev-01" },
      }),
      { code: "CLIENT_RUNTIME_FORBIDDEN" },
    );
    assert.equal(f.state.listLeases().length, 0);
  } finally {
    f.close();
  }
});

test("enabled+ADR-accepted in-scope social Mission auto-runs with no approval; payment waits; firewall blocks create no effect", async () => {
  const f = setup({ missionAutoApprovalEnabled: true, adrAccepted: true });
  try {
    const flagOnSocialRun = f.control.submitMission({
      actor: "human:operator",
      idempotencyKey: "freedom-on-01",
      policy: socialPolicy,
    });
    assert.equal(flagOnSocialRun.approvalRequired, false);
    assert.equal(flagOnSocialRun.status, "running");
    const missionId = flagOnSocialRun.mission.missionId;
    assert.equal(f.state.listDeviceRuns({ missionId }).length, 1);
    assert.equal(f.state.listLeases().length, 1);
    // no whole-Mission or per-job approval row was created for the automatic path
    assert.equal(
      f.state.db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE approval_required=1").get().c,
      0,
    );

    // a blocked firewall verdict records a primitive event but creates no effect row
    const tuple = flagOnSocialRun.run.tuple;
    const blocked = await f.control.executeMissionPrimitive(tuple, {
      primitive: "tap",
      envelope: {
        declaredIntent: "tap",
        snapshot: freshSnapshot("unknown"),
        observedTargetFingerprint: "target-hash-aaa",
      },
    });
    assert.equal(blocked.verdict.decision, "blocked");
    assert.equal(f.state.listMissionEffects(missionId).length, 0);

    // payment always enters the Protected Human Commit, waiting for a real human per commit;
    // the pending commit is durable, not merely in-memory.
    const phc = f.control.createProtectedHumanCommit({ ecp: stubPaymentEcp() });
    const flagOnPaymentRun = await phc.begin({
      mission: flagOnSocialRun.mission,
      action: "payment",
      target: "target-hash-aaa",
      tuple,
    });
    assert.equal(flagOnPaymentRun.status, "waiting_authorization");
    assert.equal(f.state.listProtectedCommits({ missionId }).length, 1);
    assert.ok(
      f.state.listMissionEvents(missionId).some((event) => event.type === "protected_human_commit.waiting_authorization"),
    );
  } finally {
    await f.close();
  }
});

test("an invalid effect-intent envelope is rejected by the runtime schema and creates no effect", async () => {
  const f = setup({ missionAutoApprovalEnabled: true, adrAccepted: true });
  try {
    const run = f.control.submitMission({
      actor: "human:operator",
      idempotencyKey: "freedom-schema-01",
      policy: socialPolicy,
    });
    const tuple = run.run.tuple;
    await assert.rejects(
      () => f.control.executeMissionPrimitive(tuple, {
        primitive: "tap",
        envelope: {
          declaredIntent: "tap",
          snapshot: freshSnapshot("social-effect", { effectAction: "follow" }),
          observedTargetFingerprint: "target-hash-aaa",
          // an unknown top-level key is rejected by additionalProperties:false
          maliciousRuntimeId: "private-runtime-xyz",
        },
      }),
      { code: "ENVELOPE_SCHEMA_INVALID" },
    );
    assert.equal(f.state.listMissionEffects(run.mission.missionId).length, 0);
  } finally {
    await f.close();
  }
});

test("missing or unparseable effect-intent schema fails closed before a Mission primitive runs", async () => {
  const f = setup({ missionAutoApprovalEnabled: true, adrAccepted: true, effectIntentSchema: null });
  try {
    const run = f.control.submitMission({
      actor: "human:operator",
      idempotencyKey: "freedom-schema-unavailable-01",
      policy: socialPolicy,
    });
    await assert.rejects(
      () => f.control.executeMissionPrimitive(run.run.tuple, {
        primitive: "tap",
        envelope: {
          declaredIntent: "tap",
          snapshot: freshSnapshot("social-effect", { effectAction: "follow" }),
          observedTargetFingerprint: "target-hash-aaa",
        },
      }),
      { code: "EFFECT_INTENT_SCHEMA_UNAVAILABLE" },
    );
    assert.equal(f.state.listMissionEffects(run.mission.missionId).length, 0);
    assert.equal(f.state.listMissionEvents(run.mission.missionId).some((event) => event.type === "mission.primitive"), false);
  } finally {
    await f.close();
  }
});

test("mission show/status/revoke report lifecycle and revoke blocks further effects", () => {
  const f = setup({ missionAutoApprovalEnabled: true, adrAccepted: true });
  try {
    const submitted = f.control.submitMission({
      actor: "human:operator",
      idempotencyKey: "freedom-lifecycle-01",
      policy: socialPolicy,
    });
    const missionId = submitted.mission.missionId;

    const shown = f.control.showMission(missionId);
    assert.equal(shown.mission.missionId, missionId);
    assert.equal(shown.deviceRuns.length, 1);
    // the public mission shape is constrained: no private dedup handle or internal redaction
    assert.equal(Object.hasOwn(shown.mission, "idempotencyKey"), false);
    assert.equal(Object.hasOwn(shown.mission, "redaction"), false);

    const status = f.control.missionStatus(missionId);
    assert.equal(status.status, "active");
    assert.equal(status.deviceRunCount, 1);

    const revoked = f.control.revokeMission(missionId, { actorId: "human:operator", reason: "user-stop" });
    assert.equal(revoked.status, "revoked");
    assert.equal(f.control.missionStatus(missionId).status, "revoked");
    // after revoke, an in-scope effect is blocked, never an approval request
    const decision = f.control.missions.evaluateMissionEffect(
      f.state.getMission(missionId),
      { action: "follow", target: "target-hash-aaa" },
    );
    assert.equal(decision.decision, "blocked");
  } finally {
    f.close();
  }
});

test("a legacy non-Mission R2 job retains its manual waiting_approval gate", () => {
  const f = setup(); // flag off does not affect legacy jobs
  try {
    const created = f.control.submitJob({
      idempotencyKey: "legacy-r2-01",
      actorId: "agent-a",
      capabilityId: "xhs.follow.r2",
      params: {},
    });
    assert.equal(created.job.approvalRequired, true);
    assert.equal(created.job.status, "waiting_approval");
    assert.equal(created.job.externalEffect, true);
  } finally {
    f.close();
  }
});

test("PHC pending commit is durable across a state reconstruct and recovered fail-closed on restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-phc-dur-"));
  const dbPath = join(root, "control.db");
  let state = new StateStore({ dbPath });
  let control = new ControlPlane({
    state,
    capabilities: new CapabilityRegistry([r2Capability()]),
    adapters: new AdapterRegistry([{ id: "stub", async execute() {}, async verify() { return { ok: true }; }, async restore() { return { ok: true }; } }]),
    evidence: new EvidenceStore({ runsRoot: join(root, "runs"), state, minFreeBytes: 0, minExternalEffectFreeBytes: 0 }),
    authorityNodeId: AUTHORITY,
    missionAutoApprovalEnabled: true,
    adrAccepted: true,
    acquireTransportLock: () => Promise.resolve(() => {}),
  });
  state.upsertNode({ nodeId: AUTHORITY, authority: true });
  state.upsertDevice({
    alias: "01", physicalLabel: "rack-01", nodeId: AUTHORITY, runtimeId: "private-01",
    routingProfile: { enabled: true, tags: ["slot:01"], capabilityIds: ["xhs.follow.r2"] },
  });
  try {
    const submitted = control.submitMission({
      actor: "human:operator",
      idempotencyKey: "freedom-phc-dur-01",
      policy: socialPolicy,
    });
    const missionId = submitted.mission.missionId;
    const phc = control.createProtectedHumanCommit({ ecp: stubPaymentEcp() });
    const waiting = await phc.begin({
      mission: submitted.mission,
      action: "payment",
      target: "target-hash-aaa",
      tuple: submitted.run.tuple,
    });
    // the commitId is not merely in-memory: it is durable in protected_commits
    assert.equal(waiting.status, "waiting_authorization");
    assert.equal(state.listProtectedCommits({ missionId }).length, 1);

    // reconstruct the store from disk: the protected commit row survives reconstruct
    await control.stop();
    state.close();
    state = new StateStore({ dbPath });
    assert.equal(state.listProtectedCommits({ missionId }).length, 1);
    // control-plane restart recovery cancels the pending commit fail-closed (control was lost);
    // the waiting commit is no longer decidable and the durable row is retained as audit.
    state.recoverInterruptedWork();
    assert.equal(state.listProtectedCommits({ missionId, status: "waiting_authorization" }).length, 0);
    assert.equal(state.listProtectedCommits({ missionId, status: "recovered_cancelled" }).length, 1);
    const recoveryEvent = state.listMissionEvents(missionId)
      .find((event) => event.type === "protected_human_commit.recovered_cancelled");
    assert.equal(recoveryEvent?.payload.commitId, waiting.commitId);
    assert.equal(recoveryEvent?.payload.effectId, waiting.effectId);
  } finally {
    try { await control.stop(); } catch {}
    try { state.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});
