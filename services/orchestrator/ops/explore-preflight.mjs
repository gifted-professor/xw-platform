#!/usr/bin/env node
// Explorer 开工检查：不通则非 0，禁止开干。
//
//   node ops/explore-preflight.mjs --alias 01
//   node ops/explore-preflight.mjs --alias 01 --require-17910
//
// exit: 0 可开工 | 2 舰队/设备不行 | 4 客户端/SSH

import { execFileSync } from "node:child_process";
// execFileSync used for netstat probe too

const argv = process.argv.slice(2);
const opt = (n, fb = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : fb;
};
const flag = (n) => argv.includes(n);

if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/explore-preflight.mjs --alias <01-04> [--ssh xhs-windows] [--require-17910]

检查顺序:
  1) registry 17930 /control health 17920
  2) agent-entry: 目标 ready + 未隔离 + lease free
  3) control devices online
  4) 小薇 22222 端口 LISTEN（交互 ops 依赖它，不通=失败）
  5) 可选 17910 device/v1/devices（--require-17910 时不通=失败；默认只警告）

exit: 0 ok | 2 fleet/device | 4 client/ssh`);
  process.exit(0);
}

const ALIAS = opt("--alias");
const SSH = opt("--ssh", "xhs-windows");
const REQUIRE_17910 = flag("--require-17910");

if (!ALIAS) {
  console.log("✗ 需要 --alias 01|02|03|04");
  process.exit(4);
}

function sshCurl(url) {
  try {
    return execFileSync(
      "ssh",
      [SSH, "curl.exe", "-s", "-m", "12", url],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    const msg = `${e.stderr || e.stdout || e.message || ""}`.slice(0, 300);
    throw new Error(`curl ${url} failed: ${msg}`);
  }
}

function suggestUiAccess(alias) {
  // 启发，非穷尽
  return "dump-first（未知 App 先 dump；Flutter→semantic；dump 空→vision 限次）";
}

const log = (m) => console.log(m);
const problems = [];

try {
  log(`[preflight] alias=${ALIAS} ssh=${SSH}`);

  // 1) health
  let h30, h20;
  try {
    h30 = JSON.parse(sshCurl("http://127.0.0.1:17930/api/health"));
  } catch (e) {
    console.log(`✗ registry 17930: ${e.message}`);
    process.exit(4);
  }
  try {
    h20 = JSON.parse(sshCurl("http://127.0.0.1:17920/control/v1/health"));
  } catch (e) {
    console.log(`✗ control 17920: ${e.message}`);
    process.exit(4);
  }
  if (h30.ok !== true) problems.push("registry health.ok!=true");
  if (h20.ok !== true) problems.push("control health.ok!=true");
  log(`  17930 ok=${h30.ok}  17920 ok=${h20.ok} devices=${h20.devices} leases=${h20.activeLeases}`);

  // 2) agent-entry
  let entry;
  try {
    entry = JSON.parse(sshCurl("http://127.0.0.1:17930/api/agent-entry"));
  } catch (e) {
    console.log(`✗ agent-entry: ${e.message}`);
    process.exit(4);
  }
  const dev = (entry.devices || []).find((d) => d.alias === ALIAS);
  if (!dev) {
    console.log(`✗ alias ${ALIAS} 不在 agent-entry.devices`);
    process.exit(2);
  }
  const state = dev.state || {};
  const control = dev.control || {};
  const deviceId = control.deviceId || dev.deviceId;
  const serial = dev.serial || null;
  const ready = state.ready;
  const quarantined = state.quarantined ?? control.quarantined;
  const leaseFree = state.leaseFree ?? (control.lease == null);
  const online = state.online ?? control.online;

  log(`  ${ALIAS} deviceId=${deviceId}`);
  log(`  serial=${serial} online=${online} ready=${ready} quarantined=${quarantined} leaseFree=${leaseFree}`);
  log(`  ui_access_hint=${suggestUiAccess(ALIAS)}`);

  if (online !== true) problems.push(`${ALIAS}: online!=true`);
  if (ready !== true) problems.push(`${ALIAS}: ready!=true（先恢复/清隔离/刷 success）`);
  if (quarantined === true) problems.push(`${ALIAS}: quarantined`);
  if (leaseFree === false) problems.push(`${ALIAS}: lease 占用中`);
  if (!deviceId) problems.push(`${ALIAS}: 无 deviceId`);

  // 3) control devices
  try {
    const cd = JSON.parse(sshCurl("http://127.0.0.1:17920/control/v1/devices"));
    const list = cd.devices || [];
    const hit = list.find((d) => d.alias === ALIAS || d.deviceId === deviceId);
    if (!hit) problems.push(`${ALIAS}: 不在 control/v1/devices`);
    else if (hit.online !== true) problems.push(`${ALIAS}: control.online!=true`);
    else log(`  control.devices: online=${hit.online} quarantined=${hit.quarantined}`);
  } catch (e) {
    problems.push(`control devices: ${e.message}`);
  }

  // 4) Xiaowei 22222（tap/dump/screenshot 真通道）
  try {
    const listen = execFileSync(
      "ssh",
      [SSH, "cmd", "/c", "netstat -ano | findstr 22222"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (!/LISTENING/i.test(listen) && !/22222/.test(listen)) {
      problems.push("xiaowei 22222 未检测到 LISTEN（交互 ops 不可用）");
    } else {
      log("  22222: detected");
    }
  } catch (e) {
    problems.push(`xiaowei 22222 探测失败: ${String(e.message || e).slice(0, 120)}`);
  }

  // 5) 17910 optional
  try {
    const xw = JSON.parse(sshCurl("http://127.0.0.1:17910/device/v1/devices"));
    const aliases = (xw.devices || []).map((d) => d.alias);
    log(`  17910 devices: [${aliases.join(",")}]（可选旁证，非交互依赖）`);
    if (REQUIRE_17910) {
      if (xw.ok !== true) problems.push("17910 ok!=true");
      if (!aliases.includes(ALIAS)) problems.push(`${ALIAS}: 不在 17910 device list`);
    } else if (!aliases.includes(ALIAS)) {
      log(`  ⚠ ${ALIAS} 不在 17910 列表（未 --require-17910，仅警告）`);
    }
  } catch (e) {
    if (REQUIRE_17910) problems.push(`17910 不可达: ${e.message}`);
    else log(`  ⚠ 17910 探测失败（未强制）: ${e.message.slice(0, 120)}`);
  }

  if (problems.length) {
    console.log("✗ preflight 失败:");
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(2);
  }

  // machine-readable footer
  console.log(`DEVICE_ID=${deviceId}`);
  console.log(`SERIAL=${serial || ""}`);
  console.log("✓ preflight ok — 可开工");
  process.exit(0);
} catch (e) {
  console.log(`✗ ${e.message}`);
  process.exit(4);
}
