#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const PROGRAM_ID = /^xrp_[a-z0-9][a-z0-9._-]{2,63}$/;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function parsePositive(value) {
  if (!/^[1-9][0-9]{0,8}$/.test(String(value ?? ""))) return null;
  return Number(value);
}

function parse(argv) {
  if (!Array.isArray(argv) || !["plan", "status", "disable", "tick"].includes(argv[0])) {
    fail("XHS_RPA_ARGUMENT_INVALID", "usage: xw-rpa plan|status|disable|tick --program-id <opaque-id> [...]");
  }
  const command = argv[0];
  if ((command === "plan" || command === "status")
    && argv.length === 3 && argv[1] === "--program-id" && PROGRAM_ID.test(String(argv[2] ?? ""))) {
    return Object.freeze({ command, programId: argv[2] });
  }
  if (command === "disable" && argv.length === 5 && argv[1] === "--program-id"
    && PROGRAM_ID.test(String(argv[2] ?? "")) && argv[3] === "--generation" && parsePositive(argv[4])) {
    return Object.freeze({ command, programId: argv[2], generation: parsePositive(argv[4]) });
  }
  if (command === "tick" && argv.length === 7 && argv[1] === "--program-id"
    && PROGRAM_ID.test(String(argv[2] ?? "")) && argv[3] === "--generation" && parsePositive(argv[4])
    && argv[5] === "--idempotency-key" && IDEMPOTENCY.test(String(argv[6] ?? ""))) {
    return Object.freeze({
      command,
      programId: argv[2],
      generation: parsePositive(argv[4]),
      idempotencyKey: argv[6],
    });
  }
  fail("XHS_RPA_ARGUMENT_INVALID", "arguments must be exact; procedure, placement, recurring and enable flags are forbidden");
}

export async function runXwRpaCli(argv, {
  runtime,
  emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
} = {}) {
  const request = parse(argv);
  if (!runtime || !["plan", "status", "disable", "tick"].every((method) => typeof runtime[method] === "function")) {
    fail("XHS_RPA_TASK_CONTEXT_REQUIRED", "fixed RPA task context is not installed");
  }
  let result;
  if (request.command === "plan") result = await runtime.plan({ programId: request.programId });
  if (request.command === "status") result = await runtime.status({ programId: request.programId });
  if (request.command === "disable") {
    result = await runtime.disable({ programId: request.programId, generation: request.generation, reason: "operator_disable" });
  }
  if (request.command === "tick") {
    result = await runtime.tick({
      programId: request.programId,
      generation: request.generation,
      idempotencyKey: request.idempotencyKey,
      trigger: "manual_once",
    });
  }
  emit(result);
  return result;
}

// The immutable P5 task entry imports this facade with fixed closures. Direct
// shell execution cannot supply a loader, executor, endpoint, path or device.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: { code: "XHS_RPA_TASK_CONTEXT_REQUIRED", message: "invoke through the immutable formal task binding" },
  })}\n`);
  process.exitCode = 4;
}
