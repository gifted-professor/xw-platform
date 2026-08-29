# xhs-routine-03 (Plan V2) 交接文档 — R0–R4 全部执行完毕

> 生成时间：2026-08-28（closeout 之后）。接手前先读完本文档 + Plan V2 原文。
> Plan: `C:/Users/Public/xw-fusion/xw-platform/docs/plans/xhs-routine-03-live-s1-s4-plan-v2.md`（READY_FOR_EXECUTION，已全部执行完）

## 1. 一句话现状

Plan V2 的 R0–R4 所有 wave 已在真机执行完毕并 closeout。**S1 PASS、[03,04] 并行只读 PASS、S2/S3 已真实传输但 ambiguous（预算 1/1 消耗，本激活窗口不再重试）、S4 HELD（host 无视觉 provider）**。`S1_S4_LIVE_VERIFIED=false`。

最终 closeout aggregate（先读这个）：
`C:/Users/Public/xw-runtime/state/orchestrator/xhs-routine-acceptance/xhs-routine-s1-s4-live-acceptance.v1.json`

## 2. git / release 状态

- 分支：`codex/xhs-routine-03-live-s1-s4`（worktree `C:/Users/Public/xw-fusion/xw-platform/.worktrees/xhs-r03`），**未 push、未开 PR**
- 冻结链：S_A(R0) → S_B `5f7d22c`（R2 生产接线）→ S_B2 `fea46a5`（S2 register sessionId 修复）→ **S_B3 `dc41e2e`（effects 透传修复，最终）**
- 当前部署 release：`xw-xhs-routine-b3-dc41e2e`（junction `C:/Users/Public/xw-runtime/current` 指向它）
- 回滚：junction `current.pre-b3-dc41e2e` → b2-fea46a5；tuple 在 `C:/Users/Public/xw-runtime/snapshots/switch-b3-dc41e2e.rollback-tuple.json`
- 运行中进程：CP 17920（simple launcher，隐藏窗口）、Registry 17930、serve-03 17898、serve-04 17896 — 全部同源 b3-dc41e2e
- 待清理：worktree `.worktrees/xhs-r03-release3`（打包用的，可 prune）；`xhs-r03-release`/`release2` 空壳

## 3. 预算账本（本 Plan V2 激活窗口）

| 预算 | 状态 |
|---|---|
| like 传输 | **1/1 已消耗**（ambiguous，不重试） |
| comment 传输 | **1/1 已消耗**（ambiguous，不补发） |
| 视觉 tap | 0（S4 HELD，全程 shadow tap=0） |
| S2 采样窗口 | 2/3 已用（窗口已因传输发生而关闭） |

要再开社交窗口必须：用户明确授权 + 重验 plan hash/release → 开**新窗口**（新 seed），绝不是重试。

## 4. 关键 wave 证据（都在 `xhs-routine-acceptance/` 目录）

- S2：`S2-xe_4363841...-run.json` + `s2-wave2-effect-passthrough-adjudication.json`。CP ledger 真相：like effect `routine-effect_b56dd8bd...` status=ambiguous、reservation_consumed=1（tap 真实发生）；机器回执显示 bridge_error 是缺陷假象
- S3：`S3-xe_868199c6...-run.json`。comment effect `routine-effect_d26abcc5...` ambiguous；server-sealed 草稿已 consumed
- 并行：`PAR-xe-parallel-03-04-w1-run.json`。两 lane SUCCEEDED、transport=0、restored
- S4：`S4-held-no-provider.json`（恢复条件已记录）

CP ledger（只读查询，绝不直写）：`C:/Users/Public/xw-runtime/state/control-plane/control.db` 表 `routine_effects` / `routine_authorities` / `comment_drafts`。查询脚本模式：node + `node:sqlite` DatabaseSync readOnly，注意表里是 `status` 不是 `outcome`。

## 5. 本轮修的两个 P1（都已带回归测试，186/186 + gate KNOWN_FAILURE_MATCH）

1. **S_B2 register 缺 sessionId**：explorer-runtime register body 没带 sessionId → CP `validateSession(undefined)` → SQLite bind 错误被吞成 `CONTROL_INTERNAL_ERROR`。修复：body 带 sessionId + validateSession 类型化 404 守卫
2. **S_B3 effects 透传**：`xhs-routine-authority.mjs` 的 seam 对已解包的 effect 对象再取 `.effect` → 所有真实结果塌缩成 `{outcome:"bridge_error"}`，transported 标志丢失。**测试 fixture 编码了错误契约（原始信封）所以离线测试没抓住**。修复：原样返回 + fixture 对齐生产契约（malformed 抛 `ROUTINE_AUTHORITY_RESPONSE_INVALID`）

## 6. 留痕的 follow-up（未修，按优先级）

1. **P2 in-run comment reconcile**：ambiguous 后 machine 从不调用已接线的 `reconcileComments` seam → `verified_late` 结构性不可达（authority 随 session 关闭，post-release reconcile 报 `ROUTINE_AUTHORITY_INACTIVE`）。修法：machine 在 ambiguous 后、release 前调用 reconcile（纯离线可改+可测）。**这是下次社交窗口拿到 verified 的关键**
2. **P2 CP 不记 handler 错误**：typed 错误被 catch-all 掩盖，S2 根因因此多花了一个 wave
3. **P3 client close 时序**：authority close 在 session release 之后触发（server 端 auto-close 兜底了，回执里有噪音 `ROUTINE_SESSION_BINDING_INVALID`）
4. **S4 视觉 provider**：host 上装 visual-grounding-poc 才能解锁 S4（dump 稀疏页面的唯一出路）

已知基线（不要修，closeout 已单列）：gate control-plane 27 个 allowlist 失败（KNOWN_FAILURE_MATCH，unexpectedFailures=[]）；03/04 有 1 个已知 capability blocker（pitfall-xhs-copy-link-...-20260814）。

## 7. 能力开放状态（§11 裁决）

**已开放**：03 日常只读（scout / feed-play）+ 显式 [03,04] 只读并发
**未开放**：verified S2/S3 日常化（nurture 模板仍 canary-bounded、逐段授权）、S4 视觉 canary
**红线不变**：04 永不社交/永不 fallback；publish/DM/delete/follow/collect/payment 是 non-goal；每轮写传输 ≤2、动作间隔数分钟（风控约束，用户 2026-08-27 授权但节奏限制持久有效）

## 8. 运维要点（踩过的坑）

- **CP 停止**：graceful CTRL-C 对隐藏窗口 CP 不可靠 → `Stop-Process -Force` + 审计脚本 `C:/Users/Public/xw-runtime/recover-cp-owner-lock.ps1`（必须 AUDIT_OK 再拉起）
- **CP 启动**：用 `launch-control-plane.simple.ps1`（Gate F launcher 的 binding 还钉在旧 c7b0695，会 `M6_C1_RELEASE_REBINDING` 拒启）。**用 `Start-Process powershell ... -WindowStyle Hidden` 分离启动**，别挂在本会话后台任务上（否则任务清理会连带杀掉 CP——已发生并恢复过一次）
- **release 切换**：junction 用 `cmd /c rmdir` + `mklink /J`（在 PowerShell 里托管，别在 Git Bash 裸跑）；serve 启动配置 `state/control-plane/fast-operator/serve-launch-{03,04}.json` 每次切换要重绑 releaseId/sourceCommit
- 打 release 用干净 detached worktree（`git worktree add --detach ... dc41e2e`），CLI 是 `node packages/cli/xw.mjs cutover package --out C:/Users/Public/xw-runtime --release-id <id>`
- **`xw cutover snapshot` 的 M3-R 默认 DB 路径已过期**：必须显式 `--control-db C:/Users/Public/xw-runtime/state/control-plane/control.db --registry-db C:/Users/Public/xw-runtime/state/orchestrator/registry.db`（registry 老路径 `xhs-registry\registry.db` 随 Route B 销毁）
- **`collect-rollback-tuple.ps1` 在 PS 5.1 会因 ConvertTo-Json 参数越界死掉**（artifact 落了、tuple JSON 没落）→ 用 node 按同 schema 组装（先例：`C:/Users/Public/xw-runtime/tmp-canary/build-rollback-tuple.mjs`），verify-rollback-tuple PASS
- **feed 内容轮换导致 video 卡稀疏**：S1 video 重跑 6 连 BLOCKED（NO_MATCHING_CARD_EXHAUSTED）后第 7 次 `--items 2` 才 SUCCEEDED——video 重放要准备多次尝试或加 seed/轮换，观测要耐心（发送后渲染滞后同类坑）
- **并行 runner 父 receipt 的 cleanup 是 lane 聚合形状**（`{verified}`，无 primitiveTrace）→ accept 工具已按 `mode:"parallel-batch"` 分支断言 lanes（S_B7），单-run 断言不要套在并行收据上

## 9. 下一步建议（新会话的活）

按优先级：
1. 修 in-run reconcile（follow-up #1，纯离线：machine + 测试 → 全套回归 → S_B4 → release B4 → cutover 同 §8 流程）
2. 用户授权后开新社交窗口（S2/S3 各一次，目标 verified / verified_late）
3. S4：装 visual-grounding-poc provider → shadow → 一次性 R0 canary tap
4. push 分支 + 开 PR（3 个 commit 已就绪）

## 10. 常用命令

```bash
# 只读探索（已开放，日常可用）
cd C:/Users/Public/xw-runtime/current/services/orchestrator
node ops/xw-xhs-routine.mjs run --template xhs.feed-play.v1 --alias 03 --items 3 --dwell 5:12 --seed daily --execute --json

# [03,04] 并发只读（已开放）
node ops/xw-xhs-routine.mjs run --template xhs.feed-play.v1 --parallel 2 --items 1 --seed p-03-04-w2 --execute --json

# 社交（未日常化，需逐段授权 + canary）
node ops/xw-xhs-routine.mjs run --template xhs.nurture-grounded.v1 --alias 03 --items 2 --comment-screens 1 --like-max 0 --comment-max 1 --llm grounded --seed <window> --canary-authorized --execute --json

# 回归
npm run test:xhs-routine && npm run test:gate   # 在 worktree xhs-r03
```

持久 trace：`C:/Users/Public/xw-runtime/state/orchestrator/xhs-routine-runs/`（机器轨迹）和 `.../xhs-routine-acceptance/`（验收证据）。

记忆索引已有条目：`xhs-r03-r1-s1-live-done`、`xhs-r03-r3-r4-closeout`、`xhs-social-pacing-limit`。

---

# V2.1 Closure — 2026-08-29（离线闭环完成 + live 只读验收完成）

> 依据：执行复核裁决 `FIX_REQUIRED`（5 findings）+ 用户三项范围决定：
> ①分阶段（先离线闭环→只读 live 验收）；②SYSTEM launcher 重绑单列不做（部署按裁决标 unverified）；③续 `xhs-r03` worktree，不 push 不 merge。

## A. 本窗口已落地（冻结链 S_A → S_B3 → 三个新 commit）

| commit | 内容 | 对应 finding |
|---|---|---|
| S_B4 `083de25` | machine 在评论 ambiguous 分支内（BACK_VERIFY_FEED 前）立刻调 reconcile（唯一 verified_late 窗口），`run.reconciles` 进 receipt；authority close 提前到 release 之前（`effects.closeAuthority(reason)` + runner 兜底 fail-visible）；`routine_effects`/`comment_drafts`/`note_context_receipts` 全链 `account_fingerprint` 绑定（零破坏 SQLite ensureColumn 迁移） | P1-COMMENT-RECONCILE-LIFECYCLE + P2-AUTHORITY-CLOSE-ORDER |
| S_B5 `83436c6` | `ops/xw-xhs-routine-closeout.mjs` 六子命令证据工具：ledger-export(readOnly)、backfill S2/S3/S4（verdict 从 ledger 推导，authority 绑定强制校验）、receipt --emit-contract S1/PAR（无 releaseIdentity 的旧收据拒收=stale lineage 永不产生 PASS）、aggregate v2（逐文件重哈希 + 混合身份如实记录 + liveVerified 硬 false）、completion（真实文件 sha256；Gate F launcher + 视觉 provider 两条 unverified）、source-ledger（本文件已被其重生成：`xhs-routine-03-live-source-files.v1-703fb29.json`，23 files @ S_B6） | P1-REPRODUCIBLE-CLOSEOUT |
| S_B6 `703fb29` | `tools/xhs-routine/` 三件套：`switch-release.ps1`（参数化 junction cutover，flip 前 manifest sha256 硬门禁，失败自动恢复旧 junction+current.json 报 `SWITCH_ROLLED_BACK`；**不进 `xw cutover` 命名空间**）、`collect-rollback-tuple.ps1`（§6.2 九类只读采集）、`verify-rollback-tuple.mjs`（离线校验器，非零退出阻断 flip）；CP 结构化错误日志：`cp.route.error`/`cp.release.identity.unavailable`/`cp.live.progress.unavailable`/`cp.transport.status.unavailable`，全部 console.log（stderr 红线）、永不记 body/token、吞点 30s 节流 | P1-DURABLE-CUTOVER-ROLLBACK + P2-OBSERVABILITY |

**原 §9 follow-up #1/#2/#3 已全部修复**；#4（视觉 provider）仍单列。
测试基线：**214/214** test:xhs-routine、**144/144** test:xhs-pack、**20/20** test:fusion（fusion allowlist +3 新文件）。27 个 KNOWN_FAILURE_MATCH gate 项不动。

## B. W4 — 只读 live 验收 runbook（已执行，实际见 §D）

前置已满足：W1-W3 全绿；source-ledger 已以 S_B6 重生成并随本窗口 commit。

1. 打 release B4（干净 detached worktree @ 703fb29）：`xw cutover package/verify/preflight --release-id xw-xhs-routine-b4-703fb29`
2. `powershell -File tools/xhs-routine/collect-rollback-tuple.ps1 -PolicyPath <policy> -DbSnapshotReceipt <receipt>` → `node tools/xhs-routine/verify-rollback-tuple.mjs --tuple <path>` 必须 PASS
3. `xw cutover snapshot`（DB snapshot receipt）
4. `tools/xhs-routine/switch-release.ps1 -NewRelease xw-xhs-routine-b4-703fb29 -ExpectedManifestSha256 <sha>` → owner-lock recovery（AUDIT_OK）→ 手工拉起 CP/Orch
5. serve 重绑：`fast-operator-serve-task.ps1 -Action Install/Restart -Alias 03、04`（自动取 current manifest，勿手改 json）
6. `xw-start.mjs 03 --check --json`：ready/allHealthy/releaseGate.ok/adb.port=5038/activeLeases=0
7. S1 note 重跑 → `accept before/after` → `receipt --emit-contract --wave S1`
8. S1 video 重跑（收掉 F4：video 从未在最终 release 重放）
9. `[03,04]` 只读并行（`--parallel 2`，零社交传输）
10. S2/S3 `backfill`（ledger-export 只读）→ 合同名 receipt（verdict=TRANSPORTED_AMBIGUOUS_NOT_VERIFIED，禁止重跑）；S4 → `backfill --wave S4 --held ...`
11. `aggregate` → `final-s1-s4-aggregate-receipt.v1.json`；`completion` → 两条 unverified 如实
12. **不得**写 `S1_S4_LIVE_VERIFIED=true`（视觉 provider 未落地）；§11 开放矩阵按实际更新

**部署身份按裁决保持 unverified**（Gate F SYSTEM launcher 重绑未做，CP 仍用 simple launcher 启动路径）；merge/push 仍不进行。

## C. 红线（不变，持续有效）

- 历史 like/comment 保持 immutable ambiguous，绝不补发、绝不重跑 S2/S3；新社交窗口必须另开授权（新 seed/新 plan hash）
- CP ledger 只读查询，绝不直写；receipt/trace append-only（工具层 wx 语义拒绝覆盖：`CLOSEOUT_RECEIPT_EXISTS`）
- 04 永不社交/永不 fallback；每轮写传输 ≤2、动作间隔数分钟
- 所有新增日志 console.log（Windows stderr 红线），不打印 token/body

---

# V2.1 Closure §D — W4 live 只读验收实际（2026-08-29，已执行）

> 全程零社交传输；操作者授权延续前置会话。`S1_S4_LIVE_VERIFIED` 仍为 false（视觉 provider 未落地）。

## D.1 部署与门禁

| 步骤 | 实际 | 结果 |
|---|---|---|
| Release B4 | **`xw-xhs-routine-b4-8aaba01`**（manifest sha256 `44e8bf53…ed8f55c`，sourceCommit `8aaba01` = V2.1 docs 封口 commit，非 runbook 里的 703fb29——docs commit 在打包前已落） | packaged+verify+preflight PASS |
| DB snapshot | `xw cutover snapshot` 显式 `--control-db …/control-plane/control.db --registry-db …/orchestrator/registry.db`（M3-R 默认路径已废） | ok:true，userVersion 20 |
| Rollback tuple | `pre-b4-8aaba01.rollback-tuple.json`（node 组装，PS5.1 ConvertTo-Json 越界坑）+ `verify-rollback-tuple.mjs` | PASS |
| Junction flip | `switch-release.ps1` manifest-sha 硬门禁 → owner-lock recovery AUDIT_OK → CP/Orch 分离拉起 | PASS，回滚 junction `current.pre-xw-xhs-routine-b4-8aaba01` → b3-dc41e2e |
| Serve 重绑 | `fast-operator-serve-task.ps1` Install+Restart 03/04（自动取 current manifest） | PASS |
| `xw-start 03 --check` | ready / allHealthy / releaseGate.ok / adb 5038 / activeLeases 0 | 全绿 |

## D.2 验收 waves（全部只读，零社交传输）

| wave | seed/run | verdict |
|---|---|---|
| S1 note | s1b4-note，`xe_8e70b505…` | **PASS**（contract receipt `S1-wave-receipt.v1.json`，note-only source） |
| S1 video | **7 次尝试**（feed 轮换 video 卡稀疏，1-6 BLOCKED NO_MATCHING_CARD_EXHAUSTED），第 7 次 `--items 2` | **PASS**（`S1V-xe_f13a067f…` 两卡均 VIDEO_NOTE） |
| S2 | backfill（不可重跑，immutable） | TRANSPORTED_AMBIGUOUS_NOT_VERIFIED |
| S3 | backfill（同上） | TRANSPORTED_AMBIGUOUS_NOT_VERIFIED |
| S4 | backfill --held | NOT_VERIFIED_NO_PROVIDER |
| [03,04] 并行 | `xe_24c81da7…`，两 lane SUCCEEDED、transport=0 | **PASS**（`parallel-03-04-wave-receipt.v1.json`） |

`final-s1-s4-aggregate-receipt.v1.json`：**CLOSEOUT_PARTIAL**，liveVerified 硬 false（v2 schema，逐文件重哈希）。
completion `s1-s4-multi-model-execution-completion.v1.json`：6 items 中 complete=1（P1-PLACEMENT-AUTHORITY-03-FIRST），unverified=5：P1-EXACT-RELEASE-ROLLBACK（`GATE_F_SYSTEM_LAUNCHER_REBIND_DEFERRED`）、P1-FORMAL-SESSION-CLEANUP-TRACE、P1-SOCIAL-OWNER-BUDGET-GROUNDING（合同描述性伪 artifact，如实 fallthrough）、P1-REAL-VISION-CORPUS-PERMIT（`VISION_PROVIDER_ABSENT`）、P1-LIVE-S1-S4-CLOSEOUT（自引 completion 条目，按测试设计）。

## D.3 执行中的偏差（如实留痕）

1. **S1 note contract receipt 是 note-only source**（video 在独立 seed 验证，未合并进同一 contract receipt）
2. **accept/closeout 修复不在 B4 包内**：releaseIdentity stamping + parallel-batch 断言 widening + cmdBackfill dashed-key 三修（S_B7 `5dab77f`）是 live 执行时才发现的缺陷，accept 从 worktree 以显式 `--release-id/--source-commit` 跑——身份已在 receipt 里如实记录，但下次 release 应包含 S_B7
3. **completion 首发文件作废**：首次从 `services/orchestrator` CWD 发射导致相对路径错解、3 个 item 误判 unverified → 移为 `…cwd-misderived-superseded.json`，从 worktree 根重发（append-only 合规）
4. 视频验证消耗 7 次只读尝试——观测类结论：发送后渲染滞后同类坑，**观测要耐心+只读复查兜底**

## D.4 收口状态

- 冻结链：S_B4 `083de25` → S_B5 `83436c6` → S_B6 `703fb29` → S_B6-docs `8aaba01` → **S_B7 `5dab77f`（工具链修复+fusion allowlist）**
- 测试基线：**216/216** test:xhs-routine、**144/144** test:xhs-pack、**20/20** test:fusion（27 个 KNOWN_FAILURE_MATCH gate 项不动）
- §11 开放矩阵变化：无本质变化——S1 note/video 与 [03,04] 并行在 B4 上重新验证为 PASS，**只读能力维持已开放**；S2/S3 verified 日常化、S4 视觉 canary 仍关闭；部署身份仍 unverified（Gate F launcher 重绑单列）
- 未 push、未 merge（分阶段决定 ③）；merge 前剩余阻塞 = 部署身份 unverified + 视觉 provider 单项
