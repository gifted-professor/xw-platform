#!/usr/bin/env node
/**
 * xw-ops-health — 命令观察成熟度（不是 GET /api/health，不是 xw-start --check，不是 xhs-free-explore-health / fleet-health）
 *
 *   node ops/xw-ops-health.mjs list [--json] [--all] [--root <dir>] [--db <registry.db>] [--sessions-root <dir>]
 *   node ops/xw-ops-health.mjs show <commandId|runId> [--json] [--steps|--no-steps]
 *   node ops/xw-ops-health.mjs --help
 *   node ops/xw-ops-health.mjs --self-test
 *
 * Read-only. console.log only. Overlay does not authorize jobs.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_TUNABLES,
  loadOpsHealthInputs,
  mergeTunables,
  redactAmounts,
  scoreCommands,
} from "../scripts/lib/ops-health.mjs";
import { loadTaskTemplates } from "../scripts/lib/task-template.mjs";
import { loadWorkflows } from "../scripts/lib/workflow-catalog.mjs";

const ROOT_DEFAULT = dirname(dirname(fileURLToPath(import.meta.url)));

function usage() {
  return `xw-ops-health — 命令观察成熟度（不是 GET /api/health，不是 xw-start --check，不是 xhs-free-explore-health / fleet-health）

usage:
  node ops/xw-ops-health.mjs list [--json] [--all] [--root <dir>] [--db <file>] [--sessions-root <dir>]
  node ops/xw-ops-health.mjs show <commandId|runId> [--json] [--steps|--no-steps]
  node ops/xw-ops-health.mjs --self-test
  node ops/xw-ops-health.mjs --help

declared is catalog status. observed is derived from harvest/steps/stall/leftover sessions.
oilEligible is a report only; it does not change /xw task gates.`;
}

function argOf(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { cmd: "help" };
  if (argv.includes("--self-test")) return { cmd: "self-test" };
  const rest = argv.filter((item) => !item.startsWith("--"));
  const cmd = rest[0] || "list";
  return {
    cmd,
    target: rest[1] || null,
    json: argv.includes("--json"),
    all: argv.includes("--all"),
    steps: !argv.includes("--no-steps"),
    root: argOf(argv, "--root", ROOT_DEFAULT),
    db: argOf(argv, "--db", join(argOf(argv, "--root", ROOT_DEFAULT), "registry.db")),
    sessionsRoot: argOf(argv, "--sessions-root", join(homedir(), ".xhs-explorer-sessions")),
    runsRoot: argOf(argv, "--runs-root", "C:\\Users\\Public\\xhs-agent-runs"),
  };
}

function envTunables() {
  const overrides = {};
  if (process.env.XHS_OPS_HEALTH_WINDOW_N) overrides.WINDOW_N = Number(process.env.XHS_OPS_HEALTH_WINDOW_N);
  if (process.env.XHS_OPS_HEALTH_WINDOW_DAYS) overrides.WINDOW_DAYS = Number(process.env.XHS_OPS_HEALTH_WINDOW_DAYS);
  if (process.env.XHS_OPS_HEALTH_FLAKY_FAIL_RATE) overrides.FLAKY_FAIL_RATE = Number(process.env.XHS_OPS_HEALTH_FLAKY_FAIL_RATE);
  if (process.env.XHS_OPS_HEALTH_STALL_P95_MULTIPLIER) overrides.STALL_P95_MULTIPLIER = Number(process.env.XHS_OPS_HEALTH_STALL_P95_MULTIPLIER);
  return mergeTunables(overrides);
}

function loadCatalog(root) {
  let templates = [];
  let workflows = [];
  try { templates = loadTaskTemplates({ dir: join(root, "task-templates"), includeAll: true }).templates; } catch { templates = []; }
  try { workflows = loadWorkflows({ path: join(root, "contracts", "workflows.v1.json") }); } catch { workflows = []; }
  return { templates, workflows };
}

function attachProgress(runId, runsRoot) {
  if (!runId || !runsRoot) return null;
  const path = join(runsRoot, runId, "progress.jsonl");
  if (!existsSync(path)) return null;
  try {
    const lines = readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    return {
      name: last.name ?? null,
      step: last.step ?? null,
      phase: last.phase ?? null,
      t: last.t ?? null,
      signalType: last.signalType ?? null,
      silenceMs: last.silenceMs ?? null,
    };
  } catch {
    return null;
  }
}

function printList(scored, { all }) {
  const rows = all
    ? scored.commands
    : scored.commands.filter((item) => item.commandId !== "_unmapped");
  for (const row of rows) {
    const oil = row.oilEligible ? "oil=yes" : "oil=no";
    console.log(`${row.commandId.padEnd(18)} declared=${String(row.declared.normalized).padEnd(12)} observed=${String(row.observed).padEnd(12)} n=${row.counts.samples} ${oil}`);
  }
  if (all && scored.unmappedRunIds.length) {
    console.log(`_unmapped            runs=${scored.unmappedRunIds.join(",")}`);
  }
}

function printShow(scored, target, { steps, runsRoot }) {
  const byRun = scored.commands.flatMap((cmd) => (cmd.runs || []).map((run) => ({ cmd, run })));
  const command = scored.commands.find((item) => item.commandId === target);
  const runHit = byRun.find((item) => item.run.runId === target);
  if (command) {
    console.log(`/xw ops-health show ${command.commandId}`);
    console.log(`  declared: ${command.declared.normalized}`);
    console.log(`  observed: ${command.observed}  n=${command.counts.samples}`);
    console.log(`  oil: ${command.oilEligible ? "yes" : "no"}`);
    if (command.reasons.length) console.log(`  reasons: ${command.reasons.join(",")}`);
    const last = (command.runs || [])[0];
    if (last) {
      console.log(`  last: ${last.runId}  result=${last.result}  run=${last.durationMs ?? "?"}ms`);
      if (steps && last.steps?.length) {
        console.log("  steps (ts=completion; duration=ts[i]-(i==0?startedAt:ts[i-1])):");
        for (const step of last.steps) {
          console.log(`   ${String(step.durationMs ?? "?").padStart(6)}  ${step.status || "?"}  ${step.title || step.stepId || "?"}  durationSource=${step.durationSource || "missing"}`);
        }
      }
    }
    return;
  }
  if (runHit) {
    console.log(`run ${runHit.run.runId}  command=${runHit.cmd.commandId}  result=${runHit.run.result}`);
    const progress = attachProgress(runHit.run.runId, runsRoot);
    if (progress) console.log(`  progress: ${progress.name || "?"} / ${progress.step || "?"} @ ${progress.t || "?"}`);
    return;
  }
  const progress = attachProgress(target, runsRoot);
  if (progress) {
    console.log(`run ${target} (no closeout match)`);
    console.log(`  progress: ${progress.name || "?"} / ${progress.step || "?"} @ ${progress.t || "?"}`);
    return;
  }
  console.log(`XW_OPS_HEALTH_FAILED unknown target ${target}`);
}

function selfTest() {
  const result = spawnSync(process.execPath, ["--test", join(ROOT_DEFAULT, "tests", "ops-health.test.mjs")], {
    encoding: "utf8",
    windowsHide: true,
  });
  const pass = result.status === 0;
  console.log(pass ? "PASS" : "FAIL");
  console.log(`XW_OPS_HEALTH_SELF_TEST summary pass=${pass ? 1 : 0} fail=${pass ? 0 : 1}`);
  process.exitCode = pass ? 0 : 2;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.cmd === "help") {
    console.log(usage());
    return;
  }
  if (args.cmd === "self-test") {
    selfTest();
    return;
  }
  if (!["list", "show"].includes(args.cmd)) {
    console.log(usage());
    process.exitCode = 4;
    return;
  }
  if (!existsSync(args.root)) {
    console.log(`XW_OPS_HEALTH_FAILED root missing: ${args.root}`);
    process.exitCode = 2;
    return;
  }
  const nowMs = Date.now();
  const tunables = envTunables();
  const catalog = loadCatalog(args.root);
  const inputs = loadOpsHealthInputs(args.root, {
    sessionsRoot: args.sessionsRoot,
    dbPath: args.db,
    tunables,
    catalog,
  });
  const scored = redactAmounts(scoreCommands(inputs, tunables, { nowMs }), tunables);
  scored.root = args.root;
  const counts = scored.commands.reduce((acc, row) => {
    acc[row.observed] = (acc[row.observed] || 0) + 1;
    if (row.oilEligible) acc.oil += 1;
    return acc;
  }, { unobserved: 0, healthy: 0, flaky: 0, stalled: 0, oil: 0 });
  console.log(`XW_OPS_HEALTH n=${scored.commands.length} unobserved=${counts.unobserved} healthy=${counts.healthy} flaky=${counts.flaky} stalled=${counts.stalled} oil=${counts.oil} ms=${Date.now() - nowMs}`);
  if (args.json) {
    if (args.cmd === "list" && !args.all) {
      const copy = { ...scored, unmappedRunIds: [] };
      console.log(JSON.stringify(copy, null, 2));
    } else {
      console.log(JSON.stringify(scored, null, 2));
    }
    return;
  }
  if (args.cmd === "list") printList(scored, args);
  else {
    if (!args.target) {
      console.log(usage());
      process.exitCode = 4;
      return;
    }
    printShow(scored, args.target, args);
  }
}

main(process.argv.slice(2));
