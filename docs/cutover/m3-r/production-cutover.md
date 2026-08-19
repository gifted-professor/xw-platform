# M3-R4 落地记录：生产 Runtime Source Cutover（2026-08-19）

> 执行分支：`ops/m3r-production-cutover`。事实源是同目录四份新 receipt（JSON），本文只是人读摘要。

## 结果

```text
LIVE_CANARY_GATE    = PASS
RUNTIME_CUTOVER_GATE = PASS
```

现场两个服务现在唯一运行来源是 `xw-platform` release `xw-20260819-f337079`（main `f337079`）：

| 服务 | 端口 | 进程来源 | 拉起方式 |
|---|---|---|---|
| Control Plane | 17920 | `xw-runtime\releases\xw-20260819-f337079\services\control-plane\...` | 计划任务 `XW Platform Control Plane`（BootTrigger, SYSTEM） |
| Orchestrator | 17930 | 同 release `\services\orchestrator\registry.mjs` | 计划任务 `XW Platform Orchestrator`（BootTrigger, SYSTEM） |

两个 health 的 `sourceRepo/sourceCommit/releaseId/runtimeProfile` 四元组全等，均为 `legacy_compat`。

## 状态迁移

- `registry.db` → `xw-runtime\state\orchestrator\`（uv=0，hash 与 snapshot 全等）
- `control.db` → `xw-runtime\state\control-plane\`（uv 15→18，与 rehearsal 一致）
- evidence/runs → `xw-runtime\evidence`；日志 → `xw-runtime\logs`；秘密（设备配置、orchestrator token 启动器）→ `xw-runtime\secrets`（ACL：SYSTEM+Administrators）
- `xw-runtime\current` 是指向 release 的 junction

## 回滚单元（随时可用）

旧代码目录原样 + `xw-runtime\rollback\final-20260819\snapshots` 双 DB（integrity ok）+ 旧任务定义（`XhsDeviceRegistry` Disabled 未删）。步骤见 plan.md §十二。

## 执行中的偏差与踩坑（如实记录）

1. **junction 不能直接当 node 主模块路径**：node realpath 主模块导致 `import.meta.url !== argv[1]`，服务静默退出。launcher ps1 先解析 junction 真实路径再启动。R3 proposed-tasks XML 因此未直接注册，仅作设计记录。
2. **PS 5.1 无 BOM UTF-8 脚本被当 ANSI 读**：launcher 中文注释导致解析错乱，已改全 ASCII。
3. **新 SYSTEM 任务对非提权查询不可见**：`Get-ScheduledTask`/`schtasks` 非管理员查不到；提权查询与 XML 导出确认存在且 Running。
4. **真实 legacy job 未试跑**：任何 device capability 都可能触达 ADB/22222，保守跳过并如实记录；只读 canary 全链路（health/inventory/observe/session/job 读取/evidence/release）通过。
5. 支付红线用 release 代码内 fail-closed 探针验证（credential→wait_human_commit、final commit→wait_human_commit、不可判定→拒绝/抛错），未执行任何真实支付。

## 留给后续（M3-R5/R6 范畴）

- `XhsScoutScout`、`XhsXwEvolveWorker`、`XhsFastOperator0*` 等既有任务仍引用旧目录（见 `legacy-reference-scan.v1.json`），本次未动。
- 旧 checkout 退役（改名只读、GitHub archive）需稳定期后执行。
