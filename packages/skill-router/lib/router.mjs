import { INTENT_PATTERN, SKILL_ID_PATTERN } from "../../kernel/lib/skill-runtime.mjs";

export const DEFAULT_INTENT_CATALOG = Object.freeze({
  "intent:repair-navigation": "device.repair-navigation",
  "intent:reobserve-app-state": "xhs.observe-feed",
  "intent:wait-human-input": null,
  "intent:verify-external-effect": "system.verify-effect",
  "intent:collect-note": "xhs.collect",
});

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export class SkillRouter {
  constructor({ catalog = DEFAULT_INTENT_CATALOG } = {}) {
    this.catalog = { ...catalog };
  }

  resolveIntent(intent) {
    if (!INTENT_PATTERN.test(intent)) {
      codedError("INVALID_CANDIDATE_INTENT", `router refuses non-intent value: ${intent}`);
    }
    if (SKILL_ID_PATTERN.test(intent)) {
      codedError("LEAF_SKILL_ROUTED_AHEAD", "router will not accept a raw skillId as intent");
    }
    if (!(intent in this.catalog)) {
      codedError("INTENT_UNBOUND", `no skill bound for ${intent}`);
    }
    return this.catalog[intent];
  }

  route({
    goal,
    nodeId = null,
    currentSkillId = null,
    exit,
    observation = null,
    budgets = {},
    userConstraints = [],
  } = {}) {
    if (!exit?.exit) codedError("INVALID_SKILL_EXIT", "router requires a typed skill exit");
    const base = {
      goal: goal || null,
      nodeId,
      observationPartial: observation?.partial === true,
      budgets,
      userConstraints,
    };

    if (exit.exit === "COMPLETED") {
      return { ...base, decision: "DONE", nextSkillId: null, reason: exit.reason || "skill-completed" };
    }
    if (exit.exit === "ABORTED") {
      return { ...base, decision: "ABORTED", nextSkillId: null, reason: exit.reason || "aborted" };
    }
    if (exit.exit === "WAIT_HUMAN") {
      return { ...base, decision: "WAIT_HUMAN", nextSkillId: null, reason: exit.reason || "wait-human" };
    }
    if (exit.exit === "WAIT_EXTERNAL") {
      return { ...base, decision: "WAIT_EXTERNAL", nextSkillId: null, reason: exit.reason || "wait-external" };
    }
    if (exit.exit === "CONTINUE" || exit.exit === "RETRY") {
      return {
        ...base,
        decision: exit.exit,
        nextSkillId: currentSkillId,
        reason: exit.reason || "stay-on-current-skill",
      };
    }
    if (exit.exit === "REPAIR_REQUIRED") {
      return {
        ...base,
        decision: "REPAIR",
        nextSkillId: this.resolveIntent("intent:repair-navigation"),
        reason: exit.reason || "repair-required",
      };
    }

    const intents = exit.candidateIntents || [];
    if (!intents.length) {
      codedError("INTENT_UNBOUND", `${exit.exit} requires candidateIntents for the router`);
    }
    const nextSkillId = this.resolveIntent(intents[0]);
    return {
      ...base,
      decision: exit.exit,
      intent: intents[0],
      nextSkillId,
      reason: exit.reason || "routed-from-intent",
    };
  }
}
