# Multi-agent device control plane v1

The control plane is the only v1 authority for UI work on `DESKTOP-3I1EVHE`.
It binds to `127.0.0.1:17920`, keeps durable state in SQLite, and writes
per-run JSONL plus hashed evidence outside Git.

## Bootstrap on Windows

Use an exact repository commit and Node.js 24.11.1.

```powershell
git rev-parse HEAD
Copy-Item config\control-plane.devices.example.json config\control-plane.devices.json
```

Edit the untracked device file. Every row needs a stable rack label, its
current private runtime ID, an anonymous `routingProfile`, and adapter metadata
such as `xhsServePort`. `routingProfile.capabilityIds` is an exact fail-closed
allowlist; dependency-pending capabilities must not be added.
The first startup assigns and persists a stable `deviceId`; changing an alias
does not expose the runtime ID through the public API.

```powershell
$env:CONTROL_PLANE_GIT_COMMIT = (git rev-parse HEAD)
$env:CONTROL_PLANE_LEGACY_MODE = "audit"
node control-plane\server.mjs serve
```

After the foreground canary passes, install an on-demand task bound to the
exact commit. Installation does not auto-start it:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File scripts\control-plane-task.ps1 -Action Install
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File scripts\control-plane-task.ps1 -Action Start
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File scripts\control-plane-task.ps1 -Action Status
```

The task uses the current interactive Windows identity so it can reach the
desktop-session Xiaowei bridge. Reinstall the task after changing the deployed
commit. Stop it only when no job is active; an interrupted job is deliberately
recovered as `recovery_required`. `Remove` is explicit and does not delete
SQLite or run evidence.

Expected runtime paths:

- `C:\Users\Public\xhs-agent-control\control.db`
- `C:\Users\Public\xhs-agent-runs\<runId>\manifest.json`
- `C:\Users\Public\xhs-agent-runs\<runId>\events.jsonl`
- `C:\Users\Public\xhs-agent-runs\<runId>\evidence\`

Startup fails on a host other than `DESKTOP-3I1EVHE` unless an explicit
development override is set. The server also refuses any bind address other
than `127.0.0.1`.

## Remote entry

Run the same CLI from Mac through the configured SSH identity:

```bash
node control-plane/devicectl.mjs --ssh xhs-windows health
node control-plane/devicectl.mjs --ssh xhs-windows nodes
node control-plane/devicectl.mjs --ssh xhs-windows devices
node control-plane/devicectl.mjs --ssh xhs-windows capabilities
```

If the Windows checkout is not at the default location, set
`DEVICECTL_REMOTE_REPO` on Mac.

Preview the route without reserving a device or writing state:

```bash
node control-plane/devicectl.mjs --ssh xhs-windows route plan \
  --actor agent-a \
  --capability xhs.observe.metrics
```

Submit a low-risk job with atomic automatic placement:

```bash
node control-plane/devicectl.mjs --ssh xhs-windows job submit \
  --actor agent-a \
  --capability xhs.observe.metrics \
  --idempotency-key agent-a-metrics-001
```

Use `--device` to preserve an explicit pinned request, or use `--node`,
`--physical-label`, and repeated `--require-tag` to constrain automatic
placement. A pinned device cannot be combined with other selectors.

Watch its durable result:

```bash
node control-plane/devicectl.mjs --ssh xhs-windows job watch --job job_REPLACE
node control-plane/devicectl.mjs --ssh xhs-windows evidence show --run run_REPLACE
```

R2/R3 or otherwise external-effectful jobs remain `waiting_approval`:

```bash
node control-plane/devicectl.mjs --ssh xhs-windows approval approve \
  --job job_REPLACE \
  --actor human-reviewer \
  --reason "bounded reviewed action"
```

Publishing, commenting, messaging, following, deleting, login, payment, and
account changes always require human approval under `AGENTS.md`.

## Interactive exploration

An interactive session owns one device for 60 seconds and must heartbeat at
least every 20 seconds. An automatic session is capability-scoped and selects
only a completely idle eligible device. If all eligible devices have a lease
or pending work, it returns `423 DEVICE_BUSY`; v1.1 never preempts or jumps a
queue.

```bash
node control-plane/devicectl.mjs --ssh xhs-windows session acquire \
  --actor explorer-a --capability xiaowei.lab.raw --canary
```

Use the returned session ID and token for bounded actions. Raw Xiaowei access
is limited to the read-only allowlist and still requires a canary lease:

```bash
node control-plane/devicectl.mjs --ssh xhs-windows lab action \
  --session session_REPLACE \
  --token lease_token_REPLACE \
  --action list \
  --idempotency-key explorer-a-list-001
```

Always release the session. Token values are runtime credentials and must not
be copied to docs, PRs, logs, or shell history shared with others.

## APP adapters

- XHS uses the per-device loopback fast-operator serve and has executable E3
  observation/dry-run contracts.
- Xianyu is wired to `scripts/xianyu-operator.mjs`; its manifests accurately
  report the dependency on PR #11 until that implementation is merged.
- WeChat is wired to the local OCR operator and reports that dependency until
  the reviewed operator slice is merged. No send capability is registered.
- Xiaowei uses the shared tokenized `xw-ws-22222.lock`; raw access is
  canary-only and allowlisted.

Adapters must implement `execute`, `verify`, and `restore`. Missing verification
is a failure; timeout after a possible send is `ambiguous` and is never retried.

## Placement and storage

The authority filters devices by local `nodeId`, online and quarantine state,
capability availability, exact local capability allowlist, and optional
selectors. Normal jobs choose the lowest value of active lease plus queued and
waiting-approval jobs, then use physical label and stable `deviceId` as
deterministic tie-breakers.

Selection and job creation occur in one SQLite transaction. The logical
selector participates in the idempotency fingerprint, while the selected
device is stored in `routeDecision`; a replay never re-routes. Shared Xiaowei
transport state is advisory during placement and remains protected by the
per-action tokenized lock.

The job response and `manifest.json` include exact `storage` paths and a
sanitized `routeDecision`. The public API never returns the private routing
profile, runtime ID, or transport lock token.

## Upgrade from control-plane v1

SQLite migration to schema v2 is additive and preserves v1 jobs, evidence, and
legacy idempotency fingerprints. Before deploying:

1. Confirm `/control/v1/leases` is empty and no job is active.
2. Stop `XhsDeviceControlPlaneV1`.
3. Copy `control.db` plus any `control.db-wal` and `control.db-shm` to a
   timestamped backup directory.
4. Update the untracked device config with reviewed routing profiles.
5. Deploy one exact commit, reinstall/start the task, and verify health, nodes,
   route plan, and storage paths.

Keep `CONTROL_PLANE_LEGACY_MODE=audit`. Roll back to the PR #14 commit and the
stopped database backup if migration or canary verification fails.

## Legacy migration

The dashboard now defaults to loopback, has no wildcard CORS, reads private
device IDs from the untracked device config, and never places an LLM credential
in process arguments.

- `CONTROL_PLANE_LEGACY_MODE=audit`: direct `/home`, `/task`, and `/primitive`
  calls continue but create sanitized audit events.
- `CONTROL_PLANE_LEGACY_MODE=enforce`: those routes return
  `423 LEGACY_ROUTE_BLOCKED`.
- `CONTROL_PLANE_LEGACY_MODE=off`: temporary local rollback only.

Switch to `enforce` only after the control-plane adapters pass one stable
acceptance cycle.

Index historical evidence without copying it:

```powershell
node control-plane\index-legacy-evidence.mjs `
  --source C:\Users\Public\xianyu-gap1 `
  --output C:\Users\Public\xhs-agent-control\legacy-xianyu-gap1.jsonl `
  --dry-run
```

Remove `--dry-run` after reviewing the file count and byte total. The index
contains relative paths, sizes, mtimes, and SHA-256; `copiedFiles` remains zero.

## Failure rules

- A restart changes in-flight jobs to `recovery_required` and quarantines the
  device.
- Restoration failure or lease loss also quarantines the device.
- The SQLite idempotency fingerprint survives restart.
- Low disk blocks all new runs below 128 MiB and external-effect jobs below
  1 GiB.
- Runtime evidence is not automatically deleted in v1.
