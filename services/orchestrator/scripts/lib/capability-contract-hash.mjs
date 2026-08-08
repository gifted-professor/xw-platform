/**
 * Capability contract hash algorithm version (Foundation PR2 wiring).
 * Preimage changed in PR2 (implementation includes closure + tcbManifestRef).
 * Bare 64-hex alone cannot distinguish PR1 vs PR2 algorithms.
 */

export const CAPABILITY_CONTRACT_HASH_ALGORITHM_V2 =
  "xhs.capability-contract.sha256-canonical-json.v2";

/** Durable objects without an algorithm field must not be rehashed and claimed current. */
export const CAPABILITY_CONTRACT_HASH_ALGORITHM_LEGACY = "legacy_algorithm_unknown";

export function resolveCapabilityContractHashAlgorithm(capability) {
  if (!capability?.capabilityContractHash) return null;
  if (typeof capability.capabilityContractHashAlgorithm === "string"
    && capability.capabilityContractHashAlgorithm.length > 0) {
    return capability.capabilityContractHashAlgorithm;
  }
  return CAPABILITY_CONTRACT_HASH_ALGORITHM_LEGACY;
}
