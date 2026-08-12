# 第三方自建交付包（有机 + 有效卫）

> 场景：对方在**自己的电脑**上跑，用**自己的手机 + 效卫**，不连我们的 Windows / 01–04。  
> 交付形态（目标）：直接给 **两个 GitHub 地址**，对方 clone 后按 README 填 `.env` 即可自建。  
> 仓库：
> - https://github.com/gifted-professor/xhs-registry  
> - https://github.com/gifted-professor/xhs-device-agent  
> 前提：对方已具备 Windows 执行机、效卫（含约定 ADB 口）、至少一台已登录目标 App 的安卓机。  
> 目标：clone 两仓 → 复制 `.env.example` / identities example → 安装 → `/xw start --check` → 首单只读 R0。

**不是**「clone 完立刻零配置出活」：对方必须自备硬件，并生成自己的 token / serial。  
**禁止**把生产 `.env`、真实 `identities.seed.json`、`control.db` 推进 GitHub。

---

## 三样是什么

| # | 交付物 | 内容 | 对方拿到后做什么 |
|---|---|---|---|
| **1** | **双仓源码** | A：`xhs-registry`（入口/ops/registry）<br>B：`xhs-device-agent`（控制面/adapter，GitHub `gifted-professor/xhs-device-agent` 的 `main`） | Windows 上按约定目录 checkout；B 的 `HEAD` 与 `task-launch.json` 的 `gitCommit`（完整 40 字符）对齐 |
| **2** | **空配置模板包** | `.env.example` + washed identities/devices（无生产秘密） | 复制为 `.env` / `identities.seed.json`，只填自己的值 |
| **3** | **安装与验收清单**（本文后半 + 脚本指针） | 目录、计划任务、端口、release 闸门、第一道绿灯命令 | 按序安装 → `/xw start --check` 全绿 → 再碰业务 |

对方硬件（手机 + 效卫）算第 0 样，**不由我们交付**。

---

## 样 1 — 双仓（建议固定目录）

在对方 Windows 上：

```text
C:\Users\Public\xhs-registry\          ← A 仓（本仓）
C:\Users\Public\xhs-routing-v1-1\      ← B 仓 clone（跟踪 origin/main）
C:\Users\Public\xhs-agent-control\     ← 控制面运行数据（task-launch、control.db 等；按 B 仓安装脚本生成）
```

- A 仓若尚无对外 remote：交接前先推到对方能拉的私有地址，或打一份干净 zip（去掉 `outbox/`、`registry.db`、含密钥的本地改动）。
- B 仓：只给 `main`；不要给你们的脏 worktree / 未合分支当「生产真源」。
- 版本契约：`routing main == origin/main == task-launch.gitCommit == release receipt`（与现网同一套闸门）。

---

## 样 2 — 空配置模板包（建议打成一个文件夹）

交接时单独给一个 `third-party-config-templates/`（或压缩包），**不要**直接拷贝生产文件。最少包含：

| 文件 | 来源建议 | 对方必改 |
|---|---|---|
| A 仓 `.env.example` → 复制为 `.env`（**gitignore，永不提交**） | 已入库 | `XHS_AGENT_TOKEN` / `XHS_HUMAN_TOKEN` / 可选 observer·operator；飞书相关键若不用可留空 |
| A 仓 `identities.seed.example.json` → `identities.seed.json` | 已入库 | `alias`↔`serial`、label、accounts（**不要**拷我们的生产 seed） |
| B 仓 `config/control-plane.devices.example.json` → 本地 `devices.json` | B 仓已有 | `runtimeId` / serial、`nodeId`、capabilityIds、`xhsServePort` |
| B 仓 `.env.example` | B 仓已有 | 视觉/控制面等对方自用键 |
| `task-launch` 字段说明 | 剥密结构说明即可 | `gitCommit`=对方 B HEAD 全 hash；`pilotActors`=对方 actor |

**模板红线**：外发 zip/仓里不得出现我们现网的 `.env`、`identities.seed.json`（真机）、token、飞书 base、serial/昵称。安装脚本从 `.env` 读密钥，源码内零硬编码。

---

## 样 3 — 安装与验收清单（对方照做）

### 3.1 前置（对方自备）

- Windows + Node（现网验证过 22.5+ / 24）
- 效卫已装，设备在**约定执行口**可见（现网执行健康认 **5038**；5037 仅诊断，勿把两口设备并集当健康）
- 目标 App 已登录；USB/效卫枚举稳定

### 3.2 安装顺序（指针，细节以各仓脚本为准）

1. Checkout A/B 到上述目录；B：`git checkout main && git pull`，记下 `git rev-parse HEAD`（40 字符）。
2. 按 B 仓 `AGENTS.md`「部署流程」与 `scripts/control-plane-task.ps1` 等安装 **控制面** `XhsDeviceControlPlaneV1`（17920）。
3. 写入本地 `control-plane.devices.json`（来自模板），填对方 serial/runtimeId；改后重启控制面。
4. 安装各机 FastOperator serve（B 仓 `scripts/fast-operator-serve-task.ps1`）；端口与 devices 里 `xhsServePort` 一致。
5. A 仓：`install-registry-task.ps1`，传入**对方自己的** `-AgentToken` / `-HumanToken`（及可选 observer/operator）；任务名 `XhsDeviceRegistry`，端口 **17930**。
6. 对齐 `C:\Users\Public\xhs-agent-control\task-launch.json` 的 `gitCommit` = 当前 B HEAD；需要时写 cross-repo release 清单（若对方启用同一套 release 闸门）。
7. 设 `XHS_ACTOR=<对方 pilot actor>`（须在控制面 pilot 白名单内，否则会 `AUTONOMY_PILOT_SCOPE_MISS`）。

### 3.3 第一道绿灯（不碰业务外发）

在对方机器上：

```powershell
cd C:\Users\Public\xhs-registry
node ops\xw-start.mjs --check --json
curl.exe -s http://127.0.0.1:17930/agent-entry.md
curl.exe -s http://127.0.0.1:17920/control/v1/health
```

期望（对方自己的机，不是我们的 01–04）：

- registry / 控制面健康可读
- 目标 alias：效卫枚举到、serve 按需 listening、lease=0、无错误占用
- ADB 执行口干净（无「设备只在错误端口」）

再：

```powershell
node ops\xw-start.mjs --actor <对方actor> --json
```

健康机应能走到 readiness；然后用 `/xw skills` / 只读 R0（如 `xiaowei.device.list`）验证 **lease 可见**。  
支付、真实外发、删除：**永远**单独等人确认；模板默认不授权这些。

### 3.4 日常入口（装好以后）

```text
/xw start [--check]
/xw skills
/xw run <已固化能力>
/xw explore <未知面>
```

只走 job / session / Explorer lease；禁止无 lease 旁路碰机、禁止手写 `control.db`。

---

## 「可以直接用」的诚实边界

| 说得通 | 说不通 |
|---|---|
| 三样 + 对方有机有效卫 → 按清单装完即可自用 | clone 两仓、不填 devices/token 就能控我们的机 |
| 对方舰队与我们物理隔离 | 共用我们的 token / serial / 飞书同步 |
| 第一道验收以对方本机 `xw-start --check` 为准 | 把我们的 `outbox/`、生产 DB 当教材打包 |

---

## 交接前我们还欠的一次性工作

发三样之前，内部先做完（否则对方会卡在「仓在哪 / 模板是哪份」）：

1. A 仓对外可读（remote 或干净打包）。
2. 洗好 `identities` / `tokens` / devices 模板（零生产秘密）。
3. 把本文与 B 仓 `AGENTS.md` 部署节、`install-registry-task.ps1`、`fast-operator-serve-task.ps1` 链成对方可读的「打开哪几个文件」。

做完这三步，对外话术就可以固定成：

> 给你们三样：双仓、空配置模板、安装验收清单。你们自己有手机和效卫的话，按清单填自己的 serial 和 token，装完跑 `/xw start --check` 绿灯就能用。连不上、也不该连上我们这边的机器。
