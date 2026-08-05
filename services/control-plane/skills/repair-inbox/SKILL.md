---
name: repair-inbox
description: >-
  Windows Repair Inbox — discover backlog repair proposals from registry knowledge
  and optionally hand validated work to the existing repair consumer. Ordinary
  Skills explain how to run a capability; this Skill decides what to fix now.
triggers:
  - repair-inbox
  - repair inbox
  - repair consumer
  - backlog repair
  - source_review
version: "0.1"
verified: false
---

# Repair Inbox（Windows）

> **普通 Skill 说明能力怎么跑；Repair Inbox 决定现在修什么。**
> 不要把动态 `proposalId` 硬编码进普通 capability Skill（如 `xhs-observe-feed`）。
> 禁止修改根 `skills/SKILL.md`。

## 权威顺序

1. Live registry knowledge：`appliesTo=repair-proposal-v1` + `lifecycle=backlog` + `needsEngineer=true`
2. 本入口 + `scripts/lib/repair-consumer.mjs` + sealed outbox
3. 契约：`docs/handoffs/2026-08-02-windows-repair-consumer-contract.md`

## 开工（默认只读）

```powershell
cd C:\Users\Public\xhs-routing-v1-1
node scripts/repair-inbox.mjs list
# 或
node scripts/repair-inbox.mjs discover --expect-id repair_ff7fc51b35aec35227cf5eb6
```

成功时 JSON 含 `schemaId=xhs.repair-inbox.v1`、`mode=discover`、`entries[]`
（proposalId / proposalSha256 / skillBinding / capabilityId / findingSummary）。
**list/discover 不写 outbox、不 claim、不碰设备、不提交 job。**

## 校验门（发现后、claim 前）

对每条 candidate 校验：

- knowledge 信封：`needsEngineer=true`、`lifecycle=backlog`、`appliesTo` 含 `repair-proposal-v1`
- 完整 `xhs.repair-proposal.v1` contract + canonical hash
- `target.skillBinding`（path / version / sourceSha256）；禁止绑定根 `skills/SKILL.md`
- `policy.allowedPaths` / 必填 `forbiddenPaths` / secret scan
- Windows 不得自批：`windowsCannot` 含 self_approve / modify_review_verdict 等

通过后才可交给现有 repair consumer。

## 显式领取（默认关闭）

```powershell
# live（无 --fixture）必须带真实 checkpoint；缺 checkpoint 在任何写入前 fail closed
node scripts/repair-inbox.mjs claim `
  --proposal-id <id> `
  --outbox <dir> `
  --actor <actor> `
  --i-understand-claim `
  --checkpoint <real-checkpoint.json>
```

- **没有 `--i-understand-claim` → 拒绝 claim**（`CLAIM_NOT_AUTHORIZED`）
- **无 `--fixture` = live**（不依赖可选 `--live-knowledge` 自报）
- live 缺 `--checkpoint` → 在 mkdir / outbox / claim / knowledge 写入之前返回；失败摘要只打 stdout
- 领取后只允许：heartbeat、修源码、密封 source checkpoint / completion bundle
- **停在 `source_review`**；等待 Mac 独立复核
- 不得：自批、改 Mac verdict、`mark_deployable`、部署、replay、job/session、操作手机

## 与 capability Skill 的分工

| 文档 | 回答什么 |
|------|----------|
| `skills/xhs/xhs-observe-feed` 等 | 这条能力怎么跑、成功判据是什么 |
| **本 Skill（Repair Inbox）** | 此刻 backlog 里有没有要修的 proposal、能不能 claim |

动态 proposal（例如当前只读可见的 `repair_ff7fc51b35aec35227cf5eb6`）只出现在 Inbox / knowledge，不写进 capability Skill 正文。

## 复用面（不新建）

- Registry knowledge 发现 / 审计镜像
- `createRepairConsumer` 独占 claim、TTL、attempt、熔断、outbox 事件
- Sealed outbox `repair/<proposalId>/`
- **不新建**服务、面板、数据库

## 相关

- CLI：`scripts/repair-inbox.mjs`
- Lib：`scripts/lib/repair-inbox.mjs`
- Consumer：`scripts/repair-consumer.mjs` / `scripts/lib/repair-consumer.mjs`
- Agent entry 补丁：`docs/agent-entry.md` § Repair Inbox
