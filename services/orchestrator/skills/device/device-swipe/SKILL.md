---
name: device-swipe
description: 在设备屏幕上滑动。支持方向快捷方式和自定义起止坐标。
triggers:
  - device-swipe
  - 滑动
  - swipe
  - 翻页
version: "1.0"
verified:
  - date: 2026-07-28
    device: "01"
    result: pass
---

# 设备滑动（device-swipe）

## 用法

```bash
# 快捷方向
node ops/swipe.mjs --alias <01-04> --up
node ops/swipe.mjs --alias <01-04> --down

# 自定义起止坐标
node ops/swipe.mjs --alias <01-04> --x1 540 --y1 1800 --x2 540 --y2 700 --ms 350
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--alias` | ✅ | 设备别名 01-04 |
| `--up` / `--down` | 二选一 | 快捷方向 |
| `--x1` `--y1` `--x2` `--y2` | 二选一 | 自定义起止坐标 |
| `--ms` | ❌ | 滑动时长（默认 350ms） |

## 输出

```
SWIPE=ok
```

## 相关

- 点击：`skills/device/device-tap`
- 返回：`skills/device/device-back`
