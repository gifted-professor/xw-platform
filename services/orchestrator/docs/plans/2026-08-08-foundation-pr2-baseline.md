# Foundation PR2 post-merge baseline（2026-08-08）

> 入场闸：在 PR1 merge commit 上重跑 check/test，再开 `foundation/pr2-runtime-integrity`。  
> **判定：已知环境债，可建 PR2 分支；无 PR1 语义回归。**

## Pairing

| 仓 | merge commit | short | branch |
|---|---|---|---|
| routing `xhs-device-agent` | `fb4f90be6faa308e1e65346d4cf353c9daefe620` | `fb4f90b` | `foundation/pr2-runtime-integrity` |
| registry `xhs-registry` | `3dae43f3e6fd6478eeeef391e1de76c772727d93` | `3dae43f` | `foundation/pr2-runtime-integrity` |

- Node: **v22.22.0**（Windows）
- PR1：Source merged · Not deployed · Pilot inactive（正确）

## Routing @ fb4f90b

```text
git status --short     → clean
npm run check          → ok (142 files, secret-scan passed)
npm test               → tests=672  pass=639  fail=31
```

失败列表（与 PR1 降门「main 同债」一致；**不含** mission/payment/protected/auth-envelope/schema-v14）：

1. `control-plane-command-runner` — failed JSON adapter bounded diagnostic
2. `control-plane-evidence` — EvidenceStore / writeJson / attachFile（3）
3. `discovery-session` — Discovery primitive / candidate（4）
4. `explicit-observation-receipt` — allowlist/mint/expired/replay（4）
5. `repair-consumer-matrix` — symlink/corruption/counters（2）
6. `repair-consumer` — symlink / scope allowlist（2）
7. `repair-proposal` — filesystem/Git verifiers symlink
8. `scout-exploreFresh` — grepFile/verifyConstraint/grepRepo/locateEvidence（8）
9. `xhs-collect-standing-grant` — locator shape / offline chain / canary（5）
10. `xhs-explore-open-feed-note` — poisoned adb shell（Win）

## Registry @ 3dae43f

```text
git status --short     → clean（清掉垃圾 nul 后）
npm run check          → ok
npm test               → tests=227  pass=224  fail=3
```

失败：

1. `nonpayment-liveness` — repair-scope exclusivity（旧 repair baseline vs main 上 PR1 全量文件；foundation 分支曾跳过，**main 上仍 fail = 已知 scope 债**）
2. `registry` — observer screen singleflight（flaky/env）
3. `repair-proposal` — filesystem/Git verifiers（Win `EPERM` symlink）

## 闸门结论

| 规则 | 结果 |
|---|---|
| 全绿 → 直接开 PR2 | 否 |
| 失败均可证明为合并前已知环境问题 → 开 PR2 + 记 baseline | **是** |
| PR1 语义回归 → 先 hotfix | **否**（fail 列表无 PR1 必修套件） |

**允许开 `foundation/pr2-runtime-integrity`。**  
合并顺序仍：**routing PR2 → registry PR2**；中间禁止部署 / 重启 / 切 pilot。
