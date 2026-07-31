# 传输层（Transport）

> Mac → Windows → 手机 的通信链路。所有 skill 的底层依赖。

## 链路

```
Mac ops/ 脚本
  → SSH (Tailscale, ControlMaster 常驻)
    → Windows _win-xiaowei.mjs
      → WebSocket ws://127.0.0.1:22222 (小薇)
        → Android 手机 (USB)
```

## 关键文件

| 文件 | 作用 | 跑在哪 |
|------|------|--------|
| `ops/_explore-lib.mjs` | SSH 连接 + 设备解析 + helper 管理 | Mac |
| `ops/_win-xiaowei.mjs` | 小薇 WebSocket 原子动作 | Windows |
| `ops/_win-screencap.mjs` | 截屏（优先小薇，回落 ADB） | Windows |
| `ops/_xhs-parse.mjs` | UI dump XML 解析 | Mac（纯函数） |

## 两种模式

### 单发模式（argv）

```bash
# 每个动作一次 SSH + node 启动（~1.2s）
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
| 单发 | ~1.2s | 手敲 ad-hoc |
| session | ~40ms | 业务脚本（自动） |

## 注意事项

- 小薇 ADB 用 **端口 5038**（不是默认 5037）
- 效卫 22222 是**单实例共享连接**，多设备请求全局串行
- SSH 用 ControlMaster 常驻连接（ControlPersist=600）
- serial 本地缓存 TTL 5min（`XHS_NO_SERIAL_CACHE=1` 逃生口）
