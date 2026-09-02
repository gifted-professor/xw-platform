#!/usr/bin/env node
/**
 * xhs-collect-loop.mjs — continuous read-only collection stress CLI.
 *
 * Fans out N batches × K per-alias Control Planes (one CP process per device,
 * ports 17921-17924 for aliases 04-07). Each device-batch unit is one
 * server-side recipe run on that device's own CP, exactly the transport of
 * the 2026-09-02 4/4 note.read baseline. Full stop on risk-control signals.
 *
 *   node ops/xhs-collect-loop.mjs --batches 10 --interval-ms 5000
 *   node ops/xhs-collect-loop.mjs --aliases 04,05 --ports 17921,17922 --batches 3 --recipe xhs.search.fixed --keyword 深圳
 *
 * Progress lines and the final summary JSON both go to stdout
 * (console.log only — the Windows bridge treats stderr as fatal).
 */
import { createCollectLoop, createHttpCollectCp } from "../scripts/lib/xhs-collect-loop.mjs";
import { defaultRoutineRunStoreRoot } from "../scripts/lib/xhs-routine-run-store.mjs";

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
  node ops/xhs-collect-loop.mjs --batches 10 [--interval-ms 5000] [--max-retries 1]
      [--aliases 04,05,06,07] [--ports 17921,17922,17923,17924]
      [--recipe xhs.note.read.fixed] [--revision 1] [--keyword <text>] [--pages N]
      [--params '<json>'] [--actor agent:xhs-collect-loop] [--trace-root <dir>]

默认 aliases 04,05,06,07 对应 ports 17921-17924（每机一个 CP 进程）。
--batches 必填。批间隔默认 5000ms。全程只读；风控信号全线急停。
进度与最终 summary JSON 都走 stdout（summary 在最后一行之后）。`);
}

function csv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function emitError(code, message) {
  console.log(JSON.stringify({ ok: false, error: { code, message } }));
  process.exitCode = 4;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    return;
  }
  const aliases = csv(args.aliases || "04,05,06,07");
  const ports = csv(args.ports || "17921,17922,17923,17924");
  if (aliases.length === 0 || aliases.length !== ports.length) {
    emitError("COLLECT_ARGS_INVALID", "--aliases and --ports must be non-empty lists of the same length");
    return;
  }
  const batches = Number(args.batches);
  if (!Number.isInteger(batches) || batches < 1) {
    emitError("COLLECT_ARGS_INVALID", "--batches must be a positive integer");
    return;
  }
  const intervalMs = Number(args["interval-ms"] ?? 5000);
  const maxRetries = args["max-retries"] == null ? 1 : Number(args["max-retries"]);
  const recipeId = args.recipe || "xhs.note.read.fixed";
  const revision = args.revision == null ? null : Number(args.revision);
  const actorId = args.actor || "agent:xhs-collect-loop";
  const traceRoot = args["trace-root"] || defaultRoutineRunStoreRoot();

  let params = {};
  if (args.params) {
    try {
      params = JSON.parse(args.params);
    } catch {
      emitError("COLLECT_ARGS_INVALID", "--params must be valid JSON");
      return;
    }
  }
  if (args.keyword != null) params = { ...params, keyword: String(args.keyword) };
  if (args.pages != null) params = { ...params, pages: Number(args.pages) };

  let devices;
  try {
    devices = aliases.map((alias, index) => ({
      alias,
      cp: createHttpCollectCp({ controlBase: `http://127.0.0.1:${ports[index]}` }),
    }));
  } catch (error) {
    emitError(error.code || "COLLECT_ENDPOINT_INVALID", error.message);
    return;
  }

  const loop = createCollectLoop({
    devices,
    recipeId,
    revision,
    params,
    actorId,
    batches,
    interBatchMs: intervalMs,
    maxRetries,
    traceRoot,
    onBatch: ({ batchIndex, wallMs, status, devices: batchDevices }) => {
      const parts = batchDevices.map((entry) => `${entry.alias}:${entry.skipped ? entry.reason : (entry.ok ? "OK" : entry.status)}`);
      console.log(`[collect-loop] batch ${batchIndex} ${status} ${(wallMs / 1000).toFixed(1)}s | ${parts.join(" ")}`);
    },
  });

  console.log(`[collect-loop] batches=${batches} intervalMs=${intervalMs} recipe=${recipeId}@${revision ?? "latest"} aliases=${aliases.join(",")}`);
  console.log(`[collect-loop] traceRoot=${traceRoot}`);
  const startedAt = Date.now();
  const summary = await loop.run();
  for (const line of progressLines(summary, startedAt)) {
    console.log(line);
  }
  console.log("=== COLLECT-LOOP SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = summary.notesSucceeded > 0 && summary.stoppedBy === null ? 0 : 4;
}

function progressLines(summary, startedAt) {
  const lines = [];
  for (const [alias, stats] of Object.entries(summary.devices)) {
    lines.push(`[collect-loop] ${alias}: ok=${stats.succeeded} failed=${stats.failed} isolated=${stats.isolated} fenced=${stats.fenced} attempts=${stats.attempts}`);
  }
  lines.push(
    `[collect-loop] batches=${summary.batchesExecuted}/${summary.batchesPlanned} notes=${summary.notesSucceeded}`
      + ` wall=${((Date.now() - startedAt) / 1000).toFixed(1)}s stoppedBy=${summary.stoppedBy ?? "none"}`,
  );
  if (summary.riskSignal) {
    lines.push(`[collect-loop] RISK STOP: alias=${summary.riskSignal.alias} signal=${summary.riskSignal.signal}`);
  }
  if (summary.persistenceErrors.length > 0) {
    lines.push(`[collect-loop] persistence errors: ${JSON.stringify(summary.persistenceErrors)}`);
  }
  return lines;
}

main().catch((error) => {
  console.log(`✗ ${error?.code || "COLLECT_LOOP_FAILED"}: ${error?.message || error}`);
  process.exitCode = 4;
});