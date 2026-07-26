# 交接：Agent 入口契约 + 闲鱼 01–04 验证战役

> **给接手 agent / 人**：本文是 2026-07-26 前后一轮会话的完整交接。  
> **先读顺序**：`AGENTS.md` → 本文 → `PROGRESS.md` → 知识库 `routing-table-v1` / `routing-table-v2`。  
> **最后更新**：2026-07-26 12:05 CST（01 已绿；02 审计恢复失败后仍隔离）  
> **仓库 HEAD（GPFS + origin + Windows + task-launch 已对齐）**：`75dc6a6e4a5b0cc886a1e4f5f8ec57b383e1e854`（分支 `agent/placement-entry-v1-1-20260724`；stdout 修复 `3a430e5`；审计恢复 `75dc6a6`）  
> **控制面**：Windows `17920`，当前 health `capabilities:17`、`activeLeases:0`

> **接手结果**：P0 lease 硬闸与 `xianyu.publish.full_draft_dry_run` 已落地。Gateway/XHS serve 在设备请求前校验 device+runtime 绑定 lease；旧直调只允许带原因的 lab bypass；退役 dashboard 默认返回 `423 LEGACY_ROUTE_BLOCKED`，production worker 不再用 audit 覆盖。`a982374` 修复 canary session action 路由后，01 单机 canary 与 01–04 四条可见 lease + 四路并发只读 `imeList` 均通过。Phase B 已从 01 正门起跑，但被 supervisor/adapter stdout 协议冲突阻断；未继续 02–04，最终 leases/pending 归零、无草稿或发布授权。

---

## 最新验收：四机控制面入口 Phase A（2026-07-26）

- **版本**：GPFS / origin / Windows / task-launch 全部对齐 `a982374075de6fff354bf4b7efc146d2ab884c40`。
- **修复**：session 内部 action 使用 `session_action` 路由语义，复用既有 lease、固定 session device、同机 action 串行、运行中禁止 release。
- **质量闸**：135/135 测试，check、secret scan、diff check 通过；独立 Kimi 复审 PASS。
- **01 canary**：`xiaowei.lab.raw / imeList` succeeded、vendor 10000、verification true；1 条 lease 可见并成功释放。
- **四机 barrier**：四个独立 actor 分别持有 01–04 四条可见 interactive lease，公开 device 映射无重复。
- **并发探针**：四个 `imeList` 从同一 barrier 发出，全部 HTTP 200 / succeeded / vendor 10000 / verification true；无审批、无 external effect、无串机。
- **清理**：四条 session 均在 `finally` 释放；最终 health 4 devices / 17 capabilities，`leases=[]`、`pending=[]`、无 quarantined device；22222 listener 正常且 transport lock 无残留。
- **registry 回归**：验收前发现 17930 因 `XhsDeviceRegistry StopOnIdleEnd=true` 被终止；已在 `install-registry-task.ps1` 固化 `-DontStopOnIdleEnd`，live task 改为 false 并恢复服务。
- **边界**：Phase A 只证明控制面入口、lease 隔离和共享传输可靠；没有进入 App、截图、输入、保存草稿或发布。闲鱼 02 库存、03 物理在线、04 图片等属于后续 Phase B。

详细执行记录：`/Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-device-agent-routing-v1-1/docs/plans/2026-07-26-four-device-control-plane-acceptance.md`。

---

## 最新验收：闲鱼业务 Phase B 首个门槛（2026-07-26）

- **01 正门成立**：pinned `xianyu.publish.full_dry_run` job `job_066ae626-10c2-4a58-be93-64a27c1a07c3` / run `run_384f3930-0973-4507-a6e2-288bac461577`，可见 lease 精确绑定 01；无审批、无 external effect、`saveDraft=false`。
- **终态**：约 270 秒后 `failed / ADAPTER_INVALID_JSON`；控制面 restoration=`ok:true`，lease 自动释放，pending=0。
- **确定性根因**：`createStepSupervisor.emit()` 用 stdout 输出逐步 JSON 事件；`command-runner.mjs` 把完整 stdout 当作一个 JSON 文档解析。full flow 的多段 JSON 与 runner 单文档契约冲突。
- **安全边界**：按 Phase B 计划在首个失败门槛停止；02/03/04 与四机业务并发均未提交，草稿保存能力未提交/未批准，最终发布从未授权。
- **下一步**：修复 stdout framing（建议 supervisor 事件走 stderr/专用事件通道，终态 stdout 保持单 JSON），补协议回归测试，独立验收并部署后从 01 重跑。不要把这次结果误判为设备离线或库存/图片失败。

### Phase B 后续进展

- **stdout 修复已部署**：commit `3a430e5a622940971c7ee8a7b12a56fd3c8615a7`；supervisor/evidence-soft-fail 改走 stderr，新增 stdout 回归测试。全量 136/136、check 51/51、secret scan 通过；Mac/origin/Windows/task-launch 对齐。
- **01 已绿**：retry job `job_58f19bdd-0711-483e-8f0a-1f5097c59420` / run `run_34211e4b-eb72-4d73-ac73-2fc7acb8380a` succeeded，verification/restoration true，lease/pending 归零。
- **审计恢复已部署**：commit `75dc6a6e4a5b0cc886a1e4f5f8ec57b383e1e854` 新增 `job recover`，恢复只能锚定原 `recovery_required` job，以公开可见 `kind=recovery` lease 调用原 adapter.restore；只有验证 `ok=true` 才事务式清隔离。timeout 也会等待子进程退出后才进入 restoration。全量 141/141、check 52/52、secret scan 通过；四处部署提交一致。
- **02 仍隔离**：唯一一次恢复 key `recover-75dc6a6-job-aad-1` 于 04:00:13Z 开始，现场抓到 recovery lease 精确绑定 02 与原 job；04:00:17Z 返回 `RECOVERY_FAILED`（cause `RESTORATION_FAILED`）。started/failed 事件已落库，lease 已释放，02 online=true / quarantined=true。
- **证据缺口**：Xianyu adapter.restore 当前只返回 `{ok: boolean}`，未把 `discard-dry-run` 的 `step` 写入恢复事件或 evidence，因此现有审计只能确认“未验证安全页”，不能区分 `not-on-publish-compose`、`close-button` 或关闭后未回 MainActivity。
- **禁止动作**：不要换新幂等键盲重试，不要直接写 control.db 或调用内部 `clearDeviceQuarantine`。先补恢复诊断证据，再按具体页面状态设计并验收安全恢复。
- **未执行**：03、04、四机业务并发、保存草稿、最终发布。

详细执行记录：`/Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-device-agent-routing-v1-1/docs/plans/2026-07-26-xianyu-phase-b-business-acceptance.md`。

---

## 0. 三句话给接手人

1. **正道 = 控制面**（`job submit` / `session acquire` + lease）。直连 gateway / 临时 `_*.mjs` 能跑通，但**占用对系统不可见**——这次验证就踩了。
2. **文档/知识库是软约束**：agent 默认不先查库；**硬闸**才能让他们走正道。
3. **闲鱼草稿主链已可用**（supervisor + 配方 + vision 安全闸脚手架）；**01 全流程成功过**；**02 库存 40 未解**；**03 曾 ADB 离线**；**04 图片校验不稳**。目标「1–4 全绿」未闭环。

---

## 1. 本次战役：流程是怎么走的

### 1.1 目标（用户）

- 闲鱼「发闲置」标准草稿 dry-run：文案 → 图 → 规格（键入）→ 价库 99/10 → 包邮 → **存草稿**（永不发布）
- Live 监控/恢复（supervisor），不要死脚本事后复盘
- 吸收 visual-grounding-poc L1（安全闸 + resolve dry-run）
- 验证设备 **01–04** 能跑；接入没问题就继续验到成功

### 1.2 实际执行路径（旁路，非正道）

```
Mac agent
  → ssh xhs-windows
  → node C:\Users\Public\xhs-registry\_xianyu-full-one.mjs <serial> <alias>
       → GatewayOperator({ serial }).start()     // 直连 ws://127.0.0.1:22222
       → publishDryRun(op, plan)                 // xianyu-operator.mjs
       → createStepSupervisor 分步：open / images / description / sku / freight / saveDraft
       → 写 C:\Users\Public\xhs-registry\_full-0x.json
```

| 项目 | 实际 | 规定正道 |
|------|------|----------|
| 入口 | 直连 GatewayOperator | job submit / session acquire |
| lease | **未申请** | 必须 acquire + heartbeat + release |
| 审批 | 未走（dry-run） | R2+ 真外发才走人审 |
| 主眼 | a11y 语义 dump | 同左；vision 仅辅助 |
| 部署 | GPFS git push → Windows pull → task-launch.json gitCommit → 重启 CP | 同左（AGENTS 部署流程 3b） |

### 1.3 设备锚点（serial）

| alias | serial | 备注 |
|-------|--------|------|
| 01 | `REPLACE_SERIAL_01` | 全流程成功过 |
| 02 | `REPLACE_SERIAL_02` | 库存字段顽固残留 40 |
| 03 | `REPLACE_SERIAL_03` | 战役中期 ADB 离线；xiaowei **adb -P 5038** 上可能看不到 |
| 04 | `REPLACE_SERIAL_04` | 图校验/编辑页残留不稳 |

图源 staging：`XianyuFull4`（`xf4_a.png` / `xf4_b.png`），SHA 见 runner；推图请用 **adb port 5038**（`_stage-xf4-port.mjs`），默认 5037 常为空。

### 1.4 关键代码位置

| 路径 | 作用 |
|------|------|
| GPFS `xhs-device-agent-routing-v1-1/scripts/xianyu-operator.mjs` | 主流程、supervisor、SKU/图/草稿 |
| `scripts/vision-safety.mjs` | 空 label / 黑名单 / region / 指纹 |
| `apps/vision/` | `vision.resolve_tap_dry_run`（lab_only） |
| `apps/xianyu/` | capabilities + adapter |
| Windows `C:\Users\Public\xhs-registry\_xianyu-full-one.mjs` | **临时旁路 runner**（无 lease） |
| Windows `C:\Users\Public\xhs-registry\_stage-xf4-port.mjs` | 5038 推图 |
| 文档 `docs/xianyu-publish-dryrun.md` | 标准草稿 + Live supervisor 说明 |
| 正道入口 `docs/agent-entry.md` | job / session 必读 |

---

## 2. 遇到的问题 / 卡点

### 2.1 入口与占用（系统级，最高优先）

| 现象 | 原因 | 影响 |
|------|------|------|
| 4 台机被点，面板 `lease:null`、`leases:[]` | 旁路不走 CP | 人/其他 agent **以为空闲**，互撞 |
| Hermes 等 agent「乱走」 | 文档正道 vs 旁路都能碰机 | 入口不清晰 = 软约束失效 |
| 知识库写了很多 agent 仍不先查 | 无硬闸、冷启动未强制 curl | 写再多也不等于会遵循 |

### 2.2 闲鱼业务卡点

| 机/点 | 症状 | 根因摘要 | 状态 |
|-------|------|----------|------|
| 通用 | 规格点 chip → 蓝色变湖蓝色 | 应用联想 | ✅ 改为只键入 EditText+ENTER |
| 通用 | 价格 99→9 | 同键 debounce | ✅ `APP_NUMPAD_SETTLE_MS=450` |
| 通用 | 批量确定关 sheet | 点了中间确定 | ✅ 右下角键盘确定 |
| 并发 | 04 截图 ENOENT / 串读路径 | 共享截图目录竞态 | ✅ `_gwshot_<serial>` + fail-soft |
| 02 | SKU 后三连 BACK 回桌面 | cleanup 过激 | ✅ 无下一步时先 scroll |
| 02 | `sku-price-stock-coverage-unverified` filledRows=0 | 合并 label 变体 / 库存其实是 40 | ✅ 诊断 dump；覆盖逻辑放宽；**库存写入仍失败** |
| **02** | **库存 EditText 一直 `40`，期望 `10`** | DEL/长按/位数清/小薇覆写均无效 | ❌ **未解**，需探针 sheet 控件 |
| 02/04 | `save-draft-button-missing` | 顶栏只有 `草稿箱·N`/`发布`，无「存草稿」 | ⚠️ 关窗对话框兜底；仍不稳 |
| 03/04 | `images-unverified` / album-selector-missing | 校验过严；重试落在 `1/2` 编辑页 | ⚠️ resume 完成/坐标兜底；04 仍偶发 |
| 03 | gateway not reachable | ADB 无设备 | ❌ 需物理重连 |
| adb | `adb devices` 空 | 小薇用 **5038**，不是 5037 | ✅ 记录；stage 用 port 脚本 |

### 2.3 Vision「图→坐标」

| 层 | 状态 |
|----|------|
| vision-safety 规则模块 | ✅ 已合入 |
| xianyu 部分接入指纹/闸 | ✅ |
| capability `vision.resolve_tap_dry_run` | ✅ 第 16 个 cap，**lab_only**，默认只 resolve 不 tap |
| 主验证链用 vision 定位 | ❌ **未用**；主眼仍是语义 dump |
| Mac visual-grounding-poc OCR 上 Windows | ❌ 未部署进生产路径 |

---

## 3. 已解决什么（可继承资产）

### 3.1 提交序列（节选，自新到旧相关）

- `e27421a` — `*unverified*` 计为总体失败（修假绿）
- `8f9f42d` … `af2a343` — 02 库存清空多策略（**仍未根治 40**）
- `f972ffa` / `67afc6e` / `995c28f` — 图相册/编辑页 resume、校验
- `665c039` — 拆分 a11y 价库覆盖
- `db1df8d` — vision-safety + vision adapter
- `3882bfc` — live supervisor + fail-soft evidence
- `756fae0` — 标准草稿 capability 固化（更早）

### 3.2 行为配方（务必保留）

- 规格：**只打字**，不点推荐 chip  
- 数字键盘：**≥450ms** 键间隔；批量确认 **右下角**  
- 包邮：多行 a11y 用 `freightOptionTarget`  
- 存草稿：找「存草稿」；没有则关窗对话框找保存类；**永不点发布**  
- SKU 无「下一步」：scroll，**禁止三连 BACK**  
- 证据：fail-soft；并发目录隔离  
- ADB 推图：**`-P 5038`**（xiaowei）

### 3.3 验证结果快照（战役末）

| 机 | 结果 |
|----|------|
| 01 | ✅ 全链路成功（含存草稿）约 6–7min 量级 |
| 02 | ❌ 库存 40 + 存草稿按钮缺失 |
| 03 | ❌ 离线 / 未稳定复验 |
| 04 | ⚠️ SKU/包邮/草稿曾成功；图片 verified 不稳（旧逻辑曾假绿，已修） |

---

## 4. Agent 入口：以后怎么走（接手必守）

### 4.1 原则

```
文档/知识库 = 地图（软）
控制面      = 大门（硬）
旁路能跑通  = 技术债，不是正道
验收查正门  = 无 lease 操机 = 任务未完成
```

**正道 = 控制面**，不是「多读几篇 md」。

### 4.2 每次进场三问（答不出不准碰机）

1. 我走的是 **job** 还是 **session**？（不是 → 停）  
2. `GET /control/v1/leases` 或面板上 **能不能看见我占的机**？  
3. 我调的 **capability id** 是哪个？（不是临时无名脚本）

### 4.3 正道命令骨架

```bash
# 只读探路（不占机）
node control-plane/devicectl.mjs --ssh xhs-windows health
node control-plane/devicectl.mjs --ssh xhs-windows leases
node control-plane/devicectl.mjs --ssh xhs-windows route plan \
  --actor <you> --capability <cap-id>

# 交互 / 探针：必须 lease
node control-plane/devicectl.mjs --ssh xhs-windows session acquire \
  --actor <you> --capability <cap-id> \
  --device <deviceId>   # 或 placement slot
# … 心跳 ≤20s …
node control-plane/devicectl.mjs --ssh xhs-windows session release \
  --session <id> --token <token>

# 业务/验证：优先 job（CP 自动 lease）
node control-plane/devicectl.mjs --ssh xhs-windows job submit \
  --actor <you> --capability <cap-id> \
  --idempotency-key <unique> \
  --params '<json>'
```

详情：`xhs-device-agent-routing-v1-1/docs/agent-entry.md`。

### 4.4 明确禁止（除非环境变量显式旁路且书面记录）

- 无 lease 的 `new GatewayOperator({ serial }).start()`
- 无登记的 `_xianyu-full-one.mjs` 式四机并行干跑
- 默认 adb 5037 当生产推图（应用 5038）
- 点「发布」/支付/外发（R2+ 只提交不自批）
- 批量杀 node、写 control.db

### 4.5 冷启动仍要读（软，但验收会查）

| 顺序 | 内容 |
|------|------|
| 1 | 本目录 `AGENTS.md` |
| 2 | **本文 HANDOFF**（入口 + 战役状态） |
| 3 | `PROGRESS.md` |
| 4 | 知识库 `routing-table-v1` / `routing-table-v2`：`ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/api/knowledge'` |
| 5 | 动手前先向人汇报：状态 / 悬挂任务 / 下一步；**确认前不改** |

### 4.6 谁干什么（路由摘要）

| 类型 | 默认 |
|------|------|
| 验证 / dry-run 复验 | **MiMo**（`mimo-ro run`） |
| 修代码（库存/图/入口硬闸） | GLM / Grok |
| 设计入口契约、验收、运维 | Kimi |
| R2 审批 | **人** |

注意：让 MiMo 跑验证时，应让它 **submit job / acquire session**，不要复制旁路 runner。

### 4.7 待建硬闸（接手优先工程，按序）

| 优先级 | 项 | 说明 |
|--------|----|------|
| **P0** | GatewayOperator / lab 操机要求 lease token | 无 token 拒绝 start；开发用 `XHS_ALLOW_BYPASS=1` 显式开 |
| **P0** | 旁路 runner 加 acquire/release 包装 | 在 full_draft capability 未完成前的最小占用可见性 |
| **P1** | capability `xianyu.full_draft_dry_run` | 单 job 跑完整草稿链，MiMo 只 submit |
| **P1** | 验收项「正门」 | watchdog/Kimi：无 lease 的成功 = 不合格 |
| **P2** | ENTRY 一页进 AGENTS 置顶 | 三问 + 禁止清单 |
| **P2** | vision 仅作 dump 失败时导航兜底 | 仍 lab 安全闸，不替代主链 |

---

## 5. 接手后建议任务清单

### 立刻（业务未闭环）

1. **重连 03**（确认 `adb -P 5038 devices` 有 `REPLACE_SERIAL_03`）  
2. **02 库存探针**：批量 sheet dump 全部 EditText/可点节点；判断 `40` 是真输入框还是只读投影；必要时逐行改库存  
3. **04 图片**：完成页 settle + 媒体计数；编辑页无「完成」label 时坐标是否打中  
4. 验证时 **串行 + session/job 占机**，禁止再无 lease 四机并行  

### 入口工程（与业务并行）

1. 实现 P0 lease 硬闸  
2. 收 full_draft capability  
3. 把本文「三问」写进 `AGENTS.md` 顶部 10 行内  

### 留痕

- 新坑 → 知识库（`appliesTo` + `verifyMode`）  
- 状态变了 → 改 `PROGRESS.md`  
- 文档没写的人脑问题 → 报告里「待问项」  

---

## 6. 关键端点速查

| 什么 | 哪里 |
|------|------|
| registry | Windows `127.0.0.1:17930` |
| 控制面 | `127.0.0.1:17920` |
| leases | `GET /control/v1/leases` |
| 知识库 | `GET /api/knowledge` |
| 小薇 gateway | `ws://127.0.0.1:22222`（**应经 CP**） |
| 小薇 adb | `…\xiaowei_android\tools\adb.exe -P 5038` |
| 代码真源 | GPFS `xhs-device-agent-routing-v1-1` |
| Windows 运行副本 | `C:\Users\Public\xhs-routing-v1-1` |
| 旁路产物 | `C:\Users\Public\xhs-registry\_full-*.json` |

---

## 7. 待问项（人脑）

1. 闲鱼当前版本顶栏是否已取消「存草稿」、只留「草稿箱·N」？成功路径应以关窗保存还是别的入口为准？  
2. 02 批量库存 40：是否账号/模板默认库存？是否允许验证阶段接受非 10？  
3. 是否批准 **无 lease 禁止 GatewayOperator** 作为硬规矩（开发机显式 bypass）？  
4. full_draft 收 capability 的 risk 档与 restore 策略（单会话 vs 多 job）是否按「单会话 full_dry_run」定死？  

---

## 8. 给接手 agent 的开场白模板

```
我已读 AGENTS.md + HANDOFF-2026-07-26-agent-entry-xianyu-verify.md + PROGRESS.md。

系统状态：
- CP HEAD 应对齐 e27421a+；capabilities 16；lease 应用作占用真相
- 闲鱼草稿主链在 xianyu-operator；vision 仅 lab_only
- 01 曾全绿；02 库存 40 未解；03 需确认在线；04 图校验不稳

悬挂：
- P0 入口硬闸（lease）
- 02 库存 / 04 图 / 03 在线复验
- full_draft capability 未建

下一步建议：
1) 查 leases + adb -P 5038 devices
2) 按你确认的优先级：入口硬闸 或 02 库存探针
确认前不改代码、不直连四机。
```

---

## 9. 2026-07-26 14:06 增量交接：02 强退重跑已修，业务仍未绿

- 生产锚点已更新为 `26aa9b1d486d6bd856c7f5dd9f6923977490a37e`；GPFS、origin、Windows、`task-launch.json.gitCommit` 已对齐。控制面/registry 健康，4 devices、17 capabilities、0 leases。
- `6a83abe` 将纯 `xianyu.publish.full_dry_run` 超时从 360s 调为 720s，并减少 2x5 SKU 冗余 dump/IME 切换。
- 02 仅复验一次：job `job_463a2917-8e84-4311-ab7e-5e5e918dbd23` / run `run_352d6983-e411-4090-8b52-0fa45efaa433`，约 605.4s 后 `VERIFICATION_FAILED`；restoration 成功，未保存/未发布、无隔离、lease 归零。此结果只证明旧 360s 硬超时被越过，**不代表 2x5 通过**。
- 用户现场观察到中途强制退出并从头来。静态根因：开场重复启动、SKU child page 被宽泛 compose 指纹误判、SKU `maxAttempts:2` 整段重跑。`26aa9b1` 已关闭上述路径，并补顶层失败 `step`；171/171 + check/secret scan、独立 Kimi 复审均 PASS。
- 本轮部署后没有提交第二个设备 job。下一位必须先征得人确认，再只在 02 提交一个新 job；不得直接扩到 03/04。
- 知识库：`xianyu-02-no-force-restart-20260726`，`verifyMode=human`、`needsEngineer=true`。

---

## 10. 2026-07-26 14:29 增量交接：防重跑获真机证据，恢复对话框缺口已补

- 生产锚点：`309e5457ec0e852cfbff5410544c1f551f777cfd`，GPFS/origin/Windows/task-launch 对齐；172/172 + check/secret scan + 独立 Kimi PASS。
- 02 仅提交一次 job `job_89f6a123-b4ff-445a-b944-dd77961a15ab` / run `run_be8d9781-a021-4110-be66-092a49945ecc`。约 119.6s 停在 `sku:sku-not-on-compose`，没有强退后整段重跑；此 job 业务失败记录仍保留为 `recovery_required`。
- fresh `inspection_279` / SHA `7a65439b…` 确认 `discard-dialog` 0.99。`309e545` 支持恢复启动时已在对话框，只严格点击唯一左下“不保存”；第一段恢复按设计仍保持隔离。
- fresh `inspection_284` / SHA `d8ceefca…` 确认 `main-safe` 0.98；最终 zero-action recover：`already-safe-main`、`safeStateVerified=true`、`quarantineCleared=true`。02 在线，lease 归零，未存草稿、未发布。
- 下一个工程问题是 `sku:sku-not-on-compose`；先查本 run 的步骤/语义证据，禁止直接提交第三个 02 job。

---

## 11. 2026-07-26 19:04 增量交接：02 已绿，03 确认为物理未连接

- 02 标准 no-save/no-publish 全链已经通过：job `job_f0cbea74-b4e5-46f6-8963-fe3f1157d1d5` / run `run_cedfb09a-d5a3-4210-95d9-57cc8b7151dd`，2x5 SKU、统一价 ¥12.34、每规格库存 2、包邮均完成，verification/restoration 均 true，最终无 lease、无隔离。
- 03 pinned open job `job_d3bd9407-9dec-41d7-a497-105dad43a9a8` 首步即失败并隔离。部署 `c35db20`、`45aba9f` 后，审计型只读 recovery inspection 明确返回 `GATEWAY_DEVICE_PROBE_FAILED`；不含 runtimeId/原始错误文本。
- 全局小薇网关并未故障：01 的只读 `xiaowei.device.list` job `job_69d4c15a-4988-4d45-a101-aea8c86812d2` succeeded、vendor 10000，lease 自动释放。
- Windows PnP 只读比对显示 01/02/04 均有 present `USBDevice/OK`，03 没有 present 记录；03 的历史 PnP 记录均为 `Problem 45`。官方 `pnputil /scan-devices` 重扫后仍只有 3 台 Android-like 设备。
- **因此当前阻塞是 03 现场物理连接，不是闲鱼页面、控制面、lease 或 22222 全局服务。** 需要人现场重新插拔 03，检查供电/线材/USB 口并保持手机解锁；禁止远程批量重启 USB hub。设备重新枚举后，从原 job 做 fresh recovery inspection，安全恢复/清隔离，再按 open→full 顺序验证 03。
- 当前生产锚点：`45aba9f32040ffc6b4043d8ecc186e5e8c0d2525`，GPFS/origin/Windows/task-launch 四点一致；控制面健康 4 devices / 17 capabilities / 0 leases，03 隔离，01/02/04 未隔离。

---

*文档结束。活干了没留痕 = 未完成；无 lease 操机 = 入口违规。*
