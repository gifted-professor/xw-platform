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
## W1 — canonical 64-hex 统一 + xhs.search.fixed@2 晋级（合同 F1）

- start 2026-08-27。

- **F1 canonical hash 统一（离线 machinery，已验证）**：
  - 新增 `services/control-plane/control-plane/lib/recipe-descriptor.mjs` — 单一 canonical 源。`canonicalDescriptorHash(spec)` = sha256(canonicalJson(spec 去掉 `descriptorHash`+`status`+`originRunId`))。三字段排除理由：descriptorHash 自引用；status 跨 promotion lifecycle 变化（candidate→canary_only，overlay≠Registry 会破 byte-identical 不变量 plan V2 §7.4）；originRunId 是 Catalog provenance bookkeeping（手写 spec 不带、ingest 时塞入 spec JSON + 独立 DB 列），非执行坐标。导出：canonicalize/canonicalJson/isCanonicalV2/DESCRIPTOR_HASH_SCHEME_V2="canonical-v2"。
  - `recipe-catalog.mjs`：import 共享源并 re-export；`descriptorHashOf` 委托 `canonicalDescriptorHash`（无 status 的 spec 值不变）；`buildOverlayDocument` 改为 spread `canonicalize(spec)` 全 sealed spec + override recipeId/revision/status/descriptorHash + passthrough descriptorHashScheme → overlay 可独立复算 hash。
  - `recipe-interpreter.mjs`：`computeDescriptorHash` scheme-aware（isCanonicalV2 → 64-hex；否则 legacy rh_+24）；导出 `isCanonicalV2Recipe`。
  - `single-device-recipe-runner.mjs`：seal/tamper block 改为 `computedHash = computeDescriptorHash(loaded)`；placeholder(0×64) 接受、rh_ 旧 spec 和 v2 spec 都走 mismatch 拒绝、sealed 覆写 computedHash。
  - 生产 spec `services/control-plane/config/recipes/xhs.search.fixed@2.json` — canonical-v2，descriptorHash `6b7a505e…`，含 noRefocus/clearFirst/pages max=1/完整 restoration+failurePolicy。fixture 不再是生产真源。
  - **坑（关键）**：初版 canonicalDescriptorHash 含 status → overlay(canary_only) hash ≠ Registry(candidate) hash，破不变量。改为排除 status 后重 stamp @2（f7aa537f… → 6b7a505e…）。之后发现 ingest 把 `originRunId:null` 塞进 spec JSON（手写 spec 无此字段）→ overlay entry hash 偏移（d3088191…）。再排除 originRunId 后五消费者字节一致。

- **dispatcher 版本地图 + 晋级桥（离线 machinery，已验证）**：
  - `xw-xhs-dispatcher.mjs`：新增 `DEFAULT_RECIPE_REVISIONS`（search@1/browse@1 冻结基线）+ `resolveRecipeRevision(recipeId, overrides)`（override 优先，0/NaN 回退 default）；`planAction` 接受 `recipeRevisions` 参数，fixed_recipe plan 输出 `recipeRevision` 并绑入 planHash（§11 rollback boundary，search@1 ≠ search@2 的 planHash）。
  - `services/control-plane/config/xhs-dispatch-state.json` — dispatcher 可部署状态（recipeRevisions + liveGates），`switch-alias` 原子更新。
  - `ops/xw-xhs.mjs`：启动加载 `xhs-dispatch-state.json`（env `XHS_DISPATCH_STATE` 可覆盖），传 `recipeRevisions` 给 `planAction`、`liveGates` 给 `evaluateExecuteGate`。
  - `ops/xw-recipe-promote.mjs`：`loadFixtureSpec` 改为 production-first（`config/recipes/<id>@<rev>.json` 最高 revision，回退 fixture @1）；`cmdIngest` 幂等改为 per (recipeId,revision)（@2 新 revision 不被 @1 idempotent 挡）；新增 `switch-alias`（fail-closed：仅 canary_only/implemented 才改 dispatch state + flip liveGate，返回 {ok} 而非 process.exit 便于测试）+ `emit-overlay`（buildOverlayDocument→原子写）。
  - `ops/xw-xhs-promote.mjs` — 一键晋级链（sedimented fixed task）：ingest production spec → 逐 recipeRunId 从 CP fetch + promote → evaluate → switch-alias(fail-closed) → emit-overlay。live recipe-run 在设备侧跑，此脚本吃 server-verified recipeRunId。

- **测试（全绿）**：
  - `recipe-descriptor-hash-v2.test.mjs` — 12 测试：@2 是 canonical-v2/64-hex、独立 oracle 字节一致 stamped hash、Catalog=shared=stamped、CP scheme-aware（@2 64-hex / @1 rh_+24 回归保护）、Runner plan-mode seal、Catalog ingest+overlay+promotion receipt 同 hash、clearFirst/pages/postAssertion 三点 mutation、tamper 拒绝、placeholder 接受、path exercise。
  - `xhs-promote-chain.test.mjs` — 4 测试：ingest @2 via loader、两次 live @2→canary_only→switch-alias→overlay 带 @2、switch-alias fail-closed(candidate)、re-promote 幂等。
  - `xw-xhs-dispatcher.test.mjs` — 31 测试（+6 版本地图：resolveRecipeRevision default/override、plan 带 recipeRevision、planHash 随 revision 变、非 fixed_recipe=null、frozen 基线）。
  - `recipe-promote.test.mjs` — 6 测试（Fast-2 桥回归无破）。
  - `npm run test:xhs-pack` = 53/53 绿。hash 回归套件（catalog/spec/runner-fast2/overlay）31/31 绿。

- **决定/坑**：
  - canonical hash 排除三字段（descriptorHash/status/originRunId）而非两字段——originRunId 是 ingest 时塞入 spec JSON 的 provenance bookkeeping（手写 spec 不带），不排除则 overlay entry hash 偏移。已写进 recipe-descriptor.mjs 注释。
  - `cmdSwitchAlias` 返回 `{ok:false}` 而非 `process.exit`——CLI main 转 fail()，测试可断言返回。`--state-path` override 便于测试用 temp 文件。
  - @1 legacy 完全不动（rh_+24 投影 + immutable receipt evidence），F1 只管 @2+。

- **待办（live，需设备/operator）**：两次独立 04 live @2 recipe-run → `xw-xhs-promote.mjs --recipe xhs.search.fixed --runs <a>,<b> --action search --runtime` → canary_only → switch-alias → alias 切 @2 后一次 @2 live search 复核。离线 machinery 全就绪，只差 live canary。

- end 2026-08-27（离线部分）。W1 离线 done，live canary 待 operator。
