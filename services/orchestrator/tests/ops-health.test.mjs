import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyRunResult,
  deriveStepDurations,
  loadOpsHealthInputs,
  matchCommand,
  redactAmounts,
  scoreCommands,
  DEFAULT_TUNABLES,
} from "../scripts/lib/ops-health.mjs";

const NOW = Date.parse("2026-08-13T12:00:00.000Z");

function closeout({ status = "completed", checks = [{ id: "c1", status: "pass" }], startedAt, endedAt } = {}) {
  return {
    closure: { status, blockers: [] },
    checks,
    startedAt: startedAt || "2026-08-13T11:00:00.000Z",
    endedAt: endedAt || "2026-08-13T11:10:00.000Z",
    artifacts: [],
  };
}

test("UUID taskId never matches a template id", () => {
  const hit = matchCommand(null, { taskId: "task_70c7eb03-ee12-4d4b-b8ea-663df375edbc" }, []);
  assert.equal(hit.commandId, "_unmapped");
});

test("goal prefix matches messages and xianyu; keyword balance does not", () => {
  assert.equal(matchCommand("小红书消息页未读只读检查（/xw messages）", {}, []).commandId, "messages");
  assert.equal(matchCommand("四机打开小红书消息页并查看有无新消息", {}, []).commandId, "messages");
  assert.equal(matchCommand("青岛飞书商品资料与图片上架闲鱼（发布前停页确认）", {}, []).commandId, "xianyu-idle");
  assert.equal(matchCommand("收口 /xw skills、task 与 balance 正式入口", {}, []).commandId, "_unmapped");
});

test("parent goal wins over child commandOrRef", () => {
  const hit = matchCommand(
    "三平台账户余额只读（单 Task、单 closeout）",
    {},
    [{ commandOrRef: "ops/xw-weigou-balance.mjs", status: "ok" }],
  );
  assert.equal(hit.commandId, "balance");
  assert.equal(hit.phase, "goal");
});

test("completed with zero or unverified checks is not success", () => {
  assert.equal(classifyRunResult(closeout({ checks: [] })), "unverified");
  assert.equal(classifyRunResult(closeout({ checks: [{ id: "c1", status: "unverified" }] })), "unverified");
  assert.equal(classifyRunResult(closeout({ checks: [{ id: "c1", status: "not_run" }] })), "unverified");
  assert.equal(classifyRunResult(closeout({ checks: [{ id: "c1", status: "pass" }] })), "success");
});

test("step duration uses completion timestamps not endedAt-last.ts", () => {
  const steps = deriveStepDurations([
    { stepId: "a", ts: "2026-08-13T02:21:20.993Z", status: "ok" },
    { stepId: "b", ts: "2026-08-13T02:24:44.412Z", status: "ok" },
  ], "2026-08-13T02:13:06.897Z");
  assert.equal(steps[0].durationSource, "completion_minus_prev");
  assert.ok(Math.abs(steps[0].durationMs - 494096) < 5);
  assert.ok(Math.abs(steps[1].durationMs - 203419) < 5);
});

test("scoreCommands requires nowMs and treats live explore leftover as unobserved", () => {
  assert.throws(() => scoreCommands({ harvests: [], openWork: [], sessions: [] }, DEFAULT_TUNABLES, {}), /nowMs/);
  const scored = scoreCommands({
    harvests: [],
    openWork: [],
    sessions: [{
      name: "02.json",
      expiresAt: "2026-08-13T13:00:00.000Z",
      mtimeMs: NOW,
    }],
    stall: { ok: false, source: "unavailable", rows: [] },
    catalog: { templates: [], workflows: [] },
    sources: {},
  }, DEFAULT_TUNABLES, { nowMs: NOW });
  const explore = scored.commands.find((item) => item.commandId === "explore");
  assert.equal(explore.observed, "unobserved");
  assert.ok(explore.reasons.includes("active_or_unreleased_insufficient_cross_evidence"));
  assert.equal(scored.sessions.liveExplore.length, 1);
});

test("foreign wechat-balance session is not attributed to explore", () => {
  const scored = scoreCommands({
    harvests: [],
    openWork: [],
    sessions: [{
      name: "wechat-balance-02.json",
      expiresAt: "2026-08-13T13:00:00.000Z",
      mtimeMs: NOW,
    }],
    stall: { ok: false, source: "unavailable", rows: [] },
    catalog: { templates: [], workflows: [] },
    sources: {},
  }, DEFAULT_TUNABLES, { nowMs: NOW });
  assert.equal(scored.sessions.liveExplore.length, 0);
  assert.equal(scored.sessions.liveForeign.length, 1);
});

test("weigou without commandOrRef stays unobserved; with ref scores child only", () => {
  const parent = {
    runId: "run_balance_parent",
    closed: true,
    task: { goal: "三平台账户余额只读（单 Task、单 closeout）" },
    closeout: closeout(),
    steps: [{ stepId: "wechat", title: "wechat", status: "ok" }],
  };
  const scored = scoreCommands({
    harvests: [parent],
    openWork: [],
    sessions: [],
    stall: { ok: false, source: "unavailable", rows: [] },
    catalog: { templates: [{ templateId: "task.balance.read-all", revision: 1, status: "draft" }], workflows: [] },
    sources: {},
  }, DEFAULT_TUNABLES, { nowMs: NOW });
  assert.equal(scored.commands.find((item) => item.commandId === "weigou-balance").counts.samples, 0);
  const withRef = {
    ...parent,
    runId: "run_balance_child",
    steps: [{ stepId: "wg", commandOrRef: "ops/xw-weigou-balance.mjs", status: "ok", ts: "2026-08-13T11:05:00.000Z" }],
  };
  const scored2 = scoreCommands({
    harvests: [withRef],
    openWork: [],
    sessions: [],
    stall: { ok: false, source: "unavailable", rows: [] },
    catalog: { templates: [{ templateId: "task.balance.read-all", revision: 1, status: "draft" }], workflows: [] },
    sources: {},
  }, DEFAULT_TUNABLES, { nowMs: NOW });
  assert.equal(scored2.commands.find((item) => item.commandId === "balance").commandId, "balance");
  assert.equal(scored2.commands.find((item) => item.commandId === "weigou-balance").counts.samples, 1);
});

test("zero harvest is unobserved; thin fails are flaky; clock expires window", () => {
  const empty = scoreCommands({
    harvests: [], openWork: [], sessions: [], stall: { rows: [] }, catalog: { templates: [], workflows: [] }, sources: {},
  }, DEFAULT_TUNABLES, { nowMs: NOW });
  assert.equal(empty.commands.find((item) => item.commandId === "messages").observed, "unobserved");

  const fails = [0, 1].map((i) => ({
    runId: `run_fail_${i}`,
    closed: true,
    task: { goal: "小红书消息页未读只读检查（/xw messages）" },
    closeout: closeout({ status: "partial", endedAt: `2026-08-13T11:0${i}:00.000Z` }),
    steps: [],
  }));
  const flaky = scoreCommands({
    harvests: fails, openWork: [], sessions: [], stall: { rows: [] }, catalog: { templates: [], workflows: [] }, sources: {},
  }, DEFAULT_TUNABLES, { nowMs: NOW });
  assert.equal(flaky.commands.find((item) => item.commandId === "messages").observed, "flaky");

  const old = scoreCommands({
    harvests: fails, openWork: [], sessions: [], stall: { rows: [] }, catalog: { templates: [], workflows: [] }, sources: {},
  }, DEFAULT_TUNABLES, { nowMs: Date.parse("2026-09-10T00:00:00.000Z") });
  assert.equal(old.commands.find((item) => item.commandId === "messages").observed, "unobserved");
});

test("redactAmounts only replaces currency text and exact amount keys", () => {
  const out = redactAmounts({
    notes: "wallet ¥12.34 and display stays a word",
    nested: { balanceCny: "1810.68", other: "ok" },
  });
  assert.equal(out.notes.includes("¥12.34"), false);
  assert.equal(out.notes.includes("display"), true);
  assert.equal(out.nested.balanceCny, "<redacted-amount>");
  assert.equal(out.nested.other, "ok");
});

test("loadOpsHealthInputs is harvest-first and never reads decoys inside a run dir", () => {
  const root = mkdtempSync(join(tmpdir(), "ops-health-"));
  try {
    const runId = "run_abc123-aaaa-bbbb-cccc-ddddeeee0001";
    mkdirSync(join(root, "outbox", "harvest", runId), { recursive: true });
    mkdirSync(join(root, "outbox", "work", runId), { recursive: true });
    writeFileSync(join(root, "outbox", "harvest", runId, "closeout.v1.json"), JSON.stringify(closeout({
      status: "completed",
    })));
    writeFileSync(join(root, "outbox", "work", runId, "task.json"), JSON.stringify({
      goal: "四机打开小红书消息页并查看有无新消息",
      taskId: "task_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    }));
    writeFileSync(join(root, "outbox", "work", runId, "secret.mjs"), "throw new Error('should not be read')");
    writeFileSync(join(root, "outbox", "work", runId, "wechat-balance-result.json"), JSON.stringify({ balanceCny: "999" }));
    const inputs = loadOpsHealthInputs(root, {
      sessionsRoot: join(root, "sessions"),
      dbPath: join(root, "missing.db"),
    });
    assert.equal(inputs.harvests.length, 1);
    assert.equal(inputs.harvests[0].task.goal.includes("消息"), true);
    assert.equal(inputs.stall.source, "unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
