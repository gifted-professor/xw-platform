---
name: xhs-search
description: 小红书搜索关键词并解析结果卡片。支持翻页和跨页去重。
triggers:
  - xhs-search
  - 小红书搜索
  - 搜索笔记
  - 搜索
version: "1.1"
verified:
  - date: 2026-07-28
    device: "02"
    result: pass
    note: "--pages 2 实测：PAGE1=4→PAGE2 fresh=4→COUNT=8"
depends:
  - device-tap
  - device-dump
  - device-input
  - device-swipe
  - shared/parse
  - shared/preflight
changelog:
  - version: "1.1"
    date: 2026-07-28
    change: "支持 --pages N 翻页，跨页 title+author 去重，focus 漂走/无新卡即停"
---

# 小红书搜索（xhs-search）

## 用法

```bash
# 搜索第 1 页
node ops/xhs-search.mjs --alias <01-04> --session-file <explorer-session.json> --keyword "关键词"

# 搜索多页
node ops/xhs-search.mjs --alias <01-04> --session-file <explorer-session.json> --keyword "关键词" --pages 3

# Windows 本地
set XHS_LOCAL=1
node ops/xhs-search.mjs --alias 01 --session-file <explorer-session.json> --keyword "关键词"
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--alias` | ✅ | 设备别名 01-04 |
| `--keyword` | ✅ | 搜索关键词 |
| `--pages` | ❌ | 翻页数（默认 1） |

## 输出

```
PAGE1=4
PAGE2 fresh=4
COUNT=8
PAGES_DONE=2
```

## 翻页规则（v1.1）

- swipe up 翻页
- 跨页 title+author 去重
- focus 漂走或无新卡即停
- `--pages 1` 行为不变（向后兼容）

## 相关

- 综合互动（可搜索后互动）：`skills/xhs/xhs-engage`
- 解析库：`skills/shared/parse`
