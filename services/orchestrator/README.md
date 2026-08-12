# xhs-registry

多设备自动化的 **Windows 入口仓**：registry 面板（端口 `17930`）、`/xw` 命令面、身份/知识库。

控制面与手机执行码在兄弟仓：

**https://github.com/gifted-professor/xhs-device-agent**

> 别人自建舰队：clone **这两个**仓库 + 自备 Windows、安卓机、效卫即可。  
> **不要**指望 clone 后连上别人的手机；每套环境各自独立。

---

## 你需要自备什么

| 项 | 说明 |
|---|---|
| Windows 10/11 | 跑控制面 + registry + FastOperator |
| Node.js | 建议 22.5+ / 24（与控制面一致） |
| 效卫 | 含约定 ADB 口（本项目执行健康认 **5038**） |
| 安卓机 ≥1 | App 已登录；USB/效卫枚举稳定 |
| 密钥 | 自己生成 token，写进本地 `.env`（永不提交） |

---

## 10 分钟上手（PowerShell）

### 1. Clone 两仓（建议固定目录）

```powershell
git clone https://github.com/gifted-professor/xhs-registry.git C:\Users\Public\xhs-registry
git clone https://github.com/gifted-professor/xhs-device-agent.git C:\Users\Public\xhs-routing-v1-1

cd C:\Users\Public\xhs-routing-v1-1
git checkout main
git pull
```

### 2. 本地密钥与身份（只留在本机）

```powershell
cd C:\Users\Public\xhs-registry
copy .env.example .env
copy identities.seed.example.json identities.seed.json
notepad .env
notepad identities.seed.json
```

`.env` 至少填：

- `XHS_AGENT_TOKEN` / `XHS_HUMAN_TOKEN`（自生成长随机串）
- `XHS_ACTOR`（你的 pilot actor 名，稍后写入控制面白名单）

`identities.seed.json`：把 `REPLACE_SERIAL_0N` 换成你手机的 `adb devices` 序列号。

### 3. 控制面设备表（B 仓）

```powershell
cd C:\Users\Public\xhs-routing-v1-1
copy config\control-plane.devices.example.json config\control-plane.devices.json
notepad config\control-plane.devices.json
```

填：`runtimeId`（设备运行时 ID）、`alias`、`metadata.xhsServePort` 等。  
按 B 仓 [`AGENTS.md`](https://github.com/gifted-professor/xhs-device-agent/blob/main/AGENTS.md) / [`docs/control-plane.md`](https://github.com/gifted-professor/xhs-device-agent/blob/main/docs/control-plane.md) 安装：

- 控制面计划任务（默认 `127.0.0.1:17920`）
- 各机 FastOperator serve
- `task-launch.json` 的 `gitCommit` = 当前 `git rev-parse HEAD`（**完整 40 字符**）

### 4. 安装 registry

```powershell
cd C:\Users\Public\xhs-registry
powershell -ExecutionPolicy Bypass -File .\install-registry-task.ps1
```

脚本从 `.env` 读 token，注册计划任务 `XhsDeviceRegistry`（端口 `17930`）。

### 5. 第一道绿灯

```powershell
cd C:\Users\Public\xhs-registry
node ops\xw-start.mjs --check --json
curl.exe -s http://127.0.0.1:17930/agent-entry.md
curl.exe -s http://127.0.0.1:17920/control/v1/health
```

期望：registry / 控制面可读；你的设备在效卫约定口可见；lease/job 干净。

然后再：

```powershell
node ops\xw-start.mjs --actor <你的XHS_ACTOR> --json
```

---

## 日常怎么用

装好以后，人工入口是 **`/xw`**（Cursor / Claude Code skill，或直接跑 `ops/xw-*.mjs`）：

| 你想做的事 | 入口 |
|---|---|
| 看能力目录 | `/xw skills` 或 `node ops\xw-skills.mjs` |
| 准备设备 | `/xw start`（可先 `--check`） |
| 跑已固化能力 | `/xw run …` |
| 探索未知面 | `/xw explore …` |
| 恢复隔离/未就绪 | `/xw recover` |

硬规矩：只走 **job / session / Explorer lease**；禁止无 lease 旁路碰机；支付、真实外发、删除永远单独等人确认。

---

## 仓库里有什么 / 没有什么

**有（可公开）**

- `registry.mjs`、`ops/`、`install-registry-task.ps1`
- `.env.example`、`identities.seed.example.json`
- 文档：`docs/third-party-self-host-pack.md`、`AGENTS.md`

**没有（也不该有）**

- `.env`、真实 `identities.seed.json`
- `registry.db`、`outbox/`、截图、生产 devices 表

---

## 安全

- Token / serial / 飞书凭证只放本机 `.env` 与本地配置。
- 历史中的旧示例密钥若曾出现过，以你**当前** `.env` 与已轮换凭证为准；勿复用文档里的占位符当生产密钥。
- 本仓与 `xhs-device-agent` 均为独立自建；clone 不会获得任何远程舰队访问权。

更细的自建清单：[`docs/third-party-self-host-pack.md`](docs/third-party-self-host-pack.md)。
