# ADR 0003: SQLite state with JSONL and hashed evidence

- Status: accepted
- Date: 2026-07-24

## Decision

SQLite stores registry, jobs, leases, sessions, approvals, idempotency fingerprints, events, and evidence indexes. JSONL mirrors the per-run event stream. Binary and UI evidence is stored outside Git and referenced by SHA-256.

The implementation uses `node:sqlite` behind `StateStore`, pins the verified Node runtime, runs a startup compatibility check, and marks in-flight jobs `recovery_required` after restart.

## Consequences

No completed or ambiguous action is replayed from memory after a process restart. The storage adapter can be replaced without changing the public control API.
