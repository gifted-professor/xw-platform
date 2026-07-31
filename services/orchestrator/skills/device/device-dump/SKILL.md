---
name: device-dump
description: 获取设备当前 UI 层级 XML dump。是元素定位的首选方式（优先于 vision）。
triggers:
  - device-dump
  - dump
  - UI dump
  - 获取UI
version: "1.0"
verified:
  - date: 2026-07-28
    device: "01"
    result: pass
---

# UI Dump（device-dump）

## 用法

```bash
# 默认输出到 stdout
node ops/dump-ui.mjs --alias <01-04>

# 保存到文件
node ops/dump-ui.mjs --alias <01-04> --out /tmp/dump.xml
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--alias` | ✅ | 设备别名 01-04 |
| `--out` | ❌ | 保存路径（默认 stdout） |

## 输出

```
DUMP=/path/to/dump.xml
```

XML 格式为 Android uiautomator dump，包含所有可见节点的：
- `text` / `content-desc` / `resource-id`
- `bounds`（`[x1,y1][x2,y2]`）
- `clickable` / `focusable` / `scrollable`

## 定位策略

```
默认：dump-first（大部分原生 App）

启发：
  · FlutterBoost / 弱 class（闲鱼等）→ 语义树 / observe 优先
  · dump 全空（微信等）→ vision-only 高成本档
  · 未知 App → 先 dump；空则降级 vision（限次）
```

## 解析

用 `ops/_xhs-parse.mjs` 的解析函数提取结构化数据。详见 `skills/shared/parse.md`。

## 相关

- 点击元素：`skills/device/device-tap`
- 解析库：`skills/shared/parse`
- 坑点手册：`skills/shared/pitfalls.md`
