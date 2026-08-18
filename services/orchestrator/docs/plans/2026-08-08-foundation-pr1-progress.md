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

## PR1b（第二切片，同分支）

| 模块 | 状态 |
|---|---|
| `session-workflow-worker` | 只执行 catalog `workflow.actions`；拒 `params.actions` / `actionOverrides`（INV-07） |
| action operationKey | 去掉 attemptIndex |
| `xw-mission bind` | Raw → ExecutionPlan（live Catalog） |
| `xw-mission preflight/run` | 强制先 bind |

## PR1c（第三切片）

| 模块 | 状态 |
|---|---|
| 全部 apps/*/capabilities.json | 显式 `effect` / `exposure` / `invocationPolicy` / `lifecycle` |
| capability.schema.json | 支持 effect/exposure/invocationPolicy/lifecycle |
| OrchestrationStore | 原子 `run-manifest.v2.json`（fsync+rename）+ stable operationKey |
| task-orchestrator | init 传入 ExecutionPlan hash |

## 故意未做（PR2+）

- INV-10 dispatch recheck、TypedTransport、tcb.manifest
- Pilot 激活 / 真机 canary（PR4）
- Skill policy lint 窄 CI

## 不碰机

本切片全程离线；live 仍为 shadow，0 lease。
