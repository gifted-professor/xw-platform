# 提案：<标题>（proposal-<slug>-<date>）

> 提交者：<agent/人> · 日期：<YYYY-MM-DD> · 目标层：坑点 | 契约 | 权限
> 目标文件：<skills/.../SKILL.md | ops/... | shared/pitfalls.md>

## 1. 触发证据（必填，机器生成）

粘贴 `_trace-pitfall --evidence "<query>"` 的输出（--json 或 human），写明：
- 查询串
- 覆盖 trace 文件日期（如 2026-07-25..2026-07-31）
- 失败次数
- （biz 时）总尝试 + 失败率

**没有证据块的提案默认打回。**

## 2. 复验命令（硬编码，必填）

```bash
ssh xhs-windows 'node C:\Users\Public\xhs-registry\ops\_trace-pitfall.mjs --evidence "<query>" --json'
```

Mac 侧重跑此命令应得到与 §1 一致的 JSON 输出。

## 3. 建议改动（原来 → 现在 → 为什么）

| 位置 | 原来 | 现在 | 为什么 |
|------|------|------|--------|
| <文件:行> | <原行为/描述> | <新行为/描述> | <触发证据指向的根因> |

## 4. 验证要求

- 契约层：是否更新 `verified` 列表？需真机设备（01-04）？预期结果？
- 坑点层：`shared/pitfalls.md` 追加条目 slug？
- 权限层：交人，附证据，人等审批。

## 5. 涉及文件

- ops/...
- skills/...

## 6. 无自动 trace 覆盖时的证据下限

适用场景：新 App / 只跑 device-* 原始动作 / 截图兜底未打 dump → 无 biz 证据属**正常**。

最低证据要求：
- 至少 2 次独立观测（不同 ts），含 device/alias + 具体失败文本 + 复现步骤
- 显式标注「手动证据，非 trace 生成」
- 仍须在 §2 给出可跑复验命令（预期 matched:[] 或部分覆盖）
- 主张「某 Tab 不可 dump」类结论：至少留一次失败 dump，否则标手动证据

## 完成口令（可选）

<一行总结>
