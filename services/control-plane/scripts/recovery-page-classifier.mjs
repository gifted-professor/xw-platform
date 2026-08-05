import { classifyXianyuPage } from "./xianyu-page-classifier.mjs";

const MIUI_HOME_PACKAGE = "com.miui.home";
const MIUI_HOME_ACTIVITY = "com.miui.home.launcher.Launcher";
const DOUYIN_PACKAGE = "com.ss.android.ugc.aweme";

const LAUNCHER_LABELS = new Set([
  "设置",
  "相册",
  "日历",
  "电话",
  "相机",
  "浏览器",
  "应用商店",
  "高德地图",
  "计算器",
  "微信输入法",
  "短信",
  "联系人",
  "天气",
  "文件管理",
  "时钟",
  "主题壁纸",
  "安全中心",
  "小米商城",
  "游戏中心",
  "手机管家",
  "米家",
  "哔哩哔哩",
  "QQ",
  "飞书",
  "抖音",
  "微信",
  "小红书",
  "支付宝",
  "闲鱼",
  "微购相册",
]);
const LAUNCHER_SYSTEM_LABELS = new Set([
  "设置",
  "相册",
  "日历",
  "应用商店",
  "计算器",
  "文件管理",
  "时钟",
  "主题壁纸",
  "安全中心",
]);
const LAUNCHER_PAGE_INDICATOR = "桌面分页指示器";
const LAUNCHER_DOCK = "桌面底栏";
const LAUNCHER_SEARCH = "桌面搜索栏";
const UNSAFE_CONTENT_PATTERN = /验证码|安全验证|支付密码|确认支付|青少年模式|继续访问|同意并继续/;
const UNSAFE_ACTION_PATTERN = /^(?:立即)?登录|^(?:允许|拒绝|取消|确定|稍后|我知道了)(?:$|\s|访问|使用|一次|本次)|(?:权限|删除|发布|保存)(?:$|[：:])/;

function cleanLabel(value) {
  return String(value || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeVisualEntries(elements = []) {
  return (elements || [])
    .map((value) => ({
      label: cleanLabel(value?.label),
      bounds: Array.isArray(value?.bounds) && value.bounds.length === 4
        ? value.bounds.map(Number)
        : null,
    }))
    .filter((entry) => entry.label && entry.bounds?.every(Number.isFinite));
}

function labelsOf(entries) {
  return [...new Set(entries.map((entry) => entry.label))].slice(0, 24);
}

function result(pageType, confidence, matches, reasons, visualCount) {
  return {
    schemaVersion: 1,
    pageType,
    confidence: Number(confidence.toFixed(3)),
    safeStateVerified: pageType === "main-safe" && confidence >= 0.9,
    matchedLabels: labelsOf(matches),
    reasons,
    sources: { visual: visualCount, semantic: 0 },
  };
}

function isExactMiuiLauncher(focus) {
  return focus?.package === MIUI_HOME_PACKAGE && focus?.activity === MIUI_HOME_ACTIVITY;
}

function isDouyinMainFocus(focus) {
  return focus?.package === DOUYIN_PACKAGE
    && /(?:^|\.)SplashActivity$/.test(String(focus?.activity || ""));
}

function isUnsafeVisualLabel(label) {
  return UNSAFE_CONTENT_PATTERN.test(label) || UNSAFE_ACTION_PATTERN.test(label);
}

export function classifyRecoveryPage({
  elements = [],
  semanticNodes = [],
  focus = null,
  resolution = null,
} = {}) {
  // Keep all existing Xianyu classifications, including unsafe intermediate pages.
  const xianyu = classifyXianyuPage({ elements, semanticNodes, focus, resolution });
  if (xianyu.pageType !== "unknown") return xianyu;

  const entries = normalizeVisualEntries(elements);
  const width = Array.isArray(resolution) && Number(resolution[0]) > 0
    ? Number(resolution[0])
    : 1080;
  const height = Array.isArray(resolution) && Number(resolution[1]) > 0
    ? Number(resolution[1])
    : 2400;
  const unsafe = entries.filter((entry) => isUnsafeVisualLabel(entry.label));
  if (unsafe.length) {
    return result(
      "unknown",
      0,
      unsafe,
      ["a blocking, authentication, permission, or destructive-action marker is visible"],
      entries.length,
    );
  }

  if (isExactMiuiLauncher(focus)) {
    const known = entries.filter((entry) => (
      LAUNCHER_LABELS.has(entry.label)
      && entry.bounds[1] >= height * 0.2
      && entry.bounds[3] <= height * 0.78
    ));
    const distinct = new Set(known.map((entry) => entry.label));
    const hasSystemAnchor = known.some((entry) => LAUNCHER_SYSTEM_LABELS.has(entry.label));
    const pageIndicator = entries.filter((entry) => (
      entry.label === LAUNCHER_PAGE_INDICATOR
      && entry.bounds[1] >= height * 0.68
      && entry.bounds[3] <= height * 0.84
    ));
    const dock = entries.filter((entry) => (
      entry.label === LAUNCHER_DOCK
      && entry.bounds[1] >= height * 0.76
      && entry.bounds[3] <= height * 0.94
      && entry.bounds[2] - entry.bounds[0] >= width * 0.72
    ));
    const search = entries.filter((entry) => (
      entry.label === LAUNCHER_SEARCH
      && entry.bounds[1] >= height * 0.86
      && entry.bounds[3] <= height * 0.99
      && entry.bounds[2] - entry.bounds[0] >= width * 0.72
    ));
    const launcherChrome = [...pageIndicator, ...dock, ...search];
    const hasLauncherChrome = pageIndicator.length > 0 && dock.length > 0 && search.length > 0;
    const columnBands = new Set(known.map((entry) => Math.min(3, Math.floor(
      ((entry.bounds[0] + entry.bounds[2]) / 2) / (width / 4),
    ))));
    const rowBands = new Set(known.map((entry) => Math.floor(
      ((entry.bounds[1] + entry.bounds[3]) / 2) / (height / 5),
    )));
    if (distinct.size >= 6 && (hasSystemAnchor || hasLauncherChrome)
      && columnBands.size >= 3 && rowBands.size >= 2) {
      return result(
        "main-safe",
        0.99,
        [...known, ...launcherChrome],
        [hasSystemAnchor
          ? "exact MIUI launcher focus and a system-app anchored launcher grid agree"
          : "exact MIUI launcher focus, a launcher grid, and complete launcher chrome agree"],
        entries.length,
      );
    }
    return result(
      "unknown",
      0,
      [...known, ...launcherChrome],
      ["MIUI launcher focus lacks a system-app anchor or the complete launcher chrome fingerprint"],
      entries.length,
    );
  }

  if (isDouyinMainFocus(focus)) {
    const inBottomBar = (entry) => entry.bounds[1] >= height * 0.8;
    const bottom = entries.filter((entry) => /^(首页|朋友|消息|我|我的)$/.test(entry.label) && inBottomBar(entry));
    const labels = new Set(bottom.map((entry) => entry.label));
    const hasHome = labels.has("首页");
    const hasMine = labels.has("我") || labels.has("我的");
    if (hasHome && hasMine && labels.size >= 3) {
      return result(
        "main-safe",
        0.98,
        bottom,
        ["exact Douyin main focus and at least three bottom-navigation anchors agree"],
        entries.length,
      );
    }
    return result(
      "unknown",
      0,
      bottom,
      ["Douyin main focus lacks the required visual bottom-navigation fingerprint"],
      entries.length,
    );
  }

  return result(
    "unknown",
    0,
    entries.slice(0, 12),
    ["no app-specific recovery fingerprint reached the fail-closed threshold"],
    entries.length,
  );
}
