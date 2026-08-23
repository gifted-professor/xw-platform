import { createHash } from "node:crypto";
import { once } from "node:events";

import { M6_LIVE_TOOL_NAMES, validateLiveToolCall, validateLiveToolResult } from "../../../services/orchestrator/scripts/lib/m6/m6-live-tool-surface.mjs";
import { validateM6LivePipeBinding } from "./live-pipe-client.mjs";

const DEFAULT_MAX_LINE_BYTES = 64 * 1024;
const DEFAULT_MAX_CALLS = 4_096;
const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HELLO_KEYS = Object.freeze([
  "type", "processRef", "bindingHash", "toolNames", "brokerFd",
  "transportAuthorityPresent", "rawDeviceIdentityPresent",
]);
const CALL_KEYS = Object.freeze(["type", "correlation", "method", "nonce", "params"]);

function brokerError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function sameBinding(left, right) {
  const keys = Object.keys(right);
  return keys.length === Object.keys(left).length && keys.every((key) => left[key] === right[key]);
}

function nonceHash(nonce) {
  return createHash("sha256").update(nonce).digest("hex");
}

async function withTimeout(work, timeoutMs, code, message) {
  let timer;
  const controller = new AbortController();
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = brokerError(code, message);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class M6LiveParentBroker {
  constructor({
    stream,
    binding,
    handleToolCall,
    brokerFd = 3,
    maxLineBytes = DEFAULT_MAX_LINE_BYTES,
    maxCalls = DEFAULT_MAX_CALLS,
    helloTimeoutMs = 1_000,
    incompleteLineTimeoutMs = 1_000,
    toolTimeoutMs = 5_000,
    onFatal = () => {},
  } = {}) {
    if (!stream?.readable || !stream?.writable) throw brokerError("M6_LIVE_BROKER_PIPE_REQUIRED", "a readable and writable inherited child pipe is required");
    if (brokerFd !== 3) throw brokerError("M6_LIVE_BROKER_FD_INVALID", "the production inherited broker pipe must be FD3");
    if (typeof handleToolCall !== "function") throw brokerError("M6_LIVE_BROKER_HANDLER_REQUIRED", "a live tool handler is required");
    for (const [name, value] of Object.entries({ maxLineBytes, maxCalls, helloTimeoutMs, incompleteLineTimeoutMs, toolTimeoutMs })) {
      if (!Number.isSafeInteger(value) || value < 1) throw brokerError("M6_LIVE_BROKER_LIMIT_INVALID", `${name} must be a positive safe integer`);
    }
    this.stream = stream;
    this.binding = validateM6LivePipeBinding(binding);
    this.handleToolCall = handleToolCall;
    this.brokerFd = brokerFd;
    this.maxLineBytes = maxLineBytes;
    this.maxCalls = maxCalls;
    this.helloTimeoutMs = helloTimeoutMs;
    this.incompleteLineTimeoutMs = incompleteLineTimeoutMs;
    this.toolTimeoutMs = toolTimeoutMs;
    this.onFatal = onFatal;
    this.buffer = Buffer.alloc(0);
    this.seenNonces = new Set();
    this.chain = Promise.resolve();
    this.helloAccepted = false;
    this.started = false;
    this.isClosed = false;
    this.closeRequested = false;
    this.failure = undefined;
    this.helloTimer = undefined;
    this.incompleteTimer = undefined;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
    this.onData = (chunk) => this.#onData(chunk);
    this.onError = (error) => this.#fail(brokerError("M6_LIVE_BROKER_PIPE_ERROR", error.message, error));
    this.onEnd = () => this.#handlePipeEnd();
    this.onClose = () => this.#handlePipeEnd();
  }

  start() {
    if (this.started) throw brokerError("M6_LIVE_BROKER_ALREADY_STARTED", "live parent broker was already started");
    this.started = true;
    this.stream.on("data", this.onData);
    this.stream.once("error", this.onError);
    this.stream.once("end", this.onEnd);
    this.stream.once("close", this.onClose);
    this.helloTimer = setTimeout(() => this.#fail(brokerError("M6_LIVE_BROKER_HELLO_TIMEOUT", "child did not present a broker hello in time")), this.helloTimeoutMs);
    this.helloTimer.unref();
    return this;
  }

  close() {
    this.closeRequested = true;
    this.#finish();
    return this.closed;
  }

  abort(error) {
    this.#fail(error instanceof Error ? error : brokerError("M6_LIVE_BROKER_ABORTED", String(error)));
    return this.closed;
  }

  #onData(chunk) {
    if (this.isClosed || this.failure) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    if (this.buffer.length > this.maxLineBytes && !this.buffer.includes(0x0a)) {
      this.#fail(brokerError("M6_LIVE_BROKER_LINE_LIMIT", "incomplete child broker frame exceeded the line limit"));
      return;
    }
    while (!this.failure) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      const raw = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (raw.length > this.maxLineBytes) {
        this.#fail(brokerError("M6_LIVE_BROKER_LINE_LIMIT", "child broker frame exceeded the line limit"));
        return;
      }
      const clean = raw.at(-1) === 0x0d ? raw.subarray(0, -1) : raw;
      this.chain = this.chain.then(() => this.#handleLine(clean)).catch((error) => this.#fail(error));
    }
    this.#armIncompleteTimer();
  }

  #handlePipeEnd() {
    if (this.closeRequested || this.failure) this.#finish();
    else this.#fail(brokerError("M6_LIVE_BROKER_PIPE_EARLY_END", "child closed the broker pipe before parent close"));
  }

  #armIncompleteTimer() {
    clearTimeout(this.incompleteTimer);
    if (this.buffer.length === 0 || this.failure || this.isClosed) return;
    this.incompleteTimer = setTimeout(() => this.#fail(brokerError("M6_LIVE_BROKER_INCOMPLETE_TIMEOUT", "child left an incomplete broker frame")), this.incompleteLineTimeoutMs);
    this.incompleteTimer.unref();
  }

  async #handleLine(raw) {
    if (this.failure || this.isClosed) return;
    let message;
    try {
      message = JSON.parse(raw.toString("utf8"));
    } catch (cause) {
      throw brokerError("M6_LIVE_BROKER_PROTOCOL_INVALID", "child emitted malformed broker JSON", cause);
    }
    if (!this.helloAccepted) {
      this.#acceptHello(message);
      return;
    }
    if (!hasExactKeys(message, CALL_KEYS) || message.type !== "tool_call") {
      throw brokerError("M6_LIVE_BROKER_FRAME_INVALID", "child emitted a non-exact tool-call frame");
    }
    let correlation;
    try {
      correlation = validateM6LivePipeBinding(message.correlation);
    } catch (cause) {
      throw brokerError("M6_LIVE_BROKER_BINDING_MISMATCH", "child tool-call correlation is invalid", cause);
    }
    if (!sameBinding(correlation, this.binding)) {
      throw brokerError("M6_LIVE_BROKER_BINDING_MISMATCH", "child tool-call correlation does not match its launch binding");
    }
    if (typeof message.nonce !== "string" || !NONCE.test(message.nonce)) {
      throw brokerError("M6_LIVE_BROKER_NONCE_INVALID", "child tool-call nonce is not a UUIDv4");
    }
    if (this.seenNonces.has(message.nonce)) {
      throw brokerError("M6_LIVE_BROKER_NONCE_REPLAY", "child replayed a broker nonce");
    }
    if (this.seenNonces.size >= this.maxCalls) {
      throw brokerError("M6_LIVE_BROKER_CALL_LIMIT", "child exceeded the broker call budget");
    }
    this.seenNonces.add(message.nonce);
    const callValidation = validateLiveToolCall({ tool: message.method, args: message.params });
    if (!callValidation.ok) {
      throw brokerError(callValidation.errors[0], `live tool call was rejected: ${callValidation.errors.join(",")}`);
    }
    let result;
    try {
      result = await withTimeout(
        (signal) => this.handleToolCall(Object.freeze({
          method: message.method,
          params: message.params,
          binding: this.binding,
          signal,
        })),
        this.toolTimeoutMs,
        "M6_LIVE_BROKER_TOOL_TIMEOUT",
        `live tool ${message.method} did not settle in time`,
      );
    } catch (cause) {
      if (cause?.code === "M6_LIVE_BROKER_TOOL_TIMEOUT") throw cause;
      throw brokerError("M6_LIVE_BROKER_HANDLER_FAILED", `live tool ${message.method} handler failed`);
    }
    const resultValidation = validateLiveToolResult({ tool: message.method, result });
    if (!resultValidation.ok) {
      throw brokerError(resultValidation.errors[0], `live tool result was rejected: ${resultValidation.errors.join(",")}`);
    }
    if (this.failure || this.isClosed) return;
    await this.#writeFrame({ type: "tool_result", nonceHash: nonceHash(message.nonce), result });
  }

  #acceptHello(message) {
    if (!hasExactKeys(message, HELLO_KEYS) || message.type !== "hello"
      || message.processRef !== this.binding.processRef
      || message.bindingHash !== this.binding.bindingHash
      || message.brokerFd !== this.brokerFd
      || message.transportAuthorityPresent !== false
      || message.rawDeviceIdentityPresent !== false
      || !Array.isArray(message.toolNames)
      || message.toolNames.length !== M6_LIVE_TOOL_NAMES.length
      || message.toolNames.some((name, index) => name !== M6_LIVE_TOOL_NAMES[index])) {
      throw brokerError("M6_LIVE_BROKER_HELLO_INVALID", "child broker hello did not match the exact FD3 binding and ten-tool inventory");
    }
    clearTimeout(this.helloTimer);
    this.helloAccepted = true;
    this.resolveReady(Object.freeze({ bindingHash: this.binding.bindingHash, toolNames: M6_LIVE_TOOL_NAMES }));
  }

  async #writeFrame(value) {
    const encoded = Buffer.from(`${JSON.stringify(value)}\n`);
    if (encoded.length > this.maxLineBytes) throw brokerError("M6_LIVE_BROKER_LINE_LIMIT", "parent broker response exceeded the line limit");
    if (!this.stream.write(encoded)) {
      this.stream.pause?.();
      try {
        await once(this.stream, "drain");
      } finally {
        this.stream.resume?.();
      }
    }
  }

  #fail(cause) {
    if (this.failure || this.isClosed) return;
    const error = cause instanceof Error ? cause : brokerError("M6_LIVE_BROKER_FATAL", String(cause));
    if (typeof error.code !== "string") error.code = "M6_LIVE_BROKER_FATAL";
    this.failure = error;
    clearTimeout(this.helloTimer);
    clearTimeout(this.incompleteTimer);
    if (!this.helloAccepted) this.rejectReady(error);
    try { this.onFatal(error); } catch {}
    const rejectFrame = Buffer.from(`${JSON.stringify({ type: "reject", code: error.code })}\n`);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      this.#finish();
    };
    const timer = setTimeout(finish, 25);
    timer.unref();
    try {
      this.stream.write(rejectFrame, () => {
        clearTimeout(timer);
        finish();
      });
    } catch {
      clearTimeout(timer);
      finish();
    }
  }

  #finish() {
    if (this.isClosed) return;
    this.isClosed = true;
    clearTimeout(this.helloTimer);
    clearTimeout(this.incompleteTimer);
    if (!this.helloAccepted && !this.failure) {
      const error = brokerError("M6_LIVE_BROKER_CLOSED_BEFORE_HELLO", "broker pipe closed before child hello");
      this.failure = error;
      this.rejectReady(error);
    }
    this.stream.off("data", this.onData);
    this.stream.off("error", this.onError);
    this.stream.off("end", this.onEnd);
    this.stream.off("close", this.onClose);
    this.stream.destroy();
    this.resolveClosed(Object.freeze({
      schemaId: "xw.m6-live-parent-broker-close.v1",
      bindingHash: this.binding.bindingHash,
      helloAccepted: this.helloAccepted,
      callCount: this.seenNonces.size,
      failureCode: this.failure?.code ?? null,
      pipeClosed: true,
    }));
  }
}
