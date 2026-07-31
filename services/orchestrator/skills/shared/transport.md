# 传输层（Transport）

> 调用面 → Windows 执行面 → 手机。所有 skill 的底层依赖。
> **执行面始终在 Windows**（`_win-xiaowei.mjs` + 小薇 WS 22222），与调用端是 Mac 还是本机无关。

## 链路

### Mac 调用（默认 SSH）

```
Mac ops/ 脚本
  → SSH (Tailscale, ControlMaster 常驻)
    → Windows _win-xiaowei.mjs
      → WebSocket ws://127.0.0.1:22222 (小薇)
        → Android 手机 (USB)
```

### Windows 本地调用

```
Windows ops/ 脚本（XHS_LOCAL=1 | --local | win32 自动）
  → 本机 node ops/_win-xiaowei.mjs（无 SSH/SCP）
    → WebSocket ws://127.0.0.1:22222 (小薇)
      → Android 手机 (USB)
```

本地开关：`XHS_LOCAL=1`、`--local`、或本机 `win32` 自动；`XHS_LOCAL=0` 可关掉自动。

## 关键文件

| 文件 | 作用 | 跑在哪 |
|------|------|--------|
| `ops/_explore-lib.mjs` | 设备解析 + helper + SSH/本地短路 | 调用端（Mac 或 Windows） |
| `ops/_win-xiaowei.mjs` | 小薇 WebSocket 原子动作 | Windows（执行面） |
| `ops/_win-screencap.mjs` | 截屏（优先小薇，回落 ADB） | Windows（执行面） |
| `ops/_xhs-parse.mjs` | UI dump XML 解析 | 调用端（纯函数） |

## 两种模式

### 单发模式（argv）

```bash
# 每个动作一次启动（Mac 经 SSH ~1.2s；Windows 本地更短）
node ops/tap.mjs --alias 01 --x 540 --y 1200
```

### Session 模式（repl）

```bash
# 常驻进程，按行读 JSON 命令（~40ms）
# 由 openWinXwSession() 内部管理，业务脚本自动使用
```

## 性能

| 模式 | 延迟 | 适用 |
|------|------|------|
| 单发 | ~1.2s（SSH）/ 更短（本地） | 手敲 ad-hoc |
| session | ~40ms | 业务脚本（自动） |

## 注意事项

- 小薇 ADB 用 **端口 5038**（不是默认 5037）
- 效卫 22222 是**单实例共享连接**，多设备请求全局串行
- Mac SSH 用 ControlMaster 常驻连接（ControlPersist=600）
- serial 本地缓存 TTL 5min（`XHS_NO_SERIAL_CACHE=1` 逃生口）
- 不为 Windows 配 `Host xhs-windows → 127.0.0.1` 当正式方案——用 `XHS_LOCAL` / `--local`
