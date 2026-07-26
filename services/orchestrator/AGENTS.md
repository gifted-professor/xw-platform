# xhs-registry — 冷启动协议（任何 agent 进本目录必读）

> 你是接手 xhs 多设备自动化系统的新 agent。你没有历史上下文，**不要靠猜**，
> 按下面顺序读文件，30 分钟内你就能获得完整上下文。

## Agent 入口（硬规矩，先于一切碰机）

1. **正道 = 控制面**：只允许 `job submit` / `session acquire` 碰手机；lease 必须在 `GET /control/v1/leases` 或面板可见。
2. **禁止旁路**：无 lease 的 `GatewayOperator` / 临时 `_*.mjs` 四机干跑 = 入口违规（即使业务成功也算任务不合格）。
3. **文档是软约束**：知识库/长文 agent 默认不会自觉读完——验收与硬闸才约束行为。
4. **2026-07-26 完整交接**（流程/卡点/已修/入口设计）：本目录 **`HANDOFF-2026-07-26-agent-entry-xianyu-verify.md`** —— 接手闲鱼验证或入口改造必读。
5. 进场三问（答不出不准动手）：① job 还是 session？② leases 看不看得见我？③ capability id 是什么？

## 第一步：建立全局认知（必读，按序）

1. 本文「Agent 入口」+ `HANDOFF-2026-07-26-agent-entry-xianyu-verify.md`（若任务涉及设备/闲鱼/入口）
2. `PROGRESS.md`（本目录）——系统总状态：架构、Phase 1-3、scout、路由规则、watchdog、已知问题
3. 知识库路由表：`ssh xhs-windows 'cmd /c "curl.exe -s http://127.0.0.1:17930/api/knowledge"'` 里 id=`routing-table-v2` 的条目（v1 已废止）——任务该派给谁、升级纪律
4. 按需深入（PROGRESS.md 里有全部指针）：
   - 正道命令：`/Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-device-agent-routing-v1-1/docs/agent-entry.md`
   - scout 设计：`/Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-windows/docs/plans/2026-07-24-phase4-探索agent设计.md`
   - 项目流水账：`/Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-windows/02-项目进度.md`
   - 仓库与部署：`/Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-device-agent-routing-v1-1/AGENTS.md`

## 第二步：汇报再动手

先向人汇报三件事：① 你理解的系统状态 ② 进行中/悬挂的任务 ③ 你认为的下一步。
**人确认之前不要改任何东西。**

## 干活规矩（摘要，细则见 PROGRESS.md 路由规则）

- 任务分派查知识库 `routing-table-v2`：验证→MiMo、修复→GLM/Grok、设计/验收/部署运维→Kimi、R2 审批→人
- 代码改动走 git 流程（仓库 AGENTS.md「部署流程」节，含 task-launch.json commit 闸门 3b）
- 验收独立：执行者不自评，diff 由 Kimi 或 watchdog 验收
- **留痕契约（默认动作，不是可选项）**：任何 agent 完成任务后必须——
  1. 踩到的坑/验证过的配方 → 写知识库（带 appliesTo/verifyMode）
  2. 改变了系统状态（新服务/新端口/新流程/废弃旧物）→ 更新 PROGRESS.md 对应节
  3. 遇到文档没写的「人脑独有」问题 → 不要自己编答案，写成待问项列在报告里
  验收时检查留痕：**活干了但没留痕 = 任务未完成**（watchdog 验收报告含留痕检查项）
- 设备红线：不批量杀进程、不碰 control.db 写入、R2+ 只提交不批准、遇验证码/风控立即停止

## 关键端点

| 什么 | 在哪 |
|---|---|
| registry（身份/审批/知识库/面板） | Windows `127.0.0.1:17930`（手机经 tailscale `127.0.0.1:17930/?token=...`，token 在 Windows 任务 argLine） |
| 控制面 | Windows `127.0.0.1:17920` |
| 设备 serve | 01→17895 / 02→17897 / 04→17896（loopback） |
| MiMo 委派 | `mimo-ro run --dir <项目> "任务"`（key 池自动轮换） |
| Windows 访问 | `ssh xhs-windows`（PowerShell；curl 用 curl.exe；复杂命令用 EncodedCommand） |
