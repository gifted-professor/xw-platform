# `/xw task` 长任务编排

## 目录

1. 定位与对象
2. 命令与交互
3. 参数补齐
4. Run / Explore 编排
5. 外部效果确认
6. 运行、检查点与续跑
7. 完成后收纳
8. 任务模板契约
9. 边界与失败处理

## 1. 定位与对象

把 `/xw task` 用作可参数化、可续跑、可收纳的组合任务入口。不要要求用户选择 Run 或 Explore。

- **Task Template**：保存稳定目标、参数定义、默认值、步骤意图、效果预算和检查点策略。
- **Task Run**：绑定模板 revision、本次参数、plan、确认范围、唯一 closeout `runId`、进度和证据。
- **Capability / Recipe**：设备执行单元。Task 只引用和编排，不成为第二个控制面。
- **Workflow（P1）**：多 action + session cleanup 的版本化业务描述符；**不是**单 job Recipe 的别名。
- **Explore gap**：当某一步没有正式能力或页面漂移时，只升级该安全步骤，不把整个任务改成 Explore。

模板不得保存 ADB、GatewayOperator、原始 shell、临时坐标或旁路命令。真正设备动作继续使用正式
capability/recipe 或带可见 lease 的 Explorer session。

### 实现边界（2026-08-11，P1 已有受控 canary；尚未晋级生产）

| 层 | 状态 | 对 `/xw task` 的含义 |
|---|---|---|
| P0 `typed_job` 编排 | 已 4/4 live 实证 | 只读 R0 capability fan-out 可用（经 `xw-mission` + authoring plan） |
| P1 `session_workflow` | 离线 worker 已接；余额 workflow 保持 `canary_only` | 可 `compile-workflow` 出 plan；未经授权不得 begin 真机 fan-out |
| `ops/xw-task.mjs` → runner | balance 有显式 runner binding；最新模板仍为 draft | `task run` 固定拒绝 draft；不回退旧 revision |
| Workflow Catalog / `GET /api/workflows` | **源码已加**（部署后 live 可读） | `/xw skills --all` 可发现 canary workflow；默认不标可直接运行 |
| 首条业务竖切 | 微信/支付宝/微购余额只读（均 `canary_only`） | `/xw balance` 是 Task 快捷入口，不是独立权限 |
| Repair Inbox | 与 Task 解耦 | 普通 task 回复不加载、不展示 Inbox |

离线编译示例（零碰机）：

```text
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-task.mjs compile-workflow --goal "每台机器读取微信余额"
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-mission.mjs validate --plan <plan.v2.json>
```

叶子入口约定（P1 目标，实现后才生效）：`session`；每 Worker lease 必须在
`GET /control/v1/leases` 或面板可见；底层 capability=`xiaowei.explorer.primitive`；
业务 workflow 例=`workflow.wechat.balance-read.v1`。共享 22222 只称「任务并发 / 传输串行」。

## 2. 命令与交互

支持以下用户语义；`run` 可省略。它们是 xw 层的用户语义，不等同于当前本地目录工具的子命令：

```text
/xw task                              # 列出常态任务
/xw list                              # 同上；默认只列稳定可运行任务
/xw task <任务名> [参数]              # 补参、计划并准备执行
/xw task plan <任务名|自然语言目标>    # 只预览，不碰设备
/xw task list
/xw task list --all                   # 展开 draft / runner 未接等设计中任务
/xw task show <任务名>
/xw task status current|run=<runId>
/xw task resume current|run=<runId>
/xw task save current [name=<名称>]
/xw task 收纳当前任务 [名称=<名称>]
/xw balance [alias[,alias...]] [--apps wechat,alipay,weigou]
```

最新模板是 `draft` 时，只允许补参、预览和继续设计，不创建业务 run；不能回退到旧的 implemented revision
绕过草案状态。没有模板匹配时，把用户描述作为一次性 Task 草案：编译已有能力，未知安全步骤进入 Explore。多个模板
相近时只问一个最小澄清问题。`current` 只指当前对话明确持有的 run；上下文丢失时要求显式 `runId`，
禁止扫描 outbox 猜测。

### 稳定目录准入

默认 `/xw task` / `/xw list` 不是所有模板文件的罗列。一个任务必须同时满足以下条件才进入默认目录：

1. 最新不可变 revision 的 `status=implemented`；最新若是 draft，不回退旧 implemented。
2. `catalog.visibility=listed`（旧 implemented 模板可由目录层推断分组，但仍须满足其它条件）。
3. 存在显式 Task runner binding，实际可从 `/xw task run` 进入；只有 Markdown、脚本或模板文件不算。
4. 目录按 **App → 业务功能 → 具体任务** 分组；跨 App 任务可归到主要目标 App，并记录 sourceApps。

`--all` 用于设计、诊断和晋级，不代表其中条目可以执行。

### 青岛飞书 → 闲鱼上架

`task.xianyu.qingdao-idle-listing@1` 是首条默认稳定任务，归在“闲鱼 → 发布”。它采用一个 run 的两阶段协议：

1. `fill`：按 SKU 读飞书与下载图片；图片推送逐台持可见 Explorer session，长操作每 20 秒 heartbeat，
   finally release；填表用正式
   `xianyu.publish.full_dry_run`，默认 01/02，停在发布页。成功后保存 run-scoped checkpoint，输出
   `taskRunId / plan / planHash / maximumPublishCount`，不关闭 run。
2. `publish`：人目检并确认后，必须以同一 `taskRunId` 续跑，且 plan 路径与 SHA-256 均和 checkpoint
   完全一致；同时要求 `--confirm-external-effect`。底层仍二次要求 `--i-confirm-live-publish`。
3. 发布后必须在目标商品详情同时命中“刚刚擦亮”+“管理”+详情锚点，并确认已知托管提示已清；只有通过
   正向证据的设备才可写回飞书“闲鱼已发布设备”，然后关闭原 run。任何发布或写回未完整验证都 close
   为 partial；timeout/未知 external effect 记 `unverified`，须先人工核查外部状态，禁止自动重发。

目录登记不授权未来发布；每个新 run 都重新确认。03/04 不进入默认 aliases。

`/xw balance` 精确匹配 `task.balance.read-all`。当前 revision 为 draft：普通调用只补参/预检，
`xw-task run` 返回 `template_is_draft`。独立工程 canary 必须由人明确授权，并经
`ops/xw-balance.mjs --execute --canary-authorized` 进入；三个 App 子脚本只接受父 Task 传入的同一个
`--task-run-id`。子脚本释放各自 Explorer session，父 Task 每台只做一次正式 HOME job，然后统一 close。
金额不得进入公共 knowledge，`paymentTransport=0`、`finalCommit=false`。

## 3. 参数补齐

先读取模板：

```text
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-task.mjs prepare --task "<任务名>" [--params <json>]
```

一次性询问全部缺失的 required 参数，同时展示默认值。不要连续问五轮，也不要把本次关键词默认保存到
下次。接收人、附言、续跑等可保存为默认，但每次必须在外部效果摘要中展示。

用户只输入任务名时，使用这种短格式：

```text
已匹配「抖音关键词图文采集并转发」草案（尚未执行，也未占用设备；当前只能补参和预览计划）。

请补充：
- 关键词：
- 每词数量：

可修改默认值：接收人=天才较瘦；续跑=是；去重=是。
固定约束：真实转发；仅图文；附言=已验证的飞书同款字段格式+搜索词。
直接回复：关键词=新疆秋天live,新疆雪景live；每词数量=30
```

若模板为 draft，再补一句：“参数补齐后只展示计划、最大外发数量和接收人，不创建业务 run 或发送。”

空关键词、重复关键词和非法数量先归一化，再集中显示问题。参数完整前不创建业务 run、不占 lease。

## 4. Run / Explore 编排

模板每个步骤只保存声明式 `intent`。在每次执行时，把每个步骤分别交给现有 TaskPlan 与 live catalog：

1. implemented capability 精确匹配 → Run。
2. implemented recipe 精确匹配 → Run。
3. 步骤、implemented recipe 或已收纳 workflow 声明需要视觉区域定位时，TaskPlan 自动加入
   foundation 依赖 `locator.visual-block.v1`；Explore 安全步骤也自动继承，不要求模板重复手写。
4. 已收纳 workflow 有明确 workflowId、实现绑定且当次状态仍可证明 → 在它规定的正式入口内复用。
5. 无正式能力但步骤只读/可逆、policy 允许 → Explore。
6. 状态不可证明或未知步骤跨越外发、删除、支付提交点 → Blocked / Human gate。

`locator.visual-block.v1` 的输入必须来自同一 Explorer session 的 trusted capture，输出只允许引用
`blockId`，不得把 Vision 裸坐标直接传给 tap。定位信任顺序固定为：semantic bounds → 同会话可信截图
图层块 → fail closed。当前 Locator 只负责定位/验证，固定 `tapAuthorized=false`；计划若包含自动实点，
仍须标 canary，并在当次 trusted capture 上取得 one-shot permit。没有 permit 时计划可预览/验证，
但必须 `executionReady=false`，不得夸大为生产自动实点。

Explorer 可以探到外部提交前并生成 recipe 候选；不得因为用户确认了整批任务，就用未知 Explorer
路径旁路真实发送。已固化的外发 workflow 仍按原权限执行。

计划摘要只显示用户需要确认的内容：步骤用途、Run/Explore 分类、最大效果数、接收人、恢复和续跑策略。
自动加入的 foundation 依赖也要显示其用途和 `tapAuthorized=false` 边界。

## 5. 外部效果确认

只有模板为 `implemented` 且当次 live plan 可证明可执行时，参数冻结后才计算并请求真实外发的统一确认。
draft 只展示效果预览，禁止显示“确认开始”、禁止 begin：

```text
本次计划：3 个关键词，每词最多 20 条；最多向「天才较瘦」发送 60 条；仅图文；
附言为已验证的飞书同款字段格式+对应搜索词；自动去重并保存进度。
回复「确认开始」执行，或直接说明要修改的参数。
```

确认凭证绑定模板 revision、规范化参数、接收人、最大效果数量和 plan hash。下列变化必须重新确认：

- 更换接收人；
- 增加关键词或数量；
- 修改附言或效果类型；
- 新建 Task Run；
- 计划语义发生变化。

同一 run 在原预算内续跑可沿用确认；支付 final commit 永远按 live policy 单独确认。

## 6. 运行、检查点与续跑

前提是模板为 `implemented`、live plan 可证明且（需要时）确认已经通过，之后才执行 `xw-closeout begin`。
draft 即使参数完整也不 begin。全为已知步骤时用 `runner`；包含 Explore gap 时用
`explorer`；整条 Task 始终只持有一个 closeout `runId`。每个阶段写 step，并注明实际走 Run、Explore、
Blocked 或 Human gate。

把检查点保存到明确 run 命名空间：

```text
outbox/work/<runId>/checkpoints/<stageId>/<itemHash>.json
```

不要复用全局 `sent.json`。去重键至少绑定模板、接收人、关键词和帖子身份。暂停或停止时先保存检查点、
释放 session，再验证无残留进程。

resume 必须重读 release、capability、ready/lease 和 blocker，不复用旧 lease。若某条“可能已发送但回执
不确定”，标记 `unverified` 并停止；禁止为凑数自动重发。

## 7. 完成后收纳

首次稳定完成或步骤发生可复用变化时，主动提出 Task Template：

```text
本次完成 60/60，可收纳为常态任务。
建议名称：抖音关键词图文采集并转发
每次参数：关键词、每词数量
可修改默认值：接收人=天才较瘦；续跑和去重开启。
固定约束：真实转发；仅图文；已验证的飞书同款字段格式+搜索词。
回复「确认收纳」，也可以说「收纳，但接收人每次都问」。
```

收纳时：

1. 只使用当前对话明确持有的 closeout run。
2. 区分本次值、可变参数、稳定默认和固定安全规则。
3. 生成 `xhs.task-template.v1` 显式 JSON，并运行 `xw-task.mjs validate`。
4. closeout completed 且通过 Windows 自动收编闸门 → status=`implemented` 后 `save`。
5. partial / blocked / 证据不足 → 仅保存 draft，不进入默认调用。
6. 同名模板变化 → 新 revision，不覆盖旧版；无语义变化 → 只积累运行证据，不反复收纳。
7. 进入默认目录还必须补齐 `catalog` 分组元数据与显式 runner binding；否则即使 implemented 也只在
   `--all` 中显示为 `runner_binding_required`。

收纳模板不等于授权下次外发。Task Template 进入目录后才可以说“下次可按任务名调用”；只有
adoption receipt、没有目录模板时，只能说“证据已采纳”。

## 8. 任务模板契约

模板至少包含：

```text
schemaId / schemaVersion
templateId / revision / name / aliases / status / description
catalog（appId/appLabel、functionId/functionLabel、visibility、sortOrder、可选 sourceApps）
parameterSchema（type、required、default、prompt、validation）
steps（id、kind、intent、dependsOn；不放原始设备命令）
effectPolicy（kind、confirmation、quantity、recipient）
checkpointPolicy（resume、dedupe、uncertain effect）
originRunId / descriptorHash
```

本地目录与参数预览命令（不负责 `status/resume`；这两个用户语义由 closeout run 与检查点处理）：

```text
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-task.mjs list
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-task.mjs list --all
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-task.mjs show --task "<名称>"
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-task.mjs prepare --task "<名称>" --params <params.json>
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-task.mjs plan --task "<名称>" --params <params.json>
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-task.mjs run --task "<名称>" --params <params.json> --execute
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-task.mjs validate --input <template.json>
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-task.mjs save --input <template.json>
```

青岛闲鱼两阶段 runner：

```text
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-task.mjs run --task "青岛飞书闲鱼" --params <params.json> --actor <actor> --execute
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-task.mjs run --task "青岛飞书闲鱼" --params <same.json> --phase publish --run <taskRunId> --plan <plan> --confirm-plan-hash <sha256> --confirm-external-effect --actor <same> --execute
```

模板 revision 不可原地覆盖；相同内容重复 save 返回 `already_saved`。
`run` 只接受 `implemented` 且存在显式 runner binding 的模板；draft 返回 `template_is_draft`，
未绑定模板返回 `task_executor_binding_required`。

## 9. 边界与失败处理

- “采集”实际包含转发时，在计划中明确写“采集并转发”；`save_only` 才是无外发。
- 接收人重名或无法唯一验证时，在发送前停止。
- 已验证的飞书同款字段附言构建器不可用或模板失效时，在发送前停止，不降级为空附言。这里的“飞书字段”
  是既有结构化附言格式，不表示每次任务都重新读取飞书表格；若任务需要从飞书生成关键词，应另设来源阶段和参数。
- 页面漂移时只允许安全步骤 Explore；未知真实提交点停止。
- capability/recipe 运行中降级时保存进度并重新计划，不旁路。
- 可复用步骤未注册到正式 capability、implemented recipe 或 foundation catalog 时，只能作为候选或
  Explore gap；不得把“脚本存在/本轮跑通”写成交付完成，也不得让 Task 自动依赖未注册对象。
- 数量超过 live policy 时拆批并重新确认，或阻止执行。
- 收纳失败或不完整任务时只生成 draft。
