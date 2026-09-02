/**
 * xhs-exploration-vision-process.mjs — isolated local provider execution for
 * V3 exploration vision. Each request owns its child process and cancellation
 * handle. The provider receives a private staging copy of the exact CP-bound
 * frame bytes; the source artifact path is never passed to the child.
 */
import { createHash } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  EXPLORATION_VISION_PROCESS_RESULT_SCHEMA_ID,
  verifyExplorationVisionProviderBundle,
  verifyPythonRuntimeClosure,
} from "./xhs-exploration-provider-bundle.mjs";

export const EXPLORATION_VISION_PROCESS_DEADLINE_CAP_MS = 8_000;
export const EXPLORATION_VISION_PROCESS_KILL_GRACE_MS = 750;
export const EXPLORATION_VISION_PROCESS_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
export const EXPLORATION_VISION_PROCESS_MAX_FRAME_BYTES = 12 * 1024 * 1024;

const CHILD_SYSTEM_ENV_KEYS = Object.freeze([
  "SystemRoot",
  "WINDIR",
  "SystemDrive",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
]);

// Offline provider capability is broader than live authority. These pairs are
// used by the no-device-I/O corpus gate. The mission/navigator/CP live
// allowlists remain separately closed to VIDEO_NOTE/PAUSE_VIDEO_SAFE_ZONE.
export const EXPLORATION_VISION_PROCESS_ROUTE_ROLES = Object.freeze({
  HOME_FEED: Object.freeze(["OPEN_CONTENT_CARD"]),
  SEARCH_RESULTS: Object.freeze(["OPEN_CONTENT_CARD"]),
  IMAGE_NOTE: Object.freeze(["OPEN_COMMENT_PANEL"]),
  VIDEO_NOTE: Object.freeze(["OPEN_COMMENT_PANEL", "PAUSE_VIDEO_SAFE_ZONE"]),
  COMMENT_PANEL: Object.freeze(["BACK"]),
});

function processError(code, message, { status = 502, details = {} } = {}) {
  return Object.assign(new Error(message), {
    code,
    name: "ExplorationVisionProcessError",
    status,
    details,
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Provider children never inherit the orchestrator environment. Only the
 * minimal Windows/locale/temp keys needed to start the pinned interpreter,
 * deterministic Python flags, and request-owned XW_VISION_* bindings cross
 * the process boundary. Token/proxy/path/module injection variables cannot.
 */
export function buildExplorationVisionChildEnv(sourceEnv = {}, bindings = {}, {
  pythonPath = null,
  platform = process.platform,
} = {}) {
  const childEnv = {};
  const sourceRows = Object.entries(sourceEnv && typeof sourceEnv === "object" ? sourceEnv : {});
  for (const canonicalKey of CHILD_SYSTEM_ENV_KEYS) {
    const match = sourceRows.find(([key]) => key.toLowerCase() === canonicalKey.toLowerCase());
    if (match && match[1] !== undefined && match[1] !== null) {
      childEnv[canonicalKey] = String(match[1]);
    }
  }
  Object.assign(childEnv, {
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONHASHSEED: "0",
    PYTHONIOENCODING: "utf-8",
    PYTHONNOUSERSITE: "1",
    PYTHONUTF8: "1",
  });
  if (typeof pythonPath === "string" && isAbsolute(pythonPath)) {
    const runtimeSearch = [dirname(pythonPath)];
    if (platform === "win32") {
      const systemRoot = childEnv.SystemRoot ?? childEnv.WINDIR;
      if (systemRoot) runtimeSearch.push(join(systemRoot, "System32"), systemRoot);
    } else {
      runtimeSearch.push("/usr/bin", "/bin");
    }
    // Explicitly replace PATH. Omitting it on Windows lets CreateProcess add
    // the caller's user PATH back into the child despite the supplied env.
    childEnv.PATH = [...new Set(runtimeSearch)].join(delimiter);
  }
  for (const [key, value] of Object.entries(bindings)) {
    if (!/^XW_VISION_[A-Z0-9_]+$/.test(key) || value === undefined || value === null) {
      throw processError("EXPLORATION_VISION_PROCESS_CONFIG_INVALID", "child bindings must be explicit XW_VISION_* values");
    }
    childEnv[key] = String(value);
  }
  return Object.freeze(childEnv);
}

function isInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..\\`) && !rel.startsWith("../");
}

function safeRemoveStaging(root, candidate) {
  if (!isInside(root, candidate)) return;
  rmSync(candidate, { recursive: true, force: true });
}

function normalizeBounds(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 4
    || Object.keys(value).some((key) => !["x", "y", "w", "h"].includes(key))) return null;
  const { x, y, w, h } = value;
  return [x, y, w, h].every(Number.isFinite)
    && x >= 0 && y >= 0 && w > 0 && h > 0
    ? { x, y, w, h }
    : null;
}

function normalizeElements(value, capturedAt) {
  const rows = Array.isArray(value) ? value : null;
  if (!rows) {
    throw processError("EXPLORATION_VISION_RESULT_INVALID", "provider result must contain an elements array");
  }
  const blocks = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)
      || Object.keys(row).length !== 3
      || Object.keys(row).some((key) => !["label", "bounds", "confidence"].includes(key))
      || typeof row.label !== "string" || !row.label.trim()) {
      throw processError("EXPLORATION_VISION_PROVIDER_RESULT_INVALID", "provider element fields are invalid");
    }
    const bounds = normalizeBounds(row.bounds);
    const confidence = row.confidence;
    if (!bounds || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw processError("EXPLORATION_VISION_PROVIDER_RESULT_INVALID", "provider element values are invalid");
    }
    blocks.push({
      label: row.label,
      bounds,
      confidence,
      capturedAt,
    });
  }
  return blocks;
}

function assertBoundProviderResult(parsed, { frameHash, modelHash, page, requestedRole }) {
  const keys = ["schemaId", "schemaVersion", "frameHash", "modelHash", "page", "role", "elements"];
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.keys(parsed).length !== keys.length
    || Object.keys(parsed).some((key) => !keys.includes(key))
    || parsed.schemaId !== EXPLORATION_VISION_PROCESS_RESULT_SCHEMA_ID
    || parsed.schemaVersion !== 1
    || !Array.isArray(parsed.elements)) {
    throw processError(
      "EXPLORATION_VISION_PROVIDER_RESULT_INVALID",
      "provider result does not match the exact versioned result protocol",
    );
  }
  if (parsed.frameHash !== frameHash) {
    throw processError("EXPLORATION_VISION_RESULT_FRAME_MISMATCH", "provider result is bound to a different frame", { status: 409 });
  }
  if (parsed.modelHash !== modelHash) {
    throw processError("EXPLORATION_VISION_RESULT_MODEL_MISMATCH", "provider result is bound to a different model", { status: 409 });
  }
  if (parsed.page !== page || parsed.role !== requestedRole) {
    throw processError("EXPLORATION_VISION_RESULT_ROUTE_MISMATCH", "provider result is bound to a different page/role", { status: 409 });
  }
  return parsed.elements;
}

function boundedStream(stream, maxBytes, onOverflow) {
  if (!stream || typeof stream.on !== "function") return () => {};
  let total = 0;
  const onData = (chunk) => {
    total += Buffer.byteLength(chunk);
    if (total > maxBytes) onOverflow();
  };
  stream.on("data", onData);
  return () => stream.off?.("data", onData);
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => {
    let timer = null;
    const done = () => {
      if (timer) clearTimeout(timer);
      resolveExit();
    };
    child.once("exit", done);
    timer = setTimeout(done, timeoutMs);
    timer.unref?.();
  });
}

async function defaultKillTree(child, { spawnImpl = nodeSpawn, graceMs = EXPLORATION_VISION_PROCESS_KILL_GRACE_MS } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill(); } catch { /* already gone */ }
  if (process.platform === "win32" && child.pid && child.exitCode === null) {
    try {
      const killer = spawnImpl("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      await waitForExit(killer, graceMs);
    } catch { /* bounded best effort; original child wait follows */ }
  }
  await waitForExit(child, graceMs);
}

function assertConfig(config) {
  for (const kind of ["python", "script", "model"]) {
    const path = config?.pin?.[kind]?.path;
    if (typeof path !== "string" || !path || !isAbsolute(path) || !existsSync(path)) {
      throw processError("EXPLORATION_VISION_PROCESS_CONFIG_INVALID", `pinned ${kind} file is absent or not absolute`);
    }
  }
  const maxBufferBytes = Number(config?.analysis?.maxBufferBytes);
  if (!Number.isInteger(maxBufferBytes) || maxBufferBytes <= 0
    || maxBufferBytes > EXPLORATION_VISION_PROCESS_MAX_BUFFER_BYTES) {
    throw processError(
      "EXPLORATION_VISION_PROCESS_CONFIG_INVALID",
      `analysis.maxBufferBytes must be within 1..${EXPLORATION_VISION_PROCESS_MAX_BUFFER_BYTES}`,
    );
  }
  const timeoutMs = Number(config?.analysis?.timeoutMs);
  if (config?.analysis?.protocol !== "xw.xhs.exploration-vision-process.v1"
    || !Number.isInteger(timeoutMs) || timeoutMs <= 0
    || timeoutMs > EXPLORATION_VISION_PROCESS_DEADLINE_CAP_MS) {
    throw processError(
      "EXPLORATION_VISION_PROCESS_CONFIG_INVALID",
      `analysis must use the pinned process protocol and a timeout within 1..${EXPLORATION_VISION_PROCESS_DEADLINE_CAP_MS}ms`,
    );
  }
  return { maxBufferBytes, timeoutMs };
}

function verifyProviderClosureBeforeUse(config) {
  // Lightweight fixture adapters do not carry production bundle identity.
  // Every resolved production config does, and must reproduce the complete
  // interpreter/script/model/data closure before the analyzer becomes active.
  // Production additionally requires an immutable SYSTEM/Administrators-only
  // content-addressed root, so untrusted writers cannot reopen a hash/use race.
  if (!config?.bundle) return;
  try {
    const dataFiles = Array.isArray(config?.pin?.data)
      ? config.pin.data.map((row) => ({ logicalPath: row.logicalPath, path: row.path }))
      : [];
    const closure = verifyExplorationVisionProviderBundle({
      manifestPath: config.bundle.manifest.path,
      python: config.pin.python.path,
      script: config.pin.script.path,
      model: config.pin.model.path,
      dataFiles,
    });
    if (closure.providerBundleDigest !== config.bundle.providerBundleDigest) {
      throw new Error("providerBundleDigest mismatch");
    }
    verifyPythonRuntimeClosure({ python: config.pin.python.path, dataFiles });
  } catch (error) {
    throw processError(
      "EXPLORATION_VISION_PROVIDER_CLOSURE_DRIFT",
      "provider runtime closure drifted before process use",
      { status: 409, details: { cause: error?.code ?? null } },
    );
  }
}

export function buildExplorationVisionProcessArgs(config, requestRoot, inputPath, resultPath) {
  if (extname(config.pin.script.path).toLowerCase() !== ".py") {
    return [config.pin.script.path, inputPath, "-o", resultPath];
  }
  // -I removes cwd/user/PYTHON* injection, -S excludes third-party installs, and the
  // fresh private pycache prefix makes on-install __pycache__ files unreachable.
  return [
    "-I",
    "-S",
    "-B",
    "-X",
    `pycache_prefix=${join(requestRoot, "pycache")}`,
    config.pin.script.path,
    inputPath,
    "-o",
    resultPath,
  ];
}

/**
 * Build an analyzer pinned to a resolved V3 provider config.
 *
 * `start(request)` returns a request-owned `{result,cancel}` handle. `analyze`
 * is the queue-friendly convenience form and still uses the same isolated
 * handle internally. `close()` cancels every live request before returning.
 */
export function createPinnedExplorationVisionAnalyzer(config, {
  spawnImpl = nodeSpawn,
  killTree = null,
  stagingRoot = join(tmpdir(), "xw-xhs-exploration-vision"),
  now = () => Date.now(),
  env = process.env,
} = {}) {
  const { maxBufferBytes, timeoutMs } = assertConfig(config);
  verifyProviderClosureBeforeUse(config);
  if (typeof stagingRoot !== "string" || !stagingRoot.trim()) {
    throw processError("EXPLORATION_VISION_PROCESS_CONFIG_INVALID", "private staging root is required");
  }
  const privateStagingRoot = resolve(stagingRoot);
  mkdirSync(privateStagingRoot, { recursive: true, mode: 0o700 });
  try { chmodSync(privateStagingRoot, 0o700); } catch { /* Windows ACL is owned by the runtime installer */ }
  const active = new Set();

  function start(request = {}) {
    const frame = request.frame ?? null;
    if (!Buffer.isBuffer(frame?.bytes) || frame.bytes.length === 0) {
      throw processError("EXPLORATION_VISION_FRAME_BYTES_REQUIRED", "provider analysis requires bound frame bytes", { status: 409 });
    }
    if (frame.bytes.length > EXPLORATION_VISION_PROCESS_MAX_FRAME_BYTES) {
      throw processError(
        "EXPLORATION_VISION_FRAME_BYTES_LIMIT",
        `bound frame exceeds the ${EXPLORATION_VISION_PROCESS_MAX_FRAME_BYTES}-byte ceiling`,
        { status: 413 },
      );
    }
    const actualFrameHash = sha256(frame.bytes);
    if (!/^[0-9a-f]{64}$/.test(String(frame.frameHash || "")) || frame.frameHash !== actualFrameHash) {
      throw processError("EXPLORATION_VISION_FRAME_HASH_MISMATCH", "frameHash does not match the bound frame bytes", { status: 409 });
    }
    const requestedDeadline = request.deadlineMs ?? timeoutMs;
    if (!Number.isInteger(requestedDeadline) || requestedDeadline <= 0
      || requestedDeadline > timeoutMs) {
      throw processError(
        "EXPLORATION_VISION_DEADLINE_INVALID",
        `provider deadline must be within 1..${timeoutMs}ms`,
        { status: 400 },
      );
    }
    const page = String(request.page ?? "");
    const requestedRole = String(request.requestedRole ?? "");
    if (!Object.hasOwn(EXPLORATION_VISION_PROCESS_ROUTE_ROLES, page)
      || !EXPLORATION_VISION_PROCESS_ROUTE_ROLES[page].includes(requestedRole)) {
      throw processError(
        "EXPLORATION_VISION_REQUEST_ROUTE_INVALID",
        "provider request page/requestedRole is outside the closed offline route set",
        { status: 400 },
      );
    }
    const requestRoot = mkdtempSync(join(privateStagingRoot, "request-"));
    try { chmodSync(requestRoot, 0o700); } catch { /* see root note above */ }
    const inputPath = join(requestRoot, `${actualFrameHash}.png`);
    const resultPath = join(requestRoot, "elements.json");
    writeFileSync(inputPath, frame.bytes, { flag: "wx", mode: 0o600 });
    if (sha256(readFileSync(inputPath)) !== actualFrameHash) {
      safeRemoveStaging(privateStagingRoot, requestRoot);
      throw processError("EXPLORATION_VISION_STAGING_DRIFT", "private frame staging changed before provider start", { status: 409 });
    }

    let child = null;
    let timer = null;
    let abortListener = null;
    let done = false;
    let cancelling = null;
    let cancelReason = null;
    let rejectResult = null;
    let overflowKind = null;
    const cleanups = [];

    const terminate = async (reason = "cancelled") => {
      if (cancelling) return cancelling;
      cancelReason = String(reason || "cancelled");
      cancelling = Promise.resolve().then(async () => {
        if (child && child.exitCode === null && child.signalCode === null) {
          const killer = killTree || ((target) => defaultKillTree(target, { spawnImpl }));
          try { await killer(child, { reason }); } catch { /* cancellation remains fail-closed */ }
        }
      });
      return cancelling;
    };

    const cancel = async (reason = "cancelled") => {
      await terminate(reason);
      rejectResult?.(processError("EXPLORATION_VISION_CANCELLED", "provider analysis was cancelled", { status: 499 }));
    };

    const handle = { result: null, cancel };
    active.add(handle);
    const result = new Promise((resolveResult, reject) => {
      rejectResult = reject;
      if (request.signal?.aborted) {
        reject(processError("EXPLORATION_VISION_CANCELLED", "provider analysis was cancelled", { status: 499 }));
        return;
      }
      try {
        child = spawnImpl(
          config.pin.python.path,
          buildExplorationVisionProcessArgs(config, requestRoot, inputPath, resultPath),
          {
            cwd: dirname(config.pin.script.path),
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: buildExplorationVisionChildEnv(env, {
              XW_VISION_MODEL_PATH: config.pin.model.path,
              XW_VISION_MODEL_SHA256: config.pin.model.sha256 ?? "",
              XW_VISION_FRAME_SHA256: actualFrameHash,
              XW_VISION_PAGE: page,
              XW_VISION_REQUESTED_ROLE: requestedRole,
            }, {
              pythonPath: config.pin.python.path,
            }),
          },
        );
      } catch (error) {
        reject(processError("EXPLORATION_VISION_PROVIDER_SPAWN_FAILED", `provider could not start: ${error?.message || error}`));
        return;
      }

      const overflow = (kind) => {
        if (overflowKind) return;
        overflowKind = kind;
        void terminate(`${kind}-overflow`).finally(() => {
          rejectResult?.(processError("EXPLORATION_VISION_PROVIDER_OUTPUT_LIMIT", `${kind} exceeded the configured byte limit`));
        });
      };
      cleanups.push(boundedStream(child.stdout, maxBufferBytes, () => overflow("stdout")));
      cleanups.push(boundedStream(child.stderr, maxBufferBytes, () => overflow("stderr")));

      child.once("error", (error) => {
        reject(processError("EXPLORATION_VISION_PROVIDER_SPAWN_FAILED", `provider process failed: ${error?.message || error}`));
      });
      // `close` is later than `exit`: only then are stdout/stderr fully
      // drained, so a late output-limit breach cannot race a successful JSON
      // result into acceptance.
      child.once("close", (code, signalCode) => {
        if (overflowKind || cancelReason) return;
        if (code !== 0) {
          reject(processError("EXPLORATION_VISION_PROVIDER_FAILED", "provider process exited unsuccessfully", {
            details: { exitCode: code, signal: signalCode ?? null },
          }));
          return;
        }
        try {
          if (sha256(readFileSync(inputPath)) !== actualFrameHash) {
            throw processError("EXPLORATION_VISION_STAGING_DRIFT", "private frame staging changed during provider analysis", { status: 409 });
          }
          const stats = statSync(resultPath);
          if (!stats.isFile() || stats.size <= 0 || stats.size > maxBufferBytes) {
            throw processError("EXPLORATION_VISION_PROVIDER_RESULT_LIMIT", "provider result is empty or exceeds the configured byte limit");
          }
          const parsed = JSON.parse(readFileSync(resultPath, "utf8"));
          const elements = assertBoundProviderResult(parsed, {
            frameHash: actualFrameHash,
            modelHash: config.pin.model.sha256,
            page,
            requestedRole,
          });
          resolveResult(normalizeElements(elements, Number(frame.capturedAt ?? now())));
        } catch (error) {
          reject(error?.code ? error : processError("EXPLORATION_VISION_PROVIDER_RESULT_INVALID", `provider result is invalid: ${error?.message || error}`));
        }
      });

      timer = setTimeout(() => {
        void terminate("deadline").finally(() => {
          rejectResult?.(processError(
            "EXPLORATION_VISION_DEADLINE",
            `provider analysis exceeded the ${requestedDeadline}ms hard deadline`,
            { status: 504 },
          ));
        });
      }, requestedDeadline);
      timer.unref?.();

      if (request.signal) {
        abortListener = () => {
          void terminate("signal").finally(() => {
            rejectResult?.(processError("EXPLORATION_VISION_CANCELLED", "provider analysis was cancelled", { status: 499 }));
          });
        };
        request.signal.addEventListener("abort", abortListener, { once: true });
      }
    }).finally(async () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (request.signal && abortListener) request.signal.removeEventListener("abort", abortListener);
      for (const cleanup of cleanups) cleanup();
      active.delete(handle);
      safeRemoveStaging(privateStagingRoot, requestRoot);
    });
    // Prevent a cancellation request from racing an already resolved result into
    // an unhandled rejection; the result promise remains authoritative.
    handle.result = result;
    return handle;
  }

  async function analyze(request) {
    return start(request).result;
  }

  return Object.freeze({
    start,
    analyze,
    async close() {
      const handles = [...active];
      await Promise.allSettled(handles.map((handle) => handle.cancel("analyzer-close")));
      await Promise.allSettled(handles.map((handle) => handle.result));
    },
    stats() {
      return { active: active.size };
    },
  });
}
