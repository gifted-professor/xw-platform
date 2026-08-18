# Mac Review、原子收编与能力加强任务清单

> 模式：Mac Governance
>
> 目标：在不碰设备、不部署 Windows、不替 Windows 编造探索事实的前提下，接收 Windows sealed bundle，离线审核、原子收编候选文件，并加强现有能力库。
>
> 对端：Windows 继续执行用户已下发的完整“手机执行、证据落盘与能力沉淀任务”；本文件不替换、不重述 Windows 任务。

## 1. 边界

Mac 可以：

- 读取显式提供的 Windows bundle；
- 验证 schema/seal/hash/commit/run/effect 关联；
- 生成 `xhs.review-receipt.v1`；
- 将明确列出的候选文件放入 staging；
- 检查 base/path/hash/conflict 后原子 apply；
- 更新 App 子 Skill、共享 pitfalls 和能力库内容；
- commit/push Mac 源仓。

Mac 不可以：

- 提交手机 job/session 或碰设备；
- SSH 推部署；
- 自动扫描 Windows 文件树并整包收编；
- 替 Windows 补 selector、坐标、真动作和设备事实；
- 修改 `registry.mjs`、根 `skills/SKILL.md` 或支付权限层；
- 把 Markdown 自述当成独立事实证据。

## 2. 汇合输入

Windows 必须显式交付：

- bundle 目录或可读取位置；
- `runId`；
- `manifestSha256`；
- `producerCommit`；
- `releaseId`；
- `candidateFiles[].path/sha256`。

Mac 只处理 manifest 列出的候选，不根据目录内容猜 scope。

## 3. Mac 任务清单

### M1：离线 intake 与 Review receipt

复用并加强：

- `scripts/lib/evidence-contract.mjs`
- `scripts/validate-run-bundle.mjs`
- `scripts/render-acceptance.mjs`
- `contracts/explorer-run.v1.schema.json`
- `contracts/review-receipt.v1.schema.json`

实现一个面向显式 bundle 的治理入口，完成：

1. 读取 manifest/events/seal；
2. 校验 seal、manifest hash、schemaId/version；
3. 校验 runId、producerCommit、artifact/effect/candidate 引用；
4. 分开声明 process、adapter、effect、verification、cleanup、evidence completeness；
5. 生成机器可读 review receipt 和人可读摘要；
6. bundle 缺失或矛盾时 fail closed 于“收编”，但不宣称 Windows 业务未执行。

### M2：staging 与 atomic adopt

在现有 `adopt-from-windows.mjs` 的“显式列文件”原则上增加 sealed-bundle 路径：

1. `candidateFiles` 路径白名单和 traversal 拒绝；
2. 下载/读取后逐文件核对 SHA-256；
3. 写入仓内临时 staging，而不是直接覆盖目标；
4. 记录 Mac base commit 和 before SHA；
5. 检查脏树、base drift、目标冲突；
6. 全批通过后一次 apply；
7. 中途失败零半写；
8. 生成 `xhs.adopt-batch.v1` receipt；
9. 同一 manifest 重复 adopt 幂等。

### M3：能力评判与加强

按 `modes/governance.md` 权威度评判：

```text
sealed run/effect/artifact
> ACCEPTANCE
> EXPLORE
> App Skill 正文
> op 表/旧 knowledge
```

Review 检查：

- 候选是否与真实 trace 一致；
- selector、页面识别和 postcondition 是否明确；
- 恢复路径和适用范围是否诚实；
- 单次探索是否冒充稳定能力；
- 是否与现有 capability 重复；
- 是否泄漏 token、账号隐私或敏感输入；
- 是否绕过正式 lease；
- payment final hard gate 是否保持。

通过后优先增强现有 App 子 Skill；只有确实没有同义能力时才新增。根路由只给人提出建议，Mac agent 不修改根 `skills/SKILL.md`。

### M4：回放闭环

Mac push 收编结果后，不向 Windows 主动部署。等待既有 sync/Windows 正式部署，再由 Windows 使用收编后的 capability 重放一次并交第二个 sealed bundle。

Mac 对第二个 bundle 做轻量复核，确认：

- 使用的是已收编能力版本；
- 结果与首次候选一致；
- 新能力没有引入额外人工等待；
- 设备和 lease 正常释放；
- payment transport=0。

## 4. 测试矩阵

Mac 侧至少覆盖：

- v1-only、legacy-only、dual、empty bundle；
- seal mismatch、manifest hash mismatch；
- runId/producerCommit mismatch；
- artifact/effect/candidate 缺引用；
- candidate path traversal/绝对路径/重复路径；
- candidate hash mismatch；
- Mac 脏树、base drift、目标冲突；
- apply 中断零半写；
- 重复 adopt 幂等；
- review receipt 与 adopt receipt schema；
- secret/private-data lint；
- evidence debt 不被误写成业务失败。

运行：

```text
npm test
npm run check
node --check <新增治理脚本>
```

## 5. 双边汇合判定

以下链路全部成立才算首轮闭环完成：

```text
Windows 正式执行
-> sealed evidence bundle
-> Mac review receipt
-> staging + atomic adopt receipt
-> App capability/Skill 加强并 push
-> Windows sync/deploy
-> 使用收编能力重放
-> Mac 复核第二个 bundle
```

共同关联键必须一致：`runId/manifestSha256/producerCommit/candidateFiles`。任何一端不得用聊天报告代替机器 receipt。

## 6. Mac 当前第一批动作

1. 跑现有 `review-windows`、bundle validator、render acceptance 相关测试；
2. 记录当前 intake/adopt 缺口；
3. 实现 M1 的显式 bundle Review receipt；
4. 补测试并保持现有 legacy/dual reader 兼容；
5. 再进入 M2 atomic adopt。

## 7. Mac 完成条件

- 能对 Windows bundle 做纯离线、可重复 Review；
- review receipt 绑定 exact manifest/commit/run；
- candidateFiles 只能显式、hash 校验后收编；
- atomic adopt 零半写且幂等；
- 能把通过审核的候选增强到正确 App 能力库；
- 不碰设备、Windows 部署和根权限层；
- Windows 重放证据再次通过 Mac Review。
