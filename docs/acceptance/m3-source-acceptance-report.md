# M3 Open Action Runtime v1 — source acceptance

`M3_SOURCE_GATE = PASS`

`LIVE_CANARY_GATE = CLOSED`

`RUNTIME_CUTOVER_GATE = CLOSED`

This wave is fixture/replay only. Agent Gateway and `xw phone` talk to Control Plane over HTTP through `packages/control-client`. They do not open `control.db`, hold leases, call ADB, connect to 22222, or decide payment.

## What landed

1. Durable action ledger (`user_version` 18): reserve-before-execute, single-flight, release mutex, restart → `AMBIGUOUS`.
2. Effect events plus `packages/replay` fixture / recorded / fault backends. `transportCalled=false`.
3. `packages/control-client` + `services/agent-gateway` Observe/Act/Verify/Trace.
4. `xw phone attach|observe|act|trace|replay|release` with `--json` / `--context-file`. Token from env or `--token-file`.

## Not in this wave

- Live canary
- Runtime cutover
- Replacing the live Orchestrator `registry.mjs` approval panel sqlite reader (still `readOnly`; new surfaces do not read `control.db`)
- M4 Plugin SDK / DSH adapter
