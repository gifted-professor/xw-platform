/**
 * stall-triage.mjs — L2 diagnostic packet + shadow decision (C2)
 * No device credentials. No auto-execution in shadow mode.
 */
import { createHash, randomUUID } from "node:crypto";

export const PACKET_SCHEMA = "xhs.l2-diagnostic-packet.v1";
export const DECISION_SCHEMA = "xhs.l2-decision.v1";

export function ensureStallTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stall_queue (
      queue_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      job_id TEXT,
      verdict_hash TEXT,
      packet_json TEXT,
      decision_json TEXT,
      state TEXT NOT NULL,
      enqueued_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS stall_queue_state_idx ON stall_queue(state, enqueued_at);
  `);
}

function nowIso() {
  return new Date().toISOString();
}

function hashOf(value) {
  return createHash("sha256").update(`${JSON.stringify(value)}\n`).digest("hex");
}

export function buildL2DiagnosticPacket({
  runId,
  jobId = null,
  stallVerdict = null,
  adapterError = null,
  failedStep = null,
  restorationOk = null,
  screenshotRef = null,
  dumpRef = null,
} = {}) {
  const packet = {
    schemaId: PACKET_SCHEMA,
    schemaVersion: 1,
    runId,
    jobId,
    failedStep,
    adapterError,
    restorationOk,
    stallVerdict: stallVerdict
      ? {
        signalType: stallVerdict.signalType,
        hash: stallVerdict.hash,
        llmEscalationRecommended: stallVerdict.llmEscalationRecommended === true,
      }
      : null,
    evidenceRefs: {
      screenshot: screenshotRef,
      dump: dumpRef,
    },
    createdAt: nowIso(),
  };
  return { ...packet, packetHash: hashOf(packet) };
}

/**
 * Shadow heuristic decision — not an LLM call. Maps verdict → recommendedAction.
 */
export function buildL2ShadowDecision(packet) {
  const signal = packet?.stallVerdict?.signalType || "unknown";
  let recommendedAction = "escalate_human";
  let diagnosisCode = "unknown_failure";
  let confidence = 0.4;
  const forbiddenActions = ["approve_r2", "approve_r3", "bypass_lease", "direct_operator"];

  if (signal === "ui_stall") {
    diagnosisCode = "ui_stall";
    recommendedAction = "retry_once";
    confidence = 0.7;
  } else if (signal === "progress_silence") {
    diagnosisCode = "progress_silence";
    recommendedAction = "recover_then_retry_once";
    confidence = 0.65;
  } else if (signal === "contract_violation") {
    diagnosisCode = "progress_contract_violation";
    recommendedAction = "escalate_human";
    confidence = 0.9;
  } else if (signal === "slow_progress") {
    diagnosisCode = "slow_but_progressing";
    recommendedAction = "no_action";
    confidence = 0.8;
  }

  const decision = {
    schemaId: DECISION_SCHEMA,
    schemaVersion: 1,
    mode: "shadow",
    diagnosisCode,
    confidence,
    recommendedAction,
    reasonCodes: [signal],
    requiredCapabilityIds: [],
    forbiddenActions,
    modelId: "shadow-heuristic-v1",
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    evidenceHashes: [packet.packetHash, packet.stallVerdict?.hash].filter(Boolean),
    packetHash: packet.packetHash,
    createdAt: nowIso(),
  };
  return { ...decision, decisionHash: hashOf(decision) };
}

export function enqueueStall(db, { runId, jobId = null, verdictHash = null, packet = null } = {}) {
  if (!runId) throw Object.assign(new Error("runId required"), { status: 400 });
  const queueId = randomUUID();
  const t = nowIso();
  db.prepare(
    `INSERT INTO stall_queue
      (queue_id, run_id, job_id, verdict_hash, packet_json, decision_json, state, enqueued_at, updated_at, last_error)
     VALUES (?, ?, ?, ?, ?, NULL, 'pending', ?, ?, NULL)`,
  ).run(
    queueId,
    runId,
    jobId,
    verdictHash,
    packet ? JSON.stringify(packet) : null,
    t,
    t,
  );
  return { queueId, state: "pending", runId, jobId };
}

export function claimNextStallItem(db) {
  const row = db
    .prepare(`SELECT * FROM stall_queue WHERE state='pending' ORDER BY enqueued_at ASC LIMIT 1`)
    .get();
  if (!row) return null;
  const t = nowIso();
  db.prepare(`UPDATE stall_queue SET state='claimed', updated_at=? WHERE queue_id=? AND state='pending'`)
    .run(t, row.queue_id);
  return row;
}

export function completeStallItem(db, queueId, { decision = null, error = null } = {}) {
  const t = nowIso();
  if (error) {
    db.prepare(
      `UPDATE stall_queue SET state='failed', last_error=?, updated_at=? WHERE queue_id=?`,
    ).run(String(error).slice(0, 500), t, queueId);
    return { queueId, state: "failed" };
  }
  db.prepare(
    `UPDATE stall_queue SET state='done', decision_json=?, updated_at=?, last_error=NULL WHERE queue_id=?`,
  ).run(decision ? JSON.stringify(decision) : null, t, queueId);
  return { queueId, state: "done" };
}
