---
name: xhs-collect
description: 打开小红书信息流中的一条笔记并收藏。收藏验证用计数比对，避免 a11y 滞后误报。
triggers:
  - xhs-collect
  - 小红书收藏
  - 收藏笔记
  - 收藏
version: "1.1"
verified:
  - date: 2026-07-28
    device: "01"
    result: pass
    note: "v1.1 修复误报：计数比对 + 1200ms 重试"
depends:
  - device-tap
  - device-dump
  - device-back
  - shared/parse
  - shared/preflight
changelog:
  - version: "1.1"
    date: 2026-07-28
    change: "修复收藏误报：用计数比对替代 label 翻转判断，加 1200ms 重 dump"
---

# 小红书收藏（xhs-collect）

## 用法

```bash
# 实际执行
node ops/xhs-collect-one.mjs --alias <01-04> --session-file <explorer-session.json>

# 只定位不收藏（dry-run）
node ops/xhs-collect-one.mjs --alias <01-04> --session-file <explorer-session.json> --dry-run
```

## 流程

```
打开小红书 → 等待信息流 → dump 定位第一条笔记
→ 点击进入详情 → dump 定位收藏按钮 → tap 收藏
→ 计数比对验证 → 返回主页
```

## 验证规则（v1.1）

1. **计数比对**：收藏前记录计数，收藏后计数 +1 即成功
2. **重试机制**：如果未确认，等 1200ms 重 dump 一次再比对
3. **不依赖 label 翻转**：a11y label 滞后于服务端计数，不能当唯一判据

## 坑点

- `pitfall-collect-false-negative-20260728`：a11y label 滞后导致误报，已用计数比对修复

## 相关

- 点赞：`skills/xhs/xhs-like`
- 综合互动：`skills/xhs/xhs-engage`
- 坑点手册：`skills/shared/pitfalls`
