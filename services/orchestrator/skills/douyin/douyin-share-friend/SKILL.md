---
name: douyin-share-friend
description: 抖音图文搜索→开帖→分享给指定好友（默认「天才较瘦」）并附飞书同款字段附言。真外发私信；仅已授权跑量。
triggers:
  - douyin-share-friend
  - 抖音分享好友
  - 天才较瘦
  - share-friend-harvest
version: "1.0"
verified:
  - date: 2026-08-06
    device: "01"
    result: pass
    mode: real-send
    note: "need=10 喀纳斯 live图 → got=10 attempts=10 failStreak=0 elapsedSec=522 secPerPost=52；KW_MISMATCH 1 次自动重搜恢复。log=share-friend-run-1786003963148.jsonl"
  - date: 2026-08-06
    device: "01"
    result: pass
    mode: real-send
    note: "need=10 张live图 赛里木湖 → got=10 elapsedSec=444 secPerPost=44（summary share-friend-summary 历史轮）"
depends:
  - device-tap
  - device-dump
  - device-input
  - device-back
  - device-focus
  - device-launch
  - douyin-search
---

# 抖音分享给好友（douyin-share-friend）

> **路径 B**（产品默认）：搜索关键词 → 图文列表 → 开帖 → 分享面板 → **按名字**选好友 → 附言（飞书 7 字段）→ 发送 → 左上角回列表。  
> `v1.0` / 真机真发通过 @**01 only**。  
> **不是** dry-run；**不是**控制面正式 capability（仍走 explorer session + ops 脚本）。

## 自由度 / 红线

| 项 | 值 |
|----|-----|
| 自由度 | **已授权真发**（同 `dm` / `comment`） |
| 禁止标 | ❌ 自主 / ❌ 无人批准批量 / ❌ 多机默认 |
| 外发 | 真私信到指定好友；不可逆 |
| 好友 | 默认 `天才较瘦`；**禁止**盲点好友行最左（易点到群） |
| 设备 | **仅 01 验证**；好友列表与账号绑定 |
| 控制面 | 无 `douyin.share.friend` job id；勿当 `/api/capabilities` 已就绪 |

对比（勿混）：

| 路径 | 脚本 | 单帖 | 飞书 URL | 默认？ |
|------|------|------|----------|--------|
| **B 分享好友+字段附言** | `douyin-share-friend-harvest.mjs` | ~44–52s | 无自动链（字段里 URL 常 `-`） | **是** |
| A 评论框 PASTE 写飞书 | `douyin-harvest-share-links.mjs` | ~90s | 有 | 要真链写表时 |
| C 混合 copy→PASTE 想法 | 探针未收成默认 | ~38s 级 | 链进私信 | **否**（步骤多，不默认） |

## 用法

```bash
set XHS_LOCAL=1
$SF = "$env:USERPROFILE\.xhs-explorer-sessions\share-b-01.json"
node ops/xw-explore-session.mjs acquire --alias 01 --actor <you>-share-b --session-file $SF
node ops/explore-preflight.mjs --alias 01 --session-file $SF

node ops/douyin-share-friend-harvest.mjs --alias 01 --session-file $SF --keyword "喀纳斯 live图" --need 10 --fail-stop 4

node ops/xw-explore-session.mjs release --session-file $SF
```

可选：`--friend "天才较瘦"`（默认即此名）。

长跑可另开前台：`node ops/xw-explore-session.mjs keepalive --session-file $SF`。

## 流程

```
launch aweme → search keyword → 综合 + 漏斗图文
→ 列表开帖（FlowPage/Detail）
→ 分享半坐标 1004,2261
→ dump 找好友名 → tap → 必须 desc 含「已选中」
→ input-text 附言（飞书字段 | 分隔）
→ 发送 541,2267
→ 左上角返回 77,167（优先半坐标；失败再 dump「返回」）
→ ensureKeywordQueue：顶栏漂移 → 同词重搜
→ fail-stop 连续失败中止
```

附言格式见 `runtime/xj-live-pipeline/share-friend-msg.mjs`：

```
分享链接:…|标题:…|作者:…|Live角标:…|关键词:…|文本:…|采集状态:ok
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--alias` | ✅ | 目前只验 01 |
| `--session-file` | ✅ | explorer session |
| `--keyword` | ✅ | 搜索词 |
| `--need` | ❌ | 默认 10 |
| `--friend` | ❌ | 默认 天才较瘦 |
| `--fail-stop` | ❌ | 默认 4 |

## 硬规则（踩坑固化）

1. **名字选人 + 已选中**；禁止固定好友槽位 / 盲点最左。  
2. **先别点「分享链接」再选人**（混合路径另议）；本 skill 不点分享链接。  
3. 回列表用 **UI 左上 77,167**，禁止连按系统 back 清栈。  
4. **KW 守卫**：回列表后顶栏必须仍是本轮 keyword；相关搜改写 → `KW_MISMATCH` → `goSearch` 同词。  
5. 图文漏斗坐标（01）：漏斗 `1020,276`；图文芯片 `667,1242`；关面板 `540,1900`（筛选项多不进 dump）。  
6. 分享按钮 / 想法 / 发送可用半坐标；**好友必须 dump 名字**。

## 输出 / 证据

- 控制台：`SENT n/need`、`FRIEND_SELECTED`、`KW_CHECK` / `KW_MISMATCH`、`DONE {…}`  
- 汇总：`runtime/xj-live-pipeline/harvest-links/share-friend-summary.json`  
- 明细：`runtime/xj-live-pipeline/harvest-links/share-friend-run-*.jsonl`  
- 已发列表：`share-friend-sent.json`

成功判据：`got >= need` 且 `failStreak` 未触达 fail-stop；exit 0。

## 坐标备忘（01 / 1080×2400，半坐标加速）

| 控件 | xy |
|------|-----|
| 分享按钮 | 1004,2261 |
| 想法框 | 540,2106 |
| 发送 | 541,2267 |
| 回列表 | 77,167 |
| 好友 | **仅 dump 名**（示例 天才较瘦 常 ~116,1812，勿写死为唯一） |

## 明确不做

- 不写飞书多维表（要 URL 表走路径 A）  
- 不默认混合 copy-paste（路径 C）  
- 不点微博/微信外发条  
- 不升控制面 capability（另立项）

## 相关

- 能力地图：[`../SKILL.md`](../SKILL.md)  
- 脚本：`ops/douyin-share-friend-harvest.mjs`  
- 附言：`runtime/xj-live-pipeline/share-friend-msg.mjs`  
- NOTES：`runtime/xj-live-pipeline/NOTES-share-friend-feishu-params-20260806.md`  
- 混合探针（非默认）：`NOTES-hybrid-copy-then-share-friend-20260806.md`  
- 知识库：`recipe-douyin-share-friend-harvest-20260806`
