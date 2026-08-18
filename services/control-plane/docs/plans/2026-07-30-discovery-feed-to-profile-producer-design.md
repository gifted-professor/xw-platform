# Discovery Feed→Profile Capture-Only Producer Design

- Status: Proposed (ADR 0010 remains Proposed; both feature flags false)
- Date: 2026-07-30
- Depends on: ADR 0010, DiscoverySession Design, Task 1-2 (Grant schema + DiscoveryRun lifecycle)

## Purpose

Design a fenced, capture-only (no social effect) Discovery producer that, within a single DiscoveryRun/lease/controllerEpoch, navigates from a feed snapshot to an author profile snapshot and produces an immutable hash-only receipt suitable for `seed_profile_relation` candidate ingestion.

This design does NOT enable any feature flag, deploy code, issue a Grant, or authorize a device action. It defines the schema, safety boundaries, and TDD contract for a later implementation task.

## Context and constraints

### Luna review (task 019fb200) binding findings

The independent review of Registry identity as Discovery target proof concluded NO-GO:

- **P0-1**: Registry has no `xhsPublicId` field; `accounts.xhs` is a display nickname only. Registry serial is a device physical anchor, not a logged-in XHS account proof.
- **P0-2**: Registry identity proves controller account at best; it can NEVER prove a feed target (author) identity. Conflating them would forge the target.
- **P0-3**: `openProfile` (fast-operator.mjs:482-501) returns only `{opened, activity, authorName, tapped}` — no stable target ID, avatar content hash, or profile fingerprint.
- **P0-4**: Registry 900s cache staleness is not 5s snapshot freshness; mutable cache cannot be signed anchor or identity evidence.

These findings are accepted as constraints. The Registry may only provide controller account context in a future design where it is independently confirmed by a same-account same-snapshot capture. It is NEVER a target identity source.

### ADR 0010 constraints

- DiscoverySession is R0/R1-only. allowedPrimitives: screenshot, dump, focus, launch, back, home, navigation tap/swipe, search input, restore.
- Effect Firewall blocks: follow, like, collect, comment, DM, delete, profile(edit), settings, payment, publish, unknown, risk-control, login, captcha, identity-mismatch.
- identityPolicy: stableUserId preferred; fallback = exact nickname + avatar-content + profile-fingerprint composite; ambiguity = terminal stop.
- Snapshot freshness: 5s. Observation compile window: 60s.
- Single device, maxParallelism=1.
- Each primitive: atomic reservation before job; idempotency key `{discoveryRunId, primitive, normalizedArgsHash}`.
- Authoritative observation: immutable lineage with evidence ID/SHA-256, source/content hashes, anchor/relation binding.
- Anchor types × relation kinds: `seedIdentityFingerprint→seed_profile_relation`, `contentContextHash→content_author|content_mentioned_profile`, `searchQueryHash→search_result`, `identityFingerprint→explicit_target`.

### fast-operator platform reality

- feedCards (fast-operator.mjs:363-411): extracts authorName (TextView text), avatar bounds, cover bounds, likeButton position — all structural, no stable userId, no image content hash.
- openProfile (fast-operator.mjs:482-501): feed→openCard→tap detail header avatar→detect profile overlay. Returns `{opened:bool, activity, authorName, tapped}`. Does NOT extract profile statistics or avatar contentDesc.
- Profile overlay structure (fast-operator.mjs:477-501): clickable ImageView with contentDesc (浮层头像, e.g., "头像,xxx"), follower/following/like count TextViews, follow/DM buttons, note grid. No userId exposed.
- XHS version note: "feed 头像/名字 tap 都只开笔记" — feed card avatar/name tap opens the note, NOT the profile. Two-step navigation is required.

## A/B/C Comparison

### A: Same-DiscoveryRun feed→profile navigation (autonomous discovery)

**Flow** (5-6 R0 primitives within one lease/epoch):

```
Feed page (IndexActivityV2)
    │
    ├─[1] feedSnapshot: dump() → feedCards() → currentFocus()
    │     Evidence: feed dump XML + parsed card list
    │     Receipt: { feedSnapshotHash, cardCount, package, activity, observedAt }
    │
    ├─[2] selectCandidate: parser selects one card (NOT caller-supplied)
    │     Criteria: authorName present + avatar present + cover center valid
    │     Receipt: { candidateCardFingerprint, cardIndex, authorName }
    │
    ├─[3] openCard: tap cover center → verify NoteDetail/DetailFeed
    │     If video note: pauseIfVideoNote
    │     Receipt: { fromActivity, toActivity, tapped, opened, timestamp }
    │
    ├─[4] dumpDetail: dump() on note detail → locate author avatar
    │     Receipt: { detailDumpHash, avatarLocated, avatarBounds }
    │
    ├─[5] openProfileOverlay: tap author avatar center → verify overlay
    │     Receipt: { avatarTapped, overlayDetected, activity, timestamp }
    │
    ├─[6] captureProfile: dump() → extract profile identity data
    │     + screenshot(crop=avatar region) → avatarContentHash
    │     Receipt: { profileSnapshotHash, profileFingerprint, avatarContentHash,
    │               displayName, followerCount, followingCount, likeCount,
    │               noteGridCount, hasFollowButton, hasDmButton }
    │
    └─[7] restore: backFromProfile → IndexActivityV2
          Receipt: { restored, backCount, finalActivity }
```

**Trust chain**: feedEvidenceId/SHA-256 → candidate selection proof → navigation transition proofs → profileEvidenceId/SHA-256 → sealed lineage.

**Risk**: Navigation taps (cover, avatar) could accidentally hit social-effect buttons. Mitigation: (a) precise coordinate targeting via structural parser, (b) post-tap surface verification before next step, (c) any unexpected surface → typed abort + restore + release.

**Identity**: stableUserId unavailable → fallback to composite fingerprint. Avatar-content hash requires screenshot capability (R0, allowed). Profile structural fingerprint from dump.

### B: explicit_target known profile (first canary, collect-only)

**Flow** (2-3 R0 primitives):

```
Known profile page (direct navigation or deep link)
    │
    ├─[1] captureProfile: dump() + screenshot(avatar) → profile identity
    │     Receipt: same schema as A-[6] (profile fields)
    │
    └─[2] verifyIdentity: compare against signed explicit target anchor
```

**Trust chain**: explicit signed identityFingerprint → profile capture → match verification.

**Risk**: Requires prior knowledge of the target (signed identityFingerprint in Grant). Not autonomous.

**First canary**: collect-only. No autonomous candidate expansion. Same Grant/identity/budget/ECP/audit rules as explicit-target path.

**Identity**: Must match the signed explicit target. If profile capture shows different identity → typed mismatch → terminal.

### C: NO-GO

**Triggers** (any one ⇒ zero receipt, zero observation/candidate/Mission/effect):

1. No stable profile ID: XHS UI dump lacks userId; composite fallback is required but avatar-content screenshot fails or profile structural data incomplete.
2. Navigation failure: any transition step (openCard, openProfileOverlay) does not reach expected activity/surface.
3. Surface violation: Effect Firewall classifies any observed surface as non-R0 (social-effect, risk-control, login, captcha, unknown).
4. Identity ambiguity: display name missing, avatar contentDesc empty, profile statistics unparseable, or composite fingerprint collision.
5. Freshness violation: any snapshot >5s old at the point of use.
6. Lease/epoch mismatch: foreign lease, stale epoch, or concurrent revoke during navigation.
7. ADR gate closed or either feature flag false.
8. Identity mismatch between feed card authorName and profile display name.

**Recommendation**: C must be the default when ANY required evidence is missing. The producer must produce typed NO-GO (not silent null) with audit event.

## Recommendation: A-first with C-default

**Primary recommendation: Approach A** (autonomous feed→profile navigation) because:
- It implements the `seed_profile_relation` anchor/relation pair authentically (target genuinely found in seed's feed)
- It satisfies the one-hop rule (feed → note → profile = observation navigation, not multi-hop social graph traversal)
- It enables autonomous Discovery without pre-known targets
- Navigation taps (cover, avatar) are R0 primitives explicitly allowed by ADR 0010

**C is the DEFAULT behavior**: Before any producer execution, the system verifies all preconditions. If ANY evidence component is unavailable (no stable ID, no avatar screenshot capability, navigation fails, surface blocked), the producer returns typed NO-GO with audit event and zero downstream allocation.

**B is the explicit-target fallback**: When a signed explicit target exists, B can skip the feed→profile navigation. It shares the same profile capture schema and identity verification as A. First canary remains collect-only.

## Producer receipt schema

### feedSnapshotReceipt (step 1)

```json
{
  "receiptKind": "discovery.feed.snapshot",
  "feedSnapshotHash": "<sha256>",
  "feedEvidenceId": "<evidence_id>",
  "feedEvidenceHash": "<sha256>",
  "package": "com.xingin.xhs",
  "activity": "IndexActivityV2",
  "cardCount": 5,
  "cards": [
    {
      "cardIndex": 0,
      "authorName": "<display_name>",
      "hasAvatar": true,
      "hasCover": true,
      "hasLikeButton": true
    }
  ],
  "observedAt": "<ISO8601>",
  "parserVersion": "fast-operator-v1",
  "dumpMs": 1234
}
```

Public projection omits raw `cards[].authorName` (display names are PII). Keeps `cardCount`, `cards[].cardIndex`, and boolean structural markers only.

### candidateSelectionReceipt (step 2, parser-only)

```json
{
  "receiptKind": "discovery.candidate.select",
  "candidateCardFingerprint": "<sha256>",
  "cardIndex": 2,
  "selectionCriteria": {
    "hasAuthorName": true,
    "hasAvatar": true,
    "hasValidCover": true
  },
  "feedSnapshotHash": "<sha256>",
  "selectedAt": "<ISO8601>"
}
```

The parser selects, NOT the caller. `candidateCardFingerprint = sha256(canonicalJson({cardIndex, authorName, avatarBounds}))`. Feed authorName enters the fingerprint but NOT the public receipt.

### navigationTransitionReceipt (steps 3-5)

Each navigation step produces:

```json
{
  "receiptKind": "discovery.navigation.transition",
  "transitionId": "<discoveryRunId>:openCard|openProfileOverlay",
  "fromActivity": "IndexActivityV2",
  "toActivity": "NoteDetailActivity",
  "fromSurface": "navigation",
  "toSurface": "observation",
  "tapTarget": {
    "elementType": "cover|avatar",
    "center": [540, 1200],
    "boundsHash": "<sha256>"
  },
  "opened": true,
  "firewallVerdict": {
    "decision": "auto",
    "surface": "observation",
    "code": "REVERSIBLE_AUTO"
  },
  "timestamp": "<ISO8601>"
}
```

Report ONLY the transition that failed (if any). Success transitions are hashed into the final lineage.

### profileCaptureReceipt (step 6, the authoritative observation source)

```json
{
  "receiptKind": "discovery.profile.capture",
  "snapshotHash": "<sha256>",
  "app": "xhs",
  "accountFingerprint": "<sha256>",
  "pageFingerprint": "<sha256>",
  "observedTargetFingerprint": "<sha256>",
  "identityEvidenceHash": "<sha256>",
  "anchor": {
    "type": "seedIdentityFingerprint",
    "hash": "<sha256>"
  },
  "relationKind": "seed_profile_relation",
  "relationEvidenceId": "<evidence_id>",
  "relationEvidenceHash": "<sha256>",
  "observedAt": "<ISO8601>",
  "snapshot": {
    "surface": "observation",
    "createdAt": "<ISO8601>",
    "observedAt": "<ISO8601>"
  },
  "profileComposite": {
    "stableUserId": null,
    "displayName": "<sha256>",
    "avatarContentHash": "<sha256>",
    "profileFingerprint": "<sha256>",
    "ambiguity": false,
    "ttlSeconds": 86400,
    "collisionNote": "display-name-only composite; collision risk >0 for common names"
  },
  "_private": {
    "rawDumpHash": "<sha256>",
    "rawScreenshotHash": "<sha256>",
    "avatarContentDesc": "<头像,xxx>",
    "followerCount": 1234,
    "followingCount": 567,
    "likeCount": 8901,
    "noteGridCount": 42,
    "hasFollowButton": true,
    "hasDmButton": true
  }
}
```

**Computation rules**:

| Field | Formula | Notes |
|-------|---------|-------|
| `snapshotHash` | sha256(profileDumpXml + profileScreenshotBytes) | Combined hash of raw capture |
| `accountFingerprint` | sha256(canonicalJson({controllerIdentity})) | Controller, NOT target. From same-snapshot account proof. Unavailable in MVP v1 — placeholder null. |
| `pageFingerprint` | sha256(canonicalJson({package, activity, hasProfileOverlay, hasNoteGrid, hasFollowButton, hasDmButton})) | Structural page identity |
| `observedTargetFingerprint` | sha256(canonicalJson({displayName, avatarContentHash, profileFingerprint})) | Composite target identity |
| `identityEvidenceHash` | sha256(avatarScreenshotBytes + canonicalJson(profileComposite)) | Cryptographic binding of observation to identity |
| `anchor.hash` | sha256(canonicalJson({controllerSerial})) or sha256(canonicalJson({feedSnapshotHash, cardIndex})) | Seed identity anchor |
| `profileComposite.profileFingerprint` | sha256(canonicalJson({followerCount, followingCount, likeCount, noteGridCount})) | From parsed profile overlay TextViews |
| `profileComposite.avatarContentHash` | sha256(avatarScreenshotBytes) | Cropped avatar region screenshot |

**identityEvidenceHash binding**: The hash ties the avatar image content + display name + profile structural fingerprint + snapshot hash into one immutable proof. If the avatar image changes, display name changes, or profile stats diverge beyond tolerance, the hash breaks.

**Stability note**: displayName is mutable (users can rename). avatarContentHash changes when avatar is updated. profileFingerprint changes as counts increment. The composite is best-effort for same-day verification; cross-day verification requires a new capture. TTL is advisory (86400s = 1 day). No cryptographic guarantee of long-term identity persistence.

### lineageReceipt (final sealed lineage)

```json
{
  "receiptKind": "discovery.lineage.sealed",
  "discoveryRunId": "<id>",
  "grantId": "<id>",
  "grantHash": "<sha256>",
  "sessionId": "<id>",
  "controllerAgent": "<agent_id>",
  "controllerEpoch": 1,
  "sourceJobIds": ["<job1>", "<job2>", "..."],
  "sourceRunIds": ["<run1>", "<run2>", "..."],
  "feedEvidenceId": "<id>",
  "feedEvidenceHash": "<sha256>",
  "profileEvidenceId": "<id>",
  "profileEvidenceHash": "<sha256>",
  "candidateCardFingerprint": "<sha256>",
  "navigationProofHash": "<sha256>",
  "profileCaptureHash": "<sha256>",
  "sealedAt": "<ISO8601>",
  "anchor": { "type": "seedIdentityFingerprint", "hash": "<sha256>" },
  "relationKind": "seed_profile_relation",
  "relationEvidenceId": "<profileEvidenceId>",
  "relationEvidenceHash": "<profileEvidenceHash>"
}
```

## Effect Firewall: Discovery profile surface classification

### Current SURFACE_INFO (effect-firewall.mjs:8-19)

`navigation` (R0) and `observation` (R0) are the only reversible surfaces. No "profile" surface exists in the current classifier.

### Discovery profile classification rule

A profile overlay page is classified as `observation` (not `social-effect`, not `unknown`) when ALL of:
1. Current activity is NoteDetailActivity or DetailFeedActivity (profile is an overlay, not a separate activity)
2. A clickable ImageView with non-empty contentDesc exists at y<600 (profile floating avatar)
3. NO social-effect intent is declared
4. The surface was reached via controlled navigation (openCard → tap author avatar), NOT via follow button tap

### Blocked transitions

The Firewall MUST block (typed `DISCOVERY_SURFACE_BLOCKED`, decision `blocked`):

| Condition | Reason |
|-----------|--------|
| Follow button detected as tap target | Would trigger R2 social effect |
| DM button detected as tap target | Would trigger R2 social effect |
| Profile settings/edit surface detected | Would trigger R3 protected effect |
| Activity is not NoteDetail/DetailFeed after openCard | Navigation failed, unknown surface |
| Overlay not detected after avatar tap | Tap missed or XHS version changed |
| Like/collect/comment button in tap proximity (<100px) | Risk of accidental social effect |
| identity-mismatch: feed authorName ≠ profile displayName | Target identity not the intended candidate |

## Anchor/relation membership

For the feed→profile producer:

- **anchor.type**: `seedIdentityFingerprint`
- **anchor.hash**: sha256(canonicalJson({feedSnapshotHash, cardIndex})) — the feed origin proves the seed relationship
- **relationKind**: `seed_profile_relation`
- **One-hop proof**: feed card → note detail → profile overlay = one hop from seed observation
- **relationEvidenceId/SHA-256**: the profile capture evidence (evidence ID and hash from EvidenceStore)

The signed DiscoveryPolicy must authorize this anchor/relation pair:
```json
{
  "anchors": [{ "type": "seedIdentityFingerprint", "hash": "<feed-origin-hash>" }],
  "relationKinds": ["seed_profile_relation"],
  "maxHops": 1
}
```

## Same-run atomic reservation and job binding

Each primitive (feed dump, openCard, detail dump, avatar tap, profile dump, screenshot, back) is:

1. **Reserved atomically** via `reserveDiscoveryPrimitiveStorage` in one `BEGIN IMMEDIATE` transaction that re-reads Grant/hash, flags, ADR gate, canonical readiness, issuer config, deadline, and active lease/session/controllerEpoch/discoveryRunId ownership BEFORE the reservation is committed.
2. **Job created** with `externalEffect=false`, bound to discoveryRunId.
3. **Idempotency key**: `{discoveryRunId, primitive, normalizedArgsHash}`. Exact replay returns original reservation. Changed replay = typed conflict.
4. **No refund**: once job intent exists, reservation is durable across crash/restart/abandon.

Sequence binding: each step's evidenceId is referenced by the next step's job envelope. The full chain is:
```
feedEvidenceId → candidateSelectionReceipt → openCardEvidenceId → detailDumpEvidenceId → openProfileEvidenceId → profileEvidenceId
```

## Failure terminal cleanup

| Failure point | Cleanup |
|---------------|---------|
| feedCards returns 0 cards | Typed NO-GO. No reservation consumed. DiscoveryRun continues (may retry with scroll). |
| openCard fails (no NoteDetail/DetailFeed) | Typed abort for this transition. Restore to feed. Run may try another candidate. |
| Detail author avatar not found | Typed NO-GO for this candidate. Restore to feed. Run may try another candidate. |
| Profile overlay not detected after avatar tap | Typed navigation failure. Restore to feed. |
| Profile identity ambiguous (missing composite fields) | Typed NO-GO. Terminal for this candidate. |
| Effect Firewall blocks surface | Typed DISCOVERY_SURFACE_BLOCKED. Terminal abort + restore + release. |
| Snapshot >5s stale at any step | Typed SNAPSHOT_STALE. Re-capture or abort. |
| Lease/epoch mismatch, Grant revocation, flag/ADR close mid-run | Terminal abort + restore + release. Zero adapter call after gate closure. |
| Any social-effect surface detected | Terminal abort. Audit event with surface classification. |

## Restart no replay

After crash/restart:
1. Reopen StateStore reads the DiscoveryRun row. Status = running.
2. Existing reservations (intent_recorded) are preserved. Producer re-reads them.
3. Producer checks: has this reservation already produced a receipt? (via `getDiscoveryProducerReceiptForReservation`)
4. If receipt exists → skip, move to next step.
5. If receipt missing → the reservation intent was recorded but the job never completed → typed DISCOVERY_RECEIPT_UNAVAILABLE → terminal abort.
6. NEVER replay a job whose reservation exists without a receipt (the idempotency key prevents duplicate job creation).

## Zero adapter on mismatch

Before EVERY adapter call (dump, tap, screenshot), the producer asserts:
1. Active lease/session/controllerEpoch/discoveryRunId ownership = this DiscoveryRun
2. Grant hash unchanged from open time
3. Both flags true, ADR gate true, issuer healthy
4. Canonical readiness/freshness: snapshot ≤5s old
5. Own lease is valid; foreign/missing/expired/mismatched → zero adapter, terminal abort

If ANY assertion fails, zero adapter call, zero job creation, durable restore/release/terminal abort.

## Minimal TDD file list and commands

### New test file: tests/discovery-producer-feed-profile.test.mjs

| # | Test | Red command | Expected |
|---|------|-------------|----------|
| 1 | Producer requires active DiscoveryRun (status=running) | `node --test tests/discovery-producer-feed-profile.test.mjs` | FAIL: producer absent |
| 2 | feedCards on non-feed surface → typed NO-GO, zero job | same | FAIL |
| 3 | Full feed→profile happy path: all 7 steps succeed, sealed lineage verifiable | same | FAIL |
| 4 | openCard fails → typed abort, restore to feed, run continues | same | FAIL |
| 5 | Profile overlay not detected → typed navigation failure, restore | same | FAIL |
| 6 | Identity composite missing (no avatar contentDesc) → typed NO-GO, terminal | same | FAIL |
| 7 | Firewall blocks social-effect surface mid-navigation → terminal abort | same | FAIL |
| 8 | Snapshot >5s stale → SNAPSHOT_STALE, re-capture or abort | same | FAIL |
| 9 | Lease/epoch mismatch mid-sequence → zero adapter, terminal abort | same | FAIL |
| 10 | Grant revocation mid-sequence → zero adapter, terminal abort + restore + release | same | FAIL |
| 11 | Restart after crash: existing reservation without receipt → typed abort, no replay | same | FAIL |
| 12 | Idempotent replay: exact same primitive → returns original reservation, no duplicate job | same | FAIL |
| 13 | Changed replay: same primitive, different args → typed conflict | same | FAIL |
| 14 | Public receipt projection: no raw authorName, avatarContentDesc, dump XML, screenshot bytes | same | FAIL |
| 15 | feed authorName ≠ profile displayName → typed identity mismatch, terminal | same | FAIL |

### Modified test file: tests/discovery-session.test.mjs

| # | Test | Notes |
|---|------|-------|
| 16 | Producer wired into executeDiscoveryPrimitive for "dump"+"screenshot"+"tap" primitives | Extension of existing: producer absent → DISCOVERY_PRODUCER_UNAVAILABLE |

### Existing dirty red test: tests/control-plane-adapters.test.mjs

- Line 56-72: `default production R0 XHS capabilities emit a controlled Discovery receipt` — PRESERVE UNCHANGED. This test covers the adapter→receipt boundary (Task 3 scope), not the producer design.

### Green command (after implementation)

```bash
node --test tests/discovery-producer-feed-profile.test.mjs tests/discovery-session.test.mjs tests/discovery-session-state.test.mjs tests/control-plane-placement.test.mjs
```

### Commit points (after implementation, NOT in this design task)

1. `feat(discovery): define feed-to-profile producer schema and receipts`
2. `feat(discovery): implement capture-only feed→profile navigation producer`
3. `feat(discovery): wire producer into executeDiscoveryPrimitive`
4. `test(discovery): cover feed→profile producer lifecycle and failure modes`

## Stop rules (producer-level, in addition to ADR gate matrix)

| Rule | Condition |
|------|-----------|
| S1 | No R0 producer installed for required primitive → DISCOVERY_PRODUCER_UNAVAILABLE |
| S2 | Controller account identity not independently confirmed → accountFingerprint = null, identityEvidenceHash uses profile-only composite |
| S3 | stableUserId not parseable from UI → fallback to composite |
| S4 | Composite missing any required field (displayName, avatarContentHash, profileFingerprint) → typed NO-GO |
| S5 | Composite ambiguity=true (two profiles with identical composite) → typed NO-GO, collision audit |
| S6 | Navigation transition lands on non-R0 surface → typed DISCOVERY_SURFACE_BLOCKED |
| S7 | Any social-effect button in tap proximity → typed abort for that transition |
| S8 | identity-mismatch (feed authorName ≠ profile displayName) → typed NO-GO |
| S9 | Raw dump/screenshot bytes NEVER in public receipt → redaction enforced at serialization boundary |
| S10 | Default primitive map stays {} until independent review + runtime TDD all green |

## ADR impact

### ADR 0010 (no change needed; stays Proposed)

The existing ADR already defines:
- allowedPrimitives including screenshot, dump, tap (navigation)
- seed_profile_relation as a valid anchor→relation pair
- Composite identity fallback
- 5s snapshot freshness

This design is a conforming implementation strategy. No ADR text change required.

### DiscoverySession Design (minor addition)

Add to section "No-effect producer and firewall": a sub-section "Feed→Profile Navigation Producer" summarizing:
- The 7-step sequence within one DiscoveryRun
- The capture-only constraint (no follow/DM button tap)
- The identity composite fallback
- The navigation transition verification

### Implementation Plan (minor addition)

Add to Task 3 (R0 producer): explicit mention that the feed→profile producer is the first wired producer, with the receipt schemas defined in this design. The producer map starts as `{}` and becomes `{ "feed-to-profile": feedToProfileProducer }` only after independent review and TDD green.

## Deferred

- Multi-candidate feed scroll (current: single candidate)
- Cross-device discovery (parallelism=1 only)
- Registry-backed controller account proof (Luna NO-GO; requires separate design)
- Automatic strategy C (explicit targets remain the initial collect-only fallback)
- Avatar screenshot cropping precision (MVP: full profile overlay screenshot; crop region TBD)
- OCR-based display name extraction (current: contentDesc only)
- Profile statistics delta-tolerance for re-identification (current: exact match)

## Signature

Design by independent reviewer (slot 019fb1f5), 2026-07-30. Read-only design phase. No code written, no tests modified, no device touched, no Grant/flag/push.
