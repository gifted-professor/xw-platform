import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWechatAdapter } from "../apps/wechat/adapter.mjs";
import { createXhsAdapter } from "../apps/xhs/adapter.mjs";
import { createXianyuAdapter } from "../apps/xianyu/adapter.mjs";
import { createXiaoweiAdapter } from "../apps/xiaowei/adapter.mjs";
import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { evaluateCapabilityPolicy } from "../control-plane/lib/policy.mjs";

const registry = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
const privateDevice = {
  deviceId: "dev-test",
  alias: "01",
  nodeId: "DESKTOP-3I1EVHE",
  runtimeId: "private-runtime-id",
  metadata: { xhsServePort: 17895, adbPath: "adb.exe" },
};
const leaseAuthorization = {
  leaseId: "lease-test",
  token: "lease-token-secret",
  deviceId: privateDevice.deviceId,
  controlUrl: "http://127.0.0.1:17920",
};

test("XHS adapter uses a per-device loopback serve and fail-closed verifier", async () => {
  const calls = [];
  const adapter = createXhsAdapter({
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
      return new Response(JSON.stringify({
        ok: true,
        result: { cards: [], pageClass: "xhs.feed.index.empty", cardCount: 0 },
        metrics: {},
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const capability = registry.require("xhs.observe.feed");
  const execution = await adapter.execute({ capability, device: privateDevice, params: {}, leaseAuthorization });
  assert.equal(new URL(calls[0].url).hostname, "127.0.0.1");
  assert.equal(new URL(calls[0].url).port, "17895");
  assert.equal(calls[0].body.action, "feedCards");
  assert.equal(calls[0].headers["x-control-lease-id"], leaseAuthorization.leaseId);
  assert.equal(calls[0].headers["x-control-token"], leaseAuthorization.token);
  assert.equal(calls[0].headers["x-control-device-id"], leaseAuthorization.deviceId);
  assert.equal(execution.output.pageClass, "xhs.feed.index.empty");
  assert.equal(execution.output.cardCount, 0);
  assert.deepEqual(await adapter.verify({ capability, execution }), { ok: true, mode: "state" });
  assert.deepEqual(await adapter.verify({
    capability,
    execution: { output: { cards: [], pageClass: "xhs.unknown", cardCount: 0 } },
  }), { ok: false, mode: "state" });

  const send = registry.require("xhs.comment.send");
  assert.deepEqual(await adapter.verify({
    capability: send,
    execution: { output: { ok: true } },
  }), { ok: false, ambiguous: true, mode: "custom" });
});

test("XHS observe.feed projects redacted fields and evidenceFiles without failing on debt", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "xhs-feed-test-"));
  const shot = join(dir, "shot.png");
  const dump = join(dir, "dump.xml");
  writeFileSync(shot, Buffer.from("89504e470d0a1a0a", "hex"));
  writeFileSync(dump, "<hierarchy text=\"secret-author\" content-desc=\"pii\"></hierarchy>\n");
  const adapter = createXhsAdapter({
    fetchImpl: async () => new Response(JSON.stringify({
      ok: true,
      result: {
        cards: [{ cover: { center: [1, 2] }, authorName: "secret-author" }],
        pageClass: "xhs.feed.index",
        cardCount: 1,
        evidenceFiles: [
          { path: dump, kind: "ui_dump", label: "xhs-feed-ui-dump", exportAllowed: true },
          { path: shot, kind: "screenshot", label: "xhs-feed-screenshot", exportAllowed: false },
        ],
        evidenceDebt: [{ layer: "adapter-evidence", code: "MISSING_SCREENSHOT", cause: "simulated" }],
      },
      metrics: {},
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const capability = registry.require("xhs.observe.feed");
  const execution = await adapter.execute({ capability, device: privateDevice, params: {}, leaseAuthorization });
  assert.equal(execution.output.pageClass, "xhs.feed.index");
  assert.equal(execution.output.cardCount, 1);
  assert.equal(execution.output.evidenceDebt[0].code, "MISSING_SCREENSHOT");
  assert.ok(Array.isArray(execution.output.artifactRefs));
  assert.equal(execution.output.artifactRefs.length, 2);
  assert.equal(execution.output.artifactRefs[0].kind, "ui_dump");
  assert.equal(execution.output.artifactRefs[0].name, "dump.xml");
  assert.equal(execution.output.artifactRefs[1].name, "shot.png");
  assert.equal(execution.evidenceFiles.length, 2);
  assert.equal(execution.evidenceFiles[0].kind, "ui_dump");
  assert.equal(execution.evidenceFiles[0].exportAllowed, true);
  assert.equal(execution.evidenceFiles[1].kind, "screenshot");
  assert.equal(execution.evidenceFiles[1].exportAllowed, false);
  assert.deepEqual(await adapter.verify({ capability, execution }), { ok: true, mode: "state" });
});

test("generic XHS observation capabilities do not claim a Discovery receipt", async () => {
  const adapter = createXhsAdapter({
    fetchImpl: async (_url, options) => {
      const action = JSON.parse(options.body).action;
      return new Response(JSON.stringify({
        ok: true,
        result: action === "feedCards"
          ? { cards: [], pageClass: "xhs.feed.index.empty", cardCount: 0 }
          : { online: true },
        metrics: {},
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  for (const capability of ["xhs.observe.metrics", "xhs.observe.feed"].map((id) => registry.require(id))) {
    const execution = await adapter.execute({ capability, device: privateDevice, params: {}, leaseAuthorization });
    assert.equal(execution.output?.discoveryReceipt, undefined, `${capability.id} must not claim Discovery authority`);
  }
});

test("XHS adapter surfaces inner serve rejection instead of masking it as verification failure", async () => {
  const secret = "private-adapter-token";
  const adapter = createXhsAdapter({
    fetchImpl: async () => new Response(JSON.stringify({
      ok: true,
      result: {
        ok: false,
        notSent: true,
        step: "stableNoteLocatorUnavailable",
        locatorShape: {
          activity: "NoteDetailActivity",
          currentBlockFound: true,
          fields: {
            dat: { present: true, has24Hex: false, raw: `https://private.example/${secret}` },
            clip: { present: false, has24Hex: false },
            mReferrer: { present: false, has24Hex: false },
            extrasNoteId: { present: false, has24Hex: false },
          },
          generic24Count: 0,
          title: `private title ${secret}`,
        },
      },
      metrics: {},
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const send = registry.require("xhs.comment.send");
  await assert.rejects(
    adapter.execute({ capability: send, device: privateDevice, params: { text: "probe" }, leaseAuthorization }),
    (error) => {
      assert.equal(error.code, "ADAPTER_ACTION_REJECTED");
      assert.equal(error.notSent, true);
      assert.equal(error.details.step, "stableNoteLocatorUnavailable");
      assert.deepEqual(error.details.adapterError?.locatorShape, {
        activity: "NoteDetailActivity",
        currentBlockFound: true,
        fields: {
          dat: { present: true, has24Hex: false },
          clip: { present: false, has24Hex: false },
          mReferrer: { present: false, has24Hex: false },
          extrasNoteId: { present: false, has24Hex: false },
        },
        generic24Count: 0,
      });
      assert.doesNotMatch(JSON.stringify(error.details), /private-adapter-token|private title|private\.example/);
      return true;
    },
  );
});

test("Xianyu adapter preserves stop-before-publish and discard verification", async () => {
  const calls = [];
  const fakeOperator = fileURLToPath(new URL("../package.json", import.meta.url));
  const adapter = createXianyuAdapter({
    operatorPath: fakeOperator,
    run: async (_command, args, options) => {
      calls.push({ args, options });
      if (args.includes("inspect-recovery")) {
        return {
          ok: true,
          step: "recovery-inspected",
          stoppedBeforeAction: true,
          screenshot: { path: "C:\\evidence\\inspect.png", bytes: 1000, sha256: "a".repeat(64) },
          observation: { pageClassification: { pageType: "unknown", confidence: 0 } },
        };
      }
      if (args.includes("recover-discard-dry-run")) {
        return {
          ok: true,
          step: "sku-sheet-discarded-to-safe-main",
          stoppedBeforePublish: true,
          savedDraft: false,
          safeStateVerified: true,
          evidenceFiles: [{
            path: "C:\\evidence\\recovered.png",
            kind: "screenshot",
            label: "xianyu-recovery-final",
          }],
        };
      }
      if (args.includes("discard-dry-run")) return { ok: false, step: "not-on-publish-compose", savedDraft: false };
      if (args.includes("input-dry-run")) {
        return {
          ok: true,
          stoppedBeforePublish: true,
          audit: {
            inputAccepted: true,
            textVerified: true,
            clearedVerified: true,
            imeRestored: false,
            imeKeptOnXw: true,
          },
        };
      }
      if (args.includes("verify-image-manifest")) {
        return {
          ok: true,
          step: "image-manifest-verified",
          stoppedBeforeAction: true,
          manifest: {
            verified: true,
            entries: [{
              phonePath: "/sdcard/Pictures/XianyuStaging/a.png",
              expectedSha256: "a".repeat(64),
              actualSha256: "a".repeat(64),
              verified: true,
            }],
          },
        };
      }
      if (args.includes("image-dry-run")) {
        return {
          ok: true,
          stoppedBeforePublish: true,
          step: "images-uploaded",
          upload: { ok: true, step: "images-uploaded", picked: 2, imgCount: 2 },
        };
      }
      if (args.includes("--http-api-strict")) {
        return {
          ok: true,
          stoppedBeforePublish: true,
          savedDraft: false,
          steps: { flutterTap: { ok: true } },
          transition: { verified: true, from: "publish-compose", to: "sku-specs" },
          transportEvidence: {
            mode: "typed-http",
            httpReady: true,
            httpTapAttempts: 6,
            httpTapSucceeded: 6,
            gatewayTapFallbacks: 0,
          },
        };
      }
      if (args.includes("--save-draft")) {
        return {
          ok: true,
          stoppedBeforePublish: true,
          savedDraft: true,
          publishTapped: false,
          steps: { saveDraft: { ok: true } },
        };
      }
      if (args.includes("publish-dry-run")) {
        return { ok: true, stoppedBeforePublish: true, savedDraft: false, steps: {} };
      }
      return { ok: true };
    },
  });
  const capability = registry.require("xianyu.publish.input_dry_run");
  const execution = await adapter.execute({
    capability,
    device: privateDevice,
    params: { text: "probe" },
    leaseAuthorization,
  });
  assert.equal((await adapter.verify({ capability, execution })).ok, true);
  const restoration = await adapter.restore({ capability, device: privateDevice, leaseAuthorization });
  assert.equal(restoration.ok, false);
  assert.equal(restoration.step, "not-on-publish-compose");
  assert.equal(calls.some(({ args }) => args.includes("discard-dry-run")), true);

  const recovery = await adapter.restore({
    capability,
    device: privateDevice,
    evidenceDirectory: "C:\\evidence",
    leaseAuthorization,
    recoveryAttempt: true,
  });
  assert.equal(recovery.ok, true);
  assert.equal(recovery.safeStateVerified, true);
  assert.equal(recovery.evidenceRequired, true);
  assert.equal(recovery.visualConfirmationRequired, true);
  assert.equal(recovery.zeroActionVerified, false);
  assert.equal(recovery.evidenceFiles[0].label, "xianyu-recovery-final");
  assert.equal(calls.at(-1).args.includes("recover-discard-dry-run"), true);
  assert.equal(calls.at(-1).args.includes("--evidence-dir"), true);

  const inspection = await adapter.inspectRecovery({
    capability,
    device: privateDevice,
    evidenceDirectory: "C:\\evidence",
    leaseAuthorization,
  });
  assert.equal(inspection.ok, true);
  assert.equal(inspection.stoppedBeforeAction, true);
  assert.equal(inspection.evidenceFiles[0].path, "C:\\evidence\\inspect.png");
  assert.equal(calls.at(-1).args.includes("inspect-recovery"), true);
  assert.equal(calls.at(-1).args.includes("--evidence-dir"), true);

  const imageManifestCap = registry.require("xianyu.observe.image_manifest");
  const imageManifestParams = {
    images: [{ phonePath: "/sdcard/Pictures/XianyuStaging/a.png", sha256: "a".repeat(64) }],
  };
  const imageManifestExec = await adapter.execute({
    capability: imageManifestCap,
    device: privateDevice,
    params: imageManifestParams,
    leaseAuthorization,
  });
  assert.equal((await adapter.verify({ capability: imageManifestCap, execution: imageManifestExec })).ok, true);
  assert.equal((await adapter.verify({
    capability: imageManifestCap,
    execution: {
      output: {
        ok: true,
        stoppedBeforeAction: true,
        manifest: { verified: true, entries: [] },
      },
    },
  })).ok, false);
  assert.equal((await adapter.verify({
    capability: imageManifestCap,
    execution: {
      output: {
        ok: true,
        stoppedBeforeAction: true,
        manifest: { verified: true, entries: [{ verified: false }] },
      },
    },
  })).ok, false);
  assert.equal(calls.at(-1).args.includes("verify-image-manifest"), true);
  assert.equal(calls.at(-1).args.includes("--images"), true);
  const imagePolicy = evaluateCapabilityPolicy(imageManifestCap);
  assert.equal(imagePolicy.approvalRequired, false);
  assert.equal(imagePolicy.externalEffect, false);
  assert.equal(imagePolicy.decision, "allow");
  assert.throws(
    () => registry.validateParams(imageManifestCap.id, {
      images: [{ phonePath: "/sdcard/Pictures/a.png", sha256: "short" }],
    }),
    { code: "PARAMS_SCHEMA_INVALID" },
  );

  const imageCap = registry.require("xianyu.publish.image_dry_run");
  const imageExec = await adapter.execute({
    capability: imageCap,
    device: privateDevice,
    params: {
      images: [{ phonePath: "/sdcard/Pictures/XianyuStaging/a.png", sha256: "a".repeat(64) }],
      imageAlbum: "XianyuStaging",
    },
    leaseAuthorization,
  });
  assert.equal((await adapter.verify({ capability: imageCap, execution: imageExec })).ok, true);
  assert.equal(calls.some(({ args }) => args.includes("image-dry-run")), true);

  const fullCap = registry.require("xianyu.publish.full_dry_run");
  assert.throws(
    () => registry.validateParams(fullCap.id, { saveDraft: true }),
    { code: "PARAMS_SCHEMA_INVALID" },
  );
  const fullExec = await adapter.execute({
    capability: fullCap,
    device: privateDevice,
    params: { saveDraft: false },
    leaseAuthorization,
  });
  assert.equal((await adapter.verify({ capability: fullCap, execution: fullExec })).ok, true);
  assert.equal(calls.at(-1).args.includes("--save-draft"), false);

  const flutterTapProbe = registry.require("xianyu.probe.flutter_pointer_tap");
  const flutterTapExec = await adapter.execute({
    capability: flutterTapProbe,
    device: privateDevice,
    params: { saveDraft: false },
    leaseAuthorization,
  });
  const flutterArgs = calls.at(-1).args;
  assert.equal(flutterArgs.includes("--http-api-strict"), true);
  assert.deepEqual(flutterArgs.slice(flutterArgs.indexOf("--device-alias"), flutterArgs.indexOf("--device-alias") + 2), [
    "--device-alias", "01",
  ]);
  assert.equal(flutterArgs.includes("flutter-pointer-tap-probe"), true);
  assert.equal(flutterArgs.includes("publish-dry-run"), false);
  assert.equal((await adapter.verify({ capability: flutterTapProbe, execution: flutterTapExec })).ok, true);
  assert.equal((await adapter.verify({
    capability: flutterTapProbe,
    execution: {
      output: {
        ...flutterTapExec.output,
        transportEvidence: {
          ...flutterTapExec.output.transportEvidence,
          gatewayTapFallbacks: 1,
        },
      },
    },
  })).ok, false);

  const fullDraftCap = registry.require("xianyu.publish.full_draft_dry_run");
  // Foundation: shadow/legacy blocks business prepare without ordinary approval.
  const legacyDraft = evaluateCapabilityPolicy(fullDraftCap);
  assert.equal(legacyDraft.decision, "block");
  assert.equal(legacyDraft.reasonCode, "AUTONOMY_INACTIVE");
  assert.equal(legacyDraft.approvalRequired, false);
  assert.equal(legacyDraft.externalEffect, true);
  // nonpayment_v1 active: prepare allow
  const activeMode = { active: true, effectiveDecisionSource: "deployed-runtime", mode: "nonpayment_v1" };
  const freed = evaluateCapabilityPolicy(fullDraftCap, { policyMode: activeMode });
  assert.equal(freed.decision, "allow");
  assert.equal(freed.approvalRequired, false, "nonpayment_v1: non-payment draft must not require approval");
  assert.equal(freed.externalEffect, true, "externalEffect stays as a fact for ECP/reconcile semantics");
  assert.equal(freed.authorization?.effectiveDecisionSource, "deployed-runtime");
  const draftExec = await adapter.execute({
    capability: fullDraftCap,
    device: privateDevice,
    params: {},
    leaseAuthorization,
  });
  assert.equal(calls.at(-1).args.includes("--save-draft"), true);
  assert.equal((await adapter.verify({ capability: fullDraftCap, execution: draftExec })).ok, true);
  assert.deepEqual(
    await adapter.restore({ capability: fullDraftCap, device: privateDevice, execution: draftExec, leaseAuthorization }),
    { ok: true, skipped: "already-saved-draft" },
  );

  for (const call of calls) {
    assert.equal(call.options.env.XHS_OPERATOR_LEASE_TOKEN, leaseAuthorization.token);
    assert.doesNotMatch(JSON.stringify(call.args), /lease-token-secret/);
  }
});

test("WeChat adapter requires title match and baseline restoration", async () => {
  const fakeOperator = fileURLToPath(new URL("../package.json", import.meta.url));
  const adapter = createWechatAdapter({
    operatorPath: fakeOperator,
    run: async () => ({
      ok: true,
      titleMatched: true,
      evidence: { baselineHeld: true },
    }),
  });
  const capability = registry.require("wechat.navigate.conversation");
  const execution = await adapter.execute({
    capability,
    device: privateDevice,
    params: { title: "local-test-contact" },
    evidenceDirectory: fileURLToPath(new URL("../control-plane/runtime", import.meta.url)),
    leaseAuthorization,
  });
  assert.equal((await adapter.verify({ capability, execution })).ok, true);
});

test("Xiaowei raw adapter is canary-only and allowlisted", async () => {
  const calls = [];
  const adapter = createXiaoweiAdapter({
    transport: {
      async invoke(input) {
        calls.push(input);
        return { code: 10000, data: [] };
      },
    },
  });
  const capability = registry.require("xiaowei.lab.raw");
  await assert.rejects(
    adapter.execute({
      capability,
      device: privateDevice,
      params: { action: "list", data: {} },
      job: { canary: false },
    }),
    { code: "CANARY_REQUIRED" },
  );
  const execution = await adapter.execute({
    capability,
    device: privateDevice,
    params: { action: "list", data: {} },
    job: { canary: true },
  });
  assert.equal(execution.vendorCode, 10000);
  assert.equal(calls[0].devices, "private-runtime-id");
});
