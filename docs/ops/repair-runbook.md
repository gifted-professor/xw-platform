# Repair Runbook — 现场故障与修复记录

> 每条记录 = 症状 → 诊断命令 → 根因 → 修复动作 → 预防。
> 目标：每个条目最终固化成 `/xw repair` 可自动执行（或半自动确认执行）的 recipe。
> 未固化的条目只能由人或有授权的 agent 手动按步骤执行，执行后补记执行结果。
>
> 红线不变：禁止无 lease 碰机、禁止直写 control.db、修复动作本身也要留证据。

## 条目格式

```text
RP-NNNN  <一句话标题>
状态      active（会复发）/ mitigated（有临时修复）/ fixed（已固化）
症状      可被机器检测到的表现（错误码、端口状态、health 字段）
诊断      按顺序执行的只读命令
根因      确认后的结论
修复      具体动作（命令级）
预防      怎样才能不再发生 / 谁负责巡检
```

---

## RP-0001  ADB 双 server 抢设备（5037 vs 5038）

状态：fixed（已脚本化进 `services/orchestrator/ops/xw-repair.mjs --fix rp-0001`，2026-08-20 实战验证）

实战记录：
- 2026-08-20 首次：02/04 observe 失败，手动按本条目修复（kill 5037 + 重启 serve），四机全绿
- 2026-08-20 当天复发：03 再次被 5037 抢走（`D:\Ksoftware` 的 adb server 复活）。改用新脚本
  `xw-repair.mjs --check` 检出 → `--fix rp-0001 --confirm` 自动修复 → observe 验证 succeeded。
  证明 recipe 可机器执行。**但 5037 server 仍会复活，断根动作（查清并停用 D:\Ksoftware 那套）仍未做。**

症状：
- `xhs.observe.feed` 在部分机器上稳定失败：`ADAPTER_REJECTED / OPERATOR_ERROR: hierarchy dump incomplete / step=feedCards`
- 同一时刻 `xiaowei.explorer.primitive` 的 launch_app / screen / dump_ui 全部正常（走效卫 transport 22222，不经 ADB）
- 效卫 UI 显示设备在线，但 serve 侧 uiautomator dump 拿不到完整 hierarchy

诊断（全部只读）：

```bash
ADB="/c/Program Files (x86)/xiaowei_android/tools/adb.exe"
# 1. 分别问两个 adb server 各看到几台设备
ANDROID_ADB_SERVER_PORT=5037 "$ADB" devices -l
ANDROID_ADB_SERVER_PORT=5038 "$ADB" devices -l
# 2. 谁占着 5037（本机实测是第二套效卫安装的 adb.exe）
powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort 5037 | Select-Object -First 1 | ForEach-Object { (Get-Process -Id \$_.OwningProcess).Path }"
# 3. 逐台验证设备侧 uiautomator 本身没坏（排除手机问题）
ANDROID_ADB_SERVER_PORT=5038 "$ADB" -s <serial> exec-out uiautomator dump /dev/tty | tail -c 100
```

根因：
机器上存在两套效卫 Android 工具：
- `C:\Program Files (x86)\xiaowei_android\tools\adb.exe` —— fast-operator serve 固定使用，`ANDROID_ADB_SERVER_PORT=5038`（权威口）
- `D:\Ksoftware\xiaowei_android\tools\adb.exe` —— 另一个 adb server 抢占 5037 并认领了部分设备（2026-08-20 实测 02=9b18cccb、04=H6NNHU8LLFHAIRLV 被挂在 5037）

设备被 5037 server 认领后，serve 经 5038 发起的 uiautomator dump 流被截断 → `hierarchy dump incomplete`。效卫 UI 与 Explorer 走 transport 22222，不受影响，造成"看起来全通"的假象。

触发方式之一：任何不带 `ANDROID_ADB_SERVER_PORT=5038` 的 adb 调用会在 5037 拉起一个新 server 并可能把 USB 设备抢过去。

修复（2026-08-20 已执行，有效）：

```bash
ADB="/c/Program Files (x86)/xiaowei_android/tools/adb.exe"
# 1. 杀掉 5037 上的野 server，设备会回到 5038
ANDROID_ADB_SERVER_PORT=5037 "$ADB" kill-server
# 2. 确认四台都在 5038
ANDROID_ADB_SERVER_PORT=5038 "$ADB" devices
# 3. 重启受影响别名的 fast-operator serve（持久 adb shell 已中毒，必须重启）
#    alias→listenerPid 映射见 xw-runtime\logs\fast-operator\lifecycle-events.jsonl 最新 task-started
powershell -NoProfile -Command "Stop-Process -Id <listenerPid> -Force"
powershell -NoProfile -Command "Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','C:\Users\Public\xw-runtime\launch-fast-operator-serve.ps1','-LaunchConfig','C:\Users\Public\xw-runtime\state\control-plane\fast-operator\serve-launch-<alias>.json'"
# 4. 验证：launch_app 小红书 → 提交 xhs.observe.feed → succeeded
```

预防（未做，按优先级）：
1. 查清 `D:\Ksoftware\xiaowei_android` 是哪个软件在用，停用或卸载；至少禁止它常驻 5037
2. 所有脚本/agent 调 adb 必须显式 `ANDROID_ADB_SERVER_PORT=5038`（写进 /xw 与 agent-entry 的硬规则）
3. `xw-start --check` 已有 wrong_port 检测（5037 只作诊断证据）——但它还指向 retired 路径，等 P0 迁移后才能上岗
4. 固化成 repair recipe：`wrong_port → kill-server(5037) + 重启对应 serve`，由 `/xw repair` 半自动执行

---

## 待固化 recipe 清单（ roadmap ）

| recipe | 检测信号 | 修复动作 | 状态 |
|---|---|---|---|
| RP-0001 wrong_port | devices 分布在非 5038 server | `xw-repair.mjs --fix rp-0001 [--confirm]` | fixed，已脚本化并实战验证 |
| serve 掉线 | 17895-17898 端口不听 | launcher 重启 | 待计划任务化（P0-2） |
| adb shell poisoned | ADAPTER_REJECTED process.error | 重启该 alias serve | 已知模式，待脚本化 |
| 前台非小红书 | VERIFICATION_FAILED pageClass=xhs.unknown | launch_app + 复查 focus | 已在 /xw 概念内 |
