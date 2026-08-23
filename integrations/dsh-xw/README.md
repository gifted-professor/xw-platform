# integrations/dsh-xw

M4-B/M6-3 DSH adapters. **Source-only.** `DSH_LIVE_GATE = CLOSED`.

Locked to `deepseek-ai/deepseek-harness@0.1.0-rc.7` (`99f6f02f…`). Do not follow `master` / `latest`.

`plugin.mjs` remains the legacy `fixture_in_process` adapter. M6-3 adds the
separate `dsh_cordis_process` adapter in `src/process-adapter.mjs`; it boots
only the closed `profiles/replay` Cordis composition through the bounded stdio
supervisor. Neither path registers device/live tools.

The process adapter exposes exactly:

```text
phone_observe
phone_ground
phone_act
phone_verify
checkpoint_save
trace_query
wait_human
worker_start
worker_continue
worker_complete
```

Forbidden: `control.db`, `registry.db`, `ADB`, `22222`, lease mutation, payment/policy override.
