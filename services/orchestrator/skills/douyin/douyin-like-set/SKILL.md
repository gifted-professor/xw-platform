---
name: douyin-like-set
description: 多机抖音点赞 dry-run 集合。串行跑 douyin-like --dry-run，汇总 PASS/FAIL。
triggers:
  - douyin-like-set
  - 抖音点赞集合
  - 多机点赞
version: "1.0"
verified:
  - date: 2026-07-31
    device: "01,02"
    result: pass
    mode: dry-run
    note: "DOUYIN_LIKE_SET=ok PASS=2; retry after 01 dump flake"
depends:
  - douyin-like
  - shared/preflight
---

# 抖音点赞集合（douyin-like-set）

> 多机 `douyin-like --dry-run`。默认 `01,02`。**勿加 04**（未登录账号）。

## 用法

```bash
set XHS_LOCAL=1
node ops/douyin-like-set.mjs
node ops/douyin-like-set.mjs --aliases 01,02
```

出口：`ok`/`partial` → 0；全灭 → 2。biz：`op:douyin-like-set`。
