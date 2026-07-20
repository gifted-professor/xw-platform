# dashboard — xhs-device-agent 操作面板

4 台真机的 web 监控 + 启停面板,经 Tailscale tailnet 暴露。零侵入:不改 `fast-operator.mjs` / `task-runner.mjs` / 4 个 serve / task 模板。

## 起法

```bat
:: Windows 上(WMI detached,随 ssh 存活)
run-dashboard.bat
```
或直接:
```bat
"D:\Program Files\Node\node.exe" "scripts\dashboard.mjs"
```
默认监听 `0.0.0.0:17900`。日志 `scripts/logs/dashboard.log`。

## 暴露到 tailnet

```bat
"C:\Program Files\Tailscale\tailscale.exe" serve --bg --https 17901 http://localhost:17900
```
打开 `https://<xhs-windows>.<tailnet>.ts.net:17901/`(手机开 tailscale 即可)。
关:`tailscale serve --https=17901 off`。也可直接用 tailnet HTTP `http://<host>:17900/`。

## 路由

| 方法 路径 | 作用 |
|---|---|
| GET `/` | 静态页 `dashboard/index.html` |
| GET `/status` | 4 台聚合(activity/IME/serve 健康/累计 metrics;活跃任务期间跳过 focus/IME 降 adb 抢占) |
| GET `/tasks` | `tasks/*.json` 任务名列表 |
| POST `/task` | `{serial,action:start|stop,task,loops,commentCap}` spawn/kill `task-runner.mjs` |
| POST `/home` | `{serial}` → `adb shell monkey -p com.xingin.xhs` 拉回首页 |

## 状态来源

- **activity / IME**:dashboard 自己 one-shot `adb shell dumpsys window` / `settings get secure default_input_method`(serve 的 `focus` 走持久 shell 实测会 10s 超时,one-shot 更可靠)。
- **serve 健康**:`POST {"action":"metrics"}` 200 即活(进程内计数,无 adb)。
- **任务进度**:spawn `task-runner.mjs` 子进程,实时捕获 stdout `{phase:"loopDone",loop,ok,skip,comments}` 累加(serve/task-runner 不存累计评论数,dashboard 自己累加)。
- **任务启停**:dashboard 直接 spawn 子进程(node fs 直读 `tasks/养号.json` 等中文名,绕开 ssh/PowerShell 中文引号坑)。

## 注意

- task-runner 跑批时与该 serial serve 各持一条持久 adb shell;dashboard 轮询的 focus/IME 是 one-shot,干扰可控,且活跃任务期间该卡跳过 focus/IME。
- dashboard 退出(SIGINT/SIGTERM)会杀掉所有运行中的 task-runner 子进程,避免手机无人值守继续跑。
- 运行态在 dashboard 进程内存,重启则丢失(已跑的子进程会变孤儿被一并 kill)。
- 设备表、adb/node/CPA 路径硬编码在 `dashboard.mjs` 顶部,换机改那里。