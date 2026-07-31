# 坑点手册（Pitfalls）

> 真机验证中踩过的坑。新 agent 开工前必读，踩坑后必写。

## VLM 视觉偏移

### pitfall-vision-vlm-y-bias-20260727

**问题**：VLM（如 mimo-v2.5）对绝对像素 Y 系统性偏低。

| 场景 | dump Y | vision Y | 偏差 |
|------|--------|----------|------|
| XHS 底栏 | 2279 | 949 | **ΔY=−1330px** |
| 微购 | — | — | −160~−179px |

**规则**：有 bounds 时**禁止**用 vision 像素。优先 dump/语义；dump 空时 vision 限次且宜出区域描述而非裸坐标。

---

## Flutter 输入

### pitfall-input-text-multiline-refocus-20260727

**问题**：Flutter（闲鱼）多行输入时，每行都 refocus 会导致光标跳位/乱序。

**规则**：
- 首行：`--x --y` refocus
- 后续行：`--no-refocus` + `--keep-ime`
- SKU 规格值：加 `--enter`

---

## 收藏误报

### pitfall-collect-false-negative-20260728

**问题**：收藏后 a11y label 滞后于服务端计数，verify dump 抓到未翻转底栏。

**规则**：用**计数比对**（21→22 即成功）+ 未确认则再等 1200ms 重 dump 一次。

---

## 关注按钮状态

### pitfall-follow-btn-state-20260729

**问题**：`findFollowBtn` 旧版精确匹配 `关注`，关注后变 `已关注` 找不到 → 误判失败。

**规则**：用 exact-set 等值 `{关注, 已关注, 回关, 相互关注}`，先判已关注避免子串误中。

---

## 四机并发超时

### pitfall-feishu-xianyu-conc4-transport-timeout-20260728

**问题**：四机飞书并发 0/4 超时（720s 上限）。根因候选=长链共享 22222 串行化。

**规则**：默认并发只走 01/02（conc2），03/04 暂不进入默认并发。

---

## 计划任务 idle 杀手

### pitfall-task-stop-on-idle-20260726

**问题**：`XhsDeviceRegistry` 计划任务 `StopOnIdleEnd=true`，导致 17930 被终止。

**规则**：重装任务后必须回验 `StopOnIdleEnd=false`。安装脚本已固化 `-DontStopOnIdleEnd`。

---

## task-launch.json gitCommit 格式

### pitfall-task-launch-short-hash-20260727

**问题**：task-launch.json 的 gitCommit 填短 7 字符 hash，触发 `Repository commit mismatch` 闸门。

**规则**：必须填**完整 40 字符** `git rev-parse HEAD`。

---

## 03 恢复正则不一致

### pitfall-recovery-safe-main-regex-20260727

**问题**：`isRecoverySafeMain` 的 `/^消息[,，]/` 只认逗号后缀，03 a11y 暴露裸 `消息` → false-negative。

**规则**：统一用 `/^消息(?:$|[,，])/`，接受裸标签。

---

## SKU 全选位置

### pitfall-wp1a-03-sku-hand-nav-blocked-20260727

**问题**：03 的 SKU 全选不在规格页，在价库批量页。

**规则**：miss 时读 `output.selectAllMiss` 的 labels 原文再改正则。

---

## 抖音（douyin）

> 探索产出：`explore-douyin-*` knowledge + Windows 草稿 `tmp-know/douyin-explore-01.md`（01 / 2026-07-31）。App 级能力地图见 [`skills/douyin/SKILL.md`](../douyin/SKILL.md)。

### pitfall-douyin-splash-activity-name-20260731

**问题**：抖音首页/朋友/消息/我四个 Tab 长期挂在 `…splash.SplashActivity`，**Activity 名不是闪屏过渡页**。靠 Activity 名判当前页会全错。

**规则**：判 Tab 看底栏选中文案 / 顶栏（`已选中，推荐` / `编辑主页`），不看 Activity。搜索（`SearchResultActivity`）、拍摄（`VideoRecordNewActivity`）、设置（`DouYinSettingNewVersionActivity`）才是独立 Activity。

### pitfall-douyin-friend-follow-empty-dump-20260731

**问题**：朋友 Tab、关注顶栏 Tab dump 经常空（弱 class / 动态加载），与首页推荐 Feed 不同。

**规则**：朋友/关注 Tab **优先截图兜底**，不强磕 dump。属 dump-first 降级策略的已知实例（见 explorer.md §5）。

### pitfall-douyin-swipe-empty-dump-20260731

**问题**：推荐 Feed 上滑切下一条后偶发空 dump。

**规则**：settle 2–5s 重试；顽固则 `--force-stop` 再 `launch-app`。勿在空 dump 上盲点坐标。

### pitfall-douyin-sidebar-content-mutable-20260731

**问题**：首页侧边栏入口内容随账号状态变（本次落到作者「日常/Detail」流，非设置抽屉）。

**规则**：侧边栏 **勿写死假设**（≠ 设置抽屉）。点开后先 dump/截图确认落在哪，再决定下一步。

### pitfall-douyin-bottombar-text-not-clickable-20260731

**问题**：底栏五键（首页/朋友/拍摄/消息/我）text 常为 `clickable=false`。

**规则**：底栏**点中心坐标仍有效**，不能靠 `clickable` 判可用。坐标见 [`skills/douyin/SKILL.md`](../douyin/SKILL.md) 底栏表。

### pitfall-douyin-miui-shoot-permission-20260731

**问题**：拍摄入口常先弹 MIUI 相机权限对话框（`是否允许"抖音"拍摄照片或录制视频`）。

**规则**：自动化选**拒绝**（不进录制页）。即使进 `VideoRecordNewActivity` 也只观察，**拍摄/上传/开直播属红线外发**，需人审批。勿点「仅在使用中允许」再硬拍。

### pitfall-douyin-collect-tap-kills-a11y-dump-20260731

**问题**：推荐 Feed 点收藏后，真藏成功（黄星 + toast「收藏成功」），但随后长时间 `dump missing hierarchy` / `uiautomator could not get idle state`，脚本无法用 dump 做 desc 翻转校验。force-stop 可恢复 dump，但 Feed 已换条，无法回验同一视频。

**规则**：`douyin-collect` **以 dry-run 定位为 v1.0 主验收**；真藏 dump 校验未稳前勿把「真藏 ok」当自动门槛。点后若需确认，优先截图看黄星/toast。点后 dump 死锁 → force-stop 恢复，勿空转重试过久。

### pitfall-douyin-teen-mode-blocks-feed-dump-20260731

**问题**：02 等机首次/久未开抖音时弹出「儿童/青少年模式」「我知道了」，挡住推荐 Feed；点过后仍可能长时间空 dump。

**规则**：多机跑 douyin-* 前先确认已过青少年模式引导且 Feed dump 可见「未点赞/未选中，收藏」。未过引导的设备不进 dry-run 验收统计。

### pitfall-douyin-04-no-login-skip-sets-20260731

**问题**：04 机抖音**未登录账号**，Feed/右侧栏不可用，表现为 `dump_feed` / 空层，易被误判成青少年模式或 a11y 故障。

**规则**：集合默认只跑 **01,02**；**勿把 04 加进 like/collect/follow/rail-set**。登录后再纳入。

### pitfall-douyin-rail-needs-force-stop-each-op-20260731

**问题**：`douyin-rail-set` 同机 like→collect→follow 若后续 op 带 `--no-force-stop`，01 易连环 `dump_feed`。

**规则**：rail-set **每个 op 都 force-stop**（默认）；不要为省时间省掉。

---

## 新增坑点模板

发现新坑时，按此模板补充：

```markdown
### pitfall-<name>-<date>

**问题**：<一句话描述>

**规则**：<怎么避免/怎么处理>

**来源**：<知识库 id / job id / 验证记录>
```
