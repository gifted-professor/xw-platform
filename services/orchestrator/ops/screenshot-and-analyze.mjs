#!/usr/bin/env node
// 一步截屏到本地路径（Mac SSH 或 Windows 本地均可）
//
//   node ops/screenshot-and-analyze.mjs --alias 01
//   node ops/screenshot-and-analyze.mjs --alias 01 --out /tmp/a.png
//   node ops/screenshot-and-analyze.mjs --alias 01 --local
//   node ops/screenshot-and-analyze.mjs --alias 01 --analyze   # 可选：调本地 analyze.py
//
// stdout 含一行: SHOT=/abs/path.png
// exit: 0 ok | 2 设备不行 | 4 客户端

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  authorizeExplorerLease,
  parseArgs,
  resolveDevice,
  ensureWinHelper,
  runWinXiaowei,
  parseJsonLine,
  scpFrom,
  isLocalMode,
} from "./_explore-lib.mjs";

const { opt, flag } = parseArgs(process.argv.slice(2));
const SESSION_FILE = opt("--session-file");

if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/screenshot-and-analyze.mjs --alias <01-04> [选项]

选项:
  --session-file <context.json>  必填；由 xw-explore-session acquire 生成
  --ssh xhs-windows
  --local               本机直跑（Windows；也可用 XHS_LOCAL=1）
  --out <local.png>     默认 %TEMP%/xhs-explore/<alias>-<ts>.png
  --analyze             若存在 visual-grounding-poc，对截图跑 analyze.py
  --vgp <path>          默认 ~/Desktop/Coding/visual-grounding-poc

环境: Mac=SSH / Windows=本地短路；截屏封装在 ops/_win-screencap.mjs → 22222。
禁止手搓逐步 scp——用本脚本。`);
  process.exit(0);
}

const ALIAS = opt("--alias");
const SSH = opt("--ssh", "xhs-windows");
const VGP = opt("--vgp", join(process.env.HOME || process.env.USERPROFILE || "", "Desktop/Coding/visual-grounding-poc"));
const ANALYZE = flag("--analyze");
const TS = Date.now();
const OUT = resolve(opt("--out", join(tmpdir(), "xhs-explore", `${ALIAS || "xx"}-${TS}.png`)));

if (!ALIAS) {
  console.log("✗ 需要 --alias");
  process.exit(4);
}

try {
  await authorizeExplorerLease(SSH, ALIAS, SESSION_FILE);
  const { serial } = resolveDevice(SSH, ALIAS);
  const helper = ensureWinHelper(SSH, "_win-screencap.mjs");
  const remotePng = `C:/Users/Public/xhs-agent-runs/_explore/shot-${ALIAS}-${TS}.png`;

  let raw;
  try {
    raw = runWinXiaowei(SSH, helper, ["--serial", serial, "--out", remotePng]);
  } catch (e) {
    const msg = `${e.message || e}`.slice(0, 500);
    console.log(`✗ screencap failed: ${msg}`);
    process.exit(2);
  }

  let meta;
  try {
    meta = parseJsonLine(raw);
  } catch {
    console.log(`✗ bad screencap response: ${String(raw).slice(0, 200)}`);
    process.exit(4);
  }
  if (!meta.ok) {
    console.log(`✗ ${meta.error || "screencap not ok"}`);
    process.exit(2);
  }

  scpFrom(SSH, remotePng.replace(/\\/g, "/"), OUT);
  if (!existsSync(OUT)) {
    console.log(`✗ ${isLocalMode() ? "本地拷贝" : "scp"} 后文件不存在`);
    process.exit(4);
  }

  console.log(`SHOT=${OUT}`);
  console.log(`SERIAL=${serial}`);
  console.log(`ALIAS=${ALIAS}`);

  if (ANALYZE) {
    const pyUnix = join(VGP, ".venv", "bin", "python");
    const pyWin = join(VGP, ".venv", "Scripts", "python.exe");
    const py = existsSync(pyWin) ? pyWin : pyUnix;
    const analyze = join(VGP, "analyze.py");
    if (!existsSync(py) || !existsSync(analyze)) {
      console.log("ANALYZE_SKIP=no visual-grounding-poc");
    } else {
      const elements = OUT.replace(/\.png$/i, ".elements.json");
      try {
        execFileSync(py, [analyze, OUT, "-o", elements], {
          cwd: VGP,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120000,
        });
        console.log(`ELEMENTS=${elements}`);
      } catch (e) {
        console.log(`ANALYZE_FAIL=${String(e.stderr || e.message).slice(0, 200)}`);
      }
    }
  }

  console.log("✓ screenshot ok");
  process.exit(0);
} catch (e) {
  console.log(`✗ ${e.message || e}`);
  process.exit(e.code === 2 ? 2 : 4);
}
