/**
 * xhs-routine-fake-driver.mjs — scripted session-bound driver fixture for the
 * xw-xhs-routine CLI integration tests (offline only, zero device I/O).
 * Exports the same shape a real CP live transport would, including explicit
 * execution ownership and authoritative post-release cleanup inspection.
 */
const FEED_FOCUS = "com.xingin.xhs/com.xingin.xhs.index.v2.IndexActivityV2";
const NOTE_FOCUS = "com.xingin.xhs/com.xingin.xhs.note.NoteDetailActivity";

const NOTE_DESC = "笔记 攀岩入门三条路线 来自小岩 123赞";
const FEED_XML = '<node class="android.widget.ImageView" content-desc="' + NOTE_DESC + '" text="" clickable="true" bounds="[40,400][500,900]"/>'
  + '<node class="android.widget.ImageView" content-desc="' + NOTE_DESC + '" text="" clickable="true" bounds="[560,400][1020,900]"/>';

const DETAIL_XML = '<node class="android.widget.TextView" content-desc="点赞" text="" bounds="[40,2200][140,2300]"/>'
  + '<node class="android.widget.TextView" content-desc="评论 3" text="" bounds="[240,2200][340,2300]"/>'
  + '<node class="android.widget.TextView" text="小岩" bounds="[40,600][120,660]"/>'
  + '<node class="android.widget.TextView" text="这条路线讲解得非常清楚，收藏了" bounds="[40,680][900,740]"/>';

let taps = 0;
let released = false;
let executionBinding = null;

export default {
  async getExecutionBinding({ alias } = {}) {
    released = false;
    executionBinding = {
      alias: String(alias),
      sessionId: `fixture-session-${alias}`,
      deviceId: `fixture-device-${alias}`,
    };
    return executionBinding;
  },
  async ensureFeed() {
    return { ok: true, activity: FEED_FOCUS };
  },
  async refresh() {
    return { ok: true, activity: FEED_FOCUS };
  },
  async dump({ label } = {}) {
    if (String(label || "").startsWith("detail")) {
      return { xml: DETAIL_XML, focus: NOTE_FOCUS, pkg: "com.xingin.xhs", hash: `dh_detail_${label}` };
    }
    return { xml: FEED_XML, focus: FEED_FOCUS, pkg: "com.xingin.xhs", hash: `dh_feed_${label}` };
  },
  async tapAt({ x, y }) {
    taps += 1;
    return { ok: true, activity: NOTE_FOCUS, x, y };
  },
  async back() {
    return { ok: true, focusVerified: true };
  },
  async swipeComments({ screens }) {
    return { ok: true, screens };
  },
  async waitFor() {
    return { ok: true };
  },
  async release() {
    released = true;
    return { ok: true, released: true };
  },
  async getCleanupStatus() {
    return {
      activeLeases: released ? 0 : 1,
      restored: released,
      authorityRef: executionBinding?.sessionId ? "fixture:cleanup" : null,
      observedAtMs: 1,
    };
  },
};
