# ADR 0010: Pre-Mission Standing Grant DiscoverySession

- Status: Proposed
- Date: 2026-07-30
- Depends on: ADR 0008, ADR 0009

## Context

ADR 0009 grants durable parent authority, but verified discovery cannot honestly use a Mission DeviceRun tuple before a Mission has been compiled. A client-supplied snapshot/evidence hash is not authority. The review therefore requires a separately fenced pre-Mission source for trusted observation lineage.

This ADR remains **Proposed only**. It does not implement DiscoverySession, enable either feature flag, issue a Grant, deploy code, or authorize any device action.

## Decision

The user (`user:a1234`) has confirmed this architecture and its bounded strategy. This record is a proposed design decision only: it does not enable either feature flag or authorize a rollout.

Adopt a single-device, pre-Mission **DiscoverySession** backed by the existing control-plane session/job/evidence/lease/transport architecture. It is not a second scheduler, adapter gateway, or action-authorization system.

### Signed DiscoveryPolicy (Grant authority)

Discovery policy is **signed Grant authority**, not caller input or runtime constants. Standing Grant v1 must carry an explicit `discoveryPolicy` object that is part of:

- `control-plane/schema/delegation-grant.schema.json` required fields
- `validateDelegationGrantDraft` exact top-level key set and normalizer
- canonical signed bytes / content hash / issue payload
- issuer and subset tests

Required DiscoveryPolicy fields (exact authority; unknown/widening fail-closed):

| Field | Authority |
| --- | --- |
| `enabled` | boolean; when false, zero Discovery allocation |
| `allowedPrimitives` | exact R0/R1 allowlist only (screenshot, dump, focus, launch, back, home, navigation tap/swipe, search input, restore). Social, payment, publish, delete, profile, settings, and every effect are **never** DiscoveryPolicy members |
| `defaults` | durationMs=600000 (10m), maxPrimitives=80, maxCandidates=10 |
| `maxima` | durationMs=1800000 (30m), maxPrimitives=300, maxCandidates=50; defaults must not exceed maxima |
| `maxParallelism` | const 1 |
| `targetScope` | strict canonical `{anchors, relationKinds, maxHops: 1}`; no free-form one-hop claim |
| `identityPolicy` | stable userId wins; else exact nickname + avatar + profile fingerprint composite; ambiguity is terminal |
| `clocks` | `snapshotFreshnessMs=5000`, `observationCompileWindowMs=60000` (named; not the existing 5-minute Mission recovery constant) |
| `retention` | rawScreenshotDays=7, redactedHashAuditDays=90 |
| `accessPolicy` | signed owner subject hash + trusted reviewer-allowlist version; request role is never authority |

Old Grants without `discoveryPolicy`, or with widened/unknown fields, are rejected for Discovery. Child effect budgets (`budget.total/per-target/frequency`) remain separate and unchanged.

 `targetScope` is a strict canonical object, not a free-form “one-hop” claim:

 - `anchors` is a non-empty, deduplicated array of only `searchQueryHash`,
   `seedIdentityFingerprint`, `contentContextHash`, or explicit-target
   `identityFingerprint`; values are non-sensitive fixed-length hashes/fingerprints.
 - `relationKinds` is the closed allowlist `search_result | seed_profile_relation |
   content_author | content_mentioned_profile | explicit_target`, with its permitted anchor pairing
   defined by the same schema.
 - `maxHops` must be exactly `1`. Unknown anchors, relations, pairing, or a second hop
   reject before any candidate/job allocation.

 | Anchor type | Only permitted relation kind |
 | --- | --- |
 | `searchQueryHash` | `search_result` |
 | `seedIdentityFingerprint` | `seed_profile_relation` |
 | `contentContextHash` | `content_author` or `content_mentioned_profile` |
 | `identityFingerprint` | `explicit_target` (no automatic expansion) |

 An explicit target is a signed identity anchor under this same object, not a caller
 escape hatch.

### Lifecycle and ownership

 `openDiscoveryRunStorage` re-reads active Grant/hash, both flags, ADR gate, canonical
 ready/free placement, issuer configuration, and the signed policy **inside the same**
 `BEGIN IMMEDIATE` transaction that writes the allocation. It persists the immutable
 policy snapshot as `openedAt`, `deadlineAt`, `maxPrimitives`, `maxCandidates`,
 `maxParallelism=1`, `primitiveReserved`, and `candidateReserved`; concurrent open
 attempts conflict rather than oversubscribe the one active policy/grant scope.

1. Governed internal entrypoints only: `open` / `action` / `seal` / `abort` / `status` / heartbeat. No public HTTP/CLI/Mission/client write, update, or delete path for observations.
2. `openDiscoveryRunStorage` is one `BEGIN IMMEDIATE` factory that, after Grant/dual-flag/ADR/canonical-ready checks, atomically creates `{DiscoveryRun, Session, Lease, controllerEpoch}` without nesting the existing `createSession` transaction. Crash between any of those inserts must leave zero live allocation.
3. State machine (minimum): `running → sealing → sealed | aborted | recovery_required`. Terminal sealed/aborted/recovery records retain released tuple hashes plus `releaseAt`.
4. DiscoveryRun owns session/lease and controller epoch. Each R0 job/run binds `{discoveryRunId, sessionId, controllerEpoch, evidenceId, sourceJobId, sourceRunId}`. Multiple R0 jobs may contribute observations; ownership stays on DiscoveryRun, never on a future Mission.
5. Seal releases session/lease first. Compilation accepts only a **sealed** immutable lineage record inside the 60s compile window; it must not require an active run/session/lease.
6. Mission compilation creates a **new** placement/lease/DeviceRun. Discovery tuple is never transferred.

 `canonical ready+free` is an **open-only placement predicate**. While the run is live,
 every primitive, heartbeat, and seal rechecks canonical readiness/freshness plus that
 the active lease/session/controllerEpoch/discoveryRunId precisely belong to this
 DiscoveryRun. Its own valid lease is allowed to continue; foreign, missing, expired,
 or mismatched lease/epoch fails closed, aborts, restores, releases, and makes zero
 adapter call. A concurrent revoke or gate closure has the same result. Seal may only
 commit a lineage whose final validation succeeded.

### No-effect producer and firewall

The DiscoverySession is R0/R1-only. Exclusive `executeDiscoveryPrimitive` / discovery action boundary validates the signed DiscoveryPolicy allowlist and a fresh observed surface **before** job creation. Discovery sessions must not call generic `executeSessionAction` with another capability.

Effect Firewall (DiscoverySession profile) blocks all effects and unknown/risk-control/login/captcha/identity-mismatch surfaces, including follow, like, collect, comment, DM, delete, profile, settings, payment, and publish. Any closed Grant/flag/ADR gate or loss of control stops, restores, and releases.

 Every primitive uses one `BEGIN IMMEDIATE` transaction to revalidate the live
 authority, lock the run, check `now < deadlineAt`, reserve/increment
 `primitiveReserved`, and persist the job intent **before** job/adapter execution.
 The idempotency key binds `{discoveryRunId, primitive, normalizedArgsHash}`:
 byte-identical retry returns the same reservation, a changed replay is typed conflict,
 and a deadline/quota failure is typed abort with zero adapter call plus restore/release.
 A reservation is never refunded after its job intent exists, including restart or
 abandon, so retry cannot bypass the signed budget.

 Candidate ingest similarly atomically reserves/deduplicates `candidateReserved` using
 `{identityFingerprint, anchorType, anchorHash, relationKind}`. Exact duplicates cost
 no second candidate; changed lineage is typed conflict/audit. `seal`/`abort`/`abandon`
 races serialize on the run row: the first terminal transition wins and all later
 action/adapter work fails closed.

### Authoritative observation

Only a fenced internal producer may append a private authoritative observation. Immutable lineage includes the full DiscoveryRun control tuple, recorder identity, evidence ID/SHA-256, non-sensitive source/content hashes, observed time, page/identity/target fingerprints, `anchorType`, `anchorHash`, `relationKind`, and `relationEvidenceId/SHA-256`. Ingest proves the anchor is signed, the relation is allowed for it, and it is exactly one hop; seal, compiler, and ECP recheck the same proof. Exact duplicate content is idempotent; conflicts are typed. Conflict/rejection audit events are committed on a boundary that **survives** the error return (not rolled back with the failed insert). Public views omit all internal/source fields.

### Named clocks

Three named clocks with injectable test clock; do not reuse `mission-policy.mjs` `SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000`:

1. **snapshotFreshnessMs = 5000** — device snapshot → seal (`deviceSnapshotAt` / `sealedAt`)
2. **observationCompileWindowMs = 60000** — seal → compile (`sealedAt` → compile time)
3. **effect re-observation ≤ 5000 ms** — each ECP prepare/execute/retry requires a current adapter observation receipt bound to account/page/identity/target; never the old Discovery screenshot

### Mission compile and explicit fallback

Compiler resolves the private sealed row, validates Grant/hash, signed anchor/relation membership, sealed lineage, evidence binding, app/account/page/identity/target, then converts the verified target into the existing fingerprint-target form. Before DeviceRun use and ECP prepare/execute/retry, runtime re-resolves the observation and checks lineage/content hash and signed anchor/relation membership have not drifted. Discovery-capable ECP construction requires MissionRuntime; direct `missions=null` construction must fail closed for discovery paths.

Explicit fingerprint targets remain a governed fallback under the **same** Grant, identity, budget, ECP, and audit rules. They are not an observation bypass. The initial collect canary remains collect-only on the explicit-target path. Strategy C is **not** the default autonomous strategy.

### Retention, ACL, and gates

Raw screenshots retain for seven days in restricted evidence storage; redacted hashes/audit retain for 90 days. A bounded retention sweeper (bootstrap/startup or scheduled, injectable clock, audited) purges only expired raw bytes while preserving evidence ID/hash rows. At 90 days it replaces purged lineage/audit material with an immutable non-sensitive tombstone/purge receipt containing only record class, opaque ID/hash, purge time, policy version, and sweep receipt ID. Public projections never expose raw paths. Local ACL derives access only from an authenticated subject matching the signed owner subject hash or a trusted reviewer allowlist/configuration; it never trusts a request `role`, and missing/malformed reviewer configuration denies access.

With either Mission flag, Standing Grant flag, or ADR gate closed, or with a malformed issuer configuration, the system creates zero DiscoveryRun, session, lease, job, heartbeat, observation, Mission, effect, approval, and adapter call.

## Consequences and rollback

The pre-Mission bootstrap cycle is removed without accepting client assertions or inventing a future Mission tuple. Implementation requires:

1. Signed DiscoveryPolicy on Grant v1 (schema + normalizer + canonical hash + tests)
2. Atomic DiscoveryRun factory and sealed lifecycle
3. Exclusive firewall-gated R0 producer and append-only observation lineage
4. Named-clock Mission compile + ECP recheck + explicit-target parity
5. Retention sweeper, redaction, ACL, and full gate-matrix tests

Multi-device discovery, two-stage draft Missions, and delete/profile/settings capability paths stay out of scope.

Both feature flags remain false. If the feature is later enabled, rollback disables the Standing Grant flag first, stops active DiscoveryRuns through restoration/release, and retains immutable observations/audit for review; it does not delete evidence or replay effects. This ADR does not enable a flag, deploy code, issue a Grant, or authorize a device action.
