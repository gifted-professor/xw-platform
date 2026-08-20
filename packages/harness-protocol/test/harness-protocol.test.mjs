import assert from "node:assert/strict";
import test from "node:test";

import { DshXwAdapter, DSH_XW_FORBIDDEN } from "../../../integrations/dsh-xw/plugin.mjs";
import { loadSkillFixtureSpec } from "../../kernel/lib/skill-runtime.mjs";
import { loadRuntimeProfile } from "../../kernel/lib/runtime-profile.mjs";
import {
  HARNESS_METHODS,
  assertAdapterConformance,
  loadDshLock,
} from "../lib/protocol.mjs";
import { ReferenceHarnessAdapter } from "../lib/reference-adapter.mjs";

function adapters() {
  return [
    ["reference", new ReferenceHarnessAdapter({ now: () => 1 })],
    ["dsh-xw", new DshXwAdapter({ now: () => 1 })],
  ];
}

test("legacy_compat keeps DSH and Open Action live closed", () => {
  const profile = loadRuntimeProfile("legacy_compat");
  assert.equal(profile.dshEnabled, false);
  assert.equal(profile.openActionLiveEnabled, false);
});

test("DSH lock is exact commit, not master/latest", () => {
  const lock = loadDshLock();
  assert.equal(lock.version, "0.1.0-rc.7");
  assert.equal(lock.commit, "99f6f02fecdb7dff40c3fbc9470f5907c29f74ca");
  assert.equal(lock.follow, "exact-commit");
  assert.ok(lock.forbidden.includes("latest"));
});

test("both adapters implement the same harness methods and forbid kernel surfaces", () => {
  for (const [, adapter] of adapters()) {
    const r = assertAdapterConformance(adapter);
    assert.equal(r.ok, true);
    assert.deepEqual(r.methods, [...HARNESS_METHODS]);
  }
  for (const name of DSH_XW_FORBIDDEN) {
    const adapter = new DshXwAdapter({ now: () => 1 });
    assert.throws(() => adapter.invokeTool("missing", name), { code: "HARNESS_TOOL_FORBIDDEN" });
  }
});

test("DSH adapter and reference harness run the same skill fixture", () => {
  for (const [, adapter] of adapters()) {
    const session = adapter.createSession();
    const run = adapter.submitGoal({
      harnessSessionId: session.harnessSessionId,
      spec: loadSkillFixtureSpec(),
      ids: { traceId: `tr-${session.harness}` },
    });
    assert.equal(run.state, "RUNNING");
    adapter.checkpoint({ harnessSessionId: session.harnessSessionId });
    const done = adapter.invokeTool(session.harnessSessionId, "xw_skill_complete", { reason: "ok" });
    assert.equal(done.exit, "COMPLETED");
    const trace = adapter.queryTrace({ harnessSessionId: session.harnessSessionId });
    assert.ok(trace.xwEvents.some((event) => event.type === "xw/skill-started"));
    adapter.close({ harnessSessionId: session.harnessSessionId });
  }
});
