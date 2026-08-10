import { randomUUID } from "node:crypto";

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
  return String(value)
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
  const xml = Buffer.from(String(encoded).replace(/\s+/g, ""), "base64").toString("utf8");
  if (!xml.includes("<hierarchy") || !xml.includes("</hierarchy>")) {
    throw new ControlPlaneError("XHS_DUMP_INVALID", "XHS bounded workflow received an invalid hierarchy", {
      status: 502,
    });
  }
  return { xml, nodes: parseNodes(xml) };
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
    const commit = findLabel(page.nodes, [/^发布$/u, /^发笔记$/u, /^存草稿$/u]);
    if (commit) trace.push({ step, observedNeverTapped: commit.label });
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

export async function runXhsPublishEditDryRun({ transport, device, caption }) {
  const text = String(caption || "").trim();
  if (!text || text.length > 300) {
    return {
      ok: false,
      notSent: true,
      ambiguous: false,
      step: "captionInvalid",
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
        requireSurface(await focus(transport, serial), "publishAlbumSelected", /CapaAlbumActivity/i);
        const next = findLabel(page.nodes, [/^下一步(?:\s*\(?\d+\)?)?$/u, /下一步/u], { clickable: true });
        if (!next) fail("nextMissingAfterSelect");
        if (!result) {
          trace.push({ step: "next", label: next.label });
          await tap(transport, serial, next);
          await sleep(2400);
        }
      }
    }

    for (let index = 0; !result && index < 3; index += 1) {
      const page = await dumpUi(transport, serial);
      const current = await focus(transport, serial);
      requireSurface(current, `publishEdit${index}`, /CapaAlbumActivity|CapaPostNotePlatformActivity|ImageEdit|MaterialPreview/i);
      const edit = page.nodes.find((node) => node.className === "android.widget.EditText"
        && (node.clickable || node.focusable) && center(node));
      const post = findLabel(page.nodes, [/^发布$/u, /^发笔记$/u]);
      const captionMarker = page.nodes.some((node) => /添加标题|添加正文|说点什么|正文|话题/u.test(label(node)));
      if (captionMarker || (edit && post)) {
        if (!/CapaPostNotePlatformActivity/i.test(String(current.activity || ""))) {
          fail("captionSurfaceMismatch", { activity: current.activity || null });
          break;
        }
        const field = edit
          ? { center: center(edit), label: "EditText" }
          : findLabel(page.nodes, [/添加正文/u, /说点什么/u, /^正文$/u], { clickable: true });
        if (!field?.center) {
          fail("captionFieldMissing");
          break;
        }
        trace.push({ step: "captionPage", postButtonObserved: Boolean(post), field: field.label });
        const input = await inputCaption(transport, serial, text, field.center);
        restoreIme = input.restore;
        await sleep(900);
        const verify = await dumpUi(transport, serial);
        const landed = verify.xml.includes(text)
          || verify.nodes.some((node) => String(node.text || "").includes(text.slice(0, Math.min(6, text.length))));
        const postAfter = findLabel(verify.nodes, [/^发布$/u, /^发笔记$/u]);
        result = {
          ok: landed && Boolean(postAfter),
          notSent: true,
          ambiguous: false,
          step: landed && postAfter ? "captionFilled" : "captionVerificationFailed",
          captionLanded: landed,
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
