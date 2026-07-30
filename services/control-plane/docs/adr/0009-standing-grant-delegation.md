# ADR 0009: Standing Grant delegation

- Status: Proposed
- Date: 2026-07-30

## Decision

A Standing Grant is a durable, immutable parent authorization for bounded,
single-device Missions, never a lease, actor label, recipe, or credential.
Only an offline Ed25519 signature for `user:a1234`, verified against a
Windows-administrator-installed versioned public-key allowlist, may issue or
revoke it. The private key stays offline; no endpoint generates, signs, exports,
rotates, or recovers keys.

Each grant binds immutable id, issuance nonce, hash, scope, budget, and status.
Exact signed-byte replay is idempotent; a changed nonce replay conflicts; a
revoked id/hash cannot reactivate. Permanent grants use `expiresAt: null`; every
child Mission is finite and cannot outlive a finite parent. Both feature flags
default off and then allocate no run, session, lease, heartbeat, effect, or
approval.

Key rotation/recovery is an out-of-band human/admin ceremony: disable flags,
install a new allowlist version, revoke the old key, restart fail-closed, and
reconcile its grants before adapters run. Multi-device fan-out is out of scope.
