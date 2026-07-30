# Standing Grant DiscoverySession Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a fenced, no-effect pre-Mission DiscoverySession that produces auditable authoritative observations for finite Standing Grant Missions.

**Architecture:** Reuse existing StateStore, placement, session/lease, job, evidence, Effect Firewall, and ECP components. A DiscoveryRun owns its own fenced tuple and produces immutable private observations; Mission compilation later resolves those rows into fingerprint targets and gets a fresh Mission lease.

**Tech Stack:** Node.js ESM, `node:sqlite` StateStore transactions, existing ControlPlane/DeviceRun/EvidenceStore, Node test runner.

---

### Task 1: Add additive DiscoveryRun and authoritative-observation storage

**Files:**
- Modify: `control-plane/lib/state-store.mjs`
- Modify: `tests/control-plane-placement.test.mjs`
- Create: `tests/discovery-session-state.test.mjs`

**Step 1: Write the failing test**

Add a v7 fixture migration test and tests for an immutable `discovery_runs` row plus `authoritative_observations` row. Require duplicate byte-identical insert reuse, same identity with changed tuple/source/content hash to throw `AUTHORITATIVE_OBSERVATION_CONFLICT`, append-only recorded/conflict audit events, and reopen persistence. Assert public views omit tuple, recorder, evidence path, raw account, and identity text.

**Step 2: Run test to verify it fails**

Run: `node --test tests/discovery-session-state.test.mjs tests/control-plane-placement.test.mjs`

Expected: FAIL because DiscoveryRun tables, immutable lineage, and migration are absent.

**Step 3: Write minimal implementation**

Add v8 additive tables/indexes for `discovery_runs`, immutable observation lineage, and append-only discovery events. Store only IDs/hashes/timestamps: grant/hash, DiscoveryRun/session/lease/controller/epoch/job/run, recorder ID, evidence ID/SHA-256, source/content/snapshot hashes, page/target/identity fingerprints. Add transactional create/get/list and insert-only event helpers; no public writer.

**Step 4: Run test to verify it passes**

Run: `node --test tests/discovery-session-state.test.mjs tests/control-plane-placement.test.mjs`

Expected: PASS; legacy rows and idempotency survive v7→v8.

**Step 5: Commit**

`git commit -m "feat(control-plane): persist fenced discovery observations"`

### Task 2: Create and fence the no-effect DiscoveryRun lifecycle

**Files:**
- Create: `control-plane/lib/discovery-session.mjs`
- Modify: `control-plane/lib/control-plane.mjs`
- Modify: `control-plane/lib/effect-firewall.mjs`
- Modify: `tests/discovery-session.test.mjs`

**Step 1: Write the failing test**

Prove a verified Grant can atomically create one canonical ready/free DiscoveryRun with its own session/lease/tuple. Assert stale epoch, wrong session, controller, Grant hash, or control loss rejects before a producer call; closing any Grant/flag/ADR gate creates zero run/session/lease/job/heartbeat/observation/adapter call.

**Step 2: Run test to verify it fails**

Run: `node --test tests/discovery-session.test.mjs`

Expected: FAIL because no DiscoveryRun lifecycle/fencing API exists.

**Step 3: Write minimal implementation**

Use existing atomic placement and lease/session machinery; do not add a scheduler. Generate the DiscoveryRun tuple before observation, persist it, and auto-heartbeat only while active. On stop, Grant/flag/ADR failure, or control loss, invoke existing restore then release the independent lease. Extend Firewall with a DiscoverySession profile that allows only R0/R1 primitives and blocks every effect surface.

**Step 4: Run test to verify it passes**

Run: `node --test tests/discovery-session.test.mjs tests/mission-explorer-firewall.test.mjs`

Expected: PASS; no social/payment/publish/delete/profile/settings adapter path exists.

**Step 5: Commit**

`git commit -m "feat(control-plane): fence standing grant discovery sessions"`

### Task 3: Bind controlled R0/R1 evidence to append-only observations

**Files:**
- Modify: `control-plane/lib/control-plane.mjs`
- Modify: `control-plane/lib/evidence-store.mjs`
- Modify: `control-plane/lib/state-store.mjs`
- Modify: `tests/discovery-session.test.mjs`
- Modify: `tests/control-plane-evidence.test.mjs`

**Step 1: Write the failing test**

Use a fake R0 producer that records an evidence artifact through EvidenceStore. Prove ingest verifies the complete DiscoveryRun tuple, evidence ID/SHA-256 existence, recorder identity, and source/content hash before append. Assert forged client record, stale epoch, wrong evidence hash/session/controller, raw paths/text/tokens, and update/delete attempts all fail closed.

**Step 2: Run test to verify it fails**

Run: `node --test tests/discovery-session.test.mjs tests/control-plane-evidence.test.mjs`

Expected: FAIL because observation ingest is not lineage-bound.

**Step 3: Write minimal implementation**

Expose an internal ControlPlane method only to the fenced DiscoveryRun producer; do not add router/devicectl transport. Require evidence index lookup and matching SHA-256, append the immutable observation plus event in one transaction, and return a redacted receipt.

**Step 4: Run test to verify it passes**

Run: `node --test tests/discovery-session.test.mjs tests/control-plane-evidence.test.mjs`

Expected: PASS; a StateStore reopen verifies the same lineage and audit history.

**Step 5: Commit**

`git commit -m "feat(control-plane): audit discovery observation lineage"`

### Task 4: Compile observations into fresh finite Missions and recheck ECP

**Files:**
- Modify: `control-plane/lib/mission-runtime.mjs`
- Modify: `control-plane/lib/effect-commit-protocol.mjs`
- Modify: `control-plane/lib/state-store.mjs`
- Modify: `tests/control-plane-mission.test.mjs`
- Modify: `tests/effect-commit-protocol.test.mjs`

**Step 1: Write the failing test**

Prove only a <=60-second immutable observation from an active DiscoveryRun compiles a finite child Mission, and it becomes the stable fingerprint target. Test stale/missing, grant/hash drift, evidence/source/tuple/content hash drift, wrong app/account/page/identity, and StateStore reopen. Assert a new Mission DeviceRun gets a separate placement/lease; ECP prepare/execute/retry re-resolve observation and stop before adapter execution.

**Step 2: Run test to verify it fails**

Run: `node --test tests/control-plane-mission.test.mjs tests/effect-commit-protocol.test.mjs`

Expected: FAIL because current observation rows lack DiscoveryRun lineage.

**Step 3: Write minimal implementation**

Resolve only the private immutable record; never reuse caller hashes. Enforce five-second capture freshness and 60-second compile window, then persist only hash anchors with the compiled target. At Mission DeviceRun/ECP boundaries recheck active Grant, lineage, evidence/hash, and fresh current observation.

**Step 4: Run test to verify it passes**

Run: `node --test tests/control-plane-mission.test.mjs tests/effect-commit-protocol.test.mjs`

Expected: PASS; failed checks create no new allocation/effect/adapter call.

**Step 5: Commit**

`git commit -m "feat(control-plane): compile discovery observations into missions"`

### Task 5: Add retention, redaction, and gate-matrix regression coverage

**Files:**
- Modify: `control-plane/lib/evidence-store.mjs`
- Modify: `control-plane/lib/state-store.mjs`
- Modify: `control-plane/bootstrap.mjs`
- Modify: `tests/control-plane-server.test.mjs`
- Modify: `tests/discovery-session.test.mjs`
- Create: `docs/agent-entry-discovery-session.md`

**Step 1: Write the failing test**

Cover seven-day restricted raw artifact retention, 90-day redacted lineage retention, public redaction, and flag/ADR/issuer matrix. Each closed gate and missing/malformed issuer path must leave zero DiscoveryRun/session/lease/job/heartbeat/observation/Mission/effect/approval/adapter call. Legacy non-Mission R2 remains manual.

**Step 2: Run test to verify it fails**

Run: `node --test tests/discovery-session.test.mjs tests/control-plane-server.test.mjs`

Expected: FAIL because retention and complete gate accounting are absent.

**Step 3: Write minimal implementation**

Add a bounded retention sweeper that removes only expired restricted raw artifacts while retaining redacted hashes/audit. Keep default flags false; flag-on validates issuer config before startup. Document approved internal boundary, forbidden public endpoints, and the zero-allocation gate check without showing real identities, evidence, or secrets.

**Step 4: Run test to verify it passes**

Run: `node --test tests/discovery-session.test.mjs tests/control-plane-server.test.mjs && npm test && npm run check && git diff --check`

Expected: PASS; no feature is enabled and all public projections remain redacted.

**Step 5: Commit**

`git commit -m "test(control-plane): cover discovery session retention and gates"`

## Deferred explicitly

Do not implement multi-device DiscoverySession scheduling, two-stage draft Mission workflow, default strategy C, or actual delete/profile/settings capability paths in this plan. Any live canary requires ADR acceptance, both flags explicitly enabled in a later task, independent review, and the existing restoration/evidence/zero-cleanup gates.
