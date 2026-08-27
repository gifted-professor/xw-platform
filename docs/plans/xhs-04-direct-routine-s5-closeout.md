# xhs-04 direct-routine RPA — S5 closeout & 04 live runbook (v1)

Status: **offline complete, live HELD**. 本文档总结 S0–S5 全部离线交付物，冻结
实现基线，并给出 04 live 验收 runbook。按计划不变式
（v2 计划 §8："本计划及评审不授权部署或真机 mutation"），**live 执行未被本计划授权**，
必须由 operator 逐段授权后才可执行 §3 的窗口。

- 实现基线：`31dc8f4`（W6 live prep）
- 例行分支：`codex/new-work-20260826`
- 冻结 commit 链（每波一个 clean commit，全部来自 dirty-free 阶段提交）：
  - S0 `daa4e4a` — 执行真相（resolveExecuteOutcome / 权威终态 receipt / XHS_EXECUTE_NOT_WIRED fail-closed）
  - S1 `5fb4528` — sealed plan catalog + surface classifier + 无 Agent 状态机 + CLI 三面同 hash
  - S2 `35336cd` — commitRoutineEffect bridge + server-hard `routine_effects` 台账 + like 阶梯
  - S3 `fa0b753` — grounded 评论链（server-sealed draft、TTL 60s、硬上限 2、append-only reconcile）
  - S4 `cccadbc` — vision shadow + R0 one-shot navigation permit
  - S5 `0c72bbe` — 部署对齐（fusion verify PASS、authority redline 修复）

## 1. 模板收口（§4）

四个初始模板全部注册在 `ROUTINE_TEMPLATE_CATALOG`（services/orchestrator/scripts/lib/xhs-routine-plan.mjs）：

| template | effectClass | 外部效果 |
|---|---|---|
| `xhs.scout.home.v1` | none | 0 |
| `xhs.feed-play.v1` | none | 0 |
| `xhs.nurture-lite.v1` | social | `like <= likeMax` |
| `xhs.nurture-grounded.v1` | social | `like <= likeMax, comment <= 2` |

收口确认：publish/DM/follow/collect/delete/payment/account-setting 在 catalog、bridge、
transport 三层均无路径（`ROUTINE_ACTION_NOT_WIRED` / `frozen:forbidden_surface`）。

## 2. 离线验收（v2 计划 §10 离线/集成 1–9）

| 项 | 证据 | 结果 |
|---|---|---|
| 1 三面同 planHash / 负例 I/O 前拒绝 | `tests/xhs-routine-plan.test.mjs`（orchestrator + CP） | 绿 |
| 2 权威终态 receipt 决定返回码 | `tests/xw-xhs-routine-cli.test.mjs`（fake backend 真调 CP） | 绿 |
| 3 parser/classifier golden | surface tests（属性顺序/重复卡/冲突/负例） | 绿 |
| 4 状态机保证（open≤1、视频 swipe=0、dwell 有界、back 语义确认） | `tests/xhs-feed-routine-machine.test.mjs` | 绿 |
| 5 fault test（cancel/timeout/stale → 释放） | bridge + CLI fault 路径 | 绿 |
| 6 hard budget（第三 comment transport=0，like/comment 分开，并发/重放不突破） | `tests/xhs-routine-comment-chain.test.mjs` + bridge tests | 绿 |
| 7 ownership/like ladder（跨 session/nested job/tap bypass = 0） | `tests/xhs-routine-effect-bridge.test.mjs` | 绿 |
| 8 LLM 伪造/过期/漂移/重复/未 sealed 均不能 send；reconcile 只 append | `tests/xhs-routine-comment-chain.test.mjs` | 绿 |
| 9 vision 独立标注真实 PNG；fixture/低置信/多块/效果控件/过期重放 = 0 | `tests/xhs-vision-shadow.test.mjs` | 绿 |

全套：`test:xhs-routine` 96/96，`test:xhs-pack` 144/144，`fusion verify` PASS，fusion test-run 20/20。

与 S0–S4 无关的宿主环境已知失败（在基线 `31dc8f4` 上验证结果相同，本计划未触碰）：
external-path-guard 基线（未跟踪的第三方 WIP 文件）、四个 m6-grounded-run / m6-live-production TCB/bootstrap 测试。

## 3. 04 live 验收 runbook（OPERATOR 逐步授权后执行）

**本节不构成授权。** 每一段执行前需要 operator 单独确认；任一不满足即中止。

前置（全部硬性）：
1. 从冻结 commit `0c72bbe` 干净 worktree 构建 CP 与 Registry；manifest、overlay、`/health`
   必须报告同一 `sourceCommit`。dirty worktree 一律不得部署。
2. 部署前保存当前 CP/Registry junction 与 manifest 为 rollback tuple。
3. Gate 状态 OPEN 检查：任何 hash/overlay 不一致 → 禁止 canary。

节奏（持久约束，2026-08-27 恢复授权后仍然有效）：
- 每轮写传输 ≤2 次；动作间隔数分钟；突发触发风控。
- 04 有风控历史：follow 静默失败、不自动点击解除限制。

首轮 canary（只 alias04，01–03 增量必须为 0）：
1. `xhs.feed-play.v1` — 1 note + 1 video，dwell 2–3s，comment swipe ≤1；无法唯一进入
   视频评论面 → STOP/skip（正确行为）。
2. `xhs.nurture-grounded.v1` 首轮 `commentMax=1`（schema 允许 2，先 1 验证无重复再开放）。
3. 每步核对 receipt：planHash/seed、session/lease owner tuple、每个 state/target/reason、
   dump/screenshot hashes、primitive jobIds、effect reservation/outcome、restoration、
   `cleanup.activeLeases=0`。
4. 风控/登录/验证码/权限/商品/发布页一出现 → social transport 增量为 0，退出。

回滚：任何 sourceCommit/manifest/overlay 不一致或 04 busy fallback 迹象 → 立即用 rollback
tuple 恢复，本次 canary 判 NO-GO，不现场混源。

## 4. 已留痕的 live-wiring gap（S6 候选）

- detail-page 与 feed-card 的 targetFingerprint 绑定在 live 上需要真实接线确认（S2 设计决议）。
- 视频主 surface 的 comment panel 断言（S1 `COMMENT_PANEL_ASSERTION_PENDING_S1`）。
- fastLanePreferred / descriptorHash 两个 gap（Fast-2 留痕）。

## 5. 留痕契约

- 本文档：系统状态留痕（③ 类待问项：live 窗口需 operator 排期）。
- 踩坑/配方：XHS Flutter 输入 tap-first、社交动作节奏限制已入知识库（此前会话留痕）。