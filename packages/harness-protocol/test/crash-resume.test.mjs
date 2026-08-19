import assert from "node:assert/strict";
import test from "node:test";

import { DshXwAdapter } from "../../../integrations/dsh-xw/plugin.mjs";
import { loadSkillFixtureSpec } from "../../kernel/lib/skill-runtime.mjs";

function boot() {
  const adapter = new DshXwAdapter({ now: () => 20 });
  const session = adapter.createSession();
  adapter.submitGoal({
    harnessSessionId: session.harnessSessionId,
    spec: loadSkillFixtureSpec(),
    ids: { traceId: "tr-crash" },
  });
  return { adapter, id: session.harnessSessionId };
}

test("tool/call without tool/result cannot auto-restore", () => {
  const { adapter, id } = boot();
  adapter.checkpoint({ harnessSessionId: id });
  adapter.invokeTool(id, "xw_phone_act", { actionId: "act-lost" });
  const snapshot = JSON.parse(JSON.stringify(adapter.serialize(id)));
  adapter.close({ harnessSessionId: id });
  const next = new DshXwAdapter({ now: () => 21 });
  assert.throws(
    () => next.restoreSession({ snapshot, reconciliation: { status: "NO_UNRESOLVED_EFFECTS" } }),
    { code: "SKILL_RECONCILIATION_REQUIRED" },
  );
});

test("XW action requested with missing response is AMBIGUOUS unless ALREADY_VERIFIED", () => {
  const { adapter, id } = boot();
  adapter.checkpoint({ harnessSessionId: id });
  adapter.invokeTool(id, "xw_phone_act", { actionId: "act-maybe" });
  const snapshot = JSON.parse(JSON.stringify(adapter.serialize(id)));
  adapter.close({ harnessSessionId: id });
  const next = new DshXwAdapter({ now: () => 22 });
  assert.throws(
    () => next.restoreSession({ snapshot, reconciliation: { status: "AMBIGUOUS_EFFECT" } }),
    { code: "SKILL_RESUME_AMBIGUOUS" },
  );
});

test("DSH flushed but XW checkpoint missing refuses resume", () => {
  const { adapter, id } = boot();
  adapter.checkpoint({ harnessSessionId: id });
  const snapshot = JSON.parse(JSON.stringify(adapter.serialize(id)));
  snapshot.xw.checkpoint = null;
  adapter.close({ harnessSessionId: id });
  const next = new DshXwAdapter({ now: () => 23 });
  assert.throws(
    () => next.restoreSession({ snapshot, reconciliation: { status: "NO_UNRESOLVED_EFFECTS" } }),
    { code: "SKILL_CHECKPOINT_MISSING" },
  );
});

test("XW checkpoint written but DSH flush incomplete refuses resume", () => {
  const { adapter, id } = boot();
  adapter.checkpoint({ harnessSessionId: id, flushDsh: false });
  adapter.invokeTool(id, "xw_phone_observe");
  const snapshot = JSON.parse(JSON.stringify(adapter.serialize(id)));
  snapshot.dshFlushedSeq = 0;
  snapshot.dshLog.push({ type: "assistant/message", at: 1 });
  adapter.close({ harnessSessionId: id });
  const next = new DshXwAdapter({ now: () => 24 });
  assert.throws(
    () => next.restoreSession({ snapshot, reconciliation: { status: "NO_UNRESOLVED_EFFECTS" } }),
    { code: "DSH_FLUSH_INCOMPLETE" },
  );
});

test("DSH version change cannot silently restore an old session", () => {
  const { adapter, id } = boot();
  adapter.checkpoint({ harnessSessionId: id });
  const snapshot = JSON.parse(JSON.stringify(adapter.serialize(id)));
  adapter.close({ harnessSessionId: id });
  const next = new DshXwAdapter({ now: () => 25 });
  assert.throws(
    () => next.restoreSession({
      snapshot,
      harnessCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      reconciliation: { status: "NO_UNRESOLVED_EFFECTS" },
    }),
    { code: "DSH_VERSION_MISMATCH" },
  );
});

test("duplicate restore of a live session is rejected; replay after close is allowed", () => {
  const { adapter, id } = boot();
  adapter.checkpoint({ harnessSessionId: id });
  const snapshot = JSON.parse(JSON.stringify(adapter.serialize(id)));
  assert.throws(
    () => adapter.restoreSession({ snapshot, reconciliation: { status: "NO_UNRESOLVED_EFFECTS" } }),
    { code: "HARNESS_SESSION_ALREADY_ACTIVE" },
  );
  adapter.close({ harnessSessionId: id });
  const restored = adapter.restoreSession({ snapshot, reconciliation: { status: "NO_UNRESOLVED_EFFECTS" } });
  assert.equal(restored.phoneActsEmitted, 0);
  assert.equal(restored.run.state, "RUNNING");
});

test("subagent exit with an open tool call is AMBIGUOUS, not a retry", () => {
  const { adapter, id } = boot();
  adapter.checkpoint({ harnessSessionId: id });
  adapter.invokeTool(id, "xw_phone_act", { actionId: "act-sub" });
  const interrupted = adapter.interrupt({ harnessSessionId: id, reason: "subagent-exit" });
  assert.equal(interrupted.state, "AMBIGUOUS");
  assert.equal(interrupted.recoveryRequired, true);
});
