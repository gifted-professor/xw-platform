# xw-platform

XW Platform 唯一源码主线（独立仓，非 fork）。自 2026-08-19 起也是**唯一生产运行来源**：现场 17920（Control Plane）/ 17930（Orchestrator）由本仓 release（`xw-20260819-f337079`）驱动，两个旧仓（`xhs-registry`、`xhs-device-agent`）已在 GitHub archive 只读，本地旧 checkout 已改名为 `*-retired-20260819` 回滚工件。

**新 agent / 新人先读 [`docs/handoffs/HANDOFF-2026-08-20-post-m3r-m4-first-live.md`](docs/handoffs/HANDOFF-2026-08-20-post-m3r-m4-first-live.md)**。根 [`HANDOFF.md`](HANDOFF.md) 只做索引，过程段可能过时。

## 这个仓是什么

一套「技能感知的多设备任务编排系统」的源码 monorepo：用户 Goal → Skill 路由 → 并行计划编译 → 多 Worker / 多手机执行 → 汇总去重 → 交叉验证 → 全链路落账。目标是让多个 Agent 并发控制多台手机，同时每个任务、Shard、设备、动作、证据都可追溯。

当前真实进度要分开看两层：

- **源码层（main）**：已含 M4-A~D——Skill 合同、Harness Protocol（DSH 桥）、Skill Router + Experience Ledger、Execution Plan Compiler（`SkillParallelismSpecV1` / `ExecutionPlanV1`）。
- **生产层（现场）**：仍跑 2026-08-19 切换版 release，`runtimeProfile=legacy_compat`。M4 源码**尚未部署**，live 能力门全部关闭。

## 不要误解为

- ❌ 双跑期还没结束（没有双跑，旧系统已退役）
- ❌ Agent 已可直接控制手机（Open Action live / DSH / Multi-Agent 仍 CLOSED，支付仍人工硬闸）
- ❌ main 上的 M4 代码已经在生产生效（没部署，也不许默默部署）

## 目录结构

```text
services/orchestrator/     编排服务（goal / task / mission / knowledge，端口 17930）
services/control-plane/    控制面（device / lease / job / transport / 支付闸，端口 17920）
packages/kernel/           共享内核 + M4-A Skill 合同与运行时
packages/harness-protocol/ M4-B Harness 协议（DSH 锁版本桥接在 integrations/dsh-xw）
packages/skill-router/     M4-C Skill Router + hybrid pack
packages/experience-ledger/ M4-C 经验账本（facts / patterns / snapshots）
packages/plan-compiler/    M4-D 并行合同 + Execution Plan 编译器
packages/agent-gateway/    Agent 网关（live 门仍关）
packages/cli/              xw CLI（packages/cli/xw.mjs）
integrations/dsh-xw/       DeepSeek Harness 插件（锁 rc.7 commit，禁跟 master）
tools/fusion/              合仓验证、source-lock、test-gate、authority 检查
docs/architecture/         架构与边界合同
docs/handoffs/             接手文档（权威进度在这里）
docs/fusion/ docs/cutover/ 合仓与 M3-R 切换证据链
```

无 npm workspaces；根 scripts 只做转发与 `node --check`。

## 常用命令

```bash
npm run check          # 双服务 check + 全部源文件语法检查
npm run fusion:verify  # 合仓完整性 / source-lock
npm run authority      # 权威边界检查
npm run kernel:check   # 内核合同检查
npm run test:kernel    # kernel 测试
npm run m4a:accept     # M4-A Skill 验收
npm run test:m4b       # Harness Protocol + crash/resume
npm run test:m4c       # Skill Router
npm run test:m4d       # Plan Compiler
npm run test:gate      # 双服务测试门（对照 docs/fusion/test-baseline.v1.json）
```

离线 CI：`.github/workflows/source-fusion.yml`（ubuntu + windows 双平台）。

## 治理门

| 门 | 状态 |
|---|---|
| `SOURCE_FUSION_GATE` | OPEN |
| M3-R 六门（SOURCE/REHEARSAL/ROLLBACK/LIVE_CANARY/RUNTIME_CUTOVER/LEGACY_RETIREMENT） | 全部 PASS（2026-08-19，证据 `docs/cutover/m3-r/`） |
| `OPEN_ACTION_LIVE` / `DSH_LIVE` / `MULTI_AGENT_LIVE` | **CLOSED**（各自独立门，源码合入不自动打开） |
| 支付 | `paymentCredentialRequiresHuman=true`，final-commit 必须人工 |

## 里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| F1-B~G | 骨架、导入双服务历史、验证工具、Physical Fusion 验收 | 完成 |
| M3-EH | Open Action Runtime v1（fixture/replay） | 源码完成（PR #14）；live 仍关 |
| M3-R | 运行时来源切换 + 旧系统退役 | 完成（PR #18–#23，六门 PASS） |
| M4-A | Skill Contract + fixture SkillRun | 已合并（PR #24） |
| M4-B | Harness Protocol + DSH State Bridge | 已合并（PR #25）；真机仍关 |
| M4-C | Skill Router + Experience Ledger + xhs.collect hybrid pack | 已合并（PR #26） |
| M4-D | Skill 并行合同 + Execution Plan Compiler | 源码完成（PR #29，待 review） |
| M4-E | Registry/Router/Ledger 接服务层 | 待启动 |
| M5 | Fleet Graph Runtime（多设备 Fan-out/Join） | 待启动 |

红线速记：合并一律 **merge commit 禁 squash**；禁止无 lease 碰机；禁止直写 `control.db`；DSH 锁死 `deepseek-harness@0.1.0-rc.7`（commit `99f6f02f…`）；Compiler 只出 CANDIDATE，永不自动晋升。完整红线见接手文档 §7。

## 更多

- `docs/architecture/skill-runtime.md` — M4-A Skill 合同
- `docs/architecture/harness-protocol.md` — M4-B Harness Protocol
- `docs/architecture/skill-router.md` — M4-C Router + Experience Ledger
- `docs/architecture/target-layout.md` / `runtime-boundaries.md` / `authority-boundary.md` — 目录目标与边界不变量
- `docs/fusion/` — 合仓合同、source lock、导入收据
- `docs/cutover/m3-r/` — M3-R 切换全案证据（已完成）
