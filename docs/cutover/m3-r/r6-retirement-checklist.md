# R6 退役收尾执行清单 — 路线一（务实两段式）

> 唯一执行版本（2026-08-19 批准）。逐步勾选，证据附后。

## 现状基线（已核实）

- 现场：17920/17930 跑 `xw-runtime\releases\xw-20260819-f337079`，LIVE_CANARY_GATE / RUNTIME_CUTOVER_GATE = PASS
- 6 个残留任务已 Disabled；WIP 已备份（`xw-runtime\rollback\legacy-backup-20260819\`，bundle verify ok）

---

## Phase 0 — 8-19（B 块收尾）

- [x] **P0-1 任务状态复核**：6 个残留任务全 Disabled（实查 2026-08-19）；`XW Platform *` 为 SYSTEM 任务，非提权不可见（已知现象，见 production-cutover.md deviations）
- [x] **P0-2 环境变量全扫**：User + Machine + 进程 env 三层 grep `xhs-registry|xhs-routing-v1-1|xhs-device-agent` → **0 命中**
- [x] **P0-3 进程引用复扫**：`Win32_Process` 命令行 grep → **0**（扫描命令自身除外）
- [x] **P0-4 禁用 XhsDeviceControlPlaneV1**：已 Disabled（提权执行，日志 `r6-disable-tasks.log`）
- [x] **P0-5 落库**：本清单 + `legacy-reference-scan.v1.json` 更新（PR 见提交记录）

**Phase 0 出口**：B 块全绿，scan JSON 无 unknown。

## Phase 1 — 观察窗口（8-20 ～ 8-22）

- [ ] **P1-1 每日只读巡检**（cron 每天一次）：`XW Platform *` LastTaskResult=0 / 无重启；两服务 health identity 不漂移；`xw-runtime\logs\` 无新增 ERROR；两 DB integrity_check ok；lease/session 无残留增长
- [ ] **P1-2 真实观察类 job 试跑**（人在场监督，约 30 分钟）：evidence 落盘、job 闭环、无 lease 泄漏、支付硬闸无触发
- [ ] **P1-3 窗口末日统计**：job 成功率 vs 旧基线、无新增关键失败指纹

**出口**：连续 3 天全绿 + P1-2 通过 → Phase 2；异常 → 顺延或回滚评估。

## Phase 2 — 退役 + 关门（8-23）

- [ ] **P2-1 旧目录改名**：`xhs-registry` → `xhs-registry-retired-20260819`；`xhs-routing-v1-1` → `xhs-device-agent-retired-20260819`（前置：进程复扫=0；判据：改名后两服务 health 仍 ok）
- [ ] **P2-2 旧任务处置**：默认继续 Disabled 留档到打 tag 后再删（人定）
- [ ] **P2-3 GitHub 旧仓退役**：README 加迁移声明 → `gh repo archive gifted-professor/xhs-registry` + `xhs-device-agent`（人确认后执行）
- [ ] **P2-4 `retirement-receipt.v1.json`**：引用扫描全零 + 本清单全项状态 + 回滚包清单（bundle / snapshot / 任务 XML / rollback-certification hash）
- [ ] **P2-5 打标签** `xw-m3-runtime-source-cutover`（annotated：source commit / releaseId / cutover receipt hash / DB snapshot hash / rollback certification hash / canary + cutover verdict）并 push
- [ ] **P2-6 关门文档**：HANDOFF.md / README 更新 `LEGACY_RETIREMENT_GATE = PASS`，M3-R 全案关闭

**出口**：`LEGACY_RETIREMENT_GATE = PASS`，plan.md §十三 12 条全满足，M4 可开。

---

## 需要人出面的点

1. P0-4：一次 UAC（8-19）
2. P1-2：30 分钟监督真实 job（8-20～8-22 任选）
3. P2-3：archive 前一句确认（8-23）
