# Foundation PR2 wiring closure（2026-08-08 post-merge）

分支：`foundation/pr2-wiring-closure`（基于 main @ `a305f59`，PR3 已合入之后）

> **状态：Source fix ready for review · Not deployed · Pilot inactive**  
> 目的：补齐 PR2 合入后仍未强制消费的 integrity 接线，不进入 PR4 / 部署。

## 背景

PR2（registry `#4` / routing `#41`）与 PR3（`#5` / `#42`）已 source-merge，但重新审查发现：

- 完整性元数据已生成/持久化
- 真实执行链（Orchestrator → assignment → Worker → Receipt）仍可绕过

## 本分支修复（Approve 最小清单对照）

| # | 项 | 状态 |
|---|---|---|
| 1 | Orchestrator 强制 ExecutionPlan | ✅ `EXECUTION_PLAN_REQUIRED` |
| 2 | `sourcePlanHash` 严格匹配 | ✅ `EXECUTION_PLAN_SOURCE_MISMATCH` |
| 3 | `boundNode` 进入 assignment | ✅ `planUnits` + `buildAssignment` |
| 4 | Worker 删除本地授权推导 | ✅ 只证 catalog/appId/placement/CP decision |
| 5 | 单边 contract/closure presence fail closed | ✅ `runtime-integrity.mjs` |
| 6 | integrity-bound runtime 输出 WorkReceipt v2 | ✅ `createTerminalWorkReceipt` |
| 7 | pre-submit `jobId`/`controlPlaneRunId` 可为 null + `notSent` | ✅ schema + factory + catch |
| 8 | closure Windows/POSIX 路径规范化顺序 | ✅ lexical `\`→`/` 再 resolve |
| 9 | symlink fail closed | ✅ `IMPLEMENTATION_CLOSURE_SYMLINK` |
| 10 | `capabilityContractHashAlgorithm` 传播 | ✅ binder / manifest / receipt v2 |
| 11 | fake CP normal/drift/resume E2E | ✅ `tests/foundation-pr2-wiring-closure.test.mjs` |
| 12 | 冻结 HEAD 测试证据 | ✅ 见下 |

## 测试证据（本机 Windows）

```text
npm test → 254 tests, 252 pass, 2 fail
新增/改动 wiring 相关全绿（foundation-pr2-wiring-closure / orchestrator / worker / store / closure）
2 fail = 既有债（与本次无关）：
  - concurrent observer screen … singleflight
  - filesystem and Git verifiers …
npm run check → pass
```

规则：同名同根因 baseline 债可豁免；新增 wiring/integrity 失败不可豁免。

## 明确不做

- 不挂真实 Xianyu TCB manifest
- 不 Ready-for-Review 之外的 merge 压力（等人 review）
- 不部署 / 不重启 Windows 服务 / 不开 Pilot / 不进 PR4

## 合入建议

1. Review 本分支
2. Registry merge 后，routing 侧对照补同样的 presence / algorithm 传播（若尚未）
3. 两次合并中间禁止部署
4. 然后再谈 PR4 DeployShadow
