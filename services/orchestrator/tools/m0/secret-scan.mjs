// M0 secret scanner. Pure text scanner — no network, no filesystem required
// (callers pass strings). Detects credential-like patterns that must NOT appear
// in public dossiers / PR diffs / new blobs / issue comments. Findings are returned,
// not thrown — the caller decides whether a finding blocks (per the M0 plan, the
// `.env.example` two feishu bitable ID candidates are known-debt, not blockers).

const PATTERNS = [
  // SSH private key blocks
  { id: "ssh_private_key", re: /-----BEGIN (?:RSA |OPENSSH |DSA |EC |)PRIVATE KEY-----/ },
  // age / X25519 recipient lines (age1...) — long enough to be a real key
  { id: "age_recipient", re: /\bage1[a-z0-9]{50,}\b/ },
  // Tailscale auth keys (tskey-auth-...) and machine keys (tskey-machine-...)
  { id: "tailscale_key", re: /\btskey-(?:auth|machine|client|api)-[A-Za-z0-9]{16,}\b/ },
  // Generic high-entropy tokens: 40+ hex prefixed by common token hints
  { id: "github_pat", re: /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/ },
  // Feishu app secret / tenant access token-ish: app secret typically 32 hex
  { id: "feishu_app_secret", re: /(?:app_secret|appSecret|APP_SECRET)["'\s:=]+([A-Fa-f0-9]{32}|[A-Za-z0-9_-]{32,})\b/ },
  // Authorization: Bearer <jwt-ish>
  { id: "bearer_token", re: /Bearer\s+[A-Za-z0-9._-]{20,}/ },
  // private API key assignments
  { id: "api_key_assign", re: /\b(?:api[_-]?key|apikey|API_KEY|secret|SECRET|token|TOKEN|password|PASSWORD)["'\s]*[:=]\s*["'][^"'\s]{16,}["']/ },
  // .env variable holding a concrete secret value (not .env.example placeholder)
  // heuristically: KEY=value where the name contains a secret-suffix and the value
  // is not empty/placeholder. Prefix before the suffix is optional so bare TOKEN= /
  // KEY= (suffix at position 0) match as well as API_KEY= / FEISHU_APP_SECRET=.
  // Unquoted values starting with '<' are treated as <placeholder> and skipped.
  { id: "env_secret_value", re: /\b((?:[A-Z][A-Z0-9_]*)?(?:SECRET|TOKEN|KEY|PASSWORD|PASSWD|PWD|AUTH)[A-Z0-9_]*)=(?:"([^"']{8,})"|([^\s#<][^\s#]{7,}))/ },
];

// Known, intentionally-listed candidates that are NOT secrets (recorded in
// known-debt, not blockers). Map by finding id + the literal matched substring.
const ALLOWLIST_EXACT = new Set([
  // .env.example feishu bitable IDs are candidate identifiers, not secrets —
  // but they look like long tokens. We exempt the specific known forms.
]);

/**
 * Scan one text string for secret-like patterns.
 * @param {string} text
 * @param {{path?: string}} [ctx]
 * @returns {{id:string, path?:string, line:number, snippet:string}[]}
 */
export function scanText(text, ctx = {}) {
  const lines = text.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const p of PATTERNS) {
      const m = p.re.exec(line);
      if (m) {
        const snippet = redact(line.trim());
        hits.push({ id: p.id, path: ctx.path, line: i + 1, snippet });
      }
    }
  }
  return hits;
}

/** Scan a map of {path: text}. Returns flattened findings. */
export function scanFiles(fileMap) {
  const all = [];
  for (const [path, text] of Object.entries(fileMap)) {
    all.push(...scanText(text, { path }));
  }
  return all;
}

// Redact the middle of a matched line so the snippet is safe to print/record.
function redact(line) {
  if (line.length <= 40) return line.slice(0, 8) + "…[redacted]";
  return line.slice(0, 12) + "…[redacted]…" + line.slice(-6);
}

export { PATTERNS };