# M6-4 Plan Review Context V1

状态：`FROZEN_REVIEW_CONTEXT`  
评审模式：`PLAN_REVIEW`  
风险候选：`CRITICAL`  
评审授权：`fix-once`（只允许依据本轮裁决生成一次 Plan V2；不授权实现或 live action）

## 1. 原始请求与授权边界

用户提供 M6-3 候选完成状态，要求开始规划 M6-4，并显式指定 `multi-model-review-gate`。本轮只允许：

- 核验 M6-3 交接事实；
- 制定 M6-4 可执行计划；
- 对冻结的 Plan V1 做同包外部评审与 GPT 裁决；
- 若达到就绪条件，生成并验证执行契约、给出执行路由建议。

本轮不允许：实现代码、push/merge、部署、mint/activate gate epoch、启动 DSH live profile、连接/操纵真机、产生外部动作、修改历史收据或清理用户 scratch。

## 2. 冻结评审对象

- 主 artifact：`docs/plans/M6-4-single-alias-grounded-action-plan-v1.md`
- 本 context：`docs/plans/M6-4-plan-review-context-v1.md`
- 两位外部 reviewer 必须收到完全相同的 artifact/context bytes；禁止按 reviewer 定制上下文。
- 排除项：完整日志、数据库、sessions、`node_modules`、credentials、API keys、设备 token、`.m6-3-spike/`、根 `profiles/` 及任何 raw coordinate/evidence payload。

## 3. 已核验的 M6-3 基线

Git 身份：

- 分支：`codex/m6-3-dsh-replay`
- commit：`0fa5ae7f366bf40da242bec824882658fc6596d4`
- tree：`b91619930acbfaea218a6d3319eb8da38ad04732`
- parent / 当前 `origin/main`：`80355d341d854212045c6c1ec62daffbaf3de766`
- candidate worktree tracked diff：0；无 upstream/remote branch。
- candidate worktree 存在未跟踪 scratch：`.m6-3-spike/` 约 29,590 files / 213 MB，根 `profiles/` 4 files；必须原样保留且不得进入 M6-4 分支、评审包或提交。

外部审计 artifacts（位于 `C:/Users/Public/xw-runtime/m6-audit/`）：

| artifact | SHA-256 | 结论 |
|---|---|---|
| `m6-3-completion-receipt.json` | `fa143729fb6e08cbce9c2082802b840efe4c1488662215b01b58ad9daeda3a3f` | `M6_3_CLOSED_READY_FOR_M6_4_PLANNING` |
| `multi-model-execution-completion-m6-3.json` | `eca21f4c1b9c4c761ecba0871cf8894aef2239827e5a44ee71d88cfc12b40c27` | execution contract validator pass |
| `m6-3-gate-manifest.json` | `5812c3608423c3a2665672188629f31dbe57dc74884888d61562c3e78fdbb4d1` | gate remains CLOSED |
| `m6-3-review-adjudication.json` | `21001eef1542e12d1741755714234fa40c7690d9fba4ca9b85aed3a34c727839` | fallback adjudication; open blockers 0 |

交叉核验：completion receipt 引用的 23/23 artifact hashes 匹配；execution contract 在本机重新验证通过。M6-3 指标为 40 warm ACK、p95 7.27 ms；20 happy + 5 replan + 5 hardstop；13 fault cases；残留进程树 0；M6 121/121；M6-2 offline 108/108；epoch 66 pass + 1 Windows symlink platform skip；orchestrator 527/528，唯一失败为无关且窄化记录的 Windows symlink `EPERM`。该例外不得泛化为 M6-4 豁免。

M6-3 的所有 tool result 均为 replay、`externalEffect=false`、`actionCount=0`。gate、live actions、cutover 均未开启。评审 wave、单次 fix batch 与 repair tail 已消费完毕；M6-4 是新的 planning/review unit。

审计注记：completion `generatedAt` 约早于 candidate commit 82 秒，但 artifact mtime、Git identity、hash closure 均正确；保留为 provenance 注记，不改写原 receipt。

## 4. M6-2 与任务账本约束

- canonical 父 receipt：`m6-2-w9-completion-4ea1fa60.json`，file SHA-256 `7d6910c59656ba173869ff6454837c4bd0061eb6e24ebb50e165c01d6964bbbb`；M6-2 为 CLOSED final，merge commit `80355d341d854212045c6c1ec62daffbaf3de766`，release `xw-m6-2-w9-80355d3`。
- 该 receipt 明确 supersede `m6-2-w9-completion-53678313.json`（file SHA-256 `9c3464ae6a65057dbcb29c19af85b5a62abd0bea2420b5e4fd190f8b8fab249a`），原因是旧 receipt 绑定 5038 execution 且缺失 tombstone/dbPath evidence；旧 receipt 只能作为 denylisted lineage，不得用于开放 M6-4。
- canonical final closure：observe epoch `4ea1fa604e11d58592618ae40182deb277401a7ea7a921a039d8e459260c5887`，CLOSED epoch `481efc38a3f4e349af9dbe82eafc758d621ee04aebfe8d2ef1d0a420acd5fe22`，aggregate seal `3c2543abe7866128aad20e66592b74647a38e98110884c714c23fb4e7e071cbe`，closeout `18c11af160a965fddcfd786cd4ae51ba98bf97fe7555982f52f177db9f655e09`。
- 80 attempts：76 accepted，4 focus unstable；全部资源归零、actionCount=0。
- ADB 5037 固定 4 devices；ADB 5038 为 0；被 5038 supersede 的 epochs 已 tombstone。
- 任务账本中 53 complete、54 in_progress；M6-4 不擅自结清 task 54。若其真实 scope 与本计划冲突，Gate A 必须停止并重新定界。
- M6-2 aggregate verifier 的四 alias × 20、zero-action 语义是历史硬门，不能为 M6-4 action canary 放宽；M6-4 必须新增独立 action aggregate。

## 5. 仓内已核验事实与缺口

1. Gate schema/runtime 当前只认识 `CLOSED` 与 `OBSERVE_ONLY`；M6-4 需要新增窄化 action mode、mode-specific closure/locks，同时保持旧 epoch 可验证。
2. M6-3 DSH plugin/tool loop 是真实子进程，但 GroundingRuntime、journal 与 action 都是 child-local replay/synthetic；不存在 child→Control Plane live action broker。
3. 当前 live visual provider 不存在；M6-1/M6-3 provider 均为 hermetic/synthetic。不能把 replay 成功描述为 live-ready。
4. 当前 GroundingRuntime issued/consumed decisions 只在进程内 Map/Set；live one-shot permit 必须进入 durable authority，并与 Action Ledger 原子协同。
5. M6-2 frame capture 是 one-shot session/lease，accepted frame 返回前会释放资源；M6-4 observe→act→verify 需要 bounded same-lease run，但不得改变 M6-2 公共 route 的既有行为。
6. Control Plane 已有 `device_session_actions` Action Ledger 与 reserve/update API；startup 会把 in-flight 视为 `AMBIGUOUS`。应复用其设备事实语义，不创建第二本 ledger。
7. 仓内 `EffectCommitProtocol` 已表达 reserve→recheck→start-before-I/O 原则；M6-4 可复用原则，但不得沿用 non-payment soft-debt 处理未知设备动作。
8. M6-3 live tool surface 尚不存在；十个 replay tools 的输出被固定为 no-effect。live/replay profile 与 schema 必须分版，不能原地改写历史 replay。
9. Control Plane 当前没有公开 M6 action route；legacy raw coordinates / `explorer-primitive` 不得成为 M6 公共路径。
10. `docs/plans/M6-3-handoff.md` 仍描述旧 Gate A-only 状态，与外部 final receipt 冲突。M6-4 首个文档任务应增加 final completion index，保留历史文件但消除入口歧义。
11. 根 worktree 当前不是 candidate commit，且有用户未跟踪内容。实施必须先合入 M6-3，再从更新后的 main 创建新的干净 worktree。
12. Control Plane `CURRENT_CONTROL_SCHEMA_VERSION=18`；`StateStore.transaction()` 使用不可嵌套 `BEGIN IMMEDIATE`，而现有 action reserve API 自带事务。ledger+permit+auth 原子协同需要 v18→v19 additive migration、no-transaction private SQL helpers 与 combined APIs。
13. 既有 Action Ledger 权威状态是 `REQUESTED/ASSESSED/EXECUTING/EXECUTED/VERIFIED/COMPLETED/BLOCKED/AMBIGUOUS`，不是 Effect Ledger 的 `NOT_SENT/STARTED`。现有 startup 只把 `REQUESTED|ASSESSED|EXECUTING` 转 AMBIGUOUS，M6 live 还必须处理 result→verify crash 的 EXECUTED/无receipt VERIFIED。
14. capability session只能绑定一个 exact `scope_capability_id`；写 transport authorization origin只允许 `capability_job|mission_device_run`，禁止 session。当前 Xiaowei raw I/O仍可由 adapter constructor transport执行，job TypedTransport underlying invoke尚是 deferred；M6-4 必须建立 composite capability job + true typed M6 adapter path或明确无法过门。
15. GroundingDecision v1 强制 frameId+blockId，无法真实表达 open_app/back/wait/scroll；现有 GroundingRuntime `resolveInternalPoint()`会一步消费decision再产private point。live需要独立decision v2 target union及prepare/consume/materialize split，replay v1不可放宽。
16. Gate v1 `additionalProperties=false`、只含 CLOSED/OBSERVE_ONLY和固定三locks，loader硬载v1；capture receipt v1也只认 CLOSED/OBSERVE_ONLY。action mode、run-frame receipt与locks必须走mixed v1/v2 dispatch，不能原地改enum。
17. 当前 gate promote是文件 `current.json` 原子替换，而 action ledger在SQLite；二者没有共享线性化点。若要求close先发生则transport=0，plan必须引入共享send/gate fence或明确更弱的snapshot语义。

## 6. 权威范围与验收口径

`docs/plans/M6-task-brief.md` 的 M6-4 范围要求：

- 模型/公开 action 输入只含 server-issued grounding decision ref 与 operation key；
- 每次动作前做 lease/session/gate/grant/frame/focus/page/redline 等复核；
- 复用 Action Ledger；
- server primitives 固定为 `observe/open_app/back/wait/tap/scroll/type_search_text`；
- alias 01 上完成小红书搜索并打开笔记详情的首条闭环；
- 20 runs 成功率至少 95%；smooth-control suite 至少 90% 无中途人工；正常路径逐动作审批 0；
- payment/delete/misclick/stale/duplicate/public-side-effect 均为 0；每个 action 有完整可重算 trace/receipt。

范围冲突的冻结解释：

- master default PR 把 M6-4/5 合并为 M6-C，但 rollout 又要求先 M6-4 后 M6-5。本计划拆成独立可部署、可回滚的 M6-C1（M6-4）与 M6-C2（M6-5），M6-4 只实现 fail-closed/minimal closeout；恢复与 reconciliation 完整化留给 M6-5。
- smooth suite 要求至少 8 个 action families，而 server primitive 只有 7 个。计划以至少 8 个高层 intent families 映射到冻结的 7 primitives，不新增 raw primitive。
- 仓内冻结 benchmark 的九个 task-level families为 `app-launch/app-switch/search/text-input/scroll/tab-back/form-edit/settings-nav/social-publish-account`。首轮禁止public effect意味着只能选前八个；30-task分布、每类最低数量、无持久mutation语义必须在manifest前冻结，不能把一个搜索流程的微步骤算成八类。
- M6-4 要求 M5 receipt chain，但真正的 `agentic_session` Router/Binder 被明确排到 M6-6。M6-4 只冻结 canary run packet/correlation schema，不伪造 M5 WorkReceipt；实际接线留给 M6-6。
- 现有 policy 文档对社交/发布/账号动作仍要求逐项确认。首轮 canary 只允许 search/open-note 等无公开副作用任务；任何关注、点赞、收藏、评论、发布、消息、账号或支付/删除动作均不在本计划。
- M5 trace 延期与 M6-C拆分都是权威 scope amendments，不是实现细节。本计划把它们命名为 A01/A02，并要求 owner decision + task brief cross-reference；未获接受时只能 `SCOPE_CHANGE_REQUIRED`。

## 7. 必须由计划覆盖的失败边界

- exact live model/provider 不可用或 5 秒 frame TTL/SLO 无法满足；
- broker capability 泄漏、跨 process/run/session/alias 重放或 DSH 获得 raw authority；
- gate/release/lock drift、hot close 失败、旧 epoch 兼容性破坏；
- logical-action claim、permit、ledger、typed auth、gate fence 或final receipt非原子；双consume；跨run新key；同key异decision、同decision异key；send fence后自动重试；
- crash/kill发生在三次事务、TypedTransport consume callback、materialize/counter、I/O、result、verification、closeout的每个间隙；
- CAPTCHA、登录挑战、风控、敏感 icon/string、empty dump、focus/page drift、provider/oracle drift；
- Windows/Linux process-tree cleanup、symlink/junction/path escape、secret/raw-coordinate leakage；
- M6-2/M6-3 历史 replay/zero-action contract 被弱化。

## 8. Reviewer 问题

### Coverage reviewer

判断 Plan V1 是否：覆盖所有权威验收条件；依赖关系与 Gate A–F 顺序可执行；测试/证据有判别性；文件面、双平台、rollout/rollback、M6-3/M6-2/M6-5/M6-6 边界完整；是否存在会阻断 CODE_READY_GATE_CLOSED 或另行授权的 live completion 的遗漏。

### Safety reviewer

重点攻击：授权与 raw authority 隔离；pipe-possession broker的明确TCB边界；gate/epoch/DB-fence closure；same-lease capability job lifecycle；logical-action global claim；permit/ledger/auth/final receipt 三次原子事务；TypedTransport单次consume与start-before-I/O；idempotency/replay/concurrency/crash semantics；counter-based unknown outcome；provider provenance；redline/public-side-effect 边界；secret/path/process cleanup；是否存在 P0/P1 安全或一致性缺口。

## 9. 裁决标准

- `P0/P1`：会使 live effect 越权、重复、错设备/错页面、不可审计，或使实现无法达到冻结 DoD；必须在唯一 Plan V2 中修复，否则 `SCOPE_CHANGE_REQUIRED`。
- `P2/P3`：不阻断安全执行的改进，进入 backlog，不借机扩大本轮范围。
- 外部 reviewer 是顾问；GPT 必须逐条 `ACCEPT/REJECT/DEFER` 并给出证据。不得伪造截断或失败的报告。
- 只有 Plan V2 无开放 P0/P1、执行契约验证通过且路由结果明确时，才可标记 `READY_FOR_EXECUTION`。这仍不代表用户授权执行或 live canary。
