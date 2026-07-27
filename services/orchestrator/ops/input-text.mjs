#!/usr/bin/env node
// Explorer lab：效卫 XwIME 输入中文（禁止 adb input text / clipboard paste 当中文主路径）
//
//   node ops/input-text.mjs --alias 03 --text "蓝色"
//   node ops/input-text.mjs --alias 03 --text "蓝色" --x 540 --y 1200 --enter
//   node ops/input-text.mjs --alias 03 --text "蓝色" --x 540 --y 1200 --clear-first --enter
//   # 多行描述：首行 refocus，后续 --no-refocus（并建议 --keep-ime 少切 IME）
//   node ops/input-text.mjs --alias 01 --text "行1" --x 540 --y 870 --enter --keep-ime
//   node ops/input-text.mjs --alias 01 --text "行2" --enter --keep-ime --no-refocus
//
// Flutter（闲鱼等）：切 IME 后首进字段须 --x --y refocus，否则可能 code=10000 但字不进框。
// 多行连续输入：每行再 refocus 会点飞光标 → 用 --no-refocus 保持光标（框已聚焦时）。
// 规格值提交常需 --enter（operator 路径：input + KEYCODE_ENTER）。
//
// stdout 键：INPUT=ok TEXT_LEN=… PREVIEW=… ALIAS=… SERIAL=… REFOCUS=… ENTER=… RESTORED=…
import { parseArgs, resolveDevice, ensureWinHelper, runWinXiaowei, parseJsonLine } from "./_explore-lib.mjs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/input-text.mjs --alias <01-04> --text <str> [选项]

选项:
  --x --y          切 XwIME 后 refocus 点击（Flutter 首进字段强烈建议）
  --no-refocus     不点 --x/--y（保持当前光标；多行连续输入用）
  --clear-first    输入前 DEL 清空
  --enter          输入后 KEYCODE_ENTER（SKU 规格值 / 多行换行）
  --keep-ime       不还原原 IME（默认还原；多行连续建议开）
  --ssh <host>     默认 xhs-windows

走小薇 22222 效卫 inputText；中文勿用 adb input text / clipboard。
多行配方：首行 --x --y [--enter] --keep-ime；后续 --enter --keep-ime --no-refocus。
stdout: INPUT=ok`);
  process.exit(0);
}

const alias = opt("--alias");
const text = opt("--text");
const ssh = opt("--ssh", "xhs-windows");
const x = opt("--x");
const y = opt("--y");
const clearFirst = flag("--clear-first");
const doEnter = flag("--enter");
const keepIme = flag("--keep-ime");
const noRefocus = flag("--no-refocus");

if (!alias || text == null || text === "") {
  console.log("✗ need --alias --text");
  process.exit(4);
}

// 经 ssh/argv 传中文不稳：base64 过桥
const textB64 = Buffer.from(String(text), "utf8").toString("base64");

try {
  const { serial } = resolveDevice(ssh, alias);
  const helper = ensureWinHelper(ssh);
  const args = [
    "--serial", serial,
    "--action", "inputText",
    "--text-b64", textB64,
  ];
  // 默认：有 --x --y 就 refocus（Flutter 切 IME 后重建 connection）
  // --no-refocus：跳过点击，保留 Enter 后光标（多行描述框）
  if (!noRefocus && x != null && y != null) {
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
      console.log("✗ --x --y must be numeric");
      process.exit(4);
    }
    args.push("--refocus-x", String(Math.round(Number(x))), "--refocus-y", String(Math.round(Number(y))));
  }
  if (clearFirst) args.push("--clear-first");
  if (doEnter) args.push("--enter");
  if (keepIme) args.push("--defer-restore");

  const raw = runWinXiaowei(ssh, helper, args);
  const j = parseJsonLine(raw);
  if (!j.ok) {
    console.log(`✗ ${j.error || "inputText failed"}`);
    process.exit(2);
  }
  const a = j.audit || {};
  console.log(`INPUT=ok`);
  console.log(`TEXT_LEN=${j.textLen ?? String(text).length}`);
  console.log(`PREVIEW=${(j.textPreview || String(text)).slice(0, 40)}`);
  console.log(`ALIAS=${alias}`);
  console.log(`SERIAL=${serial}`);
  console.log(`REFOCUS=${a.refocused ? "yes" : "no"}`);
  console.log(`NO_REFOCUS_FLAG=${noRefocus ? "yes" : "no"}`);
  if (a.refocusX != null) console.log(`REFOCUS_X=${a.refocusX}`);
  if (a.refocusY != null) console.log(`REFOCUS_Y=${a.refocusY}`);
  console.log(`CLEARED=${a.cleared ? "yes" : "no"}`);
  console.log(`ENTER=${a.enter ? "yes" : "no"}`);
  console.log(`IME_RESTORED=${a.restored ? "yes" : "no"}`);
  if (a.priorIme) console.log(`PRIOR_IME=${a.priorIme}`);
  if (!a.refocused && !noRefocus) {
    console.log("HINT=Flutter first-focus needs --x --y after IME switch; multi-line follow-ups use --no-refocus");
  }
  if (noRefocus) {
    console.log("HINT=no-refocus: cursor preserved; if text missing, first line should use --x --y without --no-refocus");
  }
  process.exit(0);
} catch (e) {
  console.log(`✗ ${e.message}`);
  process.exit(e.code === 2 ? 2 : 4);
}
