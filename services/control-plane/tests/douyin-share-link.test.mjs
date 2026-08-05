import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDouyinAdapter } from "../apps/douyin/adapter.mjs";
import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import {
  createProgressReporter,
  extractDouyinShareUrl,
  findDetailShareButton,
  findImageCard,
  findImageFilter,
  findShareLinkAction,
  hasExactSearchInput,
  hasLinkCopiedConfirmation,
  inspectRecoveryPage,
  parseAllUiNodes,
  recoverShareLink,
  restoreShareLink,
  shareLink,
} from "../scripts/douyin-operator.mjs";

const registry = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
const privateDevice = {
  deviceId: "dev-test",
  alias: "01",
  nodeId: "DESKTOP-3I1EVHE",
  runtimeId: "private-runtime-id",
};
const leaseAuthorization = {
  leaseId: "lease-test",
  token: "lease-token-secret",
  deviceId: privateDevice.deviceId,
  controlUrl: "http://127.0.0.1:17920",
};

const validOutput = {
  ok: true,
  step: "share-link-copied",
  verified: true,
  verifyMethod: "copy-confirmation+ui-paste",
  appId: "douyin",
  packageName: "com.ss.android.ugc.aweme",
  keyword: "风景",
  text: "https://v.douyin.com/Test_123/",
  url: "https://v.douyin.com/Test_123/",
  focus: { package: "com.ss.android.ugc.aweme", activity: "splash.SplashActivity" },
  imageFilter: { bounds: [372, 356, 514, 433] },
  selectedCard: { bounds: [546, 472, 1069, 1169] },
  shareButton: { bounds: [929, 2225, 1080, 2345] },
  shareLinkAction: { bounds: [991, 2229, 1080, 2271] },
  copied: true,
  openedDetail: true,
  searchRestored: true,
  backHome: true,
  stoppedBeforeExternalShare: true,
  externalShareTriggered: false,
  observedAt: "2026-08-05T05:00:00.000Z",
};

function hierarchy(nodes) {
  const body = nodes.map((node, index) => `<node index="${index}" text="${node.text || ""}" content-desc="${node.desc || ""}" class="${node.className || "android.view.View"}" resource-id="${node.resourceId || ""}" clickable="${node.clickable ? "true" : "false"}" focused="${node.focused ? "true" : "false"}" bounds="[${node.bounds[0]},${node.bounds[1]}][${node.bounds[2]},${node.bounds[3]}]" />`).join("");
  return `<hierarchy>${body}</hierarchy>`;
}

test("share-link capability is an automatic replay-safe R1 observation", () => {
  const capability = registry.require("douyin.observe.share_link");
  assert.equal(capability.implementation.action, "share-link");
  assert.equal(capability.maturity, "E2");
  assert.equal(capability.risk, "R1");
  assert.equal(capability.idempotency, "replay_safe");
  assert.equal(capability.automationPolicy.mode, "automatic");
  assert.equal(capability.restoration.required, true);
  assert.equal(capability.timeoutMs, 300000);
});

test("share-link semantic locators match the observed UI and fail closed on ambiguity", () => {
  const doc = parseAllUiNodes(hierarchy([
    { text: "图片", className: "android.widget.Button", bounds: [372, 356, 514, 433] },
    { resourceId: "com.ss.android.ugc.aweme:id/qib", clickable: true, bounds: [546, 472, 1069, 1169] },
    { desc: "分享84.7万，按钮", className: "android.widget.LinearLayout", clickable: true, bounds: [929, 2225, 1080, 2345] },
    { text: "分享链接", className: "android.widget.TextView", bounds: [991, 2229, 1080, 2271] },
    { text: "链接已复制成功，去粘贴分享：", className: "android.widget.TextView", bounds: [44, 1811, 948, 1866] },
    { text: "复制打开抖音 https://v.douyin.com/Abc_123/", className: "android.widget.EditText", clickable: true, bounds: [132, 95, 910, 194] },
  ]));
  assert.deepEqual(findImageFilter(doc.nodes)?.bounds, [372, 356, 514, 433]);
  assert.deepEqual(findImageCard(doc.nodes)?.bounds, [546, 472, 1069, 1169]);
  assert.deepEqual(findDetailShareButton(doc.nodes)?.bounds, [929, 2225, 1080, 2345]);
  assert.deepEqual(findShareLinkAction(doc.nodes)?.bounds, [991, 2229, 1080, 2271]);
  assert.equal(hasLinkCopiedConfirmation(doc.nodes), true);
  assert.equal(extractDouyinShareUrl(doc.nodes), "https://v.douyin.com/Abc_123/");

  const duplicatedInputLabel = parseAllUiNodes(hierarchy([{
    text: "风景",
    desc: "风景",
    className: "android.widget.EditText",
    bounds: [132, 95, 910, 194],
  }]));
  assert.equal(hasExactSearchInput(duplicatedInputLabel.nodes, "风景"), true);

  const ambiguous = parseAllUiNodes(hierarchy([
    { text: "图片", className: "android.widget.Button", bounds: [200, 356, 342, 433] },
    { text: "图片", className: "android.widget.Button", bounds: [372, 356, 514, 433] },
  ]));
  assert.equal(findImageFilter(ambiguous.nodes), null);
});

test("adapter exposes only a verified short link and writes a redacted observation receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "douyin-share-link-"));
  const calls = [];
  try {
    const adapter = createDouyinAdapter({
      run: async (_exe, args) => {
        calls.push(args);
        if (args.includes("share-link-restore")) {
          return {
            ok: true,
            step: "douyin-splash-restored",
            safeStateVerified: true,
            keywordRestored: true,
            focus: { package: "com.ss.android.ugc.aweme", activity: "splash.SplashActivity" },
          };
        }
        return structuredClone(validOutput);
      },
    });
    const capability = registry.require("douyin.observe.share_link");
    const execution = await adapter.execute({
      capability,
      device: privateDevice,
      params: { keyword: "风景" },
      evidenceDirectory: root,
      leaseAuthorization,
      job: { jobId: "job-test", runId: "run-test" },
    });
    assert.equal(calls[0].includes("share-link"), true);
    assert.equal(calls[0].includes("--keyword"), true);
    assert.equal(calls[0].includes("--evidence-dir"), true);
    assert.equal(calls[0].includes("--run-id"), true);
    assert.equal(execution.evidenceFiles.length, 1);

    const verified = await adapter.verify({ capability, execution });
    assert.equal(verified.ok, true);
    assert.equal(verified.mode, "hash");
    assert.match(verified.hash, /^[a-f0-9]{64}$/);

    const evidenceRaw = readFileSync(execution.evidenceFiles[0].path, "utf8");
    const evidence = JSON.parse(evidenceRaw);
    assert.equal(evidence.url, validOutput.url);
    assert.equal(evidence.externalShareTriggered, false);
    assert.match(evidence.keywordFingerprint, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(evidenceRaw, /风景/);

    const restored = await adapter.restore({
      capability,
      device: privateDevice,
      params: { keyword: "风景" },
      evidenceDirectory: root,
      leaseAuthorization,
      job: { jobId: "job-test", runId: "run-test" },
    });
    assert.equal(calls[1].includes("share-link-restore"), true);
    assert.equal(calls[1].includes("风景"), true);
    assert.equal(restored.ok, true);
    assert.equal(restored.keywordRestored, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapter rejects forged URL, missing restoration, or any external-share claim", async () => {
  const adapter = createDouyinAdapter();
  const capability = registry.require("douyin.observe.share_link");
  for (const output of [
    { ...validOutput, url: "https://example.com/not-douyin", text: "https://example.com/not-douyin" },
    { ...validOutput, searchRestored: false },
    { ...validOutput, externalShareTriggered: true },
    { ...validOutput, focus: { package: "com.example.fake", activity: "splash.SplashActivity" } },
  ]) {
    const result = await adapter.verify({ capability, execution: { output } });
    assert.equal(result.ok, false);
    assert.equal(result.hash, null);
  }
});

test("adapter exposes audited read-only inspection and zero-action recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "douyin-share-recovery-adapter-"));
  const calls = [];
  try {
    const shot = join(root, "recovery.png");
    const adapter = createDouyinAdapter({
      run: async (_exe, args) => {
        calls.push(args);
        if (args.includes("inspect-recovery")) {
          return {
            ok: true,
            stoppedBeforeAction: true,
            step: "recovery-inspected",
            observation: { focus: { package: "com.miui.home", activity: ".launcher.Launcher" } },
            evidenceFiles: [{ path: shot, kind: "screenshot", label: "douyin-recovery-inspection" }],
          };
        }
        if (args.includes("share-link-recover")) {
          return {
            ok: true,
            safeStateVerified: true,
            zeroActionVerified: true,
            step: "already-safe-main",
            focus: { package: "com.miui.home", activity: ".launcher.Launcher" },
            evidenceFiles: [{ path: shot, kind: "screenshot", label: "douyin-recovery-inspection" }],
          };
        }
        throw new Error(`unexpected action: ${args.join(" ")}`);
      },
    });
    const capability = registry.require("douyin.observe.share_link");
    const inspected = await adapter.inspectRecovery({
      capability,
      device: privateDevice,
      evidenceDirectory: root,
      leaseAuthorization,
      job: { jobId: "job-test", runId: "run-test" },
    });
    assert.equal(calls[0].includes("inspect-recovery"), true);
    assert.equal(inspected.ok, true);
    assert.equal(inspected.stoppedBeforeAction, true);
    assert.equal(inspected.evidenceFiles[0].kind, "screenshot");

    const recovered = await adapter.restore({
      capability,
      device: privateDevice,
      params: { keyword: "风景" },
      evidenceDirectory: root,
      leaseAuthorization,
      job: { jobId: "job-test", runId: "run-test" },
      recoveryAttempt: true,
    });
    assert.equal(calls[1].includes("share-link-recover"), true);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.zeroActionVerified, true);
    assert.equal(recovered.visualConfirmationRequired, true);
    assert.equal(recovered.evidenceRequired, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("progress reporter appends monotonic events across execute and restore processes", () => {
  const root = mkdtempSync(join(tmpdir(), "douyin-share-progress-"));
  try {
    const first = createProgressReporter({ evidenceDir: root, runId: "run-a", jobId: "job-a" });
    first.step("search_result_observed", "fresh_ui");
    first.heartbeat();
    const second = createProgressReporter({ evidenceDir: root, runId: "run-a", jobId: "job-a" });
    second.complete("restore_complete");
    const rows = readFileSync(join(root, "progress.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map(JSON.parse);
    assert.deepEqual(rows.map((row) => row.seq), [1, 2, 3]);
    assert.equal(rows.every((row) => row.runId === "run-a" && row.jobId === "job-a"), true);
    assert.equal(rows[1].phase, "heartbeat");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator completes the observed path without touching an external share target", async () => {
  let state = "home";
  let inputValue = "";
  const semantics = [];
  const clipboard = "8.48 复制打开抖音 https://v.douyin.com/Live_Path9/ PxF:/";
  const op = {
    async currentFocus() {
      const activity = state === "home"
        ? "splash.SplashActivity"
        : ["result", "image-results"].includes(state)
          ? "search.activity.SearchResultActivity"
          : ["detail", "copied"].includes(state)
            ? "detail.ui.FlowPageActivity"
            : "search.activity.SearchActivity";
      return { package: "com.ss.android.ugc.aweme", activity };
    },
    async dumpXml(label) {
      if (label.startsWith("douyin-share-home")) {
        return hierarchy([{ text: "搜索", clickable: true, bounds: [900, 100, 1080, 190] }]);
      }
      if (label.startsWith("douyin-share-suggest")) {
        return hierarchy([{ className: "android.widget.EditText", clickable: true, bounds: [132, 95, 910, 194] }]);
      }
      if (label.startsWith("douyin-share-result")) {
        return hierarchy([{ text: "图片", className: "android.widget.Button", bounds: [372, 356, 514, 433] }]);
      }
      if (label.startsWith("douyin-share-image-results")) {
        return hierarchy([{ resourceId: "com.ss.android.ugc.aweme:id/qib", clickable: true, bounds: [546, 472, 1069, 1169] }]);
      }
      if (label.startsWith("douyin-share-detail")) {
        return hierarchy([{ desc: "分享84.7万，按钮", className: "android.widget.LinearLayout", clickable: true, bounds: [929, 2225, 1080, 2345] }]);
      }
      if (label.startsWith("douyin-share-panel")) {
        return hierarchy([{ text: "分享链接", className: "android.widget.TextView", bounds: [991, 2229, 1080, 2271] }]);
      }
      if (label.startsWith("douyin-share-copied")) {
        return hierarchy([{ text: "链接已复制成功，去粘贴分享：", bounds: [44, 1811, 948, 1866] }]);
      }
      if (label.startsWith("douyin-share-pasted")) {
        return hierarchy([{ text: inputValue, className: "android.widget.EditText", clickable: true, bounds: [132, 95, 910, 194] }]);
      }
      if (label.startsWith("douyin-share-keyword-restored")) {
        return hierarchy([{ text: inputValue, desc: inputValue, className: "android.widget.EditText", clickable: true, bounds: [132, 95, 910, 194] }]);
      }
      return hierarchy([{ text: inputValue, className: "android.widget.EditText", clickable: true, bounds: [132, 95, 910, 194] }]);
    },
    async tap(_x, _y, semantic) {
      if (semantic) semantics.push(semantic);
      if (state === "home") state = "suggest";
      else if (state === "result" && semantic === "douyin image filter") state = "image-results";
      else if (state === "image-results") state = "detail";
      else if (state === "detail" && semantic === "douyin detail share button") state = "share-panel";
      else if (state === "share-panel") state = "copied";
    },
    async inputTextViaXiaowei(text, { refocus } = {}) {
      await refocus?.();
      inputValue = text;
      return { inputAccepted: true };
    },
    async shellExec(command) {
      if (/KEYCODE_ENTER/.test(command)) {
        if (state === "suggest") state = "result";
        else if (state === "result") state = "result";
      } else if (/KEYCODE_DEL/.test(command)) {
        inputValue = "";
      } else if (/KEYCODE_PASTE/.test(command)) {
        inputValue = clipboard;
      }
      return "";
    },
    async back() {
      if (state === "copied") state = "detail";
      else if (state === "share-panel") state = "detail";
      else if (state === "detail") state = "result";
      else if (state === "result") state = "home";
      else if (state === "suggest") state = "home";
    },
    async home() {
      state = "home";
    },
  };

  const progress = [];
  const result = await shareLink(op, "风景", {
    wait: async () => {},
    progress: (step) => progress.push(step),
  });
  assert.equal(result.url, "https://v.douyin.com/Live_Path9/");
  assert.equal(result.externalShareTriggered, false);
  assert.equal(result.searchRestored, true);
  assert.equal(result.backHome, true);
  assert.equal(inputValue, "风景");
  assert.equal(state, "home");
  assert.equal(semantics.includes("douyin copy share link"), true);
  assert.equal(semantics.some((value) => /微信|私信|QQ|微博/.test(value)), false);
  assert.equal(progress.includes("share_url_observed"), true);
});

test("restore action backs to Douyin Splash and falls back to verified system home", async () => {
  let activity = "detail.ui.FlowPageActivity";
  const douyin = {
    async currentFocus() {
      return { package: "com.ss.android.ugc.aweme", activity };
    },
    async back() {
      activity = "splash.SplashActivity";
    },
    async home() {},
  };
  const restored = await restoreShareLink(douyin, { wait: async () => {} });
  assert.equal(restored.ok, true);
  assert.equal(restored.step, "douyin-splash-restored");

  let focus = { package: "com.example.other", activity: "OtherActivity" };
  const external = {
    async currentFocus() { return focus; },
    async back() {},
    async home() { focus = { package: "com.miui.home", activity: ".launcher.Launcher" }; },
  };
  const home = await restoreShareLink(external, { wait: async () => {} });
  assert.equal(home.ok, true);
  assert.equal(home.step, "system-home-restored");
});

test("recovery is zero-action on a safe page and stages one HOME transition otherwise", async () => {
  const root = mkdtempSync(join(tmpdir(), "douyin-share-recovery-"));
  const calls = [];
  const focus = { package: "com.miui.home", activity: ".launcher.Launcher" };
  const op = {
    async currentFocus() {
      calls.push("focus");
      return focus;
    },
    async capturePng(path) {
      calls.push("screen");
      return { path, bytes: 1234, sha256: "a".repeat(64) };
    },
    async dumpXml() {
      calls.push("dump");
      return hierarchy([{ text: "桌面", bounds: [0, 0, 1080, 2400] }]);
    },
  };
  try {
    const inspected = await inspectRecoveryPage(op, { evidenceDir: root });
    assert.equal(inspected.ok, true);
    assert.equal(inspected.stoppedBeforeAction, true);
    assert.equal(inspected.observation.pageClassification.pageType, "unknown");
    assert.equal(inspected.evidenceFiles[0].kind, "screenshot");

    const recovered = await recoverShareLink(op, { evidenceDir: root });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.safeStateVerified, true);
    assert.equal(recovered.zeroActionVerified, true);
    assert.equal(recovered.step, "already-safe-main");
    assert.deepEqual([...new Set(calls)].sort(), ["dump", "focus", "screen"]);

    let foreignFocus = true;
    let homeCalls = 0;
    const transitioned = await recoverShareLink({
      ...op,
      async currentFocus() {
        return foreignFocus
          ? { package: "com.example.other", activity: "OtherActivity" }
          : focus;
      },
      async home() {
        homeCalls += 1;
        foreignFocus = false;
      },
    }, { evidenceDir: root, wait: async () => {} });
    assert.equal(transitioned.ok, false);
    assert.equal(transitioned.step, "system-home-transitioned-reinspect-required");
    assert.equal(transitioned.safeStateVerified, true);
    assert.equal(transitioned.zeroActionVerified, false);
    assert.equal(transitioned.transitionPerformed, true);
    assert.equal(transitioned.stoppedBeforeAction, false);
    assert.equal(transitioned.evidenceFiles.length, 2);
    assert.equal(homeCalls, 1);

    let focusReads = 0;
    let unstableHomeCalls = 0;
    const unstable = await recoverShareLink({
      ...op,
      async currentFocus() {
        focusReads += 1;
        return {
          package: "com.example.other",
          activity: focusReads === 1 ? "FirstActivity" : "SecondActivity",
        };
      },
      async home() {
        unstableHomeCalls += 1;
      },
    }, { evidenceDir: root, wait: async () => {} });
    assert.equal(unstable.ok, false);
    assert.equal(unstable.step, "focus-changed-during-capture");
    assert.equal(unstable.zeroActionVerified, false);
    assert.equal(unstable.transitionPerformed, false);
    assert.equal(unstableHomeCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore action replaces a pasted clipboard value before leaving search results", async () => {
  let inputValue = "复制打开抖音 https://v.douyin.com/Stale_Link/";
  let activity = "search.activity.SearchResultActivity";
  const op = {
    async currentFocus() {
      return { package: "com.ss.android.ugc.aweme", activity };
    },
    async dumpXml() {
      return hierarchy([{
        text: inputValue,
        className: "android.widget.EditText",
        clickable: true,
        bounds: [132, 95, 910, 194],
      }]);
    },
    async tap() {},
    async inputTextViaXiaowei(text, { refocus } = {}) {
      await refocus?.();
      inputValue = text;
    },
    async shellExec(command) {
      if (/KEYCODE_ENTER/.test(command)) activity = "search.activity.SearchResultActivity";
      return "";
    },
    async back() {
      activity = "splash.SplashActivity";
    },
    async home() {},
  };
  const result = await restoreShareLink(op, { keyword: "风景", wait: async () => {} });
  assert.equal(result.ok, true);
  assert.equal(result.keywordRestored, true);
  assert.equal(result.searchResultEncountered, true);
  assert.equal(inputValue, "风景");
  assert.equal(result.focus.activity, "splash.SplashActivity");
});
