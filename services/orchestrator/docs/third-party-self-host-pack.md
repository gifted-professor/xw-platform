# 第三方自建交付包（有机 + 有效卫）

> **一眼入口**：先读仓库根目录 [`README.md`](../README.md)。本文是补充清单。  
> 交付形态：两个 **public** GitHub 地址，对方 clone 后按 README 填 `.env` 即可自建。  
> - https://github.com/gifted-professor/xhs-registry  
> - https://github.com/gifted-professor/xhs-device-agent  

对方自备：Windows、效卫、已登录的安卓机。clone **不会**连到任何现成远程舰队。

## 三样（都在 GitHub 里）

1. **双仓源码** — 上面两个地址  
2. **空配置模板** — `.env.example`、`identities.seed.example.json`、B 仓 `control-plane.devices.example.json`  
3. **安装验收步骤** — 根 `README.md`（本文补充细节）

## 密钥约定

| 文件 | 进 git？ | 作用 |
|---|---|---|
| `.env.example` | 是 | 键名模板 |
| `.env` | **否** | 对方自生成 token |
| `identities.seed.example.json` | 是 | 身份模板 |
| `identities.seed.json` | **否** | 对方自己的 serial |

`install-registry-task.ps1` 从 `.env` 读 `XHS_AGENT_TOKEN` / `XHS_HUMAN_TOKEN` / 可选 observer·operator；源码内不硬编码密钥。

## 验收绿灯

```powershell
node ops\xw-start.mjs --check --json
curl.exe -s http://127.0.0.1:17930/agent-entry.md
curl.exe -s http://127.0.0.1:17920/control/v1/health
```

支付 / 真实外发 / 删除：永远单独等人确认。
