// xhs-device-agent 操作面板后端
// 原生 node:http,零依赖。聚合 4 个 fast-operator serve(17895-98)+ adb one-shot,
// spawn task-runner.mjs 子进程跑【任务队列】并实时捕获进度。绑 0.0.0.0 供 Tailscale Serve 反代。
//
// 路由:GET /  静态页 | GET /status 4 台聚合 | GET /tasks 任务列表
//       POST /task {serial, action:start|stop, queue|task, durationMin, cap}  POST /home {serial}
//
// 队列模型:每台一个 [(task,durationMin,cap), ...],依次跑。每项到点 SIGINT 优雅停
// (task-runner 当前圈跑完才退),再接下一项;队列空或用户停 → done。
// task-runner 不动:用大 --loops 安全上限 + dashboard 计时 SIGINT + 30s SIGKILL 兜底。
// durationMin=0 表示该项手动停(无到点)。
//
// 设计原则:不改 fast-operator.mjs / task-runner.mjs / 4 个 serve / task 模板(零侵入)。
// task-runner 跑批时与该 serial serve 各持一条持久 adb shell,故活跃任务期间跳过 focus/IME 轮询降扰。

import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = __dirname; // dashboard.mjs 放 scripts/
const TASK_RUNNER = join(SCRIPTS, "task-runner.mjs");
const TASKS_DIR = join(SCRIPTS, "tasks");
const STATIC_DIR = join(SCRIPTS, "dashboard");
const LOGS_DIR = join(SCRIPTS, "logs");

// 同 4 个 serve 的硬编码路径
const ADB = "C:\\PROGRA~2\\xiaowei_android\\tools\\adb.exe";
const NODE = "D:\\Program Files\\Node\\node.exe";
const LLM_ENDPOINT = "http://100.84.194.46:8317/v1/chat/completions";
const LLM_KEY = "cliproxy-codexapp";
const LLM_MODEL = "grok-4.20-0309-non-reasoning";

// 安全上限:dashboard 计时 SIGINT 是主停法,这只是 SIGINT 失效时的兜底,正常远不会触达。
const LOOPS_SAFETY = 100000;
const KILL_GRACE_MS = 30000; // SIGINT 后 30s 仍不退则 SIGKILL 兜底

const PORT = Number(process.env.DASH_PORT || 17900);

const DEVICES = [
  { serial: "REPLACE_SERIAL_01", port: 17895 },
  { serial: "REPLACE_SERIAL_03", port: 17896 },
  { serial: "REPLACE_SERIAL_02", port: 17897 },
  { serial: "REPLACE_SERIAL_04", port: 17898 },
];

// serial -> 运行态记录
const running = new Map();

// ---- agent 接管说明书(机器可读 manifest 的静态部分)----
const TASKS_INFO = [
  { name: "养号", risk: "low", reversible: true, cap: "无评论,cap 忽略", steps: ["scrollN 3", "likeCard idx0", "likeCard idx1"], desc: "纯点赞养账号权重,零不可逆动作" },
  { name: "涨粉", risk: "medium", reversible: false, cap: "comment-cap 1 每圈(防风控)", steps: ["scrollN 3", "likeCard idx0", "commentOnOpenNote idx1(只评图文,跳视频)"], desc: "点赞+真评论吸回关;评论真实公开不可逆" },
  { name: "互动", risk: "medium", reversible: false, cap: "comment-cap 1 每圈", steps: ["scrollN 2", "commentOnOpenNote idx0", "commentOnOpenNote idx1(视频也评)"], desc: "纯评论任务" },
  { name: "纯刷", risk: "low", reversible: true, cap: "无评论", steps: ["scrollN 5"], desc: "只刷不点不评,最轻量养活跃度" },
  { name: "自主", risk: "medium", reversible: false, cap: "comment-cap 1 每圈", steps: ["LLM 每张卡自主决策 like/comment/skip"], desc: "AI 自主决策层,带 UNSAFE 过滤" },
];

// 31 个 serve 原语:curated 给常用原语标参数,rare 的只列名(POST /primitive {...params} 透传,未知参数 serve 忽略)
const PRIMITIVES_CURATED = [
  { name: "focus", params: {}, desc: "取当前前台 activity(包名/类名)", risk: "none" },
  { name: "dump", params: {}, desc: "dump 屏幕节点层级(定位元素)", risk: "none" },
  { name: "metrics", params: {}, desc: "serve 进程内累计计数 + 存活探针", risk: "none" },
  { name: "feedCards", params: {}, desc: "取首页可见卡片(idx/author/title)", risk: "none" },
  { name: "tap", params: { x: "int", y: "int" }, desc: "点屏幕坐标", risk: "low" },
  { name: "scrollUp", params: {}, desc: "向上滚(往下翻内容)", risk: "low" },
  { name: "scrollDown", params: {}, desc: "向下滚(往上翻)", risk: "low" },
  { name: "scrollN", params: { n: "int" }, desc: "刷 n 屏", risk: "low" },
  { name: "openCard", params: { idx: "int" }, desc: "打开首页第 idx 张卡进笔记详情", risk: "low" },
  { name: "likeCard", params: { idx: "int" }, desc: "不打开笔记,直接给首页第 idx 张卡点赞", risk: "low" },
  { name: "likeDetail", params: {}, desc: "给当前打开的笔记详情点赞", risk: "low" },
  { name: "commentOnOpenNote", params: { idx: "int", skipVideo: "bool", maxScrolls: "int" }, desc: "打开第 idx 张图文笔记发真评论(不可逆!)", risk: "high", irreversible: true },
  { name: "openCommentSection", params: {}, desc: "打开当前笔记评论区", risk: "low" },
  { name: "parseComments", params: {}, desc: "解析当前笔记评论列表", risk: "none" },
  { name: "openProfile", params: {}, desc: "打开作者主页", risk: "low" },
  { name: "profileGrid", params: {}, desc: "取主页笔记网格", risk: "none" },
  { name: "scrollProfile", params: {}, desc: "滚主页", risk: "low" },
  { name: "playProfileVideo", params: {}, desc: "播主页视频笔记", risk: "low" },
  { name: "backToFeed", params: {}, desc: "回首页流", risk: "low" },
  { name: "backFromNote", params: {}, desc: "从笔记详情返回", risk: "low" },
  { name: "backFromProfile", params: {}, desc: "从主页返回", risk: "low" },
  { name: "restoreIme", params: {}, desc: "恢复 SogouIME(若被 xwkeyboard 顶替)", risk: "low" },
  { name: "inputTextDryRun", params: { text: "string" }, desc: "走 IME 桥试输入文本(不发送)", risk: "low" },
  { name: "videoNoteDryRun", params: {}, desc: "视频笔记输入试运行", risk: "low" },
  { name: "commentBox", params: {}, desc: "打开评论输入框", risk: "low" },
  { name: "detailBar", params: {}, desc: "取笔记详情底栏", risk: "none" },
  { name: "favoriteDetail", params: {}, desc: "收藏当前笔记", risk: "low" },
  { name: "rewriteComment", params: {}, desc: "让 LLM 重写评论", risk: "low" },
  { name: "commentBenchmark", params: {}, desc: "评论基准(零发,只测计数)", risk: "none" },
  { name: "noteBenchmark", params: {}, desc: "笔记基准", risk: "none" },
  { name: "commentTransaction", params: {}, desc: "评论事务(计 countDelta 实证)", risk: "high" },
];

const CONSTRAINTS = [
  "comment-cap 1 每圈,多了触发小红书风控",
  "回首页 POST /home 已内置 force-stop 清栈再重启;别只 monkey LAUNCHER(深页不重置)",
  "别直连 ws://127.0.0.1:22222(共享中文输入桥,跨进程锁);输入走 inputTextDryRun / commentOnOpenNote",
  "某台跑批期间别抢该台 adb(/status 在该台 running 时已自动跳过 focus/IME,直接 focus 会 10s 超时)",
  "评论(commentOnOpenNote/commentTransaction)是真实公开不可逆;点赞/刷屏低风险",
  "4 台可并发,各自独立 adb shell + serve,互不串台",
  "durationMin=0 = 该项手动停(无到点);停止 = 清整个队列",
  "到点优雅停:当前圈跑完才退,实际时长会略多于设定",
  "openCard/likeCard/openProfile/openCommentSection 都吃 {idx} 自动从首页 feed 解析,不用先 feedCards",
  "视频笔记的 activity 是 DetailFeed,图文是 NoteDetail;评论优先图文(skipVideo 思路),视频先 pauseIfVideoNote(serve 内置)",
];

// 操作剧本:agent 一接管照着走,从"接管第一步"到各类精确操作。
// call 用端点名;primitive 步骤用 POST /primitive {serial, action, ...}。
const PLAYBOOKS = [
  {
    name: "0 · 接管第一步(必做)", goal: "接管并看清 4 台当前态,后续每步都基于此",
    risk: "none", reversible: true,
    steps: [
      { call: "POST /agent/takeover", params: { id: "<你的id>", kind: "<claude|codex|...>" }, expect: "active=true,人页绿灯亮" },
      { call: "GET /status", expect: "devices[4] 各含 serve/activity/ime/running;agent.active=true" },
      { call: "POST /agent/heartbeat", params: { id: "<你的id>" }, expect: "ok;之后每≤15s 重复一次,>30s 不发自动释放" },
    ],
    note: "全程必须每≤15s 发一次 heartbeat;操作中途也要发。干完 POST /agent/release。",
  },
  {
    name: "1 · 读首页卡片(侦察)", goal: "看 4 台各自首页有哪些卡片,决定点哪张",
    risk: "none", reversible: true,
    steps: [
      { call: "POST /home", params: { serial: "<s>" }, expect: "IndexActivityV2(深页也重置)", if: "该台不在首页" },
      { call: "POST /primitive", params: { serial: "<s>", action: "feedCards" }, expect: "{cards:[{authorName,title,cover:{center:[x,y]}}]}" },
    ],
    note: "idx 会随滚动变化;每次操作前重新 feedCards 或直接用带 idx 的原语(它会自己 dump)。",
  },
  {
    name: "2 · 给第 N 张卡点赞(不进详情)", goal: "首页上直接给某张卡点赞",
    risk: "low", reversible: true,
    steps: [
      { call: "POST /primitive", params: { serial: "<s>", action: "likeCard", idx: 0 }, expect: "{resolved:true,card,tapped:...}" },
    ],
    note: "idx 从 0 起。resolved=false 说明该卡无 likeButton(可能已赞过/布局异常),换 idx。",
  },
  {
    name: "3 · 打开第 N 张卡看详情+评论", goal: "进笔记详情,读评论",
    risk: "low", reversible: true,
    steps: [
      { call: "POST /primitive", params: { serial: "<s>", action: "openCard", idx: 1 }, expect: "落到 NoteDetail(图文)或 DetailFeed(视频)" },
      { call: "POST /primitive", params: { serial: "<s>", action: "parseComments" }, expect: "{comments,topNonAuthor}" },
      { call: "POST /primitive", params: { serial: "<s>", action: "backFromNote" }, expect: "回首页" },
    ],
    note: "图文=NoteDetail 可评论;视频=DetailFeed 评论前 serve 会自动暂停。backFromNote 回首页。",
  },
  {
    name: "4 · 给当前笔记详情点赞/收藏", goal: "在已打开的笔记详情页点赞或收藏",
    risk: "low", reversible: true,
    steps: [
      { call: "POST /primitive", params: { serial: "<s>", action: "openCard", idx: 0 }, expect: "NoteDetail|DetailFeed" },
      { call: "POST /primitive", params: { serial: "<s>", action: "likeDetail" }, expect: "{resolved:true,tapped:...}" },
      { call: "POST /primitive", params: { serial: "<s>", action: "favoriteDetail" }, expect: "收藏(可选)", optional: true },
    ],
    note: "必须在笔记详情页(notOnNote 会 resolved:false)。先 openCard 再 likeDetail。",
  },
  {
    name: "5 · 给第 N 张图文笔记发评论(不可逆!)", goal: "对图文笔记发一条真评论",
    risk: "high", irreversible: true,
    steps: [
      { call: "POST /home", params: { serial: "<s>" }, expect: "IndexActivityV2" },
      { call: "POST /primitive", params: { serial: "<s>", action: "openCard", idx: 1 }, expect: "NoteDetail(图文)" },
      { call: "判 focus", params: { call: "GET /status 看 activity" }, expect: "NoteDetail=图文可评;DetailFeed=视频换 idx", branch: true },
      { call: "POST /primitive", params: { serial: "<s>", action: "commentOnOpenNote", maxScrolls: 6, text: "<可选,不传则 serve 用 LLM 生成>" }, expect: "{ok:true,...} 评论真实发出,公开不可逆" },
      { call: "POST /primitive", params: { serial: "<s>", action: "parseComments" }, expect: "看到自己的评论(验证)", verify: true },
      { call: "POST /home", params: { serial: "<s>" }, expect: "回首页收尾" },
    ],
    note: "评论 = 真实公开不可逆!每圈最多 1 条(cap)。优先图文;视频别评。先 commentBenchmark(零发送)练手。",
  },
  {
    name: "6 · 评论基准(零发送,练手/测耗时)", goal: "走完整评论流程但不真发,零痕迹",
    risk: "none", reversible: true,
    steps: [
      { call: "POST /primitive", params: { serial: "<s>", action: "commentBenchmark", idx: 0 }, expect: "{ok:true,各步 ms} 不发送" },
    ],
    note: "首次接管想试评论流程又不敢真发,先跑这个。inputTextDryRun{text} 也可单测输入。",
  },
  {
    name: "7 · 进某作者主页浏览", goal: "打开卡片作者的主页,看作品网格",
    risk: "low", reversible: true,
    steps: [
      { call: "POST /primitive", params: { serial: "<s>", action: "openProfile", idx: 0 }, expect: "{resolved,opened}" },
      { call: "POST /primitive", params: { serial: "<s>", action: "profileGrid" }, expect: "{covers:[...]}" },
      { call: "POST /primitive", params: { serial: "<s>", action: "scrollProfile", n: 2 }, expect: "主页下滑" },
      { call: "POST /primitive", params: { serial: "<s>", action: "backFromProfile" }, expect: "回首页" },
    ],
  },
  {
    name: "8 · 刷 N 屏养活跃度", goal: "纯滚动不点不评,养账号活跃",
    risk: "low", reversible: true,
    steps: [
      { call: "POST /primitive", params: { serial: "<s>", action: "scrollN", n: 3, down: true }, expect: "刷 3 屏" },
    ],
    note: "down=true=往下翻内容。批量养号直接用剧本 10 起预设任务,别手摇滚动。",
  },
  {
    name: "9 · 输入法检查/恢复", goal: "确保是 SogouIME(被 xwkeyboard 顶替会打不出中文)",
    risk: "low", reversible: true,
    steps: [
      { call: "GET /status", expect: "devices[].ime 含 sogou=正常;含 xwkeyboard=异常" },
      { call: "POST /primitive", params: { serial: "<s>", action: "restoreIme" }, expect: "恢复 SogouIME", if: "ime 异常" },
    ],
  },
  {
    name: "10 · 起预设任务跑 X 分钟(推荐批量)", goal: "让某台自动跑养号/涨粉/纯刷等预设任务,按时长",
    risk: "见任务", reversible: "见任务",
    steps: [
      { call: "POST /task", params: { serial: "<s>", action: "start", queue: [{ task: "养号", durationMin: 30, cap: 1 }] }, expect: "{ok,pid,items}" },
      { call: "GET /status", expect: "该台 task.idx/total/remainingMs/ok/skip/comments 实时滚动" },
      { call: "POST /task", params: { serial: "<s>", action: "stop" }, expect: "清整个队列,优雅停(当前圈跑完)", if: "要中途停" },
    ],
    note: "队列可多项:[{task:养号,durationMin:30,cap:1},{task:涨粉,durationMin:20,cap:1}] 依次跑。各台可不同任务同时跑(4 台并发)。这是省事的主路径,精确单步用剧本 1-9。",
  },
  {
    name: "11 · 自由组合(4 台各干各的)", goal: "同时:A 跑养号队列 / B 精确给第3张点赞 / C 读某作者主页 / D 静默",
    risk: "混合", reversible: "混合",
    steps: [
      { call: "POST /task", params: { serial: "REPLACE_SERIAL_01", action: "start", queue: [{ task: "养号", durationMin: 30, cap: 1 }] } },
      { call: "POST /primitive", params: { serial: "REPLACE_SERIAL_03", action: "likeCard", idx: 2 } },
      { call: "POST /primitive", params: { serial: "REPLACE_SERIAL_02", action: "openProfile", idx: 0 } },
      { call: "POST /agent/heartbeat", params: { id: "<你的id>" }, note: "并发操作期间心跳别停" },
    ],
    note: "4 台 serve + adb 独立,可同时调;只有小薇 22222 是共享(评论时串行,serve 内部已排队)。",
  },
  {
    name: "12 · 收工释放", goal: "停所有任务、回首页、释放接管",
    risk: "none", reversible: true,
    steps: [
      { call: "POST /task", params: { serial: "<每台>", action: "stop" }, expect: "全停" },
      { call: "POST /home", params: { serial: "<每台>" }, expect: "全 IndexActivityV2" },
      { call: "POST /agent/release", params: { id: "<你的id>" }, expect: "绿灯灭" },
    ],
    note: "别留任务在跑(手机无人值守)。释放后若 30s 内想再接管,重新 takeover。",
  },
];

function log(...a) { console.log(new Date().toISOString(), ...a); }

// ---- agent 接管(心跳保活,30s 无心跳自动释放)----
const HEARTBEAT_TIMEOUT_MS = 30000;
const HEARTBEAT_INTERVAL_S = 15; // 推荐 agent 每 ≤15s 一次
const agent = { id: null, kind: null, takenAt: null, lastHeartbeat: null };
const agentLog = [];
function aLog(type, detail) { agentLog.push({ ts: Date.now(), type, detail }); if (agentLog.length > 300) agentLog.shift(); }
function agentActive() {
  return !!(agent.id && agent.lastHeartbeat && Date.now() - agent.lastHeartbeat < HEARTBEAT_TIMEOUT_MS);
}
function agentState() {
  return {
    active: agentActive(),
    id: agent.id, kind: agent.kind,
    takenAt: agent.takenAt,
    lastHeartbeatAgo: agent.lastHeartbeat ? Date.now() - agent.lastHeartbeat : null,
    timeoutMs: HEARTBEAT_TIMEOUT_MS,
  };
}

// ---- manifest(给 agent 的机器可读说明书)----
async function buildManifest() {
  const st = await buildStatus();
  return {
    project: "xhs-device-agent — 4 真机小红书自动化控制台",
    purpose: "4 台 Android 真机各跑一个账号,经 fast-operator 旁路高速操作小红书(刷/赞/评论)。dashboard 聚合 4 个 serve + task-runner,可启停预设任务队列、调原语、回首页。本 manifest 供 AI agent 冷接管。",
    base_url: "http://<this-host>:17900",
    devices: DEVICES.map((d) => ({ serial: d.serial, serve_port: d.port })),
    tasks: TASKS_INFO,
    primitives: {
      curated: PRIMITIVES_CURATED,
      count: PRIMITIVES_CURATED.length,
      usage: "POST /primitive {serial, action, ...params} 代理到该台 serve;未知参数被 serve 忽略;权威参数见 fast-operator.mjs",
    },
    api: [
      { method: "GET", path: "/status", desc: "4 台聚合状态 + agent 接管态" },
      { method: "GET", path: "/tasks", desc: "任务名列表" },
      { method: "GET", path: "/agent/manifest", desc: "本说明书(JSON)" },
      { method: "GET", path: "/agent", desc: "人可读 agent 控制面(HTML)" },
      { method: "GET", path: "/agent/state", desc: "agent 接管态 + 事件日志(轮询)" },
      { method: "POST", path: "/task", body: { serial: "str", action: "start|stop", queue: "[{task,durationMin,cap}]" }, desc: "起/停任务队列;旧单任务 {task,durationMin,cap} 仍兼容" },
      { method: "POST", path: "/home", body: { serial: "str" }, desc: "回首页(force-stop+重启,深页也重置到 IndexActivityV2)" },
      { method: "POST", path: "/primitive", body: { serial: "str", action: "原语名", "...": "原语参数" }, desc: "代理到该台 serve 的 31 个原语之一(精确控制)" },
      { method: "POST", path: "/agent/takeover", body: { id: "str", kind: "str" }, desc: "接管 → 绿灯亮" },
      { method: "POST", path: "/agent/heartbeat", body: { id: "str" }, desc: `保活,每≤${HEARTBEAT_INTERVAL_S}s 一次;>30s 无心跳自动释放` },
      { method: "POST", path: "/agent/release", body: { id: "str" }, desc: "主动释放" },
    ],
    constraints: CONSTRAINTS,
    playbooks: PLAYBOOKS,
    first_steps: "接管后照 PLAYBOOKS[0] 走;批量操作用剧本10起预设任务;精确单步用剧本1-9;收工用剧本12。全程每≤15s heartbeat。",
    takeover: {
      heartbeat_interval_s: HEARTBEAT_INTERVAL_S,
      timeout_s: HEARTBEAT_TIMEOUT_MS / 1000,
      how: "POST /agent/takeover {id,kind} → POST /agent/heartbeat {id} 每≤15s → POST /agent/release {id};>30s 无心跳自动释放,绿灯灭",
      green_light: "人页 /status.agent.active=true 时顶栏显示绿灯徽章(只标不锁,人仍可介入)",
    },
    current_state: st,
  };
}

// ---- serve HTTP 调用 ----
async function serveCall(port, action, extra = {}) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
      signal: AbortSignal.timeout(5000),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- adb one-shot ----
function adb(serial, args) {
  try {
    const r = spawnSync(ADB, ["-s", serial, ...args], { encoding: "utf8", timeout: 8000 });
    return (r.stdout || "").trim();
  } catch (e) {
    return "";
  }
}

function imeOf(serial) {
  const v = adb(serial, ["shell", "settings", "get", "secure", "default_input_method"]);
  return v || "unknown";
}

// 用自己 one-shot adb 取前台 activity(serve 的 focus 走持久 shell,实测会 10s 超时;one-shot 秒回更可靠)
function activityOf(serial) {
  const v = adb(serial, ["shell", "dumpsys window | grep -E mCurrentFocus"]);
  if (!v) return null;
  const lines = v.split("\n").map((s) => s.trim()).filter((s) => s.includes("mCurrentFocus=") && !s.includes("=null"));
  const last = lines[lines.length - 1] || "";
  const m = last.match(/mCurrentFocus=Window\{[^}]*\s+([\w.]+)\/([\w.$]+)\}/);
  return m ? `${m[1]}/${m[2]}` : (last || null);
}

// 回首页:force-stop 清任务栈再重启,保证从 xhs 深处(NoteDetail 等)也重置到 IndexActivityV2。
// 单纯 monkey -c LAUNCHER 对已在 xhs 深处的 app 只会把现有任务栈拉前台,不重置到首页。
function launchXhs(serial) {
  adb(serial, ["shell", "am", "force-stop", "com.xingin.xhs"]);
  const v = adb(serial, ["shell", "monkey", "-p", "com.xingin.xhs", "-c", "android.intent.category.LAUNCHER", "1"]);
  return /Events injected/i.test(v) ? "ok" : v.slice(-120);
}

// ---- 任务队列子进程 ----
// 队列项归一:{task, durationMin, cap}
function normItem(x) {
  const task = String(x.task || "").trim();
  const durationMin = Math.max(0, Number(x.durationMin) || 0);
  const cap = Math.max(0, Number(x.cap ?? x.commentCap ?? 0));
  return { task, durationMin, cap };
}

function startQueue(serial, queueRaw) {
  const prev = running.get(serial);
  if (prev && prev.child) killRec(prev);
  const queue = queueRaw.map(normItem).filter((q) => q.task);
  if (!queue.length) throw new Error("empty queue");
  // 校验 task 文件存在
  for (const q of queue) {
    if (!existsSync(join(TASKS_DIR, q.task + ".json"))) throw new Error("task not found: " + q.task);
  }
  const rec = {
    queue,
    idx: 0,
    child: null,
    itemStartedAt: null,
    timer: null,
    killTimer: null,
    stopRequested: false,
    // 队列累计
    ok: 0, skip: 0, comments: 0, loopsDone: 0,
    // 当前项实时
    loop: 0,
    phase: "start",
    lastErr: null,
    startedAt: Date.now(),
    endedAt: null, exitCode: null,
  };
  running.set(serial, rec);
  log("startQueue", serial, queue.length, "items:", queue.map((q) => q.task + "@" + q.durationMin + "m").join(" → "));
  runItem(serial, rec, 0);
  return rec;
}

function runItem(serial, rec, idx) {
  if (rec.stopRequested) return finishRec(rec);
  if (idx >= rec.queue.length) return finishRec(rec);
  const item = rec.queue[idx];
  rec.idx = idx;
  rec.loop = 0;
  const args = [
    TASK_RUNNER, "--adb", ADB, "--serial", serial,
    "--task", join(TASKS_DIR, item.task + ".json"),
    "--loops", String(LOOPS_SAFETY),
    "--comment-cap", String(item.cap),
    "--llm-endpoint", LLM_ENDPOINT, "--llm-key", LLM_KEY, "--llm-model", LLM_MODEL,
  ];
  const child = spawn(NODE, args, { stdio: ["ignore", "pipe", "pipe"] });
  rec.child = child;
  rec.itemStartedAt = Date.now();
  rec.phase = "running";
  log("startItem", serial, (idx + 1) + "/" + rec.queue.length, item.task, item.durationMin + "min", "cap", item.cap, "pid", child.pid);

  // 到点优雅停(SIGINT,task-runner 当前圈跑完才退)
  if (item.durationMin > 0) {
    rec.timer = setTimeout(() => {
      log("itemTimeUp", serial, idx, item.task, item.durationMin + "min 到点 → SIGINT");
      stopChild(rec);
    }, item.durationMin * 60000);
  }

  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handleLine(rec, line);
    }
  });
  let ebuf = "";
  child.stderr.on("data", (d) => { ebuf += d.toString(); });
  child.on("exit", (code) => {
    if (rec.timer) clearTimeout(rec.timer);
    if (rec.killTimer) { clearTimeout(rec.killTimer); rec.killTimer = null; }
    log("itemExit", serial, idx, item.task, "code", code, "loops", rec.loopsDone, "ok", rec.ok, "skip", rec.skip, "comments", rec.comments);
    rec.child = null;
    if (ebuf.trim()) log("itemStderr", serial, ebuf.trim().slice(-500));
    if (rec.stopRequested) return finishRec(rec, code);
    if (idx + 1 < rec.queue.length) runItem(serial, rec, idx + 1);
    else finishRec(rec, code);
  });
}

function stopChild(rec) {
  if (!rec.child) return;
  rec.phase = "stopping";
  try { rec.child.kill("SIGINT"); } catch {}
  // SIGINT 30s 仍不退则 SIGKILL 兜底(防止某圈卡死)
  rec.killTimer = setTimeout(() => {
    if (rec.child) { try { rec.child.kill("SIGKILL"); } catch {} }
  }, KILL_GRACE_MS);
}

function killRec(rec) {
  // 异常清理(进程退出/被新队列顶替):立即停,不等当前圈
  if (rec.timer) clearTimeout(rec.timer);
  if (rec.killTimer) { clearTimeout(rec.killTimer); rec.killTimer = null; }
  rec.stopRequested = true;
  if (rec.child) { try { rec.child.kill("SIGKILL"); } catch {} }
}

function finishRec(rec, code) {
  rec.phase = "done";
  rec.endedAt = Date.now();
  if (code != null) rec.exitCode = code;
  log("queueDone", "loops", rec.loopsDone, "ok", rec.ok, "skip", rec.skip, "comments", rec.comments);
}

function handleLine(rec, line) {
  let j;
  try { j = JSON.parse(line); } catch { return; } // 非 JSON 行忽略
  if (j.phase === "loopDone") {
    rec.loop = j.loop ?? rec.loop;
    rec.loopsDone = (rec.loopsDone || 0) + 1;
    rec.ok += Number(j.ok) || 0;
    rec.skip += Number(j.skip) || 0;
    rec.comments += Number(j.comments) || 0;
    rec.phase = "running";
  } else if (j.phase === "done" || j.phase === "summary") {
    if (typeof j.okSteps === "number") rec.ok = j.okSteps;
    if (typeof j.skipSteps === "number") rec.skip = j.skipSteps;
    if (typeof j.comments === "number") rec.comments = j.comments;
    if (j.errSteps) rec.lastErr = `errSteps=${j.errSteps}`;
  } else if (j.phase === "start" || j.phase === "ensureOnFeed") {
    rec.phase = j.phase;
  }
  if (j.error || j.err) rec.lastErr = String(j.error || j.err).slice(-200);
}

function stopTask(serial) {
  const rec = running.get(serial);
  if (!rec || !rec.child) return { stopped: false, reason: "not running" };
  rec.stopRequested = true;
  stopChild(rec);
  log("stopQueue", serial, "idx", rec.idx, "remaining", rec.queue.length - rec.idx);
  return { stopped: true, pid: rec.child.pid, remainingItems: rec.queue.length - rec.idx };
}

// ---- /status 聚合 ----
async function buildStatus() {
  const out = [];
  for (const d of DEVICES) {
    const rec = running.get(d.serial);
    const isRunning = rec && rec.child && rec.phase !== "done";
    const st = { serial: d.serial, port: d.port, running: !!isRunning, task: null, queue: null };
    if (isRunning) {
      const item = rec.queue[rec.idx];
      const elapsed = Date.now() - rec.itemStartedAt;
      const remaining = item && item.durationMin > 0 ? Math.max(0, item.durationMin * 60000 - elapsed) : null;
      st.task = {
        name: item ? item.task : null,
        idx: rec.idx + 1, total: rec.queue.length,
        durationMin: item ? item.durationMin : 0,
        elapsedMs: elapsed, remainingMs: remaining,
        loop: rec.loopsDone, phase: rec.phase,
        ok: rec.ok, skip: rec.skip, comments: rec.comments,
        startedAt: rec.startedAt, lastErr: rec.lastErr,
      };
      st.queue = rec.queue.map((q) => ({ task: q.task, durationMin: q.durationMin, cap: q.cap }));
      const m = await serveCall(d.port, "metrics");
      st.serve = m.ok ? "ok" : "down";
      st.activity = "(running task)";
      st.ime = null;
    } else {
      const metrics = await serveCall(d.port, "metrics"); // metrics 进程内计数,无 adb,即存活探针
      st.serve = metrics.ok ? "ok" : "down";
      st.activity = activityOf(d.serial); // one-shot adb,不走 serve 持久 shell
      st.ime = imeOf(d.serial);
      st.metrics = metrics.ok ? metrics.result : null;
      if (rec) st.lastTask = {
        queue: rec.queue.map((q) => ({ task: q.task, durationMin: q.durationMin })),
        idx: rec.idx, total: rec.queue.length, loopsDone: rec.loopsDone,
        ok: rec.ok, skip: rec.skip, comments: rec.comments,
        exitCode: rec.exitCode, lastErr: rec.lastErr, endedAt: rec.endedAt,
      };
    }
    out.push(st);
  }
  return { devices: out, ts: Date.now(), agent: agentState() };
}

// ---- 任务列表 ----
function listTasks() {
  if (!existsSync(TASKS_DIR)) return [];
  return readdirSync(TASKS_DIR)
    .filter((f) => extname(f) === ".json")
    .map((f) => f.slice(0, -5));
}

// ---- HTTP 路由 ----
async function readBody(req) {
  return new Promise((res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try { res(b ? JSON.parse(b) : {}); } catch { res({}); }
    });
  });
}

function send(res, code, obj, type = "application/json") {
  res.writeHead(code, { "Content-Type": type + "; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  if (Buffer.isBuffer(obj)) return res.end(obj);
  res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  if (req.method === "GET" && path === "/") {
    try {
      const html = await readFile(join(STATIC_DIR, "index.html"));
      return send(res, 200, html, "text/html");
    } catch {
      return send(res, 404, { error: "index.html not found" });
    }
  }
  if (req.method === "GET" && path === "/status") {
    return send(res, 200, await buildStatus());
  }
  if (req.method === "GET" && path === "/tasks") {
    return send(res, 200, { tasks: listTasks() });
  }
  if (req.method === "POST" && path === "/home") {
    const b = await readBody(req);
    const d = DEVICES.find((x) => x.serial === b.serial);
    if (!d) return send(res, 400, { error: "bad serial" });
    return send(res, 200, { serial: b.serial, result: launchXhs(b.serial) });
  }
  if (req.method === "POST" && path === "/task") {
    const b = await readBody(req);
    const d = DEVICES.find((x) => x.serial === b.serial);
    if (!d) return send(res, 400, { error: "bad serial" });
    if (b.action === "stop") return send(res, 200, stopTask(b.serial));
    if (b.action === "start") {
      try {
        let queue;
        if (Array.isArray(b.queue) && b.queue.length) queue = b.queue;
        else if (b.task) queue = [{ task: b.task, durationMin: Number(b.durationMin ?? b.minutes) || 0, cap: b.cap ?? b.commentCap ?? 0 }];
        else return send(res, 400, { error: "no queue/task" });
        const rec = startQueue(b.serial, queue);
        return send(res, 200, { ok: true, pid: rec.child ? rec.child.pid : null, items: rec.queue.length });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }
    return send(res, 400, { error: "bad action" });
  }
  // ---- agent 控制面 ----
  if (req.method === "GET" && path === "/agent") {
    try {
      const html = await readFile(join(STATIC_DIR, "agent.html"));
      return send(res, 200, html, "text/html");
    } catch {
      return send(res, 404, { error: "agent.html not found" });
    }
  }
  if (req.method === "GET" && path === "/agent/manifest") {
    return send(res, 200, await buildManifest());
  }
  if (req.method === "GET" && path === "/agent/state") {
    return send(res, 200, { agent: agentState(), log: agentLog.slice(-80) });
  }
  if (req.method === "POST" && path === "/agent/takeover") {
    const b = await readBody(req);
    agent.id = String(b.id || "agent");
    agent.kind = String(b.kind || "unknown");
    agent.takenAt = Date.now();
    agent.lastHeartbeat = Date.now();
    aLog("takeover", `${agent.id} (${agent.kind})`);
    log("agent takeover", agent.id, agent.kind);
    return send(res, 200, { ok: true, ...agentState() });
  }
  if (req.method === "POST" && path === "/agent/heartbeat") {
    const b = await readBody(req);
    if (!agent.id) return send(res, 200, { ok: false, error: "no active takeover" });
    if (b.id && b.id !== agent.id) return send(res, 409, { ok: false, error: "another agent active", current: agent.id });
    agent.lastHeartbeat = Date.now();
    aLog("heartbeat", agent.id);
    return send(res, 200, { ok: true, ...agentState() });
  }
  if (req.method === "POST" && path === "/agent/release") {
    const b = await readBody(req);
    if (b.id && b.id !== agent.id) return send(res, 409, { ok: false, error: "id mismatch", current: agent.id });
    aLog("release", agent.id || "(none)");
    log("agent release", agent.id);
    agent.id = null; agent.kind = null; agent.takenAt = null; agent.lastHeartbeat = null;
    return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && path === "/primitive") {
    const b = await readBody(req);
    const d = DEVICES.find((x) => x.serial === b.serial);
    if (!d) return send(res, 400, { error: "bad serial" });
    const { serial, action, ...params } = b;
    if (!action) return send(res, 400, { error: "no action" });
    const who = agentActive() ? agent.id : "human";
    aLog("primitive", `${who} → ${serial} ${action}${Object.keys(params).length ? " " + JSON.stringify(params) : ""}`);
    const r = await serveCall(d.port, action, params);
    return send(res, 200, r);
  }
  send(res, 404, { error: "not found", path });
});

server.listen(PORT, "0.0.0.0", () => log("dashboard serving on 0.0.0.0:" + PORT));

// dashboard 退出时强杀所有运行中的任务子进程,避免手机上无人值守继续跑
function cleanup() {
  for (const [s, rec] of running) killRec(rec);
  process.exit(0);
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

export { DEVICES, startQueue, stopTask };