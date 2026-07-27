#!/usr/bin/env node
// 一步截屏到 Mac 本地路径（替代「写脚本→scp→adb→拉图」手搓链）
//
//   node ops/screenshot-and-analyze.mjs --alias 01
//   node ops/screenshot-and-analyze.mjs --alias 01 --out /tmp/a.png
//   node ops/screenshot-and-analyze.mjs --alias 01 --analyze   # 可选：调本地 analyze.py
//
// stdout 含一行: SHOT=/abs/path.png
// exit: 0 ok | 2 设备不行 | 4 客户端

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const argv = process.argv.slice(2);
const opt = (n, fb = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : fb;
};
const flag = (n) => argv.includes(n);

if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/screenshot-and-analyze.mjs --alias <01-04> [选项]

选项:
  --ssh xhs-windows
  --out <local.png>     默认 /tmp/xhs-explore/<alias>-<ts>.png
  --analyze             若存在 visual-grounding-poc，对截图跑 analyze.py
  --vgp <path>          默认 ~/Desktop/Coding/visual-grounding-poc

环境: Mac 客户端；截屏经 SSH + Windows adb（封装在 ops/_win-screencap.mjs）。
禁止手搓逐步 scp——用本脚本。`);
  process.exit(0);
}

const ALIAS = opt("--alias");
const SSH = opt("--ssh", "xhs-windows");
const VGP = opt("--vgp", join(process.env.HOME || "", "Desktop/Coding/visual-grounding-poc"));
const ANALYZE = flag("--analyze");
const TS = Date.now();
const OUT = resolve(opt("--out", join(tmpdir(), "xhs-explore", `${ALIAS || "xx"}-${TS}.png`)));

if (!ALIAS) {
  console.log("✗ 需要 --alias");
  process.exit(4);
}

function sshCurl(url) {
  return execFileSync("ssh", [SSH, "curl.exe", "-s", "-m", "12", url], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function scpTo(local, remote) {
  execFileSync("scp", [local, `${SSH}:${remote}`], { stdio: ["ignore", "pipe", "pipe"] });
}

function scpFrom(remote, local) {
  mkdirSync(dirname(local), { recursive: true });
  execFileSync("scp", [`${SSH}:${remote}`, local], { stdio: ["ignore", "pipe", "pipe"] });
}

function sshNode(args) {
  // ssh host node arg1 arg2... — use cmd /c for windows path safety
  return execFileSync("ssh", [SSH, "node", ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

try {
  const entry = JSON.parse(sshCurl("http://127.0.0.1:17930/api/agent-entry"));
  const dev = (entry.devices || []).find((d) => d.alias === ALIAS);
  if (!dev) {
    console.log(`✗ alias ${ALIAS} 不在 agent-entry`);
    process.exit(2);
  }
  const serial = dev.serial;
  const online = (dev.state || {}).online ?? (dev.control || {}).online;
  if (!serial) {
    console.log(`✗ ${ALIAS} 无 serial`);
    process.exit(2);
  }
  if (online === false) {
    console.log(`✗ ${ALIAS} offline`);
    process.exit(2);
  }

  // ensure helper on Windows
  const winHelper = "C:/Users/Public/xhs-registry/tmp-know/_win-screencap.mjs";
  const localHelper = join(__dirname, "_win-screencap.mjs");
  scpTo(localHelper, winHelper);

  const remotePng = `C:/Users/Public/xhs-agent-runs/_explore/shot-${ALIAS}-${TS}.png`;
  // forward slashes ok for node on win
  let raw;
  try {
    raw = sshNode([winHelper, "--serial", serial, "--out", remotePng]);
  } catch (e) {
    const msg = `${e.stdout || ""}${e.stderr || e.message || ""}`.slice(0, 500);
    console.log(`✗ screencap failed: ${msg}`);
    process.exit(2);
  }
  let meta;
  try {
    const a = raw.indexOf("{");
    meta = JSON.parse(raw.slice(a));
  } catch {
    console.log(`✗ bad screencap response: ${raw.slice(0, 200)}`);
    process.exit(4);
  }
  if (!meta.ok) {
    console.log(`✗ ${meta.error || "screencap not ok"}`);
    process.exit(2);
  }

  scpFrom(remotePng.replace(/\\/g, "/"), OUT);
  if (!existsSync(OUT)) {
    console.log("✗ scp 后本地文件不存在");
    process.exit(4);
  }

  console.log(`SHOT=${OUT}`);
  console.log(`SERIAL=${serial}`);
  console.log(`ALIAS=${ALIAS}`);

  if (ANALYZE) {
    const py = join(VGP, ".venv/bin/python");
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
  process.exit(4);
}
