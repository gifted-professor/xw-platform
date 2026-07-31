---
name: douyin-collect
description: 抖音推荐 Feed 右侧栏定位收藏按钮。--dry-run 只定位不点；不加则真收藏。
triggers:
  - douyin-collect
  - 抖音收藏
version: "1.0"
verified:
  - date: 2026-07-31
    device: "01"
    result: pass
    mode: dry-run
    note: "真机 dry-run：DOUYIN_COLLECT=dry-run / COLLECT_BEFORE=未选中，收藏1.1万，按钮 / COLLECT_XY=997,1775 / COLLECT_STATE=uncollected / exit=0"
depends:
  - device-tap
  - device-dump
  - device-focus
  - shared/parse
---

# 抖音收藏（douyin-collect）

> 推荐 Feed 右侧栏收藏。dry-run 跑绿即 v1.0（约定）。真收藏 desc 翻转留下一轮。

## 用法

```bash
set XHS_LOCAL=1
node ops/douyin-collect.mjs --alias 01 --dry-run
node ops/douyin-collect.mjs --alias 01
node ops/douyin-collect.mjs --alias 01 --dry-run --no-force-stop
```

## 流程

```
launch aweme → settle 5.5s → dump Feed（空则重试）
→ findCollectBtn：desc 含「收藏」+「按钮」、cx>850
→ 已选中 → skip；--dry-run → dry-run；否则 tap → dump 校验
→ bizRecord(op:"douyin-collect")
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--alias` | ✅ | 01-04 |
| `--dry-run` | ❌ | 只定位不点 |
| `--no-force-stop` | ❌ | 沿用前台 |
| `--ssh` | ❌ | 默认 xhs-windows |

## 输出（示例）

```
FOCUS=...splash.SplashActivity
COLLECT_BEFORE=未选中，收藏N，按钮
COLLECT_XY=997,1773
COLLECT_STATE=uncollected
DOUYIN_COLLECT=dry-run
REASON=located-not-tapped
ALIAS=01
```

## 失败出口

| REASON | 含义 |
|--------|------|
| `launch` / `not_douyin` / `dump_feed` | 启动或 dump |
| `collect_btn_missing` | 无收藏 desc |
| `tap_collect` / `dump_after_collect` / `collect_not_confirmed` | 真收藏路径 |
| `exception` | 未捕获 |

## 相关

- 脚本：`ops/douyin-collect.mjs`
- 地图：`skills/douyin/SKILL.md`
- 参照：`ops/douyin-like.mjs`
