# Agent device entry

This is the mandatory front door for every agent that needs to inspect or
operate a phone. Do not select a private runtime ID and do not call a device,
APP operator, port `22222`, or legacy UI route directly.

The production checkout is `C:\Users\Public\xhs-routing-v1-1`. The Mac
`devicectl --ssh` wrapper forwards arguments as opaque base64, so nested JSON
parameters reach Windows without PowerShell reparsing.

## 1. Inspect authority

Run from Mac through the configured SSH identity:

```bash
node control-plane/devicectl.mjs --ssh xhs-windows health
node control-plane/devicectl.mjs --ssh xhs-windows nodes
node control-plane/devicectl.mjs --ssh xhs-windows capabilities
```

The authority must be `DESKTOP-3I1EVHE`. A capability whose `availability`
starts with `dependency_pending` is not routable.

## 2. Preview a route

`route plan` is advisory and creates no job, lease, reservation, run directory,
or event:

```bash
node control-plane/devicectl.mjs --ssh xhs-windows route plan \
  --actor agent-a \
  --capability xiaowei.device.list
```

Optional selectors are `--device`, or the compatible combination of `--node`,
`--physical-label`, and repeated `--require-tag`. `--device` cannot be combined
with the other selectors.

The result is:

- `dispatchable`: the selected device has no active or pending work.
- `queue`: the job will enter the selected device's FIFO.
- `blocked`: inspect the stable error code and do not bypass the control plane.

## 3. Submit atomically

Omit `--device` to let the authority select and create the job in one SQLite
transaction:

```bash
node control-plane/devicectl.mjs --ssh xhs-windows job submit \
  --actor agent-a \
  --capability xiaowei.device.list \
  --idempotency-key agent-a-list-001
```

The response contains the persistent `routeDecision`, `runId`, and exact
`storage` paths. Reusing the same idempotency key with the same logical request
returns the original job and original route. Changing capability, parameters,
or selectors returns `409 IDEMPOTENCY_CONFLICT`.

## 4. Interactive exploration

Automatic sessions must declare one capability and only accept that capability:

```bash
node control-plane/devicectl.mjs --ssh xhs-windows session acquire \
  --actor explorer-a \
  --capability xiaowei.lab.raw \
  --canary
```

If every eligible device has a lease or pending job, session acquisition
returns `423 DEVICE_BUSY`; sessions never jump the queue. Heartbeat at least
every 20 seconds and always release the session. Lease tokens are credentials
and must not be copied to docs, PRs, shared logs, or shell history.

## 5. Find durable output

Every accepted job uses:

- `C:\Users\Public\xhs-agent-control\control.db`
- `C:\Users\Public\xhs-agent-runs\<runId>\manifest.json`
- `C:\Users\Public\xhs-agent-runs\<runId>\events.jsonl`
- `C:\Users\Public\xhs-agent-runs\<runId>\evidence\`

`manifest.json` records the sanitized route decision and exact storage paths.
Runtime IDs, credentials, routing profiles, and account identifiers must never
be returned by public APIs or committed to Git.

External communication, publishing, commenting, following, deleting, login,
payment, and account changes still require the confirmation rules in
`AGENTS.md`. Route assignment is resource authority, not action authorization.

## 6. Operator hard gate and concurrency

The control plane passes a short-lived lease credential to an APP adapter. A
gateway operator must authorize that credential against the loopback control
plane before its first device request. Authorization is bound to all three of:

- lease ID and token;
- public control-plane device ID;
- private runtime serial selected by the control plane.

A lease for one phone cannot authorize another phone. Lease credentials remain
in child-process environment only; do not put them in argv, JSON output,
evidence, docs, or logs.

Different agents may hold leases for different phones and their jobs may
advance concurrently. Xiaowei port `22222` is one shared transport, so every WS
request also uses the cross-process transport lock. This serializes only the
short gateway request, not the whole multi-step phone job.

Direct `GatewayOperator.start()` without a valid lease fails closed. The only
lab exception requires both `XHS_ALLOW_BYPASS=1` and a non-empty
`XHS_BYPASS_REASON`; it emits a structured audit warning and is never a valid
production acceptance path.

## 7. Dry-run versus draft side effect

- `xianyu.publish.full_dry_run` never saves a draft and rejects
  `saveDraft:true`.
- `xianyu.publish.full_draft_dry_run` runs the full chain and saves one draft.
  It is an `external_effect` capability and enters `waiting_approval` before it
  may execute.
- `xianyu.publish.save_draft_dry_run` remains the narrow save-only effect.

No capability in this group may tap the final publish action.

## Deployed code is authoritative + policy doc debt (REX Phase 6)

Authority order: **deployed release code + live agent-entry/task packet** > top-level
AGENTS / modes / skills routing docs > not-yet-migrated app sub-skill Markdown.

- Read the **Release / runtime policy** block of this live entry before any device task:
  `ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/agent-entry.md'`
  (JSON: `GET http://127.0.0.1:17930/api/agent-entry` → `release`).
  Fields: `releaseId / runtimePolicyVersion / effectiveDecisionSource / policyMode /
  evidenceMode / policyDocDebt`.
- `policyDocDebt` only reminds which stale docs are not yet migrated; it never blocks a
  task. If a stale doc listed there says "requires approval" but the current release
  policy / task packet has superseded that rule, the release wins.
- Neither this contract nor any stale sub-skill text may widen the one hard gate: a real
  money final commit waits for human confirmation with transport held at 0.

## Repair Inbox (source-only; not a device front door)

Ordinary capability Skills explain **how to run** a capability. The Repair Inbox
decides **what to fix now**. Do not hardcode a dynamic `proposalId` into those
capability Skills, and do not edit root `skills/SKILL.md` from this lane.

Before any Windows source repair claim:

```powershell
cd C:\Users\Public\xhs-routing-v1-1
node scripts/repair-inbox.mjs list
node scripts/repair-inbox.mjs discover --expect-id repair_ff7fc51b35aec35227cf5eb6
```

Query surface (reused, no new service/DB/panel): registry
`GET /api/knowledge?appliesTo=repair-proposal-v1&lifecycle=backlog` plus client-side
`needsEngineer=true`. The inbox validates the full repair contract, canonical hash,
Skill binding, allowlist/forbidden paths, and secret scan, then may hand off to the
existing repair consumer.

- Default = read-only `list` / `discover` (no claim, no outbox write, no phone/job).
- Claim requires explicit `--i-understand-claim`. After claim: heartbeat, source fix,
  source checkpoint / completion bundle only; stop at `source_review`.
- Windows must not self-approve, modify Mac verdict, mark deployable, deploy, replay,
  submit job/session, or operate phones.

Skill contract: `skills/repair-inbox/SKILL.md`.
Consumer contract: `docs/handoffs/2026-08-02-windows-repair-consumer-contract.md`.
