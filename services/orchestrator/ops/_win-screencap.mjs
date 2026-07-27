// 跑在 Windows：优先小薇 WS Screen（22222），回落 adb。
// node _win-screencap.mjs --serial <runtimeId> --out <winPath.png>
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readdirSync, renameSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : null;
};
const serial = opt("--serial");
const out = opt("--out");
if (!serial || !out) {
  console.log(JSON.stringify({ ok: false, error: "need --serial and --out" }));
  process.exit(2);
}

mkdirSync(dirname(out), { recursive: true });

async function viaXiaowei() {
  const dir = join(dirname(out), `_gwshot_${String(serial).replace(/[^A-Za-z0-9_-]/g, "_")}`);
  mkdirSync(dir, { recursive: true });
  const before = new Set(readdirSync(dir).filter((f) => /\.png$/i.test(f)));
  const WS = globalThis.WebSocket;
  if (typeof WS !== "function") throw new Error("WebSocket unavailable");

  const result = await new Promise((resolve, reject) => {
    const ws = new WS("ws://127.0.0.1:22222/");
    const t = setTimeout(() => reject(new Error("xiaowei timeout")), 25000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ action: "Screen", devices: serial, data: { savePath: dir } }));
    });
    ws.addEventListener("message", (ev) => {
      clearTimeout(t);
      try {
        resolve(JSON.parse(String(ev.data)));
      } catch (e) {
        reject(e);
      }
      try {
        ws.close();
      } catch { /* */ }
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(t);
      reject(e.error || e);
    });
  });

  if (result.code !== 10000) {
    throw new Error(`Screen code=${result.code} ${result.message || JSON.stringify(result).slice(0, 200)}`);
  }

  let found = null;
  for (let i = 0; i < 25; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    const after = readdirSync(dir).filter((f) => /\.png$/i.test(f) && !before.has(f));
    if (after.length) {
      const pref = after.filter((f) => f.includes(String(serial)));
      found = (pref.length ? pref : after).sort().slice(-1)[0];
      break;
    }
  }
  if (!found) throw new Error("Screen: no new png");
  const src = join(dir, found);
  try {
    renameSync(src, out);
  } catch {
    copyFileSync(src, out);
  }
  return { method: "xiaowei-Screen", src: found };
}

function viaAdb() {
  const ADB_CANDIDATES = [
    process.env.ADB_PATH,
    "D:\\download\\lvjian\\tools\\adb.exe",
    "C:\\platform-tools\\adb.exe",
    "adb",
  ].filter(Boolean);
  let adb = null;
  for (const c of ADB_CANDIDATES) {
    try {
      if (c === "adb") {
        execFileSync("where", ["adb"], { stdio: "ignore" });
        adb = "adb";
        break;
      }
      if (existsSync(c)) {
        adb = c;
        break;
      }
    } catch { /* */ }
  }
  if (!adb) throw new Error("adb not found");
  const remote = "/sdcard/xhs_explore_tmp.png";
  execFileSync(adb, ["-s", serial, "shell", "screencap", "-p", remote], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20000,
  });
  execFileSync(adb, ["-s", serial, "pull", remote, out], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  });
  if (!existsSync(out)) throw new Error("adb pull missing file");
  return { method: "adb", adb };
}

try {
  let meta;
  try {
    meta = await viaXiaowei();
  } catch (e1) {
    try {
      meta = viaAdb();
      meta.fallbackFrom = String(e1.message || e1).slice(0, 160);
    } catch (e2) {
      console.log(JSON.stringify({
        ok: false,
        error: `xiaowei: ${String(e1.message || e1).slice(0, 120)}; adb: ${String(e2.message || e2).slice(0, 120)}`,
      }));
      process.exit(5);
    }
  }
  console.log(JSON.stringify({ ok: true, path: out, serial, ...meta }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 400) }));
  process.exit(5);
}
