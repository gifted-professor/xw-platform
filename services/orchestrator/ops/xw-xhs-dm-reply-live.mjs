#!/usr/bin/env node
/**
 * xw-xhs-dm-reply-live.mjs — W5 live canary driver: bound DM reply on alias
 * 03|04 (pack action reply, plan V2 §6 S3), strict-mission ECP wiring.
 *
 * One invocation = one STRICT Mission (action=reply, targets=[thread hash],
 * totalCount=1, perTargetCount=1). The send-tap is the single transport; inbox
 * navigation / thread entry / composer input are bounded preparation.
 *
 * Pre-send gates (apps/xhs/dm-verifier.mjs decideDmReplySend, all fail-closed):
 *   * thread uniqueness via groupInboxRows + resolveUniqueThreadByLabel
 *     ("唯一才进，不唯一 stop");
 *   * observed thread title === --thread (EXACT; fuzzy => USERNAME_FUZZY no-send);
 *   * last-message fingerprint unchanged between thread entry and the moment
 *     before send (drift => LAST_MESSAGE_DRIFT no-send); the last message must
 *     be the peer's (left side) — replying when the last bubble is mine is a stop.
 *
 * Post-send verify (verifyDmReplySend): the thread's last bubble text hashes to
 * lastMessageFingerprintOf({snippet: sentText}) — my reply is the newest
 * message. Weak "tapped-send" demotes to ambiguous (no blind retry).
 *
 *   node ops/xw-xhs-dm-reply-live.mjs --alias 03 --actor <id> --thread <peer> [--text <回复>] [--dry-run]
 *
 * Console: console.log only (Windows bridge treats stderr as fatal).
 */
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CONTROL_DB = "C:\\Users\\Public\\xw-runtime\\state\\control-plane\\control.db";

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
  node ops/xw-xhs-dm-reply-live.mjs --alias 03 --actor <id> --thread <对方昵称> [--text <回复>] [--dry-run]

一次调用 = 一个严格 Mission（reply, totalCount=1, perTargetCount=1）+ 唯一性/精确名/漂移三道
pre-send 门 + last-message 指纹 post-verify（弱通过一律 ambiguous）。`);
  process.exit(0);
}

const alias = opt("--alias") || "03";
// 04 + 03 only (2026-08-27 user amendment: 03 lane opened, 01/02 stay out of scope)
if (alias !== "04" && alias !== "03") { console.log(JSON.stringify({ ok: false, code: "XHS_ALIAS_NOT_04", alias })); process.exit(3); }
const actor = opt("--actor") || "claude-pilot-20260809";
const threadLabel = opt("--thread");
const text = opt("--text") || "不客气呀～";
const DRY_RUN = flag("--dry-run");
if (!threadLabel) { console.log(JSON.stringify({ ok: false, code: "THREAD_REQUIRED" })); process.exit(3); }

const { StateStore } = await import("../../control-plane/control-plane/lib/state-store.mjs");
const { MissionRuntime } = await import("../../control-plane/control-plane/lib/mission-runtime.mjs");
const { DeviceRunRuntime } = await import("../../control-plane/control-plane/lib/device-run.mjs");
const { decideDmReplySend, verifyDmReplySend, expectedReplyLastMessageFingerprint } = await import("../../control-plane/apps/xhs/dm-verifier.mjs");
const { groupInboxRows, resolveUniqueThreadByLabel, extractConversationState, lastMessageFingerprintOf } = await import("../scripts/lib/xhs-thread-fingerprint.mjs");
const { findEditText, findSendBtn } = await import("./_xhs-parse.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ECP mission-effect helpers — QUALIFICATION_ONLY is load-bearing (a STANDARD
// constructor wipes ALL live sessions+leases via recoverInterruptedWork).
let __state = null;
function openState() {
  if (!__state) {
    __state = new StateStore({ dbPath: CONTROL_DB, m6RuntimeMode: "QUALIFICATION_ONLY" });
  }
  return __state;
}
function closeState() { try { __state?.close(); } catch {} __state = null; }

const textHash = () => createHash("sha256").update(`xw.xhs.dm.text:${text}`).digest("hex");

async function main() {
  const t0Session = Date.now();
  let result = null;
  let effectId = null;
  let state = null;
  try {
    // ── Phase A: session + inbox navigation ──
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
    const sf = sess.sessionFile;
    console.log(`SESSION=${sess.sessionId}`);
    const withSf = (args) => [...args, "--alias", alias, "--session-file", sf];

    const dumpXml = async (label) => {
      const d = kv((await runOps(withSf(["ops/dump-ui.mjs"]), 60000)).out);
      if (!d.DUMP || !existsSync(d.DUMP)) throw Object.assign(new Error(`dump_${label}`), { code: "DUMP_FAILED" });
      return readFileSync(d.DUMP, "utf8");
    };

    const l = await runOps(withSf(["ops/launch-app.mjs", "--package", "com.xingin.xhs", "--force-stop"]), 60000);
    if (l.code !== 0) throw Object.assign(new Error("launch"), { code: "LAUNCH_FAILED" });
    await sleep(4500);

    const homeXml = await dumpXml("home");
    const homeNodes = (homeXml.match(/<node\b[^>]*>/g) || []).map((t) => {
      const b = t.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      return b ? {
        cx: Math.round((+b[1] + +b[3]) / 2), cy: Math.round((+b[2] + +b[4]) / 2),
        text: (t.match(/text="([^"]*)"/) || [])[1] || "",
        desc: (t.match(/content-desc="([^"]*)"/) || [])[1] || "",
      } : null;
    }).filter(Boolean);
    const msgTab = homeNodes.find((n) => (n.text === "消息" || (n.desc || "").startsWith("消息")) && n.cy > 2200);
    if (!msgTab) throw Object.assign(new Error("no 消息 tab"), { code: "MSG_TAB_MISSING" });
    let r = await runOps(withSf(["ops/tap.mjs", "--x", String(msgTab.cx), "--y", String(msgTab.cy)]), 30000);
    if (r.code !== 0) throw Object.assign(new Error("tap 消息"), { code: "PREP_FAILED" });
    await sleep(2800);

    const inboxXml = await dumpXml("inbox");
    const rows = groupInboxRows(inboxXml);
    const resolved = resolveUniqueThreadByLabel(rows, threadLabel);
    console.log(`INBOX_ROWS=${rows.length} THREAD_MATCH=${resolved.count}`);
    if (!resolved.unique) throw Object.assign(new Error(`thread not unique (${resolved.count})`), { code: "THREAD_NOT_UNIQUE" });
    const row = resolved.entry;
    const threadFp = row.threadFingerprint;
    console.log(`THREAD=${row.peer} SNIPPET=${row.snippet.slice(0, 30)} DATE=${row.date} ROW=(${row.cx},${row.cy})`);
    if (DRY_RUN) {
      console.log(JSON.stringify({ ok: true, dryRun: true, threadFingerprint: threadFp, snippetFingerprint: row.lastMessageFingerprint, textHash: textHash() }));
      await runOps(withSf(["ops/back.mjs"]), 30000);
      return;
    }
    r = await runOps(withSf(["ops/tap.mjs", "--x", String(row.cx), "--y", String(row.cy)]), 30000);
    if (r.code !== 0) throw Object.assign(new Error("tap thread row"), { code: "PREP_FAILED" });
    await sleep(3000);

    // ── Phase B: conversation state + pre-send gates (fail-closed, pre-ECP) ──
    const convXml = await dumpXml("conv");
    const conv = extractConversationState(convXml);
    if (!conv.username) throw Object.assign(new Error("no thread title"), { code: "THREAD_TITLE_MISSING" });
    if (!conv.lastMessage) throw Object.assign(new Error("no last bubble"), { code: "LAST_MESSAGE_MISSING" });
    if (conv.lastMessage.mine) throw Object.assign(new Error("last bubble is mine"), { code: "LAST_MESSAGE_IS_MINE" });
    const expectedLastMsgFp = lastMessageFingerprintOf({ snippet: conv.lastMessage.text });
    console.log(`TITLE=${conv.username} LAST=(${conv.lastMessage.cx},${conv.lastMessage.cy})[${conv.lastMessage.text.slice(0, 26)}]`);

    const composer = (await (async () => {
      const ns = (convXml.match(/<node\b[^>]*>/g) || []).map((t) => {
        const b = t.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        return b ? { cls: (t.match(/class="([^"]*)"/) || [])[1] || "", x: Math.round((+b[1] + +b[3]) / 2), y: Math.round((+b[2] + +b[4]) / 2) } : null;
      }).filter(Boolean);
      return ns.find((n) => /EditText/.test(n.cls));
    })());
    if (!composer) throw Object.assign(new Error("no composer edit text"), { code: "COMPOSER_MISSING" });

    // ── Phase C: strict ECP mission effect (reservation BEFORE transport) ──
    state = openState();
    const missions = new MissionRuntime({ state });
    const runs = new DeviceRunRuntime({ state, missions, authorityNodeId: "DESKTOP-3I1EVHE" });
    const mk = missions.createMission({
      issuer: { actorId: "human:operator" },
      idempotencyKey: `xhs-dm-reply-${threadFp.slice(0, 16)}-${Date.now()}`,
      app: "xhs",
      account: `local-alias-${alias}`,
      parallelism: 1,
      controllers: ["agent:xw-xhs-dm-reply-live"],
      scope: {
        actions: ["reply"],
        targets: { kind: "fingerprint", values: [threadFp] },
        totalCount: 1,
        perTargetCount: 1,
        frequency: { count: 10, windowSeconds: 3600 },
      },
      validity: { expiresAt: new Date(Date.now() + 1800000).toISOString() },
      policy: { publish: "confirm", delete: "confirm" },
    });
    const mission = mk.mission ?? mk;
    const run = runs.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:xw-xhs-dm-reply-live" });
    const idempotencyKey = createHash("sha256").update(
      ["ar_dm_reply_live", "reply", threadFp, textHash(), String(Date.now())].join("\0"),
    ).digest("hex");
    const begun = state.beginMissionEffect({
      mission, deviceRunId: run.tuple.deviceRunId, action: "reply", targetHash: threadFp,
      intent: { surface: "dm-reply-send", live: true, textHash: textHash(), peer: row.peer },
      idempotencyKey,
    });
    effectId = begun.effect.effectId;
    console.log(`EFFECT=${effectId} reused=${begun.reused} elapsedMs=${Date.now() - t0Session}`);

    // pre-transport heartbeat (ECP reservation phase has no primitive heartbeat)
    const hb = await runOps(["ops/xw-explore-session.mjs", "heartbeat", "--session-file", sf], 30000);
    if (hb.code !== 0) throw Object.assign(new Error(`pre-transport heartbeat failed: ${hb.out.slice(0, 200)}`), { code: "SESSION_HEARTBEAT_FAILED" });

    // drift re-check right before send (the decideDmReplySend contract)
    const preXml = await dumpXml("pre-send");
    const preState = extractConversationState(preXml);
    const gate = decideDmReplySend({
      targetUsername: threadLabel,
      observedUsername: preState.username || conv.username,
      threadMatchCount: 1,
      expectedLastMessageFingerprint: expectedLastMsgFp,
      observedLastMessageFingerprint: preState.lastMessage
        ? lastMessageFingerprintOf({ snippet: preState.lastMessage.text })
        : "none",
    });
    console.log(`GATE=${gate.reason} TITLE_NOW=${preState.username || conv.username}`);
    if (!gate.send) throw Object.assign(new Error(`pre-send gate: ${gate.reason}`), { code: `GATE_${gate.reason}` });

    // ── Phase D: composer input (bounded prep, no transport) ──
    r = await runOps(withSf(["ops/tap.mjs", "--x", String(composer.x), "--y", String(composer.y)]), 30000);
    if (r.code !== 0) throw Object.assign(new Error("tap composer"), { code: "PREP_FAILED" });
    await sleep(2000);
    r = await runOps(withSf(["ops/input-text.mjs", "--text", text, "--x", String(composer.x), "--y", String(composer.y), "--clear-first", "--keep-ime"]), 60000);
    if (r.code !== 0) {
      // Transport never happened — nothing was sent. not_sent does not consume.
      state.recordMissionEffectOutcome(effectId, { status: "not_sent" });
      console.log(JSON.stringify({ ok: false, code: "INPUT_FAILED", effectId, detail: r.out.slice(0, 200) }));
      process.exitCode = 2;
      return;
    }
    await sleep(1200);

    const typedXml = await dumpXml("typed");
    const edit = findEditText(typedXml);
    const send = findSendBtn(typedXml);
    const textLanded = Boolean(edit && edit.text && decodeXmlText(edit.text).includes(text));
    console.log(`EDIT_TEXT_AFTER=${(edit?.text || "").slice(0, 30)} TEXT_LANDED=${textLanded} SEND=${send ? `${send.x},${send.y}` : "MISSING"}`);
    if (!send || !textLanded) {
      state.recordMissionEffectOutcome(effectId, { status: "not_sent" });
      console.log(JSON.stringify({ ok: false, code: send ? "TEXT_NOT_LANDED" : "SEND_BTN_MISSING", effectId }));
      process.exitCode = 2;
      return;
    }

    // ── Phase E: THE transport — one send tap ──
    const tapR = await runOps(withSf(["ops/tap.mjs", "--x", String(send.x), "--y", String(send.y)]), 30000);
    if (tapR.code !== 0) {
      state.recordMissionEffectOutcome(effectId, { status: "not_sent" });
      console.log(JSON.stringify({ ok: false, code: "TAP_FAILED", effectId }));
      process.exitCode = 2;
      return;
    }
    await sleep(3000);

    // ── Phase F: post-send verification (last bubble is my text) ──
    // Render lag is systematic (comment x3, DM x1): the sent bubble takes
    // several seconds to appear in the dump — observe patiently before
    // demoting to ambiguous (a read-only re-open settles it either way).
    let verdict = null;
    for (let i = 0; i < 5 && !verdict; i += 1) {
      const afterXml = await dumpXml(`after-${i}`);
      const after = extractConversationState(afterXml);
      const afterFp = after.lastMessage ? lastMessageFingerprintOf({ snippet: after.lastMessage.text }) : "none";
      const editAfter = findEditText(afterXml);
      const sendAfter = findSendBtn(afterXml);
      verdict = verifyDmReplySend({
        sentText: text,
        afterLastMessageFingerprint: afterFp,
        // the DM composer is persistent: composer "still open" means MY TEXT is
        // still in the input (or the send button survives) — not merely the
        // input box being visible
        composerOpen: Boolean(editAfter?.text && decodeXmlText(editAfter.text).includes(text)),
        sendButtonPresent: Boolean(sendAfter),
      });
      if (verdict.status === "ambiguous" && i < 4) { verdict = null; await sleep(3000); }
    }
    if (!verdict) verdict = { status: "ambiguous", reason: "post-send-observe-exhausted", evidence: [] };
    console.log(`VERIFY=${verdict.status} REASON=${verdict.reason} EVIDENCE=${(verdict.evidence || []).join(",")}`);
    state.recordMissionEffectOutcome(effectId, { status: verdict.status });

    result = {
      ok: verdict.status === "verified",
      ...(verdict.status === "verified" ? {} : { code: `EFFECT_${verdict.status.toUpperCase()}` }),
      effectId, threadFingerprint: threadFp, peer: row.peer, verdict: verdict.reason,
      expectedFp: expectedReplyLastMessageFingerprint(text).slice(0, 16),
    };
    // back out of the conversation + the messages tab
    await runOps(withSf(["ops/back.mjs"]), 30000);
    await sleep(700);
    await runOps(withSf(["ops/back.mjs"]), 30000);
  } catch (e) {
    result = { ok: false, code: e?.code || "DM_REPLY_LIVE_FAILED", message: String(e?.message || e).slice(0, 300) };
    process.exitCode = 2;
  } finally {
    closeState();
  }
  console.log(JSON.stringify(result, null, 0));
}

function decodeXmlText(s) {
  return String(s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

main();