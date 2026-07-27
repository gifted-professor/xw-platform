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

const DEFAULT_URL = "ws://127.0.0.1:22222/";
const DEFAULT_LOCK_PATH = join(tmpdir(), "xw-ws-22222.lock");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  } = {}) {
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.lockPath = lockPath;
    this.requestTimeoutMs = requestTimeoutMs;
    this.lockTimeoutMs = lockTimeoutMs;
    this.staleLockMs = staleLockMs;
    this.lockRetryMs = lockRetryMs;
  }

  async invoke({ action, devices, data }, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (typeof action !== "string" || action.trim() === "") {
      throw new ControlPlaneError("XIAOWEI_INVALID_ACTION", "Xiaowei action must be non-empty");
    }
    if (typeof this.WebSocketImpl !== "function") {
      throw new ControlPlaneError("XIAOWEI_WEBSOCKET_UNAVAILABLE", "WebSocket is unavailable", { status: 503 });
    }
    const release = await acquireTransportLock({
      path: this.lockPath,
      timeoutMs: this.lockTimeoutMs,
      staleMs: this.staleLockMs,
      retryMs: this.lockRetryMs,
    });
    try {
      return await this.#invokeUnlocked({ action, ...(devices ? { devices } : {}), ...(data !== undefined ? { data } : {}) }, timeoutMs);
    } finally {
      release();
    }
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
        let response;
        try {
          response = JSON.parse(String(event.data));
        } catch (error) {
          finish(reject, new ControlPlaneError("XIAOWEI_MALFORMED_RESPONSE", "Xiaowei returned malformed JSON", {
            status: 502,
            cause: error,
          }));
          return;
        }
        if (typeof response?.code === "number" && response.code !== 10000) {
          finish(reject, new ControlPlaneError("XIAOWEI_VENDOR_ERROR", `Xiaowei rejected ${request.action}`, {
            status: 502,
            details: { action: request.action, vendorCode: response.code },
          }));
          return;
        }
        finish(resolve, response);
      });
      socket.addEventListener("error", () => {
        finish(reject, new ControlPlaneError("XIAOWEI_CONNECTION_ERROR", "Xiaowei connection failed", { status: 503 }));
      });
      socket.addEventListener("close", () => {
        if (!settled) finish(reject, new ControlPlaneError("XIAOWEI_CLOSED", "Xiaowei closed before responding", { status: 502 }));
      });
    });
  }
}
