/**
 * stall-progress.mjs — mid-run progress + UI-stall detection
 *
 * Contract (north-star):
 * - Persist step heartbeats under evidenceDir/progress.jsonl (survives ADAPTER_TIMEOUT).
 * - Trigger LLM escalation when dump/UI fingerprint is unchanged for stallMs
 *   (default 45s) — distinguish "slow" vs "stuck", not wall-clock timeout alone.
 * - LLM involvement = script-path failure / L1+ escalation, not normal oil.
 *
 * Zero device I/O; callers pass optional snap/fingerprint.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_STALL_MS = Number(process.env.XIANYU_STALL_MS || 45000);

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

/**
 * Pure stall state machine.
 * @returns {{ state, event? }} event is set when a stall is newly declared or resolved
 */
export function observeStall(state, {
  fingerprint,
  screenSha256 = null,
  now = Date.now(),
  stallMs = DEFAULT_STALL_MS,
  step = null,
} = {}) {
  const prev = state && typeof state === "object"
    ? state
    : { fingerprint: null, screenSha256: null, changedAt: null, stalled: false, stalledAt: null };

  if (!fingerprint) {
    return { state: prev, event: null };
  }

  const changed = prev.fingerprint !== fingerprint
    || (screenSha256 && prev.screenSha256 && prev.screenSha256 !== screenSha256);

  if (!prev.fingerprint || changed) {
    const next = {
      fingerprint,
      screenSha256: screenSha256 || prev.screenSha256,
      changedAt: now,
      stalled: false,
      stalledAt: null,
    };
    const event = prev.stalled
      ? {
        kind: "stall_cleared",
        dumpFingerprint: fingerprint,
        screenSha256: next.screenSha256,
        unchangedMs: prev.stalledAt != null && prev.changedAt != null
          ? Math.max(0, prev.stalledAt - prev.changedAt)
          : null,
        step,
        llmEscalationRecommended: false,
        diagnosisHint: "ui_changed",
      }
      : null;
    return { state: next, event };
  }

  const changedAt = prev.changedAt ?? now;
  const unchangedMs = Math.max(0, now - changedAt);
  if (!prev.stalled && unchangedMs >= stallMs) {
    const next = {
      ...prev,
      fingerprint,
      screenSha256: screenSha256 || prev.screenSha256,
      stalled: true,
      stalledAt: now,
    };
    return {
      state: next,
      event: {
        kind: "stall",
        dumpFingerprint: fingerprint,
        screenSha256: next.screenSha256,
        unchangedMs,
        stallMs,
        step,
        llmEscalationRecommended: true,
        diagnosisHint: "stuck_or_slow",
      },
    };
  }

  return {
    state: {
      ...prev,
      fingerprint,
      screenSha256: screenSha256 || prev.screenSha256,
    },
    event: null,
  };
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
  now = () => Date.now(),
} = {}) {
  let stallState = { fingerprint: null, screenSha256: null, changedAt: null, stalled: false, stalledAt: null };
  const stallEvents = [];
  const path = progressPathFor(evidenceDir);

  function note({ phase, name = null, step = null, snap = null, screenSha256 = null, ok = null, extra = null } = {}) {
    const fingerprint = snap ? uiFingerprint(snap) : null;
    const observed = observeStall(stallState, {
      fingerprint: fingerprint || stallState.fingerprint,
      screenSha256: screenSha256 || snap?.screenshot?.sha256 || null,
      now: now(),
      stallMs,
      step: step || name,
    });
    stallState = observed.state;
    if (observed.event) stallEvents.push(observed.event);

    const record = {
      t: new Date(now()).toISOString(),
      phase,
      name,
      step,
      ok,
      dumpFingerprint: fingerprint || stallState.fingerprint,
      screenSha256: stallState.screenSha256,
      stalled: stallState.stalled,
      unchangedMs: stallState.changedAt != null ? Math.max(0, now() - stallState.changedAt) : null,
      llmEscalationRecommended: Boolean(observed.event?.llmEscalationRecommended || stallState.stalled),
      diagnosisHint: observed.event?.diagnosisHint
        || (stallState.stalled ? "stuck_or_slow" : "progress"),
      ...(extra && typeof extra === "object" ? { extra } : {}),
      ...(observed.event ? { stallEvent: observed.event } : {}),
    };
    appendProgressLine(evidenceDir, record);
    return record;
  }

  return {
    path,
    stallMs,
    note,
    getStallState: () => ({ ...stallState }),
    getStallEvents: () => stallEvents.slice(),
    summary() {
      return {
        path,
        stallMs,
        stalled: stallState.stalled,
        dumpFingerprint: stallState.fingerprint,
        screenSha256: stallState.screenSha256,
        unchangedMs: stallState.changedAt != null ? Math.max(0, now() - stallState.changedAt) : null,
        llmEscalationRecommended: stallState.stalled,
        stallEvents: stallEvents.slice(),
        diagnosisHint: stallState.stalled ? "stuck_or_slow" : "ok",
      };
    },
  };
}
