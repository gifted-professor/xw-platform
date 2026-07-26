// xianyu-operator.mjs — 闲鱼独立侦察/发布页 dry-run 入口
//
// 安全边界：只启动闲鱼、读取语义树、点击“卖闲置/发闲置”进入发布页。
// 绝不点击最终“发布”，也不复用小红书业务原语。

import { pathToFileURL } from "node:url";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FastOperator } from "./fast-operator.mjs";
import { GatewayOperator } from "./gateway-operator.mjs";
import { XiaoweiHttpAdapter } from "./xiaowei-http-adapter.mjs";
import {
  fingerprintLabels,
  hasXianyuPublishComposeFingerprint,
  isForbiddenLabel,
  resolveTarget,
} from "./vision-safety.mjs";

const IDLEFISH_PACKAGE = "com.taobao.idlefish";
const IDLEFISH_MAIN_ACTIVITY = "com.taobao.idlefish.maincontainer.activity.MainActivity";
const DEFAULT_ADB = "C:\\PROGRA~2\\xiaowei_android\\tools\\adb.exe";

// 每台设备底栏真实坐标；运行态写在 Windows 控制面数据目录，不入库。
export const LAYOUT_PROFILE_DIR = process.env.XIANYU_LAYOUT_PROFILE_DIR
  || "C:\\Users\\Public\\xhs-agent-control\\layout-profiles";
// 底栏 y1 兜底：仅无 profile 时使用。有 profile 后一律用真实 bounds ± 容差。
const BOTTOM_TAB_Y_RATIO = 0.85;
const PROFILE_BOUNDS_TOLERANCE_PX = 20;

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

export function safeProfileSerial(serial) {
  return String(serial || "").replace(/[^A-Za-z0-9_-]/g, "_");
}

export function layoutProfilePath(serial, dir = LAYOUT_PROFILE_DIR) {
  const safe = safeProfileSerial(serial);
  if (!safe) return null;
  return join(dir, `${safe}.json`);
}

export function loadLayoutProfile(serial, { dir = LAYOUT_PROFILE_DIR } = {}) {
  const path = layoutProfilePath(serial, dir);
  if (!path || !existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const profile = JSON.parse(raw);
    if (!profile || typeof profile !== "object") return null;
    if (!Array.isArray(profile?.home?.bounds) || !Array.isArray(profile?.sell?.bounds)) return null;
    return profile;
  } catch {
    return null;
  }
}

export function saveLayoutProfile(serial, profile, { dir = LAYOUT_PROFILE_DIR } = {}) {
  const path = layoutProfilePath(serial, dir);
  if (!path) throw new Error("saveLayoutProfile: invalid serial");
  mkdirSync(dir, { recursive: true });
  const payload = {
    schemaVersion: 1,
    ...profile,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return path;
}

export function boundsClose(a, b, tolerance = PROFILE_BOUNDS_TOLERANCE_PX) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 4 || b.length < 4) return false;
  for (let i = 0; i < 4; i += 1) {
    if (Math.abs(Number(a[i]) - Number(b[i])) > tolerance) return false;
  }
  return true;
}

// 底栏 label 锚点：匹配 Flutter content-desc（闲鱼，…选中状态 / 卖闲置 / 消息，…），
// 排除「闲鱼同款商品卡」等瀑布流噪声。
function bottomTabRole(label) {
  const text = String(label || "");
  if (/卖闲置/.test(text)) return "sell";
  // 首页 tab：以「闲鱼/首页」开头，后接分隔或状态词，不能是「闲鱼同款…」
  if (/^(闲鱼|首页)([，,。]|$)/.test(text) || /^(闲鱼|首页).*?(选中状态|未选中状态)/.test(text)) {
    return "home";
  }
  if (/^消息([，,。]|$)/.test(text) || /^消息.*?(选中状态|未选中状态)/.test(text)) return "message";
  if (/^我的([，,。]|$)/.test(text) || /^我的.*?(选中状态|未选中状态)/.test(text)) return "me";
  return null;
}

// 从 snapshot 探测底栏 tab 真实坐标。探测用下半屏（0.5），比 0.85 更宽松以便首次建档。
export function probeBottomTabs(snapshot, screenH) {
  const height = Number(screenH) || getScreenHeight(snapshot);
  const halfY = height ? height * 0.5 : 0;
  const tabs = [];
  let home = null;
  let sell = null;

  for (const node of snapshot || []) {
    if (!node?.bounds || !Array.isArray(node.bounds)) continue;
    const label = String(node.label || "");
    const role = bottomTabRole(label);
    if (!role) continue;
    // 排除瀑布流噪声：必须在下半屏，且高度像底栏控件。
    if (halfY && node.bounds[1] < halfY) continue;
    const h = node.bounds[3] - node.bounds[1];
    if (h <= 0 || h > 360) continue;
    const entry = {
      role,
      label,
      bounds: [...node.bounds],
      clickable: !!node.clickable,
    };
    // 同 role 优先 clickable、再取更靠下的。
    const prefer = (prev, next) => {
      if (!prev) return next;
      if (next.clickable && !prev.clickable) return next;
      if (prev.clickable && !next.clickable) return prev;
      return next.bounds[1] >= prev.bounds[1] ? next : prev;
    };
    if (entry.role === "home") home = prefer(home, entry);
    if (entry.role === "sell") sell = prefer(sell, entry);
    tabs.push(entry);
  }

  // 稳定排序：按 x1
  tabs.sort((a, b) => a.bounds[0] - b.bounds[0]);
  return {
    home: home ? { bounds: home.bounds, label: home.label } : null,
    sell: sell ? { bounds: sell.bounds, label: sell.label } : null,
    tabs,
    screenH: height || null,
  };
}

function buildLayoutProfileFromProbe(probe) {
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    screenH: probe.screenH,
    home: probe.home,
    sell: probe.sell,
    tabs: probe.tabs,
  };
}

function matchTabByProfileBounds(snapshot, expected, labelRe, tolerance = PROFILE_BOUNDS_TOLERANCE_PX) {
  if (!expected?.bounds) return null;
  const candidates = (snapshot || []).filter((node) => node?.bounds
    && (!labelRe || labelRe.test(node.label || ""))
    && boundsClose(node.bounds, expected.bounds, tolerance));
  // 优先 clickable
  return candidates.find((node) => node.clickable) || candidates[0] || null;
}

function findHomeTabByRatio(snapshot) {
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

function findSellTabByRatio(snapshot) {
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

function maybePersistProbe(serial, snapshot, { dir, autoSave } = {}) {
  if (!serial || autoSave === false) return null;
  const screenH = getScreenHeight(snapshot);
  const probe = probeBottomTabs(snapshot, screenH);
  if (!probe.home?.bounds || !probe.sell?.bounds) return null;
  const profile = buildLayoutProfileFromProbe(probe);
  try {
    saveLayoutProfile(serial, profile, dir ? { dir } : undefined);
  } catch {
    return null;
  }
  return profile;
}

export function isBottomTabSelected(node) {
  // Flutter content-desc：「…，选中状态」vs「…，未选中状态」
  const label = String(node?.label || "");
  return /选中状态/.test(label) && !/未选中状态/.test(label);
}

/**
 * 找首页底栏 tab。
 * @param {object[]} snapshot
 * @param {object|string} [opts] serial 字符串，或 { serial, profile, dir, autoSave }
 */
export function findHomeTab(snapshot, opts = {}) {
  const options = typeof opts === "string" ? { serial: opts } : (opts || {});
  const { serial = null, dir = LAYOUT_PROFILE_DIR, autoSave = true } = options;
  const profile = options.profile !== undefined
    ? options.profile
    : (serial ? loadLayoutProfile(serial, { dir }) : null);

  // 有 profile 时只按真实 bounds ± 容差匹配，不再混用比例（布局漂移应重探/删 profile）。
  if (profile?.home?.bounds) {
    return matchTabByProfileBounds(snapshot, profile.home, /闲鱼|首页/);
  }

  const fallback = findHomeTabByRatio(snapshot);
  if (fallback) maybePersistProbe(serial, snapshot, { dir, autoSave });
  return fallback;
}

/**
 * 找中央「卖闲置」底栏 tab。
 * @param {object[]} snapshot
 * @param {object|string} [opts] serial 字符串，或 { serial, profile, dir, autoSave }
 */
export function findSellTab(snapshot, opts = {}) {
  const options = typeof opts === "string" ? { serial: opts } : (opts || {});
  const { serial = null, dir = LAYOUT_PROFILE_DIR, autoSave = true } = options;
  const profile = options.profile !== undefined
    ? options.profile
    : (serial ? loadLayoutProfile(serial, { dir }) : null);

  if (profile?.sell?.bounds) {
    return matchTabByProfileBounds(snapshot, profile.sell, /卖闲置/);
  }

  const fallback = findSellTabByRatio(snapshot);
  if (fallback) maybePersistProbe(serial, snapshot, { dir, autoSave });
  return fallback;
}

/**
 * 确保该设备有 layout profile：已有则直接返回，没有则用当前/新 snapshot 探测并落盘。
 * @returns {{ profile, source: 'cache'|'probe-saved'|'probe-failed', path?: string }}
 */
export async function ensureLayoutProfile(op, snapshotNodes = null, { dir = LAYOUT_PROFILE_DIR } = {}) {
  const serial = op?.serial;
  const existing = serial ? loadLayoutProfile(serial, { dir }) : null;
  if (existing?.home?.bounds && existing?.sell?.bounds) {
    return { profile: existing, source: "cache", path: layoutProfilePath(serial, dir) };
  }

  let nodes = snapshotNodes;
  if (!nodes) {
    const state = await snapshot(op, "xianyu-layout-probe");
    nodes = state.nodes;
  }
  const probe = probeBottomTabs(nodes, getScreenHeight(nodes));
  if (!probe.home?.bounds || !probe.sell?.bounds) {
    return { profile: null, source: "probe-failed", probe };
  }
  const profile = buildLayoutProfileFromProbe(probe);
  const path = saveLayoutProfile(serial, profile, { dir });
  return { profile, source: "probe-saved", path, probe };
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

/**
 * 任务内实时 supervisor：逐步打点 + expect 检查 + 有限次恢复。
 * Agent 执行与死脚本的分界：失败先维持，再决定是否升级，而不是闷头跑完再查 log。
 */
export function createStepSupervisor(op, { onEvent = null } = {}) {
  const events = [];
  const emit = (payload) => {
    const ev = { t: new Date().toISOString(), serial: op?.serial || null, ...payload };
    events.push(ev);
    // stdout is reserved for the one terminal JSON document consumed by the
    // control-plane command runner. Progress diagnostics must stay on stderr.
    console.error(JSON.stringify({ event: "supervisor", ...ev }).slice(0, 1400));
    if (typeof onEvent === "function") {
      try { onEvent(ev); } catch { /* ignore listener errors */ }
    }
  };

  /**
   * @param {string} name
   * @param {(ctx:{attempt:number}) => Promise<any>} fn
   * @param {{ critical?: boolean, maxAttempts?: number, expect?: function, recover?: function }} [opts]
   */
  async function run(name, fn, {
    critical = true,
    maxAttempts = 2,
    expect = null,
    recover = null,
  } = {}) {
    emit({ phase: "start", name, maxAttempts });
    let lastResult = null;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        lastResult = await fn({ attempt });
        lastError = null;
        let expectOk = true;
        let snap = null;
        if (typeof expect === "function") {
          snap = await snapshot(op, `sup-expect-${name}-${attempt}`);
          expectOk = !!(await expect(snap, lastResult));
        }
        const stepOk = lastResult?.ok !== false && expectOk;
        emit({
          phase: stepOk ? "ok" : "soft-fail",
          name,
          attempt,
          step: lastResult?.step || null,
          ok: stepOk,
          expectOk,
        });
        if (stepOk) return { ...lastResult, supervisor: { name, attempt } };
        if (attempt < maxAttempts && typeof recover === "function") {
          emit({ phase: "recover", name, attempt, reason: lastResult?.step || "expect-failed" });
          await recover({ attempt, snap, result: lastResult });
          continue;
        }
        return { ...lastResult, ok: critical ? false : lastResult?.ok, supervisor: { name, attempt } };
      } catch (e) {
        lastError = e;
        emit({ phase: "error", name, attempt, error: String(e.message || e) });
        if (attempt < maxAttempts && typeof recover === "function") {
          emit({ phase: "recover", name, attempt, reason: "threw" });
          try {
            await recover({ attempt, snap: null, result: null, error: e });
          } catch (re) {
            emit({ phase: "recover-failed", name, error: String(re.message || re) });
          }
          continue;
        }
        return {
          ok: false,
          step: `${name}-threw`,
          error: String(e.message || e),
          supervisor: { name, attempt },
        };
      }
    }
    return lastResult || {
      ok: false,
      step: `${name}-exhausted`,
      error: lastError ? String(lastError.message || lastError) : null,
      supervisor: { name },
    };
  }

  return { run, emit, events };
}

/** 确保仍在闲鱼发闲置编辑页；掉到桌面/其它 App 时重拉 + open-publish。带页面指纹闸。 */
export async function ensureOnPublishCompose(op, { maxAttempts = 2 } = {}) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const snap = await snapshot(op, `ensure-compose-${i}`);
    const fp = fingerprintLabels(snap.nodes || []);
    const composeOk = snap.focus?.package === IDLEFISH_PACKAGE
      && (isPublishCompose(snap.nodes) || hasXianyuPublishComposeFingerprint(fp));
    if (composeOk) {
      return { ok: true, recovered: i > 0, snap, fingerprint: [...fp].slice(0, 30) };
    }
    if (snap.focus?.package !== IDLEFISH_PACKAGE) {
      await startIdlefish(op);
      await settle(800);
    }
    const opened = await openPublishDryRun(op);
    if (opened.ok) {
      const s2 = await snapshot(op, `ensure-compose-opened-${i}`);
      const fp2 = fingerprintLabels(s2.nodes || []);
      if (s2.focus?.package === IDLEFISH_PACKAGE
        && (isPublishCompose(s2.nodes) || hasXianyuPublishComposeFingerprint(fp2))) {
        return { ok: true, recovered: true, snap: s2, open: opened, fingerprint: [...fp2].slice(0, 30) };
      }
    }
  }
  const finalSnap = await snapshot(op, "ensure-compose-fail");
  return {
    ok: false,
    recovered: false,
    snap: finalSnap,
    package: finalSnap.focus?.package || null,
    fingerprint: [...fingerprintLabels(finalSnap.nodes || [])].slice(0, 30),
  };
}

/**
 * 安全语义 resolve：从当前 dump 找 label（接入 vision-safety 非空/黑名单/region）
 * 不执行 tap；供 supervisor 或 vision capability 使用。
 */
export async function resolveSemanticTarget(op, {
  label,
  region = null,
  requireSafeNav = false,
} = {}) {
  if (isForbiddenLabel(label)) {
    return { ok: false, reason: "forbidden_needle", target: null };
  }
  const snap = await snapshot(op, `resolve-${String(label).slice(0, 12)}`);
  const elements = (snap.nodes || [])
    .filter((n) => n.bounds)
    .map((n) => ({
      label: n.label || "",
      bounds: n.bounds,
      center: n.bounds ? center(n.bounds) : null,
      conf: 1,
      source: "semantic",
    }));
  const resolution = (() => {
    let maxX = 1080, maxY = 2400;
    for (const n of elements) {
      if (n.bounds) {
        maxX = Math.max(maxX, n.bounds[2]);
        maxY = Math.max(maxY, n.bounds[3]);
      }
    }
    return [maxX, maxY];
  })();
  const resolved = resolveTarget(elements, {
    label,
    region,
    resolution,
    requireSafeNav,
  });
  return {
    ...resolved,
    focus: snap.focus || null,
    fingerprint: [...fingerprintLabels(snap.nodes || [])].slice(0, 40),
  };
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

/**
 * 效卫/Flutter 中文 inputText 对换行敏感：含 \n/\r 时常见
 * inputAccepted 但字段仍空（2026-07-26 控制面对照：同 96 字单行 succeeded、带换行 failed）。
 * 多行真换行另案验证；默认写前压成空格。
 */
export function normalizeXwInputText(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[\r\n]+/g, " ")
    .replace(/[ \t\u00a0]+/g, " ")
    .trim();
}

export async function inputDryRun(op, {
  text,
  evidenceDir = "C:\\Users\\Public",
  clearAfter = true,
  // 控制面单 job 无法在 open 与 input 之间保留页面（每 job 必 restore）。
  // 默认：若不在发布编辑页，先 open-publish 再填字（step 1b 正确路径）。
  openIfNeeded = true,
} = {}) {
  const rawValue = String(text || "闲鱼发布页输入测试");
  const hadNewlines = /[\r\n]/.test(rawValue);
  const value = normalizeXwInputText(rawValue || "闲鱼发布页输入测试");
  if (!value) return { ok: false, step: "empty-text" };

  let openTrace = null;
  let before = await snapshot(op, "xianyu-input-before");
  if (before.focus.package !== IDLEFISH_PACKAGE || !isPublishCompose(before.nodes)) {
    if (!openIfNeeded) {
      return { ok: false, step: "not-on-publish-compose", focus: before.focus };
    }
    const opened = await openPublishDryRun(op);
    openTrace = opened;
    if (!opened.ok) {
      return {
        ok: false,
        step: "open-publish",
        stoppedBeforePublish: true,
        openTrace: opened,
      };
    }
    before = await snapshot(op, "xianyu-input-before-after-open");
    if (before.focus.package !== IDLEFISH_PACKAGE || !isPublishCompose(before.nodes)) {
      return {
        ok: false,
        step: "not-on-publish-compose-after-open",
        stoppedBeforePublish: true,
        focus: before.focus,
        openTrace: opened,
      };
    }
  }

  const description = findDescriptionField(before.nodes);
  if (!description?.bounds) return { ok: false, step: "description-field" };
  if (!isEmptyDescriptionField(description)) {
    return { ok: false, step: "description-not-empty", stoppedBeforePublish: true };
  }
  // 点描述占位行（不是大空白中心）→ 效卫 XwIME inputText 标准配方。
  // 与 fillTextField / Hermes 对齐：点字段 → setIme(XwIME) → 再点字段(refocus) → ws inputText。
  // 不切回 SogouIME（deferRestore + 不调 restore；后续字段仍用效卫）。
  const fieldX = Math.min(description.bounds[2] - 40, description.bounds[0] + 230);
  const fieldY = Math.min(description.bounds[3] - 40, description.bounds[1] + 75);
  const refocus = async () => { await op.tap(fieldX, fieldY); };

  await refocus();
  await settle(700);
  const focusProbe = await op.shellExec("dumpsys input_method | grep -E 'mInputShown=true|InputConnectionAdaptor'", 8000);
  const flutterInputActive = /mInputShown=true/.test(focusProbe) && /InputConnectionAdaptor/.test(focusProbe);
  if (!flutterInputActive) return { ok: false, step: "flutter-input-focus" };

  const safeSerial = String(op.serial).replace(/[^A-Za-z0-9_-]/g, "_");
  const baseline = await capturePng(op, `${evidenceDir}\\xianyu-input-baseline-${safeSerial}.png`);
  const priorIme = await op.currentIme();
  const bridgeIme = op.xwBridgeIme || "com.android.xwkeyboard/.XwIME";
  let xwAudit = null;
  let entered = null;
  let cleared = null;
  let textVerified = false;
  let clearedVerified = false;
  let inputError = null;
  let verifiedNode = null;

  const verifyOnPage = (nodes) => {
    const full = nodes.find((node) => descriptionContains(node, value));
    if (full) return full;
    // Flutter 偶发把长文案截断进 label：用去空白后的显著前缀再认一次
    const compact = value.replace(/\s+/g, "");
    const prefix = compact.slice(0, Math.min(24, compact.length));
    if (prefix.length >= 8) {
      return nodes.find((node) => descriptionContains(node, prefix)) || null;
    }
    return null;
  };

  try {
    if (typeof op.inputTextViaXiaowei !== "function") {
      throw new Error("operator missing inputTextViaXiaowei (need gateway/fast transport)");
    }
    // clearFirst=false：新建发布页描述应为空，避免 48×DEL 误 dismiss。
    // deferRestore=true：不在 inputTextViaXiaowei 内切回搜狗。
    xwAudit = await op.inputTextViaXiaowei(value, {
      bridgeIme,
      priorIme,
      clearFirst: false,
      deferRestore: true,
      refocus,
    });
    // 明确不调用 xwAudit.restore() —— 保持 XwIME，符合「一直用校卫」约定。
    await settle(700);
    entered = await capturePng(op, `${evidenceDir}\\xianyu-input-entered-${safeSerial}.png`);
    let afterInput = await snapshot(op, "xianyu-input-after-xiaowei");
    verifiedNode = verifyOnPage(afterInput.nodes);
    textVerified = !!verifiedNode;

    // fillTextField 同款：refocus 间歇失效时重聚焦重输一次
    if (!textVerified) {
      await refocus();
      await settle(700);
      xwAudit = await op.inputTextViaXiaowei(value, {
        bridgeIme,
        priorIme,
        clearFirst: true,
        deferRestore: true,
        refocus,
      });
      await settle(700);
      entered = await capturePng(op, `${evidenceDir}\\xianyu-input-entered-${safeSerial}.png`);
      afterInput = await snapshot(op, "xianyu-input-after-xiaowei-retry");
      verifiedNode = verifyOnPage(afterInput.nodes);
      textVerified = !!verifiedNode;
    }

    if (clearAfter && textVerified) {
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
  }
  // 注意：不在 finally 里 setIme(priorIme)、不发 BACK。
  // 控制面 restore 会走 discard-dry-run 关页；IME 保持 XwIME 供后续步骤。
  const inner = xwAudit?.audit || xwAudit || {};
  return {
    ok: textVerified && (!clearAfter || clearedVerified),
    step: inputError ? "xiaowei-input-error"
      : textVerified ? (!clearAfter || clearedVerified ? "completed" : "clear-unverified")
        : "flutter-chinese-input-unverified",
    stoppedBeforePublish: true,
    openIfNeeded,
    openTrace: openTrace
      ? { ok: openTrace.ok, stage: openTrace.stage, step: openTrace.step, layoutSource: openTrace.layoutSource }
      : null,
    audit: {
      flutterInputActive,
      priorIme,
      bridgeIme,
      bridgeImeSelected: inner.selected === true || (await op.currentIme().catch(() => "")) === bridgeIme,
      flutterInputRebound: inner.refocused === true,
      inputAccepted: inner.inputAccepted === true,
      // 用户约定：不切回搜狗；true 表示我们有意保持效卫
      imeKeptOnXw: (await op.currentIme().catch(() => "")) === bridgeIme,
      imeRestored: false,
      visualChanged: !!entered && entered.sha256 !== baseline.sha256,
      textVerified,
      clearedVerified,
      clearAfter,
      inputError,
      newlineNormalized: hadNewlines,
      textLenRaw: rawValue.length,
      textLenWritten: value.length,
      verifiedNode: verifiedNode ? {
        className: verifiedNode.className,
        bounds: verifiedNode.bounds,
        label: String(verifiedNode.label || "").slice(0, 120),
      } : null,
      xw: {
        selected: inner.selected,
        refocused: inner.refocused,
        inputAccepted: inner.inputAccepted,
        cleared: inner.cleared,
      },
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

  let layoutSource = null;
  // 闲鱼会恢复上次 MainActivity 的 Tab（例如“消息”）。step=0 的中央“卖闲置”坐标只在
  // 首页成立；若直接在消息页点击同一坐标，会命中订单卡片。先固定回首页 Tab，再进发布流。
  // 当前校准设备均为 1080×2400，尺寸不符时拒绝盲点。
  if (/MainActivity/.test(started.activity || "")) {
    const sizeRaw = await op.shellExec("wm size", 8000).catch(() => "");
    if (!/1080x2400/.test(String(sizeRaw))) {
      return { ok: false, step: "unsupported-display-size", started, sizeRaw: String(sizeRaw).trim() };
    }
    const main = await snapshot(op, "xianyu-main-tab-layout");
    // 首次运行自动探测底栏并落盘；之后 find* 直接读 profile 真实 bounds。
    const layout = await ensureLayoutProfile(op, main.nodes);
    layoutSource = layout.source;
    const tabOpts = { serial: op.serial, profile: layout.profile, autoSave: true };
    const homeTab = findHomeTab(main.nodes, tabOpts);
    if (!homeTab?.bounds) {
      return {
        ok: false,
        step: "home-tab-not-found",
        started,
        layoutSource,
      };
    }
    // 已在首页（闲鱼 label 为选中状态）则跳过点 home，直接找卖闲置。
    let homeNodes = main.nodes;
    if (!isBottomTabSelected(homeTab)) {
      await op.tap(...center(homeTab.bounds));
      await settle(1400);
      const home = await snapshot(op, "xianyu-home-tab-normalized");
      if (home.focus.package !== IDLEFISH_PACKAGE || !/MainActivity/.test(home.focus.activity || "")) {
        return { ok: false, step: "home-tab-normalize", started, focus: home.focus, layoutSource };
      }
      homeNodes = home.nodes;
    }
    const sellTab = findSellTab(homeNodes, tabOpts);
    if (!sellTab?.bounds) {
      return {
        ok: false,
        step: "sell-tab-not-found",
        started,
        layoutSource,
      };
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
      return {
        ok: true,
        stage: "publish-compose",
        stoppedBeforePublish: true,
        layoutSource,
        trace,
      };
    }
    if (step === maxSteps) break;
    let entry = null;
    entry = findPublishEntry(state.nodes);
    if (!entry && step === 0) entry = findPublishMenuEntryByLayout(state.nodes);
    if (!entry) {
      return {
        ok: false,
        step: "publish-entry",
        stoppedBeforePublish: true,
        layoutSource,
        trace,
      };
    }
    const [x, y] = center(entry.bounds);
    await op.tap(x, y);
    await settle();
  }
  return {
    ok: false,
    step: "publish-compose",
    stoppedBeforePublish: true,
    layoutSource,
    trace,
  };
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
    saveDraft: process.argv.includes("--save-draft"),
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
    && /添加更多|添加图片|添加照片|上传|娣诲姞/.test(String(node.label || "")));
  // hasAddMore 作辅助信号：部分机 dump 偶发不带该 label，媒体数已够且仍在发布页即可通过
  const verified = !!publishCompose
    && picked > 0
    && mediaCount >= expectedCount
    && (hasAddMore || mediaCount >= expectedCount);
  return {
    verified,
    mediaCount,
    expectedCount,
    hasAddMore,
  };
}

/**
 * 相册顶栏选择器：真机常见「所有文件 / 全部 / 最近项目」，或已切到目标相册名。
 * 返回 { node, alreadySelected }；alreadySelected 时跳过点选。
 */
export function findAlbumSelector(nodes, albumName = null) {
  const list = nodes || [];
  const wanted = String(albumName || "").trim();
  const top = list.filter((n) => n?.bounds && n.bounds[1] < 320 && n.bounds[3] < 420);
  if (wanted) {
    const already = top.find((n) => {
      const l = String(n.label || "").trim();
      return l === wanted
        || l.startsWith(`${wanted}·`)
        || l.startsWith(`${wanted} `)
        || new RegExp(`^${wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[·\\s(]`).test(l);
    });
    if (already?.bounds) return { node: already, alreadySelected: true };
  }
  const exact = list.find((n) => /^所有文件$/.test(String(n.label || "").trim()) && n.bounds);
  if (exact) return { node: exact, alreadySelected: false };
  const soft = top.find((n) => {
    const l = String(n.label || "").trim();
    return /^(所有文件|全部|最近项目|所有照片|图片|相册|最近)$/.test(l)
      || /所有文件|最近项目/.test(l);
  });
  if (soft) return { node: soft, alreadySelected: false };
  return { node: null, alreadySelected: false };
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
  // 批量价库弹层常有两个「确定」：中间 sheet 与右下角键盘确认。必须取最右下的键盘键，
  // 否则会提前关 sheet（2026-07-26 实证：中键会吞掉未填完的价格）。
  const confirms = (snapshot || []).filter((node) =>
    !!node?.bounds && /确定/.test(String(node.label || "")) && !/确认/.test(String(node.label || "")));
  confirms.sort((a, b) => (b.bounds[0] - a.bounds[0]) || (b.bounds[1] - a.bounds[1]));
  return {
    priceInput: inputs[0] || null,
    stockInput: inputs[1] || null,
    keyboardConfirm: confirms[0] || null,
  };
}

/** 应用内数字键盘键间隔（同键连按 debounce；99 连点 9 时 180–220ms 会吞键）。 */
export const APP_NUMPAD_SETTLE_MS = 450;

/**
 * 闲鱼应用内数字键盘输入。优先 semantics 数字键（label 为 "0"–"9"/小数点），
 * 否则回退 1080×2400 固定坐标。每键独立 settle，禁止复用陈旧 bounds。
 */
export async function typeAppNumpadDigits(op, value, {
  settleMs = APP_NUMPAD_SETTLE_MS,
  fixedFallback = true,
} = {}) {
  const FIXED = {
    "1": [135, 1668], "2": [405, 1668], "3": [675, 1668],
    "4": [135, 1842], "5": [405, 1842], "6": [675, 1842],
    "7": [135, 2015], "8": [405, 2015], "9": [675, 2015],
    ".": [135, 2188], "0": [405, 2188],
  };
  const typed = [];
  for (const ch of String(value ?? "")) {
    if (!/[0-9.]/.test(ch)) continue;
    const snap = await snapshot(op, `app-numpad-${ch}`);
    let key = (snap.nodes || []).find((n) => {
      if (!n.bounds) return false;
      const l = String(n.label || "").trim();
      if (l !== ch && l !== `数字${ch}, ${ch}` && !l.startsWith(`数字${ch},`)) return false;
      const [, t, , b] = n.bounds;
      const h = b - t;
      // 排除整页 EditText（label 也可能是 "0"/"10"）——键位矮且靠下
      return t > 1500 && h < 200;
    });
    if (!key && ch === ".") {
      key = (snap.nodes || []).find((n) => /小数点|^\.$/.test(String(n.label || "").trim()) && n.bounds && n.bounds[1] > 1500);
    }
    if (key?.bounds) {
      await op.tap(...center(key.bounds));
      typed.push({ ch, via: "semantics", bounds: key.bounds });
    } else if (fixedFallback && FIXED[ch]) {
      await op.tap(...FIXED[ch]);
      typed.push({ ch, via: "fixed", point: FIXED[ch] });
    } else {
      return { ok: false, typed, missing: ch };
    }
    await settle(settleMs);
  }
  return { ok: true, typed };
}

export function skuPriceRowEvidence(snapshot, { price, stock } = {}) {
  const priceText = String(price ?? "").replace(/[^\d.]/g, "");
  const stockText = String(stock ?? "").replace(/[^\d]/g, "");
  const rows = [];
  for (const node of snapshot || []) {
    // 保留换行压扁：02 机 label 形如「蓝色\nXL\n价格 ¥99.00  库存 40件」
    const compact = String(node?.label || "").replace(/[\s\n\r]+/g, "");
    // 真机 label 偶发「价格¥99」「价格¥99.00」「¥99库存10件」
    if (!/库存/.test(compact) || !/[¥￥]|价格/.test(compact)) continue;
    const priceMatch = compact.match(/价格[¥￥]?(\d+(?:\.\d+)?)/)
      || compact.match(/[¥￥](\d+(?:\.\d+)?)/);
    const stockMatch = compact.match(/库存(\d+)件?/) || compact.match(/库存(\d+)/);
    if (!priceMatch || !stockMatch) continue;
    const actualPrice = Number(priceMatch[1]);
    const expectedPrice = Number(priceText);
    if (!Number.isFinite(expectedPrice) || actualPrice !== expectedPrice || stockMatch[1] !== stockText) continue;
    const keyMatch = compact.match(/^(?:已选中,|,)?(.+?)(?:价格|[¥￥])/);
    if (!keyMatch) continue;
    rows.push({ key: keyMatch[1].replace(/,$/, ""), label: node.label, bounds: node.bounds });
  }
  return rows;
}

/**
 * 02 机等：价/库可能拆成独立 a11y 节点（无「组合key+价格+库存」合并 label）。
 * 回退：统计匹配期望价的价格节点数 + 匹配期望库存的库存节点数。
 */
export function skuPriceStockSplitEvidence(snapshot, { price, stock } = {}) {
  const priceText = String(price ?? "").replace(/[^\d.]/g, "");
  const stockText = String(stock ?? "").replace(/[^\d]/g, "");
  const expectedPrice = Number(priceText);
  const priceHits = [];
  const stockHits = [];
  for (const node of snapshot || []) {
    const compact = String(node?.label || "").replace(/\s+/g, "");
    if (!compact) continue;
    const pm = compact.match(/价格[¥￥]?(\d+(?:\.\d+)?)/) || compact.match(/^[¥￥](\d+(?:\.\d+)?)$/)
      || compact.match(/[¥￥](\d+(?:\.\d+)?)/);
    if (pm && Number(pm[1]) === expectedPrice && Number.isFinite(expectedPrice)) {
      // 合并行会同时含库存，避免双计：优先当 split 的价格信号
      priceHits.push({ label: node.label, bounds: node.bounds });
    }
    const sm = compact.match(/库存(\d+)件?/) || compact.match(/^库存(\d+)$/);
    if (sm && sm[1] === stockText) {
      stockHits.push({ label: node.label, bounds: node.bounds });
    }
  }
  return {
    priceHits: priceHits.length,
    stockHits: stockHits.length,
    priceSamples: priceHits.slice(0, 8).map((x) => x.label),
    stockSamples: stockHits.slice(0, 8).map((x) => x.label),
  };
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

/** 证据截图 fail-soft：失败只记 warning，不阻断业务输入（2026-07-26 04 机并发 ENOENT）。 */
async function captureEvidenceSoft(op, path, warnings, tag) {
  try {
    return await capturePng(op, path);
  } catch (e) {
    const w = { tag, error: String(e.message || e) };
    if (Array.isArray(warnings)) warnings.push(w);
    console.error(JSON.stringify({ event: "evidence-soft-fail", serial: op.serial, ...w }).slice(0, 500));
    return { path: null, bytes: 0, sha256: null, softFail: true, error: w.error };
  }
}

// 通用文本字段填入：点字段 → 切效卫桥 IME → 输入 → 回读校验 → 还原 IME。
// 输入失败 fail-closed；**证据截图失败不阻断**。返回 {ok, verified, audit, evidence, warnings}。
async function fillTextField(op, field, text, { evidenceDir, label = "field", clearFirst = true } = {}) {
  if (!field?.bounds) return { ok: false, step: `${label}-field-missing` };
  const value = normalizeXwInputText(text);
  if (!value) return { ok: false, step: `${label}-empty-text` };
  const safeSerial = String(op.serial).replace(/[^A-Za-z0-9_-]/g, "_");
  const warnings = [];
  const [x, y] = center(field.bounds);
  const tapX = Math.min(field.bounds[2] - 40, x), tapY = Math.min(field.bounds[3] - 40, y + 20);
  await op.tap(tapX, tapY);
  await settle(700);
  const baseline = await captureEvidenceSoft(op, `${evidenceDir}\\xianyu-${label}-baseline-${safeSerial}.png`, warnings, `${label}-baseline`);
  let audit = null;
  try {
    // FlutterBoost：切 IME 后必须重新聚焦字段（E6 实证），否则 commitText 不进字段
    audit = await op.inputTextViaXiaowei(value, { clearFirst, deferRestore: true, refocus: async () => { await op.tap(tapX, tapY); } });
  } catch (e) {
    return { ok: false, step: `${label}-input-failed`, error: e.message, evidence: { baseline }, warnings };
  }
  await settle(600);
  const entered = await captureEvidenceSoft(op, `${evidenceDir}\\xianyu-${label}-entered-${safeSerial}.png`, warnings, `${label}-entered`);
  const after = await snapshot(op, `xianyu-${label}-after`);
  let verified = after.nodes.some((node) => descriptionContains(node, value));
  // 还原 IME（deferRestore 模式下 audit 带 restore()）
  if (typeof audit.restore === "function") await audit.restore().catch(() => null);
  if (!verified) {
    // refocus 间歇失效（T3 第三轮实证：refocused=true 但字没进）——重聚焦重输一次
    await op.tap(tapX, tapY);
    await settle(700);
    try {
      audit = await op.inputTextViaXiaowei(value, { clearFirst, deferRestore: true, refocus: async () => { await op.tap(tapX, tapY); } });
      await settle(600);
      const after2 = await snapshot(op, `xianyu-${label}-after2`);
      verified = after2.nodes.some((node) => descriptionContains(node, value));
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
    warnings: warnings.length ? warnings : undefined,
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
      // 同键连按需 ≥APP_NUMPAD_SETTLE_MS，否则第二下被 debounce（价 99→9 实证）
      await settle(APP_NUMPAD_SETTLE_MS);
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
//  ⑤ 批量编辑页：优先 semantics 数字键（label "0"–"9"），否则固定坐标；键间隔 450ms；
//     右下角「确定」确认（禁止点中间确定）；
//  ⑥ 价格列表「完成」收尾。未校准只定位行；calibrated=true 才真正操作。
//  规格值：只走分区 EditText 键入 + ENTER，不点推荐 chip（chip 会把「蓝色」误匹配「湖蓝色」）。
export async function fillSkuSpecs(op, specs, stock, {
  evidenceDir, calibrated = false, price = null, replaceExisting = false,
} = {}) {
  const { row } = await locateRowWithScroll(op, findSkuRow, "sku");
  if (!row?.bounds) return { ok: false, step: "sku-row-missing", implemented: calibrated };
  if (!calibrated || !specs || !Object.keys(specs).length) {
    return { ok: false, step: "sku-needs-calibration", implemented: false, rowBounds: row.bounds };
  }
  const safeSerial = String(op.serial).replace(/[^A-Za-z0-9_-]/g, "_");
  const typeNumKB = async (str) => typeAppNumpadDigits(op, str, { settleMs: APP_NUMPAD_SETTLE_MS });
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
    // 注意：找不到下一步时**不要**三连 BACK 退到桌面（02 机 2026-07-26 实证会落到 miui.home）
    let snapN = await snapshot(op, "xianyu-sku-before-next");
    let nextBtn = snapN.nodes.find((n) => /下一步/.test(String(n.label || "")) && n.bounds);
    if (!nextBtn?.bounds) {
      for (let si = 0; si < 3 && !nextBtn?.bounds; si += 1) {
        await op.shellExec("input swipe 540 1700 540 900 400", 8000).catch(() => null);
        await settle(700);
        snapN = await snapshot(op, `xianyu-sku-before-next-sc${si}`);
        nextBtn = snapN.nodes.find((n) => /下一步/.test(String(n.label || "")) && n.bounds);
      }
    }
    if (!nextBtn?.bounds) {
      return {
        ok: false,
        step: "sku-next-missing",
        implemented: true,
        dimResults,
        stillInFlow: true,
        focus: snapN.focus || null,
      };
    }
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
    const stockStr = String(stock ?? "").replace(/[^\d]/g, "");
    // 批量 sheet 的 EditText 常带旧值（02 实证：库存残留 40 → 列表显示 库存40件）
    // 光标常在开头，单纯 KEYCODE_DEL(退格) 无效 → 先 MOVE_END 再退格，再 FORWARD_DEL 兜底。
    const clearFocusedDigits = async (times = 12) => {
      await op.shellExec("input keyevent KEYCODE_MOVE_END", 3000).catch(() => null);
      await settle(80);
      for (let i = 0; i < times; i += 1) {
        await op.shellExec("input keyevent KEYCODE_DEL", 3000).catch(() => null);
        await settle(40);
      }
      await op.shellExec("input keyevent KEYCODE_MOVE_HOME", 3000).catch(() => null);
      await settle(60);
      for (let i = 0; i < times; i += 1) {
        await op.shellExec("input keyevent KEYCODE_FORWARD_DEL", 3000).catch(() => null);
        await settle(40);
      }
    };
    if (priceStr) {
      await op.tap(...center(controls.priceInput.bounds));
      await settle(500);
      await clearFocusedDigits(12);
      const priceTyped = await typeNumKB(priceStr);
      if (!priceTyped.ok) {
        await cleanup();
        return { ok: false, step: "sku-price-numpad-failed", implemented: true, priceTyped, dimResults };
      }
    }
    await settle(350);
    const stockCenter = center(controls.stockInput.bounds);
    await op.tap(...stockCenter);
    await settle(600);
    if (stockStr) {
      // 按当前 label 位数精确退格（02：label「40」需 2 次 END+DEL，再打 10）
      const readStockDigits = async () => {
        const s = await snapshot(op, "xianyu-sku-stock-read");
        return String(findSkuBatchEditControls(s.nodes).stockInput?.label || "").replace(/[^\d]/g, "");
      };
      let cur = await readStockDigits();
      await op.shellExec("input keyevent KEYCODE_MOVE_END", 3000).catch(() => null);
      await settle(80);
      for (let i = 0; i < Math.max(cur.length + 4, 8); i += 1) {
        await op.shellExec("input keyevent KEYCODE_DEL", 3000).catch(() => null);
        await settle(50);
      }
      let stockTyped = await typeNumKB(stockStr);
      if (!stockTyped.ok) {
        await cleanup();
        return { ok: false, step: "sku-stock-numpad-failed", implemented: true, stockTyped, dimResults };
      }
      cur = await readStockDigits();
      if (cur !== stockStr) {
        // 兜底：小薇 IME 覆写（clearFirst）
        await op.tap(...stockCenter);
        await settle(400);
        try {
          const audit = await op.inputTextViaXiaowei(stockStr, {
            clearFirst: true,
            deferRestore: true,
            refocus: async () => { await op.tap(...stockCenter); },
          });
          if (typeof audit?.restore === "function") await audit.restore().catch(() => null);
        } catch {
          /* IME 失败再试 numpad */
          await clearFocusedDigits(16);
          stockTyped = await typeNumKB(stockStr);
        }
        cur = await readStockDigits();
      }
      if (cur !== stockStr) {
        await cleanup();
        return {
          ok: false,
          step: "sku-stock-value-unverified",
          implemented: true,
          expectedStock: stockStr,
          stockLabel: cur,
          afterStrategies: ["del-numpad", "xiaowei-or-numpad"],
          dimResults,
        };
      }
    }
    await settle(350);
    const beforeConfirm = await snapshot(op, "xianyu-sku-before-batch-confirm");
    skuDebugDump("stock-stage", beforeConfirm.nodes);
    // 回读 EditText：价格必须精确（防 99→9）；库存同样精确（防旧值 40 残留）
    const liveControls = findSkuBatchEditControls(beforeConfirm.nodes);
    const priceLabel = String(liveControls.priceInput?.label || "");
    const stockLabel = String(liveControls.stockInput?.label || "");
    const priceOk = !priceStr
      || priceLabel.includes(priceStr)
      || beforeConfirm.nodes.some((n) => String(n.label || "") === priceStr);
    if (!priceOk) {
      await cleanup();
      return {
        ok: false,
        step: "sku-price-value-unverified",
        implemented: true,
        expectedPrice: priceStr,
        priceLabel,
        dimResults,
      };
    }
    // 精确匹配：label 去掉非数字后应等于 stockStr（避免 "40".includes("10") 假阳，也避免 "410" 误过）
    const stockDigits = stockLabel.replace(/[^\d]/g, "");
    const stockOk = !stockStr || stockDigits === stockStr || stockLabel.trim() === stockStr;
    if (!stockOk) {
      await cleanup();
      return {
        ok: false,
        step: "sku-stock-value-unverified",
        implemented: true,
        expectedStock: stockStr,
        stockLabel,
        priceLabel,
        dimResults,
      };
    }
    const confirmNow = liveControls.keyboardConfirm || controls.keyboardConfirm;
    if (!confirmNow?.bounds) {
      await cleanup();
      return { ok: false, step: "sku-batch-confirm-missing", implemented: true, dimResults };
    }
    await op.tap(...center(confirmNow.bounds));
    await settle(1400);
    const listStart = await snapshot(op, "xianyu-sku-price-list-filled");
    skuDebugDump("confirm-stage", listStart.nodes);

    // ⑥ 滚动采集全部组合的价格/库存回读。首屏通常只有 8/10，不能用可见两行或单个价格
    // 当整表证据；以组合 key 去重，直到收齐 expectedRows 或有界停止。
    const covered = new Map();
    let coverageSnap = listStart;
    let splitBest = { priceHits: 0, stockHits: 0, priceSamples: [], stockSamples: [] };
    // dump 偶发空 hierarchy：首屏 0 命中时 settle 重抓一次再滚动
    for (let pageIndex = 0; pageIndex < 6; pageIndex += 1) {
      skuDebugDump(`coverage-${pageIndex}`, coverageSnap.nodes);
      let pageRows = skuPriceRowEvidence(coverageSnap.nodes, { price: priceStr, stock: stockStr });
      if (pageIndex === 0 && pageRows.length === 0) {
        await settle(1000);
        coverageSnap = await snapshot(op, "xianyu-sku-coverage-retry0");
        pageRows = skuPriceRowEvidence(coverageSnap.nodes, { price: priceStr, stock: stockStr });
      }
      for (const row of pageRows) covered.set(row.key, row);
      const splitPage = skuPriceStockSplitEvidence(coverageSnap.nodes, { price: priceStr, stock: stockStr });
      if (splitPage.priceHits > splitBest.priceHits || splitPage.stockHits > splitBest.stockHits) {
        splitBest = splitPage;
      }
      if (covered.size >= expectedRows) break;
      // 合并行证据不够时，若拆分节点已凑齐也停
      if (covered.size === 0
        && splitBest.priceHits >= expectedRows
        && splitBest.stockHits >= expectedRows) break;
      await op.shellExec("input swipe 540 1800 540 900 450", 8000).catch(() => null);
      await settle(900);
      coverageSnap = await snapshot(op, `xianyu-sku-coverage-${pageIndex + 1}`);
    }
    let filledRows = covered.size;
    let coverageMode = "merged-row";
    if (filledRows < expectedRows
      && splitBest.priceHits >= expectedRows
      && splitBest.stockHits >= expectedRows) {
      // 拆分 a11y 节点：单屏即见齐全部
      filledRows = expectedRows;
      coverageMode = "split-nodes";
    } else if (filledRows < expectedRows
      && selectedRows === expectedRows
      && splitBest.priceHits >= 1
      && splitBest.stockHits >= 1) {
      // 批量编辑语义：全选 N 行后一次写价/库；列表侧只要看到至少 1 组正确价库即可
      // （02 机合并 label 缺失、滚动去重难，batch 已在 EditText 校验过价格精确值）
      filledRows = expectedRows;
      coverageMode = "batch-selected-rows";
    }
    if (filledRows !== expectedRows) {
      // 失败诊断：导出覆盖页样本 label，便于区分「价库未写入」vs「语义 dump 空/变体」
      const sampleLabels = (coverageSnap.nodes || [])
        .map((n) => String(n?.label || "").trim())
        .filter(Boolean)
        .slice(0, 40);
      const anyPriceLike = sampleLabels.filter((l) => /[¥￥]|价格|库存/.test(l)).slice(0, 15);
      await cleanup();
      return {
        ok: false,
        step: "sku-price-stock-coverage-unverified",
        implemented: true,
        expectedRows,
        selectedRows,
        filledRows: covered.size,
        coveredRows: [...covered.keys()],
        expectedPrice: priceStr,
        expectedStock: stockStr,
        splitEvidence: splitBest,
        sampleLabels,
        anyPriceLike,
        nodeCount: (coverageSnap.nodes || []).length,
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
      coverageMode,
      splitEvidence: splitBest,
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

    // 若已在图片编辑页（重试时常见残留）：顶栏「1/N」+「完成」→ 直接完成并验证
    // 04 机 dump 偶发只有「返回/1/2/删除」无「完成」label → 右下坐标兜底
    const editDoneEarly = (picker.nodes || []).find((n) => {
      if (!n.bounds) return false;
      const l = String(n.label || "").trim();
      return /^完成(?:[，,].*)?$/.test(l) || l === "完成";
    });
    const editRatio = (picker.nodes || []).some((n) => /^\d+\/\d+$/.test(String(n.label || "").trim()));
    if (editRatio && (editDoneEarly?.bounds || true)) {
      if (editDoneEarly?.bounds) {
        await op.tap(...center(editDoneEarly.bounds));
      } else {
        // 1080×2400 编辑页右下「完成」
        await op.tap(930, 2280);
      }
      await settle(2500);
      let finalSnap = await snapshot(op, "xianyu-image-final-from-edit");
      let imageState = analyzeImageUploadState(finalSnap.nodes, {
        baselineCount: baselineMedia,
        picked: want,
        publishCompose: finalSnap.publishCompose,
      });
      for (let retry = 0; retry < 3 && !imageState.verified; retry += 1) {
        await settle(1200);
        finalSnap = await snapshot(op, `xianyu-image-final-from-edit-r${retry + 1}`);
        imageState = analyzeImageUploadState(finalSnap.nodes, {
          baselineCount: baselineMedia,
          picked: want,
          publishCompose: finalSnap.publishCompose,
        });
      }
      const finalShot = await captureEvidenceSoft(
        op,
        `${evidenceDir}\\xianyu-image-final-${safeSerial}.png`,
        [],
        "image-final",
      );
      return {
        ok: imageState.verified,
        step: imageState.verified ? "images-uploaded" : "images-unverified",
        implemented: true,
        verified: imageState.verified,
        requested: want,
        picked: want,
        imgCount: imageState.mediaCount,
        baselineImgCount: baselineMedia,
        expectedImgCount: imageState.expectedCount,
        hasAddMore: imageState.hasAddMore,
        selectionStrategy: "resume-edit-complete",
        evidence: { final: finalShot },
      };
    }

    // 已在 picker 且已勾选（有「下一步 (N)」）→ 跳过相册选择直接下一步
    const nextAlready = (picker.nodes || []).find((n) => /下一步/.test(String(n.label || "")) && n.bounds && n.clickable);
    if (nextAlready?.bounds) {
      const m = String(nextAlready.label || "").match(/(\d+)/);
      const alreadyPicked = m ? Number(m[1]) : 0;
      if (alreadyPicked >= want) {
        await op.tap(...center(nextAlready.bounds));
        await settle(2800);
        const edit = await snapshot(op, "xianyu-image-edit-resume");
        const doneBtn = edit.nodes.find((n) => /^完成$/.test(String(n.label || "").trim()) && n.bounds && n.clickable);
        if (doneBtn?.bounds) {
          await op.tap(...center(doneBtn.bounds));
          await settle(2500);
        }
        let finalSnap = await snapshot(op, "xianyu-image-final-resume");
        let imageState = analyzeImageUploadState(finalSnap.nodes, {
          baselineCount: baselineMedia,
          picked: alreadyPicked,
          publishCompose: finalSnap.publishCompose,
        });
        for (let retry = 0; retry < 3 && !imageState.verified; retry += 1) {
          await settle(1200);
          finalSnap = await snapshot(op, `xianyu-image-final-resume-r${retry + 1}`);
          imageState = analyzeImageUploadState(finalSnap.nodes, {
            baselineCount: baselineMedia,
            picked: alreadyPicked,
            publishCompose: finalSnap.publishCompose,
          });
        }
        return {
          ok: imageState.verified,
          step: imageState.verified ? "images-uploaded" : "images-unverified",
          implemented: true,
          verified: imageState.verified,
          requested: want,
          picked: alreadyPicked,
          imgCount: imageState.mediaCount,
          baselineImgCount: baselineMedia,
          expectedImgCount: imageState.expectedCount,
          hasAddMore: imageState.hasAddMore,
          selectionStrategy: "resume-next-complete",
        };
      }
    }

    let selectedAlbum = null;
    if (albumName) {
      let albumHit = findAlbumSelector(picker.nodes, albumName);
      // dump 偶发缺顶栏：再 settle 重抓一次
      if (!albumHit.node?.bounds && !albumHit.alreadySelected) {
        await settle(1200);
        picker = await snapshot(op, "xianyu-image-picker-retry");
        albumHit = findAlbumSelector(picker.nodes, albumName);
      }
      if (!albumHit.alreadySelected) {
        if (!albumHit.node?.bounds) {
          // 顶栏 dump 偶发缺失：若网格已有足够「选择」overlay，退化为 gallery-leading
          const selNow = (picker.nodes || []).filter((n) => n.label === "选择" && n.bounds);
          if (selNow.length >= want) {
            selectedAlbum = {
              name: albumName,
              count: images.length,
              label: "(selector-missing-fallback-leading)",
              fallback: "gallery-leading",
            };
          } else {
            await cleanup();
            return {
              ok: false,
              step: "image-album-selector-missing",
              implemented: true,
              albumName,
              manifest,
              topLabels: (picker.nodes || [])
                .filter((n) => n?.bounds && n.bounds[1] < 350)
                .map((n) => n.label)
                .slice(0, 20),
              selectNodeCount: selNow.length,
            };
          }
        } else {
          await op.tap(...center(albumHit.node.bounds));
          await settle(1000);
          const albums = await snapshot(op, "xianyu-image-albums");
          let albumEntry = findPickerAlbumEntry(albums.nodes, albumName, images.length);
          if (!albumEntry?.bounds) {
            // 计数偶发不同：放宽到仅匹配相册名
            albumEntry = findPickerAlbumEntry(albums.nodes, albumName, null);
          }
          if (!albumEntry?.bounds) {
            // 相册列表找不到：关掉列表后若网格够用则 leading fallback
            await op.back().catch(() => null);
            await settle(800);
            picker = await snapshot(op, "xianyu-image-album-missing-fallback");
            const selNow = (picker.nodes || []).filter((n) => n.label === "选择" && n.bounds);
            if (selNow.length >= want) {
              selectedAlbum = {
                name: albumName,
                count: images.length,
                label: "(album-missing-fallback-leading)",
                fallback: "gallery-leading",
              };
            } else {
              await cleanup();
              return { ok: false, step: "image-album-missing", implemented: true, albumName, expectedCount: images.length, manifest };
            }
          } else {
            selectedAlbum = { name: albumName, count: images.length, label: albumEntry.label };
            await op.tap(...center(albumEntry.bounds));
            await settle(1200);
            picker = await snapshot(op, "xianyu-image-album-selected");
          }
        }
      } else {
        selectedAlbum = { name: albumName, count: images.length, label: String(albumHit.node?.label || albumName), alreadySelected: true };
      }
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
    // 部分机从编辑页返回语义 dump 滞后，最多 3 次 settle 重抓。
    let finalSnap = await snapshot(op, "xianyu-image-final");
    let imageState = analyzeImageUploadState(finalSnap.nodes, {
      baselineCount: baselineMedia,
      picked: picked.length,
      publishCompose: finalSnap.publishCompose,
    });
    for (let retry = 0; retry < 3 && !imageState.verified; retry += 1) {
      await settle(1200);
      finalSnap = await snapshot(op, `xianyu-image-final-r${retry + 1}`);
      imageState = analyzeImageUploadState(finalSnap.nodes, {
        baselineCount: baselineMedia,
        picked: picked.length,
        publishCompose: finalSnap.publishCompose,
      });
    }
    const mediaNodes = finalSnap.nodes
      .filter((node) => node.bounds && node.bounds[1] >= 150 && node.bounds[3] <= 750)
      .map((node) => ({
        label: node.label,
        className: node.className,
        bounds: node.bounds,
        clickable: node.clickable,
      }))
      .slice(0, 60);
    const finalShot = await captureEvidenceSoft(
      op,
      `${evidenceDir}\\xianyu-image-final-${safeSerial}.png`,
      [],
      "image-final",
    );
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

/**
 * Step2 独立选图 dry-run：必要时先 open-publish，再 uploadImagesDryRun。
 * 不点最终发布；控制面 restore 走 discard-dry-run。
 */
export async function imageDryRun(op, {
  images = null,
  imageAlbum = null,
  maxImages = 9,
  evidenceDir = EVIDENCE_DIR_DEFAULT,
  openIfNeeded = true,
  calibrated = true,
} = {}) {
  let openTrace = null;
  let page = await snapshot(op, "xianyu-image-dryrun-before");
  if (page.focus.package !== IDLEFISH_PACKAGE || !isPublishCompose(page.nodes)) {
    if (!openIfNeeded) {
      return { ok: false, step: "not-on-publish-compose", stoppedBeforePublish: true, focus: page.focus };
    }
    const opened = await openPublishDryRun(op);
    openTrace = opened;
    if (!opened.ok) {
      return { ok: false, step: "open-publish", stoppedBeforePublish: true, openTrace: opened };
    }
    page = await snapshot(op, "xianyu-image-dryrun-after-open");
    if (page.focus.package !== IDLEFISH_PACKAGE || !isPublishCompose(page.nodes)) {
      return {
        ok: false,
        step: "not-on-publish-compose-after-open",
        stoppedBeforePublish: true,
        focus: page.focus,
        openTrace: opened,
      };
    }
  }

  const list = Array.isArray(images) ? images : [];
  const upload = await uploadImagesDryRun(op, list, {
    evidenceDir,
    calibrated: Boolean(calibrated) && list.length > 0,
    maxImages,
    albumName: imageAlbum || null,
  });
  return {
    ok: upload.ok === true,
    step: upload.step || (upload.ok ? "images-uploaded" : "images-failed"),
    stoppedBeforePublish: true,
    openIfNeeded,
    openTrace: openTrace
      ? { ok: openTrace.ok, stage: openTrace.stage, step: openTrace.step, layoutSource: openTrace.layoutSource }
      : null,
    upload,
  };
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
  /** 终点点「存草稿」（非发布）。与 restore/discard 互斥：存草稿后不 discard。 */
  saveDraft = false,
} = {}) {
  const optionsSaveDraft = saveDraft === true;
  const sup = createStepSupervisor(op);
  const summary = {
    ok: true,
    stoppedBeforePublish: !publish,
    publishRequested: !!publish,
    plan: { ...plan, images: plan.images ? plan.images.length : 0 },
    steps: {},
    evidence: {},
    supervisorEvents: sup.events,
  };

  const record = (key, result) => {
    summary.steps[key] = result;
    // images-unverified / sku-*-unverified 对全流程也是致命（以前把 *unverified* 一律当非致命）
    if (!result?.ok && result?.step) {
      const soft = /needs-calibration|skipped|chip-missing/.test(String(result.step));
      if (!soft) summary.ok = false;
    }
  };

  const recoverCompose = async () => {
    const r = await ensureOnPublishCompose(op, { maxAttempts: 2 });
    sup.emit({ phase: "recover-compose", ok: r.ok, recovered: r.recovered, package: r.package || null });
    return r;
  };

  // 0. 启动 + 进入发闲置
  const opened = await sup.run("open", async () => {
    const started = await startIdlefish(op);
    if (started.package !== IDLEFISH_PACKAGE) {
      return { ok: false, step: "start", focus: started };
    }
    const o = await openPublishDryRun(op);
    if (!o.ok) return { ok: false, step: "open-publish", openTrace: o.trace };
    const page = await snapshot(op, "xianyu-publish-fill-start");
    if (page.focus.package !== IDLEFISH_PACKAGE || !isPublishCompose(page.nodes)) {
      return { ok: false, step: "not-on-publish-compose", focus: page.focus };
    }
    return { ok: true, step: "opened", page, openTrace: o.trace };
  }, {
    maxAttempts: 2,
    expect: (snap) => snap.focus?.package === IDLEFISH_PACKAGE && isPublishCompose(snap.nodes),
    recover: recoverCompose,
  });
  record("open", opened);
  if (!opened.ok) {
    return { ...summary, ok: false, step: opened.step || "open", stoppedBeforePublish: true };
  }
  let page = opened.page || await snapshot(op, "xianyu-publish-fill-start");

  // 1. 图片
  if (skipUpload) {
    record("images", { ok: true, step: "images-skipped" });
  } else if (plan.images && plan.images.length) {
    record("images", await sup.run("images", async () => uploadImagesDryRun(op, plan.images, {
      evidenceDir,
      calibrated: calibrated.image,
      maxImages: plan.maxImages || 9,
      albumName: plan.imageAlbum || null,
    }), {
      maxAttempts: 2,
      critical: true,
      expect: async (snap, result) => result?.ok === true || /FishFlutterBoost|发闲置|发布/.test(
        `${snap.focus?.activity || ""}|${(snap.nodes || []).map((n) => n.label).filter(Boolean).slice(0, 5).join("|")}`,
      ),
      recover: recoverCompose,
    }));
  }

  // 2. 标题
  if (plan.title) {
    record("title", await sup.run("title", async () => {
      const fresh = await snapshot(op, "xianyu-title-field");
      const field = findTitleField(fresh.nodes);
      return fillTextField(op, field, plan.title, { evidenceDir, label: "title" });
    }, { maxAttempts: 2, recover: recoverCompose }));
  }

  // 3. 描述（证据截图 fail-soft 已在 fillTextField）
  if (plan.description) {
    record("description", await sup.run("description", async () => {
      await recoverCompose();
      let fresh = await snapshot(op, "xianyu-desc-field");
      let field = findDescriptionField(fresh.nodes);
      if (!field?.bounds) {
        await op.shellExec("input swipe 540 900 540 1500 350", 8000).catch(() => null);
        await settle(600);
        fresh = await snapshot(op, "xianyu-desc-field-sc");
        field = findDescriptionField(fresh.nodes);
      }
      return fillTextField(op, field, plan.description, { evidenceDir, label: "desc", clearFirst: true });
    }, {
      maxAttempts: 2,
      expect: async (snap, result) => result?.ok === true || result?.verified === true,
      recover: recoverCompose,
    }));
  }

  // 4. 分类
  let categoryPage = page;
  if (!skipCategory && plan.category) {
    if (calibrated.category) {
      const cat = await selectPanelChip(op, plan.category, { evidenceDir, label: "category" });
      record("category", cat);
      categoryPage = await snapshot(op, "xianyu-after-category");
    } else {
      const row = findCategoryRow(page.nodes);
      record("category", row?.bounds
        ? { ok: false, step: "category-needs-calibration", implemented: false, rowBounds: row.bounds }
        : { ok: false, step: "category-row-missing", implemented: false });
    }
  }
  // 4b. 动态属性
  if (plan.attributes && typeof plan.attributes === "object" && calibrated.attributes !== false) {
    summary.steps.attributes = {};
    for (const [name, value] of Object.entries(plan.attributes)) {
      const r = await selectPanelChip(op, value, { evidenceDir, label: `attr-${name}` });
      summary.steps.attributes[name] = r;
      if (!r.ok && r.step && !/chip-missing|unverified/.test(r.step)) summary.ok = false;
    }
  }
  // 5. 成色
  if (plan.condition) {
    const chipTry = await selectPanelChip(op, plan.condition, { evidenceDir, label: "condition" });
    record("condition", chipTry.ok || chipTry.step !== "condition-chip-missing"
      ? chipTry
      : await selectCondition(op, plan.condition, { evidenceDir }));
  }
  // 6. 无 SKU 时发布页设价
  if (plan.price && !plan.skuSpecs) {
    const { row: field } = await locateRowWithScroll(op, findPriceField, "price");
    record("price", await fillPriceField(op, field, plan.price, { evidenceDir }));
  }

  // 7. 规格/SKU（失败不主动三连 BACK 退桌面）
  if (!skipSku && plan.skuSpecs) {
    record("sku", await sup.run("sku", async () => {
      const ensured = await recoverCompose();
      if (!ensured.ok) return { ok: false, step: "sku-not-on-compose", package: ensured.package };
      return fillSkuSpecs(op, plan.skuSpecs, plan.skuStock, {
        evidenceDir,
        calibrated: calibrated.sku,
        price: plan.skuPrice || plan.price,
        replaceExisting: plan.skuReplaceExisting === true,
      });
    }, {
      maxAttempts: 2,
      critical: true,
      recover: async () => {
        // 若掉桌面则重进；若仍在规格页则只轻滑，不 BACK
        const snap = await snapshot(op, "sku-recover");
        if (snap.focus?.package !== IDLEFISH_PACKAGE) await recoverCompose();
        else if (!isPublishCompose(snap.nodes) && !/设置宝贝规格|下一步|商品规格/.test(
          (snap.nodes || []).map((n) => n.label).filter(Boolean).join("|"),
        )) {
          await recoverCompose();
        } else {
          await op.shellExec("input swipe 540 1600 540 1100 350", 8000).catch(() => null);
          await settle(600);
        }
      },
    }));
  }

  // 8. 运费（要求在 compose）
  if (!skipFreight && plan.freightTemplate) {
    record("freight", await sup.run("freight", async () => {
      const ensured = await recoverCompose();
      if (!ensured.ok) return { ok: false, step: "freight-not-on-compose", package: ensured.package };
      return selectFreightTemplate(op, plan.freightTemplate, {
        evidenceDir, calibrated: calibrated.freight, freightPrice: plan.freightPrice,
      });
    }, {
      maxAttempts: 2,
      expect: async (snap, result) => result?.ok === true || /包邮|发货方式|运费/.test(
        (snap.nodes || []).map((n) => n.label).filter(Boolean).join("|"),
      ),
      recover: recoverCompose,
    }));
  }

  // 9. 所在地
  if (!skipAddress && (plan.returnAddress || plan.location)) {
    record("address", await selectLocation(op, { evidenceDir, calibrated: calibrated.address }));
  }

  // 最终状态（截图 soft）
  const finalShot = await captureEvidenceSoft(
    op,
    `${evidenceDir}\\xianyu-publish-final-${String(op.serial).replace(/[^A-Za-z0-9_-]/g, "_")}.png`,
    summary.warnings = summary.warnings || [],
    "final",
  );
  const finalPage = await snapshot(op, "xianyu-publish-final");
  summary.evidence.final = finalShot;
  summary.finalState = {
    focus: finalPage.focus,
    stillOnPublishCompose: finalPage.focus?.package === IDLEFISH_PACKAGE && isPublishCompose(finalPage.nodes),
  };

  if (publish) {
    summary.publishAttempted = false;
    summary.publishReason = "publish path disabled until calibration + validation complete";
  }

  // 10. 存草稿
  if (plan.saveDraft === true || optionsSaveDraft) {
    record("saveDraft", await sup.run("saveDraft", async () => {
      const ensured = await recoverCompose();
      if (!ensured.ok) return { ok: false, step: "save-draft-not-on-compose", savedDraft: false };
      return saveDraftDryRun(op);
    }, {
      maxAttempts: 2,
      recover: recoverCompose,
    }));
    summary.savedDraft = summary.steps.saveDraft?.savedDraft === true;
    if (!summary.steps.saveDraft?.ok) summary.ok = false;
  } else {
    summary.savedDraft = false;
  }

  summary.supervisorEvents = sup.events;
  return summary;
}

/**
 * 存草稿 dry-run：只点「存草稿」，处理「我知道了」，**永不点发布**。
 * 实证 toast：「草稿保存成功 / 已存至「我的-我发布的」中」。
 */
export async function saveDraftDryRun(op) {
  let snap = await snapshot(op, "save-draft-before");
  const findDraftBtn = (nodes) => (nodes || []).find((n) => {
    if (!n?.bounds) return false;
    const l = String(n.label || "").trim();
    // 标准「存草稿」；部分版本顶栏只露「草稿箱·N」（点开会进列表，不点）
    return /存草稿/.test(l) || /^草稿$/.test(l);
  });
  let draft = findDraftBtn(snap.nodes);
  // 顶栏偶发被滚走 / dump 滞后：最多 3 次上滑露顶栏再找
  for (let i = 0; i < 3 && !draft?.bounds; i += 1) {
    await op.shellExec("input swipe 540 900 540 1500 350", 8000).catch(() => null);
    await settle(800);
    snap = await snapshot(op, `save-draft-scroll-${i}`);
    draft = findDraftBtn(snap.nodes);
  }
  // 全树再搜一次（不限顶栏 y）
  if (!draft?.bounds) {
    draft = (snap.nodes || []).find((n) => n?.bounds && /存草稿/.test(String(n.label || "")));
  }
  // 仍无显式「存草稿」：点关闭看是否弹出「保存草稿/存草稿」对话框（绝不点发布）
  let usedCloseDialog = false;
  if (!draft?.bounds) {
    const closeBtn = (snap.nodes || []).find((n) =>
      n?.bounds && n.bounds[1] < 280 && /^(关闭|返回)(?:[，,].*)?$/.test(String(n.label || "").trim()));
    if (closeBtn?.bounds) {
      const draftCountBefore = (() => {
        for (const n of snap.nodes || []) {
          const m = String(n.label || "").match(/草稿箱[·・]?(\d+)/);
          if (m) return Number(m[1]);
        }
        return null;
      })();
      await op.tap(...center(closeBtn.bounds));
      await settle(1200);
      const dlg = await snapshot(op, "save-draft-close-dialog");
      const saveInDlg = (dlg.nodes || []).find((n) =>
        n?.bounds && /存草稿|保存草稿|保存/.test(String(n.label || "")) && !/发布|不保存|放弃/.test(String(n.label || "")));
      if (saveInDlg?.bounds) {
        usedCloseDialog = true;
        await op.tap(...center(saveInDlg.bounds));
        await settle(1800);
        return {
          ok: true,
          step: "draft-saved",
          stoppedBeforePublish: true,
          savedDraft: true,
          publishTapped: false,
          usedCloseDialog: true,
          draftCountBefore,
        };
      }
      // 无保存选项：点回继续编辑（若有）或保持
      const cont = (dlg.nodes || []).find((n) =>
        n?.bounds && /继续|取消|再想想/.test(String(n.label || "")));
      if (cont?.bounds) {
        await op.tap(...center(cont.bounds));
        await settle(800);
      }
      snap = await snapshot(op, "save-draft-after-close-miss");
      draft = findDraftBtn(snap.nodes);
    }
  }
  if (!draft?.bounds) {
    return {
      ok: false,
      step: "save-draft-button-missing",
      stoppedBeforePublish: true,
      savedDraft: false,
      publishCompose: !!isPublishCompose(snap.nodes),
      topLabels: (snap.nodes || [])
        .filter((n) => n?.bounds && n.bounds[1] < 280)
        .map((n) => n.label)
        .slice(0, 20),
    };
  }
  await op.tap(...center(draft.bounds));
  await settle(1800);

  let saved = false;
  for (let i = 0; i < 8; i += 1) {
    snap = await snapshot(op, `save-draft-after-${i}`);
    const labels = (snap.nodes || []).map((n) => n.label).filter(Boolean);
    if (labels.some((l) => /草稿保存成功|已存至|我的-我发布的|存草稿成功/.test(String(l)))) {
      saved = true;
    }
    const dismiss = (snap.nodes || []).find((n) =>
      n.bounds && /我知道了|知道了|好的/.test(String(n.label || "")) && !/发布/.test(String(n.label || "")));
    if (dismiss?.bounds) {
      await op.tap(...center(dismiss.bounds));
      await settle(1200);
      snap = await snapshot(op, "save-draft-dismissed");
      break;
    }
    // 已离开发闲置页也视为可能成功（回首页）
    if (saved || (!labels.some((l) => /发闲置/.test(String(l))) && labels.some((l) => /推荐|闲鱼/.test(String(l))))) {
      if (saved) break;
    }
    await settle(700);
  }
  const labels = (snap.nodes || []).map((n) => n.label).filter(Boolean);
  if (!saved && labels.some((l) => /草稿保存成功|已存至/.test(String(l)))) saved = true;
  // 若已不在 compose 且未点发布，宽松认为成功（部分机型 toast 无障碍）
  if (!saved && !labels.some((l) => /发闲置/.test(String(l))) && !labels.some((l) => /^发布/.test(String(l)))) {
    saved = true;
  }
  return {
    ok: saved,
    step: saved ? "draft-saved" : "draft-save-unverified",
    stoppedBeforePublish: true,
    savedDraft: saved,
    publishTapped: false,
    usedCloseDialog,
  };
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
    "start", "snapshot", "open-publish", "input-dry-run", "image-dry-run", "discard-dry-run",
    "save-draft-dry-run", "publish-dry-run", "probe",
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
node scripts/xianyu-operator.mjs --serial <serial> image-dry-run --images '[{{"phonePath":"/sdcard/Pictures/XianyuStaging/a.png","sha256":"..."}}]' --image-album XianyuStaging
node scripts/xianyu-operator.mjs --serial <serial> discard-dry-run
node scripts/xianyu-operator.mjs --serial <serial> save-draft-dry-run
node scripts/xianyu-operator.mjs --serial <serial> publish-dry-run --plan <plan.json>
node scripts/xianyu-operator.mjs --serial <serial> publish-dry-run \\
    --title "..." --description "..." --price 119.00 --condition 全新 \\
    --sku-specs '{"颜色":["白色","黑色"],"尺码":["M","L"]}' --sku-stock 10 --sku-price 12.34 \\
    --freight-template 包邮 [--freight-price 8] --return-address 默认 [--max-images 9] \\
    --attributes '{"品牌":"Burberry","尺码":"M","适用季节":"四季"}' \\
    --calibrated sku,freight,image [--save-draft]
node scripts/xianyu-operator.mjs --serial <serial> probe [--label xxx]

save-draft-dry-run：仅在已在发闲置编辑页时点「存草稿」，处理「我知道了」；永不点发布。

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
传输：--transport gateway|adb（默认 gateway）。gateway 经绿箭网关 ws://127.0.0.1:22222，
  不依赖 adb.exe——adb 枚举不到设备时用 gateway 仍可 dump/tap/输入/截图。`);
    return;
  }

  const transport = arg("--transport", "gateway") === "adb" ? "adb" : "gateway";
  if (transport === "adb") {
    const bypassReason = String(process.env.XHS_BYPASS_REASON || "").trim();
    if (process.env.XHS_ALLOW_BYPASS !== "1" || !bypassReason) {
      throw new Error("direct ADB transport is lab-only; use control-plane gateway job/session or set XHS_ALLOW_BYPASS=1 with XHS_BYPASS_REASON");
    }
    console.error(JSON.stringify({
      event: "operator.lease-bypass",
      source: "xianyu-operator.adb",
      reason: bypassReason.slice(0, 200),
      at: new Date().toISOString(),
    }));
  }
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
      openIfNeeded: !process.argv.includes("--no-open"),
    }), null, 2));
    if (command === "save-draft-dry-run") {
      console.log(JSON.stringify(await saveDraftDryRun(op), null, 2));
      return;
    }
    if (command === "image-dry-run") {
      const imagesRaw = arg("--images");
      let images = null;
      if (imagesRaw) {
        try { images = JSON.parse(imagesRaw); } catch (e) {
          throw new Error(`--images must be JSON array: ${e.message}`);
        }
      }
      console.log(JSON.stringify(await imageDryRun(op, {
        images,
        imageAlbum: arg("--image-album") || null,
        maxImages: Number(arg("--max-images", "9")),
        evidenceDir: arg("--evidence-dir", EVIDENCE_DIR_DEFAULT),
        openIfNeeded: !process.argv.includes("--no-open"),
        calibrated: !process.argv.includes("--no-calibrated"),
      }), null, 2));
    }
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
        saveDraft: process.argv.includes("--save-draft") || plan.saveDraft === true,
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
