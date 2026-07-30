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
  const capabilities = CapabilityRegistry.load(new URL("../apps", import.meta.url).pathname);
  state.syncCapabilities(capabilities);
  state.upsertNode({ nodeId: AUTHORITY, authority: true });
  const device = state.upsertDevice({ alias: "01", physicalLabel: "rack-01", nodeId: AUTHORITY, runtimeId: "private-01", routingProfile: { enabled: true, tags: ["slot:01"], capabilityIds: ["xhs.observe.feed"] } });
  const grant = { grantId: "grant-receipt", issuanceNonce: "nonce-receipt", app: "xhs", accountFingerprint: "account-fingerprint", controllers: ["agent:runner"], authorization: { primitives: [], socialActions: ["follow"], missionOnlyActions: [], prohibitedActions: [] }, targets: { mode: "explicit_fingerprints", values: ["target-a"] }, budget: { maxima: { totalCount: 1, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } }, defaults: { totalCount: 1, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } } }, validity: { expiresAt: null } };
  state.issueDelegationGrant({ grant, grantHash: "grant-receipt-hash", proofHash: "proof", issuerSubject: "user:a1234", issuerKeyId: "test", allowlistVersion: 1 });
  const missions = new MissionRuntime({ state });
  const { mission } = missions.createMission({ issuer: { actorId: "user:a1234" }, idempotencyKey: "receipt-mission", app: "xhs", account: "account-fingerprint", parallelism: 1, controllers: ["agent:runner"], scope: { actions: ["follow"], targets: { kind: "fingerprint", values: ["target-a"] }, totalCount: 1, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } }, validity: { expiresAt: "2099-07-29T16:00:00Z" }, policy: { publish: "confirm", delete: "confirm" } }, { parentGrantId: grant.grantId, parentGrantHash: "grant-receipt-hash" });
  const run = new DeviceRunRuntime({ state, missions, authorityNodeId: AUTHORITY }).openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:runner" });
  const evidence = state.recordEvidence({ jobId: null, runId: run.deviceRunId, kind: "parser-observation", path: "evidence/receipt.json", sha256: "a".repeat(64), bytes: 1 });
  return { capabilities, device, grant, mission, run, evidence };
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

test("caller fields cannot mint an explicit receipt without server-owned job lineage", () => {
  const root = mkdtempSync(join(tmpdir(), "explicit-receipt-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  try {
    const { grant, mission, run, evidence } = liveFixture(state);
    assert.throws(() => state.recordExplicitObservationReceipt({
      grantId: grant.grantId, grantHash: "grant-receipt-hash", missionId: mission.missionId, deviceRunId: run.deviceRunId,
      leaseId: run.leaseId, sessionId: run.sessionId, controllerEpoch: run.controllerEpoch,
      app: "xhs", accountFingerprint: "account-fingerprint", pageFingerprint: "page-fingerprint", targetFingerprint: "target-a",
      observedAt: new Date().toISOString(), evidenceId: evidence.evidenceId, evidenceHash: evidence.sha256,
    }), { code: "EXPLICIT_RECEIPT_INVALID" });
    assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM explicit_observation_receipts").get().count, 0);
  } finally { state.close(); rmSync(root, { recursive: true, force: true }); }
});

test("control-plane rejects caller-declared producer and raw observation fields", () => {
  const root = mkdtempSync(join(tmpdir(), "explicit-receipt-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  try {
    const { mission, run, evidence } = liveFixture(state);
    const control = new ControlPlane({ state, capabilities: new CapabilityRegistry([]), adapters: new AdapterRegistry([]), evidence: { findByIdAndHash() {} }, authorityNodeId: AUTHORITY, leaseHeartbeatMs: 5000, leaseTtlMs: 60000, schedulerIntervalMs: 100 });
    assert.throws(() => control.recordExplicitObservationReceipt({ tuple: run.tuple, parserReceipt: { producer: "xhs.observe.feed", pageFingerprint: "page", targetFingerprint: "target-a", observedAt: new Date().toISOString(), evidenceId: evidence.evidenceId, evidenceHash: evidence.sha256 } }), { code: "EXPLICIT_RECEIPT_PROVENANCE_REQUIRED" });
    assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM explicit_observation_receipts").get().count, 0);
  } finally { state.close(); rmSync(root, { recursive: true, force: true }); }
});

test("only an allowlisted succeeded parser job can mint a tuple-bound receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "explicit-receipt-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  try {
    const fixture = liveFixture(state);
    const sourceJob = state.createJob({
      idempotencyKey: "receipt-source-job", actorId: "agent:runner", authorityNodeId: AUTHORITY,
      deviceId: fixture.device.deviceId, capability: fixture.capabilities.require("xhs.observe.feed"),
      params: {}, sessionId: fixture.run.sessionId, status: "succeeded",
    }).job;
    const sourceEvidence = state.recordEvidence({
      jobId: sourceJob.jobId, runId: sourceJob.runId, kind: "parser-observation",
      path: "evidence/source-receipt.json", sha256: "b".repeat(64), bytes: 1,
    });
    assert.throws(() => state.recordExplicitObservationReceipt({
      grantId: fixture.grant.grantId, grantHash: "grant-receipt-hash", missionId: fixture.mission.missionId,
      deviceRunId: fixture.run.deviceRunId, leaseId: fixture.run.leaseId, sessionId: fixture.run.sessionId,
      controllerEpoch: fixture.run.controllerEpoch, app: "xhs", accountFingerprint: "account-fingerprint",
      pageFingerprint: "page-fingerprint", targetFingerprint: "target-a", observedAt: new Date().toISOString(),
      evidenceId: sourceEvidence.evidenceId, evidenceHash: sourceEvidence.sha256, sourceJobId: sourceJob.jobId,
      sourceRunId: sourceJob.runId, sourceAdapterId: "forged-adapter", sourceCapabilityId: sourceJob.capabilityId,
    }), { code: "EXPLICIT_RECEIPT_BINDING_MISMATCH" });
    const adapter = {
      id: "xhs", async execute() {},
      getExplicitObservationReceipt({ job, receiptId }) {
        if (job.jobId !== sourceJob.jobId || receiptId !== "sealed-receipt") return null;
        return { pageFingerprint: "page-fingerprint", targetFingerprint: "target-a", observedAt: new Date().toISOString(), evidenceId: sourceEvidence.evidenceId, evidenceHash: sourceEvidence.sha256 };
      },
    };
    let evidenceLookups = 0;
    const control = new ControlPlane({ state, capabilities: fixture.capabilities, adapters: new AdapterRegistry([adapter]), evidence: { findByIdAndHash(evidenceId, evidenceHash) { evidenceLookups += 1; assert.equal(evidenceId, sourceEvidence.evidenceId); assert.equal(evidenceHash, sourceEvidence.sha256); return sourceEvidence; } }, authorityNodeId: AUTHORITY, leaseHeartbeatMs: 5000, leaseTtlMs: 60000, schedulerIntervalMs: 100 });
    const recorded = control.recordExplicitObservationReceipt({ tuple: fixture.run.tuple, sourceJobId: sourceJob.jobId, adapterReceiptId: "sealed-receipt" });
    assert.equal(recorded.status, "recorded");
    assert.equal(evidenceLookups, 1);
    assert.deepEqual(state.getExplicitObservationReceipt(recorded.receiptId).sourceJobId, sourceJob.jobId);
  } finally { state.close(); rmSync(root, { recursive: true, force: true }); }
});
