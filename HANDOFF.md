# 接手文档 — 2026-08-19

## 🔧 2026-08-19：M4-A Skill Contract（当前工作）

分支：`feat/m4a-skill-contract`。**源码 only**：不改 17920/17930，不改 `runtimeProfile`，`dshEnabled` 仍 false。

- 合同：`packages/kernel/contracts/skill/`
- 状态机 + 跨进程 `serialize`/`restore` + SkillVersionRef + Action Ledger 对账门
- 样板包装现有 `xhs.collect`；`candidateIntents` 必须是 `intent:…`
- 机器门：`npm run m4a:accept`
- 下一波才是 M4-B（`integrations/dsh-xw`）。Graph / Experience Compiler / 真机 canary 不在本波

## 🏁 2026-08-19 晚：M3-R 全案关闭

**`LEGACY_RETIREMENT_GATE = PASS`，M3-R 六个门全部关闭。**

- 两个旧 GitHub 仓（`xhs-registry`、`xhs-device-agent`）已 archive 只读，README 有迁移声明。
- 旧 checkout 已改名 `C:\Users\Public\xhs-registry-retired-20260819` / `xhs-device-agent-retired-20260819`（回滚工件，勿删：内有唯一 WIP 现场状态，备份在 `xw-runtime\rollback\legacy-backup-20260819\`）。
- 7 个旧计划任务全部 Disabled 留档；`XW Platform Control Plane` / `XW Platform Orchestrator`（BootTrigger, SYSTEM）接管启动。
- 引用扫描全零（进程/env/任务），见 `docs/cutover/m3-r/legacy-reference-scan.v1.json` 与 `retirement-receipt.v1.json`；打标签 `xw-m3-runtime-source-cutover`。
- 观察窗压缩至当日（人决定），每日巡检 cron 兜底；真实观察 job 已验证（P1-2 PASS，零外发）。
- **下一步：M4（Plugin SDK + DSH Adapter）。能力门独立：Open Action live / DSH / Multi-Agent 仍 CLOSED，支付人工硬闸不变。**
- 下面 §3「切换后现状」与更早内容保留作历史记录。

## ⚡ 2026-08-19 切换后现状（历史记录）

**现场已切到 xw-platform（M3-R3+R4 已执行，两个 Gate 均 PASS）。**

- 17920 Control Plane 与 17930 Orchestrator 现在都跑 `C:\Users\Public\xw-runtime\releases\xw-20260819-f337079`（= main `f337079`），由新计划任务 `XW Platform Control Plane` / `XW Platform Orchestrator`（BootTrigger, SYSTEM, 启用）拉起，重启可活。
- 两个 DB 已迁到 `C:\Users\Public\xw-runtime\state\{orchestrator,control-plane}\`；control.db 已迁移到 user_version=18；evidence/logs 在 `xw-runtime\evidence|logs`。
- 旧任务：`XhsDeviceRegistry` 已 **Disabled（未删）**；`XhsDeviceControlPlaneV1` 保持原状。旧 checkout（`xhs-registry`、`xhs-routing-v1-1`）未动，是回滚单元的一部分。
- 回滚单元：`xw-runtime\rollback\final-20260819\snapshots`（双 DB，integrity ok）+ 旧任务定义 + 旧代码目录。回滚步骤见 `docs/cutover/m3-r/plan.md` §十二。
-  receipts：`docs/cutover/m3-r/{production-cutover-receipt,canary-receipt,state-path-migration-receipt,legacy-reference-scan}.v1.json`。
- 新任务对**非提权** `Get-ScheduledTask` 不可见（SYSTEM 任务），查询/操作需管理员 PowerShell。
- 注意两个坑：① 不要用 junction 路径直接 `node xw-runtime\current\...` 启动服务（node realpath 主模块会静默退出，必须经过 `launch-*.ps1` 先解析）；② launcher ps1 必须 ASCII 或带 BOM（PS 5.1 编码坑）。
- 支付红线未变：credential/final commit 均需 HUMAN；探针验证见 canary-receipt。
- 未做：真实 legacy job 试跑（保守跳过）；`XhsScoutScout`/`XhsXwEvolveWorker` 等既有任务仍引用旧目录（M3-R6 退役范畴）。

---

> 以下为切换前的历史接手文档，目录角色描述已过时（旧目录不再跑生产），保留作背景。

## 0. 你在哪一侧（历史）

- **本仓 = 源码 / 治理主线**。新功能只写这里。
- **不是现场运行目录**。Windows 上真正在跑的仍是下面两个旧文件夹。
- `RUNTIME_CUTOVER_GATE = CLOSED`。本仓没有生产部署授权。

开工三问：① 这次改源码还是碰机？② 若碰机，lease 在 17920 看得见吗？③ 若改源码，落在哪个 PR / 哪个门？  
碰机任务不要在本仓硬干，去旧仓 + live `agent-entry.md`。

---

## 1. 三套目录（完整清单）

| 路径 | 角色 | git | 现场 |
|---|---|---|---|
| **`C:\Users\Public\xw-fusion\xw-platform`** | **现在的源码主线**。两旧仓历史已导入 | `gifted-professor/xw-platform` | **不跑** 17920/17930 |
| `C:\Users\Public\xhs-registry` | 旧 Orchestrator 现场副本 | `gifted-professor/xhs-registry` | **跑** `17930`（计划任务 `XhsDeviceRegistry`） |
| `C:\Users\Public\xhs-routing-v1-1` | 旧 Control Plane 现场副本（device-agent `main`） | 与 `xhs-device-agent` 同源 | **跑** `17920` |

同级一次性 scratch（导入用过，不要复用、不要当源）：

```text
C:\Users\Public\xw-fusion\
  xw-platform                          ← 你在这里
  xw-platform-m1                       ← 旧草稿，忽略
  F1-B-DRAFT                           ← 骨架草稿，忽略
  xw-f1c-registry-20260818T121027Z-3fa099c
  xw-f1d-device-agent-20260818T122302Z-43b09ac
```

导入锁（不要改、不要从 dirty tree 再导一次）：

- registry：`3fa099c1` / tree `0bed6b8f…` → `services/orchestrator/`
- device-agent：`43b09acc` / tree `cdcb731…` → `services/control-plane/`

`xhs-registry` 现场工作树大约 **108 个未提交 WIP**（fanout / grant / bench / compose）。那是 8/12–8/16 业务源码，**没有**进融合锁。不要去那棵脏树「收拾一下」。

---

## 2. 三者关系（一句话）

```text
产品只有一个：XW
源码主线只有一个：xw-platform
运行时仍是两个进程、两套库、两套旧路径
```

```text
xw-platform/
  services/orchestrator/     ← xhs-registry 全历史（F1-C）
  services/control-plane/    ← xhs-device-agent 全历史（F1-D）
  services/agent-gateway/    ← M3-EH 新建（见 §5：CI 因此红了）
  packages/kernel|control-client|replay|cli
  docs/  tools/fusion/
```

权威边界（M2-A，未改）：

- Control Plane：device / lease / session / job / transport / 支付 final-commit
- Orchestrator：goal / task / mission / knowledge / closeout
- `registry.db` 与 `control.db` 独立
- 17920 / 17930 / 计划任务 / 启动路径 **未切**

旧仓不 archive。紧急修复可改旧仓，但必须 port 回 `xw-platform`。新功能禁止只写旧仓。

---

## 3. 进度（到 2026-08-19）

### 门

| 门 | 状态 |
|---|---|
| `SOURCE_FUSION_GATE` | OPEN |
| `RUNTIME_CUTOVER_GATE` | CLOSED |
| `LIVE_CANARY_GATE` | CLOSED |
| M0 | `M0_CANDIDATE / UNCERTIFIED`，B1–B4 DEFERRED |
| `runtimeCutoverAllowed` | false |

### 已合进 `xw-platform` `main`（`cc405ab`）

| PR | 内容 |
|---|---|
| #1–#6 | F1-B→G Physical Fusion / M1 |
| #7 | GitHub Actions（Ubuntu 硬闸；Windows 服务测试 `continue-on-error`） |
| #8 M2-A | 权威边界 |
| #9 M2-B | `packages/kernel` 复制 repair 契约 |
| #10 M3-A | Open Action 协议 + 支付硬闸 |
| #11 M3-B | observation-only device session |
| #12 M3-C | payment firewall fixtures |
| #13 M3-D | fixture `tap` 执行器 + schema / 未知信号 fail-closed / observation freshness |

#13 收口 head `8550621`，merge `cc405ab`。Ubuntu + Windows 当时都绿。

### 未合：PR #14 M3-EH（当前工作）

- URL：https://github.com/gifted-professor/xw-platform/pull/14
- 分支：`feat/m3eh-open-action-runtime-v1`
- head：`32d13a2`
- 状态：**OPEN / MERGEABLE，但 CI 红**

四个 commit：

1. `133754c` Durable ledger（schema 18）：reserve-before-execute、单飞、release 互斥、重启 → `AMBIGUOUS`
2. `ecbb6be` `packages/replay`
3. `66ab167` `control-client` + Agent Gateway
4. `32d13a2` `xw phone` CLI + `docs/acceptance/m3-source-acceptance.*`

本地曾过：executor + M3-EH 16/16，`npm run check` / `authority` / `kernel:check` PASS。  
**CI 两边都死在 `fusion:verify`**：`unexpected services/: agent-gateway`。  
verify 只承认 `services/orchestrator` 与 `services/control-plane`。新目录必须挪走或改 verify 合同。

验收稿自称 `M3_SOURCE_GATE=PASS`，**在 CI 红时不要当已经过门**。

### 现场（2026-08-19）

- 17930 registry：活着，4 台身份缓存新鲜
- 17920 控制面：**不可达**
- 四机 `online/ready=unknown`，lease free，job=0
- 现场 release 仍是 `rel-2026-08-12-xianyu-qr-mask-v3`
- 与本仓 M3 代码无关，不要为了 M3 去重启控制面，除非人明确派工

### 明确没做

- 没切运行时、没 archive 旧仓
- 没改现场 `registry.mjs` 审批面板（仍 readOnly 读 `control.db`）
- 没 live canary、没 ADB/22222
- 没开 M4 Plugin SDK

---

## 4. 新 agent 默认下一步

**不要开 M4，不要 cutover，不要碰四机。**

按这个顺序：

1. **修 PR #14 的 `fusion:verify`**  
   推荐：把 `services/agent-gateway/` 挪到 `packages/agent-gateway/` 或 `integrations/agent-gateway/`（target-layout 允许 packages/integrations 在首个真文件时建）。  
   少改 verify 合同（它是合仓硬闸）。
2. 本地再跑：`npm run fusion:verify`、`npm run check`、`npm run test:m3eh`、`npm run authority`。
3. 推同一分支，等 **Ubuntu CI 绿**（Windows 服务测试不是硬闸；`check` / `fusion:verify` 挂了两边都会红）。
4. 等人 review。合的时候用 **merge commit**，不要 squash。
5. 合完才谈 M4（Plugin SDK + DSH Adapter）。cutover 是更后面的独立门。

审查留下的债（不要塞进 #14 除非人要求）：

- `registry.mjs` 审批列表仍直读 `control.db`（readOnly）
- 幂等单飞是 session 级 SQLite UNIQUE，不是跨进程 single-flight 锁文件
- M3-D 仍只开放 `tap`

---

## 5. 红线

- 禁止无 lease 碰手机、禁止 GatewayOperator 旁路、禁止直写 `control.db`
- 支付 / final commit：`transport=0`，等人
- 不要 `runtimeCutoverAllowed=true`
- 不要 npm workspaces
- 导入树改动必须进 `docs/fusion/post-import-allowlist.v1.json`（control-plane 已有一批 extra/blob）
- `services/` 下不要再新增第三套导入服务名，除非先改 verify 合同
- 旧仓 108 个 dirty 文件保持不动

---

## 6. 常用命令（cwd = 本仓根）

```text
npm run check
npm run fusion:verify
npm run authority
npm run kernel:check
npm run test:kernel
npm run test:m3eh
node packages/cli/xw.mjs phone --help
```

看现场（只读）：

```text
curl.exe -s http://127.0.0.1:17930/agent-entry.md
```

不要 curl 本仓假装自己是 17930。

---

## 7. 该读的文件

| 先读 | 为什么 |
|---|---|
| 本文 | 进度与下一步 |
| `README.md` | 门与「不要误解」 |
| `docs/architecture/runtime-boundaries.md` | 两服务边界 |
| `docs/architecture/authority-boundary.md` | 谁写什么 |
| `docs/acceptance/m3-source-acceptance-report.md` | M3-EH 自称过了什么 |
| `docs/fusion/post-import-allowlist.v1.json` | 导入树允许改哪些文件 |
| PR #14 | 当前 diff |

旧仓冷启动（仅碰机任务）：`C:\Users\Public\xhs-registry\AGENTS.md` + live `agent-entry.md`。
