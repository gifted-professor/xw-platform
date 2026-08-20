# Harness Protocol v1（M4-B）

让 DSH 与 Reference Harness 走同一套 XW Harness Protocol。  
`DSH_LIVE_GATE = CLOSED`。`dshEnabled = false`。不能控制真机。

## DSH lock

`packages/harness-protocol/locks/dsh.lock.v1.json` 与 `integrations/dsh-xw/lock.json` 必须同 commit：

```text
deepseek-ai/deepseek-harness
0.1.0-rc.7
99f6f02fecdb7dff40c3fbc9470f5907c29f74ca
```

禁止跟随 `master` / `latest`。升级必须独立 PR。

## 统一接口

```text
createSession
restoreSession
submitGoal
continueSkill
checkpoint
queryTrace
interrupt
close
```

DSH adapter 只暴露 `xw_skill_*` / `xw_phone_*` / `xw_trace_query`。禁止 db / ADB / 22222 / lease / 支付覆盖。

## 恢复规则

| 场景 | 结果 |
| --- | --- |
| tool/call 后、tool/result 前崩溃 | 拒恢复，除非 `ALREADY_VERIFIED` |
| XW Action 已请求、响应丢失 | `AMBIGUOUS_EFFECT` → 拒绝 |
| DSH 已 flush、XW checkpoint 未写 | `SKILL_CHECKPOINT_MISSING` |
| XW checkpoint 已写、DSH 未 flush | `DSH_FLUSH_INCOMPLETE` |
| DSH commit 变了 | `DSH_VERSION_MISMATCH` |
| 重复恢复仍活着的 session | `HARNESS_SESSION_ALREADY_ACTIVE` |
| Subagent 带着未完成 tool 退出 | `AMBIGUOUS` |

设备动作重复执行必须为 0。无法证明的结果全部 AMBIGUOUS。

## 文件

- `packages/harness-protocol/`
- `integrations/dsh-xw/`
