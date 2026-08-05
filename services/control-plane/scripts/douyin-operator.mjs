#!/usr/bin/env node
/**
 * Douyin control-plane operator.
 * Lease-aware via GatewayOperator (--serial + XHS_OPERATOR_LEASE_*).
 *
 *   node scripts/douyin-operator.mjs --serial <serial> --transport gateway start
 *   node scripts/douyin-operator.mjs --serial <serial> --transport gateway snapshot
 *   node scripts/douyin-operator.mjs --serial <serial> --transport gateway search --keyword <词>
 *   node scripts/douyin-operator.mjs --serial <serial> --transport gateway share-link --keyword <词>
 *   node scripts/douyin-operator.mjs --serial <serial> --transport gateway like-dry-run
 *   node scripts/douyin-operator.mjs --serial <serial> --transport gateway collect-dry-run
 *   node scripts/douyin-operator.mjs --serial <serial> --transport gateway follow-dry-run
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { GatewayOperator } from "./gateway-operator.mjs";

const DOUYIN_PACKAGE = "com.ss.android.ugc.aweme";
const OPERATOR_COMMANDS = new Set([
  "help", "start", "snapshot", "search", "share-link", "share-link-restore",
  "like-dry-run", "collect-dry-run", "follow-dry-run",
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

function publicLocator(node, matched) {
  const c = centerOf(node?.bounds);
  if (!c) return null;
  return {
    cx: c.cx,
    cy: c.cy,
    bounds: node.bounds,
    matched,
    resourceId: node.resourceId || null,
  };
}

export function createProgressReporter({ evidenceDir, runId = null, jobId = null } = {}) {
  if (!evidenceDir) {
    return {
      path: null,
      step() {},
      heartbeat() {},
      complete() {},
      fail() {},
    };
  }
  const root = resolve(evidenceDir);
  mkdirSync(root, { recursive: true });
  const path = join(root, "progress.jsonl");
  let seq = 0;
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)) {
      try {
        const parsed = JSON.parse(line);
        if (Number.isInteger(parsed?.seq) && parsed.seq > seq) seq = parsed.seq;
      } catch {
        // The stall reader owns validation. Never copy malformed content into an event.
      }
    }
  }
  let currentStep = "start";
  const emit = (event) => {
    seq += 1;
    appendFileSync(path, `${JSON.stringify({
      seq,
      t: new Date().toISOString(),
      ...(runId ? { runId } : {}),
      ...(jobId ? { jobId } : {}),
      ...event,
    })}\n`, "utf8");
  };
  return {
    path,
    step(step, freshness = null) {
      currentStep = step;
      emit({ phase: "step_start", step, ...(freshness ? { freshness } : {}) });
    },
    heartbeat() {
      emit({ phase: "heartbeat", step: currentStep });
    },
    complete(step = "complete") {
      currentStep = step;
      emit({ phase: "complete", step, freshness: "fresh_ui" });
    },
    fail(step = "operator_failed") {
      currentStep = step;
      emit({ phase: "failed", step });
    },
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

export function findImageFilter(nodes) {
  const hits = (nodes || []).filter((node) => {
    const c = centerOf(node.bounds);
    return node.text === "图片"
      && /Button/.test(String(node.className || ""))
      && c
      && c.cy > 250
      && c.cy < 650;
  });
  return hits.length === 1 ? publicLocator(hits[0], "图片") : null;
}

export function findImageCard(nodes) {
  const hits = (nodes || []).filter((node) => {
    const c = centerOf(node.bounds);
    return node.clickable
      && /:id\/qib$/.test(String(node.resourceId || ""))
      && c
      && c.w >= 400
      && c.h >= 300
      && c.cy > 450
      && c.cy < 2200;
  });
  hits.sort((left, right) => {
    const a = centerOf(left.bounds);
    const b = centerOf(right.bounds);
    return (a?.cy || 0) - (b?.cy || 0) || (a?.cx || 0) - (b?.cx || 0);
  });
  return hits[0] ? publicLocator(hits[0], "first-visible-image-card") : null;
}

export function findDetailShareButton(nodes) {
  const hits = (nodes || []).filter((node) => {
    const label = semanticLabel(node);
    const c = centerOf(node.bounds);
    return /^分享.*按钮$/.test(label)
      && node.clickable
      && c
      && c.cx > 850
      && c.cy > 1700;
  });
  return hits.length === 1 ? publicLocator(hits[0], "share-button") : null;
}

export function findShareLinkAction(nodes) {
  const hits = (nodes || []).filter((node) => {
    const c = centerOf(node.bounds);
    return semanticLabel(node).trim() === "分享链接"
      && c
      && c.cy > 1700;
  });
  return hits.length === 1 ? publicLocator(hits[0], "分享链接") : null;
}

export function hasLinkCopiedConfirmation(nodes) {
  return (nodes || []).some((node) => /^链接已复制成功/.test(semanticLabel(node).trim()));
}

export function extractDouyinShareUrl(nodes) {
  const inputLabels = (nodes || [])
    .filter((node) => /EditText|AutoCompleteTextView/.test(String(node.className || "")))
    .map((node) => semanticLabel(node));
  for (const label of inputLabels) {
    const match = String(label).match(/https:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?/);
    if (match) return match[0].endsWith("/") ? match[0] : `${match[0]}/`;
  }
  return null;
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

export async function startDouyin(op, { forceStop = true } = {}) {
  if (forceStop) {
    await op.shellExec(`am force-stop ${DOUYIN_PACKAGE}`, 8000);
    await settle(800);
  }
  // Keep launches as separate plain shell commands (gateway adb_shell is not a full
  // interactive shell; `||` / redirects have been unreliable on alias 01).
  let launchOut = await op.shellExec(
    `am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p ${DOUYIN_PACKAGE}`,
    15000,
  ).catch((error) => String(error?.message || error));
  const amLooksBad = /Error|Exception|not found|does not exist|SecurityException/i.test(String(launchOut || ""))
    || !/Starting|cmp=/i.test(String(launchOut || ""));
  if (amLooksBad) {
    launchOut = await op.shellExec(
      `monkey -p ${DOUYIN_PACKAGE} -c android.intent.category.LAUNCHER 1`,
      15000,
    ).catch((error) => String(error?.message || error));
  }
  let focus = null;
  const attempts = forceStop ? 16 : 10;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await settle(attempt === 0 ? (forceStop ? SETTLE_AFTER_LAUNCH_MS : 2500) : 900);
    focus = await op.currentFocus();
    if (focus.package === DOUYIN_PACKAGE) {
      if (attempt >= 1) {
        await op.shellExec("input tap 540 1200", 5000).catch(() => null);
        await settle(800);
      }
      return focus;
    }
  }
  return focus || { package: null, activity: null, raw: String(launchOut || "").slice(0, 160) };
}

/** Prefer soft bring-to-foreground; only force-stop if Douyin is not running. */
export async function ensureDouyinForeground(op) {
  let focus = await op.currentFocus();
  if (focus.package === DOUYIN_PACKAGE) return focus;
  focus = await startDouyin(op, { forceStop: false });
  if (focus.package === DOUYIN_PACKAGE) return focus;
  return startDouyin(op, { forceStop: true });
}

export async function snapshot(op, label = "douyin-snapshot", { launchIfNeeded = true } = {}) {
  let focus = await op.currentFocus();
  if (launchIfNeeded && focus.package !== DOUYIN_PACKAGE) {
    focus = await ensureDouyinForeground(op);
  }
  if (focus.package !== DOUYIN_PACKAGE) {
    throw new Error(
      `douyin not foreground after launch (pkg=${focus.package || "null"} act=${focus.activity || "null"})`,
    );
  }
  await settle(500);
  const doc = await dumpWithRetry(op, label, { attempts: 3 });
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

  let focus = await ensureDouyinForeground(op);
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

function requireSemanticLocator(locator, code) {
  if (!locator || String(locator.matched || "").startsWith("fallback")) {
    throw new Error(code);
  }
  return locator;
}

function focusMatches(focus, activityPattern) {
  return focus?.package === DOUYIN_PACKAGE
    && activityPattern.test(String(focus?.activity || focus?.raw || ""));
}

async function returnToSearchResult(op, wait, maxBacks = 5) {
  let focus = await op.currentFocus();
  for (let backCount = 0; backCount <= maxBacks; backCount += 1) {
    if (focusMatches(focus, /SearchResultActivity/i)) return { focus, backCount };
    if (focus?.package !== DOUYIN_PACKAGE) {
      throw new Error("douyin_share_restore_left_package");
    }
    if (backCount === maxBacks) break;
    await op.back();
    await wait(1100);
    focus = await op.currentFocus();
  }
  throw new Error("douyin_share_search_result_not_restored");
}

export async function shareLink(op, keyword, { wait = settle, progress = () => {} } = {}) {
  const text = String(keyword || "").trim();
  if (!text) throw new Error("share-link requires --keyword");

  progress("launch");
  let focus = await ensureDouyinForeground(op);
  if (focus?.package !== DOUYIN_PACKAGE) throw new Error("douyin_share_not_foreground");

  const homeDoc = await dumpWithRetry(op, "douyin-share-home", {
    attempts: 4,
    accept: (doc) => !String(findSearchEntry(doc.nodes)?.matched || "").startsWith("fallback"),
  });
  progress("home_observed", "fresh_ui");
  const entry = requireSemanticLocator(findSearchEntry(homeDoc.nodes), "douyin_share_search_entry_missing");
  await op.tap(entry.cx, entry.cy, "douyin search entry");
  await wait(1800);

  const suggestDoc = await dumpWithRetry(op, "douyin-share-suggest", {
    attempts: 4,
    accept: (doc) => !String(findSearchInput(doc.nodes)?.matched || "").startsWith("fallback"),
  });
  const input = requireSemanticLocator(findSearchInput(suggestDoc.nodes), "douyin_share_search_input_missing");
  await op.tap(input.cx, input.cy, "douyin search input");
  await wait(300);
  await op.inputTextViaXiaowei(text, {
    clearFirst: true,
    refocus: async () => op.tap(input.cx, input.cy, "douyin search input refocus"),
  });
  await op.shellExec("input keyevent KEYCODE_ENTER", 6000);
  await wait(3200);

  focus = await op.currentFocus();
  if (!focusMatches(focus, /SearchResultActivity/i)) throw new Error("douyin_share_not_search_result");
  const resultDoc = await dumpWithRetry(op, "douyin-share-result", {
    attempts: 4,
    accept: (doc) => Boolean(findImageFilter(doc.nodes)),
  });
  progress("search_result_observed", "fresh_ui");
  const imageFilter = requireSemanticLocator(
    findImageFilter(resultDoc.nodes),
    "douyin_share_image_filter_missing_or_ambiguous",
  );
  await op.tap(imageFilter.cx, imageFilter.cy, "douyin image filter");
  await wait(1800);

  const imageDoc = await dumpWithRetry(op, "douyin-share-image-results", {
    attempts: 5,
    accept: (doc) => Boolean(findImageCard(doc.nodes)),
  });
  progress("image_results_observed", "fresh_ui");
  const selectedCard = requireSemanticLocator(findImageCard(imageDoc.nodes), "douyin_share_image_card_missing");
  await op.tap(selectedCard.cx, selectedCard.cy, "douyin first visible image card");
  await wait(2500);

  focus = await op.currentFocus();
  if (!focusMatches(focus, /FlowPageActivity/i)) throw new Error("douyin_share_not_flow_page");
  const detailDoc = await dumpWithRetry(op, "douyin-share-detail", {
    attempts: 5,
    accept: (doc) => Boolean(findDetailShareButton(doc.nodes)),
  });
  progress("detail_observed", "fresh_ui");
  const shareButton = requireSemanticLocator(
    findDetailShareButton(detailDoc.nodes),
    "douyin_share_button_missing_or_ambiguous",
  );
  await op.tap(shareButton.cx, shareButton.cy, "douyin detail share button");
  await wait(1200);

  const shareDoc = await dumpWithRetry(op, "douyin-share-panel", {
    attempts: 5,
    accept: (doc) => Boolean(findShareLinkAction(doc.nodes)),
  });
  progress("share_panel_observed", "fresh_ui");
  const shareLinkAction = requireSemanticLocator(
    findShareLinkAction(shareDoc.nodes),
    "douyin_share_link_action_missing_or_ambiguous",
  );
  await op.tap(shareLinkAction.cx, shareLinkAction.cy, "douyin copy share link");
  await wait(1200);

  const copiedDoc = await dumpWithRetry(op, "douyin-share-copied", {
    attempts: 4,
    accept: (doc) => hasLinkCopiedConfirmation(doc.nodes),
  });
  const copied = hasLinkCopiedConfirmation(copiedDoc.nodes);
  if (!copied) throw new Error("douyin_share_copy_confirmation_missing");
  progress("link_copied", "fresh_ui");

  const returned = await returnToSearchResult(op, wait);
  focus = returned.focus;
  const returnedDoc = await dumpWithRetry(op, "douyin-share-returned-result", {
    attempts: 4,
    accept: (doc) => !String(findSearchInput(doc.nodes)?.matched || "").startsWith("fallback"),
  });
  const returnedInput = requireSemanticLocator(
    findSearchInput(returnedDoc.nodes),
    "douyin_share_returned_input_missing",
  );
  await op.tap(returnedInput.cx, returnedInput.cy, "douyin search input for clipboard read");
  await wait(250);
  await op.inputTextViaXiaowei(".", {
    clearFirst: true,
    refocus: async () => op.tap(returnedInput.cx, returnedInput.cy, "douyin clipboard input refocus"),
  });
  await op.shellExec("input keyevent KEYCODE_DEL", 5000);
  await op.shellExec("input keyevent KEYCODE_PASTE", 5000);
  await wait(900);

  const pastedDoc = await dumpWithRetry(op, "douyin-share-pasted", {
    attempts: 4,
    accept: (doc) => Boolean(extractDouyinShareUrl(doc.nodes)),
  });
  const url = extractDouyinShareUrl(pastedDoc.nodes);
  if (!url) throw new Error("douyin_share_url_not_found_in_search_input");
  progress("share_url_observed", "fresh_ui");

  await op.inputTextViaXiaowei(text, {
    clearFirst: true,
    refocus: async () => op.tap(returnedInput.cx, returnedInput.cy, "douyin search input restore"),
  });
  await op.shellExec("input keyevent KEYCODE_ENTER", 6000);
  await wait(2800);
  focus = await op.currentFocus();
  const restoredDoc = await dumpWithRetry(op, "douyin-share-keyword-restored", {
    attempts: 4,
    accept: (doc) => (doc.nodes || []).some((node) => (
      /EditText|AutoCompleteTextView/.test(String(node.className || ""))
      && semanticLabel(node).trim() === text
    )),
  });
  const searchRestored = focusMatches(focus, /SearchResultActivity/i)
    && restoredDoc.nodes.some((node) => (
      /EditText|AutoCompleteTextView/.test(String(node.className || ""))
      && semanticLabel(node).trim() === text
    ));
  if (!searchRestored) throw new Error("douyin_share_keyword_restore_failed");

  let backHome = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await op.back();
    await wait(1000);
    focus = await op.currentFocus();
    if (focusMatches(focus, /SplashActivity/i)) {
      backHome = true;
      break;
    }
  }
  if (!backHome) throw new Error("douyin_share_splash_restore_failed");
  progress("search_and_splash_restored", "fresh_ui");

  return {
    ok: true,
    step: "share-link-copied",
    verified: true,
    verifyMethod: "copy-confirmation+ui-paste",
    appId: "douyin",
    packageName: DOUYIN_PACKAGE,
    keyword: text,
    text: url,
    url,
    focus,
    imageFilter,
    selectedCard,
    shareButton,
    shareLinkAction,
    copied: true,
    openedDetail: true,
    searchRestored: true,
    backHome: true,
    stoppedBeforeExternalShare: true,
    externalShareTriggered: false,
    observedAt: new Date().toISOString(),
  };
}

function isSystemHomeFocus(focus) {
  return /com\.miui\.home|launcher/i.test(
    `${focus?.package || ""} ${focus?.activity || ""} ${focus?.raw || ""}`,
  );
}

function hasExactSearchInput(nodes, keyword) {
  return (nodes || []).some((node) => (
    /EditText|AutoCompleteTextView/.test(String(node.className || ""))
    && semanticLabel(node).trim() === keyword
  ));
}

async function restoreSearchKeyword(op, keyword, wait) {
  const text = String(keyword || "").trim();
  if (!text) return { ok: false, changed: false };
  const before = await dumpWithRetry(op, "douyin-share-restore-keyword-before", {
    attempts: 3,
    accept: (doc) => !String(findSearchInput(doc.nodes)?.matched || "").startsWith("fallback"),
  });
  if (hasExactSearchInput(before.nodes, text)) return { ok: true, changed: false };
  const input = requireSemanticLocator(
    findSearchInput(before.nodes),
    "douyin_share_restore_input_missing",
  );
  await op.tap(input.cx, input.cy, "douyin restore original search keyword");
  await wait(250);
  await op.inputTextViaXiaowei(text, {
    clearFirst: true,
    refocus: async () => op.tap(input.cx, input.cy, "douyin restore keyword refocus"),
  });
  await op.shellExec("input keyevent KEYCODE_ENTER", 6000);
  await wait(2200);
  const focus = await op.currentFocus();
  if (!focusMatches(focus, /SearchResultActivity/i)) return { ok: false, changed: true };
  const after = await dumpWithRetry(op, "douyin-share-restore-keyword-after", {
    attempts: 3,
    accept: (doc) => hasExactSearchInput(doc.nodes, text),
  });
  return { ok: hasExactSearchInput(after.nodes, text), changed: true };
}

export async function restoreShareLink(op, { keyword = null, wait = settle, maxBacks = 6 } = {}) {
  let focus = await op.currentFocus();
  let searchResultEncountered = false;
  let keywordRestored = null;
  for (let backCount = 0; backCount <= maxBacks; backCount += 1) {
    if (focusMatches(focus, /SplashActivity/i)) {
      const ok = keywordRestored !== false;
      return {
        ok,
        step: ok ? "douyin-splash-restored" : "keyword-restore-failed",
        safeStateVerified: ok,
        backCount,
        searchResultEncountered,
        keywordRestored,
        focus,
      };
    }
    if (focus?.package !== DOUYIN_PACKAGE) break;
    if (backCount === maxBacks) break;
    if (focusMatches(focus, /SearchResultActivity/i)) {
      searchResultEncountered = true;
      const restored = await restoreSearchKeyword(op, keyword, wait).catch(() => ({ ok: false }));
      keywordRestored = restored.ok === true;
      if (!keywordRestored) break;
    }
    await op.back();
    await wait(900);
    focus = await op.currentFocus();
  }
  await op.home();
  await wait(1000);
  focus = await op.currentFocus();
  const safeStateVerified = isSystemHomeFocus(focus) && keywordRestored !== false;
  return {
    ok: safeStateVerified,
    step: safeStateVerified ? "system-home-restored" : "safe-state-not-verified",
    safeStateVerified,
    searchResultEncountered,
    keywordRestored,
    focus,
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
node scripts/douyin-operator.mjs --serial <serial> --transport gateway share-link --keyword <词>
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

  const progressEnabled = command === "share-link" || command === "share-link-restore";
  const reporter = createProgressReporter({
    evidenceDir: progressEnabled ? arg("--evidence-dir") : null,
    runId: arg("--run-id"),
    jobId: arg("--job-id"),
  });
  if (progressEnabled) reporter.step("operator_start");
  const heartbeat = progressEnabled ? setInterval(() => reporter.heartbeat(), 30000) : null;
  heartbeat?.unref?.();
  let op = null;
  try {
    op = await new GatewayOperator({ serial }).start();
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
    if (command === "share-link") {
      const result = await shareLink(op, arg("--keyword"), {
        progress: (step, freshness) => reporter.step(step, freshness),
      });
      reporter.complete("share_link_complete");
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (command === "share-link-restore") {
      const result = await restoreShareLink(op, { keyword: arg("--keyword") });
      if (result.ok) reporter.complete("share_link_restore_complete");
      else reporter.fail("share_link_restore_failed");
      console.log(JSON.stringify(result, null, 2));
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
  } catch (error) {
    if (progressEnabled) reporter.fail("operator_failed");
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    try { await op?.stop?.(); } catch {}
  }
}

const isDirectRun = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  main().catch((error) => {
    const payload = JSON.stringify({
      ok: false,
      errorCode: "DOUYIN_OPERATOR_ERROR",
      error: { message: String(error?.message || error).slice(0, 400) },
    });
    // stdout so control-plane command-runner can surface adapterCode/message;
    // stderr kept for local debugging (Windows bridge does not consume this path).
    console.log(payload);
    console.error(payload);
    process.exit(1);
  });
}
