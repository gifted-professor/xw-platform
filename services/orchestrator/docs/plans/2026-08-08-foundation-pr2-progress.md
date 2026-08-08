# Foundation PR2 progress（2026-08-08）

分支：`foundation/pr2-runtime-integrity`（已合入 main）

> **状态：Source merged · Not deployed · Pilot inactive**（正确）  
> routing main = `16fac8e`（PR [#41](https://github.com/gifted-professor/xhs-device-agent/pull/41)）  
> registry main = `60fe801`（PR [#4](https://github.com/gifted-professor/xhs-registry/pull/4)）

基线：见 `2026-08-08-foundation-pr2-baseline.md`

## Slice 1 — Closure + TCB

| 仓 | 模块 |
|---|---|
| routing | `implementation-closure.mjs`, `tcb-manifest.mjs`, schemas |
| registry | 同名 scripts/contracts + baseline/files |

## Slice 2 — RI-02…RI-05 + TypedTransport

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

## Slice 3 — review follow-ups（P3 + residual tests）

- Align path validation with schema (`isCanonicalRepoRelativePath`; allow `v1..0.mjs`, reject `../`)
- Golden cross-repo RI-01 hash pin (`14b92313…`)
- Asymmetric null→present closure recheck coverage

## 合入后 backlog（PR3+）

- live capabilities 挂真实 TCB（可选最小 xianyu prepare）
- Adapter import lint CI / fake-CP pump 集成测
- Mandatory Capability 晋升与假 hash 清零审计
- **PR3**：TypedTransport 物理边界 / transportActionAuthorization / purpose 矩阵

## 红线仍守

0 device I/O · 0 Windows service · 0 pilot（至 PR4）
