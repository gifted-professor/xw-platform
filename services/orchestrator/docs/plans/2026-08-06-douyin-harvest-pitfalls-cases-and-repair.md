# 抖音分享链接采链：本会话踩坑案例与修复建议

- 日期：2026-08-06
- 设备：alias `01`（serial `REPLACE_SERIAL_01`）
- 主脚本：`ops/douyin-harvest-share-links.mjs`
- 目标：关键词搜 → 漏斗「图文」→ 开帖 → 拿 `v.douyin.com` 分享链 → 飞书 Base 写入
- 飞书：Base `REDACTED_FEISHU_BASE_TOKEN` / table `REPLACE_FEISHU_DOUYIN_TABLE_ID`；总目标约 **200** 唯一 URL
- 文档性质：人审阅用；知识库条目待统一补（见文末「待补知识库」）
- 相关短记：
  - `runtime/xj-live-pipeline/REPORT-paste-into-searchbox-every-exit-20260806.md`
  - `runtime/xj-live-pipeline/NOTES-clipboard-paste-fallback-20260805.md`
  - `runtime/xj-live-pipeline/DEFERRED-pitfalls-douyin-harvest-20260806.md`
  - `runtime/xj-live-pipeline/NOTES-weibo-gate-after-share-link-20260806.md`（若存在：分享后外发条误触微博）
  - 控制面预算方案（未部署）：`docs/plans/2026-08-06-explorer-budget-cross-device-circuit-breaker-v1.md`

---

## 1. 本会话进度快照（写文档时）

| 项 | 值 |
|---|---|
| 飞书唯一 URL | **76 / ~200** |
| 单关键词跑通 | `live实况新疆` **20/20**（`URL_VIA=paste_detail`） |
| 两词连跑 | `live记录 新疆` 曾 fail-stop 于 8/10；后续表内已到 **10**；`张live图 伊犁` 未作为本会话完整验收 |
| 笔记 App 粘贴方案 | **未验证成功**（卡在种子/焦点） |

按关键词（飞书）：

| 关键词 | 条数 |
|---|---:|
| 张live记录新疆 | 30 |
| live实况新疆 | 20 |
| live记录 新疆 | 10 |
| 新疆之旅live | 6 |
| 新疆回忆live | 6 |
| 新疆live图 | 4 |

---

## 2. 正确业务链路（心里要有的图）

```text
搜关键词（每词至少一次，漂移则同词重搜）
  → 漏斗「图文」
  → 结果队列翻页开帖
  → 分享面板点「分享链接/复制链接」（只要 dump 文案，禁死坐标）
  → toast「链接已复制」
  → 【理想】shell 读系统剪贴板 → URL
  → 【01 现实】剪贴板 shell 读空 → 详情评论框 PASTE → dump 抽 URL
  → lark-cli 写飞书（不往飞书 App 里粘贴）
  → back 回结果队列，校验顶栏仍是当前关键词
```

**飞书不依赖手机粘贴。** 粘贴只是「读出已复制内容」的权宜之计。

---

## 3. 踩坑案例清单（本会话）

### 案例 A — Toast 已复制，shell 剪贴板永远空（根因）

- **现象**：`TOAST_COPIED=true`，`CLIP_URL=miss`；`cmd clipboard get-clip` 报未实现；`dumpsys clipboard` 空。
- **证据**：`runtime/xj-live-pipeline/probe-clip-vs-paste-result.json`（`confirmed_clipboard_miss_paste_works`）。
- **根因**：Android/厂商对 shell 读剪贴板限制；粘贴键仍可用 → 内容在，自动化读通路不通。
- **影响**：不能「复制完直接 API」；必须有读出器（评论框 PASTE / 或其它 App 粘贴）。
- **状态**：根因仍在；靠兜底绕过。

### 案例 B — 把链接贴进结果页搜索框（假重搜）

- **现象**：每出详情就像又搜了一遍；顶栏被 `v.douyin.com...` 污染。
- **根因**：旧兜底用搜索框当「剪贴板显示器」。
- **修法**：禁止 `pasteSearchBoxReadUrlThenClear`；改为 `pasteDetailCommentReadUrl`。
- **状态**：**已修**。日志应见 `PASTE_DETAIL` / `URL_VIA=paste_detail`。

### 案例 C — dump 缺 tab → 误判列表丢失 → 真重搜同词

- **现象**：滚动后 `tabs=false`，脚本 `LIST_LOST` → `goSearch` 同一关键词。
- **根因**：把「综合/视频 tab 是否进 dump」当成「是否还在结果页」。
- **修法**：有列表卡片 / SearchResult / 顶栏框即可；禁止因缺 tab 重搜。
- **状态**：**已修**（但曾矫枉过正，见案例 D）。

### 案例 D — 只搜一次狂滚，滚出关键词队列（用户可见「没搜词」）

- **现象**：后几页标题发散；停机时 dump **无搜索框、无综合/图文 tab**。
- **根因**：`once-search-then-scroll` + 「有卡片就当还在队列」过宽；不校验顶栏关键词。
- **修法**：
  - `boxMatchesKeyword`；不匹配 → `KW_MISMATCH` / `QUEUE_LOST` → **同词** `goSearch`
  - 每 3 页 `ensureOnKeywordQueue`
- **状态**：**已加**；两词批量未完整验收。曾实测：框变成「新疆赛里木湖」→ 重搜回「live记录 新疆」→ `KW_OK`。

### 案例 E — 分享面板固定坐标误开微信

- **现象**：前台变成 `com.tencent.mm`。
- **根因**：固定槽位（如面板死坐标）点到微信图标。
- **修法**：只点 dump 文案「分享链接/复制链接」；`ESCAPE_WECHAT` + skip 本帖。
- **状态**：**已修**（文案路径）。

### 案例 F — 外发条 / 右轨误触微博门闸（会话后期补记）

- **现象**：点「分享链接」后外发条出现微博；旧评论轨盲点靠近外发条 → MIUI「想要打开微博」。
- **修法方向**：分享后先 `dismissShareChrome`；评论轨避开危险 Y（见 `NOTES-weibo-gate-after-share-link-20260806.md`）。
- **状态**：以该 NOTES 为准；与案例 E 同类——**禁盲点坐标**。

### 案例 G — `paste_detail_miss` 连打触发 fail-stop

- **现象**：toast 有、评论区也点了，dump 仍是「说点什么…」无 URL；`failStreak` 到上限停。
- **例子**：`live记录 新疆` 在 8/10 时 `FAIL_STOP after 4 consecutive misses`（当时 `--fail-stop 4`）。
- **根因**：焦点没进真 EditText / 贴到提示节点 / 面板状态不对；评论右轨 Y 版本差。
- **状态**：未根治；靠多档轨 + fail-stop 止血。

### 案例 H — 「3 词上限」记忆偏差

- **实际有的**：
  - 脚本 `--fail-stop` 默认 **3**（连续读链失败停）
  - Explorer 预算方案：同 checkpoint **3** 次无进展熔断（**未部署**）
  - 飞书总目标 **200**，批量词表约 **8** 个，**没有**「只跑 3 个词」硬上限
- **状态**：认知问题；文档澄清即可。

### 案例 I — 笔记 App 粘贴方案未跑通

- **意图**：抖音复制 → 打开 `com.miui.notes` → 粘贴 → dump URL（少碰抖音评论）。
- **01 有包**：`com.miui.notes`。
- **翻车**：
  1. 笔记卡在 `NotesPreferenceActivity`，挡住抖音 launch
  2. 未断言前台 package 就搜/点 → `seed_no_card` / 点到错 App
  3. 种子「开帖+分享复制」不稳，**笔记粘贴步骤从未被实证**
- **状态**：**不能**据此说「笔记不行」；只能说「探针没做成」。

### 案例 J — 工程旁路问题（巡检/会话）

- 巡检脚本路径含空格被截断；`focus` 缺 `--serial` → 误报 `NO_SEARCH_BOX`
- 跨 App 探路缺少开局「双 force-stop + 断言 package」
- 采链仍用 session `shell`（正式 Explorer 预算上线后可能 fail closed）

---

## 4. 已改动的代码行为（摘要）

文件：`ops/douyin-harvest-share-links.mjs`

| 能力 | 说明 |
|---|---|
| `pasteDetailCommentReadUrl` | 详情评论框 PASTE 读链 |
| 搜索框粘贴 | 已阻塞 |
| 分享链接 | 仅 dump 文案节点 |
| `ESCAPE_WECHAT` | 误开微信则逃逸并 skip |
| `KW_MISMATCH` / `ensureOnKeywordQueue` / `QUEUE_LOST→goSearch` | 关键词漂移同词重搜 |
| `--fail-stop` | 默认 3；连续失败停整词 |

---

## 5. 修复建议（按优先级）

### P0 — 采链日常可执行约定

1. **`--fail-stop` 用 3**（与「连续 3 次」心智一致）；不要默认放到 4，除非人明示。
2. **熔断后不要盲续下一词**：先看最后 `reason`（`paste_detail_miss` / `no_share_link_btn` / `KW_MISMATCH`…）。
3. **开跑前确认**：01 ready、lease 空、抖音可启动；若刚测过笔记，先 `am force-stop com.miui.notes`。
4. **人机可见验收**：顶栏搜索框必须是当前关键词；日志要有 `FILTER_TUWEN` / `KW_OK`，不能长时间无搜词只有 `SCROLL_DOWN`。

### P1 — 熔断后的「LLM 定点复现 → 再沉淀脚本」（推荐流程）

适用：同词连续失败 ≥3（或 fail-stop 触发），或同 checkpoint 无进展。

```text
1) 脚本 FAIL_STOP
   落诊断包：keyword、reason、focus、最后 dump/截图、步骤（分享/粘贴/回列表）

2) LLM / Explorer 限次探路（不要从头搜到尾）
   - 只复现最后 2～3 步（例：开帖 → 分享 → 读链）
   - 单机、有 session；步数/时长帽（建议 ≤15 分钟或 ≤20 次 primitive）
   - 禁止无 lease 旁路

3) 改动要小
   - 例：评论轨 Y、dismiss 外发条、换读链表面（笔记 vs 评论）
   - 禁止一口气重写整条 harvest

4) 冒烟
   - 同一关键词 --need 3～5，要求无 KW 漂移、无微信/微博门闸、有 URL_VIA

5) 稳定 ≥2 次 → 合并进 ops/ 脚本 → 再批量
   失败 → ask_human，不自动开下一词硬冲
```

这与未部署的 Explorer「同卡点 3 次熔断再 pivot」同构；在控制面上线前，用 **脚本 fail-stop + 人工/LLM 定点修** 顶上。

### P2 — 读链策略（中期）

| 方案 | 优点 | 风险 | 建议 |
|---|---|---|---|
| A. 详情评论框 PASTE（当前） | 已跑通 20/20 | miss、误触评论、轨坐标 | 维持主路径，加 dismiss 外发条 |
| B. 系统笔记粘贴 | 不碰抖音评论 | 跨 App 焦点、耗时、未验证 | 单独做「种子复制成功后再贴笔记」探针；成功再双轨 |
| C. 正式 capability 读剪贴板 | 最干净 | 要平台能力/权限 | 长期正道；上线前 A/B 过渡 |
| D. 再贴搜索框 | — | **禁止** | 永不恢复 |

### P3 — 平台债（与采链并行，勿混为一谈）

- Explorer durable run / 预算 / 跨机熔断：**源码分支有，生产未部署**；部署前须先迁走 raw shell 依赖。
- 采链脚本依赖 `_win-xiaowei … shell`：与「arbitrary shell fail-closed」冲突 → 正式收口时要变成 typed action。
- 知识库：把本文案例收成 `pitfall`/`recipe`（带 `appliesTo`/`verifyMode`），勿只留 runtime 笔记。

### P4 — 批量冲 200 的执行建议

1. 词表用 `batch-harvest-01.mjs` 的 KWS；每词 `need=10` 或 `20`，`fail-stop=3`。
2. **同一 session 换词前**：必须看到新词的 `FILTER_TUWEN` + 顶栏框==新词（脚本应 `goSearch`；人眼抽查）。
3. 单词 fail-stop → 走 P1，**不要**自动 foreach 下一个。
4. 飞书以 `_count-feishu.mjs` 为准；本地 `harvested.json` 只服务同词 resume。

---

## 6. 建议沉淀成知识库的条目（待补，本会话未写 registry）

| 拟 id | 类型 | 要点 |
|---|---|---|
| `pitfall-douyin-01-clipboard-toast-shell-miss` | pitfall | toast≠shell 可读 |
| `recipe-douyin-paste-detail-comment-read-share-url` | recipe | 详情评论框 PASTE 读链 |
| `pitfall-douyin-paste-into-searchbox-fake-research` | pitfall | 禁搜索框粘贴 |
| `pitfall-douyin-share-fixed-slot-opens-wechat` | pitfall | 分享禁死坐标 |
| `recipe-douyin-kw-guard-research-on-box-mismatch` | recipe | 顶栏词漂移则同词重搜 |
| `pitfall-douyin-failstop-then-llm-repro` | recipe | 连续 3 次失败后定点复现再改脚本 |

---

## 7. 一句话结论

- **根因**：01 上分享复制成功，自动化读不到剪贴板。  
- **能跑**：评论框 PASTE + 关键词守卫 + 文案点分享；单词 20 已证明。  
- **仍脆**：paste miss、外发条/微博门闸、跨 App（笔记）焦点、两词切换纪律。  
- **最好的「卡死修复」**：fail-stop（3）→ LLM/人按脚本末步定点复现 → 小改 → 冒烟 → 再写入脚本；不要无熔断狂滚，也不要每帖都上 LLM。

---

## 8. 待你拍板

1. 日常 `fail-stop` 是否固定为 **3**？  
2. 是否采纳 P1「熔断后 LLM 定点复现」写成 `/xw` 或采链约定？  
3. 笔记粘贴：要不要单独排一次「先保证抖音复制成功，再只测笔记」的短探针？  
4. 本文案例是否批准写入 registry 知识库（上表拟 id）？
