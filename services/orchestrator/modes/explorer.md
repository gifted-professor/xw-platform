# Explorer Mode v2 — 便宜 agent 探路契约

> **一句话**：只读/可逆地弄清一个 App 面或一条短流程；结论进知识库；禁止旁路与外发副作用。  
> **入口 cwd**：`xhs-registry`。执行码在 Windows `main`。

---

## 0. 开工前 Preflight（硬性）

**任一步失败 → 禁止开干。**

```bash
node ops/explore-preflight.mjs --alias 01
# 仅当仍依赖旧 17910 设备 API 时：再加 --require-17910（默认不需要）
```

脚本检查：17930/17920 health → agent-entry ready/lease → control devices online；**17910 为可选探测**（`ops/dump-ui|tap|focus|launch-app|screenshot` 走小薇 **22222**，不绑 17910）。见知识库 `note-17910-optional-for-explorer-ops-20260727`。

也可手查：

```bash
ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/api/health'
ssh xhs-windows 'curl.exe -s http://127.0.0.1:17920/control/v1/health'
ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/agent-entry.md'
```

截屏 / dump / tap / 输入 / 开 App（**禁止**手搓临时脚本；**不依赖 17910**，走小薇 22222）：

```bash
node ops/screenshot-and-analyze.mjs --alias 01   # SHOT=/path.png
node ops/dump-ui.mjs --alias 01                  # DUMP=/path.xml
node ops/focus.mjs --alias 01                    # FOCUS=pkg/activity
node ops/tap.mjs --alias 01 --x 540 --y 1200     # TAP=ok
# 中文输入：效卫 XwIME（禁止 adb input text / clipboard 当主路径）
node ops/input-text.mjs --alias 01 --text "蓝色" --x 540 --y 1200 --enter
# 多行描述：首行 refocus；后续 --no-refocus 保光标（每行再点会跳位/乱序）
node ops/input-text.mjs --alias 01 --text "行1" --x 540 --y 870 --enter --keep-ime
node ops/input-text.mjs --alias 01 --text "行2" --enter --keep-ime --no-refocus
node ops/launch-app.mjs --alias 01 --package com.taobao.idlefish
```

> 以上是 **Explorer lab 通道**（22222）。生产业务仍用 job/session；探索可用，不用于 R2 外发。  
> **Flutter（闲鱼）**：首进字段带 `--x --y` refocus；**多行连续**后续用 `--no-refocus`（+ 建议 `--keep-ime`）；SKU 规格值加 `--enter`。见 `pitfall-input-text-multiline-refocus-20260727`。

---

## 1. 禁止

| 禁止 | 原因 |
|------|------|
| 无 lease 的 GatewayOperator / 临时 `_*.mjs` 干跑 | 入口违规 |
| 写 control.db、调用 approve/deny | 红线 |
| R2/R3 **执行**外发（评论/发布/私信…） | 只允许 submit 挂起等人 |
| 逐步 scp 临时脚本当默认手法 | 用 `screenshot-and-analyze.mjs` |
| 有 dump/语义仍 vision 死磕；同目标 vision **>2 次** | VLM 像素 Y 可偏 **−1330px**（见下）；费时 |
| 交互式 session 长时间不 heartbeat | lease 可能被回收；≤20s 心跳或改用 job |
| 遇验证码/风控/登录墙继续点 | 立即停 + knowledge |
| 一次会话多个主 flow | 失焦；一轮一个 scope |
| 编造验证结果 | `verifyMode=human` 时标待人 |

---

## 2. 允许

- 读 agent-entry / knowledge / capabilities  
- 写 knowledge（recipe / pitfall / unknown）  
- R0/R1 job（observe、`*_dry_run` 等 automatic）  
- Explorer ops：preflight / screenshot / **dump-ui / tap / input-text / focus / launch-app**（lab **22222**，不绑 17910）  
- session canary（若 capability 要求且 lease 可见）；**长 session 每 ≤20s heartbeat**，否则优先 job 模式  


---

## 3. 能力在哪

| 需要 | 去哪 |
|------|------|
| live 状态 | `GET …:17930/api/agent-entry` |
| 能力目录 | `GET …:17930/api/capabilities` 或控制面 |
| 生产碰机 | `devicectl job/session` 正道 |
| 探索交互 | `ops/tap\|input-text\|dump-ui\|focus\|launch-app\|screenshot-and-analyze.mjs`（**22222**，不绑 17910） |
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
| 坑 | pitfall（vision 偏移、dump 空、preflight 失败原因） |
| 交接摘要 | **写在同一 knowledge content** 小节「交接摘要」（不强制独立 HANDOFF 文件） |

---

## 10. 派工模板（复制即用）

```text
你是 Explorer Mode。只读 xhs-registry/modes/explorer.md。

输入:
  mode: explorer
  actor: mimo-explore-YYYYMMDD
  app: <xianyu|xhs|wechat|…>
  scope: <一句范围>
  goal: map | verify-flow
  depth: E0 | E1
  alias: 01
  budget: { max_minutes: 20, max_jobs: 5 }
  allow_switch_device: false

步骤:
  1) timeout 1200 node ops/explore-preflight.mjs --alias 01
  2) 需要截屏: node ops/screenshot-and-analyze.mjs --alias 01
  3) 正道 devicectl job only；dump-first；vision≤2/目标（Y 可偏 −1330px，有 bounds 禁 vision）
  4) 若用 session：每 ≤20s heartbeat；否则优先 job
  5) 结束 POST knowledge（成功 A/B/C 或 aborted）

禁止: 旁路碰机、approve、R2 执行、逐步 scp、vision 死磕、无 heartbeat 长 session。
```

### 模式对照

| 模式 | 何时 | 入口 |
|------|------|------|
| **Explorer** | 未知面/探路 | 本文 + preflight + screenshot 脚本 |
| **Runner** | 已知回归 | `ops/conc4-full-dry-run.mjs` |
| **Fix** | 改代码 | Grok/GLM；非本模式默认 |
