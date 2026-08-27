#!/usr/bin/env node
/**
 * xw-xhs-r0-inbox.mjs — W3b live driver for the 04-only pack's R0 inbox/read
 * entries (plan V2 §6: dispatcher plans; this composes the read-only execution).
 *
 * Read-only by construction: no text input, no send primitives, no follow.
 * The only taps are: the 消息 bottom tab (dump-located), the unique thread
 * (only when resolveUniqueThreadByLabel says unique===true), and Back.
 *
 *   node ops/xw-xhs-r0-inbox.mjs inbox  --alias 04 --actor <id>   # list + fingerprint inbox
 *   node ops/xw-xhs-r0-inbox.mjs read   --alias 04 --actor <id> --thread <label> [--no-enter]
 *
 * Uniqueness gate ("唯一才进，不唯一 stop"): read enters ONLY on exactly-one
 * normalized-label match; zero or many matches => report STOP, no entry.
 * Console: console.log only (Windows bridge treats stderr as fatal).
 */
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import {
  extractConversationEntries,
  lastMessageFingerprintOf,
  resolveUniqueThreadByLabel,
  threadFingerprintOf,
} from "../scripts/lib/xhs-thread-fingerprint.mjs";
import { parseArgs } from "./_explore-lib.mjs";

const ROOT = join(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const PKG = "com.xingin.xhs";

const { opt, flag } = parseArgs(process.argv.slice(2));
const command = (opt("_") || process.argv[2] || "").toLowerCase();

if (flag("--help") || flag("-h") || !["inbox", "read"].includes(command)) {
  console.log(`用法:
  node ops/xw-xhs-r0-inbox.mjs inbox --alias 04 --actor <id>
  node ops/xw-xhs-r0-inbox.mjs read  --alias 04 --actor <id> --thread <会话名> [--no-enter]

read 仅在目标会话唯一时进入（不唯一 => STOP 只上报）。全程只读。`);
  process.exit(command && command !== "" ? 0 : 4);
}

const alias = opt("--alias") || "04";
if (alias !== "04") {
  console.log(JSON.stringify({ ok: false, code: "XHS_ALIAS_NOT_04", alias }));
  process.exit(3);
}
const actor = opt("--actor") || "claude-pilot-20260809";
const threadLabel = opt("--thread");
const doEnter = !flag("--no-enter");
// Session context must live directly under the explorer session root; the
// acquire default is <root>/<actor>-<alias>.json. We pass the explicit path so
// release/heartbeat address the same context.
const sessionFile = opt("--session-file") || null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runOps(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn("node", args, { cwd: process.cwd() });
    let out = "";
    const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} resolve({ code: 124, out, ms: Date.now() - t0 }); }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out: out.trim(), ms: Date.now() - t0 }); });
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
      clickable: /clickable="true"/.test(tag),
    });
  }
  return out;
}

let sessionAcquired = false;

async function main() {
  // 1. acquire the canary explorer session (formal lease; token to private ctx).
  const acqArgs = ["ops/xw-explore-session.mjs", "acquire", "--alias", alias, "--actor", actor];
  if (sessionFile) acqArgs.push("--session-file", sessionFile);
  let acq = await runOps(acqArgs, 60000);
  if (acq.code !== 0 && acq.out.includes("EXPLORER_SESSION_CONTEXT_EXISTS")) {
    // stale token context from an earlier run: release (best-effort) + remove.
    const stalePath = sessionFile
      || `C:\\Users\\windows 10\\.xhs-explorer-sessions\\${String(actor).replace(/[^A-Za-z0-9._-]/g, "_")}-${alias}.json`;
    await runOps(["ops/xw-explore-session.mjs", "release", "--session-file", stalePath], 30000);
    try { rmSync(stalePath, { force: true }); } catch {}
    acq = await runOps(acqArgs, 60000);
  }
  if (acq.code !== 0) {
    console.log(JSON.stringify({ ok: false, code: "SESSION_ACQUIRE_FAILED", detail: acq.out.slice(0, 300) }));
    process.exit(2);
  }
  sessionAcquired = true;
  // acquire prints a single JSON line ({ok,action,sessionFile,sessionId,...}).
  let sess = {};
  try { sess = JSON.parse(acq.out.split(/\n/).find((l) => l.trim().startsWith("{")) || "{}"); } catch { /* handled below */ }
  const sf = sess.sessionFile || sessionFile;
  if (!sf) throw Object.assign(new Error("acquire returned no sessionFile"), { code: "SESSION_CONTEXT_MISSING" });
  console.log(`SESSION=${sess.sessionId || "acquired"} ALIAS=${alias}`);

  const withSf = (args) => [...args, "--alias", alias, "--session-file", sf];

  try {
    // 2. launch XHS fresh.
    const l = await runOps(withSf(["ops/launch-app.mjs", "--package", PKG, "--force-stop"]), 60000);
    if (l.code !== 0) throw Object.assign(new Error(`launch failed: ${l.out.slice(0, 200)}`), { code: "LAUNCH_FAILED" });
    await sleep(2600);

    // 3. dump home -> find the 消息 bottom tab (dynamic, no hardcoded coords).
    const d1 = await runOps(withSf(["ops/dump-ui.mjs"]), 60000);
    const k1 = kv(d1.out);
    if (!k1.DUMP || !existsSync(k1.DUMP)) throw Object.assign(new Error("dump_home"), { code: "DUMP_FAILED" });
    const homeXml = readFileSync(k1.DUMP, "utf8");
    const homeNodes = allNodes(homeXml);
    const screenHeight = Math.max(...homeNodes.map((n) => n.B), 0);
    const tabCandidates = homeNodes.filter((n) => {
      const label = (n.text || "").trim() || (n.desc || "").trim();
      return label === "消息" && n.cy >= screenHeight - 320;
    });
    if (tabCandidates.length !== 1) {
      console.log(JSON.stringify({ ok: false, code: "INBOX_TAB_NOT_UNIQUE", count: tabCandidates.length }));
      process.exit(2);
    }
    const tab = tabCandidates[0];
    console.log(`INBOX_TAB=(${tab.cx},${tab.cy})`);

    // 4. tap 消息 -> dump inbox.
    await runOps(withSf(["ops/tap.mjs", "--x", String(tab.cx), "--y", String(tab.cy)]), 30000);
    await sleep(2200);
    const d2 = await runOps(withSf(["ops/dump-ui.mjs"]), 60000);
    const k2 = kv(d2.out);
    if (!k2.DUMP || !existsSync(k2.DUMP)) throw Object.assign(new Error("dump_inbox"), { code: "DUMP_FAILED" });
    const inboxXml = readFileSync(k2.DUMP, "utf8");
    const entries = extractConversationEntries(inboxXml).filter((e) => e.peer);
    console.log(`INBOX_THREADS=${entries.length}`);
    for (const e of entries.slice(0, 20)) {
      console.log(`THREAD=${e.peer.slice(0, 40)} fp=${e.threadFingerprint.slice(0, 12)} last=${e.lastMessageFingerprint.slice(0, 12)}`);
    }

    // 5. read subcommand: uniqueness gate then enter + read-only observe.
    if (command === "read") {
      if (!threadLabel) throw Object.assign(new Error("--thread required for read"), { code: "ARGS" });
      const gate = resolveUniqueThreadByLabel(entries, threadLabel);
      if (!gate.unique) {
        console.log(JSON.stringify({ ok: false, code: "THREAD_NOT_UNIQUE", count: gate.count, thread: threadLabel }, null, 0));
        process.exit(2);
      }
      console.log(`UNIQUE=1 thread=${gate.entry.peer.slice(0, 40)} fp=${gate.entry.threadFingerprint.slice(0, 12)}`);
      if (!doEnter) { console.log("ENTER=skipped(--no-enter)"); process.exit(0); }
      // find the tappable row containing the peer label.
      const inboxNodes = allNodes(inboxXml);
      const row = inboxNodes.find((n) => (n.text || "").trim() === gate.entry.peer.trim() && n.clickable)
        || inboxNodes.find((n) => (n.text || "").trim() === gate.entry.peer.trim());
      if (!row) throw Object.assign(new Error("row not found for unique thread"), { code: "ROW_NOT_FOUND" });
      await runOps(withSf(["ops/tap.mjs", "--x", String(row.cx), "--y", String(row.cy)]), 30000);
      await sleep(2200);
      const d3 = await runOps(withSf(["ops/dump-ui.mjs"]), 60000);
      const k3 = kv(d3.out);
      if (!k3.DUMP || !existsSync(k3.DUMP)) throw Object.assign(new Error("dump_conversation"), { code: "DUMP_FAILED" });
      const convXml = readFileSync(k3.DUMP, "utf8");
      const convEntries = extractConversationEntries(convXml).filter((e) => e.snippet);
      const last = convEntries[convEntries.length - 1] || null;
      if (last) {
        console.log(`LAST_MSG_FP=${last.lastMessageFingerprint}`);
        console.log(`LAST_MSG_SNIPPET=${last.snippet.slice(0, 40)}`);
      } else {
        console.log("LAST_MSG_FP=none");
      }
      // back to inbox (read-only exit)
      await runOps(withSf(["ops/back.mjs"]), 30000);
      await sleep(1200);
      console.log(`READ_OK thread=${gate.entry.peer.slice(0, 40)}`);
    }

    console.log("R0_INBOX_OK read_only=1");
  } finally {
    if (sessionAcquired && sf) {
      await runOps(["ops/xw-explore-session.mjs", "release", "--session-file", sf], 30000);
    }
  }
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, code: e?.code || "R0_INBOX_FAILED", message: String(e?.message || e).slice(0, 300) }));
  process.exit(2);
});