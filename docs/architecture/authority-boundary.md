# Authority Boundary

M2-A 把运行时边界收成**可检查的权威表**。机器可读副本：`authority-boundary.v1.json`。

这不是运行时切换。`RUNTIME_CUTOVER_GATE` 仍是 CLOSED。`runtimeCutoverAllowed` 仍是 `false`。

## 谁写什么

| 面 | 独占 | 禁止 |
| --- | --- | --- |
| **Control Plane** | device / lease / session / job / approval 落库 / transport / payment final-commit | 写 `registry.db` |
| **Orchestrator** | goal / task / mission / knowledge / evolution / closeout | 写 `control.db`；触发设备 Screen / job / lease；把 22222/ADB 当权威 |
| **两库** | `registry.db` 与 `control.db` 独立 | 合并、迁移、改 17920/17930 |

同一 `canonicalState` 只能有一个 `authoritativeOwner`。双权威 = BLOCK。

Orchestrator 读 `control.db` 必须 `readOnly`（审批列表、聚合）。approve/deny 只能 POST 到控制面，由控制面落库。

## 检查

```bash
node tools/fusion/cli.mjs authority
```

第一轮只做静态/路径级扫描，不启动服务、不连手机。

## 与 M0 的关系

状态表提升自 `state-ownership.v1.json` 与 `runtime-boundaries.md`。不改冻结 M0 dossier 哈希。
