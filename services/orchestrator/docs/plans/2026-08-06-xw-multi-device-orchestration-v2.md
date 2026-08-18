# xw 多设备 Lead/Worker 并发编排 v2

日期：2026-08-06  
修订：2026-08-08（P1a：入口对齐 + P1 契约落稿；**无设备执行**）  
实证 run：`run_20cfe70c-d29a-4806-92dd-3c95041e29d4`

## P0 实现状态（2026-08-06）

通用编排内核已在 Windows registry 本地实现，仍未触发设备任务：

- `xhs.task-plan.v2`：稳定 plan hash、node/shard、动态 placement、最多四 Worker、每机并发 1。
- `xhs.work-receipt.v1`：task/plan/node/shard/attempt/worker/device/capability fencing。
- Lead scheduler：依赖调度、不同设备并发、失败换机、从 receipt 学习 alias+capability 临时 blocker。
- typed-job Worker：live capability policy gate、route plan、正式 job submit/status、技术与业务双验收。
- parent ledger：固定进入 `outbox/work/<closeout-runId>/orchestration/`，显式 receipt refs，不扫描目录猜结果。
- reducer：选择 winning attempt，按 `(nodeIndex, shardIndex, itemIndex)` 输出，与完成先后无关。
- P0 只允许 `effectClass=none`，live capability 必须是 implemented、automatic、read_only/replay_safe、非 R2/R3。

本地入口：

```text
node ops/xw-mission.mjs create --input <authoring.json>
node ops/xw-mission.mjs validate --plan <plan.v2.json>
node ops/xw-mission.mjs preflight --plan <plan.v2.json>
node ops/xw-mission.mjs run --plan <plan.v2.json> --run <closeoutRunId> --actor <actor> --execute
node ops/xw-mission.mjs status --run <closeoutRunId>
```

`create`、`validate`、`preflight` 均不提交设备任务；`run` 缺少显式 `--execute` 时 fail closed。P1 Explorer workflow、P2 面板父子任务视图及任何外部效果均未在 P0 内实现。

## 结论

现有控制面已经具备可复用的执行底座：设备路由、typed job、session、可见 lease、同机互斥、共享 transport 锁、job events、verification、restoration、隔离与 closeout。四台设备的正式 job 已实证存在 2072ms 的共同执行重叠窗口，并且最终 4/4 成功。

缺的不是另一个设备控制面，而是它上面的一层耐久编排器：把一个自然语言任务编译成 phase/node/shard，按资源并发下发，把技术状态与业务验收分开，再按计划顺序汇总。

现有 Control Plane Mission v1 不适合直接承担这个职责。它是单 App、单账号、`parallelism=1` 的单设备授权容器，不是跨 App fan-out/reduce workflow。短期和中期都应在它外层新增 `xhs.task-plan.v2` 与 `xw-mission`，叶子动作继续复用正式 job/session。

## 本轮实证

| 场景 | 结果 | 说明 |
|---|---:|---|
| 02/03/04 小红书三个关键词，各取 3 条 | 0/3 业务通过 | 三路会话能并发，但空字段、更新提示、无关卡片被旧脚本误报为成功 |
| 02/03/04 微信余额 | 3/3 通过 | ¥278.27 / ¥3621.90 / ¥250.18；只读，无支付 transport/final commit |
| 01–04 异构 R0 job | 2/4 业务通过 | 四路共同重叠 4561ms；03 App 语义错配，04 adapter unavailable |
| 01–04 同一 XHS metrics | 1/4 通过 | 四路共同重叠 2127ms；暴露 device ready 不等于 capability ready |
| 01 Douyin + 02/03/04 XHS metrics | 4/4 通过 | 四路共同重叠 2072ms；verification/restoration 均通过 |

证据：`runtime/missions/run_20cfe70c-d29a-4806-92dd-3c95041e29d4/`。

## 目标模型

```text
用户目标
  -> Lead / Plan Compiler
      -> durable parent run
      -> phases / nodes / shards
          -> Worker 01 -> typed job 或 worker-owned session
          -> Worker 02 -> typed job 或 worker-owned session
          -> Worker 03 -> typed job 或 worker-owned session
          -> Worker 04 -> typed job 或 worker-owned session
      -> technical validator
      -> business validator
      -> deterministic reducer
      -> closeout bundle
```

并发规则：

1. 不同设备、依赖已满足、能力就绪的 shard 可以并发。
2. 同一设备同时只允许一个重业务 shard。
3. 含 `transport:xiaowei:22222` 的 job 可以与其他 job 重叠，但底层 transport 仍由全局锁串行；不得把 job 重叠写成底层线性加速。
4. Explorer session 必须由 worker 在真正开工时 JIT acquire，并在 `finally` release。Lead 不提前占用 60 秒 session。
5. 资金 final commit 永远停在人类确认前，transport 数保持 0。

## `xhs.task-plan.v2` 最小契约

```json
{
  "schemaId": "xhs.task-plan.v2",
  "schemaVersion": 2,
  "planId": "plan_<canonicalSha256>",
  "requestKey": "user-request-stable-key",
  "planHash": "<sha256>",
  "goal": "三机采集三个关键词，随后读取三机微信余额",
  "execution": {
    "maxWorkers": 4,
    "perDeviceConcurrency": 1,
    "sharedTransport": "serialized",
    "allowReassign": false
  },
  "nodes": [
    {
      "nodeId": "xhs_keyword_search",
      "nodeIndex": 0,
      "dependsOn": [],
      "executor": {
        "kind": "session_workflow",
        "workflowId": "xhs.search.posts.v2",
        "appId": "xhs",
        "replaySafety": "read_only"
      },
      "shards": [
        {
          "shardIndex": 0,
          "placement": { "alias": "02" },
          "params": { "keyword": "新疆旅行live图", "limit": 3 }
        },
        {
          "shardIndex": 1,
          "placement": { "alias": "03" },
          "params": { "keyword": "新疆原相机live", "limit": 3 }
        },
        {
          "shardIndex": 2,
          "placement": { "alias": "04" },
          "params": { "keyword": "新疆夏天live", "limit": 3 }
        }
      ],
      "acceptance": {
        "minItemsPerShard": 3,
        "requiredFields": ["postIdentity", "title", "author"],
        "rejectPageKinds": ["update_prompt", "login_wall", "captcha", "risk_control"]
      }
    }
  ],
  "reduce": {
    "orderBy": ["nodeIndex", "shardIndex"],
    "arrivalOrderIgnored": true,
    "judgeBy": "businessAcceptance"
  }
}
```

幂等规则：

- `requestKey + planHash` 相同：恢复同一 parent run。
- `requestKey` 相同但 `planHash` 不同：冲突，拒绝静默改任务。
- `shardKey = sha256(planHash, nodeId, shardIndex, canonicalParams)`。
- 正式 job key：`m2:<missionRunId>:<shardKey>:attempt-<n>`。
- 同一 attempt 重放复用；新 attempt 必须显式记录 `retryOfJobId`。

## Parent ledger 与关联字段

新增耐久账本，至少持久化：

```text
missionRunId
planId / planHash / requestKeyHash
nodeId / nodeIndex
shardId / shardIndex / shardKey
attemptIndex / retryOfJobId
actorId / alias / expectedApp
capabilityId 或 workflowId
paramsHash（敏感参数不进公共日志）
sessionId / leaseId / jobId / runId
technicalStatus / businessStatus
startedAt / heartbeatAt / finishedAt
verification / restoration / artifactRefs
```

建议先用 append-only JSONL + 每 shard receipt 落地，稳定后再迁入数据库。Reducer 只读计划显式列出的 receipt，不扫描目录猜结果。

## Worker 生命周期

Job worker：

1. 校验 parent/shard/attempt fencing tuple。
2. 读取 live gate，验证 device ready/free、capability policy、资源与能力依赖。
3. `route plan`。
4. `job submit`，立刻记录 jobId/runId。
5. 读取 job events，跟踪 queued/running/verifying/restoring/terminal。
6. 校验 verification/restoration 与业务字段。
7. 写原子 shard receipt。

Explorer worker：

1. 启动后 JIT acquire session。
2. 将 sessionId/leaseId 写入 parent ledger。
3. preflight。
4. 每个动作绑定同一 session，并记录 action jobId、屏幕原始尺寸和坐标 frame receipt。
5. 验证 expected package/activity、页面类型与业务结果。
6. `finally` release；异常也必须释放。

## Lead 如何用日志

Lead 不直接相信单个成功标志，而是分四层判断：

1. **Fleet 层**：agent-entry 的 ready/lease/quarantine/unresolved failure，用于设备级 gate。
2. **Capability 层**：adapter 端口、shared transport、App 登录态和 capability dependency，用于能力级 gate。
3. **Execution 层**：job events、heartbeat、verification、restoration、lease release，用于技术状态。
4. **Business 层**：expected app/package/activity、必填字段、数量、去重 ID、页面类型，用于最终验收。

本轮已证明：

- `ready=yes` 不能代表 XHS adapter 正常；
- `job succeeded + verification=true` 不能代表运行的是期望 App；
- `SEARCH=ok` 不能代表得到 3 条有效帖子。

因此 Reducer 的输入必须同时包含 `technicalStatus` 与 `businessStatus`。

## 返回顺序

网络返回和完成先后永远不决定用户看到的顺序。固定键为：

```text
(nodeIndex, shardIndex, attemptIndex)
```

同一 shard 有多个 attempt 时，只选择 attemptIndex 最大且同时通过技术与业务验收的结果；没有通过的 attempt 时，保留最后一次失败和完整错误链。总状态：

- 全部接受：`completed`
- 部分接受：`partial`
- 全部失败但资源已安全释放：`failed`
- 有验证码、风控、未知外部效果、recovery_required：`blocked`

## 重试规则

- `read_only` / `replay_safe` 且结果明确失败：可自动新 attempt。
- `ADAPTER_HTTP_UNAVAILABLE`：先恢复依赖服务，再用 R0 探针验证；禁止无脑原请求循环。
- 验证码、登录墙、风控、未知页面：停止，不自动重试。
- `ambiguous_on_timeout`、可能已有外部效果、`recovery_required`：停止，不重发。
- 支付或资金 final commit：永不自动重试，永远请求人类确认。

## 直接复用与新增代码

直接复用：

- `scripts/lib/task-plan.mjs`：自然语言到 capability/recipe 的现有解析基础。
- `scripts/lib/task-template.mjs`：参数校验、DAG 与 descriptor hash 基础。
- typed `job submit/status/events`：叶子 job。
- Explorer lease helper：worker-owned session。
- `ops/xw-closeout.mjs`：parent begin/step/close、证据封包。
- 控制面 device route、lease、queue、idempotency、verification、restoration。

新增：

1. `contracts/task-plan.v2.schema.json`
2. `scripts/lib/task-plan-v2.mjs`
3. `ops/xw-mission.mjs`
4. `ops/xw-mission-worker.mjs`
5. `scripts/lib/mission-reducer.mjs`
6. `contracts/mission-result.v1.schema.json`
7. `mission-runs/<run>/plan.json + shards/*.json + attempts/*.jsonl`
8. XHS 搜索与微信余额的业务 validator / workflow recipe

不要复用 Mission v1 的漏洞来做 fan-out。当前 Mission v1 的 active DeviceRun 数量与 alias placement 还存在单独需要修的硬闸；它仍应保持授权容器语义。

## 实施顺序

### P0：先让 Lead 可恢复、可排序

- 固化 v2 plan、shard/attempt receipt、稳定 idempotency key。
- typed job 的 4 机 fan-out、轮询、固定顺序 reduce。
- capability-specific readiness 与 expectedApp validator。
- 乱序返回、重复提交、worker crash、lease 清理测试。

### P1：纳入 Explorer workflow（契约修订 2026-08-08）

> **状态（2026-08-08）**：P0 typed_job 已 4/4 live；P1a–P1d **离线实现已绿**（catalog / plan 联合类型 /
> SessionWorkflowWorker + fake 四机 / compile-workflow）。真机 canary **未授权**，**不得**写成已上线。  
> **首轮 canary 业务**：微信余额只读（**不走 XHS**——locator / serve-exit blocker 仍在）。  
> **入口真源**：`C:\Users\windows 10\.agents\skills\xw\`（与 `.codex\skills\xw\` 同步）；
> 普通 `/xw task` **不**加载 Repair Inbox。

#### P1 目标（可验收句子）

1. 用户用自然语言 `/xw task plan|run` 描述「每台机器读微信余额」时，**计划阶段零碰机**。
2. 可执行后 begin **一个**父 closeout run，Lead 调度最多 4 个 Worker；每 Worker 对固定 alias 开工时
   **JIT** `session acquire`，lease 在 `GET /control/v1/leases` / 面板可见。
3. 叶子入口 = **`session`**；底层 capability = **`xiaowei.explorer.primitive`**；业务描述符 =
   **`workflow.wechat.balance-read.v1`**（`canary_only`，非 production 自动实点）。
4. 某台失败只在**原机**重试（`allowReassign=false`）；结果固定按 01→04 reduce；终态
   0 lease / 0 running job / 0 pending approval。
5. 共享 22222 对外口径固定为：**任务并发、传输串行**。

#### P1 分段交付

| 段 | 交付物 | 碰机？ | 退出标准 |
|---|---|---|---|
| **P1a** | Skill 双份对齐；本设计稿 P1 契约 | 否 | `.agents`≡`.codex`；契约可独立审阅 |
| **P1b** | Workflow Catalog + TaskPlan v2 `session_workflow` 联合类型 + 离线 schema/单测 | 否 | validate/create 接受联合类型；假数据绿 |
| **P1c** | `SessionWorkflowWorker` + 消除全局 session identity 单例 + fake control plane | 否 | 四假机 fan-out 绿；release 全路径 |
| **P1d** | `/xw task plan|run` → `xw-mission`（NL 编译；plan 零碰机） | 否 | plan 不 submit；run 需显式 gate |
| **P1e** | 微信余额 workflow 描述符 + canary 闸门（仍离线） | 否 | descriptor + validator 单测绿 |
| **Canary** | 单机 → 双机 → 四机 → 余额 1→4（另开授权轮） | 是 | 见下方分层验收；人确认后才开 |

#### 1) 统一 `xw` 入口（P1a）

- **真源**：`.agents/skills/xw/SKILL.md` + `references/task-orchestration.md`。
- **镜像**：`.codex/skills/xw/` 必须同内容（含 references）；改一处同步另一处。
- **Repair**：仅 `/xw repair` / 点名 Inbox / proposalId；普通 task/run/explore/skills **禁止**
  list/claim/展示 Inbox（历史 `.codex` 冷启动「每次必查 Inbox」已废止）。
- **当前实现缺口（不得伪装已通）**：
  - `scripts/lib/task-plan-v2.mjs`：`EXECUTOR_KINDS` 仅 `typed_job`。
  - `ops/xw-mission.mjs`：仅 `TypedJobWorker`。
  - `ops/xw-task.mjs`：live plan 永久 `executionReady=false`（`task_executor_binding_required`）。
  - `ops/_explore-session-action.mjs`：`pinnedIdentity` 进程级单例 → 同进程多 Worker 互斥冲突。

#### 2) 独立 Workflow Catalog（P1b）

Session workflow = **多 action + session cleanup**，**禁止**伪装成单 job Recipe。

最小描述符（版本化，建议路径 `contracts/workflows/<id>.v1.json` 或单文件 catalog）：

```json
{
  "schemaId": "xhs.workflow.v1",
  "workflowId": "workflow.wechat.balance-read.v1",
  "version": 1,
  "appId": "wechat",
  "maturity": "canary_only",
  "entry": "session",
  "capabilityId": "xiaowei.explorer.primitive",
  "replaySafety": "read_only",
  "effectClass": "none",
  "resources": ["transport:xiaowei:22222"],
  "expectedApp": {
    "package": "<wechat-package>",
    "activityIncludes": ["<balance-or-wallet-activity-fragment>"]
  },
  "actions": [
    { "actionId": "launch_or_focus", "primitive": "launch_app", "..." : "..." },
    { "actionId": "navigate_wallet", "primitive": "tap|dump_ui|...", "requires": "trusted_capture_permit_if_tap" },
    { "actionId": "read_balance", "primitive": "dump_ui|screen", "extract": "unique_amount_cny" }
  ],
  "acceptance": {
    "requiredFields": ["amountCny", "currency", "capturedAt"],
    "amountMustBeUniqueOnScreen": true,
    "paymentTransport": 0,
    "finalCommit": false,
    "privacy": { "publicKnowledge": false, "redactInCommonLogs": ["amountCny"] }
  },
  "placement": {
    "compileMode": "one_shard_per_alias",
    "fixedAliases": ["01", "02", "03", "04"],
    "allowReassign": false
  }
}
```

Registry / 发现：

- 新增 `GET /api/workflows` 与可选 `GET /api/workflows/:id`（只读；loopback 可读）。
- `/xw skills`（`ops/xw-skills.mjs`）同时发现四类：**capability / recipe / workflow / foundation**。
- workflow 默认可列 `canary_only` 为「暂不可用 / 需 canary」，不得标「可直接运行」除非 maturity
  与 live gate 同时满足 production 条件（P1 首条明确 **不** 满足 production）。

#### 3) TaskPlan v2 联合类型（P1b）

```text
executor.kind ∈ { "typed_job", "session_workflow" }
```

| 字段 | `typed_job`（P0） | `session_workflow`（P1） |
|---|---|---|
| 主键 | `capabilityId` | `workflowId`（+ 底层 `capabilityId` 固定 explorer primitive） |
| 叶子 | `job submit` | `session acquire` → actions → `release` |
| placement | 动态 eligible / 可换机（P0 学习） | **“每台机器”→ 01–04 固定 shard**，`allowReassign=false` |
| 失败重试 | 可按策略换机（P0） | **仅原 alias** 新 attempt |
| effect | P0 限 `none` | P1 首条同限 `none`；资金 finalCommit 永不自动 |

编译规则（自然语言「每台 / 四机 / 01-04」）：

1. 展开为 `fixedAliases` 四个 shard（缺机则该 shard `blocked`/`skipped` 按 policy，不静默并到别机）。
2. `execution.allowReassign` 对 session_workflow 节点强制 `false`。
3. `shardKey = sha256(planHash, nodeId, shardIndex, alias, canonicalParams)`（含 alias，防重绑）。
4. 幂等：action 级 key 确定性  
   `m2:<missionRunId>:<shardKey>:a<actionIndex>:attempt-<n>`（或等价规范；写入 ledger）。

Schema：`contracts/task-plan.v2.schema.json` 与 `scripts/lib/task-plan-v2.mjs` 同步放宽
`EXECUTOR_KINDS`；非法 kind 仍 fail closed。

#### 4) SessionWorkflowWorker（P1c）

生命周期（每个 shard / Worker 实例）：

```text
validate fencing
  -> (optional) preflight readiness for alias + workflow
  -> JIT session acquire   // 不在 Lead 预占
  -> ledger: sessionId, leaseId
  -> for each action:
        deterministic idempotency key
        POST session action (primitive)
        record jobId/runId/frame receipt (raw screen size + coords if any)
  -> business + technical validate
  -> write shard receipt
  -> finally: session release   // 一切出口，含 throw
```

硬约束：

- **消除** `ops/_explore-session-action.mjs` 进程级 `pinnedIdentity` 单例；改为
  **每调用 / 每 Worker 实例**持有 identity（或 context-file 绑定），同进程四机不得互踩。
- 每个 action 的 job/run/frame 写入 parent ledger；Reducer 不扫盘猜。
- lease 必须在控制面可见；无 lease 的 GatewayOperator / 临时脚本 = 入口违规。
- `tapAuthorized=false` 时：计划可含导航意图，但 **无** trusted-capture one-shot permit 则
  `executionReady=false` 或 canary 闸门失败，**禁止**冒充 production 自动实点。

#### 5) `/xw task` → `xw-mission`（P1d）

| 用户语义 | 行为 | 碰机 |
|---|---|---|
| `/xw task plan <NL或任务名>` | 补参 + 编译 TaskPlan v2 + 展示 gate；**不** begin、**不** submit | 否 |
| `/xw task` / prepare | 本地模板补参；参数不全不占 lease | 否 |
| `/xw task run`（或确认开始后的执行） | 模板/`executionReady` 通过 → `xw-closeout begin` → `xw-mission run --execute` | 是（仅 gate 后） |

要求：

- 用户**无需**手写 authoring JSON 作为主路径（调试仍可 `xw-mission create --input`）。
- `executionReady=true` 仅当：workflow/capability live 可证、设备 ready/free、无命中 blocker、
  effect 闸通过、（若需 tap）permit 可证。
- 一个父 run 贯穿；status/resume 重读 live，不复用旧 lease。

#### 6) 首条业务竖切：微信余额（P1e + Canary）

- `workflowId`：`workflow.wechat.balance-read.v1`
- `maturity`：`canary_only`
- `expectedApp`：package/activity 必须校验；错 App → technical 或 business fail（不得 accepted）
- 金额：**屏上唯一**可解析 CNY 金额；多候选 → fail closed
- 隐私：金额与账户证据 **不** 写入公共 knowledge；ledger/harvest 可红acted 或 run 私有
- 强制：`paymentTransport=0`、`finalCommit=false`；违反 → blocked，永不自动重试
- 微信空 dump 若需自动导航：必须先接通 trusted-capture one-shot tap permit；当前
  `tapAuthorized=false` **不能**标 production
- **不做**：XHS 搜索竖切（留给 blocker 清除后的后续轮次）

#### 7) 分层验收（每层都要：lease 可见、同机并发 1、结果 01→04、22222 口径、终态归零）

| 层 | 内容 | 通过标准 |
|---|---|---|
| L0 离线 | fake control plane + 单测/集成 | 相关 suite 全绿；无真机 API |
| L1 单机无动作 session | 真机 acquire → no-op/list → release | lease 可见→归零；1/1 |
| L2 双机 | 两 alias 并行 session workflow（只读） | 2/2 或诚实 partial；互不串 identity |
| L3 四机 | 01–04 fan-out | 4/4 或诚实 partial；reduce 序固定 |
| L4 余额 1→4 | 微信余额 canary | 金额唯一；transport/finalCommit=0；隐私不进公共 KB |

L1+ 每轮结束后 agent-entry：`ready/free`、`activeLeases=0`、`runningJobs=0`、`pendingApprovals=0`。

#### P1 明确不做（推 P2 或另案）

- 控制面/面板 parent→node→shard 可视化（P2）
- cancel remaining / 跨机 reassign session shard
- XHS 搜索业务 validator 生产化（等 serve/locator blocker）
- 把 draft 抖音真实转发模板晋级 implemented
- 扩大 Standing Grant / 支付 final commit 自动化

### P2：治理与控制面展示

- 控制面/面板显示 parent -> node -> shard -> attempt -> job/session。
- 按 parent 查询 events、失败原因、完成率。
- cancel remaining、retry safe shard、resume parent。
- closeout 自动引用 parent ledger 与 shard artifacts。

## 验收矩阵

1. 四台分别执行不同 R0 capability，4/4，证明异构 fan-out。
2. 四台执行同一 workflow、参数不同，结果按 shardIndex 排序。
3. 三个小红书关键词各返回 3 条具稳定 ID/title/author 的帖子。
4. 三台微信余额只读返回，payment transport/final commit 均为 0。
5. 随机打乱 worker 返回顺序，最终输出不变。
6. 同 key 重放不重复执行；同 key 不同 plan 拒绝。
7. 一个 worker 失败时其他 worker 正常收敛，总状态 partial。
8. worker 崩溃后 lease 可回收，parent 可从 ledger 续跑。
9. technical succeeded 但 expectedApp/业务 schema 不符时，结果必须失败。
10. 最终 0 active lease、0 running job、0 pending approval、无残留 worker。

## 当前已知 blocker

- 01 的 XHS FastOperator 17895 当前未监听；设备级仍显示 ready=yes。它不影响 01 的 Douyin 能力，但禁止把 01 当作 XHS-ready，直到能力级探针通过。
- XHS 三关键词采集当前业务验收为 0/3，需先修结果解析与更新提示识别，再谈批量采集产能。
- 现有 shared 22222 是单实例全局锁；四路 job 并发不等于四路 transport 同时执行。
