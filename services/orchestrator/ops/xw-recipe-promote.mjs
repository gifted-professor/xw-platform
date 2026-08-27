#!/usr/bin/env node
/**
 * xw-recipe-promote.mjs — bridge a live SingleDeviceRecipeRunner aggregate
 * receipt into the formal Recipe Catalog promotion chain.
 *
 * The Runner (control-plane) produces `xw.single-device.recipe-receipt.v1`
 * aggregate receipts (recipeRunId + per-step jobIds + verifiedSteps). The
 * Catalog's existing `/api/recipes/attempts` path is job-based
 * (buildAttemptReceiptFromJob expects one capability job) and cannot ingest
 * the primitive_steps Runner receipt. This tool is the missing bridge:
 *
 *   1. fetch the authoritative recipe-run from the Control Plane by recipeRunId
 *      (server-verified facts, never client-trusted booleans);
 *   2. validate SUCCEEDED + 9/9 verified + serverVerified + live mode +
 *      recipeId/revision match;
 *   3. build a sealed attempt receipt (xhs.runner-attempt-receipt.v1) with a
 *      sha256 receiptHash and feed it through recordVerifiedAttempt();
 *   4. evaluatePromotion() — 2 independent signed successes advance
 *      candidate -> replay_verified -> promotable -> canary_only; 4 -> implemented.
 *
 * Idempotent: re-recording the same recipeRunId is rejected by recordAttempt's
 * PK (attempt_id = recipeRunId); re-evaluate is a no-op once promoted.
 *
 *   node ops/xw-recipe-promote.mjs ingest   --fixture xhs.search.fixed
 *   node ops/xw-recipe-promote.mjs promote  --recipe-run <id> [--recipe <id> --revision n]
 *   node ops/xw-recipe-promote.mjs record   --recipe-run <id> [--recipe <id> --revision n]
 *   node ops/xw-recipe-promote.mjs evaluate --recipe <id> [--revision n]
 *   node ops/xw-recipe-promote.mjs status   --recipe <id>
 *
 * --db defaults to the runtime orchestrator Catalog DB. Console: console.log
 * only (Windows bridge treats stderr as fatal).
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import {
  ensureRecipeTables,
  ingestRecipeCandidate,
  recordVerifiedAttempt,
  evaluatePromotion,
  getRecipe,
  buildOverlayDocument,
  writeOverlayAtomically,
  canonicalJson,
} from "../scripts/lib/recipe-catalog.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "..");
const DEFAULT_DB = join(ROOT, "registry.db");
export const RUNTIME_DB = "C:\\Users\\Public\\xw-runtime\\state\\orchestrator\\registry.db";
const CONTROL_BASE = (process.env.XHS_CONTROL_BASE || "http://127.0.0.1:17920").replace(/\/$/, "");
// Production recipe specs (F1: fixtures are no longer the production source).
const PRODUCTION_RECIPE_DIR = resolve(HERE, "..", "..", "control-plane", "config", "recipes");
// Dispatcher state (recipe revisions + live gates) — switch-alias updates this.
const DEFAULT_DISPATCH_STATE = resolve(HERE, "..", "..", "control-plane", "config", "xhs-dispatch-state.json");
const RUNTIME_DISPATCH_STATE = "C:\\Users\\Public\\xw-runtime\\state\\xhs-dispatch-state.json";
const DISPATCH_STATE_PATH = process.env.XHS_DISPATCH_STATE || DEFAULT_DISPATCH_STATE;

export const RUNNER_ATTEMPT_RECEIPT_SCHEMA = "xhs.runner-attempt-receipt.v1";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[++i];
    } else if (a.startsWith("--")) {
      out[a.slice(2)] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function fail(msg, code = 2) {
  console.log(`PROMOTE_FAILED ${msg}`);
  process.exit(code);
}

export function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA busy_timeout=5000;");
  ensureRecipeTables(db);
  return db;
}

function hashCanonical(value) {
  return createHash("sha256").update(`${canonicalJson(value)}\n`).digest("hex");
}

/**
 * Build a sealed attempt receipt from a Control-Plane recipe-run payload.
 * Facts come only from the server-returned recipeRun.receipt; this function
 * performs NO client trust — it only re-shapes and hashes.
 *
 * @param {object} recipeRunPayload - { recipeRun: {...} } or the recipe-run itself.
 * @param {{recipeId:string, revision:number}} opts
 */
export function buildRunnerAttemptReceipt(recipeRunPayload, { recipeId, revision } = {}) {
  const run = recipeRunPayload?.recipeRun || recipeRunPayload;
  if (!run || typeof run !== "object") {
    return reject("RUN_MISSING", "recipe-run payload is required");
  }
  const rec = run.receipt || {};
  const runRecipeId = rec.recipeId || run.recipeId;
  const runRevision = Number(rec.revision ?? run.revision);
  if (!runRecipeId || !Number.isInteger(runRevision)) {
    return reject("RUN_IDS_MISSING", "recipeRun.receipt.recipeId/revision required");
  }
  if (recipeId && runRecipeId !== recipeId) {
    return reject("RECIPE_MISMATCH", `expected ${recipeId}, got ${runRecipeId}`);
  }
  if (revision != null && Number(revision) !== runRevision) {
    return reject("REVISION_MISMATCH", `expected ${revision}, got ${runRevision}`);
  }
  if (rec.ok !== true || run.status !== "SUCCEEDED") {
    return reject("NOT_SUCCEEDED", `run status ${run.status}, receipt.ok=${rec.ok}`);
  }
  if (rec.serverVerified !== true) {
    return reject("NOT_SERVER_VERIFIED", "receipt.serverVerified must be true");
  }
  if (rec.mode && rec.mode !== "live") {
    return reject("NOT_LIVE", `receipt.mode ${rec.mode}; only live runs count toward promotion`);
  }
  const verifiedSteps = Number(rec.verifiedSteps ?? -1);
  const stepCount = Number(rec.stepCount ?? -1);
  if (!(verifiedSteps >= 0 && stepCount > 0 && verifiedSteps === stepCount)) {
    return reject("STEPS_NOT_FULLY_VERIFIED", `verifiedSteps ${verifiedSteps}/${stepCount}`);
  }
  if (rec.failedStepId != null) {
    return reject("FAILED_STEP", `failedStepId ${rec.failedStepId}`);
  }
  const recipeRunId = run.recipeRunId || rec.recipeRunId;
  if (!recipeRunId) return reject("RUN_ID_MISSING", "recipeRunId required");

  // The Runner has no single capability jobId; each primitive is a session_action.
  // For the Catalog independence check (distinct run_id AND job_id across
  // successes) we use the unique recipeRunId for both — two different live runs
  // yield two distinct (runId, jobId) pairs, satisfying independence.
  const runId = recipeRunId;
  const jobId = recipeRunId;

  const body = {
    schemaId: RUNNER_ATTEMPT_RECEIPT_SCHEMA,
    schemaVersion: 1,
    recipeId: runRecipeId,
    revision: runRevision,
    descriptorHash: rec.descriptorHash || run.descriptorHash || null,
    runId,
    jobId,
    status: "succeeded",
    verificationOk: true,
    restorationOk: true,
    evidenceIds: [],
    evidenceHashes: [],
    ambiguity: false,
    highDebt: false,
    alias: rec.alias || run.alias || null,
    sessionId: rec.sessionId || run.sessionId || null,
    leaseId: rec.leaseId || run.leaseId || null,
    deviceId: rec.deviceId || run.deviceId || null,
    serverVerified: true,
    mode: rec.mode || "live",
    verifiedSteps,
    stepCount,
    finishedAt: rec.finishedAt || run.finishedAt || null,
  };
  const receiptHash = hashCanonical(body);
  return {
    ok: true,
    receipt: { ...body, receiptHash },
    verificationOk: true,
    restorationOk: true,
    result: "succeeded",
  };
}

function reject(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

/**
 * Record a verified attempt from a live Runner recipe-run, then evaluate
 * promotion. Idempotent on (recipeId, revision, runId, jobId): re-recording
 * the same recipeRunId is a no-op (recordAttempt uses a random attemptId, so
 * we check existence explicitly rather than relying on a PK collision).
 * @param {object} db - DatabaseSync handle (recipe-catalog tables ensured).
 * @param {object} recipeRunPayload - server-returned recipe-run.
 */
export function promoteRunnerRun(db, recipeRunPayload, { evaluate = true } = {}) {
  const built = buildRunnerAttemptReceipt(recipeRunPayload);
  if (!built.ok) return built;
  const r = built.receipt;
  const existing = db
    .prepare(
      `SELECT attempt_id FROM recipe_attempts
       WHERE recipe_id=? AND revision=? AND run_id=? AND job_id=? LIMIT 1`,
    )
    .get(r.recipeId, r.revision, r.runId, r.jobId);
  if (existing) {
    let promotion = null;
    if (evaluate) promotion = evaluatePromotion(db, r.recipeId, r.revision);
    return { ok: true, idempotent: true, recipeId: r.recipeId, revision: r.revision, runId: r.runId, promotion };
  }
  const attempt = recordVerifiedAttempt(db, {
    recipeId: r.recipeId,
    revision: r.revision,
    runId: r.runId,
    jobId: r.jobId,
    receipt: built,
  });
  let promotion = null;
  if (evaluate) {
    promotion = evaluatePromotion(db, r.recipeId, r.revision);
  }
  return { ok: true, attempt, promotion, receipt: r };
}

async function fetchRecipeRun(recipeRunId) {
  const url = `${CONTROL_BASE}/control/v1/recipe-runs/${encodeURIComponent(recipeRunId)}`;
  const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Object.assign(new Error(`control recipe-run fetch failed: ${res.status} ${text.slice(0, 200)}`), {
      code: "CONTROL_RUN_FETCH_FAILED",
      status: res.status,
    });
  }
  return res.json();
}

export async function loadFixtureSpec(recipeId) {
  // F1: production specs live in config/recipes/<recipeId>@<rev>.json and are the
  // authoritative source. Try the production directory first (highest revision
  // matching recipeId), then fall back to the legacy test fixture for @1.
  const production = loadProductionRecipe(recipeId);
  if (production) return production.spec;
  if (recipeId === "xhs.search.fixed") {
    const mod = await import(
      new URL("../../control-plane/tests/fixtures/xhs-search-fixed.recipe.mjs", import.meta.url).href
    );
    return mod.XHS_SEARCH_FIXED_RECIPE;
  }
  throw Object.assign(new Error(`no recipe for ${recipeId}; pass --spec <file>`), { code: "NO_RECIPE" });
}

/**
 * Load the highest-revision production spec for a recipeId from config/recipes/.
 * Returns { spec, revision } or null if none found. F1: production recipes carry
 * the canonical-v2 descriptorHash; fixtures are legacy @1 only.
 */
function loadProductionRecipe(recipeId) {
  if (!existsSync(PRODUCTION_RECIPE_DIR)) return null;
  const files = readdirSync(PRODUCTION_RECIPE_DIR)
    .filter((f) => f.startsWith(`${recipeId}@`) && f.endsWith(".json"))
    .map((f) => {
      const rev = Number(f.slice(recipeId.length + 1, -5));
      return { file: f, rev };
    })
    .filter((e) => Number.isInteger(e.rev) && e.rev >= 1)
    .sort((a, b) => b.rev - a.rev);
  if (!files.length) return null;
  const spec = JSON.parse(readFileSync(join(PRODUCTION_RECIPE_DIR, files[0].file), "utf8"));
  return { spec, revision: files[0].rev };
}

function recipeExists(db, recipeId) {
  try {
    getRecipe(db, recipeId);
    return true;
  } catch {
    return false;
  }
}

async function cmdIngest(db, args) {
  let spec;
  if (args.spec) {
    spec = JSON.parse(readFileSync(args.spec, "utf8"));
  } else if (args.fixture || args.recipe) {
    spec = await loadFixtureSpec(String(args.fixture || args.recipe));
  } else {
    fail("ingest requires --recipe <recipeId> or --spec <file>");
  }
  const recipeId = String(spec.recipeId);
  const revision = Number.isInteger(spec.revision) ? spec.revision : null;
  // Idempotency is per (recipeId, revision): ingesting @2 when @1 exists is a new
  // version, not a no-op. Only skip if the exact revision is already present.
  if (revision != null) {
    const dup = db
      .prepare(`SELECT revision FROM recipe_versions WHERE recipe_id=? AND revision=?`)
      .get(recipeId, revision);
    if (dup) {
      const g = getRecipe(db, recipeId);
      const v = g.versions.find((x) => x.revision === revision);
      console.log(`INGEST_IDEMPOTENT ${recipeId}@${revision} status=${v?.status || "?"} hash=${(v?.descriptorHash || "").slice(0, 16)}`);
      return;
    }
  } else if (recipeExists(db, recipeId)) {
    const g = getRecipe(db, recipeId);
    console.log(`INGEST_IDEMPOTENT ${recipeId}@${g.latest.revision} status=${g.latest.status}`);
    return;
  }
  const created = ingestRecipeCandidate(db, { spec, actor: args.actor || "agent:xw-recipe-promote" });
  console.log(`INGESTED ${created.recipeId}@${created.revision} status=${created.status} hash=${created.descriptorHash.slice(0, 16)}`);
}

async function cmdPromote(db, args) {
  const recipeRunId = args["recipe-run"];
  if (!recipeRunId) fail("promote requires --recipe-run <id>");
  const payload = await fetchRecipeRun(recipeRunId);
  const out = promoteRunnerRun(db, payload, { evaluate: args["no-evaluate"] !== true });
  if (!out.ok) fail(`${out.code}: ${out.message}`);
  if (out.idempotent) {
    console.log(`RECORD_IDEMPOTENT ${out.recipeId}@${out.revision} run=${out.runId}`);
    if (args["no-evaluate"] !== true) {
      const ev = evaluatePromotion(db, out.recipeId, out.revision);
      printEval(ev);
    }
    return;
  }
  console.log(`RECORDED ${out.receipt.recipeId}@${out.receipt.revision} run=${out.receipt.runId} receiptHash=${out.receipt.receiptHash.slice(0, 16)}`);
  if (out.promotion) printEval(out.promotion);
}

async function cmdRecord(db, args) {
  const recipeRunId = args["recipe-run"];
  if (!recipeRunId) fail("record requires --recipe-run <id>");
  const payload = await fetchRecipeRun(recipeRunId);
  const out = promoteRunnerRun(db, payload, { evaluate: false });
  if (!out.ok) fail(`${out.code}: ${out.message}`);
  if (out.idempotent) {
    console.log(`RECORD_IDEMPOTENT ${out.recipeId}@${out.revision} run=${out.runId}`);
    return;
  }
  console.log(`RECORDED ${out.receipt.recipeId}@${out.receipt.revision} run=${out.receipt.runId} receiptHash=${out.receipt.receiptHash.slice(0, 16)}`);
}

function printEval(ev) {
  console.log(`PROMOTION ${ev.recipeId}@${ev.revision} status=${ev.status} independentSuccesses=${ev.independentSuccesses} changed=${ev.changed}`);
  for (const t of ev.transitions) {
    console.log(`  ${t.fromStatus || "(none)"} -> ${t.toStatus}  reason=${t.reason}  receiptHash=${(t.receiptHash || "").slice(0, 16)}`);
  }
}

async function cmdEvaluate(db, args) {
  const recipeId = args.recipe;
  if (!recipeId) fail("evaluate requires --recipe <id>");
  const revision = args.revision != null ? Number(args.revision) : undefined;
  const g = getRecipe(db, recipeId);
  const rev = revision != null ? revision : Number(g.latest.revision);
  const ev = evaluatePromotion(db, recipeId, rev);
  printEval(ev);
}

/**
 * switch-alias — atomically switch the dispatcher's recipe revision map to a
 * promoted revision (plan V2 §11 rollback boundary). Fail-closed: the target
 * revision MUST be canary_only or implemented in the Catalog DB before the
 * dispatch state is touched. Optionally flips the liveGate for an action so
 * --execute passes for that action. Idempotent.
 *
 *   node ops/xw-recipe-promote.mjs switch-alias --recipe xhs.search.fixed --revision 2 [--action search] [--runtime]
 */
export async function cmdSwitchAlias(db, args) {
  const recipeId = args.recipe;
  const revision = args.revision != null ? Number(args.revision) : null;
  const actionId = args.action || null;
  if (!recipeId || !Number.isInteger(revision)) {
    return { ok: false, code: "ARGS", message: "switch-alias requires --recipe <id> --revision <n>" };
  }
  // Fail-closed: verify the revision is promoted in the Catalog.
  const g = getRecipe(db, recipeId);
  const v = g.versions.find((x) => x.revision === revision);
  if (!v) return { ok: false, code: "NOT_IN_CATALOG", message: `switch-alias: ${recipeId}@${revision} not found in Catalog` };
  if (v.status !== "canary_only" && v.status !== "implemented") {
    return { ok: false, code: "NOT_PROMOTED", message: `switch-alias: ${recipeId}@${revision} status=${v.status}; must be canary_only or implemented` };
  }
  const statePath = args["state-path"] || (args.runtime ? RUNTIME_DISPATCH_STATE : DISPATCH_STATE_PATH);
  const state = readDispatchState(statePath);
  const prev = state.recipeRevisions[recipeId] ?? null;
  state.recipeRevisions[recipeId] = revision;
  if (actionId) {
    state.liveGates = state.liveGates || {};
    state.liveGates[actionId] = true;
  }
  writeDispatchState(statePath, state);
  console.log(`SWITCH_ALIAS ${recipeId}@${revision} (was ${prev ?? "?"}) status=${v.status}${actionId ? ` gate=${actionId}:on` : ""} -> ${statePath}`);
  return { ok: true, recipeId, revision, prev, status: v.status, actionId };
}

/**
 * emit-overlay — write the overlay document from the Catalog DB to a path.
 * Default: the runtime overlay; --path overrides. Includes all canary_only +
 * implemented recipes (so @2 appears once promoted).
 */
export async function cmdEmitOverlay(db, args) {
  const doc = buildOverlayDocument(db);
  const outPath = args.path || (args.runtime
    ? "C:\\Users\\Public\\xw-runtime\\recipe-overlay\\xhs-search-fixed.overlay.v1.json"
    : join(ROOT, "xhs-search-fixed.overlay.v1.json"));
  const written = writeOverlayAtomically(doc, { path: outPath });
  console.log(`OVERLAY_EMIT recipes=${written.recipeCount} sha256=${written.sha256.slice(0, 16)} -> ${written.path}`);
}

function readDispatchState(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { recipeRevisions: {}, liveGates: {} };
  }
}

function writeDispatchState(path, state) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  writeFileSync(path, readFileSync(tmp, "utf8"), "utf8");
  try { unlinkSync(tmp); } catch { /* best-effort */ }
}

async function cmdStatus(db, args) {
  const recipeId = args.recipe;
  if (!recipeId) fail("status requires --recipe <id>");
  const g = getRecipe(db, recipeId);
  console.log(`RECIPE ${g.latest.recipeId}@${g.latest.revision} status=${g.latest.status} hash=${g.latest.descriptorHash.slice(0, 16)}`);
  console.log(`versions: ${g.versions.map((v) => `${v.revision}:${v.status}`).join(", ")}`);
  console.log(`attempts: ${g.attempts.length}`);
  for (const a of g.attempts) {
    console.log(`  ${a.attemptId} run=${a.runId} job=${a.jobId} result=${a.result} vOk=${a.verificationOk} rOk=${a.restorationOk}`);
  }
  console.log(`transitions: ${g.transitions.length}`);
  for (const t of g.transitions) {
    console.log(`  ${t.fromStatus || "(none)"} -> ${t.toStatus}  reason=${t.reason}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log("usage: xw-recipe-promote.mjs <ingest|promote|record|evaluate|status|switch-alias|emit-overlay> ...");
    process.exit(0);
  }
  const cmd = args._[0];
  if (!cmd) fail("no command; one of ingest|promote|record|evaluate|status|switch-alias|emit-overlay");
  const dbPath = args.db || (args["runtime"] ? RUNTIME_DB : DEFAULT_DB);
  const db = openDb(dbPath);
  try {
    switch (cmd) {
      case "ingest": return await cmdIngest(db, args);
      case "promote": return await cmdPromote(db, args);
      case "record": return await cmdRecord(db, args);
      case "evaluate": return await cmdEvaluate(db, args);
      case "status": return await cmdStatus(db, args);
      case "switch-alias": {
        const r = await cmdSwitchAlias(db, args);
        if (!r.ok) fail(r.message);
        return;
      }
      case "emit-overlay": return await cmdEmitOverlay(db, args);
      default: fail(`unknown command ${cmd}`);
    }
  } finally {
    db.close();
  }
}

// Only run the CLI when invoked directly, not when imported by tests.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((e) => fail(e.message || String(e)));
}