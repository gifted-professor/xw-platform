/**
 * Runtime integrity recheck (Foundation PR2 / RI-04). Registry-side twin of
 * routing control-plane/lib/runtime-integrity.mjs for resume fail-closed.
 */

import { implementationClosureMatches } from "./implementation-closure.mjs";

function fail(code, message, details) {
  return Object.assign(new Error(message), { code, details });
}

function closureOf(capability) {
  return capability?.implementation?.implementationClosureHash
    || capability?.implementationClosureHash
    || null;
}

function contractOf(capability) {
  return capability?.capabilityContractHash || null;
}

export function assertImplementationIntegrity({ boundCapability, liveCapability, phase = "resume" } = {}) {
  if (!boundCapability || typeof boundCapability !== "object") {
    throw fail("IMPLEMENTATION_CONTRACT_CHANGED", "bound capability missing for integrity recheck", {
      phase,
      notSent: true,
    });
  }
  if (!liveCapability || typeof liveCapability !== "object") {
    throw fail("IMPLEMENTATION_CONTRACT_CHANGED", "live capability missing for integrity recheck", {
      phase,
      notSent: true,
      capabilityId: boundCapability.id || null,
    });
  }

  const boundContract = contractOf(boundCapability);
  const liveContract = contractOf(liveCapability);
  const boundClosure = closureOf(boundCapability);
  const liveClosure = closureOf(liveCapability);
  const capabilityId = boundCapability.id || liveCapability.id || null;

  // Contract presence must be symmetric (no fail-open when one side truncates metadata).
  if (Boolean(boundContract) !== Boolean(liveContract)) {
    throw fail("IMPLEMENTATION_CONTRACT_CHANGED", `capabilityContractHash presence drift at ${phase}`, {
      phase,
      notSent: true,
      capabilityId,
      boundContract,
      liveContract,
    });
  }
  if (boundContract && liveContract && boundContract !== liveContract) {
    throw fail("IMPLEMENTATION_CONTRACT_CHANGED", `capabilityContractHash drift at ${phase}`, {
      phase,
      notSent: true,
      capabilityId,
      boundContract,
      liveContract,
    });
  }

  // Closure presence must be symmetric; both absent → legacy skip.
  if (!boundClosure && !liveClosure) {
    return { ok: true, legacy: true };
  }
  if (Boolean(boundClosure) !== Boolean(liveClosure)) {
    throw fail("IMPLEMENTATION_CONTRACT_CHANGED", `implementationClosureHash presence drift at ${phase}`, {
      phase,
      notSent: true,
      capabilityId,
      boundClosure,
      liveClosure,
    });
  }

  if (!implementationClosureMatches(boundClosure, liveClosure)) {
    throw fail("IMPLEMENTATION_CONTRACT_CHANGED", `implementationClosureHash drift at ${phase}`, {
      phase,
      notSent: true,
      capabilityId,
      boundClosure,
      liveClosure,
    });
  }

  return { ok: true, legacy: false };
}

export function recheckImplementationIntegrity(input) {
  try {
    return assertImplementationIntegrity(input);
  } catch (error) {
    if (error?.code === "IMPLEMENTATION_CONTRACT_CHANGED") {
      return {
        ok: false,
        code: error.code,
        message: error.message,
        details: error.details || { notSent: true },
      };
    }
    throw error;
  }
}

/** Resume policy: fail closed on integrity drift (PR2). */
export const RESUME_POLICY = Object.freeze({ mode: "fail_closed" });

export function assertResumeIntegrity({ boundNode, liveCapability }) {
  const boundCapability = {
    id: boundNode?.capabilityId,
    capabilityContractHash: boundNode?.capabilityContractHash || null,
    implementationClosureHash: boundNode?.implementationClosureHash || null,
    capabilityContractHashAlgorithm: boundNode?.capabilityContractHashAlgorithm || null,
  };
  const result = assertImplementationIntegrity({
    boundCapability,
    liveCapability,
    phase: "resume",
  });
  const boundAlgo = boundNode?.capabilityContractHashAlgorithm || null;
  const liveAlgo = liveCapability?.capabilityContractHashAlgorithm || null;
  if (Boolean(boundAlgo) !== Boolean(liveAlgo)) {
    throw fail("IMPLEMENTATION_CONTRACT_CHANGED", "capabilityContractHashAlgorithm presence drift at resume", {
      phase: "resume",
      notSent: true,
      boundAlgo,
      liveAlgo,
    });
  }
  if (boundAlgo && liveAlgo && boundAlgo !== liveAlgo) {
    throw fail("IMPLEMENTATION_CONTRACT_CHANGED", "capabilityContractHashAlgorithm drift at resume", {
      phase: "resume",
      notSent: true,
      boundAlgo,
      liveAlgo,
    });
  }
  return result;
}
