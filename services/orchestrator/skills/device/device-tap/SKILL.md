---
name: device-tap
description: 在指定坐标点击设备屏幕。经小薇 22222 WebSocket 传输，走 Explorer lab 通道。
triggers:
  - device-tap
  - 点击
  - tap
  - 点屏幕
version: "1.0"
verified:
  - date: 2026-07-28
    device: "01"
    result: pass
---

# 设备点击（device-tap）

## 用法

```bash
node ops/tap.mjs --alias <01-04> --session-file <explorer-session.json> --x <像素X> --y <像素Y>
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--alias` | ✅ | 设备别名 01-04 |
| `--x` | ✅ | 像素 X 坐标 |
| `--y` | ✅ | 像素 Y 坐标 |

## 前置条件

1. `node ops/xw-explore-session.mjs acquire ...` 已创建正式 session context
2. `node ops/explore-preflight.mjs --alias <01-04> --session-file <same.json>` 通过

## 注意事项

- 坐标是**绝对像素**，不同设备分辨率不同，不要跨设备复用
- 优先用 `device-dump` 获取元素 bounds 再 tap，不要硬编码坐标
- VLM 视觉坐标 Y 可偏 −1330px，禁止直接用（见 `skills/shared/pitfalls.md`）

## 输出

```
TAP=ok
```

## 相关

- 定位元素：`skills/device/device-dump`
- 获取前台 App：`skills/device/device-focus`
- 坑点手册：`skills/shared/pitfalls.md`
