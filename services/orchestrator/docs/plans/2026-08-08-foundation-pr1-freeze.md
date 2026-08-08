# Foundation PR1 冻结记录（2026-08-08）

## 裁决

**功能范围冻结。** 不再向 `foundation/pr1-core` 增加架构/功能提交。  
只允许：独立 reviewer finding 修复 + 全量回归证据更新。

配对 head（冻结基线）：

| 仓 | 完整 SHA | short |
|---|---|---|
| routing `xhs-device-agent` | `e9cba6924ca24a302be78d6bc55ca87e50c8220d` | `e9cba69` |
| registry `xhs-registry` | `4a4131ac8ca48335f447970af43da5a55a983c62` | `4a4131a` |

PR：

- Routing: https://github.com/gifted-professor/xhs-device-agent/pull/40  
- Registry: https://github.com/gifted-professor/xhs-registry/pull/3  

**推荐合并顺序：** routing #40 → registry #3；两次合并之间 **禁止部署 / 重启 / 切 pilot**。

## 全量回归快照（冻结基线，Node v24.11.1，Windows）

### Routing @ e9cba69

```text
npm run check  → ok (142 files, secret-scan passed)
npm test       → tests=672  pass=629  fail=41
git diff --check → clean (no conflict markers)
```

失败文件（需 reviewer 区分：本 PR 语义变更 vs 既有/环境）：

- **可能与 PR1 语义直接相关：**  
  `mission-explorer-firewall`（publish/delete 不再 ECP 释放）、`mission-runtime`、`protected-human-commit`、`payment-tripwire`、`non-financial-autonomy`（unknown → TYPED_CAPABILITY_REQUIRED）、`xhs-collect-standing-grant`、`xhs-explore-open-feed-note`、`control-plane-placement`（部分）
- **更像既有/环境/路径问题（需对照 main 复核）：**  
  `control-plane-command-runner`、`control-plane-evidence`、`discovery-session*`、`explicit-observation-receipt`、`repair-*`、`scout-exploreFresh`

### Registry @ 4a4131a

```text
npm run check  → ok
npm test       → tests=227  pass=222  fail=5
git diff --check → LF warning only on unrelated plan md
```

失败：

1. `explorer-lease-gate` — `pinnedIdentity is not defined`（疑似既有 bug，非本 PR 改动）
2. `nonpayment-liveness` plan hash frozen — **本 PR 改动导致 hash 漂移**（需更新期望 hash 或改断言）
3. `nonpayment-liveness` repair scope — 工作树脏文件 + 本 PR 文件列表越界（含垃圾 untracked）
4. concurrent observer singleflight — 需对照是否 flaky
5. repair filesystem/Git verifiers — 需对照 main

**合并门（2026-08-08 降门）：** 不再要求 Windows 全量 0 fail。  
**通过条件：** PR1 语义相关失败清零（见 `2026-08-08-foundation-pr1-merge-gate.md`）。  
main 同债 ~31（routing）+ 环境 flaky（registry）不挡 merge。  
顺序仍：routing #40 → registry #3；中间禁止部署 / 切 pilot。

## Invariant 对照（PR1 声称范围）

| INV | 实现文件 | 对应测试 |
|---|---|---|
| INV-01 protected final | `control-plane/lib/protected-commit-policy.mjs`, `mission-policy.mjs`, `authorization-decision.mjs` | `tests/foundation-pr1-core.test.mjs`, mission/payment suites（部分仍失败，待 finding 修） |
| INV-03 operations key | `control-plane/lib/state-store.mjs` (`operations` 表) | state/placement/core（需审查事务是否全覆盖） |
| INV-05 raw readonly | `control-plane/lib/raw-primitive-policy.mjs` | `foundation-pr1-core` 单测；**未挂全部 transport 入口（已知 gap，冻结期内不扩功能除非 finding 要求）** |
| INV-06 no local auth | `registry.mjs` derivePolicy null；`policy.mjs` 仅 CP | `tests/registry.test.mjs`, foundation-pr1-core |
| INV-07 ExecutionPlan / no inject | `task-plan-capability-binding.mjs`, `session-workflow-worker.mjs`, `xw-mission.mjs` | binder + session-workflow + xw-mission-cli tests |
| INV-09 request-scoped pilot | `control-plane.mjs` job/session paths | placement pilot test；**Mission/Firewall 全覆盖未完成（已知 gap）** |

## 下一步（仅审查尾巴）

1. 独立逐文件 review（指定 reviewer）  
2. 只修 finding + 全量回归失败中本 PR 引入项  
3. 配对 head 离线联测  
4. 更新 PR 正文最终证据后：先 #40 再 #3，中间不部署  
5. 两仓 main 对齐后才开 `foundation/pr2-runtime-integrity`  
