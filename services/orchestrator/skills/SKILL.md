---
name: xhs-device
description: 小红书/闲鱼多设备自动化 Skills 总入口。路由到具体的 device/xhs/xianyu skill，管理进化机制和知识沉淀。
triggers:
  - xhs-device
  - 设备操作
  - 手机操作
  - 小红书操作
  - 闲鱼操作
---

# XHS Device Skills 总入口

> 一句话：把散落的 ops/ 脚本沉淀成可发现、可组合、可进化的 Skills。
> 授权理念：**先探索能力边界，能做的越多越好。除了支付以外，agent 自主执行。**

## 三层架构

```
┌─────────────────────────────────────────────┐
│ 业务层（xhs/xianyu）                         │
│  点赞、收藏、关注、评论、搜索、发布、私信       │
│  → 组合原子操作，有业务语义                   │
├─────────────────────────────────────────────┤
│ 原子层（device）                             │
│  tap、swipe、dump、input、screenshot、focus  │
│  → 单一职责，可复用，可组合                   │
├─────────────────────────────────────────────┤
│ 共享层（shared）                             │
│  传输、解析、前置检查、坑点手册                │
│  → 所有 skill 的公共依赖和知识沉淀            │
└─────────────────────────────────────────────┘
```

## 授权模型（路线 B：自由优先）

```
完全自主（agent 直接做，不需要问人）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ 所有 Explorer lab 操作（22222 通道）
   - tap / swipe / dump / input / screenshot / focus / launch / back / shell
   - 点赞 / 收藏 / 关注 / 搜索 / 浏览
✅ R0 只读（observe.* 系列）
✅ R1 dry-run（publish.*_dry_run 系列）
✅ 探索新页面 / 新 App / 新流程

需要人审批（不可逆外发）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ 真发评论（xhs.comment.send）
⚠️ 真存草稿 / 真发布
⚠️ 真发私信

永远需要人（红线）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 支付 / 转账 / 充值
🔴 删除内容 / 注销账号
🔴 修改账号密码 / 绑定手机
```

### 原则

1. **默认自主**：agent 遇到没做过的操作，先尝试，不要先问「我能不能做」
2. **失败回退**：遇到验证码/风控/登录墙，立即停止并记录，不要硬闯
3. **留痕契约**：做了什么都要记录（知识库/pitfall/recipe），下次别人不重复踩坑
4. **探索优先**：新页面、新 App、新流程，先探索再固化成 skill

## 路由表

| 你想做什么 | 去哪 | 自由度 |
|-----------|------|--------|
| 点赞笔记 | `skills/xhs/xhs-like` | ✅ 自主 |
| 收藏笔记 | `skills/xhs/xhs-collect` | ✅ 自主 |
| 关注作者 | `skills/xhs/xhs-follow` | ✅ 自主 |
| 评论笔记 | `skills/xhs/xhs-comment` | ⚠️ 需审批 |
| 综合互动 | `skills/xhs/xhs-engage` | ✅ 自主（评论除外） |
| 搜索笔记 | `skills/xhs/xhs-search` | ✅ 自主 |
| 发布笔记 | `skills/xhs/xhs-publish` | ✅ 填草稿自主，真发布需审批 |
| 私信用户 | `skills/xhs/xhs-dm` | ⚠️ 需审批 |
| 闲鱼发布 | `skills/xianyu/xianyu-publish` | ✅ dry-run 自主 |
| 闲鱼快照 | `skills/xianyu/xianyu-snapshot` | ✅ 自主 |
| 点击屏幕 | `skills/device/device-tap` | ✅ 自主 |
| UI dump | `skills/device/device-dump` | ✅ 自主 |
| 输入中文 | `skills/device/device-input` | ✅ 自主 |
| 截屏 | `skills/device/device-screenshot` | ✅ 自主 |
| 滑动 | `skills/device/device-swipe` | ✅ 自主 |
| 返回 | `skills/device/device-back` | ✅ 自主 |
| 启动 App | `skills/device/device-launch` | ✅ 自主 |
| ADB shell | `skills/device/device-shell` | ✅ 自主 |
| 前台焦点 | `skills/device/device-focus` | ✅ 自主 |
| 前置检查 | `skills/shared/preflight` | — |
| 传输层 | `skills/shared/transport` | — |
| 解析库 | `skills/shared/parse` | — |
| 坑点手册 | `skills/shared/pitfalls` | — |

## 开工前

```bash
# 查看 live 状态
ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/agent-entry.md'

# 前置检查
node ops/explore-preflight.mjs --alias 01
```

**检查通过就直接动手，不要先问「我能不能做」。**

## 进化机制

### Skills 怎么变强

```
agent 自主探索 → 发现新能力/新坑 → 写入知识库 → 更新 skill → 再验证
    ↑                                                        |
    └──────────────── 版本升级 ←─────────────────────────────┘
```

### 知识沉淀规则

1. **踩坑必记**：遇到新的坑 → 写入 `skills/shared/pitfalls.md` + 知识库
2. **验证必留**：真机验证通过 → 更新 skill 的 `verified` 字段
3. **失败必查**：skill 执行失败 → 检查是否已有同题 pitfall
4. **新能力必固化**：探索发现新操作 → 固化成新 skill 或更新现有 skill

### 版本号规则

- `v0.x` — 实验性，未真机验证
- `v1.0` — 首次真机验证通过
- `v1.x` — 小修（坑点补充、参数调整）
- `v2.0` — 行为变更（不向后兼容）

## 红线（只有这些）

| 禁止 | 原因 |
|------|------|
| 支付/转账/充值 | 资金安全 |
| 删除内容/注销账号 | 不可逆 |
| 遇验证码/风控继续点 | 账号安全 |
| 写 control.db | 数据完整性 |

**不在红线里的，都可以做。**

## 环境

- **Mac**：skills 定义 + 脚本源码 + 测试
- **Windows**：控制面 17920 + registry 17930 + 设备 serve
- **手机**：01-04 经 USB → Windows → 小薇 22222
