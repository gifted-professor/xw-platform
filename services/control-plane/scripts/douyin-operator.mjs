#!/usr/bin/env node
/**
 * Douyin control-plane operator.
 * Lease-aware via GatewayOperator (--serial + XHS_OPERATOR_LEASE_*).
 *
 *   node scripts/douyin-operator.mjs --serial <serial> --transport gateway start
 *   node scripts/douyin-operator.mjs --serial <serial> --transport gateway snapshot
 *   node scripts/douyin-operator.mjs --serial <serial> --transport gateway search --keyword <词>
 *   node scripts/douyin-operator.mjs --serial <serial> --transport gateway like-dry-run
 *   node scripts/douyin-operator.mjs --serial <serial> --transport gateway collect-dry-run
 *   node scripts/douyin-operator.mjs --serial <serial> --transport gateway follow-dry-run
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { GatewayOperator } from "./gateway-operator.mjs";

const DOUYIN_PACKAGE = "com.ss.android.ugc.aweme";
const OPERATOR_COMMANDS = new Set([
  "help", "start", "snapshot", "search", "like-dry-run", "collect-dry-run", "follow-dry-run",
]);
const SETTLE_AFTER_LAUNCH_MS = 5500;
const TAB_NAMES = ["综合", "视频", "用户", "图文", "直播", "团购"];

function arg(name, fallback = null, argv = process.argv) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  return argv[index + 1] ?? fallback;
}

export function resolveOperatorCommand(argv = process.argv) {
  return argv.find((value) => OPERATOR_COMMANDS.has(value)) || "help";
}

function settle(ms) {
  return new Promise((resolveSettle) => setTimeout(resolveSettle, ms));
}

function decodeAttr(value) {
  return String(value || "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function parseBounds(raw) {
  const match = String(raw || "").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}

function centerOf(bounds) {
  if (!bounds || bounds.length < 4) return null;
  return {
    cx: Math.round((bounds[0] + bounds[2]) / 2),
    cy: Math.round((bounds[1] + bounds[3]) / 2),
    w: bounds[2] - bounds[0],
    h: bounds[3] - bounds[1],
  };
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
      text: decodeAttr(attrs.text),
      contentDesc: decodeAttr(attrs["content-desc"]),
      className: attrs.class || "",
      resourceId: attrs["resource-id"] || "",
      bounds: parseBounds(attrs.bounds),
      clickable: attrs.clickable === "true",
      focused: attrs.focused === "true",
    });
  }
  return { nodes };
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

export function findSearchEntry(nodes) {
  const hit = (nodes || []).find((node) => {
    const label = `${node.text || ""}${node.contentDesc || ""}`;
    const c = centerOf(node.bounds);
    return c && /搜索/.test(label) && c.cy < 250;
  });
  if (hit) {
    const c = centerOf(hit.bounds);
    return { cx: c.cx, cy: c.cy, matched: hit.text || hit.contentDesc };
  }
  return { cx: 1009, cy: 145, matched: "fallback-top-right" };
}

export function findSearchInput(nodes) {
  const hit = (nodes || []).find((node) => {
    const cls = String(node.className || "");
    const c = centerOf(node.bounds);
    return c && /EditText|AutoCompleteTextView/.test(cls) && c.cy < 250;
  });
  if (hit) {
    const c = centerOf(hit.bounds);
    return { cx: c.cx, cy: c.cy, matched: "edittext" };
  }
  return { cx: 521, cy: 144, matched: "fallback-edittext" };
}

export function extractTabs(nodes) {
  const tabs = (nodes || [])
    .filter((node) => TAB_NAMES.includes(node.text) && centerOf(node.bounds)?.cy < 350)
    .map((node) => ({ text: node.text, ...centerOf(node.bounds) }))
    .sort((a, b) => a.cx - b.cx);
  const seen = new Set();
  const ordered = [];
  for (const tab of tabs) {
    if (!seen.has(tab.text)) {
      seen.add(tab.text);
      ordered.push(tab);
    }
  }
  return ordered;
}

export function countCards(nodes) {
  return (nodes || []).filter((node) => {
    const c = centerOf(node.bounds);
    return node.clickable && c && c.w >= 400 && c.h >= 120 && c.cy > 240 && c.cy < 2200;
  }).length;
}

function pickTallestRail(hits) {
  hits.sort((a, b) => {
    const ha = centerOf(a.bounds)?.h || 0;
    const hb = centerOf(b.bounds)?.h || 0;
    const ca = centerOf(a.bounds);
    const cb = centerOf(b.bounds);
    return (hb - ha) || ((ca?.cy || 0) - (cb?.cy || 0));
  });
  const hit = hits[0];
  if (!hit) return null;
  const c = centerOf(hit.bounds);
  return { cx: c.cx, cy: c.cy, desc: hit.contentDesc || hit.text || "", text: hit.text || "", bounds: hit.bounds };
}

export function findLikeBtn(nodes) {
  const hits = (nodes || []).filter((node) => {
    const desc = String(node.contentDesc || "");
    const c = centerOf(node.bounds);
    return /喜欢/.test(desc) && /按钮/.test(desc) && c && c.cx > 850 && c.cy > 400 && c.cy < 2000;
  });
  return pickTallestRail(hits);
}

export function findCollectBtn(nodes) {
  const hits = (nodes || []).filter((node) => {
    const desc = String(node.contentDesc || "");
    const c = centerOf(node.bounds);
    return /收藏/.test(desc) && /按钮/.test(desc) && c && c.cx > 850 && c.cy > 400 && c.cy < 2100;
  });
  return pickTallestRail(hits);
}

export function findFollowBtn(nodes) {
  const hits = (nodes || []).filter((node) => {
    const desc = String(node.contentDesc || "");
    const text = String(node.text || "");
    const c = centerOf(node.bounds);
    if (!c || c.cx <= 850 || c.cy <= 400 || c.cy >= 2100) return false;
    if (desc === "关注") return true;
    if (/^关注$/.test(text) && c.cy > 800) return true;
    return /关注/.test(desc) && c.cy > 800;
  });
  hits.sort((a, b) => (centerOf(a.bounds)?.cy || 0) - (centerOf(b.bounds)?.cy || 0));
  const hit = hits[0];
  if (!hit) return null;
  const c = centerOf(hit.bounds);
  return { cx: c.cx, cy: c.cy, desc: hit.contentDesc || hit.text || "", text: hit.text || "", bounds: hit.bounds };
}

export function likeStateFromDesc(desc) {
  const d = String(desc || "");
  if (/已点赞/.test(d)) return "liked";
  if (/未点赞/.test(d)) return "unliked";
  if (/喜欢/.test(d)) return "unknown";
  return "missing";
}

export function collectStateFromDesc(desc) {
  const d = String(desc || "");
  if (/已选中/.test(d)) return "collected";
  if (/未选中/.test(d)) return "uncollected";
  if (/收藏/.test(d)) return "unknown";
  return "missing";
}

export function followStateFromDesc(desc) {
  const d = String(desc || "");
  if (/已关注|互相关注/.test(d)) return "followed";
  if (/关注/.test(d)) return "unfollowed";
  return "missing";
}

async function douyinDump(op, label) {
  const startedAt = Date.now();
  const xml = await op.dumpXml(label);
  const start = xml.indexOf("<hierarchy");
  const end = xml.indexOf("</hierarchy>", start);
  if (start < 0 || end < 0) throw new Error("douyin hierarchy dump incomplete (gateway)");
  const doc = parseAllUiNodes(xml.slice(start, end + "</hierarchy>".length));
  doc._dumpMs = Date.now() - startedAt;
  doc._label = label;
  return doc;
}

async function dumpWithRetry(op, label, { attempts = 4, accept = () => true } = {}) {
  let doc = null;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (attempt > 0) await settle(1500 + attempt * 500);
      doc = await douyinDump(op, `${label}-${attempt}`);
      if ((doc.nodes || []).length > 0 && accept(doc)) return doc;
    } catch (error) {
      lastError = error;
    }
  }
  if (doc) return doc;
  throw lastError || new Error(`douyin dump failed: ${label}`);
}

export async function startDouyin(op) {
  await op.shellExec(`am force-stop ${DOUYIN_PACKAGE}`, 8000);
  await op.shellExec(
    `monkey -p ${DOUYIN_PACKAGE} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1`,
    15000,
  );
  let focus = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await settle(attempt === 0 ? SETTLE_AFTER_LAUNCH_MS : 800);
    focus = await op.currentFocus();
    if (focus.package === DOUYIN_PACKAGE) return focus;
  }
  return focus || { package: null, activity: null, raw: "" };
}

export async function snapshot(op, label = "douyin-snapshot", { launchIfNeeded = true } = {}) {
  let focus = await op.currentFocus();
  if (launchIfNeeded && focus.package !== DOUYIN_PACKAGE) {
    focus = await startDouyin(op);
  }
  await settle(500);
  const doc = await dumpWithRetry(op, label);
  focus = await op.currentFocus();
  const nodes = semanticSnapshot(doc);
  return {
    ok: focus.package === DOUYIN_PACKAGE,
    appId: "douyin",
    packageName: DOUYIN_PACKAGE,
    focus,
    dumpMs: doc._dumpMs,
    nodeCount: nodes.length,
    nodes,
  };
}

export async function search(op, keyword) {
  const text = String(keyword || "").trim();
  if (!text) throw new Error("search requires --keyword");

  let focus = await startDouyin(op);
  const homeDoc = await dumpWithRetry(op, "douyin-search-home");
  const entry = findSearchEntry(homeDoc.nodes);
  await op.tap(entry.cx, entry.cy);
  await settle(2200);

  const suggestDoc = await dumpWithRetry(op, "douyin-search-suggest");
  const input = findSearchInput(suggestDoc.nodes);
  await op.tap(input.cx, input.cy);
  await settle(400);
  await op.inputTextViaXiaowei(text, {
    clearFirst: true,
    refocus: async () => {
      await op.tap(input.cx, input.cy);
    },
  });
  await op.shellExec("input keyevent KEYCODE_ENTER", 6000);
  await settle(3800);

  focus = await op.currentFocus();
  const onResult = /SearchResultActivity/i.test(focus.activity || focus.raw || "");
  if (!onResult) {
    return {
      ok: false,
      appId: "douyin",
      packageName: DOUYIN_PACKAGE,
      keyword: text,
      focus,
      searchEntry: entry,
      inputXy: input,
      reason: "not_search_result",
      tabs: [],
      tabCount: 0,
      cardCount: 0,
      backHome: false,
      stoppedBeforeOpen: true,
    };
  }

  const resultDoc = await dumpWithRetry(op, "douyin-search-result");
  const tabs = extractTabs(resultDoc.nodes);
  const cardCount = countCards(resultDoc.nodes);
  const tabNames = tabs.map((tab) => tab.text);

  let backHome = false;
  for (let i = 0; i < 3; i += 1) {
    await op.back();
    await settle(1200);
    focus = await op.currentFocus();
    if (/SplashActivity/i.test(focus.activity || focus.raw || "")) {
      backHome = true;
      break;
    }
  }
  focus = await op.currentFocus();

  return {
    ok: onResult && tabNames.includes("综合") && backHome,
    appId: "douyin",
    packageName: DOUYIN_PACKAGE,
    keyword: text,
    focus,
    searchEntry: entry,
    inputXy: input,
    tabs: tabNames,
    tabCount: tabNames.length,
    cardCount,
    backHome,
    stoppedBeforeOpen: true,
  };
}

async function railDryRun(op, {
  label,
  findBtn,
  stateFromDesc,
  missingReason,
  beforeKey,
  xyKey,
  stateKey,
}) {
  let focus = await startDouyin(op);
  const doc = await dumpWithRetry(op, label, {
    attempts: 5,
    accept: (d) => Boolean(findBtn(d.nodes)),
  });
  focus = await op.currentFocus();
  const btn = findBtn(doc.nodes);
  if (!btn) {
    return {
      ok: false,
      appId: "douyin",
      packageName: DOUYIN_PACKAGE,
      focus,
      reason: missingReason,
      [stateKey]: "missing",
      locatedNotTapped: true,
      dryRun: true,
    };
  }
  const state = stateFromDesc(btn.desc || btn.text);
  return {
    ok: focus.package === DOUYIN_PACKAGE && Boolean(btn.cx) && state !== "missing",
    appId: "douyin",
    packageName: DOUYIN_PACKAGE,
    focus,
    [beforeKey]: btn.desc || btn.text,
    [xyKey]: { x: btn.cx, y: btn.cy },
    [stateKey]: state,
    reason: "located-not-tapped",
    locatedNotTapped: true,
    dryRun: true,
  };
}

export async function likeDryRun(op) {
  return railDryRun(op, {
    label: "douyin-like-feed",
    findBtn: findLikeBtn,
    stateFromDesc: likeStateFromDesc,
    missingReason: "like_btn_missing",
    beforeKey: "likeBefore",
    xyKey: "likeXy",
    stateKey: "likeState",
  });
}

export async function collectDryRun(op) {
  return railDryRun(op, {
    label: "douyin-collect-feed",
    findBtn: findCollectBtn,
    stateFromDesc: collectStateFromDesc,
    missingReason: "collect_btn_missing",
    beforeKey: "collectBefore",
    xyKey: "collectXy",
    stateKey: "collectState",
  });
}

export async function followDryRun(op) {
  return railDryRun(op, {
    label: "douyin-follow-feed",
    findBtn: findFollowBtn,
    stateFromDesc: followStateFromDesc,
    missingReason: "follow_btn_missing",
    beforeKey: "followBefore",
    xyKey: "followXy",
    stateKey: "followState",
  });
}

async function main() {
  const command = resolveOperatorCommand();
  const serial = arg("--serial");
  if (!serial && command !== "help") throw new Error("缺少 --serial <设备序列号>");

  if (command === "help") {
    console.log(`抖音 operator

node scripts/douyin-operator.mjs --serial <serial> --transport gateway start
node scripts/douyin-operator.mjs --serial <serial> --transport gateway snapshot
node scripts/douyin-operator.mjs --serial <serial> --transport gateway search --keyword <词>
node scripts/douyin-operator.mjs --serial <serial> --transport gateway like-dry-run
node scripts/douyin-operator.mjs --serial <serial> --transport gateway collect-dry-run
node scripts/douyin-operator.mjs --serial <serial> --transport gateway follow-dry-run

传输：默认 gateway（绿箭 22222 + lease）。`);
    return;
  }

  const transport = arg("--transport", "gateway") === "adb" ? "adb" : "gateway";
  if (transport !== "gateway") {
    throw new Error("douyin-operator only supports --transport gateway");
  }

  const op = await new GatewayOperator({ serial }).start();
  try {
    if (command === "start") {
      console.log(JSON.stringify({ ok: true, focus: await startDouyin(op) }, null, 2));
      return;
    }
    if (command === "snapshot") {
      console.log(JSON.stringify(await snapshot(op, "douyin-snapshot"), null, 2));
      return;
    }
    if (command === "search") {
      console.log(JSON.stringify(await search(op, arg("--keyword")), null, 2));
      return;
    }
    if (command === "like-dry-run") {
      console.log(JSON.stringify(await likeDryRun(op), null, 2));
      return;
    }
    if (command === "collect-dry-run") {
      console.log(JSON.stringify(await collectDryRun(op), null, 2));
      return;
    }
    if (command === "follow-dry-run") {
      console.log(JSON.stringify(await followDryRun(op), null, 2));
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
