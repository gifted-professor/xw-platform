# Standing Grant Phased Enablement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a durable, cryptographically human-issued Standing Grant that can compile bounded, immutable single-device Missions without weakening Mission/ECP/PHC safety or enabling the feature before independent approval.

**Architecture:** A grant is a durable parent authorization, not an actor string or a lease. A human-controlled offline signer creates the Ed25519 proof for `user:a1234`; Windows receives only a versioned public-key allowlist and verifies the proof, canonical grant hash, issuance nonce, and audit trail before accepting a strict-subset child Mission. Both the existing `MISSION_AUTO_APPROVAL_ENABLED` gate and a new `STANDING_GRANT_ENABLED` gate must be open before a grant-backed Mission can allocate a DeviceRun, session, lease, heartbeat, or effect.

**Tech Stack:** Node.js 24 ESM, `node:sqlite`, `node:crypto` Ed25519 verification, JSON Schema, existing ControlPlane/StateStore/MissionRuntime/ECP/PHC, `node:test`, Windows scheduled-task deployment.

---

## Scope and non-negotiable invariants

- Trusted human issuer: only a valid Ed25519 signature for configured subject `user:a1234` can issue or revoke a grant. A request `actor`, controller, SSH identity, UI text, or ADR/doc is never issuer proof. There is no key-generation, signing, recovery, or key-export endpoint: the user private key never enters the repository, control plane, environment, database, log, API, proof output, or test fixture representing a real issuer.
- Trust ceremony: the human creates/keeps the signing private key offline; a Windows administrator installs only the corresponding public key in a versioned allowlist with `keyId`, status, activation time, and revoked-key history. Rotation installs a new allowlist version before accepting its key; compromise/loss first disables both flags, marks the old key revoked in the allowlist, restarts fail-closed, and reconciles every grant issued by that key to revoked before adapters may run. This out-of-band recovery path is audited; it is not an HTTP/CLI operation.
- Temporal identity: a normal Standing Grant uses `expiresAt: null` and ends only by durable revocation. Finite grants are supported only as a narrower form; every child Mission has a finite expiry and may not outlive a finite parent. A revoked `(grantId, grantHash)` can never become active again: a later authorization requires a new `grantId` and signed issuance nonce.
- Grant scope: exploration/navigation/input/restoration plus `follow`, `like`, `collect`, `comment`, and `dm`; `payment` and `publish` are prohibited. `delete`, `profile`, and `settings` are never inherited implicitly: a child Mission must name each one explicitly and the runtime must reject it until a separately implemented Effect Firewall action supports it.
- Targeting: a child uses explicit fingerprints or the immutable rule `verified_discovery`; discovery is accepted only after the existing fresh observed-surface and identity recheck produces a fingerprint. Raw target/account/comment/DM text, signatures, private keys, tokens, runtime IDs, and paths stay out of public API/evidence views.
- Budget: every grant contains immutable maximum ceilings and conservative defaults. A child Mission compiles and persists its effective budget; omitted child values use defaults, supplied values must be no greater than maxima. Budget is still reserved by the existing atomic ECP ledger per Mission.
- Single-device only: retain `parallelism === 1`. Do not change placement to all ready/free devices in this work; multi-device grants are a later explicit design.
- Revocation and rollback stop new grant-backed primitives/effects fail-closed, leave audits intact, and use normal restoration/recovery to release resources. They never delete rows or claim an in-flight/ambiguous effect was undone.

### Task 1: Define canonical Standing Grant policy, signed envelope, and ADR

**Files:**
- Create: `docs/adr/0009-standing-grant-delegation.md`
- Create: `control-plane/schema/delegation-grant.schema.json`
- Create: `control-plane/lib/delegation-grant-policy.mjs`
- Create: `tests/delegation-grant-policy.test.mjs`
- Modify: `control-plane/schema/mission.schema.json`
- Modify: `control-plane/lib/mission-policy.mjs`

**Step 1: Write failing policy/schema tests**

Cover a canonical draft whose authorization block is limited to the accepted facts, and reject all widening cases. Add one permanent draft (`expiresAt: null`), one finite parent/child comparison, and prove the explicit-target and verified-discovery forms are mutually exclusive:

```js
assert.throws(() => validateDelegationGrantDraft({
  ...validGrant,
  authorization: { ...validGrant.authorization, prohibitedActions: ["payment"] },
}), { code: "GRANT_POLICY_INVALID" });
assert.throws(() => validateDelegationGrantDraft({ ...validGrant, scope: { ...validGrant.scope, maxParallelism: 2 } }),
  { code: "PARALLELISM_UNSUPPORTED" });
assert.equal(validateDelegationGrantDraft(validGrant).budget.defaults.totalCount, 1);
```

Also make the Mission schema reject unknown `parentGrantId`/target-discovery fields until the exact fields are added, and assert that `delete/profile/settings` require an explicit child action rather than a broad grant category.

**Step 2: Run the focused tests to prove red**

Run: `node --test tests/delegation-grant-policy.test.mjs`

Expected: FAIL because the grant schema/policy module and parent-grant fields do not exist.

**Step 3: Implement the smallest canonical policy boundary**

Create a version-1 schema and normalizer with no permissive additional properties. Canonical content must include immutable app/account fingerprint binding, controller allowlist, validity, `maxParallelism: 1`, action allow/prohibit lists, target rule, budget maxima/defaults, and redaction policy. Define the signed bytes exactly as (the human signs this offline; the control plane only verifies it):

```js
canonicalJson({
  kind: "delegation_grant.issue.v1",
  subject: "user:a1234",
  grantId,
  issuanceNonce,
  allowlistVersion,
  grantHash,
  grant: canonicalGrantContent,
});
```

`delegation-grant-policy.mjs` must compute `grantHash = fingerprint(canonicalGrantContent)` and deep-freeze the normalized result. `expiresAt` is nullable for a permanent grant; a finite parent bounds a child, while Mission `validity.expiresAt` remains mandatory and finite. Extend the Mission policy only with an immutable parent reference and mutually exclusive target modes: explicit fingerprints or `verified_discovery`. The latter carries a hash-only provenance contract `{ snapshotHash, observedAt, accountFingerprint, pageFingerprint, observedTargetFingerprint, identityEvidenceHash }`; it never accepts raw identity text. Write ADR 0009 as Proposed: it records the offline ceremony, allowlist rotation/revocation/recovery, nonce replay rule, no authority transfer to recipes/leases, flag gates, and the phased rollback rule; it does not enable either flag.

**Step 4: Run focused tests to prove green**

Run: `node --test tests/delegation-grant-policy.test.mjs tests/mission-runtime.test.mjs`

Expected: PASS; every prohibited/unknown/parallelism expansion fails closed and existing Mission policy tests remain unchanged.

**Step 5: Commit**

```bash
git add docs/adr/0009-standing-grant-delegation.md control-plane/schema/delegation-grant.schema.json \
  control-plane/lib/delegation-grant-policy.mjs control-plane/schema/mission.schema.json \
  control-plane/lib/mission-policy.mjs tests/delegation-grant-policy.test.mjs tests/mission-runtime.test.mjs
git commit -m "feat(control-plane): define standing grant policy"
```

### Task 2: Persist verified human grants and their audit trail additively

**Files:**
- Create: `control-plane/lib/trusted-human-issuer.mjs`
- Create: `control-plane/lib/delegation-grant-runtime.mjs`
- Create: `config/standing-grant-issuer-keys.example.json`
- Create: `tests/delegation-grant-runtime.test.mjs`
- Modify: `control-plane/lib/state-store.mjs`
- Modify: `control-plane/bootstrap.mjs`
- Modify: `tests/control-plane-placement.test.mjs`

**Step 1: Write failing durable/issuer tests**

Use an ephemeral test-only Ed25519 fixture in the test process, clearly unrelated to a user key. Prove that a valid `user:a1234` issue envelope persists once and reuses only byte-identical `(grantId, issuanceNonce, grantHash, proofHash)`; the same nonce with different content is `ISSUANCE_NONCE_REPLAY`, and replay of a revoked grant is `GRANT_REVOKED` rather than reactivation. A forged signature, unconfigured/revoked key id, and `actor: "user:a1234"` with no proof fail before any grant row exists. Reopen the database and assert grant/hash/status/issuer subject/key id/proof hash/allowlist version/events remain; then simulate allowlist key revocation before control start and assert reconciliation revokes affected grants before any adapter can be called. Migrate a v4 fixture and assert all legacy job/session/mission rows survive.

**Step 2: Run focused tests to prove red**

Run: `node --test tests/delegation-grant-runtime.test.mjs tests/control-plane-placement.test.mjs`

Expected: FAIL because there is no issuer verifier, grant runtime, tables, or v4-to-v5 migration.

**Step 3: Implement verification and storage**

Add `delegation_grants` and `delegation_grant_events` through additive StateStore DDL, then set `PRAGMA user_version = 5`. Store immutable `grant_id`, `issuance_nonce` (unique), `idempotency_key`, `grant_hash`, canonical grant JSON, nullable expiry, issuer subject/key id, allowlist version, proof hash, status, issue/revoke timestamps, and revocation reason; never store or return a private key or raw signature. Add `issueDelegationGrant`, `get/list`, `revokeDelegationGrant`, `revokeGrantsForIssuerKey`, and event-list helpers under the existing transaction boundary. Exact same signed bytes are idempotent; any changed hash/proof/nonce conflicts, and no revoked row is reusable.

`TrustedHumanIssuer` loads only a Windows-admin-managed public-key allowlist from `STANDING_GRANT_ISSUER_KEYS_PATH`; the example contains placeholders only. It verifies Ed25519 over the exact canonical bytes from Task 1, requires subject `user:a1234`, an active key, and current allowlist version, then returns a sanitized receipt. Missing/malformed/revoked configuration is `STANDING_GRANT_ISSUER_UNAVAILABLE` and fails closed. Issuance/revocation require separately offline-signed `issue.v1`/`revoke.v1` envelopes; do not accept a client actor as substitute proof. On startup, reconcile revoked/missing issuer keys to durable grant revocations before `control.start()`; key bootstrap, rotation, recovery, and offline revocation are documented human/admin procedures only, never API endpoints.

**Step 4: Run focused tests to prove green**

Run: `node --test tests/delegation-grant-runtime.test.mjs tests/control-plane-placement.test.mjs`

Expected: PASS, including restart durability, proof failure with zero rows, and the existing additive-migration assertion updated to user version 5.

**Step 5: Commit**

```bash
git add control-plane/lib/trusted-human-issuer.mjs control-plane/lib/delegation-grant-runtime.mjs \
  control-plane/lib/state-store.mjs control-plane/bootstrap.mjs config/standing-grant-issuer-keys.example.json \
  tests/delegation-grant-runtime.test.mjs tests/control-plane-placement.test.mjs
git commit -m "feat(control-plane): persist signed delegation grants"
```

### Task 3: Compile only Grant-subset Missions and enforce flag-off zero allocation

**Files:**
- Modify: `control-plane/lib/mission-runtime.mjs`
- Modify: `control-plane/lib/control-plane.mjs`
- Modify: `control-plane/lib/state-store.mjs`
- Modify: `control-plane/schema/mission.schema.json`
- Modify: `tests/control-plane-mission.test.mjs`
- Modify: `tests/mission-runtime.test.mjs`
- Modify: `tests/mission-freedom-acceptance.test.mjs`

**Step 1: Write failing subset/gate tests**

Create a verified grant, then assert all of the following before implementing:

```js
const result = control.submitMission({ actor: "agent:runner", parentGrantId: grant.grantId, policy: child });
assert.equal(result.status, "blocked");
assert.equal(result.reason, "STANDING_GRANT_NOT_ENABLED");
assert.equal(state.listDeviceRuns({ missionId: result.mission.missionId }).length, 0);
assert.equal(state.listLeases().length, 0);
assert.equal(state.listMissionEffects(result.mission.missionId).length, 0);
```

Add red cases for a different account fingerprint, non-allowlisted controller, over-max total/per-target/frequency budget, `payment`/`publish`, an undeclared `delete/profile/settings`, a stale or incomplete verified-discovery provenance object, target discovery without a matching fresh account/page/identity evidence hash, revoked/expired parent, changed parent hash, and a client-supplied issuer. Confirm legacy non-Mission R2 approval behavior remains unchanged.

**Step 2: Run focused tests to prove red**

Run: `node --test tests/control-plane-mission.test.mjs tests/mission-runtime.test.mjs tests/mission-freedom-acceptance.test.mjs`

Expected: FAIL because `parentGrantId`, subset compilation, and the Standing Grant flag gate are absent.

**Step 3: Implement immutable parent-child compilation**

Add nullable, additive `parent_grant_id` and `parent_grant_hash` columns to `missions`, index them, and advance the schema only to user version 6. `MissionRuntime.createMissionFromGrant` must re-read the active immutable grant, reject a revoked `(grantId, grantHash)`, normalize a child request, compile omitted total/per-target/frequency limits from immutable grant defaults, check every supplied limit against the corresponding maximum, require finite child expiry (and `child.expiresAt <= parent.expiresAt` for finite parents), bind parent id/hash plus effective budget into the child's canonical content hash, and persist the compiled child policy once. The stored Mission issuer is the verified grant issuer subject; the submitting agent is audit/controller data only.

Require both existing `MISSION_AUTO_APPROVAL_ENABLED === "1"`/accepted ADR 0008 and new `STANDING_GRANT_ENABLED === "1"` for parent-grant execution. Test each flag independently off, both off, and ADR rejected; preserve a non-oracular stable blocked reason while asserting the same zero-allocation result. With either gate closed, a *valid, compiled* child may be durably recorded as blocked with an audit event but must allocate no DeviceRun, session, lease, reservation, adapter call, approval, or runner heartbeat. Invalid subset/proof/revocation inputs fail before child persistence and always before allocation. Keep `parallelism: 1`; do not add an all-ready/free scheduler.

**Step 4: Run focused tests to prove green**

Run: `node --test tests/control-plane-mission.test.mjs tests/mission-runtime.test.mjs tests/mission-freedom-acceptance.test.mjs`

Expected: PASS; flag-off tests prove zero allocation and flag-on tests only create one canonical DeviceRun after all subset checks pass.

**Step 5: Commit**

```bash
git add control-plane/lib/mission-runtime.mjs control-plane/lib/control-plane.mjs \
  control-plane/lib/state-store.mjs control-plane/schema/mission.schema.json \
  tests/control-plane-mission.test.mjs tests/mission-runtime.test.mjs tests/mission-freedom-acceptance.test.mjs
git commit -m "feat(control-plane): bind missions to delegation grants"
```

### Task 4: Recheck active grants during primitives/ECP and make revocation durable

**Files:**
- Modify: `control-plane/lib/delegation-grant-runtime.mjs`
- Modify: `control-plane/lib/mission-runtime.mjs`
- Modify: `control-plane/lib/control-plane.mjs`
- Modify: `control-plane/lib/effect-commit-protocol.mjs`
- Modify: `control-plane/lib/device-run.mjs`
- Modify: `tests/effect-commit-protocol.test.mjs`
- Modify: `tests/device-run.test.mjs`
- Modify: `tests/delegation-grant-runtime.test.mjs`

**Step 1: Write failing revocation/control tests**

Prove that revoking a signed grant writes `delegation_grant.revoked` plus child Mission audit events, prevents a new primitive and a new ECP begin after a restart, and does not call the adapter. Test a target discovered from a fresh (<= `SNAPSHOT_MAX_AGE_MS`) snapshot succeeds only when its hash-bound provenance has matching account/page/identity evidence and fails otherwise. Exercise total, per-target, and frequency budget defaults/maxima across a StateStore reopen, then prove an `effect_started`/ambiguous outcome consumes its reservation and cannot be replayed. Test all four blocked-child gate combinations after a process reconstruction: zero DeviceRun/session/lease/effect/approval/adapter call/heartbeat. Assert runner heartbeats stop and normal restoration/recovery releases the lease.

**Step 2: Run focused tests to prove red**

Run: `node --test tests/delegation-grant-runtime.test.mjs tests/effect-commit-protocol.test.mjs tests/device-run.test.mjs`

Expected: FAIL because existing primitive/ECP paths only check Mission state and revocation does not own grant-wide audit/cleanup semantics.

**Step 3: Implement fail-closed runtime enforcement**

Have `requireActiveMission` also require the referenced parent grant to be active, its stored hash to match, and its issuer key to remain active in the loaded allowlist. Recheck this at DeviceRun open, primitive execution, ECP begin, and `retryNotSentInPlace`; verified discovery must validate the hash-bound provenance, freshness, readiness, app/account/page/before-state, and observed identity before it can consume a grant budget. A grant/key revocation transaction marks the grant revoked, appends immutable grant/Mission audit events, and marks child work unable to start. Outside that transaction, the runner uses the existing restoration/recovery path to stop heartbeats and release session/lease; no external effect is replayed or retroactively undone.

**Step 4: Run focused tests to prove green**

Run: `node --test tests/delegation-grant-runtime.test.mjs tests/effect-commit-protocol.test.mjs tests/device-run.test.mjs`

Expected: PASS; revoked/expired/flag-disabled grant paths produce a stable blocked code, zero adapter calls, durable audit, and eventual `listLeases() === []`.

**Step 5: Commit**

```bash
git add control-plane/lib/delegation-grant-runtime.mjs control-plane/lib/mission-runtime.mjs \
  control-plane/lib/control-plane.mjs control-plane/lib/effect-commit-protocol.mjs control-plane/lib/device-run.mjs \
  tests/delegation-grant-runtime.test.mjs tests/effect-commit-protocol.test.mjs tests/device-run.test.mjs
git commit -m "feat(control-plane): enforce standing grant revocation"
```

### Task 5: Add controlled Grant API/CLI, public redaction, and config wiring

**Files:**
- Modify: `control-plane/router.mjs`
- Modify: `control-plane/devicectl.mjs`
- Modify: `control-plane/bootstrap.mjs`
- Modify: `scripts/control-plane-worker.ps1`
- Modify: `scripts/control-plane-task.ps1`
- Modify: `tests/control-plane-server.test.mjs`
- Modify: `tests/devicectl.test.mjs`
- Create: `docs/agent-entry-standing-grants.md`

**Step 1: Write failing transport/redaction tests**

Add CLI tests for `grant issue|show|list|revoke`. `grant issue` must read an explicit already-signed local proof file and post a parsed envelope; no command generates, imports, exports, or prints a private key or raw proof. Router tests must reject unsigned/spoofed/replayed issue/revoke requests, and assert every public Grant/Mission response omits account fingerprints, target values, controllers, signatures, key material, raw policy, runtime ids, and local paths.

**Step 2: Run focused tests to prove red**

Run: `node --test tests/control-plane-server.test.mjs tests/devicectl.test.mjs`

Expected: FAIL because no Grant routes/commands, issuer-proof transport, or redacted Grant view exists.

**Step 3: Implement minimal boundary and Windows config contract**

Add only these endpoints: issue/list/show/revoke grants, plus `mission submit --parent-grant`. Public views return grant id/hash/status/time window/action names/count ceilings/target mode and child count, never secrets or raw identities. The worker reads two explicit booleans, an issuer-key path, and allowlist version from `task-launch.json`, defaulting both feature flags to false; it verifies the path and allowlist version before starting only when `STANDING_GRANT_ENABLED=1`. The installer writes false defaults and placeholder paths only. Do not add a key-generation/signing/recovery endpoint, a flag-setting CLI, or silently inherit a machine environment value.

`docs/agent-entry-standing-grants.md` documents the approved devicectl forms, proof-file handling, zero-allocation flag-off check, forbidden endpoints, and never displays a real key, signature, account, target, or token.

**Step 4: Run focused tests to prove green**

Run: `node --test tests/control-plane-server.test.mjs tests/devicectl.test.mjs && npm run check`

Expected: PASS; only signed human envelopes can mutate grants, all HTTP/CLI public shapes are redacted, and default launch settings keep both gates disabled.

**Step 5: Commit**

```bash
git add control-plane/router.mjs control-plane/devicectl.mjs control-plane/bootstrap.mjs \
  scripts/control-plane-worker.ps1 scripts/control-plane-task.ps1 docs/agent-entry-standing-grants.md \
  tests/control-plane-server.test.mjs tests/devicectl.test.mjs
git commit -m "feat(control-plane): expose guarded standing grants"
```

### Task 6: Independently review, then run the single-device enablement and rollback gates

**Files:**
- Create: `docs/runbooks/standing-grant-phased-rollout.md`
- Modify: `docs/adr/0009-standing-grant-delegation.md`
- Modify: `tests/mission-freedom-acceptance.test.mjs`

**Step 1: Write a failing offline rollout matrix**

Extend the acceptance matrix with reportable checkpoints: `issuerProof=passed`, `allowlistRotationAndRecovery=passed`, `grantDurability=passed`, `grantSubset=passed`, `verifiedDiscoveryProvenance=passed`, `budgetRestartAndAmbiguity=passed`, `flagOffZeroAllocation=passed`, `singleDeviceCanary=pending_live`, `independentReview=pending`, `multiDevice=not_implemented`. Its flag-off subtest must independently cover Mission flag off, Standing Grant flag off, both off, and ADR rejection, then reopen the process and prove no DeviceRun/session/lease/effect/approval/adapter/heartbeat for a valid signed child.

**Step 2: Run the complete offline gate**

Run: `node --test tests/mission-freedom-acceptance.test.mjs && npm test && npm run check && git diff --check`

Expected: all tests/checks pass, with live canary and multi-device explicitly pending/not implemented rather than reported as successful.

**Step 3: Write the phased runbook and review checklist**

The runbook must require these ordered checkpoints:

1. Independent reviewer signs off the migration replay, Ed25519 trust boundary, human offline bootstrap/rotation/compromise-recovery ceremony, nonce replay handling, subset/target-discovery provenance tests, public redaction, ECP/PHC invariants, and diff; ADR 0009 changes from Proposed to Accepted only with the recorded human decision.
2. Deploy the reviewed commit using `AGENTS.md` process with `MISSION_AUTO_APPROVAL_ENABLED=0` and `STANDING_GRANT_ENABLED=0`; update `task-launch.json` to the full SHA; restart the scheduled control-plane task; verify health, agent entry, and zero leases/jobs/approvals. Issue a signed test grant only if needed for the zero-allocation API check; do not allocate a device.
3. Only after a second independent go/no-go, set both flags to `1` for one Windows control-plane restart. Verify canonical `ready=yes + lease=free`, no active work, and the trusted key file before one child Mission on one device. The lowest-risk social canary is exactly one `collect` on a human-provided, identity-verified public target: no free text, follow, DM, comment, payment, publish, delete, profile, or settings; no retry. PASS requires succeeded, verification/evidence/restoration, public redaction, and zero terminal leases/jobs/approvals. CAPTCHA/login/risk-control/unknown/identity mismatch/control loss/budget exhaustion/ambiguous is an immediate stop.
4. Rollback at any failure: set `STANDING_GRANT_ENABLED=0` first (and `MISSION_AUTO_APPROVAL_ENABLED=0` for the pilot), restart control plane, signed-revoke the pilot grant when its signer remains available, or use the reviewed offline allowlist-revocation/reconciliation ceremony when it is not; let normal restoration/recovery finish, and verify zero active resources. Preserve DB/evidence/audit rows; do not delete or down-migrate them. Keep `CONTROL_PLANE_LEGACY_MODE=enforce`.

State explicitly that multi-device selection, `parallelism > 1`, all-ready/free fan-out, and concurrent grant budgets are deferred to a separate ADR, data-model review, offline matrix, independent review, and another smallest-scope canary.

**Step 4: Re-run final verification**

Run: `node --test tests/mission-freedom-acceptance.test.mjs && npm test && npm run check && git diff --check`

Expected: PASS; runbook has no instruction that enables a flag before independent review or treats HTTP 200/dry-run as canary success.

**Step 5: Commit**

```bash
git add docs/runbooks/standing-grant-phased-rollout.md docs/adr/0009-standing-grant-delegation.md \
  tests/mission-freedom-acceptance.test.mjs
git commit -m "docs(control-plane): add standing grant rollout gates"
```

## Completion criteria

Implementation is ready for a deployment review only when Tasks 1-6 are green, migration is additive/reopen-safe, grant issuance and revocation are cryptographically attributable to `user:a1234`, every child policy is hash-bound and subset-checked, flag-off cannot allocate any resource, and public surfaces remain redacted. It is not permission to enable either flag, run the canary, or add multi-device scheduling without the separate runbook approvals.
