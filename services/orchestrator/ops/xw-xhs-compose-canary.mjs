#!/usr/bin/env node
/**
 * Four-device XHS compose canary.
 *
 * Parent: acquire one visible Explorer session per alias, preflight them, then
 * launch one worker process per device. Workers overlap across devices while
 * each device remains strictly serial. Like/collect/follow are forced dry-run;
 * browse/search have no external effect. Every atom starts from a verified XHS
 * home checkpoint, so this validates composition and concurrency plumbing.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  XHS_COMPOSE_PAIR_COVER,
  actionCommand,
  classifyXhsSurface,
  compileCanarySequence,
  distributeSequences,
  pairCoverage,
} from "../scripts/lib/xhs-compose-canary.mjs";
import {
  DEFAULT_ACTOR,
  ROOT,
  loadLiveFleet,
  normalizeAliases,
  parseArgs,
} from "../scripts/lib/xw-balance-shared.mjs";

const XHS_PKG = "com.xingin.xhs";
const SCRIPT_PATH = fileURLToPath(import.meta.url);

function usage() {
  return `usage:
  node ops/xw-xhs-compose-canary.mjs [--aliases 01,02,03,04] [--keyword 夏季穿搭]
  node ops/xw-xhs-compose-canary.mjs --aliases 01,02,03,04 --run <runId> --actor <actor> [--attempt 2] --execute --canary-authorized

Default is plan-only. Live mode requires exactly four ready/free devices, one
visible xiaowei.explorer.primitive session per alias, and explicit canary flags.
Effects: like=0 collect=0 follow=0 comment=0 publish=0.`;
}

function runNode(args, { allowFail = false, timeoutMs = 240_000 } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    env: process.env,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!allowFail && result.status !== 0) {
    throw new Error(`exit ${result.status}: node ${args.join(" ")}\n${result.stdout || ""}\n${result.stderr || ""}`);
  }
  return result;
}

function parseKv(output) {
  const values = {};
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

function sessionPath(runId, alias) {
  return join(homedir(), ".xhs-explorer-sessions", `xhs-compose-${runId}-${alias}.json`);
}

export function canaryAttempt(value) {
  if (value === null || value === undefined || value === "") return 1;
  if (!/^[1-9]\d*$/.test(String(value))) throw new Error("--attempt must be a positive integer");
  return Number(value);
}

export function canaryRootName(attempt = 1) {
  return attempt === 1 ? "xhs-compose-conc4" : `xhs-compose-conc4-attempt${attempt}`;
}

export function assertFreshCanaryRoot(root, makeDirectory = mkdirSync) {
  try {
    makeDirectory(root, { recursive: false });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`canary attempt evidence root already exists; use a new --attempt: ${root}`);
    }
    throw error;
  }
}

export function assertCanaryWorkerParent(record, { runId, attempt, nonce }) {
  if (!record || record.schemaId !== "xhs.compose-conc4-parent.v1"
    || record.runId !== runId || record.attempt !== attempt || record.nonce !== nonce) {
    throw new Error("worker parent binding is missing or does not match this run/attempt");
  }
}

function releaseSession(path) {
  if (!existsSync(path)) return { ok: true, skipped: true };
  const result = runNode(["ops/xw-explore-session.mjs", "release", "--session-file", path], {
    allowFail: true,
    timeoutMs: 30_000,
  });
  return { ok: result.status === 0, status: result.status, stdout: String(result.stdout || "").trim() };
}

function writeJson(path, value) {
  ensureDirectory(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function isRetryableBindingChangedResult(result) {
  if (!Number.isInteger(result?.status) || result.status === 0) return false;
  const output = `${result?.stdout || ""}\n${result?.stderr || ""}`;
  return output.includes("alias/device/serial binding changed while session was active");
}

function runLogged(args, { alias, actionId, logDir, timeoutMs = 240_000 } = {}) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const attempts = [];
  let result = runNode(args, { allowFail: true, timeoutMs });
  attempts.push({
    exitCode: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
  });
  // The shared lease gate remains authoritative. A concurrent agent-entry
  // snapshot can briefly report the device binding as unavailable before the
  // rejected primitive performs device I/O. Direct primitives use exit 4;
  // zero-effect wrapper atoms can surface the same exact gate error as exit 2.
  // In that exact case only, run the whole zero-effect atom once more.
  // Persistent or different failures still fail closed.
  if (isRetryableBindingChangedResult(result)) {
    runNode(["-e", "setTimeout(()=>{},250)"], { timeoutMs: 5_000 });
    result = runNode(args, { allowFail: true, timeoutMs });
    attempts.push({
      exitCode: result.status,
      stdout: String(result.stdout || ""),
      stderr: String(result.stderr || ""),
    });
  }
  const record = {
    alias,
    actionId,
    command: ["node", ...args],
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    exitCode: result.status,
    signal: result.signal || null,
    timedOut: Boolean(result.error?.code === "ETIMEDOUT"),
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    retryCount: attempts.length - 1,
    attempts,
  };
  const ordinal = String(Date.now()).padStart(13, "0");
  writeJson(join(logDir, `${ordinal}-${actionId}.json`), record);
  if (result.status !== 0) {
    const error = new Error(`${actionId} failed with exit ${result.status}`);
    error.record = record;
    throw error;
  }
  return record;
}

function readSurface({ alias, sessionFile, logDir, label }) {
  const focusResult = runLogged(
    ["ops/focus.mjs", "--alias", alias, "--session-file", sessionFile],
    { alias, actionId: `${label}-focus`, logDir, timeoutMs: 60_000 },
  );
  const focus = parseKv(focusResult.stdout).FOCUS || "";
  const focusOnly = classifyXhsSurface({ focus, xml: "" });
  if (!focusOnly.safe) return { ...focusOnly, focus, dump: null };
  const dumpPath = join(logDir, `${Date.now()}-${label}.xml`);
  let dumpResult;
  try {
    dumpResult = runLogged(
      ["ops/dump-ui.mjs", "--alias", alias, "--session-file", sessionFile, "--out", dumpPath],
      { alias, actionId: `${label}-dump`, logDir, timeoutMs: 90_000 },
    );
  } catch (error) {
    return {
      safe: false,
      code: "DUMP_INVALID",
      detail: String(error?.record?.stdout || error.message || error).trim().slice(0, 300),
      focus,
      dump: dumpPath,
    };
  }
  const resolvedDump = parseKv(dumpResult.stdout).DUMP || dumpPath;
  const xml = existsSync(resolvedDump) ? readFileSync(resolvedDump, "utf8") : "";
  return { ...classifyXhsSurface({ focus, xml }), focus, dump: resolvedDump };
}

function restoreXhsHome({ alias, sessionFile, logDir, label }) {
  runLogged(
    ["ops/launch-app.mjs", "--alias", alias, "--session-file", sessionFile, "--package", XHS_PKG, "--force-stop"],
    { alias, actionId: `${label}-restore-home`, logDir, timeoutMs: 60_000 },
  );
  return readSurface({ alias, sessionFile, logDir, label: `${label}-home` });
}

export function signalGlobalStop(stopPath, result, writer = writeFileSync) {
  try {
    writer(stopPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

export function workerStopRecord(alias, error, observedAt = new Date().toISOString()) {
  const stopClass = error?.stopClass || "action_failure";
  if (stopClass === "peer_stop") return null;
  return {
    alias,
    stage: "worker",
    code: stopClass,
    detail: String(error?.message || error || "worker failure").slice(0, 500),
    observedAt,
  };
}

function assertSafeSurface(surface, { alias, stage, stopPath }) {
  if (surface.safe) return;
  const result = { alias, stage, code: surface.code, detail: surface.detail, observedAt: new Date().toISOString() };
  signalGlobalStop(stopPath, result);
  const error = new Error(`${surface.code} at ${stage}: ${surface.detail}`);
  error.stopClass = "risk_or_unknown_surface";
  error.surface = result;
  throw error;
}

function runBrowse({ alias, sessionFile, logDir }) {
  const before = readSurface({ alias, sessionFile, logDir, label: "browse-before" });
  runLogged(
    ["ops/swipe.mjs", "--alias", alias, "--session-file", sessionFile, "--up", "--ms", "350"],
    { alias, actionId: "browse-swipe", logDir, timeoutMs: 60_000 },
  );
  runNode(["-e", "setTimeout(()=>{},900)"], { timeoutMs: 5_000 });
  const after = readSurface({ alias, sessionFile, logDir, label: "browse-after" });
  return { before, after };
}

async function workerMain(args) {
  if (args.execute !== true || args["canary-authorized"] !== true) throw new Error("worker requires live canary authorization flags");
  const alias = normalizeAliases(args.aliases || args.alias)[0];
  const runId = String(args.run || "");
  const actor = String(args.actor || "");
  const attempt = canaryAttempt(args.attempt);
  const parentNonce = String(args["parent-nonce"] || "");
  const sessionFile = String(args["session-file"] || "");
  const keyword = String(args.keyword || "夏季穿搭");
  if (!/^run_[A-Za-z0-9._-]+$/.test(runId)) throw new Error("valid --run is required");
  if (!actor || !sessionFile || !parentNonce) throw new Error("worker requires --actor, --session-file and --parent-nonce");
  const sequences = JSON.parse(String(args["sequences-json"] || "[]"));
  const rootName = canaryRootName(attempt);
  const root = join(ROOT, "outbox", "work", runId, rootName);
  const parentPath = join(root, "parent.json");
  const parentRecord = existsSync(parentPath) ? JSON.parse(readFileSync(parentPath, "utf8")) : null;
  assertCanaryWorkerParent(parentRecord, { runId, attempt, nonce: parentNonce });
  const workDir = ensureDirectory(join(root, alias));
  const stopPath = join(root, "STOP.json");
  const resultPath = join(workDir, "result.json");
  const result = {
    alias,
    actor,
    ok: false,
    startedAt: new Date().toISOString(),
    endedAt: null,
    sequences: [],
    effects: { like: 0, collect: 0, follow: 0, comment: 0, publish: 0 },
    reason: null,
    stopClass: null,
  };
  console.log(`WORKER_START alias=${alias} sequences=${sequences.length}`);
  try {
    for (let sequenceIndex = 0; sequenceIndex < sequences.length; sequenceIndex += 1) {
      const sequence = sequences[sequenceIndex];
      if (existsSync(stopPath)) throw Object.assign(new Error("global stop requested by another worker"), { stopClass: "peer_stop" });
      const plan = compileCanarySequence(sequence, { keyword });
      const sequenceResult = { index: sequenceIndex, sequence, planId: plan.planId, ok: false, actions: [] };
      result.sequences.push(sequenceResult);
      console.log(`SEQUENCE_START alias=${alias} index=${sequenceIndex} order=${sequence.join(">")}`);
      for (let actionIndex = 0; actionIndex < sequence.length; actionIndex += 1) {
        if (existsSync(stopPath)) throw Object.assign(new Error("global stop requested by another worker"), { stopClass: "peer_stop" });
        const actionId = sequence[actionIndex];
        const actionDir = ensureDirectory(join(workDir, `seq-${sequenceIndex + 1}`, `${actionIndex + 1}-${actionId}`));
        console.log(`ACTION_START alias=${alias} sequence=${sequenceIndex} action=${actionId}`);
        const home = restoreXhsHome({ alias, sessionFile, logDir: actionDir, label: actionId });
        assertSafeSurface(home, { alias, stage: `${actionId}:home`, stopPath });
        const startedMs = Date.now();
        if (actionId === "browse_feed") {
          const browse = runBrowse({ alias, sessionFile, logDir: actionDir });
          assertSafeSurface(browse.before, { alias, stage: `${actionId}:before`, stopPath });
          assertSafeSurface(browse.after, { alias, stage: `${actionId}:after`, stopPath });
        } else {
          const command = actionCommand(actionId, { alias, sessionFile, keyword });
          runLogged(command, { alias, actionId, logDir: actionDir });
          const after = readSurface({ alias, sessionFile, logDir: actionDir, label: `${actionId}-after` });
          assertSafeSurface(after, { alias, stage: `${actionId}:after`, stopPath });
        }
        sequenceResult.actions.push({ actionId, ok: true, durationMs: Date.now() - startedMs });
        console.log(`ACTION_OK alias=${alias} sequence=${sequenceIndex} action=${actionId}`);
      }
      sequenceResult.ok = true;
      console.log(`SEQUENCE_OK alias=${alias} index=${sequenceIndex}`);
    }
    const finalHome = restoreXhsHome({ alias, sessionFile, logDir: workDir, label: "final" });
    assertSafeSurface(finalHome, { alias, stage: "final-home", stopPath });
    result.ok = true;
  } catch (error) {
    result.reason = String(error.message || error).slice(0, 500);
    result.stopClass = error.stopClass || "action_failure";
    const stopRecord = workerStopRecord(alias, error);
    if (stopRecord) signalGlobalStop(stopPath, stopRecord);
    console.log(`WORKER_FAIL alias=${alias} class=${result.stopClass} reason=${result.reason}`);
    if (result.stopClass !== "risk_or_unknown_surface") {
      try { restoreXhsHome({ alias, sessionFile, logDir: workDir, label: "failure-cleanup" }); } catch { /* best effort */ }
    }
  } finally {
    result.endedAt = new Date().toISOString();
    writeJson(resultPath, result);
  }
  console.log(`WORKER_END alias=${alias} ok=${result.ok}`);
  return result.ok ? 0 : 1;
}

function spawnWorker({ alias, actor, runId, attempt, parentNonce, sessionFile, sequences, keyword }) {
  const child = spawn(process.execPath, [
    SCRIPT_PATH,
    "--worker",
    "--alias", alias,
    "--actor", actor,
    "--run", runId,
    "--attempt", String(attempt),
    "--parent-nonce", parentNonce,
    "--session-file", sessionFile,
    "--sequences-json", JSON.stringify(sequences),
    "--keyword", keyword,
    "--execute",
    "--canary-authorized",
  ], {
    cwd: ROOT,
    env: process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = `[${alias}] `;
  child.stdout.on("data", (chunk) => process.stdout.write(`${prefix}${String(chunk).replace(/\n(?=.)/g, `\n${prefix}`)}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`${prefix}${String(chunk).replace(/\n(?=.)/g, `\n${prefix}`)}`));
  return new Promise((resolve) => child.on("close", (code, signal) => resolve({ alias, code, signal })));
}

async function parentMain(args) {
  if (args.help || args.h) {
    console.log(usage());
    return 0;
  }
  const aliases = normalizeAliases(args.aliases || "01,02,03,04");
  const keyword = String(args.keyword || "夏季穿搭");
  const actor = String(args.actor || DEFAULT_ACTOR);
  const attempt = canaryAttempt(args.attempt);
  const assignments = distributeSequences(aliases);
  const coverage = pairCoverage();
  const plans = Object.fromEntries(
    aliases.map((alias) => [alias, assignments[alias].map((sequence) => compileCanarySequence(sequence, { keyword }))]),
  );
  const summary = {
    schemaId: "xhs.compose-conc4-canary-plan.v1",
    attempt,
    aliases,
    capabilityId: "xiaowei.explorer.primitive",
    entry: "session",
    workerConcurrency: aliases.length,
    perDeviceConcurrency: 1,
    transportTrueSplit: false,
    effectBudget: { like: 0, collect: 0, follow: 0, comment: 0, publish: 0, maximumTotal: 0 },
    coverage: { expectedPairs: coverage.expected.length, coveredPairs: coverage.covered.length, missing: coverage.missing },
    assignments: Object.fromEntries(aliases.map((alias) => [alias, assignments[alias].map((sequence, index) => ({
      index,
      sequence,
      planId: plans[alias][index].planId,
    }))])),
  };
  if (args.execute !== true) {
    console.log(JSON.stringify({ ok: true, mode: "plan", ...summary }, null, 2));
    return 0;
  }
  if (args["canary-authorized"] !== true) throw new Error("live run requires --canary-authorized");
  if (aliases.length !== 4) throw new Error("live concurrency canary requires exactly four aliases");
  const runId = String(args.run || "");
  if (!/^run_[A-Za-z0-9._-]+$/.test(runId)) throw new Error("live run requires explicit --run");

  const fleet = await loadLiveFleet();
  const byAlias = new Map(fleet.map((device) => [device.alias, device]));
  const blocked = aliases.flatMap((alias) => {
    const device = byAlias.get(alias);
    if (!device) return [`${alias}:missing`];
    if (!device.online || !device.ready || device.quarantined || device.lease !== "free") {
      return [`${alias}:online=${device.online},ready=${device.ready},quarantined=${device.quarantined},lease=${device.lease}`];
    }
    return [];
  });
  if (blocked.length) throw new Error(`four-device precondition failed: ${blocked.join("; ")}`);

  const root = join(ROOT, "outbox", "work", runId, canaryRootName(attempt));
  assertFreshCanaryRoot(root);
  const parentNonce = randomUUID();
  writeJson(join(root, "parent.json"), {
    schemaId: "xhs.compose-conc4-parent.v1",
    runId,
    attempt,
    nonce: parentNonce,
    createdAt: new Date().toISOString(),
  });
  const stopPath = join(root, "STOP.json");
  if (existsSync(stopPath)) throw new Error(`run stop marker already exists: ${stopPath}`);
  writeJson(join(root, "plan.json"), summary);
  const sessions = [];
  const releases = [];
  let workerExits = [];
  try {
    for (const alias of aliases) {
      const path = sessionPath(runId, alias);
      releaseSession(path);
      const acquired = runNode([
        "ops/xw-explore-session.mjs", "acquire",
        "--alias", alias,
        "--actor", actor,
        "--session-file", path,
      ], { timeoutMs: 30_000 });
      sessions.push({ alias, path, public: JSON.parse(String(acquired.stdout || "{}").trim()) });
    }
    for (const session of sessions) {
      runNode([
        "ops/explore-preflight.mjs", "--alias", session.alias, "--session-file", session.path,
      ], { timeoutMs: 60_000 });
    }
    console.log(`CONCURRENCY_START aliases=${aliases.join(",")} workers=${aliases.length} transportTrueSplit=false`);
    const startedMs = Date.now();
    const activeWorkers = new Set(aliases);
    const ticker = setInterval(() => {
      console.log(`LIVE_PROGRESS elapsedSec=${Math.floor((Date.now() - startedMs) / 1000)} activeWorkers=${activeWorkers.size} aliases=${[...activeWorkers].join(",")}`);
    }, 30_000);
    try {
      workerExits = await Promise.all(sessions.map(async (session) => {
        const exit = await spawnWorker({
          alias: session.alias,
          actor,
          runId,
          attempt,
          parentNonce,
          sessionFile: session.path,
          sequences: assignments[session.alias],
          keyword,
        });
        activeWorkers.delete(session.alias);
        releases.push({ alias: session.alias, ...releaseSession(session.path) });
        return exit;
      }));
    } finally {
      clearInterval(ticker);
    }
  } finally {
    for (const session of sessions) {
      if (!releases.some((release) => release.alias === session.alias)) {
        releases.push({ alias: session.alias, ...releaseSession(session.path) });
      }
    }
  }

  const results = aliases.map((alias) => {
    const path = join(root, alias, "result.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { alias, ok: false, reason: "worker_result_missing" };
  });
  const output = {
    ok: results.every((result) => result.ok),
    mode: "execute",
    runId,
    ...summary,
    workerExits,
    results,
    releases: releases.sort((left, right) => left.alias.localeCompare(right.alias)),
    stop: existsSync(stopPath) ? JSON.parse(readFileSync(stopPath, "utf8")) : null,
  };
  writeJson(join(root, "summary.json"), output);
  console.log(JSON.stringify(output, null, 2));
  return output.ok ? 0 : 1;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.worker === true) return workerMain(args);
  return parentMain(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.log(JSON.stringify({ ok: false, error: String(error.message || error).slice(0, 1000) }, null, 2));
    process.exit(4);
  });
}
