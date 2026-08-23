import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { apply } from "../src/live-runtime-plugin.mjs";
import { LivePipeToolClient, validateM6LivePipeBinding } from "../src/live-pipe-client.mjs";
import { M6_LIVE_TOOL_NAMES } from "../../../services/orchestrator/scripts/lib/m6/m6-live-tool-surface.mjs";

test("live profile is separate, secret-free, exact-ten, and unqualified runtime fails closed", async () => {
  const replay = readFileSync(new URL("../profiles/replay/cordis.patch.yml", import.meta.url), "utf8");
  const live = readFileSync(new URL("../profiles/live/cordis.patch.yml", import.meta.url), "utf8");
  const manifest = JSON.parse(readFileSync(new URL("../profiles/live/model-manifest.json", import.meta.url), "utf8"));
  assert.notEqual(live, replay);
  assert.equal(new Set(M6_LIVE_TOOL_NAMES).size, 10);
  assert.equal(manifest.secretMaterialPresent, false);
  assert.equal(manifest.gateFEligible, false);
  assert.throws(() => new LivePipeToolClient({ fd: 2, binding: {} }), { code: "M6_LIVE_PIPE_REQUIRED" });
  const binding = { runId: "run:opaque", workerId: "worker:opaque", sessionId: "session:opaque", alias: "01", processRef: "process:opaque" };
  assert.deepEqual(validateM6LivePipeBinding(binding), binding);
  assert.throws(() => validateM6LivePipeBinding({ ...binding, leaseId: "lease:secret" }), { code: "M6_LIVE_PIPE_BINDING_INVALID" });
  assert.throws(() => validateM6LivePipeBinding({ ...binding, alias: "02" }), { code: "M6_LIVE_PIPE_BINDING_INVALID" });
  await assert.rejects(() => apply(), { code: "M6_LIVE_PROFILE_UNQUALIFIED" });
});
