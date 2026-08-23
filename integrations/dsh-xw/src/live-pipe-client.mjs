import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";

import { M6_LIVE_TOOL_NAMES, validateLiveToolCall, validateLiveToolResult } from "../../../services/orchestrator/scripts/lib/m6/m6-live-tool-surface.mjs";

const MAX_LINE_BYTES = 64 * 1024;
const BINDING_CORE_KEYS = Object.freeze([
  "runId", "workerId", "sessionId", "alias", "processRef",
  "gateEpochHash", "generation", "purpose", "scenarioManifestHash", "liveWindowAuthorizationHash",
]);
const BINDING_KEYS = Object.freeze([...BINDING_CORE_KEYS, "bindingHash"]);
const HASH = /^[0-9a-f]{64}$/u;
const OPAQUE = /^[a-z0-9][a-z0-9:_-]{7,127}$/u;
const PURPOSES = Object.freeze(new Set([
  "M6_4_SHADOW",
  "M6_4_HOT_CLOSE",
  "M6_4_ACTION_SMOKE",
  "M6_4_RELIABILITY",
  "M6_4_SMOOTH",
]));

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value, keys) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export function computeM6LivePipeBindingHash(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw Object.assign(new Error("live broker correlation binding is not an object"), { code: "M6_LIVE_PIPE_BINDING_INVALID" });
  }
  const core = Object.fromEntries(BINDING_CORE_KEYS.map((key) => [key, binding[key]]));
  return createHash("sha256").update(canonical(core)).digest("hex");
}

export function createM6LivePipeBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding) || !exactKeys(binding, BINDING_CORE_KEYS)) {
    throw Object.assign(new Error("live broker correlation binding core is not exact"), { code: "M6_LIVE_PIPE_BINDING_INVALID" });
  }
  return validateM6LivePipeBinding({ ...binding, bindingHash: computeM6LivePipeBindingHash(binding) });
}

export function validateM6LivePipeBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)
    || !exactKeys(binding, BINDING_KEYS)
    || !["runId", "workerId", "sessionId", "processRef"].every((key) => typeof binding[key] === "string" && OPAQUE.test(binding[key]))
    || binding.alias !== "01"
    || !["gateEpochHash", "scenarioManifestHash", "liveWindowAuthorizationHash", "bindingHash"].every((key) => typeof binding[key] === "string" && HASH.test(binding[key]))
    || !Number.isSafeInteger(binding.generation) || binding.generation < 1
    || !PURPOSES.has(binding.purpose)) {
    throw Object.assign(new Error("live broker correlation binding is not the exact opaque alias-01 shape"), { code: "M6_LIVE_PIPE_BINDING_INVALID" });
  }
  if (binding.bindingHash !== computeM6LivePipeBindingHash(binding)) {
    throw Object.assign(new Error("live broker correlation binding hash does not match its canonical fields"), { code: "M6_LIVE_PIPE_BINDING_HASH_INVALID" });
  }
  return Object.freeze({ ...binding });
}

export class LivePipeToolClient {
  constructor({ fd = Number(process.env.XW_M6_BROKER_FD), binding, timeoutMs = 5_000 } = {}) {
    if (fd !== 3) throw Object.assign(new Error("the inherited broker pipe must be FD3"), { code: "M6_LIVE_PIPE_REQUIRED" });
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw Object.assign(new Error("live pipe timeout must be a positive safe integer"), { code: "M6_LIVE_PIPE_TIMEOUT_INVALID" });
    this.binding = validateM6LivePipeBinding(binding);
    this.timeoutMs = timeoutMs;
    this.input = createReadStream(null, { fd, autoClose: false });
    this.output = createWriteStream(null, { fd, autoClose: false });
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.closed = false;
    this.input.on("data", (chunk) => this.#onData(chunk));
    this.input.on("error", (error) => this.#close(error));
    this.input.on("end", () => this.#close(Object.assign(new Error("broker pipe ended"), { code: "M6_LIVE_PIPE_CLOSED" })));
    this.output.on("error", (error) => this.#close(error));
    this.#write({
      type: "hello",
      processRef: this.binding.processRef,
      bindingHash: this.binding.bindingHash,
      toolNames: M6_LIVE_TOOL_NAMES,
      brokerFd: fd,
      transportAuthorityPresent: false,
      rawDeviceIdentityPresent: false,
    });
  }

  call(method, params) {
    const validation = validateLiveToolCall({ tool: method, args: params });
    if (!validation.ok) throw Object.assign(new Error(`live tool call rejected: ${validation.errors.join(",")}`), { code: validation.errors[0] });
    if (this.closed) return Promise.reject(Object.assign(new Error("broker pipe is closed"), { code: "M6_LIVE_PIPE_CLOSED" }));
    const nonce = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = Object.assign(new Error("broker response timed out"), { code: "M6_LIVE_PIPE_TIMEOUT" });
        reject(error);
        this.#close(error);
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(nonce, { method, resolve, reject, timer });
      this.#write({ type: "tool_call", correlation: this.binding, method, nonce, params });
    });
  }

  close() {
    this.#close(Object.assign(new Error("live pipe client closed"), { code: "M6_LIVE_PIPE_CLOSED" }));
  }

  #write(value) {
    if (this.closed) throw Object.assign(new Error("broker pipe is closed"), { code: "M6_LIVE_PIPE_CLOSED" });
    const encoded = Buffer.from(`${JSON.stringify(value)}\n`);
    if (encoded.length > MAX_LINE_BYTES) throw Object.assign(new Error("broker line is too large"), { code: "M6_LIVE_PIPE_LINE_LIMIT" });
    this.output.write(encoded);
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    if (this.buffer.length > MAX_LINE_BYTES && !this.buffer.includes(0x0a)) return this.#close(Object.assign(new Error("incomplete broker line is too large"), { code: "M6_LIVE_PIPE_LINE_LIMIT" }));
    while (this.buffer.includes(0x0a)) {
      const newline = this.buffer.indexOf(0x0a);
      const raw = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (raw.length > MAX_LINE_BYTES) return this.#close(Object.assign(new Error("broker line is too large"), { code: "M6_LIVE_PIPE_LINE_LIMIT" }));
      let message;
      try { message = JSON.parse(raw.toString("utf8")); } catch { return this.#close(Object.assign(new Error("broker returned invalid JSON"), { code: "M6_LIVE_PIPE_PROTOCOL" })); }
      if (message?.type === "reject" && exactKeys(message, ["type", "code"]) && typeof message.code === "string") {
        return this.#close(Object.assign(new Error("broker rejected child"), { code: message.code }));
      }
      if (!message || typeof message !== "object" || Array.isArray(message)
        || !exactKeys(message, ["type", "nonceHash", "result"])
        || message.type !== "tool_result" || typeof message.nonceHash !== "string" || !HASH.test(message.nonceHash)) {
        return this.#close(Object.assign(new Error("unexpected broker response"), { code: "M6_LIVE_PIPE_PROTOCOL" }));
      }
      const found = [...this.pending.entries()].find(([nonce]) => createHash("sha256").update(nonce).digest("hex") === message.nonceHash);
      if (!found) return this.#close(Object.assign(new Error("broker response nonce is unknown"), { code: "M6_LIVE_PIPE_REPLAY" }));
      const [nonce, pending] = found;
      const validation = validateLiveToolResult({ tool: pending.method, result: message.result });
      if (!validation.ok) return this.#close(Object.assign(new Error(`live tool result rejected: ${validation.errors.join(",")}`), { code: validation.errors[0] }));
      clearTimeout(pending.timer);
      this.pending.delete(nonce);
      pending.resolve(message.result);
    }
  }

  #close(error) {
    if (this.closed) return;
    this.closed = true;
    this.input.destroy();
    this.output.destroy();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}
