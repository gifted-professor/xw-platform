# XHS Routine V3 execution addendum V2 — reviewed split gate

Date: 2026-08-30
Status: reviewed / execution-active
Owner direction: continue through the complete parent plan, including P7/RPA
Frozen parent: `docs/plans/xhs-routine-v3-free-exploration-plan-v2.md`
Frozen parent SHA-256: `305686655033f57c5e56683c502bbfc020f32c7070d69e74328f7a8ca33b5e70`

This addendum resolves one execution-order cycle found while implementing P4. It changes only the order in which
offline readiness, formal deployment, real-corpus capture, and live visual authorization close. It does not replace
or weaken any parent-plan safety, privacy, hard-zero, exact `[03,04]`, Gate-F, corpus, canary, cleanup, completion,
or RPA requirement. If the documents conflict outside that narrow ordering issue, the parent plan wins.

V2 incorporates the single authorized CRITICAL review wave. There is no second review wave and no review finding
may be used to broaden live vision or device authority.

## 1. Why the parent order needs a split gate

The parent requires the missing IMAGE_NOTE, VIDEO_NOTE, and COMMENT_PANEL real corpus to come from V3 R1/R2, but
R1/R2 execute only after P5, P5 follows P4, and the unsplit P4 gate requires that same complete corpus. The legacy
S4 capture scripts cannot break the cycle: they use a single alias, raw/fixed-coordinate actions, and do not create
V3 authority, DUMP, release, provider, session, or cleanup receipts.

The smallest safe resolution is:

`P4A offline/source readiness -> P5 formal deploy with visual budget mechanically locked at 0 -> R0 fixture ->
R1 DUMP-only -> R2 shadow -> E-Corpus PASS artifact -> R3/R4 -> P7`.

`P4A_READY_FOR_FORMAL_DEPLOY` is not `P4_PASS`, `Gate E PASS`, or product verification. Full P4 closes only when
E-Corpus and the parent plan's shadow/canary requirements close.

## 2. Terms and authority separation

- `evaluationRole` is sealed corpus metadata selected from the closed route/role matrix. It tells the offline
  evaluator what target the provider must classify. It is never a CP navigation permit, a live allowlist entry, or
  evidence that a tap was authorized.
- `dumpVerdict` is emitted by the production DUMP parser and bound into a CP-owned capture receipt. A labeler,
  provider, manifest author, or caller cannot change it.
- `fallback-positive` rows have an actual `AMBIGUOUS_SAFE` or `ABSENT_OR_INVALID` verdict and may exercise provider
  localization. `dump-resolved-negative` rows have `COMPLETE_SAFE_UNIQUE`; they exercise classification and prove
  that provider output cannot replace the DUMP path. `FORBIDDEN_OR_RISKY` rows are adverse mutations and never
  count toward base-route coverage.
- Live visual authority remains the parent-plan initial allowlist only:
  `VIDEO_NOTE / PAUSE_VIDEO_SAFE_ZONE`, alias 03 only in R3, with the existing global issued/physical cap of one.
  Offline provider coverage of other evaluation roles never widens that set.
- A DUMP navigation permit is not a visual permit. R1/R2 may execute the parent plan's typed, role-bound DUMP
  navigation transitions; their visual issued/consumed/physical counters remain exactly zero.

## 3. P4A — production-vision offline/source readiness

P4A must pass before P5 may mutate production state:

1. Implement the local provider, process isolation, cancellation, queueing, factory adapter, pin/verify tooling,
   and the 8,000 ms decision, 10,000 ms live-frame, and 5,000 ms permit limits. Provider children receive a minimal
   environment allowlist and cannot select a path, module, command, model, page, role, or authority.
2. Produce one canonical content-addressed provider-bundle manifest. It transitively hashes the exact interpreter,
   entry script, every model/data file, configuration, protocol version, and manifest bytes. Its
   `providerBundleDigest` is created in P4A, pinned unchanged by P5, and asserted equal by R0/R2/E-Corpus/R3.
   Mutable paths, partial four-hash identities, or an in-place retune are not identity.
3. Enforce a strict two-channel oracle. Provider input contains only exact frame bytes plus CP-bound frame hash,
   page class, and `evaluationRole`; it never contains expected geometry/verdict, protected-region annotations,
   oracle labels, mutation answers, or provider-derived expected data. The evaluator owns hidden expected data.
4. Extend the corpus protocol to preserve the actual four DUMP verdicts. Both fallback-positive and
   dump-resolved-negative rows may satisfy real route coverage, but only fallback-positive rows exercise the live
   fallback decision algorithm. A COMPLETE row can never be relabelled ambiguous/absent; a forbidden row can never
   be made eligible by benign provider output.
5. Add the tracked `preflight|capture|seal|evaluate` corpus operator and its private/public schemas. In P4A this is
   source implementation and fixture/fake-adapter testing only. Every P4A operator test must independently assert
   `jobs=0`, `sessions=0`, `leases=0`, and `deviceIo=0`. No production config, task, service, device, or raw evidence
   is touched before P5.
6. Pass property, mutation, crash/absence, forgery/replay, privacy, oracle-leakage, provider-isolation, role/page,
   bundle-drift, and zero-I/O phase-boundary tests.

P4A output is a source commit, clean test reports, the provider-bundle digest, operator schema hashes, and the
literal state `P4A_READY_FOR_FORMAL_DEPLOY`. It cannot mint an E-Corpus artifact.

## 4. P5 — formal deployment, Gate F, and the zero-visual interlock

After P4A passes, execute the parent P5 gate in full:

- run targeted suites, `test:xhs-routine`, `test:xhs-pack`, `test:fusion`, and all Gate tests;
- build a clean content-addressed release containing `5dab77f` and all accepted V3 source;
- install the immutable tracked launcher and exact SYSTEM task binding; `.simple`, caller-selected launchers, and
  runtime-only edits remain forbidden;
- provision the SYSTEM/Administrators-only digest key ring and provider config, pinning the exact P4A
  `providerBundleDigest` and release/source identity;
- wire the corpus operator only through the formal CP task/runtime path;
- close Gate F with task-owned listener ancestry and exact CP/Registry/serve-03/serve-04/manifest/current identity;
- perform one actual content-addressed rollback and re-forward drill, ending with zero jobs/sessions/leases.

The deployed policy and Gate-F binding must mechanically enforce:

1. `effectiveVisualPermitBudget=0` when the E-Corpus artifact is absent, invalid, stale, non-PASS, forged, or bound
   to another release/provider/corpus/evaluator/key.
2. R0/R1/R2 cannot compile, reserve, issue, consume, or physically execute a visual permit. `vision=shadow` may
   analyze only captured DUMP frames and is never a permit source.
3. The only unlock input is a task-owned, content-addressed `xw.xhs.e-corpus-pass.v1` artifact. It binds release ID,
   40-hex source, provider-bundle digest, corpus/public-manifest hash, private-index digest, evaluator source hash,
   test-report hash, digest-key ID, and `status=PASS` under the production key ring.
4. R3 compilation performs a fresh registry/CP verification of that exact artifact. Missing, stale, wrong-provider,
   wrong-release, replayed, unsigned, copied, or caller-supplied artifacts reject before reservation or device I/O.

Forging/minting/replay tests for this interlock are part of Gate F. An E-Corpus failure never permits an in-place
provider edit: a changed provider bundle creates a new digest and requires a new P4A result, P5 deployment/Gate-F
closure, and fresh corpus evaluation.

## 5. R0 fixture and R1/R2 route reachability

Run only after P5 passes.

### R0 — deployed offline fixture

Exercise the deployed operator, provider, interlock, receipt signer, private loader, and evaluator through a
task-owned fake device adapter. Prove device I/O and live resource creation are zero, the provider digest equals
P4A/P5, visual budget remains zero, and E-Corpus cannot be forged. A failed R0 rolls back or blocks R1.

### R1/R2 navigation matrix

R1 and R2 are exact `[03,04]` formal CP waves with a common authority, acquire barrier, fixed roles, typed actions,
fresh DUMP pre/postconditions, bounded budgets, and all-settled cleanup. They may reach required pages as follows:

| Required route | Admissible fixed lane(s) | Non-visual DUMP transitions used to reach/capture it |
|---|---|---|
| HOME_FEED | 03 feed lane | initial/RESTORE, bounded SCROLL_FEED |
| SEARCH_RESULTS | 04 search lane | OPEN_SEARCH, exact sealed SUBMIT_SEARCH, bounded SCROLL_RESULTS |
| IMAGE_NOTE | 03 or 04, without work stealing | DUMP-resolved OPEN_CONTENT_CARD; assert IMAGE_NOTE |
| VIDEO_NOTE | 03 or 04, without work stealing | DUMP-resolved OPEN_CONTENT_CARD; assert VIDEO_NOTE; no pause tap |
| COMMENT_PANEL | the lane that opened its note | DUMP-resolved OPEN_COMMENT_PANEL; assert COMMENT_PANEL; BACK |

Only `COMPLETE_SAFE_UNIQUE` DUMP transitions may perform those non-visual navigation primitives. Ambiguous/absent
navigation is captured for evaluation but not executed; forbidden/risky stops the transition. Search/input, swipes,
content opens, comment-panel opens, BACK, and RESTORE all use the parent plan's typed CP permits—never ADB, port
22222, raw helpers, arbitrary shell, coordinate literals, or legacy capture scripts.

- **R1 DUMP-only:** capture CP-bound frame/DUMP/focus evidence at each admitted route; visual counters are zero.
- **R2 shadow:** repeat the exact-pair DUMP traversal with the real pinned provider. The provider may analyze the
  CP-captured frame and record agreement/conflict, but visual issued/consumed/physical counters are all zero.
- CAPTCHA, login/auth/risk/system overlays stop the wave. Two consecutive navigation failures stop business work.
  Failure never widens a budget, changes a lane, reuses a permit, or authorizes retry-by-raw-action.

## 6. Capture attestation, blinded labels, and diversity

For every candidate row, CP writes a private HMAC/content-addressed capture receipt binding at least:

`pngHash, dumpHash, focusHash, pageClass, evaluationRole, actual dumpVerdict/reasons/regions, alias, fixed lane role,
session digest, lease digest, authority/wave digest, release/source, providerBundleDigest, digestKeyId`.

The public manifest contains only opaque refs/keyed digests and content hashes. It never contains pixels, XML/OCR
or bounded page text, coordinates that reveal a raw device frame outside the reviewed geometry schema, serials,
tokens, raw job/session/lease/run IDs, private paths, or account data. Raw PNG/XML/focus, the ref map, and private
receipts stay in deny-by-default SYSTEM/Administrators storage under the parent retention rule.

An independent label workspace may read the captured frame and reviewed DUMP receipt, but is ACL-separated from
provider output and implementation answers. The reviewer authors only expected provider outcome/geometry and
protected-region checks; page class, evaluation role, frame binding, and actual DUMP verdict are immutable CP
fields. A label-session manifest records reviewer identity/role, input hashes, denied provider-output access,
annotation-seal time/hash, and provider-output disclosure (if any) only after sealing. The evaluator rejects a row
without this blinding/attestation chain.

E-Corpus diversity is mechanical:

- every required route has at least three globally distinct real PNG SHA-256 values;
- each route spans both R1 and R2 and at least two distinct exact-pair authority/session receipts, with no more than
  two counting rows for that route from one wave;
- HOME_FEED rows are alias 03; SEARCH_RESULTS rows are alias 04; detail/comment rows may be 03 or 04 only when that
  fixed lane reached them naturally—no reassignment or work stealing;
- IMAGE_NOTE, VIDEO_NOTE, and COMMENT_PANEL each span at least two opaque content/surface claim digests, preventing
  time/video jitter on one unchanged page from filling all three slots;
- duplicate PNG, receipt, surface claim, cross-wave replay, route/role drift, or unverifiable source refs fail closed.

All pre-P5 HOME_FEED/SEARCH_RESULTS rows and historical V2 captures are tagged `calibration-only`. They may test
code offline but cannot close E-Corpus. Every counting E-Corpus row must be recaptured under the P5 release in R1/R2.

## 7. E-Corpus checkpoint

After R1/R2 cleanup proves exact aliases/roles, authority close, restoration, zero social/effect transport, and zero
leases, seal the public manifest and private index, then run the production provider/evaluator plus adverse mutations.

E-Corpus passes only when:

1. section 6 coverage, provenance, blinding, and diversity all reproduce from private evidence;
2. every CP receipt and HMAC/hash binding reproduces under the pinned release/provider/key identities;
3. the provider passes the hidden expected-data oracle without receiving or inferring expected data;
4. dump-resolved-negative rows cannot invoke/authorize live fallback, forbidden rows remain forbidden, and every
   benign relabel/social-region/duplicate/low-confidence/bounds/stale/cross-lane/path/provider mutation fails closed;
5. R2 and all evaluator/adverse runs prove aggregate social/effect transport=0 and visual tap=0;
6. the task-owned sealer, not a caller, emits the one content-addressed `xw.xhs.e-corpus-pass.v1` artifact.

Until that exact artifact verifies, R3 is mechanically forbidden and `XHS_V3_FREE_EXPLORATION_VERIFIED` remains
unset/false. A partial corpus is a named blocker, not a PASS.

## 8. R3/R4, closeout, and P7

After E-Corpus PASS, resume the parent plan unchanged:

- R3 exact `[03,04]` sparse one-shot canary: only alias 03 and only
  `VIDEO_NOTE / PAUSE_VIDEO_SAFE_ZONE` are visual-permit eligible; globally issued permits and physical visual taps
  are each at most one; alias 04 remains DUMP-only; social/effect transport is zero.
- R4 exact `[03,04]` small-budget goal exploration with shared budgets/deduplication, complete CP-owned journals,
  semantic restoration, authority close, and independent zero-lease proof.
- Only the fully reproduced aggregate may set `XHS_V3_FREE_EXPLORATION_VERIFIED=true`.
- P7 implements the parent plan's RPA schema/compiler/catalog/M5 adapter/ledger/kill/CLI foundation. It remains
  disabled by default. After P6, one explicit read-only `manual-once` may run; `RPA_RECURRING_ENABLED=false`, no
  recurring business program is enabled, and no recurring Windows wake task is installed or enabled.

## 9. Explicit prohibitions and failure handling

- Do not run `qualification-bootstrap/s4-corpus-capture*.mjs`, raw ADB/22222/fixed-coordinate helpers, or a generic
  Explorer tap/swipe/input/back path.
- Do not accept caller-selected aliases, endpoints, providers, paths, commands, modules, roles, or E-Corpus data.
- Do not expose private evidence or loosen historical evidence ACLs.
- Do not count a frame without its CP/session/DUMP/release receipt or a calibration/historical frame as R1/R2.
- Do not treat `evaluationRole`, offline provider support, or a COMPLETE row as live visual authority.
- Do not retry a consumed permit, widen a failed wave, bypass Gate F/E-Corpus, or enter R3 early.
- Any provider retune, release drift, key drift, or E-Corpus failure returns to the corresponding P4A/P5 boundary.
- Every failure still performs shielded RESTORE, closes authority, releases both sessions, and independently proves
  zero owned leases; otherwise the aggregate is BLOCKED.

## 10. Completion rule

This addendum is complete only when the parent completion rule is complete: all offline/full-repository gates,
formal task-owned deployment and rollback/re-forward, real provider corpus, R2 shadow, R3 one-shot canary, R4 exact
pair acceptance, reproducible V3 aggregate, and disabled-by-default P7 foundation plus one read-only manual acceptance
all pass without changing historical S2/S3 or enabling recurring/social behavior. Anything less is an honest partial
closeout, never daily V3 activation.
