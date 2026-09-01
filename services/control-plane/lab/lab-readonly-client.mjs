// XHS lab-only read-only FastOperator entry — client CLI (Plan V2, xhs-lab-readonly-fast-entry-v1).
//
// Exact-command client: start | stop | status | focus <slot> | dump <slot> [label].
// Node stdlib only, current user, zero elevation. The client never constructs a
// FastOperator body — it sends {slot, action, label?, requestId} to the gateway,
// which is the single trust boundary. The client token is required for every
// gateway call and lives in the Git-ignored .xw-lab/ data directory.
//
// A client-side deadline only stops the client from waiting; it never releases
// the underlying lease (fail-stop semantics on the gateway).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { labDataDir, loadOrCreateClientToken } from "./lab-readonly-gateway.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATEWAY_PATH = join(HERE, "lab-readonly-gateway.mjs");
const DEFAULT_CONTROL_PORT = 17920;
const DEFAULT_ENTRY_PORT = 17930;
const DEFAULT_WAIT_MS = 30_000;

class ClientError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
  }
}

function controlBase() {
  return `http://127.0.0.1:${process.env.XHS_LAB_CONTROL_PORT || DEFAULT_CONTROL_PORT}`;
}

function entryBase() {
  return `http://127.0.0.1:${process.env.XHS_LAB_ENTRY_PORT || DEFAULT_ENTRY_PORT}`;
}

function clientToken() {
  return loadOrCreateClientToken(labDataDir());
}

async function fetchJson(url, options = {}, deadlineMs = 8000) {
  let response;
  try {
    response = await globalThis.fetch(url, { ...options, signal: AbortSignal.timeout(deadlineMs) });
  } catch {
    throw new ClientError("GATEWAY_UNAVAILABLE", "gateway is not reachable on 127.0.0.1");
  }
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body };
}

function parseArgs(argv, spec) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (!Object.hasOwn(spec.flags, name)) {
        throw new ClientError("UNKNOWN_ARGUMENT", `unknown argument --${name}`);
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ClientError("MALFORMED_ARGUMENT", `--${name} requires a value`);
      }
      flags[name] = value;
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length < spec.min || positional.length > spec.max) {
    throw new ClientError("MALFORMED_ARGUMENT", `expected ${spec.min}..${spec.max} positional args`);
  }
  return { positional, flags };
}

function requireSlot(value) {
  if (value !== "01" && value !== "02") {
    throw new ClientError("UNKNOWN_SLOT", "slot must be 01 or 02");
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readPid(pidPath) {
  try {
    const value = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Spawn the gateway detached (current user, no elevation) and wait for health.
// The gateway itself fails closed if either loopback port is occupied.
async function cmdStart() {
  if (process.argv.length !== 3) throw new ClientError("LAB_ARGUMENT_FORBIDDEN", "start takes no arguments");
  const dataDir = labDataDir();
  mkdirSync(dataDir, { recursive: true });
  const pidPath = join(dataDir, "gateway.pid");
  const existing = readPid(pidPath);
  if (existing && pidAlive(existing)) {
    emit({ ok: true, alreadyRunning: true, pid: existing });
    return;
  }
  try { rmSync(pidPath, { force: true }); } catch { /* best effort */ }
  const logFd = openSync(join(dataDir, "gateway.log"), "a");
  const child = spawn(process.execPath, [GATEWAY_PATH], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  for (let waited = 0; waited <= 8000; waited += 100) {
    await sleep(100);
    if (child.exitCode !== null || child.signalCode !== null) {
      emit({
        ok: false,
        code: "GATEWAY_EXITED",
        exitCode: child.exitCode,
        note: "see gateway.log; PORT_OCCUPIED means 17920/17930 were already in use — the occupier is never touched",
      });
      process.exitCode = 2;
      return;
    }
    try {
      const health = await fetchJson(`${controlBase()}/healthz`, { method: "GET" }, 1000);
      if (health.status === 200 && health.body?.ok === true) {
        emit({
          ok: true,
          pid: child.pid,
          controlPort: health.body.controlPort,
          entryPort: health.body.entryPort,
        });
        return;
      }
    } catch { /* keep polling until deadline */ }
  }
  emit({ ok: false, code: "GATEWAY_START_TIMEOUT" });
  process.exitCode = 2;
}

// Stop ONLY the gateway pid this lab recorded. Never any other process.
async function cmdStop() {
  if (process.argv.length !== 3) throw new ClientError("LAB_ARGUMENT_FORBIDDEN", "stop takes no arguments");
  const dataDir = labDataDir();
  const pidPath = join(dataDir, "gateway.pid");
  const pid = readPid(pidPath);
  if (!pid || !pidAlive(pid)) {
    try { rmSync(pidPath, { force: true }); } catch { /* best effort */ }
    emit({ ok: true, stopped: false, note: "no live gateway pid recorded" });
    return;
  }
  process.kill(pid, "SIGTERM");
  for (let waited = 0; waited < 2000 && pidAlive(pid); waited += 100) {
    await sleep(100);
  }
  try { rmSync(pidPath, { force: true }); } catch { /* best effort */ }
  emit({
    ok: true,
    stopped: true,
    pid,
    note: "rollback: only the lab gateway was stopped; FastOperator 01/02 and everything else untouched",
  });
}

async function cmdStatus() {
  const token = clientToken();
  const leases = await fetchJson(`${controlBase()}/control/v1/leases`, {
    method: "GET",
    headers: { "x-lab-client-token": token },
  });
  let entry = null;
  try {
    entry = (await fetchJson(`${entryBase()}/agent-entry.json`, { method: "GET" }, 3000)).body;
  } catch { /* entry content is advisory */ }
  emit({
    ok: leases.status === 200,
    leases: leases.body?.leases ?? null,
    gateway: entry === null
      ? null
      : {
          mode: entry.mode,
          labOnly: entry.labOnly,
          productionAcceptance: entry.productionAcceptance,
          pid: entry.pid,
          activeLeases: entry.activeLeases,
        },
  });
  if (leases.status !== 200) process.exitCode = 2;
}

async function cmdOperate(action, argv) {
  const spec = action === "dump"
    ? { flags: { label: true, "wait-ms": true }, min: 1, max: 2, allowLabel: true }
    : { flags: { "wait-ms": true }, min: 1, max: 1, allowLabel: false };
  const { positional, flags } = parseArgs(argv, spec);
  const slot = requireSlot(positional[0]);
  const waitMs = flags["wait-ms"] ? Number.parseInt(flags["wait-ms"], 10) : DEFAULT_WAIT_MS;
  if (!Number.isInteger(waitMs) || waitMs < 100 || waitMs > 300_000) {
    throw new ClientError("MALFORMED_ARGUMENT", "--wait-ms must be 100..300000");
  }
  const token = clientToken();
  const payload = {
    action,
    slot,
    requestId: randomUUID(),
    ...(action === "dump" && flags.label !== undefined ? { label: flags.label } : {}),
  };
  let response;
  try {
    response = await globalThis.fetch(`${controlBase()}/lab/v1/requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-lab-client-token": token },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(waitMs),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.code === "ABORT_ERR") {
      emit({
        ok: false,
        code: "CLIENT_DEADLINE",
        note: "the client stopped waiting; the underlying lease was NOT released — run xhs:lab:status",
      });
      process.exitCode = 3;
      return;
    }
    throw new ClientError("GATEWAY_UNAVAILABLE");
  }
  const body = await response.json().catch(() => null);
  emit({ httpStatus: response.status, ...(body ?? { ok: false, code: "MALFORMED_RESPONSE" }) });
  if (!response.ok || body?.ok !== true) process.exitCode = 1;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === "start") return await cmdStart();
    if (command === "stop") return await cmdStop();
    if (command === "status") return await cmdStatus();
    if (command === "focus") return await cmdOperate("focus", rest);
    if (command === "dump") return await cmdOperate("dump", rest);
    throw new ClientError("UNKNOWN_COMMAND", "usage: lab-readonly-client.mjs start|stop|status|focus <01|02>|dump <01|02> [label]");
  } catch (error) {
    emit({ ok: false, code: error?.code ?? "CLIENT_FAILED", message: error?.code ?? "CLIENT_FAILED" });
    process.exitCode = 1;
  }
}

const invokedDirectly = (() => {
  try {
    const argvPath = process.argv[1];
    if (!argvPath) return false;
    return pathToFileURL(argvPath).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  void main();
}