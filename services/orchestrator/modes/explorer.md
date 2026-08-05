# Explorer Mode v2 — 便宜 agent 探路契约

> **一句话**：只读/可逆地弄清一个 App 面或一条短流程；结论进知识库；禁止旁路与外发副作用。  
> **入口 cwd**：`xhs-registry`。执行码在 Windows `main`。

### 运行代码为准 + 文档债明示（REX Phase 6 起）

权威顺序：**deployed release code + live agent-entry/task packet** > 顶层
AGENTS/modes/skills 路由说明 > 尚未迁移的 App 子 Skill Markdown。

- 开工先读 live 入口的 **Release / runtime policy** 段（JSON `release` 块）：
  `ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/agent-entry.md'`
  字段：`releaseId / runtimePolicyVersion / effectiveDecisionSource / policyMode /
  evidenceMode / policyDocDebt`。
- `policyDocDebt` 只提醒哪些旧文档仍未迁移，**不阻止任何任务**；它列出的文件里的
  「需审批」旧文案若已被当前 release 的 policy/task packet superseded，以 release 为准。
- 本契约与旧 App 子 Skill 文案都不能放宽唯一硬闸：**真实资金 final commit → 等人类
  确认，transport 保持 0**。

---

## 0. 开工前 Preflight（硬性）

**任一步失败 → 禁止开干。**

Windows 本机 `/xw explore` 必须先 acquire 正式 session；`preflight` 单独运行只能体检，不能授权后续碰机：

```powershell
$xwSession = "$env:USERPROFILE\.xhs-explorer-sessions\xw-explore-<runId>-01.json"
node ops/xw-explore-session.mjs acquire --alias 01 --actor <actor> --session-file $xwSession
node ops/explore-preflight.mjs --alias 01 --session-file $xwSession
# 仅当仍依赖旧 17910 设备 API 时：preflight 再加 --require-17910
```

`acquire` 会创建控制面可见的 exclusive canary session；每条设备 op 都会 heartbeat，第二个 agent 会得到 `DEVICE_BUSY`。它不会启动脱离 owner 的后台 keeper；长时间只观察时可在前台运行 `keepalive`。任务结束无论成功、失败或中止都执行：

```powershell
node ops/xw-explore-session.mjs release --session-file $xwSession
```

跨机任务先逐台 acquire；每个 alias 必须有自己的 context，不能共享 token。集合脚本使用 `<session-dir>\<alias>.json`：

```powershell
$xwSessionDir = "$env:USERPROFILE\.xhs-explorer-sessions"
node ops/xw-explore-session.mjs acquire --alias 02 --actor <actor>-02 --session-file "$xwSessionDir\02.json"
node ops/xw-explore-session.mjs acquire --alias 03 --actor <actor>-03 --session-file "$xwSessionDir\03.json"
node ops/douyin-rail-set.mjs --aliases 02,03 --session-dir $xwSessionDir
# finally：分别 release 02.json、03.json
```

控制面按设备原子互斥；不同设备可并行，同一设备始终串行。任一 acquire 失败时只释放本轮已拿到的 context，不得改用无 lease 旁路。

脚本检查：17930/17920 health → agent-entry ready/lease → control devices online；**17910 为可选探测**（`ops/dump-ui|tap|focus|launch-app|screenshot` 走小薇 **22222**，不绑 17910）。见知识库 `note-17910-optional-for-explorer-ops-20260727`。

也可手查：

```bash
ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/api/health'
ssh xhs-windows 'curl.exe -s http://127.0.0.1:17920/control/v1/health'
ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/agent-entry.md'
```

截屏 / dump / tap / 输入 / 开 App（**禁止**手搓临时脚本；**不依赖 17910**，走小薇 22222）：

```bash
node ops/screenshot-and-analyze.mjs --alias 01 --session-file $xwSession   # SHOT=/path.png
node ops/dump-ui.mjs --alias 01 --session-file $xwSession                  # DUMP=/path.xml
node ops/focus.mjs --alias 01 --session-file $xwSession                    # FOCUS=pkg/activity
node ops/tap.mjs --alias 01 --session-file $xwSession --x 540 --y 1200     # TAP=ok
# 中文输入：效卫 XwIME（禁止 adb input text / clipboard 当主路径）
node ops/input-text.mjs --alias 01 --session-file $xwSession --text "蓝色" --x 540 --y 1200 --enter
# 多行描述：首行 refocus；后续 --no-refocus 保光标（每行再点会跳位/乱序）
node ops/input-text.mjs --alias 01 --session-file $xwSession --text "行1" --x 540 --y 870 --enter --keep-ime
node ops/input-text.mjs --alias 01 --session-file $xwSession --text "行2" --enter --keep-ime --no-refocus
node ops/launch-app.mjs --alias 01 --session-file $xwSession --package com.taobao.idlefish
```

> 以上是持正式 canary session lease 的 **Explorer lab 通道**（22222）。缺 `--session-file`、alias/serial 不匹配、heartbeat 失败或 lease 不可见都会在设备 I/O 前拒绝；不用于 R2 外发。
> **Flutter（闲鱼）**：首进字段带 `--x --y` refocus；**多行连续**后续用 `--no-refocus`（+ 建议 `--keep-ime`）；SKU 规格值加 `--enter`。见 `pitfall-input-text-multiline-refocus-20260727`。

---

## 1. 禁止

| 禁止 | 原因 |
|------|------|
| 无 lease 的 GatewayOperator / Explorer ops / 临时 `_*.mjs` 干跑 | 入口违规；脚本现已 fail closed |
| 写 control.db、调用 approve/deny | 红线 |
| R2/R3 **执行**外发（评论/发布/私信…） | 只允许 submit 挂起等人 |
| 逐步 scp 临时脚本当默认手法 | 用 `screenshot-and-analyze.mjs` |
| 有 dump/语义仍 vision 死磕；同目标 vision **>2 次** | VLM 像素 Y 可偏 **−1330px**（见下）；费时 |
| 交互式 session 长时间不 heartbeat | 每个 op 自动 heartbeat；纯观察期若需续租则前台 keepalive，仍须 finally release |
| 遇验证码/风控/登录墙继续点 | 立即停 + knowledge |
| 一次会话多个主 flow | 失焦；一轮一个 scope |
| 编造验证结果 | `verifyMode=human` 时标待人 |

---

## 2. 允许

- 读 agent-entry / knowledge / capabilities  
- 写 knowledge（recipe / pitfall / unknown）  
- R0/R1 job（observe、`*_dry_run` 等 automatic）  
- Explorer ops：先 `xw-explore-session acquire`，再用同一个 `--session-file` 执行 preflight / screenshot / **dump-ui / tap / input-text / focus / launch-app**（lab **22222**，不绑 17910）
- session canary lease 必须在控制面可见；每个 op 自动 heartbeat，结束显式 release


---

## 3. 能力在哪

| 需要 | 去哪 |
|------|------|
| live 状态 | `GET …:17930/api/agent-entry` |
| 能力目录 | `GET …:17930/api/capabilities` 或控制面 |
| 生产碰机 | `devicectl job/session` 正道 |
| 探索交互 | `ops/xw-explore-session.mjs` acquire 后，所有原子脚本带同一个 `--session-file`（**22222**，不绑 17910） |
| 观测 capability | `xhs.observe.*` / `xianyu.observe.snapshot` / `wechat.observe.*` |
| 已知剧本回归 | **Runner**：`ops/conc4-full-dry-run.mjs` |

---

## 4. 何时查知识库

1. **开工前** `GET /api/knowledge?app=<app>&q=<scope>` — 有 recipe 则 **先验证** 再重探  
2. 踩坑前搜是否已有同题  
3. **结束时** 必写（成功或 aborted）  
4. 不以旧 HANDOFF 当 live 状态  

---

## 5. 定位策略（默认 + 自动降级）

```
默认：dump-first（大部分原生 App）

启发（非穷尽名单）：
  · FlutterBoost / 弱 class（闲鱼等）→ 语义树 / observe 优先
  · dump 全空（微信等）→ vision-only 高成本档（budget 用 40min）
  · 未知 App → 先 dump；空则降级 vision（限次）

vision 同一目标 2 次失败：
  → 写 pitfall（含坐标/偏移）
  → 再试 dump/semantic（若未试）
  → 仍空 → dump_capability=none
  → 终止；knowledge 标「需人工介入」
  → 不默认换机（除非 allow_switch_device: true）
```

**已知（Hermes 2026-07-27 实机 01）**：VLM（如 mimo-v2.5）对**绝对像素** Y 系统性偏低——XHS 底栏 dump Y=2279 vs vision Y=949 → **ΔY=−1330px**（ratioY≈0.416）；微购约 −160~−179px。X 偏差较小。**不是**单纯截图缩放，换模型也难当主眼；有 bounds 时**禁止**用 vision 像素。知识库：`pitfall-vision-vlm-y-bias-20260727`。优先 dump/语义；dump 空时 vision 限次且宜出区域描述而非裸坐标。

---

## 6. 成功判据

**探索成功** ⇔ 至少一项并已写入 knowledge：

| 码 | 判据 |
|----|------|
| **A** | 目标 App 主页/目标 Activity 已确认（focus + jobId/证据） |
| **B** | 目标元素 bounds 或稳定定位策略已记录（dump/semantic 优先） |
| **C** | 该 App dump 能力 ✅/⚠️/❌ 已记录 |

超时/预算用尽：写 knowledge `status=aborted` + 原因 → **受控结束**，不算成功。

---

## 7. 预算（不靠自觉）

| 档 | max_minutes | 外部命令示例 |
|----|-------------|--------------|
| E0 / dump 可用 E1 | 20 | `timeout 1200 node …` 或调度杀进程 |
| vision / 微信 | 40 | `timeout 2400 …` |

派工 prompt 必须写死墙钟上限；agent 超时也须写 aborted knowledge。

---

## 8. 与 scout

Explorer 产出 recipe 默认 **`verifyMode=human`**，content 可带 `[explorer]`。  
**scout 定时任务不自动 verify/覆写**；人确认或改成 replay/constraint 后再交给 scout。

---

## 9. 产出落点

| 类型 | 落点 |
|------|------|
| 结论/坐标/dump 能力 | `POST /api/knowledge` id=`explore-<app>-<scope>-<yyyymmdd>` |
| **App 级能力地图** | `skills/<app>/SKILL.md`（App 总览页，`v0.x`/`verified:false` 起步；探索散条在此聚合，单 op 固化后下沉 `skills/<app>/<op>/`） |
| 坑 | pitfall（vision 偏移、dump 空、preflight 失败原因）→ `shared/pitfalls.md` 对应章节 |
| 交接摘要 | **写在同一 knowledge content** 小节「交接摘要」（不强制独立 HANDOFF 文件） |

> 新 App 首轮探索即建 `skills/<app>/SKILL.md` 当能力地图**唯一权威落点**，勿把地图停在 `tmp-know/` 草稿停车场——草稿会被下次同步/清理丢失，且无契约约束。

### 固化轻量约定（explore 散条 → `skills/<app>/<op>/` v1.0）

固化成业务脚本时**别过度仪式化**，守住三条：

| 项 | 约定 |
|----|------|
| `verified` | `verified: true` + 一行 note（`date / device / result`，dry-run 加 `mode: dry-run`）。**不写 `changelog` 数组**——git 历史就是 changelog。 |
| 能力地图 op 表 | `skills/<app>/SKILL.md` 的 op 表只列 `op` + 链接 + 自由度，**不跟踪 version 文字**（状态看子 skill frontmatter，别每次升 v1.0 都回写那一行）。 |
| 输出示例 | 标「示例，非实机值」，**不追着实机值改**。实机值进 `verified` note。 |
| dry-run | dry-run 真机跑绿即升 `v1.0 / verified:true`（note 标 `mode: dry-run`）。真动作（真赞 desc 翻转、真发评论）是**下一功能**，不作为本功能升 v1.0 的门槛。 |
| 地图元信息 | `skills/<app>/SKILL.md` 元信息表记**全设备清单 + 各设备登录态/可用性**（正常 / 未登录 / 受限 / 青少年模式），不止记探索主机；集合验收排除某机时，原因落此表——勿只在 `tmp-know/` 短报口头记（停车场会丢）。 |
| 真动作校验 | 真动作若「视觉成功但 dump 校验失败」（点后 a11y 死等），skill `verified` 仍只标 dry-run，**另起一行 `real-action: <op> 视觉成功/dump-fail，校验方式待定`** 显式标注，勿让后人误判真动作已验或未验。 |

**收编**：Windows 先行落地的文件，Mac 一条命令拉回——`node scripts/adopt-from-windows.mjs <相对路径...>`（显式列文件，base64 拉回，不自动 diff）。

### Windows 写契约（让 Mac 能评判）

同轮探索结束：短报（`EXPLORE/ACCEPTANCE`）+ 地图元信息 + op 表**三处同改**；改不完 op 表时标 `stale-as-of <date>`，勿让地图落后于真机又不留痕（否则 Mac 评判会看到「短报新、op 表旧」的矛盾，如 wechat R2 已发但 op 表停 R1）。**本轮若有待 Mac adopt 的文件 → 追加/刷新 `skills/.SYNCED-FROM.md` 清单**，否则后半夜探索会丢发现信号（如 douyin `.SYNCED-FROM` 停在 00:45，只点名 like/collect 四文件，滞后于 01:00 后的 longpress/live-photo/live-comment/max-playbook/lyk-notes）。

---

## 10. 派工模板（复制即用）

```text
你是 Explorer Mode。只读 xhs-registry/modes/explorer.md。

输入:
  mode: explorer
  actor: mimo-explore-YYYYMMDD
  app: <xianyu|xhs|wechat|douyin|…>
  scope: <一句范围>
  goal: map | verify-flow
  depth: E0 | E1
  alias: 01
  budget: { max_minutes: 20, max_jobs: 5 }
  allow_switch_device: false

步骤:
  1) node ops/xw-explore-session.mjs acquire --alias 01 --actor <actor> --session-file "$env:USERPROFILE\.xhs-explorer-sessions\<run>-01.json"
  2) timeout 1200 node ops/explore-preflight.mjs --alias 01 --session-file <same-path>
  3) 需要截屏: node ops/screenshot-and-analyze.mjs --alias 01 --session-file <same-path>
  3) 正道 devicectl job only；dump-first；vision≤2/目标（Y 可偏 −1330px，有 bounds 禁 vision）
  4) 所有设备 ops 必须传同一个 session file；alias/lease 不符立即停
  5) 结束 POST knowledge（成功 A/B/C 或 aborted），finally release session

禁止: 旁路碰机、approve、R2 执行、逐步 scp、vision 死磕、无 heartbeat 长 session。
```

### 模式对照

| 模式 | 何时 | 入口 |
|------|------|------|
| **Explorer** | 未知面/探路 | 本文 + preflight + screenshot 脚本 |
| **Runner** | 已知回归 | `ops/conc4-full-dry-run.mjs` |
| **Fix** | 改代码 | Grok/GLM；非本模式默认 |
