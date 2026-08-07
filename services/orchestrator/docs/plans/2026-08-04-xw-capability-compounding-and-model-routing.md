# `/xw` 默认复用、能力进化与模型路由计划

## 总结

北极星：任何手机任务先编译成结构化执行计划，默认复用已有 capability 或 recipe；确定步骤走纯脚本，有限判断交给便宜模型，未知探索和修复才升级到强模型，最终确认进入人工层。每一步绑定可校验的落盘证据。

优先级固定为：成功率 > 证据完整性 > 成本。Token 作为持续优化指标记录，不设硬性预算门槛。

## 核心改造

### 1. 先修复可信发布基础

- 修复 `review-run-bundle` 缺失依赖，并兼容现有 `xhs.task-closeout-manifest.v1`、旧 explorer bundle 和历史枚举。
- 保留 [`xw-closeout.mjs`](C:/Users/Public/xhs-registry/ops/xw-closeout.mjs) 的现有 sealed contract；新增 recipe spec 作为带 hash 的 artifact，由 evolve bundle 再次密封。
- 发布闸加入 clean-worktree、tracked-content hash 和测试结果校验，避免未跟踪代码随控制面重启进入生产。
- 统一 capability JSON Schema 与实际 loader 字段，并要求 adapter 明确提供 `execute/verify/restore`。
- 清理当前 capability 数量测试的硬编码，并把现有脏工作树作为独立现场保留。

### 2. 建立任务编译器与四级路由

统一入口为 `/xw <自然语言目标>`，同时保留 `plan/run/explore/recover/repair` 供显式控制。

新增 `xhs.task-plan.v1`：

- 记录标准化意图、参数、步骤 DAG、依赖、候选 capability/recipe、预期效果、恢复和证据要求。
- Resolver 顺序固定为：正式 capability → published recipe → capability 组合 → Explorer → Repair。
- L0：所有步骤和参数均确定，纯脚本执行，无模型调用。
- L1：仅剩意图分类、参数提取或有限选项，使用便宜模型和 JSON Schema 输出。
- L2：未知页面、定位漂移、新流程或源码修复，交给强模型。
- L3：资金最终提交、权限政策变更、外部效果歧义及人工验收。
- 每次记录实际模型层级、调用次数、token、耗时、升级原因和最终结果；成功模式逐步编译到更低层级。

### 3. 建立独立 Recipe Catalog

新增不可变的 `xhs.recipe-candidate.v1` 和 `xhs.recipe.v1`。第一阶段 executor 限定为一个现有正式 capability 的参数化包装：

```text
recipeId, revision, appId, intentAliases, inputSchema
executor.capabilityId, executor.paramsTemplate
preconditions, assertions, restoration, validityEnvelope
riskCeiling, descriptorHash, originRunId, evidenceHashes
```

Registry 新增：

- `recipe_versions`：不可变 spec、revision、hash、状态和来源。
- `recipe_attempts`：append-only 的 run/job、结果、验证、恢复、release 和证据。
- `recipe_transitions`：状态变化、原因、actor 和 receipt hash。
- `evolve_queue`：由 closeout 后的显式 enqueue 写入，worker 无需扫描目录猜测。

状态机：

```text
observed -> candidate -> replay_verified -> promotable
         -> canary_only -> implemented -> degraded -> retired
```

历史 knowledge recipe 全部保持 `observed`，其 `resolved` 或 `verifiedBy` 状态不直接产生执行资格。

### 4. 自动 Replay、灰度 Manifest 与反馈

新增 Windows scheduled task `xw-evolve-worker`，通过正式 `devicectl job/session` 和可见 lease 执行，每轮最多处理一个候选。

晋级规则：

- 两次独立成功：不同 run/job；同设备时至少跨两个 worker 窗口并重新启动、重新观测页面。
- 每次均要求 terminal succeeded、verification 为真、所需 restoration 为真、证据完整、无歧义和高等级 debt。
- 达标后生成密封的 runtime wrapper manifest，状态为 `canary_only`。
- 再完成两次独立回归后转为 `implemented`，进入普通 `/xw` 默认解析。
- Manifest 的风险、幂等、策略和 eligible alias 继承并收紧底层 capability；runtime overlay 不修改 Git 真源和设备配置。
- 环境类失败如 lease busy、设备离线、无 eligible device 仅排队重试。
- descriptor/policy 漂移、外部效果歧义、证据或恢复失败立即降级；连续两次语义断言失败同样降级。
- 修复产生新 revision，旧 revision 与全部历史证据保持不可变。

控制面增加固定路径的 generated-overlay 原子 reload，携带预期 SHA256；校验失败时继续使用上一份 catalog。Feature flag 支持 `off/shadow/canary/active`。

### 5. 第二阶段受控 Recipe Interpreter

包装型闭环通过后，再加入白名单步骤：

```text
callCapability, dump, focus, screenshot, tapSelector
swipe, input, back, launch
```

所有 primitive 在 leased session 内执行，包含 typed 参数、超时、前置断言、后置断言、恢复和证据采集。语义 selector 为主，坐标仅作为绑定设备和版本的 fallback。执行面只包含正式 capability 与上述 typed primitive。

## 接口与命令

- `POST /api/task-plans`：编译任务并返回步骤、模型层级及匹配依据。
- `GET /api/recipes`、`GET /api/recipes/:id`：查询 published/canary/degraded recipe。
- `POST /api/recipes/ingest`、`POST .../attempts`、`POST .../reviews`：写入密封证据，状态由服务端推导。
- `ops/xw-evolve.mjs enqueue|ingest|replay|evaluate|status`：后台闭环入口。
- `/api/task-packet` 保持兼容，内部改为读取 TaskPlan 和 Recipe Catalog。
- `/xw skills` 默认展示正式 capability 与 implemented recipe；`--all` 展示候选、canary 和 degraded。

## 测试与验收

- 保持 closeout self-test 32 项全绿，并修复当前 review test 启动失败。
- 覆盖 bundle/spec/receipt 篡改、路径逃逸、重复 ingest、重复 run 去重、revision 不可变和并发幂等。
- 覆盖两次 replay 进入 canary、再两次进入 implemented，以及质量失败降级、环境失败保持原状态。
- 验证生成 manifest 只能继承或收紧底层 capability 的风险、策略和设备范围。
- 验证 L0 零模型调用、L1 只接收 schema 约束输出、未知任务进入 L2、人工门禁进入 L3。
- 首个端到端试点使用 `douyin.observe.snapshot` 与 `douyin.observe.search`，分别覆盖无参数和带参数任务。
- Rollout 顺序：shadow 只生成计划 → alias 01 canary → 四次独立成功 → active。
- Rollback：关闭 generated-overlay flag，静态 capability catalog 与历史证据保持原状。

## 已定默认

- Windows 是执行与 evolve worker 权威；Mac 继续负责静态源码治理。
- 第一阶段只包装现有 R0/R1、`read_only/replay_safe` capability。
- 自动 manifest 是 runtime wrapper，不扩大权限，也不自动写 Git 源 manifest。
- 模型配置按 `L0/L1/L2/L3` 抽象映射，具体模型可替换。
- Token 仅用于统计、比较和后续下沉优化。

## Stall / LLM 升级契约（2026-08-05）

北极星补充：**接 LLM = 脚本路径至少降级失败**，不是常态油门。触发看 UI 是否冻结，不看单纯 wall-clock。

| 信号 | 含义 |
|------|------|
| `evidenceDir/progress.jsonl` | 每步心跳：`phase/name/step` + `dumpFingerprint` + 时间戳（**超时后仍可读**） |
| dump/画面指纹连续不变 ≥ `XIANYU_STALL_MS`（默认 45s） | 标 `stall` + `llmEscalationRecommended=true` + `diagnosisHint=stuck_or_slow` |
| 指纹再次变化 | `stall_cleared`（更像「慢」而不是「卡」） |
| 仅 `ADAPTER_TIMEOUT` 且无 progress | **契约违规**——无法区分慢/卡 |

落地：`scripts/lib/stall-progress.mjs` + `createStepSupervisor(evidenceDir)` + xianyu `publish-dry-run`/`full-draft`；adapter `execute` 必须传入控制面 `evidenceDirectory`。

## 实施记录


- 2026-08-04：计划正文落盘本路径（此前仅存在于 Codex Plan 会话，未写入磁盘）。
- 2026-08-04 Phase 1（可信发布基础）：
  - 从 Mac 源仓同步 `scripts/lib/evidence-contract.mjs`、`task-closeout-contract.mjs`、`repair-*.mjs`、完整 `review-run-bundle` + `contracts/*.json`。
  - `review-run-bundle` 兼容 explorer / closeout / historical schema；review tests **13/13**；closeout self-test **32/32**。
  - routing：capability schema 对齐 `availability`/`description`；`AdapterRegistry` 强制 `execute/verify/restore`；去掉 capability 数量硬编码；新增 `scripts/assert-release-gates.mjs` 并接入 `control-plane-worker.ps1`；`task-launch.json` 保留 `allowDirtyWorktree:true`（脏树现场）。
- 2026-08-04 Phase 2–3（task-plan + Recipe Catalog）：
  - `scripts/lib/task-plan.mjs`、`scripts/lib/recipe-catalog.mjs`、`ops/xw-evolve.mjs`；registry 路由 `GET/POST /api/recipes*`、`POST /api/task-plans`；已重启 `XhsDeviceRegistry` 生效。
  - 单测 recipe/task-plan/recipe-spec 合计绿。
- 2026-08-04 Phase 4（overlay / evolve worker）：
  - **routing** `control-plane/lib/generated-overlay.mjs` + bootstrap 挂载；feature flag `XHS_RECIPE_OVERLAY_MODE`
  - **registry** overlay 原子写、`xw-evolve-worker.mjs`、`install-xw-evolve-worker.ps1`
- 2026-08-05 全量授权收尾：
  - `/xw skills`：`ops/xw-skills.mjs`（default implemented recipes；`--all` 含 candidate/canary）；closeout 自动挂 `recipe_spec`
  - Phase 5：`recipe-interpreter.mjs` plan-only whitelist（已 commit `daa9763`）；worker 接线 `586b6ac`
  - Douyin 已进 git；`allowDirtyWorktree=false`；release gates **clean**；`task-launch.gitCommit=586b6ac…`；`recipeOverlayMode=shadow`
  - 已注册计划任务 `XhsXwEvolveWorker`（30min，Interactive）
  - E2E alias **01**：`douyin.observe.search` 4/4 succeeded → recipe `douyin.observe.search.wrap` **implemented**（overlay 已写）；`douyin.observe.snapshot` 首跑 succeeded，后续重试 ADAPTER_FAILED → wrap 仍 **candidate**（1 independent success）
  - **控制面未 reload**：02 悬挂 `waiting_approval:xianyu.publish.full_draft_dry_run`（runningJobs≠0）；shadow overlay 需人处理该审批后才能按红线重启控制面加载
