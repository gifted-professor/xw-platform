import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const roots = [
  ...["scripts", "control-plane", "apps", "config", "docs", "ops"]
    .map((name) => join(root, name)),
  join(repoRoot, "services", "orchestrator", "ops"),
  join(repoRoot, "services", "orchestrator", "providers"),
  join(repoRoot, "services", "orchestrator", "scripts", "lib"),
  join(repoRoot, "services", "orchestrator", "contracts"),
  join(repoRoot, "tools", "m6"),
  join(repoRoot, "artifacts", "m6-4", "trust-roots"),
  join(repoRoot, "packages", "kernel", "contracts"),
];
const extensions = new Set([
  ".mjs", ".js", ".json", ".md", ".ps1", ".bat", ".py", ".yaml", ".yml",
]);
const patterns = [
  { name: "private key", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  {
    name: "provider token",
    regex: /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_-]{16,})\b/,
  },
  {
    name: "literal API key assignment",
    regex: /\b(?:API|LLM|VISION|ACCESS|AUTH)[_-]?KEY\s*=\s*["'][^"'$]{4,}["']/i,
  },
];
const findings = [];

function walk(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (["node_modules", "runtime", ".git"].includes(entry.name)) continue;
    if (/\.(?:test|spec)\.(?:mjs|js)$/u.test(entry.name)) continue;
    const full = join(path, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (extensions.has(extname(entry.name)) && statSync(full).size <= 2 * 1024 * 1024) {
      const content = readFileSync(full, "utf8");
      for (const pattern of patterns) {
        if (pattern.regex.test(content)) findings.push({ file: relative(root, full), pattern: pattern.name });
      }
    }
  }
}

for (const path of roots) {
  if (existsSync(path)) walk(path);
}
if (findings.length > 0) {
  console.error(JSON.stringify({ ok: false, findings }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, secretScan: "passed" }));
}
