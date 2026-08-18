# ADR 0004: E0-E4 maturity separated from R0-R3 risk

- Status: accepted
- Date: 2026-07-24

## Decision

Maturity is E0 observed, E1 one-off, E2 repeatable, E3 CLI/tested/fail-closed, and E4 registered API. Risk is R0 observation, R1 reversible UI change, R2 external effect, and R3 destructive/account/system change.

E0/E1 are canary lab-only. E2 R0/R1 may run automatically. R2/R3 require human approval regardless of maturity under the repository safety rules. Missing verification or restoration fails closed.

## Consequences

A well-tested capability does not silently become authorized. Legacy D0-D5 values are manually reassessed rather than numerically mapped.
