# Windows repair consumer v1 派工契约

> 适用：Mac Review 产生 `xhs.repair-proposal.v1` 后，由 Windows consumer 自动领取源码修复，再交 Mac 独立复核。
>
> 本契约只授权 consumer 做 proposal 明示的 source-only 修复。它不授权部署、手机 job/session、设备操作或重放。

## 1. 复用面

- 发现：现有 registry `GET /api/knowledge?appliesTo=repair-proposal-v1&lifecycle=backlog`。
- 发布：现有 `POST /api/knowledge`，proposal/event 各占一个不可变 knowledge item；不 PATCH `content`。
- 串行与证据：现有 Windows explorer outbox 下使用 `repair/<proposalId>/`；不新建服务、数据库或控制面。
- 源码：仍走 `gifted-professor/xhs-device-agent` Git；Windows 不写 Mac 工作树。

knowledge 是发现/审计镜像，sealed outbox 是 claim/checkpoint/completion 的文件证据。knowledge 写失败只增加 repair transport debt；不得改变非支付业务结果。

## 2. 状态机与权限

```text
proposed -> claimed -> fixing -> source_review
                               -> request_changes -> fixing
source_review -> approved -> deployable -> replaying -> completed
任一非终态 -> failed/cancelled
```

- Windows consumer 可发：`claim`、`heartbeat`、`start_fixing`、`source_checkpoint`、`attempt_failed`、`claim_expired`、`fail`。
- `start_replay`/`complete` 也由 Windows 发，但 `start_replay.payload.authorizationRef/authorizationSha256/authorizationCommit` 必须引用可信 Mac ref 可达 commit 上 `docs/handoffs/repair-authorizations/` 内、另行取得的 Windows 部署/重放授权；proposal 本身不算授权。authorization 的 canonical unsigned JSON 还必须有独立人类 Ed25519 key 签名，public key 由 consumer 配置且不在 proposal 内。归约器通过 Git + signature verifier 双重核验，字符串、Git push 权或 `issuer.role` 自报均无效。
- Mac Governance/人类可发：`review_approved`、`review_request_changes`、`mark_deployable`、`cancel`。
- Windows 不能发批准事件、不能修改 Review receipt/verdict、不能写 Mac、不能自行标 deployable。
- Mac 不碰设备、不提交 job/session、不部署 Windows。

精确转换、角色检查与去重由 `scripts/lib/repair-proposal.mjs` 的 `applyRepairEvent` 约束；实际可信物验证使用 `scripts/lib/repair-authority-verifiers.mjs` 的 `createRepairAuthorityVerifiers`，必须显式配置 Mac repo/trusted ref、outbox、completion roots 与 `replayAuthorizationPublicKeys`。Mac review 从可信 Git ref 读取；replay authorization 还必须通过独立人类签名，禁止传恒真 callback。outbox/completion artifact 同时做 lexical + realpath containment 并拒绝 symlink。事件按 `occurredAt,eventId` 排序后归约；同 `eventId` + 同 canonical digest 重放幂等，同 ID 不同内容一律拒绝。

## 3. claim / heartbeat

1. consumer 校验 proposal schema、`proposalSha256`、idempotency key、supersession、scope 与 circuit breaker。
2. 在现有 outbox `repair/<proposalId>/attempt-<N>/` 内用独占创建 `claim.lock` 竞争；`EEXIST` 即未领取。锁内容只含 proposal hash、actor、attempt、claimedAt、expiresAt，不含凭据。
3. 赢锁者写 `xhs.repair-event.v1` claim；payload 必须带精确 `lockRef=repair/<proposalId>/attempt-<N>/claim.lock` 和锁文件 `lockSha256`，再将同一事件以 knowledge item 镜像。归约器调用方必须注入 outbox lock verifier 核实独占文件及 hash；只报字符串会 fail closed。多 claim 冲突时，只有 outbox 独占锁且锁 hash 匹配的事件有效。
4. 每 60 秒 heartbeat，claim TTL 900 秒。heartbeat 先原子替换 outbox receipt，再镜像 knowledge。
5. TTL 到期后 consumer 写 `claim_expired`；attempt 未达上限且熔断未开时回 `proposed`，否则 `failed`。
6. 同一 proposal 最多 3 attempts；连续 2 次失败在 3600 秒窗口内打开熔断。重试已终态 proposal 必须由 Mac 发新 proposal，并以 `supersedes` 绑定旧 proposal。

## 4. source checkpoint

Windows 修复完成后，在原 attempt 目录密封 `xhs.repair-source-checkpoint.v1`：

- 绑定 proposal id/hash、attempt、base/result commit；proposal/review/event 的对象 hash 均为 canonical JSON（对象 key 排序、数组顺序保留）后做 SHA-256；
- 逐文件 before/after SHA-256 与增删行；
- 总文件数、总 diff 不超过 proposal；
- 每个路径必须在 allowlist 且不命中 forbidden paths；
- 测试、scope guard、secret scan 均带 evidence hash；
- `businessSemanticsChanged=false`；
- `reviewVerdictModified=false`、`macWritePerformed=false`、`deploymentPerformed=false`、`deviceActions=0`。

密封完成后发 `source_checkpoint` 事件，状态进入 `source_review`。Windows 到此停止；不能自批。

## 5. Mac 独立复核

Mac 只读拉取显式 checkpoint bundle，核 exact proposal/base/result commit、diff、tests、scope、secret scan 和禁止项：

- 通过：发 `review_approved`，随后单独发 `mark_deployable`。
- 需改：发 `review_request_changes`，列 finding 和新 TTL；原 claimant 可回 `fixing`。
- 越界或不可信：发 `cancel` 或让 proposal `failed`；不替 Windows 改源码。

`approved` 只表示 source review 通过；`deployable` 只表示允许进入另行授权的部署候选。两者都不等于已部署或已重放。

每个 Mac verdict/deployable/cancel 事件都必须带 `authority`：可信 Mac commit、`docs/handoffs/repair-reviews/` 下 receipt path/hash、被复核 checkpoint hash。consumer 不能只信 `actor.role`；调用方 verifier 必须确认该 commit 可达配置的可信 Mac `origin/main`（或明确配置的 review ref），并确认该 commit 上 receipt 的 bytes/hash 与 proposal/checkpoint 绑定。未注入 verifier 时归约器 fail closed。

## 6. completion bundle

只有另行授权并实际部署/重放后，Windows 才可密封 `xhs.repair-completion.v1`：绑定 source checkpoint、result commit、Mac approved/deployable 事件、replay run/manifest hash 和独立授权引用/hash。`complete` 事件还必须经调用方 completion verifier 核验 sealed bundle，不能只凭 payload hash 自报。首条 XHS 只读 proposal 还必须保持 `externalEffect=false`、`paymentTransport=0`，且 `evidenceDebtAffectsBusinessResult=false`。

## 7. v1 自动修边界

允许：evidence exporter、截图/UI dump artifact、manifest/artifact hash、脱敏 `pageClass/cardCount`、日志/lifecycle、测试 fixture、不改变业务语义的恢复和观测逻辑。

绝对禁止：根 `skills/SKILL.md`、治理权限含义、payment guard、approval/Standing Grant、密钥/token/认证、`control.db`、真实支付、不可逆 effect、Windows 部署配置，以及任务未另行授权的手机动作。

## 8. 首条 proposal

- 文件：`docs/handoffs/2026-08-02-xhs-observe-feed-repair-proposal.v1.json`
- proposal id：`repair_ff7fc51b35aec35227cf5eb6`
- idempotency key：`repair:ff7fc51b35aec35227cf5eb6a22d708566772f2dbe37241ea7f1ee5c5cffa041`
- source manifest：`14ab37290468fd6dd82ed11dd615d5dea9494b6fabea8c4166f8a814ff3fae7d`
- source Skill：`skills/xhs/xhs-observe-feed/SKILL.md` v0.1，SHA-256 `2baba76b8c9c877c1f63e2a824096c2065f90031db119238a6e33bf864e9720d`

生成现有 registry knowledge 信封（纯离线，不发送）：

```text
node scripts/create-repair-proposal.mjs docs/handoffs/2026-08-02-xhs-observe-feed-repair-proposal.v1.json --existing --knowledge
```

从本次 aggregate review bundle 机械复现同一个 proposal（纯离线；`--repair-proposals` 因 evidence debt 返回非零是预期）：

```text
node scripts/review-run-bundle.mjs tmp-know/review-bundles/p78-feed-loop-20260802 --repair-proposals --proposal-created-at 2026-08-02T09:30:00.000Z --skill-path skills/xhs/xhs-observe-feed/SKILL.md --skill-version 0.1 --skill-sha256 2baba76b8c9c877c1f63e2a824096c2065f90031db119238a6e33bf864e9720d
```
