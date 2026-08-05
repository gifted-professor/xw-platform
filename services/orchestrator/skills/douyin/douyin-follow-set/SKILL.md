---
name: douyin-follow-set
description: 多机抖音关注 dry-run 集合。串行跑 douyin-follow --dry-run，汇总 PASS/FAIL。
triggers:
  - douyin-follow-set
  - 抖音关注集合
  - 多机关注
version: "1.0"
verified:
  - date: 2026-07-31
    device: "01,02"
    result: pass
    mode: dry-run
    note: "DOUYIN_FOLLOW_SET=ok PASS=2"
depends:
  - douyin-follow
  - shared/preflight
---

# 抖音关注集合（douyin-follow-set）

> 多机 `douyin-follow --dry-run`。默认 `01,02`。**勿加 04**（未登录账号）。

## 用法

```bash
set XHS_LOCAL=1
node ops/douyin-follow-set.mjs --session-dir <contexts-dir>
node ops/douyin-follow-set.mjs --session-dir <contexts-dir> --aliases 01,02
```

出口：`ok`/`partial` → 0；全灭 → 2。biz：`op:douyin-follow-set`。
