import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const roots = ["scripts", "control-plane", "apps", "tests"];
const files = [];

function walk(path) {
  for (const name of readdirSync(path)) {
    if (name === "node_modules" || name === "runtime") continue;
    const full = join(path, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name.endsWith(".mjs")) files.push(full);
  }
}

for (const name of roots) {
  try {
    walk(join(root, name));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(`${relative(root, file)}\n${result.stderr || result.stdout}`);
    process.exit(result.status || 1);
  }
}

console.log(JSON.stringify({ ok: true, checked: files.length }));
