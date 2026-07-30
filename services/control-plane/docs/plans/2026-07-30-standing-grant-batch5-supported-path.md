# Standing Grant Batch5 Supported Path

- Status: implementation candidate; offline verified only
- Baseline: `7bf03099444aa356b00dd97ffcaf3b3771c60908`
- ADR 0009 / ADR 0010: remain Proposed. This change does not accept either ADR or enable a feature flag.

## Authority chain

1. A normal control-plane `xhs.observe.note_detail` job produces a sealed, evidence-backed receipt.
2. `grant prepare` accepts only the opaque job/receipt IDs. The server re-reads the succeeded job and evidence, rejects a caller target, derives one explicit fingerprint, forces collect-only scope and `discoveryPolicy.enabled=false`, and returns canonical signing bytes.
3. `user:a1234` signs those exact bytes offline. No private key enters the repo, CLI, control plane, evidence, or logs.
4. `grant install` verifies the signature against the administrator-installed allowlist. Install/list/show responses redact account, target, issuer key ID, nonce, and proof material.
5. `mission collect-canary` rechecks the signed target, opens one server-owned DeviceRun, re-observes within that fenced session, mints a fresh receipt, executes the collect through ECP, verifies it, invokes the capability restoration (undo plus feed), terminalizes the Mission, and releases its lease.
6. A durable one-time marker blocks a second collect after success or ambiguity. Signed `grant revoke` is the final authority cleanup.

## Commands

All commands use the normal `devicectl --ssh xhs-windows` transport and the live agent-entry checkout.

```text
grant prepare --job <observeJobId> --receipt <opaqueReceiptId> --draft <json> --allowlist-version <n>
grant install --envelope <signed-json>
grant list
grant show --grant <grantId>
mission collect-canary --actor user:a1234 --idempotency-key <key> --grant <grantId> --job <observeJobId> --receipt <opaqueReceiptId>
grant prepare-revoke --grant <grantId> --revocation-nonce <nonce> --reason canary_complete --allowlist-version <n>
grant revoke --grant <grantId> --envelope <signed-revocation-json>
```

`grant install` and `grant revoke` never accept unsigned input. Revocation signing bytes use kind `delegation_grant.revoke.v1` and bind grant ID/hash, revocation nonce, reason, allowlist version, and subject.

## Gates and terminal behavior

- `MISSION_AUTO_APPROVAL_ENABLED` and `STANDING_GRANT_ENABLED` remain false by default.
- A live Mission allocation still requires both flags plus accepted ADR 0008 and ADR 0009. With ADR 0009 Proposed, live execution remains blocked even when tests inject accepted gates.
- Payment, publish, and delete remain outside this path. The ceremony forces one action: collect.
- An ambiguous collect is never retried. The marker becomes `ambiguous`, restoration runs, the DeviceRun is terminalized, and the owned lease is released.
- No endpoint exposes a session token, lease token, private runtime ID, private signing key, raw target draft, or bypass route.

## Offline verification

```text
node --test tests/standing-grant-supported-path.test.mjs tests/standing-grant-canary-state.test.mjs tests/delegation-grant-runtime.test.mjs tests/xhs-collect-standing-grant.test.mjs tests/capability-registry.test.mjs
npm test
npm run check
git diff --check
```

Deployment, flag changes, signer ceremony, and the real-device canary are separate reviewed operations.
