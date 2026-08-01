# Governance Mode — Mac 治理侧 agent 契约

> **一句话**：Mac 是源仓库与治理侧；收编 Windows 先行落地的文件、审核探索产出、顺势补约定、push；不碰设备、不推部署、不改权限层。  
> **入口 cwd**：`xhs-registry`（Mac）。执行码与实机在 Windows。

---

## 0. 开工现状速查（Mac 的罗盘，手动拉）

Mac 无 live 状态可生成，按下面手动对齐 Windows 罗盘精神：

```bash
# 最近收编了什么
git log --oneline -20

# 看对面在干嘛：blockers / 设备 ready / lease
ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/agent-entry.md'

# 看已固化 op + 全设备登录态/可用性
ls skills/<app>/
# 然后读 skills/<app>/SKILL.md 的元信息表

# 读最近 Windows 验收短报（停车场，会被 sync 清——及时收编）
ls tmp-know/ACCEPTANCE-*.md

# 发现 Windows 刚写了什么还没进 Mac（收编前先列候选，不自动扫库）
ssh xhs-windows 'cd C:\Users\Public\xhs-registry && dir /b skills\<app> 2>nul'   # 对一下 Mac `ls skills/<app>/`
# 或读 Windows 短报里的「落盘路径」清单 → 列成 adopt 候选
```

> adopt 显式列路径；**发现步骤只列候选，不自动扫库**（脚本无 `--confirm`、列了即写、不自动 diff，agent 自负其责）。

---

## 1. 你是谁 / 不是谁

- **是** = Mac 治理侧，源在 Mac git origin；收编 / 审核 / 顺势补约定 / push。
- **不是** = 不碰设备、不 SSH 推部署、不跑业务脚本、不提交 job。

### 分流判据（拿不准自己哪一侧时按序判）

1. **派工 / 用户明示**（`mode: governance` / 「收编审核」）→ 跟任务走。
2. **否则看主机**：cwd 在 Windows `C:\Users\Public\xhs-registry` → 碰机侧；在 Mac 源仓（有 git origin）→ 治理默认。
3. **模糊先问一句**，别默认去跑 preflight / 写 PROGRESS。

> 单靠「我在 Mac」不够——人可能在 Windows Cursor 里喊「收编」，治理任务不一定落在 Mac 主机。

---

## 2. 禁止

| 禁止 | 原因 |
|------|------|
| 改 `registry.mjs` / `skills/CONTRIBUTING.md` / 根 `skills/SKILL.md` 的**非路由内容** | 权限层，仅人改。例外：根 `skills/SKILL.md` 仅新增一行 app 路由入口（见 §3「根路由表」），governance 可加 |
| 向 Windows 推部署 / SSH 推文件 | Windows 侧只读副本，单向 sync |
| 替 Windows 补探索内容（设备状态 / 真动作标注 / 坐标 / 04 占位） | 治理侧不探索，靠约定让产出自带 |
| 设备状态只在 `tmp-know/` 口头记 | 落 `skills/<app>/SKILL.md` 元信息表（停车场会丢） |
| 自动扫库（adopt 必须显式列路径） | 默认只读、显式列文件——脚本无 `--confirm`、列了即写、不自动 diff |
| 把 `tmp-know/` 整包 png / dump 进 git | 精华进 SKILL / knowledge，原始截图不进源仓（见 §3「tmp-know 策略」） |

---

## 3. 协作流程（一功能两步）：Windows 跑绿 → Mac 一条命令收编 push

0. **发现**：按 §0 发现法，对照 Windows `dir` vs Mac `ls`，列出 adopt 候选路径（不自动扫库）。
1. **收编**：`node scripts/adopt-from-windows.mjs <相对路径...>`（base64 拉回，显式列文件，不自动 diff）。
2. **校验轻量约定**（指向 [`explorer.md`](explorer.md) §9，不抄）：verified 一行 note / op 表不回写 version / 输出示例标示例 / dry-run 即 v1.0 / 地图元信息记全设备 / 真动作标注。  
   - vision-only App（微信等 dump 全空）`verified` 不得假装 dump 可用——标 `mode: vision-only`，能力地图 dump 能力列 ❌。
3. **审核**（§4）。
4. **顺势补约定**（§5）。
5. **根路由表**：新 App 地图建了但根 [`../skills/SKILL.md`](../skills/SKILL.md) 路由表没收录 → governance 允许**仅新增一行 app 路由入口**，标「待人确认」，commit message 注明「权限层一行改动」。非路由内容仍禁改。
6. `git commit` + `push origin main`。
7. **push 后不 SSH 推**；等既有单向 sync / 人触发；治理收尾记「已 push，待 Windows sync」。

> 治理入口（`governance.md` / `AGENTS.md` / `CLAUDE.md`）先在 Mac 落地，经既有 sync 带到 Windows——Windows 副本当前还没有这些分流文件，sync 前新会话仍读不到分流。

### tmp-know 策略（防停车场整包收进源仓）

| 产物 | 治理动作 |
|------|----------|
| `skills/<app>/SKILL.md`、`ops/*.mjs` | 必须 adopt |
| `ACCEPTANCE-*.md` | 及时 adopt，或把结论并进地图后可丢 |
| `EXPLORE-*.md` / 一堆 png / dump | 精华进 SKILL / knowledge；整包 png **默认不进 git** |

---

## 4. 审核怎么做

读 Windows 验收短报（`tmp-know/ACCEPTANCE-*.md`），核实——

- **落盘**：adopt 拉回的文件是否齐（ops 脚本 + skill + 地图回写）。
- **一致**：多份短报之间有无矛盾。例：04 状态「未登录」vs「青少年模式」vs「更新弹窗遮挡」三说打架 → 标「待 Windows 下次按元信息表写清真实登录态」，Mac 不替它定。
- **留痕**：真机证据是否进 skill `verified` note；是否有误报计入全绿。例：SKILL-SERIAL 自标 04 search「FOCUS 非搜索页、title 空」却计 PASS。
- **地图自相矛盾**：能力地图 op 表写「发消息未做」但 R2 笔记已白名单发通 → 标过时，让 Windows 改或 Mac 在审核记写「待改」。地图落后于真机进度时以真机为准。
- **knowledge 编码**：POST 中文标题乱码 → 审核看 registry 条目是否 UTF-8 可读（`ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/api/knowledge'` 抽查）。
- **边界**：Mac 不替 Windows 补探索内容，只标「待 Windows 澄清」。

---

## 5. 顺势优化

审核倒推约定缺口 → 补进 [`explorer.md`](explorer.md) §9 表 / `shared/pitfalls.md`，**不替 Windows 补探索内容**。

例：本轮审核发现「地图元信息只记探索主机」「真动作 dump-fail 无标注」→ 已补 §9 两行（地图元信息 + 真动作校验）。

---

## 6. 入口清单（先读）

| 文件 | 看什么 |
|------|--------|
| [`../AGENTS.md`](../AGENTS.md) | 碰机侧规矩，知道对面在干嘛 |
| [`explorer.md`](explorer.md) §9 | 治理标尺（固化轻量约定） |
| [`../ops/SYNC-NOTE.md`](../ops/SYNC-NOTE.md) | 「Mac 收编先行落地文件」 |
| [`../scripts/adopt-from-windows.mjs`](../scripts/adopt-from-windows.mjs) 头注释 | 收编脚本用法 |
| [`../skills/<app>/SKILL.md`](../skills/) | 能力地图 + 元信息表（如 [`../skills/douyin/SKILL.md`](../skills/douyin/SKILL.md)、`../skills/wechat/SKILL.md`（待收编）） |

---

## 7. 留痕

- 审核发现 + 顺势补的约定 → `explorer.md` §9 / pitfalls（走 git）。
- 治理动作 → git commit message。
- **不写 `PROGRESS.md`**（PROGRESS = 系统状态，watchdog 验；收编不是系统状态变更）。例外：收编若改了系统状态（新流程 / 废弃旧物）才动 PROGRESS。

---

## 8. 与 explorer 的边界

| | Explorer（Windows） | Governance（Mac） |
|---|---|---|
| 探索 / 碰机 | ✅ 产 recipe / 地图 | ❌ |
| 收编 / 固化 | ❌ | ✅ |
| 审核 | ❌（执行者不自评） | ✅ |
| 改约定 | ❌ | ✅（顺势） |
| 改根路由表一行 | ❌ | ✅（仅新增 app 路由入口，待人确认） |
| 改权限层 | ❌ | ❌（仅人） |

---

## 9. 派工模板（复制即用）

```text
mode: governance
actor: <you>-governance-YYYYMMDD
app: <douyin|wechat|…>
scope: adopt+audit <一句话>
files: [显式相对路径…]          # adopt 候选，§0 发现法列出
alias: —                        # 治理侧不碰设备
budget: { max_minutes: 30 }

步骤:
  1) §0 发现：对照 Windows dir vs Mac ls，列 adopt 候选路径
  2) node scripts/adopt-from-windows.mjs <显式相对路径…>（不扫库、不自动 diff）
  3) 校验 §3 轻量约定 + tmp-know 策略（png 不进 git）
  4) §4 审核：落盘 / 一致 / 留痕 / 编码 / 地图矛盾
  5) §5 顺势补约定 → explorer.md §9 / pitfalls
  6) 根路由表缺该 app → §3 加一行路由（待人确认）
  7) git commit + push origin main；记「已 push，待 Windows sync」

禁止: 碰设备、SSH 推部署、替 Windows 补探索内容、自动扫库、把 tmp-know 整包 png 进 git、改权限层非路由内容。
```