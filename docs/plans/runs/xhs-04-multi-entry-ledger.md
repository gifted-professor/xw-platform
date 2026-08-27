# 04 多入口脚本包 — 执行台账

> append-only。每个 wave 开始/结束写一条：做了什么、证据指针、坑、决定。
> 计划：`docs/plans/xhs-04-multi-entry-executable-plan.md`；合同：`xhs-04-multi-entry-script-pack-execution-contract-v1.json`。
> 运行时基线：Fast-2 done（cd86c00，c7b0695 血系 schema 20，CP live）。

## W0 — 执行底座 + plan-only dispatcher

- start 2026-08-27。
- 探索结论（关键事实，供后续 wave 复用）：
  - Catalog `descriptorHashOf`（`scripts/lib/recipe-catalog.mjs:101`）= 全 spec canonical JSON sha256 **64-hex**；CP `computeDescriptorHash`（`control-plane/lib/recipe-interpreter.mjs:604`）= 投影 `rh_`+24hex。→ F1 统一到 64-hex（@2 起）。
  - live overlay `C:\Users\Public\xw-runtime\recipe-overlay\xhs-search-fixed.overlay.v1.json` 仍 rh_ 轨 + descriptorHash 占位 0；registry.db `recipe_versions` `xhs.search.fixed@1` = canary_only（hash 463c5fa3…，64-hex，2 attempts vOk/rOk=1，transition 链 candidate→replay_verified→promotable→canary_only）。
  - 04 routing_json 现 14 caps（含 xhs.comment.send、xhs.follow.ensure）；`xhs.follow.ensure` 在 capabilities 表 enabled=0。新 cap 只加 04 profile。
  - placement 过滤在 `placement.mjs:127` `profile.capabilityIds.includes(cap.id)`。
  - ECP 严格路径已存在：`state-store.mjs:4391 beginMissionEffect({softScope=false,softBudget=false})` + `effect-commit-protocol.mjs` + `mission-policy.mjs evaluateMissionEffect`；operationKey 概念已在 `m6-grounded-action-facade.mjs`。
  - vision 框架 `scripts/lib/m6/m6-grounding-runtime.mjs`：provider 构造期 pin（id/version/modelSha256/segment），默认 HERMETIC_FIXTURE_PROVIDER；真实像素参照 `ops/screenshot-and-analyze.mjs` 调 `~/Desktop/Coding/visual-grounding-poc/analyze.py`。
  - 无字面 `R2 => 需人工确认`；对应面 = `dag-compiler.mjs requiresHuman/humanGate=WAIT_HUMAN` + `task-plan.mjs` L3 human_gate → W0 改为透传中央 AuthorizationDecision（`control-plane/lib/policy.mjs`/`authorization-decision.mjs`），保留 fail-closed 行为。
  - **SKILL.md 文档先行坑**：`/xw messages`→`ops/xw-xhs-messages.mjs`、`/xw bench`→`xw-bench.mjs`、`/xw balance`→`xw-balance.mjs` 三个 .mjs **都不存在**（文档先于实现）。W0 把 `/xw messages` 改为指向新 dispatcher `xw-xhs.mjs inbox`，并收敛为 04-only（原文档默认 01,02,03,04 与计划冲突）。
  - 发布底座：`protected_commits` 表 + `protected-human-commit.test.mjs` 存在；公开 list/decide 面只接 payment → S4/W6 需 spike。

- **产物（W0 done，未提交）**：
  - `services/orchestrator/scripts/lib/xw-xhs-dispatcher.mjs` — 纯 dispatcher 库（无 fs/网络，可被测试 import）。12 action catalog（search/browse/inbox/read/like/collect/follow/nurture/comment/reply/publish prepare/publish send），backend 种类 fixed_recipe|r0_workflow|capability|composed，effectClass none|social|publish，gate 标注每 wave，`messages`→inbox 别名。
  - `services/orchestrator/ops/xw-xhs.mjs` — CLI（plan/json/execute/catalog）；`--execute` 走 `evaluateExecuteGate` fail-closed（W0 全 gated）；04-only 在 plan 阶段 `XHS_ALIAS_NOT_04` 拒绝（01–03 零 I/O）。
  - `services/orchestrator/tests/xw-xhs-dispatcher.test.mjs` — 25 测试全绿：catalog 完整性、三调用面同 planHash、effect budget（none/social/publish/nurture/compose payloadHash）、04-only 拒绝、operationKey 绑定、execute gate、golden planHash 稳定性。
  - `integrations/codex/skills/xw/SKILL.md` — 新增 `/xw xhs` 段；`/xw messages` 改为 `inbox` 兼容别名并收敛 04-only（原文档默认 01,02,03,04 与计划冲突，已改）。`xw:skill:install` + `xw:skill:check` 通过。
  - `package.json` 新增 `test:xhs-pack` = dispatcher 测试单命令。
  - `docs/plans/xhs-04-multi-entry-executable-plan.md` — 可执行计划（plan mode 产出）。

- **验收（W0）**：`npm run test:xhs-pack` 25/25 绿；CLI smoke：plan/json/execute-gated/alias01-rejected/messages 全部正确输出；所有入口 plan-only 输出 alias04/backend/budget/stopConditions；01–03 在 plan 阶段即拒绝（零 job/lease/I/O，pre-lease）。

- **决定/坑**：
  - `R2 => 需人工确认` 字面文案在代码中不存在（已核实全仓 grep）；等价面是 `dag-compiler.mjs requiresHuman/humanGate=WAIT_HUMAN` + `task-plan.mjs` L3 human_gate，属 m5 编排、不在 xhs pack 范围。pack 自身 CLI 已改为透出 AuthorizationDecision（effectClass + gate + nonpayment-autonomy 直执行 / publish 人工 commit），而非泛化人工确认文案。计划 S0 该条在 pack 范围内已满足。
  - `xw-xhs-messages.mjs`/`xw-bench.mjs`/`xw-balance.mjs` 三个 SKILL 引用的 .mjs 本就不存在（文档先行）。`/xw messages` 已改指 dispatcher；`/xw bench`、`/xw balance` 仍指向不存在的脚本，属既有遗留，不在本 pack 范围，留痕不动。
  - W0 全动作 `--execute` fail-closed；search live 晋级在 W1 开闸（届时 `evaluateExecuteGate(plan,{search:true})`）。

- end 2026-08-27。W0 完成。下一波 W1：canonical 64-hex 统一 + `xhs.search.fixed@2` 晋级（合同 F1）。