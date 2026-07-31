---
name: xhs-like
description: 打开小红书信息流中的一条笔记并点赞。使用 session 模式传输，自动 dump 定位点赞按钮。
triggers:
  - xhs-like
  - 小红书点赞
  - 点赞笔记
  - 点赞
version: "1.0"
verified:
  - date: 2026-07-28
    device: "01"
    result: pass
    note: "dry-run 定位准确，全流程 17.18s"
depends:
  - device-tap
  - device-dump
  - device-back
  - device-focus
  - shared/parse
  - shared/preflight
---

# 小红书点赞（xhs-like）

## 用法

```bash
# 实际执行（打开一条笔记并点赞）
node ops/xhs-like-one.mjs --alias <01-04>

# 只定位不点赞（dry-run）
node ops/xhs-like-one.mjs --alias <01-04> --dry-run

# Windows 本地
set XHS_LOCAL=1
node ops/xhs-like-one.mjs --alias 01 --dry-run
```

## 流程

```
打开小红书 → 等待信息流加载 → dump 定位第一条笔记
→ 点击进入笔记详情 → dump 定位点赞按钮 → tap 点赞
→ re-dump 验证 → 返回主页
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--alias` | ✅ | 设备别名 01-04 |
| `--dry-run` | ❌ | 只定位不执行 |

## 验证

- 点赞按钮文本从 `点赞` 变为 `已点赞`
- 或点赞计数 +1

## 前置条件

1. `explore-preflight` 通过
2. 小红书已登录

**自由度**：✅ 完全自主，不需要问人，直接做。

## 注意事项

- 使用 `openWinXwSession()` 常驻连接，传输延迟 ~40ms
- 全流程约 17s（其中 ~7s UI sleep + ~7s dump）
- 点赞按钮定位用 `findLikeBtn()`，不硬编码坐标

## 坑点

- 如果信息流未加载，增加等待时间
- 如果笔记是视频，可能需要额外处理

## 相关

- 收藏：`skills/xhs/xhs-collect`
- 综合互动：`skills/xhs/xhs-engage`
- 解析库：`skills/shared/parse`
