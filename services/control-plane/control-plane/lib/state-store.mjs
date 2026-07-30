import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { canonicalJson, fingerprint, newId, sha256 } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";
import {
  normalizePlacementRequest,
  normalizeRoutingProfile,
  selectPlacement,
} from "./placement.mjs";

const ACTIVE_JOB_STATES = new Set(["running", "verifying", "restoring"]);
const TERMINAL_JOB_STATES = new Set(["succeeded", "failed", "ambiguous", "recovery_required", "cancelled"]);
const TRANSITIONS = {
  queued: new Set(["running", "cancelled"]),
  waiting_approval: new Set(["queued", "cancelled"]),
  running: new Set(["verifying", "restoring", "failed", "ambiguous", "recovery_required"]),
  verifying: new Set(["restoring", "failed", "ambiguous", "recovery_required"]),
  restoring: new Set(["succeeded", "failed", "ambiguous", "recovery_required"]),
};

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  return JSON.parse(value);
}

function iso(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

function publicDevice(row, includeRuntime = false) {
  if (!row) return null;
  return {
    deviceId: row.device_id,
    alias: row.alias,
    physicalLabel: row.physical_label,
    nodeId: row.node_id,
    online: Boolean(row.online),
    quarantined: Boolean(row.quarantined),
    quarantineReason: row.quarantine_reason,
    updatedAt: iso(row.updated_at),
    ...(includeRuntime ? {
      runtimeId: row.runtime_id,
      metadata: parseJson(row.metadata_json, {}),
      routingProfile: normalizeRoutingProfile(parseJson(row.routing_json, {})),
    } : {}),
  };
}

function publicNode(row) {
  if (!row) return null;
  return {
    nodeId: row.node_id,
    status: row.status,
    authority: Boolean(row.authority),
    dispatchMode: row.dispatch_mode,
    lastSeenAt: iso(row.last_seen_at),
  };
}

function publicJob(row) {
  if (!row) return null;
  return {
    jobId: row.job_id,
    runId: row.run_id,
    actorId: row.actor_id,
    deviceId: row.device_id,
    capabilityId: row.capability_id,
    params: parseJson(row.params_json, {}),
    canary: Boolean(row.canary),
    sessionId: row.session_id,
    status: row.status,
    approvalRequired: Boolean(row.approval_required),
    externalEffect: Boolean(row.external_effect),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    errorCode: row.error_code,
    result: parseJson(row.result_json),
    capability: parseJson(row.capability_json),
    placementRequest: parseJson(row.placement_request_json, {}),
    routeDecision: parseJson(row.placement_decision_json),
  };
}

// The durable effect ledger persists only an allowlisted, redacted intent summary. Raw
// credentials, runtime IDs, serials, and unredacted snapshot text never reach public fields;
// full snapshots link to existing evidence hashes/paths instead.
function redactEffectIntent(intent) {
  if (!intent || typeof intent !== "object") return {};
  const out = {};
  if (typeof intent.surface === "string") out.surface = intent.surface;
  if (typeof intent.effectAction === "string") out.effectAction = intent.effectAction;
  if (typeof intent.pageFingerprint === "string") out.pageFingerprint = intent.pageFingerprint;
  return out;
}

function publicLease(row, token) {
  return {
    leaseId: row.lease_id,
    deviceId: row.device_id,
    kind: row.kind,
    holderId: row.holder_id,
    jobId: row.job_id,
    expiresAt: iso(row.expires_at),
    heartbeatAt: iso(row.heartbeat_at),
    ...(row.owner_device_run_id ? { ownerDeviceRunId: row.owner_device_run_id } : {}),
    ...(token ? { token } : {}),
  };
}

export function assertNodeSqliteRuntime() {
  if (typeof DatabaseSync !== "function") {
    throw new ControlPlaneError("SQLITE_UNAVAILABLE", "node:sqlite DatabaseSync is unavailable", { status: 503 });
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new ControlPlaneError(
      "NODE_RUNTIME_UNSUPPORTED",
      `Node ${process.versions.node} is too old; require >=22.13 and deploy with pinned 24.11.1`,
      { status: 503 },
    );
  }
}

export class StateStore {
  constructor({ dbPath = ":memory:", now = Date.now } = {}) {
    assertNodeSqliteRuntime();
    this.dbPath = dbPath;
    this.now = now;
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (dbPath !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.#migrate();
    this.recoverInterruptedWork();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        node_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        authority INTEGER NOT NULL DEFAULT 0,
        dispatch_mode TEXT NOT NULL DEFAULT 'local',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
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
        updated_at INTEGER NOT NULL,
        UNIQUE(node_id, alias)
      );
      CREATE TABLE IF NOT EXISTS capabilities (
        capability_id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        maturity TEXT NOT NULL,
        risk TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        manifest_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
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
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        error_code TEXT,
        result_json TEXT,
        placement_request_json TEXT NOT NULL DEFAULT '{}',
        placement_decision_json TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_device_queue_idx ON jobs(device_id, status, created_at);
      CREATE TABLE IF NOT EXISTS leases (
        lease_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL UNIQUE REFERENCES devices(device_id),
        kind TEXT NOT NULL,
        holder_id TEXT NOT NULL,
        job_id TEXT,
        token_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        lease_id TEXT NOT NULL UNIQUE REFERENCES leases(lease_id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL,
        device_id TEXT NOT NULL REFERENCES devices(device_id),
        token_hash TEXT NOT NULL,
        canary INTEGER NOT NULL,
        scope_capability_id TEXT,
        placement_decision_json TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        approval_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL UNIQUE REFERENCES jobs(job_id),
        decision TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT REFERENCES jobs(job_id),
        run_id TEXT,
        created_at INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_job_idx ON events(job_id, event_id);
      CREATE TABLE IF NOT EXISTS evidence (
        evidence_id TEXT PRIMARY KEY,
        job_id TEXT REFERENCES jobs(job_id),
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS missions (
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
        expires_at INTEGER NOT NULL,
        parent_grant_id TEXT REFERENCES delegation_grants(grant_id),
        parent_grant_hash TEXT,
        revoked_at INTEGER,
        revoked_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS missions_status_idx ON missions(status, expires_at);
      CREATE INDEX IF NOT EXISTS missions_parent_grant_idx ON missions(parent_grant_id, status);
      CREATE TABLE IF NOT EXISTS mission_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        mission_id TEXT NOT NULL REFERENCES missions(mission_id),
        created_at INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mission_events_idx ON mission_events(mission_id, event_id);
      CREATE TABLE IF NOT EXISTS device_runs (
        device_run_id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(mission_id),
        mission_hash TEXT NOT NULL,
        mission_version INTEGER NOT NULL,
        device_id TEXT NOT NULL REFERENCES devices(device_id),
        session_id TEXT,
        lease_id TEXT,
        controller_agent TEXT NOT NULL,
        controller_epoch INTEGER NOT NULL DEFAULT 1,
        heartbeat_at INTEGER,
        phase TEXT NOT NULL,
        outcome TEXT,
        readiness_receipt_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS mission_effects (
        effect_id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(mission_id),
        device_run_id TEXT NOT NULL REFERENCES device_runs(device_run_id),
        idempotency_key TEXT NOT NULL UNIQUE,
        action TEXT NOT NULL,
        target_hash TEXT NOT NULL,
        intent_json TEXT NOT NULL,
        status TEXT NOT NULL,
        reservation_json TEXT NOT NULL,
        reservation_consumed INTEGER NOT NULL DEFAULT 0,
        reservation_released INTEGER NOT NULL DEFAULT 0,
        retry_blocked INTEGER NOT NULL DEFAULT 0,
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS mission_effects_budget_idx
        ON mission_effects(mission_id, action, target_hash, created_at);
      CREATE INDEX IF NOT EXISTS device_runs_mission_idx ON device_runs(mission_id, phase);
      CREATE TABLE IF NOT EXISTS protected_commits (
        commit_id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(mission_id),
        effect_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS protected_commits_mission_idx ON protected_commits(mission_id, status);
      CREATE TABLE IF NOT EXISTS delegation_grants (
        grant_id TEXT PRIMARY KEY,
        issuance_nonce TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        grant_hash TEXT NOT NULL,
        grant_json TEXT NOT NULL,
        issuer_subject TEXT NOT NULL,
        issuer_key_id TEXT NOT NULL,
        allowlist_version INTEGER NOT NULL,
        proof_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER,
        revoked_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS delegation_grants_issuer_key_idx
        ON delegation_grants(issuer_key_id, status);
      CREATE TABLE IF NOT EXISTS delegation_grant_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        grant_id TEXT NOT NULL REFERENCES delegation_grants(grant_id),
        created_at INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS delegation_grant_events_idx
        ON delegation_grant_events(grant_id, event_id);
      -- This private control-plane record is the sole durable authority for a
      -- verified-discovery reference. Mission/API inputs can only reference its hashes.
      CREATE TABLE IF NOT EXISTS authoritative_observations (
        snapshot_hash TEXT PRIMARY KEY,
        app TEXT NOT NULL,
        account_fingerprint TEXT NOT NULL,
        page_fingerprint TEXT NOT NULL,
        observed_target_fingerprint TEXT NOT NULL,
        identity_evidence_hash TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS authoritative_observations_fresh_idx
        ON authoritative_observations(observed_at);
      CREATE TABLE IF NOT EXISTS discovery_runs (
        discovery_run_id TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL REFERENCES delegation_grants(grant_id),
        grant_hash TEXT NOT NULL,
        device_id TEXT NOT NULL REFERENCES devices(device_id),
        session_id TEXT NOT NULL UNIQUE,
        lease_id TEXT NOT NULL UNIQUE,
        controller_agent TEXT NOT NULL,
        controller_epoch INTEGER NOT NULL,
        status TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        deadline_at INTEGER NOT NULL,
        max_primitives INTEGER NOT NULL,
        max_candidates INTEGER NOT NULL,
        max_parallelism INTEGER NOT NULL,
        primitive_count INTEGER NOT NULL DEFAULT 0,
        candidate_count INTEGER NOT NULL DEFAULT 0,
        release_at INTEGER,
        released_tuple_hashes_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS discovery_runs_active_grant_idx
        ON discovery_runs(grant_id) WHERE status IN ('running', 'sealing');
      CREATE TABLE IF NOT EXISTS discovery_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        discovery_run_id TEXT NOT NULL REFERENCES discovery_runs(discovery_run_id),
        created_at INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS discovery_events_run_idx ON discovery_events(discovery_run_id, event_id);
      CREATE TABLE IF NOT EXISTS discovery_reservations (
        reservation_id TEXT PRIMARY KEY,
        discovery_run_id TEXT NOT NULL REFERENCES discovery_runs(discovery_run_id),
        kind TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(discovery_run_id, kind, idempotency_key)
      );
    `);
    this.#ensureColumn(
      "devices",
      "routing_json",
      `TEXT NOT NULL DEFAULT '{"enabled":false,"tags":[],"capabilityIds":[]}'`,
    );
    this.#ensureColumn("jobs", "placement_request_json", "TEXT NOT NULL DEFAULT '{}'");
    this.#ensureColumn("jobs", "placement_decision_json", "TEXT");
    this.#ensureColumn("sessions", "scope_capability_id", "TEXT");
    this.#ensureColumn("sessions", "placement_decision_json", "TEXT");
    this.#ensureColumn("leases", "owner_device_run_id", "TEXT");
    this.#ensureColumn("leases", "owner_discovery_run_id", "TEXT");
    this.#ensureColumn("missions", "parent_grant_id", "TEXT");
    this.#ensureColumn("missions", "parent_grant_hash", "TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS missions_parent_grant_idx ON missions(parent_grant_id, status)");
    this.db.exec("PRAGMA user_version = 8;");
  }

  #ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  recoverInterruptedWork() {
    const interrupted = this.db.prepare(
      "SELECT job_id, run_id, device_id, status FROM jobs WHERE status IN ('running','verifying','restoring')",
    ).all();
    if (interrupted.length === 0) {
      const now = this.now();
      this.#recoverInterruptedDeviceRuns(now);
      this.#recoverInterruptedDiscoveryRuns(now);
      this.#recoverInterruptedEffects(now);
      this.#recoverInterruptedProtectedCommits(now);
      this.db.exec("DELETE FROM sessions; DELETE FROM leases;");
      return [];
    }
    const now = this.now();
    this.transaction(() => {
      const update = this.db.prepare(
        "UPDATE jobs SET status='recovery_required', error_code='CONTROL_RESTART', updated_at=?, finished_at=? WHERE job_id=?",
      );
      const quarantine = this.db.prepare(
        "UPDATE devices SET quarantined=1, quarantine_reason='CONTROL_RESTART', updated_at=? WHERE device_id=?",
      );
      for (const row of interrupted) {
        update.run(now, now, row.job_id);
        quarantine.run(now, row.device_id);
        this.#insertEvent({
          jobId: row.job_id,
          runId: row.run_id,
          type: "job.recovery_required",
          payload: { previousStatus: row.status, reason: "CONTROL_RESTART" },
          createdAt: now,
        });
      }
      this.#recoverInterruptedDeviceRuns(now);
      this.#recoverInterruptedDiscoveryRuns(now);
      this.#recoverInterruptedEffects(now);
      this.#recoverInterruptedProtectedCommits(now);
      this.db.exec("DELETE FROM sessions; DELETE FROM leases;");
    });
    return interrupted.map((row) => row.job_id);
  }

  #recoverInterruptedDeviceRuns(now) {
    const active = this.db.prepare(
      "SELECT * FROM device_runs WHERE phase IN ('running','waiting_authorization')",
    ).all();
    for (const row of active) {
      this.db.prepare(
        "UPDATE device_runs SET phase='paused_control_lost', outcome='CONTROL_RESTART', updated_at=?, finished_at=? WHERE device_run_id=?",
      ).run(now, now, row.device_run_id);
      this.#insertMissionEvent({
        missionId: row.mission_id,
        type: "device_run.paused_control_lost",
        payload: { deviceRunId: row.device_run_id, reason: "CONTROL_RESTART" },
        createdAt: now,
      });
    }
    return active.length;
  }

  #recoverInterruptedDiscoveryRuns(now) {
    const active = this.db.prepare(
      "SELECT * FROM discovery_runs WHERE status IN ('running','sealing')",
    ).all();
    for (const row of active) {
      this.#releaseDiscoveryRun(row, "recovery_required", now, "CONTROL_RESTART");
    }
    return active.length;
  }

  #recoverInterruptedEffects(now) {
    const interrupted = this.db.prepare(`
      SELECT effect_id, mission_id FROM mission_effects
      WHERE reservation_released=0
        AND status IN ('started', 'pending_authorization', 'waiting_authorization')
    `).all();
    for (const row of interrupted) {
      this.db.prepare(`
        UPDATE mission_effects SET
          status='ambiguous', reservation_consumed=1, retry_blocked=1,
          updated_at=?, finished_at=?
        WHERE effect_id=?
      `).run(now, now, row.effect_id);
      this.#insertMissionEvent({
        missionId: row.mission_id,
        type: "effect.recovered_ambiguous",
        payload: { effectId: row.effect_id, reason: "CONTROL_RESTART" },
        createdAt: now,
      });
    }
    return interrupted.map((row) => row.effect_id);
  }

  upsertNode({
    nodeId,
    status = "online",
    authority = false,
    dispatchMode = "local",
    metadata = {},
  }) {
    if (typeof nodeId !== "string" || nodeId.trim() === "") throw new TypeError("nodeId is required");
    if (!["online", "offline"].includes(status)) throw new TypeError("node status must be online or offline");
    if (!["local", "remote"].includes(dispatchMode)) throw new TypeError("dispatchMode must be local or remote");
    const now = this.now();
    this.db.prepare(`
      INSERT INTO nodes (node_id, status, authority, dispatch_mode, metadata_json, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET
        status=excluded.status,
        authority=excluded.authority,
        dispatch_mode=excluded.dispatch_mode,
        metadata_json=excluded.metadata_json,
        last_seen_at=excluded.last_seen_at
    `).run(nodeId.trim(), status, authority ? 1 : 0, dispatchMode, canonicalJson(metadata), now);
    return this.getNode(nodeId.trim());
  }

  getNode(nodeId) {
    return publicNode(this.db.prepare("SELECT * FROM nodes WHERE node_id=?").get(nodeId));
  }

  listNodes() {
    this.cleanupExpiredLeases();
    return this.db.prepare("SELECT * FROM nodes ORDER BY node_id").all().map((row) => {
      const counts = this.db.prepare(`
        SELECT
          COUNT(*) AS device_count,
          SUM(
            CASE WHEN online=1 AND quarantined=0
              AND json_extract(routing_json, '$.enabled')=1
            THEN 1 ELSE 0 END
          ) AS ready_count
        FROM devices WHERE node_id=?
      `).get(row.node_id);
      const leases = this.db.prepare(`
        SELECT COUNT(*) AS active_count
        FROM leases l JOIN devices d ON d.device_id=l.device_id
        WHERE d.node_id=? AND l.expires_at>?
      `).get(row.node_id, this.now());
      return {
        ...publicNode(row),
        devices: Number(counts.device_count || 0),
        readyDevices: Number(counts.ready_count || 0),
        activeDeviceLeases: Number(leases.active_count || 0),
      };
    });
  }

  upsertDevice({
    deviceId,
    alias,
    physicalLabel,
    nodeId,
    runtimeId = null,
    metadata = {},
    routingProfile = {},
    online = true,
  }) {
    if (!alias || !physicalLabel || !nodeId) throw new TypeError("alias, physicalLabel, and nodeId are required");
    let existing = deviceId
      ? this.db.prepare("SELECT * FROM devices WHERE device_id=?").get(deviceId)
      : this.db.prepare("SELECT * FROM devices WHERE node_id=? AND alias=?").get(nodeId, alias);
    if (!existing && runtimeId) {
      existing = this.db.prepare("SELECT * FROM devices WHERE node_id=? AND runtime_id=?").get(nodeId, runtimeId);
    }
    const id = existing?.device_id || deviceId || newId("dev");
    const now = this.now();
    const normalizedRouting = normalizeRoutingProfile(routingProfile);
    this.db.prepare(`
      INSERT INTO devices (
        device_id, alias, physical_label, node_id, runtime_id, metadata_json, routing_json, online, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        alias=excluded.alias,
        physical_label=excluded.physical_label,
        node_id=excluded.node_id,
        runtime_id=COALESCE(excluded.runtime_id, devices.runtime_id),
        metadata_json=excluded.metadata_json,
        routing_json=excluded.routing_json,
        online=excluded.online,
        updated_at=excluded.updated_at
    `).run(
      id,
      alias,
      physicalLabel,
      nodeId,
      runtimeId,
      canonicalJson(metadata),
      canonicalJson(normalizedRouting),
      online ? 1 : 0,
      now,
    );
    return this.getDevice(id, { includeRuntime: true });
  }

  listDevices({ includeRuntime = false } = {}) {
    return this.db.prepare("SELECT * FROM devices ORDER BY node_id, alias").all()
      .map((row) => publicDevice(row, includeRuntime));
  }

  getDevice(deviceId, { includeRuntime = false } = {}) {
    return publicDevice(this.db.prepare("SELECT * FROM devices WHERE device_id=?").get(deviceId), includeRuntime);
  }

  requireDevice(deviceId, { includeRuntime = false, requireReady = true } = {}) {
    const device = this.getDevice(deviceId, { includeRuntime });
    if (!device) throw new ControlPlaneError("DEVICE_NOT_FOUND", `unknown device ${deviceId}`, { status: 404 });
    if (requireReady && !device.online) throw new ControlPlaneError("DEVICE_OFFLINE", `${device.alias} is offline`, { status: 409 });
    if (requireReady && device.quarantined) {
      throw new ControlPlaneError("DEVICE_QUARANTINED", `${device.alias} is quarantined`, {
        status: 423,
        details: { reason: device.quarantineReason },
      });
    }
    return device;
  }

  quarantineDevice(deviceId, reason) {
    const result = this.db.prepare(
      "UPDATE devices SET quarantined=1, quarantine_reason=?, updated_at=? WHERE device_id=?",
    ).run(reason, this.now(), deviceId);
    if (result.changes === 0) throw new ControlPlaneError("DEVICE_NOT_FOUND", `unknown device ${deviceId}`, { status: 404 });
  }

  clearDeviceQuarantine(deviceId) {
    this.db.prepare(
      "UPDATE devices SET quarantined=0, quarantine_reason=NULL, updated_at=? WHERE device_id=?",
    ).run(this.now(), deviceId);
  }

  completeDeviceRecovery({ deviceId, jobId, runId, payload }) {
    return this.transaction(() => {
      const device = this.requireDevice(deviceId, { requireReady: false });
      if (!device.quarantined) {
        throw new ControlPlaneError("DEVICE_NOT_QUARANTINED", `${device.alias} is not quarantined`, {
          status: 409,
        });
      }
      const now = this.now();
      this.db.prepare(
        "UPDATE devices SET quarantined=0, quarantine_reason=NULL, updated_at=? WHERE device_id=?",
      ).run(now, deviceId);
      const eventId = this.#insertEvent({
        jobId,
        runId,
        type: "job.recovery.succeeded",
        payload,
        createdAt: now,
      });
      return { eventId, device: this.getDevice(deviceId) };
    });
  }

  syncCapabilities(registry) {
    const now = this.now();
    this.transaction(() => {
      this.db.exec("UPDATE capabilities SET enabled=0");
      const statement = this.db.prepare(`
        INSERT INTO capabilities (
          capability_id, app_id, maturity, risk, enabled, manifest_json, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(capability_id) DO UPDATE SET
          app_id=excluded.app_id,
          maturity=excluded.maturity,
          risk=excluded.risk,
          enabled=1,
          manifest_json=excluded.manifest_json,
          updated_at=excluded.updated_at
      `);
      for (const capability of registry.capabilities) {
        statement.run(
          capability.id,
          capability.appId,
          capability.maturity,
          capability.risk,
          canonicalJson(capability),
          now,
        );
      }
    });
  }

  getCapabilityRecord(capabilityId) {
    const row = this.db.prepare(
      "SELECT manifest_json, enabled FROM capabilities WHERE capability_id=?",
    ).get(capabilityId);
    return row ? { ...parseJson(row.manifest_json), enabled: Boolean(row.enabled) } : null;
  }

  #placementCandidates() {
    const now = this.now();
    return this.db.prepare(`
      SELECT d.*,
        EXISTS(
          SELECT 1 FROM leases l
          WHERE l.device_id=d.device_id AND l.expires_at>?
        ) AS active_lease,
        (
          SELECT COUNT(*) FROM jobs j
          WHERE j.device_id=d.device_id AND j.status='queued'
        ) AS pending_jobs,
        (
          SELECT COUNT(*) FROM jobs j
          WHERE j.device_id=d.device_id AND j.status='waiting_approval'
        ) AS waiting_approval
      FROM devices d
    `).all(now).map((row) => {
      const device = publicDevice(row, true);
      const pendingJobs = Number(row.pending_jobs || 0);
      const waitingApproval = Number(row.waiting_approval || 0);
      const activeLease = Boolean(row.active_lease);
      return {
        ...device,
        activeLease,
        pendingJobs,
        waitingApproval,
        effectiveLoad: (activeLease ? 1 : 0) + pendingJobs + waitingApproval,
      };
    });
  }

  #selectPlacementDecision({
    authorityNodeId,
    capability,
    placementRequest,
    invocation,
    canary,
    advisory,
  }) {
    const requestedNodeId = placementRequest.placement.nodeId || authorityNodeId;
    const node = this.getNode(requestedNodeId);
    if (!node || node.status !== "online" || node.dispatchMode !== "local" || requestedNodeId !== authorityNodeId) {
      throw new ControlPlaneError(
        "NODE_UNAVAILABLE",
        `node ${requestedNodeId} is unavailable for local dispatch`,
        { status: 409, details: { nodeId: requestedNodeId } },
      );
    }
    return selectPlacement({
      authorityNodeId,
      capability,
      placementRequest,
      candidates: this.#placementCandidates(),
      invocation,
      canary,
      advisory,
      now: this.now(),
    });
  }

  planPlacement({
    authorityNodeId,
    capability,
    deviceId = null,
    placement = {},
    invocation = "job",
    canary = false,
  }) {
    const placementRequest = normalizePlacementRequest({ deviceId, placement });
    return this.#selectPlacementDecision({
      authorityNodeId,
      capability,
      placementRequest,
      invocation,
      canary,
      advisory: true,
    });
  }

  createJob({
    idempotencyKey,
    actorId,
    authorityNodeId,
    deviceId = null,
    placement = {},
    capability,
    params = {},
    canary = false,
    sessionId = null,
    status = "queued",
    approvalRequired = false,
    externalEffect = false,
  }) {
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") {
      throw new ControlPlaneError("IDEMPOTENCY_REQUIRED", "idempotencyKey is required");
    }
    if (typeof actorId !== "string" || actorId.trim() === "") {
      throw new ControlPlaneError("ACTOR_REQUIRED", "actorId is required");
    }
    const placementRequest = normalizePlacementRequest({ deviceId, placement });
    const requestFingerprint = fingerprint({
      actorId,
      placementRequest,
      capabilityId: capability.id,
      params,
      canary,
      sessionId,
    });
    const legacyFingerprint = placementRequest.mode === "pinned"
      ? fingerprint({ deviceId: placementRequest.deviceId, capabilityId: capability.id, params, canary, sessionId })
      : null;
    const now = this.now();
    const jobId = newId("job");
    const runId = newId("run");
    const result = this.transaction(() => {
      const prior = this.db.prepare("SELECT * FROM jobs WHERE idempotency_key=?").get(idempotencyKey);
      if (prior) {
        if (prior.actor_id !== actorId
          || (prior.request_fingerprint !== requestFingerprint && prior.request_fingerprint !== legacyFingerprint)) {
          throw new ControlPlaneError("IDEMPOTENCY_CONFLICT", "idempotency key was used for a different request", {
            status: 409,
            details: { jobId: prior.job_id },
          });
        }
        return { reused: true, jobId: prior.job_id };
      }
      const routeDecision = this.#selectPlacementDecision({
        authorityNodeId,
        capability,
        placementRequest,
        invocation: sessionId ? "session_action" : "job",
        canary,
        advisory: false,
      });
      this.db.prepare(`
        INSERT INTO jobs (
          job_id, run_id, idempotency_key, request_fingerprint, actor_id, device_id,
          capability_id, capability_json, params_json, canary, session_id, status,
          approval_required, external_effect, created_at, updated_at,
          placement_request_json, placement_decision_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        jobId,
        runId,
        idempotencyKey,
        requestFingerprint,
        actorId,
        routeDecision.selectedDeviceId,
        capability.id,
        canonicalJson(capability),
        canonicalJson(params),
        canary ? 1 : 0,
        sessionId,
        status,
        approvalRequired ? 1 : 0,
        externalEffect ? 1 : 0,
        now,
        now,
        canonicalJson(placementRequest),
        canonicalJson(routeDecision),
      );
      this.#insertEvent({
        jobId,
        runId,
        type: "route.assigned",
        payload: routeDecision,
        createdAt: now,
      });
      this.#insertEvent({
        jobId,
        runId,
        type: `job.${status}`,
        payload: {
          actorId,
          deviceId: routeDecision.selectedDeviceId,
          capabilityId: capability.id,
          approvalRequired,
          canary,
        },
        createdAt: now,
      });
      return { reused: false, jobId };
    });
    return { job: this.getJob(result.jobId), reused: result.reused };
  }

  getJob(jobId) {
    return publicJob(this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId));
  }

  requireJob(jobId) {
    const job = this.getJob(jobId);
    if (!job) throw new ControlPlaneError("JOB_NOT_FOUND", `unknown job ${jobId}`, { status: 404 });
    return job;
  }

  nextQueuedJobs() {
    return this.db.prepare(`
      SELECT j.*
      FROM jobs j
      WHERE j.status='queued'
        AND NOT EXISTS (
          SELECT 1 FROM jobs earlier
          WHERE earlier.device_id=j.device_id
            AND earlier.status='queued'
            AND (
              earlier.created_at < j.created_at OR
              (earlier.created_at=j.created_at AND earlier.rowid < j.rowid)
            )
        )
      ORDER BY j.created_at, j.rowid
    `).all().map(publicJob);
  }

  transitionJob(jobId, nextStatus, { errorCode = null, result = undefined, payload = {} } = {}) {
    const current = this.requireJob(jobId);
    if (current.status === nextStatus) return current;
    if (!TRANSITIONS[current.status]?.has(nextStatus)) {
      throw new ControlPlaneError(
        "JOB_TRANSITION_INVALID",
        `cannot transition ${current.status} to ${nextStatus}`,
        { status: 409, details: { jobId } },
      );
    }
    const now = this.now();
    const startedAt = nextStatus === "running" ? now : current.startedAt ? Date.parse(current.startedAt) : null;
    const finishedAt = TERMINAL_JOB_STATES.has(nextStatus) ? now : null;
    this.transaction(() => {
      this.db.prepare(`
        UPDATE jobs SET
          status=?,
          updated_at=?,
          started_at=COALESCE(started_at, ?),
          finished_at=COALESCE(?, finished_at),
          error_code=?,
          result_json=COALESCE(?, result_json)
        WHERE job_id=?
      `).run(
        nextStatus,
        now,
        startedAt,
        finishedAt,
        errorCode,
        result === undefined ? null : canonicalJson(result),
        jobId,
      );
      this.#insertEvent({
        jobId,
        runId: current.runId,
        type: `job.${nextStatus}`,
        payload: { ...payload, ...(errorCode ? { errorCode } : {}) },
        createdAt: now,
      });
    });
    return this.getJob(jobId);
  }

  cancelJob(jobId) {
    const job = this.requireJob(jobId);
    if (!["queued", "waiting_approval"].includes(job.status)) {
      throw new ControlPlaneError("JOB_CANCEL_UNSAFE", `cannot cancel a ${job.status} job without preemption`, {
        status: 409,
      });
    }
    return this.transitionJob(jobId, "cancelled", { errorCode: "CANCELLED_BY_ACTOR" });
  }

  decideApproval(jobId, { decision, actorId, reason = null }) {
    if (!["approve", "deny"].includes(decision)) throw new ControlPlaneError("APPROVAL_INVALID", "decision must be approve or deny");
    const job = this.requireJob(jobId);
    if (job.status !== "waiting_approval") {
      throw new ControlPlaneError("APPROVAL_NOT_PENDING", `job ${jobId} is ${job.status}`, { status: 409 });
    }
    const now = this.now();
    const nextStatus = decision === "approve" ? "queued" : "cancelled";
    this.transaction(() => {
      this.db.prepare(
        "INSERT INTO approvals (approval_id, job_id, decision, actor_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(newId("approval"), jobId, decision, actorId, reason, now);
      this.db.prepare(`
        UPDATE jobs SET
          status=?,
          updated_at=?,
          finished_at=?,
          error_code=?
        WHERE job_id=?
      `).run(
        nextStatus,
        now,
        nextStatus === "cancelled" ? now : null,
        nextStatus === "cancelled" ? "APPROVAL_DENIED" : null,
        jobId,
      );
      this.#insertEvent({
        jobId,
        runId: job.runId,
        type: `job.${nextStatus}`,
        payload: { decision, actorId },
        createdAt: now,
      });
    });
    return this.getJob(jobId);
  }

  cleanupExpiredLeases() {
    const now = this.now();
    const expired = this.db.prepare("SELECT * FROM leases WHERE expires_at<=?").all(now);
    for (const lease of expired) {
      if (lease.kind === "job" && lease.job_id) {
        const job = this.getJob(lease.job_id);
        if (job && ACTIVE_JOB_STATES.has(job.status)) {
          this.transitionJob(job.jobId, "recovery_required", { errorCode: "LEASE_EXPIRED" });
          this.quarantineDevice(lease.device_id, "LEASE_EXPIRED");
        }
      }
    }
    this.db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(now);
    this.db.prepare("DELETE FROM leases WHERE expires_at<=?").run(now);
    return expired.length;
  }

  acquireLease({
    deviceId,
    kind,
    holderId,
    jobId = null,
    ttlMs = 60000,
    allowQuarantined = false,
  }) {
    const device = this.requireDevice(deviceId, { requireReady: !allowQuarantined });
    if (allowQuarantined) {
      if (kind !== "recovery") {
        throw new ControlPlaneError("RECOVERY_LEASE_REQUIRED", "only recovery leases may access quarantine", {
          status: 403,
        });
      }
      if (!device.online) {
        throw new ControlPlaneError("DEVICE_OFFLINE", `${device.alias} is offline`, { status: 409 });
      }
      if (!device.quarantined) {
        throw new ControlPlaneError("DEVICE_NOT_QUARANTINED", `${device.alias} is not quarantined`, { status: 409 });
      }
    }
    this.cleanupExpiredLeases();
    const token = newId("lease_token");
    const tokenHash = sha256(token);
    const leaseId = newId("lease");
    const now = this.now();
    const row = {
      lease_id: leaseId,
      device_id: deviceId,
      kind,
      holder_id: holderId,
      job_id: jobId,
      created_at: now,
      heartbeat_at: now,
      expires_at: now + ttlMs,
    };
    try {
      this.db.prepare(`
        INSERT INTO leases (
          lease_id, device_id, kind, holder_id, job_id, token_hash, created_at, heartbeat_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.lease_id,
        row.device_id,
        row.kind,
        row.holder_id,
        row.job_id,
        tokenHash,
        row.created_at,
        row.heartbeat_at,
        row.expires_at,
      );
    } catch (error) {
      if (String(error?.message).includes("UNIQUE constraint failed: leases.device_id")) {
        const current = this.db.prepare("SELECT * FROM leases WHERE device_id=?").get(deviceId);
        throw new ControlPlaneError("DEVICE_BUSY", "device already has an active lease", {
          status: 423,
          details: current ? {
            leaseId: current.lease_id,
            kind: current.kind,
            holderId: current.holder_id,
            expiresAt: iso(current.expires_at),
          } : {},
        });
      }
      throw error;
    }
    return publicLease(row, token);
  }

  validateLease(leaseId, token) {
    this.cleanupExpiredLeases();
    const row = this.db.prepare("SELECT * FROM leases WHERE lease_id=?").get(leaseId);
    if (!row) throw new ControlPlaneError("LEASE_REQUIRED", "active lease not found", { status: 423 });
    if (row.token_hash !== sha256(token || "")) {
      throw new ControlPlaneError("LEASE_TOKEN_INVALID", "lease token is invalid", { status: 403 });
    }
    return publicLease(row);
  }

  authorizeLease({ leaseId, token, deviceId, runtimeId }) {
    const lease = this.validateLease(leaseId, token);
    if (typeof deviceId !== "string" || deviceId.trim() === "") {
      throw new ControlPlaneError("LEASE_DEVICE_REQUIRED", "deviceId is required for operator authorization");
    }
    if (lease.deviceId !== deviceId) {
      throw new ControlPlaneError("LEASE_DEVICE_MISMATCH", "lease does not own the requested device", {
        status: 409,
        details: { leaseDeviceId: lease.deviceId, requestedDeviceId: deviceId },
      });
    }
    const device = this.requireDevice(deviceId, {
      includeRuntime: true,
      requireReady: lease.kind !== "recovery",
    });
    if (lease.kind === "recovery") {
      if (!device.online) {
        throw new ControlPlaneError("DEVICE_OFFLINE", `${device.alias} is offline`, { status: 409 });
      }
      if (!device.quarantined) {
        throw new ControlPlaneError("DEVICE_NOT_QUARANTINED", `${device.alias} is not quarantined`, { status: 409 });
      }
    }
    if (typeof runtimeId !== "string" || runtimeId === "" || device.runtimeId !== runtimeId) {
      throw new ControlPlaneError("LEASE_RUNTIME_MISMATCH", "lease is not valid for the requested runtime", {
        status: 409,
      });
    }
    return lease;
  }

  heartbeatLease(leaseId, token, ttlMs = 60000) {
    this.validateLease(leaseId, token);
    const now = this.now();
    this.db.prepare("UPDATE leases SET heartbeat_at=?, expires_at=? WHERE lease_id=?").run(now, now + ttlMs, leaseId);
    return publicLease(this.db.prepare("SELECT * FROM leases WHERE lease_id=?").get(leaseId));
  }

  releaseLease(leaseId, token) {
    this.validateLease(leaseId, token);
    this.db.prepare("DELETE FROM leases WHERE lease_id=?").run(leaseId);
  }

  createSession({
    actorId,
    authorityNodeId,
    deviceId = null,
    placement = {},
    capability = null,
    canary = false,
    ttlMs = 60000,
  }) {
    if (typeof actorId !== "string" || actorId.trim() === "") {
      throw new ControlPlaneError("ACTOR_REQUIRED", "actorId is required");
    }
    if (!capability && !deviceId) {
      throw new ControlPlaneError(
        "PLACEMENT_CONFLICT",
        "automatic sessions require capabilityId",
        { status: 409 },
      );
    }
    const placementRequest = normalizePlacementRequest({ deviceId, placement });
    const sessionId = newId("session");
    const leaseId = newId("lease");
    const token = newId("lease_token");
    const now = this.now();
    this.cleanupExpiredLeases();
    const result = this.transaction(() => {
      let routeDecision;
      if (capability) {
        routeDecision = this.#selectPlacementDecision({
          authorityNodeId,
          capability,
          placementRequest,
          invocation: "session",
          canary,
          advisory: false,
        });
      } else {
        const device = this.requireDevice(placementRequest.deviceId);
        const busy = this.db.prepare(
          "SELECT 1 FROM leases WHERE device_id=? AND expires_at>?",
        ).get(device.deviceId, now);
        if (busy) {
          throw new ControlPlaneError("DEVICE_BUSY", "device already has an active lease", { status: 423 });
        }
        routeDecision = {
          mode: "pinned",
          decision: "dispatchable",
          selectedNodeId: device.nodeId,
          selectedDeviceId: device.deviceId,
          selectedDevice: {
            deviceId: device.deviceId,
            alias: device.alias,
            physicalLabel: device.physicalLabel,
            nodeId: device.nodeId,
          },
          queueDepth: 0,
          waitingApproval: 0,
          activeLease: false,
          requiredResources: ["device"],
          selector: {},
          assignedAt: iso(now),
          advisory: false,
        };
      }
      this.db.prepare(`
        INSERT INTO leases (
          lease_id, device_id, kind, holder_id, job_id, token_hash, created_at, heartbeat_at, expires_at
        ) VALUES (?, ?, 'interactive', ?, NULL, ?, ?, ?, ?)
      `).run(
        leaseId,
        routeDecision.selectedDeviceId,
        actorId,
        sha256(token),
        now,
        now,
        now + ttlMs,
      );
      this.db.prepare(`
        INSERT INTO sessions (
          session_id, lease_id, actor_id, device_id, token_hash, canary,
          scope_capability_id, placement_decision_json, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId,
        leaseId,
        actorId,
        routeDecision.selectedDeviceId,
        sha256(token),
        canary ? 1 : 0,
        capability?.id || null,
        canonicalJson(routeDecision),
        now,
        now + ttlMs,
      );
      return routeDecision;
    });
    return {
      sessionId,
      leaseId,
      token,
      actorId,
      deviceId: result.selectedDeviceId,
      canary,
      scopeCapabilityId: capability?.id || null,
      routeDecision: result,
      expiresAt: iso(now + ttlMs),
    };
  }

  validateSession(sessionId, token) {
    this.cleanupExpiredLeases();
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_id=?").get(sessionId);
    if (!row) throw new ControlPlaneError("SESSION_NOT_FOUND", "active session not found", { status: 404 });
    if (row.token_hash !== sha256(token || "")) {
      throw new ControlPlaneError("SESSION_TOKEN_INVALID", "session token is invalid", { status: 403 });
    }
    this.validateLease(row.lease_id, token);
    return {
      sessionId: row.session_id,
      leaseId: row.lease_id,
      actorId: row.actor_id,
      deviceId: row.device_id,
      canary: Boolean(row.canary),
      scopeCapabilityId: row.scope_capability_id,
      routeDecision: parseJson(row.placement_decision_json),
      expiresAt: iso(row.expires_at),
    };
  }

  heartbeatSession(sessionId, token, ttlMs = 60000) {
    const session = this.validateSession(sessionId, token);
    const lease = this.heartbeatLease(session.leaseId, token, ttlMs);
    this.db.prepare("UPDATE sessions SET expires_at=? WHERE session_id=?").run(Date.parse(lease.expiresAt), sessionId);
    return { ...session, expiresAt: lease.expiresAt };
  }

  releaseSession(sessionId, token) {
    const session = this.validateSession(sessionId, token);
    this.db.prepare("DELETE FROM sessions WHERE session_id=?").run(sessionId);
    this.releaseLease(session.leaseId, token);
    return { released: true, sessionId };
  }

  listLeases() {
    this.cleanupExpiredLeases();
    return this.db.prepare("SELECT * FROM leases ORDER BY created_at").all().map((row) => publicLease(row));
  }

  appendEvent({ jobId = null, runId = null, type, payload = {} }) {
    return this.#insertEvent({ jobId, runId, type, payload, createdAt: this.now() });
  }

  #insertEvent({ jobId, runId, type, payload, createdAt }) {
    const result = this.db.prepare(
      "INSERT INTO events (job_id, run_id, created_at, type, payload_json) VALUES (?, ?, ?, ?, ?)",
    ).run(jobId, runId, createdAt, type, canonicalJson(payload));
    return Number(result.lastInsertRowid);
  }

  listJobEvents(jobId, after = 0) {
    this.requireJob(jobId);
    return this.db.prepare(
      "SELECT * FROM events WHERE job_id=? AND event_id>? ORDER BY event_id",
    ).all(jobId, after).map((row) => ({
      eventId: row.event_id,
      jobId: row.job_id,
      runId: row.run_id,
      createdAt: iso(row.created_at),
      type: row.type,
      payload: parseJson(row.payload_json, {}),
    }));
  }

  recordEvidence({ jobId, runId, kind, path, sha256: hash, bytes }) {
    const evidenceId = newId("evidence");
    this.db.prepare(`
      INSERT INTO evidence (evidence_id, job_id, run_id, kind, path, sha256, bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(evidenceId, jobId, runId, kind, path, hash, bytes, this.now());
    return { evidenceId, jobId, runId, kind, path, sha256: hash, bytes };
  }

  listEvidence(runId) {
    return this.db.prepare("SELECT * FROM evidence WHERE run_id=? ORDER BY created_at").all(runId).map((row) => ({
      evidenceId: row.evidence_id,
      jobId: row.job_id,
      runId: row.run_id,
      kind: row.kind,
      path: row.path,
      sha256: row.sha256,
      bytes: row.bytes,
      createdAt: iso(row.created_at),
    }));
  }

  #publicDelegationGrant(row) {
    if (!row) return null;
    return {
      grantId: row.grant_id,
      issuanceNonce: row.issuance_nonce,
      grantHash: row.grant_hash,
      issuer: { subject: row.issuer_subject, keyId: row.issuer_key_id },
      allowlistVersion: row.allowlist_version,
      proofHash: row.proof_hash,
      status: row.status,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      expiresAt: iso(row.expires_at),
      revokedAt: iso(row.revoked_at),
      revokedReason: row.revoked_reason,
    };
  }

  // Grant issue/revoke records are retained forever as the immutable authorization audit
  // trail. Neither a nonce nor a revoked grant can be reactivated by replaying an envelope.
  issueDelegationGrant({
    grant,
    grantHash,
    proofHash,
    issuerSubject,
    issuerKeyId,
    allowlistVersion,
  }) {
    const now = this.now();
    const expiresAt = grant.validity.expiresAt == null ? null : Date.parse(grant.validity.expiresAt);
    return this.transaction(() => {
      const byNonce = this.db.prepare("SELECT * FROM delegation_grants WHERE issuance_nonce=?").get(grant.issuanceNonce);
      if (byNonce) {
        if (byNonce.status === "revoked") {
          throw new ControlPlaneError("GRANT_REVOKED", "revoked delegation grants cannot be replayed", { status: 409 });
        }
        if (byNonce.grant_id !== grant.grantId || byNonce.grant_hash !== grantHash || byNonce.proof_hash !== proofHash) {
          throw new ControlPlaneError("ISSUANCE_NONCE_REPLAY", "issuance nonce was used for different grant content", { status: 409 });
        }
        return { grant: this.#publicDelegationGrant(byNonce), reused: true };
      }
      const byId = this.db.prepare("SELECT * FROM delegation_grants WHERE grant_id=?").get(grant.grantId);
      if (byId) {
        if (byId.status === "revoked") {
          throw new ControlPlaneError("GRANT_REVOKED", "revoked delegation grants cannot be replayed", { status: 409 });
        }
        if (byId.grant_hash !== grantHash || byId.proof_hash !== proofHash) {
          throw new ControlPlaneError("GRANT_CONFLICT", "grant id was used for different signed content", { status: 409 });
        }
        return { grant: this.#publicDelegationGrant(byId), reused: true };
      }
      this.db.prepare(`
        INSERT INTO delegation_grants (
          grant_id, issuance_nonce, idempotency_key, grant_hash, grant_json,
          issuer_subject, issuer_key_id, allowlist_version, proof_hash, status,
          created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(
        grant.grantId,
        grant.issuanceNonce,
        grant.grantId,
        grantHash,
        canonicalJson(grant),
        issuerSubject,
        issuerKeyId,
        allowlistVersion,
        proofHash,
        now,
        now,
        expiresAt,
      );
      this.#insertDelegationGrantEvent({
        grantId: grant.grantId,
        type: "delegation_grant.issued",
        payload: { grantHash, issuerSubject, issuerKeyId, allowlistVersion, proofHash },
        createdAt: now,
      });
      return {
        grant: this.#publicDelegationGrant(this.db.prepare("SELECT * FROM delegation_grants WHERE grant_id=?").get(grant.grantId)),
        reused: false,
      };
    });
  }

  getDelegationGrant(grantId) {
    return this.#publicDelegationGrant(this.db.prepare("SELECT * FROM delegation_grants WHERE grant_id=?").get(grantId));
  }

  getDelegationGrantRecord(grantId) {
    const row = this.db.prepare("SELECT * FROM delegation_grants WHERE grant_id=?").get(grantId);
    if (!row) return null;
    return { ...this.#publicDelegationGrant(row), grant: parseJson(row.grant_json, {}) };
  }

  listDelegationGrants() {
    return this.db.prepare("SELECT * FROM delegation_grants ORDER BY created_at").all().map((row) => this.#publicDelegationGrant(row));
  }

  revokeDelegationGrant(grantId, { reason = "issuer_revoked" } = {}) {
    const now = this.now();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM delegation_grants WHERE grant_id=?").get(grantId);
      if (!row) throw new ControlPlaneError("GRANT_NOT_FOUND", `unknown delegation grant ${grantId}`, { status: 404 });
      if (row.status === "revoked") return this.#publicDelegationGrant(row);
      this.db.prepare("UPDATE delegation_grants SET status='revoked', updated_at=?, revoked_at=?, revoked_reason=? WHERE grant_id=?")
        .run(now, now, reason, grantId);
      this.#insertDelegationGrantEvent({ grantId, type: "delegation_grant.revoked", payload: { reason }, createdAt: now });
      return this.#publicDelegationGrant(this.db.prepare("SELECT * FROM delegation_grants WHERE grant_id=?").get(grantId));
    });
  }

  revokeGrantsForIssuerKey(issuerKeyId, { reason = "issuer_key_unavailable" } = {}) {
    const ids = this.db.prepare("SELECT grant_id FROM delegation_grants WHERE issuer_key_id=? AND status='active'").all(issuerKeyId);
    return ids.map(({ grant_id: grantId }) => this.revokeDelegationGrant(grantId, { reason }));
  }

  #insertDelegationGrantEvent({ grantId, type, payload, createdAt }) {
    const result = this.db.prepare(
      "INSERT INTO delegation_grant_events (grant_id, created_at, type, payload_json) VALUES (?, ?, ?, ?)",
    ).run(grantId, createdAt, type, canonicalJson(payload));
    return Number(result.lastInsertRowid);
  }

  listDelegationGrantEvents(grantId, after = 0) {
    return this.db.prepare(
      "SELECT * FROM delegation_grant_events WHERE grant_id=? AND event_id>? ORDER BY event_id",
    ).all(grantId, after).map((row) => ({
      eventId: row.event_id,
      grantId: row.grant_id,
      createdAt: iso(row.created_at),
      type: row.type,
      payload: parseJson(row.payload_json, {}),
    }));
  }

  // There is deliberately no public router/API writer for this table. The control-plane's
  // trusted observation path records hash-only facts after it owns the device/control tuple.
  recordAuthoritativeObservation({
    snapshotHash,
    app,
    accountFingerprint,
    pageFingerprint,
    observedTargetFingerprint,
    identityEvidenceHash,
    observedAt,
  }) {
    const fields = { snapshotHash, app, accountFingerprint, pageFingerprint, observedTargetFingerprint, identityEvidenceHash };
    for (const [name, value] of Object.entries(fields)) {
      if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} is required`);
    }
    const observedAtMs = Date.parse(observedAt);
    if (!Number.isFinite(observedAtMs)) throw new TypeError("observedAt must be an ISO timestamp");
    const normalized = {
      snapshotHash: snapshotHash.trim(), app: app.trim(), accountFingerprint: accountFingerprint.trim(),
      pageFingerprint: pageFingerprint.trim(), observedTargetFingerprint: observedTargetFingerprint.trim(),
      identityEvidenceHash: identityEvidenceHash.trim(), observedAt: new Date(observedAtMs).toISOString(),
    };
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM authoritative_observations WHERE snapshot_hash=?").get(normalized.snapshotHash);
      if (existing) {
        const same = existing.app === normalized.app && existing.account_fingerprint === normalized.accountFingerprint
          && existing.page_fingerprint === normalized.pageFingerprint && existing.observed_target_fingerprint === normalized.observedTargetFingerprint
          && existing.identity_evidence_hash === normalized.identityEvidenceHash && existing.observed_at === observedAtMs;
        if (!same) throw new ControlPlaneError("AUTHORITATIVE_OBSERVATION_CONFLICT", "snapshot hash is already bound to different observed facts", { status: 409 });
        return this.#publicAuthoritativeObservation(existing);
      }
      this.db.prepare(`
        INSERT INTO authoritative_observations (
          snapshot_hash, app, account_fingerprint, page_fingerprint, observed_target_fingerprint,
          identity_evidence_hash, observed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(normalized.snapshotHash, normalized.app, normalized.accountFingerprint, normalized.pageFingerprint,
        normalized.observedTargetFingerprint, normalized.identityEvidenceHash, observedAtMs, this.now());
      return this.#publicAuthoritativeObservation(this.db.prepare("SELECT * FROM authoritative_observations WHERE snapshot_hash=?").get(normalized.snapshotHash));
    });
  }

  #publicAuthoritativeObservation(row) {
    if (!row) return null;
    return {
      snapshotHash: row.snapshot_hash,
      app: row.app,
      accountFingerprint: row.account_fingerprint,
      pageFingerprint: row.page_fingerprint,
      observedTargetFingerprint: row.observed_target_fingerprint,
      identityEvidenceHash: row.identity_evidence_hash,
      observedAt: iso(row.observed_at),
    };
  }

  getAuthoritativeObservation(snapshotHash) {
    return this.#publicAuthoritativeObservation(this.db.prepare("SELECT * FROM authoritative_observations WHERE snapshot_hash=?").get(snapshotHash));
  }

  #publicMission(row) {
    if (!row) return null;
    const policy = parseJson(row.policy_json, {});
    // Constrained public projection of the immutable policy. Spreading the whole policy
    // leaked the caller's private idempotency dedup handle and the internal redaction config
    // and would blindly expose any future policy field. The stable public Mission contract is
    // an explicit allowlist: identity (missionId/hash/version), lifecycle, and the authorizing
    // scope/policy/validity — never the private dedup key or internal redaction rules.
    return {
      missionId: row.mission_id,
      version: row.version,
      missionHash: row.mission_hash,
      contentHash: row.content_hash,
      status: row.status,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      expiresAt: iso(row.expires_at),
      revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
      revokedReason: row.revoked_reason,
      parentGrantId: row.parent_grant_id,
      parentGrantHash: row.parent_grant_hash,
      schemaVersion: policy.schemaVersion,
      issuer: policy.issuer,
      app: policy.app,
      account: policy.account,
      parallelism: policy.parallelism,
      controllers: policy.controllers,
      scope: policy.scope,
      validity: policy.validity,
      policy: policy.policy,
    };
  }

  // Additive, idempotent Mission insert. The canonical identity is mission_id (derived
  // from the content hash); idempotency_key is the user-supplied dedup handle. Same key +
  // same content reuses; same key + different content conflicts; different key + same
  // content reuses the canonical mission. Never mutates an existing mission's scope.
  addMission({
    missionId,
    idempotencyKey,
    issuerActorId,
    version = 1,
    missionHash,
    contentHash,
    policy,
    expiresAtMs,
    parentGrantId = null,
    parentGrantHash = null,
  }) {
    const now = this.now();
    return this.transaction(() => {
      const byKey = this.db.prepare("SELECT * FROM missions WHERE idempotency_key=?").get(idempotencyKey);
      if (byKey) {
        if (byKey.mission_id !== missionId) {
          throw new ControlPlaneError("IDEMPOTENCY_CONFLICT", "idempotency key was used for a different mission", {
            status: 409,
            details: { missionId: byKey.mission_id },
          });
        }
        return { mission: this.#publicMission(byKey), reused: true };
      }
      const byId = this.db.prepare("SELECT * FROM missions WHERE mission_id=?").get(missionId);
      if (byId) {
        return { mission: this.#publicMission(byId), reused: true };
      }
      this.db.prepare(`
        INSERT INTO missions (
          mission_id, idempotency_key, issuer_actor_id, version, mission_hash, content_hash,
          policy_json, status, created_at, updated_at, expires_at, parent_grant_id, parent_grant_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
      `).run(
        missionId,
        idempotencyKey,
        issuerActorId,
        version,
        missionHash,
        contentHash,
        canonicalJson(policy),
        now,
        now,
        expiresAtMs,
        parentGrantId,
        parentGrantHash,
      );
      this.#insertMissionEvent({
        missionId,
        type: "mission.created",
        payload: { missionHash, contentHash, version, parentGrantId, parentGrantHash },
        createdAt: now,
      });
      return {
        mission: this.#publicMission(this.db.prepare("SELECT * FROM missions WHERE mission_id=?").get(missionId)),
        reused: false,
      };
    });
  }

  getMission(missionId) {
    return this.#publicMission(this.db.prepare("SELECT * FROM missions WHERE mission_id=?").get(missionId));
  }

  getMissionForRuntime(missionId) {
    const row = this.db.prepare("SELECT * FROM missions WHERE mission_id=?").get(missionId);
    if (!row) return null;
    const policy = parseJson(row.policy_json, {});
    return { ...this.#publicMission(row), ...(policy.verifiedDiscovery ? { verifiedDiscovery: policy.verifiedDiscovery } : {}) };
  }

  getMissionByIdempotencyKey(idempotencyKey) {
    return this.#publicMission(this.db.prepare("SELECT * FROM missions WHERE idempotency_key=?").get(idempotencyKey));
  }

  listMissions() {
    return this.db.prepare("SELECT * FROM missions ORDER BY created_at").all().map((row) => this.#publicMission(row));
  }

  setMissionStatus(missionId, status, { reason = null } = {}) {
    const now = this.now();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM missions WHERE mission_id=?").get(missionId);
      if (!row) throw new ControlPlaneError("MISSION_NOT_FOUND", `unknown mission ${missionId}`, { status: 404 });
      if (row.status === status) return this.#publicMission(row);
      this.db.prepare(
        "UPDATE missions SET status=?, updated_at=?, revoked_at=COALESCE(?, revoked_at), revoked_reason=COALESCE(?, revoked_reason) WHERE mission_id=?",
      ).run(status, now, status === "revoked" ? now : null, reason, missionId);
      return this.#publicMission(this.db.prepare("SELECT * FROM missions WHERE mission_id=?").get(missionId));
    });
  }

  #insertMissionEvent({ missionId, type, payload, createdAt }) {
    const result = this.db.prepare(
      "INSERT INTO mission_events (mission_id, created_at, type, payload_json) VALUES (?, ?, ?, ?)",
    ).run(missionId, createdAt, type, canonicalJson(payload));
    return Number(result.lastInsertRowid);
  }

  appendMissionEvent({ missionId, type, payload = {} }) {
    return this.#insertMissionEvent({ missionId, type, payload, createdAt: this.now() });
  }

  listMissionEvents(missionId, after = 0) {
    return this.db.prepare(
      "SELECT * FROM mission_events WHERE mission_id=? AND event_id>? ORDER BY event_id",
    ).all(missionId, after).map((row) => ({
      eventId: row.event_id,
      missionId: row.mission_id,
      createdAt: iso(row.created_at),
      type: row.type,
      payload: parseJson(row.payload_json, {}),
    }));
  }

  // Protected Human Commit durable records. The commitId is the human's per-commit handle; it
  // is persisted so a pending commit is observable and survives a StateStore reconstruct rather
  // than living only in a process-local Map. Control-plane restart cannot resume a pending human
  // commit (the device control tuple was lost), so recovery cancels it fail-closed; the durable
  // row remains the audit record until then.
  addProtectedCommit({ commitId, missionId, effectId, action, targetHash, status = "waiting_authorization" }) {
    if (!commitId || !missionId || !effectId || !action || !targetHash) {
      throw new TypeError("commitId, missionId, effectId, action, targetHash are required");
    }
    const now = this.now();
    this.db.prepare(`
      INSERT INTO protected_commits (commit_id, mission_id, effect_id, action, target_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(commitId, missionId, effectId, action, targetHash, status, now, now);
    return this.getProtectedCommit(commitId);
  }

  getProtectedCommit(commitId) {
    const row = this.db.prepare("SELECT * FROM protected_commits WHERE commit_id=?").get(commitId);
    if (!row) return null;
    return this.#publicProtectedCommit(row);
  }

  listProtectedCommits({ missionId = null, status = null } = {}) {
    let sql = "SELECT * FROM protected_commits";
    const conditions = [];
    const params = [];
    if (missionId) { conditions.push("mission_id=?"); params.push(missionId); }
    if (status) { conditions.push("status=?"); params.push(status); }
    if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += " ORDER BY created_at";
    return this.db.prepare(sql).all(...params).map((row) => this.#publicProtectedCommit(row));
  }

  removeProtectedCommit(commitId) {
    this.db.prepare("DELETE FROM protected_commits WHERE commit_id=?").run(commitId);
  }

  #publicProtectedCommit(row) {
    return {
      commitId: row.commit_id,
      missionId: row.mission_id,
      effectId: row.effect_id,
      action: row.action,
      targetFingerprint: row.target_hash,
      status: row.status,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  #recoverInterruptedProtectedCommits(now) {
    const pending = this.db.prepare(
      "SELECT * FROM protected_commits WHERE status='waiting_authorization'",
    ).all();
    for (const row of pending) {
      // A restart invalidates the in-memory prepared handle. Mark this durable commit terminal
      // so it cannot be decided or resumed after control was lost, while retaining commitId
      // and the terminal decision for audit.
      this.db.prepare(
        "UPDATE protected_commits SET status='recovered_cancelled', updated_at=? WHERE commit_id=?",
      ).run(now, row.commit_id);
      this.#insertMissionEvent({
        missionId: row.mission_id,
        type: "protected_human_commit.recovered_cancelled",
        payload: { commitId: row.commit_id, effectId: row.effect_id, action: row.action },
        createdAt: now,
      });
    }
    return pending.length;
  }

  #publicMissionEffect(row) {
    if (!row) return null;
    return {
      effectId: row.effect_id,
      missionId: row.mission_id,
      deviceRunId: row.device_run_id,
      idempotencyKey: row.idempotency_key,
      action: row.action,
      targetFingerprint: row.target_hash,
      intent: parseJson(row.intent_json, {}),
      status: row.status,
      reservation: parseJson(row.reservation_json, {}),
      reservationConsumed: Boolean(row.reservation_consumed),
      reservationReleased: Boolean(row.reservation_released),
      retryBlocked: Boolean(row.retry_blocked),
      evidenceRefs: parseJson(row.evidence_refs_json, []),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      finishedAt: row.finished_at ? iso(row.finished_at) : null,
    };
  }

  listMissionEffects(missionId) {
    return this.db.prepare(
      "SELECT * FROM mission_effects WHERE mission_id=? ORDER BY created_at, effect_id",
    ).all(missionId).map((row) => this.#publicMissionEffect(row));
  }

  beginMissionEffect({ mission, deviceRunId, action, targetHash, intent = {}, idempotencyKey, status = "started" }) {
    if (!mission?.missionId || !deviceRunId || !action || !targetHash || !idempotencyKey) {
      throw new TypeError("mission, deviceRunId, action, targetHash, and idempotencyKey are required");
    }
    const now = this.now();
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM mission_effects WHERE idempotency_key=?").get(idempotencyKey);
      if (existing) return { effect: this.#publicMissionEffect(existing), reused: true };
      const blockedRetry = this.db.prepare(`
        SELECT effect_id FROM mission_effects
        WHERE mission_id=? AND action=? AND target_hash=? AND retry_blocked=1
        LIMIT 1
      `).get(mission.missionId, action, targetHash);
      if (blockedRetry) {
        throw new ControlPlaneError("AMBIGUOUS_NO_RETRY", "an ambiguous effect for this target cannot be retried", {
          status: 409, details: { effectId: blockedRetry.effect_id },
        });
      }
      if (!mission.scope?.actions?.includes(action) || !mission.scope?.targets?.values?.includes(targetHash)) {
        throw new ControlPlaneError("SCOPE_VIOLATION", "effect action or target is outside Mission scope", { status: 409 });
      }
      const live = this.db.prepare(`
        SELECT action, target_hash, created_at FROM mission_effects
        WHERE mission_id=? AND reservation_released=0
      `).all(mission.missionId);
      const totalCount = Number(mission.scope.totalCount || 0);
      const perTargetCount = Number(mission.scope.perTargetCount || 0);
      const frequency = mission.scope.frequency || {};
      if (totalCount > 0 && live.length >= totalCount) {
        throw new ControlPlaneError("BUDGET_EXCEEDED", "Mission total effect budget is exhausted", { status: 409 });
      }
      if (perTargetCount > 0 && live.filter((row) => row.target_hash === targetHash).length >= perTargetCount) {
        throw new ControlPlaneError("BUDGET_PER_TARGET_EXCEEDED", "Mission per-target budget is exhausted", { status: 409 });
      }
      const frequencyCount = Number(frequency.count || 0);
      const windowMs = Number(frequency.windowSeconds || 0) * 1000;
      if (frequencyCount > 0 && windowMs > 0 && live.filter((row) => row.created_at >= now - windowMs).length >= frequencyCount) {
        throw new ControlPlaneError("BUDGET_THROTTLED", "Mission frequency budget is exhausted", { status: 409 });
      }
      const effectId = newId("effect");
      const reservation = { total: 1, perTarget: 1, frequency: 1 };
      this.db.prepare(`
        INSERT INTO mission_effects (
          effect_id, mission_id, device_run_id, idempotency_key, action, target_hash,
          intent_json, status, reservation_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        effectId, mission.missionId, deviceRunId, idempotencyKey, action, targetHash,
        canonicalJson(redactEffectIntent(intent)), status, canonicalJson(reservation), now, now,
      );
      this.#insertMissionEvent({
        missionId: mission.missionId,
        type: status === "started" ? "effect.started" : "effect.reserved",
        payload: { effectId, deviceRunId, action, targetFingerprint: targetHash },
        createdAt: now,
      });
      return {
        effect: this.#publicMissionEffect(this.db.prepare("SELECT * FROM mission_effects WHERE effect_id=?").get(effectId)),
        reused: false,
      };
    });
  }

  recordMissionEffectOutcome(effectId, { status, evidenceRefs = [] } = {}) {
    if (!["verified", "ambiguous", "not_sent", "cancelled"].includes(status)) {
      throw new TypeError("unsupported mission effect outcome");
    }
    const now = this.now();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM mission_effects WHERE effect_id=?").get(effectId);
      if (!row) throw new ControlPlaneError("EFFECT_NOT_FOUND", `unknown effect ${effectId}`, { status: 404 });
      const consumed = status !== "not_sent";
      const retryBlocked = status === "ambiguous";
      this.db.prepare(`
        UPDATE mission_effects SET
          status=?, reservation_consumed=?, retry_blocked=?, evidence_refs_json=?,
          updated_at=?, finished_at=?
        WHERE effect_id=?
      `).run(status, consumed ? 1 : 0, retryBlocked ? 1 : 0, canonicalJson(evidenceRefs), now, now, effectId);
      this.#insertMissionEvent({
        missionId: row.mission_id,
        type: `effect.${status}`,
        payload: { effectId, evidenceRefs },
        createdAt: now,
      });
      return this.#publicMissionEffect(this.db.prepare("SELECT * FROM mission_effects WHERE effect_id=?").get(effectId));
    });
  }

  setMissionEffectWaitingAuthorization(effectId) {
    const now = this.now();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM mission_effects WHERE effect_id=?").get(effectId);
      if (!row) throw new ControlPlaneError("EFFECT_NOT_FOUND", `unknown effect ${effectId}`, { status: 404 });
      if (row.status !== "pending_authorization") {
        throw new ControlPlaneError("EFFECT_AUTHORIZATION_INVALID", "effect is not pending authorization", { status: 409 });
      }
      this.db.prepare("UPDATE mission_effects SET status='waiting_authorization', updated_at=? WHERE effect_id=?")
        .run(now, effectId);
      this.#insertMissionEvent({
        missionId: row.mission_id,
        type: "protected_human_commit.waiting_authorization",
        payload: { effectId },
        createdAt: now,
      });
      return this.#publicMissionEffect(this.db.prepare("SELECT * FROM mission_effects WHERE effect_id=?").get(effectId));
    });
  }

  startAuthorizedMissionEffect(effectId) {
    const now = this.now();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM mission_effects WHERE effect_id=?").get(effectId);
      if (!row) throw new ControlPlaneError("EFFECT_NOT_FOUND", `unknown effect ${effectId}`, { status: 404 });
      if (!['pending_authorization', 'waiting_authorization'].includes(row.status)) {
        throw new ControlPlaneError("EFFECT_START_INVALID", "effect cannot start from its current state", { status: 409 });
      }
      this.db.prepare("UPDATE mission_effects SET status='started', updated_at=? WHERE effect_id=?").run(now, effectId);
      this.#insertMissionEvent({
        missionId: row.mission_id,
        type: "effect.started",
        payload: { effectId },
        createdAt: now,
      });
      return this.#publicMissionEffect(this.db.prepare("SELECT * FROM mission_effects WHERE effect_id=?").get(effectId));
    });
  }

  retryNotSentMissionEffect(effectId) {
    const now = this.now();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM mission_effects WHERE effect_id=?").get(effectId);
      if (!row) throw new ControlPlaneError("EFFECT_NOT_FOUND", `unknown effect ${effectId}`, { status: 404 });
      if (row.status !== "not_sent" || row.reservation_released) {
        throw new ControlPlaneError("EFFECT_RETRY_UNSAFE", "only a reserved not_sent effect may retry", { status: 409 });
      }
      this.db.prepare(`
        UPDATE mission_effects SET status='started', updated_at=?, finished_at=NULL WHERE effect_id=?
      `).run(now, effectId);
      this.#insertMissionEvent({
        missionId: row.mission_id,
        type: "effect.retry_started",
        payload: { effectId },
        createdAt: now,
      });
      return this.#publicMissionEffect(this.db.prepare("SELECT * FROM mission_effects WHERE effect_id=?").get(effectId));
    });
  }

  abandonNotSentMissionEffect(effectId) {
    const now = this.now();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM mission_effects WHERE effect_id=?").get(effectId);
      if (!row) throw new ControlPlaneError("EFFECT_NOT_FOUND", `unknown effect ${effectId}`, { status: 404 });
      if (row.status !== "not_sent" || row.reservation_released) {
        throw new ControlPlaneError("EFFECT_RELEASE_UNSAFE", "only a reserved not_sent effect may be abandoned", { status: 409 });
      }
      this.db.prepare(`
        UPDATE mission_effects SET status='abandoned', reservation_released=1, updated_at=?, finished_at=? WHERE effect_id=?
      `).run(now, now, effectId);
      this.#insertMissionEvent({
        missionId: row.mission_id,
        type: "effect.abandoned",
        payload: { effectId },
        createdAt: now,
      });
      return this.#publicMissionEffect(this.db.prepare("SELECT * FROM mission_effects WHERE effect_id=?").get(effectId));
    });
  }

  #publicDeviceRun(row) {
    if (!row) return null;
    return {
      deviceRunId: row.device_run_id,
      missionId: row.mission_id,
      missionHash: row.mission_hash,
      missionVersion: row.mission_version,
      deviceId: row.device_id,
      sessionId: row.session_id,
      leaseId: row.lease_id,
      controllerAgent: row.controller_agent,
      controllerEpoch: row.controller_epoch,
      phase: row.phase,
      outcome: row.outcome,
      heartbeatAt: iso(row.heartbeat_at),
      readinessReceipt: parseJson(row.readiness_receipt_json, null),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      finishedAt: row.finished_at ? iso(row.finished_at) : null,
    };
  }

  #publicDiscoveryRun(row, token = null) {
    if (!row) return null;
    const tuple = {
      discoveryRunId: row.discovery_run_id,
      sessionId: row.session_id,
      controllerAgent: row.controller_agent,
      controllerEpoch: row.controller_epoch,
    };
    return {
      discoveryRunId: row.discovery_run_id,
      grantId: row.grant_id,
      grantHash: row.grant_hash,
      deviceId: row.device_id,
      sessionId: row.session_id,
      leaseId: row.lease_id,
      controllerAgent: row.controller_agent,
      controllerEpoch: row.controller_epoch,
      status: row.status,
      policyHash: row.policy_hash,
      openedAt: iso(row.opened_at),
      deadlineAt: iso(row.deadline_at),
      maxPrimitives: row.max_primitives,
      maxCandidates: row.max_candidates,
      maxParallelism: row.max_parallelism,
      primitiveCount: row.primitive_count,
      candidateCount: row.candidate_count,
      releaseAt: iso(row.release_at),
      releasedTupleHashes: parseJson(row.released_tuple_hashes_json, null),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      tuple,
      ...(token ? { token } : {}),
    };
  }

  #insertDiscoveryEvent({ discoveryRunId, type, payload, createdAt }) {
    this.db.prepare(
      "INSERT INTO discovery_events (discovery_run_id, created_at, type, payload_json) VALUES (?, ?, ?, ?)",
    ).run(discoveryRunId, createdAt, type, canonicalJson(payload));
  }

  #assertDiscoveryRunOwnership(row, tuple, now) {
    if (!tuple || typeof tuple !== "object"
      || tuple.discoveryRunId !== row.discovery_run_id
      || tuple.sessionId !== row.session_id
      || tuple.controllerAgent !== row.controller_agent
      || tuple.controllerEpoch !== row.controller_epoch) {
      throw new ControlPlaneError("DISCOVERY_TUPLE_MISMATCH", "DiscoveryRun control tuple is stale or incomplete", { status: 409 });
    }
    if (!["running", "sealing"].includes(row.status)) {
      throw new ControlPlaneError("DISCOVERY_RUN_NOT_ACTIVE", "DiscoveryRun is not active", { status: 409 });
    }
    const session = this.db.prepare("SELECT * FROM sessions WHERE session_id=?").get(row.session_id);
    const lease = this.db.prepare("SELECT * FROM leases WHERE lease_id=?").get(row.lease_id);
    if (!session || !lease || lease.owner_discovery_run_id !== row.discovery_run_id || session.lease_id !== row.lease_id
      || lease.device_id !== row.device_id || lease.expires_at <= now) {
      throw new ControlPlaneError("DISCOVERY_CONTROL_LOST", "DiscoveryRun no longer owns its active session and lease", { status: 409 });
    }
    const device = this.db.prepare("SELECT online, quarantined FROM devices WHERE device_id=?").get(row.device_id);
    if (!device || !device.online || device.quarantined) {
      throw new ControlPlaneError("DISCOVERY_READINESS_LOST", "canonical device is no longer ready", { status: 409 });
    }
    return { session, lease };
  }

  #releaseDiscoveryRun(row, terminalStatus, now, reason = null) {
    const tupleHashes = {
      discoveryRunId: fingerprint(row.discovery_run_id),
      sessionId: fingerprint(row.session_id),
      leaseId: fingerprint(row.lease_id),
      controllerEpoch: fingerprint(String(row.controller_epoch)),
    };
    this.db.prepare("DELETE FROM leases WHERE lease_id=?").run(row.lease_id);
    this.db.prepare(`
      UPDATE discovery_runs SET status=?, release_at=?, released_tuple_hashes_json=?, updated_at=?
      WHERE discovery_run_id=? AND status IN ('running', 'sealing')
    `).run(terminalStatus, now, canonicalJson(tupleHashes), now, row.discovery_run_id);
    this.#insertDiscoveryEvent({
      discoveryRunId: row.discovery_run_id,
      type: `discovery_run.${terminalStatus}`,
      payload: { reason, released: true },
      createdAt: now,
    });
    return this.#publicDiscoveryRun(this.db.prepare("SELECT * FROM discovery_runs WHERE discovery_run_id=?").get(row.discovery_run_id));
  }

  openDiscoveryRunStorage({
    grantId,
    grantHash,
    controllerAgent,
    authorityNodeId,
    placement = {},
    registrySnapshot = null,
    gates = {},
    ttlMs = 60000,
    faultAfter = null,
  }) {
    if (typeof grantId !== "string" || grantId.trim() === "" || typeof controllerAgent !== "string" || controllerAgent.trim() === "") {
      throw new ControlPlaneError("DISCOVERY_INPUT_INVALID", "grantId and controllerAgent are required", { status: 400 });
    }
    const placementRequest = normalizePlacementRequest({ deviceId: null, placement });
    const now = this.now();
    this.cleanupExpiredLeases();
    return this.transaction(() => {
      const grantRow = this.db.prepare("SELECT * FROM delegation_grants WHERE grant_id=?").get(grantId);
      if (!grantRow || grantRow.status !== "active") throw new ControlPlaneError("GRANT_NOT_ACTIVE", "DiscoveryRun requires an active Grant", { status: 409 });
      if (grantRow.grant_hash !== grantHash) throw new ControlPlaneError("GRANT_HASH_DRIFT", "DiscoveryRun Grant hash drifted", { status: 409 });
      let grant;
      try { grant = parseJson(grantRow.grant_json, {}); } catch { throw new ControlPlaneError("GRANT_POLICY_INVALID", "DiscoveryRun Grant is malformed", { status: 409 }); }
      const policy = grant.discoveryPolicy;
      if (!policy || policy.enabled !== true) throw new ControlPlaneError("DISCOVERY_POLICY_DISABLED", "DiscoveryPolicy is not enabled", { status: 409 });
      if (policy.maxParallelism !== 1) throw new ControlPlaneError("PARALLELISM_UNSUPPORTED", "DiscoveryPolicy parallelism must be one", { status: 409 });
      if (!gates.missionAutoApprovalEnabled || !gates.standingGrantEnabled || !gates.adrAccepted || !gates.issuerReady) {
        throw new ControlPlaneError("DISCOVERY_GATE_CLOSED", "DiscoveryRun gate is closed", { status: 409 });
      }
      const requestedNodeId = placementRequest.placement.nodeId || authorityNodeId;
      const node = this.getNode(requestedNodeId);
      if (!node || node.status !== "online" || node.dispatchMode !== "local") {
        throw new ControlPlaneError("NODE_UNAVAILABLE", "authority node is unavailable", { status: 409 });
      }
      const candidates = this.#placementCandidates().filter((candidate) => {
        const requiredTags = placementRequest.placement.requiredTags || [];
        return candidate.nodeId === requestedNodeId && candidate.online && !candidate.quarantined
          && candidate.routingProfile.enabled && (!placementRequest.placement.physicalLabel || candidate.physicalLabel === placementRequest.placement.physicalLabel)
          && requiredTags.every((tag) => candidate.routingProfile.tags.includes(tag));
      }).sort((left, right) => left.physicalLabel.localeCompare(right.physicalLabel) || left.deviceId.localeCompare(right.deviceId));
      const selected = candidates.find((candidate) => candidate.effectiveLoad === 0);
      if (!selected) throw new ControlPlaneError(candidates.length ? "DEVICE_BUSY" : "NO_ELIGIBLE_DEVICE", "no canonical ready and free device", { status: 409 });
      if (registrySnapshot && (registrySnapshot.deviceId !== selected.deviceId || registrySnapshot.online === false || registrySnapshot.quarantined === true)) {
        throw new ControlPlaneError("READINESS_SPLIT", "registry and canonical readiness disagree", { status: 409 });
      }
      const discoveryRunId = newId("discovery_run");
      const leaseId = newId("lease");
      const sessionId = newId("session");
      const token = newId("lease_token");
      const deadlineAt = now + policy.defaults.durationMs;
      this.db.prepare(`
        INSERT INTO leases (lease_id, device_id, kind, holder_id, job_id, token_hash, created_at, heartbeat_at, expires_at, owner_discovery_run_id)
        VALUES (?, ?, 'discovery', ?, NULL, ?, ?, ?, ?, ?)
      `).run(leaseId, selected.deviceId, controllerAgent, sha256(token), now, now, now + ttlMs, discoveryRunId);
      if (faultAfter === "afterLease") throw new ControlPlaneError("DISCOVERY_OPEN_FAULT", "injected DiscoveryRun open fault", { status: 500 });
      this.db.prepare(`
        INSERT INTO sessions (session_id, lease_id, actor_id, device_id, token_hash, canary, scope_capability_id, placement_decision_json, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)
      `).run(sessionId, leaseId, controllerAgent, selected.deviceId, sha256(token), canonicalJson({ mode: placementRequest.mode, decision: "dispatchable", selectedDeviceId: selected.deviceId, source: "discovery" }), now, now + ttlMs);
      this.db.prepare(`
        INSERT INTO discovery_runs (
          discovery_run_id, grant_id, grant_hash, device_id, session_id, lease_id, controller_agent, controller_epoch, status,
          policy_hash, policy_json, opened_at, deadline_at, max_primitives, max_candidates, max_parallelism, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'running', ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(discoveryRunId, grantId, grantHash, selected.deviceId, sessionId, leaseId, controllerAgent, fingerprint(policy), canonicalJson(policy), now, deadlineAt, policy.defaults.maxPrimitives, policy.defaults.maxCandidates, now, now);
      this.#insertDiscoveryEvent({ discoveryRunId, type: "discovery_run.opened", payload: { grantId, grantHash, deviceId: selected.deviceId, controllerEpoch: 1 }, createdAt: now });
      return this.#publicDiscoveryRun(this.db.prepare("SELECT * FROM discovery_runs WHERE discovery_run_id=?").get(discoveryRunId), token);
    });
  }

  getDiscoveryRun(discoveryRunId) {
    return this.#publicDiscoveryRun(this.db.prepare("SELECT * FROM discovery_runs WHERE discovery_run_id=?").get(discoveryRunId));
  }

  listDiscoveryRuns({ status = null } = {}) {
    const rows = status
      ? this.db.prepare("SELECT * FROM discovery_runs WHERE status=? ORDER BY created_at").all(status)
      : this.db.prepare("SELECT * FROM discovery_runs ORDER BY created_at").all();
    return rows.map((row) => this.#publicDiscoveryRun(row));
  }

  heartbeatDiscoveryRunStorage({ discoveryRunId, tuple, ttlMs = 60000 }) {
    const now = this.now();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM discovery_runs WHERE discovery_run_id=?").get(discoveryRunId);
      if (!row) throw new ControlPlaneError("DISCOVERY_RUN_NOT_FOUND", "unknown DiscoveryRun", { status: 404 });
      this.#assertDiscoveryRunOwnership(row, tuple, now);
      this.db.prepare("UPDATE leases SET heartbeat_at=?, expires_at=? WHERE lease_id=?").run(now, now + ttlMs, row.lease_id);
      this.db.prepare("UPDATE sessions SET expires_at=? WHERE session_id=?").run(now + ttlMs, row.session_id);
      this.db.prepare("UPDATE discovery_runs SET updated_at=? WHERE discovery_run_id=?").run(now, row.discovery_run_id);
      this.#insertDiscoveryEvent({ discoveryRunId, type: "discovery_run.heartbeat", payload: {}, createdAt: now });
      return this.#publicDiscoveryRun(this.db.prepare("SELECT * FROM discovery_runs WHERE discovery_run_id=?").get(discoveryRunId));
    });
  }

  sealDiscoveryRunStorage({ discoveryRunId, tuple }) {
    const now = this.now();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM discovery_runs WHERE discovery_run_id=?").get(discoveryRunId);
      if (!row) throw new ControlPlaneError("DISCOVERY_RUN_NOT_FOUND", "unknown DiscoveryRun", { status: 404 });
      this.#assertDiscoveryRunOwnership(row, tuple, now);
      this.db.prepare("UPDATE discovery_runs SET status='sealing', updated_at=? WHERE discovery_run_id=? AND status='running'").run(now, discoveryRunId);
      const sealing = this.db.prepare("SELECT * FROM discovery_runs WHERE discovery_run_id=?").get(discoveryRunId);
      return this.#releaseDiscoveryRun(sealing, "sealed", now);
    });
  }

  abortDiscoveryRunStorage({ discoveryRunId, tuple, reason = "aborted" }) {
    const now = this.now();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM discovery_runs WHERE discovery_run_id=?").get(discoveryRunId);
      if (!row) throw new ControlPlaneError("DISCOVERY_RUN_NOT_FOUND", "unknown DiscoveryRun", { status: 404 });
      this.#assertDiscoveryRunOwnership(row, tuple, now);
      return this.#releaseDiscoveryRun(row, "aborted", now, reason);
    });
  }

  // Atomic placement + lease + Session + device_run in one BEGIN IMMEDIATE transaction.
  // Selects exactly one canonical ready+free device (no capability required, since Explorer
  // primitives are not typed actions). The lease is owned by the device_run. A registry
  // mirror may be supplied for a READINESS_SPLIT check; it can only restrict, never permit.
  openDeviceRunStorage({
    missionId,
    missionHash,
    missionVersion,
    controllerAgent,
    authorityNodeId,
    placement = {},
    registrySnapshot = null,
    ttlMs = 60000,
  }) {
    const placementRequest = normalizePlacementRequest({ deviceId: null, placement });
    const now = this.now();
    this.cleanupExpiredLeases();
    return this.transaction(() => {
      const requestedNodeId = placementRequest.placement.nodeId || authorityNodeId;
      const node = this.getNode(requestedNodeId);
      if (!node || node.status !== "online" || node.dispatchMode !== "local") {
        throw new ControlPlaneError("NODE_UNAVAILABLE", `node ${requestedNodeId} is unavailable for local dispatch`, {
          status: 409, details: { nodeId: requestedNodeId },
        });
      }
      const candidates = this.#placementCandidates();
      const matching = candidates.filter((candidate) => {
        if (candidate.nodeId !== requestedNodeId || !candidate.online || candidate.quarantined) return false;
        if (!candidate.routingProfile.enabled) return false;
        if (placementRequest.placement.physicalLabel
          && candidate.physicalLabel !== placementRequest.placement.physicalLabel) return false;
        const requiredTags = placementRequest.placement.requiredTags || [];
        if (!requiredTags.every((tag) => candidate.routingProfile.tags.includes(tag))) return false;
        return true;
      });
      const free = matching.filter((candidate) => candidate.effectiveLoad === 0);
      free.sort((left, right) => (
        left.physicalLabel.localeCompare(right.physicalLabel)
        || left.deviceId.localeCompare(right.deviceId)
      ));
      const selected = free[0];
      if (!selected) {
        const anyReady = matching.length > 0;
        const code = anyReady ? "DEVICE_BUSY" : "NO_ELIGIBLE_DEVICE";
        throw new ControlPlaneError(
          code,
          code === "DEVICE_BUSY" ? "all eligible devices are busy" : "no device satisfies the placement request",
          { status: code === "DEVICE_BUSY" ? 423 : 409, details: { missionId, nodeId: requestedNodeId } },
        );
      }
      if (registrySnapshot && typeof registrySnapshot === "object") {
        const reg = registrySnapshot;
        if ((typeof reg.deviceId === "string" && reg.deviceId !== selected.deviceId)
          || (typeof reg.alias === "string" && reg.alias !== selected.alias)
          || (typeof reg.physicalLabel === "string" && reg.physicalLabel !== selected.physicalLabel)
          || reg.online === false
          || reg.quarantined === true) {
          throw new ControlPlaneError(
            "READINESS_SPLIT",
            "registry and control plane readiness disagree",
            { status: 409, details: { deviceId: selected.deviceId } },
          );
        }
      }
      const rawDevice = this.db.prepare("SELECT updated_at FROM devices WHERE device_id=?").get(selected.deviceId);
      const readinessReceipt = {
        source: "control-plane",
        deviceId: selected.deviceId,
        alias: selected.alias,
        version: rawDevice?.updated_at ?? null,
        ready: true,
        checkedAt: iso(now),
        registryCoherent: registrySnapshot ? true : null,
      };
      const routeDecision = {
        mode: placementRequest.mode,
        decision: "dispatchable",
        selectedNodeId: selected.nodeId,
        selectedDeviceId: selected.deviceId,
        selectedDevice: {
          deviceId: selected.deviceId,
          alias: selected.alias,
          physicalLabel: selected.physicalLabel,
          nodeId: selected.nodeId,
        },
        queueDepth: selected.pendingJobs,
        waitingApproval: selected.waitingApproval,
        activeLease: selected.activeLease,
        requiredResources: ["device"],
        selector: placementRequest.placement,
        assignedAt: iso(now),
        advisory: false,
      };

      const deviceRunId = newId("device_run");
      const leaseId = newId("lease");
      const sessionId = newId("session");
      const token = newId("lease_token");
      const tokenHash = sha256(token);
      try {
        this.db.prepare(`
          INSERT INTO leases (
            lease_id, device_id, kind, holder_id, job_id, token_hash, created_at, heartbeat_at, expires_at, owner_device_run_id
          ) VALUES (?, ?, 'mission', ?, NULL, ?, ?, ?, ?, ?)
        `).run(leaseId, selected.deviceId, controllerAgent, tokenHash, now, now, now + ttlMs, deviceRunId);
      } catch (error) {
        if (String(error?.message).includes("UNIQUE constraint failed: leases.device_id")) {
          throw new ControlPlaneError("DEVICE_BUSY", "device already has an active lease", {
            status: 423, details: { missionId, deviceId: selected.deviceId },
          });
        }
        throw error;
      }
      this.db.prepare(`
        INSERT INTO sessions (
          session_id, lease_id, actor_id, device_id, token_hash, canary,
          scope_capability_id, placement_decision_json, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)
      `).run(sessionId, leaseId, controllerAgent, selected.deviceId, tokenHash, canonicalJson(routeDecision), now, now + ttlMs);
      this.db.prepare(`
        INSERT INTO device_runs (
          device_run_id, mission_id, mission_hash, mission_version, device_id, session_id, lease_id,
          controller_agent, controller_epoch, heartbeat_at, phase, outcome, readiness_receipt_json,
          created_at, updated_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'running', NULL, ?, ?, ?, NULL)
      `).run(
        deviceRunId, missionId, missionHash, missionVersion, selected.deviceId, sessionId, leaseId,
        controllerAgent, now, canonicalJson(readinessReceipt), now, now,
      );
      this.#insertMissionEvent({
        missionId,
        type: "device_run.opened",
        payload: {
          deviceRunId, deviceId: selected.deviceId, sessionId, leaseId,
          controllerAgent, controllerEpoch: 1,
        },
        createdAt: now,
      });
      const leaseRow = this.db.prepare("SELECT * FROM leases WHERE lease_id=?").get(leaseId);
      return {
        deviceRunId,
        missionId,
        deviceId: selected.deviceId,
        sessionId,
        leaseId,
        token,
        controllerAgent,
        controllerEpoch: 1,
        lease: publicLease(leaseRow, token),
        routeDecision,
        readinessReceipt,
        heartbeatAt: iso(now),
        tuple: {
          missionId,
          deviceRunId,
          sessionId,
          controllerAgent,
          controllerEpoch: 1,
        },
      };
    });
  }

  getDeviceRun(deviceRunId) {
    return this.#publicDeviceRun(this.db.prepare("SELECT * FROM device_runs WHERE device_run_id=?").get(deviceRunId));
  }

  listDeviceRuns({ missionId = null, phase = null } = {}) {
    let sql = "SELECT * FROM device_runs";
    const conditions = [];
    const params = [];
    if (missionId) { conditions.push("mission_id=?"); params.push(missionId); }
    if (phase) { conditions.push("phase=?"); params.push(phase); }
    if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += " ORDER BY created_at";
    return this.db.prepare(sql).all(...params).map((row) => this.#publicDeviceRun(row));
  }

  updateDeviceRunPhase(deviceRunId, phase, { outcome = null, controllerEpoch = null } = {}) {
    const now = this.now();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM device_runs WHERE device_run_id=?").get(deviceRunId);
      if (!row) throw new ControlPlaneError("DEVICE_RUN_NOT_FOUND", `unknown device run ${deviceRunId}`, { status: 404 });
      const terminal = ["succeeded", "failed", "ambiguous", "blocked", "cancelled", "paused_control_lost"];
      this.db.prepare(`
        UPDATE device_runs SET
          phase=?,
          outcome=COALESCE(?, outcome),
          controller_epoch=COALESCE(?, controller_epoch),
          heartbeat_at=?,
          updated_at=?,
          finished_at=COALESCE(?, finished_at)
        WHERE device_run_id=?
      `).run(phase, outcome, controllerEpoch, now, now, terminal.includes(phase) ? now : null, deviceRunId);
      this.#insertMissionEvent({
        missionId: row.mission_id,
        type: `device_run.${phase}`,
        payload: { deviceRunId, outcome, ...(controllerEpoch !== null ? { controllerEpoch } : {}) },
        createdAt: now,
      });
      return this.#publicDeviceRun(this.db.prepare("SELECT * FROM device_runs WHERE device_run_id=?").get(deviceRunId));
    });
  }

  heartbeatDeviceRunStorage(deviceRunId, ttlMs = 60000) {
    const now = this.now();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM device_runs WHERE device_run_id=?").get(deviceRunId);
      if (!row) throw new ControlPlaneError("DEVICE_RUN_NOT_FOUND", `unknown device run ${deviceRunId}`, { status: 404 });
      this.db.prepare("UPDATE leases SET heartbeat_at=?, expires_at=? WHERE lease_id=?")
        .run(now, now + ttlMs, row.lease_id);
      this.db.prepare("UPDATE sessions SET expires_at=? WHERE session_id=?").run(now + ttlMs, row.session_id);
      this.db.prepare("UPDATE device_runs SET heartbeat_at=?, updated_at=? WHERE device_run_id=?")
        .run(now, now, deviceRunId);
      return this.#publicDeviceRun(this.db.prepare("SELECT * FROM device_runs WHERE device_run_id=?").get(deviceRunId));
    });
  }
}
