---
name: wechat
description: 微信 App 能力地图与探索沉淀总入口。dump 空壳→vision-only；路由待固化的 wechat-* skill。
triggers:
  - wechat
  - 微信操作
  - 微信能力地图
version: "0.1"
verified: false
---

# 微信能力地图（wechat）

> 一句话：微信整 App 探索产出（01 / 2026-08-01）的**唯一权威落点**。探索散条在此聚合；单 op 固化后下沉 `skills/wechat/<op>/`。
> **本页是草稿固化中**（`v0.1` / `verified:false`）。真机脚本固化后升 `v1.0`。

## 元信息

| 项 | 值 |
|----|----|
| 包名 | `com.tencent.mm` |
| 版本 | `8.0.64`（versionCode `2940`） |
| 探索设备 | 01 / `REPLACE_SERIAL_01` |
| 账号（01） | 芋圆奥莱四店… / 微信号 `ghyl998` |
| 探索日期 | 2026-08-01 |
| 预算 | **无墙钟上限（R2）**；红线：禁支付；发消息仅白名单会话 |
| 探索源 | `tmp-know/EXPLORE-WECHAT-R2-20260801.md` + R1 笔记/截图 |

### 设备清单与可用性

| alias | serial | 登录态 | 可用性 | 集合 | 备注 |
|-------|--------|--------|--------|------|------|
| 01 | `REPLACE_SERIAL_01` | **已登录** | 正常；dump **空壳** | ✅ 探索主机 | vision-only |
| 02 | `REPLACE_SERIAL_02` | 未核微信 | — | ❌ | 本轮未探 |
| 03 | — | — | — | ❌ | 本轮未探 |
| 04 | — | — | — | ❌ | 本轮未探 |

## dump 能力

| 页面 | dump | 策略 |
|------|------|------|
| 全 App（已测多页） | ❌ 空壳 `NODES=1` bounds=`[0,0][0,0]` | **vision-only**（高成本档） |

## 底栏四键（1080×2400，Y≈2320）

| Tab | 约 X | 备注 |
|-----|------|------|
| 微信 | 135 | 会话列表；角标未读数 |
| 通讯录 | 405 | 朋友推荐/群聊/标签/服务号/企业/星标/A–Z |
| 发现 | 675 | 朋友圈→小程序入口 |
| 我 | 945 | 服务/收藏/朋友圈/视频号/小店/表情/设置 |

## 壳与 Activity（实机）

| 场景 | Activity |
|------|----------|
| 四 Tab 主壳 / 多数会话 | `…ui.LauncherUI`（进会话后 focus 常仍报此） |
| 群聊信息 | `…chatroom.ui.ChatroomInfoUI` |
| 通讯录→群聊文件夹 | `…ui.contact.ChatroomContactUI`（本账号为空：需「保存到通讯录」） |
| 通讯录→标签 | `…label.ui.ContactLabelManagerUI` |
| 通讯录→服务号 | `…brandservice.ui.BrandServiceIndexUI` |
| 朋友圈时间线 | `…sns.ui.improve.ImproveSnsTimelineUI` |
| 我→朋友圈相册 | `…ui.AlbumUI` |
| 视频号 | `…finder.ui.FinderHomeAffinityUI` / `FinderSelfUI` |
| 直播 | `…finder.nearby.newlivesquare.FinderLiveSquareNewEntranceUI` |
| 全局搜索 | `…fts.MMFTSSearchTabWebViewUI` |
| 看一看 | `…topstory.ui.home.TopStoryHomeUI` |
| 听一听 | `…ting.TingFlutterActivity`（**Flutter**） |
| 扫一扫 | `…scanner.ui.BaseScanUI` |
| 游戏 | `…game.ui.LiteAppGameTabUI` |
| 小程序列表 | `…appbrand.ui.AppBrandPluginUI` |
| 小程序运行 | `…appbrand.ui.AppBrandUI01`（例：种草相册） |
| 表情商店 | `…emoji.ui.v2.EmojiStoreV2UI` |
| 设置→插件 | `…lite.ui.WxaLiteAppLiteUI`（系统 back 常无效） |
| 收藏 | `…fav.ui.FavoriteIndexUI` |
| 服务（含钱包入口） | `…mall.ui.MallIndexUIv2` |
| 铃声设置 | `…ringtone.ui.RingtoneSettingsUI` |
| 绑定手机引导 | `…account.bind.ui.BindMContactIntroUI` |
| 全局搜索主页 | `…fts.ui.FTSMainUI` |
| 搜索详情 | `…fts.ui.FTSDetailUI` |
| 单聊信息 | `…ui.SingleChatInfoUI` |
| 会话内找记录 | `…chatting.search.multi.FTSChattingConvMultiTabUI` |
| 图片视频历史 | `…chatting.gallery.MediaHistoryGalleryUI` |
| 联系人资料 | `…profile.ui.ContactInfoUI` |
| 私聊/群聊会话 | `…ui.chatting.ChattingUI` |
| 按日期查记录 | `…chatroom.ui.SelectDateUI` |

## Me 列表坐标（1080×2400，无浮层时）

| 项 | 约 Y | 备注 |
|----|------|------|
| 服务 | ~670 | → MallIndex；**勿点收付款/钱包支付** |
| 收藏 | ~850 | |
| 朋友圈 | ~960 | → AlbumUI |
| 表情 | ~1500 | → 表情商店 |
| 设置 | ~1680 | |

## 会话 + 面板（只读映射）

页1：相册 / 拍摄 / 语音通话 / 位置 / **红包** / 礼物 / **转账** / 语音输入  
页2：收藏 / 群工具 / 接龙 / 直播 / 个人名片 / 文件 / 音乐  
另：浮层「你可能要发送的照片」— **勿点**。

首页顶栏 `+`：发起群聊 / 添加朋友 / 扫一扫 / **收付款**。

## 发现清单

朋友圈 · 视频号 · 直播 · 扫一扫 · 听一听 · 看一看 · 搜一搜 · 附近 · 游戏 · 小程序

## 红线（本 App）

| 禁止 | 原因 |
|------|------|
| 收付款 / 转账 / 红包 / 充值 | 资金红线（永不） |
| 向非白名单会话发消息 | 外发 |
| 发朋友圈（顶栏相机） | 外发 |
| 清空聊天记录 / 删内容 / 注销 | 不可逆 |
| 遇验证码/风控继续 | 账号安全 |

### 本轮白名单外发（用户授权 2026-08-01 R2）

| 会话 | 允许 |
|------|------|
| 私聊 **天才较瘦** | ✅ 发文本测试 |
| 群 **问题解答群** | ✅ 发文本测试 |

## 搜人搜群（已通）

1. 微信 Tab 顶栏放大镜 → `FTSMainUI`
2. `input-text` 输入关键词 → 结果分栏：最常使用/联系人、群聊、聊天记录、收藏
3. 点「联系人」进 `ChattingUI`；群聊行约 **Y=380**（本机 1080×2400，搜「问题解答群」时）
4. 发消息：`input-text` 聚焦输入框 → 持同一 Explorer `--session-file` 用 `ops/tap.mjs --x 990 --y 2260` 点绿「发送」（坐标仅为历史线索，操作前先截图复核）

## 历史消息能力（结论）

| 方式 | 能否“全量” | 说明 |
|------|-----------|------|
| 会话内上滑 | ⚠️ 渐进加载 | UI 分页滚，无一键导出全文；可滚到更早 |
| 查找聊天记录 | ⚠️ 按条件检索 | `FTSChattingConvMultiTabUI`：关键词 + 日期/图视/文件/链接/音/交易/小程序/视频号/商品/礼物 |
| 图片与视频 | ⚠️ 媒体全览 | `MediaHistoryGalleryUI` 按月分节 + 搜图中文字；**不是文本全量** |
| dump / API | ❌ | dump 空壳；无本地明文全量拉取通道（本探索面） |

**结论：不能一键拿到联系人「全部历史文本」**；只能 UI 滚读 + 分类检索/媒体库。交易分类仅观察、不点支付。


## 坑

1. **dump 恒空** → 禁止 dump-first 死磕；vision 限次 + 区域描述优先于裸坐标  
2. **`WxaLiteAppLiteUI` / 部分 Lite**：系统 `back` 无效 → 点顶栏 ←  
3. 子页无底栏时 Tab 坐标无效 → UI back / `launch --force-stop`  
4. Me 页视频号「继续」浮层可挡中部点击 → force-stop 清场  
5. `screenshot --out` 直写偶发 0 字节 → 默认 SHOT 再 Copy-Item  
6. VLM 绝对 Y 可偏（见全局 pitfall）；本轮用人眼截图描述，不用 VLM 裸坐标当主眼

## op 表（待固化）

| op | 状态 | 自由度 |
|----|------|--------|
| 底栏导航 / focus / screenshot | 已探 | ✅ 自主 |
| 会话只读打开 | 已探 | ✅ 自主 |
| 发消息 | 未做 | ⚠️ 禁 / 需人 |
| 朋友圈浏览 | 已探 | ✅ 自主 |
| 朋友圈发布 | 未做 | ⚠️ 禁 |
| 支付相关 | 仅观察入口 | 🔴 禁执行 |

## 交接摘要

- 成功判据：**A**（LauncherUI 确认）+ **C**（dump_capability=none）已达成；**B** 以底栏/Me 列表经验坐标沉淀（无 dump bounds）。  
- 原文笔记：`tmp-know/EXPLORE-WECHAT-01-20260801.md`。  
- 下一刀：把底栏导航 / 会话只读 / 发现入口收成 `wechat-nav` dry-run 脚本；支付入口只做 observe。
