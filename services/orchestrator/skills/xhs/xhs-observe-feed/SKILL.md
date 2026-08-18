---
name: xhs-observe-feed
description: 正式控制面 xhs.observe.feed 只读观察信息流卡片（非 lab 旁路）。
triggers:
  - xhs-observe-feed
  - 小红书观察信息流
  - observe feed
version: "0.1"
verified:
  - date: 2026-08-02
    device: "01"
    result: pass
    note: "dual evidence / shadow; two formal jobs succeeded; paymentTransport=0"
    runs:
      - run_cb3cd098-60e5-4e27-9406-ed0403fc0eb0
      - run_4ea05df4-cb7e-4d71-bf23-9a244f9379af
    producerCommit: 5677e61e3363d2afc415e9add5f89f873fc7a32d
    releaseId: rel-shadow-2026-08-02-p7a-stable-locator
depends: []
changelog:
  - version: "0.1"
    date: 2026-08-02
    change: "Phase 7/8 loop candidate→skill thin wrapper around formal capability"
---

# 小红书信息流观察（xhs-observe-feed）

正式能力：`xhs.observe.feed`（R0 / E3）。不经 22222 lab 旁路。

## 用法（Windows 本地）

```powershell
cd C:\Users\Public\xhs-routing-v1-1
node control-plane\devicectl.mjs --local job submit `
  --actor <actor> `
  --capability xhs.observe.feed `
  --alias 01 `
  --idempotency-key <key> `
  --params "{}"
node control-plane\devicectl.mjs --local job status --job <jobId>
```

## 成功判据

- `job.status=succeeded`
- `verification.ok=true`
- `externalEffect=false`
- lease/job 结束后归零

## 已知不适用

- note-detail 稳定 locator / receipt
- 支付 / Standing Grant collect
- 把 lab `ops/xhs-search.mjs` 当成同一条正式 capability

## Review bundle

`tmp-know/review-bundles/p78-feed-loop-20260802/`
