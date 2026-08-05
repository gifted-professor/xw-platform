/**
 * stall-progress.mjs — mid-run progress + stall detection (v2)
 *
 * Contract (G1):
 * - Persist step heartbeats under evidenceDir/progress.jsonl (survives ADAPTER_TIMEOUT).
 * - ui_stall: ≥2 fresh identical UI fingerprints spanning ≥ stallMs.
 * - progress_silence: step alive past stallMs with no fresh UI/business snapshot
 *   (never reuse a stale fingerprint to claim ui_stall).
 * - Heartbeat timer proves process liveness during long awaits.
 * - LLM escalation only on ui_stall / progress_silence / terminal failure — not on slow success.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_STALL_MS = Number(process.env.XIANYU_STALL_MS || 45000);
export const DEFAULT_HEARTBEAT_MS = Number(process.env.XIANYU_HEARTBEAT_MS || 5000);
export const PROGRESS_SCHEMA = "xhs.stall-progress.v2";

export function canonicalizeLabels(nodes = []) {
  return (Array.isArray(nodes) ? nodes : [])
    .map((n) => String(n?.label || "").trim())
    .filter(Boolean)
    .slice(0, 40)
    .sort();
}

/** Stable UI fingerprint from a semantic snapshot (dump labels + focus). */
export function uiFingerprint(snap) {
  if (!snap || typeof snap !== "object") return null;
  const focus = snap.focus || {};
  const payload = {
    package: focus.package || null,
    activity: focus.activity || null,
    labels: canonicalizeLabels(snap.nodes || []),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function emptyUiState() {
  return {
    fingerprint: null,
    screenSha256: null,
    firstFreshAt: null,
    lastFreshAt: null,
    freshCount: 0,
    uiStalled: false,
    uiStalledAt: null,
    silenceDeclared: false,
    silenceDeclaredAt: null,
  };
}

/**
 * Pure UI stall state machine — only call with a *fresh* fingerprint from a new snapshot.
 * @returns {{ state, event? }}
 */
export function observeStall(state, {
  fingerprint,
  screenSha256 = null,
  now = Date.now(),
  stallMs = DEFAULT_STALL_MS,
  step = null,
  fresh = true,
} = {}) {
  const prev = state && typeof state === "object" ? { ...emptyUiState(), ...state } : emptyUiState();

  if (!fingerprint || fresh !== true) {
    return { state: prev, event: null };
  }

  const same = prev.fingerprint === fingerprint
    && (!screenSha256 || !prev.screenSha256 || prev.screenSha256 === screenSha256);

  if (!prev.fingerprint || !same) {
    const next = {
      ...prev,
      fingerprint,
      screenSha256: screenSha256 || null,
      firstFreshAt: now,
      lastFreshAt: now,
      freshCount: 1,
      uiStalled: false,
      uiStalledAt: null,
    };
    const event = prev.uiStalled
      ? {
        kind: "stall_cleared",
        signalType: "slow_progress",
        dumpFingerprint: fingerprint,
        screenSha256: next.screenSha256,
        unchangedMs: prev.uiStalledAt != null && prev.firstFreshAt != null
          ? Math.max(0, prev.uiStalledAt - prev.firstFreshAt)
          : null,
        step,
        llmEscalationRecommended: false,
        diagnosisHint: "ui_changed",
      }
      : null;
    return { state: next, event };
  }

  const firstFreshAt = prev.firstFreshAt ?? now;
  const freshCount = (prev.freshCount || 1) + 1;
  const unchangedMs = Math.max(0, now - firstFreshAt);
  const next = {
    ...prev,
    fingerprint,
    screenSha256: screenSha256 || prev.screenSha256,
    firstFreshAt,
    lastFreshAt: now,
    freshCount,
  };

  if (!prev.uiStalled && freshCount >= 2 && unchangedMs >= stallMs) {
    next.uiStalled = true;
    next.uiStalledAt = now;
    return {
      state: next,
      event: {
        kind: "stall",
        signalType: "ui_stall",
        dumpFingerprint: fingerprint,
        screenSha256: next.screenSha256,
        unchangedMs,
        stallMs,
        freshCount,
        step,
        llmEscalationRecommended: true,
        diagnosisHint: "ui_stall",
      },
    };
  }

  return { state: next, event: null };
}

/**
 * Progress silence: alive past stallMs with no fresh UI observation.
 * Does not mutate UI stall fingerprint state.
 */
export function observeProgressSilence(state, {
  now = Date.now(),
  stallMs = DEFAULT_STALL_MS,
  step = null,
} = {}) {
  const prev = state && typeof state === "object" ? { ...emptyUiState(), ...state } : emptyUiState();
  const anchor = prev.lastFreshAt ?? prev.firstFreshAt;
  if (anchor == null) {
    // No UI yet — silence relative to tracker start is handled by caller via lastActivityAt.
    return { state: prev, event: null, silenceMs: null };
  }
  const silenceMs = Math.max(0, now - anchor);
  if (!prev.silenceDeclared && silenceMs >= stallMs) {
    const next = { ...prev, silenceDeclared: true, silenceDeclaredAt: now };
    return {
      state: next,
      silenceMs,
      event: {
        kind: "progress_silence",
        signalType: "progress_silence",
        dumpFingerprint: prev.fingerprint,
        screenSha256: prev.screenSha256,
        silenceMs,
        stallMs,
        step,
        llmEscalationRecommended: true,
        diagnosisHint: "progress_silence",
      },
    };
  }
  return { state: prev, event: null, silenceMs };
}

export function progressPathFor(evidenceDir) {
  if (!evidenceDir || typeof evidenceDir !== "string") return null;
  return join(evidenceDir, "progress.jsonl");
}

export function appendProgressLine(evidenceDir, record) {
  const path = progressPathFor(evidenceDir);
  if (!path) return null;
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  return path;
}

/**
 * Bind progress file + stall tracker for a run.
 */
export function createProgressTracker({
  evidenceDir = null,
  stallMs = DEFAULT_STALL_MS,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  now = () => Date.now(),
  runId = null,
  jobId = null,
} = {}) {
  let uiState = emptyUiState();
  let seq = 0;
  let startedAt = now();
  let lastActivityAt = startedAt;
  let heartbeatTimer = null;
  let heartbeatStep = null;
  const stallEvents = [];
  const path = progressPathFor(evidenceDir);

  function writeRecord(partial) {
    seq += 1;
    lastActivityAt = now();
    const record = {
      schemaId: PROGRESS_SCHEMA,
      seq,
      t: new Date(now()).toISOString(),
      runId,
      jobId,
      ...partial,
    };
    appendProgressLine(evidenceDir, record);
    return record;
  }

  function note({
    phase,
    name = null,
    step = null,
    snap = null,
    screenSha256 = null,
    ok = null,
    extra = null,
    freshObservation = null,
  } = {}) {
    const hasFreshSnap = Boolean(snap) || freshObservation === true;
    const fingerprint = snap ? uiFingerprint(snap) : null;
    let event = null;

    if (hasFreshSnap && fingerprint) {
      const observed = observeStall(uiState, {
        fingerprint,
        screenSha256: screenSha256 || snap?.screenshot?.sha256 || null,
        now: now(),
        stallMs,
        step: step || name,
        fresh: true,
      });
      uiState = observed.state;
      event = observed.event;
      // Fresh UI clears silence latch so a later freeze can re-fire.
      if (event?.kind === "stall_cleared" || !uiState.uiStalled) {
        uiState = { ...uiState, silenceDeclared: false, silenceDeclaredAt: null };
      }
    } else {
      // No fresh UI — may declare progress_silence; never advance ui_stall clock via stale fp.
      const silence = observeProgressSilence(uiState, {
        now: now(),
        stallMs,
        step: step || name,
      });
      uiState = silence.state;
      event = silence.event;
      if (!event && uiState.lastFreshAt == null) {
        const silenceMs = Math.max(0, now() - startedAt);
        if (!uiState.silenceDeclared && silenceMs >= stallMs) {
          uiState = { ...uiState, silenceDeclared: true, silenceDeclaredAt: now() };
          event = {
            kind: "progress_silence",
            signalType: "progress_silence",
            dumpFingerprint: null,
            screenSha256: null,
            silenceMs,
            stallMs,
            step: step || name,
            llmEscalationRecommended: true,
            diagnosisHint: "progress_silence",
          };
        }
      }
    }

    if (event) stallEvents.push(event);

    const silenceMs = uiState.lastFreshAt != null
      ? Math.max(0, now() - uiState.lastFreshAt)
      : Math.max(0, now() - startedAt);

    const escalate = Boolean(
      event?.llmEscalationRecommended
      || uiState.uiStalled
      || (event?.signalType === "progress_silence"),
    );

    return writeRecord({
      phase,
      name,
      step,
      ok,
      freshness: hasFreshSnap ? "fresh_ui" : "no_fresh_ui",
      dumpFingerprint: hasFreshSnap ? fingerprint : uiState.fingerprint,
      screenSha256: uiState.screenSha256,
      stalled: uiState.uiStalled,
      signalType: event?.signalType
        || (uiState.uiStalled ? "ui_stall" : null),
      unchangedMs: uiState.firstFreshAt != null && uiState.fingerprint
        ? Math.max(0, now() - uiState.firstFreshAt)
        : null,
      silenceMs,
      llmEscalationRecommended: escalate,
      diagnosisHint: event?.diagnosisHint
        || (uiState.uiStalled ? "ui_stall" : "progress"),
      ...(extra && typeof extra === "object" ? { extra } : {}),
      ...(event ? { stallEvent: event } : {}),
    });
  }

  function heartbeatTick() {
    note({
      phase: "heartbeat",
      name: heartbeatStep,
      step: heartbeatStep,
      freshObservation: false,
    });
  }

  function startHeartbeat({ name = null, intervalMs = heartbeatMs } = {}) {
    stopHeartbeat();
    heartbeatStep = name;
    const ms = Math.max(50, Number(intervalMs) || heartbeatMs);
    heartbeatTimer = setInterval(heartbeatTick, ms);
    // Keep the timer referenced while a step await is in flight so heartbeats
    // still fire under test runners / short-lived event loops.
    return true;
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    heartbeatStep = null;
  }

  return {
    path,
    stallMs,
    note,
    startHeartbeat,
    stopHeartbeat,
    getStallState: () => ({ ...uiState }),
    getStallEvents: () => stallEvents.slice(),
    getSeq: () => seq,
    summary() {
      const escalate = uiState.uiStalled
        || stallEvents.some((e) => e.signalType === "progress_silence" || e.signalType === "ui_stall");
      return {
        path,
        stallMs,
        seq,
        stalled: uiState.uiStalled,
        dumpFingerprint: uiState.fingerprint,
        screenSha256: uiState.screenSha256,
        unchangedMs: uiState.firstFreshAt != null
          ? Math.max(0, now() - uiState.firstFreshAt)
          : null,
        silenceMs: uiState.lastFreshAt != null
          ? Math.max(0, now() - uiState.lastFreshAt)
          : Math.max(0, now() - startedAt),
        llmEscalationRecommended: escalate && (uiState.uiStalled
          || stallEvents.some((e) => e.signalType === "progress_silence")),
        stallEvents: stallEvents.slice(),
        diagnosisHint: uiState.uiStalled
          ? "ui_stall"
          : (stallEvents.some((e) => e.signalType === "progress_silence")
            ? "progress_silence"
            : "ok"),
        lastActivityAt: new Date(lastActivityAt).toISOString(),
      };
    },
  };
}
