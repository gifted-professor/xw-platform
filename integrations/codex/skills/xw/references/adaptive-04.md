# 04 快车道：Claude 自主选路细则

> 真源：`docs/plans/xhs-04-adaptive-xwskill-fast-plan-v2.md`。本文件是 `/xw` 对 alias `04` 普通 R0 目标的执行细则，
> 不修改根 `skills/SKILL.md` 的人类权限底座，也不扩大 release/policy/Standing Grant。

## 1. 适用范围

- 只针对 alias `04`、小红书、R0/可逆操作：搜索、浏览、dump、截图、输入、滑动、返回、启动 App。
- 01–03 仍只读，不自动切换；旧 `Xhs*` 任务永远 Disabled。
- 支付/转账/充值、删除/注销/改密、系统权限、验证码/风控/登录墙、点赞/收藏/关注/评论/私信/发布/草稿/保存
  **立即 STOP**，不进快车道，仍单独等人确认。

## 2. 开始一次 run

1. `xw-closeout begin --mode explorer|runner --goal "<目标>"` 取得唯一 `runId`。
2. 读 live `agent-entry`，只接受 `04` `ready=true && leaseFree=true`。
3. 读 `/api/recipes?includeAll=1` 与 `/api/knowledge?app=xhs&q=<goalSignature>`。
4. 取当前 package/activity；需要碰机时 `xw-explore-session acquire 04` 取得 `--session-file`，
   把 sessionId/leaseRef 写入本 run 第一条 decision step。
5. 计算轻量 `goalSignature`：`app + intent + 参数名集合 + 起始 surface`，如 `xhs.search(keyword)@home`。

历史画像只用本轮实际可观察字段：alias、package/activity、分辨率、方向、release，以及可读时的 App version。
App version 读不到不得假装已匹配；含旧坐标的 Recipe 只有 fresh dump/screenshot 页面断言也匹配才可运行。

## 3. 固定选择顺序

```text
exact 04 Recipe + 画像/页面断言匹配 + 最近一次 Runner 成功  -> RECIPE
否则 fresh dump
  -> 唯一目标且 bounds 合法：DUMP
  -> dump 空/稀疏/同等候选不唯一：VISION
  -> dump 命令本身失败：被动重取一次；仍失败：STOP
任一路径遇红线：STOP
```

Claude 不询问用户选哪条路。普通 R0 且能证明就直接执行。

## 4. 统一失败计数

每个业务目标维护一个 `targetFailureCount`：

- 一次定位周期结束仍无唯一目标：`+1`。
- tap/input/swipe/Recipe 调用失败：`+1`。
- 动作完成但 mandatory postcondition 失败：`+1`。
- fresh dump、fresh screenshot、focus 检查等无 mutation 的被动刷新本身不计数。

Recipe 失败算第一次；转 DUMP/VISION 修复是最后一次动作机会。计数到 2 立即 `STOP`，不得换一种 route 重置计数。

## 5. 三条路径

### 5.1 RECIPE

- 只自动选择 R0、`eligibleAliases=["04"]`、已封存且有一次 04 Runner 成功的 fast-lane Recipe，
  或正式 catalog `canary_only|implemented` Recipe。
- 开始前只做一次 ready/free、画像和起始页面断言。
- 每个 step 的 jobId/断言进同一个 closeout run；结束必须有最终页面断言和 lease release。
- Recipe 失败后不重跑全链；失败计数 `+1`，重新观察后只允许一次有界修复。

### 5.2 DUMP

- fresh dump 唯一节点优先于视觉；取语义 bounds 的确定性中心或既有 safe point。
- 点击后必须验证 package/activity 或目标页面特征。
- 输入前必须验证目标编辑框 `focused=true`。
- XHS Flutter 搜索框固化经验：`tap-first -> focused=true -> input --no-refocus --clear-first --enter`
  （见 memory `xhs-flutter-xhsime-input-tap-first`）。

### 5.3 VISION

VISION 是 04 Explorer canary 路径，不冒充正式 `locator.visual-block.v1` 已获生产点击能力。

1. 用同一 Explorer session 取 screenshot、focus、capturedAt 和 hash。
2. 先验证承载 `/xw` 的 Claude runtime 能读本地 PNG 并返回结构化块；不能就
   `STOP/VISION_RUNTIME_UNAVAILABLE`，不得伪造分析结果。
   - 探针：`node ops/xw-adaptive-visual-tap.mjs --probe --alias 04 --session-file <ctx>`
     （或 `--probe --screenshot <path>`）。拿到 `SHOT=` 路径后用 Read 工具读图并返回结构化块；
     读不出即 `STOP`。
3. Claude 只给当前截图上的：`label、region、bounds、confidence、rationale`（坐标用原图原始分辨率）。
4. `node ops/xw-adaptive-visual-tap.mjs` 在一条命令内：
   - 绑定 alias04、sessionRef、screenshot hash、focus、短 TTL（默认 30s）和目标描述；
   - 拒绝越界、低置信（默认 `<0.5`）、同名歧义/重叠同等候选、系统区（顶栏/底栏）和全部红线 label；
   - 将 block 内容寻址为 `blockId`，从 bounds 确定性取中心；
   - 立即消费这次 `actionRef`（同一截图+块只能用一次），经现有 Explorer session 执行一次 tap；
   - 只回 `BLOCK_ID / JOB / EVIDENCE / ACTION_REF`，不把最终坐标作为可复用授权。
5. tap 后 mandatory fresh dump/screenshot assertion；assert 结果必须进 closeout。
6. 视觉 postcondition 失败的 run 不得计入历史成功，也不得生成 Recipe candidate；失败计数 `+1`。

## 6. 收尾

无论成功/失败/中断：

1. finally release 本 run 持有的 session；
2. 查 live lease/job，记录 04 是否清零；
3. `xw-closeout close` 生成 harvest bundle；
4. 成功则更新相同 goal/profile 的 knowledge `verifiedBy`；失败则写/更新 pitfall；
5. 不确定动作结果时标 `unverified`，不自动重放。

若 Claude/进程崩溃，下次只能凭明确 `runId` 读取 task/steps 中的 sessionRef，查当前 lease owner，
仅释放这个 run 自己仍持有的 session。owner 不符、上下文缺失或 release 失败就停止；禁止扫描 outbox 猜 runId，
禁止为补日志重做业务动作。

## 7. adaptiveDecision 字段（closeout）

`xw-closeout step` 接受可选 `adaptiveDecision` 对象（严格白名单，未知字段 fail closed）：

```json
{
  "goalSignature": "xhs.search(keyword)@home",
  "route": "RECIPE|DUMP|VISION|STOP",
  "reasonCode": "EXACT_RECIPE|UNIQUE_DUMP|DUMP_SPARSE|AMBIGUOUS|REDLINE|SECOND_FAILURE|DUMP_FAILED|VISION_RUNTIME_UNAVAILABLE|PROFILE_DRIFT|NOT_READY",
  "profile": {"alias":"04","package":"com.xingin.xhs","activity":"...","width":1080,"height":2400,"orientation":"portrait","appVersion":null},
  "targetFailureCount": 0,
  "historyRefs": ["knowledge id","prior run id"],
  "evidenceRefs": ["job id","screenshot/dump hash"],
  "blockId": null,
  "assertion": {"name":"...","pass":true}
}
```

`xw-closeout` 继续负责 secret redaction、append-only journal、candidate sealing 和 manifest hash。

## 8. 固定脚本自动沉淀

Claude 在成功 closeout 时自行判断；同时满足即自动生成，不问人：

- R0/可逆，无外发/支付/删除/账号/权限/验证码/风控步骤；
- 相同 `goalSignature + observed profile` 有 2 个不同 runId 的成功记录；
- 动作顺序稳定，可变值能抽成参数，关键页面有明确断言；
- 所有 visual tap 的 mandatory postcondition 均通过；
- 两次都正常释放 session/lease，无 unknown result。

产物沿用 `xw-closeout` 的 recipe candidate sealing：Recipe spec、参数 schema、device profile、
source run refs、descriptor hash 和离线 golden test。状态诚实保持 `candidate`。

### 与正式 Catalog 的状态映射

1. `candidate` 过离线校验后进服务端 04-only extras；客户端 inline Recipe 禁 live。
2. Runner 新增显式 canary mode：只允许服务端 extras 中的 R0 candidate、alias04、正式 session/lease，
   不接受客户端自报 status。
3. 第 1 次真实 Runner 成功后只标 `fastLanePreferred=true`，供 04 完全匹配目标优先使用；
   **不宣称正式 catalog 已是 canary_only**。
4. Runner 产 aggregate receipt，把每个 primitive job、断言、evidence、恢复和 lease release 汇总
   交给现有 `recordVerifiedAttempt()`。
5. 现有 `evaluatePromotion()` 不改阈值：2 个独立、带签名 receipt 的 Runner 成功依法经过
   `candidate -> replay_verified -> promotable -> canary_only`；累计 4 个到 `implemented`。

## 9. 红线（快车道专条，叠加于根 Skill 红线）

- 只操作 alias 04；不得自动切换 01–03。
- 手机动作只走 Control Plane 可见的 Explorer session/lease；禁止裸 ADB、直连 22222、无 lease 脚本。
- ADB 5038 权威；永不 kill/restart 5038（5037 kill 是 sanctioned RP-0001）。
- 同一目标累计两次失败立即 STOP 并 closeout。
- 不得把截图、serial、账号 ID、裸设备 ID、原始坐标写进 Git / task 参数 / 普通日志 / review packet / 公共 receipt；
  私有证据只走 hash/ref。
- 部署只从 committed release artifact；禁止热拷 dirty worktree 散文件。禁止自动重启 Windows。
- effect=0 等价 forbiddenEffectCount=0。