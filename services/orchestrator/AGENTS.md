# xhs-registry — 冷启动协议（任何 agent 进本目录必读）

> 你是接手 xhs 多设备自动化系统的新 agent。你没有历史上下文，**不要靠猜**，
> 按下面顺序读文件，30 分钟内你就能获得完整上下文。

## 你属于哪一侧（先分流，再读对应规矩）

进本目录的 agent 分两侧：
- **Windows 碰机侧**（执行/探索/运维）：按本文「Agent 入口」「默认业务链路」干；碰机/job/lease 红线对你适用。
- **Mac 治理侧**（收编/审核/顺势优化/不碰设备）：读 [`modes/governance.md`](modes/governance.md)；本文的碰机/job/lease 规矩对你**不适用**。

## Agent 入口（硬规矩，先于一切碰机）

1. **正道 = 控制面**：只允许 `job submit` / `session acquire` 碰手机；lease 必须在 `GET /control/v1/leases` 或面板可见。
2. **禁止旁路**：无 lease 的 `GatewayOperator` / 临时 `_*.mjs` 四机干跑 = 入口违规（即使业务成功也算任务不合格）。
3. **文档是软约束**：知识库/长文 agent 默认不会自觉读完——验收与硬闸才约束行为。
4. **开工先读 live 入口**（比旧 HANDOFF 优先）：  
   `ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/agent-entry.md'`  
   只信其中的 **ready / lease / active blockers / Approved command skeletons**；PROGRESS 与知识库作补充。
5. **2026-07-26 完整交接**（流程/卡点/已修/入口设计）：本目录 **`HANDOFF-2026-07-26-agent-entry-xianyu-verify.md`** —— 接手闲鱼验证或入口改造必读（历史背景；设备现状以 agent-entry 为准）。
6. 进场三问（答不出不准动手）：① job 还是 session？② leases 看不看得见我？③ capability id 是什么？

## 默认业务链路（2026-07-27 起）

1. **代码真源**：GitHub `gifted-professor/xhs-device-agent` 的 **`main`**（Windows `C:\Users\Public\xhs-routing-v1-1` 必须在 `main` 且 `task-launch.json` gitCommit = 完整 40 字符 HEAD）。
2. **碰机命令骨架**（Mac 上跑，cwd = GPFS 路由仓 checkout）：  
   `node control-plane/devicectl.mjs --ssh xhs-windows job submit --capability <id> --actor <actor> --idempotency-key <key> [--device <devId>] --params '<json>'`  
   状态：`job status --job <id>`；路由预览：`route plan ...`。
3. **只对 `ready=yes` 且 `lease=free` 的设备提交**；非 ready 先恢复（`job recover` / `ops/recover-main-safe.mjs`），禁止旁路清隔离。
4. **跨机并发（机制已 4/4 实证；2026-07-28 起临时只走 01/02）**：**默认** `node ops/conc2-full-dry-run.mjs --actor <you>-conc2`（内置 live 预检 + 两路 submit + poll，脚本拒绝扩大 aliases）。
   - 效卫 22222 当前仍是**单实例/单连接共享传输**；控制面允许 01/02 job 重叠，但网关请求由全局锁串行化，不宣称多实例。
   - fixture：`campaign/fixtures/{01,02}-full.json`；历史 4/4 证据知识库 `xianyu-4machine-concurrency-4of4-20260727`。
   - **禁止**同机并行两个重业务 job；**禁止**无 lease 干跑；03/04 暂不进入默认并发。手拼 devicectl 仅调试用。
5. **恢复**：job 末 restoration 已有 discard-dry-run relaunch 兜底（main 含 `953d187`）；quarantine 清隔离仍走 recover + 视觉 main-safe 硬闸（见 `ops/recover-main-safe.mjs`）。

## 环境双路径（三行契约）

1. **Mac**（本仓 `xhs-registry` + GPFS 上 `devicectl.mjs`）= 脚本客户端、fixture、留痕；**不要** curl Mac `localhost:17930`。
2. **Windows**（`C:\Users\Public\xhs-routing-v1-1` @ **`main`** + 17920/17930）= 唯一业务执行码与 registry/控制面。
3. job 对错只看 Windows HEAD / task-launch 全 hash；Mac checkout 脏不代表未部署。

## 工作模式（派工时指定一个）

| 模式 | 何时 | 入口 |
|------|------|------|
| **Explorer** | 未知面/探路/写 recipe | **`modes/explorer.md`** → `ops/explore-preflight.mjs` → `ops/screenshot-and-analyze.mjs` |
| **Runner** | 已知剧本回归 | `ops/conc2-full-dry-run.mjs` 等 |
| **Fix** | 改代码/部署 | Grok/GLM；正道 devicectl + git main |
| **Governance** | Mac 治理/收编/审核/顺势补约定 | **`modes/governance.md`** |

自动派 cheap agent 探 App：**只派 Explorer**，把 `modes/explorer.md` 文末派工模板填好即可。

## 复用流程表（默认油门；手拼仍允许）

| 要做的事 | 默认命令（cwd = 本仓 xhs-registry，除非注明） |
|----------|-----------------------------------------------|
| 看 live | `ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/agent-entry.md'` |
| **探索开工检查** | `node ops/explore-preflight.mjs --alias 01` |
| **探索截屏（一步）** | `node ops/screenshot-and-analyze.mjs --alias 01` → `SHOT=…` |
| **探索 dump/点/输入/焦点/开 App** | `ops/dump-ui.mjs` / `tap.mjs` / `input-text.mjs` / `focus.mjs` / `launch-app.mjs`（lab 22222，见 `modes/explorer.md`） |
| **01/02 full_dry_run 并发（临时默认）** | `node ops/conc2-full-dry-run.mjs --actor <you>-conc2` |
| 同上只预检 | `node ops/conc2-full-dry-run.mjs --actor <you>-conc2 --dry-run` |
| 隔离后 main-safe 清 | `node ops/recover-main-safe.mjs --job <jobId> --actor <you>` |
| 单机 campaign 步 | `campaign/step.sh`（单机）；并发**优先** conc2 脚本（固定 01/02） |
| 手拼调试 | `node <gpfs>/control-plane/devicectl.mjs --ssh xhs-windows job submit …` |

同一流程成功 ≥2 次 → 应收成 `ops/` 脚本；之后默认跑脚本，不靠拼 5 份文档。

## 第一步：建立全局认知（必读，按序）

1. 本文「Agent 入口」+ 上节「默认业务链路」+ live `agent-entry.md`（Mac 治理侧另读 [`modes/governance.md`](modes/governance.md)）
2. `PROGRESS.md`（本目录）——系统总状态：架构、Phase 1-3、scout、路由规则、watchdog、已知问题
3. 知识库路由表：`ssh xhs-windows 'cmd /c "curl.exe -s http://127.0.0.1:17930/api/knowledge"'` 里 id=`routing-table-v2` 的条目（v1 已废止）——任务该派给谁、升级纪律
4. 按需深入（PROGRESS.md 里有全部指针）：
   - 正道命令：路由仓 `docs/agent-entry.md`（GPFS checkout 或 Windows `xhs-routing-v1-1`）
   - scout 设计：`/Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-windows/docs/plans/2026-07-24-phase4-探索agent设计.md`
   - 项目流水账：`/Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-windows/02-项目进度.md`
   - 仓库与部署：路由仓 `AGENTS.md`（**main 分支**）

## 第二步：汇报再动手

先向人汇报三件事：① 你理解的系统状态（含 agent-entry 四机 ready/lease）② 进行中/悬挂的任务 ③ 你认为的下一步。
**人确认之前不要改任何东西。**

## 干活规矩（摘要，细则见 PROGRESS.md 路由规则）

- 任务分派查知识库 `routing-table-v2`：验证→MiMo、修复→GLM/Grok、设计/验收/部署运维→Kimi、R2 审批→人
- 代码改动走 git 流程（仓库 AGENTS.md「部署流程」节，含 task-launch.json commit 闸门 3b）
- 验收独立：执行者不自评，diff 由 Kimi 或 watchdog 验收
- **留痕契约（默认动作，不是可选项）**：任何 agent 完成任务后必须——
  1. 踩到的坑/验证过的配方 → 写知识库（带 appliesTo/verifyMode）
  2. 改变了系统状态（新服务/新端口/新流程/废弃旧物）→ 更新 PROGRESS.md 对应节
  3. 遇到文档没写的「人脑独有」问题 → 不要自己编答案，写成待问项列在报告里
  验收时检查留痕：**活干了但没留痕 = 任务未完成**（watchdog 验收报告含留痕检查项）
- 设备红线：不批量杀进程、不碰 control.db 写入、R2+ 只提交不批准、遇验证码/风控立即停止

## 关键端点

| 什么 | 在哪 |
|---|---|
| registry（身份/审批/知识库/面板/舰队/截图/Operator） | Windows `127.0.0.1:17930`（手机经 tailscale `127.0.0.1:17930/?token=...`，token 在 Windows 任务 argLine） |
| 控制面 | Windows `127.0.0.1:17920` |
| 设备 serve | 01→17895 / 02→17897 / 03→17898 / 04→17896（loopback） |
| MiMo 委派 | `mimo-ro run --dir <项目> "任务"`（key 池自动轮换） |
| Windows 访问 | `ssh xhs-windows`（PowerShell；curl 用 curl.exe；复杂命令用 EncodedCommand） |

## abtop 远程通道（2026-07-29 起，只读/受控）

abtop 后端（浏览器控制台）**不直连** 17920/22222/ADB/control.db；统一经 registry 17930 的 Tailscale 入口，用独立 token：

- `--observer-token`（只读）：`GET /api/fleet`（脱敏舰队：online/ready/隔离/占用/当前任务/reported actor/数据新鲜度）、`GET /api/fleet/screen/:alias[/meta]`（cache-only 已采集截图，刷新**不触发**设备 Screen/job/lease）。写知识库/审批 → 403。
- `--operator-token`（受控提交）：`POST /api/operator/submit`（白名单 capability → 正式 job 提交控制面，actor 强制 `abtop:` 前缀）、`GET /api/operator/job/:id`（代理状态）、`POST /api/operator/session`（预留 501）。R0/R1 只读与 dry-run 白名单内真代提交；R2 外发仍走现有人工审批。
- 部署：token 与 `--runs-root`（截图根目录，默认 `C:\Users\Public\xhs-agent-runs`）由 `install-registry-task.ps1 -ObserverToken … -OperatorToken … -RunsRoot …` 传入。
