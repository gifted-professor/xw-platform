/**
 * Runtime integrity recheck (Foundation PR2 / RI-04 / INV-10).
 * Compare bound vs live contract/closure before lease or Adapter I/O.
 */

import { ControlPlaneError } from "./errors.mjs";
import { implementationClosureMatches } from "./implementation-closure.mjs";

function closureOf(capability) {
  return capability?.implementation?.implementationClosureHash
    || capability?.implementationClosureHash
    || null;
}

function contractOf(capability) {
  return capability?.capabilityContractHash || null;
}

/**
 * @returns {{ ok: true, legacy: boolean } | never }
 * Legacy: neither side bound a closure → skip closure compare (read-only compat).
 * If either side has a closure or contract hash, mismatch fails closed.
 */
export function assertImplementationIntegrity({ boundCapability, liveCapability, phase = "dispatch" } = {}) {
  if (!boundCapability || typeof boundCapability !== "object") {
    throw new ControlPlaneError("IMPLEMENTATION_CONTRACT_CHANGED", "bound capability missing for integrity recheck", {
      status: 409,
      details: { phase, notSent: true },
    });
  }
  if (!liveCapability || typeof liveCapability !== "object") {
    throw new ControlPlaneError("IMPLEMENTATION_CONTRACT_CHANGED", "live capability missing for integrity recheck", {
      status: 409,
      details: { phase, notSent: true, capabilityId: boundCapability.id || null },
    });
  }

  const boundContract = contractOf(boundCapability);
  const liveContract = contractOf(liveCapability);
  const boundClosure = closureOf(boundCapability);
  const liveClosure = closureOf(liveCapability);

  if (boundContract && liveContract && boundContract !== liveContract) {
    throw new ControlPlaneError(
      "IMPLEMENTATION_CONTRACT_CHANGED",
      `capabilityContractHash drift at ${phase}`,
      {
        status: 409,
        details: {
          phase,
          notSent: true,
          capabilityId: boundCapability.id || liveCapability.id || null,
          boundContract,
          liveContract,
        },
      },
    );
  }

  if (!boundClosure && !liveClosure) {
    return { ok: true, legacy: true };
  }

  if (!implementationClosureMatches(boundClosure, liveClosure)) {
    throw new ControlPlaneError(
      "IMPLEMENTATION_CONTRACT_CHANGED",
      `implementationClosureHash drift at ${phase}`,
      {
        status: 409,
        details: {
          phase,
          notSent: true,
          capabilityId: boundCapability.id || liveCapability.id || null,
          boundClosure,
          liveClosure,
        },
      },
    );
  }

  return { ok: true, legacy: false };
}

/** Soft form for callers that prefer result objects over throws. */
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
