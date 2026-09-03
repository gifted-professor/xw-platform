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
  - date: 2026-09-03
    device: "04"
    result: PASS
    note: "飞书发布表→保序推相册→编辑页 1/2 顺序正确→存草稿，草稿箱·1 可见（feat/xhs-feishu-sync-adapter 60eb388）"
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
node ops/xhs-publish-draft.mjs --alias <01-04> --session-file <explorer-session.json> --caption "文案内容"

# 经授权后真发布（不可逆！）
node ops/xhs-publish-draft.mjs --alias <01-04> --session-file <explorer-session.json> --caption "文案内容" --publish

# 飞书发布表 → 存草稿整链（2026-09-03 已验证，真人身份 --as user，绝不点发布）
node ops/feishu-to-xhs-draft.mjs --record-id <rec> --alias 04
node ops/feishu-to-xhs-draft.mjs --record-id <rec> --alias 04 --push-only   # 只推相册不碰 UI

# 飞书发布表 → 正式 job 链（edit_dry_run stayForAccept 停编辑页等人验收）
node ops/feishu-to-xhs-publish.mjs
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--alias` | ✅ | 设备别名 01-04 |
| `--caption` | ✅ | 文案内容 |
| `--publish` | ❌ | 真发布（需授权，不可逆） |
| `--record-id` | feishu 链✅ | 飞书发布表记录 ID（tblA3sCeFgdJHStf） |
| `--select` | ❌ | 飞书链选前 N 张图（1-9，默认 2） |

## 流程

```
打开发布 → 相册选择图片 → (滤镜) → 文案页
→ 填入 caption → [默认停在这里]
→ [--publish: 点发布 → 验证离开文案页]
```

飞书链：`飞书附件（--as user，reverse 保序）→ 01-/02- 前缀下载+sha256 → 倒序 push+touch 推相册 → 编辑页 UI 流 → 存草稿（W6：存草稿=完成）`

## 已修复的坑

- `caption_page_not_reached`：相册→文案偶需两次「下一步」，且 22222 排队致 tap 丢失。修法：循环 2→3 轮、首步 settle 2800→3000、tap 后比对 focus 没动则重点。

## 飞书发布链坑点（知识库已沉淀，id 见 registry /api/knowledge）

- **飞书附件逆序**（`xhs-feishu-attachment-newest-first`）：附件 cell 是「后上传在前」，必须 reverse 后 orderIndex 0=封面。
- **保序双机制**（`xhs-feishu-staging-dual-order`）：倒序 push + touch mtime 单调 + 500ms 间隔 + MEDIA_SCANNER + 01-/02- 前缀，封面才落左上第一格。
- **Git Bash GBK 乱码**（`xhs-curl-gbk-mangling`）：curl -d 传中文→GBK 乱码→PARAMS_SCHEMA_INVALID；改 node 写 UTF-8 JSON + `--data-binary @file`。
- **无 save_draft capability**（`xhs-no-save-draft-capability`）：存草稿=adb tap(≈920,142)→弹窗「确定」(≈717,1289)；草稿箱验证在「我」tab (999,2260)（(998,2350) 是手势条会打空）。
- **文案硬限制**（`xhs-title-20-body-300-limits`）：title≤20、body≤300、tags≤10×30、图 1–9；adapter 对拼 tags 后正文再查 300；预检 fail-closed，禁止 slice 截断。
- **飞书状态枚举**（`feishu-status-option-enum`）：只有 待发布/发布中/已发布/发布失败；存草稿回写「待发布」。
- **⚠️ 04 号机风控**（`xhs-account-04-risk-control`）：账号弹过「异常行为风险」限制提示；只点取消，解除限制（真人安全验证）留给操作者。
- **MIUI 权限弹窗**（`miui-media-permission-pm-grant`）：根治=`adb shell pm grant` XHS 三媒体权限。
- **quarantine 恢复**（`xhs-job-recover-before-resubmit`）：先 `POST /control/v1/jobs/:id/recover` + 换新 idempotencyKey 再重提。

## 相关

- 发布入口探索：`skills/xhs/xhs-publish`（xhs-publish-entry.mjs）
- 坑点手册：`skills/shared/pitfalls`
- task-template：`task-templates/task.xhs.feishu-draft@1.json`（飞书→草稿整链登记）
