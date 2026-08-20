# integrations/dsh-xw

M4-B DSH adapter. **Source-only.** `DSH_LIVE_GATE = CLOSED`.

Locked to `deepseek-ai/deepseek-harness@0.1.0-rc.7` (`99f6f02f…`). Do not follow `master` / `latest`.

This package does **not** vendor DSH and does **not** talk to a real DSH process. It implements the same XW Harness Protocol as `packages/harness-protocol` so a future plugin can be dropped in without changing Skill Runtime or the Device Kernel.

Exposed tools only:

```text
xw_skill_start
xw_skill_continue
xw_skill_checkpoint
xw_skill_complete
xw_phone_observe
xw_phone_act
xw_phone_verify
xw_trace_query
```

Forbidden: `control.db`, `registry.db`, `ADB`, `22222`, lease mutation, payment/policy override.
