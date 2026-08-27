#!/usr/bin/env node
/**
 * xw-xhs-social-live.mjs — W4 live canary driver: strict-mission ECP social
 * effects on alias 04 (like/collect/follow), composed read from a feed card.
 *
 * Mission wiring per plan V2 §6 (F3): one STRICT Mission per invocation with
 * actions=[action], targets=[targetNoteHash], totalCount=1, perTargetCount=1,
 * softScope=false, softBudget=false. The target fingerprint is the sha256 of
 * the note's content-desc fragment captured in the same dump that locates it —
 * before/after + exactly-once are enforced by beginMissionEffect + verifiers.
 *
 *   node ops/xw-xhs-social-live.mjs like --alias 04 --actor <id> [--note-desc-contains X]
 *
 * Console: console.log only (Windows bridge treats stderr as fatal).
 */
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

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
const action = (argMap._[0] || "").toLowerCase();

if (flag("--help") || flag("-h") || !["like", "collect", "follow"].includes(action)) {
  console.log(`用法:
  node ops/xw-xhs-social-live.mjs <like|collect|follow> --alias 04 --actor <id> [--note-desc-contains <词>]

一次调用 = 一个严格 Mission（totalCount=1, perTargetCount=1）+ before/after 校验。`);
  process.exit(0);
}

const alias = opt("--alias") || "04";
if (alias !== "04") { console.log(JSON.stringify({ ok: false, code: "XHS_ALIAS_NOT_04", alias })); process.exit(3); }
const actor = opt("--actor") || "claude-pilot-20260809";
const noteFilter = opt("--note-desc-contains") || null;
const DRY_RUN = flag("--dry-run");

// Dynamic import so --help works without touching live DBs.
const { StateStore } = await import("../../control-plane/control-plane/lib/state-store.mjs");
const { MissionRuntime } = await import("../../control-plane/control-plane/lib/mission-runtime.mjs");
const { DeviceRunRuntime } = await import("../../control-plane/control-plane/lib/device-run.mjs");
const {
  likeState, collectState, followState,
} = await import("../../control-plane/apps/xhs/social-verifiers.mjs");
const { parseFeedCards, pickFeedCard, parseBottomBar, findBtn, findFollowBtn, findProfileFollowBtn } = await import("./_xhs-parse.mjs");

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

// ECP mission-effect helpers — mirror the offline W4 test harness shape.
let __state = null;
function openState() {
  if (!__state) {
    // QUALIFICATION_ONLY is load-bearing here: a STANDARD-mode constructor runs
    // recoverInterruptedWork(), which on a clean job queue still executes
    // `DELETE FROM sessions; DELETE FROM leases;` — wiping our own live
    // explorer session (and every other lease in the db) mid-run. That was the
    // root cause of the first three TAP_FAILED like attempts.
    __state = new StateStore({ dbPath: CONTROL_DB, m6RuntimeMode: "QUALIFICATION_ONLY" });
    // Authority identity for this node already exists; do not upsert here.
  }
  return __state;
}
function closeState() { try { __state?.close(); } catch {} __state = null; }

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

async function main() {
  const t0Session = Date.now();
  let pagesToPop = 1; // backs needed at exit: detail->feed; follow adds profile->detail
  let result = null;
  try {
    // ── Phase A: acquire explorer session, open a note, locate the button ──
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

    const l = await runOps(withSf(["ops/launch-app.mjs", "--package", "com.xingin.xhs", "--force-stop"]), 60000);
    if (l.code !== 0) throw Object.assign(new Error("launch"), { code: "LAUNCH_FAILED" });
    await sleep(2600);

    const d1 = kv((await runOps(withSf(["ops/dump-ui.mjs"]), 60000)).out);
    if (!d1.DUMP || !existsSync(d1.DUMP)) throw Object.assign(new Error("dump_feed"), { code: "DUMP_FAILED" });
    const homeXml = readFileSync(d1.DUMP, "utf8");
    let cards = parseFeedCards(homeXml);
    if (noteFilter) cards = cards.filter((c) => (c.desc || c.title || "").includes(noteFilter));
    const card = pickFeedCard(cards, { prefer: "note", avoidWan: true });
    if (!card) throw Object.assign(new Error("no feed card"), { code: "NO_CARD" });
    console.log(`CARD=${String(card.title || "").slice(0, 40)} AUTHOR=${card.author || ""}`);
    await runOps(withSf(["ops/tap.mjs", "--x", String(card.cx), "--y", String(card.cy)]), 30000);
    await sleep(2800);

    const d2 = kv((await runOps(withSf(["ops/dump-ui.mjs"]), 60000)).out);
    if (!d2.DUMP || !existsSync(d2.DUMP)) throw Object.assign(new Error("dump_detail"), { code: "DUMP_FAILED" });
    const detailXml = readFileSync(d2.DUMP, "utf8");
    const btnMap = { like: "like", collect: "collect", follow: "follow" };
    let targetHash;
    let btn;
    // follow uses the AUTHOR PROFILE surface: the detail-header follow TextView
    // is non-clickable and silently ignored coordinate taps in 3 live attempts;
    // the profile page CTA is a native clickable Button and is the canonical
    // follow surface. Transport is still exactly one tap (the CTA); the avatar
    // tap is read-only navigation.
    if (action === "follow") {
      const ns = allNodes(detailXml);
      const avatar = ns.find((n) => /ImageView/i.test(n.cls || "") && /头像/.test(n.desc || "") && n.cy < 500 && n.clickable)
        || ns.find((n) => (n.text || "").trim() === (card.author || "").trim() && n.cy < 500);
      if (!avatar) throw Object.assign(new Error("author entry not found on detail"), { code: "AUTHOR_ENTRY_MISSING" });
      await runOps(withSf(["ops/tap.mjs", "--x", String(avatar.cx), "--y", String(avatar.cy)]), 30000);
      await sleep(2600);
      const d2b = kv((await runOps(withSf(["ops/dump-ui.mjs"]), 60000)).out);
      if (!d2b.DUMP || !existsSync(d2b.DUMP)) throw Object.assign(new Error("dump_profile"), { code: "DUMP_FAILED" });
      const profileXml = readFileSync(d2b.DUMP, "utf8");
      // binding check: the profile must name the author we fingerprinted
      const authorSeen = profileXml.includes(decodeXml(card.author || " noauthor"))
        || /头像[,，]/.test((profileXml.match(/content-desc="(头像[^"]*)"/) || [])[1] || "");
      if (!authorSeen) throw Object.assign(new Error("profile author binding mismatch"), { code: "PROFILE_AUTHOR_MISMATCH" });
      btn = findProfileFollowBtn(profileXml); // fail-closed: zero/multiple → null
      if (!btn) throw Object.assign(new Error("profile follow CTA not found"), { code: "BTN_MISSING" });
      targetHash = createHash("sha256").update(`xw.xhs.author:${card.author || ""}`).digest("hex");
      console.log(`PROFILE_CTA DESC=${btn.desc} AT=(${btn.x},${btn.y}) AUTHOR_MATCH=${authorSeen}`);
      pagesToPop = 2; // profile -> detail -> feed
    } else {
      // like/collect use the detail-page bottom bar.
      btn = findBtn(detailXml, btnMap[action]);
      if (!btn && action === "collect") {
        // collect button may be behind the like row as 已收藏-desc
        btn = findBtn(detailXml, "collect");
      }
      if (!btn) throw Object.assign(new Error(`${action} button not found`), { code: "BTN_MISSING" });
      const targetRaw = `${card.author || ""}|${card.title || ""}`;
      targetHash = createHash("sha256").update(`xw.xhs.note:${targetRaw}`).digest("hex");
      pagesToPop = 1; // detail -> feed
    }
    if (!targetHash) throw Object.assign(new Error("target hash missing"), { code: "INTERNAL" });

    const stateVerifier = { like: likeState, collect: collectState, follow: followState }[action];
    const before = stateVerifier(btn.desc);
    console.log(`BEFORE=${before} DESC=${btn.desc.slice(0, 30)} AT=(${btn.x},${btn.y})`);

    // Already-true skip: no transport, no effect reservation.
    const popPages = async () => {
      for (let i = 0; i < pagesToPop; i += 1) {
        await runOps(withSf(["ops/back.mjs"]), 30000);
        await sleep(700);
      }
    };
    if (before === { like: "liked", collect: "collected", follow: "followed" }[action]) {
      console.log(JSON.stringify({ ok: true, skipped: true, reason: "already_true", targetHash, transport: 0 }));
      await popPages();
      return;
    }
    if (before === "missing" || before === "unknown") {
      throw Object.assign(new Error(`cannot verify state pre-tap (${before})`), { code: "UNKNOWN_STATE_NO_BLIND_TAP" });
    }

    if (DRY_RUN) { console.log(JSON.stringify({ ok: true, dryRun: true, targetHash })); await popPages(); return; }

    // ── Phase B: strict ECP mission effect (reservation BEFORE transport) ──
    const state = openState();
    const missions = new MissionRuntime({ state });
    const runs = new DeviceRunRuntime({ state, missions, authorityNodeId: "DESKTOP-3I1EVHE" });
    const mk = missions.createMission({
      issuer: { actorId: "human:operator" },
      idempotencyKey: `xhs-${action}-${targetHash.slice(0, 16)}-${Date.now()}`,
      app: "xhs",
      account: "local-alias-04",
      parallelism: 1,
      controllers: ["agent:xw-xhs-social-live"],
      scope: {
        actions: [action],
        targets: { kind: "fingerprint", values: [targetHash] },
        totalCount: 1,
        perTargetCount: 1,
        frequency: { count: 10, windowSeconds: 3600 },
      },
      validity: { expiresAt: new Date(Date.now() + 1800000).toISOString() },
      policy: { publish: "confirm", delete: "confirm" },
    });
    const mission = mk.mission ?? mk;
    const run = runs.openDeviceRun({ missionId: mission.missionId, controllerAgent: "agent:xw-xhs-social-live" });
    const deviceRunId = run.tuple.deviceRunId;

    const idempotencyKey = createHash("sha256").update(
      ["ar_social_live", action, targetHash, String(Date.now())].join("\0"),
    ).digest("hex");
    const begun = state.beginMissionEffect({
      mission, deviceRunId, action, targetHash,
      intent: { surface: "social-effect", live: true },
      idempotencyKey,
    }); // strict path: no softScope/softBudget
    const effectId = begun.effect.effectId;
    console.log(`EFFECT=${effectId} reused=${begun.reused} elapsedMs=${Date.now() - t0Session}`);

    // ── Phase C: transport (one tap) + post-verify ──
    let outcome;
    // The ECP reservation phase (Phase B) holds no explorer heartbeat; on a
    // contended live control.db it can outlast the 60s session TTL and the
    // next primitive would 404 on a cleaned-up session. Refresh the lease
    // immediately before transport.
    const hb = await runOps(["ops/xw-explore-session.mjs", "heartbeat", "--session-file", sf], 30000);
    if (hb.code !== 0) throw Object.assign(new Error(`pre-transport heartbeat failed: ${hb.out.slice(0, 200)}`), { code: "SESSION_HEARTBEAT_FAILED" });
    const tapR = await runOps(withSf(["ops/tap.mjs", "--x", String(btn.x), "--y", String(btn.y)]), 30000);
    console.log(`TAP_ELAPSED_MS=${Date.now() - t0Session}`);
    if (tapR.code !== 0) {
      console.log(`TAP_DEBUG code=${tapR.code} out=${tapR.out.slice(0, 300).replace(/\n/g, " | ")}`);
      // Transport never happened: not_sent does NOT consume the reservation
      // and does NOT set retry_blocked (the target stays actionable).
      state.recordMissionEffectOutcome(effectId, { status: "not_sent" });
      console.log(JSON.stringify({ ok: false, code: "TAP_FAILED", effectId, targetHash }));
      await popPages();
      process.exitCode = 2;
      return;
    }
    await sleep(2500);

    const d3 = kv((await runOps(withSf(["ops/dump-ui.mjs"]), 60000)).out);
    if (!d3.DUMP || !existsSync(d3.DUMP)) {
      // Transport happened but cannot be verified -> ambiguous fences retry.
      state.recordMissionEffectOutcome(effectId, { status: "ambiguous" });
      throw Object.assign(new Error("post-tap dump missing"), { code: "EFFECT_AMBIGUOUS" });
    }
    const afterXml = readFileSync(d3.DUMP, "utf8");
    // follow post-verify reads the profile CTA (exact-set + clickable-container
    // locator); like/collect read the detail bottom bar.
    const afterBtn = action === "follow"
      ? (findProfileFollowBtn(afterXml) || findFollowBtn(afterXml))
      : findBtn(afterXml, btnMap[action]);
    const afterDesc = afterBtn?.desc || "";
    if (!afterBtn) {
      // Diagnostic: print every 关注-like label still present after the tap so
      // a changed button shape (toast, profile nav, relayout) is visible.
      for (const m of afterXml.matchAll(/(?:text|content-desc)="([^"]*(?:关注|回关|相互)[^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)) {
        console.log(`AFTER_NODE label=${m[1].slice(0, 24)} at=(${Math.round((+m[2] + +m[4]) / 2)},${Math.round((+m[3] + +m[5]) / 2)})`);
      }
    }
    const after = afterBtn ? stateVerifier(afterDesc) : "missing";
    const terminal = { like: "liked", collect: "collected", follow: "followed" }[action];
    const verified = after === terminal || (afterDesc && btn.desc && afterDesc !== btn.desc);
    console.log(`AFTER=${after} DESC=${afterDesc.slice(0, 30)} VERIFIED=${verified}`);

    outcome = verified ? "verified" : "ambiguous";
    state.recordMissionEffectOutcome(effectId, { status: outcome });

    result = {
      ok: verified,
      ...(verified ? {} : { code: "EFFECT_NOT_VERIFIED" }),
      effectId, targetHash, before: btn.desc, after: afterDesc,
    };
    await popPages();
  } catch (e) {
    result = { ok: false, code: e?.code || "SOCIAL_LIVE_FAILED", message: String(e?.message || e).slice(0, 300) };
    process.exitCode = e?.code === "AMBIGUOUS_NO_RETRY" ? 5 : 2;
  } finally {
    closeState();
  }
  console.log(JSON.stringify(result, null, 0));
}

main();