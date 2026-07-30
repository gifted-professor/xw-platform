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
    gates: { missionAutoApprovalEnabled: true, standingGrantEnabled: true, adrAccepted: true, issuerReady: true },
    ...overrides,
  };
}

test("v7 migrates additively to v8 discovery storage and open is one fenced allocation", () => {
  const f = setup();
  try {
    assert.equal(f.state.db.prepare("PRAGMA user_version").get().user_version, 8);
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
    { gates: { missionAutoApprovalEnabled: false, standingGrantEnabled: true, adrAccepted: true, issuerReady: true } },
    { gates: { missionAutoApprovalEnabled: true, standingGrantEnabled: false, adrAccepted: true, issuerReady: true } },
    { gates: { missionAutoApprovalEnabled: true, standingGrantEnabled: true, adrAccepted: false, issuerReady: true } },
    { gates: { missionAutoApprovalEnabled: true, standingGrantEnabled: true, adrAccepted: true, issuerReady: false } },
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
    assert.throws(() => active.state.openDiscoveryRunStorage(openInput(active)), { code: "DEVICE_BUSY" });
    assert.equal(active.state.listDiscoveryRuns().length, 1);
  } finally { active.state.close(); rmSync(active.root, { recursive: true, force: true }); }
});

test("sealed DiscoveryRun releases its own session and lease durably without resurrection", () => {
  const f = setup();
  try {
    const run = f.state.openDiscoveryRunStorage(openInput(f));
    const sealed = f.state.sealDiscoveryRunStorage({ discoveryRunId: run.discoveryRunId, tuple: run.tuple });
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
    assert.throws(() => f.state.openDiscoveryRunStorage(openInput(f, { faultAfter: "afterLease" })), { code: "DISCOVERY_OPEN_FAULT" });
    assert.equal(f.state.listLeases().length, 0);
    assert.equal(f.state.listDiscoveryRuns().length, 0);
    assert.equal(f.state.db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
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
