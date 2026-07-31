---
name: device-launch
description: 在设备上启动指定 App。可选指定 Activity 和 force-stop。
triggers:
  - device-launch
  - 启动App
  - 打开App
  - launch app
version: "1.0"
verified:
  - date: 2026-07-28
    device: "01"
    result: pass
---

# 启动 App（device-launch）

## 用法

```bash
# 启动小红书
node ops/launch-app.mjs --alias <01-04> --package com.xingin.xhs

# 启动闲鱼（指定 Activity）
node ops/launch-app.mjs --alias <01-04> --package com.taobao.idlefish --activity com.taobao.idlefish.maincontainer.activity.MainActivity
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--alias` | ✅ | 设备别名 01-04 |
| `--package` | ✅ | App 包名 |
| `--activity` | ❌ | 指定 Activity（默认主 Activity） |

## 常用包名

| App | package |
|-----|---------|
| 小红书 | `com.xingin.xhs` |
| 闲鱼 | `com.taobao.idlefish` |
| 微信 | `com.tencent.mm` |

## 输出

```
LAUNCH=ok
```

## 相关

- 确认前台：`skills/device/device-focus`
- 前置检查：`skills/shared/preflight`
