# APP exploration records

Exploration and API promotion are separate changes.

1. Create one dated record from `TEMPLATE.md`.
2. Store only sanitized observations and small deterministic fixtures in Git.
3. Keep screenshots, UI dumps, OCR output, device identifiers, accounts, and secrets in the runtime evidence directory.
4. A real-device one-off is E1. Repeatability is E2. CLI, tests, restoration, and fail-closed behavior are E3. A registered control-plane API is E4.
5. Every API PR links its exploration PR and declares the capability risk, verification, restoration, and approval policy.
6. **The structured run/effect/evidence bundle is the source of truth** — a Markdown record is only a human-facing view over it, never a substitute. A record that cannot name its run ID, effect IDs, and evidence hashes is not done (REX Phase 5 B6a).

Do not convert the legacy D0-D5 values numerically. Reassess each capability from its evidence.
