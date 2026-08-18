#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readAndVerifyTaskCloseoutBundle,
  canonicalJson,
} from "../scripts/lib/task-closeout-contract.mjs";
import { evaluateWindowsAdoption } from "../scripts/lib/xw-adoption-policy.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "..");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) out[arg.slice(2)] = argv[++i];
    else if (arg.startsWith("--")) out[arg.slice(2)] = true;
    else out._.push(arg);
  }
  return out;
}

function fail(message) {
  console.log(`AUTO_ADOPT_FAILED ${message}`);
  process.exit(2);
}

function numberArg(args, name) {
  if (args[name] == null) fail(`missing --${name} <count>`);
  const value = Number(args[name]);
  if (!Number.isInteger(value) || value < 0) fail(`--${name} must be a non-negative integer`);
  return value;
}

function decisionHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function writeDecision(decision) {
  const dir = join(ROOT, "outbox", "adopted", decision.runId);
  const path = join(dir, "adoption.v1.json");
  mkdirSync(dir, { recursive: true });
  const payload = `${JSON.stringify(decision, null, 2)}\n`;
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (existing === payload) return { result: "already_adopted", path };
    fail(`conflicting adoption decision already exists for ${decision.runId}`);
  }
  const temp = `${path}.tmp.${process.pid}`;
  writeFileSync(temp, payload, "utf8");
  renameSync(temp, path);
  return { result: "adopted", path };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "evaluate";
  if (!["evaluate", "adopt"].includes(command)) fail("usage: xw-auto-adopt.mjs evaluate|adopt --from <bundle> --requested N --completed N [clean-state counts]");
  if (!args.from) fail("missing --from <harvest-bundle>");
  const verified = readAndVerifyTaskCloseoutBundle(resolve(args.from));
  if (!verified.ok) fail(`bundle verification failed: ${verified.errors.map((e) => `${e.path}:${e.message}`).join("; ")}`);

  const policy = evaluateWindowsAdoption(verified.closeout, {
    requestedCount: numberArg(args, "requested"),
    completedCount: numberArg(args, "completed"),
    activeLeaseCount: numberArg(args, "active-leases"),
    runningJobCount: numberArg(args, "running-jobs"),
    residualProcessCount: numberArg(args, "residual-processes"),
    unresolvedFailureCount: numberArg(args, "unresolved-failures"),
    userConfirmed: args["user-confirmed"] === true,
  });
  const base = {
    ...policy,
    runId: verified.closeout.runId,
    taskId: verified.closeout.taskId,
    manifestSha256: verified.manifestSha256,
    adoptedAt: verified.closeout.endedAt,
  };
  const decision = { ...base, decisionSha256: decisionHash(base) };

  if (command === "evaluate" || decision.status !== "accepted") {
    console.log(JSON.stringify({ ok: decision.status === "accepted", command, decision }, null, 2));
    if (decision.status !== "accepted") process.exitCode = 3;
    return;
  }
  const written = writeDecision(decision);
  console.log(JSON.stringify({ ok: true, command, ...written, decision }, null, 2));
  console.log(`AUTO_ADOPT run=${decision.runId} status=accepted result=${written.result}`);
  console.log(`decision=${written.path}`);
  console.log("localAdoption=accepted");
  console.log("macReview=not_required");
}

main();
