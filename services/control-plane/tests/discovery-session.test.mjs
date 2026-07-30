import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";

const AUTHORITY = "DESKTOP-3I1EVHE";

function fixture() {
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
    state, capabilities: new CapabilityRegistry([]), authorityNodeId: AUTHORITY, missionAutoApprovalEnabled: true, standingGrantEnabled: true, adrAccepted: true,
    discoveryIssuerReady: true,
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

test("stale tuple and a second lease fail closed without creating another DiscoveryRun", () => {
  const f = fixture();
  try {
    const run = f.control.openDiscoveryRun({ grantId: f.grant.grantId, controllerAgent: "agent:runner" });
    assert.throws(() => f.control.heartbeatDiscoveryRun({ discoveryRunId: run.discoveryRunId, tuple: { ...run.tuple, controllerEpoch: 0 } }));
    assert.throws(() => f.control.openDiscoveryRun({ grantId: f.grant.grantId, controllerAgent: "agent:runner" }), { code: "DEVICE_BUSY" });
    assert.equal(f.state.listDiscoveryRuns().length, 1);
    assert.equal(f.state.listLeases().length, 1);
  } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
});
