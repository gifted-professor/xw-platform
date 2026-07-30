# Standing Grant Phase1: explicit_target-only Convergence

- Status: Accepted (user decision 2026-07-30)
- Date: 2026-07-30
- Supersedes: feed→profile producer design (019fb206) as a Phase1 dependency
- Depends on: ADR 0009 (Proposed), ADR 0010 (Proposed, boundary only)

## User Decision

**Approach A selected**: Standing Grant Phase1 and first live-device canary permit ONLY signed `explicit_target`. Autonomous verified_discovery (feed→profile producer, DiscoveryRun observation lineage, candidate ingestion) is deferred and kept fail-closed with default producer map `{}`.

This decision was informed by:
- Independent review (019fb1f8): Registry identity cannot serve as Discovery target proof
- Independent review (019fb200): Registry serial/alias/accounts.xhs proves controller at best, NEVER feed target
- Producer design (019fb206): feed→profile navigation requires avatar screenshot + composite identity fallback; stable userId unavailable from XHS UI hierarchy

## Phase1 Scope (explicit_target only)

### In scope for Phase1

| Item | Status | Notes |
|------|--------|-------|
| Task 1: Signed DiscoveryPolicy on Grant v1 | Code exists | Schema + normalizer + canonical hash. `discoveryPolicy` required on Grant. |
| Task 2: Atomic DiscoveryRun lifecycle | Code exists | open/seal/abort/status/heartbeat. Fenced session/lease/epoch. |
| Task 4 (partial): explicit_target Mission/ECP | NOT YET IMPLEMENTED | Explicit-target path only. Same signed identity anchor, Grant subset/identity/budget/ECP/audit. First canary collect-only. |
| Task 5 (partial): Retention, ACL, gate matrix | NOT YET IMPLEMENTED | Sweeper, redaction, ACL for explicit_target evidence only. |

### Out of scope for Phase1 (deferred, fail-closed)

| Item | Status | Deferred to |
|------|--------|-------------|
| Task 3: R0 producer (feed→profile, search, seed) | NOT IMPLEMENTED | Post-Phase1, after ADR0010 Accepted + trusted producer exists |
| Task 4 (partial): verified_discovery Mission compile | NOT IMPLEMENTED | Requires sealed observation lineage from Task 3 |
| Task 4 (partial): named clocks for verified_discovery | NOT IMPLEMENTED | Requires ADR0010 Accepted |
| verified_discovery → Mission compile path | NOT IMPLEMENTED | Requires atomic multi-stage binding |
| Autonomous candidate ingestion | NOT IMPLEMENTED | Requires feed→profile producer |
| seed_profile_relation / content_author / search_result anchors | Schema only | No producer to create them |
| Avatar screenshot capability | NOT IMPLEMENTED | fast-operator has no screenshot method |
| Registry-backed controller account proof | NO-GO (019fb200) | Requires separate design |

### Default state (all fail-closed)

- `discoveryProducer` = not installed → `DISCOVERY_PRODUCER_UNAVAILABLE` (503)
- `discoveryCapabilityForPrimitive` = `{}` (empty map)
- `discoverySessions.gates().adr0010Accepted` = false
- `standingGrantEnabled` flag = false
- `missionAutoApprovalEnabled` flag = false
- Grant `discoveryPolicy.enabled` = false (on all issued Grants)
- `verified_discovery` target kind → rejected by `validateMissionPolicy` unless explicit gate override

## Explicit Target Fail-Closed Rules

### Identity and binding

1. **Source of truth**: Only a signed Grant's `identityFingerprint` anchor (type=`identityFingerprint`, relation=`explicit_target`) may produce an explicit target. Client-supplied target strings, hashes, or fingerprints are rejected.
2. **No client override**: `validateMissionPolicy` accepts `scope.targets.kind = "fingerprint"` with `values: [fingerprint1, ...]` only when the fingerprint matches a signed Grant anchor. Client-declared `verified_discovery` target kind is rejected unless both flags + ADR0010 gate are open.
3. **Account binding**: Mission `account` field must match the Grant's authorized account. Identity re-observation at ECP time must confirm the same account.
4. **Controller authorization**: Mission `controllers` list must be a subset of the Grant's authorized controllers.
5. **Revocation**: Grant revocation immediately stops all child Missions. No grace period. No in-flight effect completion.

### Budget and scope

6. **Subset budget**: Child Mission `scope.totalCount`, `scope.perTargetCount`, and `scope.frequency` must be ≤ parent Grant `budget` limits.
7. **Single device**: `parallelism = 1` only. Multi-device is rejected.
8. **Action allowlist**: Only `follow`, `like`, `collect`, `comment` in scope.actions. `payment`, `publish`, `delete`, `profile`, `settings` are rejected at policy validation.

### Feature flags and gates

9. **Dual flags**: Both `standingGrantEnabled` AND `missionAutoApprovalEnabled` must be true before ANY explicit_target Mission allocation. If either flag is false → zero Mission, DeviceRun, effect, approval.
10. **ADR 0009 gate**: `adr0008Accepted` must be true (ADR 0009 depends on ADR 0008 per ADR text).
11. **ADR 0010 gate**: `adr0010Accepted` may remain false for explicit_target Phase1. The explicit_target path does NOT require ADR0010 Accepted because it uses `identityFingerprint → explicit_target` (not verified_discovery lineage). The gate only gates DiscoveryRun open, which Phase1 doesn't use.
12. **No DiscoveryPolicy bypass**: Even for explicit_target, if the Grant carries `discoveryPolicy.enabled = true`, the runtime must NOT accidentally open a DiscoveryRun for the explicit_target path. explicit_target Missions skip DiscoveryRun entirely.

### ECP and effect safety

13. **Canary collect-only**: First explicit_target canary is `collect` only. No `follow`, `like`, or `comment` on the first canary run.
14. **ECP re-observation**: Before each ECP prepare/execute/retry, runtime re-resolves a current adapter observation (≤5s freshness) bound to account/page/identity/target. Failure → stop before adapter execution.
15. **No Discoveryshot**: ECP never uses a Discovery screenshot. Each effect gets its own fresh observation receipt.
16. **Effect Firewall**: Standard Mission Firewall applies (social-effect → ECP/PHC evaluation via mission policy). explicit_target has no special Firewall bypass.

### Cleanup and recovery

17. **Restoration**: Mission abort/revoke → restore device to safe state (back to feed), release lease.
18. **Zero leases on revoke**: Grant revocation → all child Mission leases released, all active DeviceRuns stopped.
19. **Evidence retention**: Standard Mission evidence retention applies (not Discovery 7d/90d policy).

## Live Canary Readiness Checklist

Before the FIRST explicit_target canary runs on a real device:

| # | Gate | Owner | Verification |
|---|------|-------|-------------|
| C1 | Independent code review of entire explicit_target path | Reviewer (not implementer) | Review report with file:line findings |
| C2 | Offline gate matrix: all 19 fail-closed rules verified in tests | Implementer | `node --test tests/control-plane-mission.test.mjs tests/effect-commit-protocol.test.mjs tests/delegation-grant-policy.test.mjs tests/delegation-grant-runtime.test.mjs` all green |
| C3 | Flag-off deploy: code deployed to Windows with both flags false | Implementer | `ssh xhs-windows 'curl.exe -s http://127.0.0.1:17920/control/v1/health'` returns 200; no DiscoveryRun/session/lease allocated |
| C4 | Human signer ceremony: Offline Ed25519 signature for Grant with `discoveryPolicy.enabled = false`, `explicit_target` anchor | user:a1234 | Signed Grant bytes verified against public-key allowlist |
| C5 | Grant installed: `POST /control/v1/grants` with signed bytes → 200, grant status = active | Implementer | `GET /control/v1/grants/:id` returns active |
| C6 | Device ready: canonical ready+free placement on target device | Operator | `GET /api/devices` → target device ready=true, free=true |
| C7 | Zero leases: no active lease on target device before canary | Operator | `SELECT COUNT(*) FROM leases WHERE device_id=? AND released_at IS NULL` = 0 |
| C8 | Mission compiled: explicit_target Mission created with `kind: "fingerprint"`, `values: [<signed-target>]` | Implementer | Mission status = active, single DeviceRun allocated |
| C9 | Firewall check: fresh observation receipt confirms target identity matches signed fingerprint | Runtime | `classify()` returns `auto` for `social-effect` on matched target |
| C10 | Canary execution: single `collect` action on target note | Runtime | Job status = succeeded, evidence written |
| C11 | Canary verification: collect count delta +1, no side effects | Operator | Manual verification on device |
| C12 | Rollback ready: revoke Grant → all leases released, no residual state | Implementer | `SELECT COUNT(*) FROM leases WHERE released_at IS NULL` = 0 |

**Only after C1-C12 all pass**: Consider Phase2 (verified_discovery enablement).

## Task Dependency Rewire

### Original plan (superseded)

```
Task 1 (Grant schema) → Task 2 (DiscoveryRun lifecycle) → Task 3 (R0 producer)
                                                         ↘ Task 4 (Mission/ECP) → Task 5 (Retention/ACL)
```

Task 4 required Task 3 because verified_discovery compile needs sealed observation lineage.

### Phase1 plan (current)

```
Task 1 (Grant schema) → Task 2 (DiscoveryRun lifecycle, explicit_target only)
                      ↘ Task 4p (explicit_target Mission/ECP, no verified_discovery) → Task 5p (Retention/ACL for explicit_target)
Task 3 (R0 producer) → DEFERRED (not a Phase1 dependency)
Task 4f (verified_discovery) → DEFERRED (requires Task 3 + ADR0010 Accepted)
```

### Task 4p: explicit_target Mission/ECP (Phase1 subset)

**Files**:
- Modify: `control-plane/lib/mission-policy.mjs` (ensure explicit_target path works; reject verified_discovery)
- Modify: `control-plane/lib/mission-runtime.mjs` (explicit_target binding, no Discovery lineage)
- Modify: `control-plane/lib/effect-commit-protocol.mjs` (constructor guard: missions=null → fail for discovery paths; explicit_target path OK)
- Modify: `tests/control-plane-mission.test.mjs` (explicit_target tests)
- Modify: `tests/effect-commit-protocol.test.mjs` (explicit_target path)

**Key differences from original Task 4**:
- No named clocks (Discovery clocks not used)
- No sealed observation compile (no DiscoveryRun → no seal → no lineage)
- No verified_discovery target kind support
- No anchor/relation membership validation (explicit_target has no Discovery anchor)
- ECP re-observation still required (≤5s fresh observation receipt)
- Explicit-target canary collect-only gate unchanged

### Task 5p: Retention, ACL, gate matrix (Phase1 subset)

**Files**:
- Modify: `control-plane/lib/evidence-store.mjs` (standard Mission retention, not Discovery 7d/90d)
- Modify: `control-plane/lib/state-store.mjs` (no Discovery retention sweeper needed)
- Modify: `tests/control-plane-server.test.mjs` (explicit_target gate matrix)
- Modify: `tests/discovery-session.test.mjs` (no change: Discovery path stays fail-closed)

**Key differences from original Task 5**:
- No Discovery retention sweeper
- No redacted lineage/audit purge
- Standard Mission evidence retention

### Superseded tasks

| Original reference | What it was | Phase1 disposition |
|--------------------|-------------|--------------------|
| Task 019fb1ed (inferred: "Discovery producer receipt schema") | Producer receipt implementation | **SUPERSEDED**. Not a Phase1 dependency. Deferred until verified_discovery is in scope. |
| Task 019fb1f8 (Registry identity proof) | Can Registry prove target identity? | **COMPLETED** (019fb1f8). Conclusion: NO-GO. |
| Task 019fb200 (Luna review of Registry identity) | Independent verification of NO-GO | **COMPLETED** (019fb200). NO-GO confirmed. |
| Task 019fb206 (feed→profile producer design) | Design of autonomous feed→profile Discovery producer | **COMPLETED** but **DEFERRED** for implementation. Design document exists at `docs/plans/2026-07-30-discovery-feed-to-profile-producer-design.md`. Producer map stays `{}`. |

## ADR boundaries (no status change)

### ADR 0009 (Proposed — no change)

ADR 0009 already acknowledges:
> "Verified-discovery children additionally depend on proposed ADR 0010. Until its pre-Mission DiscoverySession lineage is implemented and independently reviewed, a client-supplied snapshot/evidence hash is never authority and explicit targets remain the only governed fallback."

Phase1 explicit_target-only is the embodiment of this clause. No ADR text change needed.

### ADR 0010 (Proposed — no change)

ADR 0010 defines the verified_discovery architecture. Phase1 implements NONE of it:
- No DiscoveryRun open (gate closed)
- No R0 producer (map = {})
- No sealed observation lineage
- No candidate ingestion
- No Mission compile from Discovery

ADR 0010 remains Proposed. Its acceptance is a prerequisite for Phase2 (verified_discovery), not Phase1 (explicit_target).

### Standing Grant DiscoverySession Design (minor annotation)

Add to the design document a Phase1 scope annotation:
> "Phase1 (2026-07-30): explicit_target only. DiscoveryRun lifecycle (Task 2) is implemented but never opened for explicit_target Missions. R0 producer (Task 3) is deferred. The Discovery firewall, sealed lineage, and Mission compile are not used in Phase1."

### Implementation Plan (superseded by this document)

The original implementation plan (`2026-07-30-standing-grant-discovery-session-implementation-plan.md`) remains as the long-term reference. This document (`2026-07-30-standing-grant-phase1-explicit-target-only.md`) is the authoritative Phase1 scope. Where they conflict, this document wins.

## Acceptance Checklist for Phase1

Before Phase1 is considered complete:

| # | Criterion | Verification |
|---|-----------|-------------|
| A1 | Grant issue: signed Grant with explicit_target identityFingerprint, discoveryPolicy.enabled=false | `POST /control/v1/grants` → 200, status=active |
| A2 | Grant reject: Grant without explicit_target anchor, or with verification_discovery target kind → rejected | 400 MISSION_POLICY_INVALID |
| A3 | Grant reject: client-supplied target fingerprint → rejected | 400 MISSION_POLICY_INVALID |
| A4 | Mission create: explicit_target Mission with fingerprint from Grant → success | 200, Mission active |
| A5 | Mission reject: verified_discovery target kind → rejected (flags off) | 400 MISSION_POLICY_INVALID |
| A6 | Mission reject: fingerprint not in Grant anchors → rejected | 400 MISSION_POLICY_INVALID |
| A7 | Mission reject: payment/publish/delete/profile/settings in scope.actions → rejected | 400 ACTION_NOT_AUTHORIZABLE |
| A8 | Mission reject: parallelism > 1 → rejected | 400 PARALLELISM_UNSUPPORTED |
| A9 | Mission reject: either flag false → zero allocation | No Mission/DeviceRun/session created |
| A10 | ECP: fresh observation receipt before each effect → enforced | ≤5s freshness check |
| A11 | ECP: identity re-observation mismatch → stop before adapter | DISCOVERY_SURFACE_BLOCKED or TARGET_MISMATCH |
| A12 | Revoke: Grant revocation → all child Missions stopped, leases released | Zero active leases |
| A13 | Default: both flags false → zero DiscoveryRun/session/lease/job/heartbeat/observation/Mission/effect/approval/adapter call | Gate matrix tests pass |
| A14 | Producer map: discoveryProducer not installed → DISCOVERY_PRODUCER_UNAVAILABLE (503) | Test verifies |
| A15 | Canary: first explicit_target canary is collect-only → enforced | Test verifies |
| A16 | Dirty red test preserved: tests/control-plane-adapters.test.mjs unchanged | `git diff --check` clean except for committed docs |

## TDD: Phase1 Red-Green Tests

### New test file: tests/standing-grant-explicit-target-phase1.test.mjs

| # | Test | Phase1 requirement |
|---|------|--------------------|
| T1 | Grant without explicit_target identityFingerprint → rejected for Mission | A2 |
| T2 | Grant with verified_discovery target kind → rejected (flags off) | A5 |
| T3 | Client-supplied target fingerprint not in Grant → rejected | A3, A6 |
| T4 | Valid explicit_target Grant → Mission created, DeviceRun allocated | A4 |
| T5 | payment in scope.actions → rejected | A7 |
| T6 | publish/delete/profile/settings in scope.actions → rejected | A7 |
| T7 | parallelism=2 → rejected | A8 |
| T8 | standingGrantEnabled=false → zero Mission allocation | A9 |
| T9 | missionAutoApprovalEnabled=false → zero Mission allocation | A9 |
| T10 | ECP requires fresh observation receipt (≤5s) | A10 |
| T11 | ECP identity mismatch → block before adapter | A11 |
| T12 | Grant revoke → child Missions stopped, leases released | A12 |
| T13 | discoveryProducer not installed → DISCOVERY_PRODUCER_UNAVAILABLE | A14 |
| T14 | First canary collect-only enforced | A15 |
| T15 | Full gate matrix: 9 closed paths → zero allocation | A13 |

### Red command (after implementation)

```bash
node --test tests/standing-grant-explicit-target-phase1.test.mjs
```

Expected: FAIL (file absent or tests unimplemented)

### Green command

```bash
node --test tests/standing-grant-explicit-target-phase1.test.mjs tests/control-plane-mission.test.mjs tests/effect-commit-protocol.test.mjs tests/delegation-grant-policy.test.mjs tests/delegation-grant-runtime.test.mjs tests/discovery-session.test.mjs tests/discovery-session-state.test.mjs
```

Expected: all PASS; Discovery path stays fail-closed.

### Commit points

1. `docs(standing-grant): converge Phase1 to explicit_target-only scope`
2. `feat(control-plane): enforce explicit_target fail-closed rules`
3. `test(control-plane): cover explicit_target Phase1 gate matrix`
4. `fix(control-plane): ensure verified_discovery path defaults fail-closed`

## Phase2 Gating (verified_discovery enablement)

Phase2 requires ALL of:
1. ADR 0010 Accepted (status changed from Proposed to Accepted)
2. Trusted R0 producer (feed→profile or equivalent) implemented and independently reviewed
3. Avatar screenshot capability in fast-operator
4. Producer map updated from `{}` to include wired producer
5. Atomic multi-stage binding (feed→profile navigation within one DiscoveryRun) proven in tests
6. All 15 producer TDD tests green (from 019fb206 design)
7. Independent review of the full verified_discovery path
8. Offline gate matrix for verified_discovery path
9. Human signer ceremony for Grant with discoveryPolicy.enabled=true
10. Separate canary checklist (not the Phase1 explicit_target checklist)

Until ALL Phase2 gates pass, the system stays in Phase1 explicit_target-only mode with default producer map `{}`.

---

Design by independent reviewer (slot 019fb1f5), 2026-07-30. Docs-only. No runtime/test/config modified. ADR statuses unchanged.
