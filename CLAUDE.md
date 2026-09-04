# CLAUDE.md

## 主线定位（2026-09-04 定调）

**主线 = XHS 业务链路**：飞书任务 → 采集 → 提取 → 发布 → receipts 沉淀（orchestrator + recipes + receipts）。

M6-4 正式部署链（Gate F / TCB freeze / owner lock / control-plane 套件）是**封存的可选基础设施**，不在关键路径上；其 CI 步骤已降级为非阻断（a5e3bbf）。不要为 M6 的测试/部署机器消耗主线时间；解封需操作者明确要求。

## 日常迭代节奏

1. 业务改动落在 `services/orchestrator`（`ops/`、`scripts/lib/`、`tests/`、`contracts/`）
2. 新增/修改导入边界文件时：`node tools/fusion/cli.mjs verify` → 把 drift 路径抄进 `docs/fusion/post-import-allowlist.v1.json`（机械登记，一两分钟）
3. 动到 control-plane grounded-run 闭包 import 时（罕见）：`node tools/m6/m6-4-freeze-grounded-tcb.mjs --write` 重封
4. push main → CI 绿即完成。**唯一必须绿的测试门**：`npm run test:orchestrator`；M6 相关步骤红了只报警告、不拦 merge

## live 红线（不变）

- 每轮写传输 ≤2 次、动作间隔数分钟（风控约束）
- 发布内容必须先给操作者过目；正式发布（草稿→发布）前确认 04 号机账号限制已解除，或改走 03
- 设备/机队操作遵循 `services/orchestrator/AGENTS.md`（冷启动协议、设备红线、留痕契约）