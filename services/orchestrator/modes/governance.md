# Governance Mode — Mac 治理侧**评判技能**

> **一句话**：Mac 是源仓库与治理侧；收到 Windows 落盘 → **定位**对面落盘了什么 → **索引证据**（按权威度）→ **评判** → 决定怎么收编；不碰设备、不推部署、不改权限层（含根 `skills/SKILL.md`）。
> **入口 cwd**：`xhs-registry`（Mac）。执行码与实机在 Windows。

> 与 [`explorer.md`](explorer.md) 对称：**Windows skill = 怎么执行**（收到任务 → 按链路跑 → 边跑边落盘事实/坑/日志）；**Mac skill = 怎么评判**（收到 Windows 落盘 → 定位/索引证据/评判/决定收编）。

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
```

### 发现信号（多路，不只 `ls skills/`）

收编前先列候选，**不自动扫库**：

- 读 Windows `skills\.SYNCED-FROM.md`（待 adopt 清单，最直接）：
  `ssh xhs-windows 'powershell -NoProfile -Command "[Convert]::ToBase64String([IO.File]::ReadAllBytes(\"C:\\Users\\Public\\xhs-registry\\skills\\.SYNCED-FROM.md\"))"'` → 本地 `echo <b64> | base64 -D`。
- 扫 `tmp-know\HANDOFF-WIN-*.md`（Windows 交接说明）、`ACCEPTANCE-*.md`（验收短报）、`EXPLORE-*.md`（探索短报）：
  `ssh xhs-windows 'cmd /c "dir /b C:\Users\Public\xhs-registry\tmp-know\*.md"'`
- 对照 Win `dir skills\<app>` vs Mac `ls skills/<app>/`。

> adopt 显式列路径；**发现步骤只列候选，不自动拉回**（脚本无 `--confirm`、列了即写、不自动 diff，agent 自负其责）。读 Windows 文件用 base64（避免 GBK 乱码）。

### 接盘第一轮（没人派工给你时）

跑下面罗盘 + §4 定位 → 出一份「**现状 + 待收编候选 + 建议下一刀**」报告给人，**等人确认再收编**（不自动干）。对应 AGENTS.md「第二步：汇报再动手」——治理侧也守这条。

---

## 1. 你是谁 / 不是谁

- **是** = Mac 治理侧，源在 Mac git origin；定位 / 索引证据 / 评判 / 收编 / 审核 / 顺势补约定 / push。
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
| 改 `registry.mjs` / `skills/CONTRIBUTING.md` / **根 `skills/SKILL.md`（含路由表）** | 权限层，仅人改；governance **不碰**，只标「待人加路由」或写提案 |
| 向 Windows 推部署 / SSH 推文件 | Windows 侧只读副本，单向 sync |
| 替 Windows 补探索内容（设备状态 / 真动作标注 / 坐标 / 04 占位 / 建 App 地图） | 治理侧不探索，靠约定让产出自带 |
| 设备状态只在 `tmp-know/` 口头记 | 落 `skills/<app>/SKILL.md` 元信息表（停车场会丢） |
| 替 Windows 改 op 表 / 真动作标注 | 只标「待 Windows 澄清/改」（见 §6 stale 规则） |
| 自动扫库（adopt 必须显式列路径） | 默认只读、显式列文件——脚本无 `--confirm`、列了即写、不自动 diff |
| 把 `tmp-know/` 整包 png / dump 进 git | 精华进 SKILL / knowledge，原始截图不进源仓（见 §3「tmp-know 策略」） |

> 根 `skills/SKILL.md` 是给人看的索引（第 142 行「agent 只能写提案」）。让 agent 改会复现 op 表 stale 失败、越积越脏。**评判结论给人，人加路由行**——governance 不碰根 SKILL.md。

---

## 3. 协作流程（一功能两步）：Windows 跑绿 → Mac 一条命令收编 push

0. **发现**：按 §0 发现信号，对照 Windows vs Mac，列出 adopt 候选路径（不自动扫库）。
1. **定位 + 评判**：§4 定位落盘 → §5 索引证据 → §6 评判（决定收编/升级/标 stale/标缺地图）。
2. **收编**：`node scripts/adopt-from-windows.mjs <相对路径...>`（base64 拉回，显式列文件，不自动 diff）。
3. **校验轻量约定**（指向 [`explorer.md`](explorer.md) §9，不抄）：verified 一行 note / op 表不回写 version / 输出示例标示例 / dry-run 即 v1.0 / 地图元信息记全设备 / 真动作标注。
   - vision-only App（微信等 dump 全空）`verified` 不得假装 dump 可用——标 `mode: vision-only`，能力地图 dump 能力列 ❌。
4. **审核**（§7）。
5. **顺势补约定**（§8）。
6. **评判结论**：若认为某 App 该入根路由 → governance **不碰根 SKILL.md**，在评判记写「待人加 `<app>` 路由行」，commit message 留痕。
7. `git commit` + `push origin main`。
8. **push 后不 SSH 推**；等既有单向 sync / 人触发；治理收尾记「已 push，待 Windows sync」。

> 治理入口（`governance.md` / `AGENTS.md` / `CLAUDE.md`）先在 Mac 落地，经既有 sync 带到 Windows——Windows 副本当前还没有这些分流文件，sync 前新会话仍读不到分流。

### tmp-know 策略（防停车场整包收进源仓）

| 产物 | 治理动作 |
|------|----------|
| `skills/<app>/SKILL.md`、`ops/*.mjs` | 必须 adopt |
| `ACCEPTANCE-*.md` | 及时 adopt，或把结论并进地图后可丢 |
| `EXPLORE-*.md` / 一堆 png / dump | 精华进 SKILL / knowledge；整包 png **默认不进 git** |

---

## 4. 定位（核心一）—— Windows 落盘了什么 vs Mac

列 Windows 落盘 vs Mac，出**待收编表**（按 App 打阶段牌，不一刀切）：

| App | 阶段 | tmp-know 证据 | 根路由 | App 级地图 | 治理动作（快照 a4716d5） |
|----|------|--------------|------|----------|---------|
| xhs | 已入路由/维护 | 0 | ✅8 行 | 无（共用根 SKILL.md） | 偏维护，按需审核 |
| douyin | 已收编/待固化新 op | 8 ACCEPTANCE + 5 EXPLORE（最厚） | ❌ 待人加 | v0.1，4 SKILL+pitfalls 已 adopt | 地图保 v0.1；新 op（longpress/live-photo/live-comment/max-playbook/lyk-notes）待 Win 固化 ops+ACCEPTANCE |
| wechat | 已入库/保 v0.1 | 2 EXPLORE，无 ACCEPTANCE | ❌ 待人加 | v0.1，已 commit | op 表 stale 待 Win 改（R2 已白名单发通但 op 表停 R1「未做」） |
| xianyu | 缺地图 | 0 .md（仅 png/xml） | ✅2 行 | ❌ 无 | 待 Win 建 App 级地图；tmp 存量 dump=Win 债，下轮 explorer 先建地图 |

> **快照截至 a4716d5，会过时——每次接盘以 §0 实拉为准，别照本表定 scope。** 定位只列候选，不自动拉回；阶段牌决定评判尺度——别用抖音的验收密度一刀切闲鱼/微信。

---

## 5. 证据地图（核心二）—— 每种产物是什么证据

**`tmp-know/*` = 停车场 / 支撑证据；权威落点 = `skills/<app>/SKILL.md`**（[`explorer.md`](explorer.md) §9 已写）。

| Windows 产物 | 是什么 | 怎么读 | 权威度 |
|----|----|----|----|
| `biz/ACCEPTANCE-*.md`（带 ops/* + exit/KV） | 真机验收记录 | base64 拉回读；查 ops 脚本 + exit 码 | **最高** |
| `EXPLORE-*.md`（当日、带具体动作） | 探索短报 | base64 拉回读 | 高 |
| `skills/<app>/SKILL.md` 正文新段（白名单/流程） | 地图正文 | adopt 后读 | 高 |
| `skills/<app>/SKILL.md` op 表 / knowledge 旧条 | 状态标注 | adopt 后读；易 stale | 低 |
| `tmp-know` 无日期/无复验散条 | 仅线索 | 不单独采信 | 仅线索 |
| png / dump | 原始截图 | 精华进 SKILL，整包不进 git | 支撑 |

---

## 6. 评判方法论（核心三）—— 多源矛盾怎么判

**多源矛盾按权威度判**：`biz/ACCEPTANCE` > `EXPLORE 短报` > `SKILL.md 正文新段` > `op 表 / knowledge 旧条` > `tmp-know 仅线索`。

- **stale 规则**：地图落后于真机进度时以真机为准。例：wechat op 表写「发消息未做」但 R2 笔记已白名单发通 → op 表 stale，标「待 Windows 改」，**Mac 不替改**。
- **不替 Windows 改 op 表 / 真动作标注**：只标「待 Windows 澄清/改」。
- **收编决策判据**：
  - 有验收/trace 证据 → 评估升 v1.0（按 explorer §9 dry-run 跑绿即升）；**升版对象是子 skill，不是 App 级地图聚合页**（地图页是汇总，comment/dm/live 等仍无 ops 时地图保 v0.1）。
  - 只有探索短报、无 op 固化 → 收编地图防丢，保 v0.1。
  - 多源矛盾 → **先标待澄清，不盲升**。
- 探索期无 biz 按 [`../ops/proposal-TEMPLATE.md`](../ops/proposal-TEMPLATE.md) §6 属正常，别当成「没做」。

### 罗盘边界（别混线）

| 罗盘 | 内容 | 进 adopt 评判？ |
|----|----|----|
| 本仓 `skills/` + explorer | 真机 22222 自动化 | ✅ 主战场 |
| agent-reach / xhs-search | 公开内容采集 | ❌ 不进 adopt，不与 device skill 混评判 |
| 17930 agent-entry | 设备 lease/live | ❌ 执行前置，不是收编证据 |

---

## 7. 审核怎么做

读 Windows 验收短报（`tmp-know/ACCEPTANCE-*.md`），核实——

- **落盘**：adopt 拉回的文件是否齐（ops 脚本 + skill + 地图回写）。
- **一致**：多份短报之间有无矛盾。例：04 状态「未登录」vs「青少年模式」vs「更新弹窗遮挡」三说打架 → 标「待 Windows 下次按元信息表写清真实登录态」，Mac 不替它定。
- **留痕**：真机证据是否进 skill `verified` note；是否有误报计入全绿。例：SKILL-SERIAL 自标 04 search「FOCUS 非搜索页、title 空」却计 PASS。
- **地图自相矛盾**：op 表写「发消息未做」但 R2 笔记已白名单发通 → 标过时（§6 stale 规则），让 Windows 改或 Mac 在审核记写「待改」。地图落后于真机进度时以真机为准。
- **knowledge 编码**：POST 中文标题乱码 → 审核看 registry 条目是否 UTF-8 可读（`ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/api/knowledge'` 抽查）。
- **边界**：Mac 不替 Windows 补探索内容，只标「待 Windows 澄清」。

---

## 8. 顺势优化

审核倒推约定缺口 → 补进 [`explorer.md`](explorer.md) §9 表 / `shared/pitfalls.md`，**不替 Windows 补探索内容**。

例：本轮审核发现「地图元信息只记探索主机」「真动作 dump-fail 无标注」→ 已补 §9 两行（地图元信息 + 真动作校验）。

---

## 9. 入口清单（先读）

| 文件 | 看什么 |
|------|--------|
| [`../AGENTS.md`](../AGENTS.md) | 碰机侧规矩，知道对面在干嘛 |
| [`explorer.md`](explorer.md) §9 | 治理标尺（固化轻量约定 + Windows 写契约） |
| [`../ops/SYNC-NOTE.md`](../ops/SYNC-NOTE.md) | 「Mac 收编先行落地文件」 |
| [`../scripts/adopt-from-windows.mjs`](../scripts/adopt-from-windows.mjs) 头注释 | 收编脚本用法 |
| [`../skills/<app>/SKILL.md`](../skills/) | 能力地图 + 元信息表（如 [`../skills/douyin/SKILL.md`](../skills/douyin/SKILL.md)、[`../skills/wechat/SKILL.md`](../skills/wechat/SKILL.md)） |

---

## 10. 留痕

- 审核发现 + 顺势补的约定 → `explorer.md` §9 / pitfalls（走 git）。
- 治理动作 + 评判结论 → git commit message。
- **不写 `PROGRESS.md`**（PROGRESS = 系统状态，watchdog 验；收编不是系统状态变更）。例外：收编若改了系统状态（新流程 / 废弃旧物）才动 PROGRESS。

---

## 11. 与 explorer 的边界

| | Explorer（Windows） | Governance（Mac） |
|---|---|---|
| 探索 / 碰机 | ✅ 产 recipe / 地图 | ❌ |
| 收编 / 固化 | ❌ | ✅ |
| 审核 | ❌（执行者不自评） | ✅ |
| 改约定 | ❌ | ✅（顺势） |
| 评判结论给人加路由 | ❌ | ✅ 出结论，不碰根 SKILL.md |
| 改权限层 | ❌ | ❌（仅人） |

---

## 12. 派工模板（复制即用）

```text
mode: governance
actor: <you>-governance-YYYYMMDD
app: <douyin|wechat|xianyu|…>
scope: locate+judge+adopt <一句话>
files: [显式相对路径…]          # adopt 候选，§0 发现信号列出
alias: —                        # 治理侧不碰设备
budget: { max_minutes: 30 }

步骤:
  1) §0 发现信号：读 .SYNCED-FROM / 扫 tmp-know / 对照 Win vs Mac，列 adopt 候选路径
  2) §4 定位 + §5 证据地图 + §6 评判：按权威度判收编/升级/标 stale/标缺地图
  3) node scripts/adopt-from-windows.mjs <显式相对路径…>（不扫库、不自动 diff）
  4) §3 校验轻量约定 + tmp-know 策略（png 不进 git）
  5) §7 审核：落盘 / 一致 / 留痕 / 编码 / 地图矛盾
  6) §8 顺势补约定 → explorer.md §9 / pitfalls
  7) 根路由缺该 app → 评判结论记「待人加路由行」（Mac 不碰根 SKILL.md）
  8) git commit + push origin main；记「已 push，待 Windows sync」

禁止: 碰设备、SSH 推部署、替 Windows 补探索内容/改 op 表/建地图、自动扫库、把 tmp-know 整包 png 进 git、碰根 skills/SKILL.md。
```