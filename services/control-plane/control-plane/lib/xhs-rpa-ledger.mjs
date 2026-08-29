import { createHash } from "node:crypto";

const HASH = /^[0-9a-f]{64}$/;
const PROGRAM_ID = /^xrp_[a-z0-9][a-z0-9._-]{2,63}$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/;
const ACTIVE = new Set(["RESERVED", "DISPATCHED", "CLEANING", "CANCEL_REQUESTED"]);
const JOURNAL_TYPES = new Set([
  "TICK_RESERVED", "PRE_IO_ATTEMPT", "DISPATCHED", "CHILD_COMMITTED",
  "VALIDATOR_PASSED", "CLEANUP_STARTED", "CLEANUP_VERIFIED", "TICK_COMMITTED",
  "KILL_OBSERVED", "TICK_CANCELLED", "TICK_BLOCKED",
]);
const SAFETY_KEYS = [
  "likes", "comments", "follows", "shares", "saves", "publishes", "messages",
  "socialAuthorityDelta", "socialReservationDelta", "socialTransportDelta",
];
const FORBIDDEN_ACTIONS = [
  "like", "collect", "follow", "comment_send", "comment_reply", "comment_like",
  "dm", "publish", "delete", "payment", "purchase", "account", "settings",
  "permission_change", "share",
];

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function exact(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key)));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) fail("XHS_RPA_LEDGER_JSON_INVALID", "journal values must be plain JSON");
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  fail("XHS_RPA_LEDGER_JSON_INVALID", "journal values must be finite JSON");
}

function json(value) {
  return JSON.stringify(canonicalize(value));
}

function sha(value) {
  return createHash("sha256").update(typeof value === "string" ? value : json(value), "utf8").digest("hex");
}

function zeroSafety(value) {
  return exact(value, SAFETY_KEYS) && SAFETY_KEYS.every((key) => value[key] === 0);
}

function verifiedCleanup(value) {
  return exact(value, ["restored", "zeroOwnedLeases", "ownedLeaseCount"])
    && value.restored === true && value.zeroOwnedLeases === true && value.ownedLeaseCount === 0;
}

function shanghaiLocalDayStartMs(epochMs) {
  const offsetMs = 8 * 60 * 60 * 1000;
  return Math.floor((epochMs + offsetMs) / 86_400_000) * 86_400_000 - offsetMs;
}

function rowTick(row) {
  if (!row) return null;
  return Object.freeze({
    tickId: row.tick_id,
    idempotencyKey: row.idempotency_key,
    programId: row.program_id,
    generation: row.generation,
    accountRef: row.account_ref,
    status: row.status,
    trigger: row.trigger,
    scheduledAtMs: row.scheduled_at_ms,
    reservedAtMs: row.reserved_at_ms,
    killGeneration: row.kill_generation,
    preIoAttempts: row.pre_io_attempts,
    receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null,
  });
}

function assertDatabase(database) {
  if (!database || typeof database.exec !== "function" || typeof database.prepare !== "function") {
    fail("XHS_RPA_LEDGER_DB_REQUIRED", "a Control-Plane-owned SQLite database is required");
  }
}

export function verifyTaskOwnedXhsV3P6Artifact(artifact, binding) {
  const keys = [
    "schemaId", "schemaVersion", "ownership", "contentAddressed", "verdict", "programId",
    "programVersion", "generation", "programHash", "taskPlanHash", "releaseId", "sourceCommit",
    "artifactHash",
  ];
  const body = artifact && Object.fromEntries(Object.entries(artifact).filter(([key]) => key !== "artifactHash"));
  const verified = exact(artifact, keys)
    && artifact.schemaId === "xw.xhs.v3-p6-artifact.v1"
    && artifact.schemaVersion === 1
    && artifact.ownership === "task_owned"
    && artifact.contentAddressed === true
    && artifact.verdict === "PASS"
    && artifact.programId === binding?.programId
    && artifact.programVersion === binding?.programVersion
    && artifact.generation === binding?.generation
    && artifact.programHash === binding?.programHash
    && artifact.taskPlanHash === binding?.taskPlanHash
    && artifact.releaseId === binding?.releaseId
    && artifact.sourceCommit === binding?.sourceCommit
    && HASH.test(String(artifact.artifactHash ?? ""))
    && artifact.artifactHash === sha(body);
  return Object.freeze({
    verified,
    taskOwned: verified,
    artifactHash: verified ? artifact.artifactHash : null,
  });
}

export function createXhsRpaLedger(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !["database", "now"].includes(key))) {
    fail("XHS_RPA_LEDGER_DEPENDENCY_INVALID", "ledger dependency input must be exact");
  }
  const { database, now = () => Date.now() } = input;
  assertDatabase(database);
  if (typeof now !== "function") {
    fail("XHS_RPA_LEDGER_DEPENDENCY_INVALID", "ledger dependencies are invalid");
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS xhs_rpa_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      kill_generation INTEGER NOT NULL
    ) STRICT;
    INSERT OR IGNORE INTO xhs_rpa_meta(singleton, kill_generation) VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS xhs_rpa_programs (
      program_id TEXT PRIMARY KEY,
      program_version INTEGER NOT NULL,
      program_hash TEXT NOT NULL,
      task_plan_hash TEXT NOT NULL,
      owner_ref TEXT NOT NULL,
      account_ref TEXT NOT NULL,
      generation INTEGER NOT NULL,
      rollback_generation INTEGER NOT NULL,
      release_id TEXT NOT NULL,
      source_commit TEXT NOT NULL,
      expected_receipts_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled = 0),
      recurring_enabled INTEGER NOT NULL DEFAULT 0 CHECK (recurring_enabled = 0),
      pacing_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      disabled_at_ms INTEGER
    ) STRICT;
    CREATE TABLE IF NOT EXISTS xhs_rpa_ticks (
      tick_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      program_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      account_ref TEXT NOT NULL,
      status TEXT NOT NULL,
      trigger TEXT NOT NULL,
      scheduled_at_ms INTEGER NOT NULL,
      reserved_at_ms INTEGER NOT NULL,
      dispatched_at_ms INTEGER,
      finished_at_ms INTEGER,
      kill_generation INTEGER NOT NULL,
      p6_artifact_hash TEXT,
      pre_io_attempts INTEGER NOT NULL DEFAULT 0,
      receipt_json TEXT,
      FOREIGN KEY(program_id) REFERENCES xhs_rpa_programs(program_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS xhs_rpa_ticks_account_time
      ON xhs_rpa_ticks(account_ref, reserved_at_ms);
    CREATE TABLE IF NOT EXISTS xhs_rpa_journal (
      tick_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      previous_hash TEXT NOT NULL,
      record_hash TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY(tick_id, seq),
      FOREIGN KEY(tick_id) REFERENCES xhs_rpa_ticks(tick_id)
    ) STRICT;
  `);

  function transaction(fn) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  function getTickRow(tickId) {
    return database.prepare("SELECT * FROM xhs_rpa_ticks WHERE tick_id = ?").get(tickId);
  }

  function appendInTransaction(tickId, type, payload, atMs = now()) {
    if (!JOURNAL_TYPES.has(type)) fail("XHS_RPA_JOURNAL_TYPE_INVALID", `unsupported journal type ${type}`);
    const last = database.prepare(
      "SELECT seq, record_hash FROM xhs_rpa_journal WHERE tick_id = ? ORDER BY seq DESC LIMIT 1",
    ).get(tickId);
    const seq = (last?.seq ?? 0) + 1;
    const previousHash = last?.record_hash ?? "genesis";
    const payloadJson = json(payload);
    const recordHash = sha({ tickId, seq, type, payload: JSON.parse(payloadJson), previousHash, atMs });
    database.prepare(`
      INSERT INTO xhs_rpa_journal
        (tick_id, seq, type, payload_json, previous_hash, record_hash, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(tickId, seq, type, payloadJson, previousHash, recordHash, atMs);
    return Object.freeze({ tickId, seq, type, previousHash, recordHash, atMs });
  }

  function registerProgram(program) {
    const programBody = program && Object.fromEntries(Object.entries(program).filter(([key]) => key !== "programHash"));
    if (!program || !PROGRAM_ID.test(String(program.programId ?? ""))
      || !HASH.test(String(program.programHash ?? "")) || !HASH.test(String(program.taskPlanHash ?? ""))
      || program.programHash !== sha(programBody)
      || !Number.isInteger(program.programVersion) || program.programVersion < 1
      || !/^own_[a-z0-9][a-z0-9._-]{2,127}$/.test(String(program.ownerRef ?? ""))
      || !HASH.test(String(program.accountRef ?? "")) || !Number.isInteger(program.generation) || program.generation < 1
      || !Number.isInteger(program.rollbackGeneration) || program.rollbackGeneration < 0 || program.rollbackGeneration > program.generation
      || program.enabled !== false || program.recurringEnabled !== false
      || program.externalEffects !== 0 || program.writeTransportBudget !== 0
      || json(program.forbiddenActions) !== json(FORBIDDEN_ACTIONS)
      || !/^[A-Za-z0-9._-]{3,128}$/.test(String(program.runtime?.releaseId ?? ""))
      || !/^[0-9a-f]{40}$/.test(String(program.runtime?.sourceCommit ?? ""))
      || program.pacing?.accountConcurrency !== 1
      || !Number.isInteger(program.pacing?.dailyStarts) || program.pacing.dailyStarts < 1 || program.pacing.dailyStarts > 4
      || !Number.isInteger(program.pacing?.minimumIntervalMs) || program.pacing.minimumIntervalMs < 300_000
      || !Number.isInteger(program.pacing?.preIoRetryMax) || program.pacing.preIoRetryMax < 0 || program.pacing.preIoRetryMax > 1) {
      fail("XHS_RPA_PROGRAM_INVALID", "only a sealed, disabled RPA program can be registered");
    }
    return transaction(() => {
      const existing = database.prepare("SELECT * FROM xhs_rpa_programs WHERE program_id = ?").get(program.programId);
      if (existing) {
        if (existing.program_hash !== program.programHash || existing.generation !== program.generation) {
          fail("XHS_RPA_PROGRAM_CONFLICT", "program id is already bound to another seal/generation");
        }
        return status(program.programId);
      }
      database.prepare(`
        INSERT INTO xhs_rpa_programs
          (program_id, program_version, program_hash, task_plan_hash, owner_ref, account_ref,
           generation, rollback_generation, release_id, source_commit, expected_receipts_json,
           pacing_json, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(program.programId, program.programVersion, program.programHash, program.taskPlanHash,
        program.ownerRef, program.accountRef, program.generation, program.rollbackGeneration,
        program.runtime.releaseId, program.runtime.sourceCommit, json(Object.fromEntries(program.nodes.map((node) => [
          node.nodeId,
          {
            expectedReceiptSchema: node.catalogRef.expectedReceiptSchema,
            cleanupContractHash: node.catalogRef.cleanupContractHash,
          },
        ]))), json(program.pacing), now());
      return status(program.programId);
    });
  }

  function status(programId) {
    if (!PROGRAM_ID.test(String(programId ?? ""))) fail("XHS_RPA_PROGRAM_ID_INVALID", "program id is invalid");
    const row = database.prepare("SELECT * FROM xhs_rpa_programs WHERE program_id = ?").get(programId);
    if (!row) return null;
    const activeTicks = database.prepare(`
      SELECT COUNT(*) AS count FROM xhs_rpa_ticks
      WHERE program_id = ? AND status IN ('RESERVED','DISPATCHED','CLEANING','CANCEL_REQUESTED')
    `).get(programId).count;
    return Object.freeze({
      programId: row.program_id,
      programVersion: row.program_version,
      programHash: row.program_hash,
      taskPlanHash: row.task_plan_hash,
      ownerRef: row.owner_ref,
      accountRef: row.account_ref,
      generation: row.generation,
      rollbackGeneration: row.rollback_generation,
      releaseId: row.release_id,
      sourceCommit: row.source_commit,
      enabled: false,
      recurringEnabled: false,
      pacing: Object.freeze(JSON.parse(row.pacing_json)),
      activeTicks,
      disabledAtMs: row.disabled_at_ms ?? null,
    });
  }

  function listActiveTicks() {
    return Object.freeze(database.prepare(`
      SELECT * FROM xhs_rpa_ticks
      WHERE status IN ('RESERVED','DISPATCHED','CLEANING','CANCEL_REQUESTED')
      ORDER BY reserved_at_ms ASC, tick_id ASC
    `).all().map((row) => rowTick(row)));
  }

  function insertSkipped({ program, generation, idempotencyKey, trigger, scheduledAtMs, reason, atMs, killGeneration }) {
    const tickId = `tick_${sha(`${program.program_id}:${idempotencyKey}`).slice(0, 32)}`;
    const receipt = Object.freeze({ admitted: false, reason });
    database.prepare(`
      INSERT INTO xhs_rpa_ticks
        (tick_id,idempotency_key,program_id,generation,account_ref,status,trigger,scheduled_at_ms,
         reserved_at_ms,finished_at_ms,kill_generation,receipt_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(tickId, idempotencyKey, program.program_id, generation, program.account_ref,
      `SKIPPED_${reason}`, trigger, scheduledAtMs, atMs, atMs, killGeneration, json(receipt));
    return rowTick(getTickRow(tickId));
  }

  function reserveTick(input = {}) {
    const keys = ["programId", "generation", "idempotencyKey", "trigger", "scheduledAtMs", "p6Artifact"];
    if (!exact(input, keys) || !PROGRAM_ID.test(String(input.programId ?? ""))
      || !Number.isInteger(input.generation) || input.generation < 1
      || !OPAQUE.test(String(input.idempotencyKey ?? ""))
      || !["manual_once", "recurring_wake"].includes(input.trigger)
      || !Number.isInteger(input.scheduledAtMs)) {
      fail("XHS_RPA_TICK_INPUT_INVALID", "tick input must be the exact opaque trigger contract");
    }
    return transaction(() => {
      const prior = database.prepare("SELECT * FROM xhs_rpa_ticks WHERE idempotency_key = ?").get(input.idempotencyKey);
      if (prior) return rowTick(prior);
      const program = database.prepare("SELECT * FROM xhs_rpa_programs WHERE program_id = ?").get(input.programId);
      if (!program) fail("XHS_RPA_PROGRAM_NOT_FOUND", "program is not registered");
      if (program.generation !== input.generation) fail("XHS_RPA_GENERATION_STALE", "tick generation is stale");
      const atMs = now();
      const killGeneration = database.prepare("SELECT kill_generation FROM xhs_rpa_meta WHERE singleton = 1").get().kill_generation;
      if (input.trigger === "recurring_wake") {
        return insertSkipped({ program, ...input, reason: "RECURRING_DISABLED", atMs, killGeneration });
      }
      const p6 = verifyTaskOwnedXhsV3P6Artifact(input.p6Artifact, {
        programId: program.program_id,
        programVersion: program.program_version,
        programHash: program.program_hash,
        taskPlanHash: program.task_plan_hash,
        generation: program.generation,
        releaseId: program.release_id,
        sourceCommit: program.source_commit,
      });
      if (!p6 || p6.verified !== true || p6.taskOwned !== true || !HASH.test(String(p6.artifactHash ?? ""))) {
        return insertSkipped({ program, ...input, reason: "P6_UNVERIFIED", atMs, killGeneration });
      }
      if (input.scheduledAtMs < atMs - 300_000) {
        return insertSkipped({ program, ...input, reason: "NO_CATCHUP", atMs, killGeneration });
      }
      if (input.scheduledAtMs > atMs + 30_000) {
        fail("XHS_RPA_TICK_EARLY", "manual tick cannot reserve before its schedule");
      }
      const pacing = JSON.parse(program.pacing_json);
      const active = database.prepare(`
        SELECT COUNT(*) AS count FROM xhs_rpa_ticks
        WHERE account_ref = ? AND status IN ('RESERVED','DISPATCHED','CLEANING','CANCEL_REQUESTED')
      `).get(program.account_ref).count;
      if (active >= 1) return insertSkipped({ program, ...input, reason: "ACCOUNT_CONCURRENCY", atMs, killGeneration });
      const starts = database.prepare(`
        SELECT COUNT(*) AS count FROM xhs_rpa_ticks
        WHERE account_ref = ? AND reserved_at_ms >= ?
          AND status NOT LIKE 'SKIPPED_%'
      `).get(program.account_ref, shanghaiLocalDayStartMs(atMs)).count;
      if (starts >= pacing.dailyStarts) return insertSkipped({ program, ...input, reason: "DAILY_CAP", atMs, killGeneration });
      const last = database.prepare(`
        SELECT MAX(reserved_at_ms) AS last FROM xhs_rpa_ticks
        WHERE account_ref = ? AND status NOT LIKE 'SKIPPED_%'
      `).get(program.account_ref).last;
      if (last !== null && last > atMs) {
        return insertSkipped({ program, ...input, reason: "CLOCK_ROLLBACK", atMs, killGeneration });
      }
      if (last !== null && atMs - last < pacing.minimumIntervalMs) {
        return insertSkipped({ program, ...input, reason: "MINIMUM_INTERVAL", atMs, killGeneration });
      }
      const tickId = `tick_${sha(`${program.program_id}:${input.idempotencyKey}`).slice(0, 32)}`;
      database.prepare(`
        INSERT INTO xhs_rpa_ticks
          (tick_id,idempotency_key,program_id,generation,account_ref,status,trigger,scheduled_at_ms,
           reserved_at_ms,kill_generation,p6_artifact_hash)
        VALUES (?,?,?,?,?,'RESERVED',?,?,?,?,?)
      `).run(tickId, input.idempotencyKey, program.program_id, input.generation,
        program.account_ref, input.trigger, input.scheduledAtMs, atMs, killGeneration, p6.artifactHash);
      appendInTransaction(tickId, "TICK_RESERVED", {
        p6ArtifactHash: p6.artifactHash,
        programHash: program.program_hash,
        taskPlanHash: program.task_plan_hash,
        killGeneration,
      }, atMs);
      return rowTick(getTickRow(tickId));
    });
  }

  function recordPreIoAttempt(input = {}) {
    if (!exact(input, ["tickId"])) fail("XHS_RPA_LEDGER_INPUT_INVALID", "pre-I/O input is not exact");
    return transaction(() => {
      const tick = getTickRow(input.tickId);
      if (!tick || tick.status !== "RESERVED") fail("XHS_RPA_TICK_STATE_INVALID", "tick is not reserved");
      const pacing = JSON.parse(database.prepare("SELECT pacing_json FROM xhs_rpa_programs WHERE program_id = ?").get(tick.program_id).pacing_json);
      const attempts = tick.pre_io_attempts + 1;
      if (attempts > pacing.preIoRetryMax + 1) fail("XHS_RPA_PRE_IO_RETRY_EXHAUSTED", "pre-I/O retry hard cap exceeded");
      database.prepare("UPDATE xhs_rpa_ticks SET pre_io_attempts = ? WHERE tick_id = ?").run(attempts, tick.tick_id);
      appendInTransaction(tick.tick_id, "PRE_IO_ATTEMPT", { attempts });
      return rowTick(getTickRow(tick.tick_id));
    });
  }

  function markDispatched(input = {}) {
    if (!exact(input, ["tickId", "killGeneration"]) || !Number.isInteger(input.killGeneration)) {
      fail("XHS_RPA_LEDGER_INPUT_INVALID", "dispatch input is not exact");
    }
    return transaction(() => {
      const tick = getTickRow(input.tickId);
      const currentKill = database.prepare("SELECT kill_generation FROM xhs_rpa_meta WHERE singleton=1").get().kill_generation;
      if (!tick || tick.status !== "RESERVED" || tick.kill_generation !== input.killGeneration || currentKill !== input.killGeneration) {
        fail("XHS_RPA_KILL_GENERATION_STALE", "dispatch crossed a kill generation");
      }
      database.prepare("UPDATE xhs_rpa_ticks SET status='DISPATCHED', dispatched_at_ms=? WHERE tick_id=?")
        .run(now(), tick.tick_id);
      appendInTransaction(tick.tick_id, "DISPATCHED", { killGeneration: currentKill });
      return rowTick(getTickRow(tick.tick_id));
    });
  }

  function beginCleanup(input = {}) {
    if (!exact(input, ["tickId"])) fail("XHS_RPA_LEDGER_INPUT_INVALID", "cleanup input is not exact");
    return transaction(() => {
      const tick = getTickRow(input.tickId);
      if (!tick || !["DISPATCHED", "CANCEL_REQUESTED"].includes(tick.status)) {
        fail("XHS_RPA_TICK_STATE_INVALID", "tick cannot enter cleanup");
      }
      database.prepare("UPDATE xhs_rpa_ticks SET status='CLEANING' WHERE tick_id=?").run(tick.tick_id);
      appendInTransaction(tick.tick_id, "CLEANUP_STARTED", {});
      return rowTick(getTickRow(tick.tick_id));
    });
  }

  function cancelTick(input = {}) {
    if (!exact(input, ["tickId", "cleanup", "reason"]) || typeof input.reason !== "string" || !verifiedCleanup(input.cleanup)) {
      fail("XHS_RPA_CANCEL_INVALID", "cancel requires verified restore and zero owned leases");
    }
    return transaction(() => {
      const tick = getTickRow(input.tickId);
      if (!tick || !["RESERVED", "CANCEL_REQUESTED", "CLEANING", "DISPATCHED"].includes(tick.status)) {
        fail("XHS_RPA_TICK_STATE_INVALID", "tick cannot be cancelled");
      }
      appendInTransaction(tick.tick_id, "CLEANUP_VERIFIED", input.cleanup);
      const receipt = Object.freeze({ committed: false, cancelled: true, reason: input.reason, cleanup: input.cleanup });
      database.prepare("UPDATE xhs_rpa_ticks SET status='CANCELLED', finished_at_ms=?, receipt_json=? WHERE tick_id=?")
        .run(now(), json(receipt), tick.tick_id);
      appendInTransaction(tick.tick_id, "TICK_CANCELLED", { reason: input.reason, receiptHash: sha(receipt) });
      return rowTick(getTickRow(tick.tick_id));
    });
  }

  function blockTick(input = {}) {
    if (!exact(input, ["tickId", "cleanup", "reason"]) || typeof input.reason !== "string" || !verifiedCleanup(input.cleanup)) {
      fail("XHS_RPA_BLOCK_INVALID", "blocked tick requires verified restore and zero owned leases");
    }
    return transaction(() => {
      const tick = getTickRow(input.tickId);
      if (!tick || !ACTIVE.has(tick.status)) fail("XHS_RPA_TICK_STATE_INVALID", "tick cannot be blocked");
      appendInTransaction(tick.tick_id, "CLEANUP_VERIFIED", input.cleanup);
      const receipt = Object.freeze({ committed: false, blocked: true, reason: input.reason, cleanup: input.cleanup });
      database.prepare("UPDATE xhs_rpa_ticks SET status='BLOCKED', finished_at_ms=?, receipt_json=? WHERE tick_id=?")
        .run(now(), json(receipt), tick.tick_id);
      appendInTransaction(tick.tick_id, "TICK_BLOCKED", { reason: input.reason, receiptHash: sha(receipt) });
      return rowTick(getTickRow(tick.tick_id));
    });
  }

  function commitTick(input = {}) {
    const keys = ["tickId", "killGeneration", "schedulerTraceHash", "childReceipts", "validator", "cleanup", "aggregateSafety"];
    if (!exact(input, keys) || !Number.isInteger(input.killGeneration)
      || !HASH.test(String(input.schedulerTraceHash ?? ""))
      || !Array.isArray(input.childReceipts) || input.childReceipts.length === 0
      || !exact(input.validator, ["passed", "reportHash"]) || input.validator.passed !== true || !HASH.test(String(input.validator.reportHash ?? ""))
      || !verifiedCleanup(input.cleanup) || !zeroSafety(input.aggregateSafety)) {
      fail("XHS_RPA_COMMIT_INVALID", "aggregate commit contract is invalid");
    }
    for (const child of input.childReceipts) {
      if (!exact(child, ["nodeId", "schemaId", "receiptHash", "cleanupContractHash", "committed", "safety", "cleanup"])
        || typeof child.nodeId !== "string" || !HASH.test(String(child.receiptHash ?? ""))
        || typeof child.schemaId !== "string" || !HASH.test(String(child.cleanupContractHash ?? ""))
        || child.committed !== true || !zeroSafety(child.safety) || !verifiedCleanup(child.cleanup)) {
        fail("XHS_RPA_CHILD_RECEIPT_INVALID", "child receipt is not committed/zero-social/clean");
      }
    }
    return transaction(() => {
      const tick = getTickRow(input.tickId);
      const currentKill = database.prepare("SELECT kill_generation FROM xhs_rpa_meta WHERE singleton=1").get().kill_generation;
      if (!tick || tick.status !== "CLEANING"
        || tick.kill_generation !== input.killGeneration || currentKill !== input.killGeneration) {
        fail("XHS_RPA_KILL_GENERATION_STALE", "commit crossed a kill generation");
      }
      const program = database.prepare("SELECT * FROM xhs_rpa_programs WHERE program_id=?").get(tick.program_id);
      const expected = JSON.parse(program.expected_receipts_json);
      if (new Set(input.childReceipts.map((child) => child.nodeId)).size !== input.childReceipts.length
        || input.childReceipts.length !== Object.keys(expected).length
        || input.childReceipts.some((child) => child.schemaId !== expected[child.nodeId]?.expectedReceiptSchema
          || child.cleanupContractHash !== expected[child.nodeId]?.cleanupContractHash)) {
        fail("XHS_RPA_CHILD_RECEIPT_BINDING_INVALID", "child receipt schema/cleanup contract differs from the sealed program");
      }
      for (const child of input.childReceipts) {
        appendInTransaction(tick.tick_id, "CHILD_COMMITTED", { nodeId: child.nodeId, receiptHash: child.receiptHash });
      }
      appendInTransaction(tick.tick_id, "VALIDATOR_PASSED", input.validator);
      appendInTransaction(tick.tick_id, "CLEANUP_VERIFIED", input.cleanup);
      const journalCheckpoint = database.prepare(`
        SELECT seq, record_hash FROM xhs_rpa_journal WHERE tick_id=? ORDER BY seq DESC LIMIT 1
      `).get(tick.tick_id);
      const receiptBody = {
        schemaId: "xw.xhs.rpa-tick-receipt.v1",
        tickId: tick.tick_id,
        programId: tick.program_id,
        programVersion: program.program_version,
        programHash: program.program_hash,
        taskPlanHash: program.task_plan_hash,
        generation: tick.generation,
        killGeneration: input.killGeneration,
        trigger: "manual_once",
        taskOwned: true,
        p6ArtifactHash: tick.p6_artifact_hash,
        releaseId: program.release_id,
        sourceCommit: program.source_commit,
        recurringEnabled: false,
        externalEffects: 0,
        writeTransportBudget: 0,
        journalHeadHash: journalCheckpoint.record_hash,
        journalLength: journalCheckpoint.seq,
        schedulerTraceHash: input.schedulerTraceHash,
        childReceipts: input.childReceipts,
        validator: input.validator,
        cleanup: input.cleanup,
        aggregateSafety: input.aggregateSafety,
        committed: true,
      };
      const receipt = Object.freeze({ ...receiptBody, receiptHash: sha(receiptBody) });
      database.prepare("UPDATE xhs_rpa_ticks SET status='SUCCEEDED', finished_at_ms=?, receipt_json=? WHERE tick_id=?")
        .run(now(), json(receipt), tick.tick_id);
      appendInTransaction(tick.tick_id, "TICK_COMMITTED", { receiptHash: receipt.receiptHash });
      return rowTick(getTickRow(tick.tick_id));
    });
  }

  function disable(input = {}) {
    if (!exact(input, ["programId", "generation", "reason"]) || !PROGRAM_ID.test(String(input.programId ?? ""))
      || !Number.isInteger(input.generation) || typeof input.reason !== "string" || input.reason.length < 3) {
      fail("XHS_RPA_DISABLE_INPUT_INVALID", "disable input is invalid");
    }
    return transaction(() => {
      const program = database.prepare("SELECT * FROM xhs_rpa_programs WHERE program_id=?").get(input.programId);
      if (!program) fail("XHS_RPA_PROGRAM_NOT_FOUND", "program is not registered");
      if (program.generation !== input.generation) fail("XHS_RPA_GENERATION_STALE", "disable generation is stale");
      const next = program.generation + 1;
      database.prepare("UPDATE xhs_rpa_programs SET generation=?, disabled_at_ms=? WHERE program_id=?")
        .run(next, now(), input.programId);
      const active = database.prepare(`SELECT tick_id FROM xhs_rpa_ticks WHERE program_id=?
        AND status IN ('RESERVED','DISPATCHED','CLEANING','CANCEL_REQUESTED')`).all(input.programId);
      for (const tick of active) {
        database.prepare("UPDATE xhs_rpa_ticks SET status='CANCEL_REQUESTED' WHERE tick_id=?").run(tick.tick_id);
        appendInTransaction(tick.tick_id, "KILL_OBSERVED", { reason: input.reason, source: "program_disable" });
      }
      return status(input.programId);
    });
  }

  function kill(input = {}) {
    if (!exact(input, ["reason"]) || typeof input.reason !== "string" || input.reason.length < 3) {
      fail("XHS_RPA_KILL_INPUT_INVALID", "kill reason is required");
    }
    return transaction(() => {
      database.prepare("UPDATE xhs_rpa_meta SET kill_generation=kill_generation+1 WHERE singleton=1").run();
      const generation = database.prepare("SELECT kill_generation FROM xhs_rpa_meta WHERE singleton=1").get().kill_generation;
      database.prepare("UPDATE xhs_rpa_programs SET generation=generation+1, disabled_at_ms=?").run(now());
      const active = database.prepare(`SELECT tick_id FROM xhs_rpa_ticks
        WHERE status IN ('RESERVED','DISPATCHED','CLEANING','CANCEL_REQUESTED')`).all();
      for (const tick of active) {
        database.prepare("UPDATE xhs_rpa_ticks SET status='CANCEL_REQUESTED' WHERE tick_id=?").run(tick.tick_id);
        appendInTransaction(tick.tick_id, "KILL_OBSERVED", { generation, reason: input.reason, source: "global_kill" });
      }
      return Object.freeze({ killGeneration: generation, cancelledTickCount: active.length, recurringEnabled: false });
    });
  }

  function listJournal(tickId) {
    return Object.freeze(database.prepare("SELECT * FROM xhs_rpa_journal WHERE tick_id=? ORDER BY seq").all(tickId).map((row) => Object.freeze({
      tickId: row.tick_id,
      seq: row.seq,
      type: row.type,
      payload: JSON.parse(row.payload_json),
      previousHash: row.previous_hash,
      recordHash: row.record_hash,
      createdAtMs: row.created_at_ms,
    })));
  }

  function verifyJournal(tickId) {
    const rows = listJournal(tickId);
    let previousHash = "genesis";
    for (const row of rows) {
      const expected = sha({
        tickId: row.tickId,
        seq: row.seq,
        type: row.type,
        payload: row.payload,
        previousHash,
        atMs: row.createdAtMs,
      });
      if (row.previousHash !== previousHash || row.recordHash !== expected) {
        return Object.freeze({ valid: false, length: rows.length, headHash: null });
      }
      previousHash = row.recordHash;
    }
    return Object.freeze({ valid: true, length: rows.length, headHash: rows.length ? previousHash : null });
  }

  return Object.freeze({
    registerProgram,
    status,
    reserveTick,
    recordPreIoAttempt,
    markDispatched,
    beginCleanup,
    cancelTick,
    blockTick,
    commitTick,
    disable,
    kill,
    getTick: (tickId) => rowTick(getTickRow(tickId)),
    listActiveTicks,
    listJournal,
    verifyJournal,
    getKillGeneration: () => database.prepare("SELECT kill_generation FROM xhs_rpa_meta WHERE singleton=1").get().kill_generation,
  });
}
