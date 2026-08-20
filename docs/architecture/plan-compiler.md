# Execution Plan Compiler（M4-D）

源码 only。M4-D 定义 **Skill 并行合同**（`xw.skill.parallelism.v1`）与 **Execution Plan**（`xw.execution.plan.v1`），并提供纯函数编译器把「目标 + SkillVersion + 并行合同 + 可用设备 + 预算」冻结成一份 Execution Plan。

不改 Control Plane，不接手机，不接 DSH，不打开 Graph。  
`dshEnabled` / `graphV2Enabled` / `multiAgentEnabled` 仍为 `false`。M5 Graph Runtime 不在本波。

## 五种并行模式

| mode | 语义 | 关键约束 |
| --- | --- | --- |
| `single` | 单分片单设备 | 强制 1 worker |
| `shardable` | 按 `splitDimensions` 从 `goal.variants` 切分 | `minimum_success` 需 `minimumSuccessfulShards` ≤ 分片数 |
| `replicated` | 同一输入复制 N 份 | `goal.replicas` 控制份数 |
| `device_affine` | 每分片编译期绑定指定设备 | 强制 `reassignable=false`；绑定设备离线则该分片 `assignedDeviceId=null`（partial），**绝不重绑**到别的设备 |
| `quorum_verify` | 生成 `quorumTotal` 个验证分片 | `quorumOf ≤ quorumTotal`，join 为 `quorum` + `minimum=quorumOf` |

主 mode 之外可用 `verificationMode` 单独声明验证方式；`dataClassification.classification=financial_sensitive` 时合同要求 `rawValueInHarnessLog=false`。

## 动态并发公式

```text
selectedWorkers = min(spec.maxWorkers, 合规设备数, 分片数, budget.maxWorkers)
requestedWorkers = min(spec.maxWorkers, 分片数, budget.maxWorkers)   # 设备钳制前的意图
single 恒为 1
```

合规设备 = 在线（`status != "offline"` 且 `online != false`）且满足 `deviceRequirements.profiles`。
合规设备数 < `minWorkers` → 抛 `INSUFFICIENT_DEVICES`，fail-closed，不产半成品 plan。

## 冻结 / append-only 语义

- `compilePlan()` 输出**深冻结**；同一输入重编译得到逐字节相同的 plan（`planRunId` / `shardRunId` 由输入内容 SHA-256 派生，不用随机数）。
- 模型可以建议并行方式，但 plan 由 XW 编译并冻结——运行期只读。
- `ShardRun.events` 是 append-only；`PlacementDecision` 一旦写下不改，`leaseId` 可空（编译期没有 lease）。

## 红线

- plan 绝不包含 lease / transport / payment 字段；输入里出现这类键直接 `PLAN_FORBIDDEN_FIELD`。
- `assignedDeviceId` 只是**申请意图**，不是 lease，不是 placement 承诺；真实 placement 由后续波次写 `PlacementDecision`。

## 与 M4-A/B/C 的边界

| 波次 | 拥有 | M4-D 怎么用 |
| --- | --- | --- |
| M4-A | Skill contract / SkillVersionRef / 状态机 | plan 通过 `skillVersionRef` 绑定不可变 SkillVersion；分片运行时仍是 M4-A SkillRun |
| M4-B | Harness-neutral protocol | 编译器无 I/O、无 harness 调用；分片执行才走 harness |
| M4-C | Experience Ledger / Router | Router 决定「要不要并行」，Plan Compiler 决定「并行成什么样」；本波不互相调用 |
| M5 | Graph Runtime | **不在本波**；plan 只是冻结文档，没有任何调度器消费它 |

`correlation-ids.v1` 追加 `planRunId / shardRunId / workerRunId / placementDecisionId / leaseId / joinRunId / reducerRunId / verificationRunId`（全部可选，additive）。

## 样板

fixture 包装现有 `xhs.collect` 的并行形态（搜索分片 / 设备亲和读取 / 2-of-3 验证），不发明新 skill。

机器门：`npm run test:m4d`。

## 文件

- `packages/kernel/contracts/parallelism/`（4 份 schema + fixture）
- `packages/plan-compiler/lib/plan-compiler.mjs`
- `packages/plan-compiler/fixtures/`
- `packages/plan-compiler/test/plan-compiler.test.mjs`
