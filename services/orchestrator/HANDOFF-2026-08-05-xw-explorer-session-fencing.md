# `/xw explore` 占用登记与原子 fencing 交接（2026-08-05）

## 一句话状态

Registry 本仓已经补齐 `/xw explore` 的**可见 session 占用、逐请求复核和本地身份钉死**，并通过独立 source-only review；但 raw 22222/ADB 请求尚未成为 control-plane `session_action`，所以“设备动作执行中禁止外部 release”的跨客户端原子 fencing 仍需在 `xhs-device-agent` 控制面完成。

不要把当前状态描述为“完整硬 fencing 已上线”。当前代码尚未 merge、部署或真机 replay。

## 当前分支与证据

- 仓库：`C:\Users\Public\xhs-registry-wt-explorer-lease`
- 分支：`codex/explorer-lease-hard-gate-20260805`
- 最终 HEAD：`10d94e4`（`fix: pin screencap session across fallback`）
- 基线：`3d712db`
- 独立 reviewer：`resolver_canary_impl`
- verdict：`APPROVE（source-only 范围）`
- Explorer 专项：`12/12 PASS`
- `npm run check`：PASS
- `git diff --check`：PASS
- 全程未访问 live API、未 acquire live session、未碰 01–04、未部署/reload/replay。

完整 `npm test` 在本轮较早 HEAD 为 `130/134`；4 个失败均为既有/范围型失败：

1. approved repair plan frozen hash；
2. Repair scope 检查拒绝任何本功能分支文件；
3. Registry cold-cache singleflight 期望 1 次、实际 0 次；
4. Windows 无权限创建测试 symlink（EPERM）。

本功能专项、解析测试和语法检查均为绿色。

## 本仓已经完成

### 1. 正式可见占用

新增 `ops/xw-explore-session.mjs` 和 `ops/_explore-lease.mjs`：

- acquire `xiaowei.lab.raw` canary session；
- acquire 后再次检查 `/control/v1/leases`，只有 interactive lease 的 actor/device/lease 全匹配才报告成功；
- heartbeat/status/release 均固定访问 `127.0.0.1:17920/17930`；
- context 不能携带或覆盖 control/registry endpoint；
- release 未得到明确确认时不删除 context，避免留下不可管理的孤儿 lease。

### 2. Context 与 keeper 收口

- token context 只能直接位于 `%USERPROFILE%\.xhs-explorer-sessions\`；
- 拒绝相对路径、任意公共目录、symlink/junction/reparse root 和非普通文件；
- Windows 写入后使用 `icacls` 去继承并只授权当前用户；ACL 失败则删除 context，并 best-effort release session；
- acquire 不再启动 detached keeper；
- 前台 keepalive 钉死首次 `contextId/sessionId`，同路径新会话不会被旧 keeper 接管。

### 3. 全部 Explorer 调用传播 session

- 原子 ops：screenshot/dump/tap/input/focus/launch/back/swipe/shell 等均要求 `--session-file`；
- 12 个单机 composite 和 4 个 set/rail composite 传播同一 context；
- set 脚本按 `<session-dir>\<alias>.json` 使用每机独立 session；
- `_win-xiaowei`、`_win-screencap` 缺 context 时在设备 I/O 前 fail closed。

### 4. 长驻 helper 防接管

- REPL 每条 dispatch、每个 22222 request 前重新 heartbeat + 查可见 lease；
- helper 启动后钉死 `contextId/sessionId/leaseId/actorId/deviceId`；
- release A 后同路径 acquire B，旧 REPL 不会借 B 的 lease 继续；
- screencap 从 Xiaowei 降级 ADB 时同样钉死身份，并在 screencap/pull 前分别复核；
- 运行中 device 进入 quarantine 会拒绝后续请求。

### 5. 文档已同步

已更新：

- `AGENTS.md`
- `modes/explorer.md`
- `PROGRESS.md`
- `skills/SKILL.md`
- device/Douyin/XHS/WeChat 相关 Skills
- `skills/shared/preflight.md` / `skills/shared/transport.md`
- `knowledge-seed-explorer-lease-hard-gate-20260805.json`

旧的“只跑 preflight 就直接动手”和 raw `adb input tap` 指引已经移除。

## 为什么仍未完全闭环

当前 raw helper 的顺序仍是：

```text
verify/heartbeat visible lease
        ↓
直接请求 22222 或 adb
```

控制面并不知道 raw 请求已经开始。因此另一个客户端可能在 verify 之后、I/O 完成之前 release session；控制面随后可能允许第二个 agent acquire 同机 lease。

本仓通过“每个 raw request 前复核”缩小窗口，但不能提供跨进程、跨客户端、崩溃安全的原子保证。本地 lock 也不能解决其他客户端直接调用控制面 release，因此不要用本地 mutex 冒充最终方案。

真正闭环必须变成：

```text
POST /control/v1/sessions/:sessionId/actions
        ↓
控制面验证 token + session identity
        ↓
登记 active session_action（此时 release 返回 SESSION_ACTION_RUNNING）
        ↓
adapter 持 fencing/lease credential 执行唯一 bounded primitive
        ↓
动作完成并落 event/evidence
        ↓
解除 active action，之后才允许 release
```

现有控制面已有这套基础语义：`executeSessionAction()` 会复用 session lease、按设备串行，并在 action 运行中禁止 release。问题是现有 `xiaowei.lab.raw` schema 只允许 `list`、`Screen`、`imeList`，无法承接现有 Explorer 的 dump/tap/input/focus/launch/back/swipe 等动作。

## 下一阶段：必须做什么

### WP1 — 在 `xhs-device-agent` 设计 bounded Explorer primitive capability

目标仓：GitHub `gifted-professor/xhs-device-agent`，Windows checkout `C:\Users\Public\xhs-routing-v1-1`，必须从 `main` 开新分支。

不要简单把任意 `adb_shell` 加入 `xiaowei.lab.raw` enum。建议新增或收紧为一个明确的 canary-only capability，例如 `xiaowei.explorer.primitive`，输入采用判别联合：

- `screen`
- `dump_ui`
- `focus`
- `tap`（整数坐标和屏幕边界校验）
- `swipe`（有界坐标/时长）
- `back`（次数有界）
- `launch_app`（package/activity allowlist 或安全正则）
- `input_text`（长度、IME restore、禁止 secret 落 evidence）

`shell` 不应作为任意命令透传；如确有需要，拆成只读 allowlisted diagnostics，或继续保持明确 lab-only、不可进入默认 `/xw explore`。

### WP2 — Adapter 内执行 primitive，移除 helper 对 22222/ADB 的直接业务调用

- session action 必须调用正式 adapter；
- adapter 从控制面获得 session lease/fencing credential；
- Gateway/transport 在首次及必要的每次设备请求前校验 credential 与 device/runtime serial；
- action 运行期间由控制面 `activeJobs`/session action 状态阻止 release；
- 不允许 client 先 action 登记、再绕回本地 raw helper；设备 I/O 必须发生在受控 adapter 内。

### WP3 — Registry `/xw explore` 切到 session action client

在本分支或后续 Registry 分支中：

- `ops/_explore-lib.mjs` 不再直接 spawn 22222 helper；
- 每个 primitive 生成唯一 idempotency key，POST session action；
- composite 继续复用同一 session，但每个 primitive 都是正式 action；
- action response 绑定 job/run/event/evidence；
- 删除 ADB fallback 旁路，fallback 也必须是 adapter 内部的受控实现。

### WP4 — 必须新增的离线测试

至少覆盖：

1. action 运行中 release → `423 SESSION_ACTION_RUNNING`；
2. action 完成后 release 成功；
3. lease 过期/错误 token → adapter 零调用；
4. session A context 被 B 替换 → 旧 helper/action client 永久拒绝；
5. 第二 agent 同机 acquire → `DEVICE_BUSY`；
6. alias/device/runtime serial 任一漂移 → 零设备 I/O；
7. quarantine 在 action 前发生 → 零设备 I/O；
8. idempotency key 同请求复用、异请求冲突；
9. input/screenshot/dump evidence 不含 session token、输入正文或 secret；
10. 所有旧 raw helper 入口在无正式 action envelope 时 fail closed。

### WP5 — Review、合并与部署闸门

代码完成后的顺序：

1. xhs-device-agent 独立 source review；
2. Registry 独立 source review；
3. 人类决定是否 merge；
4. 人类授权部署/reload；
5. 先用非 01 的明确指定设备做 canary（若当时人仍要求避开 01）；
6. 人类授权后才做真机 replay；
7. 验证 Registry lease、action event、release blocking 和最终 restoration；
8. 再同步正式安装的 `/xw` Skill。

任何 source APPROVE 都不等于允许 merge、deploy 或 replay。

## 接手者第一小时建议

1. 读取本文件、Registry `AGENTS.md`、`modes/explorer.md`。
2. 在 `C:\Users\Public\xhs-routing-v1-1` 读取其 `AGENTS.md`、`docs/agent-entry.md`。
3. 只读检查现有实现：

   ```powershell
   rg -n "executeSessionAction|SESSION_ACTION_RUNNING|xiaowei\.lab\.raw" control-plane apps docs tests
   ```

4. 先写 capability schema、adapter boundary 和 release/action 并发测试；不要先碰设备。
5. 提交设计与测试结果供独立 review。

## 当前分支验证命令

```powershell
cd C:\Users\Public\xhs-registry-wt-explorer-lease
node --test tests\explorer-lease-gate.test.mjs tests\xhs-parse.test.mjs
npm run check
git diff --check 3d712db..HEAD
git status --short
```

预期：Explorer + parse `36/36`（当前 Explorer 12、parse 24），check/diff-check 通过，工作树干净。

## 绝对不要做

- 不要为“验证一下”直接连 22222/ADB；
- 不要手改 `control.db`；
- 不要把任意 shell 伪装成 bounded primitive；
- 不要让 Registry client 自己声称 action running，而控制面无记录；
- 不要把 source-only APPROVE 写成“已部署”；
- 不要未经人类授权 merge、部署、reload 或真机 replay；
- 不要默认碰 01；设备选择以接手当时 live 状态和人的明确指示为准。

