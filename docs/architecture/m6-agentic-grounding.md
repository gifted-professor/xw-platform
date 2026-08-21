# M6 Agentic Grounding 架构

基线：`docs/plans/M6-task-brief.md`（V2, READY_FOR_EXECUTION）。本文档冻结责任矩阵、动作时序、AgenticSessionWorker 状态机、失败语义、授权编译公式、live gate 关系与 ADR。M6-0 只交付合同与文档，不翻任何 live gate、不碰真机。

## 1. 责任矩阵（任务书 §4）

| 组件 | 唯一责任 | 明确禁止 |
|---|---|---|
| M5 Router/DAG/Scheduler | 分类、DAG、依赖、alias、worker 调度、失败隔离、汇总 | 视觉推理、坐标、直接设备动作 |
| AgenticSessionWorker | DSH 进程生命周期、工具桥、checkpoint、receipt、trace | 自己解释屏幕、自己执行设备动作 |
| DSH/Cordis plugin | 模型循环、选择 block、决定下一工具调用 | ADB、端口、坐标、lease、DB、payment |
| Grounding Runtime | 稳定帧、视觉分块、block 解析、安全落点、stale/ambiguity 检查 | 绕 Control Plane 派发动作 |
| Control Plane | session/lease/action authority、任务级授权、设备 I/O、Action Ledger、reconcile | 接受未授权 raw coordinate/model command，支付或删除动作 |
| Trace/Evidence Store | 内容寻址附件、事件关联、审计证据 | 保存秘密、token、原始支付值 |

收敛原则：只存在一条链路 `M5 assignment + AutonomyGrant → AgenticSessionWorker → DSH subprocess → Grounding Tool API → Grounding Runtime → Control Plane session/action authority`。既有 `xw-locator` 退化为诊断 CLI（调用同一 Grounding Runtime），不产生第二套 locator、第二套 action executor 或第二本账。

## 2. 动作时序（任务书 §4，固定 9 步）

1. Worker 获得 M5 assignment；通过正式入口申请 session/lease。
2. Worker 启动 pinned DSH 子进程，传入最小 session capability token/reference，不传设备 transport 信息。
3. `phone_observe` 请求 execution-grade stable frame。
4. Grounding Runtime 获取 screenshot A、dump/focus、screenshot B；稳定性和敏感区域检查通过后冻结 frame。
5. DSH 只选择 `blockId`；落点不稳时先自动重观测、滚动、返回或换策略，服务端将有效 block 解析为一次性内部落点。
6. Control Plane 在 dispatch 前复核 AutonomyGrant、lease、frame freshness、focus/page fingerprint、硬红线、Action Ledger 幂等键。
7. Control Plane 执行动作并写 ledger；返回只含引用的 receipt。
8. Worker 重新 observe/verify，写 checkpoint；异常时先 reconcile 并在预算内自动恢复，只有目标本身是支付/删除、需要扩大原始任务范围或恢复预算耗尽才 `WAIT_HUMAN`。
9. 结束顺序固定：停止新工具调用 → checkpoint/reconcile → revoke session → release lease → terminate DSH → close worker receipt。

## 3. AgenticSessionWorker 状态机

```text
IDLE
  → ASSIGNED            收到 M5 WorkAssignment（authorizationMode=task_grant）
  → GRANT_VERIFIED      AutonomyGrant + hard-redline policy + lease 校验通过（否则 → FAILED_CLOSED）
  → DSH_STARTING        启动 pinned DSH 子进程（一 WorkerRun 一进程）
  → RUNNING             工具循环：observe → ground → act → verify → checkpoint
  → RECONCILING         故障/结果丢失：查 Action Ledger，禁止盲重放
  → WAIT_HUMAN          仅 hard stop / 范围扩张 / 恢复预算耗尽
  → CLOSING             固定收尾：停工具 → checkpoint/reconcile → revoke → release → terminate DSH
  → CLOSED              receipt 关闭，资源归零（lease/process/session 全部为 0）
  → FAILED_CLOSED       任何契约/gate/授权校验失败的默认终态（fail closed）
```

约束：`RUNNING` 内模型在有效 grant 下连续执行，不查询 gate、不产生逐动作审批；`RECONCILING` 只有确认动作未执行才允许同 operationKey 重试；`CLOSING` 顺序不可交换（先 revoke 后 kill）。

## 4. 失败语义

| 决策/状态 | 触发条件 |
|---|---|
| `REPLAN` | 视觉歧义（多候选块、空 dump、分类未知）、位于确认弹窗/支付页/订单页/资产页/破坏性设置页且语义不确定、frame stale/焦点变化、范围外但可换策略、自动恢复预算未耗尽 |
| `HARD_STOP` | 动作 intent 或目标 block 的任一信号（OCR/semantic/resourceId/a11y/icon label、页面风险 fingerprint）命中支付/删除硬红线类别；DSH/grant/live config 均不可覆盖 |
| `WAIT_HUMAN` | 目标本身是支付/删除、需要扩大原始任务范围、或自动恢复预算耗尽（仅这三种） |
| `FAILED_CLOSED` | 换帧/焦点变化/页面变化/超时/歧义下 blockId 失效；gate 关闭；grant/policy/capability 任一缺失 |

## 5. 授权编译公式（任务书 §5.4）

```text
effectiveScope = registered AgenticSkillSpec maximum
               ∩ compiled TaskIntentSet
               ∩ actor/device/time/budget limits
               − hardRedlineSet
```

- `AgenticSkillSpec` 列出 action families、apps、数据范围、max budgets、verification obligations。
- Router/Compiler 把 goal 编成 `TaskIntentSet`；无法唯一确定 app/skill/action family 时只在任务开始前澄清一次，不生成宽泛 grant。
- Control Plane 强制执行设备/app/action family/时间/次数/redline；模型不能扩大 app、设备、目标、预算或动作类别。
- 每次 action 携带 grant ref 只是本地机器校验，不是人工审批或远程往返。
- agentic node 只有在 `authorizationMode=task_grant` + 有效 grant ref + hard-redline policy 同时存在时可运行，否则 fail closed；旧 skill 与 `authorizationMode=per_node` 语义不变。

## 6. 唯一 live gate 与旧 gate 的关系（任务书 §7）

- M6 只有一个运行开关 `M6_AGENTIC_LIVE_GATE`，默认 CLOSED，记录 release/actor/sourceCommit/lock hashes/skill/alias allowlist/到期时间/closeout；单机到四机通过扩大同一 canary allowlist 渐进发布。
- replay、observe-only、single-alias、multi-alias 是执行模式/rollout stage，不是逐步审批。
- 支付/删除是更低层不可覆盖的 hard-deny firewall：M6 config、grant、模型或管理员误开 live gate 都不能放行；原有支付 firewall 继续保持。
- 既有 generic Open Action、fixture DSH、graph-v2、multi-agent legacy live flags 保持 false；M6 不借它们开门，也不旁路它们调用旧 generic executor。
- 新 Grounded Action endpoint 与 AgenticSessionWorker 只认 `M6_AGENTIC_LIVE_GATE + AutonomyGrant + 正式 session/lease`，在独立 namespace/profile 字段 `agenticGroundingEnabled` 下启用。
- 请求落入旧 PrimitiveAction/raw-coordinate endpoint 时，即使 M6 gate 开着也拒绝；M6 gate 关闭时新 endpoint 与真实 DSH worker 均拒绝启动。

## 7. ADR（任务书 §14，六条冻结决策）

1. **ADR-M6-1**：`ScreenFrameV1` 作为引用 `ObservationV1` 的 execution-grade envelope，而不是 ObservationV2。
2. **ADR-M6-2**：不修改 Action Ledger v1 语义；M6 先用 additive `GroundedActionReceipt` 引用它。
3. **ADR-M6-3**：`agentic_session` 合同先定义但不进入可执行 enum，直到 worker/binder/gate 同 PR 落地。
4. **ADR-M6-4**：视觉源码与模型分离：可审源码进仓/锁定；大模型和 corpus 用内容寻址 artifact manifest，不默认进 Git。
5. **ADR-M6-5**：M6 的 live action 走窄 grounded-action 接口，不让 DSH 直接使用现有 PrimitiveAction target。
6. **ADR-M6-6**：授权模型为 task-scoped AutonomyGrant；唯一系统级 hard redline 是支付与删除，其他动作按 goal 范围默认自主执行。

## 8. M6-0 配套机器可读资产

- `services/orchestrator/contracts/m6/vision-inventory.v1.json`：视觉实现 inventory + 外部路径基线（三个兼容例外：xw-locator、xw-start、wechat-ocr，M6-1 清零）。
- `services/orchestrator/contracts/m6/visual-assets.lock.v1.json` + kernel schema `xw.visual-assets.lock.v1`：资产来源/版本/hash/许可/安装方式；未知许可资产不提交进仓。
- kernel schema `xw.replay-corpus-manifest.v1`：replay 语料内容寻址、强制去标识、禁止账号/设备/token/余额字段。
- `services/orchestrator/contracts/m6/autonomy-benchmark.v1.json`：102 个非红线任务 + 中途人工介入/逐动作审批计数口径。
- `services/orchestrator/contracts/m6/smoothness-slo.v1.json`：bridge p95 ≤100ms、grounding decision p95 ≤1s、observe-to-dispatch 非模型开销 p95 ≤4s；阈值调整必须显式计划变更。
- `tools/m6/external-path-guard.mjs` / `tools/m6/dsh-inventory-check.mjs`：静态门。

## 9. M6-1 落地状态：离线 Grounding Runtime 与 replay corpus

M6-1 交付了唯一 `GroundingRuntime`（`services/orchestrator/scripts/lib/m6/m6-grounding-runtime.mjs`），收敛原则已落实：旧 `xw-locator` 退化为调用同一 runtime 的诊断 CLI，不保留独立算法；三个机器外兼容例外（xw-locator、xw-start、wechat-ocr）全部清零，external-path-guard violations=0。

- **唯一 GroundingRuntime**：`freezeFrame` → `segmentBlocks` → `decide` → `resolveInternalPoint`。blockId / block-set integrity / grounding decision id 全部复用 M6-0 `m6-contracts.mjs` 派生函数，payment/delete 走 `m6-hard-redline.evaluateHardRedline` 多信号 + Control Plane 双重拦截，provider 无法覆盖安全策略。
- **hermetic fixture provider**：CI 唯一 provider，零外部模型权重，内容寻址自哈希，Windows/Linux 一致；真实 provider（Cordis/DSH/OCR）在 M6-3 接入但 contract 不变。
- **evidenceStore**：内存内容寻址；bounds/point 只存 opaque ref，模型面不含坐标/pixel/base64；落盘版（`xw-runtime` canonical root，原子写 + hash 校验）在 M6-2。
- **≥200 replay corpus**：`services/orchestrator/contracts/m6/replay-corpus.v1.json`（208 frames / 832 entries），全合成、去标识、`validateReplayCorpusManifest` 递归敏感 key 扫描通过；覆盖弹窗/键盘/旋转/广告/空 dump/重复块/敏感标签/滚动/permission-dialog/status-bar/system-nav。
- **确定性 metrics receipt**：`services/orchestrator/contracts/m6/grounding-metrics.v1.json`。退出门实测：block recall 100%、top-1 100%、safe-region 100%、forbidden/misclick/stale=0、determinism=true、decision p95 < 100ms（远低于 1s SLO）。
- **SLO 冻结**：`smoothness-slo.v1.json` 的 `hardwareProfile`（m6-1-calibration-hermetic）与 `modelProfile`（m6-1-hermetic-fixture-provider, locked=true）已填入并冻结；真实 DSH/Cordis profile 在 M6-3 另立。
- **xw-start / wechat-ocr 清零**：xw-start 视觉恢复分析改为 `XW_VISUAL_RECOVERY_*` env 显式配置（未设置 fail-closed），wechat-balance-extract / xw-balance-shared 的 PaddleOCR 默认 venv 路径删除，改要求 `XHS_PADDLE_OCR_PYTHON` 显式提供；非视觉路径（ADB、runtime root）不动。
- **零 live**：未翻 `M6_AGENTIC_LIVE_GATE`、未碰真机、未改 DB schema、未发 release、未把 `agentic_session` 加入可执行 enum；支付/删除 hard-deny 保持。
