import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";

const AUTHORITY = "DESKTOP-3I1EVHE";

function fixture({ adrAccepted = true, discoveryAdrAccepted = true, discoveryAdrPath = undefined } = {}) {
  const root = mkdtempSync(join(tmpdir(), "discovery-control-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  state.upsertNode({ nodeId: AUTHORITY, authority: true });
  state.upsertDevice({
    alias: "01", physicalLabel: "rack-01", nodeId: AUTHORITY, runtimeId: "private-01",
    routingProfile: { enabled: true, tags: ["slot:01"], capabilityIds: [] },
  });
  const grant = {
    grantId: "grant-discovery-control", issuanceNonce: "nonce-discovery-control", grantHash: "hash-grant-discovery-control", status: "active",
    discoveryPolicy: { enabled: true, defaults: { durationMs: 600000, maxPrimitives: 80, maxCandidates: 10 }, maxima: { durationMs: 1800000, maxPrimitives: 300, maxCandidates: 50 }, maxParallelism: 1, targetScope: { anchors: [{ type: "identityFingerprint", hash: "a".repeat(64) }], relationKinds: ["explicit_target"], maxHops: 1 } },
    validity: { expiresAt: null },
  };
  state.issueDelegationGrant({ grant, grantHash: grant.grantHash, proofHash: "proof", issuerSubject: "user:a1234", issuerKeyId: "test", allowlistVersion: 1 });
  const control = new ControlPlane({
    state, capabilities: new CapabilityRegistry([]), authorityNodeId: AUTHORITY, missionAutoApprovalEnabled: true, standingGrantEnabled: true, adrAccepted,
    discoveryIssuerReady: true, discoveryAdrAccepted, discoveryAdrPath,
  });
  return { root, state, grant, control };
}

test("governed DiscoveryRun open, heartbeat, and seal preserve the exact own tuple", () => {
  const f = fixture();
  try {
    const run = f.control.openDiscoveryRun({ grantId: f.grant.grantId, controllerAgent: "agent:runner" });
    assert.equal(run.status, "running");
    assert.equal(f.control.heartbeatDiscoveryRun({ discoveryRunId: run.discoveryRunId, tuple: run.tuple }).status, "running");
    assert.equal(f.control.sealDiscoveryRun({ discoveryRunId: run.discoveryRunId, tuple: run.tuple }).status, "sealed");
    assert.equal(f.control.getDiscoveryRun(run.discoveryRunId).status, "sealed");
  } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("a stale tuple fail-closes and releases its prior allocation before any future open", () => {
  const f = fixture();
  try {
    const run = f.control.openDiscoveryRun({ grantId: f.grant.grantId, controllerAgent: "agent:runner" });
    assert.throws(() => f.control.heartbeatDiscoveryRun({ discoveryRunId: run.discoveryRunId, tuple: { ...run.tuple, controllerEpoch: 0 } }));
    assert.equal(f.control.getDiscoveryRun(run.discoveryRunId).status, "aborted");
    assert.equal(f.state.listDiscoveryRuns().length, 1);
    assert.equal(f.state.listLeases().length, 0);
  } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("DiscoverySession requires separately accepted ADR0010, not the Mission ADR0008 override", () => {
  const f = fixture({ discoveryAdrAccepted: null });
  try {
    assert.throws(() => f.control.openDiscoveryRun({
      grantId: f.grant.grantId, controllerAgent: "agent:runner",
    }), { code: "DISCOVERY_GATE_CLOSED" });
    assert.equal(f.state.listDiscoveryRuns().length, 0);
  } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("DiscoverySession opens only when ADR0008 and ADR0010 are both accepted", () => {
  for (const [adrAccepted, discoveryAdrAccepted, shouldOpen] of [
    [false, false, false], [false, true, false], [true, false, false], [true, true, true],
  ]) {
    const f = fixture({ adrAccepted, discoveryAdrAccepted });
    try {
      if (shouldOpen) {
        assert.equal(f.control.openDiscoveryRun({ grantId: f.grant.grantId, controllerAgent: "agent:runner" }).status, "running");
      } else {
        assert.throws(() => f.control.openDiscoveryRun({ grantId: f.grant.grantId, controllerAgent: "agent:runner" }), { code: "DISCOVERY_GATE_CLOSED" });
      }
      assert.equal(f.state.listDiscoveryRuns().length, shouldOpen ? 1 : 0);
      assert.equal(f.state.listLeases().length, shouldOpen ? 1 : 0);
      assert.equal(f.state.db.prepare("SELECT COUNT(*) AS count FROM discovery_events").get().count, shouldOpen ? 1 : 0);
    } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("flipping either accepted ADR while running commits one typed terminal event", () => {
  for (const override of ["adrAcceptedOverride", "discoveryAdrAcceptedOverride"]) {
    const f = fixture();
    try {
      const run = f.control.openDiscoveryRun({ grantId: f.grant.grantId, controllerAgent: "agent:runner" });
      f.control[override] = false;
      assert.throws(() => f.control.heartbeatDiscoveryRun({ discoveryRunId: run.discoveryRunId, tuple: run.tuple }), { code: "DISCOVERY_GATE_CLOSED" });
      assert.equal(f.control.getDiscoveryRun(run.discoveryRunId).status, "aborted");
      const events = f.state.db.prepare("SELECT payload_json FROM discovery_events WHERE discovery_run_id=? AND type='discovery_run.aborted'").all(run.discoveryRunId);
      assert.equal(events.length, 1);
      assert.equal(JSON.parse(events[0].payload_json).reason, "DISCOVERY_GATE_CLOSED");
    } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("DiscoverySession lazily rereads its dedicated ADR0010 path at each live boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "discovery-adr-"));
  const adrPath = join(root, "0010.md");
  writeFileSync(adrPath, "# ADR 0010\n\n- Status: Proposed\n");
  const f = fixture({ discoveryAdrAccepted: null, discoveryAdrPath: adrPath });
  try {
    assert.throws(() => f.control.openDiscoveryRun({ grantId: f.grant.grantId, controllerAgent: "agent:runner" }), { code: "DISCOVERY_GATE_CLOSED" });
    writeFileSync(adrPath, "# ADR 0010\n\n- Status: Accepted\n");
    const run = f.control.openDiscoveryRun({ grantId: f.grant.grantId, controllerAgent: "agent:runner" });
    writeFileSync(adrPath, "# ADR 0010\n\n- Status: Proposed\n");
    assert.throws(() => f.control.heartbeatDiscoveryRun({ discoveryRunId: run.discoveryRunId, tuple: run.tuple }), { code: "DISCOVERY_GATE_CLOSED" });
    assert.equal(f.control.getDiscoveryRun(run.discoveryRunId).status, "aborted");
  } finally {
    f.state.close(); rmSync(f.root, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
  }
});
