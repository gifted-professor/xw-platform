# Windows Local Ops 验收短报（2026-07-31）

环境：`C:\Users\Public\xhs-registry`，`XHS_LOCAL=1`（win32 自动亦可），设备 **01**（跳过 03）。

## 通过项

| ID | 项 | 结果 |
|----|-----|------|
| C1 | `explore-preflight.mjs --alias 01` | exit 0，`mode=local`，22222 detected |
| C2 | focus / dump-ui / screenshot / swipe / back / shell | 全部 exit 0 |
| C3 | `xhs-like-one --dry-run` | LIKE=dry-run，located-not-tapped（**依赖设备初始状态**：须能进笔记详情并 dump 到点赞按钮；若停在搜索页等，可能 `LIKE=fail REASON=like_btn_missing`——属业务定位，与本地/SSH 无关） |
| C3 | `xhs-collect-one --dry-run` | COLLECT=dry-run |
| C3 | `xhs-search --keyword 探店 --pages 1` | SEARCH=ok，COUNT=4 |

**C3 可复现性**：本地适配链路（REPL / 导航 / dump）与业务按钮定位解耦。复验若遇 `like_btn_missing`，先确认 01 不在搜索页/异常页，或先 `focus`/`launch` 回信息流再跑 dry-run。

## 失败项

无。

## 未跑（按 C4）

真评论 / 真私信 / 真发布 / 真存草稿 — 未执行。

## 授权表述冲突（需后续统一，本次未改行为）

| 位置 | 说法 |
|------|------|
| `ops/xhs-like-one.mjs` 头注释 | Requires human authorization for real likes |
| `skills/xhs/xhs-like/SKILL.md` + 根 SKILL 路线 B | 完全自主，不需要问人 |
| `ops/xhs-follow-one.mjs` / `ops/xhs-engage-one.mjs` 头 | 同类「需人审」 |
| skill 路由表 like/follow/collect | ✅ 自主 |

建议：后续统一到路线 B（改脚本头注释），或改 skill 与脚本头一致。本次 dry-run 验收为准，**未改审批模型**。

## 完成口令

**preflight 01 绿 → 原子 6 项绿 → xhs-like --dry-run 绿** — 达成。
