# Agent rules

- Read `docs/agent-entry.md` before any device task and use `devicectl route plan`,
  `job submit`, or a leased session as the only device-operation entry.
- Read `skills/xhs-device-operator/SKILL.md` before operating devices.
- Never choose a runtime device ID or call a direct UI/vendor script outside the
  control-plane audit/canary rules.
- Prefer Android UI hierarchy and semantic selectors over fixed coordinates.
- Treat every phone as an independent layout and version profile.
- Allowed without extra confirmation: inventory, screenshots for diagnosis, UI dumps, opening the app, navigating to the local user's own profile, and syncing approved public/device fields.
- Require human confirmation for publishing, commenting, following, messaging, deleting, account changes, login challenges, payments, or external communication.
- Never bypass CAPTCHAs, platform restrictions, risk controls, or identity verification.
- Never commit `.env`, `config/local.psd1`, `data/`, screenshots, UI XML, OAuth tokens, or real device/account identifiers.
- Stop a device after two consecutive navigation failures and report the current screenshot and hierarchy paths.
## 部署流程（2026-07-24 起，用户指定为标准流程）

生产控制面跑在 Windows `C:\Users\Public\xhs-routing-v1-1`（git 分支
`agent/placement-entry-v1-1-20260724`，跟踪 origin）。**禁止 scp 热改 Windows 文件**，一律：

1. 在 GPFS 仓库改代码 → `npm test` 全绿
2. commit → push 到 origin 分支
3. Windows `git pull`（仓库已挂分支，不再是 detached HEAD；注意 Windows 侧 CRLF 行尾，certutil 哈希与 Mac 不一致属正常，比对内容要去 `\r`）
4. 重启生效：`schtasks /end /tn XhsDeviceControlPlaneV1 & schtasks /run /tn XhsDeviceControlPlaneV1`（registry 17930 已验证能在控制面重启后存活，无需联动重启）

设备路由/端口配置改 `C:\Users\Public\xhs-routing-v1-1\config\control-plane.devices.json`
（不入库），改后同样重启控制面生效。
