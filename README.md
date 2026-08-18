# xw-platform

统一源码项目。Physical Fusion / M1 已验收；运行时仍未切换。

## 当前状态

- XW Platform 是两旧仓（`xhs-registry`、`xhs-device-agent`）的统一源码主线。
- Physical Fusion（源码合仓 / M1）已完成验收。**不是**运行时统一阶段。
- Orchestrator 与 Control Plane 仍是**两个独立运行时**。
- `RUNTIME_CUTOVER_GATE = CLOSED`：运行时切换未发生。
- 本仓当前**没有生产部署授权**。

## 不要误解为

- ❌ production ready
- ❌ 统一运行时已经完成
- ❌ Agent 已可直接控制手机

## 治理门

| 门 | 状态 |
|---|---|
| `SOURCE_FUSION_GATE` | OPEN |
| `RUNTIME_CUTOVER_GATE` | CLOSED |
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

## 更多

- `docs/architecture/target-layout.md` — 目标目录结构。
- `docs/architecture/runtime-boundaries.md` — 运行时边界与不变量。
- `docs/fusion/` — 合仓合同、source lock、导入收据、Physical Fusion 验收。
- `tools/fusion/` — 离线导入验证与 test-gate。
- 根命令：`npm run check` / `fusion:verify` / `authority` / `kernel:check` / `test:m0` / `test:gate`（无 workspaces）。
- 权威边界：`docs/architecture/authority-boundary.md`（M2-A，source-only）。
- 共享内核：`packages/kernel/`（M2-B，先复制 repair 契约，不删服务原件）。
- 离线 CI：`.github/workflows/source-fusion.yml`（`ubuntu-latest` + `windows-latest`，源文件仍在 `docs/fusion/source-fusion.workflow.yml`）。