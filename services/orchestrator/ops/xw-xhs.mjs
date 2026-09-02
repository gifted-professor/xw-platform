#!/usr/bin/env node
/**
 * xw-xhs.mjs — adaptive dispatcher for the legacy 04 fixed-action pack plus
 * the 03-first deterministic routine surface. `/xw xhs routine ...` delegates
 * in-process to xw-xhs-routine.mjs; it does not create a second executor.
 *
 *   node ops/xw-xhs.mjs <action> [flags] --plan        # plan-only (default)
 *   node ops/xw-xhs.mjs <action> [flags] --json        # plan as JSON
 *   node ops/xw-xhs.mjs <action> [flags] --execute      # fail-closed per gate
 *   node ops/xw-xhs.mjs catalog                         # list actions
 *
 * Three entry surfaces converge here (plan V2 §1):
 *   /xw xhs <action>            -> this CLI
 *   /xw task "..." (xhs-compose) -> compiles to this action catalog
 *   RPA/agent                    -> this CLI with --json
 *
 * /xw messages is the compat alias for `inbox`.
 *
 * 04-only: non-04 aliases are rejected at plan stage (XHS_ALIAS_NOT_04) before
 * any device I/O. --execute is gated per action.gate until each wave promotes it.
 *
 * Console: console.log only (Windows bridge treats stderr as fatal).
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  planAction,
  resolveAction,
  listActions,
  evaluateExecuteGate,
  resolveExecuteOutcome,
  PlanError,
  FORCED_ALIAS,
} from "../scripts/lib/xw-xhs-dispatcher.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
// Default dispatch state (recipe revisions + live gates). The runtime override
// is XHS_DISPATCH_STATE; switch-alias updates this file in place after promotion.
const DEFAULT_STATE_PATH = join(HERE, "..", "..", "control-plane", "config", "xhs-dispatch-state.json");
const STATE_PATH = process.env.XHS_DISPATCH_STATE || DEFAULT_STATE_PATH;

function loadDispatchState() {
  try {
    const raw = readFileSync(STATE_PATH, "utf8");
    const s = JSON.parse(raw);
    return {
      recipeRevisions: s.recipeRevisions || {},
      liveGates: s.liveGates || {},
    };
  } catch {
    // Missing/unreadable state -> fall back to dispatcher defaults (search@1, no gates).
    return { recipeRevisions: {}, liveGates: {} };
  }
}

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

function usage() {
  return `usage:
  node ops/xw-xhs.mjs <action> [params] --plan|--json|--execute
  node ops/xw-xhs.mjs catalog
  node ops/xw-xhs.mjs --help

actions (04-only):
  search --keyword <词> [--pages 1]
  browse                      # recipe@1 performs exactly 5 static swipes (no params)
  inbox                      (/xw messages compat alias)
  read --thread <会话标识>
  like [--keyword 词] [--count 1]
  collect [--keyword 词] [--count 1]
  follow [--keyword 词] [--count 1]
  nurture --minutes 20 [--likes 2] [--collects 1] [--follows 0]
  comment --keyword <词> --text <评论> [--count 1]
  reply --thread <会话标识> --text <回复>
  publish prepare --title <标题> --body <正文> [--tags a,b] [--images x,y]
  publish send --run <prepareRunId>

routines (03-first, formal CP-session-bound):
  routine feed-play [--items 8] [--dwell 5:12] [--execute]
  routine scout [--items 5] [--execute]
  routine nurture-lite|nurture-grounded ...  # social authority remains fail-closed
  routine catalog

--plan (default) never touches a device. --execute fails closed until the
action's wave promotes it via the live canary chain.`;
}

function toParams(action, args) {
  const spec = action.params || {};
  const params = {};
  for (const key of Object.keys(spec)) {
    if (args[key] !== undefined) params[key] = args[key];
  }
  return params;
}

async function main() {
  const rawArgv = process.argv.slice(2);
  if (rawArgv[0] === "routine") {
    const tail = rawArgv.slice(1);
    const directCommands = new Set(["catalog", "goal", "plan", "run"]);
    const routineArgv = directCommands.has(tail[0]) ? tail : ["run", ...tail];
    const { runRoutineCli } = await import("./xw-xhs-routine.mjs");
    await runRoutineCli(routineArgv);
    return;
  }

  const args = parseArgs(rawArgv);
  if (args.help || args.h) { console.log(usage()); return; }

  if (args._[0] === "catalog") {
    const actions = listActions();
    console.log(JSON.stringify({ ok: true, command: "catalog", alias: FORCED_ALIAS, perDeviceConcurrency: 1, actions }, null, 2));
    return;
  }

  // "publish prepare" / "publish send" arrive as two positional tokens.
  let actionId = args._.join(" ").trim();
  if (!actionId) { console.log(usage()); process.exitCode = 4; return; }

  const action = resolveAction(actionId);
  if (!action) {
    console.log(JSON.stringify({ ok: false, error: { code: "ACTION_UNKNOWN", message: `unknown xhs action: ${actionId}` } }));
    process.exitCode = 4;
    return;
  }

  const alias = args.alias || FORCED_ALIAS;
  const actor = args.actor || null;
  const params = toParams(action, args);
  const { recipeRevisions, liveGates } = loadDispatchState();

  let plan;
  try {
    plan = planAction({ actionId: action.id, params, alias, actor, recipeRevisions });
  } catch (e) {
    if (e instanceof PlanError) {
      console.log(JSON.stringify({ ok: false, error: { code: e.code, message: e.message, alias } }));
      process.exitCode = e.code === "XHS_ALIAS_NOT_04" ? 3 : 4;
      return;
    }
    throw e;
  }

  const asJson = Boolean(args.json) || Boolean(args.execute);
  if (args.execute) {
    // S0 execution truth (plan V2 §3.4/§6.6): gate pass alone is never success.
    // The CP routine executor is not wired into this CLI yet (S1); even with
    // the live gate open, --execute fails closed with XHS_EXECUTE_NOT_WIRED
    // instead of printing a gate-only ok:true.
    const gate = evaluateExecuteGate(plan, liveGates);
    const outcome = resolveExecuteOutcome(plan, liveGates, null);
    const payload = {
      ok: outcome.ok,
      command: "execute",
      plan,
      gate: gate.ok ? null : gate.reason || null,
    };
    if (!outcome.ok) {
      payload.error = { code: outcome.code, message: outcome.message || outcome.reason };
      if (outcome.code === "ACTION_GATED") {
        payload.message = `live execution is fail-closed for ${plan.action} until wave ${plan.gate} promotes it via the canary chain`;
      }
    }
    console.log(JSON.stringify(payload, null, 2));
    process.exitCode = outcome.ok ? 0 : 4;
    return;
  }

  if (asJson || args.plan) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  // default: human-readable plan summary
  console.log(`action:     ${plan.action}`);
  console.log(`actionRunId ${plan.actionRunId}`);
  console.log(`planHash:   ${plan.planHash}`);
  console.log(`alias:      ${plan.alias} (perDeviceConcurrency=${plan.perDeviceConcurrency})`);
  console.log(`backend:    ${plan.backend}${plan.recipeId ? ` -> ${plan.recipeId}@${plan.recipeRevision ?? "?"}` : ""}${plan.capabilityId ? ` -> ${plan.capabilityId}` : ""}`);
  console.log(`effect:     ${plan.effectClass}  gate: ${plan.gate}  route: ${plan.adaptiveRoute}`);
  console.log(`params:     ${JSON.stringify(plan.params)}`);
  console.log(`budget:     ${JSON.stringify(plan.budget)}`);
  console.log(`stop:       ${plan.stopConditions.join(" | ")}`);
  console.log(`execute:    ${plan.executionReady ? "ready" : "plan-only (fail-closed)"}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.log(JSON.stringify({ ok: false, error: { code: "XHS_DISPATCH_FAILED", message: String(error?.message || error) } }));
    process.exit(2);
  });
}
