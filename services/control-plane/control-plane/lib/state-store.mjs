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

function publicLease(row, token) {
  return {
    leaseId: row.lease_id,
    deviceId: row.device_id,
    kind: row.kind,
    holderId: row.holder_id,
    jobId: row.job_id,
    expiresAt: iso(row.expires_at),
    heartbeatAt: iso(row.heartbeat_at),
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
    this.db.exec("PRAGMA user_version = 2;");
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
      this.db.exec("DELETE FROM sessions; DELETE FROM leases;");
    });
    return interrupted.map((row) => row.job_id);
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
        invocation: "job",
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

  acquireLease({ deviceId, kind, holderId, jobId = null, ttlMs = 60000 }) {
    this.requireDevice(deviceId);
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
}
