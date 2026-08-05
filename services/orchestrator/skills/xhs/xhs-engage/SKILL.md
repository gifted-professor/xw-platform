---
name: xhs-engage
description: 小红书综合互动（点赞+收藏+评论）。可选搜索目标笔记，支持单动作组合。
triggers:
  - xhs-engage
  - 小红书互动
  - 综合互动
  - 赞藏评
version: "1.0"
verified:
  - date: 2026-07-28
    device: "01"
    result: pass
depends:
  - xhs-like
  - xhs-collect
  - xhs-comment
  - device-tap
  - device-dump
  - shared/parse
  - shared/preflight
---

# 小红书综合互动（xhs-engage）

## 用法

```bash
# 点赞+收藏
node ops/xhs-engage-one.mjs --alias <01-04> --session-file <explorer-session.json> --like --collect

# 点赞+收藏+评论
node ops/xhs-engage-one.mjs --alias <01-04> --session-file <explorer-session.json> --like --collect --comment "好内容！"

# 先搜索再互动
node ops/xhs-engage-one.mjs --alias <01-04> --session-file <explorer-session.json> --search "关键词" --like --collect

# dry-run
node ops/xhs-engage-one.mjs --alias <01-04> --session-file <explorer-session.json> --like --collect --dry-run
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--alias` | ✅ | 设备别名 01-04 |
| `--like` | ❌ | 点赞 |
| `--collect` | ❌ | 收藏 |
| `--comment <text>` | ❌ | 评论（R2 外发） |
| `--search <keyword>` | ❌ | 先搜索再互动 |
| `--dry-run` | ❌ | 只定位不执行 |

## 流程

```
[可选搜索] → 打开笔记 → 逐个执行 like/collect/comment
→ 每个动作独立验证 → 返回主页
```

## 注意事项

- 评论是 R2 外发动作，lab 通道不算生产验收
- 每个动作独立验证，单个失败不影响其他动作
- 收藏验证用计数比对（v1.1 规则）

## 相关

- 单独点赞：`skills/xhs/xhs-like`
- 单独收藏：`skills/xhs/xhs-collect`
- 单独评论：`skills/xhs/xhs-comment`
