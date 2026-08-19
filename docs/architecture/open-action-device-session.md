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
- open_action or discovery session → `POST /control/v1/sessions/:id/heartbeat|release|actions`

`/control/v1/device-sessions/:id/actions` is not enabled in M3-B. That route returns `PRIMITIVE_NOT_SUPPORTED`, not a fake kind mismatch.

Device-session tokens travel only as `X-Control-Token`. Query-string `?token=` is rejected.

## Observe

`POST /control/v1/device-sessions/:id/observe` returns `ObservationV1` plus `mutatingCalls: 0`.

M3-B uses a **fake/fixture** provider. Evidence is refs only (`screenshotRef` / `ocrRef` / `uiTreeRef` / `accessibilityRef`). Inline screenshot/uiTree bytes are rejected.

Mutating primitive kinds (`tap`, `type_text`, …) are `PRIMITIVE_NOT_SUPPORTED` on this path.

## Payment Firewall Fixtures — M3-C

Classifier: `services/control-plane/control-plane/lib/payment-firewall.mjs`.

It maps `observation.paymentSignals` onto the frozen kernel `EFFECT_POLICY` table. It does not copy the table. `paymentSignals` is a fixture slot; live `effect.assessed` / `payment.hold_created` emission waits for M3-E.

| category | decision | signals |
| --- | --- | --- |
| `payment_final_commit` | `HUMAN_REQUIRED` | `final_confirm_pay`, `final_transfer_confirm`, `final_one_click_pay`, `final_subscription_confirm`, `final_verified_control` |
| `payment_credential` | `HUMAN_REQUIRED` | `credential_pin_pad`, `credential_password`, `credential_otp`, `credential_card_number`, `credential_cvv`, `credential_bank_card`, `credential_expiry` |
| `payment_context_uncertain` | `REOBSERVE_REQUIRED` | `pay_adjacent_label`, `pay_ambiguous_button`, `pay_keyword_no_commit`, `pay_context_incomplete` |
| `nonpayment` | `ALLOW_WITH_TRACE` | no known payment signal |

Priority: `final_commit > credential > uncertain > nonpayment`. Agent-claimed category is echoed and never authoritative. `/device-sessions/:id/actions` stays disabled.

## Not in this wave

Primitive executor (M3-D), kernel reader wiring (M3-E), agent-gateway (M3-F).
