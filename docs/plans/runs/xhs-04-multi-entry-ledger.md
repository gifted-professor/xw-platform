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

## W2 — 04-only placement 证明（合同 F2，S2 前置）

- start 2026-08-27。

- **探索结论（placement/routing infra）**：
  - 过滤核心 `placement.mjs:127`：`if (!profile.enabled || !profile.capabilityIds.includes(capability.id)) return false`。`routing_json` 存 `devices` 表（control.db），shape `{enabled, tags, capabilityIds}`。写经 `StateStore.upsertDevice({alias, routingProfile})`；读经 `getDevice(id,{includeRuntime:true}).routingProfile`。
  - `assertCapabilityRoutable` 先于 device 过滤：`ROUTABLE_AVAILABILITY={implemented,approval_gated}`，不可路由 → `NO_ELIGIBLE_DEVICE`(409) 在 device filter 前。capability manifest 的 `automationPolicy.mode`（lab_only/automatic/approval_required/disabled）影响 authorization 不影响 routability。
  - `selectPlacement`：session/composite_action 的 `eligible = matching.filter(effectiveLoad===0)`；`selected` 空时 `acquiringSession && matching.length>0` → `DEVICE_BUSY`(423)，否则 `NO_ELIGIBLE_DEVICE`(409)。job 的 `eligible=matching`（busy 不排除，job 排队）。
  - `syncCapabilities(registry)` 全量同步（先 `UPDATE enabled=0` 再 upsert 供给的）——会 disable 未供给的 cap，additive 注册需先读现有 enabled caps union 再 sync。
  - `planRoute` advisory 错误返回 `{decision:"blocked",error:{code,message,details}}`（无 status 字段）；`createJob`/`createSession` throw `{code,status}`。

- **产物**：
  - `services/control-plane/tests/xhs-04-placement-boundary.test.mjs` — 6 测试全绿（合同 F2）：
    1. 每 social cap（like/collect/follow）+ alias 01/02/03 → `planRoute` error NO_ELIGIBLE_DEVICE + `createJob` throw NO_ELIGIBLE_DEVICE(409)，且 jobs/sessions/leases/transport 四项 delta=0（transport 用 adapter execute 计数器）。
    2. 无 alias → plan 只解析 04（01-03 不带 social caps）。
    3. 无 alias createJob → assigned to 04。
    4. 04 busy（持有 session）→ createSession DEVICE_BUSY(423) 不 fallback 01-03；显式 alias 01-03 → NO_ELIGIBLE_DEVICE。
    5. quarantine 04 → NO_ELIGIBLE_DEVICE 不 fallback。
    6. 01-03 routingProfile 不含任何 social capId，04 含全部三个。
  - `services/orchestrator/ops/xw-xhs-capabilities.mjs` — 沉淀的可重放注册脚本（apply/diff，--runtime/--db）：additive sync（读现有 enabled caps union xhs 集，避免 disable 其他 app）+ 只把 capIds merge 进 04 的 routingProfile（01-03 不动）。idempotent：re-apply no-op。smoke 验证 apply→seed 04 5 caps、diff→no change、apply2→IDEMPOTENT。

- **验收（W2）**：`npm run test:xhs-pack` 59/59 绿（53 + 6 F2）。此测试是 W4 social live canary 的硬前置（脚本 gate，非人工）。

- **决定/坑**：
  - `planRoute` error 对象无 `status` 字段（advisory 返回 `{code,message,details}`），与 `createJob`/`createSession` throw 的 `{code,status}` 不同——测试分别断言。
  - `getDevice(id).routingProfile` 默认不返回（`includeRuntime:false`）；要读 routingProfile 须 `getDevice(id,{includeRuntime:true})`。
  - capabilities 用 `availability:"implemented"` + `automationPolicy:"approval_required"` —— routable 但 social 需审批；placement 边界与 automation mode 无关（placement 先于 authorization）。
  - W2 注册 5 个 social cap（like/collect/follow/comment/dm），W4/W5 绑 adapter 时用同 id。

- end 2026-08-27。W2 完成（全离线，无需 live）。下一波 W3：R0 browse/inbox/read + 真实 vision 导航（VISION）。

## W3 — R0 browse/inbox/read + 真实 vision 导航（合同 VISION，S1 后半）

- start 2026-08-27。

- **探索结论（vision/explorer infra，Explore agent 全量回报）**：
  - `m6-grounding-runtime.mjs` provider pin 接口 = 构造期冻结 `{id, version, modelSha256(64-hex), segment(frame,evidence)->rawBlocks[]}`；pinnedProvider 写进每个 blockSet 的 `segmentation` 字段，per-call override 被忽略。blockId 由 runtime 经 `deriveBlockId` 派生（非 provider）；坐标只进 evidence store bounds blob，block surface 无坐标泄漏。
  - `segmentBlocks` 输出 `xw.visual-block-set.v1`，schema 要求 `blocks.minItems:1` → **空标注 → segmentBlocks fail-closed（ok:false, blockSet:null）**，decide 根本无法触达。这是 vision 不可用时的最强"不瞎点"契约。
  - `decide()` 六项 grounding check：freshness/focus/ambiguity(同 label 兄弟>0 → REPLAN)/safe-region/sensitive-label(category payment|delete → FAIL→HARD_STOP)/confidence(>=0.8)；+ hard-redline firewall（独立扫 blockSignals ocrText/semanticLabel 的 payment/delete 词，DSH/grant 不可覆盖）；+ REDLINE_EFFECT_CLASSES（effectClass payment|delete → HARD_STOP）。
  - offline（m6-grounding-runtime，HERMETIC_FIXTURE_PROVIDER）与 live（packages/kernel/lib/m6-live-grounding.mjs，parseUiTree+deriveLiveVisualBlockSet）是**结构性分离**（version-boundary test 字节 pin），不是 runtime guard。计划要求"live mode 显式拒绝 HERMETIC_FIXTURE_PROVIDER" → 需新增显式 guard（本次实现）。
  - Explorer session 生命周期：`_explore-lease.mjs` acquire（POST /control/v1/sessions，binding 全字段校验，ACL 硬化 context 文件）→ verify→release。bounded primitives（`_explore-session-action.mjs`）：screen/dump_ui/focus/tap/swipe/back/launch_app/input_text，shell 被拒。dump=dump_ui → dump-ui.xml（Android hierarchy）。
  - `ops/screenshot-and-analyze.mjs` 已包装 analyze.py（→ .elements.json），但是 CLI 形态，**没有 provider-pin adapter**。analyze.py 输出元素 shape `{label, bounds, center, conf, source}`。
  - thread fingerprint **无任何现存实现**（仅计划文档），dispatcher catalog 已定义 stop condition `thread fingerprint not unique`，`operationKey=sha256(actionRunId+action+targetFingerprint+payloadHash)`。

- **产物（离线 machinery，全绿）**：
  - `xhs.browse.fixed@1` 生产 spec（13 步 R0 只读：launch→settle→swipe×5+wait×5→screenshot→back，无 tap/input/callCapability）canonical-v2 hash `494773e9…`，eligibleAliases ["04"]，riskCeiling R0，inputSchema swipes/minutes。fixture 不再是生产真源。
  - `services/control-plane/tests/xhs-browse-recipe.test.mjs` — 7 测试：canonical-v2/64-hex、13 步全在 primitive 白名单且 R0 无互动、validateRecipeExecutor 接受、五消费者同 hash、Runner plan-mode seal、swipe 坐标 mutation 改 hash、dispatcher browse→xhs.browse.fixed@1(R0,RECIPE,gate W3)。
  - `services/orchestrator/scripts/lib/m6/real-vision-provider.mjs` — 真实 vision provider adapter（合同 VISION）：
    - `createRealVisionProvider({loader, modelSha256, version})`：把 analyze.py（或等价真实像素）的标注 loader 注入 provider-pin shape（id `xhs-real-vision-v1`）。`segment(frame,evidence)` 调 loader→标注[]，每标注映射成 raw block（regionHash=`sha256("xw.region.rv:"+canonicalJson({frameId,stableIndex,label,category,bounds}))`，blockId 经 deriveBlockId，geometry+signals 进 evidence.bounds blob，category 经 classifyCategory）。loader 返回 []/null/throw → 返回 []（**永不伪造导航块**；配合 schema minItems:1 → segmentBlocks fail-closed）。
    - `classifyCategory(label)`：PAYMENT_RE/DELETE_RE/NAV_RE → payment/delete/system-navigation/content。classifier 准确分类，redline firewall 独立扫 signals 做兜底（双层）。
    - `assertLiveGroundingProvider(provider)`：显式 live guard（计划要求）——provider.id===HERMETIC_FIXTURE_PROVIDER.id → throw `LIVE_GROUNDING_REJECTS_HERMETIC`；modelSha256 非 64-hex → throw；segment 非函数 → throw。live 误配 fail-closed 而非静默跑 fixture。
  - `services/control-plane/tests/xhs-visual-navigation-boundary.test.mjs` — VISION 三 probe 共 6 测试：
    1. 独立标注 oracle：oracle 用同公式（m6-contracts）重算每块 regionHash+blockId，与 provider 输出字节一致；block surface 无坐标泄漏；blockSet.segmentation=REAL_VISION_PROVIDER_ID（非 fixture）；determinism（重 segment 同 integritySha256）。
    2. block mutation：改 block.category=payment → integritySha256 mismatch → decide ok:false；provider 正确分类"确认支付"=payment → decide HARD_STOP（sensitive-label + redline 双层）。
    3. dump fallback 阶梯：empty/throwing/null loader → segmentBlocks fail-closed（ok:false, blockSet:null，无法 decide）；唯一 R0 导航（一个"返回"system-navigation，in-bounds geometry，conf 0.95）→ ALLOW_ONCE + resolveInternalPoint 一次性点（replay 拒绝）；重复 label（两个"返回"）→ ambiguity FAIL → REPLAN（不唯一 stop）；live guard 拒 HERMETIC_FIXTURE_PROVIDER、接受 real provider、非 64-hex modelSha256 双层拒。
  - `services/orchestrator/scripts/lib/xhs-thread-fingerprint.mjs` — inbox/read R0 唯一性 gate（"唯一才进，不唯一 stop"）：
    - `threadFingerprintOf(entry)`=sha256("xw.xhs.thread:"+normalize(peer)+"|"+resourceId)——stable identity（peer+slot），**排除 snippet**（last message 每 msg 变，W5 用 lastMessageFingerprintOf 单独 hash 漂移检测）。
    - `resolveUniqueThread(entries,fp)`/`resolveUniqueThreadByLabel(entries,label)`：恰好 1 match → unique（进）；0 或 >1 → 不 unique（stop）。mirror decide() ambiguity check。
    - `parseDumpNodes(dumpXml)`：轻量提取 dump-ui.xml 的 text-bearing node（text/resourceId/bounds/className），空/垃圾输入安全。
    - `extractConversationEntries(dumpOrNodes)`：dump 字符串或预 shape entry[] → 带 threadFingerprint+lastMessageFingerprint 的 entries。
  - `services/control-plane/tests/xhs-thread-fingerprint.test.mjs` — 10 测试：deterministic/stable、同名不同 slot→不同 fp、boundary 空格归一化（内部 CJK 空格不剥离——"小 书童"≠"小书童"是合法区分）、thread fp 排除 snippet/lastMsg fp 随 snippet 变、resolveUniqueThread 唯一/0/多、resolveUniqueThreadByLabel、parseDumpNodes、extractConversationEntries、dispatcher inbox/read=r0_workflow/gate W3/adaptiveRoute DUMP/read 必填 thread、messages→inbox 别名。

- **测试（全绿）**：`npm run test:xhs-pack` = 82/82 绿（59 + 7 browse + 6 vision + 10 thread-fingerprint）。新增三测试文件已加入聚合脚本。

- **决定/坑**：
  - **schema minItems:1 是契约而非 bug**：empty 标注 → segmentBlocks 直接 fail-closed（blockSet:null），decide 不可达。比"0 块但 ok"更强——workflow 根本拿不到可决策面，杜绝瞎点。测试 3a 改为断言 ok:false + blockSet:null。
  - real provider 的 `segment` 不用 `this`（loader 经闭包），`pinnedProvider.segment.bind(provider)` 安全。modelSha256 注入式（live 部署 pin 真 analyze.py 模型 hash，测试用 FIXTURE_MODEL_SHA256="a"×64）。
  - **CJK 空格归一化边界**：normalizeLabel 只 trim+collapse 空白 run，**不剥离内部 CJK 空格**——"小 书童"（内部空格）与"小书童"是不同显示串，fingerprint 不应静默合并。测试用 boundary-only 空格证归一化，内部空格的区分性单独留痕。这是有意的（避免误合并不同条目）。
  - vision adapter **不复用** live kernel 的 deriveLiveVisualBlockSet（那是 dump XML 路径，结构性分离）；real-vision-provider 是 grounding runtime 的 provider-pin 实现，analyze.py 路径与 dump 路径并存（dump fallback ladder：vision 不可用→无块→stop，不回退 fixture）。
  - inbox/read 是 `r0_workflow` backend（Explorer acquire→dump→只读采集→release），**W3 不 tap**（read-only collection 止于 dump）；进 thread（tap）是 W5 reply 的 effect。thread fingerprint W3 做初版，W5 formalize last-message fingerprint 漂移检测。

- **待办（live，需设备/operator）**：search@2 / browse / inbox / read 各 2 次独立 04 receipt（probe+tap 原子执行坑已知）。browse live 晋级走 `xw-xhs-promote.mjs --recipe xhs.browse.fixed --runs <a>,<b> --action browse --runtime`（桥已就绪，@1 hash 494773e9）。inbox/read 是 r0_workflow 非 fixed_recipe，不走 recipe 晋级桥——live 执行经 Explorer session + real-vision provider adapter（live 部署需 pin 真 analyze.py modelSha256 + 接 screenshot-and-analyze 输出）。离线 machinery 全就绪，只差 live canary。

- end 2026-08-27（离线部分）。W3 离线 done（browse+vision+thread-fingerprint 全绿），live canary 待 operator。下一波 W4：like/collect/follow + nurture（合同 F3）。

## W4 — like/collect/follow + nurture（合同 F3，S2）— 离线 done 2026-08-27

- **产物**：
  - `services/orchestrator/tests/xw-xhs-effect-budget.test.mjs` — F3 严格 Mission 预算纯 plan-time 不变量（9 测试）：perTargetCount=1（每 target 恰一次 transport）/ like/collect/follow count bounded 1..20（参数边界 pre-budget 拒）/ comment capped count=1 / operationKey 计划期 deferred（target 未知）但绑定后 deterministic——(action,target,payload) 碰撞即 replay 边界 / payloadHash content-bound（comment=sha256(text), reply=sha256(text+thread), like/collect/follow=null）/ nurture 默认 browse-only + 每 explicit social count 一 Mission + ceiling 20 / budget+mission frozen（tamper-evident）/ none+publish 不变量。从 dispatcher 抽 bindOperationKey/effectBudget/normalizeParams/planAction/XHS_ACTION_CATALOG 直接验证。
  - `services/control-plane/apps/xhs/social-verifiers.mjs` — 纯 state classifier（无 fs/net/device IO），从旧 ops 脚本抽出为单一真相源：
    - `likeState`（faithful _xhs-parse.mjs:136-142）：已点赞→liked（terminal，先于 点赞 检查因含子串）/ 点赞→unliked / ""→missing / else unknown。
    - `collectState`（faithful xhs-collect-one.mjs:88-93）：已收藏→collected / 收藏→uncollected。
    - `followState`（faithful _xhs-parse.mjs:503-509）：已关注|相互关注→followed（先检查避免 关注 子串假阳）/ 关注|回关→unfollowed。注意：substring classifier，调用方须用 exact-set locator（FOLLOW_LABELS）防"关注的话题"假阳——classifier 自身文档为 substring-only。
    - `socialEffectDecision({action, beforeState})` → {skip, reason, transport}：already-true（liked/collected/followed）→ skip=true, transport=0（不进 ECP，不耗 perTargetCount）；actionable pre-state（unliked/uncollected/unfollowed）→ proceed, transport=1；missing/unknown → unknown-state, transport=0（**不瞎点，REPLAN 而非 skip**）。这是 run-time ladder 在 beginMissionEffect 之前的决策——已完成的 target 永不进 ECP，perTargetCount=1 只守真正的状态转换。
    - `isAlreadyTrue(action, beforeState)` / `ALREADY_TRUE_STATE` / `STATE_CLASSIFIER` frozen 映射。
  - `services/control-plane/tests/xhs-social-action-run.test.mjs` — F3 三 probe run-time 不变量（5 测试，对真实 StateStore+MissionRuntime+DeviceRunRuntime，无 mock）：
    1. **并发 reservation 竞争**（perTargetCount=1）：首个 like fp-a reserve 成功；第二个 like 同 fp-a（不同 idk）→ BUDGET_PER_TARGET_EXCEEDED(409)——每 target 恰一次 transport，即便首个未 release；不同 target fp-b proceed；totalCount=2 满后 follow fp-c → BUDGET_EXCEEDED(409)。blocked attempt 不泄漏 reservation（effects 恰 2 条）。
    2. **伪造绑定/禁盲重试 fence**（AMBIGUOUS_NO_RETRY）：ambiguous outcome → recordMissionEffectOutcome retry_blocked=1 on (mission,action,target)；同 triple 新 idk 重试 → AMBIGUOUS_NO_RETRY(409)（retry-block fence 在 budget gate 之前检查，新 idk 无法绕过）；不同 target（fp-y）同 action proceed；不同 action（collect）+新 target（fp-z）proceed——fence 是 per-triple 非 mission-wide。
    3. **replay + already-true skip**：(3a) 同 idempotencyKey → reused:true, 同 effectId, 无新行（重跑 no-op 非 double-send）；(3b) social-verifiers classifier 忠实性 + socialEffectDecision already-true skip / proceed / unknown-state（不瞎点）/ unknown-action；(3c) 已 liked target 经 socialEffectDecision skip → 不调 beginMissionEffect → 预算未耗（effects=0）；真转换 unliked→proceed 才开 reservation（effects=1）。
  - idempotencyKey 经 `bindOperationKey({actionRunId, action, targetFingerprint, payloadHash})` 派生——W4 wiring（operationKey→ECP idempotencyKey），live canary 实跑此链。
  - `services/orchestrator/ops/xw-xhs-capabilities.mjs` — 5 个 XHS social cap 加 `exposure:"public"` + `invocationPolicy:{allowedModes:["mission_effect"]}`（canonical mission-only gate，authorization-decision.mjs:55 / placement.mjs:78 消费的对象形式，非新 string）。apply 经 syncCapabilities→validateCapability 验证通过，幂等 re-apply no-op。W2 离线 placement 测试用自含 fixture（自带 SOCIAL_CAPS manifest，无 invocationPolicy），不受影响——invocationPolicy 只作用于 live apply 路径（xw-xhs-capabilities.mjs apply --runtime 写真 control.db）。

- **测试（全绿）**：`npm run test:xhs-pack` = 96/96 绿（82 + 9 effect-budget + 5 social-action-run）。两新测试文件已加入聚合脚本。

- **决定/坑**：
  - **invocationPolicy=mission_only 用对象形式 `{allowedModes:["mission_effect"]}`**：计划写 "invocationPolicy=mission_only"（string）是 NEW，但仓库既有 mission-only cap（xhs.collect.standing_grant）用对象形式 allowedModes。authorization-decision.mjs:55-56 + placement.mjs:78-79 都读 `capability.invocationPolicy?.allowedModes`（array includes 检查），没有读 string 形式。复用对象形式 = 复用既有 enforcement path，不造新分支。
  - **W2 placement 测试不受 invocationPolicy 影响**：W2 测试自含 fixture（自带 SOCIAL_CAPS manifest 无 invocationPolicy），不走 xw-xhs-capabilities.mjs 的 manifest。invocationPolicy 只经 live apply 路径写真 control.db。两路径分离——离线 placement boundary proof 与 live mission_only enforcement 各自独立可验。
  - **assertCapabilityRoutable 在 device-capability filter 之前**（placement.mjs:113 先于 :127）：mission_only cap 经 planRoute(job)/createSession(session) 会被 CAPABILITY_INVOCATION_FORBIDDEN(403) 挡在 device filter 之前。这是对的——social effect 不走 job/session，走 mission_effect（ECP）。W2 的 planRoute/createSession 代理只对自含 fixture（无 invocationPolicy）有效；live social effect 必经 ECP mission_effect 路径，F3 三 probe 已证此路径的预算/重试/fence。
  - **already-true skip 是预算守门的关键**：已 liked/collected/followed 的 target 经 socialEffectDecision skip → 不进 beginMissionEffect → perTargetCount=1 不被已完成 target 消耗。这让重跑已完成的 like 是 zero-effect no-op 而非 double-send，且预算只守真正状态转换。socialEffectDecision 在 ECP reservation 之前执行（run-time ladder），F3 probe 3c 证此。

- **待办（live，需设备/operator）**：每 cap（like/collect/follow）一次有界 04 canary（before/after state + exactly-once transport + ledger 核对）。nurture live= browse-only 默认 + 显式 counts 各建严格 Mission。离线 machinery 全就绪（effect-budget + social-verifiers + social-action-run 三测试 + capabilities mission_only），只差 live canary。

- end 2026-08-27（离线部分）。W4 离线 done（F3 strict-mission budget + already-true skip + no-retry fence 全绿），live canary 待 operator。下一波 W5：comment + DM（S3，formalize last-message fingerprint）。

## W5 — comment + DM（S3）— 离线 done 2026-08-27

- **产物**：
  - `services/control-plane/apps/xhs/comment-verifier.mjs` — 纯 comment-send 验证，替换旧 `xhs-comment-one.mjs:301-322` 弱验证（"composer closed after send"=pass）。三因子强证明：(1) exactTextHashPresent——note 已发评论含 text hash === commentTextHash(sentText)（文本须是**已发评论**非 composer 输入）；(2) countDelta——评论数严格递增 after>before；(3) ownLatestComment——最新评论（postedComments[0] newest-first）是我的且 text hash 匹配。三因子全中→verified；弱"composer-closed"（composer 关但无已发评论+无 count delta）→**降为 ambiguous**（不再 verified，no-blind-retry fence 适用）；text-present-no-count-delta→ambiguous（stale/replay）；count-delta-text-missing→ambiguous（别人评论了）；composer 仍开/发送键在→not_sent。text+count 但 peer 抢发新评论（ownLatest false）→仍 verified（ownLatest 是强化非硬门，我的评论确实发了）。`commentTextHash`=sha256(`xw.xhs.comment.text:`+text)（node:crypto，零三方）。`extractPostedComments` 滤 UI 标签（评论/点赞/收藏/纯数字）留正文。
  - `services/control-plane/apps/xhs/dm-verifier.mjs` — 纯 DM reply 验证，替换旧 `xhs-dm-user.mjs:216-221` 模糊用户名阶梯 + `:340-344` 弱验证（"tapped-send"/"input-cleared"=pass）：
    - `usernameMatch(target, observed)`：exact/`fuzzy`/none。fuzzy = target 是 observed 子串 OR 4-char 前缀碰撞（旧 `.includes(user)`/`user.slice(0,4)` 阶梯命中类）→**禁发**。
    - `decideDmReplySend`（pre-send 三门）：USERNAME_FUZZY/USERNAME_NONE→不 send；THREAD_NOT_UNIQUE(0)/THREAD_AMBIGUOUS(>1)→不 send（W3"唯一才进"gate 绑入 DM 决策）；LAST_MESSAGE_DRIFT（observed last-msg fp ≠ expected，peer 插话）→不 send；全过→proceed。
    - `verifyDmReplySend`（post-send）：thread 新 last-msg fp === expectedReplyLastMessageFingerprint(sentText)=`lastMessageFingerprintOf({snippet:sentText})`→verified；弱"tapped-send"（composer 关但最新消息非我）→ambiguous（不再 verified）；composer 仍开→not_sent。
    - **关键复用**：post-send 用 W3 `lastMessageFingerprintOf`（`xw.xhs.lastmsg:` namespace）算期望 fp——pre-send drift 检查与 post-send verify 共享**同一身份层**，非两套 hash。import 自 `xhs-thread-fingerprint.mjs`。这是计划"inbox/read thread fingerprint 补齐（W3 部分的正式化）"——W3 模块正式作为 DM 绑定身份层。
  - `services/control-plane/tests/xhs-comment-dm-bound.test.mjs` — 21 测试：comment 强验证/弱验证拒（composer-closed→ambiguous, text-no-delta, count-no-text, composer-open→not_sent, peer-interleaved→verified）/hash 确定性/extractPostedComments；dm usernameMatch exact/fuzzy/none、decideDmReplySend 四门（USERNAME_FUZZY/USERNAME_NONE/THREAD_NOT_UNIQUE+AMBIGUOUS/LAST_MESSAGE_DRIFT/proceed）、verifyDmReplySend（verified/弱 tapped-send→ambiguous/not_sent）、thread+last-msg fp 组合身份；**F3 fence**：ambiguous comment/reply outcome→recordMissionEffectOutcome retry_blocked→同 triple 重试 AMBIGUOUS_NO_RETRY(409)（real StateStore，fence 在 budget 前），不同 target 不 fence（per-triple）。idempotencyKey 经 bindOperationKey 派生（payloadHash=commentTextHash）。
  - 顺带修 `xw-xhs-dispatcher.mjs`：W1 引入的 2 个 raw null byte（join 分隔符）替换为 `\0` 转义（运行时等价，文本安全——grep 不再误判 binary）。behavior-preserving（40/40 dispatcher+budget 测试绿）。

- **测试（全绿）**：`npm run test:xhs-pack` = 117/117 绿（96 + 21 comment-dm-bound）。新测试已加入聚合脚本。

- **决定/坑**：
  - **弱验证降级是 W5 核心**：旧 "composer closed" / "tapped-send" / "input-cleared" 把"发送键消失/输入框清空"当成功——但那只能证明 composer 关了，不能证明评论/私信发出。W5 全降为 ambiguous，触发 AMBIGUOUS_NO_RETRY fence（W4 probe 2 同一机制），杜绝瞎重试。强验证须"我的文本作为已发内容出现 + 计数递增 + 最新是我"三重证。
  - **fuzzy username 禁发**：旧阶梯 `exact→includes(user)→user.slice(0,4)` 会把"天才"匹配到"天才较瘦"（target 是 observed 子串）或 4-char 前缀碰撞。W5 usernameMatch 把这些标 fuzzy，decideDmReplySend 直接禁发（USERNAME_FUZZY）——防回错人。
  - **last-message drift 禁发**：read 与 send 之间 peer 插话→thread 最新消息变→lastMessageFingerprintOf 变→LAST_MESSAGE_DRIFT 禁发。防 stale-context reply。pre-send drift 检查与 post-send verify 共享 W3 `lastMessageFingerprintOf`（同 namespace）——一套身份层，不漂移。
  - **F3 fence 对 comment/reply 同样适用**：ambiguous comment/reply outcome 经 recordMissionEffectOutcome(status="ambiguous")→retry_blocked=1 on (mission,action,target)；同 triple 新 idk 重试→AMBIGUOUS_NO_RETRY（fence 在 budget gate 前检查，W4 probe 2 同机制）。不同 target 不 fence（per-triple）。

- **待办（live，需设备/operator）**：comment + reply 各一次 04 canary（comment: before/after 评论数 + 本人最新评论 hash；reply: exact username + thread unique + last-msg 无漂移 + 发后 last-msg 是我）。inbox/read thread fingerprint W3 已初版，W5 已 formalize 为 DM 身份层。离线 machinery 全就绪，只差 live canary。

- end 2026-08-27（离线部分）。W5 离线 done（comment 强验证 + DM fuzzy/drift 禁发 + F3 fence 全绿），live canary 待 operator。下一波 W6：publish protected commit（合同 PUBLISH，唯一保留人工点）。

## W6 — publish protected commit（合同 PUBLISH，S4）— 离线 done 2026-08-27

- **Spike 结论（2-4h 核验 PHC 现有公开面，payment-only 程度）**：`ProtectedHumanCommit`（`control-plane/lib/protected-human-commit.mjs`）是 **payment-specialized 但非 payment-only**：
  - `route({mission,action,target})` → `evaluateMissionEffect`：`action==="publish"` **永远**返回 `decision:"phc"`（mission-policy.mjs:326-328，Foundation Freeze INV-01——publish/delete final 永久 protected，`allow_within_scope` 不能释放）。所以 publish 路由进 PHC 是内核既定行为，无需新代码。
  - `begin(input)`：payment 专属逻辑（`PAYMENT_BINDING_INCOMPLETE` 必填校验 line 37-52 + 冻结 `approvalBinding` line 61-77）**仅在 `action==="payment" && approvalVerifier` 时触发**。非 payment action（publish）只走通用 prepare→markWaitingAuthorization→入 `pending` Map→`addProtectedCommit` 落库。无 approvalVerifier 时 publish 不需任何 crypto approval。
  - `decide(commitId,{decision,actorId,approval})`：`approvalVerifier.verify` **仅 `decision==="approve" && pending.action==="payment"` 时调**（line 126-132）。publish 的 approve 不走 crypto verify——人工 `decide("approve")` 调用本身就是 gate（plan V2 §10.5 唯一保留人工点）。deny 走 cancelPrepared/restore。
  - **结论**：PHC 的 route/begin/decide 生命周期是 action-agnostic 的；payment 的 crypto approvalBinding + verifier 是 payment 专属叠加层。publish 作为非 payment protected commit 直接复用 PHC 内核，人工 decide("approve") 即唯一 gate。W6 只需在 PHC 之上叠 publish 专属的 envelope drift fail-closed + restart-lost-handle fail-closed。

- **产物**：
  - `services/control-plane/apps/xhs/publish-envelope.mjs` — 纯 `xhs.publish.commit-envelope.v1`：`buildPublishEnvelope({prepareRunId, planHash, contentHash, screenshotHash, deviceFingerprint, accountFingerprint, targetFingerprint, expiresAt})` → 冻结 envelope + `envelopeHash`（64-hex canonical）。`canonicalEnvelopeHash` = sha256(canonicalJson of BINDING_FIELDS only)——**排除 envelopeHash + status**（bookkeeping 非 binding，同 W1 canonical-v2 思路）。`verifyEnvelopeIntegrity`（重算 hash 比 envelopeHash，篡改→false）。`detectEnvelopeDrift(frozen, observed)`（content/screenshot 重 hash 比，fingerprints/planHash 直比，返漂移字段名或 null）。`contentHashOf`/`screenshotHashOf` namespaced sha256。必填字段缺→throw（partial binding 不许建——人工 gate 须建在 COMPLETE tamper-evident binding 上）。
  - `services/control-plane/apps/xhs/publish-commit.mjs` — `PublishCommitHandler` 包 PHC 内核，叠 publish 专属 fail-closed：
    - `beginPublish(...)`: 建 envelope（冻结 publish context）→ `phc.begin({action:"publish", envelope})` → waiting_authorization。**prepare=transport=0**（envelope 是 proof 非 send；execute 不在 begin 调）。envelope 存 in-process `envelopes` Map（drift reference）。
    - `decidePublish(commitId,{decision,actorId,observed})`: **restart-lost-handle fail-closed**（envelopes.get 失败→PUBLISH_HANDLE_LOST，不 execute）；**drift fail-closed**（approve 时 `detectEnvelopeDrift(frozen, observed)` 返字段→PUBLISH_ENVELOPE_DRIFT，不 execute；observed 必填否则 PUBLISH_OBSERVED_STATE_REQUIRED）；**expiry fail-closed**（PHC 内核已强制 expiresAt→cancelled）；deny→cancel 不查 drift；approve 全过→`phc.decide("approve")`→executePrepared（one-tap publish，恰一次 execute）。envelope 自身 tamper→PUBLISH_ENVELOPE_TAMPERED。
  - `services/control-plane/tests/xhs-publish-protected-commit.test.mjs` — PUBLISH 三 probe 共 14 测试（real PHC 内核 + stub ECP）：
    1. **envelope integrity + drift**（1a-1e）：冻结/64-hex hash/self-consistent；canonical hash 排除 envelopeHash+status（status 篡改 hash 不变，binding 字段篡改 hash 变）；六字段 drift 全检出；frozen envelope 篡改 binding 字段+留旧 hash→integrity false；缺字段→throw。
    2. **prepare=transport=0**（2a-2b）：dispatcher `publish prepare` effectClass=none/missions=[]/operationKeyDeferred（transport=0 dry-run）；beginPublish 调 prepare+waiting 一次，**execute 零调**（envelope 是 proof）。
    3. **approve/deny + fail-closed**（3a-3g）：approve+identical observed→恰一次 execute（verified）；drift→PUBLISH_ENVELOPE_DRIFT 不 execute；restart-lost-handle（envelopes.clear）→PUBLISH_HANDLE_LOST 不 execute（防 silent publish）；expiry（clock+120s 过 60s 窗）→不 verified 不 execute；deny→cancelled 不 execute；approve 无 observed→PUBLISH_OBSERVED_STATE_REQUIRED；bogus decision→PUBLISH_DECISION_INVALID。

- **测试（全绿）**：`npm run test:xhs-pack` = 131/131 绿（117 + 14 publish-protected-commit）。新测试已加入聚合脚本。

- **决定/坑**：
  - **PHC 复用边界**：publish 走 PHC 的 route/begin/decide 生命周期（action-agnostic），不碰 payment 专属的 approvalVerifier/approvalBinding。人工 `decidePublish("approve")` 调用 = plan V2 §10.5 唯一人工点；W6 叠加的 envelope drift + restart-lost-handle 是 publish 专属 fail-closed，PHC 内核不管。
  - **canonical hash 排除 envelopeHash+status**（同 W1 canonical-v2）：status 跨 lifecycle 变（pending→approved/denied/expired），envelopeHash 是 hash 自身——都非 binding field，排除以免自指 + 状态变更假漂移。binding fields = 8 个身份字段（prepareRunId/planHash/contentHash/screenshotHash/device/account/target fingerprint/expiresAt）。
  - **restart-lost-handle 是 in-process 限制**：envelopes Map + PHC pending 都 in-process，重启丢。这是有意的 fail-closed——重启后 decide→PUBLISH_HANDLE_LOST，绝不 silent publish。durable 落库（state.addProtectedCommit）只让 pending 可观测，不能恢复 handle（控制已丢）。计划"重启丢 handle fail-closed"=此设计。
  - **prepare=transport=0**：`publish prepare`（edit_dry_run）effectClass=none，不 transport；envelope 是 proof。真正 send 只在 `decidePublish("approve")` 后 executePrepared 一次（one-tap）。两段式防误发。

- **待办（live，需用户明确授权）**：最终 publish canary **需用户另行明确授权具体发布内容**（V2 §10.5，唯一保留人工点）——离线 machinery 全就绪（envelope + handler + 三 probe），但 live publish 必须用户亲自授权 content + screenshot + target，非 operator 可代决。其他 wave 的 live canary 待 operator 设备驱动；publish live 待用户内容授权。

- end 2026-08-27（离线部分）。**W6 离线 done——全 7 波 W0-W6 离线部分全部完成**。`npm run test:xhs-pack` 131/131 绿。合同 5 个 P1 item（F1/F2/F3/VISION/PUBLISH）离线全绿。剩余纯 live canary（W1/W3/W4/W5 待 operator 设备 + W6 待用户内容授权），无更多离线工作。

## W1 — search@2 live 晋级全链（合同 F1 live 部分）— done 2026-08-27

用户授权（2026-08-27）：除支付外全部 wave 授权（W1-W6），执行方案由 agent 决定；唯一保留点 = W6 publish 内容本人过目后一键 approve。

- **live 前置状态核实**：CP live（17920，releaseId xw-m6-c1-fadb449，c7b0695 血系 schema 20 ✓）；4 设备全在线、04 未隔离、activeLeases=0；overlay mode=canary（XHS_RPA_ALIAS=04）；runtime registry.db 只有 @1 canary_only（Fast-2 产物）。
- **发现：@2 首跑 bootstrap 缺口**——catalog ingest 只产 candidate、`buildOverlayDocument` 只发 canary_only/implemented、runner（部署 release）只从 overlay 解析（"server-extras candidate" 钩子在 fadb449 未接线，repo 也无人填 `recipeCatalogExtras`）→ @2 live run 无法解析。解法与 Fast-2 给 @1 手写 overlay 同构：**只 seed runtime overlay 视图**（临时置 canary_only → emit → 还原 candidate，try/finally 保证还原），catalog 阶梯保持干净。
- **发现：CP 无优雅停机通道**——进程由计划任务 `XW Platform Control Plane`（SYSTEM, BootTrigger）经 launch-control-plane.simple.ps1 拉起，console-less（AttachConsole err=203），CTRL_C/SIGINT 不可达，无 shutdown HTTP 路由。重启 = `Stop-ScheduledTask`（硬停）→ **audited stale-lock recovery**（照 cbe741e 先例写 `recover-stale-owner-lock-w1seed.mjs`：pid 死+端口关+lock hash/pid 校验 → db/-wal/-shm 快照 → lock 归档 → integrity_check+wal_checkpoint(TRUNCATE) → receipt 落 `m6-c1-owner-recovery-w1seed.json`）→ `Start-ScheduledTask`。integrity ok，schema 20 保持。
- **live runs（3 次，全部 SUCCEEDED 9/9，alias 04，actor claude-pilot-20260809）**：
  - `rr_4c16261d1e424d19`（晋级 1）、`rr_30eef8324d574ddc`（晋级 2，receipt ok/serverVerified/live 9/9）、`rr_3739a4c43151444f`（**switch-alias 后复核**，验收项 ✓）。
- **晋级链**（`node ops/xw-xhs-promote.mjs --recipe xhs.search.fixed --runs rr_4c…,rr_30… --action search --runtime`）：INGEST_IDEMPOTENT → 2×RECORDED → PROMOTION candidate→replay_verified→promotable→canary_only（2 independent，changed=true，receiptHash b668d57e 绑定）→ SWITCH_ALIAS @2 gate=search:on（runtime state）→ OVERLAY_EMIT（4 recipes，sha256 3ed12c25）。审计行 4 条全带 receiptHash（transitions 表）。
- **dispatcher 面**：repo dispatch-state 同步 search→2 + liveGates.search=true（switch-alias --db runtime + repo 路径）；`xw-xhs.mjs search --execute` gateOk=true rev=2。
- **发现（F1 部署 gap，遗留项）**：部署 release fadb449 的 Runner receipt 仍产 legacy `rh_`+24hex（W1 的 canonical-v2 runner 代码只在 repo，未随 release 部署）；且部署 runner 对 canonical-v2 provided hash 的 tamper 校验静默放行（isCanonicalV2Recipe 不识别）。五消费者中 Runner receipt/CP plan 两个运行时消费者在部署面上暂未统一 64-hex。**桥与 catalog 对 receipt hash 只透传不比对，晋级不受阻；catalog（权威）+ overlay 是 canonical-v2 ✓**。后续：下次 release 刷新（建议并入 W3 live 阶段）后五消费者运行时全同 hash；本次 3 次 run 的 receipt 保留 rh_ 原样（不回填伪造）。
- **结束状态**：leases=0、4 设备在线、disk 46GB。W1 live done —— **F1（canonical hash 统一 + @2 晋级）合同项完整闭环**（catalog/overlay/dispatcher/晋级 receipt 四消费者同 hash；Runner receipt 留部署 gap 已留痕）。

- end 2026-08-27（W1 live）。
