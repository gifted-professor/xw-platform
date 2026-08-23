#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { M6_TOOL_NAMES } from "../../services/orchestrator/scripts/lib/m6/m6-tool-surface.mjs";

const SCHEMA_ID = "xw.m6-broker-spike.v1";
const MAX_LINE_BYTES = 64 * 1024;
const CASE_TIMEOUT_MS = 1_000;
const CHILD = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "m6-4-broker-child.mjs");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function writeLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function expectedCode(mode) {
  return {
    "wrong-run": "BROKER_BINDING_MISMATCH",
    "wrong-worker": "BROKER_BINDING_MISMATCH",
    "wrong-session": "BROKER_BINDING_MISMATCH",
    "wrong-alias": "BROKER_BINDING_MISMATCH",
    "extra-method": "BROKER_METHOD_FORBIDDEN",
    replay: "BROKER_NONCE_REPLAY",
    oversize: "BROKER_LINE_LIMIT",
    timeout: "BROKER_INCOMPLETE_TIMEOUT",
    "descendant-growth": "BROKER_PROCESS_TREE_GROWTH",
  }[mode] || null;
}

function reject(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

async function waitForExit(child, timeoutMs = 2_000) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), timeoutMs)),
  ]);
}

async function closeChild(child) {
  child.stdio[3]?.destroy();
  if (!(await waitForExit(child, 300))) child.kill();
  const closed = await waitForExit(child, 2_000);
  return { closed, exitCode: child.exitCode, signalCode: child.signalCode };
}

async function runCase(mode) {
  const binding = {
    runId: "run-m6-4-broker-spike",
    workerId: "worker-m6-4-broker-spike",
    sessionId: "session-m6-4-broker-spike",
    alias: "01",
    processRef: `process-${randomUUID()}`,
  };
  const child = spawn(process.execPath, [CHILD], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      XW_M6_BROKER_CASE: mode,
      XW_M6_BROKER_FD: "3",
      XW_M6_BROKER_BINDING: JSON.stringify(binding),
    },
  });
  const pipe = child.stdio[3];
  let buffer = Buffer.alloc(0);
  let hello = null;
  const calls = [];
  const nonces = new Set();
  let settled = false;
  let error = null;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const completion = new Promise((resolvePromise) => {
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    const fail = (caught) => {
      error = caught;
      try { writeLine(pipe, { type: "reject", code: caught.code || "BROKER_INVALID" }); } catch {}
      finish();
    };
    pipe.on("data", (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      if (buffer.length > MAX_LINE_BYTES && !buffer.includes(0x0a)) {
        fail(Object.assign(new Error("broker frame exceeded incomplete-line limit"), { code: "BROKER_LINE_LIMIT" }));
        return;
      }
      while (buffer.includes(0x0a) && !settled) {
        const newline = buffer.indexOf(0x0a);
        const raw = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (raw.length > MAX_LINE_BYTES) {
          fail(Object.assign(new Error("broker frame exceeded line limit"), { code: "BROKER_LINE_LIMIT" }));
          return;
        }
        try {
          const message = JSON.parse(raw.toString("utf8"));
          if (!hello) {
            if (message.type !== "hello") reject("BROKER_HELLO_REQUIRED", "first broker frame must be hello");
            if (message.processRef !== binding.processRef) reject("BROKER_BINDING_MISMATCH", "hello processRef mismatch");
            if (canonical(message.toolNames) !== canonical(M6_TOOL_NAMES)) reject("BROKER_TOOL_INVENTORY_MISMATCH", "tool inventory mismatch");
            if (message.brokerFd !== 3 || message.transportAuthorityPresent || message.rawDeviceIdentityPresent) {
              reject("BROKER_AUTHORITY_LEAK", "child reported forbidden authority");
            }
            hello = message;
            continue;
          }
          if (message.type === "process_tree_growth") reject("BROKER_PROCESS_TREE_GROWTH", "unexpected descendant invalidates pipe possession");
          if (message.type === "complete") {
            if (mode !== "happy" || calls.length !== M6_TOOL_NAMES.length) reject("BROKER_CALL_COUNT", "happy case did not call all tools exactly once");
            writeLine(pipe, { type: "complete_ack" });
            finish();
            continue;
          }
          if (message.type !== "tool_call") reject("BROKER_FRAME_INVALID", "unexpected broker frame");
          for (const key of ["runId", "workerId", "sessionId", "alias", "processRef"]) {
            if (message.correlation?.[key] !== binding[key]) reject("BROKER_BINDING_MISMATCH", `broker ${key} mismatch`);
          }
          if (!M6_TOOL_NAMES.includes(message.method)) reject("BROKER_METHOD_FORBIDDEN", "method is outside exact ten-tool inventory");
          if (typeof message.nonce !== "string" || nonces.has(message.nonce)) reject("BROKER_NONCE_REPLAY", "broker nonce replay");
          nonces.add(message.nonce);
          calls.push({ method: message.method, nonceHash: sha256(message.nonce) });
          writeLine(pipe, { type: "tool_result", nonceHash: sha256(message.nonce), ok: true, externalEffect: false, actionCount: 0 });
        } catch (caught) {
          fail(caught);
        }
      }
    });
    pipe.once("error", (caught) => fail(Object.assign(caught, { code: caught.code || "BROKER_PIPE_ERROR" })));
    child.once("error", (caught) => fail(Object.assign(caught, { code: "BROKER_CHILD_ERROR" })));
    child.once("exit", () => {
      if (!settled) fail(Object.assign(new Error("child exited before broker completion"), { code: "BROKER_CHILD_EARLY_EXIT" }));
    });
    setTimeout(() => {
      if (settled) return;
      const code = buffer.length > 0 ? "BROKER_INCOMPLETE_TIMEOUT" : "BROKER_TIMEOUT";
      fail(Object.assign(new Error("broker case timed out"), { code }));
    }, CASE_TIMEOUT_MS).unref();
  });

  await completion;
  const close = await closeChild(child);
  const expected = expectedCode(mode);
  const passed = mode === "happy"
    ? !error && calls.length === 10 && new Set(calls.map((call) => call.method)).size === 10 && close.closed
    : error?.code === expected && close.closed;
  return {
    mode,
    passed,
    expectedCode: expected,
    actualCode: error?.code || null,
    helloVerified: Boolean(hello),
    callCount: calls.length,
    uniqueToolCount: new Set(calls.map((call) => call.method)).size,
    externalEffect: false,
    actionCount: 0,
    pipeClosed: pipe.destroyed,
    processClosed: close.closed,
    exitCode: close.exitCode,
    signalCode: close.signalCode,
    stderrSha256: sha256(stderr),
  };
}

async function main() {
  const outIndex = process.argv.indexOf("--out");
  const out = resolve(outIndex >= 0 && process.argv[outIndex + 1]
    ? process.argv[outIndex + 1]
    : "artifacts/m6-4/m6-4-broker-spike.json");
  const modes = [
    "happy",
    "wrong-run",
    "wrong-worker",
    "wrong-session",
    "wrong-alias",
    "extra-method",
    "replay",
    "oversize",
    "timeout",
    "descendant-growth",
  ];
  const cases = [];
  for (const mode of modes) cases.push(await runCase(mode));
  const sourceSha256 = sha256(readFileSync(fileURLToPath(import.meta.url)));
  const childSourceSha256 = sha256(readFileSync(CHILD));
  const core = {
    schemaId: SCHEMA_ID,
    adapterKind: "real-child-extra-stdio-possession-broker",
    sourceSha256,
    childSourceSha256,
    exactToolNames: M6_TOOL_NAMES,
    toolCount: M6_TOOL_NAMES.length,
    listenerOpened: false,
    brokerTokenInChild: false,
    payloadProcessRefAuthorityClaimed: false,
    pipePossessionAuthority: true,
    cases,
    allPassed: cases.every((entry) => entry.passed),
    remainingOwnedTrees: cases.filter((entry) => !entry.processClosed).length,
  };
  const artifact = { ...core, artifactSha256: sha256(`${SCHEMA_ID}:${canonical(core)}`) };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: artifact.allPassed && artifact.remainingOwnedTrees === 0, out, cases, artifactSha256: artifact.artifactSha256 }, null, 2)}\n`);
  return artifact.allPassed && artifact.remainingOwnedTrees === 0 ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, code: error.code, stack: error.stack }, null, 2)}\n`);
  process.exitCode = 2;
});
