// xhs-comment-dm-bound.test.mjs — W5 comment + DM bound-send invariants (S3).
//
// The plan acceptance: "F3/弱验证/模糊用户名/last-message 漂移均不得 send 或报
// verified." Four things must NOT happen:
//   * 弱验证 (weak verification) — the old "composer closed" / "tapped-send" pass
//     must NOT report verified (demoted to ambiguous).
//   * 模糊用户名 (fuzzy username) — contains/maybe/prefix match must NOT send.
//   * last-message 漂移 — the thread's last message changed since we decided to
//     reply (peer interleaved) must NOT send.
//   * F3 — an ambiguous comment/reply outcome poisons (mission,action,target)
//     against a blind retry (AMBIGUOUS_NO_RETRY), reusing the W4 fence.
//
// Comment + DM verifiers are pure; the F3 fence test uses the real StateStore.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  commentTextHash,
  extractPostedComments,
  verifyCommentSend,
} from "../apps/xhs/comment-verifier.mjs";
import {
  decideDmReplySend,
  expectedReplyLastMessageFingerprint,
  usernameMatch,
  verifyDmReplySend,
} from "../apps/xhs/dm-verifier.mjs";
import { lastMessageFingerprintOf, threadFingerprintOf } from "../../orchestrator/scripts/lib/xhs-thread-fingerprint.mjs";
import { bindOperationKey } from "../../orchestrator/scripts/lib/xw-xhs-dispatcher.mjs";

import { ControlPlaneError } from "../control-plane/lib/errors.mjs";
import { MissionRuntime } from "../control-plane/lib/mission-runtime.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";

const SENT = "学到了，谢谢分享";
const hash = commentTextHash;

// =================== Comment verifier (弱验证 rejection + strong proof) ======

test("comment: strong verify = exact text hash + count delta + own-latest-comment", () => {
  const r = verifyCommentSend({
    sentText: SENT,
    before: { commentCount: 12 },
    after: {
      postedComments: [{ text: SENT, author: "me" }, { text: "好文章", author: "甲" }],
      commentCount: 13,
      composerOpen: false,
      sendButtonPresent: false,
    },
  });
  assert.equal(r.status, "verified");
  assert.equal(r.reason, "text+count+own-latest");
  assert.ok(r.evidence.includes("own-latest-comment"));
});

test("comment: 弱验证 — composer closed but no posted comment + no count delta => ambiguous (NOT verified)", () => {
  // This is the old xhs-comment-one.mjs:316-319 weak pass ("composer-closed").
  // W5 demotes it to ambiguous so a closed composer alone is no longer trusted.
  const r = verifyCommentSend({
    sentText: SENT,
    before: { commentCount: 12 },
    after: { postedComments: [], commentCount: 12, composerOpen: false, sendButtonPresent: false },
  });
  assert.equal(r.status, "ambiguous");
  assert.equal(r.reason, "composer-closed-weak");
  assert.notEqual(r.status, "verified", "weak composer-closed must NOT be verified");
});

test("comment: text present but count did not increase => ambiguous (stale/replay)", () => {
  const r = verifyCommentSend({
    sentText: SENT,
    before: { commentCount: 12 },
    after: { postedComments: [{ text: SENT }], commentCount: 12, composerOpen: false, sendButtonPresent: false },
  });
  assert.equal(r.status, "ambiguous");
  assert.equal(r.reason, "text-present-no-count-delta");
});

test("comment: count increased but my text missing => ambiguous (someone else commented)", () => {
  const r = verifyCommentSend({
    sentText: SENT,
    before: { commentCount: 12 },
    after: { postedComments: [{ text: "顶一下" }], commentCount: 13, composerOpen: false, sendButtonPresent: false },
  });
  assert.equal(r.status, "ambiguous");
  assert.equal(r.reason, "count-delta-text-missing");
});

test("comment: composer still open / send button present => not_sent (transport did not happen)", () => {
  const open = verifyCommentSend({
    sentText: SENT,
    before: { commentCount: 12 },
    after: { postedComments: [], commentCount: 12, composerOpen: true, sendButtonPresent: true },
  });
  assert.equal(open.status, "not_sent");
  assert.equal(open.reason, "composer-still-open");
});

test("comment: text+count but peer interleaved newer comment => still verified (own-latest is strengthening)", () => {
  // my comment posted (text hash present + count increased) but a peer's comment
  // is now newest — my send DID land, so this is verified, not ambiguous.
  const r = verifyCommentSend({
    sentText: SENT,
    before: { commentCount: 12 },
    after: {
      postedComments: [{ text: "刚发了朋友圈" }, { text: SENT }],
      commentCount: 13,
      composerOpen: false,
      sendButtonPresent: false,
    },
  });
  assert.equal(r.status, "verified");
  assert.equal(r.reason, "text+count (peer-interleaved)");
});

test("comment: commentTextHash is deterministic + namespaced (different text => different hash)", () => {
  assert.equal(hash(SENT), hash(SENT));
  assert.match(hash(SENT), /^[0-9a-f]{64}$/);
  assert.notEqual(hash(SENT), hash("不同内容"));
  // empty/undefined are stable, not throwing.
  assert.equal(hash(""), hash(""));
  assert.equal(typeof hash(undefined), "string");
});

test("comment: extractPostedComments drops UI labels, keeps bodies", () => {
  const nodes = [
    { text: "评论" }, { text: "123" }, { text: "点赞" }, { text: SENT }, { text: "好文章" }, { text: "" },
  ];
  const out = extractPostedComments(nodes);
  assert.deepEqual(out.map((c) => c.text).sort(), [SENT, "好文章"].sort());
});

// =================== DM verifier (fuzzy username + drift gates) ==============

test("dm usernameMatch: exact / fuzzy (contains+prefix) / none", () => {
  assert.equal(usernameMatch("天才较瘦", "天才较瘦"), "exact");
  // fuzzy: target is a substring of observed (the dangerous "contains" case).
  assert.equal(usernameMatch("天才", "天才较瘦"), "fuzzy", "target substring of observed is fuzzy");
  assert.equal(usernameMatch("天才较瘦", "天才"), "fuzzy", "observed substring of target is fuzzy");
  // fuzzy: 4-char prefix collision (the old user.slice(0,4) ladder).
  assert.equal(usernameMatch("天才较瘦A", "天才较瘦B"), "fuzzy", "4-char prefix collision is fuzzy");
  // none.
  assert.equal(usernameMatch("天才较瘦", "完全不同"), "none");
  // whitespace normalize.
  assert.equal(usernameMatch(" 天才较瘦 ", "天才较瘦"), "exact");
  // short names (<4) only match on substring, not prefix.
  assert.equal(usernameMatch("ab", "ab"), "exact");
  assert.equal(usernameMatch("ab", "abc"), "fuzzy");
  assert.equal(usernameMatch("ab", "xy"), "none");
});

test("dm decideDmReplySend: 模糊用户名 => NO SEND (USERNAME_FUZZY)", () => {
  const d = decideDmReplySend({
    targetUsername: "天才",
    observedUsername: "天才较瘦", // contains → fuzzy
    threadMatchCount: 1,
    expectedLastMessageFingerprint: lastMessageFingerprintOf({ snippet: "在吗" }),
    observedLastMessageFingerprint: lastMessageFingerprintOf({ snippet: "在吗" }),
  });
  assert.equal(d.send, false);
  assert.equal(d.reason, "USERNAME_FUZZY");
});

test("dm decideDmReplySend: username none => NO SEND (USERNAME_NONE)", () => {
  const d = decideDmReplySend({
    targetUsername: "天才较瘦",
    observedUsername: "完全不同",
    threadMatchCount: 1,
    expectedLastMessageFingerprint: "x",
    observedLastMessageFingerprint: "x",
  });
  assert.equal(d.send, false);
  assert.equal(d.reason, "USERNAME_NONE");
});

test("dm decideDmReplySend: thread not unique (0 or >1) => NO SEND", () => {
  const fp = lastMessageFingerprintOf({ snippet: "在吗" });
  const zero = decideDmReplySend({
    targetUsername: "天才较瘦", observedUsername: "天才较瘦", threadMatchCount: 0,
    expectedLastMessageFingerprint: fp, observedLastMessageFingerprint: fp,
  });
  assert.equal(zero.send, false);
  assert.equal(zero.reason, "THREAD_NOT_UNIQUE");

  const many = decideDmReplySend({
    targetUsername: "天才较瘦", observedUsername: "天才较瘦", threadMatchCount: 2,
    expectedLastMessageFingerprint: fp, observedLastMessageFingerprint: fp,
  });
  assert.equal(many.send, false);
  assert.equal(many.reason, "THREAD_AMBIGUOUS");
});

test("dm decideDmReplySend: last-message 漂移 => NO SEND (LAST_MESSAGE_DRIFT)", () => {
  // the peer replied between read and send → last message fingerprint changed.
  const expected = lastMessageFingerprintOf({ snippet: "在吗" });
  const drifted = lastMessageFingerprintOf({ snippet: "在吗，方便聊聊吗？" });
  assert.notEqual(expected, drifted, "fixture: snippets differ => fp differs");
  const d = decideDmReplySend({
    targetUsername: "天才较瘦",
    observedUsername: "天才较瘦",
    threadMatchCount: 1,
    expectedLastMessageFingerprint: expected,
    observedLastMessageFingerprint: drifted,
  });
  assert.equal(d.send, false);
  assert.equal(d.reason, "LAST_MESSAGE_DRIFT");
});

test("dm decideDmReplySend: all gates pass => proceed (send=true)", () => {
  const fp = lastMessageFingerprintOf({ snippet: "在吗" });
  const d = decideDmReplySend({
    targetUsername: "天才较瘦",
    observedUsername: "天才较瘦",
    threadMatchCount: 1,
    expectedLastMessageFingerprint: fp,
    observedLastMessageFingerprint: fp,
  });
  assert.equal(d.send, true);
  assert.equal(d.reason, "proceed");
});

test("dm verifyDmReplySend: my reply is the new last message => verified", () => {
  const after = lastMessageFingerprintOf({ snippet: SENT }); // last msg is now my reply
  assert.equal(after, expectedReplyLastMessageFingerprint(SENT), "shared W3 fingerprint scheme");
  const r = verifyDmReplySend({ sentText: SENT, afterLastMessageFingerprint: after });
  assert.equal(r.status, "verified");
  assert.equal(r.reason, "last-message-is-mine");
});

test("dm verifyDmReplySend: 弱验证 — tapped-send / input-cleared but last msg not mine => ambiguous", () => {
  // the old xhs-dm-user.mjs:340-344 weak passes ("tapped-send"/"input-cleared")
  // land here: composer closed but the last message is NOT my reply.
  const someoneElse = lastMessageFingerprintOf({ snippet: "我刚好也想问" });
  const r = verifyDmReplySend({ sentText: SENT, afterLastMessageFingerprint: someoneElse });
  assert.equal(r.status, "ambiguous");
  assert.equal(r.reason, "last-message-not-mine");
  assert.notEqual(r.status, "verified", "weak tapped-send must NOT be verified");
});

test("dm verifyDmReplySend: composer still open => not_sent", () => {
  const r = verifyDmReplySend({
    sentText: SENT,
    afterLastMessageFingerprint: expectedReplyLastMessageFingerprint(SENT),
    composerOpen: true,
  });
  assert.equal(r.status, "not_sent");
});

test("dm: thread fingerprint + last-message fingerprint compose the binding identity", () => {
  // The W3 formalization: the DM binding identity = threadFingerprint (stable
  // peer+slot) + lastMessageFingerprint (drift signal). Two threads with the same
  // peer but different resourceId slots are distinct; the same thread with a
  // changed last message drifts.
  const t1 = threadFingerprintOf({ peer: "天才较瘦", resourceId: "msg-list-1" });
  const t2 = threadFingerprintOf({ peer: "天才较瘦", resourceId: "msg-list-2" });
  assert.notEqual(t1, t2, "same peer, different slot => different thread fp");
  const lm1 = lastMessageFingerprintOf({ snippet: "在吗" });
  const lm2 = lastMessageFingerprintOf({ snippet: "在吗？" });
  assert.notEqual(lm1, lm2, "different last message => different last-msg fp (drift)");
});

// =================== F3 fence: ambiguous comment/reply => no blind retry =======

function setupMission({ actions, targets, totalCount = 5 }) {
  const root = mkdtempSync(join(tmpdir(), "w5-cdm-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const missions = new MissionRuntime({ state });
  state.upsertNode({ nodeId: "W5-AUTH", authority: true });
  state.upsertDevice({
    alias: "04", physicalLabel: "rack-04", nodeId: "W5-AUTH", runtimeId: "private-runtime-04",
    routingProfile: { enabled: true, tags: ["slot:04"], capabilityIds: [] },
  });
  const { mission } = missions.createMission({
    issuer: { actorId: "human:operator" }, idempotencyKey: `w5-${Math.random()}`,
    app: "xhs", account: "local-alias-04", parallelism: 1, controllers: ["agent:runner"],
    scope: {
      actions, targets: { kind: "fingerprint", values: targets },
      totalCount, perTargetCount: 1, frequency: { count: 100, windowSeconds: 3600 },
    },
    validity: { expiresAt: "2099-07-29T16:00:00Z" }, policy: { publish: "confirm", delete: "confirm" },
  });
  const run = state.openDeviceRunStorage({
    missionId: mission.missionId, missionHash: mission.missionHash, missionVersion: mission.version,
    controllerAgent: "agent:runner", authorityNodeId: "W5-AUTH",
  });
  return {
    root, state, mission, run,
    begin: ({ action, target, idempotencyKey }) => state.beginMissionEffect({
      mission, deviceRunId: run.tuple.deviceRunId, action, targetHash: target,
      intent: { surface: "social-effect" }, idempotencyKey,
    }),
    cleanup: () => { state.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("F3 fence: ambiguous comment outcome => retry_blocked => AMBIGUOUS_NO_RETRY on same triple", () => {
  const f = setupMission({ actions: ["comment"], targets: ["note-abc"] });
  try {
    // The adapter ran verifyCommentSend -> ambiguous (weak composer-closed). It
    // records the ambiguous outcome, which sets retry_blocked=1.
    const idk = bindOperationKey({ actionRunId: "ar_w5", action: "comment", targetFingerprint: "note-abc", payloadHash: commentTextHash(SENT) });
    const r1 = f.begin({ action: "comment", target: "note-abc", idempotencyKey: idk });
    const outcome = f.state.recordMissionEffectOutcome(r1.effect.effectId, { status: "ambiguous" });
    assert.equal(outcome.retryBlocked, true, "ambiguous comment -> retry_blocked=1");

    // A blind retry on the SAME (mission,action,target) with a fresh idempotency
    // key is AMBIGUOUS_NO_RETRY — the fence is checked before the budget gate.
    assert.throws(
      () => f.begin({ action: "comment", target: "note-abc", idempotencyKey: bindOperationKey({ actionRunId: "ar_w5", action: "comment", targetFingerprint: "note-abc", payloadHash: commentTextHash("不同的重试") }) }),
      (e) => e instanceof ControlPlaneError && e.code === "AMBIGUOUS_NO_RETRY" && e.status === 409,
    );
    assert.equal(f.state.listMissionEffects(f.mission.missionId).length, 1, "fenced retry created no new effect");
  } finally {
    f.cleanup();
  }
});

test("F3 fence: ambiguous reply outcome => retry_blocked (same fence for DM reply)", () => {
  const f = setupMission({ actions: ["reply"], targets: ["thread-xyz"] });
  try {
    const idk = bindOperationKey({ actionRunId: "ar_w5", action: "reply", targetFingerprint: "thread-xyz", payloadHash: commentTextHash("你好") });
    const r1 = f.begin({ action: "reply", target: "thread-xyz", idempotencyKey: idk });
    f.state.recordMissionEffectOutcome(r1.effect.effectId, { status: "ambiguous" });

    // retry same triple (different payload hash = different intent, but SAME
    // mission+action+target) is still fenced — the fence is per-triple, not per-payload.
    assert.throws(
      () => f.begin({ action: "reply", target: "thread-xyz", idempotencyKey: bindOperationKey({ actionRunId: "ar_w5", action: "reply", targetFingerprint: "thread-xyz", payloadHash: commentTextHash("再问一次") }) }),
      (e) => e instanceof ControlPlaneError && e.code === "AMBIGUOUS_NO_RETRY",
    );
  } finally {
    f.cleanup();
  }
});

test("F3 fence: a different comment target is NOT fenced (the fence is per-triple)", () => {
  const f = setupMission({ actions: ["comment"], targets: ["note-abc", "note-def"] });
  try {
    const idk = bindOperationKey({ actionRunId: "ar_w5", action: "comment", targetFingerprint: "note-abc", payloadHash: commentTextHash(SENT) });
    const r1 = f.begin({ action: "comment", target: "note-abc", idempotencyKey: idk });
    f.state.recordMissionEffectOutcome(r1.effect.effectId, { status: "ambiguous" });

    // a different note proceeds — the poisoned triple is (mission,comment,note-abc).
    const r2 = f.begin({ action: "comment", target: "note-def", idempotencyKey: bindOperationKey({ actionRunId: "ar_w5", action: "comment", targetFingerprint: "note-def", payloadHash: commentTextHash(SENT) }) });
    assert.equal(r2.reused, false, "different target is not fenced");
  } finally {
    f.cleanup();
  }
});