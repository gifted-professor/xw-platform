#!/usr/bin/env node
// node ops/swipe.mjs --alias 01 --up
// node ops/swipe.mjs --alias 01 --x1 540 --y1 1800 --x2 540 --y2 700 --ms 350
import { parseArgs, resolveDevice, ensureWinHelper, runWinShell } from "./_explore-lib.mjs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法:
  node ops/swipe.mjs --alias <01-04> --up|--down|--left|--right [--ms 350]
  node ops/swipe.mjs --alias <01-04> --x1 N --y1 N --x2 N --y2 N [--ms 350]
默认分辨率假设 1080x2400 中部手势。stdout: SWIPE=ok`);
  process.exit(0);
}
const alias = opt("--alias");
const ssh = opt("--ssh", "xhs-windows");
const ms = Math.max(50, Number(opt("--ms", "350")) || 350);
if (!alias) {
  console.log("✗ need --alias");
  process.exit(4);
}

let x1 = opt("--x1");
let y1 = opt("--y1");
let x2 = opt("--x2");
let y2 = opt("--y2");

// preset gestures on 1080x2400
if (flag("--up")) {
  x1 = 540; y1 = 1800; x2 = 540; y2 = 700;
} else if (flag("--down")) {
  x1 = 540; y1 = 700; x2 = 540; y2 = 1800;
} else if (flag("--left")) {
  x1 = 850; y1 = 1200; x2 = 200; y2 = 1200;
} else if (flag("--right")) {
  x1 = 200; y1 = 1200; x2 = 850; y2 = 1200;
}

x1 = Math.round(Number(x1));
y1 = Math.round(Number(y1));
x2 = Math.round(Number(x2));
y2 = Math.round(Number(y2));
if (![x1, y1, x2, y2].every(Number.isFinite)) {
  console.log("✗ need preset --up/--down/--left/--right or numeric --x1 --y1 --x2 --y2");
  process.exit(4);
}

try {
  const { serial } = resolveDevice(ssh, alias);
  const helper = ensureWinHelper(ssh);
  const cmd = `input swipe ${x1} ${y1} ${x2} ${y2} ${ms}`;
  const j = runWinShell(ssh, serial, cmd, helper);
  if (!j.ok) {
    console.log(`✗ ${j.error || "swipe failed"}`);
    process.exit(2);
  }
  const stdout = String(j.stdout || "");
  if (/^Usage:\s*input/i.test(stdout.trim())) {
    console.log("✗ swipe cmd truncated");
    process.exit(2);
  }
  console.log(`SWIPE=ok`);
  console.log(`X1=${x1}`);
  console.log(`Y1=${y1}`);
  console.log(`X2=${x2}`);
  console.log(`Y2=${y2}`);
  console.log(`MS=${ms}`);
  console.log(`ALIAS=${alias}`);
  console.log(`SERIAL=${serial}`);
  process.exit(0);
} catch (e) {
  console.log(`✗ ${e.message}`);
  process.exit(e.code === 2 ? 2 : 4);
}
