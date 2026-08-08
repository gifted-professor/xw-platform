# Foundation PR1 进度（2026-08-08）

分支：`foundation/pr1-core`（routing + registry 双仓）

规格：`C:\Users\windows 10\.claude\plans\silly-tumbling-raccoon.md`（Architecture Freeze Approved）

## 已落地

### Routing (`C:\Users\Public\xhs-routing-v1-1`)

| 模块 | 状态 |
|---|---|
| `capability-effect.mjs` | normalize + contract hash + legacy derive |
| `protected-commit-policy.mjs` | publish/payment/delete final kernel |
| `raw-primitive-policy.mjs` | Raw Public 只读（无 home/launch/tap） |
| `authorization-decision.mjs` | allow / wait_human_commit / block |
| `policy.mjs` | thin wrapper → 新 decision |
| `mission-policy` | publish/delete 永不 allow_within_scope 释放 |
| `nonpayment-autonomy` | unknown → TYPED_CAPABILITY_REQUIRED |
| `submitJob` | **不再**创建 ordinary `waiting_approval` |
| `operations` 表 | operation_key 主权 + jobs 投影列 |
| Capability loader | effect/exposure/lifecycle 可选字段 |

### Registry (`C:\Users\Public\xhs-registry`)

| 模块 | 状态 |
|---|---|
| `derivePolicy` | approvalRequired/autonomous/runnableAsJob → **null** |
| `authorizationHint` | `context_required` |
| `task-plan-capability-binding.mjs` | Raw → ExecutionPlan binder |
| task-plan-v2 | 放宽 raw external_effect assertion |

## 测试

- routing：`foundation-pr1-core` + core/placement/mission/adapters/freedom **82 pass**
- registry：`registry` + binder + task-plan **51 pass**

## 故意未做（后续 PR1 切片 / PR2+）

- 全量 Mandatory capability 显式 `effect` 字段（当前 legacy derive）
- Workflow SessionWorker runtime 硬闸（binder 已拒 params.actions）
- xw-mission 强制只吃 ExecutionPlan
- INV-10 dispatch recheck、TypedTransport、tcb.manifest（PR2/PR3）
- Pilot 激活 / 真机 canary（PR4）

## 不碰机

本切片全程离线；live 仍为 shadow，0 lease。
