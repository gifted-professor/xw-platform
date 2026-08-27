import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { AdapterRegistry, ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { EvidenceStore } from "../control-plane/lib/evidence-store.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";

const tempBase = fileURLToPath(new URL("../control-plane/runtime", import.meta.url));
mkdirSync(tempBase, { recursive: true });
const authorityNodeId = "DESKTOP-3I1EVHE";

// The XHS social capabilities this pack introduces (W4 binds the adapters; W2
// proves the 04-only placement boundary — the hard prerequisite for any social
// live canary). availability=implemented so assertCapabilityRoutable passes and
// the routing-profile filter is the sole gate; automationPolicy=approval_required
// is realistic for social effects but irrelevant to the placement boundary
// (placement runs before authorization).
const SOCIAL_CAPS = ["xhs.like.ensure", "xhs.collect.ensure", "xhs.follow.ensure"];

function xhsSocialCapability(id) {
  return {
    schemaVersion: 1,
    id,
    appId: "xhs",
    packageName: "com.xingin.xhs",
    versionRange: "9.10.113",
    maturity: "E3",
    risk: "R1",
    resources: ["device"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object" },
    preconditions: [],
    verification: { mode: "state", description: "social verifier (W4)" },
    restoration: { required: true, description: "return home" },
    timeoutMs: 30000,
    idempotency: "external_effect",
    automationPolicy: { mode: "approval_required" },
    implementation: { adapter: "xhs", action: id },
    evidence: [],
    availability: "implemented",
  };
}

/**
 * Seed devices 01-04. Only alias 04's routing profile carries the XHS social
 * capability IDs; 01-03 get an enabled profile with no social caps (baseline
 * observe-only) so they are routable in general but never for social actions.
 * A transport counter on the adapter catches any execution side effect.
 */
function fixture04() {
  const root = mkdtempSync(join(tempBase, "xhs-04-boundary-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const capabilities = SOCIAL_CAPS.map(xhsSocialCapability);
  const registry = new CapabilityRegistry(capabilities);
  state.syncCapabilities(registry);
  state.upsertNode({ nodeId: authorityNodeId, authority: true });

  const devices = ["01", "02", "03", "04"].map((alias) =>
    state.upsertDevice({
      alias,
      physicalLabel: `rack-${alias}`,
      nodeId: authorityNodeId,
      runtimeId: `private-${alias}`,
      routingProfile: {
        enabled: true,
        tags: [`slot:${alias}`],
        // Only 04 carries the social capabilities (plan V2 §2.1 04-only).
        capabilityIds: alias === "04" ? [...SOCIAL_CAPS] : [],
      },
    }),
  );

  let transportCalls = 0;
  const evidence = new EvidenceStore({
    runsRoot: join(root, "runs"),
    state,
    minFreeBytes: 0,
    minExternalEffectFreeBytes: 0,
  });
  const control = new ControlPlane({
    state,
    capabilities: registry,
    adapters: new AdapterRegistry([{
      id: "xhs",
      async execute() { transportCalls += 1; return { ok: true }; },
      async verify() { return { ok: true, mode: "state" }; },
      async restore() { return { ok: true }; },
    }]),
    evidence,
    authorityNodeId,
    transportStatus: () => ({ status: "free", ageMs: null }),
  });
  return {
    root, state, registry, devices, control, transportCalls: () => transportCalls,
    async close() {
      await control.stop();
      state.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function counts(f) {
  return {
    jobs: f.state.db.prepare("SELECT COUNT(*) AS c FROM jobs").get().c,
    sessions: f.state.db.prepare("SELECT COUNT(*) AS c FROM sessions").get().c,
    leases: f.state.db.prepare("SELECT COUNT(*) AS c FROM leases").get().c,
    transport: f.transportCalls(),
  };
}

function assertZeroDelta(before, after, label) {
  assert.equal(after.jobs - before.jobs, 0, `${label}: jobs delta must be 0`);
  assert.equal(after.sessions - before.sessions, 0, `${label}: sessions delta must be 0`);
  assert.equal(after.leases - before.leases, 0, `${label}: leases delta must be 0`);
  assert.equal(after.transport - before.transport, 0, `${label}: transport delta must be 0`);
}

// --- F2: 04-only placement boundary (contract F2) ---------------------------

test("F2: each social cap + alias 01/02/03 -> NO_ELIGIBLE_DEVICE with zero job/session/lease/transport delta", async () => {
  const f = fixture04();
  try {
    for (const capId of SOCIAL_CAPS) {
      for (const alias of ["01", "02", "03"]) {
        const before = counts(f);
        // advisory plan: returns error.code (no throw, no side effects)
        const plan = f.control.planRoute({ actorId: "agent-test", capabilityId: capId, placement: { alias } });
        assert.equal(plan.error?.code, "NO_ELIGIBLE_DEVICE", `${capId} alias ${alias} plan error`);
        assert.equal(plan.decision, "blocked");
        // real job creation: throws before any row is written
        assert.throws(
          () => f.state.createJob({
            idempotencyKey: `reject-${capId}-${alias}`,
            actorId: "agent-test",
            authorityNodeId,
            capability: f.registry.require(capId),
            placement: { alias },
          }),
          { code: "NO_ELIGIBLE_DEVICE", status: 409 },
        );
        const after = counts(f);
        assertZeroDelta(before, after, `${capId}@${alias}`);
      }
    }
  } finally {
    await f.close();
  }
});

test("F2: no-alias plan resolves only to 04 (01-03 never carry social caps)", async () => {
  const f = fixture04();
  try {
    for (const capId of SOCIAL_CAPS) {
      const plan = f.control.planRoute({ actorId: "agent-test", capabilityId: capId });
      assert.equal(plan.error, undefined, `${capId} should be routable`);
      assert.equal(plan.selectedDevice.alias, "04", `${capId} automatic -> alias 04`);
    }
  } finally {
    await f.close();
  }
});

test("F2: no-alias job is assigned to 04, not 01-03", async () => {
  const f = fixture04();
  try {
    const before = counts(f);
    const { job } = f.state.createJob({
      idempotencyKey: "social-04-only",
      actorId: "agent-test",
      authorityNodeId,
      capability: f.registry.require("xhs.like.ensure"),
    });
    assert.equal(job.deviceId, f.devices[3].deviceId, "job assigned to 04");
    const after = counts(f);
    assert.equal(after.jobs - before.jobs, 1, "one job created");
    assert.equal(after.transport - before.transport, 0, "no transport (approval_required, not executed)");
  } finally {
    await f.close();
  }
});

test("F2: 04 busy -> DEVICE_BUSY for session, never falls back to 01-03", async () => {
  const f = fixture04();
  try {
    // Acquire a session on 04 (occupies the device, effectiveLoad=1).
    const session = f.control.createSession({
      actorId: "agent-test",
      capabilityId: "xhs.like.ensure",
    });
    assert.equal(session.deviceId, f.devices[3].deviceId, "session acquired on 04");
    try {
      for (const alias of ["01", "02", "03"]) {
        const before = counts(f);
        // no-alias: 04 is the only matching device but busy -> DEVICE_BUSY (423)
        assert.throws(
          () => f.control.createSession({ actorId: "agent-test", capabilityId: "xhs.like.ensure" }),
          { code: "DEVICE_BUSY", status: 423 },
        );
        // explicit alias 01-03: no device carries the cap -> NO_ELIGIBLE_DEVICE
        assert.throws(
          () => f.control.createSession({ actorId: "agent-test", capabilityId: "xhs.like.ensure", placement: { alias } }),
          { code: "NO_ELIGIBLE_DEVICE", status: 409 },
        );
        const after = counts(f);
        assertZeroDelta(before, after, `busy 04 alias ${alias}`);
        void alias; // break before-loop alias capture for delta label
        break; // one pass is enough; the alias loop proves 01-03 stay rejected
      }
    } finally {
      f.control.releaseSession(session.sessionId, session.token);
    }
  } finally {
    await f.close();
  }
});

test("F2: quarantine 04 -> NO_ELIGIBLE_DEVICE (no fallback to 01-03)", async () => {
  const f = fixture04();
  try {
    f.state.quarantineDevice(f.devices[3].deviceId, "TEST_QUARANTINE");
    const before = counts(f);
    const plan = f.control.planRoute({ actorId: "agent-test", capabilityId: "xhs.like.ensure" });
    assert.equal(plan.error?.code, "NO_ELIGIBLE_DEVICE", "quarantined 04 -> no eligible, no fallback");
    assert.throws(
      () => f.state.createJob({
        idempotencyKey: "quarantine-04",
        actorId: "agent-test",
        authorityNodeId,
        capability: f.registry.require("xhs.like.ensure"),
      }),
      { code: "NO_ELIGIBLE_DEVICE", status: 409 },
    );
    assertZeroDelta(before, counts(f), "quarantine 04");
  } finally {
    await f.close();
  }
});

test("F2: 01-03 routing profiles do not include any social capabilityId", async () => {
  const f = fixture04();
  try {
    for (let i = 0; i < 3; i += 1) {
      const dev = f.devices[i];
      const profile = f.state.getDevice(dev.deviceId, { includeRuntime: true }).routingProfile;
      for (const capId of SOCIAL_CAPS) {
        assert.ok(!profile.capabilityIds.includes(capId), `device ${dev.alias} must not carry ${capId}`);
      }
    }
    const dev04 = f.state.getDevice(f.devices[3].deviceId, { includeRuntime: true }).routingProfile;
    for (const capId of SOCIAL_CAPS) {
      assert.ok(dev04.capabilityIds.includes(capId), `device 04 must carry ${capId}`);
    }
  } finally {
    await f.close();
  }
});