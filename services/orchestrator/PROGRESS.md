# xhs-registry 进度

> 最后更新：2026-07-27 13:40 CST（方案 A main 真源已收口；过时 knowledge active_blocker 三条已 resolved；Agents.md 补默认链路+跨机并发。agent-entry active blockers=none；4 ready）

## 一句话现状（北极星，所有 agent 必读）

**愿景**：AI agent 原生公司——无人操控手机，每台/每群 agent 配真机，自动做运营、上架、客服回复等真实业务。
**当前阶段**：基础设施已建成（身份/审批闸/知识库/scout 骨架/多模型路由/无人值守验收/手机面板），业务刚点火（首例控制面真评论 2026-07-24 已发出）。
**路线**：不等建设完，小步真跑——本周每天 2-3 条真评论走控制面+人审批攒实证；近期 scout 自动巡航啃配方积压 + 闲鱼上架接通；中期微信客服 + R2 审批降级抽检；远期手机池扩容 + v1.2 调度内核。
**路径裁决**：控制面 job + 审批闸是唯一权威业务入口；task-runner/dashboard 是已退役的历史主力（实证保留）。
**代码真源（2026-07-27 方案 A）**：GitHub `gifted-professor/xhs-device-agent` 的 **`main`** 是唯一权威。已合并 PR [#14](https://github.com/gifted-professor/xhs-device-agent/pull/14)（control-plane → main，merge `2923bef`）+ [#15](https://github.com/gifted-professor/xhs-device-agent/pull/15)（placement-entry v1.1 + 闲鱼恢复/4 机并发 → main，merge **`1f7ae22`**）。业务 tip `953d187`（discard-dry-run relaunch）已在 main 祖先链上。约定：新活从 `main` 拉短分支；禁止再往 `agent/placement-entry-v1-1-20260724` 长支无限堆；Windows `C:\Users\Public\xhs-routing-v1-1` 应对齐 `main`（`git checkout main && git pull`，`task-launch.json` gitCommit = **完整 40 字符** `git rev-parse HEAD`）。旧 draft 长支可留作考古，不再当生产入口。
**Agent 入口（2026-07-26 已落地并通过四机 Phase A）**：碰机必须 `session acquire` / `job submit`（lease 可见）。`GatewayOperator`、XHS serve、旧 task-runner/greenarrow 直调均 fail-closed；退役 dashboard 的 legacy guard 默认也已切到 `enforce`。实验旁路必须同时设置 `XHS_ALLOW_BYPASS=1` 和非空 `XHS_BYPASS_REASON`，且不计生产验收。lease 授权同时绑定 public device id 与 private runtime id。`a982374` 已修复 canary session action 误按普通 job 路由的问题；01 canary 与 01–04 四 lease + 并发 `imeList` 均通过，最终 leases/pending 归零。完整交接见 **`HANDOFF-2026-07-26-agent-entry-xianyu-verify.md`**。

### Agent 统一入口与占用控制台（2026-07-26 20:39 CST）

- **生产入口**：Windows registry `GET /agent-entry.md`（curl 直读）、`GET /api/agent-entry`（`xhs.agent-entry.v1`）和 `GET /`（SSR 纯 HTML、零 JS）。每次请求实时聚合设备/lease、只读 control.db 的 running/recent jobs 与审批、四态知识卡点；控制面或 control.db 不可达时返回 source stale，不报 500。
- **卡点生命周期**：`active_blocker | backlog | resolved | probe_unknown`；resolved 为终态。两条已解决 02 条目迁移为 resolved，03 物理断连为唯一 active blocker；03 后续 resolved 后重启不会重新激活。旧 `flag-engineer` API 与 lifecycle 同步，不再出现字段分裂。
- **人类审批安全**：远程 `?token=` 初次验证后换 30 分钟签名 HttpOnly/SameSite=Strict Cookie；表单带 CSRF，批准必须准确输入 `APPROVE`，完成后 303 PRG。Agent 入场红线仍禁止调用 approve/deny。
- **验收**：本地 9/9 tests + check-js 通过；Hermes 显式使用 `openai-codex/gpt-5.6-sol` 独立审查，首轮发现 4 项后修复，复验唯一裁决 PASS（首轮 session `20260726_202804_5c85dd`，复验 session `20260726_203415_04477a`）。MiMo 两次因余额不足未启动，不计验收证据。
- **部署实证**：Mac/Windows `registry.mjs` SHA-256 均为 `96ed8316262ca0f883520762fd54d439c02c88a46b9de2277076ab2e6dfff012`；`XhsDeviceRegistry` 监听 PID `21968 → 22144`，`StopOnIdleEnd=false`。备份/回滚点：`C:\Users\Public\xhs-registry\backups\deploy-20260726-203924`（含代码与 registry DB/WAL/SHM 当时存在项）。
- **线上 smoke**：新旧端点均 200；无 token 的 tailnet 请求为 401，正确 token 初始交换为 303；JSON/Markdown 均 no-store；页面无 `<script>`；当前 active blocker 仅 03、两条 02 为 resolved、pending=0。另起 Windows 临时实例断开控制面与 control.db 后 `/api/agent-entry` 仍为 200，两个 source 均明确 stale；临时实例和目录已清理。
- **边界**：本节只证明 registry 入口/控制台已上线，不代表 P2 感知改造或任何新一轮手机业务链已验证；本轮未申请 lease、未提交设备 job、未碰 01–04 真机。03 继续等现场重插，恢复协议见 `~/handoffs/HANDOFF-from-e98a5289-xhs-registry.md`。

### P0 安全闸与入口语义修正（2026-07-27）

- **agent-entry 升 `xhs.agent-entry.v2`**：per-device 新增 `jobStatus`（latestJob/lastSuccess/lastFailure/**unresolvedFailure**/consecutiveSuccesses，窗口 50）与 `state` 分层（online/quarantined/leaseFree/identityKnown/identityStale/hasUnresolvedFailure/**ready**，任一输入未知则 ready=null 绝不假阳性）。旧 `recentFailure` 保留为废弃别名但语义改为 unresolvedFailure——只有发生在最后一次成功之后的失败才显示，修复「已修好的机器仍顶着旧失败」误导。Markdown 入口设备行补 online/ready/streak/unresolvedFailure，并注明 registry 观测不到 PnP/App 登录态。
- **命令骨架修正**：入口命令改为 `node control-plane/devicectl.mjs --ssh xhs-windows ...`（cwd = Mac 上 GPFS checkout），新增 route plan / job status 骨架；devicectl 确认自带 `job status|watch|cancel`。
- **身份 TTL 真实化**：`--identity-stale-s`（默认 900s）；identityCache 返回 ageSeconds/staleAfterSeconds，超时如实标 stale（此前只判「同步过没有」，停摆几天也显示新鲜）。
- **审批权限拆分（关键安全闸）**：`--agent-token`（读 + 知识库/身份写）与 `--human-token`（唯一能 approve/deny）分离；loopback 免凭证不再能审批（此前 Windows 本机任何进程可无凭证批准 R2）；actor 由凭证推导为 `human:<--human-actor>`，body/表单自报作废；API approve 需 `{"confirm":"APPROVE"}`。新增 registry 侧 `approval_audit` 表与 `GET /api/approvals/audit`。**未传 `--human-token` 时为 LEGACY 模式，行为与旧版完全一致**（零中断迁移用）。
- **installer 修复**：`install-registry-task.ps1` 此前注册的任务**没有任何触发器**（重启后 17930 不会自动拉起，全靠手动 Start）；现加 AtStartup 触发器 + Principal（S4U，失败回落 Interactive），参数化 `-AgentToken`（默认旧值，sync-feishu 零改动）/`-HumanToken`。
- **watchdog 冷却期吞变更修复**：冷却期跳过 kimi 时不再推进 lastSha/flags（此前被抑制的 commit 永远不会被验收——22:58 那轮已实际吞掉 `8cf9e08..0686247`，state 已回拨补验收）；kimi rc≠0 也不消费变更。
- **本目录 git 化**：`git init`（main），`.gitignore` 隔离日志/截图/.bak/runtime；首 commit `9fc0247` 记录改造前 Windows 部署 SHA `96ed8316…` 与新版 SHA 锚点。调试截图已删，旧 .bak 移入 `runtime/backups/`。
- **测试**：13/13（node --test，新增 per-device 语义、TTL stale、human/agent/loopback 权限矩阵、LEGACY 回归、审计断言）。
- **部署实证（2026-07-27 00:08 CST 完成切换）**：Windows registry.mjs SHA256 `780054dc65bc1d8aeb2b2198a1839f408373b262d57e367ceab350861ca1836a`（旧版备份 `backups\registry.mjs.pre-p0-20260727`）。legacy soak 通过后以 `-HumanToken` 原子重装任务：State Running、`StopOnIdleEnd=false`、**BootTrigger 已注册**（此前任务无任何触发器）。验收矩阵全过：loopback/agent token POST approve=**403**、human token 无 confirm=**400**、human token+confirm 穿透控制面（fake-job 404 如实代理）且 `approval_audit` 落行（actor=human:console 凭证推导）、`?token=<human>`=**303**、agent token 读=200、loopback 知识库读=200、sync-feishu lastIdentitySync 切换后继续推进。生产 v2 实测：01/02/04 `ready=true`/`unresolvedFailure=none`（旧失败不再误导），03 `ready=false`/`unresolved=ADAPTER_FAILED`/隔离如实。human token 在 Windows 任务参数里（`schtasks /query /tn XhsDeviceRegistry /v` 可查回）。坑：`schtasks /end` 杀不掉旧 node（22144 曾继续占 17930 服务 v1），需 netstat 定位 PID 后定点 taskkill；ssh 进 Windows 默认 PowerShell，curl JSON body 要 scp 临时文件。**未做真实重启 soak**（会打断控制面/网关/手机 serve，留待下次维护窗口顺带验证 BootTrigger 实效）。
- **知识库留痕**：`registry-token-split-migration-20260727`（recipe，verifyMode=replay，含迁移顺序与两个坑）。

### 无人化真机稳定性 campaign + registry P1 + Hermes 常驻（2026-07-27）

> 批准的 4-phase 计划（campaign 规模=每台 3 连轮 + 三机并发 1 轮；恢复权限=main-safe 零动作自动恢复、其余 fail-closed 停臂；分工=Claude 战役 / Hermes 常驻 / Codex 验收）。执行过程零人工，人只做开工前颗粒度对齐 + R2/R3 审批 + 03 物理重插。

- **Phase A — 三机 3 连轮 campaign（本仓库 `campaign/`，净新建）**：
  - 原语 `campaign/step.sh`（submit→15s poll→终态，退出码 0/2/3/4/5/6）+ 主会话后台驱动 `campaign/arm-driver.sh`（三臂真并行，控制面按 deviceId 键控泵，跨设备并发）。fixture 参数固定（`campaign/fixtures/<alias>-<step>.json`），每步换幂等键重放。链：01=open→input→image→full、02=open→input→full、04=manifest→image→full。能力全免审批（R0/R1 非外部效应）。
  - **结果（2026-07-27 09:19 CST 截止）**：**02、04 各 3 连轮 COMPLETE（green_steps=6）**；01 r1+r2 全绿 + r3 open 绿后 r3 input 触发 `recovery_required`（设备前台 package=com.tencent.mm 微信，非闲鱼 → 非 main-safe）→ fail-closed 保持隔离、臂终止。leases 全释放（activeLeases=0），02/04 干净，01/03 隔离。
  - **证据 job id**：02 末轮 full `job_15d3b4df-9aac-48ca-9376-a696a6cd9178`；04 末轮 full `job_e020cfd0-f28b-4e22-af54-5093bd101bd9`；01 r1 full `job_5569fd47-a787-40c6-a018-027574d32700`、r2 full `job_8cadb94a-cb3f-402b-829b-110527c8193b`、r3 open `job_5318a8bd-49d7-4902-8a19-925406822872`、r3 input(recovery) `job_3d62c4bc-d9b6-42cb-b7d5-2bf028824fc7`。日志 `campaign/logs/arm-{01,02,04}.log`。
  - **验收（Codex 独立 verdict=fail，如实记录）**：Codex `--output-schema campaign/acceptance-schema.json` 判 **fail**——blocker 理由：campaign 原始目标=3 台各 3 连轮，01 只达 2 个完整绿轮（r3 input recovery_required），且 01 隔离使 fleet 不满足 fleet_clean，故整体验收 fail；02/04 各 3 连轮成立但不改变整体结论。**Codex 未能独立 ssh 复核**（read-only 沙箱内 Tailscale 主机名不可解析，直接 ssh 与 windows-tailscale-bridge 均失败）→ 三台 `claimsMatchControlDb=false`（=未独立比对，非已确认不一致）；我方 campaign 全程经 `ssh xhs-windows` 实跑、job id 可追溯，但「独立验收者复核 control.db」这一环未达成，留为验收缺口。major：step.sh 全角括号 bug 导致 01 r3 input 被记 rc=1/ABORTED_UNKNOWN 而非 exit=3/ABORTED_RECOVERY（streak/失败计数采集可靠性风险，已修+落知识库）。minor：三臂恢复初期 harness 自身故障（STEP 变量撞车 rc=126/127，已修）后重跑，非控制面失败。**结论：campaign 目标 3/3 未达成，实得 2/3 + 1 fail-closed 隔离；01 需先恢复（设备在微信前台）才可能继续。**
  - **踩坑（已写知识库）**：① `step.sh` line 46 `$JOB（`全角括号 + `set -u` + 非 UTF-8 locale → 误判 unbound 变量 exit 1，掩盖 recovery_required exit 3（01 r3 input 实际 recovery_required 被记成 rc=1）；修法=ASCII 括号 + `${JOB}`。② recover-inspect-record 的 analysis 要求 `xhs.visual-elements.v1` 按截图 SHA 审计的视觉元素分析，不接受简化 classification JSON——视觉 sidecar 不可用时无法完成恢复分析 → fail-closed 保持隔离（正确）。
- **Phase B — registry P1（`/api/capabilities`+`/api/task-packet`+知识库过滤，已部署）**：Codex 无头 diff review 后修 4 处真实 bug（registry.mjs 部署 SHA `aa9924a`）：① `derivePolicy` 新增 `availability`/`runnableAsJob`/`runnableAsCanarySession`——autonomous（免审批）≠ 可直接 job 自跑；wechat.* `availability=dependency_pending_wechat_operator` 标 autonomous=true 但 runnableAsJob=false，task-packet 不再给它生成 job submit 骨架。② `routingMatrix` 只在 `routing.enabled!==false` 时把 alias 计入 byCapability（否则 eligibleAliases 误导 agent 提交后被拒）。③ `listKnowledge` appliesTo 过滤改 `json_each` 精确元素匹配，不再 LIKE '%x%'（`?appliesTo=%` 不再返回全部）。④ task-packet 意图词补 save_draft/草稿 + 发布/发商品；无意图匹配返回空推荐 + noIntentNote。17 集成测试全过（含 disabled-routing/appliesTo 通配符/no-intent/save_draft 无骨架反例）。**Codex #1 高危项（LEGACY_AUTH 可 approve）= 文档化迁移兼容契约，prod 带 --human-token 不激活，未改——记 backlog 待人定**。
- **Phase C — Hermes 常驻 cron ×3（已注册验证）**：`xhs-pnp-sentry`（每 15min，03 PnP present 翻转通知+写知识库）、`xhs-fleet-health`（每 30min，17930/17920 探活+sync-feishu 日志尾异常才发声）、`xhs-l1-patrol`（每 2h，对 ready 设备提交 `xianyu.observe.snapshot` R0 只读巡探，空闲才跑，全绿静默）。脚本落 `~/.hermes/scripts/`，源在 `ops/`。**watchdog launchd 迁移暂缓**（TCC 拦 launchd 跑 ~/Desktop 脚本 + 与运行中终端循环 watchdog 双发风险，留待迁出 Desktop 后做）。
- **Phase D — 03 恢复管线 + 4 机并发**：
  - **03 物理重插 + 恢复（2026-07-27 10:25 CST）**：用户现场重插 03 → PnP 哨兵报 present → 用户手动把 03 停在闲鱼主页。`job recover` 首次 RESTORATION_FAILED，根因 `scripts/xianyu-operator.mjs` isRecoverySafeMain line 1337 `/^消息[,，]/` 只认逗号后缀，而 03 a11y 把「消息」tab 暴露成裸 `消息`（无 `消息，未选中状态` 描述节点）→ false-negative（「卖闲置」同函数用 `(?:$|[,，])` 接受裸标签，内部不一致）。修法 commit `14a5f0d`：对齐成 `/^消息(?:$|[,，])/`，49 测试全过含 03 fixture 回归。**部署坑**：task-launch.json gitCommit 必须填**完整 40 字符 hash**（短 7 字符触发 `Repository commit mismatch` 闸门→控制面 exit 1），改全 hash 后重启 `XhsDeviceControlPlaneV1`，17920 LISTEN/health 200。03 recover→`step=already-safe-main` `quarantineCleared=true`。**再坑**：recovery 清隔离但原 job 是 terminal `recovery_required` 不翻 status，registry `state.ready` 还要求一个成功 job 刷新 lastSuccess（registry.mjs:663 `unresolvedFailure=lastFailure 且比 lastSuccess 新`）——给 01/03 各跑一个 R0 `xianyu.observe.snapshot` succeeded 后 4/4 全 ready。
  - **4 机并发 full_dry_run 轮（2026-07-27 02:34 CST）**：4 台同刻各提交 `xianyu.publish.full_dry_run`（eligibleAliases=01/02/03/04，R1 免审批，fixture 全 skipUpload/skipCategory/skipAddress=true saveDraft=false，不需图片）。4 job startedAt 均 02:34:18 真并行，共享 `transport:xiaowei:22222` 锁无死锁无互相干扰。**结果：01/02/04 succeeded（restoration/verification true），03 recovery_required/RESTORATION_FAILED**——03 dry-run 本身 output.ok=true/verification.ok=true（未存草稿未发布），但 restoration 从 service-category compose 页退回 main 失败（03 闲鱼落到服务类目 compose，findDiscardWithoutSaving/compose-exit 不认其 a11y 出口）→ 03 重新隔离、卡 compose 页。job id：01=`job_b696b401`、02=`job_e6aad8ee`、03=`job_c47d9413`、04=`job_cea82378`。**并发机制结论：4 路真并行 + 22222 锁串行化网关请求无死锁，机制成立；03 失败是 03 专属 compose-exit restoration 间隙与并发无关。**
  - **Codex 独立验收 verdict=fail（如实）**：blocker=03 非 succeeded（4/4 硬门槛失败）+ fleet not clean（03 quarantined）；major=沙箱 SSH 不可达→四台 claimsMatchControlDb=false（=未比对非不一致）+ 无法独立确认时间窗/22222 锁/实际参数；minor=本地 fixture saveDraft=false 但静态不能替代 control.db 实证。用户决定接受 3/4 作为并发机制验证结果，03 compose-exit 间隙记 backlog。
  - **03 现状（已清隔离且并发 restoration 过关，2026-07-27 12:30 CST）**：`quarantined=false`、`state.ready=true`；4 机并发 full_dry_run 中 03 与 01/02/04 同为 succeeded。
  - **03 零点击自主恢复闭环（2026-07-27，继承 Claude 会话 9e0dc5b6 → Grok 收尾）**：
    1. **代码**：GPFS `47c329d` — `recoverDiscardDryRun` relaunch；`6f9221c` — recovery.failed 透出 adapterCode/stderr；**`953d187` — `discardDraftDryRun`（job 末 restoration 真路径）relaunch 兜底**。
    2. **部署**：Windows `xhs-routing-v1-1` pull 对齐 + `task-launch.json` **完整 40 字符** gitCommit + 重启 `XhsDeviceControlPlaneV1`。
    3. **attempt1**：对 `job_c47d9413` `job recover` → relaunch dialer→MainActivity（零点击）→ 预期 `RECOVERY_VISUAL_CONFIRMATION_REQUIRED`。
    4. **attempt2**：`ops/recover-main-safe.mjs` → main-safe 0.98 → `already-safe-main` / `quarantineCleared=true`。
    5. **ready 刷新**：R0 snapshot `job_b8043847` succeeded。
    6. **交接**：`~/handoffs/HANDOFF-from-9e0dc5b6-xhs-registry.md`。
  - **job 末 discard-dry-run relaunch（关键修复，`953d187`）**：此前 03 并发失败是 **in-job restoration 走 `discard-dry-run`**（不是 recover 路径），service-compose 上 close/不保存 a11y 认不出 → RESTORATION_FAILED。现精细路径失败则 `startIdlefish` 回 main（弃未存草稿）。单测 54/54。
  - **4 机并发 full_dry_run 复跑 4/4 全绿（2026-07-27 12:16–12:28 CST）**：actor `grok-conc4`，startedAt 均 ~04:16:50 真并行。job：01=`job_b26617e9`、02=`job_25c9678d`、03=`job_7e9955cf`、04=`job_a0ead64d`；全 `succeeded` 且 `output.ok`/`restoration.ok`/`verification.ok`。终态 fleet **4 ready / 0 lease**。02 因 5×2 SKU 略长（~11.5min）。上轮 3/4 的 03 间隙已实证关闭。
  - **仍可选 backlog**：service-compose **精细** a11y 点选退出（relaunch 兜底已够并发验收；精细路径可降 force-stop 频率）。
- **知识库留痕**：原条目 + `recovery-zero-tap-relaunch-two-step-20260727`、`recovery-relaunch-gate-visual-confirmation-20260727`、`recovery-discard-dry-run-relaunch-fallback-20260727`、`xianyu-4machine-concurrency-4of4-20260727`、`ops-recover-main-safe-one-shot-20260727`。

### 闲鱼标准草稿链路（2026-07-26）

- **形态**：按 App 固定剧本（非 LLM 临场点）；闲鱼在 `apps/xianyu` + `scripts/xianyu-operator.mjs`
- **能力**：`open_dry_run` → `input_dry_run` → `image_dry_run` → `full_dry_run`（纯 dry-run，禁止存草稿）；产生草稿改走独立 `full_draft_dry_run` 或 `save_draft_dry_run`，均为 external effect + 人工审批；另有 lab_only `vision.resolve_tap_dry_run`
- **部署锚点**：GPFS/origin/Windows/task-launch 应对齐 **`309e5457ec0e852cfbff5410544c1f551f777cfd`**（分支 `agent/placement-entry-v1-1-20260724`，17 capabilities；`6a83abe` 将纯 dry-run 预算调至 720s 并压缩 2x5 SKU 输入冗余，`26aa9b1` 关闭重复启动、同 App 子页 force-stop/reopen 与整段 SKU 二次重跑，`309e545` 允许受审计恢复从已存在的 `discard-dialog` 严格点击唯一“不保存”继续；production worker 与 `.env.example` 均 enforce）
- **实战配方**（已写进 operator / 文档）：
  - 规格值**只键入** EditText+ENTER，不点推荐 chip（防「蓝色」→「湖蓝色」）
  - 批量价库应用内数字键盘键间隔 **≥450ms**（同键连按 debounce；99 曾变成 9）
  - 批量确认点**右下角**确定，不是中间 sheet 确定
  - 包邮：多行合成节点按行心点（`freightOptionTarget`）
  - 存草稿：点「存草稿」→「我知道了」；顶栏若只有「草稿箱·N」需关窗对话框兜底；**永不发布**
  - 小薇 ADB 用 **port 5038**（不是默认 5037）
- **干净耗时**：单会话约 2–4 分钟；控制面多 job 会 restore 打断，宜单会话 full_dry_run
- **文档**：仓库 `docs/xianyu-publish-dryrun.md`；**交接全文** `HANDOFF-2026-07-26-agent-entry-xianyu-verify.md`
- **Live supervisor（3882bfc+）**：逐步打点+expect+recover；截图 fail-soft；SKU 无下一步不三连 BACK
- **01–04 战役末状态**：01 全绿曾成功；02 **库存 EditText 顽固 40** 未解；03 ADB 曾离线；04 图 verified 不稳。旁路验证**未占 lease**——接手勿重复
- **入口验收**：135/135 测试 + check/secret scan 通过；独立 Kimi 复审 PASS。真实 01 canary 的 lease 可见，`xiaowei.lab.raw/imeList` succeeded、vendor 10000；随后四个 Agent 同时持有 01–04 四条可见 lease，并从同一 barrier 并发执行四次只读 `imeList`，均绑定正确公开 device、无审批/外部副作用；四条 session 全释放，最终 `leases=[]`、`pending=[]`、无隔离设备。此结论只覆盖 Phase A 入口，不代表闲鱼业务链已复验。
- **Phase B 真机结果（2026-07-26）**：stdout 协议冲突已由 commit `3a430e5` 修复（进度走 stderr、终态 JSON 留 stdout）。01 重跑 job `job_58f19bdd-0711-483e-8f0a-1f5097c59420` succeeded，verification/restoration 均 true，lease 自动释放——01 核心链已绿。随后 02 的 2x5 SKU/stock job `job_aad3113e-1569-4986-9a9c-ced28cde4384` 超过 360s，落 `ADAPTER_TIMEOUT`；discard restoration 失败，控制面将 02 标记 `recovery_required / RESTORATION_FAILED` 并隔离。`inspection_256` + hash-bound Mac 视觉分析先将残留页确认为 `sku-sheet`（0.97）。`1684fe9` 随后上线定向 SKU 恢复、异常证据、恢复截图和视觉硬闸，并由独立 Kimi 复验 PASS（全套 167/167 + check/secret scan）。用户手工重开 App 后，fresh `inspection_262` 仍在可见 recovery lease 下确认 MainActivity；截图 SHA-256 `1cf059e34f8e3111237b75bfb161472729725ec575a6acbc52a4484651896f57`，Mac 视觉热路径 1.413s / 82 elements，控制面重算为 `main-safe`（0.98）。最终 `job recover` 运行中可见 lease `lease_92458ec3-883d-4986-a6f8-dfff812336fe`，结果 `already-safe-main / safeStateVerified=true`，全程零点击，before/final 两张截图证据 `evidence_812140ed-b8a6-456f-9f34-b5293faab54e` / `evidence_56c84267-556d-44b7-ad61-1e841749f5d3`；02 已 `quarantined=false`，最终 `leases=[]`，未保存草稿、未发布。
- **02 单次复验与强退根因（2026-07-26 13:42–13:52 CST）**：部署 `6a83abe` 后只提交了一次 02 job `job_463a2917-8e84-4311-ab7e-5e5e918dbd23` / run `run_352d6983-e411-4090-8b52-0fa45efaa433`，lease `lease_7b2ba0f0-c934-4ebc-a2cb-5ddac1d9cd29` 全程可见。作业运行约 605.4s，证明旧 360s `ADAPTER_TIMEOUT` 已越过，但终态仍为 `failed / VERIFICATION_FAILED`，不能写成业务通过；restoration `{ok:true}`，最终 02 在线、未隔离、`leases=[]`、pending approvals 为空，未保存草稿、未发布。用户现场观察到“做到一半被强制退出又从头来”；代码审计确认并非正常流程：开场重复 `startIdlefish`、SKU 子页可被宽泛 compose 指纹误判、SKU supervisor `maxAttempts:2` 会把长链整段再跑。`26aa9b1` 已改为同 App 非 compose 页只复读一次并诚实失败、不 force-stop/reopen，已知 child page 明确排除，SKU 只跑一遍，并把首个失败 step 顶层化；全套 171/171 + check/secret scan 通过，独立 Kimi 复审 PASS。部署后 GPFS/origin/Windows/task-launch 对齐，控制面健康（4 devices/17 capabilities/0 leases），本轮未提交第二个真机 job。
- **02 防重跑复验与恢复（2026-07-26 14:13–14:29 CST）**：经人确认后只提交一次 job `job_89f6a123-b4ff-445a-b944-dd77961a15ab` / run `run_be8d9781-a021-4110-be66-092a49945ecc`，lease `lease_e0a5259f-2646-41ae-8c84-98e5c7d7364c` 可见、public device id 固定 02。约 119.6s 即停止，准确输出 `sku:sku-not-on-compose`，没有 force-stop 后整段重跑；业务终态仍未通过。自动恢复停在“要不要先存个草稿”对话框并进入 `recovery_required / RESTORATION_FAILED`。fresh `inspection_279` 截图 SHA `7a65439bb353b7fe18ebd33abd7434deb1a2445476be787770ab7bdfad16a0ec` 经本机 hash-bound 视觉分析确认 `discard-dialog` 0.99；`309e545` 补“恢复启动时已在对话框”分支，只允许精确、唯一、左下的“不保存”，定向 31/31、全量 172/172、check/secret scan、独立 Kimi 均 PASS。第一段恢复只点一次“不保存”且按硬闸不直接解隔离；随后 `inspection_284` / SHA `d8ceefca2d69b3a833af02763a6ac12fd91d3d2a28da2dec1b9ea461874158ce` 确认 `main-safe` 0.98，最终零点击 recover 为 `already-safe-main / safeStateVerified=true`，证据 `evidence_845861c4-31ff-4f6c-a724-629708bbb157` / `evidence_4953587a-869c-4ca8-86dc-68568660fa72`，02 已在线、`quarantined=false`、`leases=[]`，未保存草稿、未发布。
- **Phase B 最新状态（2026-07-26 18:59 CST）**：02 已在控制面标准流程完成 2x5 SKU、统一价 ¥12.34、每规格库存 2、包邮、no-save/no-publish 全链验证；job `job_f0cbea74-b4e5-46f6-8963-fe3f1157d1d5` / run `run_cedfb09a-d5a3-4210-95d9-57cc8b7151dd` 为 `succeeded`，verification/restoration 均 true，lease 已释放，02 未隔离。相关恢复/分类修复依次落在 `5b5c733`、`8b39017`、`539c2d7`，全套测试最终 188/188 并经独立 Kimi 复审。
- **当前唯一硬卡点：03 物理未连接（2026-07-26 19:04 CST）**：03 的 pinned `xianyu.publish.open_dry_run` job `job_d3bd9407-9dec-41d7-a497-105dad43a9a8` 在适配器首步失败并进入隔离；只读 recovery inspection 经可见 recovery lease 复现 `ADAPTER_FAILED / GATEWAY_DEVICE_PROBE_FAILED`。诊断透传由 `c35db20` + `45aba9f` 上线，GPFS/origin/Windows/task-launch 已对齐 `45aba9f32040ffc6b4043d8ecc186e5e8c0d2525`。全局网关正常：01 上 `xiaowei.device.list` job `job_69d4c15a-4988-4d45-a101-aea8c86812d2` succeeded / vendor 10000。Windows PnP 内存比对只输出布尔结果：01/02/04 `USBDevice/OK`，03 无 present 记录；历史记录为 `Problem 45`（phantom/not connected）。`pnputil /scan-devices` 后仍仅 3 台 Android-like present。下一步必须现场重插/供电/线材检查 03；恢复枚举后才可继续 03 recovery→open→full、04、四机并行。
- **04 图片门槛首跑（2026-07-26 21:25 CST）**：用户决定先跳过 03、放行 04 真机验证。04 pinned `xianyu.publish.image_dry_run` job `job_79e4d366-a22d-45fd-a927-92e161fb3d36` / run `run_96cab943-bbac-4f93-b3a6-567b7c8183c8` 运行时公开 job lease 精确绑定 04，终态 `failed / VERIFICATION_FAILED / image-manifest-unverified`，restoration `{ok:true}`；最终 `leases=[]`、pending approvals 为空、04 未隔离，未保存草稿、未发布。诊断确认 Windows 源文件名为 `xf4_a.png`/`xf4_b.png`，而历史手机 staging 路径实际为 `XianyuFull4/a.png`/`b.png`，本次清单误把源文件名当成手机文件名；两张源 SHA 与历史 staging 清单一致。因现有控制面没有 UI 前只读复算手机文件 SHA 的登记能力，未换幂等键用历史路径重跑，也未继续 04 core full dry-run。
- **04 图片预检上线与第二门槛（2026-07-26 21:50 CST）**：commit `278fc56498abe21f93a2c6bb3f8e46447aa878fc` 新增 R0/read-only `xianyu.observe.image_manifest`，仅允许 lease 内对 `/sdcard/Pictures/...` 做 SHA-256 读取，不启动/导航 App；focused 54/54、全量 199/199、check 61、secret scan、diff check 全绿，独立 GPT 强模型验收 `PASS`。GPFS/origin/Windows/task-launch 四端对齐，控制面 18 capabilities；只给 04 routingProfile 增加该能力，配置/launch 备份后重启健康。04 pinned 预检 job `job_1d9f8910-fbb1-4ed4-8415-bd36c24ac207` / run `run_2b021122-a2c1-4016-9148-a61ee5e27fad` succeeded，确认手机 `XianyuFull4/a.png`/`b.png` 与源 SHA 一致。随后唯一一次 image job `job_f0a909d7-5576-41dd-b872-ded2441feb64` / run `run_bfe9f604-19e3-426d-800e-780b134b22ef` 在可见 04 job lease 下完成选择，但终态仍为 `failed / images-unverified`；截图 SHA `a929bca2135f...` 显示相册两图均选中，`d8c71a0a6636...` 显示发布页确有两个图片 tile，故定性为图片计数/感知假阴性，不能写成 job 通过。restoration `{ok:true}`，最终 04 未隔离、`leases=[]`、pending 为空，未保存草稿、未发布；按门槛未继续 core full dry-run。
- **04 图片假阴性修复与核心新卡点（2026-07-26 22:04–23:21 CST）**：先以 commit `6cd630ae757d073cd3c1b618cbae9a3313d283e1` 上线有界脱敏诊断，单次 fixture job `job_5ad55c31-2cb7-43c1-b7ca-48ddf612fcfb` 实证 04 的已选图片为两个同排 `Button/clickable/other` 大 tile，第三个为 `Button/add`，旧逻辑仅数 `ImageView`。commit `8cf9e08b0105a2486d768f5a474c77a15077fd5d` 增加“必须有同排同尺寸 add 锚点才数其左侧 Button”的 fail-closed 回退；202/202、check 61、secret scan、diff/syntax 全绿，两轮独立 GPT 强模型均 `PASS`，GPFS/origin/Windows/task-launch 四端对齐。修复后 04 image job `job_53ed22a3-fc19-48fa-87da-dc32dd60e171` / run `run_0ab0df6c-681c-45f8-a582-1bf433dd8c3b` succeeded，`images-uploaded`、verification/restoration true，图片门槛正式通过。随后 no-save core job `job_5acaf312-2671-4a0e-931c-9da6f18ca831` / run `run_be9c556f-07e1-46a9-b0a3-c1dd627b3200` 诚实失败于 `sku:sku-price-numpad-failed`，自动恢复未验证安全页而隔离；fresh `inspection_417` + screenshot SHA `bc4262ac...` 经 hash-bound 视觉确认为 `sku-sheet` 0.98（价格停在 `¥12`、数字键盘仍开），定向恢复返回主页后按视觉硬闸不直接清隔离；fresh `inspection_422` + SHA `0149282c...` 确认 `main-safe` 0.98，最终零动作 recover 为 `already-safe-main / safeStateVerified=true` 并清隔离。终态 04 online/not quarantined、`leases=[]`、pending 为空，未保存草稿、未发布；核心链仍未通过，禁止换幂等键盲重跑，先补数字键盘失败的有界结构诊断。
- **04 数字键盘根因修复并全绿（2026-07-26 23:29–23:44 CST）**：commit `8aff050d8d21165f3da3bef753b979ab7c4aaa3b` 上线仅失败时保留的有界脱敏 numpad 诊断（missing 字符、分辨率、最多 8 个候选的 classKind/bounds/clickable/geometry；不保留 raw label/输入框/账号文本），204/204 + check 61 + secret scan + 独立 GPT `PASS`。唯一 fixture job `job_a7a63413-a5b7-4b04-9dfe-863f12bc44a7` / run `run_c20e7c36-dc53-4bb7-9a58-3d5d87ee1f56` 精确返回 missing=`.`，唯一候选 `[0,2109,271,2287]`，旧 bottom 上限 `2400*0.95=2280` 仅差 7px；该 job 恢复仍严格走 `inspection_433` sku-sheet 0.98 → 定向恢复 → `inspection_438` main-safe 0.98 → zero-action recover，04 清隔离。commit `0686247e919d676068ee217c5e2d209b25c0dba9` 将键盘 bottom 上限最小放宽至 0.96（2304），真实 fixture 通过且 2305 仍拒绝；204/204、check/secret scan/diff/syntax、独立 GPT 均 PASS，四端对齐。最终 04 no-save core job `job_94870751-c63d-47a3-9145-deca4082ef8c` / run `run_39547768-e2e8-4caa-958d-fb8759ca8f7b` succeeded（约 4m16s），verification/restoration true；04 图片门槛 + 核心门槛均已绿，最终 04 online/not quarantined、`leases=[]`、pending 为空，未保存草稿、未发布。03 物理断连卡点不变，本轮未碰 03。

## scout（Phase 4 探索 agent）状态

- 设计文档 v2.1：`/Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-windows/docs/plans/2026-07-24-phase4-探索agent设计.md`（目标 P0/P1/P2、安全约束、DoD 全在里面）
- 代码：仓库 `scout/scout.mjs`（分支 agent/placement-entry-v1-1-20260724，commit 1158a35 起 12 个，最新 0f52cb7）
- 状态：§10-1/2 完成；§10-3 完成——结论：知识库 3 条 recipe 全为规则型且 ID 不匹配 capability，**P1 路径空集**（finding 已落库 `scout-finding-recipe-classification-missing`，待人决策 recipe→capability 映射）；§10-4 首轮 fresh explore 已在 01 跑通（xiaowei.lab.raw，scope 已落库）。待解：lab.raw 能力 app 对齐语义、pitfall 类别污染（详见 watchdog 报告 2026-07-24T15-05Z）
- v2.2 落地（2026-07-25）：ff951e8 修 exploreFresh 空 packageName 误探（null 即跳过记 pitfall，不再默认 xhs）+ --dry-run 贯通；99f9973 constraint 验证引擎（grep 取证，3 内置模式 comment-cap/timeout-90s/fail-closed，证据查不到→pitfall 标 human 不编造）；存量 3 条 xhs recipe 已补 appliesTo/verifyMode 并被 scout-constraint 实跑验证（verifiedBy 落库）；918908b AGENTS.md 部署流程加 3b（task-launch.json commit 闸门同步）
- **自动巡航已上线（2026-07-25）**：Windows 计划任务 `XhsScoutScout`，每 45 分钟一轮 P1 constraint 验证（只读 grep，不碰手机/不提交 job），安装脚本 `scripts/install-scout-task.ps1`
- ~~**当前阻塞**：P1 过滤 bug~~ 已修复（2026-07-25，三连修：b2fba6a P1 选目标 category-agnostic 只认 verifyMode；5339df9 跳过 device/session 目标 + 409 换目标 + generic repo-grep 取证；0f52cb7 noloc pitfall 24h 去重防刷库）。三端一致（origin=Windows=task-launch.json gitCommit 均 0f52cb7），巡航已恢复产出。新形态：6 个 recipe 被标 noloc（evidence 定位不到），待人裁决改 verifyMode=human 或补证据锚点，否则 24h 窗口过后会再刷一轮
- 委派路由：**routing-table-v2**（知识库，2026-07-25 用户裁决）——验证类→MiMo、修复类（含 scout）→GLM/Grok、设计/验收/运维→Kimi、R2→人；v1 已废止
- **fallback 链（2026-07-25 定）**：修复类默认 GLM → 失败/超时/验收不过 → Grok → 仍不决 → Kimi → 人；验证类默认 MiMo → 连卡两次 → GLM。触发即升档，不硬磕
- 设备 serve：01→17895 / 02→17897 / 04→17896（serial 见 identities.seed.json）
- 委派方式：`mimo-ro run --dir <项目> "任务"`（mimo-ro = ~/.mimocode/bin/mimo-ro，key 池轮换包装，池在 ~/.mimocode/key-pool.json 共 12 把，`mimo-ro --check` 体检，失败 key 自动标记 24h）；会话续接 `mimo-ro run -s <id>`。裸 `mimo` 也能用但只有单 key，推荐一律走 mimo-ro

## 委派路由规则（2026-07-24 定）

1. **作者优先**：谁写的代码谁修（会话连续性 `mimo-ro run -c`），同任务域不随便换人
2. **升级阶梯**：规格清晰的机械活 → MiMo；连卡两次 / 跨多文件推理 / 设计级 → GLM（claude -p）或 Grok（grok -p）；仍不决 / 安全边界 / 架构 → Kimi 或人
3. **验收独立**：无论哪档执行，diff 一律由 Kimi（或 watchdog 唤醒的无头 Kimi）验收，执行者不自评
4. **失败留样**：某档模型在某类任务失败 → 记知识库，作为以后路由样本

### 路由样本（2026-07-24/25 实测）

**正式路由表：`routing-table-v2`（v1 已废止）**——所有 agent 开工前先查它（`GET /api/knowledge` 按 id 查）。默认：验证→MiMo；修复→GLM/Grok；设计/验收/部署运维→Kimi；R2 审批→人不可委派。升级触发：同任务连卡两次升一档。以下为原始样本记录：

- MiMo 强：scout 逻辑/后端任务（constraint 引擎、exploreFresh 修复，均 7min 内过验收）
- MiMo 弱：前端页面+部署复合任务（面板 P0+P1，40min 超时 + 批量杀 node 误伤控制面/serve）→ 面板类升级 GLM/Grok
- 并行工单风险：A/B 双任务共享 registry 服务，A 重装任务会打断 B 的写入——涉服务重启的工单要串行
- 服务恢复手册：CP 挂 → 先查 task-launch.json commit 闸门（AGENTS.md 3b）；serve 挂 → `C:\Users\Public\xhs-registry\serve-restart-0X.ps1` 逐台拉
- 面板 P0 已完成（token + 0.0.0.0 绑定，tailscale 手机可访，token 在 Windows 任务 argLine）；P1 页面活升级给 GLM

## watchdog（无人值守验收）

- launchd `com.xhs.scout-watchdog`，每 1800s 跑 `watchdog/watchdog.sh`
- 检测：origin 分支新 commit + 知识库新 needsEngineer；无变化零成本静默退出
- 有变化且过 45min 冷却 → `kimi --print -p SUPERVISOR.md` 无头验收，报告写 `watchdog/reports/`
- v1 只验收不派工（不调 mimo-ro、不 push、不重启服务、不碰手机）；冷却期内变化记入 state 不重复唤醒
- state/log：`watchdog/state.json` `watchdog/watchdog.log`

## 架构

- **registry.mjs**（本目录 = 源；部署在 Windows `C:\Users\Public\xhs-registry\`，计划任务 `XhsDeviceRegistry`，端口 17930）
  - 设备身份注册 + 控制面状态聚合 + 人的视图（零依赖 node:http + node:sqlite）
  - Phase 1 身份注册 / Phase 2 控制面聚合 / Phase 3 审批（✅ 已全部上线并 E2E 通过）
- **sync-feishu.mjs**（跑在 Mac，launchd/手动 `--interval 60`）：飞书多维表格 ⇄ Windows registry 双向桥
- **控制面**（17920，Windows `C:\Users\Public\xhs-routing-v1-1\`，计划任务 `XhsDeviceControlPlaneV1`，仓库在 GPFS `xhs-device-agent-routing-v1-1`）
- 身份真相在飞书多维表格；registry 只做缓存；审批状态机属于控制面，registry 只读 control.db + 代理 approve/deny

## Phase 3 状态（2026-07-24 完成）

- registry.mjs Phase 3 已部署 Windows（SHA256 `91496134…` 与本目录一致，含崩溃修复），旧版备份在 Windows `registry.mjs.bak-phase2`
- E2E 已验证：提交 approval_gated 作业 `xhs.comment.send` → waiting_approval → registry `/api/approvals/pending` 可见（含设备别名/风险富化）→ registry 代理 deny → 作业 `cancelled / APPROVAL_DENIED`，`startedAt=null` 未执行
- 04 号设备（dev_8a943f25，二店）routingProfile 已**永久加入** `xhs.comment.send`（用户决策保留）；配置备份 `control-plane.devices.json.bak-phase3test`
- 设备路由配置：`C:\Users\Public\xhs-routing-v1-1\config\control-plane.devices.json`，改后需 `schtasks /end /tn XhsDeviceControlPlaneV1 & schtasks /run /tn XhsDeviceControlPlaneV1`

## 已知问题（下次可修）

1. ~~registry 会在控制面重启时崩溃退出~~ 已修复（2026-07-24 20:10，registry.mjs 701 行版）：control.db 查询全部走 queryControlDb（出错关句柄、30s 后重试，不再永久降级）；EADDRINUSE 进程内重试（防止任务重启撞端口耗尽重启次数）；进程级 uncaughtException/unhandledRejection 兜底。已通过验收：重演控制面重启，registry 存活且审批/聚合接口正常。Windows 旧版备份 registry.mjs.bak-phase3
2. **计划任务 idle 杀手（2026-07-26 再次回归并修复）**：`XhsDeviceRegistry` live task 再次出现 `StopOnIdleEnd=true`，导致 17930 被终止；根因是 `install-registry-task.ps1` 未固化该设置。现已在源脚本加入 `-DontStopOnIdleEnd`，live task 改为 false 并恢复 17930；原任务 XML 备份为 `C:\Users\Public\xhs-registry\XhsDeviceRegistry.before-idle-fix-20260726.xml`。以后重装任务后必须回验此字段。fast-operator serve 是 WMI 拉的不受影响。
3. ~~serve 响应包装掩盖执行细节~~ 已修复（2026-07-24，commit `3537505` + 部署流程文档 `824b1fd`）：xhs adapter 透传内层 `ok:false` 为 `ADAPTER_ACTION_REJECTED`（带 step/activity/log，`notSent` 不误标 ambiguous）；`resultSummary` 增加 output/error 字段；测试 33/33。**部署已走标准流程：GPFS commit → push origin → Windows pull（分支 agent/placement-entry-v1-1-20260724，两端一致）**，详见仓库 AGENTS.md「部署流程」节
4. ~~高赞评论选择器占位文本~~ 已修复（run-real-comment.mjs 加 CHROME_USER/CHROME_TEXT 过滤 + 视频笔记自动跳过换卡）
5. ~~04 editorLostAfterInput~~ 已绕过：首例真实评论 2026-07-24 21:55 在 **01** 发出（`job_7711264d`，01 主力机一次过，`output.ok:true` 发出确认，计数实证 366→「共 368 条评论」）。但作业状态落 ambiguous——**strict 验证假阴性**（afterCount 计数头没复读到 + 新评论按热度排序沉底，textScan 看不到）。04 的 editorLostAfterInput 仍是设备级偶发，未根治
6. **backlog：strict 验证改进**——verifyCommentSent strict 模式应回滚取计数头（beforeCount 路径已有此逻辑，afterCount 没有）；热帖场景考虑切「最新」排序找刚发的评论
7. **backlog：控制面 EADDRINUSE 重启竞态**——`schtasks /end` 后 3s 可能不够旧进程释放 17920（21:40 撞过一次，LastTaskResult=1），重启等待加到 8s+，或给控制面也加 registry 同款端口重试
8. **backlog（Hermes 全读评审 2026-07-25 提，有效但非紧急）**：
   - secret 治理：sync-feishu/install ps1 明文 token → 改 .env/环境变量（本地单人私网可缓）
   - 知识库 API：加 DELETE + PATCH-content（现只能增不能删、PATCH 只限三字段）+ 批量导入/导出
   - 知识库 category 加 scope/observation（收敛 pitfall 污染）
   - sync-feishu：SSH 调用加退避重试；sync-feishu.log 加轮转（已 1171 行）
   - registry.mjs 头注释 Node 版本更正（node:sqlite 需 22.5+ 标记实验/24 稳定）；esc() 前后端两处重复实现待合
   - 面板 JS 刷新加指数退避
   - ~~watchdog launchd 权限~~ 已修（tmux 模式，见 watchdog 节）
9. ~~**阻塞：闲鱼 supervisor 污染 adapter stdout（2026-07-26 Phase B）**~~ 已由 `3a430e5` 修复：进度事件走 stderr、stdout 只保留终态 JSON；01 控制面 job 已实证成功。
10. ~~**阻塞：02 长 SKU 超时后恢复失败**~~ 恢复与 360s 硬超时均已处理，但**业务验证仍未绿**：`1684fe9` 已完成 fail-closed 安全恢复，`6a83abe` 把纯 dry-run 预算调至 720s，02 单次复验越过 360s 后于约 605.4s 落 `VERIFICATION_FAILED` 且安全恢复。`26aa9b1` 已关闭强退/整段重跑路径并补失败 step，但尚未再次碰机验证；不得把部署成功写成 2x5 业务成功。
11. ~~编号冲突~~ 已解决（2026-07-24 20:01）：飞书 02/03 编号是 07-13 旧数据，已按 serial 锚定改正为 02=REPLACE_SERIAL_02（棕色手机）、03=REPLACE_SERIAL_03（三店），与 seed 的 07-22/07-24 实证一致
12. `/control/v1/devices` 公开视图不含 routingProfile（排查要看 control.db 或 query-routing.mjs）
13. **watchdog 实际驱动者是临时终端循环（2026-07-27 发现）**：launchd `com.xhs.scout-watchdog` 因 macOS TCC 拒绝执行 Desktop 下脚本已被禁用（`.plist.disabled`），当前靠一个手工 `while true; do watchdog.sh; sleep 1800; done` 终端进程（s009 会话）驱动——终端一关 watchdog 就停。待办：把脚本移出 Desktop（或给 bash 授 Full Disk Access）后恢复 launchd 托管。

## 工具

- `query-routing.mjs`（Windows `C:\Users\Public\xhs-registry\`）：只读 dump control.db 的 routing_json
- 审批 API：`GET /api/approvals/pending`、`GET /api/approvals/recent?limit=N`、`POST /api/approvals/:jobId/(approve|deny)` body `{actor, reason}`
- SSH 到 Windows：`ssh xhs-windows`，远程默认 PowerShell；curl 要用 `curl.exe`；复杂命令用 `powershell -NoProfile -EncodedCommand <base64(utf16le)>`

## 启动 Kimi 的正确姿势（避免 EDIT_OUTSIDE 假卡死）

```bash
cd /Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-windows
kimi --add-dir /Users/a1234/Desktop/Coding/xhs-registry
```

## 接手 FAQ（冷启动评审 2026-07-25 后补）

- **生产路径裁决**：控制面 job + 审批闸是权威入口（Phase 3 起）。task-runner/dashboard 是打过仗的历史主力（31 条真评论实证），仍可用但新链路一律走控制面。首例控制面真评论 2026-07-24 已发出
- **dashboard 17900**：**废弃**（旧 watcher 时代面板，不拉起）。人机入口唯一 = registry:17930 面板
- **日常任务实况**：当前 4 机**没有**在跑评论/养号（activeLeases=0，业务刚点火）。「不停工」铁律是建设期原则；按北极星路线从「小步真跑」每天 2-3 条真评论起步。live 状态一律查 API 不信文档日期
- **共享账本 xhs-agent-progress.md**：**废弃**（停在 revision 11 / 07-22）。新真相三件套：本 PROGRESS.md + 知识库 + watchdog/reports/
- **审批通道日常**：手机 registry 面板（tailscale + token），API/curl 备用；飞书只做身份与状态同步，不做审批
- **v1.2 调度内核**：未实现，纯 backlog。scout 选机暂无 cooldown 子句，v1.2 落地时按设计文档对接点扩展
- **secret 明文**：本地单人环境的有意取舍（飞书 base token、registry token 均在私有 tailnet/个人 Base 内），接手 agent 不当事故处理；若仓库要公开再统一治理
- **目录噪音**：placement.mjs 已从本目录删除（与仓库逐字节一致的冗余拷贝）；query-routing.mjs 保留（Windows 探针工具）
- **知识库 category 裂缝**：设计想要 scope 类，实现只有 pitfall|recipe|unknown——scout 边界记录暂用 pitfall + `[scout-scope]` 前缀顶替，收敛方案待 v1.2 时一起定
- **P1 现状细分**：xhs 侧 48 条 constraint 可直接验证（证据在代码/配置）；xianyu/wechat 的 recipe 虽有 appliesTo 但 capability 仍 dependency_pending 且全库 0 条 steps——**能挂能力 ≠ 能回放**，这两 app 的 replay 验证等 PR#11/微信 operator 合入
- **身份字段以 serial 为锚**：alias 是槽位会变（02/03 已于 07-24 对调），昵称/机型跟 serial 走；seed 注释与飞书显示不一致时以 serial 对应为准
- **旧文档分层**：01/04/05/06/07 为 watcher 时代历史文档（含 17900 dashboard、共享账本协议），仅作参考；权威入口 = 本目录 AGENTS.md + PROGRESS.md + 仓库 AGENTS.md
- **多 agent 实时任务板（2026-07-25 决议：暂缓）**：不建协作总线类产品。设备占用看控制面 lease（准实时），任务状态看 git+知识库+watchdog（30min 粒度），并行纪律查 routing-table-v2。**启用触发条件**（满足其一）：常态 ≥3 agent 并行；或再次发生工单互撞。启用时用知识库 `[inflight]` 条目 + PATCH（零新基建），不另起产品
