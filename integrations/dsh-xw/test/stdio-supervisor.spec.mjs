import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import { StdioSupervisor, spawnOwnedProcess, terminateOwnedProcessTree } from "../src/stdio-supervisor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const peer = join(here, "fixtures", "fake-jsonrpc-peer.mjs");

function collectLines(stream) {
  let buffer = "";
  const lines = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  return lines;
}

async function running(mode = "normal", options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const childRef = spawnOwnedProcess(process.execPath, [peer, mode]);
  const failures = [];
  const supervisor = new StdioSupervisor({
    upstreamInput: input,
    upstreamOutput: output,
    childRef,
    timeouts: { initializeMs: 250, promptAckMs: 250, idleMs: 250, shutdownResponseMs: 250, gracefulExitMs: 10, termExitMs: 2000, treeKillMs: 2000 },
    ...options,
    onFatal: (error) => failures.push(error),
  }).start();
  return { input, output, childRef, failures, supervisor, lines: collectLines(output) };
}

async function until(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("maps opaque SDK ids to monotonic child ids and preserves notifications", async () => {
  const run = await running();
  run.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "sdk-uuid", method: "session/prompt", params: { sessionId: "s1", contentBlocks: [] } })}\n`);
  await until(() => run.lines.length === 2);
  assert.equal(run.lines[0].id, "sdk-uuid");
  assert.equal(run.lines[0].result.messageId, "message-1");
  assert.deepEqual(run.lines[1].params, { sessionId: "s1", status: "idle" });
  assert.equal(run.failures.length, 0);
  await terminateOwnedProcessTree(run.childRef, { timeouts: { gracefulExitMs: 0, termExitMs: 2000, treeKillMs: 2000 } });
});

test("rejects malformed envelopes, forbidden methods, and pending overflow", async (t) => {
  for (const [label, frame, code] of [
    ["malformed", "{\n", "M6_DSH_PROTOCOL_INVALID"],
    ["method", `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "device/live", params: {} })}\n`, "M6_DSH_PROTOCOL_INVALID"],
  ]) await t.test(label, async () => {
    const run = await running();
    run.input.write(frame);
    await until(() => run.failures.length === 1);
    assert.equal(run.failures[0].code, code);
    await terminateOwnedProcessTree(run.childRef, { timeouts: { gracefulExitMs: 0, termExitMs: 2000, treeKillMs: 2000 } });
  });
});

test("rejects child requests and unknown response ids", async (t) => {
  for (const [mode, code] of [["child-request", "M6_DSH_CHILD_REQUEST_FORBIDDEN"], ["unknown-id", "M6_DSH_UNKNOWN_RESPONSE_ID"]]) {
    await t.test(mode, async () => {
      const run = await running(mode);
      run.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "x", method: "initialize", params: {} })}\n`);
      await until(() => run.failures.length === 1);
      assert.equal(run.failures[0].code, code);
      await terminateOwnedProcessTree(run.childRef, { timeouts: { gracefulExitMs: 0, termExitMs: 2000, treeKillMs: 2000 } });
    });
  }
});

test("enforces line and incomplete-buffer byte ceilings", async (t) => {
  for (const [label, payload, code] of [
    ["line", `${"x".repeat(65)}\n`, "M6_DSH_STDIO_LINE_LIMIT"],
    ["incomplete", "x".repeat(65), "M6_DSH_STDIO_LINE_LIMIT"],
  ]) await t.test(label, async () => {
    const run = await running("normal", { limits: { maxLineBytes: 64, maxIncompleteBytes: 64 } });
    run.input.write(payload);
    await until(() => run.failures.length === 1);
    assert.equal(run.failures[0].code, code);
    await terminateOwnedProcessTree(run.childRef, { timeouts: { gracefulExitMs: 0, termExitMs: 2000, treeKillMs: 2000 } });
  });
});

test("enforces pending, prompt-ack, idle, stdout and stderr budgets", async (t) => {
  await t.test("pending overflow", async () => {
    const run = await running("stall", { limits: { maxPendingRequests: 2 } });
    for (let id = 1; id <= 3; id += 1) run.input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: {} })}\n`);
    await until(() => run.failures.length === 1);
    assert.equal(run.failures[0].code, "M6_DSH_PROTOCOL_INVALID");
    await terminateOwnedProcessTree(run.childRef, { timeouts: { gracefulExitMs: 0, termExitMs: 2000, treeKillMs: 2000 } });
  });
  for (const [label, mode, method, limits, code] of [
    ["prompt ack", "stall", "session/prompt", {}, "M6_DSH_PROMPT_ACK_TIMEOUT"],
    ["idle", "no-idle", "session/prompt", {}, "M6_DSH_IDLE_TIMEOUT"],
    ["stdout", "stdout", "initialize", { maxStdoutBytes: 1000, maxLineBytes: 5000 }, "M6_DSH_STDOUT_BUDGET"],
    ["stderr", "stderr", "initialize", { maxStderrBytes: 1000 }, "M6_DSH_STDERR_BUDGET"],
  ]) await t.test(label, async () => {
    const run = await running(mode, { limits });
    const params = method === "session/prompt" ? { sessionId: "s1", contentBlocks: [] } : {};
    run.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: label, method, params })}\n`);
    await until(() => run.failures.length === 1);
    assert.equal(run.failures[0].code, code);
    await terminateOwnedProcessTree(run.childRef, { timeouts: { gracefulExitMs: 0, termExitMs: 2000, treeKillMs: 2000 } });
  });
});

test("rejects duplicate response ids", async () => {
  const run = await running("duplicate-response");
  run.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "dup", method: "initialize", params: {} })}\n`);
  await until(() => run.failures.length === 1);
  assert.equal(run.failures[0].code, "M6_DSH_DUPLICATE_RESPONSE_ID");
  await terminateOwnedProcessTree(run.childRef, { timeouts: { gracefulExitMs: 0, termExitMs: 2000, treeKillMs: 2000 } });
});

test("rejects duplicate ordered notifications", async () => {
  const run = await running("duplicate-notification");
  run.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "notification", method: "initialize", params: {} })}\n`);
  await until(() => run.failures.length === 1);
  assert.equal(run.failures[0].code, "M6_DSH_PROTOCOL_INVALID");
  await terminateOwnedProcessTree(run.childRef, { timeouts: { gracefulExitMs: 0, termExitMs: 2000, treeKillMs: 2000 } });
});
