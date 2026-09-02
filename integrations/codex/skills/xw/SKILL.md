---
name: xw
description: >-
  Windows 小薇人工入口：/xw skills 查看正式 capability + implemented recipe（--all 含
  candidate/canary/degraded）；/xw task 按 App→功能列出稳定常态任务，并负责创建、补参、编排、续跑和收纳；
  /xw balance 是三平台余额只读 Task 快捷入口；/xw messages 是小红书消息页未读只读检查；/xw bench 对已固化只读链路做 N 次计时重跑并输出路径优化候选；
  /xw start 幂等启动 Registry/控制面/四台 serve，并用正式 audited recovery + R0 job 有界收敛到任务可运行；/xw locator 定位弱语义界面；/xw run 用自然语言匹配并运行已固化能力；/xw explore 探索未知面；/xw recover 精确恢复指定隔离/未就绪设备；
  /xw repair 处理源码债。默认未知单步目标走 Explorer，组合或常态任务走 task；Repair 只在明确点名时加载。
---

# xw — Windows 开工入口

> **Skill 唯一真源**
> `C:\Users\Public\xw-fusion\xw-platform\integrations\codex\skills\xw\`。
> `.agents` 与 `.codex` 下的副本只由仓库同步器投放，不直接编辑。
> 普通 `/xw start|task|balance|messages|bench|run|explore|skills|locator|recover` **不**查询、不展示、不 claim Repair Inbox；
> 仅用户点名 `/xw repair`、Repair Inbox 或 proposalId 时才加载修复路径。

把 `xw` 当成一个入口，不是新的控制面：它只读取现有 registry、根 Skill 和 live 状态，
再把任务路由到 Explorer、正式 capability、设备恢复；Repair Inbox 只在点名时进入。

## 用法

```text
/xw start [alias[,alias...]] [--check]
/xw skills [xhs|xianyu|alias|关键词] [--all]
/xw task [任务名|自然语言目标]
/xw task plan|list|show|status|resume|save ...
/xw list [--all]
/xw xianyu-idle <SKU>
/xw balance [alias[,alias...]] [--apps wechat,alipay,weigou]
/xw messages [alias[,alias...]] [--home]
/xw session list|show|validate|save-as-task|issues|stats
/xw bench plan|run|report
/xw locator <目标描述> [alias|--input <截图>]
/xw run <自然语言目标或 capability id> [alias]
/xw explore <App / 页面 / 未知目标> [alias]
/xw recover [alias|deviceId]
/xw repair [proposalId]
/xw close current
/xw close run=<runId>
/xw harvest current|run=<runId>    # close 的同义别名
```

- `/xw` 无参数：只显示上面入口和一句示例，不执行任务。
- `/xw start`：幂等准备基础设施与设备基础 readiness；`--check` 只给计划，不启动服务、不提交 job。
- `/xw <未知目标>`：按 Explorer 处理。
- `/xw task <目标>`：用户不需要判断 Run 或 Explore；按步骤动态组合，并在完成后收纳参数化模板。
- `/xw task` / `/xw task list`：默认只列 `implemented` 且有显式 runner binding 的稳定常态任务，按
  **App → 业务功能 → 任务** 分组；`/xw list` 是同义快捷入口。`--all` 才展示 draft、未接 runner 等设计中条目。
- `/xw xianyu-idle <SKU>`：精确解析为稳定 Task `task.xianyu.qingdao-idle-listing`；先 fill 停页，
  人目检确认后再以原 run + plan hash 续跑 publish。
- `/xw balance`：`task.balance.read-all` 的快捷入口；默认只做 Task 预检，未晋级前不得省略 canary 闸门直接碰机。
- `/xw messages`：小红书消息页未读只读检查（Explorer session）；不进会话、不回复；用户写 `/xw messages` 即开工确认。
- `/xw session`：通用 run session 账本。`list/show/validate/stats` 只读；`save-as-task` 把一场成功 run 收纳成 draft Task（不继承外发授权）；`issues` 按场分流 pitfall/repair。积木执行器是 `ops/xw-xhs-explore-run.mjs`，live 需 `--execute --canary-authorized`。
- `/xw bench`：对 messages / compose locate 等只读零效果链路做 N 次重跑，聚合每步耗时并输出优化候选。默认 source-only；`--execute` 才碰机。候选不自动改路径。
- `/xw locator <目标>`：只生成/核验图层块与 `blockId`，不执行点击；Task 与 Explore 在需要时会自动调用，
  用户通常无需单独指定。
- 用户显式写 `/xw start`、`/xw run`、`/xw explore`、`/xw messages` 或 `/xw recover`，已经构成本轮普通只读/可逆任务的开工确认；
  检查通过后直接执行，不再重复问一次。
- 支付、真实外发、删除、账号安全和其他不可逆动作始终单独等人确认。

## `/xw` 04 快车道 — 自主选路（RECIPE / DUMP / VISION / STOP）

当目标是 alias `04` 的普通 R0/可逆小红书任务（搜索、浏览、dump、截图、输入、滑动、返回、启动 App）时，
Claude **不逐步问人选路**，自行按下列顺序选择并执行；完整状态机、失败计数、视觉单击与沉淀规则见
[references/adaptive-04.md](references/adaptive-04.md)。

```text
exact 04 Recipe + 画像/页面断言匹配  -> RECIPE
否则 fresh dump 唯一目标            -> DUMP
dump 空/稀疏/歧义 -> fresh screenshot -> VISION
任一路径撞红线或同一目标累计两次失败 -> STOP
```

- 只碰 alias `04`；01–03 仍只读，不自动切换。
- 碰机只走正式 Explorer session/lease（`xw-explore-session acquire` → `--session-file`）；禁止裸 ADB / 直连 22222。
- 每次 run 仍走强制 closeout 生命周期；关键 decision step 带 `adaptiveDecision`（route / reasonCode / profile / targetFailureCount / assertion）。
- VISION 单击用 `ops/xw-adaptive-visual-tap.mjs`：先 `--probe` 验证本 runtime 能读 PNG 出结构化块（不能则 `STOP/VISION_RUNTIME_UNAVAILABLE`），再在同 session、同新鲜截图上校验块（越界/低置信/同名歧义/系统区/红线 label 全拒）并执行一次 tap，只回 blockId/jobId/evidence ref，不回可复用坐标。
- 同一 `goalSignature + observed profile` 成功两次后自动生成 `candidate` Recipe（离线校验后进服务端 04-only extras；客户端 inline Recipe 禁 live）。正式 Catalog 晋级仍走原 `evaluatePromotion()` 阈值，不混为一谈。
- 支付/转账/充值、删除/注销/改密、系统权限、验证码/风控/登录墙立即 `STOP`；这些永远不进快车道，仍单独等人确认。

## Task closeout 生命周期（强制）

每次由 `/xw start|task|balance|messages|session|locator|run|explore|repair|recover` 启动的业务任务必须绑定唯一 `runId`，结束时落盘；
不改变上述权限与执行语义，只增加收口契约。

1. **begin（任务一开始就做）**

   ```text
   node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-closeout.mjs begin --mode <explorer|runner|repair|engineering|recover> --actor <actor> --goal "<本轮任务目标>"
   ```

   - `run` → `--mode runner`；`explore` / `messages` → `explorer`；`repair` → `repair`；`start/recover` → `recover`；其它工程收口 → `engineering`。
   - `--goal` 必填：用一句话写清本轮任务目标（不要空字符串）。
   - 输出 JSON：`taskId` / `runId` / `startedAt` / `goal`。必须在**同一次** `/xw` 任务上下文中持有该 `runId`。
   - begin 会写 `outbox/work/<runId>/task.json`；不碰设备、不扫描目录。

2. **执行中（最短 step 规则）**

   关键脚本、关键判断、卡点或业务效果发生后，调用一次：

   ```text
   node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-closeout.mjs step --run <runId> --input <explicit-step-json-path>
   ```

   - 只记关键节点，不记每次点击。
   - **close 前 `steps.jsonl` 至少有一条**；缺 step 不能报 `completed`。
   - 脚本、截图、job、飞书回执等证据都显式绑定这个 `runId`；不得另起隐式 run。

3. **close / harvest（任务结束必须做）**

   ```text
   node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-closeout.mjs close --run <runId> --input <explicit-json-path>
   ```

   - `/xw close current` 与 `/xw harvest current`：**只能**使用本次 `/xw` 启动时 begin 得到的 `runId`。
   - 上下文丢失时必须要求用户给 `run=<runId>`；**禁止**扫描 `outbox`、`tmp-know`、`_explore`、runs 根或整机猜测。
   - `--input` 必须是显式 JSON 路径；只读取其中列出的 sources / artifact refs，禁止 glob、目录递归、绝对 artifact path、`..`。
   - closeout 自身不得碰设备、提交 job/session、claim Repair、部署、reload、replay 或 mark deployable。
   - 若 `candidates` 含 `kind=recipe`：close 会用 `sealRecipeSpec` 密封 spec（可带可选
     `recipeSpec`/`capabilityId`/`appId`），写入 work ledger 与 harvest `recipe-specs/`，
     并在 artifacts 中挂 `kind=recipe_spec`（供 `xw-evolve enqueue` 读取）。

4. **落盘位置**

   ```text
   C:\Users\Public\xw-runtime\state\orchestrator\outbox\work\<runId>\
     task.json
     steps.jsonl
   C:\Users\Public\xw-runtime\state\orchestrator\outbox\harvest\<runId>\
     closeout.v1.json
     manifest.json
     manifest.sha256
   ```

5. **任务结束必须输出（失败也要说清）**

   ```text
   CLOSEOUT run=<runId> status=<completed|partial|blocked|unverified> result=<created|already_harvested>
   bundle=C:\Users\Public\xw-runtime\state\orchestrator\outbox\harvest\<runId>
   manifestSha256=<64hex>
   localAdoption=<accepted|review_required>
   macReview=<not_required|pending>
   ```

   - close 失败：输出 `CLOSEOUT_FAILED <原因>`，不得用聊天总结代替落盘，也不得因此重跑业务动作。
   - close 后按下节“证据式自动收编”判定；满足闸门时 Windows 可本地收编，Mac 不再是固定前置条件。

### 证据式自动收编（Windows）

closeout 创建成功后，若本轮产生了 recipe / knowledge / repair 等候选，运行：

```text
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-auto-adopt.mjs adopt --from <harvest-bundle> --requested <计划数> --completed <完成数> --active-leases 0 --running-jobs 0 --residual-processes 0 --unresolved-failures 0 [--user-confirmed]
```

仅在以下条件全部成立时输出 `localAdoption=accepted`、`macReview=not_required`：

- closeout=`completed`，无 blocker / remaining work；全部 checks=`pass`；无中高等级 evidence debt。
- 完成率不低于 95%，并且用户明确确认 OK；或样本不少于 20 且完成率不低于 98%。
- 结束时无活动 lease、运行 job、残留进程或未解决失败。
- 不涉及支付、资金 transport 或 final commit。

任一条件不成立即 `review_required`，继续交人工或 Mac；不得降低运行时权限。自动收编只确认流程可复用，
以后真实外发、删除、支付等动作仍按每次运行的原权限重新确认。

## `/xw task` — 参数化组合长任务

当用户描述多阶段、会重复执行、数量较多、需要检查点或希望完成后复用的工作时，使用 `/xw task`。
先完整读取 [references/task-orchestration.md](references/task-orchestration.md)，再执行以下核心规则：

1. 无参数时先显示稳定任务目录：只有最新 revision=`implemented`、目录 visibility=`listed` 且存在显式
   runner binding 的模板才能进入默认列表；按 App→功能分组。`--all` 才显示 draft / runner 未接等条目。
2. 有目标时先精确匹配 implemented Task Template；若最新 revision 是 draft，只做补参和计划预览，不开始执行；
   无匹配则建立一次性草案。不要让用户选择 Run/Explore。
3. 一次性询问全部缺失必填参数，同时展示默认值；参数完整前不占 lease、不创建业务 run。
4. 对每个步骤分别用 live TaskPlan/capability/recipe 判断 Run、Explore、Blocked 或 Human gate。
5. 真实外发在参数冻结后汇总最大数量与接收人，只确认一次；计划语义或预算增加时重新确认。
6. 用一个 closeout `runId` 贯穿整条 Task；检查点进入该 run 的命名空间，续跑重读 live 状态。
7. 完成后提出“收纳当前任务”：把固定流程、可变参数和默认值生成不可变 Task Template revision；
   通过自动收编闸门后才标记 implemented，失败或证据不足只保存 draft。
8. 收纳模板不授权未来外发，也不把 Task 变成第二个控制面；设备动作仍只走正式 job/session/Explorer lease。

### 首条稳定常态任务：青岛飞书 → 闲鱼上架

- Template：`task.xianyu.qingdao-idle-listing@1`；目录：闲鱼 → 发布；快捷别名：`/xw xianyu-idle`。
- 每次必填 `sku`；默认 aliases=`01,02`、库存 10、包邮。填充阶段读取飞书与图片，图片推送逐台持可见
  Explorer session、长操作每 20 秒 heartbeat、finally release；填表走正式
  `xianyu.publish.full_dry_run`，并停在发布页，不产生真实发布。
- 填充成功后输出同一个 `taskRunId`、plan 与 `planHash`，状态为 `awaiting_publish_confirmation`。
  人目检并明确确认后，发布续跑必须同时匹配原 run、原 plan、原 hash；任一变化 fail closed。
- 真实发布仍须裸 flag `--confirm-external-effect`，底层再次要求裸 flag `--i-confirm-live-publish`；发布后
  必须在目标商品详情同时命中“刚刚擦亮”+“管理”+详情锚点，并确认托管提示已清；只有这样才写回飞书
  “闲鱼已发布设备”并关闭唯一 Task run。timeout/未知结果记 `unverified`，禁止盲目重发。
- 目录登记不构成未来发布授权；每个新 run 都重新确认。03/04 不进入默认 aliases，只有人本轮明确指定才可扩大。

## `/xw balance` — 三平台余额只读 Task 快捷入口

`/xw balance` 固定解析为 `task.balance.read-all`，不是独立能力、第二套权限或三个脚本的串联别名。

```text
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-task.mjs prepare --task "/xw balance"
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-balance.mjs [--aliases 01,02,03,04] [--apps wechat,alipay,weigou]
```

1. 当前最新模板为 `draft`，三个底层 workflow 为 `canary_only`；普通 `xw-task run` 必须返回
   `template_is_draft`，不得暗示已正式可运行。
2. 独立工程 canary 只能在设备 `ready/free`、无活动 blocker，并由人明确授权后使用
   `ops/xw-balance.mjs --execute --canary-authorized`；未授权时 fail closed。
3. `ops/xw-wechat-balance.mjs`、`ops/xw-alipay-balance.mjs`、`ops/xw-weigou-balance.mjs`
   是父 Task 内部执行器；真跑必须收到同一个 `--task-run-id`，不得作为日常入口单独执行。
4. 整条 Task 只 begin/harvest 一个 closeout；子执行器各自释放 Explorer session，父入口最后对每个
   touched alias 只提交一次正式 R0 HOME job，再统一 close。
5. 未登录账号默认 skip，不尝试登录或验证码；金额只进本地隐私结果，绝不进入公共 knowledge；
   `paymentTransport=0`、`finalCommit=false`，禁止支付、提现及任何资金动作。
6. 只有独立 canary、closeout、lease/job 清零和审核均通过后，才能新建 `implemented` revision；
   不得原地改 draft 或用历史实证替代本轮独立验收。

## `/xw xhs` — 小红书多入口统一调度（04-only）

`/xw xhs <action>` 是小红书业务动作的唯一入口面。用户只描述业务动作，不选 Recipe/dump/截图/视觉/capability；dispatcher 按自适应决策阶梯自动选路。三个调用面（`/xw xhs`、`/xw task "…"` 经 xhs-compose、RPA `--json`）收敛到同一个 plan、同一个 planHash 和同一份 effect budget，不复制业务脚本。

```text
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-xhs.mjs <action> [params] --plan|--json|--execute
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-xhs.mjs catalog
```

动作目录（`xw-xhs.mjs catalog` 列全）：`search`、`browse`、`inbox`、`read`、`like`、`collect`、`follow`、`nurture`、`comment`、`reply`、`publish prepare`、`publish send`。

1. **04-only，不可绕过**：每次 plan 强制 `placement=04`、`perDeviceConcurrency=1`；alias 01/02/03 在 plan 阶段直接 `XHS_ALIAS_NOT_04` 拒绝，零 job/lease/session/I/O；无 alias 也只解析到 04，04 busy 不 fallback 到 01–03。
2. **快车道，不增日常审核**：用户提交命令即开工意图；`xhs.nonpayment-autonomy.v1` pilot 下 like/collect/follow/comment/reply 经 typed social capability 直接执行；唯一保留的人类 commit 是 `publish send`。
3. **追溯而非审批**：一个 action = 一个 closeout run，记 actionRunId/planHash/参数摘要、recipe 或 capability 凭证、目标 fingerprint/operationKey、before/after、截图/dump/effect receipt hash、transport 次数与 ambiguous/no-retry 状态、最终 lease/job 清理状态。评论/私信正文只在受控证据中保存，普通日志只留 hash/长度/目标指纹。
4. **效果预算是硬约束**：social action 走现有 Mission/EffectLedger 严格路径（`softScope=false, softBudget=false`），nonpayment 只取消人工确认，不放松用户声明的数量和目标；`operationKey=sha256(actionRunId+action+targetFingerprint+payloadHash)`，同 key 重放复用 receipt，ambiguous 同 mission/action/target 禁盲重试。
5. **--execute 分 wave 开闸**：默认 `--plan` 只输出 plan 不碰设备；`--execute` 在对应 wave 的 live canary 晋级链通过前 fail-closed（返回 `action_gated:<wave>`）。当前 W0：所有动作 plan-only。
6. 支付、删除/注销/改密、验证码、登录墙、风控页、目标不唯一 → 始终停止。本阶段只允许 04；01–03 不参与也不被 fallback。
7. 计划与执行台账：`docs/plans/xhs-04-multi-entry-executable-plan.md` + `docs/plans/runs/xhs-04-multi-entry-ledger.md`。

## `/xw messages` — `/xw xhs inbox` 兼容别名（04-only）

`/xw messages` 是 `inbox` 动作的兼容别名，打开小红书底栏「消息」并汇总未读信号。经统一 dispatcher 调度，**04-only**，不是独立 capability / recipe，也不授权进会话或回复。

```text
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-xhs.mjs messages --plan|--json|--execute
# 等价于
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-xhs.mjs inbox --plan|--json|--execute
```

1. 用户写 `/xw messages` 即开工确认（只读/可逆）；内部 `xw-closeout begin --mode explorer`，acquire Explorer session → launch XHS → dump 找「消息」tab → tap → dump/截图汇总未读 → release → close。
2. **04-only**：默认且唯一 alias=`04`；01–03 在 plan 阶段拒绝，不逐台多机编排。actor：`--actor` → `XHS_ACTOR` → `claude-pilot-20260809`。
3. 只报告未读角标/「N条未读」等 dump 信号；**禁止**打开私信会话、发送、删除；会话不唯一不进入。
4. 完成后默认回到首页（restoration）；摘要落 `outbox/work/<runId>/messages-summary.json`，不进公共 knowledge。
5. `inbox` 的 live 执行在 W3 wave 晋级前 fail-closed；当前 plan-only。

## `/xw bench` — 只读链路计时实验

`/xw bench` 对已固化只读/零效果链路做 N 次重跑，聚合每步耗时并输出路径优化候选。不是第二控制面，不绕 session/job 闸门。

```text
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-bench.mjs plan --target "messages" --repeat 3
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-bench.mjs plan --target "小红书搜索夏季穿搭，只定位" --repeat 5 --aliases 01
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-bench.mjs run --bench <benchId> --execute --canary-authorized
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-bench.mjs report --bench <benchId>
```

1. `plan` 零碰机，只接受 messages / compose locate / observe 同类只读目标；余额、支付、真发、闲鱼上架直接拒绝。
2. `run` 每次独立 closeout run（自带 begin/step/close）；同机串行；失败即停不补量。compose locate 真跑还需 `--canary-authorized`。
3. `report` 写 `outbox/bench/<id>/report.md` + `candidates.json`；候选需人工采纳，不自动改 recipe/Task。
4. closeout `steps.jsonl` 现可带原生 `startedAt`/`durationMs`；`xw-session stats` 与 ops-health 优先用原生时长。

## 权限与事实来源

每次调用都重新读取，不缓存能力清单：

1. live `http://127.0.0.1:17930/agent-entry.md`：release、ready/lease、active blockers、批准命令骨架。
2. live `http://127.0.0.1:17930/api/capabilities`：正式 capability 与当前可执行属性；
   `http://127.0.0.1:17930/api/foundation-capabilities`：跨 App foundation/Locator 及其执行边界。
3. live `http://127.0.0.1:17930/api/recipes`（默认 `?status=implemented`）与
   `?includeAll=1`（`--all`）：Recipe Catalog；implemented 才进入默认可运行解析。
4. `C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\skills\SKILL.md`：人类权限与路由含义，只读。
5. 运行具体任务时读取 `/api/task-packet?task=<URL 编码目标>`、
   `/api/capabilities/<capabilityId>` 和对应 capability Skill。

最终可运行范围是以下条件的**交集**，不是并集：

```text
根 Skill 允许 ∩ live capability/recipe 可执行 ∩ 当前 release policy 允许
∩ 至少一台 eligible 设备 ready/free ∩ 无匹配 active blocker
```

- 根 Skill 说明“人允许什么”；capability/recipe 说明“系统现在会什么”；子 Skill 说明“怎么做”；
  Repair proposal 说明“现在修什么”。任何一项都不能替另一项授权。
- 来源冲突时取更严格结果并显示原因。不得修改根 `skills/SKILL.md`，不得靠子 Skill
  文件存在推断“可运行”。
- live 入口、catalog 或设备状态不可读时 fail closed，显示“状态不可证明”，不要猜。
- 可复用能力若未注册为正式 capability、status=`implemented` 的 recipe，或 foundation catalog
  条目，就不算交付完成；Markdown、knowledge、脚本或一次 Explorer 成功只能算候选证据。

## `/xw start` — 一键准备基础设施与设备

这是幂等 ensure 入口，不是第二个控制面，也不是部署快捷键。默认覆盖 01–04；有 alias 参数时只处理指定设备。

```text
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-start.mjs --check --json
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-start.mjs [01,02] --actor <actor> --json
```

1. `--check` 只读计划任务、端口、release gate、live fleet；不启动服务、不改 task、不提交 job。
   仓库/机器配置边界另用 `npm run xw:runtime:check` 校验；其唯一契约是
   `config/runtime/xw-runtime.v1.json`，不得把真实 secrets、数据库或 evidence 搬进 Git。
2. 真正 start 先 `xw-closeout begin --mode recover`。Orchestrator/控制面已健康时绝不重启；任务缺失时 fail closed，并提示先注册 `XW Platform FastOperator 01–04`，不得复活任何 `Xhs*` 旧任务。start 最多执行两轮“检查 → 安全修复 → 重检”，不得无限循环。
3. 任何 serve 变更前必须证明 `xw-runtime\current` 的真实 release、`release-manifest.v1.json`、17920 health 与 17930 health 的 `releaseId/sourceCommit/runtimeProfile` 完全一致，且 active lease/running job 均为 0、`MISSION_AUTO_APPROVAL_ENABLED`/`STANDING_GRANT_ENABLED` 为 OFF。源码 `main` 可以领先现场，不能拿源码 HEAD 代替 deployed release 身份。
4. stopped serve 的 launch commit 过期时，只能经源码主线里的正式 `services\control-plane\scripts\fast-operator-serve-task.ps1 -Action Install` 重新绑定 exact deployed release 后 Start；正在监听但 commit 过期时，仅在 exact release gate、active lease/running job 均为 0 时允许 Stop → Install → Start 收敛，否则 blocked。任务启动器必须位于 `xw-runtime` 并先解析 junction 真实目标。
5. 隔离设备由 start 内部直接走正式 audited recovery：`recover-inspect` → 对审计截图做 hash 绑定的视觉/OCR 分析。fresh `pageType=main-safe && safeStateVerified=true` 才允许零动作 `job recover` 清隔离；首次不在主页时只允许正式 recover 做一次可逆 restoration，继续保留隔离，第二轮必须 fresh main-safe 才清，否则 `HUMAN_REQUIRED`。恢复后以及普通 `ready=no`、online、lease free 的设备，再提交 `xiaowei.device.list` R0 job；必须 route plan=dispatchable、authorization=allow、无 external effect/approval，并捕获正式 job lease。健康设备跳过。
6. ADB 执行健康只认效卫控制面约定口 **5038**；5037 仅作只读诊断旁证，两口各连续采样 3 次，严禁把两套 daemon 的设备取并集。设备仅在 5037 出现时返回 `wrong_port` / `adb_wrong_port`，该 alias 的 `canPushImages=false`、全局 `adbOk=false`；`--check` 不得自动拉起空 daemon。禁止裸 `kill-server/start-server`、USB/PnP 切换或驱动重装。若 5038 缺机但 PnP 仍在且未落到 5037，返回 `xiaowei_restart_adb_required`；效卫路径仍可按 gateway readiness 独立给出 `canExecute=true`。
7. 终态：`READY`=基础设施、全部目标 serve/设备、lease/job/审批、**ADB** 全部干净且无 capability blocker（`allHealthy=true`）；`READY_WITH_LIMITS`=全部目标设备已可运行，但有 capability-scoped blocker 或 ADB 不全；`WAITING`=出现 active lease/job；`HUMAN_REQUIRED`=两轮后仍有隔离、离线、非 main-safe 或缺少人工条件；`BLOCKED`=基础设施/release 状态不可证明。输出必须含 `readyAliases`、`humanRequiredAliases`、`canExecuteAny`、`canExecuteAllTargets`。capability blocker 只限制其 `appliesTo` 能力，不得把无关 App/能力全局判死；每个具体业务仍由 `/xw run` 重新核验。
8. 禁止在 start 中调用 App operator、lab bypass、支付/外发 capability、写 control.db、批量杀进程或重启健康服务。

## `/xw skills` — 看已沉淀能力

这是纯只读目录，不碰设备、不 claim Repair。

**可执行帮助（推荐，避免手拼 API）：**

```text
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-skills.mjs [xhs|xianyu|alias|关键词] [--all]
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-skills.mjs --json [--all]
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-skills.mjs --self-test
```

等价手读：`GET /api/capabilities` + `GET /api/foundation-capabilities` + `GET /api/recipes?status=implemented`
（`--all` → `GET /api/recipes?includeAll=1`，并展开非 runnable capability）。

1. 合并上述 live 数据与根权限；按 App 和自然语言用途分组。
2. “已沉淀”= 正式 capability、status=`implemented` 的 recipe，或 foundation catalog 中已注册的
   跨 App 基础能力；只有 Markdown/knowledge/脚本不算。
   `locator.visual-block.v1` 属于 foundation：在可信截图中返回可审计的视觉区域 `blockId`，供
   Explorer、workflow 和 recipe 定位/验证弱语义界面。它**不返回可直接点击的坐标授权**，当前固定
   `tapAuthorized=false`；自动实点仍是 canary，必须另有 trusted capture one-shot permit。
3. 无筛选条件时列出全部“可直接运行”项（capability + implemented recipe）；有筛选时只列相关项；
   `--all` 才展开“暂不可用 / 需确认”capability，以及 candidate / canary_only / degraded 等
   非 retired recipe。
4. 给每项归为一个人能理解的状态：
   - **可直接运行**：实现可用、正式 job 可运行、非外部效果/无需审批、有 ready/free 的
     eligible 设备，且无 live blocker（recipe 另需 status=implemented，并继承底层 capability 闸）。
   - **需确认**：当前权限或 policy 要求人确认，或会产生真实外部效果；绝不自动执行。
   - **暂不可用**：依赖未就绪、无 eligible ready/free 设备、被 blocker 命中、仅 lab/canary、
     recipe 未晋级（candidate/canary_only/degraded 等）、已禁用，或状态无法证明。
5. 默认不打印原始 JSON、hash、event 或长审计链；需要诊断时才展开（`--json`）。
6. foundation/Locator 应单列“跨 App 基础能力”，并显示当前边界；不得因其可发现就把
   `locator.visual-block.v1` 描述为生产自动实点能力。

## `/xw locator` — 弱语义界面安全定位

这是 `locator.visual-block.v1` 的统一人工入口，也是 Task/Explore 的条件式内部依赖。优先使用语义
bounds；只有语义边界缺失或无法唯一确定时才启用图层块，因此不会让正常路径无条件增加视觉开销。

```text
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-locator.mjs status
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-locator.mjs prepare --input <screen.png> --query <目标> --out <目录>
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-locator.mjs prepare --alias <01-04> --session-file <ctx> --query <目标> --out <目录>
node C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\ops\xw-locator.mjs verify --input <同一screen.png> --dir <prepare目录> --decision <decision.json>
```

- 设备截图必须经正式 Explorer session/可见 lease；离线 `--input` 只做 passive 分析。
- Vision 决策只允许 `blockId`，由确定性代码在原图坐标系生成并校验安全点；裸 `x/y/bbox/point` 一律拒绝。
- 结果固定 `effect=none`、`tapAuthorized=false`。`/xw locator` 不提供 `tap/execute`；自动实点仍须
  同设备、同 session、同一新鲜画面的 trusted capture receipt 与 one-shot permit。
- 截图、pack、overlay、decision 或页面发生变化时必须重新定位，禁止跨设备或跨帧复用坐标。

### 强制升级硬闸（Explore / 坐标点击，2026-08-08）

细则真源：`C:\Users\Public\xw-fusion\xw-platform\services\orchestrator\modes\explorer.md` §5。执行时必须遵守：

1. **定位失败 ≥3（同一目标）** → 必须 `xw-locator prepare`，禁止第 4 次盲点。
   「失败」= dump 失败/树空，或 dump 成功但**没有可 tap 的唯一 bounds**（含只有父控件、整条滑条、整行，目标小点/刻度无节点）。
2. **盲坐标 tap**：同一目标最多 **1 次**失败；再点之前必须已 locator verify（或 fail closed）。**禁止连续盲点 3 次。**
3. **部分语义**：父有 label、子目标无 bounds → 第一次点不到就 locator，不必凑满 3。
4. **用户红框 /「点这个小点」** → 本目标**直接** locator，禁止先盲点。
5. Locator 只出 `blockId` + 确定性 `sourceSafePoint`；无 permit 时默认不点；**仅用户本轮明确授权 canary 实点**（或已有 one-shot permit）才可用同 session Explorer `tap.mjs` 点该 safe point，且禁止跨帧复用。

输出示例（名称与设备必须来自当次 live 数据，不能硬编码）：

```text
小红书
- 看首页信息流 — 可直接运行 — 设备 01/02 — xhs.observe.feed
- 看笔记详情 — 暂不可用 — serve lifecycle blocker — xhs.observe.note_detail

抖音
- 观察搜索结果 — 可直接运行 — 设备 01 — recipe.douyin.observe.search (recipe)

提示：/xw run 看一下小红书首页
```

## `/xw run` — 运行已固化能力

0. 先 `xw-closeout begin --mode runner --goal "<本轮任务目标>"`，持有本轮 `runId`；关键节点后 `step`；任务结束必须 `close`。

1. 先把自然语言归一成“App + 动作 + 对象”，再用 task packet 的 recommendations 和
   capability catalog 形成候选；recommendations 只是候选，不是自动提交决定。
2. 用户给了 capability id 时必须走精确详情接口。用户给自然语言时，读取候选对应的
   descriptor/Skill 确认语义；即使 task packet 没识别中文口语，只要正式 catalog 中有唯一
   明确匹配（如“看首页信息流”对应 feed），也可继续。真正零匹配才建议 Explorer；仍有
   多个语义相近候选时只问一个最小澄清问题，不执行。
3. 立即重算权限、release、ready/lease、eligible alias 与 blocker，不能复用旧的 skills 列表。
4. 执行前只给一行：

   ```text
   将运行：<用途> | <capability id> | 设备 <alias> | <只读/干跑/外部效果> | <自动/需确认>
   ```

5. 对“可直接运行”项，`/xw run` 本身就是确认：先 route plan，再使用 live agent-entry
   批准的正式 job/session 命令骨架执行并报告结果。
6. 对“需确认”或“暂不可用”项，停止并给一句具体原因；不得降级成旁路、lab 探针或手拼命令。
7. `/xw run list` 等同 `/xw skills`，不执行任务。
8. task packet 附带的 repair knowledge 只作背景；除非用户调用 `/xw repair`，不得据此查询、
   claim 或阻断普通 run。

## `/xw explore` — 探索未知面

只在用户明确选择 Explorer 或目标没有正式 capability 时使用；不要查询或展示 Repair Inbox。
先 `xw-closeout begin --mode explorer --goal "<本轮任务目标>"`，关键节点后 `step`，结束必须 `close`。

1. 在 `C:\Users\Public\xw-fusion\xw-platform\services\orchestrator` 读取 `modes\explorer.md` 和 live agent-entry。
2. 选择 ready/free 且不命中 blocker 的 alias，执行
   `node ops/explore-preflight.mjs --alias <alias>`。
3. preflight 通过后走正式 Explorer/lease 入口；禁止无 lease 旁路碰机。
4. 产出 evidence、短报、recipe/ops 固化候选；满足正式契约后才可成为 `/xw skills`
   中的 capability，不能因探索成功就宣称已沉淀可运行。
   对弱语义页面，定位信任顺序固定为：semantic bounds → 同一 Explorer session 的可信截图图层块
   （`locator.visual-block.v1`，只取 `blockId`）→ fail closed。Locator 当前只做定位/验证，
   `tapAuthorized=false`；没有 trusted capture one-shot permit 时不得据此自动实点。
   **坐标/弱目标硬闸**（详见上节「强制升级硬闸」与 `modes/explorer.md` §5）：定位失败 ≥3 或盲点失败 ≥1
   后再点、部分语义无子节点、用户框选 → 必须 locator，禁止连盲 3 次。
5. 验证码、风控、支付、真实外发、不可逆动作或已知 serve-lifecycle blocker 立即停止。

## `/xw recover` — 恢复设备（隔离 / 未就绪）

救机，不修代码。与 `/xw repair` 严格分家：Repair 管源码债；recover 管机子黄条与未决失败。

```text
/xw recover           # 只修当前不健康的机（隔离 / ready=no / 有未决失败）；健康机跳过
/xw recover 03        # 只修指定 alias
/xw recover <deviceId> # 只修指定 deviceId
```

用户写了 `/xw recover` 即开工确认（普通恢复，无支付/外发）。先
`xw-closeout begin --mode recover --goal "<本轮恢复目标>"`，按机 step，结束必须 `close`。

### 选机规则

1. 立即重读 live `agent-entry`（及必要时控制面 devices）；状态不可读 → fail closed。
2. **有参数**：解析为 alias（01-04）或 deviceId；只处理这一台。找不到或参数含糊 → 停，问一句最小澄清。
3. **无参数**：候选 = 当前不健康机，即满足任一：
   - `quarantined=yes`，或
   - `ready=no`，或
   - 有 `unresolvedFailure`
   已 ready 且未隔离且无未决失败的机**跳过**，不要无脑四台全冲。
4. 候选为空：输出「没有需要恢复的设备」并 close `completed`（或 `blocked` 若入口不可读），不碰机。

### 单机恢复步骤（每台独立，可多机并行但同机串行）

对每台目标机：

1. 打印一行：`将恢复：设备 <alias> | 原因 <隔离|未就绪|未决失败> | 关联 job <id或none>`
2. 若 FastOperator serve / 端口明显挂了：先走 `XW Platform FastOperator 0N` 与源码主线的 serve-task 正道重启；禁止手杀乱启，禁止启用旧 `XhsFastOperator*Live`。
3. 若状态是 `recovery_required` + 隔离：走正道恢复链（`recover-inspect` → 视觉目检 envelope → `recover-inspect-record` → `job recover`）。
   - 目检硬闸：必须 `pageType=main-safe` 且 `safeStateVerified=true`，否则这台 **blocked**，禁止清隔离。
   - 不在安全主页时：可用 Explorer lab（`back` / `launch-app` 等）尝试退回对应 App 主页；退不回 → 停这台，记证据，不旁路。
4. 若只是普通 `failed`/`ready=no`、未隔离：优先重启必要 serve，再提交一单只读 R0（如 `xhs.observe.metrics` 或 `xianyu.observe.snapshot`，按机上可用 capability）刷掉未决失败；不得用外发/需审批能力“刷绿”。
5. 单机成功标准：live 上该机 `quarantined=no` 且 `ready=yes` 且无未决失败。
6. 一台失败不影响其它候选；总结果：全成功 → `completed`；部分成功 → `partial`；全失败 → `blocked`。

### 红线（recover 专条）

- 禁止手改 `control.db`、禁止无 lease 旁路清隔离、禁止跳过目检硬闸。
- 禁止把 recover 转成 `/xw repair` 或擅自改源码/根 Skill。
- 禁止对健康机做“预防性恢复”。
- 支付、真实外发、删除仍永远不在 recover 范围内。

## `/xw repair` — 修复源码债

只有用户明确写 `/xw repair`、`Repair Inbox` 或 proposalId 时才加载；普通 skills/run/explore/recover
不得被 Repair backlog 阻塞。
先 `xw-closeout begin --mode repair --goal "<本轮任务目标>"`，关键节点后 `step`，结束必须 `close`（停在 source_review 时同样落盘）。

1. 在 `C:\Users\Public\xw-fusion\xw-platform\services\control-plane` 读取 `skills\repair-inbox\SKILL.md`。
2. 默认只读运行 `node scripts/repair-inbox.mjs list`；指定 proposal 时再 discover。
3. 以 consumer 自动归约出的 effective status 与 `claimable=true` 为准，不能只看 proposal
   初始 `status`，也不能把 event/hash/outbox 审计交给用户手工判断。
4. 状态不自洽时只报告 `当前不可领取：repair state unresolved` 并停止。
5. 仅当用户本轮明确授权 claim、consumer 判定可领取且 checkpoint 校验通过时，才使用
   显式 claim 开关；完成后停在 `source_review` 交 Mac 独立复核。
6. Windows 不得自批、改 review verdict、mark deployable、部署或 replay；Repair 默认不碰设备。

## 红线

- 不修改根 `skills/SKILL.md`，不扩大 release/policy/Standing Grant，不处理真实支付。
- 不写 `control.db`，不无 lease 碰机，不绕过正式 job/session/Explorer 入口。
- 不把动态 proposalId 写进 capability Skill，不把 capability Skill 当 backlog。
- Windows 可按“证据式自动收编”采纳低风险且证据完整的候选；未过闸门以及支付/资金候选继续由人工或 Mac 复核。
- closeout 不得扫描整机猜测 runId；不得把聊天总结写成 proven claim；不得在 close 失败后重跑业务来“补证据”。
