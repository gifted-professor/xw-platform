---
name: xhs-dm
description: 小红书私信。搜索用户 → 打开主页 → 发私信。R2 外发动作。
triggers:
  - xhs-dm
  - 小红书私信
  - 私信
  - dm
version: "0.9"
verified: []
depends:
  - device-tap
  - device-dump
  - device-input
  - device-back
  - shared/parse
  - shared/preflight
---

# 小红书私信（xhs-dm）

## ⚠️ 真发私信需审批

- **打开私信会话 / dry-run**：✅ 自主执行
- **真发私信**：⚠️ 不可逆外发，需要人审批

## 用法

```bash
# 打开私信会话（不发消息）
node ops/xhs-dm-open.mjs --alias <01-04> --session-file <explorer-session.json>

# 搜索用户并打开私信
node ops/xhs-dm-user.mjs --alias <01-04> --session-file <explorer-session.json> --user "用户名" --dry-run

# 搜索用户并发送私信（R2，需授权）
node ops/xhs-dm-user.mjs --alias <01-04> --session-file <explorer-session.json> --user "用户名" --text "消息内容" --send
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--alias` | ✅ | 设备别名 01-04 |
| `--user` | ✅ | 目标用户名 |
| `--text` | ❌ | 私信内容 |
| `--send` | ❌ | 真发送（R2，需授权） |
| `--dry-run` | ❌ | 只定位不执行 |

## 流程

```
搜索用户 → 打开用户主页 → 点私信按钮
→ 进入私信会话 → [可选] 输入消息 → [--send: 发送]
```

## 注意事项

- 实验性 skill（v0.9），未经过完整真机验证
- 发送私信是 R2 外发，需要人工审批
- 用户名搜索可能不准确（同名用户），建议用 user ID

## 相关

- 关注用户：`skills/xhs/xhs-follow`
- 坑点手册：`skills/shared/pitfalls`
