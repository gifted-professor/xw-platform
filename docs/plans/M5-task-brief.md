# M5 任务书 — 编排层（Task Router / Plan Compiler / Event Trace）

> 派发用。执行者完成后按「验收清单」逐条自证，review 按同一清单逐项核。
> 日期：2026-08-20。基线：main@db8885e（PR #28/#29/#32/#33/#34 已合）。
> 2026-08-20 核查修订：serve 演练命令（§1 P-1 / §3）、M5-0 测试点名与 CI 改动点（§1.2）已固化。

## 0. 背景一句话

设备控制层（M3/M4 + 四机真机）已完成并验证。M5 只长在它上面：**编排 + 观测**，不新增任何设备能力。

## 1. 前置任务（先做，阻塞后面）

- [x] **P-1 合并 PR #28**（feat(runtime): consolidate XW skill and machine configuration）
  先 rebase 到最新 main，解决与 PR #32 的冲突（xw-start.mjs 同一文件），CI 绿后 merge commit 合入。
  ⚠️ 合入后**确认四机 serve 的受管任务名**（本仓库已核：main 与 PR #28 分支一致为
  `XW Platform FastOperator {01..04}`，runtime root `C:\Users\Public\xw-runtime`，launcher
  `launch-fast-operator-serve.ps1`，端口 01=17895/02=17897/03=17898/04=17896）。
  已退役的 `services/control-plane/scripts/fast-operator-serve-task.ps1`（管 `XhsFastOperator${Alias}Live`、
  root `xhs-agent-control\fast-operator`）**不得再用于 M5-C 演练**。
- [x] **P-2 评审并合并 PR #29**（feat(plan): M4-D parallelism contracts and plan compiler）
  同样 rebase + CI 绿 + merge commit。这是 M5 的合同基础，`packages/plan-compiler` 由此进 main。
  合同 schemaId 已核：`xw.execution.plan.v1`（`packages/kernel/contracts/parallelism/execution-plan.v1.schema.json`）。

### 1.1 说明（防误读）

- `xw-mission.mjs` **已存在**于 `services/orchestrator/ops/xw-mission.mjs`，M5 只是给它加
  `--goal/--execute` 形态，**不是新建**；不要在 `packages/cli` 下重建。
- 本任务书 `docs/plans/M5-task-brief.md` 目前未跟踪，需随 M5 首 PR 纳入版本控制
  （计划要求「任务书纳入版本控制」，别漏这一步）。

## 1.2 测试债清零（M5-0，单提交先于功能代码合入）

1. **退休两个一次性 scope 测试——点名在 `services/orchestrator/tests/nonpayment-liveness.test.mjs`**：
   - `"the earlier approved implementation remains frozen inside its own scope"`（~L37，
     `git diff acc1f3d9..755fa657`，把旧 xhs-registry 谱系冻结 baseline 比到当前树）
   - `"repository A current changes stay exclusively inside the repair command scope"`（~L44，
     `git diff 755fa657 → HEAD`）
   - 失败根因：`acc1f3d9/755fa657/5d5ed277` 在本仓库不存在，`git cat-file` 失败 → `git diff`
     非零退出 → assert 抛错。**保留**同文件其余两条：plan hash/authorization frozen（L25）、
     scope 唯一性（L72）。
2. **修 Screen cold-cache 探针**（`registry.test.mjs` `"concurrent observer screen requests on a cold cache
   share exactly one disk load (singleflight)"`）：计数根与测的路径 realpath + Windows 大小写归一，
   再用 `path.relative` 判根内，验证 cold=1/warm=0。
3. **目录 symlink 清理**改用 `unlinkSync` 删链接（Windows directory symlink 不能 `rmSync`）。
4. 剩余 POSIX-only Windows 路径断言改显式 `path.win32` 或可注入实现。
5. **test-gate 修正**：测试进程非零退出且解析不到失败名时必须 BLOCK（`tools/fusion/test-gate.mjs`）。
6. **同步改 CI**（M5-0 明确列入）：`.github/workflows/source-fusion.yml` 第 58-61 行
   orchestrator step 去掉 `continue-on-error: ${{ runner.os == 'Windows' }}`、直接
   `run: npm run test:orchestrator`（root 已存在该 script）。control-plane step（L63-66）按
   P-2 约定另议，不在本单默认范围。
7. 清空 orchestrator known-failure allowlist（`docs/fusion/test-baseline.v1.json` 当前 5+2 条），
   Windows/Ubuntu 均硬门。

## 2. M5 本体（三个模块）

### M5-1 Task Router（放 services/orchestrator，不新建服务）

- 输入：自然语言任务或结构化 goal；输出：任务分类 + 执行策略
- 任务分类先支持三类：`search`（多信息源 fan-out）、`collection`（设备状态采集）、`validation`（结果验收）
- 输出形如 `{type, parallel, workers, strategy, validatorRequired}`，只引用已注册 skillId，不碰设备
- 接现有 `services/orchestrator` 的 goal/task 入口；未知类型 fail-closed 返回 `needs_human`

### M5-2 Plan Compiler 落地（基于 PR #29 的 contracts）

- 输入 Task Router 的分类结果，输出执行 DAG（JSON）：节点 = skillId + 参数 + 依赖边 + 目标 alias 约束
- 硬约束：节点只能引用 skill 合同内的能力；不得生成无 lease 旁路；外发类节点必须标 `requiresHuman: true`
- 提供 `--dry-run`：只出图不执行

### M5-3 Event Trace（统一事件汇）

- 新增事件流：`TaskCreated / PlanGenerated / WorkerAssigned / SkillStarted / SkillFinished / ValidationPassed / RepairTriggered`
- 复用 kernel 的 correlation-ids schema（traceId 贯穿）；harness-protocol 的 `queryTrace` 能查到
- 落盘位置：`xw-runtime\state\orchestrator\trace\`（JSONL，按 traceId 分文件），不写 DB

## 3. 验收清单（review 按此逐项核）

机器门：
- [ ] `npm run check` / `npm run fusion:verify` PASS
- [ ] `npm run test:orchestrator` 全绿（含新增测试）
- [ ] 每个新模块有对抗测试（非法 skillId、循环依赖 DAG、traceId 断链）

真机演示（只读，actor=claude-pilot-20260809）：
- [ ] 一条自然语言任务（如"四台机器各刷一次首页并汇总卡片数"）经 Router → Compiler → DAG → 四机 fan-out 执行 → 全部 succeeded
- [ ] 全程 trace 可查：`queryTrace` 返回完整事件链，traceId 一致
- [ ] 中途杀掉一台 serve：对应节点失败、其它不受影响、事件里有 `RepairTriggered` 或明确失败记录
  ⚠️ 演练命令用受管任务，不用已退役的 fast-operator-serve-task.ps1：
  停止 alias 03：`Stop-ScheduledTask -TaskName 'XW Platform FastOperator 03'`，并确认
  端口 **17898** 不再监听（xw-start.mjs 同款不变式）；恢复：
  `Start-ScheduledTask -TaskName 'XW Platform FastOperator 03'`，等 17898 监听。
  先 `node ops/xw-start.mjs --check` 拿当前四机快照，演练前后资源归零对照以该输出为准。

红线（违反即打回）：
- [ ] 不开任何 live 门（MULTI_AGENT_LIVE / DSH_LIVE / OPEN_ACTION_LIVE 保持 CLOSED）
- [ ] 不碰 control.db / registry.db 直写；不绕 lease；支付闸不动
- [ ] 不部署新 release（源码进 main 即可）
- [ ] 禁止 npm workspaces、禁止 squash 合 PR
- [ ] 导入树改动必须登记 `docs/fusion/post-import-allowlist.v1.json`

## 4. 明确不做（scope 外）

- Agent 自主协商 / 多 Agent 角色（Lead/Planner/Worker 团队）→ M6 以后
- experience-ledger 持久化回喂 planner → M6
- 任何新设备能力（点赞/发帖/私信等外发）→ 不在本单

## 5. 交付物

1. PR（一个或多个，merge commit）：上述三模块 + 测试
2. 设计文档：`docs/architecture/m5-orchestration.md`（合同先行，可与代码同 PR）
3. handoff 更新：`docs/handoffs/` 新增一篇，记录验收证据（jobId/traceId/evidence 路径）


