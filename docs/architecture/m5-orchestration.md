# M5 只读编排层（Task Router + DAG Compiler）

源码 only。M5 定义上层编排合同（`xw.orchestration.task-classification.v1`、`xw.orchestration.dag.v1`），提供两个纯函数编译器：

- **Task Router**（`services/orchestrator/scripts/lib/task-router.mjs`）—— 自然语言目标 → 确定性任务分类，无 LLM、无 IO、fail-closed。
- **DAG Compiler**（`services/orchestrator/scripts/lib/dag-compiler.mjs`）—— 分类结果 + 已注册 skill catalog → 冻结执行 DAG。

M5 不改 Control Plane、不接手机、不接 DSH、不开 Graph、不碰 SQLite / control.db / registry.db / ADB / 22222 / GatewayOperator。`DSH_LIVE` / `MULTI_AGENT_LIVE` / `OPEN_ACTION_LIVE` 保持 CLOSED。

## 输入 → 输出

```text
goal（自然语言或结构化 { text }）
  + 版本化 Skill 注册清单（SkillSpec + SkillVersionRef + executor + effectContract）
  + 可用设备数（1-4）
        │
        ▼
  Task Router ──► xw.orchestration.task-classification.v1
        │          taskType ∈ { search, collection, validation, needs_human }
        │          parallel / workers / strategy / validatorRequired / sourceSkills
        ▼
  DAG Compiler ──► xw.orchestration.dag.v1
                   nodes（skillId + inputs + dependsOn + targetAliases）
                   executionReady / humanGate / planHash / dagId
```

- Router 输出 `needs_human`（含原因）时 **DAG Compiler 拒绝编译**（`DAG_COMPILE_NEEDS_HUMAN`），绝不猜测成可执行 DAG。
- 外发类目标（发布/点赞/关注/私信/评论/收藏/转发/上传/下单/购买/删除/取消订单/退换/编辑资料/改昵称/发帖/提交表单）→ `needs_human.external_effect_not_allowed`，**禁止编入只读编排**。

## Task Router 规则（确定性，无 LLM）

| 命中 | taskType | strategy | parallel |
| --- | --- | --- | --- |
| 外发动词 | needs_human | none | false |
| 搜索/查找/检索/对比/多源 | search | fan_out_reduce | true |
| 验收/校验/核对/确认 | validation | sequential_validate | false |
| 采集/刷/浏览/首页/每台/四台 | collection | alias_fan_out_reduce（含 `0[1-4]`）否则 fan_out_collect | true |
| 未命中任何规则 | needs_human | none | false |

- `workers` 钳在 `[1,4]`，由设备数决定上限。
- 每个具体类型都必须存在对应 role 的注册技能；缺失 → `needs_human: no_registered_<role>_skill`（fail-closed）。
- goal / params 出现 `lease|transport|payment|capabilityId|executor|rawCommand` 键 → `TASK_FORBIDDEN_FIELD` / `DAG_FORBIDDEN_FIELD` 抛错。
- 输出深冻结；`classificationHash` / `planHash` / `dagId` 均为输入内容 SHA-256（canonicalize 排序后哈希），同输入必得同哈希。

## DAG 编译规则

- 节点 skillId 只能引用 catalog 内已注册技能（否则 `DAG_COMPILE_UNREGISTERED_SKILL`，防御性检查）。
- catalog 条目必须携带完整 `skillVersionRef`（`urn:xw:contract:skill-version-ref:v1` 六字段）；缺则 `DAG_CATALOG_ENTRY` 编译失败——不编造版本信息，与 M4-D plan-compiler 一致。
- 依赖有环 → `DAG_COMPILE_CYCLE`；引用未知节点 → `DAG_COMPILE_UNKNOWN_DEP`。
- localValidator 节点必须是终端（`DAG_COMPILE_VALIDATOR_NON_TERMINAL` 防御）。
- effect 只能来自版本化注册清单，并由正式 capability 合同复核；调用方传入旧式 `externalEffect` 会被拒绝。外发类技能**优先不选**；仅当某角色 catalog 全为外发技能时才回落 → 该节点 `requiresHuman=true`，DAG `executionReady=false` + `humanGate=WAIT_HUMAN`。
- 只读 DAG（无 requiresHuman 节点）→ `executionReady=true`、`humanGate=null`，可自动执行。
- `catalogHash` 覆盖 SkillVersionRef、可信 effect 和 executor 绑定；`planHash` 覆盖完整节点结构（包括 `requiresHuman`、`localValidator`、effect、参数和依赖），`dagId = dag_<planHash 前 16 hex>`。

## Skill 注册真源

生产入口只从 `services/orchestrator/contracts/m5-skill-catalog.v1.json` 加载注册项。加载器逐项验证：

- SkillSpec 与完整 SkillVersionRef 的 canonical hash 一致；Git `sourceCommit:sourcePath` 的 blob 必须匹配。
- capability executor 必须出现在 SkillSpec.requiredCapabilities，且正式能力合同为 implemented + automatic；effect 必须与能力合同一致。
- local validator 必须为 effect=none、零设备 capability，并实际导出登记函数。

M5 首批只注册正式只读 `xhs.observe.feed` 和既有本地 `validateBusinessOutput`。`wechat.observe.balance` 仍是 dependency_pending 草案，不进入 M5 catalog。

## 合同

| 合同 | 文件 | 说明 |
| --- | --- | --- |
| skill-catalog.v1 | `packages/kernel/contracts/orchestration/skill-catalog.v1.schema.json` | 版本化 Skill 注册与可信执行/effect 绑定 |
| task-classification.v1 | `packages/kernel/contracts/orchestration/task-classification.v1.schema.json` | Router 输出形状 |
| dag.v1 | `packages/kernel/contracts/orchestration/dag.v1.schema.json` | Compiler 输出形状 |
| trace-event.v1 | `packages/kernel/contracts/orchestration/trace-event.v1.schema.json` | 七类持久编排事件 |

两者已在 `packages/kernel/contracts/manifest.v1.json` 的 `orchestrationContracts` 注册。

## 测试

- `services/orchestrator/tests/task-router.test.mjs` —— 分类确定性、needs_human fail-closed、外发动词、alias 解析、workers 钳制、forbidden 字段、hash 确定性。
- `services/orchestrator/tests/dag-compiler.test.mjs` —— 三种 taskType 节点结构、validator 终端、外发 WAIT_HUMAN、混合 catalog 非外发优先、forbidden 字段、确定性 dagId/planHash、params 注入。
- 机器门：`npm --prefix services/orchestrator test`、`npm --prefix services/orchestrator run check`。

## 边界（M5 不做）

- 不做真实设备执行：DAG 只冻结结构，执行/占点/结果回写属于后续波次（M5-B runtime/trace、M5-C CLI + 真机验收）。
- 不写任何 state：TraceStore append-only JSONL 属 M5-B，本层零 IO。
- 不碰 lease：DAG 不含 lease 语义，`executionReady` 不代表可租设备。

## M5-B 持久 Trace

- `TraceStore` 默认从 `XW_RUNTIME_ROOT` 或 runtime layout 读取 `state/orchestrator/trace`；文件名为 `sha256(traceId).jsonl`，不会把任意 traceId 拼成路径。
- 每次 append 都先校验已有 JSONL 的 traceId、连续 seq、eventId 和合同，再落盘；只有持久化成功后才调用 onPersisted。坏 JSON、半行、断序、磁盘失败均 fail-closed。
- payload 禁止 token/secret/authorization/cookie/password/credential/payment/rawValue 等敏感键和 credential-like 文本；单事件默认上限 64 KiB。
- `queryTrace({harnessSessionId})` 保持 M4-B 原返回形状；新增 `queryTrace({traceId})` 可在 session close 或新 runtime 实例后读取有序事件与完整性摘要。
- 既有 TaskPlanV2 scheduler 只增加可选 trace bridge，不复制调度逻辑；映射 WorkerAssigned、SkillStarted、SkillFinished、RepairTriggered，并仅在整体 technical + business acceptance 成功时写 ValidationPassed。
