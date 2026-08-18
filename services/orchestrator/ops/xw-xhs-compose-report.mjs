#!/usr/bin/env node

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  backfillRunReport,
  validateRunReports,
} from "../scripts/lib/xhs-run-report.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      args._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function usage() {
  return `usage:
  node ops/xw-xhs-compose-report.mjs backfill --run <runId>
  node ops/xw-xhs-compose-report.mjs validate --run <runId>

Both commands are local evidence operations. They never acquire a lease, submit a
job, call the device transport, or change an existing raw attempt artifact.`;
}

export async function main(argv = process.argv.slice(2), { repoRoot = ROOT } = {}) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (args.help || args.h || !command) {
    console.log(usage());
    return command ? 0 : 2;
  }
  const runId = String(args.run || "");
  if (!/^run_[A-Za-z0-9._-]+$/.test(runId)) throw new Error("valid --run is required");
  if (command === "backfill") {
    const result = backfillRunReport({ repoRoot, runId });
    console.log(JSON.stringify({
      ok: true,
      command,
      runId,
      reportRoot: result.reportRoot,
      status: result.summary.status,
      attempts: result.attempts.map((attempt) => ({ attempt: attempt.attempt, status: attempt.summary.status })),
    }, null, 2));
    return 0;
  }
  if (command === "validate") {
    const result = validateRunReports({ repoRoot, runId });
    console.log(JSON.stringify({
      ok: result.ok,
      command,
      runId,
      errors: result.errors,
      attempts: result.attempts.map((attempt) => ({ attempt: attempt.attempt, status: attempt.summary?.status || "missing" })),
      closeout: {
        runEvidenceMismatches: result.closeoutAudit.runEvidenceMismatches,
        mutableSourceDrift: result.closeoutAudit.mutableSourceDrift,
      },
    }, null, 2));
    return result.ok ? 0 : 1;
  }
  throw new Error(`unsupported command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.log(JSON.stringify({ ok: false, error: String(error.message || error) }, null, 2));
    process.exit(4);
  });
}
