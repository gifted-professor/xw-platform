#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { ControlClient } from "../control-client/lib/control-client.mjs";

function usage() {
  return `xw phone attach|observe|act|trace|replay|release [--json] [--jsonl] [--non-interactive] [--context-file PATH] [--trace-id ID]
Token is read from XW_CONTROL_TOKEN or --token-file. Never pass tokens on argv, query, or stdout.`;
}

function argOf(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  if (index < 0 || index === argv.length - 1) return fallback;
  return argv[index + 1];
}

function has(argv, name) {
  return argv.includes(name);
}

function readToken(argv) {
  const file = argOf(argv, "--token-file");
  if (file) return readFileSync(resolve(file), "utf8").trim();
  return process.env.XW_CONTROL_TOKEN || process.env.XHS_CONTROL_TOKEN || null;
}

function loadContext(argv) {
  const file = argOf(argv, "--context-file");
  if (!file || !existsSync(resolve(file))) return {};
  return JSON.parse(readFileSync(resolve(file), "utf8"));
}

function saveContext(argv, context) {
  const file = argOf(argv, "--context-file");
  if (!file) return;
  writeFileSync(resolve(file), `${JSON.stringify(context, null, 2)}\n`);
}

function emit(argv, value) {
  if (has(argv, "--jsonl") && Array.isArray(value)) {
    for (const item of value) process.stdout.write(`${JSON.stringify(item)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function redact(value) {
  if (!value || typeof value !== "object") return value;
  const copy = Array.isArray(value) ? [...value] : { ...value };
  for (const key of Object.keys(copy)) {
    if (/token|authorization|password|secret/i.test(key)) copy[key] = "[redacted]";
    else if (copy[key] && typeof copy[key] === "object") copy[key] = redact(copy[key]);
  }
  return copy;
}

async function main(argv = process.argv.slice(2)) {
  if (argv[0] !== "phone" || !argv[1] || argv.includes("--help")) {
    process.stderr.write(`${usage()}\n`);
    return argv.includes("--help") ? 0 : 2;
  }
  const command = argv[1];
  const baseUrl = argOf(argv, "--control", process.env.XW_CONTROL_URL || "http://127.0.0.1:17920");
  const token = readToken(argv);
  const client = new ControlClient({ baseUrl, token });
  const context = loadContext(argv);
  const sessionId = argOf(argv, "--session", context.sessionId);
  const sessionToken = context.token || null;

  if (["observe", "act", "trace", "release"].includes(command) && (!sessionId || !sessionToken)) {
    process.stderr.write("missing --context-file session\n");
    return 2;
  }

  if (command === "attach") {
    const created = await client.createDeviceSession({
      actorId: argOf(argv, "--actor", "agent:cli"),
      deviceId: argOf(argv, "--device"),
    });
    saveContext(argv, {
      sessionId: created.session.sessionId,
      token: created.token,
      traceId: argOf(argv, "--trace-id", created.session.sessionId),
    });
    emit(argv, redact({ ok: true, session: created.session, expiresAt: created.expiresAt }));
    return 0;
  }
  if (command === "observe") {
    const observed = await client.observe(sessionId, sessionToken, {});
    context.lastObservationId = observed.observation.observationId;
    saveContext(argv, context);
    emit(argv, redact(observed));
    return 0;
  }
  if (command === "act") {
    const requestPath = argOf(argv, "--request");
    const request = requestPath ? JSON.parse(readFileSync(resolve(requestPath), "utf8")) : JSON.parse(argOf(argv, "--request-json", "{}"));
    const acted = await client.act(sessionId, sessionToken, request);
    saveContext(argv, context);
    emit(argv, redact(acted));
    return 0;
  }
  if (command === "trace") {
    const events = await client.events(sessionId, sessionToken, Number(argOf(argv, "--after", "0")));
    emit(argv, has(argv, "--jsonl") ? events.events : redact(events));
    return 0;
  }
  if (command === "replay") {
    emit(argv, { ok: true, mode: "recorded_replay", transportCalled: false, liveCanaryGate: "CLOSED" });
    return 0;
  }
  if (command === "release") {
    const released = await client.release(sessionId, sessionToken);
    saveContext(argv, {});
    emit(argv, redact(released));
    return 0;
  }
  process.stderr.write(`${usage()}\n`);
  return 2;
}

if (import.meta.url === `file://${process.argv[1].replaceAll("\\", "/")}` || process.argv[1]?.endsWith("xw.mjs")) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error.code || "CLI_ERROR"}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export { main, redact };
