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

`input-dry-run` 只在已识别为发布编辑页且 Flutter InputConnection 活跃时运行：写入临时文本、截图、校验描述节点确实变化、清空并再次校验；任一证据缺失都返回失败，不点击发布。

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
- 小薇 `inputText` 返回成功，但中文没有进入描述框：未通过。
- 小薇 `writeClipboard` + Android `KEYCODE_PASTE` 返回成功，但中文仍未进入描述框：未通过。

因此当前可对 Hermes 开放“启动闲鱼、进入发布页、读取页面、打开并退出相册”的固定流程；中文描述输入仍必须交回 Codex，不得把桥返回成功当作编辑器实证。
