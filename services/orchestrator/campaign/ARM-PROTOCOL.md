# 稳定性 campaign 臂协议（子代理执行手册）

你负责一台设备的「臂」。全程零人工，机械闸门 fail-closed。工作目录 `/Users/a1234/Desktop/Coding/xhs-registry`。

## 链路与参数（按你的 alias 查表）

| alias | device UUID | 链（每轮按序） | timeout_s |
|---|---|---|---|
| 01 | dev_6214d94d-cecf-4bd5-8688-f038bcf600eb | open→input→image→full | 180/270/300/840 |
| 02 | dev_d801a54b-0216-479b-a127-374c813ef709 | open→input→full | 180/270/840 |
| 04 | dev_8a943f25-b54e-409f-9712-333f9ae74a7f | manifest→image→full | 150/300/840 |

capability 全名：open=`xianyu.publish.open_dry_run`、input=`xianyu.publish.input_dry_run`、image=`xianyu.publish.image_dry_run`、full=`xianyu.publish.full_dry_run`、manifest=`xianyu.observe.image_manifest`。参数文件 `campaign/fixtures/<alias>-<step>.json`，**禁止修改内容**。

## 单步执行

```bash
bash campaign/step.sh <alias> <uuid> <capability> campaign/fixtures/<alias>-<step>.json <timeout_s> \
  stab3-<alias>-<step>-r<round>-a<attempt>-$(date +%s) claude-arm-<alias>
```
stdout 最后是终态 job JSON（记下 jobId 作证据）；退出码 0=绿 2=红 3=recovery 4=waiting_approval 5=超时 6=infra。
每步日志追加到 `campaign/logs/arm-<alias>.log`（jobId、退出码、耗时）。

## 轮次规则

- 目标：**3 个连续全绿轮**（一轮 = 链上每步都绿）。
- 步骤退出码 2：同 fixture 换幂等键（attempt+1）重试 1 次；再红 → 本轮判红，**臂终止**，写日志报告。
- 退出码 5（超时）：不重试不恢复，臂终止保留现场（job 可能仍在跑，报告 jobId）。
- 退出码 6：基础设施错误，重试 1 次；再错臂终止。
- 退出码 4：立即臂终止（免审批能力不该出现，说明系统异常）。
- 某轮判红但恢复成功 → 连续计数清零，从头再计 3 连轮；**总轮数上限 6**，超出臂终止。

## recovery_required（退出码 3）处理——只允许 main-safe 零动作恢复

自动恢复整臂预算 **2 次**，超出臂终止。步骤（cwd = /Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-device-agent-routing-v1-1）：

1. `node control-plane/devicectl.mjs --ssh xhs-windows job recover-inspect --job <jobId> --actor claude-arm-<alias> --idempotency-key rec-<alias>-<ts>` —— 读输出 JSON，找 inspection id 与截图/evidence 路径（Windows 路径）。
2. 把截图 scp 回本地（`scp xhs-windows:'<windows路径>' /tmp/arm-<alias>-inspect.png`，注意路径正斜杠化），用 Read 工具**亲眼看图**分类。
3. **只有**画面是闲鱼主页/首页且无任何弹窗、对话框、半屏 sheet、键盘（即 main-safe）且你置信 ≥0.9 时，才继续；否则停臂，报告分类结论与截图路径，保持隔离。
4. `job recover-inspect-record --job <jobId> --inspection <iid> --actor claude-arm-<alias> --idempotency-key recrec-<alias>-<ts> --analysis '<JSON>'`——analysis JSON 先试 `{"classification":"main-safe","confidence":0.97,"safeStateVerified":true}`；若报 schema 错误，按错误提示修正字段名重试，**最多 2 次**，仍失败停臂。
5. `job recover --job <jobId> --actor claude-arm-<alias> --idempotency-key recdo-<alias>-<ts>`——期望结果含 already-safe-main / safeStateVerified=true。5 分钟窗口：第 4、5 步必须紧接着做。
6. 经 registry 确认隔离已清：`ssh xhs-windows 'curl.exe -s -H "x-registry-token: REDACTED_OLD_AGENT_TOKEN" http://127.0.0.1:17930/api/agent-entry'` 中本设备 `state.quarantined=false`。

## 红线（违反即臂终止并如实报告）

- 只准调 `devicectl`（job submit/status/recover*），只准上表 capability，`--device` 钉死本臂 UUID。
- 禁止 session、GatewayOperator、lab action、approval approve/deny、改 fixture、碰其他设备、直写 control.db。
- 任何 waiting_approval / 未知页面 / 意料外输出：停下报告，不要发挥。

## 报告格式（最终回复）

每轮每步一行：`r<round> <step> <jobId> <exit> <耗时s>`；最后给：连续绿轮数、恢复次数、终态（COMPLETE 3/3 或 ABORTED@原因）、设备终态（online/quarantined/lease）。
