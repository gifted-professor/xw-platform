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
| 5 | schema-valid capture receipt + frozen 4×20 aggregate closeout oracle | `packages/kernel/lib/m6-aggregate-closeout.mjs` + `xw m6 epoch aggregate-closeout` |
| 6 | live gate reload + commit-time drift re-check | preflight/capture/commit/health reload the signed disk state; a close or rollback is visible without restart |
| 7 | cleanup is part of the accepted-frame transaction | cleanup failure emits a rejected tombstone and no consumable frame; accepted TTL/receipt time is recomputed after convergence |
| 8 | ScreenFrame manifest integrity + independent A/B observation | manifest binds mode/expiry/stability/flags and all evidence refs; quarter-turn rotation and B-time display freshness are verified |
| 9 | epoch mint/activate/close with dry-run, aggregate binding, signature/hash verify, append-only rollback | `control-plane/lib/m6-epoch.mjs` + `xw m6 epoch *` CLI |

## Key layout (runtime root)

```
<XW_RUNTIME_ROOT>/            (default C:\Users\Public\xw-runtime on win32)
  m6-gate/
    issuer-keys.json          ed25519 issuer allowlist (public keys only)
    locks.v1.json             release-pinned lock hashes (written by release pipeline)
    <gate-id>/epochs/<hash>.json      immutable epoch chain
    <gate-id>/current.json            active append-only chain pointer (activate = atomic swap)
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
  --gate-id m6-gate --audit-root <XW_RUNTIME_ROOT>/m6-audit \
  --scenario-manifest <prewritten-scenarios.json> \
  --resource-snapshot <independent-resources.json>
```

Runs the pure verifier over the complete pre-written matrix: exactly four
allowlisted aliases, exactly 20 unique scenarios per alias (80 total), frozen
stable→accepted and unstable→rejected expectations, unique attempt/run/job
attribution, a closeout for every attempt, and no unplanned attempt. Each
scenario must declare `zeroAction:true`. The separately captured resource proof
must bind the same epoch, hash cleanly, record `actionCount=0`, and show
`activeJobs/activeSessions/activeLeases=0` both before and after. Stable receipts
must carry complete stable frames; unstable receipts must carry a recognized
instability rejection code. With `--yes` the command writes the immutable seal
`m6-gate/<gate-id>/aggregate/<sealHash>.json`.

### 6. Close the epoch / rollback

```bash
node packages/cli/xw.mjs m6 epoch close --gate-id m6-gate --reason R \
  --aggregate-seal H --key-file priv.pem --key-id K --yes
node packages/cli/xw.mjs m6 epoch rollback --gate-id m6-gate --to CLOSED_H \
  --key-file priv.pem --key-id K --promoted-at ISO --yes
```

`close` refuses zero/partial matrices: the referenced seal must re-derive, bind
the active OBSERVE_ONLY epoch and contain all 80 attempts. The resulting signed
CLOSED epoch hashes both its per-epoch closeout and aggregate seal references.
Rollback may target only a prior CLOSED epoch and appends a newly signed CLOSED
epoch with `rollbackTargetEpochHash`; it never restores an old pointer or
re-activates an OBSERVE_ONLY tail.

## Tests / CI

```bash
npm run test:m6-2:offline   # W1-W7 surface (106 tests)
npm run test:m6-2:epoch     # W8 epoch/loader/aggregate/manifest/CLI (60+ tests)
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
