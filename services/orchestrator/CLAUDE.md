# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 先读这两个文件（本目录已有，CLAUDE.md 不重复其内容）

- `AGENTS.md` — 冷启动协议：接手顺序、设备红线、留痕契约、关键端点。
- `PROGRESS.md` — 系统总状态、Phase 1-3、scout、路由规则、watchdog、已知问题。
任何任务开工前先读这两份，本文件只补它们没写的「怎么跑代码」和「代码结构」。

## 仓库性质

- **本目录自 2026-07-27 起是独立 git 仓库**（main 分支，本地无 origin）。运行产物走 `.gitignore`（日志/截图/.bak/runtime/）。
  routing/scout/控制面代码在另一个 GPFS 仓库：`/Volumes/GPFS/.../xhs-device-agent-routing-v1-1`。
  `registry.mjs` 仍通过对照 SHA256 部署到 Windows（不走 git pull），commit message 里记部署 SHA 锚点。
- **零第三方依赖**：只用 `node:http` + `node:sqlite`（Node 22.5+，Windows 上 Node 24 已验证）。
  `package.json` 只有 `npm test` / `npm run check` 两个脚本，无 node_modules。
- **部署在 Windows**：`C:\Users\Public\xhs-registry\`，计划任务 `XhsDeviceRegistry`（AtStartup 触发），端口 17930。
  本目录是「源」，Windows 是「运行实例」。

## 常用命令

### 本地（Mac）跑 registry（调试用）
```bash
node registry.mjs --port 17930 --host 127.0.0.1 --control http://127.0.0.1:17920
# 可选参数：--db ./registry.db --seed ./identities.seed.json --token <str>
```

### 飞书双向同步桥（跑在 Mac）
```bash
node sync-feishu.mjs --once        # 单次
node sync-feishu.mjs --interval 60 # 循环（默认 60s，生产由 launchd 托管）
```

### 批量导入知识库 seed 到 Windows registry
```bash
node import-knowledge.mjs knowledge-seed-core.json knowledge-seed-from-records.json [--update]
# 默认遇 409 跳过；--update 先删同 id 再插
```

### 查 Windows 上 registry API（不经本机，走 SSH）
```bash
# 健康
ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/api/health'
# 全部知识库
ssh xhs-windows 'cmd /c "curl.exe -s http://127.0.0.1:17930/api/knowledge"'
# 待审批
ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/api/approvals/pending'
```

### 查控制面路由配置（只读 dump control.db）
```bash
# Windows 上运行 query-routing.mjs（路径见 PROGRESS.md「工具」节）
ssh xhs-windows 'cd C:\Users\Public\xhs-registry && node query-routing.mjs'
```

### watchdog
```bash
# 手动跑一轮（检测变化→有变化才唤醒 kimi）
bash watchdog/watchdog.sh
# 看 state
cat watchdog/state.json
# 最近报告：watchdog/reports/ 下按 UTC 时间戳命名，新版在前
```

### 重启/重装 Windows 上的 registry
- 改了 `registry.mjs` 后：对照 SHA256 把文件传到 Windows `C:\Users\Public\xhs-registry\registry.mjs`，再
  `schtasks /end /tn XhsDeviceRegistry & schtasks /run /tn XhsDeviceRegistry`（或重跑 `install-registry-task.ps1`）。
- 重装计划任务本身：`install-registry-task.ps1`（含 token、0.0.0.0 绑定、重启策略）。

## 测试

`npm test`（node --test，tests/registry.test.mjs，13 个集成测试：起真实 registry 子进程 + 临时 sqlite + 假控制面）；`npm run check` 对三个 .mjs 跑 `node --check`。改 registry 行为必须先过这两个，再手动验关键端点：`/api/health`、`/api/agent-entry`、`/agent-entry.md`、`/api/approvals/pending`、面板 `/`。业务链验收仍靠 E2E 实跑，验收独立（执行者不自评）。

## 鉴权模型（2026-07-27 起）

- `--agent-token`：读一切 + 写知识库/身份，**不能审批**（回落旧 `--token`）。
- `--human-token`：唯一能 `approve/deny` 的凭证；actor 由凭证推导（`human:<--human-actor>`），body 自报无效；API approve 还需 `{"confirm":"APPROVE"}`。
- loopback 免凭证 = 只读 + 知识库/身份写，永远不含审批。
- **不传 `--human-token` = LEGACY 模式**，行为与旧单 token 版完全一致（迁移期兼容，长期必须带 human token 跑）。
- 审批留痕：registry.db `approval_audit` 表，`GET /api/approvals/audit?limit=` 可查。

## 架构（registry.mjs 内部分解）

单文件 ~820 行，一个 `http.createServer`，路由全是手写 `if (method && pathname)` 链（无框架）。四块职责：

1. **身份缓存**（`identities` 表）——真相在飞书多维表格，本服务只缓存。`sync-feishu.mjs` 每 60s `PUT /api/identities` 推入。`identities.seed.json` 是冷启动种子，serial 是身份锚点（物理不变），alias 是可变槽位（02/03 已对调过）。
2. **控制面聚合**（`aggregate()`）——只读控制面 `/control/v1/health|devices|leases`，并行 `Promise.all` + `Promise.allSettled`，控制面不可达时降级为只显示身份缓存，**绝不 500**。
3. **知识库**（`knowledge` 表 + 迁移）——`pitfall|recipe|unknown` 三类，带 `appliesTo/steps/verifyMode/needsEngineer`。`addKnowledge` 增、`PATCH /api/knowledge/:id` 改三字段、`POST .../verify` 与 `.../flag-engineer` 转状态。**无 DELETE**（已知 backlog）。表有幂等迁移块（`ALTER TABLE ADD COLUMN` 加三列），改 schema 在那里加。
4. **审批代理**（Phase 3）——pending/recent 列表**只读查询控制面 `control.db`**（WAL 模式只读安全，registry 绝不写 control.db，经 `queryControlDb` 出错关句柄 30s 重试不永久降级）；approve/deny 代理 POST 到控制面 `/control/v1/approvals/:jobId`，由控制面落库。

### 关键约束（改代码时守住）

- **禁 `console.error`**：一律 `console.log`。Windows bridge exec 约束——远端把 stderr 当错误信号，会误判进程挂了。注释在文件头明确写了。
- **`esc()` HTML 转义**：面板 HTML 与 `/watchdog` 页都靠它防 XSS；改任何往 HTML 里插值的渲染处都要走 `esc()`。注意 PROGRESS.md backlog 提到 esc() 在前后端有两处重复实现。
- **EADDRINUSE 进程内重试**：`server.on("error")` 里遇端口占用 2s 后重听，不直接退出（防止计划任务重启撞端口耗尽 RestartCount=3）。
- **`uncaughtException`/`unhandledRejection` 兜底**：进程级，别在 handler 里抛。
- **`CONTROL_DB_PATH` 默认指 Windows 路径** `C:\Users\Public\xhs-agent-control\control.db`，Mac 本地跑会查不到——本地调试身份/知识库功能不受影响，审批/聚合会降级。

### 端点速查

| 方法 路径 | 作用 |
|---|---|
| GET `/` | 人机面板（SSR HTML，零 JS） |
| GET `/api/agent-entry` | Agent 统一入口 JSON（`xhs.agent-entry.v2`：state 分层/jobStatus/blockers/protocol） |
| GET `/agent-entry.md` | 同上 Markdown 版（curl 直读） |
| GET `/watchdog` | watchdog 报告查看页 |
| GET `/api/health` | 健康 |
| GET `/api/devices` | 聚合视图（身份×控制面状态×lease） |
| PUT `/api/identities` | 飞书同步推入（body `{identities:[...]}`） |
| GET `/api/knowledge` | 列表（?app&category&q&limit 过滤） |
| POST `/api/knowledge` | 新增（409 = id 已存在） |
| PATCH `/api/knowledge/:id` | 改 appliesTo/steps/verifyMode |
| POST `/api/knowledge/:id/verify` | 标记已验证（body.by） |
| POST `/api/knowledge/:id/flag-engineer` | 标记 needsEngineer（触发 watchdog） |
| GET `/api/approvals/pending` | 待审批（读 control.db） |
| GET `/api/approvals/recent?limit=` | 最近审批 |
| GET `/api/approvals/audit?limit=` | registry 侧审批审计记录 |
| POST `/api/approvals/:jobId/approve\|deny` | 代理到控制面（**仅 human token**；approve 需 body.confirm="APPROVE"；actor 凭证推导） |

## watchdog（无人值守验收，本目录自管）

- launchd `com.xhs.scout-watchdog`，每 1800s 跑 `watchdog/watchdog.sh`。
- 哨兵逻辑：检测两路变化——① GPFS git 仓库 origin 分支新 commit；② 知识库新 `needsEngineer` 条目（经 SSH 查 registry API）。**无变化零 LLM 成本静默退出**。
- 有变化且过 45min（`COOLDOWN_S=2700`）冷却 → 拼装 `SUPERVISOR.md` 模板（`{{CHANGES}}` 占位）→ `kimi --print -p` 无头验收，报告写 `watchdog/reports/<UTC时间戳>.md`。
- **v1 只验收不派工**：不调 mimo-ro、不 push、不重启服务、不碰手机。state 记 lastSha/flags/lastKimiRun。
- 路径硬编码 `REPO=/Volumes/GPFS/.../xhs-device-agent-routing-v1-1`、`BRANCH=agent/placement-entry-v1-1-20260724`，GPFS 未挂载时整轮跳过。

## sync-feishu.mjs 注意

- 明文 token 硬编码在文件头（`BASE_TOKEN`/`REGISTRY_TOKEN`）——PROGRESS.md backlog 已记为「本地单人私网有意取舍」，接手 agent 不当事故处理，公开仓库前再统一治理。
- 经 `ssh xhs-windows` 远程调 `curl.exe`；字段映射见 `F` 对象（中文飞书列名 ⇄ 英文 key）。无 SSH 重试退避（backlog）。

## 留痕契约（AGENTS.md 已定，重申要点）

完成任务后三选一必须做：① 踩坑/配方写知识库（带 `appliesTo`/`verifyMode`）；② 改系统状态（新服务/端口/流程/废弃）更新 `PROGRESS.md` 对应节；③ 文档没写的人脑问题写成待问项。**活干了没留痕 = 任务未完成**，watchdog 验收报告会查。