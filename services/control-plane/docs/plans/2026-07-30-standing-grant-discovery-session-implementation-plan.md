# Standing Grant DiscoverySession Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a fenced, no-effect pre-Mission DiscoverySession that produces auditable authoritative observations for finite Standing Grant Missions, with Discovery limits carried as **signed Grant DiscoveryPolicy**.

**Architecture:** Reuse existing StateStore, placement, session/lease, job, evidence, Effect Firewall, and ECP components. DiscoveryPolicy is Grant authority (schema + normalizer + canonical hash). A DiscoveryRun is opened by one atomic factory, owns its fenced session/lease/epoch, produces immutable private observations via an exclusive firewall-gated R0 path, seals and releases before Mission compile, and never transfers its tuple. Mission compilation resolves sealed rows into fingerprint targets under named clocks and gets a fresh Mission lease.

**Tech Stack:** Node.js ESM, `node:sqlite` StateStore transactions, existing ControlPlane/DeviceRun/EvidenceStore, Node test runner.

**Status boundary:** ADR 0010 remains Proposed. Both feature flags stay false. This plan does not authorize enablement, deployment, real Grant issuance, or canary.

**Baseline repaired by this plan (current code):**

- Grant exact keys / hash: `control-plane/lib/delegation-grant-policy.mjs:45-76`
- Grant schema required set: `control-plane/schema/delegation-grant.schema.json:5-13`
- Session factory own-txn: `control-plane/lib/state-store.mjs:1130-1236` (must not nest)
- Generic session action without Firewall: `control-plane/lib/control-plane.mjs:1219-1262`
- Firewall snapshot age 5s: `control-plane/lib/effect-firewall.mjs:3,74-90`
- Mission verified-discovery 5min constant: `control-plane/lib/mission-policy.mjs:8` + `mission-runtime.mjs:124-143`
- Authoritative observation rows (pre-lineage): `control-plane/lib/state-store.mjs:356-367,1483-1516`
- Schema user_version: `control-plane/lib/state-store.mjs:382` (`PRAGMA user_version = 7`)
- Router session routes (no discovery lifecycle yet): `control-plane/router.mjs:247-273`

---

### Task 1: Signed DiscoveryPolicy on Standing Grant v1

**Files:**

- Modify: `control-plane/schema/delegation-grant.schema.json`
- Modify: `control-plane/lib/delegation-grant-policy.mjs`
- Modify: `tests/delegation-grant-policy.test.mjs`
- Modify: `tests/delegation-grant-runtime.test.mjs`
- Modify fixtures under `tests/fixtures/` that embed Grant drafts (update every draft used by grant tests)

**Step 1: Write the failing test**

Extend `tests/delegation-grant-policy.test.mjs` and runtime tests so that:

1. A valid Grant draft **requires** `discoveryPolicy` with exact keys:
   `enabled`, `allowedPrimitives`, `defaults`, `maxima`, `maxParallelism`, `targetScope`, `identityPolicy`, `clocks`, `retention`, `accessRoles`.
2. Canonical defaults/maxima match: defaults durationMs=600000, maxPrimitives=80, maxCandidates=10; maxima 1800000/300/50; defaults ≤ maxima; `maxParallelism === 1`.
3. `allowedPrimitives` accepts only the R0/R1 set (screenshot, dump, focus, launch, back, home, tap, swipe, input, restore — navigation/search expressed as existing primitive names already in `PRIMITIVES` plus any additive focus if introduced consistently). Reject social/payment/publish/delete/profile/settings inside DiscoveryPolicy.
4. `clocks.snapshotFreshnessMs === 5000` and `clocks.observationCompileWindowMs === 60000`.
5. `retention.rawScreenshotDays === 7`, `retention.redactedHashAuditDays === 90`.
6. Unknown top-level Grant field or unknown DiscoveryPolicy field ⇒ `GRANT_POLICY_INVALID`.
7. Widening maxima beyond schema maxima, defaults > maxima, or `enabled` non-boolean ⇒ fail closed.
8. `delegationGrantContentHash` / `canonicalGrantIssueSigningBytes` change when DiscoveryPolicy changes; exact-byte replay still idempotent; subset/child Mission path still uses separate effect `budget`.
9. Runtime issue path: old Grant bytes without DiscoveryPolicy cannot issue for Discovery-capable verified_discovery targets once validator requires the field; malformed issuer still writes no rows.

**Step 2: Run test to verify it fails**

Run: `node --test tests/delegation-grant-policy.test.mjs tests/delegation-grant-runtime.test.mjs`

Expected: FAIL because schema/normalizer have no `discoveryPolicy` and fixtures lack the field.

**Step 3: Write minimal implementation**

1. Add `discoveryPolicy` to `delegation-grant.schema.json` required + properties (`additionalProperties: false` everywhere).
2. Extend `validateDelegationGrantDraft` exact key list and add `discoveryPolicy(...)` normalizer that freezes the canonical object; reject unknown keys; keep child effect `budget()` separate.
3. Ensure `delegationGrantContentHash` / signing payload hash the normalized Grant including DiscoveryPolicy.
4. Update all Grant fixtures/drafts used by policy/runtime tests.
5. Do **not** allocate DiscoveryRun/session/lease in this task.

**Step 4: Run test to verify it passes**

Run: `node --test tests/delegation-grant-policy.test.mjs tests/delegation-grant-runtime.test.mjs`

Expected: PASS; signature/hash/replay/rotation behavior preserved; DiscoveryPolicy is part of signed bytes.

**Step 5: Commit**

`git commit -m "feat(control-plane): sign standing grant discovery policy"`

---

### Task 2: Atomic DiscoveryRun lifecycle, fencing, and governed entrypoints

**Files:**

- Modify: `control-plane/lib/state-store.mjs` (v7→v8 additive tables; `openDiscoveryRunStorage`; state machine; seal/abort/release)
- Create: `control-plane/lib/discovery-session.mjs`
- Modify: `control-plane/lib/control-plane.mjs` (governed open/action/seal/abort/status/heartbeat wiring)
- Modify: `control-plane/router.mjs` only if lifecycle commands are exposed; observation writer routes stay 404/403
- Create: `tests/discovery-session-state.test.mjs`
- Create: `tests/discovery-session.test.mjs`
- Modify: `tests/control-plane-placement.test.mjs` if migration fixture shared

**Step 1: Write the failing test**

1. Migration v7→v8 creates `discovery_runs` + discovery events; legacy rows survive.
2. `openDiscoveryRunStorage` in **one** `BEGIN IMMEDIATE` creates `{DiscoveryRun, Session, Lease, controllerEpoch}` together; crash between inserts (simulated by failing after N statements / injected fault) leaves zero live allocation.
3. Pre-checks fail closed with zero rows: missing/inactive Grant, grantHash drift, DiscoveryPolicy.enabled=false, either feature flag false, ADR gate closed, malformed issuer, non-ready/busy device.
4. State machine: `running → sealing → sealed | aborted | recovery_required`. Seal releases session/lease and persists released tuple hashes + `releaseAt`. After seal, validateSession/lease fails; sealed record still readable.
5. Heartbeat only while `running`/`sealing`; stale epoch / wrong controller / revocation mid-run ⇒ abort or recovery_required + restore + release.
6. Governed commands accepted; public observation POST/PATCH/DELETE and generic non-discovery writer paths return 404/403.
7. Reopen StateStore: sealed/aborted durable; cannot resurrect released lease.

**Step 2: Run test to verify it fails**

Run: `node --test tests/discovery-session-state.test.mjs tests/discovery-session.test.mjs tests/control-plane-placement.test.mjs`

Expected: FAIL because DiscoveryRun factory/tables/lifecycle API are absent.

**Step 3: Write minimal implementation**

1. Additive v8 schema: `discovery_runs` (id, grantId, grantHash, sessionId, leaseId, controllerAgent, controllerEpoch, status, deviceId, policyHash anchors, sealed/release timestamps, released tuple hashes JSON), append-only `discovery_events`.
2. Implement `openDiscoveryRunStorage` as a single transaction that inlines placement+lease+session+run inserts (**do not** call `createSession()` nested).
3. Implement seal/abort/status/heartbeat with fencing; on stop paths call existing restore then release.
4. Wire ControlPlane governed methods; keep flags default false.
5. No observation ingest and no Mission compile in this task beyond status surfaces needed for tests.

**Step 4: Run test to verify it passes**

Run: `node --test tests/discovery-session-state.test.mjs tests/discovery-session.test.mjs tests/control-plane-placement.test.mjs`

Expected: PASS; dual-flag/ADR/issuer closed paths allocate nothing; seal leaves durable sealed row without live lease.

**Step 5: Commit**

`git commit -m "feat(control-plane): atomic discovery run lifecycle"`

---

### Task 3: Exclusive R0 producer, Effect Firewall, evidence-bound observations

**Files:**

- Modify: `control-plane/lib/discovery-session.mjs`
- Modify: `control-plane/lib/control-plane.mjs`
- Modify: `control-plane/lib/effect-firewall.mjs`
- Modify: `control-plane/lib/state-store.mjs` (lineage columns / insert-only observation API)
- Modify: `control-plane/lib/evidence-store.mjs` (lookup helpers if needed)
- Modify: `tests/discovery-session.test.mjs`
- Modify: `tests/control-plane-evidence.test.mjs`
- Modify: `tests/mission-explorer-firewall.test.mjs`

**Step 1: Write the failing test**

1. `executeDiscoveryPrimitive` / discovery action path requires live DiscoveryRun `running`, valid token+epoch, primitive ∈ signed DiscoveryPolicy.allowedPrimitives, and Firewall allow on **observed** surface before `createJob`.
2. Generic `executeSessionAction` on a Discovery-owned session with a non-discovery capability is rejected (no bypass onto `control-plane.mjs` generic path).
3. Firewall DiscoverySession profile blocks: follow, like, collect, comment, DM, delete, profile, settings, payment, publish, unknown, risk-control, login, captcha, identity mismatch — not merely “adapter absent”.
4. Fake R0 producer records evidence via EvidenceStore; internal ingest verifies full lineage (grant/hash, discoveryRunId, sessionId, epoch, sourceJobId/sourceRunId, evidence ID+SHA-256 existence, recorder, source/content hashes) then appends immutable observation + event in one txn; returns redacted receipt.
5. Byte-identical duplicate reuses; same key different hash/tuple ⇒ `AUTHORITATIVE_OBSERVATION_CONFLICT`.
6. Conflict/rejection audit: commit audit event in a transaction that **succeeds before** throwing, so reopen still shows the conflict event even though observation insert did not land.
7. Forged client record, stale epoch, wrong evidence hash/session/controller, raw paths/text/tokens, update/delete attempts fail closed.
8. Public projection omits tuple, recorder, evidence path, raw account, identity text.

**Step 2: Run test to verify it fails**

Run: `node --test tests/discovery-session.test.mjs tests/control-plane-evidence.test.mjs tests/mission-explorer-firewall.test.mjs`

Expected: FAIL because exclusive discovery action path, Discovery Firewall profile, and lineage-bound ingest are absent.

**Step 3: Write minimal implementation**

1. Extend Effect Firewall with DiscoverySession profile driven by signed allowlist + observed surface classification; keep `SNAPSHOT_MAX_AGE_MS=5000` for live action snapshots.
2. Implement exclusive discovery action boundary; refuse generic session action for Discovery sessions.
3. Internal-only ingest method (no router/devicectl transport): EvidenceStore index lookup + SHA-256 match; append observation+event; separate committed audit on conflict.
4. Bind every R0 job to discoveryRunId/sessionId/controllerEpoch; observation stores sourceJobId/sourceRunId.
5. No Mission compile yet.

**Step 4: Run test to verify it passes**

Run: `node --test tests/discovery-session.test.mjs tests/control-plane-evidence.test.mjs tests/mission-explorer-firewall.test.mjs`

Expected: PASS; no social/payment/publish/delete/profile/settings adapter path; reopen shows lineage + conflict audits.

**Step 5: Commit**

`git commit -m "feat(control-plane): fence discovery primitives and observations"`

---

### Task 4: Sealed observation → Mission/ECP, named clocks, explicit-target parity

**Files:**

- Modify: `control-plane/lib/mission-policy.mjs` (stop using 5min constant for Discovery-verified path; adopt named clocks)
- Modify: `control-plane/lib/mission-runtime.mjs`
- Modify: `control-plane/lib/effect-commit-protocol.mjs`
- Modify: `control-plane/lib/state-store.mjs` / `discovery-session.mjs` as needed for sealed compile API
- Modify: `tests/control-plane-mission.test.mjs`
- Modify: `tests/effect-commit-protocol.test.mjs`
- Modify: `tests/mission-runtime.test.mjs` (if present coverage needs expansion)
- Modify: `tests/discovery-session.test.mjs` (seal→compile window)

**Step 1: Write the failing test**

Named clocks (injectable `now`):

| Clock | Bound | Persist |
| --- | --- | --- |
| `snapshotFreshnessMs=5000` | `deviceSnapshotAt → sealedAt` | both timestamps on sealed observation/run |
| `observationCompileWindowMs=60000` | `sealedAt → compileNow` | compile reads sealedAt |
| effect re-observation ≤5000 ms | current adapter observation at each ECP prepare/execute/retry | fresh receipt id/hash, not Discovery screenshot |

Tests must prove:

1. Only a **sealed** observation (lease already released) within both clocks compiles a finite child Mission into stable fingerprint target. Active-run-only compile is rejected.
2. Stale/missing sealed row, grant/hash drift, evidence/source/tuple/content hash drift, wrong app/account/page/identity, reopen mismatch ⇒ no Mission allocation.
3. Compiled Mission gets **new** placement/lease/DeviceRun; Discovery tuple not transferred.
4. ECP prepare/execute/retry re-resolve sealed lineage and require fresh effect observation receipt bound to account/page/identity/target; failure stops before adapter execution.
5. Discovery-capable ECP construction requires MissionRuntime; direct `EffectCommitProtocol({ missions: null })` (see `effect-commit-protocol.mjs:19-38`) fails closed for discovery paths (regression).
6. Explicit-target fallback: same Grant/account/budget/ECP/audit binding; identity re-observation rule applied; first canary **collect-only**; not an observation bypass (`mission-runtime.mjs:74-80` membership check alone is insufficient—add parity tests).
7. Must not accidentally accept the old five-minute Mission `SNAPSHOT_MAX_AGE_MS` for Discovery-verified compile.

**Step 2: Run test to verify it fails**

Run: `node --test tests/control-plane-mission.test.mjs tests/effect-commit-protocol.test.mjs tests/discovery-session.test.mjs`

Expected: FAIL because compile still expects live/non-lineage rows and 5min freshness.

**Step 3: Write minimal implementation**

1. Define exported named clock constants for Discovery (do not repurpose mission-policy 5min recovery constant for this path).
2. Compile API resolves private sealed record only; persist hash anchors with compiled target.
3. Mission DeviceRun/ECP boundaries recheck active Grant, sealed lineage, evidence/hash, and fresh current observation receipt.
4. Require MissionRuntime for discovery-capable ECP; add constructor guard/regression.
5. Explicit-target path shares Grant subset/identity/budget/ECP/audit checks; canary collect-only gate.

**Step 4: Run test to verify it passes**

Run: `node --test tests/control-plane-mission.test.mjs tests/effect-commit-protocol.test.mjs tests/discovery-session.test.mjs`

Expected: PASS; failed checks create no new allocation/effect/adapter call; explicit canary collect-only holds.

**Step 5: Commit**

`git commit -m "feat(control-plane): compile sealed discovery observations"`

---

### Task 5: Retention sweeper, redaction/ACL, gate matrix, acceptance docs

**Files:**

- Modify: `control-plane/lib/evidence-store.mjs`
- Modify: `control-plane/lib/state-store.mjs`
- Modify: `control-plane/bootstrap.mjs` (startup/scheduled sweeper registration)
- Modify: `control-plane/lib/discovery-session.mjs` or small `discovery-retention.mjs` if needed
- Modify: `tests/control-plane-server.test.mjs`
- Modify: `tests/discovery-session.test.mjs`
- Create: `docs/agent-entry-discovery-session.md` (internal boundary only; no secrets)

**Step 1: Write the failing test**

Retention/ACL:

1. Sweeper trigger: invoked from bootstrap/startup path and as an explicit callable with injectable clock (no hidden Windows-only config dependency in unit tests).
2. Raw screenshot files older than 7d purged; evidence ID + SHA-256 rows retained; public projection never includes raw path after purge.
3. Redacted hashes/lineage/audit older than 90d purged per policy; newer retained.
4. Failure mid-sweep is retryable and idempotent; partial purge still leaves consistent hash/ID rows; audit receipt recorded per run.
5. ACL: only `user` + independent reviewer roles pass restricted access gate; public/observer projections redact account/identity text, paths, serials, tokens, raw screenshots, full tuples.

Gate matrix (each closed path ⇒ **zero** DiscoveryRun/session/lease/job/heartbeat/observation/Mission/effect/approval/adapter call):

- Mission flag false
- Standing Grant flag false
- ADR 0010 not accepted / gate closed
- malformed / missing issuer allowlist
- DiscoveryPolicy.enabled=false
- revoked Grant / grantHash drift

Also: legacy non-Mission R2 remains manual; multi-device/draft/delete/profile/settings still absent (assert no code path enabled). Flags default false at end of suite.

**Step 2: Run test to verify it fails**

Run: `node --test tests/discovery-session.test.mjs tests/control-plane-server.test.mjs`

Expected: FAIL because sweeper/ACL/complete gate accounting are absent.

**Step 3: Write minimal implementation**

1. Bounded retention sweeper with injectable clock, audit receipts, idempotent raw purge, preserved hash/ID.
2. Local ACL enforcement point for restricted evidence; public redaction helpers.
3. Startup registration in bootstrap without enabling flags.
4. Document approved internal boundary, forbidden public endpoints, zero-allocation gate check in `docs/agent-entry-discovery-session.md` without real identities/evidence/secrets.
5. Keep default flags false; flag-on still requires later ADR acceptance + independent review (out of this plan’s enablement scope).

**Step 4: Run test to verify it passes**

Run: `node --test tests/discovery-session.test.mjs tests/control-plane-server.test.mjs && npm test && npm run check && git diff --check`

Expected: PASS; no feature enabled; public projections redacted; full gate matrix holds.

**Step 5: Commit**

`git commit -m "test(control-plane): cover discovery retention and gates"`

---

## Deferred explicitly

Do not implement in this plan:

- multi-device DiscoverySession scheduling
- two-stage draft Mission workflow
- autonomous “strategy C” as default (explicit targets remain the documented initial collect-only fallback)
- actual delete/profile/settings capability paths
- enabling either feature flag, issuing a real Grant, deployment, or live canary

Any live canary requires ADR 0010 acceptance, both flags explicitly enabled in a **later** reviewed task, independent review, and existing restoration/evidence/zero-cleanup gates.
