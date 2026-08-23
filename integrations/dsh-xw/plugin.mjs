import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HARNESS_ALLOWED_TOOLS,
  HARNESS_FORBIDDEN_TOOLS,
  assertHarnessToolAllowed,
} from "../../packages/kernel/lib/skill-runtime.mjs";
import { HarnessRuntime, assertAdapterConformance, loadDshLock } from "../../packages/harness-protocol/lib/protocol.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export function loadPluginLock() {
  return JSON.parse(readFileSync(join(here, "lock.json"), "utf8"));
}

export const DSH_XW_TOOLS = HARNESS_ALLOWED_TOOLS;
export const DSH_XW_FORBIDDEN = HARNESS_FORBIDDEN_TOOLS;

export class DshXwAdapter {
  constructor(opts = {}) {
    const lock = loadDshLock();
    const pluginLock = loadPluginLock();
    if (pluginLock.commit !== lock.commit || pluginLock.version !== lock.version) {
      const error = new Error("integrations/dsh-xw lock does not match harness-protocol lock");
      error.code = "DSH_LOCK_DRIFT";
      throw error;
    }
    this.adapterKind = "fixture_in_process";
    this.traceMarker = "xw.dsh.fixture-in-process.v1";
    this.lock = lock;
    this.runtime = new HarnessRuntime({
      harness: "deepseek-harness",
      harnessVersion: lock.version,
      harnessCommit: lock.commit,
      ...opts,
    });
    assertAdapterConformance(this);
  }

  createSession() {
    return this.runtime.createSession();
  }

  restoreSession(input) {
    return this.runtime.restoreSession({
      ...input,
      harnessCommit: input.harnessCommit || this.lock.commit,
    });
  }

  submitGoal(input) {
    return this.runtime.submitGoal(input);
  }

  continueSkill(input) {
    return this.runtime.continueSkill(input);
  }

  checkpoint(input) {
    return this.runtime.checkpoint(input);
  }

  queryTrace(input) {
    return this.runtime.queryTrace(input);
  }

  interrupt(input) {
    return this.runtime.interrupt(input);
  }

  close(input) {
    return this.runtime.close(input);
  }

  invokeTool(sessionId, name, payload) {
    assertHarnessToolAllowed(name);
    return this.runtime.invokeTool(sessionId, name, payload);
  }

  serialize(sessionId) {
    return this.runtime.serialize(sessionId);
  }
}
