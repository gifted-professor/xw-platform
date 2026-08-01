# Windows 部署同步说明

本机 `C:\Users\Public\xhs-registry` 是 **Windows 部署目录**：`skills/` + `ops/` 从 GitHub `gifted-professor/xhs-registry` 同步；`registry.mjs` / DB / 计划任务等为本机运行时，勿被 sync 覆盖。

## 正式方案

1. Mac（或任意完整 git 工作区）改 `skills/` / `ops/` → commit → push
2. 在本机更新部署副本，例如：

```powershell
cd C:\Users\Public\xhs-registry
# 若本目录是完整 clone：
git pull

# 若只是部署快照（无完整 .git），用 gh 拉树：
# gh api repos/gifted-professor/xhs-registry/contents/ops --jq ...
# 或从 Mac rsync/scp 只同步 skills/ 与 ops/
```

3. 刷新 [`skills/.SYNCED-FROM.md`](../skills/.SYNCED-FROM.md)：写入 `commit` + `synced_at`

## 本地跑 ops

```powershell
cd C:\Users\Public\xhs-registry
$env:XHS_LOCAL = "1"
node ops/explore-preflight.mjs --alias 01
```

`win32` 下也可省略 `XHS_LOCAL`（`_explore-lib` 自动本地）。不要用 `Host xhs-windows → 127.0.0.1` 当正式方案。

## Skills 只读（Windows 侧）

- `skills/` 在部署目录是**只读同步副本**：源在 Mac 仓库，改动一律回 Mac commit → push → 再同步到本机。
- 在本机直接改 `skills/` 会被下次同步覆盖。权限分层见 [`skills/CONTRIBUTING.md`](../skills/CONTRIBUTING.md)（坑点放开 / 契约带 verified / 权限仅人改）。

## Mac 复核触发证据

提案（`ops/proposal-*.md`）的触发证据都可用下面命令在 Mac 上原样重跑复核（只读，不 POST）：

```bash
ssh xhs-windows 'node C:\Users\Public\xhs-registry\ops\_trace-pitfall.mjs --evidence "<query>" --json'
```

TRACE_DIR 是绝对路径，无需 cd。证据块格式与字段见 [`ops/proposal-TEMPLATE.md`](proposal-TEMPLATE.md)。

## Mac 收编先行落地文件

Windows agent 验收时常直接在部署副本写新 `ops/`/`skills/` 文件（先行落地）。源在 Mac，**不收编会被下次单向 sync 冲掉**。Mac 一条命令 base64 拉回（只读 Windows、只写 Mac 仓库，不向 Windows 推部署）：

```bash
node scripts/adopt-from-windows.mjs ops/douyin-like.mjs skills/douyin/douyin-like/SKILL.md
```

显式列文件，**不自动 diff**（agent 责任，避免把落后副本当新增拉回覆盖）。固化轻量约定（verified 一行 note / op 表不回写 version / 输出示例标示例 / dry-run 即 v1.0）见 [`modes/explorer.md`](../modes/explorer.md) §9「固化轻量约定」。治理侧（收编 / 审核 / 顺势补约定）入口见 [`modes/governance.md`](../modes/governance.md)；两侧分流见 [`AGENTS.md`](../AGENTS.md)「你属于哪一侧」。

## 非目标

- 不在本目录维护第二套 `ops-win/`
- sync 不覆盖 registry DB / control.db / 设备 serve 状态
