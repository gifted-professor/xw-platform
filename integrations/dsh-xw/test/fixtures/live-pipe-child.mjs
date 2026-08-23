import assert from "node:assert/strict";
import { createReadStream, createWriteStream } from "node:fs";

import { LivePipeToolClient } from "../../src/live-pipe-client.mjs";
import { M6_LIVE_TOOL_NAMES } from "../../../../services/orchestrator/scripts/lib/m6/m6-live-tool-surface.mjs";

const mode = process.argv[2] ?? "happy";
const fd = Number(process.env.XW_M6_BROKER_FD);
const binding = JSON.parse(process.env.XW_M6_BROKER_BINDING ?? "null");
const forbiddenEnvKey = Object.keys(process.env).find((key) => /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|LEASE|ADB|SERIAL|RAW_DEVICE)/iu.test(key));
const runtimeEnvPresent = typeof process.env.XW_M6_LIVE_PROVIDER_BASE_URL === "string"
  && /^[0-9a-f]{64}$/u.test(process.env.XW_M6_LIVE_MODEL_PROFILE_HASH ?? "")
  && typeof process.env.XW_DSH_PERSISTENCE_ROOT === "string";
const credentialPresent = typeof process.env.DEEPSEEK_API_KEY === "string" && process.env.DEEPSEEK_API_KEY.length >= 8;

function writeStdout(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function waitForPipeClose(stream) {
  return new Promise((resolve) => {
    stream.once("end", resolve);
    stream.once("close", resolve);
  });
}

async function runRaw() {
  const input = createReadStream(null, { fd, autoClose: false });
  const output = createWriteStream(null, { fd, autoClose: false });
  const hello = {
    type: "hello",
    processRef: binding.processRef,
    bindingHash: binding.bindingHash,
    toolNames: M6_LIVE_TOOL_NAMES,
    brokerFd: 3,
    transportAuthorityPresent: false,
    rawDeviceIdentityPresent: false,
  };
  if (mode === "partial") {
    output.write('{"type":"hello"');
  } else if (mode === "oversize") {
    output.write(`${"x".repeat(4_096)}\n`);
  } else {
    const nonce = "123e4567-e89b-42d3-a456-426614174000";
    const call = {
      type: "tool_call",
      correlation: binding,
      method: "phone_observe",
      nonce,
      params: { runRef: "run:opaque", stepRef: "step:opaque" },
    };
    output.write(`${JSON.stringify(hello)}\n${JSON.stringify(call)}\n`);
    if (mode === "replay") output.write(`${JSON.stringify(call)}\n`);
  }
  let buffer = "";
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(raw);
        if (message.type === "reject") writeStdout({ mode, rejected: message.code });
      } catch {}
    }
  });
  await waitForPipeClose(input);
  input.destroy();
  output.destroy();
}

async function main() {
  assert.equal(fd, 3);
  assert.equal(forbiddenEnvKey, undefined, `forbidden authority environment key reached child: ${forbiddenEnvKey}`);
  assert.equal(runtimeEnvPresent, true);
  assert.equal(credentialPresent, true);
  if (mode !== "happy") {
    await runRaw();
    return;
  }
  const client = new LivePipeToolClient({ fd, binding, timeoutMs: 2_000 });
  const result = await client.call("phone_observe", { runRef: "run:opaque", stepRef: "step:opaque" });
  assert.deepEqual(result, { externalEffect: false, actionCount: 0, frameRef: "frame:opaque" });
  writeStdout({ mode, ok: true, forbiddenEnvKey: null, runtimeEnvPresent, credentialPresent, bindingHash: binding.bindingHash });
  await waitForPipeClose(client.input);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
