---
name: device-back
description: 按设备返回键。可指定按多次。
triggers:
  - device-back
  - 返回
  - back
  - 返回键
version: "1.0"
verified:
  - date: 2026-07-28
    device: "01"
    result: pass
---

# 设备返回（device-back）

## 用法

```bash
# 按一次返回
node ops/back.mjs --alias <01-04>

# 按多次返回
node ops/back.mjs --alias <01-04> --times 3
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--alias` | ✅ | 设备别名 01-04 |
| `--times` | ❌ | 按几次（默认 1） |

## 输出

```
BACK=ok
```

## 注意事项

- 连续多次返回可能退出 App，建议每次返回后用 `device-focus` 确认
- 某些页面返回键被拦截（如编辑页面的「放弃」对话框），需要用 `device-tap` 点具体按钮

## 相关

- 确认前台：`skills/device/device-focus`
- 点击：`skills/device/device-tap`
