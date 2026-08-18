#!/usr/bin/env node
/**
 * xw-evolve.mjs — Recipe Catalog evolve CLI (Phase 2/3/4 scaffolding)
 *
 *   node ops/xw-evolve.mjs enqueue --from <harvest-dir>
 *   node ops/xw-evolve.mjs ingest --spec <json-file>
 *   node ops/xw-evolve.mjs evaluate --recipe <id> [--revision n] [--no-write-overlay]
 *   node ops/xw-evolve.mjs status [--write-overlay]
 *   node ops/xw-evolve.mjs replay --recipe <id> [--revision n] [--i-understand-live]
 *
 * Never auto-submits jobs unless --i-understand-live (still a stub that only prints).
 * evaluate / status --write-overlay atomically write generated-overlay for control-plane.
 * Console: use console.log only (Windows bridge treats stderr as fatal).
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureRecipeTables,
  ingestRecipeCandidate,
  evaluatePromotion,
  enqueueEvolve,
  listRecipes,
  getRecipe,
  listEvolveQueue,
  writeOverlayFromDb,
  DEFAULT_OVERLAY_PATH,
  RECIPE_SCHEMA_IDS,
} from "../scripts/lib/recipe-catalog.mjs";
import { sealRecipeSpec } from "../scripts/lib/recipe-spec.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "..");
const DEFAULT_DB = join(ROOT, "registry.db");

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

function fail(msg, code = 2) {
  console.log(`EVOLVE_FAILED ${msg}`);
  process.exit(code);
}

function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  ensureRecipeTables(db);
  return db;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isRecipeSpec(obj) {
  if (!obj || typeof obj !== "object") return false;
  const sid = String(obj.schemaId || "");
  if (RECIPE_SCHEMA_IDS.includes(sid)) return true;
  if (!obj.recipeId || !obj.executor) return false;
  if (obj.executor.kind === "primitive_steps" && Array.isArray(obj.executor.steps)) return true;
  if (obj.executor.capabilityId || obj.executor.capability) return true;
  return false;
}

function walkJsonFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === ".staging" || name === "node_modules") continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkJsonFiles(full, out);
    else if (st.isFile() && /\.json$/i.test(name)) out.push(full);
  }
  return out;
}

function extractCandidatesFromHarvest(dir) {
  const found = [];
  const seen = new Set();

  const pushSpec = (spec, originRunId) => {
    if (!isRecipeSpec(spec)) return;
    const key = `${spec.recipeId || ""}:${spec.revision || 1}:${JSON.stringify(spec.executor || {})}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ spec, originRunId });
  };

  // 1) JSON files that are recipe specs
  for (const file of walkJsonFiles(dir)) {
    let obj;
    try {
      obj = readJson(file);
    } catch {
      continue;
    }
    if (isRecipeSpec(obj)) {
      pushSpec(obj, obj.originRunId || null);
      continue;
    }
    // nested
    if (Array.isArray(obj.recipes)) {
      for (const r of obj.recipes) pushSpec(r, obj.runId || null);
    }
    if (obj.recipe && isRecipeSpec(obj.recipe)) pushSpec(obj.recipe, obj.runId || null);
    if (obj.spec && isRecipeSpec(obj.spec)) pushSpec(obj.spec, obj.runId || obj.originRunId || null);
  }

  // 2) closeout candidates of kind=recipe — synthesize minimal candidate when no full spec
  for (const name of ["closeout.v1.json", "closeout.json", "manifest.json"]) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    let closeout;
    try {
      closeout = readJson(path);
    } catch {
      continue;
    }
    const runId = closeout.runId || null;
    const candidates = Array.isArray(closeout.candidates) ? closeout.candidates : [];
    for (const c of candidates) {
      if (c?.kind !== "recipe") continue;
      if (c.spec && isRecipeSpec(c.spec)) {
        pushSpec(c.spec, runId);
        continue;
      }
      if (c.recipeSpec && isRecipeSpec(c.recipeSpec)) {
        pushSpec(c.recipeSpec, runId);
        continue;
      }
      // Minimal scaffold from closeout candidate metadata (status=candidate on ingest).
      const recipeId = String(c.candidateId || c.recipeId || "")
        .replace(/^cand_/, "recipe_")
        .replace(/[^A-Za-z0-9._-]/g, "_");
      if (!recipeId) continue;
      pushSpec(
        {
          schemaId: "xhs.recipe-candidate.v1",
          recipeId,
          revision: 1,
          appId: c.appId || "unknown",
          intentAliases: [c.title || recipeId].filter(Boolean),
          inputSchema: { type: "object", properties: {}, required: [] },
          executor: {
            capabilityId: c.capabilityId || "unknown.pending",
            paramsTemplate: {},
          },
          preconditions: [],
          assertions: Array.isArray(c.acceptanceConditions) ? c.acceptanceConditions : [],
          restoration: { required: false },
          validityEnvelope: {},
          riskCeiling: "R1",
          originRunId: runId,
          evidenceHashes: Array.isArray(c.evidenceRefs) ? c.evidenceRefs : [],
        },
        runId,
      );
    }
  }

  return found;
}

function resolveOverlayPath(args) {
  return resolve(args["overlay-path"] || process.env.XHS_RECIPE_OVERLAY_PATH || DEFAULT_OVERLAY_PATH);
}

function writeOverlaySafe(db, args) {
  const path = resolveOverlayPath(args);
  try {
    const written = writeOverlayFromDb(db, { path });
    return { ok: true, ...written };
  } catch (e) {
    return { ok: false, error: String(e.message || e), path };
  }
}

function cmdIngest(db, args) {
  const specPath = args.spec;
  if (!specPath) fail("ingest requires --spec <json-file>");
  const abs = resolve(specPath);
  if (!existsSync(abs)) fail(`spec file not found: ${abs}`);
  const spec = readJson(abs);
  const sealed = sealRecipeSpec(spec);
  const version = ingestRecipeCandidate(db, {
    spec: sealed.spec,
    originRunId: args["origin-run"] || sealed.spec.originRunId || null,
    actor: args.actor || "xw-evolve",
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        command: "ingest",
        recipe: version,
        recipeSpecArtifact: sealed.artifact,
        note: "Attach recipeSpecArtifact to closeout as a hashed artifact later if desired.",
      },
      null,
      2,
    ),
  );
}

function cmdEnqueue(db, args) {
  if (args.recipe) {
    const recipeId = String(args.recipe);
    const revision = args.revision != null ? Number(args.revision) : undefined;
    const q = enqueueEvolve(db, { recipeId, revision });
    console.log(JSON.stringify({ ok: true, command: "enqueue", enqueued: [q] }, null, 2));
    return;
  }
  const from = args.from;
  if (!from) fail("enqueue requires --from <harvest-dir> or --recipe <id> [--revision n]");
  const abs = resolve(from);
  if (!existsSync(abs)) fail(`harvest dir not found: ${abs}`);

  const candidates = extractCandidatesFromHarvest(abs);
  if (!candidates.length) {
    console.log(
      JSON.stringify(
        { ok: true, command: "enqueue", ingested: [], enqueued: [], note: "no recipe candidates found" },
        null,
        2,
      ),
    );
    return;
  }

  const ingested = [];
  const enqueued = [];
  const errors = [];
  const artifacts = [];
  for (const { spec, originRunId } of candidates) {
    try {
      const sealed = sealRecipeSpec(spec);
      artifacts.push(sealed.artifact);
      const version = ingestRecipeCandidate(db, {
        spec: sealed.spec,
        originRunId,
        actor: args.actor || "xw-evolve-enqueue",
      });
      ingested.push(version);
      const q = enqueueEvolve(db, {
        recipeId: version.recipeId,
        revision: version.revision,
      });
      enqueued.push(q);
    } catch (e) {
      errors.push({ recipeId: spec.recipeId, error: String(e.message || e) });
    }
  }
  console.log(
    JSON.stringify(
      { ok: errors.length === 0, command: "enqueue", ingested, enqueued, artifacts, errors },
      null,
      2,
    ),
  );
}

function cmdEvaluate(db, args) {
  const recipeId = args.recipe;
  if (!recipeId) fail("evaluate requires --recipe <id>");
  let revision = args.revision != null ? Number(args.revision) : null;
  if (revision == null) {
    const recipe = getRecipe(db, recipeId);
    revision = recipe.latest.revision;
  }
  const result = evaluatePromotion(db, recipeId, revision);
  let overlay = null;
  if (!args["no-write-overlay"]) {
    overlay = writeOverlaySafe(db, args);
  }
  console.log(JSON.stringify({ ok: true, command: "evaluate", result, overlay }, null, 2));
}

function cmdStatus(db, args) {
  const queue = listEvolveQueue(db);
  const recipes = listRecipes(db, { includeAll: true });
  let overlay = null;
  if (args["write-overlay"]) {
    overlay = writeOverlaySafe(db, args);
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        command: "status",
        queueCount: queue.length,
        recipeCount: recipes.length,
        queue,
        recipes: recipes.map((r) => ({
          recipeId: r.recipeId,
          revision: r.revision,
          status: r.status,
          descriptorHash: r.descriptorHash,
          originRunId: r.originRunId,
        })),
        overlay,
        overlayPath: resolveOverlayPath(args),
      },
      null,
      2,
    ),
  );
}

function cmdReplay(args) {
  const recipeId = args.recipe || "<recipeId>";
  const revision = args.revision || "<n>";
  if (args["i-understand-live"]) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          command: "replay",
          stub: true,
          message:
            "Live replay is intentionally not auto-submitted in this scaffolding. Use formal devicectl job submit with a visible lease, then recordAttempt + evaluate.",
          hint: `node control-plane/devicectl.mjs --ssh xhs-windows job submit --capability <id> --actor evolve-replay --idempotency-key <key> --params '<json>'  # recipe ${recipeId}@${revision}`,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        command: "replay",
        stub: true,
        message:
          "replay must go through devicectl job (do not submit jobs automatically). Re-run with --i-understand-live to print the live hint only; this CLI still will not submit.",
        recipeId,
        revision,
      },
      null,
      2,
    ),
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command) {
    fail(
      "usage: xw-evolve.mjs enqueue|ingest|replay|evaluate|status [--db path] ...",
    );
  }
  const dbPath = resolve(args.db || DEFAULT_DB);

  if (command === "replay") {
    cmdReplay(args);
    return;
  }

  const db = openDb(dbPath);
  try {
    if (command === "ingest") cmdIngest(db, args);
    else if (command === "enqueue") cmdEnqueue(db, args);
    else if (command === "evaluate") cmdEvaluate(db, args);
    else if (command === "status") cmdStatus(db, args);
    else fail(`unknown command: ${command}`);
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

main();
