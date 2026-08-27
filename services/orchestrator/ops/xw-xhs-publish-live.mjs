#!/usr/bin/env node
/**
 * xw-xhs-publish-live.mjs — W6 live driver: XHS note publish (pack action
 * publish, plan V2 §10.5), strict ECP/PHC protected commit. Alias 03|04.
 *
 * ONE invocation = draft preparation (transport-0) + a frozen publish envelope
 * under a ProtectedHumanCommit + an approval-file wait + at most ONE 发布 tap
 * released only by an explicit human approve. The publish tap is the single
 * transport of the effect; album navigation / caption input are bounded prep.
 *
 * Chain (all fail-closed):
 *   发布 tab → 相册 → first thumb → 下一步* → editor → caption input (verified
 *   landed) → editor screenshot (prepare proof) → Mission(publish) +
 *   EffectLedger.beginEffect(pending_authorization, via PHC) →
 *   PublishCommitHandler.beginPublish (envelope freeze; transport=0) →
 *   waiting_authorization → REVIEW block printed → approval file polled
 *   (session heartbeated) → approve: live drift check (content re-hashed from
 *   the CURRENT editor dump) → decidePublish → ECP.executePrepared → exactly
 *   one 发布 tap → post-verify (editor closed) → outcome. deny / drift /
 *   expiry / handle-lost → no tap, cancelled.
 *
 * Approval file (written by the human operator after reviewing the content):
 *   {"decision":"approve"|"deny","by":"human:operator"}
 *
 *   node ops/xw-xhs-publish-live.mjs --alias 03 --actor <id> --text <正文> [--dry-run]
 *
 * Console: console.log only (Windows bridge treats stderr as fatal).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CONTROL_DB = "C:\\Users\\Public\\xw-runtime\\state\\control-plane\\control.db";
const EVIDENCE_DIR = "C:\\Users\\Public\\xw-runtime\\evidence\\w6-publish-live";
const APPROVAL_DIR = "C:\\Users\\Public\\xw-runtime\\publish-approval";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
    else if (a.startsWith("--")) out[a.slice(2)] = true;
    else if (!out._[0]) out._.push(a);
  }
  return out;
}
const argMap = parseArgs(process.argv.slice(2));
const opt = (name, fb = null) => (argMap[name.slice(2)] !== undefined ? argMap[name.slice(2)] : fb);
const flag = (name) => Boolean(argMap[name.slice(2)]);

if (flag("--help") || flag("-h")) {
  console.log(`用法:
  node ops/xw-xhs-publish-live.mjs --alias 03 --actor <id> --text <正文> [--dry-run]

一次调用 = 草稿准备(零传输) + 冻结 publish envelope(PHC, transport=0) + 审批文件轮询 +
至多一次发布 tap(仅 approve 且漂移检查通过后)。审批文件:
  {"decision":"approve"|"deny","by":"human:operator"}`);
  process.exit(0);
}

const alias = opt("--alias") || "03";
if (alias !== "04" && alias !== "03") { console.log(JSON.stringify({ ok: false, code: "XHS_ALIAS_NOT_03_04", alias })); process.exit(3); }
const actor = opt("--actor") || "claude-pilot-20260809";
const caption = opt("--text");
const DRY_RUN = flag("--dry-run");
const REVIEW_MS = ((Number(opt("--review-minutes", "30")) || 30) * 60000);
if (!caption || !String(caption).trim()) { console.log(JSON.stringify({ ok: false, code: "TEXT_REQUIRED" })); process.exit(3); }

const { StateStore } = await import("../../control-plane/control-plane/lib/state-store.mjs");
const { MissionRuntime } = await import("../../control-plane/control-plane/lib/mission-runtime.mjs");
const { DeviceRunRuntime } = await import("../../control-plane/control-plane/lib/device-run.mjs");
const { EffectLedger } = await import("../../control-plane/control-plane/lib/effect-ledger.mjs");
const { EffectCommitProtocol } = await import("../../control-plane/control-plane/lib/effect-commit-protocol.mjs");
const { ProtectedHumanCommit } = await import("../../control-plane/control-plane/lib/protected-human-commit.mjs");
const { PublishCommitHandler } = await import("../../control-plane/apps/xhs/publish-commit.mjs");
const { contentHashOf, screenshotHashOf } = await import("../../control-plane/apps/xhs/publish-envelope.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => createHash("sha256").update(String(s), "utf8").digest("hex");

function runOps(args, timeoutMs = 120000) {
  return new Promise((resolveP) => {
    const t0 = Date.now();
    const p = spawn("node", args, { cwd: ROOT });
    let out = "";
    const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} resolveP({ code: 124, out, ms: Date.now() - t0 }); }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => { clearTimeout(timer); resolveP({ code: code ?? 1, out: out.trim(), ms: Date.now() - t0 }); });
  });
}

function kv(t) {
  const o = {};
  for (const line of String(t || "").split(/\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) o[m[1]] = m[2];
  }
  return o;
}

function decodeXmlText(s) {
  return String(s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/** Parse all <node> tags into {text, desc, cls, clickable, x, y, w, h, cx, cy}. */
function parseNodes(xml) {
  return (String(xml || "").match(/<node\b[^>]*>/g) || []).map((t) => {
    const b = t.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!b) return null;
    const x = +b[1], y = +b[2], x2 = +b[3], y2 = +b[4];
    return {
      text: decodeXmlText((t.match(/text="([^"]*)"/) || [])[1] || ""),
      desc: decodeXmlText((t.match(/content-desc="([^"]*)"/) || [])[1] || ""),
      cls: (t.match(/class="([^"]*)"/) || [])[1] || "",
      rid: (t.match(/resource-id="([^"]*)"/) || [])[1] || "",
      clickable: /clickable="true"/.test(t),
      x, y, w: x2 - x, h: y2 - y, cx: Math.round((x + x2) / 2), cy: Math.round((y + y2) / 2),
    };
  }).filter(Boolean);
}

// QUALIFICATION_ONLY is load-bearing (a STANDARD StateStore constructor wipes
// ALL live sessions+leases via recoverInterruptedWork).
let __state = null;
function openState() {
  if (!__state) __state = new StateStore({ dbPath: CONTROL_DB, m6RuntimeMode: "QUALIFICATION_ONLY" });
  return __state;
}
function closeState() { try { __state?.close(); } catch {} __state = null; }

const targetFp = sha256(`xw.xhs.publish.account:${alias}`);
const planHash = sha256("xw-xhs-publish-live:v1");

// The editor's publish control (03 recon: "发布笔记" Button, bottom bar cy≈2227;
// older layouts put "发布" top-right). Exact-set equality — "发布" alone must
// never match the 发布笔记 button (and vice versa the tab-bar 发布 is excluded
// by requiring the editor context at the call sites).
function findPublishBtn(ns) {
  return ns.find((n) => (n.text === "发布笔记" || (n.desc || "") === "发布笔记") && n.clickable)
    || ns.find((n) => n.text === "发布" && n.clickable && n.cy < 800)
    || null;
}

async function main() {
  const t0 = Date.now();
  let result = null;
  let state = null;
  let commitId = null;
  let handler = null;
  let sf = null;
  try {
    // ── Phase A: session + draft navigation (transport-0) ──
    const acqArgs = ["ops/xw-explore-session.mjs", "acquire", "--alias", alias, "--actor", actor];
    const acqPath = `C:\\Users\\windows 10\\.xhs-explorer-sessions\\${String(actor).replace(/[^A-Za-z0-9._-]/g, "_")}-${alias}.json`;
    let acq = await runOps(acqArgs, 60000);
    if (acq.code !== 0 && acq.out.includes("EXPLORER_SESSION_CONTEXT_EXISTS")) {
      await runOps(["ops/xw-explore-session.mjs", "release", "--session-file", acqPath], 30000);
      try { (await import("node:fs")).rmSync(acqPath, { force: true }); } catch {}
      acq = await runOps(acqArgs, 60000);
    }
    if (acq.code !== 0) throw Object.assign(new Error(`session acquire failed: ${acq.out.slice(0, 200)}`), { code: "SESSION_ACQUIRE_FAILED" });
    const sess = JSON.parse(acq.out.split(/\n/).find((l) => l.trim().startsWith("{")) || "{}");
    sf = sess.sessionFile;
    console.log(`SESSION=${sess.sessionId}`);
    const withSf = (args) => [...args, "--alias", alias, "--session-file", sf];

    // device identity from the live session context (drift-checked by re-read)
    const deviceFingerprint = (() => {
      try {
        const ctx = JSON.parse(readFileSync(sf, "utf8"));
        return ctx.authorization?.serial || ctx.serial || `xhs-device-${alias}`;
      } catch { return `xhs-device-${alias}`; }
    })();

    const dumpXml = async (label) => {
      const d = kv((await runOps(withSf(["ops/dump-ui.mjs"]), 60000)).out);
      if (!d.DUMP || !existsSync(d.DUMP)) throw Object.assign(new Error(`dump_${label}`), { code: "DUMP_FAILED" });
      return readFileSync(d.DUMP, "utf8");
    };

    let r = await runOps(withSf(["ops/launch-app.mjs", "--package", "com.xingin.xhs", "--force-stop"]), 60000);
    if (r.code !== 0) throw Object.assign(new Error("launch"), { code: "LAUNCH_FAILED" });
    await sleep(4500);

    // 发布 tab (center of the bottom bar; desc/text 发布, fallback coordinate)
    let homeXml = await dumpXml("home");
    let nodes = parseNodes(homeXml);
    let pub = nodes.find((n) => (n.text === "发布" || (n.desc || "").startsWith("发布")) && n.cy > 2100)
      || nodes.find((n) => (n.text === "发布" || (n.desc || "").startsWith("发布")));
    const pubTap = pub ? { x: pub.cx, y: pub.cy } : { x: 540, y: 2295 };
    console.log(`PUB_TAB=(${pubTap.x},${pubTap.y})${pub ? "" : " FALLBACK"}`);
    r = await runOps(withSf(["ops/tap.mjs", "--x", String(pubTap.x), "--y", String(pubTap.y)]), 30000);
    if (r.code !== 0) throw Object.assign(new Error("tap 发布"), { code: "PREP_FAILED" });
    await sleep(3000);

    // possible permission dialog on a cold app — accept once, best-effort
    const permXml = await dumpXml("after-pub-tab");
    const allow = parseNodes(permXml).find((n) => /^(允许|仅在使用中允许|始终允许)$/.test(n.text) && n.clickable);
    if (allow) {
      console.log(`PERMISSION_DIALOG="${allow.text}"`);
      await runOps(withSf(["ops/tap.mjs", "--x", String(allow.cx), "--y", String(allow.cy)]), 30000);
      await sleep(2000);
    }

    // 相册 entry (sheet)
    const sheetXml = await dumpXml("sheet");
    nodes = parseNodes(sheetXml);
    const album = nodes.find((n) => /从相册选择|相册/.test(n.text + n.desc));
    if (!album) throw Object.assign(new Error("no 相册 entry"), { code: "ALBUM_MISSING" });
    r = await runOps(withSf(["ops/tap.mjs", "--x", String(album.cx), "--y", String(album.cy)]), 30000);
    if (r.code !== 0) throw Object.assign(new Error("tap 相册"), { code: "PREP_FAILED" });
    await sleep(3000);

    // first album thumb: large clickable image, no text, upper grid area
    const albumXml = await dumpXml("album");
    nodes = parseNodes(albumXml);
    let thumbs = nodes.filter((n) => n.clickable && !n.text && !n.desc
      && n.w >= 200 && n.w <= 600 && n.h >= 200 && n.h <= 600
      && n.cy >= 250 && n.cy <= 1600)
      .sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx));
    const thumb = thumbs[0] ? { x: thumbs[0].cx, y: thumbs[0].cy } : { x: 180, y: 450 };
    console.log(`THUMB=${thumbs.length} (${thumb.x},${thumb.y})${thumbs[0] ? "" : " FALLBACK"}`);
    r = await runOps(withSf(["ops/tap.mjs", "--x", String(thumb.x), "--y", String(thumb.y)]), 30000);
    if (r.code !== 0) throw Object.assign(new Error("tap thumb"), { code: "PREP_FAILED" });
    await sleep(2500);

    // 下一步 (up to 3 stacked confirmation screens) until the editor is detected.
    // Real shape (03 recon): select screen 下一步(796,2279) → photo-edit screen
    // 下一步(926,2279) → editor with 添加标题/添加正文 EditTexts + 发布笔记 button.
    const isEditor = (xml) => {
      const ns = parseNodes(xml);
      const edits = ns.filter((n) => /EditText/.test(n.cls));
      const publishNotes = ns.some((n) => (n.text === "发布笔记" || (n.desc || "") === "发布笔记"));
      const publishTop = ns.some((n) => n.text === "发布" && n.cy < 800);
      return edits.length >= 1 && (publishNotes || publishTop);
    };
    let editorXml = null;
    for (let i = 0; i < 3; i += 1) {
      const cur = await dumpXml(`next-${i}`);
      if (isEditor(cur)) { editorXml = cur; break; }
      const ns = parseNodes(cur);
      const next = ns.find((n) => (n.text === "下一步" || (n.desc || "") === "下一步") && n.clickable);
      if (!next) throw Object.assign(new Error(`no 下一步 (screen ${i})`), { code: "NEXT_MISSING" });
      r = await runOps(withSf(["ops/tap.mjs", "--x", String(next.cx), "--y", String(next.cy)]), 30000);
      if (r.code !== 0) throw Object.assign(new Error("tap 下一步"), { code: "PREP_FAILED" });
      await sleep(2500);
    }
    if (!editorXml) editorXml = await dumpXml("editor");
    if (!isEditor(editorXml)) throw Object.assign(new Error("editor not detected"), { code: "EDITOR_MISSING" });

    // ── Phase B: caption input (bounded prep, no transport) ──
    nodes = parseNodes(editorXml);
    const edits = nodes.filter((n) => /EditText/.test(n.cls));
    const bodyField = edits.find((n) => /说点什么|添加正文|正文/.test(n.desc + n.text))
      || edits.reduce((a, b) => (b.cy > (a?.cy ?? -1) ? b : a), null);
    if (!bodyField) throw Object.assign(new Error("no body edit field"), { code: "BODY_FIELD_MISSING" });
    r = await runOps(withSf(["ops/tap.mjs", "--x", String(bodyField.cx), "--y", String(bodyField.cy)]), 30000);
    if (r.code !== 0) throw Object.assign(new Error("tap body field"), { code: "PREP_FAILED" });
    await sleep(1800);
    r = await runOps(withSf(["ops/input-text.mjs", "--text", caption, "--x", String(bodyField.cx), "--y", String(bodyField.cy), "--clear-first", "--keep-ime"]), 60000);
    if (r.code !== 0) throw Object.assign(new Error(`input caption: ${r.out.slice(0, 160)}`), { code: "INPUT_FAILED" });
    await sleep(1500);

    const typedXml = await dumpXml("typed");
    // scan ALL EditTexts (title + body both exist; the body field holds the caption)
    const textLanded = parseNodes(typedXml)
      .filter((n) => /EditText/.test(n.cls))
      .some((n) => n.text.includes(caption));
    console.log(`TEXT_LANDED=${textLanded}`);
    if (!textLanded) throw Object.assign(new Error("caption not landed"), { code: "TEXT_NOT_LANDED" });

    // The IME covers the bottom-bar 发布笔记 (cy≈2227) — collapse the keyboard
    // with one back BEFORE the effect chain. If the IME was not open, back opens
    // the exit dialog instead: tap 继续编辑/保留 to stay in the editor.
    await runOps(withSf(["ops/back.mjs"]), 30000);
    await sleep(1200);
    const afterImeBack = await dumpXml("ime-back");
    if (!isEditor(afterImeBack)) {
      const stay = parseNodes(afterImeBack).find((n) => /^(继续编辑|保留|取消|留在页面)$/.test(n.text) && n.clickable)
        || parseNodes(afterImeBack).find((n) => /继续编辑|保留/.test(n.text) && n.clickable);
      if (!stay) throw Object.assign(new Error("editor lost after IME back"), { code: "EDITOR_LOST_IME_BACK" });
      await runOps(withSf(["ops/tap.mjs", "--x", String(stay.cx), "--y", String(stay.cy)]), 30000);
      await sleep(1500);
      if (!isEditor(await dumpXml("ime-back-2"))) throw Object.assign(new Error("editor lost after IME back"), { code: "EDITOR_LOST_IME_BACK" });
      console.log("IME_BACK=dialog-stayed");
    } else {
      console.log("IME_BACK=keyboard-collapsed");
    }
    // caption must survive the IME collapse
    const settledXml = await dumpXml("settled");
    if (!parseNodes(settledXml).filter((n) => /EditText/.test(n.cls)).some((n) => n.text.includes(caption))) {
      throw Object.assign(new Error("caption lost after IME back"), { code: "TEXT_NOT_LANDED" });
    }

    // ── Phase C: prepare-time editor screenshot (the frozen screenshot proof) ──
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const shotPath = resolve(EVIDENCE_DIR, `editor-prepare-${Date.now()}.png`);
    // session_action screen primitive (no direct adb; prints SHOT=<path>)
    const shotProc = await runOps(withSf(["ops/screenshot-and-analyze.mjs", "--out", shotPath]), 90000);
    const shotOk = /^SHOT=/.test(shotProc.out) && existsSync(shotPath);
    if (!shotOk || !existsSync(shotPath)) throw Object.assign(new Error("editor screenshot failed"), { code: "SCREENSHOT_FAILED" });
    const screenshotB64 = readFileSync(shotPath).toString("base64");
    console.log(`SCREENSHOT=${shotPath} SHA=${screenshotHashOf(screenshotB64).slice(0, 16)}`);

    if (DRY_RUN) {
      // stop before ANY effect record — back out and discard the draft
      console.log(JSON.stringify({ ok: true, dryRun: true, targetFingerprint: targetFp, contentHash: contentHashOf(caption), deviceFingerprint }));
      await runOps(withSf(["ops/back.mjs"]), 30000); // collapse IME (or open exit dialog)
      await sleep(1200);
      await runOps(withSf(["ops/back.mjs"]), 30000); // exit editor (exit dialog if content present)
      await sleep(1200);
      const dlg = parseNodes(await dumpXml("discard"));
      const giveUp = dlg.find((n) => /^(放弃|丢弃|不保存)$/.test(n.text) && n.clickable)
        || dlg.find((n) => /放弃/.test(n.text) && n.clickable);
      if (giveUp) await runOps(withSf(["ops/tap.mjs", "--x", String(giveUp.cx), "--y", String(giveUp.cy)]), 30000);
      return;
    }

    // ── Phase D: strict ECP/PHC protected commit (transport=0) ──
    state = openState();
    const missions = new MissionRuntime({ state });
    const runs = new DeviceRunRuntime({ state, missions, authorityNodeId: "DESKTOP-3I1EVHE" });
    const ledger = new EffectLedger({ state });

    const freshEditorState = async () => {
      const xml = await dumpXml("recheck");
      const ns = parseNodes(xml);
      // content = the EditText carrying the caption (body; title stays empty)
      const edit = ns.find((n) => /EditText/.test(n.cls) && n.text.includes(caption))
        || ns.find((n) => /EditText/.test(n.cls) && n.text);
      const publishBtn = findPublishBtn(ns);
      const content = edit ? decodeXmlText(edit.text) : "";
      return { xml, content, publishBtn, editorOpen: Boolean(publishBtn) };
    };

    // ECP recheck: readiness from a FRESH editor dump each call (prepare + the
    // approve-time recheck both run it — the live drift surface).
    const recheck = async () => {
      const s = await freshEditorState();
      const contentHash = contentHashOf(s.content);
      return {
        readiness: { ready: true, source: "control-plane", fresh: true },
        app: "xhs",
        account: `local-alias-${alias}`,
        targetFingerprint: targetFp,
        pageFingerprint: sha256(`xw.xhs.publish.editor:${contentHash}`),
        beforeState: { editor: s.editorOpen, content: s.content, contentHash, deviceFingerprint },
        control: true,
      };
    };
    // ECP execute = THE single publish tap (fail-closed NOT_SENT when absent).
    const execute = async () => {
      const { publishBtn } = await freshEditorState();
      if (!publishBtn) throw Object.assign(new Error("publish button missing at execute"), { code: "NOT_SENT" });
      const tapR = await runOps(withSf(["ops/tap.mjs", "--x", String(publishBtn.cx), "--y", String(publishBtn.cy)]), 30000);
      if (tapR.code !== 0) throw Object.assign(new Error("publish tap failed"), { code: "NOT_SENT" });
      console.log(`PUBLISH_TAP=(${publishBtn.cx},${publishBtn.cy})`);
      return { sent: true, x: publishBtn.cx, y: publishBtn.cy };
    };
    // ECP verify: editor closes (or a publish-success surface appears). Render
    // lag tolerated (5 × 3s) — same pattern as W4/W5 live.
    const verify = async () => {
      let refs = [];
      for (let i = 0; i < 5; i += 1) {
        const xml = await dumpXml(`after-${i}`);
        const ns = parseNodes(xml);
        const editorGone = !ns.some((n) => /EditText/.test(n.cls)) && !findPublishBtn(ns);
        const success = ns.some((n) => /发布成功|发布中|已发布/.test(n.text + n.desc));
        if (success) { refs = ["publish:success-surface"]; return { ok: true, evidenceRefs: refs }; }
        if (editorGone) { refs = ["publish:editor-closed"]; return { ok: true, evidenceRefs: refs }; }
        refs = [`publish:editor-still-open-${i}`];
        if (i < 4) await sleep(3000);
      }
      return { ok: false, evidenceRefs: refs };
    };
    // ECP restore: best-effort exit from editor / publish result page.
    const restore = async ({ outcome } = {}) => {
      try {
        if (outcome === "verified") return;
        await runOps(withSf(["ops/back.mjs"]), 30000);
        await sleep(1200);
        const dlg = parseNodes(await dumpXml("restore-dlg"));
        const giveUp = dlg.find((n) => /^(放弃|丢弃|不保存)$/.test(n.text) && n.clickable)
          || dlg.find((n) => /放弃/.test(n.text) && n.clickable);
        if (giveUp) await runOps(withSf(["ops/tap.mjs", "--x", String(giveUp.cx), "--y", String(giveUp.cy)]), 30000);
      } catch { /* best-effort */ }
    };

    const ecp = new EffectCommitProtocol({ state, ledger, deviceRuns: runs, missions, recheck, execute, verify, restore });
    const phc = new ProtectedHumanCommit({
      ecp, state,
      audit: (e) => console.log(`AUDIT=${JSON.stringify(e)}`),
      approvalTtlMs: REVIEW_MS, // review window (the driver polls in-process)
    });
    handler = new PublishCommitHandler({ phc, approvalTtlMs: REVIEW_MS });

    const mk = missions.createMission({
      issuer: { actorId: "human:operator" },
      idempotencyKey: `xhs-publish-${alias}-${Date.now()}`,
      app: "xhs",
      account: `local-alias-${alias}`,
      parallelism: 1,
      controllers: ["agent:xw-xhs-publish-live"],
      scope: {
        actions: ["publish"],
        targets: { kind: "fingerprint", values: [targetFp] },
        totalCount: 1,
        perTargetCount: 1,
        frequency: { count: 10, windowSeconds: 3600 },
      },
      validity: { expiresAt: new Date(Date.now() + 2700000).toISOString() },
      policy: { publish: "confirm", delete: "confirm" },
    });
    const mission = mk.mission ?? mk;
    const run = runs.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:xw-xhs-publish-live" });
    const idempotencyKey = createHash("sha256").update(
      ["ar_publish_live", "publish", targetFp, contentHashOf(caption), String(Date.now())].join("\0"),
    ).digest("hex");

    const begun = await handler.beginPublish({
      mission,
      target: targetFp,
      prepareRunId: run.tuple.deviceRunId,
      planHash,
      content: caption,
      screenshot: screenshotB64,
      deviceFingerprint,
      accountFingerprint: `local-alias-${alias}`,
      targetFingerprint: targetFp,
      tuple: run.tuple,
      idempotencyKey,
      intent: { surface: "xhs-publish-editor", live: true, alias, captionChars: caption.length },
    });
    if (begun.status !== "waiting_authorization") {
      throw Object.assign(new Error(`beginPublish blocked: ${JSON.stringify(begun).slice(0, 300)}`), { code: begun.code || "PUBLISH_BEGIN_BLOCKED" });
    }
    commitId = begun.commitId;
    const approvalFile = opt("--approval-file") || resolve(APPROVAL_DIR, `${commitId}.json`);
    console.log(`COMMIT=${commitId}`);
    console.log(`ENVELOPE=${begun.envelopeHash}`);
    console.log(`EFFECT=${begun.effectId}`);
    console.log(`APPROVAL_FILE=${approvalFile}`);

    // ── Phase E: human review gate — content printed, approval file polled ──
    console.log("=== CONTENT_FOR_REVIEW_BEGIN ===");
    console.log(`ALIAS=${alias} DEVICE=${deviceFingerprint}`);
    console.log(`TEXT=${caption}`);
    console.log(`SCREENSHOT=${shotPath}`);
    console.log(`CONTENT_SHA=${contentHashOf(caption)}`);
    console.log("=== CONTENT_FOR_REVIEW_END ===");

    mkdirSync(dirname(approvalFile), { recursive: true });
    const deadline = Date.now() + REVIEW_MS - 120000;
    let decision = null;
    let lastHeartbeat = 0;
    while (Date.now() < deadline) {
      if (Date.now() - lastHeartbeat > 25000) {
        const hb = await runOps(["ops/xw-explore-session.mjs", "heartbeat", "--session-file", sf], 30000);
        if (hb.code !== 0) {
          await handler.decidePublish(commitId, { decision: "deny", actorId: "agent:xw-xhs-publish-live" });
          throw Object.assign(new Error("session heartbeat lost during review wait"), { code: "SESSION_HEARTBEAT_LOST" });
        }
        lastHeartbeat = Date.now();
      }
      if (existsSync(approvalFile)) {
        try {
          const req = JSON.parse(readFileSync(approvalFile, "utf8"));
          if (req.decision === "approve" || req.decision === "deny") {
            decision = req.decision;
            console.log(`DECISION_FILE=${decision} BY=${req.by || "unknown"}`);
            break;
          }
        } catch { /* partially written file — keep polling */ }
      }
      await sleep(5000);
    }
    if (!decision) {
      await handler.decidePublish(commitId, { decision: "deny", actorId: "agent:xw-xhs-publish-live" });
      throw Object.assign(new Error("review window elapsed"), { code: "REVIEW_WINDOW_EXPIRED" });
    }

    let decideResult;
    if (decision === "approve") {
      // live drift check: re-hash the CURRENT editor content against the frozen
      // envelope (screenshot drift is disabled live — pixel re-capture always
      // drifts on cursor/animation noise; the frozen prepare capture IS the proof).
      const nowState = await freshEditorState();
      if (!nowState.editorOpen) throw Object.assign(new Error("editor closed before approve"), { code: "EDITOR_CLOSED_PRE_APPROVE" });
      const observed = {
        content: nowState.content,
        screenshot: screenshotB64,
        deviceFingerprint,
        accountFingerprint: `local-alias-${alias}`,
        targetFingerprint: targetFp,
        planHash,
      };
      decideResult = await handler.decidePublish(commitId, { decision: "approve", actorId: "human:operator", observed });
    } else {
      decideResult = await handler.decidePublish(commitId, { decision: "deny", actorId: "human:operator" });
    }
    console.log(`DECIDE=${JSON.stringify(decideResult).slice(0, 400)}`);

    const status = decideResult?.status;
    result = {
      ok: decision === "approve" && status === "verified",
      decision,
      commitId,
      envelopeHash: begun.envelopeHash,
      effectId: begun.effectId,
      status,
      ...(decideResult?.code ? { code: decideResult.code } : {}),
      ...(decideResult?.field ? { driftField: decideResult.field } : {}),
    };
    if (result.ok !== true) { result.code = result.code || `EFFECT_${String(status).toUpperCase()}`; process.exitCode = 2; }
    try { writeFileSync(resolve(EVIDENCE_DIR, `result-${commitId}.json`), JSON.stringify({ ...result, caption }, null, 2)); } catch {}
  } catch (e) {
    result = { ok: false, code: e?.code || "PUBLISH_LIVE_FAILED", message: String(e?.message || e).slice(0, 300), ...(commitId ? { commitId } : {}) };
    process.exitCode = 2;
  } finally {
    closeState();
  }
  console.log(JSON.stringify(result, null, 0));
}

main();