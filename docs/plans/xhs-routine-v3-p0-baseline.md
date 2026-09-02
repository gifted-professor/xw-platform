# XHS Routine V3 — P0 Execution Baseline (Pre-State)

Recorded: 2026-08-29 (session-local; no runtime mutation performed)

## Source base

- Implementation branch: `codex/xhs-routine-v3-impl` created from clean `a7b7fbbd536522352972b85a5789718dcc7146a0` in `.worktrees/xhs-r03`.
- Includes `5dab77f` (S_B7 fixes) per plan §2.1 — confirmed in `git log`.
- Root checkout is dirty and is NOT a V3 base.

## Frozen plan/contract identity (sha256)

| Artifact | SHA-256 |
| --- | --- |
| `docs/plans/xhs-routine-v3-free-exploration-plan-v2.md` | `305686655033f57c5e56683c502bbfc020f32c7070d69e74328f7a8ca33b5e70` |
| `docs/plans/xhs-routine-v3-execution-contract.v1.json` | `8c4190b15fcbb1546e85553210fa347e3e77ff2b086350a4f3190a70ca1bd4b7` |
| `docs/plans/xhs-routine-v3-execution-route.v1.json` | `40b75e6204d48054b69cf4a332a239369dbdd8e423450e5d4ba0fd202a9a0033` |

Route: primary `opencode-go/glm-5.3`, risk tier HIGH, whole-plan execution, max 1 model switch. Plan hash matches contract `planSha256`. No Plan V3, no second review wave.

## Runtime pre-state (observed 2026-08-29)

- CP live at `http://127.0.0.1:17920/control/v1/health`:
  - `ok:true`, nodeId `DESKTOP-3I1EVHE`, authority, node 24.11.1, `node:sqlite`
  - devices 4, capabilities 35, **activeLeases: 0**
  - policyMode `nonpayment_v1`, active, pilotOnly, pilotAliases `[01,02,03,04]`
  - `sourceCommit 8aaba01...`, `releaseId xw-xhs-routine-b4-8aaba01` (B4 — matches plan §2.2)
- Gate F: `GET /control/v1/internal/m6/gate-f/status` → 503-ish `M6_GATE_F_OPERATIONS_UNAVAILABLE` (not installed in this runtime) — matches plan §2.2.
- Vision: `xhs-routine-vision-provider.v1.json` absent; no production `analyze.py` (per plan §2.3; to be re-verified at P4).
- Rollback tuple exists but does not hash launcher body (plan §2.2) — P5 obligation.

## Frozen contracts

- Template: `xhs.explore.goal.v1`, `effectClass="none"`, `externalEffects=0`; mission `xw.xhs.exploration-mission.v1`.
- Lanes fixed: `03=feed_lane`, `04=search_lane`; acquire order 03→04; both attached before any device I/O.
- Page allowlist: HOME_FEED, SEARCH_HOME, SEARCH_RESULTS, IMAGE_NOTE, VIDEO_NOTE, COMMENT_PANEL.
- Navigation vocabulary (closed): OPEN_SEARCH, SUBMIT_SEARCH, SCROLL_FEED, SCROLL_RESULTS, OPEN_CONTENT_CARD, OPEN_COMMENT_PANEL, SCROLL_COMMENTS, PAUSE_VIDEO_SAFE_ZONE, BACK, RESTORE.
- Budgets/caps: per plan §3.3 table (mission 600s, 80 primitives, 8 novel opens, 2 queries, vision 6 attempts / 1 permit / ≤1 physical tap canary, 8000ms provider deadline, 10000ms frame age, 5000ms permit TTL, concurrency 1/device, parallelism exactly 2 or plan-only).
- RPA: `xw.xhs.rpa-program.v1`, disabled-by-default, `RPA_RECURRING_ENABLED=false`, pacing bounds per plan §3.6.

## P0 gate

- [x] Plan/contract hashes recorded and matching.
- [x] Baseline branch from clean `a7b7fbb`.
- [x] Pre-state captured (B4 identity, Gate-F unavailability, zero leases, provider absence).
- [x] Schemas/caps/allowlists/roles frozen (this document + plan §3).
- [x] No runtime mutation performed.
