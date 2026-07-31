# 前置检查（Preflight）

> 任何设备操作前必须通过的检查。不通则禁止开干。

## 一键检查

```bash
node ops/explore-preflight.mjs --alias 01
```

## 检查项

| # | 检查 | 命令 | 期望 |
|---|------|------|------|
| 1 | registry 健康 | `ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/api/health'` | `{"ok":true}` |
| 2 | 控制面健康 | `ssh xhs-windows 'curl.exe -s http://127.0.0.1:17920/control/v1/health'` | `{"ok":true}` |
| 3 | 设备 ready | `ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/agent-entry.md'` | `ready=yes` |
| 4 | 设备 lease | 同上 | `lease=free` |
| 5 | 设备 online | 同上 | `online=yes` |

## 失败处理

| 失败 | 怎么办 |
|------|--------|
| registry 不通 | 检查 Windows 计划任务 `XhsDeviceRegistry` 是否在跑 |
| 控制面不通 | 检查 `XhsDeviceControlPlaneV1` 是否在跑 |
| ready=no | 先走 `job recover` 或 `ops/recover-main-safe.mjs` |
| lease=held | 等 lease 释放，或换设备 |
| online=no | 检查 USB 连接 / 小薇 22222 |

## 设备 serve 端口

| 设备 | 端口 | 恢复脚本 |
|------|------|----------|
| 01 | 17895 | `serve-restart-01.ps1` |
| 02 | 17897 | `serve-restart-02.ps1` |
| 03 | 17898 | `serve-restart-03.ps1` |
| 04 | 17896 | `serve-restart-04.ps1` |
