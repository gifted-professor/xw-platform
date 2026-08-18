# XHS Device Agent

多设备控制面与执行码（端口 `17920`、FastOperator、capability / job / lease）。

**日常人工入口在兄弟仓**（`/xw`、registry `17930`）：

**https://github.com/gifted-professor/xhs-registry**

自建舰队请先读 registry 仓根目录 `README.md`（两仓一起 clone + `.env` + 设备表），再回到本仓按控制面文档安装。

基于 ADB、Android UI 层级、可选云端视觉识别和飞书多维表格的多设备资产采集框架。

项目采用“脚本执行、Agent 调度、视觉兜底”的方式：常规页面按控件文字和边界定位；页面结构缺失或版本变化时，才把脱敏截图交给云端视觉模型分析。默认不自动点赞、评论、关注、私信或发布。

## 前置软件

- Windows 10/11、PowerShell 5.1+
- Android Platform Tools，或效卫软件内置的 `adb.exe`
- Node.js 18+（基础采集）；多 Agent 控制面固定使用 Node.js 24.11.1
- 可选：`lark-cli`，用于同步飞书多维表格
- 可选：[效卫安卓投屏官方下载页面](https://www.xiaowei.xin/android)；软件本体不包含在本仓库
- [效卫帮助中心](https://www.xiaowei.xin/help/71)

## 快速开始

1. 复制配置模板：

   ```powershell
   Copy-Item config/devices.example.psd1 config/local.psd1
   ```

2. 编辑 `config/local.psd1`，填写 ADB 路径、设备序列号；需要同步飞书时再填写 Base Token 和 Table ID。

3. 只采集本地数据：

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/Run-Pipeline.ps1 -SkipLark
   ```

4. 采集并同步飞书：

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/Run-Pipeline.ps1
   ```

运行结果保存在 `data/`，该目录已被 Git 忽略。

## 云端视觉识别

复制 `.env.example` 为 `.env`，在当前终端设置相应环境变量，然后运行：

```powershell
node scripts/cloud-vision.mjs --image data/device_inventory/设备序列号/screen.png
```

脚本只返回页面类型、置信度和建议动作，不直接点击手机。Agent 必须在执行动作前重新读取 UI 层级并验证目标。

## 交给 Hermes

Hermes 只需具备 `terminal,file,vision` 工具即可调度本项目，ADB 控制手机不依赖 Windows Computer Use 驱动。

```powershell
hermes -z "按照 skills/xhs-device-operator/SKILL.md 运行一次安全设备盘点，只采集和同步，不执行互动或发布" -t terminal,file,vision
```

推荐让 Hermes 负责日常运行和异常汇报；连续失败、页面大改版或需要新增动作时，再交给 Codex 修改状态机。

## 目录

- `scripts/Collect-PhoneAssets.ps1`：逐台读取硬件、系统、小红书公开主页和 UI 层级
- `scripts/Run-Pipeline.ps1`：一键采集、生成标准 CSV、可选同步飞书
- `scripts/Sync-LarkBase.ps1`：创建必要字段并按设备编号/ADB 序列号更新记录
- `scripts/cloud-vision.mjs`：OpenAI-compatible 云端视觉分类器
- `scripts/greenarrow-api.mjs`：可选的本地 WebSocket API 示例；需要软件侧开放 API
- `skills/xhs-device-operator/SKILL.md`：Hermes/Codex 执行规则
- `docs/ARCHITECTURE.md`：系统结构和页面状态机
- `docs/SAFETY.md`：数据与操作边界
- `docs/control-plane.md`：多 Agent、多手机控制面部署与使用
- `docs/agent-entry.md`：所有 Agent 必须遵循的统一选机、提交和落盘入口

## 多 Agent 控制面

控制面在 Windows 本机 `127.0.0.1:17920` 提供统一任务、租约、审批和证据接口。不同手机可以并发，同一手机严格 FIFO；远端 Agent 通过 SSH 运行 `devicectl`，不直接访问端口。

```powershell
Copy-Item config/control-plane.devices.example.json config/control-plane.devices.json
node control-plane/server.mjs serve
```

Mac 侧：

```bash
node control-plane/devicectl.mjs --ssh xhs-windows health
node control-plane/devicectl.mjs --ssh xhs-windows route plan \
  --actor agent-a --capability xiaowei.device.list
```

普通任务可以省略 `--device`，控制面会按路由档案和最短队列原子分配。
完整入口、配置、审批和迁移规则见 `docs/agent-entry.md` 与
`docs/control-plane.md`。

## 隐私

仓库不应包含 API Key、OAuth Token、设备截图、UI XML、真实 ADB 序列号、账号清单或飞书记录。提交前运行 `git status` 并检查暂存内容。
