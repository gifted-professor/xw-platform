# Pre-Mission DiscoverySession Design

## Purpose and non-goals

DiscoverySession solves the bootstrap cycle identified by the Standing Grant review: a verified-discovery Mission needs trusted observations before it can own a Mission DeviceRun tuple. A DiscoverySession is the separately fenced, no-effect R0/R1 phase that creates those observations. It reuses the existing session → job → evidence → lease → transport path; it is not a second scheduler, adapter gateway, or action-authorization system.

This design does not enable either feature flag, authorize a live effect, add a public observation API, implement multi-device scheduling, or make delete/profile/settings supported Grant actions. ADR 0010 remains Proposed; nothing here claims implementation or rollout authority.

## Signed DiscoveryPolicy (Grant authority, not constants)

Discovery limits are **signed parent Grant authority**. They must live inside Standing Grant v1 `discoveryPolicy`, participate in schema validation, normalizer exact-key checks, canonical signed bytes, content hash, and issuer proofs. Caller-supplied duration/candidate/seed values and unsigned runtime constants are not authority.

Canonical DiscoveryPolicy (fail-closed on unknown keys or widening):

- `enabled` — false ⇒ zero Discovery allocation even if flags later flip
- `allowedPrimitives` — exact R0/R1 set only: screenshot, dump, focus, launch, back, home, navigation tap/swipe, search input, restore
- `defaults` — durationMs 600000 (10m), maxPrimitives 80, maxCandidates 10
- `maxima` — durationMs 1800000 (30m), maxPrimitives 300, maxCandidates 50; defaults ≤ maxima
- `maxParallelism` — 1
- `targetScope` — one-hop from Mission search terms, seed accounts, or content context
- `identityPolicy` — stable userId when present; otherwise exact nickname + avatar + profile fingerprint; ambiguity terminal (no approval conversion)
- `clocks` — `snapshotFreshnessMs=5000`, `observationCompileWindowMs=60000`
- `retention` — rawScreenshotDays=7, redactedHashAuditDays=90
- `accessRoles` — user + independent reviewer

Payment, publish, follow/like/collect/comment/DM, delete, profile, and settings are **never** DiscoveryPolicy members. Child Mission effect budgets remain the separate Grant `budget` object. Grants missing `discoveryPolicy`, or carrying widened/unknown Discovery fields, are rejected for Discovery open.

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

### State machine and ownership

Minimum states: `running → sealing → sealed | aborted | recovery_required`.

- DiscoveryRun owns session/lease and controller epoch for the whole live window.
- Each R0 job/run records `{discoveryRunId, sessionId, controllerEpoch, evidenceId, sourceJobId, sourceRunId}`. Multiple R0 jobs may feed observations; the singular “tuple jobId/runId” is therefore **source provenance per observation**, not a single permanent job owned by the run.
- Stale epoch, wrong session/controller, Grant hash drift, control loss, revocation, flag/ADR closure, or malformed issuer ⇒ stop, restore UI, release lease, terminal `aborted` or `recovery_required`.
- `seal` transitions `running → sealing → sealed`, releases session/lease inside the seal transaction, and persists released tuple hashes + `releaseAt` + sealed observation anchors. After seal there is **no** live session/lease; compilers must not require an active run.
- Reopen of StateStore must reconstruct sealed/aborted records and refuse to reopen a released lease as live.

### No-effect producer

While `running`, the producer may collect only DiscoveryPolicy `allowedPrimitives`. Exclusive `executeDiscoveryPrimitive` (or equivalent discovery action boundary):

1. Validates session token + controller epoch + Grant hash
2. Checks primitive ∈ signed allowlist
3. Classifies **fresh observed surface** via Effect Firewall DiscoverySession profile
4. Blocks every social/protected/unknown/risk-control/login/captcha/identity-mismatch surface
5. Only then creates an `externalEffect=false` job bound to discoveryRunId

Discovery sessions must not call generic `executeSessionAction` with an arbitrary capability (current generic path at `control-plane.mjs:1219-1262` never invokes Firewall). There is no PHC fallback and no social-effect adapter call in this phase.

### Authoritative observation append

An internal fenced producer appends an immutable, hash-only authoritative observation bound to:

- grantId/grantHash, discoveryRunId, sessionId, leaseId (hash after release), controllerAgent/epoch
- sourceJobId/sourceRunId, recorder identity
- evidence ID + SHA-256 (real EvidenceStore lookup), snapshot/source/content hashes
- page / observed-target / identity proof fingerprints, observedAt

Duplicate byte-identical records reuse (idempotent). Same key with different tuple/source/content hash ⇒ typed `AUTHORITATIVE_OBSERVATION_CONFLICT`. Conflict and rejection audit events commit on a **separate successful transaction boundary** before the error is returned, so restart still shows the conflict. Public projections omit tuple, recorder, evidence path, raw account, identity text, serials, tokens, and full internal fields.

### Seal → Mission compile (no active run)

After independent lease release:

1. Observation must satisfy **snapshotFreshnessMs=5000** at seal (`deviceSnapshotAt → sealedAt`)
2. Compile must occur within **observationCompileWindowMs=60000** (`sealedAt → compileNow`)
3. Compiler resolves the private **sealed** row only; never caller-supplied hashes; never a live session/lease check
4. Validates Grant/hash, sealed lineage, evidence reference/hash, app/account/page/identity/target
5. Converts verified target to existing fingerprint-target form and creates a **new** Mission placement/lease/DeviceRun
6. Before DeviceRun use and every ECP prepare/execute/retry, runtime re-resolves observation lineage and requires a **fresh effect observation receipt** (≤5000 ms, account/page/identity/target bound). Effects never rely on the old Discovery screenshot
7. Named clocks are distinct from `mission-policy.mjs` five-minute `SNAPSHOT_MAX_AGE_MS`; Mission verified-discovery must adopt the Discovery clocks, not accidentally keep 5 minutes

## Scope, budgets, identity, and explicit fallback

Automatic candidates are limited to one-hop relations from Mission search terms, seed accounts, or content context, under signed `targetScope`. Stable user ID wins; otherwise exact nickname + avatar + profile fingerprint is required. Ambiguous identity is terminal for the attempt and cannot become an approval request.

Explicit fingerprint targets remain supported as a fallback under the **same** Grant, identity, budget, ECP, and audit rules. They are not an observation bypass. The first canary remains **collect-only** on the explicit-target path. Strategy C is not the default autonomous strategy; explicit targets are the documented initial collect-only fallback.

## Retention, redaction, and ACL

- Raw screenshots: 7 days in restricted evidence storage
- Redacted hashes, lineage, audit events: 90 days
- Sweeper: bootstrap/startup or scheduled control-plane operation with injectable clock; on each run emit audit receipts; on failure retry without deleting hash/ID rows; after raw purge, evidence ID/SHA-256 rows remain and public output never includes raw paths
- ACL enforcement point: local restricted evidence/access gate admits only authorized user and independent reviewer; public APIs return only aggregate states, aliases, counts, and hashes

## Gate matrix and deferred work

With either Mission flag, Standing Grant flag, or ADR gate closed, or with a malformed issuer configuration, the system creates zero DiscoveryRun, session, lease, job, heartbeat, observation, Mission, effect, approval, and adapter call. The legacy non-Mission R2 manual path is unchanged.

Multi-device discovery, two-stage draft Missions, and actual delete/profile/settings implementation are explicitly deferred. A later proposal must reopen scope and independent review before any of them changes.
