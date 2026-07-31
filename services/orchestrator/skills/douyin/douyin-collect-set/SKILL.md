---
name: douyin-collect-set
description: 多机抖音收藏 dry-run 集合。串行跑 douyin-collect --dry-run，汇总 PASS/FAIL。
triggers:
  - douyin-collect-set
  - 抖音收藏集合
  - 多机收藏
version: "1.0"
verified:
  - date: 2026-07-31
    device: "01,02"
    result: pass
    mode: dry-run
    note: "DOUYIN_COLLECT_SET=ok PASS=2; 01 XY=997,1775 / 02 XY=997,1582"
  - date: 2026-07-31
    device: "01,02,04"
    result: partial
    mode: dry-run
    note: "04 FAIL dump_feed（青少年/空层）"
depends:
  - douyin-collect
  - shared/preflight
---

# 抖音收藏集合（douyin-collect-set）

> 把多机 `douyin-collect --dry-run` 收成一条集合命令。只定位不点。默认 `01,02`。**勿加 04**（未登录账号）。

## 用法

```bash
set XHS_LOCAL=1
node ops/douyin-collect-set.mjs
node ops/douyin-collect-set.mjs --aliases 01,02
node ops/douyin-collect-set.mjs --aliases 01,02,04
```

## 输出（示例）

```
ALIASES=01,02
MODE=dry-run
ROW alias=01 RESULT=dry-run COLLECT_XY=997,1775 MS=...
ROW alias=02 RESULT=dry-run COLLECT_XY=996,1581 MS=...
PASS=2
FAIL=0
DOUYIN_COLLECT_SET=ok
```

`partial`：有过有挂，exit 0；全灭 `fail` exit 2。

## biz

`op:douyin-collect-set`，`extra.rows` 形如 `01:dry-run|02:fail/dump_feed`。

## 相关

- 单机：`ops/douyin-collect.mjs`
- 坑：青少年模式 / 真藏杀 dump（`skills/shared/pitfalls.md`）
