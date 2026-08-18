# ADR 0008: Mission-driven exploration authorization and capability compounding

- Status: Accepted
- Date: 2026-07-29

## Acceptance record

- authorized human: `user:a1234`
- acceptedAt: `2026-07-30 Asia/Shanghai`
- testing authority: all four devices; runtime selection remains canonical `ready + free` only.
- prohibited: payment and publish.
- hard stops: captcha, login, risk-control, unknown surface, identity mismatch, and ambiguous outcome.
- delete is outside the first canary scope.

This record accepts the authorization design; it does not enable the runtime feature flag,
deploy the candidate, or authorize a live external effect.

## Context

The current control plane has strong resource and audit boundaries:

- Windows is the sole authority (ADR 0001).
- Device leases and the short Xiaowei transport lock serialize resources (ADR 0002).
- SQLite, JSONL events, and hashed evidence provide durable state (ADR 0003).
- Maturity and risk are separate (ADR 0004).
- Direct legacy routes are migrating behind the control plane (ADR 0005).
- Placement and job creation are atomic (ADR 0006).
- Recovery inspection remains evidence-bound and fail-closed (ADR 0007).

The implemented authorization model treats R2/R3 as requiring per-job human approval. That is too coarse for a user-authorized Mission containing bounded follows, likes, collections, comments, messages, or batches. It also prevents an exploratory agent from composing sanctioned primitives when the target is known but the UI path is not yet a registered whole capability.

The user has decided that authorization should be freedom-first:

- a trusted user command authorizes one Mission;
- bounded social effects inside its target, count, frequency, account, and validity scope do not require per-effect approval;
- payment is the only non-overridable permanent human commit gate;
- publish and delete require confirmation by template default, but a Mission may explicitly allow them;
- success should compound into reusable capability, and failure should become durable learning evidence.

This ADR records the target decision. It does not claim that current code, `AGENTS.md`, `docs/SAFETY.md`, or live deployment already implements it.

## Decision

Adopt an immutable, versioned **Mission Policy** as the action-authorization authority for Mission-driven execution.

A Mission Policy binds issuer provenance, app/account scope, allowed actions, target rules, total and per-target effect limits, frequency, validity, publish/delete policy, idempotency namespace, and evidence/redaction policy. It receives a stable `missionId`, version, and `missionHash`. Any material expansion creates a new version and hash.

### Authorization precedence

```text
non-bypassable platform/system boundary
> explicit Mission Policy
> Mission template default
> Recipe recommendation
```

1. Payment always waits for explicit human confirmation. No Mission, template, Recipe, maturity level, or Agent may lower this gate.
2. Publish and delete wait by default. A trusted user may explicitly set them to `allow_within_scope`; then the runtime does not ask for each effect.
3. Follow, like, collect, comment, and message may execute automatically within an explicit Mission scope, including bounded batches.
4. CAPTCHA, login challenge, identity loss, platform restriction, risk-control warning, and loss of device control remain stop conditions. They are execution-legality and correctness constraints, not ordinary approval gates.
5. A Recipe never carries authority from an earlier Mission and never expands a later Mission.

### Separate authorization, correctness, and maturity

The system SHALL keep three independent decisions:

- **Authorization:** Is the action inside the immutable Mission Policy?
- **Correctness:** Are device, account, page, target, budget, lease, and effect boundary correct and unambiguous?
- **Maturity:** Is the implementation proven in the current validity envelope?

Passing correctness does not create authorization. High maturity does not create authorization. A correctness failure terminates or blocks execution; it does not silently become a request for broader permission.

### Two lanes, one effect protocol

The runtime SHALL support a deterministic Workflow Lane for Typed Actions and stable Workflows, plus an Exploration Lane using a Mission-bound Session and sanctioned primitives when the path is unknown.

Exploration primitives may include inspect, dump, screenshot, launch, back, tap, swipe, input, and registered App actions. They remain behind the control-plane Session API and require an exclusive visible lease, actor binding, heartbeat, schema validation, durable events, and evidence.

“Open primitives” does not authorize direct ADB, direct 22222, private runtime selection, arbitrary HTTP/shell, or any lease-free operator. A lab bypass never counts as production acceptance.

Both lanes SHALL use the same Mission Policy, budget ledger, idempotency, effect protocol, evidence, restoration, and ambiguity rules. Switching lanes cannot reset scope, count, rate, or effect history.

### Effect Firewall and intent envelope

Risk is decided by the fresh **observed surface** (with `declaredIntent` treated only as an untrusted hint), not by primitive type. Every primitive call, including raw `tap`, `swipe`, and `input`, SHALL carry an effect-intent envelope `{snapshot, target, declaredIntent}`. The Effect Firewall resolves the intent:

- reversible navigation/observation intents (navigate-back, screenshot, dump, launch) run automatically;
- in-scope social intents (follow/like/collect/comment/message) run through the Effect Commit Protocol automatically, with no human wait;
- a `publish` intent runs through the Protected Human Commit when the Mission has not explicitly released it, and through the ECP automatically when released;
- a `payment` intent ALWAYS enters the Protected Human Commit (`waiting_authorization`), approved per time by a real user, never automatic — this is not "permanent block", it is waiting for per-time human release;
- an out-of-scope intent (action/target outside the Mission scope) produces `SCOPE_VIOLATION` → `blocked`/`failed`, with no approval request and no `waiting_authorization`.

A raw `tap` landing on a publish/payment button (declared intent publish/payment, or snapshot-inferred external effect) is forced through the ECP/PHC. **Raw tap cannot bypass payment or the Protected Human Commit.** An intent inconsistent with the snapshot/target is `INTENT_MISMATCH` and fails closed.

### Effect commit protocol

Every external effect SHALL have a stable `effectId` and idempotency key. Before execution the runtime SHALL:

1. validate active Mission version/hash and revocation;
2. validate action, target, account, count, frequency, and validity;
3. validate canonical readiness, lease/runtime binding, current App/account, target identity, page fingerprint, and before-state;
4. atomically reserve Mission budget and persist effect intent;
5. persist `effect_started` before invoking the effect;
6. verify after-state and store evidence.

A definitely-not-sent pre-effect failure may use a bounded retry. If an effect was or may have been sent, budget is consumed, the effect is `ambiguous` unless verified, and automatic retry is forbidden. UI restoration does not undo an external effect.

The protocol distinguishes two layers:

- **Effect Commit Protocol (ECP)** applies to EVERY external effect and is automatic: scope check (out-of-scope → `SCOPE_VIOLATION` → blocked/failed, no approval), correctness recheck, atomic ledger, execute, verify. In-scope follow/like/collect/comment/message run the ECP end-to-end with no human wait.
- **Protected Human Commit (PHC)** applies ONLY to payment (always) and to publish/delete when the Mission has not explicitly released them. After ECP scope+correctness pass, the runtime does not execute; it enters `waiting_authorization` and requires a real user to approve **per time**, then rechecks before execute. Payment is always PHC and never automatic (it is per-time human release, not permanent block). Publish/delete skip PHC and run the ECP automatically once the Mission explicitly releases them.

A scope or correctness failure is `blocked`/`failed` and MUST NOT be disguised as a human authorization expansion or approval request. Only payment and unreleased publish/delete enter `waiting_authorization`.

### State semantics

The runtime SHALL distinguish phase from outcome.

- User revocation produces terminal `cancelled`; it is not a resumable pause.
- Pre-effect control loss may produce `paused_control_lost`; resume requires full revalidation.
- Post-effect control loss or unknown after-state produces reconciliation/`ambiguous`; it cannot auto-resume the effect.
- Scope, target, identity, readiness, page, or budget failure produces `failed/blocked`, not an authorization prompt.
- Payment, and publish/delete when not explicitly allowed, produce `waiting_authorization`.
- Restoration occurs before terminal completion where possible; the model must not become terminal `cancelled` and then attempt restoration.

### Capability compounding

After one verified success, an implementation may be reused inside the same Mission and validity envelope. This reuses implementation, not effect; each effect still requires a new record, budget reservation, identity check, and verification.

After two independent verified successes, a Recipe may become globally reusable. Independence requires distinct runs and effect IDs and SHOULD cover different time or device/layout conditions. Bypass, ambiguous, unverified, or manually pre-positioned runs do not count.

Global reuse means a future Mission may select the Recipe. It does not transfer earlier authorization. Drift outside the Recipe validity envelope demotes it for revalidation.

Recipe Candidate auto-reuse is NOT manifest/permission change: ≥1 success enables Mission-local auto-reuse of the recipe path; ≥2 independent successes make a globally selectable Candidate (a Candidate Resolver selects it for future Missions of the same shape). This auto-reuse SHALL NOT automatically modify any Typed Action manifest, maturity, or risk (Typed Action productization promotion is a separate engineering step requiring human confirmation), SHALL NOT expand Mission authorization (it does not change scope/policy and remains bound by the Effect Firewall and ECP/PHC), and SHALL NOT replay an effect (reuse reruns a controlled recipe path; it does not replay an existing effect record).

Success and failure observations are durable. Failures refine preconditions, selectors, stop conditions, fixtures, and recovery; they do not increase maturity.

### Canonical control and readiness

Mission authorization is not resource authority or device-health proof. Placement, lease acquisition, operator authorization, and final pre-effect checks SHALL use one canonical readiness contract with a freshness threshold.

If Registry and Control Plane readiness disagree, execution fails closed. A device known as not ready may not be selected merely because a Mission authorizes the action.

### Control hierarchy: Mission → DeviceRun → Session + Lease

The runtime SHALL maintain the hierarchy:

- A **Mission** (authorized by a trusted user command) may span multiple **DeviceRuns**.
- A **DeviceRun** is one device's execution within a Mission and **owns the lease** (the lease belongs to the DeviceRun, not a bare top-level job). Sessions open inside a DeviceRun.
- Device selection and lease acquisition SHALL be atomic in one transaction (extending ADR 0006's atomic placement to "placement + lease"), eliminating the time-of-check/time-of-use gap between choosing and occupying a device.
- A workflow/DeviceRun runner SHALL auto-heartbeat its lease server-side (not dependent on external heartbeat); a Session that is not runner-managed still respects the ≤20s heartbeat expectation.

### Controller fencing and handoff

Each DeviceRun SHALL record `controller_agent` (must be a Mission-authorized controller) and a monotonically increasing `controller_epoch`.

- **Hard invariant — complete fencing tuple:** every control command SHALL carry `{missionId, deviceRunId, sessionId, controllerAgent, controllerEpoch}` (plus `jobId` when the command concerns a job). The runtime SHALL verify each element against the current DeviceRun binding and **reject on any mismatch** (`MISSION_MISMATCH`/`DEVICE_RUN_MISMATCH`/`SESSION_MISMATCH`/`CONTROLLER_NOT_AUTHORIZED`/`EPOCH_MISMATCH`). A command without the complete tuple SHALL not execute. A token does not replace the tuple and does not enter fields outside the tuple.
- **Fencing:** a command MUST carry the current epoch and a controller in the Mission-authorized set, else `EPOCH_MISMATCH`/`CONTROLLER_NOT_AUTHORIZED` — a disconnected or stale controller cannot keep issuing commands.
- **Handoff:** a DeviceRun may be handed off between controllers by incrementing the epoch, switching `controller_agent`, and emitting a `controller_handoff` audit event. Handoff does not drop the lease, but the new controller MUST recheck the live state before acting; old-epoch commands become invalid.

### Panel display

The human panel (registry 17930) SHALL display Mission/DeviceRun/Effect state (Mission active/paused/cancelled and scope progress; DeviceRun running/waiting_authorization/paused/ambiguous/blocked with controller; effect ledger counts and budget). **The panel/API handles ONLY Protected Human Commits (payment and unreleased publish/delete) per time — it does not approve the whole Mission and does not approve per job.** Scope/correctness failures display as blocked/failed and offer no "expand authorization" action.

### Concurrency default

The default parallelism is 1 (a single device, a single DeviceRun). A Mission MAY declare `parallelism=N`; the scheduler then opens up to N DeviceRuns on N ready devices, subject to per-device lease serialization (ADR 0002) and shared atomic budget. Multi-device Mission concurrency does not equal transport concurrency.

### Privacy

Mission text, targets, comments, messages, contacts, account identifiers, screenshots, and UI dumps are sensitive by default. Public views expose only aliases, fingerprints, counts, states, and evidence hashes. Tokens, runtime IDs, credentials, private text, and local paths are never public or committed.

Recipes contain redacted fixtures and contracts, not bearer authorization or real Mission data. Cloud vision receives only the minimum permitted crop and never receives login codes, contacts, private messages, payment content, or unpublished private content by default.

## Minimum durable model

The implementation SHALL provide equivalent durable concepts for:

- `missions`: versioned policy, hash, issuer, status, validity, revocation;
- `device_runs`: lane, actor, device, job/session/lease references (the lease is owned by the DeviceRun), `controller_agent`, `controller_epoch`, phase and outcome;
- `mission_effects`: effect ID, idempotency key, target fingerprint, budget reservation, before/after, ambiguity and evidence;
- Mission events and evidence indexes;
- `recipes` and success/failure observations with versioned validity envelopes.

Exact table names are not fixed. Atomic budget reservation and effect intent persistence are required semantics.

## Consequences

### Positive

- A user authorizes a bounded Mission once instead of approving every social effect.
- Unknown UI paths can be explored without a control-plane bypass.
- Permission, correctness, and maturity become independently auditable.
- One effect ledger supports deterministic Workflows and dynamic Sessions.
- Success and failure compound into evidence-backed capability.
- Payment remains impossible without human confirmation.

### Negative

- Mission compilation, budget accounting, revocation, and reconciliation add state and test complexity.
- Missing target/count/rate/account/validity requires templates or one-time clarification.
- Open primitives increase the importance of scope checks and prompt-injection resistance.
- Publish/delete behavior depends on a versioned template and explicit clauses.
- Existing approval, job, and session state machines require migration.

### Neutral

- Existing leases, 22222 short lock, Windows authority, evidence, recovery, and atomic placement remain valid foundations.
- R0-R3 remains useful descriptive risk metadata, but no longer alone decides Mission authorization.
- Whole capabilities remain valid when clearer than composition.

## Compatibility and migration

This ADR is **Accepted**. Acceptance records the authorization design only; implementation, independent verification, deployment, feature-flag enablement, and live confirmation remain separate gated steps.

If implemented, this ADR supersedes only ADR 0004's blanket authorization sentence for Mission-governed actions. ADR 0004's maturity/risk separation remains valid. ADRs 0001-0003 and 0005-0007 remain in force.

Migration SHALL be additive and staged:

1. define Mission, effect, state, readiness, and redaction schemas;
2. implement read-only compile/plan/status and policy replay tests;
3. bind R0/R1 Exploration Sessions to Mission + lease + evidence;
4. implement atomic effect ledger and revocation;
5. enable bounded follow/like/collect/comment/message Missions;
6. validate publish/delete overrides and permanent payment gate;
7. enable Recipe compounding only after independent verifier acceptance;
8. update old rules and documentation in a separate explicit migration.

This ADR does not authorize live deployment, device testing, or edits to existing rules by itself.

## Required acceptance properties

- Mission-scoped social effects do not request per-effect approval.
- Out-of-scope action, target, account, count, rate, or validity fails closed.
- Payment cannot be enabled by Mission, template, Recipe, Agent, or maturity.
- Publish/delete default to confirmation and honor an explicit bounded override.
- Revocation prevents new primitives/effects and cannot resume under the old Mission.
- Pre-effect control loss pauses; possible post-effect loss is ambiguous and never auto-retried.
- Concurrent workers cannot exceed a shared Mission budget.
- One device has one visible lease; authorization stays bound to device/runtime.
- Registry/Control Plane readiness disagreement blocks placement/effect.
- One success permits only Mission-local implementation reuse; two independent verified successes permit only Recipe availability, never authority transfer.
- Success and failure evidence is durable and redacted.
- Restart does not replay an in-flight or ambiguous effect.

## Alternatives considered

### Keep blanket R2/R3 per-job approval

Rejected as the target because it contradicts bounded Mission authorization and prevents efficient batches and exploration. It remains migration-time live behavior until implementation.

### Treat a lease or route decision as action authorization

Rejected. A lease grants exclusive resource control, not permission for an external effect.

### Allow unrestricted Agent scripting after Mission start

Rejected. Mission freedom is bounded composition through the control plane, not direct shell, ADB, 22222, private runtime, or arbitrary network access.

### Let Recipe maturity grant permission

Rejected. Maturity describes implementation evidence; only the current Mission grants authority.

### Retry unknown effects for availability

Rejected. Duplicate follows, messages, comments, publishes, or deletes are worse than a visible ambiguous stop.

## References

- `AGENTS.md`
- `docs/SAFETY.md`
- `docs/agent-entry.md`
- `docs/adr/0001-windows-authority-and-ssh-cli.md`
- `docs/adr/0002-two-layer-resource-locking.md`
- `docs/adr/0003-durable-state-and-evidence.md`
- `docs/adr/0004-maturity-risk-and-approval.md`
- `docs/adr/0005-legacy-entrypoint-migration.md`
- `docs/adr/0006-atomic-agent-placement-entry.md`
- `docs/adr/0007-recovery-inspection-analysis-placement.md`
- `docs/plans/2026-07-29-xhs-capability-composition-runtime-blueprint.md`
- `docs/plans/2026-07-29-mission-driven-exploration-capability-compounding-design.md`
