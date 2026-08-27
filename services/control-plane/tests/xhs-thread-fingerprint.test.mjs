// Thread fingerprint + uniqueness gate test (executable-plan W3, inbox/read R0).
//
// "唯一才进，不唯一 stop" — a read-only inbox/read entry proceeds only when the
// target thread fingerprint matches exactly one conversation; zero or many
// matches => stop (report ambiguity, do not enter). This mirrors the grounding
// runtime's ambiguity check (duplicate peer labels -> REPLAN).
import assert from "node:assert/strict";
import test from "node:test";

import {
  extractConversationEntries,
  lastMessageFingerprintOf,
  parseDumpNodes,
  resolveUniqueThread,
  resolveUniqueThreadByLabel,
  threadFingerprintOf,
} from "../../orchestrator/scripts/lib/xhs-thread-fingerprint.mjs";
import { planAction } from "../../orchestrator/scripts/lib/xw-xhs-dispatcher.mjs";

function entry(peer, resourceId, snippet = "") {
  return { peer, resourceId, snippet };
}

test("threadFingerprintOf is deterministic and stable on (peer, resourceId)", () => {
  const a = threadFingerprintOf(entry("小书童", "com.xingin.xhs:id/title"));
  const b = threadFingerprintOf(entry("小书童", "com.xingin.xhs:id/title"));
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("same peer name + different resourceId slot -> different thread fingerprints", () => {
  const a = threadFingerprintOf(entry("小书童", "com.xingin.xhs:id/title_0"));
  const b = threadFingerprintOf(entry("小书童", "com.xingin.xhs:id/title_1"));
  assert.notEqual(a, b, "different slots -> different fingerprints (resource-id disambiguates)");
});

test("identical peer+slot collide (ambiguous); whitespace normalization is stable", () => {
  // Boundary-only whitespace is normalized away (trim + collapse). Internal
  // CJK spacing is NOT stripped — "小 书童" (internal space) is a distinct
  // display string from "小书童", and the fingerprint must not silently merge
  // them. This test proves the boundary case; the internal-space distinction
  // is asserted in the resolveUniqueThreadByLabel test below.
  const a = threadFingerprintOf(entry(" 小书童 ", "com.xingin.xhs:id/title"));
  const b = threadFingerprintOf(entry("小书童", "com.xingin.xhs:id/title"));
  assert.equal(a, b, "boundary whitespace normalized away");
});

test("threadFingerprint excludes the snippet (last message changes do not move the thread id)", () => {
  const fp = threadFingerprintOf(entry("小书童", "com.xingin.xhs:id/title", "在吗？"));
  const fp2 = threadFingerprintOf(entry("小书童", "com.xingin.xhs:id/title", "明天见"));
  assert.equal(fp, fp2, "thread fingerprint stable across last-message changes");
  // The last-message fingerprint DOES change with the snippet (W5 drift check).
  assert.notEqual(
    lastMessageFingerprintOf(entry("小书童", "rid", "在吗？")),
    lastMessageFingerprintOf(entry("小书童", "rid", "明天见")),
  );
});

test("resolveUniqueThread: exactly one match -> unique; zero or many -> stop", () => {
  const entries = extractConversationEntries([
    entry("小书童", "id/title_0"),
    entry("测试号", "id/title_1"),
    entry("小书童", "id/title_2"), // same NAME, different SLOT -> different fingerprint
  ]);
  // Target the first entry's fingerprint -> exactly one match.
  const one = resolveUniqueThread(entries, entries[0].threadFingerprint);
  assert.equal(one.count, 1);
  assert.equal(one.unique, true);
  assert.equal(one.entry.peer, "小书童");

  // Unknown fingerprint -> zero matches -> not unique (stop).
  const zero = resolveUniqueThread(entries, "0".repeat(64));
  assert.equal(zero.count, 0);
  assert.equal(zero.unique, false);
  assert.equal(zero.entry, null);

  // Two entries with identical peer+slot -> same fingerprint -> many -> stop.
  const dup = extractConversationEntries([
    entry("小书童", "id/title_0"),
    entry("小书童", "id/title_0"),
  ]);
  const many = resolveUniqueThread(dup, dup[0].threadFingerprint);
  assert.equal(many.count, 2);
  assert.equal(many.unique, false, "duplicate target -> 不唯一 stop");
});

test("resolveUniqueThreadByLabel: normalized-label uniqueness gate", () => {
  const entries = extractConversationEntries([
    entry(" 小书童 ", "id/title_0"),
    entry("测试号", "id/title_1"),
    entry("小书童", "id/title_2"), // same label (boundary ws normalized), different slot
  ]);
  // Two entries share the normalized label "小书童" -> not unique.
  const ambig = resolveUniqueThreadByLabel(entries, "小书童");
  assert.equal(ambig.count, 2);
  assert.equal(ambig.unique, false);

  // "测试号" is unique by label.
  const unique = resolveUniqueThreadByLabel(entries, "测试号");
  assert.equal(unique.count, 1);
  assert.equal(unique.unique, true);
  assert.equal(unique.entry.peer, "测试号");

  // No match -> stop.
  const none = resolveUniqueThreadByLabel(entries, "不存在");
  assert.equal(none.count, 0);
  assert.equal(none.unique, false);
});

test("parseDumpNodes extracts text-bearing nodes from a UI hierarchy dump", () => {
  const dump = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.ListView" />
  <node index="1" text="小书童" resource-id="com.xingin.xhs:id/title" class="android.widget.TextView" bounds="[0,100][360,220]" />
  <node index="2" text="在吗？" resource-id="com.xingin.xhs:id/sub_title" class="android.widget.TextView" bounds="[0,220][360,280]" />
  <node index="3" text="测试号" resource-id="com.xingin.xhs:id/title" class="android.widget.TextView" bounds="[0,300][360,420]" />
</hierarchy>`;
  const nodes = parseDumpNodes(dump);
  // Empty-text nodes are skipped; the three text-bearing nodes are extracted.
  assert.equal(nodes.length, 3);
  assert.equal(nodes[0].text, "小书童");
  assert.equal(nodes[0].resourceId, "com.xingin.xhs:id/title");
  assert.equal(nodes[2].text, "测试号");
  assert.equal(nodes[0].bounds, "[0,100][360,220]");

  // Empty/garbage input is safe.
  assert.deepEqual(parseDumpNodes(""), []);
  assert.deepEqual(parseDumpNodes(null), []);
  assert.deepEqual(parseDumpNodes("no nodes here"), []);
});

test("extractConversationEntries from a dump string yields fingerprinted entries", () => {
  const dump = `<hierarchy>
    <node text="小书童" resource-id="com.xingin.xhs:id/title_0" class="android.widget.TextView" />
    <node text="测试号" resource-id="com.xingin.xhs:id/title_1" class="android.widget.TextView" />
  </hierarchy>`;
  const entries = extractConversationEntries(dump);
  assert.equal(entries.length, 2);
  for (const e of entries) {
    assert.match(e.threadFingerprint, /^[0-9a-f]{64}$/);
    assert.match(e.lastMessageFingerprint, /^[0-9a-f]{64}$/);
  }
  // The two entries have distinct fingerprints (different slots).
  assert.notEqual(entries[0].threadFingerprint, entries[1].threadFingerprint);
  // Resolving the first entry's fingerprint is unique.
  assert.equal(resolveUniqueThread(entries, entries[0].threadFingerprint).unique, true);
});

test("dispatcher: inbox/read are r0_workflow, gate W3, adaptiveRoute DUMP (not RECIPE)", () => {
  const inbox = planAction({ actionId: "inbox" });
  assert.equal(inbox.backend, "r0_workflow");
  assert.equal(inbox.gate, "W3");
  assert.equal(inbox.effectClass, "none");
  assert.equal(inbox.adaptiveRoute, "DUMP");
  assert.equal(inbox.alias, "04");
  assert.ok(inbox.stopConditions.includes("non-unique conversation entered"));

  const read = planAction({ actionId: "read", params: { thread: "小书童" } });
  assert.equal(read.backend, "r0_workflow");
  assert.equal(read.gate, "W3");
  assert.equal(read.adaptiveRoute, "DUMP");
  assert.ok(read.stopConditions.includes("thread fingerprint not unique"));
  // read requires a thread param (PlanError carries the code).
  assert.throws(() => planAction({ actionId: "read" }), { code: "PARAMS_REQUIRED" });
});

test("dispatcher: 'messages' alias resolves to the inbox action", () => {
  const msg = planAction({ actionId: "messages" });
  assert.equal(msg.action, "inbox");
  assert.equal(msg.backend, "r0_workflow");
});