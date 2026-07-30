import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { StateStore } from "../control-plane/lib/state-store.mjs";

const AUTHORITY = "DESKTOP-3I1EVHE";

function grant(grantId = "grant-discovery-state") {
  return {
    grantId,
    issuanceNonce: `nonce-${grantId}`,
    grantHash: `hash-${grantId}`,
    status: "active",
    discoveryPolicy: {
      enabled: true,
      defaults: { durationMs: 600000, maxPrimitives: 80, maxCandidates: 10 },
      maxima: { durationMs: 1800000, maxPrimitives: 300, maxCandidates: 50 },
      maxParallelism: 1,
      targetScope: { anchors: [{ type: "identityFingerprint", hash: "a".repeat(64) }], relationKinds: ["explicit_target"], maxHops: 1 },
    },
    validity: { expiresAt: null },
  };
}

function setup({ policyEnabled = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "discovery-state-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  state.upsertNode({ nodeId: AUTHORITY, authority: true });
  const device = state.upsertDevice({
    alias: "01", physicalLabel: "rack-01", nodeId: AUTHORITY, runtimeId: "private-01",
    routingProfile: { enabled: true, tags: ["slot:01"], capabilityIds: [] },
  });
  const item = grant();
  item.discoveryPolicy.enabled = policyEnabled;
  state.issueDelegationGrant({
    grant: item, grantHash: item.grantHash, proofHash: "proof", issuerSubject: "user:a1234", issuerKeyId: "test", allowlistVersion: 1,
  });
  return { root, state, device, grant: item };
}

function openInput(fixture, overrides = {}) {
  return {
    grantId: fixture.grant.grantId,
    grantHash: fixture.grant.grantHash,
    controllerAgent: "agent:runner",
    authorityNodeId: AUTHORITY,
    gates: { missionAutoApprovalEnabled: true, standingGrantEnabled: true, adr0008Accepted: true, adr0010Accepted: true, issuerReady: true },
    ...overrides,
  };
}

test("v7 migrates additively to v8 discovery storage and open is one fenced allocation", () => {
  const f = setup();
  try {
    assert.equal(f.state.db.prepare("PRAGMA user_version").get().user_version, 11);
    assert.equal(f.state.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='standing_grant_canaries'").get().name, "standing_grant_canaries");
    assert.equal(f.state.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='discovery_runs'").get().name, "discovery_runs");
    const run = f.state.openDiscoveryRunStorage(openInput(f));
    assert.equal(run.status, "running");
    assert.equal(run.deviceId, f.device.deviceId);
    assert.equal(run.controllerEpoch, 1);
    assert.equal(f.state.listLeases().length, 1);
    assert.equal(f.state.listDiscoveryRuns().length, 1);
    assert.deepEqual(run.tuple, {
      discoveryRunId: run.discoveryRunId,
      sessionId: run.sessionId,
      controllerAgent: "agent:runner",
      controllerEpoch: 1,
    });
  } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("closed gate, disabled policy, grant drift, and a second open leave zero new allocation", () => {
  for (const mutation of [
    { gates: { missionAutoApprovalEnabled: false, standingGrantEnabled: true, adr0008Accepted: true, adr0010Accepted: true, issuerReady: true } },
    { gates: { missionAutoApprovalEnabled: true, standingGrantEnabled: false, adr0008Accepted: true, adr0010Accepted: true, issuerReady: true } },
    { gates: { missionAutoApprovalEnabled: true, standingGrantEnabled: true, adr0008Accepted: false, adr0010Accepted: true, issuerReady: true } },
    { gates: { missionAutoApprovalEnabled: true, standingGrantEnabled: true, adr0008Accepted: true, adr0010Accepted: false, issuerReady: true } },
    { gates: { missionAutoApprovalEnabled: true, standingGrantEnabled: true, adr0008Accepted: true, adr0010Accepted: true, issuerReady: false } },
    { grantHash: "drifted" },
  ]) {
    const f = setup();
    try {
      assert.throws(() => f.state.openDiscoveryRunStorage(openInput(f, mutation)));
      assert.equal(f.state.listLeases().length, 0);
      assert.equal(f.state.listDiscoveryRuns().length, 0);
    } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
  }
  const f = setup({ policyEnabled: false });
  try {
    assert.throws(() => f.state.openDiscoveryRunStorage(openInput(f)), { code: "DISCOVERY_POLICY_DISABLED" });
    assert.equal(f.state.listLeases().length, 0);
    assert.equal(f.state.listDiscoveryRuns().length, 0);
  } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
  const active = setup();
  try {
    active.state.openDiscoveryRunStorage(openInput(active));
    assert.throws(() => active.state.openDiscoveryRunStorage(openInput(active)), { code: "DISCOVERY_GRANT_ACTIVE" });
    assert.equal(active.state.listDiscoveryRuns().length, 1);
  } finally { active.state.close(); rmSync(active.root, { recursive: true, force: true }); }
});

test("sealed DiscoveryRun releases its own session and lease durably without resurrection", () => {
  const f = setup();
  try {
    const run = f.state.openDiscoveryRunStorage(openInput(f));
    const sealed = f.state.sealDiscoveryRunStorage({ discoveryRunId: run.discoveryRunId, tuple: run.tuple, gates: openInput(f).gates });
    assert.equal(sealed.status, "sealed");
    assert.ok(sealed.releaseAt);
    assert.equal(f.state.listLeases().length, 0);
    assert.throws(() => f.state.validateSession(run.sessionId, run.token), { code: "SESSION_NOT_FOUND" });
    assert.equal(f.state.getDiscoveryRun(run.discoveryRunId).status, "sealed");
  } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("injected open fault rolls the one BEGIN IMMEDIATE allocation back to zero live rows", () => {
  const f = setup();
  try {
    for (const faultAfter of ["afterLease", "afterSession", "afterRun"]) {
      assert.throws(() => f.state.openDiscoveryRunStorage(openInput(f, { faultAfter })), { code: "DISCOVERY_OPEN_FAULT" });
      assert.equal(f.state.listLeases().length, 0);
      assert.equal(f.state.listDiscoveryRuns().length, 0);
      assert.equal(f.state.db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
    }
  } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("restart converts active DiscoveryRun to recovery_required and releases its tuple", () => {
  const f = setup();
  const path = join(f.root, "control.db");
  try {
    const run = f.state.openDiscoveryRunStorage(openInput(f));
    f.state.close();
    const reopened = new StateStore({ dbPath: path });
    try {
      assert.equal(reopened.getDiscoveryRun(run.discoveryRunId).status, "recovery_required");
      assert.equal(reopened.listLeases().length, 0);
    } finally { reopened.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a live Grant revocation aborts the current DiscoveryRun and releases only its own tuple", () => {
  const f = setup();
  try {
    const run = f.state.openDiscoveryRunStorage(openInput(f));
    f.state.revokeDelegationGrant(f.grant.grantId);
    assert.throws(() => f.state.heartbeatDiscoveryRunStorage({
      discoveryRunId: run.discoveryRunId, tuple: run.tuple,
      gates: openInput(f).gates,
    }), { code: "GRANT_NOT_ACTIVE" });
    assert.equal(f.state.getDiscoveryRun(run.discoveryRunId).status, "aborted");
    assert.equal(f.state.db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
    assert.equal(f.state.listLeases().length, 0);
    assert.equal(f.state.db.prepare("SELECT COUNT(*) AS count FROM discovery_events WHERE discovery_run_id=? AND type='discovery_run.aborted'").get(run.discoveryRunId).count, 1);
  } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("a foreign replacement lease is never deleted when the own tuple is lost", () => {
  const f = setup();
  try {
    const run = f.state.openDiscoveryRunStorage(openInput(f));
    f.state.db.prepare("UPDATE leases SET owner_discovery_run_id='foreign-run', holder_id='agent:foreign' WHERE lease_id=?").run(run.leaseId);
    assert.throws(() => f.state.abortDiscoveryRunStorage({
      discoveryRunId: run.discoveryRunId, tuple: run.tuple, gates: openInput(f).gates,
    }), { code: "DISCOVERY_CONTROL_LOST" });
    assert.equal(f.state.getDiscoveryRun(run.discoveryRunId).status, "recovery_required");
    assert.equal(f.state.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE session_id=?").get(run.sessionId).count, 0);
    assert.equal(f.state.db.prepare("SELECT owner_discovery_run_id FROM leases WHERE lease_id=?").get(run.leaseId).owner_discovery_run_id, "foreign-run");
  } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("one Grant cannot hold DiscoveryRuns on two canonical devices at once", () => {
  const f = setup();
  try {
    f.state.upsertDevice({
      alias: "02", physicalLabel: "rack-02", nodeId: AUTHORITY, runtimeId: "private-02",
      routingProfile: { enabled: true, tags: ["slot:02"], capabilityIds: [] },
    });
    const first = f.state.openDiscoveryRunStorage(openInput(f));
    assert.throws(() => f.state.openDiscoveryRunStorage(openInput(f, { placement: { physicalLabel: "rack-02" } })), { code: "DISCOVERY_GRANT_ACTIVE" });
    assert.equal(f.state.getDiscoveryRun(first.discoveryRunId).status, "running");
    assert.equal(f.state.listLeases().length, 1);
  } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("missing, expired, or sessionless own tuples fail closed with durable cleanup", () => {
  for (const mutation of ["missingLease", "expiredLease", "missingSession"]) {
    const f = setup();
    try {
      const run = f.state.openDiscoveryRunStorage(openInput(f));
      if (mutation === "missingLease") f.state.db.prepare("DELETE FROM leases WHERE lease_id=?").run(run.leaseId);
      if (mutation === "expiredLease") f.state.db.prepare("UPDATE leases SET expires_at=0 WHERE lease_id=?").run(run.leaseId);
      if (mutation === "missingSession") f.state.db.prepare("DELETE FROM sessions WHERE session_id=?").run(run.sessionId);
      assert.throws(() => f.state.heartbeatDiscoveryRunStorage({ discoveryRunId: run.discoveryRunId, tuple: run.tuple, gates: openInput(f).gates }), { code: "DISCOVERY_CONTROL_LOST" });
      assert.equal(f.state.getDiscoveryRun(run.discoveryRunId).status, "recovery_required");
      assert.equal(f.state.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE session_id=?").get(run.sessionId).count, 0);
      assert.equal(f.state.db.prepare("SELECT COUNT(*) AS count FROM leases WHERE lease_id=? AND owner_discovery_run_id=?").get(run.leaseId, run.discoveryRunId).count, 0);
    } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("every live boundary rechecks gates, canonical readiness, and policy before terminal cleanup", () => {
  for (const boundary of ["heartbeat", "seal", "abort"]) {
    for (const mutation of ["gate", "readiness", "policy", "grantHash"]) {
      const f = setup();
      try {
        const run = f.state.openDiscoveryRunStorage(openInput(f));
        let gates = openInput(f).gates;
        if (mutation === "gate") gates = { ...gates, issuerReady: false };
        if (mutation === "readiness") f.state.db.prepare("UPDATE devices SET online=0 WHERE device_id=?").run(run.deviceId);
        if (mutation === "policy") {
          const changed = { ...f.grant, discoveryPolicy: { ...f.grant.discoveryPolicy, enabled: false } };
          f.state.db.prepare("UPDATE delegation_grants SET grant_json=? WHERE grant_id=?").run(JSON.stringify(changed), f.grant.grantId);
        }
        if (mutation === "grantHash") f.state.db.prepare("UPDATE delegation_grants SET grant_hash='drifted-live' WHERE grant_id=?").run(f.grant.grantId);
        const input = { discoveryRunId: run.discoveryRunId, tuple: run.tuple, gates };
        const method = boundary === "heartbeat" ? "heartbeatDiscoveryRunStorage"
          : boundary === "seal" ? "sealDiscoveryRunStorage" : "abortDiscoveryRunStorage";
        assert.throws(() => f.state[method](input));
        assert.ok(["aborted", "recovery_required"].includes(f.state.getDiscoveryRun(run.discoveryRunId).status));
        assert.equal(f.state.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE session_id=?").get(run.sessionId).count, 0);
        assert.equal(f.state.listLeases().length, 0);
      } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
    }
  }
});

test("terminal CAS emits one release event and late boundaries cannot resurrect a DiscoveryRun", () => {
  const f = setup();
  try {
    const run = f.state.openDiscoveryRunStorage(openInput(f));
    assert.equal(f.state.sealDiscoveryRunStorage({ discoveryRunId: run.discoveryRunId, tuple: run.tuple, gates: openInput(f).gates }).status, "sealed");
    assert.throws(() => f.state.abortDiscoveryRunStorage({ discoveryRunId: run.discoveryRunId, tuple: run.tuple, gates: openInput(f).gates }), { code: "DISCOVERY_RUN_NOT_ACTIVE" });
    assert.equal(f.state.getDiscoveryRun(run.discoveryRunId).status, "sealed");
    assert.equal(f.state.db.prepare("SELECT COUNT(*) AS count FROM discovery_events WHERE discovery_run_id=? AND type IN ('discovery_run.sealed', 'discovery_run.aborted', 'discovery_run.recovery_required')").get(run.discoveryRunId).count, 1);
  } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("every live authority loss records exactly one typed durable terminal event at every boundary", () => {
  const cases = [
    ["revoke", (f) => f.state.revokeDelegationGrant(f.grant.grantId), "GRANT_NOT_ACTIVE"],
    ["gate", (_f, input) => { input.gates.adr0010Accepted = false; }, "DISCOVERY_GATE_CLOSED"],
    ["ready", (f, _input, run) => f.state.db.prepare("UPDATE devices SET online=0 WHERE device_id=?").run(run.deviceId), "DISCOVERY_READINESS_LOST"],
    ["policy", (f) => f.state.db.prepare("UPDATE delegation_grants SET grant_json=? WHERE grant_id=?").run(JSON.stringify({ ...f.grant, discoveryPolicy: { ...f.grant.discoveryPolicy, enabled: false } }), f.grant.grantId), "DISCOVERY_POLICY_DISABLED"],
    ["hash", (f) => f.state.db.prepare("UPDATE delegation_grants SET grant_hash='live-drift' WHERE grant_id=?").run(f.grant.grantId), "GRANT_HASH_DRIFT"],
    ["foreignLease", (f, _input, run) => f.state.db.prepare("UPDATE leases SET owner_discovery_run_id='foreign-run' WHERE lease_id=?").run(run.leaseId), "DISCOVERY_CONTROL_LOST"],
    ["missingLease", (f, _input, run) => f.state.db.prepare("DELETE FROM leases WHERE lease_id=?").run(run.leaseId), "DISCOVERY_CONTROL_LOST"],
    ["expiredLease", (f, _input, run) => f.state.db.prepare("UPDATE leases SET expires_at=0 WHERE lease_id=?").run(run.leaseId), "DISCOVERY_CONTROL_LOST"],
    ["sessionless", (f, _input, run) => f.state.db.prepare("DELETE FROM sessions WHERE session_id=?").run(run.sessionId), "DISCOVERY_CONTROL_LOST"],
    ["epochMismatch", (_f, input) => { input.tuple.controllerEpoch = 0; }, "DISCOVERY_TUPLE_MISMATCH"],
  ];
  const methods = ["heartbeatDiscoveryRunStorage", "sealDiscoveryRunStorage", "abortDiscoveryRunStorage"];
  for (const method of methods) {
    for (const [_name, mutate, code] of cases) {
      const f = setup();
      try {
        const run = f.state.openDiscoveryRunStorage(openInput(f));
        const input = { discoveryRunId: run.discoveryRunId, tuple: { ...run.tuple }, gates: { ...openInput(f).gates } };
        mutate(f, input, run);
        assert.throws(() => f.state[method](input), { code });
        const events = f.state.db.prepare(`
          SELECT type, payload_json FROM discovery_events
          WHERE discovery_run_id=? AND type IN ('discovery_run.aborted', 'discovery_run.recovery_required')
        `).all(run.discoveryRunId);
        assert.equal(events.length, 1);
        assert.equal(JSON.parse(events[0].payload_json).reason, code);
      } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
    }
  }
});
