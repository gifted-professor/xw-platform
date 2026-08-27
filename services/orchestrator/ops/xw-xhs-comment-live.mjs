#!/usr/bin/env node
/**
 * xw-xhs-comment-live.mjs — W5 live canary driver: bound comment send on alias
 * 04 (pack action comment.send, plan V2 §6 S3), strict-mission ECP wiring.
 *
 * One invocation = one STRICT Mission (action=comment, targets=[note hash],
 * totalCount=1, perTargetCount=1, softScope=false, softBudget=false). The
 * send-tap is the single transport; composer open / text typing are bounded
 * preparation. Verification is the W5 three-factor proof
 * (apps/xhs/comment-verifier.mjs): exact text hash posted + count delta +
 * own-latest — the old "composer closed" weak pass is demoted to ambiguous.
 *
 *   node ops/xw-xhs-comment-live.mjs --alias 04 --actor <id> [--text <评论>] [--note-desc-contains X] [--dry-run]
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
  node ops/xw-xhs-comment-live.mjs --alias 04 --actor <id> [--text <评论>] [--note-desc-contains <词>] [--dry-run]

一次调用 = 一个严格 Mission（comment, totalCount=1, perTargetCount=1）+ 三因子验证
（posted text hash + count delta + own-latest；弱通过一律 ambiguous）。`);
  process.exit(0);
}

const alias = opt("--alias") || "04";
if (alias !== "04") { console.log(JSON.stringify({ ok: false, code: "XHS_ALIAS_NOT_04", alias })); process.exit(3); }
const actor = opt("--actor") || "claude-pilot-20260809";
const text = opt("--text") || "学到了，说得很清楚👍";
const noteFilter = opt("--note-desc-contains") || null;
const DRY_RUN = flag("--dry-run");

const { StateStore } = await import("../../control-plane/control-plane/lib/state-store.mjs");
const { MissionRuntime } = await import("../../control-plane/control-plane/lib/mission-runtime.mjs");
const { DeviceRunRuntime } = await import("../../control-plane/control-plane/lib/device-run.mjs");
const { verifyCommentSend, commentTextHash } = await import("../../control-plane/apps/xhs/comment-verifier.mjs");
const { parseFeedCards, pickFeedCard, parseBottomBar, findSendBtn, findEditText } = await import("./_xhs-parse.mjs");

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

function allNodes(xml) {
  const out = [];
  const re = /<node\b[^>]*>/g;
  let m;
  while ((m = re.exec(xml))) {
    const tag = m[0];
    const b = tag.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!b) continue;
    out.push({
      L: +b[1], T: +b[2], R: +b[3], B: +b[4],
      cx: Math.round((+b[1] + +b[3]) / 2), cy: Math.round((+b[2] + +b[4]) / 2),
      text: (tag.match(/text="([^"]*)"/) || [])[1] || "",
      desc: (tag.match(/content-desc="([^"]*)"/) || [])[1] || "",
      cls: (tag.match(/class="([^"]*)"/) || [])[1] || "",
      clickable: /clickable="true"/.test(tag),
    });
  }
  return out;
}

const decodeXml = (s) => String(s || "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** "评论 23" / "评论23" → 23; null when absent/unclear. */
function parseCommentCount(desc) {
  const m = String(desc || "").match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
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

async function main() {
  const t0Session = Date.now();
  let result = null;
  let effectId = null;
  let state = null;
  try {
    // ── Phase A: session + note entry ──
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

    const popToFeed = async () => {
      // up to 3 backs back to the feed; extra backs on the home tab are harmless
      for (let i = 0; i < 3; i += 1) {
        await runOps(withSf(["ops/back.mjs"]), 30000);
        await sleep(700);
      }
    };

    const l = await runOps(withSf(["ops/launch-app.mjs", "--package", "com.xingin.xhs", "--force-stop"]), 60000);
    if (l.code !== 0) throw Object.assign(new Error("launch"), { code: "LAUNCH_FAILED" });
    await sleep(2600);

    const d1 = kv((await runOps(withSf(["ops/dump-ui.mjs"]), 60000)).out);
    if (!d1.DUMP || !existsSync(d1.DUMP)) throw Object.assign(new Error("dump_feed"), { code: "DUMP_FAILED" });
    let cards = parseFeedCards(readFileSync(d1.DUMP, "utf8"));
    if (noteFilter) cards = cards.filter((c) => (c.desc || c.title || "").includes(noteFilter));
    const card = pickFeedCard(cards, { prefer: "note", avoidWan: true });
    if (!card) throw Object.assign(new Error("no feed card"), { code: "NO_CARD" });
    const targetRaw = `${card.author || ""}|${card.title || ""}`;
    const targetHash = createHash("sha256").update(`xw.xhs.note:${targetRaw}`).digest("hex");
    console.log(`CARD=${String(card.title || "").slice(0, 40)} AUTHOR=${card.author || ""}`);
    console.log(`TARGET_HASH=${targetHash.slice(0, 16)} TEXT_HASH=${commentTextHash(text).slice(0, 16)}`);
    await runOps(withSf(["ops/tap.mjs", "--x", String(card.cx), "--y", String(card.cy)]), 30000);
    await sleep(2800);

    const d2 = kv((await runOps(withSf(["ops/dump-ui.mjs"]), 60000)).out);
    if (!d2.DUMP || !existsSync(d2.DUMP)) throw Object.assign(new Error("dump_detail"), { code: "DUMP_FAILED" });
    const detailXml = readFileSync(d2.DUMP, "utf8");

    const bar = parseBottomBar(detailXml);
    const box = bar.commentBox || bar.comment;
    if (!box) throw Object.assign(new Error("comment box not found"), { code: "COMMENT_BOX_MISSING" });
    const beforeCount = parseCommentCount(bar.comment?.desc);
    console.log(`COMMENT_BOX=${(box.desc || "").slice(0, 24)} AT=(${box.x},${box.y}) COUNT_BEFORE=${beforeCount}`);

    if (DRY_RUN) { console.log(JSON.stringify({ ok: true, dryRun: true, targetHash, textHash: commentTextHash(text), beforeCount })); await popToFeed(); return; }

    // ── Phase B: strict ECP mission effect (reservation BEFORE transport) ──
    state = openState();
    const missions = new MissionRuntime({ state });
    const runs = new DeviceRunRuntime({ state, missions, authorityNodeId: "DESKTOP-3I1EVHE" });
    const mk = missions.createMission({
      issuer: { actorId: "human:operator" },
      idempotencyKey: `xhs-comment-${targetHash.slice(0, 16)}-${Date.now()}`,
      app: "xhs",
      account: "local-alias-04",
      parallelism: 1,
      controllers: ["agent:xw-xhs-comment-live"],
      scope: {
        actions: ["comment"],
        targets: { kind: "fingerprint", values: [targetHash] },
        totalCount: 1,
        perTargetCount: 1,
        frequency: { count: 10, windowSeconds: 3600 },
      },
      validity: { expiresAt: new Date(Date.now() + 1800000).toISOString() },
      policy: { publish: "confirm", delete: "confirm" },
    });
    const mission = mk.mission ?? mk;
    const run = runs.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:xw-xhs-comment-live" });
    const idempotencyKey = createHash("sha256").update(
      ["ar_comment_live", "comment", targetHash, commentTextHash(text), String(Date.now())].join("\0"),
    ).digest("hex");
    const begun = state.beginMissionEffect({
      mission, deviceRunId: run.tuple.deviceRunId, action: "comment", targetHash,
      intent: { surface: "comment-send", live: true, textHash: commentTextHash(text) },
      idempotencyKey,
    });
    effectId = begun.effect.effectId;
    console.log(`EFFECT=${effectId} reused=${begun.reused} elapsedMs=${Date.now() - t0Session}`);

    // ── Phase C: preparation (composer + input) — bounded, no transport yet ──
    const hb = await runOps(["ops/xw-explore-session.mjs", "heartbeat", "--session-file", sf], 30000);
    if (hb.code !== 0) throw Object.assign(new Error(`pre-transport heartbeat failed: ${hb.out.slice(0, 200)}`), { code: "SESSION_HEARTBEAT_FAILED" });

    let r = await runOps(withSf(["ops/tap.mjs", "--x", String(box.x), "--y", String(box.y)]), 30000);
    if (r.code !== 0) throw Object.assign(new Error("tap comment box"), { code: "PREP_FAILED" });
    await sleep(2000);

    let dump = kv((await runOps(withSf(["ops/dump-ui.mjs"]), 60000)).out);
    if (!dump.DUMP || !existsSync(dump.DUMP)) throw Object.assign(new Error("dump_composer"), { code: "PREP_FAILED" });
    let composerXml = readFileSync(dump.DUMP, "utf8");
    if (!findEditText(composerXml) && !findSendBtn(composerXml)) {
      await runOps(withSf(["ops/tap.mjs", "--x", String(box.x), "--y", String(box.y)]), 30000);
      await sleep(1800);
      dump = kv((await runOps(withSf(["ops/dump-ui.mjs"]), 60000)).out);
      if (!dump.DUMP || !existsSync(dump.DUMP)) throw Object.assign(new Error("dump_composer_retry"), { code: "PREP_FAILED" });
      composerXml = readFileSync(dump.DUMP, "utf8");
    }
    const edit = findEditText(composerXml);
    const ix = edit?.x ?? box.x;
    const iy = edit?.y ?? box.y;

    // Input via XwIME (中文勿用 adb input text); keep-ime: IME restore often
    // dismisses the composer before 发送.
    r = await runOps(withSf(["ops/input-text.mjs", "--text", text, "--x", String(ix), "--y", String(iy), "--clear-first", "--keep-ime"]), 60000);
    if (r.code !== 0) {
      // Transport never happened — nothing was sent. not_sent does not consume.
      state.recordMissionEffectOutcome(effectId, { status: "not_sent" });
      console.log(JSON.stringify({ ok: false, code: "INPUT_FAILED", effectId, detail: r.out.slice(0, 200) }));
      await popToFeed();
      process.exitCode = 2;
      return;
    }
    await sleep(1200);

    dump = kv((await runOps(withSf(["ops/dump-ui.mjs"]), 60000)).out);
    if (!dump.DUMP || !existsSync(dump.DUMP)) throw Object.assign(new Error("dump_before_send"), { code: "PREP_FAILED" });
    composerXml = readFileSync(dump.DUMP, "utf8");
    const editAfter = findEditText(composerXml);
    const textLanded = Boolean(editAfter?.text && decodeXml(editAfter.text).includes(text));
    const send = findSendBtn(composerXml);
    console.log(`EDIT_TEXT_AFTER=${(editAfter?.text || "").slice(0, 40)} TEXT_LANDED=${textLanded} SEND=${send ? `${send.x},${send.y}` : "MISSING"}`);
    if (!send || !textLanded) {
      state.recordMissionEffectOutcome(effectId, { status: "not_sent" });
      console.log(JSON.stringify({ ok: false, code: send ? "TEXT_NOT_LANDED" : "SEND_BTN_MISSING", effectId, targetHash }));
      await popToFeed();
      process.exitCode = 2;
      return;
    }

    // ── Phase D: THE transport — one send tap ──
    const tapR = await runOps(withSf(["ops/tap.mjs", "--x", String(send.x), "--y", String(send.y)]), 30000);
    if (tapR.code !== 0) {
      state.recordMissionEffectOutcome(effectId, { status: "not_sent" });
      console.log(JSON.stringify({ ok: false, code: "TAP_FAILED", effectId, targetHash }));
      await popToFeed();
      process.exitCode = 2;
      return;
    }
    await sleep(3000);

    // ── Phase E: three-factor verification ──
    // The composer-close animation hides the bottom bar for a while; re-dump
    // until the count is readable, then scroll the (lazy-loaded) comment list
    // into view if the posted text is not yet in the dump.
    const observe = async () => {
      let lastXml = null;
      for (let i = 0; i < 3; i += 1) {
        const dN = kv((await runOps(withSf(["ops/dump-ui.mjs"]), 60000)).out);
        if (!dN.DUMP || !existsSync(dN.DUMP)) break;
        const xmlN = readFileSync(dN.DUMP, "utf8");
        lastXml = xmlN;
        const count = parseCommentCount(parseBottomBar(xmlN).comment?.desc);
        if (count !== null) return { xml: xmlN, count };
        // composer-close transition can hide the bottom bar; scroll the
        // lazy-loaded comment list into view and try again
        await sleep(2000);
        await runOps(withSf(["ops/swipe.mjs", "--up", "--ms", "300"]), 30000);
        await sleep(1500);
      }
      // a dump we can read but with no parseable count is still valid evidence
      // (the verifier treats count null as "factor 2 unobserved")
      return { xml: lastXml, count: lastXml ? parseCommentCount(parseBottomBar(lastXml).comment?.desc) : null };
    };
    const obs = await observe();
    if (!obs.xml) {
      state.recordMissionEffectOutcome(effectId, { status: "ambiguous" });
      throw Object.assign(new Error("post-send dump missing"), { code: "EFFECT_AMBIGUOUS" });
    }
    let afterXmlFull = obs.xml;
    const afterCount = obs.count;
    let postedComments = allNodes(afterXmlFull)
      .map((n) => ({ text: decodeXml(n.text || n.desc) }))
      .filter((n) => n.text && n.text.length >= 2);
    if (!postedComments.some((c) => c.text.includes(text))) {
      await runOps(withSf(["ops/swipe.mjs", "--up", "--ms", "300"]), 30000);
      await sleep(1500);
      const d4 = kv((await runOps(withSf(["ops/dump-ui.mjs"]), 60000)).out);
      if (d4.DUMP && existsSync(d4.DUMP)) {
        afterXmlFull = readFileSync(d4.DUMP, "utf8");
        postedComments = allNodes(afterXmlFull)
          .map((n) => ({ text: decodeXml(n.text || n.desc) }))
          .filter((n) => n.text && n.text.length >= 2);
      }
    }
    const verdict = verifyCommentSend({
      sentText: text,
      before: { commentCount: beforeCount },
      after: {
        postedComments,
        commentCount: afterCount,
        composerOpen: Boolean(findEditText(afterXmlFull)),
        sendButtonPresent: Boolean(findSendBtn(afterXmlFull)),
      },
    });
    console.log(`VERIFY=${verdict.status} REASON=${verdict.reason} EVIDENCE=${verdict.evidence.join(",")} COUNT_AFTER=${afterCount}`);
    state.recordMissionEffectOutcome(effectId, { status: verdict.status });

    result = {
      ok: verdict.status === "verified",
      ...(verdict.status === "verified" ? {} : { code: `EFFECT_${verdict.status.toUpperCase()}` }),
      effectId, targetHash, verdict: verdict.reason, beforeCount, afterCount,
    };
    await popToFeed();
  } catch (e) {
    result = { ok: false, code: e?.code || "COMMENT_LIVE_FAILED", message: String(e?.message || e).slice(0, 300) };
    process.exitCode = 2;
  } finally {
    closeState();
  }
  console.log(JSON.stringify(result, null, 0));
}

main();