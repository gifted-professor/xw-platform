// M6-2 W4 — closed read-only Xiaowei observation. All device-text fields come
// from REAL raw fixtures (dumpsys window/power/input_method/display greps and
// a uiautomator hierarchy), consumed through the adapter's own parsers — no
// hand-filled observation object. Screenshots are real PNG bytes (signature +
// IHDR + IDAT + IEND), A/B bit-identical.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { createXiaoweiAdapter } from "../apps/xiaowei/adapter.mjs";
import {
  M6_OBSERVE_ORDER,
  M6_READ_COMMANDS,
  M6ObserveError,
  orientationFromRotation,
  parseDisplayMetrics,
  parseInputShown,
  parseRotation,
  parseWakefulness,
  pngDimensions,
  readObservation,
} from "../apps/xiaowei/read-observation.mjs";

const FIX = (name) => readFileSync(join(import.meta.dirname, "fixtures", "m6-xiaowei", name));
const SCREEN_A = FIX("screen-a.png");
const SCREEN_B = FIX("screen-b.png");
const DUMP_XML = FIX("dump-ui.raw.xml");
const WINDOW_FOCUS = FIX("window-focus.raw.txt");
const WINDOW_ROTATION = FIX("window-rotation.raw.txt");
const POWER = FIX("power.raw.txt");
const INPUT_METHOD = FIX("input-method.raw.txt");
const DISPLAY = FIX("display.raw.txt");

// --- Real PNG generator for mismatch fixtures (valid structure, odd dims) ----
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makePng(width, height, seed = 0) {
  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * rowBytes] = 0;
    for (let x = 0; x < width; x += 1) {
      raw[y * rowBytes + 1 + x * 3] = (x + seed) % 256;
      raw[y * rowBytes + 1 + x * 3 + 1] = (y + seed) % 256;
      raw[y * rowBytes + 1 + x * 3 + 2] = (x + y + seed) % 256;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const chunk = (type, data) => {
    const buf = Buffer.alloc(12 + data.length);
    buf.writeUInt32BE(data.length, 0);
    buf.write(type, 4, "latin1");
    data.copy(buf, 8);
    buf.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 8 + data.length);
    return buf;
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Injected clock: returns the next fixed timestamp per call.
function sequenceClock(timestamps) {
  let i = 0;
  return () => timestamps[Math.min(i++, timestamps.length - 1)];
}

const T0 = Date.parse("2026-08-21T12:00:00.000Z");

// A closed mock device transport. adb_shell dispatches ONLY against fixed
// allowlisted command text; any command that is neither an M6_READ_COMMANDS
// value nor a shared dump/cleanup sequence fails the test (closed surface).
function mockTransport(overrides = {}) {
  const events = [];
  let exclusiveCalls = 0;
  let screenCalls = 0;
  // windowRotation is the FIRST command of each display read (Promise.all order
  // is windowRotation, powerState, inputState, displayMetrics, and the mock
  // invoke bodies run synchronously in that order). Counting it marks each
  // display read, so an override can return DIFFERENT display state for read A
  // vs read B — the basis of the A/B display-independence test.
  let displayRead = 0;
  const transport = {
    events,
    exclusiveCalls: () => exclusiveCalls,
    async runExclusive(callback) {
      exclusiveCalls += 1;
      return callback(this);
    },
    async invoke({ action, devices, data }, options = {}) {
      events.push({ action, command: data?.command ?? null, options });
      if (action === "Screen") {
        screenCalls += 1;
        if (overrides.screenFailAt === screenCalls) {
          throw new Error("vendor screen failure");
        }
        const bytes = screenCalls === 1 ? overrides.pngA ?? SCREEN_A : overrides.pngB ?? SCREEN_B;
        mkdirSync(data.savePath, { recursive: true });
        writeFileSync(join(data.savePath, `frame-${screenCalls}.png`), bytes);
        return { code: 10000 };
      }
      if (action === "adb_shell") {
        const cmd = String(data.command);
        const fixed = new Set([
          ...Object.values(M6_READ_COMMANDS),
          /uiautomator dump/.test(cmd) ? cmd : null,
          /base64/.test(cmd) ? cmd : null,
          /rm -f/.test(cmd) ? cmd : null,
        ]);
        assert.ok(fixed.has(cmd), `adb_shell received non-allowlisted command: ${cmd}`);
        const fixture = (bytes) => ({ data: { [devices]: bytes } });
        if (/uiautomator dump/.test(cmd)) return fixture("");
        if (/base64/.test(cmd)) {
          const xml = overrides.dumpXml ?? DUMP_XML;
          if (xml === "") return fixture("");
          return fixture(Buffer.from(xml).toString("base64"));
        }
        if (/rm -f/.test(cmd)) return fixture("");
        if (cmd.includes("init=")) return fixture(overrides.displayText ?? DISPLAY); // displayMetrics also greps mCurrentRotation — match init= first
        if (cmd.includes("mCurrentFocus")) return fixture(overrides.windowFocus ?? WINDOW_FOCUS);
        if (cmd.includes("mCurrentRotation")) {
          // windowRotation fires once per display read (displayA then displayB).
          // Counting it lets an override return DIFFERENT rotation for the two
          // reads — the basis of the A/B display-independence test.
          displayRead += 1;
          const text = displayRead <= 1
            ? overrides.rotationTextA ?? overrides.rotationText ?? WINDOW_ROTATION
            : overrides.rotationTextB ?? overrides.rotationText ?? WINDOW_ROTATION;
          return fixture(text);
        }
        if (cmd.includes("mWakefulness=")) {
          const text = displayRead <= 1
            ? overrides.powerTextA ?? overrides.powerText ?? POWER
            : overrides.powerTextB ?? overrides.powerText ?? POWER;
          return fixture(text);
        }
        if (cmd.includes("mInputShown")) {
          const text = displayRead <= 1
            ? overrides.inputTextA ?? overrides.inputText ?? INPUT_METHOD
            : overrides.inputTextB ?? overrides.inputText ?? INPUT_METHOD;
          return fixture(text);
        }
        throw new Error(`unmatched adb_shell command: ${cmd}`);
      }
      throw new Error(`unexpected transport action: ${action}`);
    },
  };
  return transport;
}

function observe(transport, overrides = {}) {
  return readObservation({
    transport,
    serial: overrides.serial ?? "serial-1",
    now: overrides.now ?? (() => T0 + 1000),
    timeoutMs: overrides.timeoutMs,
  });
}

// ---------------------------------------------------------------------------
test("field parsers read the raw fixtures (source of truth is device text)", () => {
  assert.equal(parseWakefulness("  mWakefulness=Awake\n"), true);
  assert.equal(parseWakefulness("  mWakefulness=Asleep\n"), false);
  assert.equal(parseWakefulness("no power line"), null);
  assert.equal(parseInputShown("  mInputShown=false\n"), false);
  assert.equal(parseInputShown("  mInputShown=true\n"), true);
  assert.equal(parseInputShown(""), null);
  assert.equal(parseRotation("  mCurrentRotation=1 (ROTATION_90)\n"), 1);
  assert.equal(parseRotation("garbage"), null);
  const metrics = parseDisplayMetrics(DISPLAY.toString("utf8"));
  assert.deepEqual(metrics, { width: 1080, height: 2400, density: 440, rotation: 0, orientation: "portrait" });
  assert.equal(pngDimensions(SCREEN_A).width, 1080);
  assert.equal(pngDimensions(SCREEN_A).height, 2400);
});

test("readObservation follows the frozen A→focusA→dump→B→focusB order in ONE critical section", async () => {
  const transport = mockTransport();
  const result = await observe(transport, {
    now: sequenceClock([T0, T0 + 350, T0 + 500]),
  });
  assert.equal(result.ok, true);
  assert.equal(transport.exclusiveCalls(), 1);
  assert.deepEqual(result.order, M6_OBSERVE_ORDER);

  // Frozen sequence with TWO independent display observations (one at focus-A
  // time, one at focus-B time), so each focus carries its own A/B-moment display
  // state and the stability gate is real:
  //   screenA → focusA(1) → displayA(4) → dump(3) → screenB → focusB(1) → displayB(4)
  const kinds = transport.events.map((e) => (e.action === "Screen" ? "Screen" : "shell"));
  assert.deepEqual(
    kinds,
    ["Screen", "shell", "shell", "shell", "shell", "shell", "shell", "shell", "shell", "Screen", "shell", "shell", "shell", "shell", "shell"],
  );
  const screenActions = transport.events.filter((e) => e.action === "Screen");
  assert.equal(screenActions.length, 2);
  const focusCmds = transport.events.filter((e) => e.command && /mCurrentFocus/.test(e.command));
  assert.equal(focusCmds.length, 2); // focus A and focus B
  const displayCmds = transport.events.filter(
    (e) => e.command && /mCurrentRotation|mWakefulness=|mInputShown|init=/.test(e.command),
  );
  assert.equal(displayCmds.length, 8); // displayA (rotation+power+input+metrics) + displayB (same 4)
});

test("field-source matrix: observation binds ONLY from raw fixture text", async () => {
  const result = await observe(mockTransport(), {
    now: sequenceClock([T0, T0 + 350, T0 + 500]),
  });
  assert.equal(result.capturedAt, "2026-08-21T12:00:00.500Z");
  assert.deepEqual(result.skew, { aToBMs: 350, bToFocusBMs: 150 });
  assert.deepEqual(result.observation, {
    width: 1080,
    height: 2400,
    density: 440,
    orientation: "portrait",
    screenOn: true,
    keyboardVisible: false,
    rotation: 0,
    package: "com.tencent.mm",
    activity: "com.tencent.mm.ui.LauncherUI",
  });
  // focus A/B carry the same closed display state + their own raw package/activity.
  assert.deepEqual(result.focusA.package, "com.tencent.mm");
  assert.deepEqual(result.focusA.activity, "com.tencent.mm.ui.LauncherUI");
  assert.equal(result.focusA.screenOn, true);
  assert.equal(result.focusB.package, "com.tencent.mm");
});

test("A/B display independence: focusA carries the A-time display state, focusB the B-time state, observation follows B", async () => {
  // Fix #6: the display state is sourced TWICE — once at focus-A time, once at
  // focus-B time — so focusA and focusB each carry their OWN moment's state.
  // The keyboard visibility changes between A (IME hidden) and B (IME shown).
  const result = await observe(
    mockTransport({ inputTextA: "mInputShown=false", inputTextB: "mInputShown=true" }),
    { now: sequenceClock([T0, T0 + 350, T0 + 500]) },
  );
  // focusA carries the A-time state (IME hidden)...
  assert.equal(result.focusA.keyboardVisible, false);
  // ...focusB carries the B-time state (IME shown) — NOT a shared B-time value
  // copied into focusA, and NOT the A-time value copied into focusB.
  assert.equal(result.focusB.keyboardVisible, true);
  // The frame's display observation is the FINAL (focus-B) state.
  assert.equal(result.observation.keyboardVisible, true);
  // package/activity remain the focused app recorded at focus A.
  assert.equal(result.observation.package, result.focusA.package);
  assert.equal(result.observation.activity, result.focusA.activity);
  // The two display reads are independent: focusA and focusB disagree on the
  // stable field. (A real frame assembler's focusStableFieldsHash gate would
  // reject this pair as M6_FRAME_FOCUS_PAIR_UNSTABLE; readObservation itself
  // just returns both so the assembler can make that call.)
  assert.notEqual(result.focusA.keyboardVisible, result.focusB.keyboardVisible);
});

test("evidence carries the real raw bytes: A/B bit-identical PNGs, hierarchy dump, focus text", async () => {
  const result = await observe(mockTransport());
  assert.ok(result.evidence.screenshotA.equals(SCREEN_A));
  assert.ok(result.evidence.screenshotB.equals(SCREEN_B));
  assert.ok(result.evidence.screenshotA.equals(result.evidence.screenshotB));
  assert.ok(result.evidence.dump.toString("utf8").includes("<hierarchy"));
  assert.match(result.evidence.focusA.toString("utf8"), /com\.tencent\.mm\/com\.tencent\.mm\.ui\.LauncherUI/);
  assert.match(result.evidence.focusB.toString("utf8"), /mCurrentFocus/);
});

test("skew gates fail closed before any frame is returned", async () => {
  await assert.rejects(
    observe(mockTransport(), { now: sequenceClock([T0, T0 + 4001, T0 + 4101]) }),
    (e) => e instanceof M6ObserveError && e.code === "M6_OBSERVE_A_TO_B_SKEW",
  );
  // B→focusB >= 1000ms fails (strict boundary is 1000ms exclusive).
  await assert.rejects(
    observe(mockTransport(), { now: sequenceClock([T0, T0 + 300, T0 + 1300]) }),
    (e) => e.code === "M6_OBSERVE_B_TO_FOCUS_B_SKEW",
  );
});

test("stage failures fail closed with M6_* codes and cancel the critical section", async () => {
  await assert.rejects(
    () => observe(mockTransport({ screenFailAt: 2 })),
    (e) => e.code === "M6_OBSERVE_SCREEN_B_FAILED",
  );
  await assert.rejects(
    () => observe(mockTransport({ windowFocus: "no window token here" })),
    (e) => e.code === "M6_OBSERVE_FOCUS_A_EMPTY",
  );
  await assert.rejects(
    () => observe(mockTransport({ dumpXml: "" })),
    (e) => e.code === "M6_OBSERVE_DUMP_FAILED",
  );
  await assert.rejects(
    () => observe(mockTransport({ rotationText: "no rotation line" })),
    (e) => e.code === "M6_OBSERVE_ROTATION_INVALID",
  );
  await assert.rejects(
    () => observe(mockTransport({ powerText: "no power line" })),
    (e) => e.code === "M6_OBSERVE_POWER_INVALID",
  );
  await assert.rejects(
    () => observe(mockTransport({ inputText: "" })),
    (e) => e.code === "M6_OBSERVE_INPUT_STATE_INVALID",
  );
  await assert.rejects(
    () => observe(mockTransport({ displayText: "cur=1080x2400 no init no dpi" })),
    (e) => e.code === "M6_OBSERVE_DISPLAY_DIMS_INVALID",
  );
});

test("PNG IHDR dims must agree with the display observation; mismatch fails closed", async () => {
  const odd = makePng(120, 160);
  await assert.rejects(
    () => observe(mockTransport({ pngA: odd })),
    (e) => e.code === "M6_OBSERVE_SCREEN_A_DIMS_MISMATCH",
  );
  await assert.rejects(
    () => observe(mockTransport({ pngB: odd })),
    (e) => e.code === "M6_OBSERVE_SCREEN_B_DIMS_MISMATCH",
  );
});

test("timeout/cancel: lock exhaustion and per-stage stall fail closed with no partial frame", async () => {
  // Exclusive-lock budget exhaustion propagates as a hard failure (no frame).
  const locked = mockTransport();
  locked.runExclusive = async () => {
    throw new M6ObserveError("M6_OBSERVE_LOCK_TIMEOUT", "exclusive lock not acquired in budget");
  };
  await assert.rejects(
    () => observe(locked),
    (e) => e.code === "M6_OBSERVE_LOCK_TIMEOUT",
  );

  // A per-stage vendor stall (invoke timeout) cancels the whole observation.
  const stalled = mockTransport();
  const original = stalled.invoke;
  stalled.invoke = async (input) => {
    if (input.action === "Screen") {
      throw new M6ObserveError("M6_OBSERVE_SCREEN_A_FAILED", "vendor Screen stalled", { stage: "screenshot-a" });
    }
    return original(input);
  };
  await assert.rejects(
    () => observe(stalled),
    (e) => e.code === "M6_OBSERVE_SCREEN_A_FAILED",
  );
});

test("concurrency: two concurrent observations each use exactly one critical section and both succeed", async () => {
  const transport = mockTransport();
  const [a, b] = await Promise.all([observe(transport), observe(transport)]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(transport.exclusiveCalls(), 2); // two observations → two lock acquisitions, never more
});

test("size: raw evidence bytes are preserved verbatim (caps are owned by freezer/store)", async () => {
  const bigDump = Buffer.from(`<hierarchy>${"<node text='x'/>".repeat(200000)}</hierarchy>`);
  const result = await observe(mockTransport({ dumpXml: bigDump.toString("utf8") }));
  assert.equal(result.evidence.dump.length, bigDump.length);
});

test("transport without runExclusive and missing serial fail closed structurally", async () => {
  await assert.rejects(
    () => readObservation({ transport: { invoke: async () => ({}) }, serial: "s" }),
    (e) => e.code === "M6_OBSERVE_TRANSPORT_INVALID",
  );
  await assert.rejects(
    () => readObservation({ transport: mockTransport(), serial: "" }),
    (e) => e.code === "M6_OBSERVE_SERIAL_REQUIRED",
  );
});

test("M6_READ_COMMANDS is a closed allowlist — no mutating shell text", () => {
  const values = Object.values(M6_READ_COMMANDS).join("\n");
  assert.ok(!/input (tap|swipe|keyevent|text)/.test(values));
  assert.ok(!/am (start|force-stop)/.test(values));
  assert.ok(!/monkey/.test(values));
  for (const [name, command] of Object.entries(M6_READ_COMMANDS)) {
    assert.ok(typeof command === "string" && command.length > 0, name);
  }
});

test("read-observation is statically closed: no mutating primitive reachable", () => {
  const source = readFileSync(new URL("../apps/xiaowei/read-observation.mjs", import.meta.url), "utf8");
  // Strip comments before scanning: the header explains WHAT is excluded, so
  // the scan must match code only, not prose.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  for (const token of ["tap", "swipe", "back", "launch_app", "input_text", "keyevent", "am start", "monkey"]) {
    assert.equal(code.includes(token), false, `read-observation code must not mention '${token}'`);
  }
  // The adapter's observe branch must be the ONLY new wiring; no generic routes.
  const adapterSource = readFileSync(new URL("../apps/xiaowei/adapter.mjs", import.meta.url), "utf8");
  assert.equal(adapterSource.includes("xiaowei.m6.observe_frame"), false); // capability is not hardcoded in adapter
});

test("adapter wiring: observe_frame executes the closed observation and verifies", async () => {
  const transport = mockTransport();
  const adapter = createXiaoweiAdapter({ transport });
  const execution = await adapter.execute({
    capability: { implementation: { action: "observe_frame" }, verification: { mode: "custom" } },
    device: { runtimeId: "serial-1" },
    params: {},
    job: { canary: true },
    evidenceDirectory: null,
    leaseAuthorization: { deviceId: "serial-1" },
  });
  assert.equal(execution.vendorCode, 10000);
  assert.equal(execution.output.ok, true);
  assert.ok(execution.output.capturedAt);
  const verification = await adapter.verify({
    capability: { implementation: { action: "observe_frame" }, verification: { mode: "custom" } },
    execution,
  });
  assert.deepEqual(verification, { ok: true, mode: "custom" });

  // Canary is enforced inside the adapter (defense in depth).
  await assert.rejects(
    () =>
      adapter.execute({
        capability: { implementation: { action: "observe_frame" } },
        device: { id: "serial-1" },
        params: {},
        job: { canary: false },
        evidenceDirectory: null,
        leaseAuthorization: {},
      }),
    (e) => e.code === "CANARY_REQUIRED",
  );
});
