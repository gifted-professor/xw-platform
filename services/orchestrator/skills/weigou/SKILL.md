---
name: weigou
description: 微购相册能力地图。厂家相册商品块（九图/文案/价格/SKU）探索沉淀；单 op 固化后下沉 skills/weigou/<op>/。
triggers:
  - weigou
  - 微购相册
  - 搬运工
  - truedian
version: "0.1"
verified: false
---

# 微购相册能力地图（weigou）

> 一句话：微购相册探索产出的**权威落点**。散条知识库 `explore-weigou-*`；本页聚合。
> `v0.1` / `verified:false`（2026-08-02 首探，02 实机「搬运工」）。

## 元信息

| 项 | 值 |
|----|----|
| 包名 | `com.truedian.dragon` |
| 探索设备 | **02** / `REPLACE_SERIAL_02` |
| 厂家样本 | 搬运工（SVIP；上新86 / 总数5270） |
| 探索日期 | 2026-08-02 |
| 预算 | Explorer lab；禁 R2 外发执行 |
| 知识库 | `explore-weigou-banyungong-product-structure-20260802` |

### 设备清单与可用性

| alias | serial | 登录态 | 可用性 | 备注 |
|-------|--------|--------|--------|------|
| 01 | — | 未本轮 | — | 历史 vision Y 偏差测过微购 |
| 02 | `REPLACE_SERIAL_02` | **已登录** | 正常；相册 dump ✅ | 本轮主机 |
| 03/04 | — | — | — | 未探 |

## dump 能力

| 页面 | dump | 策略 |
|------|------|------|
| 好友列表（WebView） | ❌ sparse | 搜索框 + 坐标点选 |
| 厂家相册 HomeActivity | ✅ | dump-first；`recycler_home` |
| 动态详情 DynamicDetailActivity | ✅ | `image_list` 九宫格可数 |

## Activity

| 场景 | Activity |
|------|----------|
| 主壳五 Tab | `…activity.fragment.MainActivity` |
| 厂家相册 | `…activity.HomeActivity` |
| 动态详情 | `com.wego.wgdetail.view.activity.DynamicDetailActivity` |

## 底栏（MainActivity）

动态 | **好友** | 工作台 | 消息 | 我的

## 厂家页结构

- tabs：全部 / 上新 / 小视频 / 图集
- 搜索：标题/简称/搜索码/货号
- 卡片动作：下载 / 编辑 / 转发；底栏：商品分类 / 联系Ta / 批量转发

## 商品结构（op 待固化）

见知识库正文。摘要：

1. 连续多条动态 = 一商品；`title_home_fragment`（💰N发）= 尾锚
2. 详情满格九图 = `image_list` 下 9×`image`
3. 文案解析：代发价 / 款号 / 颜色 / 尺码；dump 已含全文，不必点「全文」
4. 双价格：💰发价 vs 图内 ¥标价

## op 表

| op | 链接 | 自由度 |
|----|------|--------|
| product-structure | 知识库 `explore-weigou-banyungong-product-structure-20260802` | 只读探索已验 |
| open-friend-album | （待脚本）好友搜索→HomeActivity | — |
| parse-copy | （待）title_home_fragment → price/sku/colors/sizes | — |
| pick-best-nine | （待）优先满 9 宫格动态详情 | — |

## 已知坑

- 好友列表 WebView：无名字节点，勿盲 dump 点选
- VLM 像素 Y 偏低（微购约 −160~−179px）→ 有 bounds 禁 vision；见 `pitfall-vision-vlm-y-bias-20260727`
