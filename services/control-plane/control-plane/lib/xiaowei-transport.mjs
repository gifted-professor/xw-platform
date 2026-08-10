import {
  closeSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { ControlPlaneError } from "./errors.mjs";
import { guardFinancialCommit } from "./financial-commit-classifier.mjs";

const DEFAULT_URL = "ws://127.0.0.1:22222/";
const DEFAULT_LOCK_PATH = join(tmpdir(), "xw-ws-22222.lock");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A small in-process FIFO gate for callers sharing one transport lock path.
 *
 * This is intentionally only the first half of fairness: the filesystem lock
 * remains the cross-process single-flight authority.  A future broker process
 * can replace this gate without changing XiaoweiTransport's public contract.
 */
export class FairFifoQueue {
  #items = [];
  #active = false;
  #idleWaiters = [];

  get size() {
    return this.#items.length + (this.#active ? 1 : 0);
  }

  enqueue(task) {
    if (typeof task !== "function") {
      throw new TypeError("FairFifoQueue.enqueue requires a function");
    }
    const result = new Promise((resolve, reject) => {
      this.#items.push({ task, resolve, reject });
    });
    void this.#drain();
    return result;
  }

  waitForIdle() {
    if (!this.#active && this.#items.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  async #drain() {
    if (this.#active) return;
    this.#active = true;
    try {
      while (this.#items.length > 0) {
        const item = this.#items.shift();
        try {
          item.resolve(await item.task());
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.#active = false;
      if (this.#items.length > 0) {
        void this.#drain();
        return;
      }
      const waiters = this.#idleWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }
}

const sharedFifoQueues = new Map();

function sharedQueueFor(lockPath) {
  let queue = sharedFifoQueues.get(lockPath);
  if (!queue) {
    queue = new FairFifoQueue();
    sharedFifoQueues.set(lockPath, queue);
  }
  return queue;
}

function normalizeRequest({ action, devices, data } = {}) {
  if (typeof action !== "string" || action.trim() === "") {
    throw new ControlPlaneError("XIAOWEI_INVALID_ACTION", "Xiaowei action must be non-empty");
  }
  return {
    action,
    ...(devices ? { devices } : {}),
    ...(data !== undefined ? { data } : {}),
  };
}

function parseVendorResponse(event, request) {
  let response;
  try {
    response = JSON.parse(String(event.data));
  } catch (error) {
    throw new ControlPlaneError("XIAOWEI_MALFORMED_RESPONSE", "Xiaowei returned malformed JSON", {
      status: 502,
      cause: error,
    });
  }
  if (typeof response?.code === "number" && response.code !== 10000) {
    throw new ControlPlaneError("XIAOWEI_VENDOR_ERROR", `Xiaowei rejected ${request.action}`, {
      status: 502,
      details: { action: request.action, vendorCode: response.code },
    });
  }
  return response;
}

function readToken(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed.token === "string" ? parsed.token : null;
  } catch {
    return null;
  }
}

export function inspectTransportLock({
  path = DEFAULT_LOCK_PATH,
  staleMs = 180000,
  now = Date.now(),
} = {}) {
  try {
    const ageMs = Math.max(0, now - statSync(path).mtimeMs);
    return {
      status: ageMs > staleMs ? "stale" : "busy",
      ageMs,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "free", ageMs: null };
    return { status: "unknown", ageMs: null };
  }
}

export async function acquireTransportLock({
  path = DEFAULT_LOCK_PATH,
  timeoutMs = 45000,
  staleMs = 180000,
  retryMs = 100,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  while (true) {
    try {
      const descriptor = openSync(path, "wx", 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }));
      } finally {
        closeSync(descriptor);
      }
      const heartbeatMs = Math.max(25, Math.min(5000, Math.floor(staleMs / 3)));
      const heartbeat = setInterval(() => {
        try {
          const now = new Date();
          if (readToken(path) === token) utimesSync(path, now, now);
        } catch {
          // release checks ownership before deleting.
        }
      }, heartbeatMs);
      heartbeat.unref?.();
      return () => {
        clearInterval(heartbeat);
        try {
          if (readToken(path) === token) unlinkSync(path);
        } catch {
          // Missing locks are already released.
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw new ControlPlaneError("TRANSPORT_LOCK_ERROR", "unable to create Xiaowei transport lock", {
          status: 503,
          details: { path },
          cause: error,
        });
      }
      try {
        if (Date.now() - statSync(path).mtimeMs > staleMs) {
          unlinkSync(path);
          continue;
        }
      } catch (lockError) {
        if (lockError?.code === "ENOENT") continue;
      }
      if (Date.now() >= deadline) {
        throw new ControlPlaneError("TRANSPORT_LOCK_TIMEOUT", "timed out waiting for Xiaowei transport", {
          status: 503,
          details: { timeoutMs },
        });
      }
      await sleep(Math.min(retryMs, Math.max(1, deadline - Date.now())));
    }
  }
}

export class XiaoweiTransport {
  constructor({
    url = DEFAULT_URL,
    WebSocketImpl = globalThis.WebSocket,
    lockPath = DEFAULT_LOCK_PATH,
    requestTimeoutMs = 12000,
    lockTimeoutMs = 45000,
    staleLockMs = 180000,
    lockRetryMs = 100,
    broker = null,
    reuseWebSocket = false,
  } = {}) {
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.lockPath = lockPath;
    this.requestTimeoutMs = requestTimeoutMs;
    this.lockTimeoutMs = lockTimeoutMs;
    this.staleLockMs = staleLockMs;
    this.lockRetryMs = lockRetryMs;
    if (broker !== null && typeof broker?.enqueue !== "function") {
      throw new TypeError("XiaoweiTransport broker must expose enqueue(task)");
    }
    this.broker = broker || sharedQueueFor(lockPath);
    // Vendor support for multiple requests per WebSocket is not established.
    // Reuse therefore remains an explicit opt-in for controlled tests/workflows.
    this.reuseWebSocket = reuseWebSocket === true;
  }

  /**
   * Execute one request with the historical one-request/one-WebSocket policy.
   * The request is still ordered through the broker and the cross-process lock.
   */
  async invoke(request = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    const normalized = normalizeRequest(request);
    // REX Phase 2 收尾 §4.2.A：直运 WS-22222 入口 fail-closed。无 verifier → 任何
    // financial_commit 语义输入恒拒（transport=0，不连 WS）。无语义的 list/Screen 等
    // 请求 extractFinancialInput 返回 null，零成本放行。
    await guardFinancialCommit(normalized);
    return this.#enqueueExclusive(
      (channel) => channel.invoke(normalized, { timeoutMs }),
      { reuseWebSocket: false },
    );
  }

  /**
   * Run a bounded, caller-defined workflow while holding one transport turn.
   *
   * The callback receives only the typed `invoke` method. Calls made through it
   * are FIFO-serialized inside this turn, and the outer turn remains protected
   * by the existing cross-process tokenized lock. This is the foundation for a
   * catalog-bound workflow runner; it is deliberately not an arbitrary shell
   * or action-array executor.
   *
   * `reuseWebSocket: true` is experimental and opt-in. The default creates a
   * fresh WebSocket per request even inside the bounded workflow.
   */
  async runExclusive(callback, {
    lockTimeoutMs = this.lockTimeoutMs,
    reuseWebSocket = this.reuseWebSocket,
  } = {}) {
    if (typeof callback !== "function") {
      throw new TypeError("XiaoweiTransport.runExclusive requires a function");
    }
    return this.#enqueueExclusive(
      (channel) => callback(channel),
      { lockTimeoutMs, reuseWebSocket },
    );
  }

  async #enqueueExclusive(callback, {
    lockTimeoutMs = this.lockTimeoutMs,
    reuseWebSocket = false,
  } = {}) {
    if (typeof this.WebSocketImpl !== "function") {
      throw new ControlPlaneError("XIAOWEI_WEBSOCKET_UNAVAILABLE", "WebSocket is unavailable", { status: 503 });
    }
    return this.broker.enqueue(async () => {
      const release = await acquireTransportLock({
        path: this.lockPath,
        timeoutMs: lockTimeoutMs,
        staleMs: this.staleLockMs,
        retryMs: this.lockRetryMs,
      });
      const state = {
        reuseWebSocket: reuseWebSocket === true,
        socket: null,
        opened: false,
        openPromise: null,
        openReject: null,
        pending: null,
      };
      const requestQueue = new FairFifoQueue();
      const invokeUnchecked = (request, { timeoutMs = this.requestTimeoutMs } = {}) => {
        const normalized = normalizeRequest(request);
        return requestQueue.enqueue(() => state.reuseWebSocket
          ? this.#invokeReusable(state, normalized, timeoutMs)
          : this.#invokeUnlocked(normalized, timeoutMs));
      };
      const channel = {
        invoke: async (request = {}, options = {}) => {
          const normalized = normalizeRequest(request);
          await guardFinancialCommit(normalized);
          return invokeUnchecked(normalized, options);
        },
        get pending() {
          return requestQueue.size;
        },
      };
      try {
        // Public callers receive only channel.invoke, which retains the
        // financial gate. The unchecked helper never crosses this boundary.
        return await callback(channel);
      } finally {
        // A callback may intentionally enqueue work without immediately
        // awaiting every Promise. Do not close the socket or release the lock
        // until all accepted channel requests have settled.
        await requestQueue.waitForIdle();
        this.#closeReusable(state);
        release();
      }
    });
  }

  #invokeUnlocked(request, timeoutMs) {
    return new Promise((resolve, reject) => {
      let socket;
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket?.close(); } catch {}
        callback(value);
      };
      const timer = setTimeout(() => {
        const error = new ControlPlaneError("XIAOWEI_TIMEOUT", `Xiaowei timed out after ${timeoutMs}ms`, {
          status: 504,
          details: { action: request.action, timeoutMs },
        });
        error.sent = true;
        finish(reject, error);
      }, timeoutMs);
      try {
        socket = new this.WebSocketImpl(this.url);
      } catch (error) {
        finish(reject, new ControlPlaneError("XIAOWEI_CONNECTION_ERROR", "unable to connect to Xiaowei", {
          status: 503,
          cause: error,
        }));
        return;
      }
      socket.addEventListener("open", () => {
        try {
          socket.send(JSON.stringify(request));
        } catch (error) {
          finish(reject, new ControlPlaneError("XIAOWEI_SEND_ERROR", "unable to send Xiaowei request", {
            status: 503,
            cause: error,
          }));
        }
      });
      socket.addEventListener("message", (event) => {
        try {
          finish(resolve, parseVendorResponse(event, request));
        } catch (error) {
          finish(reject, error);
        }
      });
      socket.addEventListener("error", () => {
        finish(reject, new ControlPlaneError("XIAOWEI_CONNECTION_ERROR", "Xiaowei connection failed", { status: 503 }));
      });
      socket.addEventListener("close", () => {
        if (!settled) finish(reject, new ControlPlaneError("XIAOWEI_CLOSED", "Xiaowei closed before responding", { status: 502 }));
      });
    });
  }

  #invokeReusable(state, request, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (state.pending?.finish === finish) state.pending = null;
        callback(value);
      };
      const timer = setTimeout(() => {
        const error = new ControlPlaneError("XIAOWEI_TIMEOUT", `Xiaowei timed out after ${timeoutMs}ms`, {
          status: 504,
          details: { action: request.action, timeoutMs },
        });
        error.sent = true;
        finish(reject, error);
        // A timed-out request may have been accepted by the vendor. Do not
        // send a second request on the same uncorrelated connection.
        this.#closeReusable(state, error);
      }, timeoutMs);

      (async () => {
        try {
          const socket = await this.#ensureReusableSocket(state);
          if (settled) return;
          state.pending = {
            request,
            finish,
            resolve: (response) => finish(resolve, response),
            reject: (error) => finish(reject, error),
          };
          try {
            socket.send(JSON.stringify(request));
          } catch (error) {
            const wrapped = new ControlPlaneError("XIAOWEI_SEND_ERROR", "unable to send Xiaowei request", {
              status: 503,
              cause: error,
            });
            finish(reject, wrapped);
            this.#closeReusable(state, wrapped);
          }
        } catch (error) {
          finish(reject, error);
        }
      })();
    });
  }

  #ensureReusableSocket(state) {
    if (state.socket && state.opened) return Promise.resolve(state.socket);
    if (state.openPromise) return state.openPromise;

    let socket;
    let ready = false;
    let resolveReady;
    let rejectReady;
    const openPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    state.openPromise = openPromise;
    state.openReject = rejectReady;

    const fail = (error) => {
      const current = state.socket === socket;
      if (current) {
        state.socket = null;
        state.opened = false;
        state.openPromise = null;
        state.openReject = null;
      }
      if (!ready) {
        ready = true;
        rejectReady(error);
      }
      const pending = state.pending;
      if (pending) {
        state.pending = null;
        pending.reject(error);
      }
      try { socket?.close(); } catch {}
    };

    try {
      socket = new this.WebSocketImpl(this.url);
      state.socket = socket;
      socket.addEventListener("open", () => {
        if (ready) return;
        ready = true;
        state.opened = true;
        state.openPromise = null;
        state.openReject = null;
        resolveReady(socket);
      });
      socket.addEventListener("message", (event) => {
        const pending = state.pending;
        if (!pending) return;
        try {
          pending.resolve(parseVendorResponse(event, pending.request));
        } catch (error) {
          pending.reject(error);
          if (error?.code === "XIAOWEI_MALFORMED_RESPONSE") this.#closeReusable(state, error);
        }
      });
      socket.addEventListener("error", () => {
        fail(new ControlPlaneError("XIAOWEI_CONNECTION_ERROR", "Xiaowei connection failed", { status: 503 }));
      });
      socket.addEventListener("close", () => {
        if (!ready || state.pending) {
          fail(new ControlPlaneError("XIAOWEI_CLOSED", "Xiaowei closed before responding", { status: 502 }));
        } else if (state.socket === socket) {
          state.socket = null;
          state.opened = false;
          state.openPromise = null;
          state.openReject = null;
        }
      });
    } catch (error) {
      fail(new ControlPlaneError("XIAOWEI_CONNECTION_ERROR", "unable to connect to Xiaowei", {
        status: 503,
        cause: error,
      }));
    }
    return openPromise;
  }

  #closeReusable(state, error = null) {
    const closeError = error || new ControlPlaneError("XIAOWEI_CLOSED", "Xiaowei connection closed", { status: 502 });
    const pending = state.pending;
    state.pending = null;
    if (pending) pending.reject(closeError);
    if (state.openReject && !state.opened) state.openReject(closeError);
    const socket = state.socket;
    state.socket = null;
    state.opened = false;
    state.openPromise = null;
    state.openReject = null;
    try { socket?.close(); } catch {}
  }
}
