#!/usr/bin/env node
/**
 * xw-xhs-routine.mjs — the single executor surface for the XHS deterministic
 * feed routine. Placement is 03-first; 04 is only an explicit, read-only
 * concurrency child. Three call surfaces converge
 * here on one canonical planHash and one executor — no second script set:
 *
 *   /xw xhs routine <template-short> [flags]      -> this CLI
 *   sealed JSON plan submission                   -> acceptSealedRoutinePlan
 *   machine entry                                 -> node ops/xw-xhs-routine.mjs ...
 *
 * This CLI parses, executes and records the aggregate trace; every device
 * primitive and the whole-session lease still belong to the Control Plane.
 * Local driver/effect modules are test fixtures only and require both
 * --offline-fixture and XW_ROUTINE_ALLOW_FIXTURE=1.
 *
 * Console: console.log only (Windows bridge treats stderr as fatal).
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

import {
  planRoutine,
  acceptSealedRoutinePlan,
  bindRoutineExecution,
  listRoutineTemplates,
  resolveRoutineTemplateFromGoal,
  RoutinePlanError,
  ROUTINE_ALIAS,
  ROUTINE_PRIMARY_ALIAS,
  ROUTINE_SECONDARY_ALIAS,
  ROUTINE_PLACEMENT_POLICY,
} from "../scripts/lib/xhs-routine-plan.mjs";
import { createRoutineRun } from "../scripts/lib/xhs-feed-routine-machine.mjs";
import { XhsRoutineRunner } from "../scripts/lib/xhs-routine-runner.mjs";
import {
  listRoutineTraces,
  readRoutineTrace,
  writeRoutineTrace,
} from "../scripts/lib/xhs-routine-run-store.mjs";
import { createExplorerRoutineRuntime } from "./_xhs-routine-explorer-runtime.mjs";

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

const OFFLINE_FIXTURE_ROOT = realpathSync(fileURLToPath(new URL("../tests/fixtures/", import.meta.url)));

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
  node ops/xw-xhs-routine.mjs run --template xhs.feed-play.v1 [--alias 03] --items 8 [--prefer any] [--dwell 5:12] [--comment-screens 1] [--like-max 1] [--comment-max 2] [--seed daily] --plan|--json
  node ops/xw-xhs-routine.mjs plan --template xhs.feed-play.v1 --parallel 2
      # explicit read-only batch; exact children [03,04], never fallback
  node ops/xw-xhs-routine.mjs run --plan-file <sealed-plan.json> --json
  node ops/xw-xhs-routine.mjs plan ...          # plan-only, never touches a device
  node ops/xw-xhs-routine.mjs catalog
  node ops/xw-xhs-routine.mjs history [--limit 20] [--run-id xe_...]
  node ops/xw-xhs-routine.mjs goal "<自然语言>"   # NL -> template mapping (compose surface)

run --plan/--json outputs the sealed plan. Actual execution owns one formal
Explorer session and uses only the fixed loopback CP/Registry endpoints.
Offline fixture injection requires --offline-fixture, XW_ROUTINE_ALLOW_FIXTURE=1
and --driver-module; it is never a production transport.`;
}

function planningOptions(args) {
  return {
    alias: args.alias || ROUTINE_ALIAS,
    parallel: args.parallel === undefined ? 1 : args.parallel,
  };
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

function sealedPlanDocument(plan) {
  const { templateSpec, ...sealed } = plan;
  return sealed;
}

function emitError(code, message, extra = {}) {
  console.log(JSON.stringify({ ok: false, ...extra, error: { code, message } }));
  process.exitCode = 4;
}

function emitPlanError(error) {
  console.log(JSON.stringify({ ok: false, error: { code: error.code, message: error.message, alias: ROUTINE_ALIAS } }));
  const placementError = new Set([
    "ROUTINE_ALIAS_NOT_ALLOWED",
    "ROUTINE_SECONDARY_REQUIRES_EXPLICIT_CONCURRENCY",
    "ROUTINE_SECONDARY_EFFECT_CLASS_FORBIDDEN",
    "ROUTINE_PARALLEL_INVALID",
  ]).has(error.code);
  process.exitCode = placementError ? 3 : 4;
}

function resolveOfflineFixtureModule(rawPath) {
  let resolved;
  try {
    resolved = realpathSync(String(rawPath || ""));
  } catch (error) {
    const wrapped = new Error(`fixture module cannot be resolved: ${error?.message || error}`);
    wrapped.code = "ROUTINE_FIXTURE_PATH_INVALID";
    throw wrapped;
  }
  const rel = relative(OFFLINE_FIXTURE_ROOT, resolved);
  const inside = rel !== ""
    && rel !== ".."
    && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel);
  if (!inside || !resolved.toLowerCase().endsWith(".mjs")) {
    const wrapped = new Error("fixture modules must resolve to an .mjs file inside services/orchestrator/tests/fixtures/");
    wrapped.code = "ROUTINE_FIXTURE_PATH_FORBIDDEN";
    throw wrapped;
  }
  return resolved;
}

export async function runRoutineCli(argv = [], {
  routineRuntimeFactory = createExplorerRoutineRuntime,
  routineTraceWriter = writeRoutineTrace,
  routineTraceReader = readRoutineTrace,
  routineTraceLister = listRoutineTraces,
} = {}) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (args.help || args.h || !cmd) { console.log(usage()); return; }

  if (cmd === "catalog") {
    console.log(JSON.stringify({
      ok: true,
      command: "catalog",
      alias: ROUTINE_ALIAS,
      primaryAlias: ROUTINE_PRIMARY_ALIAS,
      secondaryAlias: ROUTINE_SECONDARY_ALIAS,
      placementPolicy: ROUTINE_PLACEMENT_POLICY,
      perDeviceConcurrency: 1,
      templates: listRoutineTemplates(),
    }, null, 2));
    return;
  }

  if (cmd === "history") {
    try {
      if (args["run-id"]) {
        const result = routineTraceReader(String(args["run-id"]));
        console.log(JSON.stringify({ ok: true, command: "history", trace: result.trace }, null, 2));
      } else {
        console.log(JSON.stringify({
          ok: true,
          command: "history",
          traces: routineTraceLister({ limit: args.limit }),
        }, null, 2));
      }
    } catch (error) {
      emitError(error.code || "ROUTINE_TRACE_READ_FAILED", error.message, { command: "history" });
    }
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
    try {
      const plan = planRoutine({
        templateId,
        params: toParams(args),
        ...planningOptions(args),
        actor: args.actor || null,
        goalSignature: goal,
      });
      console.log(JSON.stringify(plan, (_, v) => (v === undefined ? null : v), 2));
    } catch (error) {
      if (!(error instanceof RoutinePlanError)) throw error;
      emitPlanError(error);
    }
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
        ...planningOptions(args),
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
      emitPlanError(e);
      return;
    }
    throw e;
  }

  const emitPlan = () => {
    console.log(JSON.stringify(sealedPlanDocument(plan), null, 2));
  };

  // plan-only surfaces
  if (cmd === "plan" || args.plan || !args.execute) {
    emitPlan();
    return;
  }

  // Production --execute has exactly one transport: a fixed local routine
  // runner over the formal CP Explorer APIs. Module injection is an explicitly
  // unlocked offline test lane.
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

    const fixtureRequested = Boolean(args["offline-fixture"]);
    const injectionRequested = Boolean(args["driver-module"] || args["effect-bridge-module"]);
    if (injectionRequested && !fixtureRequested) {
      emitError(
        "ROUTINE_FIXTURE_FLAG_REQUIRED",
        "driver/effect module injection is offline-test-only; add --offline-fixture and set XW_ROUTINE_ALLOW_FIXTURE=1",
        { command: "execute", planHash: plan.planHash },
      );
      return;
    }

    if (!fixtureRequested) {
      if (args["control-url"] || args["registry-url"]) {
        emitError(
          "ROUTINE_ENDPOINT_OVERRIDE_FORBIDDEN",
          "production routine endpoints are fixed loopback authorities and cannot be selected by the caller",
          { command: "execute", planHash: plan.planHash },
        );
        return;
      }
      try {
        const runner = new XhsRoutineRunner(routineRuntimeFactory());
        const routineRun = await runner.start({
          plan: sealedPlanDocument(plan),
          actorId: "agent:xhs-routine",
          executionRequest: {
            mode: plan.parallel === 2 ? "parallel" : "single",
            aliases: [...plan.placement.aliases],
          },
        });
        let trace;
        try {
          trace = routineTraceWriter({ plan: sealedPlanDocument(plan), routineRun });
        } catch (traceError) {
          emitError(traceError.code || "ROUTINE_TRACE_WRITE_FAILED", traceError.message, {
            command: "execute",
            planHash: plan.planHash,
            routineRun,
          });
          return;
        }
        const serverVerified = routineRun.serverVerified === true
          && routineRun.receipt?.cleanup?.verified === true;
        const succeeded = String(routineRun.status || "").toUpperCase() === "SUCCEEDED"
          && serverVerified;
        console.log(JSON.stringify({
          ok: succeeded,
          command: "execute",
          planHash: plan.planHash,
          routineRun,
          trace: { path: trace.path, schemaId: trace.trace.schemaId },
          ...(!succeeded ? {
            error: {
              code: "ROUTINE_RUN_NOT_VERIFIED",
              message: "success requires status=SUCCEEDED, serverVerified=true and receipt.cleanup.verified=true",
            },
          } : {}),
        }, null, 2));
        process.exitCode = succeeded ? 0 : 4;
      } catch (error) {
        emitError(error.code || "ROUTINE_EXECUTION_REJECTED", error.message, {
          command: "execute",
          planHash: plan.planHash,
          ...(error.status ? { status: error.status } : {}),
        });
      }
      return;
    }

    if (process.env.XW_ROUTINE_ALLOW_FIXTURE !== "1") {
      emitError(
        "ROUTINE_FIXTURE_ENV_REQUIRED",
        "--offline-fixture requires XW_ROUTINE_ALLOW_FIXTURE=1; zero module import and zero device I/O",
        { command: "execute", planHash: plan.planHash },
      );
      return;
    }
    if (process.env.NODE_ENV !== "test") {
      emitError(
        "ROUTINE_FIXTURE_TEST_ENV_REQUIRED",
        "offline fixture execution requires NODE_ENV=test; production mode never imports caller-selected modules",
        { command: "execute", planHash: plan.planHash },
      );
      return;
    }
    if (plan.parallel === 2) {
      emitError(
        "ROUTINE_PARALLEL_FIXTURE_UNAVAILABLE",
        "offline fixture executor cannot atomically own the exact [03,04] batch; submit it to the Control Plane",
        { command: "execute", planHash: plan.planHash, aliases: plan.placement.aliases },
      );
      return;
    }
    if (!args["driver-module"]) {
      emitError(
        "ROUTINE_EXECUTOR_UNAVAILABLE",
        "offline fixture execution requires --driver-module",
        { command: "execute", planHash: plan.planHash },
      );
      return;
    }
    let driverModulePath;
    try {
      driverModulePath = resolveOfflineFixtureModule(args["driver-module"]);
    } catch (error) {
      emitError(error.code || "ROUTINE_FIXTURE_PATH_INVALID", error.message, { command: "execute", planHash: plan.planHash });
      return;
    }
    const driverMod = await import(pathToFileURL(driverModulePath).href);
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
    // Allocate execution identity only after all fail-closed planning and
    // transport-presence gates above. plan-only output never carries it.
    const executionPlan = bindRoutineExecution(plan, { alias: ROUTINE_PRIMARY_ALIAS });
    let effects = null;
    if (args["effect-bridge-module"]) {
      let bridgeModulePath;
      try {
        bridgeModulePath = resolveOfflineFixtureModule(args["effect-bridge-module"]);
      } catch (error) {
        emitError(error.code || "ROUTINE_FIXTURE_PATH_INVALID", error.message, { command: "execute", planHash: plan.planHash });
        return;
      }
      const bridgeMod = await import(pathToFileURL(bridgeModulePath).href);
      const factory = bridgeMod.createMachineEffects || bridgeMod.default;
      if (typeof factory !== "function") {
        console.log(JSON.stringify({ ok: false, error: { code: "ROUTINE_EFFECT_BRIDGE_INVALID", message: "effect bridge module must export createMachineEffects()/default(plan, owner)" } }));
        process.exitCode = 4;
        return;
      }
      effects = factory({ plan: executionPlan, args });
      if (!effects || typeof effects.commitRoutineEffect !== "function") {
        console.log(JSON.stringify({ ok: false, error: { code: "ROUTINE_EFFECT_BRIDGE_INVALID", message: "effect bridge factory must return { commitRoutineEffect }" } }));
        process.exitCode = 4;
        return;
      }
    }
    const exec = createRoutineRun({ plan: executionPlan, driver, effects });
    const receipt = await exec.execute();
    const okTerminal = receipt.status === "SUCCEEDED";
    const cleanupVerified = receipt.cleanup?.verified === true;
    const payload = {
      ok: okTerminal && cleanupVerified,
      command: "execute",
      planHash: plan.planHash,
      executionRunId: executionPlan.executionRunId,
      routineRunId: executionPlan.routineRunId,
      receipt,
      ...(!(okTerminal && cleanupVerified) ? {
        error: {
          code: "ROUTINE_RUN_NOT_VERIFIED",
          message: "offline fixture success requires status=SUCCEEDED and cleanup.verified=true",
        },
      } : {}),
    };
    console.log(JSON.stringify(payload, null, 2));
    process.exitCode = payload.ok ? 0 : 4;
    return;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  runRoutineCli(process.argv.slice(2)).catch((error) => {
    console.log(JSON.stringify({ ok: false, error: { code: "XHS_ROUTINE_FAILED", message: String(error?.message || error) } }));
    process.exit(2);
  });
}
