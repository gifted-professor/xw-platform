/**
 * Foundation PR3: Adapter import lint (INV-08).
 * Production adapters under apps/<app>/adapter.mjs must not statically import raw device channels.
 * Composition roots (bootstrap) may construct transports and inject them.
 *
 * Usage: node scripts/check-adapter-imports.mjs
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appsRoot = join(root, "apps");

const FORBIDDEN = [
  { re: /from\s+["'].*gateway-operator\.mjs["']/, id: "gateway-operator-static-import" },
  { re: /from\s+["'].*xiaowei-transport\.mjs["']/, id: "xiaowei-transport-static-import" },
  { re: /from\s+["']node:child_process["']/, id: "child_process-static-import" },
  { re: /new\s+XiaoweiTransport\s*\(/, id: "ambient-xiaowei-transport-construct" },
  { re: /new\s+GatewayOperator\s*\(/, id: "ambient-gateway-operator-construct" },
];

const findings = [];
if (existsSync(appsRoot)) {
  for (const app of readdirSync(appsRoot, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const adapterPath = join(appsRoot, app.name, "adapter.mjs");
    if (!existsSync(adapterPath)) continue;
    const src = readFileSync(adapterPath, "utf8");
    for (const rule of FORBIDDEN) {
      if (rule.re.test(src)) {
        findings.push({ file: `apps/${app.name}/adapter.mjs`, rule: rule.id });
      }
    }
  }
}

if (findings.length) {
  console.log(JSON.stringify({ ok: false, findings }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  ok: true,
  checked: "apps/<app>/adapter.mjs",
  forbiddenRules: FORBIDDEN.map((f) => f.id),
}));
