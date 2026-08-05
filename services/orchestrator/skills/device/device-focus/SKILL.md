---
name: device-focus
description: 获取设备当前前台 App 的 package/activity。用于确认设备在哪个页面。
triggers:
  - device-focus
  - focus
  - 前台App
  - 当前页面
version: "1.0"
verified:
  - date: 2026-07-28
    device: "01"
    result: pass
---

# 前台焦点（device-focus）

## 用法

```bash
node ops/focus.mjs --alias <01-04> --session-file <explorer-session.json>
```

## 输出

```
FOCUS=com.xingin.xhs/.index.v2.IndexActivityV2
```

格式：`<package>/<activity>`

## 常见值

| App | package | 主 Activity |
|-----|---------|------------|
| 小红书 | `com.xingin.xhs` | `.index.v2.IndexActivityV2` |
| 闲鱼 | `com.taobao.idlefish` | `.maincontainer.activity.MainActivity` |
| 微信 | `com.tencent.mm` | `.ui.LauncherUI` |

## 用途

1. **确认设备状态**：操作前确认在正确的 App
2. **验证导航结果**：操作后确认到了预期页面
3. **恢复判断**：确认设备是否在安全的主页

## 相关

- 启动 App：`skills/device/device-launch`
- 前置检查：`skills/shared/preflight`
