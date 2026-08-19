# M3-R：XW Platform Runtime Source Cutover

> 状态：**R3+R4 已执行（2026-08-19），LIVE_CANARY_GATE=PASS、RUNTIME_CUTOVER_GATE=PASS**。
> 落地记录与 receipts：见 `production-cutover.md`、`production-cutover-receipt.v1.json`、`canary-receipt.v1.json`、`state-path-migration-receipt.v1.json`、`legacy-reference-scan.v1.json`。
> R5（状态路径收敛）已随切换一并完成；R6（稳定观察与旧仓退役）未开始。

它的目的不是马上让 DSH、Open Action、Graph、Multi-Agent 全部控制真机，而是先完成一件更基础的事：

> **现场 Orchestrator 和 Control Plane 的唯一源码、发布包、启动路径、计划任务和 release identity，全部切换到 `xw-platform`。**

切完以后仍然可以保持：

```text
两个进程
两个数据库
两个端口
原有业务行为
原有设备身份
原有支付硬闸
```

只是运行来源从：

```text
xhs-registry
xhs-device-agent
```

统一变为：

```text
xw-platform
```

当前 PR #14 仍处于 OPEN，`LIVE_CANARY_GATE` 和 `RUNTIME_CUTOVER_GATE` 仍关闭，因此 M3-R 只能先设计和实现工具，不能立即执行现场切换。

---

# 一、M3-R 最终目标状态

现场完成后应当是：

```text
GitHub Source of Truth
└── gifted-professor/xw-platform

Windows Runtime
├── Orchestrator
│   └── 来自同一个 xw-platform release
│
└── Control Plane
    └── 来自同一个 xw-platform release

Runtime State
├── registry.db
└── control.db

Ports
├── 17930：Orchestrator
└── 17920：Control Plane
```

需要特别明确：

```text
一个仓库 ≠ 一个进程
一个仓库 ≠ 一个数据库
```

M3-R 不做：

* 合并 `registry.db` 与 `control.db`；
* 把两个服务塞进一个进程；
* 改 17920/17930；
* 打开 DSH 真机控制；
* 打开 Multi-Agent；
* 打开 Graph v2；
* 打开 Open Action live executor；
* 修改支付红线。

第一次正式切换统一采用：

```text
runtimeProfile = legacy_compat
```

其含义是：

```yaml
orchestratorEnabled: true
controlPlaneEnabled: true

legacyCapabilitiesEnabled: true
legacyWorkflowsEnabled: true

openActionLiveEnabled: false
agentGatewayLiveEnabled: false
dshEnabled: false
graphV2Enabled: false
multiAgentEnabled: false

paymentCredentialRequiresHuman: true
paymentFinalCommitRequiresHuman: true
```

所以 M3-R 是：

> **换运行来源，不换现场行为。**

---

# 二、M3-R 的完整 Gate 系统

不要只用一个总开关。建议建立六个独立 Gate：

```text
M3_SOURCE_GATE
REHEARSAL_GATE
ROLLBACK_GATE
LIVE_CANARY_GATE
RUNTIME_CUTOVER_GATE
LEGACY_RETIREMENT_GATE
```

状态顺序：

```text
M3_SOURCE_GATE = PASS
        ↓
REHEARSAL_GATE = PASS
        ↓
ROLLBACK_GATE = PASS
        ↓
LIVE_CANARY_GATE = OPEN
        ↓
LIVE_CANARY_GATE = PASS
        ↓
RUNTIME_CUTOVER_GATE = OPEN
        ↓
RUNTIME_CUTOVER_GATE = PASS
        ↓
LEGACY_RETIREMENT_GATE = OPEN
        ↓
LEGACY_RETIREMENT_GATE = PASS
```

任何阶段只开放自己的 Gate，不顺带开放后面的能力。

例如现场已经切到 `xw-platform` 后，仍保持：

```text
OPEN_ACTION_LIVE_GATE = CLOSED
DSH_LIVE_GATE = CLOSED
MULTI_AGENT_LIVE_GATE = CLOSED
```

---

# 三、M3-R0：进入条件

M3-R 真正执行前，以下条件必须全部成立。

## 1. PR #14 完成机器级验收并合并

必须满足：

```text
Ubuntu CI = PASS
Windows CI = PASS
fusion:verify = PASS
authority = PASS
kernel:check = PASS
test:m3eh = PASS
m3:accept = PASS
```

不能再出现：

```text
CI BLOCK
但 acceptance JSON 手写 PASS
```

## 2. M3 Source Gate 锁定

生成：

```text
docs/cutover/m3-r/m3-r-entry-lock.v1.json
```

至少包含：

```json
{
  "sourceRepo": "gifted-professor/xw-platform",
  "sourceCommit": "<完整40位SHA>",
  "sourceTreeSha": "<完整tree SHA>",
  "m3SourceGate": "PASS",
  "liveCanaryGate": "CLOSED",
  "runtimeCutoverGate": "CLOSED",
  "runtimeProfile": "legacy_compat"
}
```

## 3. 当前现场没有未分类关键漂移

必须重新采集：

```text
现场运行进程
计划任务
启动命令
实际 checkout 路径
release SHA
DB 路径
DB user_version
端口占用
设备列表
active lease
active session
running job
环境变量
密钥来源
runtime 目录
```

任何：

```text
unknown process
unknown lease
unknown source SHA
unknown DB
```

都不能直接进入现场切换。

---

# 四、M3-R1：Release 与部署基础

这一阶段只搭建可部署能力，不操作现场。

建议第一张大 PR：

```text
feat(cutover): add XW runtime release contract and preflight
```

## 4.1 建立不可变 Release 结构

不要让生产现场直接运行一个会被 `git pull` 改动的工作树。

推荐 Windows 目录：

```text
C:\Users\Public\xw-runtime
├── releases
│   ├── xw-<release-id>
│   └── xw-<previous-release-id>
│
├── current
│
├── state
│   ├── orchestrator
│   └── control-plane
│
├── evidence
├── logs
├── secrets
├── receipts
└── rollback
```

其中：

```text
releases/<release-id>
```

必须不可变。

`current` 可以采用：

* Windows directory junction；
* 或者一个机器可读 `active-release.v1.json`；
* 不建议直接覆盖已有 release 目录。

代码和状态分离：

```text
代码：
releases/<release-id>

数据库：
state/orchestrator/registry.db
state/control-plane/control.db

证据：
evidence/

日志：
logs/

秘密：
secrets/
```

这样以后更新代码时，不会顺带覆盖 DB、日志和私有状态。

## 4.2 Release Manifest

每个发布包必须包含：

```text
release-manifest.v1.json
```

示例：

```json
{
  "schemaId": "xw.runtime.release-manifest.v1",
  "releaseId": "xw-20260819-<shortsha>",
  "sourceRepo": "gifted-professor/xw-platform",
  "sourceCommit": "<40位SHA>",
  "sourceTreeSha": "<tree SHA>",
  "runtimeProfile": "legacy_compat",
  "nodeVersion": "24.11.1",
  "npmVersion": "11.6.2",
  "services": {
    "orchestrator": {
      "path": "services/orchestrator",
      "treeSha256": "..."
    },
    "controlPlane": {
      "path": "services/control-plane",
      "treeSha256": "..."
    }
  },
  "runtimeCutoverAllowed": false
}
```

发布包内部文件需要完整 manifest hash。

## 4.3 统一 Release Identity

Orchestrator 与 Control Plane health 都应暴露：

```json
{
  "sourceRepo": "gifted-professor/xw-platform",
  "sourceCommit": "<40位SHA>",
  "releaseId": "<releaseId>",
  "runtimeProfile": "legacy_compat"
}
```

最终必须证明两个进程：

```text
sourceRepo 相同
sourceCommit 相同
releaseId 相同
runtimeProfile 相同
```

## 4.4 Cutover CLI

建议新增：

```bash
xw cutover collect
xw cutover preflight
xw cutover package
xw cutover rehearse
xw cutover verify
xw cutover canary
xw cutover promote
xw cutover rollback
xw cutover closeout
```

M3-R1 只实现离线：

```text
collect
preflight
package
verify
```

不允许：

```text
deploy
restart
task mutation
DB migration
device action
```

## M3-R1 退出条件

```text
Release 包可重现
Release manifest 可验证
两个服务可从 release 目录离线启动
runtimeProfile=legacy_compat
没有任何现场改动
```

---

# 五、M3-R2：现场资产冻结、DB 演练与回滚证明

建议第二张大 PR：

```text
test(cutover): add runtime rehearsal and rollback certification
```

这一阶段在现有 Windows 控制环境执行，不走 Mac mini，不开虚拟机。

## 5.1 现场只读采集

产物：

```text
docs/cutover/m3-r/live-inventory.v1.json
```

至少记录：

```text
旧 Registry checkout
旧 Device Agent checkout
两个实际运行 SHA
所有计划任务定义
所有服务启动参数
端口拥有者
数据库绝对路径
数据库大小与 SHA-256
数据库 user_version
runtime/evidence/log 路径
设备数量
lease/session/job 状态
```

真实路径中的用户名、token、设备序列号应脱敏。

## 5.2 数据库 Snapshot

切换前对两个数据库生成：

```text
registry.db.snapshot
control.db.snapshot
```

并记录：

```text
文件 SHA-256
大小
SQLite integrity_check
user_version
schema hash
核心表行数
WAL/SHM 状态
snapshot 时间
源 release
```

注意：

> 只切回旧代码，不恢复旧 DB，不算完整回滚。

如果新 `xw-platform` 把 `control.db` 升级到更高 schema，旧 `xhs-device-agent` 可能无法继续读取。

所以 rollback 单元必须是：

```text
旧代码
+
旧 DB snapshot
+
旧 launch 配置
```

## 5.3 在复制数据库上做三轮 Rehearsal

不用 VM。

使用一次性隔离目录：

```text
C:\Users\Public\xw-cutover-rehearsal
└── <rehearsal-id>
    ├── release
    ├── state-copy
    ├── logs
    └── receipt
```

运行条件：

```text
使用 DB 副本
使用隔离 runtime 目录
使用替代本地端口
不连接真实设备
不获取真实 lease
不提交真实 job
不触碰 22222
```

三轮连续执行：

```text
旧 DB 副本
→ xw-platform legacy_compat
→ schema migration
→ health
→ legacy tests
→ shutdown
→ integrity_check
```

三轮必须：

```text
结果一致
schema hash 一致
表数量一致
关键行数一致
无 flaky
无新增关键失败
```

## 5.4 回滚演练

必须实际证明：

```text
xw-platform rehearsal 启动
→ 执行 DB migration
→ 停止
→ 恢复旧 DB snapshot
→ 使用旧代码启动
→ health 恢复
```

生成：

```text
rollback-certification.v1.json
```

只有实际恢复成功，才允许：

```text
ROLLBACK_GATE = PASS
```

## M3-R2 退出条件

```text
REHEARSAL_GATE = PASS
ROLLBACK_GATE = PASS
三轮结果一致
两个 DB 均可恢复
无真实设备操作
```

---

# 六、M3-R3：Shadow 启动与单设备 Canary

建议第三张大 PR：

```text
feat(cutover): add shadow runtime and controlled canary promotion
```

## 6.1 Shadow 模式

旧系统继续是唯一权威。

新 `xw-platform` 使用：

```text
DB 副本
替代端口
设备执行关闭
lease 获取关闭
job 提交关闭
```

Shadow 只比较：

```text
health
设备 inventory 投影
capability registry
job/session 读取
release identity
schema
配置解析
关键 workflow plan
```

绝对禁止：

```text
两个 Control Plane 同时写同一个 control.db
两个 Control Plane 同时控制同一设备
两个 Orchestrator 同时提交真实任务
```

## 6.2 预建新计划任务

建立新的任务，但保持 Disabled：

```text
XW Platform Orchestrator
XW Platform Control Plane
```

旧任务保持不变。

新任务必须指向：

```text
C:\Users\Public\xw-runtime\current
```

不要直接指向：

```text
git checkout 的 main
```

新任务参数、环境变量和账号权限全部生成 receipt。

## 6.3 单设备 Canary 窗口

Canary 时不能让旧、新两个权威同时运行。

正确顺序：

```text
暂停新 job 提交
→ drain active jobs
→ active lease/session 收敛
→ snapshot 两个 DB
→ 停止旧 Orchestrator
→ 停止旧 Control Plane
→ 验证 17920/17930 已释放
→ 启动 xw-platform Control Plane
→ 启动 xw-platform Orchestrator
```

Canary 配置：

```text
只启用一台测试设备
其他设备全部 quarantine / disabled
只允许指定 actor
只允许 legacy capability
Open Action live 仍关闭
Agent Gateway live 仍关闭
```

Canary 测试顺序：

```text
health
→ inventory
→ observe
→ existing capability
→ existing session
→ existing job
→ evidence
→ recovery
→ release
```

然后必须做支付红线验证：

```text
支付凭证
→ HUMAN_REQUIRED

支付 final commit
→ HUMAN_REQUIRED

无法判断的支付环境
→ 不执行
```

## 6.4 Canary 自动回滚触发器

以下任一发生，立即执行 rollback：

```text
运行 SHA 与锁定 SHA 不一致
releaseId 漂移
DB integrity_check 失败
schema 版本异常
设备数量不一致
lease/session 权威不一致
已有 workflow 新关键失败
evidence 无法落盘
支付硬闸失败
端口被错误进程占用
未知进程仍引用旧 checkout
```

## M3-R3 退出条件

```text
LIVE_CANARY_GATE = PASS
旧系统可完整恢复
测试设备 legacy workflow 通过
支付硬闸通过
无双 writer
无双 lease owner
```

---

# 七、M3-R4：正式生产 Source Cutover

这一步才真正将现场运行来源切到 `xw-platform`。

建议第四张大 PR：

```text
ops(cutover): promote XW Platform as sole runtime source
```

代码 PR 合并后，再执行实际 cutover runbook。

## 7.1 Cutover 前冻结

进入维护窗口后：

```text
禁止新 job
禁止新 session
停止任务调度
等待 running job 结束
等待 lease/session 收敛
```

最终要求：

```text
runningJobs = 0
activeSessions = 0
activeLeases = 0
```

无法收敛的项目必须：

```text
显式 cancel
显式 recover
或 BLOCK
```

不能把 unknown 写成 zero。

## 7.2 最终 Snapshot

再次生成：

```text
registry DB snapshot
control DB snapshot
old launch config export
old scheduled task XML
old source commit receipt
old runtime directory manifest
```

## 7.3 原子切换

正式顺序：

```text
1. 禁用旧 Orchestrator 计划任务
2. 禁用旧 Control Plane 计划任务
3. 停止旧进程
4. 验证旧进程 PID 不存在
5. 验证 17920/17930 无旧进程占用
6. 将 current 指向锁定的 xw-platform release
7. 启用新 Control Plane 任务
8. 启动并验证 Control Plane
9. 启用新 Orchestrator 任务
10. 启动并验证 Orchestrator
```

必须先 Control Plane，后 Orchestrator。

## 7.4 启动后验证

Control Plane：

```text
health ok
authority=true
sourceRepo=xw-platform
sourceCommit=locked SHA
releaseId 正确
runtimeProfile=legacy_compat
DB user_version 正确
devices 数量一致
payment hard gate active
```

Orchestrator：

```text
health ok
sourceRepo=xw-platform
sourceCommit 与 Control Plane 一致
releaseId 一致
Control API 可达
无 control.db 直接写入
```

## 7.5 分阶段恢复业务流量

不要启动后立即全量。

顺序：

```text
只读 health/inventory
→ observe
→ 单个 legacy job
→ 单个 legacy workflow
→ 小批量任务
→ 正常任务量
```

每一步都要检查：

```text
job state
lease state
session state
evidence
failure fingerprint
支付硬闸
```

## M3-R4 退出条件

```text
RUNTIME_CUTOVER_GATE = PASS
两个生产进程均来自 xw-platform
新任务只从 xw-platform 提交
计划任务不再启动旧 checkout
旧任务保持 Disabled
```

---

# 八、M3-R5：状态路径收敛

源码切换成功后，还需要处理一个问题：

> DB、日志或 runtime state 是否仍位于两个旧项目目录内。

分两种情况。

## 情况 A：状态本来就在独立目录

直接保持，不迁移。

## 情况 B：状态仍在旧 checkout 内

建立：

```text
C:\Users\Public\xw-runtime\state
```

分别迁移：

```text
registry.db
control.db
WAL/SHM
evidence
runtime state
```

过程：

```text
停止服务
→ snapshot
→ 复制到新 state 目录
→ hash 对比
→ SQLite integrity_check
→ 修改外部 launch config
→ 启动
→ 验证
```

仍然保持：

```text
两个数据库
两个 state 子目录
```

不合库。

只有状态路径也不再依赖旧目录，才能真正退役旧 checkout。

---

# 九、M3-R6：稳定观察与旧仓退役

正式切换后，不要立即删除旧项目。

## 9.1 稳定期

建议至少完成：

```text
一个短窗口：基础 smoke
一个完整业务日：正常 job/session
一个完整业务周期：已有 workflow 和恢复链路
```

观察指标：

```text
服务重启次数
job 成功率
lease 泄漏
session 泄漏
evidence 缺失
DB integrity
release drift
支付硬闸
旧路径调用
```

## 9.2 旧 checkout 处理

先改名为只读 rollback artifact：

```text
xhs-registry-retired-<date>
xhs-device-agent-retired-<date>
```

并设置：

```text
计划任务引用 = 0
服务引用 = 0
脚本引用 = 0
环境变量引用 = 0
release 引用 = 0
```

暂时保留：

```text
Git bundle
旧 release
DB snapshot
计划任务 XML
rollback receipt
```

## 9.3 GitHub 旧仓库退役

满足稳定期后：

```text
xhs-registry
→ archived / read-only

xhs-device-agent
→ archived / read-only
```

README 标明：

```text
Development and production runtime have moved to xw-platform.
```

禁止继续在旧仓做 hotfix。

所有生产修复只允许：

```text
xw-platform
```

## 9.4 最终标签

在 `xw-platform` 创建：

```text
xw-m3-runtime-source-cutover
```

Tag annotation 包含：

```text
source commit
releaseId
cutover receipt hash
DB snapshot receipt hash
rollback certification hash
canary verdict
production cutover verdict
```

---

# 十、M3-R 的四张大 PR

为了避免继续频繁 review 小问题，建议只拆四张。

## PR R1：Release Foundation

```text
feat(cutover): add runtime release contract and preflight
```

包含：

```text
runtimeProfile=legacy_compat
release manifest
immutable release layout
health identity
cutover collect/preflight/package/verify
```

不操作现场。

## PR R2：Rehearsal and Rollback

```text
test(cutover): certify database rehearsal and rollback
```

包含：

```text
现场资产采集
DB snapshot
三轮 rehearsal
rollback drill
machine receipts
```

## PR R3：Shadow and Canary

```text
feat(cutover): add shadow comparison and controlled canary
```

包含：

```text
shadow mode
disabled scheduled tasks
canary profile
automatic rollback triggers
payment canary
```

## PR R4：Promotion and Retirement

```text
ops(cutover): promote xw-platform and retire legacy runtime sources
```

包含：

```text
atomic task switch
production receipt
state path convergence
legacy reference scan
retirement receipt
final tag
```

每张 PR 内可以有多个结构清晰的 commit，但不再为每个小字段单独开 PR。

---

# 十一、机器证据清单

最终 `docs/cutover/m3-r/` 建议包含：

```text
m3-r-entry-lock.v1.json
release-manifest.v1.json
live-inventory.v1.json
scheduled-tasks-before.v1.json
scheduled-tasks-after.v1.json
db-snapshot-receipt.v1.json
rehearsal-receipt.v1.json
rollback-certification.v1.json
shadow-comparison.v1.json
canary-receipt.v1.json
production-cutover-receipt.v1.json
state-path-migration-receipt.v1.json
legacy-reference-scan.v1.json
retirement-receipt.v1.json
acceptance-report.md
```

JSON 是事实源，Markdown 必须自动生成。

---

# 十二、正式回滚方案

回滚必须是一个完整事务，不是“把路径改回去”。

## 触发后执行

```text
1. 立即停止新任务提交
2. 停止 xw-platform Orchestrator
3. 停止 xw-platform Control Plane
4. 禁用新计划任务
5. 恢复切换前 registry.db snapshot
6. 恢复切换前 control.db snapshot
7. 恢复旧 launch config
8. 启用旧 Control Plane
9. 验证旧 Control Plane
10. 启用旧 Orchestrator
11. 验证旧 Orchestrator
12. 记录 rollback receipt
```

必须确认：

```text
旧 source SHA 正确
旧 DB hash 正确
旧 DB schema 正确
旧端口拥有者正确
旧 payment gate 正确
```

---

# 十三、怎样才算“彻底切完”

只有以下全部为真，才算完全退出两个旧项目：

```text
1. 所有生产 Orchestrator 进程来自 xw-platform release
2. 所有生产 Control Plane 进程来自同一个 release
3. 所有计划任务仅引用 xw-platform runtime 路径
4. 所有 launch/recover/deploy 脚本仅引用 xw-platform
5. DB、日志、evidence 不依赖旧 checkout
6. release identity 唯一且可证明
7. 两个旧仓不再接收生产修复
8. 旧 checkout 不再被任何进程读取
9. 回滚包已验证
10. 支付硬闸真机验证通过
11. legacy workflow 无关键回归
12. LEGACY_RETIREMENT_GATE = PASS
```

最终现场状态：

```text
xw-platform
= 唯一源码主线
= 唯一发布来源
= 唯一生产运行来源

xhs-registry
= 历史归档

xhs-device-agent
= 历史归档
```

---

# 十四、M3-R 完成后的路线

M3-R 通过后，后续所有开发只围绕 `xw-platform`：

```text
M4
Plugin SDK + DSH Adapter

M5
Graph + Loop Runtime

M6
Multi-Agent + Repair + Evolution

M7
Open Action Live Promotion + Fleet Scale
```

M4 开始时，现场已经不再运行两个旧仓。但是新能力仍按自己的 Gate 独立上线，不会因为换了源码来源，就自动获得真机执行权限。

当前执行顺序固定为：

```text
1. 收口并合并 PR #14
2. 开 PR M3-R1：Release Foundation
3. 开 PR M3-R2：Rehearsal + Rollback
4. 开 PR M3-R3：Shadow + Canary
5. 开 PR M3-R4：Production Cutover + Retirement
6. 宣布 xw-platform 成为唯一生产 Source of Truth
```
