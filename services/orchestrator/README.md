# xhs-registry

Windows 侧入口仓：registry（17930）、`/xw` ops、身份/知识库面板。  
控制面与业务执行码在兄弟仓 **[xhs-device-agent](https://github.com/gifted-professor/xhs-device-agent)**。

别人要自建舰队时，给这两个 GitHub 地址即可（需自备 Windows + 手机 + 效卫）。**密钥不进 git**：只提交 `.env.example` / `identities.seed.example.json`。

## 对方 clone 后最小路径

```powershell
# 1) 两仓（建议固定目录）
git clone https://github.com/gifted-professor/xhs-registry.git C:\Users\Public\xhs-registry
git clone https://github.com/gifted-professor/xhs-device-agent.git C:\Users\Public\xhs-routing-v1-1
cd C:\Users\Public\xhs-routing-v1-1
git checkout main
git pull

# 2) 本地密钥与身份（勿提交）
cd C:\Users\Public\xhs-registry
copy .env.example .env
copy identities.seed.example.json identities.seed.json
# 编辑 .env：自生成 XHS_AGENT_TOKEN / XHS_HUMAN_TOKEN / XHS_ACTOR …
# 编辑 identities.seed.json：填自己的 serial / 账号
# 编辑 B 仓 config\control-plane.devices.json（从 example 复制）：runtimeId / 端口

# 3) 按 B 仓 AGENTS.md 装控制面 + FastOperator serve；再装 registry：
powershell -File .\install-registry-task.ps1

# 4) 验收（对方自己的机，不是我们的 01–04）
node ops\xw-start.mjs --check --json
curl.exe -s http://127.0.0.1:17930/agent-entry.md
```

更细的三样交付说明：[`docs/third-party-self-host-pack.md`](docs/third-party-self-host-pack.md)。

## 本机开发者

- 密钥：仓库根目录 `.env`（gitignore）。缺文件时从 `.env.example` 复制。
- 身份：`identities.seed.json`（gitignore）。缺文件时从 `identities.seed.example.json` 复制。
- 日常入口：`/xw start|skills|run|explore|recover|…`（见 `.agents` / `.codex` 的 xw skill）。

## 安全

- 不要把 `.env`、真实 `identities.seed.json`、`registry.db`、`outbox/` 推进 GitHub。
- 若仓库曾提交过明文 token：**轮换** agent/human/飞书相关密钥后再分享；仅删当前文件不够（历史 commit 仍可能含旧值）。
- 支付 / 真实外发 / 删除：永远单独等人确认。
