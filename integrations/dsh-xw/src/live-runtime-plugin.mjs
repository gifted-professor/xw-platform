import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "xw-dsh-live-runtime";

export async function apply() {
  const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../profiles/live/model-manifest.json"), "utf8"));
  if (manifest.status !== "QUALIFIED" || manifest.gateFEligible !== true || !/^[0-9a-f]{64}$/u.test(manifest.contentHash || "")) {
    throw Object.assign(new Error(`M6-4 live profile is fail-closed: ${manifest.reason || "model profile is not qualified"}`), { code: "M6_LIVE_PROFILE_UNQUALIFIED" });
  }
  throw Object.assign(new Error("qualified live provider adapter must be sealed by a separately reviewed runtime lock"), { code: "M6_LIVE_PROVIDER_ADAPTER_UNSEALED" });
}

export default { name, apply };
