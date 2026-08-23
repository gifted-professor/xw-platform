import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DshXwProcessAdapter } from "../src/process-adapter.mjs";

for (const [route, expectedVerdict, expectedCalls] of [
  ["replan", "REPLAN", ["worker_start", "phone_observe", "phone_ground", "trace_query", "worker_complete"]],
  ["hardstop", "HARD_STOP", ["worker_start", "phone_observe", "phone_ground", "trace_query", "worker_complete"]],
  ["wait", undefined, ["worker_start", "wait_human", "worker_complete"]],
]) test(`real ${route} route remains replay-only and omits synthetic act`, { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), `xw-m6-3-${route}-`));
  const harness = new DshXwProcessAdapter({ persistenceRoot: join(root, "sessions"), replayRoot: join(root, "replay") }).createHarness();
  try {
    const result = await harness.run(`run ${route} replay`, { sessionId: `session-${route}-0001` });
    const calls = result.events.filter((event) => event.type === "assistant/message")
      .flatMap((event) => event.data?.message?.content ?? []).filter((block) => block.type === "tool-call").map((block) => block.name);
    assert.deepEqual(calls, expectedCalls);
    assert.equal(calls.includes("phone_act"), false);
    const resultText = result.events.filter((event) => event.type === "tool/result").map((event) => JSON.stringify(event)).join("\n");
    if (expectedVerdict) assert.match(resultText, new RegExp(expectedVerdict, "u"));
    assert.doesNotMatch(resultText, /"externalEffect":true|"actionCount":[1-9]/u);
  } finally {
    await harness.close();
  }
});
