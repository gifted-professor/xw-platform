import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { postJson, runJsonCommand } from "../control-plane/lib/command-runner.mjs";

test("command timeout waits for child exit before rejecting", async () => {
  let killed = false;
  const keepAlive = setTimeout(() => {}, 300);
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      killed = true;
      setTimeout(() => child.emit("exit", null), 40);
      return true;
    };
    return child;
  };
  const startedAt = Date.now();
  try {
    await assert.rejects(
      runJsonCommand("fake", [], { timeoutMs: 5, spawnImpl, timeoutExitGraceMs: 200 }),
      { code: "ADAPTER_TIMEOUT" },
    );
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(killed, true);
  assert.ok(Date.now() - startedAt >= 35);
});

test("failed JSON adapter surfaces only its bounded diagnostic code", async () => {
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end(JSON.stringify({
        ok: false,
        errorCode: "GATEWAY_DEVICE_PROBE_FAILED",
        error: "private runtime details must not escape",
      }));
      child.emit("exit", 1);
    });
    return child;
  };
  await assert.rejects(
    runJsonCommand("fake", [], { timeoutMs: 100, spawnImpl }),
    (error) => error.code === "ADAPTER_FAILED"
      && error.details?.adapterCode === "GATEWAY_DEVICE_PROBE_FAILED"
      && !JSON.stringify(error.details).includes("private runtime details"),
  );
});

test("HTTP adapter rejection preserves only bounded sanitized error diagnostics", async () => {
  const secret = "top-secret-token";
  await assert.rejects(
    postJson("http://127.0.0.1:17897/action", { action: "openFeedNote" }, {
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        async json() {
          return {
            ok: false,
            error: {
              code: "XHS_LAUNCH_FAILED",
              step: "xhsLaunchFailed",
              message: `launcher failed\nserial=REPLACE_SERIAL_02 token=${secret} Authorization: Bearer abc123`,
              stack: `private stack ${secret}`,
              serial: "REPLACE_SERIAL_02",
            },
            raw: `private body ${secret}`,
          };
        },
      }),
    }),
    (error) => {
      assert.equal(error.code, "ADAPTER_REJECTED");
      assert.deepEqual(error.details, {
        httpStatus: 500,
        adapterError: {
          code: "XHS_LAUNCH_FAILED",
          step: "xhsLaunchFailed",
          message: "launcher failed serial=[redacted] token=[redacted] authorization=[redacted]",
        },
      });
      const serialized = JSON.stringify(error.details);
      assert.doesNotMatch(serialized, /top-secret-token|REPLACE_SERIAL_02|abc123|private stack|private body/i);
      return true;
    },
  );
});

test("HTTP adapter diagnostics normalize invalid code and bound action and message", async () => {
  await assert.rejects(
    postJson("http://127.0.0.1:17897/action", {}, {
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        async json() {
          return {
            error: {
              code: "bad code!",
              action: `open feed ${"x".repeat(100)}`,
              message: `Bearer unsafe-token ${"m".repeat(300)}`,
            },
          };
        },
      }),
    }),
    (error) => {
      assert.equal(error.details.adapterError.code, "OPERATOR_ERROR");
      assert.match(error.details.adapterError.step, /^[A-Za-z0-9_.-]{1,80}$/);
      assert.equal(error.details.adapterError.step.length, 80);
      assert.equal(error.details.adapterError.message.length, 240);
      assert.doesNotMatch(JSON.stringify(error.details), /unsafe-token|bad code!|open feed/);
      return true;
    },
  );
});
