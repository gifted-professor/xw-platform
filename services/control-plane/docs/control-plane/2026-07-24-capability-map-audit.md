# HANDOFF — 能力地图完整性审计（完整版）+ 多 Agent 并发风险分析

> **来源**: 用户综合审计结论（无单一在线源会话，片段散见 kimi [1]/[9] 等闲鱼真机会话 + claude [0] 架构审计）
> **项目**: xhs-windows | **cwd**: `/Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-windows`
> **采集时间**: 2026-07-23T23:05+08:00
> **关联文件**:
> - `~/handoffs/HANDOFF-from-eaecdd5a-xhs-windows.md`（claude 架构审计版）
> - `~/handoffs/HANDOFF-from-019f8005-windows-control-bridge.md`（codex SSH 配置版）

---

## 一、核心判断

原方案有「节点/服务/能力/路由/任务/证据」骨架，但**还不能称完整能力地图**。最核心病根是把六种不同真相混为一谈：

```
知识库真相 ≠ 代码真相 ≠ 部署真相 ≠ 当前在线 ≠ 已授权 ≠ 动作真实生效
```

## 二、现场差异（铁证）

- **capability-library**: 457 能力 / 459 报告，但仅 **5 条**被 Route/Workflow 引用；455 条仍 `experimental`、104 条 `partial`。
- **Windows `DESKTOP-3I1EVHE`**:
  - `17910/17911/17912/22222` 在线，但 Tailscale `443→17891`、`17901→17900` 都 502（入口在、后端死）。
  - `17910/17911` 暴露 52 条能力 vs GPFS 新工作树 57 条 → **部署落后于源码**。
  - `17912` `active=[]` 仅开 `1511f78c`；4 号机只有效卫网关可见。
- **Mac**: OpenCLI 在线但扩展未连、profile=0；Funnel `8443→8907` 在但 `8907` 后端未监听。
- **Codex**: 可见 ~426 工具 ≠ 已登录/获权/业务验证。

## 三、16 类漏掉的一级对象

| 漏项 | 必须记录什么 |
|---|---|
| Runtime/Session | Codex Desktop、CLI、Claude、Hermes、OpenCLI 各自的工具和权限 |
| Installation 生命周期 | cached、installed、enabled、configured、authenticated、connected、healthy、verified |
| Deployment/Provenance | repo、worktree、branch、commit、dirty、manifest hash、部署 hash、运行进程绑定 |
| Executor 与 Transport | 执行器和 HTTP、SSH、Tailscale、ADB、WS、CDP、文件、IME 通道必须分开 |
| Endpoint/Ingress | bind 地址、暴露范围、TLS、认证、后端及后端健康 |
| Identity/Profile | 设备 alias/serial、App 安装、登录账号、浏览器 profile、租户；只保存凭据引用 |
| Policy Environment | raw-lab、测试、dry-run、生产、发布/发送禁区、审批要求 |
| Effect Certification | 可调用、schema 已知、请求成功、动作生效、清理成功、回滚验证分别记录 |
| Job/Run/Attempt | lease、checkpoint、幂等、超时、取消、补偿、清场、baseline 前后状态 |
| Evidence/Artifact | 哈希、采集时间、版本环境、支持哪个结论、ACL、隐私等级、保留期 |
| App State/Perception | 页面状态图、selector、OCR/视觉/层级树、ROI、置信度、版本适配 |
| Human Gate/Recovery | 人工审核、登录/CAPTCHA、USB 重插、恢复控制器、最终发布确认 |
| Supervisor/Schedule/Event | launchd、Windows 计划任务、cron、watchdog、webhook、最近/下次运行 |
| Storage/Sync/Data | GPFS、数据库、云盘、Syncthing、证据库、数据驻留与冲突策略 |
| Model Route | provider、model、协议适配器、vision/context、quota、cost、fallback |
| Incident/Drift/Coverage | declared、live、stale、offline、unmapped、unknown、conflicted、superseded |

## 四、六组件架构（非三组件）

```text
1. capability-control-plane  统一查询、选路、Job
2. node-agent                Mac/Windows 本机发现
3. service-adapters          现有 API/CLI/WS 适配
4. app-onboarding-kit        新 App 探索与晋级
5. policy-evidence-store     权限、证据、事故、基线
6. capability-library-sync   正式知识库与运行时地图连接
```

## 五、通用 API 缺口

**P0（优先补）**:
```
GET  /control/v1/runtime-instances
GET  /control/v1/sessions/{id}/tools
GET  /control/v1/deployments
GET  /control/v1/endpoints
GET  /control/v1/links
GET  /control/v1/identities
GET  /control/v1/policies
GET  /control/v1/coverage
GET  /control/v1/drift
GET  /control/v1/incidents
POST /control/v1/resolve
```

**任务执行层**:
```
POST /control/v1/jobs
GET  /control/v1/jobs/{id}
GET  /control/v1/runs/{id}
POST /control/v1/jobs/{id}/cancel
GET  /control/v1/evidence/{id}
```

**完整性接口**:
```
GET  /control/v1/snapshot
GET  /control/v1/coverage
POST /control/v1/refresh
```

`coverage` 必须明确报告：
```json
{
  "declared": 120,
  "discovered": 104,
  "healthy": 71,
  "degraded": 8,
  "offline": 12,
  "stale": 13,
  "unmapped": 9,
  "unknown": 7
}
```

## 六、推荐 5 层分层

1. `capability-library`：经人工审核的知识真相。
2. Runtime Registry：当前节点、部署、端口、设备、连接和健康真相。
3. Policy/Router：这次任务允许走哪条路线。
4. Job/Run/Evidence：本次到底执行了什么、是否真实生效。
5. Human Review：能否晋级、发布、发送或进入生产。

## 七、登记范围（未逐项盘点）

### 1. Mac 本机
- Codex：skills、plugins、apps/connectors、浏览器、Computer Use、任务管理能力
- Claude：CLI、skills、`cx`、CCB、登录与模型状态
- Hermes：skills、plugins、channels、MoA、gateway、定时任务
- OpenCLI：adapter、profile、CDP/Browser Bridge
- 本地模型网关：CLIProxyAPI、CC Switch/NewAPI、Ollama/vision sidecar
- GPFS、Tailscale、SSH、文件桥、自动化任务

### 2. Windows
- `windows_bridge.py` 的读写、执行、文件和手机传输能力
- 绿箭 `22222` 的 action map
- 闲鱼 `17912` API
- 当前离线但曾存在的 `17900`、`17891`
- 计划任务、工作树、CLI 和各类探针
- **小薇/效卫/绿箭必须作为不同服务登记，不能混写**

### 3. 手机和设备
- `alias ↔ serial ↔ 物理编号`
- 分辨率、系统、App 版本、登录状态、IME
- 网关、ADB、截图、语义树、文件传输分别是否可用
- 每台手机通过了哪些 App 能力
- 当前租约、基线、最后验证时间

### 4. App 能力
- 小红书、闲鱼、微信（语义树不足边界）
- 后续淘宝、抖音、拼多多等
- 每个 App 的页面地图、原子能力、workflow、验收器和禁止动作

### 5. 外部集成
- 飞书/Base、企业微信、Telegram
- Gmail、Google Drive、Slack 等已安装 connector
- GitHub、Linear、Netlify、Vercel 等开发服务
- **只登记"是否配置、是否连接、能力范围"，绝不登记 token 和 cookie**

### 6. 知识与数据资产
- `capability-library` 正式能力卡
- Route Sidecar
- TailAgent Capability Exchange
- 项目 handoff、incident、gap、field report
- 各项目专属 API 和 review portal

## 八、三路合并策略

> 接口和数据模型应覆盖所有能力，但不能靠人工一次性写全；必须使用**自动发现、服务自描述、人工审核**三路合并，并永远允许 `unknown/stale/offline`，不能假装全绿。

## 九、纪律

系统权限、连接器真实登录态、部分 Windows 计划任务保持 `unknown`，不能假定可用；「可见/监听/插件存在/声明」四件套都不等于可执行，判定必须落到 Effect Certification。

---

## 十、多 Agent 并发操控风险分析（用户核心问题）

### 当前架构的冲突点

| 冲突层 | 现状 | 风险 |
|---|---|---|
| **设备控制** | 网关 `22222` 是单点 USB 通道，无锁机制 | 两个 agent 同时 `input tap` 会互相干扰 |
| **文件系统** | GPFS 共享挂载，无版本控制 | 并发写同一文件会冲突 |
| **API 调用** | `17910/17911/17912` 无鉴权、无速率限制 | 并发调用可能触发设备端异常 |
| **状态一致性** | 各 agent 独立维护上下文，无共享状态 | A agent 看到的状态可能被 B agent 改变 |
| **证据链** | 无统一 Job/Run 追踪 | 无法追溯哪个 agent 做了什么 |

### 具体场景

1. **Hermes + Codex 同时操控同一台手机**
   - Hermes 通过 `22222` 发 `input tap 500 800`
   - Codex 同时发 `input swipe 300 1000 300 500`
   - 结果：设备端执行顺序不确定，UI 状态混乱

2. **Claude + Kimi 同时写 GPFS 上的同一个项目文件**
   - Claude 在 `xhs-windows/02-项目进度.md` 追加内容
   - Kimi 同时覆写同一文件
   - 结果：后写覆盖先写，数据丢失

3. **多个 agent 同时调用 `17912` 闲鱼 API**
   - 无速率限制，可能触发闲鱼风控
   - 无 Job 追踪，无法确定哪个请求导致了封号

### 当前项目"乱不乱"的诚实回答

**现在就很乱**，只是靠运气和人工协调没出大事：

- 设备掉线（2 号机 `211d0120`）靠人工重插
- 微信自动化靠"手动点开聊天，agent 接管"的人机分工
- 各 agent 会话独立，靠 abtop 快照 + HANDOFF.md 人工同步
- 无锁、无队列、无状态共享、无证据链

### 需要的机制（当前缺失）

| 机制 | 作用 | 现状 |
|---|---|---|
| **设备租约 (Lease)** | 同一时刻只有一个 agent 能控制一台设备 | ❌ 无 |
| **Job 队列** | 任务排队执行，避免并发冲突 | ❌ 无 |
| **分布式锁** | 文件/资源级别的互斥 | ❌ 无 |
| **共享状态存储** | 所有 agent 看到一致的设备/任务状态 | ❌ 无 |
| **证据链 (Evidence Chain)** | 每个操作可追溯、可回滚 | ❌ 无 |
| **Policy Engine** | 哪些 agent 能做什么操作 | ❌ 无 |

---

## 十一、下一步建议

### 短期（防乱）
1. **人工协调**：同一时间只让一个 agent 操控设备
2. **HANDOFF.md 同步**：每次交接落盘，新会话先读
3. **abtop 快照**：操作前先看有没有其他活跃会话

### 中期（机制）
1. 实现设备租约：`POST /control/v1/leases {device_id, agent_id, ttl}`
2. 实现 Job 队列：`POST /control/v1/jobs` 返回 job_id，异步执行
3. 实现证据链：每个 Job 记录 `baseline → action → result → cleanup`

### 长期（架构）
1. 落地六组件架构
2. 实现三路合并的能力注册
3. 实现 Policy Engine + Human Gate
