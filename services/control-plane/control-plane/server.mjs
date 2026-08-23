import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { assertAuthorityHost, assertPinnedNodeVersion, createControlPlaneRuntime } from "./bootstrap.mjs";
import { ControlPlaneError, errorBody } from "./lib/errors.mjs";
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

export async function shutdownControlServer({ server, runtime }) {
  const failures = [];
  const settle = async (operation) => {
    try { await operation(); } catch (error) { failures.push(error); }
  };
  // Drain in-flight HTTP work after stopping acceptance, so a concurrent start
  // cannot appear after the live-entry shutdown snapshot. Child/broker cleanup
  // then runs while the scheduler and StateStore are still available.
  await settle(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await settle(() => runtime.m6LiveEntry?.shutdown?.() ?? Promise.resolve());
  await settle(() => runtime.control.stop());
  try {
    runtime.state.close();
  } catch (error) { failures.push(error); }
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

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command !== "serve") {
    console.log("node control-plane/server.mjs serve [--host 127.0.0.1] [--port 17920]");
    return;
  }
  const actualHost = assertAuthorityHost();
  assertPinnedNodeVersion();
  const nodeId = process.env.CONTROL_PLANE_NODE_ID || "DESKTOP-3I1EVHE";
  const runtime = createControlPlaneRuntime({ nodeId });
  const router = new ControlRouter({ ...runtime, nodeId });
  const server = createControlServer({ router });
  const scheduler = startControlPlaneScheduler(runtime);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
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
    shutdownTask ??= shutdownControlServer({ server, runtime });
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
