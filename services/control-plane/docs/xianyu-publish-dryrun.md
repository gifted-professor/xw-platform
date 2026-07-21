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

`input-dry-run` 只在已识别为发布编辑页时运行：输入临时文本、截图、清空、再次截图并恢复原输入法；不点击发布。

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
