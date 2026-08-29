#!/usr/bin/env node
/**
 * Fixed task CLI facade for V3 R0/R1/R2.
 *
 * The formal Gate-F task imports `runXhsV3TaskCli` and supplies its fixed
 * invocation loader and production runner once at bootstrap.  The command
 * line carries only a phase and an opaque task invocation id; it cannot carry
 * aliases, endpoints, providers, paths, modules, roles, credentials, or
 * E-Corpus material.
 */
import { pathToFileURL } from "node:url";

import {
  XHS_V3_TASK_INVOCATION_SCHEMA_ID,
} from "../scripts/lib/xhs-exploration-production-runner.mjs";

const COMMAND_PHASE = Object.freeze({ r0: "R0", r1: "R1", r2: "R2" });
const INVOCATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 3
    || !Object.hasOwn(COMMAND_PHASE, String(argv[0] ?? "").toLowerCase())
    || argv[1] !== "--invocation-id"
    || !INVOCATION_ID.test(String(argv[2] ?? ""))) {
    fail(
      "XHS_V3_TASK_ARGUMENT_INVALID",
      "usage: xw-xhs-exploration-run.mjs r0|r1|r2 --invocation-id <opaque-id>",
    );
  }
  return Object.freeze({
    phase: COMMAND_PHASE[String(argv[0]).toLowerCase()],
    invocationId: String(argv[2]),
  });
}

function validateLoadedInvocation(value) {
  const keys = ["schemaId", "plan", "privatePayload"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !keys.includes(key))
    || value.schemaId !== XHS_V3_TASK_INVOCATION_SCHEMA_ID) {
    fail("XHS_V3_TASK_INVOCATION_INVALID", "fixed task loader returned a malformed invocation");
  }
  return value;
}

export async function runXhsV3TaskCli(argv, {
  loadTaskInvocation,
  runner,
  emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
} = {}) {
  const request = parseArgs(argv);
  if (typeof loadTaskInvocation !== "function" || !runner || typeof runner.run !== "function") {
    fail("XHS_V3_TASK_CONTEXT_REQUIRED", "Gate-F fixed task context is not installed");
  }
  const loaded = validateLoadedInvocation(await loadTaskInvocation(request.invocationId));
  const result = await runner.run({
    phase: request.phase,
    plan: loaded.plan,
    privatePayload: loaded.privatePayload,
  });
  emit(result);
  return result;
}

// Direct execution is intentionally inert. P5's immutable task launcher calls
// the exported facade with its fixed loader/runtime closure; this prevents a
// shell caller from supplying a store, module, endpoint, provider, or secret.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: {
      code: "XHS_V3_TASK_CONTEXT_REQUIRED",
      message: "invoke through the immutable Gate-F task binding",
    },
  })}\n`);
  process.exitCode = 4;
}
