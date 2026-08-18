---
name: douyin-live-bulk-slides
description: 抖音新疆高密度 Live/slides 整包采集：标题打分→综合搜索→分享链接→龙猫视频下载。与单张 live-photo（实况→保存至相册）不同链路。
triggers:
  - douyin-live-bulk
  - 新疆live图
  - 整包Live
  - live-bulk-slides
version: "0.2"
verified: false
changelog:
  - version: "0.2"
    date: 2026-08-03
    change: "停车场收编：ops 打分/下载固化；搜索仍用探索脚本半自动"
  - version: "0.1"
    date: 2026-08-02
    change: "01 探索：标题规律+分享链+龙猫，约173 mp4"
depends:
  - douyin-search
  - device-dump
  - device-tap
---

# 抖音整包 Live slides（新疆高密度）

> 权威短报：`tmp-know/EXPLORE-DOUYIN-XJ-LIVE-BULK-20260802.md`  
> 标题先验：`tmp-know/STRATEGY-XJ-LIVE-TITLE-PRIOR.md`  
> 停车场证据：`tmp-know/exp-max-01/lyk-lives/`（mp4 / 链接表；勿当唯一真理）

## 一句话

搜/群里「**用 N 张 live 图|记录 + 新疆**」→ 详情角标 **动图** → **分享链接** → 龙猫「**视频下载**」批量 mp4。  
「N张**照片**」无 live → 通常只有图集，跳过。

## 已固化命令

```bash
# 标题打分（≥4 优先开帖）
node ops/douyin-live-bulk-score.mjs --text "用45张live图回忆我的新疆之旅"
node ops/douyin-live-bulk-score.mjs --queries

# 龙猫提取后：目录内放 video-urls.txt，批量下 mp4（不碰手机）
node ops/douyin-live-bulk-download.mjs --dir tmp-know/exp-max-01/lyk-lives/downloads/01
```

共享库：`ops/_douyin-xj-live-lib.mjs`（`scoreXjLiveTitle` / `classifyXjLivePrior` / 推荐搜索词）。

## 半自动碰机搜索（未完全固化）

停车场脚本（硬编码曾用 01；扩采续跑前先改 alias / 迁 ops）：

```bash
set XHS_LOCAL=1
node tmp-know/exp-max-01/lyk-lives/search-xj-live.mjs 4
```

产出：`search-found-links.json`；再人工/半自动进龙猫拿 `video-urls.txt`。

## 链路

```
综合搜「新疆live图」（可点 chip「实况」）
  → 标题打分 ≥4
  → Detail（动图、图数≥30 优先）
  → 分享 → 分享链接 → v.douyin.com
  → longmao 提取 → 有「视频下载」才 download ops
```

## 与 live-photo 对照

| | live-photo | live-bulk-slides（本 skill） |
|--|------------|------------------------------|
| 典型 | 「一张…Live图 #赛里木湖」 | 「用45张live图回忆新疆之旅」 |
| 角标 | 实况 | 动图 / slides |
| 下载 | App 内保存至相册 | **站外**龙猫视频下载 |
| 张数 | 1～数张 | 常 ≥30 |

## 征集帖先验（B）

标题含「交换/评论区留下实况」→ **评论区「动图」矿**，不要只盯封面。细则见 STRATEGY。

## 红线

- 不进支付；不真私信转发好友  
- 搜索扩采注意频率（dump Kill / 风控）  
- SearchResultActivity dump 比 Feed/Splash 稳

## 已落盘样例（01 · 2026-08-02）

约 **173** mp4 / 4 帖（45+46+44+38）；链接表 `lyk-lives/share-links.json`。  
待验搜索链：`lyk-lives/search-found-links.json`。

## 下一步（未做）

- 把 `search-xj-live.mjs` 迁成 `ops/douyin-live-bulk-search.mjs`（`--alias`、CPA 闸门可选）  
- 龙猫提取自动化（若政策允许）  
- Mac `adopt-from-windows` 后 commit skills
