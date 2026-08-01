import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { AdapterRegistry, ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { EvidenceStore } from "../control-plane/lib/evidence-store.mjs";
import { ControlPlaneError } from "../control-plane/lib/errors.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";

const tempBase = fileURLToPath(new URL("../control-plane/runtime", import.meta.url));
mkdirSync(tempBase, { recursive: true });

function manifest(id, overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    appId: "test",
    packageName: "local.test",
    versionRange: "test",
    maturity: "E3",
    risk: "R0",
    resources: ["device"],
    inputSchema: {
      type: "object",
      properties: { label: { type: "string" } },
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
    preconditions: [],
    verification: { mode: "state", description: "fake verifier" },
    restoration: { required: false, description: "none" },
    timeoutMs: 1000,
    idempotency: "read_only",
    automationPolicy: { mode: "automatic" },
    implementation: { adapter: "test", action: id },
    evidence: [],
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fixture({ capabilities, adapter, policyMode = null, evidenceOpts = {} }) {
  const root = mkdtempSync(join(tempBase, "core-test-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const registry = new CapabilityRegistry(capabilities);
  const capabilityIds = capabilities.map((capability) => capability.id);
  const devices = ["01", "02"].map((alias) => state.upsertDevice({
    alias,
    physicalLabel: `rack-${alias}`,
    nodeId: "DESKTOP-3I1EVHE",
    runtimeId: `private-${alias}`,
    routingProfile: { enabled: true, tags: [`slot:${alias}`], capabilityIds },
  }));
  const evidence = new EvidenceStore({
    runsRoot: join(root, "runs"),
    state,
    minFreeBytes: 0,
    minExternalEffectFreeBytes: 0,
    ...evidenceOpts,
  });
  const control = new ControlPlane({
    state,
    capabilities: registry,
    adapters: new AdapterRegistry([adapter]),
    evidence,
    schedulerIntervalMs: 5,
    leaseTtlMs: 1000,
    leaseHeartbeatMs: 20,
    policyMode,
  });
  control.start();
  return {
    root,
    state,
    registry,
    devices,
    evidence,
    control,
    async close() {
      await control.stop();
      state.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("job result keeps bounded diagnostics and drops unrelated adapter output", async () => {
  const diagnostic = {
    publishCompose: true,
    mediaCount: 0,
    expectedCount: 2,
    hasAddMore: false,
    topMedia: {
      nodeCount: 1,
      nodes: [{ labelKind: "empty", classKind: "view", bounds: [10, 20, 30, 40], clickable: false }],
    },
  };
  const adapter = {
    id: "test",
    async execute() {
      return {
        vendorCode: 0,
        output: {
          ok: false,
          step: "images-unverified",
          diagnostic,
          transportEvidence: {
            mode: "typed-http",
            httpReady: true,
            httpTapAttempts: 4,
            httpTapSucceeded: 4,
            gatewayTapFallbacks: 0,
            privateRawLabel: "must-not-persist",
          },
          privateRawLabel: "must-not-persist",
        },
      };
    },
    async verify() { return { ok: false, mode: "state" }; },
    async restore() { return { ok: true }; },
  };
  const f = fixture({ capabilities: [manifest("test.diagnostic")], adapter });
  try {
    const submitted = f.control.submitJob({
      idempotencyKey: "bounded-diagnostic",
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      capabilityId: "test.diagnostic",
      params: {},
    }).job;
    const terminal = await f.control.waitForJob(submitted.jobId);
    assert.equal(terminal.status, "failed");
    assert.deepEqual(terminal.result.output.diagnostic, diagnostic);
    assert.equal(Object.hasOwn(terminal.result.output, "privateRawLabel"), false);
    assert.deepEqual(terminal.result.transportEvidence, {
      mode: "typed-http",
      httpReady: true,
      httpTapAttempts: 4,
      httpTapSucceeded: 4,
      gatewayTapFallbacks: 0,
    });
  } finally {
    await f.close();
  }
});

test("different devices run concurrently while one device remains FIFO", async () => {
  const gates = [];
  const starts = [];
  let active = 0;
  let maxActive = 0;
  const adapter = {
    id: "test",
    async execute({ job, device }) {
      starts.push([job.jobId, device.alias]);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      active -= 1;
      return { vendorCode: 0 };
    },
    async verify() { return { ok: true, mode: "state" }; },
    async restore() { return { ok: true }; },
  };
  const f = fixture({ capabilities: [manifest("test.observe")], adapter });
  try {
    const first = f.control.submitJob({
      idempotencyKey: "first",
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      capabilityId: "test.observe",
      params: { label: "first" },
    }).job;
    const secondSameDevice = f.control.submitJob({
      idempotencyKey: "second",
      actorId: "agent-b",
      deviceId: f.devices[0].deviceId,
      capabilityId: "test.observe",
      params: { label: "second" },
    }).job;
    const otherDevice = f.control.submitJob({
      idempotencyKey: "third",
      actorId: "agent-c",
      deviceId: f.devices[1].deviceId,
      capabilityId: "test.observe",
      params: { label: "third" },
    }).job;
    await until(() => starts.length === 2);
    assert.equal(maxActive, 2);
    assert.equal(starts.filter(([, alias]) => alias === "01").length, 1);
    assert.equal(f.state.requireJob(secondSameDevice.jobId).status, "queued");
    gates[0].resolve();
    gates[1].resolve();
    await until(() => starts.length === 3);
    gates[2].resolve();
    assert.equal((await f.control.waitForJob(first.jobId)).status, "succeeded");
    assert.equal((await f.control.waitForJob(otherDevice.jobId)).status, "succeeded");
    assert.equal((await f.control.waitForJob(secondSameDevice.jobId)).status, "succeeded");
  } finally {
    gates.forEach((gate) => gate.resolve());
    await f.close();
  }
});

test("adapter execution receives a device-bound lease credential without persisting the token", async () => {
  const seen = [];
  let f;
  const adapter = {
    id: "test",
    async execute({ device, leaseAuthorization }) {
      const authorized = f.state.authorizeLease({
        leaseId: leaseAuthorization.leaseId,
        token: leaseAuthorization.token,
        deviceId: leaseAuthorization.deviceId,
        runtimeId: device.runtimeId,
      });
      seen.push({ device, leaseAuthorization, authorized });
      return { vendorCode: 0, output: { ok: true } };
    },
    async verify() { return { ok: true, mode: "state" }; },
    async restore() { return { ok: true }; },
  };
  f = fixture({ capabilities: [manifest("test.lease-context")], adapter });
  try {
    const submitted = f.control.submitJob({
      idempotencyKey: "lease-context",
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      capabilityId: "test.lease-context",
      params: {},
    }).job;
    const finished = await f.control.waitForJob(submitted.jobId);
    assert.equal(finished.status, "succeeded");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].leaseAuthorization.deviceId, f.devices[0].deviceId);
    assert.equal(seen[0].authorized.deviceId, f.devices[0].deviceId);
    assert.doesNotMatch(JSON.stringify(finished), new RegExp(seen[0].leaseAuthorization.token));
    assert.doesNotMatch(
      JSON.stringify(f.evidence.getManifest(submitted.runId)),
      new RegExp(seen[0].leaseAuthorization.token),
    );
  } finally {
    await f.close();
  }
});

test("ordinary jobs persist secret-free lease acquired and released events", async () => {
  let leaseToken;
  const adapter = {
    id: "test",
    async execute({ leaseAuthorization }) {
      leaseToken = leaseAuthorization.token;
      return { vendorCode: 0, output: { ok: true } };
    },
    async verify() { return { ok: true, mode: "state" }; },
    async restore() { return { ok: true }; },
  };
  const f = fixture({ capabilities: [manifest("test.lease-events")], adapter });
  try {
    const job = f.control.submitJob({
      idempotencyKey: "lease-events",
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      capabilityId: "test.lease-events",
      params: {},
    }).job;
    assert.equal((await f.control.waitForJob(job.jobId)).status, "succeeded");
    await until(() => f.state.listJobEvents(job.jobId)
      .filter((event) => event.type.startsWith("job.lease.")).length === 2);
    const leaseEvents = f.state.listJobEvents(job.jobId)
      .filter((event) => event.type.startsWith("job.lease."));
    assert.deepEqual(leaseEvents.map((event) => event.type), ["job.lease.acquired", "job.lease.released"]);
    for (const event of leaseEvents) {
      assert.deepEqual(Object.keys(event.payload).sort(), [
        "createdAt", "deviceId", "expiresAt", "holderId", "jobId", "leaseId", "outcome",
      ]);
      assert.equal(event.payload.jobId, job.jobId);
      assert.equal(event.payload.deviceId, f.devices[0].deviceId);
      assert.match(event.payload.leaseId, /^lease_/);
      assert.match(event.payload.createdAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.match(event.payload.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
    }
    assert.equal(leaseEvents[0].payload.outcome, "acquired");
    assert.equal(leaseEvents[1].payload.outcome, "released");
    assert.equal(f.state.listLeases().length, 0);
    assert.doesNotMatch(JSON.stringify(leaseEvents), new RegExp(leaseToken));
    assert.doesNotMatch(JSON.stringify(leaseEvents), /token|hash|secret/i);
  } finally {
    await f.close();
  }
});

test("lease release event logging failure never blocks lease release", async () => {
  const adapter = {
    id: "test",
    async execute() { return { vendorCode: 0, output: { ok: true } }; },
    async verify() { return { ok: true, mode: "state" }; },
    async restore() { return { ok: true }; },
  };
  const f = fixture({ capabilities: [manifest("test.lease-release-log-failure")], adapter });
  const appendEvent = f.state.appendEvent.bind(f.state);
  f.state.appendEvent = (entry) => {
    if (entry.type === "job.lease.released") throw new Error("simulated event sink failure");
    return appendEvent(entry);
  };
  try {
    const job = f.control.submitJob({
      idempotencyKey: "lease-release-log-failure",
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      capabilityId: "test.lease-release-log-failure",
      params: {},
    }).job;
    assert.equal((await f.control.waitForJob(job.jobId)).status, "succeeded");
    await until(() => f.state.listLeases().length === 0);
    assert.equal(f.state.listLeases().length, 0);
  } finally {
    await f.close();
  }
});

test("external effects wait for approval before entering the queue", async () => {
  let executions = 0;
  const adapter = {
    id: "test",
    async execute() { executions += 1; return { vendorCode: 0 }; },
    async verify() { return { ok: true, mode: "custom" }; },
    async restore() { return { ok: true }; },
  };
  const external = manifest("test.external", {
    risk: "R2",
    idempotency: "external_effect",
    automationPolicy: { mode: "approval_required" },
  });
  const f = fixture({ capabilities: [external], adapter });
  try {
    const submitted = f.control.submitJob({
      idempotencyKey: "external",
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      capabilityId: external.id,
      params: {},
    }).job;
    assert.equal(submitted.status, "waiting_approval");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(executions, 0);
    f.control.decideApproval(submitted.jobId, {
      decision: "approve",
      actorId: "human-reviewer",
      reason: "bounded test",
    });
    assert.equal((await f.control.waitForJob(submitted.jobId)).status, "succeeded");
    assert.equal(executions, 1);
  } finally {
    await f.close();
  }
});

// REX Phase 5 §8.2 B9 反转：nonpayment_v1 active 下，同一非支付 external effect 不再
// 等审批——直接 dispatch。legacy 审批流保留上方测试作 fallback。liveness：无需
// decideApproval，adapter 自动执行（executions>=1）。
test("nonpayment_v1: non-payment external effect dispatches without approval", async () => {
  let executions = 0;
  const adapter = {
    id: "test",
    async execute() { executions += 1; return { vendorCode: 0 }; },
    async verify() { return { ok: true, mode: "custom" }; },
    async restore() { return { ok: true }; },
  };
  const external = manifest("test.external", {
    risk: "R2",
    idempotency: "external_effect",
    automationPolicy: { mode: "approval_required" },
  });
  const f = fixture({
    capabilities: [external],
    adapter,
    policyMode: { active: true, mode: "nonpayment_v1", effectiveDecisionSource: "deployed-runtime" },
  });
  try {
    const submitted = f.control.submitJob({
      idempotencyKey: "external-freedom",
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      capabilityId: external.id,
      params: {},
    }).job;
    assert.equal(submitted.approvalRequired, false, "nonpayment_v1: non-payment external must not require approval");
    assert.notEqual(submitted.status, "waiting_approval");
    // liveness：无需 decideApproval，adapter 自动执行
    await f.control.waitForJob(submitted.jobId);
    assert.ok(executions >= 1, "nonpayment_v1: external effect executed without approval");
  } finally {
    await f.close();
  }
});

// ─── REX Phase 5 §8.4：evidence 容量失败对非支付走 debt，不阻断派发 ───
//
// nonpayment_v1 active + 强制低盘（minFreeBytes=MAX_SAFE_INTEGER → freeBytes<required）。
// submitJob 一个非支付 external-effect capability：必须进 queued、不抛 EVIDENCE_DISK_LOW、
// adapter 自动执行（liveness），且 control.evidenceDebt 记录 EVIDENCE_DISK_LOW 债。
// legacy（policyMode=null）下同样低盘仍 fail-closed 抛错（下方对照测试）。

test("nonpayment_v1: non-payment submitJob records evidence debt instead of blocking on low disk", async () => {
  let executions = 0;
  const adapter = {
    id: "test",
    async execute() { executions += 1; return { vendorCode: 0 }; },
    async verify() { return { ok: true, mode: "custom" }; },
    async restore() { return { ok: true }; },
  };
  const external = manifest("test.external.debt", {
    risk: "R2",
    idempotency: "external_effect",
    automationPolicy: { mode: "approval_required" },
  });
  const f = fixture({
    capabilities: [external],
    adapter,
    policyMode: { active: true, mode: "nonpayment_v1", effectiveDecisionSource: "deployed-runtime" },
    evidenceOpts: { minFreeBytes: Number.MAX_SAFE_INTEGER, minExternalEffectFreeBytes: Number.MAX_SAFE_INTEGER },
  });
  try {
    const submitted = f.control.submitJob({
      idempotencyKey: "external-debt",
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      capabilityId: external.id,
      params: {},
    }).job;
    assert.notEqual(submitted.status, "waiting_approval", "must not wait for approval");
    assert.equal(submitted.status, "queued", "nonpayment_v1: low-disk non-payment job still queues (debt, not block)");
    assert.ok(f.control.evidenceDebt.length >= 1, "evidenceDebt must record the low-disk debt");
    assert.equal(f.control.evidenceDebt[0].code, "EVIDENCE_DISK_LOW");
    assert.equal(f.control.evidenceDebt[0].externalEffect, true);
    await f.control.waitForJob(submitted.jobId);
    assert.ok(executions >= 1, "nonpayment_v1: low-disk non-payment job still dispatches (liveness)");
  } finally {
    await f.close();
  }
});

test("legacy: low-disk submitJob stays fail-closed (EVIDENCE_DISK_LOW) — payment path preserved", () => {
  const adapter = {
    id: "test",
    async execute() { return { vendorCode: 0 }; },
    async verify() { return { ok: true, mode: "custom" }; },
    async restore() { return { ok: true }; },
  };
  const external = manifest("test.external.legacydisk", {
    risk: "R2",
    idempotency: "external_effect",
    automationPolicy: { mode: "approval_required" },
  });
  const f = fixture({
    capabilities: [external],
    adapter,
    policyMode: null,
    evidenceOpts: { minFreeBytes: Number.MAX_SAFE_INTEGER, minExternalEffectFreeBytes: Number.MAX_SAFE_INTEGER },
  });
  try {
    assert.throws(
      () => f.control.submitJob({
        idempotencyKey: "legacy-disk",
        actorId: "agent-a",
        deviceId: f.devices[0].deviceId,
        capabilityId: external.id,
        params: {},
      }),
      { code: "EVIDENCE_DISK_LOW" },
    );
    assert.equal(f.control.evidenceDebt.length, 0, "legacy must not record debt on low disk");
  } finally {
    f.close();
  }
});

// ─── §8.4 #1：ControlPlane 把 debtRecorder 注入 EvidenceStore 仅在 nonpayment_v1 ───
test("nonpayment_v1 wires evidence debtRecorder; legacy leaves it null", () => {
  const adapter = {
    id: "test",
    async execute() { return { vendorCode: 0 }; },
    async verify() { return { ok: true, mode: "custom" }; },
    async restore() { return { ok: true }; },
  };
  const cap = manifest("test.cap.recorder", { risk: "R0", idempotency: "read_only", automationPolicy: { mode: "automatic" } });

  const legacyF = fixture({ capabilities: [cap], adapter, policyMode: null });
  try {
    assert.ok(!legacyF.control.debtOnLowDisk, "legacy: debtOnLowDisk falsy (null/false)");
    assert.equal(legacyF.control.evidence.debtRecorder, null, "legacy: EvidenceStore.debtRecorder must stay null (fail-closed)");
    assert.ok(Array.isArray(legacyF.control.evidenceDebt), "legacy: evidenceDebt array exists");
  } finally { legacyF.close(); }

  const activeF = fixture({
    capabilities: [cap],
    adapter,
    policyMode: { active: true, mode: "nonpayment_v1", effectiveDecisionSource: "deployed-runtime" },
  });
  try {
    assert.equal(activeF.control.debtOnLowDisk, true, "nonpayment_v1: debtOnLowDisk true");
    assert.equal(typeof activeF.control.evidence.debtRecorder, "function", "nonpayment_v1: EvidenceStore.debtRecorder wired");
    // 触发一次 debt：手动调用 appendEvent 到一个被文件阻断的 run 目录
    writeFileSync(join(activeF.evidence.runsRoot, "run-manual"), "blocker");
    activeF.control.evidence.appendEvent("run-manual", { type: "manual.probe" });
    assert.ok(activeF.control.evidenceDebt.length >= 1, "nonpayment_v1: debt recorded via wired recorder");
    assert.equal(activeF.control.evidenceDebt[0].code, "EVIDENCE_WRITE_FAILED");
  } finally { activeF.close(); }
});

// ─── §8.1 item 3：ControlPlane.start 在 nonpayment_v1 迁移历史 waiting_approval ───
test("nonpayment_v1: migrateLegacyPending frees a legacy waiting job and dispatches the fresh job", async () => {
  let executions = 0;
  const adapter = {
    id: "test",
    async execute() { executions += 1; return { vendorCode: 0 }; },
    async verify() { return { ok: true, mode: "custom" }; },
    async restore() { return { ok: true }; },
  };
  const external = manifest("test.external.legacy", {
    risk: "R2",
    idempotency: "external_effect",
    automationPolicy: { mode: "approval_required" },
  });
  const f = fixture({
    capabilities: [external],
    adapter,
    policyMode: { active: true, mode: "nonpayment_v1", effectiveDecisionSource: "deployed-runtime" },
  });
  try {
    // 直接在 state 里种一个历史 waiting_approval job（submitJob 在 nonpayment_v1 不会产生 waiting）
    const legacy = f.state.createJob({
      idempotencyKey: "legacy-waiting-dispatch", actorId: "agent-a", authorityNodeId: "DESKTOP-3I1EVHE",
      deviceId: f.devices[0].deviceId, capability: external, params: {},
      status: "waiting_approval", approvalRequired: true, externalEffect: true,
    }).job;
    const report = f.control.migrateLegacyPending();
    assert.equal(report.migrated, 1, "non-payment waiting job migrated");
    assert.equal(report.paymentLike, 0);
    const oldRow = f.state.getJob(legacy.jobId);
    assert.equal(oldRow.status, "queued_migrated");
    assert.ok(oldRow.supersededBy);
    const fresh = f.state.getJob(oldRow.supersededBy);
    assert.equal(fresh.status === "queued" || fresh.status === "running" || fresh.status === "succeeded", true);
    // liveness：fresh job 被 pump 派发，adapter 执行
    await f.control.waitForJob(fresh.jobId);
    assert.ok(executions >= 1, "migrated fresh job dispatches (liveness)");
    assert.equal(f.state.getJob(fresh.jobId).status, "succeeded");
  } finally {
    await f.close();
  }
});

test("legacy ControlPlane.migrateLegacyPending is a no-op (preserves waiting_approval)", () => {
  const adapter = {
    id: "test", async execute() { return { vendorCode: 0 }; },
    async verify() { return { ok: true, mode: "custom" }; }, async restore() { return { ok: true }; },
  };
  const cap = manifest("test.cap.legacymig", { risk: "R2", idempotency: "external_effect", automationPolicy: { mode: "approval_required" } });
  const f = fixture({ capabilities: [cap], adapter, policyMode: null });
  try {
    const legacy = f.state.createJob({
      idempotencyKey: "legacy-waiting-nomigrate", actorId: "agent-a", authorityNodeId: "DESKTOP-3I1EVHE",
      deviceId: f.devices[0].deviceId, capability: cap, params: {},
      status: "waiting_approval", approvalRequired: true, externalEffect: true,
    }).job;
    const report = f.control.migrateLegacyPending();
    assert.equal(report, null, "legacy: migration must not run");
    assert.equal(f.state.getJob(legacy.jobId).status, "waiting_approval", "legacy: waiting job preserved");
  } finally { f.close(); }
});

test("sent failures become ambiguous without automatic retry", async () => {
  let executions = 0;
  const adapter = {
    id: "test",
    async execute() {
      executions += 1;
      const error = new Error("timeout after send");
      error.code = "SENT_TIMEOUT";
      error.sent = true;
      throw error;
    },
    async restore() { return { ok: true }; },
  };
  const f = fixture({ capabilities: [manifest("test.ambiguous")], adapter });
  try {
    const job = f.control.submitJob({
      idempotencyKey: "ambiguous",
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      capabilityId: "test.ambiguous",
      params: {},
    }).job;
    assert.equal((await f.control.waitForJob(job.jobId)).status, "ambiguous");
    assert.equal(executions, 1);
    assert.equal(f.control.submitJob({
      idempotencyKey: "ambiguous",
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      capabilityId: "test.ambiguous",
      params: {},
    }).job.jobId, job.jobId);
    assert.equal(executions, 1);
  } finally {
    await f.close();
  }
});

test("restoration failure quarantines the device", async () => {
  const adapter = {
    id: "test",
    async execute() { return { vendorCode: 0 }; },
    async verify() { return { ok: true, mode: "state" }; },
    async restore() { return { ok: false }; },
  };
  const f = fixture({
    capabilities: [manifest("test.restore", {
      restoration: { required: true, description: "must restore" },
    })],
    adapter,
  });
  try {
    const job = f.control.submitJob({
      idempotencyKey: "restore",
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      capabilityId: "test.restore",
      params: {},
    }).job;
    assert.equal((await f.control.waitForJob(job.jobId)).status, "recovery_required");
    assert.equal(f.state.getDevice(f.devices[0].deviceId).quarantined, true);
  } finally {
    await f.close();
  }
});

test("audited recovery lease restores a quarantined device exactly once", async () => {
  let restoreCalls = 0;
  let recoveryAuthorization = null;
  let recoveryAttempt = null;
  let f;
  const adapter = {
    id: "test",
    async execute() { return { vendorCode: 0 }; },
    async verify() { return { ok: true, mode: "state" }; },
    async restore({ device, leaseAuthorization, recoveryAttempt: attempted }) {
      restoreCalls += 1;
      if (restoreCalls === 1) return { ok: false };
      recoveryAttempt = attempted;
      recoveryAuthorization = f.state.authorizeLease({
        leaseId: leaseAuthorization.leaseId,
        token: leaseAuthorization.token,
        deviceId: leaseAuthorization.deviceId,
        runtimeId: device.runtimeId,
      });
      return { ok: true };
    },
  };
  f = fixture({
    capabilities: [manifest("test.restore", {
      restoration: { required: true, description: "must restore" },
    })],
    adapter,
  });
  try {
    const job = f.control.submitJob({
      idempotencyKey: "restore-then-recover",
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      capabilityId: "test.restore",
      params: {},
    }).job;
    assert.equal((await f.control.waitForJob(job.jobId)).status, "recovery_required");
    assert.equal(f.state.getDevice(job.deviceId).quarantined, true);
    assert.throws(() => f.state.acquireLease({
      deviceId: job.deviceId,
      kind: "job",
      holderId: "job:must-stay-blocked",
      jobId: job.jobId,
    }), { code: "DEVICE_QUARANTINED" });

    const recovered = await f.control.recoverJob({
      jobId: job.jobId,
      actorId: "recovery-agent",
      idempotencyKey: "recover-once",
    });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.reused, false);
    assert.equal(recovered.quarantineCleared, true);
    assert.equal(recoveryAuthorization.kind, "recovery");
    assert.equal(recoveryAttempt, true);
    assert.equal(f.state.getDevice(job.deviceId).quarantined, false);
    assert.equal(f.state.listLeases().length, 0);
    assert.deepEqual(
      f.state.listJobEvents(job.jobId).filter((event) => event.type.startsWith("job.recovery.")).map((event) => event.type),
      ["job.recovery.started", "job.recovery.succeeded"],
    );

    const replay = await f.control.recoverJob({
      jobId: job.jobId,
      actorId: "recovery-agent",
      idempotencyKey: "recover-once",
    });
    assert.equal(replay.ok, true);
    assert.equal(replay.reused, true);
    assert.equal(restoreCalls, 2);
  } finally {
    await f.close();
  }
});

test("failed audited recovery keeps the device quarantined", async () => {
  let restoreCalls = 0;
  const adapter = {
    id: "test",
    async execute() { return { vendorCode: 0 }; },
    async verify() { return { ok: true, mode: "state" }; },
    async restore() {
      restoreCalls += 1;
      return { ok: false };
    },
  };
  const f = fixture({
    capabilities: [manifest("test.restore", {
      restoration: { required: true, description: "must restore" },
    })],
    adapter,
  });
  try {
    const job = f.control.submitJob({
      idempotencyKey: "restore-stays-failed",
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      capabilityId: "test.restore",
      params: {},
    }).job;
    assert.equal((await f.control.waitForJob(job.jobId)).status, "recovery_required");
    await assert.rejects(
      f.control.recoverJob({
        jobId: job.jobId,
        actorId: "recovery-agent",
        idempotencyKey: "recover-fails",
      }),
      { code: "RECOVERY_FAILED" },
    );
    assert.equal(restoreCalls, 2);
    assert.equal(f.state.getDevice(job.deviceId).quarantined, true);
    assert.equal(f.state.listLeases().length, 0);
    assert.equal(
      f.state.listJobEvents(job.jobId).some((event) => event.type === "job.recovery.failed"),
      true,
    );
  } finally {
    await f.close();
  }
});

test("audited recovery cannot clear quarantine when required screenshot evidence is missing", async () => {
  let restoreCalls = 0;
  const adapter = {
    id: "test",
    async execute() { return { vendorCode: 0 }; },
    async verify() { return { ok: true, mode: "state" }; },
    async restore() {
      restoreCalls += 1;
      if (restoreCalls === 1) return { ok: false };
      return { ok: true, safeStateVerified: true, evidenceRequired: true, evidenceFiles: [] };
    },
  };
  const f = fixture({
    capabilities: [manifest("test.restore", {
      restoration: { required: true, description: "must restore" },
    })],
    adapter,
  });
  try {
    const job = f.control.submitJob({
      idempotencyKey: "restore-evidence-required",
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      capabilityId: "test.restore",
      params: {},
    }).job;
    assert.equal((await f.control.waitForJob(job.jobId)).status, "recovery_required");
    await assert.rejects(
      f.control.recoverJob({
        jobId: job.jobId,
        actorId: "recovery-agent",
        idempotencyKey: "recover-without-evidence",
      }),
      (error) => error.code === "RECOVERY_FAILED"
        && error.details?.causeCode === "RECOVERY_SCREENSHOT_MISSING",
    );
    assert.equal(f.state.getDevice(job.deviceId).quarantined, true);
    assert.equal(f.state.listLeases().length, 0);
  } finally {
    await f.close();
  }
});

test("visual-gated recovery requires a fresh safe analysis and a zero-action verification", async () => {
  let restoreCalls = 0;
  const adapter = {
    id: "test",
    async execute() { return { vendorCode: 0 }; },
    async verify() { return { ok: true, mode: "state" }; },
    async restore() {
      restoreCalls += 1;
      if (restoreCalls === 1) return { ok: false };
      return {
        ok: true,
        safeStateVerified: true,
        visualConfirmationRequired: true,
        zeroActionVerified: true,
      };
    },
  };
  const f = fixture({
    capabilities: [manifest("test.restore", {
      restoration: { required: true, description: "must restore" },
    })],
    adapter,
  });
  try {
    const job = f.control.submitJob({
      idempotencyKey: "restore-visual-gate",
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      capabilityId: "test.restore",
      params: {},
    }).job;
    assert.equal((await f.control.waitForJob(job.jobId)).status, "recovery_required");
    f.state.appendEvent({
      jobId: job.jobId,
      runId: job.runId,
      type: "job.recovery.analysis.recorded",
      payload: {
        analysisResult: {
          inspectionId: "inspection-test",
          imageSha256: "d".repeat(64),
          pageClassification: { pageType: "main-safe", safeStateVerified: true, confidence: 0.98 },
          analysisEvidence: { evidenceId: "evidence-test" },
        },
      },
    });
    const recovered = await f.control.recoverJob({
      jobId: job.jobId,
      actorId: "recovery-agent",
      idempotencyKey: "recover-with-visual-gate",
    });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.restoration.visualConfirmation.inspectionId, "inspection-test");
    assert.equal(recovered.restoration.visualConfirmation.confidence, 0.98);
    assert.equal(f.state.getDevice(job.deviceId).quarantined, false);
  } finally {
    await f.close();
  }
});

test("visual-gated recovery keeps quarantine when no safe analysis exists", async () => {
  let restoreCalls = 0;
  const adapter = {
    id: "test",
    async execute() { return { vendorCode: 0 }; },
    async verify() { return { ok: true, mode: "state" }; },
    async restore() {
      restoreCalls += 1;
      if (restoreCalls === 1) return { ok: false };
      return {
        ok: true,
        safeStateVerified: true,
        visualConfirmationRequired: true,
        zeroActionVerified: true,
      };
    },
  };
  const f = fixture({
    capabilities: [manifest("test.restore", {
      restoration: { required: true, description: "must restore" },
    })],
    adapter,
  });
  try {
    const job = f.control.submitJob({
      idempotencyKey: "restore-visual-gate-missing",
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      capabilityId: "test.restore",
      params: {},
    }).job;
    assert.equal((await f.control.waitForJob(job.jobId)).status, "recovery_required");
    await assert.rejects(
      f.control.recoverJob({
        jobId: job.jobId,
        actorId: "recovery-agent",
        idempotencyKey: "recover-without-visual-gate",
      }),
      (error) => error.code === "RECOVERY_FAILED"
        && error.details?.causeCode === "RECOVERY_VISUAL_CONFIRMATION_REQUIRED",
    );
    assert.equal(f.state.getDevice(job.deviceId).quarantined, true);
    assert.equal(f.state.listLeases().length, 0);
  } finally {
    await f.close();
  }
});

test("audited recovery inspection attaches a screenshot and never clears quarantine", async () => {
  let inspectionCalls = 0;
  const adapter = {
    id: "test",
    async execute() { return { vendorCode: 0 }; },
    async verify() { return { ok: true, mode: "state" }; },
    async restore() { return { ok: false, step: "not-on-safe-page" }; },
    async inspectRecovery({ evidenceDirectory, leaseAuthorization }) {
      inspectionCalls += 1;
      const screenshot = join(evidenceDirectory, "inspect.png");
      writeFileSync(screenshot, Buffer.from("fake-png-evidence"));
      return {
        ok: true,
        step: "recovery-inspected",
        stoppedBeforeAction: true,
        leaseKindObserved: leaseAuthorization ? "recovery" : null,
        observation: {
          focus: {
            package: "com.taobao.idlefish",
            activity: "com.taobao.idlefish.maincontainer.activity.MainActivity",
          },
          pageClassification: {
            schemaVersion: 1,
            pageType: "unknown",
            confidence: 0,
            safeStateVerified: false,
            reasons: ["visual analysis pending"],
          },
        },
        evidenceFiles: [{ path: screenshot, kind: "screenshot", label: "recovery-inspect" }],
      };
    },
  };
  const f = fixture({
    capabilities: [manifest("test.restore", {
      restoration: { required: true, description: "must restore" },
    })],
    adapter,
  });
  try {
    const job = f.control.submitJob({
      idempotencyKey: "inspect-after-failure",
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      capabilityId: "test.restore",
      params: {},
    }).job;
    assert.equal((await f.control.waitForJob(job.jobId)).status, "recovery_required");

    const inspection = await f.control.inspectRecovery({
      jobId: job.jobId,
      actorId: "inspection-agent",
      idempotencyKey: "inspect-once",
    });
    assert.equal(inspection.ok, true);
    assert.equal(inspection.reused, false);
    assert.equal(inspection.stoppedBeforeAction, true);
    assert.equal(inspection.quarantineCleared, false);
    assert.equal(inspection.screenshot.kind, "screenshot");
    assert.match(inspection.screenshot.sha256, /^[a-f0-9]{64}$/);
    assert.equal(inspection.pageClassification.pageType, "unknown");
    assert.equal(f.state.getDevice(job.deviceId).quarantined, true);
    assert.equal(f.state.listLeases().length, 0);
    assert.deepEqual(
      f.state.listJobEvents(job.jobId)
        .filter((event) => event.type.startsWith("job.recovery.inspect."))
        .map((event) => event.type),
      ["job.recovery.inspect.started", "job.recovery.inspect.succeeded"],
    );
    assert.equal(f.state.listEvidence(job.runId).some((item) => item.kind === "screenshot"), true);
    assert.equal(f.state.listEvidence(job.runId).some((item) => item.kind === "recovery_inspection"), true);

    const replay = await f.control.inspectRecovery({
      jobId: job.jobId,
      actorId: "inspection-agent",
      idempotencyKey: "inspect-once",
    });
    assert.equal(replay.reused, true);
    assert.equal(inspectionCalls, 1);

    await assert.rejects(f.control.recordRecoveryInspectionAnalysis({
      jobId: job.jobId,
      inspectionId: inspection.inspectionId,
      actorId: "inspection-agent",
      idempotencyKey: "analysis-wrong-hash",
      analysis: {
        schemaVersion: "xhs.visual-elements.v1",
        image: { sha256: "b".repeat(64), resolution: [1080, 2400] },
        analyzer: { name: "visual-grounding-poc", version: "test", timings: { hotPathMs: 1200 } },
        elements: [],
      },
    }), { code: "RECOVERY_ANALYSIS_REJECTED" });

    const analysis = await f.control.recordRecoveryInspectionAnalysis({
      jobId: job.jobId,
      inspectionId: inspection.inspectionId,
      actorId: "inspection-agent",
      idempotencyKey: "analysis-once",
      analysis: {
        schemaVersion: "xhs.visual-elements.v1",
        image: { sha256: inspection.screenshot.sha256, resolution: [1080, 2400] },
        analyzer: { name: "visual-grounding-poc", version: "test", timings: { hotPathMs: 1200 } },
        elements: [
          { id: "home", label: "闲鱼", bounds: [0, 2140, 220, 2320], conf: 0.99, source: "ocr" },
          { id: "messages", label: "消息", bounds: [610, 2140, 800, 2320], conf: 0.99, source: "ocr" },
          { id: "mine", label: "我的", bounds: [850, 2140, 1070, 2320], conf: 0.99, source: "ocr" },
        ],
      },
    });
    assert.equal(analysis.pageClassification.pageType, "main-safe");
    assert.equal(analysis.pageClassification.safeStateVerified, true);
    assert.equal(analysis.quarantineCleared, false);
    assert.equal(f.state.getDevice(job.deviceId).quarantined, true);
    assert.equal(f.state.listEvidence(job.runId).some((item) => item.kind === "recovery_analysis"), true);

    const replayedAnalysis = await f.control.recordRecoveryInspectionAnalysis({
      jobId: job.jobId,
      inspectionId: inspection.inspectionId,
      actorId: "inspection-agent",
      idempotencyKey: " analysis-once ",
      analysis: {
        schemaVersion: "xhs.visual-elements.v1",
        image: { sha256: inspection.screenshot.sha256, resolution: [1080, 2400] },
        analyzer: { name: "visual-grounding-poc", version: "test", timings: { hotPathMs: 1200 } },
        elements: [
          { id: "home", label: "闲鱼", bounds: [0, 2140, 220, 2320], conf: 0.99, source: "ocr" },
          { id: "messages", label: "消息", bounds: [610, 2140, 800, 2320], conf: 0.99, source: "ocr" },
          { id: "mine", label: "我的", bounds: [850, 2140, 1070, 2320], conf: 0.99, source: "ocr" },
        ],
      },
    });
    assert.equal(replayedAnalysis.reused, true);
    await assert.rejects(f.control.recordRecoveryInspectionAnalysis({
      jobId: job.jobId,
      inspectionId: inspection.inspectionId,
      actorId: "inspection-agent",
      idempotencyKey: "analysis-once",
      analysis: {},
    }), { code: "IDEMPOTENCY_KEY_CONFLICT" });
  } finally {
    await f.close();
  }
});

test("failed recovery inspection releases its lease and preserves quarantine", async () => {
  const adapter = {
    id: "test",
    async execute() { return { vendorCode: 0 }; },
    async verify() { return { ok: true, mode: "state" }; },
    async restore() { return { ok: false }; },
    async inspectRecovery() {
      throw new ControlPlaneError("ADAPTER_FAILED", "adapter process failed", {
        details: {
          adapterCode: "GATEWAY_DEVICE_PROBE_FAILED",
          privateMessage: "must not escape",
        },
      });
    },
  };
  const f = fixture({
    capabilities: [manifest("test.restore", {
      restoration: { required: true, description: "must restore" },
    })],
    adapter,
  });
  try {
    const job = f.control.submitJob({
      idempotencyKey: "inspect-failure",
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      capabilityId: "test.restore",
      params: {},
    }).job;
    assert.equal((await f.control.waitForJob(job.jobId)).status, "recovery_required");
    await assert.rejects(f.control.inspectRecovery({
      jobId: job.jobId,
      actorId: "inspection-agent",
      idempotencyKey: "inspect-fails",
    }), (error) => error.code === "RECOVERY_INSPECTION_FAILED"
      && error.details?.adapterCode === "GATEWAY_DEVICE_PROBE_FAILED"
      && !JSON.stringify(error.details).includes("must not escape"));
    await assert.rejects(f.control.inspectRecovery({
      jobId: job.jobId,
      actorId: "inspection-agent",
      idempotencyKey: " inspect-fails ",
    }), { code: "RECOVERY_INSPECTION_PREVIOUSLY_FAILED" });
    assert.equal(f.state.getDevice(job.deviceId).quarantined, true);
    assert.equal(f.state.listLeases().length, 0);
    const failedEvent = f.state.listJobEvents(job.jobId)
      .find((event) => event.type === "job.recovery.inspect.failed");
    assert.equal(failedEvent.payload.adapterCode, "GATEWAY_DEVICE_PROBE_FAILED");
    assert.equal(JSON.stringify(failedEvent.payload).includes("must not escape"), false);
  } finally {
    await f.close();
  }
});

test("E1 lab actions require an exclusive canary session and valid token", async () => {
  let executions = 0;
  const adapter = {
    id: "test",
    async execute() { executions += 1; return { vendorCode: 0 }; },
    async verify() { return { ok: true, mode: "state" }; },
    async restore() { return { ok: true }; },
  };
  const lab = manifest("test.lab", {
    maturity: "E1",
    automationPolicy: { mode: "lab_only", canaryOnly: true },
    availability: "canary_only",
  });
  const f = fixture({ capabilities: [lab], adapter });
  try {
    assert.throws(() => f.control.submitJob({
      idempotencyKey: "not-lab",
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      capabilityId: lab.id,
      params: {},
    }), { code: "CANARY_SESSION_REQUIRED" });
    const session = f.control.createSession({
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      canary: true,
    });
    await assert.rejects(
      f.control.executeSessionAction(session.sessionId, "wrong", {
        idempotencyKey: "bad-token",
        capabilityId: lab.id,
        params: {},
      }),
      { code: "SESSION_TOKEN_INVALID" },
    );
    const job = await f.control.executeSessionAction(session.sessionId, session.token, {
      idempotencyKey: "lab-action",
      capabilityId: lab.id,
      params: {},
    });
    assert.equal(job.status, "succeeded");
    assert.equal(job.routeDecision.decision, "dispatchable");
    assert.equal(job.routeDecision.activeLease, true);
    assert.equal(job.routeDecision.reusesSessionLease, true);
    assert.equal(job.deviceId, session.deviceId);
    assert.equal(executions, 1);
    const replay = await f.control.executeSessionAction(session.sessionId, session.token, {
      idempotencyKey: "lab-action",
      capabilityId: lab.id,
      params: {},
    });
    assert.equal(replay.jobId, job.jobId);
    assert.equal(executions, 1);
    assert.equal(f.control.releaseSession(session.sessionId, session.token).released, true);
    const nonCanarySession = f.control.createSession({
      actorId: "agent-b",
      deviceId: f.devices[1].deviceId,
    });
    await assert.rejects(
      f.control.executeSessionAction(nonCanarySession.sessionId, nonCanarySession.token, {
        idempotencyKey: "lab-without-canary",
        capabilityId: lab.id,
        params: {},
      }),
      { code: "CANARY_SESSION_REQUIRED", status: 403 },
    );
    assert.equal(f.control.releaseSession(nonCanarySession.sessionId, nonCanarySession.token).released, true);
  } finally {
    await f.close();
  }
});

test("session actions are serialized per device and an active action blocks release", async () => {
  const gate = deferred();
  let executions = 0;
  const adapter = {
    id: "test",
    async execute() {
      executions += 1;
      await gate.promise;
      return { vendorCode: 0 };
    },
    async verify() { return { ok: true, mode: "state" }; },
    async restore() { return { ok: true }; },
  };
  const lab = manifest("test.lab", {
    maturity: "E1",
    automationPolicy: { mode: "lab_only", canaryOnly: true },
    availability: "canary_only",
  });
  const f = fixture({ capabilities: [lab], adapter });
  let session;
  try {
    session = f.control.createSession({
      actorId: "agent-a",
      deviceId: f.devices[0].deviceId,
      canary: true,
    });
    const running = f.control.executeSessionAction(session.sessionId, session.token, {
      idempotencyKey: "lab-running",
      capabilityId: lab.id,
      params: {},
    });
    await until(() => executions === 1);
    assert.equal(f.control.activeJobs.has(session.deviceId), true);
    await assert.rejects(
      f.control.executeSessionAction(session.sessionId, session.token, {
        idempotencyKey: "lab-overlap",
        capabilityId: lab.id,
        params: {},
      }),
      { code: "DEVICE_BUSY", status: 423 },
    );
    assert.throws(
      () => f.control.releaseSession(session.sessionId, session.token),
      { code: "SESSION_ACTION_RUNNING", status: 423 },
    );
    gate.resolve();
    assert.equal((await running).status, "succeeded");
    assert.equal(f.control.activeJobs.has(session.deviceId), false);
    assert.equal(f.control.releaseSession(session.sessionId, session.token).released, true);
    session = null;
  } finally {
    gate.resolve();
    if (session) {
      try { f.control.releaseSession(session.sessionId, session.token); } catch {}
    }
    await f.close();
  }
});

test("pump skips quarantined devices and keeps the job queued", async () => {
  let executions = 0;
  const adapter = {
    id: "test",
    async execute() { executions += 1; return { vendorCode: 0 }; },
    async verify() { return { ok: true, mode: "state" }; },
    async restore() { return { ok: true }; },
  };
  const capability = manifest("test.observe");
  const f = fixture({ capabilities: [capability], adapter });
  try {
    await f.control.stop();
    const cap = f.registry.require(capability.id);

    const blocked = f.state.createJob({
      idempotencyKey: "quarantined-queued",
      actorId: "agent-a",
      authorityNodeId: "DESKTOP-3I1EVHE",
      deviceId: f.devices[0].deviceId,
      capability: cap,
      params: {},
    });
    f.evidence.initializeRun({ job: blocked.job, device: f.devices[0] });
    f.state.quarantineDevice(f.devices[0].deviceId, "TEST_QUARANTINE");

    const healthy = f.state.createJob({
      idempotencyKey: "healthy-queued",
      actorId: "agent-b",
      authorityNodeId: "DESKTOP-3I1EVHE",
      deviceId: f.devices[1].deviceId,
      capability: cap,
      params: {},
    });
    f.evidence.initializeRun({ job: healthy.job, device: f.devices[1] });

    await assert.doesNotReject(() => f.control.pump());
    assert.equal(f.state.requireJob(blocked.job.jobId).status, "queued");
    await until(() => f.state.requireJob(healthy.job.jobId).status === "succeeded");
    assert.equal(executions, 1);

    f.state.clearDeviceQuarantine(f.devices[0].deviceId);
    await assert.doesNotReject(() => f.control.pump());
    await until(() => f.state.requireJob(blocked.job.jobId).status === "succeeded");
    assert.equal(executions, 2);
  } finally {
    await f.close();
  }
});

test("pump skips offline devices and start does not crash on residual queued jobs", async () => {
  let executions = 0;
  const adapter = {
    id: "test",
    async execute() { executions += 1; return { vendorCode: 0 }; },
    async verify() { return { ok: true, mode: "state" }; },
    async restore() { return { ok: true }; },
  };
  const capability = manifest("test.observe");
  const f = fixture({ capabilities: [capability], adapter });
  try {
    await f.control.stop();
    const cap = f.registry.require(capability.id);

    const offlineJob = f.state.createJob({
      idempotencyKey: "offline-queued",
      actorId: "agent-a",
      authorityNodeId: "DESKTOP-3I1EVHE",
      deviceId: f.devices[0].deviceId,
      capability: cap,
      params: {},
    });
    f.evidence.initializeRun({ job: offlineJob.job, device: f.devices[0] });

    const device = f.state.getDevice(f.devices[0].deviceId, { includeRuntime: true });
    f.state.upsertDevice({
      deviceId: device.deviceId,
      alias: device.alias,
      physicalLabel: device.physicalLabel,
      nodeId: device.nodeId,
      runtimeId: device.runtimeId,
      metadata: device.metadata,
      routingProfile: device.routingProfile,
      online: false,
    });

    // Simulates control-plane restart with leftover queued work for an offline device.
    f.control.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(f.state.requireJob(offlineJob.job.jobId).status, "queued");
    assert.equal(executions, 0);

    f.state.upsertDevice({
      deviceId: device.deviceId,
      alias: device.alias,
      physicalLabel: device.physicalLabel,
      nodeId: device.nodeId,
      runtimeId: device.runtimeId,
      metadata: device.metadata,
      routingProfile: device.routingProfile,
      online: true,
    });
    await until(() => f.state.requireJob(offlineJob.job.jobId).status === "succeeded");
    assert.equal(executions, 1);
  } finally {
    await f.close();
  }
});
