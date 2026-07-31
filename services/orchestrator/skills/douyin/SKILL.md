---
name: douyin
description: 抖音 App 能力地图与探索沉淀总入口。路由到具体 douyin-* skill（待固化），承载页面 dump 能力、可复用操作、红线。
triggers:
  - douyin
  - 抖音操作
  - 抖音能力地图
version: "0.1"
verified: false
---

# 抖音能力地图（douyin）

> 一句话：抖音整 App 探索产出（01 / 2026-07-31）的**唯一权威落点**。探索散条（`explore-douyin-*` knowledge）在此聚合；单 op 固化后下沉为 `skills/douyin/<op>/SKILL.md`。
> **本页是草稿固化中**（`v0.1` / `verified:false`，探索产出未真机脚本固化）。真机固化后升 `v1.0`。

## 元信息

| 项 | 值 |
|----|----|
| 包名 | `com.ss.android.ugc.aweme` |
| 探索设备 | 01 / `REPLACE_SERIAL_01` |
| 账号 | 小碗就爱买买买 / 抖音号 `54682422630` |
| 探索日期 | 2026-07-31 |
| 探索源 | Windows 草稿 `tmp-know/douyin-explore-01.md`（未入 git，停车场）；本页为其正式沉淀 |
| context dumps | `C:\Users\Public\xhs-agent-runs\ops-trace\context\douyin-01-*.xml` |

## 壳与 Activity

| 场景 | Activity | dump 情况 |
|------|----------|-----------|
| 首页/朋友/消息/我（四 Tab） | `…splash.SplashActivity` | 推荐 Feed 可 dump；朋友/关注易空 |
| 搜索 | `…search.activity.SearchResultActivity` | 好，无底栏 |
| 拍摄 | `…shortvideo.ui.VideoRecordNewActivity` | 好，常先弹 MIUI 权限 |
| 设置 | `…setting.ui.DouYinSettingNewVersionActivity` | 好 |
| 作者流/日常 | `…detail.ui.DetailActivity` | 可能先弹「限时日常」介绍 |

**坑**：四 Tab 都叫 SplashActivity，判 Tab 看底栏文案不看 Activity（见 [`shared/pitfalls`](../shared/pitfalls.md#抖音douyin)）。

## 底栏五键（1080 宽，~y2289）

| Tab | text | desc | 约坐标 | dump |
|-----|------|------|--------|------|
| 首页 | `首页` | — | ~[108,2289] | 推荐 Feed 可 dump |
| 朋友 | `朋友` | — | ~[324,2289] | **易空 → 截图兜底** |
| 拍摄 | — | `拍摄，按钮` | ~[540,2289] | → 录制页 / 权限框 |
| 消息 | `消息` | — | ~[756,2289] | 好：互动/陌生人/会话 |
| 我 | `我` | — | ~[972,2289] | 好，偶发安全弹窗 |

底栏 text 常 `clickable=false`，**点中心坐标仍有效**。

## 页面 dump 能力地图

| 页面 | dump 能力 | 定位策略 | 备注 |
|------|-----------|----------|------|
| 推荐 Feed | ✅ | 右侧栏 content-desc 极好 | 上滑切条偶发空 dump，settle 2-5s |
| 搜索页/结果 | ✅ | text + 卡片 bounds | input-text 中文已通 |
| 消息 Tab | ✅ | 列表 text | 只观察，不私信 |
| 我 Tab | ✅ | 资料 + 服务条 | 钱包只观察，不进支付 |
| 设置页 | ✅ | 列表 text | 不进支付设置 |
| 评论面板 | ✅ | 半屏列表 | 挂 SplashActivity，back 关 |
| 分享面板 | ✅ | 好友头像 + 动作 | 取消关闭，不真分享 |
| 朋友 Tab | ⚠️ | **截图优先** | dump 常空 |
| 关注顶栏 Tab | ⚠️ | **截图优先** | dump 易空 |
| 拍摄页 | ✅ | 控件 desc | 选拒绝权限，只观察 |
| 侧边栏 | ⚠️ | 内容随状态变 | 勿写死假设 |

## 推荐 Feed 右侧栏（content-desc 模式，可直接定位）

| 控件 | desc 模式 | 可做 |
|------|-----------|------|
| 作者头像/名 | 昵称；下方 `关注` | 关注（待固化） |
| 点赞 | `未点赞，喜欢N，按钮` | 点赞（dry-run 可，desc 翻转校验待验） |
| 评论 | `评论N，按钮` | 打开评论面板 |
| 收藏 | `未选中，收藏N，按钮` | 收藏（desc 翻转校验待验） |
| 分享 | `分享N，按钮` | 打开分享面板 |
| 音乐 | `音乐，…，按钮` | — |

## 已探索 op（待固化成 `skills/douyin/<op>/`）

| op | 探索状态 | 可固化？ | 自由度 | 下一步 |
|----|----------|----------|--------|--------|
| search | ✅ 已固化 [`douyin-search`](douyin-search/SKILL.md) v1.0 / `verified:true` | — | 自主 | 01 真机验收通过（2026-07-31） |
| like | ✅ 已固化 [`douyin-like`](douyin-like/SKILL.md) v1.0 / `verified:true`（dry-run） | ✅ dry-run | 自主（dry-run） | 01 dry-run 验收通过（2026-07-31）；真赞 desc 翻转待验 |
| collect | ✅ 已固化 [`douyin-collect`](douyin-collect/SKILL.md) | ✅ dry-run | 自主（dry-run） | 真藏 desc 翻转待验 |
| comment | 面板已摸清 | ⚠️ | **真发需审批** | 固化时只到打开面板 |
| follow | 右侧栏 `关注` | ✅ | 自主 | 待验 |
| dm | 消息 Tab 已摸清 | ⚠️ | **真发需审批** | 只观察 |
| publish/shoot | 拍摄入口已摸 | 🔴 | **红线** | 只到拒绝权限，不上传 |

> 业务脚本固化后接 `bizRecord({op:"douyin-<op>",...})`，进 biz evidence（见 `ops/_biz-trace.mjs`）。探索期无 ops 脚本 → 无 biz 证据属正常（见 `ops/proposal-TEMPLATE.md` §6）。

## 红线（抖音专属补充）

| 禁止 | 原因 |
|------|------|
| 支付 / 进钱包操作 / 支付设置 | 资金安全 |
| 拍摄 / 上传 / 开直播 / 真发布 | 不可逆外发 |
| 真发评论 / 真发私信 | 需人审批 |
| 硬闯相机权限选「允许」再拍 | 同拍摄红线 |
| 完善账号安全弹窗点「去完善」 | 改账号信息，仅人 |
| 遇验证码/风控继续点 | 账号安全 |

其余继承根 [`SKILL.md`](../SKILL.md) 红线。

## 操作手册（探索期，给下次 agent）

```bash
set XHS_LOCAL=1
node ops/explore-preflight.mjs --alias 01
node ops/launch-app.mjs --alias 01 --package com.ss.android.ugc.aweme --force-stop
# 等 5-6s 再 dump（抖音 settle 比 XHS 慢）
node ops/dump-ui.mjs --alias 01
```

| 目标 | 做法 |
|------|------|
| 空 dump | sleep 重试 → 仍空 screenshot；顽固 force-stop |
| 朋友/关注 Tab | 优先截图 |
| 评论/分享 | 右侧栏 desc 点；back/取消退出 |
| 搜索 | tap 搜索 → input-text → tap 搜索按钮 |
| 拍摄 | 拒绝权限；关闭退出 |

## 还没细挖（下一轮探索）

- 直播间 / 商城下单路径（只看到入口，**不买**）
- 用户主页稳定进入法（点 @昵称 vs 头像）
- 关注 Tab dump 稳定后结构
- 团购/同城页
- 点赞/收藏 desc 翻转校验（dry-run）

## 进化链

```
explorer.md 派工 (app:douyin)
  → 22222 通道 dump/tap/input（App 无关）
  → explore-douyin-* knowledge + 本页能力地图回写
  → Mac 固化 skills/douyin/<op>/SKILL.md + ops/douyin-*.mjs（挂 bizRecord）
  → 真机验证 → verified:true v1.0
```

## 相关

- 探索契约：[`modes/explorer.md`](../../modes/explorer.md)
- 坑点（抖音）：[`shared/pitfalls.md`](../shared/pitfalls.md#抖音douyin)
- 小红书对照：[`xhs/SKILL.md`](../SKILL.md) 路由表
- 提案证据：[`ops/proposal-TEMPLATE.md`](../../ops/proposal-TEMPLATE.md)