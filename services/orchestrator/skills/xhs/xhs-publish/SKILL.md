---
name: xhs-publish
description: 小红书发布草稿。默认不点发布，--publish 经人授权才点（不可逆）。
triggers:
  - xhs-publish
  - 小红书发布
  - 发布笔记
  - 发草稿
version: "1.0"
verified:
  - date: 2026-07-28
    device: "01"
    result: partial
    note: "--publish 待人授权实跑；flake 已修（循环 2→3 轮 + settle 2800→3000）"
depends:
  - device-tap
  - device-dump
  - device-input
  - device-back
  - shared/parse
  - shared/preflight
---

# 小红书发布草稿（xhs-publish）

## ⚠️ 安全规则

- **默认不点发布**（行为零破坏）
- `--publish` 经人授权才点（**不可逆动作**，点一次不重试）
- 空 caption **fail-closed**（不点发布）
- 点前留痕 `ABOUT_TO_PUBLISH=yes` + `PUBLISH_BTN=` + `CAPTION=`

## 用法

```bash
# 填草稿但不发布（默认安全模式）
node ops/xhs-publish-draft.mjs --alias <01-04> --caption "文案内容"

# 经授权后真发布（不可逆！）
node ops/xhs-publish-draft.mjs --alias <01-04> --caption "文案内容" --publish
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--alias` | ✅ | 设备别名 01-04 |
| `--caption` | ✅ | 文案内容 |
| `--publish` | ❌ | 真发布（需授权，不可逆） |

## 流程

```
打开发布 → 相册选择图片 → (滤镜) → 文案页
→ 填入 caption → [默认停在这里]
→ [--publish: 点发布 → 验证离开文案页]
```

## 已修复的坑

- `caption_page_not_reached`：相册→文案偶需两次「下一步」，且 22222 排队致 tap 丢失。修法：循环 2→3 轮、首步 settle 2800→3000、tap 后比对 focus 没动则重点。

## 相关

- 发布入口探索：`skills/xhs/xhs-publish`（xhs-publish-entry.mjs）
- 坑点手册：`skills/shared/pitfalls`
