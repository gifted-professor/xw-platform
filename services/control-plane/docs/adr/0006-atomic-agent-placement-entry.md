# ADR 0006: Atomic agent placement entry

- Status: accepted
- Date: 2026-07-24

## Context

The v1 control plane can serialize work on a caller-selected device, but an
agent must still choose `deviceId` before submission. A separate read-then-write
flow allows two agents to observe the same free phone. Future Windows nodes
also require a durable record of where and why work was assigned.

## Decision

Use the existing Windows authority and SQLite database for an atomic placement
and job-create transaction. Eligibility comes from an untracked, anonymous
per-device routing profile; routing performs no live phone probe. Automatic
jobs select the eligible device with the lowest active-plus-pending load.
Automatic interactive sessions require a completely idle eligible device.

Persist the logical placement request and sanitized route decision with the
job, include them in run evidence, and keep explicit `deviceId` as a compatible
pinned mode. Implement only local dispatch on `DESKTOP-3I1EVHE`; record
`nodeId` and dispatch mode for future nodes.

## Consequences

### Positive

- Route selection and job creation have no time-of-check/time-of-use gap.
- Replayed idempotent requests retain their original device assignment.
- Account or business affinity can be represented by anonymous local tags.
- Agents receive one entry contract and exact durable output paths.

### Negative

- The private routing profile must be maintained when capabilities or device
  roles change.
- A waiting-approval job contributes to placement load until approved or
  cancelled.
- Multi-node heartbeat and remote dispatch remain a later change.

## Alternatives considered

- Client-side plan followed by submit was rejected because it has a race.
- Short-lived reservations were rejected because expiry and token recovery add
  operational complexity without improving current single-node dispatch.
- Live probing during placement was rejected because selecting a route must not
  itself occupy or alter a phone.
