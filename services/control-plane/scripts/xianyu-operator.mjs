// xianyu-operator.mjs — 闲鱼独立侦察/发布页 dry-run 入口
//
// 安全边界：只启动闲鱼、读取语义树、点击“卖闲置/发闲置”进入发布页。
// 绝不点击最终“发布”，也不复用小红书业务原语。

import { pathToFileURL } from "node:url";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FastOperator } from "./fast-operator.mjs";

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
  if (hasDescription && (hasCommerceField || hasFinalPublish)) return true;

  // Windows 管道偶发把 UTF-8 content-desc 显示成 GBK mojibake；用真实页布局做二次门控。
  // 三个区域必须同时存在，且调用方还会校验前台包名，避免单坐标误判。
  const topRightButton = snapshot.some((node) => node.className === "android.widget.Button"
    && node.bounds?.[0] >= 850 && node.bounds?.[1] < 220);
  const mediaButton = snapshot.some((node) => node.className === "android.widget.Button"
    && node.bounds?.[0] < 150 && node.bounds?.[1] >= 200 && node.bounds?.[3] <= 700);
  const lowerFormRow = snapshot.some((node) => node.bounds?.[0] < 100 && node.bounds?.[1] >= 1300
    && node.bounds?.[2] > 900 && node.bounds?.[3] <= 2050);
  return topRightButton && mediaButton && lowerFormRow;
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

export function findDescriptionField(snapshot) {
  return snapshot.find((node) => /描述|品牌型号|货品来源/.test(node.label))
    || snapshot.find((node) => node.clickable && node.className === "android.view.View"
      && node.bounds?.[0] < 100 && node.bounds?.[1] >= 500 && node.bounds?.[3] <= 1200
      && node.bounds?.[2] > 900)
    || null;
}

export function descriptionContains(node, value) {
  const expected = String(value || "").replace(/\s+/g, "");
  const actual = String(node?.label || semanticLabel(node)).replace(/\s+/g, "");
  return !!expected && actual.includes(expected);
}

export function isEmptyDescriptionField(node) {
  const label = String(node?.label || semanticLabel(node));
  return /描述.*宝贝.*品牌型号.*货品来源|描述.*品牌型号.*货品来源/s.test(label);
}

export function findDiscardWithoutSaving(snapshot) {
  // xianyuDump 会先 pull 原始 UTF-8 XML，所以这里只接受语义层的精确文字。
  // Windows 控制台如何显示不参与决策；识别不到就 fail-closed，绝不按坐标猜。
  return snapshot.find((node) => /^不保存$/m.test(node.label)
    && node.className === "android.widget.Button"
    && node.bounds?.[0] < 100 && node.bounds?.[1] >= 2050 && node.bounds?.[2] < 550) || null;
}

function findPublishMenuEntryByLayout(snapshot) {
  // 仅在已经点过首页中央“卖闲置”后的第 1 步使用。
  return snapshot.find((node) => node.clickable && node.className === "android.widget.ImageView"
    && node.bounds?.[0] === 0 && node.bounds?.[2] >= 1000
    && node.bounds?.[1] >= 900 && node.bounds?.[1] <= 1350
    && node.bounds?.[3] - node.bounds?.[1] >= 150) || null;
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

function parseBounds(value) {
  const match = String(value || "").match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
  return match ? match.slice(1).map(Number) : null;
}

function decodeAttr(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export function parseAllUiNodes(xml) {
  const nodes = [];
  const nodeRe = /<node\b([^>]*?)\/?\s*>/g;
  const attrRe = /(\b[a-zA-Z:_][a-zA-Z0-9:_-]*)\s*=\s*"([^"]*)"/g;
  let nodeMatch;
  while ((nodeMatch = nodeRe.exec(xml)) !== null) {
    const attrs = {};
    let attrMatch;
    attrRe.lastIndex = 0;
    while ((attrMatch = attrRe.exec(nodeMatch[1])) !== null) attrs[attrMatch[1]] = attrMatch[2];
    nodes.push({
      text: decodeAttr(attrs.text), contentDesc: decodeAttr(attrs["content-desc"]),
      className: attrs.class || "", resourceId: attrs["resource-id"] || "",
      bounds: parseBounds(attrs.bounds), clickable: attrs.clickable === "true",
      focused: attrs.focused === "true", focusable: attrs.focusable === "true",
      scrollable: attrs.scrollable === "true", enabled: attrs.enabled !== "false",
    });
  }
  return { nodes };
}

async function xianyuDump(op, label) {
  // Windows 上 adb exec-out 管道会把 Flutter 中文先按 GBK 解码，形成 mojibake。
  // 先让设备写 XML，再 adb pull 原始字节，保证 UTF-8 语义不丢。
  const token = `${process.pid}-${Date.now()}`;
  const remote = `/sdcard/xianyu-dump-${token}.xml`;
  const local = join(tmpdir(), `xianyu-dump-${token}.xml`);
  const startedAt = Date.now();
  try {
    // 不走持久 adb shell：该 PTY 会让 uiautomator 把 Flutter 中文写成 GBK 错码。
    await runProcess(op.adbPath, ["-s", op.serial, "shell", "uiautomator", "dump", remote], 20000);
    await runProcess(op.adbPath, ["-s", op.serial, "pull", remote, local], 15000);
    const xml = readFileSync(local, "utf8");
    const start = xml.indexOf("<hierarchy");
    const end = xml.indexOf("</hierarchy>", start);
    if (start < 0 || end < 0) throw new Error("xianyu hierarchy dump incomplete");
    const doc = parseAllUiNodes(xml.slice(start, end + "</hierarchy>".length));
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
  return { path, bytes: png.length, sha256: createHash("sha256").update(png).digest("hex") };
}

export async function inputDryRun(op, {
  text,
  evidenceDir = "C:\\Users\\Public",
  clearAfter = true,
} = {}) {
  const value = String(text || "闲鱼发布页输入测试").trim();
  if (!value) return { ok: false, step: "empty-text" };
  const before = await snapshot(op, "xianyu-input-before");
  if (before.focus.package !== IDLEFISH_PACKAGE || !isPublishCompose(before.nodes)) {
    return { ok: false, step: "not-on-publish-compose", focus: before.focus };
  }

  const description = findDescriptionField(before.nodes);
  if (!description?.bounds) return { ok: false, step: "description-field" };
  if (!isEmptyDescriptionField(description)) {
    return { ok: false, step: "description-not-empty", stoppedBeforePublish: true };
  }
  // 点击占位文字行，而不是大文本区的空白中心。
  const fieldX = Math.min(description.bounds[2] - 40, description.bounds[0] + 230);
  const fieldY = Math.min(description.bounds[3] - 40, description.bounds[1] + 75);
  await op.tap(fieldX, fieldY);
  await settle(800);
  const focusProbe = await op.session.oneShotShell("dumpsys input_method | grep -E 'mInputShown=true|InputConnectionAdaptor'", 8000);
  const flutterInputActive = /mInputShown=true/.test(focusProbe) && /InputConnectionAdaptor/.test(focusProbe);
  if (!flutterInputActive) return { ok: false, step: "flutter-input-focus" };

  const safeSerial = String(op.serial).replace(/[^A-Za-z0-9_-]/g, "_");
  const baseline = await capturePng(op, `${evidenceDir}\\xianyu-input-baseline-${safeSerial}.png`);
  const priorIme = await op.currentIme();
  const bridgeIme = op.xwBridgeIme || "com.android.xwkeyboard/.XwIME";
  const inputAudit = { selected: false, rebound: false, inputAccepted: false };
  let entered = null;
  let cleared = null;
  let textVerified = false;
  let clearedVerified = false;
  let inputError = null;
  try {
    // Flutter 在运行中切换 IME 后不会总是自动把旧焦点重绑给新输入法。
    // 因此必须先切效卫桥 IME，再重新点一次同一描述框，最后才发 inputText。
    if ((await op.currentIme()) !== bridgeIme && !(await op.setIme(bridgeIme))) {
      throw new Error("bridge IME select failed");
    }
    inputAudit.selected = (await op.currentIme()) === bridgeIme;
    await settle(400);
    await op.tap(fieldX, fieldY);
    await settle(500);
    const reboundProbe = await op.session.oneShotShell(
      "dumpsys input_method | grep -E 'mInputShown=true|InputConnectionAdaptor'",
      8000,
    );
    inputAudit.rebound = /InputConnectionAdaptor/.test(reboundProbe);
    if (!inputAudit.rebound) throw new Error("Flutter InputConnection did not rebind after IME switch");
    const inputResponse = await op.xiaoweiInvoke("inputText", { content: value });
    if (inputResponse.code !== 10000) {
      throw new Error(`inputText failed: ${inputResponse.message || JSON.stringify(inputResponse)}`);
    }
    inputAudit.inputAccepted = true;
    await settle(700);
    entered = await capturePng(op, `${evidenceDir}\\xianyu-input-entered-${safeSerial}.png`);
    const afterInput = await snapshot(op, "xianyu-input-after-xiaowei");
    // 写入后占位提示会消失，所以不能再用“描述/品牌型号”反查字段；
    // 直接在当前发布页的全部语义节点中查找完整测试串。
    const enteredTextNode = afterInput.nodes.find((node) => descriptionContains(node, value));
    textVerified = !!enteredTextNode;
    inputAudit.verifiedNode = enteredTextNode ? {
      className: enteredTextNode.className,
      bounds: enteredTextNode.bounds,
      label: enteredTextNode.label,
    } : null;

    if (clearAfter) {
      // 只清理本次从空白新建页写入的临时串；多给 8 次 DEL 处理组合字符边界。
      const deleteCount = [...value].length + 8;
      await op.session.exec(`input keyevent KEYCODE_MOVE_END ${Array(deleteCount).fill("KEYCODE_DEL").join(" ")}`, 10000);
      await settle(500);
      cleared = await capturePng(op, `${evidenceDir}\\xianyu-input-cleared-${safeSerial}.png`);
      const afterClear = await snapshot(op, "xianyu-input-after-clear");
      const clearedDescription = findDescriptionField(afterClear.nodes);
      clearedVerified = !descriptionContains(clearedDescription, value)
        && String(clearedDescription?.label || semanticLabel(clearedDescription))
          === String(description?.label || semanticLabel(description));
    }
  } catch (error) {
    inputError = error.message;
  } finally {
    if ((await op.currentIme()) !== priorIme) await op.setIme(priorIme).catch(() => false);
    // 保留到整表证据阶段时，不能再发 BACK：切回原 IME 往往已经收起键盘，
    // 多余的 BACK 会直接退出编辑页。最终清理由 discard-dry-run 显式完成。
    if (clearAfter) await op.session.exec("input keyevent KEYCODE_BACK", 6000).catch(() => null);
    await settle(300);
  }
  return {
    ok: textVerified && (!clearAfter || clearedVerified),
    step: inputError ? "xiaowei-input-error"
      : textVerified ? (!clearAfter || clearedVerified ? "completed" : "clear-unverified")
        : "flutter-chinese-input-unverified",
    stoppedBeforePublish: true,
    audit: {
      flutterInputActive,
      priorIme,
      bridgeIme,
      bridgeImeSelected: inputAudit.selected,
      flutterInputRebound: inputAudit.rebound,
      inputAccepted: inputAudit.inputAccepted,
      imeRestored: (await op.currentIme()) === priorIme,
      visualChanged: !!entered && entered.sha256 !== baseline.sha256,
      textVerified,
      clearedVerified,
      clearAfter,
      inputError,
    },
    evidence: { baseline, entered, cleared },
  };
}

export async function discardDraftDryRun(op) {
  const before = await snapshot(op, "xianyu-discard-before");
  if (before.focus.package !== IDLEFISH_PACKAGE || !isPublishCompose(before.nodes)) {
    return { ok: false, step: "not-on-publish-compose", stoppedBeforePublish: true };
  }
  const close = before.nodes.find((node) => node.className === "android.widget.Button"
    && node.bounds?.[0] === 0 && node.bounds?.[1] < 200 && node.bounds?.[2] < 120);
  if (!close?.bounds) return { ok: false, step: "close-button", stoppedBeforePublish: true };
  await op.tap(...center(close.bounds));
  await settle(800);
  const confirm = await snapshot(op, "xianyu-discard-confirm");
  const discard = findDiscardWithoutSaving(confirm.nodes);
  if (!discard?.bounds) return { ok: false, step: "discard-button", stoppedBeforePublish: true };
  await op.tap(...center(discard.bounds));
  await settle(1000);
  const focus = await op.currentFocus();
  return {
    ok: focus.package === IDLEFISH_PACKAGE && /MainActivity/.test(focus.activity || ""),
    step: "discarded-without-saving",
    stoppedBeforePublish: true,
    savedDraft: false,
    focus,
  };
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
    let entry = null;
    if (step === 0 && /MainActivity/.test(state.focus.activity || "")) {
      // 首页中央黄色“卖闲置”：真实 1080x2400 页面截图校验过；下一步仍重新 dump。
      entry = { bounds: [390, 2070, 690, 2370] };
    } else {
      entry = findPublishEntry(state.nodes);
      if (!entry && step === 1) entry = findPublishMenuEntryByLayout(state.nodes);
    }
    if (!entry) return { ok: false, step: "publish-entry", stoppedBeforePublish: true, trace };
    const [x, y] = center(entry.bounds);
    await op.tap(x, y);
    await settle();
  }
  return { ok: false, step: "publish-compose", stoppedBeforePublish: true, trace };
}

async function main() {
  const command = process.argv.find((value) => [
    "start", "snapshot", "open-publish", "input-dry-run", "discard-dry-run",
  ].includes(value)) || "help";
  const serial = arg("--serial");
  const adbPath = arg("--adb", process.env.ADB_PATH || DEFAULT_ADB);
  if (!serial && command !== "help") throw new Error("缺少 --serial <设备序列号>");

  if (command === "help") {
    console.log(`闲鱼 operator（只读/发布页 dry-run）

node scripts/xianyu-operator.mjs --serial <serial> start
node scripts/xianyu-operator.mjs --serial <serial> snapshot
node scripts/xianyu-operator.mjs --serial <serial> open-publish
node scripts/xianyu-operator.mjs --serial <serial> input-dry-run --text <临时文本>
node scripts/xianyu-operator.mjs --serial <serial> discard-dry-run

open-publish 只进入发布编辑页，绝不点击最终“发布”。
discard-dry-run 只点击“关闭 → 不保存”，绝不点击“存草稿/发布”。`);
    return;
  }

  const op = await new FastOperator({ adbPath, serial }).start();
  try {
    if (command === "start") console.log(JSON.stringify({ ok: true, focus: await startIdlefish(op) }, null, 2));
    if (command === "snapshot") console.log(JSON.stringify(await snapshot(op, "xianyu-snapshot"), null, 2));
    if (command === "open-publish") console.log(JSON.stringify(await openPublishDryRun(op), null, 2));
    if (command === "input-dry-run") console.log(JSON.stringify(await inputDryRun(op, {
      text: arg("--text"),
      clearAfter: !process.argv.includes("--keep-until-discard"),
    }), null, 2));
    if (command === "discard-dry-run") console.log(JSON.stringify(await discardDraftDryRun(op), null, 2));
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
