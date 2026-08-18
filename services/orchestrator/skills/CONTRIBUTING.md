# Skills 贡献规则（CONTRIBUTING）

> 一句话：**坑点随便记，契约要验证，权限只有人改。**
> 本文定义「谁可以改 skills、改到什么程度」，是路由表之外的协作契约。
> 所有 agent（Hermes / Claude / Cursor / Codex / 任意新来的）读 `skills/SKILL.md` 时都应连带认此文。

## 三层权限一览

| 层 | 改什么 | 谁能改 | 门槛 |
|----|--------|--------|------|
| **坑点层** | `shared/pitfalls.md`、知识库 recipe、`shared/parse.md` 的补充说明 | 任何 agent | 无——踩坑即记，写完留痕 |
| **契约层** | 单个 skill 的 `SKILL.md`（`device/`、`xhs/`、`xianyu/` 下） | 任何 agent | 必须带 `verified` 字段 + 验证证据；升 `v1.0` 需真机跑过 |
| **权限层** | 根 `SKILL.md` 的授权模型 / 红线 / 路由表自由度列、`CONTRIBUTING.md` 自身 | **仅人** | commit 留痕 + 人确认 |

**下位规则不得覆盖上位规则**：skill 里写了「完全自主」也不能越过根 SKILL.md 的红线。

---

## 坑点层（放开）

- 踩坑就记，不等审批。格式照 `shared/pitfalls.md` 现有条目（`### pitfall-<slug>-<date>`：问题 / 场景 / 规则）。
- 写错最坏是噪音，下个踩坑的 agent 会修正——不必怕写错。
- 示例：新增一条 VLM 偏移 pitfall，直接 append，不需要 `verified`。

## 契约层（软门槛）

改 `skills/<层>/<skill>/SKILL.md` 时，四条要求：

1. **带 `verified` 字段**：每个 skill frontmatter 应有 `verified: false | true`（沿用版本号规则）。
   - `v0.x` + `verified: false` → 实验性，其他 agent 读到当试水
   - `v1.0` + `verified: true` → 已真机验证，可信
2. **升 `v1.0` 必须真机跑过**：改完在至少一台设备（如 01）跑通并留证据（哪台、什么结果），否则停留在 `v0.x`。
3. **说明改了什么**：在 skill 底部或 commit message 写清「原来什么样 → 现在什么样 → 为什么」。
4. **契约与实现同步**：改了 `SKILL.md` 必须同步改对应 `ops/` 脚本的用法（如新增 `--local` 示例）；改了脚本行为必须更新 `SKILL.md` 的 `verified` 状态。

示例（升版）：

```markdown
---
name: xhs-like
verified: true        # 2026-07-31 01 真机 dry-run 通过
---
```

## 权限层（仅人）

**以下改动 agent 一律不得直接做**，只能写成「提案」交人：

- 根 `SKILL.md` 的**授权模型**（自主/需审批/红线 的划分）
- **红线表**（支付/删号/验证码 等禁止项）
- 路由表的**自由度列**（把某操作从「自主」改「需审批」或反之）
- `CONTRIBUTING.md` 本文自身

原因：这些定义「什么能自主做」，是整套体系的权限底座。被 agent 自改 = 自授权，等于绕过审批。若探索中确实发现需要调整（如某操作该降级审批），照「留痕契约」写成待问项 / 提案，人决定。

## Windows 侧只读

- **`skills/` + `ops/` 的源在 Mac 仓库**（`gifted-professor/xhs-registry`），`C:\Users\Public\xhs-registry` 是部署副本。
- Windows 上（Cursor 等）**不直接改 skills**——改在 Mac 源 commit → push → 同步，再刷新 `skills/.SYNCED-FROM.md`。
- 本地改的 skills 下次同步会被覆盖，等于白改。见 `ops/SYNC-NOTE.md`。

## 快速自查

改 skills 前问自己：

- 我改的是坑点？→ 直接写。
- 我改的是某个 skill 的契约？→ 带 `verified` + 证据，升 v1.0 要真机。
- 我改的是红线 / 授权 / 自由度？→ 停，写成提案交人。
- 我在 Windows 上？→ 停，改 Mac 源。
