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
    note: "DOUYIN_COLLECT=dry-run / COLLECT_BEFORE=未选中，收藏1.1万，按钮 / COLLECT_XY=997,1775 / exit=0"
  - date: 2026-07-31
    device: "01"
    result: dump-fail
    mode: real-action
    note: "real-action: collect 视觉成功（黄星+toast「收藏成功」）/ dump-fail（点后 a11y missing hierarchy）；截图/toast 可作兜底"
  - date: 2026-08-01
    device: "02"
    result: pass
    mode: dry-run
    note: "DOUYIN_COLLECT=dry-run / COLLECT_BEFORE=未选中，收藏8175，按钮 / COLLECT_XY=997,1582 / exit=0"
  - date: 2026-08-01
    device: "02"
    result: pass
    mode: real-action
    note: "DOUYIN_COLLECT=ok / AFTER=已选中，收藏1，按钮 / dump desc 翻转确认；同日另条黄星截图+dump 双齐（tmp-know/collect-shot-02-*）"
depends:
  - device-tap
  - device-dump
  - device-focus
  - shared/parse
---

# 抖音收藏（douyin-collect）

> 推荐 Feed 右侧栏收藏。dry-run 跑绿即 v1.0。真藏：02 已 dump 翻转确认 ok；01 曾 dump-fail（截图兜底）。

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
→ 已选中 → skip；--dry-run → dry-run
→ 否则 tap → settle → dump 最多 4 次重试读 afterDesc
→ 无 afterBtn → dump_after_collect；未翻转 → collect_not_confirmed
→ bizRecord(op:"douyin-collect")
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--alias` | ✅ | 01-04（集合勿加未登录机，见地图元信息） |
| `--dry-run` | ❌ | 只定位不点 |
| `--no-force-stop` | ❌ | 沿用前台 |
| `--ssh` | ❌ | 默认 xhs-windows |

## 输出（示例，非实机值）

```
FOCUS=...splash.SplashActivity
COLLECT_BEFORE=未选中，收藏N，按钮
COLLECT_XY=997,1773
COLLECT_STATE=uncollected
DOUYIN_COLLECT=dry-run
REASON=located-not-tapped
ALIAS=01
```

## 失败出口（与 `ops/douyin-collect.mjs` 对齐）

| REASON | exit | 含义 |
|--------|------|------|
| `launch` | 2 | 启动失败 |
| `not_douyin` | 2 | 前台非抖音 |
| `dump_feed` | 2 | Feed dump 失败 |
| `collect_btn_missing` | 2 | 无收藏 desc |
| `tap_collect` | 2 | 点击失败 |
| `dump_after_collect` | 2 | 点后 dump 失败（含 settle 重试；常见 a11y 死） |
| `collect_not_confirmed` | 2 | dump 到了但 desc 未翻转 |
| `exception` | 4 | 未捕获 |
| （缺 `--alias`） | 4 | 参数错误 |

成功/跳过：`ok`/`skip`/`dry-run` → exit 0；skip 的 REASON=`already-collected`。

## 相关

- 脚本：`ops/douyin-collect.mjs`
- 集合：`ops/douyin-collect-set.mjs` / `ops/douyin-rail-set.mjs`
- 地图：`skills/douyin/SKILL.md`（设备登录态以元信息表为准）
- 参照：`ops/douyin-like.mjs`
