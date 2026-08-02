---
name: registry-review
description: 评审 Windows 落盘的验收证据，对照 Mac 已固化子 skill，出路由表业务行提案。当用户说「评审/收编评审/核证据/核 exit 码/出路由提案/核一遍」时激活——跑采集脚本、按 governance 方法论评判、出可贴路由提案，贴路由守用户确认。
---

# registry-review（Mac 端评审 skill）

> 一句话：核 Windows 落盘的验收证据 → 对照 Mac 已固化子 skill → 评判能成哪些业务行 → 出路由表提案，**贴路由守用户确认**（根 `skills/SKILL.md` 是权限层）。
>
> 这是 Mac 治理侧的活，与 Windows 侧的 explorer skill 对称：那边探索落地，这边收编评审。知识源在 [`modes/governance.md`](../../modes/governance.md) §4-§6，**本 skill 不重抄**——评判时回读 governance.md。

## 步骤

1. **采集事实**：按输入类型选择只读入口——
   - 收到显式 sealed run bundle：先跑 `node scripts/review-run-bundle.mjs <bundleDir>`，核对 seal、manifest、runId、producer commit、事件绑定和 candidate path/hash，生成绑定 exact bundle 的 `xhs.review-receipt.v1` JSON。
   - 需要把可修 finding 交给 Windows consumer 时：跑 `node scripts/review-run-bundle.mjs <bundleDir> --repair-proposals`。aggregate bundle 如需绑定已收编 Skill，另带 `--skill-path/--skill-version/--skill-sha256`。它额外输出不可变 `xhs.repair-proposal.v1` 与现有 registry knowledge 信封；只生成 JSON，不 POST、不 claim、不部署。proposal 的后续 claim/heartbeat/source checkpoint/completion 必须走 `contracts/repair-*.v1.schema.json` + append-only sealed outbox。
   - 只有 legacy Windows 停车场证据：跑 `node scripts/review-windows.mjs`。它 SSH Windows 拉 `tmp-know/ACCEPTANCE-*.md` + `EXPLORE-*.md`，本地遍历 `skills/<app>/*/SKILL.md` frontmatter（version/verified），对照 exit 码，输出 markdown 事实表到 stdout。
   - 两个脚本都只列机械事实，**不做主观评判、不触发 adopt、不碰设备**；bundle review 失败只阻止收编，不反写 Windows 业务结果。

2. **评判**：按 [`modes/governance.md`](../../modes/governance.md) 判——
   - §4 定位：Mac 是源仓库与治理侧，不碰设备、不推部署、不改权限层。
   - §5 证据地图：权威度排序（biz/ACCEPTANCE exit 码最高 > 子 skill verified 自报 > op 表/旧知识条易 stale > EXPLORE 短报仅线索）。
   - §6 评判方法论：判每条候选——能否成业务行（= 有 v1.0+verified 固化子 skill + 真机 dry-run/真跑 exit=0 落盘证据，一次跑绿即可，非「多次成功」）、自由度（✅自主 = 只读/dry-run 可逆；⚠️需审批 = 真外发，发成功过也不变自主；🔴红线 = 不可逆外发/支付）、地图成熟度（v0.1 探索态 / v1.0 固化态）。

3. **出提案**：产「可贴路由行清单」——每行附 exit 码背书 + 自由度 + 备注（如 dump-fail、未验真动作）；另列「筛掉」项及原因（如未固化成子 skill 目录、无 ACCEPTANCE 落盘、op 表 ✅ 仅探索态非已固化）。

   对属于第一版自动修 allowlist 的 evidence/观测缺口，同时输出机器 repair proposal。proposal 必须绑定 exact bundle/run/manifest hash/producer commit/review receipt/finding，且带 allowed paths、forbidden paths、文件/diff/attempt 上限、heartbeat、supersession、熔断与验收条件。evidence debt 只影响证据完整性，不反写非支付业务结果。

4. **贴路由前必须问用户**——根 [`skills/SKILL.md`](../../skills/SKILL.md) 是权限层（§2「不碰根」，agent 只能写提案）。用户确认才代贴（破例留痕，见 memory `scp-windows-after-auth-change`）；用户点头前不碰根 SKILL.md 的路由表与 frontmatter。

5. **代贴后**：`git commit` + `push origin main` → scp 根 `skills/SKILL.md` 到 Windows `C:\Users\Public\xhs-registry\skills\SKILL.md` + 刷新 `skills/.SYNCED-FROM.md` 锚点（守用户偏好：代改权限层后咨询确认即默认 scp，不等单向 sync 拖着忘）。

## 边界

- **不碰设备**：不跑业务脚本、不提交 job、不 SSH 推部署、不替 Windows 改 op 表/建地图/补探索内容（坐标/真动作标注/04 占位）。
- **repair 权限分离**：Windows 只可 claim/heartbeat/fix/source checkpoint/completion，不能自批、写 Mac 或改 review verdict；`approved/request_changes/deployable/cancelled` 必须绑定可信 Mac commit 上的独立 receipt，不能只信 actor role。`replaying` 必须另带部署/重放授权引用/hash并由外部 verifier 核验，repair proposal 本身不是部署或手机授权。
- **绝对禁止自动改**：根 `skills/SKILL.md`、治理权限语义、payment guard、approval/Standing Grant、密钥/认证、`control.db`、真实支付、不可逆 effect、Windows 部署配置。
- **评判全自动、贴路由守确认**：步骤 1-3 自主做，步骤 4 必须人确认。
- **stale 只标「待 Windows 改」**：地图落后真机时以真机为准，Mac 不替 Win 改 op 表，只标 `stale-as-of` / 待 Win 改。
- **不自动扫库**：采集脚本显式列 `ACCEPTANCE-`/`EXPLORE-` 前缀文件，本地显式遍历 `skills/`。
- **❌ ≠ 不可用**：脚本标的 ❌ 仅表示本轮无 ACCEPTANCE 落盘，不代表 skill 不可用——早已固化的老业务（xhs/xianyu）不需每轮重验，评判时按 §6 区分。

## 与 governance 的关系

本 skill 是 `modes/governance.md` 的**可触发包装**：governance 是 mode 契约（要 `mode: governance` 才激活），本 skill 把「评审」链路固化成 cwd 在本仓库的任何 Mac agent 都能被触发发现的入口。知识源在 governance §4-§6，**不重抄**——每次评判回读 governance.md，避免两处维护漂移。

## 工具

- `scripts/review-windows.mjs` — 采集脚本（零依赖、只读、`ADOPT_SSH` 覆盖 host、不进 `npm run check`）。
- `scripts/review-run-bundle.mjs` — sealed bundle 离线核验与 `xhs.review-receipt.v1` 生成器（零依赖、只读、不 SSH、不 adopt）。
- `scripts/create-repair-proposal.mjs` — 从 finding 生成/校验不可变 proposal 与 registry knowledge 信封（纯离线）。
- `scripts/lib/repair-proposal.mjs` — idempotency、状态归约、scope/diff/secret guard、checkpoint/completion 校验。
- `scripts/lib/repair-authority-verifiers.mjs` — 对可信 Mac Git receipt、outbox claim.lock、带独立人类 Ed25519 签名的 replay authorization 与 completion bundle 做实际 bytes/hash/binding 核验；consumer 不能用 `()=>true` 代替，也不能把 source push 权当 replay 权。
