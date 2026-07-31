---
name: douyin-like
description: 抖音推荐 Feed 右侧栏定位点赞按钮。默认 --dry-run 只定位不点；不加则真点赞。
triggers:
  - douyin-like
  - 抖音点赞
version: "1.0"
verified:
  - date: 2026-07-31
    device: "01"
    result: pass
    mode: dry-run
    note: "真机 dry-run：DOUYIN_LIKE=dry-run / LIKE_BEFORE=未点赞，喜欢20.4万，按钮 / LIKE_XY=998,1399 / LIKE_STATE=unliked / exit=0。真赞 desc 翻转校验留下一轮。"
changelog:
  - version: "1.0"
    date: 2026-07-31
    change: "01 真机 dry-run 验收通过（定位点赞按钮、读 desc=未点赞），升 v1.0；真赞未验"
  - version: "0.1"
    date: 2026-07-31
    change: "第二个抖音业务脚本，对齐能力地图 desc 模式"
depends:
  - device-tap
  - device-dump
  - device-focus
  - shared/parse
---

# 抖音点赞（douyin-like）

> 第二个抖音业务脚本。`v1.0` / `verified:true`（dry-run）——01 真机 dry-run 验收通过（2026-07-31：定位点赞按钮、读 desc=未点赞）。真赞 desc 翻转校验留下一轮。
> 对齐能力地图：desc「未点赞，喜欢N，按钮」。

## 用法

```bash
# 推荐：只定位不点
set XHS_LOCAL=1
node ops/douyin-like.mjs --alias 01 --dry-run

# 真点赞（自主；会改赞状态）
node ops/douyin-like.mjs --alias 01

# 不 force-stop
node ops/douyin-like.mjs --alias 01 --dry-run --no-force-stop
```

## 流程

```
launch com.ss.android.ugc.aweme (--force-stop) → settle 5.5s
→ dump 推荐 Feed（空 dump settle 重试）
→ findLikeBtn：desc 含「喜欢」+「按钮」、cx>850
→ 已点赞 → skip；--dry-run → dry-run 退出；否则 tap → dump 校验 desc 翻转
→ bizRecord(op:"douyin-like")
```

在 Feed 右侧栏操作，**不进详情**。

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--alias` | ✅ | 01-04 |
| `--dry-run` | ❌ | 只定位不点（首版验收用这个） |
| `--no-force-stop` | ❌ | 沿用前台 |
| `--ssh` | ❌ | 默认 `xhs-windows` |

## 输出

```
FOCUS=...splash.SplashActivity
LIKE_BEFORE=未点赞，喜欢20.4万，按钮
LIKE_XY=998,1399
LIKE_STATE=unliked
DUMP=...
DOUYIN_LIKE=dry-run
REASON=located-not-tapped
ALIAS=01
```

## 验证（dry-run）

- `LIKE_STATE=unliked` 或 `liked`（skip）
- `LIKE_XY` 有值，`LIKE_BEFORE` 含「喜欢」
- `DOUYIN_LIKE=dry-run`（或 skip）
- biz：`kind:biz op:douyin-like outcome:dry-run|skip`

**自由度**：dry-run ✅ 自主；真点赞 ✅ 自主（根 SKILL 赞藏关自主），首版建议先 dry-run 升 v1.0。

## 失败出口

| REASON | 含义 |
|--------|------|
| `launch` | 启动失败 |
| `not_douyin` | 前台非抖音 |
| `dump_feed` | Feed dump 失败 |
| `like_btn_missing` | 右侧栏无点赞 desc |
| `tap_like` | 点击失败 |
| `dump_after_like` | 点后 dump 失败 |
| `like_not_confirmed` | desc 未翻转 |
| `exception` | 未捕获异常 |

## 坑点

- Feed 上滑后偶发空 dump → settle 重试（`pitfall-douyin-swipe-empty-dump-20260731`）
- SplashActivity 名误导 → 只验包名 aweme（`pitfall-douyin-splash-activity-name-20260731`）
- 真点赞会改账号互动状态；验收默认 `--dry-run`

## 相关

- App 地图：`skills/douyin/SKILL.md`
- 脚本：`ops/douyin-like.mjs`
- 参照：`ops/douyin-search.mjs` / `ops/xhs-like-one.mjs`
