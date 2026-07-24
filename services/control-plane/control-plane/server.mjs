import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { assertAuthorityHost, assertPinnedNodeVersion, createControlPlaneRuntime } from "./bootstrap.mjs";
import { errorBody } from "./lib/errors.mjs";
import { ControlRouter } from "./router.mjs";

const MAX_BODY_BYTES = 1024 * 1024;

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      const error = new Error("request exceeds 1 MiB");
      error.code = "REQUEST_TOO_LARGE";
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
      sendJson(response, error?.status || (error instanceof SyntaxError ? 400 : 500), errorBody(error));
    }
  });
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
  const runtime = createControlPlaneRuntime();
  const nodeId = process.env.CONTROL_PLANE_NODE_ID || "DESKTOP-3I1EVHE";
  const router = new ControlRouter({ ...runtime, nodeId });
  const server = createControlServer({ router });
  runtime.control.start();
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
  }));

  const shutdown = async () => {
    server.close();
    await runtime.control.stop();
    runtime.state.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => { process.exitCode = 0; }));
  process.once("SIGTERM", () => void shutdown().finally(() => { process.exitCode = 0; }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify(errorBody(error)));
    process.exitCode = 1;
  });
}
