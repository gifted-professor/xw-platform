---
name: device-shell
description: 在设备上执行 ADB shell 命令。SSH-safe，支持 base64 编码。
triggers:
  - device-shell
  - shell
  - adb shell
  - 执行命令
version: "1.0"
verified:
  - date: 2026-07-28
    device: "01"
    result: pass
---

# ADB Shell（device-shell）

## 用法

```bash
# 执行简单命令
node ops/shell.mjs --alias <01-04> --session-file <explorer-session.json> --cmd "input swipe 540 1800 540 700 350"

# 查看设备属性
node ops/shell.mjs --alias <01-04> --session-file <explorer-session.json> --cmd "getprop ro.product.model"
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--alias` | ✅ | 设备别名 01-04 |
| `--cmd` | ✅ | 要执行的 shell 命令 |

## 注意事项

- 命令经小薇 WebSocket 转发，不是直接 ADB
- 小薇 ADB 用 **端口 5038**（不是默认 5037）
- 特殊字符自动 base64 编码（SSH-safe）
- 禁止用 `input text` 输入中文（用 `device-input` 代替）

## 相关

- 中文输入：`skills/device/device-input`
- 传输层：`skills/shared/transport`
