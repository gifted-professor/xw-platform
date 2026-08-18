# Explorer 预算、跨机熔断与卡点收口 v1

- 日期：2026-08-06
- 状态：核心 v1 已在隔离分支实现并提交；独立审查结论为 **源码合并 GO / 当前生产部署 NO-GO**；未合并、未 push、未部署（线上尚未生效）
- 决策：完成优先；同卡点无进展 3 次只封该路；同 run 可有限续绑且计数不重置；预算放宽但总墙不变；跨 3 台同错才封路；只有硬预算、人工终止或红线才停整 run
- 姿态一句话：**宽松到能完成，紧到死循环停得住。**

## 实施状态（2026-08-06）

- 路由仓分支：`codex/explorer-budget-breaker-v1-20260806`，commit `adfc7fa`，工作树 `C:\Users\Public\xhs-routing-wt-explorer-budget`。
- `/xw` 客户端分支：`codex/explorer-budget-client-v1-20260806`，commit `08aedab`，工作树 `C:\Users\Public\xhs-registry-wt-explorer-budget`。
- 已实现：durable run、20/40 分钟 hard wall、80/120 device action、单轮 25 action、同 checkpoint/target 3 次熔断、仅规范化 `dump_ui` 节点树生成的 `explorer_state` 新状态证据才清零、封闭失败分类、3 台同错 fleet checkpoint breaker、同 run 最多 3 次 rebind 且计数继承、纯读 status、红线 whole-run abort、周期 reaper、旧 Explorer session/raw helper 入口 fail closed、创建时冻结 route allowlist。
- 防刷预算：release 与 route catalog 均由部署控制面绑定；catalog 以 `app + budgetScopeId + exact route set` 签发预算 scope，客户端必须精确匹配整组路线。修改 task/scope、actor、alias、路线顺序、子集/超集或 session 文件均不能新开预算；同一 app 的同一路线也禁止归属多个 budget scope。
- 恢复语义：session TTL 与显式 release 都在一个 SQLite 事务内把 active round 收口为 `SESSION_TRANSPORT`、累计 checkpoint/fleet 失败、再清 session/lease；故障注入后可幂等重试，不会留下 `paused + running round` 死锁。
- 已接客户端：`acquire/rebind/status/heartbeat/round-begin/round-finish/abort/release`；open/rebind 均使用调用前持久化的幂等 key + client token，context 采用同目录临时文件、flush、原子 no-replace hard-link publication 和私有 ACL，丢响应后恢复同一 binding 不重复计费。
- 启动配置已接：installer 从显式 route-catalog JSON 读取并写入 `task-launch.json`，worker 转发 `CONTROL_PLANE_EXPLORER_ROUTE_CATALOG_JSON`；旧 launch config 默认空 catalog，Explorer fail closed，但不影响控制面其他能力。
- 回归：路由定向目标集 **86/86**、registry Explorer gate **20/20**；独立复核关键组合 **57/57**；两仓静态检查、路由 secret scan 与 diff-check 均通过。
- 未部署：未改 Windows `main`、未 reload 17920/17930、未碰 01–04、未 claim Repair Inbox。
- 部署前明确阻断：① live-only `douyin-harvest-share-links.mjs` 仍依赖已禁 raw shell helper，必须先迁成 typed session action/capability；② 必须为目标任务审核正式 route catalog，并在安装 scheduled task 时显式传入，否则 Explorer 会以 `EXPLORER_ROUTE_AUTHORITY_UNAVAILABLE` fail closed。
- 后续增强（当前不声称已上线）：辅助 R0/R1 job 独立配额、外部 vision 分析独立预留计数、终态 knowledge outbox、observer 聚合面、cleanup/rearm 管理面。

## 0. 修订原则（2026-08-06 人工确认）

来自应用商店升级实跑复盘：高效路径能完成；死磕 AI 搜 / session 抖掉后重开「刷命」才是问题。

| 要防的 | 不要误杀的 |
|---|---|
| 同 checkpoint 无限重试 | keepalive 抖动导致 session 丢一下 |
| 换机 / 换措辞假装新尝试 | 换 checkpoint 的合理 pivot（搜失败 →「我的→升级」） |
| 新开 run 刷预算 | 同 run 内有限次 session rebind（预算不重置） |
| 无进展空转 | 已有 `progressMarker` 变化的继续打 |

整 run 只在这些情况下终止：任务成功、总时长/总 actions 耗尽、红线页（验证码/风控/登录墙/支付发布/未知不可逆页面等）或人类明确 abort。所有已知 checkpoint 都暂时熔断时进入 `paused/ask_human`，不自动把整单判死。

## 1. 结论

当前不是“四台机器都坏了”，而是 Explorer 缺少硬预算和业务进度判断：

- 01 抖音分享链本应在第 3 个无进展 round 后停止当前 clipboard 路线并 pivot，实际却沿同一卡点继续了多轮。
- 03 小米商店连续 5 次停在旧搜索结果，本应第 3 次后 **停搜并 pivot**，而不是整单直接判死刑。
- 02、04 已完成核验，无需恢复。
- 方案落盘时 01–04 全部 `ready=yes / lease=free`，无 active lease、running job 或 quarantine。
- 控制面目前只知道“点按、截图、dump 命令成功”，不知道业务目标是否前进；这正是 primitive 全绿但任务卡死的根因。

## 2. 核心实现

### 2.1 Durable Explorer Run

- 从现有 DiscoveryRun 抽取通用 `BoundedSessionRun` 底层机制，但为人工 Explorer 建独立 authority；不能直接套用 Standing Grant。
- 在 `control.db` 增加持久化 `explorer_runs / explorer_rounds / explorer_reservations / explorer_run_events / explorer_breakers / explorer_alert_outbox`。
- 一次 open 原子创建 Explorer run、session 和 lease。
- **session 丢失：不默认杀 run。** 同一 `explorerRunId` 最多允许 **3 次 rebind**，任一时刻只能有一个 active session；`hardDeadlineAt`、action 用量、round、checkpoint breaker 和跨机失败记录全部继承，绝不重置。只有旧 session 已终态且不存在不确定的 active action 才能续绑；不确定动作先按现有策略隔离原设备。3 次用尽后 run 进入 `paused/ask_human`，禁止另开 run 刷命。
- 控制面只接受部署 catalog 签发的 `{app, budgetScopeId, exact sorted routes}`，并以 `{deployedReleaseId, app, budgetScopeId, exact routes}` 建立一次性 scope 锁；`taskId/scopeKey` 只作审计展示，agent 不能靠改标签、actor、alias、路线顺序、子集/超集或 session 文件绕过。
- `xiaowei.explorer.primitive` session 必须绑定 Explorer run；旧脚本缺少 run 时返回 `EXPLORER_RUN_REQUIRED`，不得降级到 raw helper。
- 每个 action 在 createJob 前事务内预留预算；完全相同的 idempotency replay 不重复扣费，参数变化的重放返回冲突。
- heartbeat 只续约 60 秒 sliding lease，绝不改变不可变的 `hardDeadlineAt`；`status` 改成纯读取。

### 2.2 业务语义 round

- 一个 round 表示一次明确假设，必须先 `round begin`、后 `round finish`；禁止同时存在两个未完成 round。
- 所有动作绑定 `checkpointId、targetKey、strategyId`。
- `round finish` 的 progressed 必须提交本轮 succeeded `dump_ui` action 由控制面从规范化 UI 节点树生成的 `explorer_state` evidence 和其 SHA-256。普通 result、tap/focus/launch 自报、截图或任意文件 hash 不能冒充业务进展；marker 未变化时，即使命令全部 succeeded，也按业务无进展计数。
- **marker 真变化（业务前进）→ 该 `{checkpointId,targetKey}` 无进展计数清零**，允许继续。
- 卡点无进展计数键固定为 `{deployedReleaseId, app, checkpointId, targetKey}`，不包含客户端标签、alias、device、strategy 或诊断文案；跨机指纹使用同一键，`reasonCode` 仅作诊断、不参与分桶，避免用同义错误码拆散三机计数。因此换机、换策略、换标签或换报错文案都不能刷新同卡点预算，不同 app 的同名 checkpoint 也不会误熔断。
- **换 `checkpointId` = 换路，允许**（例如 `market-search` → `mine-upgrade-list`）；熔断只封旧卡点，返回 `nextAction=pivot_checkpoint|ask_human`，不自动杀整 run。
- checkpoint pivot 不另设次数上限，由 run 的总墙和总 action 预算兜底；但 checkpoint 必须来自任务包中的稳定 ID，禁止仅改名字伪造新路线。
- `scopeKey` 在任务创建时确定并在 run 生命周期内不可修改。

### 2.3 默认预算（偏宽松）

| Profile | 总时长 | Device actions | 单 round | Session rebind |
|---|---:|---:|---:|---:|
| dump/E0–E1 | **20** 分钟 | **80** | 最多 25 actions | 最多 3 次 |
| vision | **40** 分钟 | **120** | 最多 25 actions | 最多 3 次 |

- `Device actions` 指 bounded Explorer primitive；session action 虽落为 job，也只计 action，不重复计辅助 job。
- 辅助 job/外部 VLM 目前没有独立 durable counter，不能把下文设计目标误读成已硬控；接成正式 capability 后再增加独立额度。R2/R3 与任何外部效果继续走原审批规则。
- 预算耗尽后不再接受目标动作；独立 cleanup 预算尚未实现，当前沿用既有 restoration/recovery 机制。
- v1 不自动延长总墙；确需加时必须由人类创建有审计理由的新任务，不能由 agent 自行 `extend-budget`。

### 2.4 熔断规则（卡点紧、整单松）

- 同 checkpoint/target 连续 **3** 个无进展或失败 round：第三轮结束 **只开该卡点闸**；第四轮同卡点在 adapter 前拒绝。整 run 默认继续，可换任务包中已有的 checkpoint。
- 相同 `DUMP_EMPTY / DUMP_INVALID` 两次：强制降级策略提示；第三次 **熔断该卡点**（同条）。
- 相同失败指纹命中 **3** 台设备（更宽松；v1 原「2 台」易误伤）：打开 capability/app breaker，禁止再拿未试设备盲试；已成功设备的核验/收尾不受影响。
- 只有总墙/总 action 预算到期、人类 abort，或验证码、风控、登录墙、支付/发布确认、身份不明、未知不可逆页面等现有红线，才自动终止整个 run。
- lease/binding 短暂丢失：走 §2.1 rebind，不杀 run；rebind 耗尽、设备 quarantine 或 serve 不可用时只暂停 run/移除该设备，等待换路、换 eligible 设备或人类处理。
- action 运行中触发 **卡点** 熔断时，不进入整 run `abort_pending`；只拒同卡点新 round。整 run abort 时才 `abort_pending` → cleanup → release。
- 独立 cleanup 90 秒/5 action 仍属后续增强；核心 v1 先保证 release/TTL 的数据库状态原子收口，设备 restoration 继续沿用既有 recovery 机制。
- 新 release 自动获得新的 breaker key；同 release 只能由人类带理由执行一次性 audited rearm，历史记录不删除。

## 3. 接口与数据合同

### 3.1 CLI

```text
xw-explore-session acquire
  --task <taskId> --app <app> --scope <stableScope> --release <releaseId>
  --profile dump|vision --alias <01-04>
  --route <checkpoint=target> [--route ...]

xw-explore-session round-begin
  --checkpoint <id> --target <id> --strategy <id>

xw-explore-session round-finish
  --outcome progressed|failed|blocked
  --progress-marker <sha256>
  --evidence <本轮 succeeded action 的 evidenceId>
  [--reason <stable-code>]

status                         # 纯读，不 heartbeat
heartbeat                      # 不延长 hard deadline
abort --reason <stable-code>
release                        # release session + seal run + 删除本地 context
```

### 3.2 Runtime contract

- 新增 `xhs.explorer-execution.v1`，至少包含：
  `explorerRunId、taskId、actor、app、scopeKey、releaseId、deviceId、sessionId、leaseId、profile、status、startedAt、hardDeadlineAt、budget、used、activeRound、lastProgressMarkerHash、failureKey、circuit、cleanup`。
- 核心 v1 run 状态为：`running | paused | aborted | sealed`；`abort_pending/sealing/cleanup` 属后续 cleanup 增强。
- circuit 状态固定为：`closed | open`。
- 终止事件使用 `xhs.explorer-abort.v1`。
- 现有封存证据合同 `xhs.explorer-run.v1` 保持不变，只引用新的 execution run，不复用或改变其语义。

## 4. 监控、可见性与问题升级（后续设计目标，当前未实现）

### 4.1 定时监控

后续可部署确定性 `XhsExplorerRunMonitor`：每 60 秒运行、30 秒 execution limit、`MultipleInstances=IgnoreNew`。它不是当前四条核心同步硬闸的依赖。

- 只能读取 observer fleet、Explorer run/event 和 lease 投影。
- 不持 session token，不 heartbeat、release、submit、focus、刷新截图，也不访问 ADB/22222。
- 只负责去重报警、补投 outbox 和生成 shadow 诊断包；真正拒绝动作由控制面同步硬闸完成。
- 已实现的控制面 scheduler 会周期调用 run reaper，处理 deadline、owner 崩溃和 TTL 终态；reaper 不触发设备业务动作。独立 Windows monitor 尚未部署。
- v1 不使用长期驻留 LLM 子代理作为熔断权威。需要诊断时，只把已熔断 run 的脱敏 evidence packet 交给 L2 shadow worker，且该 worker不得 retry、recover 或接触设备。

### 4.2 统一卡点发现面

- 计划新增只读 `GET /api/observer/v1/explorer-runs`。
- 计划新增只读 `GET /api/observer/v1/blockers`，聚合 Explorer breaker、知识库 blocker、Repair proposal、quarantine、approval 和 lease。
- Blockers API 是统一发现面，不是新队列；字段至少包括 `sourceType、key、severity、state、affectedDevices、owner、nextAction、proposalId、lastSeen`。

### 4.3 升级规则

1. 首次 run 熔断：按失败指纹去重写普通 pitfall，`lifecycle=probe_unknown`，不进 Inbox。
2. 同指纹跨独立 run 重复，或命中三台设备：设 `needsEngineer=true`；能力受阻时进入 `active_blocker` 并显示在 agent-entry。
3. Mac governance 补齐源码范围、allowlist、hash 和验收条件后，才生成 `repair-proposal-v1` 并进入 Repair Inbox。
4. 禁止从 Explorer abort 自动伪造 repair proposal。
5. knowledge 写入失败时先留 durable outbox，由 monitor 重试；同一 failureKey 只更新一个条目，避免知识库刷屏。

## 5. 当前问题收口

- **01 抖音分享链**：第三次无 URL 后熔断 `clipboard-read` checkpoint，但同 run 允许 pivot 到 `paste-in-app-and-parse`；该路线已证明可完成 6/6。正式实现仍须移除 arbitrary shell，把 fallback 收进受控抖音 capability，并禁止暴露通用剪贴板读取。
- **03 小米商店**：第三次 stale-query 后熔断 `market-search` checkpoint，但同 run 可继续 `mine-upgrade-list`（「我的→升级」）；保留 02/04 的成功结果，不把整个升级核验任务判死。
- **微信 02/03**：停止跨机复用绝对坐标，先用已有截图离线完成设备锚点/template/OCR，再做一次 canary。
- **XHS serve-exit**：把当前四条 active blocker 合并为一个治理问题并保留原证据引用；该问题已满足正式源码 repair 的治理审查条件，应单独产出 proposal。
- 删除 detached keeper 依赖，由 owner wrapper 进程内 heartbeat；启动健康确认失败时，在第一个设备动作前终止。
- 所有正常结束必须留下显式 release event；TTL 回收只算异常收口。

## 6. 测试与上线

### 6.1 离线与集成测试

- 原子 open；deadline 不可被 heartbeat 延长。
- 事务扣预算；幂等重放不重复计费；变更参数重放冲突。
- 第三次失败开闸；第四次 action/round 为零 adapter 调用。
- strategy、alias、device 或错误文案变化不能重置同卡点计数。
- 相同指纹跨机累计，三台同错才打开该 checkpoint/capability breaker；其他 checkpoint 仍可继续。
- `status` 不续租；session/lease 丢失后最多同 run rebind 3 次，全部预算和熔断计数保持不变；第 4 次不得新开 run 刷命。
- action timeout、checkpoint-only breaker、run pause、红线 abort_pending、cleanup、release 和 quarantine 状态正确。
- monitor 对 heartbeat/release/action/job/设备截图刷新均返回 403。
- knowledge/outbox 重试幂等，普通 abort 不会出现在 Repair Inbox。
- 覆盖带空格 session 路径、owner 崩溃和控制面重启恢复。

### 6.2 本轮证据回放

- 01 必须在第 3 个无进展 round 后封住旧 clipboard checkpoint，不得进入第 4 个同卡点 round；随后允许同 run pivot 到 paste fallback 并完成 6/6。
- 03 必须在第 3 次 stale query 后封住 search checkpoint，不得执行第 4、5 次同路搜索；随后允许同 run pivot 到「我的→升级」。
- 02、04 的成功路径不得误熔断。
- 微信同 target vision 第 3 次仍无进展后封住该 target；已有真实 progressMarker 变化则只清零该卡点计数。

### 6.3 上线顺序

1. 对历史日志和 fixture 运行 shadow 判定，不碰设备。
2. 独立 source review 通过后，部署 exact reviewed revision。
3. 在 04 执行一个已知安全的只读 canary，同时验证一个离线/fixture breaker 场景。
4. 通过后依次启用 02、03、01。
5. 上线后验收：100% Explorer actions 绑定 run；正常任务 100% 显式 release；同卡点不存在第 4 round；monitor 设备调用数恒为 0。

## 7. 不在本方案内放宽的红线

- 不允许无 lease、raw GatewayOperator、ADB/22222 或 arbitrary shell 旁路。
- monitor、L2 worker 和诊断子代理永远不获得设备控制权。
- R2/R3 仍只提交不批准；真实资金 final commit 仍必须等待人类确认且 transport 保持 0。
- 本方案不会把普通 pitfall 自动塞进 Repair Inbox；Inbox 继续只发现完整、有效的 `repair-proposal-v1`。
