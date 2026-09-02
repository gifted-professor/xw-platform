#!/usr/bin/env node
/**
 * xw-xhs-promote.mjs — one-shot promotion chain for the 04 XHS script pack
 * (plan V2 "sedimented fixed task"). Drives the full sequence from a freshly
 * live recipe-run to an atomically switched dispatcher alias:
 *
 *   1. ingest the production spec (idempotent per revision)
 *   2. promote each --runs recipeRunId through the Fast-2 bridge
 *      (fetch from CP -> buildRunnerAttemptReceipt -> recordVerifiedAttempt)
 *   3. evaluate promotion (2 independent -> canary_only)
 *   4. switch-alias (fail-closed: only if canary_only/implemented)
 *   5. emit-overlay (so @2 appears in the live overlay)
 *
 * The live recipe-runs themselves happen on the device (operator-driven); this
 * script takes their server-verified recipeRunIds and drives the rest. Re-runs
 * are idempotent: re-promoting the same recipeRunId is a no-op.
 *
 *   node ops/xw-xhs-promote.mjs --recipe xhs.search.fixed --runs rr_a,rr_b [--action search] [--runtime]
 *
 * Console: console.log only (Windows bridge treats stderr as fatal).
 */
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ensureRecipeTables,
  ingestRecipeCandidate,
  getRecipe,
  evaluatePromotion,
} from "../scripts/lib/recipe-catalog.mjs";
import {
  openDb,
  loadFixtureSpec,
  promoteRunnerRun,
  cmdSwitchAlias,
  cmdEmitOverlay,
  RUNTIME_DB,
} from "./xw-recipe-promote.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "..");
const DEFAULT_DB = join(ROOT, "registry.db");

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
  console.log(`PROMOTE_CHAIN_FAILED ${msg}`);
  process.exit(code);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const recipeId = args.recipe;
  if (!recipeId) fail("--recipe <recipeId> required");
  const actionId = args.action || null;
  const runs = String(args.runs || "")
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!runs.length) fail("--runs <runId1,runId2> required (need >=2 independent for canary_only)");
  const dbPath = args.db || (args.runtime ? RUNTIME_DB : DEFAULT_DB);
  const db = openDb(dbPath);

  try {
    // 1. Ingest the production spec (idempotent per revision).
    const spec = await loadFixtureSpec(recipeId);
    const revision = Number.isInteger(spec.revision) ? spec.revision : null;
    let ingestedRev = revision;
    if (revision != null) {
      const dup = db
        .prepare(`SELECT revision FROM recipe_versions WHERE recipe_id=? AND revision=?`)
        .get(recipeId, revision);
      if (!dup) {
        const created = ingestRecipeCandidate(db, { spec, actor: "agent:xw-xhs-promote" });
        ingestedRev = created.revision;
        console.log(`CHAIN[1/5] INGESTED ${created.recipeId}@${created.revision} hash=${created.descriptorHash.slice(0, 16)}`);
      } else {
        console.log(`CHAIN[1/5] INGEST_IDEMPOTENT ${recipeId}@${revision}`);
      }
    } else {
      const created = ingestRecipeCandidate(db, { spec, actor: "agent:xw-xhs-promote" });
      ingestedRev = created.revision;
      console.log(`CHAIN[1/5] INGESTED ${created.recipeId}@${created.revision} hash=${created.descriptorHash.slice(0, 16)}`);
    }

    // 2. Promote each live recipe-run: fetch from CP, build receipt, record.
    for (const runId of runs) {
      const payload = await fetchRecipeRun(runId);
      const out = promoteRunnerRun(db, payload, { evaluate: false });
      if (!out.ok) fail(`promote ${runId}: ${out.code} ${out.message}`);
      const tag = out.idempotent ? "IDEMPOTENT" : "RECORDED";
      const rid = out.receipt?.recipeId || recipeId;
      const rev = out.receipt?.revision || ingestedRev;
      console.log(`CHAIN[2/5] ${tag} ${rid}@${rev} run=${runId}`);
    }

    // 3. Evaluate promotion.
    const ev = evaluatePromotion(db, recipeId, ingestedRev);
    console.log(`CHAIN[3/5] PROMOTION ${recipeId}@${ingestedRev} status=${ev.status} independent=${ev.independentSuccesses} changed=${ev.changed}`);
    if (ev.status !== "canary_only" && ev.status !== "implemented") {
      fail(`${recipeId}@${ingestedRev} status=${ev.status}; need canary_only/implemented to switch alias (got ${runs.length} runs, need >=2 independent)`);
    }

    // 4. switch-alias (fail-closed inside cmdSwitchAlias).
    await cmdSwitchAlias(db, { recipe: recipeId, revision: ingestedRev, action: actionId, runtime: args.runtime });
    console.log(`CHAIN[4/5] SWITCH_ALIAS ${recipeId}@${ingestedRev}${actionId ? ` gate=${actionId}:on` : ""}`);

    // 5. emit-overlay.
    await cmdEmitOverlay(db, { runtime: args.runtime });
    console.log(`CHAIN[5/5] OVERLAY_EMIT done`);

    console.log(`CHAIN_OK ${recipeId}@${ingestedRev} status=${ev.status} runs=[${runs.join(",")}]`);
  } finally {
    db.close();
  }
}

async function fetchRecipeRun(recipeRunId) {
  const CONTROL_BASE = (process.env.XHS_CONTROL_BASE || "http://127.0.0.1:17920").replace(/\/$/, "");
  const url = `${CONTROL_BASE}/control/v1/recipe-runs/${encodeURIComponent(recipeRunId)}`;
  const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Object.assign(new Error(`control recipe-run fetch failed: ${res.status} ${text.slice(0, 200)}`), {
      code: "CONTROL_RUN_FETCH_FAILED", status: res.status,
    });
  }
  return res.json();
}

if (import.meta.url === new URL(`file://${process.argv[1] || ""}`).href) {
  main().catch((e) => fail(e.message || String(e)));
}