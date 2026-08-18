/**
 * recipe-catalog.mjs — immutable Recipe Catalog (Phase 2 scaffolding)
 *
 * Pure functions over a caller-provided node:sqlite DatabaseSync-compatible db.
 * Zero deps beyond node:crypto (+ node:fs for overlay write). No console.error
 * (Windows bridge constraint).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Fixed Windows path consumed by control-plane generated-overlay loader. */
export const DEFAULT_OVERLAY_PATH =
  "C:\\Users\\Public\\xhs-agent-control\\generated-overlay\\recipe-catalog.json";

export const OVERLAY_SCHEMA_ID = "xhs.recipe-overlay.v1";
export const OVERLAY_SCHEMA_VERSION = 1;

export const RECIPE_SCHEMA_IDS = Object.freeze([
  "xhs.recipe.v1",
  "xhs.recipe-candidate.v1",
]);

/**
 * Phase 5 primitive whitelist — duplicated (intentionally) from routing
 * `control-plane/lib/recipe-interpreter.mjs` to avoid cross-repo imports.
 * Keep both lists identical.
 */
export const RECIPE_PRIMITIVE_KINDS = Object.freeze([
  "callCapability",
  "dump",
  "focus",
  "screenshot",
  "tapSelector",
  "swipe",
  "input",
  "back",
  "launch",
]);

const PRIMITIVE_SET = new Set(RECIPE_PRIMITIVE_KINDS);

export const RECIPE_STATUSES = Object.freeze([
  "observed",
  "candidate",
  "replay_verified",
  "promotable",
  "canary_only",
  "implemented",
  "degraded",
  "retired",
]);

/** Allowed directed edges of the status machine. */
export const ALLOWED_TRANSITIONS = Object.freeze({
  observed: Object.freeze(["candidate", "degraded"]),
  candidate: Object.freeze(["replay_verified", "degraded"]),
  replay_verified: Object.freeze(["promotable", "degraded"]),
  promotable: Object.freeze(["canary_only", "degraded"]),
  canary_only: Object.freeze(["implemented", "degraded"]),
  implemented: Object.freeze(["degraded"]),
  degraded: Object.freeze(["retired"]),
  retired: Object.freeze([]),
});

const ENV_FAIL_RESULTS = new Set([
  "env_fail",
  "env_failure",
  "environment",
  "lease_busy",
  "device_offline",
  "no_eligible",
  "no_eligible_device",
  "offline",
]);

const DEFAULT_LIST_STATUSES = Object.freeze([
  "implemented",
  "canary_only",
  "promotable",
  "degraded",
]);

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonicalize(value[k])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function descriptorHashOf(spec) {
  const { descriptorHash: _omit, ...rest } = spec && typeof spec === "object" ? spec : {};
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function err(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function isObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Minimal whitelist + typed-param check for ingest (mirrors routing interpreter).
 * Full live execution lives in routing `recipe-interpreter.mjs`.
 *
 * @param {unknown} steps
 * @returns {{ ok: true, steps: object[] }}
 */
export function validateRecipeSteps(steps) {
  if (!Array.isArray(steps)) throw err("executor.steps must be an array");
  if (steps.length === 0) throw err("executor.steps must be a non-empty array");

  const normalized = [];
  const seenIds = new Set();

  for (let i = 0; i < steps.length; i++) {
    const raw = steps[i];
    if (!isObject(raw)) throw err(`executor.steps[${i}] must be an object`);

    const id = isNonEmptyString(raw.id) ? String(raw.id).trim() : `step_${i + 1}`;
    if (seenIds.has(id)) throw err(`duplicate step id: ${id}`);
    seenIds.add(id);

    const kind = raw.kind;
    if (!isNonEmptyString(kind)) throw err(`step ${id}: kind is required`);
    if (!PRIMITIVE_SET.has(kind)) {
      throw err(
        `step ${id}: kind "${kind}" is not in whitelist (${RECIPE_PRIMITIVE_KINDS.join(", ")})`,
      );
    }

    const params = raw.params == null ? {} : raw.params;
    if (!isObject(params)) throw err(`step ${id}: params must be an object`);

    // Typed minimal checks (ingest gate); routing interpreter is stricter on selectors/coords.
    switch (kind) {
      case "callCapability": {
        if (!isNonEmptyString(params.capabilityId) && !isNonEmptyString(params.capability)) {
          throw err(`step ${id}: callCapability requires params.capabilityId`);
        }
        break;
      }
      case "tapSelector": {
        const hasSelector =
          isNonEmptyString(params.selector) ||
          (isObject(params.selector) && Object.keys(params.selector).length > 0);
        const hasCoords = params.x != null && params.y != null;
        if (!hasSelector && !hasCoords) {
          throw err(`step ${id}: tapSelector requires selector or x/y fallback`);
        }
        break;
      }
      case "input": {
        if (typeof params.text !== "string") {
          throw err(`step ${id}: input requires params.text string`);
        }
        break;
      }
      case "launch": {
        if (
          !isNonEmptyString(params.appId) &&
          !isNonEmptyString(params.packageName) &&
          !isNonEmptyString(params.package) &&
          !isNonEmptyString(params.app)
        ) {
          throw err(`step ${id}: launch requires params.appId or packageName`);
        }
        break;
      }
      case "focus": {
        const has =
          params.selector != null ||
          isNonEmptyString(params.resourceId) ||
          isNonEmptyString(params.text);
        if (!has) throw err(`step ${id}: focus requires selector|resourceId|text`);
        break;
      }
      case "swipe": {
        if (params.direction == null && params.from == null && params.selector == null) {
          throw err(`step ${id}: swipe requires direction, selector, or from/to`);
        }
        break;
      }
      case "dump":
      case "screenshot":
      case "back":
        break;
      default:
        throw err(`step ${id}: unknown kind ${kind}`);
    }

    if (raw.timeoutMs != null && (!Number.isInteger(raw.timeoutMs) || raw.timeoutMs < 0)) {
      throw err(`step ${id}: timeoutMs must be a non-negative integer`);
    }
    if (raw.preAssertions != null && !Array.isArray(raw.preAssertions)) {
      throw err(`step ${id}: preAssertions must be an array`);
    }
    if (raw.postAssertions != null && !Array.isArray(raw.postAssertions)) {
      throw err(`step ${id}: postAssertions must be an array`);
    }

    normalized.push({
      id,
      kind,
      params: { ...params },
      ...(raw.timeoutMs != null ? { timeoutMs: raw.timeoutMs } : {}),
      ...(Array.isArray(raw.preAssertions) ? { preAssertions: raw.preAssertions } : {}),
      ...(Array.isArray(raw.postAssertions) ? { postAssertions: raw.postAssertions } : {}),
      ...(raw.restore != null ? { restore: raw.restore } : {}),
    });
  }

  return { ok: true, steps: normalized };
}

/**
 * Validate recipe executor at ingest time.
 * - Phase 1 default: capabilityId wrapper (kind omitted / capability / capability_wrapper)
 * - Phase 5: kind === "primitive_steps" requires whitelist-validated steps
 */
export function validateRecipeExecutor(executor) {
  if (executor == null) return { kind: "capability_wrapper", optional: true };
  if (!isObject(executor)) throw err("executor must be an object");

  const rawKind = executor.kind == null ? null : String(executor.kind).trim();
  if (rawKind === "primitive_steps") {
    const validated = validateRecipeSteps(executor.steps);
    return { kind: "primitive_steps", steps: validated.steps };
  }
  if (rawKind && rawKind !== "capability" && rawKind !== "capability_wrapper") {
    throw err(`executor.kind "${rawKind}" is not supported`);
  }

  // Backward compatible: capability wrapper may omit kind.
  const capabilityId = executor.capabilityId || executor.capability;
  if (!isNonEmptyString(capabilityId)) {
    throw err("executor.capabilityId is required unless executor.kind is primitive_steps");
  }
  return {
    kind: "capability_wrapper",
    capabilityId: String(capabilityId).trim(),
    paramsTemplate: isObject(executor.paramsTemplate) ? executor.paramsTemplate : {},
  };
}

export function ensureRecipeTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recipe_versions (
      recipe_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      spec_json TEXT NOT NULL,
      descriptor_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      origin_run_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (recipe_id, revision)
    );
    CREATE INDEX IF NOT EXISTS recipe_versions_status_idx ON recipe_versions(status);
    CREATE INDEX IF NOT EXISTS recipe_versions_hash_idx ON recipe_versions(recipe_id, descriptor_hash);

    CREATE TABLE IF NOT EXISTS recipe_attempts (
      attempt_id TEXT PRIMARY KEY,
      recipe_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      run_id TEXT,
      job_id TEXT,
      result TEXT,
      verification_ok INTEGER,
      restoration_ok INTEGER,
      evidence_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS recipe_attempts_recipe_idx ON recipe_attempts(recipe_id, revision, created_at);

    CREATE TABLE IF NOT EXISTS recipe_transitions (
      transition_id TEXT PRIMARY KEY,
      recipe_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      reason TEXT,
      actor TEXT,
      receipt_hash TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS recipe_transitions_recipe_idx ON recipe_transitions(recipe_id, revision, created_at);

    CREATE TABLE IF NOT EXISTS evolve_queue (
      queue_id TEXT PRIMARY KEY,
      recipe_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      enqueued_at TEXT NOT NULL,
      state TEXT NOT NULL,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS evolve_queue_state_idx ON evolve_queue(state, enqueued_at);
  `);
  // C3 columns — idempotent ALTER for existing DBs.
  for (const sql of [
    `ALTER TABLE recipe_attempts ADD COLUMN receipt_hash TEXT`,
    `ALTER TABLE recipe_attempts ADD COLUMN receipt_json TEXT`,
    `ALTER TABLE recipe_attempts ADD COLUMN worker_window_id TEXT`,
  ]) {
    try {
      db.exec(sql);
    } catch {
      // column already exists
    }
  }
}

function assertTransition(from, to) {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw err(`illegal recipe status transition: ${from} -> ${to}`, 409);
  }
}

function insertTransition(db, { recipeId, revision, fromStatus, toStatus, reason, actor, receiptHash }) {
  assertTransition(fromStatus, toStatus);
  const transitionId = randomUUID();
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO recipe_transitions
      (transition_id, recipe_id, revision, from_status, to_status, reason, actor, receipt_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    transitionId,
    recipeId,
    revision,
    fromStatus,
    toStatus,
    reason ?? null,
    actor ?? null,
    receiptHash ?? null,
    createdAt,
  );
  db.prepare(
    `UPDATE recipe_versions SET status=? WHERE recipe_id=? AND revision=?`,
  ).run(toStatus, recipeId, revision);
  return {
    transitionId,
    recipeId,
    revision,
    fromStatus,
    toStatus,
    reason: reason ?? null,
    actor: actor ?? null,
    receiptHash: receiptHash ?? null,
    createdAt,
  };
}

function rowToVersion(row) {
  if (!row) return null;
  let spec = null;
  try {
    spec = JSON.parse(row.spec_json);
  } catch {
    spec = null;
  }
  return {
    recipeId: row.recipe_id,
    revision: row.revision,
    spec,
    descriptorHash: row.descriptor_hash,
    status: row.status,
    originRunId: row.origin_run_id,
    createdAt: row.created_at,
  };
}

/**
 * Ingest an immutable recipe revision.
 * Creates revision 1 (or next free revision when recipeId already exists and
 * caller did not pin an existing revision). Status = candidate, or observed
 * when the spec originates from knowledge.
 */
export function ingestRecipeCandidate(db, { spec, originRunId, actor } = {}) {
  if (!isObject(spec)) throw err("spec must be an object");
  const recipeId = String(spec.recipeId || "").trim();
  if (!recipeId) throw err("spec.recipeId is required");

  // Phase 5: validate executor (capability wrapper OR primitive_steps whitelist).
  if (spec.executor !== undefined) {
    validateRecipeExecutor(spec.executor);
  }

  const fromKnowledge =
    String(spec.schemaId || "").includes("knowledge") ||
    String(spec.origin || "").toLowerCase() === "knowledge" ||
    String(spec.source || "").toLowerCase() === "knowledge" ||
    Boolean(spec.fromKnowledge);

  const status = fromKnowledge ? "observed" : "candidate";
  const hash = descriptorHashOf(spec);
  const storedSpec = { ...spec, descriptorHash: hash, recipeId };
  if (storedSpec.revision == null) {
    /* filled below */
  }

  const existingMax = db
    .prepare(`SELECT MAX(revision) AS m FROM recipe_versions WHERE recipe_id=?`)
    .get(recipeId)?.m;
  let revision;
  if (Number.isInteger(spec.revision) && spec.revision >= 1) {
    revision = spec.revision;
  } else if (existingMax == null) {
    revision = 1;
  } else {
    revision = Number(existingMax) + 1;
  }
  storedSpec.revision = revision;

  const dup = db
    .prepare(`SELECT descriptor_hash, status FROM recipe_versions WHERE recipe_id=? AND revision=?`)
    .get(recipeId, revision);
  if (dup) {
    if (dup.descriptor_hash === hash) {
      throw err(
        `duplicate descriptor_hash for recipe ${recipeId}@${revision}: ${hash}`,
        409,
      );
    }
    throw err(`recipe revision immutable: ${recipeId}@${revision} already exists`, 409);
  }

  // Also reject re-ingesting the exact same descriptor under a different revision
  // when caller explicitly asked for revision 1 on a fresh id — already handled by PK.
  const sameHash = db
    .prepare(
      `SELECT revision FROM recipe_versions WHERE recipe_id=? AND descriptor_hash=? LIMIT 1`,
    )
    .get(recipeId, hash);
  if (sameHash) {
    throw err(
      `duplicate descriptor_hash for recipe ${recipeId} (existing revision ${sameHash.revision})`,
      409,
    );
  }

  const createdAt = nowIso();
  const origin = originRunId ?? spec.originRunId ?? null;
  storedSpec.originRunId = origin;
  db.prepare(
    `INSERT INTO recipe_versions
      (recipe_id, revision, spec_json, descriptor_hash, status, origin_run_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(recipeId, revision, canonicalJson(storedSpec), hash, status, origin, createdAt);

  // Seed transition row (null -> initial status) without going through assertTransition.
  const transitionId = randomUUID();
  db.prepare(
    `INSERT INTO recipe_transitions
      (transition_id, recipe_id, revision, from_status, to_status, reason, actor, receipt_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    transitionId,
    recipeId,
    revision,
    null,
    status,
    fromKnowledge ? "ingest_from_knowledge" : "ingest_candidate",
    actor ?? null,
    hash,
    createdAt,
  );

  return rowToVersion(
    db.prepare(`SELECT * FROM recipe_versions WHERE recipe_id=? AND revision=?`).get(recipeId, revision),
  );
}

export function recordAttempt(db, attempt = {}) {
  const recipeId = String(attempt.recipeId || "").trim();
  const revision = Number(attempt.revision);
  if (!recipeId) throw err("attempt.recipeId is required");
  if (!Number.isInteger(revision) || revision < 1) throw err("attempt.revision must be a positive integer");

  const version = db
    .prepare(`SELECT recipe_id FROM recipe_versions WHERE recipe_id=? AND revision=?`)
    .get(recipeId, revision);
  if (!version) throw err(`recipe not found: ${recipeId}@${revision}`, 404);

  // C3: refuse client-trusted success unless explicitly legacy (tests / migration).
  if (attempt.legacyClientTrust !== true) {
    if (attempt.verificationOk === true || attempt.restorationOk === true
      || ["ok", "success", "succeeded", "pass", "passed"].includes(String(attempt.result || "").toLowerCase())) {
      throw err(
        "client-trusted verificationOk/restorationOk/result are rejected; use recordVerifiedAttempt",
        400,
      );
    }
  }

  const attemptId = String(attempt.attemptId || randomUUID());
  const createdAt = attempt.createdAt || nowIso();
  const evidenceJson = attempt.evidenceJson != null
    ? (typeof attempt.evidenceJson === "string" ? attempt.evidenceJson : canonicalJson(attempt.evidenceJson))
    : (attempt.evidence != null ? canonicalJson(attempt.evidence) : null);

  db.prepare(
    `INSERT INTO recipe_attempts
      (attempt_id, recipe_id, revision, run_id, job_id, result, verification_ok, restoration_ok, evidence_json, created_at, receipt_hash, receipt_json, worker_window_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    attemptId,
    recipeId,
    revision,
    attempt.runId ?? null,
    attempt.jobId ?? null,
    attempt.result ?? null,
    attempt.verificationOk == null ? null : attempt.verificationOk ? 1 : 0,
    attempt.restorationOk == null ? null : attempt.restorationOk ? 1 : 0,
    evidenceJson,
    createdAt,
    attempt.receiptHash ?? null,
    attempt.receiptJson ?? null,
    attempt.workerWindowId ?? null,
  );

  return {
    attemptId,
    recipeId,
    revision,
    runId: attempt.runId ?? null,
    jobId: attempt.jobId ?? null,
    result: attempt.result ?? null,
    verificationOk: attempt.verificationOk == null ? null : Boolean(attempt.verificationOk),
    restorationOk: attempt.restorationOk == null ? null : Boolean(attempt.restorationOk),
    evidenceJson,
    receiptHash: attempt.receiptHash ?? null,
    workerWindowId: attempt.workerWindowId ?? null,
    createdAt,
  };
}

/**
 * Server-verified attempt: facts from control-plane job receipt only.
 */
export function recordVerifiedAttempt(db, {
  recipeId,
  revision,
  runId,
  jobId,
  workerWindowId = null,
  receipt,
} = {}) {
  if (!receipt?.ok || !receipt.receipt?.receiptHash) {
    throw err(receipt?.message || "attempt receipt verification failed", 409);
  }
  const r = receipt.receipt;
  if (r.recipeId !== recipeId || Number(r.revision) !== Number(revision)) {
    throw err("receipt recipeId/revision mismatch", 409);
  }
  if (r.runId !== runId || r.jobId !== jobId) {
    throw err("receipt runId/jobId mismatch", 409);
  }
  return recordAttempt(db, {
    recipeId,
    revision,
    runId,
    jobId,
    result: receipt.result || "succeeded",
    verificationOk: receipt.verificationOk === true,
    restorationOk: receipt.restorationOk === true,
    evidence: {
      evidenceIds: r.evidenceIds,
      evidenceHashes: r.evidenceHashes,
    },
    receiptHash: r.receiptHash,
    receiptJson: canonicalJson(r),
    workerWindowId: workerWindowId || r.workerWindowId || null,
    legacyClientTrust: true, // already server-verified
  });
}

export function degradeRecipe(db, {
  recipeId,
  revision,
  reason = "untrusted_or_quality_failure",
  actor = "degradeRecipe",
  receiptHash,
} = {}) {
  const id = String(recipeId || "").trim();
  const rev = Number(revision);
  if (!id) throw err("recipeId is required");
  if (!Number.isInteger(rev) || rev < 1) throw err("revision must be a positive integer");
  if (!receiptHash || typeof receiptHash !== "string") {
    throw err("degrade requires non-null receiptHash", 400);
  }
  const row = db
    .prepare(`SELECT * FROM recipe_versions WHERE recipe_id=? AND revision=?`)
    .get(id, rev);
  if (!row) throw err(`recipe not found: ${id}@${rev}`, 404);
  if (row.status === "degraded" || row.status === "retired") {
    return { recipeId: id, revision: rev, status: row.status, changed: false, transitions: [] };
  }
  const t = insertTransition(db, {
    recipeId: id,
    revision: rev,
    fromStatus: row.status,
    toStatus: "degraded",
    reason,
    actor,
    receiptHash,
  });
  return {
    recipeId: id,
    revision: rev,
    status: "degraded",
    changed: true,
    transitions: [t],
  };
}

function isEnvFailure(result) {
  if (result == null) return false;
  const r = String(result).toLowerCase();
  if (ENV_FAIL_RESULTS.has(r)) return true;
  return r.startsWith("env_") || r.includes("lease_busy") || r.includes("offline");
}

function listIndependentSuccesses(db, recipeId, revision) {
  const rows = db
    .prepare(
      `SELECT attempt_id, run_id, job_id, result, verification_ok, restoration_ok, receipt_hash, worker_window_id
       FROM recipe_attempts
       WHERE recipe_id=? AND revision=?
       ORDER BY created_at ASC`,
    )
    .all(recipeId, revision);

  const seen = new Set();
  const seenWindows = new Set();
  const successes = [];
  for (const row of rows) {
    if (isEnvFailure(row.result)) continue;
    if (row.verification_ok !== 1 || row.restoration_ok !== 1) continue;
    // C3: unsigned attempts never count toward promotion.
    if (!row.receipt_hash) continue;
    const resultOk =
      row.result == null ||
      ["ok", "success", "succeeded", "pass", "passed"].includes(String(row.result).toLowerCase());
    if (!resultOk) continue;
    const key = `${row.run_id || ""}::${row.job_id || ""}`;
    if (seen.has(key)) continue;
    if (!row.run_id || !row.job_id) continue;
    const independent = successes.every(
      (s) => row.run_id !== s.runId && row.job_id !== s.jobId,
    );
    if (successes.length > 0 && !independent) continue;
    const windowId = row.worker_window_id || null;
    if (windowId) {
      if (seenWindows.has(windowId)) continue;
      seenWindows.add(windowId);
    }
    seen.add(key);
    successes.push({
      attemptId: row.attempt_id,
      runId: row.run_id,
      jobId: row.job_id,
      receiptHash: row.receipt_hash,
      workerWindowId: windowId,
    });
  }
  return successes;
}

/**
 * Promotion evaluator.
 * - 2 independent successes while status is replay_verified|promotable (or candidate,
 *   which is auto-advanced through the legal chain) → canary_only
 * - 2 more (total ≥ 4) while canary_only → implemented
 * - Env failures never change status
 * - Auto transitions require non-null receiptHash (hash of success receipt hashes)
 */
export function evaluatePromotion(db, recipeId, revision) {
  const id = String(recipeId || "").trim();
  const rev = Number(revision);
  if (!id) throw err("recipeId is required");
  if (!Number.isInteger(rev) || rev < 1) throw err("revision must be a positive integer");

  const row = db
    .prepare(`SELECT * FROM recipe_versions WHERE recipe_id=? AND revision=?`)
    .get(id, rev);
  if (!row) throw err(`recipe not found: ${id}@${rev}`, 404);

  const successes = listIndependentSuccesses(db, id, rev);
  const transitions = [];
  let status = row.status;

  const receiptHashFor = (slice) => createHash("sha256")
    .update(slice.map((s) => s.receiptHash).join("|"))
    .digest("hex");

  const advance = (to, reason, slice) => {
    const receiptHash = receiptHashFor(slice);
    if (!receiptHash) throw err("promotion refused: empty receiptHash", 409);
    const t = insertTransition(db, {
      recipeId: id,
      revision: rev,
      fromStatus: status,
      toStatus: to,
      reason,
      actor: "evaluatePromotion",
      receiptHash,
    });
    transitions.push(t);
    status = to;
  };

  if (["candidate", "replay_verified", "promotable"].includes(status) && successes.length >= 2) {
    const slice = successes.slice(0, 2);
    // Same-device windows: require at least 2 distinct workerWindowId when present.
    const windows = new Set(slice.map((s) => s.workerWindowId).filter(Boolean));
    if (windows.size === 1 && slice.every((s) => s.workerWindowId)) {
      // both same window — not enough independence
    } else {
      if (status === "candidate") advance("replay_verified", "two_independent_successes", slice);
      if (status === "replay_verified") advance("promotable", "two_independent_successes", slice);
      if (status === "promotable") advance("canary_only", "two_independent_successes", slice);
    }
  }

  if (status === "canary_only" && successes.length >= 4) {
    const slice = successes.slice(0, 4);
    const windows = new Set(slice.map((s) => s.workerWindowId).filter(Boolean));
    if (!(windows.size === 1 && slice.every((s) => s.workerWindowId))) {
      advance("implemented", "two_additional_independent_successes", slice);
    }
  }

  return {
    recipeId: id,
    revision: rev,
    status,
    independentSuccesses: successes.length,
    successes,
    transitions,
    changed: transitions.length > 0,
  };
}

export function enqueueEvolve(db, { recipeId, revision } = {}) {
  const id = String(recipeId || "").trim();
  const rev = Number(revision);
  if (!id) throw err("recipeId is required");
  if (!Number.isInteger(rev) || rev < 1) throw err("revision must be a positive integer");

  const version = db
    .prepare(`SELECT recipe_id FROM recipe_versions WHERE recipe_id=? AND revision=?`)
    .get(id, rev);
  if (!version) throw err(`recipe not found: ${id}@${rev}`, 404);

  const pending = db
    .prepare(
      `SELECT queue_id FROM evolve_queue
       WHERE recipe_id=? AND revision=? AND state IN ('queued','running')
       LIMIT 1`,
    )
    .get(id, rev);
  if (pending) {
    return {
      queueId: pending.queue_id,
      recipeId: id,
      revision: rev,
      state: "queued",
      deduped: true,
    };
  }

  const queueId = randomUUID();
  const enqueuedAt = nowIso();
  db.prepare(
    `INSERT INTO evolve_queue (queue_id, recipe_id, revision, enqueued_at, state, last_error)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(queueId, id, rev, enqueuedAt, "queued", null);

  return {
    queueId,
    recipeId: id,
    revision: rev,
    enqueuedAt,
    state: "queued",
    deduped: false,
  };
}

export function listRecipes(db, { status, includeAll } = {}) {
  let rows;
  if (status) {
    rows = db
      .prepare(
        `SELECT * FROM recipe_versions WHERE status=? ORDER BY recipe_id, revision DESC`,
      )
      .all(String(status));
  } else if (includeAll) {
    rows = db
      .prepare(`SELECT * FROM recipe_versions ORDER BY recipe_id, revision DESC`)
      .all();
  } else {
    const placeholders = DEFAULT_LIST_STATUSES.map(() => "?").join(",");
    rows = db
      .prepare(
        `SELECT * FROM recipe_versions WHERE status IN (${placeholders})
         ORDER BY recipe_id, revision DESC`,
      )
      .all(...DEFAULT_LIST_STATUSES);
  }
  return rows.map(rowToVersion);
}

export function getRecipe(db, recipeId) {
  const id = String(recipeId || "").trim();
  if (!id) throw err("recipeId is required");
  const versions = db
    .prepare(`SELECT * FROM recipe_versions WHERE recipe_id=? ORDER BY revision DESC`)
    .all(id)
    .map(rowToVersion);
  if (!versions.length) throw err(`recipe not found: ${id}`, 404);

  const attempts = db
    .prepare(
      `SELECT * FROM recipe_attempts WHERE recipe_id=? ORDER BY created_at DESC`,
    )
    .all(id)
    .map((r) => ({
      attemptId: r.attempt_id,
      recipeId: r.recipe_id,
      revision: r.revision,
      runId: r.run_id,
      jobId: r.job_id,
      result: r.result,
      verificationOk: r.verification_ok == null ? null : Boolean(r.verification_ok),
      restorationOk: r.restoration_ok == null ? null : Boolean(r.restoration_ok),
      evidenceJson: r.evidence_json,
      createdAt: r.created_at,
    }));

  const transitions = db
    .prepare(
      `SELECT * FROM recipe_transitions WHERE recipe_id=? ORDER BY created_at ASC`,
    )
    .all(id)
    .map((r) => ({
      transitionId: r.transition_id,
      recipeId: r.recipe_id,
      revision: r.revision,
      fromStatus: r.from_status,
      toStatus: r.to_status,
      reason: r.reason,
      actor: r.actor,
      receiptHash: r.receipt_hash,
      createdAt: r.created_at,
    }));

  const queue = db
    .prepare(
      `SELECT * FROM evolve_queue WHERE recipe_id=? ORDER BY enqueued_at DESC`,
    )
    .all(id)
    .map((r) => ({
      queueId: r.queue_id,
      recipeId: r.recipe_id,
      revision: r.revision,
      enqueuedAt: r.enqueued_at,
      state: r.state,
      lastError: r.last_error,
    }));

  return {
    recipeId: id,
    latest: versions[0],
    versions,
    attempts,
    transitions,
    queue,
  };
}

export function listEvolveQueue(db, { state } = {}) {
  const rows = state
    ? db
        .prepare(`SELECT * FROM evolve_queue WHERE state=? ORDER BY enqueued_at ASC`)
        .all(String(state))
    : db.prepare(`SELECT * FROM evolve_queue ORDER BY enqueued_at DESC`).all();
  return rows.map((r) => ({
    queueId: r.queue_id,
    recipeId: r.recipe_id,
    revision: r.revision,
    enqueuedAt: r.enqueued_at,
    state: r.state,
    lastError: r.last_error,
  }));
}

/**
 * Claim next pending/queued evolve item (FIFO). Marks it running.
 * Accepts both `queued` (current enqueueEvolve) and `pending` (alias).
 */
export function claimNextEvolveItem(db) {
  const row = db
    .prepare(
      `SELECT * FROM evolve_queue
       WHERE state IN ('queued', 'pending')
       ORDER BY enqueued_at ASC
       LIMIT 1`,
    )
    .get();
  if (!row) return null;
  db.prepare(`UPDATE evolve_queue SET state=?, last_error=? WHERE queue_id=?`).run(
    "running",
    null,
    row.queue_id,
  );
  return {
    queueId: row.queue_id,
    recipeId: row.recipe_id,
    revision: row.revision,
    enqueuedAt: row.enqueued_at,
    state: "running",
    lastError: null,
  };
}

export function setEvolveQueueState(db, queueId, state, lastError = null) {
  const id = String(queueId || "").trim();
  if (!id) throw err("queueId is required");
  const to = String(state || "").trim();
  if (!to) throw err("state is required");
  const existing = db.prepare(`SELECT queue_id FROM evolve_queue WHERE queue_id=?`).get(id);
  if (!existing) throw err(`evolve queue item not found: ${id}`, 404);
  db.prepare(`UPDATE evolve_queue SET state=?, last_error=? WHERE queue_id=?`).run(
    to,
    lastError == null ? null : String(lastError),
    id,
  );
  return { queueId: id, state: to, lastError: lastError == null ? null : String(lastError) };
}

/**
 * Build sealed overlay document from canary_only + implemented recipes.
 * sha256 is over the canonical body WITHOUT the sha256 field itself.
 */
export function buildOverlayDocument(db, { generatedAt = nowIso() } = {}) {
  const canary = listRecipes(db, { status: "canary_only" });
  const implemented = listRecipes(db, { status: "implemented" });
  // Dedup by recipeId@revision (prefer higher status if both somehow present).
  const seen = new Set();
  const recipes = [];
  for (const v of [...implemented, ...canary]) {
    const key = `${v.recipeId}@${v.revision}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const spec = v.spec && typeof v.spec === "object" ? v.spec : {};
    const eligibleAliases = Array.isArray(spec.eligibleAliases)
      ? spec.eligibleAliases.map(String)
      : v.status === "canary_only"
        ? ["01"]
        : undefined;
    const entry = {
      recipeId: v.recipeId,
      revision: v.revision,
      status: v.status,
      executor: spec.executor ?? null,
      riskCeiling: String(spec.riskCeiling || "R1"),
      descriptorHash: v.descriptorHash,
    };
    if (eligibleAliases) entry.eligibleAliases = eligibleAliases;
    recipes.push(entry);
  }
  recipes.sort((a, b) => {
    const c = String(a.recipeId).localeCompare(String(b.recipeId));
    if (c !== 0) return c;
    return a.revision - b.revision;
  });

  const body = {
    schemaId: OVERLAY_SCHEMA_ID,
    schemaVersion: OVERLAY_SCHEMA_VERSION,
    generatedAt,
    recipes,
  };
  const sha256 = createHash("sha256").update(canonicalJson(body)).digest("hex");
  return { ...body, sha256 };
}

/**
 * Atomically write overlay JSON + `.sha256` sidecar (temp + rename).
 */
export function writeOverlayAtomically(doc, { path = DEFAULT_OVERLAY_PATH } = {}) {
  if (!doc || typeof doc !== "object") throw err("overlay doc must be an object");
  if (typeof doc.sha256 !== "string" || !doc.sha256) throw err("overlay doc.sha256 required");
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const payload = `${JSON.stringify(doc, null, 2)}\n`;
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, payload, "utf8");
  renameSync(tmp, path);
  const sidecar = `${path}.sha256`;
  writeFileSync(sidecar, `${doc.sha256}\n`, "utf8");
  return {
    path,
    sidecar,
    sha256: doc.sha256,
    recipeCount: Array.isArray(doc.recipes) ? doc.recipes.length : 0,
  };
}

/** Convenience: build from db then atomically write. */
export function writeOverlayFromDb(db, { path = DEFAULT_OVERLAY_PATH } = {}) {
  const doc = buildOverlayDocument(db);
  const written = writeOverlayAtomically(doc, { path });
  return { doc, ...written };
}
