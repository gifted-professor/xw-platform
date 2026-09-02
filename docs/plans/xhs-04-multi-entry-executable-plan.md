# 04 多入口脚本包 — 可执行计划（由 V2 编译）

来源：`docs/plans/xhs-04-multi-entry-script-pack-plan-v2.md`（READY_FOR_EXECUTION）
执行合同：`xhs-04-multi-entry-script-pack-execution-contract-v1.json`（F1/F2/F3/VISION/PUBLISH 五项）
日期：2026-08-27 · 运行时：claude-cli · 基线：Fast-2 done（cd86c00，c7b0695 血系，CP live = xw-m6-c1-fadb449/c21a3d3 lineage）

## 执行原则（响应用户要求）

1. **零人工审核波次**：所有 gate 用离线测试 + live canary 自动晋级链表达；唯一人工 commit 保持 publish 最终 send（合同 V2-P1 要求，不可去除）。
2. **自我留痕**：append-only 执行台账 `docs/plans/runs/xhs-04-multi-entry-ledger.md` — 每个 wave 开始/结束写一条（做了什么、证据指针、坑、决定）。每个 wave 结束同步更新 memory。
3. **固定任务脚本化沉淀**：可重复的 run→ingest→promote→verify→switch-alias 序列固化为 `services/orchestrator/ops/xw-xhs-promote.mjs`（复用 Fast-2 桥）；wave 级回归固化为 `npm run test:xhs-pack` 单命令。

## 已核实的事实基础（探索结论）

- Catalog `descriptorHashOf`（recipe-catalog.mjs:101）= 全 spec canonical JSON sha256 **64-hex**；CP `computeDescriptorHash`（recipe-interpreter.mjs:604）= 投影后 `rh_`+24hex。合同 F1 需要统一到 64-hex（新 revision 起）。
- live overlay `C:\Users\Public\xw-runtime\recipe-overlay\xhs-search-fixed.overlay.v1.json` 仍 `rh_` 轨 + descriptorHash 占位 0；registry.db `recipe_versions` 中 `xhs.search.fixed@1` = canary_only（hash 463c5fa3…，64-hex）。
- 04 routing_json 现有 14 caps（含 xhs.comment.send、xhs.follow.ensure）；`xhs.follow.ensure` 在 capabilities 表中 `enabled=0`。新 capability 只加 04 profile。
- placement.mjs:127 已按 `profile.capabilityIds.includes(capability.id)` 过滤 → 04-only 靠 profile + 集成测试证明（合同 F2）。
- ECP 严格路径已存在：`beginMissionEffect({softScope=false, softBudget=false})`（state-store.mjs:4391）+ `evaluateMissionEffect` + idempotencyKey；`operationKey` 概念已在 m6-grounded-action-facade 中存在。
- xhs adapter（apps/xhs/adapter.mjs）已有 `commentOnOpenNote` internal action；capabilities.json 有 `xhs.comment.send`(internal/approval_required)。
- vision 框架：`m6-grounding-runtime.mjs` freezeFrame→segmentBlocks→decide→resolveInternalPoint，默认 provider = `HERMETIC_FIXTURE_PROVIDER`（构造期 pin id/version/modelSha256/segment）。真实像素 provider 参照 `ops/screenshot-and-analyze.mjs` 调 `~/Desktop/Coding/visual-grounding-poc/analyze.py`。
- 无字面 `R2 => 需人工确认` 代码；对应面是 dag-compiler.mjs 的 `requiresHuman/humanGate=WAIT_HUMAN` + task-plan.mjs L3 human_gate。改为透传中央 AuthorizationDecision（policy/authorization-decision.mjs）。
- 发布底座：`protected_commits` 表 + protected-human-commit.test.mjs 存在，公开 list/decide 面只接了 payment —— S4 需 spike 核验（合同 PUBLISH）。

## Wave 分解（每 wave = 一个 commit + 测试全绿 + 台账一条）

### W0 — 执行底座 + 留痕 + plan-only dispatcher（S0）
产物：
- `docs/plans/runs/xhs-04-multi-entry-ledger.md`（台账，建首条）
- `services/orchestrator/ops/xw-xhs.mjs`：唯一 dispatcher。`node ops/xw-xhs.mjs <action> [params] --plan|--json`；action catalog 表（12 入口，见 V2 §6）；强制 `placement=04`、perDeviceConcurrency=1；`--execute` 按 action gate fail-closed。
- `/xw messages` → inbox 别名（SKILL.md + dispatcher catalog）。
- dag-compiler/task-plan 的 WAIT_HUMAN 面改为展示中央 AuthorizationDecision（保留 fail-closed 行为，只改文案/来源）。
- 测试：`xw-xhs-dispatcher.test.mjs` — 三调用面（xw-xhs CLI / xw-xhs-compose 编译 / SKILL 描述）同 action 产生相同 planHash + 相同 effect budget；01–03 plan 阶段直接拒绝（pre-plan，无 I/O）。
验收：所有入口 plan-only 输出 alias04/backend/budget/stop conditions；`npm run test:xhs-pack`（本 wave 新增聚合脚本）全绿；search plan 指向 `xhs.search.fixed@1`。

### W1 — canonical hash 统一 + `xhs.search.fixed@2` 晋级（合同 F1，S1 前半）
产物：
- 共享 canonical 64-hex：CP `recipe-interpreter.mjs` 新增 `computeDescriptorHashV2`（或直接 import Catalog 的 canonicalize 实现做字节一致校验），Runner/overlay/promotion bridge 对 `@2+` 一律 64-hex；`rh_` 仅在显式 legacy revision 路径接受。
- 生产 recipes 目录 `services/control-plane/config/recipes/`（fixture 不再是生产真源）；sealed `xhs.search.fixed@2` spec（含 noRefocus/clearFirst/pages=1/完整 restoration/failurePolicy）。
- 测试：`recipe-descriptor-hash-v2.test.mjs`（独立 oracle fixture + clearFirst/pages/postAssertions 三点 mutation，F1 两个 probe）。
- live：04 两次独立 `@2` recipe-run → `xw-recipe-promote`（复用 Fast-2 桥，升级支持 64-hex）→ canary_only → 原子切 dispatcher search alias 到 @2（`xw-xhs-promote.mjs` 固化整链）。@1 留 legacy 档案不改写。
验收：五消费者（Catalog/overlay/CP plan/Runner receipt/promotion receipt）同 hash；alias 切换后一次 @2 live search 复核。

### W2 — 04-only placement 证明（合同 F2，S2 前置）
产物：
- 新 capability 的 routing profile 只加 04（control.db routing_json + capabilities 注册；一次性脚本 `ops/xw-xhs-capabilities.mjs apply` 沉淀，可重放）。
- 测试：`services/control-plane/tests/xhs-04-placement-boundary.test.mjs` — seed 01–04，每新 cap 显式 01/02/03 → `NO_ELIGIBLE_DEVICE` 且 jobs/sessions/leases/transport 四项增量为 0；无 alias → 只解析 04；04 busy → busy 不 fallback。
验收：此测试是 W4 任何 social live canary 的硬前置（脚本 gate，非人工）。

### W3 — R0 包：browse/inbox/read + 真实 vision 导航（S1 后半）
产物：
- `xhs.browse.fixed@1` production spec（launch→swipe×N→screenshot→back，无互动）→ 2 次 live 晋级。
- inbox/read：dispatcher 内 R0 workflow（Explorer session acquire→dump→汇总/只读采集→release）；thread fingerprint（唯一才进，不唯一 stop）。
- 真实 vision provider adapter：包装 analyze.py（或等价真实像素实现）满足 provider pin 接口（id/version/modelSha256/segment(bytes)→blocks）；live mode 显式拒绝 HERMETIC_FIXTURE_PROVIDER；决策面只放行唯一 R0 导航块（复用 m6-grounding-runtime decide + redline policy；效果按钮一律 stop）。
- 测试：`xhs-visual-navigation-boundary.test.mjs`（VISION 三个 probe：独立标注 oracle、block mutation、dump fallback 阶梯）+ browse recipe 测试。
- live：search@2 / browse / inbox / read 各 2 次独立 04 receipt（probe+tap 原子执行坑已知）。
验收：四条只读入口 `--execute` 可用；每 run 后 activeLeases=0、runningJobs=0。

### W4 — like/collect/follow + nurture（合同 F3，S2）
产物：
- capabilities.json 新增 `xhs.like.ensure` / `xhs.collect.ensure` / `xhs.follow.ensure`（exposure=public 但 invocationPolicy=mission_only；adapter action 复用旧 `xhs-*-one.mjs` 抽出的 locator/state verifier —— 抽到 `apps/xhs/social-verifiers.mjs`，旧脚本不再作为 live 后门）。
- 严格 Mission wiring：每 action 一个 Mission（actions/targets 冻结/totalCount/perTargetCount=1/frequency），ECP `softScope=false, softBudget=false`；`operationKey=sha256(actionRunId+action+targetFingerprint+payloadHash)`；ambiguous 同 mission/action/target 禁盲重试。
- nurture：默认 browse-only；显式 counts 各建严格 Mission。
- 测试：`xhs-social-action-run.test.mjs`（F3 三 probe：并发 reservation 竞争/伪造绑定逐字段/replay+ambiguous）、`xw-xhs-effect-budget.test.mjs`。
- live：每 cap 一次有界 04 canary（before/after + exactly-once + ledger 核对）。
验收：already-true skip；false→true 恰一次 transport；并发/重放不破预算。

### W5 — comment + DM（S3）
产物：
- `xhs.comment.bound_send`（internal composite `comment.send` adapter 唯一公开编排入口）：唯一 note + exact text hash + count delta/本人最新评论 hash 验证替换"编辑器关闭即成功"。
- `xhs.dm.bound_reply`：唯一 thread + last-message fingerprint；username contains/maybe 禁入 send。
- inbox/read thread fingerprint 补齐（W3 部分的正式化）。
- 测试：F3/弱验证/模糊用户名/last-message 漂移均不得 send 或报 verified。
- live：各一次 04 canary。

### W6 — publish（合同 PUBLISH，S4）
产物：
- 2–4h spike：核验 ProtectedHumanCommit 现有公开面（payment-only 程度），结论写台账。
- `xhs.publish.commit-envelope.v1`（prepareRunId+planHash+contentHash+screenshotHash+device/account/target fingerprint+expiresAt，canonical hash）。
- publish 最小 begin/list/decide 绑定层，复用 PHC 内核；prepare 复用 `xhs.publish.edit_dry_run`（transport=0 证明）；approve 后一次 tap、漂移 fail-closed、重启丢 handle fail-closed。
- 测试：`xhs-publish-protected-commit.test.mjs`（PUBLISH 三 probe）。
- live：最终 publish canary **需用户另行明确授权具体内容**（V2 §10.5，唯一保留人工点）。

## 沉淀的固定脚本（贯穿）

| 脚本 | 用途 |
|---|---|
| `ops/xw-xhs.mjs` | 唯一 dispatcher（三调用面共用） |
| `ops/xw-xhs-promote.mjs` | run→ingest→promote→verify→switch-alias 一键晋级链 |
| `ops/xw-xhs-capabilities.mjs` | routing profile/capability 注册（幂等 apply + diff 输出） |
| `npm run test:xhs-pack` | 全 pack 离线回归单命令 |
| `docs/plans/runs/xhs-04-multi-entry-ledger.md` | 我的执行台账（append-only） |

## 执行顺序与 gate

W0 → W1 → W2 → W3 → W4 → W5 → W6。每 wave gate = `npm run test:xhs-pack` 全绿 + （有 live 项时）canary 晋级链完成 + 台账落条。合同 5 个 P1 item 分别落在 W1(F1)/W2(F2)/W4(F3)/W3(VISION)/W6(PUBLISH)。

## 环境注意（来自 memory，执行时遵守）

- live 操作基于 c7b0695 血系（schema 20）；新 release 从干净 detached worktree 打（主 worktree untracked 会 RELEASE_SOURCE_DIRTY）。
- CP 优雅关闭（防 crash-lock）；probe+tap 同一 bash 调用原子执行。
- 不碰 01–03 pilot 配置；不启用旧 XhsDevice* 任务。

## 明确不做

同 V2 §13；publish 最终 send 是唯一人工 commit。
