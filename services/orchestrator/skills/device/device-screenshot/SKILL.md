---
name: device-screenshot
description: 截取设备当前屏幕并保存到 Mac 本地。优先小薇 WS Screen，回落 ADB。
triggers:
  - device-screenshot
  - 截屏
  - screenshot
  - 截图
version: "1.0"
verified:
  - date: 2026-07-28
    device: "01"
    result: pass
---

# 设备截屏（device-screenshot）

## 用法

```bash
node ops/screenshot-and-analyze.mjs --alias <01-04>
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--alias` | ✅ | 设备别名 01-04 |

## 输出

```
SHOT=/path/to/screenshot.png
```

## 说明

- 截屏保存到 Mac 本地临时目录
- 优先走小薇 WebSocket Screen（22222）
- 小薇不可用时回落 ADB screencap
- 截屏后可配合 AI 视觉分析（但注意 VLM Y 偏移坑）

## 注意事项

- 截屏是**只读**操作，不改变设备状态
- 截屏分辨率 = 设备物理分辨率
- 视觉分析时注意 `pitfall-vision-vlm-y-bias-20260727`（Y 可偏 −1330px）

## 相关

- UI dump（更精确）：`skills/device/device-dump`
- 坑点手册：`skills/shared/pitfalls.md`
