#!/usr/bin/env node
// node ops/shell.mjs — arbitrary shell is intentionally fail-closed for /xw explore
import { parseArgs } from "./_explore-lib.mjs";

const { flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: 已禁用

arbitrary adb shell 不是 bounded Explorer primitive。
请用 tap / swipe / back / focus / dump-ui / input-text / launch-app / screenshot-and-analyze
（均经 xiaowei.explorer.primitive session_action）。`);
  process.exit(0);
}
console.log("✗ EXPLORER_SHELL_NOT_BOUNDED: arbitrary shell is not an Explorer primitive");
process.exit(4);
