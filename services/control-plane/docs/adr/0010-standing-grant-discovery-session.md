# ADR 0010: Pre-Mission Standing Grant DiscoverySession

- Status: Proposed
- Date: 2026-07-30
- Depends on: ADR 0008, ADR 0009

## Context

ADR 0009 grants durable parent authority, but verified discovery cannot honestly use a Mission DeviceRun tuple before a Mission has been compiled. A client-supplied snapshot/evidence hash is not authority. The review therefore requires a separately fenced pre-Mission source for trusted observation lineage.

## Decision

The user (`user:a1234`) has confirmed this architecture and its bounded strategy. This record is a proposed design decision only: it does not enable either feature flag or authorize a rollout.

Adopt a single-device, pre-Mission **DiscoverySession** backed by the existing control-plane session/job/evidence/lease/transport architecture. It creates a minimal DiscoveryRun tuple bound to immutable `{grantId, grantHash}`, session/lease, controller agent/epoch, and job/run IDs. It never transfers this tuple to a Mission.

The DiscoverySession is R0/R1-only. It may run screenshot, dump, focus, launch, back, home, navigation tap/swipe, and search input. Effect Firewall must block all effects, including social actions, delete/profile/settings, payment, and publish. Any closed Grant/flag/ADR gate or loss of control stops, restores, and releases.

Only a fenced internal producer may append a private authoritative observation. Its immutable lineage includes the full DiscoveryRun control tuple, recorder identity, evidence ID/SHA-256, non-sensitive source/content hashes, observed time, and page/identity/target fingerprints. There is no public HTTP, CLI, Mission, or client write/update endpoint. Exact duplicate content is idempotent; conflicts are typed and the audit event is retained across restart.

Discovery observations are fresh for five seconds at capture and can compile a Mission for at most 60 seconds. A compiler must resolve the private row, validate its lineage and evidence binding, and compile the verified target into an immutable fingerprint target. The subsequent Mission gets a new placement/lease and rechecks both Grant and observation before DeviceRun/ECP prepare/execute/retry.

Defaults are 10 minutes, 80 primitives, and 10 candidates; Grant maxima are 30 minutes, 300 primitives, and 50 candidates; parallelism is one. Candidate discovery is one-hop from search/seed/context. Stable user ID wins; otherwise exact nickname + avatar + profile fingerprint is required. Ambiguity stops.

Raw screenshots retain for seven days; redacted hashes/audit retain for 90 days; access is restricted to the user and independent reviewer. Explicit targets remain a governed fallback, not a bypass.

## Consequences and rollback

The pre-Mission bootstrap cycle is removed without accepting client assertions or inventing a future Mission tuple. A new additive lifecycle, migration, audit/retention worker, and offline test matrix are required. Multi-device, draft-Mission strategy, and delete/profile/settings implementation stay out of scope.

Both feature flags remain false. If the feature is later enabled, rollback disables the Standing Grant flag first, stops active DiscoveryRuns through restoration/release, and retains immutable observations/audit for review; it does not delete evidence or replay effects. This ADR does not enable a flag, deploy code, issue a Grant, or authorize a device action.
