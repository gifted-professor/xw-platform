# `/xw task` 长任务设计（设计冻结稿）

日期：2026-08-06  
状态：设计与本地只读原型；未触发任何设备 job/session，也未执行真实外发。

## 1. 一句话定位

`/xw task` 是可参数化、可续跑、可收纳的组合任务入口。用户只说目标和本次变化参数；xw 在每次运行时
自动判断哪些阶段复用已知能力，哪些安全缺口需要 Explore，不要求用户理解 Run / Explore。

它不是新的设备执行器，也不是第二个控制面。所有手机动作仍走现有 capability、recipe、正式 job/session、
可见 lease 和当次权限确认。

## 2. 两个对象

### Task Template（常态任务）

保存稳定部分：

- 名称、别名、不可变 revision、状态；
- 参数类型、必填项、默认值、提问方式；
- 阶段目标与依赖关系；
- 外部效果种类、最大数量计算和重新确认条件；
- 检查点、去重与不确定回执策略。

不保存本次关键词，不保存 lease，也不保存 ADB、GatewayOperator、临时坐标或旁路命令。

### Task Run（本次运行）

绑定一个模板 revision，并保存：

- 本次规范化参数及参数 hash；
- 当次 live 编排结果及 plan hash；
- 唯一 runId、阶段进度、逐项检查点；
- 外部效果确认范围；
- 完成证据与 closeout。

模板的默认值可以复用；外部效果授权不能跨 Task Run 复用。

## 3. 用户命令

```text
/xw task
/xw task <任务名> [参数]
/xw task plan <任务名|自然语言目标>
/xw task list
/xw task show <任务名>
/xw task status current|run=<runId>
/xw task resume current|run=<runId>
/xw task 收纳当前任务 [名称=<名称>]
```

- `/xw task <任务名>` 等价于准备运行；参数不全时只补参，不占设备。
- `plan` 永远只预览。
- `current` 只指当前对话明确持有的 run；上下文丢失时必须给 runId，不能扫描目录猜。

## 4. 参数交互

一次性问齐所有缺失必填项，并同时展示默认值。不要连续问五轮。

```text
已打开「抖音关键词素材采集」。

请补充：
- 关键词：
- 每词数量：

可修改默认值：接收人=天才较瘦；续跑=是；去重=是。
固定约束：真实转发；仅图文；附言=已验证的飞书同款字段格式+当前搜索词。
直接回复：关键词=新疆秋天live,新疆雪景live；每词数量=30
```

关键词去空白、保持顺序并去重；数量必须是模板允许范围内的整数。关键词不自动沉淀为下次默认值。

## 5. 自动组合规则

每个阶段独立解析：

1. implemented capability 精确匹配：Run。
2. implemented recipe 精确匹配：Run。
3. 已验证并有实现绑定的本地 workflow：在其规定的正式 job/session 内复用。
4. 无正式能力但只读、可逆且 policy 允许：只把该阶段升级为 Explore。
5. 状态不可证明，或未知路径会跨越外发、删除、支付提交点：Blocked / Human gate。

页面漂移不会自动把整条 Task 变成 Explore。Explorer 可以探到未知外发提交点之前，但不能借整批确认
旁路真实发送。

## 6. 外部效果确认

只有模板为 `implemented` 且当次 live 计划可证明可执行时，参数冻结后才汇总确认一次。draft 只显示
外部效果预览，不能显示“确认开始”，也不能创建业务 run：

```text
本次计划：3 个关键词，每词最多 30 条；最多向「天才较瘦」发送 90 条；仅图文；
附言为原飞书字段+对应搜索词；自动去重并保存进度。
回复「确认开始」执行，或直接说明要修改的参数。
```

确认绑定模板 revision、规范化参数、接收人、最大数量、plan hash 和 policy 版本。更换接收人、增加关键词或
数量、修改附言/效果类型、计划语义改变或新建 Task Run，都必须重新确认。同一 run 在原预算内续跑可沿用。

## 7. 状态机与续跑

```text
collecting_parameters
→ planned
→ awaiting_effect_confirmation
→ running
→ paused | blocked | partial | completed
→ closeout
→ adopted | review_required
```

检查点固定进入：

```text
outbox/work/<runId>/checkpoints/<stageId>/<itemHash>.json
```

续跑时重新读取 release、capability、ready/lease 和 blocker，不复用旧 lease。某项“可能已发送但回执不确定”
时标记 `unverified` 并停止，不自动重发。

## 8. 完成后收纳

完成后由 xw 提炼：

- 每次变化的参数；
- 可保存的默认值；
- 固定流程与安全规则；
- 外部效果预算与检查点策略。

生成新的不可变 Task Template revision。完整完成且证据闸门通过才进入 `implemented`；partial、blocked 或
证据不足只保存 draft。模板进入目录后才可说“下次可按任务名调用”。收纳不授权下次真实外发。

## 9. 首个模板：抖音关键词素材采集

必填参数：

- `keywords: string[]`
- `perKeyword: integer`

当前有效默认值：

- `recipient = 天才较瘦`
- `resume = true`
- `dedupe = true`

固定约束：

- `resultMode = share_to_friend`
- `contentType = image_text`
- `annotationMode = verified_feishu_style_fields_with_current_keyword`

“飞书字段”指本流程已经验证过的结构化附言格式，不表示每轮都重新读取飞书表格。若以后需要自动从飞书表格
分析并生成关键词，应作为独立来源阶段加入新的模板 revision。

最大外发数为 `keywords.length × perKeyword`。第一版只承诺当前已验证的附言方式，不向用户展示尚未实现的
选项。抖音已知单关键词 workflow 作为 Task 内部执行单元；多关键词由 Task 层顺序编排，并为每个关键词
使用 run-scoped checkpoint。

## 10. 验收标准

- 只输入任务名时，一次性返回两个必填项与全部默认值。
- 三个关键词、每词 30 条时，外部效果预览为最多 90 条，接收人为“天才较瘦”。
- 重复关键词只计算一次。
- 参数未齐时不创建业务 run、不占 lease。
- `plan` 不碰设备。
- 模板 revision 不可覆盖；相同内容重复保存幂等。
- 未知真实外发步骤必须停止。
- 续跑检查点按 run 隔离，回执不确定不重发。

## 11. 本轮边界

本轮只冻结交互、模板契约、目录原型和本地校验。最新版模板保持 `draft`，不会创建设备 job/session，
不会打开 App，不会执行转发。真实执行接线、live 复核与首轮试跑应在用户另行确认后进行。

从 `draft` 激活为 `implemented` 前还需完成：

1. 把 `workflow.douyin.keyword-image-text-share-friend.v1` 绑定到当前已验证 runner，并校验参数映射；
2. 用 run-scoped checkpoint 做一次不触发外发的本地/模拟验收；
3. 确认每阶段 live 解析、接收人唯一解析和整批确认凭证；
4. 用户另行允许后再做首轮设备试跑；
5. closeout 与证据闸门通过后，新建 implemented revision，不能原地修改 draft。
