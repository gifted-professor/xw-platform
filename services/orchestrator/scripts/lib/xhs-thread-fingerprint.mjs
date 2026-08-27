// xhs-thread-fingerprint.mjs — inbox/read R0 workflow fingerprint + uniqueness
// gate (plan V2 §6 / executable-plan W3 + W5 formalization).
//
// The inbox/read actions are r0_workflow: Explorer session acquire -> dump_ui ->
// read-only collection -> release. They are R0 (no tap/input/send). The one
// decision the workflow must make is WHICH conversation to read — and the plan's
// rule is "唯一才进，不唯一 stop" (only enter if the target thread fingerprint
// matches exactly one conversation; stop if zero or many match). This mirrors the
// grounding runtime's `ambiguity` check (duplicate peer labels -> REPLAN): a
// non-unique target is never acted on.
//
// Pure + offline-testable. The live wiring (Explorer dump_ui primitive -> XML)
// feeds the dump string into parseDumpNodes; tests inject fixture dumps. The
// thread fingerprint hashes a conversation's STABLE identity (normalized peer
// name + resource-id slot). The last-message snippet is intentionally excluded
// — it changes every message and has its own last-message fingerprint (W5,
// used by reply's "last-message fingerprint drifted" stop condition).
//
// NOTE: this is NOT a navigation decision surface. It only decides whether a
// read-only entry is UNIQUE. Entering the thread (tap) is a separate, W5-gated
// effect for reply; W3 inbox/read never taps — read-only collection stops at the
// dump, so a non-unique result means "report ambiguity, do not enter".
import { createHash } from "node:crypto";

const NODE_RE = /<node\b([^>]*?)\/?>/g;
const ATTR_RE = /([\w:-]+)\s*=\s*"([^"]*)"/g;

function parseNodeAttributes(attrString) {
  const attrs = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(attrString)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

/**
 * Extract text-bearing nodes from an Android UI hierarchy dump (the XML emitted
 * by the Explorer `dump_ui` primitive / `uiautomator dump`). Returns nodes with
 * { text, resourceId, bounds, className }. Empty/non-string input -> [].
 */
export function parseDumpNodes(dumpXml) {
  if (typeof dumpXml !== "string" || !dumpXml) return [];
  const nodes = [];
  let m;
  NODE_RE.lastIndex = 0;
  while ((m = NODE_RE.exec(dumpXml)) !== null) {
    const attrs = parseNodeAttributes(m[1]);
    const text = attrs.text || attrs["content-desc"] || "";
    if (!text) continue;
    nodes.push({
      text,
      resourceId: attrs["resource-id"] || "",
      bounds: attrs.bounds || "",
      className: attrs.class || "",
    });
  }
  return nodes;
}

function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function normalizeLabel(s) {
  return String(s ?? "").trim().replace(/\s+/g, " ");
}

/**
 * Thread fingerprint — stable identity of a conversation. Hashes the normalized
 * peer name + resource-id slot. Two conversations with the same display name but
 * different list slots (different resource-id) get different fingerprints; two
 * with the same name AND same slot collide (ambiguous -> the uniqueness gate
 * stops). The last-message snippet is NOT included.
 */
export function threadFingerprintOf(entry) {
  const peer = normalizeLabel(entry?.peer ?? entry?.text ?? "");
  const rid = String(entry?.resourceId ?? "").trim();
  return sha256(`xw.xhs.thread:${peer}|${rid}`);
}

/**
 * Last-message fingerprint (W5 stop condition "last-message fingerprint
 * drifted"). Hashes the normalized snippet. Used by reply to detect that the
 * thread's last message changed between read and send (drift -> stop).
 */
export function lastMessageFingerprintOf(entry) {
  const snippet = normalizeLabel(entry?.snippet ?? "");
  return sha256(`xw.xhs.lastmsg:${snippet}`);
}

/**
 * Build conversation entries from a dump. Accepts:
 *   - a dump XML string (parsed via parseDumpNodes; each text node becomes an
 *     entry with peer=text, snippet="", resourceId from the node)
 *   - a pre-shaped entry array (each { peer, snippet, resourceId }) — used by
 *     tests and by the live wiring when it pairs title+subtext itself
 * Each returned entry carries its threadFingerprint + lastMessageFingerprint.
 */
export function extractConversationEntries(dumpOrNodes) {
  const nodes = typeof dumpOrNodes === "string"
    ? parseDumpNodes(dumpOrNodes)
    : Array.isArray(dumpOrNodes) ? dumpOrNodes : [];
  return nodes.map((n) => {
    const entry = {
      peer: n.peer ?? n.text ?? "",
      snippet: n.snippet ?? "",
      resourceId: n.resourceId ?? n.resourceId ?? "",
    };
    return {
      ...entry,
      threadFingerprint: threadFingerprintOf(entry),
      lastMessageFingerprint: lastMessageFingerprintOf(entry),
    };
  });
}

/**
 * The uniqueness gate: "唯一才进，不唯一 stop".
 *
 * Resolves a target thread fingerprint among conversation entries. Returns
 * { unique, count, entry }. `unique === true` only when exactly one entry's
 * threadFingerprint equals the target — zero or many matches => unique=false,
 * and the caller MUST stop (do not enter). This is the R0 read-only decision:
 * a non-unique target is reported, never acted on.
 */
export function resolveUniqueThread(entries, targetFingerprint) {
  const matches = (entries || []).filter(
    (e) => e.threadFingerprint === targetFingerprint,
  );
  return {
    unique: matches.length === 1,
    count: matches.length,
    entry: matches.length === 1 ? matches[0] : null,
  };
}

/**
 * Resolve by peer label (normalized). Convenience for the inbox action which
 * takes a thread label rather than a precomputed fingerprint. Same uniqueness
 * contract: exactly one normalized-label match => unique.
 */
export function resolveUniqueThreadByLabel(entries, targetLabel) {
  const target = normalizeLabel(targetLabel);
  const matches = (entries || []).filter(
    (e) => normalizeLabel(e.peer) === target,
  );
  return {
    unique: matches.length === 1,
    count: matches.length,
    entry: matches.length === 1 ? matches[0] : null,
  };
}