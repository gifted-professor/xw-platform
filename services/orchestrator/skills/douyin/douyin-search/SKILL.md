---
name: douyin-search
description: 抖音搜索关键词，进结果页记录 Tabs 与卡片粗计数，back 回 Splash 壳。只读探索型，不点开卡片不翻页。
triggers:
  - douyin-search
  - 抖音搜索
version: "1.0"
verified:
  - date: 2026-07-31
    device: "01"
    result: pass
    note: "真机：DOUYIN_SEARCH=ok / TABS=综合,团购,视频,用户,图文,直播 / COUNT=6 / BACK_HOME=yes / exit=0"
changelog:
  - version: "1.0"
    date: 2026-07-31
    change: "01 真机验收通过（搜索→结果页→back 回壳），升 v1.0"
  - version: "0.1"
    date: 2026-07-31
    change: "首个抖音业务脚本，对齐 01 烟测 SMOKE=ok"
depends:
  - device-tap
  - device-dump
  - device-input
  - device-back
  - device-focus
  - shared/parse
---

# 抖音搜索（douyin-search）

> 首个抖音业务脚本。`v1.0` / `verified:true`——01 真机验收通过（2026-07-31：搜索→结果页→back 回壳）。

## 用法

```bash
# Mac（默认 SSH → Windows）
node ops/douyin-search.mjs --alias 01 --keyword 阿勒泰

# 不 force-stop（沿用当前前台）
node ops/douyin-search.mjs --alias 01 --keyword 阿勒泰 --no-force-stop

# Windows 本机
set XHS_LOCAL=1
node ops/douyin-search.mjs --alias 01 --keyword 阿勒泰
```

## 流程

```
launch com.ss.android.ugc.aweme (--force-stop) → settle 5.5s
→ dump 首页 → 找顶栏搜索入口（text/desc="搜索"，fallback 1009,145）→ tap
→ dump 搜索建议页 → 找 EditText 输入框 → input-text <keyword> --enter
→ settle 3.8s → focus 验 SearchResultActivity → dump 结果页
→ extractTabs(综合/视频/用户/图文/直播/团购) + countCards
→ back 1-3 次 → focus 验回到 SplashActivity 壳
→ bizRecord(op:"douyin-search", ok) → exit 0
```

只读：不点开卡片、不进详情、不翻页（留 v0.2）。

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--alias` | ✅ | 设备别名 01-04 |
| `--keyword` | ✅ | 搜索词（别名 `--text`） |
| `--no-force-stop` | ❌ | 不 force-stop，沿用前台 |
| `--ssh` | ❌ | SSH host，默认 `xhs-windows` |

## 输出

```
SEARCH_ENTRY=搜索@1009,145
INPUT_XY=521,144
FOCUS=...search.activity.SearchResultActivity
TABS=综合,团购,视频,用户,图文,直播
TAB_COUNT=6
COUNT=6
DUMP=C:\Users\Public\xhs-agent-runs\...\douyin-01-*.xml
BACK_HOME=yes
DOUYIN_SEARCH=ok
ALIAS=01
```

> `TABS` 由 `extractTabs` 按 **x 坐标排序去重**，是 DOM 落点顺序，**非视觉从左到右顺序**（实机 01 落 `综合,团购,视频,用户,图文,直播`）。`COUNT` 是 `countCards` 启发式粗计数（clickable + 较大 + 结果区），仅参考，非精确卡片数。

## 验证

- `FOCUS` 含 `SearchResultActivity`
- `TABS` 含 `综合`（默认 Tab）
- `BACK_HOME=yes`（回到 Splash 壳）
- biz trace 落 `kind:biz op:douyin-search outcome:ok`，Mac 可 `ssh xhs-windows 'node .../_trace-pitfall.mjs --evidence "kind:biz op:douyin-search" --json'` 复核

**自由度**：✅ 完全自主。只读搜索，不外发。

## 失败出口

| REASON | 含义 |
|--------|------|
| `launch` | 启动失败 |
| `dump_home` / `dump_search_suggest` / `dump_results` | 各阶段 dump 丢失 |
| `tap_search`（隐含） | 入口 tap 未进搜索页 |
| `input_keyword` | input-text 非 0 退出 |
| `not_search_result` | focus 不是 SearchResultActivity |
| `exception` | main().catch 兜底 |

所有 fail 出口走 `bizRecord(outcome:"fail")` 同步落盘再 exit。

## 前置条件

1. `explore-preflight` 通过（派工前，脚本内不跑）
2. 抖音已登录

## 坑点（见 [`shared/pitfalls.md`](../../shared/pitfalls.md#抖音douyin) 抖音章）

- SplashActivity 名误导：四 Tab 都挂 SplashActivity，回壳只验 SplashActivity 不验具体 Tab
- settle 比 XHS 慢：launch 后 5.5s、input 后 3.8s
- 结果页无底栏：back 退出，不靠底栏

## 相关

- 抖音能力地图：[`skills/douyin/SKILL.md`](../SKILL.md)
- 小红书对照：[`skills/xhs/xhs-search`](../../xhs/xhs-search/SKILL.md)
- 提案证据：[`ops/proposal-TEMPLATE.md`](../../../ops/proposal-TEMPLATE.md)