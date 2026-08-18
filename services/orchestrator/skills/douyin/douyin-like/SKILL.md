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
    note: "DOUYIN_LIKE=dry-run / LIKE_BEFORE=未点赞，喜欢20.4万，按钮 / LIKE_XY=998,1399 / LIKE_STATE=unliked / exit=0"
  - date: 2026-07-31
    device: "01"
    result: dump-fail
    mode: real-action
    note: "real-action: like 点后 dump_after_like（a11y 死）；视觉是否成功未截图确认；校验方式待定（截图/toast）"
depends:
  - device-tap
  - device-dump
  - device-focus
  - shared/parse
---

# 抖音点赞（douyin-like）

> 第二个抖音业务脚本。`v1.0` / dry-run 已验。真赞见 `verified` 的 `real-action` 行（dump 校验未稳）。
> 对齐能力地图：desc「未点赞，喜欢N，按钮」。

## 用法

```bash
# 推荐：只定位不点
set XHS_LOCAL=1
node ops/douyin-like.mjs --alias 01 --session-file <explorer-session.json> --dry-run

# 真点赞（自主；会改赞状态）
node ops/douyin-like.mjs --alias 01 --session-file <explorer-session.json>

# 不 force-stop
node ops/douyin-like.mjs --alias 01 --session-file <explorer-session.json> --dry-run --no-force-stop
```

## 流程

```
launch com.ss.android.ugc.aweme (--force-stop) → settle 5.5s
→ dump 推荐 Feed（空 dump settle 重试）
→ findLikeBtn：desc 含「喜欢」+「按钮」、cx>850
→ 已点赞 → skip；--dry-run → dry-run 退出
→ 否则 tap → settle → dump 最多 4 次重试读 afterDesc
→ 无 afterBtn → dump_after_like；desc 未翻转 → like_not_confirmed
→ bizRecord(op:"douyin-like")
```

在 Feed 右侧栏操作，**不进详情**。

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--alias` | ✅ | 01-04（集合勿加未登录机，见地图元信息） |
| `--dry-run` | ❌ | 只定位不点（首版验收用这个） |
| `--no-force-stop` | ❌ | 沿用前台 |
| `--ssh` | ❌ | 默认 `xhs-windows` |

## 输出（示例，非实机值）

```
FOCUS=...splash.SplashActivity
LIKE_BEFORE=未点赞，喜欢N，按钮
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

**自由度**：dry-run ✅ 自主；真点赞 ✅ 自主（根 SKILL 赞藏关自主），主验收用 `--dry-run`。

## 失败出口（与 `ops/douyin-like.mjs` 对齐）

| REASON | exit | 含义 |
|--------|------|------|
| `launch` | 2 | 启动失败 |
| `not_douyin` | 2 | 前台非抖音 |
| `dump_feed` | 2 | Feed dump 失败 |
| `like_btn_missing` | 2 | 右侧栏无点赞 desc |
| `tap_like` | 2 | 点击失败 |
| `dump_after_like` | 2 | 点后 dump 失败（含 4 次 settle 重试仍无按钮；常见 a11y 死） |
| `like_not_confirmed` | 2 | dump 到了但 desc 未翻转 |
| `exception` | 4 | 未捕获异常 |
| （缺 `--alias`） | 4 | 参数错误 |

成功/跳过：`ok`/`skip`/`dry-run` → exit 0；skip 的 REASON=`already-liked`。

## 坑点

- Feed 上滑后偶发空 dump → settle 重试（`pitfall-douyin-swipe-empty-dump-20260731`）
- SplashActivity 名误导 → 只验包名 aweme（`pitfall-douyin-splash-activity-name-20260731`）
- 真赞点后常 `dump_after_like`（与收藏同款 a11y 死，`pitfall-douyin-collect-tap-kills-a11y-dump-20260731`）
- 真点赞会改账号互动状态；验收默认 `--dry-run`

## 相关

- App 地图：`skills/douyin/SKILL.md`
- 脚本：`ops/douyin-like.mjs`
- 集合：`ops/douyin-like-set.mjs` / `ops/douyin-rail-set.mjs`
- 参照：`ops/douyin-search.mjs` / `ops/xhs-like-one.mjs`
