# XHS Lab 只读极速入口 — 可执行落盘计划（Executable Plan）

上游：`plan-v2.md`（SHA-256 `5658803b…10d6e`）+ `execution-contract.json`（SHA-256 `de09dbda…ab3`）+ `execution-route.json`。本文件不改变能力边界；与 V2 冲突时以 V2 为准，实施中若需改变边界 → 停止并 `BLOCKED_NEEDS_DECISION`。

执行环境：`.worktrees/xhs-r03`（Node 24，普通 Medium shell，零 UAC，零 SYSTEM task mutation，Node 标准库 only）。

## 0. 执行总则

- 只声明 `LAB_READ_ONLY_SLOT_REACHED`。固定 slot 映射 `01 -> 127.0.0.1:17895`、`02 -> 127.0.0.1:17897`；首次回调 runtime 只做进程内 HMAC 一致性，不是设备身份。
- 只允许 `focus` 和 `dump`；gateway 是唯一 action allowlist；常量 body + mutation probe。
- Lease 状态机 fail-stop：`PENDING -> AUTHORIZED -> IN_FLIGHT -> RELEASED`；client deadline 不释放；未知 settle → `IN_FLIGHT_UNCERTAIN`；无自动恢复。
- 17920/17930 被占用即 fail closed；不杀任何进程。全程不使用 `XHS_ALLOW_BYPASS`。
- dual token：client token（启动生成、Git-ignored、CLI 必带）与 operator token（每操作重生成、仅内存 + FO header）。
- 完成本计划后 **硬停**；V2 §9 真机 smoke（slot 01 focus → dump）需操作者另行逐段授权。

## WP1 — 胡姬花 compile（无边界变更）✅ 本文件与 route 即产物

`execution-route.json`（`risk_tier: CRITICAL`，`preflight.mode: CLAUDE_CLI_PLAN_MODE`，`execute_authorized: false`）+ 本文件。契约 `planSha256` 已绑定当前 plan-v2（复核 5658803b… 一致，未改动契约）。

## WP2 — Lab gateway + client + scripts

新增（Node stdlib only，禁 import 生产 router/state-store/DB/qualification/relay/rotation/Gate-F/owner-lock/Task Scheduler/release builder/ADB/22222）：

- `services/control-plane/lab/lab-readonly-gateway.mjs` — 同进程绑定 17920（FO 兼容 `POST /control/v1/leases/authorize`、`GET /control/v1/leases`、health）与 17930（`agent-entry.md` + JSON agent entry + health，明示 lab-only、slot semantics、.allowed actions、dump 副产物 `/sdcard/fo-dump.xml`、`productionAcceptance=false`）。
- `services/control-plane/lab/lab-readonly-client.mjs` — CLI exact 命令 + client token；拒绝浏览器 Origin、缺 token、额外键、未知 slot、非法 label。
- slot map 常量：`01 -> http://127.0.0.1:17895`、`02 -> http://127.0.0.1:17897`；lab deviceId 固定 `lab-slot-01|02`（非生产 alias/identity）。
- gateway → FO headers：`x-control-lease-id`、`x-control-token`、`x-control-device-id`；body 恒为 `{action:"focus"}` 或 `{action:"dump",label}`，任何污染（tap/scrollDown/未知 action/额外键/URL/port 注入）在 forwarding 前拒绝（fake FO spy=0）。
- 本地数据：Git-ignored `.xw-lab/`（client token + 脱敏 metadata receipt）；不落 SQLite/xw-runtime/raw dump/UI XML/operator token/raw runtimeId。
- scripts：root + `services/control-plane/package.json` 加 `xhs:lab:start|status|focus|dump`；`check-js.mjs` walk 根加 `lab`；root `check` --check 清单加两个 lab 文件；`.gitignore` 加 `.xw-lab/`。

exit：`npm --prefix services/control-plane run check` 绿。

## WP3 — 离线 probe 矩阵（契约 4 items 全覆盖）

`services/control-plane/tests/lab-readonly-gateway.test.mjs`（CP `test` 自动拾取）+ 命名聚合 `test:xhs-lab`：

| contract item | probes |
|---|---|
| XHS-LAB-AUTH-01 | auth-adversarial / auth-forgery / auth-replay |
| XHS-LAB-BIND-01 | bind-adversarial |
| XHS-LAB-LEASE-01 | lease-adversarial / lease-forgery / lease-replay |
| XHS-LAB-DUMP-01 | dump-regression |

外加 V2 §8 的 10 项：常量 body+mutation probe（spy=0）、双 token 不可读、单次消费+drift 拒绝、同 slot 并发 423/跨 slot 独立、deadline 不释放+`IN_FLIGHT_UNCERTAIN` active≠0、端口占用 fail closed、agent entry 声明、负向 import 扫描、`fast-operator-auth` + serve dispatch 保持绿、Medium shell 启停无 RunAs/schtasks/ACL/taskkill/管理员 Node。

exit：全部绿；raw dump/UI XML 任何 gateway 持有文件零命中。

## WP4 — 默认路径清理

- 删除本轮 `services/control-plane/ops/m6-qualification-emergency-relay-a-fixed.mjs`（V2 §7）。
- 新增一页 quick start：start → status/agent-entry → focus → dump → stop；披露 dump 副产物与 lab-only 声明。
- M6 qualification/relay/rotation/recovery 标注 production-only dormant；不删除既有生产恢复模块。

## WP5 — 硬停（live 另行授权）

离线 PASS 后 **不** 启动真机请求、不向 17895/17897 发任何东西、不占用/不杀 17920/17930。V2 §9 smoke（普通权限 start → 17930 agent-entry → slot 01 focus → slot 01 dump → lease=0、零 UAC）以及回退（仅停 gateway）需操作者显式逐段授权后另行执行。

## 完成态

- 输出仅 `LAB_READ_ONLY_SLOT_REACHED`（真机段）或 OFFLINE_PASS（离线段）。
- 不声明 production alias/device identity、Gate、release、acceptance。

## 执行结果（2026-09-01）

- **离线段：OFFLINE_PASS**。probe 全绿：lab 15/15（含 Medium shell 集成启停）+ `fast-operator-auth`/serve-dispatch 4/4 + fusion verify PASS（allowlist 增补 3 个 lab 文件、relay 删除清零 extra）+ CP check-js（含 lab/）317 文件 + secret-scan PASS。
- 落地 commit：`d661c3e`（lab gateway/client/tests/胡姬花 pack/清理）+ `cb1adda`（relay 删除）。
- 已知非本计划范围的预存失败：CP 全量 suite 中 65 个与本入口无关的预存失败（evidence-store/ACL/verifyConstraint 等，HEAD 上即失败，未改动其代码）。
- **真机段：未执行（WP5 硬停）**。无任何流量发往 17895/17897，未占用/未杀 17920/17930。live smoke 待操作者逐段授权。