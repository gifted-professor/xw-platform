# XHS 本地只读真机极速入口 Plan V2（终版）

状态：READY_FOR_EXECUTION
日期：2026-09-01
授权：fix-once 已消费；Plan V2 不再自动评审
风险：CRITICAL（本地 lease authority、真实设备、隐私可见性）
Plan V1 SHA-256：`7a9ebf6278f8a9dfa3d941622865b7132c299df13d6e1d45aa9cab20081e55c0`

## 1. 目标

用普通 Codex Medium shell、零 UAC、零 SYSTEM task mutation，在现有 FastOperator 01/02 listener 上建立一个 lab-only、内存态、只读入口，尽快完成一次真实设备 `focus`，随后允许一次 `dump`。

从该默认路径彻底移除 qualification、relay、rotation、formal release、Gate-F、数据库恢复、owner-lock 恢复和 Scheduled Task 依赖。既有生产恢复代码保留为 dormant code，不再阻塞 lab 首次触机。

## 2. 明确声明边界

- 只声明 `LAB_READ_ONLY_SLOT_REACHED`，不声明 production alias/device identity、Gate、release 或 acceptance 通过。
- 固定 slot 映射为 `01 -> 127.0.0.1:17895`、`02 -> 127.0.0.1:17897`。首次回调的 runtime 只用于同一 gateway 生命周期内的一致性比较；它不是可信设备身份证明。
- 第一版只允许 `focus` 和 `dump`。不存在 tap、scroll、open、launch、back、input、like、collect、comment、publish、message、follow、login、settings、payment、raw shell、ADB、22222 或任意转发入口。
- 现有 FastOperator 的 `dump` fallback 可能在手机留下 `/sdcard/fo-dump.xml`。V2 明确接受它作为 lab 诊断副产物，因此不再声称“零设备持久化”；raw dump 不由 gateway 写盘或提交 Git。
- lab receipt 不计任何生产验收。

## 3. 最小实现

新增一个只使用 Node 标准库的当前用户进程：

- `services/control-plane/lab/lab-readonly-gateway.mjs`
- `services/control-plane/lab/lab-readonly-client.mjs`

Gateway 同时绑定 loopback：

- `17920`：FastOperator compatibility authorization、health、active lease/status。
- `17930`：lab `agent-entry.md`、JSON agent entry、health。

新增 package scripts：

- `xhs:lab:start`
- `xhs:lab:status`
- `xhs:lab:focus -- <01|02>`
- `xhs:lab:dump -- <01|02> [label]`

启动时若 17920 或 17930 任一已占用，直接失败；不结束、不重启、不修改任何现有进程或任务。

## 4. 单一信任边界

Gateway 是 lab 动作 allowlist 的唯一安全边界；不得宣称 FastOperator 的 `/leases/authorize` 自身绑定 action，因为现有回调只携带 `leaseId/deviceId/runtimeId`。

每次客户端调用使用两类独立随机 secret：

1. client token：启动时生成，写入 Git-ignored、当前用户私有的本地文件；CLI 必须携带。拒绝浏览器 Origin、跨站请求和无 token 请求。
2. operator token：每个操作重新生成，仅在 gateway 内存和发往 FastOperator 的 header 中存在；不返回客户端、不写日志、不写 receipt。

Gateway 不接受调用者提供 JSON action body、URL、port、token、deviceId 或 runtimeId。CLI 解析 exact 命令后，gateway 从常量构造 FastOperator body：

- focus 恒为 `{ "action": "focus" }`
- dump 恒为 `{ "action": "dump", "label": <bounded label> }`

一个独立的 mutation probe 必须替换/污染拟转发 action（如 `tap`、`scrollDown`、未知 action），并证明在 HTTP forwarding 前拒绝且 FastOperator fake 调用数为 0。

## 5. Lease 生命周期

每个 slot 同时最多一个状态机：

`PENDING -> AUTHORIZED -> IN_FLIGHT -> RELEASED`

- `/control/v1/leases/authorize` 原子校验并单次消费 exact operator token、lease ID、slot/device ID、TTL；第一次记录 runtime 的进程内 HMAC，之后必须一致。
- client deadline 只影响客户端等待，不释放底层 lease。
- slot 只有在 outbound FastOperator 请求真实 settle 后才进入 RELEASED。
- 若 outbound 超时或连接状态未知，slot 进入 `IN_FLIGHT_UNCERTAIN`，拒绝后续请求；不自动重试、不猜测完成、不报告 active lease=0。
- 第一版不实现自动恢复。进程异常退出后，重新启动前必须由操作者确认 FastOperator 请求已结束；这条是 fail-stop 运维说明，不新增恢复服务。

Active leases 可从 `GET /control/v1/leases` 和 17930 agent entry 看到；只显示 slot、action、状态、时间和 ephemeral runtime HMAC，不显示任何 secret/raw runtime/device identifier。

## 6. 本地数据与日志

- Gateway 不使用 SQLite、control DB、release current、runtime secrets 或 protected `xw-runtime` 文件。
- 只在 Git-ignored 本地目录写 client-token 文件和脱敏 metadata receipt。
- 不保存 FastOperator response、UI XML、截图、operator token 或 raw runtime ID。
- 所有请求体、header、label、响应和超时有固定上限；错误消息递归脱敏。

## 7. 默认路径清理

- 新增一页唯一 quick start：start -> status/agent-entry -> focus -> dump -> stop。
- 标记 M6 qualification/relay/rotation/recovery 为 production-only dormant path，不再作为 lab 前置条件。
- 删除本轮新增的 `services/control-plane/ops/m6-qualification-emergency-relay-a-fixed.mjs`，避免继续诱导 UAC/immutable-release 绕行。
- 加静态负向依赖测试：lab gateway/client 不得 import qualification、relay、rotation、Gate-F、owner-lock、DB、Task Scheduler、release builder、ADB 或 22222 模块。

## 8. 离线验证

1. exact slot/action/schema：额外键、未知 alias、URL/port/body/action 注入均在 forwarding 前拒绝。
2. gateway 只可能构造 focus/dump 两种常量 body；mutation probe 使被污染版本 fail closed，fake forwarding=0。
3. client/operator token 分离；operator token 不可从任何 API、receipt、日志或错误读取。
4. operator authorization 单次消费；跨 slot、过期、释放、错误 token、runtime HMAC drift 全部拒绝。
5. 同 slot 并发返回 423；不同 slot 独立。
6. client deadline 不释放 lease；底层 settle 才释放；未知完成进入 `IN_FLIGHT_UNCERTAIN`。
7. 17920/17930 端口冲突 fail closed 且不杀进程。
8. agent entry 明示 lab-only、slot semantics、allowed actions、dump 副产物、active lease、productionAcceptance=false。
9. 负向依赖扫描通过；既有 `fast-operator-auth` 和 serve dispatch 测试继续通过。
10. 从 Medium shell 启停 gateway 的集成测试不调用 `RunAs`、schtasks、ACL、taskkill 或管理员 Node。

## 9. 首次真机 smoke（实现验收后另行执行）

1. 普通权限启动 gateway。
2. 读取 `http://127.0.0.1:17930/agent-entry.md`。
3. slot 01 执行一次 focus；确认响应后 lease=0。
4. slot 01 执行一次 dump；明确接受可能存在的 `/sdcard/fo-dump.xml`，不把 response 写盘。
5. 确认 active lease=0、无 effect action、无 UAC、无 SYSTEM/task/runtime mutation。
6. 遇登录、验证码、风控或系统 overlay，只报告并停止；不导航、不重试。

## 10. 验收与回退

- 成功标准：普通 Medium shell 完成 slot 01 focus/dump，期间 lease 可见，结束后 lease=0，全程零 UAC。
- 输出仅为 `LAB_READ_ONLY_SLOT_REACHED`。
- 回退只需停止 gateway；17920/17930 由 OS 释放。FastOperator 01/02、生产任务、数据库、ACL 和 runtime 均不变。

## 11. 评审裁决记录

- `XHS-LAB-AUTH-01` P1 — ACCEPT：不伪称 FastOperator action-bound auth；gateway 为唯一边界，双 token + 常量 body + mutation probe。
- `XHS-LAB-BIND-01` P1 — ACCEPT：TOFU 仅作进程内一致性；声明从 alias/device 降为固定 slot。
- `XHS-LAB-LEASE-01` P1 — ACCEPT：client timeout 不释放；未知完成 fail-stop。
- `XHS-LAB-DUMP-01` P1 — ACCEPT：显式接受已知设备端诊断文件，不再承诺零设备持久化。
- 保留生产恢复代码 — ACCEPT：不冲突于“从默认操作路径去掉严格恢复”的用户目标，并以负向依赖测试证明 lab 不调用它。

