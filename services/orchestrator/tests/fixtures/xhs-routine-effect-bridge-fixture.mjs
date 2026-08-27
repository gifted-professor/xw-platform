/**
 * xhs-routine-effect-bridge-fixture.mjs — offline effect-bridge fixture for the
 * xw-xhs-routine CLI integration tests. Wraps the real CP bridge
 * (createRoutineEffectBridge + bridgeAsMachineEffects) around an in-memory
 * StateStore and a scripted typed transport, so the CLI end-to-end exercises
 * the same ledger path the live canary will.
 */
import { StateStore } from "../../../control-plane/control-plane/lib/state-store.mjs";
import { createRoutineEffectBridge, bridgeAsMachineEffects } from "../../../control-plane/apps/xhs/routine-effect-bridge.mjs";

const NOW = 1_700_000_000_000;
const CLOCK = { nowMs: () => NOW, sleep: async () => {} };

export function createMachineEffects({ plan }) {
  const state = new StateStore({ dbPath: ":memory:" });
  const owner = {
    sessionId: "sess-cli-fixture",
    leaseRef: "lease-cli-fixture",
    leaseAuthorization: "lat_cli_fixture",
    routineRunId: plan.routineRunId,
    planHash: plan.planHash,
  };
  const labels = ["点赞", "已点赞"];
  let likeIdx = 0;
  const transport = {
    async observe({ reason, targetFingerprint } = {}) {
      return {
        hash: `obs_${reason}_${plan.routineRunId}`,
        targetFingerprint,
        likeLabel: reason === "post_like" ? "已点赞" : labels[Math.min(likeIdx, labels.length - 1)],
        observedAt: CLOCK.nowMs(),
      };
    },
    async commitLike() {
      likeIdx += 1;
      return { ok: true };
    },
  };
  const bridge = createRoutineEffectBridge({ state, owner, transport, clock: CLOCK });
  return bridgeAsMachineEffects({ bridge, owner });
}