# Runtime Boundaries

F1 是**源码层**合仓：一仓源码、一项目产品，但运行时仍是两独立服务。本文件锁定 F1 阶段运行时边界。

## 锁定的边界

1. **Control Plane** 仍是 device、lease、session、transport、实际执行、device evidence 与 payment final-commit 的**唯一权威**。
2. **Orchestrator** 仍拥有 goal、task、mission、knowledge、evolution 和 closeout。
3. `registry.db` 与 `control.db` **仍然独立**，不迁移、不合并。
4. `17920`、`17930`、计划任务、启动路径和现场部署**完全不变**。
5. 新仓当前**没有生产部署授权**。
6. 普通 Agent 动作自由度设计属于 **F2**，不在 F1-B 中实施。

## 治理门

- `SOURCE_FUSION_GATE = OPEN`：允许源码融合（历史导入、骨架）。
- `RUNTIME_CUTOVER_GATE = CLOSED`：禁止运行时切换。
- M0 = `M0_CANDIDATE / UNCERTIFIED`；B1–B4 DEFERRED。

## 旧仓关系

两旧仓（`xhs-registry`、`xhs-device-agent`）不 archive。新功能只进 xw-platform；旧仓仅紧急修复且须 port 回。运行时切换未发生。

## F1 不变量（零运行时变化）

| 项 | F1 状态 |
|---|---|
| registry 端口 | 17930（不变） |
| 控制面端口 | 17920（不变） |
| registry DB | 独立 `registry.db`（不变） |
| 控制面 DB | 独立 `control.db`（不变） |
| Windows 计划任务 `XhsDeviceRegistry` | 仍指向旧路径（不变） |
| 手机 / ADB | 本轮不碰 |
| 部署链路 | 仍旧链路 |
| `runtimeCutoverAllowed` | `false` |