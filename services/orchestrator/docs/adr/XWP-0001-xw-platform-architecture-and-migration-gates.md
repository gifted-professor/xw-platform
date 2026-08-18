# XWP-0001 — XW 平台架构与迁移门

- 状态：Accepted（M0 基线冻结 `xw-m0-20260817-r0` 固定）
- 日期：2026-08-17
- 关联：`docs/platform/m0/public/xw-m0-20260817-r0/`（baseline-identity / state-ownership / inventory / pr-assets）

## 背景

XW 平台由两个仓库组成：`xhs-registry`（本仓，Orchestrator）与 `xhs-device-agent`（设备侧控制面）。系统在 2026-07 起快速演进，出现多套命名（workflow/catalog/recipe/task/legacy）、多个端口、多类凭证与多套状态存储。M0 的目标不是部署或生产健康认证，而是建立一份**可恢复、可重放、可验证、无身份歧义**的治理基线。本 ADR 固定平台边界与迁移门，作为后续所有变更的判定基准。

## 决策

### 1. 一个产品

XW 平台是一个产品，不是多个独立工具的组合。所有组件（Orchestrator、Control Plane、设备 Agent、ops 脚本、task-templates）服务于同一套设备编排与审批治理语义。任何新组件必须能回答：它属于哪个 canonical state 的哪个 projection，由哪个 authoritative owner 写入。

### 2. Orchestrator 与 Control Plane 边界

| 面 | 角色 | 权威存储 | 写入口 |
|---|---|---|---|
| **Orchestrator**（`xhs-registry`，本仓） | 身份缓存、知识库、审批代理、只读聚合、脱敏舰队视图 | `registry.db`（identities/knowledge/approval_audit） | `PUT /api/identities`、`POST/PATCH /api/knowledge`、`POST /api/approvals/:jobId/approve\|deny`（代理到控制面） |
| **Control Plane**（`xhs-device-agent` 控制面） | 设备/lease/job/session/approval 的权威状态 | `control.db`（devices/leases/jobs/sessions/approvals/evidence） | 控制面自身 + 设备 Agent 上报 |

边界规则（M0 冻结，见 `state-ownership.v1.json`）：

1. **Orchestrator 绝不写 `control.db`**。审批经 `POST /control/v1/approvals/:jobId` 代理，由控制面落库；Orchestrator 只读 `control.db`（`mode=ro` + `query_only=ON`）。
2. **Orchestrator 绝不直接碰设备**：不触 22222/ADB/FastOperator/GatewayOperator；`/api/fleet/screen` 只读 evidence 表 + 磁盘字节，绝不触发设备 Screen/job/lease。
3. **同一 canonical state 只有一个 authoritative owner**。发现双权威 = BLOCK，停止并另修后重新冻结。
4. **多个受约束 projection writer 允许**，但每个 writer 必须受同一事务或 reconciliation 协议约束（如 sync-feishu 只经 `PUT /api/identities` 推入）。

### 3. 迁移门

任何迁移（端口、计划任务、DB schema、凭证模型、task-template 命名、跨仓路径）必须满足以下门，否则 BLOCK：

- **G1 身份无歧义**：迁移前后，每个 canonical state 的 authoritative owner/store/mutation entrypoint 在 `state-ownership.v1.json` 中唯一且可判定。
- **G2 可恢复**：迁移前 WIP 已按 M0-0B 取证（两样本一致、`wipUnknownClassification=0`），私有明文包已加密（B1）且可从 GPFS 回读校验。
- **G3 可重放**：迁移步骤在一次性隔离 VM 上从 exact HEAD clone 可重放，三轮一致（M0-D）。
- **G4 无 secret 泄漏**：公开层（docs/platform/m0/public/**）经 secret-scan 零命中；`.env`/token/私钥绝不进公开层。
- **G5 不破坏冻结**：根 `package.json`/lockfile/runtime/contracts/安装启动脚本在 M0 期间零改动；M0 只落 allowlist（`docs/platform/**`、`docs/adr/XWP-*`、`tools/m0/**`）。
- **G6 双 tag 完整**：`xw-m0-baseline` 双 tag（registry + device-agent）`pairStatus=COMPLETE` 才允许 M1 启动；`PAIR_INCOMPLETE` 时 M1 禁启动。

## 后果

- 本 ADR 固定了平台边界，后续变更以 `state-ownership.v1.json` 与 `inventory-coverage.v1.json` 为判定基准。
- 已知债务（不阻塞 M0，见 A4 `known-debt.v1.json`）：`17920` 控制面在本机不可达、舰队 ready/lease 状态 unknown、`processLoadedBytes=UNVERIFIABLE`、registry 可执行码中存在 ADB/22222 入口（ops 脚本，M0 不触碰）。
- 迁移门 G1-G6 在 M0-E（B4）最终验证；本 ADR 不宣称生产健康认证。
