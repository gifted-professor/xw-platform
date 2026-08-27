#!/usr/bin/env node
/**
 * xw-xhs-routine.mjs — the single executor surface for the 04 XHS deterministic
 * feed routine (direct-routine plan V2 §1/§6). Three call surfaces converge
 * here on one canonical planHash and one executor — no second script set:
 *
 *   /xw xhs routine <template-short> [flags]      -> this CLI
 *   sealed JSON plan submission                   -> acceptSealedRoutinePlan
 *   machine entry                                 -> node ops/xw-xhs-routine.mjs ...
 *
 * This CLI only parses, submits, observes progress and outputs the receipt;
 * device ownership belongs to the Control Plane. Every run needs a
 * session-bound driver: either an injected module (--driver-module, used by
 * offline tests/fakes) or the CP live transport. Without one, run fails
 * closed — a printed plan is never execution evidence (S0 truth).
 *
 * Console: console.log only (Windows bridge treats stderr as fatal).
 */
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

import {
  planRoutine,
  acceptSealedRoutinePlan,
  listRoutineTemplates,
  resolveRoutineTemplateFromGoal,
  RoutinePlanError,
  ROUTINE_ALIAS,
  ROUTINE_SCHEMA_ID,
} from "../scripts/lib/xhs-routine-plan.mjs";
import { createRoutineRun } from "../scripts/lib/xhs-feed-routine-machine.mjs";

const TEMPLATE_SHORT = {
  scout: "xhs.scout.home.v1",
  "scout-home": "xhs.scout.home.v1",
  "feed-play": "xhs.feed-play.v1",
  feedplay: "xhs.feed-play.v1",
  "nurture-lite": "xhs.nurture-lite.v1",
  nurturelite: "xhs.nurture-lite.v1",
  "nurture-grounded": "xhs.nurture-grounded.v1",
  nurturegrounded: "xhs.nurture-grounded.v1",
};

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
  node ops/xw-xhs-routine.mjs run --template xhs.feed-play.v1 --alias 04 --items 8 [--prefer any] [--dwell 5:12] [--comment-screens 1] [--like-max 1] [--comment-max 2] [--seed daily] --plan|--json
  node ops/xw-xhs-routine.mjs run --plan-file <sealed-plan.json> --json
  node ops/xw-xhs-routine.mjs plan ...          # plan-only, never touches a device
  node ops/xw-xhs-routine.mjs catalog
  node ops/xw-xhs-routine.mjs goal "<自然语言>"   # NL -> template mapping (compose surface)

run --plan/--json outputs the sealed plan. Actual device execution additionally
requires a session-bound driver (--driver-module) or the CP live transport;
without one, run fails closed with ROUTINE_EXECUTOR_UNAVAILABLE.`;
}

function toParams(args) {
  const params = {};
  if (args.items !== undefined) params.items = Number(args.items);
  if (args.prefer !== undefined) params.prefer = args.prefer;
  if (args.dwell !== undefined) params.dwell = args.dwell;
  if (args["comment-screens"] !== undefined) params.commentScreens = Number(args["comment-screens"]);
  if (args["like-max"] !== undefined) params.likeMax = Number(args["like-max"]);
  if (args["comment-max"] !== undefined) params.commentMax = Number(args["comment-max"]);
  if (args.seed !== undefined) params.seed = args.seed;
  return params;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (args.help || args.h || !cmd) { console.log(usage()); return; }

  if (cmd === "catalog") {
    console.log(JSON.stringify({ ok: true, command: "catalog", alias: ROUTINE_ALIAS, perDeviceConcurrency: 1, templates: listRoutineTemplates() }, null, 2));
    return;
  }

  if (cmd === "goal") {
    const goal = args._.slice(1).join(" ");
    const templateId = resolveRoutineTemplateFromGoal(goal);
    if (!templateId) {
      console.log(JSON.stringify({ ok: false, error: { code: "ROUTINE_GOAL_UNRESOLVED", message: `no routine template matches goal: ${goal}` } }));
      process.exitCode = 4;
      return;
    }
    const plan = planRoutine({ templateId, params: toParams(args), alias: args.alias || ROUTINE_ALIAS, actor: args.actor || null, goalSignature: goal });
    console.log(JSON.stringify(plan, (_, v) => (v === undefined ? null : v), 2));
    return;
  }

  let plan;
  try {
    if (cmd === "run" && args["plan-file"]) {
      plan = acceptSealedRoutinePlan(JSON.parse(readFileSync(String(args["plan-file"]), "utf8")));
    } else if (cmd === "run" || cmd === "plan") {
      const short = args.template ? String(args.template) : args._[1];
      const templateId = TEMPLATE_SHORT[short] || short;
      plan = planRoutine({
        templateId,
        params: toParams(args),
        alias: args.alias || ROUTINE_ALIAS,
        actor: args.actor || null,
        goalSignature: args.goal || null,
      });
    } else {
      console.log(usage());
      process.exitCode = 4;
      return;
    }
  } catch (e) {
    if (e instanceof RoutinePlanError) {
      console.log(JSON.stringify({ ok: false, error: { code: e.code, message: e.message, alias: ROUTINE_ALIAS } }));
      process.exitCode = e.code === "ROUTINE_ALIAS_NOT_04" ? 3 : 4;
      return;
    }
    throw e;
  }

  const emitPlan = () => {
    const { templateSpec, ...out } = plan;
    console.log(JSON.stringify(out, null, 2));
  };

  // plan-only surfaces
  if (cmd === "plan" || args.plan || !args.execute) {
    emitPlan();
    return;
  }

  // --execute: requires a session-bound driver (offline tests/fakes inject one
  // via --driver-module) or the CP live transport. Fail closed otherwise —
  // plan printing is never execution evidence.
  if (args.execute) {
    if (plan.effectClass === "social" && !args["canary-authorized"]) {
      console.log(JSON.stringify({
        ok: false,
        command: "execute",
        planHash: plan.planHash,
        error: { code: "ROUTINE_EFFECT_GATED", message: `social template ${plan.template} runs live only after its S-wave canary chain promotes it, with explicit --canary-authorized` },
      }));
      process.exitCode = 4;
      return;
    }
    if (!args["driver-module"]) {
      console.log(JSON.stringify({
        ok: false,
        command: "execute",
        planHash: plan.planHash,
        error: { code: "ROUTINE_EXECUTOR_UNAVAILABLE", message: "no session-bound driver wired (use --driver-module for offline fakes; live transport arrives with the CP deployment freeze)" },
      }));
      process.exitCode = 4;
      return;
    }
    const driverMod = await import(pathToFileURL(String(args["driver-module"])).href);
    const driver = driverMod.default || driverMod.driver || driverMod.createDriver?.();
    if (!driver) {
      console.log(JSON.stringify({ ok: false, error: { code: "ROUTINE_DRIVER_INVALID", message: "driver module must export default/driver/createDriver()" } }));
      process.exitCode = 4;
      return;
    }
    // S2: the effect bridge is the ONLY path for social effects (nurture-*).
    // Offline tests inject a bridge module; the live CP transport is wired at
    // the S5 deployment freeze. A canary-authorized social run without a
    // bridge fails closed — a like can never go through the raw driver, and
    // "deferred" is only an S1 offline observation, never a live outcome.
    if (plan.effectClass === "social" && !args["effect-bridge-module"]) {
      console.log(JSON.stringify({
        ok: false,
        command: "execute",
        planHash: plan.planHash,
        error: { code: "ROUTINE_EFFECT_BRIDGE_REQUIRED", message: "social templates require --effect-bridge-module (live CP transport is wired at the S5 deployment freeze)" },
      }));
      process.exitCode = 4;
      return;
    }
    let effects = null;
    if (args["effect-bridge-module"]) {
      const bridgeMod = await import(pathToFileURL(String(args["effect-bridge-module"])).href);
      const factory = bridgeMod.createMachineEffects || bridgeMod.default;
      if (typeof factory !== "function") {
        console.log(JSON.stringify({ ok: false, error: { code: "ROUTINE_EFFECT_BRIDGE_INVALID", message: "effect bridge module must export createMachineEffects()/default(plan, owner)" } }));
        process.exitCode = 4;
        return;
      }
      effects = factory({ plan, args });
      if (!effects || typeof effects.commitRoutineEffect !== "function") {
        console.log(JSON.stringify({ ok: false, error: { code: "ROUTINE_EFFECT_BRIDGE_INVALID", message: "effect bridge factory must return { commitRoutineEffect }" } }));
        process.exitCode = 4;
        return;
      }
    }
    const exec = createRoutineRun({ plan, driver, effects });
    const receipt = await exec.execute();
    const okTerminal = receipt.status === "SUCCEEDED";
    const payload = {
      ok: okTerminal && receipt.cleanup?.activeLeases === 0,
      command: "execute",
      planHash: plan.planHash,
      receipt,
    };
    console.log(JSON.stringify(payload, null, 2));
    process.exitCode = payload.ok ? 0 : 4;
    return;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.log(JSON.stringify({ ok: false, error: { code: "XHS_ROUTINE_FAILED", message: String(error?.message || error) } }));
    process.exit(2);
  });
}