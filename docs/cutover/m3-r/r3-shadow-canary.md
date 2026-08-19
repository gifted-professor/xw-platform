# M3-R3 落地记录：Shadow 启动与单设备 Canary（工具与可离线执行部分）

> 状态：**shadow 已真实执行一次（PASS）；计划任务定义已生成未注册；canary 仅实现工具 + dry-run，未执行**（2026-08-19，执行机 DESKTOP-3I1EVHE）。
> 范围：`plan.md` §六 6.1 / 6.2 / 6.4 + 6.3 的编排骨架。**6.3 canary 真实执行不做**——`LIVE_CANARY_GATE` 保持 CLOSED。
> 红线遵守：现场进程/计划任务未触碰；`xhs-registry` / `xhs-routing-v1-1` / `xhs-agent-control` 零写入；未连设备 / 未取真实 lease / 未提交 job / 未碰 22222/ADB/支付；对现场唯一网络动作是 17930 的 GET 只读 API。

## 1. 代码落点（均在 `packages/cutover/`，纯 Node、零第三方依赖）

- `lib/shadow.mjs`：`runShadow` —— 物化 release（复用 R1 `writeRelease`）→ DB 用 R2 snapshot 副本 → 替代端口（18922/18932）启动两服务（复用 R2 `runStack`，启动面本即无设备/lease/job 主动行为）→ 只读逐项比较 → 关闭。`buildComparisons` / `shadowVerdict` 为纯函数，离线可测。
- `lib/tasks.mjs`：`buildProposedTasks` / `buildTaskXml` / `buildTasksProposedReceipt` —— 只生成 schtasks 可导入 XML（Task 1.2，`Settings.Enabled` 恒 `false` 硬编码）与对照 receipt。**无任何 schtasks/Register-ScheduledTask 调用**。
- `lib/canary.mjs`：`buildCanaryProfile` / `validateCanaryProfile`（6.3 profile 契约，fail-closed）、`buildCanarySequence`（6.3 顺序骨架：freeze → 停旧 → 先 Control Plane 后 Orchestrator → health→…→release → 支付红线）、`ROLLBACK_TRIGGERS` + `evaluateRollbackTriggers`（6.4 判定函数，false/unknown/缺失均触发）、`runCanaryDryRun`（只出计划，不执行）。
- CLI：`xw cutover shadow|tasks|canary --dry-run` 接线进 `packages/cli/xw.mjs`。
- 测试：`packages/cutover/test/cutover-r3.test.mjs`（11 例：比较判定、任务 XML、profile 校验、触发器 fail-closed、序列顺序、dry-run、runShadow 注入假 spawn/http 端到端），挂进 `test:cutover` 与 `check` 链。
- 未改 `services/` 导入树，`docs/fusion/post-import-allowlist.v1.json` 无需变更。

## 2. Receipt / 产物清单（全部进 git）

| 文件 | schemaId | 结论 |
|---|---|---|
| `shadow-comparison.v1.json` | `xw.cutover.shadow-comparison.v1` | **verdict = PASS**（19 项：17 match、1 unknown、0 mismatch） |
| `scheduled-tasks-proposed.v1.json` + `proposed-tasks/*.xml` | `xw.cutover.scheduled-tasks-proposed.v1` | ok，**registration = NOT_REGISTERED**（注册属 R4 执行窗口） |
| `canary-plan.v1.json` | `xw.cutover.canary-plan.v1` | ok，`executed:false`、`liveCanaryGate:"CLOSED"`（dry-run 产物） |

未生成 `canary-receipt.v1.json`（那是 canary 真跑才有的产物）。

## 3. Shadow 真实比较结果要点（release `xw-20260819-c97892b`，DB = R2 snapshot 副本）

match（17 项）：

- health.orchestrator：shadow ok ↔ 现场 17930 GET /api/health ok（17930 全程只读 GET）。
- 设备 inventory 投影：control-plane `/control/v1/devices` = 4、orchestrator `/api/devices` = 4 ↔ 现场 17930 `deviceCount` = 4。
- capability registry：API 投影 28 ↔ R2  rehearsal smoke 28；DB 行数 32 ↔ 32（首轮曾把 API 28 与表行数 32 直接对比误报 mismatch——两者本来就不是一个面，已拆成 `capability-registry.api.count` 与 `capability-registry.db.rows` 两项分别比较）。
- 读取面：leases=0、sessions=0、jobs=14185 均与 R2 基线一致。
- release identity 四字段：shadow 两进程与 manifest 全等（旧代码无此四字段，legacy 侧记 `null`——预期差异，note 已说明）。
- schema：control.db user_version=18、schemaHash 与 rehearsal receipt round-1 完全一致；registry.db user_version=0、schemaHash 一致。
- 配置解析：legacy_compat 全字段与契约一致，`openActionLiveEnabled`/`agentGatewayLiveEnabled` 均 false，支付硬闸开。

unknown（1 项，如实）：

- `health.control-plane`：17920 不可达（R2 已记录），无 legacy 基准，记 unknown；不手写 match。

关闭手段（receipt `disabledMechanisms` / `safetyNotes` 已记录）：fixture 执行器 + 惰性 transport（启动期零设备行为）；启动恢复仅置 recovery_required、不取 lease 不派 job；shadow 全程无 POST；只听 127.0.0.1 替代端口。

## 4. 计划任务定义（生成未注册）

- `XW Platform Control Plane` / `XW Platform Orchestrator`：Disabled、BootTrigger、S4U、指向 `C:\Users\Public\xw-runtime\current` 下的服务入口；DB/runs/state 指向 `xw-runtime\state`（plan.md §4.1 布局）。
- pending（如实标注）：入口尚不存在（按 R1 release 布局推导）；orchestrator 的 `--agent-token` 等 secret 不生成具体值（不进 git，注册窗口人工注入）；env 需包装脚本或机器级注入（schtasks XML 不支持内联 env）。
- 与 `scheduled-tasks-before.v1.json` 对照：15 个旧任务全部 `unchanged`，无重名冲突。
- **未调用 `schtasks /create` / `Register-ScheduledTask`；注册属 R4 执行窗口（先禁旧、后启新，Control Plane 先于 Orchestrator）。**

## 5. Canary 工具覆盖范围（未执行）

- profile 契约：单设备白名单、其余 quarantine、指定 actor、legacy-only capability、Open Action/Agent Gateway live 关、支付双硬闸开；校验 fail-closed。
- 编排骨架 22 步：6.3 切换序列（pause → drain → 收敛 → snapshot → 停旧 → 验证端口释放 → 先 CP 后 Orch）+ canary 测试序列（health→inventory→observe→capability→session→job→evidence→recovery→release）+ 支付红线 3 步（credential/final-commit → HUMAN_REQUIRED，unknown 支付环境不执行）。每步带前置/后置检查。
- 回滚触发器 11 个（6.4 全量），`evaluateRollbackTriggers` 输入检查结果输出 trigger/ok，检查值 false/unknown/缺失均触发（fail-closed）。
- `xw cutover canary --dry-run` 只输出 `canary-plan.v1.json`；无 `--dry-run` 直接拒绝。真实 canary 执行未实现，属 LIVE_CANARY_GATE 开放后的窗口。

## 6. 验收

- `test:cutover`（含 r3 11 例）、`check`、`fusion:verify`、`authority`、`kernel:check`、`test:m3eh` 全绿（见 commit 说明）。
- shadow 工作区 `C:\Users\Public\xw-cutover-rehearsal\shadow-20260819-m3r3\` 保留作证据，可整体删除。

## 7. 未做 / 边界

- canary 真实执行（6.3）未做，`LIVE_CANARY_GATE` CLOSED；无 `canary-receipt.v1.json`。
- 计划任务未注册；`C:\Users\Public\xw-runtime\current` 入口尚不存在（pending）。
- 17920 不可达原因仍未排查（按要求未拉起）；control 面比较基准 = R2 采集/演练 receipt。
- shadow 是短窗口只读比较（比较完即关），不是常驻 shadow 服务。
