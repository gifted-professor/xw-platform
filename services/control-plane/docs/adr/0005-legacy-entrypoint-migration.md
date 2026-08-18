# ADR 0005: Gradual enforcement of the control plane

- Status: accepted
- Date: 2026-07-24

## Decision

Legacy dashboard, `17910/17911`, fast-operator serves, and direct Xiaowei calls are first wrapped as adapters. Calls without a lease are audited during canary. After one stable acceptance cycle, direct UI routes are blocked by default.

Raw vendor actions remain available only through a canary lab session with an exclusive lease, validation, and evidence. The old dashboard becomes a read-only client of the control API.

## Consequences

Existing experiments can migrate without a flag day, but the end state has one authority and no silent bypass.
