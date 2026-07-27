// Windows helper: Xiaowei ws://127.0.0.1:22222 原子动作
// node _win-xiaowei.mjs --serial <id> --action tap|shell|dump|focus|start [--x --y --cmd --out --package --activity --force-stop]
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
const opt = (n, fb = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : fb;
};
const flag = (n) => argv.includes(n);

const serial = opt("--serial");
const action = opt("--action");
if (!serial || !action) {
  console.log(JSON.stringify({ ok: false, error: "need --serial and --action" }));
  process.exit(2);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function xwInvoke(payload, timeoutMs = 25000) {
  const WS = globalThis.WebSocket;
  if (typeof WS !== "function") throw new Error("WebSocket unavailable");
  return new Promise((resolve, reject) => {
    const ws = new WS("ws://127.0.0.1:22222/");
    const t = setTimeout(() => {
      try { ws.close(); } catch { /* */ }
      reject(new Error(`xiaowei timeout ${timeoutMs}ms action=${payload.action}`));
    }, timeoutMs);
    ws.addEventListener("open", () => {
      try {
        ws.send(JSON.stringify(payload));
      } catch (e) {
        clearTimeout(t);
        reject(e);
      }
    });
    ws.addEventListener("message", (ev) => {
      clearTimeout(t);
      try {
        resolve(JSON.parse(String(ev.data)));
      } catch (e) {
        reject(e);
      }
      try { ws.close(); } catch { /* */ }
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(t);
      reject(e.error || e);
    });
  });
}

async function adbShell(command, timeoutMs = 20000) {
  const r = await xwInvoke({ action: "adb_shell", devices: serial, data: { command: String(command) } }, timeoutMs);
  if (r.code !== 10000) {
    throw new Error(`adb_shell failed code=${r.code} ${r.message || JSON.stringify(r).slice(0, 200)}`);
  }
  // data may be map serial -> stdout or raw string
  const data = r.data;
  if (data == null) return "";
  if (typeof data === "string") return data;
  if (typeof data === "object") {
    if (data[serial] != null) return String(data[serial]);
    const vals = Object.values(data);
    if (vals.length === 1) return String(vals[0] ?? "");
  }
  return String(data);
}

function parseFocus(raw) {
  const s = String(raw || "");
  // mCurrentFocus=Window{... u0 package/activity}
  const m = s.match(/([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)\/(\S+)/);
  if (m) return { package: m[1], activity: m[2].replace(/[\}\s].*$/, ""), raw: s.slice(0, 300) };
  const m2 = s.match(/mCurrentFocus=([^\n]+)/);
  return { package: null, activity: null, raw: (m2 ? m2[1] : s).slice(0, 300) };
}

try {
  let result = { ok: true, action, serial };

  if (action === "shell") {
    const cmd = opt("--cmd");
    if (!cmd) throw new Error("shell needs --cmd");
    const stdout = await adbShell(cmd);
    result.stdout = stdout.slice(0, 50000);
  } else if (action === "tap") {
    const x = Math.round(Number(opt("--x")));
    const y = Math.round(Number(opt("--y")));
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("tap needs numeric --x --y");
    await adbShell(`input tap ${x} ${y}`, 10000);
    result.x = x;
    result.y = y;
  } else if (action === "focus") {
    const raw = await adbShell(
      "dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp'; dumpsys activity activities 2>/dev/null | grep -E 'mResumedActivity' | head -1",
      15000,
    );
    const parsed = parseFocus(raw);
    result = { ...result, ...parsed };
  } else if (action === "dump") {
    const out = opt("--out");
    if (!out) throw new Error("dump needs --out win path");
    mkdirSync(dirname(out), { recursive: true });
    const token = `${process.pid}-${Date.now()}`;
    const remote = `/sdcard/xhs-dump-${token}.xml`;
    await adbShell(`uiautomator dump ${remote}`, 25000);
    let b64 = "";
    for (let i = 0; i < 3; i += 1) {
      b64 = await adbShell(`base64 ${remote}`, 25000).catch(() => "");
      if (b64 && String(b64).trim()) break;
      await sleep(400);
    }
    await adbShell(`rm -f ${remote}`, 8000).catch(() => "");
    const cleaned = String(b64).replace(/\s+/g, "");
    if (!cleaned) throw new Error("dump empty base64");
    const xml = Buffer.from(cleaned, "base64").toString("utf8");
    if (!xml.includes("<hierarchy")) throw new Error("dump missing hierarchy");
    writeFileSync(out, xml, "utf8");
    result.path = out;
    result.bytes = Buffer.byteLength(xml);
  } else if (action === "start") {
    const pkg = opt("--package");
    if (!pkg || !/^[a-zA-Z0-9._]+$/.test(pkg)) throw new Error("start needs safe --package");
    const activity = opt("--activity");
    if (activity && !/^[A-Za-z0-9_$.\/]+$/.test(activity)) throw new Error("unsafe --activity");
    if (flag("--force-stop")) {
      await adbShell(`am force-stop ${pkg}`, 12000);
      await sleep(500);
    }
    let cmd;
    if (activity) {
      const comp = activity.includes("/") ? activity : `${pkg}/${activity}`;
      cmd = `am start -W -n ${comp}`;
    } else {
      cmd = `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`;
    }
    const stdout = await adbShell(cmd, 20000);
    await sleep(800);
    const raw = await adbShell(
      "dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' | head -3",
      12000,
    ).catch(() => "");
    result.stdout = String(stdout).slice(0, 2000);
    result.focus = parseFocus(raw);
  } else {
    throw new Error(`unknown action ${action}`);
  }

  console.log(JSON.stringify(result));
} catch (e) {
  console.log(JSON.stringify({ ok: false, action, serial, error: String(e.message || e).slice(0, 500) }));
  process.exit(5);
}
