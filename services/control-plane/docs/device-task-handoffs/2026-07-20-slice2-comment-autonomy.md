# 2026-07-20 Slice 2：fast-operator 评论自主（comment autonomy）

## 目标
让 AI 员工高速自主发评论，单条 30-60s → 5-8s。策略：抓评论区点赞最高的**非作者**评论 → LLM 改写微调 → 经 xiaowei WS 网关 inputText 输中文 → 发送。避免硬编码文案、避免与高赞评论完全重复被风控判垃圾。

## 架构决策
- **fast-operator 保持 Windows 自包含**。评论导航走持久 adb shell；中文输入借 xiaowei WS 网关（一次 WS 往返，网关常驻 daemon）。
- **改写在 fast-operator 内直调 CPA LLM**，不依赖 Mac 侧 `ai-role-runner.mjs`。因此 **Mac 侧围栏（`FORBIDDEN_OUTPUT_PATTERN` + `comment_assistant` 人类触发）保持不动**——独立旁路自带内容生成，零回归。
- **排除作者评论**：parseComments 识别"作者"badge，topComment 只在非作者里选。

## 新增原语（`scripts/fast-operator.mjs`）
- `commentBox(doc)` — 底部评论入口框（content-desc="评论框"），退路：底部条最左 clickable TextView
- `scrollToComments({maxScrolls})` — 下滚直到 dump 出现评论 item
- `parseComments(doc)` — 几何锚定 username TextView，解 `{username,text,likeCount,isAuthor}`；**作者 badge 过滤**；likeCount 用时间戳行 y 锚定（避免误抓底部互动条评论总数）
- `topComment(comments)` — 非作者里点赞最高
- `commentEditor(doc)` / `sendButton(doc)`
- `xiaoweiInvoke(action,data)` — WS 网关单请求（ws://127.0.0.1:22222/，code 10000=SUCCESS）
- `currentIme()` / `setIme(ime)`
- `inputTextViaXiaowei(text,{deferRestore})` — selectIme→bridge→清空→inputText；**deferRestore 延迟 IME 还原到发送后**（还原会令编辑器失焦关闭）
- `rewriteComment(text)` — CPA LLM 改写，失败回退规则
- `commentOnOpenNote({text})` / `commentTransaction(card,{text})` — 全流程编排

## HTTP actions（serve:17895）
commentTransaction / commentOnOpenNote / openCommentSection / parseComments / rewriteComment / commentBox / inputTextDryRun（零发送）/ backFromProfile

## CLI flags
`--llm-endpoint` `--llm-key` `--llm-model` `--xw-ws` `--xw-bridge-ime`

## CPA LLM
- endpoint: `http://100.84.194.46:8317/v1/chat/completions`
- key: `cliproxy-codexapp`
- model: `gpt-5.4-mini`（注意：`gpt-4o-mini` 在 CPA 报 "unknown provider"，CPA 用自有 model 名表）

## 真机验证（01, serial REPLACE_SERIAL_01）
1. parseComments dry-run：7/7 评论全解，作者评论(盛荷牧场)被 isAuthor=True 排除 ✓
2. rewriteComment 离线：`有没有不加糖的…原味[害羞R]` → `请问有不加糖的款吗？我想先试试最原始的味道[害羞R]` ✓
3. inputTextViaXiaowei dry-run（零发送）：全程 audit 绿，BACK 清零、无评论发出、设备回 feed ✓
4. **真发**：用户指定笔记（外卖小哥/白敬亭，2338 评论），深链打开→top非作者(Kelsie不是你～,赞314)→改写"这位小哥我好像见过，难道他就是白敬亭吗🤔"→用户确认→发送→**评论数 2338→2339 验证发出 ✓**，单条 17.4s

## 关键坑
- **IME 还原时机：** 不能在 `finally` 发送前 selectIme 还原，否则编辑器(NoteCommentActivity)失焦关闭、sendButton 找不到、评论丢弃。必须 deferRestore 到发送后。
- **likeCount 误抓：** 底部互动条的笔记评论总数会被宽 y 范围的 likeCount 检测误当某评论赞数。用时间戳行 y 锚定（|cy-tsCy|<45）解决。
- **深链：** 网页 URL 落浏览器，需转 `xhsdiscover://item/<noteId>?xsec_token=...`。
- **Windows detached 进程：** `start /B` 不脱离 ssh；用 WMI `Win32_Process.Create("cmd /c x.bat")`。8.3 短路径 `.MJS` 大写 Node ESM 不认 → 脚本用长路径带引号。
- **serve 调用：** cmd 吞 JSON 内引号，focall.mjs 吃 base64-json。

## 待办
- 单条 17.4s → 5-8s 优化（IME 切换是最大块，可考虑 bridge IME 常驻不切）
- Slice 3 operator 决策 role
