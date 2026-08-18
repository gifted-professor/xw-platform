/**
 * Shared permanent protected-commit kernel (Foundation INV-01).
 * Pure function — no I/O. Call before placement / pilot / device I/O.
 */

export function decideProtectedCommit(effect) {
  if (
    effect?.phase === "final"
    && (effect?.class === "publish" || effect?.class === "payment" || effect?.class === "delete")
  ) {
    return {
      protected: true,
      decision: "wait_human_commit",
      reasonCode: "PROTECTED_COMMIT_REQUIRED",
    };
  }
  return { protected: false };
}

/** Map kernel wait → Mission/ECP phc (existing enum; no ECP expansion). */
export function mapProtectedToMissionPhc(kernel) {
  if (!kernel?.protected) return null;
  return {
    decision: "phc",
    reason: "PROTECTED_COMMIT_REQUIRED",
    code: "PROTECTED_COMMIT_REQUIRED",
  };
}
