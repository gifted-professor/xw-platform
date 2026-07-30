import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DeviceRunRuntime } from "../control-plane/lib/device-run.mjs";
import { MissionRuntime } from "../control-plane/lib/mission-runtime.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";
import { AdapterRegistry, ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";

const AUTHORITY = "DESKTOP-3I1EVHE";

function liveFixture(state) {
  state.upsertNode({ nodeId: AUTHORITY, authority: true });
  state.upsertDevice({ alias: "01", physicalLabel: "rack-01", nodeId: AUTHORITY, runtimeId: "private-01", routingProfile: { enabled: true, tags: ["slot:01"], capabilityIds: [] } });
  const grant = { grantId: "grant-receipt", issuanceNonce: "nonce-receipt", app: "xhs", accountFingerprint: "account-fingerprint", controllers: ["agent:runner"], authorization: { primitives: [], socialActions: ["follow"], missionOnlyActions: [], prohibitedActions: [] }, targets: { mode: "explicit_fingerprints", values: ["target-a"] }, budget: { maxima: { totalCount: 1, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } }, defaults: { totalCount: 1, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } } }, validity: { expiresAt: null } };
  state.issueDelegationGrant({ grant, grantHash: "grant-receipt-hash", proofHash: "proof", issuerSubject: "user:a1234", issuerKeyId: "test", allowlistVersion: 1 });
  const missions = new MissionRuntime({ state });
  const { mission } = missions.createMission({ issuer: { actorId: "user:a1234" }, idempotencyKey: "receipt-mission", app: "xhs", account: "account-fingerprint", parallelism: 1, controllers: ["agent:runner"], scope: { actions: ["follow"], targets: { kind: "fingerprint", values: ["target-a"] }, totalCount: 1, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } }, validity: { expiresAt: "2099-07-29T16:00:00Z" }, policy: { publish: "confirm", delete: "confirm" } }, { parentGrantId: grant.grantId, parentGrantHash: "grant-receipt-hash" });
  const run = new DeviceRunRuntime({ state, missions, authorityNodeId: AUTHORITY }).openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:runner" });
  const evidence = state.recordEvidence({ jobId: null, runId: run.deviceRunId, kind: "parser-observation", path: "evidence/receipt.json", sha256: "a".repeat(64), bytes: 1 });
  return { grant, mission, run, evidence };
}

test("server-owned explicit observation receipts bind the control tuple and reject stale observations", () => {
  const root = mkdtempSync(join(tmpdir(), "explicit-receipt-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  try {
    const receipt = state.recordExplicitObservationReceipt({
      grantId: "grant-receipt", grantHash: "grant-receipt-hash", missionId: "mission-receipt", deviceRunId: "run-receipt",
      leaseId: "lease-receipt", sessionId: "session-receipt", controllerEpoch: 1,
      app: "xhs", accountFingerprint: "account-fingerprint", pageFingerprint: "page-fingerprint", targetFingerprint: "target-a",
      observedAt: new Date(Date.now() - 5001).toISOString(), serverReceivedAt: new Date().toISOString(),
      evidenceId: "evidence-receipt", evidenceHash: "a".repeat(64),
    });
    assert.equal(receipt.status, "rejected_stale");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh receipt is bound to one exact live tuple and cannot replay", () => {
  const root = mkdtempSync(join(tmpdir(), "explicit-receipt-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  try {
    const { grant, mission, run, evidence } = liveFixture(state);
    const receipt = state.recordExplicitObservationReceipt({
      grantId: grant.grantId, grantHash: "grant-receipt-hash", missionId: mission.missionId, deviceRunId: run.deviceRunId,
      leaseId: run.leaseId, sessionId: run.sessionId, controllerEpoch: run.controllerEpoch,
      app: "xhs", accountFingerprint: "account-fingerprint", pageFingerprint: "page-fingerprint", targetFingerprint: "target-a",
      observedAt: new Date().toISOString(), evidenceId: evidence.evidenceId, evidenceHash: evidence.sha256,
    });
    assert.equal(receipt.status, "recorded");
    assert.throws(() => state.consumeExplicitObservationReceipt({ receiptId: receipt.receiptId, missionId: mission.missionId, deviceRunId: run.deviceRunId, leaseId: run.leaseId, sessionId: run.sessionId, controllerEpoch: run.controllerEpoch, action: "follow", targetFingerprint: "other-target" }), { code: "EXPLICIT_RECEIPT_INVALID" });
    assert.equal(state.consumeExplicitObservationReceipt({ receiptId: receipt.receiptId, missionId: mission.missionId, deviceRunId: run.deviceRunId, leaseId: run.leaseId, sessionId: run.sessionId, controllerEpoch: run.controllerEpoch, action: "follow", targetFingerprint: "target-a" }).receiptId, receipt.receiptId);
    assert.throws(() => state.consumeExplicitObservationReceipt({ receiptId: receipt.receiptId, missionId: mission.missionId, deviceRunId: run.deviceRunId, leaseId: run.leaseId, sessionId: run.sessionId, controllerEpoch: run.controllerEpoch, action: "follow", targetFingerprint: "target-a" }), { code: "EXPLICIT_RECEIPT_INVALID" });
  } finally { state.close(); rmSync(root, { recursive: true, force: true }); }
});

test("only the control-plane allowlisted parser can mint the server-owned receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "explicit-receipt-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  try {
    const { mission, run, evidence } = liveFixture(state);
    const control = new ControlPlane({ state, capabilities: new CapabilityRegistry([]), adapters: new AdapterRegistry([]), evidence: { findByIdAndHash() {} }, authorityNodeId: AUTHORITY, leaseHeartbeatMs: 5000, leaseTtlMs: 60000, schedulerIntervalMs: 100 });
    assert.throws(() => control.recordExplicitObservationReceipt({ tuple: run.tuple, parserReceipt: { producer: "xhs.observe.feed", pageFingerprint: "page", targetFingerprint: "target-a", observedAt: new Date().toISOString(), evidenceId: evidence.evidenceId, evidenceHash: evidence.sha256 } }), { code: "EXPLICIT_RECEIPT_PRODUCER_INVALID" });
    const receipt = control.recordExplicitObservationReceipt({ tuple: run.tuple, parserReceipt: { producer: "xhs.explicit_observation_parser", pageFingerprint: "page", targetFingerprint: "target-a", observedAt: new Date().toISOString(), evidenceId: evidence.evidenceId, evidenceHash: evidence.sha256, clientGrantId: "forged" } });
    assert.equal(receipt.status, "recorded");
    assert.equal(state.getExplicitObservationReceipt(receipt.receiptId).missionId, mission.missionId);
  } finally { state.close(); rmSync(root, { recursive: true, force: true }); }
});
