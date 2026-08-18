import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAuthority } from "../authority.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("checkAuthority passes the imported platform checkout", () => {
  const report = checkAuthority(repoRoot);
  assert.equal(report.status, "PASS", report.blockers.join("\n"));
  assert.equal(report.runtimeCutoverAllowed, false);
  assert.ok(report.stateCount >= 8);
});

test("checkAuthority blocks a write-mode control.db open in orchestrator", () => {
  const dir = join(tmpdir(), `xw-auth-${Date.now()}`);
  mkdirSync(join(dir, "docs/architecture"), { recursive: true });
  mkdirSync(join(dir, "docs/fusion"), { recursive: true });
  mkdirSync(join(dir, "services/orchestrator"), { recursive: true });
  writeFileSync(join(dir, "docs/architecture/authority-boundary.v1.json"), readBoundary(), "utf8");
  writeFileSync(join(dir, "docs/fusion/source-lock.v1.json"), JSON.stringify({ runtimeCutoverAllowed: false }), "utf8");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true }), "utf8");
  writeFileSync(
    join(dir, "services/orchestrator/bad.mjs"),
    'import { DatabaseSync } from "node:sqlite";\nnew DatabaseSync("C:\\\\x\\\\control.db");\n',
    "utf8",
  );
  const report = checkAuthority(dir);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(report.status, "BLOCK");
  assert.ok(report.blockers.some((b) => b.includes("readOnly")));
});

test("cli authority emits PASS JSON", () => {
  const cli = join(repoRoot, "tools/fusion/cli.mjs");
  const r = spawnSync(process.execPath, [cli, "authority", repoRoot], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const json = JSON.parse(r.stdout.trim().split("\n").at(-1));
  assert.equal(json.subcommand, "authority");
  assert.equal(json.status, "PASS");
});

function readBoundary() {
  return JSON.stringify({
    schemaId: "xhs.platform.authority-boundary.v1",
    runtimeCutoverAllowed: false,
    runtimeCutoverGate: "CLOSED",
    states: [
      { canonicalState: "knowledge base", authoritativeOwner: "orchestrator" },
      { canonicalState: "approval decisions", authoritativeOwner: "controlPlane" },
    ],
  });
}
