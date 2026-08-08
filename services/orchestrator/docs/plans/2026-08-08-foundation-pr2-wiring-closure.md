# Foundation PR2 wiring closure（2026-08-08 post-merge）

分支：`foundation/pr2-wiring-closure`（基于 main @ `a305f59`，PR3 已合入之后）

> **状态：Draft PR #6 · REQUEST CHANGES round-2 fixes in progress · Not deployed · Pilot inactive**

## Round-2 findings addressed (Registry)

| Finding | Fix |
|---|---|
| Blocker 1 stable `operationKey` | Worker submits `idempotencyKey: assignment.operationKey` only; no attempt suffix / slice |
| Blocker 2 Scheduler constraints | Orchestrator uses `executionPlan.constraints`; business forced 1/false/1 |
| Blocker 3 hash recompute | `assertExecutionPlan()` canonical rehash → `EXECUTION_PLAN_HASH_MISMATCH` |
| High 1 route auth fail-open | Require `authorization.decision === "allow"` + non-empty `decisionId` |
| High 2 final decisionId | Receipt prefers Job auth decisionId; pre-submit uses `null` (no `"unbound"`) |
| Medium retryClass | Integrity-bound reads only `boundNode.retryClass` |
| Medium binder assertions | Exact raw↔live effect/retry mismatch |
| Medium parent symlink | Segment-wise `lstat` rejects parent-directory symlinks |
| Medium receipt fencing | v2 fences executionPlanHash/operationKey/contract/algo/closure |
| Blocker 4 expected hashes on submit | Registry **sends** expected* fields; Routing twin must atomically enforce (follow-up) |

## Paired heads

- Registry head: see latest commit on `foundation/pr2-wiring-closure`
- Routing PR #41 final head: `aca4d52b63f80014e8fc3eff2961d15adc409196` (not intermediate `524a675`)
- Routing follow-up still required for submit-transaction expected hash lock + algorithm catalog exposure

## Red lines

0 deploy · 0 Windows reload · 0 Pilot · 0 device I/O
