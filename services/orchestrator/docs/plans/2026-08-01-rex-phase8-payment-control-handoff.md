# REX Phase 8 payment control surface handoff

> 状态：`HANDOFF_READY / SOURCE_ONLY / NO_WINDOWS_DEPLOY / NO_DEVICE_ACTION`
> 日期：2026-08-01
> 计划：`REX-FREEDOM-V1`
> 目的：把 `payment pending/list/decide API + Registry 人类确认页` 从 Phase 2 延后到 Phase 8，由后续接手人独立完成。

## 1. 先读结论

这不是把支付硬闸取消，也不是恢复所有任务审批。

- 唯一硬闸仍是“真实资金最终提交”。
- 非支付任务不得因为本 handoff 新增审批、白名单或 Review 前置。
- Phase 2 已经落下资金最终提交的分类、目标绑定、一次性签名批准验证和 fake transport `transport=0` 核心。
- 尚未完成的是：持久化 pending 详情、控制面 list/decide 路由、Registry 代理 API、人类确认页、生产装配与对应离线测试。
- 在 Phase 8 完成这些控制面/人类界面前，资金提交只能安全停在 hold，不能宣称“支付确认流程可用”。
- Phase 7 只允许走到资金最终手势之前，并继续使用 fake/spy 证明 `transport=0`；不得真钱试验。

## 2. 当前两仓冻结点

### A 仓：Mac Review / Registry

- 路径：`/Users/a1234/Desktop/Coding/xhs-registry`
- 分支：`codex/rex-freedom-v1`
- 当前交接前 HEAD：`c461d9f20a2ffef40a27fcfd2cc112e48c4b64d2`
- 已有提交：
  - `1c89e19`：Phase 1 contracts、scope manifest、红灯测试与总计划。
  - `c461d9f`：`xhs.payment-approval.v1` 增加 issuer role/key/allowlist binding。
- 当前未实现：`registry.mjs` 和 `tests/registry.test.mjs` 尚无 payment list/decide/UI 变更。

### B 仓：路由/控制面源仓

- 路径：`/Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-device-agent-routing-v1-1`
- 分支：`codex/rex-freedom-v1`
- 当前 HEAD：`7e7696ea1d31ff6dd2ea345c419ca0be7d394c4a`
- 已有提交：
  - `253c51e`：Phase 1 contracts、fixtures 和红灯测试。
  - `7e7696e`：资金最终提交 tripwire 核心。
- 当前未实现：StateStore payment pending 扩展、ControlPlane 活跃 handle 索引、payment list/decide router/server、生产 bootstrap 装配。

以上 SHA 是交接锚点，不是部署事实。接手前必须重新跑 `git status --short` 和 `git rev-parse HEAD`；有漂移先解释，不要直接覆盖或 rebase 吞掉。

## 3. 已经完成的核心，不要重写

### 3.1 四级分类与窄硬闸

B 仓 `control-plane/lib/financial-commit-classifier.mjs` 已提供：

- target-bound financial classifier；
- payment candidate 可补一次观察；
- 普通 primitive 不同步调用 dump/vision/cloud；
- typed capability 与 raw `tap/input/shell` 在 fake wrapper 下得出相同 hold；
- 未有绑定批准时支付正例不下发 transport。

禁止用整页“支付/订单/金额”等关键词重新做 blanket gate。只有经目标控件和最终阶段证据确认的 `financial_commit` 才进入资金等待。

### 3.2 一次性人类批准契约

两仓的 `payment-approval` schema 已一致。批准必须精确绑定：

```text
commitId
runId
effectId
app
accountRef
payeeRef
amount
currency
targetControlFingerprint
snapshotHash
deviceId
createdAt
expiresAt
issuer.keyId
issuer.subject
issuer.role = human
issuer.allowlistVersion
purpose = financial_commit
signature
```

B 仓 `control-plane/lib/payment-approval-verifier.mjs` 已完成 schema、字段全绑定、过期、allowlist、human role、purpose 和 Ed25519 签名验证。不要新增“agent token 也算批准”“Registry 登录就跳过签名”之类旁路。

### 3.3 Protected Human Commit 核心

B 仓 `control-plane/lib/protected-human-commit.mjs` 已完成：

- payment begin 时生成 `commitId`、`createdAt`、`expiresAt`、`approvalBinding`；
- approve 前验证精确绑定的签名；
- 过期取消；
- commit 一次性决定；
- 验签失败仍保持 waiting，底层 transport 不执行。

但当前 live prepared handle 仍只在每个 `ProtectedHumanCommit` 实例的内存 Map 中；控制面没有全局可决定索引。StateStore 目前也只保存旧的最小 protected commit 行，终态路径会删除记录。这正是 Phase 8 要补的部分。

## 4. Phase 8 实施范围

Phase 8 先新增 `8.0 Payment control surface`，完成后才进入原有 alias 01/02 扩容、Review/adopt 切换和文档收口。

### 4.1 B 仓：持久化和控制面

允许修改的核心文件：

```text
control-plane/lib/state-store.mjs
control-plane/lib/protected-human-commit.mjs
control-plane/lib/control-plane.mjs
control-plane/router.mjs
control-plane/server.mjs              # 仅实际装配需要时
control-plane/bootstrap.mjs           # 仅 verifier/allowlist 装配需要时
tests/control-plane-state.test.mjs
tests/protected-human-commit.test.mjs
tests/control-plane-server.test.mjs
tests/payment-tripwire.test.mjs
```

实现要求：

1. `protected_commits` 通过服务内幂等 migration 增加 payment 所需最小字段；禁止手写或直接修改 `control.db`。
2. 最少持久化 `approval_binding_json` 与 `expires_at`。不得持久化私钥、human token 或完整签名密钥材料。
3. `listProtectedCommits` 增加 `action=payment` 过滤；对外 DTO 只返回确认所需绑定字段，不返回内部 tuple/token/params。
4. 终态改为保留审计行，建议状态至少包括 `waiting_authorization/approved/denied/expired/recovered_cancelled`；不得靠删除行假装完成。
5. ControlPlane 维护 `commitId -> live ProtectedHumanCommit instance` 的进程内索引。只有 live handle 可以决定。
6. 控制面重启后，durable pending 必须变成 `recovered_cancelled` 或等价不可恢复状态；不得凭旧批准自动执行。人需要重新观察并生成新 commit。
7. 新增：

```text
GET  /control/v1/payment-commits
POST /control/v1/payment-commits/:commitId/decide
```

8. `decide` 请求仅接受 `approve|deny`。approve 必须携带符合 `xhs.payment-approval.v1` 的签名对象；deny 不得意外触发 execute。
9. 未找到 durable row 返回 404；有 durable row但没有 live handle 返回 409 且要求重新观察；过期返回明确终态，不得重试执行。
10. 重复 approve/deny 必须幂等地拒绝第二次 transport；同一个 commit 底层 execute 调用最多一次。

建议 DTO：

```json
{
  "commitId": "protected_commit_...",
  "status": "waiting_authorization",
  "approvalBinding": {
    "runId": "...",
    "effectId": "...",
    "app": "...",
    "accountRef": "redacted:...",
    "payeeRef": "redacted:...",
    "amount": "8.00",
    "currency": "CNY",
    "targetControlFingerprint": "...",
    "snapshotHash": "...",
    "deviceId": "...",
    "createdAt": "...",
    "expiresAt": "..."
  }
}
```

`accountRef/payeeRef` 必须继续是脱敏引用，不要为了 UI 可读性换回姓名、账号或收款码原文。

### 4.2 A 仓：Registry proxy 与人类确认页

允许修改的核心文件：

```text
registry.mjs
tests/registry.test.mjs
install-registry-task.ps1             # 只有 signer 文件配置确实需要时
docs/observer-api-20260729.md          # 完成后同步接口语义
```

实现要求：

1. Registry 从控制面 GET payment commits，不直接读取或写入 B 仓数据库。
2. 增加 payment list proxy 与 human-only decide proxy；agent/operator/observer token 均不得 approve/deny。
3. UI 标题和文案必须明确“仅资金最终提交需要人类确认”；不得把普通评论、私信、发布、收藏、关注、搜索或未知 Explorer 放进该面板。
4. UI 展示 app、金额/币种、脱敏 payee/account、device、过期时间和目标指纹摘要；HTML 全部转义。
5. approve 需要 CSRF、明确确认短语和签名批准；deny 也需要 CSRF，但不能要求或生成支付签名。
6. legacy approval 在 Phase 8 只读展示，待新 payment surface 全部 GO 后再关闭旧“非支付 waiting approval 创建路径”。不能先关旧路，再补支付页。
7. signer 私钥只允许从受限文件/系统密钥设施读取。禁止放在命令行、URL、日志、数据库、页面 HTML 或 task-launch 明文参数里。
8. 如果 Phase 8 当时没有合格 signer 装配：UI 可以列出并允许 deny，但 approve 必须 503 明确报 `payment signer unavailable`；不得降级成 unsigned approve。
9. Registry 只能为已认证 human session 签发；签名内容必须直接来自控制面返回的 `approvalBinding`，浏览器不得自行改 amount/payee/target/snapshot。
10. UI/API 的成功只代表决定被控制面接受；不得把 HTTP 200 写成“支付完成”。真实 effect 结果仍由控制面状态/receipt 判断。

### 4.3 建议的签名装配

推荐由 Registry server 读取只读 key file，并配置：

```text
payment signer key file path
keyId
human subject
allowlistVersion
purpose = financial_commit
```

控制面只加载对应 public-key allowlist。A/B 使用相同 canonical JSON 规则。测试用临时 Ed25519 keypair；生产 key 不进入仓库、fixture 或测试输出。

如果接手人提出别的 signer 架构，必须先证明：

- agent/operator 无法调用；
- 私钥不出现在 argv/log/HTML/DB；
- 签名精确绑定全部 payment fields；
- 控制面独立验签，而不是信任 Registry 的普通布尔值。

## 5. 离线测试矩阵

### 5.1 B 仓必测

- payment begin 后 list 可见且字段完整、脱敏。
- ordinary nonpayment 不生成 payment pending。
- approve 正确签名：execute 恰好 1 次，状态 approved。
- deny：execute 0 次，cancel/restore 恰好 1 次，状态 denied。
- agent/错误 role/错误 key/撤销 key/错误 purpose：execute 0。
- amount、currency、payee、target、snapshot、device、effect、run 任一字段被改：execute 0。
- 过期批准：execute 0，状态 expired。
- 重复决定与并发双击：execute 最多 1 次。
- 控制面重启：旧 pending 不可 resume，状态 recovered_cancelled。
- raw/typed 支付正例未确认：transport 0。
- 非支付 fixture：不出现 waiting payment；普通 primitive 同步观察调用 0。
- list/decide DTO 不含 token、params、account 原文、私钥或 signature。

### 5.2 A 仓必测

- human 可 list；agent 是否可 list 可按只读策略决定，但不得 decide。
- agent/operator/observer/无 token approve/deny 均 403。
- human approve 无 CSRF、确认短语错误、signer unavailable 均不代理成功。
- human approve 生成签名后，字段与控制面 binding 逐字一致。
- human deny 不生成签名且控制面收到 deny。
- 页面 HTML escape、无私钥/完整 token/signature 泄漏。
- legacy approval 只读；页面不为普通非支付项目显示批准按钮。
- 控制面不可达时页面降级显示，不返回伪成功。

### 5.3 回归与 scope

完成后至少运行：

```text
A: npm test
A: node --test tests/nonpayment-liveness.test.mjs tests/registry.test.mjs
B: npm test
B: node --test tests/payment-tripwire.test.mjs tests/protected-human-commit.test.mjs tests/control-plane-state.test.mjs tests/control-plane-server.test.mjs
B: node --test tests/cross-repo-contract-parity.test.mjs
```

同时运行两仓 scope diff 和 secret scan。任何计划外文件都先停下补计划，不得顺手改。

## 6. GO / NO-GO

### GO

- 未确认 payment final 的所有路径 transport=0。
- 正确的人类签名只对一个 commit、一个 target、一个 snapshot、一个 device、一个时间窗有效。
- list durable、decide 只认 live handle；重启后不自动恢复支付。
- agent/operator/observer 无支付决定权。
- 普通非支付任务不进入这个 UI，也不新增审批或等待。
- 两仓全量测试、scope、secret scan 全绿。

### NO-GO

- Registry 用 human token 直接代替加密签名。
- 私钥出现在 argv、日志、HTML、数据库或仓库。
- 页面关键词让整页操作都被当支付。
- unknown 被当 payment。
- durable pending 在重启后凭旧批准执行。
- 先关闭旧门，后补 payment control surface。
- 以支付安全为理由给非支付任务恢复 R2/R3 blanket approval。
- 把 API 200、签名通过或暗部署写成真实支付完成。

## 7. 实施顺序与提交拆分

建议至少拆成三次独立提交：

1. `payment-pending-store-and-control-api`
   - StateStore migration、live handle 索引、list/decide、B tests。
2. `registry-payment-human-surface`
   - Registry proxy、human-only UI/API、signer 装配、A tests。
3. `payment-control-docs-and-legacy-readonly`
   - 文档、legacy 只读切换、最终 scope/secret/full regression。

每个提交报告：两仓起止 SHA、实际文件、测试数、未完成项、是否部署、是否碰机。Phase 8 的源码提交仍不自动授权 Windows 部署或真机动作。

## 8. 当前已验证结果

交接前现场复核：

- A 仓 `npm test`：73/73 通过。
- A 仓 scope test：3/3 通过。
- B 仓 Phase 2 定向测试：8 tests，其中 6 通过、2 个跨仓/scope 测试因未设置跨仓环境而 skip，0 失败。
- B 核心验证覆盖 classifier、fake transport、普通 primitive 零同步观察、PHC 单次签名批准。
- 两仓交接时均无未提交源码改动；本 handoff/计划修订会形成 A 仓新的文档提交。

这些是 source/offline 事实，不代表 Windows 已部署，也不代表设备或支付流程已验证。

## 9. 接手人开工清单

1. 完整阅读主计划 §0、§2、§3、§5.3、§7、§8.1 A1、§8.2 B4、§9 Phase 2/7/8、§11、§12。
2. 核对本 handoff 的两仓 HEAD、clean status 和分支。
3. 先写 B 的 durable/list/decide 红灯测试，再改状态层；禁止直接碰 DB。
4. 再写 A 的 role/CSRF/signer/UI 红灯测试；禁止把 agent token 变成人类批准。
5. 先完成离线 GO，再向用户单独申请 Windows 暗部署授权。
6. 暗部署仍保持 shadow、空 pilot、active jobs=0、active leases=0；不得顺带碰手机。
7. 任何影响非支付自由度或 Explorer 热路径的变化立即停止并单独报告。

