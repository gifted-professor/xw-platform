# Skill 串行可行性验收（2026-07-31）

环境：`C:\Users\Public\xhs-registry`，本地模式（win32 / `XHS_LOCAL=1`）。顺序：**01 → 02 → 04**（跳过 03）。全程串行。

范围：原子层真跑；业务 dry-run / 只搜 / 打开入口。**未跑**真点赞、收藏、关注、评论、私信、发布、存草稿。

原始日志：`tmp-know/serial-validate-{01,02,04}.jsonl`

## 总览

| 设备 | 结果 | 备注 |
|------|------|------|
| 01 | **全绿**（20/20） | ~160s |
| 02 | **全绿**（20/20） | ~165s |
| 04 | **通过（含 1 次重试）** | 首轮 `follow-dry-run` 因更新弹窗失败；dismiss+launch 后重试绿 |

**结论：三机 Explorer skill 链路可行；本地短路 + 22222 执行面正常。**

---

## 01（serial=1511f78c）

| 步骤 | exit | 关键 KV |
|------|------|--------|
| preflight | 0 | ok |
| focus / dump-ui / screenshot | 0 | ok |
| swipe / back / shell | 0 | SWIPE/BACK/SHELL=ok |
| launch-app / tap-home | 0 | LAUNCH=ok TAP=ok |
| search | 0 | SEARCH=ok COUNT=4 |
| like / collect / follow dry-run | 0 | *=dry-run |
| comment / engage dry-run | 0 | COMMENT=dry-run ENGAGE=dry-run |
| dm-open | 0 | DM=ok MODE=open-only |
| publish-entry | 0 | PUBLISH_ENTRY=ok PUBLISHED=no |
| cleanup | 0 | IndexActivityV2 |

---

## 02（serial=9b18cccb）

| 步骤 | exit | 关键 KV |
|------|------|--------|
| preflight | 0 | ok |
| atomics（含 focus 初为桌面，launch 后进 XHS） | 0 | 全绿 |
| search | 0 | SEARCH=ok COUNT=3 |
| like / collect / follow dry-run | 0 | *=dry-run |
| comment / engage dry-run | 0 | dry-run |
| dm-open | 0 | DM=ok MODE=open-only |
| publish-entry | 0 | PUBLISH_ENTRY=ok PUBLISHED=no |
| cleanup | 0 | IndexActivityV2 |

---

## 04（serial=H6NNHU8LLFHAIRLV）

| 步骤 | exit | 关键 KV / 备注 |
|------|------|----------------|
| preflight | 0 | ok |
| atomics | 0 | 初 focus=支付宝登录页；launch 后进 XHS |
| search | 0 | SEARCH=ok（FOCUS 仍 Index，卡片弱解析但脚本判 ok） |
| like / collect dry-run | 0 | *=dry-run |
| **follow-dry-run（首轮）** | **2** | `FOLLOW=fail REASON=no_feed_card`；`WARN_FOCUS=UpdateDialogActivity` |
| follow-dry-run-retry | 0 | back dismiss → launch → `FOLLOW=dry-run` |
| comment / engage dry-run | 0 | dry-run |
| dm-open | 0 | DM=ok MODE=open-only |
| publish-entry | 0 | PUBLISH_ENTRY=ok PUBLISHED=no |
| cleanup | 0 | IndexActivityV2 |

**04 失败归因**：业务层 UI 状态（应用内更新弹窗遮挡信息流），**非**本地适配/传输问题。与计划「依赖 UI 状态可重试」一致。

---

## 未跑（按计划）

真 like/collect/follow、真评论、`--send` 私信、`xhs-publish-draft` / `--publish`、`xhs-dm-user`、闲鱼 conc、设备 03。

## 建议

1. 业务脚本遇 `UpdateDialogActivity` 可自动 `back` 后重试 feed dump。
2. 04 search 出现 `SEARCH=ok` 但 FOCUS 非搜索页、卡片 title 空——可后续收紧成功判据（本次不挡「skill 可行」）。
