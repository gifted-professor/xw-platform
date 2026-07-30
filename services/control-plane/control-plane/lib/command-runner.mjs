import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { ControlPlaneError } from "./errors.mjs";

export function requireFile(path, capabilityId) {
  if (!existsSync(path)) {
    throw new ControlPlaneError(
      "ADAPTER_DEPENDENCY_MISSING",
      `${capabilityId} depends on an implementation that is not merged`,
      { status: 503, details: { dependency: path.split(/[\\/]/).pop() } },
    );
  }
}

export function runJsonCommand(command, args, {
  cwd,
  timeoutMs,
  env = process.env,
  maxOutputBytes = 4 * 1024 * 1024,
  spawnImpl = spawn,
  timeoutExitGraceMs = 5000,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let killedForSize = false;
    let timedOut = false;
    let timeoutError = null;
    let timeoutExitTimer = null;
    const append = (current, chunk) => {
      const next = Buffer.concat([current, chunk]);
      if (next.length > maxOutputBytes) {
        killedForSize = true;
        child.kill();
      }
      return next.subarray(0, maxOutputBytes);
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const rejectTimeout = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(timeoutExitTimer);
      reject(timeoutError);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      timeoutError = new ControlPlaneError("ADAPTER_TIMEOUT", `adapter timed out after ${timeoutMs}ms`, {
        status: 504,
      });
      timeoutError.sent = true;
      try {
        child.kill();
      } catch {
        rejectTimeout();
        return;
      }
      // Restoration must not race the timed-out adapter. Prefer the real exit,
      // but keep a bounded fallback in case the platform never reports it.
      timeoutExitTimer = setTimeout(rejectTimeout, timeoutExitGraceMs);
      timeoutExitTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (error) => {
      if (settled) return;
      if (timedOut) {
        rejectTimeout();
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(new ControlPlaneError("ADAPTER_START_FAILED", "unable to start adapter process", {
        status: 503,
        cause: error,
      }));
    });
    child.once("exit", (code) => {
      if (settled) return;
      if (timedOut) {
        rejectTimeout();
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(timeoutExitTimer);
      if (killedForSize) {
        reject(new ControlPlaneError("ADAPTER_OUTPUT_TOO_LARGE", "adapter output exceeded the limit", { status: 502 }));
        return;
      }
      const output = stdout.toString("utf8").trim();
      if (code !== 0) {
        let adapterCode = null;
        try {
          const parsed = output ? JSON.parse(output) : null;
          adapterCode = typeof parsed?.errorCode === "string"
            ? parsed.errorCode.slice(0, 96)
            : null;
        } catch {
          // A failed adapter is not required to return JSON. Keep diagnostics bounded.
        }
        reject(new ControlPlaneError("ADAPTER_FAILED", "adapter process failed", {
          status: 502,
          details: {
            exitCode: code,
            stderrPresent: stderr.length > 0,
            adapterCode,
          },
        }));
        return;
      }
      try {
        resolve(output ? JSON.parse(output) : {});
      } catch (error) {
        reject(new ControlPlaneError("ADAPTER_INVALID_JSON", "adapter returned invalid JSON", {
          status: 502,
          cause: error,
        }));
      }
    });
  });
}

function safeAdapterCode(value) {
  const code = String(value ?? "").trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "OPERATOR_ERROR";
}

function safeAdapterStep(value) {
  const step = String(value ?? "adapter")
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .slice(0, 80);
  return step || "adapter";
}

function safeAdapterMessage(value) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\b(serial|runtime(?:id)?|token|secret|password|authorization)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi,
      (_match, key) => `${key.toLowerCase()}=[redacted]`)
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function safeAdapterError(result) {
  const error = result?.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  if (error.code == null && error.step == null && error.action == null && error.message == null) return null;
  return {
    code: safeAdapterCode(error.code),
    step: safeAdapterStep(error.step ?? error.action),
    message: safeAdapterMessage(error.message),
  };
}

export async function postJson(url, body, {
  timeoutMs = 30000,
  fetchImpl = globalThis.fetch,
  headers = {},
} = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const wrapped = new ControlPlaneError("ADAPTER_HTTP_UNAVAILABLE", "loopback adapter is unavailable", {
      status: 503,
      details: { endpoint: new URL(url).origin },
      cause: error,
    });
    if (error?.name === "TimeoutError") wrapped.sent = true;
    throw wrapped;
  }
  let result;
  try {
    result = await response.json();
  } catch (error) {
    throw new ControlPlaneError("ADAPTER_INVALID_JSON", "loopback adapter returned invalid JSON", {
      status: 502,
      cause: error,
    });
  }
  if (!response.ok || result?.ok === false) {
    const adapterError = safeAdapterError(result);
    throw new ControlPlaneError("ADAPTER_REJECTED", "loopback adapter rejected the action", {
      status: 502,
      details: {
        httpStatus: response.status,
        ...(adapterError ? { adapterError } : {}),
      },
    });
  }
  return result;
}
