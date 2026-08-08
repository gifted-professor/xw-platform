# Foundation PR3 post-merge entry（2026-08-08）

> PR2 source-merged; not deployed; pilot inactive.  
> Pairing at PR3 branch cut:

| 仓 | main HEAD | PR3 branch |
|---|---|---|
| routing | `16fac8e` | `foundation/pr3-transport-boundary` |
| registry | `945a5fe`（含 PR2 merge leave-trace docs） | `foundation/pr3-transport-boundary` |

## PR3 目标（冻结规格 §12）

TypedTransport Phase 1 物理边界 + `transportActionAuthorization` + purpose 矩阵；session/recovery/bypass **0 写 token**；生产 `XHS_ALLOW_BYPASS` 写路径关闭。

## Slice 1（本切片）

- routing: `control-plane/lib/transport-action-authorization.mjs` + schema + unit tests  
- 签发 kind 仅 `capability_job` \| `mission_device_run`  
- purpose↔job status 表；nonce 单次消费；bypass 写关闭  
- **尚未**：StateStore 表、FastOperator/Gateway 接线、Adapter import lint

## 红线

0 device I/O · 0 Windows service · 0 ActivatePilot  
合并顺序仍 routing → registry
