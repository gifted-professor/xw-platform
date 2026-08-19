# Skill Runtime v1（M4-A）

M4-A 只定义 **Stateful Skill Contract**：Skill 是版本化、带状态、带出口、带验证器的执行单元。

不改 Control Plane，不接手机，不接 DSH，不打开 Graph。  
`dshEnabled` 仍为 `false`。`DSH_LIVE_GATE = CLOSED`。`OPEN_ACTION_LIVE` 仍 CLOSED。

## 权威

| 层 | 谁拥有 | 本波做什么 |
| --- | --- | --- |
| Mission / Graph | Orchestrator（`missionRunId` 不是控制面 `MissionRuntime`） | 只预留关联 ID，不实现 Graph |
| SkillRun | Orchestrator / Skill Runtime | 状态机 + checkpoint |
| Harness session | 外部 Harness（DSH 只是其中一种） | Reference Harness 对照；禁止焊死 DSH |
| Action / Effect | Control Plane Action Ledger | 只引用 `actionId` / `evidenceRef`，不复制证据 |

叶子 Skill 只报告语义出口，不写死下一站。中央 Router 是后续波次；本波只禁止 `nextSkill`。

## Skill 出口

`COMPLETED CONTINUE REROUTE WAIT_HUMAN WAIT_EXTERNAL RETRY FALLBACK REPAIR_REQUIRED ABORTED`

合法例子：

```json
{
  "schemaId": "xw.skill.exit.v1",
  "schemaVersion": 1,
  "exit": "REROUTE",
  "reason": "target-page-not-found",
  "factsProduced": [],
  "openQuestions": [],
  "candidateIntents": ["repair-navigation", "reobserve-app-state"]
}
```

禁止：`nextSkill = xhs.publish`。

## 崩溃恢复

- 有 checkpoint：恢复到 checkpoint 状态，**不**重放手机动作。先查 XW Action Ledger，再恢复 Harness session。
- 无 checkpoint 且当时 RUNNING/VERIFYING：`AMBIGUOUS`，禁止自动 resume。

运行中的 SkillRun 绑定 `skillId + skillVersion`，中途不可换版。

## Harness 工具面

允许：`xw_skill_start|continue|checkpoint|complete`、`xw_phone_observe|act|verify`、`xw_trace_query`。

禁止：`control.db`、`registry.db`、`ADB`、`22222`、lease mutation、payment/policy override。

`packages/kernel/lib/skill-runtime.mjs` 里的 `ReferenceHarness` 证明这条协议不依赖 DSH。DSH adapter 是后续 M4-B，且只能进 `integrations/dsh-xw`。

## 样板

第一份 fixture spec 包装现有 `xhs.collect`（`services/orchestrator/skills/xhs/xhs-collect/`），不发明新的 `xhs.open-collection`。

## 文件

- `packages/kernel/contracts/skill/`
- `packages/kernel/event-protocol/skill-events.v1.json`
- `packages/kernel/error-codes/skill-error-codes.v1.json`
- `packages/kernel/lib/skill-runtime.mjs`
- `packages/kernel/test/skill-runtime.test.mjs`
