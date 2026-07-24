# Agent device entry

This is the mandatory front door for every agent that needs to inspect or
operate a phone. Do not select a private runtime ID and do not call a device,
APP operator, port `22222`, or legacy UI route directly.

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
