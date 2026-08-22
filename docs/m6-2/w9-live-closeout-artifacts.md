# M6-2 W9 — Live Closeout Offline Artifacts (turnkey window inputs)

Status: **prepared offline, zero-live**. This wave makes the W8/W9 live observe
window turnkey by providing the two inputs the aggregate-closeout oracle
consumes and the exact command sequence, so the window itself is mechanical:

- The **frozen scenario manifest** (`xw.m6-scenario-manifest.v1`) — the
  4-alias × 20-run matrix, bound to the minted epoch hash, written BEFORE any
  capture.
- The **before/after resource snapshot** (`xw.m6-resource-snapshot.v1`) —
  independent quiescence proof (activeJobs/activeSessions/activeLeases all 0,
  actionCount 0), bound to the same epoch hash.
- The **runbook** below: dry-run-first, every durable write explicit `--yes`,
  no deploy/restart/device I/O until the operator authorizes the live segment.

The generator commands are `xw m6 window manifest|snapshot` (new in this wave,
`packages/cli/xw.mjs`). They are zero-live and dry-run by default; `--yes`
writes through the immutable writer (refuse-overwrite, atomic). The oracle is
`verifyAggregateCloseout` in `packages/kernel/lib/m6-aggregate-closeout.mjs` —
these commands only produce inputs that oracle accepts.

## Frozen inputs

### 1. Mint the OBSERVE_ONLY epoch (operator, human-confirmed)

```bash
node packages/cli/xw.mjs m6 epoch mint \
  --m6-root C:\Users\Public\xw-runtime \
  --gate-id m6-gate \
  --release-id xw-m6-2-w9-fe15f6f \
  --source-commit fe15f6f2ce1d787b76ac9b58acced0d522366aef \
  --actor human:operator-01 \
  --allowlist 01,02,03,04 \
  --expires-at <ISO> \
  --key-file C:\Users\Public\xw-runtime\secrets\operator-keys\operator-01.pkcs8.pem \
  --key-id operator-01
```

Dry-run first (prints the signed candidate + path). `--yes` writes the
immutable epoch. Lock hashes are re-read from the pinned
`<runtime root>/m6-gate/locks.v1.json` (`xw-m6-2-w9-fe15f6f`); a mismatch
aborts. Record the returned `epochHash` — it binds everything below.

### 2. Freeze the scenario matrix (offline, before any capture)

```bash
node packages/cli/xw.mjs m6 window manifest \
  --epoch-hash <EPOCH_HASH> \
  --out X:\path\m6-window-scenario-manifest.json \
  --yes
```

Produces `xw.m6-scenario-manifest.v1` with exactly 80 scenarios
(`observe-01-01` … `observe-04-20`), each `zeroAction:true`, stable→accepted
and unstable→rejected, and one deliberately-unstable ordinal per alias
(default ordinal 20; override with `--unstable 01:17,02:20,…` after a manual
device pre-screen). `--aliases` overrides the default `01,02,03,04`.

### 3. Snapshot quiescence before the window (offline, bound to the epoch)

```bash
node packages/cli/xw.mjs m6 window snapshot \
  --epoch-hash H \
  --out C:\path\m6-window-resource-snapshot.json \
  --yes
```

Fails closed on any non-zero `activeJobs/activeSessions/activeLeases` in
`--before`/`--after`; the independent proof is the operator confirming the
control plane is quiescent (no job/session/lease in flight) right before and
right after the window.

### 4. Activate

```bash
node packages/cli/xw.mjs m6 epoch activate --m6-root X:\Users\Public\xw-runtime --gate-id m6-gate [--epoch-hash H] --yes
```

### 5. The window (live, per-segment authorized)

One capture per scenario. Each capture is a real server-owned capability
session (one device, one lease) running the closed read-only observer
(`xiaowei.m6.observe_frame`), then a strict-frame freeze; cleanup is part of
the capture transaction. Re-run of an identical `--idempotency-key` within the
window is safe (job idempotency `m6:<ik>:observe`), but the audit trail is
append-only — **a scenario may land exactly once**. If a scenario's actual
outcome disagrees with the frozen matrix, the aggregate oracle rejects
(`M6_AGGREGATE_SCENARIO_OUTCOME_MISMATCH`); there is no in-window corrective
re-capture (a second receipt for the same scenario is a duplicate). Calibrate
the matrix against device reality before freezing.

```bash
# per attempt (alias 01 ordinal 01 shown):
node packages/cli/xw.mjs m6 frame capture --alias 01 --scenario observe-01-01 \
  --idempotency-key <EIGHT_HEX>:observe-01-01 --json
node packages/cli/xw.mjs m6 frame closeout --attempt-id <ATTEMPT_ID> --reason matrix --json
```

`capture` returns the server-generated `attemptId` (the audit root file
`<attemptId>.json` is written by the control plane); `closeout` seals each
attempt only after job/session/lease convergence.

### 6. Snapshot quiescence after the window

Confirm zero in-flight state again, then `xw m6 window snapshot` (step 3)
again with the same `--out` replaced only if nothing was written; the oracle
reads one file with both points.

### 7. Aggregate closeout (dry-run first)

```bash
node packages/cli/xw.mjs m6 epoch aggregate-closeout \
  --m6-root X:\Users\Public\xw-runtime --gate-id m6-gate \
  --audit-root X:\Users\Public\xw-runtime\m6-audit \
  --scenario-manifest C:\path\m6-window-scenario-manifest.json \
  --resource-snapshot C:\path\m6-window-resource-snapshot.json
# dry-run output: ok / attemptCount 80 / aliases + errors if any
# then --yes writes m6-gate/m6-gate/aggregate/<sealHash>.json (immutable)
```

### 8. Close (signed CLOSED epoch)

```bash
node packages/cli/xw.mjs m6 epoch close --m6-root X:\Users\Public\xw-runtime \
  --gate-id m6-gate --reason W8_W9_OBSERVE_ONLY --aggregate-seal <SEAL_HASH> \
  --key-file C:\Users\Public\xw-runtime\secrets\operator-keys\operator-01.pkcs8.pem \
  --key-id operator-01 --yes
```

`close` refuses zero/partial matrices: the referenced seal must re-derive, bind
the active OBSERVE_ONLY epoch, and contain all 80 attempts. `xw m6 epoch
verify` then re-checks hash + signature + chain + closeout/aggregate refs.

## Command reference

```
xw m6 window manifest --epoch-hash H [--aliases 01,02,03,04]
                      [--unstable 01:20,02:20,03:20,04:20] [--runs-per-alias 20]
                      [--out FILE] [--yes] [--json]
xw m6 window snapshot --epoch-hash H
                      [--before '{"activeJobs":0,"activeSessions":0,"activeLeases":0}']
                      [--after  '{"activeJobs":0,"activeSessions":0,"activeLeases":0}']
                      [--out FILE] [--yes] [--json]
```

Both commands are dry-run by default, bind the epoch hash, self-derive their
`manifestSha256`/`snapshotSha256`, and fail closed on invalid inputs (bad hash,
non-zero resource counts, malformed `--unstable`).

## Tests / CI

`npm run test:m6-2:epoch` gained the `xw m6 window` cases (generate → write →
pass the aggregate oracle end-to-end with synthetic 80-run attempts; tampered
expectations and non-zero snapshots fail closed). CI runs the same suite on
Ubuntu and Windows.

## This wave deliberately does NOT do

- Flip the gate, mint into the live root, deploy, restart, or touch devices.
- Change the DB schema or add server routes (the window runs the already
  released `xw m6 frame` facade + `xw m6 epoch` CLI; the new commands are pure
  offline generators).
- Authorize the live window — that remains the operator's per-segment call
  after the four devices are physically connected and authorized.
