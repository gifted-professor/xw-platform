---
name: xianyu-publish
description: 闲鱼发布 dry-run。走控制面 job，支持飞书商品表编排，4 机并发已实证。
triggers:
  - xianyu-publish
  - 闲鱼发布
  - 闲鱼上架
  - 发布商品
version: "1.0"
verified:
  - date: 2026-07-27
    device: "01,02,03,04"
    result: pass
    note: "4 机并发 4/4 全绿；02 单机 E2E 通过"
depends:
  - shared/preflight
  - shared/transport
---

# 闲鱼发布 dry-run（xianyu-publish）

## 说明

闲鱼发布走**控制面 job**（不是 lab 脚本），有完整的 lease/审批/恢复机制。

## 用法

### 单机 dry-run

```bash
cd /Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-device-agent-routing-v1-1
node control-plane/devicectl.mjs --ssh xhs-windows job submit \
  --capability xianyu.publish.full_dry_run \
  --actor <actor> \
  --idempotency-key <key> \
  --device 02 \
  --params '{"productTitle":"标题","descriptionPrefix":"【奥莱折扣】","descriptionBody":"描述","colors":["黑色"],"sizes":["S","M","L","XL","XXL"],"price":"12.34","stock":2,"freeShipping":true,"saveDraft":false,"skipUpload":true,"skipCategory":true,"skipAddress":true}'
```

### 飞书编排（推荐）

```bash
# 从飞书商品表取一条 READY_TO_PUBLISH 的商品，自动组装 fixture 并提交
node ops/feishu-to-xianyu.mjs --sku <SKU> --aliases 02 --actor <actor>

# dry-run（只规划，不碰手机）
node ops/feishu-to-xianyu.mjs --sku <SKU> --aliases 02 --actor <actor> --dry-run
```

### 双机并发（默认入口）

```bash
node ops/conc2-full-dry-run.mjs --actor <actor>-conc2
```

## 能力等级

| 能力 | 等级 | 说明 |
|------|------|------|
| `xianyu.publish.open_dry_run` | R1 | 打开发布页 |
| `xianyu.publish.input_dry_run` | R1 | 输入文本 |
| `xianyu.publish.image_dry_run` | R1 | 选择图片 |
| `xianyu.publish.full_dry_run` | R1 | 完整 dry-run（不存草稿） |
| `xianyu.publish.save_draft_dry_run` | R2 | 存草稿（需审批） |

## 实战配方

- 规格值**只键入** EditText+ENTER，不点推荐 chip（防「蓝色」→「湖蓝色」）
- 批量价库应用内数字键盘键间隔 **≥450ms**（同键连按 debounce；99 曾变成 9）
- 批量确认点**右下角**确定，不是中间 sheet 确定
- 包邮：多行合成节点按行心点（`freightOptionTarget`）
- 存草稿：点「存草稿」→「我知道了」；**永不发布**

## 已知问题

- 四机飞书并发 720s 超时（0/4，根因候选=长链共享 22222 串行化）
- 默认并发只走 01/02（conc2），03/04 暂不进入默认并发

## 相关

- 前置检查：`skills/shared/preflight`
- 传输层：`skills/shared/transport`
- 坑点手册：`skills/shared/pitfalls`
