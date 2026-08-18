# fast-operator 脚本式 task-runner 方案

## 背景

fast-operator 旁路原语层已闭环并真机验证（Slice 1+2+3：刷新/点赞/收藏/评论(图文+视频)/进主页/刷主页视频/不进正文点赞，PR #4 已 merge，偶发 bug 修复 PR #5）。但它只是**原语服务**——`serve` 在 17895 暴露 ~30 个原子动作，CLI 只有 `serve` / `demo-scroll`，**没有任务编排层**，不能"按一定任务序列自动跑"。

本轮做**脚本式 task-runner**：读任务定义 JSON（一组原语 steps + loops + 拟人间隔），loop 在进程内直接调 `FastOperator` 原语自动跑，带封号风控（评论频次上限、步间/圈间拟人停顿、视频/带货跳过、SIGINT 优雅退出）。LLM 自主决策层留后续，叠在本层之上。

## 设计要点

- **in-process import 复用**：`task-runner.mjs` `import { FastOperator, Pacer, applyCommentFlags }`，进程内调原语，省 dump（HTTP 路每步自带 dump，与"少 dump"哲学相悖）。`fast-operator.mjs` 末尾加一行 `export { Pacer, applyCommentFlags }`（纯加性，`FastOperator` 已 export）。
- **循环骨架**：照抄 `noteBenchmark` 的 `runs[]+step 码+backToFeed(5) 兜底` 模式（不抄 `demoScroll`——它有 `observeFeed` 死方法坑）。
- **step dispatch**：scrollN / likeCard / likeDetail / favoriteDetail / commentOnOpenNote / openProfile / scrollProfile / playProfileVideo / backFromNote / backFromProfile / backToFeed / rest。
- **skip 语义**：评论步骤返回 `detailfeedUnsupported`（带货）/ `editorLostAfterInput` / `commentBox` / `sendButton` / `inputText` → 记 skip 继续，不 abort（异构 UI 偶发，不因单张失败中断整轮）。
- **封号风控**：默认 `commentCap=2/圈`、圈间 8-20s、步间 0.8-2.5s 拟人；`--fast` 牺牲拟人度换吞吐默认关。评论仍遵守 Slice 2 约束（非作者最高赞改写直发，已验证链路）。
- **`--dry-run`**：评论步骤视频走 `commentOnVideoNote({dryRun:true})`（zero-send），图文仅 open+back（零输入零发）。
- **SIGINT 优雅退出**：设 stopFlag，当前步跑完才 `backToFeed(5)+close`，不在 dump/输入中途强杀（避免留编辑器开/IME 错乱）。

## 任务模板（`scripts/tasks/*.json`）

- `养号.json` — scrollN×3 + likeCard idx0,1（无评论）
- `涨粉.json` — scrollN×3 + likeCard idx0 + commentOnOpenNote idx1（skipVideo，comment-cap 1）
- `互动.json` — scrollN×2 + commentOnOpenNote idx0,1（comment-cap 2）
- `纯刷.json` — scrollN×5（零互动，纯刷屏吞吐）

## CLI

```
node task-runner.mjs --adb <adb.exe> --serial <serial> --task <tasks/养号.json>
  [--loops N] [--comment-cap N] [--dry-run] [--log-dir <dir>] [--on-error skip|abort]
  [--fast] [--pace-fast] [--ime-sticky] [--verify light|strict]
  [--llm-endpoint ... --llm-key ... --llm-model ... --xw-ws ... --xw-bridge-ime ...]
```

`--fast` / `--llm-*` / `--xw-*` 透传给 `applyCommentFlags`（它直接读 `process.argv`）。

## 日志

每圈一行 JSON 落 `scripts/logs/task-<name>-<ts>.jsonl` + stdout，字段 `{loop, ms, steps:[{action,idx,ok,step,ms,skipped}], commentCount, metrics}`。收尾 summary。

## 改动文件

- `scripts/fast-operator.mjs` — 末尾加 `export { Pacer, applyCommentFlags };`（1 行，纯加性）
- `scripts/task-runner.mjs` — 新建主程序
- `scripts/tasks/{养号,涨粉,互动,纯刷}.json` — 新建模板
- `docs/device-task-handoffs/2026-07-20-task-runner-plan.md` — 本文档

## 验证

1. `node --check` 两文件。
2. dry-run 真机 `养号.json --loops 2 --dry-run` → loop 骨架/步间停顿/日志/SIGINT。
3. 养号真机 `--loops 3`（纯点赞零评论低风险）→ likeCard、metrics、圈间停顿。
4. 涨粉真机 `--loops 2 --comment-cap 1` → commentOnOpenNote、skipVideo/skipGoods、commentCap、countDelta verified。
5. 恢复设备 IndexActivityV2 干净态 + IME=SogouIME，清临时脚本。

## 风险与约束

- 仅 loopback / 进程内直连 op，不经网络；任务定义 JSON 本地文件。
- 不碰私信（沿用现有约束）。
- detached 启动复用 relaunch3.ps1 的 WMI 模式。
- 远端 ssh shell 是 PowerShell：不支持 `&&`/`cd /d`/`| findstr`；直跑 adb 用 node `child_process.spawnSync`。
