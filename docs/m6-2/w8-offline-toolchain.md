# M6-2 W8 — Offline Live-Gate Toolchain (zero-live)

Status: **landed, zero-live**. This wave closes the nine W8 prerequisites for the
M6-2 live window while keeping every hard constraint intact:

- `M6_AGENTIC_LIVE_GATE` stays **CLOSED**; no deploy, no restart of `:17920`,
  no device I/O, no DB schema change, no release.
- Every operator command is **dry-run first**: nothing durable is written
  without an explicit `--yes`.
- Everything runs offline (Ubuntu + Windows CI green) — no gate flip required.

The nine prerequisite items and where each closed:

| # | Prerequisite | Where |
|---|---|---|
| 1 | gate contract vs runtime hash/status incompatibility | `m6-live-gate.mjs` epoch-hash prefix alignment (`:epoch:` → bare); `tests/m6-epoch-hash-alignment.test.mjs` |
| 2 | fail-open on missing release/source/lock/expiry | `m6-frame-capture.mjs` requires non-null `lockHashes` when enabled; loader fails closed (`M6_LOCKS_MISSING`) |
| 3 | production config loader, canonical evidence root, health/preflight proof | `control-plane/lib/m6-gate-loader.mjs`; `/control/v1/health` carries the `m6` block; `xw m6 frame preflight` |
| 4 | `xw m6 frame` route + public closeout inputs | `packages/cli/xw.mjs` (`frame` namespace), `m6-frame-capture.mjs` closeout |
| 5 | schema-valid capture receipt + four-machine aggregate closeout verifier | `packages/kernel/lib/m6-aggregate-closeout.mjs` + `xw m6 epoch aggregate-closeout` |
| 6 | manifest-commit gate-drift re-check | capture re-verifies the frame against its own manifest before accept (see #8) |
| 7 | job/session/lease cleanup failure fails capture/closeout | `M6_CLEANUP_FAILED` / `M6_CLOSEOUT_CONVERGENCE_FAILED` (`state-store.sessionExists/leaseExists`) |
| 8 | ScreenFrame manifest integrity + independent A/B observation | `kernel/lib/m6-screen-frame.mjs` `verifyFrameManifest`; slot-swap/forgery/focus-stability/page-fingerprint re-derivation |
| 9 | epoch mint/activate/close with dry-run, immutability, signature/hash verify, rollback | `control-plane/lib/m6-epoch.mjs` + `xw m6 epoch *` CLI |

## Key layout (runtime root)

```
<XW_RUNTIME_ROOT>/            (default C:\Users\Public\xw-runtime on win32)
  m6-gate/
    issuer-keys.json          ed25519 issuer allowlist (public keys only)
    locks.v1.json             release-pinned lock hashes (written by release pipeline)
    <gate-id>/epochs/<hash>.json      immutable epoch chain
    <gate-id>/state.json              active pointer (activate = atomic swap)
    <gate-id>/aggregate/<sealHash>.json   aggregate closeout seal
  m6-audit/<attemptId>.json           { receipt, frame } per attempt
  m6-audit/<attemptId>.closeout.json  { closeout } per attempt
  m6-frames/<attemptId>/...           screenshot A/B, dump, focus blobs
```

All writes go through the immutable writer (refuse-overwrite,
temp→fsync→atomic rename). Reads of hashed artifacts are symlink-safe.
Tombstones are renames — nothing under `m6-gate/` or `m6-audit/` is ever
hard-deleted. The private issuer key never lives on-repo; it is supplied to
the CLI at mint time via `--key-file`.

## Operator runbook (all commands dry-run first)

### 0. One-time setup

1. Generate the operator keypair off-repo and publish the public half into the
   allowlist. An example allowlist shape lives at
   `services/control-plane/tests/fixtures/m6-gate/issuer-keys.example.json`
   (`schemaId xw.m6-gate-issuer-allowlist.v1`, SPKI PEM public keys).
2. Drop the release-pinned `locks.v1.json` into `<XW_RUNTIME_ROOT>/m6-gate/`.
   Shape: `{schemaId:"xw.m6-locks.v1", releaseId, sourceCommit,
   lockHashes:{runtimeProfile, hardRedlinePolicy, groundingRuntime}}`. The
   control plane and the mint CLI only **read** it. Absent while M6 is enabled
   ⇒ `M6_LOCKS_MISSING` (fail-closed).

### 1. Mint an OBSERVE_ONLY epoch

```bash
node packages/cli/xw.mjs m6 epoch mint \
  --gate-id m6-gate --release-id R --source-commit C --actor OPERATOR \
  --allowlist 01,02,03,04 --expires-at ISO --mode OBSERVE_ONLY \
  --key-file priv.pem --key-id K
```

Dry-run by default: prints the planned epoch + `path`. Add `--yes` to write.
The CLI re-derives `epochHash` itself and signs over the hash bytes (detached
ed25519) — hand-crafted JSON is impossible by construction. Lock hashes are
read from the pinned file; a mismatch aborts mint.

### 2. Verify the chain

```bash
node packages/cli/xw.mjs m6 epoch status  --gate-id m6-gate
node packages/cli/xw.mjs m6 epoch verify  --gate-id m6-gate
```

`verify` re-checks every epoch: hash re-derivation, signature against the
allowlist, parent-link chain, mode/status coupling (CLOSED⇒closed sealed with
closeoutRef; OBSERVE_ONLY⇒active).

### 3. Activate

```bash
node packages/cli/xw.mjs m6 epoch activate --gate-id m6-gate [--latest]
```

Dry-run first; `--yes` atomically swaps the active pointer.

### 4. Observe window → per-attempt closeout

During the window, `xw m6 frame capture` records receipts/frames under the
canonical evidence root; `xw m6 frame closeout` seals each attempt. Capture
refuses when cleanup leaks (`M6_CLEANUP_FAILED`); closeout refuses while any
job/session/lease has not converged (`M6_CLOSEOUT_CONVERGENCE_FAILED`).

### 5. Aggregate closeout across the four aliases

```bash
node packages/cli/xw.mjs m6 epoch aggregate-closeout \
  --gate-id m6-gate --audit-root <XW_RUNTIME_ROOT>/m6-audit
```

Runs the pure four-alias verifier over `{receipt, closeout}` pairs:
every allowlist alias exactly once accepted (`M6_AGGREGATE_ALIAS_MISSING` /
`_DUPLICATE`), every hash re-derived (`M6_AGGREGATE_CLOSEOUT_FORGED`),
run/job uniqueness (`_RUN_DUPLICATE` / `_JOB_DUPLICATE`), no unsealed attempt
(`M6_AGGREGATE_UNSEALED`), no orphan closeouts (`_CLOSEOUT_ORPHAN`). With
`--yes` it writes the immutable aggregate seal
`m6-gate/<gate-id>/aggregate/<sealHash>.json`.

### 6. Close the epoch / rollback

```bash
node packages/cli/xw.mjs m6 epoch close --gate-id m6-gate --reason R \
  --key-file priv.pem --key-id K --yes
node packages/cli/xw.mjs m6 epoch rollback --gate-id m6-gate --to H --promoted-at ISO --yes
```

Rollback appends a new active epoch whose parent is the target — history is
never rewritten.

## Tests / CI

```bash
npm run test:m6-2:offline   # W1-W7 surface (105 tests)
npm run test:m6-2:epoch     # W8 epoch/loader/aggregate/manifest/CLI (64+ tests)
npm run check               # node --check over all touched files
npm run fusion:verify       # tree-integrity gate (allowlist covers new files)
```

CI (`.github/workflows/source-fusion.yml`) gained the
`M6-2 W8 epoch + aggregate closeout` step running `test:m6-2:epoch` on both
Ubuntu and Windows after the existing offline step.

## What this wave deliberately does NOT do

- Does not flip the gate, mint anything into the live root, or touch devices.
- Does not change the DB schema; convergence checks are read-only SELECTs.
- Does not add server routes — aggregate closeout is pure kernel code plus the
  operator CLI. The W8/W9 live execution plan follows separately with
  per-segment authorization.
