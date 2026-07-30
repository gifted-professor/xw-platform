import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { after, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createXhsAdapter } from "../apps/xhs/adapter.mjs";
import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { AdapterRegistry, ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { EvidenceStore } from "../control-plane/lib/evidence-store.mjs";
import { MissionRuntime } from "../control-plane/lib/mission-runtime.mjs";
import { evaluateCapabilityPolicy } from "../control-plane/lib/policy.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";
import { FastOperator } from "../scripts/fast-operator.mjs";

const capabilities = JSON.parse(readFileSync(new URL("../apps/xhs/capabilities.json", import.meta.url), "utf8")).capabilities;
const collect = capabilities.find((capability) => capability.id === "xhs.collect.standing_grant");
const observeNote = capabilities.find((capability) => capability.id === "xhs.observe.note_detail");

function leaseAuthorization() {
  return { leaseId: "lease-collect", token: "secret-token", deviceId: "device-01" };
}

test("collect standing-grant manifest is R2, governed-only, and rejects ordinary jobs", () => {
  assert.ok(collect, "the only new Batch3 capability must be registered");
  assert.equal(collect.risk, "R2");
  assert.equal(collect.implementation.adapter, "xhs");
  assert.equal(collect.implementation.action, "collectOnOpenNote");
  assert.equal(collect.restoration.required, true);
  assert.throws(
    () => evaluateCapabilityPolicy(collect, { invocation: "job" }),
    { code: "STANDING_GRANT_MISSION_REQUIRED" },
  );
});

test("note-detail receipt producer is a separate automatic read-only R0 capability", () => {
  assert.ok(observeNote, "the receipt producer must be independently callable before collect");
  assert.equal(observeNote.risk, "R0");
  assert.equal(observeNote.idempotency, "read_only");
  assert.equal(observeNote.implementation.adapter, "xhs");
  assert.equal(observeNote.implementation.action, "observeOpenNoteDetail");
  assert.deepEqual(observeNote.inputSchema.required ?? [], []);
  assert.deepEqual(evaluateCapabilityPolicy(observeNote, { invocation: "session" }), {
    approvalRequired: false,
    externalEffect: false,
  });
});

test("note-detail producer derives the target only from the resumed activity intent", async () => {
  const operator = Object.create(FastOperator.prototype);
  operator.currentFocus = async () => ({
    package: "com.xingin.xhs",
    activity: "com.xingin.xhs.note.NoteDetailActivity",
  });
  operator.session = {
    exec: async () => `\nTASK id=418\n  ACTIVITY com.xingin.xhs/.note.NoteDetailActivity\n  Intent { act=android.intent.action.VIEW dat=xhsdiscover://item/64f0123456789abcdef01234?source=canary }\n`,
  };
  const first = await operator.observeOpenNoteDetail();
  const second = await operator.observeOpenNoteDetail();
  assert.equal(first.ok, true);
  assert.match(first.targetFingerprint, /^[a-f0-9]{64}$/);
  assert.match(first.pageFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(first.targetFingerprint, second.targetFingerprint);
  assert.equal(first.pageFingerprint, second.pageFingerprint);
  assert.equal("noteId" in first, false, "raw note identity must not leave the device parser");
});

test("note-detail producer fails closed when the top activity has no stable note locator", async () => {
  const operator = Object.create(FastOperator.prototype);
  operator.currentFocus = async () => ({
    package: "com.xingin.xhs",
    activity: "com.xingin.xhs.note.NoteDetailActivity",
  });
  operator.session = { exec: async () => "ACTIVITY com.xingin.xhs/.note.NoteDetailActivity" };
  const result = await operator.observeOpenNoteDetail();
  assert.deepEqual(result, { ok: false, notSent: true, step: "stableNoteLocatorUnavailable" });
});

test("note-detail producer ignores a stable locator retained only by an older history entry", async () => {
  const operator = Object.create(FastOperator.prototype);
  operator.currentFocus = async () => ({
    package: "com.xingin.xhs",
    activity: "com.xingin.xhs.note.NoteDetailActivity",
  });
  operator.session = {
    exec: async () => `
      * Hist #0: ActivityRecord{top com.xingin.xhs/.note.NoteDetailActivity}
        Intent { act=android.intent.action.MAIN }
      * Hist #1: ActivityRecord{old com.xingin.xhs/.note.NoteDetailActivity}
        Intent { act=android.intent.action.VIEW dat=xhsdiscover://item/64f0123456789abcdef01234 }
    `,
  };
  const result = await operator.observeOpenNoteDetail();
  assert.deepEqual(result, { ok: false, notSent: true, step: "stableNoteLocatorUnavailable" });
});

test("XHS adapter exposes only a sealed note-detail receipt from a succeeded source job", () => {
  const adapter = createXhsAdapter();
  assert.equal(typeof adapter.buildExplicitObservationReceipt, "function");
  assert.equal(typeof adapter.getExplicitObservationReceipt, "function");
  const draft = adapter.buildExplicitObservationReceipt({
    capability: observeNote,
    execution: {
      output: {
        ok: true,
        pageFingerprint: "page-a",
        targetFingerprint: "target-a",
        observedAt: new Date().toISOString(),
      },
    },
  });
  assert.equal(draft.targetFingerprint, "target-a");
  const sealed = {
    receiptId: "sealed-a",
    ...draft,
    evidenceId: "evidence-a",
    evidenceHash: "a".repeat(64),
  };
  assert.deepEqual(adapter.getExplicitObservationReceipt({
    job: { status: "succeeded", result: { explicitObservationReceipt: sealed } },
    receiptId: "sealed-a",
  }), {
    pageFingerprint: sealed.pageFingerprint,
    targetFingerprint: sealed.targetFingerprint,
    observedAt: sealed.observedAt,
    evidenceId: sealed.evidenceId,
    evidenceHash: sealed.evidenceHash,
  });
  assert.equal(adapter.getExplicitObservationReceipt({
    job: { status: "succeeded", result: { explicitObservationReceipt: sealed } },
    receiptId: "forged",
  }), null);
});

test("governed offline chain runs observe job, seals receipt, then ECP collects and restores", async () => {
  const root = mkdtempSync(join(tmpdir(), "xhs-collect-governed-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    requests.push(input.action);
    const result = input.action === "observeOpenNoteDetail"
      ? { ok: true, pageFingerprint: "page-a", targetFingerprint: "target-a", observedAt: new Date().toISOString() }
      : input.action === "collectOnOpenNote"
        ? { ok: true, collected: true, beforeState: "not_collected", afterState: "collected", countDelta: 1, collectProof: { tapped: [500, 2200] } }
        : input.action === "undoCollectOnOpenNote"
          ? { ok: true, restored: true, beforeState: "collected", afterState: "not_collected" }
          : input.action === "backToFeed"
            ? { ok: true, home: true }
            : { ok: false, notSent: true, step: "unexpected-action" };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const registry = new CapabilityRegistry(capabilities);
    const adapter = createXhsAdapter();
    const evidence = new EvidenceStore({ runsRoot: join(root, "runs"), state, minFreeBytes: 1, minExternalEffectFreeBytes: 1 });
    state.upsertNode({ nodeId: "DESKTOP-3I1EVHE", status: "online", authority: true, dispatchMode: "local" });
    const device = state.upsertDevice({
      alias: "01", physicalLabel: "rack-01", nodeId: "DESKTOP-3I1EVHE", runtimeId: "private-01",
      metadata: { xhsServePort: port },
      routingProfile: { enabled: true, tags: ["slot:01"], capabilityIds: [observeNote.id] },
    });
    const grant = {
      grantId: "grant-collect", issuanceNonce: "nonce-collect", app: "xhs", accountFingerprint: "account-a",
      controllers: ["agent:runner"],
      authorization: { primitives: [], socialActions: ["collect"], missionOnlyActions: [], prohibitedActions: [] },
      targets: { mode: "explicit_fingerprints", values: ["target-a"] },
      budget: { maxima: { totalCount: 1, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } }, defaults: { totalCount: 1, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } } },
      validity: { expiresAt: "2099-07-30T00:00:00.000Z" },
    };
    state.issueDelegationGrant({ grant, grantHash: "grant-collect-hash", proofHash: "proof", issuerSubject: "user:a1234", issuerKeyId: "test", allowlistVersion: 1 });
    const missions = new MissionRuntime({ state });
    const { mission } = missions.createMission({
      issuer: { actorId: "user:a1234" }, idempotencyKey: "mission-collect", app: "xhs", account: "account-a",
      parallelism: 1, controllers: ["agent:runner"],
      scope: { actions: ["collect"], targets: { kind: "fingerprint", values: ["target-a"] }, totalCount: 1, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } },
      validity: { expiresAt: "2099-07-30T00:00:00.000Z" }, policy: { publish: "confirm", delete: "confirm" },
    }, { parentGrantId: grant.grantId, parentGrantHash: "grant-collect-hash" });
    const control = new ControlPlane({
      state, capabilities: registry, adapters: new AdapterRegistry([adapter]), evidence, missions,
      authorityNodeId: "DESKTOP-3I1EVHE", leaseHeartbeatMs: 5000, leaseTtlMs: 60000,
      receiptAuthorityAllowlist: [{ capabilityId: observeNote.id, adapterId: adapter.id }],
    });
    const run = control.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:runner", placement: { physicalLabel: device.physicalLabel } });
    const sourceJob = await control.executeSessionAction(run.sessionId, run.token, {
      idempotencyKey: "observe-note-source", capabilityId: observeNote.id, params: {},
    });
    assert.equal(sourceJob.status, "succeeded");
    const sealed = sourceJob.result.explicitObservationReceipt;
    const receipt = control.recordExplicitObservationReceipt({
      tuple: run.tuple, sourceJobId: sourceJob.jobId, adapterReceiptId: sealed.receiptId,
    });
    assert.equal(receipt.status, "recorded");

    const runtimeDevice = state.requireDevice(run.deviceId, { includeRuntime: true });
    let lastExecution = null;
    const params = { observationReceiptId: receipt.receiptId, targetFingerprint: "target-a" };
    const ecp = control.createEffectCommitProtocol({
      recheck: async () => ({ readiness: { ready: true, source: "control-plane", fresh: true }, app: "xhs", account: "account-a", targetFingerprint: "target-a", pageFingerprint: "page-a", beforeState: "not_collected", control: true }),
      execute: async () => {
        lastExecution = await adapter.execute({ capability: collect, device: runtimeDevice, params, leaseAuthorization: { leaseId: run.leaseId, token: run.token, deviceId: run.deviceId } });
        return lastExecution;
      },
      verify: async () => adapter.verify({ capability: collect, params, execution: lastExecution }),
      restore: async () => adapter.restore({ capability: collect, device: runtimeDevice, params, execution: lastExecution, leaseAuthorization: { leaseId: run.leaseId, token: run.token, deviceId: run.deviceId } }),
    });
    const result = await ecp.commit({
      tuple: run.tuple, mission, action: "collect", target: "target-a", idempotencyKey: "collect-effect", observationReceiptId: receipt.receiptId,
    });
    assert.equal(result.status, "verified");
    assert.deepEqual(requests, ["observeOpenNoteDetail", "collectOnOpenNote", "undoCollectOnOpenNote", "backToFeed"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("collect adapter offline E2E sends once, verifies state change, and restores only this collect before feed", async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    requests.push({ input, headers: req.headers });
    const result = input.action === "collectOnOpenNote"
      ? { ok: true, collected: true, beforeState: "not_collected", afterState: "collected", countDelta: 1, accountFingerprint: "account-a", pageFingerprint: "page-a", targetFingerprint: "target-a", observedAt: new Date().toISOString() }
      : input.action === "undoCollectOnOpenNote"
        ? { ok: true, restored: true, beforeState: "collected", afterState: "not_collected" }
        : input.action === "backToFeed"
          ? { ok: true, home: true }
          : { ok: false, step: "unexpected-action" };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => server.close());
  const port = server.address().port;
  const adapter = createXhsAdapter();
  const capability = {
    ...collect,
    timeoutMs: 5000,
  };
  const device = { metadata: { xhsServePort: port } };
  const params = {
    observationReceiptId: "receipt-a", targetFingerprint: "target-a",
  };

  const execution = await adapter.execute({ capability, device, params, leaseAuthorization: leaseAuthorization() });
  const verification = await adapter.verify({ capability, params, execution });
  const restoration = await adapter.restore({ capability, device, params, execution, verification, leaseAuthorization: leaseAuthorization() });

  assert.equal(verification.ok, true);
  assert.equal(restoration.ok, true);
  assert.deepEqual(requests.map((request) => request.input.action), ["collectOnOpenNote", "undoCollectOnOpenNote", "backToFeed"]);
  assert.equal(requests[0].input.observationReceiptId, "receipt-a");
  assert.equal(requests[1].input.targetFingerprint, "target-a");
  assert.equal(requests[0].headers["x-control-lease-id"], "lease-collect");
});

test("collect fast operator taps once only from a fresh explicit note-detail surface", async () => {
  const operator = Object.create(FastOperator.prototype);
  const states = [
    { groups: [{}, { icon: { center: [500, 2200] }, label: "收藏", isNumeric: false, countValue: null }, {}], favorite: { icon: { center: [500, 2200] }, label: "收藏", isNumeric: false, countValue: null } },
    { groups: [{}, { icon: { center: [500, 2200] }, label: "1", isNumeric: true, countValue: 1 }, {}], favorite: { icon: { center: [500, 2200] }, label: "1", isNumeric: true, countValue: 1 } },
  ];
  let taps = 0;
  operator.observeOpenNoteDetail = async () => ({ ok: true, targetFingerprint: "target-a" });
  operator.currentFocus = async () => ({ package: "com.xingin.xhs", activity: "com.xingin.xhs.note.NoteDetailActivity" });
  operator.dump = async () => ({});
  operator.detailEngagementBar = () => states.shift();
  operator.favoriteDetail = async (bar) => { taps += 1; return { tapped: bar.favorite.icon.center }; };
  const result = await operator.collectOnOpenNote({ targetFingerprint: "target-a" });
  assert.equal(result.collected, true);
  assert.equal(taps, 1);
});

test("collect refuses a missing receipt target before any operator request", async () => {
  let fetchCalls = 0;
  const adapter = createXhsAdapter({ fetchImpl: async () => { fetchCalls += 1; throw new Error("must not fetch"); } });
  await assert.rejects(
    () => adapter.execute({
      capability: collect, device: { metadata: { xhsServePort: 17999 } }, leaseAuthorization: leaseAuthorization(),
      params: { observationReceiptId: "receipt-a" },
    }),
    (error) => error.code === "COLLECT_RECEIPT_BINDING_INVALID" && error.notSent === true,
  );
  assert.equal(fetchCalls, 0);
});

test("collect adapter fails closed when the operator reports an already-collected or ambiguous surface", async () => {
  const adapter = createXhsAdapter({
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, result: { ok: false, notSent: true, step: "alreadyCollected" } }), { status: 200 }),
  });
  await assert.rejects(
    () => adapter.execute({
      capability: collect, device: { metadata: { xhsServePort: 17999 } }, leaseAuthorization: leaseAuthorization(),
      params: { observationReceiptId: "receipt-a", targetFingerprint: "target-a" },
    }),
    (error) => error.code === "ADAPTER_ACTION_REJECTED" && error.notSent === true,
  );
});
