import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "normal";

if (mode === "tree") {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  process.stderr.write(`GRANDCHILD ${grandchild.pid}\n`);
  setInterval(() => {}, 1000);
} else {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const request = JSON.parse(line);
    if (mode === "stall") continue;
    if (mode === "stderr") {
      process.stderr.write("e".repeat(4096));
      continue;
    }
    if (mode === "stdout") {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session.event", params: { payload: "x".repeat(4096) } })}\n`);
      continue;
    }
    if (mode === "duplicate-notification") {
      const notification = `${JSON.stringify({ jsonrpc: "2.0", method: "session.status", params: { sessionId: "s1", status: "running" } })}\n`;
      process.stdout.write(notification);
      process.stdout.write(notification);
      continue;
    }
    if (mode === "child-request") {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 99, method: "host/doThing", params: {} })}\n`);
      continue;
    }
    if (mode === "unknown-id") {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id + 100, result: {} })}\n`);
      continue;
    }
    const result = request.method === "initialize"
      ? { serverInfo: { name: "fake", version: "1" } }
      : request.method === "session/prompt"
        ? { messageId: "message-1" }
        : {};
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    if (mode === "duplicate-response") process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    if (request.method === "session/prompt") {
      if (mode !== "no-idle") process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session.status", params: { sessionId: request.params.sessionId, status: "idle" } })}\n`);
    }
    if (request.method === "shutdown") process.exit(0);
  }
}
