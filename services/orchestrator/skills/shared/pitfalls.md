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

## 新增坑点模板

发现新坑时，按此模板补充：

```markdown
### pitfall-<name>-<date>

**问题**：<一句话描述>

**规则**：<怎么避免/怎么处理>

**来源**：<知识库 id / job id / 验证记录>
```
