/**
 * xhs-feed-routine-machine.test.mjs — deterministic state-machine invariants
 * (direct-routine plan V2 §4/§6/§10.4): per-item single open, video comment
 * swipe = 0, bounded dwell/screens/skips, semantic back confirm, UNKNOWN skip,
 * forbidden-surface freeze, seeded replay determinism, deferred/capped effects,
 * explicit refresh, injected R0 vision fallback, and authoritative cleanup.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { planRoutine, ROUTINE_ALIAS } from "../scripts/lib/xhs-routine-plan.mjs";
import { createRoutineRun } from "../scripts/lib/xhs-feed-routine-machine.mjs";
import { PAGE_CLASS } from "../scripts/lib/xhs-feed-surface.mjs";

const FEED_FOCUS = "com.xingin.xhs/com.xingin.xhs.index.v2.IndexActivityV2";
const NOTE_FOCUS = "com.xingin.xhs/com.xingin.xhs.note.NoteDetailActivity";
const VIDEO_FOCUS = "com.xingin.xhs/com.xingin.xhs.note.DetailFeedActivity";

const NOTE_DESC = "笔记 攀岩入门三条路线 来自小岩 123赞";
const VIDEO_DESCS = ["视频 日落 来自u 5赞", "视频 海边 来自u 6赞"];

const NOTE_DETAIL_XML = '<node class="android.widget.TextView" content-desc="点赞" text="" bounds="[40,2200][140,2300]"/>'
  + '<node class="android.widget.TextView" content-desc="评论" text="" bounds="[240,2200][340,2300]"/>'
  + '<node class="android.widget.TextView" text="小岩" bounds="[40,600][120,660]"/>'
  + '<node class="android.widget.TextView" text="这条路线讲解得非常清楚，收藏了" bounds="[40,680][900,740]"/>';
const VIDEO_XML = '<node class="android.view.TextureView" content-desc="" text="" bounds="[0,180][1080,1500]"/>'
  + '<node class="android.widget.TextView" content-desc="评论" text="" bounds="[860,2200][940,2260]"/>';
const EMPTY_INDEX_XML = '<node class="android.widget.TextView" text="网络不给力，点击重试" bounds="[0,0][1080,2400]"/>';

function feedCardXml(desc, bounds) {
  return `<node class="android.widget.ImageView" content-desc="${desc}" text="" clickable="true" bounds="${bounds}"/>`;
}

function feedXml(count) {
  // distinct positions (distinct target fingerprints), one media kind — the
  // default detailDump asserts IMAGE_NOTE; video paths override detailDump.
  const cols = ["[40,400][500,900]", "[560,400][1020,900]", "[40,1000][500,1500]", "[560,1000][1020,1500]", "[40,1600][500,2000]"];
  let out = "";
  for (let i = 0; i < count; i += 1) {
    out += feedCardXml(NOTE_DESC, cols[i % cols.length]);
  }
  return out;
}

const FEED_DUMP = { xml: feedXml(4), focus: FEED_FOCUS, pkg: "com.xingin.xhs" };

/** Fake session-bound driver with call recording — the machine's only I/O seam. */
function fakeDriver({
  feedDump = FEED_DUMP,
  detailDump = { xml: NOTE_DETAIL_XML, focus: NOTE_FOCUS, pkg: "com.xingin.xhs" },
  ensureFeedOk = true,
  dumpOk = true,
  refreshOk = true,
  tapOk = true,
  backOk = true,
  swipeCommentsOk = true,
  releaseOk = true,
  cleanupActiveLeases = 0,
  cleanupRestored = true,
  binding = { alias: ROUTINE_ALIAS, sessionId: `sess-test-${ROUTINE_ALIAS}`, deviceId: `device-test-${ROUTINE_ALIAS}` },
} = {}) {
  const calls = {
    getExecutionBinding: 0,
    ensureFeed: 0,
    refresh: 0,
    dump: [],
    tap: [],
    back: 0,
    swipeComments: [],
    waitFor: [],
    release: 0,
    getCleanupStatus: 0,
  };
  return {
    calls,
    async getExecutionBinding() {
      calls.getExecutionBinding += 1;
      return binding;
    },
    async ensureFeed() {
      calls.ensureFeed += 1;
      return { ok: ensureFeedOk, activity: FEED_FOCUS };
    },
    async refresh() {
      calls.refresh += 1;
      return { ok: refreshOk, activity: FEED_FOCUS };
    },
    async dump({ label } = {}) {
      calls.dump.push(label || "");
      if (!dumpOk) return { xml: "", focus: FEED_FOCUS, pkg: "com.xingin.xhs" };
      const base = (label || "").startsWith("detail") ? detailDump : feedDump;
      return { ...base, hash: `dh_${label}` };
    },
    async tapAt(input) {
      const { x, y } = input;
      calls.tap.push({ ...input });
      return { ok: tapOk, activity: detailDump.focus };
    },
    async back() {
      calls.back += 1;
      return { ok: backOk, focusVerified: backOk };
    },
    async swipeComments({ screens }) {
      calls.swipeComments.push(screens);
      return { ok: swipeCommentsOk };
    },
    async waitFor(ms) {
      calls.waitFor.push(ms);
      return { ok: true };
    },
    async release() {
      calls.release += 1;
      return { ok: releaseOk, released: releaseOk };
    },
    async getCleanupStatus() {
      calls.getCleanupStatus += 1;
      return {
        activeLeases: cleanupActiveLeases,
        restored: cleanupRestored,
        authorityRef: "cp:test-cleanup",
        observedAtMs: 1,
      };
    },
  };
}

const CLOCK = { nowMs: () => 0, sleep: async () => {} };

test("happy path: feed-play completes all items with zero transport and clean cleanup", async () => {
  const plan = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 3, commentScreens: 1, seed: "s1" } });
  const driver = fakeDriver({});
  const receipt = await createRoutineRun({ plan, driver, clock: CLOCK }).execute();
  assert.equal(receipt.status, "SUCCEEDED");
  assert.equal(receipt.template, "xhs.feed-play.v1");
  assert.equal(receipt.items.length, 3);
  assert.ok(receipt.items.every((it) => it.opened === true && it.openAttempts === 1));
  assert.ok(receipt.items.every((it) => it.detailPage === PAGE_CLASS.IMAGE_NOTE));
  assert.equal(receipt.transport.count, 0);
  assert.equal(receipt.cleanup.activeLeases, 0);
  assert.equal(receipt.cleanup.restored, true);
  assert.equal(receipt.cleanup.verified, true);
  assert.equal(driver.calls.refresh, 3, "REFRESH_CAPTURE executes a real refresh per item");
  assert.equal(driver.calls.release, 1, "session is released exactly once in finally");
  assert.equal(driver.calls.getCleanupStatus, 1, "cleanup facts come from the authority");
  assert.ok(receipt.items.every((it) => it.commentScreens === 1 && it.commentsRead === 1));
});

test("invariant: each item opened at most once — no target fingerprint repeats", async () => {
  const plan = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 4, seed: "s2" } });
  const driver = fakeDriver({});
  const receipt = await createRoutineRun({ plan, driver }).execute();
  assert.equal(driver.calls.tap.length, 4);
  const fps = receipt.picks.map((p) => p.targetFingerprint);
  assert.equal(new Set(fps).size, fps.length, "no target opened twice");
});

// --- sealed prefer is a hard media constraint on card selection (plan V2 §5.2)

function mixedFeedXml() {
  return feedCardXml(NOTE_DESC, "[40,400][500,900]")
    + feedCardXml(VIDEO_DESCS[0], "[560,400][1020,900]");
}
const MIXED_FEED_DUMP = { xml: mixedFeedXml(), focus: FEED_FOCUS, pkg: "com.xingin.xhs" };

test("prefer=note only ever opens note cards — never substitutes a video card", async () => {
  const plan = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 1, prefer: "note", seed: "s1-note" } });
  const driver = fakeDriver({ feedDump: MIXED_FEED_DUMP });
  const receipt = await createRoutineRun({ plan, driver }).execute();
  assert.equal(receipt.status, "SUCCEEDED");
  assert.equal(driver.calls.tap.length, 1);
  assert.equal(receipt.picks[0].cardKind, "note");
  assert.equal(receipt.picks[0].prefer, "note");
  assert.equal(receipt.items[0].cardKind, "note");
});

test("prefer=video with no video card -> bounded NO_MATCHING_CARD skip, tap=0", async () => {
  const plan = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 1, prefer: "video", seed: "s1-novideo" } });
  const driver = fakeDriver({});
  const receipt = await createRoutineRun({ plan, driver }).execute();
  assert.equal(receipt.status, "SUCCEEDED", "a single unmatched item is a bounded skip");
  assert.equal(driver.calls.tap.length, 0, "never opens another media kind");
  assert.equal(receipt.items[0].stopReason, "NO_MATCHING_CARD");
  assert.equal(receipt.items[0].opened, false, "never opens another media kind");
});

test("prefer with persistent mismatch exhausts boundedly -> FAILED NO_MATCHING_CARD_EXHAUSTED", async () => {
  const plan = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 4, prefer: "video", seed: "s1-still" } });
  const driver = fakeDriver({});
  const receipt = await createRoutineRun({ plan, driver }).execute();
  assert.equal(receipt.status, "FAILED");
  assert.equal(receipt.stopReason, "NO_MATCHING_CARD_EXHAUSTED");
  assert.equal(driver.calls.tap.length, 0, "exhaustion never substitutes media");
});

test("invariant: video note never swipes for comments (swipe = 0 on video surfaces)", async () => {
  const plan = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 2, commentScreens: 3, seed: "s3" } });
  const driver = fakeDriver({ detailDump: { xml: VIDEO_XML, focus: VIDEO_FOCUS, pkg: "com.xingin.xhs" } });
  const receipt = await createRoutineRun({ plan, driver }).execute();
  assert.equal(receipt.status, "SUCCEEDED");
  for (const it of receipt.items) {
    assert.equal(it.detailPage, PAGE_CLASS.VIDEO_NOTE);
    assert.equal(it.commentScreens, 0, "video main surface comment swipe = 0");
    assert.equal(it.commentsRead, 0);
    assert.equal(it.commentStop, "COMMENT_PANEL_ASSERTION_PENDING_S1");
  }
  assert.equal(driver.calls.swipeComments.length, 0, "no swipeComments call on video surfaces");
});

test("invariant: dwell bounded by plan range", async () => {
  const plan = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 3, dwell: "2:3", seed: "s4" } });
  const driver = fakeDriver({});
  await createRoutineRun({ plan, driver }).execute();
  for (const ms of driver.calls.waitFor) {
    assert.ok(ms >= 2000 && ms <= 3000, `dwell ${ms}ms outside 2:3s`);
  }
});

test("unknown feed without a vision navigator -> immediate FAILED closeout with tap=0", async () => {
  const plan = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 5, seed: "s5" } });
  const driver = fakeDriver({ feedDump: { xml: EMPTY_INDEX_XML, focus: FEED_FOCUS, pkg: "com.xingin.xhs" } });
  const receipt = await createRoutineRun({ plan, driver }).execute();
  assert.equal(receipt.status, "FAILED");
  assert.equal(receipt.stopReason, "FEED_NOT_RECOGNIZED:HOME_FEED_EMPTY");
  assert.equal(driver.calls.tap.length, 0);
});

test("ensure-feed failure -> BLOCKED closeout, no item loop", async () => {
  const plan = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 3, seed: "s6" } });
  const driver = fakeDriver({ ensureFeedOk: false });
  const receipt = await createRoutineRun({ plan, driver }).execute();
  assert.equal(receipt.status, "BLOCKED");
  assert.equal(receipt.stopReason, "ENSURE_FEED_FAILED");
  assert.equal(receipt.items.length, 1);
  assert.equal(driver.calls.tap.length, 0);
});

test("back not semantically confirmed -> BLOCKED (restoration failure)", async () => {
  const plan = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 2, seed: "s7" } });
  const driver = fakeDriver({ backOk: false });
  const receipt = await createRoutineRun({ plan, driver }).execute();
  assert.equal(receipt.status, "BLOCKED");
  assert.equal(receipt.stopReason, "BACK_FEED_NOT_CONFIRMED");
});

test("open failure bounded: skip + restore feed; exhaustion -> FAILED", async () => {
  const plan = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 4, seed: "s8" } });
  const driver = fakeDriver({ tapOk: false });
  const receipt = await createRoutineRun({ plan, driver }).execute();
  assert.equal(receipt.status, "FAILED");
  assert.equal(receipt.stopReason, "OPEN_EXHAUSTED");
  assert.ok(receipt.items.every((it) => it.opened === false));
});

test("forbidden surface (captcha) -> back out, BLOCKED, transport increment = 0", async () => {
  const plan = planRoutine({ templateId: "xhs.nurture-lite.v1", params: { items: 3, likeMax: 1, seed: "s9" } });
  const driver = fakeDriver({ detailDump: { xml: '<node text="安全验证" bounds="[0,0][1080,2400]"/>', focus: NOTE_FOCUS, pkg: "com.xingin.xhs" } });
  const receipt = await createRoutineRun({ plan, driver }).execute();
  assert.equal(receipt.status, "BLOCKED");
  assert.equal(receipt.stopReason, "FORBIDDEN_SURFACE");
  assert.equal(receipt.transport.count, 0, "risk page: social transport increment = 0");
});

test("S1 effect boundary: social template without bridge -> deferred, transport 0", async () => {
  const plan = planRoutine({ templateId: "xhs.nurture-grounded.v1", params: { items: 2, likeMax: 1, commentMax: 2, seed: "s10" } });
  const driver = fakeDriver({});
  const receipt = await createRoutineRun({ plan, driver }).execute();
  assert.equal(receipt.status, "SUCCEEDED");
  assert.equal(receipt.transport.count, 0);
  for (const it of receipt.items) {
    assert.match(it.effects.like, /deferred:effect_bridge_not_wired/);
    assert.match(it.effects.comment, /deferred:effect_bridge_not_wired/);
  }
});

test("none template never routes effects even with a bridge present", async () => {
  const plan = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 1, seed: "s11" } });
  let bridgeCalls = 0;
  const effects = { commitRoutineEffect: async () => { bridgeCalls += 1; return { outcome: "verified", transported: true }; } };
  await createRoutineRun({ plan, driver: fakeDriver({}), effects }).execute();
  assert.equal(bridgeCalls, 0, "effectClass none must not call the effect bridge");
});

test("S2 seam: bridge intents capped by plan likeMax (cap, not quota)", async () => {
  const plan = planRoutine({ templateId: "xhs.nurture-lite.v1", params: { items: 3, likeMax: 1, seed: "s12" } });
  const intents = [];
  const effects = {
    commitRoutineEffect: async ({ intent }) => {
      intents.push(intent);
      return { outcome: "verified", transported: true };
    },
  };
  const receipt = await createRoutineRun({ plan, driver: fakeDriver({}), effects }).execute();
  assert.equal(intents.length, 1, "likeMax=1: exactly one bridge intent for the whole run");
  assert.equal(intents[0].action, "like");
  assert.equal(receipt.transport.count, 1);
  assert.match(receipt.items[1].effects.like, /cap_reached/);
});

test("ambiguous like consumes the slot and closes remaining like attempts", async () => {
  const plan = planRoutine({ templateId: "xhs.nurture-lite.v1", params: { items: 3, likeMax: 1, seed: "s13" } });
  const effects = { commitRoutineEffect: async () => ({ outcome: "ambiguous", transported: true }) };
  const receipt = await createRoutineRun({ plan, driver: fakeDriver({}), effects }).execute();
  assert.equal(receipt.transport.count, 1);
  for (let i = 1; i < receipt.items.length; i += 1) {
    assert.match(receipt.items[i].effects.like, /cap_reached/);
  }
});

test("seeded replay: same seed + same observations -> identical picks and dwell", async () => {
  const mk = () => createRoutineRun({
    plan: planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 3, seed: "replay" } }),
    driver: fakeDriver({}),
  });
  const a = await mk().execute();
  const b = await mk().execute();
  assert.deepEqual(a.picks, b.picks);
  assert.deepEqual(
    a.items.map((i) => [i.dwellMs, i.targetFingerprint]),
    b.items.map((i) => [i.dwellMs, i.targetFingerprint]),
  );
});

test("different seeds diverge on multi-card feeds (sampling recorded in receipt)", async () => {
  const mk = (seed) => createRoutineRun({
    plan: planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 3, seed } }),
    driver: fakeDriver({ feedDump: { xml: feedXml(5), focus: FEED_FOCUS, pkg: "com.xingin.xhs" } }),
  });
  const a = await mk("seedA").execute();
  const b = await mk("seedB").execute();
  assert.notDeepEqual(a.picks.map((p) => p.targetFingerprint), b.picks.map((p) => p.targetFingerprint));
});

test("unavailable detail dump without vision -> restore once then FAILED", async () => {
  const plan = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 4, seed: "s14" } });
  const driver = fakeDriver({ detailDump: { xml: "", focus: "com.xingin.xhs/com.xingin.xhs.some.WeirdActivity", pkg: "com.xingin.xhs" } });
  const receipt = await createRoutineRun({ plan, driver }).execute();
  assert.equal(receipt.status, "FAILED");
  assert.equal(receipt.stopReason, "DETAIL_DUMP_UNAVAILABLE");
  assert.equal(driver.calls.back, 1);
});

test("dump unavailable -> FAILED closeout", async () => {
  const plan = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 2, seed: "s15" } });
  const driver = { ...fakeDriver({}), async dump() { return { xml: "", focus: FEED_FOCUS, pkg: "com.xingin.xhs" }; } };
  const receipt = await createRoutineRun({ plan, driver }).execute();
  assert.equal(receipt.status, "FAILED");
  assert.equal(receipt.stopReason, "DUMP_UNAVAILABLE");
});

test("REFRESH_CAPTURE is mandatory: missing or failed refresh closes before dump/tap", async () => {
  for (const mode of ["missing", "failed"]) {
    const plan = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 1, seed: `refresh-${mode}` } });
    const driver = fakeDriver({ refreshOk: mode !== "failed" });
    if (mode === "missing") delete driver.refresh;
    const receipt = await createRoutineRun({ plan, driver }).execute();
    assert.equal(receipt.status, "BLOCKED", mode);
    assert.equal(receipt.stopReason, mode === "missing" ? "REFRESH_INTERFACE_UNAVAILABLE" : "REFRESH_FAILED");
    assert.equal(driver.calls.dump.length, 0, mode);
    assert.equal(driver.calls.tap.length, 0, mode);
    assert.equal(driver.calls.release, 1, `${mode}: finally releases`);
    assert.equal(receipt.cleanup.verified, true, `${mode}: cleanup is independently verified`);
  }
});

test("execution binding is mandatory and exact before any device primitive", async () => {
  const plan = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 1, seed: "binding" } });
  const driver = fakeDriver({ binding: { alias: "wrong", sessionId: "s", deviceId: "d" } });
  const receipt = await createRoutineRun({ plan, driver }).execute();
  assert.equal(receipt.status, "BLOCKED");
  assert.equal(receipt.stopReason, "DRIVER_BINDING_MISMATCH");
  assert.equal(driver.calls.ensureFeed, 0);
  assert.equal(driver.calls.tap.length, 0);
  assert.equal(driver.calls.release, 1);
});

test("cleanup facts are authoritative: active lease or unrestored device cannot succeed", async () => {
  for (const scenario of [
    { activeLeases: 1, restored: true, reason: "ACTIVE_LEASES_REMAIN" },
    { activeLeases: 0, restored: false, reason: "DEVICE_NOT_RESTORED" },
  ]) {
    const plan = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 1, seed: scenario.reason } });
    const driver = fakeDriver({
      cleanupActiveLeases: scenario.activeLeases,
      cleanupRestored: scenario.restored,
    });
    const receipt = await createRoutineRun({ plan, driver }).execute();
    assert.equal(receipt.status, "BLOCKED");
    assert.equal(receipt.stopReason, scenario.reason);
    assert.equal(receipt.cleanup.activeLeases, scenario.activeLeases);
    assert.equal(receipt.cleanup.restored, scenario.restored);
    assert.equal(receipt.cleanup.verified, false);
  }
});

test("missing release or cleanup-inspection interface fails closed without fabricated facts", async () => {
  for (const missing of ["release", "getCleanupStatus"]) {
    const plan = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 1, seed: `missing-${missing}` } });
    const driver = fakeDriver({});
    delete driver[missing];
    const receipt = await createRoutineRun({ plan, driver }).execute();
    assert.equal(receipt.status, "BLOCKED", missing);
    assert.equal(receipt.stopReason, missing === "release"
      ? "RELEASE_INTERFACE_UNAVAILABLE"
      : "CLEANUP_INSPECTION_INTERFACE_UNAVAILABLE");
    assert.equal(receipt.cleanup.verified, false);
    if (missing === "getCleanupStatus") {
      assert.equal(receipt.cleanup.activeLeases, null);
      assert.equal(receipt.cleanup.restored, null);
    }
  }
});

test("driver exception still releases and inspects cleanup in finally", async () => {
  const plan = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 1, seed: "finally" } });
  const driver = fakeDriver({});
  driver.tapAt = async () => { throw Object.assign(new Error("boom"), { code: "TAP_BOOM" }); };
  const receipt = await createRoutineRun({ plan, driver }).execute();
  assert.equal(receipt.status, "FAILED");
  assert.equal(receipt.stopReason, "ROUTINE_EXECUTION_ERROR:TAP_BOOM");
  assert.equal(driver.calls.release, 1);
  assert.equal(driver.calls.getCleanupStatus, 1);
  assert.equal(receipt.cleanup.verified, true);
});

test("dump unavailable may open only through an exact bound one-shot R0 vision permit", async () => {
  const plan = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 1, seed: "vision-r0" } });
  const binding = { alias: plan.alias, sessionId: "sess-vision", deviceId: "device-vision" };
  const driver = fakeDriver({
    binding,
    feedDump: { xml: "", focus: FEED_FOCUS, pkg: "com.xingin.xhs" },
  });
  const visionNavigator = {
    async authorizeR0Navigation(request) {
      return {
        ok: true,
        permit: {
          permitId: "permit-1",
          executionRunId: request.executionRunId,
          planHash: request.planHash,
          alias: request.alias,
          sessionId: request.sessionId,
          deviceId: request.deviceId,
          page: request.page,
          frameId: "f".repeat(64),
          provider: { id: "real-provider", version: "1.0.0", modelSha256: "a".repeat(64) },
          actionClass: "R0_NAVIGATION",
          oneShot: true,
          blockId: "block-card-1",
          dims: { width: 1080, height: 2400 },
          expiresAtMs: 10,
        },
        target: {
          blockId: "block-card-1",
          label: "笔记 攀岩入门",
          x: 300,
          y: 600,
        },
      };
    },
  };
  const receipt = await createRoutineRun({ plan, driver, visionNavigator, clock: CLOCK }).execute();
  assert.equal(receipt.status, "SUCCEEDED");
  assert.equal(driver.calls.tap.length, 1);
  assert.equal(driver.calls.tap[0].source, "vision-r0");
  assert.equal(driver.calls.tap[0].visionPermit.permitId, "permit-1");
  assert.equal(receipt.vision[0].tapAuthorized, true);
  assert.equal(receipt.vision[0].provider.version, "1.0.0");
  assert.equal(receipt.vision[0].provider.modelSha256, "a".repeat(64));
  assert.equal(receipt.picks[0].selectionMode, "vision_unique_r0");
});

test("one-shot vision permit is consumed even when a navigator tries to replay it", async () => {
  const plan = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 2, seed: "vision-replay" } });
  const binding = { alias: plan.alias, sessionId: "sess-replay", deviceId: "device-replay" };
  const driver = fakeDriver({ binding, feedDump: { xml: "", focus: FEED_FOCUS, pkg: "com.xingin.xhs" } });
  const visionNavigator = {
    async authorizeR0Navigation(request) {
      return {
        ok: true,
        permit: {
          permitId: "permit-replayed",
          executionRunId: request.executionRunId,
          planHash: request.planHash,
          alias: request.alias,
          sessionId: request.sessionId,
          deviceId: request.deviceId,
          page: request.page,
          frameId: "c".repeat(64),
          provider: { id: "real-provider", version: "1.0.0", modelSha256: "b".repeat(64) },
          actionClass: "R0_NAVIGATION",
          oneShot: true,
          blockId: `block-${request.index}`,
          dims: { width: 1080, height: 2400 },
          expiresAtMs: 10,
        },
        target: { blockId: `block-${request.index}`, label: "笔记 普通内容", x: 300, y: 600 },
      };
    },
  };
  const receipt = await createRoutineRun({ plan, driver, visionNavigator, clock: CLOCK }).execute();
  assert.equal(receipt.status, "FAILED");
  assert.equal(receipt.stopReason, "VISION_PERMIT_UNSAFE");
  assert.equal(driver.calls.tap.length, 1, "the replayed permit produces no second tap");
});

test("vision permit with an effect control, wrong binding, or fixture provider is tap=0", async () => {
  for (const unsafe of ["effect", "binding", "fixture"]) {
    const plan = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 1, seed: `vision-${unsafe}` } });
    const binding = { alias: plan.alias, sessionId: "sess-safe", deviceId: "device-safe" };
    const driver = fakeDriver({ binding, feedDump: { xml: "", focus: FEED_FOCUS, pkg: "com.xingin.xhs" } });
    const visionNavigator = {
      async resolveNavigationTarget(request) {
        return {
          ok: true,
          permit: {
            actionRef: "action-unsafe",
            executionRunId: request.executionRunId,
            planHash: unsafe === "binding" ? "0".repeat(64) : request.planHash,
            alias: request.alias,
            sessionRef: request.sessionId,
            deviceRef: request.deviceId,
            page: request.page,
            frameId: "e".repeat(64),
            provider: unsafe === "fixture" ? "fixture" : "real-provider",
            actionClass: "R0_NAVIGATION",
            oneShot: true,
            blockId: "block-unsafe",
          },
          target: {
            blockId: "block-unsafe",
            label: unsafe === "effect" ? "点赞 12" : "笔记 普通内容",
            x: 300,
            y: 600,
          },
        };
      },
    };
    const receipt = await createRoutineRun({ plan, driver, visionNavigator, clock: CLOCK }).execute();
    assert.equal(receipt.status, "FAILED", unsafe);
    assert.equal(driver.calls.tap.length, 0, unsafe);
    assert.match(receipt.stopReason, /^VISION_PERMIT_/, unsafe);
  }
});

test("ambiguous detail dump may be classified by bound vision observation but cannot authorize a tap", async () => {
  const plan = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 1, commentScreens: 0, seed: "vision-detail" } });
  const binding = { alias: plan.alias, sessionId: "sess-detail", deviceId: "device-detail" };
  const driver = fakeDriver({
    binding,
    detailDump: { xml: "", focus: "com.xingin.xhs/com.xingin.xhs.unknown", pkg: "com.xingin.xhs" },
  });
  const visionNavigator = {
    async observePage(request) {
      return {
        ok: true,
        observation: {
          executionRunId: request.executionRunId,
          planHash: request.planHash,
          alias: request.alias,
          sessionId: request.sessionId,
          deviceId: request.deviceId,
          page: PAGE_CLASS.IMAGE_NOTE,
          frameId: "d".repeat(64),
          provider: { id: "real-provider", version: "1.0.0", modelSha256: "a".repeat(64) },
        },
      };
    },
  };
  const receipt = await createRoutineRun({ plan, driver, visionNavigator }).execute();
  assert.equal(receipt.status, "SUCCEEDED");
  assert.equal(receipt.items[0].detailPage, PAGE_CLASS.IMAGE_NOTE);
  assert.equal(receipt.vision.length, 1);
  assert.equal(receipt.vision[0].tapAuthorized, false);
  assert.equal(driver.calls.tap.length, 1, "only the dump-bound feed card is tapped");
});

test("machine rejects a non-sealed plan object", () => {
  assert.throws(() => createRoutineRun({ plan: { ok: true }, driver: fakeDriver({}) }), TypeError);
  assert.throws(() => createRoutineRun({ plan: planRoutine({ templateId: "xhs.feed-play.v1" }), driver: null }), TypeError);
});
