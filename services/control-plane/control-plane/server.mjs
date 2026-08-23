import { createServer } from "node:http";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { assertAuthorityHost, assertPinnedNodeVersion, createControlPlaneRuntime } from "./bootstrap.mjs";
import { ControlPlaneError, errorBody } from "./lib/errors.mjs";
import {
  acquireM6C1RuntimeOwnerLock,
  assertM6C1ControlDbIdentity,
} from "./lib/m6-c1-runtime-owner-lock.mjs";
import { ControlRouter } from "./router.mjs";

const MAX_BODY_BYTES = 1024 * 1024;

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      throw new ControlPlaneError("REQUEST_TOO_LARGE", "request exceeds 1 MiB", { status: 413 });
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ControlPlaneError("INVALID_JSON", "request body is not valid JSON");
  }
}

function sendJson(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store",
  });
  response.end(payload);
}

export function createControlServer({ router }) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const body = request.method === "POST" ? await readJsonBody(request) : undefined;
      const result = await router.handle({
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        body,
        headers: request.headers,
      });
      sendJson(response, result.status, result.body);
    } catch (error) {
      sendJson(response, error?.status || 500, errorBody(error));
    }
  });
}

export async function shutdownControlServer({ server, runtime, m6C1RuntimeOwner = null, finalRuntimeOwner = null }) {
  const runtimeOwner = m6C1RuntimeOwner ?? finalRuntimeOwner;
  const failures = [];
  const settle = async (operation) => {
    try { await operation(); } catch (error) { failures.push(error); }
  };
  // Drain in-flight HTTP work after stopping acceptance, so a concurrent start
  // cannot appear after the live-entry shutdown snapshot. Child/broker cleanup
  // then runs while the scheduler and StateStore are still available.
  if (typeof server?.close === "function") {
    await settle(() => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }));
  }
  await settle(() => runtime.m6LiveEntry?.shutdown?.() ?? Promise.resolve());
  await settle(() => runtime.control.stop());
  try {
    runtime.state.close();
  } catch (error) { failures.push(error); }
  // Never make the runtime root available to a new server/bootstrap/stager
  // when any old owner cleanup is unproven.  A retained crash lock is an
  // intentional audited-recovery boundary, not a liveness optimization.
  if (failures.length === 0) {
    await settle(() => runtimeOwner?.release?.() ?? Promise.resolve());
  }
  if (failures.length > 0) throw failures[0];
}

export function startControlPlaneScheduler(runtime) {
  if (runtime?.m6StartupRecovery?.required === true) {
    return Object.freeze({ started: false, recoveryOnly: true });
  }
  runtime.control.start();
  return Object.freeze({ started: true, recoveryOnly: false });
}

function parseArgs(argv) {
  const options = {
    command: argv[0] || "help",
    host: process.env.CONTROL_PLANE_HOST || "127.0.0.1",
    port: Number(process.env.CONTROL_PLANE_PORT || 17920),
  };
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--host") options.host = argv[++index];
    else if (argv[index] === "--port") options.port = Number(argv[++index]);
    else throw new Error(`unknown argument ${argv[index]}`);
  }
  if (options.host !== "127.0.0.1") throw new Error("control plane must bind exactly to 127.0.0.1");
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("invalid port");
  return options;
}

function normalizedFsPath(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function runtimeRootFromControlDb(controlDbPath) {
  if (typeof controlDbPath !== "string" || controlDbPath.length === 0 || !isAbsolute(controlDbPath)) return null;
  const dbPath = resolve(controlDbPath);
  const controlPlaneRoot = dirname(dbPath);
  const stateRoot = dirname(controlPlaneRoot);
  if (basename(dbPath).toLowerCase() !== "control.db"
    || basename(controlPlaneRoot).toLowerCase() !== "control-plane"
    || basename(stateRoot).toLowerCase() !== "state") {
    return null;
  }
  return dirname(stateRoot);
}

export function resolveM6C1RuntimeIdentity({ runtimeMode, runtimeRoot = null, controlDbPath = null } = {}) {
  const explicitRoot = typeof runtimeRoot === "string" && runtimeRoot.length > 0
    ? runtimeRoot
    : null;
  if (explicitRoot && !isAbsolute(explicitRoot)) {
    throw new ControlPlaneError(
      "M6_C1_RUNTIME_IDENTITY_INVALID",
      "M6-C1 runtime root must be absolute",
      { status: 503 },
    );
  }
  const dbRoot = runtimeRootFromControlDb(controlDbPath);
  const resolvedRoot = explicitRoot ? resolve(explicitRoot) : dbRoot;
  const m6Mode = runtimeMode === "QUALIFICATION_ONLY" || runtimeMode === "FINAL";
  if (m6Mode && !resolvedRoot) {
    throw new ControlPlaneError(
      "M6_C1_RUNTIME_IDENTITY_REQUIRED",
      "M6-C1 runtime mode requires an explicit runtime root or canonical control DB path",
      { status: 503 },
    );
  }
  if (resolvedRoot && typeof controlDbPath === "string" && controlDbPath.length > 0) {
    const expectedDbPath = join(resolvedRoot, "state", "control-plane", "control.db");
    if (!isAbsolute(controlDbPath)
      || normalizedFsPath(controlDbPath) !== normalizedFsPath(expectedDbPath)) {
      throw new ControlPlaneError(
        "M6_C1_RUNTIME_IDENTITY_MISMATCH",
        "M6-C1 runtime root and control DB do not identify the same runtime",
        { status: 503 },
      );
    }
  }
  return Object.freeze({
    runtimeRoot: resolvedRoot,
    controlDbPath: resolvedRoot
      ? join(resolvedRoot, "state", "control-plane", "control.db")
      : controlDbPath,
    requiresOwner: Boolean(resolvedRoot),
  });
}

export function requiresM6C1RuntimeOwner(runtimeMode, runtimeRoot = null, controlDbPath = null) {
  // FINAL/QUALIFICATION_ONLY always require the canonical runtime root.  A
  // STANDARD server explicitly bound by either root or canonical DB identity
  // must participate too; otherwise an alternate --port could open the shared
  // StateStore while stage/bootstrap incorrectly proves the default port stopped.
  return runtimeMode === "QUALIFICATION_ONLY" || runtimeMode === "FINAL"
    || (typeof runtimeRoot === "string" && runtimeRoot.length > 0)
    || runtimeRootFromControlDb(controlDbPath) !== null;
}

const DEFAULT_STARTUP_OPERATIONS = Object.freeze({
  acquireRuntimeOwner: acquireM6C1RuntimeOwnerLock,
  createRuntime: createControlPlaneRuntime,
  createRouter({ runtime, nodeId }) {
    return new ControlRouter({ ...runtime, nodeId });
  },
  createHttpServer: createControlServer,
  startScheduler: startControlPlaneScheduler,
});

export async function startControlPlaneServer({
  options,
  nodeId,
  runtimeMode,
  runtimeRoot,
  controlDbPath = null,
  startupOperations = DEFAULT_STARTUP_OPERATIONS,
} = {}) {
  const {
    acquireRuntimeOwner,
    createRuntime,
    createRouter,
    createHttpServer,
    startScheduler,
  } = startupOperations;
  if (!options || options.host !== "127.0.0.1"
    || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535
    || typeof nodeId !== "string" || nodeId.length === 0
    || [acquireRuntimeOwner, createRuntime, createRouter, createHttpServer, startScheduler]
      .some((operation) => typeof operation !== "function")) {
    throw new TypeError("invalid control-plane startup inputs");
  }
  const runtimeIdentity = resolveM6C1RuntimeIdentity({ runtimeMode, runtimeRoot, controlDbPath });
  if (runtimeIdentity.requiresOwner) {
    assertM6C1ControlDbIdentity({
      runtimeRoot: runtimeIdentity.runtimeRoot,
      controlDbPath: runtimeIdentity.controlDbPath,
      allowMissing: true,
    });
  }
  const m6C1RuntimeOwner = runtimeIdentity.requiresOwner
    ? acquireRuntimeOwner({
      runtimeRoot: runtimeIdentity.runtimeRoot,
      ownerKind: "CONTROL_PLANE_M6_C1",
    })
    : null;
  let runtime;
  let server;
  let scheduler;
  try {
    // M6-C1 ownership is acquired before createRuntime can open or migrate
    // StateStore. Stage and qualification bootstrap use the same create-only
    // owner lock while additionally occupying the control-plane port.
    runtime = createRuntime({
      nodeId,
      dbPath: runtimeIdentity.controlDbPath ?? undefined,
      m6Root: runtimeIdentity.runtimeRoot,
    });
    if (runtimeIdentity.requiresOwner) {
      assertM6C1ControlDbIdentity({
        runtimeRoot: runtimeIdentity.runtimeRoot,
        controlDbPath: runtimeIdentity.controlDbPath,
        allowMissing: false,
      });
    }
    const router = createRouter({ runtime, nodeId });
    server = createHttpServer({ router });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, resolve);
    });
    // A stage process first owns this same port and only then attempts the
    // owner lock. Rechecking the held file identity after listen closes the
    // remaining pre-listen interleaving before scheduler/resource startup.
    m6C1RuntimeOwner?.assertOwned();
    scheduler = startScheduler(runtime);
  } catch (error) {
    if (runtime) {
      try { await shutdownControlServer({ server, runtime, m6C1RuntimeOwner }); } catch {}
    }
    // createRuntime opens/migrates StateStore before all later construction
    // can finish. If it throws without returning cleanup authority, retain the
    // owner lock as a deliberate audited-recovery boundary.
    throw error;
  }
  return Object.freeze({ runtime, server, scheduler, m6C1RuntimeOwner });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command !== "serve") {
    console.log("node control-plane/server.mjs serve [--host 127.0.0.1] [--port 17920]");
    return;
  }
  const actualHost = assertAuthorityHost();
  assertPinnedNodeVersion();
  const nodeId = process.env.CONTROL_PLANE_NODE_ID || "DESKTOP-3I1EVHE";
  const { runtime, server, scheduler, m6C1RuntimeOwner } = await startControlPlaneServer({
    options,
    nodeId,
    runtimeMode: process.env.XW_M6_RUNTIME_MODE,
    runtimeRoot: process.env.XW_RUNTIME_ROOT,
    controlDbPath: process.env.CONTROL_PLANE_DB,
  });
  console.log(JSON.stringify({
    ok: true,
    authorityHost: actualHost,
    nodeId,
    host: options.host,
    port: options.port,
    api: "/control/v1/health",
    recoveryOnly: scheduler.recoveryOnly,
  }));

  let shutdownTask;
  const shutdown = () => {
    shutdownTask ??= shutdownControlServer({ server, runtime, m6C1RuntimeOwner });
    return shutdownTask;
  };
  const onSignal = () => void shutdown().then(
    () => { process.exitCode = 0; },
    (error) => {
      console.error(JSON.stringify(errorBody(error)));
      process.exitCode = 1;
    },
  );
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify(errorBody(error)));
    process.exitCode = 1;
  });
}
