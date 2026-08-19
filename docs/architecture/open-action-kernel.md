# Open Action Kernel

M3-A 只定义 **Open Action + Payment-only Autonomy** 协议。  
不改 Control Plane，不执行动作，不接手机，不接 DSH。

M3-B 在同一 Control Plane 上增加 observation-only `device-sessions`（见 `open-action-device-session.md`）。仍不执行写动作。

`runtimeCutoverAllowed` 仍为 `false`。`LIVE_CANARY_GATE` 仍为 CLOSED。

## 两条通道

| Lane | 用途 |
| --- | --- |
| Legacy Capability | 已验证的 adapter / job / session / 高层业务 capability |
| Open Action | 未知页面、通用 UI、无专用 capability 的探索 |

两条通道最终都经过同一个 Control Plane。不产生第二套设备权威。

## 循环

```
Observe → 一个 Primitive → Post-observe → Verify → 下一个
```

M3 v1 一次只执行一个 primitive。

## 支付硬闸

分类由 Control Plane 根据屏幕/OCR/a11y/目标区域独立判定，Agent 自报 `nonpayment` 无权威。

| category | decision |
| --- | --- |
| `nonpayment` | `ALLOW_WITH_TRACE` |
| `payment_credential` | `HUMAN_REQUIRED` |
| `payment_final_commit` | `HUMAN_REQUIRED` |
| `payment_context_uncertain` | `REOBSERVE_REQUIRED` |

`ALLOW_WITH_TRACE` 不得用于任何支付类。uncertain 不得直接执行。

## 公开 primitive

`observe tap long_press swipe drag scroll type_text press_key back home recents open_app wait`

不是公开协议：`raw_adb shell arbitrary_subprocess payment_override policy_override`

可变 UI 动作必填：`actionId`、`idempotencyKey`、`basedOnObservationId`。

## 文件

- `packages/kernel/contracts/open-action/`
- `packages/kernel/event-protocol/`
- `packages/kernel/error-codes/`
- `packages/kernel/lib/open-action.mjs`
- `packages/kernel/contracts/manifest.v1.json`
