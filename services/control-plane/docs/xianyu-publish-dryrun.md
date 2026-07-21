# 闲鱼发布页 dry-run

本入口只验证“启动闲鱼并进入发布编辑页”，不点击最终“发布”，也不发送聊天。

## 为什么单独实现

- `fast-operator.mjs` 的业务原语依赖小红书页面结构，不应复用于闲鱼。
- 闲鱼 Flutter 页面仍会把相当一部分语义写入 `content-desc`；先读 uiautomator 语义树，缺失时再升级截图/OCR。
- 绿箭底层已经支持 `startApk/stopApk/apkList`，原来的问题是本仓库 CLI 只暴露了 `start-xhs`。

## 通用应用命令

```powershell
$env:LVJIAN_DEVICE='REPLACE_SERIAL_01'
node scripts/greenarrow-api.mjs start-apk com.taobao.idlefish
node scripts/greenarrow-api.mjs stop-apk com.taobao.idlefish
node scripts/greenarrow-api.mjs apk-list
```

`start-xhs` 保持兼容。包名必须符合 Android 包名格式，缺失或非法时 fail-closed。

## 闲鱼发布页试运行

```powershell
node scripts/xianyu-operator.mjs --serial REPLACE_SERIAL_01 snapshot
node scripts/xianyu-operator.mjs --serial REPLACE_SERIAL_01 open-publish
node scripts/xianyu-operator.mjs --serial REPLACE_SERIAL_01 input-dry-run --text 闲鱼发布页输入测试
```

`open-publish` 的固定安全语义：

1. 启动 `com.taobao.idlefish`。
2. 从 `text/content-desc` 提取可见语义节点。
3. 只点击“卖闲置”“发闲置”或“发布闲置”。
4. 识别到描述、价格/分类/成色/运费等编辑字段后立即停止。
5. 裸“发布”永远不作为导航入口，防止误触最终发布。

`input-dry-run` 只在已识别为发布编辑页、描述框仍是空白占位状态且 Flutter InputConnection 活跃时运行：切换到效卫桥 IME、重新点一次描述框让 Flutter 重绑 InputConnection、写入临时文本、截图、在全页面语义节点中校验完整文本、清空并确认占位内容恢复，最后切回原输入法。任一证据缺失都返回失败，不点击发布，也不触碰已有草稿。

## 现场前置条件

- 目标设备 `/status.running=false`。
- `/agent/state.active=false`，随后使用独立 id takeover。
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
