import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

import { ControlPlaneError } from "../../control-plane/lib/errors.mjs";

const PACKAGE = "com.xingin.xhs";
const BRIDGE_IME = "com.android.xwkeyboard/.XwIME";
const DEFAULT_IME = "com.sohu.inputmethod.sogou.xiaomi/.SogouIME";
const PUBLISH_SURFACE = /capa|post\.platform|ImageEdit|AlbumActivity|MaterialPreview/i;
const PERMISSION_PACKAGES = new Set([
  "com.android.permissioncontroller",
  "com.google.android.permissioncontroller",
  "com.miui.securitycenter",
]);
const DISCARD_PATTERNS = [
  /^不保存$/u,
  /^退出$/u,
  /^放弃$/u,
  /^丢弃$/u,
  /^狠心离开$/u,
  /^直接退出$/u,
  /不保存/u,
  /退出编辑/u,
  /^离开$/u,
  /^不保留$/u,
  /^放弃编辑$/u,
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function decode(value = "") {
  // Xiaowei adb_shell occasionally returns an otherwise ASCII UIAutomator XML
  // whose individual Chinese attribute values contain raw UTF-16LE bytes.
  // Parse the document through latin1 to preserve bytes, then repair each
  // attribute independently. Normal UTF-8 attributes take the first path.
  const bytes = Buffer.from(String(value), "latin1");
  let text = bytes.toString("utf8");
  if (text.includes("\uFFFD") && bytes.length % 2 === 0) {
    const utf16 = bytes.toString("utf16le");
    const utf16Cjk = (utf16.match(/[\u3400-\u9fff]/g) || []).length;
    const utf8Cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
    if (utf16Cjk > utf8Cjk && !utf16.includes("\uFFFD")) text = utf16;
  }
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseNodes(xml) {
  const nodes = [];
  // UIAutomator uses both leaf `<node .../>` records and parent
  // `<node ...>...children...</node>` containers. Selectors such as the XHS
  // bottom publish tab often live on the parent, so parse every start tag.
  const tagRe = /<node\b([^>]*)>/g;
  const attrRe = /(\b[a-zA-Z:_][a-zA-Z0-9:_-]*)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = tagRe.exec(String(xml || ""))) !== null) {
    const attrs = {};
    let attr;
    attrRe.lastIndex = 0;
    while ((attr = attrRe.exec(match[1])) !== null) attrs[attr[1]] = decode(attr[2]);
    const bounds = String(attrs.bounds || "").match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
    if (!bounds) continue;
    nodes.push({
      text: attrs.text || "",
      contentDesc: attrs["content-desc"] || "",
      className: attrs.class || "",
      package: attrs.package || "",
      clickable: attrs.clickable === "true",
      focusable: attrs.focusable === "true",
      focused: attrs.focused === "true",
      bounds: bounds.slice(1).map(Number),
    });
  }
  return nodes;
}

function center(node) {
  if (!node?.bounds) return null;
  return [
    Math.round((node.bounds[0] + node.bounds[2]) / 2),
    Math.round((node.bounds[1] + node.bounds[3]) / 2),
  ];
}

function label(node) {
  return String(node?.text || node?.contentDesc || "").trim();
}

function contains(outer, inner) {
  return outer && inner
    && inner[0] >= outer[0] - 2 && inner[1] >= outer[1] - 2
    && inner[2] <= outer[2] + 2 && inner[3] <= outer[3] + 2;
}

export function resolvePublishTextParams({ title, body, caption } = {}) {
  const titleText = String(title ?? "").trim();
  const bodyText = String(body ?? caption ?? "").trim();
  return { titleText, bodyText };
}

function validatePublishTextParams({ titleText, bodyText }) {
  if (titleText.length > 20) return { ok: false, step: "titleInvalid" };
  if (bodyText.length > 300) return { ok: false, step: "bodyInvalid" };
  if (!titleText && !bodyText) return { ok: false, step: "textInvalid" };
  return { ok: true };
}

function findTitleAndBodyFields(page) {
  const edits = page.nodes
    .filter((node) => node.className === "android.widget.EditText" && center(node))
    .sort((left, right) => center(left)[1] - center(right)[1]);
  let titleField = edits[0] ? { center: center(edits[0]), label: "titleEditText" } : null;
  let bodyField = edits[1] ? { center: center(edits[1]), label: "bodyEditText" } : null;
  const titleLabel = findLabel(page.nodes, [/添加标题/u, /^标题$/u], { clickable: true });
  const bodyLabel = findLabel(page.nodes, [/添加正文/u, /说点什么/u, /发语音/u, /^正文$/u], { clickable: true });
  if (titleLabel?.center) titleField = titleLabel;
  if (bodyLabel?.center) bodyField = bodyLabel;
  if (!bodyField && edits.length === 1) {
    bodyField = titleField;
    titleField = null;
  }
  return { titleField, bodyField };
}

function textLanded(verify, text) {
  if (!text) return true;
  const needle = text.slice(0, Math.min(6, text.length));
  return verify.xml.includes(text)
    || verify.nodes.some((node) => String(node.text || "").includes(needle));
}

function findLabel(nodes, patterns, { clickable = false } = {}) {
  for (const pattern of patterns) {
    const candidates = nodes.filter((node) => pattern.test(label(node)));
    const direct = candidates.find((node) => !clickable || node.clickable);
    if (direct) return { node: direct, label: label(direct), center: center(direct) };
    if (!clickable) continue;
    for (const candidate of candidates) {
      const owner = nodes
        .filter((node) => node.clickable && contains(node.bounds, candidate.bounds))
        .sort((left, right) => {
          const lb = left.bounds;
          const rb = right.bounds;
          return (lb[2] - lb[0]) * (lb[3] - lb[1]) - (rb[2] - rb[0]) * (rb[3] - rb[1]);
        })[0];
      if (owner) return { node: owner, label: label(candidate), center: center(owner) };
    }
  }
  return null;
}

function resolveHomePublishTab(nodes) {
  const width = Math.max(0, ...nodes.map((node) => node.bounds?.[2] || 0));
  const height = Math.max(0, ...nodes.map((node) => node.bounds?.[3] || 0));
  if (width < 100 || height < 100) return null;
  const direct = findLabel(
    nodes,
    [/^发布$/u, /^发布[，,\s]*(?:按钮|入口)$/u],
    { clickable: true },
  );
  if (direct?.center?.[1] >= height * 0.78) return direct;

  // Coordinate fallback is allowed only on the already verified IndexActivity
  // and only when the hierarchy proves this is the five-item bottom nav. It is
  // never used on an editor surface where 发布/发笔记 is a final commit.
  const bottomLabels = nodes
    .filter((node) => center(node)?.[1] >= height * 0.78)
    .map(label)
    .filter(Boolean);
  const homeSignals = [/首页/u, /购物/u, /消息/u, /我(?:的)?$/u]
    .filter((pattern) => bottomLabels.some((value) => pattern.test(value))).length;
  const bottomClickable = nodes.filter((node) => node.clickable && center(node)?.[1] >= height * 0.78).length;
  if (homeSignals >= 2 && bottomClickable >= 3) {
    return {
      node: null,
      label: "verified-bottom-nav-fallback",
      center: [Math.round(width / 2), Math.round(height * 0.956)],
    };
  }
  return null;
}

function responseText(response, serial) {
  const data = response?.data;
  if (data == null) return "";
  if (typeof data === "string") return data;
  if (typeof data === "object") {
    if (data[serial] != null) return String(data[serial]);
    const values = Object.values(data);
    if (values.length === 1) return String(values[0] ?? "");
  }
  return String(data);
}

async function adbShell(transport, serial, command, timeoutMs = 20000) {
  const response = await transport.invoke({
    action: "adb_shell",
    devices: serial,
    data: { command: String(command) },
  }, { timeoutMs });
  return responseText(response, serial);
}

export async function captureXhsRecoveryScreen({ transport, device, evidenceDirectory }) {
  if (!transport || typeof transport.invoke !== "function") {
    throw new ControlPlaneError("TYPED_TRANSPORT_REQUIRED", "XHS recovery inspection requires Xiaowei transport", {
      status: 403,
    });
  }
  const serial = device?.runtimeId;
  if (!serial) throw new ControlPlaneError("DEVICE_RUNTIME_MISSING", "XHS device runtime is missing", { status: 409 });
  mkdirSync(evidenceDirectory, { recursive: true });
  const saveDirectory = join(evidenceDirectory, `_xhs_recovery_${randomUUID()}`);
  mkdirSync(saveDirectory, { recursive: true });
  const before = new Set(readdirSync(saveDirectory).filter((name) => /\.png$/i.test(name)));
  await transport.invoke({
    action: "Screen",
    devices: serial,
    data: { savePath: saveDirectory },
  }, { timeoutMs: 30000 });
  let source = null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const files = readdirSync(saveDirectory)
      .filter((name) => /\.png$/i.test(name) && !before.has(name))
      .sort();
    if (files.length > 0) {
      source = join(saveDirectory, files.at(-1));
      break;
    }
    await sleep(200);
  }
  if (!source) {
    throw new ControlPlaneError("XHS_RECOVERY_SCREEN_EMPTY", "XHS recovery inspection produced no screenshot", {
      status: 502,
    });
  }
  const target = join(evidenceDirectory, `xhs-recovery-${randomUUID()}.png`);
  renameSync(source, target);
  return target;
}

function parseFocus(raw) {
  const text = String(raw || "");
  const match = text.match(/([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)\/([A-Za-z0-9_.$]+)/);
  if (!match) return { package: null, activity: null };
  return {
    package: match[1],
    activity: match[2].startsWith(".") ? `${match[1]}${match[2]}` : match[2],
  };
}

async function focus(transport, serial) {
  const raw = await adbShell(
    transport,
    serial,
    "dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp'; dumpsys activity activities 2>/dev/null | grep -E 'mResumedActivity|topResumedActivity' | head -1",
    15000,
  );
  return { ...parseFocus(raw), raw: String(raw).slice(0, 300) };
}

async function dumpUi(transport, serial) {
  const remote = `/sdcard/xhs-bounded-${randomUUID()}.xml`;
  await adbShell(transport, serial, `uiautomator dump ${remote}`, 25000);
  let encoded = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    encoded = await adbShell(transport, serial, `base64 ${remote}`, 25000).catch(() => "");
    if (String(encoded).trim()) break;
    await sleep(350);
  }
  await adbShell(transport, serial, `rm -f ${remote}`, 8000).catch(() => {});
  const bytes = Buffer.from(String(encoded).replace(/\s+/g, ""), "base64");
  const bytePreservingXml = bytes.toString("latin1");
  if (!bytePreservingXml.includes("<hierarchy") || !bytePreservingXml.includes("</hierarchy>")) {
    throw new ControlPlaneError("XHS_DUMP_INVALID", "XHS bounded workflow received an invalid hierarchy", {
      status: 502,
    });
  }
  return { xml: bytes.toString("utf8"), nodes: parseNodes(bytePreservingXml) };
}

async function tap(transport, serial, target) {
  if (!target?.center || target.center.some((value) => !Number.isInteger(value))) {
    throw new ControlPlaneError("XHS_TAP_TARGET_INVALID", "XHS bounded workflow tap target is invalid", { status: 409 });
  }
  await adbShell(transport, serial, `input tap ${target.center[0]} ${target.center[1]}`, 10000);
}

async function back(transport, serial) {
  await adbShell(transport, serial, "input keyevent KEYCODE_BACK", 10000);
}

function requireSurface(actual, step, pattern) {
  if (actual.package !== PACKAGE || !pattern.test(String(actual.activity || ""))) {
    throw Object.assign(new Error(`unexpected XHS surface at ${step}`), {
      code: "XHS_SURFACE_MISMATCH",
      step,
      actualPackage: actual.package || null,
      actualActivity: actual.activity || null,
    });
  }
}

async function restoreDefaultIme(transport, serial) {
  const current = String(await adbShell(
    transport,
    serial,
    "settings get secure default_input_method",
    8000,
  ).catch(() => "")).trim();
  if (!current || current === DEFAULT_IME) return { restored: true, already: true, ime: current || null };
  if (current !== BRIDGE_IME) return { restored: true, already: true, ime: current };
  const response = await transport.invoke({
    action: "selectIme",
    devices: serial,
    data: { ime: DEFAULT_IME },
  }, { timeoutMs: 12000 });
  return { restored: response?.code === 10000, already: false, ime: DEFAULT_IME };
}

async function inputCaption(transport, serial, text, point) {
  const prior = String(await adbShell(transport, serial, "settings get secure default_input_method", 8000)).trim();
  const restore = async () => {
    if (!prior || prior === BRIDGE_IME) return restoreDefaultIme(transport, serial);
    const current = String(await adbShell(transport, serial, "settings get secure default_input_method", 8000)).trim();
    if (current === prior) return { restored: true, already: true, ime: current };
    const response = await transport.invoke({ action: "selectIme", devices: serial, data: { ime: prior } }, { timeoutMs: 12000 });
    return { restored: response?.code === 10000, already: false, ime: prior };
  };
  try {
    if (prior !== BRIDGE_IME) {
      const selected = await transport.invoke({ action: "selectIme", devices: serial, data: { ime: BRIDGE_IME } }, { timeoutMs: 12000 });
      if (selected?.code !== 10000) throw new Error("bridge IME selection failed");
      await sleep(400);
    }
    await tap(transport, serial, { center: point });
    await sleep(500);
    await adbShell(
      transport,
      serial,
      "input keyevent KEYCODE_MOVE_END " + Array(48).fill("KEYCODE_DEL").join(" "),
      10000,
    );
    const input = await transport.invoke({
      action: "inputText",
      devices: serial,
      data: { content: text },
    }, { timeoutMs: 15000 });
    if (input?.code !== 10000) throw new Error("caption input rejected");
    return { restore, inputAccepted: true };
  } catch (error) {
    await restore().catch(() => {});
    throw error;
  }
}

export async function restoreXhsPublishNoSave({ transport, device, maxSteps = 10 }) {
  if (!transport || typeof transport.invoke !== "function") {
    throw new ControlPlaneError("TYPED_TRANSPORT_REQUIRED", "XHS bounded workflow requires Xiaowei transport", {
      status: 403,
    });
  }
  const serial = device?.runtimeId;
  if (!serial) throw new ControlPlaneError("DEVICE_RUNTIME_MISSING", "XHS device runtime is missing", { status: 409 });
  const trace = [];
  let broughtToFront = false;
  for (let step = 0; step < maxSteps; step += 1) {
    const current = await focus(transport, serial);
    trace.push({ step, activity: current.activity || null });
    if (current.package === PACKAGE && /IndexActivity/i.test(String(current.activity || ""))) {
      const homePage = await dumpUi(transport, serial);
      const resumePrompt = findLabel(homePage.nodes, [/^继续编辑图文笔记吗[？?]?$/u]);
      if (resumePrompt) {
        const saveDraft = findLabel(homePage.nodes, [/^存草稿$/u]);
        if (saveDraft) trace.push({ step, observedNeverTapped: saveDraft.label });
        const goEdit = findLabel(homePage.nodes, [/^去编辑$/u], { clickable: true });
        if (!goEdit) {
          return {
            ok: false,
            restored: false,
            published: false,
            savedDraft: false,
            reason: "resume_dialog_unknown",
            trace,
          };
        }
        trace.push({ step, action: "resumeForDiscard", label: goEdit.label });
        await tap(transport, serial, goEdit);
        await sleep(1000);
        continue;
      }
      const ime = await restoreDefaultIme(transport, serial);
      return {
        ok: ime.restored === true,
        restored: true,
        imeRestored: ime.restored === true,
        published: false,
        savedDraft: false,
        trace,
      };
    }
    if (PERMISSION_PACKAGES.has(current.package)) {
      await back(transport, serial);
      await sleep(700);
      continue;
    }
    if (current.package !== PACKAGE || !PUBLISH_SURFACE.test(String(current.activity || ""))) {
      // A failed worker may leave the system launcher in front. Recovery may
      // bring the existing XHS task forward once, without force-stop or data
      // mutation, then re-apply the exact home/editor allowlist.
      if (!broughtToFront) {
        broughtToFront = true;
        trace.push({ step, action: "bringXhsToFront", priorPackage: current.package || null });
        await adbShell(
          transport,
          serial,
          `monkey -p ${PACKAGE} -c android.intent.category.LAUNCHER 1`,
          20000,
        );
        await sleep(1200);
        continue;
      }
      return {
        ok: false,
        restored: false,
        published: false,
        savedDraft: false,
        reason: "unexpected_surface",
        package: current.package || null,
        activity: current.activity || null,
        trace,
      };
    }
    const page = await dumpUi(transport, serial);
    trace.push({
      step,
      labels: page.nodes.map(label).filter(Boolean).slice(0, 16),
    });
    const commit = findLabel(page.nodes, [/^发布$/u, /^发笔记$/u, /^存草稿$/u, /^保存并退出$/u]);
    if (commit) trace.push({ step, observedNeverTapped: commit.label });
    const returnToEdit = findLabel(page.nodes, [/^返回编辑$/u], { clickable: true });
    const saveAndExit = findLabel(page.nodes, [/^保存并退出$/u]);
    if (returnToEdit && saveAndExit) {
      // XHS exposes this two-option menu on the final note editor. Saving is a
      // forbidden commit for dry-run. Returning to the preceding editor is a
      // navigation-only step and may expose the explicit no-save branch.
      trace.push({ step, safeNavigation: returnToEdit.label });
      await tap(transport, serial, returnToEdit);
      await sleep(850);
      continue;
    }
    const discard = findLabel(page.nodes, DISCARD_PATTERNS, { clickable: true });
    if (discard) {
      trace.push({ step, discard: discard.label });
      await tap(transport, serial, discard);
    } else {
      await back(transport, serial);
    }
    await sleep(850);
  }
  const current = await focus(transport, serial);
  const restored = current.package === PACKAGE && /IndexActivity/i.test(String(current.activity || ""));
  const ime = restored ? await restoreDefaultIme(transport, serial) : { restored: false };
  const output = {
    ok: restored && ime.restored === true,
    restored,
    imeRestored: ime.restored === true,
    published: false,
    savedDraft: false,
    activity: current.activity || null,
    trace,
  };
  if (!output.ok) {
    try {
      console.log(JSON.stringify({
        event: "xhs.publish.no-save-cleanup-failed",
        activity: output.activity,
        trace: trace.slice(-12),
        at: new Date().toISOString(),
      }));
    } catch {}
  }
  return output;
}

export async function runXhsPublishDiscardEditor({ transport, device }) {
  if (!transport || typeof transport.invoke !== "function") {
    throw new ControlPlaneError("TYPED_TRANSPORT_REQUIRED", "XHS bounded workflow requires Xiaowei transport", {
      status: 403,
    });
  }
  const serial = device?.runtimeId;
  if (!serial) throw new ControlPlaneError("DEVICE_RUNTIME_MISSING", "XHS device runtime is missing", { status: 409 });
  const cleanup = await restoreXhsPublishNoSave({ transport, device }).catch((error) => ({
    ok: false,
    restored: false,
    error: String(error?.message || error).slice(0, 240),
    published: false,
    savedDraft: false,
  }));
  const ok = cleanup.ok === true && cleanup.restored === true && cleanup.imeRestored !== false;
  return {
    ok,
    step: ok ? "discardedNoSave" : "discardFailed",
    workflowId: "workflow.xhs.publish-discard-editor.v1",
    published: false,
    savedDraft: false,
    finalCommit: false,
    paymentTransport: 0,
    restored: cleanup.restored === true,
    cleanup,
  };
}

export async function runXhsPublishEditDryRun({
  transport,
  device,
  title,
  body,
  caption,
  stayForAccept = false,
}) {
  const stay = stayForAccept === true;
  const { titleText, bodyText } = resolvePublishTextParams({ title, body, caption });
  const validation = validatePublishTextParams({ titleText, bodyText });
  if (!validation.ok) {
    return {
      ok: false,
      notSent: true,
      ambiguous: false,
      step: validation.step,
      published: false,
      savedDraft: false,
      finalCommit: false,
      paymentTransport: 0,
    };
  }
  if (!transport || typeof transport.invoke !== "function") {
    throw new ControlPlaneError("TYPED_TRANSPORT_REQUIRED", "XHS bounded workflow requires Xiaowei transport", {
      status: 403,
    });
  }
  const serial = device?.runtimeId;
  if (!serial) throw new ControlPlaneError("DEVICE_RUNTIME_MISSING", "XHS device runtime is missing", { status: 409 });

  const trace = [];
  let result = null;
  let restoreIme = null;
  const fail = (step, extra = {}) => {
    result = { ok: false, notSent: true, ambiguous: false, step, ...extra };
  };
  try {
    await adbShell(transport, serial, `am force-stop ${PACKAGE}`, 12000);
    await adbShell(transport, serial, `monkey -p ${PACKAGE} -c android.intent.category.LAUNCHER 1`, 20000);
    await sleep(2400);

    const preflightCleanup = await restoreXhsPublishNoSave({ transport, device });
    if (preflightCleanup?.restored !== true) {
      throw Object.assign(new Error("XHS preflight no-save cleanup failed"), {
        step: "preflightCleanupFailed",
        cleanupReason: preflightCleanup?.reason || null,
        cleanupActivity: preflightCleanup?.activity || null,
        cleanupTrace: Array.isArray(preflightCleanup?.trace) ? preflightCleanup.trace.slice(-12) : [],
      });
    }

    let page = await dumpUi(transport, serial);
    requireSurface(await focus(transport, serial), "publishHome", /IndexActivity/i);
    const publishTab = resolveHomePublishTab(page.nodes);
    if (!publishTab) {
      fail("publishTabMissing", {
        labels: page.nodes.map(label).filter(Boolean).slice(0, 30),
      });
    }
    if (!result) {
      trace.push({ step: "publishTab", label: publishTab.label });
      await tap(transport, serial, publishTab);
      await sleep(1700);
      page = await dumpUi(transport, serial);
      requireSurface(await focus(transport, serial), "publishSheet", /IndexActivity/i);
      const album = findLabel(page.nodes, [/^从相册选择$/u, /^相册$/u], { clickable: true });
      if (!album) fail("albumOptionMissing");
      if (!result) {
        trace.push({ step: "album", label: album.label });
        await tap(transport, serial, album);
        await sleep(1900);
      }
    }

    if (!result) {
      page = await dumpUi(transport, serial);
      let current = await focus(transport, serial);
      if (PERMISSION_PACKAGES.has(current.package)) {
        const permission = findLabel(page.nodes, [/^同意$/u, /^允许$/u, /^始终允许$/u, /允许访问/u], {
          clickable: true,
        });
        if (!permission) fail("permissionDialogUnknown", { package: current.package });
        if (!result) {
          trace.push({ step: "permission", label: permission.label });
          await tap(transport, serial, permission);
          await sleep(1200);
          page = await dumpUi(transport, serial);
          current = await focus(transport, serial);
        }
      }
      if (!result) requireSurface(current, "publishAlbum", /CapaAlbumActivity/i);
      const thumbs = page.nodes
        .filter((node) => {
          const point = center(node);
          const width = node.bounds[2] - node.bounds[0];
          const height = node.bounds[3] - node.bounds[1];
          return node.clickable && point && !node.text
            && width >= 200 && width <= 600 && height >= 200 && height <= 600
            && point[1] >= 250 && point[1] <= 1600;
        })
        .sort((left, right) => center(left)[1] - center(right)[1] || center(left)[0] - center(right)[0]);
      const thumb = thumbs[0];
      if (!result && !thumb) fail("albumThumbnailMissing");
      if (!result) {
        trace.push({ step: "thumbnail", candidates: thumbs.length });
        await tap(transport, serial, { center: center(thumb) });
        await sleep(1100);
        page = await dumpUi(transport, serial);
        const selectedSurface = await focus(transport, serial);
        requireSurface(
          selectedSurface,
          "publishAlbumSelected",
          /CapaAlbumActivity|CapaPostNotePlatformActivity|ImageEdit|MaterialPreview/i,
        );
        trace.push({ step: "thumbnailSelected", activity: selectedSurface.activity || null });
        if (/CapaAlbumActivity/i.test(String(selectedSurface.activity || ""))) {
          const next = findLabel(page.nodes, [/^下一步(?:\s*\(?\d+\)?)?$/u, /下一步/u], { clickable: true });
          if (!next) fail("nextMissingAfterSelect", { activity: selectedSurface.activity || null });
          if (!result) {
            trace.push({ step: "next", label: next.label });
            await tap(transport, serial, next);
            await sleep(2400);
          }
        } else {
          // Some XHS builds auto-advance immediately after selecting one media
          // item. The destination is still restricted to the known bounded
          // edit surfaces above; no coordinate or unknown-activity fallback.
          trace.push({ step: "albumAutoAdvanced", activity: selectedSurface.activity || null });
        }
      }
    }

    for (let index = 0; !result && index < 3; index += 1) {
      const page = await dumpUi(transport, serial);
      const current = await focus(transport, serial);
      requireSurface(current, `publishEdit${index}`, /CapaAlbumActivity|CapaPostNotePlatformActivity|ImageEdit|MaterialPreview/i);
      const post = findLabel(page.nodes, [/^发布$/u, /^发笔记$/u]);
      const captionMarker = page.nodes.some((node) => /添加标题|添加正文|说点什么|发语音|正文|话题/u.test(label(node)));
      const edit = page.nodes.find((node) => node.className === "android.widget.EditText"
        && (node.clickable || node.focusable) && center(node));
      if (captionMarker || (edit && post)) {
        if (!/CapaPostNotePlatformActivity/i.test(String(current.activity || ""))) {
          fail("captionSurfaceMismatch", { activity: current.activity || null });
          break;
        }
        const { titleField, bodyField } = findTitleAndBodyFields(page);
        if (titleText && !titleField?.center) {
          fail("titleFieldMissing");
          break;
        }
        if (bodyText && !bodyField?.center) {
          fail("bodyFieldMissing");
          break;
        }
        trace.push({
          step: "captionPage",
          postButtonObserved: Boolean(post),
          titleField: titleField?.label || null,
          bodyField: bodyField?.label || null,
        });
        if (titleText) {
          await inputCaption(transport, serial, titleText, titleField.center);
          await sleep(700);
        }
        if (bodyText) {
          const input = await inputCaption(transport, serial, bodyText, bodyField.center);
          restoreIme = input.restore;
          await sleep(900);
        }
        const verify = await dumpUi(transport, serial);
        const titleLanded = textLanded(verify, titleText);
        const bodyLanded = textLanded(verify, bodyText);
        const postAfter = findLabel(verify.nodes, [/^发布$/u, /^发笔记$/u]);
        const filled = titleLanded && bodyLanded && Boolean(postAfter);
        result = {
          ok: filled,
          notSent: true,
          ambiguous: false,
          step: filled ? "editorFilled" : "editorVerificationFailed",
          titleLanded,
          bodyLanded,
          captionLanded: bodyLanded,
          postButtonObserved: Boolean(postAfter),
        };
        break;
      }
      const next = findLabel(page.nodes, [/^下一步(?:\s*\(?\d+\)?)?$/u, /下一步/u], { clickable: true });
      if (next && !post) {
        trace.push({ step: "nextAgain", label: next.label });
        await tap(transport, serial, next);
        await sleep(2400);
        continue;
      }
      fail("captionPageNotReached", { postButtonObserved: Boolean(post) });
    }
    if (!result) fail("captionPageNotReached");
  } catch (error) {
    fail(error?.step || "exception", {
      error: String(error?.message || error).slice(0, 240),
      package: error?.actualPackage || null,
      activity: error?.actualActivity || null,
      cleanupReason: error?.cleanupReason || null,
      cleanupActivity: error?.cleanupActivity || null,
      cleanupTrace: Array.isArray(error?.cleanupTrace) ? error.cleanupTrace : undefined,
    });
  }

  if (result?.ok === true && stay) {
    return {
      ...result,
      ok: true,
      step: "awaitingAccept",
      stayForAccept: true,
      awaitingAccept: true,
      workflowId: "workflow.xhs.publish-edit-dry-run.v1",
      transportMode: "control-plane-fifo-single-flight",
      published: false,
      savedDraft: false,
      finalCommit: false,
      paymentTransport: 0,
      restored: false,
      cleanup: { deferred: true, reason: "stayForAccept" },
      trace,
    };
  }

  const cleanup = await restoreXhsPublishNoSave({ transport, device }).catch((error) => ({
    ok: false,
    restored: false,
    error: String(error?.message || error).slice(0, 240),
    published: false,
    savedDraft: false,
  }));
  if (restoreIme) await restoreIme().catch(() => {});
  const ok = result?.ok === true && cleanup.restored === true && cleanup.imeRestored !== false;
  return {
    ...result,
    ok,
    step: ok ? "completedNoSave" : (result?.step || "cleanupFailed"),
    workflowId: "workflow.xhs.publish-edit-dry-run.v1",
    transportMode: "control-plane-fifo-single-flight",
    published: false,
    savedDraft: false,
    finalCommit: false,
    paymentTransport: 0,
    restored: cleanup.restored === true,
    cleanup,
    trace,
  };
}
