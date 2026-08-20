export const SKILL_PACK_LIFECYCLE = Object.freeze([
  "DRAFT",
  "CANDIDATE",
  "REPLAY_VERIFIED",
  "CANARY",
  "STABLE",
]);

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export class ExperienceCompiler {
  compileCandidate({ episodes = [], spec }) {
    if (!spec?.skillId) codedError("INVALID_SKILL_SPEC", "compiler requires a skill spec");
    if (episodes.length < 1) {
      return {
        lifecycle: "DRAFT",
        kind: "strategy-hint",
        reason: "not-enough-episodes-for-script",
      };
    }
    return {
      lifecycle: "CANDIDATE",
      skillId: spec.skillId,
      skillVersion: spec.version,
      implementationMode: "hybrid",
      requiresHumanReview: true,
      autoPromote: false,
    };
  }

  promote(candidate, { humanApproved = false, replayPassed = false, canaryPassed = false } = {}) {
    if (!humanApproved || !replayPassed || !canaryPassed) {
      codedError("SKILL_PROMOTION_BLOCKED", "STABLE requires human review + replay + canary");
    }
    if (candidate.lifecycle !== "CANDIDATE" && candidate.lifecycle !== "REPLAY_VERIFIED" && candidate.lifecycle !== "CANARY") {
      codedError("SKILL_PROMOTION_BLOCKED", `cannot promote from ${candidate.lifecycle}`);
    }
    return { ...candidate, lifecycle: "STABLE", autoPromote: false };
  }
}
