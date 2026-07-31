---
name: xhs-follow
description: 打开小红书笔记详情页并关注作者。关注按钮四态感知，已关注幂等跳过。
triggers:
  - xhs-follow
  - 小红书关注
  - 关注作者
  - 关注
version: "1.1"
verified:
  - date: 2026-07-28
    device: "01"
    result: pass
    note: "dry-run 定位准确 FOLLOW_XY=846,161"
depends:
  - device-tap
  - device-dump
  - device-back
  - shared/parse
  - shared/preflight
changelog:
  - version: "1.1"
    date: 2026-07-29
    change: "findFollowBtn 收紧为 exact-set 等值匹配，followState 修正回关→unfollowed"
---

# 小红书关注（xhs-follow）

## 用法

```bash
# 实际执行
node ops/xhs-follow-one.mjs --alias <01-04>

# 只定位不关注（dry-run）
node ops/xhs-follow-one.mjs --alias <01-04> --dry-run
```

## 流程

```
打开小红书 → 信息流 → 进入笔记详情 → dump 定位作者区域
→ 分类关注按钮四态 → 已关注则幂等跳过 → 否则 tap 关注
→ re-dump 验证 afterState → 返回主页
```

## 关注按钮四态

| 文本 | 状态 | 动作 |
|------|------|------|
| `关注` | unfollowed | tap 关注 |
| `已关注` | followed | 幂等跳过 |
| `回关` | unfollowed | tap 回关（对方关注你） |
| `相互关注` | followed | 幂等跳过 |

## 验证

- afterState 明确翻到 `followed`（已关注/相互关注）才算成功
- after 空 ≠ 成功

## 坑点

- `pitfall-follow-btn-state-20260729`：旧版精确匹配 `关注`，关注后变 `已关注` 找不到 → 误判失败。已修。

## 相关

- 点赞：`skills/xhs/xhs-like`
- 解析库：`skills/shared/parse`
- 坑点手册：`skills/shared/pitfalls`
