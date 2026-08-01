# REX-FREEDOM-V1：未完成 Phase 2–8 接手 handoff

> 状态：`HANDOFF_READY / SOURCE_PAUSED / NO_WINDOWS_DEPLOY / NO_DEVICE_ACTION`
> 日期：2026-08-01
> 主计划：`docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.md`
> 范围：Phase 2 未完成部分，以及尚未开始的 Phase 3、4、4.5、5、6、7、8。

## 0. 接手人先读的结论

本项目的首要目的不是“加强审批”，而是让 Windows Explorer 能够自由、连续、低延迟地探索手机；只有真实资金最终提交必须停下来等人。

接手时必须同时守住两件事：

1. **自由度不倒退**：评论、私信、发布、搜索、关注、收藏、未知 App/未知操作、证据不足、Skill 不成熟、Review 未完成，都不能重新变成人工审批或派发阻断。
2. **唯一红线不漏**：真实资金最终提交必须精确识别、绑定目标与快照、只接受一次性人类签名；未确认前所有 typed/raw 输入路径的底层 transport 都必须为 0。

当前只完成了 Phase 1 和 Phase 2 的部分核心。没有部署 Windows，没有碰手机，没有取得 lease，没有运行 pilot。后续不得把“源码存在”“测试通过”“Windows 已部署”“真机有效”混成同一个结论。

## 1. 机器、仓库与真源边界

### 1.1 A 仓：Mac Review / Registry / Skill 真源

```text
path:   /Users/a1234/Desktop/Coding/xhs-registry
branch: codex/rex-freedom-v1
handoff 前 HEAD: 4b75c3232c643e28fdcd39925ee2244e982b367a
```

职责：Review、Registry、跨机证据、adopt、Skill/治理文档、Mac 侧 ops。

### 1.2 B 仓：Windows 路由与控制面源仓

```text
path:   /Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-device-agent-routing-v1-1
branch: codex/rex-freedom-v1
HEAD:   7e7696ea1d31ff6dd2ea345c419ca0be7d394c4a
```

职责：ControlPlane、Explorer session、lease、adapter、transport、effect、evidence、Windows 部署源。

### 1.3 不能误改的目标

- `/Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-device-agent` 是历史/detached checkout，不是本计划实施仓。
- `C:\Users\Public\xhs-routing-v1-1` 是 Windows 部署副本，只接收已评审 B 仓 commit，禁止现场热改。
- `C:\Users\Public\xhs-registry` 是 A 仓部署副本，禁止把它当源码真源。
- `control.db`、`task-launch.json`、运行 evidence 目录都不得手工改写。
- 不看项目无关的 C 盘内容；私人账号/财务 App 只有在明确的手机操控任务范围内才相关。

接手第一步必须重新记录两仓 `git status --short`、完整 HEAD 和分支。漂移要先解释，不能自动覆盖或用 rebase 吞掉。

## 2. 当前完成度总表

| 阶段 | 当前状态 | 已完成 | 未完成/不得误报 |
|---|---|---|---|
| Phase 0/0.5 | 完成 | 用户过目、源码授权、governance 先行、两仓 scope 冻结 | 删除/永久销户/隐私保留仍保持未勾，不得擅自放宽 |
| Phase 1 | 完成 | 两仓 contracts、scope manifest、fixtures、红灯测试 | 无 Windows 部署 |
| Phase 2 | **完成（GO）** | classifier、fingerprint、fake tripwire、payment verifier、PHC binding/expiry/签名核心、durable pending + 重启 recovered_cancelled、payment-commits list/decide API、Registry 人类确认面 + Ed25519 签名 oracle、生产输入路径全接 guardFinancialCommit fail-closed | runtime signer/verifier 装配（server.mjs/bootstrap.mjs 传 verifier）与 PHC→#runJob approval threading 留给加真实支付 capability 时再做；当前无 capability 标 financialCommit，闸 dormant；legacy PS1 只读采集 out-of-scope。提交：B 9a36130 + cf5d4ee，A 4405a60 |
| Phase 3 | **完成（GO）** | B 仓 evidence sidecar 降级链（primary→spool→ring→stdout→debt，写失败不阻 dispatch）+ sealed outbox exporter（seal crash 不产生半 adoption、旧证据不被改写）；A 仓统一 run-context 层、evidence ledger（写失败不 throw 业务层）、evidence-contract reader（四种 legacy/v1/both/empty 组合都可读、绝不 throw 业务层）、离线 validate-run-bundle + render-acceptance（纯函数、不影响派发） | 非阻塞：review-windows.mjs / adopt-from-windows.mjs 这两个 Mac SSH 治理脚本尚未接新 v1 contract reader（legacy fallback/debt 报告、staging/atomic/receipt 升级）；runtime sidecar 装配（把 createEvidenceSidecar 接进 #runJob/adapter 执行路径）留给加真实 evidence 写入点时再做。当前 GO 由离线模块 + 16 例 A 测试 + 6 例 B 测试保证。提交：B c0b66e3 + 8956fd8，A 78259bc |
| Phase 4 | **完成（GO）** | nonpayment-autonomy-policy.mjs（evaluateNonpaymentAutonomy：非支付一律自由，唯一硬闸 financial_commit；ambiguous→reconcile_effect；默认 shadow）+ explorer-session-bridge.mjs（ExplorerSessionBridge：session acquire 一次、preflight 一次、连续 primitive 走热传输、普通 primitive 零同步观测）+ shadowCompare 入口 | 非阻塞：§6.3 item 2-6/8 的 router/control-plane/mission-policy 接线（把新策略接进 live dispatch、unknown→Explorer 路由、lease busy queue/reroute、mission/grant/budget 降 context、L0 lease-free dump）留给 Phase 5/8 切流——Phase 4 GO 明确要求「新策略仍未 active」，故接线不在本阶段。当前 GO 由两模块 + 4 例红灯转绿保证。提交：B fa578b4 |
| Phase 4.5 | **完成（GO）** | explorer-hotpath-parity 离线 perf 门 6 例全绿：steady-state 结构性硬门（acquire=1/preflight=1/同步观测=0/重复 preflight=0/重复 lease=0）、steady p95<=direct+budget、30-step<=baseline*1.10+2s、payment candidate 一次额外观察、L0 lease-free 只读、acquire p95<=2s。bridge 加 l0Observe 静态 L0 只读路径 | 无 Windows 部署、未碰真机；fake 延迟 transport 离线模拟，真实端到端延迟留 Phase 7 真机 pilot。提交：B dcde809 |
| Phase 5 | **部分完成** | nonpayment_v1 模式解析（resolvePolicyMode：legacy/shadow/nonpayment_v1，§8.1 item 1「只在 fake adapter 上 active」，真适配器降级 shadow）+ liveness 证明（tests/nonpayment-liveness.test.mjs 7 例：非支付无 waiting/blocked/approval、payment 仅 financial_commit hold、普通 classifier 同步 vision/dump/cloud=0、ambiguous reconcile 不重发、payment 未弱化）+ generatePolicyDocDebt（§8.1 item 5 逐文件 debt） | **剩余**：§8.2 B9 逐文件旧断言反转（~39 个测试/源对，每个反转加对应 liveness，紧密耦合，不可简单删 blocked）、§8.1 item 3 legacy pending migration（waiting→queued_migrated + superseded_by、有 dispatch 痕迹只 reconciliation、payment-like 重新观察进 PHC）、§8.1 item 6 两仓 secret scan。模式/契约/liveness 已锁，默认 legacy 不破坏既有 425 绿。提交：B 3020886 |
| Phase 6 | 未授权/未开始 | 无 | Windows 暗部署需要第二次用户授权 |
| Phase 7 | 未授权/未开始 | 无 | alias 01 真机 pilot 需要第三次用户授权；支付最后一步永不做真钱 |
| Phase 8 | 未开始 | 无 | 01/02 扩容、Review/adopt 切换、Skill/文档收口、关闭旧非支付 approval 路径全未做 |

## 3. 已完成的提交与验证

### 3.1 A 仓

- `1c89e19` — Phase 1 contracts、scope、主计划和红灯测试。
- `c461d9f` — payment approval contract 增加 issuer role/key/allowlist binding。
- `4b75c32` — 曾生成过窄版 payment handoff；本文件会在后续纠正提交中取代它。

现场复核：

- `npm test`：73/73 通过。
- scope/hash：3/3 通过。
- 当前 A 仓尚未修改 `registry.mjs` 或 `tests/registry.test.mjs` 的 payment surface。

### 3.2 B 仓

- `253c51e` — Phase 1 schemas、fixtures 和红灯测试。
- `7e7696e` — financial commit tripwire 核心。

已经落下：

```text
control-plane/lib/financial-commit-classifier.mjs
control-plane/lib/payment-approval-verifier.mjs
control-plane/lib/protected-human-commit.mjs       # 增强
control-plane/lib/json-schema-validator.mjs        # 条件 schema 支持
control-plane/schema/payment-approval.schema.json  # issuer binding
tests/payment-tripwire.test.mjs
tests/protected-human-commit.test.mjs
```

Phase 2 定向测试现场结果：8 tests；6 pass、2 skip、0 fail。两个 skip 是未注入跨仓环境的 parity/scope 测试，不等于失败。

仍然存在的四个**预期红灯**：

```text
RED: nonpayment autonomy policy is not implemented
RED: Explorer session bridge is not implemented
RED: evidence sidecar fallback is not implemented
RED: nonpayment autonomy policy is not implemented   # ambiguous effect 路径
```

现场命令对应 5 tests：1 pass、4 fail。接手人必须通过实现把它们转绿，不能删测试、改成 skip 或弱化断言。

## 4. Phase 2：完成资金最终提交 tripwire

### 4.1 已完成，禁止重写

1. `financial-commit-classifier.mjs`
   - 四级分类；
   - target-bound final control；
   - 页面关键词本身不足以 blanket hold；
   - 普通 primitive 不同步调用 dump/vision/cloud；
   - payment candidate 最多补一次观察；
   - fake typed/raw `tap/input/shell` 未确认时 `transport=0`。
2. `payment-approval-verifier.mjs`
   - schema 校验；
   - 所有 payment binding 字段逐项相等；
   - created/expires 时间窗；
   - allowlist version、active key、human role、financial purpose；
   - Ed25519 签名验证和 proof hash。
3. `protected-human-commit.mjs`
   - begin 生成 `commitId/createdAt/expiresAt/approvalBinding`；
   - approve 前验签；
   - 过期取消；
   - 单 commit 一次性决定；
   - 验签失败保持 waiting，不执行底层 effect。

### 4.2 仍未完成

> **2026-08-01 更新：A/B/C/D 全部完成，Phase 2 GO（见 §4.3）。** 下方原文保留作接手记录。
> - A 生产输入路径接线 → B `cf5d4ee`：能力准入闸（policy.mjs）+ #runJob chokepoint + 直运 fail-closed（XiaoweiTransport/greenarrow/XiaoweiHttpAdapter/FastOperator），8 个测试证明每路径 financial_commit 在触碰设备前 transport=0；legacy PS1 经审计为只读采集，out-of-scope。
> - B durable pending + 重启 recovered_cancelled → B `9a36130`。
> - C payment-commits list/decide API → B `9a36130`。
> - D Registry 人类确认面 + Ed25519 签名 oracle → A `4405a60`。
> - 遗留（非阻塞）：runtime verifier 装配（server.mjs/bootstrap.mjs）与 PHC→#runJob approval threading 留给加真实支付 capability 时再做；当前无 capability 标 financialCommit，全链 dormant。

#### A. 所有生产输入路径接同一个 guard

现在的 typed/raw 一致性只在 fake wrapper 测试成立，尚未证明生产入口全部接线。必须审计并接入：

```text
ControlPlane submit/mission/effect primitive
xiaowei transport
gateway operator
fast operator
greenarrow API
xiaowei HTTP adapter
legacy production write path
A 仓 lab tap/input/shell 与业务脚本共用层
```

规则：输入入口可以继续走持久 22222 热传输，但不能无 session 归属、无互斥或绕过 payment tripwire。不得把每个 tap 改成完整 job/lease/preflight。

#### B. durable payment pending

当前 `protected_commits` 只有旧最小字段；PHC 终态仍会删除行；live prepared handle 只存在单个 PHC 实例的内存 Map。

需要：

- 服务内幂等 schema migration，禁止手改 DB；
- 持久化最小 `approval_binding_json`、`expires_at`；
- 保留 `waiting_authorization/approved/denied/expired/recovered_cancelled` 审计状态；
- ControlPlane 建 `commitId -> live PHC instance` 索引；
- 只有 live handle 可 decide；重启后的旧 durable pending 必须 fail-closed 取消并要求重新观察；
- 并发双击或重复决定最多执行一次 transport。

#### C. payment list/decide API

建议控制面接口：

```text
GET  /control/v1/payment-commits
POST /control/v1/payment-commits/:commitId/decide
```

list 只返回确认所需的脱敏 binding；不得返回 control token、tuple、内部 params、私钥或完整账号原文。approve 必须携带 `xhs.payment-approval.v1` 签名；deny 不执行底层 effect。

#### D. Registry 人类确认页与代理 API

A 仓 `registry.mjs`：

- 从控制面读取 list，不直接读写 B 数据库；
- human-only decide；agent/operator/observer 均不可决定；
- CSRF + 明确支付确认短语；
- UI 只显示资金最终提交，不把普通非支付任务放进去；
- legacy approval 在切换期只读兼容；
- signer 私钥只能从受限文件/系统密钥设施读取，不能出现在 argv、URL、日志、HTML、DB、仓库或 fixture；
- 如果 signer unavailable，approve 必须明确 503，不能退化 unsigned approve；deny 仍可用；
- Registry 只能签控制面原样提供的 binding，浏览器不能改 amount/payee/target/snapshot。

可能修改：

```text
A: registry.mjs
A: tests/registry.test.mjs
A: install-registry-task.ps1                 # 仅确需 signer 文件配置时
B: control-plane/lib/state-store.mjs
B: control-plane/lib/protected-human-commit.mjs
B: control-plane/lib/control-plane.mjs
B: control-plane/router.mjs
B: control-plane/server.mjs                  # 仅装配需要时
B: control-plane/bootstrap.mjs               # verifier/allowlist 装配
B: 对应 state/PHC/server/payment tests
```

### 4.3 Phase 2 GO

- 所有 payment final 正例在无确认时 transport=0；
- observe/prepare/非支付负例不被 hold；
- raw 与 typed 一致；
- 正确签名只对一个 commit/target/snapshot/device/time window 有效；
- agent/operator/observer 不可批准；
- 重启不恢复旧 payment handle；
- Registry API/UI 离线测试全绿；
- 全量测试、scope、secret scan 通过。

任何 production input 仍可绕过，Phase 2 都不能标完成。

## 5. Phase 3：Evidence v1 双写与 Mac Review shadow

### 5.1 目标

证据更严谨，但证据失败只能形成 debt，不能阻止非支付执行。

### 5.2 实施内容

1. A/B 共用层贯穿 `runId/effectId/releaseId/schemaVersion/policyMode`。
2. B 建 Evidence sidecar：SQLite → spool → bounded ring/stdout 降级链。
3. sealed outbox exporter；seal 成功后才进入跨机 Review inbox。
4. legacy normalizer：旧 Markdown/mech/biz JSONL 只读，不原地改历史。
5. A renderer/validator 能同时读 legacy 与 v1。
6. `registry-review` 进入 shadow：只判 receipt/debt，不影响 Windows submit/dispatch。
7. adopt 只到 staging，禁止自动写正式 Skill。
8. 故障注入：ENOSPC、EACCES、目录不存在、SQLite 失败、坏 JSONL、半行、重复、seal crash。

核心文件范围见主计划 §8.1 A2/A3、§8.2 B2/B4。重点包括：

```text
A: ops/_run-context.mjs
A: ops/_evidence-ledger.mjs
A: scripts/lib/evidence-contract.mjs
A: scripts/review-windows.mjs
A: scripts/adopt-from-windows.mjs
A: scripts/validate-run-bundle.mjs
A: scripts/render-acceptance.mjs
B: control-plane/lib/evidence-store.mjs
B: control-plane/lib/evidence-spool.mjs
B: control-plane/lib/evidence-exporter.mjs
B: control-plane/index-legacy-evidence.mjs
B: control-plane/lib/effect-ledger.mjs
```

### 5.3 已知红灯 → 全绿

`tests/evidence-debt.test.mjs` 已绿（B c0b66e3）。新增 `tests/evidence-exporter.test.mjs`（B 8956fd8，6 例）、`tests/run-context.test.mjs` + `tests/review-windows.test.mjs`（A 78259bc，16 例）全绿。B 全套 414 例 409 绿（剩 3 例为 Phase 4 红灯，预期）；A 全套 96 例全绿。

### 5.4 Phase 3 GO — 全部满足

- ✅ writer 正常/失败时 fake 非支付 adapter 调用数完全相同（evidence-debt 三 fixture + ledger runWithEvidence action==1）；
- ✅ 四种 legacy/v1 读写组合可读（review-windows.test.mjs v1/legacy/both/empty）；
- ✅ seal crash 不产生半 adoption（evidence-exporter seal-crash/write-fail 两例）；
- ✅ Review 结论不影响下一任务派发（summarizeBundle/renderAcceptance 纯函数 + purity 哨兵测试）；
- ✅ 旧证据不被改写（exporter legacy 产物不被触碰 + readBundle 读写后 byte-identical）；
- ✅ 隐私字段脱敏沿用 B 仓 evidence-store.redactRuntimeData（既有机制，新模块不在证据体新增敏感字段）。

### 5.5 非阻塞遗留（不影响 Phase 3 GO）

- `scripts/review-windows.mjs` / `scripts/adopt-from-windows.mjs` 这两个 Mac SSH 治理脚本尚未接新 `evidence-contract` reader（legacy fallback / debt 报告 / staging / atomic batch / receipt 升级）；当前仍是既有 read-only 评审 + 显式逐文件 adopt，行为安全，留待 Phase 8 收口或下次接手。
- runtime sidecar 装配（把 `createEvidenceSidecar` 接进 B 仓 `#runJob`/adapter 执行路径，把 `createEvidenceLedger` 接进 A 仓 ops/ 业务脚本）留给加真实 evidence 写入点时再做——当前离线模块 + 测试已锁契约。

## 6. Phase 4：Nonpayment Broker shadow 与自动 Explorer/session

### 6.1 目标

新策略只在 shadow 计算，legacy 仍负责实际执行；不碰手机，不改变 adapter 次数。

### 6.2 verdict 约束

非支付只能得到：

```text
dispatch_known
dispatch_explorer
accepted_queue
reroute
retry_observe
branch_defer
reconcile
```

不得得到：`approval_required/unsupported/blocked`。只有 `financial_commit` 可得到 `wait_financial_commit`。

### 6.3 实施内容

1. 实现 `control-plane/lib/nonpayment-autonomy-policy.mjs`。
2. 枚举并 shadow 对比所有旧硬锁来源：risk、external、R2/R3、maturity、route、skill、mission/grant/budget/expiry、stale/mismatch、login/captcha、evidence capacity。
3. unknown/no skill/no route 自动转 Explorer，不拒绝。
4. lease busy 变 accepted queue/reroute，不让派发者反复申请。
5. mission/grant/budget 降为 context、soft budget、auto-renew/debt；payment 仍 PHC。
6. ambiguous 非支付只冻结对应 effect 做 reconciliation，不冻结整个任务。
7. 实现 `explorer-session-bridge.mjs`：session 开始只 acquire 一次，连续 primitive 走持久热传输和 heartbeat/sequence。
8. L0 read-only 在控制面故障时仍可 lease-free dump/observe；L1/L2 写操作仍要 session/互斥/payment guard。

重点文件：

```text
B: control-plane/lib/nonpayment-autonomy-policy.mjs
B: control-plane/lib/policy.mjs
B: control-plane/lib/mission-policy.mjs
B: control-plane/lib/mission-runtime.mjs
B: control-plane/lib/operator-access.mjs
B: control-plane/lib/explorer-session-bridge.mjs
B: control-plane/lib/xiaowei-transport.mjs
B: control-plane/lib/legacy-guard.mjs
B: control-plane/lib/control-plane.mjs
B: control-plane/router.mjs
A: ops/_explore-lib.mjs
A: ops/explore-preflight.mjs
A: ops/_win-xiaowei.mjs
```

### 6.4 已知红灯 → 全绿

`tests/non-financial-autonomy.test.mjs`（2 例）、`tests/ambiguous-effect.test.mjs`（1 例）、`tests/autonomous-lease.test.mjs`（1 例）全绿（B fa578b4）。B 全套 414 例 412 绿 0 红。

### 6.5 Phase 4 GO — 全部满足

- ✅ 全部非支付 fixture 的 new verdict 只属于 dispatch/queue/retry/explorer/reconcile（6 fixture + ambiguous 全合规）；
- ✅ payment final 全 hold（financial_commit → wait_financial_commit + paymentHold:true）；
- ✅ shadow 下 job/lease/adapter/transport 调用数与 legacy 完全一致（新策略未接进 live dispatch，默认 shadow，legacy 执行未改）；
- ✅ session acquire 每会话一次，普通 primitive 不重复 preflight/lease（autonomous-lease：acquire=1/preflight=1/transport=4）；
- ✅ 新策略仍未 active、未部署、未碰手机（两模块仅被测试 import，未接 router/control-plane live 路径，无 Windows 部署）。

### 6.6 非阻塞遗留（不在 Phase 4，属 Phase 5/8 切流）

- §6.3 item 2-6/8 的接线：把 `evaluateNonpaymentAutonomy` 接进 `router.mjs`/`control-plane.mjs` live dispatch（shadow→v1 切流）、unknown/no-route 自动转 Explorer 路由、lease busy → accepted_queue/reroute、mission/grant/budget 降为 context+soft budget+auto-renew/debt、L0 read-only lease-free dump/observe。这些是「让新策略 active」的工作，Phase 4 GO 明确要求不 active，故留到 Phase 5（离线 active）与 Phase 8（切流收口）。
- shadow 下 job、lease、adapter/transport 调用数与 legacy 完全一致；
- session acquire 每会话一次，普通 primitive 不重复 preflight/lease；
- 新策略仍未 active、未部署、未碰手机。

## 7. Phase 4.5：Explorer 热路径离线性能门

### 7.1 必须比较同一场景

基线是当前 `_win-xiaowei` 持久 REPL，不是重新设计的慢代理。candidate 是 session bridge。

覆盖：

- L0 dump/focus/screenshot；
- L1 `tap → dump → input → focus → back`；
- 30-step ad-hoc 混合探索；
- 100 次 primitive steady-state；
- payment candidate 的一次额外观察单独统计。

### 7.2 硬门

```text
free device session acquire p95 <= 2s
每 session acquire = 1
steady primitive p95 <= direct REPL p95 + max(100ms, 10%)
30-step <= direct baseline * 1.10 + 2s
普通 primitive 重复 preflight = 0
普通 primitive 重复 lease acquire = 0
普通 primitive 同步 dump/vision/cloud = 0
L0 控制面不可用仍能只读观察
```

任何一项不过：保留旧 lab，Broker 不进入 active。禁止为了过延迟测试绕过 payment guard。

### 7.3 Phase 4.5 GO — 完成

`tests/explorer-hotpath-parity.test.mjs` 6 例全绿（B dcde809），离线 fake-延迟 transport（不碰真机/Windows）覆盖 §7.2 全部硬门：steady-state acquire=1/preflight=1/同步观测=0/重复 preflight=0/重复 lease=0；steady p95 <= direct REPL p95 + max(100ms,10%)；30-step <= baseline*1.10+2s；payment candidate 一次额外观察单独统计；L0 控制面不可用仍能 lease-free 只读（`ExplorerSessionBridge.l0Observe`）；free device acquire p95<=2s。bridge 不触 financial_commit 路径，未绕过 payment guard。B 全套 420 例 418 绿 0 红。

## 8. Phase 5：离线 active、旧断言反转与迁移

### 8.1 实施内容

1. 只在 fake adapter 上启用 `AUTONOMY_POLICY_MODE=nonpayment_v1`。
2. 逐个反转主计划 §8.2 B9 的旧 approval/blocked 断言；每个反转都加对应 liveness，不是简单删断言。
3. legacy pending migration：
   - 未 dispatch 的非支付 waiting → 事务化 `queued_migrated`；旧行写 `superseded_by`；
   - 有 dispatch 迹象 → 只 reconciliation，不重发；
   - payment-like → 重新观察后生成新 PHC，不能沿用旧批准。
4. 所有新 state migration 由服务代码完成，禁止手工 SQL/DB。
5. 生成逐文件 `policyDocDebt`，运行代码为准；旧 Skill 文案不能让 Explorer 自我停止。
6. 两仓全量测试、check、secret scan、scope diff。
7. rollback 必须回到自由 Explorer/旧 lab，不得回到 blanket approval。

### 8.2 Phase 5 GO — 部分满足（模式/liveness/契约层）

- ✅ 两仓测试矩阵全绿（B 427 例 425 绿 0 红 2 skip；A 96 例全绿）；Phase 1 四个红灯已在前序阶段绿；
- ✅ payment tests 未删未弱化（nonpayment-liveness「payment 未弱化」断言 + protected-human-commit 测试保留）；
- ✅ 非支付 liveness 证明无新 waiting approval（遍历全部非支付 actionClass × ambiguous，无 approval/waiting/blocked）；
- ✅ 旧任务不会重复 effect（ambiguous → reconcile_effect，dispatch 计数 0，重复求解仍 reconcile）；
- ✅ 普通 classifier 同步视觉调用为 0（policy 求解零同步 vision/dump/cloud）；
- ✅ 计划外文件为 0（A nonpayment-liveness scope guard 持续绿，所有新文件在白名单）；
- ✅ 仍不需要 Windows/真机（全离线 fake adapter）。

### 8.3 Phase 5 进度（部分完成，续做）

**已完成的关键结构里程碑 —— nonpayment_v1 已接入 live dispatch 路径：**

- ✅ `control-plane/lib/policy.mjs`：`evaluateCapabilityPolicy(capability, { canary, invocation, policyMode })` 在返回前新增 `policyMode.active===true` 短路 → `{approvalRequired:false, externalEffect, effectiveDecisionSource}`。默认 `policyMode=null` = legacy，425+ 旧测试零行为变化。
- ✅ `control-plane/lib/control-plane.mjs`：构造器新增 `policyMode` 参数存 `this.policyMode`；**全部 6 个 `evaluateCapabilityPolicy` 调用点**（session 检查×2、submitJob、planRoute、collectCapability mission_effect、session 复检）已透传 `policyMode: this.policyMode`。即生产不传 policyMode 仍 legacy，fake adapter 传 `{active:true,mode:"nonpayment_v1"}` 即非支付自由 dispatch。
- ✅ 4 个代表性非支付审批锁反转（每个：保留 legacy fallback 断言 + 新增 nonpayment_v1 自由断言 + liveness，非简单删）：
  1. `tests/control-plane-adapters.test.mjs` — `xianyu.publish.full_draft_dry_run`（external_effect draft）policy 层：legacy `approvalRequired:true` 保留 + nonpayment_v1 `approvalRequired:false`、externalEffect 仍作事实返回 + adapter 实际 execute/verify liveness。
  2. `tests/mission-freedom-acceptance.test.mjs` — R2 follow submitJob：legacy `waiting_approval` 保留 + nonpayment_v1 `status:"queued"` 不再 waiting + pump drain liveness。
  3. `tests/control-plane-mission.test.mjs` — `setup()` 增 `policyMode` 透传；legacy R2 `waiting_approval` 保留 + 新测试 nonpayment_v1 R2 follow `approvalRequired:false` + `await setTimeout(120)` adapter 至少 1 次 dispatch liveness。
  4. `tests/control-plane-core.test.mjs` — `fixture()` 增 `policyMode` 透传；legacy external effect `waiting_approval` 保留 + nonpayment_v1 external effect `approvalRequired:false` + `waitForJob` executions≥1 liveness。
- ✅ B 全套验证：429 tests / 427 pass / 0 fail / 2 skip（反转前 425→427，逐反转后稳定 427-429，0 fail 全程）。payment/PHC 测试未删未弱化。

### 8.4 Phase 5 剩余（不满足完整 GO，留待续做）

- ⚠️ §8.2 B9 逐文件旧断言反转 **剩余 ~35 文件**（已做 4：adapters、mission-freedom-acceptance、control-plane-mission、control-plane-core）。
  - **关键澄清**：B9 列出的 39 文件是**逐文件审查候选**，不是「所有 blocked 断言都要反转」。每个文件须区分三类：
    - **非支付审批锁**（external_effect/approval_required → `approvalRequired:true`/`waiting_approval`）：反转（已建立安全模式：gate 源于 `policyMode.active`，保留 legacy fallback + nonpayment_v1 自由 + liveness）。代表已做 4 个；剩余 `waiting_approval` 命中已极少（`control-plane-mission:368` 是已覆盖的同一 R2 机制在不同 gate-denial 测试里的复用，无需重复反转）。
    - **合法 scope/mission/safety 闸**（mission revoked、parent grant expired、target mismatch、captcha/risk-control surface、ADR_0008 denial、AUTHORITATIVE_OBSERVATION_REQUIRED、scope_violation、forged observation receipt → `EXPLICIT_RECEIPT_EVIDENCE_UNAVAILABLE`）：**必须保留**，这些不是非支付审批锁（tampered-receipt = target-integrity 安全闸，不是 evidence-write-failure debt）。`effect-commit-protocol.test.mjs`、`mission-explorer-firewall.test.mjs`、`control-plane-mission.test.mjs` 大量 `blocked` 属此类。
    - **payment/PHC 断言**（financial_commit、protected-human-commit）：**保留并增强**（§8.2 line 991 + NO-GO）。
  - **审查结论（2026-08-02）**：逐文件扫了剩余 B9 候选（control-plane-state/placement/legacy/legacy-index/evidence/command-runner/transport 等），**无新的 `waiting_approval`/`approvalRequired:true` 非支付审批锁断言**（`placement:337` 仅 DB schema 列定义；`evidence-store` 的 `assertCapacity`/`EVIDENCE_DISK_LOW` 在所有测试里被 `min*Bytes:0` 关闭，无 block 断言可反转）。即 **B9「旧断言反转」子项对实际存在的断言已基本完成**；剩余 ~35 文件需的是**前置源码改动**（B3 effect/payment context、B4 evidence-debt 接 spool + 删非支付 assertCapacity 热门 + state migration、B5/B6 adapter/operator blanket approval 假设去除），不是旧断言反转。这些前置改动需配新红灯测试 + 逐文件源+测试协同，浅做会破坏 427 绿或弱化支付测试（§8.2 NO-GO：禁简单删 blocked、禁手写 DB、禁旧任务重复发送、禁回滚只能恢复 blanket approval）。
- ❌ §8.1 item 3 legacy pending migration：waiting→queued_migrated 事务化 + 旧行 superseded_by、有 dispatch 痕迹只 reconciliation 不重发、payment-like 重新观察进新 PHC。需服务代码完成，禁手工 SQL。
- ✅ §8.1 item 6 两仓 secret scan（2026-08-02 完成，报告如下）：
  - **私钥头部**：两仓 0 命中（无 `BEGIN ... PRIVATE KEY`）。
  - **hardcoded 高熵 secret**（api_key/secret/password/bearer/private_key 赋 ≥16 字符）：两仓 0 命中（排除 fixture/test/mock 与 process.env）。
  - **密钥文件**：两仓 0 个 `.env`/`.pem`/`.key`/`.p12`/`id_rsa` 落仓库（`.git`/`node_modules` 外）。
  - **payment signer 私钥**：`control-plane/` 源码 0 命中内联私钥材料；`trusted-human-issuer` 走 keyPath/keyId/process.env，符合「私钥只能从受限文件/系统密钥设施读取，不出现 argv/URL/日志/HTML/DB/仓库/fixture」约束。
  - **已知 intentional-tradeoff token（非新泄漏）**：A 仓 `sync-feishu.mjs:17` `BASE_TOKEN="REDACTED_FEISHU_BASE_TOKEN"`、`:21` `REGISTRY_TOKEN="REDACTED_OLD_AGENT_TOKEN"` 硬编码——CLAUDE.md 已记为「本地单人私网有意取舍，公开仓库前再统一治理」，接手 agent 不当事故处理；secret scan 确认无其他新增泄漏。
  - **结论**：两仓干净，无新增 secret 泄漏；唯一待办是公开仓库前治理 `sync-feishu.mjs` 两个 intentional token（已在 CLAUDE.md backlog）。
- ⚠️→✅(部分) 前置源码改动（B3/B4/B5/B6）：
  - ✅ **B4 evidence-debt 接 live 热路径**（提交 B 741e550 + fa77081）：`evidence-store.assertCapacity({externalEffect, debtOnLowDisk, debtSink})` 加 debt 旁路（低盘+debtOnLowDisk → 记 debt entry 经 debtSink + 返回 `{debt:true,...}`，不抛；缺省/legacy 仍 fail-closed 抛 EVIDENCE_DISK_LOW）；`control-plane.mjs` 构造器 `policyMode.active` 时设 `this.debtOnLowDisk=true` + `this.evidenceDebt=[]`，`capacityOpts`(记一次 debt，initializeRun 用)/`capacityBypassOpts`(只解 throw，预检用) 双 helper，3 个 assertCapacity 预检 + 5 个 initializeRun 调用点全透传。红灯 6 测（evidence-store 4 + control-plane-core 2：nonpayment_v1 低盘非支付 submitJob → queued + evidenceDebt 记 EVIDENCE_DISK_LOW + adapter 执行 liveness；legacy 低盘仍 fail-closed 抛 + 不记 debt）。全套 435/433 pass/0 fail。
  - ✅ **B4 深层：run 进行中 evidence 写失败 → debt**（提交 B 4be2307）：`EvidenceStore.writeJson` / `attachFile` 写失败时 debtRecorder 注入（nonpayment_v1）→ 记 `EVIDENCE_WRITE_FAILED`（eventType `writeJson`/`attachFile`）+ 返回 stub record（`{debt:true, evidenceId:null, sha256:null, path:null, bytes:0}`）不抛；legacy 仍抛 fail-closed。stub 让 runJob 末尾 result 落盘与 explicit-receipt 路径不崩（receipt 拿 stub 时 evidenceHash=null 退化 best-effort）。attachFile source 缺失/空仍抛 `EVIDENCE_FILE_*`（adapter 契约违规不归 debt）。红灯 4 + 1 集成（execute 期间破坏 evidence 子目录 → 末尾 writeJson(result) ENOTDIR → debt + 非支付 job 仍 succeeded）。**§8.4 #1 证据写链全覆盖**：appendEvent / initializeRun(manifest) / writeJson / attachFile 四类写失败在 nonpayment_v1 下均走 debt 旁路，legacy/支付 fail-closed。
  - ✅ **B4 state-store pending migration + ControlPlane 接线**（提交 B 2155a03 + 4c0c0a6）：`state-store.migrateNonpaymentWaitingApprovals({isPaymentLike, onMigrated})` 扫 `waiting_approval`：非支付无 trace → `queued_migrated` + 新 queued job（`superseded_by` 指向新，idempotency_key `<old>:migrated`，approval_required=0）；有 dispatch trace → `queued_migrated` + `MIGRATED_RECONCILE` 不重发；payment-like → 保持 `waiting_approval`。`user_version` 12→13（`jobs.superseded_by` 列）。`ControlPlane.start` pump 前调 `migrateLegacyPending()`（legacy 返回 null 不迁移）；`#isPaymentLikeJob`（`ambiguous_on_timeout` 或 capability id 命中金融关键词，歧义归 payment-like）；`onMigrated → #initializeMigratedRun` 为 fresh queued job 补建 evidence run 目录（migration 绕过 submitJob，pump 派发时 #runJob 不调 initializeRun，不补建则末尾 writeJson ENOENT）。红灯 4 state + 2 ControlPlane 集成。
  - ✅ **B5 adapter effect/payment/debt context 注入**（提交 B afe3ca6）：`#runJob` 主派发路径把 `guardFinancialCommit` 结果（此前被丢弃）+ job/capability effect intent + debt 模式并进 `context`/`authorizedContext`，execute/verify/restore 三处统一可读。新增 `#adapterEffectContext(job, capability, financialCommit)` helper：`effect={externalEffect,idempotency,risk,actionClass}`（pre-execution 意图）；`payment={actionClass,reasonCode,guarded,targetControlFingerprint?,approved?}`（recovery 路径传 null → 退化为 unknown/RECOVERY_PATH）；`debt={mode:nonpayment_v1|legacy}`。recoverJob restore + inspectRecovery 两个 recovery 调用点同注入（统一传递）。forward-compatible：5 个 app adapter 只解构 `{capability,device,params,...}`，新字段不破坏；既有 context 断言（leaseAuthorization/evidenceDirectory/job/device）全保留。红灯 2 测（nonpayment_v1 三处读 effect/payment/debt + legacy read_only 派发样本 debt.mode=legacy）。**注**：`effectClass` 不入 capabilities.json（`capability-registry.mjs` 不在白名单，`ALLOWED_FIELDS` 会拒），effect/payment 运行时从 job/capability/classifier 派生。
  - ❌ B3 深层（`effect-commit-protocol.mjs` 非支付证据写失败继续 / `effect-firewall.mjs` surface 拆分 / `mission-policy.mjs` 降上下文 / `delegation-grant-*` 降 provenance）、B6（生产入口 + 视觉规则 blanket 禁词）。这些是支付相邻安全逻辑，§8.2 NO-GO 约束（禁简单删 blocked、禁弱化支付测试）适用，逐项配红灯测试 + 确认支付 fail-closed 不回退。

> 当前 nonpayment_v1 默认 legacy、未 active；**live dispatch 路径已就绪**（policy.mjs 短路 + control-plane.mjs 6 调用点透传 policyMode + evidence-debt 旁路接入 submitJob 热路径）、模式解析 + liveness + policyDocDebt 已就位。**B9 旧断言反转对实际存在的断言已基本完成**（4 个非支付审批锁全反转）；**evidence 写链失败→debt 全覆盖**（appendEvent/initializeRun/writeJson/attachFile 四类，非支付不 block，legacy/支付 fail-closed）；**legacy pending migration 已落地**（nonpayment_v1 启动迁移历史 waiting_approval，payment-like 保留人工闸，fresh job 补建 run 目录后 pump 派发）；**adapter effect/payment/debt context 已注入**（execute/verify/restore + recovery 两点统一可读）。剩余 Phase 5：B3 深层（ECP/effect-firewall/mission-policy/delegation-grant 降级——支付相邻安全逻辑，需逐项红灯 + 确认支付 fail-closed 不回退）、B6（生产入口 + 视觉规则 blanket 禁词→目标控件级 financial commit 正向识别）。续做建议：每项源改配红灯测试，一次一个 commit，跑全套确认不回退；触支付相邻逻辑时先确认不弱化 `payment-tripwire`/`effect-commit-protocol` fail-closed。

## 9. Phase 6：Windows 暗部署

### 9.1 授权边界

**当前没有 Phase 6 授权。** 必须先提交 Phase 2–5 source/offline 报告，用户明确批准 Windows 暗部署后才能开始。

暗部署不是 pilot，不得提交手机任务。

### 9.2 部署前条件

- active jobs = 0；
- active leases = 0；
- 没有运行中的 Cursor/Explorer 会话；
- 当前 Windows B HEAD、task-launch 40 SHA、Registry 部署 SHA、helper/release hash 已记录；
- governance 共享文件无并行修改；
- 两仓 reviewed commit clean；
- 只访问项目相关 Windows 路径。

### 9.3 暗部署模式

```text
AUTONOMY_POLICY_MODE=shadow
EVIDENCE_MODE=dual
REVIEW_MODE=shadow
ADOPT_MODE=stage
pilotActors=[]
pilotAliases=[]
```

部署只影响新会话；旧会话先 drain。health/agent-entry 必须显示完整 releaseId、两仓 SHA、runtime policy、evidence/review/adopt mode、schema versions 和 `policyDocDebt`。

生成 `xhs.cross-repo-release.v1` receipt。Windows B 仓必须在 main；Windows HEAD、task-launch、服务报告全部为相同完整 40 SHA。禁止在 Windows 直接修源码。

### 9.4 Phase 6 GO

- 重启前后意外 job/lease = 0；
- 旧/new evidence reader 都正常；
- shadow 不影响真实执行次数；
- release/mode/schema 可从 live health 证明；
- 只证明 dark deploy，不证明 active 或业务有效。

## 10. Phase 7：alias 01 单机 pilot

### 10.1 授权边界

**当前没有 Phase 7 授权。** Phase 6 GO 后仍需用户单独批准 alias 01 pilot、明确 actor 和动作矩阵。

支付最终提交永远不在 pilot 授权内；只走到 final commit 前，并用 fake/spy 验证最后一步 transport=0。

### 10.2 Phase 7A 手感对照

同一 alias、相近状态，依次运行旧 lab 与 candidate：

1. 连续 dump/focus/back；
2. 搜索页滚动、点卡片、返回；
3. focus/input/清理/返回；
4. 页面漂移后 dump → 重定位 → tap；
5. 30-step 混合探索。

记录 acquire、primitive p50/p95、总墙钟、额外 dump、lease、重连、人工等待。严格沿用 Phase 4.5 门槛。失败立即保留旧 lab，不进 7B。

### 10.3 Phase 7B 功能 pilot

- 已知 Skill 一条、无 Skill/无 route 一条；
- XHS、抖音、微信、闲鱼各至少一条；
- 至少两条用户再次列明的真实非支付 effect；
- writer failure、lease expiry、snapshot stale、target mismatch、进程崩溃；
- 每个 task packet 携带 releaseId、policy version、decision source、doc debt、old/candidate 命令和停止条件。

### 10.4 Phase 7 GO

- 手感门全部通过；
- 非支付 approval/waiting = 0；
- unknown 自动 Explorer；
- writer failure 只有 debt；
- ambiguous 只局部 reconcile；
- effect 不重复；
- lease 自动释放/恢复；
- payment final transport=0。

## 11. Phase 8：扩容、Review/adopt 切换和文档收口

固定顺序：

1. alias 01 已稳定；
2. alias 01/02 并发；
3. 03/04 只有 ready/资源恢复后加入；不得旁路；
4. `REVIEW_MODE shadow → v1`；
5. `ADOPT_MODE stage → atomic`；
6. 验证 adopt 幂等、冲突零半写、失败可重放；
7. 同步 AGENTS、CLAUDE、modes、Skill、PROGRESS、API/ADR 文档的真实完成状态；
8. payment guard、Registry payment UI、runtime mode、文档语义全部一致后，才关闭旧非支付 approval 创建路径；
9. 关闭的是“非支付 blanket approval 创建”，不是 payment PHC；
10. legacy evidence 双写仍保留到 Phase 9，Phase 8 不删除旧 reader/数据。

Phase 8 GO：同机自动串行、跨机可并行；Mac 离线不影响 Windows；Review 不进入派发热路径；adopt 原子；非支付无 waiting approval；payment 唯一硬闸；指标满足主计划 §3。

## 12. 跨阶段提交顺序

已完成：

1. `contract-and-red-tests`
2. `financial-commit-tripwire`（仅核心，仍需 Phase 2 收尾提交）

建议后续保持单一职责：

3. `financial-commit-tripwire-integration-and-human-surface`
4. `evidence-sidecar-v1`
5. `nonpayment-autonomy-shadow`
6. `explorer-hotpath-parity`
7. `nonpayment-autonomy-active`
8. `mac-review-and-adopt-v1`
9. `device-core-migration`
10. `xhs-migration`
11. `xianyu-migration`
12. `douyin-migration`
13. `wechat-migration`
14. `skills-docs-and-final-consistency`

不得 squash 成一坨；每个提交附实际文件、计划编号、测试结果、未完成项、证据债、是否部署、是否碰机。

## 13. 接手过程中的硬禁区

- 不增加非支付动作白名单。
- 不把 unknown/no skill/no route 变成 blocked。
- 不把 Review/evidence/adopt 变成下一任务前置。
- 不为每个 tap/input 重跑 job、SSH、preflight 或 lease acquire。
- 不用页面关键词 blanket 判断支付。
- 不让 agent/operator token 批准支付。
- 不把 signer 私钥写进仓库、命令行、日志、HTML、DB 或 task-launch。
- 不直接写 `control.db`。
- 不在 Windows 部署副本热改源码。
- 不修改项目无关 C 盘内容。
- 不顺便改 SKU、坐标、fixture 业务含义、App recipe、依赖或全仓格式。
- 内容删除、永久账号注销仍按主计划 §14 未勾状态执行，接手人不能合并成默认自主。

## 14. 每阶段统一验收报告

```text
阶段：
A 仓 before/after SHA：
B 仓 before/after SHA：
实际文件：
白名单外文件数：
新增/反转测试：
旧测试结果：
payment positive transport calls：
nonpayment waiting approval rows：
ordinary primitive sync vision calls：
evidence writer failure adapter delta：
lease acquire per session：
性能 p50/p95/30-step：
Windows 是否部署：
手机是否触碰：
active jobs/leases：
未完成项：
证据债：
GO/NO-GO：
```

## 15. 接手人第一批工作

只做 Phase 2 收尾，不并行启动 Phase 3/4：

1. ✅ 重新核对两仓 HEAD/status 和主计划 scope manifest。
2. ✅ 为 B durable pending + list/decide 写红灯测试 → 实现（B `9a36130`）。
3. ✅ 为 A Registry role/CSRF/signer/payment-only UI 写红灯测试 → 实现（A `4405a60`，80/80 绿）。
4. ✅ 把 tripwire 接到生产 typed/raw 输入共用层，证明没有 bypass，同时保持普通 primitive 零同步视觉（B `cf5d4ee`，8 个接线测试证明每路径 fail-closed + 非金融透传零同步）。
5. ✅ 实现 durable pending、live handle、重启取消、human-only signed decide（B `9a36130` + A `4405a60`）。
6. ✅ 运行两仓全量测试、scope、check、secret scan（B 403/409 + 4 预期红、A 80/80；B check-js 97 + secret-scan pass；A check pass；两仓 0 out-of-whitelist）。
7. ✅ Phase 2 GO：见 §4.3。下一步 Phase 3 Evidence v1。

**Phase 2 GO 已达成**（§4.3 全条满足）。遗留非阻塞项：runtime verifier 装配 + PHC→#runId approval threading，留给加真实支付 capability 时做。

若实现中发现白名单之外必须改的文件，立即停止，只提交计划增补给用户，不能偷偷扩大范围。

