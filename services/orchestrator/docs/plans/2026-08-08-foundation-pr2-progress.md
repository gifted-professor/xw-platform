# Foundation PR2 progress（2026-08-08）

分支：`foundation/pr2-runtime-integrity`（routing + registry）

基线：见 `2026-08-08-foundation-pr2-baseline.md`

## Slice 1 — Closure + TCB（已 push）

| 仓 | 模块 |
|---|---|
| routing | `implementation-closure.mjs`, `tcb-manifest.mjs`, schemas |
| registry | 同名 scripts/contracts + baseline/files |

## Slice 2 — RI-02…RI-05 + TypedTransport（本切片）

### Routing
- `capability-effect.mjs`：contract hash 纳入 `implementationClosureHash` / `tcbManifestRef`
- `capability.schema.json` + registry validate / `listPublic` 暴露 closure
- `authorization-decision.mjs`：snapshot 带 closure refs
- `runtime-integrity.mjs`：dispatch recheck helper
- `control-plane.mjs` `pump()`：**acquireLease 前** recheck；漂移 → `failed` + `IMPLEMENTATION_CONTRACT_CHANGED` + `notSent`（0 lease）
- `tests/foundation-pr2-runtime-integrity.test.mjs`

### Registry
- binder 写入 `implementationClosureHash` / `tcbManifestRef`（与 run-manifest 同字段）
- `runtime-integrity.mjs` + `TypedJobWorker` resume fail-closed
- `work-receipt.mjs` v1 兼容 + `createWorkReceiptV2` / schema
- `typed-transport.mjs`：interface + fake + injected adapter（无真机）
- tests

## 仍未做（可进 PR 正文 backlog，不挡本轮 review）

- 给 live `apps/*/capabilities.json` 批量写真实 TCB manifest（需选 path 集合；避免一锅炖）
- Mandatory Capability 晋升 canary/implemented 与假 hash 清零的生产 Catalog 审计
- Adapter import lint CI
- 端到端 fake CP pump 集成测（当前有 unit recheck + pump 接线）

## 红线仍守

0 device I/O · 0 Windows service · 0 pilot · 合并仍 routing → registry
