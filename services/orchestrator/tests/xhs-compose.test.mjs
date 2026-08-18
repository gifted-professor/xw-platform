import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compileXhsComposePlan,
  loadXhsComposeCatalog,
  parseAliases,
  validateXhsComposeCatalog,
  validateXhsComposePlan,
} from "../scripts/lib/xhs-compose.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "ops", "xw-xhs-compose.mjs");

test("action catalog is a strict allowlist with visible-session Explorer scripts", () => {
  const catalog = loadXhsComposeCatalog();
  assert.deepEqual(validateXhsComposeCatalog(catalog), []);
  const explorer = catalog.actions.filter((action) => action.entry === "explorer_session");
  assert.ok(explorer.length >= 6);
  assert.ok(explorer.every((action) => action.capabilityId === "xiaowei.explorer.primitive"));
  assert.ok(explorer.every((action) => action.runner.requiresSessionFile === true));
  assert.ok(explorer.flatMap((action) => action.runner.scripts).every((script) => existsSync(join(ROOT, script))));
});

test("compiler preserves command order, pacing, aliases and bounded effects", () => {
  const plan = compileXhsComposePlan({
    goal: "03和04各跑小红书：浏览20分钟，每5分钟点赞2条，收藏1条，最后回首页",
  });
  assert.deepEqual(plan.placement.aliases, ["03", "04"]);
  assert.equal(plan.normalizedIntent.durationMinutes, 20);
  assert.equal(plan.normalizedIntent.intervalSec, 300);
  assert.deepEqual(plan.actions.map((action) => action.actionId), ["browse_feed", "like_note", "collect_note", "return_xhs_home"]);
  assert.deepEqual(plan.effectBudget.perAliasQuantities, { xhs_like: 2, xhs_collect: 1 });
  assert.equal(plan.effectBudget.aliasMultiplier, 2);
  assert.equal(plan.effectBudget.quantities.xhs_like, 4);
  assert.equal(plan.effectBudget.quantities.xhs_collect, 2);
  assert.equal(plan.effectBudget.maximumTotal, 6);
  assert.equal(plan.execution.sessionStrategy, "one_visible_session_per_alias");
  assert.equal(plan.execution.executionReady, false);
  assert.equal(plan.execution.reason, "xhs_compose_workflow_canary_required");
  assert.deepEqual(validateXhsComposePlan(plan), []);
});

test("locate-only turns social actions into a zero-effect plan", () => {
  const plan = compileXhsComposePlan({ goal: "小红书搜索“夏季穿搭”，只定位点赞和关注按钮，结束回首页" });
  assert.deepEqual(plan.actions.map((action) => action.actionId), ["search_notes", "like_note", "follow_author", "return_xhs_home"]);
  assert.equal(plan.actions[0].params.keyword, "夏季穿搭");
  assert.equal(plan.actions[1].params.locateOnly, true);
  assert.deepEqual(plan.effectBudget.quantities, { xhs_like: 0, xhs_follow: 0 });
  assert.equal(plan.effectBudget.maximumTotal, 0);
  assert.equal(plan.effectBudget.requiresConfirmation, false);
});

test("negative intents are not compiled into effects", () => {
  const plan = compileXhsComposePlan({ goal: "小红书只浏览10分钟，不点赞，不收藏，最后回首页" });
  assert.deepEqual(plan.actions.map((action) => action.actionId), ["browse_feed", "return_xhs_home"]);
  assert.equal(plan.effectBudget.maximumTotal, 0);
});

test("publish editor delegates to implemented Task while live publish remains a human gate", () => {
  const dry = compileXhsComposePlan({
    goal: "小红书填一篇标题正文和话题，停在发布页检查，然后不保存退出",
    title: "测试标题",
    body: "测试正文",
    tags: ["穿搭"],
  });
  assert.deepEqual(dry.actions.map((action) => action.actionId), ["publish_edit_dry_run"]);
  assert.equal(dry.actions[0].route, "implemented_task");
  assert.equal(dry.execution.executionReady, true);
  assert.equal(dry.effectBudget.contentPublished, 0);
  assert.equal(dry.effectBudget.draftSaved, 0);

  const live = compileXhsComposePlan({ goal: "小红书真实发布一篇笔记" });
  assert.ok(live.actions.some((action) => action.actionId === "publish_live"));
  assert.equal(live.execution.executionReady, false);
  assert.equal(live.execution.reason, "human_gate_required");
  assert.equal(live.effectBudget.contentPublished, 1);
});

test("missing search keyword is explicit and plan hash detects tampering", () => {
  const plan = compileXhsComposePlan({ goal: "小红书搜索，然后回首页" });
  assert.equal(plan.execution.planReady, false);
  assert.ok(plan.unresolved.some((item) => item.code === "SEARCH_KEYWORD_REQUIRED"));
  plan.actions[0].params.keyword = "篡改";
  assert.ok(validateXhsComposePlan(plan).some((item) => item.path === "planHash"));
});

test("alias parsing ignores action quantities", () => {
  assert.deepEqual(parseAliases("小红书点赞1条，收藏2条"), []);
  assert.deepEqual(parseAliases("设备3和4号机浏览"), ["03", "04"]);
});

test("dedicated Skill context may omit the app name but rejects another explicit app", () => {
  const plan = compileXhsComposePlan({ goal: "03和04搜索‘夏季穿搭’，只定位点赞和关注按钮" });
  assert.deepEqual(plan.placement.aliases, ["03", "04"]);
  assert.equal(plan.actions[0].params.keyword, "夏季穿搭");
  assert.throws(() => compileXhsComposePlan({ goal: "抖音搜索夏季穿搭" }), /another app/);
});

test("CLI plans source-only and execute stays fail-closed", () => {
  const preview = spawnSync(process.execPath, [CLI, "plan", "--goal", "小红书浏览10分钟，点赞1条"], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  assert.equal(preview.status, 0, preview.stdout || preview.stderr);
  const payload = JSON.parse(preview.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.sourceOnly, true);
  assert.equal(payload.plan.effectBudget.quantities.xhs_like, 1);

  const execute = spawnSync(process.execPath, [CLI, "run", "--goal", "小红书浏览10分钟", "--execute"], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  assert.equal(execute.status, 4);
  const blocked = JSON.parse(execute.stdout);
  assert.equal(blocked.reason, "xhs_compose_workflow_canary_required");
});

test("CLI validates a repository-local frozen plan", () => {
  const fixture = mkdtempSync(join(ROOT, "runtime", "plans", "xhs-compose-test-"));
  try {
    const plan = compileXhsComposePlan({ goal: "小红书观察首页" });
    const path = join(fixture, "plan.json");
    writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    const result = spawnSync(process.execPath, [CLI, "validate", "--input", path], { cwd: ROOT, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stdout || result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
