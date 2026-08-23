import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";

import { SDK_METHODS, SUPERVISOR_LIMITS, SUPERVISOR_TIMEOUTS } from "./constants.mjs";
import { SupervisorError, invariant } from "./errors.mjs";

const JSONRPC = "2.0";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function writeLine(stream, value, sourceToPause) {
  const accepted = stream.write(`${JSON.stringify(value)}\n`);
  if (accepted || !sourceToPause?.pause) return;
  sourceToPause.pause();
  stream.once("drain", () => sourceToPause.resume());
}

function timeoutFor(method, timeouts) {
  if (method === "initialize") return timeouts.initializeMs;
  if (method === "session/prompt") return timeouts.promptAckMs;
  return timeouts.shutdownResponseMs;
}

export function createBoundedLineReader(stream, options) {
  const { source, maxLineBytes, maxIncompleteBytes, onLine, onFailure } = options;
  let buffered = Buffer.alloc(0);
  let chain = Promise.resolve();
  let failed = false;

  const fail = (error) => {
    if (failed) return;
    failed = true;
    onFailure(error);
  };

  stream.on("data", (chunk) => {
    if (failed) return;
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffered = Buffer.concat([buffered, next]);
    while (true) {
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) break;
      const raw = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      if (raw.byteLength > maxLineBytes) {
        fail(new SupervisorError("M6_DSH_STDIO_LINE_LIMIT", `${source} frame exceeds ${maxLineBytes} bytes`));
        return;
      }
      const clean = raw.at(-1) === 0x0d ? raw.subarray(0, -1) : raw;
      chain = chain.then(() => onLine(clean.toString("utf8"))).catch(fail);
    }
    if (buffered.byteLength > maxIncompleteBytes) {
      fail(new SupervisorError("M6_DSH_STDIO_LINE_LIMIT", `${source} incomplete frame exceeds ${maxIncompleteBytes} bytes`));
    }
  });
  stream.on("error", fail);
  return { close: () => { failed = true; buffered = Buffer.alloc(0); } };
}

export function spawnOwnedProcess(command, args = [], options = {}) {
  if (options.extraPipeFd !== undefined) {
    invariant(options.extraPipeFd === 3, "M6_DSH_EXTRA_PIPE_FD_INVALID", "the only supported child broker pipe is FD3");
  }
  const stdio = options.extraPipeFd === 3
    ? ["pipe", "pipe", "pipe", "pipe"]
    : ["pipe", "pipe", "pipe"];
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio,
  });
  return Object.freeze({
    schemaId: "xw.dsh.process-ref.v1",
    pid: child.pid,
    spawnedAt: new Date().toISOString(),
    spawnNonce: randomUUID(),
    child,
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

export async function terminateOwnedProcessTree(processRef, options = {}) {
  const timeouts = { ...SUPERVISOR_TIMEOUTS, ...options.timeouts };
  invariant(processRef?.schemaId === "xw.dsh.process-ref.v1", "UNOWNED_PROCESS", "process reference is not owned");
  invariant(processRef.child?.pid === processRef.pid && Number.isSafeInteger(processRef.pid), "PROCESS_IDENTITY_DRIFT", "owned process identity changed");
  const child = processRef.child;
  const startedAt = new Date().toISOString();
  let escalation = "none";

  if (!(await waitForExit(child, timeouts.gracefulExitMs))) {
    if (process.platform === "win32") {
      escalation = "tree-kill";
      const systemRoot = process.env.SystemRoot;
      invariant(typeof systemRoot === "string" && systemRoot.length > 0, "SYSTEM_ROOT_MISSING", "SystemRoot is required for owned taskkill fallback");
      const taskkill = spawn(join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(processRef.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      await once(taskkill, "exit");
    } else {
      escalation = "term";
      try { process.kill(-processRef.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
  if (!(await waitForExit(child, timeouts.termExitMs))) {
    escalation = "tree-kill";
    if (process.platform === "win32") {
      invariant(false, "PROCESS_TREE_LIVE", `taskkill did not close owned process tree ${processRef.pid}`);
    } else {
      try { process.kill(-processRef.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
  const closed = await waitForExit(child, timeouts.treeKillMs);
  invariant(closed, "PROCESS_TREE_LIVE", `owned process tree ${processRef.pid} did not close`);
  return Object.freeze({
    schemaId: "xw.dsh.process-close-receipt.v1",
    pid: processRef.pid,
    spawnNonce: processRef.spawnNonce,
    spawnedAt: processRef.spawnedAt,
    startedAt,
    closedAt: new Date().toISOString(),
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    escalation,
    verifiedClosed: true,
  });
}

export class StdioSupervisor {
  constructor({ upstreamInput, upstreamOutput, childRef, limits = {}, timeouts = {}, onFatal = () => {} }) {
    this.upstreamInput = upstreamInput;
    this.upstreamOutput = upstreamOutput;
    this.childRef = childRef;
    this.child = childRef.child;
    this.limits = { ...SUPERVISOR_LIMITS, ...limits };
    this.timeouts = { ...SUPERVISOR_TIMEOUTS, ...timeouts };
    this.onFatal = onFatal;
    this.pending = new Map();
    this.nextId = 1;
    this.stdoutBytes = 0;
    this.notificationCount = 0;
    this.stderrBytes = 0;
    this.stderrLines = [];
    this.idleTimers = new Map();
    this.failure = undefined;
    this.settledResponseIds = new Set();
    this.lastNotification = undefined;
  }

  start() {
    createBoundedLineReader(this.upstreamInput, {
      source: "upstream",
      maxLineBytes: this.limits.maxLineBytes,
      maxIncompleteBytes: this.limits.maxIncompleteBytes,
      onLine: (line) => this.handleUpstreamLine(line),
      onFailure: (error) => this.fatal(error),
    });
    createBoundedLineReader(this.child.stdout, {
      source: "child",
      maxLineBytes: this.limits.maxLineBytes,
      maxIncompleteBytes: this.limits.maxIncompleteBytes,
      onLine: (line) => this.handleChildLine(line),
      onFailure: (error) => this.fatal(error),
    });
    this.child.stderr.on("data", (chunk) => this.captureStderr(chunk));
    this.child.once("error", (error) => this.fatal(new SupervisorError("CHILD_SPAWN", error.message)));
    this.child.once("exit", () => {
      if ((this.pending.size > 0 || this.idleTimers.size > 0) && !this.failure) this.fatal(new SupervisorError("M6_DSH_PROTOCOL_INVALID", "child exited with pending protocol work"));
    });
    return this;
  }

  parse(line, source) {
    let value;
    try { value = JSON.parse(line); } catch { throw new SupervisorError("M6_DSH_PROTOCOL_INVALID", `${source} emitted malformed JSON`); }
    invariant(isRecord(value) && value.jsonrpc === JSONRPC, "M6_DSH_PROTOCOL_INVALID", `${source} emitted an invalid JSON-RPC envelope`);
    return value;
  }

  handleUpstreamLine(line) {
    const message = this.parse(line, "upstream");
    invariant(Object.hasOwn(message, "id") && (typeof message.id === "string" || Number.isSafeInteger(message.id)), "M6_DSH_PROTOCOL_INVALID", "upstream request id must be a string or safe integer");
    invariant(typeof message.method === "string" && SDK_METHODS.has(message.method), "M6_DSH_PROTOCOL_INVALID", `unsupported request method: ${String(message.method)}`);
    invariant(message.params === undefined || isRecord(message.params), "M6_DSH_PROTOCOL_INVALID", "request params must be an object");
    invariant(this.pending.size < this.limits.maxPendingRequests, "M6_DSH_PROTOCOL_INVALID", "too many pending requests");
    const childId = this.nextId++;
    invariant(Number.isSafeInteger(childId), "REQUEST_ID_EXHAUSTED", "request id space exhausted");
    const timeoutCode = message.method === "session/prompt" ? "M6_DSH_PROMPT_ACK_TIMEOUT" : "M6_DSH_PROTOCOL_INVALID";
    const timer = setTimeout(() => this.fatal(new SupervisorError(timeoutCode, `${message.method} response timed out`)), timeoutFor(message.method, this.timeouts));
    this.pending.set(childId, { upstreamId: message.id, method: message.method, params: message.params ?? {}, timer });
    writeLine(this.child.stdin, { jsonrpc: JSONRPC, id: childId, method: message.method, params: message.params ?? {} }, this.upstreamInput);
  }

  handleChildLine(line) {
    this.stdoutBytes += Buffer.byteLength(line) + 1;
    invariant(this.stdoutBytes <= this.limits.maxStdoutBytes, "M6_DSH_STDOUT_BUDGET", "child stdout budget exceeded");
    const message = this.parse(line, "child");
    if (typeof message.method === "string") {
      invariant(!Object.hasOwn(message, "id"), "M6_DSH_CHILD_REQUEST_FORBIDDEN", "child-to-host requests are forbidden");
      this.notificationCount += 1;
      invariant(this.notificationCount <= this.limits.maxNotifications, "M6_DSH_PROTOCOL_INVALID", "child notification budget exceeded");
      const notificationKey = JSON.stringify(message);
      invariant(notificationKey !== this.lastNotification, "M6_DSH_PROTOCOL_INVALID", "duplicate ordered notification");
      this.lastNotification = notificationKey;
      this.observeNotification(message);
      writeLine(this.upstreamOutput, message, this.child.stdout);
      return;
    }
    invariant(Number.isSafeInteger(message.id), "M6_DSH_PROTOCOL_INVALID", "child response id must be a safe integer");
    invariant(!this.settledResponseIds.has(message.id), "M6_DSH_DUPLICATE_RESPONSE_ID", `child duplicated response id ${message.id}`);
    const pending = this.pending.get(message.id);
    invariant(pending, "M6_DSH_UNKNOWN_RESPONSE_ID", `child response has unknown id ${message.id}`);
    invariant(Object.hasOwn(message, "result") !== Object.hasOwn(message, "error"), "M6_DSH_PROTOCOL_INVALID", "response must contain exactly one of result or error");
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    this.settledResponseIds.add(message.id);
    if (pending.method === "session/prompt" && !message.error) this.armIdle(pending.params.sessionId);
    writeLine(this.upstreamOutput, { ...message, id: pending.upstreamId }, this.child.stdout);
  }

  armIdle(sessionId) {
    if (typeof sessionId !== "string") return;
    clearTimeout(this.idleTimers.get(sessionId));
    this.idleTimers.set(sessionId, setTimeout(() => this.fatal(new SupervisorError("M6_DSH_IDLE_TIMEOUT", `session ${sessionId} did not become idle`)), this.timeouts.idleMs));
  }

  observeNotification(message) {
    if (message.method !== "session.status" || message.params?.status !== "idle") return;
    const sessionId = message.params?.sessionId;
    clearTimeout(this.idleTimers.get(sessionId));
    this.idleTimers.delete(sessionId);
  }

  captureStderr(chunk) {
    const bytes = Buffer.byteLength(chunk);
    this.stderrBytes += bytes;
    if (this.stderrBytes > this.limits.maxStderrBytes) return this.fatal(new SupervisorError("M6_DSH_STDERR_BUDGET", "child stderr budget exceeded"));
    this.stderrLines.push(...String(chunk).split(/\r?\n/u).filter(Boolean));
    if (this.stderrLines.length > this.limits.maxStderrLines) return this.fatal(new SupervisorError("M6_DSH_STDERR_BUDGET", "child stderr line budget exceeded"));
  }

  fatal(error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.pending.clear();
    this.idleTimers.clear();
    this.onFatal(error);
    this.child.stdin.destroy();
  }

  stderrDigest() {
    return createHash("sha256").update(this.stderrLines.join("\n")).digest("hex");
  }
}
