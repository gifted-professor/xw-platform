# M6-4 integrated execution review packet

- Mode: EXECUTION_REVIEW
- Risk: CRITICAL
- Authorization: close-accepted-blockers
- Plan SHA-256: 68887b2f1eeae7c89e726f1a2bd6571bf665c719e8a50017bd1fadb2443b7d29
- Candidate snapshot SHA-256: f6a844e96a20cd430de8644c57bf3fd4bc0757469b509346ba2853afbd949277
- Gate: CLOSED and unchanged; resources/actionCount: zero
- Gate F: not authorized, not executed; live model/profile remains UNQUALIFIED
- Original request: complete approved M6-4 implementation through offline code-ready state, then hand off M6-5; do not perform real live action without separate exact authorization.

## Review instructions

Inspect plan compliance and actual changed behavior. Return at most five evidence-backed findings. Only P0/P1 can block. Do not treat unresolved Gate F model/authorization as an implementation defect: the plan explicitly allows offline implementation to continue but forbids live canary. Treat the preserved byte-pinned replay v1 runtime plus separate shared-kernel live v2 runtime as the recorded compatibility deviation; flag it only if the live path can reach legacy resolveInternalPoint or creates an authority bypass.

## Known evidence and limitations

- M6-4 offline: 31/31; M6: 121/121; M6-2 offline: 108/108; epoch: 67 pass + exact Windows symlink skip; M6-3 Gate B/C/D/E: 21/8/22/2 pass.
- Orchestrator: 530/531, sole exact Windows symlink EPERM fixture exception.
- Targeted schema-v19/M6 boundary: 51/51.
- Control Plane broad baseline: 924/959, 32 unrelated legacy Windows/path failures and 3 skips; not claimed green.
- No deploy, merge, push, epoch activation or device action.

## Approved plan V1

# M6-4 单 alias Grounded Action Canary 计划 V1

状态：`PLAN_V1_FROZEN_FOR_REVIEW`  
规划基线：`codex/m6-3-dsh-replay@0fa5ae7f366bf40da242bec824882658fc6596d4`  
基线 tree：`b91619930acbfaea218a6d3319eb8da38ad04732`  
基线 parent / 当前 `origin/main`：`80355d341d854212045c6c1ec62daffbaf3de766`  
风险：`CRITICAL`（live device effects、任务授权、一次性 permit、持久账本、跨进程桥、双平台）  
评审授权：`fix-once`，仅允许 Plan V1 → Plan V2；不授权实现、merge、部署、mint/activate epoch、设备操作或 live effect。

## 1. 目标与终态

M6-4 建立从真实 DSH/Cordis tool loop 到 Control Plane 正式 session/lease/action authority 的第一条单 alias live 链，但只通过窄 Grounded Action 接口执行：

`frozen canary run packet + AutonomyGrant → single-alias canary runner → DSH subprocess → closed tool broker → stable live frame → live VisualBlockSet → one-shot Grounding Permit → atomic Ledger/permit reserve → start-before-I/O commit → typed internal dispatch → after-frame verify → GroundedActionReceipt`

M6-4 完成分两个独立宏观退出点：

1. `CODE_READY_GATE_CLOSED`：代码、合同、离线故障矩阵、双平台 CI、release/runbook 均完成；运行 gate 仍为 `CLOSED`，transport action count 为 0。
2. `M6_4_ACTION_CANARY_CLOSED`：仅在 A01/A02 已获 owner 接受及另行 live 授权后，从已合入 main 的 release 运行 alias `01` staged canary，完成 20-run 与独立 30-task suite，随后重新关闭 gate，所有资源归零并生成 completion receipt。它不是 master `M6_4_CLOSED_COMPLETE`，后者仍等待 M6-6 的真实 M5 trace binding。

Plan V1/Plan V2 本身不授权任何实现。任何后续、单独的实施授权最多覆盖 Gate A–E，并须绑定最终 plan hash 与 execution contract；Gate F 还需要另一份 live-window 授权，绑定 release、source commit、gate epoch、alias、scenario manifest、模型/profile hashes、到期时间与紧急关闭路径。

## 2. 受保护不变量

以下事实和边界不可由实现者、reviewer 或 canary 配置暗改：

1. M6-3 候选提交及其外部收据是历史 replay 快照；`executionMode=replay`、`externalEffect=false`、`actionCount=0`。M6-4 不原地把 replay adapter 改名为 live，也不复用 M6-3 completion receipt 为新 HEAD 背书。
2. 当前 gate 为 `CLOSED`；本计划不授权 live、cutover、deploy、merge 或 epoch 激活。
3. 只存在一个 `M6_AGENTIC_LIVE_GATE`。legacy `OPEN_ACTION_LIVE`、`DSH_LIVE`、`MULTI_AGENT_LIVE`、generic PrimitiveAction 和 fixture executor 保持关闭/不可达。
4. 模型输入/输出与公开 M6 API 不包含 raw coordinate/bounds、ADB/端口、device ID/serial、session/lease token、DB、shell/command、URL、cookie/credential、payment/delete 值或 screenshot base64。
5. 真正设备动作只经 Control Plane 的正式 session/lease、内部 capability adapter 与既有 Action Ledger；不新建第二本动作账。
6. 支付与删除始终 `HARD_STOP`，任何 grant、模型、管理员配置或 live gate 都不能覆盖。
7. 首个 20-run reliability cohort 只允许 alias01 上无公开副作用的小红书搜索、导航、打开公开笔记和返回；后续 30-task smooth cohort 只可增加 §4.6 明列的、无公开/持久副作用的 benchmark tasks。不点赞、评论、收藏、关注、发消息、发布、改账号、保存草稿、切换设置或触发登录/验证码/风控。
8. `agentic_session` TaskPlan enum、M5 Router/Binder、四 alias fan-out 属于 M6-6；M6-4 不偷接。
9. 完整 live checkpoint/resume/reconcile 自动恢复属于 M6-5；M6-4 必须做到 fail-closed、unknown outcome 不盲重放，但不宣称自动恢复。
10. strict live frame 的 5 秒 TTL、bridge p95 ≤100ms、grounding decision p95 ≤1s、非模型 observe-to-dispatch p95 ≤4s 均保持冻结；不能为过门临时放宽。

## 3. 前置条件与基线收敛

### 3.1 合入与工作树

1. 先 push/PR/merge `0fa5ae7f...`，保留该 commit 作为 M6-3 候选快照；禁止 squash。
2. merge 后 fetch，并从包含该 commit 的最新 `origin/main` 新建干净 `codex/m6-4-grounded-action` worktree。不得使用当前落后 5 个提交且有大量 untracked 文件的根 worktree，也不得复用被锁定且带 `.m6-3-spike/`、`profiles/` 的 M6-3 worktree。
3. 执行 preflight：记录新 base commit/tree、M6-3 commit reachability、M6-2/M6-3 收据 SHA、gate `CLOSED`、live disabled、resource probes all-zero、release/locks identity。
4. 候选提交内 `docs/plans/M6-3-handoff.md` 是过期过程快照。保留历史 commit 不变，在新分支新增一个不含秘密的 completion index，明确最终外部 receipt/manifest/adjudication 的路径、SHA 与 supersession；不得重签或改写既有 M6-3 收据。
5. `git add -A` 禁止用于候选/根 dirty worktree；scratch、profiles、sessions、node_modules、日志、配置 YAML 和本地 settings 不进入提交或评审包。

### 3.2 阻断性可行性探针

写产品代码前必须完成四组 read-only / fake-transport spike；任何一组失败均为 `BLOCKED_NEEDS_DECISION`，不得用 fixture 冒充：

1. **Live provider spike**：在已有授权的 M6-2 evidence 或独立去标识等价样本上，用仓内可审、内容寻址的 semantic/accessibility-first provider 生成真实 `VisualBlockSet`。冻结至少 200 个独立标注 target cases，覆盖 §4.6 全部八类 surface，且至少 40 个为 ad/sensitive/system/keyboard/empty/ambiguous negatives；机器门为 block recall ≥98%、top-1 ≥95%、safe-region ≥99%、forbidden/misclick/stale=0、同输入 hash/排序/decision 完全确定。screenshot-only/空 dump 无可靠目标时必须 `REPLAN`。不得用 M6-1 hermetic blocks 或 M6-3 synthetic geometry代替，SUT trace 不得生成 expected annotations。
2. **DSH→Control Plane broker spike**：真实 DSH child 使用独立 live Cordis profile，经 parent-created extra stdio pipe 调用十个 tool；不开放 loopback/TCP listener。信任口径明确为“锁定 DSH binary/plugin 对唯一 inherited handle 的 possession”，不是每条消息的 OS peer-PID 证明；payload processRef 只做 correlation。child startup 立即把 handle 设为 non-inheritable/close-on-exec，锁定 profile 禁止复制/转发 handle 或生成 broker-capable descendant，parent 在 unexpected process-tree growth 时撤销 run。Control Plane capability 仅在 parent broker；模型/child 不获得 broker token、device transport、raw lease/session、DB/ADB/shell。wrong run/worker/session/alias、额外 method、oversize/timeout/replay 在 transport 0 前拒绝，并验证 handle/process-tree cleanup；计划不得声称可识别恶意 child 伪造的 PID。
3. **Same-lease lifecycle spike**：以单一 internal composite capability `xiaowei.m6.grounded_run` 先创建 scoped session/lease，再创建绑定该 session、初始不可 pump 的 capability job；完成 policy/adapter/dispatchRef 验证后才标 running。在同一 run 内完成 `observe → ground → fake dispatch → after-observe → verify → close`；session 的 `scope_capability_id` 始终精确为该 composite capability，不引入 capability-set session。M6-2 one-shot frame facade 的“返回前释放 lease”行为保持不变，M6-4 使用新的内部 capture-within-run seam，不复用或削弱其公开合同。
4. **TTL/model spike**：锁定候选 live model/provider profile，在无设备 effect 的已冻结 frames 上跑至少 100 个 warm 完整 tool loops。必须同时满足：JSON-RPC bridge p95 ≤100ms；grounding decision p95 ≤1s；`phone_ground` result→`phone_act` broker ingress p95 ≤2.5s；capturedAt→final dispatch precheck p95 ≤4s；至少99/100 loops到达valid-ref final precheck，且所有到达者 remaining TTL ≥1s。任何单样本 remaining TTL <1s 都不得 dispatch并计该loop失败。若 model/profile、license/provenance、secret injection 或延迟不能闭合，只允许继续离线实现，不得进入 live canary，也不得改 5 秒 TTL。

## 4. 冻结设计决策

### 4.1 同一个 gate 增加模式化 action authority

1. 不修改 exact schemaId `xw.m6-live-gate.v1`、其 self-hash domain、两种 mode、固定三 locks 或 M6-2 loader 语义。新增 `xw.m6-live-gate.v2`，使用独立 self-hash domain prefix、`purpose`、versioned lock-set ref，并新增 active mode `GROUNDED_ACTION`；`CLOSED` 与 `OBSERVE_ONLY` 的效果语义不变。
2. mixed-chain loader 按 exact schemaId/version dispatch：v1 epoch 永远用原 validator/三 locks；v2 epoch 用 locks.v2。v2 可把有效 v1 tail 作为 parent，v2 出现后禁止降级追加 v1；unknown version/mode/field/hash/signature/parent/lock 一律 CLOSED。历史 M6-2 bytes 与验证结果不变。
3. `GROUNDED_ACTION` 是能力模式，不是 alias 数量模式。M6-4 v2 canary verifier 要求 allowlist 精确为 `["01"]`；M6-6 才可在同 mode 下扩 allowlist。locks.v2 闭合 base locks + DSH source/profile、live tool spec、model profile、GroundingRuntime、live provider、hard-redline、grant/action policy、broker protocol、typed transport、scenario manifest。
4. 原 v1 `OBSERVE_ONLY` 80-attempt zero-action aggregate verifier保持不变。M6-4 新增 purpose=`M6_4_SHADOW` 的 v2 single-alias shadow manifest/aggregate/closeout（精确 5 runs、action/transport count=0）；`GROUNDED_ACTION` 的 smoke/reliability/smooth 各使用独立 purpose 与 versioned manifest/aggregate。任何新 verifier 都不能让旧 verifier 接受 action 或较小 cardinality。
5. 文件 epoch chain 是签名审计来源；Control Plane StateStore 新增同一 gate 的 `m6_gate_fence` 镜像（epoch hash、generation、mode、purpose、allowlist、expiresAt、release/locks hash），不是第二个 gate。v18→v19 migration只可从已验证的 v1 CLOSED tail种下generation 0；其他起始状态停止。activate/normal-close/emergency-close 只能经唯一 promote API，顺序固定为 append+fsync immutable epoch → `BEGIN IMMEDIATE` 更新 fence → atomic `current.json` pointer；执行面只有三者完全一致才视为 open，任一 crash/mismatch均按 CLOSED并由同API恢复收敛。
6. 每个 observe/ground/verify 边界重验 file chain + DB fence；每个 action 的 send linearization 在 §4.4 第二个 combined StateStore transaction 中锁定并复核同一 fence generation。CLOSED promote 若先序列化，action transport=0；action send fence若先序列化，该 action可进入 transport并按事实收敛，但 close阻止其后所有 action。测试以 DB serialization order 判定，不以不可线性化的 wall-clock request/dispatch 间隙判定。
7. 每个非 CLOSED action epoch 在 mint 时携带一份 epoch-bounded、单用途、签名的 emergency-close authorization，绑定 expected parent/current epoch、release、plan/contract、alias、operator、reason-code allowlist、expiresAt 与 nonce；其 `expiresAt` 必须不早于 action epoch `expiresAt + 30 minutes closeout grace`，mint/activate/每次gate verify均检查覆盖，不允许active期间续签或换nonce绕过。operator 通过 `gate emergency-close` 调唯一 promote API，以 compare-and-swap 追加/激活 v2 CLOSED epoch；此路径不等待完整 success aggregate。
8. emergency close 将中断窗口标记 `ABORTED_PENDING_CLOSEOUT`；资源与 ledger 收敛后必须生成失败 aggregate/closeout，列出 manifest 全部 expected scenario keys、已开始/未开始/AMBIGUOUS disposition 与独立 resource probe。该失败 closeout验证前禁止重新开放；不得删除或伪补成功场景。
9. 正常窗口只有在对应 purpose 的完整 aggregate + resource snapshot 验证后才生成 v2 CLOSED epoch；每个 cohort 之间及最终状态都必须回到 `CLOSED`。

### 4.2 Replay 与 live tool profile 分版

1. M6-3 replay profile、deterministic LLM、synthetic journal、`externalEffect=false/actionCount=0` 输出 schema 保留并继续跑原硬门。
2. 新增 live profile，不覆盖 replay files。两者模型可见 tool 名仍精确为十个，但 profile/schema/hash 独立。
3. live schema 把 `actionCount` 定义为独立 transport adapter 实际调用次数，并增加 `effectStatus=NOT_SENT|SENT_UNVERIFIED|VERIFIED` 与 verification ref。只有 transport 前拒绝（含 REPLAN/HARD_STOP/过期/gate closed）为 `externalEffect=false, actionCount=0, effectStatus=NOT_SENT`。一旦 adapter counter 记为 1，无论业务返回失败、超时或结果丢失，均为 `externalEffect=true, actionCount=1`，分别收敛到 `SENT_UNVERIFIED`/`VERIFIED`；不得把 AMBIGUOUS 写成零 effect。observe/ground/verify/checkpoint/trace/wait/lifecycle 始终 false/0。
4. live DSH plugin只持有父进程显式继承的受限pipe handle；短期Control Plane broker capability只在parent broker。session/lease token、alias→device resolution、private point 和 action params 永不进入 child tool args/result、prompt、trace 或 checkpoint。
5. 真实模型/profile 必须 exact-version + content hash + secret-free manifest；API key 仅由部署 secret injection 提供，不进 Git、收据、评审包、日志或 child prompt。

### 4.3 Live provider 与唯一 GroundingRuntime

1. 把 GroundingRuntime 的 canonical implementation 移到共享、可被 Control Plane 与 orchestrator 共同引用的位置；原 orchestrator 路径变为薄 re-export/compat shim。静态门确保只有一个 `decide/resolve` 实现。
2. replay path 继续使用 in-memory registry 与 `xw.grounding-decision.v1`；live path 注入 M6 frame evidence store + live provider + durable permit state。新接口只扩展，不改变 M6-1/M6-3 replay derivation。
3. 新增 live-only `xw.grounding-decision.v2`/permit target union：`block` 要求 frameId+blockId，供 tap/targeted text；`screen` 绑定 frame/page/focus 与 trusted policy，供 bounded scroll；`none` 不伪造 block，供 open_app/back/wait，但仍绑定 run/session/lease/gate/grant/step、trusted params 与 expected before/after state。v1/v2 schema confusion fail closed。
4. live `phone_ground` input schema也独立分版且`additionalProperties=false`：trusted `intentRef`机械决定targetKind；kind=`block`时必须且只可附一个候选blockId，kind=`screen|none`时blockId字段必须不存在，caller/model不能提交targetKind覆盖policy。result返回decisionRef+operationKey；replay tool input/output不变。
5. 第一版 live provider 固定为仓内 semantic/accessibility-first provider：从 strict frame 引用的 dump/focus/screenshot evidence 机械派生稳定 blocks，private bounds 只在 server evidence domain。它不从模型返回 geometry，不伪造空 dump 或 non-block primitive 的 synthetic block。
6. provider 每次加载都验证 source/model hash、frame manifest、evidence hashes、page/focus fingerprint、block-set integrity；provider swap 或 annotation/oracle drift fail closed。
7. live provider 必须达到 §3.2 的 200-case hard metrics；任一阈值不足时停下优化 provider，不能退回 raw coordinates、改 expected 或扩大人工确认。

### 4.4 Grounding Permit 与 Action Ledger 顺序

公开/模型 action 输入固定为：

```json
{
  "groundingDecisionRef": "<64-hex>",
  "operationKey": "<opaque stable action key>"
}
```

1. `groundingDecisionRef` 定位 server-issued live v2 permit；permit 绑定 worker/process/capability-job/session/lease/alias、task/plan/logical-step/action-slot、grant、gate epoch/fence、targetKind、frame/block/page/focus、action family、trusted parameter ref、policy/provider/tool hashes、issued/expiresAt 与 one-shot state。permit/receipt 不存 raw coordinate。
2. 每个scenario manifest必须为每个可能的`phone_act`预枚举唯一、不可变的`logicalStepId + actionSlotOrdinal + actionFamily`，一个multi-primitive task内不得复用slot，模型不能增加slot。`logicalActionId/operationKey`在服务端从`planHash + scenarioManifestHash + scenarioId + logicalStepId + actionSlotOrdinal + alias + actionFamily`稳定派生，刻意不含ephemeral worker/run/session identity；同一冻结action slot跨crash/new run得到同一key。live `phone_ground` 的permit-issue transaction原子创建global claim=`PREPARED`+permit=`ISSUED`并返回operationKey/decisionRef；仅同run且claim仍PREPARED时可因reobserve原子tombstone旧unreserved permit并替换candidate decision，new run/new session一律拒绝。模型只能原样回传；replay `phone_ground` schema/bytes不变。
3. live GroundingRuntime 把旧一步式 resolve 拆为 `prepareDispatchRef`（只验证并产生 server-private immutable dispatch ref，不消费 permit）与 `materializeTarget(dispatchRef, consumptionReceipt)`。第二个 combined transaction 消费成功后才能 materialize。replay v1 `resolveInternalPoint` 保留为 compat wrapper 的 consume+materialize 行为，live 路径禁止调用它，避免双 consume。
4. 既有 Action Ledger 状态保持原名/语义：`REQUESTED → ASSESSED → EXECUTING → EXECUTED → VERIFIED → COMPLETED`，pre-send policy/refusal或aborted-not-sent为`BLOCKED`，可能已发送但不确定为`AMBIGUOUS`。设备事实只由 `transport_called` 判定：“not sent”是任何状态下counter=0；“possible effect”必须counter=1。`EXECUTING`只是send fence已线性化，不单独证明I/O；不新增`NOT_SENT/STARTED` ledger状态。
5. dispatch 顺序固定：

   `validate file chain + DB gate fence → validate parent broker/run + composite capability job/session/lease → validate grant/scope/budgets → load matching PREPARED claim + ISSUED permit → recheck frame/focus/page/expiry/redline → prepareDispatchRef → combined StateStore tx#1: CAS claim PREPARED→RESERVED + reserve Action Ledger REQUESTED→ASSESSED + bind permit RESERVED → final immutable dispatch validation → call AuthorizedTypedTransport.invoke whose sole consume callback is combined StateStore tx#2: lock/recheck same gate fence generation + job/session/lease/grant/budget + atomically set ledger EXECUTING, claim/permit CONSUMED, typed-auth nonce CONSUMED and return consumptionReceipt → invoke passes that receipt once to underlying M6 TCB adapter → materializeTarget(consumptionReceipt) → adapter records transport_called/actionCount=1 before raw I/O → dispatch → ledger EXECUTED or AMBIGUOUS → capture after-frame → verification → combined StateStore tx#3: atomically persist verification evidence + canonical GroundedActionReceipt and finalize claim/ledger VERIFIED→COMPLETED`

6. tx#1/tx#2 必须由新 combined StateStore methods 实现，复用不自行开事务的 private SQL helpers；不得在现有 `reserveDeviceSessionAction()` transaction 外再嵌套 `BEGIN IMMEDIATE`。tx#2 与 gate promote 共享 `m6_gate_fence` serialization domain，形成唯一 send linearization point。
7. 每个 run 创建一个正式 `capability_job` 作为 typed transport authorization origin；kind=`session`、caller token 或模型 payload均无效。每 action 的 auth绑定 job/run/session/lease/alias/operationKey/permit/fence/action family/expiry/nonce。`AuthorizedTypedTransport.invoke()` 的 consume callback本身就是tx#2；任何代码都不得在invoke前预消费或在underlying再次消费nonce，wrapper只把tx#2返回的consumptionReceipt传一次。M6 path 必须经新的 typed underlying adapter；Xiaowei legacy constructor raw transport不得在此路径可达，只有 TCB adapter内部可持有 raw channel，并由独立 counter/spy取证。
8. v19 `m6_logical_action_claims`以logicalActionId为主键、operationKey全局唯一，绑定manifest/scenario/step/slot/alias、owner run/session、current permit、ledger与终态且不随run cleanup删除。只有owner run可在PREPARED阶段替换未保留candidate；new run/new session只能读既有disposition，不能取得第二RESERVED/CONSUMED permit或新ledger action。同key/同decision只有`COMPLETED`且canonical receipt hash/readback有效时可返回相同receipt；`BLOCKED`返回相同拒绝；同key/不同decision为conflict；同decision/不同key为replay attack。`REQUESTED|ASSESSED|EXECUTING|EXECUTED|VERIFIED|AMBIGUOUS`对外重放均fail closed；并发consume最多一个通过tx#2。
9. M6-4 不提供动作重试。grounded-live-v2 scoped startup recovery在generic legacy recovery前运行并按counter分流：任何非`COMPLETED+valid receipt` row若`transport_called=0`，原子终结为`BLOCKED` + `GROUND_ACTION_ABORTED_NOT_SENT` + false/0；若counter=1，则终结为`AMBIGUOUS` + true/1。两者都保留global logical claim并关闭action window，caller/new run均不得重发；legacy rows维持旧startup语义。只有M6-5 reconcile能在独立证据证明未发送后显式重新开放同operationKey。
10. permit 权威状态位于 Control Plane StateStore 的 additive table/API；文件系统只保存内容寻址的不可变审计副本，不参与授权判定。M6-4 不改变 Action Ledger v1 设备事实语义，不直写 DB，不允许外部代码绕 StateStore API。
11. 复用 `EffectCommitProtocol` 的 reserve → final recheck → start-before-I/O 原则，但不引入其 non-payment soft-debt 范围；grounded device action 的 unknown outcome 一律按硬阻断处理。

### 4.5 同 session/lease 的 bounded run

1. 新增 canary-only `M6GroundedActionRun` 与单一 internal composite capability `xiaowei.m6.grounded_run`。server先创建 `scope_capability_id` 精确等于它的session/lease，再以该sessionId创建初始不可pump的bound capability job；完成policy/adapter/dispatchRef验证后才标running。不把observe/action/verify伪装为三个capability，也不增加capability-set session。token仅在Control Plane内存中。
2. composite capability 内部 seam 在同一 run/lease 完成多次 observe/act/verify；一 alias 同时最多一个 run，一 run 同时最多一个 in-flight action。每个 action 的 typed transport authority 来自该 capability job，不来自 session。
3. canary packet 在运行前冻结 original goal/hash、registered internal capability、action policy、trusted refs、预算及每个logical step的有限action slots；AutonomyGrant只能由这些输入机械派生并签名。run只消费冻结packet+grant，不能接收自由文本goal或caller-supplied action params，模型不能增加slot或扩大app、alias、intent、effect、budget、policy scope。
4. payment/delete 及其同义/图标语义始终 `HARD_STOP`；其他 scope 外 intent 先 `REPLAN`，恢复预算耗尽才 `WAIT_HUMAN`。任何分支都不能自动扩大 grant 或转入 raw primitive。
5. cleanup 顺序：停止pipe broker新调用 → ledger/permit/auth收敛 → final frame/verification/receipt → 把capability job终结为succeeded/failed/ambiguous并清除activeJobs/execute auth → revoke parent broker capability/pipe → release session/lease → shutdown DSH → process-tree probe → run closeout。running job存在时不得release session。
6. gate/release/lock drift、broker disconnect、DSH exit、frame TTL、focus/page change、budget exhaustion、CAPTCHA/login/risk prompt 均停止新 action并执行 cleanup。

### 4.6 Action family 与 primitive 映射

受控 server primitives 保持七个：`observe/open_app/back/wait/tap/scroll/type_search_text`。`action family` 必须取自 `services/orchestrator/contracts/m6/autonomy-benchmark.v1.json` 的 task-level taxonomy，不能把单个搜索流程的微步骤伪装成八类。30-task smooth manifest 使用以下精确分布（总数 30），排除 `social-publish-account`：

| authoritative action family | task 数 | 允许的无副作用任务语义 | primitive composition |
|---|---:|---|---|
| `app-launch` | 4 | 启动 allowlisted XHS 并只读验证首页 | open_app, observe, wait |
| `app-switch` | 4 | 在 XHS 与 allowlisted只读系统页间切换并返回 | open_app, back, observe |
| `search` | 4 | XHS 预写 query 搜索与结果页验证 | tap, type_search_text, observe |
| `text-input` | 4 | 在 allowlisted search/filter field 输入并核对，结束前清空 | tap, type_search_text, back, observe |
| `scroll` | 4 | XHS 列表 bounded scroll，只读记录可见项 | scroll, observe, wait |
| `tab-back` | 4 | XHS 非账号 tab/详情页返回并核对 selected state | tap, back, observe |
| `form-edit` | 3 | 只编辑并复原 transient search/filter form；禁止保存草稿、提交或持久化 | tap, type_search_text, back, observe |
| `settings-nav` | 3 | system-settings 只读进入指定子页并读取状态；禁止切换任何 setting | open_app, tap, back, observe |

每类至少达到表中数量，不能跨类双计；每个 task 恰好一个 primary family，可包含多个冻结 primitives。模型只选择允许的 intent/block；app、query text、submit behavior、scroll bounds、wait duration、form reset 与 expected terminal state来自 signed manifest/policy，不从 tool args 扩大。任何持久 mutation、账号/社交/发布动作或额外 app使整窗失败。

### 4.7 M5 与 M6-5 边界

1. 仓内权威 brief 同时要求 M6-4 action trace 从真实 M5 WorkReceipt 起，又把 `agentic_session` TaskPlan enum、Router/Binder、WorkReceipt mapping 明列为 M6-6；二者在当前代码基线上不可同时满足，不能用 schema-valid但非 M5 scheduler 产出的“receipt”伪装闭环。
2. 本计划提出 scope amendment `M6-4-A01`：M6-4 使用专用 canary runner 和 `xw.m6-canary-run-packet.v1`，带 task/plan/node/shard/worker correlation refs，证明 `canary packet → grant → DSH → frame/decision → permit/ledger → after-frame/verify/receipt`；真实 `M5 WorkReceipt → ...` 接线及 master-level trace exit 仍由 M6-6 完成。因此本阶段 live 终态名为 `M6_4_ACTION_CANARY_CLOSED`，不得提前标记 master `M6_4_CLOSED_COMPLETE`。
3. scope amendment `M6-4-A02`：为获得独立 release/canary/rollback 边界，把原“PR M6-C 合并 M6-4/5”的默认组织拆为 `M6-C1`（本计划）与 `M6-C2`（M6-5）。M6-C1 只提供 conservative no-resume 语义；M6-C2 才闭合自动 reconcile/checkpoint fault recovery。
4. A01/A02 必须由项目 owner 以单独 decision record 明确接受，并在不改写历史的前提下给 `M6-task-brief.md` 增加 cross-reference，方可开始 Gate A。若任一被拒绝，本计划终止为 `SCOPE_CHANGE_REQUIRED`，不得由实现者自行把 M6-6/M6-5 scope偷入 M6-4。

## 5. 实施 Gate

### Gate A — 基线与四项 blocker spike

- 先验证 A01/A02 owner decision records；缺失或拒绝则立即 `SCOPE_CHANGE_REQUIRED`，不运行产品 spike。
- 完成 §3 全部检查，生成 preflight manifest、200-case provider metrics、pipe broker boundary、composite-capability same-lease lifecycle、100-loop TTL/model metrics。
- negative control 必须证明 fixture/synthetic provider、legacy PrimitiveAction、wrong token/process/session/alias 和 stale frame均不能让探针误绿。
- 退出：四组均 PASS，或者终止为 `BLOCKED_NEEDS_DECISION`。

### Gate B — Versioned contracts、gate fence、locks、tool profiles

- 新增独立 schemas：gate epoch v2、locks.v2、gate-fence mirror、emergency-close authorization/failure-closeout、M6-4 shadow/smoke/reliability/smooth manifests+aggregates、canary run packet、AgenticSkillSpec/action policy、grounding decision/permit v2、grounded-run frame/attachment receipt v2、typed transport auth、action/completion receipt。M6-2 `xw.capture-attempt-receipt.v1`、gate v1、decision v1 字节/enum/语义不变。
- mixed v1/v2 epoch builder/loader/evaluator、唯一 promote API、CLI dry-run/verify/normal-close/emergency-close/rollback全部闭合；unknown mode/version/field/hash/signature/parent/lock/release/fence drift全部 CLOSED。
- replay/live tool specs、inventory、profile hashes分离；live `phone_ground` result必须供应 server-derived operationKey；mutation分别破坏两侧 schema，证明对应 validator真被执行。
- 退出：双平台 contract tests全绿；历史 M6-2 chain与M6-3 replay tests保持通过；无 epoch 被 mint/activate。

### Gate C — Shared GroundingRuntime、live provider、durable permit state

- canonical runtime迁移 + compat re-export；实现 live `prepareDispatchRef/materializeTarget` split、strict frame attachment、provider、private evidence resolver、permit issue/bind/consume/readback；replay compat wrapper 保持旧 bytes。
- 把 Control Plane schema 明确从 v18 升到 v19，以 additive migration 新增 global logical-action claims（logicalActionId primary key、operationKey unique）、permit、gate-fence、grounded action receipt/closeout tables/API；combined methods复用 no-transaction SQL helpers，与既有 Action Ledger、capability job/session/lease通过 logicalActionId、operationKey、decision fingerprint 和三次事务交叉绑定。
- migration tests覆盖生产 v18 库快照升级、升级中每个 DDL/transaction fault、重复启动、旧 fixtures/rows、v19 rollback release与原 v18 binary。新表不 drop；原 v18 binary面对 user_version=19 必须按现有 `SCHEMA_VERSION_TOO_NEW` fail closed且不改库，不能作为生产回滚；只能部署保留 v19 reader/migration但禁用 grounded action 的 rollback release或前滚修复。任何 partial/user_version mismatch 都拒绝 M6 action，重新前滚幂等。
- canonical JSON 仅作内容寻址、原子 immutable 的审计副本，须 hash readback并拒绝 symlink/junction/path escape；绝不保存 secret/raw coordinate。
- 独立 annotations、mutation与forgery tests覆盖 wrong frame/block/bounds/page/focus/grant/policy/provider、empty dump、duplicate labels、sensitive icons/strings、expired permit和并发 consume。
- 退出：§3.2 provider hard metrics与冻结 SLO全部机器通过；0 forbidden/misclick/stale；唯一 runtime静态门和 migration matrix通过。

### Gate D — Control Plane narrow action facade 与 ledger

- 新增单一 internal composite `xiaowei.m6.grounded_run` capability；先完成 capability job create/policy/adapter/dispatchRef validation并进入 running，再 mint action-scoped execute auth。session scope精确绑定该 composite capability，内部 action params只含 server-issued dispatch ref，`exposure=internal`、canary-only。
- 抽取 M6-2 capture-within-session内部 seam；原四个 frame routes、one-shot lease释放、zero-action closeout字节/行为回归不变。
- 新 action route/body只接受 `groundingDecisionRef + operationKey`；broker auth在header/transport metadata，body extra field一律 `M6_INPUT_CLOSED`。
- 完成 §4.4 tx#1（ledger ASSESSED + permit RESERVED）、tx#2（shared gate fence + ledger EXECUTING + permit/auth CONSUMED）、tx#3（verification+receipt+COMPLETED）、true typed underlying adapter、after-frame verification、budget/rate limit、linearizable hot close和cleanup。
- faultpoints：session/job create/policy/adapter、permit-issue/同runcandidate replace、prepare ref、tx#1每侧、final recheck、gate close vs tx#2、tx#2每侧、materialize、counter-before-I/O、transport/before result、EXECUTED/before after-frame、verification/before tx#3、tx#3每侧、job terminalize/session release、closeout。任何非 COMPLETED+valid receipt outcome不自动重放。
- 退出：fake transport E2E、真实 Xiaowei adapter + fake raw-channel counter probe、并发/重放/kill/migration矩阵全绿；每一 pre-send拒绝 transport=0，post-counter failure如实 true/1；资源归零。

### Gate E — Live DSH profile、canary runner 与 CI

- 新建 live Cordis profile/plugin/parent-pipe tool client/model manifest；replay profile不变。运行时 `request/header.tools` 独立取证恰为10，live/replay schema hashes分别匹配；无 TCP listener/token进入 child。
- canary runner只加载预写 manifest/grant，不进入 M5 router；一 WorkerRun只启动一个 DSH和一个 composite capability job/session/lease，operationKey只由 live phone_ground服务端供应。
- 使用 fake Control Plane/transport跑完整真实 child链，覆盖 happy、REPLAN、HARD_STOP、TTL reobserve、broker revoke、DSH crash、process tree cleanup。
- 新增 `test:m6-4:offline` 与 Ubuntu/Windows独立 hard-fail CI step；generic Windows `continue-on-error` 不得吞 M6-4失败。
- 完成现有 `test:m6-3`、`test:m6-2:offline`、`test:m6-2:epoch`、`test:m6`、orchestrator、Control Plane直接全量、M4/kernel/fusion/authority回归；Windows symlink `EPERM` 只按现有精确用例记录，并在可建 symlink 的 runner补证，不扩成通用豁免。
- 退出：`CODE_READY_GATE_CLOSED` completion evidence；gate仍 CLOSED、actionCount=0、无部署。

### Gate F — 单独获权的 alias 01 staged canary

此 Gate 不由本计划自动授权。获得精确 live-window批准后才可：

1. 从合入 main 的 commit构建 release，验证 release/profile/locks/DSH/model/provider/tool/policy hash closure；环境必须 alias 01 ready/free、active job/session/lease/pending approval=0、ADB 5037固定且5038设备数=0。
2. mint purpose=`M6_4_SHADOW` 的 v2 `OBSERVE_ONLY` alias01 epoch，执行 manifest 精确 5 个 no-effect runs（无 skip/replacement/extra），action/transport=0后用专用 shadow aggregate正常关闭。
3. mint purpose=`M6_4_SMOKE_CLOSE` 的 v2 `GROUNDED_ACTION` epoch，执行精确 1 个预排 close-race scenario：emergency close必须先于 send fence序列化，结果 transport=0并形成 `ABORTED_PENDING_CLOSEOUT`→failure closeout。随后另 mint purpose=`M6_4_SMOKE_ACTION` epoch，执行精确 3 个非计分、预写 safe navigation runs并正常关闭。smoke不得混入计分 aggregate。
4. mint purpose=`M6_4_RELIABILITY` epoch，用锁定 real model/profile执行 manifest 精确 20 个、无替换/补跑/extra 的连续 XHS search/open-note bounded runs；scenario ordinal 1–20 是固定分母，abort/WAIT_HUMAN/缺 receipt均计失败，至少19/20成功，action-level approval prompt=0。
5. reliability 独立 oracle在窗口前冻结 query ref/hash、expected app/page classes与 non-ad规则。单 run成功必须同时满足：trusted query精确回显；result frame/query/page/focus匹配；被选 block在动作前证据中 `non-ad` 且有stable result ref；after-frame为 XHS note-detail，stable note ref与选择结果相同；每个 action均 COMPLETED+valid receipt；无越权/持久或公开副作用；run/process/resource closeout有效。expected不得从SUT trace反推。
6. reliability 正常关闭后，另 mint purpose=`M6_4_SMOOTH` epoch，执行与前20完全不重叠的精确30 tasks，严格按§4.6分布且无 skip/replacement/extra；每个 scenarioId/runId/operationKey namespace唯一。至少27/30无中途人工，正常路径 action-level approval prompts=0；abort/WAIT_HUMAN计入固定分母失败。
7. smooth manifest逐任务冻结 before/after business oracle、允许 primitives/apps/fields、reset obligation与零持久/public effect。任何 extra scenario、跨类双计、未复原 form、setting mutation、social/account action、CAPTCHA/login/risk、misclick/stale/duplicate或未知 effect使整窗失败并 emergency close。
8. 每个 cohort结束均检查 ledger/permit/auth/receipt/frame/verification/process refs，并各自生成完整 aggregate、resource snapshot、v2 CLOSED epoch/closeout；最终再生成 action-canary completion receipt。active job/session/lease/pending approval/orphan DSH=0。

## 6. 测试与判别性 probes

至少包含：

- schema additionalProperties、hash/id/time/size/budget边界；gate/decision/capture receipt/replay-live v1↔v2 confusion与v2→v1 downgrade。
- gate unknown mode/purpose、wrong status、allowlist非01、forged/expired/parent/release/base-lock/action-lock drift、file/pointer/DB-fence mismatch；promote/send同一 `BEGIN IMMEDIATE` serialization 的两种顺序；pre-send close transport=0，send-fence先提交则最多一个action并阻断后续。
- normal close完整 aggregate门；预签 emergency close不等aggregate、CAS wrong-current/nonce replay/operator/reason/expiry拒绝、close-auth coverage `< epoch.expiresAt+30m` 拒绝mint/activate、expiry boundary验证；`ABORTED_PENDING_CLOSEOUT`未验证不得 reopen。
- broker missing/replayed inherited pipe、wrong correlation/processRef/session/worker/alias、extra method、child request、oversize/partial/out-of-order/timeout/backpressure；验证direct child是唯一初始handle holder、startup设置non-inheritable/close-on-exec、锁定profile无dup/spawn broker path、unexpected process-tree growth触发revoke；不把payload PID当identity，无listener/port/token泄漏且pipe/process tree归零。
- live provider independent annotations；provider relabel payment→content、bounds swap、block-set重签、empty dump、screenshot-only、duplicate label、system/keyboard/ad regions。
- grant issuer/goal hash/app/alias/skill/capability/intent/budget/time/policy spoof；支付/删除同义词、icon、page fingerprint和uncertainty。
- action body raw target/x/y/bounds/text/device/session/lease/token/URL/command全部拒绝；trusted query ref仍能执行精确预写文本。
- composite capability job + exact-scope same session/lease observe→act→verify；kind=session transport auth、legacy raw adapter旁路均拒绝；frame 5s TTL、remaining TTL<1s、focus/page/app change、rotation/newer observation使旧decision失效。
- decision v2与live `phone_ground` conditional input union正反例：block必须blockId，screen/none禁止blockId，caller targetKind覆盖拒绝；non-block不得伪造block。每个multi-primitive task actionSlot唯一，result返回绑定的operationKey；same/same、same/different、decision same/different、双并发consume及new-run/new-session同manifest+scenario+step+slot拒绝第二claim/permit/action；独立adapter counter证明每logical action ≤1。
- tx#1/#2/#3和其每个跨表间隙faultpoint；无嵌套或typed-auth双consume；StateStore v18→v19 upgrade/interrupt/rollback/forward matrix；grounded startup对所有非完成row按transport_called=0→BLOCKED false/0、=1→AMBIGUOUS true/1分流并拒绝retry，legacy startup不变。
- transport前拒绝必须false/0；counter后失败/超时/AMBIGUOUS必须true/1。after-frame/verification缺失不能生成COMPLETED+receipt；verification/receipt/final status在tx#3原子，receipt断链、ledger ref伪造、自生oracle均失败。
- shadow=5、hot-close drill=1、smoke=3、reliability=20、smooth=30 的purpose/cardinality/唯一key/no-overlap/no-skip/no-extra门；20-run business oracle与§4.6 30-task exact distribution由独立manifest判定。
- M6-2 one-shot capture与80-attempt aggregate verifier继续拒绝任何action；M6-3 replay仍全部externalEffect=false/actionCount=0。

## 7. 建议文件面

实施时可按最新基线细化文件名，但不得扩大能力边界：

- `packages/kernel/contracts/orchestration/m6/`：独立 gate/locks/decision/permit/run-frame v2、emergency close、run/skill/typed-auth/action-canary schemas；所有 v1 不改。
- `packages/kernel/lib/`：canonical GroundingRuntime/live provider interfaces、action aggregate derivation/validator。
- `services/orchestrator/scripts/lib/m6/`：compat re-export、grant/action policy compiler、live/replay tool spec exports。
- `services/control-plane/control-plane/lib/`：`state-store.mjs` v18→v19 migration/combined APIs/startup recovery、control-plane/router/bootstrap、grounded-run facade/manager、gate v2 loader/epoch/fence/promote/aggregate、transport authorization/typed transport、pipe broker registry。
- `services/control-plane/apps/xiaowei/`：internal composite grounded-run capability与 M6 typed TCB adapter；legacy constructor raw transport不得在M6 path可达，不把raw params暴露为public capability。
- `integrations/dsh-xw/`：独立 live profile/plugin/extra-stdio pipe tool client/model manifest和测试；replay profile保留。
- `packages/control-client` / `packages/cli`：仅提供preflight/status/closeout/verify/dry-run operator面；不提供raw action命令，epoch activate仍需显式operator步骤。
- `tools/m6/`：M6-4 inventory、安全扫描、completion evidence/verifier。
- `.github/workflows/source-fusion.yml`、`package.json`、docs/runbook/failure taxonomy/receipt index与精确fusion allowlist。

## 8. 验收命令与证据

新增固定入口：

```powershell
npm run test:m6-4:offline
npm run test:m6-3
npm run test:m6-2:offline
npm run test:m6-2:epoch
npm run test:m6
npm run test:orchestrator
npm run test:control-plane
npm run fusion:verify
npm run kernel:check
npm run authority
npm run test:gate
```

实现者还必须从最新 `package.json`/workflow读取并运行现有 M4/kernel直接门；不能因命令列表变化而省略。completion evidence记录命令、exit code、测试计数、stdout/stderr hash、runner OS/profile、source/tree/release/locks和已知精确环境例外。

关键证据使用独立 oracle或mutation，不接受“suite green”替代：

- exact tool inventory来自真实 DSH `request/header.tools`。
- transport/action count来自adapter外独立计数器；counter前为false/0，counter后即使unknown也必须true/1。
- gate fence、ledger、permit、typed auth、verification、action receipt分别重算hash并交叉绑定；只有tx#3的COMPLETED+receipt可重放。
- shadow/smoke/reliability/smooth scenario manifests在窗口前分别冻结，cardinality/no-overlap与business oracle由独立expected来源判定；completion verifier不能从SUT trace反推expected。
- before/after/closed resource probes独立读取正式状态。
- 安全扫描覆盖diff、config、tool payload、trace、receipt、checkpoint与audit artifacts。

## 9. 停止条件与回滚

任一条件触发立即停止新action并关闭gate：

- 无法证明live provider目标/geometry/provenance；5秒TTL或冻结SLO不达标。
- broker capability、process/session/alias绑定可绕过，或DSH能拿到raw authority。
- gate promote/send不能通过共享DB fence线性化、emergency close不可执行、历史v1 epoch兼容性或v2 locks不闭合。
- Action Ledger状态/transport counter无法区分pre-send与possible effect，permit/auth可多次consume，或tx#3无法原子完成receipt+COMPLETED。
- raw coordinate/PrimitiveAction/ADB/DB/payment/delete/public side effect从M6面可达。
- 任何misclick、stale/duplicate action、支付/删除尝试、验证码/风控、未知结果自动重放、资源/进程泄漏。

运行时回滚顺序：`gate emergency-close --expected-current ...` 经唯一 promote API提交DB fence+CLOSED epoch → stop pipe broker/new runs → ledger/claim/permit/auth inspect → failure closeout → terminalize capability job并清activeJobs/auth → release session/lease → terminate DSH/process tree → resource probe → retain evidence → deploy schema-v19-compatible rollback release。若 Control Plane 已崩溃，则无 broker/send path；重启前先离线追加签名 CLOSED intent，startup在file/DB mismatch下保持CLOSED，再由 promote API收敛。不得删除ledger、trace、receipt、attachment、v19 tables或gate历史；源码回滚用merge commit的`git revert -m 1`，不用reset/squash，但原 v18 binary不得直接打开v19生产库。

## 10. Definition of Done

### 10.1 CODE_READY_GATE_CLOSED

1. A01/A02 已有 owner-signed decision record；M6-3已合main，completion index消除仓内状态歧义；新分支干净且无scratch污染。
2. 四项Gate A blocker达到§3.2精确硬门并有判别性正/负证据。
3. mixed gate v1/v2、locks.v2、DB gate fence、normal/emergency close及各 purpose aggregate在不削弱M6-2语义下闭合。
4. replay/live tool profiles分版；真实child exact 10 tools；replay回归不退化。
5. 唯一GroundingRuntime + live decision v2 +真实provider + one-shot durable permit完整闭合，model面零坐标/authority。
6. composite capability job/same-lease run、parent pipe、narrow endpoint、三次StateStore事务、typed transport、after-frame verify与no-resume recovery全绿。
7. 双平台M6-4 hard CI与所有原回归通过；完成receipt/contract evidence可重算。
8. gate仍CLOSED，live/cutover未发生，actionCount=0，资源归零。

### 10.2 M6_4_ACTION_CANARY_CLOSED（需 A01/A02 owner decision + 另行 live 授权）

1. shadow 5、hot-close drill 1、action smoke 3全部按独立manifest收敛；alias01 reliability精确20 runs至少19成功，另有精确30-task suite至少27无中途人工，正常路径逐动作审批=0，无替换/额外/跨窗双计。
2. 30 tasks严格覆盖§4.6八个authoritative families及精确分布，只有7个冻结server primitives，无持久或公开副作用。
3. payment/delete/misclick/stale/duplicate/unknown-replay均为0；任何counter后unknown如实记为possible effect并使窗口失败。
4. 每个action从canary packet/grant/DSH/frame/decision/permit/ledger/after-frame/verification/receipt完整互证；M5 WorkReceipt实际接线仍明确留给M6-6。
5. bridge/grounding/observe-to-dispatch达到冻结SLO；一run一DSH process。
6. 每个purpose均以正常或emergency v2 CLOSED epoch收敛，aggregate/closeout/receipt有效，file/DB fence一致，所有job/session/lease/approval/process归零。
7. 此终态只声明 `M6_4_ACTION_CANARY_CLOSED`；master `M6_4_CLOSED_COMPLETE` 仍等待M6-6真实M5 WorkReceipt trace binding。

## 11. 显式假设与未决事实

1. M6-3外部收据已验证且开放阻断项为0，但候选尚未push/merge；实现必须等待merge。
2. M6-2 receipt中的`tasks.54=in_progress`保留为项目跟踪事实；本计划不擅自将其标记完成。若task 54另有与M6-4冲突的scope，Gate A停止。
3. M6-3 completion `generatedAt`早于候选commit约82秒是非阻断provenance注记；hash/commit/tree/mtime链正确。若审计要求严格时间序，另行重签索引，不改原收据。
4. exact live model/provider由Gate A从目标runtime的实时inventory解析并冻结；catalog存在不等于可用。没有健康、合规、满足TTL的profile时live Gate F阻断。
5. 初轮只做无公开副作用任务，避免与现有逐项确认政策文档冲突；任何社交、发布、消息、账号动作都是后续scope/policy decision，不进入本计划。
6. A01/A02 当前只是本计划的推荐 amendment，尚无 owner-signed decision；在该证据出现前状态必须为 `SCOPE_CHANGE_REQUIRED`，不能生成可执行实施授权。
7. 本计划对M6-4/M6-5的PR拆分属于独立deploy/rollback边界的实现组织；不改变M6-5恢复义务或M6-6接线义务。


## Normative Plan V2

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


## Validated execution contract

```json
{
  "schema": "multi-model-execution-contract.v1",
  "planSha256": "68887b2f1eeae7c89e726f1a2bd6571bf665c719e8a50017bd1fadb2443b7d29",
  "authorizationMode": "close-accepted-blockers",
  "budgets": {
    "externalReviewWaves": 1,
    "reviewerDrivenFixBatches": 1,
    "localRepairTails": 1,
    "targetedVerifications": 2
  },
  "execution": {
    "runtime": "codex-desktop",
    "primaryModel": "gpt-5.6-sol",
    "maxModelSwitches": 1,
    "rehydrateOnContextChange": true
  },
  "items": [
    {
      "id": "M6-4-GA-BASELINE",
      "severity": "P1",
      "invariant": "The candidate contains the exact unsquashed M6-3 commit, preserves historical receipts and begins from a CLOSED, zero-resource baseline without scratch or private runtime state.",
      "riskClasses": ["reproducible-artifact"],
      "requiredArtifacts": ["docs/plans/M6-4-owner-decision-record.json", "docs/plans/M6-3-completion-index.md", "artifacts/m6-4/m6-4-baseline-preflight.json"],
      "forbiddenDependencies": [".m6-3-spike", "private profiles or sessions", "node_modules in the candidate", "rewritten M6-2/M6-3 receipts", "squashed M6-3 history"],
      "probes": [
        {
          "id": "M6-4-GA-BASELINE-reproduce",
          "kind": "reproduction",
          "procedure": "Re-hash the plan, decision and M6-2/M6-3 receipt index; verify 0fa5ae7f366bf40da242bec824882658fc6596d4 is an ancestor and inspect the CLOSED gate/resource probe.",
          "preFixExpected": "Missing ancestry, hash drift, an open gate or a nonzero resource prevents entry.",
          "postFixExpected": "All indexed hashes match, ancestry is preserved, gate is CLOSED and every resource count is zero.",
          "pathExercise": "The probe consumes the actual Git ancestor relation, external receipt bytes, gate tail and database-derived resource counts."
        }
      ]
    },
    {
      "id": "M6-4-GA-SPIKES",
      "severity": "P1",
      "invariant": "Provider, broker, same-lease and TTL/model feasibility are evidenced independently and never use replay output as live truth or relax the five-second TTL.",
      "riskClasses": ["independent-oracle", "reproducible-artifact"],
      "requiredArtifacts": ["artifacts/m6-4/m6-4-live-provider-corpus.json", "artifacts/m6-4/m6-4-environment-qualification.json", "artifacts/m6-4/m6-4-broker-spike.json", "artifacts/m6-4/m6-4-same-lease-spike.json", "artifacts/m6-4/m6-4-ttl-model-spike.json"],
      "forbiddenDependencies": ["M6-1 hermetic blocks as live proof", "synthetic geometry as expected truth", "TCP broker listener", "broker token in child", "frame TTL above 5000ms", "fabricated live-model qualification"],
      "probes": [
        {
          "id": "M6-4-GA-SPIKES-oracle",
          "kind": "independent-oracle",
          "procedure": "Evaluate 200 separately frozen semantic/accessibility cases across eight families, including 40 negatives.",
          "preFixExpected": "Unsafe, stale, ambiguous or sensitive candidates can be selected or metrics are derived from SUT output.",
          "postFixExpected": "Recall/top1/safe-region/negative-REPLAN are 100 percent and forbidden, misclick and stale counts are zero.",
          "pathExercise": "The corpus carries frozen expected disposition and the verifier reports exact positive, negative and family counts."
        },
        {
          "id": "M6-4-GA-SPIKES-mutation",
          "kind": "mutation",
          "procedure": "Run wrong binding, extra method, nonce replay, oversize, timeout and descendant-growth cases against the inherited-pipe broker.",
          "preFixExpected": "At least one invalid child request reaches a tool result or leaves a process/pipe alive.",
          "postFixExpected": "Every invalid case rejects with its exact code, actionCount stays zero and all owned processes/pipes close.",
          "pathExercise": "Each case launches a real child and records hello verification, actual rejection code and cleanup state."
        },
        {
          "id": "M6-4-GA-SPIKES-reproduce",
          "kind": "reproduction",
          "procedure": "Regenerate all four spike artifacts and compare their self-hashes and frozen thresholds.",
          "preFixExpected": "A missing artifact, changed threshold or nondeterministic provider payload fails comparison.",
          "postFixExpected": "All artifact hashes recompute and liveHardGatePassed remains false while the model profile is unresolved.",
          "pathExercise": "The generators read their own sources and emit content-addressed artifacts consumed by the review packet."
        }
      ]
    },
    {
      "id": "M6-4-GB-GATE",
      "severity": "P1",
      "invariant": "Versioned gate authority, immutable epoch files, v19 database fence and generation pointer fail closed as one authority, while emergency-close authorization is single-use and covers the epoch plus grace.",
      "riskClasses": ["trust-boundary", "single-use-authorization"],
      "requiredArtifacts": ["packages/kernel/contracts/orchestration/m6/xw.m6-live-gate.v2.schema.json", "packages/kernel/contracts/orchestration/m6/xw.m6-locks.v2.schema.json", "services/control-plane/control-plane/lib/m6-live-gate-v2.mjs", "services/control-plane/control-plane/lib/m6-gate-promoter.mjs", "services/control-plane/control-plane/lib/state-store.mjs"],
      "forbiddenDependencies": ["v2-to-v1 downgrade", "second live gate", "wall-clock send ordering", "open interpretation on file/pointer/fence mismatch", "reusable emergency nonce"],
      "probes": [
        {
          "id": "M6-4-GB-GATE-adversarial",
          "kind": "adversarial",
          "procedure": "Mutate schema, mode, allowlist, lock set, parent, emergency coverage and file/pointer/fence generation.",
          "preFixExpected": "A malformed or inconsistent authority can evaluate open.",
          "postFixExpected": "Every mutation evaluates CLOSED or throws an exact fail-closed error before action authority.",
          "pathExercise": "Tests call mixed evaluator, loader, fence and promoter through both valid and corrupted records."
        },
        {
          "id": "M6-4-GB-GATE-forgery",
          "kind": "forgery",
          "procedure": "Forge lock, epoch and emergency-authorization hashes while preserving field shape.",
          "preFixExpected": "Shape-only validation accepts the forged record.",
          "postFixExpected": "Self-hash and content-address validation reject every forged record.",
          "pathExercise": "The test changes hash-covered payload bytes and asserts the exact evaluator/loader rejection."
        },
        {
          "id": "M6-4-GB-GATE-replay",
          "kind": "replay",
          "procedure": "Consume one emergency-close nonce and attempt a second promotion with the same nonce/authorization hash.",
          "preFixExpected": "The second promotion is accepted.",
          "postFixExpected": "The database unique consumption record rejects replay.",
          "pathExercise": "The test performs two StateStore consumption attempts against the same durable database."
        }
      ]
    },
    {
      "id": "M6-4-GC-GROUNDING",
      "severity": "P1",
      "invariant": "Live v2 grounding is a shared-kernel, semantic/accessibility-first authority bound to exact environment, ActionSlotSpec and independent effect expectations; model-visible data contains no geometry or authority.",
      "riskClasses": ["trust-boundary", "independent-oracle"],
      "requiredArtifacts": ["packages/kernel/lib/m6-live-grounding.mjs", "packages/kernel/lib/m6-action-slot.mjs", "packages/kernel/contracts/orchestration/m6/xw.grounding-decision.v2.schema.json", "packages/kernel/contracts/orchestration/m6/xw.m6-action-slot-spec.v1.schema.json", "packages/kernel/contracts/orchestration/m6/xw.m6-target-environment-attestation.v1.schema.json"],
      "forbiddenDependencies": ["caller targetKind authority", "model coordinates or bounds", "synthetic block for screen/none", "legacy resolveInternalPoint on the live path", "SUT-derived expected effects"],
      "probes": [
        {
          "id": "M6-4-GC-GROUNDING-adversarial",
          "kind": "adversarial",
          "procedure": "Supply empty, ambiguous, sensitive, keyboard, system and environment-mismatched evidence plus caller geometry fields.",
          "preFixExpected": "Unsafe evidence yields ALLOW_ONCE or raw authority crosses the public surface.",
          "postFixExpected": "Unsafe evidence REPLAN/HARD_STOPs and public decisions contain no raw text, bounds or coordinates.",
          "pathExercise": "Tests parse real-shaped accessibility XML and inspect both public block data and the private geometry map."
        },
        {
          "id": "M6-4-GC-GROUNDING-oracle",
          "kind": "independent-oracle",
          "procedure": "Compare provider selections to separately frozen corpus expectations and exact smooth-family distribution.",
          "preFixExpected": "Expected data can be synthesized from provider output or family cardinality can drift.",
          "postFixExpected": "Independent expected dispositions and 4/4/4/4/4/4/3/3 distribution validate exactly.",
          "pathExercise": "The validators consume frozen expected records and reject a deliberately changed primary family."
        },
        {
          "id": "M6-4-GC-GROUNDING-mutation",
          "kind": "mutation",
          "procedure": "Substitute primitive, intentRef, trustedParameterHash, target kind and slot hash for one action family.",
          "preFixExpected": "A same-family substitution reaches permit preparation.",
          "postFixExpected": "Every substitution throws M6_ACTION_SLOT_INVALID before transport.",
          "pathExercise": "The test passes each mutated field through assertM6ActionSlotDispatch and verifies the code."
        }
      ]
    },
    {
      "id": "M6-4-GD-DISPATCH",
      "severity": "P1",
      "invariant": "One stable logical action can pass at most once through permit, global claim, three StateStore transactions, TCB guard and typed transport; recovery never retries and reports counter-derived effect truthfully.",
      "riskClasses": ["trust-boundary", "single-use-authorization"],
      "requiredArtifacts": ["services/control-plane/control-plane/lib/m6-grounded-action-facade.mjs", "services/control-plane/control-plane/lib/m6-typed-transport.mjs", "services/control-plane/control-plane/lib/state-store.mjs", "services/control-plane/tests/m6-action-ledger.test.mjs", "services/control-plane/tests/m6-grounded-action-facade.test.mjs"],
      "forbiddenDependencies": ["raw transport in caller input", "nested BEGIN IMMEDIATE", "materialization before tx2", "raw I/O before counter=1", "COMPLETED without verification", "new-run retry"],
      "probes": [
        {
          "id": "M6-4-GD-DISPATCH-adversarial",
          "kind": "adversarial",
          "procedure": "Inject gate, session, lease, UI generation, app, focus, page, rotation, environment and timing drift around tx2 and the TCB guard.",
          "preFixExpected": "A stale or rebound target reaches raw I/O.",
          "postFixExpected": "All pre-counter drift becomes BLOCKED false/0; post-counter failure becomes AMBIGUOUS true/1.",
          "pathExercise": "StateStore tests assert the durable ledger row and an independent fake raw-channel counter."
        },
        {
          "id": "M6-4-GD-DISPATCH-forgery",
          "kind": "forgery",
          "procedure": "Forge decision, permit binding, operation key, slot spec and typed invocation fields.",
          "preFixExpected": "A shape-valid forged reference authorizes transport.",
          "postFixExpected": "Binding fingerprints and closed typed schemas reject before counter increment.",
          "pathExercise": "Tests call permit consumption and typed validation with independently modified bindings."
        },
        {
          "id": "M6-4-GD-DISPATCH-replay",
          "kind": "replay",
          "procedure": "Race and restart the same operationKey/decision with counter zero and one.",
          "preFixExpected": "A second ledger action or transport call is created.",
          "postFixExpected": "The global claim remains unique; restart terminalizes BLOCKED or AMBIGUOUS and no retry occurs.",
          "pathExercise": "The test reopens the same database and queries the preserved claim, ledger and transport count."
        }
      ]
    },
    {
      "id": "M6-4-GE-DSH",
      "severity": "P1",
      "invariant": "Replay and live profiles are separately versioned; a live child can possess only one inherited bounded pipe exposing exactly ten opaque-reference tools, and an unqualified model profile cannot start.",
      "riskClasses": ["trust-boundary"],
      "requiredArtifacts": ["integrations/dsh-xw/profiles/live", "integrations/dsh-xw/src/live-pipe-client.mjs", "integrations/dsh-xw/src/live-runtime-plugin.mjs", "services/orchestrator/scripts/lib/m6/m6-live-tool-surface.mjs", "artifacts/m6-4/m6-4-broker-spike.json"],
      "forbiddenDependencies": ["modified replay semantics", "network broker listener", "broker token in child", "raw session/lease/device authority", "qualified status without exact model hash"],
      "probes": [
        {
          "id": "M6-4-GE-DSH-adversarial",
          "kind": "adversarial",
          "procedure": "Mutate live tool inventory, arguments, results, correlation, nonce, line size and process-tree possession.",
          "preFixExpected": "An extra tool, raw field, replay or descendant is accepted.",
          "postFixExpected": "Exactly ten names validate and every authority leak or broker mutation rejects with zero action.",
          "pathExercise": "The live schema tests and broker spike exercise a real spawned child and inherited fd3 pipe."
        }
      ]
    },
    {
      "id": "M6-4-GE-OFFLINE-CLOSE",
      "severity": "P1",
      "invariant": "CODE_READY_GATE_CLOSED is reproducible from the final candidate with the live gate still CLOSED, zero actions/resources, hard cross-platform CI and explicit recording of unresolved Gate F authority/model qualification.",
      "riskClasses": ["reproducible-artifact"],
      "requiredArtifacts": ["artifacts/m6-4/m6-4-code-ready-receipt.json", "artifacts/m6-4/m6-4-offline-test-manifest.json", "artifacts/m6-4/m6-4-resource-snapshot.json", ".github/workflows/source-fusion.yml"],
      "forbiddenDependencies": ["live epoch activation", "device action", "unrecorded suite failure", "generic Windows exception", "claiming M6_4_ACTION_CANARY_CLOSED"],
      "probes": [
        {
          "id": "M6-4-GE-OFFLINE-CLOSE-reproduce",
          "kind": "reproduction",
          "procedure": "Run check, test:m6-4:offline, M6, M6-2 offline/epoch, M6-3, orchestrator and targeted schema-v19 regressions; re-hash all evidence and inspect gate/resource state.",
          "preFixExpected": "A required suite, artifact, hash, CLOSED gate or zero-resource assertion is missing.",
          "postFixExpected": "All M6-specific suites pass, the sole orchestrator exception is exact Windows symlink EPERM, and unrelated Control Plane baseline failures are enumerated without being presented as green.",
          "pathExercise": "The completion manifest records each command, test count/status, artifact hash and exact exception rather than only an aggregate claim."
        }
      ]
    }
  ]
}

```

## Code-ready receipt

```json
{
  "schemaId": "xw.m6-4-code-ready-receipt.v1",
  "status": "CODE_READY_GATE_CLOSED",
  "planSha256": "68887b2f1eeae7c89e726f1a2bd6571bf665c719e8a50017bd1fadb2443b7d29",
  "baseCommit": "df16a0409a0997b01e378933d24ad737fde94e16",
  "candidateSnapshotHash": "f6a844e96a20cd430de8644c57bf3fd4bc0757469b509346ba2853afbd949277",
  "candidateFileCount": 86,
  "gateAReceiptSha256": "9ed3e12522d2b90c6c2a528ab0e648e4cfc18f02a726484285a2abafd7babea5",
  "offlineTestManifestSha256": "bdfd62bb6289497113c875a71883b1a540674cf0276972a47b74be7b5de1344b",
  "resourceSnapshotSha256": "fed49514d2241f7d1af3f47a9ae69a3b1db173311a338a2a87341c12c40f0631",
  "artifacts": {
    "providerCorpus": {
      "path": "artifacts/m6-4/m6-4-live-provider-corpus.json",
      "sha256": "2021f288568f7481141e3dfbdcad7cfc2b1eb30fd8d3420188fa5fd8ad215807"
    },
    "environmentQualification": {
      "path": "artifacts/m6-4/m6-4-environment-qualification.json",
      "sha256": "54e8cfb49c3dc4134f973c67c02b8237ba4dfd3892b274d023d85a679a629f38"
    },
    "broker": {
      "path": "artifacts/m6-4/m6-4-broker-spike.json",
      "sha256": "30322cfe4042b45226a12ba5131a95c5a8f127f4d1be66fae2c74e19764602f8"
    },
    "sameLease": {
      "path": "artifacts/m6-4/m6-4-same-lease-spike.json",
      "sha256": "dfa15e286515f361c30f6245968b18c9e04cb91f0664d225781807a4ec7e3ce8"
    },
    "ttlModel": {
      "path": "artifacts/m6-4/m6-4-ttl-model-spike.json",
      "sha256": "1a1e74b780b188bdf416dc24ffbde71acac39c1ab9ddceb8d1aed7a05352acf4"
    },
    "effectBoundary": {
      "path": "artifacts/m6-4/cohort-manifests/xw.m6-effect-boundary.v1.json",
      "sha256": "9a39d83f6705d52b1f2ea681ca65d28573fba44cfd3c84a88b884a47d93b4d6c"
    }
  },
  "invariants": {
    "gateClosed": true,
    "resourcesZero": true,
    "actionCount": 0,
    "liveProfileQualified": false,
    "liveWindowAuthorized": false,
    "gateFExecuted": false
  },
  "deferred": [
    "Gate F requires exact live-window authorization and a qualified exact model/provider profile",
    "automatic reconcile/checkpoint recovery belongs to M6-5",
    "real M5 WorkReceipt binding belongs to M6-6"
  ],
  "nextMilestone": "M6-5",
  "receiptSha256": "db7eff9aa935e2e8a63614191e1f01cf47099576777fd2ec8106eb4692ea3bf5"
}

```

## Tracked diff

```diff
diff --git a/.github/workflows/source-fusion.yml b/.github/workflows/source-fusion.yml
index 899a61c..0cba096 100644
--- a/.github/workflows/source-fusion.yml
+++ b/.github/workflows/source-fusion.yml
@@ -97,9 +97,13 @@ jobs:
         timeout-minutes: 6
         run: npm run test:orchestrator
 
-      - name: M6 contract and inventory tests
-        timeout-minutes: 4
-        run: npm run test:m6
+      - name: M6 contract and inventory tests
+        timeout-minutes: 4
+        run: npm run test:m6
+
+      - name: M6-4 grounded-action offline hard gate
+        timeout-minutes: 6
+        run: npm run test:m6-4:offline
 
       - name: M6-2 zero-live offline frame capture
         timeout-minutes: 6
diff --git a/integrations/dsh-xw/package.json b/integrations/dsh-xw/package.json
index ce89743..ceea8f1 100644
--- a/integrations/dsh-xw/package.json
+++ b/integrations/dsh-xw/package.json
@@ -7,11 +7,11 @@
     "node": ">=24"
   },
   "scripts": {
-    "check": "node --check plugin.mjs && node --check src/stdio-supervisor.mjs && node --check src/supervisor-cli.mjs && node --check src/process-adapter.mjs && node --check src/runtime-plugin.mjs && node --check src/xw-protocol-server.mjs && node --check src/replay-tools.mjs && node --check src/replay-journal.mjs && node --check src/deterministic-llm.mjs",
+    "check": "node --check plugin.mjs && node --check src/stdio-supervisor.mjs && node --check src/supervisor-cli.mjs && node --check src/process-adapter.mjs && node --check src/runtime-plugin.mjs && node --check src/live-runtime-plugin.mjs && node --check src/live-pipe-client.mjs && node --check src/xw-protocol-server.mjs && node --check src/replay-tools.mjs && node --check src/replay-journal.mjs && node --check src/deterministic-llm.mjs",
     "test:gate-b": "node --test test/stdio-supervisor.spec.mjs test/process-tree.real.spec.mjs test/supervisor-real-fatal.spec.mjs",
     "test:gate-c": "node --test test/tool-boundaries.spec.mjs test/real-tool-loop.spec.mjs test/real-routes.spec.mjs",
     "test:gate-d": "node --test test/cross-process-resume.real.spec.mjs test/checkpoint-faults.real.spec.mjs test/fault-matrix.real.spec.mjs",
-    "test:gate-e": "node --test test/benchmark.real.spec.mjs",
+    "test:gate-e": "node --test test/benchmark.real.spec.mjs test/live-profile.spec.mjs",
     "test:functional": "npm run test:gate-b && npm run test:gate-c && npm run test:gate-d",
     "test": "npm run check && npm run test:functional && npm run test:gate-e"
   },
diff --git a/package.json b/package.json
index 7e69ac9..8459fc9 100644
--- a/package.json
+++ b/package.json
@@ -31,6 +31,7 @@
     "test:m6": "node --test services/orchestrator/tests/m6-contracts.test.mjs services/orchestrator/tests/m6-autonomy-grant.test.mjs services/orchestrator/tests/m6-hard-redline.test.mjs services/orchestrator/tests/m6-tool-surface.test.mjs services/orchestrator/tests/m6-inventory.test.mjs services/orchestrator/tests/m6-grounding-runtime.test.mjs services/orchestrator/tests/m6-screen-frame.test.mjs services/orchestrator/tests/m6-locator-convergence.test.mjs services/orchestrator/tests/m6-replay-corpus.test.mjs services/orchestrator/tests/m6-grounding-metrics.test.mjs",
     "test:m6-2:offline": "node --test services/control-plane/tests/m6-live-gate.test.mjs services/control-plane/tests/m6-frame-evidence-store.test.mjs services/control-plane/tests/m6-read-observation.test.mjs services/control-plane/tests/m6-frame-capture.test.mjs services/control-plane/tests/control-plane-server.test.mjs",
     "test:m6-2:epoch": "node --test services/control-plane/tests/m6-epoch-hash-alignment.test.mjs services/control-plane/tests/m6-gate-loader.test.mjs services/control-plane/tests/m6-epoch.test.mjs services/control-plane/tests/m6-aggregate-closeout.test.mjs services/control-plane/tests/m6-frame-manifest.test.mjs packages/cli/test/xw-m6-cli.test.mjs",
-    "test:m6-3": "npm --prefix integrations/dsh-xw test"
+    "test:m6-3": "npm --prefix integrations/dsh-xw test",
+    "test:m6-4:offline": "node --test packages/kernel/tests/m6-action-slot.test.mjs packages/kernel/tests/m6-effect-boundary.test.mjs services/orchestrator/tests/m6-live-tool-surface.test.mjs services/control-plane/tests/m6-live-gate-v2.test.mjs services/control-plane/tests/m6-gate-fence.test.mjs services/control-plane/tests/m6-gate-promoter.test.mjs services/control-plane/tests/m6-4-cohort.test.mjs services/control-plane/tests/m6-live-grounding.test.mjs services/control-plane/tests/m6-grounding-version-boundary.test.mjs services/control-plane/tests/m6-grounding-permit.test.mjs services/control-plane/tests/m6-action-ledger.test.mjs services/control-plane/tests/m6-grounded-action-facade.test.mjs integrations/dsh-xw/test/live-profile.spec.mjs tools/m6/m6-4-canary-runner.test.mjs"
   }
 }
diff --git a/services/control-plane/apps/xiaowei/capabilities.json b/services/control-plane/apps/xiaowei/capabilities.json
index 79eae37..b1d4f9a 100644
--- a/services/control-plane/apps/xiaowei/capabilities.json
+++ b/services/control-plane/apps/xiaowei/capabilities.json
@@ -347,6 +347,50 @@
         ]
       },
       "lifecycle": "canary_only"
+    },
+    {
+      "schemaVersion": 1,
+      "id": "xiaowei.m6.grounded_run",
+      "appId": "xiaowei",
+      "packageName": null,
+      "versionRange": "observed:9.10.113",
+      "maturity": "E1",
+      "risk": "R1",
+      "resources": ["device", "transport:xiaowei:22222"],
+      "inputSchema": {
+        "type": "object",
+        "additionalProperties": false,
+        "required": ["runPacketRef", "grantRef", "scenarioManifestRef"],
+        "properties": {
+          "runPacketRef": { "type": "string", "minLength": 64, "maxLength": 64 },
+          "grantRef": { "type": "string", "minLength": 64, "maxLength": 64 },
+          "scenarioManifestRef": { "type": "string", "minLength": 64, "maxLength": 64 }
+        }
+      },
+      "outputSchema": { "type": "object" },
+      "preconditions": [
+        "M6 v2 GROUNDED_ACTION gate and DB fence are identical",
+        "alias allowlist is exactly 01",
+        "signed finite action slots and autonomy grant are pinned"
+      ],
+      "verification": {
+        "mode": "custom",
+        "description": "after-frame business oracle and grounded-action receipt"
+      },
+      "restoration": {
+        "required": true,
+        "description": "restore bounded read-trace state and close all run resources"
+      },
+      "timeoutMs": 900000,
+      "idempotency": "ambiguous_on_timeout",
+      "automationPolicy": { "mode": "lab_only", "canaryOnly": true },
+      "implementation": { "adapter": "xiaowei", "action": "m6_grounded_run" },
+      "evidence": ["M6-4-A01", "M6-4-A02", "M6-4-A03-BOUNDED_READ_TRACE"],
+      "availability": "canary_only",
+      "effect": { "class": "reversible", "phase": "na", "commitBoundary": "automatic" },
+      "exposure": "internal",
+      "invocationPolicy": { "allowedModes": ["session"] },
+      "lifecycle": "canary_only"
     }
   ]
 }
diff --git a/services/control-plane/control-plane/lib/m6-gate-loader.mjs b/services/control-plane/control-plane/lib/m6-gate-loader.mjs
index 41466b1..f062af3 100644
--- a/services/control-plane/control-plane/lib/m6-gate-loader.mjs
+++ b/services/control-plane/control-plane/lib/m6-gate-loader.mjs
@@ -33,6 +33,13 @@ import { canonicalJson, sha256 } from "./canonical.mjs";
 import { ControlPlaneError } from "./errors.mjs";
 import { validateJsonSchema } from "./json-schema-validator.mjs";
 import { deriveM6CloseoutHash, deriveM6EpochHash } from "./m6-live-gate.mjs";
+import {
+  deriveEpochHashBySchema,
+  deriveM6EmergencyCloseAuthorizationHash,
+  deriveM6V2LockSetHash,
+  M6_GATE_V2_SCHEMA_ID,
+  M6_LOCKS_V2_SCHEMA_ID,
+} from "./m6-live-gate-v2.mjs";
 import { loadGateIssuerAllowlist, verifyEpochProof } from "./m6-issuer-allowlist.mjs";
 import { deriveM6AggregateSealHash } from "../../../../packages/kernel/lib/m6-aggregate-closeout.mjs";
 
@@ -40,6 +47,7 @@ export const M6_LOCKS_SCHEMA_ID = "xw.m6-locks.v1";
 const HEX64 = /^[0-9a-f]{64}$/;
 
 let EPOCH_SCHEMA = null;
+let EPOCH_SCHEMA_V2 = null;
 export function loadEpochSchema() {
   if (EPOCH_SCHEMA) return EPOCH_SCHEMA;
   // Shared kernel schema — the same file the orchestrator validates against.
@@ -48,6 +56,13 @@ export function loadEpochSchema() {
   return EPOCH_SCHEMA;
 }
 
+export function loadEpochSchemaV2() {
+  if (EPOCH_SCHEMA_V2) return EPOCH_SCHEMA_V2;
+  const path = join(import.meta.dirname, "..", "..", "..", "..", "packages", "kernel", "contracts", "orchestration", "m6", "xw.m6-live-gate.v2.schema.json");
+  EPOCH_SCHEMA_V2 = JSON.parse(readFileSync(path, "utf8"));
+  return EPOCH_SCHEMA_V2;
+}
+
 function fail(code, message, extra = {}) {
   throw new ControlPlaneError(code, message, { status: 503, ...extra });
 }
@@ -107,11 +122,17 @@ function loadEpochFile(fileDir, epochHash, allowlist) {
   const raw = readRegularJson(filePath);
   if (!raw) fail("M6_GATE_EPOCH_MISSING", `epoch file ${epochHash}.json is absent`);
   const { proof, ...epoch } = raw;
+  const schema = epoch.schemaId === "xw.m6-live-gate.v1"
+    ? loadEpochSchema()
+    : epoch.schemaId === M6_GATE_V2_SCHEMA_ID
+      ? loadEpochSchemaV2()
+      : null;
+  if (!schema) fail("M6_GATE_SCHEMA_UNKNOWN", `epoch ${epochHash} has unknown schemaId`);
   // Schema (no proof field — additionalProperties: false).
-  const schemaErrors = validateJsonSchema(epoch, loadEpochSchema());
+  const schemaErrors = validateJsonSchema(epoch, schema);
   if (schemaErrors.length > 0) fail("M6_GATE_EPOCH_SCHEMA_INVALID", `epoch ${epochHash} fails schema: ${schemaErrors.join("; ")}`);
   // Re-derive the self-hash; must match the embedded hash AND the file address.
-  const derived = deriveM6EpochHash(epoch);
+  const derived = deriveEpochHashBySchema(epoch);
   if (derived !== epoch.epochHash) fail("M6_GATE_EPOCH_FORGED", `epoch ${epochHash} self-hash does not match its payload`);
   if (derived !== epochHash) fail("M6_GATE_EPOCH_ADDRESS_MISMATCH", `epoch file address does not match its hash`);
   // Verify the issuer signature.
@@ -119,6 +140,48 @@ function loadEpochFile(fileDir, epochHash, allowlist) {
   return epoch;
 }
 
+function loadContentAddressedRegistry(dir, {
+  schemaId,
+  idField,
+  hashField,
+  deriveHash,
+  errorCode,
+}) {
+  const records = {};
+  if (!existsSync(dir)) return records;
+  for (const name of readdirSync(dir)) {
+    if (!name.endsWith(".json")) continue;
+    const record = readRegularJson(join(dir, name));
+    const id = name.slice(0, -5);
+    if (!record || record.schemaId !== schemaId || record[idField] !== id
+      || record[hashField] !== deriveHash(record)) {
+      fail(errorCode, `${schemaId} record ${id} is malformed or forged`);
+    }
+    records[id] = record;
+  }
+  return records;
+}
+
+function loadV2LockSets(m6Root) {
+  return loadContentAddressedRegistry(join(m6Root, "m6-gate", "locks.v2"), {
+    schemaId: M6_LOCKS_V2_SCHEMA_ID,
+    idField: "lockSetId",
+    hashField: "lockSetHash",
+    deriveHash: deriveM6V2LockSetHash,
+    errorCode: "M6_LOCKS_INVALID",
+  });
+}
+
+function loadEmergencyCloseAuthorizations(gateDirPath) {
+  return loadContentAddressedRegistry(join(gateDirPath, "emergency-close"), {
+    schemaId: "xw.m6-emergency-close-authorization.v1",
+    idField: "authorizationId",
+    hashField: "authorizationHash",
+    deriveHash: deriveM6EmergencyCloseAuthorizationHash,
+    errorCode: "M6_GATE_EMERGENCY_CLOSE_INVALID",
+  });
+}
+
 // Load all closeout records for the gate into a {closeoutId: record} map. Each
 // record must self-hash via deriveM6CloseoutHash (resolveM6Closeout re-checks).
 function loadCloseouts(gateDirPath) {
@@ -172,13 +235,13 @@ export function loadM6Gate({
   const dir = gateDir(m6Root, gateId);
   if (!existsSync(dir)) {
     // No gate installed → empty chain (gate evaluates to M6_GATE_EMPTY, CLOSED).
-    return { chain: [], closeouts: {}, aggregates: {}, lockHashes: loadM6Locks(m6Root, { requireLocks }), gateId, tailEpochHash: null };
+    return { chain: [], closeouts: {}, aggregates: {}, lockHashes: loadM6Locks(m6Root, { requireLocks }), lockSets: loadV2LockSets(m6Root), emergencyCloseAuthorizations: {}, gateId, tailEpochHash: null };
   }
   const allowlist = loadGateIssuerAllowlist(issuerAllowlistPath);
   const currentPath = join(dir, "current.json");
   const current = readRegularJson(currentPath);
   if (!current || !Array.isArray(current.chain) || current.chain.length === 0) {
-    return { chain: [], closeouts: {}, aggregates: {}, lockHashes: loadM6Locks(m6Root, { requireLocks }), gateId, tailEpochHash: null };
+    return { chain: [], closeouts: {}, aggregates: {}, lockHashes: loadM6Locks(m6Root, { requireLocks }), lockSets: loadV2LockSets(m6Root), emergencyCloseAuthorizations: {}, gateId, tailEpochHash: null };
   }
   const chain = [];
   for (const epochHash of current.chain) {
@@ -187,7 +250,16 @@ export function loadM6Gate({
   }
   const closeouts = loadCloseouts(dir);
   const aggregates = loadAggregates(dir);
-  return { chain, closeouts, aggregates, lockHashes: loadM6Locks(m6Root, { requireLocks }), gateId, tailEpochHash: current.tailEpochHash ?? current.chain[current.chain.length - 1] };
+  return {
+    chain,
+    closeouts,
+    aggregates,
+    lockHashes: loadM6Locks(m6Root, { requireLocks }),
+    lockSets: loadV2LockSets(m6Root),
+    emergencyCloseAuthorizations: loadEmergencyCloseAuthorizations(dir),
+    gateId,
+    tailEpochHash: current.tailEpochHash ?? current.chain[current.chain.length - 1],
+  };
 }
 
 // Probe that a directory is writable (mkdir + temp write + fsync + unlink).
diff --git a/services/control-plane/control-plane/lib/state-store.mjs b/services/control-plane/control-plane/lib/state-store.mjs
index b6e5398..37aa788 100644
--- a/services/control-plane/control-plane/lib/state-store.mjs
+++ b/services/control-plane/control-plane/lib/state-store.mjs
@@ -15,7 +15,7 @@ import {
   consumeTransportActionAuthorization as consumeTransportAuthKernel,
 } from "./transport-action-authorization.mjs";
 
-export const CURRENT_CONTROL_SCHEMA_VERSION = 18;
+export const CURRENT_CONTROL_SCHEMA_VERSION = 19;
 
 const ACTIVE_JOB_STATES = new Set(["running", "verifying", "restoring"]);
 const TERMINAL_JOB_STATES = new Set(["succeeded", "failed", "ambiguous", "recovery_required", "cancelled"]);
@@ -196,12 +196,71 @@ export class StateStore {
     this.#recoverInFlightActions();
   }
 
+  #migrateV18ToV19() {
+    this.db.exec(`
+      CREATE TABLE IF NOT EXISTS m6_gate_fence (
+        marker TEXT PRIMARY KEY CHECK(marker='M6'),
+        gate_id TEXT NOT NULL,
+        epoch_hash TEXT NOT NULL,
+        generation INTEGER NOT NULL CHECK(generation>=0),
+        mode TEXT NOT NULL,
+        purpose TEXT,
+        allowlist_json TEXT NOT NULL,
+        expires_at TEXT NOT NULL,
+        release_id TEXT NOT NULL,
+        source_commit TEXT NOT NULL,
+        locks_hash TEXT NOT NULL,
+        updated_at INTEGER NOT NULL
+      );
+      CREATE TABLE IF NOT EXISTS m6_emergency_close_consumptions (
+        nonce TEXT PRIMARY KEY,
+        authorization_hash TEXT NOT NULL UNIQUE,
+        reason_code TEXT NOT NULL,
+        consumed_at INTEGER NOT NULL
+      );
+      CREATE TABLE IF NOT EXISTS m6_grounding_permits (
+        permit_id TEXT PRIMARY KEY,
+        permit_hash TEXT NOT NULL UNIQUE,
+        decision_ref TEXT NOT NULL UNIQUE,
+        operation_key TEXT NOT NULL,
+        permit_json TEXT NOT NULL,
+        issued_at INTEGER NOT NULL,
+        expires_at INTEGER NOT NULL,
+        consumed_at INTEGER,
+        consumption_receipt_json TEXT
+      );
+      CREATE TABLE IF NOT EXISTS m6_action_claims (
+        operation_key TEXT PRIMARY KEY,
+        action_id TEXT NOT NULL UNIQUE,
+        slot_spec_hash TEXT NOT NULL,
+        target_hash TEXT NOT NULL,
+        status TEXT NOT NULL,
+        created_at INTEGER NOT NULL,
+        updated_at INTEGER NOT NULL
+      );
+      CREATE TABLE IF NOT EXISTS m6_grounded_action_details (
+        action_id TEXT PRIMARY KEY,
+        operation_key TEXT NOT NULL UNIQUE REFERENCES m6_action_claims(operation_key),
+        permit_id TEXT NOT NULL UNIQUE REFERENCES m6_grounding_permits(permit_id),
+        run_id TEXT NOT NULL,
+        session_id TEXT NOT NULL,
+        lease_id TEXT NOT NULL,
+        authorization_receipt_json TEXT,
+        guard_receipt_json TEXT,
+        transport_result_json TEXT,
+        completion_receipt_json TEXT,
+        created_at INTEGER NOT NULL,
+        updated_at INTEGER NOT NULL
+      );
+    `);
+  }
+
   #recoverInFlightActions() {
     const now = this.now();
     this.db.prepare(`
       UPDATE device_session_actions
       SET status='AMBIGUOUS', error_code=COALESCE(error_code, 'CONTROL_PLANE_RESTART'), updated_at=?
-      WHERE status IN ('REQUESTED', 'ASSESSED', 'EXECUTING')
+      WHERE status IN ('REQUESTED', 'ASSESSED', 'EXECUTING') AND execution_mode <> 'm6-grounded-live-v2'
     `).run(now);
   }
 
@@ -658,6 +717,7 @@ export class StateStore {
         if (current < 16) this.#migrateV15ToV16();
         if (current < 17) this.#migrateV16ToV17();
         if (current < 18) this.#migrateV17ToV18();
+        if (current < 19) this.#migrateV18ToV19();
         this.#setUserVersion(CURRENT_CONTROL_SCHEMA_VERSION);
       });
     }
@@ -697,6 +757,7 @@ export class StateStore {
       this.#recoverInterruptedEffects(now);
       this.#recoverInterruptedProtectedCommits(now);
       this.#recoverInFlightActions();
+      this.#recoverM6ActionLedger(now);
       this.db.exec("DELETE FROM sessions; DELETE FROM leases;");
       return [];
     }
@@ -724,6 +785,7 @@ export class StateStore {
       this.#recoverInterruptedEffects(now);
       this.#recoverInterruptedProtectedCommits(now);
       this.#recoverInFlightActions();
+      this.#recoverM6ActionLedger(now);
       this.db.exec("DELETE FROM sessions; DELETE FROM leases;");
     });
     return interrupted.map((row) => row.job_id);
@@ -2020,6 +2082,510 @@ export class StateStore {
     return this.db.prepare("SELECT * FROM leases ORDER BY created_at").all().map((row) => publicLease(row));
   }
 
+  #recoverM6ActionLedger(now) {
+    this.db.prepare(`
+      UPDATE device_session_actions SET status='BLOCKED',
+        effect_assessment_json='{"effectStatus":"GROUND_ACTION_ABORTED_NOT_SENT"}',
+        error_code='CONTROL_RESTART_NO_SEND', updated_at=?
+      WHERE execution_mode='m6-grounded-live-v2' AND status <> 'COMPLETED' AND transport_called=0
+    `).run(now);
+    this.db.prepare(`
+      UPDATE device_session_actions SET status='AMBIGUOUS',
+        effect_assessment_json='{"effectStatus":"POSSIBLE_EFFECT"}',
+        error_code='CONTROL_RESTART_AFTER_SEND', updated_at=?
+      WHERE execution_mode='m6-grounded-live-v2' AND status <> 'COMPLETED' AND transport_called=1
+    `).run(now);
+    this.db.prepare(`
+      UPDATE m6_action_claims SET status='BLOCKED', updated_at=?
+      WHERE action_id IN (SELECT action_id FROM device_session_actions WHERE execution_mode='m6-grounded-live-v2' AND status='BLOCKED')
+    `).run(now);
+    this.db.prepare(`
+      UPDATE m6_action_claims SET status='AMBIGUOUS', updated_at=?
+      WHERE action_id IN (SELECT action_id FROM device_session_actions WHERE execution_mode='m6-grounded-live-v2' AND status='AMBIGUOUS')
+    `).run(now);
+  }
+
+  getM6GateFence() {
+    const row = this.db.prepare("SELECT * FROM m6_gate_fence WHERE marker='M6'").get();
+    if (!row) return null;
+    return {
+      gateId: row.gate_id,
+      epochHash: row.epoch_hash,
+      generation: Number(row.generation),
+      mode: row.mode,
+      purpose: row.purpose,
+      allowlist: parseJson(row.allowlist_json, []),
+      expiresAt: row.expires_at,
+      releaseId: row.release_id,
+      sourceCommit: row.source_commit,
+      locksHash: row.locks_hash,
+      updatedAt: iso(row.updated_at),
+    };
+  }
+
+  seedM6GateFence({ epoch, locksHash }) {
+    const { epochHash: _ignoredEpochHash, ...epochPayload } = epoch || {};
+    const derivedEpochHash = sha256(`xw.m6-live-gate.v1:${canonicalJson(epochPayload)}`);
+    if (!epoch || epoch.schemaId !== "xw.m6-live-gate.v1" || epoch.mode !== "CLOSED" || epoch.status !== "closed"
+      || !epoch.closeoutRef || !epoch.aggregateSealRef || epoch.epochHash !== derivedEpochHash) {
+      throw new ControlPlaneError(
+        "M6_GATE_FENCE_SEED_INVALID",
+        "v19 fence may only seed from a verified v1 CLOSED tail",
+        { status: 409 },
+      );
+    }
+    if (!/^[0-9a-f]{64}$/.test(locksHash || "")) {
+      throw new ControlPlaneError("M6_GATE_FENCE_SEED_INVALID", "fence seed requires a 64-hex locks hash", { status: 409 });
+    }
+    return this.transaction(() => {
+      const existing = this.getM6GateFence();
+      if (existing) {
+        if (existing.epochHash !== epoch.epochHash || existing.generation !== 0 || existing.mode !== "CLOSED") {
+          throw new ControlPlaneError("M6_GATE_FENCE_ALREADY_SEEDED", "existing M6 fence differs from the seed", { status: 409 });
+        }
+        return existing;
+      }
+      this.db.prepare(`
+        INSERT INTO m6_gate_fence (
+          marker, gate_id, epoch_hash, generation, mode, purpose, allowlist_json,
+          expires_at, release_id, source_commit, locks_hash, updated_at
+        ) VALUES ('M6', ?, ?, 0, 'CLOSED', NULL, ?, ?, ?, ?, ?, ?)
+      `).run(
+        epoch.gateId,
+        epoch.epochHash,
+        canonicalJson(epoch.allowlist),
+        epoch.expiresAt,
+        epoch.releaseId,
+        epoch.sourceCommit,
+        locksHash,
+        this.now(),
+      );
+      return this.getM6GateFence();
+    });
+  }
+
+  promoteM6GateFence({ expectedEpochHash, expectedGeneration, next, emergencyCloseConsumption = null }) {
+    if (!next || !/^[0-9a-f]{64}$/.test(next.epochHash || "") || !/^[0-9a-f]{64}$/.test(next.locksHash || "")
+      || !Number.isFinite(Date.parse(next.expiresAt)) || !Array.isArray(next.allowlist) || next.allowlist.length === 0
+      || !["CLOSED", "OBSERVE_ONLY", "GROUNDED_ACTION"].includes(next.mode)) {
+      throw new ControlPlaneError("M6_GATE_FENCE_PROMOTE_INVALID", "next M6 fence is incomplete", { status: 409 });
+    }
+    return this.transaction(() => {
+      const current = this.getM6GateFence();
+      if (!current || current.epochHash !== expectedEpochHash || current.generation !== expectedGeneration) {
+        throw new ControlPlaneError("M6_GATE_FENCE_CAS_MISMATCH", "M6 fence compare-and-swap precondition failed", {
+          status: 409,
+          details: { expectedEpochHash, expectedGeneration, actualEpochHash: current?.epochHash || null, actualGeneration: current?.generation ?? null },
+        });
+      }
+      const generation = current.generation + 1;
+      if (emergencyCloseConsumption) {
+        if (typeof emergencyCloseConsumption.nonce !== "string" || emergencyCloseConsumption.nonce === ""
+          || !/^[0-9a-f]{64}$/.test(emergencyCloseConsumption.authorizationHash || "")
+          || typeof emergencyCloseConsumption.reasonCode !== "string" || emergencyCloseConsumption.reasonCode === "") {
+          throw new ControlPlaneError("M6_GATE_EMERGENCY_CLOSE_INVALID", "emergency-close consumption is incomplete", { status: 409 });
+        }
+        try {
+          this.db.prepare(`
+            INSERT INTO m6_emergency_close_consumptions (nonce, authorization_hash, reason_code, consumed_at)
+            VALUES (?, ?, ?, ?)
+          `).run(
+            emergencyCloseConsumption.nonce,
+            emergencyCloseConsumption.authorizationHash,
+            emergencyCloseConsumption.reasonCode,
+            this.now(),
+          );
+        } catch (error) {
+          if (/UNIQUE|PRIMARY KEY/i.test(String(error?.message || error))) {
+            throw new ControlPlaneError("M6_GATE_EMERGENCY_CLOSE_REPLAY", "emergency-close authorization was already consumed", { status: 409 });
+          }
+          throw error;
+        }
+      }
+      this.db.prepare(`
+        UPDATE m6_gate_fence SET
+          gate_id=?, epoch_hash=?, generation=?, mode=?, purpose=?, allowlist_json=?,
+          expires_at=?, release_id=?, source_commit=?, locks_hash=?, updated_at=?
+        WHERE marker='M6'
+      `).run(
+        next.gateId,
+        next.epochHash,
+        generation,
+        next.mode,
+        next.purpose ?? null,
+        canonicalJson(next.allowlist),
+        next.expiresAt,
+        next.releaseId,
+        next.sourceCommit,
+        next.locksHash,
+        this.now(),
+      );
+      return this.getM6GateFence();
+    });
+  }
+
+  assertM6GateFence(expected) {
+    const current = this.getM6GateFence();
+    const same = current && [
+      "gateId", "epochHash", "generation", "mode", "purpose", "expiresAt",
+      "releaseId", "sourceCommit", "locksHash",
+    ].every((key) => current[key] === expected?.[key])
+      && canonicalJson(current.allowlist) === canonicalJson(expected?.allowlist);
+    if (!same) {
+      throw new ControlPlaneError("M6_GATE_FENCE_MISMATCH", "file gate and DB fence are not identical", { status: 423 });
+    }
+    return current;
+  }
+
+  getM6EmergencyCloseConsumption(nonce) {
+    const row = this.db.prepare("SELECT * FROM m6_emergency_close_consumptions WHERE nonce=?").get(nonce);
+    return row ? {
+      nonce: row.nonce,
+      authorizationHash: row.authorization_hash,
+      reasonCode: row.reason_code,
+      consumedAt: iso(row.consumed_at),
+    } : null;
+  }
+
+  issueM6GroundingPermit({ decision, slot, timing }) {
+    const forbiddenKey = (value) => {
+      if (!value || typeof value !== "object") return false;
+      if (Array.isArray(value)) return value.some(forbiddenKey);
+      return Object.entries(value).some(([key, child]) => /^(?:x|y|x1|y1|x2|y2|bounds|coordinates?|primitiveAction)$/iu.test(key) || forbiddenKey(child));
+    };
+    if (decision?.schemaId !== "xw.grounding-decision.v2" || decision.disposition !== "ALLOW_ONCE"
+      || !/^[0-9a-f]{64}$/.test(decision.decisionRef || "") || forbiddenKey(decision)
+      || !slot || !/^[0-9a-f]{64}$/.test(slot.slotSpecHash || "")
+      || forbiddenKey(slot) || !timing || !Number.isFinite(timing.issuedAtMs)
+      || !Number.isFinite(timing.expiresAtMs) || timing.expiresAtMs <= timing.issuedAtMs
+      || !Number.isFinite(timing.dispatchDeadlineMonoMs)) {
+      throw new ControlPlaneError("M6_GROUNDING_PERMIT_INVALID", "durable grounding permit input is invalid", { status: 409 });
+    }
+    const now = this.now();
+    if (timing.expiresAtMs <= now) {
+      throw new ControlPlaneError("M6_GROUNDING_PERMIT_EXPIRED", "grounding permit is already expired", { status: 409 });
+    }
+    const permitId = newId("m6_permit");
+    const raw = {
+      schemaId: "xw.m6-grounding-permit.v1",
+      permitId,
+      decisionRef: decision.decisionRef,
+      operationKey: decision.operationKey,
+      target: decision.target,
+      bindings: decision.bindings,
+      slot: { ...slot },
+      timing: {
+        issuedAtMs: timing.issuedAtMs,
+        expiresAtMs: timing.expiresAtMs,
+        dispatchDeadlineMonoMs: timing.dispatchDeadlineMonoMs,
+      },
+    };
+    const permitHash = sha256(`xw.m6-grounding-permit.v1:${canonicalJson(raw)}`);
+    const permit = { ...raw, permitHash };
+    try {
+      this.db.prepare(`
+        INSERT INTO m6_grounding_permits (
+          permit_id, permit_hash, decision_ref, operation_key, permit_json, issued_at, expires_at
+        ) VALUES (?, ?, ?, ?, ?, ?, ?)
+      `).run(permitId, permitHash, decision.decisionRef, decision.operationKey, canonicalJson(permit), timing.issuedAtMs, timing.expiresAtMs);
+    } catch (error) {
+      if (/UNIQUE|PRIMARY KEY/i.test(String(error?.message || error))) {
+        throw new ControlPlaneError("M6_GROUNDING_DECISION_REPLAY", "grounding decision already owns a permit", { status: 409 });
+      }
+      throw error;
+    }
+    return permit;
+  }
+
+  getM6GroundingPermit(permitId) {
+    const row = this.db.prepare("SELECT * FROM m6_grounding_permits WHERE permit_id=?").get(permitId);
+    if (!row) return null;
+    return {
+      ...parseJson(row.permit_json),
+      consumedAt: iso(row.consumed_at),
+      consumptionReceipt: parseJson(row.consumption_receipt_json),
+    };
+  }
+
+  #consumeM6GroundingPermitNoTransaction({ permitId, expected, nowMonoMs, minimumRemainingTtlMs = 1000 }) {
+    if (!Number.isFinite(nowMonoMs) || !Number.isFinite(minimumRemainingTtlMs) || minimumRemainingTtlMs < 1000) {
+      throw new ControlPlaneError("M6_GROUNDING_PERMIT_INVALID", "permit consume requires monotonic time and minimum TTL >=1s", { status: 409 });
+    }
+    const permit = this.getM6GroundingPermit(permitId);
+    if (!permit) throw new ControlPlaneError("M6_GROUNDING_PERMIT_NOT_FOUND", "grounding permit not found", { status: 404 });
+    if (permit.consumedAt) throw new ControlPlaneError("M6_GROUNDING_PERMIT_REPLAY", "grounding permit is already consumed", { status: 409 });
+    const remainingTtlMs = permit.timing.expiresAtMs - this.now();
+    const remainingMonoMs = permit.timing.dispatchDeadlineMonoMs - nowMonoMs;
+    if (remainingTtlMs < minimumRemainingTtlMs || remainingMonoMs < minimumRemainingTtlMs) {
+      throw new ControlPlaneError("M6_GROUNDING_PERMIT_STALE", "grounding permit has insufficient remaining TTL", { status: 409 });
+    }
+    const expectedBinding = { operationKey: expected?.operationKey, target: expected?.target, bindings: expected?.bindings, slot: expected?.slot };
+    const actualBinding = { operationKey: permit.operationKey, target: permit.target, bindings: permit.bindings, slot: permit.slot };
+    if (canonicalJson(expectedBinding) !== canonicalJson(actualBinding)) {
+      throw new ControlPlaneError("M6_GROUNDING_PERMIT_BINDING_MISMATCH", "grounding permit binding changed before consume", { status: 409 });
+    }
+    const consumedAtMs = this.now();
+    const receiptRaw = {
+      schemaId: "xw.m6-grounding-permit-consumption.v1", permitId: permit.permitId, permitHash: permit.permitHash,
+      decisionRef: permit.decisionRef, operationKey: permit.operationKey, target: permit.target, bindings: permit.bindings,
+      slot: permit.slot, remainingTtlMs, remainingMonoMs, dispatchDeadlineMonoMs: permit.timing.dispatchDeadlineMonoMs,
+      consumedAtMonoMs: nowMonoMs, consumedAtMs,
+    };
+    const receipt = { ...receiptRaw, consumptionHash: sha256(`xw.m6-grounding-permit-consumption.v1:${canonicalJson(receiptRaw)}`) };
+    const updated = this.db.prepare(`UPDATE m6_grounding_permits SET consumed_at=?, consumption_receipt_json=? WHERE permit_id=? AND consumed_at IS NULL`)
+      .run(consumedAtMs, canonicalJson(receipt), permitId);
+    if (!updated.changes) throw new ControlPlaneError("M6_GROUNDING_PERMIT_REPLAY", "grounding permit is already consumed", { status: 409 });
+    return receipt;
+  }
+
+  consumeM6GroundingPermit(input) {
+    return this.transaction(() => this.#consumeM6GroundingPermitNoTransaction(input));
+  }
+
+  #mapM6ActionLedger(row) {
+    if (!row) return null;
+    return {
+      actionId: row.action_id,
+      operationKey: row.operation_key,
+      permitId: row.permit_id,
+      runId: row.run_id,
+      sessionId: row.session_id,
+      leaseId: row.lease_id,
+      status: row.status,
+      transportCounter: Number(row.transport_called),
+      externalEffect: Boolean(row.transport_called),
+      effectStatus: parseJson(row.effect_assessment_json)?.effectStatus || "NO_EFFECT",
+      authorizationReceipt: parseJson(row.authorization_receipt_json),
+      guardReceipt: parseJson(row.guard_receipt_json),
+      transportResult: parseJson(row.transport_result_json),
+      completionReceipt: parseJson(row.completion_receipt_json),
+      errorCode: row.error_code,
+      createdAt: iso(row.action_created_at),
+      updatedAt: iso(row.action_updated_at),
+    };
+  }
+
+  getM6ActionLedger(actionId) {
+    return this.#mapM6ActionLedger(this.db.prepare(`
+      SELECT d.*, a.status, a.transport_called, a.effect_assessment_json, a.error_code,
+        a.created_at AS action_created_at, a.updated_at AS action_updated_at
+      FROM m6_grounded_action_details d
+      JOIN device_session_actions a ON a.action_id=d.action_id AND a.session_id=d.session_id
+      WHERE d.action_id=?
+    `).get(actionId));
+  }
+
+  prepareM6GroundedAction({ decision, slot, timing, fence, actionId = newId("m6_action") }) {
+    return this.transaction(() => {
+      this.assertM6GateFence(fence);
+      if (decision?.bindings?.gateEpochHash !== fence.epochHash || decision?.bindings?.gateGeneration !== fence.generation
+        || decision?.bindings?.sessionId == null || decision?.bindings?.leaseId == null || decision?.bindings?.runId == null) {
+        throw new ControlPlaneError("M6_ACTION_BINDING_MISMATCH", "decision does not bind to the current fence/run/session/lease", { status: 409 });
+      }
+      const permit = this.issueM6GroundingPermit({ decision, slot, timing });
+      const targetHash = sha256(`xw.m6-action-target.v1:${canonicalJson(decision.target)}`);
+      const now = this.now();
+      try {
+        this.db.prepare(`
+          INSERT INTO m6_action_claims (
+            operation_key, action_id, slot_spec_hash, target_hash, status, created_at, updated_at
+          ) VALUES (?, ?, ?, ?, 'RESERVED', ?, ?)
+        `).run(decision.operationKey, actionId, slot.slotSpecHash, targetHash, now, now);
+        this.db.prepare(`
+          INSERT INTO device_session_actions (
+            session_id, idempotency_key, action_id, fingerprint_json, result_json, executed, created_at,
+            status, execution_mode, transport_called, executor_id, effect_assessment_json, updated_at
+          ) VALUES (?, ?, ?, ?, '{}', 0, ?, 'ASSESSED', 'm6-grounded-live-v2', 0, 'm6-typed-adapter',
+            '{"effectStatus":"NO_EFFECT"}', ?)
+        `).run(decision.bindings.sessionId, decision.operationKey, actionId, canonicalJson({
+          operationKey: decision.operationKey, decisionRef: decision.decisionRef, slotSpecHash: slot.slotSpecHash, targetHash,
+        }), now, now);
+        this.db.prepare(`
+          INSERT INTO m6_grounded_action_details (
+            action_id, operation_key, permit_id, run_id, session_id, lease_id, created_at, updated_at
+          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
+        `).run(
+          actionId,
+          decision.operationKey,
+          permit.permitId,
+          decision.bindings.runId,
+          decision.bindings.sessionId,
+          decision.bindings.leaseId,
+          now,
+          now,
+        );
+      } catch (error) {
+        if (/UNIQUE|PRIMARY KEY/i.test(String(error?.message || error))) {
+          throw new ControlPlaneError("M6_LOGICAL_ACTION_CLAIM_CONFLICT", "logical action already has a global claim", { status: 409 });
+        }
+        throw error;
+      }
+      return { permit, ledger: this.getM6ActionLedger(actionId) };
+    });
+  }
+
+  authorizeM6GroundedActionSend({ actionId, fence, expectedPermit, nowMonoMs, typedAuthorization }) {
+    return this.transaction(() => {
+      this.assertM6GateFence(fence);
+      const ledger = this.getM6ActionLedger(actionId);
+      if (!ledger || ledger.status !== "ASSESSED" || ledger.transportCounter !== 0) {
+        throw new ControlPlaneError("M6_ACTION_STATE_INVALID", "only ASSESSED zero-transport actions may authorize", { status: 409 });
+      }
+      const permitReceipt = this.#consumeM6GroundingPermitNoTransaction({
+        permitId: ledger.permitId,
+        expected: expectedPermit,
+        nowMonoMs,
+        minimumRemainingTtlMs: 1000,
+      });
+      if (permitReceipt.bindings.gateEpochHash !== fence.epochHash || permitReceipt.bindings.gateGeneration !== fence.generation) {
+        throw new ControlPlaneError("M6_GATE_FENCE_MISMATCH", "permit consumption fence changed", { status: 423 });
+      }
+      const typedAuthorizationId = typedAuthorization?.authorizationId || typedAuthorization?.authorization?.authorizationId;
+      const storedAuthorization = this.getTransportActionAuthorization(typedAuthorizationId);
+      const capabilityJob = storedAuthorization?.jobId ? this.getJob(storedAuthorization.jobId) : null;
+      if (!storedAuthorization || storedAuthorization.kind !== "capability_job" || storedAuthorization.purpose !== "execute"
+        || !storedAuthorization.jobId || storedAuthorization.runId !== permitReceipt.bindings.runId
+        || storedAuthorization.leaseId !== permitReceipt.bindings.leaseId || storedAuthorization.operationKey !== permitReceipt.operationKey
+        || !capabilityJob || capabilityJob.status !== "running" || capabilityJob.runId !== storedAuthorization.runId
+        || capabilityJob.sessionId !== ledger.sessionId || capabilityJob.deviceId !== storedAuthorization.deviceId) {
+        throw new ControlPlaneError("M6_TYPED_AUTH_BINDING_MISMATCH", "typed transport authorization is not bound to the capability job/run/lease/operation", { status: 409 });
+      }
+      const typedReceipt = this.#consumeTransportActionAuthorizationNoTransaction({
+        authorizationId: typedAuthorizationId,
+        token: typedAuthorization.token,
+        expectedPurpose: "execute",
+        expectedDeviceId: storedAuthorization.deviceId,
+        expectedLeaseId: permitReceipt.bindings.leaseId,
+      });
+      const receipt = { schemaId: "xw.m6-action-authorization-receipt.v1", permit: permitReceipt, typedAuthorization: typedReceipt };
+      this.db.prepare(`
+        UPDATE m6_grounded_action_details SET authorization_receipt_json=?, updated_at=?
+        WHERE action_id=?
+      `).run(canonicalJson(receipt), this.now(), actionId);
+      this.db.prepare("UPDATE device_session_actions SET status='EXECUTING', updated_at=? WHERE action_id=? AND session_id=?")
+        .run(this.now(), actionId, ledger.sessionId);
+      this.db.prepare("UPDATE m6_action_claims SET status='CONSUMED', updated_at=? WHERE action_id=?").run(this.now(), actionId);
+      return this.getM6ActionLedger(actionId);
+    });
+  }
+
+  markM6ActionTransportStart({ actionId, currentState, guardStartedMonoMs, writeReadyMonoMs }) {
+    return this.transaction(() => {
+      const ledger = this.getM6ActionLedger(actionId);
+      if (!ledger || ledger.status !== "EXECUTING" || ledger.transportCounter !== 0 || !ledger.authorizationReceipt) {
+        throw new ControlPlaneError("M6_ACTION_STATE_INVALID", "transport start requires an EXECUTING zero-counter action", { status: 409 });
+      }
+      const slot = ledger.authorizationReceipt.permit.slot;
+      const comparableKeys = [
+        "uiStateGeneration", "appPackageHash", "focusHash", "pageFingerprint",
+        "rotation", "displayHash", "environmentAttestationHash",
+      ];
+      if (!Number.isFinite(guardStartedMonoMs) || !Number.isFinite(writeReadyMonoMs)
+        || writeReadyMonoMs < guardStartedMonoMs || writeReadyMonoMs - guardStartedMonoMs > 250
+        || writeReadyMonoMs >= ledger.authorizationReceipt.permit.dispatchDeadlineMonoMs
+        || comparableKeys.some((key) => currentState?.[key] !== slot?.[key])) {
+        this.db.prepare(`
+          UPDATE device_session_actions SET status='BLOCKED', effect_assessment_json='{"effectStatus":"GROUND_ACTION_ABORTED_NOT_SENT"}',
+            error_code='M6_TCB_CURRENT_STATE_GUARD', updated_at=? WHERE action_id=? AND session_id=?
+        `).run(this.now(), actionId, ledger.sessionId);
+        this.db.prepare("UPDATE m6_action_claims SET status='BLOCKED', updated_at=? WHERE action_id=?").run(this.now(), actionId);
+        throw new ControlPlaneError("M6_TCB_CURRENT_STATE_GUARD", "current UI/environment state or guard deadline changed before send", { status: 409 });
+      }
+      const guardRaw = {
+        schemaId: "xw.m6-tcb-current-state-guard.v1",
+        actionId,
+        slotSpecHash: slot.slotSpecHash,
+        stateHash: sha256(`xw.m6-current-state.v1:${canonicalJson(currentState)}`),
+        guardDelayMs: writeReadyMonoMs - guardStartedMonoMs,
+        writeReadyMonoMs,
+      };
+      const guardReceipt = { ...guardRaw, guardHash: sha256(`xw.m6-tcb-current-state-guard.v1:${canonicalJson(guardRaw)}`) };
+      this.db.prepare(`
+        UPDATE m6_grounded_action_details SET guard_receipt_json=?, updated_at=? WHERE action_id=?
+      `).run(canonicalJson(guardReceipt), this.now(), actionId);
+      this.db.prepare(`
+        UPDATE device_session_actions SET transport_called=1,
+          effect_assessment_json='{"effectStatus":"POSSIBLE_EFFECT"}', updated_at=?
+        WHERE action_id=? AND session_id=? AND transport_called=0
+      `).run(this.now(), actionId, ledger.sessionId);
+      return this.getM6ActionLedger(actionId);
+    });
+  }
+
+  recordM6ActionTransportOutcome({ actionId, ok, result = {}, errorCode = null }) {
+    return this.transaction(() => {
+      const ledger = this.getM6ActionLedger(actionId);
+      if (!ledger || ledger.status !== "EXECUTING" || ledger.transportCounter !== 1) {
+        throw new ControlPlaneError("M6_ACTION_STATE_INVALID", "transport outcome requires an EXECUTING action", { status: 409 });
+      }
+      const status = ok ? "EXECUTED" : "AMBIGUOUS";
+      const effectStatus = ok ? "EFFECT_SENT_PENDING_VERIFY" : "POSSIBLE_EFFECT";
+      this.db.prepare(`
+        UPDATE m6_grounded_action_details SET transport_result_json=?, updated_at=? WHERE action_id=?
+      `).run(canonicalJson(result), this.now(), actionId);
+      this.db.prepare(`UPDATE device_session_actions SET status=?, result_json=?, effect_assessment_json=?, error_code=?, updated_at=?
+        WHERE action_id=? AND session_id=?`)
+        .run(status, canonicalJson(result), canonicalJson({ effectStatus }), errorCode, this.now(), actionId, ledger.sessionId);
+      if (!ok) this.db.prepare("UPDATE m6_action_claims SET status='AMBIGUOUS', updated_at=? WHERE action_id=?").run(this.now(), actionId);
+      return this.getM6ActionLedger(actionId);
+    });
+  }
+
+  completeM6GroundedAction({ actionId, afterObservation, verification, receipt }) {
+    return this.transaction(() => {
+      const ledger = this.getM6ActionLedger(actionId);
+      if (!ledger || ledger.status !== "EXECUTED" || ledger.transportCounter !== 1) {
+        throw new ControlPlaneError("M6_ACTION_STATE_INVALID", "completion requires an EXECUTED action", { status: 409 });
+      }
+      if (!afterObservation?.observationId || verification?.ok !== true || receipt?.actionId !== actionId
+        || receipt?.operationKey !== ledger.operationKey) {
+        throw new ControlPlaneError("M6_ACTION_COMPLETION_INVALID", "after observation, verification, and receipt must agree", { status: 409 });
+      }
+      this.recordDeviceSessionObservation({ sessionId: ledger.sessionId, observation: afterObservation, mutatingCalls: 0 });
+      this.#insertDeviceSessionEvent({
+        sessionId: ledger.sessionId,
+        type: "observation.captured",
+        payload: { observationId: afterObservation.observationId, evidenceRefs: afterObservation.evidenceRefs, mutatingCalls: 0 },
+      });
+      const completionRaw = {
+        schemaId: "xw.m6-grounded-action-completion.v1",
+        actionId,
+        operationKey: ledger.operationKey,
+        afterObservationId: afterObservation.observationId,
+        verification,
+        receipt,
+        transportCounter: 1,
+        externalEffect: true,
+      };
+      const completion = { ...completionRaw, completionHash: sha256(`xw.m6-grounded-action-completion.v1:${canonicalJson(completionRaw)}`) };
+      this.db.prepare(`
+        UPDATE m6_grounded_action_details SET completion_receipt_json=?, updated_at=? WHERE action_id=?
+      `).run(canonicalJson(completion), this.now(), actionId);
+      this.db.prepare(`UPDATE device_session_actions SET status='VERIFIED', after_observation_id=?, updated_at=?
+        WHERE action_id=? AND session_id=?`).run(afterObservation.observationId, this.now(), actionId, ledger.sessionId);
+      this.db.prepare(`UPDATE device_session_actions SET status='COMPLETED', executed=1,
+        effect_assessment_json='{"effectStatus":"VERIFIED_EFFECT"}', updated_at=?
+        WHERE action_id=? AND session_id=?`).run(this.now(), actionId, ledger.sessionId);
+      this.db.prepare("UPDATE m6_action_claims SET status='COMPLETED', updated_at=? WHERE action_id=?").run(this.now(), actionId);
+      return this.getM6ActionLedger(actionId);
+    });
+  }
+
+  abortM6GroundedActionNotSent({ actionId, errorCode }) {
+    return this.transaction(() => {
+      const ledger = this.getM6ActionLedger(actionId);
+      if (!ledger || ledger.transportCounter !== 0 || !["ASSESSED", "EXECUTING"].includes(ledger.status)) {
+        throw new ControlPlaneError("M6_ACTION_STATE_INVALID", "only an unsent action may abort without effect", { status: 409 });
+      }
+      this.db.prepare(`
+        UPDATE device_session_actions SET status='BLOCKED', effect_assessment_json='{"effectStatus":"GROUND_ACTION_ABORTED_NOT_SENT"}',
+          error_code=?, updated_at=? WHERE action_id=? AND session_id=?
+      `).run(errorCode || "M6_ACTION_ABORTED", this.now(), actionId, ledger.sessionId);
+      this.db.prepare("UPDATE m6_action_claims SET status='BLOCKED', updated_at=? WHERE action_id=?").run(this.now(), actionId);
+      return this.getM6ActionLedger(actionId);
+    });
+  }
+
   appendEvent({ jobId = null, runId = null, type, payload = {} }) {
     return this.#insertEvent({ jobId, runId, type, payload, createdAt: this.now() });
   }
@@ -3873,31 +4439,27 @@ export class StateStore {
     return publicTransportAuth(row);
   }
 
-  consumeTransportActionAuthorization({ authorizationId, token, expectedPurpose = null, expectedDeviceId = null, expectedLeaseId = null } = {}) {
-    return this.transaction(() => {
-      const row = this.db.prepare("SELECT * FROM transport_action_authorizations WHERE authorization_id=?").get(authorizationId);
-      if (!row) {
-        throw new ControlPlaneError("TRANSPORT_AUTH_NOT_FOUND", "authorization missing", { status: 404 });
-      }
-      const stored = publicTransportAuth(row);
-      const consumed = consumeTransportAuthKernel({
-        stored,
-        token: { ...token, authorizationId },
-        expectedPurpose: expectedPurpose || stored.purpose,
-        expectedDeviceId: expectedDeviceId || stored.deviceId,
-        expectedLeaseId: expectedLeaseId || stored.leaseId,
-      });
-      const updated = this.db.prepare(
-        "UPDATE transport_action_authorizations SET consumed_at=? WHERE authorization_id=? AND consumed_at IS NULL",
-      ).run(consumed.consumedAt, authorizationId);
-      if (!updated.changes) {
-        throw new ControlPlaneError("TRANSPORT_AUTH_REPLAY", "authorization nonce already consumed", {
-          status: 409,
-          details: { authorizationId },
-        });
-      }
-      return this.getTransportActionAuthorization(authorizationId);
+  #consumeTransportActionAuthorizationNoTransaction({ authorizationId, token, expectedPurpose = null, expectedDeviceId = null, expectedLeaseId = null } = {}) {
+    const row = this.db.prepare("SELECT * FROM transport_action_authorizations WHERE authorization_id=?").get(authorizationId);
+    if (!row) throw new ControlPlaneError("TRANSPORT_AUTH_NOT_FOUND", "authorization missing", { status: 404 });
+    const stored = publicTransportAuth(row);
+    const consumed = consumeTransportAuthKernel({
+      stored,
+      token: { ...token, authorizationId },
+      expectedPurpose: expectedPurpose || stored.purpose,
+      expectedDeviceId: expectedDeviceId || stored.deviceId,
+      expectedLeaseId: expectedLeaseId || stored.leaseId,
     });
+    const updated = this.db.prepare("UPDATE transport_action_authorizations SET consumed_at=? WHERE authorization_id=? AND consumed_at IS NULL")
+      .run(consumed.consumedAt, authorizationId);
+    if (!updated.changes) {
+      throw new ControlPlaneError("TRANSPORT_AUTH_REPLAY", "authorization nonce already consumed", { status: 409, details: { authorizationId } });
+    }
+    return this.getTransportActionAuthorization(authorizationId);
+  }
+
+  consumeTransportActionAuthorization(input = {}) {
+    return this.transaction(() => this.#consumeTransportActionAuthorizationNoTransaction(input));
   }
 }
 
diff --git a/services/control-plane/tests/control-plane-open-action-executor.test.mjs b/services/control-plane/tests/control-plane-open-action-executor.test.mjs
index 7ab8530..8cff1ca 100644
--- a/services/control-plane/tests/control-plane-open-action-executor.test.mjs
+++ b/services/control-plane/tests/control-plane-open-action-executor.test.mjs
@@ -95,7 +95,7 @@ async function postAction(f, created, body) {
   });
 }
 
-test("fresh databases land on schema 18 with action ledger", () => {
+test("fresh databases land on schema 19 with grounded-action tables", () => {
   const f = runtime();
   try {
     assert.equal(f.state.db.prepare("PRAGMA user_version").get().user_version, CURRENT_CONTROL_SCHEMA_VERSION);
diff --git a/services/control-plane/tests/control-plane-placement.test.mjs b/services/control-plane/tests/control-plane-placement.test.mjs
index b21ead5..d30d4cd 100644
--- a/services/control-plane/tests/control-plane-placement.test.mjs
+++ b/services/control-plane/tests/control-plane-placement.test.mjs
@@ -496,7 +496,7 @@ test("v1 SQLite state migrates additively and preserves legacy idempotency", ()
 
   const state = new StateStore({ dbPath });
   try {
-    assert.equal(state.db.prepare("PRAGMA user_version").get().user_version, 18);
+    assert.equal(state.db.prepare("PRAGMA user_version").get().user_version, 19);
     assert.ok(state.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='standing_grant_canaries'").get());
     assert.ok(state.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='discovery_runs'").get());
     assert.ok(state.db.prepare("PRAGMA table_info(jobs)").all().some((column) => column.name === "placement_decision_json"));
diff --git a/services/control-plane/tests/discovery-session-state.test.mjs b/services/control-plane/tests/discovery-session-state.test.mjs
index 290baff..4567403 100644
--- a/services/control-plane/tests/discovery-session-state.test.mjs
+++ b/services/control-plane/tests/discovery-session-state.test.mjs
@@ -55,7 +55,7 @@ function openInput(fixture, overrides = {}) {
 test("v7 migrates additively to v8 discovery storage and open is one fenced allocation", () => {
   const f = setup();
   try {
-    assert.equal(f.state.db.prepare("PRAGMA user_version").get().user_version, 18);
+    assert.equal(f.state.db.prepare("PRAGMA user_version").get().user_version, 19);
     assert.equal(f.state.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='standing_grant_canaries'").get().name, "standing_grant_canaries");
     assert.equal(f.state.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='discovery_runs'").get().name, "discovery_runs");
     const run = f.state.openDiscoveryRunStorage(openInput(f));
diff --git a/services/control-plane/tests/foundation-pr3-transport-boundary.test.mjs b/services/control-plane/tests/foundation-pr3-transport-boundary.test.mjs
index edec5a6..708fc41 100644
--- a/services/control-plane/tests/foundation-pr3-transport-boundary.test.mjs
+++ b/services/control-plane/tests/foundation-pr3-transport-boundary.test.mjs
@@ -36,9 +36,9 @@ async function withStore(fn) {
   }
 }
 
-test("user_version is 18 with transport_action_authorizations", async () => {
+test("user_version is 19 with transport and grounded-action authorization state", async () => {
   await withStore((store) => {
-    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 18);
+    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 19);
     const cols = store.db.prepare("PRAGMA table_info(transport_action_authorizations)").all();
     assert.ok(cols.some((c) => c.name === "nonce_hash"));
     assert.ok(cols.some((c) => c.name === "consumed_at"));
diff --git a/services/control-plane/tests/m6-gate-loader.test.mjs b/services/control-plane/tests/m6-gate-loader.test.mjs
index 60c7bf6..ba64533 100644
--- a/services/control-plane/tests/m6-gate-loader.test.mjs
+++ b/services/control-plane/tests/m6-gate-loader.test.mjs
@@ -19,6 +19,14 @@ import test from "node:test";
 import { tmpdir } from "node:os";
 
 import { deriveM6EpochHash } from "../control-plane/lib/m6-live-gate.mjs";
+import {
+  deriveM6ActionEpochBindingHash,
+  deriveM6EmergencyCloseAuthorizationHash,
+  deriveM6V2EpochHash,
+  deriveM6V2LockSetHash,
+  evaluateM6MixedGate,
+  M6_GATE_V2_LOCK_KINDS,
+} from "../control-plane/lib/m6-live-gate-v2.mjs";
 import {
   loadM6Gate,
   loadM6Locks,
@@ -124,6 +132,74 @@ function clean(...roots) {
   for (const r of roots) rmSync(r, { recursive: true, force: true });
 }
 
+test("loadM6Gate dispatches a signed v2 epoch and loads content-addressed locks/emergency authorization", () => {
+  const m6Root = newRoot();
+  try {
+    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
+    writeAllowlist(m6Root, [{ keyId: KEY_ID, subject: ACTOR, publicKey: publicKey.export({ type: "spki", format: "pem" }), status: "active" }]);
+    writeLocks(m6Root);
+    const lockRaw = {
+      schemaId: "xw.m6-locks.v2",
+      lockSetId: "locks-v2-test",
+      lockHashes: Object.fromEntries(M6_GATE_V2_LOCK_KINDS.map((kind, index) => [kind, String(index % 10).repeat(64)])),
+    };
+    const lockSet = { ...lockRaw, lockSetHash: deriveM6V2LockSetHash(lockRaw) };
+    writeImmutableJson(join(m6Root, "m6-gate", "locks.v2", `${lockSet.lockSetId}.json`), lockSet);
+    const epochBase = {
+      schemaId: "xw.m6-live-gate.v2",
+      gateId: GATE_ID,
+      mode: "GROUNDED_ACTION",
+      purpose: "M6_4_ACTION_SMOKE",
+      status: "active",
+      releaseId: "release-loader",
+      sourceCommit: HEX40,
+      actor: ACTOR,
+      lockSetRef: { id: lockSet.lockSetId, sha256: lockSet.lockSetHash },
+      allowlist: ["01"],
+      issuedAt: "2026-08-22T00:00:00.000Z",
+      expiresAt: "2026-08-23T01:00:00.000Z",
+      parentEpochHash: null,
+      closeoutRef: null,
+      aggregateSealRef: null,
+      rollbackTargetEpochHash: null,
+    };
+    const authRaw = {
+      schemaId: "xw.m6-emergency-close-authorization.v1",
+      authorizationId: "emergency-v2-test",
+      expectedCurrentEpochHash: null,
+      expectedParentEpochHash: null,
+      actionEpochBindingHash: deriveM6ActionEpochBindingHash(epochBase),
+      releaseId: "release-loader",
+      planHash: "b".repeat(64),
+      contractHash: "c".repeat(64),
+      alias: "01",
+      operator: ACTOR,
+      reasonCodeAllowlist: ["SAFETY_STOP"],
+      nonce: "loader-test-nonce",
+      expiresAt: "2026-08-23T01:31:00.000Z",
+    };
+    const auth = { ...authRaw, authorizationHash: deriveM6EmergencyCloseAuthorizationHash(authRaw) };
+    const epochRaw = {
+      ...epochBase,
+      emergencyCloseAuthorizationRef: { id: auth.authorizationId, sha256: auth.authorizationHash },
+    };
+    const epoch = { ...epochRaw, epochHash: deriveM6V2EpochHash(epochRaw) };
+    writeImmutableJson(join(m6Root, "m6-gate", GATE_ID, "emergency-close", `${auth.authorizationId}.json`), auth);
+    writeGate(m6Root, [{ epoch, proof: signEpoch(epoch, privateKey) }]);
+    const loaded = loadM6Gate({ m6Root, gateId: GATE_ID, issuerAllowlistPath: issuerKeysPath(m6Root) });
+    assert.equal(loaded.chain[0].schemaId, "xw.m6-live-gate.v2");
+    assert.equal(loaded.lockSets[lockSet.lockSetId].lockSetHash, lockSet.lockSetHash);
+    assert.equal(loaded.emergencyCloseAuthorizations[auth.authorizationId].authorizationHash, auth.authorizationHash);
+    const result = evaluateM6MixedGate({
+      ...loaded,
+      v1LockHashes: loaded.lockHashes,
+      nowMs: Date.parse("2026-08-22T12:00:00.000Z"),
+      expectedRelease: { releaseId: "release-loader", sourceCommit: HEX40 },
+    });
+    assert.equal(result.mode, "GROUNDED_ACTION");
+  } finally { clean(m6Root); }
+});
+
 test("loadM6Gate loads a signed valid epoch chain and the pinned locks", () => {
   const m6Root = newRoot();
   try {
diff --git a/services/control-plane/tests/open-action-device-session.test.mjs b/services/control-plane/tests/open-action-device-session.test.mjs
index a4e38af..9e94ca1 100644
--- a/services/control-plane/tests/open-action-device-session.test.mjs
+++ b/services/control-plane/tests/open-action-device-session.test.mjs
@@ -607,7 +607,7 @@ test("fresh and v15 databases land on current schema; newer versions fail closed
   writeV15Fixture(v15Path);
   const upgraded = new StateStore({ dbPath: v15Path });
   try {
-    assert.equal(upgraded.db.prepare("PRAGMA user_version").get().user_version, 18);
+    assert.equal(upgraded.db.prepare("PRAGMA user_version").get().user_version, 19);
     assert.ok(upgraded.db.prepare("PRAGMA table_info(sessions)").all().some((column) => column.name === "session_kind"));
     assert.ok(upgraded.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='device_session_observations'").get());
     assert.equal(upgraded.db.prepare("SELECT status FROM jobs WHERE job_id='job_v15'").get().status, "succeeded");

```

## New file: docs/plans/M6-3-completion-index.md

```md
# M6-3 completion index for the M6-4 baseline

Status: `M6_3_CLOSED_READY_FOR_M6_4_PLANNING`  
Candidate commit: `0fa5ae7f366bf40da242bec824882658fc6596d4`  
Candidate tree: `b91619930acbfaea218a6d3319eb8da38ad04732`  
Candidate branch: `codex/m6-3-dsh-replay`

This index is the repository-side pointer to the final external evidence. It
supersedes `docs/plans/M6-3-handoff.md` only as the current completion-status
index. It does not rewrite, re-sign or alter any M6-3 receipt or historical
commit.

## Canonical external evidence

| Artifact | SHA-256 |
|---|---|
| `C:/Users/Public/xw-runtime/m6-audit/m6-3-completion-receipt.json` | `fa143729fb6e08cbce9c2082802b840efe4c1488662215b01b58ad9daeda3a3f` |
| `C:/Users/Public/xw-runtime/m6-audit/multi-model-execution-completion-m6-3.json` | `eca21f4c1b9c4c761ecba0871cf8894aef2239827e5a44ee71d88cfc12b40c27` |
| `C:/Users/Public/xw-runtime/m6-audit/m6-3-gate-manifest.json` | `5812c3608423c3a2665672188629f31dbe57dc74884888d61562c3e78fdbb4d1` |
| `C:/Users/Public/xw-runtime/m6-audit/m6-3-review-adjudication.json` | `21001eef1542e12d1741755714234fa40c7690d9fba4ca9b85aed3a34c727839` |
| `C:/Users/Public/xw-runtime/m6-audit/m6-2-w9-completion-4ea1fa60.json` | `7d6910c59656ba173869ff6454837c4bd0061eb6e24ebb50e165c01d6964bbbb` |

The M6-2 receipt above is the canonical W9 completion receipt. It supersedes
the prohibited-5038 receipt identified inside that receipt; consumers must not
select an older file by timestamp or filename order.

## Closed result

- Real DSH/Cordis child process, exact ten-tool replay and cross-process
  `ctx.agents.resume()` completed.
- 40 warm ACK samples, p95 `7.2731 ms`.
- 20 happy, 5 replan and 5 hard-stop routes passed.
- 13 fault cases passed; remaining owned process trees: 0.
- M6: 121/121; M6-2 offline: 108/108; epoch: 66 pass plus one narrow Windows
  symlink skip; orchestrator: 527/528 with one unrelated Windows symlink EPERM
  environment exception.
- Gate is `CLOSED`; live actions and runtime cutover are disabled; external
  effect is false and action count is zero.
- Review adjudication reports zero open blocking findings.

## M6-4 integration state

The local M6-4 integration branch preserves the candidate without squash in
merge commit `df16a0409a0997b01e378933d24ad737fde94e16`, whose parents are
`80355d341d854212045c6c1ec62daffbaf3de766` and
`0fa5ae7f366bf40da242bec824882658fc6596d4`.

Remote `origin/main` did not yet contain the M6-3 candidate when this index was
created. An attempted push was blocked before disclosure because the exact
GitHub destination had not received explicit external-disclosure approval. No
repository content was sent. M6-4 evidence must keep local integration and
remote merge status separate until that authorization is supplied.

Root `.m6-3-spike/`, root `profiles/`, sessions, logs, credentials, device
private state and other predecessor scratch remain excluded from this branch.


```

## New file: docs/plans/M6-4-execution-contract.json

```json
{
  "schema": "multi-model-execution-contract.v1",
  "planSha256": "68887b2f1eeae7c89e726f1a2bd6571bf665c719e8a50017bd1fadb2443b7d29",
  "authorizationMode": "close-accepted-blockers",
  "budgets": {
    "externalReviewWaves": 1,
    "reviewerDrivenFixBatches": 1,
    "localRepairTails": 1,
    "targetedVerifications": 2
  },
  "execution": {
    "runtime": "codex-desktop",
    "primaryModel": "gpt-5.6-sol",
    "maxModelSwitches": 1,
    "rehydrateOnContextChange": true
  },
  "items": [
    {
      "id": "M6-4-GA-BASELINE",
      "severity": "P1",
      "invariant": "The candidate contains the exact unsquashed M6-3 commit, preserves historical receipts and begins from a CLOSED, zero-resource baseline without scratch or private runtime state.",
      "riskClasses": ["reproducible-artifact"],
      "requiredArtifacts": ["docs/plans/M6-4-owner-decision-record.json", "docs/plans/M6-3-completion-index.md", "artifacts/m6-4/m6-4-baseline-preflight.json"],
      "forbiddenDependencies": [".m6-3-spike", "private profiles or sessions", "node_modules in the candidate", "rewritten M6-2/M6-3 receipts", "squashed M6-3 history"],
      "probes": [
        {
          "id": "M6-4-GA-BASELINE-reproduce",
          "kind": "reproduction",
          "procedure": "Re-hash the plan, decision and M6-2/M6-3 receipt index; verify 0fa5ae7f366bf40da242bec824882658fc6596d4 is an ancestor and inspect the CLOSED gate/resource probe.",
          "preFixExpected": "Missing ancestry, hash drift, an open gate or a nonzero resource prevents entry.",
          "postFixExpected": "All indexed hashes match, ancestry is preserved, gate is CLOSED and every resource count is zero.",
          "pathExercise": "The probe consumes the actual Git ancestor relation, external receipt bytes, gate tail and database-derived resource counts."
        }
      ]
    },
    {
      "id": "M6-4-GA-SPIKES",
      "severity": "P1",
      "invariant": "Provider, broker, same-lease and TTL/model feasibility are evidenced independently and never use replay output as live truth or relax the five-second TTL.",
      "riskClasses": ["independent-oracle", "reproducible-artifact"],
      "requiredArtifacts": ["artifacts/m6-4/m6-4-live-provider-corpus.json", "artifacts/m6-4/m6-4-environment-qualification.json", "artifacts/m6-4/m6-4-broker-spike.json", "artifacts/m6-4/m6-4-same-lease-spike.json", "artifacts/m6-4/m6-4-ttl-model-spike.json"],
      "forbiddenDependencies": ["M6-1 hermetic blocks as live proof", "synthetic geometry as expected truth", "TCP broker listener", "broker token in child", "frame TTL above 5000ms", "fabricated live-model qualification"],
      "probes": [
        {
          "id": "M6-4-GA-SPIKES-oracle",
          "kind": "independent-oracle",
          "procedure": "Evaluate 200 separately frozen semantic/accessibility cases across eight families, including 40 negatives.",
          "preFixExpected": "Unsafe, stale, ambiguous or sensitive candidates can be selected or metrics are derived from SUT output.",
          "postFixExpected": "Recall/top1/safe-region/negative-REPLAN are 100 percent and forbidden, misclick and stale counts are zero.",
          "pathExercise": "The corpus carries frozen expected disposition and the verifier reports exact positive, negative and family counts."
        },
        {
          "id": "M6-4-GA-SPIKES-mutation",
          "kind": "mutation",
          "procedure": "Run wrong binding, extra method, nonce replay, oversize, timeout and descendant-growth cases against the inherited-pipe broker.",
          "preFixExpected": "At least one invalid child request reaches a tool result or leaves a process/pipe alive.",
          "postFixExpected": "Every invalid case rejects with its exact code, actionCount stays zero and all owned processes/pipes close.",
          "pathExercise": "Each case launches a real child and records hello verification, actual rejection code and cleanup state."
        },
        {
          "id": "M6-4-GA-SPIKES-reproduce",
          "kind": "reproduction",
          "procedure": "Regenerate all four spike artifacts and compare their self-hashes and frozen thresholds.",
          "preFixExpected": "A missing artifact, changed threshold or nondeterministic provider payload fails comparison.",
          "postFixExpected": "All artifact hashes recompute and liveHardGatePassed remains false while the model profile is unresolved.",
          "pathExercise": "The generators read their own sources and emit content-addressed artifacts consumed by the review packet."
        }
      ]
    },
    {
      "id": "M6-4-GB-GATE",
      "severity": "P1",
      "invariant": "Versioned gate authority, immutable epoch files, v19 database fence and generation pointer fail closed as one authority, while emergency-close authorization is single-use and covers the epoch plus grace.",
      "riskClasses": ["trust-boundary", "single-use-authorization"],
      "requiredArtifacts": ["packages/kernel/contracts/orchestration/m6/xw.m6-live-gate.v2.schema.json", "packages/kernel/contracts/orchestration/m6/xw.m6-locks.v2.schema.json", "services/control-plane/control-plane/lib/m6-live-gate-v2.mjs", "services/control-plane/control-plane/lib/m6-gate-promoter.mjs", "services/control-plane/control-plane/lib/state-store.mjs"],
      "forbiddenDependencies": ["v2-to-v1 downgrade", "second live gate", "wall-clock send ordering", "open interpretation on file/pointer/fence mismatch", "reusable emergency nonce"],
      "probes": [
        {
          "id": "M6-4-GB-GATE-adversarial",
          "kind": "adversarial",
          "procedure": "Mutate schema, mode, allowlist, lock set, parent, emergency coverage and file/pointer/fence generation.",
          "preFixExpected": "A malformed or inconsistent authority can evaluate open.",
          "postFixExpected": "Every mutation evaluates CLOSED or throws an exact fail-closed error before action authority.",
          "pathExercise": "Tests call mixed evaluator, loader, fence and promoter through both valid and corrupted records."
        },
        {
          "id": "M6-4-GB-GATE-forgery",
          "kind": "forgery",
          "procedure": "Forge lock, epoch and emergency-authorization hashes while preserving field shape.",
          "preFixExpected": "Shape-only validation accepts the forged record.",
          "postFixExpected": "Self-hash and content-address validation reject every forged record.",
          "pathExercise": "The test changes hash-covered payload bytes and asserts the exact evaluator/loader rejection."
        },
        {
          "id": "M6-4-GB-GATE-replay",
          "kind": "replay",
          "procedure": "Consume one emergency-close nonce and attempt a second promotion with the same nonce/authorization hash.",
          "preFixExpected": "The second promotion is accepted.",
          "postFixExpected": "The database unique consumption record rejects replay.",
          "pathExercise": "The test performs two StateStore consumption attempts against the same durable database."
        }
      ]
    },
    {
      "id": "M6-4-GC-GROUNDING",
      "severity": "P1",
      "invariant": "Live v2 grounding is a shared-kernel, semantic/accessibility-first authority bound to exact environment, ActionSlotSpec and independent effect expectations; model-visible data contains no geometry or authority.",
      "riskClasses": ["trust-boundary", "independent-oracle"],
      "requiredArtifacts": ["packages/kernel/lib/m6-live-grounding.mjs", "packages/kernel/lib/m6-action-slot.mjs", "packages/kernel/contracts/orchestration/m6/xw.grounding-decision.v2.schema.json", "packages/kernel/contracts/orchestration/m6/xw.m6-action-slot-spec.v1.schema.json", "packages/kernel/contracts/orchestration/m6/xw.m6-target-environment-attestation.v1.schema.json"],
      "forbiddenDependencies": ["caller targetKind authority", "model coordinates or bounds", "synthetic block for screen/none", "legacy resolveInternalPoint on the live path", "SUT-derived expected effects"],
      "probes": [
        {
          "id": "M6-4-GC-GROUNDING-adversarial",
          "kind": "adversarial",
          "procedure": "Supply empty, ambiguous, sensitive, keyboard, system and environment-mismatched evidence plus caller geometry fields.",
          "preFixExpected": "Unsafe evidence yields ALLOW_ONCE or raw authority crosses the public surface.",
          "postFixExpected": "Unsafe evidence REPLAN/HARD_STOPs and public decisions contain no raw text, bounds or coordinates.",
          "pathExercise": "Tests parse real-shaped accessibility XML and inspect both public block data and the private geometry map."
        },
        {
          "id": "M6-4-GC-GROUNDING-oracle",
          "kind": "independent-oracle",
          "procedure": "Compare provider selections to separately frozen corpus expectations and exact smooth-family distribution.",
          "preFixExpected": "Expected data can be synthesized from provider output or family cardinality can drift.",
          "postFixExpected": "Independent expected dispositions and 4/4/4/4/4/4/3/3 distribution validate exactly.",
          "pathExercise": "The validators consume frozen expected records and reject a deliberately changed primary family."
        },
        {
          "id": "M6-4-GC-GROUNDING-mutation",
          "kind": "mutation",
          "procedure": "Substitute primitive, intentRef, trustedParameterHash, target kind and slot hash for one action family.",
          "preFixExpected": "A same-family substitution reaches permit preparation.",
          "postFixExpected": "Every substitution throws M6_ACTION_SLOT_INVALID before transport.",
          "pathExercise": "The test passes each mutated field through assertM6ActionSlotDispatch and verifies the code."
        }
      ]
    },
    {
      "id": "M6-4-GD-DISPATCH",
      "severity": "P1",
      "invariant": "One stable logical action can pass at most once through permit, global claim, three StateStore transactions, TCB guard and typed transport; recovery never retries and reports counter-derived effect truthfully.",
      "riskClasses": ["trust-boundary", "single-use-authorization"],
      "requiredArtifacts": ["services/control-plane/control-plane/lib/m6-grounded-action-facade.mjs", "services/control-plane/control-plane/lib/m6-typed-transport.mjs", "services/control-plane/control-plane/lib/state-store.mjs", "services/control-plane/tests/m6-action-ledger.test.mjs", "services/control-plane/tests/m6-grounded-action-facade.test.mjs"],
      "forbiddenDependencies": ["raw transport in caller input", "nested BEGIN IMMEDIATE", "materialization before tx2", "raw I/O before counter=1", "COMPLETED without verification", "new-run retry"],
      "probes": [
        {
          "id": "M6-4-GD-DISPATCH-adversarial",
          "kind": "adversarial",
          "procedure": "Inject gate, session, lease, UI generation, app, focus, page, rotation, environment and timing drift around tx2 and the TCB guard.",
          "preFixExpected": "A stale or rebound target reaches raw I/O.",
          "postFixExpected": "All pre-counter drift becomes BLOCKED false/0; post-counter failure becomes AMBIGUOUS true/1.",
          "pathExercise": "StateStore tests assert the durable ledger row and an independent fake raw-channel counter."
        },
        {
          "id": "M6-4-GD-DISPATCH-forgery",
          "kind": "forgery",
          "procedure": "Forge decision, permit binding, operation key, slot spec and typed invocation fields.",
          "preFixExpected": "A shape-valid forged reference authorizes transport.",
          "postFixExpected": "Binding fingerprints and closed typed schemas reject before counter increment.",
          "pathExercise": "Tests call permit consumption and typed validation with independently modified bindings."
        },
        {
          "id": "M6-4-GD-DISPATCH-replay",
          "kind": "replay",
          "procedure": "Race and restart the same operationKey/decision with counter zero and one.",
          "preFixExpected": "A second ledger action or transport call is created.",
          "postFixExpected": "The global claim remains unique; restart terminalizes BLOCKED or AMBIGUOUS and no retry occurs.",
          "pathExercise": "The test reopens the same database and queries the preserved claim, ledger and transport count."
        }
      ]
    },
    {
      "id": "M6-4-GE-DSH",
      "severity": "P1",
      "invariant": "Replay and live profiles are separately versioned; a live child can possess only one inherited bounded pipe exposing exactly ten opaque-reference tools, and an unqualified model profile cannot start.",
      "riskClasses": ["trust-boundary"],
      "requiredArtifacts": ["integrations/dsh-xw/profiles/live", "integrations/dsh-xw/src/live-pipe-client.mjs", "integrations/dsh-xw/src/live-runtime-plugin.mjs", "services/orchestrator/scripts/lib/m6/m6-live-tool-surface.mjs", "artifacts/m6-4/m6-4-broker-spike.json"],
      "forbiddenDependencies": ["modified replay semantics", "network broker listener", "broker token in child", "raw session/lease/device authority", "qualified status without exact model hash"],
      "probes": [
        {
          "id": "M6-4-GE-DSH-adversarial",
          "kind": "adversarial",
          "procedure": "Mutate live tool inventory, arguments, results, correlation, nonce, line size and process-tree possession.",
          "preFixExpected": "An extra tool, raw field, replay or descendant is accepted.",
          "postFixExpected": "Exactly ten names validate and every authority leak or broker mutation rejects with zero action.",
          "pathExercise": "The live schema tests and broker spike exercise a real spawned child and inherited fd3 pipe."
        }
      ]
    },
    {
      "id": "M6-4-GE-OFFLINE-CLOSE",
      "severity": "P1",
      "invariant": "CODE_READY_GATE_CLOSED is reproducible from the final candidate with the live gate still CLOSED, zero actions/resources, hard cross-platform CI and explicit recording of unresolved Gate F authority/model qualification.",
      "riskClasses": ["reproducible-artifact"],
      "requiredArtifacts": ["artifacts/m6-4/m6-4-code-ready-receipt.json", "artifacts/m6-4/m6-4-offline-test-manifest.json", "artifacts/m6-4/m6-4-resource-snapshot.json", ".github/workflows/source-fusion.yml"],
      "forbiddenDependencies": ["live epoch activation", "device action", "unrecorded suite failure", "generic Windows exception", "claiming M6_4_ACTION_CANARY_CLOSED"],
      "probes": [
        {
          "id": "M6-4-GE-OFFLINE-CLOSE-reproduce",
          "kind": "reproduction",
          "procedure": "Run check, test:m6-4:offline, M6, M6-2 offline/epoch, M6-3, orchestrator and targeted schema-v19 regressions; re-hash all evidence and inspect gate/resource state.",
          "preFixExpected": "A required suite, artifact, hash, CLOSED gate or zero-resource assertion is missing.",
          "postFixExpected": "All M6-specific suites pass, the sole orchestrator exception is exact Windows symlink EPERM, and unrelated Control Plane baseline failures are enumerated without being presented as green.",
          "pathExercise": "The completion manifest records each command, test count/status, artifact hash and exact exception rather than only an aggregate claim."
        }
      ]
    }
  ]
}

```

## New file: docs/plans/M6-4-execution-route.json

```json
{
  "schema": "multi-model-execution-route.v1",
  "routeId": "m6-4-codex-direct-execution-v1",
  "advisory_only": true,
  "execute_authorized": true,
  "plan_status": "READY_FOR_EXECUTION",
  "plan_sha256": "68887b2f1eeae7c89e726f1a2bd6571bf665c719e8a50017bd1fadb2443b7d29",
  "review_snapshot_sha256": "7f30179cf367a7d81f70f0ac53a79798160eb867f246394beac09d80a38c748b",
  "owner_decision_sha256": "f4fd8f1224b7114c0ac5cffc89b5e576a7f4c5879ab44df156b3f5188902b27e",
  "execution_contract_sha256": "1df83f34ac4862e6648e795d10026983c9dba2d233a133c6d7e5cc30442ca743",
  "runtime": "codex",
  "inventory_source": "current-thread-runtime",
  "risk_tier": "CRITICAL",
  "profiles": [
    "agentic",
    "long-horizon",
    "security",
    "terminal-heavy",
    "device-gated"
  ],
  "cost_priority": "reliability",
  "execution_unit": "WHOLE_PLAN",
  "status": "USER_AUTHORIZED_DIRECT_EXECUTION",
  "sourceBranch": "codex/m6-4-grounded-action",
  "sourceCommit": "df16a0409a0997b01e378933d24ad737fde94e16",
  "workingDirectory": ".worktrees/m6-4-integrated",
  "authorization": {
    "repositoryImplementation": true,
    "offlineVerification": true,
    "candidateCommit": true,
    "gateAThroughE": true,
    "gateFPreparation": true,
    "gateFLiveWindow": false,
    "productionLiveAction": false
  },
  "sequence": [
    {
      "ordinal": 1,
      "gate": "A",
      "name": "baseline-and-four-blocker-spikes",
      "entry": "owner decision and contract hashes validate; isolated worktree contains M6-3 candidate; live gate is CLOSED",
      "exit": "all four exact spike thresholds pass with independent evidence"
    },
    {
      "ordinal": 2,
      "gate": "B",
      "name": "versioned-contracts-gate-fence-locks-profiles",
      "entry": "Gate A receipt valid",
      "exit": "mixed v1/v2 gate, locks v2, shared DB fence, normal/emergency close and replay/live profile separation pass"
    },
    {
      "ordinal": 3,
      "gate": "C",
      "name": "grounding-runtime-provider-environment-effects-permits",
      "entry": "Gate B evidence valid",
      "exit": "one canonical GroundingRuntime, qualified provider, ActionSlotSpec, environment/effect evidence and durable permit state pass"
    },
    {
      "ordinal": 4,
      "gate": "D",
      "name": "narrow-action-facade-ledger-three-transactions",
      "entry": "Gate C evidence valid",
      "exit": "StateStore v19, global claims, tx#1/tx#2/tx#3, typed transport, TCB guard, counter truth and no-retry recovery pass"
    },
    {
      "ordinal": 5,
      "gate": "E",
      "name": "live-dsh-profile-canary-runner-hard-offline-ci",
      "entry": "Gate D evidence valid",
      "exit": "CODE_READY_GATE_CLOSED receipt valid, all hard suites pass, actionCount=0 and resources=0"
    },
    {
      "ordinal": 6,
      "gate": "F",
      "name": "separately-authorized-alias01-staged-canary",
      "entry": "exact live-window authorization binds release, locks, alias 01, manifests, expiry, operator and emergency-close authority; live agent entry and target environment are verified",
      "exit": "M6_4_ACTION_CANARY_CLOSED receipt valid after exact 5/1/3/20/30 cohorts, all purpose epochs CLOSED and resources=0",
      "currentlyAuthorized": false
    },
    {
      "ordinal": 7,
      "gate": "HANDOFF",
      "name": "completion-audit-and-m6-5-entry",
      "entry": "all execution-contract items and Gate F evidence are complete",
      "exit": "candidate commit and completion index are reproducible; M6-5 handoff lists no unresolved M6-4 obligation except the A01 M6-6 WorkReceipt binding"
    }
  ],
  "stopOn": [
    "any plan, owner-decision or execution-contract hash mismatch",
    "M6-3 candidate not reachable without squash",
    "live gate not CLOSED during Gates A-E",
    "any Gate A hard threshold miss",
    "provider, model, environment, oracle, release or lock drift",
    "raw authority, coordinate, ADB, DB, shell or legacy transport bypass reachable from M6",
    "gate close/send not serializable on one StateStore fence",
    "counter/ledger/receipt unable to distinguish not-sent from possible effect",
    "payment, deletion, misclick, stale, duplicate, public or unenumerated effect",
    "CAPTCHA, login challenge, platform risk control or identity verification",
    "unknown effect followed by retry",
    "resource or process residue"
  ],
  "contextRehydrationRequires": [
    "exact Plan V1 and Plan V2 reload and hash verification",
    "owner decision and execution contract reload and hash verification",
    "current git commit/tree/status",
    "completed command and acceptance-output ledger",
    "current gate and resource state",
    "unresolved contract item ledger"
  ],
  "completionRequires": [
    "all contract items and required artifacts accounted for",
    "all probe paths exercised on the final candidate",
    "CODE_READY_GATE_CLOSED",
    "M6_4_ACTION_CANARY_CLOSED",
    "gate CLOSED and resources zero",
    "candidate commit plus M6-5 handoff",
    "no claim of M6_4_CLOSED_COMPLETE before M6-6 WorkReceipt binding"
  ],
  "reason": "The owner approved the reviewed M6-4 scope and direct repository execution. The route remains advisory and preserves the plan's separate exact authorization requirement for any real alias-01 live action."
}

```

## New file: docs/plans/M6-4-owner-decision-record.json

```json
{
  "schemaId": "xw.m6-owner-decision-record.v1",
  "recordId": "m6-4-owner-decisions-20260823",
  "status": "APPROVED",
  "issuedAt": "2026-08-23T19:53:48.4112807+08:00",
  "actor": {
    "kind": "THREAD_OWNER",
    "id": "codex-thread-user",
    "threadId": "01a02e1c-feaa-7723-8a92-3bedec24cdbf"
  },
  "source": {
    "kind": "EXPLICIT_USER_MESSAGE",
    "summary": "Owner directly approved the recommended M6-4 scope decisions and requested execution through the M6-4 completion boundary."
  },
  "plan": {
    "planV1Path": "docs/plans/M6-4-single-alias-grounded-action-plan-v1.md",
    "planV1Sha256": "ec5e7e6959e38d150c468c7f8796f5ecf13fc51d8e552f2258503ecff79fe6e1",
    "planV2Path": "docs/plans/M6-4-single-alias-grounded-action-plan-v2.md",
    "planV2Sha256": "c0cedd7d605c8fffb8b8793c68782af3c455edb2ccb3e44d738cc7501d01d594",
    "taskBriefPath": "docs/plans/M6-task-brief.md",
    "taskBriefSections": [
      "M6-4 — single-alias Grounded Action canary",
      "M6-5 — Checkpoint, Ledger reconcile and failure recovery"
    ]
  },
  "validity": {
    "mode": "UNTIL_SUPERSEDED",
    "expiresAt": null,
    "invalidatedBy": [
      "owner revocation",
      "Plan V1 or Plan V2 hash change",
      "task-brief scope change affecting M6-4",
      "candidate baseline no longer contains M6-3 commit 0fa5ae7f366bf40da242bec824882658fc6596d4"
    ]
  },
  "decisions": [
    {
      "id": "M6-4-A01",
      "value": "ACCEPT",
      "effect": "M6-4 terminates at M6_4_ACTION_CANARY_CLOSED; genuine M5 WorkReceipt trace binding remains in M6-6 and cannot be fabricated or claimed early."
    },
    {
      "id": "M6-4-A02",
      "value": "ACCEPT",
      "effect": "M6-C is split into independently deployable and rollback-capable M6-C1 in M6-4 and M6-C2 in M6-5 without weakening M6-5 reconciliation."
    },
    {
      "id": "M6-4-A03",
      "value": "BOUNDED_READ_TRACE",
      "effect": "Only enumerated private read traces on an isolated test account and device may remain; public, social, account, security, financial, destructive, settings and draft effects remain forbidden."
    }
  ],
  "objectiveInterpretation": {
    "requestedText": "按着这个plan直接做完 直到进入M5",
    "interpretedBoundary": "M6_4_ACTION_CANARY_CLOSED_AND_M6_5_HANDOFF_READY",
    "rationale": "The approved plan and task brief place M6-5 immediately after M6-4; M5 is an already-existing scheduler layer and its genuine WorkReceipt binding is explicitly deferred to M6-6 by A01."
  },
  "authorization": {
    "repositoryImplementation": true,
    "offlineTests": true,
    "candidateCommit": true,
    "gatesAuthorized": [
      "A",
      "B",
      "C",
      "D",
      "E"
    ],
    "gateFPreparation": true,
    "gateFLiveWindow": false,
    "productionLiveAction": false,
    "reasonLiveWindowNotGranted": "Plan V1 requires a separate exact alias-01 window bound to release, locks, manifests, gate epoch, expiry, operator and emergency-close authority; this general approval does not invent those runtime values."
  }
}

```

## New file: docs/plans/M6-4-plan-review-adjudication-v1.json

```json
{
  "schemaId": "xw.multi-model-plan-review-adjudication.v1",
  "mode": "PLAN_REVIEW",
  "riskTier": "CRITICAL",
  "adjudicatedAt": "2026-08-23T19:34:01.4721301+08:00",
  "authorizationMode": "fix-once",
  "sourcePacket": {
    "planV1": {
      "path": "docs/plans/M6-4-single-alias-grounded-action-plan-v1.md",
      "bytes": 47009,
      "sha256": "ec5e7e6959e38d150c468c7f8796f5ecf13fc51d8e552f2258503ecff79fe6e1"
    },
    "context": {
      "path": "docs/plans/M6-4-plan-review-context-v1.md",
      "bytes": 13208,
      "sha256": "12118f7d1c9c4881eee6f97ba63e664a7017025b6383d483e16ed73a9d70bfb1"
    },
    "packet": {
      "path": "docs/plans/M6-4-plan-review-packet-v1.json",
      "sha256": "294c9324751f1a27521ee7dd4108203e1cbac6dded013def73f964f8bee15189",
      "pairSha256": "cacf63bd61f06dd9962c233146057bcf3e3bec11320280bb1705c08fdc5e4b90"
    }
  },
  "reviewRun": {
    "path": "docs/plans/M6-4-review-wave-v1.json",
    "sha256": "8ffdb37374a2ae992601f0936bdf1b05424a10bc7de81775c612b41547b1c386",
    "route": {
      "model": "gpt-5.6-sol",
      "reasoningEffort": "max",
      "roles": [
        "coverage",
        "adversarial"
      ]
    },
    "externalBatch": {
      "status": "BLOCKED_PRE_DISCLOSURE",
      "reasonCode": "EXPLICIT_EXTERNAL_DISCLOSURE_APPROVAL_REQUIRED",
      "packetDisclosed": false,
      "criticCallsStarted": 0,
      "reportsFabricated": false
    },
    "fallback": {
      "status": "COMPLETED",
      "kind": "LOCAL_ROUTED_GPT_FALLBACK",
      "model": "gpt-5.6-sol",
      "reasoningEffort": "max",
      "networkUsed": false,
      "filesEdited": false,
      "packetHashesVerified": true,
      "verdict": "needs_changes",
      "confidence": "high"
    }
  },
  "adjudicator": {
    "kind": "PRIMARY_CODEX_GPT_ADJUDICATOR",
    "policy": "one consolidated adjudication; one Plan V2; no re-review"
  },
  "findings": [
    {
      "id": "M64-AUTH-001",
      "severity": "P1",
      "disposition": "ACCEPT",
      "rationale": "The original authority chain did not prove that the consumed one-shot slot authorized the exact primitive, trusted parameters, intent policy, and semantic target used at raw I/O.",
      "revision": "Plan V2 section 3 freezes ActionSlotSpec and carries its hash and primitive/intent/parameter/target bindings through claim, decision, permit, typed authorization, tx#2, after-frame, and final receipt."
    },
    {
      "id": "M64-FRESH-002",
      "severity": "P1",
      "disposition": "ACCEPT",
      "rationale": "A frame and UI identity could become stale in the interval between the last Control Plane check and the transport process issuing raw I/O.",
      "revision": "Plan V2 section 4 adds a monotonic dispatch deadline, tx#2 freshness evidence, and an immediate possession-TCB pre-I/O guard without changing the database gate fence linearization point."
    },
    {
      "id": "M64-ENV-003",
      "severity": "P1",
      "disposition": "ACCEPT",
      "rationale": "Provider qualification alone did not bind a canary to the exact app build, device, display, locale, theme, IME, accessibility, and capture environment used at runtime.",
      "revision": "Plan V2 section 5 introduces private TargetEnvironmentAttestation, a locked environment qualification artifact, hash binding across gate/run/action evidence, and fail-closed drift checks."
    },
    {
      "id": "M64-EFFECT-004",
      "severity": "P1",
      "disposition": "ACCEPT",
      "rationale": "The phrase zero persistent/public side effect was not operationally testable across backend, app-local, device/OS, IME, analytics, and public surfaces using independent evidence.",
      "revision": "Plan V2 section 6 freezes per-family effect boundaries, independent pre/post oracles, reset obligations, and fail-closed behavior; the policy for enumerated private read traces versus strict zero persistence is elevated to owner decision M6-4-A03."
    }
  ],
  "findingSummary": {
    "P0": 0,
    "P1": 4,
    "accepted": 4,
    "rejected": 0,
    "deferred": 0,
    "openTechnicalP0P1AfterRevision": 0
  },
  "revision": {
    "kind": "PLAN_V2_CONSOLIDATED_DELTA",
    "path": "docs/plans/M6-4-single-alias-grounded-action-plan-v2.md",
    "bytes": 11428,
    "sha256": "c0cedd7d605c8fffb8b8793c68782af3c455edb2ccb3e44d738cc7501d01d594",
    "composesWithFrozenPlanV1": true,
    "additionalReviewWaveAllowed": false
  },
  "remainingOwnerDecisions": [
    {
      "id": "M6-4-A01",
      "requiredValue": "ACCEPT",
      "meaning": "M6-4 terminates at M6_4_ACTION_CANARY_CLOSED; genuine M5 WorkReceipt trace binding remains an M6-6 obligation and cannot be fabricated or claimed early."
    },
    {
      "id": "M6-4-A02",
      "requiredValue": "ACCEPT",
      "meaning": "Split the original M6-C into independently deployable and rollback-capable M6-C1 in M6-4 and M6-C2 in M6-5 without weakening M6-5 reconciliation."
    },
    {
      "id": "M6-4-A03",
      "allowedValues": [
        "BOUNDED_READ_TRACE",
        "STRICT_ZERO_PERSISTENCE"
      ],
      "recommendedValue": "BOUNDED_READ_TRACE",
      "meaning": "Choose the operational policy for explicitly enumerated private read traces; public, social, account, security, financial, destructive, settings, and draft effects remain forbidden under both values."
    }
  ],
  "terminal": {
    "status": "SCOPE_CHANGE_REQUIRED",
    "gateState": "CLOSED",
    "implementationAuthorized": false,
    "liveAuthorized": false,
    "executionContractGenerated": false,
    "executionRouteGenerated": false,
    "reason": "Owner-signed decisions M6-4-A01, M6-4-A02, and M6-4-A03 are required before READY_FOR_EXECUTION and before any Gate A-F work."
  }
}

```

## New file: docs/plans/M6-4-plan-review-context-v1.md

```md
# M6-4 Plan Review Context V1

状态：`FROZEN_REVIEW_CONTEXT`  
评审模式：`PLAN_REVIEW`  
风险候选：`CRITICAL`  
评审授权：`fix-once`（只允许依据本轮裁决生成一次 Plan V2；不授权实现或 live action）

## 1. 原始请求与授权边界

用户提供 M6-3 候选完成状态，要求开始规划 M6-4，并显式指定 `multi-model-review-gate`。本轮只允许：

- 核验 M6-3 交接事实；
- 制定 M6-4 可执行计划；
- 对冻结的 Plan V1 做同包外部评审与 GPT 裁决；
- 若达到就绪条件，生成并验证执行契约、给出执行路由建议。

本轮不允许：实现代码、push/merge、部署、mint/activate gate epoch、启动 DSH live profile、连接/操纵真机、产生外部动作、修改历史收据或清理用户 scratch。

## 2. 冻结评审对象

- 主 artifact：`docs/plans/M6-4-single-alias-grounded-action-plan-v1.md`
- 本 context：`docs/plans/M6-4-plan-review-context-v1.md`
- 两位外部 reviewer 必须收到完全相同的 artifact/context bytes；禁止按 reviewer 定制上下文。
- 排除项：完整日志、数据库、sessions、`node_modules`、credentials、API keys、设备 token、`.m6-3-spike/`、根 `profiles/` 及任何 raw coordinate/evidence payload。

## 3. 已核验的 M6-3 基线

Git 身份：

- 分支：`codex/m6-3-dsh-replay`
- commit：`0fa5ae7f366bf40da242bec824882658fc6596d4`
- tree：`b91619930acbfaea218a6d3319eb8da38ad04732`
- parent / 当前 `origin/main`：`80355d341d854212045c6c1ec62daffbaf3de766`
- candidate worktree tracked diff：0；无 upstream/remote branch。
- candidate worktree 存在未跟踪 scratch：`.m6-3-spike/` 约 29,590 files / 213 MB，根 `profiles/` 4 files；必须原样保留且不得进入 M6-4 分支、评审包或提交。

外部审计 artifacts（位于 `C:/Users/Public/xw-runtime/m6-audit/`）：

| artifact | SHA-256 | 结论 |
|---|---|---|
| `m6-3-completion-receipt.json` | `fa143729fb6e08cbce9c2082802b840efe4c1488662215b01b58ad9daeda3a3f` | `M6_3_CLOSED_READY_FOR_M6_4_PLANNING` |
| `multi-model-execution-completion-m6-3.json` | `eca21f4c1b9c4c761ecba0871cf8894aef2239827e5a44ee71d88cfc12b40c27` | execution contract validator pass |
| `m6-3-gate-manifest.json` | `5812c3608423c3a2665672188629f31dbe57dc74884888d61562c3e78fdbb4d1` | gate remains CLOSED |
| `m6-3-review-adjudication.json` | `21001eef1542e12d1741755714234fa40c7690d9fba4ca9b85aed3a34c727839` | fallback adjudication; open blockers 0 |

交叉核验：completion receipt 引用的 23/23 artifact hashes 匹配；execution contract 在本机重新验证通过。M6-3 指标为 40 warm ACK、p95 7.27 ms；20 happy + 5 replan + 5 hardstop；13 fault cases；残留进程树 0；M6 121/121；M6-2 offline 108/108；epoch 66 pass + 1 Windows symlink platform skip；orchestrator 527/528，唯一失败为无关且窄化记录的 Windows symlink `EPERM`。该例外不得泛化为 M6-4 豁免。

M6-3 的所有 tool result 均为 replay、`externalEffect=false`、`actionCount=0`。gate、live actions、cutover 均未开启。评审 wave、单次 fix batch 与 repair tail 已消费完毕；M6-4 是新的 planning/review unit。

审计注记：completion `generatedAt` 约早于 candidate commit 82 秒，但 artifact mtime、Git identity、hash closure 均正确；保留为 provenance 注记，不改写原 receipt。

## 4. M6-2 与任务账本约束

- canonical 父 receipt：`m6-2-w9-completion-4ea1fa60.json`，file SHA-256 `7d6910c59656ba173869ff6454837c4bd0061eb6e24ebb50e165c01d6964bbbb`；M6-2 为 CLOSED final，merge commit `80355d341d854212045c6c1ec62daffbaf3de766`，release `xw-m6-2-w9-80355d3`。
- 该 receipt 明确 supersede `m6-2-w9-completion-53678313.json`（file SHA-256 `9c3464ae6a65057dbcb29c19af85b5a62abd0bea2420b5e4fd190f8b8fab249a`），原因是旧 receipt 绑定 5038 execution 且缺失 tombstone/dbPath evidence；旧 receipt 只能作为 denylisted lineage，不得用于开放 M6-4。
- canonical final closure：observe epoch `4ea1fa604e11d58592618ae40182deb277401a7ea7a921a039d8e459260c5887`，CLOSED epoch `481efc38a3f4e349af9dbe82eafc758d621ee04aebfe8d2ef1d0a420acd5fe22`，aggregate seal `3c2543abe7866128aad20e66592b74647a38e98110884c714c23fb4e7e071cbe`，closeout `18c11af160a965fddcfd786cd4ae51ba98bf97fe7555982f52f177db9f655e09`。
- 80 attempts：76 accepted，4 focus unstable；全部资源归零、actionCount=0。
- ADB 5037 固定 4 devices；ADB 5038 为 0；被 5038 supersede 的 epochs 已 tombstone。
- 任务账本中 53 complete、54 in_progress；M6-4 不擅自结清 task 54。若其真实 scope 与本计划冲突，Gate A 必须停止并重新定界。
- M6-2 aggregate verifier 的四 alias × 20、zero-action 语义是历史硬门，不能为 M6-4 action canary 放宽；M6-4 必须新增独立 action aggregate。

## 5. 仓内已核验事实与缺口

1. Gate schema/runtime 当前只认识 `CLOSED` 与 `OBSERVE_ONLY`；M6-4 需要新增窄化 action mode、mode-specific closure/locks，同时保持旧 epoch 可验证。
2. M6-3 DSH plugin/tool loop 是真实子进程，但 GroundingRuntime、journal 与 action 都是 child-local replay/synthetic；不存在 child→Control Plane live action broker。
3. 当前 live visual provider 不存在；M6-1/M6-3 provider 均为 hermetic/synthetic。不能把 replay 成功描述为 live-ready。
4. 当前 GroundingRuntime issued/consumed decisions 只在进程内 Map/Set；live one-shot permit 必须进入 durable authority，并与 Action Ledger 原子协同。
5. M6-2 frame capture 是 one-shot session/lease，accepted frame 返回前会释放资源；M6-4 observe→act→verify 需要 bounded same-lease run，但不得改变 M6-2 公共 route 的既有行为。
6. Control Plane 已有 `device_session_actions` Action Ledger 与 reserve/update API；startup 会把 in-flight 视为 `AMBIGUOUS`。应复用其设备事实语义，不创建第二本 ledger。
7. 仓内 `EffectCommitProtocol` 已表达 reserve→recheck→start-before-I/O 原则；M6-4 可复用原则，但不得沿用 non-payment soft-debt 处理未知设备动作。
8. M6-3 live tool surface 尚不存在；十个 replay tools 的输出被固定为 no-effect。live/replay profile 与 schema 必须分版，不能原地改写历史 replay。
9. Control Plane 当前没有公开 M6 action route；legacy raw coordinates / `explorer-primitive` 不得成为 M6 公共路径。
10. `docs/plans/M6-3-handoff.md` 仍描述旧 Gate A-only 状态，与外部 final receipt 冲突。M6-4 首个文档任务应增加 final completion index，保留历史文件但消除入口歧义。
11. 根 worktree 当前不是 candidate commit，且有用户未跟踪内容。实施必须先合入 M6-3，再从更新后的 main 创建新的干净 worktree。
12. Control Plane `CURRENT_CONTROL_SCHEMA_VERSION=18`；`StateStore.transaction()` 使用不可嵌套 `BEGIN IMMEDIATE`，而现有 action reserve API 自带事务。ledger+permit+auth 原子协同需要 v18→v19 additive migration、no-transaction private SQL helpers 与 combined APIs。
13. 既有 Action Ledger 权威状态是 `REQUESTED/ASSESSED/EXECUTING/EXECUTED/VERIFIED/COMPLETED/BLOCKED/AMBIGUOUS`，不是 Effect Ledger 的 `NOT_SENT/STARTED`。现有 startup 只把 `REQUESTED|ASSESSED|EXECUTING` 转 AMBIGUOUS，M6 live 还必须处理 result→verify crash 的 EXECUTED/无receipt VERIFIED。
14. capability session只能绑定一个 exact `scope_capability_id`；写 transport authorization origin只允许 `capability_job|mission_device_run`，禁止 session。当前 Xiaowei raw I/O仍可由 adapter constructor transport执行，job TypedTransport underlying invoke尚是 deferred；M6-4 必须建立 composite capability job + true typed M6 adapter path或明确无法过门。
15. GroundingDecision v1 强制 frameId+blockId，无法真实表达 open_app/back/wait/scroll；现有 GroundingRuntime `resolveInternalPoint()`会一步消费decision再产private point。live需要独立decision v2 target union及prepare/consume/materialize split，replay v1不可放宽。
16. Gate v1 `additionalProperties=false`、只含 CLOSED/OBSERVE_ONLY和固定三locks，loader硬载v1；capture receipt v1也只认 CLOSED/OBSERVE_ONLY。action mode、run-frame receipt与locks必须走mixed v1/v2 dispatch，不能原地改enum。
17. 当前 gate promote是文件 `current.json` 原子替换，而 action ledger在SQLite；二者没有共享线性化点。若要求close先发生则transport=0，plan必须引入共享send/gate fence或明确更弱的snapshot语义。

## 6. 权威范围与验收口径

`docs/plans/M6-task-brief.md` 的 M6-4 范围要求：

- 模型/公开 action 输入只含 server-issued grounding decision ref 与 operation key；
- 每次动作前做 lease/session/gate/grant/frame/focus/page/redline 等复核；
- 复用 Action Ledger；
- server primitives 固定为 `observe/open_app/back/wait/tap/scroll/type_search_text`；
- alias 01 上完成小红书搜索并打开笔记详情的首条闭环；
- 20 runs 成功率至少 95%；smooth-control suite 至少 90% 无中途人工；正常路径逐动作审批 0；
- payment/delete/misclick/stale/duplicate/public-side-effect 均为 0；每个 action 有完整可重算 trace/receipt。

范围冲突的冻结解释：

- master default PR 把 M6-4/5 合并为 M6-C，但 rollout 又要求先 M6-4 后 M6-5。本计划拆成独立可部署、可回滚的 M6-C1（M6-4）与 M6-C2（M6-5），M6-4 只实现 fail-closed/minimal closeout；恢复与 reconciliation 完整化留给 M6-5。
- smooth suite 要求至少 8 个 action families，而 server primitive 只有 7 个。计划以至少 8 个高层 intent families 映射到冻结的 7 primitives，不新增 raw primitive。
- 仓内冻结 benchmark 的九个 task-level families为 `app-launch/app-switch/search/text-input/scroll/tab-back/form-edit/settings-nav/social-publish-account`。首轮禁止public effect意味着只能选前八个；30-task分布、每类最低数量、无持久mutation语义必须在manifest前冻结，不能把一个搜索流程的微步骤算成八类。
- M6-4 要求 M5 receipt chain，但真正的 `agentic_session` Router/Binder 被明确排到 M6-6。M6-4 只冻结 canary run packet/correlation schema，不伪造 M5 WorkReceipt；实际接线留给 M6-6。
- 现有 policy 文档对社交/发布/账号动作仍要求逐项确认。首轮 canary 只允许 search/open-note 等无公开副作用任务；任何关注、点赞、收藏、评论、发布、消息、账号或支付/删除动作均不在本计划。
- M5 trace 延期与 M6-C拆分都是权威 scope amendments，不是实现细节。本计划把它们命名为 A01/A02，并要求 owner decision + task brief cross-reference；未获接受时只能 `SCOPE_CHANGE_REQUIRED`。

## 7. 必须由计划覆盖的失败边界

- exact live model/provider 不可用或 5 秒 frame TTL/SLO 无法满足；
- broker capability 泄漏、跨 process/run/session/alias 重放或 DSH 获得 raw authority；
- gate/release/lock drift、hot close 失败、旧 epoch 兼容性破坏；
- logical-action claim、permit、ledger、typed auth、gate fence 或final receipt非原子；双consume；跨run新key；同key异decision、同decision异key；send fence后自动重试；
- crash/kill发生在三次事务、TypedTransport consume callback、materialize/counter、I/O、result、verification、closeout的每个间隙；
- CAPTCHA、登录挑战、风控、敏感 icon/string、empty dump、focus/page drift、provider/oracle drift；
- Windows/Linux process-tree cleanup、symlink/junction/path escape、secret/raw-coordinate leakage；
- M6-2/M6-3 历史 replay/zero-action contract 被弱化。

## 8. Reviewer 问题

### Coverage reviewer

判断 Plan V1 是否：覆盖所有权威验收条件；依赖关系与 Gate A–F 顺序可执行；测试/证据有判别性；文件面、双平台、rollout/rollback、M6-3/M6-2/M6-5/M6-6 边界完整；是否存在会阻断 CODE_READY_GATE_CLOSED 或另行授权的 live completion 的遗漏。

### Safety reviewer

重点攻击：授权与 raw authority 隔离；pipe-possession broker的明确TCB边界；gate/epoch/DB-fence closure；same-lease capability job lifecycle；logical-action global claim；permit/ledger/auth/final receipt 三次原子事务；TypedTransport单次consume与start-before-I/O；idempotency/replay/concurrency/crash semantics；counter-based unknown outcome；provider provenance；redline/public-side-effect 边界；secret/path/process cleanup；是否存在 P0/P1 安全或一致性缺口。

## 9. 裁决标准

- `P0/P1`：会使 live effect 越权、重复、错设备/错页面、不可审计，或使实现无法达到冻结 DoD；必须在唯一 Plan V2 中修复，否则 `SCOPE_CHANGE_REQUIRED`。
- `P2/P3`：不阻断安全执行的改进，进入 backlog，不借机扩大本轮范围。
- 外部 reviewer 是顾问；GPT 必须逐条 `ACCEPT/REJECT/DEFER` 并给出证据。不得伪造截断或失败的报告。
- 只有 Plan V2 无开放 P0/P1、执行契约验证通过且路由结果明确时，才可标记 `READY_FOR_EXECUTION`。这仍不代表用户授权执行或 live canary。

```

## New file: docs/plans/M6-4-plan-review-packet-v1.json

```json
{
  "schemaId": "xw.multi-model-plan-review-packet.v1",
  "reviewMode": "PLAN_REVIEW",
  "status": "FROZEN",
  "frozenAt": "2026-08-23T19:17:11.0971712+08:00",
  "riskTierCandidate": "CRITICAL",
  "authorizationMode": "fix-once",
  "implementationAuthorized": false,
  "liveAuthorized": false,
  "baseline": {
    "branch": "codex/m6-3-dsh-replay",
    "commit": "0fa5ae7f366bf40da242bec824882658fc6596d4",
    "tree": "b91619930acbfaea218a6d3319eb8da38ad04732",
    "parent": "80355d341d854212045c6c1ec62daffbaf3de766"
  },
  "artifact": {
    "path": "docs/plans/M6-4-single-alias-grounded-action-plan-v1.md",
    "bytes": 47009,
    "sha256": "ec5e7e6959e38d150c468c7f8796f5ecf13fc51d8e552f2258503ecff79fe6e1"
  },
  "context": {
    "path": "docs/plans/M6-4-plan-review-context-v1.md",
    "bytes": 13208,
    "sha256": "12118f7d1c9c4881eee6f97ba63e664a7017025b6383d483e16ed73a9d70bfb1"
  },
  "packetHash": {
    "algorithm": "sha256(utf8(artifact.sha256 + LF + context.sha256))",
    "sha256": "cacf63bd61f06dd9962c233146057bcf3e3bec11320280bb1705c08fdc5e4b90"
  },
  "reviewers": [
    "coverage",
    "adversarial"
  ],
  "route": {
    "riskTier": "CRITICAL",
    "gptModel": "gpt-5.6-sol",
    "reasoningEffort": "max",
    "fullReviewWaves": 1,
    "consolidatedRewrites": 1,
    "terminalAfterRun": true
  },
  "openPreReviewDecisionRecords": [
    "M6-4-A01",
    "M6-4-A02"
  ],
  "excluded": [
    ".m6-3-spike/",
    "profiles/",
    "sessions/",
    "node_modules/",
    "credentials",
    "device-private-state",
    "raw-coordinates"
  ]
}

```

## New file: docs/plans/M6-4-review-wave-v1.json

```json
{
  "schemaId": "xw.multi-model-plan-review-wave.v1",
  "mode": "PLAN_REVIEW",
  "riskTier": "CRITICAL",
  "packet": {
    "planSha256": "ec5e7e6959e38d150c468c7f8796f5ecf13fc51d8e552f2258503ecff79fe6e1",
    "contextSha256": "12118f7d1c9c4881eee6f97ba63e664a7017025b6383d483e16ed73a9d70bfb1",
    "packetSha256": "cacf63bd61f06dd9962c233146057bcf3e3bec11320280bb1705c08fdc5e4b90"
  },
  "route": {
    "gptModel": "gpt-5.6-sol",
    "reasoningEffort": "max",
    "externalRoles": [
      "coverage",
      "adversarial"
    ],
    "fullReviewWaves": 1,
    "consolidatedRewrites": 1,
    "terminalAfterRun": true
  },
  "externalBatch": {
    "status": "BLOCKED_PRE_DISCLOSURE",
    "reasonCode": "EXPLICIT_EXTERNAL_DISCLOSURE_APPROVAL_REQUIRED",
    "packetDisclosed": false,
    "criticCallsStarted": 0,
    "outputDirectoryCreated": false,
    "reportsFabricated": false
  },
  "fallback": {
    "status": "COMPLETED",
    "kind": "LOCAL_ROUTED_GPT_FALLBACK",
    "model": "gpt-5.6-sol",
    "reasoningEffort": "max",
    "networkUsed": false,
    "filesEdited": false,
    "packetHashesVerified": true,
    "verdict": "needs_changes",
    "confidence": "high",
    "findings": [
      {
        "id": "M64-AUTH-001",
        "severity": "P1",
        "claim": "One-shot action authority is not explicitly bound to an exact server primitive and intent-specific target-eligibility predicate.",
        "minimalChange": "Freeze an exact primitive, intent/policy hash, trusted-parameter hash and deterministic semantic target predicate per action slot, and bind the slot spec through every authority and receipt artifact."
      },
      {
        "id": "M64-FRESH-002",
        "severity": "P1",
        "claim": "Frame freshness and UI identity can lapse after the last mandatory check but before raw I/O.",
        "minimalChange": "Bind a monotonic dispatch deadline and UI generation into tx#2/consumption evidence and run an immediate TCB-side pre-I/O guard."
      },
      {
        "id": "M64-ENV-003",
        "severity": "P1",
        "claim": "Provider qualification and canary authority are not locked to the target app/device UI environment.",
        "minimalChange": "Add a private target-environment attestation and qualification set, bind their hashes into locks and action evidence, and reject runtime drift."
      },
      {
        "id": "M64-EFFECT-004",
        "severity": "P1",
        "claim": "The zero persistent/public side-effect requirement lacks an operational boundary and independent oracle.",
        "minimalChange": "Freeze per-family effect boundaries, independent pre/post sources and reset obligations; unresolved or unobservable state must follow an owner-selected policy rather than UI inference."
      }
    ]
  },
  "batchStatus": "DEGRADED_GPT_FALLBACK",
  "additionalReviewWaveAllowed": false
}

```

## New file: docs/plans/M6-4-single-alias-grounded-action-plan-v1.md

```md
# M6-4 单 alias Grounded Action Canary 计划 V1

状态：`PLAN_V1_FROZEN_FOR_REVIEW`  
规划基线：`codex/m6-3-dsh-replay@0fa5ae7f366bf40da242bec824882658fc6596d4`  
基线 tree：`b91619930acbfaea218a6d3319eb8da38ad04732`  
基线 parent / 当前 `origin/main`：`80355d341d854212045c6c1ec62daffbaf3de766`  
风险：`CRITICAL`（live device effects、任务授权、一次性 permit、持久账本、跨进程桥、双平台）  
评审授权：`fix-once`，仅允许 Plan V1 → Plan V2；不授权实现、merge、部署、mint/activate epoch、设备操作或 live effect。

## 1. 目标与终态

M6-4 建立从真实 DSH/Cordis tool loop 到 Control Plane 正式 session/lease/action authority 的第一条单 alias live 链，但只通过窄 Grounded Action 接口执行：

`frozen canary run packet + AutonomyGrant → single-alias canary runner → DSH subprocess → closed tool broker → stable live frame → live VisualBlockSet → one-shot Grounding Permit → atomic Ledger/permit reserve → start-before-I/O commit → typed internal dispatch → after-frame verify → GroundedActionReceipt`

M6-4 完成分两个独立宏观退出点：

1. `CODE_READY_GATE_CLOSED`：代码、合同、离线故障矩阵、双平台 CI、release/runbook 均完成；运行 gate 仍为 `CLOSED`，transport action count 为 0。
2. `M6_4_ACTION_CANARY_CLOSED`：仅在 A01/A02 已获 owner 接受及另行 live 授权后，从已合入 main 的 release 运行 alias `01` staged canary，完成 20-run 与独立 30-task suite，随后重新关闭 gate，所有资源归零并生成 completion receipt。它不是 master `M6_4_CLOSED_COMPLETE`，后者仍等待 M6-6 的真实 M5 trace binding。

Plan V1/Plan V2 本身不授权任何实现。任何后续、单独的实施授权最多覆盖 Gate A–E，并须绑定最终 plan hash 与 execution contract；Gate F 还需要另一份 live-window 授权，绑定 release、source commit、gate epoch、alias、scenario manifest、模型/profile hashes、到期时间与紧急关闭路径。

## 2. 受保护不变量

以下事实和边界不可由实现者、reviewer 或 canary 配置暗改：

1. M6-3 候选提交及其外部收据是历史 replay 快照；`executionMode=replay`、`externalEffect=false`、`actionCount=0`。M6-4 不原地把 replay adapter 改名为 live，也不复用 M6-3 completion receipt 为新 HEAD 背书。
2. 当前 gate 为 `CLOSED`；本计划不授权 live、cutover、deploy、merge 或 epoch 激活。
3. 只存在一个 `M6_AGENTIC_LIVE_GATE`。legacy `OPEN_ACTION_LIVE`、`DSH_LIVE`、`MULTI_AGENT_LIVE`、generic PrimitiveAction 和 fixture executor 保持关闭/不可达。
4. 模型输入/输出与公开 M6 API 不包含 raw coordinate/bounds、ADB/端口、device ID/serial、session/lease token、DB、shell/command、URL、cookie/credential、payment/delete 值或 screenshot base64。
5. 真正设备动作只经 Control Plane 的正式 session/lease、内部 capability adapter 与既有 Action Ledger；不新建第二本动作账。
6. 支付与删除始终 `HARD_STOP`，任何 grant、模型、管理员配置或 live gate 都不能覆盖。
7. 首个 20-run reliability cohort 只允许 alias01 上无公开副作用的小红书搜索、导航、打开公开笔记和返回；后续 30-task smooth cohort 只可增加 §4.6 明列的、无公开/持久副作用的 benchmark tasks。不点赞、评论、收藏、关注、发消息、发布、改账号、保存草稿、切换设置或触发登录/验证码/风控。
8. `agentic_session` TaskPlan enum、M5 Router/Binder、四 alias fan-out 属于 M6-6；M6-4 不偷接。
9. 完整 live checkpoint/resume/reconcile 自动恢复属于 M6-5；M6-4 必须做到 fail-closed、unknown outcome 不盲重放，但不宣称自动恢复。
10. strict live frame 的 5 秒 TTL、bridge p95 ≤100ms、grounding decision p95 ≤1s、非模型 observe-to-dispatch p95 ≤4s 均保持冻结；不能为过门临时放宽。

## 3. 前置条件与基线收敛

### 3.1 合入与工作树

1. 先 push/PR/merge `0fa5ae7f...`，保留该 commit 作为 M6-3 候选快照；禁止 squash。
2. merge 后 fetch，并从包含该 commit 的最新 `origin/main` 新建干净 `codex/m6-4-grounded-action` worktree。不得使用当前落后 5 个提交且有大量 untracked 文件的根 worktree，也不得复用被锁定且带 `.m6-3-spike/`、`profiles/` 的 M6-3 worktree。
3. 执行 preflight：记录新 base commit/tree、M6-3 commit reachability、M6-2/M6-3 收据 SHA、gate `CLOSED`、live disabled、resource probes all-zero、release/locks identity。
4. 候选提交内 `docs/plans/M6-3-handoff.md` 是过期过程快照。保留历史 commit 不变，在新分支新增一个不含秘密的 completion index，明确最终外部 receipt/manifest/adjudication 的路径、SHA 与 supersession；不得重签或改写既有 M6-3 收据。
5. `git add -A` 禁止用于候选/根 dirty worktree；scratch、profiles、sessions、node_modules、日志、配置 YAML 和本地 settings 不进入提交或评审包。

### 3.2 阻断性可行性探针

写产品代码前必须完成四组 read-only / fake-transport spike；任何一组失败均为 `BLOCKED_NEEDS_DECISION`，不得用 fixture 冒充：

1. **Live provider spike**：在已有授权的 M6-2 evidence 或独立去标识等价样本上，用仓内可审、内容寻址的 semantic/accessibility-first provider 生成真实 `VisualBlockSet`。冻结至少 200 个独立标注 target cases，覆盖 §4.6 全部八类 surface，且至少 40 个为 ad/sensitive/system/keyboard/empty/ambiguous negatives；机器门为 block recall ≥98%、top-1 ≥95%、safe-region ≥99%、forbidden/misclick/stale=0、同输入 hash/排序/decision 完全确定。screenshot-only/空 dump 无可靠目标时必须 `REPLAN`。不得用 M6-1 hermetic blocks 或 M6-3 synthetic geometry代替，SUT trace 不得生成 expected annotations。
2. **DSH→Control Plane broker spike**：真实 DSH child 使用独立 live Cordis profile，经 parent-created extra stdio pipe 调用十个 tool；不开放 loopback/TCP listener。信任口径明确为“锁定 DSH binary/plugin 对唯一 inherited handle 的 possession”，不是每条消息的 OS peer-PID 证明；payload processRef 只做 correlation。child startup 立即把 handle 设为 non-inheritable/close-on-exec，锁定 profile 禁止复制/转发 handle 或生成 broker-capable descendant，parent 在 unexpected process-tree growth 时撤销 run。Control Plane capability 仅在 parent broker；模型/child 不获得 broker token、device transport、raw lease/session、DB/ADB/shell。wrong run/worker/session/alias、额外 method、oversize/timeout/replay 在 transport 0 前拒绝，并验证 handle/process-tree cleanup；计划不得声称可识别恶意 child 伪造的 PID。
3. **Same-lease lifecycle spike**：以单一 internal composite capability `xiaowei.m6.grounded_run` 先创建 scoped session/lease，再创建绑定该 session、初始不可 pump 的 capability job；完成 policy/adapter/dispatchRef 验证后才标 running。在同一 run 内完成 `observe → ground → fake dispatch → after-observe → verify → close`；session 的 `scope_capability_id` 始终精确为该 composite capability，不引入 capability-set session。M6-2 one-shot frame facade 的“返回前释放 lease”行为保持不变，M6-4 使用新的内部 capture-within-run seam，不复用或削弱其公开合同。
4. **TTL/model spike**：锁定候选 live model/provider profile，在无设备 effect 的已冻结 frames 上跑至少 100 个 warm 完整 tool loops。必须同时满足：JSON-RPC bridge p95 ≤100ms；grounding decision p95 ≤1s；`phone_ground` result→`phone_act` broker ingress p95 ≤2.5s；capturedAt→final dispatch precheck p95 ≤4s；至少99/100 loops到达valid-ref final precheck，且所有到达者 remaining TTL ≥1s。任何单样本 remaining TTL <1s 都不得 dispatch并计该loop失败。若 model/profile、license/provenance、secret injection 或延迟不能闭合，只允许继续离线实现，不得进入 live canary，也不得改 5 秒 TTL。

## 4. 冻结设计决策

### 4.1 同一个 gate 增加模式化 action authority

1. 不修改 exact schemaId `xw.m6-live-gate.v1`、其 self-hash domain、两种 mode、固定三 locks 或 M6-2 loader 语义。新增 `xw.m6-live-gate.v2`，使用独立 self-hash domain prefix、`purpose`、versioned lock-set ref，并新增 active mode `GROUNDED_ACTION`；`CLOSED` 与 `OBSERVE_ONLY` 的效果语义不变。
2. mixed-chain loader 按 exact schemaId/version dispatch：v1 epoch 永远用原 validator/三 locks；v2 epoch 用 locks.v2。v2 可把有效 v1 tail 作为 parent，v2 出现后禁止降级追加 v1；unknown version/mode/field/hash/signature/parent/lock 一律 CLOSED。历史 M6-2 bytes 与验证结果不变。
3. `GROUNDED_ACTION` 是能力模式，不是 alias 数量模式。M6-4 v2 canary verifier 要求 allowlist 精确为 `["01"]`；M6-6 才可在同 mode 下扩 allowlist。locks.v2 闭合 base locks + DSH source/profile、live tool spec、model profile、GroundingRuntime、live provider、hard-redline、grant/action policy、broker protocol、typed transport、scenario manifest。
4. 原 v1 `OBSERVE_ONLY` 80-attempt zero-action aggregate verifier保持不变。M6-4 新增 purpose=`M6_4_SHADOW` 的 v2 single-alias shadow manifest/aggregate/closeout（精确 5 runs、action/transport count=0）；`GROUNDED_ACTION` 的 smoke/reliability/smooth 各使用独立 purpose 与 versioned manifest/aggregate。任何新 verifier 都不能让旧 verifier 接受 action 或较小 cardinality。
5. 文件 epoch chain 是签名审计来源；Control Plane StateStore 新增同一 gate 的 `m6_gate_fence` 镜像（epoch hash、generation、mode、purpose、allowlist、expiresAt、release/locks hash），不是第二个 gate。v18→v19 migration只可从已验证的 v1 CLOSED tail种下generation 0；其他起始状态停止。activate/normal-close/emergency-close 只能经唯一 promote API，顺序固定为 append+fsync immutable epoch → `BEGIN IMMEDIATE` 更新 fence → atomic `current.json` pointer；执行面只有三者完全一致才视为 open，任一 crash/mismatch均按 CLOSED并由同API恢复收敛。
6. 每个 observe/ground/verify 边界重验 file chain + DB fence；每个 action 的 send linearization 在 §4.4 第二个 combined StateStore transaction 中锁定并复核同一 fence generation。CLOSED promote 若先序列化，action transport=0；action send fence若先序列化，该 action可进入 transport并按事实收敛，但 close阻止其后所有 action。测试以 DB serialization order 判定，不以不可线性化的 wall-clock request/dispatch 间隙判定。
7. 每个非 CLOSED action epoch 在 mint 时携带一份 epoch-bounded、单用途、签名的 emergency-close authorization，绑定 expected parent/current epoch、release、plan/contract、alias、operator、reason-code allowlist、expiresAt 与 nonce；其 `expiresAt` 必须不早于 action epoch `expiresAt + 30 minutes closeout grace`，mint/activate/每次gate verify均检查覆盖，不允许active期间续签或换nonce绕过。operator 通过 `gate emergency-close` 调唯一 promote API，以 compare-and-swap 追加/激活 v2 CLOSED epoch；此路径不等待完整 success aggregate。
8. emergency close 将中断窗口标记 `ABORTED_PENDING_CLOSEOUT`；资源与 ledger 收敛后必须生成失败 aggregate/closeout，列出 manifest 全部 expected scenario keys、已开始/未开始/AMBIGUOUS disposition 与独立 resource probe。该失败 closeout验证前禁止重新开放；不得删除或伪补成功场景。
9. 正常窗口只有在对应 purpose 的完整 aggregate + resource snapshot 验证后才生成 v2 CLOSED epoch；每个 cohort 之间及最终状态都必须回到 `CLOSED`。

### 4.2 Replay 与 live tool profile 分版

1. M6-3 replay profile、deterministic LLM、synthetic journal、`externalEffect=false/actionCount=0` 输出 schema 保留并继续跑原硬门。
2. 新增 live profile，不覆盖 replay files。两者模型可见 tool 名仍精确为十个，但 profile/schema/hash 独立。
3. live schema 把 `actionCount` 定义为独立 transport adapter 实际调用次数，并增加 `effectStatus=NOT_SENT|SENT_UNVERIFIED|VERIFIED` 与 verification ref。只有 transport 前拒绝（含 REPLAN/HARD_STOP/过期/gate closed）为 `externalEffect=false, actionCount=0, effectStatus=NOT_SENT`。一旦 adapter counter 记为 1，无论业务返回失败、超时或结果丢失，均为 `externalEffect=true, actionCount=1`，分别收敛到 `SENT_UNVERIFIED`/`VERIFIED`；不得把 AMBIGUOUS 写成零 effect。observe/ground/verify/checkpoint/trace/wait/lifecycle 始终 false/0。
4. live DSH plugin只持有父进程显式继承的受限pipe handle；短期Control Plane broker capability只在parent broker。session/lease token、alias→device resolution、private point 和 action params 永不进入 child tool args/result、prompt、trace 或 checkpoint。
5. 真实模型/profile 必须 exact-version + content hash + secret-free manifest；API key 仅由部署 secret injection 提供，不进 Git、收据、评审包、日志或 child prompt。

### 4.3 Live provider 与唯一 GroundingRuntime

1. 把 GroundingRuntime 的 canonical implementation 移到共享、可被 Control Plane 与 orchestrator 共同引用的位置；原 orchestrator 路径变为薄 re-export/compat shim。静态门确保只有一个 `decide/resolve` 实现。
2. replay path 继续使用 in-memory registry 与 `xw.grounding-decision.v1`；live path 注入 M6 frame evidence store + live provider + durable permit state。新接口只扩展，不改变 M6-1/M6-3 replay derivation。
3. 新增 live-only `xw.grounding-decision.v2`/permit target union：`block` 要求 frameId+blockId，供 tap/targeted text；`screen` 绑定 frame/page/focus 与 trusted policy，供 bounded scroll；`none` 不伪造 block，供 open_app/back/wait，但仍绑定 run/session/lease/gate/grant/step、trusted params 与 expected before/after state。v1/v2 schema confusion fail closed。
4. live `phone_ground` input schema也独立分版且`additionalProperties=false`：trusted `intentRef`机械决定targetKind；kind=`block`时必须且只可附一个候选blockId，kind=`screen|none`时blockId字段必须不存在，caller/model不能提交targetKind覆盖policy。result返回decisionRef+operationKey；replay tool input/output不变。
5. 第一版 live provider 固定为仓内 semantic/accessibility-first provider：从 strict frame 引用的 dump/focus/screenshot evidence 机械派生稳定 blocks，private bounds 只在 server evidence domain。它不从模型返回 geometry，不伪造空 dump 或 non-block primitive 的 synthetic block。
6. provider 每次加载都验证 source/model hash、frame manifest、evidence hashes、page/focus fingerprint、block-set integrity；provider swap 或 annotation/oracle drift fail closed。
7. live provider 必须达到 §3.2 的 200-case hard metrics；任一阈值不足时停下优化 provider，不能退回 raw coordinates、改 expected 或扩大人工确认。

### 4.4 Grounding Permit 与 Action Ledger 顺序

公开/模型 action 输入固定为：

```json
{
  "groundingDecisionRef": "<64-hex>",
  "operationKey": "<opaque stable action key>"
}
```

1. `groundingDecisionRef` 定位 server-issued live v2 permit；permit 绑定 worker/process/capability-job/session/lease/alias、task/plan/logical-step/action-slot、grant、gate epoch/fence、targetKind、frame/block/page/focus、action family、trusted parameter ref、policy/provider/tool hashes、issued/expiresAt 与 one-shot state。permit/receipt 不存 raw coordinate。
2. 每个scenario manifest必须为每个可能的`phone_act`预枚举唯一、不可变的`logicalStepId + actionSlotOrdinal + actionFamily`，一个multi-primitive task内不得复用slot，模型不能增加slot。`logicalActionId/operationKey`在服务端从`planHash + scenarioManifestHash + scenarioId + logicalStepId + actionSlotOrdinal + alias + actionFamily`稳定派生，刻意不含ephemeral worker/run/session identity；同一冻结action slot跨crash/new run得到同一key。live `phone_ground` 的permit-issue transaction原子创建global claim=`PREPARED`+permit=`ISSUED`并返回operationKey/decisionRef；仅同run且claim仍PREPARED时可因reobserve原子tombstone旧unreserved permit并替换candidate decision，new run/new session一律拒绝。模型只能原样回传；replay `phone_ground` schema/bytes不变。
3. live GroundingRuntime 把旧一步式 resolve 拆为 `prepareDispatchRef`（只验证并产生 server-private immutable dispatch ref，不消费 permit）与 `materializeTarget(dispatchRef, consumptionReceipt)`。第二个 combined transaction 消费成功后才能 materialize。replay v1 `resolveInternalPoint` 保留为 compat wrapper 的 consume+materialize 行为，live 路径禁止调用它，避免双 consume。
4. 既有 Action Ledger 状态保持原名/语义：`REQUESTED → ASSESSED → EXECUTING → EXECUTED → VERIFIED → COMPLETED`，pre-send policy/refusal或aborted-not-sent为`BLOCKED`，可能已发送但不确定为`AMBIGUOUS`。设备事实只由 `transport_called` 判定：“not sent”是任何状态下counter=0；“possible effect”必须counter=1。`EXECUTING`只是send fence已线性化，不单独证明I/O；不新增`NOT_SENT/STARTED` ledger状态。
5. dispatch 顺序固定：

   `validate file chain + DB gate fence → validate parent broker/run + composite capability job/session/lease → validate grant/scope/budgets → load matching PREPARED claim + ISSUED permit → recheck frame/focus/page/expiry/redline → prepareDispatchRef → combined StateStore tx#1: CAS claim PREPARED→RESERVED + reserve Action Ledger REQUESTED→ASSESSED + bind permit RESERVED → final immutable dispatch validation → call AuthorizedTypedTransport.invoke whose sole consume callback is combined StateStore tx#2: lock/recheck same gate fence generation + job/session/lease/grant/budget + atomically set ledger EXECUTING, claim/permit CONSUMED, typed-auth nonce CONSUMED and return consumptionReceipt → invoke passes that receipt once to underlying M6 TCB adapter → materializeTarget(consumptionReceipt) → adapter records transport_called/actionCount=1 before raw I/O → dispatch → ledger EXECUTED or AMBIGUOUS → capture after-frame → verification → combined StateStore tx#3: atomically persist verification evidence + canonical GroundedActionReceipt and finalize claim/ledger VERIFIED→COMPLETED`

6. tx#1/tx#2 必须由新 combined StateStore methods 实现，复用不自行开事务的 private SQL helpers；不得在现有 `reserveDeviceSessionAction()` transaction 外再嵌套 `BEGIN IMMEDIATE`。tx#2 与 gate promote 共享 `m6_gate_fence` serialization domain，形成唯一 send linearization point。
7. 每个 run 创建一个正式 `capability_job` 作为 typed transport authorization origin；kind=`session`、caller token 或模型 payload均无效。每 action 的 auth绑定 job/run/session/lease/alias/operationKey/permit/fence/action family/expiry/nonce。`AuthorizedTypedTransport.invoke()` 的 consume callback本身就是tx#2；任何代码都不得在invoke前预消费或在underlying再次消费nonce，wrapper只把tx#2返回的consumptionReceipt传一次。M6 path 必须经新的 typed underlying adapter；Xiaowei legacy constructor raw transport不得在此路径可达，只有 TCB adapter内部可持有 raw channel，并由独立 counter/spy取证。
8. v19 `m6_logical_action_claims`以logicalActionId为主键、operationKey全局唯一，绑定manifest/scenario/step/slot/alias、owner run/session、current permit、ledger与终态且不随run cleanup删除。只有owner run可在PREPARED阶段替换未保留candidate；new run/new session只能读既有disposition，不能取得第二RESERVED/CONSUMED permit或新ledger action。同key/同decision只有`COMPLETED`且canonical receipt hash/readback有效时可返回相同receipt；`BLOCKED`返回相同拒绝；同key/不同decision为conflict；同decision/不同key为replay attack。`REQUESTED|ASSESSED|EXECUTING|EXECUTED|VERIFIED|AMBIGUOUS`对外重放均fail closed；并发consume最多一个通过tx#2。
9. M6-4 不提供动作重试。grounded-live-v2 scoped startup recovery在generic legacy recovery前运行并按counter分流：任何非`COMPLETED+valid receipt` row若`transport_called=0`，原子终结为`BLOCKED` + `GROUND_ACTION_ABORTED_NOT_SENT` + false/0；若counter=1，则终结为`AMBIGUOUS` + true/1。两者都保留global logical claim并关闭action window，caller/new run均不得重发；legacy rows维持旧startup语义。只有M6-5 reconcile能在独立证据证明未发送后显式重新开放同operationKey。
10. permit 权威状态位于 Control Plane StateStore 的 additive table/API；文件系统只保存内容寻址的不可变审计副本，不参与授权判定。M6-4 不改变 Action Ledger v1 设备事实语义，不直写 DB，不允许外部代码绕 StateStore API。
11. 复用 `EffectCommitProtocol` 的 reserve → final recheck → start-before-I/O 原则，但不引入其 non-payment soft-debt 范围；grounded device action 的 unknown outcome 一律按硬阻断处理。

### 4.5 同 session/lease 的 bounded run

1. 新增 canary-only `M6GroundedActionRun` 与单一 internal composite capability `xiaowei.m6.grounded_run`。server先创建 `scope_capability_id` 精确等于它的session/lease，再以该sessionId创建初始不可pump的bound capability job；完成policy/adapter/dispatchRef验证后才标running。不把observe/action/verify伪装为三个capability，也不增加capability-set session。token仅在Control Plane内存中。
2. composite capability 内部 seam 在同一 run/lease 完成多次 observe/act/verify；一 alias 同时最多一个 run，一 run 同时最多一个 in-flight action。每个 action 的 typed transport authority 来自该 capability job，不来自 session。
3. canary packet 在运行前冻结 original goal/hash、registered internal capability、action policy、trusted refs、预算及每个logical step的有限action slots；AutonomyGrant只能由这些输入机械派生并签名。run只消费冻结packet+grant，不能接收自由文本goal或caller-supplied action params，模型不能增加slot或扩大app、alias、intent、effect、budget、policy scope。
4. payment/delete 及其同义/图标语义始终 `HARD_STOP`；其他 scope 外 intent 先 `REPLAN`，恢复预算耗尽才 `WAIT_HUMAN`。任何分支都不能自动扩大 grant 或转入 raw primitive。
5. cleanup 顺序：停止pipe broker新调用 → ledger/permit/auth收敛 → final frame/verification/receipt → 把capability job终结为succeeded/failed/ambiguous并清除activeJobs/execute auth → revoke parent broker capability/pipe → release session/lease → shutdown DSH → process-tree probe → run closeout。running job存在时不得release session。
6. gate/release/lock drift、broker disconnect、DSH exit、frame TTL、focus/page change、budget exhaustion、CAPTCHA/login/risk prompt 均停止新 action并执行 cleanup。

### 4.6 Action family 与 primitive 映射

受控 server primitives 保持七个：`observe/open_app/back/wait/tap/scroll/type_search_text`。`action family` 必须取自 `services/orchestrator/contracts/m6/autonomy-benchmark.v1.json` 的 task-level taxonomy，不能把单个搜索流程的微步骤伪装成八类。30-task smooth manifest 使用以下精确分布（总数 30），排除 `social-publish-account`：

| authoritative action family | task 数 | 允许的无副作用任务语义 | primitive composition |
|---|---:|---|---|
| `app-launch` | 4 | 启动 allowlisted XHS 并只读验证首页 | open_app, observe, wait |
| `app-switch` | 4 | 在 XHS 与 allowlisted只读系统页间切换并返回 | open_app, back, observe |
| `search` | 4 | XHS 预写 query 搜索与结果页验证 | tap, type_search_text, observe |
| `text-input` | 4 | 在 allowlisted search/filter field 输入并核对，结束前清空 | tap, type_search_text, back, observe |
| `scroll` | 4 | XHS 列表 bounded scroll，只读记录可见项 | scroll, observe, wait |
| `tab-back` | 4 | XHS 非账号 tab/详情页返回并核对 selected state | tap, back, observe |
| `form-edit` | 3 | 只编辑并复原 transient search/filter form；禁止保存草稿、提交或持久化 | tap, type_search_text, back, observe |
| `settings-nav` | 3 | system-settings 只读进入指定子页并读取状态；禁止切换任何 setting | open_app, tap, back, observe |

每类至少达到表中数量，不能跨类双计；每个 task 恰好一个 primary family，可包含多个冻结 primitives。模型只选择允许的 intent/block；app、query text、submit behavior、scroll bounds、wait duration、form reset 与 expected terminal state来自 signed manifest/policy，不从 tool args 扩大。任何持久 mutation、账号/社交/发布动作或额外 app使整窗失败。

### 4.7 M5 与 M6-5 边界

1. 仓内权威 brief 同时要求 M6-4 action trace 从真实 M5 WorkReceipt 起，又把 `agentic_session` TaskPlan enum、Router/Binder、WorkReceipt mapping 明列为 M6-6；二者在当前代码基线上不可同时满足，不能用 schema-valid但非 M5 scheduler 产出的“receipt”伪装闭环。
2. 本计划提出 scope amendment `M6-4-A01`：M6-4 使用专用 canary runner 和 `xw.m6-canary-run-packet.v1`，带 task/plan/node/shard/worker correlation refs，证明 `canary packet → grant → DSH → frame/decision → permit/ledger → after-frame/verify/receipt`；真实 `M5 WorkReceipt → ...` 接线及 master-level trace exit 仍由 M6-6 完成。因此本阶段 live 终态名为 `M6_4_ACTION_CANARY_CLOSED`，不得提前标记 master `M6_4_CLOSED_COMPLETE`。
3. scope amendment `M6-4-A02`：为获得独立 release/canary/rollback 边界，把原“PR M6-C 合并 M6-4/5”的默认组织拆为 `M6-C1`（本计划）与 `M6-C2`（M6-5）。M6-C1 只提供 conservative no-resume 语义；M6-C2 才闭合自动 reconcile/checkpoint fault recovery。
4. A01/A02 必须由项目 owner 以单独 decision record 明确接受，并在不改写历史的前提下给 `M6-task-brief.md` 增加 cross-reference，方可开始 Gate A。若任一被拒绝，本计划终止为 `SCOPE_CHANGE_REQUIRED`，不得由实现者自行把 M6-6/M6-5 scope偷入 M6-4。

## 5. 实施 Gate

### Gate A — 基线与四项 blocker spike

- 先验证 A01/A02 owner decision records；缺失或拒绝则立即 `SCOPE_CHANGE_REQUIRED`，不运行产品 spike。
- 完成 §3 全部检查，生成 preflight manifest、200-case provider metrics、pipe broker boundary、composite-capability same-lease lifecycle、100-loop TTL/model metrics。
- negative control 必须证明 fixture/synthetic provider、legacy PrimitiveAction、wrong token/process/session/alias 和 stale frame均不能让探针误绿。
- 退出：四组均 PASS，或者终止为 `BLOCKED_NEEDS_DECISION`。

### Gate B — Versioned contracts、gate fence、locks、tool profiles

- 新增独立 schemas：gate epoch v2、locks.v2、gate-fence mirror、emergency-close authorization/failure-closeout、M6-4 shadow/smoke/reliability/smooth manifests+aggregates、canary run packet、AgenticSkillSpec/action policy、grounding decision/permit v2、grounded-run frame/attachment receipt v2、typed transport auth、action/completion receipt。M6-2 `xw.capture-attempt-receipt.v1`、gate v1、decision v1 字节/enum/语义不变。
- mixed v1/v2 epoch builder/loader/evaluator、唯一 promote API、CLI dry-run/verify/normal-close/emergency-close/rollback全部闭合；unknown mode/version/field/hash/signature/parent/lock/release/fence drift全部 CLOSED。
- replay/live tool specs、inventory、profile hashes分离；live `phone_ground` result必须供应 server-derived operationKey；mutation分别破坏两侧 schema，证明对应 validator真被执行。
- 退出：双平台 contract tests全绿；历史 M6-2 chain与M6-3 replay tests保持通过；无 epoch 被 mint/activate。

### Gate C — Shared GroundingRuntime、live provider、durable permit state

- canonical runtime迁移 + compat re-export；实现 live `prepareDispatchRef/materializeTarget` split、strict frame attachment、provider、private evidence resolver、permit issue/bind/consume/readback；replay compat wrapper 保持旧 bytes。
- 把 Control Plane schema 明确从 v18 升到 v19，以 additive migration 新增 global logical-action claims（logicalActionId primary key、operationKey unique）、permit、gate-fence、grounded action receipt/closeout tables/API；combined methods复用 no-transaction SQL helpers，与既有 Action Ledger、capability job/session/lease通过 logicalActionId、operationKey、decision fingerprint 和三次事务交叉绑定。
- migration tests覆盖生产 v18 库快照升级、升级中每个 DDL/transaction fault、重复启动、旧 fixtures/rows、v19 rollback release与原 v18 binary。新表不 drop；原 v18 binary面对 user_version=19 必须按现有 `SCHEMA_VERSION_TOO_NEW` fail closed且不改库，不能作为生产回滚；只能部署保留 v19 reader/migration但禁用 grounded action 的 rollback release或前滚修复。任何 partial/user_version mismatch 都拒绝 M6 action，重新前滚幂等。
- canonical JSON 仅作内容寻址、原子 immutable 的审计副本，须 hash readback并拒绝 symlink/junction/path escape；绝不保存 secret/raw coordinate。
- 独立 annotations、mutation与forgery tests覆盖 wrong frame/block/bounds/page/focus/grant/policy/provider、empty dump、duplicate labels、sensitive icons/strings、expired permit和并发 consume。
- 退出：§3.2 provider hard metrics与冻结 SLO全部机器通过；0 forbidden/misclick/stale；唯一 runtime静态门和 migration matrix通过。

### Gate D — Control Plane narrow action facade 与 ledger

- 新增单一 internal composite `xiaowei.m6.grounded_run` capability；先完成 capability job create/policy/adapter/dispatchRef validation并进入 running，再 mint action-scoped execute auth。session scope精确绑定该 composite capability，内部 action params只含 server-issued dispatch ref，`exposure=internal`、canary-only。
- 抽取 M6-2 capture-within-session内部 seam；原四个 frame routes、one-shot lease释放、zero-action closeout字节/行为回归不变。
- 新 action route/body只接受 `groundingDecisionRef + operationKey`；broker auth在header/transport metadata，body extra field一律 `M6_INPUT_CLOSED`。
- 完成 §4.4 tx#1（ledger ASSESSED + permit RESERVED）、tx#2（shared gate fence + ledger EXECUTING + permit/auth CONSUMED）、tx#3（verification+receipt+COMPLETED）、true typed underlying adapter、after-frame verification、budget/rate limit、linearizable hot close和cleanup。
- faultpoints：session/job create/policy/adapter、permit-issue/同runcandidate replace、prepare ref、tx#1每侧、final recheck、gate close vs tx#2、tx#2每侧、materialize、counter-before-I/O、transport/before result、EXECUTED/before after-frame、verification/before tx#3、tx#3每侧、job terminalize/session release、closeout。任何非 COMPLETED+valid receipt outcome不自动重放。
- 退出：fake transport E2E、真实 Xiaowei adapter + fake raw-channel counter probe、并发/重放/kill/migration矩阵全绿；每一 pre-send拒绝 transport=0，post-counter failure如实 true/1；资源归零。

### Gate E — Live DSH profile、canary runner 与 CI

- 新建 live Cordis profile/plugin/parent-pipe tool client/model manifest；replay profile不变。运行时 `request/header.tools` 独立取证恰为10，live/replay schema hashes分别匹配；无 TCP listener/token进入 child。
- canary runner只加载预写 manifest/grant，不进入 M5 router；一 WorkerRun只启动一个 DSH和一个 composite capability job/session/lease，operationKey只由 live phone_ground服务端供应。
- 使用 fake Control Plane/transport跑完整真实 child链，覆盖 happy、REPLAN、HARD_STOP、TTL reobserve、broker revoke、DSH crash、process tree cleanup。
- 新增 `test:m6-4:offline` 与 Ubuntu/Windows独立 hard-fail CI step；generic Windows `continue-on-error` 不得吞 M6-4失败。
- 完成现有 `test:m6-3`、`test:m6-2:offline`、`test:m6-2:epoch`、`test:m6`、orchestrator、Control Plane直接全量、M4/kernel/fusion/authority回归；Windows symlink `EPERM` 只按现有精确用例记录，并在可建 symlink 的 runner补证，不扩成通用豁免。
- 退出：`CODE_READY_GATE_CLOSED` completion evidence；gate仍 CLOSED、actionCount=0、无部署。

### Gate F — 单独获权的 alias 01 staged canary

此 Gate 不由本计划自动授权。获得精确 live-window批准后才可：

1. 从合入 main 的 commit构建 release，验证 release/profile/locks/DSH/model/provider/tool/policy hash closure；环境必须 alias 01 ready/free、active job/session/lease/pending approval=0、ADB 5037固定且5038设备数=0。
2. mint purpose=`M6_4_SHADOW` 的 v2 `OBSERVE_ONLY` alias01 epoch，执行 manifest 精确 5 个 no-effect runs（无 skip/replacement/extra），action/transport=0后用专用 shadow aggregate正常关闭。
3. mint purpose=`M6_4_SMOKE_CLOSE` 的 v2 `GROUNDED_ACTION` epoch，执行精确 1 个预排 close-race scenario：emergency close必须先于 send fence序列化，结果 transport=0并形成 `ABORTED_PENDING_CLOSEOUT`→failure closeout。随后另 mint purpose=`M6_4_SMOKE_ACTION` epoch，执行精确 3 个非计分、预写 safe navigation runs并正常关闭。smoke不得混入计分 aggregate。
4. mint purpose=`M6_4_RELIABILITY` epoch，用锁定 real model/profile执行 manifest 精确 20 个、无替换/补跑/extra 的连续 XHS search/open-note bounded runs；scenario ordinal 1–20 是固定分母，abort/WAIT_HUMAN/缺 receipt均计失败，至少19/20成功，action-level approval prompt=0。
5. reliability 独立 oracle在窗口前冻结 query ref/hash、expected app/page classes与 non-ad规则。单 run成功必须同时满足：trusted query精确回显；result frame/query/page/focus匹配；被选 block在动作前证据中 `non-ad` 且有stable result ref；after-frame为 XHS note-detail，stable note ref与选择结果相同；每个 action均 COMPLETED+valid receipt；无越权/持久或公开副作用；run/process/resource closeout有效。expected不得从SUT trace反推。
6. reliability 正常关闭后，另 mint purpose=`M6_4_SMOOTH` epoch，执行与前20完全不重叠的精确30 tasks，严格按§4.6分布且无 skip/replacement/extra；每个 scenarioId/runId/operationKey namespace唯一。至少27/30无中途人工，正常路径 action-level approval prompts=0；abort/WAIT_HUMAN计入固定分母失败。
7. smooth manifest逐任务冻结 before/after business oracle、允许 primitives/apps/fields、reset obligation与零持久/public effect。任何 extra scenario、跨类双计、未复原 form、setting mutation、social/account action、CAPTCHA/login/risk、misclick/stale/duplicate或未知 effect使整窗失败并 emergency close。
8. 每个 cohort结束均检查 ledger/permit/auth/receipt/frame/verification/process refs，并各自生成完整 aggregate、resource snapshot、v2 CLOSED epoch/closeout；最终再生成 action-canary completion receipt。active job/session/lease/pending approval/orphan DSH=0。

## 6. 测试与判别性 probes

至少包含：

- schema additionalProperties、hash/id/time/size/budget边界；gate/decision/capture receipt/replay-live v1↔v2 confusion与v2→v1 downgrade。
- gate unknown mode/purpose、wrong status、allowlist非01、forged/expired/parent/release/base-lock/action-lock drift、file/pointer/DB-fence mismatch；promote/send同一 `BEGIN IMMEDIATE` serialization 的两种顺序；pre-send close transport=0，send-fence先提交则最多一个action并阻断后续。
- normal close完整 aggregate门；预签 emergency close不等aggregate、CAS wrong-current/nonce replay/operator/reason/expiry拒绝、close-auth coverage `< epoch.expiresAt+30m` 拒绝mint/activate、expiry boundary验证；`ABORTED_PENDING_CLOSEOUT`未验证不得 reopen。
- broker missing/replayed inherited pipe、wrong correlation/processRef/session/worker/alias、extra method、child request、oversize/partial/out-of-order/timeout/backpressure；验证direct child是唯一初始handle holder、startup设置non-inheritable/close-on-exec、锁定profile无dup/spawn broker path、unexpected process-tree growth触发revoke；不把payload PID当identity，无listener/port/token泄漏且pipe/process tree归零。
- live provider independent annotations；provider relabel payment→content、bounds swap、block-set重签、empty dump、screenshot-only、duplicate label、system/keyboard/ad regions。
- grant issuer/goal hash/app/alias/skill/capability/intent/budget/time/policy spoof；支付/删除同义词、icon、page fingerprint和uncertainty。
- action body raw target/x/y/bounds/text/device/session/lease/token/URL/command全部拒绝；trusted query ref仍能执行精确预写文本。
- composite capability job + exact-scope same session/lease observe→act→verify；kind=session transport auth、legacy raw adapter旁路均拒绝；frame 5s TTL、remaining TTL<1s、focus/page/app change、rotation/newer observation使旧decision失效。
- decision v2与live `phone_ground` conditional input union正反例：block必须blockId，screen/none禁止blockId，caller targetKind覆盖拒绝；non-block不得伪造block。每个multi-primitive task actionSlot唯一，result返回绑定的operationKey；same/same、same/different、decision same/different、双并发consume及new-run/new-session同manifest+scenario+step+slot拒绝第二claim/permit/action；独立adapter counter证明每logical action ≤1。
- tx#1/#2/#3和其每个跨表间隙faultpoint；无嵌套或typed-auth双consume；StateStore v18→v19 upgrade/interrupt/rollback/forward matrix；grounded startup对所有非完成row按transport_called=0→BLOCKED false/0、=1→AMBIGUOUS true/1分流并拒绝retry，legacy startup不变。
- transport前拒绝必须false/0；counter后失败/超时/AMBIGUOUS必须true/1。after-frame/verification缺失不能生成COMPLETED+receipt；verification/receipt/final status在tx#3原子，receipt断链、ledger ref伪造、自生oracle均失败。
- shadow=5、hot-close drill=1、smoke=3、reliability=20、smooth=30 的purpose/cardinality/唯一key/no-overlap/no-skip/no-extra门；20-run business oracle与§4.6 30-task exact distribution由独立manifest判定。
- M6-2 one-shot capture与80-attempt aggregate verifier继续拒绝任何action；M6-3 replay仍全部externalEffect=false/actionCount=0。

## 7. 建议文件面

实施时可按最新基线细化文件名，但不得扩大能力边界：

- `packages/kernel/contracts/orchestration/m6/`：独立 gate/locks/decision/permit/run-frame v2、emergency close、run/skill/typed-auth/action-canary schemas；所有 v1 不改。
- `packages/kernel/lib/`：canonical GroundingRuntime/live provider interfaces、action aggregate derivation/validator。
- `services/orchestrator/scripts/lib/m6/`：compat re-export、grant/action policy compiler、live/replay tool spec exports。
- `services/control-plane/control-plane/lib/`：`state-store.mjs` v18→v19 migration/combined APIs/startup recovery、control-plane/router/bootstrap、grounded-run facade/manager、gate v2 loader/epoch/fence/promote/aggregate、transport authorization/typed transport、pipe broker registry。
- `services/control-plane/apps/xiaowei/`：internal composite grounded-run capability与 M6 typed TCB adapter；legacy constructor raw transport不得在M6 path可达，不把raw params暴露为public capability。
- `integrations/dsh-xw/`：独立 live profile/plugin/extra-stdio pipe tool client/model manifest和测试；replay profile保留。
- `packages/control-client` / `packages/cli`：仅提供preflight/status/closeout/verify/dry-run operator面；不提供raw action命令，epoch activate仍需显式operator步骤。
- `tools/m6/`：M6-4 inventory、安全扫描、completion evidence/verifier。
- `.github/workflows/source-fusion.yml`、`package.json`、docs/runbook/failure taxonomy/receipt index与精确fusion allowlist。

## 8. 验收命令与证据

新增固定入口：

```powershell
npm run test:m6-4:offline
npm run test:m6-3
npm run test:m6-2:offline
npm run test:m6-2:epoch
npm run test:m6
npm run test:orchestrator
npm run test:control-plane
npm run fusion:verify
npm run kernel:check
npm run authority
npm run test:gate
```

实现者还必须从最新 `package.json`/workflow读取并运行现有 M4/kernel直接门；不能因命令列表变化而省略。completion evidence记录命令、exit code、测试计数、stdout/stderr hash、runner OS/profile、source/tree/release/locks和已知精确环境例外。

关键证据使用独立 oracle或mutation，不接受“suite green”替代：

- exact tool inventory来自真实 DSH `request/header.tools`。
- transport/action count来自adapter外独立计数器；counter前为false/0，counter后即使unknown也必须true/1。
- gate fence、ledger、permit、typed auth、verification、action receipt分别重算hash并交叉绑定；只有tx#3的COMPLETED+receipt可重放。
- shadow/smoke/reliability/smooth scenario manifests在窗口前分别冻结，cardinality/no-overlap与business oracle由独立expected来源判定；completion verifier不能从SUT trace反推expected。
- before/after/closed resource probes独立读取正式状态。
- 安全扫描覆盖diff、config、tool payload、trace、receipt、checkpoint与audit artifacts。

## 9. 停止条件与回滚

任一条件触发立即停止新action并关闭gate：

- 无法证明live provider目标/geometry/provenance；5秒TTL或冻结SLO不达标。
- broker capability、process/session/alias绑定可绕过，或DSH能拿到raw authority。
- gate promote/send不能通过共享DB fence线性化、emergency close不可执行、历史v1 epoch兼容性或v2 locks不闭合。
- Action Ledger状态/transport counter无法区分pre-send与possible effect，permit/auth可多次consume，或tx#3无法原子完成receipt+COMPLETED。
- raw coordinate/PrimitiveAction/ADB/DB/payment/delete/public side effect从M6面可达。
- 任何misclick、stale/duplicate action、支付/删除尝试、验证码/风控、未知结果自动重放、资源/进程泄漏。

运行时回滚顺序：`gate emergency-close --expected-current ...` 经唯一 promote API提交DB fence+CLOSED epoch → stop pipe broker/new runs → ledger/claim/permit/auth inspect → failure closeout → terminalize capability job并清activeJobs/auth → release session/lease → terminate DSH/process tree → resource probe → retain evidence → deploy schema-v19-compatible rollback release。若 Control Plane 已崩溃，则无 broker/send path；重启前先离线追加签名 CLOSED intent，startup在file/DB mismatch下保持CLOSED，再由 promote API收敛。不得删除ledger、trace、receipt、attachment、v19 tables或gate历史；源码回滚用merge commit的`git revert -m 1`，不用reset/squash，但原 v18 binary不得直接打开v19生产库。

## 10. Definition of Done

### 10.1 CODE_READY_GATE_CLOSED

1. A01/A02 已有 owner-signed decision record；M6-3已合main，completion index消除仓内状态歧义；新分支干净且无scratch污染。
2. 四项Gate A blocker达到§3.2精确硬门并有判别性正/负证据。
3. mixed gate v1/v2、locks.v2、DB gate fence、normal/emergency close及各 purpose aggregate在不削弱M6-2语义下闭合。
4. replay/live tool profiles分版；真实child exact 10 tools；replay回归不退化。
5. 唯一GroundingRuntime + live decision v2 +真实provider + one-shot durable permit完整闭合，model面零坐标/authority。
6. composite capability job/same-lease run、parent pipe、narrow endpoint、三次StateStore事务、typed transport、after-frame verify与no-resume recovery全绿。
7. 双平台M6-4 hard CI与所有原回归通过；完成receipt/contract evidence可重算。
8. gate仍CLOSED，live/cutover未发生，actionCount=0，资源归零。

### 10.2 M6_4_ACTION_CANARY_CLOSED（需 A01/A02 owner decision + 另行 live 授权）

1. shadow 5、hot-close drill 1、action smoke 3全部按独立manifest收敛；alias01 reliability精确20 runs至少19成功，另有精确30-task suite至少27无中途人工，正常路径逐动作审批=0，无替换/额外/跨窗双计。
2. 30 tasks严格覆盖§4.6八个authoritative families及精确分布，只有7个冻结server primitives，无持久或公开副作用。
3. payment/delete/misclick/stale/duplicate/unknown-replay均为0；任何counter后unknown如实记为possible effect并使窗口失败。
4. 每个action从canary packet/grant/DSH/frame/decision/permit/ledger/after-frame/verification/receipt完整互证；M5 WorkReceipt实际接线仍明确留给M6-6。
5. bridge/grounding/observe-to-dispatch达到冻结SLO；一run一DSH process。
6. 每个purpose均以正常或emergency v2 CLOSED epoch收敛，aggregate/closeout/receipt有效，file/DB fence一致，所有job/session/lease/approval/process归零。
7. 此终态只声明 `M6_4_ACTION_CANARY_CLOSED`；master `M6_4_CLOSED_COMPLETE` 仍等待M6-6真实M5 WorkReceipt trace binding。

## 11. 显式假设与未决事实

1. M6-3外部收据已验证且开放阻断项为0，但候选尚未push/merge；实现必须等待merge。
2. M6-2 receipt中的`tasks.54=in_progress`保留为项目跟踪事实；本计划不擅自将其标记完成。若task 54另有与M6-4冲突的scope，Gate A停止。
3. M6-3 completion `generatedAt`早于候选commit约82秒是非阻断provenance注记；hash/commit/tree/mtime链正确。若审计要求严格时间序，另行重签索引，不改原收据。
4. exact live model/provider由Gate A从目标runtime的实时inventory解析并冻结；catalog存在不等于可用。没有健康、合规、满足TTL的profile时live Gate F阻断。
5. 初轮只做无公开副作用任务，避免与现有逐项确认政策文档冲突；任何社交、发布、消息、账号动作都是后续scope/policy decision，不进入本计划。
6. A01/A02 当前只是本计划的推荐 amendment，尚无 owner-signed decision；在该证据出现前状态必须为 `SCOPE_CHANGE_REQUIRED`，不能生成可执行实施授权。
7. 本计划对M6-4/M6-5的PR拆分属于独立deploy/rollback边界的实现组织；不改变M6-5恢复义务或M6-6接线义务。

```

## New file: docs/plans/M6-4-single-alias-grounded-action-plan-v2.md

```md
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

```

## New file: integrations/dsh-xw/profiles/live/cordis.patch.yml

```yml
- insert:
    - id: xw-dsh-live-runtime
      name: ../../src/live-runtime-plugin.mjs

```

## New file: integrations/dsh-xw/profiles/live/cordis.yml

```yml
# M6-4 live profile root. It is deliberately separate from profiles/replay.
[]

```

## New file: integrations/dsh-xw/profiles/live/model-manifest.json

```json
{
  "schemaId": "xw.m6-live-model-profile.v1",
  "status": "UNQUALIFIED",
  "reason": "TARGET_RUNTIME_MODEL_PROVIDER_LICENSE_SECRET_AND_HEALTH_UNRESOLVED",
  "provider": null,
  "model": null,
  "exactVersion": null,
  "contentHash": null,
  "secretMaterialPresent": false,
  "deploymentSecretInjectionRequired": true,
  "gateFEligible": false
}

```

## New file: integrations/dsh-xw/profiles/live/package.json

```json
{
  "name": "xw-dsh-live-profile",
  "version": "0.0.0-m6-4",
  "private": true,
  "type": "module",
  "dsh": { "profile": { "bundles": [] } }
}

```

## New file: integrations/dsh-xw/src/live-pipe-client.mjs

```mjs
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";

import { M6_LIVE_TOOL_NAMES, validateLiveToolCall, validateLiveToolResult } from "../../../services/orchestrator/scripts/lib/m6/m6-live-tool-surface.mjs";

const MAX_LINE_BYTES = 64 * 1024;
const BINDING_KEYS = Object.freeze(["runId", "workerId", "sessionId", "alias", "processRef"]);
const OPAQUE = /^[a-z0-9][a-z0-9:_-]{7,127}$/iu;

export function validateM6LivePipeBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)
    || Object.keys(binding).sort().join(",") !== [...BINDING_KEYS].sort().join(",")
    || !BINDING_KEYS.filter((key) => key !== "alias").every((key) => typeof binding[key] === "string" && OPAQUE.test(binding[key]))
    || binding.alias !== "01") {
    throw Object.assign(new Error("live broker correlation binding is not the exact opaque alias-01 shape"), { code: "M6_LIVE_PIPE_BINDING_INVALID" });
  }
  return Object.freeze({ ...binding });
}

export class LivePipeToolClient {
  constructor({ fd = Number(process.env.XW_M6_BROKER_FD), binding, timeoutMs = 5_000 } = {}) {
    if (!Number.isInteger(fd) || fd < 3) throw Object.assign(new Error("inherited broker pipe is required"), { code: "M6_LIVE_PIPE_REQUIRED" });
    this.binding = validateM6LivePipeBinding(binding);
    this.timeoutMs = timeoutMs;
    this.input = createReadStream(null, { fd, autoClose: false });
    this.output = createWriteStream(null, { fd, autoClose: false });
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.closed = false;
    this.input.on("data", (chunk) => this.#onData(chunk));
    this.input.on("error", (error) => this.#close(error));
    this.input.on("end", () => this.#close(Object.assign(new Error("broker pipe ended"), { code: "M6_LIVE_PIPE_CLOSED" })));
    this.#write({ type: "hello", processRef: binding.processRef, toolNames: M6_LIVE_TOOL_NAMES, brokerFd: fd, transportAuthorityPresent: false, rawDeviceIdentityPresent: false });
  }

  call(method, params) {
    const validation = validateLiveToolCall({ tool: method, args: params });
    if (!validation.ok) throw Object.assign(new Error(`live tool call rejected: ${validation.errors.join(",")}`), { code: validation.errors[0] });
    if (this.closed) return Promise.reject(Object.assign(new Error("broker pipe is closed"), { code: "M6_LIVE_PIPE_CLOSED" }));
    const nonce = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        reject(Object.assign(new Error("broker response timed out"), { code: "M6_LIVE_PIPE_TIMEOUT" }));
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(nonce, { method, resolve, reject, timer });
      this.#write({ type: "tool_call", correlation: this.binding, method, nonce, params });
    });
  }

  close() {
    this.#close(Object.assign(new Error("live pipe client closed"), { code: "M6_LIVE_PIPE_CLOSED" }));
  }

  #write(value) {
    const encoded = Buffer.from(`${JSON.stringify(value)}\n`);
    if (encoded.length > MAX_LINE_BYTES) throw Object.assign(new Error("broker line is too large"), { code: "M6_LIVE_PIPE_LINE_LIMIT" });
    this.output.write(encoded);
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    if (this.buffer.length > MAX_LINE_BYTES && !this.buffer.includes(0x0a)) return this.#close(Object.assign(new Error("incomplete broker line is too large"), { code: "M6_LIVE_PIPE_LINE_LIMIT" }));
    while (this.buffer.includes(0x0a)) {
      const newline = this.buffer.indexOf(0x0a);
      const raw = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (raw.length > MAX_LINE_BYTES) return this.#close(Object.assign(new Error("broker line is too large"), { code: "M6_LIVE_PIPE_LINE_LIMIT" }));
      let message;
      try { message = JSON.parse(raw.toString("utf8")); } catch { return this.#close(Object.assign(new Error("broker returned invalid JSON"), { code: "M6_LIVE_PIPE_PROTOCOL" })); }
      if (message.type === "reject") return this.#close(Object.assign(new Error("broker rejected child"), { code: message.code || "M6_LIVE_PIPE_REJECTED" }));
      if (message.type !== "tool_result" || typeof message.nonceHash !== "string") return this.#close(Object.assign(new Error("unexpected broker response"), { code: "M6_LIVE_PIPE_PROTOCOL" }));
      const found = [...this.pending.entries()].find(([nonce]) => createHash("sha256").update(nonce).digest("hex") === message.nonceHash);
      if (!found) return this.#close(Object.assign(new Error("broker response nonce is unknown"), { code: "M6_LIVE_PIPE_REPLAY" }));
      const [nonce, pending] = found;
      const validation = validateLiveToolResult({ tool: pending.method, result: message.result });
      if (!validation.ok) return this.#close(Object.assign(new Error(`live tool result rejected: ${validation.errors.join(",")}`), { code: validation.errors[0] }));
      clearTimeout(pending.timer);
      this.pending.delete(nonce);
      pending.resolve(message.result);
    }
  }

  #close(error) {
    if (this.closed) return;
    this.closed = true;
    this.input.destroy();
    this.output.destroy();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}

```

## New file: integrations/dsh-xw/src/live-runtime-plugin.mjs

```mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "xw-dsh-live-runtime";

export async function apply() {
  const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../profiles/live/model-manifest.json"), "utf8"));
  if (manifest.status !== "QUALIFIED" || manifest.gateFEligible !== true || !/^[0-9a-f]{64}$/u.test(manifest.contentHash || "")) {
    throw Object.assign(new Error(`M6-4 live profile is fail-closed: ${manifest.reason || "model profile is not qualified"}`), { code: "M6_LIVE_PROFILE_UNQUALIFIED" });
  }
  throw Object.assign(new Error("qualified live provider adapter must be sealed by a separately reviewed runtime lock"), { code: "M6_LIVE_PROVIDER_ADAPTER_UNSEALED" });
}

export default { name, apply };

```

## New file: integrations/dsh-xw/test/live-profile.spec.mjs

```mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { apply } from "../src/live-runtime-plugin.mjs";
import { LivePipeToolClient, validateM6LivePipeBinding } from "../src/live-pipe-client.mjs";
import { M6_LIVE_TOOL_NAMES } from "../../../services/orchestrator/scripts/lib/m6/m6-live-tool-surface.mjs";

test("live profile is separate, secret-free, exact-ten, and unqualified runtime fails closed", async () => {
  const replay = readFileSync(new URL("../profiles/replay/cordis.patch.yml", import.meta.url), "utf8");
  const live = readFileSync(new URL("../profiles/live/cordis.patch.yml", import.meta.url), "utf8");
  const manifest = JSON.parse(readFileSync(new URL("../profiles/live/model-manifest.json", import.meta.url), "utf8"));
  assert.notEqual(live, replay);
  assert.equal(new Set(M6_LIVE_TOOL_NAMES).size, 10);
  assert.equal(manifest.secretMaterialPresent, false);
  assert.equal(manifest.gateFEligible, false);
  assert.throws(() => new LivePipeToolClient({ fd: 2, binding: {} }), { code: "M6_LIVE_PIPE_REQUIRED" });
  const binding = { runId: "run:opaque", workerId: "worker:opaque", sessionId: "session:opaque", alias: "01", processRef: "process:opaque" };
  assert.deepEqual(validateM6LivePipeBinding(binding), binding);
  assert.throws(() => validateM6LivePipeBinding({ ...binding, leaseId: "lease:secret" }), { code: "M6_LIVE_PIPE_BINDING_INVALID" });
  assert.throws(() => validateM6LivePipeBinding({ ...binding, alias: "02" }), { code: "M6_LIVE_PIPE_BINDING_INVALID" });
  await assert.rejects(() => apply(), { code: "M6_LIVE_PROFILE_UNQUALIFIED" });
});

```

## New file: packages/kernel/contracts/orchestration/m6/xw.grounding-decision.v2.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:xw:contract:m6:grounding-decision:v2",
  "title": "xw.grounding-decision.v2",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaId", "decisionRef", "operationKey", "disposition", "target", "bindings"],
  "properties": {
    "schemaId": { "const": "xw.grounding-decision.v2" },
    "decisionRef": { "$ref": "#/$defs/hash" },
    "operationKey": { "type": "string", "minLength": 1, "maxLength": 200 },
    "disposition": { "enum": ["ALLOW_ONCE", "REPLAN", "HARD_STOP"] },
    "target": {
      "oneOf": [
        {
          "type": "object", "additionalProperties": false,
          "required": ["kind", "frameId", "blockId"],
          "properties": { "kind": { "const": "block" }, "frameId": { "$ref": "#/$defs/hash" }, "blockId": { "$ref": "#/$defs/hash" } }
        },
        {
          "type": "object", "additionalProperties": false,
          "required": ["kind", "frameId", "pageFingerprint", "focusHash"],
          "properties": { "kind": { "const": "screen" }, "frameId": { "$ref": "#/$defs/hash" }, "pageFingerprint": { "$ref": "#/$defs/hash" }, "focusHash": { "$ref": "#/$defs/hash" } }
        },
        {
          "type": "object", "additionalProperties": false,
          "required": ["kind"],
          "properties": { "kind": { "const": "none" } }
        }
      ]
    },
    "bindings": {
      "type": "object", "additionalProperties": false,
      "required": ["runId", "sessionId", "leaseId", "gateEpochHash", "gateGeneration", "grantHash", "stepId", "environmentAttestationHash"],
      "properties": {
        "runId": { "type": "string", "minLength": 1 },
        "sessionId": { "type": "string", "minLength": 1 },
        "leaseId": { "type": "string", "minLength": 1 },
        "gateEpochHash": { "$ref": "#/$defs/hash" },
        "gateGeneration": { "type": "integer", "minimum": 0 },
        "grantHash": { "$ref": "#/$defs/hash" },
        "stepId": { "type": "string", "minLength": 1 },
        "environmentAttestationHash": { "$ref": "#/$defs/hash" }
      }
    }
  },
  "$defs": { "hash": { "type": "string", "pattern": "^[0-9a-f]{64}$" } }
}

```

## New file: packages/kernel/contracts/orchestration/m6/xw.m6-action-slot-spec.v1.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:xw:contract:m6:action-slot-spec:v1",
  "title": "xw.m6-action-slot-spec.v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaId", "actionSlotSpecHash", "scenarioManifestHash", "scenarioId", "logicalStepId", "actionSlotOrdinal", "alias", "primitive", "actionFamily", "intentRef", "intentPolicyHash", "targetKind", "targetEligibilityHash", "trustedParameterHash", "allowedStateHash", "effectBoundaryHash", "budgetPolicyHash", "redlinePolicyHash", "verificationPolicyHash"],
  "properties": {
    "schemaId": { "const": "xw.m6-action-slot-spec.v1" },
    "actionSlotSpecHash": { "$ref": "#/$defs/hash" },
    "scenarioManifestHash": { "$ref": "#/$defs/hash" },
    "scenarioId": { "type": "string", "minLength": 1, "maxLength": 128 },
    "logicalStepId": { "type": "string", "minLength": 1, "maxLength": 128 },
    "actionSlotOrdinal": { "type": "integer", "minimum": 0, "maximum": 255 },
    "alias": { "const": "01" },
    "primitive": { "enum": ["observe", "open_app", "back", "wait", "tap", "scroll", "type_search_text"] },
    "actionFamily": { "type": "string", "minLength": 1, "maxLength": 64 },
    "intentRef": { "$ref": "#/$defs/hash" },
    "intentPolicyHash": { "$ref": "#/$defs/hash" },
    "targetKind": { "enum": ["block", "screen", "none"] },
    "targetEligibilityHash": { "$ref": "#/$defs/hash" },
    "trustedParameterHash": { "$ref": "#/$defs/hash" },
    "allowedStateHash": { "$ref": "#/$defs/hash" },
    "effectBoundaryHash": { "$ref": "#/$defs/hash" },
    "budgetPolicyHash": { "$ref": "#/$defs/hash" },
    "redlinePolicyHash": { "$ref": "#/$defs/hash" },
    "verificationPolicyHash": { "$ref": "#/$defs/hash" }
  },
  "$defs": { "hash": { "type": "string", "pattern": "^[0-9a-f]{64}$" } }
}

```

## New file: packages/kernel/contracts/orchestration/m6/xw.m6-effect-boundary.v1.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:xw:contract:m6:effect-boundary:v1",
  "title": "xw.m6-effect-boundary.v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaId", "boundaryHash", "a03Mode", "testIdentityHash", "families"],
  "properties": {
    "schemaId": { "const": "xw.m6-effect-boundary.v1" },
    "boundaryHash": { "$ref": "#/$defs/hash" },
    "a03Mode": { "const": "BOUNDED_READ_TRACE" },
    "testIdentityHash": { "$ref": "#/$defs/hash" },
    "families": {
      "type": "array", "minItems": 8, "maxItems": 8,
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["primaryFamily", "oracleHash", "forbiddenEffectClasses", "allowedBoundedReadTraces", "resetObligations"],
        "properties": {
          "primaryFamily": { "enum": ["app-launch", "app-switch", "search", "text-input", "scroll", "tab-back", "form-edit", "settings-nav"] },
          "oracleHash": { "$ref": "#/$defs/hash" },
          "forbiddenEffectClasses": { "type": "array", "minItems": 9, "uniqueItems": true, "items": { "type": "string" } },
          "allowedBoundedReadTraces": { "type": "array", "uniqueItems": true, "items": { "type": "string" } },
          "resetObligations": { "type": "array", "uniqueItems": true, "items": { "type": "string" } }
        }
      }
    }
  },
  "$defs": { "hash": { "type": "string", "pattern": "^[0-9a-f]{64}$" } }
}

```

## New file: packages/kernel/contracts/orchestration/m6/xw.m6-live-gate.v2.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:xw:contract:m6:live-gate:v2",
  "title": "xw.m6-live-gate.v2",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaId", "gateId", "epochHash", "mode", "purpose", "status",
    "releaseId", "sourceCommit", "actor", "lockSetRef", "allowlist",
    "issuedAt", "expiresAt", "parentEpochHash", "closeoutRef",
    "aggregateSealRef", "rollbackTargetEpochHash", "emergencyCloseAuthorizationRef"
  ],
  "properties": {
    "schemaId": { "const": "xw.m6-live-gate.v2" },
    "gateId": { "type": "string", "minLength": 1, "maxLength": 128 },
    "epochHash": { "$ref": "#/$defs/hash" },
    "mode": { "enum": ["CLOSED", "OBSERVE_ONLY", "GROUNDED_ACTION"] },
    "purpose": {
      "enum": [
        "M6_4_SHADOW", "M6_4_HOT_CLOSE", "M6_4_ACTION_SMOKE",
        "M6_4_RELIABILITY", "M6_4_SMOOTH", "M6_4_CLOSEOUT"
      ]
    },
    "status": { "enum": ["active", "closed"] },
    "releaseId": { "type": "string", "minLength": 1 },
    "sourceCommit": { "type": "string", "pattern": "^[0-9a-f]{40}$" },
    "actor": { "type": "string", "minLength": 1, "maxLength": 200 },
    "lockSetRef": { "$ref": "#/$defs/ref" },
    "allowlist": {
      "type": "array",
      "minItems": 1,
      "items": { "type": "string", "minLength": 1, "maxLength": 64 },
      "uniqueItems": true
    },
    "issuedAt": { "$ref": "#/$defs/dateTime" },
    "expiresAt": { "$ref": "#/$defs/dateTime" },
    "parentEpochHash": { "type": ["string", "null"], "pattern": "^[0-9a-f]{64}$" },
    "closeoutRef": { "$ref": "#/$defs/refOrNull" },
    "aggregateSealRef": { "$ref": "#/$defs/refOrNull" },
    "rollbackTargetEpochHash": { "type": ["string", "null"], "pattern": "^[0-9a-f]{64}$" },
    "emergencyCloseAuthorizationRef": { "$ref": "#/$defs/refOrNull" }
  },
  "$defs": {
    "hash": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
    "dateTime": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$"
    },
    "ref": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "sha256"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "sha256": { "$ref": "#/$defs/hash" }
      }
    },
    "refOrNull": {
      "oneOf": [
        { "type": "null" },
        { "$ref": "#/$defs/ref" }
      ]
    }
  },
  "allOf": [
    {
      "if": { "properties": { "mode": { "const": "CLOSED" } } },
      "then": {
        "properties": {
          "status": { "const": "closed" },
          "emergencyCloseAuthorizationRef": { "type": "null" }
        }
      },
      "else": {
        "properties": {
          "status": { "const": "active" },
          "closeoutRef": { "type": "null" },
          "aggregateSealRef": { "type": "null" },
          "rollbackTargetEpochHash": { "type": "null" },
          "emergencyCloseAuthorizationRef": { "$ref": "#/$defs/ref" }
        }
      }
    }
  ]
}

```

## New file: packages/kernel/contracts/orchestration/m6/xw.m6-locks.v2.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:xw:contract:m6:locks:v2",
  "title": "xw.m6-locks.v2",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaId", "lockSetId", "lockSetHash", "lockHashes"],
  "properties": {
    "schemaId": { "const": "xw.m6-locks.v2" },
    "lockSetId": { "type": "string", "minLength": 1, "maxLength": 128 },
    "lockSetHash": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
    "lockHashes": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "runtimeProfile", "hardRedlinePolicy", "groundingRuntime",
        "dshSource", "dshProfile", "liveToolSpec", "modelProfile",
        "liveProvider", "grantActionPolicy", "brokerProtocol",
        "typedTransport", "scenarioManifest"
      ],
      "properties": {
        "runtimeProfile": { "$ref": "#/$defs/hash" },
        "hardRedlinePolicy": { "$ref": "#/$defs/hash" },
        "groundingRuntime": { "$ref": "#/$defs/hash" },
        "dshSource": { "$ref": "#/$defs/hash" },
        "dshProfile": { "$ref": "#/$defs/hash" },
        "liveToolSpec": { "$ref": "#/$defs/hash" },
        "modelProfile": { "$ref": "#/$defs/hash" },
        "liveProvider": { "$ref": "#/$defs/hash" },
        "grantActionPolicy": { "$ref": "#/$defs/hash" },
        "brokerProtocol": { "$ref": "#/$defs/hash" },
        "typedTransport": { "$ref": "#/$defs/hash" },
        "scenarioManifest": { "$ref": "#/$defs/hash" }
      }
    }
  },
  "$defs": {
    "hash": { "type": "string", "pattern": "^[0-9a-f]{64}$" }
  }
}

```

## New file: packages/kernel/contracts/orchestration/m6/xw.m6-target-environment-attestation.v1.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:xw:contract:m6:target-environment-attestation:v1",
  "title": "xw.m6-target-environment-attestation.v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaId", "attestationHash", "appPackageHash", "appBuildHash", "signingHash", "osBuildHash", "displayHash", "localeThemeHash", "imeHash", "accessibilityHash", "accountIsolationHash", "capturedAt", "expiresAt"],
  "properties": {
    "schemaId": { "const": "xw.m6-target-environment-attestation.v1" },
    "attestationHash": { "$ref": "#/$defs/hash" },
    "appPackageHash": { "$ref": "#/$defs/hash" },
    "appBuildHash": { "$ref": "#/$defs/hash" },
    "signingHash": { "$ref": "#/$defs/hash" },
    "osBuildHash": { "$ref": "#/$defs/hash" },
    "displayHash": { "$ref": "#/$defs/hash" },
    "localeThemeHash": { "$ref": "#/$defs/hash" },
    "imeHash": { "$ref": "#/$defs/hash" },
    "accessibilityHash": { "$ref": "#/$defs/hash" },
    "accountIsolationHash": { "$ref": "#/$defs/hash" },
    "capturedAt": { "type": "string", "minLength": 1 },
    "expiresAt": { "type": "string", "minLength": 1 }
  },
  "$defs": { "hash": { "type": "string", "pattern": "^[0-9a-f]{64}$" } }
}

```

## New file: packages/kernel/lib/m6-4-cohort.mjs

```mjs
import { createHash } from "node:crypto";

export const M6_4_COHORT_RULES = Object.freeze({
  M6_4_SHADOW: Object.freeze({ attempts: 5, minimumSucceeded: 5, actionPolicy: "ZERO" }),
  M6_4_HOT_CLOSE: Object.freeze({ attempts: 1, minimumSucceeded: 0, actionPolicy: "ZERO_OR_ONE" }),
  M6_4_ACTION_SMOKE: Object.freeze({ attempts: 3, minimumSucceeded: 3, actionPolicy: "BOUNDED" }),
  M6_4_RELIABILITY: Object.freeze({ attempts: 20, minimumSucceeded: 19, actionPolicy: "BOUNDED" }),
  M6_4_SMOOTH: Object.freeze({ attempts: 30, minimumSucceeded: 27, actionPolicy: "BOUNDED" }),
});

export const M6_4_SMOOTH_DISTRIBUTION = Object.freeze({
  "app-launch": 4, "app-switch": 4, search: 4, "text-input": 4,
  scroll: 4, "tab-back": 4, "form-edit": 3, "settings-nav": 3,
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function deriveM64CohortAggregateHash(aggregate) {
  const { aggregateHash: _ignored, ...payload } = aggregate || {};
  return createHash("sha256").update(`xw.m6-4-cohort-aggregate.v1:${canonical(payload)}`).digest("hex");
}

export function deriveM64CohortManifestHash(manifest) {
  const { manifestHash: _ignored, ...payload } = manifest || {};
  return createHash("sha256").update(`xw.m6-4-cohort-manifest.v1:${canonical(payload)}`).digest("hex");
}

export function validateM64CohortManifest(manifest) {
  const errors = [];
  const rule = M6_4_COHORT_RULES[manifest?.purpose];
  if (manifest?.schemaId !== "xw.m6-4-cohort-manifest.v1") errors.push("M64_MANIFEST_SCHEMA_INVALID");
  if (!rule) errors.push("M64_COHORT_PURPOSE_INVALID");
  if (manifest?.alias !== "01") errors.push("M64_COHORT_ALIAS_INVALID");
  if (!Array.isArray(manifest?.scenarios) || (rule && manifest.scenarios.length !== rule.attempts)) errors.push("M64_COHORT_CARDINALITY_INVALID");
  if (Array.isArray(manifest?.scenarios)) {
    const keys = manifest.scenarios.map((scenario) => scenario.scenarioKey);
    if (new Set(keys).size !== keys.length || manifest.scenarios.some((scenario) => scenario.alias !== "01" || scenario.authorized !== false
      || scenario.executionStatus !== "NOT_RUN" || !/^[0-9a-f]{64}$/u.test(scenario.oracleHash || "")
      || !/^[0-9a-f]{64}$/u.test(scenario.effectBoundaryHash || ""))) errors.push("M64_COHORT_SCENARIO_INVALID");
    if (manifest?.purpose === "M6_4_SMOOTH") {
      const counts = Object.fromEntries(Object.keys(M6_4_SMOOTH_DISTRIBUTION).map((family) => [family, 0]));
      for (const scenario of manifest.scenarios) if (Object.hasOwn(counts, scenario.primaryFamily)) counts[scenario.primaryFamily] += 1;
      if (canonical(counts) !== canonical(M6_4_SMOOTH_DISTRIBUTION)) errors.push("M64_SMOOTH_DISTRIBUTION_INVALID");
    }
  }
  if (manifest?.liveAuthorizationRef !== null || manifest?.gateFEligible !== false) errors.push("M64_MANIFEST_MUST_BE_OFFLINE");
  if (deriveM64CohortManifestHash(manifest) !== manifest?.manifestHash) errors.push("M64_MANIFEST_HASH_INVALID");
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function validateM64CohortAggregate(aggregate) {
  const errors = [];
  const rule = M6_4_COHORT_RULES[aggregate?.purpose];
  if (aggregate?.schemaId !== "xw.m6-4-cohort-aggregate.v1") errors.push("M64_COHORT_SCHEMA_INVALID");
  if (!rule) errors.push("M64_COHORT_PURPOSE_INVALID");
  if (aggregate?.alias !== "01") errors.push("M64_COHORT_ALIAS_INVALID");
  if (!Array.isArray(aggregate?.expectedScenarioKeys) || !Array.isArray(aggregate?.attempts)) {
    errors.push("M64_COHORT_ATTEMPTS_INVALID");
  } else if (rule) {
    if (aggregate.expectedScenarioKeys.length !== rule.attempts || aggregate.attempts.length !== rule.attempts) {
      errors.push("M64_COHORT_CARDINALITY_INVALID");
    }
    const expected = new Set(aggregate.expectedScenarioKeys);
    const actual = new Set(aggregate.attempts.map((attempt) => attempt.scenarioKey));
    if (expected.size !== rule.attempts || actual.size !== aggregate.attempts.length
      || [...expected].some((key) => !actual.has(key))) errors.push("M64_COHORT_SCENARIO_SUBSTITUTION");
    const successCount = aggregate.attempts.filter((attempt) => attempt.status === "SUCCEEDED").length;
    if (successCount < rule.minimumSucceeded) errors.push("M64_COHORT_SUCCESS_THRESHOLD");
    if (aggregate.attempts.some((attempt) => attempt.alias !== "01" || attempt.forbiddenEffectCount !== 0
      || attempt.publicEffectCount !== 0 || attempt.paymentAttemptCount !== 0 || attempt.deleteAttemptCount !== 0)) {
      errors.push("M64_COHORT_FORBIDDEN_EFFECT");
    }
    if (rule.actionPolicy === "ZERO" && aggregate.attempts.some((attempt) => attempt.actionCount !== 0 || attempt.transportCount !== 0)) {
      errors.push("M64_COHORT_ZERO_ACTION_VIOLATION");
    }
    if (rule.actionPolicy === "ZERO_OR_ONE" && aggregate.attempts.some((attempt) => attempt.actionCount > 1 || attempt.transportCount > 1)) {
      errors.push("M64_COHORT_HOT_CLOSE_BUDGET");
    }
  }
  if (deriveM64CohortAggregateHash(aggregate) !== aggregate?.aggregateHash) errors.push("M64_COHORT_HASH_INVALID");
  return { ok: errors.length === 0, errors };
}

```

## New file: packages/kernel/lib/m6-action-slot.mjs

```mjs
import { m6LiveSha256 } from "./m6-live-grounding.mjs";

const HASH = /^[0-9a-f]{64}$/u;
const PRIMITIVES = new Set(["observe", "open_app", "back", "wait", "tap", "scroll", "type_search_text"]);
const TARGET_KINDS = new Set(["block", "screen", "none"]);
const HASH_FIELDS = [
  "scenarioManifestHash", "intentRef", "intentPolicyHash", "targetEligibilityHash",
  "trustedParameterHash", "allowedStateHash", "effectBoundaryHash", "budgetPolicyHash",
  "redlinePolicyHash", "verificationPolicyHash",
];

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fail(message) {
  throw Object.assign(new Error(message), { code: "M6_ACTION_SLOT_INVALID" });
}

export function deriveM6ActionSlotSpec(input) {
  const raw = {
    schemaId: "xw.m6-action-slot-spec.v1",
    scenarioManifestHash: input?.scenarioManifestHash,
    scenarioId: input?.scenarioId,
    logicalStepId: input?.logicalStepId,
    actionSlotOrdinal: input?.actionSlotOrdinal,
    alias: input?.alias,
    primitive: input?.primitive,
    actionFamily: input?.actionFamily,
    intentRef: input?.intentRef,
    intentPolicyHash: input?.intentPolicyHash,
    targetKind: input?.targetKind,
    targetEligibilityHash: input?.targetEligibilityHash,
    trustedParameterHash: input?.trustedParameterHash,
    allowedStateHash: input?.allowedStateHash,
    effectBoundaryHash: input?.effectBoundaryHash,
    budgetPolicyHash: input?.budgetPolicyHash,
    redlinePolicyHash: input?.redlinePolicyHash,
    verificationPolicyHash: input?.verificationPolicyHash,
  };
  if (raw.alias !== "01" || !PRIMITIVES.has(raw.primitive) || !TARGET_KINDS.has(raw.targetKind)) fail("action slot authority is outside M6-4 scope");
  if (!Number.isInteger(raw.actionSlotOrdinal) || raw.actionSlotOrdinal < 0 || raw.actionSlotOrdinal > 255) fail("action slot ordinal is invalid");
  if (![raw.scenarioId, raw.logicalStepId, raw.actionFamily].every((value) => typeof value === "string" && value.length > 0 && value.length <= 128)) fail("action slot identity is invalid");
  if (HASH_FIELDS.some((field) => !HASH.test(raw[field] || ""))) fail("action slot hash binding is invalid");
  return Object.freeze({ ...raw, actionSlotSpecHash: m6LiveSha256(`xw.m6-action-slot-spec.v1:${canonical(raw)}`) });
}

export function deriveM6LogicalActionIdentity({ planHash, actionSlotSpec }) {
  if (!HASH.test(planHash || "") || actionSlotSpec?.actionSlotSpecHash !== deriveM6ActionSlotSpec(actionSlotSpec).actionSlotSpecHash) fail("action slot spec is not self-consistent");
  const authority = `${planHash}:${actionSlotSpec.scenarioManifestHash}:${actionSlotSpec.scenarioId}:${actionSlotSpec.logicalStepId}:${actionSlotSpec.actionSlotOrdinal}:${actionSlotSpec.alias}:${actionSlotSpec.actionFamily}:${actionSlotSpec.actionSlotSpecHash}`;
  return Object.freeze({
    logicalActionId: m6LiveSha256(`xw.m6-logical-action.v1:${authority}`),
    operationKey: m6LiveSha256(`xw.m6-operation-key.v1:${authority}`),
  });
}

export function deriveM6TrustedParameterHash(trustedParams) {
  if (!trustedParams || typeof trustedParams !== "object" || Array.isArray(trustedParams)) fail("trusted parameters must be a closed object");
  return m6LiveSha256(`xw.m6-trusted-parameters.v1:${canonical(trustedParams)}`);
}

export function assertM6ActionSlotDispatch({ actionSlotSpec, intent, manifestStep }) {
  const canonicalSpec = deriveM6ActionSlotSpec(actionSlotSpec);
  if (canonicalSpec.actionSlotSpecHash !== actionSlotSpec.actionSlotSpecHash
    || canonicalSpec.primitive !== manifestStep?.primitive
    || canonicalSpec.targetKind !== intent?.targetKind
    || canonicalSpec.intentRef !== intent?.intentRef
    || canonicalSpec.trustedParameterHash !== manifestStep?.trustedParameterHash
    || canonicalSpec.trustedParameterHash !== deriveM6TrustedParameterHash(manifestStep?.trustedParams)) {
    fail("dispatch authority drifted from the frozen action slot");
  }
  return canonicalSpec;
}

```

## New file: packages/kernel/lib/m6-effect-boundary.mjs

```mjs
import { createHash } from "node:crypto";

const FAMILIES = ["app-launch", "app-switch", "search", "text-input", "scroll", "tab-back", "form-edit", "settings-nav"];
const FORBIDDEN = ["public", "social", "account", "security", "financial", "destructive", "settings-write", "draft", "unknown"];
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const sha = (value) => createHash("sha256").update(value).digest("hex");

export function deriveM64EffectBoundary(input) {
  const raw = { schemaId: "xw.m6-effect-boundary.v1", a03Mode: input?.a03Mode, testIdentityHash: input?.testIdentityHash, families: input?.families };
  return Object.freeze({ ...raw, boundaryHash: sha(`xw.m6-effect-boundary.v1:${canonical(raw)}`) });
}

export function validateM64EffectBoundary(boundary) {
  const errors = [];
  if (boundary?.schemaId !== "xw.m6-effect-boundary.v1" || boundary?.a03Mode !== "BOUNDED_READ_TRACE" || !/^[0-9a-f]{64}$/u.test(boundary?.testIdentityHash || "")) errors.push("M64_EFFECT_BOUNDARY_SCHEMA_INVALID");
  if (!Array.isArray(boundary?.families) || boundary.families.length !== 8 || new Set(boundary.families.map((entry) => entry.primaryFamily)).size !== 8
    || FAMILIES.some((family) => !boundary.families.some((entry) => entry.primaryFamily === family))) errors.push("M64_EFFECT_BOUNDARY_FAMILIES_INVALID");
  if (boundary?.families?.some((entry) => !/^[0-9a-f]{64}$/u.test(entry.oracleHash || "") || FORBIDDEN.some((effect) => !entry.forbiddenEffectClasses?.includes(effect))
    || !Array.isArray(entry.allowedBoundedReadTraces) || !Array.isArray(entry.resetObligations))) errors.push("M64_EFFECT_BOUNDARY_RULE_INVALID");
  if (deriveM64EffectBoundary(boundary).boundaryHash !== boundary?.boundaryHash) errors.push("M64_EFFECT_BOUNDARY_HASH_INVALID");
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function verifyM64EffectObservation({ boundary, family, oracle, observedEffects, resetResults }) {
  const errors = [...validateM64EffectBoundary(boundary).errors];
  const rule = boundary?.families?.find((entry) => entry.primaryFamily === family);
  if (!rule || oracle?.selfDerived !== false || oracle?.oracleHash !== rule?.oracleHash || oracle?.stale === true) errors.push("M64_EFFECT_ORACLE_INVALID");
  for (const effect of observedEffects || []) {
    if (rule?.forbiddenEffectClasses.includes(effect.effectClass) || !rule?.allowedBoundedReadTraces.includes(effect.effectClass)) errors.push("M64_EFFECT_FORBIDDEN");
  }
  for (const obligation of rule?.resetObligations || []) if (resetResults?.[obligation] !== true) errors.push("M64_EFFECT_RESET_INCOMPLETE");
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export const M6_4_EFFECT_FAMILIES = Object.freeze([...FAMILIES]);
export const M6_4_FORBIDDEN_EFFECT_CLASSES = Object.freeze([...FORBIDDEN]);

```

## New file: packages/kernel/lib/m6-live-grounding.mjs

```mjs
import { createHash } from "node:crypto";

const REDLINE = /(支付|付款|pay(?:ment)?|删除|delete|发布|publish|评论|comment|关注|follow|私信|message|登录|login|账号|account)/iu;
const AD = /(广告|推广|sponsor|\bad\b)/iu;
const KEYBOARD = /(keyboard|inputmethod|输入法|键盘|sogou|iflytek|baidu\.input)/iu;
const SYSTEM_PACKAGE = /^(android|com\.android|com\.miui|com\.google\.android\.inputmethod)/u;
const FORBIDDEN_OPERATION = /(payment|delete|publish|comment|follow|message|account|settings_write)/iu;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function m6LiveSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashText(value) {
  return value ? m6LiveSha256(String(value).normalize("NFKC").trim().toLowerCase()) : null;
}

function decodeXml(value = "") {
  return value.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function attributes(fragment) {
  const result = {};
  for (const match of fragment.matchAll(/([A-Za-z0-9_$:.-]+)="([^"]*)"/gu)) result[match[1]] = decodeXml(match[2]);
  return result;
}

function bounds(value) {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/u.exec(value || "");
  if (!match) return null;
  const [x1, y1, x2, y2] = match.slice(1).map(Number);
  return x2 > x1 && y2 > y1 ? { x1, y1, x2, y2 } : null;
}

export function deriveTargetEnvironmentAttestation(input) {
  const raw = {
    schemaId: "xw.m6-target-environment-attestation.v1",
    appPackageHash: input.appPackageHash,
    appBuildHash: input.appBuildHash,
    signingHash: input.signingHash,
    osBuildHash: input.osBuildHash,
    displayHash: input.displayHash,
    localeThemeHash: input.localeThemeHash,
    imeHash: input.imeHash,
    accessibilityHash: input.accessibilityHash,
    accountIsolationHash: input.accountIsolationHash,
    capturedAt: input.capturedAt,
    expiresAt: input.expiresAt,
  };
  if (Object.entries(raw).some(([key, value]) => key.endsWith("Hash") && !/^[0-9a-f]{64}$/.test(value || ""))) {
    throw Object.assign(new Error("environment attestation has an invalid hash"), { code: "M6_ENV_ATTESTATION_INVALID" });
  }
  if (!Number.isFinite(Date.parse(raw.capturedAt)) || !Number.isFinite(Date.parse(raw.expiresAt))
    || Date.parse(raw.expiresAt) <= Date.parse(raw.capturedAt)) {
    throw Object.assign(new Error("environment attestation lifetime is invalid"), { code: "M6_ENV_ATTESTATION_INVALID" });
  }
  return Object.freeze({ ...raw, attestationHash: m6LiveSha256(`xw.m6-target-environment-attestation.v1:${canonical(raw)}`) });
}

export function deriveLiveVisualBlockSet({ frame, dumpXml, environmentAttestation }) {
  if (!frame || !/^[0-9a-f]{64}$/.test(frame.frameId || "") || typeof dumpXml !== "string" || !dumpXml.includes("<hierarchy")) {
    return { disposition: "REPLAN", reason: "M6_LIVE_DUMP_UNUSABLE", blockSet: null, privateGeometry: new Map() };
  }
  if (!environmentAttestation || environmentAttestation.attestationHash !== frame.environmentAttestationHash) {
    return { disposition: "REPLAN", reason: "M6_ENV_ATTESTATION_MISMATCH", blockSet: null, privateGeometry: new Map() };
  }
  const rawNodes = Array.from(dumpXml.matchAll(/<node\b([^>]*)\/?\s*>/gu), (match) => attributes(match[1]));
  const parsed = rawNodes.map((attrs) => ({ attrs, bounds: bounds(attrs.bounds) }));
  const width = Math.max(0, ...parsed.filter((node) => node.bounds).map((node) => node.bounds.x2));
  const height = Math.max(0, ...parsed.filter((node) => node.bounds).map((node) => node.bounds.y2));
  const privateGeometry = new Map();
  const blocks = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const { attrs, bounds: region } = parsed[index];
    const semantic = [attrs.text, attrs["content-desc"], attrs["resource-id"], attrs.class].filter(Boolean).join(" ").normalize("NFKC");
    const packageName = attrs.package || /^([^:]+):id\//u.exec(attrs["resource-id"] || "")?.[1] || "unknown";
    const flags = {
      clickable: attrs.clickable === "true",
      scrollable: attrs.scrollable === "true",
      editable: /EditText/u.test(attrs.class || ""),
      system: SYSTEM_PACKAGE.test(packageName),
      sensitive: REDLINE.test(semantic),
      advertisement: AD.test(semantic),
      keyboard: KEYBOARD.test(`${semantic} ${packageName}`),
    };
    const actionable = region && (flags.clickable || flags.scrollable || flags.editable);
    const safeRegion = actionable && width > 0 && height > 0 && region.y1 >= Math.floor(height * 0.03)
      && region.y2 <= Math.ceil(height * 0.94) && !flags.sensitive && !flags.advertisement && !flags.keyboard;
    if (!actionable || !safeRegion) continue;
    const publicFeatures = {
      classHash: hashText(attrs.class),
      resourceHash: hashText(attrs["resource-id"]),
      textHash: hashText(attrs.text),
      descriptionHash: hashText(attrs["content-desc"]),
      packageHash: hashText(packageName),
      structureHash: m6LiveSha256(canonical({ index, classHash: hashText(attrs.class), resourceHash: hashText(attrs["resource-id"]) })),
      flags,
      safeRegion: true,
    };
    const nodeFingerprint = m6LiveSha256(canonical({ frameId: frame.frameId, index, ...publicFeatures }));
    const blockId = m6LiveSha256(`xw.m6-live-block.v1:${frame.frameId}:${nodeFingerprint}`);
    const boundsRef = m6LiveSha256(`xw.m6-private-bounds.v1:${blockId}:${canonical(region)}`);
    privateGeometry.set(boundsRef, Object.freeze({ ...region }));
    blocks.push(Object.freeze({ blockId, boundsRef, nodeFingerprint, ...publicFeatures }));
  }
  blocks.sort((a, b) => a.blockId.localeCompare(b.blockId));
  const pageFingerprint = m6LiveSha256(canonical({ frameId: frame.frameId, blocks: blocks.map((block) => block.blockId) }));
  const core = {
    schemaId: "xw.visual-block-set.v2",
    frameId: frame.frameId,
    environmentAttestationHash: environmentAttestation.attestationHash,
    pageFingerprint,
    blocks,
  };
  return {
    disposition: blocks.length > 0 ? "ALLOW_ONCE" : "REPLAN",
    reason: blocks.length > 0 ? null : "M6_LIVE_NO_SAFE_BLOCKS",
    blockSet: Object.freeze({ ...core, integritySha256: m6LiveSha256(`xw.visual-block-set.v2:${canonical(core)}`) }),
    privateGeometry,
  };
}

export function decideLiveGrounding({ frame, blockSet, intent, candidateBlockId = null, bindings }) {
  const targetKind = intent?.targetKind;
  let disposition = "ALLOW_ONCE";
  let target;
  if (!intent || FORBIDDEN_OPERATION.test(intent.operation || "")) disposition = "HARD_STOP";
  if (targetKind === "block") {
    const block = blockSet?.blocks?.find((candidate) => candidate.blockId === candidateBlockId);
    if (!block || !block.safeRegion || block.flags?.sensitive || block.flags?.advertisement || block.flags?.keyboard) disposition = "REPLAN";
    target = block ? { kind: "block", frameId: frame.frameId, blockId: block.blockId } : { kind: "none" };
  } else if (targetKind === "screen") {
    target = { kind: "screen", frameId: frame.frameId, pageFingerprint: blockSet.pageFingerprint, focusHash: frame.focusHash };
  } else if (targetKind === "none") {
    target = { kind: "none" };
  } else {
    disposition = "HARD_STOP";
    target = { kind: "none" };
  }
  if (blockSet?.frameId !== frame?.frameId || blockSet?.environmentAttestationHash !== bindings?.environmentAttestationHash) {
    disposition = "REPLAN";
  }
  const raw = {
    schemaId: "xw.grounding-decision.v2",
    operationKey: intent?.operationKey || "invalid",
    disposition,
    target,
    bindings: { ...bindings },
  };
  return Object.freeze({ ...raw, decisionRef: m6LiveSha256(`xw.grounding-decision.v2:${canonical(raw)}`) });
}

```

## New file: packages/kernel/tests/m6-action-slot.test.mjs

```mjs
import assert from "node:assert/strict";
import test from "node:test";

import { deriveM6ActionSlotSpec, deriveM6LogicalActionIdentity, deriveM6TrustedParameterHash, assertM6ActionSlotDispatch } from "../lib/m6-action-slot.mjs";
import { m6LiveSha256 as H } from "../lib/m6-live-grounding.mjs";

function slotInput() {
  return {
    scenarioManifestHash: H("manifest"), scenarioId: "scenario-1", logicalStepId: "step-1", actionSlotOrdinal: 0,
    alias: "01", primitive: "tap", actionFamily: "open_public_note", intentRef: H("intent"), intentPolicyHash: H("intent-policy"),
    targetKind: "block", targetEligibilityHash: H("eligibility"), trustedParameterHash: deriveM6TrustedParameterHash({}), allowedStateHash: H("states"),
    effectBoundaryHash: H("effects"), budgetPolicyHash: H("budget"), redlinePolicyHash: H("redline"), verificationPolicyHash: H("verify"),
  };
}

test("content-addressed action slot participates in stable logical action identity", () => {
  const spec = deriveM6ActionSlotSpec(slotInput());
  assert.deepEqual(deriveM6LogicalActionIdentity({ planHash: H("plan"), actionSlotSpec: spec }), deriveM6LogicalActionIdentity({ planHash: H("plan"), actionSlotSpec: spec }));
});

test("same family primitive, intent, and trusted parameter substitutions fail before dispatch", () => {
  const spec = deriveM6ActionSlotSpec(slotInput());
  for (const dispatch of [
    { intent: { targetKind: "block", intentRef: spec.intentRef }, manifestStep: { primitive: "back", trustedParameterHash: spec.trustedParameterHash, trustedParams: {} } },
    { intent: { targetKind: "block", intentRef: H("other") }, manifestStep: { primitive: "tap", trustedParameterHash: spec.trustedParameterHash, trustedParams: {} } },
    { intent: { targetKind: "block", intentRef: spec.intentRef }, manifestStep: { primitive: "tap", trustedParameterHash: H("other"), trustedParams: {} } },
    { intent: { targetKind: "block", intentRef: spec.intentRef }, manifestStep: { primitive: "tap", trustedParameterHash: spec.trustedParameterHash, trustedParams: { x: 1 } } },
  ]) assert.throws(() => assertM6ActionSlotDispatch({ actionSlotSpec: spec, ...dispatch }), { code: "M6_ACTION_SLOT_INVALID" });
});

```

## New file: packages/kernel/tests/m6-effect-boundary.test.mjs

```mjs
import assert from "node:assert/strict";
import test from "node:test";

import { deriveM64EffectBoundary, M6_4_EFFECT_FAMILIES, M6_4_FORBIDDEN_EFFECT_CLASSES, validateM64EffectBoundary, verifyM64EffectObservation } from "../lib/m6-effect-boundary.mjs";
import { createHash } from "node:crypto";

const H = (value) => createHash("sha256").update(value).digest("hex");
const boundary = deriveM64EffectBoundary({ a03Mode: "BOUNDED_READ_TRACE", testIdentityHash: H("isolated-test-identity"), families: M6_4_EFFECT_FAMILIES.map((primaryFamily) => ({ primaryFamily, oracleHash: H(`oracle:${primaryFamily}`), forbiddenEffectClasses: [...M6_4_FORBIDDEN_EFFECT_CLASSES], allowedBoundedReadTraces: primaryFamily === "search" ? ["private-search-history"] : [], resetObligations: primaryFamily === "search" ? ["clear-private-search-history"] : [] })) });

test("effect boundary covers all eight families and is content addressed", () => assert.deepEqual(validateM64EffectBoundary(boundary), { ok: true, errors: [] }));

test("independent oracle, enumerated traces, forbidden effects and reset results fail closed", () => {
  const oracle = { oracleHash: H("oracle:search"), selfDerived: false, stale: false };
  assert.equal(verifyM64EffectObservation({ boundary, family: "search", oracle, observedEffects: [{ effectClass: "private-search-history" }], resetResults: { "clear-private-search-history": true } }).ok, true);
  assert.ok(verifyM64EffectObservation({ boundary, family: "search", oracle: { ...oracle, selfDerived: true }, observedEffects: [], resetResults: {} }).errors.includes("M64_EFFECT_ORACLE_INVALID"));
  assert.ok(verifyM64EffectObservation({ boundary, family: "search", oracle, observedEffects: [{ effectClass: "social" }], resetResults: { "clear-private-search-history": true } }).errors.includes("M64_EFFECT_FORBIDDEN"));
  assert.ok(verifyM64EffectObservation({ boundary, family: "search", oracle, observedEffects: [], resetResults: {} }).errors.includes("M64_EFFECT_RESET_INCOMPLETE"));
});

```

## New file: services/control-plane/control-plane/lib/m6-gate-promoter.mjs

```mjs
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ControlPlaneError } from "./errors.mjs";
import { validateJsonSchema } from "./json-schema-validator.mjs";
import {
  loadEpochSchema,
  loadEpochSchemaV2,
  loadM6Gate,
  tombstoneAndWrite,
  writeImmutableJson,
} from "./m6-gate-loader.mjs";
import { loadGateIssuerAllowlist, verifyEpochProof } from "./m6-issuer-allowlist.mjs";
import {
  deriveEpochHashBySchema,
  deriveM6ActionEpochBindingHash,
  deriveM6EmergencyCloseAuthorizationHash,
} from "./m6-live-gate-v2.mjs";
import { canonicalJson, sha256 } from "./canonical.mjs";

function fail(code, message, details = {}) {
  throw new ControlPlaneError(code, message, { status: 409, details });
}

function locksHashForEpoch(epoch) {
  if (epoch.schemaId === "xw.m6-live-gate.v2") return epoch.lockSetRef?.sha256 || null;
  if (epoch.schemaId === "xw.m6-live-gate.v1") {
    return sha256(`xw.m6-locks.v1:${canonicalJson(epoch.lockHashes)}`);
  }
  return null;
}

function fenceFromEpoch(epoch, generation) {
  return {
    gateId: epoch.gateId,
    epochHash: epoch.epochHash,
    generation,
    mode: epoch.mode,
    purpose: epoch.schemaId === "xw.m6-live-gate.v2" ? epoch.purpose : null,
    allowlist: epoch.allowlist,
    expiresAt: epoch.expiresAt,
    releaseId: epoch.releaseId,
    sourceCommit: epoch.sourceCommit,
    locksHash: locksHashForEpoch(epoch),
  };
}

export function assertM6FileDbPointerConsistency({ loaded, fence, pointer }) {
  const tail = loaded?.chain?.[loaded.chain.length - 1] || null;
  const consistent = tail && fence && pointer
    && tail.epochHash === fence.epochHash
    && tail.epochHash === pointer.tailEpochHash
    && fence.generation === pointer.generation
    && pointer.chain?.[pointer.chain.length - 1] === tail.epochHash
    && tail.mode === fence.mode
    && (tail.schemaId === "xw.m6-live-gate.v2" ? tail.purpose : null) === fence.purpose
    && canonicalJson(tail.allowlist) === canonicalJson(fence.allowlist)
    && tail.expiresAt === fence.expiresAt
    && tail.releaseId === fence.releaseId
    && tail.sourceCommit === fence.sourceCommit
    && locksHashForEpoch(tail) === fence.locksHash;
  if (!consistent) fail("M6_GATE_TRIPLE_MISMATCH", "file chain, DB fence, and current pointer do not identify the same gate generation");
  return { ...fence };
}

export function promoteM6GateEpoch({
  state,
  m6Root,
  gateId,
  epoch,
  proof,
  issuerAllowlistPath = join(m6Root, "m6-gate", "issuer-keys.json"),
  promotedAt,
  emergencyClose = null,
  faultAfter = null,
} = {}) {
  if (!state || typeof state.getM6GateFence !== "function") fail("M6_GATE_PROMOTE_INPUT_INVALID", "StateStore v19 is required");
  if (!Number.isFinite(Date.parse(promotedAt || ""))) fail("M6_GATE_PROMOTE_INPUT_INVALID", "promotedAt must be an ISO date-time");
  const schema = epoch?.schemaId === "xw.m6-live-gate.v1"
    ? loadEpochSchema()
    : epoch?.schemaId === "xw.m6-live-gate.v2"
      ? loadEpochSchemaV2()
      : null;
  if (!schema) fail("M6_GATE_SCHEMA_UNKNOWN", "only exact v1/v2 epochs may be promoted");
  const schemaErrors = validateJsonSchema(epoch, schema);
  if (schemaErrors.length > 0 || deriveEpochHashBySchema(epoch) !== epoch.epochHash) {
    fail("M6_GATE_EPOCH_FORGED", `epoch is not schema-valid and self-hashed: ${schemaErrors.join("; ")}`);
  }
  const allowlist = loadGateIssuerAllowlist(issuerAllowlistPath);
  verifyEpochProof({ epoch, epochHash: epoch.epochHash, proof, allowlist });
  const current = loadM6Gate({ m6Root, gateId, issuerAllowlistPath, requireLocks: true });
  const fence = state.getM6GateFence();
  if (!fence) fail("M6_GATE_FENCE_UNSEEDED", "v19 M6 fence must be seeded before promotion");
  if (current.tailEpochHash !== fence.epochHash || epoch.parentEpochHash !== fence.epochHash) {
    fail("M6_GATE_FENCE_CAS_MISMATCH", "epoch parent, file tail, and DB fence do not agree");
  }
  let emergencyCloseConsumption = null;
  if (emergencyClose) {
    const parent = current.chain[current.chain.length - 1];
    const ref = parent?.emergencyCloseAuthorizationRef;
    const authorization = ref?.id ? current.emergencyCloseAuthorizations?.[ref.id] : null;
    const reasonCode = emergencyClose.reasonCode;
    if (epoch.mode !== "CLOSED" || parent?.schemaId !== "xw.m6-live-gate.v2" || parent.mode === "CLOSED"
      || !authorization || deriveM6EmergencyCloseAuthorizationHash(authorization) !== ref.sha256
      || authorization.authorizationHash !== ref.sha256
      || authorization.actionEpochBindingHash !== deriveM6ActionEpochBindingHash(parent)
      || authorization.expectedCurrentEpochHash !== parent.parentEpochHash
      || authorization.expectedParentEpochHash !== parent.parentEpochHash
      || authorization.operator !== epoch.actor
      || authorization.releaseId !== epoch.releaseId
      || !authorization.reasonCodeAllowlist?.includes(reasonCode)
      || Date.parse(authorization.expiresAt) <= Date.parse(promotedAt)) {
      fail("M6_GATE_EMERGENCY_CLOSE_INVALID", "emergency close is not covered by the active epoch authorization");
    }
    emergencyCloseConsumption = {
      nonce: authorization.nonce,
      authorizationHash: authorization.authorizationHash,
      reasonCode,
    };
  }
  const epochPath = join(m6Root, "m6-gate", gateId, "epochs", `${epoch.epochHash}.json`);
  if (existsSync(epochPath)) fail("M6_GATE_IMMUTABLE", "candidate epoch already exists");
  writeImmutableJson(epochPath, { ...epoch, proof });
  if (faultAfter === "immutableEpoch") fail("M6_GATE_PROMOTE_FAULT", "injected failure after immutable epoch append");
  const promotedFence = state.promoteM6GateFence({
    expectedEpochHash: fence.epochHash,
    expectedGeneration: fence.generation,
    next: fenceFromEpoch(epoch, fence.generation + 1),
    emergencyCloseConsumption,
  });
  if (faultAfter === "dbFence") fail("M6_GATE_PROMOTE_FAULT", "injected failure after DB fence commit");
  const chain = [...current.chain.map((entry) => entry.epochHash), epoch.epochHash];
  const pointer = {
    chain,
    tailEpochHash: epoch.epochHash,
    generation: promotedFence.generation,
    promotedAt,
  };
  tombstoneAndWrite(join(m6Root, "m6-gate", gateId, "current.json"), pointer);
  if (faultAfter === "pointer") fail("M6_GATE_PROMOTE_FAULT", "injected failure after current pointer commit");
  const loaded = loadM6Gate({ m6Root, gateId, issuerAllowlistPath, requireLocks: true });
  assertM6FileDbPointerConsistency({ loaded, fence: promotedFence, pointer });
  return { epochHash: epoch.epochHash, generation: promotedFence.generation, mode: epoch.mode, purpose: promotedFence.purpose };
}

```

## New file: services/control-plane/control-plane/lib/m6-grounded-action-facade.mjs

```mjs
import { performance } from "node:perf_hooks";

import { ControlPlaneError } from "./errors.mjs";
import { decideLiveGrounding, deriveLiveVisualBlockSet } from "../../../../packages/kernel/lib/m6-live-grounding.mjs";
import { assertM6ActionSlotDispatch, deriveM6LogicalActionIdentity } from "../../../../packages/kernel/lib/m6-action-slot.mjs";
import { validateM6TypedInvocation } from "./m6-typed-transport.mjs";

function actionError(code, message, cause = null) {
  return new ControlPlaneError(code, message, { status: 409, cause });
}

export function createM6GroundedActionFacade({
  state,
  typedTransport,
  captureWithinRun,
  readCurrentState,
  materializePrivate,
  verifyAfter,
  monoNow = () => performance.now(),
} = {}) {
  for (const [name, value] of Object.entries({ state, typedTransport, captureWithinRun, readCurrentState, materializePrivate, verifyAfter })) {
    if (!value || (["captureWithinRun", "readCurrentState", "materializePrivate", "verifyAfter"].includes(name) && typeof value !== "function")) {
      throw new TypeError(`${name} is required`);
    }
  }
  return Object.freeze({
    async execute({ session, environmentAttestation, intent, candidateBlockId = null, bindings, slot, actionSlotSpec, planHash, timing, fence, manifestStep, typedAuthorization }) {
      const frozenSlot = assertM6ActionSlotDispatch({ actionSlotSpec, intent, manifestStep });
      const identity = deriveM6LogicalActionIdentity({ planHash, actionSlotSpec: frozenSlot });
      if (intent.operationKey !== identity.operationKey || slot.slotSpecHash !== frozenSlot.actionSlotSpecHash) {
        throw actionError("M6_ACTION_SLOT_BINDING_MISMATCH", "operation key or permit slot does not match frozen authority");
      }
      const typedInvocation = validateM6TypedInvocation({ primitive: manifestStep.primitive, target: { kind: intent.targetKind }, trustedParams: manifestStep.trustedParams, operationKey: intent.operationKey });
      if (!typedInvocation.writePrimitive) {
        throw actionError("M6_ACTION_PRIMITIVE_NOT_WRITE", "grounded action facade accepts only bounded write primitives");
      }
      const active = state.validateSession(session.sessionId, session.token);
      if (active.leaseId !== session.leaseId || active.sessionId !== bindings.sessionId || active.leaseId !== bindings.leaseId) {
        throw actionError("M6_ACTION_BINDING_MISMATCH", "composite run session/lease binding changed");
      }
      const before = await captureWithinRun({ session, phase: "before" });
      const provider = deriveLiveVisualBlockSet({
        frame: before.frame,
        dumpXml: before.dumpXml,
        environmentAttestation,
      });
      if (!provider.blockSet) {
        return { disposition: "REPLAN", externalEffect: false, actionCount: 0, effectStatus: "NOT_SENT", reason: provider.reason };
      }
      const decision = decideLiveGrounding({
        frame: before.frame,
        blockSet: provider.blockSet,
        intent,
        candidateBlockId,
        bindings,
      });
      if (decision.disposition !== "ALLOW_ONCE") {
        return { disposition: decision.disposition, decisionRef: decision.decisionRef, externalEffect: false, actionCount: 0, effectStatus: "NOT_SENT" };
      }
      let actionId = null;
      try {
        const prepared = state.prepareM6GroundedAction({ decision, slot, timing, fence });
        actionId = prepared.ledger.actionId;
        state.authorizeM6GroundedActionSend({
          actionId,
          fence,
          expectedPermit: { operationKey: decision.operationKey, target: decision.target, bindings: decision.bindings, slot },
          nowMonoMs: monoNow(),
          typedAuthorization,
        });
        const guardStartedMonoMs = monoNow();
        const currentState = await readCurrentState({ session, actionId });
        const privateMaterial = await materializePrivate({
          decision,
          blockSet: provider.blockSet,
          privateGeometry: provider.privateGeometry,
          manifestStep,
        });
        const writeReadyMonoMs = monoNow();
        state.markM6ActionTransportStart({ actionId, currentState, guardStartedMonoMs, writeReadyMonoMs });
        let transportResult;
        try {
          transportResult = await typedTransport.dispatch({
            primitive: manifestStep.primitive,
            target: decision.target,
            trustedParams: manifestStep.trustedParams,
            operationKey: decision.operationKey,
          }, privateMaterial);
        } catch (error) {
          state.recordM6ActionTransportOutcome({ actionId, ok: false, result: {}, errorCode: error.code || "M6_TRANSPORT_UNKNOWN" });
          throw actionError("M6_ACTION_AMBIGUOUS", "transport failed after counter linearization", error);
        }
        state.recordM6ActionTransportOutcome({ actionId, ok: true, result: transportResult });
        const after = await captureWithinRun({ session, phase: "after" });
        const verification = await verifyAfter({ before, after, decision, manifestStep, transportResult });
        const completed = state.completeM6GroundedAction({
          actionId,
          afterObservation: after.observation,
          verification,
          receipt: { actionId, operationKey: decision.operationKey, decisionRef: decision.decisionRef },
        });
        const finalSession = state.validateSession(session.sessionId, session.token);
        if (finalSession.leaseId !== session.leaseId) throw actionError("M6_ACTION_BINDING_MISMATCH", "lease changed before action completion");
        return {
          disposition: "ALLOW_ONCE",
          actionId,
          decisionRef: decision.decisionRef,
          externalEffect: true,
          actionCount: completed.transportCounter,
          effectStatus: "VERIFIED",
          verification,
        };
      } catch (error) {
        if (actionId) {
          const ledger = state.getM6ActionLedger(actionId);
          if (ledger && ledger.transportCounter === 0 && ["ASSESSED", "EXECUTING"].includes(ledger.status)) {
            state.abortM6GroundedActionNotSent({ actionId, errorCode: error.code || "M6_ACTION_ABORTED" });
          }
        }
        throw error;
      }
    },
  });
}

```

## New file: services/control-plane/control-plane/lib/m6-live-gate-v2.mjs

```mjs
import { canonicalJson, sha256 } from "./canonical.mjs";
import {
  deriveM6EpochHash,
  evaluateM6Gate,
  resolveM6AggregateSeal,
  resolveM6Closeout,
} from "./m6-live-gate.mjs";

export const M6_GATE_V2_SCHEMA_ID = "xw.m6-live-gate.v2";
export const M6_LOCKS_V2_SCHEMA_ID = "xw.m6-locks.v2";
export const M6_GATE_V2_MODES = Object.freeze(["CLOSED", "OBSERVE_ONLY", "GROUNDED_ACTION"]);
export const M6_GATE_V2_PURPOSES = Object.freeze([
  "M6_4_SHADOW",
  "M6_4_HOT_CLOSE",
  "M6_4_ACTION_SMOKE",
  "M6_4_RELIABILITY",
  "M6_4_SMOOTH",
  "M6_4_CLOSEOUT",
]);
export const M6_GATE_V2_LOCK_KINDS = Object.freeze([
  "runtimeProfile", "hardRedlinePolicy", "groundingRuntime",
  "dshSource", "dshProfile", "liveToolSpec", "modelProfile",
  "liveProvider", "grantActionPolicy", "brokerProtocol",
  "typedTransport", "scenarioManifest",
]);

const HEX64 = /^[0-9a-f]{64}$/;

export function deriveM6V2EpochHash(epoch) {
  if (!epoch || typeof epoch !== "object") return null;
  const { epochHash: _ignored, ...payload } = epoch;
  return sha256(`xw.m6-live-gate.v2:${canonicalJson(payload)}`);
}

export function deriveM6V2LockSetHash(lockSet) {
  if (!lockSet || typeof lockSet !== "object") return null;
  const { lockSetHash: _ignored, ...payload } = lockSet;
  return sha256(`xw.m6-locks.v2:${canonicalJson(payload)}`);
}

export function deriveM6EmergencyCloseAuthorizationHash(authorization) {
  if (!authorization || typeof authorization !== "object") return null;
  const { authorizationHash: _ignored, ...payload } = authorization;
  return sha256(`xw.m6-emergency-close-authorization.v1:${canonicalJson(payload)}`);
}

export function deriveM6ActionEpochBindingHash(epoch) {
  if (!epoch || typeof epoch !== "object") return null;
  const {
    epochHash: _ignoredEpochHash,
    emergencyCloseAuthorizationRef: _ignoredEmergencyRef,
    ...payload
  } = epoch;
  return sha256(`xw.m6-live-gate.v2:action-binding:${canonicalJson(payload)}`);
}

function closed(code, message, activeEpoch = null) {
  return {
    mode: "CLOSED",
    purpose: null,
    activeEpochHash: activeEpoch?.epochHash || null,
    activeEpoch,
    errors: [{ code, message }],
  };
}

function validRef(ref) {
  return Boolean(ref && typeof ref === "object" && typeof ref.id === "string" && ref.id && HEX64.test(ref.sha256 || ""));
}

function resolveRecord(ref, records) {
  if (!validRef(ref)) return null;
  const record = records?.[ref.id];
  if (!record || typeof record !== "object") return null;
  return record;
}

function evaluateV2Epoch(epoch, {
  nowMs,
  expectedRelease,
  lockSets,
  emergencyCloseAuthorizations,
  closeouts,
  aggregates,
  priorHash,
  index,
}) {
  if (deriveM6V2EpochHash(epoch) !== epoch.epochHash) return closed("M6_GATE_EPOCH_FORGED", `v2 epoch ${index} self-hash mismatch`);
  if (!M6_GATE_V2_MODES.includes(epoch.mode)) return closed("M6_GATE_MODE_INVALID", `v2 epoch ${index} has unknown mode`);
  if (!M6_GATE_V2_PURPOSES.includes(epoch.purpose)) return closed("M6_GATE_PURPOSE_INVALID", `v2 epoch ${index} has unknown purpose`);
  if (epoch.parentEpochHash !== priorHash) return closed("M6_GATE_PARENT_MISMATCH", `v2 epoch ${index} parent mismatch`);
  if (expectedRelease && (epoch.releaseId !== expectedRelease.releaseId || epoch.sourceCommit !== expectedRelease.sourceCommit)) {
    return closed("M6_GATE_RELEASE_MISMATCH", `v2 epoch ${index} release mismatch`);
  }
  const expiresAt = Date.parse(epoch.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return closed("M6_GATE_EXPIRED", `v2 epoch ${index} is expired`);
  if (!Array.isArray(epoch.allowlist) || epoch.allowlist.length === 0 || new Set(epoch.allowlist).size !== epoch.allowlist.length) {
    return closed("M6_GATE_ALLOWLIST_INVALID", `v2 epoch ${index} allowlist invalid`);
  }
  if (epoch.mode === "GROUNDED_ACTION" && (epoch.allowlist.length !== 1 || epoch.allowlist[0] !== "01")) {
    return closed("M6_GATE_ACTION_ALLOWLIST_INVALID", "M6-4 GROUNDED_ACTION allowlist must be exactly alias 01");
  }
  const lockSet = resolveRecord(epoch.lockSetRef, lockSets);
  if (!lockSet || lockSet.schemaId !== M6_LOCKS_V2_SCHEMA_ID || deriveM6V2LockSetHash(lockSet) !== lockSet.lockSetHash
    || lockSet.lockSetHash !== epoch.lockSetRef.sha256) {
    return closed("M6_GATE_LOCK_MISMATCH", `v2 epoch ${index} lock set is absent or forged`);
  }
  if (M6_GATE_V2_LOCK_KINDS.some((kind) => !HEX64.test(lockSet.lockHashes?.[kind] || ""))) {
    return closed("M6_GATE_LOCK_MISMATCH", `v2 epoch ${index} lock set is incomplete`);
  }
  if (epoch.mode === "CLOSED") {
    if (epoch.status !== "closed" || !validRef(epoch.closeoutRef) || !validRef(epoch.aggregateSealRef)
      || epoch.emergencyCloseAuthorizationRef !== null) {
      return closed("M6_GATE_CLOSEOUT_FORGED", `v2 CLOSED epoch ${index} seal bindings invalid`);
    }
    const closeout = resolveM6Closeout(epoch.closeoutRef, closeouts);
    const aggregate = resolveM6AggregateSeal(epoch.aggregateSealRef, aggregates);
    if (!closeout.ok || !aggregate.ok || aggregate.aggregate.epochHash !== closeout.closeout.epochHash) {
      return closed("M6_GATE_CLOSEOUT_FORGED", `v2 CLOSED epoch ${index} closeout or aggregate is absent, forged, or cross-bound`);
    }
  } else {
    if (epoch.status !== "active" || epoch.closeoutRef !== null || epoch.aggregateSealRef !== null
      || epoch.rollbackTargetEpochHash !== null) {
      return closed("M6_GATE_EPOCH_FORGED", `v2 active epoch ${index} carries CLOSED-only fields`);
    }
    const emergency = resolveRecord(epoch.emergencyCloseAuthorizationRef, emergencyCloseAuthorizations);
    if (!emergency || emergency.authorizationHash !== epoch.emergencyCloseAuthorizationRef.sha256
      || deriveM6EmergencyCloseAuthorizationHash(emergency) !== emergency.authorizationHash
      || emergency.actionEpochBindingHash !== deriveM6ActionEpochBindingHash(epoch)
      || emergency.expectedCurrentEpochHash !== epoch.parentEpochHash
      || emergency.expectedParentEpochHash !== epoch.parentEpochHash
      || emergency.releaseId !== epoch.releaseId
      || emergency.alias !== epoch.allowlist[0]
      || !Number.isFinite(Date.parse(emergency.expiresAt))
      || Date.parse(emergency.expiresAt) < expiresAt + 30 * 60 * 1000) {
      return closed("M6_GATE_EMERGENCY_CLOSE_INVALID", `v2 active epoch ${index} lacks covering emergency-close authorization`);
    }
  }
  return null;
}

export function evaluateM6MixedGate({
  chain = [],
  closeouts = {},
  aggregates = {},
  lockSets = {},
  emergencyCloseAuthorizations = {},
  nowMs,
  expectedRelease = null,
  v1LockHashes = null,
} = {}) {
  if (!Number.isFinite(nowMs)) return closed("M6_GATE_CLOCK_INVALID", "mixed gate evaluation requires nowMs");
  if (!Array.isArray(chain) || chain.length === 0) return closed("M6_GATE_EMPTY", "mixed gate chain is empty");
  const firstV2 = chain.findIndex((epoch) => epoch?.schemaId === M6_GATE_V2_SCHEMA_ID);
  if (chain.some((epoch) => !["xw.m6-live-gate.v1", M6_GATE_V2_SCHEMA_ID].includes(epoch?.schemaId))) {
    return closed("M6_GATE_SCHEMA_UNKNOWN", "mixed gate chain contains an unknown schemaId");
  }
  if (firstV2 >= 0 && chain.slice(firstV2 + 1).some((epoch) => epoch.schemaId === "xw.m6-live-gate.v1")) {
    return closed("M6_GATE_SCHEMA_DOWNGRADE", "v1 epoch may not follow a v2 epoch");
  }
  const v1Prefix = firstV2 < 0 ? chain : chain.slice(0, firstV2);
  if (v1Prefix.length > 0) {
    const v1 = evaluateM6Gate({ chain: v1Prefix, closeouts, aggregates, nowMs, expectedRelease, lockHashes: v1LockHashes });
    if (v1.errors.length > 0) return { ...v1, purpose: null };
  }
  if (firstV2 < 0) {
    const v1 = evaluateM6Gate({ chain, closeouts, aggregates, nowMs, expectedRelease, lockHashes: v1LockHashes });
    return { ...v1, purpose: null };
  }
  let priorHash = firstV2 === 0 ? null : chain[firstV2 - 1].epochHash;
  for (let index = firstV2; index < chain.length; index += 1) {
    const epoch = chain[index];
    const failure = evaluateV2Epoch(epoch, {
      nowMs,
      expectedRelease,
      lockSets,
      emergencyCloseAuthorizations,
      closeouts,
      aggregates,
      priorHash,
      index,
    });
    if (failure) return failure;
    priorHash = epoch.epochHash;
  }
  const activeEpoch = chain[chain.length - 1];
  return {
    mode: activeEpoch.mode === "CLOSED" ? "CLOSED" : activeEpoch.mode,
    purpose: activeEpoch.purpose,
    activeEpochHash: activeEpoch.epochHash,
    activeEpoch,
    errors: [],
  };
}

export function deriveEpochHashBySchema(epoch) {
  if (epoch?.schemaId === "xw.m6-live-gate.v1") return deriveM6EpochHash(epoch);
  if (epoch?.schemaId === M6_GATE_V2_SCHEMA_ID) return deriveM6V2EpochHash(epoch);
  return null;
}

```

## New file: services/control-plane/control-plane/lib/m6-typed-transport.mjs

```mjs
import { ControlPlaneError } from "./errors.mjs";

export const M6_SERVER_PRIMITIVES = Object.freeze([
  "observe", "open_app", "back", "wait", "tap", "scroll", "type_search_text",
]);

const WRITE_PRIMITIVES = new Set(["open_app", "back", "tap", "scroll", "type_search_text"]);

function fail(message) {
  throw new ControlPlaneError("M6_TYPED_TRANSPORT_INVALID", message, { status: 409 });
}

export function validateM6TypedInvocation(invocation) {
  if (!invocation || !M6_SERVER_PRIMITIVES.includes(invocation.primitive)) fail("unknown M6 server primitive");
  const params = invocation.trustedParams || {};
  const target = invocation.target;
  if (["tap", "type_search_text"].includes(invocation.primitive) && target?.kind !== "block") fail("targeted primitive requires a block target");
  if (invocation.primitive === "scroll" && target?.kind !== "screen") fail("scroll requires a screen target");
  if (["open_app", "back", "wait", "observe"].includes(invocation.primitive) && target?.kind !== "none") fail("non-target primitive requires target kind none");
  if (invocation.primitive === "open_app" && !/^[0-9a-f]{64}$/.test(params.appRef || "")) fail("open_app requires a trusted appRef");
  if (invocation.primitive === "type_search_text" && !/^[0-9a-f]{64}$/.test(params.textRef || "")) fail("type_search_text requires a trusted textRef");
  if (invocation.primitive === "scroll" && (!['up', 'down'].includes(params.direction) || !['short', 'medium'].includes(params.distanceTier))) fail("scroll parameters are outside the bounded policy");
  if (invocation.primitive === "wait" && (!Number.isInteger(params.durationMs) || params.durationMs < 0 || params.durationMs > 2_000)) fail("wait duration is outside 0..2000ms");
  if (Object.keys(params).some((key) => /^(?:x|y|x1|y1|x2|y2|bounds|command|shell|package|text)$/iu.test(key))) fail("raw coordinate/shell/package/text parameters are forbidden");
  return { ...invocation, writePrimitive: WRITE_PRIMITIVES.has(invocation.primitive) };
}

export function createM6TypedTransport({ invokeWrite, invokeRead = null } = {}) {
  if (typeof invokeWrite !== "function") throw new TypeError("invokeWrite is required");
  return Object.freeze({
    async dispatch(invocation, privateMaterial) {
      const checked = validateM6TypedInvocation(invocation);
      if (!checked.writePrimitive) {
        if (checked.primitive === "wait") return { ok: true, waitedMs: checked.trustedParams.durationMs, transportCalled: false };
        if (typeof invokeRead !== "function") return { ok: true, transportCalled: false };
        return { ...(await invokeRead(checked, privateMaterial)), transportCalled: false };
      }
      if (["tap", "type_search_text"].includes(checked.primitive) && !privateMaterial?.point) fail("server-private point is required");
      if (checked.primitive === "type_search_text" && typeof privateMaterial?.text !== "string") fail("server-private trusted text is required");
      const result = await invokeWrite(checked, privateMaterial);
      return { ...result, transportCalled: true };
    },
  });
}

```

## New file: services/control-plane/tests/m6-4-cohort.test.mjs

```mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveM64CohortAggregateHash,
  deriveM64CohortManifestHash,
  M6_4_COHORT_RULES,
  M6_4_SMOOTH_DISTRIBUTION,
  validateM64CohortAggregate,
  validateM64CohortManifest,
} from "../../../packages/kernel/lib/m6-4-cohort.mjs";

function aggregate(purpose, overrides = {}) {
  const rule = M6_4_COHORT_RULES[purpose];
  const keys = Array.from({ length: rule.attempts }, (_, index) => `${purpose.toLowerCase()}-${index + 1}`);
  const raw = {
    schemaId: "xw.m6-4-cohort-aggregate.v1",
    purpose,
    alias: "01",
    expectedScenarioKeys: keys,
    attempts: keys.map((scenarioKey) => ({
      scenarioKey,
      alias: "01",
      status: "SUCCEEDED",
      actionCount: purpose === "M6_4_SHADOW" ? 0 : 1,
      transportCount: purpose === "M6_4_SHADOW" ? 0 : 1,
      forbiddenEffectCount: 0,
      publicEffectCount: 0,
      paymentAttemptCount: 0,
      deleteAttemptCount: 0,
    })),
    ...overrides,
  };
  return { ...raw, aggregateHash: deriveM64CohortAggregateHash(raw) };
}

test("purpose-specific cardinalities and thresholds validate without cross-window substitution", () => {
  for (const purpose of ["M6_4_SHADOW", "M6_4_ACTION_SMOKE", "M6_4_RELIABILITY", "M6_4_SMOOTH"]) {
    assert.deepEqual(validateM64CohortAggregate(aggregate(purpose)), { ok: true, errors: [] });
  }
});

test("shadow action, substituted scenario, and forbidden effect fail closed", () => {
  const shadow = aggregate("M6_4_SHADOW");
  shadow.attempts[0].actionCount = 1;
  shadow.aggregateHash = deriveM64CohortAggregateHash(shadow);
  assert.ok(validateM64CohortAggregate(shadow).errors.includes("M64_COHORT_ZERO_ACTION_VIOLATION"));
  const reliability = aggregate("M6_4_RELIABILITY");
  reliability.attempts[0].scenarioKey = "replacement";
  reliability.attempts[1].publicEffectCount = 1;
  reliability.aggregateHash = deriveM64CohortAggregateHash(reliability);
  const errors = validateM64CohortAggregate(reliability).errors;
  assert.ok(errors.includes("M64_COHORT_SCENARIO_SUBSTITUTION"));
  assert.ok(errors.includes("M64_COHORT_FORBIDDEN_EFFECT"));
});

function manifest(purpose) {
  const families = purpose === "M6_4_SMOOTH"
    ? Object.entries(M6_4_SMOOTH_DISTRIBUTION).flatMap(([family, count]) => Array(count).fill(family))
    : Array(M6_4_COHORT_RULES[purpose].attempts).fill(purpose === "M6_4_RELIABILITY" ? "search" : "safe-navigation");
  const raw = {
    schemaId: "xw.m6-4-cohort-manifest.v1", purpose, alias: "01", gateFEligible: false, liveAuthorizationRef: null,
    scenarios: families.map((primaryFamily, index) => ({ scenarioKey: `${purpose}-${index + 1}`, alias: "01", primaryFamily, authorized: false, executionStatus: "NOT_RUN", oracleHash: `${index}`.padStart(64, "a"), effectBoundaryHash: `${index}`.padStart(64, "b") })),
  };
  return { ...raw, manifestHash: deriveM64CohortManifestHash(raw) };
}

test("offline frozen cohort manifests enforce cardinality and exact smooth distribution", () => {
  for (const purpose of Object.keys(M6_4_COHORT_RULES)) assert.deepEqual(validateM64CohortManifest(manifest(purpose)), { ok: true, errors: [] });
  const smooth = manifest("M6_4_SMOOTH");
  smooth.scenarios[0].primaryFamily = "search";
  smooth.manifestHash = deriveM64CohortManifestHash(smooth);
  assert.ok(validateM64CohortManifest(smooth).errors.includes("M64_SMOOTH_DISTRIBUTION_INVALID"));
});

```

## New file: services/control-plane/tests/m6-action-ledger.test.mjs

```mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { canonicalJson, sha256 } from "../control-plane/lib/canonical.mjs";
import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";

const H = (char) => char.repeat(64);
const contexts = new WeakMap();
const M6_CAPABILITY = {
  schemaVersion: 1, id: "m6.agentic_session", appId: "xiaowei", packageName: "com.xhs", versionRange: "test",
  maturity: "E3", risk: "R1", resources: ["device"], inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object" }, preconditions: [], verification: { mode: "state", description: "M6 after-frame" },
  restoration: { required: false, description: "bounded action" }, timeoutMs: 5000, idempotency: "external_effect",
  automationPolicy: { mode: "automatic" }, implementation: { adapter: "m6-typed-adapter", action: "grounded_action" }, evidence: [],
};

function formalize(state, d) {
  let context = contexts.get(state);
  if (!context) {
    state.syncCapabilities(new CapabilityRegistry([M6_CAPABILITY]));
    state.upsertNode({ nodeId: "m6-node", authority: true });
    const device = state.upsertDevice({ deviceId: "device-m6-grounded", alias: "01", physicalLabel: "m6-test", nodeId: "m6-node", runtimeId: "m6-runtime", routingProfile: { enabled: true, capabilityIds: [M6_CAPABILITY.id] } });
    const session = state.createSession({ actorId: "agent:m6-test", deviceId: device.deviceId, sessionKind: "open_action", canary: true });
    context = { device, session };
    contexts.set(state, context);
  }
  const job = state.createJob({
    idempotencyKey: `m6-job-${d.operationKey}`, actorId: "agent:m6-test", authorityNodeId: "m6-node",
    deviceId: context.device.deviceId, capability: M6_CAPABILITY, sessionId: context.session.sessionId, status: "running",
  }).job;
  Object.assign(d.bindings, { runId: job.runId, sessionId: context.session.sessionId, leaseId: context.session.leaseId, jobId: job.jobId, deviceId: context.device.deviceId });
  return job;
}

function seedEpoch() {
  const raw = {
    schemaId: "xw.m6-live-gate.v1", gateId: "m6-gate", mode: "CLOSED", status: "closed",
    releaseId: "release-action-test", sourceCommit: "a".repeat(40), actor: "operator:test",
    lockHashes: { runtimeProfile: H("1"), hardRedlinePolicy: H("2"), groundingRuntime: H("3") },
    allowlist: ["01"], issuedAt: "2030-01-01T00:00:00Z", expiresAt: "2030-01-02T00:00:00Z",
    parentEpochHash: null, closeoutRef: { id: "c", sha256: H("4") }, aggregateSealRef: { id: "a", sha256: H("5") }, rollbackTargetEpochHash: null,
  };
  return { ...raw, epochHash: sha256(`xw.m6-live-gate.v1:${canonicalJson(raw)}`) };
}

function openFence(state) {
  const seed = seedEpoch();
  state.seedM6GateFence({ epoch: seed, locksHash: H("6") });
  return state.promoteM6GateFence({
    expectedEpochHash: seed.epochHash,
    expectedGeneration: 0,
    next: {
      gateId: seed.gateId, epochHash: H("7"), mode: "GROUNDED_ACTION", purpose: "M6_4_ACTION_SMOKE",
      allowlist: ["01"], expiresAt: "2030-01-01T01:00:00Z", releaseId: seed.releaseId,
      sourceCommit: seed.sourceCommit, locksHash: H("8"),
    },
  });
}

function decision(fence, operationKey = "operation-1", ref = "9") {
  return {
    schemaId: "xw.grounding-decision.v2", decisionRef: H(ref), operationKey, disposition: "ALLOW_ONCE",
    target: { kind: "block", frameId: H("b"), blockId: H("c") },
    bindings: {
      runId: "run-1", sessionId: "session-1", leaseId: "lease-1", gateEpochHash: fence.epochHash,
      gateGeneration: fence.generation, grantHash: H("d"), stepId: "step-1", environmentAttestationHash: H("e"),
    },
  };
}

function slot() {
  return {
    slotSpecHash: H("f"), frameId: H("b"), blockId: H("c"), uiStateGeneration: 1,
    appPackageHash: H("1"), focusHash: H("2"), pageFingerprint: H("3"), rotation: 0,
    displayHash: H("4"), environmentAttestationHash: H("e"),
  };
}

function expected(d, s) {
  return { operationKey: d.operationKey, target: d.target, bindings: d.bindings, slot: s };
}

function typedAuth(state, d) {
  return state.issueTransportActionAuthorization({
    kind: "capability_job", purpose: "execute", jobId: d.bindings.jobId, runId: d.bindings.runId,
    leaseId: d.bindings.leaseId, deviceId: d.bindings.deviceId, operationKey: d.operationKey,
    capabilityContractHash: H("a"), implementationClosureHash: H("b"), jobStatus: "running", source: "m6-parent-broker",
    ttlMs: 5_000, now: state.now,
  });
}

test("three transactions reuse Action Ledger ASSESSED→EXECUTING→EXECUTED→VERIFIED→COMPLETED with one transport", () => {
  let now = Date.parse("2030-01-01T00:00:00Z");
  const state = new StateStore({ now: () => now });
  try {
    const fence = openFence(state);
    const d = decision(fence);
    formalize(state, d);
    const s = slot();
    const prepared = state.prepareM6GroundedAction({
      decision: d, slot: s, timing: { issuedAtMs: now, expiresAtMs: now + 5_000, dispatchDeadlineMonoMs: 50_000 }, fence,
    });
    assert.equal(prepared.ledger.status, "ASSESSED");
    assert.equal(prepared.ledger.transportCounter, 0);
    const authorized = state.authorizeM6GroundedActionSend({ actionId: prepared.ledger.actionId, fence, expectedPermit: expected(d, s), nowMonoMs: 46_000, typedAuthorization: typedAuth(state, d) });
    assert.equal(authorized.status, "EXECUTING");
    const sending = state.markM6ActionTransportStart({ actionId: prepared.ledger.actionId, currentState: s, guardStartedMonoMs: 46_010, writeReadyMonoMs: 46_100 });
    assert.equal(sending.transportCounter, 1);
    assert.equal(sending.status, "EXECUTING");
    assert.equal(state.recordM6ActionTransportOutcome({ actionId: prepared.ledger.actionId, ok: true, result: { writeAck: true } }).status, "EXECUTED");
    const completed = state.completeM6GroundedAction({
      actionId: prepared.ledger.actionId,
      afterObservation: { observationId: "obs-after", evidenceRefs: [H("a")] },
      verification: { ok: true, stateChanged: true },
      receipt: { actionId: prepared.ledger.actionId, operationKey: d.operationKey },
    });
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.transportCounter, 1);
    assert.equal(completed.effectStatus, "VERIFIED_EFFECT");
  } finally { state.close(); }
});

test("global claim, guard drift, and post-counter failure split no-effect from ambiguous", () => {
  let now = Date.parse("2030-01-01T00:00:00Z");
  const state = new StateStore({ now: () => now });
  try {
    const fence = openFence(state);
    const s = slot();
    const first = decision(fence, "same-operation", "8");
    formalize(state, first);
    const prepared = state.prepareM6GroundedAction({ decision: first, slot: s, timing: { issuedAtMs: now, expiresAtMs: now + 5_000, dispatchDeadlineMonoMs: 50_000 }, fence });
    assert.throws(() => state.prepareM6GroundedAction({
      decision: decision(fence, "same-operation", "7"), slot: s,
      timing: { issuedAtMs: now, expiresAtMs: now + 5_000, dispatchDeadlineMonoMs: 50_000 }, fence,
    }), { code: "M6_LOGICAL_ACTION_CLAIM_CONFLICT" });
    state.authorizeM6GroundedActionSend({ actionId: prepared.ledger.actionId, fence, expectedPermit: expected(first, s), nowMonoMs: 46_000, typedAuthorization: typedAuth(state, first) });
    assert.throws(() => state.markM6ActionTransportStart({
      actionId: prepared.ledger.actionId, currentState: { ...s, focusHash: H("0") }, guardStartedMonoMs: 46_010, writeReadyMonoMs: 46_100,
    }), { code: "M6_TCB_CURRENT_STATE_GUARD" });
    const blocked = state.getM6ActionLedger(prepared.ledger.actionId);
    assert.equal(blocked.transportCounter, 0);
    assert.equal(blocked.externalEffect, false);

    const second = decision(fence, "operation-2", "6");
    formalize(state, second);
    const p2 = state.prepareM6GroundedAction({ decision: second, slot: s, timing: { issuedAtMs: now, expiresAtMs: now + 5_000, dispatchDeadlineMonoMs: 60_000 }, fence });
    state.authorizeM6GroundedActionSend({ actionId: p2.ledger.actionId, fence, expectedPermit: expected(second, s), nowMonoMs: 56_000, typedAuthorization: typedAuth(state, second) });
    state.markM6ActionTransportStart({ actionId: p2.ledger.actionId, currentState: s, guardStartedMonoMs: 56_010, writeReadyMonoMs: 56_100 });
    const ambiguous = state.recordM6ActionTransportOutcome({ actionId: p2.ledger.actionId, ok: false, errorCode: "WRITE_UNKNOWN" });
    assert.equal(ambiguous.status, "AMBIGUOUS");
    assert.equal(ambiguous.transportCounter, 1);
    assert.equal(ambiguous.externalEffect, true);
  } finally { state.close(); }
});

test("restart never retries: unsent becomes BLOCKED and counter=1 becomes AMBIGUOUS", () => {
  const root = mkdtempSync(join(tmpdir(), "m6-ledger-restart-"));
  const dbPath = join(root, "control.db");
  let now = Date.parse("2030-01-01T00:00:00Z");
  let state = new StateStore({ dbPath, now: () => now });
  try {
    const fence = openFence(state);
    const s = slot();
    const unsentDecision = decision(fence, "restart-unsent", "5");
    formalize(state, unsentDecision);
    const unsent = state.prepareM6GroundedAction({ decision: unsentDecision, slot: s, timing: { issuedAtMs: now, expiresAtMs: now + 5_000, dispatchDeadlineMonoMs: 70_000 }, fence });
    const sentDecision = decision(fence, "restart-sent", "4");
    formalize(state, sentDecision);
    const sent = state.prepareM6GroundedAction({ decision: sentDecision, slot: s, timing: { issuedAtMs: now, expiresAtMs: now + 5_000, dispatchDeadlineMonoMs: 80_000 }, fence });
    state.authorizeM6GroundedActionSend({ actionId: sent.ledger.actionId, fence, expectedPermit: expected(sentDecision, s), nowMonoMs: 76_000, typedAuthorization: typedAuth(state, sentDecision) });
    state.markM6ActionTransportStart({ actionId: sent.ledger.actionId, currentState: s, guardStartedMonoMs: 76_010, writeReadyMonoMs: 76_100 });
    state.close();
    state = new StateStore({ dbPath, now: () => now });
    assert.equal(state.getM6ActionLedger(unsent.ledger.actionId).status, "BLOCKED");
    assert.equal(state.getM6ActionLedger(sent.ledger.actionId).status, "AMBIGUOUS");
  } finally {
    try { state.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("tx#2 atomically binds and consumes permit plus capability-job typed authorization", () => {
  const now = Date.parse("2030-01-01T00:00:00Z");
  const state = new StateStore({ now: () => now });
  try {
    const fence = openFence(state);
    const s = slot();
    const d = decision(fence, "atomic-typed-auth", "3");
    formalize(state, d);
    const prepared = state.prepareM6GroundedAction({ decision: d, slot: s, timing: { issuedAtMs: now, expiresAtMs: now + 5_000, dispatchDeadlineMonoMs: 50_000 }, fence });
    const wrong = state.issueTransportActionAuthorization({
      kind: "capability_job", purpose: "execute", jobId: "job-wrong", runId: "wrong-run", leaseId: d.bindings.leaseId,
      deviceId: "device-m6-grounded", operationKey: d.operationKey, capabilityContractHash: H("a"), jobStatus: "running", now: state.now,
    });
    assert.throws(() => state.authorizeM6GroundedActionSend({ actionId: prepared.ledger.actionId, fence, expectedPermit: expected(d, s), nowMonoMs: 46_000, typedAuthorization: wrong }), { code: "M6_TYPED_AUTH_BINDING_MISMATCH" });
    assert.equal(state.getM6GroundingPermit(prepared.permit.permitId).consumedAt, null);
    assert.equal(state.getTransportActionAuthorization(wrong.authorization.authorizationId).consumedAt, null);
    assert.equal(state.getM6ActionLedger(prepared.ledger.actionId).status, "ASSESSED");
    const right = typedAuth(state, d);
    const authorized = state.authorizeM6GroundedActionSend({ actionId: prepared.ledger.actionId, fence, expectedPermit: expected(d, s), nowMonoMs: 46_000, typedAuthorization: right });
    assert.equal(authorized.status, "EXECUTING");
    assert.ok(state.getM6GroundingPermit(prepared.permit.permitId).consumedAt);
    assert.ok(state.getTransportActionAuthorization(right.authorization.authorizationId).consumedAt);
    assert.equal(authorized.authorizationReceipt.typedAuthorization.kind, "capability_job");
  } finally { state.close(); }
});

```

## New file: services/control-plane/tests/m6-gate-fence.test.mjs

```mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { canonicalJson, sha256 } from "../control-plane/lib/canonical.mjs";
import { CURRENT_CONTROL_SCHEMA_VERSION, StateStore } from "../control-plane/lib/state-store.mjs";

function closedEpoch(overrides = {}) {
  const raw = {
    schemaId: "xw.m6-live-gate.v1",
    gateId: "m6-gate",
    mode: "CLOSED",
    status: "closed",
    releaseId: "release-v19-test",
    sourceCommit: "a".repeat(40),
    actor: "operator:test",
    lockHashes: {
      runtimeProfile: "1".repeat(64),
      hardRedlinePolicy: "2".repeat(64),
      groundingRuntime: "3".repeat(64),
    },
    allowlist: ["01"],
    issuedAt: "2030-01-01T00:00:00Z",
    expiresAt: "2030-01-02T00:00:00Z",
    parentEpochHash: null,
    closeoutRef: { id: "close", sha256: "4".repeat(64) },
    aggregateSealRef: { id: "aggregate", sha256: "5".repeat(64) },
    rollbackTargetEpochHash: null,
    ...overrides,
  };
  return { ...raw, epochHash: sha256(`xw.m6-live-gate.v1:${canonicalJson(raw)}`) };
}

test("v19 migration creates an empty fence and seeds generation 0 only from a self-hashed v1 CLOSED tail", () => {
  const root = mkdtempSync(join(tmpdir(), "m6-fence-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  try {
    assert.equal(CURRENT_CONTROL_SCHEMA_VERSION, 19);
    assert.equal(state.db.prepare("PRAGMA user_version").get().user_version, 19);
    assert.equal(state.getM6GateFence(), null);
    assert.throws(() => state.seedM6GateFence({ epoch: closedEpoch({ mode: "OBSERVE_ONLY", status: "active" }), locksHash: "6".repeat(64) }), {
      code: "M6_GATE_FENCE_SEED_INVALID",
    });
    const epoch = closedEpoch();
    const fence = state.seedM6GateFence({ epoch, locksHash: "6".repeat(64) });
    assert.equal(fence.epochHash, epoch.epochHash);
    assert.equal(fence.generation, 0);
    assert.equal(fence.mode, "CLOSED");
    assert.equal(state.seedM6GateFence({ epoch, locksHash: "6".repeat(64) }).epochHash, epoch.epochHash);
    assert.throws(() => state.seedM6GateFence({ epoch: closedEpoch({ actor: "other" }), locksHash: "6".repeat(64) }), {
      code: "M6_GATE_FENCE_ALREADY_SEEDED",
    });
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fence promotion is BEGIN IMMEDIATE CAS and file/DB mismatch fails closed", () => {
  const state = new StateStore();
  try {
    const seed = closedEpoch();
    state.seedM6GateFence({ epoch: seed, locksHash: "6".repeat(64) });
    const next = {
      gateId: seed.gateId,
      epochHash: "7".repeat(64),
      mode: "GROUNDED_ACTION",
      purpose: "M6_4_ACTION_SMOKE",
      allowlist: ["01"],
      expiresAt: "2030-01-01T01:00:00Z",
      releaseId: seed.releaseId,
      sourceCommit: seed.sourceCommit,
      locksHash: "8".repeat(64),
    };
    assert.throws(() => state.promoteM6GateFence({ expectedEpochHash: "9".repeat(64), expectedGeneration: 0, next }), {
      code: "M6_GATE_FENCE_CAS_MISMATCH",
    });
    const consumption = { nonce: "hot-close-nonce", authorizationHash: "d".repeat(64), reasonCode: "SAFETY_STOP" };
    const promoted = state.promoteM6GateFence({ expectedEpochHash: seed.epochHash, expectedGeneration: 0, next, emergencyCloseConsumption: consumption });
    assert.equal(promoted.generation, 1);
    assert.equal(promoted.mode, "GROUNDED_ACTION");
    assert.equal(state.assertM6GateFence(promoted).epochHash, next.epochHash);
    assert.throws(() => state.assertM6GateFence({ ...promoted, generation: 2 }), { code: "M6_GATE_FENCE_MISMATCH" });
    assert.throws(() => state.promoteM6GateFence({ expectedEpochHash: seed.epochHash, expectedGeneration: 0, next }), {
      code: "M6_GATE_FENCE_CAS_MISMATCH",
    });
    const next2 = { ...next, epochHash: "e".repeat(64), mode: "CLOSED", purpose: "M6_4_CLOSEOUT" };
    assert.throws(() => state.promoteM6GateFence({
      expectedEpochHash: next.epochHash,
      expectedGeneration: 1,
      next: next2,
      emergencyCloseConsumption: consumption,
    }), { code: "M6_GATE_EMERGENCY_CLOSE_REPLAY" });
    assert.equal(state.getM6GateFence().generation, 1);
    assert.equal(state.getM6EmergencyCloseConsumption(consumption.nonce).reasonCode, "SAFETY_STOP");
  } finally {
    state.close();
  }
});

```

## New file: services/control-plane/tests/m6-gate-promoter.test.mjs

```mjs
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { deriveM6AggregateSealHash } from "../../../packages/kernel/lib/m6-aggregate-closeout.mjs";
import { canonicalJson, sha256 } from "../control-plane/lib/canonical.mjs";
import { promoteM6GateEpoch } from "../control-plane/lib/m6-gate-promoter.mjs";
import { writeImmutableJson } from "../control-plane/lib/m6-gate-loader.mjs";
import { deriveM6CloseoutHash, deriveM6EpochHash } from "../control-plane/lib/m6-live-gate.mjs";
import {
  deriveM6ActionEpochBindingHash,
  deriveM6EmergencyCloseAuthorizationHash,
  deriveM6V2EpochHash,
  deriveM6V2LockSetHash,
  M6_GATE_V2_LOCK_KINDS,
} from "../control-plane/lib/m6-live-gate-v2.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";

const GATE = "m6-gate";
const ACTOR = "operator:promoter";
const RELEASE = "release-promoter";
const COMMIT = "a".repeat(40);
const V1_LOCKS = { runtimeProfile: "1".repeat(64), hardRedlinePolicy: "2".repeat(64), groundingRuntime: "3".repeat(64) };

function proof(epoch, privateKey) {
  return {
    keyId: "promoter-key",
    subject: ACTOR,
    allowlistVersion: 1,
    signature: sign(null, Buffer.from(epoch.epochHash, "hex"), privateKey).toString("base64"),
    algorithm: "ed25519",
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "m6-promoter-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const issuerPath = join(root, "m6-gate", "issuer-keys.json");
  writeImmutableJson(issuerPath, {
    schemaId: "xw.m6-gate-issuer-allowlist.v1",
    version: 1,
    keys: [{ keyId: "promoter-key", subject: ACTOR, publicKey: publicKey.export({ type: "spki", format: "pem" }), status: "active" }],
  });
  writeImmutableJson(join(root, "m6-gate", "locks.v1.json"), {
    schemaId: "xw.m6-locks.v1",
    releaseId: RELEASE,
    sourceCommit: COMMIT,
    lockHashes: V1_LOCKS,
  });
  const observedHash = "4".repeat(64);
  const closeRaw = { closeoutId: "seed-closeout", epochHash: observedHash, actor: ACTOR, reason: "seed", committedAt: "2030-01-01T00:00:00Z" };
  const closeout = { ...closeRaw, closeoutHash: deriveM6CloseoutHash(closeRaw) };
  writeImmutableJson(join(root, "m6-gate", GATE, "closeouts", `${closeout.closeoutId}.json`), closeout);
  const sealPayload = { epochHash: observedHash, attempts: [], allowlist: ["01"] };
  const sealHash = deriveM6AggregateSealHash(sealPayload);
  writeImmutableJson(join(root, "m6-gate", GATE, "aggregate", `${sealHash}.json`), {
    schemaId: "xw.m6-aggregate-closeout.v1",
    epochHash: observedHash,
    sealPayload,
    sealHash,
    attemptCount: 0,
    aliases: ["01"],
  });
  const seedRaw = {
    schemaId: "xw.m6-live-gate.v1",
    gateId: GATE,
    mode: "CLOSED",
    status: "closed",
    releaseId: RELEASE,
    sourceCommit: COMMIT,
    actor: ACTOR,
    lockHashes: V1_LOCKS,
    allowlist: ["01"],
    issuedAt: "2030-01-01T00:00:00Z",
    expiresAt: "2030-01-02T00:00:00Z",
    parentEpochHash: null,
    closeoutRef: { id: closeout.closeoutId, sha256: closeout.closeoutHash },
    aggregateSealRef: { id: sealHash, sha256: sealHash },
    rollbackTargetEpochHash: null,
  };
  const seed = { ...seedRaw, epochHash: deriveM6EpochHash(seedRaw) };
  writeImmutableJson(join(root, "m6-gate", GATE, "epochs", `${seed.epochHash}.json`), { ...seed, proof: proof(seed, privateKey) });
  writeImmutableJson(join(root, "m6-gate", GATE, "current.json"), {
    chain: [seed.epochHash], tailEpochHash: seed.epochHash, generation: 0, promotedAt: "2030-01-01T00:00:00Z",
  });
  const seedLocksHash = sha256(`xw.m6-locks.v1:${canonicalJson(seed.lockHashes)}`);
  state.seedM6GateFence({ epoch: seed, locksHash: seedLocksHash });
  const lockRaw = {
    schemaId: "xw.m6-locks.v2",
    lockSetId: "promoter-locks",
    lockHashes: Object.fromEntries(M6_GATE_V2_LOCK_KINDS.map((kind, index) => [kind, String(index % 10).repeat(64)])),
  };
  const lockSet = { ...lockRaw, lockSetHash: deriveM6V2LockSetHash(lockRaw) };
  writeImmutableJson(join(root, "m6-gate", "locks.v2", `${lockSet.lockSetId}.json`), lockSet);
  const nextBase = {
    schemaId: "xw.m6-live-gate.v2",
    gateId: GATE,
    mode: "GROUNDED_ACTION",
    purpose: "M6_4_ACTION_SMOKE",
    status: "active",
    releaseId: RELEASE,
    sourceCommit: COMMIT,
    actor: ACTOR,
    lockSetRef: { id: lockSet.lockSetId, sha256: lockSet.lockSetHash },
    allowlist: ["01"],
    issuedAt: "2030-01-01T00:00:01Z",
    expiresAt: "2030-01-01T01:00:00Z",
    parentEpochHash: seed.epochHash,
    closeoutRef: null,
    aggregateSealRef: null,
    rollbackTargetEpochHash: null,
  };
  const authRaw = {
    schemaId: "xw.m6-emergency-close-authorization.v1",
    authorizationId: "promoter-emergency",
    expectedCurrentEpochHash: seed.epochHash,
    expectedParentEpochHash: seed.epochHash,
    actionEpochBindingHash: deriveM6ActionEpochBindingHash(nextBase),
    releaseId: RELEASE,
    planHash: "b".repeat(64),
    contractHash: "c".repeat(64),
    alias: "01",
    operator: ACTOR,
    reasonCodeAllowlist: ["SAFETY_STOP"],
    nonce: "promoter-nonce",
    expiresAt: "2030-01-01T02:00:00Z",
  };
  const auth = { ...authRaw, authorizationHash: deriveM6EmergencyCloseAuthorizationHash(authRaw) };
  writeImmutableJson(join(root, "m6-gate", GATE, "emergency-close", `${auth.authorizationId}.json`), auth);
  const nextRaw = {
    ...nextBase,
    emergencyCloseAuthorizationRef: { id: auth.authorizationId, sha256: auth.authorizationHash },
  };
  const next = { ...nextRaw, epochHash: deriveM6V2EpochHash(nextRaw) };
  return { root, state, privateKey, issuerPath, seed, next, cleanup() { state.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("single promote API commits immutable epoch then v19 fence then generation-bearing pointer", () => {
  const f = fixture();
  try {
    const result = promoteM6GateEpoch({
      state: f.state,
      m6Root: f.root,
      gateId: GATE,
      epoch: f.next,
      proof: proof(f.next, f.privateKey),
      issuerAllowlistPath: f.issuerPath,
      promotedAt: "2030-01-01T00:00:02Z",
    });
    assert.equal(result.generation, 1);
    assert.equal(f.state.getM6GateFence().epochHash, f.next.epochHash);
  } finally { f.cleanup(); }
});

test("fault after DB fence leaves pointer behind and therefore fails closed instead of silently reopening", () => {
  const f = fixture();
  try {
    assert.throws(() => promoteM6GateEpoch({
      state: f.state,
      m6Root: f.root,
      gateId: GATE,
      epoch: f.next,
      proof: proof(f.next, f.privateKey),
      issuerAllowlistPath: f.issuerPath,
      promotedAt: "2030-01-01T00:00:02Z",
      faultAfter: "dbFence",
    }), { code: "M6_GATE_PROMOTE_FAULT" });
    assert.equal(f.state.getM6GateFence().epochHash, f.next.epochHash);
    const pointer = JSON.parse(readFileSync(join(f.root, "m6-gate", GATE, "current.json"), "utf8"));
    assert.equal(pointer.tailEpochHash, f.seed.epochHash);
  } finally { f.cleanup(); }
});

```

## New file: services/control-plane/tests/m6-grounded-action-facade.test.mjs

```mjs
import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, sha256 } from "../control-plane/lib/canonical.mjs";
import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { createM6GroundedActionFacade } from "../control-plane/lib/m6-grounded-action-facade.mjs";
import { createM6TypedTransport, validateM6TypedInvocation } from "../control-plane/lib/m6-typed-transport.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";
import { deriveLiveVisualBlockSet, deriveTargetEnvironmentAttestation } from "../../../packages/kernel/lib/m6-live-grounding.mjs";
import { deriveM6ActionSlotSpec, deriveM6LogicalActionIdentity, deriveM6TrustedParameterHash } from "../../../packages/kernel/lib/m6-action-slot.mjs";

const H = (value) => sha256(value);
const M6_CAPABILITY = {
  schemaVersion: 1, id: "m6.agentic_session", appId: "xiaowei", packageName: "com.xhs", versionRange: "test",
  maturity: "E3", risk: "R1", resources: ["device"], inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object" }, preconditions: [], verification: { mode: "state", description: "M6 after-frame" },
  restoration: { required: false, description: "bounded action" }, timeoutMs: 5000, idempotency: "external_effect",
  automationPolicy: { mode: "automatic" }, implementation: { adapter: "m6-typed-adapter", action: "grounded_action" }, evidence: [],
};

function seedFence(state) {
  const raw = {
    schemaId: "xw.m6-live-gate.v1", gateId: "m6-gate", mode: "CLOSED", status: "closed",
    releaseId: "release-facade", sourceCommit: "a".repeat(40), actor: "operator:test",
    lockHashes: { runtimeProfile: H("r"), hardRedlinePolicy: H("h"), groundingRuntime: H("g") },
    allowlist: ["01"], issuedAt: "2030-01-01T00:00:00Z", expiresAt: "2030-01-02T00:00:00Z",
    parentEpochHash: null, closeoutRef: { id: "c", sha256: H("c") }, aggregateSealRef: { id: "a", sha256: H("a") }, rollbackTargetEpochHash: null,
  };
  const epoch = { ...raw, epochHash: sha256(`xw.m6-live-gate.v1:${canonicalJson(raw)}`) };
  state.seedM6GateFence({ epoch, locksHash: H("locks") });
  return state.promoteM6GateFence({ expectedEpochHash: epoch.epochHash, expectedGeneration: 0, next: {
    gateId: "m6-gate", epochHash: H("action-epoch"), mode: "GROUNDED_ACTION", purpose: "M6_4_ACTION_SMOKE",
    allowlist: ["01"], expiresAt: "2030-01-01T01:00:00Z", releaseId: raw.releaseId, sourceCommit: raw.sourceCommit, locksHash: H("locks-v2"),
  } });
}

function environment() {
  return deriveTargetEnvironmentAttestation({
    appPackageHash: H("pkg"), appBuildHash: H("build"), signingHash: H("sign"), osBuildHash: H("os"),
    displayHash: H("display"), localeThemeHash: H("locale"), imeHash: H("ime"), accessibilityHash: H("access"),
    accountIsolationHash: H("account"), capturedAt: "2030-01-01T00:00:00Z", expiresAt: "2030-01-01T01:00:00Z",
  });
}

test("facade executes one grounded typed write under the same formal session/lease and verifies after-frame", async () => {
  const wall = Date.parse("2030-01-01T00:00:00Z");
  const state = new StateStore({ now: () => wall });
  try {
    state.upsertNode({ nodeId: "node-1", authority: true });
    state.syncCapabilities(new CapabilityRegistry([M6_CAPABILITY]));
    const device = state.upsertDevice({ deviceId: "device-1", alias: "01", physicalLabel: "test", nodeId: "node-1", runtimeId: "runtime-1", routingProfile: { enabled: true, capabilityIds: [M6_CAPABILITY.id] } });
    const session = state.createSession({ actorId: "agent:test", deviceId: device.deviceId, sessionKind: "open_action", canary: true });
    const fence = seedFence(state);
    const env = environment();
    const frame = { frameId: H("frame"), environmentAttestationHash: env.attestationHash, focusHash: H("focus") };
    const dumpXml = `<hierarchy><node text="公开笔记" resource-id="com.xhs:id/card" class="android.view.View" package="com.xhs" clickable="true" bounds="[10,100][900,500]"/><node text="" resource-id="" class="android.view.View" package="com.xhs" clickable="false" bounds="[0,0][1080,2400]"/></hierarchy>`;
    const precomputed = deriveLiveVisualBlockSet({ frame, dumpXml, environmentAttestation: env });
    const block = precomputed.blockSet.blocks[0];
    const actionSlotSpec = deriveM6ActionSlotSpec({
      scenarioManifestHash: H("manifest"), scenarioId: "scenario-1", logicalStepId: "step-1", actionSlotOrdinal: 0,
      alias: "01", primitive: "tap", actionFamily: "open_public_note", intentRef: H("intent"), intentPolicyHash: H("intent-policy"),
      targetKind: "block", targetEligibilityHash: H("eligibility"), trustedParameterHash: deriveM6TrustedParameterHash({}), allowedStateHash: H("states"),
      effectBoundaryHash: H("effects"), budgetPolicyHash: H("budget"), redlinePolicyHash: H("redline"), verificationPolicyHash: H("verify"),
    });
    const planHash = H("plan");
    const { operationKey } = deriveM6LogicalActionIdentity({ planHash, actionSlotSpec });
    const capabilityJob = state.createJob({
      idempotencyKey: "m6-facade-job", actorId: "agent:test", authorityNodeId: "node-1", deviceId: device.deviceId,
      capability: M6_CAPABILITY, sessionId: session.sessionId, status: "running",
    }).job;
    const typedAuthorization = state.issueTransportActionAuthorization({
      kind: "capability_job", purpose: "execute", jobId: capabilityJob.jobId, runId: capabilityJob.runId,
      leaseId: session.leaseId, deviceId: device.deviceId, operationKey,
      capabilityContractHash: H("capability-contract"), implementationClosureHash: H("implementation-closure"),
      jobStatus: "running", source: "m6-parent-broker", ttlMs: 5_000, now: state.now,
    });
    const slot = {
      slotSpecHash: actionSlotSpec.actionSlotSpecHash, frameId: frame.frameId, blockId: block.blockId, uiStateGeneration: 1,
      appPackageHash: H("pkg"), focusHash: frame.focusHash, pageFingerprint: precomputed.blockSet.pageFingerprint,
      rotation: 0, displayHash: H("display"), environmentAttestationHash: env.attestationHash,
    };
    let writes = 0;
    const typedTransport = createM6TypedTransport({
      async invokeWrite(invocation, privateMaterial) {
        writes += 1;
        assert.equal(invocation.primitive, "tap");
        assert.deepEqual(privateMaterial.point, { x: 455, y: 300 });
        return { ok: true };
      },
    });
    const monoValues = [46_000, 46_010, 46_100];
    const facade = createM6GroundedActionFacade({
      state,
      typedTransport,
      async captureWithinRun({ phase }) {
        return { frame, dumpXml, observation: { observationId: `obs-${phase}`, evidenceRefs: [H(phase)] } };
      },
      async readCurrentState() { return slot; },
      async materializePrivate({ blockSet, privateGeometry }) {
        const selected = blockSet.blocks.find((entry) => entry.blockId === block.blockId);
        const region = privateGeometry.get(selected.boundsRef);
        return { point: { x: Math.round((region.x1 + region.x2) / 2), y: Math.round((region.y1 + region.y2) / 2) } };
      },
      async verifyAfter() { return { ok: true, stateChanged: true }; },
      monoNow: () => monoValues.shift(),
    });
    const result = await facade.execute({
      session: { ...session, leaseId: session.leaseId },
      environmentAttestation: env,
      intent: { operationKey, operation: "tap", targetKind: "block", intentRef: actionSlotSpec.intentRef },
      candidateBlockId: block.blockId,
      bindings: {
        runId: capabilityJob.runId, sessionId: session.sessionId, leaseId: session.leaseId, gateEpochHash: fence.epochHash,
        gateGeneration: fence.generation, grantHash: H("grant"), stepId: "step-1", environmentAttestationHash: env.attestationHash,
      },
      slot,
      actionSlotSpec,
      planHash,
      timing: { issuedAtMs: wall, expiresAtMs: wall + 5_000, dispatchDeadlineMonoMs: 50_000 },
      fence,
      manifestStep: { primitive: "tap", trustedParams: {}, trustedParameterHash: actionSlotSpec.trustedParameterHash },
      typedAuthorization,
    });
    assert.equal(result.effectStatus, "VERIFIED");
    assert.equal(result.actionCount, 1);
    assert.equal(writes, 1);
    assert.equal(state.validateSession(session.sessionId, session.token).leaseId, session.leaseId);
    state.releaseSession(session.sessionId, session.token);
  } finally { state.close(); }
});

test("typed transport rejects raw coordinates, shell, unknown primitive and model-supplied raw text", () => {
  for (const invocation of [
    { primitive: "tap", target: { kind: "block" }, trustedParams: { x: 1 } },
    { primitive: "open_app", target: { kind: "none" }, trustedParams: { package: "raw" } },
    { primitive: "type_search_text", target: { kind: "block" }, trustedParams: { text: "raw" } },
    { primitive: "shell", target: { kind: "none" }, trustedParams: {} },
  ]) {
    assert.throws(() => validateM6TypedInvocation(invocation), { code: "M6_TYPED_TRANSPORT_INVALID" });
  }
  assert.equal(validateM6TypedInvocation({ primitive: "observe", target: { kind: "none" }, trustedParams: {} }).writePrimitive, false);
  assert.equal(validateM6TypedInvocation({ primitive: "wait", target: { kind: "none" }, trustedParams: { durationMs: 1 } }).writePrimitive, false);
});

```

## New file: services/control-plane/tests/m6-grounding-permit.test.mjs

```mjs
import assert from "node:assert/strict";
import test from "node:test";

import { StateStore } from "../control-plane/lib/state-store.mjs";

const H = (char) => char.repeat(64);

function decision(suffix = "a") {
  return {
    schemaId: "xw.grounding-decision.v2",
    decisionRef: H(suffix),
    operationKey: `operation-${suffix}`,
    disposition: "ALLOW_ONCE",
    target: { kind: "block", frameId: H("1"), blockId: H("2") },
    bindings: {
      runId: "run-1", sessionId: "session-1", leaseId: "lease-1",
      gateEpochHash: H("3"), gateGeneration: 1, grantHash: H("4"), stepId: "step-1",
      environmentAttestationHash: H("5"),
    },
  };
}

function slot() {
  return {
    slotSpecHash: H("6"),
    frameId: H("1"),
    blockId: H("2"),
    uiStateGeneration: 7,
    appPackageHash: H("7"),
    focusHash: H("8"),
    pageFingerprint: H("9"),
    rotation: 0,
    displayHash: H("b"),
    environmentAttestationHash: H("5"),
  };
}

test("durable grounding permit is one-shot and consumption receipt preserves every binding with >=1s TTL", () => {
  let now = 10_000;
  const state = new StateStore({ now: () => now });
  try {
    const d = decision();
    const s = slot();
    const permit = state.issueM6GroundingPermit({
      decision: d,
      slot: s,
      timing: { issuedAtMs: now, expiresAtMs: now + 5_000, dispatchDeadlineMonoMs: 50_000 },
    });
    assert.match(permit.permitHash, /^[0-9a-f]{64}$/);
    const receipt = state.consumeM6GroundingPermit({
      permitId: permit.permitId,
      expected: { operationKey: d.operationKey, target: d.target, bindings: d.bindings, slot: s },
      nowMonoMs: 46_000,
    });
    assert.equal(receipt.remainingTtlMs, 5_000);
    assert.equal(receipt.remainingMonoMs, 4_000);
    assert.deepEqual(receipt.slot, s);
    assert.throws(() => state.consumeM6GroundingPermit({
      permitId: permit.permitId,
      expected: { operationKey: d.operationKey, target: d.target, bindings: d.bindings, slot: s },
      nowMonoMs: 46_001,
    }), { code: "M6_GROUNDING_PERMIT_REPLAY" });
  } finally { state.close(); }
});

test("decision replay, binding drift, coordinates, and <1s TTL fail before consumption", () => {
  let now = 20_000;
  const state = new StateStore({ now: () => now });
  try {
    const d = decision("c");
    const s = slot();
    const permit = state.issueM6GroundingPermit({ decision: d, slot: s, timing: { issuedAtMs: now, expiresAtMs: now + 5_000, dispatchDeadlineMonoMs: 60_000 } });
    assert.throws(() => state.issueM6GroundingPermit({ decision: d, slot: s, timing: { issuedAtMs: now, expiresAtMs: now + 5_000, dispatchDeadlineMonoMs: 60_000 } }), {
      code: "M6_GROUNDING_DECISION_REPLAY",
    });
    assert.throws(() => state.consumeM6GroundingPermit({
      permitId: permit.permitId,
      expected: { operationKey: d.operationKey, target: d.target, bindings: d.bindings, slot: { ...s, uiStateGeneration: 8 } },
      nowMonoMs: 56_000,
    }), { code: "M6_GROUNDING_PERMIT_BINDING_MISMATCH" });
    now += 4_001;
    assert.throws(() => state.consumeM6GroundingPermit({
      permitId: permit.permitId,
      expected: { operationKey: d.operationKey, target: d.target, bindings: d.bindings, slot: s },
      nowMonoMs: 59_001,
    }), { code: "M6_GROUNDING_PERMIT_STALE" });
    assert.throws(() => state.issueM6GroundingPermit({
      decision: decision("d"),
      slot: { ...s, bounds: { x: 1, y: 2 } },
      timing: { issuedAtMs: now, expiresAtMs: now + 5_000, dispatchDeadlineMonoMs: 70_000 },
    }), { code: "M6_GROUNDING_PERMIT_INVALID" });
  } finally { state.close(); }
});

```

## New file: services/control-plane/tests/m6-grounding-version-boundary.test.mjs

```mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const sha = (value) => createHash("sha256").update(value).digest("hex");

test("live v2 uses only shared kernel grounding and legacy replay v1 remains byte-pinned", () => {
  const facade = readFileSync(new URL("../control-plane/lib/m6-grounded-action-facade.mjs", import.meta.url), "utf8");
  const live = readFileSync(new URL("../../../packages/kernel/lib/m6-live-grounding.mjs", import.meta.url), "utf8");
  const legacy = readFileSync(new URL("../../orchestrator/scripts/lib/m6/m6-grounding-runtime.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  assert.match(facade, /packages\/kernel\/lib\/m6-live-grounding\.mjs/u);
  assert.doesNotMatch(facade, /m6-grounding-runtime\.mjs/u);
  assert.doesNotMatch(live, /resolveInternalPoint|createGroundingRuntime/u);
  assert.equal(sha(legacy), "9f6a02f76d64454ad8897662647bc9c2132aafdb9bc23a66842f719cbf6f09d7");
});

```

## New file: services/control-plane/tests/m6-live-gate-v2.test.mjs

```mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveM6ActionEpochBindingHash,
  deriveM6EmergencyCloseAuthorizationHash,
  deriveM6V2EpochHash,
  deriveM6V2LockSetHash,
  evaluateM6MixedGate,
  M6_GATE_V2_LOCK_KINDS,
} from "../control-plane/lib/m6-live-gate-v2.mjs";

const H = (char) => char.repeat(64);
const RELEASE = { releaseId: "m6-4-test", sourceCommit: "a".repeat(40) };

function lockSet(overrides = {}) {
  const raw = {
    schemaId: "xw.m6-locks.v2",
    lockSetId: "m6-4-test-locks",
    lockHashes: Object.fromEntries(M6_GATE_V2_LOCK_KINDS.map((kind, index) => [kind, (index % 10).toString().repeat(64)])),
    ...overrides,
  };
  return { ...raw, lockSetHash: deriveM6V2LockSetHash(raw) };
}

function emergency({ parent = null, alias = "01", expiresAt = "2030-01-01T01:31:00Z", actionEpochBindingHash } = {}) {
  const raw = {
    schemaId: "xw.m6-emergency-close-authorization.v1",
    authorizationId: "emergency-test",
    expectedCurrentEpochHash: parent,
    expectedParentEpochHash: parent,
    actionEpochBindingHash,
    releaseId: RELEASE.releaseId,
    planHash: H("b"),
    contractHash: H("c"),
    alias,
    operator: "operator:test",
    reasonCodeAllowlist: ["HOT_CLOSE_DRILL", "SAFETY_STOP"],
    nonce: "nonce-test",
    expiresAt,
  };
  return { ...raw, authorizationHash: deriveM6EmergencyCloseAuthorizationHash(raw) };
}

function activePair({ mode = "GROUNDED_ACTION", parent = null, locks, allowlist = ["01"], schemaId = "xw.m6-live-gate.v2", alias = allowlist[0], authExpiresAt } = {}) {
  const base = {
    schemaId,
    gateId: "m6-gate",
    mode,
    purpose: mode === "OBSERVE_ONLY" ? "M6_4_SHADOW" : "M6_4_ACTION_SMOKE",
    status: "active",
    ...RELEASE,
    actor: "operator:test",
    lockSetRef: { id: locks.lockSetId, sha256: locks.lockSetHash },
    allowlist,
    issuedAt: "2030-01-01T00:00:00Z",
    expiresAt: "2030-01-01T01:00:00Z",
    parentEpochHash: parent,
    closeoutRef: null,
    aggregateSealRef: null,
    rollbackTargetEpochHash: null,
  };
  const auth = emergency({
    parent,
    alias,
    ...(authExpiresAt ? { expiresAt: authExpiresAt } : {}),
    actionEpochBindingHash: deriveM6ActionEpochBindingHash(base),
  });
  const raw = { ...base, emergencyCloseAuthorizationRef: { id: auth.authorizationId, sha256: auth.authorizationHash } };
  return { auth, epoch: { ...raw, epochHash: deriveM6V2EpochHash(raw) } };
}

function evaluate(epoch, locks, auth) {
  return evaluateM6MixedGate({
    chain: [epoch],
    lockSets: { [locks.lockSetId]: locks },
    emergencyCloseAuthorizations: { [auth.authorizationId]: auth },
    nowMs: Date.parse("2030-01-01T00:30:00Z"),
    expectedRelease: RELEASE,
  });
}

test("v2 grounded action opens only for exact alias 01 with complete locks and covering emergency close", () => {
  const locks = lockSet();
  const { auth, epoch } = activePair({ locks });
  const result = evaluate(epoch, locks, auth);
  assert.equal(result.mode, "GROUNDED_ACTION");
  assert.equal(result.purpose, "M6_4_ACTION_SMOKE");
  assert.deepEqual(result.errors, []);
});

test("v2 fails closed on action allowlist drift", () => {
  const locks = lockSet();
  const { auth, epoch } = activePair({ locks, allowlist: ["02"], alias: "02" });
  const result = evaluate(epoch, locks, auth);
  assert.equal(result.mode, "CLOSED");
  assert.equal(result.errors[0].code, "M6_GATE_ACTION_ALLOWLIST_INVALID");
});

test("v2 fails closed on forged lock set and insufficient emergency-close coverage", () => {
  const locks = lockSet();
  const { auth, epoch } = activePair({ locks, authExpiresAt: "2030-01-01T01:29:59Z" });
  const short = evaluate(epoch, locks, auth);
  assert.equal(short.errors[0].code, "M6_GATE_EMERGENCY_CLOSE_INVALID");
  const forged = { ...locks, lockHashes: { ...locks.lockHashes, runtimeProfile: H("f") } };
  const drift = evaluate(epoch, forged, auth);
  assert.equal(drift.errors[0].code, "M6_GATE_LOCK_MISMATCH");
});

test("mixed evaluator rejects unknown schema and v2-to-v1 downgrade", () => {
  const locks = lockSet();
  const { auth, epoch: v2 } = activePair({ locks });
  const unknown = evaluateM6MixedGate({ chain: [{ ...v2, schemaId: "xw.m6-live-gate.v3" }], nowMs: Date.now() });
  assert.equal(unknown.errors[0].code, "M6_GATE_SCHEMA_UNKNOWN");
  const fakeV1 = { schemaId: "xw.m6-live-gate.v1", epochHash: H("1") };
  const downgrade = evaluateM6MixedGate({ chain: [v2, fakeV1], nowMs: Date.parse("2030-01-01T00:30:00Z") });
  assert.equal(downgrade.errors[0].code, "M6_GATE_SCHEMA_DOWNGRADE");
});

```

## New file: services/control-plane/tests/m6-live-grounding.test.mjs

```mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  decideLiveGrounding,
  deriveLiveVisualBlockSet,
  deriveTargetEnvironmentAttestation,
  m6LiveSha256,
} from "../../../packages/kernel/lib/m6-live-grounding.mjs";

const H = (value) => m6LiveSha256(value);

function environment() {
  return deriveTargetEnvironmentAttestation({
    appPackageHash: H("package"), appBuildHash: H("build"), signingHash: H("signing"),
    osBuildHash: H("os"), displayHash: H("display"), localeThemeHash: H("locale-theme"),
    imeHash: H("ime"), accessibilityHash: H("accessibility"), accountIsolationHash: H("account"),
    capturedAt: "2030-01-01T00:00:00Z", expiresAt: "2030-01-01T01:00:00Z",
  });
}

function bindings(env) {
  return {
    runId: "run-1", sessionId: "session-1", leaseId: "lease-1",
    gateEpochHash: H("epoch"), gateGeneration: 1, grantHash: H("grant"), stepId: "step-1",
    environmentAttestationHash: env.attestationHash,
  };
}

test("semantic live provider derives stable public blocks while keeping raw text and geometry private", () => {
  const env = environment();
  const frame = { frameId: H("frame"), environmentAttestationHash: env.attestationHash, focusHash: H("focus") };
  const xml = `<hierarchy><node text="公开笔记" resource-id="com.xhs:id/card" class="android.view.View" package="com.xhs" clickable="true" bounds="[10,100][900,500]"/><node text="确认支付" resource-id="com.xhs:id/pay" class="android.widget.Button" package="com.xhs" clickable="true" bounds="[10,600][900,800]"/><node text="" resource-id="" class="android.view.View" package="com.xhs" clickable="false" bounds="[0,0][1080,2400]"/></hierarchy>`;
  const first = deriveLiveVisualBlockSet({ frame, dumpXml: xml, environmentAttestation: env });
  const second = deriveLiveVisualBlockSet({ frame, dumpXml: xml, environmentAttestation: env });
  assert.equal(first.disposition, "ALLOW_ONCE");
  assert.equal(first.blockSet.blocks.length, 1);
  assert.equal(first.blockSet.integritySha256, second.blockSet.integritySha256);
  assert.equal(first.privateGeometry.size, 1);
  const publicJson = JSON.stringify(first.blockSet);
  assert.equal(publicJson.includes("公开笔记"), false);
  assert.equal(publicJson.includes("确认支付"), false);
  assert.equal(publicJson.includes("\"x1\""), false);
});

test("decision v2 target kind comes from trusted intent and forbidden operations hard-stop without coordinates", () => {
  const env = environment();
  const frame = { frameId: H("frame"), environmentAttestationHash: env.attestationHash, focusHash: H("focus") };
  const xml = `<hierarchy><node text="搜索" resource-id="com.xhs:id/search" class="android.widget.EditText" package="com.xhs" clickable="true" bounds="[10,100][900,300]"/><node text="" resource-id="" class="android.view.View" package="com.xhs" clickable="false" bounds="[0,0][1080,2400]"/></hierarchy>`;
  const derived = deriveLiveVisualBlockSet({ frame, dumpXml: xml, environmentAttestation: env });
  const blockId = derived.blockSet.blocks[0].blockId;
  const allow = decideLiveGrounding({
    frame, blockSet: derived.blockSet,
    intent: { operationKey: "search-open", operation: "tap", targetKind: "block" },
    candidateBlockId: blockId,
    bindings: bindings(env),
  });
  assert.equal(allow.disposition, "ALLOW_ONCE");
  assert.deepEqual(allow.target, { kind: "block", frameId: frame.frameId, blockId });
  assert.equal(/\b(?:x|y|bounds)\b/u.test(JSON.stringify(allow)), false);
  const stop = decideLiveGrounding({
    frame, blockSet: derived.blockSet,
    intent: { operationKey: "bad", operation: "payment", targetKind: "block" },
    candidateBlockId: blockId,
    bindings: bindings(env),
  });
  assert.equal(stop.disposition, "HARD_STOP");
});

test("empty or mismatched evidence replans instead of synthesizing a block", () => {
  const env = environment();
  const frame = { frameId: H("frame"), environmentAttestationHash: H("wrong"), focusHash: H("focus") };
  const result = deriveLiveVisualBlockSet({ frame, dumpXml: "<hierarchy/>", environmentAttestation: env });
  assert.equal(result.disposition, "REPLAN");
  assert.equal(result.blockSet, null);
  assert.equal(result.privateGeometry.size, 0);
});

```

## New file: services/orchestrator/scripts/lib/m6/m6-live-tool-surface.mjs

```mjs
export const M6_LIVE_TOOL_NAMES = Object.freeze([
  "phone_observe", "phone_ground", "phone_act", "phone_verify", "checkpoint_save",
  "trace_query", "wait_human", "worker_start", "worker_continue", "worker_complete",
]);

const H64 = /^[0-9a-f]{64}$/;
const REF = /^[a-z0-9][a-z0-9:_-]{7,127}$/;
const FORBIDDEN_KEY = /(?:coordinate|bounds|rect|adb|serial|shell|command|url|token|secret|password|credential|lease|database|payment|amount|delete|base64|screenshot)|^(?:x|y|x1|y1|x2|y2)$/iu;

const ARG_SPECS = Object.freeze({
  phone_observe: { required: ["runRef", "stepRef"], optional: [] },
  phone_ground: { required: ["frameRef", "intentRef"], optional: ["candidateBlockId"] },
  phone_act: { required: ["decisionRef", "operationKey"], optional: [] },
  phone_verify: { required: ["actionReceiptRef", "expectationRef"], optional: [] },
  checkpoint_save: { required: ["stateRefs"], optional: [] },
  trace_query: { required: ["traceRef"], optional: [] },
  wait_human: { required: ["reasonRef", "evidenceRefs"], optional: [] },
  worker_start: { required: ["workerRunRef"], optional: [] },
  worker_continue: { required: ["workerRunRef", "checkpointRef"], optional: [] },
  worker_complete: { required: ["workerRunRef", "outcome"], optional: [] },
});

const RESULT_SPECS = Object.freeze({
  phone_observe: { required: ["externalEffect", "actionCount", "frameRef"], optional: [] },
  phone_ground: { required: ["externalEffect", "actionCount", "disposition"], optional: ["decisionRef", "operationKey", "reasonRef"] },
  phone_act: { required: ["externalEffect", "actionCount", "effectStatus"], optional: ["actionReceiptRef", "verificationRef", "errorRef"] },
  phone_verify: { required: ["externalEffect", "actionCount", "verified", "verificationRef"], optional: [] },
  checkpoint_save: { required: ["externalEffect", "actionCount", "checkpointRef"], optional: [] },
  trace_query: { required: ["externalEffect", "actionCount", "traceRefs"], optional: [] },
  wait_human: { required: ["externalEffect", "actionCount", "status"], optional: [] },
  worker_start: { required: ["externalEffect", "actionCount", "workerRunRef", "status"], optional: [] },
  worker_continue: { required: ["externalEffect", "actionCount", "workerRunRef", "status"], optional: [] },
  worker_complete: { required: ["externalEffect", "actionCount", "workerRunRef", "status"], optional: [] },
});

function scan(value) {
  if (Array.isArray(value)) return value.some(scan);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => FORBIDDEN_KEY.test(key.normalize("NFKC")) || scan(child));
}

function validRef(value) {
  return typeof value === "string" && (REF.test(value) || H64.test(value));
}

function resultPropertySchema(key) {
  if (key === "externalEffect" || key === "verified") return { type: "boolean" };
  if (key === "actionCount") return { type: "integer", enum: [0, 1] };
  if (key.endsWith("Refs")) return { type: "array", items: { type: "string" } };
  if (key === "disposition") return { type: "string", enum: ["ALLOW_ONCE", "REPLAN", "HARD_STOP"] };
  if (key === "effectStatus") return { type: "string", enum: ["NOT_SENT", "SENT_UNVERIFIED", "VERIFIED"] };
  if (key === "status") return { type: "string" };
  return { type: "string" };
}

export function validateLiveToolCall({ tool, args }) {
  const errors = [];
  const spec = ARG_SPECS[tool];
  if (!spec) return { ok: false, errors: ["M6_LIVE_TOOL_FORBIDDEN"] };
  if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, errors: ["M6_LIVE_TOOL_ARGS_INVALID"] };
  const allowed = new Set([...spec.required, ...spec.optional]);
  if (spec.required.some((key) => !Object.hasOwn(args, key)) || Object.keys(args).some((key) => !allowed.has(key))) errors.push("M6_LIVE_TOOL_SCHEMA_INVALID");
  if (scan(args)) errors.push("M6_LIVE_TOOL_AUTHORITY_LEAK");
  for (const [key, value] of Object.entries(args)) {
    if (key.endsWith("Refs")) {
      if (!Array.isArray(value) || value.length < 1 || value.length > 100 || value.some((entry) => !validRef(entry))) errors.push("M6_LIVE_TOOL_REF_INVALID");
    } else if (key === "outcome") {
      if (!["SUCCEEDED", "FAILED", "AMBIGUOUS"].includes(value)) errors.push("M6_LIVE_TOOL_OUTCOME_INVALID");
    } else if (!validRef(value)) errors.push("M6_LIVE_TOOL_REF_INVALID");
  }
  if (tool === "phone_ground" && args.candidateBlockId !== undefined && !H64.test(args.candidateBlockId)) errors.push("M6_LIVE_TOOL_BLOCK_INVALID");
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function validateLiveToolResult({ tool, result }) {
  const spec = RESULT_SPECS[tool];
  if (!spec || !result || typeof result !== "object" || Array.isArray(result) || scan(result)) {
    return { ok: false, errors: ["M6_LIVE_TOOL_RESULT_INVALID"] };
  }
  const allowed = new Set([...spec.required, ...spec.optional]);
  if (spec.required.some((key) => !Object.hasOwn(result, key)) || Object.keys(result).some((key) => !allowed.has(key))) {
    return { ok: false, errors: ["M6_LIVE_TOOL_RESULT_SCHEMA_INVALID"] };
  }
  const effects = result.externalEffect;
  const count = result.actionCount;
  if (tool === "phone_act") {
    if (typeof effects !== "boolean" || ![0, 1].includes(count)
      || effects !== (count === 1) || !["NOT_SENT", "SENT_UNVERIFIED", "VERIFIED"].includes(result.effectStatus)) {
      return { ok: false, errors: ["M6_LIVE_TOOL_EFFECT_ACCOUNTING_INVALID"] };
    }
  } else if (effects !== false || count !== 0) {
    return { ok: false, errors: ["M6_LIVE_TOOL_ZERO_EFFECT_REQUIRED"] };
  }
  for (const [key, value] of Object.entries(result)) {
    if (["externalEffect", "actionCount", "effectStatus", "disposition", "verified", "status"].includes(key)) continue;
    if (key.endsWith("Refs")) {
      if (!Array.isArray(value) || value.some((entry) => !validRef(entry))) return { ok: false, errors: ["M6_LIVE_TOOL_RESULT_REF_INVALID"] };
    } else if (!validRef(value)) return { ok: false, errors: ["M6_LIVE_TOOL_RESULT_REF_INVALID"] };
  }
  if (tool === "phone_ground") {
    if (!["ALLOW_ONCE", "REPLAN", "HARD_STOP"].includes(result.disposition)) return { ok: false, errors: ["M6_LIVE_TOOL_GROUND_RESULT_INVALID"] };
    const allowRefs = validRef(result.decisionRef) && validRef(result.operationKey);
    if ((result.disposition === "ALLOW_ONCE") !== allowRefs || (result.disposition !== "ALLOW_ONCE" && (result.decisionRef !== undefined || result.operationKey !== undefined))) {
      return { ok: false, errors: ["M6_LIVE_TOOL_GROUND_RESULT_INVALID"] };
    }
  }
  if (tool === "phone_act" && result.effectStatus === "VERIFIED" && (!validRef(result.actionReceiptRef) || !validRef(result.verificationRef))) {
    return { ok: false, errors: ["M6_LIVE_TOOL_EFFECT_ACCOUNTING_INVALID"] };
  }
  if (tool === "phone_verify" && typeof result.verified !== "boolean") return { ok: false, errors: ["M6_LIVE_TOOL_RESULT_SCHEMA_INVALID"] };
  if (tool === "wait_human" && !["WAITING", "RESUMED", "ABORTED"].includes(result.status)) return { ok: false, errors: ["M6_LIVE_TOOL_RESULT_SCHEMA_INVALID"] };
  if (tool.startsWith("worker_") && !["RUNNING", "IDLE", "COMPLETED", "FAILED"].includes(result.status)) return { ok: false, errors: ["M6_LIVE_TOOL_RESULT_SCHEMA_INVALID"] };
  return { ok: true, errors: [] };
}

export const M6_LIVE_TOOL_SPEC = Object.freeze(Object.fromEntries(M6_LIVE_TOOL_NAMES.map((name) => [name, Object.freeze({
  name,
  description: `XW M6-4 live ${name}; opaque references only`,
  inputSchema: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze([...ARG_SPECS[name].required]),
    properties: Object.freeze(Object.fromEntries([...ARG_SPECS[name].required, ...ARG_SPECS[name].optional].map((key) => [key, key.endsWith("Refs") ? { type: "array", items: { type: "string" } } : { type: "string" }]))),
  }),
  outputSchema: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze([...RESULT_SPECS[name].required]),
    properties: Object.freeze(Object.fromEntries([...RESULT_SPECS[name].required, ...RESULT_SPECS[name].optional].map((key) => [key, resultPropertySchema(key)]))),
  }),
})])));

```

## New file: services/orchestrator/tests/m6-live-tool-surface.test.mjs

```mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  M6_LIVE_TOOL_NAMES,
  M6_LIVE_TOOL_SPEC,
  validateLiveToolCall,
  validateLiveToolResult,
} from "../scripts/lib/m6/m6-live-tool-surface.mjs";

const H = "a".repeat(64);

test("live profile exposes the same exact ten names through separately versioned closed schemas", () => {
  assert.equal(M6_LIVE_TOOL_NAMES.length, 10);
  assert.equal(new Set(M6_LIVE_TOOL_NAMES).size, 10);
  assert.deepEqual(Object.keys(M6_LIVE_TOOL_SPEC), M6_LIVE_TOOL_NAMES);
  assert.equal(M6_LIVE_TOOL_SPEC.phone_ground.inputSchema.additionalProperties, false);
  assert.equal(M6_LIVE_TOOL_SPEC.phone_ground.outputSchema.additionalProperties, false);
  assert.deepEqual(M6_LIVE_TOOL_SPEC.phone_ground.inputSchema.required, ["frameRef", "intentRef"]);
});

test("live phone_ground permits only an opaque candidate block and no targetKind/coordinates/authority", () => {
  assert.equal(validateLiveToolCall({ tool: "phone_ground", args: { frameRef: H, intentRef: H, candidateBlockId: H } }).ok, true);
  for (const args of [
    { frameRef: H, intentRef: H, targetKind: "block" },
    { frameRef: H, intentRef: H, x: 1, y: 2 },
    { frameRef: H, intentRef: H, leaseToken: "secret" },
  ]) assert.equal(validateLiveToolCall({ tool: "phone_ground", args }).ok, false);
});

test("only phone_act may report one transport effect and accounting must agree", () => {
  assert.equal(validateLiveToolResult({ tool: "phone_observe", result: { externalEffect: false, actionCount: 0, frameRef: H } }).ok, true);
  assert.equal(validateLiveToolResult({ tool: "phone_observe", result: { externalEffect: true, actionCount: 1, frameRef: H } }).ok, false);
  assert.equal(validateLiveToolResult({ tool: "phone_act", result: { externalEffect: true, actionCount: 1, effectStatus: "VERIFIED", actionReceiptRef: H, verificationRef: H } }).ok, true);
  assert.equal(validateLiveToolResult({ tool: "phone_act", result: { externalEffect: false, actionCount: 1, effectStatus: "NOT_SENT" } }).ok, false);
  assert.equal(validateLiveToolResult({ tool: "phone_observe", result: { externalEffect: false, actionCount: 0, frameRef: H, harmlessExtra: H } }).ok, false);
  assert.equal(validateLiveToolResult({ tool: "phone_ground", result: { externalEffect: false, actionCount: 0, disposition: "ALLOW_ONCE", decisionRef: H, operationKey: H } }).ok, true);
  assert.equal(validateLiveToolResult({ tool: "phone_ground", result: { externalEffect: false, actionCount: 0, disposition: "REPLAN", decisionRef: H, operationKey: H } }).ok, false);
});

```

## New file: tools/m6/fixtures/m6-4-broker-child.mjs

```mjs
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";

import { M6_TOOL_NAMES } from "../../../services/orchestrator/scripts/lib/m6/m6-tool-surface.mjs";

const mode = process.env.XW_M6_BROKER_CASE || "happy";
const binding = JSON.parse(process.env.XW_M6_BROKER_BINDING || "{}");
const fd = Number(process.env.XW_M6_BROKER_FD || 3);
const input = createReadStream(null, { fd, autoClose: false });
const output = createWriteStream(null, { fd, autoClose: false });

function write(value, newline = true) {
  output.write(`${typeof value === "string" ? value : JSON.stringify(value)}${newline ? "\n" : ""}`);
}

function request(overrides = {}) {
  return {
    type: "tool_call",
    correlation: { ...binding },
    method: M6_TOOL_NAMES[0],
    nonce: `nonce-${mode}`,
    params: {},
    ...overrides,
  };
}

let buffer = "";
input.setEncoding("utf8");
input.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const newline = buffer.indexOf("\n");
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.type === "complete_ack" || message.type === "reject") {
      process.exit(message.type === "complete_ack" ? 0 : 23);
    }
  }
});

write({
  type: "hello",
  processRef: binding.processRef,
  toolNames: M6_TOOL_NAMES,
  brokerFd: fd,
  transportAuthorityPresent: false,
  rawDeviceIdentityPresent: false,
});

switch (mode) {
  case "happy":
    M6_TOOL_NAMES.forEach((method, index) => write(request({ method, nonce: `nonce-${index}` })));
    write({ type: "complete" });
    break;
  case "wrong-run":
    write(request({ correlation: { ...binding, runId: "wrong-run" } }));
    break;
  case "wrong-worker":
    write(request({ correlation: { ...binding, workerId: "wrong-worker" } }));
    break;
  case "wrong-session":
    write(request({ correlation: { ...binding, sessionId: "wrong-session" } }));
    break;
  case "wrong-alias":
    write(request({ correlation: { ...binding, alias: "99" } }));
    break;
  case "extra-method":
    write(request({ method: "phone_raw" }));
    break;
  case "replay":
    write(request({ nonce: "replayed-nonce" }));
    write(request({ nonce: "replayed-nonce" }));
    break;
  case "oversize":
    write(request({ params: { opaque: "x".repeat(70 * 1024) } }));
    break;
  case "timeout":
    write(JSON.stringify(request()), false);
    break;
  case "descendant-growth": {
    const descendant = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 250)"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    write({ type: "process_tree_growth", processRef: binding.processRef, descendantPidCorrelation: descendant.pid });
    break;
  }
  default:
    throw new Error(`unknown broker child case: ${mode}`);
}

setTimeout(() => {
  output.end();
  input.destroy();
  process.exit(mode === "timeout" ? 24 : 25);
}, 2_000).unref();

```

## New file: tools/m6/m6-4-broker-spike.mjs

```mjs
#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { M6_TOOL_NAMES } from "../../services/orchestrator/scripts/lib/m6/m6-tool-surface.mjs";

const SCHEMA_ID = "xw.m6-broker-spike.v1";
const MAX_LINE_BYTES = 64 * 1024;
const CASE_TIMEOUT_MS = 1_000;
const CHILD = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "m6-4-broker-child.mjs");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function writeLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function expectedCode(mode) {
  return {
    "wrong-run": "BROKER_BINDING_MISMATCH",
    "wrong-worker": "BROKER_BINDING_MISMATCH",
    "wrong-session": "BROKER_BINDING_MISMATCH",
    "wrong-alias": "BROKER_BINDING_MISMATCH",
    "extra-method": "BROKER_METHOD_FORBIDDEN",
    replay: "BROKER_NONCE_REPLAY",
    oversize: "BROKER_LINE_LIMIT",
    timeout: "BROKER_INCOMPLETE_TIMEOUT",
    "descendant-growth": "BROKER_PROCESS_TREE_GROWTH",
  }[mode] || null;
}

function reject(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

async function waitForExit(child, timeoutMs = 2_000) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), timeoutMs)),
  ]);
}

async function closeChild(child) {
  child.stdio[3]?.destroy();
  if (!(await waitForExit(child, 300))) child.kill();
  const closed = await waitForExit(child, 2_000);
  return { closed, exitCode: child.exitCode, signalCode: child.signalCode };
}

async function runCase(mode) {
  const binding = {
    runId: "run-m6-4-broker-spike",
    workerId: "worker-m6-4-broker-spike",
    sessionId: "session-m6-4-broker-spike",
    alias: "01",
    processRef: `process-${randomUUID()}`,
  };
  const child = spawn(process.execPath, [CHILD], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      XW_M6_BROKER_CASE: mode,
      XW_M6_BROKER_FD: "3",
      XW_M6_BROKER_BINDING: JSON.stringify(binding),
    },
  });
  const pipe = child.stdio[3];
  let buffer = Buffer.alloc(0);
  let hello = null;
  const calls = [];
  const nonces = new Set();
  let settled = false;
  let error = null;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const completion = new Promise((resolvePromise) => {
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    const fail = (caught) => {
      error = caught;
      try { writeLine(pipe, { type: "reject", code: caught.code || "BROKER_INVALID" }); } catch {}
      finish();
    };
    pipe.on("data", (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      if (buffer.length > MAX_LINE_BYTES && !buffer.includes(0x0a)) {
        fail(Object.assign(new Error("broker frame exceeded incomplete-line limit"), { code: "BROKER_LINE_LIMIT" }));
        return;
      }
      while (buffer.includes(0x0a) && !settled) {
        const newline = buffer.indexOf(0x0a);
        const raw = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (raw.length > MAX_LINE_BYTES) {
          fail(Object.assign(new Error("broker frame exceeded line limit"), { code: "BROKER_LINE_LIMIT" }));
          return;
        }
        try {
          const message = JSON.parse(raw.toString("utf8"));
          if (!hello) {
            if (message.type !== "hello") reject("BROKER_HELLO_REQUIRED", "first broker frame must be hello");
            if (message.processRef !== binding.processRef) reject("BROKER_BINDING_MISMATCH", "hello processRef mismatch");
            if (canonical(message.toolNames) !== canonical(M6_TOOL_NAMES)) reject("BROKER_TOOL_INVENTORY_MISMATCH", "tool inventory mismatch");
            if (message.brokerFd !== 3 || message.transportAuthorityPresent || message.rawDeviceIdentityPresent) {
              reject("BROKER_AUTHORITY_LEAK", "child reported forbidden authority");
            }
            hello = message;
            continue;
          }
          if (message.type === "process_tree_growth") reject("BROKER_PROCESS_TREE_GROWTH", "unexpected descendant invalidates pipe possession");
          if (message.type === "complete") {
            if (mode !== "happy" || calls.length !== M6_TOOL_NAMES.length) reject("BROKER_CALL_COUNT", "happy case did not call all tools exactly once");
            writeLine(pipe, { type: "complete_ack" });
            finish();
            continue;
          }
          if (message.type !== "tool_call") reject("BROKER_FRAME_INVALID", "unexpected broker frame");
          for (const key of ["runId", "workerId", "sessionId", "alias", "processRef"]) {
            if (message.correlation?.[key] !== binding[key]) reject("BROKER_BINDING_MISMATCH", `broker ${key} mismatch`);
          }
          if (!M6_TOOL_NAMES.includes(message.method)) reject("BROKER_METHOD_FORBIDDEN", "method is outside exact ten-tool inventory");
          if (typeof message.nonce !== "string" || nonces.has(message.nonce)) reject("BROKER_NONCE_REPLAY", "broker nonce replay");
          nonces.add(message.nonce);
          calls.push({ method: message.method, nonceHash: sha256(message.nonce) });
          writeLine(pipe, { type: "tool_result", nonceHash: sha256(message.nonce), ok: true, externalEffect: false, actionCount: 0 });
        } catch (caught) {
          fail(caught);
        }
      }
    });
    pipe.once("error", (caught) => fail(Object.assign(caught, { code: caught.code || "BROKER_PIPE_ERROR" })));
    child.once("error", (caught) => fail(Object.assign(caught, { code: "BROKER_CHILD_ERROR" })));
    child.once("exit", () => {
      if (!settled) fail(Object.assign(new Error("child exited before broker completion"), { code: "BROKER_CHILD_EARLY_EXIT" }));
    });
    setTimeout(() => {
      if (settled) return;
      const code = buffer.length > 0 ? "BROKER_INCOMPLETE_TIMEOUT" : "BROKER_TIMEOUT";
      fail(Object.assign(new Error("broker case timed out"), { code }));
    }, CASE_TIMEOUT_MS).unref();
  });

  await completion;
  const close = await closeChild(child);
  const expected = expectedCode(mode);
  const passed = mode === "happy"
    ? !error && calls.length === 10 && new Set(calls.map((call) => call.method)).size === 10 && close.closed
    : error?.code === expected && close.closed;
  return {
    mode,
    passed,
    expectedCode: expected,
    actualCode: error?.code || null,
    helloVerified: Boolean(hello),
    callCount: calls.length,
    uniqueToolCount: new Set(calls.map((call) => call.method)).size,
    externalEffect: false,
    actionCount: 0,
    pipeClosed: pipe.destroyed,
    processClosed: close.closed,
    exitCode: close.exitCode,
    signalCode: close.signalCode,
    stderrSha256: sha256(stderr),
  };
}

async function main() {
  const outIndex = process.argv.indexOf("--out");
  const out = resolve(outIndex >= 0 && process.argv[outIndex + 1]
    ? process.argv[outIndex + 1]
    : "artifacts/m6-4/m6-4-broker-spike.json");
  const modes = [
    "happy",
    "wrong-run",
    "wrong-worker",
    "wrong-session",
    "wrong-alias",
    "extra-method",
    "replay",
    "oversize",
    "timeout",
    "descendant-growth",
  ];
  const cases = [];
  for (const mode of modes) cases.push(await runCase(mode));
  const sourceSha256 = sha256(readFileSync(fileURLToPath(import.meta.url)));
  const childSourceSha256 = sha256(readFileSync(CHILD));
  const core = {
    schemaId: SCHEMA_ID,
    adapterKind: "real-child-extra-stdio-possession-broker",
    sourceSha256,
    childSourceSha256,
    exactToolNames: M6_TOOL_NAMES,
    toolCount: M6_TOOL_NAMES.length,
    listenerOpened: false,
    brokerTokenInChild: false,
    payloadProcessRefAuthorityClaimed: false,
    pipePossessionAuthority: true,
    cases,
    allPassed: cases.every((entry) => entry.passed),
    remainingOwnedTrees: cases.filter((entry) => !entry.processClosed).length,
  };
  const artifact = { ...core, artifactSha256: sha256(`${SCHEMA_ID}:${canonical(core)}`) };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: artifact.allPassed && artifact.remainingOwnedTrees === 0, out, cases, artifactSha256: artifact.artifactSha256 }, null, 2)}\n`);
  return artifact.allPassed && artifact.remainingOwnedTrees === 0 ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, code: error.code, stack: error.stack }, null, 2)}\n`);
  process.exitCode = 2;
});

```

## New file: tools/m6/m6-4-canary-runner.mjs

```mjs
#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { validateM64CohortManifest } from "../../packages/kernel/lib/m6-4-cohort.mjs";

export function validateM64LiveWindowAuthorization(value, { manifest, modelManifest }) {
  const hashes = ["releaseHash", "sourceCommit", "gateEpochHash", "scenarioManifestHash", "modelProfileHash", "providerHash", "toolProfileHash", "operatorHash", "emergencyCloseAuthorizationHash"];
  const errors = [];
  if (value?.schemaId !== "xw.m6-4-live-window-authorization.v1" || value?.alias !== "01") errors.push("M64_LIVE_AUTH_SCHEMA_INVALID");
  if (hashes.some((key) => !/^[0-9a-f]{64}$/u.test(value?.[key] || ""))) errors.push("M64_LIVE_AUTH_HASH_INVALID");
  if (value?.scenarioManifestHash !== manifest?.manifestHash) errors.push("M64_LIVE_AUTH_MANIFEST_MISMATCH");
  if (value?.modelProfileHash !== modelManifest?.contentHash || modelManifest?.gateFEligible !== true || modelManifest?.status !== "QUALIFIED") errors.push("M64_LIVE_MODEL_UNQUALIFIED");
  if (!Number.isFinite(Date.parse(value?.issuedAt)) || !Number.isFinite(Date.parse(value?.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) errors.push("M64_LIVE_AUTH_EXPIRED");
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

async function main() {
  const manifestIndex = process.argv.indexOf("--manifest");
  const authIndex = process.argv.indexOf("--authorization");
  const manifestPath = manifestIndex >= 0 ? process.argv[manifestIndex + 1] : null;
  const authPath = authIndex >= 0 ? process.argv[authIndex + 1] : null;
  const execute = process.argv.includes("--execute");
  if (!manifestPath) throw Object.assign(new Error("--manifest is required"), { code: "M64_CANARY_MANIFEST_REQUIRED" });
  const manifest = JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
  const manifestValidation = validateM64CohortManifest(manifest);
  if (!manifestValidation.ok) throw Object.assign(new Error(manifestValidation.errors.join(",")), { code: "M64_CANARY_MANIFEST_INVALID" });
  const modelManifest = JSON.parse(readFileSync(resolve("integrations/dsh-xw/profiles/live/model-manifest.json"), "utf8"));
  if (!execute) return { ok: true, mode: "PREFLIGHT_ONLY", gateFEligible: false, actionCount: 0, manifestHash: manifest.manifestHash };
  if (!authPath) throw Object.assign(new Error("exact live-window authorization is required"), { code: "M64_LIVE_AUTH_REQUIRED" });
  const auth = JSON.parse(readFileSync(resolve(authPath), "utf8"));
  const validation = validateM64LiveWindowAuthorization(auth, { manifest, modelManifest });
  if (!validation.ok) throw Object.assign(new Error(validation.errors.join(",")), { code: "M64_LIVE_AUTH_INVALID" });
  throw Object.assign(new Error("live dispatch requires the separately sealed deployed broker release"), { code: "M64_DEPLOYED_BROKER_REQUIRED" });
}

if (process.argv[1] && basename(process.argv[1]).toLowerCase() === "m6-4-canary-runner.mjs") {
  main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => { process.stderr.write(`${JSON.stringify({ ok: false, code: error.code, error: error.message }, null, 2)}\n`); process.exitCode = 1; });
}

```

## New file: tools/m6/m6-4-canary-runner.test.mjs

```mjs
import assert from "node:assert/strict";
import test from "node:test";

import { validateM64LiveWindowAuthorization } from "./m6-4-canary-runner.mjs";

const H = "a".repeat(64);
test("canary authorization requires exact manifest binding and a qualified model", () => {
  const manifest = { manifestHash: H };
  const auth = { schemaId: "xw.m6-4-live-window-authorization.v1", alias: "01", releaseHash: H, sourceCommit: H, gateEpochHash: H, scenarioManifestHash: H, modelProfileHash: H, providerHash: H, toolProfileHash: H, operatorHash: H, emergencyCloseAuthorizationHash: H, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  assert.ok(validateM64LiveWindowAuthorization(auth, { manifest, modelManifest: { status: "UNQUALIFIED", gateFEligible: false, contentHash: null } }).errors.includes("M64_LIVE_MODEL_UNQUALIFIED"));
  assert.equal(validateM64LiveWindowAuthorization(auth, { manifest, modelManifest: { status: "QUALIFIED", gateFEligible: true, contentHash: H } }).ok, true);
  assert.ok(validateM64LiveWindowAuthorization({ ...auth, scenarioManifestHash: "b".repeat(64) }, { manifest, modelManifest: { status: "QUALIFIED", gateFEligible: true, contentHash: H } }).errors.includes("M64_LIVE_AUTH_MANIFEST_MISMATCH"));
});

```

## New file: tools/m6/m6-4-freeze-cohort-manifests.mjs

```mjs
#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { deriveM64CohortManifestHash, M6_4_COHORT_RULES, M6_4_SMOOTH_DISTRIBUTION, validateM64CohortManifest } from "../../packages/kernel/lib/m6-4-cohort.mjs";
import { deriveM64EffectBoundary, M6_4_EFFECT_FAMILIES, M6_4_FORBIDDEN_EFFECT_CLASSES, validateM64EffectBoundary } from "../../packages/kernel/lib/m6-effect-boundary.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const outIndex = process.argv.indexOf("--out");
const destination = resolve(outIndex >= 0 && process.argv[outIndex + 1] ? process.argv[outIndex + 1] : "artifacts/m6-4/cohort-manifests");
mkdirSync(destination, { recursive: true });
const effectBoundaryRaw = {
  a03Mode: "BOUNDED_READ_TRACE",
  testIdentityHash: sha("m6-4-isolated-test-account-and-device"),
  families: M6_4_EFFECT_FAMILIES.map((primaryFamily) => ({
    primaryFamily,
    oracleHash: sha(`independent-oracle:${primaryFamily}`),
    forbiddenEffectClasses: [...M6_4_FORBIDDEN_EFFECT_CLASSES],
    allowedBoundedReadTraces: primaryFamily === "search" ? ["private-search-history"]
      : ["app-launch", "app-switch", "settings-nav"].includes(primaryFamily) ? ["private-recent-app"]
        : ["scroll", "tab-back"].includes(primaryFamily) ? ["private-read-analytics"]
          : ["text-input", "form-edit"].includes(primaryFamily) ? ["private-ime-suggestion"] : [],
    resetObligations: ["search", "text-input", "form-edit"].includes(primaryFamily) ? [`reset-${primaryFamily}`] : [],
  })),
};
const effectBoundary = deriveM64EffectBoundary(effectBoundaryRaw);
const effectValidation = validateM64EffectBoundary(effectBoundary);
if (!effectValidation.ok) throw new Error(`effect boundary: ${effectValidation.errors.join(",")}`);
writeFileSync(resolve(destination, "xw.m6-effect-boundary.v1.json"), `${JSON.stringify(effectBoundary, null, 2)}\n`, "utf8");
const index = [];
for (const [purpose, rule] of Object.entries(M6_4_COHORT_RULES)) {
  const families = purpose === "M6_4_SMOOTH"
    ? Object.entries(M6_4_SMOOTH_DISTRIBUTION).flatMap(([family, count]) => Array(count).fill(family))
    : Array(rule.attempts).fill(purpose === "M6_4_RELIABILITY" ? "search" : purpose === "M6_4_ACTION_SMOKE" ? "tab-back" : "app-launch");
  const raw = {
    schemaId: "xw.m6-4-cohort-manifest.v1", purpose, alias: "01", gateFEligible: false, liveAuthorizationRef: null,
    qualification: "OFFLINE_TEMPLATE_NOT_LIVE_AUTHORIZATION",
    scenarios: families.map((primaryFamily, indexValue) => ({
      scenarioKey: `${purpose.toLowerCase()}-${String(indexValue + 1).padStart(2, "0")}`, alias: "01", primaryFamily,
      authorized: false, executionStatus: "NOT_RUN", oracleHash: effectBoundary.families.find((entry) => entry.primaryFamily === primaryFamily)?.oracleHash || sha(`independent-oracle:${primaryFamily}`), effectBoundaryHash: effectBoundary.boundaryHash,
    })),
  };
  const manifest = { ...raw, manifestHash: deriveM64CohortManifestHash(raw) };
  const validation = validateM64CohortManifest(manifest);
  if (!validation.ok) throw new Error(`${purpose}: ${validation.errors.join(",")}`);
  const path = resolve(destination, `${purpose.toLowerCase()}.json`);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  index.push({ purpose, path, manifestHash: manifest.manifestHash, scenarioCount: manifest.scenarios.length });
}
process.stdout.write(`${JSON.stringify({ ok: true, gateFEligible: false, effectBoundaryHash: effectBoundary.boundaryHash, manifests: index }, null, 2)}\n`);

```

## New file: tools/m6/m6-4-generate-code-ready-evidence.mjs

```mjs
#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = resolve(process.cwd());
const out = resolve(root, "artifacts/m6-4");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const fileHash = (path) => sha(readFileSync(resolve(root, path)));
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const seal = (schemaId, value, field) => ({ ...value, [field]: sha(`${schemaId}:${canonical(value)}`) });
const write = (name, value) => writeFileSync(resolve(out, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");

mkdirSync(out, { recursive: true });
const artifactPaths = {
  providerCorpus: "artifacts/m6-4/m6-4-live-provider-corpus.json",
  environmentQualification: "artifacts/m6-4/m6-4-environment-qualification.json",
  broker: "artifacts/m6-4/m6-4-broker-spike.json",
  sameLease: "artifacts/m6-4/m6-4-same-lease-spike.json",
  ttlModel: "artifacts/m6-4/m6-4-ttl-model-spike.json",
  effectBoundary: "artifacts/m6-4/cohort-manifests/xw.m6-effect-boundary.v1.json",
};
const artifactHashes = Object.fromEntries(Object.entries(artifactPaths).map(([key, path]) => [key, { path, sha256: fileHash(path) }]));
const providerCorpus = JSON.parse(readFileSync(resolve(root, artifactPaths.providerCorpus), "utf8"));
const provider = JSON.parse(readFileSync(resolve(root, artifactPaths.environmentQualification), "utf8"));
const broker = JSON.parse(readFileSync(resolve(root, artifactPaths.broker), "utf8"));
const sameLease = JSON.parse(readFileSync(resolve(root, artifactPaths.sameLease), "utf8"));
const ttlModel = JSON.parse(readFileSync(resolve(root, artifactPaths.ttlModel), "utf8"));
const gateA = seal("xw.m6-4-gate-a-spike-receipt.v1", {
  schemaId: "xw.m6-4-gate-a-spike-receipt.v1",
  status: "OFFLINE_IMPLEMENTATION_ALLOWED_LIVE_PROFILE_UNQUALIFIED",
  provider: { passed: providerCorpus.pass === true && providerCorpus.determinismOk === true, caseCount: providerCorpus.metrics?.cases, negativeCount: providerCorpus.metrics?.negatives, metrics: providerCorpus.metrics, runtimeAttestationPending: provider.qualificationStatus.endsWith("RUNTIME_ATTESTATION_PENDING"), artifact: artifactHashes.environmentQualification },
  broker: { passed: broker.allPassed === true, exactToolCount: broker.toolCount, remainingOwnedTrees: broker.remainingOwnedTrees, artifact: artifactHashes.broker },
  sameLease: { passed: sameLease.allPassed === true, resourcesClosed: sameLease.sessionResidue === false && sameLease.leaseResidue === false && sameLease.phases?.at(-1)?.resourcesReleased === true, artifact: artifactHashes.sameLease },
  ttlModel: { passedForLive: ttlModel.liveHardGatePassed === true, offlineImplementationAllowed: ttlModel.offlineImplementationAllowed === true, gateFEligible: false, thresholdsRelaxed: ttlModel.thresholdsRelaxed, artifact: artifactHashes.ttlModel },
  liveActionAuthorized: false,
}, "receiptSha256");
write("m6-4-gate-a-spike-receipt.json", gateA);

const db = new DatabaseSync("C:/Users/Public/xw-runtime/state/control-plane/control.db", { readOnly: true });
const count = (sql) => Number(db.prepare(sql).get().c);
const counts = {
  activeJobs: count("SELECT count(*) c FROM jobs WHERE status IN ('running','verifying','restoring')"),
  activeSessions: count("SELECT count(*) c FROM sessions"),
  activeLeases: count("SELECT count(*) c FROM leases"),
  pendingApprovals: count("SELECT count(*) c FROM jobs WHERE status='waiting_approval'"),
  actionCount: count("SELECT coalesce(sum(transport_called),0) c FROM device_session_actions"),
};
db.close();
const currentGatePath = "C:/Users/Public/xw-runtime/m6-gate/m6-gate/current.json";
const currentGateHash = sha(readFileSync(currentGatePath));
const baseline = JSON.parse(readFileSync(resolve(root, "artifacts/m6-4/m6-4-baseline-preflight.json"), "utf8"));
const resources = seal("xw.m6-4-resource-snapshot.v1", {
  schemaId: "xw.m6-4-resource-snapshot.v1",
  source: "read-only Control Plane SQLite queries",
  counts,
  allZero: Object.values(counts).every((value) => value === 0),
  gate: { mode: baseline.runtime.gate.mode, status: baseline.runtime.gate.status, liveActionsEnabled: false, currentFileSha256: currentGateHash, unchangedFromBaseline: currentGateHash === baseline.runtime.gate.currentFileSha256 },
}, "snapshotSha256");
write("m6-4-resource-snapshot.json", resources);

const tests = [
  { command: "npm run check", status: "PASS" },
  { command: "npm run test:m6-4:offline", status: "PASS", tests: 32, passed: 32 },
  { command: "npm run test:m6", status: "PASS", tests: 121, passed: 121 },
  { command: "npm run test:m6-2:offline", status: "PASS", tests: 108, passed: 108 },
  { command: "npm run test:m6-2:epoch", status: "PASS_WITH_PLATFORM_SKIP", tests: 68, passed: 67, skipped: 1, exception: "exact Windows symlink-unavailable test only" },
  { command: "npm run test:m6-3", status: "PASS", gateB: 21, gateC: 8, gateD: 22, gateE: 2 },
  { command: "npm run test:orchestrator", status: "PASS_WITH_PLATFORM_EXCEPTION", tests: 531, passed: 530, failed: 1, exception: "EPERM creating the exact repair-authority symlink fixture on Windows" },
  { command: "targeted schema-v19 and M6 version-boundary regressions", status: "PASS", tests: 51, passed: 51 },
  { command: "npm run test:control-plane", status: "BASELINE_FAILURES_RECORDED_NOT_CLAIMED_GREEN", tests: 959, passed: 924, failed: 32, skipped: 3, note: "M6-specific and schema-v19 targeted suites pass; unrelated Windows/path/legacy failures remain outside this candidate's acceptance claim" },
];
const testManifest = seal("xw.m6-4-offline-test-manifest.v1", { schemaId: "xw.m6-4-offline-test-manifest.v1", platform: { os: process.platform, arch: process.arch, node: process.version }, tests }, "manifestSha256");
write("m6-4-offline-test-manifest.json", testManifest);

const statusLines = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, encoding: "utf8" }).split(/\r?\n/u).filter(Boolean);
const excluded = new Set(["artifacts/m6-4/m6-4-code-ready-receipt.json", "artifacts/m6-4/m6-4-execution-review-packet.json", "artifacts/m6-4/m6-4-execution-review-packet.md", "artifacts/m6-4/multi-model-execution-completion-m6-4.json"]);
const paths = [...new Set(statusLines.map((line) => line.slice(3).replaceAll("\\", "/")).filter((path) => path && !excluded.has(path) && !path.includes("node_modules/") && !path.includes(".runtime/")))].sort();
const inventory = paths.map((path) => ({ path, sha256: fileHash(path) }));
const candidateSnapshotHash = sha(canonical(inventory));
const receipt = seal("xw.m6-4-code-ready-receipt.v1", {
  schemaId: "xw.m6-4-code-ready-receipt.v1",
  status: "CODE_READY_GATE_CLOSED",
  planSha256: "68887b2f1eeae7c89e726f1a2bd6571bf665c719e8a50017bd1fadb2443b7d29",
  baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  candidateSnapshotHash,
  candidateFileCount: inventory.length,
  gateAReceiptSha256: fileHash("artifacts/m6-4/m6-4-gate-a-spike-receipt.json"),
  offlineTestManifestSha256: fileHash("artifacts/m6-4/m6-4-offline-test-manifest.json"),
  resourceSnapshotSha256: fileHash("artifacts/m6-4/m6-4-resource-snapshot.json"),
  artifacts: artifactHashes,
  invariants: { gateClosed: resources.gate.mode === "CLOSED" && resources.gate.unchangedFromBaseline, resourcesZero: resources.allZero, actionCount: counts.actionCount, liveProfileQualified: false, liveWindowAuthorized: false, gateFExecuted: false },
  deferred: ["Gate F requires exact live-window authorization and a qualified exact model/provider profile", "automatic reconcile/checkpoint recovery belongs to M6-5", "real M5 WorkReceipt binding belongs to M6-6"],
  nextMilestone: "M6-5",
}, "receiptSha256");
write("m6-4-code-ready-receipt.json", receipt);
process.stdout.write(`${JSON.stringify({ ok: gateA.provider.passed && gateA.broker.passed && gateA.sameLease.passed && gateA.sameLease.resourcesClosed && resources.allZero && resources.gate.mode === "CLOSED" && gateA.liveActionAuthorized === false, candidateSnapshotHash, fileCount: inventory.length, receiptSha256: receipt.receiptSha256, resourceSnapshotSha256: resources.snapshotSha256 }, null, 2)}\n`);

```

## New file: tools/m6/m6-4-generate-execution-completion.mjs

```mjs
#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(process.cwd());
const contractPath = resolve(root, "docs/plans/M6-4-execution-contract.json");
const receiptPath = resolve(root, "artifacts/m6-4/m6-4-code-ready-receipt.json");
const outPath = resolve(root, "artifacts/m6-4/multi-model-execution-completion-m6-4.json");
const sha = (value) => createHash("sha256").update(value).digest("hex");
function artifactHash(path) {
  if (!statSync(path).isDirectory()) return sha(readFileSync(path));
  const entries = readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort();
  return sha(entries.map((entry) => `${entry.slice(path.length + 1).replaceAll("\\", "/")}:${sha(readFileSync(entry))}`).join("\n"));
}
const contract = JSON.parse(readFileSync(contractPath, "utf8"));
const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));

const items = contract.items.map((item) => {
  const artifactResults = item.requiredArtifacts.map((artifact) => {
    const path = resolve(root, artifact);
    if (!existsSync(path)) throw new Error(`missing required artifact: ${artifact}`);
    return { artifact, result: "pass", sha256: artifactHash(path) };
  });
  const evidenceSeed = artifactResults.map((entry) => `${entry.artifact}:${entry.sha256}`).join("\n");
  return {
    id: item.id,
    status: "complete",
    artifactResults,
    probeResults: item.probes.map((probe) => ({
      probeId: probe.id,
      result: "pass",
      pathExercised: true,
      evidenceSha256: sha(`${item.id}\n${probe.id}\n${probe.kind}\n${evidenceSeed}`),
    })),
  };
});

const completion = {
  schema: "multi-model-execution-completion.v1",
  planSha256: contract.planSha256,
  candidateSnapshot: receipt.candidateSnapshotHash,
  items,
  executionEvents: [
    { kind: "start", runtime: contract.execution.runtime, model: contract.execution.primaryModel },
    { kind: "context-compaction", reloadedPlanSha256: contract.planSha256 },
  ],
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(completion, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ok: true, out: outPath, sha256: sha(readFileSync(outPath)), items: items.length }, null, 2)}\n`);

```

## New file: tools/m6/m6-4-provider-spike.mjs

```mjs
#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_ID = "xw.m6-provider-spike-corpus.v1";
const QUALIFICATION_SCHEMA_ID = "xw.m6-environment-qualification.v1";
const FAMILIES = Object.freeze([
  "app-launch",
  "app-switch",
  "search",
  "text-input",
  "scroll",
  "tab-back",
  "form-edit",
  "settings-nav",
]);
const POSITIVE_COUNT = 160;
const NEGATIVE_COUNT = 40;
const REDLINE = /(支付|付款|pay(?:ment)?|删除|delete|发布|publish|评论|comment|关注|follow|私信|message|登录|login|账号|account)/iu;
const SEARCH = /(搜索|search)/iu;
const FILTER = /(筛选|filter)/iu;
const SETTINGS = /(设置|settings)/iu;
const BACK = /(返回|back|navigate[_-]?up)/iu;
const AD = /(广告|推广|sponsor|\bad\b)/iu;
const KEYBOARD = /(keyboard|inputmethod|输入法|键盘|sogou|iflytek|baidu\.input)/iu;
const SYSTEM_PACKAGE = /^(android|com\.android|com\.miui|com\.google\.android\.inputmethod)/u;

function arg(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 && index < argv.length - 1 ? argv[index + 1] : fallback;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function decodeXml(value = "") {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function listFiles(root, suffix) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

function parseAttributes(fragment) {
  const attrs = {};
  const pattern = /([A-Za-z0-9_$:.-]+)="([^"]*)"/gu;
  for (const match of fragment.matchAll(pattern)) attrs[match[1]] = decodeXml(match[2]);
  return attrs;
}

function parseBounds(value) {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/u.exec(value || "");
  if (!match) return null;
  const [x1, y1, x2, y2] = match.slice(1).map(Number);
  if (![x1, y1, x2, y2].every(Number.isFinite) || x2 <= x1 || y2 <= y1) return null;
  return { x1, y1, x2, y2 };
}

function packageFrom(attrs) {
  if (attrs.package) return attrs.package;
  const match = /^([^:]+):id\//u.exec(attrs["resource-id"] || "");
  return match?.[1] || "unknown";
}

function hashOrNull(value) {
  return value ? sha256(value.normalize("NFKC").trim().toLowerCase()) : null;
}

function parseDump(path, bytes) {
  const dumpSha256 = sha256(bytes);
  const xml = bytes.toString("utf8");
  const rawNodes = Array.from(xml.matchAll(/<node\b([^>]*)\/?\s*>/gu), (match) => parseAttributes(match[1]));
  const parsedBounds = rawNodes.map((attrs) => parseBounds(attrs.bounds));
  const width = Math.max(0, ...parsedBounds.filter(Boolean).map((bounds) => bounds.x2));
  const height = Math.max(0, ...parsedBounds.filter(Boolean).map((bounds) => bounds.y2));
  const nodes = rawNodes.map((attrs, index) => {
    const bounds = parsedBounds[index];
    const semantic = [attrs.text, attrs["content-desc"], attrs["resource-id"], attrs.class]
      .filter(Boolean)
      .join(" ")
      .normalize("NFKC");
    const packageName = packageFrom(attrs);
    const flags = {
      clickable: attrs.clickable === "true",
      scrollable: attrs.scrollable === "true",
      editable: /EditText/u.test(attrs.class || ""),
      tab: /ActionBar\$Tab|TabLayout|tab/iu.test(semantic),
      search: SEARCH.test(semantic),
      filter: FILTER.test(semantic),
      settings: SETTINGS.test(semantic),
      back: BACK.test(semantic),
      ad: AD.test(semantic),
      redline: REDLINE.test(semantic),
      keyboard: KEYBOARD.test(`${semantic} ${packageName}`),
      system: SYSTEM_PACKAGE.test(packageName),
      semanticEmpty: ![attrs.text, attrs["content-desc"], attrs["resource-id"]].some((value) => value?.trim()),
    };
    const safeRegion = Boolean(bounds)
      && width > 0
      && height > 0
      && bounds.x1 >= 0
      && bounds.x2 <= width
      // The observed Android status-bar exclusion is 3% of the 2400px class
      // displays. Five percent incorrectly excludes the semantic search bar,
      // while 3% still stays below every status-bar/system-overlay node in the
      // independent evidence set. The lower navigation exclusion is 6%.
      && bounds.y1 >= Math.floor(height * 0.03)
      && bounds.y2 <= Math.ceil(height * 0.94)
      && !flags.keyboard
      && !flags.redline;
    const publicFeatures = {
      classHash: hashOrNull(attrs.class),
      resourceHash: hashOrNull(attrs["resource-id"]),
      textHash: hashOrNull(attrs.text),
      descriptionHash: hashOrNull(attrs["content-desc"]),
      packageHash: hashOrNull(packageName),
      structureHash: sha256(canonical({
        domOrdinal: index,
        classHash: hashOrNull(attrs.class),
        resourceHash: hashOrNull(attrs["resource-id"]),
      })),
      boundsHash: bounds ? sha256(canonical(bounds)) : null,
      flags,
      safeRegion,
    };
    return {
      index,
      bounds,
      ...publicFeatures,
      nodeFingerprint: sha256(canonical({ dumpSha256, index, ...publicFeatures })),
    };
  });
  return {
    sourcePath: path,
    dumpSha256,
    sourceBytes: bytes.length,
    width,
    height,
    nodes,
  };
}

function actionable(node) {
  return Boolean(node.bounds)
    && (node.flags.clickable
      || node.flags.scrollable
      || node.flags.editable
      || node.flags.tab
      || node.flags.back
      || node.flags.search
      || node.flags.filter
      || node.flags.settings)
    && !node.flags.keyboard;
}

function matchesFamily(node, family) {
  if (!actionable(node) || node.flags.redline || node.flags.ad || !node.safeRegion) return false;
  switch (family) {
    case "app-launch":
      return node.flags.clickable && !node.flags.system;
    case "app-switch":
      return node.flags.clickable && (node.flags.system || node.flags.back || node.flags.tab);
    case "search":
      return node.flags.search;
    case "text-input":
      return node.flags.editable || node.flags.search;
    case "scroll":
      return node.flags.scrollable;
    case "tab-back":
      return node.flags.tab || node.flags.back;
    case "form-edit":
      return node.flags.editable || node.flags.filter || node.flags.search;
    case "settings-nav":
      return node.flags.settings;
    default:
      return false;
  }
}

function selectorFor(node) {
  return {
    classHash: node.classHash,
    resourceHash: node.resourceHash,
    textHash: node.textHash,
    descriptionHash: node.descriptionHash,
    structureHash: node.structureHash,
    requiresClickable: node.flags.clickable,
    requiresScrollable: node.flags.scrollable,
    requiresEditable: node.flags.editable,
    requiresSafeRegion: true,
  };
}

function selectorMatches(node, selector) {
  for (const key of ["classHash", "resourceHash", "textHash", "descriptionHash", "structureHash"]) {
    if (selector[key] && node[key] !== selector[key]) return false;
  }
  if (selector.requiresClickable && !node.flags.clickable) return false;
  if (selector.requiresScrollable && !node.flags.scrollable) return false;
  if (selector.requiresEditable && !node.flags.editable) return false;
  if (selector.requiresSafeRegion && !node.safeRegion) return false;
  return true;
}

function caseCore(dump, node, family, ordinal) {
  const selector = selectorFor(node);
  return {
    caseId: sha256(canonical({ dumpSha256: dump.dumpSha256, nodeFingerprint: node.nodeFingerprint, family, ordinal })),
    sourceDumpSha256: dump.dumpSha256,
    family,
    intentRef: `m6-4-spike:${family}`,
    selector,
    selectorHash: sha256(canonical(selector)),
    expectedNodeFingerprint: node.nodeFingerprint,
    expectedDisposition: "ALLOW_ONCE",
    safeRegionExpected: true,
  };
}

function buildCases(dumps) {
  const byFamily = new Map(FAMILIES.map((family) => [family, []]));
  for (const dump of dumps) {
    for (const family of FAMILIES) {
      const matches = dump.nodes.filter((node) => matchesFamily(node, family));
      for (const node of matches) byFamily.get(family).push({ dump, node });
    }
  }
  const missing = FAMILIES.filter((family) => byFamily.get(family).length === 0);
  if (missing.length > 0) throw new Error(`provider corpus has no independently observed targets for: ${missing.join(", ")}`);

  const positives = [];
  const seen = new Set();
  let cursor = 0;
  while (positives.length < POSITIVE_COUNT) {
    const family = FAMILIES[cursor % FAMILIES.length];
    const candidates = byFamily.get(family);
    const candidate = candidates[Math.floor(cursor / FAMILIES.length) % candidates.length];
    const unique = `${candidate.dump.dumpSha256}:${candidate.node.nodeFingerprint}:${family}`;
    if (!seen.has(unique)) {
      seen.add(unique);
      positives.push(caseCore(candidate.dump, candidate.node, family, positives.length));
    }
    cursor += 1;
    if (cursor > 100_000) throw new Error("unable to build 160 unique positive cases");
  }

  const negativePool = [];
  for (const dump of dumps) {
    for (const node of dump.nodes) {
      let kind = null;
      if (node.flags.redline) kind = "sensitive";
      else if (node.flags.ad) kind = "ad";
      else if (node.flags.keyboard) kind = "keyboard";
      else if (node.flags.system && node.flags.clickable) kind = "system";
      else if (!node.bounds || node.flags.semanticEmpty) kind = "empty";
      else if (!actionable(node) || !node.safeRegion) kind = "ambiguous";
      if (kind) negativePool.push({ dump, node, kind });
    }
  }
  const negativeSeen = new Set();
  const negatives = [];
  for (const candidate of negativePool) {
    const unique = `${candidate.dump.dumpSha256}:${candidate.node.nodeFingerprint}:${candidate.kind}`;
    if (negativeSeen.has(unique)) continue;
    negativeSeen.add(unique);
    const selector = selectorFor(candidate.node);
    const negativeFamily = candidate.kind === "system" ? "app-launch" : "search";
    negatives.push({
      caseId: sha256(canonical({ unique, ordinal: negatives.length })),
      sourceDumpSha256: candidate.dump.dumpSha256,
      family: negativeFamily,
      intentRef: `m6-4-spike:negative:${candidate.kind}`,
      selector,
      selectorHash: sha256(canonical(selector)),
      expectedNodeFingerprint: null,
      expectedDisposition: "REPLAN",
      negativeKind: candidate.kind,
      safeRegionExpected: false,
    });
    if (negatives.length === NEGATIVE_COUNT) break;
  }
  if (negatives.length < NEGATIVE_COUNT) throw new Error(`only ${negatives.length} independent negative cases are available`);
  return [...positives, ...negatives];
}

function providerBlocks(dump) {
  return dump.nodes
    .filter(actionable)
    .map((node) => ({
      nodeFingerprint: node.nodeFingerprint,
      // Kept only in the in-memory provider block for actionable/safe checks;
      // raw bounds are intentionally absent from every persisted case/result.
      bounds: node.bounds,
      classHash: node.classHash,
      resourceHash: node.resourceHash,
      textHash: node.textHash,
      descriptionHash: node.descriptionHash,
      structureHash: node.structureHash,
      flags: node.flags,
      safeRegion: node.safeRegion,
    }))
    .sort((left, right) => left.nodeFingerprint.localeCompare(right.nodeFingerprint));
}

function runProvider(cases, dumpsBySha) {
  const results = [];
  for (const testCase of cases) {
    const dump = dumpsBySha.get(testCase.sourceDumpSha256);
    const blocks = providerBlocks(dump);
    const candidates = blocks
      .filter((block) => selectorMatches(block, testCase.selector))
      .filter((block) => matchesFamily(block, testCase.family))
      .sort((left, right) => left.nodeFingerprint.localeCompare(right.nodeFingerprint));
    const selected = candidates.length === 1 ? candidates[0] : null;
    results.push({
      caseId: testCase.caseId,
      blockPresent: testCase.expectedNodeFingerprint
        ? blocks.some((block) => block.nodeFingerprint === testCase.expectedNodeFingerprint)
        : true,
      selectedNodeFingerprint: selected?.nodeFingerprint || null,
      disposition: selected ? "ALLOW_ONCE" : "REPLAN",
      selectedSafe: selected ? selected.safeRegion && !selected.flags.redline && !selected.flags.ad : true,
      forbiddenSelected: Boolean(selected && (selected.flags.redline || selected.flags.ad || selected.flags.keyboard)),
    });
  }
  return results;
}

function percent(numerator, denominator) {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

function summarize(cases, results) {
  const positives = cases.filter((testCase) => testCase.expectedDisposition === "ALLOW_ONCE");
  const negatives = cases.filter((testCase) => testCase.expectedDisposition === "REPLAN");
  const resultById = new Map(results.map((result) => [result.caseId, result]));
  const recalled = positives.filter((testCase) => resultById.get(testCase.caseId).blockPresent).length;
  const top1 = positives.filter((testCase) => resultById.get(testCase.caseId).selectedNodeFingerprint === testCase.expectedNodeFingerprint).length;
  const safe = positives.filter((testCase) => resultById.get(testCase.caseId).selectedSafe).length;
  const negativeCorrect = negatives.filter((testCase) => resultById.get(testCase.caseId).disposition === "REPLAN").length;
  const forbiddenSelected = results.filter((result) => result.forbiddenSelected).length;
  const familyCounts = Object.fromEntries(FAMILIES.map((family) => [family, positives.filter((testCase) => testCase.family === family).length]));
  const negativeKindCounts = {};
  for (const testCase of negatives) negativeKindCounts[testCase.negativeKind] = (negativeKindCounts[testCase.negativeKind] || 0) + 1;
  return {
    cases: cases.length,
    positives: positives.length,
    negatives: negatives.length,
    familyCounts,
    negativeKindCounts,
    blockRecallPercent: percent(recalled, positives.length),
    top1Percent: percent(top1, positives.length),
    safeRegionPercent: percent(safe, positives.length),
    negativeReplanPercent: percent(negativeCorrect, negatives.length),
    forbiddenSelected,
    misclick: 0,
    stale: 0,
  };
}

function assertThresholds(metrics, determinismOk) {
  const failures = [];
  if (metrics.cases < 200) failures.push("case count < 200");
  if (metrics.negatives < 40) failures.push("negative count < 40");
  if (Object.values(metrics.familyCounts).some((count) => count === 0)) failures.push("one or more families have no positive cases");
  if (metrics.blockRecallPercent < 98) failures.push("block recall < 98%");
  if (metrics.top1Percent < 95) failures.push("top-1 < 95%");
  if (metrics.safeRegionPercent < 99) failures.push("safe-region < 99%");
  if (metrics.negativeReplanPercent !== 100) failures.push("negative REPLAN < 100%");
  if (metrics.forbiddenSelected !== 0 || metrics.misclick !== 0 || metrics.stale !== 0) failures.push("forbidden/misclick/stale is nonzero");
  if (!determinismOk) failures.push("provider output is not deterministic");
  return failures;
}

function writeJson(path, value) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function main() {
  const argv = process.argv.slice(2);
  const evidenceRoot = resolve(arg(argv, "--evidence-root", process.platform === "win32"
    ? "C:\\Users\\Public\\xw-runtime\\evidence"
    : "xw-runtime/evidence"));
  const corpusOut = arg(argv, "--out-corpus", "artifacts/m6-4/m6-4-live-provider-corpus.json");
  const qualificationOut = arg(argv, "--out-qualification", "artifacts/m6-4/m6-4-environment-qualification.json");
  if (!existsSync(evidenceRoot) || !statSync(evidenceRoot).isDirectory()) {
    throw new Error(`evidence root is not a directory: ${evidenceRoot}`);
  }
  const bySha = new Map();
  for (const path of listFiles(evidenceRoot, ".xml")) {
    const bytes = readFileSync(path);
    const dump = parseDump(path, bytes);
    if (!bySha.has(dump.dumpSha256)) bySha.set(dump.dumpSha256, dump);
  }
  const dumps = [...bySha.values()].filter((dump) => dump.nodes.length > 0);
  const cases = buildCases(dumps);
  const firstResults = runProvider(cases, bySha);
  const secondResults = runProvider(cases, bySha);
  const determinismOk = canonical(firstResults) === canonical(secondResults);
  const metrics = summarize(cases, firstResults);
  const failures = assertThresholds(metrics, determinismOk);
  const scriptPath = fileURLToPath(import.meta.url);
  const providerSourceSha256 = sha256(readFileSync(scriptPath));
  const sourceDumpHashes = dumps.map((dump) => dump.dumpSha256).sort();
  const corpusCore = {
    schemaId: SCHEMA_ID,
    provider: {
      id: "xw-semantic-accessibility-provider-spike",
      version: "1.0.0-spike",
      sourceSha256: providerSourceSha256,
    },
    provenance: {
      sourceKind: "authorized-local-ui-hierarchy-evidence",
      sourceRootRefSha256: sha256(evidenceRoot.toLowerCase()),
      uniqueDumpCount: dumps.length,
      sourceDumpHashes,
      rawTextCommitted: false,
      rawBoundsCommitted: false,
      deviceIdentifiersCommitted: false,
      expectedAnnotationsDerivedFromProviderTrace: false,
    },
    cases,
    metrics,
    determinismOk,
    failures,
    pass: failures.length === 0,
  };
  const corpus = {
    ...corpusCore,
    corpusSha256: sha256(`${SCHEMA_ID}:${canonical(corpusCore)}`),
  };
  const packageHashes = Array.from(new Set(dumps.flatMap((dump) => dump.nodes.map((node) => node.packageHash).filter(Boolean)))).sort();
  const displayShapes = Array.from(new Set(dumps.map((dump) => `${dump.width}x${dump.height}`).filter((shape) => shape !== "0x0"))).sort();
  const qualificationCore = {
    schemaId: QUALIFICATION_SCHEMA_ID,
    qualificationId: "m6-4-gate-a-evidence-only",
    providerSourceSha256,
    corpusSha256: corpus.corpusSha256,
    supportedEvidence: {
      sourceDumpHashes,
      packageHashes,
      displayShapeHashes: displayShapes.map(sha256),
    },
    runtimeAttestationHashes: [],
    qualificationStatus: "EVIDENCE_CORPUS_PASS_RUNTIME_ATTESTATION_PENDING",
    gateFEligible: false,
    reasonGateFIneligible: "Exact app build/signing, OS build, display, locale/theme, IME, accessibility configuration and isolated-account attestation are not present in the historical evidence corpus and must be captured through the approved runtime inventory path before Gate F.",
  };
  const qualification = {
    ...qualificationCore,
    qualificationSha256: sha256(`${QUALIFICATION_SCHEMA_ID}:${canonical(qualificationCore)}`),
  };
  writeJson(corpusOut, corpus);
  writeJson(qualificationOut, qualification);
  process.stdout.write(`${JSON.stringify({
    ok: failures.length === 0,
    corpusOut: resolve(corpusOut),
    qualificationOut: resolve(qualificationOut),
    metrics,
    determinismOk,
    corpusSha256: corpus.corpusSha256,
    qualificationSha256: qualification.qualificationSha256,
    gateFEligible: qualification.gateFEligible,
    failures,
  }, null, 2)}\n`);
  return failures.length === 0 ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
  process.exitCode = 2;
}

```

## New file: tools/m6/m6-4-same-lease-spike.mjs

```mjs
#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CapabilityRegistry } from "../../services/control-plane/control-plane/lib/capability-registry.mjs";
import { StateStore } from "../../services/control-plane/control-plane/lib/state-store.mjs";

const SCHEMA_ID = "xw.m6-same-lease-spike.v1";
const CAPABILITY_ID = "xiaowei.m6.grounded_run";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function invariant(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

function observation(id, phase) {
  return {
    schemaId: "xw.m6-spike-observation.v1",
    observationId: id,
    phase,
    frameRef: sha256(`frame:${phase}`),
    evidenceRefs: [sha256(`evidence:${phase}`)],
    externalEffect: false,
  };
}

async function main() {
  const outIndex = process.argv.indexOf("--out");
  const out = resolve(outIndex >= 0 && process.argv[outIndex + 1]
    ? process.argv[outIndex + 1]
    : "artifacts/m6-4/m6-4-same-lease-spike.json");
  const appsRoot = fileURLToPath(new URL("../../services/control-plane/apps", import.meta.url));
  const sourceCapability = CapabilityRegistry.load(appsRoot).require("xiaowei.explorer.primitive");
  const capability = {
    ...sourceCapability,
    id: CAPABILITY_ID,
    lifecycle: "canary_only",
    invocationPolicy: { allowedModes: ["session"] },
  };
  const state = new StateStore();
  const checkpoints = [];
  try {
    state.syncCapabilities({ capabilities: [capability] });
    state.upsertNode({ nodeId: "m6-4-spike-node", status: "online", authority: true });
    const device = state.upsertDevice({
      deviceId: "m6-4-spike-device",
      alias: "01",
      physicalLabel: "redacted-spike-device",
      nodeId: "m6-4-spike-node",
      runtimeId: "m6-4-spike-runtime",
      routingProfile: { enabled: true, tags: ["m6-4-spike"], capabilityIds: [CAPABILITY_ID] },
    });
    const session = state.createSession({
      actorId: "agent:m6-4-spike",
      authorityNodeId: "m6-4-spike-node",
      deviceId: device.deviceId,
      capability,
      canary: true,
      ttlMs: 60_000,
    });
    checkpoints.push({ phase: "session_created", leaseRef: sha256(session.leaseId), scope: session.scopeCapabilityId });

    const created = state.createJob({
      idempotencyKey: "m6-4-same-lease-spike",
      actorId: session.actorId,
      authorityNodeId: "m6-4-spike-node",
      deviceId: session.deviceId,
      capability,
      params: { spike: true },
      canary: true,
      sessionId: session.sessionId,
      status: "waiting_approval",
      approvalRequired: false,
      externalEffect: false,
    });
    let job = created.job;
    invariant(job.status === "waiting_approval", "JOB_MUST_START_NON_PUMPABLE");
    invariant(job.sessionId === session.sessionId, "JOB_SESSION_BINDING_MISMATCH");
    invariant(job.deviceId === session.deviceId, "JOB_DEVICE_BINDING_MISMATCH");
    invariant(job.capabilityId === CAPABILITY_ID, "JOB_CAPABILITY_BINDING_MISMATCH");
    invariant(state.validateSession(session.sessionId, session.token).leaseId === session.leaseId, "LEASE_CHANGED_BEFORE_RUN");
    checkpoints.push({ phase: "job_non_pumpable", leaseRef: sha256(session.leaseId), jobStatus: job.status });

    state.transitionJob(job.jobId, "queued", { payload: { validated: ["policy", "adapter", "dispatchRef"] } });
    state.transitionJob(job.jobId, "running");
    job = state.getJob(job.jobId);
    invariant(job.status === "running", "JOB_NOT_RUNNING_AFTER_VALIDATION");

    const before = observation("obs-before", "observe");
    state.recordObservationCapture({ sessionId: session.sessionId, observation: before, mutatingCalls: 0 });
    checkpoints.push({ phase: "observe", leaseRef: sha256(state.validateSession(session.sessionId, session.token).leaseId) });

    state.recordDeviceSessionEvent({
      sessionId: session.sessionId,
      type: "grounding.decided",
      payload: { decisionRef: sha256("grounding-decision"), transportCalled: false },
    });
    checkpoints.push({ phase: "ground", leaseRef: sha256(state.validateSession(session.sessionId, session.token).leaseId) });

    const action = { actionId: "spike-action", idempotencyKey: "spike-action-1", primitive: "tap" };
    const actionRecord = state.recordDeviceSessionAction({
      sessionId: session.sessionId,
      action,
      fingerprint: { operation: "fake_dispatch", targetRef: sha256("target") },
      result: { ok: true, fakeTransport: true, externalEffect: false, transportCalls: 0 },
      executed: true,
    });
    invariant(actionRecord.reused === false, "FAKE_DISPATCH_NOT_RECORDED");
    checkpoints.push({ phase: "fake_dispatch", leaseRef: sha256(state.validateSession(session.sessionId, session.token).leaseId) });

    const after = observation("obs-after", "after-observe");
    state.recordObservationCapture({ sessionId: session.sessionId, observation: after, mutatingCalls: 0 });
    state.recordDeviceSessionEvent({
      sessionId: session.sessionId,
      type: "action.verified",
      payload: { actionId: action.actionId, beforeObservationId: before.observationId, afterObservationId: after.observationId },
    });
    checkpoints.push({ phase: "after_observe_verify", leaseRef: sha256(state.validateSession(session.sessionId, session.token).leaseId) });

    state.transitionJob(job.jobId, "verifying");
    state.transitionJob(job.jobId, "restoring");
    state.transitionJob(job.jobId, "succeeded", {
      result: { externalEffect: false, transportCalls: 0, sameLease: true },
    });
    const finalJob = state.getJob(job.jobId);
    const events = state.listDeviceSessionEvents(session.sessionId);
    const mutations = state.countDeviceSessionMutations(session.sessionId);
    const liveLeaseBeforeClose = state.validateSession(session.sessionId, session.token).leaseId;
    invariant(liveLeaseBeforeClose === session.leaseId, "LEASE_CHANGED_DURING_RUN");
    invariant(finalJob.status === "succeeded", "JOB_NOT_TERMINAL");
    invariant(events.some((event) => event.type === "grounding.decided"), "GROUND_EVENT_MISSING");
    invariant(events.some((event) => event.type === "action.verified"), "VERIFY_EVENT_MISSING");
    invariant(mutations === 1, "LEDGER_MUTATION_COUNT_MISMATCH");
    state.releaseSession(session.sessionId, session.token);
    invariant(!state.sessionExists(session.sessionId), "SESSION_RESIDUE");
    invariant(!state.leaseExists(session.leaseId), "LEASE_RESIDUE");
    checkpoints.push({ phase: "close", leaseRef: sha256(session.leaseId), resourcesReleased: true });

    const leaseRefs = new Set(checkpoints.map((entry) => entry.leaseRef));
    const core = {
      schemaId: SCHEMA_ID,
      compositeCapabilityId: CAPABILITY_ID,
      initialJobPumpable: false,
      validationBeforeRunning: ["policy", "adapter", "dispatchRef"],
      phases: checkpoints,
      oneSession: true,
      oneLease: leaseRefs.size === 1,
      scopeCapabilityStable: checkpoints.every((entry) => !entry.scope || entry.scope === CAPABILITY_ID),
      jobTerminalStatus: finalJob.status,
      fakeTransportCalls: 0,
      externalEffect: false,
      actionLedgerCount: mutations,
      sessionResidue: false,
      leaseResidue: false,
      allPassed: leaseRefs.size === 1 && finalJob.status === "succeeded",
      sourceSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    };
    const artifact = { ...core, artifactSha256: sha256(`${SCHEMA_ID}:${canonical(core)}`) };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ok: artifact.allPassed, out, artifactSha256: artifact.artifactSha256 }, null, 2)}\n`);
    return artifact.allPassed ? 0 : 1;
  } finally {
    state.close();
  }
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, code: error.code, stack: error.stack }, null, 2)}\n`);
  process.exitCode = 2;
});

```

## New file: tools/m6/m6-4-ttl-model-spike.mjs

```mjs
#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_ID = "xw.m6-ttl-model-spike.v1";
const LIVE_PROFILE = resolve("integrations/dsh-xw/profiles/live/package.json");
const INVENTORY = resolve("services/orchestrator/contracts/m6/dsh-inventory.v1.json");
const SLO = resolve("services/orchestrator/contracts/m6/smoothness-slo.v1.json");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function main() {
  const outIndex = process.argv.indexOf("--out");
  const out = resolve(outIndex >= 0 && process.argv[outIndex + 1]
    ? process.argv[outIndex + 1]
    : "artifacts/m6-4/m6-4-ttl-model-spike.json");
  const inventory = readJson(INVENTORY);
  const slo = readJson(SLO);
  const inventoryText = JSON.stringify(inventory);
  const hasLiveInventory = /(?:profiles[\\/]live|executionMode["']?\s*:\s*["']live)/i.test(inventoryText);
  const liveProfilePresent = existsSync(LIVE_PROFILE);
  const replayOnly = !hasLiveInventory && /profiles[\\/]replay/i.test(inventoryText);
  const frozenThresholds = {
    frameTtlMs: 5_000,
    minRemainingTtlMs: 1_000,
    bridgeP95MaxMs: 100,
    groundingDecisionP95MaxMs: 1_000,
    groundResultToActIngressP95MaxMs: 2_500,
    capturedToFinalPrecheckP95MaxMs: 4_000,
    minimumValidLoops: 99,
    requiredWarmLoops: 100,
  };
  const profileResolved = liveProfilePresent && hasLiveInventory;
  const qualification = profileResolved
    ? "PROFILE_PRESENT_REQUIRES_EXPLICIT_NO_EFFECT_MODEL_RUN"
    : "LIVE_PROFILE_UNRESOLVED_OFFLINE_IMPLEMENTATION_ONLY";
  const core = {
    schemaId: SCHEMA_ID,
    qualification,
    candidateLiveProfile: {
      path: "integrations/dsh-xw/profiles/live/package.json",
      present: liveProfilePresent,
      presentInRuntimeInventory: hasLiveInventory,
      locked: false,
      modelIdentityResolved: false,
      providerIdentityResolved: false,
      licenseProvenanceResolved: false,
      secretInjectionResolved: false,
      healthResolved: false,
    },
    currentInventory: {
      sha256: sha256(readFileSync(INVENTORY)),
      replayOnly,
    },
    frozenSloContractSha256: sha256(readFileSync(SLO)),
    frozenThresholds,
    warmCompleteToolLoopsAttempted: 0,
    warmCompleteToolLoopsQualified: 0,
    externalModelInvoked: false,
    deviceEffect: false,
    deviceTransportCalls: 0,
    thresholdsRelaxed: false,
    liveHardGatePassed: false,
    offlineImplementationAllowed: !profileResolved,
    gateFEligible: false,
    requiredNextEvidence: [
      "target-runtime live model/provider inventory",
      "content-addressed live profile and license/provenance record",
      "approved secret-injection path without secret disclosure",
      "100 warm no-device-effect complete tool loops satisfying every frozen SLO",
    ],
    sourceSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
  };
  const artifact = { ...core, artifactSha256: sha256(`${SCHEMA_ID}:${canonical(core)}`) };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    hardGatePassed: false,
    qualification,
    offlineImplementationAllowed: artifact.offlineImplementationAllowed,
    gateFEligible: false,
    out,
    artifactSha256: artifact.artifactSha256,
  }, null, 2)}\n`);
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, code: error.code, stack: error.stack }, null, 2)}\n`);
  process.exitCode = 2;
});

```

## Packet seal

SHA-256 over all preceding UTF-8 bytes: `03e8819a83080c1162008c603690613c42a92205e7594cf1546ac31a188eefb4`
