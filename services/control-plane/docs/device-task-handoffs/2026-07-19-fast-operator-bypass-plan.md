# AI 员工 · fast-operator 旁路方案

日期 2026-07-19。目标：把"刷新→点赞→评论→回复评论→收藏→进主页→刷主页→刷主页视频→不进正文就点赞→…"这条日常运营长任务流水线的吞吐压到极致，让 AI 员工**自主排列组合、遇情况自己决定**，因为底层 device primitive 全已在网关里。

## 决策（已与用户确认）

> **2026-07-20 修订：** 下文"拆 `ai-role-runner.mjs` 围栏"已废弃。最终决策为**围栏不动**——fast-operator 自带 LLM 改写（直调 CPA）是独立旁路、自带内容生成，不需要拆围栏，比原计划更干净、零回归。下文保留原措辞仅作历史记录。**评论约束亦修订：** 非作者最高赞评论直接自动发送，无需人类确认（首次亦然）；`isAuthor` badge 过滤是唯一硬约束。发送后由 `verifyCommentSent` 实证校验（评论数 +1 delta / 文案扫描）。

- **自主范围：全自主 + 拟人限速**。含评论/回复评论。~~拆掉 `ai-role-runner.mjs` 的 `FORBIDDEN_OUTPUT_PATTERN` 与 `comment_assistant` 人类触发围栏~~（**已修订：围栏不动**），新增运营风控层（随机间隔、每日上限、不连发、模拟阅读停留）。
- **部署：新建 fast-operator 旁路，不动现有链路**。现有 `xiaowei-device-read.mjs` / `xhs-remote-gateway.mjs` / `composite-workflow` 原样保留，现有 571 测试零回归。旁路独立验收。

## 瓶颈结构（三份分析坐实）

真实地板（01 真机实测，绕过网关直连 adb）：
- `uiautomator dump /dev/tty` = **2.42s / 40KB**（Android uiautomator 本身成本，传输层省不掉，只能靠**少 dump**）
- `input swipe` = 0.51s，`input tap` = 0.42s（持久 adb shell 可再砍 ~0.15s/次 adb 客户端启动）

结构性根因：
1. **每个网关命令 = 3 层进程 spawn 链**（Node→PowerShell→Node）+ **每个 primitive 各开一个 WebSocket**（不复用）。一条评论 15-30 次 WS 握手/拆除。
2. **评论热路径黑洞**：6s 固定 grace sleep + 60×2500ms 验证循环（150s 预算）+ **512 次 keyevent 清空风暴**（即使编辑器已空也发）+ 两次 waitForIme（各 5s）+ restoreEditorFocus（9s、24 dump）。单条评论慢机常 30-60s，且该机调度器全程被锁死串行。
3. **同卡 hierarchy 反复 dump**：like→favorite→评论开→评论发 各自重新 dump，一张卡 4-8 次本可 1-2 次。**最大杠杆**：2.4s × (4-8→1-2) = 每卡省 5-15s。
4. **进主页/刷主页/刷主页视频/不进正文点赞 无 in-process 实现**：`open-profile` 在 `xiaowei-device-read.mjs` 只有 CLI 注册桩没函数体，只能走最重的 3 进程网关链。
5. **无"滚 N 张再 dump 一次"原语**，每 fling 一次就 2-4 次 dump。
6. playbook `observe→resolve→recheck→execute→verify→record` 的 `recheck`（第二份新鲜证据防漂移）= "每动作前再 dump 一次"，为安全装，正是吞吐杀手。

## 架构：fast-operator 旁路

`scripts/fast-operator.mjs` — 长驻 Node 进程，**不经过网关**：

- **持久 adb shell**：每台设备 `spawn(adbPath, ["-s", serial, "shell"])` 一个常驻子进程，命令走 stdin，stdout 用 sentinel 分帧。砍掉每 primitive 的 adb 客户端启动 + 网关 3 进程 spawn + 每 primitive WS 握手。
- **单 dump 多动作**：一次 hierarchy dump 解析成 `document`，同卡的 like/favorite/comment-open/comment-send 共用，不再各 dump。`like+favorite` 共用一次 `stableUi`。
- **scroll-N-then-dump**：连续 N 次 `input swipe` 只在最后一次后 dump 一次（feed 滚屏找目标用）。
- **下一卡预取**：当前卡 engage 时，预取/预解析下一卡候选（与评论发送验证尾重叠）。
- **轻量审计**：每 N 步一次 checkpoint（批量异步 fsync），失败才截图、失败才写 evidence，无每步 ledger 锁轮询。
- **拟人限速层**：每动作间随机间隔（如 800-2500ms）、每日动作上限、不连发、模拟阅读停留（按内容长度带抖动）、全局速率预算。这是风控，不是吞吐的敌人——节奏本身就是反封号。
- **AI 组合**：每卡调一次轻量"operator 决策"（分类卡片：视频/图文/广告/私密号/评论关闭/已点赞 → 选动作），处理边缘情况自己决定跳过或换动作。决策可由本进程内调 LLM（新 operator role，拆围栏）或外部 agent loop 驱动。

## 分片

### Slice 1 · 底座 + 读侧轻互动员工（本批）
- fast-operator 长驻进程 + 持久 adb shell + 自包含 XML 解析器
- 原语：observe-feed、scroll、scroll-n-dump、like-card、favorite-card（单 dump 服务两个）、open-profile、scroll-profile、play-profile-video、like-without-entering
- 轻量审计 + 拟人限速
- loopback HTTP 表面（:17895）+ 内置 demo 循环
- **验收**：01 真机跑读侧轻互动循环（滚屏→点赞→收藏→进主页→刷主页→不进正文点赞），测吞吐 vs 07-17 基线（单步 7-14s），目标单步 1-3s。

### Slice 2 · 评论自主（拆围栏）
- `comment.transaction`：开+输+发一进程，早退（首个 poll 成功即返回）+ 指数退避 + 跳 512 keyevent 风暴（`xhsEditorIsEmpty` 已空则跳）
- `reply.transaction` 同理
- 拆 `FORBIDDEN_OUTPUT_PATTERN` + `comment_assistant` 人类触发；保留敏感页 STOP_FOR_HUMAN
- 拟人限速覆盖评论（更长间隔、更长停留、每日评论上限）
- 验收：01 真机自主评论+回复，测单条评论 5-8s（vs 30-60s 基线），限速生效

### Slice 3 · 自适应组合
- operator 决策 role：observe-feed → 卡片分类 → 每卡选动作 → 边缘情况自决（评论关闭跳过、已点赞 no-op、私密号跳进主页、视频自动播判停）
- 用户可声明运营意图（如"今天主刷同领域、互动率 30%、评论率 10%"），员工自己排组合
- 验收：01 真机无人监督跑 30 分钟混合循环，节奏拟人、无连发、无封号触发、吞吐达预期

## 回归边界

- 不改 `xiaowei-device-read.mjs` / `xhs-remote-gateway.mjs` / `xiaowei-transport.mjs` / `composite-*`。现有 571 测试不碰。
- fast-operator 新增文件 + 新增测试，独立 `Test-Project.ps1` 入口。
- 真机验证只用 01，验证完恢复首页清洁态。
- 拆围栏只动 `ai-role-runner.mjs`（Slice 2），且新增风控层补偿。

## 安全 / 封号风险

- 全自主+拟人限速是用户选定档位，中可控风险。
- 限速层硬上限：每动作类型每日上限、最小间隔、随机抖动、模拟阅读。任何节奏异常 fail-safe 停机待人工。
- 不碰私信（用户明确排除）。私信仍走原有人类确认链路。