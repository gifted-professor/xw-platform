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
