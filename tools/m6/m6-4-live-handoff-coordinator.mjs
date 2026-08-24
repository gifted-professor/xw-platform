#!/usr/bin/env node

// M6-4 live handoff coordinator. This process never owns a signer, calls a
// device, activates Gate-F, or runs a canary. It serializes the external
// handoff requests produced by the production bridge and prepares exactly one
// successor window after the preceding window is proven CLOSED.

import { createHash } from "node:crypto";
import {
  closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync,
  mkdirSync, openSync, readFileSync, readdirSync, realpathSync,
} from "node:fs";
import { createConnection } from "node:net";
import { execFile } from "node:child_process";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { publishRecoverableCreateOnly } from "./lib/recoverable-create-only-publication.mjs";

export const M64_LIVE_HANDOFF_ORDER = Object.freeze([
  "M6_4_SHADOW", "M6_4_HOT_CLOSE", "M6_4_ACTION_SMOKE", "M6_4_RELIABILITY", "M6_4_SMOOTH",
]);
export const M64_LIVE_HANDOFF_STATE_SCHEMA_ID = "xw.m6-4-live-handoff-coordinator-state.v1";
const HASH = /^[0-9a-f]{64}$/u;
const PURPOSE = new Set(M64_LIVE_HANDOFF_ORDER);
const KINDS = new Set(["OBSERVATION", "NORMAL_CLOSE_SIGNING", "RESOURCE_OBSERVATION"]);
const EVENT_KEYS = Object.freeze(["descriptors", "kind", "purpose", "requestHash"]);
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_MS = 50;
const MAX_BYTES = 2 * 1024 * 1024;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function rawSha(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function domainSha(domain, value) { return createHash("sha256").update(`${domain}:${canonical(value)}`).digest("hex"); }
export function deriveM64LiveHandoffConfigHash(value) {
  const { configHash: _ignored, ...raw } = value || {};
  return domainSha("xw.m6-4-live-handoff-coordinator-config.v1", raw);
}
function stateHash(value) {
  const { stateHash: _ignored, ...raw } = value || {};
  return createHash("sha256").update(`xw.m6-4-live-handoff-coordinator-state.v1:${canonical(raw)}`).digest("hex");
}
function fail(code, message, details = {}) { throw Object.assign(new Error(message), { code, details }); }
function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && canonical(Object.keys(value).sort()) === canonical([...keys].sort()));
}
function normalized(path) { const value = resolve(path); return process.platform === "win32" ? value.toLowerCase() : value; }
function sameIdentity(a, b) { return ["dev", "ino", "mode", "nlink", "size"].every((key) => String(a[key]) === String(b[key])); }

function assertPlainAncestors(path) {
  const target = resolve(path);
  const root = parse(target).root;
  let cursor = dirname(target);
  while (cursor && cursor !== root) {
    const stat = lstatSync(cursor, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || normalized(realpathSync(cursor)) !== normalized(cursor)) {
      fail("M64_COORDINATOR_PATH_INVALID", "coordinator paths must not traverse a symlink, junction, or reparse point");
    }
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
}

export function loadM64CoordinatorArtifact(path, label = "coordinator artifact") {
  if (typeof path !== "string" || !isAbsolute(path)) fail("M64_COORDINATOR_PATH_INVALID", `${label} path must be absolute`);
  const target = resolve(path);
  assertPlainAncestors(target);
  let fd;
  try {
    const before = lstatSync(target, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 2n || before.size > BigInt(MAX_BYTES)
      || normalized(realpathSync(target)) !== normalized(target)) fail("M64_COORDINATOR_PATH_INVALID", `${label} must be one bounded plain file`);
    fd = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd, { bigint: true });
    const bytes = readFileSync(fd);
    const after = lstatSync(target, { bigint: true });
    if (!sameIdentity(before, opened) || !sameIdentity(opened, after) || BigInt(bytes.length) !== opened.size) {
      fail("M64_COORDINATOR_PATH_RACE", `${label} changed while it was read`);
    }
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { fail("M64_COORDINATOR_JSON_INVALID", `${label} is malformed JSON`); }
    return Object.freeze({ bytes, sha256: rawSha(bytes), value });
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function atomicPublishM64Descriptor(path, value) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("M64_COORDINATOR_PATH_INVALID", "descriptor path must be absolute");
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  assertPlainAncestors(target);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    publishRecoverableCreateOnly({ targetPath: target, bytes });
  } catch (error) {
    fail("M64_COORDINATOR_PUBLICATION_FAILED", "descriptor could not be atomically published", { cause: error?.code ?? null });
  }
  return Object.freeze({ path: target, sha256: rawSha(bytes) });
}

export function validateM64CoordinatorEvent(event, { purpose, phase, seenRequestHashes }) {
  const descriptor = (value) => exactObject(value, ["path", "sha256"]) && isAbsolute(value.path || "") && HASH.test(value.sha256 || "");
  const descriptorsOk = event?.kind === "OBSERVATION"
    ? exactObject(event.descriptors, ["ticket"]) && descriptor(event.descriptors.ticket)
    : exactObject(event?.descriptors, ["locator"]) && descriptor(event.descriptors.locator);
  if (!exactObject(event, EVENT_KEYS)
    || !KINDS.has(event?.kind) || event.purpose !== purpose || !HASH.test(event.requestHash || "")
    || !descriptorsOk) {
    fail("M64_COORDINATOR_EVENT_INVALID", "handoff event is malformed or rebound");
  }
  if (seenRequestHashes.has(event.requestHash)) fail("M64_COORDINATOR_REPLAY_FORBIDDEN", "handoff requests cannot be replayed or supplemented");
  if ((phase === "OBSERVING" && event.kind === "RESOURCE_OBSERVATION")
    || (phase === "WAIT_RESOURCE" && event.kind !== "RESOURCE_OBSERVATION")
    || (phase === "WAIT_CLOSED")) {
    fail("M64_COORDINATOR_ORDER_INVALID", "handoff request violates the frozen serial order");
  }
  if (phase === "OBSERVING" && !["OBSERVATION", "NORMAL_CLOSE_SIGNING"].includes(event.kind)) {
    fail("M64_COORDINATOR_ORDER_INVALID", "unexpected observation-phase handoff request");
  }
  return Object.freeze({ ...event });
}

export function createM64LocatorEventSource({ observationTicketRoot, handoffRequestRoot,
  waitMs = DEFAULT_TIMEOUT_MS, pollMs = DEFAULT_POLL_MS, now = Date.now,
  waitForPoll = (delayMs) => new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs)),
} = {}) {
  for (const root of [observationTicketRoot, handoffRequestRoot]) {
    if (typeof root !== "string" || !isAbsolute(root)) fail("M64_COORDINATOR_PATH_INVALID", "locator roots must be absolute");
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || normalized(realpathSync(root)) !== normalized(root)) {
      fail("M64_COORDINATOR_PATH_INVALID", "locator roots must be plain directories");
    }
  }
  if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > DEFAULT_TIMEOUT_MS
    || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 100 || pollMs > waitMs) {
    fail("M64_COORDINATOR_INPUT_INVALID", "locator wait must use a bounded short poll");
  }
  const consumedPaths = new Set();
  const scan = (root, predicate) => readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && predicate(entry.name))
    .map((entry) => join(root, entry.name)).filter((path) => !consumedPaths.has(normalized(path)));
  return async ({ purpose, phase }) => {
    const deadline = now() + waitMs;
    for (;;) {
      const candidates = [];
      if (phase === "OBSERVING") {
        for (const path of scan(observationTicketRoot, (name) => name.endsWith(".work-request.json"))) {
          const record = loadM64CoordinatorArtifact(path, "observation work ticket");
          const ticket = record.value;
          if (ticket?.schemaId !== "xw.m6-4-device-read-work-ticket.v1" || !HASH.test(ticket?.request?.requestHash || "")
            || ticket.request.purpose !== purpose) fail("M64_COORDINATOR_EVENT_INVALID", "observation ticket is stale, malformed, or out of order");
          candidates.push({ kind: "OBSERVATION", purpose, requestHash: ticket.request.requestHash,
            descriptors: { ticket: { path: resolve(path), sha256: record.sha256 } } });
        }
      }
      for (const path of scan(handoffRequestRoot, (name) => name.endsWith(".locator.json"))) {
        const record = loadM64CoordinatorArtifact(path, "external handoff locator");
        const locator = record.value;
        const { locatorHash, ...locatorRaw } = locator || {};
        if (!exactObject(locator, ["artifactFileName", "kind", "locatorHash", "purpose", "requestHash", "requestSha256", "responseDescriptorFileName", "schemaId"])
          || locator?.schemaId !== "xw.m6-4-external-handoff-request-locator.v1" || !HASH.test(locator.requestHash || "")
          || !HASH.test(locator.requestSha256 || "") || !HASH.test(locator.locatorHash || "")
          || locator.locatorHash !== domainSha("xw.m6-4-external-handoff-request-locator.v1", locatorRaw)
          || locator.purpose !== purpose || !["NORMAL_CLOSE_SIGNING", "RESOURCE_OBSERVATION"].includes(locator.kind)) {
          fail("M64_COORDINATOR_EVENT_INVALID", "external handoff locator is stale, malformed, or out of order");
        }
        if ((phase === "OBSERVING" && locator.kind !== "NORMAL_CLOSE_SIGNING")
          || (phase === "WAIT_RESOURCE" && locator.kind !== "RESOURCE_OBSERVATION")) {
          fail("M64_COORDINATOR_ORDER_INVALID", "handoff locator appeared before its frozen serial phase");
        }
        candidates.push({ kind: locator.kind, purpose, requestHash: locator.requestHash,
          descriptors: { locator: { path: resolve(path), sha256: record.sha256 } } });
      }
      if (candidates.length > 1) fail("M64_COORDINATOR_PARALLEL_REQUESTS_FORBIDDEN", "multiple unconsumed handoff requests appeared concurrently");
      if (candidates.length === 1) {
        const event = candidates[0];
        const descriptor = event.descriptors.ticket || event.descriptors.locator;
        consumedPaths.add(normalized(descriptor.path));
        return Object.freeze(event);
      }
      if (now() >= deadline) fail("M64_COORDINATOR_TIMEOUT", "expected handoff locator was not published before the deadline", { purpose, phase });
      await waitForPoll(Math.min(pollMs, Math.max(1, deadline - now())));
    }
  };
}

export async function invokeM64WorkerHandoff({ pipeName, role, requestHash, descriptors, operation = "RUN_ONCE",
  timeoutMs = DEFAULT_TIMEOUT_MS, requestId = `coord-${Date.now().toString(36)}` } = {}) {
  const roleByKind = { OBSERVATION: "observation", NORMAL_CLOSE_SIGNING: "normal-close", RESOURCE_OBSERVATION: "process-inventory" };
  const publicRole = roleByKind[role] || role;
  const response = await invokeM64NamedPipeHost({ pipeName, timeoutMs, request: {
    schemaId: "xw.m6-4-handoff-host-request.v1", requestId, operation, role: publicRole, requestHash, descriptors,
  } });
  const result = response?.result;
  if (response?.requestId !== requestId || !result || result.ok !== true || result.role !== publicRole
    || result.requestHash !== requestHash || result.actionCount !== 0) {
    fail("M64_COORDINATOR_HOST_REJECTED", "handoff host response is missing its exact public request binding");
  }
  return Object.freeze({ ...result });
}

export function invokeM64NamedPipeHost({ pipeName, request, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof pipeName !== "string" || !/^(?:\\\\\.\\pipe\\)?xw-m6-4-handoff-[a-z0-9-]{8,80}$/u.test(pipeName) || pipeName.length > 240
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    fail("M64_COORDINATOR_HOST_INVALID", "named-pipe host settings are invalid");
  }
  const publicRequest = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(publicRequest) > 64 * 1024 || /PRIVATE KEY|api[_-]?key|access[_-]?token|password|secret/iu.test(publicRequest)) {
    fail("M64_COORDINATOR_SECRET_BOUNDARY", "handoff request contains forbidden secret-shaped material");
  }
  const endpoint = pipeName.startsWith("\\\\.\\pipe\\") ? pipeName : `\\\\.\\pipe\\${pipeName}`;
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection(endpoint);
    let response = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectPromise(error); else resolvePromise(value);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error("handoff host timed out"), { code: "M64_COORDINATOR_TIMEOUT" })), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(publicRequest));
    socket.on("data", (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response) > MAX_BYTES) finish(Object.assign(new Error("handoff response exceeded bound"), { code: "M64_COORDINATOR_HOST_INVALID" }));
    });
    socket.on("error", (cause) => finish(Object.assign(new Error("handoff host unavailable"), { code: "M64_COORDINATOR_HOST_UNAVAILABLE", cause })));
    socket.on("end", () => {
      let value;
      try { value = JSON.parse(response); } catch { return finish(Object.assign(new Error("handoff host returned malformed JSON"), { code: "M64_COORDINATOR_HOST_INVALID" })); }
      if (!value || (value.ok === false) || (value.actionCount !== undefined && value.actionCount !== 0)) return finish(Object.assign(new Error("handoff host failed closed"), { code: value?.code || "M64_COORDINATOR_HOST_REJECTED" }));
      finish(null, Object.freeze(value));
    });
  });
}

export function invokeM64JsonCli({ executable, args, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof executable !== "string" || !isAbsolute(executable) || !Array.isArray(args)
    || args.some((arg) => typeof arg !== "string" || /PRIVATE KEY|api[_-]?key|access[_-]?token|password|secret/iu.test(arg))
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    fail("M64_COORDINATOR_CLI_INVALID", "external helper invocation is not one explicit secret-free bounded command");
  }
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(executable, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_BYTES, encoding: "utf8" }, (error, stdout) => {
      if (error) return rejectPromise(Object.assign(new Error("external helper failed closed"), { code: "M64_COORDINATOR_HELPER_FAILED", cause: error?.code ?? null }));
      let value;
      try { value = JSON.parse(String(stdout).trim()); } catch { return rejectPromise(Object.assign(new Error("external helper returned malformed JSON"), { code: "M64_COORDINATOR_HELPER_INVALID" })); }
      if (!value || value.ok !== true) return rejectPromise(Object.assign(new Error("external helper rejected request"), { code: value?.code || "M64_COORDINATOR_HELPER_REJECTED" }));
      resolvePromise(Object.freeze(value));
    });
  });
}

export function createM64ProductionCliHandoffs({
  powershellPath, signerInvokePath, signerPipeName, nodePath, inventoryBuilderPath, stageToolPath,
  buildResponseRoot, stagePaths, timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const absoluteFiles = [powershellPath, signerInvokePath, nodePath, inventoryBuilderPath, stageToolPath, buildResponseRoot];
  const stageKeys = ["finalBindingPath", "gateIssuerAllowlistPath", "liveIssuerAllowlistPath", "runtimeSnapshotPath"];
  if (absoluteFiles.some((path) => typeof path !== "string" || !isAbsolute(path))
    || typeof signerPipeName !== "string" || !/^xw-m6-gate-f-signer-[A-Za-z0-9-]{8,100}$/u.test(signerPipeName)
    || !exactObject(stagePaths, stageKeys) || stageKeys.some((key) => !isAbsolute(stagePaths[key] || ""))) {
    fail("M64_COORDINATOR_HELPER_CONFIG_INVALID", "production helpers must be injected as exact absolute paths and one signer pipe");
  }
  const buildWindow = async ({ purpose, parentEpochHash, generation, dryRun }) => {
    if (dryRun) fail("M64_COORDINATOR_DRY_BUILD_FORBIDDEN", "dry-run stops before requesting a new signature");
    const response = await invokeM64JsonCli({ executable: powershellPath, timeoutMs, args: ["-NoProfile", "-NonInteractive", "-File",
      signerInvokePath, "-PipeName", signerPipeName, "-Command", "BUILD", "-Purpose", purpose] });
    if (response.purpose !== purpose || response.parentEpochHash !== parentEpochHash || response.generation !== generation
      || !HASH.test(response.epochHash || "") || !isAbsolute(response.paths?.authorization || "")
      || !isAbsolute(response.paths?.candidate || "")) {
      fail("M64_COORDINATOR_BUILD_INVALID", "elevated signer returned a stale or rebound successor");
    }
    const responsePath = join(resolve(buildResponseRoot), `${generation}-${purpose.toLowerCase()}.gate-signer-response.json`);
    atomicPublishM64Descriptor(responsePath, response);
    return Object.freeze({ ...response, actionCount: 0, authorizationPath: response.paths.authorization,
      candidateActivationPackagePath: response.paths.candidate, responsePath });
  };
  const buildInventory = async ({ purpose, built, parentEpochHash, generation, dryRun }) => {
    if (dryRun) fail("M64_COORDINATOR_DRY_BUILD_FORBIDDEN", "dry-run stops before building a successor inventory");
    if (built.purpose !== purpose || built.parentEpochHash !== parentEpochHash || built.generation !== generation) {
      fail("M64_COORDINATOR_INVENTORY_INVALID", "inventory request is rebound from the exact signer response");
    }
    const result = await invokeM64JsonCli({ executable: nodePath, timeoutMs, args: [inventoryBuilderPath, built.responsePath] });
    if (result.purpose !== purpose || !exactObject(result.inventoryDescriptor, ["path", "sha256"])
      || !isAbsolute(result.inventoryDescriptor.path || "") || !HASH.test(result.inventoryDescriptor.sha256 || "")) {
      fail("M64_COORDINATOR_INVENTORY_INVALID", "inventory helper returned an invalid descriptor");
    }
    return Object.freeze({ ok: true, actionCount: 0, descriptorPath: result.inventoryDescriptor.path,
      sha256: result.inventoryDescriptor.sha256, inventoryHash: result.inventoryHash });
  };
  const stageWindow = async ({ purpose, built, inventory, execute }) => {
    const args = [stageToolPath,
      "--final-binding", stagePaths.finalBindingPath,
      "--authorization", built.authorizationPath,
      "--candidate-activation-package", built.candidateActivationPackagePath,
      "--gate-issuer-allowlist", stagePaths.gateIssuerAllowlistPath,
      "--live-issuer-allowlist", stagePaths.liveIssuerAllowlistPath,
      "--runtime-snapshot", stagePaths.runtimeSnapshotPath,
    ];
    if (execute) args.push("--execute");
    const result = await invokeM64JsonCli({ executable: nodePath, timeoutMs, args });
    if ((result.purpose !== undefined && result.purpose !== purpose)
      || result.gateMutationPerformed !== false || result.deviceAccessed !== false) {
      fail("M64_COORDINATOR_STAGE_INVALID", "stage helper crossed its no-touch boundary");
    }
    return Object.freeze({ ok: true, actionCount: 0, purpose, parentEpochHash: built.parentEpochHash,
      generation: built.generation, gateMutationPerformed: false, deviceAccessed: false, stage: result, inventorySha256: inventory.sha256 });
  };
  return Object.freeze({ buildWindow, buildInventory, stageWindow });
}

function assertClosedStatus(status, { purpose, activeEpochHash, generation }) {
  if (!status || status.mode !== "CLOSED" || status.purpose !== purpose || status.tripleConsistent !== true
    || !HASH.test(status.epochHash || "") || status.epochHash === activeEpochHash
    || status.generation !== generation + 1
    || Object.values(status.resourceCounts || {}).some((value) => value !== 0)) {
    fail("M64_COORDINATOR_CLOSED_PROOF_INVALID", "window did not reach the exact zero-resource CLOSED successor");
  }
  return Object.freeze({ ...status });
}

function validateBuiltWindow(result, { purpose, parentEpochHash, generation }) {
  if (!result || result.ok !== true || result.actionCount !== 0 || result.purpose !== purpose
    || result.parentEpochHash !== parentEpochHash || result.generation !== generation
    || !isAbsolute(result.authorizationPath || "") || !isAbsolute(result.candidateActivationPackagePath || "")) {
    fail("M64_COORDINATOR_BUILD_INVALID", "signer BUILD result is missing or cross-bound");
  }
  return Object.freeze({ ...result });
}

export async function runM64LiveHandoffCoordinator({
  initialWindow, statePath, windowInboxRoot, timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = DEFAULT_POLL_MS,
  dryRun = false,
} = {}, {
  nextEvent, invokeHost, buildWindow, readGateStatus, buildInventory, stageWindow,
  publishDescriptor = atomicPublishM64Descriptor, now = Date.now,
} = {}) {
  if (!initialWindow || initialWindow.purpose !== M64_LIVE_HANDOFF_ORDER[0] || !HASH.test(initialWindow.epochHash || "")
    || !Number.isSafeInteger(initialWindow.generation) || initialWindow.generation < 0
    || !isAbsolute(initialWindow.inventoryPath || "") || !HASH.test(initialWindow.inventorySha256 || "")
    || !isAbsolute(statePath || "") || !isAbsolute(windowInboxRoot || "")
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS
    || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 100
    || [nextEvent, invokeHost, buildWindow, readGateStatus, buildInventory, stageWindow, publishDescriptor].some((fn) => typeof fn !== "function")) {
    fail("M64_COORDINATOR_INPUT_INVALID", "coordinator requires one exact staged SHADOW window and bounded dependencies");
  }
  if (existsSync(statePath) || (existsSync(`${statePath}.journal`) && readdirSync(`${statePath}.journal`).length > 0)) {
    fail("M64_COORDINATOR_RESUME_FORBIDDEN", "existing coordinator state requires explicit adjudication; automatic catch-up is forbidden");
  }
  let active = Object.freeze({ ...initialWindow });
  const seenRequestHashes = new Set();
  const windows = [];
  const publishState = (phase) => {
    const raw = { schemaId: M64_LIVE_HANDOFF_STATE_SCHEMA_ID, actionCount: 0, dryRun, phase,
      currentPurpose: active.purpose, currentEpochHash: active.epochHash, currentGeneration: active.generation,
      completedPurposes: windows.map((entry) => entry.purpose), updatedAt: new Date(now()).toISOString() };
    const value = { ...raw, stateHash: stateHash(raw) };
    return publishDescriptor(join(`${statePath}.journal`, `${value.stateHash}.json`), value);
  };
  publishState("OBSERVING");
  for (let index = 0; index < M64_LIVE_HANDOFF_ORDER.length; index += 1) {
    const windowDeadline = now() + timeoutMs;
    const purpose = M64_LIVE_HANDOFF_ORDER[index];
    if (active.purpose !== purpose) fail("M64_COORDINATOR_ORDER_INVALID", "active window skipped or reordered the frozen purpose list");
    let phase = "OBSERVING";
    let normalCloseRequestHash = null;
    for (;;) {
      if (now() > windowDeadline) fail("M64_COORDINATOR_TIMEOUT", "window exceeded its fixed fail-closed deadline", { purpose, phase });
      const event = validateM64CoordinatorEvent(await nextEvent({ purpose, phase, pollMs }), { purpose, phase, seenRequestHashes });
      seenRequestHashes.add(event.requestHash);
      const runDescriptors = event.kind === "NORMAL_CLOSE_SIGNING"
        ? { ...event.descriptors, window: { path: active.inventoryPath, sha256: active.inventorySha256 } }
        : event.descriptors;
      const descriptors = dryRun ? {} : runDescriptors;
      const response = await invokeHost({ operation: dryRun ? "DRY" : "RUN_ONCE", purpose, kind: event.kind,
        requestHash: event.requestHash, descriptors, actionCount: 0, dryRun });
      if (!response || response.ok !== true || response.actionCount !== 0 || response.requestHash !== event.requestHash) {
        fail("M64_COORDINATOR_HOST_REJECTED", "handoff host response did not bind the exact request");
      }
      if (event.kind === "NORMAL_CLOSE_SIGNING") { normalCloseRequestHash = event.requestHash; phase = "WAIT_RESOURCE"; publishState("WAIT_CLOSED"); }
      if (event.kind === "RESOURCE_OBSERVATION") break;
    }
    const closed = assertClosedStatus(await readGateStatus({ purpose, expectedParentEpochHash: active.epochHash, normalCloseRequestHash }), {
      purpose, activeEpochHash: active.epochHash, generation: active.generation,
    });
    windows.push(Object.freeze({ purpose, activeEpochHash: active.epochHash, closedEpochHash: closed.epochHash,
      closedGeneration: closed.generation, normalCloseRequestHash }));
    publishState("CLOSED");
    if (index === M64_LIVE_HANDOFF_ORDER.length - 1) break;
    const nextPurpose = M64_LIVE_HANDOFF_ORDER[index + 1];
    const built = validateBuiltWindow(await buildWindow({ operation: "BUILD", purpose: nextPurpose,
      parentEpochHash: closed.epochHash, generation: closed.generation + 1, actionCount: 0, dryRun }), {
      purpose: nextPurpose, parentEpochHash: closed.epochHash, generation: closed.generation + 1,
    });
    const inventory = await buildInventory({ purpose: nextPurpose, built, parentEpochHash: closed.epochHash,
      generation: closed.generation + 1, dryRun });
    if (!inventory || inventory.ok !== true || inventory.actionCount !== 0 || !isAbsolute(inventory.descriptorPath || "")) {
      fail("M64_COORDINATOR_INVENTORY_INVALID", "canary inventory builder did not return one exact descriptor");
    }
    const staged = await stageWindow({ purpose: nextPurpose, built, inventory, execute: !dryRun });
    if (!staged || staged.ok !== true || staged.actionCount !== 0 || staged.purpose !== nextPurpose
      || staged.parentEpochHash !== closed.epochHash || staged.generation !== closed.generation + 1
      || staged.gateMutationPerformed !== false || staged.deviceAccessed !== false) {
      fail("M64_COORDINATOR_STAGE_INVALID", "stage tool did not preserve the exact closed parent and no-touch boundary");
    }
    const descriptorPath = join(resolve(windowInboxRoot), `${nextPurpose}.window.descriptor.json`);
    publishDescriptor(descriptorPath, { path: resolve(inventory.descriptorPath), sha256: inventory.sha256 });
    active = Object.freeze({ purpose: nextPurpose, epochHash: built.epochHash, generation: built.generation,
      inventoryPath: resolve(inventory.descriptorPath), inventorySha256: inventory.sha256 });
    publishState("STAGED");
  }
  publishState("COMPLETE");
  const finalState = { schemaId: M64_LIVE_HANDOFF_STATE_SCHEMA_ID, actionCount: 0, dryRun, phase: "COMPLETE",
    currentPurpose: active.purpose, currentEpochHash: active.epochHash, currentGeneration: active.generation,
    completedPurposes: windows.map((entry) => entry.purpose), updatedAt: new Date(now()).toISOString() };
  publishDescriptor(statePath, { ...finalState, stateHash: stateHash(finalState) });
  return Object.freeze({ ok: true, schemaId: "xw.m6-4-live-handoff-coordinator-result.v1", actionCount: 0,
    dryRun, completedPurposes: windows.map((entry) => entry.purpose), windows: Object.freeze(windows), gateMutationPerformed: false,
    deviceAccessed: false, supplementalRunCount: 0 });
}

export function parseM64LiveHandoffCoordinatorArgs(argv) {
  const out = { dryRun: false, execute: false };
  const names = new Map([["--config", "configPath"]]);
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--dry-run") { if (out.dryRun) fail("M64_COORDINATOR_CLI_INVALID", "duplicate --dry-run"); out.dryRun = true; continue; }
    if (argv[index] === "--execute") { if (out.execute) fail("M64_COORDINATOR_CLI_INVALID", "duplicate --execute"); out.execute = true; continue; }
    const key = names.get(argv[index]);
    if (!key || out[key] !== undefined || index + 1 >= argv.length) fail("M64_COORDINATOR_CLI_INVALID", `unknown, duplicate, or incomplete argument: ${argv[index]}`);
    out[key] = argv[++index];
  }
  if (!out.configPath) fail("M64_COORDINATOR_CLI_INVALID", "--config is required");
  if (out.dryRun && out.execute) fail("M64_COORDINATOR_CLI_INVALID", "--dry-run and --execute are mutually exclusive");
  return Object.freeze(out);
}

export function validateM64LiveHandoffCoordinatorConfig(config) {
  const keys = ["configHash", "handoffPipeName", "handoffRequestRoot", "initialWindow", "observationTicketRoot",
    "pipeline", "pollMs", "schemaId", "signer", "statePath", "statusHelper", "timeoutMs", "windowInboxRoot"];
  const configHash = config?.configHash;
  const abs = (value) => typeof value === "string" && isAbsolute(value);
  if (!exactObject(config, keys) || config.schemaId !== "xw.m6-4-live-handoff-coordinator-config.v1"
    || !HASH.test(configHash || "") || configHash !== deriveM64LiveHandoffConfigHash(config)
    || !exactObject(config.initialWindow, ["epochHash", "generation", "inventoryPath", "inventorySha256", "purpose"])
    || !exactObject(config.signer, ["invokePath", "pipeName", "powershellPath"])
    || !exactObject(config.pipeline, ["buildResponseRoot", "inventoryBuilderPath", "nodePath", "stagePaths", "stageToolPath"])
    || !exactObject(config.statusHelper, ["args", "executable"])
    || !Array.isArray(config.statusHelper.args) || config.statusHelper.args.some((arg) => typeof arg !== "string")
    || ![config.statePath, config.windowInboxRoot, config.observationTicketRoot, config.handoffRequestRoot,
      config.initialWindow.inventoryPath, config.signer.invokePath, config.signer.powershellPath,
      config.pipeline.buildResponseRoot, config.pipeline.inventoryBuilderPath, config.pipeline.nodePath,
      config.pipeline.stageToolPath, config.statusHelper.executable].every(abs)) {
    fail("M64_COORDINATOR_CONFIG_INVALID", "coordinator config is not one exact content-bound production wiring contract");
  }
  return Object.freeze(config);
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const args = parseM64LiveHandoffCoordinatorArgs(argv);
    const config = validateM64LiveHandoffCoordinatorConfig(loadM64CoordinatorArtifact(resolve(args.configPath), "coordinator config").value);
    const nextEvent = createM64LocatorEventSource({ observationTicketRoot: config.observationTicketRoot,
      handoffRequestRoot: config.handoffRequestRoot, waitMs: config.timeoutMs, pollMs: config.pollMs });
    const cli = createM64ProductionCliHandoffs({ powershellPath: config.signer.powershellPath,
      signerInvokePath: config.signer.invokePath, signerPipeName: config.signer.pipeName,
      nodePath: config.pipeline.nodePath, inventoryBuilderPath: config.pipeline.inventoryBuilderPath,
      stageToolPath: config.pipeline.stageToolPath, buildResponseRoot: config.pipeline.buildResponseRoot,
      stagePaths: config.pipeline.stagePaths, timeoutMs: config.timeoutMs });
    if (!args.execute) {
      stdout.write(`${JSON.stringify({ ok: true, schemaId: "xw.m6-4-live-handoff-coordinator-preflight.v1",
        status: args.dryRun ? "DRY_RUN_READY" : "EXECUTE_NOT_REQUESTED", actionCount: 0, writesPerformed: 0,
        gateMutationPerformed: false, deviceAccessed: false, configHash: config.configHash })}\n`);
      return 0;
    }
    const invokeHost = ({ operation, kind, requestHash, descriptors }) => invokeM64WorkerHandoff({
      pipeName: config.handoffPipeName, role: kind, requestHash, descriptors, operation, timeoutMs: config.timeoutMs,
    });
    const readGateStatus = async ({ purpose, expectedParentEpochHash, normalCloseRequestHash }) => {
      const value = await invokeM64JsonCli({ executable: config.statusHelper.executable, timeoutMs: config.timeoutMs,
        args: [...config.statusHelper.args, "--purpose", purpose, "--parent-epoch-hash", expectedParentEpochHash,
          "--normal-close-request-hash", normalCloseRequestHash] });
      return value.gate || value;
    };
    const result = await runM64LiveHandoffCoordinator({ initialWindow: config.initialWindow,
      statePath: config.statePath, windowInboxRoot: config.windowInboxRoot, timeoutMs: config.timeoutMs,
      pollMs: config.pollMs, dryRun: false }, { nextEvent, invokeHost, readGateStatus, ...cli });
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify({ ok: false, code: error?.code || "M64_COORDINATOR_FAILED", actionCount: 0 })}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
