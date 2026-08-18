---
name: xianyu-snapshot
description: 闲鱼只读快照。R0 免审批，用于确认设备状态和恢复验证。
triggers:
  - xianyu-snapshot
  - 闲鱼快照
  - 闲鱼状态
  - snapshot
version: "1.0"
verified:
  - date: 2026-07-28
    device: "01,02,03,04"
    result: pass
depends:
  - shared/preflight
---

# 闲鱼只读快照（xianyu-snapshot）

## 用法

```bash
cd /Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-device-agent-routing-v1-1
node control-plane/devicectl.mjs --ssh xhs-windows job submit \
  --capability xianyu.observe.snapshot \
  --actor <actor> \
  --idempotency-key <key> \
  --device <01-04>
```

## 说明

- **R0 只读**，免审批
- 用于确认设备在闲鱼主页（main-safe）
- 用于恢复后刷绿（ready 状态刷新）
- 不启动/导航 App，只读当前状态

## 用途

1. **恢复验证**：设备恢复后跑 snapshot 确认 main-safe
2. **刷绿**：清除 unresolvedFailure，刷新 ready 状态
3. **巡探**：Hermes L1 patrol 对 ready 设备定期跑 snapshot

## 相关

- 闲鱼发布：`skills/xianyu/xianyu-publish`
- 前置检查：`skills/shared/preflight`
