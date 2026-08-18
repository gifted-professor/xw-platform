/**
 * Runtime integrity recheck (Foundation PR2 / RI-04 / INV-10).
 * Compare bound vs live contract/closure before lease or Adapter I/O.
 * Submit path also compares expected hashes from Worker before creating Job.
 */

import { ControlPlaneError } from "./errors.mjs";
import { implementationClosureMatches } from "./implementation-closure.mjs";

export const CAPABILITY_CONTRACT_HASH_ALGORITHM_V2 =
  "xhs.capability-contract.sha256-canonical-json.v2";
export const CAPABILITY_CONTRACT_HASH_ALGORITHM_LEGACY = "legacy_algorithm_unknown";

function closureOf(capability) {
  return capability?.implementation?.implementationClosureHash
    || capability?.implementationClosureHash
    || null;
}

function contractOf(capability) {
  return capability?.capabilityContractHash || null;
}

function algorithmOf(capability) {
  return capability?.capabilityContractHashAlgorithm || null;
}

function failChanged(message, details) {
  throw new ControlPlaneError("IMPLEMENTATION_CONTRACT_CHANGED", message, {
    status: 409,
    details: { notSent: true, ...details },
  });
}

/**
 * @returns {{ ok: true, legacy: boolean } | never }
 */
export function assertImplementationIntegrity({ boundCapability, liveCapability, phase = "dispatch" } = {}) {
  if (!boundCapability || typeof boundCapability !== "object") {
    failChanged("bound capability missing for integrity recheck", { phase });
  }
  if (!liveCapability || typeof liveCapability !== "object") {
    failChanged("live capability missing for integrity recheck", {
      phase,
      capabilityId: boundCapability.id || null,
    });
  }

  const boundContract = contractOf(boundCapability);
  const liveContract = contractOf(liveCapability);
  const boundClosure = closureOf(boundCapability);
  const liveClosure = closureOf(liveCapability);
  const capabilityId = boundCapability.id || liveCapability.id || null;

  if (Boolean(boundContract) !== Boolean(liveContract)) {
    failChanged(`capabilityContractHash presence drift at ${phase}`, {
      phase,
      capabilityId,
      boundContract,
      liveContract,
    });
  }
  if (boundContract && liveContract && boundContract !== liveContract) {
    failChanged(`capabilityContractHash drift at ${phase}`, {
      phase,
      capabilityId,
      boundContract,
      liveContract,
    });
  }

  if (!boundClosure && !liveClosure) {
    return { ok: true, legacy: true };
  }
  if (Boolean(boundClosure) !== Boolean(liveClosure)) {
    failChanged(`implementationClosureHash presence drift at ${phase}`, {
      phase,
      capabilityId,
      boundClosure,
      liveClosure,
    });
  }
  if (!implementationClosureMatches(boundClosure, liveClosure)) {
    failChanged(`implementationClosureHash drift at ${phase}`, {
      phase,
      capabilityId,
      boundClosure,
      liveClosure,
    });
  }

  return { ok: true, legacy: false };
}

export function assertAlgorithmIntegrity({ boundCapability, liveCapability, phase = "dispatch" } = {}) {
  const boundAlgo = algorithmOf(boundCapability);
  const liveAlgo = algorithmOf(liveCapability);
  if (Boolean(boundAlgo) !== Boolean(liveAlgo)) {
    failChanged(`capabilityContractHashAlgorithm presence drift at ${phase}`, {
      phase,
      boundAlgo,
      liveAlgo,
    });
  }
  if (boundAlgo && liveAlgo && boundAlgo !== liveAlgo) {
    failChanged(`capabilityContractHashAlgorithm drift at ${phase}`, {
      phase,
      boundAlgo,
      liveAlgo,
    });
  }
  return { ok: true };
}

/**
 * Atomic submit lock: Worker expected hashes vs live Capability inside Job creation.
 * Missing expected* fields → legacy client path (compat).
 */
export function assertExpectedImplementationAtSubmit({
  liveCapability,
  expectedCapabilityContractHash = undefined,
  expectedCapabilityContractHashAlgorithm = undefined,
  expectedImplementationClosureHash = undefined,
} = {}) {
  const hasExpected = expectedCapabilityContractHash != null
    || expectedImplementationClosureHash != null
    || expectedCapabilityContractHashAlgorithm != null;
  if (!hasExpected) {
    return { ok: true, legacy: true };
  }
  const boundCapability = {
    id: liveCapability?.id,
    capabilityContractHash: expectedCapabilityContractHash ?? null,
    implementationClosureHash: expectedImplementationClosureHash ?? null,
    capabilityContractHashAlgorithm: expectedCapabilityContractHashAlgorithm ?? null,
  };
  assertImplementationIntegrity({
    boundCapability,
    liveCapability,
    phase: "submit",
  });
  assertAlgorithmIntegrity({
    boundCapability,
    liveCapability,
    phase: "submit",
  });
  return { ok: true, legacy: false };
}

/** Soft form for callers that prefer result objects over throws. */
export function recheckImplementationIntegrity(input) {
  try {
    const result = assertImplementationIntegrity(input);
    assertAlgorithmIntegrity(input);
    return result;
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
