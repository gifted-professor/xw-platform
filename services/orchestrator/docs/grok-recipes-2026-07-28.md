# Grok 收脚本规格 — 2026-07-28

4 个 recipe，定位数据已验证，**不用重新探索**。照着现成脚本模式收。

## 仓库约定（必守）

- **零第三方依赖**：只用 `node:*` 内置。无 `console.error`（一律 `console.log`）。
- **输出契约**：stdout 走 `KEY=value` KV 行，结尾 `XXX=ok|fail` + `ALIAS=`。参考 `ops/xhs-like-one.mjs` / `ops/xhs-search.mjs` 的 `fail(reason, extra)` + `kv()`。
- **传输层（重要，二选一）**：
  - **新脚本优先用 session pipe**：`import { openWinXwSession, scpFrom } from "./_explore-lib.mjs"`，`const s = openWinXwSession(ssh, alias); await s.ready;` 然后 `await s.cmd({op, ...})`。单动作 ~50ms。参考 `ops/xhs-like-one.mjs`（已切 session）的 `focusNow/dumpNow/tap/back` 封装。
  - **扩已有脚本就沿用其现有 `runOps`（spawn 子进程）风格**，别为加一个 flag 重写传输层。
- **dump**：session 下 `await s.cmd({op:"dump", out: remotePath})` 把 XML 写到 Windows 远端路径，再 `scpFrom(ssh, remote, local)` 拉回本地 `readFileSync` 解析。远端路径用 `C:/Users/Public/xhs-agent-runs/_explore/<name>-<alias>-<ts>.xml`，本地 `join(tmpdir(),"xhs-explore",...)`。
- **解析**：纯函数都放 `ops/_xhs-parse.mjs`，无设备 I/O。已有 `allNodes(xml)`、`findBtn(xml,kind)`、`parseBottomBar`、`parseSearchResults`、`findEditText`、`findSendBtn`、`decodeEntities`、`isHomeFocus`、`isDetailFocus`。
- **时序/重试（本轮刚加的范式，照抄）**：
  - 状态翻转判定用**计数比对 + re-dump 重试**（a11y label 滞后于服务端计数）。参考 `xhs-collect-one.mjs` verify 段：`countOf` + 未确认则 `sleep(1200)` 重 dump 一次。
  - 导航类「下一步」tap 后**比对 focus 没动则重点一次**（22222 排队偶发 tap 丢失）。参考 `xhs-publish-draft.mjs` 的 `NEXT_AGAIN_RETRY`。
- **退出码**：0 ok / 2 业务 fail / 4 参数或异常 / 124 超时。
- **改完必跑**：`node --check <file>` + `npm test`（26/26）+ `npm run check`。活干完留痕 PROGRESS.md。

## 已验证定位数据（直接用，别再 dump 探）

```
关注按钮:  text="关注"  @ (846,161)        # detail 页，会漂，必须 dump 定位
发布按钮:  text="发布"  @ (955,136)        # publish-draft 文案页右上角
评论框:    content-desc="评论框"
评论数:    content-desc="评论 N"
搜索翻页:  swipe up 后仍 GlobalSearchActivity，clickable 节点增多（翻页成功信号）
```

---

## Recipe 1 — `ops/xhs-follow-one.mjs`（新建）

**能力**：detail 页 → 关注 → verify。参考 `ops/xhs-collect-one.mjs`（结构最像：开笔记→定位底栏上方按钮→tap→verify→退回）。

**建议用法**：`node ops/xhs-follow-one.mjs --alias 01` / `--dry-run` / `--no-force-stop`。

**实现要点**：
- 复用 collect-one 的「launch → dump feed → pickFeedCard → tap 卡 → 进 detail」前段（可直接抄，PKG=`com.xingin.xhs`）。
- 关注按钮不在底栏，在 detail 页上部。用 `allNodes(xml)` 找 `n.text === "关注"`（坐标会漂，**禁止硬编码 846,161**，按节点 bounds 中心 tap）。建议在 `_xhs-parse.mjs` 加 `findFollowBtn(xml)`：返回 `{x,y,desc,matched}` 或 null。
- 状态判定：tap 前 `before = (找到 "关注")`，tap 后 re-dump，找 `已关注` / `回关` / `相互关注`。`followState(desc)` → `"followed" | "unfollowed" | "unknown" | "missing"`。
- **verify 用 re-dump 重试**（label 滞后）：tap 后 `sleep(1800)`，首次未确认再 `sleep(1200)` 重 dump 一次。
- `--dry-run`：只定位关注按钮、打印坐标，不 tap。
- 输出：`FOLLOW_BEFORE=`、`FOLLOW_AFTER=`、`FOLLOW=ok|skip|fail`、`ALIAS=`。`skip` = 已关注。
- 退回主页用 back 循环（抄 collect-one 的 `backHome`）。

**验收**：`--dry-run` 能打印 `FOLLOW_BTN=x,y` 且不 tap；真跑（人授权后）`FOLLOW=ok` 且 `FOLLOW_AFTER` 含 `已关注/回关`。

---

## Recipe 2 — `parseComments(xml)`（扩 `ops/_xhs-parse.mjs`）

**能力**：从 detail 页 dump 解析评论区。

**实现要点**：
- 在 `_xhs-parse.mjs` 加 `export function parseComments(xml)`。
- 用 `allNodes(xml)`。评论总数：找 `content-desc` 匹配 `/^评论\s*(\d+)$/`，取计数。评论框：`content-desc === "评论框"`（返回其坐标，供后续点开评论用）。
- 评论条目：XHS detail 页评论区每条是带 `text=` 的 TextView 组合（用户名 + 正文 + 点赞数）。启发式：找正文 `text` 长度 ≥ 4 的节点，按 y 升序，去重；每条尽量配最近的短 `text`（用户名）和纯数字（点赞数）。**不强求完美**——先返回 `{count, box:{x,y}, items:[{user, text, likes, y}]}`，items 可粗。
- 不要设备 I/O。纯 regex/`allNodes`。
- 可选：加 `export function findCommentBox(xml)` 复用 `findBtn(xml, "commentBox")` 已有的 `(?:评论框|说点什么)`。

**验收**：`node --input-type=module -e "import {parseComments} from './ops/_xhs-parse.mjs'; console.log(parseComments(require('fs').readFileSync('<一个detail dump.xml>','utf8')))"` 能出 count + items。提供不了一个真实 dump 就先保证 `parseComments("")` 返回 `{count:null,box:null,items:[]}` 不崩。

---

## Recipe 3 — `xhs-search.mjs --pages N`（扩 `ops/xhs-search.mjs`）

**能力**：搜索结果翻页，聚合多页卡片。

**现状**：`ops/xhs-search.mjs` 现只 dump 一页（line 160-175），`parseSearchResults(xml)` 返回 `{tabs, cards}`。无 `--pages`。

**实现要点**：
- 加 `--pages <N>`（默认 1）。`--pages 1` = 现有行为，不破坏。
- 翻页：`swipe up`（用 `ops/swipe.mjs --up` 或 session `s.cmd({op:"swipe", x1:540,y1:1800,x2:540,y2:700,ms:350})`）。翻页后 `sleep(1200)` 再 dump。
- **翻页成功信号**：`focusNow()` 仍是 `GlobalSearchActivity` 且新 dump 的 clickable 节点数 > 上一页（或新卡片坐标不与已收卡片重叠）。若 swipe 后 focus 漂走或卡片数没增 → 停止翻页（别硬翻 N 次）。
- 聚合：每页 `parseSearchResults` 的 cards 合并，按 `Math.round(cx/40)_Math.round(cy/40)` 去重（抄 `parseSearchResults` 末尾的 dedup 思路，但跨页坐标会重复——改用 title+author 去重更稳）。
- 输出：`COUNT=` 改为合并后总数；新增 `PAGES_DONE=`、`PAGE<i>_COUNT=`。JSON 落盘含全部卡片。
- 沿用现有 `runOps` 风格（别重写成 session，只为加 `--pages`）。

**验收**：`--pages 1` 行为不变；`--pages 3` 输出 `PAGES_DONE=` 实际翻到的页数 + 合并 `COUNT ≥` 单页数；focus 漂走时提前停、不报 crash。

---

## Recipe 4 — `xhs-publish-draft.mjs --publish`（扩 `ops/xhs-publish-draft.mjs`）

**能力**：文案页填好后，**显式授权**才点最终「发布」。默认**绝不点**。

**现状**：`ops/xhs-publish-draft.mjs` 现在定位到文案页的 `text="发布"` 按钮但**只打印 `POST_BTN_LOCATED_NOT_TAPPED=` / `POST_BTN_STILL_NOT_TAPPED=`，绝不 tap**，然后 `abortHome()`。文件头注释 `NEVER taps final 发布`。

**实现要点**：
- 加 `--publish` flag。**默认不传 = 现有行为（不点发布，abortHome，`PUBLISHED=no`）**。现有所有调用方零破坏。
- `--publish` 时：填完文案 → 重新 dump 确认 `text="发布"` 按钮仍在 + 文案已落（`findEditText` 的 text 含 caption）→ tap 发布按钮 → `sleep(3000)` → verify。
- **verify 发布成功**：发布后通常跳走文案页（focus 不再是编辑页）或弹「发布成功」/回到主页。判定：`!findEditText(xml) && !/text="发布"/.test(xml)` 或 `isHomeFocus(focus)`。参考 `xhs-engage-one.mjs` comment 的 `composer-closed` 思路。
- **安全门（必守）**：
  - `--publish` 必须配合 `--caption` 且文案非空；空文案 + `--publish` → `fail("publish-no-caption")`，不点。
  - 点发布前打印 `ABOUT_TO_PUBLISH=yes` + `PUBLISH_BTN=x,y` + `CAPTION=<preview>`，留痕可追溯。
  - 发布是**不可逆外部动作**：脚本不自动重试发布 tap（点一次就够；失败就报 `PUBLISH=fail`，人介入）。
- 输出：`PUBLISHED=yes|no`、`PUBLISH=ok|fail`。
- 文件头注释从 `NEVER taps final 发布` 改为 `默认不点发布；--publish 经人授权才点`。

**验收**：不带 `--publish` 行为与现在完全一致（`PUBLISHED=no`，不点）；带 `--publish` + 空 caption → fail 不点；带 `--publish` + 非空 caption → 点发布并 `PUBLISH=ok`（人授权真跑）。

---

## 收完后

1. `node --check` 四个触及文件 + `npm test` + `npm run check`。
2. 留痕 PROGRESS.md：加一条 `2026-07-28 ops 新增 follow/parseComments/search-pages/publish-flag`，注明「定位数据来自已验证探索，未重探」。
3. 4 个 recipe 的 live E2E（follow-01 / search-02 --pages 3 / publish-04 --publish / parseComments 用真实 dump）需人授权真跑，Grok 不自评，交付后由回归 harness 验。