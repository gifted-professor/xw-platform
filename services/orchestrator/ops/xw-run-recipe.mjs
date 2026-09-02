#!/usr/bin/env node
/**
 * xw-run-recipe.mjs — CLI for Single-Device Recipe Runner (PR1).
 *
 *   node ops/xw-run-recipe.mjs --recipe xhs.search.fixed --params '{"keyword":"深圳攀岩"}' --dry-run
 *   node ops/xw-run-recipe.mjs --recipe xhs.search.fixed --params '{"keyword":"深圳攀岩"}' --actor agent:rpa
 *
 * Live runs POST /control/v1/recipe-runs on the Control Plane.
 * --dry-run posts dryRun:true (plan + validate only; no device I/O) when control is up,
 * or falls back to local plan against the baked fixture for xhs.search.fixed.
 *
 * Console: console.log only (Windows bridge).
 */
import { readFileSync } from "node:fs";

const CONTROL = (process.env.XHS_CONTROL_URL || "http://127.0.0.1:17920").replace(/\/$/, "");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("-")) {
      out[a.slice(2)] = argv[++i];
    } else if (a.startsWith("--")) {
      out[a.slice(2)] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function usage() {
  console.log(`用法:
  node ops/xw-run-recipe.mjs --recipe <recipeId> --keyword <text> [--pages N] [--actor <id>] [--revision N] [--dry-run]
  node ops/xw-run-recipe.mjs --recipe <recipeId> --params '<json>' [--dry-run]
  node ops/xw-run-recipe.mjs --recipe-file <path.json> --params-file <path.json> [--dry-run]

固定 alias 默认 04（可用环境变量 XHS_RPA_ALIAS 覆盖）。--dry-run 不碰设备。Windows 建议用 --keyword 避免 PowerShell 吃掉 JSON 引号。`);
}

async function postJson(path, body) {
  const res = await fetch(`${CONTROL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text.slice(0, 400) };
  }
  if (!res.ok) {
    const code = payload?.error?.code || "CONTROL_REJECTED";
    const message = payload?.error?.message || text.slice(0, 200);
    const e = new Error(`${code}: ${message}`);
    e.code = code;
    e.status = res.status;
    e.payload = payload;
    throw e;
  }
  return payload;
}

async function localDryPlan({ recipe, params }) {
  const runnerMod = await import(
    new URL("../../control-plane/control-plane/lib/single-device-recipe-runner.mjs", import.meta.url).href
  );
  const { planRecipeFromExecutor } = await import(
    new URL("../../control-plane/control-plane/lib/recipe-interpreter.mjs", import.meta.url).href
  );
  const prepared = runnerMod.prepareRecipeSteps(recipe, params);
  const planned = planRecipeFromExecutor(prepared.executor, { live: false });
  return {
    ok: true,
    mode: "plan",
    recipeId: recipe.recipeId,
    revision: recipe.revision,
    alias: runnerMod.resolveFixedRpaAlias(),
    input: prepared.input,
    stepCount: prepared.steps.length,
    plannedCalls: planned.plannedCalls,
    message: planned.message,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    process.exit(0);
  }

  const recipeId = args.recipe || null;
  const recipeFile = args["recipe-file"] || null;
  const actorId = args.actor || `agent:xw-run-recipe`;
  const dryRun = Boolean(args["dry-run"]);
  let revision = args.revision != null ? Number(args.revision) : null;
  if (revision != null && !Number.isInteger(revision)) {
    console.log("✗ --revision must be integer");
    process.exit(4);
  }

  let params = {};
  if (args["params-file"]) {
    try {
      params = JSON.parse(readFileSync(args["params-file"], "utf8"));
    } catch (e) {
      console.log(`✗ --params-file invalid: ${e.message}`);
      process.exit(4);
    }
  } else if (args.params) {
    try {
      params = JSON.parse(args.params);
    } catch (e) {
      console.log(`✗ --params JSON invalid: ${e.message}`);
      process.exit(4);
    }
  }
  if (args.keyword != null) {
    params = { ...params, keyword: String(args.keyword) };
  }
  if (args.pages != null) {
    params = { ...params, pages: Number(args.pages) };
  }

  let inlineRecipe = null;
  if (recipeFile) {
    inlineRecipe = JSON.parse(readFileSync(recipeFile, "utf8"));
  }

  if (!recipeId && !inlineRecipe) {
    usage();
    process.exit(4);
  }

  if (dryRun) {
    try {
      const body = {
        actorId,
        dryRun: true,
        params,
        ...(inlineRecipe
          ? { recipe: inlineRecipe }
          : { recipeId, ...(revision != null ? { revision } : {}) }),
      };
      const payload = await postJson("/control/v1/recipe-runs", body);
      console.log(JSON.stringify(payload.recipeRun || payload, null, 2));
      process.exit(0);
    } catch (e) {
      if (e.code === "CONTROL_REJECTED" || e.status === 404 || /fetch|ECONNREFUSED|AbortError/i.test(String(e.message))) {
        // Local fallback for fixture dry-run when control is down.
        if (!inlineRecipe && recipeId === "xhs.search.fixed") {
          const { XHS_SEARCH_FIXED_RECIPE } = await import(
            new URL("../../control-plane/tests/fixtures/xhs-search-fixed.recipe.mjs", import.meta.url).href
          );
          const plan = await localDryPlan({ recipe: XHS_SEARCH_FIXED_RECIPE, params });
          console.log(JSON.stringify(plan, null, 2));
          process.exit(0);
        }
        if (inlineRecipe) {
          const plan = await localDryPlan({ recipe: inlineRecipe, params });
          console.log(JSON.stringify(plan, null, 2));
          process.exit(0);
        }
      }
      console.log(`✗ ${e.message}`);
      process.exit(4);
    }
  }

  try {
    const body = {
      actorId,
      params,
      dryRun: false,
      ...(inlineRecipe
        ? { recipe: inlineRecipe }
        : { recipeId, ...(revision != null ? { revision } : {}) }),
    };
    const payload = await postJson("/control/v1/recipe-runs", body);
    const run = payload.recipeRun || payload;
    console.log(JSON.stringify(run, null, 2));
    process.exit(run.status === "SUCCEEDED" ? 0 : 4);
  } catch (e) {
    console.log(`✗ ${e.message}`);
    process.exit(4);
  }
}

main();
