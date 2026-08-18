# Explicit-Target Phase1 Implementation Batches

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

- Status: Accepted (user decision 2026-07-30)
- Date: 2026-07-30
- Baseline: worktree @ 06e697b
- Absorbs: review task P0/P1/P2 (019fb220)
- Replaces: `2026-07-30-standing-grant-phase1-explicit-target-only.md` as the executable plan (that document remains as decision record)
- Constraint: 4 code tasks + 1 acceptance task; no Discovery producer

## P0/P1/P2 Absorption Summary

Each finding from review 019fb220 is mapped to a specific batch below:

| Finding | Severity | Absorbed into | Summary |
|---------|----------|---------------|---------|
| A | P0 | Batch 1 | `Grant.targets.values` is the ONLY explicit-target authority. DiscoveryPolicy targetScope does NOT authorize. Test parentGrantId/hash/app/account/controllers/targets subset/budget/parallelism. |
| B | P0 | Batch 2 | Parent Grant live fencing: ECP re-reads active/hash/revocation before each adapter call. Revoke → cancel if notSent; ambiguous if possiblySent. |
| C | P0 | Batch 2 | Adapter-authored ≤5s observation receipt. Server timestamp/hash, app/account/page/target exact match. Client-supplied fresh/target DISABLED. |
| D | P0 | Batch 3 | New XHS collect-only capability, constrained by Grant subset/prohibitedActions. Explicit risk tier/ECP, execute/verify/restore/evidence/restart. Do NOT reuse generic feed/metrics. |
| E | P0 | Batch 1, 4 | Gates: MISSION_AUTO_APPROVAL + STANDING_GRANT + ADR0008 + ADR0009 (Proposed). Flag-off → Mission/audit persistable, ZERO DeviceRun/session/lease/effect/job/adapter. ADR0010/map={} = Discovery unreachable. |
| F | P1 | Batch 4 | Dirty red test disposition: save diff/report, apply minimal reverse patch for clean CI. CI MUST include adapters suite, assert no discoveryReceipt on feed/metrics. |
| G | P1 | Batch 3 | Payment → PHC only. Publish/delete blocked by Grant prohibitedActions/subset. Profile/settings out-of-scope. |
| H | P2 | Batch 5 | One-time collect canary: server marker, evidence ACL/retention, ambiguous/restoration handling, final lease=0 verification. |

---

## Batch 1: Canonical Explicit-Target Grant Authority

**Goal**: Signed Grant `targets.values` is the single source of truth for explicit-target authorization. DiscoveryPolicy plays NO role. Grant→Mission→DeviceRun chain is strictly validated for subset compliance.

### Files

| Action | File | Notes |
|--------|------|-------|
| Modify | `control-plane/schema/delegation-grant.schema.json` | Ensure `targets.values` required for explicit_target Grants; DiscoveryPolicy NOT required when `discoveryPolicy.enabled=false` |
| Modify | `control-plane/lib/delegation-grant-policy.mjs` | Validate explicit_target fingerprints in Grant; reject verified_discovery targets |
| Modify | `control-plane/lib/mission-policy.mjs` | Enforce: (a) parentGrantId/hash present, (b) app/account/controllers match Grant, (c) targets subset of Grant.targets.values, (d) budget ≤ parent Grant budget, (e) parallelism=1 |
| Modify | `control-plane/lib/mission-runtime.mjs` | Mission open validates parent Grant existence + active status + hash match |
| Modify | `tests/delegation-grant-policy.test.mjs` | Add explicit_target Grant fixture tests |
| Modify | `tests/delegation-grant-runtime.test.mjs` | Add Grant issue with explicit_target + Mission compilation tests |
| Modify | `tests/control-plane-mission.test.mjs` | Add parent Grant subset enforcement tests |
| Modify | `tests/fixtures/` | Add/update Grant fixtures with explicit_target targets.values |

### Gate definitions (precise)

```js
// Phase1 gates. ADR0009 is independently Proposed and gated separately from ADR0010.
const PHASE1_GATES = {
  missionAutoApprovalEnabled: false,  // MISSION_AUTO_APPROVAL flag
  standingGrantEnabled: false,        // STANDING_GRANT flag
  adr0008Accepted: true,              // ADR0008 dependency (already Accepted, per ADR0009 text)
  adr0009Accepted: false,             // ADR0009 Proposed; stays false until user accepts
};
// ADR0010 gate is NOT in Phase1 gates. It only controls DiscoveryRun open (map={}).
```

### TDD: Red command

```bash
node --test tests/delegation-grant-policy.test.mjs tests/delegation-grant-runtime.test.mjs tests/control-plane-mission.test.mjs
```

**Expected**: FAIL — Grant fixtures lack explicit_target targets.values; Mission open doesn't validate parent Grant subset; DiscoveryPolicy incorrectly required for non-Discovery Grants.

### TDD: Green command

Same command. **Expected**: PASS.

Tests must prove:

| # | Test | Expected |
|---|------|----------|
| 1.1 | Grant with `targets.values: ["<fingerprint>"]` → valid | 200, Grant active |
| 1.2 | Grant without `targets.values` for explicit_target → rejected | GRANT_POLICY_INVALID |
| 1.3 | Grant with `discoveryPolicy.enabled=false` → valid (DiscoveryPolicy NOT required) | 200, `discoveryPolicy.enabled=false` |
| 1.4 | Mission `parentGrantId` missing → rejected | MISSION_POLICY_INVALID |
| 1.5 | Mission `parentGrantHash` mismatch → rejected | GRANT_HASH_MISMATCH |
| 1.6 | Mission `app` ≠ Grant `app` → rejected | MISSION_POLICY_INVALID |
| 1.7 | Mission `account` not in Grant authorized accounts → rejected | MISSION_POLICY_INVALID |
| 1.8 | Mission `controllers` not subset of Grant controllers → rejected | MISSION_POLICY_INVALID |
| 1.9 | Mission `targets.values` not subset of Grant `targets.values` → rejected | MISSION_POLICY_INVALID |
| 1.10 | Mission `scope.totalCount` > Grant `budget.total` → rejected | MISSION_POLICY_INVALID |
| 1.11 | Mission `scope.perTargetCount` > Grant `budget.perTarget` → rejected | MISSION_POLICY_INVALID |
| 1.12 | Mission `parallelism` = 2 → rejected | PARALLELISM_UNSUPPORTED |
| 1.13 | `verified_discovery` target kind rejected (flags off) | MISSION_POLICY_INVALID |
| 1.14 | `discoveryPolicy.enabled=true` Grant → DiscoveryRun open fails (ADR0010 gate closed) | DISCOVERY_RUN_DENIED |

### Commit point

```
feat(control-plane): enforce canonical explicit-target Grant authority
```

---

## Batch 2: Parent Grant Live Fencing + Adapter-Authored Observation Receipt

**Goal**: Every adapter call in the explicit-target path is fenced by a live Grant re-read. Observation receipts come from the adapter (server-authored), never from client input. Stale/mismatched receipts fail closed.

### Files

| Action | File | Notes |
|--------|------|-------|
| Modify | `control-plane/lib/effect-commit-protocol.mjs` | ECP prepare/execute/retry: re-read Grant active/hash/revocation before each adapter call |
| Modify | `control-plane/lib/mission-runtime.mjs` | Explicit-target binding + fresh observation receipt flow |
| Modify | `control-plane/lib/control-plane.mjs` | Wire receipt validation: server timestamp, app/account/page/target hash match |
| Modify | `tests/effect-commit-protocol.test.mjs` | Live fencing tests |
| Modify | `tests/control-plane-mission.test.mjs` | Receipt validation tests |

### Grant live fencing rules (precise)

```
prepare/execute/retry:
  1. BEGIN IMMEDIATE transaction
  2. SELECT grant_hash, status FROM delegation_grants WHERE grant_id = :parentGrantId
  3. IF grant_hash != mission.parentGrantHash → GRANT_HASH_DRIFT (terminal abort, release lease)
  4. IF status = 'revoked' → GRANT_REVOKED
     - IF effect_not_sent (notSent=true from adapter) → cancel + own lease release
     - IF effect_possibly_sent (ambiguous) → ambiguous + restore UI + record audit
  5. IF status != 'active' → GRANT_NOT_ACTIVE (terminal abort, release lease)
  6. IF now < grant.validity.notBefore OR now > grant.validity.expiresAt → GRANT_OUTSIDE_VALIDITY
  7. All checks pass → proceed with adapter call
  8. COMMIT
```

### Observation receipt schema (adapter-authored)

```json
{
  "receiptKind": "explicit-target.observation",
  "receiptId": "<receipt_id>",
  "serverTimestamp": "<ISO8601>",
  "serverTimestampHash": "<sha256>",
  "app": "xhs",
  "accountFingerprint": "<sha256>",
  "pageFingerprint": "<sha256>",
  "observedTargetFingerprint": "<sha256>",
  "observedAt": "<ISO8601>",
  "snapshotAgeMs": 1234,
  "adapterVersion": "xhs-adapter-v1"
}
```

**Client-supplied fields DISABLED**: The receipt is produced server-side by the adapter during ECP prepare. The client (agent/runtime) may only pass through the opaque receipt ID — NEVER the receipt content, target fingerprint, or freshness claim.

### TDD: Red command

```bash
node --test tests/effect-commit-protocol.test.mjs tests/control-plane-mission.test.mjs
```

**Expected**: FAIL — ECP doesn't re-read Grant before adapter call; observation receipt not validated.

### TDD: Green command

Same command. **Expected**: PASS.

Tests must prove:

| # | Test | Expected |
|---|------|----------|
| 2.1 | Grant active at prepare → ECP proceeds | adapter called |
| 2.2 | Grant revoked before prepare (notSent) → cancel + lease released | zero adapter call, lease=null |
| 2.3 | Grant revoked before prepare (ambiguous) → restore + audit | zero adapter call, ambiguous audit event |
| 2.4 | Grant hash changed between prepare and retry → GRANT_HASH_DRIFT | terminal abort |
| 2.5 | Grant validity expired → GRANT_OUTSIDE_VALIDITY | terminal abort |
| 2.6 | Receipt `app` ≠ Mission `app` → AUTHORITATIVE_OBSERVATION_MISMATCH | blocked |
| 2.7 | Receipt `accountFingerprint` ≠ Mission `account` → mismatch | blocked |
| 2.8 | Receipt `observedTargetFingerprint` ≠ Mission target → mismatch | blocked |
| 2.9 | Receipt `snapshotAgeMs` > 5000 → SNAPSHOT_STALE | blocked |
| 2.10 | Client-supplied receipt fields → rejected (receipt must be adapter-authored) | DISCOVERY_RECEIPT_INVALID |
| 2.11 | Receipt missing `serverTimestamp` or `serverTimestampHash` → rejected | DISCOVERY_RECEIPT_INVALID |

### Commit point

```
feat(control-plane): add parent Grant live fencing and adapter-authored receipts
```

---

## Batch 3: XHS Collect-Only Capability (Grant-Constrained)

**Goal**: A new `xhs.collect.standing_grant` capability that inherits risk/ECP from the Grant, constrained by Grant `prohibitedActions` and `scope.actions` subset. Does NOT reuse generic `xhs.observe.feed` or `xhs.observe.metrics`.

### Files

| Action | File | Notes |
|--------|------|-------|
| Create | `apps/xhs/capabilities.json` → add capability entry | New `xhs.collect.standing_grant` |
| Modify | `apps/xhs/adapter.mjs` | Wire collect execution path (tap+verify+restore) |
| Modify | `control-plane/lib/policy.mjs` | Grant-constrained capability evaluation |
| Create | `tests/xhs-collect-standing-grant.test.mjs` | New test file |
| Modify | `tests/control-plane-adapters.test.mjs` | Add collect capability tests (NOT modifying dirty red test lines) |

### Capability definition

```json
{
  "schemaVersion": 1,
  "id": "xhs.collect.standing_grant",
  "appId": "xhs",
  "packageName": "com.xingin.xhs",
  "versionRange": "observed",
  "maturity": "E2",
  "risk": "R2",
  "resources": ["device", "transport:xiaowei:22222"],
  "inputSchema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "collected": { "type": "boolean" },
      "countDelta": { "type": "integer" }
    }
  },
  "preconditions": [
    "a note is open with a collect button visible",
    "explicit Grant authorization exists for this target"
  ],
  "verification": {
    "mode": "state",
    "description": "collect count delta +1 or button state changed"
  },
  "restoration": {
    "required": true,
    "description": "uncollect if collected, return to feed"
  },
  "timeoutMs": 90000,
  "idempotency": "ambiguous_on_timeout",
  "automationPolicy": {
    "mode": "ecp",
    "transactionSafe": false
  },
  "implementation": {
    "adapter": "xhs",
    "action": "collectOnOpenNote"
  },
  "evidence": [
    "docs/plans/2026-07-30-explicit-target-phase1-implementation-batches.md"
  ],
  "availability": "implemented",
  "standingGrantConstraints": {
    "prohibitedActions": ["payment", "publish", "delete", "profile", "settings"],
    "requiresExplicitTarget": true,
    "firstCanaryCollectOnly": true
  }
}
```

### Grant actions/payment/scope rules

| Action | Phase1 status | Rule |
|--------|--------------|------|
| `collect` | Allowed | First canary collect-only. Subsequent: per Grant scope.actions. |
| `like` | Allowed (ECP-gated) | Must be in Grant scope.actions. |
| `follow` | Allowed (ECP-gated) | Must be in Grant scope.actions. |
| `comment` | Allowed (ECP-gated) | Must be in Grant scope.actions. |
| `payment` | BLOCKED | PHC only; never in Grant scope.actions. |
| `publish` | BLOCKED | Blocked by Grant prohibitedActions. |
| `delete` | BLOCKED | Blocked by Grant prohibitedActions. |
| `profile` | OUT OF SCOPE | Not implemented. |
| `settings` | OUT OF SCOPE | Not implemented. |

### TDD: Red command

```bash
node --test tests/xhs-collect-standing-grant.test.mjs
```

**Expected**: FAIL — capability not defined, adapter has no collect action.

### TDD: Green command

```bash
node --test tests/xhs-collect-standing-grant.test.mjs tests/control-plane-adapters.test.mjs
```

**Expected**: PASS.

Tests must prove:

| # | Test | Expected |
|---|------|----------|
| 3.1 | `xhs.collect.standing_grant` capability loads from registry | capability found, risk=R2 |
| 3.2 | Adapter `collectOnOpenNote` → taps collect button, verifies count delta | output.collected=true, countDelta=1 |
| 3.3 | Adapter `collectOnOpenNote` on non-note surface → ADAPTER_ACTION_REJECTED | notOnNote |
| 3.4 | `evaluateCapabilityPolicy` with Grant → ECP decision | decision=ecp, approvalRequired=false |
| 3.5 | Grant `scope.actions` excludes "collect" → rejected | SCOPE_VIOLATION |
| 3.6 | Grant `prohibitedActions` includes "collect" → rejected | ACTION_PROHIBITED |
| 3.7 | `payment` in scope.actions → rejected | ACTION_NOT_AUTHORIZABLE |
| 3.8 | `publish` in scope.actions → rejected | ACTION_NOT_AUTHORIZABLE |
| 3.9 | `delete` in scope.actions → rejected | ACTION_NOT_AUTHORIZABLE |
| 3.10 | Restoration: collect → uncollect → back to feed | restored=true, finalActivity=IndexActivityV2 |
| 3.11 | Generic R0 capability (feedCards) does NOT produce discoveryReceipt | execution.output.discoveryReceipt === undefined |
| 3.12 | Evidence written for collect execution | evidence record exists with kind=capability_evidence |

### Commit point

```
feat(xhs): add Grant-constrained collect-only capability
```

---

## Batch 4: Dirty Red Test Disposition + Full Gate Matrix

**Goal**: Document the dirty red test, save its diff for future Task 3 patch, apply minimal reverse patch to restore clean CI. Build the complete Phase1 gate matrix proving zero allocation when any gate is closed.

### Files

| Action | File | Notes |
|--------|------|-------|
| Read | `tests/control-plane-adapters.test.mjs` | Record exact diff (lines 56-72) |
| Create | `docs/plans/2026-07-30-dirty-red-test-disposition.md` | Saved diff + deferred Task 3 patch plan |
| Create | `tests/control-plane-adapters.test.mjs.reverse.patch` | Reverse patch for clean CI |
| Apply | `tests/control-plane-adapters.test.mjs` | Apply reverse patch (remove discoveryReceipt assertion) |
| Modify | `tests/discovery-session.test.mjs` | Add gate matrix tests: all closed paths → zero allocation |
| Modify | `tests/control-plane-server.test.mjs` | Add gate matrix server-level tests |

### Dirty red test disposition (precise)

The test at `tests/control-plane-adapters.test.mjs:56-72` asserts that R0 XHS capabilities (`xhs.observe.feed`, `xhs.observe.metrics`) produce a `discoveryReceipt` on their output. This is the Task 3 (R0 producer) patch — currently failing because the producer is not implemented.

**Phase1 action**:
1. Save the exact diff to `docs/plans/2026-07-30-dirty-red-test-disposition.md` with the original test text.
2. Create a minimal reverse patch that replaces the discoveryReceipt assertion with a negative assertion (feedCards → no discoveryReceipt).
3. Document that the original test will be restored when Task 3 (R0 producer) is implemented in Phase2.

**CI requirement after Batch 4**:
```bash
# Adapters suite MUST pass with assertion that feed/metrics have NO discoveryReceipt
node --test tests/control-plane-adapters.test.mjs
# Expected: PASS. feedCards output.discoveryReceipt === undefined
```

### Gate matrix (precise)

All gates default false. Each closed gate → ZERO Mission/DeviceRun/session/lease/effect/job/adapter:

| Gate | Default | Phase1 behavior when false |
|------|---------|---------------------------|
| `missionAutoApprovalEnabled` | false | Zero Mission compilation → MISSION_DISABLED |
| `standingGrantEnabled` | false | Zero Standing Grant Mission → STANDING_GRANT_DISABLED |
| `adr0008Accepted` | true (already) | ADR0008 is a dependency; must be true for any Mission |
| `adr0009Accepted` | false | Zero Standing Grant allocation → ADR0009_NOT_ACCEPTED |
| `adr0010Accepted` | false | Only gates DiscoveryRun open; explicit_target path works without it |
| `discoveryProducer` | not installed | DISCOVERY_PRODUCER_UNAVAILABLE (503) |
| `producerMap` | {} | No primitive mapped to a producer |

Flag-off behavior: Mission/audit rows ARE persisted (for audit trail). DeviceRun/session/lease/effect/job/adapter calls are ZERO.

### TDD: Red command

```bash
node --test tests/discovery-session.test.mjs tests/control-plane-server.test.mjs tests/control-plane-adapters.test.mjs
```

**Expected**: FAIL — dirty red test fails; no gate matrix tests; clean adapters suite not yet applied.

### TDD: Green command

```bash
node --test tests/discovery-session.test.mjs tests/control-plane-server.test.mjs tests/control-plane-adapters.test.mjs
```

**Expected**: PASS.

Tests must prove:

| # | Test | Expected |
|---|------|----------|
| 4.1 | `missionAutoApprovalEnabled=false` → zero Mission compilation | MISSION_DISABLED |
| 4.2 | `standingGrantEnabled=false` → zero Standing Grant allocation | STANDING_GRANT_DISABLED |
| 4.3 | `adr0009Accepted=false` → zero allocation | ADR0009_NOT_ACCEPTED |
| 4.4 | `adr0010Accepted=false` → DiscoveryRun open fails | DISCOVERY_RUN_DENIED |
| 4.5 | `adr0010Accepted=false` + explicit_target → Mission still works | Mission created, DeviceRun allocated |
| 4.6 | All gates false → Mission row persistable, zero DeviceRun | Mission.status='active', zero DeviceRun |
| 4.7 | `discoveryProducer` not installed → DISCOVERY_PRODUCER_UNAVAILABLE | 503 |
| 4.8 | `producerMap = {}` → DISCOVERY_PRIMITIVE_UNAVAILABLE for any primitive | 503 |
| 4.9 | feedCards → output.discoveryReceipt === undefined | assert passes |
| 4.10 | metrics → output.discoveryReceipt === undefined | assert passes |
| 4.11 | Dirty red test diff saved to docs | file exists, SHA matches original lines |
| 4.12 | Reverse patch applies cleanly | `git apply` succeeds |

### Commit point

```
fix(tests): dispose dirty red test and complete gate matrix for Phase1
```

---

## Batch 5: Acceptance — One-Time Collect Canary + Phase1 Verification

**Goal**: Define and verify (offline) the one-time collect canary acceptance criteria. No code changes beyond any marker/config needed for canary identification.

### Files

| Action | File | Notes |
|--------|------|-------|
| Create | `docs/plans/2026-07-30-phase1-acceptance-checklist.md` | Full checklist |
| Create or Modify | `control-plane/lib/state-store.mjs` | Add `canary_marker` or server-level flag for first-collect-only |
| Modify | `tests/control-plane-server.test.mjs` | Canary marker behavior |

### One-time collect canary rules

1. **Server marker**: A durable server-side marker (`firstCollectCanaryCompleted: false`) prevents any second collect until explicitly cleared.
2. **Evidence ACL**: Collect canary evidence is access-controlled (owner subject hash + trusted reviewer, never request role).
3. **Evidence retention**: Canary evidence persists for 90 days minimum; no automatic purge.
4. **Ambiguous handling**: If the collect result is ambiguous (timeout, crash), do NOT retry. Record ambiguous audit event + restore + release lease. Human reviews before any retry.
5. **Restoration**: After collect (success or ambiguous), restore device to feed. Verify `currentFocus` = IndexActivityV2.
6. **Final lease=0**: After canary completes (success/ambiguous/aborted), verify zero active leases on the canary device.

### Acceptance checklist

| # | Criterion | Verification |
|---|-----------|-------------|
| A1 | Signed Grant with explicit_target fingerprint → active | `POST /control/v1/grants` → 200 |
| A2 | Mission compiled from Grant → active, DeviceRun allocated | Mission.status='active' |
| A3 | Single collect executed → succeeded | Job.status='succeeded', evidence written |
| A4 | Collect count delta verified | +1 on target note |
| A5 | No side effects (no follow, no like, no comment leaked) | Manual audit of job log |
| A6 | Device restored to feed after canary | currentFocus = IndexActivityV2 |
| A7 | Zero active leases after canary | `SELECT COUNT(*)=0 FROM leases WHERE released_at IS NULL AND device_id=?` |
| A8 | Ambiguous collect → not retried, human reviews | Ambiguous audit event recorded |
| A9 | Grant revoked → all leases released | `SELECT COUNT(*)=0 FROM leases WHERE released_at IS NULL` |
| A10 | Revoked Grant → cannot create new Mission | GRANT_REVOKED |
| A11 | All 12 Batch 1-4 test groups green | `npm test` passes |
| A12 | CI includes adapters suite with no discoveryReceipt assertion | CI green |

### TDD: Red command

```bash
node --test tests/control-plane-server.test.mjs
```

**Expected**: FAIL — canary marker not implemented.

### TDD: Green command

```bash
node --test tests/control-plane-server.test.mjs tests/control-plane-mission.test.mjs tests/effect-commit-protocol.test.mjs tests/delegation-grant-policy.test.mjs tests/delegation-grant-runtime.test.mjs tests/xhs-collect-standing-grant.test.mjs tests/control-plane-adapters.test.mjs tests/discovery-session.test.mjs tests/discovery-session-state.test.mjs
```

**Expected**: ALL PASS.

Tests must prove:

| # | Test | Expected |
|---|------|----------|
| 5.1 | First collect succeeds with canary marker false | collect succeeds |
| 5.2 | Second collect blocked by canary marker | CANARY_ALREADY_COMPLETED |
| 5.3 | Canary marker cleared → second collect allowed | collect succeeds |
| 5.4 | Ambiguous collect → audit event, no retry | ambiguous event, lease released |
| 5.5 | Evidence ACL: unauthorized viewer → denied | 403 |
| 5.6 | Evidence ACL: authorized reviewer → allowed | 200 |
| 5.7 | Post-canary lease count = 0 | zero active leases |
| 5.8 | Post-canary device focus = IndexActivityV2 | restored to feed |
| 5.9 | Full test suite passes (`npm test`) | all green |

### Commit point

```
feat(control-plane): add one-time collect canary marker and acceptance checks
```

---

## Full CI Command (after all 5 batches)

```bash
npm test && npm run check && git diff --check
```

**Expected**: ALL PASS; zero uncommitted changes (except intentional dirty red test reverse patch).

## Batch Dependency Graph

```
Batch 1 (Grant authority)
  ├── Batch 2 (Live fencing + receipts)
  │     └── Batch 3 (Collect capability)
  │           └── Batch 5 (Acceptance)
  └── Batch 4 (Dirty test + gate matrix) ── independent, can run parallel with 2+3
```

Batch 4 can execute in parallel with Batch 2+3 (different files, different concerns). Batch 5 depends on Batch 3 (needs the collect capability) and Batch 4 (needs clean CI).

## What is NOT in Phase1

| Item | Reason |
|------|--------|
| DiscoveryRun open (for explicit_target) | ADR0010 not Accepted; explicit_target skips DiscoveryRun |
| R0 producer (feed→profile, search, seed) | Task 3 deferred to Phase2 |
| Discovery observation lineage | Requires R0 producer |
| verified_discovery Mission compile | Requires sealed lineage |
| Candidate ingestion | Requires producer |
| Avatar screenshot | No producer to call it |
| Multi-device discovery | Out of scope |
| Profile/settings capability paths | Out of scope |
| Payment/publish/delete implementation | Blocked by prohibitedActions; payment PHC only |

## ADR Boundaries

- **ADR 0009** (Proposed): No change. Phase1 implements the "explicit targets remain the only governed fallback" clause.
- **ADR 0010** (Proposed): No change. Phase1 does not use anything from ADR 0010. Gate `adr0010Accepted` remains false and only controls DiscoveryRun open.
- **ADR 0008**: Already Accepted. Phase1 depends on it for Mission auto-approval.

---

Design by independent reviewer (slot 019fb1f5), 2026-07-30. Docs-only. No runtime/test/config modified.
