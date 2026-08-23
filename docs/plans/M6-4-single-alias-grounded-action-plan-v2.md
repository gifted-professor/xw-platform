# M6-4 单 alias Grounded Action Canary 计划 V2

状态：`SCOPE_CHANGE_REQUIRED`  
风险：`CRITICAL`  
评审授权：`fix-once` 已消费；Plan V2 为本 review unit 的终版，不再自动评审、不得生成 Plan V3。  
实现/live 授权：`false` / `false`

## 1. Plan V2 的精确组成

Plan V2 是一个不可歧义的 composite plan：

1. frozen base：[M6-4-single-alias-grounded-action-plan-v1.md](M6-4-single-alias-grounded-action-plan-v1.md)，SHA-256 `ec5e7e6959e38d150c468c7f8796f5ecf13fc51d8e552f2258503ecff79fe6e1`；
2. 本文件的全部 normative amendments。

发生冲突时本文件优先；未被本文件修改的 Plan V1 条款继续有效。执行者、后续上下文或 handoff 必须同时加载这两个 exact files 并重算 V1 hash，不能只用摘要。评审上下文 SHA-256 为 `12118f7d1c9c4881eee6f97ba63e664a7017025b6383d483e16ed73a9d70bfb1`，冻结 packet SHA-256 为 `cacf63bd61f06dd9962c233146057bcf3e3bec11320280bb1705c08fdc5e4b90`。

外部 critics 在任何 packet disclosure 前因缺少明确外发批准而被安全层阻止；没有内容被发送，也没有伪造外部报告。按 skill 的失败分支，单次本地 `gpt-5.6-sol/max` fallback 重算两份 SHA 后完成整包审查。记录见 [M6-4-review-wave-v1.json](M6-4-review-wave-v1.json)。

## 2. 终态与 owner 决策

技术计划在纳入 §3–§6 后无已知开放 P0/P1，但三个 scope/authority decisions 尚未获得 owner-signed record，因此不得标记 `READY_FOR_EXECUTION`，不得开始 Gate A：

| decision | 推荐选择 | 含义 |
|---|---|---|
| `M6-4-A01` | `ACCEPT` | M6-4 交付 `M6_4_ACTION_CANARY_CLOSED`，真实 `M5 WorkReceipt → ...` trace binding 留到 M6-6；不伪造 M5 receipt，不提前声明 master `M6_4_CLOSED_COMPLETE`。 |
| `M6-4-A02` | `ACCEPT` | 原 M6-C 拆为独立 deploy/rollback 的 M6-C1（M6-4）与 M6-C2（M6-5），不削弱 M6-5 reconcile义务。 |
| `M6-4-A03` | `BOUNDED_READ_TRACE`（推荐） | 允许专用测试账号/设备上的枚举式私有 read-trace（如搜索/浏览历史、recent-app/IME/analytics痕迹），但 public/social/account/security/financial/destructive/settings/draft effects 保持严格为0，并对可观测面做独立pre/post证明。若选择 `STRICT_ZERO_PERSISTENCE`，任何无法独立观察并恢复的 backend/app/device/IME状态都阻断 Gate F。 |

owner decision record 必须绑定 Plan V2 SHA、三个 decision 值、actor、issuedAt、expiresAt/长期有效口径及 `M6-task-brief.md` cross-reference。A01/A02 任一拒绝都返回新的 scope planning；A03 未选则 Gate A 不开始。decision record 只解析本计划已有分支，不构成 Plan V3。

## 3. `M64-AUTH-001` — 精确 ActionSlotSpec authority

裁决：`ACCEPT / P1`。

Plan V1 §4.3/§4.4/§4.6 的 action slot 必须升级为内容寻址的 `xw.m6-action-slot-spec.v1`，每个可能的 `phone_act` slot 至少冻结：

- `scenarioManifestHash/scenarioId/logicalStepId/actionSlotOrdinal/alias`；
- exact `primitive`，只能是七个 server primitives 之一；
- task-level `actionFamily` 与 exact intentRef、intent policy hash；
- `targetKind=block|screen|none` 与 deterministic semantic target-eligibility predicate artifact/hash；
- trusted parameter artifact/hash、allowed app/page/before-state/after-state；
- effect class、预算/节流、redline和verification obligation。

predicate 必须是仓内 versioned declarative DSL/JSON，不执行模型代码，不接受 caller expression。`block` target 除 schema/integrity 正确外，还必须满足 intent-specific semantic predicate，例如 exact role/label class、non-ad、safe region、query/result/page binding和 forbidden-neighbor约束；`screen|none` 必须满足对应 pre-state predicate，不能借合法 targetKind 换 primitive。

`actionSlotSpecHash` 加入 logicalActionId/operationKey derivation，并逐跳绑定到 global claim、candidate/RESERVED/CONSUMED permit、GroundingDecision、dispatchRef、typed transport auth、tx#2 consumptionReceipt、Action Ledger decision fingerprint、verification evidence与GroundedActionReceipt。任一 primitive/intent/predicate/param/hash drift 在counter=0前拒绝。

新增判别性 tests：

- 同 family 跨 primitive substitution；
- 同 primitive 跨 intent/policy substitution；
- integrity/hash有效但语义错误、广告、敏感邻区或错query/page block substitution；
- same logical slot 改 trusted params、predicate或verification obligation；
- receipt/ledger未绑定完整slot spec时completion verifier失败。

## 4. `M64-FRESH-002` — tx#2 与 TCB pre-I/O freshness

裁决：`ACCEPT / P1`。

permit issue 时由 server monotonic clock冻结：

- `frameExpiresAt`及其monotonic映射；
- `dispatchDeadlineMono = min(frame, permit, gate epoch, typed auth expiries)`；
- `uiStateGeneration`、app/package、focus/window、page fingerprint、rotation/display identity与environment-attestation hash。

Plan V1 §4.4 的 tx#2 consume callback 必须重新读取并验证这些字段，且此时 remaining frame TTL 仍≥1s；它把相同值写入 consumptionReceipt。tx#2 之后、adapter counter之前，M6 TCB adapter必须执行一次read-only current-state guard：用实际app/focus/page/rotation/UI generation/environment attestation对比receipt，并检查monotonic deadline。guard成功到raw write调用的p95≤100ms且每次≤250ms；无法在上限内发送时不得调用write。

失败收敛沿用V1 counter规则：guard/deadline失败且counter=0 → `BLOCKED/GROUND_ACTION_ABORTED_NOT_SENT`、false/0、无retry；counter已置1后的任何延迟/异常 → `AMBIGUOUS`、true/1。TCB guard不重定义gate线性化：close与send仍由tx#2共享fence决定；guard只防UI/freshness drift。

新增 fault/mutation tests：

- tx#1→tx#2 DB contention导致TTL不足；
- tx#2前后 focus/page/app/rotation/UI generation改变；
- materialize、counter和raw I/O前分别注入250ms/expiry-boundary延迟；
- wall-clock跳变但monotonic deadline正确；
- stale consumptionReceipt或environment hash；
- counter前与counter后两类证据/ledger/effectStatus分流。

## 5. `M64-ENV-003` — TargetEnvironmentAttestation

裁决：`ACCEPT / P1`。

新增私有内容寻址 `xw.m6-target-environment-attestation.v1`，至少包含：

- alias/device profile/hardware display identity；
- app package、versionCode/versionName、signing-certificate hash；
- OS build fingerprint、安全补丁与UI/accessibility framework版本；
- display size/density/font scale/rotation、locale、theme；
- input method ID/version/layout；
- accessibility dump schema、service/config与关键系统overlay设置；
-专用test account/tenant identity的不可逆hash/ref，不含credential。

200-case provider corpus必须产生 `xw.m6-environment-qualification.v1`，声明 exact supported attestation hashes 或逐字段闭合constraints，并绑定corpus/annotation/provider hashes。locks.v2增加qualification hash；gate v2、run packet、strict frame、decision/permit、tx#2 receipt、after-frame与action receipt都绑定runtime attestation hash。private payload留在Control Plane evidence domain，对外只出现hash/ref。

Gate F activation先独立采集/验证attestation；每个run启动和每个action tx#2/TCB guard再验证。app自动更新、签名/OS/locale/density/font/theme/IME/accessibility drift或qualification外值全部fail closed，不能以provider source未变为理由继续。

新增 mutation：逐字段改变app/OS/display/locale/theme/IME/accessibility/account profile；qualification删一项、扩大wildcard、换corpus但保留provider hash；runtime attestation payload/hash错配；after-frame环境漂移。每项都必须在write counter=0前失败。

## 6. `M64-EFFECT-004` — 明确 effect boundary 与独立 oracle

裁决：`ACCEPT / P1`，并产生 owner decision `M6-4-A03`。

Plan V1 中笼统的“无持久副作用”替换为 versioned `xw.m6-effect-boundary.v1`。每个scenario family必须逐项声明：

- `requiredTransientEffects`：允许的app launch、navigation、read-only open、transient search/filter text、scroll/back；
- `forbiddenEffects`：payment/delete、like/favorite/follow/comment/message/publish、account/auth、draft/save、setting toggle、clipboard/file/permission mutation及manifest外network/write；
- `boundedReadTraceEffects`：可能由read-only交互产生的私有search/view history、recommendation/analytics、recent-app与IME学习痕迹；
- 每一面的independent pre/post source、expected delta、reset obligation、不可观测处理与retention。

所有live cohort只用专用test account/device，window前冻结clean baseline。独立oracle不能从DSH/SUT trace反推，至少覆盖：test account public profile/activity/follow/favorite/like/comment/message/draft面、OS settings/permissions、allowlisted app local state、IME/recent-app state及可取得的backend/account activity。每个family manifest绑定oracle artifact/hash；completion receipt分别报告 `forbiddenEffectCount=0`、`publicEffectCount=0`、实际 `boundedReadTraceEffects` 与reset结果。

A03分支：

1. `BOUNDED_READ_TRACE`：只允许boundary中精确枚举的私有read traces；能reset的在cohort closeout前恢复并独立复核，不能reset但已明确枚举的只允许存在于隔离test account/device并作为残余风险入receipt。任何未枚举、public/account/security/settings/draft effect或oracle缺失使整窗失败。
2. `STRICT_ZERO_PERSISTENCE`：所有app/backend/device/IME持久面都必须有独立pre/post相等证明和恢复能力；任一面不可观测、不可恢复或允许非零delta时 Gate F=`BLOCKED_NEEDS_DECISION`。不得用UI终态、Control Plane ledger或“只读意图”代替证明。

新增 tests：每个effect面expected/actual mutation、oracle missing/stale/self-derived、reset失败、public effect在UI不可见但独立源可见、允许read trace未列举、test account/device identity swap。completion verifier必须对每个scenario family逐面闭合，而不是只看aggregate success。

## 7. 评审裁决与不变项

本轮四项正式finding全部 `ACCEPT`，无 `REJECT/DEFER`，无P2/P3 backlog。它们只补强authority、freshness、environment qualification与effect evidence，不放宽以下V1不变量：

- gate保持CLOSED，本轮无实现、merge、deploy、epoch或live action；
- replay/live profile、gate/decision/capture receipt v1/v2严格分版；
-同一DB fence线性化close/send；global logical-action claim与no-retry不变；
-payment/delete与所有public/social/account effects保持硬阻断；
-M6-2/M6-3历史zero-action/replay证据不变；
-A01/A02未获owner批准前不偷接M6-5/M6-6 scope。

## 8. 终端判定

当前 canonical terminal status：`SCOPE_CHANGE_REQUIRED`。

剩余阻断只有 owner decisions A01/A02/A03；并非外部review缺失而伪造的技术通过。三个decision获得有效记录后，可在不改Plan V2、不再评审的前提下：

1. 重算 composite Plan V2 与decision record hashes；
2. 按CRITICAL handoff规则生成machine-checkable execution contract；
3. 本地validator通过后才可标记 `READY_FOR_EXECUTION` 并生成advisory-only `EXECUTION_ROUTE`。

在此之前，不生成execution contract/route，不授权任何Gate A–F动作。
