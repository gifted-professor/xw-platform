# xw-platform

统一源码项目。2026-08-19 起也是**唯一生产运行来源**：17920/17930 由本仓 release（`xw-20260819-f337079`）驱动，两个旧仓已 archive。

**新 agent 先读 [`HANDOFF.md`](HANDOFF.md)**。

## 当前状态

- XW Platform 是两旧仓（`xhs-registry`、`xhs-device-agent`）的统一源码主线，**也是唯一发布与运行来源**。
- 运行时仍是**两个独立进程/数据库/端口**（`legacy_compat`），业务行为与切换前一致。
- 旧仓已归档只读；旧 checkout 已改名为 `*-retired-20260819` 回滚工件。
- M3-R 全案关闭（证据链：`docs/cutover/m3-r/`）。

## 不要误解为

- ❌ 双跑期还没结束（没有双跑，旧系统已退役）
- ❌ Agent 已可直接控制手机（Open Action live / DSH / Multi-Agent 仍 CLOSED，支付仍人工硬闸）

## 治理门

| 门 | 状态 |
|---|---|
| `SOURCE_FUSION_GATE` | OPEN |
| `REHEARSAL_GATE` / `ROLLBACK_GATE` | PASS |
| `LIVE_CANARY_GATE` / `RUNTIME_CUTOVER_GATE` | PASS（2026-08-19） |
| `LEGACY_RETIREMENT_GATE` | PASS（2026-08-19） |
| `OPEN_ACTION_LIVE` / `DSH_LIVE` / `MULTI_AGENT_LIVE` | CLOSED（各自独立门） |
| M0 | `M0_CANDIDATE / UNCERTIFIED`（B1–B4 DEFERRED） |

## 阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| F1-B | 骨架文档 + 合同/source-lock 副本 | 完成 |
| F1-C | 导入 Orchestrator（xhs-registry 历史） | 完成 |
| F1-D | 导入 Control Plane（xhs-device-agent 历史） | 完成 |
| F1-E | 增加导入验证工具 | 完成 |
| F1-F | 增加根命令和离线 CI | 完成 |
| F1-G | 完成 Physical Fusion 验收 | 完成 |
| M3-EH | Open Action Runtime v1（fixture/replay） | 源码完成；live 仍关 |
| M4-A | Skill Contract + fixture SkillRun | PR #24；DSH live 仍关 |
| M4-B | Harness Protocol + DSH State Bridge | PR #25；真机仍关 |
| M4-C/D | Skill Router + Experience Ledger + xhs.collect hybrid pack | 进行中；Compiler 不自动晋升 |

## 更多

- `docs/architecture/skill-runtime.md` — M4-A Skill 合同（源码 only，不接 DSH/真机）。
- `docs/architecture/harness-protocol.md` — M4-B Harness Protocol（DSH 锁 commit，live 仍关）。
- `docs/architecture/skill-router.md` — M4-C Router + Experience Ledger。
- `docs/architecture/target-layout.md` — 目标目录结构。
- `docs/architecture/runtime-boundaries.md` — 运行时边界与不变量。
- `docs/fusion/` — 合仓合同、source lock、导入收据、Physical Fusion 验收。
- `docs/cutover/m3-r/plan.md` — M3-R Runtime Source Cutover 定义（已定义、未启动；前置：PR #14 合并 + M3 Source Gate 锁定）。
- `tools/fusion/` — 离线导入验证与 test-gate。
- 根命令：`npm run check` / `fusion:verify` / `authority` / `kernel:check` / `test:m0` / `test:gate`（无 workspaces）。
- 权威边界：`docs/architecture/authority-boundary.md`（M2-A，source-only）。
- 共享内核：`packages/kernel/`（M2-B，先复制 repair 契约，不删服务原件）。
- 离线 CI：`.github/workflows/source-fusion.yml`（`ubuntu-latest` + `windows-latest`，源文件仍在 `docs/fusion/source-fusion.workflow.yml`）。
- Open Action Runtime：`docs/acceptance/m3-source-acceptance.v1.json`；CLI `node packages/cli/xw.mjs phone …`。