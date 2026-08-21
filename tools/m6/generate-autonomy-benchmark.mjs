#!/usr/bin/env node
/**
 * M6-0 autonomy benchmark generator (deterministic).
 * Writes services/orchestrator/contracts/m6/autonomy-benchmark.v1.json.
 * All tasks are non-redline; every entry expects full in-scope autonomy
 * (expectedAutonomous=true) under a task-scoped AutonomyGrant.
 *
 * Usage: node tools/m6/generate-autonomy-benchmark.mjs [--check]
 *   --check  verify the on-disk file matches this generator's output.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(REPO_ROOT, "services/orchestrator/contracts/m6/autonomy-benchmark.v1.json");

const REPLAY = "replay";
const AUTH = "authorized_test_account";

// family -> [count, apps, intent templates]. Intents must never name payment/delete semantics.
const FAMILIES = [
  ["app-launch", 12, ["xiaohongshu", "wechat", "douyin", "xianyu", "system-settings", "gallery"], [
    "从桌面启动 {app} 并等待首页可交互",
    "冷启动 {app} 后定位首页搜索入口",
  ], REPLAY],
  ["app-switch", 10, ["xiaohongshu", "wechat", "douyin", "xianyu"], [
    "从 {app} 切到最近任务再切回，确认页面状态保持",
    "在 {app} 与系统桌面之间往返切换并恢复前台",
  ], REPLAY],
  ["search", 14, ["xiaohongshu", "douyin", "xianyu", "wechat"], [
    "在 {app} 搜索框输入给定关键词并打开结果列表",
    "在 {app} 搜索结果中按筛选条件浏览并定位首个非广告条目",
  ], REPLAY],
  ["text-input", 12, ["xiaohongshu", "wechat", "xianyu"], [
    "在 {app} 输入框键入指定文本并校验回显",
    "在 {app} 输入后逐字修正错别字并确认最终内容",
  ], REPLAY],
  ["scroll", 12, ["xiaohongshu", "douyin", "xianyu", "wechat"], [
    "在 {app} 列表匀速下滑指定屏数并记录可见条目",
    "在 {app} 长页面滚动到底部后回到顶部",
  ], REPLAY],
  ["tab-back", 10, ["xiaohongshu", "douyin", "xianyu", "system-settings"], [
    "在 {app} 底部 tab 之间依次切换并核对选中态",
    "进入 {app} 二级页面后逐级返回首页",
  ], REPLAY],
  ["form-edit", 10, ["xianyu", "wechat", "xiaohongshu"], [
    "在 {app} 编辑表单字段、保存草稿并核对持久化",
    "在 {app} 表单中切换选项控件并确认状态变更",
  ], REPLAY],
  ["settings-nav", 10, ["system-settings"], [
    "在系统设置中进入指定子页面并读取开关状态",
    "在系统设置中切换非破坏性显示/音量类开关并恢复初值",
  ], REPLAY],
  ["social-publish-account", 12, ["xiaohongshu", "douyin", "wechat"], [
    "用授权测试账号在 {app} 发布一条预置文本笔记并随后核验可见",
    "用授权测试账号在 {app} 对指定内容点赞/收藏并按任务要求核验",
    "用授权测试账号在 {app} 关注指定测试账号并核对列表",
    "用授权测试账号在 {app} 编辑个人资料签名并恢复",
  ], AUTH],
];

export function buildBenchmark() {
  const tasks = [];
  for (const [family, count, apps, intents, scenario] of FAMILIES) {
    for (let i = 0; i < count; i += 1) {
      const app = apps[i % apps.length];
      const intent = intents[i % intents.length].replace("{app}", app);
      tasks.push({
        id: `m6-bench-${family}-${String(i + 1).padStart(2, "0")}`,
        app,
        actionFamily: family,
        intent,
        scenario,
        expectedAutonomous: true,
      });
    }
  }
  return {
    schemaId: "xw.autonomy-benchmark.v1",
    schemaVersion: 1,
    generatedAt: "2026-08-21T00:00:00Z",
    generatedBy: "tools/m6/generate-autonomy-benchmark.mjs (deterministic)",
    countingRules: {
      midRunHumanIntervention: {
        definition: "任务授权编译完成、WorkerRun 启动之后，到任务终态之间发生的任何人工介入次数：包括 WAIT_HUMAN 被人工应答、人工接管设备、人工补充确认。任务开始前的一次性任务授权（AutonomyGrant 签发）不计入。",
        unit: "interventions per task run",
        budget: "非红线任务集中 <10% 的任务允许发生中途人工介入（任务书 §9.3 / §12.9）",
      },
      perActionApproval: {
        definition: "正常路径上每次 action dispatch 前要求人工逐步审批/点确认的次数。grant 范围内自主执行的动作不产生审批；仅 hard stop、范围扩张或恢复预算耗尽触发的 WAIT_HUMAN 计入 midRunHumanIntervention 而非本项。",
        unit: "approval prompts per action",
        budget: "正常路径必须为 0（任务书 §1.8 / §9.3）",
      },
    },
    tasks,
  };
}

function main() {
  const benchmark = buildBenchmark();
  const serialized = `${JSON.stringify(benchmark, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    const current = readFileSync(OUT, "utf8");
    if (current !== serialized) {
      process.stdout.write("AUTONOMY_BENCHMARK_DRIFT: run node tools/m6/generate-autonomy-benchmark.mjs\n");
      process.exit(1);
    }
    process.stdout.write(`AUTONOMY_BENCHMARK_OK tasks=${benchmark.tasks.length}\n`);
    return;
  }
  writeFileSync(OUT, serialized);
  process.stdout.write(`AUTONOMY_BENCHMARK_WRITTEN ${OUT} tasks=${benchmark.tasks.length}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
