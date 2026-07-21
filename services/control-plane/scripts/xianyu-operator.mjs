// xianyu-operator.mjs — 闲鱼独立侦察/发布页 dry-run 入口
//
// 安全边界：只启动闲鱼、读取语义树、点击“卖闲置/发闲置”进入发布页。
// 绝不点击最终“发布”，也不复用小红书业务原语。

import { pathToFileURL } from "node:url";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FastOperator, parseUiAutomatorXml } from "./fast-operator.mjs";

const IDLEFISH_PACKAGE = "com.taobao.idlefish";
const DEFAULT_ADB = "C:\\PROGRA~2\\xiaowei_android\\tools\\adb.exe";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

export function semanticLabel(node) {
  return [node?.text, node?.contentDesc]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n");
}

export function semanticSnapshot(doc) {
  return (doc?.nodes || [])
    .map((node) => ({
      label: semanticLabel(node),
      bounds: node.bounds,
      clickable: !!node.clickable,
      focused: !!node.focused,
      className: node.className,
      resourceId: node.resourceId,
    }))
    .filter((node) => node.label && node.bounds)
    .filter((node, index, all) => all.findIndex((other) => (
      other.label === node.label && JSON.stringify(other.bounds) === JSON.stringify(node.bounds)
    )) === index);
}

export function isPublishCompose(snapshot) {
  const text = snapshot.map((node) => node.label).join("\n");
  const hasDescription = /描述|宝贝描述|说说宝贝|标题/.test(text);
  const hasCommerceField = /价格|分类|成色|运费/.test(text);
  const hasFinalPublish = /(^|\n)发布($|\n)/m.test(text);
  return hasDescription && (hasCommerceField || hasFinalPublish);
}

export function findPublishEntry(snapshot) {
  // 不匹配裸“发布”，避免在编辑页误点最终发布按钮。
  const patterns = [/^卖闲置$/m, /^发闲置$/m, /^发布闲置$/m, /卖闲置/, /发闲置/];
  for (const pattern of patterns) {
    const candidates = snapshot.filter((node) => pattern.test(node.label));
    const hit = candidates.find((node) => node.clickable) || candidates[0];
    if (hit) return hit;
  }
  return null;
}

function center(bounds) {
  return [Math.trunc((bounds[0] + bounds[2]) / 2), Math.trunc((bounds[1] + bounds[3]) / 2)];
}

async function settle(ms = 1200) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function runProcess(file, args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`process timeout: ${file} ${args.slice(0, 4).join(" ")}`));
    }, timeoutMs);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`process exit ${code}: ${stderr.trim()}`));
    });
  });
}

async function xianyuDump(op, label) {
  // Windows 上 adb exec-out 管道会把 Flutter 中文先按 GBK 解码，形成 mojibake。
  // 先让设备写 XML，再 adb pull 原始字节，保证 UTF-8 语义不丢。
  const token = `${process.pid}-${Date.now()}`;
  const remote = `/sdcard/xianyu-dump-${token}.xml`;
  const local = join(tmpdir(), `xianyu-dump-${token}.xml`);
  const startedAt = Date.now();
  try {
    await op.session.exec(`uiautomator dump ${remote} >/dev/null 2>&1`, 18000);
    await runProcess(op.adbPath, ["-s", op.serial, "pull", remote, local], 15000);
    const xml = readFileSync(local, "utf8");
    const start = xml.indexOf("<hierarchy");
    const end = xml.indexOf("</hierarchy>", start);
    if (start < 0 || end < 0) throw new Error("xianyu hierarchy dump incomplete");
    const doc = parseUiAutomatorXml(xml.slice(start, end + "</hierarchy>".length));
    doc._dumpMs = Date.now() - startedAt;
    doc._label = label;
    return doc;
  } finally {
    try { unlinkSync(local); } catch {}
    try { await op.session.exec(`rm -f ${remote}`, 5000); } catch {}
  }
}

async function startIdlefish(op) {
  await op.session.exec(`am force-stop ${IDLEFISH_PACKAGE}`, 8000);
  await op.session.exec(`monkey -p ${IDLEFISH_PACKAGE} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1`, 12000);
  await settle(1800);
  return op.currentFocus();
}

async function snapshot(op, label) {
  const focus = await op.currentFocus();
  await settle(500);
  const doc = await xianyuDump(op, label);
  const nodes = semanticSnapshot(doc);
  return { focus, dumpMs: doc._dumpMs, publishCompose: isPublishCompose(nodes), nodes };
}

async function capturePng(op, path) {
  const png = await op.session.execOut(["screencap", "-p"], 15000);
  writeFileSync(path, png);
  return { path, bytes: png.length };
}

export async function inputDryRun(op, { text, evidenceDir = "C:\\Users\\Public" } = {}) {
  const value = String(text || "闲鱼发布页输入测试").trim();
  if (!value) return { ok: false, step: "empty-text" };
  const before = await snapshot(op, "xianyu-input-before");
  if (before.focus.package !== IDLEFISH_PACKAGE || !isPublishCompose(before.nodes)) {
    return { ok: false, step: "not-on-publish-compose", focus: before.focus };
  }

  // Flutter 描述框未稳定暴露语义节点；坐标仅在发布页语义门控通过后使用。
  await op.tap(540, 760);
  await settle(800);
  const { audit, restore } = await op.inputTextViaXiaowei(value, { deferRestore: true });
  await settle(600);
  const safeSerial = String(op.serial).replace(/[^A-Za-z0-9_-]/g, "_");
  const entered = await capturePng(op, `${evidenceDir}\\xianyu-input-entered-${safeSerial}.png`);

  // 清空刚输入的测试串，不保存草稿。多给 8 次 DEL 处理 emoji/组合字符边界。
  const deleteCount = [...value].length + 8;
  await op.session.exec(`input keyevent KEYCODE_MOVE_END ${Array(deleteCount).fill("KEYCODE_DEL").join(" ")}`, 10000);
  await settle(500);
  const cleared = await capturePng(op, `${evidenceDir}\\xianyu-input-cleared-${safeSerial}.png`);
  await op.session.exec("input keyevent KEYCODE_BACK", 6000);
  await settle(300);
  await restore();
  return { ok: true, stoppedBeforePublish: true, audit, evidence: { entered, cleared } };
}

export async function openPublishDryRun(op, { maxSteps = 3 } = {}) {
  const started = await startIdlefish(op);
  if (started.package !== IDLEFISH_PACKAGE) {
    return { ok: false, step: "start", started };
  }

  const trace = [];
  for (let step = 0; step <= maxSteps; step += 1) {
    const state = await snapshot(op, `xianyu-publish-${step}`);
    trace.push({
      step,
      focus: state.focus,
      dumpMs: state.dumpMs,
      labels: state.nodes.map((node) => node.label).slice(0, 80),
    });
    if (isPublishCompose(state.nodes)) {
      return { ok: true, stage: "publish-compose", stoppedBeforePublish: true, trace };
    }
    if (step === maxSteps) break;
    const entry = findPublishEntry(state.nodes);
    if (!entry) return { ok: false, step: "publish-entry", stoppedBeforePublish: true, trace };
    const [x, y] = center(entry.bounds);
    await op.tap(x, y);
    await settle();
  }
  return { ok: false, step: "publish-compose", stoppedBeforePublish: true, trace };
}

async function main() {
  const command = process.argv.find((value) => ["start", "snapshot", "open-publish", "input-dry-run"].includes(value)) || "help";
  const serial = arg("--serial");
  const adbPath = arg("--adb", process.env.ADB_PATH || DEFAULT_ADB);
  if (!serial && command !== "help") throw new Error("缺少 --serial <设备序列号>");

  if (command === "help") {
    console.log(`闲鱼 operator（只读/发布页 dry-run）

node scripts/xianyu-operator.mjs --serial <serial> start
node scripts/xianyu-operator.mjs --serial <serial> snapshot
node scripts/xianyu-operator.mjs --serial <serial> open-publish
node scripts/xianyu-operator.mjs --serial <serial> input-dry-run --text <临时文本>

open-publish 只进入发布编辑页，绝不点击最终“发布”。`);
    return;
  }

  const op = await new FastOperator({ adbPath, serial }).start();
  try {
    if (command === "start") console.log(JSON.stringify({ ok: true, focus: await startIdlefish(op) }, null, 2));
    if (command === "snapshot") console.log(JSON.stringify(await snapshot(op, "xianyu-snapshot"), null, 2));
    if (command === "open-publish") console.log(JSON.stringify(await openPublishDryRun(op), null, 2));
    if (command === "input-dry-run") console.log(JSON.stringify(await inputDryRun(op, { text: arg("--text") }), null, 2));
  } finally {
    await op.close();
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entry === import.meta.url) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  });
}
