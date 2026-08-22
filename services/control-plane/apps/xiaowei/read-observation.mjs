// M6-2 W4 — closed read-only Xiaowei frame observation. This is the ONLY M6-2
// surface that talks to the device, and it is strictly read-only:
//
//   * Fixed capture order: screenshot A → focus A → UI dump → screenshot B →
//     focus B, all inside ONE `runExclusive` critical section (same session,
//     same lease, FIFO device serialization, 30s hard budget).
//   * Every shell command comes from M6_READ_COMMANDS — a fixed allowlist of
//     read-only `dumpsys window/activity/display/power/input_method` greps.
//     A caller passes a command NAME, never shell text; an unknown name fails
//     closed. There is NO generic shell export and NO caller-provided shell.
//   * Mutating primitives (tap/swipe/back/launch_app/input_text) live only in
//     explorer-primitive.mjs and are NOT reachable from here — this module
//     exports no device-action function and accepts no coordinate/action/URL.
//   * Every stage fails closed: a stall/timeout/empty/corrupt read throws with
//     an M6_* code and the critical section is cancelled (temp save dirs swept).
//
// The produced observation is the field-source matrix for the strict frame:
//   width/height          PNG IHDR, cross-checked with display init=
//   orientation/density   display/window observation (fixed dumpsys reads)
//   screenOn              dumpsys power mWakefulness= (only "Awake" is on)
//   keyboardVisible       dumpsys input_method mInputShown
//   rotation              dumpsys window mCurrentRotation
//   package/activity      parsed from focus A/B raw (shared parseFocus)
//   capturedAt            real focus-B completion time (injected clock)
//   skew                  measured aToBMs / bToFocusBMs in the critical section
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { ControlPlaneError } from "../../control-plane/lib/errors.mjs";
import { parseFocus, readDumpXml, readScreenPng, readWindowFocusText } from "./explorer-primitive.mjs";

export const M6_READ_COMMANDS = Object.freeze({
  // Fixed, read-only commands only. No caller text ever reaches the shell.
  windowFocus:
    "dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp'; " +
    "dumpsys activity activities 2>/dev/null | grep -E 'mResumedActivity' | head -1",
  windowRotation: "dumpsys window 2>/dev/null | grep -E 'mCurrentRotation' | head -3",
  powerState: "dumpsys power 2>/dev/null | grep -E 'mWakefulness=' | head -3",
  inputState: "dumpsys input_method 2>/dev/null | grep -E 'mInputShown|mImeWindowVis' | head -3",
  displayMetrics: "dumpsys window displays 2>/dev/null | grep -E 'init=|mCurrentRotation|dpi' | head -5",
});

// The frozen observation sequence. Order is part of the M6-2 contract and is
// asserted by the strict frame assembler's A→B / B→focusB skew gates.
export const M6_OBSERVE_ORDER = Object.freeze([
  "screenshot-a",
  "focus-a",
  "dump",
  "screenshot-b",
  "focus-b",
]);

export class M6ObserveError extends ControlPlaneError {
  constructor(code, message, extra = {}) {
    super(code, message, { status: extra.status ?? 502, ...extra });
    this.name = "M6ObserveError";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Pure parsers over the raw device text (tested against real fixtures) ----

export function parseWakefulness(text) {
  const m = /mWakefulness=([A-Za-z]+)/.exec(String(text || ""));
  if (!m) return null;
  return m[1] === "Awake";
}

export function parseInputShown(text) {
  const m = /mInputShown=([A-Za-z]+)/.exec(String(text ?? ""));
  if (!m) return null;
  return m[1].toLowerCase() === "true";
}

export function parseRotation(text) {
  const s = String(text ?? "");
  // Physical Xiaowei devices emit the enum only: "mCurrentRotation=ROTATION_0".
  // Other builds emit a digit, sometimes followed by the enum in parens:
  // "mCurrentRotation=0 (ROTATION_90)". The enum is named after the Surface
  // degree constant (ROTATION_0/90/180/270) but holds a quarter-turn VALUE
  // (0..3), so map names explicitly. Unknown enums fall through to the digit
  // form; a bare digit remains accepted for the numeric dumpsys format.
  const ENUM_QUARTER = { ROTATION_0: 0, ROTATION_90: 1, ROTATION_180: 2, ROTATION_270: 3 };
  const enumMatch = /mCurrentRotation=(ROTATION_\d+)/.exec(s);
  if (enumMatch && enumMatch[1] in ENUM_QUARTER) return ENUM_QUARTER[enumMatch[1]];
  const digitMatch = /mCurrentRotation=(\d+)/.exec(s);
  if (!digitMatch) return null;
  const rotation = Number(digitMatch[1]);
  return rotation >= 0 && rotation <= 3 ? rotation : null;
}

export function orientationFromRotation(rotation) {
  // Android dumpsys reports Surface.ROTATION_* as quarter turns (0..3), not
  // degrees. Keep degree values for replay/backward compatibility, but the live
  // parser's 1/2/3 must map to 90/180/270 rather than fail as unknown.
  if (rotation === 1 || rotation === 3 || rotation === 90 || rotation === 270) return "landscape";
  if (rotation === 0 || rotation === 2 || rotation === 180) return "portrait";
  return null;
}

export function parseDisplayMetrics(text) {
  // dumpsys window displays:
  //   init=1080x2400 440dpi cur=1080x2400 app=1080x2400 ...
  //   mCurrentRotation=1 (ROTATION_90)
  // Real devices list EVERY display; the first init= can be a virtual display
  // with a placeholder density (e.g. 1dpi). Pick the highest-density init line
  // (the physical panel) rather than the first match.
  const s = String(text ?? "");
  let width = null;
  let height = null;
  let density = null;
  for (const init of s.matchAll(/init=(\d+)x(\d+)\s+(\d+)dpi/g)) {
    const d = Number(init[3]);
    if (density === null || d > density) {
      width = Number(init[1]);
      height = Number(init[2]);
      density = d;
    }
  }
  if (width === null || height === null) {
    const size = /init=(\d+)x(\d+)/.exec(s);
    if (size) {
      width = Number(size[1]);
      height = Number(size[2]);
    }
    const dpi = /(\d+)dpi/.exec(s);
    if (dpi) density = Number(dpi[1]);
  }
  const rotation = parseRotation(s);
  return { width, height, density, rotation, orientation: orientationFromRotation(rotation) };
}

// PNG signature + IHDR dimensions (pure, no decode).
export function pngDimensions(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 + 4 + 4 + 13) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i += 1) if (bytes[i] !== sig[i]) return null;
  const length = bytes.readUInt32BE(8);
  const type = bytes.toString("latin1", 12, 16);
  if (length !== 13 || type !== "IHDR") return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1) return null;
  return { width, height };
}

// Bounded shell executor: name → FIXED command only. Never accepts caller text.
async function runFixedRead(transport, serial, name, timeoutMs = 12000) {
  const command = M6_READ_COMMANDS[name];
  if (!command) {
    throw new M6ObserveError("M6_READ_COMMAND_NOT_ALLOWED", `read command '${name}' is not in the M6_READ_COMMANDS allowlist`);
  }
  const response = await transport.invoke(
    { action: "adb_shell", devices: serial, data: { command } },
    { timeoutMs },
  );
  const data = response?.data;
  if (data == null) return "";
  if (typeof data === "string") return data;
  if (typeof data === "object") {
    if (data[serial] != null) return String(data[serial]);
    const vals = Object.values(data);
    if (vals.length === 1) return String(vals[0] ?? "");
  }
  return String(data);
}

// Captures the display-state observation (rotation/power/input/display) with
// the fixed read-only registry, then cross-checks PNG IHDR dims against the
// display metrics. Any missing field fails closed — never a partial observation.
async function readDisplayState(transport, serial) {
  const [rotationText, powerText, inputText, metricsText] = await Promise.all([
    runFixedRead(transport, serial, "windowRotation"),
    runFixedRead(transport, serial, "powerState"),
    runFixedRead(transport, serial, "inputState"),
    runFixedRead(transport, serial, "displayMetrics"),
  ]);
  const rotation = parseRotation(rotationText);
  const screenOn = parseWakefulness(powerText);
  const keyboardVisible = parseInputShown(inputText);
  const metrics = parseDisplayMetrics(metricsText);
  const orientation = orientationFromRotation(rotation);

  if (rotation === null || orientation === null) {
    throw new M6ObserveError("M6_OBSERVE_ROTATION_INVALID", "window rotation observation is missing or invalid", { details: { rotationText: rotationText.slice(0, 120) } });
  }
  if (screenOn === null) {
    throw new M6ObserveError("M6_OBSERVE_POWER_INVALID", "power state observation is missing or invalid");
  }
  if (keyboardVisible === null) {
    throw new M6ObserveError("M6_OBSERVE_INPUT_STATE_INVALID", "input state observation is missing or invalid");
  }
  if (!Number.isInteger(metrics.width) || !Number.isInteger(metrics.height) || metrics.width < 1 || metrics.height < 1) {
    throw new M6ObserveError("M6_OBSERVE_DISPLAY_DIMS_INVALID", "display metrics observation is missing dimensions", { metrics });
  }
  if (!Number.isFinite(metrics.density) || metrics.density <= 0) {
    throw new M6ObserveError("M6_OBSERVE_DISPLAY_DENSITY_INVALID", "display metrics observation is missing density", { metrics });
  }
  return {
    width: metrics.width,
    height: metrics.height,
    orientation,
    density: metrics.density,
    screenOn,
    keyboardVisible,
    rotation,
  };
}

function failStage(stage, code, message, cause) {
  throw new M6ObserveError(code, `${stage}: ${message}`, { stage, cause: cause?.message ?? String(cause ?? "") });
}

// --- The one M6-2 observation path -------------------------------------------
// Runs the FULL fixed sequence inside a single runExclusive critical section:
// same session/lease, FIFO serialized, 30s hard budget. capturedAt is the
// focus-B completion time; skew is measured a→screenB and screenB→focusB.
export async function readObservation({
  transport,
  serial,
  now = Date.now,
  timeoutMs = 30000,
}) {
  if (!transport?.runExclusive) {
    throw new M6ObserveError("M6_OBSERVE_TRANSPORT_INVALID", "observation requires a transport with runExclusive");
  }
  if (!serial) {
    throw new M6ObserveError("M6_OBSERVE_SERIAL_REQUIRED", "device runtime serial is required");
  }
  const saveDirA = join(tmpdir(), `m6-sa-${randomUUID()}`);
  const saveDirB = join(tmpdir(), `m6-sb-${randomUUID()}`);
  mkdirSync(saveDirA, { recursive: true });
  mkdirSync(saveDirB, { recursive: true });

  try {
    return await transport.runExclusive(async (channel) => {
      const tA = now();
      const screenA = await readScreenPng({ transport: channel, serial, saveDir: saveDirA }).catch((error) =>
        failStage("screenshot-a", "M6_OBSERVE_SCREEN_A_FAILED", "screen A capture failed", error),
      );

      const focusAText = await readWindowFocusText({ transport: channel, serial }).catch((error) =>
        failStage("focus-a", "M6_OBSERVE_FOCUS_A_FAILED", "focus A read failed", error),
      );
      // The display state (rotation/power/input/metrics) is sourced at focus-A time
      // so focus A is a complete, independently-sourced observation — not the
      // focus-B-time state reused for both. The A/B stability gate compares the
      // two; a display change between A and B (rotation, screen-off) fails closed.
      const displayA = await readDisplayState(channel, serial);

      const dump = await readDumpXml({ transport: channel, serial }).catch((error) =>
        failStage("dump", "M6_OBSERVE_DUMP_FAILED", "UI dump failed", error),
      );

      const screenB = await readScreenPng({ transport: channel, serial, saveDir: saveDirB }).catch((error) =>
        failStage("screenshot-b", "M6_OBSERVE_SCREEN_B_FAILED", "screen B capture failed", error),
      );
      const tB = now();
      if (tB - tA > 4000) {
        throw new M6ObserveError("M6_OBSERVE_A_TO_B_SKEW", "A→B skew exceeded 4000ms", { stage: "screenshot-b", aToBMs: tB - tA });
      }

      // Source display B inside the measured B→focus-B window, then take focus B
      // last. capturedAt therefore covers every B-time safety field instead of
      // timestamping the frame before the display reads have completed.
      const displayB = await readDisplayState(channel, serial);
      const focusBText = await readWindowFocusText({ transport: channel, serial }).catch((error) =>
        failStage("focus-b", "M6_OBSERVE_FOCUS_B_FAILED", "focus B read failed", error),
      );
      const tFocusB = now();
      if (tFocusB - tB > 1000) {
        throw new M6ObserveError("M6_OBSERVE_B_TO_FOCUS_B_SKEW", "B→focus B skew exceeded 1000ms", { stage: "focus-b", bToFocusBMs: tFocusB - tB });
      }

      const focusA = parseFocus(focusAText);
      const focusB = parseFocus(focusBText);
      if (!focusA.package) {
        throw new M6ObserveError("M6_OBSERVE_FOCUS_A_EMPTY", "focus A produced no focused package/activity", { stage: "focus-a" });
      }
      if (!focusB.package) {
        throw new M6ObserveError("M6_OBSERVE_FOCUS_B_EMPTY", "focus B produced no focused package/activity", { stage: "focus-b" });
      }

      // Each screenshot's IHDR dims are cross-checked against its OWN display
      // observation (A against displayA, B against displayB), so a rotation
      // change between A and B is caught here rather than masked by a shared state.
      const dimsA = pngDimensions(screenA.bytes);
      const dimsB = pngDimensions(screenB.bytes);
      if (!dimsA || dimsA.width !== displayA.width || dimsA.height !== displayA.height) {
        throw new M6ObserveError("M6_OBSERVE_SCREEN_A_DIMS_MISMATCH", "screen A IHDR dims disagree with the focus-A display observation", { stage: "screenshot-a" });
      }
      if (!dimsB || dimsB.width !== displayB.width || dimsB.height !== displayB.height) {
        throw new M6ObserveError("M6_OBSERVE_SCREEN_B_DIMS_MISMATCH", "screen B IHDR dims disagree with the focus-B display observation", { stage: "screenshot-b" });
      }

      return {
        ok: true,
        order: M6_OBSERVE_ORDER,
        capturedAt: new Date(tFocusB).toISOString(),
        skew: { aToBMs: tB - tA, bToFocusBMs: tFocusB - tB },
        // The frame's display observation is the final (focus-B) state; the
        // package/activity remain the focused app recorded at focus A.
        observation: {
          ...displayB,
          package: focusA.package,
          activity: focusA.activity,
        },
        focusA: { ...focusA, ...displayA },
        focusB: { ...focusB, ...displayB },
        evidence: {
          screenshotA: screenA.bytes,
          screenshotB: screenB.bytes,
          dump: Buffer.from(dump.xml, "utf8"),
          focusA: Buffer.from(focusAText, "utf8"),
          focusB: Buffer.from(focusBText, "utf8"),
        },
        vendorCode: screenB.vendorCode ?? null,
      };
    }, { lockTimeoutMs: timeoutMs });
  } finally {
    rmSync(saveDirA, { recursive: true, force: true });
    rmSync(saveDirB, { recursive: true, force: true });
  }
}
