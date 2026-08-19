# Open Action Device Session — M3-B

Observation-only device sessions. No mutating primitives. No phones, ADB, or 22222.

`runtimeCutoverAllowed` remains `false`. `LIVE_CANARY_GATE` remains CLOSED.

## Lane split

| API | sessionKind | writes UI? |
| --- | --- | --- |
| `POST /control/v1/sessions` | `capability` | existing capability `/actions` |
| `POST /control/v1/device-sessions` | `open_action` | **observe only** |

One device still has one lease. An open_action session and a capability session cannot share a device.

Cross-lane calls return `SESSION_KIND_MISMATCH`:

- capability session → `POST /control/v1/device-sessions/:id/observe`
- open_action session → `POST /control/v1/sessions/:id/actions`
- any method on `/control/v1/device-sessions/:id/actions` (path is not enabled)

## Observe

`POST /control/v1/device-sessions/:id/observe` returns `ObservationV1` plus `mutatingCalls: 0`.

M3-B uses a **fake/fixture** provider. Evidence is refs only (`screenshotRef` / `ocrRef` / `uiTreeRef` / `accessibilityRef`). Inline screenshot/uiTree bytes are rejected.

Mutating primitive kinds (`tap`, `type_text`, …) are `PRIMITIVE_NOT_SUPPORTED` on this path.

## Not in this PR

Payment firewall fixtures (M3-C), primitive executor (M3-D), kernel reader wiring (M3-E), agent-gateway (M3-F).
