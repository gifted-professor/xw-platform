# XHS Routine V3 — Gate-F 钻井 + 真机推进计划（R0→RPA）

Date: 2026-08-31
Status: active / next-up
Base: worktree `codex/xhs-routine-v3-impl` @ `b0a3e8f`（release I `xw-xhs-v3-r03-b0a3e8f91e65` 已 QUALIFIED）
Frozen parents:
- `docs/plans/xhs-routine-v3-free-exploration-plan-v2.md`
- `docs/plans/xhs-routine-v3-execution-addendum-v1.md`（split gate：P4A→P5→R0→R1→R2→E-Corpus→R3/R4→P7）
- `docs/plans/m6-4-fresh-production-assembler-entry.md`（三固定入口 + Gate-F FINAL 验证）
- `docs/plans/m6-4-fixed-qualification-entry.md`（每 release 固定链序）

## 0. 当前状态（起点）

- 资格链两根因已修（f4f3385 §非ASCII + b0a3e8f 数组splat→哈希表splat），10/10+8/8 测试绿
- Release I 全链完成：tcb×2 + package `cde20942…` + legacy×3 + quiesce + rotation（gate `m6-4-gate-f-b0a3e8f`）+ launcher execute + **execute-fixed = QUALIFIED**
- SYSTEM 计划任务 `XW Platform M6 Qualification` 启动的资格 CP 正在 17920 监听（token-gated）
- 已知坑（沿用）：rotation execute 在 finally guard 挂起（DB 已提交，直接杀）；preflight 前 Unregister 旧任务；fence CAS 推进 + events provenance；recover-cp-owner-lock.ps1；quiesce 前用 /tmp/relaunch-topology.ps1 恢复监听拓扑

## 1. Phase A — Gate-F 钻井（零资源，先跑完这个）

目标：完成 addendum/entry 文档要求的机械钻井 `legacy→A, validate A, A→B, validate B, B→A, validate A, A→B final, validate B`。
A 和 B 是两个新 formal release（各走一遍完整资格链 + assembler）。

### 1.1 Release A 生命周期（每个新 release 的固定步骤）

从 worktree 干净提交构建：
1. `node services/control-plane/ops/formal-release-builder.mjs build`（在 worktree）
2. 在 release 副本内依次：
   - `npm run m6-4:qualification-tcb-provision-fixed`
   - `npm run m6-4:qualification-package-fixed -- <releaseId> <sourceCommit>`（记下 packageHash）
   - `npm run m6-4:qualification-legacy-current-tcb-provision-fixed`
   - `npm run m6-4:qualification-legacy-database-tcb-provision-fixed`
   - `npm run m6-4:qualification-legacy-launcher-tcb-provision-fixed`
   - relaunch 拓扑 → `node services/control-plane/ops/m6-qualification-legacy-window-operator.mjs quiesce-fixed <releaseId> <sourceCommit>`（后台，>10min 正常）
   - fence CAS 推进（UPDATE m6_gate_fence expires_at 到过去 + events 行）
   - `npm run m6-4:qualification-rotation-preflight-fixed -- <releaseId> <sourceCommit> <packageHash>`
   - `node tools/m6/m6-4-qualification-bootstrap-rotation.mjs execute-fixed …`（后台；提交后杀 guard）
   - `npm run m6-4:qualification-tcb-provision-fixed`（第二次，强制）
   - Unregister 旧任务 → launcher `preflight-fixed` → `execute-fixed` → `status-fixed`
   - `npm run m6-4:qualification-execute-fixed` → **QUALIFIED**
   - `npm run m6-4:assemble-current-fixed` → assembler receipt（记下 receiptHash，stage-candidate 要用）

### 1.2 Gate-F 切换钻井（gate-f-cutover-operator.mjs，全部从活跃 release 运行）

Release A 就绪后：
1. `prepare-target-fixed <A_releaseId> <A_sourceCommit>`
2. `stage-candidate-fixed <A_releaseId> <A_sourceCommit> <assemblerReceiptHash> <qualificationPackageHash>`
3. `capture-legacy-prestate-fixed <legacyReleaseId> <legacySourceCommit> <A_releaseId> <A_sourceCommit>`
4. `authorize-legacy-bootstrap-fixed <legacy…> <A…> <expectedCurrentAuthorizationSha256>`
5. `preflight-legacy-bootstrap-fixed` → `bootstrap-authorized-fixed`（legacy→A）
6. `validate-final-fixed <A_releaseId> <A_sourceCommit>` → **status=VALIDATED** 才许下一步
7. Release B 重复 1.1 → authorize-transition-fixed A→B → preflight/apply-authorized-fixed → validate B
8. B→A，validate A；A→B final，validate B
9. 钻井全程零资源（无真机 I/O、无社交动作、视觉 permit=0）

验收：每次切换后 active release `validate-final-fixed` 返回 VALIDATED；current/binding/package/receipt 无漂移。

## 2. Phase B — R0 部署夹具（真机阶段入口，仍是零真机 I/O）

按 addendum §5：部署后的 operator/provider/interlock/receipt signer/private loader/evaluator 走 task-owned fake device adapter。证明：设备 I/O=0、live 资源=0、provider digest == P4A/P5、视觉预算=0、E-Corpus 不可伪造。R0 失败则回滚并阻塞 R1。

## 3. Phase C — R1 DUMP-only → R2 shadow（真机，只读）

- R1：[03,04] 正式 CP 波次，DUMP-only 导航矩阵（HOME_FEED/SEARCH_RESULTS/IMAGE_NOTE/VIDEO_NOTE/COMMENT_PANEL），视觉计数器全零
- R2：同矩阵 + 真实 pinned provider shadow 分析（协议/冲突记录），视觉计数器仍全零
- 真机持久约束：社交写传输每轮 ≤2、动作间隔数分钟；CAPTCHA/登录/风控覆盖层即停；连续 2 次导航失败停业务动作

## 4. Phase D — E-Corpus PASS artifact

`xw.xhs.e-corpus-pass.v1`（绑定 release/source/provider digest/corpus hash/status=PASS，生产 key ring 签名）。这是视觉 permit 的唯一解锁输入。

## 5. Phase E — R3/R4 → P7 RPA

- R3：E-Corpus artifact 经 CP 新鲜校验后编译视觉 permit（初始 allowlist：VIDEO_NOTE/PAUSE_VIDEO_SAFE_ZONE，alias 03，全局 issued/physical=1）
- R4：按 addendum 收尾
- P7：RPA manual-once（RECURRING=false），内容先给用户过目后发布

## 6. 风险与回退

- Gate-F 每步 fail-closed；A receipt 不能满足 B（source-pinned root）
- 任何 live 阶段失败：不扩预算、不换 lane、不重试 raw action，按 addendum 停波
- rotation guard 挂起属已知噪音：确认 DB 提交（fence gate_id 变更）即继续
- 本机调试遗留：qual-* 临时文件已清理；debug 计划任务已 Unregister

## 7. 立即下一步

从 §1.1 开始构建 Release A。A/B 只需代码不变（同一 commit 即可——A/B 是同一 release 的两个槽位轮换？否——A、B 各自是独立 formal release；若代码无变化可用同一 commit 构建两个 release 副本，链序各自完整走一遍）。
