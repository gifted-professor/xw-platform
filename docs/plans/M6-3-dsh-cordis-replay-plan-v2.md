# M6-3 真实 DSH/Cordis 子进程与 replay tools 计划（Plan V2，终版）

状态：`READY_FOR_EXECUTION`

范围：M6-3 / 单一 PR `M6-B`

授权：本文件只界定未来实施的范围与验收，不自行授予写代码或运行外部副作用的权限；本次任务为 `review-only`，未授权实现、设备动作、部署或开闸。开始实施前需由用户另行明确授权。

基线：实施开始时重新 `git fetch origin --prune`，从当时最新 `origin/main` 新建独立干净 worktree 与 `codex/m6-3-dsh-replay` 分支。不得清理、重置或复用当前含用户未跟踪文件的 root worktree。

## 1. 目标与硬边界

M6-3 只建立真实、固定版本、out-of-process 的 DSH/Cordis replay 链：

`M6DshReplayWorker → real @deepseek-ai/dsh-sdk-client → line-buffered supervisor → pinned DSH/Cordis child → XW protocol server + replay tools → 唯一 GroundingRuntime → synthetic replay state`

退出时必须同时满足：

1. 每个 `WorkerRun` 同时至多一个 DSH child；正常 happy run 只有一个 process incarnation。checkpoint/resume 测试可以在旧 incarnation 已有可验证关闭收据后启动一个新 incarnation，但同一时刻绝不双写同一 session。
2. 实际运行的是锁定的 DSH/Cordis 包与真实 newline-delimited JSON-RPC stdio，不是 `integrations/dsh-xw/plugin.mjs` 的内存 fixture。
3. 模型可见工具恰为 10 个具体方法、归属 8 类：`phone_observe`、`phone_ground`、`phone_act`、`phone_verify`、`checkpoint_save`、`trace_query`、`wait_human`、`worker_start`、`worker_continue`、`worker_complete`。
4. 所有 ground/act/verify 只作用于 synthetic replay state；`phone_act` 结果必须含 `executionMode=replay`、`externalEffect=false`、`actionCount=0`。不得触达 ADB、真机、Control Plane live adapter、lease、数据库、支付、删除或网络 provider。
5. Cordis schema 与 XW 共享 validator 在 handler 两侧独立校验；模型输入、工具输出和持久 evidence 都是闭合 schema。
6. replay frame 只通过仓内唯一 `orchestrator/src/m6-grounding-runtime.mjs` 消费；不得另写坐标解析、图像点击器或第二套 grounding runtime。
7. JSON-RPC framing、ID、timeout、stdout/stderr cap、backpressure、进程树清理和 checkpoint/resume 均有失败闭合测试。
8. Windows 与 Ubuntu CI 均用 lockfile 安装并跑真实 child 全链；现有 no-install/offline job 保持不变。
9. gate 始终 `CLOSED`；M5 Router/Binder 不注册 `agentic_session`，该接线仍只属于 M6-6。

明确不做：真实模型/API key、live device action、M6-4 policy/lease live chain、M6-5 live recovery、M6-6 router/binder、deployment、epoch 变更、UI 工作。

## 2. 已核验事实与输入证据

### 2.1 M6-2 收口

- `C:\Users\Public\xw-runtime\m6-audit\m6-2-w9-completion-4ea1fa60.json`，SHA-256 `7d6910c59656ba173869ff6454837c4bd0061eb6e24ebb50e165c01d6964bbbb`，verdict=`M6_2_CLOSED_READY_FOR_M6_3`。
- `C:\Users\Public\xw-runtime\m6-audit\multi-model-execution-completion-4ea1fa60.json`，SHA-256 `04305ea55835e977af518b9f22224e148b41172807cb92e3c51993f4c1997f31`。
- `C:\Users\Public\xw-runtime\operator-probe\w9-final-independent-inventory-4ea1fa60.json`，SHA-256 `68a38d84014c4312d1b58fd214dcee379ea77d7f3d0bc4c2c0bfd8ff91824c25`：80 attempts、80 closeouts、76 accepted、4 `M6_FRAME_FOCUS_UNSTABLE`、extras=0、PASS。
- `C:\Users\Public\xw-runtime\m6-audit\m6-window-final-4ea1fa60-manifest.json`，SHA-256 `5bc7a0c4ba8c9a66d227c385c814595f63ed236a44a9a88aebde77d3fdc9ce4e`。
- M6-2 明确 M6-3 入口为 `replay_only_DSH_Cordis_worker`，`reuseObserveOnlyEpoch=false`、`liveActionsEnabled=false`；gate 最终 CLOSED，资源 before/after/closed 均为零，`actionCount=0`。
- M6-2 使用冻结 external ADB 5037 launcher，而通用默认仍为 5038。这是后续 live 波次的显式风险；M6-3 禁止任何 ADB，所以既不复用也不修改该配置。

### 2.2 总计划与代码基线

- 总计划 `M6-execution-plan.md` SHA-256 `8966727bf218cd803be3f5b1ae3efbeabda9aa778fc3b8d442a58faeabefe013`。
- 仓内 `docs/plans/M6-task-brief.md` SHA-256 `cfab112b7a00adc4013b28f7c67291a2a1ff441e440f34a73385a30dba5885bc`。
- 评审时 `origin/main=80355d341d854212045c6c1ec62daffbaf3de766`，已含 M6-2 merge；这不是执行时永久固定基线，执行者仍须 fetch 后记录新基线。
- `integrations/dsh-xw/plugin.mjs` 是 M4 in-process fixture，不 spawn；它必须保留。
- `orchestrator/src/m6-tool-surface.mjs` 已定义上述 10 个工具的输入约束；需要扩展为唯一 machine-readable spec 并新增输出 validator。
- `orchestrator/src/m6-grounding-runtime.mjs` 是唯一 GroundingRuntime；现有 corpus 有 208 个 synthetic frames。

### 2.3 DSH rc.7 源码与协议事实

锁定 upstream：

- source commit `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
- tree `3bc8f89fe494a4755c188be354add4e8b1e7b188`
- `@deepseek-ai/dsh@0.1.0-rc.7`、SDK client/protocol/JSON-RPC server、tools、agent spine、JSONL persistence、checkpoint policy 均锁到 `0.1.0-rc.7`，MIT；包级 integrity 由最终 `package-lock.json` 固定。
- `@deepseek-ai/dsh` 的直接依赖使用 caret 范围，因此只写顶层 exact version 不足以复现；必须提交独立 lockfile 并验证所有解析版本与 integrity。
- client→server request 只有 `initialize`、`session/prompt`、`shutdown`；server→client 是 notification（`session.event`、`session.status`、`subagent.started/finished`），rc.7 不存在 server→client request。
- `session/prompt` response 只是 `messageId` ack；turn 完成必须等待匹配的 `agent/inbox/spliced`，随后 `session.status=idle`，不能把 ack 当最终结果。
- `request/header` 是 rc.7 正式 SessionEvent；`data.header.tools` 在 core session 类型与 jsonrpc-agent runtime snapshots 中均存在，可作为模型工具面的运行时证据。
- stock SDK server 的 `createSession()` 调用 `ctx.agents.create({sessionId})`；它不会因相同 id 的 JSONL 已存在而自动调用 `ctx.agents.resume()`。公共 AgentRegistry 明确提供 `resume()`，且 upstream 测试证明同一 persistence root 跨新 Context 恢复，但 stock SDK server 本身未接这条路径。
- upstream client transport 未提供 M6 所需的单行/累计 cap、unknown response id 拒绝与 write backpressure 等全部强约束，必须由 XW supervisor 在 SDK parse 之前补齐。

## 3. 最终架构决策

### D1 — fixture 与 process adapter 并存

保留 `integrations/dsh-xw/plugin.mjs`，只补 `adapterKind=fixture_in_process` 与显式 trace marker。新增 process adapter，使用 `adapterKind=dsh_cordis_process`。两者的 receipt 不能互相冒充；M6-3 completion 只接受后者。

process receipt 还必须携带 `executionMode=replay`、DSH package/source/tree、lockfile、Cordis config、child protocol plugin、model profile、tool surface、corpus 与 policy hashes。

### D2 — child-local GroundingRuntime，不增加反向 IPC

rc.7 wire 无 server→client request，因此 XW replay tool handler 在 DSH/Cordis child 内加载仓内唯一 GroundingRuntime 与 synthetic corpus。宿主只通过真实 SDK client 发 prompt、消费 response/notification、汇总 evidence；不新增 socket、HTTP、MCP 或自定义 host callback。

child import 仓内 GroundingRuntime 时使用固定、profile 校验后的绝对入口；启动 receipt 记录模块文件哈希。任何路径来自 prompt/tool args 均拒绝。

### D3 — XW-owned、SDK-protocol-compatible child server

不直接加载 stock `@deepseek-ai/dsh-sdk-server` 作为 M6-3 server。新增最小 XW Cordis plugin，复用 rc.7 的公开 SDK protocol/JSON-RPC primitives 与 DSH services，只实现相同的 `initialize`、`session/prompt`、`shutdown` 及既有 notifications：

1. child profile 固定 `workerRunRef`、`sessionId`、`sessionMode=create|resume`、persistence root 和所有内容哈希；这些字段不接受模型或 goal 覆盖。
2. 首个 prompt 前只允许一个 session id，且必须等于 profile 中的 id。
3. `create` 路径调用公共 `ctx.agents.create()`；若磁盘已有同 id log，失败闭合，绝不静默 resume。
4. `resume` 路径调用公共 `ctx.agents.resume()`；若 log 不存在、hash ledger 不匹配、旧 process 无关闭收据、session seed/seq 不一致，失败闭合，绝不新建空 session。
5. server 为每个 session 保存唯一 handle；重复/并发 create/resume 共享同一 pending promise，失败后清理；shutdown 只处理自己拥有的 handle。
6. prompt ack 与 notification shape 必须与 rc.7 protocol schema 相符，真实 host 使用 `@deepseek-ai/dsh-sdk-client` 解码；禁止 XW 私有成功捷径。

这不是 fork upstream 包，也不修改 `node_modules`；它是仓内明确拥有的协议适配插件。Gate A 必须先以两次全新 OS process 证明 `create → persist/close → resume → prior history visible → continue`。若公共 API 或 rc.7 composition 无法满足，M6-3 直接 `BLOCKED_NEEDS_DECISION`，不得退回 stock create、换 session id 冒充 resume，或删除 checkpoint 验收。

### D4 — protocol-preserving line-buffered store-and-forward supervisor

host 的真实 SDK client 启动 XW supervisor/launcher，supervisor 再以 `shell:false` 启动唯一 DSH child。supervisor 对每个完整 newline frame 先做有界缓冲、UTF-8/JSON/JSON-RPC envelope 与方向校验，再原样转发；因此它不是 byte-transparent proxy，而是 protocol-preserving、line-buffered store-and-forward proxy。

默认预算（只能通过 versioned profile 修改）：

- 单行：1 MiB，超过即 `M6_DSH_STDIO_LINE_LIMIT`。
- child stdout 总量：32 MiB/run；notification 10,000/run；pending requests 8；inbound 未完成 buffer 1 MiB。
- child stderr：最多 256 KiB 或 400 行，先到者截断；receipt 只存脱敏 tail hash、byte/line count 与 truncation 标志。
- initialize 10 s；prompt ack 5 s；turn idle 60 s；shutdown response 5 s；graceful exit 5 s；TERM 后 3 s；最终 tree kill 后 5 s 验证。
- request id 为 supervisor 单调安全整数；response 必须恰好匹配一个 pending id。duplicate、unknown、非整数/越界 id、child→host request、stdout 非 JSON、EOF 残行或写关闭后的 frame 均终止 run。

supervisor 等待 `stdin.write()`/`drain`，暂停上游读取直到下游恢复；不得无界排队。host request 也执行同样的单行和 pending cap。每次异常只产生一个 canonical failure 与一个 close sequence。

冷启动延迟与 warm prompt ack 分开测量。由于完整行校验会增加开销，Gate B 增加 40 次 1 KiB/64 KiB/1 MiB-1 的纯 proxy microbenchmark；Gate E 的真实 warm p95 包含 supervisor 开销。

### D5 — 精确的跨平台进程身份与树收敛

每次 launch 生成 128-bit `processRef`，记录 supervisor 持有的 live `ChildProcess` handle、direct child PID、spawn timestamp、verified executable path/profile hash。PID 不是身份，也不单独作为“已死亡”证明。

正常顺序：停止新 prompt → 等当前 request/notification drain → `shutdown` response → stdin EOF → child `close` → persistence/trace close → supervisor close receipt。

POSIX：child 建独立 process group；只对 supervisor 自己创建且 `processRef`/PID 匹配的负 PGID 发送 TERM/KILL。Windows：

1. 先走 shutdown/EOF 与直接 child kill；
2. 仍未 close 时，以 `shell:false` 直接启动已验证的 `%SystemRoot%\System32\taskkill.exe`，参数固定为 `/PID <owned-direct-child-pid> /T /F`；PID 必须为 supervisor 当前 live handle 的正整数且 processRef 未换代；不得拼接 shell 字符串；
3. fake child+grandchild 测试记录两者独立 nonce/开始时间，在正常关闭与强杀后分别探测；二者都必须不存在或已发生 identity change；
4. 只有收到 direct child `close` 且 tree probe 通过，才写 `process-closed.v1` 收据。

checkpoint/resume 只接受该关闭收据及其 SHA-256。若宿主崩溃而没有收据，即使同 PID 当前不存在也不自动 resume，状态为 `FAILED_CLOSED/ORPHAN_AUDIT_REQUIRED`；人工审计不属于本 PR 的自动路径。

### D6 — 闭合 Cordis composition 与确定性模型

`replay.cordis.yml` 只装载完成 loop 所需的精确组件：XW protocol server、agent spine/loop、session JSONL persistence、checkpoint policy、deterministic scripted replay LLM、XW replay tools。不得装载 bash、pwsh、fs、editor、web、HTTP、terminal、subagent、MCP、ADB 或其他 provider/tool。

deterministic adapter 只消费受版本控制的 scripted turns，并产生可预测的 10-tool 调用；无网络、无 API key。启动时静态 inventory 配置，运行时再从真实 `session.event(type=request/header).data.header.tools` 取证。canonical name 集合必须恰好相等，且每个 schema hash 与共享 spec 一致；出现额外工具、缺工具或重复工具立即失败。

### D7 — 单一 tool spec、双侧输入与闭合输出

扩展 `orchestrator/src/m6-tool-surface.mjs`：

- 导出 canonical 10-tool spec、输入 schema/validator 与 `validateToolResult`。
- 所有 object schema `additionalProperties=false`；字符串、数组、递归深度与总序列化字节有上限。
- Cordis tool schema 从该 spec 机械生成；handler 入口仍调用共享 `validateToolCall`，返回前调用 `validateToolResult`。
- tool result 禁止 coordinate/bounds、ADB/port、shell/command、URL、token/credential、lease、DB、payment/delete、raw screenshot/base64；只返回 opaque refs、hash、枚举、计数、布尔和有界诊断。
- mutation tests 分别打破 Cordis schema、handler 输入、handler 输出和 receipt verifier，必须在对应边界失败，并证明该边界被实际执行。

### D8 — run packet、synthetic act 与幂等 journal

host 只把 versioned run packet 的 opaque ref 与 canonical hash 放进受验证 child profile。packet 包含 manifest/frame refs、scenario、预算、expected route、policy/corpus hashes，不含 raw screenshot、坐标、设备 serial、token 或 live authority。

child plugin 验证 packet hash后建立 session-local replay state：

- `phone_observe` 物化 synthetic evidence 并返回 frame/block refs；
- `phone_ground` 通过唯一 GroundingRuntime 产生 decision；
- `phone_act` 只消费 ALLOW_ONCE decision，按冻结 transition table 更新 synthetic state；返回 `externalEffect=false`、`actionCount=0`；同 `(sessionId, toolCallId, operationKey)` 重放返回相同 result，不再推进状态；换 key 重放同 decision 拒绝；
- `phone_verify` 对 synthetic after-state 做确定性验证；REPLAN/HARD_STOP 路线 action tool count 为 0。

XW replay journal 是 child-local、append-only、canonical JSONL；synthetic transition 与 operation result 在 tool result 返回前 flush+fsync。journal 只含 refs/hash/枚举/计数，不含禁用数据。其 prefix hash进入 checkpoint，恢复时用于 DSH transcript/tool result 与 synthetic state 对账，不能由当前 runtime 输出反推 expected oracle。

### D9 — checkpoint/resume 的有限语义

M6-3 checkpoint 只覆盖 replay worker/process，不声称 M6-5 live recovery。checkpoint 记录：schema/version、workerRunRef、DSH session id、最后持久 event seq、XW journal prefix/hash、synthetic state hash、budget counters、所有 lock/config/tool/corpus/policy hashes、process close receipt ref；不存 raw screenshot、坐标、secret、env 或 provider body。

顺序：停止派发 → 完成本步 tool result journal fsync → `ctx.sessions.flush(session)` → 写 canonical checkpoint temp file并 fsync → atomic publish → 正常 shutdown → 写 process-closed receipt。只有 checkpoint 和 close receipt 都有效才可 resume。

恢复：验证全部哈希与 schema → 验证 close receipt/processRef → 新 DSH process 以 `sessionMode=resume` 启动 → 公共 `agents.resume()` 装载同 session → 校验首个 resumed event seq/header/tool inventory/journal prefix → 只继续未完成 route。不得用新 session id重播历史冒充恢复。

故障恢复：若 DSH JSONL 已有 tool result但 checkpoint 未推进，以 journal与 `(toolCallId,operationKey)` 对账并返回同结果；若两者不一致、存在未知 outcome、坏 JSONL、seq gap、hash drift、缺关闭收据或旧 incarnation 仍可能存活，失败闭合，不重试 synthetic act。

## 4. 文件面

计划内文件（preflight 可细化文件名，但不得扩大能力边界）：

### `integrations/dsh-xw/`

- 保留并小改 `plugin.mjs`：fixture discriminator，禁止 spawn。
- 新增 `package.json`、`package-lock.json`：独立 exact rc.7 dependency closure；不提交 `node_modules`。
- 新增 `replay.cordis.yml` 与 versioned `replay-profile.v1.json`。
- 新增 `process-adapter.mjs`：真实 SDK client、WorkerRun lifecycle、notification completion、trace/receipt。
- 新增 `stdio-supervisor.mjs`：line-buffered store-and-forward、预算、backpressure、跨平台 tree cleanup、process-closed receipt。
- 新增 `xw-sdk-protocol-server.mjs`：协议兼容 server、严格 session mode、公共 agents create/resume。
- 新增 `xw-replay-tools.mjs`、`deterministic-replay-llm.mjs`、`replay-journal.mjs`、`checkpoint-store.mjs`。
- 新增 `test/`：protocol fake peers、真实 child E2E、cross-process resume、tool inventory、mutation、fault、process tree、latency。
- 更新 `README.md`：fixture/process 区分、安装/运行、零 live、故障码、evidence 与 cleanup。

### `orchestrator/`

- 扩展 `src/m6-tool-surface.mjs`：唯一 specs + input/output validation。
- 新增 `src/m6-dsh-replay-worker.mjs`：依赖注入 process adapter；不得注册 M5 Router。
- 新增/更新测试：worker state machine、replay routes、checkpoint/resume、禁用字段与回归。

### `tools/m6/`、CI 与文档

- 扩展 `dsh-inventory-check.mjs`：fixture no-spawn、exact closure/integrity/license、source/tree、config/plugin/model/tool inventory、无 tracked node_modules。
- 新增可复现 M6-3 evidence runner/verifier，生成 manifest、independent inventory、completion receipt。
- `.github/workflows/source-fusion.yml` 新增 Windows/Ubuntu `m6-3-replay` matrix：`npm ci --prefix integrations/dsh-xw` 后跑硬门；无 `continue-on-error`。保留现有 offline/no-install job。
- 更新精确 post-import allowlist，不使用目录通配；更新 M6 文档与 runbook。

## 5. WorkerRun 状态机

`CREATED → PACKET_VERIFIED → PROCESS_STARTING → INITIALIZED → SESSION_BOUND(create|resume) → PROMPT_ACKED → TOOL_LOOP → IDLE_VERIFIED → CHECKPOINTED? → SHUTTING_DOWN → PROCESS_CLOSED → COMPLETED`

任一异常：`… → FAILING_CLOSED → TREE_TERMINATING → PROCESS_CLOSED | ORPHAN_AUDIT_REQUIRED → FAILED_CLOSED`

恢复只能：`CHECKPOINT_VERIFIED + PROCESS_CLOSED → PROCESS_STARTING(new processRef, sessionMode=resume)`。任何状态不得同时持有两个 live DSH handles；adapter 按 `workerRunRef` 串行化 start/resume/close。

## 6. 执行 Gate 与阻断条件

### Gate A — 干净基线、依赖和两项可行性 spike

1. fetch，记录 `origin/main`，从其建干净 worktree；核对 M6-2 收据哈希/语义，确认 gate CLOSED、资源零、live disabled。
2. 临时非提交目录 exact 安装 rc.7，记录 registry integrity/license、CLI/package/source/tree；生成最终 lockfile并验证 clean reinstall。
3. 最小真实 child：initialize → prompt ack → matching inbox receipt → idle → shutdown；证明 stdout 是真实 SDK wire。
4. 两个全新 OS process、同 persistence root/session id：process 1 create+完成 turn+flush+close；process 2 以 XW server `resume` 路径调用公共 `agents.resume()`，证明 prior message/header/tool result 可见并继续新 turn。探针同时断言 `agents.create()` 在同条件会失败，防止错误路径也变绿。
5. 从真实 notification 捕获 `request/header.tools`，与 10-tool expected oracle 对比。

Gate A 任一失败即 `BLOCKED_NEEDS_DECISION`。尤其不得删除 resume、换 id、用 fixture 或只依赖源码静态推断继续。

### Gate B — lock、protocol supervisor 与 process tree

1. 提交 standalone lock/profile/config，inventory 验证 exact dependency closure、integrity、license 与禁止包/工具。
2. 实现 line-buffered supervisor 和真实 SDK process adapter；command/env/cwd 只来自 profile，敏感环境不默认继承。
3. fake peers 覆盖 partial/multiple/oversize line、invalid UTF-8/JSON/envelope、duplicate/unknown id、child request、response timeout、EOF残帧、stdout/stderr/notification/pending cap、slow reader backpressure。
4. Windows/POSIX child+grandchild 正常与强杀测试，验证 exact process identity 和 tree=0；Windows 必须实际命中 direct `taskkill.exe /T /F` fallback 路径一次。
5. 运行 40 次三档 line-size proxy microbenchmark，保存原始样本与统计；不得用它替代 Gate E 真实 warm SLO。

### Gate C — Cordis replay tools 与模型面

1. 从共享 spec 生成并注册 10 tools；handler input/output 二次校验。
2. happy route 必须是 `worker_start → phone_observe → phone_ground → phone_act → phone_verify → checkpoint_save → trace_query → worker_complete`；continue route覆盖 `worker_continue`；受控等待覆盖 `wait_human`。
3. REPLAN/HARD_STOP 路线不调用 `phone_act`；所有路线 externalEffect=false/actionCount=0。
4. runtime `request/header.tools` 独立 inventory 恰为 10；内置/额外/重复/缺失/schema drift 均失败。
5. mutation tests 命中 Cordis schema、XW input validator、XW output validator、forbidden-field scanner、GroundingRuntime 单次授权与 journal idempotency。

### Gate D — checkpoint/resume 与 fault matrix

1. 完成 create→checkpoint→close receipt→new process resume→continue→same final state；检查 session id相同、processRef不同、无并发 writer、prior transcript 可见。
2. 独立 expected route/state hashes来自受版本控制的 scenario oracle，不得从 SUT trace生成。
3. fault matrix：kill-before-call、kill-after-prompt-ack、kill-after-tool-journal-before DSH result、kill-after-tool-result-before-checkpoint、kill-after-checkpoint-before-shutdown、bad/partial JSONL、journal mismatch、seq gap、profile drift、duplicate/ordered notifications、resume without close receipt、resume while old process alive。
4. 每个 fault 断言 canonical code、唯一 close sequence、无重复 transition、无 live effect、tree=0或显式 `ORPHAN_AUDIT_REQUIRED`。

### Gate E — 性能、矩阵与真实链硬门

1. Windows 固定 profile 下至少 40 个 warm `session/prompt` ack 样本，从 request write 到匹配 response parse，包含 supervisor store-and-forward，p95 ≤100 ms；cold startup 单列。
2. 真实 child happy route至少20次，REPLAN/HARD_STOP各至少5次；结果确定，一 worker 同时一 child，clean close 100%。
3. Windows/Ubuntu CI 都执行 exact `npm ci`、inventory、real child E2E、resume、fault 和 cleanup；不可软失败。
4. 若 GitHub hosted runner 的噪声不适合 100 ms 硬 SLO，功能矩阵仍为硬门；延迟硬门绑定 versioned self-hosted Windows runner。不能把阈值改为报告项。

### Gate F — 全回归、安全审计与完成收据

1. 跑现有 M4/M6/orchestrator/kernel/fusion/authority 与 M6-2 regression；fixture tests 保持全绿。
2. 扫 Git diff、config、schemas、trace/receipts：不得含 secret、raw screenshot/base64、coordinate/bounds、device serial、ADB/port、lease、DB、payment/delete 值。
3. 验证未接 M5 Router/Binder、gate CLOSED、live actions disabled；真实 run 后资源归零。
4. 单一 M6-B PR，merge commit禁止 squash。merge candidate 重跑所有硬门并生成 `xw.m6-3-completion-receipt.v1` 与独立 inventory/manifest。

## 7. 验收矩阵

| 不变量 | 必需证据 | 失败处理 |
|---|---|---|
| 真 DSH/Cordis 而非 fixture | child package/source/tree/integrity、serverInfo、PID/processRef、adapterKind | 不完成 M6-3 |
| 正确 create/resume 路由 | 两个新 OS process、同 session、public resume path hit、create negative control | Gate A 阻断 |
| 单 writer/进程身份 | workerRunRef→active processRef 唯一、close receipt、并发 mutation | fail closed |
| 模型面恰为 10 tools | runtime `request/header.tools` + independent expected inventory | 终止 child |
| 双侧闭合 schema | Cordis/input/output/receipt mutation及 path-exercised | CI fail |
| 唯一 GroundingRuntime | import/hash inventory、forbidden alternate implementation scan | CI fail |
| replay-only | externalEffect=false、actionCount=0、无 live dependency、REPLAN/HARD_STOP no-act | 拒绝 receipt |
| protocol 有界 | frame/id/budget/backpressure fake peers + real client path | fail closed |
| checkpoint 可判定 | DSH flush/seq、journal fsync/hash、same-session resume、independent oracle | 拒绝 resume |
| process tree 归零 | Windows/Ubuntu normal/fault inventories，Windows fallback hit | CI fail |
| fixture/process 可区分 | discriminator + cross-claim negative tests | 阻断合入 |
| CI 可复现 | standalone lock clean install、no-install job保留、无 soft fail | 阻断合入 |

## 8. 预算、错误码与可观测性

预算除第3节 transport 默认外，还包括：每 run 10分钟、最多32个 tool calls、observe最多4次、ground最多4次、synthetic act最多1次/decision、checkpoint最多4个、trace/receipt单文件4 MiB。任一预算超限走统一 cleanup。

至少定义：`M6_DSH_PROFILE_DRIFT`、`M6_DSH_PROTOCOL_INVALID`、`M6_DSH_STDIO_LINE_LIMIT`、`M6_DSH_STDOUT_BUDGET`、`M6_DSH_STDERR_BUDGET`、`M6_DSH_UNKNOWN_RESPONSE_ID`、`M6_DSH_DUPLICATE_RESPONSE_ID`、`M6_DSH_CHILD_REQUEST_FORBIDDEN`、`M6_DSH_PROMPT_ACK_TIMEOUT`、`M6_DSH_IDLE_TIMEOUT`、`M6_DSH_TOOL_INVENTORY_MISMATCH`、`M6_DSH_TOOL_INPUT_INVALID`、`M6_DSH_TOOL_RESULT_INVALID`、`M6_DSH_RESUME_UNSUPPORTED`、`M6_DSH_RESUME_IDENTITY_MISMATCH`、`M6_DSH_CHECKPOINT_INVALID`、`M6_DSH_JOURNAL_MISMATCH`、`M6_DSH_PROCESS_CLOSE_UNPROVEN`、`M6_DSH_PROCESS_TREE_LEAK`。

trace 使用 canonical JSONL：run/process/session refs、request id/method/status、event type/seq、tool name/call id/operation key hash、budget counters、hash ledger、cleanup transitions。不得记录 prompt全文、reasoning、raw provider body、secret、raw image或坐标。

## 9. 推荐执行顺序与提交边界

1. Gate A spike；任何 blocker在写产品代码前暴露。
2. lock/profile/inventory 与 supervisor fake-peer/process-tree tests。
3. XW protocol server + closed Cordis composition + runtime tool inventory。
4. tool spec/results、replay journal、process adapter、worker state machine。
5. checkpoint/resume 与完整 fault matrix。
6. 性能、Windows/Ubuntu CI、全回归、安全审计与 completion evidence。

允许一个 PR、多个可审提交；每个提交保持测试可运行。不得把 M6-4/M6-6 接线夹带进 M6-B。

推荐验收入口（实施时在 package scripts/runner 中固定，completion receipt记录实际命令和输出哈希）：

```powershell
npm ci --prefix integrations/dsh-xw
npm test --prefix integrations/dsh-xw
npm run test:real --prefix integrations/dsh-xw
node tools/m6/dsh-inventory-check.mjs
node tools/m6/run-m6-3-evidence.mjs
```

还必须执行仓库既有 no-install/offline、orchestrator、kernel、fusion、authority 与 M6-2 regression命令；不得因本计划未硬编码可能变化的现有脚本名而省略，执行者应从最新基线 package/workflow 读取并在收据中列全。

## 10. 回滚与失败策略

- process adapter 未进入 M5 Router，回滚只需移除新 adapter/worker/CI并恢复 fixture marker；不触碰 live gate、device或M6-2 evidence。
- 真实链故障可以用 fixture诊断，但 fixture永远不能生成 M6-3 completion receipt或打开 M6-4。
- exact rc.7 无法安装、runtime tool inventory不闭合、SDK parse前无法限界、Windows/POSIX tree无法收敛、cross-process resume无法证明、独立 oracle不成立，任一即阻断；不得降级验收。
- completion 后 gate仍 CLOSED。M6-4 必须以独立计划显式接 live authority；M6-6 才能把 `agentic_session` 放进 TaskPlan/M5 router/binder。

## 11. Definition of Done

1. frozen lock/profile/config/model/tool/corpus/policy hash ledger完整、可clean reinstall。
2. 真实 rc.7 DSH/Cordis child 在Windows/Ubuntu跑通真实 SDK wire与 replay全链。
3. 两个全新OS process的同-session create/resume路径真实命中公共API；checkpoint与journal可确定恢复。
4. runtime工具集合恰为10，双侧schema与输出扫描有mutation/path-exercise证据。
5. 所有act为synthetic，externalEffect=false/actionCount=0；无live依赖、无M5接线、gate CLOSED。
6. protocol budgets/backpressure/ID/timeout和Windows/POSIX树清理故障矩阵全绿。
7. warm p95达标；real route counts、independent inventory、manifest与receipt可复现。
8. fixture/process不混淆，旧回归与新增硬CI全绿，无soft-fail。
9. `multi-model-execution-completion.v1` 覆盖执行契约全部items/probes；随后由独立 GPT execution review核对diff和证据，才可宣告M6-3完成。

## 12. Multi-model review 裁决记录

评审输入：Plan V1 SHA-256 `a7de1e90354e486a17ec603cdaf45ff12d9502420620c14ff420bf1bd8b0a3e9`；context SHA-256 `b3d9ab88b6444c94e779eb97112435b8bc2da92ebc86180a3137094ee57b5569`；batch artifact `docs/plans/reviews/m6-3-v1/review-batch-plan.json`。

评审批次为单波 HIGH review，`degraded=true`：coverage route在CPA preflight遇到403，无成功报告；原adversarial route探测遇到402，batch按skill规则晋升健康的 Ollama DeepSeek `deepseek-v4-pro:0813`，产生一份正式adversarial报告。没有追加外部模型调用或第二轮评审。

| Finding | 裁决 | Plan V2变化 |
|---|---|---|
| F1/P1：跨新进程复用session id缺少可执行依据 | `ACCEPT` | 源码确认stock SDK server只create；新增XW协议server显式create/resume，并把两进程negative-control spike设为Gate A blocker |
| F2/P1：`request/header.tools`没有真实事件依据 | `REJECT` | rc.7 core类型与jsonrpc-agent snapshots均证明真实事件；Plan V2删除“或等价事件”模糊措辞，固定取该事件 |
| F3/P1：Windows进程树终止不具体 | `ACCEPT` | 固定shell:false直启System32 taskkill `/PID /T /F` fallback、owner校验和child+grandchild path test |
| F4/P2：称transparent但必须整行校验 | `ACCEPT` | 政名为line-buffered store-and-forward，增加三档microbenchmark，真实warm SLO含其开销 |
| F5/P2：PID-only死亡证明弱 | `ACCEPT` | 引入processRef/live handle/spawn identity与process-closed receipt；无receipt不自动resume |

本表与正文组成唯一 Plan V2；不存在 Plan V3。实施中新发现需要改变能力边界、删除硬门或改变resume/进程安全架构时，停止并请求新决策，不能就地改写本计划。
