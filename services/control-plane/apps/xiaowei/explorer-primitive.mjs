import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { ControlPlaneError } from "../../control-plane/lib/errors.mjs";

const BRIDGE_IME = "com.android.xwkeyboard/.XwIME";
const MAX_COORD = 4096;
const PACKAGE_RE = /^[a-zA-Z0-9._]+$/;
const ACTIVITY_RE = /^[A-Za-z0-9_$./]+$/;

const PRIMITIVES = new Set([
  "screen",
  "dump_ui",
  "focus",
  "tap",
  "swipe",
  "back",
  "launch_app",
  "input_text",
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertCanary(job) {
  if (!job?.canary) {
    throw new ControlPlaneError("CANARY_REQUIRED", "Explorer primitive requires canary session", { status: 403 });
  }
}

function assertLeaseDevice(leaseAuthorization, device) {
  if (!leaseAuthorization?.leaseId || !leaseAuthorization?.token || !leaseAuthorization?.deviceId) {
    throw new ControlPlaneError("LEASE_AUTHORIZATION_REQUIRED", "Explorer primitive requires active session lease", { status: 403 });
  }
  if (leaseAuthorization.deviceId !== device.deviceId) {
    throw new ControlPlaneError("LEASE_DEVICE_MISMATCH", "session lease does not match target device", {
      status: 409,
      details: { expectedDeviceId: leaseAuthorization.deviceId, actualDeviceId: device.deviceId },
    });
  }
}

function requireInteger(value, path, { min = 0, max = MAX_COORD } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ControlPlaneError("PARAMS_SCHEMA_INVALID", `${path} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function validateExplorerPrimitiveParams(params) {
  if (!PRIMITIVES.has(params?.primitive)) {
    throw new ControlPlaneError("PARAMS_SCHEMA_INVALID", "params.primitive is not an allowed Explorer primitive");
  }
  switch (params.primitive) {
    case "tap":
      requireInteger(params.x, "params.x");
      requireInteger(params.y, "params.y");
      break;
    case "swipe":
      requireInteger(params.x1, "params.x1");
      requireInteger(params.y1, "params.y1");
      requireInteger(params.x2, "params.x2");
      requireInteger(params.y2, "params.y2");
      if (params.durationMs !== undefined) requireInteger(params.durationMs, "params.durationMs", { min: 50, max: 5000 });
      break;
    case "back":
      if (params.times !== undefined) requireInteger(params.times, "params.times", { min: 1, max: 5 });
      break;
    case "launch_app": {
      const pkg = String(params.package || "");
      if (!PACKAGE_RE.test(pkg)) throw new ControlPlaneError("PARAMS_SCHEMA_INVALID", "params.package is invalid");
      if (params.activity !== undefined && !ACTIVITY_RE.test(String(params.activity))) {
        throw new ControlPlaneError("PARAMS_SCHEMA_INVALID", "params.activity is invalid");
      }
      break;
    }
    case "input_text": {
      const text = String(params.text ?? "");
      if (!text.trim()) throw new ControlPlaneError("PARAMS_SCHEMA_INVALID", "params.text is required");
      if (text.length > 500) throw new ControlPlaneError("PARAMS_SCHEMA_INVALID", "params.text exceeds 500 characters");
      if (params.refocusX !== undefined) requireInteger(params.refocusX, "params.refocusX");
      if (params.refocusY !== undefined) requireInteger(params.refocusY, "params.refocusY");
      break;
    }
    default:
      break;
  }
  return params;
}

function parseFocus(raw) {
  const s = String(raw || "");
  const m = s.match(/([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)\/(\S+)/);
  if (m) return { package: m[1], activity: m[2].replace(/[\}\s].*$/, ""), raw: s.slice(0, 300) };
  const m2 = s.match(/mCurrentFocus=([^\n]+)/);
  return { package: null, activity: null, raw: (m2 ? m2[1] : s).slice(0, 300) };
}

function redactExplorerOutput(params, output) {
  const safe = { ...output };
  delete safe.token;
  delete safe.sessionToken;
  if (params?.primitive === "input_text") {
    delete safe.text;
    if (typeof safe.textPreview === "string") safe.textPreview = safe.textPreview.slice(0, 40);
  }
  return safe;
}

async function adbShell(transport, serial, command, timeoutMs = 20000) {
  const response = await transport.invoke({
    action: "adb_shell",
    devices: serial,
    data: { command: String(command) },
  }, { timeoutMs });
  const data = response?.data;
  if (data == null) return "";
  if (typeof data === "string") return data;
  if (typeof data === "object") {
    if (data[serial] != null) return String(data[serial]);
    const vals = Object.values(data);
    if (vals.length === 1) return String(vals[0] ?? "");
  }
  return String(data);
}

async function doScreen(transport, serial, evidenceDirectory) {
  mkdirSync(evidenceDirectory, { recursive: true });
  const saveDir = join(evidenceDirectory, `_screen_${randomUUID()}`);
  mkdirSync(saveDir, { recursive: true });
  const before = new Set(readdirSync(saveDir).filter((f) => /\.png$/i.test(f)));
  const response = await transport.invoke({
    action: "Screen",
    devices: serial,
    data: { savePath: saveDir },
  }, { timeoutMs: 30000 });
  let found = null;
  for (let i = 0; i < 25; i += 1) {
    const next = readdirSync(saveDir).filter((f) => /\.png$/i.test(f) && !before.has(f));
    if (next.length > 0) {
      found = join(saveDir, next.sort().at(-1));
      break;
    }
    await sleep(200);
  }
  if (!found) {
    throw new ControlPlaneError("EXPLORER_SCREEN_EMPTY", "screen capture produced no png", { status: 502 });
  }
  const target = join(evidenceDirectory, "screen.png");
  renameSync(found, target);
  return {
    ok: true,
    primitive: "screen",
    path: target,
    bytes: readFileSync(target).length,
    vendorCode: response?.code ?? null,
  };
}

async function doDumpUi(transport, serial, evidenceDirectory) {
  mkdirSync(evidenceDirectory, { recursive: true });
  const out = join(evidenceDirectory, "dump-ui.xml");
  const token = randomUUID();
  const remote = `/sdcard/xhs-dump-${token}.xml`;
  await adbShell(transport, serial, `uiautomator dump ${remote}`, 25000);
  let b64 = "";
  for (let i = 0; i < 3; i += 1) {
    b64 = await adbShell(transport, serial, `base64 ${remote}`, 25000).catch(() => "");
    if (b64 && String(b64).trim()) break;
    await sleep(400);
  }
  await adbShell(transport, serial, `rm -f ${remote}`, 8000).catch(() => {});
  const cleaned = String(b64).replace(/\s+/g, "");
  if (!cleaned) throw new ControlPlaneError("EXPLORER_DUMP_EMPTY", "dump produced empty payload", { status: 502 });
  const xml = Buffer.from(cleaned, "base64").toString("utf8");
  if (!xml.includes("<hierarchy")) {
    throw new ControlPlaneError("EXPLORER_DUMP_INVALID", "dump missing hierarchy", { status: 502 });
  }
  writeFileSync(out, xml, "utf8");
  return { ok: true, primitive: "dump_ui", path: out, bytes: Buffer.byteLength(xml) };
}

async function doFocus(transport, serial) {
  const raw = await adbShell(
    transport,
    serial,
    "dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp'; dumpsys activity activities 2>/dev/null | grep -E 'mResumedActivity' | head -1",
    15000,
  );
  return { ok: true, primitive: "focus", ...parseFocus(raw) };
}

async function doTap(transport, serial, params) {
  const x = requireInteger(params.x, "params.x");
  const y = requireInteger(params.y, "params.y");
  await adbShell(transport, serial, `input tap ${x} ${y}`, 10000);
  return { ok: true, primitive: "tap", x, y };
}

async function doSwipe(transport, serial, params) {
  const x1 = requireInteger(params.x1, "params.x1");
  const y1 = requireInteger(params.y1, "params.y1");
  const x2 = requireInteger(params.x2, "params.x2");
  const y2 = requireInteger(params.y2, "params.y2");
  const durationMs = params.durationMs === undefined ? 350 : requireInteger(params.durationMs, "params.durationMs", { min: 50, max: 5000 });
  await adbShell(transport, serial, `input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`, 12000);
  return { ok: true, primitive: "swipe", x1, y1, x2, y2, durationMs };
}

async function doBack(transport, serial, params) {
  const times = params.times === undefined ? 1 : requireInteger(params.times, "params.times", { min: 1, max: 5 });
  for (let i = 0; i < times; i += 1) {
    await adbShell(transport, serial, "input keyevent 4", 10000);
  }
  return { ok: true, primitive: "back", times };
}

async function doLaunchApp(transport, serial, params) {
  const pkg = String(params.package);
  const activity = params.activity ? String(params.activity) : null;
  if (params.forceStop) {
    await adbShell(transport, serial, `am force-stop ${pkg}`, 12000);
    await sleep(500);
  }
  let cmd;
  if (activity) {
    const comp = activity.includes("/") ? activity : `${pkg}/${activity}`;
    cmd = `am start -W -n ${comp}`;
  } else {
    cmd = `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`;
  }
  const stdout = await adbShell(transport, serial, cmd, 20000);
  await sleep(800);
  const raw = await adbShell(
    transport,
    serial,
    "dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' | head -3",
    12000,
  ).catch(() => "");
  return { ok: true, primitive: "launch_app", package: pkg, stdout: String(stdout).slice(0, 2000), focus: parseFocus(raw) };
}

async function doInputText(transport, serial, params) {
  const text = String(params.text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[\r\n]+/g, " ")
    .replace(/[ \t\u00a0]+/g, " ")
    .trim();
  const hasRefocus = params.refocusX !== undefined && params.refocusY !== undefined;
  const audit = {
    priorIme: null,
    bridgeIme: BRIDGE_IME,
    selected: false,
    refocused: false,
    cleared: false,
    inputAccepted: false,
    enter: false,
    restored: false,
  };

  const priorImeRaw = await adbShell(transport, serial, "settings get secure default_input_method", 8000).catch(() => "");
  const priorIme = String(priorImeRaw || "").trim();
  audit.priorIme = priorIme === "null" ? null : priorIme;

  const restoreIme = async () => {
    if (!priorIme || priorIme === BRIDGE_IME) {
      audit.restored = true;
      return;
    }
    try {
      const cur = String(await adbShell(transport, serial, "settings get secure default_input_method", 8000)).trim();
      if (cur !== priorIme) {
        const response = await transport.invoke({ action: "selectIme", devices: serial, data: { ime: priorIme } }, { timeoutMs: 12000 });
        if (response?.code !== 10000) throw new Error(`restore selectIme code=${response?.code}`);
      }
      audit.restored = true;
    } catch (error) {
      audit.restoreError = String(error.message || error).slice(0, 200);
    }
  };

  try {
    let cur = String(await adbShell(transport, serial, "settings get secure default_input_method", 8000)).trim();
    if (cur !== BRIDGE_IME) {
      const response = await transport.invoke({ action: "selectIme", devices: serial, data: { ime: BRIDGE_IME } }, { timeoutMs: 12000 });
      if (response?.code !== 10000) {
        throw new ControlPlaneError("EXPLORER_IME_FAILED", "bridge IME selection failed", { status: 502 });
      }
      for (let i = 0; i < 8; i += 1) {
        await sleep(200);
        cur = String(await adbShell(transport, serial, "settings get secure default_input_method", 8000)).trim();
        if (cur === BRIDGE_IME) break;
      }
      if (cur !== BRIDGE_IME) {
        throw new ControlPlaneError("EXPLORER_IME_FAILED", "bridge IME not active after selectIme", { status: 502 });
      }
    }
    audit.selected = true;
    await sleep(400);

    if (hasRefocus) {
      const rx = requireInteger(params.refocusX, "params.refocusX");
      const ry = requireInteger(params.refocusY, "params.refocusY");
      await adbShell(transport, serial, `input tap ${rx} ${ry}`, 10000);
      await sleep(600);
      audit.refocused = true;
    }

    if (params.clearFirst) {
      await adbShell(
        transport,
        serial,
        "input keyevent KEYCODE_MOVE_END " + Array(48).fill("KEYCODE_DEL").join(" "),
        8000,
      );
      await sleep(150);
      audit.cleared = true;
    }

    const inputResponse = await transport.invoke(
      { action: "inputText", devices: serial, data: { content: text } },
      { timeoutMs: 15000 },
    );
    if (inputResponse?.code !== 10000) {
      throw new ControlPlaneError("EXPLORER_INPUT_FAILED", "inputText rejected by vendor", { status: 502 });
    }
    audit.inputAccepted = true;

    if (params.enter) {
      await sleep(200);
      await adbShell(transport, serial, "input keyevent KEYCODE_ENTER", 8000);
      audit.enter = true;
    }
  } catch (error) {
    await restoreIme();
    throw error;
  }

  if (!params.deferRestore) await restoreIme();
  else audit.restored = false;

  return {
    ok: true,
    primitive: "input_text",
    audit,
    textLen: text.length,
    textPreview: text.slice(0, 40),
  };
}

export async function executeExplorerPrimitive({
  transport,
  device,
  params,
  evidenceDirectory,
  leaseAuthorization,
  job,
}) {
  assertCanary(job);
  assertLeaseDevice(leaseAuthorization, device);
  validateExplorerPrimitiveParams(params);
  const serial = device.runtimeId;
  if (!serial) {
    throw new ControlPlaneError("DEVICE_RUNTIME_MISSING", "device runtime serial is required", { status: 409 });
  }

  let result;
  switch (params.primitive) {
    case "screen":
      result = await doScreen(transport, serial, evidenceDirectory);
      break;
    case "dump_ui":
      result = await doDumpUi(transport, serial, evidenceDirectory);
      break;
    case "focus":
      result = await doFocus(transport, serial);
      break;
    case "tap":
      result = await doTap(transport, serial, params);
      break;
    case "swipe":
      result = await doSwipe(transport, serial, params);
      break;
    case "back":
      result = await doBack(transport, serial, params);
      break;
    case "launch_app":
      result = await doLaunchApp(transport, serial, params);
      break;
    case "input_text":
      result = await doInputText(transport, serial, params);
      break;
    default:
      throw new ControlPlaneError("EXPLORER_PRIMITIVE_UNSUPPORTED", `unsupported primitive ${params.primitive}`, { status: 400 });
  }
  return {
    vendorCode: result.vendorCode ?? 10000,
    output: redactExplorerOutput(params, result),
  };
}
