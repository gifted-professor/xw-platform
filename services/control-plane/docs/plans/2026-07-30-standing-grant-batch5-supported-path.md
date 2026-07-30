# Standing Grant Batch5 supported path

- Status: offline verified only
- Baseline: `7bf03099444aa356b00dd97ffcaf3b3771c60908`
- ADR 0009 remains Proposed; both feature flags remain OFF by default.

Batch5 is acceptance scaffolding for the first real collect canary, not the future authorization model. The durable `standing_grant.first_collect` marker and explicit-target/collect-only constraints are deliberately named and scoped as canary-only. They must not be reused to require per-target human signatures, per-step approval, or restricted exploration in the future scoped-Grant model.

## Supported authority chain

1. An already signed Grant is installed through `POST /control/v1/grants`; the existing `TrustedHumanIssuer` and `DelegationGrantRuntime.issue` verify it.
2. `grant list` and `grant show` expose redacted status only. There is no receipt-to-Grant producer, `grant prepare`, or ADR 0010 discovery path in Batch5.
3. `mission collect-canary` consumes an active signed Grant plus an existing sealed note-detail receipt, runs observe -> collect -> verify -> undo -> feed inside one owned DeviceRun, then terminalizes the Mission and releases its lease.
4. The server marker blocks every second attempt with `CANARY_ALREADY_COMPLETED` until an explicit audited terminal-marker clear.
5. `grant revoke` is an audited administrative operation on the already trusted runtime; it does not introduce a second signing protocol.

## Commands

```text
grant install --envelope <signed-json>
grant list
grant show --grant <grantId>
mission collect-canary --actor <actor> --idempotency-key <key> --grant <grantId> --job <observeJobId> --receipt <opaqueReceiptId>
grant revoke --grant <grantId> --actor <actor> --reason <reason>
```

## Terminal and access behavior

- Successful and ambiguous effects retain the marker; ambiguity is never retried automatically.
- A pre-effect blocked attempt releases its reservation, so a gate failure does not consume the one-time canary.
- Terminal cleanup stops heartbeat, terminalizes the DeviceRun, revokes the child Mission, and deletes the owned session and lease.
- Canary evidence persists under normal Mission retention (no automatic purge) and is denied unless a server-owned authenticated owner/reviewer authorizer allows it. Request `role` is ignored.
- Payment, publish, and delete are not authorized. The existing Grant schema remains compatible with future time/device/action/budget scopes and an explicit payment deny.

See `2026-07-30-phase1-acceptance-checklist.md` for 5.1-5.8 and A1-A7 evidence.
