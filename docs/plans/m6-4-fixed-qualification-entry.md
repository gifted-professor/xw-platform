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
