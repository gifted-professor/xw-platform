# M5 收口与合入计划 V2（终版）

> 目标：从 `feat/m5-orchestration-layer@6fc376a` 出发，关闭唯一缺失的真机故障隔离验收，先合 M5-0 PR #35，再以一个 M5 功能 PR 用 merge commit 合入 `main`。不部署新 release。

> Review：Plan V1 artifact SHA-256=`E74D7667715417F0EE65C64FB5BD3D42A92DFB97103FA5EC2F4521335E58C47F`；HIGH 路由，Kimi coverage 失败后批次降级，Grok adversarial 报告完成；GPT 已一次性裁决并收敛。本 V2 不再自动复审，也不生成 V3。

## 1. 冻结事实

- 任务书：`docs/plans/M5-task-brief.md`；基线 `main@db8885eb00b50ba80677cebd865e4765e3d7929e`。
- GitHub `main` 当前仍为 `db8885e`；本地 M5 分支比它多 9 个提交、48 个文件、约 `+3187/-90`。精确序列为 `56374e0`、`eb106ff`、`3bd2fc1`、`658d188`、`bdd5d05`、`7165787`、`1b1c124`、`6bbd1d9`、`6fc376a`。
- PR #35 仍 OPEN/DIRTY，远端 head=`c69d71f`、base 仍显示旧的 `b639083`，没有当前 checks；本地 `feat/m5-zero-test-baseline@eb106ff` 已基于 `db8885e`，含 M5-0 `56374e0` 和 Windows registry 稳定化 `eb106ff`。
- 代码门已绿：`test:orchestrator` 407/407；check/fusion/authority/kernel/M4/M0/runtime tools/test:fusion 通过；review 的两个 P1 已通过 VERIFY_FIXES。
- 四机成功演示已通过：trace `trace-m5-live-success-20260820d`，4/4 accepted，cardCount=8，queryTrace 17/17 连续。
- 唯一缺失验收：alias 03 serve 停止时，该节点失败且其它三路成功。此前两次演练均无效；更重要的是使用了任务书明确禁止的退役脚本 `services/control-plane/scripts/fast-operator-serve-task.ps1`。
- 当前 live 已恢复：release=`xw-20260819-f337079`、四机 ready、serve 全监听、activeLeases=0、runningJobs=0、三 live gate CLOSED。

## 2. 边界与停止条件

- 不新增设备能力，不改 runtime release，不开 live gate，不直写 `control.db`/`registry.db`，不绕 lease，不碰支付。
- 调度仍走 M5 DAG adapter → TaskPlanV2/ExecutionPlanV2 → 现有 scheduler；故障演练不得另造 scheduler。
- PR 一律 merge commit，禁止 squash；PR #35 与 M5 功能保持两个独立 merge commit，便于独立回滚。
- GitHub 发布动作按顺序单独执行：更新 PR #35 head、合 #35、push M5 head、创建 M5 PR、合 M5 PR。任一步没有明确授权或 CI 未绿就停。
- 真机故障演练只允许一次新的有界运行。任何恢复失败、端口状态不确定、活跃 lease/job、App focus 不确定都在派发前 fail-closed。

## 3. F0：修正账本并冻结合入候选

1. 修正 handoff：明确前两次使用的是退役脚本、证据无效；删掉“正式脚本”误称。
2. 在 M5 分支建立本地备份引用，分别冻结 `db8885e..eb106ff` 与 `eb106ff..6fc376a` 的 `git log`、patch-id/range-diff、候选 SHA、机器门、live release 和资源快照；不碰主工作区。
3. 将本计划经 multi-model plan review 收敛为唯一 Plan V2；之后不再生成 Plan V3。

退出门：候选工作树只含获批的计划/账本变更；`git diff --check` 通过。

## 4. F1：先关闭 M5-0 PR #35

1. 在现有 `m5-m0` worktree 复核 `eb106ff` 相对 `db8885e` 只含 M5-0 与 Windows 启动稳定化变更。
2. 用远端 head `c69d71f` 作为 lease 更新现有 PR #35 分支；因为本地分支已 rebase，更新必须精确写成 `--force-with-lease=refs/heads/feat/m5-zero-test-baseline:c69d71f`，禁止无 lease force。
3. push 后重新读取 PR #35：要求 base=`main` 且 base OID=`db8885e`、head=`eb106ff`、mergeability 不再 DIRTY；任一不符即停，不消耗 merge 动作。
4. 等待 Ubuntu/Windows source-fusion 全部硬绿；尤其确认 Windows 直接 `npm run test:orchestrator`，没有 `continue-on-error` 和 orchestrator allowlist。
5. 用 merge commit 合并 PR #35；读取 GitHub 返回的 merge SHA，并验证 `origin/main` 包含两笔本地修复的等价 patch。

退出门：#35 MERGED；main CI 绿；M5-0 可独立回滚；没有修改 live runtime。

## 5. F2：把 M5 功能重放到新 main

1. fetch 新 main；从 `feat/m5-orchestration-layer` 的备份引用开始，执行语义等价于 `git rebase --onto <post-35-main> eb106ff <m5-backup>`。只允许重放以下 7 笔：`3bd2fc1`、`658d188`、`bdd5d05`、`7165787`、`1b1c124`、`6bbd1d9`、`6fc376a`；避免用易误读的 `3bd2fc1..6fc376a` 作为提交清单。
2. 如有冲突，只处理 main 与 M5 真实重叠；保留 PR #35 的 CI/test-gate 版本，保留 M5 的 catalog/trace/runtime/allowlist 登记。
3. 核对提交序列、patch-id 和 `git range-diff`：Router/Compiler、Trace、validator、runtime/CLI、两个 review fix、handoff 均存在；M5-0 两笔不再出现在功能 PR diff。

退出门：工作树干净；M5 diff 只含 M5 本体、合同、测试、架构/任务书/handoff。

## 6. F3：一次确定性的 alias 03 真机隔离演练

### 6.1 预检

1. `xw-start --check --json`：release/source 不变，01..04 ready/free，四个 serve listening，ADB 5038 稳定，activeLeases=0、runningJobs=0。
2. 证明 17898 listener 归属：读取 scheduled task action、task state、`Get-NetTCPConnection -LocalPort 17898 -State Listen` 的 PID、该 PID/parent chain 的 `Win32_Process.CommandLine`；必须绑定当前 release 的 alias 03 FastOperator。归属不一致时先走正式 xw-start recovery，然后在创建 drill run 前 abort，不能烧掉唯一演练。
3. 用正式 Explorer session/lease 将四台 XHS 前台状态证明为 `com.xingin.xhs.index.v2.IndexActivityV2`，在 `finally` 释放 session。释放最后一个 lease 后 2 秒内立即再次读取正式 focus 证据并进入 `executeM5Goal`；任何 alias focus 不符或 handoff 超过 2 秒就 abort，不注入故障。不得在 mission job lease 外保留 Explorer lease。
4. 创建唯一 closeout run、traceId 和 runtime evidence 目录；记录 17898 listener、scheduled task、focus proof 与 dispatch 的单调时间戳。

### 6.2 故障注入

使用一次性、留在 runtime evidence 目录的 acceptance runner；它只组合现有公开模块，不修改仓库或设备能力。runner 的完整源码必须在执行前原样附入 handoff，记录 SHA-256，执行文件 SHA 必须与 handoff 一致：

1. 仍调用 `executeM5Goal`、正式 `ControlPlaneHttpClient` / `TypedJobWorker` / `MissionWorkerRouter`、既有 store/TraceStore。
2. 仅包装 `worker.execute(assignment)`：当前 `task-orchestrator.mjs` 的 happens-before 锁定为 `traceBridge.skillStarted(...)`（L320）→ `worker.execute(assignment)`（L321）。当第一次进入 `assignment.alias === "03"` 的包装器时，03 的 `WorkerAssigned`/`SkillStarted` 已持久化；包装器在调用真实 worker 前执行：
   - `Stop-ScheduledTask -TaskName 'XW Platform FastOperator 03'`；
   - 有界轮询确认 17898 不再监听；
   - 保持 03 serve 停止直到整个 mission 结束。
3. 01/02/04 直接进入原 worker，不等待 03；`startWork` 只把 promise 放入 active map，不 await 03，所以 04 仍可派发。03 的后续安全 retry 继续保持 serve 停止。
4. runner 最外层必须 `finally`：`Start-ScheduledTask -TaskName 'XW Platform FastOperator 03'`，有界等待 17898 恢复。不得调用退役 wrapper、`Stop-Process`、`taskkill` 或直写 DB。
5. 数值边界：stop 后最多 15 秒、每 100ms 检查一次 17898；mission 最多 120 秒；start 后最多 30 秒恢复监听。TaskPlan 仍用既有 `maxAttemptsPerShard=2`，runner 不改 retry 数。

这种注入发生在真实 03 节点 `SkillStarted` 与正式 job submit 之间；事件顺序由上述相邻代码行证明，不把“执行前先停机”冒充“中途故障”。调度、授权、lease、正式 job submit 和设备请求仍全部走原底座。

### 6.3 通过条件

- 03 为 failed/blocked，真实 worker 在端口确认关闭后仍要提交正式 job，保留 job/attempt/error；01/02/04 各自 accepted，cardCount 均可验证，彼此不受影响。
- traceId 全链一致、seq 连续；03 有 `SkillFinished(status=failed|blocked)`，若发生 retry 则有 `RepairTriggered`；`task-orchestrator.mjs` 只有 `result.validation.ok===true` 才写 `ValidationPassed`，因此本失败场景不得出现该事件，并用现有 isolation/validator regression test 复核。
- 端口 stop/start 时间戳、task state、trace、jobId、DAG/TaskPlan/ExecutionPlan hash、closeout work root 全部落证据。
- 恢复后运行正式 xw-start recovery（只在 unresolvedFailure 存在时），最终 03 listener 恢复，四机 ready，activeLeases=0、runningJobs=0、pending approval=0。

失败处理：在 `finally` 恢复服务并归零资源；本轮不做第二次重跑，M5 不进入发布阶段，返回 BLOCKED_NEEDS_DECISION。

## 7. F4：最终源码门与 handoff

1. 将有效 failure drill 和最终恢复证据更新进 handoff；删除旧证据的任何“通过”表述。
2. 提交后运行：
   - `npm run check`
   - `npm run fusion:verify`
   - `npm run test:orchestrator`（必须 0 fail）
   - authority、kernel、test:fusion、test:kernel、M4-A/B/C/D、M0、runtime tools
   - `npm run test:gate`，确认 orchestrator PASS 且无 unexpected failure
3. 定向重跑 Router/DAG/catalog、TraceStore/queryTrace、runtime/CLI、scheduler isolation、两个 review fix。
4. `git diff --check`、secret scan、服务树 post-import allowlist、`git status --short` 全部复核。

退出门：全部源码门绿；真机成功和单机失败两份证据齐；multi-model execution final evidence gate 没有未关闭 P0/P1。

## 8. F5：M5 PR 与 merge commit

1. push 当前 M5 分支；确认远端 head 与本地 SHA 一致。
2. 创建一个非 draft M5 PR，base=`main`，PR 描述逐项链接任务书、设计、成功 trace、失败 trace、恢复快照和机器门；不得把已有 PR #35 内容重复列为 M5 diff。
3. 等待 Ubuntu/Windows 必需 checks 全绿；重新读取 mergeability、review threads 和 head SHA，防止检查期间 main/head 漂移。
4. 用 merge commit 合入，禁止 squash/rebase merge；记录 merge SHA 和两个 parent。

退出门：M5 PR MERGED；GitHub main 指向含 M5 merge commit 的新 head；所有 required checks 成功。

## 9. F6：post-merge 只读验收与回滚

1. 从合并后的远端 main 做干净只读验证：`check`、`fusion:verify`、`test:orchestrator`，并确认任务书/架构/handoff 可达。
2. 只读检查 live：release/sourceCommit 未变、三 live gate CLOSED、四机 serve/ADB 正常、0 lease、0 running job、0 pending approval；不重复设备演示。
3. 最终回报 PR #35 merge SHA、M5 PR/merge SHA、CI 链接、两条 trace、四机 jobIds、恢复证据和剩余非阻塞 backlog。
4. 回滚策略：M5 故障只 revert M5 merge commit；M5-0 独立故障才 revert #35 merge commit。保留 JSONL 审计证据，不删 DB、不做 down migration、不回退 PR #28/#29。

## 10. 完成定义

只有以下全部成立才宣布 M5 已合入完成：PR #35 与 M5 PR 均以 merge commit 进入 main；源码/CI 门全绿；成功场景 4/4；一次有效的 03 serve 隔离场景 1 fail + 3 accepted；trace 完整；live release/gates 未变；最终资源归零。

## 11. Review 决策日志

- `F-1` ACCEPT/P1：加入 listener PID/command-line/task ownership 预检；不匹配在 drill 创建前 abort。
- `F-2` ACCEPT/P1：把四机 focus proof 改为紧贴 execute 的 2 秒内 lease handoff，并记录时间戳。
- `F-3` REJECT/P1、ACCEPT/P2 文档澄清：仓库事实证明 scheduler 在相邻两行先持久 `SkillStarted` 再调用 wrapper；任务书未要求 jobId 必须先存在。V2 锁定 happens-before，同时要求端口关闭后仍提交正式 03 job。
- `F-4` ACCEPT/P1：冻结两段 commit/patch 清单，写成精确 `rebase --onto` 语义与 7 笔白名单，push 后重新验证 #35 base/head。
- `F-5` ACCEPT/P2：runner 完整源码先入 handoff 并做 SHA 绑定，runtime 执行副本可复核，但不把 live drill 命令装进 release。
- Kimi coverage 两次均未返回可解析 JSON，批次按 degraded 规则使用 Grok 报告并由 GPT 裁决；没有追加 reviewer。
