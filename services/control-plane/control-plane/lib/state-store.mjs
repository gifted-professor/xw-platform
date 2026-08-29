import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  deriveM64LiveWindowAuthorizationBodyHash,
  deriveM64LiveWindowAuthorizationEnvelopeHash,
  selectM64LiveWindowRuntimeBinding,
} from "../../../../packages/kernel/lib/m6-4-live-window-authorization.mjs";
import { canonicalJson, fingerprint, newId, sha256 } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";
import {
  deriveM6GateFSafetyClosePackageHash,
  deriveM6GateFSafetyCloseProofHash,
} from "./m6-gate-safety-close-arm.mjs";
import { isM64LiveWindowAuthorizationVerification } from "./m6-live-window-authorization.mjs";
import { isSoftBudgetAuthority } from "./mission-policy.mjs";
import {
  normalizePlacementRequest,
  normalizeRoutingProfile,
  selectPlacement,
} from "./placement.mjs";
import {
  issueTransportActionAuthorization as issueTransportAuthKernel,
  consumeTransportActionAuthorization as consumeTransportAuthKernel,
} from "./transport-action-authorization.mjs";

export const CURRENT_CONTROL_SCHEMA_VERSION = 20;

const ACTIVE_JOB_STATES = new Set(["running", "verifying", "restoring"]);
const TERMINAL_JOB_STATES = new Set(["succeeded", "failed", "ambiguous", "recovery_required", "cancelled"]);
const M6_GROUNDED_RUN_CAPABILITY_ID = "xiaowei.m6.grounded_run";
const M6_PRODUCTION_BROKER_ACTOR_ID = "agent:m6-production-broker";
const M6_QUALIFICATION_CAPABILITY_ID = "xiaowei.m6.qualify_environment";
const M6_QUALIFICATION_ACTOR_ID = "operator:m6-target-environment-qualification";
const M6_QUALIFICATION_JOB_AUTHORITY = Symbol("m6-qualification-job-authority");
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
    supersededBy: row.superseded_by ?? null,
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
  constructor({ dbPath = ":memory:", now = Date.now, m6RuntimeMode = "STANDARD" } = {}) {
    assertNodeSqliteRuntime();
    if (!["STANDARD", "QUALIFICATION_ONLY", "FINAL"].includes(m6RuntimeMode)) {
      throw new ControlPlaneError("M6_RUNTIME_MODE_INVALID", "StateStore M6 runtime mode is not recognized", { status: 503 });
    }
    this.dbPath = dbPath;
    this.now = now;
    this.m6RuntimeMode = m6RuntimeMode;
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      if (dbPath !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      this.#migrate();
      // Qualification bootstrap verifies that migration preserves the exact
      // pre-migration legacy row set before it seeds the generation-0 fence.
      // Ordinary restart recovery intentionally rewrites that row set (for
      // example, it removes expired sessions/leases and marks interrupted
      // actions ambiguous), so the qualification-only opener must stop after
      // schema migration. STANDARD and FINAL retain normal startup recovery.
      if (m6RuntimeMode !== "QUALIFICATION_ONLY") this.recoverInterruptedWork();
    } catch (error) {
      try { this.db.close(); } catch {}
      throw error;
    }
  }

  #readUserVersion() {
    return Number(this.db.prepare("PRAGMA user_version").get().user_version);
  }

  #setUserVersion(version) {
    this.db.exec(`PRAGMA user_version = ${Number(version)}`);
  }

  #migrateV16ToV17() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS device_session_actions (
        session_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        action_id TEXT,
        fingerprint_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        executed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS device_session_actions_session_idx
        ON device_session_actions(session_id, created_at);
    `);
  }

  #migrateV17ToV18() {
    this.#ensureColumn("device_session_actions", "status", "TEXT NOT NULL DEFAULT 'COMPLETED'");
    this.#ensureColumn("device_session_actions", "execution_mode", "TEXT NOT NULL DEFAULT 'fixture'");
    this.#ensureColumn("device_session_actions", "transport_called", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("device_session_actions", "executor_id", "TEXT");
    this.#ensureColumn("device_session_actions", "effect_assessment_json", "TEXT");
    this.#ensureColumn("device_session_actions", "before_observation_id", "TEXT");
    this.#ensureColumn("device_session_actions", "preflight_observation_id", "TEXT");
    this.#ensureColumn("device_session_actions", "after_observation_id", "TEXT");
    this.#ensureColumn("device_session_actions", "error_code", "TEXT");
    this.#ensureColumn("device_session_actions", "updated_at", "INTEGER NOT NULL DEFAULT 0");
    this.db.exec(`
      UPDATE device_session_actions
      SET status = CASE WHEN executed = 1 THEN 'COMPLETED' ELSE status END,
          updated_at = CASE WHEN updated_at = 0 THEN created_at ELSE updated_at END
      WHERE updated_at = 0 OR (executed = 1 AND status = 'COMPLETED');
    `);
    this.#recoverInFlightActions();
  }

  #migrateV18ToV19() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS m6_gate_fence (
        marker TEXT PRIMARY KEY CHECK(marker='M6'),
        gate_id TEXT NOT NULL,
        epoch_hash TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK(generation>=0),
        mode TEXT NOT NULL,
        purpose TEXT,
        allowlist_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        release_id TEXT NOT NULL,
        source_commit TEXT NOT NULL,
        locks_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS m6_emergency_close_consumptions (
        nonce TEXT PRIMARY KEY,
        authorization_hash TEXT NOT NULL UNIQUE,
        reason_code TEXT NOT NULL,
        consumed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS m6_grounding_permits (
        permit_id TEXT PRIMARY KEY,
        permit_hash TEXT NOT NULL UNIQUE,
        decision_ref TEXT NOT NULL UNIQUE,
        operation_key TEXT NOT NULL,
        permit_json TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        consumption_receipt_json TEXT
      );
      CREATE TABLE IF NOT EXISTS m6_action_claims (
        operation_key TEXT PRIMARY KEY,
        action_id TEXT NOT NULL UNIQUE,
        slot_spec_hash TEXT NOT NULL,
        target_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS m6_grounded_action_details (
        action_id TEXT PRIMARY KEY,
        operation_key TEXT NOT NULL UNIQUE REFERENCES m6_action_claims(operation_key),
        permit_id TEXT NOT NULL UNIQUE REFERENCES m6_grounding_permits(permit_id),
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        authorization_receipt_json TEXT,
        guard_receipt_json TEXT,
        transport_result_json TEXT,
        completion_receipt_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  #ensureV19LiveWindowAuthorizationSchema() {
    // Older production v19 databases may predate Gate-F owner authorization, so
    // table creation remains idempotent while v20 adds the normal-close terminal
    // proof binding through an explicit migration.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS m6_live_window_authorization_consumptions (
        nonce_hash TEXT PRIMARY KEY,
        authorization_id TEXT NOT NULL UNIQUE,
        body_hash TEXT NOT NULL UNIQUE,
        envelope_hash TEXT NOT NULL UNIQUE,
        issuer TEXT NOT NULL,
        key_id TEXT NOT NULL,
        allowlist_version INTEGER NOT NULL CHECK(allowlist_version>=1),
        gate_id TEXT NOT NULL,
        gate_epoch_hash TEXT NOT NULL,
        gate_generation INTEGER NOT NULL CHECK(gate_generation>=0),
        purpose TEXT NOT NULL,
        release_id TEXT NOT NULL,
        source_commit TEXT NOT NULL,
        locks_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER NOT NULL,
        consumption_receipt_json TEXT NOT NULL,
        UNIQUE(gate_id, gate_generation)
      );
      CREATE INDEX IF NOT EXISTS m6_live_window_auth_gate_idx
        ON m6_live_window_authorization_consumptions(gate_id, gate_generation);
      CREATE TABLE IF NOT EXISTS m6_live_scenario_claims (
        claim_hash TEXT PRIMARY KEY,
        authorization_id TEXT NOT NULL,
        authorization_hash TEXT NOT NULL,
        manifest_hash TEXT NOT NULL,
        scenario_key TEXT NOT NULL,
        purpose TEXT NOT NULL,
        gate_epoch_hash TEXT NOT NULL,
        gate_generation INTEGER NOT NULL CHECK(gate_generation>=0),
        status TEXT NOT NULL CHECK(status IN ('STARTED','FINALIZED')),
        claimed_at INTEGER NOT NULL,
        finalized_at INTEGER,
        result_json TEXT,
        UNIQUE(authorization_id, scenario_key),
        UNIQUE(gate_epoch_hash, scenario_key)
      );
      CREATE INDEX IF NOT EXISTS m6_live_scenario_claims_auth_idx
        ON m6_live_scenario_claims(authorization_id, claimed_at);
      CREATE TABLE IF NOT EXISTS m6_gate_safety_close_arms (
        active_epoch_hash TEXT PRIMARY KEY,
        gate_id TEXT NOT NULL,
        purpose TEXT NOT NULL,
        close_epoch_hash TEXT NOT NULL UNIQUE,
        package_hash TEXT NOT NULL UNIQUE,
        activation_proof_hash TEXT NOT NULL,
        proof_hash TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        authorization_expires_at INTEGER NOT NULL,
        package_expires_at INTEGER NOT NULL,
        package_json TEXT NOT NULL,
        armed_generation INTEGER NOT NULL CHECK(armed_generation>=1),
        status TEXT NOT NULL CHECK(status IN ('ARMED','CONSUMED','RELEASED')),
        armed_at INTEGER NOT NULL,
        terminal_epoch_hash TEXT,
        terminal_proof_hash TEXT,
        terminalized_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS m6_gate_safety_close_arm_status_idx
        ON m6_gate_safety_close_arms(status, active_epoch_hash);
      CREATE UNIQUE INDEX IF NOT EXISTS m6_gate_safety_close_arm_terminal_idx
        ON m6_gate_safety_close_arms(terminal_epoch_hash)
        WHERE terminal_epoch_hash IS NOT NULL;
    `);
    this.#ensureColumn("m6_gate_safety_close_arms", "activation_proof_hash", "TEXT NOT NULL DEFAULT ''");
    this.#ensureColumn("m6_gate_safety_close_arms", "terminal_proof_hash", "TEXT");
  }

  #migrateV19ToV20() {
    // A normal close is signed independently from the activation-time emergency
    // close package. Persist its exact proof hash with the terminal fence so a
    // restarted process can validate a RELEASED CLOSED tail after issuer-key
    // revocation without treating the emergency proof as interchangeable.
    this.#ensureV19LiveWindowAuthorizationSchema();
    this.#ensureColumn("m6_gate_safety_close_arms", "terminal_proof_hash", "TEXT");
  }

  #recoverInFlightActions() {
    const now = this.now();
    this.db.prepare(`
      UPDATE device_session_actions
      SET status='AMBIGUOUS', error_code=COALESCE(error_code, 'CONTROL_PLANE_RESTART'), updated_at=?
      WHERE status IN ('REQUESTED', 'ASSESSED', 'EXECUTING') AND execution_mode <> 'm6-grounded-live-v2'
    `).run(now);
  }

  #migrateV15ToV16() {
    this.#ensureColumn("sessions", "session_kind", "TEXT NOT NULL DEFAULT 'capability'");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS device_session_observations (
        observation_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        observation_json TEXT NOT NULL,
        mutating_calls INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS device_session_observations_session_idx
        ON device_session_observations(session_id, captured_at);
      CREATE TABLE IF NOT EXISTS device_session_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS device_session_events_session_idx
        ON device_session_events(session_id, event_id);
    `);
  }

  #migrate() {
    const current = this.#readUserVersion();
    if (current > CURRENT_CONTROL_SCHEMA_VERSION) {
      throw new ControlPlaneError(
        "SCHEMA_VERSION_TOO_NEW",
        `control.db user_version ${current} is newer than this binary (${CURRENT_CONTROL_SCHEMA_VERSION})`,
        { status: 500, details: { userVersion: current, supported: CURRENT_CONTROL_SCHEMA_VERSION } },
      );
    }
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
        session_kind TEXT NOT NULL DEFAULT 'capability',
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
      CREATE TABLE IF NOT EXISTS standing_grant_canaries (
        marker TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        grant_id TEXT NOT NULL,
        source_job_id TEXT NOT NULL,
        mission_id TEXT,
        device_run_id TEXT,
        collect_job_id TEXT,
        status TEXT NOT NULL,
        outcome TEXT,
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
      CREATE TABLE IF NOT EXISTS discovery_producer_receipts (
        receipt_id TEXT PRIMARY KEY,
        reservation_id TEXT NOT NULL UNIQUE REFERENCES discovery_reservations(reservation_id),
        discovery_run_id TEXT NOT NULL REFERENCES discovery_runs(discovery_run_id),
        session_id TEXT NOT NULL,
        controller_epoch INTEGER NOT NULL,
        source_job_id TEXT NOT NULL REFERENCES jobs(job_id),
        source_run_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id),
        evidence_hash TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS discovery_observation_lineage (
        snapshot_hash TEXT PRIMARY KEY,
        discovery_run_id TEXT NOT NULL REFERENCES discovery_runs(discovery_run_id),
        session_id TEXT NOT NULL,
        controller_agent TEXT NOT NULL,
        controller_epoch INTEGER NOT NULL,
        source_job_id TEXT NOT NULL,
        source_run_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id),
        evidence_hash TEXT NOT NULL,
        recorder TEXT NOT NULL,
        record_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS explicit_observation_receipts (
        receipt_id TEXT PRIMARY KEY,
        receipt_hash TEXT NOT NULL UNIQUE,
        grant_id TEXT NOT NULL REFERENCES delegation_grants(grant_id),
        grant_hash TEXT NOT NULL,
        mission_id TEXT NOT NULL REFERENCES missions(mission_id),
        device_run_id TEXT NOT NULL REFERENCES device_runs(device_run_id),
        lease_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        controller_epoch INTEGER NOT NULL,
        app TEXT NOT NULL,
        account_fingerprint TEXT NOT NULL,
        page_fingerprint TEXT NOT NULL,
        target_fingerprint TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        server_received_at INTEGER NOT NULL,
        evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id),
        evidence_hash TEXT NOT NULL,
        source_job_id TEXT,
        source_run_id TEXT,
        source_adapter_id TEXT,
        source_capability_id TEXT,
        status TEXT NOT NULL,
        used_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS explicit_observation_receipts_live_idx ON explicit_observation_receipts(mission_id, device_run_id, status);
    `);
    this.#ensureColumn(
      "devices",
      "routing_json",
      `TEXT NOT NULL DEFAULT '{"enabled":false,"tags":[],"capabilityIds":[]}'`,
    );
    this.#ensureColumn("jobs", "placement_request_json", "TEXT NOT NULL DEFAULT '{}'");
    this.#ensureColumn("jobs", "placement_decision_json", "TEXT");
    this.#ensureColumn("sessions", "scope_capability_id", "TEXT");
    this.#ensureColumn("discovery_observation_lineage", "source_hash", "TEXT");
    this.#ensureColumn("discovery_observation_lineage", "content_hash", "TEXT");
    this.#ensureColumn("discovery_observation_lineage", "anchor_json", "TEXT");
    this.#ensureColumn("discovery_observation_lineage", "relation_kind", "TEXT");
    this.#ensureColumn("discovery_observation_lineage", "relation_evidence_id", "TEXT");
    this.#ensureColumn("discovery_observation_lineage", "relation_evidence_hash", "TEXT");
    this.#ensureColumn("discovery_reservations", "source_job_id", "TEXT");
    this.#ensureColumn("discovery_reservations", "source_run_id", "TEXT");
    this.#ensureColumn("discovery_reservations", "receipt_id", "TEXT");
    this.#ensureColumn("sessions", "placement_decision_json", "TEXT");
    this.#ensureColumn("leases", "owner_device_run_id", "TEXT");
    this.#ensureColumn("leases", "owner_discovery_run_id", "TEXT");
    this.#ensureColumn("missions", "parent_grant_id", "TEXT");
    this.#ensureColumn("missions", "parent_grant_hash", "TEXT");
    this.#ensureColumn("explicit_observation_receipts", "source_job_id", "TEXT");
    this.#ensureColumn("explicit_observation_receipts", "source_run_id", "TEXT");
    this.#ensureColumn("explicit_observation_receipts", "source_adapter_id", "TEXT");
    this.#ensureColumn("explicit_observation_receipts", "source_capability_id", "TEXT");
    // REX Phase 2 收尾: payment pending must be durable and retain its audit row across the
    // terminal decision instead of being deleted. The binding is the redacted human-confirmation
    // payload; expires_at is the INTEGER ms deadline used by restart recovery.
    this.#ensureColumn("protected_commits", "approval_binding_json", "TEXT");
    this.#ensureColumn("protected_commits", "expires_at", "INTEGER");
    this.db.exec("CREATE INDEX IF NOT EXISTS protected_commits_action_idx ON protected_commits(action, status)");
    this.db.exec("CREATE INDEX IF NOT EXISTS missions_parent_grant_idx ON missions(parent_grant_id, status)");
    // REX Phase 5 §8.1 item 3：legacy pending migration。superseded_by 记录旧 waiting_approval
    // job 被 fresh queued job 取代的链路（旧行→queued_migrated，superseded_by→新 job_id）。
    this.#ensureColumn("jobs", "superseded_by", "TEXT");
    // Foundation PR1: operations owns operation_key uniqueness (jobs.idempotency_key is legacy projection).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operations (
        operation_key TEXT PRIMARY KEY,
        fingerprint_version INTEGER NOT NULL DEFAULT 1,
        request_fingerprint_hash TEXT NOT NULL,
        outcome_kind TEXT NOT NULL,
        authorization_decision_id TEXT,
        job_id TEXT,
        created_at TEXT NOT NULL
      );
    `);
    // Direct-routine plan V2 §7: server-hard routine effect ledger. mode=hard —
    // the budget here is enforced in the same SQLite transaction as the slot
    // reservation and has NO soft path: nonpayment-autonomy policyMode can never
    // soften it into a budget debt. Dynamic targets are bound to the CP-owned
    // observation hash; the caller may not self-report a fingerprint.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS routine_effects (
        effect_id TEXT PRIMARY KEY,
        routine_run_id TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        action TEXT NOT NULL,
        target_hash TEXT NOT NULL,
        observation_hash TEXT,
        payload_hash TEXT,
        intent_json TEXT NOT NULL,
        status TEXT NOT NULL,
        reservation_consumed INTEGER NOT NULL DEFAULT 0,
        retry_blocked INTEGER NOT NULL DEFAULT 0,
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        account_fingerprint TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS routine_effects_budget_idx
        ON routine_effects(routine_run_id, action, target_hash, created_at);
      CREATE TABLE IF NOT EXISTS routine_run_closures (
        routine_run_id TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (routine_run_id, action)
      );
      CREATE TABLE IF NOT EXISTS note_context_receipts (
        receipt_id TEXT PRIMARY KEY,
        receipt_hash TEXT NOT NULL,
        routine_run_id TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        target_fingerprint TEXT NOT NULL,
        detail_state_version TEXT NOT NULL,
        account_fingerprint TEXT,
        page_fingerprint TEXT,
        title_excerpt TEXT,
        body_excerpt TEXT,
        comment_digest_json TEXT NOT NULL DEFAULT '[]',
        evidence_hashes_json TEXT NOT NULL DEFAULT '[]',
        observed_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (receipt_hash, routine_run_id, target_fingerprint)
      );
      CREATE TABLE IF NOT EXISTS comment_drafts (
        draft_id TEXT PRIMARY KEY,
        draft_hash TEXT NOT NULL UNIQUE,
        receipt_hash TEXT NOT NULL,
        routine_run_id TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        target_fingerprint TEXT NOT NULL,
        detail_state_version TEXT NOT NULL,
        text TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        source_observation_hash TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        model_id TEXT,
        prompt_hash TEXT,
        risk_flags_json TEXT NOT NULL DEFAULT '[]',
        validation_json TEXT,
        status TEXT NOT NULL DEFAULT 'sealed',
        account_fingerprint TEXT,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS comment_reconciles (
        reconcile_id TEXT PRIMARY KEY,
        effect_id TEXT NOT NULL,
        routine_run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        evidence_hash TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS routine_authorities (
        authority_id TEXT PRIMARY KEY,
        execution_run_id TEXT NOT NULL,
        routine_run_id TEXT NOT NULL UNIQUE,
        plan_hash TEXT NOT NULL,
        alias TEXT NOT NULL,
        device_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        effect_caps_json TEXT NOT NULL,
        canary_authorized INTEGER NOT NULL DEFAULT 0,
        canary_policy_json TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        account_fingerprint TEXT,
        created_at INTEGER NOT NULL,
        closed_at INTEGER,
        closed_reason TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS routine_authorities_session_active
        ON routine_authorities(session_id) WHERE status='active';
    `);
    this.#ensureColumn("jobs", "operation_key", "TEXT");
    this.#ensureColumn("jobs", "authorization_snapshot_json", "TEXT");
    // V2.1 P1-COMMENT-RECONCILE-LIFECYCLE: full account binding on the effect
    // ledger — the authoritative accountFingerprint comes from the registered
    // routine_authorities tuple (which already carries the column). Nullable,
    // no index, no backfill: pre-existing rows read back as null (append-only,
    // history is never rewritten).
    this.#ensureColumn("routine_effects", "account_fingerprint", "TEXT");
    this.#ensureColumn("comment_drafts", "account_fingerprint", "TEXT");
    // Foundation PR3: one-time transport action authorizations (INV-02).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transport_action_authorizations (
        authorization_id TEXT PRIMARY KEY,
        schema_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        purpose TEXT NOT NULL,
        job_id TEXT,
        run_id TEXT,
        mission_id TEXT,
        device_run_id TEXT,
        lease_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        operation_key TEXT NOT NULL,
        capability_contract_hash TEXT NOT NULL,
        implementation_closure_hash TEXT,
        nonce_hash TEXT NOT NULL UNIQUE,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        source TEXT
      );
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS transport_auth_job_idx ON transport_action_authorizations(job_id, purpose, consumed_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS transport_auth_lease_idx ON transport_action_authorizations(lease_id, consumed_at)");
    if (current < CURRENT_CONTROL_SCHEMA_VERSION) {
      this.transaction(() => {
        if (current < 16) this.#migrateV15ToV16();
        if (current < 17) this.#migrateV16ToV17();
        if (current < 18) this.#migrateV17ToV18();
        if (current < 19) this.#migrateV18ToV19();
        if (current < 20) this.#migrateV19ToV20();
        this.#setUserVersion(CURRENT_CONTROL_SCHEMA_VERSION);
      });
    }
    this.#ensureV19LiveWindowAuthorizationSchema();
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
      this.#recoverInFlightActions();
      this.#recoverM6ActionLedger(now);
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
      this.#recoverInFlightActions();
      this.#recoverM6ActionLedger(now);
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

  #assertOrdinaryM6ResourceAllowedNoTransaction() {
    const fence = this.getM6GateFence();
    if (fence?.mode !== undefined && fence.mode !== "CLOSED") {
      throw new ControlPlaneError(
        "M6_GATE_ACTIVE_ISOLATION",
        "ordinary jobs, leases, sessions, and runs are disabled while an M6 live gate is active",
        { status: 423, details: { mode: fence.mode, generation: fence.generation } },
      );
    }
    return fence;
  }

  #assertM6CompositeAuthorityNoTransaction({
    actorId,
    authority,
    capability,
    canary,
    deviceId,
    sessionId = null,
    idempotencyKey = null,
    operationKey = null,
    params = null,
    status = null,
    approvalRequired = null,
    externalEffect = null,
    ttlMs = null,
  }) {
    const authorityKeys = ["authorizationConsumptionHash", "authorizationId", "binding", "fence", "scenarioClaimHash"];
    if (!authority || typeof authority !== "object" || Array.isArray(authority)
      || canonicalJson(Object.keys(authority).sort()) !== canonicalJson(authorityKeys)
      || actorId !== M6_PRODUCTION_BROKER_ACTOR_ID || capability?.id !== M6_GROUNDED_RUN_CAPABILITY_ID
      || canary !== true || typeof deviceId !== "string" || deviceId === "") {
      throw new ControlPlaneError(
        "M6_COMPOSITE_AUTHORITY_INVALID",
        "composite_action requires the exact production broker authority envelope",
        { status: 403 },
      );
    }
    const binding = authority.binding;
    const expectedBindingKeys = [
      "alias", "bindingHash", "gateEpochHash", "generation", "liveWindowAuthorizationHash",
      "processRef", "purpose", "runId", "scenarioManifestHash", "sessionId", "workerId",
    ];
    const claim = this.getM64LiveScenarioClaim(authority.scenarioClaimHash);
    const consumption = claim ? this.getM64LiveWindowAuthorizationConsumption(claim.authorizationId) : null;
    const fence = this.getM6GateFence();
    const expectedMode = claim?.purpose === "M6_4_SHADOW" ? "OBSERVE_ONLY" : "GROUNDED_ACTION";
    const deriveRef = (kind) => `${kind}:${sha256(`xw.m6-live-entry.v1:${kind}:${claim?.authorizationHash}:${claim?.scenarioKey}`)}`;
    const bindingCore = binding && typeof binding === "object" && !Array.isArray(binding)
      ? Object.fromEntries(expectedBindingKeys.filter((key) => key !== "bindingHash").map((key) => [key, binding[key]]))
      : null;
    const exactFence = fence && authority.fence && [
      "gateId", "epochHash", "generation", "mode", "purpose", "expiresAt",
      "releaseId", "sourceCommit", "locksHash",
    ].every((key) => fence[key] === authority.fence[key])
      && canonicalJson(fence.allowlist) === canonicalJson(authority.fence.allowlist);
    const exactBinding = binding && typeof binding === "object" && !Array.isArray(binding)
      && canonicalJson(Object.keys(binding).sort()) === canonicalJson(expectedBindingKeys)
      && binding.alias === "01"
      && binding.gateEpochHash === fence?.epochHash
      && binding.generation === fence?.generation
      && binding.purpose === fence?.purpose
      && binding.runId === deriveRef("run")
      && binding.workerId === deriveRef("worker")
      && binding.sessionId === deriveRef("session")
      && binding.processRef === deriveRef("process")
      && binding.bindingHash === sha256(canonicalJson(bindingCore));
    const exactClaim = claim?.status === "STARTED"
      && claim.authorizationId === authority.authorizationId
      && claim.authorizationHash === binding?.liveWindowAuthorizationHash
      && claim.manifestHash === binding?.scenarioManifestHash
      && claim.purpose === binding?.purpose
      && claim.gateEpochHash === binding?.gateEpochHash
      && claim.gateGeneration === binding?.generation;
    const exactConsumption = consumption?.authorizationId === claim?.authorizationId
      && consumption.envelopeHash === claim?.authorizationHash
      && consumption.consumptionHash === authority.authorizationConsumptionHash
      && consumption.gateId === fence?.gateId
      && consumption.gateEpochHash === fence?.epochHash
      && consumption.gateGeneration === fence?.generation
      && consumption.purpose === fence?.purpose
      && consumption.releaseId === fence?.releaseId
      && consumption.sourceCommit === fence?.sourceCommit
      && consumption.locksHash === fence?.locksHash
      && Date.parse(consumption.expiresAt) > this.now();
    const device = this.requireDevice(deviceId);
    if (!exactFence || fence.mode !== expectedMode || canonicalJson(fence.allowlist) !== canonicalJson(["01"])
      || Date.parse(fence.expiresAt) <= this.now() || !exactBinding || !exactClaim || !exactConsumption
      || device.alias !== "01") {
      throw new ControlPlaneError(
        "M6_COMPOSITE_AUTHORITY_INVALID",
        "composite_action authority is not bound to the current Gate, authorization, scenario claim, and alias 01",
        { status: 403 },
      );
    }
    if (sessionId === null && (!Number.isSafeInteger(ttlMs) || ttlMs < 1
      || this.now() + ttlMs > Math.min(Date.parse(fence.expiresAt), Date.parse(consumption.expiresAt)))) {
      throw new ControlPlaneError(
        "M6_COMPOSITE_AUTHORITY_INVALID",
        "composite_action session lifetime must remain inside the current Gate and authorization window",
        { status: 403 },
      );
    }
    if (sessionId !== null) {
      const session = this.db.prepare("SELECT * FROM sessions WHERE session_id=?").get(sessionId);
      const exactParams = params && canonicalJson(Object.keys(params).sort())
        === canonicalJson(["grantRef", "runPacketRef", "scenarioManifestRef"])
        && params.runPacketRef === binding.bindingHash
        && params.grantRef === authority.authorizationConsumptionHash
        && params.scenarioManifestRef === claim.manifestHash;
      if (!session || session.actor_id !== M6_PRODUCTION_BROKER_ACTOR_ID || session.device_id !== deviceId
        || session.canary !== 1 || session.scope_capability_id !== M6_GROUNDED_RUN_CAPABILITY_ID
        || session.expires_at <= this.now() || idempotencyKey !== `m6-live:${binding.runId}`
        || operationKey !== idempotencyKey || status !== "running" || approvalRequired !== false
        || externalEffect !== true || !exactParams) {
        throw new ControlPlaneError(
          "M6_COMPOSITE_AUTHORITY_INVALID",
          "composite_action job is not the exact broker-owned session/job binding",
          { status: 403 },
        );
      }
    }
    return { binding, claim, consumption, fence, device };
  }

  createM6QualificationJob(input) {
    if (this.m6RuntimeMode !== "QUALIFICATION_ONLY") {
      throw new ControlPlaneError(
        "M6_QUALIFICATION_ONLY_REQUIRED",
        "formal target qualification jobs may only be created by the qualification-only runtime",
        { status: 403 },
      );
    }
    return this.createJob({ ...input, [M6_QUALIFICATION_JOB_AUTHORITY]: true });
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
    authorization = null,
    operationKey = null,
    invocation = null,
    m6CompositeAuthority = null,
    [M6_QUALIFICATION_JOB_AUTHORITY]: qualificationJobAuthority = false,
  }) {
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") {
      throw new ControlPlaneError("IDEMPOTENCY_REQUIRED", "idempotencyKey is required");
    }
    if (typeof actorId !== "string" || actorId.trim() === "") {
      throw new ControlPlaneError("ACTOR_REQUIRED", "actorId is required");
    }
    const invocationMode = invocation ?? (sessionId ? "session_action" : "job");
    if (!["job", "session_action", "composite_action"].includes(invocationMode)) {
      throw new ControlPlaneError("CAPABILITY_INVOCATION_FORBIDDEN", "unknown internal job invocation mode", { status: 403 });
    }
    if (invocationMode === "composite_action" && (!sessionId || canary !== true
      || capability?.id !== M6_GROUNDED_RUN_CAPABILITY_ID)) {
      throw new ControlPlaneError(
        "CAPABILITY_INVOCATION_FORBIDDEN",
        "composite_action jobs require the exact M6 grounded-run canary session",
        { status: 403 },
      );
    }
    if ((capability?.id === M6_QUALIFICATION_CAPABILITY_ID) !== (qualificationJobAuthority === true)) {
      throw new ControlPlaneError(
        "M6_QUALIFICATION_ONLY_REQUIRED",
        "formal target qualification is unavailable through the ordinary job creator",
        { status: 403 },
      );
    }
    const opKey = (typeof operationKey === "string" && operationKey.trim()) ? operationKey.trim() : idempotencyKey;
    const placementRequest = normalizePlacementRequest({ deviceId, placement });
    const requestFingerprint = fingerprint({
      actorId,
      placementRequest,
      capabilityId: capability.id,
      params,
      canary,
      sessionId,
      ...(invocationMode === "composite_action" ? { invocationMode } : {}),
    });
    const legacyFingerprint = placementRequest.mode === "pinned"
      ? fingerprint({ deviceId: placementRequest.deviceId, capabilityId: capability.id, params, canary, sessionId })
      : null;
    const now = this.now();
    const nowIso = new Date(now).toISOString();
    const jobId = newId("job");
    const runId = newId("run");
    const result = this.transaction(() => {
      const m6Fence = this.getM6GateFence();
      const isM6Composite = invocationMode === "composite_action"
        && canary === true
        && capability?.id === M6_GROUNDED_RUN_CAPABILITY_ID;
      if (isM6Composite) {
        this.#assertM6CompositeAuthorityNoTransaction({
          actorId,
          authority: m6CompositeAuthority,
          capability,
          canary,
          deviceId,
          sessionId,
          idempotencyKey,
          operationKey: opKey,
          params,
          status,
          approvalRequired,
          externalEffect,
        });
      } else {
        this.#assertOrdinaryM6ResourceAllowedNoTransaction();
      }
      if (capability?.id === M6_QUALIFICATION_CAPABILITY_ID) {
        const resources = this.getM6GateFResourceCounts();
        const qualificationDevice = typeof deviceId === "string" ? this.requireDevice(deviceId) : null;
        const qualificationRequestHash = qualificationDevice ? sha256(`xw.m6-target-environment-job.v1:${canonicalJson({
          accountIsolationBindingHash: params?.accountIsolationBindingHash,
          deviceId: qualificationDevice.deviceId,
          gateEpochHash: params?.gateEpochHash,
          gateGeneration: params?.gateGeneration,
          gateLocksHash: params?.gateLocksHash,
        })}`) : null;
        const qualificationBound = invocationMode === "job" && canary === true && sessionId === null
          && this.m6RuntimeMode === "QUALIFICATION_ONLY"
          && actorId === M6_QUALIFICATION_ACTOR_ID
          && qualificationDevice?.alias === "01"
          && canonicalJson(Object.keys(params || {}).sort()) === canonicalJson([
            "accountIsolationBindingHash", "gateEpochHash", "gateGeneration", "gateLocksHash",
          ])
          && idempotencyKey === `m6-env-${qualificationRequestHash}`
          && opKey === idempotencyKey
          && m6Fence?.mode === "CLOSED"
          && params?.gateEpochHash === m6Fence.epochHash
          && params?.gateGeneration === m6Fence.generation
          && params?.gateLocksHash === m6Fence.locksHash
          && Object.values(resources).every((count) => count === 0);
        if (!qualificationBound) {
          throw new ControlPlaneError(
            "M6_QUALIFICATION_GATE_REBOUND",
            "target qualification job must atomically bind the current CLOSED zero-resource Gate-F generation",
            {
              status: 409,
              details: {
                mode: m6Fence?.mode ?? null,
                generation: m6Fence?.generation ?? null,
                resources,
              },
            },
          );
        }
      }
      // Foundation: operations table is the unique owner of operation_key.
      const priorOp = this.db.prepare("SELECT * FROM operations WHERE operation_key=?").get(opKey);
      if (priorOp) {
        if (priorOp.request_fingerprint_hash !== requestFingerprint
          && priorOp.request_fingerprint_hash !== legacyFingerprint) {
          throw new ControlPlaneError("IDEMPOTENCY_CONFLICT", "operation key was used for a different request", {
            status: 409,
            details: { operationKey: opKey, jobId: priorOp.job_id },
          });
        }
        if (priorOp.job_id) return { reused: true, jobId: priorOp.job_id };
      }
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
        invocation: invocationMode,
        canary,
        advisory: false,
      });
      if (!priorOp) {
        this.db.prepare(`
          INSERT INTO operations (
            operation_key, fingerprint_version, request_fingerprint_hash, outcome_kind,
            authorization_decision_id, job_id, created_at
          ) VALUES (?, 1, ?, 'allowed_job', ?, ?, ?)
        `).run(
          opKey,
          requestFingerprint,
          authorization?.decisionId || null,
          jobId,
          nowIso,
        );
      } else {
        this.db.prepare("UPDATE operations SET job_id=?, outcome_kind='allowed_job', authorization_decision_id=? WHERE operation_key=?")
          .run(jobId, authorization?.decisionId || null, opKey);
      }
      this.db.prepare(`
        INSERT INTO jobs (
          job_id, run_id, idempotency_key, request_fingerprint, actor_id, device_id,
          capability_id, capability_json, params_json, canary, session_id, status,
          approval_required, external_effect, created_at, updated_at,
          placement_request_json, placement_decision_json,
          operation_key, authorization_snapshot_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        opKey,
        authorization ? canonicalJson(authorization) : null,
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
      if (nextStatus === "queued") this.#assertOrdinaryM6ResourceAllowedNoTransaction();
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

  // ─── REX Phase 5 §8.1 item 3：legacy pending migration ───
  //
  // nonpayment_v1 启动期迁移历史 waiting_approval job。保守、支付安全：
  //   - payment-like（isPaymentLike 返回 true）→ 保持 waiting_approval，不迁移（保留人工闸）。
  //   - 有 dispatch 痕迹（started_at 已设）→ queued_migrated + error_code=MIGRATED_RECONCILE，
  //     不 spawn 新 job（只 reconcile，不重发，避免重复 effect）。
  //   - 非支付无 trace → 旧行 queued_migrated + superseded_by→新 fresh queued job（approval-free，
  //     idempotency_key=<old>:migrated），由 pump 重新派发。
  // isPaymentLike 由 ControlPlane 注入（financial-commit-classifier on capability），state-store
  // 保持通用、不内嵌支付分类逻辑。返回 {total, migrated, reconciled, paymentLike} 报告。
  migrateNonpaymentWaitingApprovals({ isPaymentLike = () => false, onMigrated = null } = {}) {
    const rows = this.db.prepare("SELECT * FROM jobs WHERE status='waiting_approval'").all();
    const report = { total: rows.length, migrated: 0, reconciled: 0, paymentLike: 0 };
    const onMigratedCb = typeof onMigrated === "function" ? onMigrated : null;
    for (const row of rows) {
      const job = publicJob(row);
      if (isPaymentLike(job)) {
        report.paymentLike += 1;
        continue;
      }
      const now = this.now();
      if (row.started_at !== null) {
        // 有 dispatch 痕迹：只 reconcile，不重发。
        this.transaction(() => {
          this.#assertOrdinaryM6ResourceAllowedNoTransaction();
          this.db.prepare(
            "UPDATE jobs SET status='queued_migrated', error_code='MIGRATED_RECONCILE', updated_at=? WHERE job_id=?",
          ).run(now, row.job_id);
          this.#insertEvent({
            jobId: row.job_id,
            runId: row.run_id,
            type: "job.queued_migrated",
            payload: { reason: "reconcile_only", hadDispatchTrace: true },
            createdAt: now,
          });
        });
        report.reconciled += 1;
        continue;
      }
      // 非支付无 trace：spawn fresh queued job + 旧行 superseded_by。
      const freshJobId = newId("job");
      const freshRunId = newId("run");
      const freshIdempotencyKey = `${row.idempotency_key}:migrated`;
      this.transaction(() => {
        this.#assertOrdinaryM6ResourceAllowedNoTransaction();
        this.db.prepare(`
          INSERT INTO jobs (
            job_id, run_id, idempotency_key, request_fingerprint, actor_id, device_id,
            capability_id, capability_json, params_json, canary, session_id, status,
            approval_required, external_effect, created_at, updated_at, placement_request_json, placement_decision_json
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'queued',0,?,?,?,?,?)
        `).run(
          freshJobId,
          freshRunId,
          freshIdempotencyKey,
          row.request_fingerprint,
          row.actor_id,
          row.device_id,
          row.capability_id,
          row.capability_json,
          row.params_json,
          row.canary,
          row.session_id,
          Boolean(row.external_effect) ? 1 : 0,
          now,
          now,
          row.placement_request_json || "{}",
          row.placement_decision_json || "{}",
        );
        this.db.prepare(
          "UPDATE jobs SET status='queued_migrated', superseded_by=?, updated_at=? WHERE job_id=?",
        ).run(freshJobId, now, row.job_id);
        this.#insertEvent({
          jobId: row.job_id,
          runId: row.run_id,
          type: "job.queued_migrated",
          payload: { reason: "migrated_to_queued", supersededBy: freshJobId },
          createdAt: now,
        });
      });
      report.migrated += 1;
      if (onMigratedCb) {
        // 通知 ControlPlane 为 fresh job 初始化 evidence run 目录——pump 派发 queued
        // job 时不调 initializeRun（依赖 submitJob 期已建），migration 绕过 submitJob
        // 故在此补建，否则 runJob 末尾 writeJson 落 evidence/result-*.json 会 ENOENT。
        try { onMigratedCb(this.getJob(freshJobId)); } catch {}
      }
    }
    return report;
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
      this.transaction(() => {
        this.#assertOrdinaryM6ResourceAllowedNoTransaction();
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
      });
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
    sessionKind = "capability",
    recordCreatedEvent = false,
    faultAfter = null,
    invocation = "session",
    m6CompositeAuthority = null,
  }) {
    if (typeof actorId !== "string" || actorId.trim() === "") {
      throw new ControlPlaneError("ACTOR_REQUIRED", "actorId is required");
    }
    const kind = sessionKind || "capability";
    if (!["capability", "open_action"].includes(kind)) {
      throw new ControlPlaneError(
        "SESSION_KIND_MISMATCH",
        `unknown sessionKind: ${kind}`,
        { status: 409, details: { sessionKind: kind } },
      );
    }
    if (kind === "open_action" && capability) {
      throw new ControlPlaneError(
        "SESSION_KIND_MISMATCH",
        "open_action session must not require capabilityId",
        { status: 409 },
      );
    }
    if (kind === "capability" && !capability && !deviceId) {
      throw new ControlPlaneError(
        "PLACEMENT_CONFLICT",
        "automatic sessions require capabilityId",
        { status: 409 },
      );
    }
    if (kind === "open_action" && !deviceId) {
      throw new ControlPlaneError(
        "PLACEMENT_CONFLICT",
        "open_action sessions require deviceId",
        { status: 409 },
      );
    }
    if (!["session", "composite_action"].includes(invocation)
      || (invocation === "composite_action" && (kind !== "capability" || canary !== true
        || capability?.id !== M6_GROUNDED_RUN_CAPABILITY_ID))) {
      throw new ControlPlaneError(
        "CAPABILITY_INVOCATION_FORBIDDEN",
        "composite_action sessions require the exact M6 grounded-run canary capability",
        { status: 403 },
      );
    }
    const placementRequest = normalizePlacementRequest({ deviceId, placement });
    const sessionId = newId("session");
    const leaseId = newId("lease");
    const token = newId("lease_token");
    const now = this.now();
    this.cleanupExpiredLeases();
    const result = this.transaction(() => {
      const isM6Composite = invocation === "composite_action"
        && kind === "capability"
        && canary === true
        && capability?.id === M6_GROUNDED_RUN_CAPABILITY_ID;
      if (isM6Composite) {
        this.#assertM6CompositeAuthorityNoTransaction({
          actorId,
          authority: m6CompositeAuthority,
          capability,
          canary,
          deviceId,
          ttlMs,
        });
      } else this.#assertOrdinaryM6ResourceAllowedNoTransaction();
      let routeDecision;
      if (capability) {
        routeDecision = this.#selectPlacementDecision({
          authorityNodeId,
          capability,
          placementRequest,
          invocation: invocation === "composite_action" ? "composite_action_session" : invocation,
          canary,
          advisory: false,
        });
        if (isM6Composite && routeDecision.selectedDeviceId !== deviceId) {
          throw new ControlPlaneError(
            "M6_COMPOSITE_AUTHORITY_INVALID",
            "composite_action placement changed from its alias-01 authority binding",
            { status: 403 },
          );
        }
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
          scope_capability_id, placement_decision_json, created_at, expires_at, session_kind
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        kind,
      );
      if (faultAfter === "afterSession") {
        throw new ControlPlaneError("DEVICE_SESSION_OPEN_FAULT", "injected device-session open fault", { status: 500 });
      }
      if (recordCreatedEvent || kind === "open_action") {
        if (faultAfter === "createdEvent") {
          throw new ControlPlaneError("DEVICE_SESSION_OPEN_FAULT", "injected device-session created event fault", { status: 500 });
        }
        this.#insertDeviceSessionEvent({
          sessionId,
          type: "device_session.created",
          payload: {
            schemaId: "xw.open-action.device-session.v1",
            schemaVersion: 1,
            sessionId,
            sessionKind: kind,
            deviceId: routeDecision.selectedDeviceId,
            leaseId,
            actor: actorId,
            createdAt: iso(now),
            capabilityId: capability?.id || null,
          },
          createdAt: now,
        });
      }
      return routeDecision;
    });
    return {
      sessionId,
      leaseId,
      token,
      actorId,
      deviceId: result.selectedDeviceId,
      canary,
      sessionKind: kind,
      scopeCapabilityId: capability?.id || null,
      routeDecision: result,
      createdAt: iso(now),
      expiresAt: iso(now + ttlMs),
    };
  }

  validateSession(sessionId, token) {
    if (!sessionId) {
      // fail typed before the SQL bind: an undefined session id would otherwise
      // surface as the CONTROL_INTERNAL_ERROR catch-all instead of 404
      throw new ControlPlaneError("SESSION_NOT_FOUND", "active session not found", { status: 404 });
    }
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
      sessionKind: row.session_kind || "capability",
      scopeCapabilityId: row.scope_capability_id,
      routeDecision: parseJson(row.placement_decision_json),
      createdAt: iso(row.created_at),
      expiresAt: iso(row.expires_at),
    };
  }

  // M6-2 W8 #7 — read-only convergence probes for the facade closeout. A leaked
  // session/lease is one whose row still exists and has not expired; these are
  // plain SELECTs (no cleanup side-effect, no re-release, no schema change).
  sessionExists(sessionId) {
    if (!sessionId) return false;
    const row = this.db.prepare("SELECT 1 FROM sessions WHERE session_id=? AND expires_at>?").get(sessionId, this.now());
    return Boolean(row);
  }

  leaseExists(leaseId) {
    if (!leaseId) return false;
    const row = this.db.prepare("SELECT 1 FROM leases WHERE lease_id=? AND expires_at>?").get(leaseId, this.now());
    return Boolean(row);
  }

  heartbeatSession(sessionId, token, ttlMs = 60000) {
    const session = this.validateSession(sessionId, token);
    const lease = this.heartbeatLease(session.leaseId, token, ttlMs);
    this.db.prepare("UPDATE sessions SET expires_at=? WHERE session_id=?").run(Date.parse(lease.expiresAt), sessionId);
    return { ...session, expiresAt: lease.expiresAt };
  }

  releaseSession(sessionId, token, { recordReleasedEvent = false, faultAfter = null } = {}) {
    const session = this.validateSession(sessionId, token);
    return this.transaction(() => {
      if (recordReleasedEvent || session.sessionKind === "open_action") {
        this.#insertDeviceSessionEvent({
          sessionId,
          type: "device_session.released",
          payload: { sessionId, leaseId: session.leaseId },
        });
      }
      if (faultAfter === "afterReleasedEvent") {
        throw new ControlPlaneError("DEVICE_SESSION_RELEASE_FAULT", "injected device-session release fault", { status: 500 });
      }
      this.db.prepare("DELETE FROM sessions WHERE session_id=?").run(sessionId);
      this.releaseLease(session.leaseId, token);
      return { released: true, sessionId };
    });
  }

  #insertDeviceSessionEvent({ sessionId, type, payload = {}, createdAt = this.now() }) {
    const result = this.db.prepare(
      "INSERT INTO device_session_events (session_id, created_at, type, payload_json) VALUES (?, ?, ?, ?)",
    ).run(sessionId, createdAt, type, canonicalJson(payload));
    return {
      eventId: Number(result.lastInsertRowid),
      sessionId,
      createdAt: iso(createdAt),
      type,
      payload,
    };
  }

  recordDeviceSessionObservation({ sessionId, observation, mutatingCalls = 0 }) {
    const now = this.now();
    this.db.prepare(`
      INSERT INTO device_session_observations (
        observation_id, session_id, captured_at, observation_json, mutating_calls
      ) VALUES (?, ?, ?, ?, ?)
    `).run(observation.observationId, sessionId, now, canonicalJson(observation), mutatingCalls);
    return observation;
  }

  recordObservationCapture({ sessionId, observation, mutatingCalls = 0, faultAfter = null }) {
    return this.transaction(() => {
      this.recordDeviceSessionObservation({ sessionId, observation, mutatingCalls });
      if (faultAfter === "afterObservation") {
        throw new ControlPlaneError("DEVICE_SESSION_OBSERVE_FAULT", "injected observation persist fault", { status: 500 });
      }
      this.#insertDeviceSessionEvent({
        sessionId,
        type: "observation.captured",
        payload: {
          observationId: observation.observationId,
          evidenceRefs: observation.evidenceRefs,
          mutatingCalls,
        },
      });
      return observation;
    });
  }

  listDeviceSessionObservations(sessionId) {
    return this.db.prepare(
      "SELECT observation_json FROM device_session_observations WHERE session_id=? ORDER BY captured_at",
    ).all(sessionId).map((row) => parseJson(row.observation_json));
  }

  getDeviceSessionObservation(sessionId, observationId) {
    const row = this.db.prepare(
      "SELECT observation_json FROM device_session_observations WHERE session_id=? AND observation_id=?",
    ).get(sessionId, observationId);
    return row ? parseJson(row.observation_json) : null;
  }

  getLatestDeviceSessionObservation(sessionId) {
    const row = this.db.prepare(
      "SELECT observation_json FROM device_session_observations WHERE session_id=? ORDER BY captured_at DESC, observation_id DESC LIMIT 1",
    ).get(sessionId);
    return row ? parseJson(row.observation_json) : null;
  }

  countDeviceSessionMutations(sessionId) {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM device_session_actions
       WHERE session_id=? AND (executed=1 OR status IN ('EXECUTED','VERIFIED','COMPLETED'))`,
    ).get(sessionId);
    return Number(row?.n) || 0;
  }

  #mapActionRow(row) {
    if (!row) return null;
    return {
      sessionId: row.session_id,
      actionId: row.action_id,
      idempotencyKey: row.idempotency_key,
      fingerprintJson: row.fingerprint_json,
      fingerprint: parseJson(row.fingerprint_json),
      result: parseJson(row.result_json),
      executed: Boolean(row.executed),
      status: row.status || (row.executed ? "COMPLETED" : "REQUESTED"),
      executionMode: row.execution_mode || "fixture",
      transportCalled: Boolean(row.transport_called),
      executorId: row.executor_id || null,
      effectAssessment: parseJson(row.effect_assessment_json),
      beforeObservationId: row.before_observation_id || null,
      preflightObservationId: row.preflight_observation_id || null,
      afterObservationId: row.after_observation_id || null,
      errorCode: row.error_code || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getDeviceSessionAction(sessionId, idempotencyKey) {
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") return null;
    const row = this.db.prepare(
      "SELECT * FROM device_session_actions WHERE session_id=? AND idempotency_key=?",
    ).get(sessionId, idempotencyKey);
    return this.#mapActionRow(row);
  }

  findDeviceSessionAction(sessionId, idempotencyKey) {
    const row = this.getDeviceSessionAction(sessionId, idempotencyKey);
    if (!row) return null;
    return { fingerprintJson: row.fingerprintJson, result: row.result, status: row.status };
  }

  listInFlightDeviceSessionActions(sessionId) {
    return this.db.prepare(
      `SELECT * FROM device_session_actions
       WHERE session_id=? AND status IN ('REQUESTED','ASSESSED','EXECUTING')
       ORDER BY created_at`,
    ).all(sessionId).map((row) => this.#mapActionRow(row));
  }

  reserveDeviceSessionAction({
    sessionId,
    action,
    fingerprint,
    executionMode = "fixture",
    executorId = "open-action-fixture",
  }) {
    const key = action.idempotencyKey;
    if (typeof key !== "string" || key.trim() === "") {
      throw new ControlPlaneError("INVALID_ACTION", "mutating action requires idempotencyKey", { status: 400 });
    }
    const print = canonicalJson(fingerprint);
    const now = this.now();
    return this.transaction(() => {
      const inflight = this.listInFlightDeviceSessionActions(sessionId);
      const sameKey = inflight.find((row) => row.idempotencyKey === key);
      if (inflight.length && !sameKey) {
        throw new ControlPlaneError(
          "ACTION_IN_FLIGHT",
          "this session already has an in-flight open action",
          { status: 423, details: { sessionId, actionId: inflight[0].actionId } },
        );
      }
      try {
        this.db.prepare(`
          INSERT INTO device_session_actions (
            session_id, idempotency_key, action_id, fingerprint_json, result_json, executed, created_at,
            status, execution_mode, transport_called, executor_id, effect_assessment_json,
            before_observation_id, preflight_observation_id, after_observation_id, error_code, updated_at
          ) VALUES (?, ?, ?, ?, ?, 0, ?, 'REQUESTED', ?, 0, ?, NULL, NULL, NULL, NULL, NULL, ?)
        `).run(sessionId, key, action.actionId, print, "{}", now, executionMode, executorId, now);
        return { reserved: true, reused: false, row: this.getDeviceSessionAction(sessionId, key) };
      } catch (error) {
        const unique = /UNIQUE|PRIMARY KEY/i.test(String(error?.message || error));
        if (!unique) throw error;
        const existing = this.getDeviceSessionAction(sessionId, key);
        if (!existing) throw error;
        if (existing.fingerprintJson !== print) {
          throw new ControlPlaneError(
            "PRIMITIVE_IDEMPOTENCY_CONFLICT",
            "idempotency key belongs to a different action",
            { status: 409, details: { sessionId, idempotencyKey: key } },
          );
        }
        if (["REQUESTED", "ASSESSED", "EXECUTING"].includes(existing.status)) {
          throw new ControlPlaneError(
            "ACTION_IN_FLIGHT",
            "this idempotency key is already executing",
            { status: 423, details: { sessionId, idempotencyKey: key, status: existing.status } },
          );
        }
        if (existing.status === "AMBIGUOUS") {
          throw new ControlPlaneError(
            "ACTION_AMBIGUOUS",
            "previous execution is ambiguous and must not be retried blindly",
            { status: 409, details: { sessionId, idempotencyKey: key, nextAction: "STOP" } },
          );
        }
        return { reserved: false, reused: true, row: existing };
      }
    });
  }

  updateDeviceSessionAction(sessionId, idempotencyKey, patch = {}) {
    const current = this.getDeviceSessionAction(sessionId, idempotencyKey);
    if (!current) {
      throw new ControlPlaneError("INVALID_ACTION", "action reservation missing", { status: 500 });
    }
    const next = {
      status: patch.status ?? current.status,
      result: patch.result === undefined ? current.result : patch.result,
      executed: patch.executed === undefined ? current.executed : patch.executed,
      transportCalled: patch.transportCalled === undefined ? current.transportCalled : patch.transportCalled,
      effectAssessment: patch.effectAssessment === undefined ? current.effectAssessment : patch.effectAssessment,
      beforeObservationId: patch.beforeObservationId === undefined ? current.beforeObservationId : patch.beforeObservationId,
      preflightObservationId: patch.preflightObservationId === undefined ? current.preflightObservationId : patch.preflightObservationId,
      afterObservationId: patch.afterObservationId === undefined ? current.afterObservationId : patch.afterObservationId,
      errorCode: patch.errorCode === undefined ? current.errorCode : patch.errorCode,
    };
    this.db.prepare(`
      UPDATE device_session_actions SET
        status=?, result_json=?, executed=?, transport_called=?, effect_assessment_json=?,
        before_observation_id=?, preflight_observation_id=?, after_observation_id=?, error_code=?, updated_at=?
      WHERE session_id=? AND idempotency_key=?
    `).run(
      next.status,
      canonicalJson(next.result ?? {}),
      next.executed ? 1 : 0,
      next.transportCalled ? 1 : 0,
      next.effectAssessment == null ? null : canonicalJson(next.effectAssessment),
      next.beforeObservationId,
      next.preflightObservationId,
      next.afterObservationId,
      next.errorCode,
      this.now(),
      sessionId,
      idempotencyKey,
    );
    return this.getDeviceSessionAction(sessionId, idempotencyKey);
  }

  recordDeviceSessionAction({ sessionId, action, fingerprint, result, executed }) {
    const reserved = this.reserveDeviceSessionAction({ sessionId, action, fingerprint });
    if (reserved.reused) return { reused: true, result: reserved.row.result };
    const row = this.updateDeviceSessionAction(sessionId, action.idempotencyKey, {
      status: executed ? "COMPLETED" : "BLOCKED",
      result,
      executed,
    });
    return { reused: false, result: row.result };
  }

  recordDeviceSessionEvent({ sessionId, type, payload = {} }) {
    return this.#insertDeviceSessionEvent({ sessionId, type, payload });
  }

  listDeviceSessionEvents(sessionId, after = 0) {
    return this.db.prepare(
      "SELECT * FROM device_session_events WHERE session_id=? AND event_id>? ORDER BY event_id",
    ).all(sessionId, after).map((row) => ({
      eventId: row.event_id,
      sessionId: row.session_id,
      createdAt: iso(row.created_at),
      type: row.type,
      payload: parseJson(row.payload_json, {}),
    }));
  }

  listLeases() {
    this.cleanupExpiredLeases();
    return this.db.prepare("SELECT * FROM leases ORDER BY created_at").all().map((row) => publicLease(row));
  }

  getM6GateFResourceCounts() {
    const now = this.now();
    const jobs = Number(this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM jobs
      WHERE status IN ('queued','waiting_approval','running','verifying','restoring')
    `).get().count);
    const sessions = Number(this.db.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE expires_at>?",
    ).get(now).count);
    const leases = Number(this.db.prepare(
      "SELECT COUNT(*) AS count FROM leases WHERE expires_at>?",
    ).get(now).count);
    const actionCount = Number(this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM device_session_actions
      WHERE execution_mode='m6-grounded-live-v2'
        AND status IN ('ASSESSED','EXECUTING','EXECUTED')
    `).get().count);
    return Object.freeze({ jobs, leases, sessions, actionCount });
  }

  #recoverM6ActionLedger(now) {
    this.db.prepare(`
      UPDATE device_session_actions SET status='BLOCKED',
        effect_assessment_json='{"effectStatus":"GROUND_ACTION_ABORTED_NOT_SENT"}',
        error_code='CONTROL_RESTART_NO_SEND', updated_at=?
      WHERE execution_mode='m6-grounded-live-v2' AND status <> 'COMPLETED' AND transport_called=0
    `).run(now);
    this.db.prepare(`
      UPDATE device_session_actions SET status='AMBIGUOUS',
        effect_assessment_json='{"effectStatus":"POSSIBLE_EFFECT"}',
        error_code='CONTROL_RESTART_AFTER_SEND', updated_at=?
      WHERE execution_mode='m6-grounded-live-v2' AND status <> 'COMPLETED' AND transport_called=1
    `).run(now);
    this.db.prepare(`
      UPDATE m6_action_claims SET status='BLOCKED', updated_at=?
      WHERE action_id IN (SELECT action_id FROM device_session_actions WHERE execution_mode='m6-grounded-live-v2' AND status='BLOCKED')
    `).run(now);
    this.db.prepare(`
      UPDATE m6_action_claims SET status='AMBIGUOUS', updated_at=?
      WHERE action_id IN (SELECT action_id FROM device_session_actions WHERE execution_mode='m6-grounded-live-v2' AND status='AMBIGUOUS')
    `).run(now);
  }

  getM6GateFence() {
    const row = this.db.prepare("SELECT * FROM m6_gate_fence WHERE marker='M6'").get();
    if (!row) return null;
    return {
      gateId: row.gate_id,
      epochHash: row.epoch_hash,
      generation: Number(row.generation),
      mode: row.mode,
      purpose: row.purpose,
      allowlist: parseJson(row.allowlist_json, []),
      expiresAt: row.expires_at,
      releaseId: row.release_id,
      sourceCommit: row.source_commit,
      locksHash: row.locks_hash,
      updatedAt: iso(row.updated_at),
    };
  }

  #consumeM64LiveWindowAuthorizationNoTransaction({ authorization, verification, fence }) {
    const derivedBodyHash = deriveM64LiveWindowAuthorizationBodyHash(authorization);
    const derivedEnvelopeHash = deriveM64LiveWindowAuthorizationEnvelopeHash(authorization);
    const binding = selectM64LiveWindowRuntimeBinding(authorization);
    const verified = isM64LiveWindowAuthorizationVerification(verification)
      && verification.schemaId === "xw.m6-4-live-window-authorization-verification.v1"
      && verification.authorizationId === authorization?.authorizationId
      && verification.nonce === authorization?.nonce
      && verification.bodyHash === authorization?.bodyHash
      && verification.envelopeHash === authorization?.envelopeHash
      && verification.issuer === authorization?.issuer
      && verification.keyId === authorization?.keyId
      && verification.allowlistVersion === authorization?.allowlistVersion
      && canonicalJson(verification.runtimeBinding) === canonicalJson(binding)
      && authorization?.bodyHash === derivedBodyHash
      && authorization?.envelopeHash === derivedEnvelopeHash;
    if (!verified) {
      throw new ControlPlaneError("M64_LIVE_AUTH_UNVERIFIED", "only a production-verified live-window envelope may be consumed", { status: 403 });
    }
    const now = this.now();
    const issuedAt = Date.parse(authorization.issuedAt);
    const expiresAt = Date.parse(authorization.expiresAt);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > now || expiresAt <= now || expiresAt <= issuedAt) {
      throw new ControlPlaneError("M64_LIVE_AUTH_EXPIRED", "live-window authorization is not active at its consumption linearization point", { status: 409 });
    }
    const fenceMatches = fence
      && fence.mode !== "CLOSED"
      && authorization.gateId === fence.gateId
      && authorization.gateEpochHash === fence.epochHash
      && authorization.gateGeneration === fence.generation
      && authorization.purpose === fence.purpose
      && authorization.releaseId === fence.releaseId
      && authorization.sourceCommit === fence.sourceCommit
      && authorization.locksHash === fence.locksHash
      && canonicalJson(fence.allowlist) === canonicalJson([authorization.alias]);
    if (!fenceMatches) {
      throw new ControlPlaneError("M64_LIVE_AUTH_GENERATION_CAS_MISMATCH", "live-window authorization does not match the current gate fence generation", {
        status: 409,
        details: {
          expectedEpochHash: authorization.gateEpochHash,
          expectedGeneration: authorization.gateGeneration,
          actualEpochHash: fence?.epochHash ?? null,
          actualGeneration: fence?.generation ?? null,
        },
      });
    }
    const nonceHash = sha256(`xw.m6-4-live-window-authorization.v1:nonce:${authorization.nonce}`);
    const receiptRaw = {
      schemaId: "xw.m6-4-live-window-authorization-consumption.v1",
      authorizationId: authorization.authorizationId,
      nonceHash,
      bodyHash: authorization.bodyHash,
      envelopeHash: authorization.envelopeHash,
      issuer: authorization.issuer,
      keyId: authorization.keyId,
      allowlistVersion: authorization.allowlistVersion,
      gateId: authorization.gateId,
      gateEpochHash: authorization.gateEpochHash,
      gateGeneration: authorization.gateGeneration,
      purpose: authorization.purpose,
      releaseId: authorization.releaseId,
      sourceCommit: authorization.sourceCommit,
      locksHash: authorization.locksHash,
      expiresAt: authorization.expiresAt,
      consumedAt: iso(now),
    };
    const receipt = {
      ...receiptRaw,
      consumptionHash: sha256(`xw.m6-4-live-window-authorization-consumption.v1:${canonicalJson(receiptRaw)}`),
    };
    try {
      this.db.prepare(`
        INSERT INTO m6_live_window_authorization_consumptions (
          nonce_hash, authorization_id, body_hash, envelope_hash, issuer, key_id,
          allowlist_version, gate_id, gate_epoch_hash, gate_generation, purpose,
          release_id, source_commit, locks_hash, expires_at, consumed_at,
          consumption_receipt_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        nonceHash,
        authorization.authorizationId,
        authorization.bodyHash,
        authorization.envelopeHash,
        authorization.issuer,
        authorization.keyId,
        authorization.allowlistVersion,
        authorization.gateId,
        authorization.gateEpochHash,
        authorization.gateGeneration,
        authorization.purpose,
        authorization.releaseId,
        authorization.sourceCommit,
        authorization.locksHash,
        expiresAt,
        now,
        canonicalJson(receipt),
      );
    } catch (error) {
      if (/UNIQUE|PRIMARY KEY/i.test(String(error?.message || error))) {
        throw new ControlPlaneError("M64_LIVE_AUTH_REPLAY", "live-window authorization nonce or gate generation was already consumed", { status: 409 });
      }
      throw error;
    }
    return receipt;
  }

  getM64LiveWindowAuthorizationConsumption(authorizationId) {
    const row = this.db.prepare(`
      SELECT consumption_receipt_json
      FROM m6_live_window_authorization_consumptions
      WHERE authorization_id=?
    `).get(authorizationId);
    return row ? parseJson(row.consumption_receipt_json) : null;
  }

  getM6LiveWindowAuthorizationConsumption(authorizationId) {
    return this.getM64LiveWindowAuthorizationConsumption(authorizationId);
  }

  #mapM64LiveScenarioClaim(row) {
    if (!row) return null;
    return {
      schemaId: "xw.m6-4-live-scenario-claim.v1",
      claimHash: row.claim_hash,
      authorizationId: row.authorization_id,
      authorizationHash: row.authorization_hash,
      manifestHash: row.manifest_hash,
      scenarioKey: row.scenario_key,
      purpose: row.purpose,
      gateEpochHash: row.gate_epoch_hash,
      gateGeneration: Number(row.gate_generation),
      status: row.status,
      claimedAt: iso(row.claimed_at),
      finalizedAt: iso(row.finalized_at),
      result: parseJson(row.result_json),
    };
  }

  claimM64LiveScenarioStart({ verification, scenarioKey } = {}) {
    if (!isM64LiveWindowAuthorizationVerification(verification)) {
      throw new ControlPlaneError(
        "M6_LIVE_SCENARIO_AUTH_UNVERIFIED",
        "a process-local verified live-window authorization is required before claiming a scenario",
        { status: 403 },
      );
    }
    if (typeof scenarioKey !== "string" || !/^m6_4_[a-z_]+-[0-9]{2}$/u.test(scenarioKey)) {
      throw new ControlPlaneError("M6_LIVE_SCENARIO_KEY_INVALID", "scenarioKey is not a frozen M6-4 scenario reference", { status: 409 });
    }
    const binding = verification.runtimeBinding;
    const expectedPrefix = `${String(binding?.purpose || "").toLowerCase()}-`;
    if (binding?.alias !== "01" || !scenarioKey.startsWith(expectedPrefix)
      || !/^[0-9a-f]{64}$/u.test(binding?.scenarioManifestHash || "")
      || !/^[0-9a-f]{64}$/u.test(binding?.gateEpochHash || "")
      || !Number.isInteger(binding?.gateGeneration)) {
      throw new ControlPlaneError("M6_LIVE_SCENARIO_BINDING_MISMATCH", "scenario claim is outside the verified cohort binding", { status: 409 });
    }
    return this.transaction(() => {
      const now = this.now();
      if (Date.parse(verification.expiresAt) <= now) {
        throw new ControlPlaneError("M64_LIVE_AUTH_EXPIRED", "live-window authorization expired before scenario claim", { status: 409 });
      }
      const consumption = this.getM64LiveWindowAuthorizationConsumption(verification.authorizationId);
      const fence = this.getM6GateFence();
      const requiredFenceMode = binding.purpose === "M6_4_SHADOW" ? "OBSERVE_ONLY" : "GROUNDED_ACTION";
      const activated = consumption
        && consumption.authorizationId === verification.authorizationId
        && consumption.bodyHash === verification.bodyHash
        && consumption.envelopeHash === verification.envelopeHash
        && consumption.gateId === binding.gateId
        && consumption.gateEpochHash === binding.gateEpochHash
        && consumption.gateGeneration === binding.gateGeneration
        && consumption.purpose === binding.purpose
        && fence?.mode === requiredFenceMode
        && fence.gateId === binding.gateId
        && fence.epochHash === binding.gateEpochHash
        && fence.generation === binding.gateGeneration
        && fence.purpose === binding.purpose
        && canonicalJson(fence.allowlist) === canonicalJson(["01"])
        && Date.parse(fence.expiresAt) > now;
      if (!activated) {
        throw new ControlPlaneError(
          "M6_LIVE_SCENARIO_AUTH_NOT_ACTIVATED",
          "scenario claim requires the exact currently activated Gate-F authorization and fence",
          { status: 403 },
        );
      }
      const claimRaw = {
        schemaId: "xw.m6-4-live-scenario-claim.v1",
        authorizationId: verification.authorizationId,
        authorizationHash: verification.envelopeHash,
        manifestHash: binding.scenarioManifestHash,
        scenarioKey,
        purpose: binding.purpose,
        gateEpochHash: binding.gateEpochHash,
        gateGeneration: binding.gateGeneration,
        claimedAt: iso(now),
      };
      const claimHash = sha256(`xw.m6-4-live-scenario-claim.v1:${canonicalJson(claimRaw)}`);
      try {
        this.db.prepare(`
          INSERT INTO m6_live_scenario_claims (
            claim_hash, authorization_id, authorization_hash, manifest_hash, scenario_key,
            purpose, gate_epoch_hash, gate_generation, status, claimed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTED', ?)
        `).run(
          claimHash,
          verification.authorizationId,
          verification.envelopeHash,
          binding.scenarioManifestHash,
          scenarioKey,
          binding.purpose,
          binding.gateEpochHash,
          binding.gateGeneration,
          now,
        );
      } catch (error) {
        if (/UNIQUE|PRIMARY KEY/iu.test(String(error?.message || error))) {
          throw new ControlPlaneError(
            "M6_LIVE_SCENARIO_ALREADY_CLAIMED",
            "this frozen scenario was already claimed and cannot be replaced or rerun",
            { status: 409, details: { authorizationId: verification.authorizationId, scenarioKey } },
          );
        }
        throw error;
      }
      return this.#mapM64LiveScenarioClaim(this.db.prepare("SELECT * FROM m6_live_scenario_claims WHERE claim_hash=?").get(claimHash));
    });
  }

  getM64LiveScenarioClaim(claimHash) {
    if (typeof claimHash !== "string") return null;
    return this.#mapM64LiveScenarioClaim(this.db.prepare("SELECT * FROM m6_live_scenario_claims WHERE claim_hash=?").get(claimHash));
  }

  listM64LiveScenarioClaims(authorizationId) {
    if (typeof authorizationId !== "string" || authorizationId === "") return [];
    return this.db.prepare(`
      SELECT * FROM m6_live_scenario_claims
      WHERE authorization_id=?
      ORDER BY claimed_at, scenario_key
    `).all(authorizationId).map((row) => this.#mapM64LiveScenarioClaim(row));
  }

  finalizeM64LiveScenarioClaim({
    claimHash,
    outcome,
    actionCount,
    transportCount,
    attemptEvidenceHash,
    oracleObservationHash,
    resetReceiptHash,
    closeReceiptHash,
  } = {}) {
    const hashes = { attemptEvidenceHash, oracleObservationHash, resetReceiptHash, closeReceiptHash };
    if (!/^[0-9a-f]{64}$/u.test(claimHash || "")
      || !["SUCCEEDED", "FAILED", "ABORTED_PENDING_CLOSEOUT"].includes(outcome)
      || !Number.isInteger(actionCount) || actionCount < 0
      || !Number.isInteger(transportCount) || transportCount < 0 || transportCount !== actionCount
      || Object.values(hashes).some((value) => !/^[0-9a-f]{64}$/u.test(value || ""))) {
      throw new ControlPlaneError("M6_LIVE_SCENARIO_RESULT_INVALID", "scenario finalization requires closed, content-addressed evidence", { status: 409 });
    }
    return this.transaction(() => {
      const current = this.getM64LiveScenarioClaim(claimHash);
      if (!current) throw new ControlPlaneError("M6_LIVE_SCENARIO_CLAIM_NOT_FOUND", "scenario claim was not found", { status: 404 });
      if (current.status !== "STARTED") {
        throw new ControlPlaneError("M6_LIVE_SCENARIO_FINALIZE_REPLAY", "scenario claim is already finalized", { status: 409 });
      }
      const finalizedAt = this.now();
      const resultRaw = {
        schemaId: "xw.m6-4-live-scenario-result.v1",
        claimHash,
        outcome,
        actionCount,
        transportCount,
        ...hashes,
        finalizedAt: iso(finalizedAt),
      };
      const result = {
        ...resultRaw,
        resultHash: sha256(`xw.m6-4-live-scenario-result.v1:${canonicalJson(resultRaw)}`),
      };
      const updated = this.db.prepare(`
        UPDATE m6_live_scenario_claims
        SET status='FINALIZED', finalized_at=?, result_json=?
        WHERE claim_hash=? AND status='STARTED'
      `).run(finalizedAt, canonicalJson(result), claimHash);
      if (!updated.changes) {
        throw new ControlPlaneError("M6_LIVE_SCENARIO_FINALIZE_REPLAY", "scenario claim is already finalized", { status: 409 });
      }
      return this.getM64LiveScenarioClaim(claimHash);
    });
  }

  seedM6GateFence({ epoch, locksHash }) {
    const { epochHash: _ignoredEpochHash, ...epochPayload } = epoch || {};
    const derivedEpochHash = sha256(`xw.m6-live-gate.v1:${canonicalJson(epochPayload)}`);
    if (!epoch || epoch.schemaId !== "xw.m6-live-gate.v1" || epoch.mode !== "CLOSED" || epoch.status !== "closed"
      || !epoch.closeoutRef || !epoch.aggregateSealRef || epoch.epochHash !== derivedEpochHash) {
      throw new ControlPlaneError(
        "M6_GATE_FENCE_SEED_INVALID",
        "v19 fence may only seed from a verified v1 CLOSED tail",
        { status: 409 },
      );
    }
    if (!/^[0-9a-f]{64}$/.test(locksHash || "")) {
      throw new ControlPlaneError("M6_GATE_FENCE_SEED_INVALID", "fence seed requires a 64-hex locks hash", { status: 409 });
    }
    return this.transaction(() => {
      const existing = this.getM6GateFence();
      if (existing) {
        if (existing.epochHash !== epoch.epochHash || existing.generation !== 0 || existing.mode !== "CLOSED") {
          throw new ControlPlaneError("M6_GATE_FENCE_ALREADY_SEEDED", "existing M6 fence differs from the seed", { status: 409 });
        }
        return existing;
      }
      this.db.prepare(`
        INSERT INTO m6_gate_fence (
          marker, gate_id, epoch_hash, generation, mode, purpose, allowlist_json,
          expires_at, release_id, source_commit, locks_hash, updated_at
        ) VALUES ('M6', ?, ?, 0, 'CLOSED', NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        epoch.gateId,
        epoch.epochHash,
        canonicalJson(epoch.allowlist),
        epoch.expiresAt,
        epoch.releaseId,
        epoch.sourceCommit,
        locksHash,
        this.now(),
      );
      return this.getM6GateFence();
    });
  }

  // Production qualification bootstrap is the one place that may create the
  // generation-0 M6 fence.  Keep its zero-resource proof in the same SQLite
  // transaction as the insert so a caller cannot observe zero, race another
  // writer, and then seed authority from a stale snapshot.  Unlike the legacy
  // test/setup helper above, replay compares the complete fence identity and
  // refuses every durable M6 residue from an earlier attempt/window.
  seedM6QualificationBootstrapFence({ epoch, locksHash }) {
    const { epochHash: _ignoredEpochHash, ...epochPayload } = epoch || {};
    const derivedEpochHash = sha256(`xw.m6-live-gate.v1:${canonicalJson(epochPayload)}`);
    if (!epoch || epoch.schemaId !== "xw.m6-live-gate.v1" || epoch.mode !== "CLOSED" || epoch.status !== "closed"
      || !epoch.closeoutRef || !epoch.aggregateSealRef || epoch.epochHash !== derivedEpochHash
      || canonicalJson(epoch.allowlist) !== canonicalJson(["01"])) {
      throw new ControlPlaneError(
        "M6_QUALIFICATION_BOOTSTRAP_FENCE_INVALID",
        "qualification bootstrap may only seed from the exact verified alias-01 v1 CLOSED tail",
        { status: 409 },
      );
    }
    if (!/^[0-9a-f]{64}$/.test(locksHash || "")) {
      throw new ControlPlaneError(
        "M6_QUALIFICATION_BOOTSTRAP_FENCE_INVALID",
        "qualification bootstrap fence requires a 64-hex locks hash",
        { status: 409 },
      );
    }
    return this.transaction(() => {
      const resources = this.getM6GateFResourceCounts();
      const durableResidue = Object.freeze({
        groundedActions: Number(this.db.prepare(
          "SELECT COUNT(*) AS count FROM device_session_actions WHERE execution_mode='m6-grounded-live-v2'",
        ).get().count),
        emergencyCloseConsumptions: Number(this.db.prepare("SELECT COUNT(*) AS count FROM m6_emergency_close_consumptions").get().count),
        groundingPermits: Number(this.db.prepare("SELECT COUNT(*) AS count FROM m6_grounding_permits").get().count),
        actionClaims: Number(this.db.prepare("SELECT COUNT(*) AS count FROM m6_action_claims").get().count),
        groundedActionDetails: Number(this.db.prepare("SELECT COUNT(*) AS count FROM m6_grounded_action_details").get().count),
        liveWindowAuthorizations: Number(this.db.prepare("SELECT COUNT(*) AS count FROM m6_live_window_authorization_consumptions").get().count),
        liveScenarioClaims: Number(this.db.prepare("SELECT COUNT(*) AS count FROM m6_live_scenario_claims").get().count),
        safetyCloseArms: Number(this.db.prepare("SELECT COUNT(*) AS count FROM m6_gate_safety_close_arms").get().count),
      });
      if (Object.values(resources).some((count) => !Number.isSafeInteger(count) || count !== 0)
        || Object.values(durableResidue).some((count) => !Number.isSafeInteger(count) || count !== 0)) {
        throw new ControlPlaneError(
          "M6_QUALIFICATION_BOOTSTRAP_RESOURCES_NOT_ZERO",
          "qualification bootstrap requires one atomic zero-resource and zero-M6-residue database snapshot",
          { status: 409, details: { resources, durableResidue } },
        );
      }
      const expected = {
        gateId: epoch.gateId,
        epochHash: epoch.epochHash,
        generation: 0,
        mode: "CLOSED",
        purpose: null,
        allowlist: epoch.allowlist,
        expiresAt: epoch.expiresAt,
        releaseId: epoch.releaseId,
        sourceCommit: epoch.sourceCommit,
        locksHash,
      };
      const existing = this.getM6GateFence();
      if (existing) {
        const comparable = {
          gateId: existing.gateId,
          epochHash: existing.epochHash,
          generation: existing.generation,
          mode: existing.mode,
          purpose: existing.purpose,
          allowlist: existing.allowlist,
          expiresAt: existing.expiresAt,
          releaseId: existing.releaseId,
          sourceCommit: existing.sourceCommit,
          locksHash: existing.locksHash,
        };
        if (canonicalJson(comparable) !== canonicalJson(expected)) {
          throw new ControlPlaneError(
            "M6_QUALIFICATION_BOOTSTRAP_FENCE_DRIFT",
            "existing M6 fence differs from the exact qualification bootstrap generation",
            { status: 409 },
          );
        }
        return existing;
      }
      this.db.prepare(`
        INSERT INTO m6_gate_fence (
          marker, gate_id, epoch_hash, generation, mode, purpose, allowlist_json,
          expires_at, release_id, source_commit, locks_hash, updated_at
        ) VALUES ('M6', ?, ?, 0, 'CLOSED', NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        epoch.gateId,
        epoch.epochHash,
        canonicalJson(epoch.allowlist),
        epoch.expiresAt,
        epoch.releaseId,
        epoch.sourceCommit,
        locksHash,
        this.now(),
      );
      return this.getM6GateFence();
    });
  }

  promoteM6GateFence({
    expectedEpochHash,
    expectedGeneration,
    next,
    emergencyCloseConsumption = null,
    liveWindowAuthorizationConsumption = null,
    safetyCloseArm = null,
    safetyCloseArmTerminalization = null,
  }) {
    if (!next || !/^[0-9a-f]{64}$/.test(next.epochHash || "") || !/^[0-9a-f]{64}$/.test(next.locksHash || "")
      || !Number.isFinite(Date.parse(next.expiresAt)) || !Array.isArray(next.allowlist) || next.allowlist.length === 0
      || !["CLOSED", "OBSERVE_ONLY", "GROUNDED_ACTION"].includes(next.mode)) {
      throw new ControlPlaneError("M6_GATE_FENCE_PROMOTE_INVALID", "next M6 fence is incomplete", { status: 409 });
    }
    return this.transaction(() => {
      const current = this.getM6GateFence();
      if (!current || current.epochHash !== expectedEpochHash || current.generation !== expectedGeneration) {
        throw new ControlPlaneError("M6_GATE_FENCE_CAS_MISMATCH", "M6 fence compare-and-swap precondition failed", {
          status: 409,
          details: { expectedEpochHash, expectedGeneration, actualEpochHash: current?.epochHash || null, actualGeneration: current?.generation ?? null },
        });
      }
      if (next.mode !== "CLOSED" && current.epochHash !== next.epochHash) {
        const resources = this.getM6GateFResourceCounts();
        if (Object.values(resources).some((count) => count !== 0)) {
          throw new ControlPlaneError(
            "M6_GATE_F_RESOURCES_NOT_ZERO",
            "M6 gate activation requires an atomic zero-resource snapshot",
            { status: 409, details: { resources } },
          );
        }
      }
      const generation = current.generation + 1;
      const armedSafetyClose = next.mode === "CLOSED"
        ? this.db.prepare("SELECT active_epoch_hash FROM m6_gate_safety_close_arms WHERE active_epoch_hash=? AND status='ARMED'")
          .get(current.epochHash)
        : null;
      if (armedSafetyClose && !safetyCloseArmTerminalization) {
        throw new ControlPlaneError(
          "M6_GATE_SAFETY_CLOSE_TERMINAL_REQUIRED",
          "an active safety-close arm must be atomically consumed or released with the CLOSED fence",
          { status: 409 },
        );
      }
      if (safetyCloseArmTerminalization) {
        const requestedStatus = safetyCloseArmTerminalization.status;
        const hasEmergencyConsumption = emergencyCloseConsumption !== null;
        if ((requestedStatus === "CONSUMED" && (!hasEmergencyConsumption
          || next.epochHash !== safetyCloseArmTerminalization.armCloseEpochHash
          || safetyCloseArmTerminalization.terminalProofHash !== null))
          || (requestedStatus === "RELEASED" && (hasEmergencyConsumption
            || !/^[0-9a-f]{64}$/.test(safetyCloseArmTerminalization.terminalProofHash || "")))) {
          throw new ControlPlaneError(
            "M6_GATE_SAFETY_CLOSE_TERMINAL_INVALID",
            "safety-close consumption must use its exact armed epoch and emergency authorization; release must not consume emergency authority",
            { status: 409 },
          );
        }
      }
      if (liveWindowAuthorizationConsumption) {
        this.#consumeM64LiveWindowAuthorizationNoTransaction({
          ...liveWindowAuthorizationConsumption,
          fence: { ...next, generation },
        });
      }
      if (safetyCloseArm) {
        const armPackage = safetyCloseArm.package;
        const valid = safetyCloseArm.schemaId === "xw.m6-gate-safety-close-arm.v1"
          && safetyCloseArm.activeEpochHash === next.epochHash
          && safetyCloseArm.gateId === next.gateId
          && safetyCloseArm.purpose === next.purpose
          && safetyCloseArm.closeEpochHash === armPackage?.epoch?.epochHash
          && safetyCloseArm.activeEpochHash === armPackage?.epoch?.parentEpochHash
          && safetyCloseArm.reasonCode === armPackage?.reasonCode
          && safetyCloseArm.packageHash === deriveM6GateFSafetyClosePackageHash(armPackage)
          && /^[0-9a-f]{64}$/.test(safetyCloseArm.activationProofHash || "")
          && safetyCloseArm.proofHash === deriveM6GateFSafetyCloseProofHash(armPackage?.proof)
          && [safetyCloseArm.packageHash, safetyCloseArm.proofHash,
            safetyCloseArm.activeEpochHash, safetyCloseArm.closeEpochHash]
            .every((value) => /^[0-9a-f]{64}$/.test(value || ""))
          && [safetyCloseArm.expiresAtMs, safetyCloseArm.authorizationExpiresAtMs,
            safetyCloseArm.packageExpiresAtMs].every(Number.isFinite)
          && safetyCloseArm.expiresAtMs === Math.min(
            safetyCloseArm.authorizationExpiresAtMs,
            safetyCloseArm.packageExpiresAtMs,
          )
          && safetyCloseArm.expiresAtMs > this.now()
          && next.mode !== "CLOSED";
        if (!valid) {
          throw new ControlPlaneError("M6_GATE_SAFETY_CLOSE_ARM_INVALID", "safety-close arm is incomplete or rebound", { status: 409 });
        }
        try {
          this.db.prepare(`
            INSERT INTO m6_gate_safety_close_arms (
              active_epoch_hash, gate_id, purpose, close_epoch_hash, package_hash,
              activation_proof_hash, proof_hash, reason_code, expires_at, authorization_expires_at,
              package_expires_at, package_json, armed_generation, status, armed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ARMED', ?)
          `).run(
            safetyCloseArm.activeEpochHash,
            safetyCloseArm.gateId,
            safetyCloseArm.purpose,
            safetyCloseArm.closeEpochHash,
            safetyCloseArm.packageHash,
            safetyCloseArm.activationProofHash,
            safetyCloseArm.proofHash,
            safetyCloseArm.reasonCode,
            safetyCloseArm.expiresAtMs,
            safetyCloseArm.authorizationExpiresAtMs,
            safetyCloseArm.packageExpiresAtMs,
            canonicalJson(armPackage),
            generation,
            this.now(),
          );
        } catch (error) {
          if (/UNIQUE|PRIMARY KEY/i.test(String(error?.message || error))) {
            throw new ControlPlaneError("M6_GATE_SAFETY_CLOSE_ARM_REPLAY", "safety-close package or active epoch was already armed", { status: 409 });
          }
          throw error;
        }
      }
      if (emergencyCloseConsumption) {
        if (typeof emergencyCloseConsumption.nonce !== "string" || emergencyCloseConsumption.nonce === ""
          || !/^[0-9a-f]{64}$/.test(emergencyCloseConsumption.authorizationHash || "")
          || typeof emergencyCloseConsumption.reasonCode !== "string" || emergencyCloseConsumption.reasonCode === "") {
          throw new ControlPlaneError("M6_GATE_EMERGENCY_CLOSE_INVALID", "emergency-close consumption is incomplete", { status: 409 });
        }
        try {
          this.db.prepare(`
            INSERT INTO m6_emergency_close_consumptions (nonce, authorization_hash, reason_code, consumed_at)
            VALUES (?, ?, ?, ?)
          `).run(
            emergencyCloseConsumption.nonce,
            emergencyCloseConsumption.authorizationHash,
            emergencyCloseConsumption.reasonCode,
            this.now(),
          );
        } catch (error) {
          if (/UNIQUE|PRIMARY KEY/i.test(String(error?.message || error))) {
            throw new ControlPlaneError("M6_GATE_EMERGENCY_CLOSE_REPLAY", "emergency-close authorization was already consumed", { status: 409 });
          }
          throw error;
        }
      }
      if (safetyCloseArmTerminalization) {
        const terminalStatus = safetyCloseArmTerminalization.status;
        if (!["CONSUMED", "RELEASED"].includes(terminalStatus)
          || !/^[0-9a-f]{64}$/.test(safetyCloseArmTerminalization.activeEpochHash || "")
          || !/^[0-9a-f]{64}$/.test(safetyCloseArmTerminalization.armCloseEpochHash || "")
          || !/^[0-9a-f]{64}$/.test(safetyCloseArmTerminalization.packageHash || "")
          || (terminalStatus === "RELEASED"
            ? !/^[0-9a-f]{64}$/.test(safetyCloseArmTerminalization.terminalProofHash || "")
            : safetyCloseArmTerminalization.terminalProofHash !== null)
          || safetyCloseArmTerminalization.activeEpochHash !== current.epochHash
          || safetyCloseArmTerminalization.terminalEpochHash !== next.epochHash
          || next.mode !== "CLOSED") {
          throw new ControlPlaneError("M6_GATE_SAFETY_CLOSE_TERMINAL_INVALID", "safety-close arm terminalization is incomplete or rebound", { status: 409 });
        }
        const updated = this.db.prepare(`
          UPDATE m6_gate_safety_close_arms
          SET status=?, terminal_epoch_hash=?, terminal_proof_hash=?, terminalized_at=?
          WHERE active_epoch_hash=? AND close_epoch_hash=? AND package_hash=? AND status='ARMED'
        `).run(
          terminalStatus,
          next.epochHash,
          safetyCloseArmTerminalization.terminalProofHash,
          this.now(),
          safetyCloseArmTerminalization.activeEpochHash,
          safetyCloseArmTerminalization.armCloseEpochHash,
          safetyCloseArmTerminalization.packageHash,
        );
        if (!updated.changes) {
          throw new ControlPlaneError("M6_GATE_SAFETY_CLOSE_TERMINAL_MISMATCH", "no exact armed safety-close package was available to terminalize", { status: 409 });
        }
      }
      this.db.prepare(`
        UPDATE m6_gate_fence SET
          gate_id=?, epoch_hash=?, generation=?, mode=?, purpose=?, allowlist_json=?,
          expires_at=?, release_id=?, source_commit=?, locks_hash=?, updated_at=?
        WHERE marker='M6'
      `).run(
        next.gateId,
        next.epochHash,
        generation,
        next.mode,
        next.purpose ?? null,
        canonicalJson(next.allowlist),
        next.expiresAt,
        next.releaseId,
        next.sourceCommit,
        next.locksHash,
        this.now(),
      );
      return this.getM6GateFence();
    });
  }

  assertM6GateFence(expected) {
    const current = this.getM6GateFence();
    const same = current && [
      "gateId", "epochHash", "generation", "mode", "purpose", "expiresAt",
      "releaseId", "sourceCommit", "locksHash",
    ].every((key) => current[key] === expected?.[key])
      && canonicalJson(current.allowlist) === canonicalJson(expected?.allowlist);
    if (!same) {
      throw new ControlPlaneError("M6_GATE_FENCE_MISMATCH", "file gate and DB fence are not identical", { status: 423 });
    }
    return current;
  }

  getM6EmergencyCloseConsumption(nonce) {
    const row = this.db.prepare("SELECT * FROM m6_emergency_close_consumptions WHERE nonce=?").get(nonce);
    return row ? {
      nonce: row.nonce,
      authorizationHash: row.authorization_hash,
      reasonCode: row.reason_code,
      consumedAt: iso(row.consumed_at),
    } : null;
  }

  issueM6GroundingPermit({ decision, slot, timing }) {
    const forbiddenKey = (value) => {
      if (!value || typeof value !== "object") return false;
      if (Array.isArray(value)) return value.some(forbiddenKey);
      return Object.entries(value).some(([key, child]) => /^(?:x|y|x1|y1|x2|y2|bounds|coordinates?|primitiveAction)$/iu.test(key) || forbiddenKey(child));
    };
    if (decision?.schemaId !== "xw.grounding-decision.v2" || decision.disposition !== "ALLOW_ONCE"
      || !/^[0-9a-f]{64}$/.test(decision.decisionRef || "") || forbiddenKey(decision)
      || !slot || !/^[0-9a-f]{64}$/.test(slot.slotSpecHash || "")
      || forbiddenKey(slot) || !timing || !Number.isFinite(timing.issuedAtMs)
      || !Number.isFinite(timing.expiresAtMs) || timing.expiresAtMs <= timing.issuedAtMs
      || !Number.isFinite(timing.dispatchDeadlineMonoMs)) {
      throw new ControlPlaneError("M6_GROUNDING_PERMIT_INVALID", "durable grounding permit input is invalid", { status: 409 });
    }
    const now = this.now();
    if (timing.expiresAtMs <= now) {
      throw new ControlPlaneError("M6_GROUNDING_PERMIT_EXPIRED", "grounding permit is already expired", { status: 409 });
    }
    const permitId = newId("m6_permit");
    const raw = {
      schemaId: "xw.m6-grounding-permit.v1",
      permitId,
      decisionRef: decision.decisionRef,
      operationKey: decision.operationKey,
      target: decision.target,
      bindings: decision.bindings,
      slot: { ...slot },
      timing: {
        issuedAtMs: timing.issuedAtMs,
        expiresAtMs: timing.expiresAtMs,
        dispatchDeadlineMonoMs: timing.dispatchDeadlineMonoMs,
      },
    };
    const permitHash = sha256(`xw.m6-grounding-permit.v1:${canonicalJson(raw)}`);
    const permit = { ...raw, permitHash };
    try {
      this.db.prepare(`
        INSERT INTO m6_grounding_permits (
          permit_id, permit_hash, decision_ref, operation_key, permit_json, issued_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(permitId, permitHash, decision.decisionRef, decision.operationKey, canonicalJson(permit), timing.issuedAtMs, timing.expiresAtMs);
    } catch (error) {
      if (/UNIQUE|PRIMARY KEY/i.test(String(error?.message || error))) {
        throw new ControlPlaneError("M6_GROUNDING_DECISION_REPLAY", "grounding decision already owns a permit", { status: 409 });
      }
      throw error;
    }
    return permit;
  }

  getM6GroundingPermit(permitId) {
    const row = this.db.prepare("SELECT * FROM m6_grounding_permits WHERE permit_id=?").get(permitId);
    if (!row) return null;
    return {
      ...parseJson(row.permit_json),
      consumedAt: iso(row.consumed_at),
      consumptionReceipt: parseJson(row.consumption_receipt_json),
    };
  }

  #consumeM6GroundingPermitNoTransaction({ permitId, expected, nowMonoMs, minimumRemainingTtlMs = 1000 }) {
    if (!Number.isFinite(nowMonoMs) || !Number.isFinite(minimumRemainingTtlMs) || minimumRemainingTtlMs < 1000) {
      throw new ControlPlaneError("M6_GROUNDING_PERMIT_INVALID", "permit consume requires monotonic time and minimum TTL >=1s", { status: 409 });
    }
    const permit = this.getM6GroundingPermit(permitId);
    if (!permit) throw new ControlPlaneError("M6_GROUNDING_PERMIT_NOT_FOUND", "grounding permit not found", { status: 404 });
    if (permit.consumedAt) throw new ControlPlaneError("M6_GROUNDING_PERMIT_REPLAY", "grounding permit is already consumed", { status: 409 });
    const remainingTtlMs = permit.timing.expiresAtMs - this.now();
    const remainingMonoMs = permit.timing.dispatchDeadlineMonoMs - nowMonoMs;
    if (remainingTtlMs < minimumRemainingTtlMs || remainingMonoMs < minimumRemainingTtlMs) {
      throw new ControlPlaneError("M6_GROUNDING_PERMIT_STALE", "grounding permit has insufficient remaining TTL", { status: 409 });
    }
    const expectedBinding = { operationKey: expected?.operationKey, target: expected?.target, bindings: expected?.bindings, slot: expected?.slot };
    const actualBinding = { operationKey: permit.operationKey, target: permit.target, bindings: permit.bindings, slot: permit.slot };
    if (canonicalJson(expectedBinding) !== canonicalJson(actualBinding)) {
      throw new ControlPlaneError("M6_GROUNDING_PERMIT_BINDING_MISMATCH", "grounding permit binding changed before consume", { status: 409 });
    }
    const consumedAtMs = this.now();
    const receiptRaw = {
      schemaId: "xw.m6-grounding-permit-consumption.v1", permitId: permit.permitId, permitHash: permit.permitHash,
      decisionRef: permit.decisionRef, operationKey: permit.operationKey, target: permit.target, bindings: permit.bindings,
      slot: permit.slot, remainingTtlMs, remainingMonoMs, dispatchDeadlineMonoMs: permit.timing.dispatchDeadlineMonoMs,
      consumedAtMonoMs: nowMonoMs, consumedAtMs,
    };
    const receipt = { ...receiptRaw, consumptionHash: sha256(`xw.m6-grounding-permit-consumption.v1:${canonicalJson(receiptRaw)}`) };
    const updated = this.db.prepare(`UPDATE m6_grounding_permits SET consumed_at=?, consumption_receipt_json=? WHERE permit_id=? AND consumed_at IS NULL`)
      .run(consumedAtMs, canonicalJson(receipt), permitId);
    if (!updated.changes) throw new ControlPlaneError("M6_GROUNDING_PERMIT_REPLAY", "grounding permit is already consumed", { status: 409 });
    return receipt;
  }

  consumeM6GroundingPermit(input) {
    return this.transaction(() => this.#consumeM6GroundingPermitNoTransaction(input));
  }

  #mapM6ActionLedger(row) {
    if (!row) return null;
    return {
      actionId: row.action_id,
      operationKey: row.operation_key,
      permitId: row.permit_id,
      runId: row.run_id,
      sessionId: row.session_id,
      leaseId: row.lease_id,
      status: row.status,
      transportCounter: Number(row.transport_called),
      externalEffect: Boolean(row.transport_called),
      effectStatus: parseJson(row.effect_assessment_json)?.effectStatus || "NO_EFFECT",
      authorizationReceipt: parseJson(row.authorization_receipt_json),
      guardReceipt: parseJson(row.guard_receipt_json),
      transportResult: parseJson(row.transport_result_json),
      completionReceipt: parseJson(row.completion_receipt_json),
      errorCode: row.error_code,
      createdAt: iso(row.action_created_at),
      updatedAt: iso(row.action_updated_at),
    };
  }

  getM6ActionLedger(actionId) {
    return this.#mapM6ActionLedger(this.db.prepare(`
      SELECT d.*, a.status, a.transport_called, a.effect_assessment_json, a.error_code,
        a.created_at AS action_created_at, a.updated_at AS action_updated_at
      FROM m6_grounded_action_details d
      JOIN device_session_actions a ON a.action_id=d.action_id AND a.session_id=d.session_id
      WHERE d.action_id=?
    `).get(actionId));
  }

  getM6GateSafetyCloseArm(activeEpochHash) {
    const row = this.db.prepare("SELECT * FROM m6_gate_safety_close_arms WHERE active_epoch_hash=?").get(activeEpochHash);
    return this.#mapM6GateSafetyCloseArm(row);
  }

  getM6GateSafetyCloseArmByTerminalEpoch(terminalEpochHash) {
    const row = this.db.prepare("SELECT * FROM m6_gate_safety_close_arms WHERE terminal_epoch_hash=?").get(terminalEpochHash);
    return this.#mapM6GateSafetyCloseArm(row);
  }

  #mapM6GateSafetyCloseArm(row) {
    return row ? Object.freeze({
      schemaId: "xw.m6-gate-safety-close-arm.v1",
      gateId: row.gate_id,
      purpose: row.purpose,
      activeEpochHash: row.active_epoch_hash,
      closeEpochHash: row.close_epoch_hash,
      packageHash: row.package_hash,
      activationProofHash: row.activation_proof_hash,
      proofHash: row.proof_hash,
      reasonCode: row.reason_code,
      expiresAt: iso(row.expires_at),
      authorizationExpiresAt: iso(row.authorization_expires_at),
      packageExpiresAt: iso(row.package_expires_at),
      package: parseJson(row.package_json),
      armedGeneration: row.armed_generation,
      status: row.status,
      armedAt: iso(row.armed_at),
      terminalEpochHash: row.terminal_epoch_hash ?? null,
      terminalProofHash: row.terminal_proof_hash ?? null,
      terminalizedAt: iso(row.terminalized_at),
    }) : null;
  }

  listM6ActionLedgersForRun(runId) {
    if (typeof runId !== "string" || runId === "") return [];
    return this.db.prepare(`
      SELECT d.*, a.status, a.transport_called, a.effect_assessment_json, a.error_code,
        a.created_at AS action_created_at, a.updated_at AS action_updated_at
      FROM m6_grounded_action_details d
      JOIN device_session_actions a ON a.action_id=d.action_id AND a.session_id=d.session_id
      WHERE d.run_id=?
      ORDER BY a.created_at, d.action_id
    `).all(runId).map((row) => this.#mapM6ActionLedger(row));
  }

  prepareM6GroundedAction({ decision, slot, timing, fence, actionId = newId("m6_action") }) {
    return this.transaction(() => {
      this.assertM6GateFence(fence);
      if (decision?.bindings?.gateEpochHash !== fence.epochHash || decision?.bindings?.gateGeneration !== fence.generation
        || decision?.bindings?.sessionId == null || decision?.bindings?.leaseId == null || decision?.bindings?.runId == null) {
        throw new ControlPlaneError("M6_ACTION_BINDING_MISMATCH", "decision does not bind to the current fence/run/session/lease", { status: 409 });
      }
      const permit = this.issueM6GroundingPermit({ decision, slot, timing });
      const targetHash = sha256(`xw.m6-action-target.v1:${canonicalJson(decision.target)}`);
      const now = this.now();
      try {
        this.db.prepare(`
          INSERT INTO m6_action_claims (
            operation_key, action_id, slot_spec_hash, target_hash, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'RESERVED', ?, ?)
        `).run(decision.operationKey, actionId, slot.slotSpecHash, targetHash, now, now);
        this.db.prepare(`
          INSERT INTO device_session_actions (
            session_id, idempotency_key, action_id, fingerprint_json, result_json, executed, created_at,
            status, execution_mode, transport_called, executor_id, effect_assessment_json, updated_at
          ) VALUES (?, ?, ?, ?, '{}', 0, ?, 'ASSESSED', 'm6-grounded-live-v2', 0, 'm6-typed-adapter',
            '{"effectStatus":"NO_EFFECT"}', ?)
        `).run(decision.bindings.sessionId, decision.operationKey, actionId, canonicalJson({
          operationKey: decision.operationKey, decisionRef: decision.decisionRef, slotSpecHash: slot.slotSpecHash, targetHash,
        }), now, now);
        this.db.prepare(`
          INSERT INTO m6_grounded_action_details (
            action_id, operation_key, permit_id, run_id, session_id, lease_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          actionId,
          decision.operationKey,
          permit.permitId,
          decision.bindings.runId,
          decision.bindings.sessionId,
          decision.bindings.leaseId,
          now,
          now,
        );
      } catch (error) {
        if (/UNIQUE|PRIMARY KEY/i.test(String(error?.message || error))) {
          throw new ControlPlaneError("M6_LOGICAL_ACTION_CLAIM_CONFLICT", "logical action already has a global claim", { status: 409 });
        }
        throw error;
      }
      return { permit, ledger: this.getM6ActionLedger(actionId) };
    });
  }

  authorizeM6GroundedActionSend({ actionId, fence, expectedPermit, nowMonoMs, typedAuthorization }) {
    return this.transaction(() => {
      this.assertM6GateFence(fence);
      const ledger = this.getM6ActionLedger(actionId);
      if (!ledger || ledger.status !== "ASSESSED" || ledger.transportCounter !== 0) {
        throw new ControlPlaneError("M6_ACTION_STATE_INVALID", "only ASSESSED zero-transport actions may authorize", { status: 409 });
      }
      // Validate the entire M6 authority closure before either one-shot object
      // is consumed. The transaction still protects the later dual consume,
      // but a cross-binding mismatch must leave both nonces visibly untouched.
      const permit = this.getM6GroundingPermit(ledger.permitId);
      const typedAuthorizationId = typedAuthorization?.authorizationId || typedAuthorization?.authorization?.authorizationId;
      const storedAuthorization = this.getTransportActionAuthorization(typedAuthorizationId);
      const capabilityJob = storedAuthorization?.jobId ? this.getJob(storedAuthorization.jobId) : null;
      const sessionRow = capabilityJob?.sessionId
        ? this.db.prepare("SELECT * FROM sessions WHERE session_id=?").get(capabilityJob.sessionId)
        : null;
      const leaseRow = sessionRow
        ? this.db.prepare("SELECT * FROM leases WHERE lease_id=?").get(sessionRow.lease_id)
        : null;
      const deviceRow = capabilityJob?.deviceId
        ? this.db.prepare("SELECT * FROM devices WHERE device_id=?").get(capabilityJob.deviceId)
        : null;
      const currentCapability = this.getCapabilityRecord("xiaowei.m6.grounded_run");
      const jobCapability = capabilityJob?.capability;
      const jobClosureHash = jobCapability?.implementation?.implementationClosureHash ?? null;
      const currentClosureHash = currentCapability?.implementation?.implementationClosureHash ?? null;
      const expectedBinding = {
        operationKey: expectedPermit?.operationKey,
        target: expectedPermit?.target,
        bindings: expectedPermit?.bindings,
        slot: expectedPermit?.slot,
      };
      const permitBinding = permit && {
        operationKey: permit.operationKey,
        target: permit.target,
        bindings: permit.bindings,
        slot: permit.slot,
      };
      if (!storedAuthorization || storedAuthorization.kind !== "capability_job" || storedAuthorization.purpose !== "execute"
        || storedAuthorization.source !== "m6-parent-broker"
        || !permit || permit.consumedAt || canonicalJson(expectedBinding) !== canonicalJson(permitBinding)
        || !storedAuthorization.jobId || storedAuthorization.runId !== permit.bindings.runId
        || storedAuthorization.leaseId !== permit.bindings.leaseId || storedAuthorization.operationKey !== permit.operationKey
        || !capabilityJob || capabilityJob.status !== "running" || capabilityJob.runId !== storedAuthorization.runId
        || capabilityJob.sessionId !== ledger.sessionId || capabilityJob.deviceId !== storedAuthorization.deviceId
        || capabilityJob.capabilityId !== "xiaowei.m6.grounded_run" || capabilityJob.canary !== true
        || jobCapability?.id !== "xiaowei.m6.grounded_run"
        || jobCapability?.implementation?.action !== "m6_grounded_run"
        || !/^[0-9a-f]{64}$/.test(jobCapability?.capabilityContractHash || "")
        || !/^[0-9a-f]{64}$/.test(jobClosureHash || "")
        || storedAuthorization.capabilityContractHash !== jobCapability.capabilityContractHash
        || storedAuthorization.implementationClosureHash !== jobClosureHash
        || currentCapability?.enabled !== true
        || currentCapability.capabilityContractHash !== jobCapability.capabilityContractHash
        || currentClosureHash !== jobClosureHash
        || !sessionRow || sessionRow.lease_id !== storedAuthorization.leaseId
        || sessionRow.device_id !== storedAuthorization.deviceId || sessionRow.canary !== 1
        || sessionRow.scope_capability_id !== "xiaowei.m6.grounded_run" || sessionRow.expires_at <= this.now()
        || !leaseRow || leaseRow.device_id !== storedAuthorization.deviceId || leaseRow.expires_at <= this.now()
        || !deviceRow || deviceRow.alias !== "01"
        || canonicalJson(fence.allowlist) !== canonicalJson(["01"])
        || permit.bindings.jobId !== storedAuthorization.jobId
        || permit.bindings.deviceId !== storedAuthorization.deviceId
        || permit.bindings.capabilityId !== "xiaowei.m6.grounded_run"
        || permit.bindings.capabilityContractHash !== storedAuthorization.capabilityContractHash
        || permit.bindings.implementationClosureHash !== storedAuthorization.implementationClosureHash
        || permit.bindings.sessionScopeCapabilityId !== "xiaowei.m6.grounded_run"
        || permit.bindings.canary !== true || permit.bindings.alias !== "01"
        || permit.bindings.actionSlotSpecHash !== permit.slot.slotSpecHash
        || permit.slot.slotSpecHash !== expectedPermit?.slot?.slotSpecHash
        || permit.slot.primitive !== expectedPermit?.slot?.primitive
        || permit.slot.targetKind !== permit.target?.kind) {
        throw new ControlPlaneError("M6_TYPED_AUTH_BINDING_MISMATCH", "typed transport authorization is not bound to the exact grounded-run capability/session/alias/slot closure", { status: 409 });
      }
      const permitReceipt = this.#consumeM6GroundingPermitNoTransaction({
        permitId: ledger.permitId,
        expected: expectedPermit,
        nowMonoMs,
        minimumRemainingTtlMs: 1000,
      });
      if (permitReceipt.bindings.gateEpochHash !== fence.epochHash || permitReceipt.bindings.gateGeneration !== fence.generation) {
        throw new ControlPlaneError("M6_GATE_FENCE_MISMATCH", "permit consumption fence changed", { status: 423 });
      }
      const typedReceipt = this.#consumeTransportActionAuthorizationNoTransaction({
        authorizationId: typedAuthorizationId,
        token: typedAuthorization.token,
        expectedPurpose: "execute",
        expectedDeviceId: storedAuthorization.deviceId,
        expectedLeaseId: permitReceipt.bindings.leaseId,
      });
      const receipt = { schemaId: "xw.m6-action-authorization-receipt.v1", permit: permitReceipt, typedAuthorization: typedReceipt };
      this.db.prepare(`
        UPDATE m6_grounded_action_details SET authorization_receipt_json=?, updated_at=?
        WHERE action_id=?
      `).run(canonicalJson(receipt), this.now(), actionId);
      this.db.prepare("UPDATE device_session_actions SET status='EXECUTING', updated_at=? WHERE action_id=? AND session_id=?")
        .run(this.now(), actionId, ledger.sessionId);
      this.db.prepare("UPDATE m6_action_claims SET status='CONSUMED', updated_at=? WHERE action_id=?").run(this.now(), actionId);
      return this.getM6ActionLedger(actionId);
    });
  }

  markM6ActionTransportStart({ actionId, currentState, guardStartedMonoMs, writeReadyMonoMs, privateMaterialBinding }) {
    return this.transaction(() => {
      const ledger = this.getM6ActionLedger(actionId);
      if (!ledger || ledger.status !== "EXECUTING" || ledger.transportCounter !== 0 || !ledger.authorizationReceipt) {
        throw new ControlPlaneError("M6_ACTION_STATE_INVALID", "transport start requires an EXECUTING zero-counter action", { status: 409 });
      }
      const slot = ledger.authorizationReceipt.permit.slot;
      const comparableKeys = [
        "uiStateGeneration", "appPackageHash", "focusHash", "pageFingerprint",
        "rotation", "displayHash", "environmentAttestationHash",
      ];
      const currentStateHash = sha256(`xw.m6-current-state.v1:${canonicalJson(currentState)}`);
      const { bindingHash: _ignoredBindingHash, ...privateBindingRaw } = privateMaterialBinding || {};
      const privateBindingHashValid = privateMaterialBinding?.schemaId === "xw.m6-private-material-binding.v1"
        && /^[0-9a-f]{64}$/.test(privateMaterialBinding?.privateMaterialHash || "")
        && /^[0-9a-f]{64}$/.test(privateMaterialBinding?.bindingHash || "")
        && privateMaterialBinding.bindingHash === sha256(`xw.m6-private-material-binding.v1:${canonicalJson(privateBindingRaw)}`);
      const permit = ledger.authorizationReceipt.permit;
      const privateBindingMatches = privateBindingHashValid
        && privateMaterialBinding.operationKey === permit.operationKey
        && privateMaterialBinding.decisionRef === permit.decisionRef
        && privateMaterialBinding.slotSpecHash === slot.slotSpecHash
        && privateMaterialBinding.primitive === slot.primitive
        && canonicalJson(privateMaterialBinding.target) === canonicalJson(permit.target)
        && privateMaterialBinding.trustedParameterHash === slot.trustedParameterHash
        && privateMaterialBinding.currentStateHash === currentStateHash
        && privateMaterialBinding.boundsRef === (slot.boundsRef ?? null)
        && privateMaterialBinding.appRef === (slot.appRef ?? null)
        && privateMaterialBinding.textRef === (slot.textRef ?? null);
      if (!Number.isFinite(guardStartedMonoMs) || !Number.isFinite(writeReadyMonoMs)
        || writeReadyMonoMs < guardStartedMonoMs || writeReadyMonoMs - guardStartedMonoMs > 250
        || writeReadyMonoMs >= ledger.authorizationReceipt.permit.dispatchDeadlineMonoMs
        || comparableKeys.some((key) => currentState?.[key] !== slot?.[key])
        || !privateBindingMatches) {
        this.db.prepare(`
          UPDATE device_session_actions SET status='BLOCKED', effect_assessment_json='{"effectStatus":"GROUND_ACTION_ABORTED_NOT_SENT"}',
            error_code='M6_TCB_CURRENT_STATE_GUARD', updated_at=? WHERE action_id=? AND session_id=?
        `).run(this.now(), actionId, ledger.sessionId);
        this.db.prepare("UPDATE m6_action_claims SET status='BLOCKED', updated_at=? WHERE action_id=?").run(this.now(), actionId);
        throw new ControlPlaneError("M6_TCB_CURRENT_STATE_GUARD", "current UI/environment state or guard deadline changed before send", { status: 409 });
      }
      const guardRaw = {
        schemaId: "xw.m6-tcb-current-state-guard.v1",
        actionId,
        operationKey: permit.operationKey,
        decisionRef: permit.decisionRef,
        slotSpecHash: slot.slotSpecHash,
        blockId: permit.target?.kind === "block" ? permit.target.blockId : null,
        boundsRef: slot.boundsRef ?? null,
        appRef: slot.appRef ?? null,
        textRef: slot.textRef ?? null,
        stateHash: currentStateHash,
        privateMaterialHash: privateMaterialBinding.privateMaterialHash,
        privateMaterialBindingHash: privateMaterialBinding.bindingHash,
        guardDelayMs: writeReadyMonoMs - guardStartedMonoMs,
        writeReadyMonoMs,
      };
      const guardReceipt = { ...guardRaw, guardHash: sha256(`xw.m6-tcb-current-state-guard.v1:${canonicalJson(guardRaw)}`) };
      this.db.prepare(`
        UPDATE m6_grounded_action_details SET guard_receipt_json=?, updated_at=? WHERE action_id=?
      `).run(canonicalJson(guardReceipt), this.now(), actionId);
      this.db.prepare(`
        UPDATE device_session_actions SET transport_called=1,
          effect_assessment_json='{"effectStatus":"POSSIBLE_EFFECT"}', updated_at=?
        WHERE action_id=? AND session_id=? AND transport_called=0
      `).run(this.now(), actionId, ledger.sessionId);
      return this.getM6ActionLedger(actionId);
    });
  }

  recordM6ActionTransportOutcome({ actionId, ok, result = {}, errorCode = null }) {
    return this.transaction(() => {
      const ledger = this.getM6ActionLedger(actionId);
      if (!ledger || ledger.status !== "EXECUTING" || ledger.transportCounter !== 1) {
        throw new ControlPlaneError("M6_ACTION_STATE_INVALID", "transport outcome requires an EXECUTING action", { status: 409 });
      }
      const status = ok ? "EXECUTED" : "AMBIGUOUS";
      const effectStatus = ok ? "EFFECT_SENT_PENDING_VERIFY" : "POSSIBLE_EFFECT";
      this.db.prepare(`
        UPDATE m6_grounded_action_details SET transport_result_json=?, updated_at=? WHERE action_id=?
      `).run(canonicalJson(result), this.now(), actionId);
      this.db.prepare(`UPDATE device_session_actions SET status=?, result_json=?, effect_assessment_json=?, error_code=?, updated_at=?
        WHERE action_id=? AND session_id=?`)
        .run(status, canonicalJson(result), canonicalJson({ effectStatus }), errorCode, this.now(), actionId, ledger.sessionId);
      if (!ok) this.db.prepare("UPDATE m6_action_claims SET status='AMBIGUOUS', updated_at=? WHERE action_id=?").run(this.now(), actionId);
      return this.getM6ActionLedger(actionId);
    });
  }

  completeM6GroundedAction({ actionId, afterObservation, verification, receipt }) {
    return this.transaction(() => {
      const ledger = this.getM6ActionLedger(actionId);
      if (!ledger || ledger.status !== "EXECUTED" || ledger.transportCounter !== 1) {
        throw new ControlPlaneError("M6_ACTION_STATE_INVALID", "completion requires an EXECUTED action", { status: 409 });
      }
      if (!afterObservation?.observationId || verification?.ok !== true || receipt?.actionId !== actionId
        || receipt?.operationKey !== ledger.operationKey) {
        throw new ControlPlaneError("M6_ACTION_COMPLETION_INVALID", "after observation, verification, and receipt must agree", { status: 409 });
      }
      this.recordDeviceSessionObservation({ sessionId: ledger.sessionId, observation: afterObservation, mutatingCalls: 0 });
      this.#insertDeviceSessionEvent({
        sessionId: ledger.sessionId,
        type: "observation.captured",
        payload: { observationId: afterObservation.observationId, evidenceRefs: afterObservation.evidenceRefs, mutatingCalls: 0 },
      });
      const completionRaw = {
        schemaId: "xw.m6-grounded-action-completion.v1",
        actionId,
        operationKey: ledger.operationKey,
        afterObservationId: afterObservation.observationId,
        verification,
        receipt,
        transportCounter: 1,
        externalEffect: true,
      };
      const completion = { ...completionRaw, completionHash: sha256(`xw.m6-grounded-action-completion.v1:${canonicalJson(completionRaw)}`) };
      this.db.prepare(`
        UPDATE m6_grounded_action_details SET completion_receipt_json=?, updated_at=? WHERE action_id=?
      `).run(canonicalJson(completion), this.now(), actionId);
      this.db.prepare(`UPDATE device_session_actions SET status='VERIFIED', after_observation_id=?, updated_at=?
        WHERE action_id=? AND session_id=?`).run(afterObservation.observationId, this.now(), actionId, ledger.sessionId);
      this.db.prepare(`UPDATE device_session_actions SET status='COMPLETED', executed=1,
        effect_assessment_json='{"effectStatus":"VERIFIED_EFFECT"}', updated_at=?
        WHERE action_id=? AND session_id=?`).run(this.now(), actionId, ledger.sessionId);
      this.db.prepare("UPDATE m6_action_claims SET status='COMPLETED', updated_at=? WHERE action_id=?").run(this.now(), actionId);
      return this.getM6ActionLedger(actionId);
    });
  }

  abortM6GroundedActionNotSent({ actionId, errorCode }) {
    return this.transaction(() => {
      const ledger = this.getM6ActionLedger(actionId);
      if (!ledger || ledger.transportCounter !== 0 || !["ASSESSED", "EXECUTING"].includes(ledger.status)) {
        throw new ControlPlaneError("M6_ACTION_STATE_INVALID", "only an unsent action may abort without effect", { status: 409 });
      }
      this.db.prepare(`
        UPDATE device_session_actions SET status='BLOCKED', effect_assessment_json='{"effectStatus":"GROUND_ACTION_ABORTED_NOT_SENT"}',
          error_code=?, updated_at=? WHERE action_id=? AND session_id=?
      `).run(errorCode || "M6_ACTION_ABORTED", this.now(), actionId, ledger.sessionId);
      this.db.prepare("UPDATE m6_action_claims SET status='BLOCKED', updated_at=? WHERE action_id=?").run(this.now(), actionId);
      return this.getM6ActionLedger(actionId);
    });
  }

  closeM6GroundedRunActions({ runId, sessionId, reasonCode = "M6_LIVE_RUN_CLOSED" } = {}) {
    if (typeof runId !== "string" || runId === "" || typeof sessionId !== "string" || sessionId === ""
      || typeof reasonCode !== "string" || !/^[A-Z0-9_]{3,96}$/u.test(reasonCode)) {
      throw new ControlPlaneError("M6_ACTION_CLOSE_INPUT_INVALID", "grounded-run action close requires exact run/session/reason refs", { status: 409 });
    }
    return this.transaction(() => {
      const now = this.now();
      this.db.prepare(`
        UPDATE device_session_actions
        SET status=CASE WHEN transport_called=0 THEN 'BLOCKED' ELSE 'AMBIGUOUS' END,
          effect_assessment_json=CASE WHEN transport_called=0
            THEN '{"effectStatus":"GROUND_ACTION_ABORTED_NOT_SENT"}'
            ELSE '{"effectStatus":"POSSIBLE_EFFECT"}' END,
          error_code=COALESCE(error_code, ?), updated_at=?
        WHERE session_id=? AND action_id IN (
          SELECT action_id FROM m6_grounded_action_details WHERE run_id=? AND session_id=?
        ) AND status NOT IN ('COMPLETED','BLOCKED','AMBIGUOUS')
      `).run(reasonCode, now, sessionId, runId, sessionId);
      this.db.prepare(`
        UPDATE m6_action_claims
        SET status=(SELECT a.status FROM device_session_actions a WHERE a.action_id=m6_action_claims.action_id), updated_at=?
        WHERE action_id IN (
          SELECT d.action_id FROM m6_grounded_action_details d
          JOIN device_session_actions a ON a.action_id=d.action_id AND a.session_id=d.session_id
          WHERE d.run_id=? AND d.session_id=? AND a.status IN ('BLOCKED','AMBIGUOUS')
        )
      `).run(now, runId, sessionId);
      return this.listM6ActionLedgersForRun(runId);
    });
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

  getEvidenceRecord(evidenceId) {
    const row = this.db.prepare("SELECT * FROM evidence WHERE evidence_id=?").get(evidenceId);
    return row ? { evidenceId: row.evidence_id, jobId: row.job_id, runId: row.run_id, kind: row.kind, sha256: row.sha256, bytes: row.bytes } : null;
  }

  // Storage-only lookup.  This intentionally is not used by any HTTP response: EvidenceStore
  // needs the relative path to recompute content integrity before a receipt can become lineage.
  getEvidenceRecordInternal(evidenceId) {
    const row = this.db.prepare("SELECT * FROM evidence WHERE evidence_id=?").get(evidenceId);
    return row ? {
      evidenceId: row.evidence_id, jobId: row.job_id, runId: row.run_id, kind: row.kind,
      path: row.path, sha256: row.sha256, bytes: row.bytes,
    } : null;
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

  revokeDelegationGrant(grantId, { reason = "issuer_revoked", actor = null } = {}) {
    const now = this.now();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM delegation_grants WHERE grant_id=?").get(grantId);
      if (!row) throw new ControlPlaneError("GRANT_NOT_FOUND", `unknown delegation grant ${grantId}`, { status: 404 });
      if (row.status === "revoked") return this.#publicDelegationGrant(row);
      this.db.prepare("UPDATE delegation_grants SET status='revoked', updated_at=?, revoked_at=?, revoked_reason=? WHERE grant_id=?")
        .run(now, now, reason, grantId);
      this.#insertDelegationGrantEvent({ grantId, type: "delegation_grant.revoked", payload: { reason, actor }, createdAt: now });
      // Revocation is a durable fence, not merely a future-create denial.  A child Mission
      // cannot retain an owned tuple or a retryable effect once its parent is no longer live.
      const children = this.db.prepare("SELECT * FROM missions WHERE parent_grant_id=? AND status='active'").all(grantId);
      for (const mission of children) {
        this.db.prepare("UPDATE missions SET status='revoked', updated_at=?, revoked_at=?, revoked_reason=? WHERE mission_id=? AND status='active'")
          .run(now, now, `parent_grant:${reason}`, mission.mission_id);
        this.#insertMissionEvent({ missionId: mission.mission_id, type: "mission.parent_grant_revoked", payload: { grantId, reason }, createdAt: now });
        this.db.prepare(`UPDATE mission_effects SET status='cancelled', reservation_released=1, retry_blocked=1, updated_at=?, finished_at=?
          WHERE mission_id=? AND status IN ('pending_authorization', 'waiting_authorization', 'not_sent')`).run(now, now, mission.mission_id);
        this.db.prepare(`UPDATE mission_effects SET status='ambiguous', reservation_consumed=1, reservation_released=0, retry_blocked=1, updated_at=?, finished_at=?
          WHERE mission_id=? AND status IN ('started', 'executing')`).run(now, now, mission.mission_id);
        const runs = this.db.prepare("SELECT * FROM device_runs WHERE mission_id=? AND phase NOT IN ('succeeded','failed','ambiguous','blocked','cancelled','paused_control_lost')").all(mission.mission_id);
        for (const run of runs) {
          const started = this.db.prepare("SELECT 1 FROM mission_effects WHERE device_run_id=? AND status='ambiguous' LIMIT 1").get(run.device_run_id);
          const phase = started ? "ambiguous" : "cancelled";
          this.db.prepare("UPDATE device_runs SET phase=?, outcome=?, updated_at=?, finished_at=? WHERE device_run_id=?")
            .run(phase, "PARENT_GRANT_REVOKED", now, now, run.device_run_id);
          this.db.prepare("DELETE FROM sessions WHERE session_id=? AND lease_id=? AND device_id=?")
            .run(run.session_id, run.lease_id, run.device_id);
          this.db.prepare("DELETE FROM leases WHERE lease_id=? AND device_id=? AND owner_device_run_id=?")
            .run(run.lease_id, run.device_id, run.device_run_id);
          this.#insertMissionEvent({ missionId: mission.mission_id, type: `device_run.${phase}`, payload: { deviceRunId: run.device_run_id, outcome: "PARENT_GRANT_REVOKED", restoreRequired: Boolean(started) }, createdAt: now });
        }
      }
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

  reserveStandingGrantCanary({ idempotencyKey, grantId, sourceJobId }) {
    const now = this.now();
    return this.transaction(() => {
      const byKey = this.db.prepare("SELECT * FROM standing_grant_canaries WHERE idempotency_key=?").get(idempotencyKey);
      if (byKey) return { reused: true, marker: { ...byKey } };
      const existing = this.db.prepare("SELECT * FROM standing_grant_canaries LIMIT 1").get();
      if (existing) throw new ControlPlaneError("CANARY_ALREADY_COMPLETED", "the canary-only first collect has already been attempted", { status: 409 });
      const marker = "standing_grant.first_collect";
      this.db.prepare("INSERT INTO standing_grant_canaries (marker,idempotency_key,grant_id,source_job_id,status,created_at,updated_at) VALUES (?,?,?,?,\'reserved\',?,?)")
        .run(marker, idempotencyKey, grantId, sourceJobId, now, now);
      this.appendEvent({ type: "standing_grant.canary.reserved", payload: { marker, grantId, sourceJobId } });
      return { reused: false, marker: { ...this.db.prepare("SELECT * FROM standing_grant_canaries WHERE marker=?").get(marker) } };
    });
  }

  bindStandingGrantCanary({ missionId, deviceRunId, collectJobId = null }) {
    const now = this.now();
    const result = this.db.prepare("UPDATE standing_grant_canaries SET mission_id=COALESCE(?,mission_id),device_run_id=COALESCE(?,device_run_id),collect_job_id=COALESCE(?,collect_job_id),status=CASE WHEN ? IS NULL THEN status ELSE \'running\' END,updated_at=? WHERE marker=\'standing_grant.first_collect\'")
      .run(missionId, deviceRunId, collectJobId, collectJobId, now);
    if (result.changes !== 1) throw new ControlPlaneError("CANARY_MARKER_MISSING", "Standing Grant canary marker is missing", { status: 409 });
    return this.db.prepare("SELECT * FROM standing_grant_canaries WHERE marker=\'standing_grant.first_collect\'").get();
  }

  releaseStandingGrantCanaryReservation({ idempotencyKey }) {
    const result = this.db.prepare("DELETE FROM standing_grant_canaries WHERE marker='standing_grant.first_collect' AND idempotency_key=? AND status='reserved' AND collect_job_id IS NULL")
      .run(idempotencyKey);
    return { released: result.changes === 1 };
  }

  releaseStandingGrantCanaryNoEffect({ idempotencyKey, outcome }) {
    const now = this.now();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM standing_grant_canaries WHERE marker='standing_grant.first_collect' AND idempotency_key=?").get(idempotencyKey);
      if (!row || ["completed", "ambiguous"].includes(row.status)) return { released: false };
      this.db.prepare("DELETE FROM standing_grant_canaries WHERE marker='standing_grant.first_collect' AND idempotency_key=?").run(idempotencyKey);
      this.appendEvent({ type: "standing_grant.canary.no_effect_released", payload: { outcome: outcome || null, previousStatus: row.status, releasedAt: now } });
      return { released: true };
    });
  }

  finishStandingGrantCanary({ status, outcome }) {
    const allowed = new Set(["completed", "ambiguous", "failed", "blocked"]);
    if (!allowed.has(status)) throw new ControlPlaneError("CANARY_STATUS_INVALID", "invalid Standing Grant canary terminal status", { status: 400 });
    const now = this.now();
    const result = this.db.prepare("UPDATE standing_grant_canaries SET status=?,outcome=?,updated_at=?,finished_at=? WHERE marker=\'standing_grant.first_collect\'")
      .run(status, outcome || null, now, now);
    if (result.changes !== 1) throw new ControlPlaneError("CANARY_MARKER_MISSING", "Standing Grant canary marker is missing", { status: 409 });
    this.appendEvent({ type: `standing_grant.canary.${status}`, payload: { outcome: outcome || null } });
    return this.db.prepare("SELECT * FROM standing_grant_canaries WHERE marker=\'standing_grant.first_collect\'").get();
  }

  getStandingGrantCanary() {
    return this.db.prepare("SELECT * FROM standing_grant_canaries WHERE marker=\'standing_grant.first_collect\'").get() || null;
  }

  clearStandingGrantCanary({ actor, reason } = {}) {
    if (typeof actor !== "string" || actor.trim() === "" || typeof reason !== "string" || reason.trim() === "") {
      throw new ControlPlaneError("CANARY_CLEAR_INVALID", "canary clear actor and reason are required", { status: 400 });
    }
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM standing_grant_canaries WHERE marker='standing_grant.first_collect'").get();
      if (!row) return { cleared: false };
      if (!row.finished_at) throw new ControlPlaneError("CANARY_CLEAR_INVALID", "an in-flight canary marker cannot be cleared", { status: 409 });
      this.db.prepare("DELETE FROM standing_grant_canaries WHERE marker='standing_grant.first_collect'").run();
      this.appendEvent({ type: "standing_grant.canary.cleared", payload: { actor: actor.trim(), reason: reason.trim(), previousStatus: row.status } });
      return { cleared: true };
    });
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

  recordExplicitObservationReceipt(input) {
    const now = this.now();
    const observedAt = Date.parse(input?.observedAt);
    if (!Number.isFinite(observedAt) || now < observedAt || now - observedAt > 5000) {
      return { status: "rejected_stale" };
    }
    const required = ["grantId", "grantHash", "missionId", "deviceRunId", "leaseId", "sessionId", "app", "accountFingerprint", "pageFingerprint", "targetFingerprint", "evidenceId", "evidenceHash", "sourceJobId", "sourceRunId", "sourceAdapterId", "sourceCapabilityId"];
    if (required.some((key) => typeof input?.[key] !== "string" || input[key] === "") || !Number.isInteger(input?.controllerEpoch)) {
      throw new ControlPlaneError("EXPLICIT_RECEIPT_INVALID", "explicit receipt fields are incomplete", { status: 400 });
    }
    return this.transaction(() => {
      const grant = this.db.prepare("SELECT * FROM delegation_grants WHERE grant_id=?").get(input.grantId);
      const mission = this.db.prepare("SELECT * FROM missions WHERE mission_id=?").get(input.missionId);
      const run = this.db.prepare("SELECT * FROM device_runs WHERE device_run_id=?").get(input.deviceRunId);
      const session = this.db.prepare("SELECT * FROM sessions WHERE session_id=?").get(input.sessionId);
      const lease = this.db.prepare("SELECT * FROM leases WHERE lease_id=?").get(input.leaseId);
      const evidence = this.db.prepare("SELECT * FROM evidence WHERE evidence_id=?").get(input.evidenceId);
      const sourceJob = this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(input.sourceJobId);
      const sourceCapability = parseJson(sourceJob?.capability_json, {});
      const grantValidity = parseJson(grant?.grant_json, {}).validity || {};
      const missionValidity = parseJson(mission?.policy_json, {}).validity || {};
      const parentNotBefore = Date.parse(grantValidity.notBefore);
      const parentExpiry = Date.parse(grantValidity.expiresAt);
      const childNotBefore = Date.parse(missionValidity.notBefore);
      const childExpiry = Date.parse(missionValidity.expiresAt);
      if (!grant || grant.status !== "active" || grant.grant_hash !== input.grantHash || !mission
        || mission.status !== "active" || mission.parent_grant_id !== input.grantId || mission.parent_grant_hash !== input.grantHash
        || !run || run.mission_id !== input.missionId || run.session_id !== input.sessionId || run.lease_id !== input.leaseId
        || run.controller_epoch !== input.controllerEpoch || !session || session.lease_id !== input.leaseId
        || !lease || lease.owner_device_run_id !== input.deviceRunId || evidence?.sha256 !== input.evidenceHash
        || !sourceJob || sourceJob.status !== "succeeded" || sourceJob.run_id !== input.sourceRunId || sourceJob.device_id !== run.device_id || sourceJob.session_id !== input.sessionId
        || sourceJob.capability_id !== input.sourceCapabilityId || sourceCapability.implementation?.adapter !== input.sourceAdapterId
        || evidence.job_id !== input.sourceJobId || evidence.run_id !== input.sourceRunId
        || (Number.isFinite(parentNotBefore) && now < parentNotBefore) || (Number.isFinite(parentExpiry) && now >= parentExpiry)
        || (Number.isFinite(childNotBefore) && now < childNotBefore) || (Number.isFinite(childExpiry) && now >= childExpiry)) {
        throw new ControlPlaneError("EXPLICIT_RECEIPT_BINDING_MISMATCH", "receipt is not bound to a live control-plane tuple", { status: 409 });
      }
      const policy = parseJson(mission.policy_json, {});
      if (policy.app !== input.app || policy.account !== input.accountFingerprint || !policy.scope?.targets?.values?.includes(input.targetFingerprint)) {
        throw new ControlPlaneError("EXPLICIT_RECEIPT_SCOPE_MISMATCH", "receipt is outside Mission authority", { status: 409 });
      }
      const receiptHash = fingerprint({ grantId: input.grantId, grantHash: input.grantHash, missionId: input.missionId, deviceRunId: input.deviceRunId, leaseId: input.leaseId, sessionId: input.sessionId, controllerEpoch: input.controllerEpoch, app: input.app, accountFingerprint: input.accountFingerprint, pageFingerprint: input.pageFingerprint, targetFingerprint: input.targetFingerprint, observedAt, evidenceId: input.evidenceId, evidenceHash: input.evidenceHash, sourceJobId: input.sourceJobId, sourceRunId: input.sourceRunId, sourceAdapterId: input.sourceAdapterId, sourceCapabilityId: input.sourceCapabilityId });
      const existing = this.db.prepare("SELECT * FROM explicit_observation_receipts WHERE receipt_hash=?").get(receiptHash);
      if (existing) return { receiptId: existing.receipt_id, receiptHash, status: existing.status, reused: true };
      const receiptId = newId("explicit_receipt");
      this.db.prepare(`INSERT INTO explicit_observation_receipts (receipt_id, receipt_hash, grant_id, grant_hash, mission_id, device_run_id, lease_id, session_id, controller_epoch, app, account_fingerprint, page_fingerprint, target_fingerprint, observed_at, server_received_at, evidence_id, evidence_hash, source_job_id, source_run_id, source_adapter_id, source_capability_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded', ?)`)
        .run(receiptId, receiptHash, input.grantId, input.grantHash, input.missionId, input.deviceRunId, input.leaseId, input.sessionId, input.controllerEpoch, input.app, input.accountFingerprint, input.pageFingerprint, input.targetFingerprint, observedAt, now, input.evidenceId, input.evidenceHash, input.sourceJobId, input.sourceRunId, input.sourceAdapterId, input.sourceCapabilityId, now);
      return { receiptId, receiptHash, status: "recorded", reused: false };
    });
  }

  consumeExplicitObservationReceipt({ receiptId, missionId, deviceRunId, leaseId, sessionId, controllerEpoch, action, targetFingerprint }) {
    const now = this.now();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM explicit_observation_receipts WHERE receipt_id=?").get(receiptId);
      const grant = row && this.db.prepare("SELECT status, grant_hash, grant_json FROM delegation_grants WHERE grant_id=?").get(row.grant_id);
      const mission = row && this.db.prepare("SELECT parent_grant_id, parent_grant_hash, status, policy_json FROM missions WHERE mission_id=?").get(row.mission_id);
      const run = row && this.db.prepare("SELECT mission_id, session_id, lease_id, controller_epoch, phase FROM device_runs WHERE device_run_id=?").get(row.device_run_id);
      const session = row && this.db.prepare("SELECT lease_id FROM sessions WHERE session_id=?").get(row.session_id);
      const lease = row && this.db.prepare("SELECT owner_device_run_id FROM leases WHERE lease_id=?").get(row.lease_id);
      if (!row || row.status !== "recorded" || now - row.server_received_at > 5000
        || row.mission_id !== missionId || row.device_run_id !== deviceRunId || row.lease_id !== leaseId || row.session_id !== sessionId || row.controller_epoch !== controllerEpoch || row.target_fingerprint !== targetFingerprint) {
        throw new ControlPlaneError("EXPLICIT_RECEIPT_INVALID", "receipt is stale, replayed, or not bound to this effect", { status: 409 });
      }
      if (!grant || grant.status !== "active" || grant.grant_hash !== row.grant_hash
        || !mission || mission.status !== "active" || mission.parent_grant_id !== row.grant_id || mission.parent_grant_hash !== row.grant_hash
        || !run || run.mission_id !== row.mission_id || run.session_id !== row.session_id || run.lease_id !== row.lease_id || run.controller_epoch !== row.controller_epoch || run.phase !== "running"
        || !session || session.lease_id !== row.lease_id || !lease || lease.owner_device_run_id !== row.device_run_id
        || (Number.isFinite(Date.parse(parseJson(grant.grant_json, {}).validity?.notBefore)) && now < Date.parse(parseJson(grant.grant_json, {}).validity.notBefore))
        || (Number.isFinite(Date.parse(parseJson(grant.grant_json, {}).validity?.expiresAt)) && now >= Date.parse(parseJson(grant.grant_json, {}).validity.expiresAt))
        || (Number.isFinite(Date.parse(parseJson(mission.policy_json, {}).validity?.notBefore)) && now < Date.parse(parseJson(mission.policy_json, {}).validity.notBefore))
        || (Number.isFinite(Date.parse(parseJson(mission.policy_json, {}).validity?.expiresAt)) && now >= Date.parse(parseJson(mission.policy_json, {}).validity.expiresAt))) {
        throw new ControlPlaneError("EXPLICIT_RECEIPT_INVALID", "receipt lost live parent or control tuple authority", { status: 409 });
      }
      this.db.prepare("UPDATE explicit_observation_receipts SET status='consumed', used_at=? WHERE receipt_id=? AND status='recorded'").run(now, receiptId);
      return { receiptId, action, targetFingerprint, evidenceId: row.evidence_id, evidenceHash: row.evidence_hash };
    });
  }

  getExplicitObservationReceipt(receiptId) {
    const row = this.db.prepare("SELECT * FROM explicit_observation_receipts WHERE receipt_id=?").get(receiptId);
    return row ? {
      receiptId: row.receipt_id, receiptHash: row.receipt_hash, missionId: row.mission_id,
      deviceRunId: row.device_run_id, leaseId: row.lease_id, sessionId: row.session_id,
      controllerEpoch: row.controller_epoch, app: row.app, accountFingerprint: row.account_fingerprint,
      pageFingerprint: row.page_fingerprint, targetFingerprint: row.target_fingerprint,
      observedAt: iso(row.observed_at), serverReceivedAt: iso(row.server_received_at),
      evidenceId: row.evidence_id, evidenceHash: row.evidence_hash, status: row.status,
      sourceJobId: row.source_job_id, sourceRunId: row.source_run_id, sourceAdapterId: row.source_adapter_id, sourceCapabilityId: row.source_capability_id,
    } : null;
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
  addProtectedCommit({
    commitId, missionId, effectId, action, targetHash,
    status = "waiting_authorization", approvalBinding = null, expiresAt = null,
  }) {
    if (!commitId || !missionId || !effectId || !action || !targetHash) {
      throw new TypeError("commitId, missionId, effectId, action, targetHash are required");
    }
    const now = this.now();
    const bindingJson = approvalBinding ? canonicalJson(approvalBinding) : null;
    const expiresMs = expiresAt ? Date.parse(expiresAt) : null;
    this.db.prepare(`
      INSERT INTO protected_commits
        (commit_id, mission_id, effect_id, action, target_hash, status, created_at, updated_at, approval_binding_json, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(commitId, missionId, effectId, action, targetHash, status, now, now, bindingJson, expiresMs);
    return this.getProtectedCommit(commitId);
  }

  getProtectedCommit(commitId) {
    const row = this.db.prepare("SELECT * FROM protected_commits WHERE commit_id=?").get(commitId);
    if (!row) return null;
    return this.#publicProtectedCommit(row);
  }

  listProtectedCommits({ missionId = null, status = null, action = null } = {}) {
    let sql = "SELECT * FROM protected_commits";
    const conditions = [];
    const params = [];
    if (missionId) { conditions.push("mission_id=?"); params.push(missionId); }
    if (status) { conditions.push("status=?"); params.push(status); }
    if (action) { conditions.push("action=?"); params.push(action); }
    if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += " ORDER BY created_at";
    return this.db.prepare(sql).all(...params).map((row) => this.#publicProtectedCommit(row));
  }

  // REX Phase 2 收尾: terminal decisions retain the audit row instead of deleting it. The live
  // prepared handle is gone either way; the durable row stays as the auditable record of the
  // human's per-commit decision (approved/denied/expired/recovered_cancelled).
  setProtectedCommitStatus(commitId, status) {
    const now = this.now();
    this.db.prepare(
      "UPDATE protected_commits SET status=?, updated_at=? WHERE commit_id=?",
    ).run(status, now, commitId);
    return this.getProtectedCommit(commitId);
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
      expiresAt: row.expires_at != null ? iso(row.expires_at) : null,
      approvalBinding: parseJson(row.approval_binding_json, null),
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

  // --- Direct-routine plan V2 §7: server-hard routine effect ledger ----------
  //
  // Enforced in the same SQLite transaction as the slot reservation. There is
  // deliberately NO softScope/softBudget/debtSink parameter on this path: the
  // nonpayment-autonomy policyMode must never be able to soften a routine
  // budget into a debt (§7.3). The absolute per-action caps (like<=1,
  // comment<=2) are re-validated here so even a mis-wired bridge caller cannot
  // raise them.

  static ROUTINE_BUDGET_ABSOLUTE_CAPS = Object.freeze({ like: 1, comment: 2 });

  #publicRoutineEffect(row) {
    if (!row) return null;
    return {
      effectId: row.effect_id,
      routineRunId: row.routine_run_id,
      planHash: row.plan_hash,
      idempotencyKey: row.idempotency_key,
      action: row.action,
      targetFingerprint: row.target_hash,
      observationHash: row.observation_hash,
      payloadHash: row.payload_hash,
      intent: parseJson(row.intent_json, {}),
      status: row.status,
      reservationConsumed: Boolean(row.reservation_consumed),
      retryBlocked: Boolean(row.retry_blocked),
      evidenceRefs: parseJson(row.evidence_refs_json, []),
      accountFingerprint: row.account_fingerprint ?? null,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      finishedAt: row.finished_at ? iso(row.finished_at) : null,
    };
  }

  beginRoutineEffect({ routineRunId, planHash, action, targetFingerprint, observationHash = null, payloadHash = null, intent = {}, idempotencyKey, budget, accountFingerprint = null }) {
    if (!routineRunId || !planHash || !action || !targetFingerprint || !idempotencyKey) {
      throw new TypeError("routineRunId, planHash, action, targetFingerprint, idempotencyKey are required");
    }
    if (!budget || budget.mode !== "hard") {
      throw new ControlPlaneError("ROUTINE_BUDGET_MODE_HARD_REQUIRED", "routine effect budget must be mode=hard (soft budgets have no path here)", { status: 400 });
    }
    const cap = budget.actions?.[action];
    if (!cap || !Number.isInteger(cap.max) || cap.max < 0 || !Number.isInteger(cap.perTarget) || cap.perTarget < 0) {
      throw new ControlPlaneError("ROUTINE_BUDGET_ACTION_UNKNOWN", `no hard budget configured for routine action ${action}`, { status: 400 });
    }
    const absolute = StateStore.ROUTINE_BUDGET_ABSOLUTE_CAPS[action];
    if (absolute === undefined) {
      throw new ControlPlaneError("ROUTINE_BUDGET_ACTION_UNKNOWN", `routine action ${action} has no schema cap`, { status: 400 });
    }
    if (cap.max > absolute) {
      throw new ControlPlaneError("ROUTINE_BUDGET_CAP_EXCEEDED", `routine budget max for ${action} exceeds the schema cap ${absolute}`, { status: 400 });
    }
    const now = this.now();
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM routine_effects WHERE idempotency_key=?").get(idempotencyKey);
      if (existing) return { effect: this.#publicRoutineEffect(existing), reused: true };
      const closed = this.db.prepare("SELECT reason FROM routine_run_closures WHERE routine_run_id=? AND action=?").get(routineRunId, action);
      if (closed) {
        throw new ControlPlaneError("ROUTINE_ACTION_CLOSED", `action ${action} is closed for this routine run (${closed.reason})`, { status: 409 });
      }
      const blockedRetry = this.db.prepare(`
        SELECT effect_id FROM routine_effects
        WHERE routine_run_id=? AND action=? AND target_hash=? AND retry_blocked=1
        LIMIT 1
      `).get(routineRunId, action, targetFingerprint);
      if (blockedRetry) {
        throw new ControlPlaneError("AMBIGUOUS_NO_RETRY", "an ambiguous routine effect for this target cannot be retried", {
          status: 409, details: { effectId: blockedRetry.effect_id },
        });
      }
      // a slot stays consumed once transported: reserved/verified/ambiguous all
      // count against max; only a pre-transport stop (not_sent/cancelled) releases
      const live = this.db.prepare(`
        SELECT target_hash FROM routine_effects
        WHERE routine_run_id=? AND action=? AND status NOT IN ('not_sent','cancelled')
      `).all(routineRunId, action);
      if (live.length >= cap.max) {
        throw new ControlPlaneError("ROUTINE_BUDGET_EXCEEDED", `routine hard budget for ${action} (max ${cap.max}) is exhausted`, { status: 409 });
      }
      if (live.filter((row) => row.target_hash === targetFingerprint).length >= cap.perTarget) {
        throw new ControlPlaneError("ROUTINE_BUDGET_PER_TARGET_EXCEEDED", `routine hard per-target budget for ${action} is exhausted`, { status: 409 });
      }
      const effectId = newId("routine-effect");
      this.db.prepare(`
        INSERT INTO routine_effects (
          effect_id, routine_run_id, plan_hash, idempotency_key, action, target_hash,
          observation_hash, payload_hash, intent_json, status, account_fingerprint, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)
      `).run(
        effectId, routineRunId, planHash, idempotencyKey, action, targetFingerprint,
        observationHash, payloadHash, canonicalJson(redactEffectIntent(intent)), accountFingerprint ?? null, now, now,
      );
      return { effect: this.#publicRoutineEffect(this.db.prepare("SELECT * FROM routine_effects WHERE effect_id=?").get(effectId)), reused: false };
    });
  }

  recordRoutineEffectOutcome(effectId, { status, evidenceRefs = [] } = {}) {
    if (!["verified", "ambiguous", "not_sent", "cancelled"].includes(status)) {
      throw new TypeError("unsupported routine effect outcome");
    }
    const now = this.now();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM routine_effects WHERE effect_id=?").get(effectId);
      if (!row) throw new ControlPlaneError("ROUTINE_EFFECT_NOT_FOUND", `unknown routine effect ${effectId}`, { status: 404 });
      // ambiguous consumes its slot (§7.6) — only a pre-transport stop releases it
      const consumed = status !== "not_sent" && status !== "cancelled";
      const retryBlocked = status === "ambiguous";
      this.db.prepare(`
        UPDATE routine_effects SET
          status=?, reservation_consumed=?, retry_blocked=?, evidence_refs_json=?,
          updated_at=?, finished_at=?
        WHERE effect_id=?
      `).run(status, consumed ? 1 : 0, retryBlocked ? 1 : 0, canonicalJson(evidenceRefs), now, now, effectId);
      return this.#publicRoutineEffect(this.db.prepare("SELECT * FROM routine_effects WHERE effect_id=?").get(effectId));
    });
  }

  closeRoutineRunAction({ routineRunId, action, reason }) {
    if (!routineRunId || !action || !reason) {
      throw new TypeError("routineRunId, action, reason are required");
    }
    this.db.prepare(`
      INSERT INTO routine_run_closures (routine_run_id, action, reason, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(routine_run_id, action) DO NOTHING
    `).run(routineRunId, action, reason, this.now());
  }

  isRoutineRunActionClosed(routineRunId, action) {
    return Boolean(this.db.prepare("SELECT 1 FROM routine_run_closures WHERE routine_run_id=? AND action=?").get(routineRunId, action));
  }

  listRoutineEffects(routineRunId) {
    return this.db.prepare(
      "SELECT * FROM routine_effects WHERE routine_run_id=? ORDER BY created_at, effect_id",
    ).all(routineRunId).map((row) => this.#publicRoutineEffect(row));
  }

  // --- Direct-routine plan V2 §8: grounded comment chain storage -------------
  // Receipts/drafts/reconciles are durable and server-sealed: bound_send only
  // ever accepts a draftId that the SERVER stored, never caller-supplied text.

  recordNoteContextReceipt({ receiptHash, routineRunId, planHash, targetFingerprint, detailStateVersion, accountFingerprint = null, pageFingerprint = null, titleExcerpt = null, bodyExcerpt = null, commentDigest = [], evidenceHashes = [], observedAt }) {
    const receiptId = newId("ncr");
    const now = this.now();
    // content-addressed per (run, target): re-observing identical note state
    // within the same run+target is idempotent (bound_send re-check
    // re-observes); the same content bound to another target is its own receipt
    this.db.prepare(`
      INSERT OR IGNORE INTO note_context_receipts (
        receipt_id, receipt_hash, routine_run_id, plan_hash, target_fingerprint,
        detail_state_version, account_fingerprint, page_fingerprint,
        title_excerpt, body_excerpt, comment_digest_json, evidence_hashes_json,
        observed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId, receiptHash, routineRunId, planHash, targetFingerprint,
      detailStateVersion, accountFingerprint, pageFingerprint,
      titleExcerpt, bodyExcerpt, canonicalJson(commentDigest), canonicalJson(evidenceHashes),
      observedAt, now,
    );
    const row = this.db.prepare("SELECT * FROM note_context_receipts WHERE receipt_hash=? AND routine_run_id=? AND target_fingerprint=?").get(receiptHash, routineRunId, targetFingerprint);
    if (!row) return null;
    return {
      receiptId: row.receipt_id,
      receiptHash: row.receipt_hash,
      routineRunId: row.routine_run_id,
      planHash: row.plan_hash,
      targetFingerprint: row.target_fingerprint,
      detailStateVersion: row.detail_state_version,
      accountFingerprint: row.account_fingerprint,
      pageFingerprint: row.page_fingerprint,
      titleExcerpt: row.title_excerpt,
      bodyExcerpt: row.body_excerpt,
      commentDigest: parseJson(row.comment_digest_json, []),
      evidenceHashes: parseJson(row.evidence_hashes_json, []),
      observedAt: row.observed_at,
    };
  }

  getNoteContextReceipt(receiptHash) {
    const row = this.db.prepare("SELECT * FROM note_context_receipts WHERE receipt_hash=?").get(receiptHash);
    if (!row) return null;
    return {
      receiptId: row.receipt_id,
      receiptHash: row.receipt_hash,
      routineRunId: row.routine_run_id,
      planHash: row.plan_hash,
      targetFingerprint: row.target_fingerprint,
      detailStateVersion: row.detail_state_version,
      accountFingerprint: row.account_fingerprint,
      pageFingerprint: row.page_fingerprint,
      titleExcerpt: row.title_excerpt,
      bodyExcerpt: row.body_excerpt,
      commentDigest: parseJson(row.comment_digest_json, []),
      evidenceHashes: parseJson(row.evidence_hashes_json, []),
      observedAt: row.observed_at,
    };
  }

  recordCommentDraft(draft) {
    const now = this.now();
    this.db.prepare(`
      INSERT INTO comment_drafts (
        draft_id, draft_hash, receipt_hash, routine_run_id, plan_hash, target_fingerprint,
        detail_state_version, text, text_hash, source_observation_hash, evidence_refs_json,
        model_id, prompt_hash, risk_flags_json, validation_json, status, account_fingerprint, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sealed', ?, ?, ?, ?)
    `).run(
      draft.draftId, draft.draftHash, draft.receiptHash, draft.routineRunId, draft.planHash,
      draft.targetFingerprint, draft.detailStateVersion, draft.text, draft.textHash,
      draft.sourceObservationHash, canonicalJson(draft.evidenceRefs ?? []), draft.modelId ?? null,
      draft.promptHash ?? null, canonicalJson(draft.riskFlags ?? []), canonicalJson(draft.validation ?? {}),
      draft.accountFingerprint ?? null, draft.expiresAt, now, now,
    );
    return this.getCommentDraft(draft.draftId);
  }

  getCommentDraft(draftId) {
    const row = this.db.prepare("SELECT * FROM comment_drafts WHERE draft_id=?").get(draftId);
    if (!row) return null;
    return {
      draftId: row.draft_id,
      draftHash: row.draft_hash,
      receiptHash: row.receipt_hash,
      routineRunId: row.routine_run_id,
      planHash: row.plan_hash,
      targetFingerprint: row.target_fingerprint,
      detailStateVersion: row.detail_state_version,
      text: row.text,
      textHash: row.text_hash,
      sourceObservationHash: row.source_observation_hash,
      evidenceRefs: parseJson(row.evidence_refs_json, []),
      modelId: row.model_id,
      promptHash: row.prompt_hash,
      riskFlags: parseJson(row.risk_flags_json, []),
      validation: parseJson(row.validation_json, {}),
      status: row.status,
      accountFingerprint: row.account_fingerprint ?? null,
      expiresAt: row.expires_at,
    };
  }

  setCommentDraftStatus(draftId, status) {
    if (!["sealed", "consumed", "invalidated"].includes(status)) {
      throw new TypeError("unsupported comment draft status");
    }
    this.db.prepare("UPDATE comment_drafts SET status=?, updated_at=? WHERE draft_id=?")
      .run(status, this.now(), draftId);
    return this.getCommentDraft(draftId);
  }

  recordCommentReconcile({ effectId, routineRunId, status, evidenceHash = null }) {
    if (!["verified_late", "unresolved_final"].includes(status)) {
      throw new TypeError("unsupported comment reconcile status");
    }
    // append-only: a new row per reconcile — the original ambiguous effect row
    // is never rewritten and the slot is never restored
    const reconcileId = newId("reconcile");
    this.db.prepare(`
      INSERT INTO comment_reconciles (reconcile_id, effect_id, routine_run_id, status, evidence_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(reconcileId, effectId, routineRunId, status, evidenceHash, this.now());
    return { reconcileId, effectId, routineRunId, status, evidenceHash };
  }

  listCommentReconciles(effectId) {
    return this.db.prepare("SELECT * FROM comment_reconciles WHERE effect_id=? ORDER BY created_at").all(effectId);
  }

  // --- Direct-routine plan V2 §8.1: CP-owned routine authority ---------------
  // Every social routine run registers ONE immutable authority tuple before any
  // device work. The server seals the canary policy: a client --canary-authorized
  // flag is only a request — the transport only opens for an authority whose
  // server-sealed policy granted it, and the absolute caps (alias 03, like<=1,
  // comment<=2) are re-validated here so even a mis-wired bridge caller cannot
  // raise them.

  static ROUTINE_AUTHORITY_ALIAS = "03";

  #publicRoutineAuthority(row) {
    if (!row) return null;
    return {
      authorityId: row.authority_id,
      executionRunId: row.execution_run_id,
      routineRunId: row.routine_run_id,
      planHash: row.plan_hash,
      alias: row.alias,
      deviceId: row.device_id,
      sessionId: row.session_id,
      leaseId: row.lease_id,
      actorId: row.actor_id,
      effectCaps: parseJson(row.effect_caps_json, {}),
      canaryAuthorized: Boolean(row.canary_authorized),
      canaryPolicy: parseJson(row.canary_policy_json, null),
      status: row.status,
      accountFingerprint: row.account_fingerprint ?? null,
      createdAt: iso(row.created_at),
      closedAt: row.closed_at ? iso(row.closed_at) : null,
      closedReason: row.closed_reason ?? null,
    };
  }

  registerRoutineAuthority({ executionRunId, routineRunId, planHash, alias, deviceId, sessionId, leaseId, actorId, effectCaps = {}, canaryAuthorized = false, accountFingerprint = null }) {
    if (!executionRunId || !routineRunId || !planHash || !deviceId || !sessionId || !leaseId || !actorId) {
      throw new ControlPlaneError("ROUTINE_AUTHORITY_INVALID", "authority tuple fields are required", { status: 400 });
    }
    if (alias !== StateStore.ROUTINE_AUTHORITY_ALIAS) {
      throw new ControlPlaneError("ROUTINE_AUTHORITY_ALIAS_FORBIDDEN", `routine social authority is 03-only (got ${alias})`, { status: 403 });
    }
    if (canaryAuthorized !== true && canaryAuthorized !== false) {
      throw new ControlPlaneError("ROUTINE_AUTHORITY_INVALID", "canaryAuthorized must be a boolean request", { status: 400 });
    }
    // absolute caps re-validated server-side (§8.1.2): the client cannot raise them
    const absolute = StateStore.ROUTINE_BUDGET_ABSOLUTE_CAPS;
    const sealedCaps = {};
    for (const action of Object.keys(absolute)) {
      const requested = Number(effectCaps?.[action] ?? absolute[action]);
      if (!Number.isInteger(requested) || requested < 0 || requested > absolute[action]) {
        throw new ControlPlaneError("ROUTINE_AUTHORITY_CAP_EXCEEDED", `requested cap for ${action} exceeds the absolute routine cap ${absolute[action]}`, { status: 400 });
      }
      sealedCaps[action] = requested;
    }
    const now = this.now();
    return this.transaction(() => {
      // one immutable authority per routineRunId — a re-registration is a replay
      const existing = this.db.prepare("SELECT * FROM routine_authorities WHERE routine_run_id=?").get(routineRunId);
      if (existing) return { authority: this.#publicRoutineAuthority(existing), reused: true };
      // at most one active routine authority per session (§8.1.1)
      const active = this.db.prepare(
        "SELECT authority_id FROM routine_authorities WHERE session_id=? AND status='active'",
      ).get(sessionId);
      if (active) {
        throw new ControlPlaneError("ROUTINE_AUTHORITY_SESSION_ACTIVE", "this session already holds an active routine authority", {
          status: 409, details: { authorityId: active.authority_id },
        });
      }
      const authorityId = newId("routine-auth");
      // server-sealed canary policy: the client flag is only a request; the
      // grant lives here and the typed effect RPC re-checks it before transport
      const canaryPolicy = canaryAuthorized
        ? {
            granted: true,
            sealedAt: iso(now),
            transport: { like: sealedCaps.like, comment: sealedCaps.comment },
            visualTap: 0, // vision navigation is authorized by the vision permit chain, never by this policy
            planHash,
            alias,
          }
        : { granted: false, sealedAt: iso(now), transport: { like: 0, comment: 0 }, visualTap: 0, planHash, alias };
      const canaryPolicyJson = canonicalJson({ ...canaryPolicy, policyHash: sha256(canonicalJson(canaryPolicy)) });
      this.db.prepare(`
        INSERT INTO routine_authorities (
          authority_id, execution_run_id, routine_run_id, plan_hash, alias, device_id,
          session_id, lease_id, actor_id, effect_caps_json, canary_authorized,
          canary_policy_json, status, account_fingerprint, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(
        authorityId, executionRunId, routineRunId, planHash, alias, deviceId,
        sessionId, leaseId, actorId, canonicalJson(sealedCaps), canaryAuthorized ? 1 : 0,
        canaryPolicyJson, accountFingerprint, now,
      );
      return { authority: this.#publicRoutineAuthority(this.db.prepare("SELECT * FROM routine_authorities WHERE authority_id=?").get(authorityId)), reused: false };
    });
  }

  getRoutineAuthority(authorityId) {
    return this.#publicRoutineAuthority(
      this.db.prepare("SELECT * FROM routine_authorities WHERE authority_id=?").get(String(authorityId || "")),
    );
  }

  closeRoutineAuthority(authorityId, { reason = "released" } = {}) {
    const now = this.now();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM routine_authorities WHERE authority_id=?").get(String(authorityId || ""));
      if (!row) throw new ControlPlaneError("ROUTINE_AUTHORITY_NOT_FOUND", `unknown routine authority ${authorityId}`, { status: 404 });
      if (row.status === "active") {
        this.db.prepare("UPDATE routine_authorities SET status='closed', closed_at=?, closed_reason=? WHERE authority_id=?")
          .run(now, String(reason), authorityId);
      }
      return this.#publicRoutineAuthority(this.db.prepare("SELECT * FROM routine_authorities WHERE authority_id=?").get(authorityId));
    });
  }

  listActiveRoutineAuthorities() {
    return this.db.prepare("SELECT * FROM routine_authorities WHERE status='active' ORDER BY created_at")
      .all().map((row) => this.#publicRoutineAuthority(row));
  }

  // --- Mission effects (ECP) -------------------------------------------------

  // REX Phase 5 §8.4 (P5b): softBudget (set by the ledger under nonpayment_v1) turns an
  // exhausted count/frequency budget into a durable budget_debt instead of throwing — a
  // non-payment social effect past its budget is debt, not a hard block. Legacy default false
  // keeps the BUDGET_* gates fail-closed byte-for-byte.
  beginMissionEffect({ mission, deviceRunId, action, targetHash, intent = {}, idempotencyKey, status = "started", softScope = false, softBudget = false, debtSink = null }) {
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
        // REX Phase 5 §8.4 (P5b): nonpayment_v1 soft-scope effects (out-of-scope action/target)
        // become durable soft-budget reservations instead of scope violations. Default false =
        // legacy fail-closed. Only the ledger's non-payment soft path sets softScope; payment is
        // always PHC and never reaches here soft, so the financial gate is untouched.
        if (!softScope) {
          throw new ControlPlaneError("SCOPE_VIOLATION", "effect action or target is outside Mission scope", { status: 409 });
        }
      }
      const live = this.db.prepare(`
        SELECT action, target_hash, created_at FROM mission_effects
        WHERE mission_id=? AND reservation_released=0
      `).all(mission.missionId);
      const totalCount = Number(mission.scope.totalCount || 0);
      const perTargetCount = Number(mission.scope.perTargetCount || 0);
      const frequency = mission.scope.frequency || {};
      const frequencyCount = Number(frequency.count || 0);
      const windowMs = Number(frequency.windowSeconds || 0) * 1000;
      let budgetCode = null;
      if (totalCount > 0 && live.length >= totalCount) budgetCode = "BUDGET_EXCEEDED";
      else if (perTargetCount > 0 && live.filter((row) => row.target_hash === targetHash).length >= perTargetCount) budgetCode = "BUDGET_PER_TARGET_EXCEEDED";
      else if (frequencyCount > 0 && windowMs > 0 && live.filter((row) => row.created_at >= now - windowMs).length >= frequencyCount) budgetCode = "BUDGET_THROTTLED";
      if (budgetCode && !softBudget) {
        throw new ControlPlaneError(budgetCode, "Mission budget is exhausted", { status: 409 });
      }
      if (budgetCode && softBudget) {
        // REX P5b: exhausted count/frequency budget under nonpayment_v1 is a soft-budget debt,
        // not a block — the reservation still proceeds so the non-payment effect may run.
        if (typeof debtSink === "function") {
          debtSink({
            kind: "budget_debt",
            missionId: mission.missionId,
            code: budgetCode,
            action,
            targetHash,
            createdAt: new Date().toISOString(),
          });
        }
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

  startPreparedMissionEffect(effectId) {
    const now = this.now();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM mission_effects WHERE effect_id=?").get(effectId);
      if (!row) throw new ControlPlaneError("EFFECT_NOT_FOUND", `unknown effect ${effectId}`, { status: 404 });
      if (row.status !== "not_sent" || row.reservation_released) {
        throw new ControlPlaneError("EFFECT_START_INVALID", "effect cannot start from its current state", { status: 409 });
      }
      this.db.prepare("UPDATE mission_effects SET status='started', updated_at=?, finished_at=NULL WHERE effect_id=?").run(now, effectId);
      this.#insertMissionEvent({ missionId: row.mission_id, type: "effect.started", payload: { effectId }, createdAt: now });
      return this.#publicMissionEffect(this.db.prepare("SELECT * FROM mission_effects WHERE effect_id=?").get(effectId));
    });
  }

  // Used by pre-send ECP fencing as well as the final send boundary.  It can release only the
  // tuple still owned by this DeviceRun; a foreign lease/session is never touched.
  terminalizeMissionEffectAuthorityLoss({ effectId, missionId, deviceRunId, leaseId, sessionId, controllerEpoch, code }) {
    const now = this.now();
    return this.transaction(() => {
      const effect = this.db.prepare("SELECT * FROM mission_effects WHERE effect_id=?").get(effectId);
      const run = this.db.prepare("SELECT * FROM device_runs WHERE device_run_id=?").get(deviceRunId);
      const lease = this.db.prepare("SELECT * FROM leases WHERE lease_id=?").get(leaseId);
      if (!effect || effect.mission_id !== missionId || effect.device_run_id !== deviceRunId) {
        throw new ControlPlaneError("EFFECT_BINDING_MISMATCH", "effect is not bound to this DeviceRun", { status: 409 });
      }
      this.db.prepare("UPDATE mission_effects SET status='cancelled', reservation_released=1, retry_blocked=1, updated_at=?, finished_at=? WHERE effect_id=? AND status IN ('not_sent','pending_authorization','waiting_authorization')")
        .run(now, now, effectId);
      this.#insertMissionEvent({ missionId, type: "effect.cancelled", payload: { effectId, reason: code }, createdAt: now });
      const ownsTuple = run && run.mission_id === missionId && run.session_id === sessionId && run.lease_id === leaseId
        && run.controller_epoch === controllerEpoch && lease?.owner_device_run_id === deviceRunId;
      if (ownsTuple) {
        this.db.prepare("UPDATE device_runs SET phase='cancelled', outcome=?, updated_at=?, finished_at=? WHERE device_run_id=? AND phase NOT IN ('succeeded','failed','ambiguous','blocked','cancelled','paused_control_lost')")
          .run(code, now, now, deviceRunId);
        this.db.prepare("DELETE FROM sessions WHERE session_id=? AND lease_id=? AND device_id=?").run(sessionId, leaseId, run.device_id);
        this.db.prepare("DELETE FROM leases WHERE lease_id=? AND device_id=? AND owner_device_run_id=?").run(leaseId, run.device_id, deviceRunId);
        this.#insertMissionEvent({ missionId, type: "device_run.cancelled", payload: { deviceRunId, outcome: code, released: true }, createdAt: now });
      }
      return this.#publicMissionEffect(this.db.prepare("SELECT * FROM mission_effects WHERE effect_id=?").get(effectId));
    });
  }

  // This is the final synchronous boundary before an external effect: no await, callback, or
  // file I/O may intervene between the durable authority/receipt re-read and effect_started.
  beginMissionEffectSend({ effectId, receiptId = null, missionId, deviceRunId, leaseId, sessionId, controllerEpoch, targetFingerprint, softAuthority = false }) {
    let authorityError = null;
    const result = this.transaction(() => {
      const now = this.now();
      const effect = this.db.prepare("SELECT * FROM mission_effects WHERE effect_id=?").get(effectId);
      if (!effect || effect.mission_id !== missionId || effect.device_run_id !== deviceRunId || effect.status !== "not_sent" || effect.reservation_released) {
        throw new ControlPlaneError("EFFECT_START_INVALID", "effect is not a live not_sent reservation for this run", { status: 409 });
      }
      const receipt = receiptId ? this.db.prepare("SELECT * FROM explicit_observation_receipts WHERE receipt_id=?").get(receiptId) : null;
      const mission = this.db.prepare("SELECT * FROM missions WHERE mission_id=?").get(missionId);
      const grant = mission && this.db.prepare("SELECT * FROM delegation_grants WHERE grant_id=?").get(mission.parent_grant_id);
      const run = this.db.prepare("SELECT * FROM device_runs WHERE device_run_id=?").get(deviceRunId);
      const session = this.db.prepare("SELECT * FROM sessions WHERE session_id=?").get(sessionId);
      const lease = this.db.prepare("SELECT * FROM leases WHERE lease_id=?").get(leaseId);
      const grantValidity = parseJson(grant?.grant_json, {}).validity || {};
      const missionValidity = parseJson(mission?.policy_json, {}).validity || {};
      let authorityCode = null;
      if (!grant || grant.status !== "active") authorityCode = "PARENT_GRANT_INACTIVE";
      else if (!mission || mission.status !== "active") authorityCode = mission?.status === "revoked" ? "MISSION_REVOKED" : "MISSION_INACTIVE";
      else if (grant.grant_hash !== mission.parent_grant_hash) authorityCode = "PARENT_GRANT_HASH_DRIFT";
      else if (Number.isFinite(Date.parse(grantValidity.notBefore)) && now < Date.parse(grantValidity.notBefore)) authorityCode = "PARENT_GRANT_NOT_YET_VALID";
      else if (Number.isFinite(Date.parse(grantValidity.expiresAt)) && now >= Date.parse(grantValidity.expiresAt)) authorityCode = "PARENT_GRANT_EXPIRED";
      else if (Number.isFinite(Date.parse(missionValidity.notBefore)) && now < Date.parse(missionValidity.notBefore)) authorityCode = "MISSION_NOT_YET_VALID";
      else if (Number.isFinite(Date.parse(missionValidity.expiresAt)) && now >= Date.parse(missionValidity.expiresAt)) authorityCode = "MISSION_EXPIRED";
      // REX Phase 5 §8.4 (P5b): nonpayment_v1 (softAuthority) treats a decayed provenance or
      // budget fence (PARENT_GRANT_* / MISSION_EXPIRED) as soft context — the send proceeds and
      // the ECP already recorded the provenance_debt / budget_debt. MISSION_REVOKED /
      // MISSION_NOT_YET_VALID and any legacy call (softAuthority=false) still cancel the
      // reservation and fail closed.
      if (authorityCode && !(softAuthority === true && isSoftBudgetAuthority(authorityCode))) {
        this.db.prepare("UPDATE mission_effects SET status='cancelled', reservation_released=1, retry_blocked=1, updated_at=?, finished_at=? WHERE effect_id=? AND status='not_sent'")
          .run(now, now, effectId);
        this.#insertMissionEvent({ missionId, type: "effect.cancelled", payload: { effectId, reason: authorityCode }, createdAt: now });
        if (run && run.session_id === sessionId && run.lease_id === leaseId && run.controller_epoch === controllerEpoch) {
          this.db.prepare("UPDATE device_runs SET phase='cancelled', outcome=?, updated_at=?, finished_at=? WHERE device_run_id=? AND phase NOT IN ('succeeded','failed','ambiguous','blocked','cancelled','paused_control_lost')")
            .run(authorityCode, now, now, deviceRunId);
          this.db.prepare("DELETE FROM sessions WHERE session_id=? AND lease_id=? AND device_id=?").run(sessionId, leaseId, run.device_id);
          this.db.prepare("DELETE FROM leases WHERE lease_id=? AND device_id=? AND owner_device_run_id=?").run(leaseId, run.device_id, deviceRunId);
          this.#insertMissionEvent({ missionId, type: "device_run.cancelled", payload: { deviceRunId, outcome: authorityCode, released: true }, createdAt: now });
        }
        authorityError = authorityCode;
        return null;
      }
      if (!run || run.mission_id !== missionId || run.session_id !== sessionId || run.lease_id !== leaseId || run.controller_epoch !== controllerEpoch || run.phase !== "running"
        || !session || session.lease_id !== leaseId || !lease || lease.owner_device_run_id !== deviceRunId) {
        throw new ControlPlaneError("EXPLICIT_RECEIPT_INVALID", "effect control tuple is no longer owned", { status: 409 });
      }
      if (receipt) {
        const evidence = this.db.prepare("SELECT * FROM evidence WHERE evidence_id=?").get(receipt.evidence_id);
        const sourceJob = this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(receipt.source_job_id);
        const sourceCapability = parseJson(sourceJob?.capability_json, {});
        if (receipt.status !== "recorded" || now - receipt.server_received_at > 5000 || receipt.mission_id !== missionId || receipt.device_run_id !== deviceRunId
          || receipt.lease_id !== leaseId || receipt.session_id !== sessionId || receipt.controller_epoch !== controllerEpoch || receipt.target_fingerprint !== targetFingerprint
          || receipt.grant_id !== grant?.grant_id || receipt.grant_hash !== grant?.grant_hash || evidence?.sha256 !== receipt.evidence_hash
          || !sourceJob || sourceJob.status !== "succeeded" || sourceJob.run_id !== receipt.source_run_id || sourceJob.session_id !== sessionId
          || sourceJob.device_id !== run.device_id || sourceJob.capability_id !== receipt.source_capability_id || sourceCapability.implementation?.adapter !== receipt.source_adapter_id
          || evidence.job_id !== sourceJob.job_id || evidence.run_id !== sourceJob.run_id) {
          throw new ControlPlaneError("EXPLICIT_RECEIPT_INVALID", "receipt lost its durable provenance or tuple binding", { status: 409 });
        }
        this.db.prepare("UPDATE explicit_observation_receipts SET status='consumed', used_at=? WHERE receipt_id=? AND status='recorded'").run(now, receiptId);
      }
      this.db.prepare("UPDATE mission_effects SET status='started', updated_at=?, finished_at=NULL WHERE effect_id=? AND status='not_sent'").run(now, effectId);
      this.#insertMissionEvent({ missionId, type: "effect.started", payload: { effectId, ...(receiptId ? { receiptId } : {}) }, createdAt: now });
      return this.#publicMissionEffect(this.db.prepare("SELECT * FROM mission_effects WHERE effect_id=?").get(effectId));
    });
    if (authorityError) throw new ControlPlaneError(authorityError, "live Mission authority was lost before send", { status: 409 });
    return result;
  }

  retryNotSentMissionEffect(effectId) {
    const now = this.now();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM mission_effects WHERE effect_id=?").get(effectId);
      if (!row) throw new ControlPlaneError("EFFECT_NOT_FOUND", `unknown effect ${effectId}`, { status: 404 });
      if (row.status !== "not_sent" || row.reservation_released) {
        throw new ControlPlaneError("EFFECT_RETRY_UNSAFE", "only a reserved not_sent effect may retry", { status: 409 });
      }
      this.db.prepare("UPDATE mission_effects SET updated_at=?, finished_at=NULL WHERE effect_id=?").run(now, effectId);
      this.#insertMissionEvent({
        missionId: row.mission_id,
        type: "effect.retry_reserved",
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

  #assertLiveDiscoveryAuthority(row, gates) {
    const grantRow = this.db.prepare("SELECT * FROM delegation_grants WHERE grant_id=?").get(row.grant_id);
    if (!grantRow || grantRow.status !== "active") {
      throw new ControlPlaneError("GRANT_NOT_ACTIVE", "DiscoveryRun Grant is no longer active", { status: 409 });
    }
    if (grantRow.grant_hash !== row.grant_hash) {
      throw new ControlPlaneError("GRANT_HASH_DRIFT", "DiscoveryRun Grant hash drifted", { status: 409 });
    }
    let grant;
    try { grant = parseJson(grantRow.grant_json, {}); } catch { throw new ControlPlaneError("GRANT_POLICY_INVALID", "DiscoveryRun Grant is malformed", { status: 409 }); }
    const policy = grant.discoveryPolicy;
    if (!policy || policy.enabled !== true) {
      throw new ControlPlaneError("DISCOVERY_POLICY_DISABLED", "DiscoveryPolicy is not enabled", { status: 409 });
    }
    if (policy.maxParallelism !== 1) {
      throw new ControlPlaneError("PARALLELISM_UNSUPPORTED", "DiscoveryPolicy parallelism must be one", { status: 409 });
    }
    if (fingerprint(policy) !== row.policy_hash) {
      throw new ControlPlaneError("DISCOVERY_POLICY_DRIFT", "DiscoveryPolicy changed after allocation", { status: 409 });
    }
    if (!gates?.missionAutoApprovalEnabled || !gates?.standingGrantEnabled
      || !gates?.adr0008Accepted || !gates?.adr0010Accepted || !gates?.issuerReady) {
      throw new ControlPlaneError("DISCOVERY_GATE_CLOSED", "DiscoveryRun gate is closed", { status: 409 });
    }
  }

  #terminalizeDiscoveryFailure(row, error, now) {
    const terminalStatus = ["DISCOVERY_CONTROL_LOST", "DISCOVERY_READINESS_LOST"].includes(error.code)
      ? "recovery_required"
      : "aborted";
    this.#releaseDiscoveryRun(row, terminalStatus, now, error.code);
    return error;
  }

  #releaseDiscoveryRun(row, terminalStatus, now, reason = null) {
    const tupleHashes = {
      discoveryRunId: fingerprint(row.discovery_run_id),
      sessionId: fingerprint(row.session_id),
      leaseId: fingerprint(row.lease_id),
      controllerEpoch: fingerprint(String(row.controller_epoch)),
    };
    const transition = this.db.prepare(`
      UPDATE discovery_runs SET status=?, release_at=?, released_tuple_hashes_json=?, updated_at=?
      WHERE discovery_run_id=? AND status IN ('running', 'sealing')
    `).run(terminalStatus, now, canonicalJson(tupleHashes), now, row.discovery_run_id);
    if (transition.changes === 0) {
      return this.#publicDiscoveryRun(this.db.prepare("SELECT * FROM discovery_runs WHERE discovery_run_id=?").get(row.discovery_run_id));
    }
    // A terminal run may clean only the exact Session it created. The lease predicate
    // prevents a stale run row from deleting a subsequently-owned foreign lease.
    this.db.prepare("DELETE FROM sessions WHERE session_id=? AND lease_id=? AND device_id=?")
      .run(row.session_id, row.lease_id, row.device_id);
    this.db.prepare("DELETE FROM leases WHERE lease_id=? AND device_id=? AND owner_discovery_run_id=?")
      .run(row.lease_id, row.device_id, row.discovery_run_id);
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
      this.#assertOrdinaryM6ResourceAllowedNoTransaction();
      const grantRow = this.db.prepare("SELECT * FROM delegation_grants WHERE grant_id=?").get(grantId);
      if (!grantRow || grantRow.status !== "active") throw new ControlPlaneError("GRANT_NOT_ACTIVE", "DiscoveryRun requires an active Grant", { status: 409 });
      if (grantRow.grant_hash !== grantHash) throw new ControlPlaneError("GRANT_HASH_DRIFT", "DiscoveryRun Grant hash drifted", { status: 409 });
      const activeForGrant = this.db.prepare(
        "SELECT discovery_run_id FROM discovery_runs WHERE grant_id=? AND status IN ('running', 'sealing')",
      ).get(grantId);
      if (activeForGrant) {
        throw new ControlPlaneError("DISCOVERY_GRANT_ACTIVE", "Grant already owns an active DiscoveryRun", { status: 409 });
      }
      let grant;
      try { grant = parseJson(grantRow.grant_json, {}); } catch { throw new ControlPlaneError("GRANT_POLICY_INVALID", "DiscoveryRun Grant is malformed", { status: 409 }); }
      const policy = grant.discoveryPolicy;
      if (!policy || policy.enabled !== true) throw new ControlPlaneError("DISCOVERY_POLICY_DISABLED", "DiscoveryPolicy is not enabled", { status: 409 });
      if (policy.maxParallelism !== 1) throw new ControlPlaneError("PARALLELISM_UNSUPPORTED", "DiscoveryPolicy parallelism must be one", { status: 409 });
      if (!gates.missionAutoApprovalEnabled || !gates.standingGrantEnabled
        || !gates.adr0008Accepted || !gates.adr0010Accepted || !gates.issuerReady) {
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
        INSERT INTO sessions (session_id, lease_id, actor_id, device_id, token_hash, canary, scope_capability_id, placement_decision_json, created_at, expires_at, session_kind)
        VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, 'discovery')
      `).run(sessionId, leaseId, controllerAgent, selected.deviceId, sha256(token), canonicalJson({ mode: placementRequest.mode, decision: "dispatchable", selectedDeviceId: selected.deviceId, source: "discovery" }), now, now + ttlMs);
      if (faultAfter === "afterSession") throw new ControlPlaneError("DISCOVERY_OPEN_FAULT", "injected DiscoveryRun open fault", { status: 500 });
      this.db.prepare(`
        INSERT INTO discovery_runs (
          discovery_run_id, grant_id, grant_hash, device_id, session_id, lease_id, controller_agent, controller_epoch, status,
          policy_hash, policy_json, opened_at, deadline_at, max_primitives, max_candidates, max_parallelism, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'running', ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(discoveryRunId, grantId, grantHash, selected.deviceId, sessionId, leaseId, controllerAgent, fingerprint(policy), canonicalJson(policy), now, deadlineAt, policy.defaults.maxPrimitives, policy.defaults.maxCandidates, now, now);
      if (faultAfter === "afterRun") throw new ControlPlaneError("DISCOVERY_OPEN_FAULT", "injected DiscoveryRun open fault", { status: 500 });
      this.#insertDiscoveryEvent({ discoveryRunId, type: "discovery_run.opened", payload: { grantId, grantHash, deviceId: selected.deviceId, controllerEpoch: 1 }, createdAt: now });
      return this.#publicDiscoveryRun(this.db.prepare("SELECT * FROM discovery_runs WHERE discovery_run_id=?").get(discoveryRunId), token);
    });
  }

  getDiscoveryRun(discoveryRunId) {
    return this.#publicDiscoveryRun(this.db.prepare("SELECT * FROM discovery_runs WHERE discovery_run_id=?").get(discoveryRunId));
  }

  getDiscoveryRunForSession(sessionId) {
    return this.#publicDiscoveryRun(this.db.prepare("SELECT * FROM discovery_runs WHERE session_id=?").get(sessionId));
  }

  listDiscoveryEvents(discoveryRunId) {
    return this.db.prepare("SELECT * FROM discovery_events WHERE discovery_run_id=? ORDER BY event_id").all(discoveryRunId)
      .map((row) => ({ type: row.type, payload: parseJson(row.payload_json, {}), createdAt: iso(row.created_at) }));
  }

  bindDiscoveryReservationJob({ discoveryRunId, reservationId, tuple, job, gates = {} }) {
    const now = this.now();
    const result = this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM discovery_runs WHERE discovery_run_id=?").get(discoveryRunId);
      if (!row) throw new ControlPlaneError("DISCOVERY_RUN_NOT_FOUND", "unknown DiscoveryRun", { status: 404 });
      try {
        this.#assertDiscoveryRunOwnership(row, tuple, now);
        this.#assertLiveDiscoveryAuthority(row, gates);
        const reservation = this.db.prepare("SELECT * FROM discovery_reservations WHERE reservation_id=? AND discovery_run_id=? AND kind='primitive'").get(reservationId, discoveryRunId);
        if (!reservation || job?.sessionId !== row.session_id || job?.deviceId !== row.device_id) {
          throw new ControlPlaneError("DISCOVERY_JOB_BINDING_INVALID", "job is not bound to this Discovery reservation tuple", { status: 409 });
        }
        if (reservation.source_job_id && (reservation.source_job_id !== job.jobId || reservation.source_run_id !== job.runId)) {
          throw new ControlPlaneError("DISCOVERY_JOB_BINDING_CONFLICT", "reservation is already bound to another source job", { status: 409 });
        }
        this.db.prepare("UPDATE discovery_reservations SET source_job_id=?, source_run_id=?, status='dispatched', updated_at=? WHERE reservation_id=?")
          .run(job.jobId, job.runId, now, reservationId);
        this.#insertDiscoveryEvent({ discoveryRunId, type: "discovery_primitive.dispatched", payload: { reservationId, jobId: job.jobId }, createdAt: now });
        return true;
      } catch (error) { return { error: this.#terminalizeDiscoveryFailure(row, error, now) }; }
    });
    if (result?.error) throw result.error;
    return result;
  }

  recordDiscoveryProducerReceipt({ discoveryRunId, reservationId, tuple, job, evidence, receipt, gates = {} }) {
    const now = this.now();
    const result = this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM discovery_runs WHERE discovery_run_id=?").get(discoveryRunId);
      if (!row) throw new ControlPlaneError("DISCOVERY_RUN_NOT_FOUND", "unknown DiscoveryRun", { status: 404 });
      try {
        this.#assertDiscoveryRunOwnership(row, tuple, now);
        this.#assertLiveDiscoveryAuthority(row, gates);
        const reservation = this.db.prepare("SELECT * FROM discovery_reservations WHERE reservation_id=? AND discovery_run_id=? AND kind='primitive'").get(reservationId, discoveryRunId);
        const source = this.db.prepare("SELECT job_id, run_id, session_id, device_id FROM jobs WHERE job_id=?").get(job?.jobId);
        const storedEvidence = this.getEvidenceRecord(evidence?.evidenceId);
        if (!reservation || !source || !storedEvidence
          || reservation.source_job_id !== job.jobId || reservation.source_run_id !== job.runId
          || source.session_id !== row.session_id || source.device_id !== row.device_id
          || storedEvidence.jobId !== job.jobId || storedEvidence.runId !== job.runId
          || storedEvidence.sha256 !== evidence.sha256) {
          throw new ControlPlaneError("DISCOVERY_RECEIPT_BINDING_INVALID", "producer receipt does not match the reserved source job", { status: 409 });
        }
        const existing = this.db.prepare("SELECT * FROM discovery_producer_receipts WHERE reservation_id=?").get(reservationId);
        const receiptHash = fingerprint(receipt);
        if (existing) {
          if (existing.evidence_hash !== evidence.sha256 || fingerprint(parseJson(existing.receipt_json, {})) !== receiptHash) {
            throw new ControlPlaneError("DISCOVERY_RECEIPT_CONFLICT", "producer attempted to replace immutable receipt", { status: 409 });
          }
          return { receiptId: existing.receipt_id, evidenceId: existing.evidence_id, evidenceHash: existing.evidence_hash, ...parseJson(existing.receipt_json, {}) };
        }
        const receiptId = newId("discovery_receipt");
        this.db.prepare("INSERT INTO discovery_producer_receipts (receipt_id, reservation_id, discovery_run_id, session_id, controller_epoch, source_job_id, source_run_id, evidence_id, evidence_hash, receipt_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(receiptId, reservationId, discoveryRunId, row.session_id, row.controller_epoch, job.jobId, job.runId, evidence.evidenceId, evidence.sha256, canonicalJson(receipt), now);
        this.db.prepare("UPDATE discovery_reservations SET receipt_id=?, status='completed', updated_at=? WHERE reservation_id=?").run(receiptId, now, reservationId);
        this.#insertDiscoveryEvent({ discoveryRunId, type: "discovery_primitive.receipt_recorded", payload: { reservationId, receiptId, jobId: job.jobId }, createdAt: now });
        return { receiptId, evidenceId: evidence.evidenceId, evidenceHash: evidence.sha256, ...receipt };
      } catch (error) { return { error: this.#terminalizeDiscoveryFailure(row, error, now) }; }
    });
    if (result?.error) throw result.error;
    return result;
  }

  getDiscoveryProducerReceiptForReservation(reservationId) {
    const row = this.db.prepare("SELECT * FROM discovery_producer_receipts WHERE reservation_id=?").get(reservationId);
    return row ? { receiptId: row.receipt_id, discoveryRunId: row.discovery_run_id, reservationId: row.reservation_id, sessionId: row.session_id, controllerEpoch: row.controller_epoch, sourceJobId: row.source_job_id, sourceRunId: row.source_run_id, evidenceId: row.evidence_id, evidenceHash: row.evidence_hash, ...parseJson(row.receipt_json, {}) } : null;
  }

  getDiscoveryProducerReceipt(receiptId) {
    const row = this.db.prepare("SELECT * FROM discovery_producer_receipts WHERE receipt_id=?").get(receiptId);
    return row ? { receiptId: row.receipt_id, discoveryRunId: row.discovery_run_id, reservationId: row.reservation_id, sessionId: row.session_id, controllerEpoch: row.controller_epoch, sourceJobId: row.source_job_id, sourceRunId: row.source_run_id, evidenceId: row.evidence_id, evidenceHash: row.evidence_hash, ...parseJson(row.receipt_json, {}) } : null;
  }

  ingestDiscoveryObservation(raw) {
    const allowedFields = new Set([
      "discoveryRunId", "tuple", "gates", "receiptId",
    ]);
    if (!raw || typeof raw !== "object" || Object.keys(raw).some((key) => !allowedFields.has(key))) {
      throw new ControlPlaneError("DISCOVERY_INGEST_INPUT_INVALID", "Discovery ingestion accepts only an opaque producer receipt", { status: 400 });
    }
    const receipt = this.getDiscoveryProducerReceipt(raw.receiptId);
    if (!receipt || receipt.discoveryRunId !== raw.discoveryRunId) {
      throw new ControlPlaneError("DISCOVERY_RECEIPT_INVALID", "Discovery receipt is absent or belongs to another run", { status: 409 });
    }
    const input = {
      ...raw,
      evidenceId: receipt.evidenceId, evidenceHash: receipt.evidenceHash,
      reservationId: receipt.reservationId, sourceJobId: receipt.sourceJobId, sourceRunId: receipt.sourceRunId,
      recorder: receipt.recorder, sourceHash: receipt.sourceHash, contentHash: receipt.contentHash,
      snapshotHash: receipt.snapshotHash, app: receipt.app, accountFingerprint: receipt.accountFingerprint,
      pageFingerprint: receipt.pageFingerprint, observedTargetFingerprint: receipt.observedTargetFingerprint,
      identityEvidenceHash: receipt.identityEvidenceHash, anchor: receipt.anchor, relationKind: receipt.relationKind,
      relationEvidenceId: receipt.evidenceId, relationEvidenceHash: receipt.evidenceHash, observedAt: receipt.observedAt,
    };
    const now = this.now();
    const result = this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM discovery_runs WHERE discovery_run_id=?").get(input.discoveryRunId);
      if (!row) throw new ControlPlaneError("DISCOVERY_RUN_NOT_FOUND", "unknown DiscoveryRun", { status: 404 });
      try {
        this.#assertDiscoveryRunOwnership(row, input.tuple, now);
        this.#assertLiveDiscoveryAuthority(row, input.gates);
      } catch (error) {
        return { error: this.#terminalizeDiscoveryFailure(row, error, now) };
      }
      const evidence = this.getEvidenceRecord(input.evidenceId);
      const reservation = this.db.prepare("SELECT * FROM discovery_reservations WHERE reservation_id=? AND discovery_run_id=? AND kind='primitive'")
        .get(input.reservationId, row.discovery_run_id);
      if (!evidence || evidence.sha256 !== input.evidenceHash || evidence.runId !== input.sourceRunId
        || !reservation || reservation.receipt_id !== raw.receiptId
        || reservation.source_job_id !== input.sourceJobId || reservation.source_run_id !== input.sourceRunId) {
        throw new ControlPlaneError("DISCOVERY_EVIDENCE_INVALID", "Discovery observation evidence is not authoritative", { status: 409 });
      }
      const hashes = ["sourceHash", "contentHash", "snapshotHash", "identityEvidenceHash", "evidenceHash", "relationEvidenceHash"];
      if (hashes.some((name) => typeof input[name] !== "string" || !/^[a-f0-9]{64}$/i.test(input[name]))) {
        throw new ControlPlaneError("DISCOVERY_LINEAGE_INVALID", "Discovery observation needs complete hash-only lineage", { status: 409 });
      }
      if (input.relationEvidenceId !== input.evidenceId || input.relationEvidenceHash !== input.evidenceHash) {
        throw new ControlPlaneError("DISCOVERY_RELATION_EVIDENCE_INVALID", "relation evidence must bind the observed evidence", { status: 409 });
      }
      const policy = parseJson(row.policy_json, {});
      const scope = policy.targetScope || {};
      const allowedPairs = {
        searchQueryHash: new Set(["search_result"]),
        seedIdentityFingerprint: new Set(["seed_profile_relation"]),
        contentContextHash: new Set(["content_author", "content_mentioned_profile"]),
        identityFingerprint: new Set(["explicit_target"]),
      };
      const allowedAnchor = scope.anchors?.some((anchor) => anchor.type === input.anchor?.type && anchor.hash === input.anchor?.hash);
      if (!allowedAnchor || scope.maxHops !== 1 || !scope.relationKinds?.includes(input.relationKind)
        || !allowedPairs[input.anchor?.type]?.has(input.relationKind)) {
        throw new ControlPlaneError("DISCOVERY_ANCHOR_RELATION_INVALID", "observation is outside signed one-hop authority", { status: 409 });
      }
      const recordHash = fingerprint({ ...input, tuple: undefined });
      const existing = this.db.prepare("SELECT record_hash FROM discovery_observation_lineage WHERE snapshot_hash=?").get(input.snapshotHash);
      if (existing) {
        if (existing.record_hash === recordHash) return { reused: true, snapshotHash: input.snapshotHash, evidenceHash: input.evidenceHash };
        this.#insertDiscoveryEvent({ discoveryRunId: row.discovery_run_id, type: "discovery_observation.conflict", payload: { snapshotHash: fingerprint(input.snapshotHash) }, createdAt: now });
        return { error: new ControlPlaneError("AUTHORITATIVE_OBSERVATION_CONFLICT", "Discovery observation conflicts with immutable lineage", { status: 409 }) };
      }
      if (row.candidate_count >= row.max_candidates) {
        throw new ControlPlaneError("DISCOVERY_CANDIDATE_BUDGET_EXHAUSTED", "DiscoveryRun candidate quota exhausted", { status: 409 });
      }
      const candidateKey = `observation:${input.snapshotHash}`;
      const candidatePayloadHash = fingerprint({ candidateHash: input.observedTargetFingerprint, anchor: input.anchor, relationKind: input.relationKind, relationEvidenceId: input.relationEvidenceId, relationEvidenceHash: input.relationEvidenceHash });
      const candidate = this.db.prepare("SELECT * FROM discovery_reservations WHERE discovery_run_id=? AND kind='candidate' AND idempotency_key=?").get(row.discovery_run_id, candidateKey);
      if (candidate && candidate.payload_hash !== candidatePayloadHash) {
        throw new ControlPlaneError("DISCOVERY_IDEMPOTENCY_CONFLICT", "observation candidate replay changed", { status: 409 });
      }
      if (!candidate) {
        this.db.prepare("INSERT INTO discovery_reservations (reservation_id, discovery_run_id, kind, idempotency_key, payload_hash, status, created_at, updated_at) VALUES (?, ?, 'candidate', ?, ?, 'intent_recorded', ?, ?)")
          .run(newId("discovery_candidate"), row.discovery_run_id, candidateKey, candidatePayloadHash, now, now);
        this.db.prepare("UPDATE discovery_runs SET candidate_count=candidate_count+1, updated_at=? WHERE discovery_run_id=? AND status='running'").run(now, row.discovery_run_id);
      }
      this.db.prepare("INSERT INTO authoritative_observations (snapshot_hash, app, account_fingerprint, page_fingerprint, observed_target_fingerprint, identity_evidence_hash, observed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(input.snapshotHash, input.app, input.accountFingerprint, input.pageFingerprint, input.observedTargetFingerprint, input.identityEvidenceHash, Date.parse(input.observedAt), now);
      this.db.prepare("INSERT INTO discovery_observation_lineage (snapshot_hash, discovery_run_id, session_id, controller_agent, controller_epoch, source_job_id, source_run_id, evidence_id, evidence_hash, recorder, record_hash, source_hash, content_hash, anchor_json, relation_kind, relation_evidence_id, relation_evidence_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(input.snapshotHash, row.discovery_run_id, row.session_id, row.controller_agent, row.controller_epoch, input.sourceJobId, input.sourceRunId, input.evidenceId, input.evidenceHash, input.recorder, recordHash, input.sourceHash, input.contentHash, canonicalJson(input.anchor), input.relationKind, input.relationEvidenceId, input.relationEvidenceHash, now);
      this.#insertDiscoveryEvent({ discoveryRunId: row.discovery_run_id, type: "discovery_observation.recorded", payload: { snapshotHash: fingerprint(input.snapshotHash) }, createdAt: now });
      return { reused: false, snapshotHash: input.snapshotHash, evidenceHash: input.evidenceHash };
    });
    if (result?.error) throw result.error;
    return result;
  }

  listDiscoveryRuns({ status = null } = {}) {
    const rows = status
      ? this.db.prepare("SELECT * FROM discovery_runs WHERE status=? ORDER BY created_at").all(status)
      : this.db.prepare("SELECT * FROM discovery_runs ORDER BY created_at").all();
    return rows.map((row) => this.#publicDiscoveryRun(row));
  }

  reserveDiscoveryPrimitiveStorage({ discoveryRunId, tuple, token, gates = {}, primitive, idempotencyKey, payloadHash }) {
    if (typeof primitive !== "string" || typeof idempotencyKey !== "string" || typeof payloadHash !== "string") {
      throw new ControlPlaneError("DISCOVERY_INPUT_INVALID", "primitive idempotencyKey and payloadHash are required", { status: 400 });
    }
    const now = this.now();
    const result = this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM discovery_runs WHERE discovery_run_id=?").get(discoveryRunId);
      if (!row) throw new ControlPlaneError("DISCOVERY_RUN_NOT_FOUND", "unknown DiscoveryRun", { status: 404 });
      try {
        this.#assertDiscoveryRunOwnership(row, tuple, now);
        this.#assertLiveDiscoveryAuthority(row, gates);
        const session = this.db.prepare("SELECT token_hash FROM sessions WHERE session_id=?").get(row.session_id);
        if (!session || session.token_hash !== sha256(token || "")) {
          throw new ControlPlaneError("SESSION_TOKEN_INVALID", "DiscoveryRun session token is invalid", { status: 403 });
        }
        const policy = parseJson(row.policy_json, {});
        if (!Array.isArray(policy.allowedPrimitives) || !policy.allowedPrimitives.includes(primitive)) {
          throw new ControlPlaneError("DISCOVERY_PRIMITIVE_FORBIDDEN", "primitive is not signed DiscoveryPolicy authority", { status: 403 });
        }
      } catch (error) {
        return { error: this.#terminalizeDiscoveryFailure(row, error, now) };
      }
      const existing = this.db.prepare("SELECT * FROM discovery_reservations WHERE discovery_run_id=? AND kind='primitive' AND idempotency_key=?")
        .get(discoveryRunId, idempotencyKey);
      if (existing) {
        if (existing.payload_hash !== payloadHash) {
          throw new ControlPlaneError("DISCOVERY_IDEMPOTENCY_CONFLICT", "primitive idempotency key has different payload", { status: 409 });
        }
        return { reservationId: existing.reservation_id, reused: true };
      }
      // A fully-authorized exact retry must never be charged or terminalized merely because
      // a concurrent new request consumed the final quota. New work is checked only after the
      // exact reservation lookup, while a changed replay still conflicts above.
      if (now >= row.deadline_at) {
        throw new ControlPlaneError("DISCOVERY_DEADLINE_EXCEEDED", "DiscoveryRun deadline elapsed", { status: 409 });
      }
      if (row.primitive_count >= row.max_primitives) {
        throw new ControlPlaneError("DISCOVERY_PRIMITIVE_BUDGET_EXHAUSTED", "DiscoveryRun primitive quota exhausted", { status: 409 });
      }
      const reservationId = newId("discovery_primitive");
      this.db.prepare(`
        INSERT INTO discovery_reservations (reservation_id, discovery_run_id, kind, idempotency_key, payload_hash, status, created_at, updated_at)
        VALUES (?, ?, 'primitive', ?, ?, 'intent_recorded', ?, ?)
      `).run(reservationId, discoveryRunId, idempotencyKey, payloadHash, now, now);
      this.db.prepare("UPDATE discovery_runs SET primitive_count=primitive_count+1, updated_at=? WHERE discovery_run_id=? AND status='running'")
        .run(now, discoveryRunId);
      this.#insertDiscoveryEvent({ discoveryRunId, type: "discovery_primitive.intent_recorded", payload: { primitive, reservationId }, createdAt: now });
      return { reservationId, reused: false };
    });
    if (result?.error) throw result.error;
    return { ...result, discoveryRunId, primitive };
  }

  reserveDiscoveryCandidateStorage({ discoveryRunId, tuple, token, gates = {}, idempotencyKey, candidateHash, anchor, relationKind, relationEvidenceId, relationEvidenceHash }) {
    const now = this.now();
    const result = this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM discovery_runs WHERE discovery_run_id=?").get(discoveryRunId);
      if (!row) throw new ControlPlaneError("DISCOVERY_RUN_NOT_FOUND", "unknown DiscoveryRun", { status: 404 });
      try {
        this.#assertDiscoveryRunOwnership(row, tuple, now); this.#assertLiveDiscoveryAuthority(row, gates);
        const session = this.db.prepare("SELECT token_hash FROM sessions WHERE session_id=?").get(row.session_id);
        if (!session || session.token_hash !== sha256(token || "")) throw new ControlPlaneError("SESSION_TOKEN_INVALID", "DiscoveryRun session token is invalid", { status: 403 });
        const relationEvidence = this.getEvidenceRecord(relationEvidenceId);
        if (!relationEvidence || relationEvidence.sha256 !== relationEvidenceHash || relationEvidence.runId !== row.discovery_run_id) {
          throw new ControlPlaneError("DISCOVERY_RELATION_EVIDENCE_INVALID", "candidate relation evidence is not bound to this DiscoveryRun", { status: 409 });
        }
        const policy = parseJson(row.policy_json, {}); const scope = policy.targetScope || {};
        const allowedPairs = {
          searchQueryHash: new Set(["search_result"]),
          seedIdentityFingerprint: new Set(["seed_profile_relation"]),
          contentContextHash: new Set(["content_author", "content_mentioned_profile"]),
          identityFingerprint: new Set(["explicit_target"]),
        };
        const allowed = Array.isArray(scope.anchors) && scope.anchors.some((item) => item.type === anchor?.type && item.hash === anchor?.hash)
          && Array.isArray(scope.relationKinds) && scope.relationKinds.includes(relationKind) && scope.maxHops === 1;
        if (!allowed || !allowedPairs[anchor?.type]?.has(relationKind)) throw new ControlPlaneError("DISCOVERY_ANCHOR_RELATION_INVALID", "candidate is outside signed one-hop authority", { status: 409 });
      } catch (error) { return { error: this.#terminalizeDiscoveryFailure(row, error, now) }; }
      const payloadHash = fingerprint({ candidateHash, anchor, relationKind, relationEvidenceId, relationEvidenceHash });
      const existing = this.db.prepare("SELECT * FROM discovery_reservations WHERE discovery_run_id=? AND kind='candidate' AND idempotency_key=?").get(discoveryRunId, idempotencyKey);
      if (existing) { if (existing.payload_hash !== payloadHash) throw new ControlPlaneError("DISCOVERY_IDEMPOTENCY_CONFLICT", "candidate idempotency conflict", { status: 409 }); return { reused: true, reservationId: existing.reservation_id }; }
      if (row.candidate_count >= row.max_candidates) throw new ControlPlaneError("DISCOVERY_CANDIDATE_BUDGET_EXHAUSTED", "DiscoveryRun candidate quota exhausted", { status: 409 });
      const reservationId = newId("discovery_candidate");
      this.db.prepare("INSERT INTO discovery_reservations (reservation_id, discovery_run_id, kind, idempotency_key, payload_hash, status, created_at, updated_at) VALUES (?, ?, 'candidate', ?, ?, 'intent_recorded', ?, ?)").run(reservationId, discoveryRunId, idempotencyKey, payloadHash, now, now);
      this.db.prepare("UPDATE discovery_runs SET candidate_count=candidate_count+1, updated_at=? WHERE discovery_run_id=?").run(now, discoveryRunId);
      return { reused: false, reservationId };
    });
    if (result?.error) throw result.error; return result;
  }

  heartbeatDiscoveryRunStorage({ discoveryRunId, tuple, gates = {}, ttlMs = 60000 }) {
    const now = this.now();
    const result = this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM discovery_runs WHERE discovery_run_id=?").get(discoveryRunId);
      if (!row) throw new ControlPlaneError("DISCOVERY_RUN_NOT_FOUND", "unknown DiscoveryRun", { status: 404 });
      try {
        this.#assertDiscoveryRunOwnership(row, tuple, now);
        this.#assertLiveDiscoveryAuthority(row, gates);
      } catch (error) {
        return { error: this.#terminalizeDiscoveryFailure(row, error, now) };
      }
      this.db.prepare("UPDATE leases SET heartbeat_at=?, expires_at=? WHERE lease_id=?").run(now, now + ttlMs, row.lease_id);
      this.db.prepare("UPDATE sessions SET expires_at=? WHERE session_id=?").run(now + ttlMs, row.session_id);
      this.db.prepare("UPDATE discovery_runs SET updated_at=? WHERE discovery_run_id=?").run(now, row.discovery_run_id);
      this.#insertDiscoveryEvent({ discoveryRunId, type: "discovery_run.heartbeat", payload: {}, createdAt: now });
      return this.#publicDiscoveryRun(this.db.prepare("SELECT * FROM discovery_runs WHERE discovery_run_id=?").get(discoveryRunId));
    });
    if (result?.error) throw result.error;
    return result;
  }

  sealDiscoveryRunStorage({ discoveryRunId, tuple, gates = {} }) {
    const now = this.now();
    const result = this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM discovery_runs WHERE discovery_run_id=?").get(discoveryRunId);
      if (!row) throw new ControlPlaneError("DISCOVERY_RUN_NOT_FOUND", "unknown DiscoveryRun", { status: 404 });
      try {
        this.#assertDiscoveryRunOwnership(row, tuple, now);
        this.#assertLiveDiscoveryAuthority(row, gates);
      } catch (error) {
        return { error: this.#terminalizeDiscoveryFailure(row, error, now) };
      }
      this.db.prepare("UPDATE discovery_runs SET status='sealing', updated_at=? WHERE discovery_run_id=? AND status='running'").run(now, discoveryRunId);
      const sealing = this.db.prepare("SELECT * FROM discovery_runs WHERE discovery_run_id=?").get(discoveryRunId);
      return this.#releaseDiscoveryRun(sealing, "sealed", now);
    });
    if (result?.error) throw result.error;
    return result;
  }

  abortDiscoveryRunStorage({ discoveryRunId, tuple, reason = "aborted", gates = {} }) {
    const now = this.now();
    const result = this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM discovery_runs WHERE discovery_run_id=?").get(discoveryRunId);
      if (!row) throw new ControlPlaneError("DISCOVERY_RUN_NOT_FOUND", "unknown DiscoveryRun", { status: 404 });
      try {
        this.#assertDiscoveryRunOwnership(row, tuple, now);
        this.#assertLiveDiscoveryAuthority(row, gates);
      } catch (error) {
        return { error: this.#terminalizeDiscoveryFailure(row, error, now) };
      }
      return this.#releaseDiscoveryRun(row, "aborted", now, reason);
    });
    if (result?.error) throw result.error;
    return result;
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
      this.#assertOrdinaryM6ResourceAllowedNoTransaction();
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
          scope_capability_id, placement_decision_json, created_at, expires_at, session_kind
        ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, 'capability')
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

  finishDeviceRunStorage({ tuple, phase, outcome = null }) {
    if (!["succeeded", "failed", "ambiguous", "blocked", "cancelled"].includes(phase)) {
      throw new ControlPlaneError("DEVICE_RUN_PHASE_INVALID", "device run terminal phase is invalid", { status: 400 });
    }
    const now = this.now();
    return this.transaction(() => {
      const run = this.db.prepare("SELECT * FROM device_runs WHERE device_run_id=?").get(tuple?.deviceRunId);
      const lease = run && this.db.prepare("SELECT * FROM leases WHERE lease_id=?").get(run.lease_id);
      if (!run || run.mission_id !== tuple?.missionId || run.session_id !== tuple?.sessionId
        || run.controller_agent !== tuple?.controllerAgent || run.controller_epoch !== tuple?.controllerEpoch
        || !lease || lease.owner_device_run_id !== run.device_run_id) {
        throw new ControlPlaneError("CONTROL_TUPLE_INCOMPLETE", "cannot finish a device run without its live owned tuple", { status: 409 });
      }
      this.db.prepare("UPDATE device_runs SET phase=?,outcome=?,updated_at=?,finished_at=? WHERE device_run_id=?")
        .run(phase, outcome, now, now, run.device_run_id);
      this.db.prepare("DELETE FROM sessions WHERE session_id=? AND lease_id=? AND device_id=?").run(run.session_id, run.lease_id, run.device_id);
      this.db.prepare("DELETE FROM leases WHERE lease_id=? AND device_id=? AND owner_device_run_id=?").run(run.lease_id, run.device_id, run.device_run_id);
      this.#insertMissionEvent({ missionId: run.mission_id, type: `device_run.${phase}`, payload: { deviceRunId: run.device_run_id, outcome, released: true }, createdAt: now });
      return this.#publicDeviceRun(this.db.prepare("SELECT * FROM device_runs WHERE device_run_id=?").get(run.device_run_id));
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

  /**
   * Persist + return a one-time transport action authorization (Foundation PR3).
   * Plaintext nonce is returned once; only nonce_hash is stored.
   */
  issueTransportActionAuthorization(input) {
    const { authorization, token } = issueTransportAuthKernel(input);
    this.db.prepare(`
      INSERT INTO transport_action_authorizations (
        authorization_id, schema_id, kind, purpose, job_id, run_id, mission_id, device_run_id,
        lease_id, device_id, operation_key, capability_contract_hash, implementation_closure_hash,
        nonce_hash, issued_at, expires_at, consumed_at, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(
      authorization.authorizationId,
      authorization.schemaId,
      authorization.kind,
      authorization.purpose,
      authorization.jobId,
      authorization.runId,
      authorization.missionId,
      authorization.deviceRunId,
      authorization.leaseId,
      authorization.deviceId,
      authorization.operationKey,
      authorization.capabilityContractHash,
      authorization.implementationClosureHash,
      authorization.nonceHash,
      authorization.issuedAt,
      authorization.expiresAt,
      authorization.source,
    );
    return { authorization: this.getTransportActionAuthorization(authorization.authorizationId), token };
  }

  getTransportActionAuthorization(authorizationId) {
    const row = this.db.prepare("SELECT * FROM transport_action_authorizations WHERE authorization_id=?").get(authorizationId);
    return publicTransportAuth(row);
  }

  #consumeTransportActionAuthorizationNoTransaction({ authorizationId, token, expectedPurpose = null, expectedDeviceId = null, expectedLeaseId = null } = {}) {
    const row = this.db.prepare("SELECT * FROM transport_action_authorizations WHERE authorization_id=?").get(authorizationId);
    if (!row) throw new ControlPlaneError("TRANSPORT_AUTH_NOT_FOUND", "authorization missing", { status: 404 });
    const stored = publicTransportAuth(row);
    const consumed = consumeTransportAuthKernel({
      stored,
      token: { ...token, authorizationId },
      expectedPurpose: expectedPurpose || stored.purpose,
      expectedDeviceId: expectedDeviceId || stored.deviceId,
      expectedLeaseId: expectedLeaseId || stored.leaseId,
    });
    const updated = this.db.prepare("UPDATE transport_action_authorizations SET consumed_at=? WHERE authorization_id=? AND consumed_at IS NULL")
      .run(consumed.consumedAt, authorizationId);
    if (!updated.changes) {
      throw new ControlPlaneError("TRANSPORT_AUTH_REPLAY", "authorization nonce already consumed", { status: 409, details: { authorizationId } });
    }
    return this.getTransportActionAuthorization(authorizationId);
  }

  consumeTransportActionAuthorization(input = {}) {
    return this.transaction(() => this.#consumeTransportActionAuthorizationNoTransaction(input));
  }
}

function publicTransportAuth(row) {
  if (!row) return null;
  return {
    schemaId: row.schema_id,
    authorizationId: row.authorization_id,
    kind: row.kind,
    purpose: row.purpose,
    jobId: row.job_id,
    runId: row.run_id,
    missionId: row.mission_id,
    deviceRunId: row.device_run_id,
    leaseId: row.lease_id,
    deviceId: row.device_id,
    operationKey: row.operation_key,
    capabilityContractHash: row.capability_contract_hash,
    implementationClosureHash: row.implementation_closure_hash,
    nonceHash: row.nonce_hash,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    source: row.source,
  };
}
