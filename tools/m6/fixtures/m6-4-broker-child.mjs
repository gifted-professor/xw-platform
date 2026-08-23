import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";

import { M6_TOOL_NAMES } from "../../../services/orchestrator/scripts/lib/m6/m6-tool-surface.mjs";

const mode = process.env.XW_M6_BROKER_CASE || "happy";
const binding = JSON.parse(process.env.XW_M6_BROKER_BINDING || "{}");
const fd = Number(process.env.XW_M6_BROKER_FD || 3);
const input = createReadStream(null, { fd, autoClose: false });
const output = createWriteStream(null, { fd, autoClose: false });

function write(value, newline = true) {
  output.write(`${typeof value === "string" ? value : JSON.stringify(value)}${newline ? "\n" : ""}`);
}

function request(overrides = {}) {
  return {
    type: "tool_call",
    correlation: { ...binding },
    method: M6_TOOL_NAMES[0],
    nonce: `nonce-${mode}`,
    params: {},
    ...overrides,
  };
}

let buffer = "";
input.setEncoding("utf8");
input.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const newline = buffer.indexOf("\n");
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.type === "complete_ack" || message.type === "reject") {
      process.exit(message.type === "complete_ack" ? 0 : 23);
    }
  }
});

write({
  type: "hello",
  processRef: binding.processRef,
  toolNames: M6_TOOL_NAMES,
  brokerFd: fd,
  transportAuthorityPresent: false,
  rawDeviceIdentityPresent: false,
});

switch (mode) {
  case "happy":
    M6_TOOL_NAMES.forEach((method, index) => write(request({ method, nonce: `nonce-${index}` })));
    write({ type: "complete" });
    break;
  case "wrong-run":
    write(request({ correlation: { ...binding, runId: "wrong-run" } }));
    break;
  case "wrong-worker":
    write(request({ correlation: { ...binding, workerId: "wrong-worker" } }));
    break;
  case "wrong-session":
    write(request({ correlation: { ...binding, sessionId: "wrong-session" } }));
    break;
  case "wrong-alias":
    write(request({ correlation: { ...binding, alias: "99" } }));
    break;
  case "extra-method":
    write(request({ method: "phone_raw" }));
    break;
  case "replay":
    write(request({ nonce: "replayed-nonce" }));
    write(request({ nonce: "replayed-nonce" }));
    break;
  case "oversize":
    write(request({ params: { opaque: "x".repeat(70 * 1024) } }));
    break;
  case "timeout":
    write(JSON.stringify(request()), false);
    break;
  case "descendant-growth": {
    const descendant = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 250)"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    write({ type: "process_tree_growth", processRef: binding.processRef, descendantPidCorrelation: descendant.pid });
    break;
  }
  default:
    throw new Error(`unknown broker child case: ${mode}`);
}

setTimeout(() => {
  output.end();
  input.destroy();
  process.exit(mode === "timeout" ? 24 : 25);
}, 2_000).unref();
