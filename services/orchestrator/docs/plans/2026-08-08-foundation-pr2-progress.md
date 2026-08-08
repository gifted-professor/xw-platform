# Foundation PR2 progress — slice 1（2026-08-08）

分支：`foundation/pr2-runtime-integrity`（routing + registry）

基线：见 `2026-08-08-foundation-pr2-baseline.md`

## 本切片已落地（Closure + TCB only）

| 仓 | 模块 |
|---|---|
| routing | `control-plane/lib/implementation-closure.mjs`, `tcb-manifest.mjs`, schemas, `tests/implementation-closure.test.mjs` |
| registry | `scripts/lib/implementation-closure.mjs`, `tcb-manifest.mjs`, contracts, tests, baseline + files manifest |

覆盖：RI-01（稳定 hash / 一字节漂移 / missing fail-closed / TCB verify）。

## 尚未做（后续切片）

- RI-02 Contract 传播（capabilityContractHash 纳入 closure）
- RI-03 ExecutionPlan / run-manifest 强制同 hash
- RI-04 dispatch/resume recheck
- RI-05 WorkReceipt v2
- TypedTransport interface / fake

## 红线

0 device I/O · 0 Windows service · 0 pilot · 合并仍 routing → registry
