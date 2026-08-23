# M6-3 交接文档（Handoff）

日期：2026-08-23
状态：**Gate A 完成，Gate B 未开始**，等待接手继续

---

## 1. 项目背景（一段话）

xw-platform 的 M6-3 阶段：建立真实、锁定版本（`@deepseek-ai/dsh@0.1.0-rc.7`）、out-of-process 的 DSH/Cordis replay 链，供后续 M6 阶段做 replay-only worker。模型可见工具面恰为 10 个，所有 ground/act/verify 只作用于 synthetic replay state（`externalEffect=false`、`actionCount=0`），gate 始终 CLOSED，不触达任何真机/live authority。实施已获用户授权。

## 2. 必读产物（按顺序）

全部在主仓 `C:\Users\Public\xw-fusion\xw-platform\docs\plans\`：

1. **M6-3-dsh-cordis-replay-plan-v2.md**（终版计划，`READY_FOR_EXECUTION`）
   SHA-256 `f1c6d321bd5fb2a7d8fe59ef859f286bbe8ac4894dc68cece4de5797defef803`
   —— 唯一权威计划。§3 是 9 条架构决策（D1–D9），§6 是 Gate A–F，§7 验收矩阵，§12 是评审裁决记录（F1–F5）。**不存在 Plan V3**；实施中若需改能力边界/删硬门/改 resume 架构，必须停下请求新决策。
2. **M6-3-execution-contract.json**（SHA `5cd6b7d4…`）— 2 个 P1 contract items（跨进程 resume、进程树收敛）+ probes，完成收据必须逐项覆盖。
3. **M6-3-execution-route.json** — 执行路由（advisory）。runtime=claude-cli、primary=glm-5.3、fallback=deepseek-v4-pro（最多 1 次切换）。
4. **reviews/m6-3-v1/review-batch-plan.json** — 原始 multi-model review 批次（degraded：adversarial 由 Ollama deepseek-v4-pro 完成，coverage 因 CPA 403 失败无报告）。

前置：M6-2 已收口（`C:\Users\Public\xw-runtime\m6-audit\m6-2-w9-completion-4ea1fa60.json`，verdict=`M6_2_CLOSED_READY_FOR_M6_3`，gate CLOSED，资源归零）。

## 3. 当前工作环境

- **worktree**：`C:\Users\Public\xw-fusion\xw-platform\.claude\worktrees\m6-3-dsh-replay`
- **分支**：`codex/m6-3-dsh-replay`，基于 origin/main `80355d3`（= PR #45 合入后），**尚无任何提交**
- **spike 目录**：worktree 内 `.m6-3-spike/`（未跟踪，含 node_modules，不提交）。产物：
  - `package.json` / `package-lock.json` — rc.7 依赖闭包（455 包，全 MIT + integrity，clean `npm ci` 复现已验证）
  - `profiles/headless/` — dsh profile workspace（pnpm），`cordis.patch.yml` 已用 `insert:` 语法把 `dsh-sdk-jsonrpc-server@0.1.0-rc.7` 插进 headless 组合并禁掉 one-shot runner
  - `spike-a3.mjs`、`spike-a4-p1.mjs`、`spike-a4-p2.mjs` — Gate A spike 脚本（可复跑）
  - `gate-a-evidence.md` — **Gate A 证据文档（接手先读）**
  - `sessions/` — spike 落盘的持久化 session（zstd 编码）
- 注意：`.dsh-home/` 是误建目录（DSH_HOME 解析偏移），可忽略；真实 profile 在 `profiles/`

## 4. Gate A 结论（已完成 ✅）

1. **A.1** 四份 M6-2 收据哈希全匹配（7d6910c5…、04305ea5…、68a38d84…、5bc7a0c4…）；gateMode=CLOSED；m6_3Entry=replay_only_DSH_Cordis_worker / reuseObserveOnlyEpoch=false / liveActionsEnabled=false
2. **A.2** rc.7 闭包锁定 + `npm ci` clean reinstall 复现；顶层 rc.7 但 @deepseek-ai/* 传递依赖解析到 rc.8（caret 范围）——「必须独立 lockfile」的必要性被证实
3. **A.3** 真实 SDK wire 打通：真实 `HarnessClient` spawn 真实 dsh bin → initialize ack `deepseek-harness-sdk-runtime/0.0.1` → shutdown → 干净关闭
4. **A.4（F1 blocker，最关键）** 两个全新 OS 进程、同 persistence root、同 session id `m6-3-spike-a4`：
   - P1（spike-a4-p1.mjs）：prompt enqueue → messageId ack + 18 个 session.event + 2 个 session.status → session 落盘 `session.jsonl.zstd` → clean close
   - P2（spike-a4-p2.mjs）：公共 `ctx.agents.resume({resumeSessionId})` **成功恢复同 id session**（返回 AgentHandle，id 相同）
   - negative control：同 id `agents.create()` 失败 `session already exists` ✅
   - **stock jsonrpc server 的 create 只查内存 map，跨进程不撞盘** —— XW server 必须先查 persistence（Plan D3.3/D3.4 必要性被证实）
5. **A.5** `request/header.tools` 运行时取证：spike 已见真实 session.event 事件流；完整 10-tool 对比按计划留到 Gate C 真实 composition

### 实现要点（spike 踩坑，接手必读）

| 发现 | 影响 |
|---|---|
| server `initialize` 无条件 `resolve(params.cwd)`，**cwd 必传**；provider 不传时只有 `deepseek-official` fallback | XW client/server 两侧显式传；Gate C 用 deterministic LLM 时需注册 adapter |
| persistence `compression` 不匹配会 fail-closed（zstd 文件不能被 none 配置读） | XW profile 固定 compression + root |
| session 事件按 batch window（默认 200ms）落盘；close 前必须显式 flush | Plan D9 的 flush 顺序是硬要求 |
| Cordis `Context` 无 `start()/dispose()`；用 `await ctx.plugin(...)` 与 `ctx.fiber.dispose()`；需 `ctx.provide('dshHomePath', …)` | 写 XW server 时照此 |
| agent-loop factory 需 services：`agents/sessions/llm/tools/systemPrompt`（tools 由 `dsh-tools` 提供，不是 typert-registry） | 最小 composition 插件清单 |
| 最小可用插件集（已验证）：cordis + dsh-llm + dsh-typert-registry + dsh-tools + dsh-system-prompt + dsh-session + dsh-session-persistence-jsonl + dsh-agent + dsh-agent-loop | Gate C 起点 |
| `dsh plugin add` 装到 `$DSH_HOME/profiles/<name>` pnpm workspace；jsonrpc-server 无 `dsh.bundle` 声明，必须用 `insert:` patch 语法挂载（顶层 `- id:` 会报 entry not found） | 组 profile 时照此 |
| resume 报 `cannot prepare session while it is live` = 同进程内已有 live session，非错误路径 | 测试时注意进程边界 |

## 5. 剩余工作（Gate B–F，全部未开始）

按 Plan V2 §9 推荐顺序（每 Gate 细节见计划 §6）：

- **Gate B**：`integrations/dsh-xw` standalone lock/profile/inventory check；line-buffered store-and-forward supervisor（预算：单行 1MiB、stdout 32MiB/run、notification 10k/run、pending 8、stderr 256KiB/400 行，Plan D4）；fake-peer/budget/backpressure 测试；Windows（`shell:false` 直启 System32 `taskkill /PID /T /F` fallback，必须实际命中一次）+ POSIX（owned process group）进程树测试；40 次三档（1KiB/64KiB/1MiB-1）proxy microbenchmark
- **Gate C**：XW protocol server（显式 create/resume、严格 session mode、不用 stock server）；闭合 Cordis composition（`replay.cordis.yml`：无 bash/pwsh/fs/editor/web/subagent/MCP）；deterministic scripted replay LLM；10-tool spec 双侧校验（扩展 `orchestrator/src/m6-tool-surface.mjs`）；runtime `request/header.tools` 恰为 10 的独立取证；mutation tests（Cordis schema/XW input/XW output/forbidden scanner/单次授权/journal 幂等）
- **Gate D**：checkpoint/resume 全链（journal fsync、process-closed receipt、新进程 resume、13 项 fault matrix、independent oracle hashes）
- **Gate E**：40 warm prompt-ack p95≤100ms（含 supervisor 开销，versioned self-hosted Windows runner）；happy ≥20 / REPLAN ≥5 / HARD_STOP ≥5；Windows/Ubuntu CI matrix（`npm ci --prefix integrations/dsh-xw` + 真实 child，无 soft-fail）
- **Gate F**：全回归、安全扫描（禁字段：坐标/bounds、serial、ADB/port、lease、DB、payment、secret、raw screenshot/base64）、completion receipt（`xw.m6-3-completion-receipt.v1`）+ 独立 GPT execution review；单一 PR `M6-B`，**merge commit 禁止 squash**

## 6. 硬边界（不可违反）

- 只做 replay：无真实模型/API key、无 ADB/真机/Control Plane live adapter/lease/DB/支付/网络 provider
- gate 保持 CLOSED；M5 Router/Binder 不注册 `agentic_session`（属于 M6-6）
- 不 fork upstream 包、不改 node_modules；`integrations/dsh-xw/plugin.mjs`（M4 in-process fixture）保留并加 `adapterKind=fixture_in_process` 标记；两种 receipt 不能互相冒充
- replay frame 只经唯一 `orchestrator/src/m6-grounding-runtime.mjs` 消费
- 契约 budgets 全为 0（不允许修复批次）；错误码清单见 Plan §8
- 实施前 `git fetch origin --prune` 并记录当时基线；**不要动主仓 root worktree**（含用户未跟踪文件）
- 每 Gate 出 blocker 即 `BLOCKED_NEEDS_DECISION` 停下，不降级验收

## 7. 接手第一步建议

1. 读 `docs/plans/M6-3-dsh-cordis-replay-plan-v2.md` + 本文档 + worktree 内 `.m6-3-spike/gate-a-evidence.md`
2. 复跑 spike 验证环境：在 `.m6-3-spike/` 下依次 `node spike-a3.mjs`、`node spike-a4-p1.mjs <新id>`、`node spike-a4-p2.mjs <同id>`
3. 从 Gate B 开始：建 `integrations/dsh-xw/package.json` + lock（可从 `.m6-3-spike/package-lock.json` 迁移，注意补 `dsh-sdk-jsonrpc-server` exact），然后 supervisor + fake-peer tests
4. 一个 PR 多个可审提交，每提交测试可运行

## 8. 会话杂项

- 会话内有每小时的 PR #38 CI 定时检查（cron `eff628cd`，session-only）——PR #38（M6-A，早已 merged）一直全绿，与 M6-3 无关，可忽略
- 查 CI 命令：`gh pr view 38 --repo gifted-professor/xw-platform`
