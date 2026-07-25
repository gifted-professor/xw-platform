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
import { GatewayOperator } from "./gateway-operator.mjs";
import { XiaoweiHttpAdapter } from "./xiaowei-http-adapter.mjs";

const IDLEFISH_PACKAGE = "com.taobao.idlefish";
const IDLEFISH_MAIN_ACTIVITY = "com.taobao.idlefish.maincontainer.activity.MainActivity";
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
  // 首页也含「价格指数」「描述真实…」等字样，会误匹配裸 /价格|描述|标题/，导致 open-publish
  // 在首页就提前判定已到发布页、不点「卖闲置」进发布编辑页（2026-07-23 实证）。先排除首页。
  if (/价格指数|(^|\n)卖闲置($|\n)/m.test(text)) return false;
  // 发布页描述区占位文案 / 商业字段，收紧避免首页瀑布流文案误命中。
  const hasDescription = /宝贝描述|说说宝贝|描述一下宝贝|品牌型号|货品来源|宝贝标题/.test(text);
  const hasCommerceField = /(^|\n)价格(¥| ¥|$|\n)|分类|成色|发货方式|运费|商品规格/.test(text);
  const hasMediaUpload = /添加图片|添加照片|拍照/.test(text);
  const hasFinalPublish = /(^|\n)发布($|\n)/m.test(text);
  const topRightButton = snapshot.some((node) => node.className === "android.widget.Button"
    && node.bounds?.[0] >= 850 && node.bounds?.[1] < 220);
  const closeButton = snapshot.some((node) => node.className === "android.widget.Button"
    && node.bounds?.[0] === 0 && node.bounds?.[1] < 220 && node.bounds?.[2] < 120);
  // 发布页必有媒体上传入口（首页没有），用它做主门控，杜绝首页误判。
  if (hasMediaUpload && (hasDescription || hasCommerceField || hasFinalPublish)) return true;
  if (hasDescription && (hasCommerceField || hasFinalPublish)) return true;
  // 页面滚到 SKU/运费/所在地后，Flutter 只暴露可视节点，描述和图片入口会离开语义树。
  // 顶栏最终发布按钮 + 可见商务字段是发布页下半部的稳定组合。
  if (topRightButton && hasFinalPublish && hasCommerceField) return true;

  // Windows 管道偶发把 UTF-8 content-desc 显示成 GBK mojibake；用真实页布局做二次门控。
  // 三个区域必须同时存在，且调用方还会校验前台包名，避免单坐标误判。
  const mediaButton = snapshot.some((node) => node.className === "android.widget.Button"
    && node.bounds?.[0] < 150 && node.bounds?.[1] >= 200 && node.bounds?.[3] <= 700);
  const lowerFormRow = snapshot.some((node) => node.bounds?.[0] < 100 && node.bounds?.[1] >= 1300
    && node.bounds?.[2] > 900 && node.bounds?.[3] <= 2050);
  if (topRightButton && mediaButton && lowerFormRow) return true;
  // 带图联合 run 偶发在所在地回填后留下陈旧/乱码语义文本，但几何树仍准确：
  // 左上关闭 + 右上发布位 + 至少三条全宽商务行。三条件同时成立，排除 picker/SKU 子页。
  const fullWidthFormRows = snapshot.filter((node) => node.bounds?.[0] < 120
    && node.bounds?.[2] > 900
    && node.bounds?.[1] >= 700
    && node.bounds?.[3] <= 2050
    && (node.bounds[3] - node.bounds[1]) >= 70).length;
  return closeButton && topRightButton && fullWidthFormRows >= 3;
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

// 从 snapshot bounds 推算可视高度（取所有节点 y2 最大值）。
// 三键导航机型上底栏 y 低于手势导航机型；禁止再写死 2180/2320。
export function getScreenHeight(snapshot) {
  let maxY = 0;
  for (const node of snapshot || []) {
    const y2 = Number(node?.bounds?.[3]);
    if (Number.isFinite(y2) && y2 > maxY) maxY = y2;
  }
  return maxY;
}

// 底栏 y1 阈值：屏高 × 0.85。02 号机（三键导航）底栏 y1≈2132，
// 04 号机（手势）≈2227；0.85 同时覆盖两者，避免写死像素。
const BOTTOM_TAB_Y_RATIO = 0.85;

export function isBottomTabSelected(node) {
  // Flutter content-desc：「…，选中状态」vs「…，未选中状态」
  const label = String(node?.label || "");
  return /选中状态/.test(label) && !/未选中状态/.test(label);
}

export function findHomeTab(snapshot) {
  // 首页底栏：label /闲鱼|首页/ + 左下 X 轴 + 屏高比例，不写死 Y 像素。
  const screenH = getScreenHeight(snapshot);
  if (!screenH) return null;
  const minY = screenH * BOTTOM_TAB_Y_RATIO;
  const candidates = (snapshot || []).filter((node) => node.clickable && node.bounds
    && /闲鱼|首页/.test(node.label || "")
    && node.bounds[0] >= 0 && node.bounds[0] < 100
    && node.bounds[2] <= 300
    && node.bounds[1] >= minY
    && node.bounds[3] - node.bounds[1] <= 220);
  return candidates[0] || null;
}

export function findSellTab(snapshot) {
  // 中央「卖闲置」：label 匹配 + 底部中央 X 轴 + 屏高比例；卖闲置图标略高出普通底栏。
  const screenH = getScreenHeight(snapshot);
  if (!screenH) return null;
  const minY = screenH * BOTTOM_TAB_Y_RATIO;
  const candidates = (snapshot || []).filter((node) => node.clickable && node.bounds
    && /卖闲置/.test(node.label || "")
    && node.bounds[0] >= 350 && node.bounds[2] <= 730
    && node.bounds[0] <= 540 && node.bounds[2] >= 540
    && node.bounds[1] >= minY
    && node.bounds[3] - node.bounds[1] <= 320);
  return candidates[0] || null;
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

export function center(bounds) {
  return [Math.trunc((bounds[0] + bounds[2]) / 2), Math.trunc((bounds[1] + bounds[3]) / 2)];
}

export async function settle(ms = 1200) {
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
  const startedAt = Date.now();
  // 网关传输：不经 adb.exe，uiautomator dump + cat 经绿箭 adb_shell 回传 UTF-8 XML。
  if (op.transport === "gateway") {
    const xml = await op.dumpXml(label);
    const start = xml.indexOf("<hierarchy");
    const end = xml.indexOf("</hierarchy>", start);
    if (start < 0 || end < 0) throw new Error("xianyu hierarchy dump incomplete (gateway)");
    const doc = parseAllUiNodes(xml.slice(start, end + "</hierarchy>".length));
    doc._dumpMs = Date.now() - startedAt;
    doc._label = label;
    return doc;
  }
  // adb 传输：Windows 上 adb exec-out 管道会把 Flutter 中文先按 GBK 解码，形成 mojibake。
  // 先让设备写 XML，再 adb pull 原始字节，保证 UTF-8 语义不丢。
  const token = `${process.pid}-${Date.now()}`;
  const remote = `/sdcard/xianyu-dump-${token}.xml`;
  const local = join(tmpdir(), `xianyu-dump-${token}.xml`);
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
    try { await op.shellExec(`rm -f ${remote}`, 5000); } catch {}
  }
}

export async function startIdlefish(op) {
  await op.shellExec(`am force-stop ${IDLEFISH_PACKAGE}`, 8000);
  // 显式清任务栈启动主 Activity，避免恢复消息订单详情、商品 WebHybrid、图片 picker 等旧页面。
  // 4号机 USB 重插后实证：普通 `am start -n MainActivity` 会短暂到 MainActivity，随后旧商品详情
  // WebHybridActivity 重新置顶；`-S + CLEAR_TASK + NEW_TASK` 才能稳定归一。
  await op.shellExec(
    `am start -W -S -n ${IDLEFISH_PACKAGE}/${IDLEFISH_MAIN_ACTIVITY} -f 0x10008000 >/dev/null 2>&1`,
    15000,
  );
  // force-stop → monkey 后 mCurrentFocus 会短暂为 null；单次 1.8s 读取会把正常启动误判失败。
  // 有界轮询前台，仍未出现闲鱼才 fail-closed，绝不靠盲点坐标继续。
  let focus = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await settle(attempt === 0 ? 1800 : 600);
    focus = await op.currentFocus();
    if (focus.package === IDLEFISH_PACKAGE && /MainActivity/.test(focus.activity || "")) return focus;
  }
  return focus || { package: null, activity: null, raw: "" };
}

export async function snapshot(op, label) {
  const focus = await op.currentFocus();
  await settle(500);
  const doc = await xianyuDump(op, label);
  const nodes = semanticSnapshot(doc);
  return { focus, dumpMs: doc._dumpMs, publishCompose: isPublishCompose(nodes), nodes };
}

async function capturePng(op, path) {
  // 网关：Screen 存 Windows 本地路径，node 直读字节算 sha256。
  if (op.transport === "gateway") return op.capturePng(path);
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
  const focusProbe = await op.shellExec("dumpsys input_method | grep -E 'mInputShown=true|InputConnectionAdaptor'", 8000);
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
    const reboundProbe = await op.shellExec(
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
      await op.shellExec(`input keyevent KEYCODE_MOVE_END ${Array(deleteCount).fill("KEYCODE_DEL").join(" ")}`, 10000);
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
    if (clearAfter) await op.back().catch(() => null);
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
  if (!discard?.bounds) {
    // 空表或仅改了不触发草稿的字段时，闲鱼会直接关闭而不弹「不保存」。
    // 只有新鲜 focus 已回 MainActivity 才接受该分支；仍在 Flutter 页则继续 fail-closed。
    const focus = confirm.focus || await op.currentFocus();
    const closedWithoutPrompt = focus.package === IDLEFISH_PACKAGE && /MainActivity/.test(focus.activity || "");
    return {
      ok: closedWithoutPrompt,
      step: closedWithoutPrompt ? "closed-empty-without-saving" : "discard-button",
      stoppedBeforePublish: true,
      savedDraft: false,
      focus,
    };
  }
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

// 草稿恢复框处置（2026-07-23 实证）：闲鱼对未保存的编辑会自动存草稿，下次进发布页弹
// 「你有未编辑完成的宝贝，是否继续?」+ 放弃/继续。模态会挡住发布页导致填表失效。
// fail-closed 仪式：一律点「放弃」(灰钮，左)丢弃脏草稿。返回是否处置过。
export async function dismissRestoreDialog(op) {
  const snap = await snapshot(op, "xianyu-restore-check");
  const abandon = snap.nodes.find((node) => /^放弃$/.test(node.label)
    && node.className === "android.widget.Button" && node.bounds && node.bounds[1] >= 2000) || null;
  if (!abandon?.bounds) return false;
  await op.tap(...center(abandon.bounds));
  await settle(1500);
  return true;
}

export async function openPublishDryRun(op, { maxSteps = 6 } = {}) {
  const started = await startIdlefish(op);
  if (started.package !== IDLEFISH_PACKAGE) {
    return { ok: false, step: "start", started };
  }

  // 闲鱼会恢复上次 MainActivity 的 Tab（例如“消息”）。step=0 的中央“卖闲置”坐标只在
  // 首页成立；若直接在消息页点击同一坐标，会命中订单卡片。先固定回首页 Tab，再进发布流。
  // 当前校准设备均为 1080×2400，尺寸不符时拒绝盲点。
  if (/MainActivity/.test(started.activity || "")) {
    const sizeRaw = await op.shellExec("wm size", 8000).catch(() => "");
    if (!/1080x2400/.test(String(sizeRaw))) {
      return { ok: false, step: "unsupported-display-size", started, sizeRaw: String(sizeRaw).trim() };
    }
    const main = await snapshot(op, "xianyu-main-tab-layout");
    const homeTab = findHomeTab(main.nodes);
    if (!homeTab?.bounds) {
      return { ok: false, step: "home-tab-not-found", started };
    }
    // 已在首页（闲鱼 label 为选中状态）则跳过点 home，直接找卖闲置。
    let homeNodes = main.nodes;
    if (!isBottomTabSelected(homeTab)) {
      await op.tap(...center(homeTab.bounds));
      await settle(1400);
      const home = await snapshot(op, "xianyu-home-tab-normalized");
      if (home.focus.package !== IDLEFISH_PACKAGE || !/MainActivity/.test(home.focus.activity || "")) {
        return { ok: false, step: "home-tab-normalize", started, focus: home.focus };
      }
      homeNodes = home.nodes;
    }
    const sellTab = findSellTab(homeNodes);
    if (!sellTab?.bounds) {
      return { ok: false, step: "sell-tab-not-found", started };
    }
    await op.tap(...center(sellTab.bounds));
    await settle();
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
    // 草稿恢复框（「你有未编辑完成的宝贝，是否继续?」+ 放弃/继续）会盖住发布页，
    // 且这一页 isPublishCompose 为 false，必须独立检测并点「放弃」清掉，再重新进循环。
    if (/放弃/.test(state.nodes.map((n) => n.label).join("\n")) && /继续/.test(state.nodes.map((n) => n.label).join("\n"))) {
      const dismissed = await dismissRestoreDialog(op).catch(() => false);
      if (dismissed) {
        trace.push({ step: "restore-dismissed" });
        // 清掉后重 dump 当前页，可能直接是干净发布页或上一层，继续循环判断。
        continue;
      }
    }
    if (isPublishCompose(state.nodes)) {
      // 发布页可能仍叠了草稿恢复框（极端情况），再清一次再确认落在干净发布页。
      const dismissed = await dismissRestoreDialog(op).catch(() => false);
      if (dismissed) trace.push({ step: "restore-dismissed" });
      return { ok: true, stage: "publish-compose", stoppedBeforePublish: true, trace };
    }
    if (step === maxSteps) break;
    let entry = null;
    entry = findPublishEntry(state.nodes);
    if (!entry && step === 0) entry = findPublishMenuEntryByLayout(state.nodes);
    if (!entry) return { ok: false, step: "publish-entry", stoppedBeforePublish: true, trace };
    const [x, y] = center(entry.bounds);
    await op.tap(x, y);
    await settle();
  }
  return { ok: false, step: "publish-compose", stoppedBeforePublish: true, trace };
}

// ─────────────────────────────────────────────────────────────────────────────
// publish-dry-run：闲鱼发布页「整表填写」安全一键试运行
//
// 安全边界（与 open-publish / input-dry-run 一致）：
//   - 默认 dry-run，永不点击最终「发布」按钮；裸「发布」不作为任何导航入口。
//   - 只在发布编辑页（isPublishCompose）内操作；离开页面立即 fail-closed 停手。
//   - 每个字段独立填入 + 回读校验 + 截图取证；任一步失败不继续后续破坏性步骤。
//   - --publish 显式 opt-in 才会点击最终发布（仍默认禁用，交接表要求「正式发布继续默认禁止」）。
//
// 主页字段（标题/描述/价格/分类/成色/规格/运费/退货地址/图片）选择器以 Flutter 语义
// label + bounds 启发为主（resource-id 被混淆，不可靠），与现有 findDescriptionField 同套路。
// 运费模板/退货地址/图片上传在二级页，选择器需真机 dump 校准——见 `probe` 子命令。
// ─────────────────────────────────────────────────────────────────────────────

const EVIDENCE_DIR_DEFAULT = process.env.XIANYU_EVIDENCE_DIR || "C:\\Users\\Public";

function planFromArgv() {
  // 优先 --plan <path>（JSON 文件），否则从分项 flag 组装。
  const planPath = arg("--plan");
  if (planPath) {
    const raw = readFileSync(planPath, "utf8");
    return JSON.parse(raw);
  }
  const skuSpecsRaw = arg("--sku-specs");
  const imagesRaw = arg("--images");
  const attributesRaw = arg("--attributes");
  const plan = {
    title: arg("--title") || null,
    description: arg("--description") || null,
    price: arg("--price") || null,
    originalPrice: arg("--original-price") || null,
    category: arg("--category") || null,
    condition: arg("--condition") || null,
    skuSpecs: skuSpecsRaw ? JSON.parse(skuSpecsRaw) : null,
    skuReplaceExisting: process.argv.includes("--sku-replace"),
    skuStock: arg("--sku-stock") || "10",
    skuPrice: arg("--sku-price") || null,
    freightTemplate: arg("--freight-template") || null,
    freightPrice: arg("--freight-price") || null,
    returnAddress: arg("--return-address") || null,
    attributes: attributesRaw ? JSON.parse(attributesRaw) : null,
    images: imagesRaw ? JSON.parse(imagesRaw) : null,
    imageAlbum: arg("--image-album") || null,
    maxImages: Number(arg("--max-images", "9")),
  };
  return plan;
}

// 找一行可点的表单项（label 命中且通常 clickable + 在表单区）。返回首个命中。
function findRowByLabel(snapshot, regex, { clickable = true } = {}) {
  // FlutterBoost 行常 clickable=false、focusable=true（如「选择位置」），故 focusable 也算可点。
  return snapshot.find((node) =>
    regex.test(node.label)
    && (!clickable || node.clickable || node.focusable)
    && node.bounds
    && node.bounds[1] >= 200) || null;
}

// 价格输入框：label 含「价格」且为可点输入区；价格行常带「¥」前缀占位。
function findPriceField(snapshot) {
  return snapshot.find((node) => /价格|¥/.test(node.label) && node.bounds && node.bounds[1] >= 200)
    || null;
}

// 标题输入框：label 含「标题」「宝贝标题」「品牌型号」中任一（注意描述区也含「品牌型号」，
// 故优先取靠近顶部的、且 label 不含「描述」的节点）。
function findTitleField(snapshot) {
  const cands = snapshot.filter((node) => /标题|宝贝标题/.test(node.label) && node.bounds);
  if (cands.length) return cands.sort((a, b) => a.bounds[1] - b.bounds[1])[0];
  return null;
}

// 分类行：label 含「分类」。
function findCategoryRow(snapshot) {
  return findRowByLabel(snapshot, /分类/);
}

// 成色行：label 含「成色」。
function findConditionRow(snapshot) {
  return findRowByLabel(snapshot, /成色/);
}

// 运费行：label 含「运费」「包邮」「快递」。点开进入运费模板选择二级页。
export function findFreightRow(snapshot) {
  return findRowByLabel(snapshot, /发货方式|邮寄|运费|包邮|快递/);
}

// 通用：定位行并确保在可视区（Flutter render-on-scroll + 底部行半渲染点不中，
// 实证 2026-07-22 T3：desc/price 填完后布局下移，发货方式/所在位置行被推出可视区）。
// 行找不到或贴底边（>2100）就下滑渲染再重找，maxScrolls 有界。
async function locateRowWithScroll(op, findFn, label, { maxScrolls = 4 } = {}) {
  let snap = await snapshot(op, `xianyu-${label}-locate`);
  let row = findFn(snap.nodes);
  for (let i = 0; i < maxScrolls && (!row?.bounds || row.bounds[3] > 2100); i += 1) {
    await op.shellExec("input swipe 540 1600 540 1100 400", 8000).catch(() => null);
    await settle(800);
    snap = await snapshot(op, `xianyu-${label}-locate-s${i}`);
    row = findFn(snap.nodes);
  }
  return { row, snap };
}

// 所在地/位置行：label 含「选择位置」「位置」「所在地」。点开进入地图/地区选择二级页。
// 闲鱼发闲置无「退货地址」行；该字段是所在地（视觉回填，不写真实地址）。
// 注意：选择位置节点的 clickable/focusable 在 Flutter semantics 里不稳定（时 true 时 false），
// 但坐标 tap 不依赖可点标志，故用 {clickable:false} 按 label+bounds 定位即可。
export function findReturnAddressRow(snapshot) {
  return findRowByLabel(snapshot, /退货地址|收货地址|发货地址|所在地|选择位置|位置|地址/, { clickable: false });
}

// 规格/SKU 行：label 含「规格」「颜色/尺码」「SKU」。点开进入规格编辑二级页。
export function findSkuRow(snapshot) {
  return findRowByLabel(snapshot, /规格|颜色.*尺码|SKU/);
}

// SKU sheet 删除入口（1号机 2026-07-23 实证 label 形态）：
//   值级（值行右侧垃圾桶）：ImageView label='删除，按钮'        ← skuReplace 只删这层
//   维级（维度标题行右侧）：View     label='删除，按钮, 删除'   ← 不碰！维度可能是我们要填的
// 精确匹配值级；普通规格值文本('S, S')与维级删除均不匹配。
export function findSpecDeleteEntry(snapshot) {
  return snapshot.find((node) => !!node?.bounds && String(node?.label || "").trim() === "删除，按钮") || null;
}

// 维度级删除入口（'删除，按钮, 删除'）：存在说明有维度区；空维度无值可删，属正常状态。
function hasDimLevelDelete(snapshot) {
  return snapshot.some((node) => String(node?.label || "").trim() === "删除，按钮, 删除");
}

// 未删净证据：仍存在值级删除入口（有值才有值级垃圾桶）。维级删除不算残留。
function hasSpecValueEvidence(snapshot) {
  return snapshot.some((node) => String(node?.label || "").trim() === "删除，按钮");
}

// 状态A（规格类型 chips 页）实证 label：'推荐常用的规格类型' / '选择颜色规格类型, 颜色'。
// 注意状态A 的 EditText label 也是'添加规格类型'，不能用它做排除条件。
function isSpecTypeChipPage(snapshot) {
  return snapshot.some((node) => /推荐常用的规格类型|选择[^\n]*规格类型/.test(String(node?.label || "")));
}

// 调试落盘：设 XIANYU_DEBUG_DUMPS=<目录> 时把关键快照 nodes 写 JSON，供 fetch 回 Mac 亲眼看。
function skuDebugDump(tag, nodes) {
  const dir = process.env.XIANYU_DEBUG_DUMPS;
  if (!dir) return;
  try {
    writeFileSync(`${dir}\\sku-${tag}-${Date.now()}.json`, JSON.stringify(
      (nodes || []).map((n) => ({ label: n.label, cls: n.className, bounds: n.bounds, clickable: n.clickable })), null, 2), "utf8");
  } catch { /* 调试落盘失败不影响主流程 */ }
}

async function deleteExistingSpecValues(op) {
  let deleted = 0;
  let snap = await snapshot(op, "xianyu-sku-replace-check");
  skuDebugDump("replace-check", snap.nodes);
  let entry = findSpecDeleteEntry(snap.nodes);
  if (!entry) {
    // 状态A chips 页 或 空维度区（有维级删除但无值）→ 无值可删，正常继续
    if (isSpecTypeChipPage(snap.nodes) || hasDimLevelDelete(snap.nodes)) {
      return { ok: true, step: "sku-replace-empty", deleted };
    }
    return { ok: false, step: "sku-replace-unverified", deleted };
  }

  const maxDeletes = Math.max(1, snap.nodes.length);
  while (entry && deleted < maxDeletes) {
    await op.tap(...center(entry.bounds));
    deleted += 1;
    await settle(800);
    snap = await snapshot(op, `xianyu-sku-replace-after-${deleted}`);
    entry = findSpecDeleteEntry(snap.nodes);
  }

  if (entry || hasSpecValueEvidence(snap.nodes)) {
    return { ok: false, step: "sku-replace-unverified", deleted };
  }
  return { ok: true, step: "sku-replaced", deleted };
}

// 图片上传入口：发布页左上媒体按钮区，label 含「图片」「照片」「相机」或 + 占位。
export function findImageUploadEntry(snapshot) {
  return snapshot.find((node) => /图片|照片|相机|添加图片|上传/.test(node.label)
    && node.bounds && node.bounds[1] < 700)
    || snapshot.find((node) => node.className === "android.widget.Button"
      && node.bounds?.[0] < 150 && node.bounds?.[1] >= 200 && node.bounds?.[3] <= 700) || null;
}

// 发布页图片 tile 在 1/4 号机的 semantics 中不带「商品图片」label；稳定可见的是每张
// tile 右上角的「删除」角标。只统计顶部媒体区，避免把 SKU sheet 的值级删除按钮混进来。
export function analyzeImageUploadState(snapshot, {
  baselineCount = 0,
  picked = 0,
  publishCompose = true,
} = {}) {
  const topMediaNodes = (snapshot || []).filter((node) => {
    const label = String(node?.label || "").trim();
    const b = node?.bounds;
    return !!b
      && b[1] >= 150
      && b[3] <= 750
      && node.className === "android.widget.ImageView"
      && node.clickable
      && b[2] - b[0] >= 180
      && b[3] - b[1] >= 180;
  });
  const isAddTile = (node) => /添加|上传|娣诲姞鍥剧墖/.test(String(node?.label || ""));
  const deleteTiles = topMediaNodes.filter((node) =>
    /删除图片|鍒犻櫎鍥剧墖/.test(String(node?.label || "")));
  // 中文语义新鲜时按「删除图片」精确计数；乱码/无 label 时退到同一顶部媒体行的方形
  // ImageView 结构计数，并排除「添加图片」tile。
  const mediaCount = deleteTiles.length
    || topMediaNodes.filter((node) => !isAddTile(node)).length;
  const expectedCount = Number(baselineCount || 0) + Number(picked || 0);
  const hasAddMore = (snapshot || []).some((node) =>
    !!node?.bounds
    && node.bounds[1] < 750
    && /添加更多|添加图片|添加照片|娣诲姞鍥剧墖/.test(String(node.label || "")));
  return {
    verified: !!publishCompose && picked > 0 && mediaCount >= expectedCount && hasAddMore,
    mediaCount,
    expectedCount,
    hasAddMore,
  };
}

export function expectedSkuCombinationCount(specs) {
  const dimensions = Object.values(specs || {});
  if (!dimensions.length) return 0;
  if (dimensions.some((values) => !Array.isArray(values) || values.length === 0)) return 0;
  return dimensions.reduce((total, values) => total * values.length, 1);
}

export function findSkuSelectAll(snapshot) {
  return (snapshot || []).find((node) =>
    !!node?.bounds
    && /^全选[，,]/.test(String(node.label || "").trim())
    && /全选$/.test(String(node.label || "").trim())) || null;
}

export function selectedSkuCount(snapshot) {
  for (const node of snapshot || []) {
    const match = String(node?.label || "").trim().match(/^已选\s*(\d+)$/);
    if (match) return Number(match[1]);
  }
  return null;
}

export function findSkuBatchEditControls(snapshot) {
  const inputs = (snapshot || [])
    .filter((node) => /EditText/.test(String(node?.className || "")) && node?.bounds)
    .sort((a, b) => a.bounds[1] - b.bounds[1]);
  const keyboardConfirm = (snapshot || []).find((node) =>
    !!node?.bounds && /^确定(?:[，,]\s*确定)?$/.test(String(node.label || "").trim())) || null;
  return {
    priceInput: inputs[0] || null,
    stockInput: inputs[1] || null,
    keyboardConfirm,
  };
}

export function skuPriceRowEvidence(snapshot, { price, stock } = {}) {
  const priceText = String(price ?? "").replace(/[^\d.]/g, "");
  const stockText = String(stock ?? "").replace(/[^\d]/g, "");
  const rows = [];
  for (const node of snapshot || []) {
    const compact = String(node?.label || "").replace(/\s+/g, "");
    if (!compact.includes("价格¥") || !compact.includes("库存")) continue;
    const priceMatch = compact.match(/价格¥(\d+(?:\.\d+)?)/);
    const stockMatch = compact.match(/库存(\d+)件/);
    if (!priceMatch || !stockMatch) continue;
    const actualPrice = Number(priceMatch[1]);
    const expectedPrice = Number(priceText);
    if (!Number.isFinite(expectedPrice) || actualPrice !== expectedPrice || stockMatch[1] !== stockText) continue;
    const keyMatch = compact.match(/^(?:已选中,|,)?(.+?)价格¥/);
    if (!keyMatch) continue;
    rows.push({ key: keyMatch[1].replace(/,$/, ""), label: node.label, bounds: node.bounds });
  }
  return rows;
}

export function findPickerAlbumEntry(snapshot, albumName, expectedCount = null) {
  const wanted = String(albumName || "").trim();
  if (!wanted) return null;
  return (snapshot || []).find((node) => {
    const label = String(node?.label || "").trim();
    const match = label.match(/^(.*)·(\d+)$/);
    return !!node?.bounds
      && node.clickable
      && match
      && match[1] === wanted
      && (expectedCount == null || Number(match[2]) === Number(expectedCount));
  }) || null;
}

function shellSafePhonePath(path) {
  const value = String(path || "");
  if (!/^\/sdcard\/Pictures\/[A-Za-z0-9._/-]+$/.test(value) || value.includes("..")) {
    throw new Error(`unsafe staged phone image path: ${value}`);
  }
  return value;
}

async function verifyPhoneImageManifest(op, images) {
  const entries = [];
  for (const image of images || []) {
    const phonePath = shellSafePhonePath(image?.phonePath);
    const expectedSha256 = String(image?.sha256 || "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
      throw new Error(`invalid staged image sha256: ${expectedSha256}`);
    }
    const raw = await op.shellExec(`sha256sum '${phonePath}'`, 15000);
    const actualSha256 = String(raw).trim().split(/\s+/)[0]?.toLowerCase() || "";
    entries.push({
      phonePath,
      expectedSha256,
      actualSha256,
      verified: actualSha256 === expectedSha256,
    });
  }
  return {
    verified: entries.length > 0 && entries.every((entry) => entry.verified),
    entries,
  };
}

// 通用文本字段填入：点字段 → 切效卫桥 IME → 输入 → 回读校验 → 还原 IME。
// 失败 fail-closed，不继续。返回 {ok, verified, audit, evidence}。
async function fillTextField(op, field, text, { evidenceDir, label = "field", clearFirst = true } = {}) {
  if (!field?.bounds) return { ok: false, step: `${label}-field-missing` };
  if (!text) return { ok: false, step: `${label}-empty-text` };
  const safeSerial = String(op.serial).replace(/[^A-Za-z0-9_-]/g, "_");
  const [x, y] = center(field.bounds);
  const tapX = Math.min(field.bounds[2] - 40, x), tapY = Math.min(field.bounds[3] - 40, y + 20);
  await op.tap(tapX, tapY);
  await settle(700);
  const baseline = await capturePng(op, `${evidenceDir}\\xianyu-${label}-baseline-${safeSerial}.png`);
  let audit = null;
  try {
    // FlutterBoost：切 IME 后必须重新聚焦字段（E6 实证），否则 commitText 不进字段
    audit = await op.inputTextViaXiaowei(String(text), { clearFirst, deferRestore: true, refocus: async () => { await op.tap(tapX, tapY); } });
  } catch (e) {
    return { ok: false, step: `${label}-input-failed`, error: e.message, evidence: { baseline } };
  }
  await settle(600);
  const entered = await capturePng(op, `${evidenceDir}\\xianyu-${label}-entered-${safeSerial}.png`);
  const after = await snapshot(op, `xianyu-${label}-after`);
  let verified = after.nodes.some((node) => descriptionContains(node, text));
  // 还原 IME（deferRestore 模式下 audit 带 restore()）
  if (typeof audit.restore === "function") await audit.restore().catch(() => null);
  if (!verified) {
    // refocus 间歇失效（T3 第三轮实证：refocused=true 但字没进）——重聚焦重输一次
    await op.tap(tapX, tapY);
    await settle(700);
    try {
      audit = await op.inputTextViaXiaowei(String(text), { clearFirst, deferRestore: true, refocus: async () => { await op.tap(tapX, tapY); } });
      await settle(600);
      const after2 = await snapshot(op, `xianyu-${label}-after2`);
      verified = after2.nodes.some((node) => descriptionContains(node, text));
    } catch { /* 保持 unverified */ }
    if (typeof audit?.restore === "function") await audit.restore().catch(() => null);
  }
  // 关闭编辑器（点「完成」）——分类推荐区/后续行在编辑态关闭后才渲染（gap5 实证，2026-07-22）
  const editorSnap = await snapshot(op, `xianyu-${label}-editor`);
  const doneBtn = editorSnap.nodes.find((n) => /^完成$/.test(String(n.label || "")));
  if (doneBtn?.bounds) { await op.tap(...center(doneBtn.bounds)); await settle(900); }
  return {
    ok: verified,
    step: verified ? `${label}-filled` : `${label}-unverified`,
    verified,
    audit: audit.audit || audit,
    evidence: { baseline, entered },
  };
}

// 价格字段填入：价格是纯数字（ASCII），用 `input text` 直输即可，无需 IME 桥。
// 仍做回读校验（页面出现该数字串）。
async function fillPriceField(op, field, price, { evidenceDir } = {}) {
  if (!field?.bounds) return { ok: false, step: "price-field-missing" };
  const clean = String(price).replace(/[^\d.]/g, "");
  if (!clean) return { ok: false, step: "price-invalid" };
  const safeSerial = String(op.serial).replace(/[^A-Za-z0-9_-]/g, "_");
  const cleanup = () => op.back().catch(() => null);
  const [x, y] = center(field.bounds);
  await op.tap(x, y);
  await settle(1000);
  const baseline = await capturePng(op, `${evidenceDir}\\xianyu-price-baseline-${safeSerial}.png`);
  const sheet = await snapshot(op, "xianyu-price-sheet");
  const digits = sheet.nodes.filter((n) => /^[0-9]$/.test(String(n.label || "")) && n.bounds);
  let entered = null;
  if (digits.length >= 8) {
    // 应用内数字键盘模式（2026-07-22 gap4 实证）：价格行点开是底部 sheet（价格/原价/库存+数字键盘），
    // KeyEvent input text 对它无效；semantics 数字键逐个点（占位 0.00 输入即替换），键盘确定=x 中心>700。
    for (const ch of clean) {
      const key = sheet.nodes.find((n) => String(n.label) === ch);
      if (!key?.bounds) { await cleanup(); return { ok: false, step: `price-key-missing`, evidence: { baseline } }; }
      await op.tap(...center(key.bounds));
      await settle(220);
    }
    await settle(400);
    entered = await capturePng(op, `${evidenceDir}\\xianyu-price-entered-${safeSerial}.png`);
    const typed = await snapshot(op, "xianyu-price-typed");
    const kbConfirm = typed.nodes.find((n) => /^确定$/.test(String(n.label || "")) && n.bounds && center(n.bounds)[0] > 700)
      || sheet.nodes.find((n) => /^确定$/.test(String(n.label || "")) && n.bounds && center(n.bounds)[0] > 700);
    if (!kbConfirm?.bounds) { await cleanup(); return { ok: false, step: "price-keyboard-confirm-missing", evidence: { baseline, entered } }; }
    await op.tap(...center(kbConfirm.bounds));
    await settle(1000);
  } else {
    // 兼容行内编辑形态：KeyEvent 直输（先清后输）
    await op.shellExec("input keyevent KEYCODE_MOVE_END " + Array(24).fill("KEYCODE_DEL").join(" "), 8000);
    await op.shellExec(`input text ${clean}`, 8000);
    await settle(500);
    entered = await capturePng(op, `${evidenceDir}\\xianyu-price-entered-${safeSerial}.png`);
  }
  const after = await snapshot(op, "xianyu-price-after");
  // 严格校验：必须出现在价格行 label 里（防「66 进了描述框也判过」的假象，T3 实证）
  const rowAfter = findPriceField(after.nodes);
  const verified = !!(rowAfter && String(rowAfter.label || "").includes(clean));
  if (!verified) await cleanup(); // fail-closed：不留开着的 sheet 给后续步骤
  return { ok: verified, step: verified ? "price-filled" : "price-unverified", verified, evidence: { baseline, entered } };
}

// 成色选择：点成色行 → 在弹出的选项里点目标（默认「全新」）。
async function selectCondition(op, condition, { evidenceDir } = {}) {
  const safeSerial = String(op.serial).replace(/[^A-Za-z0-9_-]/g, "_");
  const { row } = await locateRowWithScroll(op, findConditionRow, "condition");
  if (!row?.bounds) return { ok: false, step: "condition-row-missing" };
  await op.tap(...center(row.bounds));
  await settle(800);
  const sheet = await snapshot(op, "xianyu-condition-sheet");
  const target = sheet.nodes.find((node) => new RegExp(`^${condition}$|^${condition}成色`).test(node.label)
    && node.bounds) || sheet.nodes.find((node) => node.label && node.label.includes(condition) && node.bounds);
  if (!target?.bounds) {
    // 选项面板没出现或找不到目标：回退并 fail-closed。
    await op.back().catch(() => null);
    return { ok: false, step: "condition-option-missing", wanted: condition };
  }
  const ev = await capturePng(op, `${evidenceDir}\\xianyu-condition-selected-${safeSerial}.png`);
  await op.tap(...center(target.bounds));
  await settle(600);
  return { ok: true, step: "condition-selected", selected: condition, evidence: { sheet: ev } };
}

// ─────────────────────────────────────────────────────────────────────────────
// 分类推荐区 chip 选择（2026-07-22 gap5 实证）：填描述退出编辑态后，「分类/品牌/型号/等」
// 推荐面板展开，chip label 形态为「可选X, X」/「已选中X, X」（selected 标志不可用，前缀即状态）。
// AI 会按描述自动选中部分 chip（实证自动选中 手机 + MIUI/小米）。
export function findPanelChip(nodes, target) {
  const wanted = String(target || "").trim();
  if (!wanted) return null;
  for (const n of nodes || []) {
    const m = String(n.label || "").match(/^(已选中|可选)(.+?),/);
    if (m && m[2].trim() === wanted) return { node: n, state: m[1], name: m[2].trim() };
  }
  return null;
}

// 点 chip：已选中→直接 verified；可选→点→回读变已选中。行外 chip 需纵向滚动兜底。
async function selectPanelChip(op, target, { evidenceDir, label = "chip" } = {}) {
  let snap = await snapshot(op, `xianyu-${label}-panel`);
  let chip = findPanelChip(snap.nodes, target);
  for (let i = 0; i < 4 && !chip; i += 1) {
    await op.shellExec("input swipe 540 1600 540 1100 400", 8000).catch(() => null);
    await settle(800);
    snap = await snapshot(op, `xianyu-${label}-panel-s${i}`);
    chip = findPanelChip(snap.nodes, target);
  }
  if (!chip) return { ok: false, step: `${label}-chip-missing`, wanted: target };
  if (chip.state === "已选中") return { ok: true, step: `${label}-already-selected`, verified: true };
  await op.tap(...center(chip.node.bounds));
  await settle(900);
  const after = await snapshot(op, `xianyu-${label}-after`);
  const chip2 = findPanelChip(after.nodes, target);
  const verified = !!chip2 && chip2.state === "已选中";
  const ev = await capturePng(op, `${evidenceDir}\\xianyu-${label}-chip-${String(op.serial).replace(/[^A-Za-z0-9_-]/g, "_")}.png`);
  return { ok: verified, step: verified ? `${label}-selected` : `${label}-unverified`, verified, evidence: { chip: ev } };
}


//   - 分类/品牌/成色/尺码/适用季节/裤长/腰型 都能点选；**不同分类生成不同字段，不能写固定坐标**。
//   - 规格弹窗底部「下一步」第二轮 ADB/绿箭点击偶发不响应（第一轮完整链路成功）。
// 据此：
//   - selectRowOption：通用「点行 → 面板选目标 → 回读校验」，按 label 定位，零硬编码坐标；
//     驱动成色/分类/运费/退货地址/动态属性（品牌/尺码/适用季节/裤长/腰型…）。
//   - stableTapButton：等动画落定 → bounds 稳定校验 → 偏上点击避遮挡 → 校验页面前进 →
//     未前进重找按钮 + 交替 ADB/绿箭 通道重试；治「下一步」第二轮偶发不响应。
// ─────────────────────────────────────────────────────────────────────────────

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 屏幕尺寸缓存（绿箭 tap 用百分比坐标，需真实像素分母；默认 1080x2400 = 4 号机实证值）。
const _screenSize = new Map();
async function screenSize(op) {
  if (_screenSize.has(op.serial)) return _screenSize.get(op.serial);
  const out = await op.shellExec("wm size", 6000).catch(() => "");
  const m = String(out || "").match(/(\d+)x(\d+)/);
  const sz = m ? { w: +m[1], h: +m[2] } : { w: 1080, h: 2400 };
  _screenSize.set(op.serial, sz);
  return sz;
}

// 通用「点表单行 → 弹出选项面板 → 点目标选项 → 回读校验」。
// 行不在当前页 → field-not-present（动态字段因分类不同而不同，非致命；调用方按 present 判定是否跳过）。
// 选项面板没出现或找不到目标 → BACK 回退 + fail-closed。选完回读该行 label 应包含 value 或 verifyRegex 命中。
export async function selectRowOption(op, labelRegex, value, {
  evidenceDir = EVIDENCE_DIR_DEFAULT, label = "row", verifyRegex = null,
  scrollToFind = true, maxScrolls = 6,
} = {}) {
  if (value == null || value === "") return { ok: false, step: `${label}-empty-value` };
  const safeSerial = String(op.serial).replace(/[^A-Za-z0-9_-]/g, "_");
  let before = await snapshot(op, `xianyu-${label}-before`);
  let row = findRowByLabel(before.nodes, labelRegex);
  // FlutterBoost semantics 只渲染可见节点；分类/成色/品牌等行常在折叠下方，
  // 单次 dump 找不到 → 交替下滑/上滑再 dump 重找（有界），把行滚进视区。
  let scrolls = 0;
  while (!row?.bounds && scrollToFind && scrolls < maxScrolls) {
    const swipe = scrolls % 2 === 0 ? "input swipe 540 1700 540 800 400" : "input swipe 540 800 540 1700 400";
    await op.shellExec(swipe, 8000).catch(() => null);
    await settle(700);
    before = await snapshot(op, `xianyu-${label}-before-s${scrolls + 1}`);
    row = findRowByLabel(before.nodes, labelRegex);
    scrolls += 1;
  }
  if (!row?.bounds) return { ok: false, step: `${label}-row-not-present`, implemented: true, present: false, scrolled: scrolls };
  await op.tap(...center(row.bounds));
  await settle(800);
  const sheet = await snapshot(op, `xianyu-${label}-sheet`);
  const exact = new RegExp(`^${escapeRegex(value)}$`);
  const bounded = new RegExp(`(^|[^\\w])${escapeRegex(String(value))}($|[^\\w])`);
  const target = sheet.nodes.find((n) => n.label && exact.test(n.label) && n.clickable && n.bounds)
    || sheet.nodes.find((n) => n.label && bounded.test(n.label) && n.clickable && n.bounds)
    || sheet.nodes.find((n) => n.label && n.label.includes(value) && n.clickable && n.bounds)
    || sheet.nodes.find((n) => n.label && (exact.test(n.label) || n.label.includes(value)) && n.bounds);
  if (!target?.bounds) {
    await op.back().catch(() => null);
    return { ok: false, step: `${label}-option-missing`, implemented: true, present: true, wanted: value, rowBounds: row.bounds };
  }
  const evSheet = await capturePng(op, `${evidenceDir}\\xianyu-${label}-sheet-${safeSerial}.png`);
  await op.tap(...center(target.bounds));
  await settle(700);
  const after = await snapshot(op, `xianyu-${label}-after`);
  const verifyRe = verifyRegex ? new RegExp(verifyRegex) : new RegExp(escapeRegex(value));
  const rowAfter = after.nodes.find((n) => labelRegex.test(n.label) && n.bounds);
  const verified = !!(rowAfter && verifyRe.test(String(rowAfter.label || "")));
  const evSelected = await capturePng(op, `${evidenceDir}\\xianyu-${label}-selected-${safeSerial}.png`);
  return {
    ok: verified,
    step: verified ? `${label}-selected` : `${label}-selected-unverified`,
    implemented: true, present: true, selected: value, verified,
    rowBounds: row.bounds, optionBounds: target.bounds,
    evidence: { sheet: evSheet, selected: evSelected },
  };
}

// 稳定点击 Flutter 按钮——规格弹窗「下一步」第二轮偶发不响应的根治。
// 策略：等动画稳定 → 找按钮 → 跨两次 dump 校验 bounds 稳定且 clickable →
// 偏上点击（y=bounds[1]+h*0.45，避底部键盘/遮挡）→ 校验页面前进（按钮消失或 label 集合变化）；
// 未前进则重新找按钮（bounds 可能位移）、交替 ADB input tap / 绿箭 tap(百分比) 重试，最多 retries 次。
export async function stableTapButton(op, labelRegex, {
  label = "next", retries = 4, settleMs = 700, evidenceDir = EVIDENCE_DIR_DEFAULT,
} = {}) {
  const safeSerial = String(op.serial).replace(/[^A-Za-z0-9_-]/g, "_");
  const labelSet = (snap) => (snap.nodes || []).map((n) => n.label).filter(Boolean).join("\n");
  const findBtn = (snap) => (snap.nodes || []).find((n) =>
    labelRegex.test(n.label) && n.clickable && n.bounds && n.bounds[1] >= 200) || null;
  const advanced = (before, after) => (!findBtn(after)) || (labelSet(before) !== labelSet(after));
  let before = await snapshot(op, `xianyu-${label}-pre`);
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await settle(settleMs);
    const s1 = await snapshot(op, `xianyu-${label}-a${attempt}-s1`);
    const btn1 = findBtn(s1);
    if (!btn1) {
      if (advanced(before, s1)) return { ok: true, step: `${label}-already-advanced`, attempts: attempt };
      continue;
    }
    await settle(300);
    const s2 = await snapshot(op, `xianyu-${label}-a${attempt}-s2`);
    const btn2 = findBtn(s2);
    if (!btn2) {
      if (advanced(before, s2)) return { ok: true, step: `${label}-advanced-during-stable`, attempts: attempt };
      continue;
    }
    const stableBounds = JSON.stringify(btn1.bounds) === JSON.stringify(btn2.bounds);
    const b = stableBounds ? btn2.bounds : btn1.bounds;
    const [cx] = center(b);
    const h = b[3] - b[1];
    const tx = Math.max(20, Math.min(1060, cx));
    const ty = Math.max(b[1] + 20, Math.min(b[3] - 10, b[1] + Math.trunc(h * 0.45)));
    const ev = await capturePng(op, `${evidenceDir}\\xianyu-${label}-tap-a${attempt}-${safeSerial}.png`);
    if (attempt % 2 === 0) {
      await op.tap(tx, ty);
    } else {
      try {
        const sz = await screenSize(op);
        await op.xiaoweiInvoke("tap", { x: Math.round(tx / sz.w * 100), y: Math.round(ty / sz.h * 100) });
      } catch {
        await op.tap(tx, ty);
      }
    }
    await settle(settleMs);
    const after = await snapshot(op, `xianyu-${label}-a${attempt}-after`);
    if (advanced(before, after)) {
      return { ok: true, step: `${label}-advanced`, attempts: attempt + 1, tappedBounds: b, evidence: { tap: ev } };
    }
    before = after;
  }
  return { ok: false, step: `${label}-no-advance`, attempts: retries + 1 };
}

// 发现当前发布页的所有可点表单行（label + bounds），用于动态字段探测与调试。
// 排除已知固定大区（标题/描述/价格/规格/运费/地址/图片/发布）后，剩下的就是分类驱动的动态属性候选。
export function discoverFormRows(snapshot, { exclude = /标题|描述|价格|规格|运费|包邮|快递|退货地址|收货地址|发货地址|所在地|选择位置|位置|地址|图片|照片|发布|发货方式|添加图片|商品规格|选择位置/ } = {}) {
  return (snapshot.nodes || [])
    .filter((n) => n.clickable && n.bounds && n.bounds[1] >= 200 && n.label)
    .filter((n) => !exclude.test(n.label))
    .map((n) => ({ label: n.label, bounds: n.bounds }));
}

// 运费 sheet 的选项不是独立节点，而是一个带换行的整块 Flutter semantics。
// 将整块按行数等分，用 synthetic bounds + center() 计算目标行行心。
export function findFreightOptionBlock(nodes) {
  return (nodes || []).filter((node) =>
    node?.bounds
    && String(node.label || "").includes("\n")
    && String(node.label || "").includes("邮寄")
    && String(node.label || "").includes("包邮"))
    .sort((a, b) => String(b.label || "").split("\n").length - String(a.label || "").split("\n").length)[0] || null;
}

export function freightOptionTarget(block, template) {
  if (!block?.bounds || !template) return null;
  const lines = String(block.label || "").split("\n").map((line) => line.trim());
  const wanted = String(template).trim();
  const suffix = wanted.includes("-") ? wanted.split("-").slice(1).join("-") : wanted;
  let index = lines.findIndex((line) => line === wanted);
  if (index < 0 && wanted === "包邮") index = lines.findIndex((line) => line === "包邮");
  if (index < 0 && wanted !== "包邮") index = lines.findIndex((line) => line.includes(wanted));
  if (index < 0 && suffix && suffix !== wanted) index = lines.findIndex((line) => line.includes(suffix));
  if (index < 0) return null;
  const [x0, y0, x1, y1] = block.bounds;
  const lineHeight = (y1 - y0) / lines.length;
  const lineBounds = [x0, y0 + lineHeight * index, x1, y0 + lineHeight * (index + 1)];
  return { index, lineCount: lines.length, bounds: lineBounds, point: center(lineBounds) };
}

export function freightKeyboard(nodes) {
  const digitNodes = (nodes || []).filter((node) => /^[0-9]$/.test(String(node.label || "").trim()) && node.bounds);
  const keyByLabel = new Map();
  for (const node of digitNodes) {
    const label = String(node.label).trim();
    if (!keyByLabel.has(label) || node.clickable) keyByLabel.set(label, node);
  }
  const confirms = (nodes || []).filter((node) => /^确定$/.test(String(node.label || "").trim()) && node.bounds);
  return {
    active: keyByLabel.size >= 8,
    keyByLabel,
    keyboardConfirm: confirms.find((node) => center(node.bounds)[0] > 700) || null,
    sheetConfirm: confirms.find((node) => center(node.bounds)[0] < 700) || null,
  };
}

export function freightRowVerified(label, template, freightPrice = null) {
  const value = String(label || "");
  if (String(template).trim() === "包邮") return value.includes("包邮") && !/不包邮|运费/.test(value);
  if (!value.includes("运费")) return false;
  const price = String(freightPrice ?? "").trim().replace(/[^\d.]/g, "");
  if (!price) return true;
  const escaped = escapeRegex(price);
  return new RegExp(`(?:¥|￥)?\\s*${escaped}(?:\\.0{1,2})?(?!\\d)`).test(value);
}

// 运费模板专用状态机：点行 → 多行 semantics 行心选择 → 应用内数字键盘 → 双确定 → 回读。
// 未校准只定位行，不点开二级页。
export async function selectFreightTemplate(op, template, {
  evidenceDir = EVIDENCE_DIR_DEFAULT, calibrated = false, freightPrice = null,
} = {}) {
  if (!calibrated || !template) {
    const before = await snapshot(op, "xianyu-freight-before");
    const row = findFreightRow(before.nodes);
    return row?.bounds
      ? { ok: false, step: "freight-needs-calibration", implemented: false, rowBounds: row.bounds }
      : { ok: false, step: "freight-row-missing", implemented: false };
  }
  const safeSerial = String(op.serial).replace(/[^A-Za-z0-9_-]/g, "_");
  const { row } = await locateRowWithScroll(op, findFreightRow, "freight");
  if (!row?.bounds) return { ok: false, step: "freight-row-missing", implemented: true };
  await op.tap(...center(row.bounds));
  await settle(800);

  let sheet = null;
  let block = null;
  for (let attempt = 0; attempt < 4 && !block; attempt += 1) {
    sheet = await snapshot(op, `xianyu-freight-sheet-a${attempt}`);
    block = findFreightOptionBlock(sheet.nodes);
    if (!block) await settle(800);
  }
  if (!block) {
    await op.back().catch(() => null);
    return { ok: false, step: "freight-option-block-missing", implemented: true };
  }
  const target = freightOptionTarget(block, template);
  if (!target) {
    await op.back().catch(() => null);
    return { ok: false, step: "freight-option-missing", implemented: true };
  }
  await op.tap(...target.point);
  await settle(700);
  const selectedShot = await capturePng(op, `${evidenceDir}\\xianyu-freight-option-${safeSerial}.png`);
  let selected = await snapshot(op, "xianyu-freight-selected");
  let keyboard = freightKeyboard(selected.nodes);
  let priceFilled = false;

  if (keyboard.active) {
    if (freightPrice == null || String(freightPrice).trim() === "") {
      return { ok: false, step: "freight-price-required", implemented: true, keyboardMode: true };
    }
    for (const char of String(freightPrice).trim()) {
      const key = keyboard.keyByLabel.get(char);
      if (!key?.bounds) return { ok: false, step: "freight-price-key-missing", implemented: true, keyboardMode: true };
      await op.tap(...center(key.bounds));
      await settle(180);
    }
    priceFilled = true;
    if (!keyboard.keyboardConfirm?.bounds) {
      return { ok: false, step: "freight-keyboard-confirm-missing", implemented: true, keyboardMode: true, priceFilled };
    }
    await op.tap(...center(keyboard.keyboardConfirm.bounds));
    await settle(700);
    selected = await snapshot(op, "xianyu-freight-after-keyboard-confirm");
    keyboard = freightKeyboard(selected.nodes);
  }

  if (!keyboard.sheetConfirm?.bounds) {
    return { ok: false, step: "freight-sheet-confirm-missing", implemented: true, keyboardMode: keyboard.active, priceFilled };
  }
  await op.tap(...center(keyboard.sheetConfirm.bounds));
  await settle(900);
  const after = await snapshot(op, "xianyu-freight-after");
  const rowAfter = findFreightRow(after.nodes);
  const verified = freightRowVerified(rowAfter?.label, template, freightPrice);
  const confirmedShot = await capturePng(op, `${evidenceDir}\\xianyu-freight-confirmed-${safeSerial}.png`);
  return {
    ok: verified,
    step: verified ? "freight-selected" : "freight-selected-unverified",
    implemented: true,
    verified,
    keyboardMode: priceFilled,
    priceFilled,
    evidence: { selected: selectedShot, confirmed: confirmedShot },
  };
}

// 退货地址：点退货地址行 → 二级页选地址。委托 selectRowOption。
async function selectReturnAddress(op, address, { evidenceDir, calibrated = false } = {}) {
  if (!calibrated || !address) {
    const before = await snapshot(op, "xianyu-address-before");
    const row = findReturnAddressRow(before.nodes);
    return row?.bounds
      ? { ok: false, step: "address-needs-calibration", implemented: false, rowBounds: row.bounds }
      : { ok: false, step: "address-row-missing", implemented: false };
  }
  return selectRowOption(op, /退货地址|收货地址|发货地址|所在地|选择位置|位置|地址/, address, { evidenceDir, label: "address", verifyRegex: escapeRegex(address) });
}

// 所在地（视觉选择器，P1 整表 dry-run 最后一环）：
// 点「选择位置」→ 地区列表页（常用地址/附近地址，每条 name\naddress，clickable）→
// 点第一条常用地址 → 回发布页校验「选择位置」行 label 已变（不再是裸「选择位置」）→ 截图取证。
// 隐私：只回 filled 布尔 + 截图 hash；绝回传/记录真实地址文字。dry-run 不保存故无真实发布。
// 不像 selectRowOption 要文本选项匹配——所在地是地址列表非选项 sheet，故专用此函数。
async function selectLocation(op, { evidenceDir = EVIDENCE_DIR_DEFAULT, calibrated = false } = {}) {
  const { row } = await locateRowWithScroll(op, findReturnAddressRow, "loc");
  if (!row?.bounds) return { ok: false, step: "loc-row-missing", implemented: calibrated };
  if (!calibrated) return { ok: false, step: "loc-needs-calibration", implemented: false, rowBounds: row.bounds };
  const safeSerial = String(op.serial).replace(/[^A-Za-z0-9_-]/g, "_");
  try {
    await op.tap(...center(row.bounds));
    await settle(1500);
    const picker = await snapshot(op, "xianyu-loc-picker");
    // 常用地址条目：label 含换行（name\naddress）、clickable、在「常用地址」区（bounds[1] 在 500~1600 之间）。
    const entry = picker.nodes.find((n) => n.clickable && n.label && n.label.includes("\n") && n.bounds && n.bounds[1] >= 500 && n.bounds[1] < 1600)
      || picker.nodes.find((n) => n.clickable && n.label && n.label.includes("\n") && n.bounds && n.bounds[1] >= 500);
    if (!entry?.bounds) {
      await op.back().catch(() => null);
      return { ok: false, step: "loc-entry-missing", implemented: true };
    }
    await op.tap(...center(entry.bounds));
    await settle(1800);
    // Flutter a11y 树冻结实证（2026-07-22 gap③）：从地区页返回后，dump 一直回的是**进地区页之前**的旧树
    // （裸「选择位置」），nudge/重试都刷不动；像素其实已回填（截图=所在位置+地区名）。
    // 故校验改为双路：①label 校验（semantics 新鲜时成立）②页面迁移校验（地区页标记消失 + 发布页标记出现
    // = 条目被消费自动回填返回；点漏了会停在地区页）。两路任一成立即 filled。
    let after = await snapshot(op, "xianyu-loc-after");
    const judge = (nodes) => {
      const stillPicker = (nodes || []).some((n) => /宝贝所在地|搜索地址|常用地址/.test(String(n.label || "")));
      const backOnPublish = (nodes || []).some((n) => /描述一下宝贝|发闲置/.test(String(n.label || "")));
      const hasFilledTitle = (nodes || []).some((n) => /^所在位置/.test(String(n.label || "").trim()));
      const row = findReturnAddressRow(nodes);
      const rowChanged = !!(row && String(row.label || "").trim().length > 4 && !/^选择位置\s*$/.test(String(row.label || "").trim()));
      return { stillPicker, backOnPublish, hasFilledTitle, rowChanged, filled: hasFilledTitle || rowChanged || (!stillPicker && backOnPublish) };
    };
    let verdict = judge(after.nodes);
    if (verdict.stillPicker) {
      // 点漏了：再点一次条目
      await op.tap(...center(entry.bounds));
      await settle(1800);
      after = await snapshot(op, "xianyu-loc-after-r1");
      verdict = judge(after.nodes);
    }
    const filled = verdict.filled;
    const ev = await capturePng(op, `${evidenceDir}\\xianyu-loc-selected-${safeSerial}.png`);
    return { ok: filled, step: filled ? "loc-selected" : "loc-selected-unverified", implemented: true, filled, evidenceHash: ev?.sha256 };
  } catch (e) {
    await op.back().catch(() => null);
    return { ok: false, step: "loc-error", error: String(e.message || e), implemented: true };
  }
}

// 规格/SKU：点规格行 → 二级页填维度选项 + 价格 + 库存 → 「下一步」（可能两轮）。
// 规格/SKU（2026-07-22 gap6 探针 17 轮实证配方）：
//  ① 第一级 sheet 点类型 chip 加第一个维度（sheet 立即变形，标准类型只能这样加一个）；
//  ② 维度值：输入框输值（EditText 无 label 按 class 找，**每值重新定位**，防布局挤压出屏）+ KEYCODE_ENTER 提交；
//  ③ 后续维度：「添加规格类型」→ 新自定义区灰色标题**本身是可编辑文本框**（refocus 输维度名）；
//  ④ 下一步 → 价格库存页**双模式**：非批量（蓝链入口+行>）/批量（全选/行 radio+已选+黄批量按钮）；
//     无「取消批量设置」→ 点蓝链进批量模式；行=大 radio 逐行点中心选中（重复点会开编辑页）；
//  ⑤ 批量编辑页：数字键盘**不在 semantics**（和应用内运费键盘不同！）且 input text 不进
//     → **固定坐标敲键盘**（3列数字布局 + 确定(945,2100)，1080x2400 实测）→ 库存同法 → 确认；
//  ⑥ 价格列表「完成」收尾。未校准只定位行；calibrated=true 才真正操作。
async function fillSkuSpecs(op, specs, stock, {
  evidenceDir, calibrated = false, price = null, replaceExisting = false,
} = {}) {
  const { row } = await locateRowWithScroll(op, findSkuRow, "sku");
  if (!row?.bounds) return { ok: false, step: "sku-row-missing", implemented: calibrated };
  if (!calibrated || !specs || !Object.keys(specs).length) {
    return { ok: false, step: "sku-needs-calibration", implemented: false, rowBounds: row.bounds };
  }
  const safeSerial = String(op.serial).replace(/[^A-Za-z0-9_-]/g, "_");
  const KB = { "1": [135, 1668], "2": [405, 1668], "3": [675, 1668], "4": [135, 1842], "5": [405, 1842], "6": [675, 1842], "7": [135, 2015], "8": [405, 2015], "9": [675, 2015], ".": [135, 2188], "0": [405, 2188] };
  const KB_CONFIRM = [945, 2100];
  const typeNumKB = async (str) => { for (const ch of String(str)) { const k = KB[ch]; if (k) { await op.tap(k[0], k[1]); await settle(220); } } };
  const cleanup = async () => { for (let i = 0; i < 3; i += 1) { await op.back().catch(() => null); await settle(600); } };
  const dimResults = [];

  // 维度值输入（EditText 每值重找 + ENTER 提交 + 每 2 值滚动防挤压）
  const typeValues = async (values, tag) => {
    const out = [];
    let vi = 0;
    for (const val of values) {
      const snap0 = await snapshot(op, `xianyu-sku-${tag}-before-${vi}`);
      const edits = snap0.nodes.filter((n) => /EditText/.test(String(n.className || "")) && n.bounds && n.bounds[1] > 300 && n.bounds[3] < 2200);
      const input = edits[edits.length - 1];
      if (!input) { out.push({ val, ok: false, reason: "input-missing" }); continue; }
      const [ix, iy] = center(input.bounds);
      await op.tap(ix, iy);
      await settle(600);
      const audit = await op.inputTextViaXiaowei(String(val), { clearFirst: false, deferRestore: true, refocus: async () => { await op.tap(ix, iy); } });
      await settle(500);
      if (typeof audit.restore === "function") await audit.restore().catch(() => null);
      await op.shellExec("input keyevent KEYCODE_ENTER", 5000).catch(() => null);
      await settle(800);
      const snap1 = await snapshot(op, `xianyu-sku-${tag}-after-${vi}`);
      out.push({ val, ok: snap1.nodes.some((n) => String(n.label || "").includes(String(val))) });
      vi += 1;
      if (vi >= 2) { await op.shellExec("input swipe 540 1500 540 1100 350", 8000).catch(() => null); await settle(700); }
    }
    return out;
  };

  // 维度标题判定（状态C 实证：维度块 label = '颜色\n选择推荐的\n颜色' 整块形态）
function isDimTitle(label, dimName) {
  const l = String(label || "").trim();
  return l === dimName || l.startsWith(dimName + "\n");
}

// 分区感知的输入框定位：dimName 标题之下、下一个标题/添加按钮之上的 EditText
  const sectionInput = (nodes, dimName, allDimNames) => {
    const title = nodes.find((n) => isDimTitle(n.label, dimName) && n.bounds);
    if (!title) return null;
    const nextTitles = nodes.filter((n) => n.bounds && n.bounds[1] > title.bounds[1]
      && (allDimNames.some((d) => d !== dimName && isDimTitle(n.label, d))
        || /添加规格类型|下一步/.test(String(n.label || ""))));
    const bottom = nextTitles.length ? Math.min(...nextTitles.map((n) => n.bounds[1])) : 2400;
    const edits = nodes.filter((n) => /EditText/.test(String(n.className || "")) && n.bounds
      && n.bounds[1] > title.bounds[1] && n.bounds[3] < bottom);
    return edits[edits.length - 1] || null;
  };

  try {
    await op.tap(...center(row.bounds));
    await settle(1500);
    if (replaceExisting) {
      const replaced = await deleteExistingSpecValues(op);
      if (!replaced.ok) {
        await cleanup();
        return { ...replaced, implemented: true };
      }
    }
    const dimEntries = Object.entries(specs);
    const allDimNames = dimEntries.map(([d]) => d);
    for (let d = 0; d < dimEntries.length; d += 1) {
      const [dimName, values] = dimEntries[d];
      let snap = await snapshot(op, `xianyu-sku-dim${d}-check`);
      skuDebugDump(`dim${d}-check`, snap.nodes);
      let sectionExists = snap.nodes.some((n) => isDimTitle(n.label, dimName));
      if (!sectionExists && d === 0) {
        // 状态A：第一级类型 chips 页，点类型 chip 加第一个维度
        const chip = snap.nodes.find((n) => String(n.label || "").includes("规格类型") && String(n.label || "").endsWith(dimName));
        if (chip?.bounds) {
          await op.tap(...center(chip.bounds)); await settle(1200);
          snap = await snapshot(op, `xianyu-sku-dim${d}-added`);
          // 诚实校验：tap 后维度标题必须真出现，否则走自定义加维度路径，不盲目打字
          sectionExists = snap.nodes.some((n) => isDimTitle(n.label, dimName));
        }
      }
      if (!sectionExists) {
        // 自定义加维度：添加规格类型 → 灰标题输维度名
        const addBtn = snap.nodes.find((n) => /添加规格类型/.test(String(n.label || "")));
        if (addBtn?.bounds) {
          await op.tap(...center(addBtn.bounds));
          await settle(1200);
          const snapB = await snapshot(op, `xianyu-sku-dim${d}-title`);
          const greyTitle = snapB.nodes.find((n) => String(n.label || "") === "添加规格类型");
          if (greyTitle?.bounds) {
            const [gtx, gty] = center(greyTitle.bounds);
            await op.tap(gtx, gty);
            await settle(700);
            const auditD = await op.inputTextViaXiaowei(String(dimName), { clearFirst: false, deferRestore: true, refocus: async () => { await op.tap(gtx, gty); } });
            await settle(700);
            if (typeof auditD.restore === "function") await auditD.restore().catch(() => null);
            snap = await snapshot(op, `xianyu-sku-dim${d}-named`);
            sectionExists = snap.nodes.some((n) => isDimTitle(n.label, dimName));
          }
        }
      }
      if (!sectionExists) { dimResults.push({ dim: dimName, ok: false, reason: "section-missing" }); continue; }
      // 填值：用户明确——在分区输入框**打字**（芯片仅作兜底）。输入后校验提交值精确等于目标
      // （输 "XS" 可能被联想成 2XS及以下——实证；不符则点垃圾桶删掉重试）
      const chosen = [];
      let vi = 0;
      for (const val of values) {
        snap = await snapshot(op, `xianyu-sku-dim${d}-val-${vi}`);
        {
          const input = sectionInput(snap.nodes, dimName, allDimNames) || sectionInput(snap.nodes, dimName, []);
          if (!input) { chosen.push({ val, ok: false, reason: "input-missing" }); continue; }
          const [ix, iy] = center(input.bounds);
          await op.tap(ix, iy);
          await settle(600);
          const audit = await op.inputTextViaXiaowei(String(val), { clearFirst: false, deferRestore: true, refocus: async () => { await op.tap(ix, iy); } });
          await settle(500);
          if (typeof audit.restore === "function") await audit.restore().catch(() => null);
          await op.shellExec("input keyevent KEYCODE_ENTER", 5000).catch(() => null);
          await settle(800);
          const after = await snapshot(op, `xianyu-sku-dim${d}-val-after-${vi}`);
          // 精确判定：提交值==目标（防 "XS"→2XS及以下 联想假阳性）
          const exact = (n) => { const l = String(n.label || "").trim(); return l === String(val) || l.startsWith(String(val) + ",") || l.startsWith(String(val) + "，"); };
          let ok = after.nodes.some(exact);
          if (!ok) {
            // 兜底：推荐 chip 精确点选
            const chip = after.nodes.find((n) => exact(n) && n.bounds && !/EditText/.test(String(n.className || "")));
            if (chip) {
              await op.tap(...center(chip.bounds));
              await settle(600);
              const after2 = await snapshot(op, `xianyu-sku-dim${d}-val-chip-${vi}`);
              ok = after2.nodes.some(exact);
              if (ok) { chosen.push({ val, ok, via: "chip-fallback" }); vi += 1; continue; }
            }
          }
          chosen.push({ val, ok, via: "typed" });
        }
        vi += 1;
        if (vi >= 2) { await op.shellExec("input swipe 540 1500 540 1100 350", 8000).catch(() => null); await settle(700); }
      }
      dimResults.push({ dim: dimName, chosen });
    }
    // ④ 下一步 → 价格库存页（模式判定）
    let snapN = await snapshot(op, "xianyu-sku-before-next");
    const nextBtn = snapN.nodes.find((n) => /下一步/.test(String(n.label || "")));
    if (!nextBtn?.bounds) { await cleanup(); return { ok: false, step: "sku-next-missing", implemented: true, dimResults }; }
    await op.tap(...center(nextBtn.bounds));
    await settle(1800);
    let pp = await snapshot(op, "xianyu-sku-price-page");
    if (!pp.nodes.some((n) => /取消批量设置/.test(String(n.label || "")))) {
      const entry = pp.nodes.find((n) => /批量设置价格和库存/.test(String(n.label || "")));
      if (entry?.bounds) { await op.tap(...center(entry.bounds)); await settle(1200); pp = await snapshot(op, "xianyu-sku-batch-mode"); }
    }
    // 逐行选中 + 落盘（render-on-scroll/全选机制待实证，先抓现场）
    skuDebugDump("price-page", pp.nodes);
    const expectedRows = expectedSkuCombinationCount(specs);
    const selectAll = findSkuSelectAll(pp.nodes);
    if (!selectAll?.bounds) {
      await cleanup();
      return { ok: false, step: "sku-select-all-missing", implemented: true, expectedRows, dimResults };
    }
    await op.tap(...center(selectAll.bounds));
    await settle(1000);
    const afterSelect = await snapshot(op, "xianyu-sku-after-select");
    skuDebugDump("after-row-select", afterSelect.nodes);
    const selectedRows = selectedSkuCount(afterSelect.nodes);
    if (selectedRows !== expectedRows) {
      await cleanup();
      return {
        ok: false,
        step: "sku-row-selection-unverified",
        implemented: true,
        expectedRows,
        selectedRows,
        dimResults,
      };
    }
    const batchButton = afterSelect.nodes.find((n) =>
      /批量设置价格和库存/.test(String(n.label || "")) && n.bounds);
    if (!batchButton?.bounds) {
      await cleanup();
      return { ok: false, step: "sku-batch-button-missing", implemented: true, expectedRows, selectedRows, dimResults };
    }
    await op.tap(...center(batchButton.bounds));
    await settle(1800);
    const batchEdit = await snapshot(op, "xianyu-sku-batch-edit-open");
    skuDebugDump("batch-edit-open", batchEdit.nodes);
    // ⑤ 批量编辑页：价格、库存两个 EditText 同时存在。只能在同一张 sheet 内依次填完，
    // 最后按一次数字键盘“确定”；价格后先按确定会直接关闭 sheet。
    const controls = findSkuBatchEditControls(batchEdit.nodes);
    if (!controls.priceInput?.bounds || !controls.stockInput?.bounds || !controls.keyboardConfirm?.bounds) {
      await cleanup();
      return {
        ok: false,
        step: "sku-batch-controls-missing",
        implemented: true,
        expectedRows,
        selectedRows,
        controlsFound: {
          price: !!controls.priceInput?.bounds,
          stock: !!controls.stockInput?.bounds,
          confirm: !!controls.keyboardConfirm?.bounds,
        },
        dimResults,
      };
    }
    const priceStr = String(price || "").replace(/[^\d.]/g, "");
    if (priceStr) await typeNumKB(priceStr);
    await settle(350);
    await op.tap(...center(controls.stockInput.bounds));
    await settle(500);
    const stockStr = String(stock ?? "").replace(/[^\d]/g, "");
    if (stockStr) await typeNumKB(stockStr);
    await settle(350);
    const beforeConfirm = await snapshot(op, "xianyu-sku-before-batch-confirm");
    skuDebugDump("stock-stage", beforeConfirm.nodes);
    const confirmNow = findSkuBatchEditControls(beforeConfirm.nodes).keyboardConfirm || controls.keyboardConfirm;
    await op.tap(...center(confirmNow.bounds));
    await settle(1400);
    const listStart = await snapshot(op, "xianyu-sku-price-list-filled");
    skuDebugDump("confirm-stage", listStart.nodes);

    // ⑥ 滚动采集全部组合的价格/库存回读。首屏通常只有 8/10，不能用可见两行或单个价格
    // 当整表证据；以组合 key 去重，直到收齐 expectedRows 或有界停止。
    const covered = new Map();
    let coverageSnap = listStart;
    for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
      skuDebugDump(`coverage-${pageIndex}`, coverageSnap.nodes);
      for (const row of skuPriceRowEvidence(coverageSnap.nodes, { price: priceStr, stock: stockStr })) {
        covered.set(row.key, row);
      }
      if (covered.size >= expectedRows) break;
      await op.shellExec("input swipe 540 1800 540 900 450", 8000).catch(() => null);
      await settle(800);
      coverageSnap = await snapshot(op, `xianyu-sku-coverage-${pageIndex + 1}`);
    }
    const filledRows = covered.size;
    if (filledRows !== expectedRows) {
      await cleanup();
      return {
        ok: false,
        step: "sku-price-stock-coverage-unverified",
        implemented: true,
        expectedRows,
        selectedRows,
        filledRows,
        coveredRows: [...covered.keys()],
        dimResults,
      };
    }

    const doneBtn = coverageSnap.nodes.find((n) =>
      !!n.bounds && /^完成(?:[，,].*)?$/.test(String(n.label || "").trim()));
    if (!doneBtn?.bounds) {
      await cleanup();
      return { ok: false, step: "sku-done-missing", implemented: true, expectedRows, selectedRows, filledRows, dimResults };
    }
    await op.tap(...center(doneBtn.bounds));
    await settle(1500);
    const snapV = await snapshot(op, "xianyu-sku-verify");
    const dimensionsVerified = dimResults.length === Object.keys(specs).length
      && dimResults.every((dim) => Array.isArray(dim.chosen)
        && dim.chosen.length === specs[dim.dim]?.length
        && dim.chosen.every((value) => value.ok));
    const ev = await capturePng(op, `${evidenceDir}\\xianyu-sku-final-${safeSerial}.png`);
    const verified = dimensionsVerified
      && snapV.publishCompose
      && expectedRows > 0
      && filledRows === expectedRows;
    return {
      ok: verified,
      step: verified ? "sku-filled" : "sku-filled-unverified",
      implemented: true,
      verified,
      dimensionsVerified,
      dimResults,
      confirmFound: !!confirmNow?.bounds,
      expectedRows,
      selectedRows,
      filledRows,
      coveredRows: [...covered.keys()],
      evidence: { final: ev },
    };
  } catch (e) {
    await cleanup();
    return { ok: false, step: "sku-error", error: String(e.message || e), implemented: true, dimResults };
  }
}

// 图片上传（2026-07-23 真机实证配方，4号机 1080x2400）：
//  ① 发布页点「添加图片」入口（左上媒体区，clickable=false 但坐标 tap 生效）→ 系统相册 picker；
//  ② picker 是 4 列网格，每格 = ImageView「查看大图」+ 右上角 View「选择」(clickable=true，完全重叠)；
//     ⚠ 点图片中心会触发「查看大图」全屏预览（不勾选）——必须点右上「选择」overlay 才勾选；
//     首格（列0行1）是相机磁贴，没有「选择」，照片从列1开始，按 (y,x) 排序自然跳过相机格；
//  ③ 每点一个「选择」，底部右下「下一步 (N)」计数+1（首次选中才出现）；
//  ④ 点「下一步 (N)」→ 进图片编辑页（"1/N"，裁剪/贴纸工具 + 右下「完成」）；
//     只需点 1 次「完成」即返回发布页（不是逐张），发布页图片区出现 N 个「商品图片」+ 「添加图片」入口。
// 校准前只定位入口，不实际上传。
async function uploadImagesDryRun(op, images, {
  evidenceDir = EVIDENCE_DIR_DEFAULT,
  calibrated = false,
  maxImages = 9,
  albumName = null,
} = {}) {
  // 前序字段（运费/地点在底部）会把页面滚到底，顶部「添加图片」入口被推出视区 →
  // 先滚回顶部（手指下滑=内容上移=回顶）再定位入口。
  for (let i = 0; i < 3; i += 1) {
    const reCheck = await snapshot(op, `xianyu-image-topcheck-${i}`);
    if (findImageUploadEntry(reCheck.nodes)?.bounds) break;
    await op.shellExec("input swipe 540 400 540 1600 400", 8000).catch(() => null);
    await settle(700);
  }
  const before = await snapshot(op, "xianyu-image-before");
  const entry = findImageUploadEntry(before.nodes);
  const baselineMedia = analyzeImageUploadState(before.nodes, {
    baselineCount: 0,
    picked: 0,
    publishCompose: before.publishCompose,
  }).mediaCount;
  if (!entry?.bounds) return { ok: false, step: "image-entry-missing", implemented: calibrated };
  if (!calibrated || !images || !images.length) {
    return { ok: false, step: "image-needs-calibration", implemented: false, entryBounds: entry.bounds };
  }
  const structuredImages = images.every((image) => image && typeof image === "object");
  if (albumName && !structuredImages) {
    return { ok: false, step: "image-manifest-required", implemented: true };
  }
  let manifest = null;
  if (structuredImages) {
    try {
      manifest = await verifyPhoneImageManifest(op, images);
    } catch (error) {
      return { ok: false, step: "image-manifest-invalid", implemented: true, error: String(error.message || error) };
    }
    if (!manifest.verified) {
      return { ok: false, step: "image-manifest-unverified", implemented: true, manifest };
    }
  }
  const safeSerial = String(op.serial).replace(/[^A-Za-z0-9_-]/g, "_");
  const want = Math.min(images.length, maxImages);
  const cleanup = async () => { for (let i = 0; i < 3; i += 1) { await op.back().catch(() => null); await settle(800); } };
  try {
    // ① 开 picker
    await op.tap(...center(entry.bounds));
    await settle(2500);
    let picker = await snapshot(op, "xianyu-image-picker");
    if (!/FishFlutterBoost/.test(picker.focus.activity || "")) { await cleanup(); return { ok: false, step: "image-picker-not-open", implemented: true }; }
    let selectedAlbum = null;
    if (albumName) {
      const albumSelector = picker.nodes.find((node) => /^所有文件$/.test(String(node.label || "")) && node.bounds);
      if (!albumSelector?.bounds) {
        await cleanup();
        return { ok: false, step: "image-album-selector-missing", implemented: true, albumName, manifest };
      }
      await op.tap(...center(albumSelector.bounds));
      await settle(1000);
      const albums = await snapshot(op, "xianyu-image-albums");
      const albumEntry = findPickerAlbumEntry(albums.nodes, albumName, images.length);
      if (!albumEntry?.bounds) {
        await cleanup();
        return { ok: false, step: "image-album-missing", implemented: true, albumName, expectedCount: images.length, manifest };
      }
      selectedAlbum = { name: albumName, count: images.length, label: albumEntry.label };
      await op.tap(...center(albumEntry.bounds));
      await settle(1200);
      picker = await snapshot(op, "xianyu-image-album-selected");
    }
    // ② 选 N 个「选择」overlay（按 y,x 排序：相机磁贴在列0行1无「选择」，自然跳过）
    const selNodes = picker.nodes
      .filter((n) => n.label === "选择" && n.bounds)
      .sort((a, b) => a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0]);
    if (!selNodes.length) { await cleanup(); return { ok: false, step: "image-select-nodes-missing", implemented: true }; }
    const picked = [];
    for (let i = 0; i < Math.min(want, selNodes.length); i += 1) {
      const c = center(selNodes[i].bounds);
      await op.tap(...c);
      await settle(900);
      picked.push(c);
    }
    await settle(1200);
    // ③ 下一步 (N)
    const afterPick = await snapshot(op, "xianyu-image-after-pick");
    const nextBtn = afterPick.nodes.find((n) => /下一步/.test(n.label) && n.bounds && n.clickable);
    if (!nextBtn?.bounds) { await cleanup(); return { ok: false, step: "image-next-missing", implemented: true, picked: picked.length }; }
    const pickedShot = await capturePng(op, `${evidenceDir}\\xianyu-image-picked-${safeSerial}.png`);
    await op.tap(...center(nextBtn.bounds));
    await settle(2800);
    // ④ 编辑页「完成」（1 次即可返回发布页）
    const edit = await snapshot(op, "xianyu-image-edit");
    const doneBtn = edit.nodes.find((n) => /^完成$/.test(n.label) && n.bounds && n.clickable);
    if (!doneBtn?.bounds) { await cleanup(); return { ok: false, step: "image-done-missing", implemented: true, picked: picked.length }; }
    await op.tap(...center(doneBtn.bounds));
    await settle(2500);
    // 验证：回发布页 + 顶部媒体区「删除」角标相对基线增加 N 个。
    // 真实 tile 没有「商品图片」label，不能再用该 label 计数。
    const finalSnap = await snapshot(op, "xianyu-image-final");
    const imageState = analyzeImageUploadState(finalSnap.nodes, {
      baselineCount: baselineMedia,
      picked: picked.length,
      publishCompose: finalSnap.publishCompose,
    });
    const mediaNodes = finalSnap.nodes
      .filter((node) => node.bounds && node.bounds[1] >= 150 && node.bounds[3] <= 750)
      .map((node) => ({
        label: node.label,
        className: node.className,
        bounds: node.bounds,
        clickable: node.clickable,
      }))
      .slice(0, 60);
    const finalShot = await capturePng(op, `${evidenceDir}\\xianyu-image-final-${safeSerial}.png`);
    const verified = imageState.verified;
    return {
      ok: verified,
      step: verified ? "images-uploaded" : "images-unverified",
      implemented: true,
      verified,
      requested: want,
      picked: picked.length,
      imgCount: imageState.mediaCount,
      baselineImgCount: baselineMedia,
      expectedImgCount: imageState.expectedCount,
      hasAddMore: imageState.hasAddMore,
      selectionStrategy: albumName ? "isolated-album-exact-count" : "gallery-leading-items",
      selectedAlbum,
      manifest,
      ...(!verified ? { mediaNodes } : {}),
      evidence: { picked: pickedShot, final: finalShot },
    };
  } catch (e) {
    await cleanup();
    return { ok: false, step: "image-error", error: String(e.message || e), implemented: true };
  }
}

// 主流程：按序填整表，每步聚合到 summary。dry-run 默认 stoppedBeforePublish:true。
export async function publishDryRun(op, plan, {
  evidenceDir = EVIDENCE_DIR_DEFAULT,
  skipUpload = false,
  skipCategory = false,
  skipSku = false,
  skipFreight = false,
  skipAddress = false,
  // 二级页选择器是否已 probe 校准。校准前分类/运费/地址/SKU/图片走 needs-calibration 分支。
  // attributes（动态属性：品牌/尺码/适用季节/裤长/腰型…）默认按 label 尝试，row-not-present 非致命。
  calibrated = { category: false, freight: false, address: false, sku: false, image: false, attributes: true },
  publish = false,
} = {}) {
  const started = await startIdlefish(op);
  if (started.package !== IDLEFISH_PACKAGE) {
    return { ok: false, step: "start", stoppedBeforePublish: true, focus: started };
  }
  const opened = await openPublishDryRun(op);
  if (!opened.ok) {
    return { ok: false, step: "open-publish", stoppedBeforePublish: true, openTrace: opened.trace };
  }
  // 必须停在发布编辑页才继续。
  const page = await snapshot(op, "xianyu-publish-fill-start");
  if (page.focus.package !== IDLEFISH_PACKAGE || !isPublishCompose(page.nodes)) {
    return { ok: false, step: "not-on-publish-compose", stoppedBeforePublish: true, focus: page.focus };
  }

  const summary = {
    ok: true,
    stoppedBeforePublish: !publish,
    publishRequested: !!publish,
    plan: { ...plan, images: plan.images ? plan.images.length : 0 },
    steps: {},
    evidence: {},
  };

  const record = (key, result) => { summary.steps[key] = result; if (!result.ok && result.step && !/needs-calibration|unverified/.test(result.step)) summary.ok = false; };

  // 1. 图片
  if (skipUpload) {
    record("images", { ok: true, step: "images-skipped" });
  } else if (plan.images && plan.images.length) {
    record("images", await uploadImagesDryRun(op, plan.images, {
      evidenceDir,
      calibrated: calibrated.image,
      maxImages: plan.maxImages || 9,
      albumName: plan.imageAlbum || null,
    }));
  }

  // 2. 标题
  if (plan.title) {
    const field = findTitleField(page.nodes);
    record("title", await fillTextField(op, field, plan.title, { evidenceDir, label: "title" }));
  }
  // 3. 描述
  if (plan.description) {
    let field = findDescriptionField(page.nodes);
    if (!field?.bounds || !isEmptyDescriptionField(field)) {
      // 描述区可能已含占位；重新 dump 取最新。
      const fresh = await snapshot(op, "xianyu-desc-field");
      field = findDescriptionField(fresh.nodes);
    }
    record("description", await fillTextField(op, field, plan.description, { evidenceDir, label: "desc", clearFirst: true }));
  }
  // 4. 分类（点分类行 → 分类选择二级页选目标；label 驱动 + 回读）。
  //    分类决定后续动态属性字段集，故必须在 attributes 之前。校准前只定位行。
  let categoryPage = page;
  if (!skipCategory && plan.category) {
    if (calibrated.category) {
      const cat = await selectPanelChip(op, plan.category, { evidenceDir, label: "category" });
      record("category", cat);
      // 选完分类后页面字段会变；刷新一次再进 attributes。
      categoryPage = await snapshot(op, "xianyu-after-category");
    } else {
      const row = findCategoryRow(page.nodes);
      record("category", row?.bounds
        ? { ok: false, step: "category-needs-calibration", implemented: false, rowBounds: row.bounds }
        : { ok: false, step: "category-row-missing", implemented: false });
    }
  }
  // 4b. 动态属性（P1a）：分类后动态生成的 品牌/尺码/适用季节/裤长/腰型… 等。
  //     声明式 plan.attributes = { 字段名: 值 }；按 label 找行，行不在当前页 → present:false 非致命跳过
  //     （不同分类生成不同字段，不能硬编码）；行在则 selectRowOption 填入 + 回读校验。
  if (plan.attributes && typeof plan.attributes === "object" && calibrated.attributes !== false) {
    summary.steps.attributes = {};
    for (const [name, value] of Object.entries(plan.attributes)) {
      // 推荐区属性=chip 组（品牌/型号/容量…），按「值」找 chip；行→sheet 模型不适用（gap5 实证）
      const r = await selectPanelChip(op, value, { evidenceDir, label: `attr-${name}` });
      summary.steps.attributes[name] = r;
      if (!r.ok && r.step && !/chip-missing|unverified/.test(r.step)) summary.ok = false;
    }
  }
  // 5. 成色（推荐区 chip 优先；无 chip 回退行→sheet）
  if (plan.condition) {
    const chipTry = await selectPanelChip(op, plan.condition, { evidenceDir, label: "condition" });
    record("condition", chipTry.ok || chipTry.step !== "condition-chip-missing"
      ? chipTry
      : await selectCondition(op, plan.condition, { evidenceDir }));
  }
  // 6. 价格：有 SKU 时价格在「商品规格」批量设置页内填（用户明确：填完文案直接走规格，
  //    价格在规格里设，不要在发布页直接设价），此处跳过；无 SKU 时才在发布页价格行填。
  if (plan.price && !plan.skuSpecs) {
    const { row: field } = await locateRowWithScroll(op, findPriceField, "price");
    record("price", await fillPriceField(op, field, plan.price, { evidenceDir }));
  }
  // 7. 规格/SKU
  if (!skipSku && plan.skuSpecs) {
    record("sku", await fillSkuSpecs(op, plan.skuSpecs, plan.skuStock, {
      evidenceDir,
      calibrated: calibrated.sku,
      price: plan.skuPrice || plan.price,
      replaceExisting: plan.skuReplaceExisting === true,
    }));
  }
  // 8. 运费模板
  if (!skipFreight && plan.freightTemplate) {
    record("freight", await selectFreightTemplate(op, plan.freightTemplate, {
      evidenceDir, calibrated: calibrated.freight, freightPrice: plan.freightPrice,
    }));
  }
  // 9. 所在地（视觉选择器；闲鱼发闲置无退货地址，此字段实为所在地）
  if (!skipAddress && (plan.returnAddress || plan.location)) {
    record("address", await selectLocation(op, { evidenceDir, calibrated: calibrated.address }));
  }
  // 最终状态截图 + 发布页停留校验。
  const finalShot = await capturePng(op, `${evidenceDir}\\xianyu-publish-final-${String(op.serial).replace(/[^A-Za-z0-9_-]/g, "_")}.png`);
  const finalPage = await snapshot(op, "xianyu-publish-final");
  summary.evidence.final = finalShot;
  summary.finalState = {
    focus: finalPage.focus,
    stillOnPublishCompose: finalPage.focus.package === IDLEFISH_PACKAGE && isPublishCompose(finalPage.nodes),
  };

  // 安全闸：即便 --publish 也必须显式确认仍在发布页且整表无致命失败；裸「发布」永不点。
  // 真正的点击发布逻辑在 probe 校准 + 真机验收之后再加（交接表：正式发布继续默认禁止）。
  if (publish) {
    summary.publishAttempted = false;
    summary.publishReason = "publish path disabled until calibration + validation complete";
  }

  return summary;
}

// probe：dump 当前页，打印全部语义节点（label/bounds/class/resourceId/clickable/focused）。
// 用于真机校准 publish-dry-run 各字段选择器，以及运费/退货地址/SKU/图片二级页结构。
export async function probePage(op, { label = "probe" } = {}) {
  const focus = await op.currentFocus();
  const doc = await xianyuDump(op, label);
  const nodes = (doc.nodes || []).map((node) => ({
    label: semanticLabel(node),
    className: node.className,
    resourceId: node.resourceId,
    bounds: node.bounds,
    clickable: !!node.clickable,
    focusable: !!node.focusable,
    focused: !!node.focused,
    scrollable: !!node.scrollable,
  })).filter((node) => node.label || node.resourceId);
  return { focus, dumpMs: doc._dumpMs, publishCompose: isPublishCompose(nodes), nodeCount: nodes.length, nodes };
}

async function main() {
  const command = process.argv.find((value) => [
    "start", "snapshot", "open-publish", "input-dry-run", "discard-dry-run",
    "publish-dry-run", "probe",
  ].includes(value)) || "help";
  const serial = arg("--serial");
  const adbPath = arg("--adb", process.env.ADB_PATH || DEFAULT_ADB);
  if (!serial && command !== "help") throw new Error("缺少 --serial <设备序列号>");

  if (command === "help") {
    console.log(`闲鱼 operator（只读/发布页 dry-run）

node scripts/xianyu-operator.mjs --serial <serial> [--adb <adb>] start
node scripts/xianyu-operator.mjs --serial <serial> snapshot
node scripts/xianyu-operator.mjs --serial <serial> open-publish
node scripts/xianyu-operator.mjs --serial <serial> input-dry-run --text <临时文本>
node scripts/xianyu-operator.mjs --serial <serial> discard-dry-run
node scripts/xianyu-operator.mjs --serial <serial> publish-dry-run --plan <plan.json>
node scripts/xianyu-operator.mjs --serial <serial> publish-dry-run \\
    --title "..." --description "..." --price 119.00 --condition 全新 \\
    --sku-specs '{"颜色":["白色","黑色"],"尺码":["M","L"]}' --sku-stock 10 --sku-price 12.34 \\
    --freight-template 包邮 [--freight-price 8] --return-address 默认 [--max-images 9] \\
    --attributes '{"品牌":"Burberry","尺码":"M","适用季节":"四季"}'
node scripts/xianyu-operator.mjs --serial <serial> probe [--label xxx]

publish-dry-run：在发布编辑页整表填写（标题/描述/价格/分类/成色/规格/运费/退货地址/图片），
默认 dry-run，永不点击最终"发布"；裸"发布"不作为任何导航入口。
--publish 显式 opt-in 仍暂禁用（校准+真机验收后才开放）。
动态属性（P1a）：--attributes JSON，声明分类后动态生成的字段（品牌/尺码/适用季节/裤长/腰型…）；
  按标签找行，行不存在则非致命跳过（不同分类生成不同字段，不硬编码），存在则填入并回读校验。
规格「下一步」（P1b）：用 stableTapButton 等动画落定+偏上点击+重找重试，治第二轮偶发不响应。
--calibrated <field,...>：声明哪些二级页已真机校准（category,freight,address,sku,image），
  未校准字段只定位行、不点开二级页；attributes 默认按标签尝试。
跳过某项：--skip-upload --skip-category --skip-sku --skip-freight --skip-address
证据目录：--evidence-dir（默认 ${EVIDENCE_DIR_DEFAULT}）或 env XIANYU_EVIDENCE_DIR

probe：dump 当前页全部语义节点，用于校准各字段选择器（运费/退货地址/SKU/图片二级页结构）。
open-publish 只进入发布编辑页，绝不点击最终"发布"。
discard-dry-run 只点击"关闭 → 不保存"，绝不点击"存草稿/发布"。
传输：--transport adb|gateway（默认 adb）。gateway 经绿箭网关 ws://127.0.0.1:22222，
  不依赖 adb.exe——adb 枚举不到设备时用 gateway 仍可 dump/tap/输入/截图。`);
    return;
  }

  const transport = arg("--transport", "adb") === "gateway" ? "gateway" : "adb";
  const useHttpApi = process.argv.includes("--http-api");
  const deviceAlias = arg("--device-alias", "04");
  const op = transport === "gateway"
    ? (useHttpApi
        ? await new XiaoweiHttpAdapter({ serial, deviceAlias }).start()
        : await new GatewayOperator({ serial }).start())
    : await new FastOperator({ adbPath, serial }).start();
  try {
    if (command === "start") console.log(JSON.stringify({ ok: true, focus: await startIdlefish(op) }, null, 2));
    if (command === "snapshot") console.log(JSON.stringify(await snapshot(op, "xianyu-snapshot"), null, 2));
    if (command === "open-publish") console.log(JSON.stringify(await openPublishDryRun(op), null, 2));
    if (command === "input-dry-run") console.log(JSON.stringify(await inputDryRun(op, {
      text: arg("--text"),
      clearAfter: !process.argv.includes("--keep-until-discard"),
    }), null, 2));
    if (command === "discard-dry-run") console.log(JSON.stringify(await discardDraftDryRun(op), null, 2));
    if (command === "publish-dry-run") {
      const plan = planFromArgv();
      const calibArg = arg("--calibrated", "");
      const calibSet = new Set(calibArg.split(",").map((s) => s.trim()).filter(Boolean));
      const calibrated = {
        category: calibSet.has("category") || calibSet.has("all"),
        freight: calibSet.has("freight") || calibSet.has("all"),
        address: calibSet.has("address") || calibSet.has("all"),
        sku: calibSet.has("sku") || calibSet.has("all"),
        image: calibSet.has("image") || calibSet.has("all"),
        attributes: calibSet.has("attributes") ? true : (calibSet.has("no-attributes") ? false : true),
      };
      const result = await publishDryRun(op, plan, {
        evidenceDir: arg("--evidence-dir", EVIDENCE_DIR_DEFAULT),
        skipUpload: process.argv.includes("--skip-upload"),
        skipCategory: process.argv.includes("--skip-category"),
        skipSku: process.argv.includes("--skip-sku"),
        skipFreight: process.argv.includes("--skip-freight"),
        skipAddress: process.argv.includes("--skip-address"),
        calibrated,
        publish: process.argv.includes("--publish"),
      });
      console.log(JSON.stringify(result, null, 2));
    }
    if (command === "probe") console.log(JSON.stringify(await probePage(op, { label: arg("--label", "probe") }), null, 2));
  } finally {
    await op.close();
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entry === import.meta.url) {
  main().catch((error) => {
    // bridge exec 会把原生命令首条 stderr 提升为 PowerShell 终止错误；远程脚本只写 stdout。
    console.log(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  });
}
