#!/usr/bin/env node
/**
 * xw-evolve-worker.mjs — one scheduled cycle of the recipe evolve queue (Phase 4)
 *
 * Default (safe): claim at most 1 pending/queued item → evaluatePromotion → write overlay.
 * Does NOT submit jobs / touch devices. Live replay requires --i-understand-live and still
 * only prints a hint (no auto-submit).
 *
 * Console: console.log only (Windows bridge treats stderr as fatal).
 */

import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureRecipeTables,
  evaluatePromotion,
  getRecipe,
  claimNextEvolveItem,
  setEvolveQueueState,
  writeOverlayFromDb,
  DEFAULT_OVERLAY_PATH,
} from "../scripts/lib/recipe-catalog.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "..");
const DEFAULT_DB = join(ROOT, "registry.db");

const REPLAY_STATUSES = new Set([
  "candidate",
  "replay_verified",
  "promotable",
  "canary_only",
]);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
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

function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  ensureRecipeTables(db);
  return db;
}

function needsReplay(recipe) {
  const status = recipe?.latest?.status;
  if (!REPLAY_STATUSES.has(status)) return false;
  // implemented is done; degraded/retired/observed skip. canary_only may still need
  // two more regressions before implemented — treated as "needs replay" for messaging.
  return status !== "implemented";
}

/**
 * Run one worker cycle. Exported for tests.
 */
export function runEvolveWorkerCycle(db, {
  live = false,
  overlayPath = DEFAULT_OVERLAY_PATH,
  writeOverlay = true,
} = {}) {
  const claimed = claimNextEvolveItem(db);
  if (!claimed) {
    return {
      ok: true,
      action: "idle",
      message: "no pending/queued evolve items",
    };
  }

  const notes = [];
  try {
    const recipe = getRecipe(db, claimed.recipeId);
    const version =
      recipe.versions.find((v) => v.revision === claimed.revision) || recipe.latest;

    if (needsReplay(recipe) || (version && REPLAY_STATUSES.has(version.status))) {
      if (!live) {
        notes.push(
          `skip_live_replay recipe=${claimed.recipeId}@${claimed.revision} status=${version?.status}; default worker only evaluates + writes overlay. Pass --i-understand-live for a live-hint (still no auto-submit).`,
        );
      } else {
        notes.push(
          `live_hint_only: use formal devicectl job submit with visible lease for ${claimed.recipeId}@${claimed.revision}; worker still will not submit.`,
        );
      }
    }

    const evaluation = evaluatePromotion(db, claimed.recipeId, claimed.revision);
    let overlay = null;
    if (writeOverlay) {
      overlay = writeOverlayFromDb(db, { path: overlayPath });
    }

    setEvolveQueueState(db, claimed.queueId, "done", null);
    return {
      ok: true,
      action: "processed",
      queueId: claimed.queueId,
      recipeId: claimed.recipeId,
      revision: claimed.revision,
      evaluation,
      overlay,
      notes,
      submittedJobs: false,
    };
  } catch (e) {
    const msg = String(e?.message || e);
    try {
      setEvolveQueueState(db, claimed.queueId, "error", msg);
    } catch {
      /* ignore secondary */
    }
    return {
      ok: false,
      action: "error",
      queueId: claimed.queueId,
      recipeId: claimed.recipeId,
      revision: claimed.revision,
      error: msg,
      notes,
      submittedJobs: false,
    };
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = resolve(args.db || DEFAULT_DB);
  const overlayPath = resolve(
    args["overlay-path"] || process.env.XHS_RECIPE_OVERLAY_PATH || DEFAULT_OVERLAY_PATH,
  );
  const live = Boolean(args["i-understand-live"]);
  const writeOverlay = !args["no-write-overlay"];

  const db = openDb(dbPath);
  try {
    const result = runEvolveWorkerCycle(db, { live, overlayPath, writeOverlay });
    console.log(JSON.stringify({ ok: result.ok, command: "evolve-worker", ...result }, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) main();
