import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const xwPath = join(dirname(fileURLToPath(import.meta.url)), "../xw.mjs");

function parseLastJson(stdout) {
  const line = stdout.trim().split("\n").at(-1);
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function run(args, { cwd } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [xwPath, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, json: parseLastJson(stdout) };
  } catch (error) {
    return { code: error.status ?? 1, json: parseLastJson(error.stdout?.toString() ?? "") };
  }
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "xw-cutover-repo-"));
  const git = (args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.email", "cutover@test.invalid"]);
  git(["config", "user.name", "cutover-test"]);
  mkdirSync(join(root, "services/orchestrator"), { recursive: true });
  mkdirSync(join(root, "services/control-plane/control-plane"), { recursive: true });
  mkdirSync(join(root, "packages/kernel"), { recursive: true });
  writeFileSync(join(root, "services/orchestrator/registry.mjs"), "// orchestrator entry\n");
  writeFileSync(join(root, "services/control-plane/control-plane/router.mjs"), "// control-plane entry\n");
  writeFileSync(join(root, "packages/kernel/keep.mjs"), "// kernel\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  return root;
}

test("cutover preflight：无 --release 时离线预检通过", () => {
  const { code, json } = run(["cutover", "preflight", "--json"]);
  assert.equal(code, 0);
  assert.equal(json.ok, true);
  assert.ok(json.checks.find((c) => c.id === "node-major>=20")?.ok);
  assert.ok(json.checks.find((c) => c.id === "runtime-profile:loadable")?.ok);
  assert.ok(json.checks.find((c) => c.id === "runtimeCutoverAllowed:false")?.ok);
});

test("cutover collect：输出本机离线事实", () => {
  const { code, json } = run(["cutover", "collect", "--json"]);
  assert.equal(code, 0);
  assert.equal(json.ok, true);
  assert.ok(json.nodeVersion);
  assert.ok(json.platform);
  assert.equal(json.runtimeCutoverAllowed, false);
});

test("cutover package → verify → preflight 全链路", (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outDir = mkdtempSync(join(tmpdir(), "xw-cutover-out-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));

  const packaged = run(["cutover", "package", "--out", outDir, "--release-id", "xw-cli-test", "--json"], { cwd: root });
  assert.equal(packaged.code, 0);
  assert.equal(packaged.json.ok, true);
  assert.equal(packaged.json.releaseId, "xw-cli-test");

  const releaseDir = join(outDir, "releases", "xw-cli-test");
  const verified = run(["cutover", "verify", "--release", releaseDir, "--json"]);
  assert.equal(verified.code, 0);
  assert.equal(verified.json.ok, true);

  const preflight = run(["cutover", "preflight", "--release", releaseDir, "--json"]);
  assert.equal(preflight.code, 0);
  assert.equal(preflight.json.ok, true);
});

test("cutover preflight：release 被篡改时 exit 1", (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outDir = mkdtempSync(join(tmpdir(), "xw-cutover-out-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));

  run(["cutover", "package", "--out", outDir, "--release-id", "xw-cli-bad", "--json"], { cwd: root });
  const releaseDir = join(outDir, "releases", "xw-cli-bad");
  writeFileSync(join(releaseDir, "services/orchestrator/registry.mjs"), "// tampered\n");

  const { code, json } = run(["cutover", "preflight", "--release", releaseDir, "--json"]);
  assert.equal(code, 1);
  assert.equal(json.ok, false);
  assert.equal(json.checks.find((c) => c.id === "release:manifest-verify")?.ok, false);
});

test("cutover verify：缺 --release 报用法错误；未知子命令 exit 2", () => {
  assert.equal(run(["cutover", "verify"]).code, 2);
  assert.equal(run(["cutover", "deploy"]).code, 2);
});

test("cutover --help 声明未实现的现场子命令", () => {
  const { code } = run(["cutover", "--help"]);
  assert.equal(code, 0);
  const help = execFileSync(process.execPath, [xwPath, "cutover", "--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  // usage 走 stderr
  const stderr = (() => {
    try {
      execFileSync(process.execPath, [xwPath, "cutover"], { encoding: "utf8" });
      return "";
    } catch (error) {
      return error.stderr?.toString() ?? "";
    }
  })();
  // M3-R3 已实现 shadow / tasks / canary --dry-run；仍未实现的只有后续阶段的现场切换命令
  assert.match(stderr, /canary 真实执行 \/ promote \/ closeout \/ deploy/);
  assert.match(stderr, /cutover rehearse/);
  assert.match(stderr, /cutover shadow/);
  assert.match(stderr, /cutover canary --dry-run/);
  assert.equal(help, "");
});
