import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  computeM6LivePipeBindingHash,
  createM6LivePipeBinding,
  validateM6LivePipeBinding,
} from "../src/live-pipe-client.mjs";
import {
  M6LiveProcessAdapter,
  createM6LiveChildEnvironment,
  validateM6LiveCredentialEnvironment,
  validateM6LiveLaunchQualification,
  validateM6LiveRuntimeEnvironment,
} from "../src/live-process-adapter.mjs";

const fixture = fileURLToPath(new URL("fixtures/live-pipe-child.mjs", import.meta.url));
const TEST_CREDENTIAL = "fixture-deepseek-api-key-never-in-receipts";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function bindingFor(name) {
  return createM6LivePipeBinding({
    runId: `run:${name}-opaque`,
    workerId: `worker:${name}-opaque`,
    sessionId: `session:${name}-opaque`,
    alias: "01",
    processRef: `process:${name}-opaque`,
    gateEpochHash: hash(`${name}:epoch`),
    generation: 7,
    purpose: "M6_4_ACTION_SMOKE",
    scenarioManifestHash: hash(`${name}:manifest`),
    liveWindowAuthorizationHash: hash(`${name}:window-auth`),
  });
}

function readJsonLine(stream, timeoutMs = 2_000) {
  return new Promise((resolvePromise, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for child JSON line"));
    }, timeoutMs);
    const onData = (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      try { resolvePromise(JSON.parse(buffer.slice(0, newline))); } catch (error) { reject(error); }
    };
    const onError = (error) => { cleanup(); reject(error); };
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("error", onError);
    };
    stream.on("data", onData);
    stream.once("error", onError);
  });
}

function makeAdapter(name, mode, handleToolCall, brokerOptions = {}, adapterOptions = {}) {
  const modelProfileHash = hash(`${name}:model-profile`);
  return new M6LiveProcessAdapter({
    command: process.execPath,
    args: [fixture, mode],
    cwd: resolve(fileURLToPath(new URL("..", import.meta.url))),
    binding: bindingFor(name),
    executionClass: "TEST_FIXTURE",
    runtimeEnv: {
      XW_M6_LIVE_PROVIDER_BASE_URL: "https://provider.invalid/v1",
      XW_M6_LIVE_MODEL_PROFILE_HASH: modelProfileHash,
      XW_M6_LIVE_MODEL_PROFILE_ROOT: resolve(fileURLToPath(new URL("../.runtime/live-model-qualification-test", import.meta.url))),
      XW_DSH_PERSISTENCE_ROOT: resolve(fileURLToPath(new URL("../.runtime/live-test", import.meta.url))),
    },
    credentialEnv: { DEEPSEEK_API_KEY: TEST_CREDENTIAL },
    handleToolCall,
    brokerOptions,
    terminationOptions: {
      timeouts: { gracefulExitMs: 500, termExitMs: 500, treeKillMs: 1_000 },
    },
    ...adapterOptions,
  });
}

test("live FD3 binding is exact, self-hashed, and excludes raw authority", () => {
  const binding = bindingFor("binding");
  assert.equal(binding.bindingHash, computeM6LivePipeBindingHash(binding));
  assert.deepEqual(validateM6LivePipeBinding(binding), binding);
  assert.throws(() => validateM6LivePipeBinding({ ...binding, generation: 8 }), { code: "M6_LIVE_PIPE_BINDING_HASH_INVALID" });
  assert.throws(() => validateM6LivePipeBinding({ ...binding, leaseId: "lease:forbidden" }), { code: "M6_LIVE_PIPE_BINDING_INVALID" });
  assert.throws(() => validateM6LiveLaunchQualification("PRODUCTION"), { code: "M6_LIVE_PROFILE_UNQUALIFIED" });
  assert.deepEqual(validateM6LiveLaunchQualification("TEST_FIXTURE"), {
    executionClass: "TEST_FIXTURE",
    qualificationStatus: "NOT_EVALUATED_TEST_FIXTURE",
    modelProfileHash: null,
  });
  const env = createM6LiveChildEnvironment({ sourceEnv: { PATH: process.env.PATH, XW_M6_BROKER_TOKEN: "forbidden", ANDROID_SERIAL: "forbidden" }, binding });
  assert.equal(env.XW_M6_BROKER_TOKEN, undefined);
  assert.equal(env.ANDROID_SERIAL, undefined);
  assert.equal(env.XW_M6_BROKER_FD, "3");
  assert.throws(() => validateM6LiveRuntimeEnvironment({ XW_M6_LIVE_PROVIDER_BASE_URL: "https://provider.invalid" }), { code: "M6_LIVE_RUNTIME_ENV_INVALID" });
  assert.throws(() => validateM6LiveCredentialEnvironment({ DEEPSEEK_API_KEY: TEST_CREDENTIAL, EXTRA_TOKEN: "forbidden" }), { code: "M6_LIVE_CREDENTIAL_ENV_INVALID" });
});

test("real child completes a validated live tool call over its sole FD3 broker pipe", async (t) => {
  const calls = [];
  const adapter = makeAdapter("happy", "happy", async (call) => {
    calls.push(call);
    return { externalEffect: false, actionCount: 0, frameRef: "frame:opaque" };
  });
  t.after(async () => { if (adapter.launched) await adapter.close().catch(() => {}); });
  const live = adapter.launch();
  const childLine = readJsonLine(live.processRef.child.stdout);
  const ready = await live.ready;
  const output = await childLine;
  assert.equal(ready.toolNames.length, 10);
  assert.deepEqual(output, {
    mode: "happy", ok: true, forbiddenEnvKey: null, runtimeEnvPresent: true, credentialPresent: true, bindingHash: live.bindingHash,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "phone_observe");
  assert.deepEqual(calls[0].params, { runRef: "run:opaque", stepRef: "step:opaque" });
  const second = makeAdapter("happy", "happy", async () => ({ externalEffect: false, actionCount: 0, frameRef: "frame:opaque" }));
  assert.throws(() => second.launch(), { code: "M6_LIVE_RUN_PROCESS_EXISTS" });
  const receipt = await live.close();
  assert.equal(receipt.qualificationStatus, "NOT_EVALUATED_TEST_FIXTURE");
  assert.equal(receipt.broker.failureCode, null);
  assert.equal(receipt.broker.callCount, 1);
  assert.equal(receipt.process.verifiedClosed, true);
  assert.equal(receipt.verifiedClosed, true);
  assert.equal(JSON.stringify(receipt).includes(TEST_CREDENTIAL), false);
});

test("real child nonce replay fails closed after one dispatch and cleans up the process", async (t) => {
  let dispatches = 0;
  const adapter = makeAdapter("replay", "replay", async () => {
    dispatches += 1;
    return { externalEffect: false, actionCount: 0, frameRef: "frame:opaque" };
  });
  t.after(async () => { if (adapter.launched) await adapter.close().catch(() => {}); });
  const live = adapter.launch();
  const childLine = readJsonLine(live.processRef.child.stdout);
  await live.ready;
  const brokerReceipt = await live.broker.closed;
  const output = await childLine;
  const closeReceipt = await adapter.close();
  assert.equal(output.rejected, "M6_LIVE_BROKER_NONCE_REPLAY");
  assert.equal(dispatches, 1);
  assert.equal(brokerReceipt.failureCode, "M6_LIVE_BROKER_NONCE_REPLAY");
  assert.equal(closeReceipt.verifiedClosed, true);
});

test("real process fatal cleanup waits for the owner generation-fence drain barrier", async (t) => {
  let releaseBarrier;
  let reportFatal;
  const barrier = new Promise((resolveBarrier) => { releaseBarrier = resolveBarrier; });
  const fatalReported = new Promise((resolveFatal) => { reportFatal = resolveFatal; });
  const adapter = makeAdapter(
    "fatal-barrier",
    "timeout",
    () => new Promise(() => {}),
    { toolTimeoutMs: 30 },
    {
      onFatal(error) {
        reportFatal(error);
        return barrier;
      },
    },
  );
  t.after(async () => { if (adapter.launched) { releaseBarrier(); await adapter.close().catch(() => {}); } });
  const live = adapter.launch();
  live.processRef.child.stdout.resume();
  live.processRef.child.stderr.resume();
  await live.ready;
  const fatal = await fatalReported;
  assert.equal(fatal.code, "M6_LIVE_BROKER_TOOL_TIMEOUT");
  let closeSettled = false;
  const closePromise = adapter.close().finally(() => { closeSettled = true; });
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  assert.equal(closeSettled, false, "process cleanup must not outrun the owner handler-drain barrier");
  releaseBarrier();
  const receipt = await closePromise;
  assert.equal(receipt.broker.failureCode, "M6_LIVE_BROKER_TOOL_TIMEOUT");
  assert.equal(receipt.verifiedClosed, true);
});

test("tool timeout aborts the handler signal before the real child is force-cleaned", async (t) => {
  let signalAborted = false;
  let lateEffects = 0;
  const adapter = makeAdapter("timeout-signal", "timeout", ({ signal }) => new Promise((resolve) => {
    signal.addEventListener("abort", () => {
      signalAborted = true;
      setImmediate(() => {
        if (!signal.aborted) lateEffects += 1;
      });
      resolve({ externalEffect: false, actionCount: 0, frameRef: "frame:opaque" });
    }, { once: true });
  }), { toolTimeoutMs: 30 });
  t.after(async () => { if (adapter.launched) await adapter.close().catch(() => {}); });
  const live = adapter.launch();
  live.processRef.child.stdout.resume();
  live.processRef.child.stderr.resume();
  await live.ready;
  const brokerReceipt = await live.broker.closed;
  const closeReceipt = await adapter.close();
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  assert.equal(signalAborted, true);
  assert.equal(lateEffects, 0);
  assert.equal(brokerReceipt.failureCode, "M6_LIVE_BROKER_TOOL_TIMEOUT");
  assert.equal(closeReceipt.process.verifiedClosed, true);
  assert.equal(closeReceipt.verifiedClosed, true);
});

for (const scenario of [
  { mode: "partial", expected: "M6_LIVE_BROKER_INCOMPLETE_TIMEOUT", options: { helloTimeoutMs: 500, incompleteLineTimeoutMs: 50 } },
  { mode: "oversize", expected: "M6_LIVE_BROKER_LINE_LIMIT", options: { maxLineBytes: 1_024 } },
  { mode: "timeout", expected: "M6_LIVE_BROKER_TOOL_TIMEOUT", options: { toolTimeoutMs: 50 } },
  { mode: "handler-error", expected: "M6_LIVE_BROKER_HANDLER_FAILED", options: {} },
]) {
  test(`real child ${scenario.mode} broker failure is bounded and process-clean`, async (t) => {
    const handler = scenario.mode === "timeout"
      ? () => new Promise(() => {})
      : scenario.mode === "handler-error"
        ? () => { throw new Error(TEST_CREDENTIAL); }
        : async () => ({ externalEffect: false, actionCount: 0, frameRef: "frame:opaque" });
    const adapter = makeAdapter(scenario.mode, scenario.mode, handler, scenario.options);
    t.after(async () => { if (adapter.launched) await adapter.close().catch(() => {}); });
    const live = adapter.launch();
    live.processRef.child.stdout.resume();
    live.processRef.child.stderr.resume();
    if (scenario.mode === "partial" || scenario.mode === "oversize") {
      await assert.rejects(live.ready, { code: scenario.expected });
    } else {
      await live.ready;
    }
    const brokerReceipt = await live.broker.closed;
    const closeReceipt = await adapter.close();
    assert.equal(brokerReceipt.failureCode, scenario.expected);
    assert.equal(closeReceipt.process.verifiedClosed, true);
    assert.equal(closeReceipt.verifiedClosed, true);
    assert.equal(JSON.stringify(closeReceipt).includes(TEST_CREDENTIAL), false);
    assert.equal((live.broker.failure?.message ?? "").includes(TEST_CREDENTIAL), false);
  });
}
