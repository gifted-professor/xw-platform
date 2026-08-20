# 接手文档 — 2026-08-20

> **这是当前唯一先读的进度文档。** 根目录 `HANDOFF.md` 上半段已过时（仍写 PR #24/#25 未合、P1-2 未真机）。以本文为准。
>
> 写给下一个 agent / 人。目标：不靠聊天记录也能接着干。

---

## 0. 三十秒

```text
源码主线    gifted-professor/xw-platform  main@7917ac9
生产运行    xw-runtime\releases\xw-20260819-f337079
            sourceCommit = f337079d93b6e16993b93f7d28783f57da9a5184
            runtimeProfile = legacy_compat
            17920 Control Plane / 17930 Orchestrator 都活着

M3-R        六个门全 PASS，旧仓 archive，旧目录 retired
M4 源码     A/B/C(+D fixture) 已合进 main，尚未部署到现场
真机        切仓后第一单只读 xhs.observe.feed 已在 01 成功
            job_8a3c6676-b190-449b-8b0f-e018fb8f4310 succeeded

还不能       打开 DSH live / Open Action live
不要        重新启用 XhsFastOperator* / 旧计划任务
不要        直接跑现在的 /xw start（仍指向 retired 路径）
```

**最大陷阱：源码 `main` 已经含 M4，现场 release 仍是 8-19 切换那一版 `f337079`。新 Skill Runtime / Harness / Router 还没进 17920/17930 进程。**

---

## 1. 三套目录（现在的角色）

| 路径 | 角色 | 注意 |
|---|---|---|
| `C:\Users\Public\xw-fusion\xw-platform` | **唯一源码主线** | git `gifted-professor/xw-platform`，新功能只写这里 |
| `C:\Users\Public\xw-runtime\` | **唯一生产运行根** | `current` 是 junction → 当前 release；DB/evidence/logs/secrets 都在这 |
| `C:\Users\Public\xhs-registry-retired-20260819` | 回滚工件 | 原 `xhs-registry`。勿删。含未进融合锁的 WIP |
| `C:\Users\Public\xhs-device-agent-retired-20260819` | 回滚工件 | 原 `xhs-routing-v1-1`。勿删 |

已不存在（改名走了）：

- `C:\Users\Public\xhs-registry`
- `C:\Users\Public\xhs-routing-v1-1`

GitHub 旧仓已 archive 只读：

- `gifted-professor/xhs-registry`
- `gifted-professor/xhs-device-agent`

现场端口：

| 端口 | 谁 | 8-20 下午实查 |
|---|---|---|
| 17920 | Control Plane | Listen，pid 当时 8148 |
| 17930 | Orchestrator | Listen，pid 当时 20340 |
| 22222 | 小薇 transport | Listen |
| 17895 | FastOperator 01 | Listen（**临时进程**，pid 当时 6356，不是计划任务） |
| 17897/17898/17896 | FastOperator 02/03/04 | **没在听** |

计划任务：

| 任务 | 状态 |
|---|---|
| `XW Platform Control Plane` | Running（SYSTEM，BootTrigger；非提权 `Get-ScheduledTask` 可能看不见） |
| `XW Platform Orchestrator` | Running（同上） |
| `XhsDeviceRegistry` | Disabled 留档 |
| `XhsDeviceControlPlaneV1` | Disabled 留档 |
| `XhsScoutScout` | Disabled |
| `XhsXwEvolveWorker` | Disabled |
| `XhsFastOperator01-04Live` | Disabled（**不要重新启用**，仍指向旧 checkout） |
| `CursorRenewalMonitor` | Disabled（曾漏扫：任务名不是 `Xhs*`，动作仍引用旧 `xhs-registry`） |

引用旧路径的计划任务现场实扫是 **9 个**（4 个 FastOperator 拆开 + Registry + CPv1 + Scout + Evolve + Cursor）。JSON 里有时写成 8，因为 FastOperator 合成一条。全部 Disabled。

---

## 2. 门与能力（不要混）

### 已关闭的 M3-R 门（退役完成）

证据：`docs/cutover/m3-r/`，tag `xw-m3-runtime-source-cutover`。

```text
M3_SOURCE_GATE
REHEARSAL_GATE
ROLLBACK_GATE
LIVE_CANARY_GATE          = PASS
RUNTIME_CUTOVER_GATE      = PASS
LEGACY_RETIREMENT_GATE    = PASS
```

六个都 PASS。**换运行来源，不换现场行为。** `runtimeProfile=legacy_compat`。

### 仍然关闭的能力门（M4 合进源码也不自动打开）

```text
OPEN_ACTION_LIVE          CLOSED
DSH_LIVE                  CLOSED
MULTI_AGENT_LIVE          CLOSED
openActionLiveEnabled     false
agentGatewayLiveEnabled   false
dshEnabled                false
graphV2Enabled            false
multiAgentEnabled         false
```

支付：`paymentCredentialRequiresHuman=true`，`paymentFinalCommitRequiresHuman=true`。Agent 自报 nonpayment 无权威。

### 权威边界（没变）

- Control Plane：device / lease / session / job / transport / 支付 final-commit / 设备 evidence
- Orchestrator：goal / task / mission / knowledge / evolution / closeout
- `registry.db` 与 `control.db` 独立
- 禁止无 lease 碰机、禁止 GatewayOperator 旁路、禁止直写 `control.db`
- Orchestrator 读 control.db 必须 readOnly

---

## 3. 源码进度（main@7917ac9）

合仓与切换相关 PR（时间正序，合都用 **merge commit，禁止 squash**）：

| PR | 内容 |
|---|---|
| #14 | M3-EH Open Action Runtime（agent-gateway 已在 packages/） |
| #18–#19 | M3-R3 shadow/canary + 生产切换 |
| #20 | R6 残留任务禁用 + WIP 备份 |
| #21 | R6 Phase 0 清单 + env/进程扫描 |
| #22 | retirement receipt + `LEGACY_RETIREMENT_GATE=PASS` |
| #23 | 诚实化 P1-2 + CursorRenewalMonitor |
| **#24** | **M4-A Skill 合同 + 跨进程 restore**（`1a59c56`） |
| **#25** | **M4-B Harness Protocol + dsh-xw 桥**（`2e03556`） |
| **#26** | **M4-C Router + Experience Ledger + xhs.collect hybrid 候选**（`7917ac9`） |

### M4-A（`packages/kernel`）

- 合同：`packages/kernel/contracts/skill/`
- 运行时：`packages/kernel/lib/skill-runtime.mjs`
- 机器门：`npm run m4a:accept`，CI 已跑
- 硬规则：
  - 叶子 Skill 禁止 `nextSkill` / `next_skill` / `hardcodedNext`
  - `candidateIntents` 必须 `^intent:[a-z0-9][a-z0-9._-]*$`，禁止 `xhs.publish`
  - 运行中绑定 `SkillVersionRef`（spec SHA + sourceCommit + sourceBlobSha），不能只锁 SemVer
  - `serialize()` / `SkillRunMachine.restore()` 必须跨进程、JSON 脱离旧对象
  - checkpoint 绑定 `skillRunId/skillId/version/traceId/missionRunId/seq/skillVersionRef`
  - 无 checkpoint 崩溃：`AMBIGUOUS` + `exit=null` + `recoveryRequired`，**不是** `ABORTED`
  - restore 必须带 Action Ledger `reconciliation`（`NO_UNRESOLVED_EFFECTS` / `ALREADY_VERIFIED` / `AMBIGUOUS_EFFECT`）
  - 非终态 run 上再 `start()` → `SKILL_RUN_ALREADY_ACTIVE`
- 样板包装现有 `xhs.collect`，**不要发明** `xhs.open-collection`
- `missionRunId` 属于 Orchestrator 长期任务，**不是**控制面 `MissionRuntime`

### M4-B（`packages/harness-protocol` + `integrations/dsh-xw`）

- DSH **锁死** `deepseek-ai/deepseek-harness@0.1.0-rc.7` commit `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`，禁止跟 `master`/`latest`
- 统一接口：`createSession restoreSession submitGoal continueSkill checkpoint queryTrace interrupt close`
- 只暴露 8 个工具：`xw_skill_*` / `xw_phone_*` / `xw_trace_query`
- 禁止：`control.db` `registry.db` ADB `22222` lease mutation payment/policy override
- 没有 vendor 真 DSH 进程；fixture 对抗：open tool/call、缺 XW checkpoint、DSH 未 flush、换 DSH 版本、重复 restore、subagent 带着未完成 tool 退出
- 机器门：`npm run test:m4b`

### M4-C/D fixture（`packages/skill-router` + `packages/experience-ledger`）

- Experience Ledger：facts 只追加、patterns 累计支持数、snapshots 写完不改、open_questions 完成后删除
- Router：只把 `intent:…` 映射到 skillId；`COMPLETED`/`WAIT_HUMAN` 不选下一站
- Hybrid pack：`packages/skill-router/fixtures/xhs-collect.hybrid.v1.json`
- Compiler **不能**自动升 STABLE（必须人审 + replay + canary）
- 机器门：`npm run test:m4c`

架构说明：

- `docs/architecture/skill-runtime.md`
- `docs/architecture/harness-protocol.md`
- `docs/architecture/skill-router.md`
- `docs/architecture/target-layout.md`

---

## 4. 现场切换与 R6（Kimi 执行，人批准压缩观察窗）

完整证据：`docs/cutover/m3-r/`。

### 生产切换（8-19）

- Release：`xw-20260819-f337079`（**不是**后来的 M4 commits）
- DB：`xw-runtime\state\{orchestrator,control-plane}\`；control.db user_version=18；registry uv=0
- evidence：`xw-runtime\evidence`；logs：`xw-runtime\logs`；secrets：`xw-runtime\secrets`（ACL：SYSTEM+Administrators）
- Canary：只读 health/inventory/observe API，**当时没跑真实 job**（任何 capability 都可能碰 22222）
- 支付红线：代码内 fail-closed 探针，没真付钱

已知坑（还会踩）：

1. **不要用 junction 路径当 node 主模块**（`xw-runtime\current\...`）。`import.meta.url !== argv[1]` 会静默退出。必须 `launch-*.ps1` 先解析真实路径。
2. **PS 5.1 无 BOM UTF-8 当 ANSI 读**。launcher 必须 ASCII 或带 BOM。
3. **SYSTEM 任务非提权不可见。** 查任务要管理员；查服务用 health API。
4. `xw-runtime\logs\control-plane.log` 的 mtime 可能停在启动时刻（8-19 16:13）。SYSTEM 的 stdout 不一定落这里。**健康以 API 为准。**

回滚单元（仍保留）：

- 旧 checkout 改名后的 `*-retired-20260819`
- `xw-runtime\rollback\final-20260819\snapshots` 双 DB
- `xw-runtime\rollback\legacy-backup-20260819\`（bundle + WIP patch + 110 文件 tar）
- 旧任务定义 Disabled 未删
- 步骤见 `docs/cutover/m3-r/plan.md` §十二

### R6 退役

清单：`docs/cutover/m3-r/r6-retirement-checklist.md`  
扫描：`docs/cutover/m3-r/legacy-reference-scan.v1.json`  
收据：`docs/cutover/m3-r/retirement-receipt.v1.json`

- Phase 0：env 三层 0 命中；进程 0；CPv1 禁用
- 观察窗被**人决定压缩到当天**；补救是每日 09:23 巡检 cron（在 **Kimi 会话**，不在本 Grok 会话）
- P1-2 最初把 Open Action fixture observe 写成「真实观察 job」，Grok review 后改诚实：控制通道 PASS，`partial:true` / `fixture_provider_no_device_artifact`，**不宣称真机画面**
- CursorRenewalMonitor：按任务名 `Xhs*` 漏扫；改名后跑过一次 result=1；已 Disabled；扫描改为动作内容全量匹配
- 8-20 巡检（Kimi）：全绿。旧任务无一回弹；health 不漂；leases=0；integrity ok
- 还剩：8-21、8-22 两轮巡检。漏了跟 Kimi 说「补巡检」

P1-2 fixture 与后来的真机 observe **不是同一件事**。不要用 P1-2 收据证明真机。

---

## 5. 切仓后第一单真机（2026-08-20）

约定：走 **legacy capability**，不通过 17920 拿 lease/job，不开 Open Action live / DSH live。支付仍人工闸。

### 成功单

```text
capability   xhs.observe.feed
alias        01
actor        claude-pilot-20260809   （pilotOnly 白名单，别换没登记的 actor）
jobId        job_8a3c6676-b190-449b-8b0f-e018fb8f4310
runId        run_3d96c6e5-20a8-4db5-bd69-57283e802e0c
status       succeeded
pageClass    xhs.feed.index
cardCount    2
verification ok=true
externalEffect false
leases 结束后 0
evidence     C:\Users\Public\xw-runtime\evidence\run_3d96c6e5-20a8-4db5-bd69-57283e802e0c\
截图         小红书发现页双列瀑布流
```

前置：Explorer canary session 在 01 `launch_app com.xingin.xhs`，然后才 observe。`xhs.observe.feed` **自己不会打开小红书**，只 dump 当前页。

提交方式（现场）：

```text
node C:\Users\Public\xw-runtime\releases\xw-20260819-f337079\services\control-plane\control-plane\devicectl.mjs --local ...
```

不要用 junction `xw-runtime\current` 当 server 主模块；CLI 一次性 `devicectl` 一般可以，但 release 绝对路径更稳。

### 失败单（按顺序，都有证据）

1. `job_616c00be-…` `ADAPTER_HTTP_UNAVAILABLE` endpoint `127.0.0.1:17895`  
   原因：R6 禁用了 FastOperator 任务，01 serve 没人听。
2. `job_85fefb86-…` `ADAPTER_REJECTED` / `adb shell poisoned (process.error)`  
   原因：serve 刚起，持久 ADB shell 第一下挂。lease 已释放。
3. `job_202e2b4c-…` `VERIFICATION_FAILED` `pageClass=xhs.unknown` `cardCount=2` vendor 200  
   原因：01 当时在 **「看点」** 推荐页，不是小红书。截图在  
   `xw-runtime\evidence\run_0a358d59-79ff-4ce1-a7c1-323ab8163235\evidence\`  
   恢复回到桌面。这是正确 fail-closed。

### FastOperator 现状（重要）

- 旧任务 `XhsFastOperator01-04Live` **保持 Disabled**
- 01 的 17895 是从 **当前 release** 临时拉起的 node 进程，**不是计划任务**，重启会丢
- 启动器：`C:\Users\Public\xw-runtime\logs\start-serve-01.ps1`（须带 `ANDROID_ADB_SERVER_PORT=5038`）
- 02/03/04 对应 17897/17898/17896 **未启动**
- ADB 权威口是效卫 **5038**，不是 5037
- 01 serial `1511f78c`；adb：`C:\Program Files (x86)\xiaowei_android\tools\adb.exe`

设备配置（勿把 secrets 贴进聊天/PR）：`C:\Users\Public\xw-runtime\secrets\control-plane.devices.json`

---

## 6. `/xw` 入口已经过时（下一任优先项）

人用的 `/xw` skill 真源（两份必须同内容）：

```text
C:\Users\windows 10\.agents\skills\xw\
C:\Users\windows 10\.codex\skills\xw\
```

里面大量命令仍是：

```text
node C:\Users\Public\xhs-registry\ops\xw-start.mjs
```

该文件已不存在。`xw-start.mjs` 源码在：

```text
xw-platform\services\orchestrator\ops\xw-start.mjs
```

但脚本默认：

```text
ROUTING_ROOT = C:\Users\Public\xhs-routing-v1-1
CONTROL_TASK / SERVE_TASK = 旧 ps1
TASK_LAUNCH = C:\Users\Public\xhs-agent-control\task-launch.json
```

它会：认旧计划任务名、要求 `main == origin/main == task-launch.gitCommit == release receipt`、任务缺失 `fail closed`（`task_missing`），**不会**把 serve 装到 `xw-runtime`。

若对正在听的 01 serve 跑旧 start，可能按 stale commit **停掉再装旧任务**。

`/xw start` 设计上正是「拉四机 serve + 核对 ADB 5038 + 不健康机才丢 R0」。**概念对，路径错。** 要换，不要启用 `XhsFastOperator*`。

live HTTP 已经是新系统，所以 `devicectl --local job submit` 能成。缺的是人入口和 serve 常驻。

agent-entry.md 仍夹杂旧路径和旧 `releaseId: rel-2026-08-12-xianyu-qr-mask-v3`，同时 health 是 `xw-20260819-f337079`。以 health JSON 的 `releaseId/sourceCommit/runtimeProfile` 为准。

---

## 7. 红线（接手后立刻认）

- 禁止无 lease 碰机、禁止 GatewayOperator 旁路、禁止直写 `control.db`
- 禁止支付 / 转账 / 删号 / 验证码硬闯
- 禁止 `runtimeCutoverAllowed=true`、禁止 npm workspaces
- 禁止 squash 合 PR（用 merge commit）
- 禁止把 DSH / Open Action live 当已经打开
- 禁止重新启用指向 retired 目录的旧计划任务
- 禁止删 `*-retired-20260819` 和 `xw-runtime\rollback\`
- 密钥：orchestrator token 在 `xw-runtime\secrets\launch-orchestrator.ps1`，不要进 git/聊天
- Explorer session token 不要打日志；lease TTL 约 60s，拿不到 token 就等过期，不要手改 DB 清 lease
- `services/` 下不要再新增第三套导入服务名（verify 合同只认 orchestrator + control-plane）
- 导入树改动走 `docs/fusion/post-import-allowlist.v1.json`

---

## 8. 未来要做的事（建议顺序）

不要平行乱开 live 门。下面按依赖排。

### P0 — 现场稳定性（可以和文档/源码并行）

1. Kimi 把 **8-21、8-22** 09:23 只读巡检跑完。漏了说「补巡检」。
2. 给 FastOperator 做 **XW 命名的计划任务**（01–04），从 `xw-runtime\current` 解析后的真实 release 启动，环境必须 `ANDROID_ADB_SERVER_PORT=5038`。BootTrigger 或按需。不要复活 `XhsFastOperator*Live`。
3. 01 的临时 17895 进程重启会丢；做成任务前不要当常驻。

### P0 — `/xw` 迁到新家（人入口）

4. 改 `~\.agents\skills\xw` 与 `~\.codex\skills\xw`：所有 `xhs-registry` / `xhs-routing-v1-1` 路径改为 `xw-platform` ops + `xw-runtime` 证据/outbox 约定（outbox 新位置要设计，别写回 retired 目录）。
5. 改 `ops/xw-start.mjs`：认 `XW Platform Control Plane/Orchestrator`，认新 serve 任务，release gate 对齐 `xw-20260819-f337079`（以及以后每次新 release），任务缺失 fail closed 时给出「请先注册 XW serve 任务」而不是去装旧 XML。
6. 更新 live `agent-entry.md` 生成逻辑：命令骨架不要再 ssh 到旧 Mac 路径、不要指向 retired 目录。
7. 先 `/xw start --check`（只读）在新逻辑上变绿，再允许真 start。

### P1 — 部署门（源码已超前于现场）

8. **不要默默把 main@7917ac9 布到生产。** M4 是源码合同，现场仍应 `legacy_compat`。若要新 release：走 M3-R 那套 package / preflight / 计划任务 launcher，另开 releaseId，保留回滚。
9. 新 release 仍然：`dshEnabled=false`，`openActionLiveEnabled=false`。

### P1 — M4 源码后续（不开真机也能做）

10. 把 Skill Registry 接到现有 `services/orchestrator/skills/`（真源先留这里，不要先搬到仓库根 `skills/`）。
11. Router 与正式 job 提交打通（现在 Router 是进程内 fixture）。
12. Experience Ledger 落到 Orchestrator knowledge 的分层，而不是永远内存 Map。
13. DSH 真插件：仍只改 `integrations/dsh-xw`；升级 DSH 必须独立 PR + compatibility suite。当前 lock 是 rc.7 / `99f6f02f…`。
14. Graph v2 仍是 M5，别塞进 M4。
15. Compiler 自动改生产 Skill：**禁止**。只能出 CANDIDATE。

### P2 — 真机（另开门，不要跟着源码合入自动开）

16. 只读类：`xhs.observe.feed` 已在 01 证明；02/03/04 还要各自 serve。
17. 最小外发（tap 等）必须：人在场、lease 在 17920 可见、支付闸不放行。不要为测试而测。
18. Open Action live / DSH live 是独立 Gate，不是「M4 合了就能点」。
19. `xhs.observe.note_detail` 历史上有 serve 生命周期/locator 缺失问题，不要当下一单默认。

### 文档债

20. 根 `HANDOFF.md` / `README.md` 部分段落仍写 cutover 未发生或 PR #14 为当前工作。以本文为准，抽空修。
21. `docs/architecture/runtime-boundaries.md`、`authority-boundary.md` 仍写 `RUNTIME_CUTOVER_GATE=CLOSED`。运行时已切，源码合同未改这些字。
22. `skills/CONTRIBUTING.md` 仍写「源在 Mac、Windows 只读」。合仓后已错。
23. `agent-entry.md` 的 releaseId 与 health 不一致。

---

## 9. 常用命令（cwd = xw-platform 根，除非注明）

源码门：

```text
npm run check
npm run fusion:verify
npm run authority
npm run kernel:check
npm run test:kernel
npm run m4a:accept
npm run test:m4b
npm run test:m4c
```

现场只读：

```text
curl.exe -s http://127.0.0.1:17920/control/v1/health
curl.exe -s http://127.0.0.1:17930/api/health
curl.exe -s http://127.0.0.1:17930/agent-entry.md
```

提交正式 job（绝对路径，替换 key）：

```text
node C:\Users\Public\xw-runtime\releases\xw-20260819-f337079\services\control-plane\control-plane\devicectl.mjs --local health
node ...\devicectl.mjs --local route plan --actor claude-pilot-20260809 --capability xhs.observe.feed --alias 01
node ...\devicectl.mjs --local job submit --actor claude-pilot-20260809 --capability xhs.observe.feed --alias 01 --idempotency-key <unique> --params "{}"
node ...\devicectl.mjs --local job watch --job <jobId>
node ...\devicectl.mjs --local leases
```

pilotOnly 当前白名单 actor：`claude-pilot-20260809`。换未登记 actor 可能不在 pilot 范围。

临时起 01 serve（进程，非任务）：

```text
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\Public\xw-runtime\logs\start-serve-01.ps1
```

必须 `ANDROID_ADB_SERVER_PORT=5038`。

---

## 10. 建议下一个 agent 开工三问

1. 这次改源码、改 `/xw` 入口、注册 serve 任务，还是再跑真机 job？
2. 若碰机：lease 在 17920 看得见吗？01 的 17895 还在听吗？当前前台是不是小红书 `IndexActivity`？
3. 若改源码：落哪个 PR？会不会被误当成「授权 live」？

默认下一刀：**把 `/xw start` + 四机 serve 任务迁到 `xw-runtime`，只读 `--check` 先绿。** 不要开 DSH/Open Action live，不要部署 main 上的 M4 进生产，除非人明确说「打新 release」。
