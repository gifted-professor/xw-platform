# Codex 执行 Plan：飞书→闲鱼丝滑化 + 坑④ SKU 解锁

> **给谁**：Codex（执行者）  
> **派工角色**：Fix（改代码/部署）+ 有限真机验证  
> **日期**：2026-07-28  
> **原则**：**丝滑优先**——安全闸无感、热路径短；不把流程切成一堆预检和确认  
> **证据来源**：live agent-entry、PROGRESS.md、Hermes 实跑卡点、Grok 只读审阅裁决  

---

## 0. 你是谁、你在哪、先读什么

### 0.1 项目两仓（不要搞混）

| 仓 | 路径 | 职责 | 改动规则 |
|----|------|------|----------|
| **A. xhs-registry**（本仓） | Mac `/Users/a1234/Desktop/Coding/xhs-registry` | 编排脚本、fixture、飞书同步、知识 seed、watchdog、Explorer ops | 可改；git main；可 commit |
| **B. xhs-device-agent**（路由/operator） | **生产真源** GitHub `gifted-professor/xhs-device-agent` **`main`**；Windows 部署 `C:\Users\Public\xhs-routing-v1-1` | 控制面、adapter、`scripts/xianyu-operator.mjs`、capabilities | **只在 clean `main` worktree 改**；禁止在 GPFS 脏长分支上直接修生产 |

### 0.2 当前部署锚点（开工先复核，勿盲信本文数字）

```bash
# live 入口（唯一权威状态）
ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/agent-entry.md'

# Windows 生产码
ssh xhs-windows 'Set-Location C:\Users\Public\xhs-routing-v1-1; git rev-parse HEAD; git branch --show-current; git status -sb'
ssh xhs-windows 'Get-Content C:\Users\Public\xhs-agent-control\task-launch.json'
# 要求：gitCommit == 完整 40 字符 HEAD；分支 main
```

本文起草时（2026-07-28 ~09:44 CST）观测到：

- Windows：`main@c2a44c3511385d846a2e6ce52fbee10d24fe7f27`，task-launch 一致  
- 设备：01/02/03 **ready=yes lease=free**；04 **ready=no**（`VERIFICATION_FAILED`，未隔离）  
- `activeLeases=0` `runningJobs=0` `pendingApprovals=0`  
- GPFS checkout 仍停在废弃长分支 `agent/placement-entry-v1-1-20260724@953d187` 且**工作区脏** → **禁止在那里改生产代码**

### 0.3 进场三问（答不出不准碰机）

1. 本次用 **job** 还是 **session**？  
2. lease 能否在 `GET /control/v1/leases` 或面板看见？  
3. capability id 是什么？

### 0.4 正道命令骨架（Mac 跑，cwd = 路由仓 clean checkout）

```bash
# 推荐：新建 clean worktree，不要用脏 GPFS 长分支
# 例：git worktree add /tmp/xhs-main main && cd /tmp/xhs-main

node control-plane/devicectl.mjs --ssh xhs-windows route plan \
  --actor codex-silk --capability xianyu.publish.full_dry_run

node control-plane/devicectl.mjs --ssh xhs-windows job submit \
  --capability <id> --actor codex-silk --idempotency-key <unique> \
  [--device <devId>] --params '<json>'

node control-plane/devicectl.mjs --ssh xhs-windows job status --job <jobId>

node control-plane/devicectl.mjs --ssh xhs-windows session acquire \
  --actor codex-silk --capability <id> --alias <01-04>
```

**硬红线**：

- 禁止无 lease 的 `GatewayOperator` / 临时 `_*.mjs` 四机干跑  
- 禁止 `XHS_ALLOW_BYPASS=1` 作为验收证据（仅允许**受审计 lab 诊断**，且事后必须 restore）  
- 禁止写 `control.db`、禁止 agent 调 approve/deny  
- 禁止真发布 / 存草稿（`saveDraft` 必须 false；full_dry_run only）  
- 验证码 / 风控 / 登录墙 → 立即停  

### 0.5 若执行「卡住像入口坏了」——先查这张表（Hermes 高发）

| 症状 | 真正原因 | 正确动作 |
|------|----------|----------|
| `Repository commit mismatch` | `task-launch.json.gitCommit` 不是完整 40 字符 HEAD | 改全 hash + 重启 `XhsDeviceControlPlaneV1` |
| `device_busy` / lease 看不见 | 无 lease 旁路 或 上一个 session 未 release | 查 leases；release/cancel；禁止裸 22222 |
| `ready=no` 脚本直接退出 | 客户端把 registry ready 当硬闸 | 见 §3 分级；控制面往往仍接 R0/R1 |
| `NO_ELIGIBLE_DEVICE` | routingProfile 不含该 alias/capability | 查 `config/control-plane.devices.json`，别盲重试 |
| ssh 进 Windows 后 `&&` 报错 | 远端默认 PowerShell | 用 `Set-Location; cmd1; cmd2` 或 `cmd /c` |
| curl JSON body 引号炸 | PowerShell 吃引号 | scp 临时 json 再 `curl.exe --data-binary @file` |
| GPFS 改了 Windows 没变 | 未 pull / 未改 task-launch / 未重启控制面 | 部署清单 §7 |
| Explorer dump/tap「全废」 | lab 无 lease + Flutter a11y 稀 + 像素 tap | 正道 session/job；生产用 operator snapshot 路径验证 |
| 改完 operator 测不过 | 测的是 Mac 脏树不是 Windows main | 只信 Windows HEAD + 控制面 job |

**入口健康最小集（任何 phase 失败先跑）**：

```bash
ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/api/health'
ssh xhs-windows 'curl.exe -s http://127.0.0.1:17920/control/v1/health'
ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/agent-entry.md'
ssh xhs-windows 'curl.exe -s http://127.0.0.1:17920/control/v1/leases'
```

---

## 1. 目标 / 非目标

### 1.1 目标（DoD）

1. **业务热路径**：飞书 SKU → 闲鱼 `full_dry_run` **单机成功**至少 1 次（no-save、no-publish），SKU 步不再 `sku-select-all-missing`。  
2. **诊断丝滑**：控制面 job 的 `result` **保留脱敏 SKU 诊断**（`step` + `selectAllMiss` markers 等），无需 bypass 才能排障。  
3. **编排减法**：`ops/feishu-to-xianyu.mjs` 预检合并、ready 分级、dry-run 语义诚实；跨机失败局部化。  
4. **04 不永久锁死**：在线 + 未隔离 + lease 空时，可用恢复路径刷绿或允许 R1 重试策略落地。  
5. **留痕**：知识库 + PROGRESS 更新；`verifyMode` 合法可导入。

### 1.2 非目标（本 plan 不做）

- 真发布 / 真存草稿 / R2 审批外发  
- 凭证大扫除与公开仓库治理（可记 backlog）  
- 完整重写 Explorer 为完美产品（只做「session 一次 + 连续操作」最小闭环若时间够）  
- 把 watchdog/Kimi 额度恢复当成发布门禁  
- 在 GPFS 脏长分支上继续堆 commit  
- 全局「再加更多 preflight」

### 1.3 成功度量

| 级别 | 标准 |
|------|------|
| **L_min（必须）** | 01 或 02 单机 `xianyu.publish.full_dry_run`（飞书 DX1488-100 同类 fixture 或 campaign fixture）`succeeded`，SKU 过，restoration/verification true，lease 释放 |
| **L_good** | job result 含脱敏 `selectAllMiss`/step 诊断字段；feishu 脚本 `--dry-run` 零手机写入 |
| **L_stretch** | 01+02（或 +03）并发绿；04 经 recover/R0 后 ready 或成功重跑；Explorer session 最小闭环 |

---

## 2. 背景事实（执行者必须内化）

### 2.1 已解决（不要重做）

| # | 卡点 | 状态 |
|---|------|------|
| 1 | adapter 白名单丢 description 三字段 | ✅ PR #18 @ `c2a44c3` |
| 2 | 多行描述 `\n` 被压空格 | ✅ PR #17；bypass 直跑 `desc-filled ok` |
| 3 | 07-27 campaign 4/4 full_dry_run 曾全绿 | ✅ 证明生产路径**可以**走通 SKU（gateway snapshot + bounds tap） |

### 2.2 未解决真阻塞

| # | 卡点 | 症状 | 裁决后的根因假设（按概率） |
|---|------|------|---------------------------|
| **P0** | 坑④ `sku-select-all-missing` | DX1488-100 三台 + 直跑失败 | **A（高）** 规格页→价库页导航/等待失败（诊断 `specsPage=true batchEntry=false`）；**B（中）** `findSkuSelectAll` 正则过严；**C（中）** 「下一步」点击无响应（Flutter/遮挡）；**D（低）** 整页 dump 空——与 4/4 绿历史矛盾，需证据才采信 |
| **P0-debug** | result 丢诊断 | control 只见 `output.{ok,step}` | adapter/控制面序列化裁剪 |
| **P1** | 04 ready=no | 未隔离，L1/snapshot 路由未覆盖 04 | 恢复策略，非「硬件坏了」 |
| **P1** | feishu 编排过碎 | 多次预检+SSH+push+ready 硬拦 | 脚本语义与顺序 |
| **P2** | 知识 seed 无法导入 | `verifyMode` 自由文本 | 改成枚举再 import |
| **P2** | Explorer 无真 lease | 预检后裸 22222 | 竞态；与生产 job 路径分开修 |

### 2.3 Hermes 意见 → 本 plan 最终裁决

| Hermes 观点 | 裁决 | 执行含义 |
|-------------|------|----------|
| 一次 submit、原子选机占 lease | ✅ 采纳 | 编排层减法；推图可暂留 Mac，但 **submit 前只做一次状态读** |
| 失败只停出事设备 | ✅ 采纳 | 禁止「全 fleet 清零再开」 |
| Explorer 一次 session + heartbeat | ✅ 采纳（P2） | 有时间做最小闭环；不挡 SKU |
| 异步留痕 | ✅ 采纳 | 知识库/截图不进热路径临界区 |
| ready=false 不能太松，要两级 | ✅ **部分采纳** | 见 §3 分级表；**不是**全面 hard-block |
| 04 要 force-stop 级 R0 | ⚠️ 改名 | 那是 **recover / main-safe / discard** 路径，不是只读 snapshot；snapshot 不能 force-stop |
| 保留 `--force` 只跳 ready | ✅ 迁移期保留 | quarantine/offline/真 lease 占用仍硬拦；长期目标：默认就不误拦 ready |
| 先统一效卫百分比 tap 再修 SKU | ⚠️ **证据优先** | 生产 `GatewayOperator.tap` **今天就是** `adb input tap` 像素；4/4 曾绿。先 dump 证据，再决定是否换 tap 实现；**禁止**无证据重写全栈 tap |
| UI dump 完全失败是坑④主因 | ⚠️ **可能夸大** | operator 用 gateway snapshot，不是裸 uiautomator XML；以 job 内 snapshot 是否含「下一步/全选」文案为准 |
| 多行描述会在完整链被 SKU 挡住 | ✅ 同意 | 描述已过；整链仍卡 SKU |

### 2.4 代码锚点（B 仓）

| 主题 | 文件 | 约略位置 |
|------|------|----------|
| SKU 主流程 | `scripts/xianyu-operator.mjs` | `fillSkuSpecs` ~2927+；下一步 ~3059–3094；`findSkuSelectAll` ~2029 |
| 全选正则 | 同上 | `/^全选[，,]/` **且** `/全选$/` —— 过严风险 |
| 生产 tap | `scripts/gateway-operator.mjs` | `tap()` → `input tap x y` |
| adapter 输出裁剪 | `apps/xianyu/adapter.mjs` | verify/restore 多处只回传 `ok/step` |
| 泄露单测红 | `control-plane/lib/command-runner.mjs` | ~112 仍塞 stdout/stderr snippet（安全契约；**排在 SKU 后或并行**） |
| 能力定义 | `apps/xianyu/capabilities.json` | `xianyu.publish.full_dry_run` R1；`xianyu.observe.snapshot` R0 |

| 主题 | 文件（A 仓） |
|------|----------------|
| 飞书编排 | `ops/feishu-to-xianyu.mjs` |
| 4 机并发参考 | `ops/conc4-full-dry-run.mjs` |
| 恢复 | `ops/recover-main-safe.mjs` |
| L1（过时） | `ops/l1-patrol.sh` 写死 01/02/04、旧 `/api/devices` |
| 知识 seed | `knowledge-seed-feishu-to-xianyu-20260728.json` |
| Explorer | `modes/explorer.md` + `ops/_explore-lib.mjs` |

### 2.5 关键 fixture / 商品

- 飞书 SKU：**DX1488-100**（5 尺码；颜色规则：单色不当维度）  
- 本地图：`tmp-imgs/DX1488-100/`  
- campaign 对照：`campaign/fixtures/0{1,2,3,4}-full.json`（多 `skip*`，与飞书「真图+多行描述」不同）  
- 成功对照：07-27 4/4 用的是 campaign 系 fixture，**不是**飞书 DX1488-100 —— 修 SKU 时要用**飞书同类 fixture**验收，避免假绿

---

## 3. ready / force / 恢复：分级契约（必须实现一致）

### 3.1 客户端（feishu-to-xianyu / conc4）提交前

| 条件 | 行为 |
|------|------|
| `online=false` | **硬拦** |
| `quarantined=true` | **硬拦**（指引 recover） |
| lease 被**其他 actor** 占用 | **硬拦**（`--force` **不得**跳过） |
| `ready=false` 且 `unresolvedFailure` 存在，且设备前台可能脏 | **默认**：先走 **自动恢复子路径**（§3.2）；恢复失败再硬拦 |
| `ready=false` 但 online + 未隔离 + lease 空 + 无 quarantine | **告警 + 允许 submit R0/R1**（控制面是权威） |
| `ready=true` | 直接 submit |

**`--force` 语义（保留，收窄）**：

- ✅ 允许跳过：registry `ready=false` 告警级拦截  
- ❌ 禁止跳过：offline / quarantine / **他人 lease**  
- 日志必须打印 `FORCE=ready-only` 及被跳过的检查项  

### 3.2 自动恢复子路径（给「上次 execution failed」的设备）

**不要**把 force-stop 塞进只读 `xianyu.observe.snapshot`。

顺序：

1. 若有关联 `jobId` 且状态允许 → `job recover` 或 `ops/recover-main-safe.mjs --job <id> --actor codex-silk`  
2. 无 job 可恢复 → 提交 **R0** `xianyu.observe.snapshot` **仅当 routing 含该 alias**；若 04 不在 eligible → **不要死循环 L1**；改用：  
   - session/job 下 `recover-main-safe` / discard 路径，或  
   - 临时给 04 开 snapshot routing（配置变更需备份 + 记录）  
3. 视觉/ focus 显示卡在 Flutter 子页 / 规格弹窗 → **lease 内** force-stop + relaunch 闲鱼（走已有 operator recover / startIdlefish 路径，**禁止**无 lease adb）  
4. 验证码/风控 → quarantine 标记路径 + **停 + 报告人**（不自动点）  
5. 恢复成功后可用任意成功 job 刷 `lastSuccess` → ready 转绿  

### 3.3 控制面权威

- **能不能跑**最终听控制面 accept/reject，不是 registry ready 文案。  
- registry ready 是**观测提示**（含 unresolvedFailure），用于编排决策，不是第二套权限系统。

---

## 4. 执行阶段（严格顺序）

> **丝滑版总序**：诊断一次 → 修 SKU → 诊断进 result → 编排减法 → 单机验收 →（可选）并发/04/Explorer  
> 安全契约泄露单测、watchdog、文档：**并行 backlog**，不挡 L_min。

---

### Phase 0 — 开工冻结现场（只读，30 分钟内）

**动作**：

1. 拉 live `agent-entry.md` + leases + health，记录 4 机表。  
2. 确认 Windows `main` HEAD == task-launch.gitCommit。  
3. **创建 clean worktree**（B 仓）：

```bash
# 在有 origin 的 xhs-device-agent 镜像上（不要用脏 GPFS placement 分支当写入点）
# 若只有 GPFS 脏树：先 fetch，worktree 出 main
cd /Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-device-agent-routing-v1-1
git fetch origin main
git worktree add /tmp/xhs-device-agent-main origin/main
cd /tmp/xhs-device-agent-main
git status   # 必须干净
```

4. 只读打开：  
   - `fillSkuSpecs` / `findSkuSelectAll`  
   - `apps/xianyu/adapter.mjs` result 形状  
   - `ops/feishu-to-xianyu.mjs` 预检与 `--force`  
5. 输出「Phase 0 报告」三行：live 表 / HEAD / 是否允许进入 Phase 1。

**禁止**：本 phase 改代码、submit job、bypass。

**出口**：Phase 0 报告完成。

---

### Phase 1 — 坑④ 证据采集（一次合规碰机，不修逻辑）

**目的**：在 **lease 可见** 的前提下，拿到「规格页 / 下一步 / 价库页 / 全选」节点证据，结束猜测。

**推荐路径（二选一，优先 A）**：

#### 路径 A — 控制面 job + 增强临时诊断（若已能从 evidence/日志拿到 nodes）

1. 选 **01**（ready=yes，streak 高）。  
2. 使用**已有**飞书 fixture 或 `campaign/fixtures/01-full.json` **先**确认 campaign 系是否仍绿：  
   - 若 campaign full 仍绿、飞书 fixture 红 → diff fixture（skuSpecs/描述/图）缩小根因。  
   - 若两者都红 → 全局 SKU 导航回归。  

```bash
cd /tmp/xhs-device-agent-main   # clean main
# 例：campaign 对照（params 来自 fixture 文件）
node control-plane/devicectl.mjs --ssh xhs-windows job submit \
  --capability xianyu.publish.full_dry_run \
  --actor codex-silk-p1 \
  --device <01的deviceId> \
  --idempotency-key "codex-silk-p1-campaign-$(date +%s)" \
  --params "$(cat /Users/a1234/Desktop/Coding/xhs-registry/campaign/fixtures/01-full.json)"
```

3. `job status` 直到终态；记录 `errorCode` / `step` / restoration。  
4. 若失败于 SKU：到 Windows evidence 目录找该 run 的 snapshot 文件（operator `skuDebugDump` / evidence）；列出含「下一步|全选|批量|规格|价格|库存」的 label。

#### 路径 B — session 探索（仅当 A 证据不足）

```bash
node control-plane/devicectl.mjs --ssh xhs-windows session acquire \
  --actor codex-silk-p1 --capability xiaowei.lab.raw --alias 01
# 必须：leases API 能看见
# heartbeat ≤20s
# dump/tap 走已有 ops，结束后 session release
```

**采集清单（必须填表）**：

| 字段 | 值 |
|------|-----|
| jobId / runId | |
| fixture 类型（campaign vs 飞书） | |
| 失败 step | |
| snapshot 是否为空 | yes/no |
| 是否出现 label「下一步」 | |
| 是否出现「批量设置价格和库存」/「取消批量设置」 | |
| 是否出现含「全选」的 label **原文** | 原文照抄 |
| 点击「下一步」后页面是否变化 | |
| 设备末态 package/activity | |
| restoration.ok | |

**决策树（Phase 2 用）**：

```
snapshot 空或无业务 label
  → 走 dump/transport 修复（gateway snapshot），暂缓正则放宽
有「下一步」但点击后仍 specsPage
  → 加强 wait / 二次识别 / 点击偏移 / 滚动后再点（fillSkuSpecs 导航）
已进价库页但无「全选」或原文不匹配正则
  → 放宽 findSkuSelectAll（有原文再改）
有「全选」且正则能匹配但仍 missing
  → bounds/tap 问题；评估 gateway tap 实现（含效卫是否支持非 input tap）
```

**出口**：决策树落到唯一主因分支；**禁止**同时盲改导航+正则+全栈 tap。

**设备清理**：job 应 auto restore；若 isolation/脏页 → `recover-main-safe`。  
**01 若曾 bypass**：本 phase 用正道 job open/recover 自清，不要手工当流程。

---

### Phase 2 — 修 `fillSkuSpecs`（B 仓 main 短分支）

**分支命名**：`fix/xianyu-sku-select-all-nav-20260728`

#### 2.1 按 Phase 1 主因最小改动

**若主因 = 导航/等待（最可能）**：

在 `fillSkuSpecs` 点「下一步」之后：

1. 轮询 snapshot（有界，如 5–8 次 × 600–1000ms），直到命中任一：  
   - `/取消批量设置/`  
   - `/批量设置价格和库存/`  
   - `/^全选/` 或改进后的全选匹配  
   - 或明确仍停在规格定义 markers  
2. 若见「批量设置价格和库存」入口 → tap + 再等。  
3. 仍失败 → 返回 **结构化**错误（见 2.2），**不要**假装找到全选。  
4. 可选：点「下一步」前再 swipe 确保按钮在视口（已有 swipe 重试可加强）。  

**若主因 = 全选 label 正则**：

- **必须先有原文**再改 `findSkuSelectAll`。  
- 放宽示例方向：接受裸 `全选`、`全选，未选中` 等；保持 fail-closed（多个全选则取最可能的一个并单测锁住）。  
- 加单测：旧 label + 03 历史变体 + 新原文。

**若主因 = tap 无响应且 bounds 正确**：

1. 先查效卫/gateway 是否已有 **非** `input tap` 的点击 API（百分比或 accessibility click）。  
2. **仅改 gateway-operator 的 tap 实现**或增加 `tapNode(node)` 优先走 clickable 无障碍动作；不要改所有业务坐标为魔法百分比。  
3. 用同一节点前后 snapshot 证明点击生效。  
4. Explorer `ops/tap.mjs` 可随后对齐，但 **验收以控制面 job 为准**。

**若主因 = snapshot 空**：

- 修 transport/snapshot 路径；SKU 业务逻辑免谈。  
- 记录是否 Flutter 特定页；评估语义树/效卫 dump 参数。

#### 2.2 结构化失败载荷（为 Phase 3 铺路）

`sku-select-all-missing` 返回至少：

```js
{
  ok: false,
  step: "sku-select-all-missing",
  implemented: true,
  expectedRows,
  dimResults,
  selectAllMiss: {
    markers: {
      specsPage: boolean,
      batchEntry: boolean,
      cancelBatch: boolean,
      nextOrPriceStock: boolean,
    },
    labelsWithSelectAll: string[],  // 最多 N 条，截断
    almostRelatedLabels: string[],  // 最多 N 条
    pageFingerprint: string | null  // 可选，短哈希或 pageType
  }
}
```

**脱敏**：不要账号、完整描述正文、手机号。label 可留 UI 控件短文案。

#### 2.3 测试

```bash
cd /tmp/xhs-device-agent-main
# 项目惯用测试命令（以 package.json 为准，例如）
npm test
# 至少保证 xianyu-operator / adapter 相关测试绿
node --test tests/xianyu-operator.test.mjs
```

#### 2.4 部署到 Windows（B 仓）

按路由仓 `AGENTS.md` 部署流程（摘要）：

1. push 短分支 → PR → **merge 进 main**（或用户允许的直接 main 流程）  
2. Windows：

```powershell
Set-Location C:\Users\Public\xhs-routing-v1-1
git checkout main
git pull
git rev-parse HEAD
# 编辑 C:\Users\Public\xhs-agent-control\task-launch.json
# gitCommit = 上面完整 40 字符
schtasks /end /tn XhsDeviceControlPlaneV1
schtasks /run /tn XhsDeviceControlPlaneV1
# 等端口
curl.exe -s http://127.0.0.1:17920/control/v1/health
```

3. 确认 health 200、无 commit mismatch。

**出口**：Windows HEAD 含修复；单测绿；进入 Phase 4 真机（Phase 3 可并行）。

---

### Phase 3 — job result 保留诊断（B 仓，可与 2 同 PR）

**问题**：adapter 把 operator 富输出压成 `{ok, step}`，排障被迫 bypass。

**改法**：

1. 读 `apps/xianyu/adapter.mjs` 中 full_dry_run / publish-dry-run 的 verify 与 result 映射。  
2. 在 **已有 output 白名单**中增加：  
   - `step`  
   - `selectAllMiss`（若存在）  
   - 可选 `dimResults` 长度与维度名（不要全量 dump nodes）  
3. 控制面 `result_json` 体积有界：单字段 string 截断，数组 cap。  
4. 单测：假 operator 输出含 `selectAllMiss` → job result 可读到 markers。  

**安全注意**：`command-runner.mjs` 的 stdoutSnippet 泄露是**另一契约**（测试要求失败时不泄原始细节）。  
- **本 phase 不要为了诊断去扩大 ADAPTER_FAILED 的 stdoutSnippet 暴露面。**  
- 诊断应走 **成功 JSON 结构化字段** 或 **bounded errorCode 字段**，不是裸 stderr。

**出口**：失败 job 用 `job status` 即见 SKU markers；无需 bypass。

---

### Phase 4 — 单机验收（L_min）

**设备**：优先 **01**（ready）；若 01 忙用 02。  
**禁止**：一上来 4 机并发。  
**禁止**：bypass 作为验收。

#### 4.1 对照跑（可选但推荐）

- campaign `01-full.json` 一次 → 期望 succeeded（回归）  

#### 4.2 飞书链路验收

```bash
cd /Users/a1234/Desktop/Coding/xhs-registry
# 先只预检+组装（见 Phase 5 dry-run 语义；若未改脚本，注意旧 --dry-run 会 push 图）
node ops/feishu-to-xianyu.mjs --sku DX1488-100 --aliases 01 --actor codex-silk-p4 --dry-run
# 确认 fixture 字段：description* / skuSpecs / images

# 实跑单机
node ops/feishu-to-xianyu.mjs --sku DX1488-100 --aliases 01 --actor codex-silk-p4
# 或手拼 devicectl submit 同一 fixture
```

**通过标准**：

- status=`succeeded`  
- 非 `sku-select-all-missing`  
- `restoration.ok=true` `verification` 过  
- `saveDraft` 未发生、未发布  
- lease 释放  
- `job status` 可见 step 级信息（Phase 3 后）  

**失败**：把 result 诊断贴回决策树；**只允许再改一刀**，禁止无限重跑同一幂等键。

---

### Phase 5 — 编排丝滑化（A 仓 `ops/feishu-to-xianyu.mjs`）

#### 5.1 热路径目标形态

```text
[一次] 读 agent-entry 设备表
  → 飞书取商品 + 下图（纯 Mac/飞书，不碰机）
  →（可选）phone-push 仅对「将 submit 的 alias」（需要写手机，必须可关）
  → 并行 job submit（控制面原子选机/占 lease/执行）
  → poll
  → 汇总（失败局部化）
```

#### 5.2 必须改的语义

| 项 | 现状 | 目标 |
|----|------|------|
| `--dry-run` | 仍 phone-push | **零手机写入**；只：飞书+本地下载+组装 fixture+打印预检 |
| 真要推图预演 | 无 | 新增 `--prep` 或 `--push-only`（显式） |
| 预检次数 | 多次 | **submit 前一次** |
| ready | 曾硬拦 / force 混用 | §3 分级 |
| `--force` | 过宽风险 | 仅 skip ready；文档写清 |
| 默认排除 03 | 过时 | 默认可用 01–04 中 live 可跑集合；03 已恢复勿默认排除 |
| 全局 activeLeases | 可能过度敏感 | 仅当**目标 alias** lease 冲突才拦 |
| 测试 | 无单测 | 对纯函数：assembleFixture、ready 分级、verifyMode 校验加 node:test |

#### 5.3 推图与 lease（务实折中）

**理想**：推图也在 job 内、带 lease。  
**本 plan 务实**：  

- Mac `phone-push` 可暂时保留，但：  
  - 不得在 `--dry-run` 执行；  
  - 实跑时 push 与 submit 之间窗口尽量短；  
  - 文档标明「相册写入无控制面 lease」为已知 gap / backlog。  
- **不要**为了完美推图租赁阻塞 SKU 验收。

#### 5.4 知识 seed

修 `knowledge-seed-feishu-to-xianyu-20260728.json`：

- `verifyMode` ∈ `replay | constraint | human | null`  
- 自由文本验证说明移到 `content` 或 `steps`  

```bash
node import-knowledge.mjs knowledge-seed-feishu-to-xianyu-20260728.json
# 按 import 工具真实语义处理更新（勿盲信过期 CLAUDE 文档）
```

#### 5.5 A 仓验证

```bash
cd /Users/a1234/Desktop/Coding/xhs-registry
npm test
npm run check
```

---

### Phase 6 — 04 与局部失败（P1）

1. 不要对 04 盲重跑完整飞书链直到 Phase 4 绿。  
2. 04 恢复：  
   - 若有失败 jobId `job_0b5c725e-...`（以 live 为准）→ `recover-main-safe`  
   - 必要时 lease 内 relaunch  
   - 成功 R0/R1 刷 ready  
3. L1 脚本（时间够再做）：  
   - 按 `agent-entry` 的 ready + capability eligible 动态选机  
   - 去掉写死 01/02/04、停止重复刷知识库告警  
   - **不**作为 L_min 门禁  

---

### Phase 7 — Explorer 最小丝滑（P2，可选）

**目标**：`session acquire` → 连续 dump/tap/input → heartbeat → release。  

1. `ops/_explore-lib.mjs` / preflight：acquire session 后才允许 22222 动作。  
2. 长操作 heartbeat ≤20s。  
3. **不要**每步 route plan。  
4. tap 与生产 gateway 对齐（Phase 1–2 结论）。  

非 L_min 门禁。

---

### Phase 8 — 后台债（明确不挡发布）

| 项 | 动作 | 优先级 |
|----|------|--------|
| command-runner 泄露单测 | clean main 修到 214/214 | P1 安全，可另 PR |
| watchdog 盯 main + 迁出 Desktop | 修脚本分支常量 | P2 |
| CLAUDE.md / PROGRESS 漂移 | 更新现状 3/4、origin、测试数 | P2 |
| 凭证搬迁 | backlog | P3 |
| GPFS 脏树 | **不清理他人现场**；只用 worktree | 纪律 |

---

## 5. 明确禁止清单（Codex 红线）

1. 在 GPFS `agent/placement-entry-v1-1-20260724` 脏工作区直接提交生产修复。  
2. 无 lease 验收、bypass 验收、四机无 lease 干跑。  
3. 真存草稿 / 真发布。  
4. 为「丝滑」拆掉：双控 lease、R2 人审、风控急停。  
5. 无 Phase 1 证据同时改：导航 + 正则 + 全栈坐标体系。  
6. 把 `ready=false` 一律 hard-block 或一律忽略（必须按 §3 分级）。  
7. 用扩大 stdoutSnippet 泄露换诊断。  
8. 失败后要求 4 机全部 reset 再继续。  
9. 改 `control.db` 手搓清隔离。  
10. 把 L1/watchdog/文档完美化当作 SKU 完成前提。

---

## 6. 推荐任务拆分（给 Codex 的 checklist）

复制到 PR/会话头：

```text
[ ] P0  Phase0 只读：live + HEAD + clean worktree
[ ] P1  Phase1 证据：01 上 campaign vs 飞书 fixture；填决策表
[ ] P2  Phase2 最小修复 fillSkuSpecs / 正则 / tap（只选主因）
[ ] P2b 单测绿
[ ] P2c merge main + Windows pull + task-launch 40字 + 控制面重启
[ ] P3  result 保留 selectAllMiss 脱敏字段 + 单测
[ ] P4  01 单机 full_dry_run 飞书链 succeeded（L_min）
[ ] P5  feishu-to-xianyu dry-run 零写入 + ready 分级 + --force 收窄
[ ] P5b knowledge seed verifyMode 修复并导入
[ ] P5c xhs-registry npm test / check
[ ] P6  04 恢复策略（非门禁）
[ ] P8  留痕：PROGRESS + 知识库 pitfall 更新
[ ] （可选）P7 Explorer session 闭环
[ ] （可选）command-runner 214/214 另 PR
```

---

## 7. 部署检查单（每次改 B 仓）

```text
[ ] 短分支自 main
[ ] 测试绿
[ ] PR / merge main
[ ] Windows: git pull main
[ ] git rev-parse HEAD → 完整 40 字符
[ ] task-launch.json.gitCommit 同步
[ ] schtasks 重启 XhsDeviceControlPlaneV1
[ ] curl health 200
[ ] 再 submit 验证（新 idempotency-key）
```

---

## 8. 验收报告模板（Codex 完成后粘贴）

```markdown
## 丝滑 Plan 验收

### Live（验收时刻）
- generatedAt:
- 01/02/03/04 ready/lease/quarantine:
- Windows HEAD / task-launch:

### Phase 1 决策
- 主因分支: 导航 | 正则 | tap | dump空
- 证据 jobId:
- 全选 label 原文:

### 代码
- PR/commit:
- 改动文件列表:

### L_min
- jobId:
- status:
- SKU step:
- restoration/verification:
- 是否 bypass: **no**

### 编排
- dry-run 是否零手机写入:
- --force 语义:

### 留痕
- 知识库 id:
- PROGRESS 已更新: yes/no

### 未做 / backlog
-

### 入口问题（若有）
- 是否曾 commit mismatch / 无 lease / 脏 GPFS:
```

---

## 9. 给派工人的一句话

> **先证据后改刀：用正道 job 在 01 上钉死坑④主因 → 最小修复 fillSkuSpecs → result 带诊断 → 飞书脚本做减法；不要再加预检，不要用 bypass 验收，不要在脏 GPFS 长分支上修生产。**

---

## 10. 附录：Hermes 完整卡点对照（执行时勾选）

| # | 卡点 | Plan 归属 | 状态目标 |
|---|------|-----------|----------|
| 1 | adapter 白名单 | 已解决 | 勿重做 |
| 2 | ready 过严 | Phase 5 + §3 | 分级，保留收窄 --force |
| 3 | 多行描述 | 已解决 | 整链随 SKU 解锁 |
| 4 | SKU select-all-missing | Phase 1–2–4 | L_min |
| 5 | Flutter tap | Phase 1 决策后条件触发 | 证据驱动 |
| 6 | UI dump 空 | Phase 1 证伪/证实 | 勿先验当主因 |
| 7 | 01 末态 | 正道 restore | 禁 bypass 常态 |
| 8 | result 丢诊断 | Phase 3 | L_good |
| 9 | 单色 SKU | 并入 #4 | 不单独立项 |
| 10 | 知识 seed | Phase 5b | 可导入 |

---

*End of plan.*
