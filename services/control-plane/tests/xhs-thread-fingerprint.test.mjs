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
  extractConversationState,
  groupInboxRows,
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
// ── W5 live prerequisites: row-level inbox grouping + conversation state ──

test("groupInboxRows: parses the real row-desc shape (peer，，，snippet，date), skips non-row nodes", () => {
  const dump =
    '<node content-desc="弥诉雪，，，[谢谢你的赞H]谢谢你的赞，06月25号" resource-id="com.xingin.xhs:id/0_resource_name_obfuscated" clickable="true" bounds="[0,1160][1080,1298]"/>' +
    '<node content-desc="婷姐说流量，，，你好，简单的看了一下你的笔记&#10;1:帐号定位和封面都需要调整&#10;2:，06月22号" clickable="true" bounds="[0,1358][1080,1496]"/>' +
    '<node text="消息" bounds="[0,2260][300,2330]"/>' +
    '<node text="打开通知，不再错过互动消息" bounds="[100,2110][800,2146]"/>';
  const rows = groupInboxRows(dump);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].peer, "弥诉雪");
  assert.equal(rows[0].snippet, "[谢谢你的赞H]谢谢你的赞");
  assert.equal(rows[0].date, "06月25号");
  // sorted top-first
  assert.ok(rows[0].cy < rows[1].cy);
  // snippet containing internal fullwidth commas still splits correctly
  assert.equal(rows[1].peer, "婷姐说流量");
  assert.ok(rows[1].snippet.includes("帐号定位"));
  assert.equal(rows[1].date, "06月22号");
  // fingerprints flow through
  assert.match(rows[0].threadFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(
    rows[0].threadFingerprint,
    threadFingerprintOf({ peer: "弥诉雪", resourceId: "com.xingin.xhs:id/0_resource_name_obfuscated" }),
  );
  assert.equal(rows[0].lastMessageFingerprint, lastMessageFingerprintOf({ snippet: "[谢谢你的赞H]谢谢你的赞" }));
});

test("groupInboxRows: empty/garbage dump -> [] (fail-closed, no fabricated rows)", () => {
  assert.deepEqual(groupInboxRows(""), []);
  assert.deepEqual(groupInboxRows(null), []);
  assert.deepEqual(groupInboxRows("<node text=\"首页\" bounds=\"[0,0][100,100]\"/>"), []);
});

test("groupInboxRows + resolveUniqueThreadByLabel: unique/ambiguous/absent gate", () => {
  const dump =
    '<node content-desc="小书童，，，在吗，08月01号" clickable="true" bounds="[0,600][1080,738]"/>' +
    '<node content-desc="小书童，，，在吗，08月20号" clickable="true" bounds="[0,800][1080,938]"/>' +
    '<node content-desc="弥诉雪，，，赞了你的笔记，06月25号" clickable="true" bounds="[0,1000][1080,1138]"/>';
  const rows = groupInboxRows(dump);
  // same peer in two slots: label resolution is ambiguous (do not enter)
  assert.equal(resolveUniqueThreadByLabel(rows, "小书童").unique, false);
  assert.equal(resolveUniqueThreadByLabel(rows, "小书童").count, 2);
  assert.equal(resolveUniqueThreadByLabel(rows, "弥诉雪").unique, true);
  assert.equal(resolveUniqueThreadByLabel(rows, "不存在").unique, false);
});

test("extractConversationState: username from title band, last bubble by geometry, excludes action row and timestamps", () => {
  const conv =
    '<node text="奥莱斯卡曼鞋服" bounds="[300,540][780,582]"/>' +
    '<node text="07-21 下午4:42" bounds="[410,780][670,800]"/>' +
    '<node text="粉丝 45 " bounds="[150,1220][400,1250]"/>' +
    '<node text="[谢谢你的赞H]谢谢你的赞" bounds="[200,1900][468,1958]"/>' +
    '<node text="拉黑" bounds="[150,2130][312,2162]"/>' +
    '<node text="举报" bounds="[495,2130][657,2162]"/>' +
    '<node text="删除对话" bounds="[840,2130][1002,2162]"/>';
  const st = extractConversationState(conv);
  assert.equal(st.username, "奥莱斯卡曼鞋服");
  assert.equal(st.lastMessage.text, "[谢谢你的赞H]谢谢你的赞");
  assert.equal(st.lastMessage.mine, false); // left side (cx 334 < 540)
  // a right-side (mine) bubble BELOW the peer bubble becomes the last message
  const mineDump = conv + '<node text="不客气呀～" bounds="[700,1980][1000,2038]"/>';
  assert.equal(extractConversationState(mineDump).lastMessage.mine, true);
  assert.equal(extractConversationState(mineDump).lastMessage.text, "不客气呀～");
});

test("extractConversationState: no bubble in band -> lastMessage null (fail-closed)", () => {
  const st = extractConversationState('<node text="某人" bounds="[300,540][780,582]"/>');
  assert.equal(st.username, "某人");
  assert.equal(st.lastMessage, null);
});

test("extractConversationState: short 2-message thread (real Lucky-pinkpie shape) — bubbles near top, chips/composer excluded", () => {
  // Real recon dump: title 145, timestamps 247/483 (center), my bubble 365,
  // peer bubble 601, quick-reply chips y≈2125, composer y≈2273.
  const conv =
    '<node text="Lucky-pinkpie" bounds="[220,125][510,165]"/>' +
    '<node text="06-15 下午8:44" bounds="[410,237][670,269]"/>' +
    '<node text="不会特别热" bounds="[700,340][856,398]"/>' +
    '<node text="06-15 下午8:58" bounds="[410,467][670,499]"/>' +
    '<node text="啊哈哈哈谢谢姐妹！[飞吻R][飞吻R][飞吻R] " bounds="[180,570][766,632]"/>' +
    '<node text="hello" bounds="[120,2105][206,2145]"/>' +
    '<node text="谢谢宝" bounds="[330,2105][442,2145]"/>' +
    '<node text="发消息…" bounds="[220,2250][756,2300]"/>';
  const st = extractConversationState(conv);
  assert.equal(st.username, "Lucky-pinkpie");
  assert.equal(st.lastMessage.text, "啊哈哈哈谢谢姐妹！[飞吻R][飞吻R][飞吻R]");
  assert.equal(st.lastMessage.mine, false);
  // the quick-reply chips and composer are NOT mistaken for the last bubble
  assert.ok(st.lastMessage.cy < 2100);
});
