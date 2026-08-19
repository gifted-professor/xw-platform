import { createFakeObserveProvider } from "../../../services/control-plane/control-plane/lib/open-action-session.mjs";

export const LIVE_CANARY_GATE = "CLOSED";

export function createFixtureBackend(options = {}) {
  const provider = createFakeObserveProvider(options);
  return {
    kind: "fixture",
    executionMode: "fixture",
    executorId: "replay-fixture",
    transportCalled: false,
    liveCanaryGate: LIVE_CANARY_GATE,
    observeProvider: {
      ...provider,
      executionMode: "fixture",
      executorId: "replay-fixture",
    },
  };
}

export function createRecordedBackend(trace = {}) {
  const observations = [...(trace.observations || [])];
  let index = 0;
  return {
    kind: "recorded_replay",
    executionMode: "recorded_replay",
    executorId: "replay-recorded",
    transportCalled: false,
    liveCanaryGate: LIVE_CANARY_GATE,
    observeProvider: {
      executionMode: "recorded_replay",
      executorId: "replay-recorded",
      mutatingCalls: 0,
      async observe() {
        const next = observations[Math.min(index, observations.length - 1)] || null;
        index += 1;
        if (!next) {
          const error = new Error("recorded replay has no further observations");
          error.code = "OBSERVATION_INCOMPLETE";
          throw error;
        }
        return { ...next, observationId: next.observationId || `replay_obs_${index}` };
      },
    },
  };
}

export function createFaultBackend({ faultAfter = null, fixture = {} } = {}) {
  const inner = createFakeObserveProvider({ fixture });
  let observes = 0;
  return {
    kind: "fault_injection",
    executionMode: "fault_injection",
    executorId: "replay-fault",
    transportCalled: false,
    liveCanaryGate: LIVE_CANARY_GATE,
    observeProvider: {
      executionMode: "fault_injection",
      executorId: "replay-fault",
      get mutatingCalls() {
        return 0;
      },
      async observe(session) {
        observes += 1;
        if (faultAfter === "observe" && observes === 1) {
          const error = new Error("injected observe fault");
          error.code = "OBSERVATION_INCOMPLETE";
          throw error;
        }
        if (faultAfter === "post-observe" && observes === 2) {
          const error = new Error("injected post-observe fault");
          error.code = "OBSERVATION_INCOMPLETE";
          throw error;
        }
        return inner.observe(session);
      },
    },
  };
}

export function summarizeTrace(events = []) {
  return {
    schemaId: "xw.open-action.trace.v1",
    schemaVersion: 1,
    transportCalled: false,
    liveCanaryGate: LIVE_CANARY_GATE,
    types: events.map((event) => event.type),
  };
}
