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
  standingGrantAdrAccepted = true,
  capabilities = [r2Capability()],
  effectIntentSchema = undefined,
  policyMode = null,
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
  const adapterCalls = [];
  const control = new ControlPlane({
    state,
    capabilities: registry,
    adapters: new AdapterRegistry([{
      id: "stub",
      async execute(input) { adapterCalls.push(input); return {}; },
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
    standingGrantAdrAccepted,
    effectIntentSchema,
    policyMode,
    acquireTransportLock: () => Promise.resolve(() => {}),
  });
  control.start();
  return {
    root,
    state,
    registry,
    control,
    adapterCalls,
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
      primitives: ["screenshot"], socialActions: ["follow"], missionOnlyActions: [], prohibitedActions: ["payment", "publish"],
    },
    targets: { mode: "explicit_fingerprints", values: ["target-hash-aaa"] },
    budget: {
      maxima: { totalCount: 2, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } },
      defaults: { totalCount: 1, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } },
    },
    discoveryPolicy: {
      enabled: true,
      allowedPrimitives: ["screenshot"],
      defaults: { durationMs: 600000, maxPrimitives: 80, maxCandidates: 10 },
      maxima: { durationMs: 1800000, maxPrimitives: 300, maxCandidates: 50 },
      maxParallelism: 1,
      targetScope: { anchors: [{ type: "identityFingerprint", hash: "a".repeat(64) }], relationKinds: ["explicit_target"], maxHops: 1 },
      identityPolicy: { stableUserId: "preferred", fallback: "exact_nickname_avatar_profile_fingerprint", onAmbiguity: "stop" },
      clocks: { snapshotFreshnessMs: 5000, observationCompileWindowMs: 60000 },
      retention: { rawScreenshotDays: 7, redactedHashAuditDays: 90 },
      accessPolicy: { ownerSubjectHash: "b".repeat(64), reviewerAllowlistVersion: 1 },
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

test("explicit-target child allocation requires all four independent Standing Grant gates", () => {
  const combinations = [
    { missionAutoApprovalEnabled: false, standingGrantEnabled: true, adrAccepted: true, standingGrantAdrAccepted: true, running: false },
    { missionAutoApprovalEnabled: true, standingGrantEnabled: false, adrAccepted: true, standingGrantAdrAccepted: true, running: false },
    { missionAutoApprovalEnabled: true, standingGrantEnabled: true, adrAccepted: false, standingGrantAdrAccepted: true, running: false },
    { missionAutoApprovalEnabled: true, standingGrantEnabled: true, adrAccepted: true, standingGrantAdrAccepted: false, running: false },
    { missionAutoApprovalEnabled: true, standingGrantEnabled: true, adrAccepted: true, standingGrantAdrAccepted: true, running: true },
  ];
  for (const [index, gates] of combinations.entries()) {
    const f = setup(gates);
    try {
      const grant = persistStandingGrant(f.state, { ...standingGrant(), grantId: `grant-explicit-four-gate-${index}`, issuanceNonce: `nonce-explicit-four-gate-${index}` });
      const result = f.control.submitMission({
        actor: "agent:runner", parentGrantId: grant.grantId, idempotencyKey: `explicit-four-gate-${index}`,
        policy: { ...socialPolicy, account: grant.accountFingerprint },
      });
      assert.equal(result.status, gates.running ? "running" : "blocked");
      assert.equal(f.state.listDeviceRuns({ missionId: result.mission.missionId }).length, gates.running ? 1 : 0);
      assert.equal(f.state.listLeases().length, gates.running ? 1 : 0);
      assert.equal(f.state.db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, gates.running ? 1 : 0);
      assert.equal(f.state.db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, 0);
      assert.equal(f.state.listMissionEffects(result.mission.missionId).length, 0);
      assert.equal(f.adapterCalls.length, 0);
    } finally { f.close(); }
  }
});

test("an accepted ADR0009 is read lazily while the Standing Grant flag still fails closed", () => {
  const f = setup({ missionAutoApprovalEnabled: true, standingGrantEnabled: false, adrAccepted: true, standingGrantAdrAccepted: null });
  try {
    const grant = persistStandingGrant(f.state, { ...standingGrant(), grantId: "grant-adr0009-proposed", issuanceNonce: "nonce-adr0009-proposed" });
    const result = f.control.submitMission({
      actor: "agent:runner", parentGrantId: grant.grantId, idempotencyKey: "adr0009-proposed",
      policy: { ...socialPolicy, account: grant.accountFingerprint },
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "STANDING_GRANT_NOT_ENABLED");
    assert.equal(f.state.listDeviceRuns({ missionId: result.mission.missionId }).length, 0);
    assert.equal(f.state.listLeases().length, 0);
  } finally { f.close(); }
});

test("a grant child is subset-compiled from immutable parent scope and only runs with both flags", () => {
  const f = setup({ missionAutoApprovalEnabled: true, standingGrantEnabled: true, adrAccepted: true });
  try {
    const grant = persistStandingGrant(f.state);
    const policy = { ...socialPolicy, account: grant.accountFingerprint };
    const result = f.control.submitMission({ actor: "agent:runner", parentGrantId: grant.grantId, idempotencyKey: "grant-child-on", policy });
    assert.equal(result.status, "running");
    assert.equal(result.mission.parentGrantId, grant.grantId);
    assert.equal(result.mission.parentGrantHash, `hash-${grant.grantId}`);
    assert.equal(result.mission.issuer.actorId, "user:a1234");
    assert.deepEqual(result.mission.scope.targets, { kind: "fingerprint", values: grant.targets.values });
    assert.equal(result.mission.parallelism, 1);
    assert.equal(result.mission.scope.totalCount, grant.budget.defaults.totalCount);
    assert.equal(result.mission.scope.perTargetCount, grant.budget.defaults.perTargetCount);
    assert.deepEqual(result.mission.scope.frequency, grant.budget.defaults.frequency);
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
    assert.throws(() => f.control.submitMission({ actor: "agent:runner", parentGrantId: grant.grantId, idempotencyKey: "grant-child-parallel", policy: { ...policy, parallelism: 2 } }), { code: "PARALLELISM_UNSUPPORTED" });
    assert.throws(() => f.control.submitMission({ actor: "agent:runner", parentGrantId: grant.grantId, idempotencyKey: "grant-child-client-issuer", policy: { ...policy, issuer: { actorId: "human:spoof" } } }), { code: "CLIENT_ISSUER_FORBIDDEN" });
    f.state.revokeDelegationGrant(grant.grantId, { reason: "test" });
    assert.throws(() => f.control.submitMission({ actor: "agent:runner", parentGrantId: grant.grantId, idempotencyKey: "grant-child-revoked", policy }), { code: "PARENT_GRANT_INACTIVE" });
  } finally {
    f.close();
  }
});

test("an explicit Grant target list remains authoritative over a submitted DiscoveryPolicy targetScope", () => {
  const f = setup({ missionAutoApprovalEnabled: true, standingGrantEnabled: true, adrAccepted: true, standingGrantAdrAccepted: true });
  try {
    const grant = persistStandingGrant(f.state, { ...standingGrant(), grantId: "grant-explicit-authority", issuanceNonce: "nonce-explicit-authority" });
    const result = f.control.submitMission({
      actor: "agent:runner", parentGrantId: grant.grantId, idempotencyKey: "explicit-authority",
      policy: {
        ...socialPolicy,
        account: grant.accountFingerprint,
        declaredTarget: { kind: "fingerprint", values: ["client-declared-target"] },
        discoveryPolicy: { targetScope: { anchors: [{ type: "identityFingerprint", hash: "c".repeat(64) }], relationKinds: ["search_result"] } },
      },
    });
    assert.equal(result.status, "running");
    assert.deepEqual(result.mission.scope.targets, { kind: "fingerprint", values: grant.targets.values });
    assert.equal(result.mission.parentGrantId, grant.grantId);
    assert.equal(result.mission.parentGrantHash, `hash-${grant.grantId}`);
    assert.equal(result.mission.parallelism, 1);
    assert.equal(Object.hasOwn(result.mission, "declaredTarget"), false);
    assert.equal(Object.hasOwn(result.mission, "discoveryPolicy"), false);
    const storedPolicy = JSON.parse(f.state.db.prepare("SELECT policy_json FROM missions WHERE mission_id=?").get(result.mission.missionId).policy_json);
    assert.equal(Object.hasOwn(storedPolicy, "declaredTarget"), false);
    assert.equal(Object.hasOwn(storedPolicy, "discoveryPolicy"), false);
  } finally { f.close(); }
});

test("verified discovery requires a control-plane-authored observation before Mission allocation and ECP rechecks it", async () => {
  const f = setup({ missionAutoApprovalEnabled: true, standingGrantEnabled: true, adrAccepted: true });
  try {
    const grant = persistStandingGrant(f.state, {
      ...standingGrant(),
      grantId: "grant_discovery_test_001",
      issuanceNonce: "nonce_discovery_test_001",
      targets: { mode: "verified_discovery" },
    });
    const provenance = {
      snapshotHash: "snapshot-authoritative-001",
      observedAt: new Date().toISOString(),
      accountFingerprint: grant.accountFingerprint,
      pageFingerprint: "page-authoritative-001",
      observedTargetFingerprint: "target-authoritative-001",
      identityEvidenceHash: "identity-authoritative-001",
    };
    const child = {
      ...socialPolicy,
      account: grant.accountFingerprint,
      scope: { ...socialPolicy.scope, targets: { kind: "verified_discovery", provenance } },
    };
    assert.throws(
      () => f.control.submitMission({ actor: "agent:runner", parentGrantId: grant.grantId, idempotencyKey: "discovery-client-claimed", policy: child }),
      { code: "AUTHORITATIVE_OBSERVATION_REQUIRED" },
    );
    assert.equal(f.state.listDeviceRuns().length, 0);
    assert.equal(f.state.listLeases().length, 0);
    assert.equal(f.state.listMissions().length, 0);

    // The table is a private control-plane store; this unit injects the trusted observation
    // directly, while production writes use recordAuthoritativeObservation with a fenced tuple.
    f.state.recordAuthoritativeObservation({ ...provenance, app: grant.app });
    const accepted = f.control.submitMission({ actor: "agent:runner", parentGrantId: grant.grantId, idempotencyKey: "discovery-authoritative", policy: child });
    assert.equal(accepted.status, "running");
    assert.deepEqual(accepted.mission.scope.targets, { kind: "fingerprint", values: [provenance.observedTargetFingerprint] });
    assert.equal(Object.hasOwn(accepted.mission, "verifiedDiscovery"), false);
    const ecp = f.control.createEffectCommitProtocol({
      recheck: async () => ({ readiness: { ready: true, source: "control-plane", fresh: true }, app: "xhs", account: grant.accountFingerprint, targetFingerprint: provenance.observedTargetFingerprint, pageFingerprint: provenance.pageFingerprint, beforeState: "before", control: true }),
      execute: async () => ({ ok: true }), verify: async () => ({ ok: true }), restore: async () => ({ ok: true }),
    });
    const prepared = await ecp.prepare({ mission: accepted.mission, action: "follow", target: provenance.observedTargetFingerprint, tuple: accepted.run.tuple, idempotencyKey: "discovery-ecp-before" });
    assert.equal(prepared.status, "prepared");
    await ecp.cancelPrepared(prepared);
    assert.throws(
      () => f.control.submitMission({
        actor: "agent:runner", parentGrantId: grant.grantId, idempotencyKey: "discovery-wrong-page",
        policy: { ...child, scope: { ...child.scope, targets: { kind: "verified_discovery", provenance: { ...provenance, pageFingerprint: "forged-page" } } } },
      }),
      { code: "AUTHORITATIVE_OBSERVATION_MISMATCH" },
    );
    // Simulate a process reconstruction where the durable observation no longer resolves:
    // ECP must reread authority and block before a second effect reservation or adapter call.
    f.state.db.prepare("DELETE FROM authoritative_observations WHERE snapshot_hash=?").run(provenance.snapshotHash);
    const afterRestart = await ecp.prepare({ mission: accepted.mission, action: "follow", target: provenance.observedTargetFingerprint, tuple: accepted.run.tuple, idempotencyKey: "discovery-ecp-after" });
    assert.deepEqual(afterRestart, { status: "blocked", code: "AUTHORITATIVE_OBSERVATION_REQUIRED" });
  } finally {
    f.close();
  }
});

test("every parent-grant flag/ADR denial is zero-allocation and legacy R2 stays manual", () => {
  for (const gates of [
    { missionAutoApprovalEnabled: false, standingGrantEnabled: true, adrAccepted: true },
    { missionAutoApprovalEnabled: true, standingGrantEnabled: false, adrAccepted: true },
    { missionAutoApprovalEnabled: false, standingGrantEnabled: false, adrAccepted: true },
    { missionAutoApprovalEnabled: true, standingGrantEnabled: true, adrAccepted: false },
  ]) {
    const f = setup(gates);
    try {
      const grant = persistStandingGrant(f.state, { ...standingGrant(), grantId: `grant-gate-${JSON.stringify(gates)}`, issuanceNonce: `nonce-gate-${JSON.stringify(gates)}` });
      const blocked = f.control.submitMission({ actor: "agent:runner", parentGrantId: grant.grantId, idempotencyKey: `blocked-${JSON.stringify(gates)}`, policy: { ...socialPolicy, account: grant.accountFingerprint } });
      assert.equal(blocked.status, "blocked");
      assert.equal(f.state.listDeviceRuns({ missionId: blocked.mission.missionId }).length, 0);
      assert.equal(f.state.listLeases().length, 0);
      assert.equal(f.state.listMissionEffects(blocked.mission.missionId).length, 0);
      assert.equal(f.state.db.prepare("SELECT COUNT(*) AS c FROM approvals").get().c, 0);
      const legacy = f.control.submitJob({ idempotencyKey: `legacy-${JSON.stringify(gates)}`, actorId: "agent:r2", capabilityId: "xhs.follow.r2", params: {} });
      assert.equal(legacy.job.status, "waiting_approval");
    } finally {
      f.close();
    }
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

// REX Phase 5 §8.2 B9 反转：nonpayment_v1 active（fake adapter）下，同一非支付 R2
// follow job 不再 waiting_approval——非支付一律自由。legacy 闸作为 fallback 保留上方测试。
// liveness：job 进 queued（dispatch 队列）+ adapter 实际被调用（无审批门阻挡执行）。
test("nonpayment_v1: a non-Mission R2 follow job is free and dispatches without approval", async () => {
  const f = setup({ policyMode: { active: true, mode: "nonpayment_v1", effectiveDecisionSource: "deployed-runtime" } });
  try {
    const created = f.control.submitJob({
      idempotencyKey: "freedom-r2-01",
      actorId: "agent-a",
      capabilityId: "xhs.follow.r2",
      params: {},
    });
    assert.equal(created.job.approvalRequired, false, "nonpayment_v1: non-payment R2 follow must not require approval");
    assert.notEqual(created.job.status, "waiting_approval", "nonpayment_v1: must not wait for approval");
    assert.equal(created.job.externalEffect, true, "externalEffect stays as a fact");
    // liveness：等 pump 把 queued job 跑到 adapter（无审批门阻挡 dispatch）
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(f.adapterCalls.length >= 1, "nonpayment_v1: adapter executed without approval gate");
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
