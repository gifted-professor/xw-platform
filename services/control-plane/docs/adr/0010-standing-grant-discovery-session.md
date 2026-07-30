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
| `targetScope` | one-hop from search terms / seed accounts / content context only |
| `identityPolicy` | stable userId wins; else exact nickname + avatar + profile fingerprint composite; ambiguity is terminal |
| `clocks` | `snapshotFreshnessMs=5000`, `observationCompileWindowMs=60000` (named; not the existing 5-minute Mission recovery constant) |
| `retention` | rawScreenshotDays=7, redactedHashAuditDays=90 |
| `accessRoles` | user + independent reviewer only |

Old Grants without `discoveryPolicy`, or with widened/unknown fields, are rejected for Discovery. Child effect budgets (`budget.total/per-target/frequency`) remain separate and unchanged.

### Lifecycle and ownership

1. Governed internal entrypoints only: `open` / `action` / `seal` / `abort` / `status` / heartbeat. No public HTTP/CLI/Mission/client write, update, or delete path for observations.
2. `openDiscoveryRunStorage` is one `BEGIN IMMEDIATE` factory that, after Grant/dual-flag/ADR/canonical-ready checks, atomically creates `{DiscoveryRun, Session, Lease, controllerEpoch}` without nesting the existing `createSession` transaction. Crash between any of those inserts must leave zero live allocation.
3. State machine (minimum): `running → sealing → sealed | aborted | recovery_required`. Terminal sealed/aborted/recovery records retain released tuple hashes plus `releaseAt`.
4. DiscoveryRun owns session/lease and controller epoch. Each R0 job/run binds `{discoveryRunId, sessionId, controllerEpoch, evidenceId, sourceJobId, sourceRunId}`. Multiple R0 jobs may contribute observations; ownership stays on DiscoveryRun, never on a future Mission.
5. Seal releases session/lease first. Compilation accepts only a **sealed** immutable lineage record inside the 60s compile window; it must not require an active run/session/lease.
6. Mission compilation creates a **new** placement/lease/DeviceRun. Discovery tuple is never transferred.

### No-effect producer and firewall

The DiscoverySession is R0/R1-only. Exclusive `executeDiscoveryPrimitive` / discovery action boundary validates the signed DiscoveryPolicy allowlist and a fresh observed surface **before** job creation. Discovery sessions must not call generic `executeSessionAction` with another capability.

Effect Firewall (DiscoverySession profile) blocks all effects and unknown/risk-control/login/captcha/identity-mismatch surfaces, including follow, like, collect, comment, DM, delete, profile, settings, payment, and publish. Any closed Grant/flag/ADR gate or loss of control stops, restores, and releases.

### Authoritative observation

Only a fenced internal producer may append a private authoritative observation. Immutable lineage includes the full DiscoveryRun control tuple, recorder identity, evidence ID/SHA-256, non-sensitive source/content hashes, observed time, and page/identity/target fingerprints. Exact duplicate content is idempotent; conflicts are typed. Conflict/rejection audit events are committed on a boundary that **survives** the error return (not rolled back with the failed insert). Public views omit all internal/source fields.

### Named clocks

Three named clocks with injectable test clock; do not reuse `mission-policy.mjs` `SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000`:

1. **snapshotFreshnessMs = 5000** — device snapshot → seal (`deviceSnapshotAt` / `sealedAt`)
2. **observationCompileWindowMs = 60000** — seal → compile (`sealedAt` → compile time)
3. **effect re-observation ≤ 5000 ms** — each ECP prepare/execute/retry requires a current adapter observation receipt bound to account/page/identity/target; never the old Discovery screenshot

### Mission compile and explicit fallback

Compiler resolves the private sealed row, validates Grant/hash, sealed lineage, evidence binding, app/account/page/identity/target, then converts the verified target into the existing fingerprint-target form. Before DeviceRun use and ECP prepare/execute/retry, runtime re-resolves the observation and checks lineage/content hash has not drifted. Discovery-capable ECP construction requires MissionRuntime; direct `missions=null` construction must fail closed for discovery paths.

Explicit fingerprint targets remain a governed fallback under the **same** Grant, identity, budget, ECP, and audit rules. They are not an observation bypass. The initial collect canary remains collect-only on the explicit-target path. Strategy C is **not** the default autonomous strategy.

### Retention, ACL, and gates

Raw screenshots retain for seven days in restricted evidence storage; redacted hashes/audit retain for 90 days. A bounded retention sweeper (bootstrap/startup or scheduled, injectable clock, audited) purges only expired raw bytes while preserving evidence ID/hash rows; public projections never expose raw paths. Local ACL enforcement admits only the authorized user and independent reviewer.

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
