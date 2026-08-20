# Skill Runtime v1（M4-A）

M4-A 只定义 **Stateful Skill Contract**：Skill 是版本化、带状态、带出口、带验证器的执行单元。

不改 Control Plane，不接手机，不接 DSH，不打开 Graph。  
`dshEnabled` 仍为 `false`。`DSH_LIVE_GATE = CLOSED`。`OPEN_ACTION_LIVE` 仍 CLOSED。

## 权威

| 层 | 谁拥有 | 本波做什么 |
| --- | --- | --- |
| Mission / Graph | Orchestrator（`missionRunId` 不是控制面 `MissionRuntime`） | 只预留关联 ID，不实现 Graph |
| SkillRun | Orchestrator / Skill Runtime | 状态机 + 跨进程 checkpoint/restore |
| Harness session | 外部 Harness（DSH 只是其中一种） | Reference Harness 对照；禁止焊死 DSH |
| Action / Effect | Control Plane Action Ledger | restore 前必须对账；本波用 fixture verdict |

叶子 Skill 只报告语义出口，不写死下一站。中央 Router 是后续波次。

## 不可变 SkillVersionRef

运行中绑定的不只是 SemVer，而是内容摘要：

```json
{
  "skillId": "xhs.collect",
  "skillVersion": "1.1.0",
  "skillSpecSha256": "<canonical SkillSpec SHA-256>",
  "sourceCommit": "<40-hex>",
  "sourcePath": "services/orchestrator/skills/xhs/xhs-collect/SKILL.md",
  "sourceBlobSha": "<40-hex>"
}
```

恢复时：当前 spec digest == `SkillRun.skillVersionRef.skillSpecSha256` == `Checkpoint.skillVersionRef.skillSpecSha256`，否则 `SKILL_SPEC_DIGEST_MISMATCH`。

## 出口与 intent

`COMPLETED CONTINUE REROUTE WAIT_HUMAN WAIT_EXTERNAL RETRY FALLBACK REPAIR_REQUIRED ABORTED`

`candidateIntents` 必须是 `intent:…`，禁止 `xhs.publish` / `skill:` / 任意 skillId。

```json
{
  "schemaId": "xw.skill.exit.v1",
  "schemaVersion": 1,
  "exit": "REROUTE",
  "reason": "target-page-not-found",
  "candidateIntents": ["intent:repair-navigation", "intent:reobserve-app-state"]
}
```

## 跨进程恢复

```text
Machine A start → checkpoint → serialize() → JSON
丢弃 A
Machine B = SkillRunMachine.restore({ spec, run, checkpoint, reconciliation })
```

`resume()` 不能只靠同对象内存。checkpoint 必须绑定 `skillRunId / skillId / skillVersion / traceId / missionRunId / skillVersionRef / seq`。

无 checkpoint 崩溃：`state=AMBIGUOUS`，`exit=null`，`recoveryRequired=true`，发 `xw/recovery-required`。这不是操作员 `ABORTED`。

## Action Ledger 对账

`restore()` 必带 `reconciliation.status`：

| status | 行为 |
| --- | --- |
| `NO_UNRESOLVED_EFFECTS` | 允许继续（且 run 上不能有未验证 action） |
| `ALREADY_VERIFIED` | 允许继续 |
| `AMBIGUOUS_EFFECT` | 拒绝，`AMBIGUOUS` + `REPAIR_REQUIRED` |

checkpoint 后已请求 phone action、尚无 verified receipt：自动 restore 必须被拒绝。`phoneActsEmitted = 0` 不是安全证明。

## Harness 工具面

允许：`xw_skill_start|continue|checkpoint|complete`、`xw_phone_observe|act|verify`、`xw_trace_query`。

禁止：`control.db`、`registry.db`、`ADB`、`22222`、lease mutation、payment/policy override。

## 样板

fixture spec 包装现有 `xhs.collect`，不发明 `xhs.open-collection`。

机器门：`npm run m4a:accept`。

## 文件

- `packages/kernel/contracts/skill/`
- `packages/kernel/lib/skill-runtime.mjs`
- `packages/kernel/lib/m4a-accept.mjs`
- `packages/kernel/test/skill-runtime.test.mjs`
