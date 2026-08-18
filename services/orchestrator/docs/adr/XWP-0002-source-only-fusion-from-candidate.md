# XWP-0002 — 源码级合仓治理门（Source-only Fusion from M0 Candidate）

- 状态：Accepted（M0_CANDIDATE 下 source-only fusion 放行）
- 日期：2026-08-18
- 关联：`docs/platform/fusion/source-only-gate.v1.json`、`docs/adr/XWP-0001-xw-platform-architecture-and-migration-gates.md`、`docs/platform/m0/public/xw-m0-20260817-r0/`（冻结 dossier，本 ADR 不触碰）

## 背景

M0 基线 `xw-m0-20260817-r0` 已于 2026-08-17 冻结（PR #15 `1c70551`），当前状态 **M0_CANDIDATE / UNCERTIFIED**，`conclusion: PASS_PENDING`。M0 的 G3（可重放）依赖一次性隔离 VM（B2/B3），该路径不再追求用 UTM 补齐。

系统仍由两个独立仓库组成：`xhs-registry`（Orchestrator）与 `xhs-device-agent`（设备侧控制面）。为了把两个项目在**源码与治理层面**融合为一个产品，需要把两仓完整、可追溯地合并进一个新的 monorepo `xw-platform`。这属于**源码级合仓（source fusion）**，与**运行时切换（runtime cutover）**是两件正交的事——前者不触任何运行行为，后者才受 XWP-0001 的 G1–G6 门管辖。

本 ADR 定义并放行 source fusion 轨道，同时保持 RUNTIME_CUTOVER 关闭。

## 决策

### 1. 两个正交的门

| 门 | 状态 | 含义 |
|---|---|---|
| **SOURCE_FUSION_GATE** | **OPEN** | 允许源码级合仓、目录重组、离线测试、CI 建设、新建 monorepo `xw-platform` |
| **RUNTIME_CUTOVER_GATE** | **CLOSED** | 禁止运行时切换、部署、重启、数据库迁移、设备操作 |

两门正交：SOURCE_FUSION 打开**不**意味着 RUNTIME_CUTOVER 打开。任何 PR 若试图同时触碰两个门（如合仓时顺带改端口/DB/启动脚本），即视为违反本 ADR，BLOCK。

### 2. M0_CANDIDATE 的权限

M0_CANDIDATE 可以进入物理合仓，但**不允许**进入运行时切换：

| 允许（permits） | 禁止（forbids） |
|---|---|
| 源码级仓库合并进新 monorepo | 运行时切换 / 部署 / 重启 |
| `services/{orchestrator,control-plane}` 目录重组 | 数据库迁移（`registry.db`、`control.db`） |
| 离线测试与 CI 建设（GitHub Actions，含 Windows Runner） | 设备操作 / ADB / 22222 / 17920 / 17930 变更 |
| 新建 `xw-platform` 仓库 | 修改 M0 冻结 dossier 哈希 |
| 合仓导入收据与验收工具的维护 | 关闭旧 PR；打 M0 双 tag |

### 3. B1–B4 保持 DEFERRED；G3 在 source-only 轨道的替代

- B1 / B2 / B3 / B4 **保持 DEFERRED**，不因 source fusion 重新打开。
- XWP-0001 的 **G3（可重放）**对 **source-only 轨道**由 **GitHub Actions Windows Runner** 承担：CI 在 `ubuntu-latest` + `windows-latest` 上跑离线套件（`npm run check` / `npm test` / `test:control-critical` / `test:m0`），作为一次性隔离 VM 的源码兼容性替代。对**运行时迁移轨道**，G3 约束不变。
- **不要求 Mac mini 运行 UTM。**
- 真实设备与运行时验收延迟到 RUNTIME_CUTOVER 之前，届时补完或由真实 Windows 切换验收正式替代，不能直接消失。

### 4. 对 G1–G6 的边界

- G1–G6（身份无歧义 / 可恢复 / 可重放 / 无 secret 泄漏 / 不破坏冻结 / 双 tag 完整）管**运行时迁移**。Source fusion 不触运行时，**不消耗 G1–G6**，也不改变 M0 的 `PASS_PENDING`。
- 本 ADR 在 XWP-0001 的 G5 allowlist（`docs/platform/**`、`docs/adr/XWP-*`、`tools/m0/**`）内新增文件，不破坏冻结。
- 明确允许新建 `gifted-professor/xw-platform`（PUBLIC，与两个源仓一致）。合仓后的完成态：源码层一仓、产品层一项目，运行时仍两个独立服务、两个独立数据库，部署仍走旧链路。
- 旧仓（`xhs-registry`、`xhs-device-agent`）**不 archive**（现有运行环境仍依赖）；是否将新功能主线切换到 `xw-platform` 由后续合仓 PR（F5）单独决定，不在本 ADR 范围内。

## 后果

- M0 状态保持 **M0_CANDIDATE / UNCERTIFIED**，`conclusion: PASS_PENDING` 不变。
- Source fusion 轨道获得明确授权，可以执行 F1–F5：建仓、历史导入（`git filter-repo` + 导入收据，blob/mode/missing/extra 四 mismatch 必须全 0）、根命令与双服务 CI、物理合仓验收。
- 本 ADR **不授权任何运行时行为变更**：端口、DB 路径、计划任务、launch 脚本、session token / lease / payment gate 模型、capability 执行与 adapter 行为均保持现状。
- 已知债务：G3 的一次性隔离 VM 可重放对 source-only 轨道被 CI Windows Runner 替代，属有意放宽；运行时轨道仍保留原约束。
