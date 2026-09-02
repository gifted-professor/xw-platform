# XHS 本地只读真机极速入口 Plan V1

状态：FROZEN_FOR_REVIEW
日期：2026-09-01
授权：fix-once（仅允许评审驱动生成一次 Plan V2；不授权生产发布或真机动作）
风险：HIGH（Windows 本地控制面、真实设备、权限边界）

## 1. 原始目标

用户要求去掉阻塞首次触机的严格恢复设计，遵循“大道至简”，尽快进入手机操作阶段；复杂的发布、恢复和验收关卡在实际遇到问题后再补。

本计划把“去掉”解释为：从默认本地只读操作路径中彻底移除 qualification、relay、rotation、formal release、Gate-F、数据库恢复、owner-lock 恢复和 SYSTEM Scheduled Task 依赖。旧生产实现暂留为 dormant code，不在本次大规模删除，以免删除工作本身延迟触机。

## 2. 已验证现状

- `127.0.0.1:17920`、`17930` 均未监听。
- `XW Platform FastOperator 01/02` 仍以 SYSTEM 运行，分别监听 `127.0.0.1:17895/17897`。
- FastOperator 在任何设备工作前调用 `POST http://127.0.0.1:17920/control/v1/leases/authorize`，请求绑定 `leaseId/deviceId/runtimeId`；缺 lease 会在触机前返回 423。
- 旧任务 `XhsDeviceControlPlaneV1` 已 Disabled，且其代码目录 `C:\Users\Public\xhs-routing-v1-1` 已不存在，不能作为恢复入口。
- 当前 Codex 命令宿主是 Windows Medium integrity；修改受保护 runtime/SYSTEM task 会反复触发 UAC。
- 仓库允许有明确原因的 lab bypass，但 bypass 不能计入生产验收；本计划选择更窄的本地 lease 代理，不启用 FastOperator 的无 lease 环境变量旁路。

## 3. 非目标与硬边界

- 不恢复、修补或迁移现有 M6 qualification/final topology。
- 不修改 control DB，不建立持久化 owner lock，不使用 Scheduled Task，不要求管理员权限。
- 不产生 production acceptance、E-Corpus、R1/R2/R3/R4、Gate-F 或 release drill 证据。
- 不调用原始 ADB、22222、vendor helper 或固定坐标脚本。
- 第一版只允许 `focus` 与 `dump`；禁止 tap、scroll、open、like、collect、comment、publish、message、follow、login、settings、payment 及任何外部效果。
- 不把 token、runtime ID、设备 ID、UI dump 或截图写入 Git。

## 4. 最小架构

新增一个当前用户进程 `lab-readonly-gateway.mjs`，同时占用两个空闲 loopback 端口：

- `17920`：只实现 FastOperator 所需的 lease authorization 和只读健康/lease 查询。
- `17930`：提供明确标记为 `LAB_READ_ONLY / productionAcceptance=false` 的 `agent-entry.md`、JSON agent entry 和健康端点。

同一进程提供本地只读调用入口：

1. 客户端提交 exact `{ alias: "01"|"02", action: "focus"|"dump", label? }`。
2. gateway 根据固定映射 `01 -> 17895`、`02 -> 17897` 创建一个内存 lease 和随机 token；token 不返回客户端、不写日志。
3. gateway 向对应 FastOperator 转发请求并携带 lease headers。
4. FastOperator 回调 `17920/control/v1/leases/authorize`；gateway 校验 token、lease、alias、期限和状态，并在第一次成功回调时把不可逆摘要形式的 `runtimeId` 绑定到 alias。后续 runtime 变化立即拒绝。
5. 响应或超时后在 `finally` 中释放 lease；进程崩溃时内存 lease 随进程消失，端口由 OS 释放，不做 stale-lock recovery。

这一路径不向调用者暴露任意 FastOperator action、目标 URL、端口、token、runtime ID 或 device ID。

## 5. 实现单元

### A. Gateway 与 CLI

- 新增 `services/control-plane/lab/lab-readonly-gateway.mjs`。
- 新增 `services/control-plane/lab/lab-readonly-client.mjs`，只接受 fixed alias/action/label；禁止透传 JSON 或 URL。
- 新增 package scripts：`xhs:lab:start`、`xhs:lab:status`、`xhs:lab:focus`、`xhs:lab:dump`。
- 只绑定 `127.0.0.1`；body、header、响应均设尺寸和超时上限。
- 若 17920 或 17930 已被占用，启动直接失败，不杀进程、不抢占正式控制面。

### B. 最小审计

- 内存保留 active leases；`GET /control/v1/leases` 可见 alias、action、状态、时间和 runtime 摘要。
- 仅追加一行脱敏 metadata receipt 到 Git ignored 的本地运行目录；不保存 token、raw runtime ID 或 dump 内容。
- 每个调用 action budget = 1，单 alias 同时最多一个 lease，硬超时后释放。

### C. 默认路径简化

- 新增一页短文档，唯一 quick start 为：start -> status/agent-entry -> focus -> dump -> stop。
- 明确 M6 qualification/relay/rotation/recovery 是 production-only dormant path，不再作为本地首次触机前置条件。
- 删除本轮新增的 `m6-qualification-emergency-relay-a-fixed.mjs`，避免继续诱导 UAC/immutable-release 绕行；不删除既有生产恢复模块。

## 6. 验证

离线自动化必须覆盖：

1. 只有 `01/02` 和 `focus/dump` 被接受；任意额外键、action、alias、URL、port 均拒绝且 forwarding call = 0。
2. token 不返回、不记录；错误输出不含 token、raw runtime ID 或设备标识。
3. lease 只能授权一次 exact alias，跨 alias、过期、释放、错误 token、runtime drift 全部拒绝。
4. 同 alias 并发第二请求返回 423；不同 alias 可独立执行。
5. FastOperator 失败、超时或非 JSON 响应均释放 lease；不产生重试动作。
6. 17920/17930 任一占用时 fail closed，不结束占用进程。
7. agent entry 明示 lab-only、allowed actions、active lease、productionAcceptance=false。
8. 既有 `fast-operator-auth` 与 serve dispatch 测试继续通过。

实现后、另行获得执行确认，才进行一次真机 smoke：

- 启动 gateway（无 UAC）。
- 读取 `17930/agent-entry.md`。
- alias 01 执行一次 `focus`，随后一次 `dump`。
- 验证两个 lease 均已释放、无 effect action、无持久化 token/raw dump。
- 遇到登录、验证码、风控或系统 overlay，只报告并停止；不导航、不重试。

## 7. 验收标准

- 从普通 Codex Medium shell 到 alias 01 的成功 `focus/dump` 全程零 UAC、零 SYSTEM task mutation、零 owner-lock recovery。
- 操作期间 lease 在 17920 可见，结束后 active lease 为 0。
- 网关不存在可表达写入、导航或任意转发的请求面。
- 停止 gateway 后 17920/17930 自动释放；FastOperator 01/02 不被停止或重启。
- 输出只能声明 `LAB_READ_ONLY_DEVICE_REACHED`，不能声明任何 production gate/acceptance 通过。

## 8. 回退

停止当前用户 gateway 进程即可；没有数据库、任务、ACL、runtime current 或设备持久状态需要恢复。旧生产代码和任务定义保持原状，后续如需生产化再单独设计。

