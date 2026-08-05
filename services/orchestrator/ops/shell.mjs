#!/usr/bin/env node
// node ops/shell.mjs --alias 01 --cmd "input swipe 540 1800 540 700 350"
// SSH-safe via --cmd-b64 inside _win-xiaowei
import {
  authorizeExplorerLease,
  parseArgs,
  resolveDevice,
  ensureWinHelper,
  runWinShell,
} from "./_explore-lib.mjs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/shell.mjs --alias <01-04> --session-file <context.json> --cmd "<adb shell cmd>"
Explorer lab（22222）。带空格命令请整段放进 --cmd。
stdout: SHELL=ok`);
  process.exit(0);
}
const alias = opt("--alias");
const cmd = opt("--cmd");
const ssh = opt("--ssh", "xhs-windows");
const sessionFile = opt("--session-file");
if (!alias || !cmd) {
  console.log("✗ need --alias --cmd");
  process.exit(4);
}
try {
  await authorizeExplorerLease(ssh, alias, sessionFile);
  const { serial } = resolveDevice(ssh, alias);
  const helper = ensureWinHelper(ssh);
  const j = runWinShell(ssh, serial, cmd, helper);
  if (!j.ok) {
    console.log(`✗ ${j.error || "shell failed"}`);
    process.exit(2);
  }
  const stdout = String(j.stdout || "");
  // Detect accidental "input" with no args (old quoting bug)
  if (/^Usage:\s*input/i.test(stdout.trim())) {
    console.log("✗ shell cmd looks truncated (got input Usage help)");
    console.log(`STDOUT=${stdout.slice(0, 200).replace(/\n/g, "\\n")}`);
    process.exit(2);
  }
  console.log(`SHELL=ok`);
  console.log(`CMD=${cmd}`);
  if (stdout) console.log(`STDOUT=${stdout.replace(/\n/g, "\\n").slice(0, 2000)}`);
  console.log(`ALIAS=${alias}`);
  console.log(`SERIAL=${serial}`);
  process.exit(0);
} catch (e) {
  console.log(`✗ ${e.message}`);
  process.exit(e.code === 2 ? 2 : 4);
}
