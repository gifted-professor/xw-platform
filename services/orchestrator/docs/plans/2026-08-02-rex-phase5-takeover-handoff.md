# REX-FREEDOM-V1 Phase 5 接手 Handoff（2026-08-02）

> 给接手 agent 的冷启动文档。先读 `AGENTS.md` + `PROGRESS.md` + `CLAUDE.md`（冷启动协议、设备红线、留痕契约），再读本文件。本文件只写「当前在哪、下一步做什么、哪些红线不能碰」。

## 0. 一句话状态

REX-FREEDOM-V1（Review × Explorer：**非支付全自由，唯一硬闸是真金支付 final commit**）Phase 5 离线源码已推进到 **evidence 写链 debt 全覆盖 + legacy pending migration + adapter effect/payment/debt context 注入**；两仓测试全绿，支付/PHC fail-closed 未弱化。**下一步：`effect-firewall.mjs` 非支付松绑**（用户已选定）。

## 1. 仓库与分支

| 仓 | 路径 | 角色 | HEAD | 分支 |
|---|---|---|---|---|
| A | `/Users/a1234/Desktop/Coding/xhs-registry`（Mac，本目录） | registry / 文档 / 计划源 | `8abf108` | `codex/rex-freedom-v1` |
| B | `/Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-device-agent-routing-v1-1`（GPFS） | 控制面源码 + 测试 | `afe3ca6` | `codex/rex-freedom-v1` |

- 两仓都是本地 git 仓库（无 origin，PR 不走远程）。A 仓的 routing/scout/控制面代码不在本仓，在 B 仓。
- 计划文件 + 文件白名单在 A 仓：`docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.md`（计划全文）、`docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.files.json`（白名单，`planSha256=8c19b669511b594fc56b25d5e13c4ddb8a8d1bc73ef58366ab07294849648ebc`）。
- 详细历史进度见 A 仓 `docs/plans/2026-08-01-rex-phase2-to-8-handoff.md`（§8.4 节是 Phase 5 逐项状态）。

## 2. 当前验证状态（接手前先复跑确认）

```bash
# B 仓（控制面）：应 452 pass / 0 fail / 2 skipped
cd /Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-device-agent-routing-v1-1 && node --test 2>&1 | tail -9

# A 仓（registry）：应 96 pass / 0 fail
npm test 2>&1 | tail -8
npm run check   # node --check 三个 .mjs
```

任何接手第一步：复跑这两条，确认绿。不绿先别动新代码。

## 3. 已完成（本会话 + 之前，按时间倒序）

每个 commit 单一职责、red-test-first、green suite、不 squash。B 仓提交（`codex/rex-freedom-v1`）：

| commit | 项 | 摘要 |
|---|---|---|
| `afe3ca6` | §8.4 B5 | adapter `execute`/`verify`/`restore` + recoverJob restore + inspectRecovery 统一收到 `effect`/`payment`/`debt` context。`#adapterEffectContext(job,cap,financialCommit)` helper：`guardFinancialCommit` 结果（此前被丢弃）现注入 adapter。forward-compatible。红灯 2 测。 |
| `4be2307` | §8.4 #1 深层 | `EvidenceStore.writeJson`/`attachFile` 写失败 → debt（nonpayment_v1）+ stub record `{debt:true,evidenceId:null,sha256:null,path:null,bytes:0}` 不抛；legacy rethrows fail-closed。**§8.4 #1 证据写链全覆盖**：appendEvent/initializeRun(manifest)/writeJson/attachFile 四类。红灯 4 + 1 集成。 |
| `4c0c0a6` | §8.1 #4 | `ControlPlane.start` pump 前调 `migrateLegacyPending()`；`#isPaymentLikeJob`（`ambiguous_on_timeout` 或 cap id 命中 `/pay\|payment\|financial\|checkout\|recharge\|transfer\|wallet\|redpacket\|topup\|deposit/i`，歧义归 payment-like）；`onMigrated→#initializeMigratedRun` 为 fresh queued job 补建 evidence run 目录（不补建则 pump 派发时 writeJson ENOENT）。红灯 2 ControlPlane 集成。 |
| `2155a03` | §8.1 #3 | `state-store.migrateNonpaymentWaitingApprovals({isPaymentLike,onMigrated})`：非支付无 trace → `queued_migrated`+fresh queued job（`superseded_by`，idempotency_key `<old>:migrated`，approval_required=0）；有 trace → `queued_migrated`+`MIGRATED_RECONCILE` 不重发；payment-like → 保持 `waiting_approval`。`user_version` 12→13（`jobs.superseded_by` 列）。红灯 4 state。 |
| `7ce3023` | §8.4 #1 | `appendEvent` + `initializeRun` manifest 写失败容错（debtRecorder）。红灯 +6 测。 |
| `fa77081` | B4 接线 | `ControlPlane` 构造器 `policyMode.active` → `this.debtOnLowDisk=true`+`this.evidenceDebt=[]`；`capacityOpts`(记一次 debt)/`capacityBypassOpts`(只解 throw 预检用)；3 assertCapacity 预检 + 5 initializeRun 调用点透传。 |
| `741e550` | B4 | `evidence-store.assertCapacity({externalEffect,debtOnLowDisk,debtSink})` debt 旁路。 |
| `525d2dc`/`b686ed9`/`483e97e`/`ff6458e` | B9 + policy | `policy.mjs` `evaluateCapabilityPolicy(...,{policyMode})` 短路（`active===true`→`{approvalRequired:false,...}`，默认 null=legacy）；4 个非支付审批锁反转（adapters/mission-freedom-acceptance/control-plane-mission/control-plane-core）。 |

A 仓提交：仅文档（`8abf108`/`6f3238d`/`b65bb45`/`5f03664`/`ded25da`/`1a858fa` 等，handoff §8.4 状态更新）。

## 4. 关键架构锚点（改代码前要知道的）

- **policy 短路**：`control-plane/lib/policy.mjs` `evaluateCapabilityPolicy(cap,{canary,invocation,policyMode})`——`policyMode.active===true` → `{approvalRequired:false, externalEffect, effectiveDecisionSource}`；`policyMode=null`（默认/生产）= legacy。三种 POLICY_MODES：legacy（默认）、shadow、nonpayment_v1（仅 fake adapter / 测试 active）。
- **debt 开关**：`ControlPlane` 构造器 `this.debtOnLowDisk = policyMode && policyMode.active===true`（policyMode null 时是 `null` 不是 `false`，测试用 `assert.ok(!legacyF.control.debtOnLowDisk)` 而非 `===false`）。`this.evidenceDebt=[]`，`this.evidence.debtRecorder` 在 active 时被注入。
- **证据写链 4 类 debt 旁路**（`control-plane/lib/evidence-store.mjs`）：`appendEvent`/`initializeRun`/`writeJson`/`attachFile`——debtRecorder 注入时记 `EVIDENCE_WRITE_FAILED`（含 `eventType`）+ 不抛（writeJson/attachFile 返回 stub record）；legacy/支付 rethrow fail-closed。`assertCapacity({externalEffect,debtOnLowDisk,debtSink})` 低盘旁路。
- **adapter context**（`control-plane/lib/control-plane.mjs` `#runJob`）：`context`/`authorizedContext` 现含 `effect`/`payment`/`debt`（`#adapterEffectContext`）；execute 用 `authorizedContext`（含 `leaseAuthorization`），verify 用 `context`（**不含** leaseAuthorization，这是既有非对称，别「统一」掉除非有测试）。
- **legacy migration**：`ControlPlane.start()` pump 前调 `migrateLegacyPending()`；`state-store.migrateNonpaymentWaitingApprovals` 只扫 `status='waiting_approval'`（幂等：已 `queued_migrated` 不再命中）。
- **payment 守卫**：`#runJob` 在 `adapter.execute` 前调 `guardFinancialCommit({...job.params, app, deviceId},{verifyApproval})`，命中 `financial_commit` 无人类签名批准 → 抛 `FINANCIAL_COMMIT_REQUIRES_HUMAN_GATE`（403）。分类器 `classifyFinancialCommit({target,context})` → actionClass `financial_commit|financial_commit_candidate|financial_prepare|financial_observe|unknown`。
- **EffectFirewall**（`control-plane/lib/effect-firewall.mjs`）：按 observed surface 分类（navigation/observation R0 自动；social-effect R2；publish/delete R3 protected；payment R3 payment；risk-control/login/captcha R3 stop；unknown R3 fail-closed）。`decision ∈ {auto,ecp,phc,blocked}`。

## 5. 下一步（用户已选定）：effect-firewall 非支付松绑

**目标**（计划 B3 line 831）：`effect-firewall.mjs` 的 `unknown`/`SNAPSHOT_STALE`/`INTENT_MISMATCH` 在 **nonpayment_v1** 下从 hard `blocked` 改为**自动重观察（debt）**，不阻断非支付探索；**payment / risk-control / login / captcha / publish / delete 仍 fail-closed**。

**红线**（不能破）：
- `payment` surface 任何路径 → `PHC_PAYMENT`，永不松。
- `unknown` surface **紧邻 payment 上下文**（snapshot 带 financial surface 信号 / target 命中金融控件）时仍 fail-closed——别让 unknown 成为绕支付闸的后门。
- snapshot 完全缺失时间戳（`SNAPSHOT_MISSING_TIMESTAMP`）是数据契约违规，不建议归 debt；只放宽「有时间戳但 stale」和「unknown 但非支付上下文」。
- 改完必须确认 `tests/effect-firewall*`、`tests/payment-tripwire.test.mjs`、`tests/mission-*` 的 fail-closed 断言不回退。

**方法**（强制）：
1. `EffectFirewall.classify` 当前无 `policyMode` 参数——加一个（默认 null=legacy，行为不变）。
2. **先写红灯测试**：nonpayment_v1 下 unknown（非支付上下文）/stale snapshot → `decision:"reobserve"`（或 `"auto"` + debt 标记，选一个一致语义）+ 记 evidence_debt；legacy 下仍 `blocked`；payment 上下文下两种模式都 `blocked`。
3. 再改源码，跑 `node --test`，确认 B 全套仍 0 fail。
4. 一次一个 commit，message 写清红线保留点。
5. 触支付相邻逻辑时，逐个确认 `payment-tripwire`/`effect-commit-protocol` 相关测试仍绿。

**白名单**：`control-plane/lib/effect-firewall.mjs` + `tests/*` 在白名单内。若发现必须改白名单外文件（如 `mission-policy.mjs`、`capability-registry.mjs`），**立即停止，只提交计划增补给用户，不能偷偷扩大范围**。

## 6. 其余 Phase 5 未完（按计划顺序，都在 §8.2 NO-GO 红区）

- **B3-deep 余项**：
  - `mission-policy.mjs`：action/target/count/frequency/expiry 从权限门降为上下文/软预算；payment 永远 PHC。
  - `delegation-grant-policy.mjs` / `delegation-grant-runtime.mjs`：grant 退热路径成可选 provenance/revocation metadata；parent grant 缺失/过期不阻断非支付，记 provenance debt。
  - `effect-commit-protocol.mjs`：**注意——`recordEvidence` 当前在生产接线（`control-plane.mjs:789` 的 `createEffectCommitProtocol`）未传，是 test-only/前瞻路径**。线 833「非支付证据写失败继续」要等 recordEvidence 真接进生产才有意义；现在做价值低。接手时先确认是否已接进再决定。
  - `effect-firewall.mjs` surface 拆 financial observe/prepare/candidate/commit（refinement，`payment` surface 已存在）。
- **B6**：`scripts/vision-safety.mjs` 删 publish/send/order/buy/follow blanket 禁词 → 目标控件级 financial-commit 正向识别（接 `classifyFinancialCommit`）；`prompts/xhs-page-classifier.txt` 四级 financial 类别；`scripts/gateway-operator.mjs`/`xiaowei-http-adapter.mjs`/`fast-operator.mjs`/`greenarrow-api.mjs`/`task-runner.mjs`/`xianyu-operator.mjs`/`xhs-watcher.mjs`/`xhs-watcher-launch.ps1` 统一 protected input + run/lease/effect context。
- **B5 余**：5 个 `apps/*/adapter.mjs` 当前只解构既有字段，新 effect/payment/debt 字段已可用；若某 adapter 要用 effect/payment/debt 决策行为，再按需读。`apps/*/capabilities.json` 不能加 `effectClass` 字段（`capability-registry.mjs` 不在白名单，`ALLOWED_FIELDS` 会拒）。

## 7. Phase 6/7（已授权，但 gated）

用户 2026-08-02 原话「继续 phase6 7 授权给你 按照计划推进下去」。**但**：
- Phase 6（Windows 暗部署，shadow 模式）§9.2 前置条件：Phase 5 source 基本完成 + active jobs=0 + active leases=0 + 无运行中 Cursor/Explorer + 两仓 SHA 记录 + governance 无并行改 + reviewed commit clean。**Phase 5 source 未全完前不部署**。
- Phase 6 是生产 Windows 操作（`ssh xhs-windows`、重启 `XhsDeviceRegistry` 计划任务、生成 `xhs.cross-repo-release.v1` receipt）——**hard-to-reverse + outward-facing，部署前必须向用户单独确认 go**，即使有授权。
- Phase 7（alias 01 单机 pilot）：**支付最终提交永远不在 pilot 授权内**；只走到 final commit 前，用 fake/spy 验证最后一步 `transport=0`。Phase 6 GO 后仍需用户单独批准 pilot。

## 8. 红线与约束（接手必守）

- **支付 final commit 永不做真钱**。任何「松绑」只针对非支付；payment/PHC 路径永远 fail-closed。
- **§8.2 NO-GO**：禁简单删 `blocked` 断言、禁手写 DB（用 state-store API + schema migration）、禁旧任务重复发送、禁回滚只能恢复 blanket approval。浅做会破坏 452 绿或弱化支付测试。
- **白名单**：`docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.files.json`（A 仓 B 仓各一份文件列表）。白名单外文件需改 → **STOP，只提交计划增补给用户**。
- **禁 `console.error`**（A 仓 `registry.mjs` Windows bridge 约束，远端把 stderr 当进程挂了信号）；A 仓 HTML 插值一律走 `esc()`。
- **payment signer 私钥**只能从受限文件/系统密钥设施读取，不能出现在 argv/URL/日志/HTML/DB/仓库/fixture。
- **留痕契约**：完成任务三选一必做：①踩坑/配方写知识库（带 `appliesTo`/`verifyMode`）；②改系统状态更新 `PROGRESS.md`；③文档没写的人脑问题写待问项。活干了没留痕=任务未完成。
- **每项源改 red-test-first，一次一个 commit，跑全套确认不回退**。

## 9. 常用命令速查

```bash
# B 仓跑控制面全套测试
cd /Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-device-agent-routing-v1-1 && node --test
# B 仓单文件
node --test tests/control-plane-core.test.mjs

# A 仓 registry
npm test          # node --test，13 集成测试
npm run check     # node --check 三个 .mjs
node registry.mjs --port 17930 --host 127.0.0.1 --control http://127.0.0.1:17920  # 本地起 registry 调试

# 查 Windows 上 registry（经 SSH，只读）
ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/api/health'
ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/api/approvals/pending'

# watchdog 手动一轮
bash watchdog/watchdog.sh
```

## 10. 接手 checklist

1. 读 `AGENTS.md` + `PROGRESS.md` + `CLAUDE.md`。
2. 复跑 §2 两条测试，确认绿。
3. 读本文件 §4 锚点 + `docs/plans/2026-08-01-rex-phase2-to-8-handoff.md` §8.4。
4. 从 §5（effect-firewall 非支付松绑）开始：先红灯，再源码，跑全套，一次一 commit。
5. 任何白名单外改动 / 支付 fail-closed 回退 → 停手，报用户。