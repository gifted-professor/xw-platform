# M6-1 / PR M6-A 实施计划：离线 Grounding Runtime 与 replay corpus

> 派发基线：`origin/main@f37b19f`（PR #37 已合，M6-0 PASS）。本计划只实施 M6-1，零 live、零真机、零 DB/release 变化。
> 任务书依据：`docs/plans/M6-task-brief.md` §M6-1 与 §5 合同、§9 测试门、§11 阻断条件。
> 复核结论：M6-0 PASS，M6-1 READY_FOR_EXECUTION。支付/删除保持硬拒绝；非红线路径零逐动作审批。

## 0. 前置与纪律（不可违反）

1. 从最新 `origin/main@f37b19f` 创建干净 worktree，分支 `codex/m6-a-grounding-runtime`。**不在**当前 dirty root（`db8885e`）或已合 M5/M6-0 worktree 上开发。
2. M6-1 保持零 live：不碰真机、不翻 `M6_AGENTIC_LIVE_GATE`、不改 DB schema、不发 release、不把 `agentic_session` 加入可执行 enum。
3. 支付/删除保持系统级 hard-deny，grant 无法放行。非红线路径零逐动作审批。
4. 机器外视觉资产不得在许可未核实前导入或计入 corpus。DSH SDK/许可证可在 M6-1 期间继续核实，但未解决不进入 M6-3。
5. 不增加 npm workspace 或新 service；不直写 `control.db`/`registry.db`；不使用 squash，PR 用 merge commit，可独立回滚。
6. 每个 PR 至少跑：`check`、`fusion:verify`、`test:m6`、`test:orchestrator`、`test:m4b/c/d`、`test:kernel`、`kernel:check`、`authority`；Ubuntu/Windows 双平台硬门。

## 1. 现状基线（已核实）

- **M6-0 已交付**：10 个 kernel schema（`packages/kernel/contracts/orchestration/m6/*.schema.json`）+ `services/orchestrator/scripts/lib/m6/{m6-contracts,m6-autonomy-grant,m6-hard-redline,m6-tool-surface}.mjs` 纯函数 validator + 5 个 contract 数据文件（vision-inventory / visual-assets.lock / dsh-inventory / autonomy-benchmark 102 task / smoothness-slo）+ `tools/m6/{external-path-guard,dsh-inventory-check,generate-autonomy-benchmark}.mjs` 静态门 + `test:m6` 硬门已接 CI。
- **三个机器外兼容例外**（`vision-inventory.v1.json` 标注 `removeBy: M6-1`）：
  - `xw-locator`（`ops/xw-locator.mjs`）：默认解析 `C:\Users\Public\xhs-registry-visual-tap\experiments\visual-tap-resolver` + `.venv-ocr/.venv` Python + `visual_tap_demo.py`，调 `vision-pack`/`select` 子命令产出 `vision-pack.json`/`blocks.json`。
  - `xw-start`（`ops/xw-start.mjs` + `scripts/lib/xw-start.mjs`）：预检引用同一 resolver 根 + `.venv-ocr` python 做 OCR 可用性检查。
  - `wechat-ocr`（`scripts/lib/wechat-balance-extract.mjs` + `wechat-balance-ocr.py`）：PaddleOCR 余额提取，默认 `…\visual-tap-resolver\.venv-ocr\Scripts\python.exe`。
- **external-path-guard**（`tools/m6/external-path-guard.mjs`）：扫 `services/orchestrator`、`packages`、`integrations` 下源码的机器外绝对路径；每条 `(file, literal)` 必须在 `vision-inventory.v1.json` 的 `externalPathBaseline[]` 登记，否则 `EXTERNAL_PATH_GUARD_FAILED`。**清零三个例外 = 从 baseline 删除对应 literal，并改源码使其不再引用这些路径。**
- **合同约束**：`GroundingRuntime` 必须产出符合 `xw.screen-frame.v1`（frameId = sha256("…:manifestSha256")，稳定/非 partial/非 missing）、`xw.visual-block-set.v1`（blockId = sha256("…:" + {frameId, stableIndex, regionHash, label, category})，integritySha256 覆盖全 block 元数据 + segmentation）、`xw.grounding-decision.v1`（ALLOW_ONCE 带 derived groundingDecisionId；支付/删除→HARD_STOP；degraded check→REPLAN）的文档，且复用 M6-0 的 `m6-contracts.mjs` 派生函数与 validator。
- **风格**：纯函数、零第三方依赖、`node --test`、validator 返回 `{ok, errors}` 不抛错；fixture-driven；Windows/Linux 一致靠 LF-normalized hash。
- **CI**：`.github/workflows/source-fusion.yml` matrix `ubuntu-latest / windows-latest`，`fail-fast: false`；`test:m6` 是硬门（4 分钟超时）。
- **fusion allowlist**（`docs/fusion/post-import-allowlist.v1.json`）：M6 新文件走 `services.orchestrator.allowedExtra`；`runtimeCutoverAllowed=false`。新增文件必须登记否则 `fusion:verify` 失败。

## 2. 设计：唯一 GroundingRuntime 接口

新增 `services/orchestrator/scripts/lib/m6/m6-grounding-runtime.mjs`（纯函数 + 可注入 provider，零设备 IO）。这是 M6-1 的**唯一真源**；`xw-locator` 退化为调用它的诊断 CLI。

### 2.1 接口形状

```js
// provider 注入：CI 用 hermetic fixture provider；真实 provider 留给 M6-2/3
createGroundingRuntime({ provider, evidenceStore, policy, expectedPolicySha256 })

runtime.freezeFrame(observeInput) -> { ok, frame, errors }
  // observeInput: { screenshotA, dump, focus, screenshotB, linkage, capturedAt, ... }
  // 计算 A/B sha256、page/focus fingerprint、稳定性判定、manifestSha256、frameId
  // 不稳定/partial/missing => fail closed，不产出 actionable frame
  // 复用 m6-contracts.deriveFrameId / validateScreenFrame

runtime.segmentBlocks(frame, { provider? }) -> { ok, blockSet, errors }
  // blockId 由 frame hash + stableIndex + regionHash 派生（唯一算法，与 provider 无关）
  // boundsRef 只进 evidenceStore，模型可见输出不含坐标
  // integritySha256 覆盖全 block 元数据 + segmentation provenance
  // 复用 m6-contracts.deriveBlockId / computeBlockSetIntegritySha256 / validateVisualBlockSet

runtime.decide({ frame, blockSet, blockId, intent, grantRef, goalRef, stepRef, effectClass }) -> { ok, decision, errors }
  // 跑 6 个 check: freshness / focus / ambiguity / safe-region / sensitive-label / confidence
  // 调 m6-hard-redline.evaluateHardRedline 做 payment/delete 多信号拦截
  // effectClass 命中红线或 sensitive-label FAIL => HARD_STOP
  // 其余 degraded check => REPLAN；全 PASS => ALLOW_ONCE + derived groundingDecisionId
  // 复用 m6-contracts.deriveGroundingDecisionId / validateGroundingDecision

runtime.resolveInternalPoint(decision) -> { ok, pointRef, errors }  // 私有，一次性，dispatch 事务内失效
  // 只在 ALLOW_ONCE 时解析；REPLAN/HARD_STOP 不解析
  // 不暴露给模型面；返回 opaque pointRef（boundsRef + 一次性 nonce），坐标只存在于 evidenceStore
```

### 2.2 provider 抽象（可插拔，安全策略唯一）

```js
// provider 只负责"原始视觉信号"：把 screenshot/dump 转成候选 block 原料（label/category/confidence/source/regionHash 素材）
// blockId 生成、安全分类、redline、decision 全部由 GroundingRuntime 唯一算法做，provider 不可覆盖
const HermeticFixtureProvider = { id, version, modelSha256, segment(frame, evidence) -> rawBlocks[] }
// CI 唯一使用此 provider；真实 provider（Cordis/DSH/OCR）在 M6-2/3 接入，但 contract 不变
```

`modelSha256` 用 fixture provider 自身源码的 LF-normalized sha256，保证 Windows/Linux 一致 + 内容寻址。

### 2.3 evidenceStore（内存/落盘，内容寻址）

- 私有附件存：`boundsRef`（block 边界坐标）、`pointRef`（一次性落点）、screenshot/dump/focus 原始 bytes 的 sha256 + ref。
- 模型面**只**拿到 opaque `{id, sha256}`；不拿坐标/pixel/原始 base64。
- CI 用内存版 evidenceStore；落盘版留给 M6-2（`xw-runtime` canonical root，原子写 + hash 校验）。

## 3. xw-locator 收敛为同一 runtime 的代理

改 `services/orchestrator/ops/xw-locator.mjs`：删除 `runtime()`/`run()`/`captureInput()`/`commandPrepare`/`commandVerify` 里对 `visual_tap_demo.py` + `.venv-ocr/.venv` python + `visual-tap-resolver` 机器外根的全部引用。改为：

- `status`：调用 `createGroundingRuntime({ provider: HermeticFixtureProvider })` 报 runtime 可用性、capability、`tapAuthorized=false`。
- `prepare`：调 `runtime.freezeFrame` + `runtime.segmentBlocks`，产出符合 `xw.screen-frame.v1` + `xw.visual-block-set.v1` 的 JSON，artifacts 走 evidenceStore opaque refs。
- `verify`：调 `runtime.decide`，产出符合 `xw.grounding-decision.v1` 的 JSON；`tapAuthorized=false`（trusted live tap permit 仍不实现，M6-0 既有语义保持）。
- `--self-test`：跑 runtime 纯函数自检 + fixture provider smoke；不再 `import cv2,numpy`。
- 删除 `spawnSync`/`process.execPath screenshot-and-analyze.mjs` 截图路径（截图采集是 M6-2 真机职责；M6-1 离线，输入由 fixture/CLI `--input` 提供）。

`foundation-capabilities.v1.json` 的 `locator.visual-block.v1` 条目保持注册（effect=none, directRun=false 不变），只是其实现收敛到同一 runtime。

## 4. 三个机器外例外的清零

### 4.1 xw-locator
- §3 已述：源码删机器外引用，改调 GroundingRuntime。

### 4.2 xw-start
- `ops/xw-start.mjs` + `scripts/lib/xw-start.mjs`：删除 `VISUAL_RESOLVER_ROOT` 默认值 + `.venv-ocr` python OCR 可用性检查。改为调 `xw-locator status`（同一 runtime）报告 vision-pack 可用性；或直接 import `createGroundingRuntime` 做 hermetic smoke。保留 `XW_RUNTIME_ROOT` / `ADB_PATH` 等非视觉路径（那些不是 `removeBy: M6-1` 的例外）。

### 4.3 wechat-ocr
- `scripts/lib/wechat-balance-extract.mjs`：默认 `…\.venv-ocr\Scripts\python.exe` 改为通过 `XHS_PADDLE_OCR_PYTHON` env 显式提供（无默认值）；未配置时 fail-closed 而非回落机器外路径。`wechat-balance-ocr.py` 保持仓内（已是 in-repo 资产）。
- 注意：wechat-ocr 是只读余额 OCR，与 GroundingRuntime 的视觉分块是**不同**链路。M6-1 的收敛目标只是"清零机器外默认路径"（external-path-guard 例外归零），不是把它并入 GroundingRuntime。资产锁 `visual-assets.lock.v1.json` 里 `wechat-balance-ocr.py` 保持 in-repo；`paddleocr-venv-ocr` 保持 external/unverified（M6-1 不解决 PaddleOCR 许可，只清默认路径引用）。

### 4.4 baseline 清零
- `vision-inventory.v1.json`：`externalPathBaseline[]` 删除已清零的 literal 条目（`C:\Users\Public\xhs-registry-visual-tap\experiments\visual-tap-resolver` 及其 `.venv-ocr\Scripts\python.exe` 子路径、`.venv-ocr`/`.venv` 标记中**仅**来自这三个例外的 file 关联）。仍被非例外文件引用的同名 literal（如 `.venv` 仍被 `screenshot-and-analyze`/`recover-main-safe` 引用）从 `exceptionIds` 移除但 literal 保留并 reclassify 为非例外。
- `compatExceptions[]` 的三条 `removeBy: M6-1` 标记完成（保留记录但标注 resolved，或删除——取决于 fusion allowlist 不要求该字段）。`files[]` 里这三条的 `externalPaths`/`externalDependencies` 更新为空/已迁移。
- `visual-assets.lock.v1.json`：`visual-tap-resolver` 资产状态更新（机器外根不再被生产默认引用；保留 external 登记直到资产真正迁移/移除）。

**核心判据**：`npm run --silent node tools/m6/external-path-guard.mjs` 在清零后对这三条例外相关的新源码状态为 `violations=0`；且不再因这三个 file 的旧 literal 而需要 baseline 豁免。

## 5. ≥200 授权、去标识 replay frames corpus

### 5.1 生成器 + manifest
- 新增 `tools/m6/generate-replay-corpus.mjs`（确定性，纯函数，无 Math.random/Date.now）。
- 产出 `services/orchestrator/contracts/m6/replay-corpus.v1.json`（符合 `xw.replay-corpus-manifest.v1` schema，≥200 entries）。
- **全合成**：每帧是 deterministic 合成 screenshot/dump/focus（程序生成的稳定视觉图样 + 合成 a11y/dump 文本），不来自真机截图、不含账号/设备/token/余额。
- `validateReplayCorpusManifest`（已有，递归敏感 key 扫描 account/device/serial/token/cookie/secret/password/balance/credential）必须 PASS。
- 覆盖任务书要求场景：弹窗、键盘、旋转、广告、空 dump、重复块、敏感标签（payment/delete 命中）、滚动前后页面、permission-dialog、status-bar、system-navigation。

### 5.2 corpus 用途
- GroundingRuntime 的 hermetic fixture provider 以 corpus frames 为输入，跑 freezeFrame→segmentBlocks→decide 全链，产出确定性 metrics receipt。

## 6. 确定性 metrics receipt 与 evidence/overlay

- 新增 `tools/m6/grounding-metrics.mjs`：对 ≥200 corpus frames 跑 runtime，产出 metrics receipt（block recall / top-1 / safe-region 命中 / forbidden=0 / misclick=0 / stale=0 / decision 分布 / 每 frame 的 input hash→block set→decision 完全确定）。
- receipt 走 LF-normalized sha256，Windows/Linux 一致。
- overlay/evidence：evidenceStore 可输出 deterministic overlay（block 边界标注，不含原始坐标泄露给模型面；overlay 是诊断/审计产物，落 evidenceStore）。

## 7. SLO 校准与冻结

- 用 corpus + hermetic fixture provider 在本机（Windows runner/alias profile）跑 metrics，测 grounding-decision p95（目标 ≤1s）与 observe-to-dispatch 非模型开销 p95（目标 ≤4s）。
- `smoothness-slo.v1.json`：`hardwareProfile`（具体机型填入）、`modelProfile`（hermetic fixture provider 锁定）填实际值并冻结 `locked: true`；json-rpc-bridge p95（≤100ms）在 M6-1 用 stub bridge 度量（真实 DSH 进程在 M6-3），但 fixture 度量已能证明 runtime 侧不超标。
- 不达标先优化实现，不以人工确认规避。任何阈值调整作为显式计划变更（独立 PR + 更新本文件）。

## 8. 测试（node --test，Windows/Linux 一致）

新增/扩展测试文件，全部加入根 `package.json` 的 `test:m6` 点名 + CI 硬门：

1. `services/orchestrator/tests/m6-grounding-runtime.test.mjs`（新）：
   - freezeFrame：稳定/不稳定/partial/missing/A≠B/expiry/跨 session→fail closed。
   - segmentBlocks：blockId 派生唯一、cross-frame reuse 检测、integritySha256 篡改检测、坐标不泄露给模型面。
   - decide：全 PASS→ALLOW_ONCE+derived id；payment/delete block→HARD_STOP（多信号同义词/图标/空 dump/误分类/伪造 intent）；degraded check→REPLAN；REPLAN/HARD_STOP 不解析 point。
   - resolveInternalPoint：一次性、REPLAN/HARD_STOP 不解析、重复解析失效。
   - provider 可插拔：换 provider 不改 blockId/decision 算法；伪造 provider 不能放行 redline。
   - 确定性：同输入 hash/排序/decision 完全一致（跑 ≥200 corpus frames 断言）。
2. `services/orchestrator/tests/m6-locator-convergence.test.mjs`（新）：
   - `xw-locator status/prepare/verify` 走同一 runtime；不再 spawn python/visual_tap_demo.py；`tapAuthorized=false` 保持；输出符合三个 schema。
   - 源码静态断言：`ops/xw-locator.mjs` 不含 `visual_tap_demo.py`/`xhs-registry-visual-tap`/`spawnSync`(python)/`.venv-ocr` 默认。
3. 扩展 `m6-inventory.test.mjs`：
   - external-path-guard 在清零后 `violations=[]` 仍成立（baseline 已更新）。
   - 三条例外的 `compatException` resolved 标记 / `externalPaths` 清空断言。
   - `xw-locator`/`xw-start`/`wechat-balance-extract` 源码不再含被删 literal。
4. 新增 `services/orchestrator/tests/m6-replay-corpus.test.mjs`：
   - corpus ≥200 entries；`validateReplayCorpusManifest` PASS；敏感 key 扫描 PASS；覆盖要求场景（用 entry kind/notes 断言）；deterministic（重生成 hash 一致）。
5. 新增 `services/orchestrator/tests/m6-grounding-metrics.test.mjs`：
   - metrics receipt 退出指标：block recall ≥98%、top-1 ≥95%、safe-region ≥99%、forbidden/misclick/stale=0；同输入完全确定；Windows/Linux hash 一致（CI 双平台断言）。
6. SLO 度量测试（轻量）：grounding-decision p95 在 fixture 输入下 ≤1s（CI 机器上断言，防回归）。

## 9. 合同/allowlist/CI 接线

- 根 `package.json` `check`：追加 `node --check services/orchestrator/scripts/lib/m6/m6-grounding-runtime.mjs` + `node --check tools/m6/generate-replay-corpus.mjs` + `node --check tools/m6/grounding-metrics.mjs`。
- 根 `package.json` `test:m6`：追加 4 个新测试文件到 `node --test` 列表。
- `services/orchestrator/package.json` `check`：追加新 lib 的 `node --check`。
- `docs/fusion/post-import-allowlist.v1.json` `services.orchestrator.allowedExtra`：登记所有新文件路径（否则 `fusion:verify` 失败）。
- `vision-inventory.v1.json`：登记 `m6-grounding-runtime.mjs` 为新视觉真源（callers、role、sha256、`compatException:false`、`externalPaths:[]`）。
- `visual-assets.lock.v1.json`：新增 hermetic fixture provider 资产（in-repo、repo-internal license、sha256）；更新三个机器外资产状态。
- `.github/workflows/source-fusion.yml`：无需改（已含 `test:m6` 硬门、双平台 matrix）。
- 更新 `docs/architecture/m6-agentic-grounding.md`：补 M6-1 GroundingRuntime 落地状态、provider 抽象、evidenceStore、SLO 冻结值、corpus 指标。

## 10. 退出门（任务书 §M6-1 退出指标）

- block recall ≥98%、top-1 ≥95%、safe-region ≥99%、forbidden/misclick/stale=0。
- 同输入 hash/排序/decision 完全确定；Windows/Linux replay 一致。
- 三个机器外兼容例外清零，external-path-guard `violations=0` 且不再依赖这三条 baseline 豁免。
- `xw-locator` 收敛为同一 runtime 诊断 CLI，不保留独立算法。
- ≥200 授权/去标识 replay frames corpus 通过隐私扫描。
- 确定性 metrics receipt 与 overlay/evidence 产出。
- SLO 在固定 profile 下冻结并达标。
- 双平台 CI 全绿；无 live/device/DB/release 变化；`agentic_session` 未加入可执行 enum；支付/删除 hard-deny 保持。

## 11. 执行顺序（落盘顺序）

1. fetch + 从 `origin/main@f37b19f` 创建 worktree `codex/m6-a-grounding-runtime`；preflight：`npm run check` / `fusion:verify` / `test:m6` 基线全绿，确认 main 漂移未改变责任边界。
2. 先写 `m6-grounding-runtime.mjs`（接口 + hermetic fixture provider + evidenceStore），复用 M6-0 contracts 派生函数；配套 `m6-grounding-runtime.test.mjs`。
3. 写 `generate-replay-corpus.mjs` + corpus manifest（≥200 entries）+ `m6-replay-corpus.test.mjs`。
4. 改 `xw-locator.mjs` 收敛为 runtime 代理 + `m6-locator-convergence.test.mjs`。
5. 清零 `xw-start` / `wechat-balance-extract` 机器外默认路径。
6. 更新 `vision-inventory` / `visual-assets.lock` baseline + 扩展 `m6-inventory.test.mjs`。
7. 写 `grounding-metrics.mjs` + `m6-grounding-metrics.test.mjs`（退出指标 + 确定性 + SLO 度量）。
8. 接线：`package.json` check/test:m6、orchestrator check、fusion allowlist、架构文档、SLO 冻结值。
9. 本地双平台取证（Windows 实跑 + Linux 行为等价断言），开 Draft PR；不翻 gate、不碰真机。
10. 自证退出清单 → review → merge（merge commit，不 squash）。

## 12. 风险与边界

| 风险 | 控制 |
|---|---|
| 改 xw-locator/xw-start/wechat-ocr 破坏既有 ops 行为 | 保持 capability 注册不变；wechat-ocr 只清默认路径不改只读语义；xw-start 非视觉路径不动 |
| corpus 误含敏感信息 | 全合成 + `validateReplayCorpusManifest` 递归敏感 key 扫描硬门 |
| GroundingRuntime 形成"第二套真源" | blockId/integrity/decision 全部复用 M6-0 `m6-contracts.mjs` 派生函数；provider 不可覆盖安全策略 |
| SLO 在 CI 机器上 flaky | 只对固定 fixture 输入断言 p95；不依赖真机/模型；Windows continue-on-error 只针对 control-plane，test:m6 是硬门 |
| fusion allowlist 漏登新文件 | 每加一个文件同步登记 `allowedExtra`；本地 `fusion:verify` 先绿 |
| 清零 baseline 漏删导致 guard 误判 | 删 literal 时同步删源码引用；guard + inventory test 双断言 |

## 13. 非目标（M6-1 不做）

- 不接真机 screenshot A/B（M6-2）。
- 不接真实 DSH/Cordis 子进程（M6-3）。
- 不开 grounded-action 服务端入口（M6-4）。
- 不做 checkpoint/ledger reconcile 故障矩阵（M6-5）。
- 不把 `agentic_session` 接入 TaskPlan enum/binder/worker（M6-6）。
- 不解决 DSH/PaddleOCR 许可证（M6-1 期间继续核实，未解决不进 M6-3）。
- 不把 corpus/overlay 作为机器外资产导入仓库（只进 manifest + 合成数据）。
