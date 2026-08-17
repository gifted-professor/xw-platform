// M0 renderer. Produces the public acceptance-report Markdown from dossier JSONs.
// Markdown is NOT a source of truth — it is a projection of the JSON. The CLI's
// `render` subcommand writes to a temp dir and byte-compares against the committed
// acceptance-report.md to prove the projection is reproducible.
//
// Rendering is deterministic: objects are ordered by schemaId then by a stable
// key; each object becomes a heading + a sorted key/value table. No timestamps or
// other volatile content are injected here (capturedAt comes from the JSONs).

const TITLES = {
  "xhs.m0.baseline-identity.v1": "Baseline Identity",
  "xhs.m0.runtime-attestation.v1": "Runtime Attestation",
  "xhs.m0.state-ownership.v1": "State Ownership",
  "xhs.m0.known-debt.v1": "Known Debt Register",
  "xhs.m0.inventory-coverage.v1": "Inventory Coverage",
  "xhs.m0.inventory.v1": "Inventory",
  "xhs.m0.pr-assets.v1": "PR Public Assets",
  "xhs.m0.test-baseline.v1": "Test Baseline",
  "xhs.m0.private-evidence.v1": "Private Evidence",
  "xhs.m0.dossier-manifest.v1": "Dossier Manifest",
  "xhs.m0.file-manifest.v1": "File Manifest",
};

/**
 * Render an array of dossier objects into a Markdown acceptance report.
 * @param {{schemaId:string}[]} objects
 * @param {{baselineId?:string}} [opts]
 * @returns {string}
 */
export function renderToMarkdown(objects, opts = {}) {
  const baselineId = opts.baselineId
    || objects.find((o) => o.baselineId)?.baselineId
    || "(unknown baseline)";
  const lines = [];
  lines.push(`# M0 Acceptance Report — ${baselineId}`);
  lines.push("");
  lines.push("> This Markdown is a projection of the dossier JSONs. The JSONs are the source of truth; this report is not.");
  lines.push("");

  const ordered = objects.slice().sort((a, b) => {
    const ta = TITLES[a.schemaId] || a.schemaId;
    const tb = TITLES[b.schemaId] || b.schemaId;
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });

  for (const obj of ordered) {
    const title = TITLES[obj.schemaId] || obj.schemaId;
    lines.push(`## ${title}`);
    lines.push("");
    renderObject(obj, lines, 0);
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "") + "\n";
}

function renderObject(obj, lines, depth) {
  if (obj === null || typeof obj !== "object") {
    lines.push(formatScalar(obj));
    return;
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) { lines.push("_(empty)_"); return; }
    const allObjects = obj.every((x) => x && typeof x === "object" && !Array.isArray(x));
    if (allObjects) {
      for (let i = 0; i < obj.length; i++) {
        lines.push(`### [${i + 1}]`);
        lines.push("");
        renderObject(obj[i], lines, depth + 1);
        lines.push("");
      }
    } else {
      for (const item of obj) lines.push(`- ${inline(item, depth + 1)}`);
    }
    return;
  }
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    if (v !== null && typeof v === "object") {
      const isArrayOfObjects = Array.isArray(v) && v.length && v.every((x) => x && typeof x === "object" && !Array.isArray(x));
      if (isArrayOfObjects) {
        lines.push(`- **${k}**:`);
        lines.push("");
        // delegate to the array renderer so each entry gets a ### [n] heading
        renderObject(v, lines, depth + 1);
        lines.push("");
      } else if (Array.isArray(v)) {
        lines.push(`- **${k}**: ${inline(v, depth + 2)}`);
      } else {
        lines.push(`- **${k}**: ${inline(v, depth + 2)}`);
      }
    } else {
      lines.push(`- **${k}**: ${formatScalar(v)}`);
    }
  }
}

function inline(v, depth) {
  if (v === null || typeof v !== "object") return formatScalar(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return "[" + v.map((x) => inline(x, depth + 1)).join(", ") + "]";
  }
  const pairs = Object.keys(v).sort().map((k) => `${k}=${inline(v[k], depth + 1)}`);
  return "{ " + pairs.join("; ") + " }";
}

function formatScalar(v) {
  if (v === null) return "_(null)_";
  if (typeof v === "string") return "`" + v + "`";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "`" + JSON.stringify(v) + "`";
}

/** Render every *.json in a directory (excluding the manifest's own self-listing).
 *  @param {string} dir
 *  @param {{baselineId?:string}} [opts]
 */
export async function renderDir(dir, opts) {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const objects = files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
  return renderToMarkdown(objects, opts);
}