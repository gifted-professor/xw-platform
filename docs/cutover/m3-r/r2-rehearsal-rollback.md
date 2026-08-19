# M3-R2 落地记录：现场资产冻结、DB 演练与回滚证明

> 状态：**已执行完毕**（2026-08-19，执行机 DESKTOP-3I1EVHE）。
> 范围：`plan.md` §五 R2。红线遵守：旧目录零写入、旧进程/计划任务未触碰、未连真实设备 / 真实 lease / 真实 job / 22222 / ADB / 支付。
> `runtimeCutoverAllowed` 恒 `false`；`LIVE_CANARY_GATE` / `RUNTIME_CUTOVER_GATE` 仍 CLOSED。

## 1. 代码落点

- 新包 `packages/cutover/`（纯 Node、零第三方依赖）：
  - `lib/util.mjs`：脱敏（token/secret/serial key、命令行 `--*token` 值、`C:\Users\<name>\` 用户名段）、sha256、只读 HTTP GET、netstat/tasklist/schtasks 查询。
  - `lib/db.mjs`：DB 只读探查（`mode=ro` 级别只读打开取 `user_version`）、snapshot（优先只读连接 `VACUUM INTO`，失败退化文件拷贝+副本 checkpoint）、schema hash / integrity / 行数分析、从 snapshot 恢复工作副本。
  - `lib/live-collect.mjs`：现场只读采集（§5.1）+ 计划任务只读导出。
  - `lib/service-runner.mjs`：隔离目录 + 替代端口的两服务启动/health/只读冒烟/关闭编排。
  - `lib/rehearsal.mjs`：三轮 rehearsal 与一致性判定（`REHEARSAL_GATE`）。
  - `lib/rollback.mjs`：回滚演练与判定（`ROLLBACK_GATE`）。
- CLI 接线 `packages/cli/xw.mjs`：`collect --live` / `snapshot` / `rehearse` / `rollback`。离线默认行为不变。
- 测试：`packages/cutover/test/cutover-r2.test.mjs`（fixture DB 在临时目录现造，注入假 exec/http/spawn，离线可重复），挂进根 `test:cutover`；六个新 lib 文件挂进 `check` 的 node --check 链。
- 未改 `services/` 导入树，`docs/fusion/post-import-allowlist.v1.json` 无需变更。

## 2. Receipt 清单（receipt 是事实源，全部进 git）

| 文件 | schemaId | verdict |
|---|---|---|
| `live-inventory.v1.json` | `xw.cutover.live-inventory.v1` | 采集成功（17920 如实记 unreachable） |
| `scheduled-tasks-before.v1.json` | `xw.cutover.scheduled-tasks-before.v1` | 只读导出 8 个 Xhs* 任务 + 系统 Device* 任务 |
| `db-snapshot-receipt.v1.json` | `xw.cutover.db-snapshot.v1` | 两个 DB snapshot 均 ok（integrity_check=ok） |
| `rehearsal-receipt.v1.json` | `xw.cutover.rehearsal.v1` | **REHEARSAL_GATE = PASS**（三轮一致，diffs=[]） |
| `rollback-certification.v1.json` | `xw.cutover.rollback-certification.v1` | **ROLLBACK_GATE = PASS**（5 步全 ok） |

Snapshot 本体（约 101MB + 684KB）**不进 git**，位于 `C:\Users\Public\xw-cutover-rehearsal\reh-20260819-m3r2\snapshots\`（rehearsal 工作区在仓库外，无需 .gitignore 条目；仓内 `*.db` 规则兜底）。

## 3. 现场事实要点（2026-08-19 采集）

- 旧 Orchestrator checkout `C:\Users\Public\xhs-registry`：HEAD `4838f3d4…`，**108 个脏文件**（含 registry.mjs 本体 +158 行），remote `gifted-professor/xhs-registry`。
- 旧 Control Plane checkout `C:\Users\Public\xhs-routing-v1-1`：HEAD `43b09acc…`（= 导入锁 commit），2 个脏文件。
- 端口：17930 LISTENING（pid 20680，node.exe，计划任务 `XhsDeviceRegistry` Running / BootTrigger / S4U）；**17920 无监听，`/control/v1/health` 不可达（fetch failed），如实记录，未拉起**。任务 `XhsDeviceControlPlaneV1` 状态 Ready（未运行）。
- DB：
  - `registry.db` = `C:\Users\Public\xhs-registry\registry.db`（696,320 B，user_version=0，无 WAL/SHM；路径来自计划任务 `--db` 参数）。
  - `control.db` = `C:\Users\Public\xhs-agent-control\control.db`（103,432,192 B，**user_version=15**，WAL 6.1MB + SHM 存在；路径来自旧仓 `bootstrap.mjs` win32 默认值）。
- 业务状态（17930 只读 API）：4 台设备、identities=4、knowledge=486、active jobs=0、controlPlane 视图 reachable=false。lease/session/job 详情 17920 拿不到，记 unknown/unreachable。

## 4. Rehearsal 结果（release `xw-20260819-59926e9`，legacy_compat）

三轮（端口 18920/18930，DB 均为 snapshot 副本）完全一致：

- control.db **user_version 15 → 18 真实迁移**，三轮后 schema hash / 表数（29）/ 关键行数（devices=4, capabilities=32, jobs=14185, leases=0, sessions=0）逐轮一致；integrity_check=ok。
- registry.db user_version 保持 0（该库无 user_version 机制，幂等建表），identities=4 一致。
- health 校验含 R1 release identity（sourceRepo/sourceCommit/releaseId/runtimeProfile 与 manifest 全等，authority=true）。
- 只读冒烟：`/control/v1/devices|capabilities|leases`、`/api/devices|capabilities` 全 200。
- 设备/lease/job/支付隔离方式记录在 receipt `safetyNotes` / `envRecord`（启动期无主动设备行为、fixture 执行器、惰性 transport、env/参数全部指向 rehearsal 目录与替代端口）。

## 5. 回滚演练结果

实际执行：snapshot 恢复（control uv=15）→ xw-platform 启动并迁移到 uv=18、health ok → 停止 → 再从 snapshot 恢复（uv 回到 15）→ **旧代码**（`xhs-registry` 工作树 + `xhs-routing-v1-1`，端口 18931/18921，DB/runs/state 全在 rehearsal 目录）启动 → legacy health 恢复（control-plane authority=true、orchestrator ok）。`ROLLBACK_GATE = PASS`。

回滚单元 = 旧代码 + 旧 DB snapshot + 旧 launch 配置（计划任务 XML 已导出）。旧 control-plane 代码在当前环境可直接启动（hostname / node 24.11.1 前置断言均满足），无缺失依赖。

## 6. 已知边界 / 未做

- rehearsal 只覆盖 legacy_compat 只读面；未做任何写操作与真实 workflow（属 R3 canary 范围）。
- 17920 现场不可达的原因未排查（按要求未拉起）；`control.db` 停在 2026-08-15/16。
- 计划任务 `XhsFastOperator01-04Live`、`XhsScoutScout`、`XhsXwEvolveWorker` 已导出但不在 R2 切换范围内。
- rehearsal 工作区 `C:\Users\Public\xw-cutover-rehearsal\reh-20260819-m3r2\` 保留作证据，可随时整体删除。
