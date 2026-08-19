import { HarnessRuntime, assertAdapterConformance } from "./protocol.mjs";

export class ReferenceHarnessAdapter {
  constructor(opts = {}) {
    this.runtime = new HarnessRuntime({
      harness: "reference-harness",
      harnessVersion: "m4b-fixture",
      harnessCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ...opts,
    });
    assertAdapterConformance(this);
  }

  createSession() {
    return this.runtime.createSession();
  }

  restoreSession(input) {
    return this.runtime.restoreSession(input);
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
    return this.runtime.invokeTool(sessionId, name, payload);
  }

  serialize(sessionId) {
    return this.runtime.serialize(sessionId);
  }
}
