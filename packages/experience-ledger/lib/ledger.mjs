export const EXPERIENCE_LAYERS = Object.freeze([
  "facts",
  "patterns",
  "snapshots",
  "open_questions",
]);

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class ExperienceLedger {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.facts = [];
    this.patterns = new Map();
    this.snapshots = [];
    this.openQuestions = new Map();
  }

  appendFact(fact) {
    if (!fact?.id || !fact?.kind) codedError("INVALID_FACT", "fact requires id and kind");
    if (this.facts.some((row) => row.id === fact.id)) {
      codedError("FACT_IMMUTABLE", "facts are append-only and cannot be rewritten");
    }
    const row = { ...fact, recordedAt: fact.recordedAt || this.now() };
    this.facts.push(row);
    return clone(row);
  }

  upsertPattern(pattern) {
    if (!pattern?.id) codedError("INVALID_PATTERN", "pattern requires id");
    const existing = this.patterns.get(pattern.id);
    if (existing && pattern.overwrite) {
      codedError("PATTERN_NO_OVERWRITE", "patterns must be revised slowly, not overwritten");
    }
    const row = {
      id: pattern.id,
      statement: pattern.statement,
      supportEpisodes: pattern.supportEpisodes || 1,
      applicableAppVersions: pattern.applicableAppVersions || [],
      expiresOnAppVersion: pattern.expiresOnAppVersion || null,
      updatedAt: this.now(),
    };
    if (existing) {
      row.supportEpisodes = existing.supportEpisodes + (pattern.supportEpisodes || 1);
      row.statement = pattern.statement || existing.statement;
    }
    this.patterns.set(pattern.id, row);
    return clone(row);
  }

  writeSnapshot(snapshot) {
    if (!snapshot?.id) codedError("INVALID_SNAPSHOT", "snapshot requires id");
    if (this.snapshots.some((row) => row.id === snapshot.id)) {
      codedError("SNAPSHOT_IMMUTABLE", "snapshots cannot be modified once written");
    }
    const row = { ...snapshot, writtenAt: this.now() };
    this.snapshots.push(row);
    return clone(row);
  }

  openQuestion(question) {
    if (!question?.id || !question?.text) codedError("INVALID_QUESTION", "open question requires id and text");
    this.openQuestions.set(question.id, { ...question, status: "open", openedAt: this.now() });
    return clone(this.openQuestions.get(question.id));
  }

  resolveQuestion(id, resolution) {
    const row = this.openQuestions.get(id);
    if (!row) codedError("QUESTION_MISSING", `unknown question ${id}`);
    row.status = "resolved";
    row.resolution = resolution;
    row.resolvedAt = this.now();
    this.openQuestions.delete(id);
    return clone(row);
  }

  dump() {
    return {
      facts: clone(this.facts),
      patterns: [...this.patterns.values()].map(clone),
      snapshots: clone(this.snapshots),
      openQuestions: [...this.openQuestions.values()].map(clone),
    };
  }
}
