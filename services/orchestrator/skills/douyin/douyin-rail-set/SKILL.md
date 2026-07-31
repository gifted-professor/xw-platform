---
name: douyin-rail-set
description: 抖音右侧栏三连 dry-run 集合（like+collect+follow），按机串行。
triggers:
  - douyin-rail-set
  - 抖音右侧栏集合
  - 三连集合
version: "1.0"
verified:
  - date: 2026-07-31
    device: "01,02"
    result: pass
    mode: dry-run
    note: "DOUYIN_RAIL_SET=ok PASS=6；每 op force-stop（同机连跑否则 dump 死）"
depends:
  - douyin-like
  - douyin-collect
  - douyin-follow
  - shared/preflight
---

# 抖音右侧栏三连集合（douyin-rail-set）

> 每机串行 `like → collect → follow`（均 `--dry-run`）。默认 `01,02`。**勿加 04**（未登录）。

## 用法

```bash
set XHS_LOCAL=1
node ops/douyin-rail-set.mjs --aliases 01,02
```

同机第二起起带 `--no-force-stop`。biz：`op:douyin-rail-set`。
