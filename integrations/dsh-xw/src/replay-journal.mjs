import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

import { canonicalJson, sha256Json } from "./canonical-json.mjs";

function fsyncFile(path) {
  const fd = openSync(path, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export class ReplayJournal {
  constructor(root, workerRunRef) {
    this.root = root;
    this.workerRunRef = workerRunRef;
    this.journalPath = join(root, `${workerRunRef}.journal.jsonl`);
    this.checkpointPath = join(root, `${workerRunRef}.checkpoint.json`);
    mkdirSync(root, { recursive: true });
    this.entries = [];
    try {
      const source = readFileSync(this.journalPath, "utf8").trim();
      if (source) {
        this.entries = source.split("\n").map((line) => JSON.parse(line));
        this.entries.forEach((entry, index) => {
          if (entry.seq !== index + 1) {
            const error = new Error(`journal sequence gap at ${index + 1}`);
            error.code = "M6_DSH_JOURNAL_MISMATCH";
            throw error;
          }
        });
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        if (!String(error.code ?? "").startsWith("M6_DSH_")) error.code = "M6_DSH_JOURNAL_MISMATCH";
        throw error;
      }
    }
  }

  append(entry) {
    const record = Object.freeze({ seq: this.entries.length + 1, ...entry });
    const fd = openSync(this.journalPath, "a");
    try {
      writeSync(fd, `${canonicalJson(record)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.entries.push(record);
    return record;
  }

  prefixHash() {
    return sha256Json(this.entries);
  }

  find(tool, argsHash) {
    return this.entries.find((entry) => entry.tool === tool && entry.argsHash === argsHash)?.result;
  }

  loadCheckpoint() {
    let checkpoint;
    try { checkpoint = JSON.parse(readFileSync(this.checkpointPath, "utf8")); } catch (cause) {
      const error = new Error("checkpoint is missing or malformed", { cause });
      error.code = "M6_DSH_CHECKPOINT_INVALID";
      throw error;
    }
    if (checkpoint.schemaId !== "xw.dsh-replay-checkpoint.v1"
      || checkpoint.workerRunRef !== this.workerRunRef
      || checkpoint.journalSeq > this.entries.length
      || checkpoint.journalHash !== sha256Json(this.entries.slice(0, checkpoint.journalSeq))
      || checkpoint.stateHash !== sha256Json(checkpoint.state)) {
      const error = new Error("checkpoint does not match the durable journal/state");
      error.code = "M6_DSH_JOURNAL_MISMATCH";
      throw error;
    }
    return checkpoint;
  }

  checkpoint(state) {
    const checkpoint = {
      schemaId: "xw.dsh-replay-checkpoint.v1",
      workerRunRef: this.workerRunRef,
      journalSeq: this.entries.length,
      journalHash: this.prefixHash(),
      stateHash: sha256Json(state),
      state,
    };
    const temporary = `${this.checkpointPath}.tmp`;
    writeFileSync(temporary, `${canonicalJson(checkpoint)}\n`, { flag: "w" });
    fsyncFile(temporary);
    renameSync(temporary, this.checkpointPath);
    fsyncFile(this.checkpointPath);
    return checkpoint;
  }
}
