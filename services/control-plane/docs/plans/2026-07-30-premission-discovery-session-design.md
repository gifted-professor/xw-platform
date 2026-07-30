# Pre-Mission DiscoverySession Design

## Purpose and non-goals

DiscoverySession solves the bootstrap cycle identified by the Standing Grant review: a verified-discovery Mission needs trusted observations before it can own a Mission DeviceRun tuple. A DiscoverySession is the separately fenced, no-effect R0/R1 phase that creates those observations. It reuses the existing session → job → evidence → lease → transport path; it is not a second scheduler, adapter gateway, or action-authorization system.

This design does not enable either feature flag, authorize a live effect, add a public observation API, or implement multi-device scheduling. It also does not make delete/profile/settings supported Grant actions.

## Lifecycle and authority

1. A previously verified active Standing Grant starts a single-device DiscoverySession. The control plane atomically selects canonical ready+free placement and creates a **DiscoveryRun** with its own session, lease, job/run references, controller agent, and controller epoch. This is the source tuple; it is never borrowed from a future Mission.
2. The R0/R1 producer holds `{grantId, grantHash, discoveryRunId, sessionId, leaseId, controllerAgent, controllerEpoch, jobId, runId}`. A stale epoch, control loss, grant revocation, flag/ADR closure, or malformed issuer configuration stops the run, restores UI, and releases its lease.
3. The producer may collect only screenshot/dump/focus/launch/back/home/navigation tap/swipe/search input. Effect Firewall blocks follow, like, collect, comment, DM, delete, profile, settings, payment, and publish. There is no PHC fallback and no social-effect adapter call in this phase.
4. An internal fenced producer appends an immutable, hash-only authoritative observation. It binds the source tuple, recorder identity, evidence ID plus SHA-256, snapshot/source/content hashes, page and observed-target fingerprints, identity proof hash, and observed time. Duplicate byte-identical records reuse; any same-key difference is a typed conflict. Public views omit all internal/source fields.
5. After its independent lease is released, the control plane may compile a finite immutable Mission within 60 seconds from an observation no older than 5 seconds at capture. Compilation resolves the private observation row, checks Grant/hash, source tuple integrity, evidence reference/hash, app/account/page/identity/target, then converts the verified target to the existing fingerprint-target form.
6. The compiled Mission performs a fresh placement and receives a new Mission DeviceRun/lease. Before DeviceRun use and ECP prepare/execute/retry, the runtime re-resolves the authoritative observation and checks that its lineage/content hash has not drifted. An effect uses a fresh observation; it never relies on the old Discovery screenshot.

## Scope, budgets, and identity

DiscoverySession defaults are 10 minutes, 80 primitives, and 10 candidate observations. Grant maxima are 30 minutes, 300 primitives, and 50 candidates. Parallelism is fixed at one.

Automatic candidates are limited to one-hop relations from Mission search terms, seed accounts, or content context. Stable user ID is required when available; otherwise the system requires an exact nickname + avatar + profile fingerprint composite. Ambiguous identity is terminal for the attempt and cannot be converted to an approval request.

Explicit fingerprint targets remain supported as a fallback under the same Grant, identity, budget, ECP, and audit rules. They are not an observation bypass and are the only allowed path for the initial collect canary.

## Retention and visibility

Raw screenshots remain for seven days in restricted evidence storage. Redacted hashes, lineage, and audit events remain for 90 days. Only the authorized user and independent reviewer may inspect restricted material. Public APIs return only allowed aggregate states, aliases, counts, and hashes; they never expose account/identity text, paths, serials, tokens, raw screenshots, or full tuples.

## Gate matrix and deferred work

With either Mission flag, Standing Grant flag, or ADR gate closed, or with a malformed issuer configuration, the system creates zero DiscoveryRun, session, lease, job, heartbeat, observation, Mission, effect, approval, and adapter call. The legacy non-Mission R2 manual path is unchanged.

Multi-device discovery, two-stage draft Missions, default strategy C, and actual delete/profile/settings implementation are explicitly deferred. A later proposal must reopen scope and independent review before any of them changes.
