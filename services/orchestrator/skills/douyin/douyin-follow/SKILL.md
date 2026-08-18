---
name: douyin-follow
description: 抖音推荐 Feed 右侧栏定位关注按钮。--dry-run 只定位不点；不加则真关注。
triggers:
  - douyin-follow
  - 抖音关注
version: "1.0"
verified:
  - date: 2026-07-31
    device: "01"
    result: pass
    mode: dry-run
    note: "真机 dry-run：DOUYIN_FOLLOW=dry-run / FOLLOW_BEFORE=关注 / FOLLOW_XY=997,1263 / FOLLOW_STATE=unfollowed / exit=0"
depends:
  - device-tap
  - device-dump
  - device-focus
  - shared/parse
---

# 抖音关注（douyin-follow）

> Feed 右侧栏头像旁「关注」。dry-run 跑绿即 v1.0。真关注留下一轮。

## 用法

```bash
set XHS_LOCAL=1
node ops/douyin-follow.mjs --alias 01 --session-file <explorer-session.json> --dry-run
node ops/douyin-follow.mjs --alias 01 --session-file <explorer-session.json>
```

## 流程

```
launch aweme → settle → dump Feed
→ findFollowBtn：右侧 cx>850、desc/text「关注」（排除顶栏）
→ 已关注 → skip；--dry-run → dry-run；否则 tap → dump 校验
→ bizRecord(op:"douyin-follow")
```

## 输出（示例）

```
FOLLOW_BEFORE=关注
FOLLOW_XY=997,1263
FOLLOW_STATE=unfollowed
DOUYIN_FOLLOW=dry-run
REASON=located-not-tapped
ALIAS=01
```

## 相关

- `ops/douyin-follow.mjs`
- `skills/douyin/SKILL.md`
