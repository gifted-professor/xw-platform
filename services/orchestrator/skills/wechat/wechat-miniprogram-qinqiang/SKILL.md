---
name: wechat-miniprogram-qinqiang
description: 微信小程序「擒墙Beta」探索执行手册。vision-only；搜馆/筛选/详情/日历/Tab/约伴；禁支付与真登录。
triggers:
  - wechat-miniprogram-qinqiang
  - 擒墙Beta
  - 擒墙
  - 攀岩小程序
version: "0.1"
verified:
  - date: 2026-08-01
    device: "02"
    result: pass
    note: "入口→首页筛→多馆详情(香蕉/闪电/Upper/征岩/擎天)→日历翻月/选日/qty→底栏三 Tab→约伴表单登录墙；未点立即购买"
  - date: 2026-08-01
    device: "01"
    result: pass
    note: "同入口链路曾通；底栏 Y 与 02 三键机不同"
changelog:
  - version: "0.1"
    date: 2026-08-02
    change: "从 tmp-know/qinqiang-beta-replica 探索收编为 wechat 业务 skill（无 ops 脚本，手工+ops 原子）"
depends:
  - device-tap
  - device-input
  - device-swipe
  - device-focus
  - device-launch
  - device-shell
  - device-screenshot
  - shared/preflight
---

# 微信小程序 · 擒墙Beta（wechat-miniprogram-qinqiang）

> 一句话：在微信里打开「擒墙Beta」，用 **vision + 坐标** 跑通搜馆/详情/日历/Tab（**dump 恒空**）。  
> `v0.1` / 真机探索已过；**尚未**固化独立 `ops/wechat-qinqiang-*.mjs`（下一刀）。

## 元信息

| 项 | 值 |
|----|----|
| 宿主包 | `com.tencent.mm` |
| 小程序 Activity | `…appbrand.ui.AppBrandUI00`（入口亦见 `AppBrandUI01`） |
| 探索主设备 | **02** / `REPLACE_SERIAL_02`（微信已登录 `芒果好吃` / `mghhc888`） |
| 辅设备 | 01 同入口曾通 |
| 素材真源 | `tmp-know/qinqiang-beta-replica/`（`FEATURES.md` + 截图） |
| 短报 | `tmp-know/EXPLORE-WECHAT-QINQIANG-BETA-20260801.md` |

## 授权 / 红线

| 动作 | 自由度 |
|------|--------|
| 开微信、搜小程序、浏览列表/详情、筛地区/类型、翻日历、qty±、切 Tab、进约伴表单看到登录墙 | ✅ 自主 |
| 点「立即购买」/ 支付 / 钱包 | 🔴 禁 |
| 点「微信登录」完成授权 | ⚠️ 需人明确授权 |
| 真发约伴/帖子 | ⚠️ 登录后仍属外发，需人 |

## 开工

```powershell
cd C:\Users\Public\xhs-registry
$env:XHS_LOCAL=1
node ops/explore-preflight.mjs --alias 02
node ops/launch-app.mjs --alias 02 --package com.tencent.mm
node ops/focus.mjs --alias 02
# 截屏：screenshot-and-analyze 偶发 0 字节 → 用 _win-screencap
node ops\_win-screencap.mjs --serial REPLACE_SERIAL_02 --out C:\Users\Public\xhs-registry\tmp-know\_shot.png
```

**策略**：`AppBrandUI*` 上 `dump-ui` ≈ NODES=2 / 空 FrameLayout → **禁止 dump-first**；靠截图 + 像素/人眼定坐标。系统权限框（MIUI 定位）例外，可 dump。

## 入口链路（已验）

```
微信 Tab（必要时先点底栏「微信」）
→ 顶栏放大镜 → FTSMainUI
→ input-text「擒墙Beta」
→ 点「搜索网络结果」建议（约 Y=540，随机型变）
→ MMFTSSOSHomeWebViewUI：点小程序卡（约 Y=610）
→ AppBrandUI00
→ 位置：小程序「允许」→（02）MIUI「仅在使用中允许」
→ 首页（附近岩馆）
```

命令骨架：

```powershell
node ops/tap.mjs --alias 02 --x 135 --y 2180          # 微信 Tab（02 三键）
# 放大镜：视首页布局，常用顶栏右侧；以截图为准
node ops/input-text.mjs --alias 02 --text "擒墙Beta" --x 540 --y 400 --enter
```

## 小程序坐标契约（02 / 1080×2400 / 三键）

| 目标 | 约坐标 | 备注 |
|------|--------|------|
| 小程序底栏 首页/社区/订单/我的 | X≈135/400/670/940，**Y≈2180** | **Y=2100 会落空**；详情页 FAB「转发截图」挡右下 → 先回首页再切 Tab |
| 类型 chips（有公告） | **Y≈900–940** | 用选中态 lime 像素定位，勿写死 600 |
| 类型 chips（无公告/精简顶栏） | **Y≈410–430** | 全部地区时常如此 |
| 地区 pill | 顶栏左侧（有公告时约 Y≈500；无公告更靠上） | 打开「选择地区」sheet |
| 馆卡进详情 | 点 **logo/店名区**，勿点底行「写下本期线路评价」 | 评价行会进评价子页 |
| 日历月 `>` / `<` | 约 X=960 / 120，Y≈1450 | 随滚动变；先截图 |
| 购买条 qty ± | 购买条中部，约 Y≈1960 | **勿点「立即购买」** |

## 产品执行要点（agent 必读）

完整字段/对照表见 `FEATURES.md`。执行时记住：

1. **核销两套路**  
   - A（香蕉/闪电/Upper）：`外部领取` → 馆方小程序卡包 → 前台扫码  
   - B（征岩/擎天）：前台报卡号(+电话) →「我已入馆」；擎天另有当日退款/勿提前>1天  
2. **日历事件语义不同**：墙面区块名 / 训练主题绿条 / 周循环「老带新·换线」/ 比赛·免费日——勿当同一 schema  
3. **可选模块**：线路图卡（仅部分香蕉）、周边餐厅（闪电见过）、社区约伴「找一起去」  
4. **登录墙**：订单/我的/发帖/部分评价 CTA → 停，记 pitfall，勿硬登  

## 推荐验收路径（手工 / 下一刀脚本化）

```
preflight 02
→ launch 微信 → 搜「擒墙Beta」进小程序
→ 地区=深圳（或空搜快捷 pill）
→ 类型=全部类型（lime 选中）
→ 进一家外部领取馆（如 Upper-南光）截顶栏+日历
→ 进一家卡号馆（若列表有征岩等）对照使用方法文案
→ 首页底栏：订单 / 社区 / 我的 各截一帧（未登录空态即可）
→ back 出小程序；不点购买
```

成功判据：`FOCUS` 含 `AppBrandUI`；至少 2 家详情截图；未触发支付。

## 素材索引

| 路径 | 用途 |
|------|------|
| `tmp-know/qinqiang-beta-replica/FEATURES.md` | 复刻/字段权威 |
| `…/01-home/31-region-picker.png` | 地区 sheet |
| `…/01-home/34-upper-search-sz.png` | Upper×深圳 |
| `…/02-gym-detail/compare/shandian-gangxia-*.png` | 闪电 |
| `…/02-gym-detail/compare/upper-nanguang-*.png` | Upper |
| `…/02-gym-detail/compare/zhengyan-detail-*.png` | 征岩卡号核销 |
| `…/02-gym-detail/compare/qingtian-*.png` | 擎天退款文案 |
| `…/05-tabs/orders/10~12*.png` | Tab 空态 |
| `…/05-tabs/orders/14-partner-login-wall.png` | 约伴登录墙 |

## 下一刀

- [ ] `ops/wechat-qinqiang-open.mjs`：launch→搜→进小程序→FOCUS 断言  
- [ ] `ops/wechat-qinqiang-home-shot.mjs`：地区/筛/列表截屏包  
- [ ] 周边餐厅子页、Upper 另外两店对照  
- [ ] Mac `adopt-from-windows` 收编本 skill  

## 变更说明

原来：`skills/wechat/SKILL.md` 仅壳层；02「未核微信」；无小程序业务 skill。  
现在：02 已登录可用；新增本 skill + 素材目录指针；支付/登录仍红线。  
为什么：2026-08-01~02 探索已跑通可复用执行契约，避免下次从零猜坐标与核销模型。
