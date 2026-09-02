# XHS Routine V3 Plan V1 — Review and GPT Adjudication

Frozen Plan V1 SHA-256: `4d7273ba55093c92dce99c5e2686d3300a2330920441746bf23259e66620e363`  
Frozen packet SHA-256: `52aa479a5620d51cc7599dc6a8c904fd076b36919c47429ca6ca20c1961dc10e`  
Wave: `1` of `1`  
Authorization mode: `fix-once`

## Reviewer execution

- Coverage: intended and selected `kimi-k3-256k` through CPA; one successful call; verdict `needs_changes`; 3 findings.
- Adversarial: intended `grok-4.6`; its CPA health probe returned upstream 500, so the bounded preflight promoted the same role to local `deepseek-v4-pro:0813`; one successful call; verdict `needs_changes`; 5 findings.
- No third reviewer and no second review wave were used.

Raw batch directory: `C:/Users/windows 10/.codex/visualizations/2026/08/29/01a04b1b-82bc-7bb1-bfd4-6243fca634de/v3-review-v1`.

## Adjudication

### COV-F1 — P1 exact-pair contradiction: ACCEPT

Evidence is direct: Plan V1 requires both sessions before V3 device I/O but defines R3 as alias-03-only. Plan V2 changes R3 to exact `[03,04]`; the one global visual tap is eligible only on the 03 feed lane, while 04 remains DUMP-only and must still complete/restore.

### COV-F2 — P2 vision latency versus permit TTL: ACCEPT

The issue is valid, but the correction separates three budgets. Provider analysis occurs before permit issuance, has its own hard timeout, and consumes an analysis-attempt budget on timeout/staleness. A navigation permit is issued only after a fresh post-analysis recheck; it has a short numeric TTL and its reservation is conservatively consumed even if unused. Physical visual-tap count remains separately observable. This avoids both unlimited retry and a permit that ages while the provider is still running.

### COV-F3 — P2 keyed-digest key lifecycle unspecified: ACCEPT

Plan V2 defines a SYSTEM-only, environment-scoped 256-bit HMAC key ring, public `digestKeyId`, release/mission binding, fail-closed ACL checks, and rotation/retention semantics. The key is not derived from a public release hash and is never exposed to the planner/reviewer/public receipt.

### ADV-F1 — P1 circular observation authority: ACCEPT, narrowed to the supported defect

The request for a second device or out-of-band attestation is rejected as an unsupported scope expansion. Repository evidence already establishes that routine XML/PNG bytes are read from CP-owned, job-bound evidence rather than a caller path. The supported defect is that Plan V1 did not explicitly require permit consumption to reobserve the page and compare the exact sealed physical payload. Plan V2 requires:

- CP-owned producer/evidence references only;
- permit issuer resolution of the exact physical action;
- a fresh CP-owned consume-time observation/focus check;
- exact action/payload equality with the durable permit;
- atomic one-shot consumption before job creation;
- V3-session rejection of any raw interactive request.

A compromised physical device/driver that ignores the requested safe action is outside this software trust boundary; the independent after-state and hard-zero UI vector remain acceptance oracles.

### ADV-F2 — P1 stable-ID reconciliation algorithm absent: ACCEPT

Plan V2 defines transactional alias reconciliation. Before novelty credit, a post-open stable note ID rekeys the candidate to a keyed canonical ID; all matching pending/confirmed fallback aliases are merged; the earliest durable claim is canonical and all later aliases are duplicate/unknown. A duplicate physical open revealed only after post-open identity still consumes its action budget but receives no novelty credit.

### ADV-F3 — P1 subjective sparse/ambiguous DUMP: ACCEPT

Plan V2 replaces prose states with a closed DUMP verdict schema and required landmarks/roles/protected-zone coverage. `FORBIDDEN_OR_RISKY` stops and disables vision. `COMPLETE_SAFE_UNIQUE` is the only DUMP-tap state. `ABSENT_OR_INVALID` and `AMBIGUOUS_SAFE` may request vision observation, but a visual tap still needs positive navigation-role proof, protected-zone exclusion, unique safe geometry, and consume-time recheck. Vision can never supply missing authority by relabeling a protected control.

### ADV-F4 — P1 child receipt crash protocol absent: ACCEPT

Plan V2 requires a CP-owned append-only lane journal. A STARTED record is durable before first device I/O; every reservation/outcome/cleanup is appended; only a final COMMITTED marker seals the receipt hash. The parent reads the authority store rather than child output. Missing, partial, or uncommitted journals are terminal BLOCKED until independent recovery/cleanup writes an ABORTED/RECOVERED record; they can never produce SUCCESS.

### ADV-F5 — P1 runtime-only launcher has no content-addressed source: ACCEPT

Plan V2 makes the formal launcher a tracked release artifact and installs it into an immutable content-addressed runtime launcher directory. Binding and rollback tuples contain the launcher SHA-256 and task XML points at that exact artifact. Runtime-only hand edits are forbidden; an actual task-owned rollback and re-forward prove executability.

## Rejected and deferred suggestions

- Rejected: per-action second-device/out-of-band UI attestation. It materially expands the system and is not necessary once CP-owned evidence, exact permit payloads, consume-time reobservation, hard-zero state vectors, and raw-session rejection are explicit.
- Deferred: any runtime model ranker, related-query recursion, cross-run novelty memory, remote vision provider, or visual tap cap above one. None is required for V3's bounded first release.

## Result

All supported P1/P2 findings are incorporated into the one permitted Plan V2. No unresolved reviewer P0/P1 or user scope choice remains. Readiness still depends on deriving and locally validating the HIGH-risk execution contract; Plan V2 is not reviewed again.

## Owner addition after the review wave

Before Plan V2 was hashed or handed off, the owner explicitly requested that V3 also establish the reusable RPA framework suggested by their executor. The addition is incorporated into the same Plan V2 without another review wave, as required by the one-wave gate, and is bounded as follows:

- reuse existing M5 -> TaskPlanV2/ExecutionPlanV2 scheduling; no third scheduler;
- sealed routine/recipe references only, with atomic current-release eligibility evidence;
- CP-owned global pacing/tick ledger and complete receipts;
- read-only/hard-zero composition only;
- recurring activation, Windows wake installation, social nurture, and publish remain disabled/out of scope;
- one manual read-only acceptance run may occur only after V3 live acceptance.

The added persistence, concurrency, trigger, catalog-drift, injection, and kill-switch obligations are carried into the final execution contract as blocking HIGH-risk families.
