import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runJsonCommand } from "../control-plane/lib/command-runner.mjs";

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
