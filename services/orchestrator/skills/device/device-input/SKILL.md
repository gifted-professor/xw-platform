---
name: device-input
description: 在设备上输入中文文本。走效卫 XwIME，禁止 adb input text / clipboard 当主路径。
triggers:
  - device-input
  - 输入
  - 中文输入
  - input text
version: "1.0"
verified:
  - date: 2026-07-28
    device: "01"
    result: pass
---

# 中文输入（device-input）

## 用法

```bash
# 基本输入（先点坐标聚焦，再输入）
node ops/input-text.mjs --alias <01-04> --session-file <explorer-session.json> --text "蓝色" --x 540 --y 1200

# 输入后按回车（SKU 规格值）
node ops/input-text.mjs --alias <01-04> --session-file <explorer-session.json> --text "蓝色" --x 540 --y 1200 --enter

# 多行输入：首行 refocus，后续行 no-refocus
node ops/input-text.mjs --alias <01-04> --session-file <explorer-session.json> --text "行1" --x 540 --y 870 --enter --keep-ime
node ops/input-text.mjs --alias <01-04> --session-file <explorer-session.json> --text "行2" --enter --keep-ime --no-refocus
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--alias` | ✅ | 设备别名 01-04 |
| `--text` | ✅ | 要输入的文本 |
| `--x` / `--y` | ❌ | 点击聚焦坐标（首行必填） |
| `--enter` | ❌ | 输入后按回车 |
| `--keep-ime` | ❌ | 保持输入法不关闭 |
| `--no-refocus` | ❌ | 不重新聚焦（多行续行用） |
| `--clear-first` | ❌ | 输入前清空已有文本 |

## Flutter（闲鱼）特殊规则

| 场景 | 参数 |
|------|------|
| 首行输入 | `--x --y` refocus |
| 多行续行 | `--no-refocus` + `--keep-ime` |
| SKU 规格值 | `--enter` |

详见 `skills/shared/pitfalls.md` 的 `pitfall-input-text-multiline-refocus-20260727`。

## 禁止

- ❌ `adb shell input text`（不支持中文）
- ❌ clipboard paste 当中文主路径（不稳定）

## 相关

- 点击聚焦：`skills/device/device-tap`
- 坑点手册：`skills/shared/pitfalls.md`
