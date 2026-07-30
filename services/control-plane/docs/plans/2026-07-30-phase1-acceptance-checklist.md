# Phase1 one-time collect canary acceptance checklist

This checklist is offline acceptance for canary-only scaffolding. It does not accept ADR 0009, enable flags, deploy code, issue a Grant, or authorize device activity.

| Test | Offline proof |
|---|---|
| 5.1 first collect succeeds | `standing-grant-supported-path.test.mjs` exercises the single supported canary route; `xhs-collect-standing-grant.test.mjs` proves the successful adapter sequence. |
| 5.2 second collect blocked | durable marker returns `CANARY_ALREADY_COMPLETED`. |
| 5.3 cleared marker allows another | terminal marker clear is explicit, reasoned, and audited; a new reservation then succeeds. |
| 5.4 ambiguity is not retried | ambiguous marker survives restart; terminal cleanup releases the owned tuple. |
| 5.5 unauthorized evidence denied | canary evidence denies by default, including a caller-provided `role`. |
| 5.6 authorized reviewer allowed | only a server-owned authorizer can allow the evidence response. |
| 5.7 post-canary lease count zero | integration assertion verifies no leases remain. |
| 5.8 restored feed | adapter order ends in undo then back-to-feed and reports `restoration.ok`. |

| Acceptance | Required evidence |
|---|---|
| A1 signed explicit-target Grant active | existing trusted issuer install route and runtime signature tests. |
| A2 Mission compiled and DeviceRun allocated | canary integration creates a Grant child Mission and owned DeviceRun. |
| A3 one collect succeeds with evidence | collect job and verified ECP result are asserted. |
| A4 collect delta verified | ECP verify returns verified with evidence refs. |
| A5 no unrelated social side effects | exact adapter sequence contains only observe, collect, undo, and feed restoration. |
| A6 device restored to feed | restoration is asserted successful and the final adapter operation is feed navigation. |
| A7 zero active leases | integration asserts the state lease list is empty after terminal cleanup. |

Focused gate:

```text
npx --yes node@24.11.1 --test tests/standing-grant-supported-path.test.mjs tests/standing-grant-canary-state.test.mjs tests/delegation-grant-runtime.test.mjs tests/xhs-collect-standing-grant.test.mjs
```

Full gates: `npm test`, `npm run check`, and `git diff --check`, all under pinned Node 24.11.1.
