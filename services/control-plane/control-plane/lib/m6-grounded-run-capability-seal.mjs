import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { canonicalJson } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";
import {
  M6_GROUNDED_RUN_CAPABILITY_SELF_BINDING_CONTENT_HASH_PROFILE,
} from "./implementation-closure.mjs";
import {
  assertExactM6GroundedRunStaticClosure,
  computeM6GroundedRunStaticClosure,
} from "./m6-grounded-run-tcb-closure.mjs";
import { loadTcbManifest, verifyTcbManifestAgainstRoot } from "./tcb-manifest.mjs";

export const M6_GROUNDED_RUN_CAPABILITY_ID = "xiaowei.m6.grounded_run";
export const M6_GROUNDED_RUN_TCB_MANIFEST_ID = "xw.m6-grounded-run.tcb.v1";
export const M6_GROUNDED_RUN_TCB_MANIFEST_PATH = "artifacts/m6-4/tcb-manifests/xw.m6-grounded-run.tcb.v1.json";

// These are deliberately authority entry points rather than a hand-maintained
// flattened closure. Every repository-local static import and literal dynamic
// import reachable from them is reproduced by the closure scanner. A new edge
// therefore changes the expected manifest path set even if a reviewer forgets
// to edit a list.
export const M6_GROUNDED_RUN_AUTHORITY_ROOTS = Object.freeze([
  "integrations/dsh-xw/src/live-network-guard.mjs",
  "integrations/dsh-xw/src/live-parent-broker.mjs",
  "integrations/dsh-xw/src/live-pipe-client.mjs",
  "integrations/dsh-xw/src/live-process-adapter.mjs",
  "integrations/dsh-xw/src/live-runtime-plugin.mjs",
  "integrations/dsh-xw/src/live-tools.mjs",
  "integrations/dsh-xw/src/live-worker-driver.mjs",
  "integrations/dsh-xw/src/xw-protocol-server.mjs",
  "services/control-plane/apps/xiaowei/adapter.mjs",
  "services/control-plane/apps/xiaowei/m6-grounded-tcb.mjs",
  "services/control-plane/control-plane/bootstrap.mjs",
  "services/control-plane/control-plane/lib/control-plane.mjs",
  "services/control-plane/control-plane/lib/m6-gate-f-operations.mjs",
  "services/control-plane/control-plane/lib/m6-gate-loader.mjs",
  "services/control-plane/control-plane/lib/m6-gate-promoter.mjs",
  "services/control-plane/control-plane/lib/m6-qualification-bootstrap.mjs",
  "services/control-plane/control-plane/lib/m6-grounded-action-facade.mjs",
  "services/control-plane/control-plane/lib/m6-grounded-action-run-manager.mjs",
  "services/control-plane/control-plane/lib/m6-grounded-run-capability-seal.mjs",
  "services/control-plane/control-plane/lib/m6-live-broker.mjs",
  "services/control-plane/control-plane/lib/m6-live-entry.mjs",
  "services/control-plane/control-plane/lib/m6-live-fresh-state-capture.mjs",
  "services/control-plane/control-plane/lib/m6-live-production-callbacks.mjs",
  "services/control-plane/control-plane/lib/m6-live-production-dependencies.mjs",
  "services/control-plane/control-plane/lib/m6-live-window-authorization.mjs",
  "services/control-plane/control-plane/lib/m6-typed-transport.mjs",
  "services/control-plane/control-plane/lib/state-store.mjs",
  "services/control-plane/control-plane/router.mjs",
  "services/control-plane/control-plane/server.mjs",
  "services/orchestrator/scripts/lib/m6/m6-live-tool-surface.mjs",
]);

// Static data is a separate reviewed authority surface. Runtime content-
// addressed evidence remains external and is verified by its loaders; release
// policy/config/profile/manifests/schemas that define what may execute are
// immutable members of this TCB closure.
export const M6_GROUNDED_RUN_EXPLICIT_DATA_DEPENDENCIES = Object.freeze([
  "artifacts/m6-4/cohort-manifests/m6_4_action_smoke.json",
  "artifacts/m6-4/cohort-manifests/m6_4_hot_close.json",
  "artifacts/m6-4/cohort-manifests/m6_4_reliability.json",
  "artifacts/m6-4/cohort-manifests/m6_4_shadow.json",
  "artifacts/m6-4/cohort-manifests/m6_4_smooth.json",
  "artifacts/m6-4/cohort-manifests/xw.m6-effect-boundary.v1.json",
  "config/runtime/xw-runtime.v1.json",
  "integrations/dsh-xw/lock.json",
  "integrations/dsh-xw/package-lock.json",
  "integrations/dsh-xw/package.json",
  "integrations/dsh-xw/profiles/live/cordis.patch.yml",
  "integrations/dsh-xw/profiles/live/cordis.yml",
  "integrations/dsh-xw/profiles/live/model-manifest.json",
  "integrations/dsh-xw/profiles/live/package.json",
  "packages/harness-protocol/locks/dsh.lock.v1.json",
  "packages/kernel/contracts/open-action/action-request.v1.schema.json",
  "packages/kernel/contracts/open-action/action-result.v1.schema.json",
  "packages/kernel/contracts/open-action/observation.v1.schema.json",
  "packages/kernel/contracts/open-action/primitive-action.v1.schema.json",
  "packages/kernel/contracts/orchestration/m6/xw.capture-attempt-receipt.v1.schema.json",
  "packages/kernel/contracts/orchestration/m6/xw.m6-4-cohort-manifest.v1.schema.json",
  "packages/kernel/contracts/orchestration/m6/xw.m6-4-live-window-authorization.v1.schema.json",
  "packages/kernel/contracts/orchestration/m6/xw.m6-4-production-dependency-binding.v1.schema.json",
  "packages/kernel/contracts/orchestration/m6/xw.m6-action-slot-spec.v1.schema.json",
  "packages/kernel/contracts/orchestration/m6/xw.m6-effect-boundary.v1.schema.json",
  "packages/kernel/contracts/orchestration/m6/xw.m6-gate-f-artifact-catalog.v1.schema.json",
  "packages/kernel/contracts/orchestration/m6/xw.m6-live-gate.v1.schema.json",
  "packages/kernel/contracts/orchestration/m6/xw.m6-live-gate.v2.schema.json",
  "packages/kernel/contracts/orchestration/m6/xw.m6-locks.v2.schema.json",
  "packages/kernel/contracts/orchestration/m6/xw.m6-target-environment-attestation.v1.schema.json",
  "packages/kernel/contracts/runtime-profile.v1.json",
  "services/control-plane/apps/douyin/capabilities.json",
  "services/control-plane/apps/vision/capabilities.json",
  "services/control-plane/apps/wechat/capabilities.json",
  "services/control-plane/apps/xhs/capabilities.json",
  "services/control-plane/apps/xianyu/capabilities.json",
  "services/control-plane/apps/xiaowei/capabilities.json",
  "services/control-plane/control-plane/schema/effect-intent.schema.json",
  "services/control-plane/control-plane/schema/implementation-closure.v1.schema.json",
  "services/control-plane/control-plane/schema/tcb.manifest.v1.schema.json",
  "services/control-plane/docs/adr/0008-mission-driven-exploration-authorization.md",
  "services/control-plane/docs/adr/0009-standing-grant-delegation.md",
  "services/control-plane/docs/adr/0010-standing-grant-discovery-session.md",
  "services/orchestrator/contracts/tcb.manifest.v1.schema.json",
]);

const DEFAULT_REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export function computeM6GroundedRunImplementationClosurePaths({
  rootDir = DEFAULT_REPOSITORY_ROOT,
  authorityRoots = M6_GROUNDED_RUN_AUTHORITY_ROOTS,
  explicitDataDependencies = M6_GROUNDED_RUN_EXPLICIT_DATA_DEPENDENCIES,
} = {}) {
  return computeM6GroundedRunStaticClosure({ rootDir, authorityRoots, explicitDataDependencies });
}

export const M6_GROUNDED_RUN_IMPLEMENTATION_CLOSURE_PATHS =
  computeM6GroundedRunImplementationClosurePaths();

function sealError(code, message, details = {}) {
  return new ControlPlaneError(code, message, { status: 409, details });
}

export function verifyM6GroundedRunCapabilitySeal({
  capability,
  rootDir = DEFAULT_REPOSITORY_ROOT,
  manifestPath = resolve(rootDir, ...M6_GROUNDED_RUN_TCB_MANIFEST_PATH.split("/")),
} = {}) {
  if (capability?.id !== M6_GROUNDED_RUN_CAPABILITY_ID
    || capability?.implementation?.adapter !== "xiaowei"
    || capability?.implementation?.action !== "m6_grounded_run"
    || capability?.implementation?.tcbManifestRef !== M6_GROUNDED_RUN_TCB_MANIFEST_ID
    || !/^[a-f0-9]{64}$/u.test(capability?.implementation?.implementationClosureHash ?? "")) {
    throw sealError(
      "M6_GROUNDED_RUN_CAPABILITY_SEAL_INVALID",
      "grounded-run capability is not bound to the production TCB manifest",
    );
  }

  const manifest = loadTcbManifest(manifestPath);
  if (manifest.manifestId !== M6_GROUNDED_RUN_TCB_MANIFEST_ID
    || manifest.contentHashProfile !== M6_GROUNDED_RUN_CAPABILITY_SELF_BINDING_CONTENT_HASH_PROFILE
    || canonicalJson(manifest.capabilityIds) !== canonicalJson([M6_GROUNDED_RUN_CAPABILITY_ID])) {
    throw sealError(
      "M6_GROUNDED_RUN_TCB_IDENTITY_MISMATCH",
      "grounded-run TCB manifest identity or capability binding changed",
    );
  }
  const expectedPaths = computeM6GroundedRunImplementationClosurePaths({ rootDir });
  assertExactM6GroundedRunStaticClosure({ declaredPaths: manifest.paths, expectedPaths });

  const verified = verifyTcbManifestAgainstRoot(manifest, rootDir);
  if (verified.implementationClosureHash !== capability.implementation.implementationClosureHash
    || verified.tcbManifestRef !== capability.implementation.tcbManifestRef) {
    throw sealError(
      "M6_GROUNDED_RUN_CAPABILITY_SEAL_MISMATCH",
      "grounded-run capability hash differs from its reproduced TCB closure",
      {
        capabilityHash: capability.implementation.implementationClosureHash,
        manifestHash: verified.implementationClosureHash,
      },
    );
  }
  return Object.freeze({
    capabilityId: capability.id,
    implementationClosureHash: verified.implementationClosureHash,
    tcbManifestRef: verified.tcbManifestRef,
    contentHashProfile: manifest.contentHashProfile,
    pathCount: expectedPaths.length,
  });
}
