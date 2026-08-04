#!/usr/bin/env node
/**
 * WeChat control-plane operator (slice 1: probe / inspect / restore).
 * Dump is empty-shell on WeChat → Activity + screenshot hash (vision-only path).
 * GatewayOperator lease required. No send / pay / moments publish.
 *
 *   node scripts/wechat-operator.mjs probe --serial <s> --evidence-dir <dir> [--label <l>]
 *   node scripts/wechat-operator.mjs inspect --serial <s> --evidence-dir <dir>
 *   node scripts/wechat-operator.mjs restore --serial <s> --evidence-dir <dir>
 *   node scripts/wechat-operator.mjs open --serial <s> --evidence-dir <dir> --title <t>  # slice1: fail-closed
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { GatewayOperator } from "./gateway-operator.mjs";

const WECHAT_PACKAGE = "com.tencent.mm";
const OPERATOR_COMMANDS = new Set(["help", "probe", "inspect", "open", "restore"]);
const SETTLE_AFTER_LAUNCH_MS = 4500;
// 1080×2400 shell (explore 01): bottom tabs Y≈2320
const TAB_MESSAGES = { x: 135, y: 2320 };

function arg(name, fallback = null, argv = process.argv) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  return argv[index + 1] ?? fallback;
}

export function resolveOperatorCommand(argv = process.argv) {
  return argv.find((value) => OPERATOR_COMMANDS.has(value)) || "help";
}

function settle(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function classifyWechatScreen(focus) {
  const pkg = focus?.package || "";
  const activity = focus?.activity || "";
  const raw = focus?.raw || "";
  const hay = `${activity} ${raw}`;
  if (pkg !== WECHAT_PACKAGE && !/com\.tencent\.mm/.test(hay)) {
    return { screenId: "unknown", reason: "not_wechat" };
  }
  if (/FTSMainUI|MMFTSSearch|fts\./i.test(hay)) {
    return { screenId: "wechat.search", reason: "fts" };
  }
  if (/ImproveSnsTimelineUI|SnsTimeLineUI|sns\.ui/i.test(hay)) {
    return { screenId: "wechat.moments", reason: "sns" };
  }
  if (/FinderHome|finder\.ui/i.test(hay)) {
    return { screenId: "wechat.channels", reason: "finder" };
  }
  if (/BaseScanUI|scanner\.ui/i.test(hay)) {
    return { screenId: "wechat.scan", reason: "scan" };
  }
  if (/AppBrand|WxaLiteApp/i.test(hay)) {
    return { screenId: "wechat.miniprogram", reason: "appbrand" };
  }
  if (/LauncherUI/i.test(hay)) {
    // LauncherUI covers all four main tabs + many chats; slice1 treats post-launch
    // + messages-tab tap as wechat.main.messages (explore: dump empty, vision/OCR later).
    return { screenId: "wechat.main.messages", reason: "launcher" };
  }
  if (/ChattingUI|chatroom/i.test(hay)) {
    return { screenId: "wechat.chat", reason: "chat" };
  }
  return { screenId: "wechat.other", reason: activity || "activity" };
}

export async function startWechat(op) {
  await op.shellExec(`am force-stop ${WECHAT_PACKAGE}`, 8000);
  await op.shellExec(
    `monkey -p ${WECHAT_PACKAGE} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1`,
    15000,
  );
  let focus = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await settle(attempt === 0 ? SETTLE_AFTER_LAUNCH_MS : 800);
    focus = await op.currentFocus();
    if (focus.package === WECHAT_PACKAGE) break;
  }
  // Prefer messages tab (leftmost).
  await op.tap(TAB_MESSAGES.x, TAB_MESSAGES.y);
  await settle(900);
  focus = await op.currentFocus();
  return focus || { package: null, activity: null, raw: "" };
}

async function ensureWechatForeground(op, { relaunch = true } = {}) {
  let focus = await op.currentFocus();
  if (focus.package !== WECHAT_PACKAGE && relaunch) {
    focus = await startWechat(op);
  }
  return focus;
}

async function captureEvidence(op, evidenceDir, label) {
  mkdirSync(evidenceDir, { recursive: true });
  const safe = String(label || "shot").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40);
  const path = join(evidenceDir, `wechat-${safe}-${Date.now()}.png`);
  const shot = await op.capturePng(path);
  return {
    path: shot.path,
    sha256: shot.sha256,
    bytes: shot.bytes,
    label: safe,
  };
}

export async function probe(op, { evidenceDir, label = "probe", launchIfNeeded = true } = {}) {
  let focus = await ensureWechatForeground(op, { relaunch: launchIfNeeded });
  await settle(400);
  focus = await op.currentFocus();
  const classified = classifyWechatScreen(focus);
  const evidence = await captureEvidence(op, evidenceDir, label);
  return {
    ok: Boolean(focus?.package === WECHAT_PACKAGE && classified.screenId),
    appId: "wechat",
    packageName: WECHAT_PACKAGE,
    focus,
    screenId: classified.screenId,
    classifyReason: classified.reason,
    evidence,
  };
}

export async function inspect(op, { evidenceDir } = {}) {
  const focus = await startWechat(op);
  const classified = classifyWechatScreen(focus);
  const evidence = await captureEvidence(op, evidenceDir, "inspect-main");
  const onMain = classified.screenId === "wechat.main.messages";
  return {
    ok: onMain && focus.package === WECHAT_PACKAGE,
    appId: "wechat",
    packageName: WECHAT_PACKAGE,
    focus,
    screenId: classified.screenId,
    classifyReason: classified.reason,
    evidence,
  };
}

export async function restore(op, { evidenceDir } = {}) {
  let focus = await op.currentFocus();
  if (focus.package !== WECHAT_PACKAGE) {
    focus = await startWechat(op);
  } else {
    // Back out of search/settings if needed, then pin messages tab.
    for (let i = 0; i < 3; i += 1) {
      const c = classifyWechatScreen(focus);
      if (c.screenId === "wechat.main.messages") break;
      await op.back();
      await settle(800);
      focus = await op.currentFocus();
      if (focus.package !== WECHAT_PACKAGE) {
        focus = await startWechat(op);
        break;
      }
    }
    await op.tap(TAB_MESSAGES.x, TAB_MESSAGES.y);
    await settle(800);
    focus = await op.currentFocus();
  }
  const classified = classifyWechatScreen(focus);
  const evidence = await captureEvidence(op, evidenceDir, "restore");
  return {
    ok: classified.screenId === "wechat.main.messages" && focus.package === WECHAT_PACKAGE,
    appId: "wechat",
    packageName: WECHAT_PACKAGE,
    focus,
    screenId: classified.screenId,
    evidence,
  };
}

export async function openConversation(_op, { title } = {}) {
  return {
    ok: false,
    appId: "wechat",
    packageName: WECHAT_PACKAGE,
    title: title || null,
    titleMatched: false,
    reason: "slice1_open_requires_ocr",
    evidence: { baselineHeld: false },
  };
}

async function main() {
  const command = resolveOperatorCommand();
  const serial = arg("--serial");
  if (!serial && command !== "help") throw new Error("缺少 --serial <设备序列号>");

  if (command === "help") {
    console.log(`微信 operator（slice1: probe/inspect/restore）

node scripts/wechat-operator.mjs probe --serial <s> --evidence-dir <dir> [--label <l>]
node scripts/wechat-operator.mjs inspect --serial <s> --evidence-dir <dir>
node scripts/wechat-operator.mjs restore --serial <s> --evidence-dir <dir>
node scripts/wechat-operator.mjs open --serial <s> --evidence-dir <dir> --title <t>  # fail-closed until OCR

dump 空壳 → Activity 分类 + 截图 hash；禁发消息/支付。`);
    return;
  }

  const evidenceDir = arg("--evidence-dir");
  if (!evidenceDir) throw new Error("缺少 --evidence-dir");

  const op = await new GatewayOperator({ serial }).start();
  try {
    if (command === "probe") {
      console.log(JSON.stringify(await probe(op, {
        evidenceDir,
        label: arg("--label", "probe"),
      }), null, 2));
      return;
    }
    if (command === "inspect") {
      console.log(JSON.stringify(await inspect(op, { evidenceDir }), null, 2));
      return;
    }
    if (command === "restore") {
      console.log(JSON.stringify(await restore(op, { evidenceDir }), null, 2));
      return;
    }
    if (command === "open") {
      console.log(JSON.stringify(await openConversation(op, { title: arg("--title") }), null, 2));
      return;
    }
    throw new Error(`unknown command: ${command}`);
  } finally {
    try { await op.stop?.(); } catch {}
  }
}

const isDirectRun = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: { message: error?.message || String(error) },
    }));
    process.exit(1);
  });
}
