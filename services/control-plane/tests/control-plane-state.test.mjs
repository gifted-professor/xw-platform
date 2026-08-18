import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";

const tempBase = fileURLToPath(new URL("../control-plane/runtime", import.meta.url));
mkdirSync(tempBase, { recursive: true });

function tempRoot() {
  return mkdtempSync(join(tempBase, "state-test-"));
}

function capability(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "test.observe",
    appId: "test",
    packageName: "local.test",
    versionRange: "test",
    maturity: "E3",
    risk: "R0",
    resources: ["device"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object" },
    preconditions: [],
    verification: { mode: "state", description: "fake verifier" },
    restoration: { required: false, description: "none" },
    timeoutMs: 1000,
    idempotency: "read_only",
    automationPolicy: { mode: "automatic" },
    implementation: { adapter: "test", action: "observe" },
    evidence: [],
    ...overrides,
  };
}

function setup(path, caps = [capability()]) {
  const state = new StateStore({ dbPath: path });
  const registry = new CapabilityRegistry(caps);
  state.syncCapabilities(registry);
  state.upsertNode({ nodeId: "DESKTOP-3I1EVHE", authority: true });
  const device = state.upsertDevice({
    alias: "01",
    physicalLabel: "rack-01",
    nodeId: "DESKTOP-3I1EVHE",
    runtimeId: "private-runtime-id",
    routingProfile: { enabled: true, tags: ["slot:01"], capabilityIds: caps.map((c) => c.id) },
  });
  return { state, device, registry };
}

test("idempotency is durable and public device records redact runtime IDs", () => {
  const root = tempRoot();
  const path = join(root, "control.db");
  const { state, device, registry } = setup(path);
  try {
    assert.equal(Object.hasOwn(state.getDevice(device.deviceId), "runtimeId"), false);
    assert.equal(state.getDevice(device.deviceId, { includeRuntime: true }).runtimeId, "private-runtime-id");
    const input = {
      idempotencyKey: "same",
      actorId: "agent-a",
      authorityNodeId: "DESKTOP-3I1EVHE",
      deviceId: device.deviceId,
      capability: registry.require("test.observe"),
      params: {},
    };
    const first = state.createJob(input);
    const second = state.createJob(input);
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(second.job.jobId, first.job.jobId);
    assert.throws(
      () => state.createJob({ ...input, params: { changed: true } }),
      { code: "IDEMPOTENCY_CONFLICT", status: 409 },
    );
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("exclusive leases reject a second actor and validate tokens", () => {
  const root = tempRoot();
  const { state, device } = setup(join(root, "control.db"));
  try {
    const session = state.createSession({ actorId: "agent-a", deviceId: device.deviceId, canary: true });
    assert.throws(
      () => state.createSession({ actorId: "agent-b", deviceId: device.deviceId }),
      { code: "DEVICE_BUSY", status: 423 },
    );
    assert.throws(() => state.heartbeatSession(session.sessionId, "wrong"), { code: "SESSION_TOKEN_INVALID" });
    assert.equal(state.heartbeatSession(session.sessionId, session.token).sessionId, session.sessionId);
    assert.deepEqual(state.releaseSession(session.sessionId, session.token), {
      released: true,
      sessionId: session.sessionId,
    });
    assert.equal(state.listLeases().length, 0);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator authorization binds a lease to both public device and private runtime", () => {
  const root = tempRoot();
  const { state, device } = setup(join(root, "control.db"));
  try {
    const lease = state.acquireLease({
      deviceId: device.deviceId,
      kind: "job",
      holderId: "job:test",
      jobId: "job:test",
    });
    const authorized = state.authorizeLease({
      leaseId: lease.leaseId,
      token: lease.token,
      deviceId: device.deviceId,
      runtimeId: "private-runtime-id",
    });
    assert.equal(authorized.deviceId, device.deviceId);
    assert.equal(Object.hasOwn(authorized, "token"), false);
    assert.throws(() => state.authorizeLease({
      leaseId: lease.leaseId,
      token: lease.token,
      deviceId: device.deviceId,
      runtimeId: "other-runtime",
    }), { code: "LEASE_RUNTIME_MISMATCH", status: 409 });
    assert.throws(() => state.authorizeLease({
      leaseId: lease.leaseId,
      token: "wrong-token",
      deviceId: device.deviceId,
      runtimeId: "private-runtime-id",
    }), { code: "LEASE_TOKEN_INVALID", status: 403 });
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart marks in-flight work recovery_required and quarantines its device", () => {
  const root = tempRoot();
  const path = join(root, "control.db");
  let state;
  try {
    const fixture = setup(path);
    state = fixture.state;
    const created = state.createJob({
      idempotencyKey: "restart",
      actorId: "agent-a",
      authorityNodeId: "DESKTOP-3I1EVHE",
      deviceId: fixture.device.deviceId,
      capability: fixture.registry.require("test.observe"),
      params: {},
    });
    const lease = state.acquireLease({
      deviceId: fixture.device.deviceId,
      kind: "job",
      holderId: created.job.jobId,
      jobId: created.job.jobId,
    });
    state.transitionJob(created.job.jobId, "running");
    assert.ok(lease.token);
    state.close();
    state = new StateStore({ dbPath: path });
    assert.equal(state.requireJob(created.job.jobId).status, "recovery_required");
    assert.equal(state.getDevice(fixture.device.deviceId).quarantined, true);
    assert.equal(state.listLeases().length, 0);
  } finally {
    try { state?.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("stable device ID follows the private runtime identity across alias changes", () => {
  const root = tempRoot();
  const { state, device } = setup(join(root, "control.db"));
  try {
    const renamed = state.upsertDevice({
      alias: "rack-alias-renamed",
      physicalLabel: "rack-01",
      nodeId: "DESKTOP-3I1EVHE",
      runtimeId: "private-runtime-id",
    });
    assert.equal(renamed.deviceId, device.deviceId);
    assert.equal(renamed.alias, "rack-alias-renamed");
    assert.equal(state.listDevices().length, 1);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── REX Phase 5 §8.1 item 3：legacy pending migration（保守、支付安全）───
//
// nonpayment_v1 启动时迁移历史 waiting_approval job：非支付无 trace → queued_migrated +
// 新 queued job（superseded_by 指向新）；有 dispatch trace → queued_migrated + MIGRATED_RECONCILE
// 不重发；payment-like → 保持 waiting_approval（不迁移，保留人工闸）。isPaymentLike 由
// ControlPlane 注入（financial-commit-classifier on capability），state-store 保持通用。

test("migrateNonpaymentWaitingApprovals: non-payment no-trace → queued_migrated + fresh queued job + superseded_by", () => {
  const root = tempRoot();
  const { state, device, registry } = setup(join(root, "control.db"), [capability()]);
  try {
    const cap = registry.require("test.observe");
    const waiting = state.createJob({
      idempotencyKey: "legacy-waiting-1", actorId: "agent-a", authorityNodeId: "DESKTOP-3I1EVHE",
      deviceId: device.deviceId, capability: cap, params: {},
      status: "waiting_approval", approvalRequired: true, externalEffect: false,
    }).job;
    const report = state.migrateNonpaymentWaitingApprovals({ isPaymentLike: () => false });
    assert.deepEqual(report, { total: 1, migrated: 1, reconciled: 0, paymentLike: 0 });
    const oldRow = state.getJob(waiting.jobId);
    assert.equal(oldRow.status, "queued_migrated");
    assert.ok(oldRow.supersededBy, "old row must record superseded_by");
    const fresh = state.getJob(oldRow.supersededBy);
    assert.equal(fresh.status, "queued", "fresh job is queued for dispatch");
    assert.equal(fresh.approvalRequired, false, "migrated fresh job is approval-free");
    assert.equal(
      state.db.prepare("SELECT idempotency_key AS k FROM jobs WHERE job_id=?").get(fresh.jobId).k,
      "legacy-waiting-1:migrated",
    );
    assert.equal(fresh.capabilityId, cap.id);
    assert.equal(fresh.deviceId, device.deviceId);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateNonpaymentWaitingApprovals: payment-like jobs stay waiting_approval (manual gate preserved)", () => {
  const root = tempRoot();
  const payCap = capability({ id: "test.pay", risk: "R2", idempotency: "ambiguous_on_timeout", automationPolicy: { mode: "approval_required" } });
  const { state, device, registry } = setup(join(root, "control.db"), [payCap]);
  try {
    const cap = registry.require("test.pay");
    state.createJob({
      idempotencyKey: "legacy-pay-1", actorId: "agent-a", authorityNodeId: "DESKTOP-3I1EVHE",
      deviceId: device.deviceId, capability: cap, params: {},
      status: "waiting_approval", approvalRequired: true, externalEffect: true,
    });
    const report = state.migrateNonpaymentWaitingApprovals({ isPaymentLike: (job) => job.capabilityId === "test.pay" });
    assert.deepEqual(report, { total: 1, migrated: 0, reconciled: 0, paymentLike: 1 });
    // payment-like 仍在 waiting_approval，无 superseded_by，无新 job
    const rows = state.db.prepare("SELECT * FROM jobs WHERE idempotency_key='legacy-pay-1'").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "waiting_approval");
    assert.equal(rows[0].superseded_by, null);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateNonpaymentWaitingApprovals: traced job → queued_migrated reconcile-only, no re-dispatch", () => {
  const root = tempRoot();
  const { state, device, registry } = setup(join(root, "control.db"), [capability()]);
  try {
    const cap = registry.require("test.observe");
    const waiting = state.createJob({
      idempotencyKey: "legacy-traced-1", actorId: "agent-a", authorityNodeId: "DESKTOP-3I1EVHE",
      deviceId: device.deviceId, capability: cap, params: {},
      status: "waiting_approval", approvalRequired: true, externalEffect: false,
    }).job;
    // 注入 dispatch 痕迹：started_at 已设（曾被派发过）
    state.db.prepare("UPDATE jobs SET started_at=? WHERE job_id=?").run(state.now(), waiting.jobId);
    const report = state.migrateNonpaymentWaitingApprovals({ isPaymentLike: () => false });
    assert.deepEqual(report, { total: 1, migrated: 0, reconciled: 1, paymentLike: 0 });
    const oldRow = state.getJob(waiting.jobId);
    assert.equal(oldRow.status, "queued_migrated");
    assert.equal(oldRow.errorCode, "MIGRATED_RECONCILE");
    assert.equal(oldRow.supersededBy, null, "traced job must NOT spawn a fresh dispatch job");
    // 无新 job 产生
    assert.equal(state.db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE idempotency_key='legacy-traced-1:migrated'").get().c, 0);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateNonpaymentWaitingApprovals: empty when no waiting_approval jobs", () => {
  const root = tempRoot();
  const { state, device, registry } = setup(join(root, "control.db"), [capability()]);
  try {
    const cap = registry.require("test.observe");
    state.createJob({
      idempotencyKey: "queued-1", actorId: "agent-a", authorityNodeId: "DESKTOP-3I1EVHE",
      deviceId: device.deviceId, capability: cap, params: {}, status: "queued",
    });
    const report = state.migrateNonpaymentWaitingApprovals({ isPaymentLike: () => false });
    assert.deepEqual(report, { total: 0, migrated: 0, reconciled: 0, paymentLike: 0 });
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
