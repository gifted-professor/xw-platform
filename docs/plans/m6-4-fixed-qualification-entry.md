# M6-4 fixed qualification production entry

Before each release's package, and again after that release's rotation has
installed its successor bootstrap binding but before qualification launcher
preflight, run the zero-argument TCB provisioner from that exact formal
release:

```text
npm run m6-4:qualification-tcb-provision-fixed
```

It verifies the already-protected formal runtime root without rewriting it,
then verifies or normalizes only the fixed `m6-gate`, `secrets/operator-keys`,
and `config` child chains. It rejects reparses, linked files, multiple active
issuers, and a private key that does not match the sole active allowlist key.
It publishes a source-bound, content-addressed receipt containing only public
identity hashes. `package-fixed` and qualification launcher preflight both
require a receipt matching the current closure, so the post-rotation command
cannot be skipped.

The only production package command is:

```text
npm run m6-4:qualification-package-fixed -- <releaseId> <sourceCommit>
```

It accepts no path, JSON input, key selector, root, token, endpoint, PID, or time. It verifies the formal release at
`C:\Users\Public\xw-runtime\releases\<releaseId>`, selects the sole active issuer from the fixed runtime allowlist,
derives the three release lock hashes, signs with the matching protected local key, and publishes one create-only
content-addressed package under the fixed `m6-audit` root. Its output contains only the package hash/ref and replay
status.

Immediately after package creation and immediately before `quiesce-fixed`, run the zero-argument legacy-current
TCB provisioner from the successor's exact formal release:

```text
npm run m6-4:qualification-legacy-current-tcb-provision-fixed
```

It full-verifies the successor formal release, the legacy `current` release manifest/tree before the ACL operation,
and the same manifest/tree again afterwards. It revalidates the fixed `current` junction target immediately before
a write and again before returning. The only condition that permits one recursive protect of that exact legacy release is the
native `SYSTEM_TCB_ACL_TARGET_DACL_INVALID` verification code. Every other error fails with zero protect. This is a
monotonic legacy migration, not a general repair surface; its public receipt contains release identities and hashes,
never filesystem paths.

Then run the zero-argument legacy-database TCB provisioner from the same successor formal release:

```text
npm run m6-4:qualification-legacy-database-tcb-provision-fixed
```

It opens read-only handles to exactly `state/control-plane/control.db` and `state/orchestrator/registry.db`, plus any
existing fixed `-wal`/`-shm` sidecars. Before any protect it snapshots their existence, identity, size, mtime, and
SHA-256, and preflights both fixed state-directory closures and both target-only database ACLs. Only the exact native
`SYSTEM_TCB_ACL_TARGET_DACL_INVALID` condition permits normalization. Directory closure migration is explicit in the
public receipt; database files then use the target-only ACL primitive. It revalidates current and every private
content snapshot around each ACL operation. Sidecars are never ACL targets and no database-related file is opened
writable or has its bytes mutated by the provisioner.

Then run the zero-argument legacy-launcher TCB provisioner from the same successor formal release:

```text
npm run m6-4:qualification-legacy-launcher-tcb-provision-fixed
```

It binds exactly `C:\Users\Public\xw-runtime\launch-control-plane.simple.ps1` and
`C:\Users\Public\xw-runtime\launch-orchestrator.current-user.ps1`. Before any protect it opens both through
read-only handles, snapshots their file identities, sizes, mtimes, and SHA-256 hashes, then preflights the single
fixed runtime-boundary ancestor closure and both target-only launcher ACLs. Only the exact native
`SYSTEM_TCB_ACL_TARGET_DACL_INVALID` condition permits normalization. Current, both launcher snapshots, the legacy
manifest, and the executing formal-release manifest are revalidated before returning. The public receipt exposes
only fixed keys, hashes, counts, and normalized flags; a partial monotonic ACL migration is recovered only by
rerunning this same fixed command after the reported drift is resolved.

`quiesce-fixed` then uses the legacy-window v2 contract. It seals both launcher hashes, the caller SID hash/session,
each child and parent SID/session, the exact child argv shape, and each listener's complete local-address set without
copying launcher bytes, raw command lines, or token values into the prestate or public receipt. Only an exact subset
of those sealed listeners may be terminated. Once both fixed ports are empty, one guard holds Windows native
`ExclusiveAddressUse` sockets for both IPv4 and IPv6 wildcard addresses on `17920` and `17930` (the non-Windows
fallback uses exclusive sockets). Every checkpoint, standalone snapshot, and current-switch boundary awaits a fresh
helper heartbeat; helper drift or an unproven helper exit retains the stale owner lock. The operator then atomically
quarantines the exact dead control-plane owner lock into its
content-addressed private archive, acquires the
`QUALIFICATION_LEGACY_WINDOW` runtime authority, checkpoints both databases, proves WAL/SHM absence, captures the
standalone database snapshots without reopening the WAL-mode sources, and switches `current` while that guard is
still held. A quiesce failure restores only current/task/listeners and never writes a pre-stop online database snapshot
back over the untouched databases. Restore registers the sealed legacy task for identity continuity but does not run
it: it reproduces the observed topology and exact local-address sets by starting the control-plane current-user
launcher first, proving its exact child/parent/caller shape, then starting the registry launcher. A second-launcher
failure terminates only processes started by that attempt and returns to a stopped checkpointed boundary.

After the release-pinned legacy window has been quiesced, use exactly one of:

```text
npm run m6-4:qualification-rotation-preflight-fixed -- <releaseId> <sourceCommit> <packageHash>
npm run m6-4:qualification-rotation-execute-fixed -- <releaseId> <sourceCommit> <packageHash>
```

The wrapper derives the package, allowlist, formal release, runtime, and external snapshot paths. The generic
signing/bootstrap/rotation functions remain library APIs for tests and audited composition; they are not production
CLI entrypoints.

The mechanically fixed per-release order is therefore:

```text
npm run m6-4:qualification-tcb-provision-fixed
npm run m6-4:qualification-package-fixed -- <releaseId> <sourceCommit>
npm run m6-4:qualification-legacy-current-tcb-provision-fixed
npm run m6-4:qualification-legacy-database-tcb-provision-fixed
npm run m6-4:qualification-legacy-launcher-tcb-provision-fixed
node services/control-plane/ops/m6-qualification-legacy-window-operator.mjs quiesce-fixed <releaseId> <sourceCommit>
npm run m6-4:qualification-rotation-preflight-fixed -- <releaseId> <sourceCommit> <packageHash>
npm run m6-4:qualification-rotation-execute-fixed -- <releaseId> <sourceCommit> <packageHash>
npm run m6-4:qualification-tcb-provision-fixed
node services/control-plane/ops/m6-qualification-launcher-operator.mjs preflight-fixed <releaseId> <sourceCommit>
node services/control-plane/ops/m6-qualification-launcher-operator.mjs execute-fixed <releaseId> <sourceCommit>
node services/control-plane/ops/m6-qualification-launcher-operator.mjs status-fixed <releaseId> <sourceCommit>
npm run m6-4:qualification-execute-fixed
```

The first TCB receipt authorizes package creation against the pre-rotation
closure. Rotation replaces the bootstrap binding, which deliberately makes
that receipt stale. The second zero-argument provision is mandatory: without
it, launcher preflight fails closed before task registration.
