# Explorer 执行内容：抓 01 主页浮层真实 dump（解锁 xhs.follow.ensure）

> 目的：`xhs.follow.ensure` 的核心——主页浮层作者名提取（`头像,<name>` content-desc）和关注按钮页面指纹——**只来自代码注释，没有真实 dump 实证**。本 runbook 让 Explorer 在 01 上抓一份真实主页浮层 UIAutomator dump + 截图，确认格式，并把 parser（`ops/_xhs-parse.mjs`）对真实数据跑一遍。
>
 这是 **Risk #1** 的关闭条件，也是 GPFS Draft PR #23 合并、Hermes 10+ 回归的前置。

## 红线

- **只做只读 dump + 截图，不点关注**。本 runbook 不触发任何外部效应，无需审批、无需控制面 job/lease。
- 导航到浮层是**人手驱动 01**（capability 按设计不导航）。你只是把 01 摆到浮层，然后 dump。
- 全程**不用 `XHS_ALLOW_BYPASS`**做验收（req#11）；dump 本身是观测，不是 acceptance。
- 01 必须 online + ready + lease-free；xhs 在前台。

## 前置检查（Mac，本仓库根目录）

```bash
# 01 在 agent-entry 里 online、有 serial
ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/api/agent-entry' | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const e=JSON.parse(s);const d=(e.devices||[]).find(x=>x.alias==="01");
    console.log("01 serial=",d&&d.serial,"online=",(d.state||{}).online,(d.control||{}).online);
  })'
# 01 当前前台应是 xhs（com.xingin.xhs）；不是就先手动开 xhs
ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/api/agent-entry' >/dev/null && echo ok
```

## 步骤 1：人手把 01 开到目标用户主页浮层

在 01 物理屏幕上操作（或用 `ops/tap.mjs` 远程点）：

1. xhs 首页（IndexActivityV2）→ 任意点开一条笔记（图文或视频均可）→ 进入笔记详情（NoteDetail/DetailFeed）。
2. 在笔记详情**点顶部作者头像/昵称** → 弹出该作者的主页浮层（focus 仍 NoteDetail，但出现：头像 + 粉丝/获赞统计 + 关注/私信按钮 + 笔记网格）。
3. 选一个**你打算关注、或已经是已关注**的目标用户（便于后面观察标签；不打算关注就只做 before-state dump，不点关注）。

> 没有现成目标？随便点一条信息流笔记→点作者头像即可；dump 是只读的，关注与否你自己定。

## 步骤 2：抓 dump + 截图（只读）

```bash
# UIAutomator XML 到 Mac 本地
node ops/dump-ui.mjs --alias 01
# 记下 stdout 的 DUMP=/abs/path.xml，下面用它

# 同屏截图（可选，留作页面指纹视觉证据）
node ops/screenshot-and-analyze.mjs --alias 01
# 记下 SHOT=/abs/path.png
```

`dump-ui.mjs` 会打印 `DUMP=…`、`NODES=N`、`DUMP_HINT=text+ content-desc`。若 `DUMP_HINT=sparse`（无 content-desc），说明这版 xhs 的 a11y 不带 desc，`头像,<name>` tier-1 必然 fail-closed——这本身就是关键发现，照实记。

## 步骤 3：用 parser 跑真实 dump（直接验证 `ops/_xhs-parse.mjs`）

把上一步的 `DUMP=` 路径填进 `DUMPFILE`：

```bash
DUMPFILE=/tmp/xhs-explore/dump-01-XXXX.xml   # 换成实际的 DUMP= 路径

node --input-type=module -e '
import { readFileSync } from "node:fs";
import { findProfileAuthor, findFollowBtn, followState } from "./ops/_xhs-parse.mjs";
const xml = readFileSync(process.env.DUMPFILE, "utf8");
console.log("author   =", JSON.stringify(findProfileAuthor(xml)));
const fb = findFollowBtn(xml);
console.log("followBtn=", JSON.stringify(fb));
console.log("state    =", fb ? followState(fb.matched) : "no-btn");
// 原始结构确认（regex，不依赖内部 allNodes）
const heads = [...xml.matchAll(/content-desc="(头像[^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*clickable="(true|false)"/g)]
  .map(m=>({desc:m[1], clickable:m[6]==="true", y:+m[3]}));
console.log("头像-desc raw =", JSON.stringify(heads));
const labels = ["关注","已关注","回关","相互关注"]
  .flatMap(L=>[...xml.matchAll(new RegExp(`(?:text|content-desc)="${L}"[^>]*?clickable="(true|false)"[^>]*?class="([^"]+)"`,"g"))]
    .map(m=>({label:L, clickable:m[1]==="true", cls:m[2].split(".").pop()})));
console.log("follow-label raw =", JSON.stringify(labels));
'
```

## 步骤 4：确认清单（acceptance for Risk #1）

逐条对真实 dump 核对，**全绿才能升 `xhs.follow.ensure` 为可成功**：

- [ ] **头像 content-desc 格式**：`author.name` 非空，且 `头像-desc raw` 里 desc 形如 `头像,<昵称>`（分隔符是半角还是全角逗号？记录实际）。→ 决定 `findProfileAuthor` tier-1 正则 `^头像[,，]` 是否正确。
- [ ] **头像 ImageView clickable**：`头像-desc raw` 里 `clickable=true` 且 y<600（浮层头像信号）。→ 决定 `profileOverlayOpen` 指纹。
- [ ] **关注按钮真实结构**：`follow-label raw` 里关注/已关注节点的 `cls`（Button? TextView?）、`clickable`、y 坐标。→ 决定 `findFollowBtn` 候选限定 `Button|TextView + clickable + y<900` 是否够。
- [ ] **四态标签真实文本**：屏幕上看到的关注按钮是 `关注` / `已关注` / `回关` / `相互关注` 中的哪个？`followBtn.matched` 命中的是否就是它？有无 `关注的话题` 之类干扰节点被误中（exact-set 应已排除，核对）。
- [ ] **普通 NoteDetail 是否会出现假浮层信号**：退回笔记详情（不进浮层）再 dump 一次，确认 `profileOverlayOpen` 不会把普通详情页误判成浮层。

## 步骤 5（可选，需授权）：标签翻转观察

> 这一步**会真的关注**，是外部效应。**只在你确实要关注该目标时做**；否则跳过，步骤 4 的 before-state dump 已足够解锁格式确认。

```bash
# before-state 已在步骤 2 抓到。若 before=关注（未关注）且你要关注：
node ops/tap.mjs --alias 01 --x <followBtn.x> --y <followBtn.y>
sleep 2
node ops/dump-ui.mjs --alias 01    # after-state dump
# 再跑步骤 3 的 parser 一行，对比 before/after state：关注→已关注（或回关→相互关注）
```

记录：tap 后标签**实际翻成什么**、翻转耗时、是否需要二次 dump 才读到（`afterStateUnknown` 风险点的真机表现）。

## 产出 & 留痕

把步骤 3/4 的输出粘到：

1. **GPFS Draft PR #23** 评论：确认 `头像,<name>` 格式 + 关注按钮指纹，或贴反例。
2. **知识库 recipe `recipe-xhs-follow-ensure-20260729`**（确认后才能写，`verifyMode=replay`）：
   - appliesTo=`xhs.follow.ensure`
   - `头像,<name>` 真实格式（分隔符/前缀/clickable/y）
   - 关注按钮真实 cls/clickable/标签
   - tap 后标签翻转实测
3. **PROGRESS.md** `xhs.follow.ensure capability` 节的「待办①」勾掉，记真实格式结论。

## 若发现格式与代码假设不符

- 头像 desc 不是 `头像,<name>`（如裸昵称、或无 desc）→ `findProfileAuthor` tier-1 正则需改；改完重跑步骤 3 直到 `author.name` 命中真实昵称。
- 关注按钮不是 clickable Button/TextView 或 y≥900 → `findFollowBtn` 候选限定需放宽/收紧。
- 任何改动都要两仓重跑测试：`npm test`（registry 33/33、GPFS 233/233）+ `npm run check`，再更新 Draft PR #23。