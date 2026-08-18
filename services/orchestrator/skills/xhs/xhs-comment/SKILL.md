---
name: xhs-comment
description: 打开小红书笔记并发送评论。R2 外发动作，需要人工审批。
triggers:
  - xhs-comment
  - 小红书评论
  - 评论笔记
  - 发评论
version: "0.9"
verified:
  - date: 2026-07-24
    device: "01"
    result: pass
    note: "首例控制面真评论已发出，strict 验证假阴性未根治"
depends:
  - device-tap
  - device-dump
  - device-input
  - device-back
  - shared/parse
  - shared/preflight
---

# 小红书评论（xhs-comment）

## ⚠️ 真发评论需审批

- **填评论框 + dry-run**：✅ 自主执行，不需要问人
- **真发评论**：⚠️ 不可逆外发，需要人审批

探索阶段建议先用 dry-run 确认流程，真发等积累足够验证后再放开。

## 用法

```bash
# lab 通道（Explorer，不算生产验收）
node ops/xhs-comment-one.mjs --alias <01-04> --session-file <explorer-session.json> --text "评论内容" --dry-run

# 正道（控制面 job，需审批）
cd /Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-device-agent-routing-v1-1
node control-plane/devicectl.mjs --ssh xhs-windows job submit \
  --capability xhs.comment.send \
  --actor <actor> \
  --idempotency-key <key> \
  --params '{"noteId":"<id>","text":"<评论>"}'
```

## 已知问题

- **strict 验证假阴性**：afterCount 计数头没复读到 + 新评论按热度排序沉底，textScan 看不到
- 首例真评论 2026-07-24 发出（job_7711264d），但作业状态落 ambiguous

## 验证建议

- 回滚取计数头（beforeCount 路径已有此逻辑，afterCount 没有）
- 热帖场景考虑切「最新」排序找刚发的评论

## 相关

- 点赞：`skills/xhs/xhs-like`
- 综合互动：`skills/xhs/xhs-engage`
- 坑点手册：`skills/shared/pitfalls`
