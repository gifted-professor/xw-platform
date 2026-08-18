import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { EvidenceStore } from "../control-plane/lib/evidence-store.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";

const AUTHORITY = "DESKTOP-3I1EVHE";

function fixture({ adrAccepted = true, discoveryAdrAccepted = true, discoveryAdrPath = undefined, discoveryProducer = undefined } = {}) {
  const root = mkdtempSync(join(tmpdir(), "discovery-control-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  state.upsertNode({ nodeId: AUTHORITY, authority: true });
  state.upsertDevice({
    alias: "01", physicalLabel: "rack-01", nodeId: AUTHORITY, runtimeId: "private-01",
    routingProfile: { enabled: true, tags: ["slot:01"], capabilityIds: [] },
  });
  const grant = {
    grantId: "grant-discovery-control", issuanceNonce: "nonce-discovery-control", grantHash: "hash-grant-discovery-control", status: "active",
    discoveryPolicy: { enabled: true, allowedPrimitives: ["screenshot", "dump", "focus", "launch", "back", "home", "tap", "swipe", "input", "restore"], defaults: { durationMs: 600000, maxPrimitives: 80, maxCandidates: 10 }, maxima: { durationMs: 1800000, maxPrimitives: 300, maxCandidates: 50 }, maxParallelism: 1, targetScope: { anchors: [{ type: "identityFingerprint", hash: "a".repeat(64) }], relationKinds: ["explicit_target"], maxHops: 1 } },
    validity: { expiresAt: null },
  };
  state.issueDelegationGrant({ grant, grantHash: grant.grantHash, proofHash: "proof", issuerSubject: "user:a1234", issuerKeyId: "test", allowlistVersion: 1 });
  const evidence = new EvidenceStore({ runsRoot: join(root, "runs"), state, minFreeBytes: 0, minExternalEffectFreeBytes: 0 });
  const control = new ControlPlane({
    state, evidence, capabilities: new CapabilityRegistry([]), authorityNodeId: AUTHORITY, missionAutoApprovalEnabled: true, standingGrantEnabled: true, adrAccepted,
    discoveryIssuerReady: true, discoveryAdrAccepted, discoveryAdrPath,
    discoveryProducer: discoveryProducer === undefined ? (() => null) : discoveryProducer,
  });
  return { root, state, grant, evidence, control };
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

test("exclusive Discovery primitive requires its own fenced tuple and signed R0 allowlist", () => {
  const f = fixture();
  try {
    const run = f.control.openDiscoveryRun({ grantId: f.grant.grantId, controllerAgent: "agent:runner" });
    const now = new Date().toISOString();
    const prepared = f.control.executeDiscoveryPrimitive({
      discoveryRunId: run.discoveryRunId,
      tuple: run.tuple,
      token: run.token,
      primitive: "screenshot",
      idempotencyKey: "discovery-r0-1",
      envelope: { declaredIntent: "screenshot", snapshot: { surface: "observation", createdAt: now, observedAt: now } },
    });
    assert.equal(prepared.discoveryRunId, run.discoveryRunId);
    assert.equal(prepared.primitive, "screenshot");
    assert.equal(f.state.getDiscoveryRun(run.discoveryRunId).primitiveCount, 1);
  } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("Discovery primitive fails closed when production producer wiring is absent", () => {
  const f = fixture({ discoveryProducer: null });
  try {
    const run = f.control.openDiscoveryRun({ grantId: f.grant.grantId, controllerAgent: "agent:runner" });
    assert.throws(() => f.control.executeDiscoveryPrimitive({
      discoveryRunId: run.discoveryRunId,
      tuple: run.tuple,
      token: run.token,
      primitive: "screenshot",
      idempotencyKey: "missing-producer",
      envelope: { snapshot: { surface: "observation", createdAt: new Date().toISOString(), observedAt: new Date().toISOString() } },
    }), { code: "DISCOVERY_PRODUCER_UNAVAILABLE" });
    assert.equal(f.state.getDiscoveryRun(run.discoveryRunId).primitiveCount, 0);
  } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("an empty bootstrap-owned producer map rejects before a Discovery reservation or job", () => {
  const f = fixture({ discoveryProducer: null });
  try {
    // Bootstrap installs this default empty map while ADR0010 remains unavailable. It must not
    // create durable primitive intent before discovering that no owned producer exists.
    f.control.installDiscoveryProducer();
    const run = f.control.openDiscoveryRun({ grantId: f.grant.grantId, controllerAgent: "agent:runner" });
    assert.throws(
      () => f.control.executeDiscoveryPrimitive({
        discoveryRunId: run.discoveryRunId, tuple: run.tuple, token: run.token,
        primitive: "screenshot", idempotencyKey: "empty-bootstrap-map",
        envelope: { snapshot: { surface: "observation", createdAt: new Date().toISOString(), observedAt: new Date().toISOString() } },
      }),
      { code: "DISCOVERY_PRIMITIVE_UNAVAILABLE" },
    );
    assert.equal(f.state.getDiscoveryRun(run.discoveryRunId).primitiveCount, 0);
    assert.equal(f.state.db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, 0);
  } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("Discovery primitive invokes only its fenced R0 producer once after durable intent", () => {
  let producerCalls = 0;
  let f;
  f = fixture({ discoveryProducer: ({ discoveryRunId, reservationId }) => {
    producerCalls += 1;
    return f.evidence.writeDiscoveryJson({ discoveryRunId, sourceJobId: reservationId, kind: "snapshot", label: "fake-r0", value: { rawPath: "/private/path", token: "private", imageHash: "a".repeat(64) } });
  } });
  try {
    const run = f.control.openDiscoveryRun({ grantId: f.grant.grantId, controllerAgent: "agent:runner" });
    const input = { discoveryRunId: run.discoveryRunId, tuple: run.tuple, token: run.token, primitive: "screenshot", idempotencyKey: "fake-r0-1", envelope: { snapshot: { surface: "observation", createdAt: new Date().toISOString(), observedAt: new Date().toISOString() } } };
    const first = f.control.executeDiscoveryPrimitive(input);
    assert.equal(producerCalls, 1);
    assert.match(first.evidenceId, /^evidence_/);
    assert.equal(f.control.executeDiscoveryPrimitive(input).reused, true);
    assert.equal(producerCalls, 1);
    assert.throws(() => f.control.executeDiscoveryPrimitive({ ...input, envelope: { snapshot: { surface: "navigation", createdAt: new Date().toISOString(), observedAt: new Date().toISOString() } } }), { code: "DISCOVERY_IDEMPOTENCY_CONFLICT" });
    assert.equal(producerCalls, 1);
  } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("authorized exact primitive and candidate retries reuse before exhausted quota checks", () => {
  const f = fixture();
  try {
    const run = f.control.openDiscoveryRun({ grantId: f.grant.grantId, controllerAgent: "agent:runner" });
    const now = new Date().toISOString();
    const primitiveInput = { discoveryRunId: run.discoveryRunId, tuple: run.tuple, token: run.token, primitive: "screenshot", idempotencyKey: "quota-primitive", envelope: { snapshot: { surface: "observation", createdAt: now, observedAt: now } } };
    const primitive = f.control.executeDiscoveryPrimitive(primitiveInput);
    f.state.db.prepare("UPDATE discovery_runs SET max_primitives=primitive_count WHERE discovery_run_id=?").run(run.discoveryRunId);
    assert.equal(f.control.executeDiscoveryPrimitive(primitiveInput).reservationId, primitive.reservationId);
    assert.equal(f.state.getDiscoveryRun(run.discoveryRunId).status, "running");
    assert.throws(() => f.control.executeDiscoveryPrimitive({ ...primitiveInput, envelope: { snapshot: { surface: "navigation", createdAt: now, observedAt: now } } }), { code: "DISCOVERY_IDEMPOTENCY_CONFLICT" });

    const evidence = f.evidence.writeDiscoveryJson({ discoveryRunId: run.discoveryRunId, sourceJobId: primitive.reservationId, kind: "relation", label: "quota", value: { relation: "explicit_target" } });
    const candidate = { discoveryRunId: run.discoveryRunId, tuple: run.tuple, token: run.token, gates: { missionAutoApprovalEnabled: true, standingGrantEnabled: true, adr0008Accepted: true, adr0010Accepted: true, issuerReady: true }, idempotencyKey: "quota-candidate", candidateHash: "b".repeat(64), anchor: { type: "identityFingerprint", hash: "a".repeat(64) }, relationKind: "explicit_target", relationEvidenceId: evidence.evidenceId, relationEvidenceHash: evidence.sha256 };
    const first = f.state.reserveDiscoveryCandidateStorage(candidate);
    f.state.db.prepare("UPDATE discovery_runs SET max_candidates=candidate_count WHERE discovery_run_id=?").run(run.discoveryRunId);
    assert.equal(f.state.reserveDiscoveryCandidateStorage(candidate).reservationId, first.reservationId);
    assert.equal(f.state.getDiscoveryRun(run.discoveryRunId).status, "running");
  } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("Discovery-owned sessions reject the generic job path and failed authority never calls the producer", async () => {
  let producerCalls = 0;
  const f = fixture({ discoveryProducer: () => { producerCalls += 1; return null; } });
  try {
    const run = f.control.openDiscoveryRun({ grantId: f.grant.grantId, controllerAgent: "agent:runner" });
    await assert.rejects(
      () => f.control.executeSessionAction(run.sessionId, run.token, { idempotencyKey: "forbidden-generic", capabilityId: "missing", params: {} }),
      { code: "DISCOVERY_SESSION_EXCLUSIVE" },
    );
    f.control.standingGrantEnabled = false;
    assert.throws(() => f.control.executeDiscoveryPrimitive({ discoveryRunId: run.discoveryRunId, tuple: run.tuple, token: run.token, primitive: "screenshot", idempotencyKey: "closed-gate", envelope: { snapshot: { surface: "observation", createdAt: new Date().toISOString(), observedAt: new Date().toISOString() } } }), { code: "DISCOVERY_GATE_CLOSED" });
    assert.equal(producerCalls, 0);
    assert.equal(f.state.getDiscoveryRun(run.discoveryRunId).status, "aborted");
    assert.equal(f.state.listLeases().length, 0);
  } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("client-declared surface is not authoritative Discovery provenance", () => {
  for (const surface of ["social-effect", "payment", "publish", "delete", "unknown", "risk-control", "login", "captcha"]) {
    const f = fixture();
    try {
      const run = f.control.openDiscoveryRun({ grantId: f.grant.grantId, controllerAgent: "agent:runner" });
      const now = new Date().toISOString();
      const reservation = f.control.executeDiscoveryPrimitive({ discoveryRunId: run.discoveryRunId, tuple: run.tuple, token: run.token, primitive: "screenshot", idempotencyKey: `declared-${surface}`, envelope: { declaredIntent: "screenshot", snapshot: { surface, createdAt: now, observedAt: now } } });
      assert.match(reservation.reservationId, /^discovery_primitive_/);
      assert.equal(f.state.getDiscoveryRun(run.discoveryRunId).primitiveCount, 1);
    } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("Discovery candidate reservation requires a signed one-hop anchor and is idempotent", () => {
  const f = fixture();
  try {
    const run = f.control.openDiscoveryRun({ grantId: f.grant.grantId, controllerAgent: "agent:runner" });
    const primitive = f.control.executeDiscoveryPrimitive({ discoveryRunId: run.discoveryRunId, tuple: run.tuple, token: run.token, primitive: "screenshot", idempotencyKey: "candidate-evidence", envelope: { snapshot: { surface: "observation", createdAt: new Date().toISOString(), observedAt: new Date().toISOString() } } });
    const evidence = f.evidence.writeDiscoveryJson({ discoveryRunId: run.discoveryRunId, sourceJobId: primitive.reservationId, kind: "relation", label: "candidate", value: { relation: "explicit_target" } });
    const input = { discoveryRunId: run.discoveryRunId, tuple: run.tuple, token: run.token, gates: { missionAutoApprovalEnabled: true, standingGrantEnabled: true, adr0008Accepted: true, adr0010Accepted: true, issuerReady: true }, idempotencyKey: "candidate-1", candidateHash: "b".repeat(64), anchor: { type: "identityFingerprint", hash: "a".repeat(64) }, relationKind: "explicit_target", relationEvidenceId: evidence.evidenceId, relationEvidenceHash: evidence.sha256 };
    const result = f.state.reserveDiscoveryCandidateStorage(input);
    assert.equal(result.reused, false);
    assert.equal(f.state.getDiscoveryRun(run.discoveryRunId).candidateCount, 1);
    assert.equal(f.state.reserveDiscoveryCandidateStorage(input).reused, true);
    assert.throws(() => f.state.reserveDiscoveryCandidateStorage({ ...input, idempotencyKey: "candidate-3", relationEvidenceHash: "0".repeat(64) }), { code: "DISCOVERY_RELATION_EVIDENCE_INVALID" });
  } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("Discovery candidate rejects unsigned relation pairing before a second candidate charge", () => {
  const f = fixture();
  try {
    const run = f.control.openDiscoveryRun({ grantId: f.grant.grantId, controllerAgent: "agent:runner" });
    const primitive = f.control.executeDiscoveryPrimitive({ discoveryRunId: run.discoveryRunId, tuple: run.tuple, token: run.token, primitive: "screenshot", idempotencyKey: "invalid-pair-evidence", envelope: { snapshot: { surface: "observation", createdAt: new Date().toISOString(), observedAt: new Date().toISOString() } } });
    const evidence = f.evidence.writeDiscoveryJson({ discoveryRunId: run.discoveryRunId, sourceJobId: primitive.reservationId, kind: "relation", label: "invalid-pair", value: { relation: "search_result" } });
    assert.throws(() => f.state.reserveDiscoveryCandidateStorage({ discoveryRunId: run.discoveryRunId, tuple: run.tuple, token: run.token, gates: { missionAutoApprovalEnabled: true, standingGrantEnabled: true, adr0008Accepted: true, adr0010Accepted: true, issuerReady: true }, idempotencyKey: "invalid-pair", candidateHash: "b".repeat(64), anchor: { type: "identityFingerprint", hash: "a".repeat(64) }, relationKind: "search_result", relationEvidenceId: evidence.evidenceId, relationEvidenceHash: evidence.sha256 }), { code: "DISCOVERY_ANCHOR_RELATION_INVALID" });
    assert.equal(f.state.getDiscoveryRun(run.discoveryRunId).candidateCount, 0);
  } finally { f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("Discovery ingest rejects client-supplied lineage and accepts only opaque producer receipts", () => {
  const f = fixture();
  let closed = false;
  try {
    const run = f.control.openDiscoveryRun({ grantId: f.grant.grantId, controllerAgent: "agent:runner" });
    assert.throws(() => f.control.ingestDiscoveryObservation({ discoveryRunId: run.discoveryRunId, tuple: run.tuple, snapshotHash: "e".repeat(64) }), { code: "DISCOVERY_INGEST_INPUT_INVALID" });
    assert.throws(() => f.control.ingestDiscoveryObservation({ discoveryRunId: run.discoveryRunId, tuple: run.tuple, receiptId: "discovery_receipt_absent" }), { code: "DISCOVERY_RECEIPT_INVALID" });
    assert.equal(f.state.getDiscoveryRun(run.discoveryRunId).status, "aborted");
    assert.equal(f.state.listLeases().length, 0);
    assert.equal(f.state.listDiscoveryEvents(run.discoveryRunId).filter((event) => event.type === "discovery_run.aborted").length, 1);
    f.state.close();
    closed = true;
    const reopened = new StateStore({ dbPath: join(f.root, "control.db") });
    assert.equal(reopened.listDiscoveryEvents(run.discoveryRunId).filter((event) => event.type === "discovery_observation.recorded").length, 0);
    reopened.close();
  } finally { if (!closed) f.state.close(); rmSync(f.root, { recursive: true, force: true }); }
});
