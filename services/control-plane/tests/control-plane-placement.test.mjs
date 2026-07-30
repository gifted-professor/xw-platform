import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { fingerprint } from "../control-plane/lib/canonical.mjs";
import { AdapterRegistry, ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { EvidenceStore } from "../control-plane/lib/evidence-store.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";

const tempBase = fileURLToPath(new URL("../control-plane/runtime", import.meta.url));
mkdirSync(tempBase, { recursive: true });
const authorityNodeId = "DESKTOP-3I1EVHE";

function capability(id = "test.observe", overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    appId: "test",
    packageName: "local.test",
    versionRange: "test",
    maturity: "E3",
    risk: "R0",
    resources: ["device"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object" },
    preconditions: [],
    verification: { mode: "state", description: "test" },
    restoration: { required: false, description: "none" },
    timeoutMs: 1000,
    idempotency: "read_only",
    automationPolicy: { mode: "automatic" },
    implementation: { adapter: "test", action: "observe" },
    evidence: [],
    availability: "implemented",
    ...overrides,
  };
}

function fixture(capabilities = [capability()]) {
  const root = mkdtempSync(join(tempBase, "placement-test-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const registry = new CapabilityRegistry(capabilities);
  state.syncCapabilities(registry);
  state.upsertNode({ nodeId: authorityNodeId, authority: true });
  const capabilityIds = capabilities.map((item) => item.id);
  const devices = ["01", "02"].map((alias) => state.upsertDevice({
    alias,
    physicalLabel: `rack-${alias}`,
    nodeId: authorityNodeId,
    runtimeId: `private-${alias}`,
    routingProfile: {
      enabled: true,
      tags: [`slot:${alias}`],
      capabilityIds,
    },
  }));
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
      id: "test",
      async execute() { return {}; },
      async verify() { return { ok: true, mode: "state" }; },
      async restore() { return { ok: true }; },
    }]),
    evidence,
    authorityNodeId,
    transportStatus: () => ({ status: "free", ageMs: null }),
  });
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

test("route plan is advisory and automatic jobs are assigned atomically by least load", async () => {
  const f = fixture();
  try {
    const beforeJobs = f.state.db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count;
    const beforeEvents = f.state.db.prepare("SELECT COUNT(*) AS count FROM events").get().count;
    const plan = f.control.planRoute({
      actorId: "agent-a",
      capabilityId: "test.observe",
    });
    assert.equal(plan.advisory, true);
    assert.equal(plan.decision, "dispatchable");
    assert.equal(plan.selectedDeviceId, f.devices[0].deviceId);
    assert.equal(f.state.db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, beforeJobs);
    assert.equal(f.state.db.prepare("SELECT COUNT(*) AS count FROM events").get().count, beforeEvents);

    const first = f.state.createJob({
      idempotencyKey: "auto-first",
      actorId: "agent-a",
      authorityNodeId,
      capability: f.registry.require("test.observe"),
    }).job;
    const second = f.state.createJob({
      idempotencyKey: "auto-second",
      actorId: "agent-b",
      authorityNodeId,
      capability: f.registry.require("test.observe"),
    }).job;
    assert.equal(first.deviceId, f.devices[0].deviceId);
    assert.equal(second.deviceId, f.devices[1].deviceId);
    assert.equal(first.routeDecision.mode, "automatic");
    assert.equal(second.routeDecision.queueDepth, 0);
    assert.equal(f.state.listJobEvents(first.jobId)[0].type, "route.assigned");

    const constrained = f.state.createJob({
      idempotencyKey: "tagged",
      actorId: "agent-c",
      authorityNodeId,
      placement: { requiredTags: ["slot:02"] },
      capability: f.registry.require("test.observe"),
    }).job;
    assert.equal(constrained.deviceId, f.devices[1].deviceId);
  } finally {
    await f.close();
  }
});

test("concurrent automatic submissions balance devices and idempotency preserves the original route", async () => {
  const f = fixture();
  try {
    const [first, second] = await Promise.all([
      Promise.resolve().then(() => f.state.createJob({
        idempotencyKey: "concurrent-first",
        actorId: "agent-a",
        authorityNodeId,
        capability: f.registry.require("test.observe"),
      })),
      Promise.resolve().then(() => f.state.createJob({
        idempotencyKey: "concurrent-second",
        actorId: "agent-b",
        authorityNodeId,
        capability: f.registry.require("test.observe"),
      })),
    ]);
    assert.notEqual(first.job.deviceId, second.job.deviceId);
    const reused = f.state.createJob({
      idempotencyKey: "concurrent-first",
      actorId: "agent-a",
      authorityNodeId,
      capability: f.registry.require("test.observe"),
    });
    assert.equal(reused.reused, true);
    assert.equal(reused.job.deviceId, first.job.deviceId);
    assert.throws(() => f.state.createJob({
      idempotencyKey: "concurrent-first",
      actorId: "agent-a",
      authorityNodeId,
      placement: { requiredTags: ["slot:02"] },
      capability: f.registry.require("test.observe"),
    }), { code: "IDEMPOTENCY_CONFLICT", status: 409 });
    assert.throws(() => f.state.createJob({
      idempotencyKey: "concurrent-first",
      actorId: "agent-other",
      authorityNodeId,
      capability: f.registry.require("test.observe"),
    }), { code: "IDEMPOTENCY_CONFLICT", status: 409 });
  } finally {
    await f.close();
  }
});

test("all busy devices queue normal jobs while automatic sessions fail with 423", async () => {
  const f = fixture();
  const sessions = [];
  try {
    for (const alias of ["01", "02"]) {
      sessions.push(f.state.createSession({
        actorId: `agent-${alias}`,
        authorityNodeId,
        placement: { requiredTags: [`slot:${alias}`] },
        capability: f.registry.require("test.observe"),
      }));
    }
    const job = f.state.createJob({
      idempotencyKey: "busy-job",
      actorId: "agent-job",
      authorityNodeId,
      capability: f.registry.require("test.observe"),
    }).job;
    assert.equal(job.deviceId, f.devices[0].deviceId);
    assert.equal(job.routeDecision.decision, "queue");
    assert.equal(job.routeDecision.activeLease, true);
    assert.throws(() => f.state.createSession({
      actorId: "agent-session",
      authorityNodeId,
      capability: f.registry.require("test.observe"),
    }), { code: "DEVICE_BUSY", status: 423 });
  } finally {
    for (const session of sessions) {
      try { f.state.releaseSession(session.sessionId, session.token); } catch {}
    }
    await f.close();
  }
});

test("routing is fail-closed for selectors, unavailable nodes, and dependency-pending capabilities", async () => {
  const pending = capability("test.pending", { availability: "dependency_pending" });
  const f = fixture([capability(), pending]);
  try {
    assert.equal(f.control.planRoute({
      actorId: "agent-a",
      capabilityId: "test.pending",
    }).error.code, "NO_ELIGIBLE_DEVICE");
    assert.equal(f.control.planRoute({
      actorId: "agent-a",
      capabilityId: "test.observe",
      placement: { nodeId: "OTHER-WINDOWS" },
    }).error.code, "NODE_UNAVAILABLE");
    assert.equal(f.control.planRoute({
      actorId: "agent-a",
      capabilityId: "test.observe",
      deviceId: f.devices[0].deviceId,
      placement: { requiredTags: ["slot:01"] },
    }).error.code, "PLACEMENT_CONFLICT");

    f.state.quarantineDevice(f.devices[0].deviceId, "TEST");
    const plan = f.control.planRoute({
      actorId: "agent-a",
      capabilityId: "test.observe",
    });
    assert.equal(plan.selectedDeviceId, f.devices[1].deviceId);
  } finally {
    await f.close();
  }
});

test("automatic sessions are capability scoped", async () => {
  const f = fixture([capability("test.observe"), capability("test.other")]);
  let session;
  try {
    session = f.control.createSession({
      actorId: "agent-a",
      capabilityId: "test.observe",
    });
    assert.equal(session.scopeCapabilityId, "test.observe");
    await assert.rejects(
      f.control.executeSessionAction(session.sessionId, session.token, {
        idempotencyKey: "wrong-scope",
        capabilityId: "test.other",
      }),
      { code: "SESSION_CAPABILITY_MISMATCH", status: 409 },
    );
  } finally {
    if (session) f.control.releaseSession(session.sessionId, session.token);
    await f.close();
  }
});

test("canary-only capabilities can be auto-routed only into canary sessions", async () => {
  const lab = capability("test.lab", {
    maturity: "E1",
    availability: "canary_only",
    automationPolicy: { mode: "lab_only", canaryOnly: true },
  });
  const f = fixture([lab]);
  let session;
  try {
    assert.throws(() => f.control.createSession({
      actorId: "agent-a",
      capabilityId: "test.lab",
    }), { code: "CANARY_SESSION_REQUIRED", status: 403 });
    assert.throws(() => f.state.createJob({
      idempotencyKey: "lab-job-placement",
      actorId: "agent-a",
      authorityNodeId,
      capability: f.registry.require("test.lab"),
      canary: true,
    }), { code: "NO_ELIGIBLE_DEVICE", status: 409 });
    session = f.control.createSession({
      actorId: "agent-a",
      capabilityId: "test.lab",
      canary: true,
    });
    assert.equal(session.scopeCapabilityId, "test.lab");
  } finally {
    if (session) f.control.releaseSession(session.sessionId, session.token);
    await f.close();
  }
});

test("v1 SQLite state migrates additively and preserves legacy idempotency", () => {
  const root = mkdtempSync(join(tempBase, "migration-test-"));
  const dbPath = join(root, "control.db");
  const raw = new DatabaseSync(dbPath);
  const manifest = capability();
  const createdAt = Date.now();
  const legacyFingerprint = fingerprint({
    deviceId: "dev_legacy",
    capabilityId: manifest.id,
    params: {},
    canary: false,
    sessionId: null,
  });
  raw.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE devices (
      device_id TEXT PRIMARY KEY, alias TEXT NOT NULL, physical_label TEXT NOT NULL,
      node_id TEXT NOT NULL, runtime_id TEXT, metadata_json TEXT NOT NULL DEFAULT '{}',
      online INTEGER NOT NULL DEFAULT 1, quarantined INTEGER NOT NULL DEFAULT 0,
      quarantine_reason TEXT, updated_at INTEGER NOT NULL, UNIQUE(node_id, alias)
    );
    CREATE TABLE capabilities (
      capability_id TEXT PRIMARY KEY, app_id TEXT NOT NULL, maturity TEXT NOT NULL,
      risk TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      manifest_json TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL UNIQUE,
      request_fingerprint TEXT NOT NULL, actor_id TEXT NOT NULL,
      device_id TEXT NOT NULL REFERENCES devices(device_id),
      capability_id TEXT NOT NULL REFERENCES capabilities(capability_id),
      capability_json TEXT NOT NULL, params_json TEXT NOT NULL,
      canary INTEGER NOT NULL DEFAULT 0, session_id TEXT, status TEXT NOT NULL,
      approval_required INTEGER NOT NULL DEFAULT 0, external_effect INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER,
      finished_at INTEGER, error_code TEXT, result_json TEXT
    );
    CREATE TABLE leases (
      lease_id TEXT PRIMARY KEY, device_id TEXT NOT NULL UNIQUE REFERENCES devices(device_id),
      kind TEXT NOT NULL, holder_id TEXT NOT NULL, job_id TEXT, token_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, lease_id TEXT NOT NULL UNIQUE REFERENCES leases(lease_id),
      actor_id TEXT NOT NULL, device_id TEXT NOT NULL REFERENCES devices(device_id),
      token_hash TEXT NOT NULL, canary INTEGER NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    PRAGMA user_version = 1;
  `);
  raw.prepare(`
    INSERT INTO devices (
      device_id, alias, physical_label, node_id, runtime_id, metadata_json, online,
      quarantined, updated_at
    ) VALUES (?, ?, ?, ?, ?, '{}', 1, 0, ?)
  `).run("dev_legacy", "01", "rack-01", authorityNodeId, "private-legacy", createdAt);
  raw.prepare(`
    INSERT INTO capabilities (
      capability_id, app_id, maturity, risk, enabled, manifest_json, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(manifest.id, manifest.appId, manifest.maturity, manifest.risk, JSON.stringify(manifest), createdAt);
  raw.prepare(`
    INSERT INTO jobs (
      job_id, run_id, idempotency_key, request_fingerprint, actor_id, device_id,
      capability_id, capability_json, params_json, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', 'succeeded', ?, ?)
  `).run(
    "job_legacy",
    "run_legacy",
    "legacy-key",
    legacyFingerprint,
    "agent-a",
    "dev_legacy",
    manifest.id,
    JSON.stringify(manifest),
    createdAt,
    createdAt,
  );
  raw.close();

  const state = new StateStore({ dbPath });
  try {
    assert.equal(state.db.prepare("PRAGMA user_version").get().user_version, 6);
    assert.ok(state.db.prepare("PRAGMA table_info(jobs)").all().some((column) => column.name === "placement_decision_json"));
    assert.ok(state.db.prepare("PRAGMA table_info(sessions)").all().some((column) => column.name === "scope_capability_id"));
    assert.equal(state.requireJob("job_legacy").status, "succeeded");
    state.upsertNode({ nodeId: authorityNodeId, authority: true });
    state.upsertDevice({
      deviceId: "dev_legacy",
      alias: "01",
      physicalLabel: "rack-01",
      nodeId: authorityNodeId,
      runtimeId: "private-legacy",
      routingProfile: { enabled: true, capabilityIds: [manifest.id] },
    });
    const reused = state.createJob({
      idempotencyKey: "legacy-key",
      actorId: "agent-a",
      authorityNodeId,
      deviceId: "dev_legacy",
      capability: manifest,
    });
    assert.equal(reused.reused, true);
    assert.equal(reused.job.jobId, "job_legacy");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
