# XHS Routine V3 — Goal-Driven Free Exploration + RPA Foundation Plan V2

Status: **READY_FOR_EXECUTION**  
Review mode: `PLAN_REVIEW / HIGH / fix-once`  
Baseline branch: `codex/xhs-routine-03-live-s1-s4`  
Baseline source: `a7b7fbbd536522352972b85a5789718dcc7146a0`  
Last deployed source: `8aaba01bcbb2e7109d9b42e80dd319da74b91c81` (`xw-xhs-routine-b4-8aaba01`)  
Scope owner: `user:a1234`  
Supersedes frozen Plan V1 SHA-256: `4d7273ba55093c92dce99c5e2686d3300a2330920441746bf23259e66620e363`  
Adjudication: `docs/plans/xhs-routine-v3-plan-review-adjudication-v1.md`  

## 0. Review changes incorporated

Plan V2 incorporates all supported findings from the sole coverage/adversarial wave:

- R3 remains an exact `[03,04]` mission; only the 03 lane may consume the one global visual-tap permit.
- Vision analysis happens before permit issuance and has a separate timeout/attempt budget; issued permits have numeric freshness/TTL rules.
- Private keyed digests use a SYSTEM-only environment key ring with a public key ID and explicit rotation semantics.
- Permit consumption performs a new CP-owned observation check and exact physical-payload comparison; no second-device attestation is added.
- Stable-ID alias reconciliation, closed DUMP verdicts, durable lane journals, and content-addressed launcher artifacts are now specified as algorithms rather than acceptance wishes.
- After the review wave, the owner explicitly added an RPA-foundation deliverable. It is contained to a disabled-by-default, read-only program compiler/dispatcher/ledger over the existing M5 scheduler; it does not activate recurrence or add social authority.

No Plan V3 and no second review wave are allowed.

## 1. Outcome

V3 adds one bounded, goal-driven, read-only exploration capability:

```text
natural-language goal
  -> locally compiled objective
  -> server-recomputed and sealed exploration mission
  -> exact [03,04] lanes
  -> adaptive choices only among current, observed, server-authorized navigation targets
  -> structured, replayable, privacy-separated receipt
```

“Free exploration” in V3 means the runner may adapt which currently observed note/video to open, how long to dwell, and when to stop for novelty or failure. It does **not** mean arbitrary coordinates, arbitrary App actions, open-ended crawling, or social effects.

The daily capability is considered open only when the final live aggregate proves:

- alias 03 feed lane and alias 04 search lane both succeeded or ended `EXHAUSTED_SAFE` with their requested minimum coverage;
- every interactive action used a fresh, single-use, server-sealed R0 navigation permit;
- social authority, social reservations, social transport, and protected actions are all zero;
- the shared mission budget and novelty ledger are reproducible;
- both lanes restored semantically and all owned sessions/leases are gone;
- the deployed release, formal SYSTEM launcher, vision provider, and evidence all share the same pinned identity.

The same delivery also establishes an **RPA foundation**, but does not silently turn it on: sealed read-only routine/recipe instances can be compiled into the existing M5 TaskPlanV2/ExecutionPlanV2 scheduler, globally paced, triggered idempotently, and closed out with one aggregate receipt. Recurring Windows activation remains disabled until a later explicit owner command selects a reviewed program and schedule.

## 2. Verified baseline and blockers

### 2.1 Source and tests

- The clean authority worktree is `.worktrees/xhs-r03` at `a7b7fbb`; the root checkout is dirty and is not a V3 base.
- `5dab77f` contains S_B7 fixes and is not present in deployed B4. The first V3 candidate release must include `5dab77f` and `a7b7fbb`.
- V2.1 reported gates are 216/216 routine, 144/144 pack, and 20/20 fusion.
- V2 read-only note/video and exact `[03,04]` execution are proven. Historical S2/S3 remain immutable `TRANSPORTED_AMBIGUOUS` and are out of V3 scope.

### 2.2 Runtime identity

- Current CP, Registry, serve-03, and serve-04 report B4 `xw-xhs-routine-b4-8aaba01` / `8aaba01...`; CP is healthy and currently has zero active leases.
- Gate F is not closed: the SYSTEM task still invokes `launch-control-plane.simple.ps1`, the formal binding is pinned to `xw-m6-c1-c7b0695`, the current CP is not task-owned, and Gate-F status returns `503 M6_GATE_F_OPERATIONS_UNAVAILABLE`.
- The existing rollback tuple does not hash the runtime-only launcher body. A static tuple PASS is therefore not proof of executable launcher rollback.

### 2.3 Vision

- `xhs-routine-vision-provider.v1.json` is absent and no production `analyze.py` installation was found.
- The real provider wrapper, navigator, and production factory exist, but the production routine runtime does not inject the factory.
- The factory validates only the declared model-hash shape, not the actual provider/script/model bytes.
- `execFileSync` and synchronous segmentation can block both lanes for up to 120 seconds and outlive the current 30-second permit TTL.
- Current V2 vision allows at most one visual navigation tap per run and does not provide the multi-step DUMP/VISION arbitration V3 needs.

### 2.4 Existing trust-boundary gaps

- A generic `xiaowei.explorer.primitive` session token can submit raw `tap`, `swipe`, and `input_text`; `effectClass=none` in an orchestrator plan alone cannot prove that a physical social control was not targeted.
- In deployed `nonpayment_v1`, some legacy out-of-scope non-payment intents may be softened into ECP plus debt. V3 requires an independent hard-zero profile and must not inherit that behavior.
- `goalSignature` is provenance only and is not part of the current routine `planHash`.
- Current target novelty is run-local and coordinate-sensitive; current parallel receipts are too shallow to prove shared de-duplication, transport zero, or child cleanup independently.

### 2.5 RPA/recipe inventory facts

- The repository already has a deterministic M5 Router/DAG adapter into the existing TaskPlanV2/ExecutionPlanV2 scheduler. V3 must extend that path, not create a third scheduler.
- The production overlay inspected during planning contains `xhs.search.fixed@1`, `xhs.search.fixed@2`, and `xhs.browse.fixed@1` as `canary_only`; the checked-in dispatcher default still pins search to revision 1 and no runtime dispatch-state file was present. Therefore `search@2 is active daily` is not an accepted baseline fact.
- `recipe-runs`, Catalog hashing, and the promotion bridge exist, but recipe status, active dispatcher revision, exact descriptor hash, accepted live receipts, effect class, and current release identity must be re-resolved as one snapshot before RPA eligibility.
- The current M5 production skill catalog is narrow; it does not make every routine/recipe automatically schedulable.
- The legacy paced free-explore script spawns old business scripts without one sealed program/session authority. It is a negative oracle, not an RPA backend.

## 3. Product contract

### 3.1 One template and three convergent call surfaces

Add exactly one template, `xhs.explore.goal.v1`, with `effectClass="none"` and `externalEffects=0`.

The existing three call surfaces remain convergent:

1. `/xw xhs routine explore-goal ...`
2. `node ops/xw-xhs-routine.mjs plan|run --template xhs.explore.goal.v1 ...`
3. a submitted sealed plan plus a separately supplied private query payload

All three use the same pure compiler, canonical mission hash, runner, control-plane navigation authority, receipt schema, and trace store. Legacy `xhs-free-explore-paced.mjs`, fixed-coordinate search scripts, raw ADB, direct 22222, and caller-selected endpoints/providers are never execution fallbacks.

### 3.2 Exploration mission

The nested mission is `xw.xhs.exploration-mission.v1`. Its semantic hash covers:

- a deployment-keyed private goal/query reference and digest, never a public raw query;
- normalized objective kind and up to two exact sealed query digests;
- exact placement and fixed roles: `03=feed_lane`, `04=search_lane`;
- page allowlist and closed navigation-intent vocabulary;
- global and per-lane budgets, novelty policy, stop policy, evidence policy, and restoration target;
- DUMP/VISION policy, provider/model/script hashes, and visual permit budgets;
- release and account binding expectations;
- `externalEffects: 0` and a complete forbidden action set.

`executionRunId`, child `routineRunId`, session/lease IDs, and wall-clock timestamps are bound after semantic planning and do not enter the semantic hash.

Raw goal/query text is supplied through a private execution payload. Its keyed digest must match the sealed reference before any session, lease, job, or device I/O is created. Public stdout, receipts, traces, and Git artifacts contain only opaque references/digests.

The natural-language compiler is plan-only and creates zero runtime state. It must reject, not silently remove or clamp:

- mixed-effect goals such as “explore and like/follow/comment”;
- unbounded language such as “all”, “forever”, or “do not stop” without explicit bounded options;
- unknown actions or fields;
- aliases 01/02, alias 04 alone, role changes, work stealing, or fallback placement;
- any value above a schema cap.

### 3.3 Default budgets and hard caps

The initial defaults are conservative and every value is a cap, never a quota:

| Budget | Default / initial cap |
| --- | --- |
| mission duration | 600 seconds |
| total reserved primitives | 80 |
| novel content opens | 8 |
| sealed queries | 2 |
| result screens per query | 2 |
| total comment screens | 6 |
| consecutive navigation failures | 2 |
| consecutive normalized screens with no novelty | 2 |
| vision analysis attempts | 6 globally; timeout consumes an attempt |
| visual navigation permits in first live canary | 1 globally; issuance consumes the permit budget |
| physical visual taps in first live canary | at most 1 globally, separately measured |
| provider decision deadline | 8,000 ms |
| source-frame age at permit issuance | at most 10,000 ms |
| issued navigation permit TTL | 5,000 ms |
| per-device concurrency | 1 |
| mission parallelism | exactly 2 or plan-only; no runtime downgrade |

Implementation may choose lower per-wave values. Raising any listed cap requires a new sealed policy version and review; runtime callers cannot widen it.

### 3.4 Fixed lane roles

- **03 feed lane:** home feed -> current goal-relevant note/video -> optional read-only comment panel -> home feed.
- **04 search lane:** exact sealed query -> search results -> note/video -> optional read-only comment panel -> search results -> home.
- The two lanes share one mission-level target claim ledger, primitive budget, item budget, deadline, cancellation state, and public aggregate.
- Acquire order is 03 then 04. Both sessions must be acquired and attached to the same exploration authority before either lane may perform device I/O.
- No reassignment, work stealing, fallback to one lane, or alias 04 single run is allowed.
- Lane execution may overlap, while the existing Xiaowei transport lock remains serialized. Reports must say “lane concurrency / transport serialization”.

### 3.5 RPA program contract

Add `xw.xhs.rpa-program.v1` as a sealed orchestration contract. A program contains only:

- immutable program ID/version/hash and owner/account/release/catalog bindings;
- ordered or DAG-linked references to a `routine_template` or exact `recipe_revision`;
- for each reference: template/revision/descriptor hash, effect class, placement, fixed parameters, input-private refs, accepted maturity/status, and expected receipt schema;
- a deterministic seed policy derived from program hash + local calendar slot + node ID, never caller randomness at execution;
- schedule policy, read-only pacing/budget policy, failure/misfire policy, evidence/retention policy, and rollback generation;
- `externalEffects=0`, `writeTransportBudget=0`, and the complete V3 forbidden-action set.

The compiler is pure, deterministic, exact-keyed, and zero-state. It resolves a frozen catalog snapshot and lowers the program into the existing M5 DAG, TaskPlanV2, and ExecutionPlanV2. It never embeds shell, executable path, endpoint, lease, token, capability override, raw coordinates, arbitrary command, or a new business procedure.

Initial RPA eligibility is deliberately narrow:

- V2 read-only `xhs.feed-play.v1` and `xhs.scout.home.v1` may be registered after their exact current release/source and acceptance receipts are imported into the RPA catalog.
- V3 `xhs.explore.goal.v1` becomes eligible only after `XHS_V3_FREE_EXPLORATION_VERIFIED=true`.
- `xhs.search.fixed@2` and `xhs.browse.fixed@1` require an execution-time inventory proving exact active revision/hash, current-release live receipts, placement, and a V3-compatible navigation/cleanup contract. `canary_only` is manual-canary eligibility, not recurring eligibility.
- Inbox/read/vision-dependent workflows are not assumed eligible merely because code exists.
- Social nurture, like/collect/follow/comment/DM, publish, delete, account, and payment are unregistrable in the V3 RPA catalog.

The framework defines two modes:

1. `plan|dry-run`: always available after offline gates; no state, lease, or device I/O.
2. `manual-once`: available only to an eligible read-only program and uses the same formal scheduler/lease/receipt path.

`recurring` remains globally disabled in this delivery. A later explicit owner command must choose one sealed program version and schedule after inspecting its plan/receipt; enabling recurrence is not inferred from building the framework.

### 3.6 RPA pacing and trigger policy

The initial schema fixes these bounds:

| RPA bound | Initial rule |
| --- | --- |
| write/social transport | exactly 0 |
| concurrent program runs per account | 1 |
| concurrent run per program version | 1 |
| default starts per local day | 1 |
| hard maximum starts per local day | 4 |
| minimum start interval | 30 minutes default; never below 5 minutes |
| catch-up after downtime | 0; misfires are skipped, never burst-replayed |
| automatic retry | pre-I/O only, at most 1; no retry after any reserved/unknown action |
| scheduler time zone | pinned `Asia/Shanghai` with persisted UTC fire time and monotonic run deadline |

A CP-owned global RPA ledger atomically checks/reserves account + program + daily + interval budgets before M5 dispatch. Duplicate/concurrent ticks share an idempotency key and at most one becomes `DISPATCHED`; the rest are `DUPLICATE` or `SKIPPED_PACING`. Clock rollback, reboot, and delayed wake cannot generate catch-up bursts.

If a Windows wake task is later installed, it invokes one tracked, content-addressed dispatcher with **no user goal, recipe, command, path, endpoint, or device arguments**. The dispatcher only asks CP to evaluate due, already-enabled sealed programs. The task itself never touches a device and is governed by the same formal launcher/task identity and rollback evidence as Gate F.

## 4. Blocking invariants

### V3-I01 — Hard-zero effects

V3 uses a dedicated exploration authority/profile, not Mission social authorization and not `nonpayment_v1` debt semantics. It never creates a routine social authority, comment draft, effect reservation, or effect bridge. Like, collect, follow, comment send/reply/like, DM, publish, delete, payment, product purchase, account, permission, settings, and unknown controls are hard blocked before job creation and adapter I/O.

### V3-I02 — No generic interactive primitives

A V3-owned session rejects generic raw `tap`, `swipe`, and `input_text` even when the caller has its real session token. Every interactive primitive must carry a CP/server-sealed navigation permit bound to:

- mission/plan/execution/authority IDs;
- alias, fixed lane role, device, session, controller, and epoch/sequence;
- a fresh CP-owned observation/evidence hash;
- a positive navigation role, action class, safe region or exact resolved point;
- target/query digest where applicable;
- permit TTL, one-shot state, and global/lane budget reservation.

Permit issuance and consumption are durable and atomic. The issuer resolves and stores the exact physical primitive payload; the consume request must match it byte-for-byte. Immediately before consumption, CP obtains a new job-bound focus/observation receipt and proves the sealed page, target role, target identity/region, and overlay state have not drifted. It then atomically consumes the permit before creating the physical job. Caller coordinates, declared intent, observation hash, provider, file path, OCR label, or model output are never authority.

### V3-I03 — Closed navigation vocabulary

Only these purposes can be sealed initially:

`OPEN_SEARCH`, `SUBMIT_SEARCH`, `SCROLL_FEED`, `SCROLL_RESULTS`, `OPEN_CONTENT_CARD`, `OPEN_COMMENT_PANEL`, `SCROLL_COMMENTS`, `PAUSE_VIDEO_SAFE_ZONE`, `BACK`, and `RESTORE`.

The page allowlist is `HOME_FEED`, `SEARCH_HOME`, `SEARCH_RESULTS`, `IMAGE_NOTE`, `VIDEO_NOTE`, and `COMMENT_PANEL`. Forbidden or unknown classification wins. `PAUSE_VIDEO_SAFE_ZONE` is a single tap only after VIDEO_NOTE is independently established; no double tap. Comment navigation never targets the editor, send, reply, or comment-like controls.

### V3-I04 — Fresh postconditions

Every state transition has a fresh precondition and independent postcondition. Search requires a unique exact search field, exact sealed query input, and SEARCH_RESULTS assertion. A content open requires a current candidate identity and IMAGE_NOTE/VIDEO_NOTE assertion. A comment-panel open requires the unique navigation role and COMMENT_PANEL assertion. A DUMP-recognized forbidden surface cannot be overridden by vision.

The DUMP validator emits exactly one closed verdict:

- `COMPLETE_SAFE_UNIQUE`: recognized allowlisted page, required landmarks present, one positive target role, display bounds valid, and every page-template protected zone either enumerated or geometrically excluded. DUMP navigation may proceed.
- `AMBIGUOUS_SAFE`: allowlisted page and protected zones known, but the positive target is non-unique. No DUMP tap; vision may observe under V3-I07.
- `ABSENT_OR_INVALID`: missing/corrupt dump or required landmarks/protected-zone coverage absent. No DUMP tap; vision may observe only within the page template's positive navigation regions.
- `FORBIDDEN_OR_RISKY`: social editor/send/reply/like controls in the candidate region, publish/product/payment/auth/captcha/risk/system overlay, forbidden page, or package/account uncertainty. Stop; vision is disabled for that transition.

A sparse XML document is never itself authority. The schema version, required landmark set, positive roles, protected-zone masks, and verdict reasons enter the receipt.

### V3-I05 — Stable identity and novelty

Coordinates and list slots never identify content. The key is a deployment-keyed digest of an App-observed stable note ID when available; fallback combines normalized title, author, media kind, and content/cover evidence. The mission ledger atomically moves candidates through `pending -> confirmed|duplicate|unknown`; both lanes share it. Unknown identity is not novel and is not opened.

Stable-ID reconciliation runs in the same `BEGIN IMMEDIATE` transaction that applies post-open identity. It computes `stable:<keyedDigest(noteId)>`, finds every pending/confirmed fallback alias that proves the same stable ID, and selects the earliest durable claim sequence (then lexicographic candidate ID) as canonical. It rekeys/aliases all rows to that canonical record before novelty credit: the canonical record may receive one novelty credit, later records become `duplicate`, and unknown/conflicting proofs become `unknown`. A duplicate learned only after a physical open conservatively keeps its primitive/open budget consumption but receives zero novelty credit. Future pending aliases are cancelled before tap when the canonical mapping is already known.

### V3-I06 — Atomic budgets and replay

The mission authority atomically reserves every primitive, content claim, and visual permit before physical execution. Two lanes racing for one remaining slot can yield at most one reservation. A started/timed-out/crashed action conservatively consumes its reservation. Restart does not replay it. Cleanup uses a shielded budget and timeout and still runs after business deadline/cancellation.

### V3-I07 — DUMP first, vision bounded

DUMP is the primary oracle. Vision may run only for `AMBIGUOUS_SAFE` or `ABSENT_OR_INVALID`, never for `FORBIDDEN_OR_RISKY`, and it never upgrades a page lacking a known positive navigation region. Vision uses a positive navigation-role allowlist, same-session CP-owned frame, pinned local provider/model/script bytes, unique safe block, confidence/bounds/protected-zone rules, and a replay fence. DUMP/VISION disagreement blocks the transition.

Provider analysis is not a navigation permit. It has an 8,000 ms deadline and consumes one of six analysis attempts on timeout, cancellation, provider error, or stale result. A result older than 10,000 ms is discarded before permit issuance. After analysis, CP performs an immediate fresh observation/overlay recheck; only then may it issue the one-shot permit with a 5,000 ms TTL. Permit issuance consumes the visual-permit budget even if the permit later expires unused; an expired permit never retries in the initial canary. Physical tap count is recorded separately.

### V3-I08 — Parallel all-settled cleanup

Each lane has a primitive timeout and the mission has a persisted deadline plus cooperative cancellation. A lane failure/hang causes the peer to stop at a safe checkpoint. Cleanup runs independently for each lane and is checked through an independent live lease oracle.

Before its first device I/O, each lane appends a CP-owned `STARTED` journal record bound to mission/plan/execution/session/role hashes. Primitive reservations, outcomes, cancellation, restoration, release attempts, and independent lease observations are append-only records. Only a final `COMMITTED` marker seals the canonical lane receipt hash. The parent reads this authority store, not a child-supplied summary. Missing, partial, conflicting, or uncommitted journals are `BLOCKED`; a recovery worker may append `ABORTED`/`RECOVERED` only after independently proving cleanup, never SUCCESS. Parent success hashes/dereferences two committed lane receipts.

### V3-I09 — Privacy-separated evidence

Private ACL-controlled run storage may contain raw goal/query, XML, PNG, and bounded page text, with a seven-day raw retention target. Public receipts contain only opaque/keyed digests, counts, state codes, release/provider identities, and evidence hashes. They exclude raw/OCR text, coordinates, serials, account/session/lease/token values, private absolute paths, and `textPreview`. Vision for this release is local-only; remote vision egress is a later scope decision.

Keyed digests use HMAC-SHA-256 with a 256-bit random environment key stored in a SYSTEM/Administrators-only, deny-by-default runtime key ring. The public `digestKeyId` is a non-secret identifier derived from the random key and is included in mission, provider/release binding, private receipt, and public aggregate. The key is never derived from a release hash and is unavailable to client/compiler/reviewer output. Startup fails closed if the active key, ACL, or key-ring manifest is missing/drifted. Rotation creates a new active key ID; old keys remain read-only through the evidence retention/replay horizon, historical receipts retain their original key ID and are never rehashed, and aggregate byte reproduction uses the sealed receipt digest rather than needing raw text after purge.

### V3-I10 — Historical and subsystem isolation

V3 does not enable or depend on Standing Grant, ADR 0010 DiscoverySession, legacy Mission social effects, or historical S2/S3 rows. Those flags/ledgers remain unchanged. Existing V2 templates keep their hashes and behavior.

### V3-I11 — No third scheduler or procedure code

RPA compilation must lower into the existing M5 -> TaskPlanV2/ExecutionPlanV2 scheduler. A program may reference only catalog-pinned routine templates or recipe revisions. The scheduler/trigger may not contain App procedure steps, coordinates, shell, arbitrary executable/module injection, or alternate device transport.

### V3-I12 — Eligibility is evidence, not file presence

An RPA node is dispatchable only when one atomic catalog snapshot proves exact source/release, template/revision/descriptor hash, accepted effect class `none`, placement, current maturity/status, live acceptance receipt hashes, and expected runner/cleanup contract. `candidate`, `draft`, stale release, inactive revision, or code/spec presence alone is not eligibility. Catalog drift after plan seal blocks before dispatch.

### V3-I13 — Global pacing is authoritative

Pacing/budget is CP-owned and shared across every RPA program for the same account. Per-recipe counters are subordinate and cannot reset the global day/interval/run budget. Reservation is atomic before scheduler dispatch; crash/unknown conservatively consumes the start slot. Misfires skip and never catch up.

### V3-I14 — Trigger is not authority

A timer/Windows task only emits an idempotent wake. It cannot enable a program, select a goal/recipe/device, widen parameters/budgets, or acquire a lease. Program enablement is a separate versioned owner decision; V3 ships it disabled. Duplicate, forged, stale-generation, clock-rollback, and manual task invocations cannot bypass catalog, pacing, Gate F, or program state.

### V3-I15 — RPA hard-zero composition

The RPA compiler rejects an entire program if any node or transitive dependency is social/protected, ambiguous-effect, human-gated, or unknown. It may not silently delete the node, clamp an effect budget to zero, or replace it with another recipe. Every child and aggregate receipt independently proves social authority/reservation/transport deltas of zero.

### V3-I16 — RPA closeout and kill switch

Every tick/run has a durable journal from `TICK_RESERVED` through scheduler events, child receipt hashes, validation, cleanup, and terminal commit. A globally readable kill generation prevents new dispatch and cooperatively cancels active business work while preserving cleanup. Missing child/validator/cleanup evidence yields BLOCKED, never a successful scheduled run.

## 5. Architecture and code changes

### 5.1 Pure planning

Extend `xhs-routine-plan.mjs` additively with `xhs.explore.goal.v1` and a nested mission object. Existing V2 plan hashes remain byte-stable when the optional mission is absent. Add a pure `xhs-exploration-mission.mjs` compiler/normalizer that:

- produces no state or I/O;
- uses exact-key schemas and canonical JSON;
- stores only private refs/keyed digests in public form;
- validates zero effects, lane roles, budgets, stop rules, and provider policy;
- revalidates the private payload digest at execution.

`goalSignature` remains non-authoritative provenance for old templates; V3 authority comes only from the hashed mission.

### 5.2 CP exploration authority and permits

Add a dedicated R0 exploration authority and durable state in Control Plane. It binds the plan, mission, release, account, exact two sessions, roles, budgets, novelty ledger, and cancellation/deadline. Mark attached sessions `xhs_goal_explore_v1` so generic interactive primitives fail before `createJob`.

The CP issues/consumes typed single-use navigation permits only from adapter-produced, CP-indexed observation receipts; it rejects caller paths/hashes and resolves the exact physical payload itself. At consumption it obtains a new CP-owned observation/focus receipt, compares page/target/overlay and exact payload, then atomically consumes the permit before `createJob`. The generic Explorer primitive remains available to legacy sessions but cannot be a bypass for V3 sessions. This profile stays fail-closed even when global `policyMode.active=true`.

### 5.3 Surface parser and state machine

Add pure `xhs-explore-surface.mjs` and `xhs-goal-explore-machine.mjs`. Reuse parsing logic from `_xhs-parse.mjs::parseSearchResults`, but not old fixed-coordinate execution. Do not expand the existing feed machine into a search machine.

The new machine receives only typed methods such as `openBoundSearch`, `submitBoundQuery`, `scrollBoundResults`, `openBoundContent`, `openBoundComments`, `pauseBoundVideo`, `backBound`, and `restoreBound`. It never receives a raw primitive function, session token, coordinate, or provider path. A deterministic seeded selector/ranker chooses only current observed candidate IDs. Model-generated runtime actions are out of scope; a future ranker may only return a permutation of current IDs under a new sealed mode.

### 5.4 Runner and coordinator

Reuse the existing formal session lifecycle, execution IDs, 03->04 acquire barrier, `Promise.allSettled`, trace store, and release logic. Add:

- authority creation only after both sessions are acquired;
- role-specific child execution;
- shared CP claim/budget calls;
- per-primitive timeout, persisted mission deadline, cooperative cancellation, and shielded cleanup;
- a CP-owned append-only lane journal created before first I/O, final commit markers, crash recovery records, and complete receipts with hashes/dereferenceable evidence;
- zero-effect and live lease independent-oracle checks in the aggregate.

### 5.5 Vision

Wire `createProductionRoutineVisionNavigator` into `createExplorerRoutineRuntime`. Replace blocking provider execution with asynchronous process/worker isolation, bounded queueing, an 8,000 ms decision deadline, per-lane cancellation, and no event-loop starvation. Analysis attempts, issued permits, consumed permits, and physical taps are four distinct receipt counters.

Pin and re-hash the actual Python executable, analysis script, model bytes, and configuration at startup. The provider may emit navigation-role candidates only; the CP remains the permit issuer. Each decision records DUMP/VISION source, agreement/disagreement, frame/evidence/provider hashes, and whether a tap was authorized. Shadow always has tap=0.

The first live canary remains a single global visual navigation tap. Raising the mission visual cap above one is a later promotion based on accepted evidence, not part of the initial V3 daily opening.

### 5.6 Acceptance and closeout

Extend `xw-xhs-routine-accept.mjs` and closeout schemas with V3 waves and independent assertions for:

- release/Gate-F/provider identity;
- mission and lane receipt hashes;
- primitive and permit ledgers;
- shared target coverage/de-duplication;
- DUMP/VISION decisions;
- social authority/reservation/transport deltas;
- per-lane restoration, release, and independent `listLeases` result;
- public privacy scan and private retention receipt.

### 5.7 RPA compiler, scheduler adapter, and ledger

Add a pure RPA program compiler and schema, an RPA catalog projection, a thin adapter to the existing M5 DAG/TaskPlanV2 scheduler, and a CP-owned pacing/tick ledger. Reuse M5 trace events and add RPA-specific program/tick/aggregate receipts rather than duplicating scheduler state.

The dispatcher has three fail-closed gates in order:

1. resolve enabled program generation + frozen catalog/release/account binding;
2. atomically reserve global pacing and create the durable tick journal;
3. submit the frozen M5 execution plan and later validate all child receipts/cleanup.

No device operation occurs in the compiler, wake task, or ledger. The existing runner/recipe-runner remains the only node executor. A fixed `xw-rpa plan|tick|status|disable` surface may be added, but `tick` accepts only an opaque program ID/generation from the authority store; production wake accepts no caller-selected node/action arguments.

The V3 release leaves `RPA_RECURRING_ENABLED=false`, installs no enabled program, and creates no recurring task. It may complete one plan/dry-run and, after V3 live acceptance, one explicitly invoked read-only `manual-once` acceptance run.

## 6. Execution phases and gates

### P0 — Freeze the execution base

1. Create the implementation branch from clean `a7b7fbb`, never from the dirty root checkout.
2. Record B4 runtime identity, the current Gate-F 503 state, provider absence, zero leases/jobs, and rollback artifacts as pre-state.
3. Freeze schemas, caps, action/page allowlists, private/public fields, and exact lane roles.

Gate: plan/contract hashes recorded; baseline files and tests enumerated; no runtime mutation.

### P1 — Mission compiler and CP hard-zero authority

1. Implement pure mission compile/seal/private-payload binding.
2. Implement durable authority, shared atomic budgets/claims, session profile, permit issuance/consumption, deadline/cancellation, and hard-zero firewall.
3. Add negative policy and raw-token bypass tests before any machine integration.

Gate: mixed effects, raw tap/input/swipe, forged/replayed/cross-lane/stale permits, and `nonpayment_v1` softening all create zero job, reservation, adapter call, and transport.

### P2 — DUMP-only single-lane machines

1. Implement surface parser, stable identity, deterministic candidate selection, typed driver methods, feed-lane machine, and search-lane machine.
2. Prove search, image note, video note, comment panel, failure/stagnation, IME restoration, and semantic final restoration with fixtures and independent postconditions.

Gate: all state-machine transitions pass; no coordinate fallback; consecutive-failure and no-novel stops are exact; private trace persistence is honestly classified.

### P3 — Exact `[03,04]` coordination

1. Attach both sessions to one authority after the acquire barrier.
2. Add shared stable-ID claims, global budgets, fixed roles, timeout/cancel, all-settled and complete child receipts.
3. Inject lane acquire/failure/hang/crash/release faults.

Gate: no downgrade/work stealing; races cannot overspend or double-open; every owned session/lease is independently closed or aggregate is BLOCKED.

### P4 — Production vision

1. Provision a local pinned provider and content-addressed runtime config.
2. Wire the factory; make provider work asynchronous and cancellable; prove the 8,000 ms deadline, 10,000 ms frame-age ceiling, immediate CP recheck, and 5,000 ms issued-permit TTL.
3. Build independently labelled real corpus for HOME_FEED, SEARCH_RESULTS, IMAGE_NOTE, VIDEO_NOTE, and COMMENT_PANEL navigation roles.
4. Prove shadow, conflict, ambiguity, forgery, replay, provider crash/absence, and one-shot canary behavior.

Gate: corpus oracle passes, shadow tap=0, canary tap<=1, effect tap=0, and provider work cannot starve lane heartbeat/deadline.

### P5 — Test, package, and formal deployment identity

1. Run targeted suites, then full `test:xhs-routine`, `test:xhs-pack`, `test:fusion`, and Gate tests with no allowlist widening except reviewed V3 source additions.
2. Build a clean release from a source containing `5dab77f` and the V3 commits.
3. Make the formal launcher a tracked release artifact. Install it under an immutable content-addressed runtime path `launchers/<sha256>/launch-control-plane.ps1`; bind task XML/config to that exact path and hash. Runtime-only launcher edits are forbidden. Hash launcher source/body, binding, task XML, manifest, policy, serve configs, key-ring manifest, and rollback material.
4. Validate the content-addressed launcher with `-Mode FINAL -ValidateOnly`, perform a task-owned SYSTEM restart, prove listener ancestry and exact health identity, perform one actual rollback and re-forward drill using the prior/next launcher hashes, and return to zero jobs/leases.

Gate: CP/Registry/serve-03/serve-04/manifest/current/task binding all show the same release ID and 40-hex source; task action contains no `.simple`; Gate-F status is 200/CLOSED/triple-consistent/zero resources; rollback and re-forward both verify.

### P6 — Live acceptance, zero social transport

Execute only after P5:

1. **R0 offline:** property/mutation/race/crash-restart/forgery/privacy/corpus gates.
2. **R1 exact `[03,04]` DUMP-only:** 03 feed lane, 04 search lane, small sealed budgets, zero visual/social actions.
3. **R2 exact parallel vision shadow:** real provider, tap=0.
4. **R3 exact `[03,04]` natural sparse one-shot vision canary:** both sessions/roles run; the one global R0 visual permit is eligible only on alias 03, while alias 04 remains DUMP-only and must complete/restore; no social transport.
5. **R4 exact `[03,04]` small-budget goal exploration:** shared budget/de-duplication, complete receipts, semantic restore.

Each wave gets before/after evidence. Failure never authorizes a retry that widens budget or reuses a consumed permit.

Gate: only an aggregate with all blocking invariants proved may set `XHS_V3_FREE_EXPLORATION_VERIFIED=true`. Otherwise retain existing V2.1 capabilities and record `CLOSEOUT_PARTIAL` with exact blockers.

### P7 — RPA foundation, disabled by default

1. Implement the RPA program schema/compiler, catalog projection, M5 adapter, CP pacing/tick ledger, kill generation, trace/aggregate receipts, and plan/status/disable CLI.
2. Inventory current routine/recipe candidates. Register only exact read-only entries whose source/release/hash/effect/placement/acceptance evidence satisfies V3-I12; record all others as ineligible with reasons. Do not promote or switch a recipe merely to fill the RPA catalog.
3. Run compiler/property/mutation/clock/concurrency/crash/privacy tests and prove no third scheduler/transport exists.
4. Produce plan-only examples for feed/scout/explore and an exact catalog eligibility report.
5. Only after P6 passes, run one explicit small-budget `manual-once` read-only program. Recurring stays disabled; no Windows wake task is installed/enabled by this plan.

Gate: deterministic hashes, atomic global pacing, duplicate/misfire safety, hard-zero transitive composition, complete child/aggregate receipts, kill-switch behavior, and zero owned leases all pass. The closeout records `RPA_FOUNDATION_VERIFIED=true` separately from `RPA_RECURRING_ENABLED=false`.

## 7. Required acceptance probes

### A. Compile, seal, and binding

- Same normalized goal/options produce the same semantic mission hash and zero state.
- Mutation of goal/query digest, alias, role, page/action allowlist, budget, stop rule, vision/provider policy, release/account binding, or `externalEffects` rejects before I/O.
- Mixed effects, unknown actions, unbounded goals, alias 01/02, and alias 04 alone are whole-plan rejection, not intent deletion or clamping.
- Old plan, wrong private payload, wrong account/release/provider, or execution replay creates zero session/job.

### B. Hard-zero and raw bypass

- With `policyMode.active=true`, attempt expired/out-of-scope like/comment/DM and forged social capabilities: zero job/reservation/transport/debt acceptance.
- With a real V3 session token, submit generic tap at like/collect/follow/send coordinates and input to the comment editor: HTTP 403 before job/device I/O.
- Forge every permit field; replay, cross-lane, cross-session, stale, and changed-payload attempts all have `deviceCall=0`.
- `routine_authorities`, `routine_effects`, `comment_drafts`, and typed social transport before/after deltas are zero.
- For every opened detail page, an independent UI-state oracle records unchanged like/collect/follow state vectors.

### C. Budget, identity, and novelty

- Concurrent remaining-budget=1 race yields at most one permit.
- Timeout/crash/restart conservatively consumes and never replays a started reservation.
- The same note across lanes, coordinates, order, or title truncation is one novel target.
- Two fallback identities later resolving to one stable note ID reconcile as one confirmed plus one duplicate.
- Reordered but unchanged candidate sets trigger stagnation; unknown identities never count as novel.
- Ledger data is partitioned by mission/account/release; cross-partition mutation is rejected.

### D. Surface navigation

- Search requires unique exact field, exact query digest match, SEARCH_RESULTS postcondition, screen cap, and IME restoration.
- Image/video/comment-panel routes each have independent pre/post assertions.
- Search-field ambiguity, query drift, video overlays, editor/send/reply/comment-like ambiguity, publish/product/auth/captcha/payment/system overlays, and unknown pages cause zero interactive I/O or immediate safe BACK plus BLOCKED.
- Two consecutive navigation failures or no-novel normalized screens stop business execution; cleanup still runs.

### E. DUMP/VISION

- DUMP-recognized forbidden/risky pages cannot be overridden by benign vision output.
- Benign relabels of social/send controls, duplicate blocks, low confidence, out-of-bounds/status-bar blocks, stale/cross-lane frames, path traversal, provider drift, crash, absence, permit forgery/replay, and DUMP/VISION conflict all yield tap=0.
- Real corpus uses at least three distinct frames per required route and an independently authored expected-data oracle plus mutations that make the gate fail.
- Provider decision timeout, source-frame age, post-analysis recheck, permit TTL, and separate analysis/permit/physical-tap counters are asserted.
- Shadow tap=0; first live canary is exact `[03,04]`, only 03 is visual-permit-eligible, global issued permits<=1 and physical visual taps<=1; replay/stale/duplicate transport=0.

### F. Parallel and cleanup

- 04 acquire failure causes 03 action=0 and releases 03.
- Lane throw, never-resolving primitive, process interruption, cleanup timeout, release failure, and forged child `cleanup=true` cannot produce parent success.
- Peer lane cooperatively stops at a safe checkpoint.
- Lane `STARTED` journal exists before first I/O; only CP-owned `COMMITTED` markers can satisfy parent success. Missing/partial/forged child output is BLOCKED, and recovery may append only independently proved ABORTED/RECOVERED state.
- Parent receipt hashes complete committed child receipts; live `listLeases` independently shows no owned leases. An unrelated active lease is reported but not released or misattributed.

### G. Evidence and privacy

- Seed private artifacts with a sensitive query, name, phone, token-like string, OCR text, and absolute path. Recursively scan stdout/stderr, public DB projections, public receipts, and committed diff; only allowed private artifacts may contain them.
- Low-entropy query/title/author values use the SYSTEM-only HMAC key ring, never plain SHA-256; missing/incorrect ACL, wrong key ID, rotation, and historical-key replay are probed.
- Public aggregate can be rebuilt byte-for-byte from referenced receipts and exact digest-key/release/provider/mission/lane hashes.
- Retention/ACL sweep preserves immutable purge receipts and evidence hashes.

### H. Live closeout

- Alias 01/02 session/job/device-I/O deltas are zero.
- Only aliases 03/04 appear, in fixed roles.
- Forbidden effects, social authority, social reservation, social transport, and visual effect taps are zero.
- Both lanes meet minimum content-route coverage, restore semantically, release, and leave zero owned leases.
- A zero-item, missing-route, unknown-cleanup, or identity/provider/release mismatch result is never SUCCESS.

### I. RPA compile and catalog

- Same program/catalog snapshot yields identical program/DAG/task-plan hashes and zero state in plan mode.
- Mutate node revision/hash/effect/placement/params/seed/schedule/budget/release/account or add a forbidden field/edge: whole program rejects before tick/state/device I/O.
- Catalog marks code-only, candidate, stale-release, inactive revision, missing acceptance, mismatched descriptor, social/human-gated, and unknown entries ineligible.
- Prove current `search@2`/browse eligibility from one exact runtime snapshot or keep them out; never infer active status from overlay/spec presence.
- Static/source graph proves RPA uses existing M5 scheduler and approved runners only; legacy free-explore/old business scripts are unreachable.

### J. RPA trigger, pacing, and closeout

- Concurrent identical/overlapping ticks, duplicated Windows wake, reboot-delayed wake, clock rollback/forward, and stale generation dispatch at most one run and never catch up.
- Two programs for one account race on the final daily/start slot: at most one `DISPATCHED`; crash/unknown consumes conservatively.
- Wake/CLI injection attempts for raw goal, recipe, path, endpoint, alias, command, capability, coordinates, or transport reject before state/device I/O.
- Kill generation before reserve, between reserve/dispatch, during a child, and during cleanup blocks new work and still completes shielded cleanup.
- Parent success requires committed scheduler trace, every pinned child receipt, local validator, hard-zero deltas, semantic restoration, and independent zero-owned-leases oracle.
- `RPA_RECURRING_ENABLED` remains false, no enabled recurring program/task exists, and the single manual acceptance run cannot alter that state.

## 8. Terminal states and hard stops

Terminal states are `SUCCEEDED`, `EXHAUSTED_SAFE`, `PARTIAL`, `BLOCKED`, and `CANCELLED`.

Business execution stops immediately, while shielded cleanup still runs, on:

- mission/plan/release/account/App/profile/controller drift;
- any effect intent, social authority/reservation/transport delta, or raw primitive attempt;
- deadline, budget, cancellation, two navigation failures, or two no-novel screens;
- repeated page fingerprint/scroll no-op;
- forbidden/auth/captcha/risk/publish/product/payment/system overlay;
- DUMP/VISION conflict, non-unique safe target, or unknown identity;
- provider/model/script/frame/permit drift, timeout, or replay;
- lane exception/timeout or peer cleanup uncertainty;
- IME or semantic UI restoration failure.

`EXHAUSTED_SAFE` is a safe terminal, not automatic product success. It satisfies a live wave only when that wave explicitly required safe exhaustion and all minimum coverage/cleanup criteria are still met.

## 9. Rollback

- Code: revert V3 additive files/call sites; existing V2 templates and hashes remain valid.
- Runtime: disable the V3 route/authority first, reject new missions, cooperatively cancel active V3 missions, finish shielded cleanup, and retain receipts.
- Vision: set V3 vision mode to fallback and remove the V3 provider binding; never substitute fixture/caller-selected providers.
- Deployment: use the content-addressed rollback tuple that now includes launcher body, binding, task XML, manifest, configs, and DB snapshot; perform the task-owned rollback, verify identity/health/zero resources, then decide whether to re-forward.
- Product: if any P1 invariant or live route fails, keep V2.1 daily read-only feed and exact `[03,04]` read-only batch only. Never reopen social actions or alter historical S2/S3 evidence.
- RPA: increment the global kill generation, reject new ticks, let shielded cleanup/recovery finish, disable the affected program generation, and retain tick/child receipts. Remove only the optional catalog/dispatcher surface after proving no active tick; never fall back to a legacy script or a Windows task containing business steps.

## 10. Non-goals

- Likes, collects, follows, comments/replies, DMs, publish/delete, profile/account/settings, payments, purchases, or permission changes.
- Author-profile traversal, related-query recursion, open web links, or more than one content hop.
- Long-running unattended patrol, bulk scraping, content download/archive, or recommendation farming.
- Alias 01/02, alias 04 single execution, automatic fallback, dynamic role changes, or work stealing.
- Enabling Standing Grant, ADR 0010 DiscoverySession, legacy Mission social authorization, or `nonpayment_v1` debt for V3.
- Remote/cloud vision egress or model-selected coordinates/actions.
- Recurring RPA activation, an enabled Windows wake task, social/nurture scheduling, publish scheduling, or automatic recipe promotion/switching. Those require later explicit owner scope and fresh acceptance; V3 only builds and manually proves the read-only foundation.
- Merging, pushing, or live execution as part of this plan-review turn.

## 11. Plan V2 decision log

- Use the proven Routine session/parallel shell but add a separate exploration machine; do not revive the old free-explore script or enable the incomplete DiscoverySession rollout.
- Make the CP navigation permit/profile the trust boundary; typed orchestrator methods alone are insufficient.
- Keep runtime selection deterministic and candidate-ID-only for V3. Model rankers/actions are deferred.
- Fix lane roles as 03 feed and 04 search to provide complementary coverage and a stable acceptance oracle.
- Treat Gate F and production vision as live/merge blockers, not blockers to offline implementation.
- Keep the initial live visual navigation budget at one globally. Multi-tap promotion is deferred.
- Keep all V3 device-I/O waves exact `[03,04]`; R3 restricts visual eligibility to 03 instead of creating a single-lane exception.
- Use consume-time CP reobservation and exact permit payloads; a second attestation device is rejected as out of scope.
- Make stable-ID merging, DUMP verdicts, lane receipt commits, digest keys, and launcher content addressing explicit implementation obligations.
- Accept the owner's post-review RPA addition only as a disabled-by-default R0 framework over M5; reject the suggested third/thin business scheduler and any assumption that code/overlay presence equals daily eligibility.
- Keep future social RPA and publish outside this plan even if their mechanical paths exist; no old ambiguous evidence is used for promotion.

## 12. Completion rule

Plan V2 execution is complete only when:

1. all offline and full repository gates pass;
2. the formal task-owned deployment and executable rollback/re-forward drill pass;
3. the provider corpus, shadow, and one-shot canary pass;
4. R4 exact `[03,04]` passes every hard-zero, shared-budget, identity, privacy, and cleanup oracle;
5. a reproducible aggregate sets `XHS_V3_FREE_EXPLORATION_VERIFIED=true` without changing `S1_S4_LIVE_VERIFIED` or historical S2/S3.
6. the RPA compiler/ledger/M5 adapter gates and one manual read-only acceptance pass, setting `RPA_FOUNDATION_VERIFIED=true` while `RPA_RECURRING_ENABLED=false` and no enabled recurring task/program exists.

Anything less is an honest partial closeout, not daily V3 activation.
