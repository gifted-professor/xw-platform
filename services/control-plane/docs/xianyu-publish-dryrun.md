# 闲鱼发布页 dry-run

本入口只验证“启动闲鱼并进入发布编辑页”，不点击最终“发布”，也不发送聊天。

## 标准草稿流程（2026-07-26 实战固化）

每个 App 有各自固定剧本；闲鱼当前推荐 **单会话** 标准链（避免控制面每 job restore 打断）：

| 步 | 做什么 | 能力 / 要点 |
|---|---|---|
| 1 | 开启发闲置 | `xianyu.publish.open_dry_run` |
| 2 | 填描述 | `input_dry_run`；`\n` 先规范化为空格 |
| 3 | 传图 | `image_dry_run`；相册 Name·count + SHA |
| 4 | 规格 + 批量价库 | `full_dry_run` + `skuSpecs` + `calibrated.sku`：**只键入不点推荐 chip**；数字键盘键间隔 ≥450ms；右下角确定 |
| 5 | 发货方式 | `freightTemplate: "包邮"` + `calibrated.freight`；多行块按行心点 |
| 6 | 存草稿（独立副作用） | `full_draft_dry_run` 或 `save_draft_dry_run`；必须走控制面审批 job |

独立价格字段的验收必须区分两阶段：首次打开的 sheet 内出现目标数字只证明按键已注册；
点击右下角「确定」关闭后，compose 视觉行会显示 `¥199.00`，但部分 Flutter 版本的
accessibility label 仍可能只有「价格设置」。此时须重开价格 sheet，从价格字段自身回读
持久化值，再点「确定」返回 compose。不得用首次 sheet 内的值假充 commit 证据，也不得
因 compose 语义占位未更新而把视觉上已提交的价格误判为失败。sheet/compose 使用
`sheet | compose | ambiguous` 三态判定；稀疏或矛盾 dump 必须停止并恢复。价格硬失败后
禁止继续后续字段或保存草稿。

```bash
# 纯整表 dry-run：不会存草稿，控制面自动 lease
node control-plane/devicectl.mjs --ssh xhs-windows job submit \
  --actor <agent-id> \
  --capability xianyu.publish.full_dry_run \
  --idempotency-key <unique-key> \
  --params '<json>'

# 完整标准草稿：会先进入 waiting_approval，批准后才保存草稿
node control-plane/devicectl.mjs --ssh xhs-windows job submit \
  --actor <agent-id> \
  --capability xianyu.publish.full_draft_dry_run \
  --idempotency-key <unique-key> \
  --params '<json>'
```

控制面 capability：

- `xianyu.publish.full_dry_run` — 纯整表剧本，永不存草稿
- `xianyu.publish.full_draft_dry_run` — 整表后存一个草稿，external_effect + approval
- `xianyu.publish.save_draft_dry_run` — 仅存草稿

**红线：** 永不点最终「发布」。存草稿会写用户草稿箱，restore 不再 discard。

## Live supervisor（2026-07-26）

Agent 执行 ≠ 死脚本：`publishDryRun` 内置 `createStepSupervisor`：

- 每步打点：`{event:"supervisor", phase, name, attempt, ok, step}`
- 失败先 `recover`（`ensureOnPublishCompose` 重进发闲置），再有限次重试
- 证据截图 **fail-soft**（`captureEvidenceSoft`）：截图 ENOENT 不阻断填文案
- 并发截图：每 serial 独立目录 `_gwshot_<serial>/`，避免互相 rename
- SKU 找不到「下一步」时**不再三连 BACK 退桌面**（02 机教训），先上滑找按钮

后续可把 supervisor 事件接到面板/飞书，实现真正的「实时维持」。

## 为什么单独实现

- `fast-operator.mjs` 的业务原语依赖小红书页面结构，不应复用于闲鱼。
- 闲鱼 Flutter 页面仍会把相当一部分语义写入 `content-desc`；先读 uiautomator 语义树，缺失时再升级截图/OCR。
- 绿箭底层已经支持 `startApk/stopApk/apkList`，原来的问题是本仓库 CLI 只暴露了 `start-xhs`。

## 通用应用命令

这些绿箭直调命令同样只用于有书面原因的 lab 诊断；运行前必须设置
`XHS_ALLOW_BYPASS=1` 和 `XHS_BYPASS_REASON`，不能作为生产验收证据。

```powershell
$env:LVJIAN_DEVICE='REPLACE_SERIAL_01'
node scripts/greenarrow-api.mjs start-apk com.taobao.idlefish
node scripts/greenarrow-api.mjs stop-apk com.taobao.idlefish
node scripts/greenarrow-api.mjs apk-list
```

`start-xhs` 保持兼容。包名必须符合 Android 包名格式，缺失或非法时 fail-closed。

## 闲鱼发布页试运行

以下直调命令只保留给明确记录的离线/lab 诊断，生产验收必须改用上面的
`devicectl job/session`。直调时缺少有效 lease 会被硬闸拒绝；实验旁路还需
同时设置 `XHS_ALLOW_BYPASS=1` 与 `XHS_BYPASS_REASON`，且结果不计入生产验收。

```powershell
node scripts/xianyu-operator.mjs --serial REPLACE_SERIAL_01 snapshot
node scripts/xianyu-operator.mjs --serial REPLACE_SERIAL_01 open-publish
node scripts/xianyu-operator.mjs --serial REPLACE_SERIAL_01 input-dry-run --text 闲鱼发布页输入测试
node scripts/xianyu-operator.mjs --serial REPLACE_SERIAL_01 discard-dry-run
```

`open-publish` 的固定安全语义：

1. 启动 `com.taobao.idlefish`。
2. 从 `text/content-desc` 提取可见语义节点。
3. 只点击“卖闲置”“发闲置”或“发布闲置”。
4. 识别到描述、价格/分类/成色/运费等编辑字段后立即停止。
5. 裸“发布”永远不作为导航入口，防止误触最终发布。

`input-dry-run` 只在已识别为发布编辑页、描述框仍是空白占位状态且 Flutter InputConnection 活跃时运行：切换到效卫桥 IME、重新点一次描述框让 Flutter 重绑 InputConnection、写入临时文本、截图、在全页面语义节点中校验完整文本、清空并确认占位内容恢复，最后切回原输入法。任一证据缺失都返回失败，不点击发布，也不触碰已有草稿。

整表验收可以给 `input-dry-run` 加 `--keep-until-discard`，把已实证的描述暂时保留到截图阶段。该模式不会发送额外的 BACK，避免切回原输入法后误退出编辑页；截图完成后必须调用 `discard-dry-run`。后者只接受语义层精确识别出的“不保存”按钮；识别不到就停止，右侧“存草稿”和顶部“发布”始终禁触。

## 现场前置条件

- 目标设备 `/status.running=false`。
- 控制面 route 可用，目标设备 lease 在 `/control/v1/leases` 可见。
- 闲鱼包已安装。
- 当前操作已获授权；真发布、选图、保存草稿和聊天仍需单独授权。

## 降级顺序

1. uiautomator `text/content-desc`。
2. 已知页面的稳定坐标，但必须同时校验前台包名和页面语义。
3. 截图 + OCR，仅用于补充文本定位；每次点击后仍重新校验页面。
4. 页面无法可靠识别时 fail-closed，不猜测点击。

## 2026-07-21 · 4 号机现场结果

设备：`REPLACE_SERIAL_04`。

- 自动流程从闲鱼 `MainActivity` 进入“卖闲置”菜单，再进入“发闲置”编辑页：通过。
- 编辑页识别到发布、添加图片、描述、商品规格、价格、发货方式和位置；最终发布未点击。
- “添加图片”进入相册选择器：通过；未选择图片，随后关闭返回。
- Flutter 描述框可获得 InputConnection；ADB ASCII `XYTEST0721` 真实写入并清空：通过。
- 中文输入根因：Flutter 输入框在运行中切换 IME 后，没有自动把旧焦点绑定给效卫桥；只看 `inputText code=10000` 会形成假成功。
- 修复后链路：`SogouIME → XwIME → 重新点击描述框 → InputConnectionAdaptor 在岗 → inputText → 完整中文语义实证 → 清空 → 占位恢复 → SogouIME`。
- 临时文本 `闲鱼中文输入验收0721` 真实进入描述框：通过；`textVerified=true`。
- 临时文本清空且原占位恢复：通过；`clearedVerified=true`。
- 输入法恢复为 `com.sohu.inputmethod.sogou.xiaomi/.SogouIME`：通过；`imeRestored=true`。
- 最终结果：`ok=true`、`step=completed`、`stoppedBeforePublish=true`；没有选择图片、没有保存草稿、没有点击发布。

因此当前可对 Hermes 开放“启动闲鱼、进入发布页、读取页面、打开并退出相册、在空白新建页写入并实证中文描述”的固定流程。后续正式保留描述内容、选图、定价、保存草稿和点击发布仍需单独命令与授权；不得把桥返回成功当作编辑器实证。

## 2026-07-21 · 4 号机整表 dry-run

- 使用单独推送并校验 SHA-256 的受控测试图，选图、图片编辑页“完成”和回填通过。
- 中文描述 `闲鱼完整表单试运行0721` 真实写入，`textVerified=true`；输入法恢复通过。
- 商品规格设置两条，价格均为 `12.34`，库存各 `2`；发布页汇总为库存 `4`。
- 发货方式设为包邮；所在地已在视觉页面回填。该 Flutter 版本的所在地语义仍错误显示“选择位置”，因此位置必须保留截图证据，记录中不得写真实地址。
- 图片识别动态生成的类别字段也已实测：分类、品牌、成色、尺码、适用季节、裤长、腰型都能点选。不同分类会生成不同字段，不能写成一套固定坐标。
- `描述不符包邮退`、`24小时发货`、`48小时发货` 属于经营承诺，本次保持关闭，不替账号作承诺。
- 规格弹窗推荐项可选；底部“下一步”在第二轮出现 ADB/绿箭点击偶发不响应。第一轮完整规格、价格、库存链路已成功，但在修复稳定点击前，不得宣称“一键整表命令”稳定可用。
- 收尾明确选择“不保存”，回到闲鱼 `MainActivity`；草稿箱仍为 `11`，没有新增草稿，没有点击发布。
