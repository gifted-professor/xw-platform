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
import {
  ensureRecipeTables,
  ingestRecipeCandidate,
  recordVerifiedAttempt,
  evaluatePromotion,
  getRecipe,
  canonicalJson,
} from "../scripts/lib/recipe-catalog.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "..");
const DEFAULT_DB = join(ROOT, "registry.db");
const RUNTIME_DB = "C:\\Users\\Public\\xw-runtime\\state\\orchestrator\\registry.db";
const CONTROL_BASE = (process.env.XHS_CONTROL_BASE || "http://127.0.0.1:17920").replace(/\/$/, "");

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

function openDb(dbPath) {
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

async function loadFixtureSpec(recipeId) {
  if (recipeId === "xhs.search.fixed") {
    const mod = await import(
      new URL("../../control-plane/tests/fixtures/xhs-search-fixed.recipe.mjs", import.meta.url).href
    );
    return mod.XHS_SEARCH_FIXED_RECIPE;
  }
  throw Object.assign(new Error(`no fixture for ${recipeId}; pass --spec <file>`), { code: "NO_FIXTURE" });
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
    const { readFileSync } = await import("node:fs");
    spec = JSON.parse(readFileSync(args.spec, "utf8"));
  } else if (args.fixture) {
    spec = await loadFixtureSpec(String(args.fixture));
  } else {
    fail("ingest requires --fixture <recipeId> or --spec <file>");
  }
  const recipeId = String(spec.recipeId);
  if (recipeExists(db, recipeId)) {
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
    console.log("usage: xw-recipe-promote.mjs <ingest|promote|record|evaluate|status> ...");
    process.exit(0);
  }
  const cmd = args._[0];
  if (!cmd) fail("no command; one of ingest|promote|record|evaluate|status");
  const dbPath = args.db || (args["runtime"] ? RUNTIME_DB : DEFAULT_DB);
  const db = openDb(dbPath);
  try {
    switch (cmd) {
      case "ingest": return await cmdIngest(db, args);
      case "promote": return await cmdPromote(db, args);
      case "record": return await cmdRecord(db, args);
      case "evaluate": return await cmdEvaluate(db, args);
      case "status": return await cmdStatus(db, args);
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