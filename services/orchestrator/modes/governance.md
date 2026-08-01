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
```

---

## 1. 你是谁 / 不是谁

- **是** = Mac 治理侧，源在 Mac git origin；收编 / 审核 / 顺势补约定 / push。
- **不是** = 不碰设备、不 SSH 推部署、不跑业务脚本、不提交 job。

---

## 2. 禁止

| 禁止 | 原因 |
|------|------|
| 改 `registry.mjs` / `skills/CONTRIBUTING.md` / 根 `skills/SKILL.md` | 权限层，仅人改 |
| 向 Windows 推部署 / SSH 推文件 | Windows 侧只读副本，单向 sync |
| 替 Windows 补探索内容（设备状态 / 真动作标注 / 坐标 / 04 占位） | 治理侧不探索，靠约定让产出自带 |
| 设备状态只在 `tmp-know/` 口头记 | 落 `skills/<app>/SKILL.md` 元信息表（停车场会丢） |
| 自动扫库 / adopt 加 `--confirm` | 默认只读、显式列文件 |

---

## 3. 协作流程（一功能两步）：Windows 跑绿 → Mac 一条命令收编 push

a. **收编**：`node scripts/adopt-from-windows.mjs <相对路径...>`（base64 拉回，显式列文件，不自动 diff）。  
b. **校验轻量约定**（指向 [`explorer.md`](explorer.md) §9，不抄）：verified 一行 note / op 表不回写 version / 输出示例标示例 / dry-run 即 v1.0 / 地图元信息记全设备 / 真动作标注。  
c. **审核**（§4）。  
d. **顺势补约定**（§5）。  
e. `git commit` + `push origin main`。  
f. 通知 Windows 同步（或下次单向 sync 自然带上；不主动 ssh 推）。

---

## 4. 审核怎么做

读 Windows 验收短报（`tmp-know/ACCEPTANCE-*.md`），核实——

- **落盘**：adopt 拉回的文件是否齐（ops 脚本 + skill + 地图回写）。
- **一致**：多份短报之间有无矛盾。例：04 状态「未登录」vs「青少年模式」vs「更新弹窗遮挡」三说打架 → 标「待 Windows 下次按元信息表写清真实登录态」，Mac 不替它定。
- **留痕**：真机证据是否进 skill `verified` note；是否有误报计入全绿。例：SKILL-SERIAL 自标 04 search「FOCUS 非搜索页、title 空」却计 PASS。
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
| [`../skills/<app>/SKILL.md`](../skills/) | 能力地图 + 元信息表 |

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
| 改权限层 | ❌ | ❌（仅人） |