# M6 可执行计划 V2：视觉落点驱动的真实手机 Agent 执行层

状态：`READY_FOR_EXECUTION`  
计划基线：`origin/main@a46fc72d3fdb1352104d354bdde5d482f2184e86`  
基线 tree：`f63e72c96319ae335ad56765b7643dd92ed4ba8e`  
前置：M5 已完成并合入；成功与单机隔离两条真机 trace 已通过  
风险级别：HIGH（跨合同、持久状态、并发、子进程、真机动作、双平台 CI）

## 1. 目标与最终状态

M6 的唯一目标是：让 M5 的一个 `WorkAssignment` 可以选择 `agentic_session` 执行器，在正式 session/lease 内启动一个固定版本的 DSH worker，完成：

`Observe → Stabilize → Ground → Authorize → Act → Verify → Checkpoint/Reconcile`

M6 完成后应同时满足：

1. M5 继续负责任务分类、DAG、依赖、四机调度、失败隔离和 reducer；M6 不复制调度器。
2. 设备观察和动作仍只经过 Control Plane 的正式 session/lease/action authority；DSH 不拥有设备权限。
3. 模型只能看到稳定 frame、视觉 block、语义标签和引用；不能看到或提交原始坐标、ADB、端口、token、数据库或 payment 参数。
4. `blockId` 只对一个不可变 `frameId` 有效；换帧、焦点变化、页面变化、超时或歧义一律 fail closed。
5. 动作 dispatch 前持久化意图与幂等键；结果丢失时先 reconcile Action Ledger，禁止盲重放。
6. 授权模型是“一次任务授权 + 范围内自主执行”，不是逐动作审批；支付与删除是系统级硬红线，其他动作在原始 goal、注册 capability、预算和设备范围内默认自主执行。
7. 四台手机可并发跑复杂任务；一个 DSH/serve/worker 失败时其他 worker 继续，lease、子进程和 trace 最终归零。
8. 在非支付、非删除的验收任务集中，≥90% 的运行不需要中途人工介入；正常路径不得弹逐步确认。
9. 丝滑是机器门而不是口号：一个 WorkerRun 只启动一次 DSH；正常路径无人工往返；bridge、grounding、observe-to-dispatch 都有 p50/p95 receipt 和硬 SLO。

## 2. 非目标与红线

M6 不做：

- 不重写 M5 Router、DAG Compiler、TaskPlanV2 scheduler 或 capability binder。
- 不把现有 `SkillRouter` 改造成任务路由器。
- 不让 DSH 直接执行 ADB、raw shell、raw HTTP、坐标点击、数据库写入或 lease 操作。
- 不启用支付或删除；支付包括购买、转账、打赏、订阅扣费、提交支付凭证和最终支付确认，删除包括删除内容/文件/消息/账号、清数据、卸载等破坏性动作。
- 不把历史视觉 PoC 的机器外绝对路径继续扩散为生产依赖。
- 不把 fixture adapter 冒充真实 Cordis/DSH 进程。
- 不在 M6-0 翻转任何 live gate，不碰真机，不发布 release。
- 不直写 `control.db`、`registry.db`，不绕正式 job/session/lease，不增加 npm workspace 或新 service。
- 不使用 squash；每个 PR 用 merge commit，可独立回滚。

## 3. 已验证现状与必须收敛的冲突

### 3.1 可复用底座

- M5 scheduler 已从 `worker.execute(assignment)` 进入 worker，并已有依赖、alias 互斥、重试、失败隔离、receipt 与 reducer。
- `WorkReceiptV2` 已绑定 task/plan/execution-plan/capability/implementation/operation/auth/job/run/node/shard/attempt/worker/alias，可承载 M6 correlation。
- Control Plane 已有 `ObservationV1`、Open Action fixture、Action Ledger、reconcile 与 crash-resume 语义。
- `vision-safety.mjs` 已有敏感标签、区域、歧义、page fingerprint 等安全规则。
- `locator.visual-block.v1` 已定义 blockId-only、`tapAuthorized=false`、semantic→visual→fail-closed。

### 3.2 当前缺口

- TaskPlan executor 只允许 `typed_job | session_workflow`，worker router 也只路由这两类。
- `integrations/dsh-xw` 只是内存 fixture；没有真实 Cordis 插件、SDK/JSON-RPC 子进程或 session 生命周期。
- `xw-locator.mjs`、`xw-start.mjs` 和微信 OCR 路径仍引用机器外 Python/模型资产。
- 当前 Primitive Action target 合同仍允许多种坐标 target；它不能直接暴露给 DSH。
- Open Action v1 仍是 fixture/replay/fault，且现有 effect 分类不足以表达“task-scoped 默认自主 + payment/delete hard deny”。
- Observe feed 的 screenshot 失败目前可留下业务成功；M6 的 agentic execution 必须把 execution-grade screenshot/frame 设为硬前置。
- 所有相关 live gates 仍 CLOSED，这是正确的 M6 起点。

### 3.3 收敛原则

只建立一条新链路：

`M5 assignment + task-scoped AutonomyGrant → AgenticSessionWorker → DSH subprocess → Grounding Tool API → Grounding Runtime → Control Plane session/action authority`

已有 `xw-locator` 退化为兼容 CLI/诊断入口，调用同一 Grounding Runtime；禁止产生第二套 locator、第二套 action executor 或第二本账。

## 4. 责任边界

| 组件 | 唯一责任 | 明确禁止 |
|---|---|---|
| M5 Router/DAG/Scheduler | 分类、DAG、依赖、alias、worker 调度、失败隔离、汇总 | 视觉推理、坐标、直接设备动作 |
| AgenticSessionWorker | DSH 进程生命周期、工具桥、checkpoint、receipt、trace | 自己解释屏幕、自己执行设备动作 |
| DSH/Cordis plugin | 模型循环、选择 block、决定下一工具调用 | ADB、端口、坐标、lease、DB、payment |
| Grounding Runtime | 稳定帧、视觉分块、block 解析、安全落点、stale/ambiguity 检查 | 绕 Control Plane 派发动作 |
| Control Plane | session/lease/action authority、任务级授权、设备 I/O、Action Ledger、reconcile | 接受未授权 raw coordinate/model command，支付或删除动作 |
| Trace/Evidence Store | 内容寻址附件、事件关联、审计证据 | 保存秘密、token、原始支付值 |

动作时序固定为：

1. Worker 获得 M5 assignment；通过正式入口申请 session/lease。
2. Worker 启动 pinned DSH 子进程，传入最小 session capability token/reference，不传设备 transport 信息。
3. `phone_observe` 请求 execution-grade stable frame。
4. Grounding Runtime 获取 screenshot A、dump/focus、screenshot B；稳定性和敏感区域检查通过后冻结 frame。
5. DSH 只选择 `blockId`；落点不稳时先自动重观测、滚动、返回或换策略，服务端将有效 block 解析为一次性内部落点。
6. Control Plane 在 dispatch 前复核 AutonomyGrant、lease、frame freshness、focus/page fingerprint、硬红线、Action Ledger 幂等键。
7. Control Plane 执行动作并写 ledger；返回只含引用的 receipt。
8. Worker 重新 observe/verify，写 checkpoint；异常时先 reconcile 并在预算内自动恢复，只有目标本身是支付/删除、需要扩大原始任务范围或恢复预算耗尽才 `WAIT_HUMAN`。
9. 结束顺序固定为：停止新工具调用 → checkpoint/reconcile → revoke session → release lease → terminate DSH → close worker receipt。

## 5. 合同设计

所有 M6 合同先放 kernel 合同树并由纯函数 validator 校验；先 additive，禁止静默改变既有 v1 语义。

### 5.1 `xw.screen-frame.v1`

execution-grade 的不可变帧封套，不替代 Control Plane 的 `ObservationV1`：

- `frameId`：由 canonical manifest/hash 生成的安全 ID。
- `observationRef`、`screenshotARef`、`screenshotBRef`、`dumpRef`、`focusRef`。
- A/B hash、尺寸、方向、density、capturedAt、expiresAt。
- `sessionId`、`leaseRef`、`alias`、`appId` 的不可篡改关联摘要；模型返回中只暴露 opaque refs。
- 稳定性结论、page/focus fingerprint、partial/missing flags。
- screenshot、focus 或稳定性不足时不得生成可操作 frame。

### 5.2 `xw.visual-block.v1` 与 `xw.visual-block-set.v1`

- 每个 block 固定绑定 `frameId + blockId + boundsRef + label + confidence + source`。
- `blockId` 由 frame hash 与稳定 index/region hash 派生，禁止跨 frame、device、rotation 复用。
- block set 含 segmentation/provider/version/model hash、排序规则和完整性 hash。
- 模型可见输出不含 pixel/normalized coordinate；内部 bounds 只存在 Grounding Runtime/evidence attachment。
- 支付、删除、广告、系统导航、状态栏、键盘、权限弹窗等显式分类；未知分类先自动重观测/换策略，不在未分类状态下盲点。

### 5.3 `xw.grounding-decision.v1`

- 绑定 goal/step、AutonomyGrant ref、frameId、blockId、action intent、effect class、policy version。
- 包含 freshness、focus、ambiguity、safe-region、sensitive-label、confidence 检查结果。
- 结果为 `ALLOW_ONCE | REPLAN | HARD_STOP`；视觉歧义默认 `REPLAN`，支付/删除为 `HARD_STOP`。
- `ALLOW_ONCE` 生成一次性 `groundingDecisionId`；坐标只由服务端在同一 dispatch transaction 内解析。
- DSH 伪造 effect、frame、block、grant 或把 `REPLAN/HARD_STOP` 改为 allow 均无效。

### 5.4 `xw.autonomy-grant.v1`

一次任务授权封套，用来消除逐动作审核：

- 由原始用户 goal/结构化任务和可信 actor 生成，不由模型自报；绑定 task/plan、apps、aliases、skill/capability、可执行 intents、时限、step/action/token budgets。
- 默认策略是范围内允许，范围外 `REPLAN`；模型不能扩大 app、设备、目标、预算或动作类别。
- 非支付/非删除动作可在 grant 范围内自主执行，包括导航、搜索、输入、滚动、打开、返回以及 goal 明确要求的社交/发布/账号类动作。
- 支付与删除被独立 hard-deny policy 覆盖，grant 无法放行；未来如要支持必须另立不属于 M6 的专门里程碑和人工审批链。
- grant 在整个 WorkerRun 有效，不产生逐动作审批；只在范围扩张或 hard stop 时请求用户。

授权编译必须是可复核的，不宣称服务端能理解任意语义：

`effectiveScope = registered AgenticSkillSpec maximum ∩ compiled TaskIntentSet ∩ actor/device/time/budget limits − hardRedlineSet`

- `AgenticSkillSpec` 列出 action families、apps、数据范围、max budgets 和 verification obligations。
- Router/Compiler 把已知自然语言或结构化 goal 编成 `TaskIntentSet`；无法唯一确定 app/skill/action family 时只在任务开始前澄清一次，不能生成宽泛 grant。
- Control Plane 强制执行设备、app、action family、时间、次数和 redline；DSH 负责范围内的语义规划，verify/no-progress policy 发现偏航后自动 replan。
- 每次 action 都携带 grant ref，但这只是本地机器校验，不是人工审批或远程往返。
- M5 DAG 中的 agentic node 只有在 `authorizationMode=task_grant`、有效 grant ref 和 hard-redline policy 同时存在时才可运行；否则 fail closed。

### 5.5 `xw.hard-redline-policy.v1`

支付/删除不能只靠模型自报或一个 OCR 标签判断：

- 注册 tool/action family 中，payment/purchase/transfer/tip/subscription/credential-submit/delete/uninstall/clear-data 等类别静态 hard deny。
- Grounding Runtime 同时检查目标 block 的 OCR/semantic/resourceId/accessibility label、页面/应用风险 fingerprint 和 action intent；任一信号命中即 `HARD_STOP`。
- 位于确认弹窗、支付页、订单页、资产页或破坏性设置页且无法确定语义时，返回 `REPLAN`，禁止通用 tap 穿过。
- Control Plane dispatch 再执行独立 policy 校验；DSH、grant、live config 均不能覆盖。
- Policy 版本/hash 写入 decision、ledger ref 和 receipt；测试必须覆盖同义词、图标按钮、空 dump、视觉误分类和伪造 intent。

### 5.6 `xw.grounded-action.receipt.v1`

避免和既有 `xw.open-action.result.v1` 冲突，作为 M6 上层 receipt：

- 绑定 task/plan/node/shard/worker/session/lease/action/operationKey。
- 绑定 before frame、decision、Control Plane action/ledger ref、after frame、verification ref。
- 状态：`AUTHORIZED | DISPATCHED | VERIFIED | FAILED | AMBIGUOUS | RECONCILED`。
- 含 AutonomyGrant、hard-redline policy/version/hash、implementation closure hash、error taxonomy。
- 不复制 Action Ledger；ledger 仍是设备动作事实真源，receipt 只给 M5/trace 使用。

### 5.7 `xw.agentic-executor.v1`

- 描述 model profile、tool allowlist、time/step/action budgets、checkpoint policy、autonomy policy、grounding/runtime/DSH lock refs。
- M6-0 只定义合同；在真实 worker、gate 和 binder 同时存在前，不把 `agentic_session` 加入可执行 TaskPlanV2 enum。
- 后续一次性接入：TaskPlan validator、capability binder、MissionWorkerRouter、receipt mapping 同 PR 完成，避免“可编译但不可执行”。

### 5.8 兼容规则

- `ObservationV1`、Action Ledger v1、WorkReceiptV2、TaskPlanV2 旧 fixture 行为保持不变。
- Action Ledger 如需 live 字段，优先由 additive extension/receipt 引用；任何 schema upgrade 必须带双读、旧 fixture 回归和明确 migration/rollback。M6-0 不改数据库 schema。
- `locator.visual-block.v1` 继续有效，但其实现收敛到新 Grounding Runtime。
- M5 既有 `requiresHuman` 行为不被全局削弱。M6-0 定义 additive `authorizationMode=task_grant`；M6-6 同一接线 PR 才更新 schema/validator/binder/worker：有有效 grant 时 agentic node 在开跑前一次性满足授权，运行中不再逐动作等待；旧 skill 和 `authorizationMode=per_node` 保持原语义。

## 6. 模型工具面

DSH 初始工具白名单固定为：

- `phone_observe({sessionRef})`
- `phone_ground({frameRef, blockId, intent})`
- `phone_act({groundingDecisionRef, operationKey})`
- `phone_verify({actionReceiptRef, expectation})`
- `checkpoint_save({stateRefs})`
- `trace_query({traceId})`
- `wait_human({reason, evidenceRefs})`（仅 hard stop、范围扩张或自动恢复预算耗尽）
- worker lifecycle tools（start/continue/complete）

静态和运行时都拒绝以下字段/能力：`x/y`、normalized coordinate、bounds、ADB serial/server/port、shell、HTTP URL、token、lease mutation、DB path/query、payment value/credential、raw screenshot base64。

图片和 dump 通过内容寻址 attachment 保存；工具 JSON 只传 opaque refs、结构化 block 和最小文本。attachment 需要大小上限、hash 校验、MIME allowlist、保留策略和敏感信息清理。

## 7. 运行开关：一个 live gate，不做逐动作关卡

M6 只有一个运行开关：`M6_AGENTIC_LIVE_GATE`。它默认 CLOSED，并记录 release、actor、sourceCommit、lock hashes、skill/alias allowlist、到期时间和 closeout；单机到四机通过扩大同一 canary allowlist 渐进发布，不再增加多层 gate。

replay、observe-only、single-alias、multi-alias 是执行模式/rollout stage，不是模型每一步都要通过的审批。模型在一个有效 AutonomyGrant 内连续执行，不查询 gate 服务。

支付/删除不是普通 rollout gate，而是更低层的不可覆盖 hard-deny firewall：M6 config、grant、模型或管理员误开 live gate都不能放行。原有支付 firewall 继续保持；M6 新增删除分类与 hard-deny。legacy gates 不被 M6 反向修改。

旧 gate 与新链路的关系必须写死：

- 既有 generic Open Action、fixture DSH、graph-v2、multi-agent legacy live flags 保持 false；M6 不借它们开门，也不绕过它们去调用旧 generic executor。
- 新的 Grounded Action endpoint 和 AgenticSessionWorker 只认 `M6_AGENTIC_LIVE_GATE + AutonomyGrant + formal session/lease`，并在独立 namespace/profile 字段 `agenticGroundingEnabled` 下启用。
- 若请求落入旧 PrimitiveAction/raw-coordinate endpoint，即使 M6 gate 开着也拒绝；若 M6 gate 关闭，新 endpoint 与真实 DSH worker均拒绝启动。
- 因此运行侧只有一个 M6 开关，代码侧仍保持旧功能 CLOSED，而不是把两个 CLOSED gate 叠成每次动作的串行审批。

## 8. 实施波次与 PR

波次是退出门，不等于八个审批关卡。为减少集成/CI/合并往返，默认合成五个可回滚 PR：

1. PR M6-0：合同、资产、inventory、benchmark、docs（下述 M6-0）。
2. PR M6-A：离线 Grounding Runtime + execution-grade frame（M6-1/2；live 部分仍在同一 PR merge 后单独 canary）。
3. PR M6-B：真实 DSH/Cordis replay worker（M6-3）。
4. PR M6-C：单 alias Grounded Action + checkpoint/reconcile（M6-4/5）。
5. PR M6-D：`agentic_session` 四机接线 + 最终验收/closeout（M6-6/7）。

只有 M6-0、M6-A observe-only、M6-C single-alias、M6-D four-alias 四个宏观退出点；它们是发布证据门，不会出现在单次手机操作循环里。

### M6-0 — 合同、资产与真实基线（PR M6-0；零 live）

交付：

- `docs/plans/M6-task-brief.md`：冻结本计划的目标、非目标、门禁、验收。
- `docs/architecture/m6-agentic-grounding.md`：责任矩阵、时序、状态机、失败语义、ADR。
- 四组 grounding 合同、agentic executor 合同、validator 与 fixtures。
- 现有视觉实现 inventory：所有源码/依赖/模型/许可证/机器外路径/调用者/hash；标出 `xw-locator`、`xw-start`、微信 OCR 的兼容例外。
- `visual-assets.lock.v1.json`：来源、版本、SHA-256、license/provenance、安装方式；禁止把未知许可模型直接提交仓库。
- replay corpus manifest schema：frame/evidence 只用去标识化、合成或授权资产；不提交账号、设备 ID、token、余额等敏感信息。
- `autonomy-benchmark.v1`：冻结不少于 100 个非红线任务，覆盖启动/切换 app、搜索、输入、滚动、tab/返回、表单编辑、设置导航、社交/发布/账号动作的 replay 或授权测试账号场景；定义“中途人工介入”和“逐动作审批”的计数口径。
- `smoothness-slo.v1`：冻结计时边界、硬件/模型 profile、warm/cold 区分和初始阈值；任何阈值调整必须作为显式计划变更，不能在 closeout 临时放宽。
- 静态 external-path guard：以精确 inventory 为暂时 baseline，只允许既存兼容例外，禁止新增绝对路径；M6-1 清零例外。
- DSH inventory/lock conformance：明确当前 adapter 为 fixture；验证 pinned DSH/commit/package manager/API/许可证，不能写假 `src/index.ts` 接口。
- `M6_AGENTIC_LIVE_GATE` CLOSED，支付/删除 hard-deny；未加入可执行 `agentic_session`。
- 新增 `test:m6` 并接 Ubuntu/Windows 硬门；更新显式 `check` 文件列表和 post-import allowlist。

测试：schema 正反例、AutonomyGrant 范围/预算/伪造、支付/删除不可覆盖、非红线任务零逐步审批、frame/block stale、跨 frame block、raw coordinate 字段、receipt correlation、路径 guard、资产 hash、fixture-not-live、gate closed、旧 M4/M5 合同回归。

退出门：双平台 CI 全绿；无 live/device/DB/release 变化；Plan/architecture/contracts/asset locks 可单独审查并可独立 revert。

### M6-1 — 离线 Grounding Runtime 与 replay corpus（PR M6-A）

交付：

- 唯一 `GroundingRuntime` 接口：stable-frame validator、provider adapter、block-set、decision policy、private point resolver。
- 将旧 visual resolver 源码迁入受版本控制/内容寻址的集成目录，或以可复现 artifact lock 安装；移除生产默认机器外路径。
- `xw-locator` 改为调用同一 runtime 的诊断 CLI，不保留独立算法。
- provider 可插拔，但安全策略和 block ID 生成唯一；CI 使用 hermetic fixture provider。
- 建立至少 200 个授权/去标识 replay frames 的 corpus manifest，覆盖弹窗、键盘、旋转、广告、空 dump、重复块、敏感标签、滚动前后页面。
- 生成确定性 metrics receipt 和 overlay/evidence。
- 在 pinned Windows runner/alias profile 上校准并冻结 live 前 SLO：JSON-RPC bridge p95 ≤100 ms（不含模型/设备 I/O），Grounding Runtime 对已冻结 frame 的 decision p95 ≤1 s，stable observe-to-dispatch 的非模型开销 p95 ≤4 s；不达标先优化，不能增加人工确认规避。

退出指标：block recall ≥98%、top-1 ≥95%、safe-region ≥99%、forbidden/misclick/stale=0；同输入 hash/排序/decision 完全确定；Windows/Linux replay 一致。

### M6-2 — Execution-grade Frame，只读真机（PR M6-A merge 后 canary）

交付：

- 在正式 session/lease 内实现 screenshot A → dump/focus → screenshot B。
- 定义稳定阈值、超时、rotation/focus/app change、partial evidence 与 error taxonomy。
- evidence/attachment 持久化到 `xw-runtime` canonical root，原子写入、hash 校验、容量/权限/敏感信息限制。
- 4 alias 只读 capture CLI/preflight/status/closeout；无 action API。

真机退出门：每台至少 20 组稳定/不稳定样本；不稳定、空 dump、截图缺失、焦点变化都不得生成 actionable frame；最终 active lease/running job/pending approval=0。

### M6-3 — 真实 DSH/Cordis 子进程与 replay tools（PR M6-B）

交付：

- 基于 M6-0 锁定的真实 SDK/JSON-RPC 形状实现 out-of-process Cordis plugin。
- 一 WorkerRun 一 DSH process/session；固定 binary/package/source/model profile hashes。
- JSON-RPC framing、request/response ID、timeout、stdout/stderr 限额、backpressure、process tree cleanup。
- tool schema 双侧校验；只接 replay GroundingRuntime，不接真机 action。
- checkpoint/resume、kill-before-call、kill-after-response、重复 response、乱序/损坏消息测试。
- 终止顺序测试：先关闭工具/session/lease，再杀进程；不能留下 orphan。

退出门：真实 DSH 进程通过 replay 全链；fixture 与 live adapter 在类型和 trace 中清楚区分；live gate 关闭时绝不能接设备动作。

### M6-4 — 单 alias Grounded Action canary（PR M6-C + staged release）

交付：

- Control Plane 新增窄 `grounded action` 服务端入口，只接受 `groundingDecisionRef + operationKey`，拒绝 raw PrimitiveAction target。
- dispatch 前复核 session/lease/frame/focus/page/effect/expiry/once-only；内部解析安全点并立即失效。
- 将动作写入既有 Action Ledger；上层生成 GroundedActionReceipt。
- 只开放受控 `observe/open_app/back/wait/tap/scroll/type_search_text` 子集；每类有预算、节流、敏感区和 verification。
- grant scope 由原始 goal + 已注册 capability + action policy 派生，模型不可扩大；支付/删除返回 `HARD_STOP`，范围外先 `REPLAN`，恢复耗尽才 `WAIT_HUMAN`。
- alias 01 首轮 canary 用小红书只读搜索与打开笔记降低上线风险；通过后在同一 gate/同一授权模型下扩展非红线动作，不增加逐动作关卡。
- 单 alias 追加 smooth-control suite：至少 30 个已授权非红线任务、至少 8 个 action families；公开副作用只在用户明确提交的任务和授权测试账号中执行，计划本身不预授权这些 live side effects。

真机退出门：20 次连续 bounded runs 成功率 ≥95%；smooth-control suite ≥90% 无中途人工、正常任务 action-level approval prompts=0；0 支付/删除、misclick/stale/duplicate action；每次 action 都能从 M5 receipt → grant → DSH tool call → frame/decision → Action Ledger → after-frame/verify 完整追溯。

### M6-5 — Checkpoint、Ledger reconcile 与故障恢复（PR M6-C）

交付：

- checkpoint 记录 step、tool call、operationKey、frame/action/receipt refs 和 budgets，不保存秘密或 raw transport。
- 故障矩阵：dispatch 前 kill、dispatch 后结果前 kill、结果后 checkpoint 前 kill、空 dump、frame stale、歧义/no-progress、serve unavailable。
- 恢复固定为查 Action Ledger：`VERIFIED` 则复用；`EXECUTING/AMBIGUOUS` 则停下并 reconcile/人工；确定未执行才允许同 operationKey 重试。
- M5 scheduler 只看到确定的 worker outcome；失败节点不污染其他 worker，依赖节点按原规则 blocked。

退出门：故障注入无双击/双写/越界动作；RepairTriggered/SkillFinished/receipt/ledger 一致；所有 DSH/process/session/lease 归零。

### M6-6 — `agentic_session` 接线与四机 fan-out（PR M6-D + canary）

交付：

- 同一 PR 完成 TaskPlanV2 enum/validator、capability binding、MissionWorkerRouter、AgenticSessionWorker、WorkReceipt/trace mapping。
- Skill registration 只有通过 capability/effect/tool/model locks 的 skill 才能选择 agentic executor。
- M5 DAG/alias/dependency/scheduler 不变；一 alias 一并发，四 WorkerRun 各自进程与 session。
- deterministic reducer/dedup/cross-device validator；汇总顺序按 plan，不按完成时间。
- 用同一个 `M6_AGENTIC_LIVE_GATE` 从 alias 01 allowlist 扩到 01-04；不增加新 gate。

退出门：四机 3 轮均 4/4，某一 DSH 或 serve 故障时其他 3 个继续；失败节点/后继状态、trace、lease cleanup 与 M5 语义一致。

### M6-7 — 最终验收、文档与 closeout（PR M6-D/证据提交）

最终任务：

- 四台小红书分别搜索四个攀岩相关 query。
- 每台打开前两个“非广告”结果，采集公开标题、作者、稳定 note ref、可见互动数和证据引用。
- reducer 去重，validator 以 plan hash 为 seed 抽样 ≥10% 做跨设备复核。
- 该验收任务本身是只读采集，因此全流程不应出现 goal 外的点赞、评论、关注或发布，也不得出现支付/删除；这不是 M6 对其他已授权任务的全局禁令。

故障演练单独运行：

1. dump 为空：visual 可继续但必须保守；不能将未知区域标为安全。
2. 两个候选块歧义：不得点击；先自动重观测/换策略，恢复预算耗尽才返回 `WAIT_HUMAN`。
3. action dispatch 后、结果返回前 kill DSH：重启后从 Ledger reconcile，动作不得重复。
4. kill 一个 alias 的 DSH/serve：其他 3 个继续，失败隔离，最后恢复服务。

handoff/closeout 冻结：source/release/actor/gate/alias、DSH/runtime/model/asset hashes、plan/DAG/trace/task/worker/job/session/lease/action IDs、corpus metrics、queryTrace、ledger reconcile、故障/恢复、资源归零、live gate 最终状态。

## 9. 测试与机器门

### 9.1 单元/合同

- schema additionalProperties、ID/hash/time/size/budget 边界。
- frame A/B、focus、rotation、expiry、跨 alias/session、page fingerprint。
- block 跨帧/重复/伪造/敏感/广告/系统区域/坐标泄漏。
- grant/action-family spoof、payment/delete 同义词与图标/空 dump、capability mismatch、gate closed、tool 未注册。
- operationKey 幂等、receipt/ledger/correlation 断链。

### 9.2 集成/并发/持久化

- M5 assignment → DSH → replay grounding → checkpoint → receipt。
- JSON-RPC truncate/oversize/out-of-order/timeout/crash/process-tree cleanup。
- 四 worker 并发 attachment/trace/ledger；原子写、连续 seq、重启恢复、坏文件明确失败。
- revoke/session/lease/DSH cleanup 顺序和 fail-closed 写盘。
- agentic worker 不影响 typed-job/session-workflow 旧路径。

### 9.3 安全静态门

- M6 tool/worker/plugin 代码不得引用 raw ADB、`:22222`、serve port、DB driver/path、payment credential、raw coordinate target。
- 外部绝对路径 baseline 在 M6-1 后归零。
- 日志/trace/attachment 扫描 token、cookie、支付原值、设备序列号和截图 base64。
- payment/live legacy gates 保持 CLOSED；无批准不可启 M6 canary。
- 非红线 benchmark 的中途人工介入率必须 <10%，正常路径 action-level approval prompts 必须为 0；CI 断言不能悄悄退回逐动作审批。

### 9.4 CI 与全量门

每个 PR 至少运行：

- `npm run check`
- `npm run fusion:verify`
- `npm run test:m6`
- `npm run test:orchestrator`
- `npm run test:m4b`
- `npm run test:m4c`
- `npm run test:m4d`
- `npm run test:kernel`
- `npm run kernel:check`
- `npm run authority`

涉及 Control Plane 时追加其直接全量测试，并使 M6 新测试在 Ubuntu/Windows 都硬失败；既有 control-plane allowlist 不得吞掉 M6 测试失败。

## 10. 发布与回滚

### 10.1 发布

- M6-0/M6-1/M6-3 replay 合入不部署 live。
- M6-2 开始才允许从已合 main 构建新 release；先 observe-only，再单 alias，使用同一个自动到期 live gate 和渐进 allowlist。
- M6-4 先 alias 01 bounded canary；指标和资源归零通过后再进入 M6-5/6。
- 四机 fan-out 必须使用正式 catalog/job/session/lease；开始前拒绝已有 active lease/job/approval 的环境。

### 10.2 回滚

- 每个 PR 用 merge commit；代码回滚用 `git revert -m 1 <merge>`，不 reset/squash。
- 运行时先关唯一 M6 live gate、停止新 assignment、reconcile in-flight ledger、revoke session/lease、终止 DSH，再回滚 release。
- 保留 trace/ledger/attachment 审计证据，不删除数据库记录或 JSONL。
- `agentic_session` 故障只回退到既有 typed/session worker；M5、支付 firewall、M4 contracts 不随之回滚。

## 11. 风险与阻断条件

| 风险 | 级别 | 控制 |
|---|---:|---|
| 旧 visual PoC 与新 runtime 形成两套真源 | 高 | M6-1 收敛到唯一 runtime，旧 CLI 只做代理 |
| DSH SDK/API/许可与设想不符 | 高 | M6-0 锁真实依赖和许可；未证实不进入 M6-3 |
| raw coordinate 经旧 PrimitiveAction target 泄露 | 高 | 新窄 grounded-action 入口；模型面与控制面双重 schema 拒绝 |
| action 已执行但结果丢失造成重复 | 高 | dispatch 前 ledger + operationKey；恢复只 reconcile |
| screenshot/dump/focus 不一致导致误点 | 高 | A/dump/B 稳定帧、expiry、same-frame once-only |
| 模型越权扩大任务范围 | 高 | AutonomyGrant/capability/policy 服务端推导；范围外自动 replan，支付/删除硬拒绝 |
| 安全设计退化为逐动作审批，控制不丝滑 | 高 | 一次任务授权；正常路径 approval prompts=0；非红线任务人工介入率 <10% |
| DSH 子进程泄漏/持 lease | 高 | 生命周期状态机、进程树 cleanup、先 revoke 后 kill |
| 200-frame corpus 含隐私/不可再分发资产 | 高 | license/provenance/去标识 gate；manifest 和二进制分离 |
| 跨平台 Python/model 依赖不可复现 | 中 | asset lock + hermetic fixture provider + Windows/Linux receipts |
| 四机演示 race/故障恢复不彻底 | 中 | 事件触发故障、finally 恢复、最终资源归零硬门 |

以下任一项未满足即停止后续波次：

- DSH 实际 SDK/JSON-RPC/许可证无法验证。
- 视觉模型或 corpus 无合法 provenance。
- 不能证明 DSH 工具面无 raw coordinate/ADB/lease/DB/payment。
- Action Ledger 无法在 dispatch 后结果丢失场景可靠 reconcile。
- 唯一 live gate 不能立即关闭，或无法证明 lease/session cleanup。

## 12. 完成定义

M6 只有在以下全部满足时才完成：

1. 离线 ≥200 frames 的四项硬指标通过，0 forbidden/misclick/stale。
2. 单 alias 20 次 bounded runs 成功率 ≥95%，0 越权/重复动作。
3. 四 alias 连续 3 轮 4/4；单 worker/DSH/serve 故障不扩散。
4. kill-after-dispatch-before-result 能从 Ledger 正确 reconcile，动作不重放。
5. M5 旧 worker、M4、kernel、authority、fusion、Ubuntu/Windows 全绿。
6. queryTrace、WorkReceipt、GroundedActionReceipt、Ledger 和 evidence 引用可完整互证。
7. 最终无 active lease、running job、pending approval、orphan DSH；服务恢复，gate 状态记录清楚。
8. 架构、runbook、failure taxonomy、gate 操作、回滚与 handoff 证据全部提交。
9. 非支付/非删除 benchmark 中 ≥90% 的任务无需中途人工介入，正常路径无逐动作审批；支付和删除在所有配置下保持 hard stop。
10. 固定 profile 下 JSON-RPC bridge、grounding decision、observe-to-dispatch 的 p95 达到冻结 SLO；一个 WorkerRun 不因每个动作重启 DSH。

## 13. 下一步执行顺序

1. 执行时先 fetch，确认最新 `origin/main` 包含 `a46fc72d...`；从最新 main 创建干净 `codex/m6-0-contracts` 工作树，并对 task-plan/worker/open-action/locator/DSH/runtime-profile 的基线漂移做 preflight。不得在当前 dirty root 或已合 M5 worktree 上开发。
2. 先把本计划 V2 提交为 `docs/plans/M6-task-brief.md`；若 preflight 发现改变上述责任边界的 main 漂移，先更新事实与计划再写功能。
3. 只实施 M6-0：合同/validator/fixtures、资产/路径/DSH inventory、静态 guard、test:m6、架构文档。
4. 本地双平台可执行门取证，开 Draft PR；不得翻 gate、部署或碰真机。
5. M6-0 merge 后，逐波执行 M6-1→M6-7；每波必须满足上一波退出门，不并行跨越 live gate。

## 14. 审查裁决与最终决策记录

冻结 Plan V1 SHA-256：`B570BB03175DE3D8DFCCF62393F6B31F4385863C58DCFAE219CD82C6E702C507`；完整 packet SHA-256：`e7b771139248882c351ec168a2835273c540c1ec94f62b0b18869c47ad824133`。

外部批次为 degraded failure：coverage critic 首次截断、唯一恢复 schema-invalid；adversarial critic 上游 500、唯一 fallback 404。按 review gate 规则未增加 critic/第二轮，改由 routed GPT 做一次 fallback 裁决。

GPT fallback 接受并已修订的 P1：

- `ACCEPT P1-GRANT`：补上 AutonomyGrant 的可执行编译公式、一次起跑授权及与 M5 `requiresHuman` 的 additive 兼容方式。
- `ACCEPT P1-REDLINE`：新增独立 HardRedlinePolicy，多信号 + Control Plane 双重拦截，支付/删除不再只靠模型标签。
- `ACCEPT P1-GATE`：写清唯一 M6 live gate 与旧 CLOSED generic gates 的关系，避免既叠门又暗中旁路。
- `ACCEPT P1-AUTONOMY`：加入 ≥100-task autonomy benchmark、30-task single-alias smooth suite、零逐动作审批和延迟 SLO，防止只读演示冒充丝滑控制。

无外部有效 finding 可供接受/拒绝；无未决 P0/P1。以下架构决策冻结：

1. `ScreenFrameV1` 作为引用 `ObservationV1` 的 execution-grade envelope，而不是 ObservationV2。
2. 不修改 Action Ledger v1 语义；M6 先用 additive GroundedActionReceipt 引用它。
3. `agentic_session` 合同先定义但不进入可执行 enum，直到 worker/binder/gate 同 PR 落地。
4. 视觉源码与模型分离：可审源码进仓/锁定；大模型和 corpus 用内容寻址 artifact manifest，不默认进 Git。
5. M6 的 live action 走窄 grounded-action 接口，不让 DSH 直接使用现有 PrimitiveAction target。
6. 授权模型为 task-scoped AutonomyGrant；唯一系统级 hard redline 是支付与删除，其他动作按 goal 范围默认自主执行。
