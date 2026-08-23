import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { AdapterRegistry, ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { EvidenceStore } from "../control-plane/lib/evidence-store.mjs";
import {
  createFakeObserveProvider,
  FIXTURE_NO_ARTIFACT_REASON,
  fixturePageHash,
} from "../control-plane/lib/open-action-session.mjs";
import {
  CURRENT_CONTROL_SCHEMA_VERSION,
  StateStore,
} from "../control-plane/lib/state-store.mjs";
import { ControlRouter } from "../control-plane/router.mjs";
import { validateDeviceSession, validateObservation } from "../../../packages/kernel/lib/open-action.mjs";

const tempBase = fileURLToPath(new URL("../control-plane/runtime", import.meta.url));
mkdirSync(tempBase, { recursive: true });
const AUTHORITY = "DESKTOP-3I1EVHE";

function capability() {
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
  };
}

function fixture({ observeProvider } = {}) {
  const root = mkdtempSync(join(tempBase, "oa-session-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const caps = new CapabilityRegistry([capability()]);
  state.upsertNode({ nodeId: AUTHORITY, authority: true });
  const device = state.upsertDevice({
    alias: "01",
    physicalLabel: "rack-01",
    nodeId: AUTHORITY,
    runtimeId: "private-01",
    routingProfile: { enabled: true, tags: ["slot:01"], capabilityIds: ["test.observe"] },
  });
  const evidence = new EvidenceStore({
    runsRoot: join(root, "runs"),
    state,
    minFreeBytes: 0,
    minExternalEffectFreeBytes: 0,
  });
  const control = new ControlPlane({
    state,
    evidence,
    capabilities: caps,
    adapters: new AdapterRegistry([{
      id: "test",
      async execute() { return {}; },
      async verify() { return { ok: true }; },
      async restore() { return { ok: true }; },
    }]),
    authorityNodeId: AUTHORITY,
    missionAutoApprovalEnabled: true,
    standingGrantEnabled: true,
    adrAccepted: true,
    discoveryIssuerReady: true,
    discoveryAdrAccepted: true,
    observeProvider,
  });
  const router = new ControlRouter({ control, state, capabilities: caps, evidence });
  return { root, state, device, control, router };
}

function auth(token) {
  return { "x-control-token": token };
}

function writeV15Fixture(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE devices (
      device_id TEXT PRIMARY KEY,
      alias TEXT NOT NULL,
      physical_label TEXT NOT NULL,
      node_id TEXT NOT NULL,
      runtime_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      routing_json TEXT NOT NULL DEFAULT '{"enabled":false,"tags":[],"capabilityIds":[]}',
      online INTEGER NOT NULL DEFAULT 1,
      quarantined INTEGER NOT NULL DEFAULT 0,
      quarantine_reason TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE capabilities (
      capability_id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      maturity TEXT NOT NULL,
      risk TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      manifest_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      request_fingerprint TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      device_id TEXT NOT NULL REFERENCES devices(device_id),
      capability_id TEXT NOT NULL REFERENCES capabilities(capability_id),
      capability_json TEXT NOT NULL,
      params_json TEXT NOT NULL,
      canary INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      status TEXT NOT NULL,
      approval_required INTEGER NOT NULL DEFAULT 0,
      external_effect INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      lease_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      canary INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE evidence (
      evidence_id TEXT PRIMARY KEY,
      job_id TEXT,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE missions (
      mission_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      issuer_actor_id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      mission_hash TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      policy_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    PRAGMA user_version = 15;
  `);
  const now = Date.now();
  db.prepare(`
    INSERT INTO devices (device_id, alias, physical_label, node_id, runtime_id, online, quarantined, updated_at)
    VALUES ('dev_v15', '01', 'rack-01', '${AUTHORITY}', 'rt-v15', 1, 0, ?)
  `).run(now);
  db.prepare(`
    INSERT INTO capabilities (capability_id, app_id, maturity, risk, enabled, manifest_json, updated_at)
    VALUES ('test.observe', 'test', 'E3', 'R0', 1, '{}', ?)
  `).run(now);
  db.prepare(`
    INSERT INTO jobs (
      job_id, run_id, idempotency_key, request_fingerprint, actor_id, device_id,
      capability_id, capability_json, params_json, status, created_at, updated_at
    ) VALUES ('job_v15', 'run_v15', 'legacy-v15', 'fp', 'agent-a', 'dev_v15', 'test.observe', '{}', '{}', 'succeeded', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO evidence (evidence_id, job_id, run_id, kind, path, sha256, bytes, created_at)
    VALUES ('ev_v15', 'job_v15', 'run_v15', 'log', 'log.txt', '${"a".repeat(64)}', 4, ?)
  `).run(now);
  db.prepare(`
    INSERT INTO missions (
      mission_id, idempotency_key, issuer_actor_id, version, mission_hash, content_hash,
      policy_json, status, created_at, updated_at, expires_at
    ) VALUES ('mission_v15', 'm-v15', 'agent-a', 1, 'mh', 'ch', '{}', 'active', ?, ?, ?)
  `).run(now, now, now + 60_000);
  db.close();
}

test("open_action device session acquires the exclusive lease without capabilityId", async () => {
  const f = fixture();
  try {
    const created = await f.router.handle({
      method: "POST",
      path: "/control/v1/device-sessions",
      body: { actorId: "agent-oa", deviceId: f.device.deviceId },
    });
    assert.equal(created.status, 201);
    const session = created.body.session;
    assert.equal(validateDeviceSession(session).ok, true);
    assert.equal(session.sessionKind, "open_action");
    assert.equal(session.capabilityId, null);
    assert.equal(session.deviceId, f.device.deviceId);
    assert.ok(created.body.token);
    assert.equal(created.body.session.token, undefined);
    assert.equal(f.state.listLeases().length, 1);
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("open_action and capability sessions share the one-lease-per-device lock", async () => {
  const f = fixture();
  try {
    const open = await f.router.handle({
      method: "POST",
      path: "/control/v1/device-sessions",
      body: { actorId: "agent-oa", deviceId: f.device.deviceId },
    });
    await assert.rejects(
      () => f.router.handle({
        method: "POST",
        path: "/control/v1/sessions",
        body: { actorId: "agent-cap", deviceId: f.device.deviceId, capabilityId: "test.observe" },
      }),
      { code: "DEVICE_BUSY", status: 423 },
    );
    await f.router.handle({
      method: "POST",
      path: `/control/v1/device-sessions/${open.body.session.sessionId}/release`,
      headers: auth(open.body.token),
      body: {},
    });
    const cap = await f.router.handle({
      method: "POST",
      path: "/control/v1/sessions",
      body: { actorId: "agent-cap", deviceId: f.device.deviceId, capabilityId: "test.observe" },
    });
    assert.equal(cap.status, 201);
    await assert.rejects(
      () => f.router.handle({
        method: "POST",
        path: "/control/v1/device-sessions",
        body: { actorId: "agent-oa-2", deviceId: f.device.deviceId },
      }),
      { code: "DEVICE_BUSY", status: 423 },
    );
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("observe returns a canonical partial ObservationV1 with stable page hashes", async () => {
  const provider = createFakeObserveProvider();
  const f = fixture({ observeProvider: provider });
  try {
    const created = await f.router.handle({
      method: "POST",
      path: "/control/v1/device-sessions",
      body: { actorId: "agent-oa", deviceId: f.device.deviceId },
    });
    const headers = auth(created.body.token);
    const first = await f.router.handle({
      method: "POST",
      path: `/control/v1/device-sessions/${created.body.session.sessionId}/observe`,
      headers,
      body: {},
    });
    const second = await f.router.handle({
      method: "POST",
      path: `/control/v1/device-sessions/${created.body.session.sessionId}/observe`,
      headers,
      body: {},
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.mutatingCalls, 0);
    assert.equal(validateObservation(first.body.observation).ok, true);
    assert.equal(first.body.observation.schemaId, "xw.open-action.observation.v1");
    assert.equal(first.body.observation.screenshotRef, null);
    assert.equal(first.body.observation.screenshotSha256, null);
    assert.equal(first.body.observation.partial, true);
    assert.equal(first.body.observation.partialReason, FIXTURE_NO_ARTIFACT_REASON);
    assert.notEqual(first.body.observation.observationId, second.body.observation.observationId);
    assert.equal(first.body.observation.pageHash, second.body.observation.pageHash);
    assert.equal(first.body.observation.screenshotSha256, second.body.observation.screenshotSha256);
    assert.equal(first.body.observation.pageHash, fixturePageHash());
    assert.equal(JSON.stringify(first.body).includes(created.body.token), false);
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("GET and mutating device-session calls accept only X-Control-Token", async () => {
  const f = fixture();
  try {
    const created = await f.router.handle({
      method: "POST",
      path: "/control/v1/device-sessions",
      body: { actorId: "agent-oa", deviceId: f.device.deviceId },
    });
    const sessionId = created.body.session.sessionId;
    const token = created.body.token;
    await assert.rejects(
      () => f.router.handle({
        method: "GET",
        path: `/control/v1/device-sessions/${sessionId}`,
        query: new URLSearchParams({ token }),
        headers: {},
      }),
      { code: "SESSION_TOKEN_INVALID", status: 403 },
    );
    await assert.rejects(
      () => f.router.handle({
        method: "GET",
        path: `/control/v1/device-sessions/${sessionId}/events`,
        query: new URLSearchParams({ token }),
        headers: {},
      }),
      { code: "SESSION_TOKEN_INVALID", status: 403 },
    );
    await assert.rejects(
      () => f.router.handle({
        method: "POST",
        path: `/control/v1/device-sessions/${sessionId}/observe`,
        headers: {},
        body: { token },
      }),
      { code: "SESSION_TOKEN_INVALID", status: 403 },
    );
    const got = await f.router.handle({
      method: "GET",
      path: `/control/v1/device-sessions/${sessionId}`,
      headers: auth(token),
    });
    assert.equal(got.status, 200);
    assert.equal(got.body.token, undefined);
    assert.equal(got.body.session.token, undefined);
    const events = await f.router.handle({
      method: "GET",
      path: `/control/v1/device-sessions/${sessionId}/events`,
      headers: auth(token),
    });
    assert.equal(events.status, 200);
    assert.equal(JSON.stringify(events.body).includes(token), false);
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("capability and open_action lanes reject each other; device-session actions are unsupported", async () => {
  const f = fixture();
  try {
    const cap = await f.router.handle({
      method: "POST",
      path: "/control/v1/sessions",
      body: { actorId: "agent-cap", deviceId: f.device.deviceId, capabilityId: "test.observe" },
    });
    await assert.rejects(
      () => f.router.handle({
        method: "POST",
        path: `/control/v1/device-sessions/${cap.body.session.sessionId}/observe`,
        headers: auth(cap.body.session.token),
        body: {},
      }),
      { code: "SESSION_KIND_MISMATCH", status: 409 },
    );
    await f.router.handle({
      method: "POST",
      path: `/control/v1/sessions/${cap.body.session.sessionId}/release`,
      body: { token: cap.body.session.token },
    });

    const open = await f.router.handle({
      method: "POST",
      path: "/control/v1/device-sessions",
      body: { actorId: "agent-oa", deviceId: f.device.deviceId },
    });
    await assert.rejects(
      () => f.router.handle({
        method: "POST",
        path: `/control/v1/sessions/${open.body.session.sessionId}/actions`,
        body: { token: open.body.token, idempotencyKey: "nope", capabilityId: "test.observe", params: {} },
      }),
      { code: "SESSION_KIND_MISMATCH", status: 409 },
    );
    await assert.rejects(
      () => f.router.handle({
        method: "POST",
        path: `/control/v1/device-sessions/${open.body.session.sessionId}/actions`,
        headers: auth(open.body.token),
        body: { kind: "observe" },
      }),
      { code: "INVALID_ACTION", status: 400 },
    );
    await assert.rejects(
      () => f.router.handle({
        method: "POST",
        path: `/control/v1/device-sessions/${open.body.session.sessionId}/actions`,
        headers: auth(open.body.token),
        body: {
          schemaId: "xw.open-action.action-request.v1",
          schemaVersion: 1,
          action: { schemaId: "xw.open-action.primitive.v1", schemaVersion: 1, kind: "observe" },
        },
      }),
      { code: "PRIMITIVE_NOT_SUPPORTED", status: 405 },
    );
    await assert.rejects(
      () => f.router.handle({
        method: "POST",
        path: `/control/v1/device-sessions/${open.body.session.sessionId}/observe`,
        headers: auth(open.body.token),
        body: { kind: "observe", primitive: "tap" },
      }),
      { code: "PRIMITIVE_NOT_SUPPORTED", status: 405 },
    );
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Discovery rows are session_kind=discovery and cannot use capability session APIs", async () => {
  const f = fixture();
  try {
    const grant = {
      grantId: "grant-discovery-oa",
      issuanceNonce: "nonce-discovery-oa",
      grantHash: "hash-grant-discovery-oa",
      status: "active",
      discoveryPolicy: {
        enabled: true,
        allowedPrimitives: ["screenshot"],
        defaults: { durationMs: 600000, maxPrimitives: 80, maxCandidates: 10 },
        maxima: { durationMs: 1800000, maxPrimitives: 300, maxCandidates: 50 },
        maxParallelism: 1,
        targetScope: { anchors: [{ type: "identityFingerprint", hash: "a".repeat(64) }], relationKinds: ["explicit_target"], maxHops: 1 },
      },
      validity: { expiresAt: null },
    };
    f.state.issueDelegationGrant({
      grant,
      grantHash: grant.grantHash,
      proofHash: "proof",
      issuerSubject: "user:a1234",
      issuerKeyId: "test",
      allowlistVersion: 1,
    });
    const run = f.control.openDiscoveryRun({ grantId: grant.grantId, controllerAgent: "agent:runner" });
    const row = f.state.db.prepare("SELECT session_kind FROM sessions WHERE session_id=?").get(run.sessionId);
    assert.equal(row.session_kind, "discovery");
    const stored = f.state.validateSession(run.sessionId, run.token);
    assert.equal(stored.sessionKind, "discovery");

    await assert.rejects(
      () => f.router.handle({
        method: "POST",
        path: `/control/v1/sessions/${run.sessionId}/heartbeat`,
        body: { token: run.token },
      }),
      { code: "SESSION_KIND_MISMATCH", status: 409 },
    );
    await assert.rejects(
      () => f.router.handle({
        method: "POST",
        path: `/control/v1/sessions/${run.sessionId}/release`,
        body: { token: run.token },
      }),
      { code: "SESSION_KIND_MISMATCH", status: 409 },
    );
    await assert.rejects(
      () => f.router.handle({
        method: "POST",
        path: `/control/v1/sessions/${run.sessionId}/actions`,
        body: { token: run.token, idempotencyKey: "x", capabilityId: "test.observe", params: {} },
      }),
      { code: "SESSION_KIND_MISMATCH", status: 409 },
    );
    assert.equal(f.control.heartbeatDiscoveryRun({ discoveryRunId: run.discoveryRunId, tuple: run.tuple }).status, "running");
    assert.equal(f.control.sealDiscoveryRun({ discoveryRunId: run.discoveryRunId, tuple: run.tuple }).status, "sealed");
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("incomplete or rebound observations are rejected before persist", async () => {
  const incomplete = fixture({
    observeProvider: { mutatingCalls: 0, async observe() { return { observationId: "obs-x" }; } },
  });
  try {
    const created = await incomplete.router.handle({
      method: "POST",
      path: "/control/v1/device-sessions",
      body: { actorId: "agent-oa", deviceId: incomplete.device.deviceId },
    });
    await assert.rejects(
      () => incomplete.router.handle({
        method: "POST",
        path: `/control/v1/device-sessions/${created.body.session.sessionId}/observe`,
        headers: auth(created.body.token),
        body: {},
      }),
      { code: "OBSERVATION_INCOMPLETE" },
    );
    assert.equal(incomplete.state.listDeviceSessionObservations(created.body.session.sessionId).length, 0);
  } finally {
    incomplete.state.close();
    rmSync(incomplete.root, { recursive: true, force: true });
  }

  const rebound = fixture({
    observeProvider: {
      mutatingCalls: 0,
      async observe() {
        return createFakeObserveProvider().observe({
          sessionId: "session_other",
          deviceId: "device_other",
          deviceAlias: "02",
        });
      },
    },
  });
  try {
    const created = await rebound.router.handle({
      method: "POST",
      path: "/control/v1/device-sessions",
      body: { actorId: "agent-oa", deviceId: rebound.device.deviceId },
    });
    await assert.rejects(
      () => rebound.router.handle({
        method: "POST",
        path: `/control/v1/device-sessions/${created.body.session.sessionId}/observe`,
        headers: auth(created.body.token),
        body: {},
      }),
      { code: "OBSERVATION_BINDING_MISMATCH" },
    );
    assert.equal(rebound.state.listDeviceSessionObservations(created.body.session.sessionId).length, 0);
    assert.equal(
      rebound.state.listDeviceSessionEvents(created.body.session.sessionId).filter((event) => event.type === "observation.captured").length,
      0,
    );
  } finally {
    rebound.state.close();
    rmSync(rebound.root, { recursive: true, force: true });
  }
});

test("fixture cannot override authoritative observation binding fields", async () => {
  const provider = createFakeObserveProvider({
    fixture: {
      schemaId: "forged",
      schemaVersion: 99,
      observationId: "forged-obs",
      deviceId: "forged-device",
      sessionId: "forged-session",
      capturedAt: "1999-01-01T00:00:00.000Z",
      pageKey: "same-page",
    },
  });
  const f = fixture({ observeProvider: provider });
  try {
    const created = f.control.createDeviceSession({ actorId: "agent-oa", deviceId: f.device.deviceId });
    const observed = await f.control.observeDeviceSession(created.session.sessionId, created.token, {});
    assert.equal(observed.observation.schemaId, "xw.open-action.observation.v1");
    assert.equal(observed.observation.schemaVersion, 1);
    assert.notEqual(observed.observation.observationId, "forged-obs");
    assert.equal(observed.observation.deviceId, created.session.deviceId);
    assert.equal(observed.observation.sessionId, created.session.sessionId);
    assert.notEqual(observed.observation.capturedAt, "1999-01-01T00:00:00.000Z");
    assert.equal(observed.observation.pageHash, fixturePageHash("same-page"));
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("fresh and v15 databases land on current schema; newer versions fail closed", () => {
  const freshRoot = mkdtempSync(join(tempBase, "oa-schema-fresh-"));
  const fresh = new StateStore({ dbPath: join(freshRoot, "control.db") });
  try {
    assert.equal(fresh.db.prepare("PRAGMA user_version").get().user_version, CURRENT_CONTROL_SCHEMA_VERSION);
    assert.ok(fresh.db.prepare("PRAGMA table_info(sessions)").all().some((column) => column.name === "session_kind"));
    assert.ok(fresh.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='device_session_events'").get());
  } finally {
    fresh.close();
    rmSync(freshRoot, { recursive: true, force: true });
  }

  const v15Root = mkdtempSync(join(tempBase, "oa-schema-v15-"));
  const v15Path = join(v15Root, "control.db");
  writeV15Fixture(v15Path);
  const upgraded = new StateStore({ dbPath: v15Path });
  try {
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get().user_version, 20);
    assert.ok(upgraded.db.prepare("PRAGMA table_info(sessions)").all().some((column) => column.name === "session_kind"));
    assert.ok(upgraded.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='device_session_observations'").get());
    assert.equal(upgraded.db.prepare("SELECT status FROM jobs WHERE job_id='job_v15'").get().status, "succeeded");
    assert.equal(upgraded.db.prepare("SELECT alias FROM devices WHERE device_id='dev_v15'").get().alias, "01");
    assert.equal(upgraded.db.prepare("SELECT evidence_id FROM evidence WHERE evidence_id='ev_v15'").get().evidence_id, "ev_v15");
    assert.equal(upgraded.db.prepare("SELECT mission_id FROM missions WHERE mission_id='mission_v15'").get().mission_id, "mission_v15");
  } finally {
    upgraded.close();
    rmSync(v15Root, { recursive: true, force: true });
  }

  const futureRoot = mkdtempSync(join(tempBase, "oa-schema-future-"));
  const futurePath = join(futureRoot, "control.db");
  const raw = new DatabaseSync(futurePath);
  raw.exec("PRAGMA user_version = 99;");
  raw.close();
  assert.throws(
    () => new StateStore({ dbPath: futurePath }),
    { code: "SCHEMA_VERSION_TOO_NEW" },
  );
  const still = new DatabaseSync(futurePath);
  try {
    assert.equal(still.prepare("PRAGMA user_version").get().user_version, 99);
  } finally {
    still.close();
    rmSync(futureRoot, { recursive: true, force: true });
  }
});

test("create, release, and observe persist atomically under injected faults", () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.control.createDeviceSession({
        actorId: "agent-oa",
        deviceId: f.device.deviceId,
        faultAfter: "createdEvent",
      }),
      { code: "DEVICE_SESSION_OPEN_FAULT" },
    );
    assert.equal(f.state.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
    assert.equal(f.state.listLeases().length, 0);
    assert.equal(f.state.db.prepare("SELECT COUNT(*) AS n FROM device_session_events").get().n, 0);

    const created = f.control.createDeviceSession({ actorId: "agent-oa", deviceId: f.device.deviceId });
    assert.throws(
      () => f.control.releaseDeviceSession(created.session.sessionId, created.token, { faultAfter: "afterReleasedEvent" }),
      { code: "DEVICE_SESSION_RELEASE_FAULT" },
    );
    assert.equal(f.state.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 1);
    assert.equal(f.state.listLeases().length, 1);
    assert.equal(
      f.state.listDeviceSessionEvents(created.session.sessionId).filter((event) => event.type === "device_session.released").length,
      0,
    );

    assert.throws(
      () => f.state.recordObservationCapture({
        sessionId: created.session.sessionId,
        observation: { observationId: "obs_fault" },
        mutatingCalls: 0,
        faultAfter: "afterObservation",
      }),
      { code: "DEVICE_SESSION_OBSERVE_FAULT" },
    );
    assert.equal(f.state.listDeviceSessionObservations(created.session.sessionId).length, 0);
    assert.equal(
      f.state.listDeviceSessionEvents(created.session.sessionId).filter((event) => event.type === "observation.captured").length,
      0,
    );
  } finally {
    f.state.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
