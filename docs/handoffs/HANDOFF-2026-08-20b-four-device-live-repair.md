# 接手文档 — 2026-08-20b（四机真机全绿 + xw-start 迁移 + repair 链路）

> 上一篇：`HANDOFF-2026-08-20-post-m3r-m4-first-live.md`。本文补充 8-20 下午的进展，与上一篇冲突处以本文为准。

## 0. 三十秒

```text
源码分支    feat/xw-start-xw-runtime-repair（未合 main，未部署进 release）
生产运行    不变：xw-runtime\releases\xw-20260819-f337079，legacy_compat
真机        01/02/03/04 四台 xhs.observe.feed 全部 succeeded（证据在 xw-runtime\evidence\）
计划任务    XW Platform FastOperator 01-04 全部 Running（任务托管，非裸进程）
repair     新 ops/xw-repair.mjs 已实战修复 RP-0001（03 wrong_port）
/xw start   已迁到 xw-runtime，--check 全绿（ready:true）
```

## 1. 今天发生的事（按序）

1. **四机 observe 首通**：01（job_9828e22d）→ 03（job_af9db228）→ 02/04 修复后（job_a187b753 / job_7a0bb1ab）全部 succeeded，pageClass=xhs.feed.index，lease 归零。
2. **RP-0001 ADB 双 server 事故**：本机有两套效卫 Android 工具——`C:\Program Files (x86)\xiaowei_android`（serve 用，权威口 5038）和 `D:\Ksoftware\xiaowei_android`（抢 5037）。02/04 设备被 5037 认领 → serve 侧 uiautomator dump 截断 → `ADAPTER_REJECTED / hierarchy dump incomplete`。效卫 UI 与 Explorer（transport 22222）不受影响，造成"看起来全通"假象。手动修复：kill 5037 server + 重启受影响 serve。全过程已固化进 `docs/ops/repair-runbook.md` RP-0001。
   - **断根未做**：`D:\Ksoftware\xiaowei_android` 的 adb 还会复活抢设备（当天下午 03 就复发了一次）。需要查清它是哪个软件拉起的并停用/卸载。
3. **P0-2 其实已完成**：`XW Platform FastOperator 01-04` 计划任务已注册且指向 `xw-runtime\launch-fast-operator-serve.ps1`（上一篇写"待做"是过时信息）。02/04 曾被手动 Stop-Process 重启过，已收口回任务托管（Start-ScheduledTask），验证 succeeded。
4. **P0-4 大部分已完成**：`~/.agents/skills/xw` 与 `~/.codex/skills/xw` 已无旧路径引用。但 SKILL.md 自称的仓库真源 `integrations/codex/skills/xw/` **不存在**，同步器也没有——当前两份副本靠手工保持一致（SKILL.md 声明已改诚实）。
5. **xw-start.mjs 迁移**（本分支）：删光 retired 路径（xhs-routing-v1-1 / xhs-agent-control / XhsFastOperator 任务名）；任务管理改内联 cmdlet（保留"拒杀无关监听进程"保护）；releaseGate 改为 17920 health + release-manifest + 四个 serve-launch 配置三方比对 releaseId/sourceCommit + runtimeProfile=legacy_compat；rebind = 用当前 manifest 重写 serve-launch-NN.json 后重启任务；任务缺失报「请先注册 XW Platform FastOperator NN」不再装旧 XML。`--check` 严格只读，实测全绿。
6. **新 xw-repair.mjs**：`--check` 只读巡检（adb 双口分布、serve 端口+任务态、双 health releaseId、issues[]，每次运行记 `xw-runtime\logs\repair\repair-log.jsonl`）；`--fix rp-0001` 默认只打印计划并非零退出，`--confirm` 才执行（有活动 lease/job 自动拒绝）。serial→alias 从 agent-entry 动态拿。**已实战**：03 复发 wrong_port 时用它修复成功并 observe 验证。
7. **/xw skill 更新**（两份副本同步，diff 验证一致）：`/xw recover` 加入 infra 诊断/修复步骤（先 `xw-repair --check`，已知故障按 runbook，未知只报告）；balance/messages/bench/session 引用的 `ops/xw-balance.mjs`、`xw-bench.mjs`、`xw-xhs-messages.mjs`、`xw-xhs-explore-run.mjs` **脚本尚不存在**，已在 SKILL.md 对应段落标注「脚本尚未实现，本节为设计约定」。

## 2. 现场快照（2026-08-20 15:30 许）

- 17920/17930 健康，releaseId 一致；四个 serve 任务 Running，17895-17898 全 LISTEN
- adb 5038：四台设备齐全；5037 server 已被 kill（可能复活）
- `node services/orchestrator/ops/xw-start.mjs --check` → ok:true, ready:true, adbOk:true
- `node services/orchestrator/ops/xw-repair.mjs --check` → issues:[]

## 3. 下一步（更新版优先级）

1. **断根 RP-0001**：查清 `D:\Ksoftware\xiaowei_android` 是谁在用，停用或统一；否则 wrong_port 会反复
2. 本分支合 main（merge commit，禁 squash）；**不部署**进 release（M4 源码仍不超前部署，除非人明确说打新 release）
3. P1 不变：Skill Registry 接 orchestrator、Router 接正式 job、Ledger 持久化
4. M5（Task Router / Plan Compiler / Execution DAG / Event Trace）单独设计文档先行
5. 文档债：根 HANDOFF.md / runtime-boundaries.md / authority-boundary.md 的过时表述仍未清

## 4. 常用命令（新增/变更）

```text
node services/orchestrator/ops/xw-start.mjs --check --json     # 现在是绿的
node services/orchestrator/ops/xw-repair.mjs --check           # 只读巡检
node services/orchestrator/ops/xw-repair.mjs --fix rp-0001     # 打印修复计划（不执行）
node services/orchestrator/ops/xw-repair.mjs --fix rp-0001 --confirm   # 真修
```

红线不变：见上一篇 §7。
