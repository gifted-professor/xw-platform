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
| 探索设备 | 01 / `REPLACE_SERIAL_01`（探索主机） |
| 账号（01） | 小碗就爱买买买 / 抖音号 `54682422630` |
| 探索日期 | 2026-07-31 |
| 探索源 | Windows 草稿 `tmp-know/douyin-explore-01.md`（未入 git，停车场）；本页为其正式沉淀 |
| context dumps | `C:\Users\Public\xhs-agent-runs\ops-trace\context\douyin-01-*.xml` |

### 设备清单与可用性（集合默认只跑已登录可用机）

| alias | serial | 登录态 | 可用性 | 集合 | 备注 |
|-------|--------|--------|--------|------|------|
| 01 | `REPLACE_SERIAL_01` | **已登录** | 正常（推荐 Feed / 右侧栏可用） | ✅ 默认 | 探索主机；偶发 dump 抖，force-stop 可恢复 |
| 02 | `REPLACE_SERIAL_02` | **已登录** | 正常 | ✅ 默认 | 曾弹青少年模式「我知道了」，过引导后 Feed 可用 |
| 03 | `REPLACE_SERIAL_03` | 未核 | `ready!=true` / 不在 17910 | ❌ | preflight 失败，暂不入集合 |
| 04 | `REPLACE_SERIAL_04` | **未登录** | Feed/右侧栏不可用（`dump_feed`/空层） | ❌ | **根因是未登录**，勿写成「青少年模式」或单纯 a11y；登录后再纳入 |

> 04 归因以本表为准。`tmp-know` 短报若仍写「青少年/空 dump」属旧说法，已废弃。

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
| 消息 Tab | ✅ | 列表优先 content-desc | 会话可进；历史靠上滑+dump；真发私信需审批 |
| 私信/群聊会话 | ✅ | 时间戳+正文 text（1:1 更好） | 无 bulk 导出；翻旧可持续；见 max-playbook |
| 互动消息 | ✅ | `IntegratedInteractionActivity` | 赞/藏/评通知 |
| 我的互动（本人评论档案） | ✅ | `ArchiveInteractiveActivity` | 我→全部功能→我的互动 |
| 观看历史 | ⚠️ | `AnnieXHostActivity` 多 content-desc | 卡片标题在 desc |
| 我 Tab | ✅ | 资料 + 服务条 | 钱包只观察，不进支付 |
| 设置页 | ✅ | 列表 text | 不进支付设置 |
| 评论面板 | ✅ | 半屏列表 | 挂 SplashActivity，back 关 |
| 分享面板 | ✅ | 好友头像 + 底栏横滑动作 | 取消关闭，不真分享/私信 |
| 长按菜单 | ✅ | 中部长按（swipe 同点 1.5s） | 无下载；有清屏/识别图片/倍速等 |
| 图搜（识别图片） | ✅ | `VisualSearchActivity` | 长按→识别图片；综合/商品 |
| 清屏播放 | ✅ | 长按→清屏播放 | 专注模式；退出/暂停/倍速/全屏 |
| 生成图片→存相册 | ✅ | 分享底栏「生成图片」 | 可「保存至相册」（帧/卡片图，非原片） |
| 保存本地（视频） | ⚠️ | 分享底栏「保存本地」 | 常灰=作者禁下；enabled 不可靠 |
| 图文实况/Live | ✅ | 搜索→图文→`FlowPageActivity`；角标 `text=实况` | 分享→「保存至相册」→`DCIM/Camera/VIDEO*.mp4` |
| 评论动图/Live | ✅ | 评论附图查看器；角标 **「动图」**；**下滑切下一条评论图** | 长按→「保存到相册」→`Pictures/douyin/comment/comment_*.mp4` |
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
| 分享 | `分享N，按钮` | 打开分享面板（底栏横滑含保存本地/生成图片等） |
| 音乐 | `音乐，…，按钮` | — |

### 长按视频中部（~400,1100，避开右侧栏）

| 菜单项 | 可做 | 备注 |
|--------|------|------|
| 推荐 / 转发到日常 / 合拍 | 观察 | 转发属外发，探索勿真点好友 |
| 不感兴趣 / 举报 | 观察 | 举报只看到列表即 back |
| 倍速 | 可调 | 0.75–3.0 |
| 清屏播放 | ✅ | 专注模式；`退出专注模式` |
| 识别图片 | ✅ | → 图搜 Activity |
| 添加至稍后再看 | 可点 | — |
| （无「下载/保存」） | — | **下载在分享面板，不在长按** |

### 分享面板底栏（横滑，y≈2159）

约序：转发到日常 → 推荐 → 私信 → 我的群聊 → 帮上热门 → 分享链接 → 身边的人 → 不感兴趣 → **保存本地** → 合拍 → 一起看视频 → **生成图片** → 动态壁纸 → 加桌面伙伴 → 举报 → 播放反馈。  
「生成图片」→ sheet：微信好友 / 朋友圈 / **保存至相册** / 取消（探索只点存相册）。


## 已探索 op（待固化成 `skills/douyin/<op>/`）

| op | 探索状态 | 可固化？ | 自由度 | 下一步 |
|----|----------|----------|--------|--------|
| search | ✅ 已固化 [`douyin-search`](douyin-search/SKILL.md) v1.0 / `verified:true` | — | 自主 | 01 真机验收通过（2026-07-31） |
| like | ✅ 已固化 [`douyin-like`](douyin-like/SKILL.md) v1.0 / `verified:true`（dry-run） | ✅ dry-run | 自主（dry-run） | 见 like-set |
| like-set | ✅ 已固化 [`douyin-like-set`](douyin-like-set/SKILL.md) | ✅ dry-run 多机 | 自主 | 默认 01,02；勿加 04（未登录） |
| collect | ✅ 已固化 [`douyin-collect`](douyin-collect/SKILL.md) | ✅ dry-run；02 真藏 dump ok | 自主 | 01 曾 dump-fail（截图兜底）；见 collect-set |
| collect-set | ✅ 已固化 [`douyin-collect-set`](douyin-collect-set/SKILL.md) | ✅ dry-run 多机 | 自主 | 默认 01,02；勿加 04 |
| rail-set | ✅ 已固化 [`douyin-rail-set`](douyin-rail-set/SKILL.md) | ✅ dry-run 三连 | 自主 | like→collect→follow @01,02 |
| comment | ✅ 真发通；默认=最高赞纯文字复制 | ✅ | 已授权真发 | 上滑3次→取赞最高纯文字→发送→再赞；见 max-playbook |
| comment-reply | ✅ 打开/输入/发送 @02 | ✅ | 已授权 | 脚本 `tmp-know/exp-max-02/comment-copy-top-liked.mjs` |
| longpress | ✅ 菜单已枚举（2026-08-01 @02） | 观察向 | 自主 | 见短报；无下载项 |
| share-save | ✅ 分享底栏+生成图片路径已摸 | ⚠️ 视频常禁下 | 自主（仅本地） | 存相册可；保存本地看作者 |
| visual-search | ✅ 识别图片→图搜 | 观察向 | 自主 | VisualSearchActivity |
| clear-screen | ✅ 清屏播放 | 观察向 | 自主 | 专注模式 |
| live-photo | ✅ 图文实况可识别+可下（2026-08-01） | ✅ 本地下载 | 自主 | 详情 `实况`；保存至相册→mp4；见短报 |
| follow | ✅ 已固化 [`douyin-follow`](douyin-follow/SKILL.md) | ✅ dry-run | 自主（dry-run） | 见 follow-set |
| follow-set | ✅ 已固化 [`douyin-follow-set`](douyin-follow-set/SKILL.md) | ✅ dry-run 多机 | 自主 | 默认 01,02；勿加 04 |
| dm | ✅ 1:1 真发通 @02 | ✅ | 已授权真发 | 列表点 desc 行（勿点顶栏故事圈）；发前清草稿；面板有红包/转账=红线不点 |
| dm-history | ✅ 可持续上滑采集 | ✅ 只读 | 自主 | 逐屏 dump 拼接；非一键全量 |
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
node ops/launch-app.mjs --alias 01 --session-file <explorer-session.json> --package com.ss.android.ugc.aweme --force-stop
# 等 5-6s 再 dump（抖音 settle 比 XHS 慢）
node ops/dump-ui.mjs --alias 01 --session-file <explorer-session.json>
```

| 目标 | 做法 |
|------|------|
| 空 dump | sleep 重试 → 仍空 screenshot；顽固 force-stop |
| 朋友/关注 Tab | 优先截图 |
| 评论/分享 | 右侧栏 desc 点；back/取消退出 |
| 长按菜单 | 中部 `input swipe x y x y 1500`；下载不在此 |
| 保存视频 | 分享→横滑「保存本地」（常灰）；帧图：分享→生成图片→保存至相册 |
| 搜索 | tap 搜索 → input-text → tap 搜索按钮 |
| 拍摄 | 拒绝权限；关闭退出 |

## 还没细挖（下一轮探索）

- 点赞 desc 翻转校验；收藏 @02 已 dump 翻转 ok（01 偶发 dump-fail）
- 「保存本地」亮起时的成功判据（toast / 相册文件）
- 直播间 / 商城下单路径（只看到入口，**不买**）
- 用户主页稳定进入法（点 @昵称 vs 头像）
- 关注 Tab dump 稳定后结构
- 团购/同城页
- 动态壁纸 / 加桌面伙伴（只观察到入口）

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
