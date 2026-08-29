# XHS Routine V3 — Goal-Driven Free Exploration Plan V1

Status: **FROZEN_FOR_REVIEW**  
Review mode: `PLAN_REVIEW / HIGH / fix-once`  
Baseline branch: `codex/xhs-routine-03-live-s1-s4`  
Baseline source: `a7b7fbbd536522352972b85a5789718dcc7146a0`  
Last deployed source: `8aaba01bcbb2e7109d9b42e80dd319da74b91c81` (`xw-xhs-routine-b4-8aaba01`)  
Scope owner: `user:a1234`  

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
| visual navigation taps in first live canary | 1 globally |
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

Permit issuance and consumption are durable and atomic. Caller coordinates, declared intent, provider, file path, OCR label, or model output are never authority.

### V3-I03 — Closed navigation vocabulary

Only these purposes can be sealed initially:

`OPEN_SEARCH`, `SUBMIT_SEARCH`, `SCROLL_FEED`, `SCROLL_RESULTS`, `OPEN_CONTENT_CARD`, `OPEN_COMMENT_PANEL`, `SCROLL_COMMENTS`, `PAUSE_VIDEO_SAFE_ZONE`, `BACK`, and `RESTORE`.

The page allowlist is `HOME_FEED`, `SEARCH_HOME`, `SEARCH_RESULTS`, `IMAGE_NOTE`, `VIDEO_NOTE`, and `COMMENT_PANEL`. Forbidden or unknown classification wins. `PAUSE_VIDEO_SAFE_ZONE` is a single tap only after VIDEO_NOTE is independently established; no double tap. Comment navigation never targets the editor, send, reply, or comment-like controls.

### V3-I04 — Fresh postconditions

Every state transition has a fresh precondition and independent postcondition. Search requires a unique exact search field, exact sealed query input, and SEARCH_RESULTS assertion. A content open requires a current candidate identity and IMAGE_NOTE/VIDEO_NOTE assertion. A comment-panel open requires the unique navigation role and COMMENT_PANEL assertion. A DUMP-recognized forbidden surface cannot be overridden by vision.

### V3-I05 — Stable identity and novelty

Coordinates and list slots never identify content. The key is a deployment-keyed digest of an App-observed stable note ID when available; fallback combines normalized title, author, media kind, and content/cover evidence. The mission ledger atomically moves candidates through `pending -> confirmed|duplicate|unknown`; both lanes share it. Unknown identity is not novel and is not opened.

### V3-I06 — Atomic budgets and replay

The mission authority atomically reserves every primitive, content claim, and visual permit before physical execution. Two lanes racing for one remaining slot can yield at most one reservation. A started/timed-out/crashed action conservatively consumes its reservation. Restart does not replay it. Cleanup uses a shielded budget and timeout and still runs after business deadline/cancellation.

### V3-I07 — DUMP first, vision bounded

DUMP is the primary oracle. Vision may run only when the fresh DUMP is absent, sparse, or ambiguous, never when DUMP identifies risk/forbidden content. Vision uses a positive navigation-role allowlist, same-session fresh frame, pinned local provider/model/script bytes, unique safe block, confidence/bounds rules, TTL, and one-shot replay fence. DUMP/VISION disagreement blocks the transition.

### V3-I08 — Parallel all-settled cleanup

Each lane has a primitive timeout and the mission has a persisted deadline plus cooperative cancellation. A lane failure/hang causes the peer to stop at a safe checkpoint. Cleanup runs independently for each lane and is checked through an independent live lease oracle. Parent success cannot be inferred from a shallow child summary; it hashes/dereferences complete lane receipts.

### V3-I09 — Privacy-separated evidence

Private ACL-controlled run storage may contain raw goal/query, XML, PNG, and bounded page text, with a seven-day raw retention target. Public receipts contain only opaque/keyed digests, counts, state codes, release/provider identities, and evidence hashes. They exclude raw/OCR text, coordinates, serials, account/session/lease/token values, private absolute paths, and `textPreview`. Vision for this release is local-only; remote vision egress is a later scope decision.

### V3-I10 — Historical and subsystem isolation

V3 does not enable or depend on Standing Grant, ADR 0010 DiscoverySession, legacy Mission social effects, or historical S2/S3 rows. Those flags/ledgers remain unchanged. Existing V2 templates keep their hashes and behavior.

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

The CP issues/consumes typed single-use navigation permits from CP-owned observation receipts. The generic Explorer primitive remains available to legacy sessions but cannot be a bypass for V3 sessions. This profile stays fail-closed even when global `policyMode.active=true`.

### 5.3 Surface parser and state machine

Add pure `xhs-explore-surface.mjs` and `xhs-goal-explore-machine.mjs`. Reuse parsing logic from `_xhs-parse.mjs::parseSearchResults`, but not old fixed-coordinate execution. Do not expand the existing feed machine into a search machine.

The new machine receives only typed methods such as `openBoundSearch`, `submitBoundQuery`, `scrollBoundResults`, `openBoundContent`, `openBoundComments`, `pauseBoundVideo`, `backBound`, and `restoreBound`. It never receives a raw primitive function, session token, coordinate, or provider path. A deterministic seeded selector/ranker chooses only current observed candidate IDs. Model-generated runtime actions are out of scope; a future ranker may only return a permutation of current IDs under a new sealed mode.

### 5.4 Runner and coordinator

Reuse the existing formal session lifecycle, execution IDs, 03->04 acquire barrier, `Promise.allSettled`, trace store, and release logic. Add:

- authority creation only after both sessions are acquired;
- role-specific child execution;
- shared CP claim/budget calls;
- per-primitive timeout, persisted mission deadline, cooperative cancellation, and shielded cleanup;
- complete lane receipts with hashes and dereferenceable evidence;
- zero-effect and live lease independent-oracle checks in the aggregate.

### 5.5 Vision

Wire `createProductionRoutineVisionNavigator` into `createExplorerRoutineRuntime`. Replace blocking provider execution with asynchronous process/worker isolation, bounded queueing, per-lane timeout/cancellation, and no event-loop starvation.

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
2. Wire the factory; make provider work asynchronous and cancellable.
3. Build independently labelled real corpus for HOME_FEED, SEARCH_RESULTS, IMAGE_NOTE, VIDEO_NOTE, and COMMENT_PANEL navigation roles.
4. Prove shadow, conflict, ambiguity, forgery, replay, provider crash/absence, and one-shot canary behavior.

Gate: corpus oracle passes, shadow tap=0, canary tap<=1, effect tap=0, and provider work cannot starve lane heartbeat/deadline.

### P5 — Test, package, and formal deployment identity

1. Run targeted suites, then full `test:xhs-routine`, `test:xhs-pack`, `test:fusion`, and Gate tests with no allowlist widening except reviewed V3 source additions.
2. Build a clean release from a source containing `5dab77f` and the V3 commits.
3. Bind the formal Gate-F launcher/config/task to the exact release. Hash launcher body, binding, task XML, manifest, policy, serve configs, and rollback material.
4. Validate `launch-control-plane.ps1 -Mode FINAL -ValidateOnly`, perform a task-owned SYSTEM restart, prove listener ancestry and exact health identity, perform one actual rollback and re-forward drill, and return to zero jobs/leases.

Gate: CP/Registry/serve-03/serve-04/manifest/current/task binding all show the same release ID and 40-hex source; task action contains no `.simple`; Gate-F status is 200/CLOSED/triple-consistent/zero resources; rollback and re-forward both verify.

### P6 — Live acceptance, zero social transport

Execute only after P5:

1. **R0 offline:** property/mutation/race/crash-restart/forgery/privacy/corpus gates.
2. **R1 exact `[03,04]` DUMP-only:** 03 feed lane, 04 search lane, small sealed budgets, zero visual/social actions.
3. **R2 exact parallel vision shadow:** real provider, tap=0.
4. **R3 alias-03 natural sparse one-shot vision canary:** at most one R0 navigation tap; no social transport.
5. **R4 exact `[03,04]` small-budget goal exploration:** shared budget/de-duplication, complete receipts, semantic restore.

Each wave gets before/after evidence. Failure never authorizes a retry that widens budget or reuses a consumed permit.

Gate: only an aggregate with all blocking invariants proved may set `XHS_V3_FREE_EXPLORATION_VERIFIED=true`. Otherwise retain existing V2.1 capabilities and record `CLOSEOUT_PARTIAL` with exact blockers.

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
- Real corpus uses at least three distinct frames per required route and an independent expected-data author/oracle.
- Shadow tap=0; first live canary global visual tap<=1; replay/stale/duplicate transport=0.

### F. Parallel and cleanup

- 04 acquire failure causes 03 action=0 and releases 03.
- Lane throw, never-resolving primitive, process interruption, cleanup timeout, release failure, and forged child `cleanup=true` cannot produce parent success.
- Peer lane cooperatively stops at a safe checkpoint.
- Parent receipt hashes complete child receipts; live `listLeases` independently shows no owned leases. An unrelated active lease is reported but not released or misattributed.

### G. Evidence and privacy

- Seed private artifacts with a sensitive query, name, phone, token-like string, OCR text, and absolute path. Recursively scan stdout/stderr, public DB projections, public receipts, and committed diff; only allowed private artifacts may contain them.
- Low-entropy query/title/author values use deployment-keyed digests, not plain SHA-256.
- Public aggregate can be rebuilt byte-for-byte from referenced receipts and exact release/provider/mission/lane hashes.
- Retention/ACL sweep preserves immutable purge receipts and evidence hashes.

### H. Live closeout

- Alias 01/02 session/job/device-I/O deltas are zero.
- Only aliases 03/04 appear, in fixed roles.
- Forbidden effects, social authority, social reservation, social transport, and visual effect taps are zero.
- Both lanes meet minimum content-route coverage, restore semantically, release, and leave zero owned leases.
- A zero-item, missing-route, unknown-cleanup, or identity/provider/release mismatch result is never SUCCESS.

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

## 10. Non-goals

- Likes, collects, follows, comments/replies, DMs, publish/delete, profile/account/settings, payments, purchases, or permission changes.
- Author-profile traversal, related-query recursion, open web links, or more than one content hop.
- Long-running unattended patrol, bulk scraping, content download/archive, or recommendation farming.
- Alias 01/02, alias 04 single execution, automatic fallback, dynamic role changes, or work stealing.
- Enabling Standing Grant, ADR 0010 DiscoverySession, legacy Mission social authorization, or `nonpayment_v1` debt for V3.
- Remote/cloud vision egress or model-selected coordinates/actions.
- Merging, pushing, or live execution as part of this plan-review turn.

## 11. Plan V1 decisions

- Use the proven Routine session/parallel shell but add a separate exploration machine; do not revive the old free-explore script or enable the incomplete DiscoverySession rollout.
- Make the CP navigation permit/profile the trust boundary; typed orchestrator methods alone are insufficient.
- Keep runtime selection deterministic and candidate-ID-only for V3. Model rankers/actions are deferred.
- Fix lane roles as 03 feed and 04 search to provide complementary coverage and a stable acceptance oracle.
- Treat Gate F and production vision as live/merge blockers, not blockers to offline implementation.
- Keep the initial live visual navigation budget at one globally. Multi-tap promotion is deferred.

## 12. Completion rule

Plan execution is complete only when:

1. all offline and full repository gates pass;
2. the formal task-owned deployment and executable rollback/re-forward drill pass;
3. the provider corpus, shadow, and one-shot canary pass;
4. R4 exact `[03,04]` passes every hard-zero, shared-budget, identity, privacy, and cleanup oracle;
5. a reproducible aggregate sets `XHS_V3_FREE_EXPLORATION_VERIFIED=true` without changing `S1_S4_LIVE_VERIFIED` or historical S2/S3.

Anything less is an honest partial closeout, not daily V3 activation.
