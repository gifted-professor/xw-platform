# XHS Lab 只读极速入口 — Quick Start（lab-only，离线已 PASS）

上游计划：`plan-v2.md` + `execution-contract.json` + `execution-route.json` + `xhs-lab-readonly-fast-entry-executable-plan.md`。
本页只描述已落地的 lab 只读入口；**不授予任何真机操作授权**。

## 声明（必读）

- 状态声明上限：`LAB_READ_ONLY_SLOT_REACHED`。不声明 production alias/device identity、Gate、release、acceptance。
- 只允许 `focus` 与 `dump`。tap/scroll/input/like/comment/publish/DM/ADB/22222 等一切转发在 gateway 处 fail closed（mutation probe 保证 spy=0）。
- `dump` 可能触发设备侧 `/sdcard/fo-dump.xml` 副产物（FO 兜底路径）；gateway 不落盘、不收编 raw dump/UI XML。
- 端口：17920（FO 兼容 authorize/leases/health）+ 17930（agent-entry.md/JSON/health）。被占用即 fail closed，**绝不杀占用进程**。
- 双 token：client token（首次启动生成于 Git-ignored `.xw-lab/`，CLI 必带）；operator token（每操作随机、仅内存 + FO header，永不回显/落盘/收据）。
- Lease 状态机 fail-stop：`PENDING → AUTHORIZED → IN_FLIGHT → RELEASED`；client deadline **不**释放 lease（`IN_FLIGHT_UNCERTAIN` 需人工经 status 复查）；无自动恢复。
- 全程零 UAC、零 SYSTEM task mutation、当前用户 Node、Node 标准库 only；不使用 `XHS_ALLOW_BYPASS`。

## 操作序列（普通 Medium shell，工作目录 = repo 根）

```bash
# 1. 启动（后台、当前用户；17920/17930 被占则 PORT_OCCUPIED 退出码 2）
npm --prefix services/control-plane run xhs:lab:start

# 2. 查看入口声明与活动 lease（只读）
npm --prefix services/control-plane run xhs:lab:status
#    agent-entry 明文：curl http://127.0.0.1:17930/agent-entry.md

# 3. 只读动作（需另行操作者授权后才可在真机执行）
npm --prefix services/control-plane run xhs:lab:focus -- 01
npm --prefix services/control-plane run xhs:lab:dump -- 01 [label]

# 4. 回滚 = 只停 gateway（FastOperator 01/02 与其余一切不动）
npm --prefix services/control-plane run xhs:lab:stop
```

slot 语义：`01 -> 127.0.0.1:17895`、`02 -> 127.0.0.1:17897`；lab deviceId 固定 `lab-slot-01|02`（非生产 identity）。

## 离线验证（已 PASS）

```bash
npm --prefix services/control-plane run test:xhs-lab   # 15/15（含 medium-shell 集成）
node --test tests/fast-operator-auth.test.mjs tests/fast-operator-serve-dispatch.test.mjs  # 4/4 保持绿
npm --prefix services/control-plane run check          # check-js（含 lab/）+ secret-scan
```

## 边界与生产模块

- 本入口与生产 router/state-store/DB/qualification/rotation/Gate-F 零 import（负向扫描在测试里持续把关）。
- M6 qualification / relay / rotation / recovery 模块为 **production-only dormant**：不删除、不在本入口引用，仅供生产恢复路径使用。
- 本轮已按计划删除 `services/control-plane/ops/m6-qualification-emergency-relay-a-fixed.mjs`。

## 硬停

离线 PASS 后本轮到此为止。真机 smoke（slot 01 focus → dump，验收 lease=0、零 UAC）需操作者另行逐段授权；回滚仅停 gateway。