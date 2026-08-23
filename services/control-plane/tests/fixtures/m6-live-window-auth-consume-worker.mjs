import { readFileSync } from "node:fs";

import {
  normalizeM64LiveWindowIssuerAllowlist,
  verifyM64LiveWindowAuthorization,
} from "../../control-plane/lib/m6-live-window-authorization.mjs";
import { StateStore } from "../../control-plane/lib/state-store.mjs";

const [dbPath, authorizationPath, allowlistPath, runtimePath, nowText] = process.argv.slice(2);
const nowMs = Number(nowText);
let state;
try {
  const authorization = JSON.parse(readFileSync(authorizationPath, "utf8"));
  const issuerAllowlist = normalizeM64LiveWindowIssuerAllowlist(JSON.parse(readFileSync(allowlistPath, "utf8")));
  const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
  state = new StateStore({ dbPath, now: () => nowMs });
  const verification = verifyM64LiveWindowAuthorization({
    authorization,
    issuerAllowlist,
    runtime,
    nowMs,
  });
  const current = state.getM6GateFence();
  state.promoteM6GateFence({
    expectedEpochHash: current.epochHash,
    expectedGeneration: current.generation,
    next: {
      gateId: runtime.gateId,
      epochHash: runtime.gateEpochHash,
      mode: "GROUNDED_ACTION",
      purpose: runtime.purpose,
      allowlist: [runtime.alias],
      expiresAt: authorization.expiresAt,
      releaseId: runtime.releaseId,
      sourceCommit: runtime.sourceCommit,
      locksHash: runtime.locksHash,
    },
    liveWindowAuthorizationConsumption: { authorization, verification },
  });
  const receipt = state.getM64LiveWindowAuthorizationConsumption(authorization.authorizationId);
  process.stdout.write(`${JSON.stringify({ ok: true, consumptionHash: receipt.consumptionHash })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: error?.code || "UNKNOWN" })}\n`);
  process.exitCode = 1;
} finally {
  state?.close();
}
