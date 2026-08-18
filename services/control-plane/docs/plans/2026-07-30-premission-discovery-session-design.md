# Pre-Mission DiscoverySession Design

## Purpose and non-goals

DiscoverySession solves the bootstrap cycle identified by the Standing Grant review: a verified-discovery Mission needs trusted observations before it can own a Mission DeviceRun tuple. A DiscoverySession is the separately fenced, no-effect R0/R1 phase that creates those observations. It reuses the existing session → job → evidence → lease → transport path; it is not a second scheduler, adapter gateway, or action-authorization system.

This design does not enable either feature flag, authorize a live effect, add a public observation API, implement multi-device scheduling, or make delete/profile/settings supported Grant actions. ADR 0010 remains Proposed; nothing here claims implementation or rollout authority.

**Phase1 scope annotation (2026-07-30)**: Standing Grant Phase1 is converged to explicit_target-only. DiscoveryRun lifecycle (Task 2) is implemented but never opened for explicit_target Missions — explicit_target skips DiscoveryRun entirely. The R0 producer (Task 3) is deferred; producer map stays `{}`. Discovery firewall, sealed observation lineage, and verified_discovery Mission compile are not in Phase1 scope. See `docs/plans/2026-07-30-standing-grant-phase1-explicit-target-only.md` for the authoritative Phase1 plan.

## Signed DiscoveryPolicy (Grant authority, not constants)

Discovery limits are **signed parent Grant authority**. They must live inside Standing Grant v1 `discoveryPolicy`, participate in schema validation, normalizer exact-key checks, canonical signed bytes, content hash, and issuer proofs. Caller-supplied duration/candidate/seed values and unsigned runtime constants are not authority.

Canonical DiscoveryPolicy (fail-closed on unknown keys or widening):

- `enabled` — false ⇒ zero Discovery allocation even if flags later flip
- `allowedPrimitives` — exact R0/R1 set only: screenshot, dump, focus, launch, back, home, navigation tap/swipe, search input, restore
- `defaults` — durationMs 600000 (10m), maxPrimitives 80, maxCandidates 10
- `maxima` — durationMs 1800000 (30m), maxPrimitives 300, maxCandidates 50; defaults ≤ maxima
- `maxParallelism` — 1
- `targetScope` — strict canonical anchors + closed relation allowlist + `maxHops: 1`, never a narrative one-hop claim
- `identityPolicy` — stable userId when present; otherwise exact nickname + avatar + profile fingerprint; ambiguity terminal (no approval conversion)
- `clocks` — `snapshotFreshnessMs=5000`, `observationCompileWindowMs=60000`
- `retention` — rawScreenshotDays=7, redactedHashAuditDays=90
- `accessPolicy` — signed owner subject hash + trusted reviewer-allowlist version; request role is not authority

Payment, publish, follow/like/collect/comment/DM, delete, profile, and settings are **never** DiscoveryPolicy members. Child Mission effect budgets remain the separate Grant `budget` object. Grants missing `discoveryPolicy`, or carrying widened/unknown Discovery fields, are rejected for Discovery open.

 `targetScope` has exact, signed, canonical fields:

 - `anchors`: non-empty, deduplicated `{type, hash}` records whose type is only
   `searchQueryHash`, `seedIdentityFingerprint`, `contentContextHash`, or
   explicit-target `identityFingerprint`; raw search/account/content text is forbidden.
 - `relationKinds`: closed `search_result | seed_profile_relation | content_author |
   content_mentioned_profile | explicit_target` enum, with valid anchor-kind pairing in the schema.
 - `maxHops`: exactly `1`.
 - `explicit_target` is the only relation kind allowed for explicit-target `identityFingerprint`; it has no automatic candidate expansion.

 Every candidate carries one signed anchor plus allowed relation kind and
 `relationEvidenceId/SHA-256`. Unknown/widened anchors, arbitrary caller seeds, a
 second hop, wrong app/account/page/identity, or relation-evidence mismatch is
 fail-closed before candidate/job allocation. An explicit target is the signed identity
 anchor form and therefore follows the same identity, budget, ECP, and audit path.

Current code baseline that this design repairs: `delegation-grant-policy.mjs` exact top-level keys and hash (`:45-76`), schema required set (`delegation-grant.schema.json:5-13`), and child effect-only budget (`:32-42`) have no DiscoveryPolicy today.

## Lifecycle and authority

### Governed entrypoints

Internal control-plane commands only (extension of allowed session control, not a public writer):

| Command | Role |
| --- | --- |
| `open` | Grant/flag/ADR/ready checks, then atomic factory |
| `action` | exclusive Discovery primitive path (Firewall + signed allowlist) |
| `seal` | stop producer, release session/lease, persist sealed lineage |
| `abort` | stop/restore/release with terminal aborted record |
| `status` / heartbeat | fencing + liveness while `running`/`sealing` |

No router/devicectl/public HTTP observation ingest, update, or delete. Router may expose lifecycle commands only; observation writer routes remain 404/403.

### Atomic open

`openDiscoveryRunStorage` runs in one `BEGIN IMMEDIATE` transaction and creates `{DiscoveryRun, Session, Lease, initial controllerEpoch}` together. It must **not** call nested `StateStore.createSession` (that helper already opens its own transaction at `state-store.mjs:1130-1236`). Pre-allocation checks (active Grant + matching grantHash, dual feature flags, ADR gate, canonical ready+free placement, valid signed DiscoveryPolicy, healthy issuer config) all run before any insert. A crash mid-factory leaves zero live session/lease/run.

The same transaction re-reads every precondition from authoritative storage and
persists an immutable policy snapshot: `openedAt`, `deadlineAt`, `maxPrimitives`,
`maxCandidates`, `maxParallelism=1`, `primitiveReserved`, and
`candidateReserved`. The unique active-run key and transaction make parallel open
attempts conflict; no caller-supplied budget, duration, or ready mirror can widen it.

### State machine and ownership

Minimum states: `running → sealing → sealed | aborted | recovery_required`.

- DiscoveryRun owns session/lease and controller epoch for the whole live window.
- Each R0 job/run records `{discoveryRunId, sessionId, controllerEpoch, evidenceId, sourceJobId, sourceRunId}`. Multiple R0 jobs may feed observations; the singular “tuple jobId/runId” is therefore **source provenance per observation**, not a single permanent job owned by the run.
- Stale epoch, wrong session/controller, Grant hash drift, control loss, revocation, flag/ADR closure, or malformed issuer ⇒ stop, restore UI, release lease, terminal `aborted` or `recovery_required`.
- `seal` transitions `running → sealing → sealed`, releases session/lease inside the seal transaction, and persists released tuple hashes + `releaseAt` + sealed observation anchors. After seal there is **no** live session/lease; compilers must not require an active run.
- Reopen of StateStore must reconstruct sealed/aborted records and refuse to reopen a released lease as live.
- Before every primitive reservation and before seal, the transaction re-reads active
  Grant/hash, both flags, ADR gate, canonical readiness, and issuer configuration. A
  concurrent revoke/gate closure fails closed: no next adapter call; restore/release and
  terminal abort/recovery are durable.
- Canonical ready+free is only the open placement test. During a live run, primitive,
  heartbeat, and seal require active lease/session/controllerEpoch/discoveryRunId
  ownership by this DiscoveryRun; its own valid lease continues. Foreign, missing,
  expired, or mismatched lease/epoch fails closed with no next adapter call and durable
  restore/release/terminal abort.

### No-effect producer

While `running`, the producer may collect only DiscoveryPolicy `allowedPrimitives`. Exclusive `executeDiscoveryPrimitive` (or equivalent discovery action boundary):

1. Validates session token + lease + controller epoch + discoveryRunId + Grant hash
2. Checks primitive ∈ signed allowlist
3. Classifies **fresh observed surface** via Effect Firewall DiscoverySession profile
4. Blocks every social/protected/unknown/risk-control/login/captcha/identity-mismatch surface
5. Only then creates an `externalEffect=false` job bound to discoveryRunId

Before that job exists, a single `BEGIN IMMEDIATE` transaction locks the run, checks
`now < deadlineAt`, reserves/increments `primitiveReserved`, and persists the job
intent. Idempotency is `{discoveryRunId, primitive, normalizedArgsHash}`: exact replay
returns the existing reservation; a changed replay is typed conflict. Deadline/quota
exhaustion performs typed abort plus restore/release with zero adapter call. Once job
intent exists its reservation is never refunded on restart or abandon.

Discovery sessions must not call generic `executeSessionAction` with an arbitrary capability (current generic path at `control-plane.mjs:1219-1262` never invokes Firewall). There is no PHC fallback and no social-effect adapter call in this phase.

### Authoritative observation append

An internal fenced producer appends an immutable, hash-only authoritative observation bound to:

- grantId/grantHash, discoveryRunId, sessionId, leaseId (hash after release), controllerAgent/epoch
- sourceJobId/sourceRunId, recorder identity
- evidence ID + SHA-256 (real EvidenceStore lookup), snapshot/source/content hashes
- page / observed-target / identity proof fingerprints, observedAt
- signed `anchorType`/`anchorHash`, allowed `relationKind`, and relation evidence ID + SHA-256

Duplicate byte-identical records reuse (idempotent). Same key with different tuple/source/content hash ⇒ typed `AUTHORITATIVE_OBSERVATION_CONFLICT`. Conflict and rejection audit events commit on a **separate successful transaction boundary** before the error is returned, so restart still shows the conflict. Public projections omit tuple, recorder, evidence path, raw account, identity text, serials, tokens, and full internal fields.

Candidate accounting runs in the same ingest transaction using canonical
`{identityFingerprint, anchorType, anchorHash, relationKind}`. Exact duplicate lineage
consumes no second candidate; changed lineage is conflict/audit. `seal`, `abort`, and
`abandon` serialize on the run row: the first terminal transition wins, preserves every
durable reservation, and prevents late job or adapter execution.

### Seal → Mission compile (no active run)

After independent lease release:

1. Observation must satisfy **snapshotFreshnessMs=5000** at seal (`deviceSnapshotAt → sealedAt`)
2. Compile must occur within **observationCompileWindowMs=60000** (`sealedAt → compileNow`)
3. Compiler resolves the private **sealed** row only; never caller-supplied hashes; never a live session/lease check
4. Validates Grant/hash, sealed lineage, signed anchor/relation membership, relation evidence, evidence reference/hash, app/account/page/identity/target
5. Converts verified target to existing fingerprint-target form and creates a **new** Mission placement/lease/DeviceRun
6. Before DeviceRun use and every ECP prepare/execute/retry, runtime re-resolves observation lineage and requires a **fresh effect observation receipt** (≤5000 ms, account/page/identity/target bound). Effects never rely on the old Discovery screenshot
7. Named clocks are distinct from `mission-policy.mjs` five-minute `SNAPSHOT_MAX_AGE_MS`; Mission verified-discovery must adopt the Discovery clocks, not accidentally keep 5 minutes

## Scope, budgets, identity, and explicit fallback

Automatic candidates must prove membership in the signed `targetScope` anchor/relation schema: exactly one allowed relation from a canonical search, seed, or content hash. An arbitrary accepted observation is not a target. Stable user ID wins; otherwise exact nickname + avatar + profile fingerprint is required. Ambiguous identity is terminal for the attempt and cannot become an approval request.

Explicit fingerprint targets remain supported as a fallback under the **same** Grant, identity, budget, ECP, and audit rules. They are not an observation bypass. The first canary remains **collect-only** on the explicit-target path. Strategy C is not the default autonomous strategy; explicit targets are the documented initial collect-only fallback.

## Retention, redaction, and ACL

- Raw screenshots: 7 days in restricted evidence storage
- Redacted hashes, lineage, audit events: 90 days
- Sweeper: bootstrap/startup or scheduled control-plane operation with injectable clock; on each run emit audit receipts; on failure retry without deleting hash/ID rows; after raw purge, evidence ID/SHA-256 rows remain and public output never includes raw paths
- ACL enforcement point: local restricted evidence/access gate admits only an authenticated subject matching the signed owner subject hash or a principal in trusted reviewer allowlist/config; never a request role; missing/malformed reviewer config denies; public APIs return only aggregate states, aliases, counts, and hashes
- At 90 days: purge redacted lineage/audit payloads only after recording an immutable non-sensitive tombstone/purge receipt (record class, opaque ID/hash, purge time, policy version, sweep receipt); no raw identity/path survives

## Gate matrix and deferred work

With either Mission flag, Standing Grant flag, or ADR gate closed, or with a malformed issuer configuration, the system creates zero DiscoveryRun, session, lease, job, heartbeat, observation, Mission, effect, approval, and adapter call. The legacy non-Mission R2 manual path is unchanged.

Multi-device discovery, two-stage draft Missions, and actual delete/profile/settings implementation are explicitly deferred. A later proposal must reopen scope and independent review before any of them changes.
