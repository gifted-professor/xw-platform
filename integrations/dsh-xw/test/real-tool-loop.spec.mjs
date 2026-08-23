import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { M6_TOOL_NAMES, M6_TOOL_SPEC } from "../src/replay-tools.mjs";
import { DshXwProcessAdapter } from "../src/process-adapter.mjs";
import { sha256Json } from "../src/canonical-json.mjs";

test("real SDK client drives real DSH/Cordis through all happy-route tools", { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "xw-m6-3-tool-loop-"));
  const adapter = new DshXwProcessAdapter({ persistenceRoot: join(root, "sessions"), replayRoot: join(root, "replay") });
  assert.equal(adapter.adapterKind, "dsh_cordis_process");
  const harness = adapter.createHarness();
  try {
    const result = await harness.run("run the M6-3 happy replay", { sessionId: "session-replay-0001" });
    assert.match(result.finalResponse, /happy replay complete/u);
    const toolCalls = result.events
      .filter((event) => event.type === "assistant/message")
      .flatMap((event) => event.data?.message?.content ?? [])
      .filter((block) => block.type === "tool-call")
      .map((block) => block.name);
    assert.deepEqual(toolCalls, ["worker_start", "phone_observe", "phone_ground", "phone_act", "phone_verify", "checkpoint_save", "trace_query", "worker_complete"]);

    const headers = result.events.filter((event) => event.type === "request/header");
    assert.ok(headers.length >= 1, "real DSH request/header events must be visible");
    for (const header of headers) {
      const tools = header.data?.header?.tools ?? [];
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [...M6_TOOL_NAMES].sort());
      for (const tool of tools) assert.equal(sha256Json(tool.parameters), sha256Json(M6_TOOL_SPEC[tool.name].inputSchema));
    }
  } finally {
    await harness.close();
  }
});
