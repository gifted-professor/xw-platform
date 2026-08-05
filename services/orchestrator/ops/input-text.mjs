#!/usr/bin/env node
// Explorer lab：效卫 XwIME 输入中文（经 session_action，禁止直连 22222）
//
//   node ops/input-text.mjs --alias 03 --session-file <ctx> --text "蓝色"
//   node ops/input-text.mjs --alias 03 --session-file <ctx> --text "蓝色" --x 540 --y 1200 --enter
import { authorizeExplorerLease, parseArgs, resolveDevice, runExplorerPrimitive } from "./_explore-lib.mjs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/input-text.mjs --alias <01-04> --session-file <context.json> --text <str> [选项]

选项:
  --x --y          切 XwIME 后 refocus 点击（Flutter 首进字段强烈建议）
  --no-refocus     不点 --x/--y（保持当前光标；多行连续输入用）
  --clear-first    输入前 DEL 清空
  --enter          输入后 KEYCODE_ENTER
  --keep-ime       不还原原 IME（默认还原；多行连续建议开）
  --ssh <host>     默认 xhs-windows

经 xiaowei.explorer.primitive session_action；中文勿用 adb input text。
stdout: INPUT=ok`);
  process.exit(0);
}

const alias = opt("--alias");
const text = opt("--text");
const ssh = opt("--ssh", "xhs-windows");
const sessionFile = opt("--session-file");
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

try {
  await authorizeExplorerLease(ssh, alias, sessionFile);
  const { serial } = resolveDevice(ssh, alias);
  const params = {
    primitive: "input_text",
    text: String(text),
  };
  if (!noRefocus && x != null && y != null) {
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
      console.log("✗ --x --y must be numeric");
      process.exit(4);
    }
    params.refocusX = Math.round(Number(x));
    params.refocusY = Math.round(Number(y));
  }
  if (clearFirst) params.clearFirst = true;
  if (doEnter) params.enter = true;
  if (keepIme) params.deferRestore = true;

  const result = await runExplorerPrimitive(params);
  const a = result.output?.audit || {};
  console.log(`INPUT=ok`);
  console.log(`TEXT_LEN=${result.output?.textLen ?? String(text).length}`);
  console.log(`PREVIEW=${(result.output?.textPreview || String(text)).slice(0, 40)}`);
  console.log(`JOB=${result.jobId}`);
  console.log(`ALIAS=${alias}`);
  console.log(`SERIAL=${serial}`);
  console.log(`REFOCUS=${a.refocused ? "yes" : "no"}`);
  console.log(`NO_REFOCUS_FLAG=${noRefocus ? "yes" : "no"}`);
  console.log(`CLEARED=${a.cleared ? "yes" : "no"}`);
  console.log(`ENTER=${a.enter ? "yes" : "no"}`);
  console.log(`IME_RESTORED=${a.restored ? "yes" : "no"}`);
  if (a.priorIme) console.log(`PRIOR_IME=${a.priorIme}`);
  if (!a.refocused && !noRefocus) {
    console.log("HINT=Flutter first-focus needs --x --y after IME switch; multi-line follow-ups use --no-refocus");
  }
  process.exit(0);
} catch (e) {
  console.log(`✗ ${e.message}`);
  process.exit(e.code === 2 ? 2 : 4);
}
