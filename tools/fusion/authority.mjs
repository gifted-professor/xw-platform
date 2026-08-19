import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const CODE_EXT = new Set([".mjs", ".js", ".cjs"]);

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function walkFiles(root, out = []) {
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".git" || name === "tests" || name === "test") continue;
      walkFiles(p, out);
    } else if (CODE_EXT.has(extname(name))) {
      out.push(p);
    }
  }
  return out;
}

function nearbyIncludes(text, token, needle, window = 240) {
  let from = 0;
  while (from < text.length) {
    const i = text.indexOf(token, from);
    if (i < 0) break;
    const slice = text.slice(Math.max(0, i - window), i + token.length + window);
    if (slice.includes(needle)) return true;
    from = i + token.length;
  }
  return false;
}

export function checkAuthority(root) {
  const blockers = [];
  const findings = [];
  const boundaryPath = join(root, "docs/architecture/authority-boundary.v1.json");
  const lockPath = join(root, "docs/fusion/source-lock.v1.json");
  const pkgPath = join(root, "package.json");

  if (!existsSync(boundaryPath)) {
    return { status: "BLOCK", runtimeCutoverAllowed: false, blockers: ["missing authority-boundary.v1.json"], findings };
  }

  const boundary = loadJson(boundaryPath);
  if (boundary.runtimeCutoverAllowed !== false) blockers.push("authority-boundary.runtimeCutoverAllowed must be false");
  if (boundary.runtimeCutoverGate !== "CLOSED") blockers.push("authority-boundary.runtimeCutoverGate must be CLOSED");
  if (!Array.isArray(boundary.states) || boundary.states.length === 0) {
    blockers.push("authority-boundary.states missing");
  }

  const owners = new Map();
  for (const state of boundary.states || []) {
    if (!state.canonicalState || !state.authoritativeOwner) {
      blockers.push("state missing canonicalState or authoritativeOwner");
      continue;
    }
    if (owners.has(state.canonicalState) && owners.get(state.canonicalState) !== state.authoritativeOwner) {
      blockers.push(`dual authority for ${state.canonicalState}`);
    }
    owners.set(state.canonicalState, state.authoritativeOwner);
  }

  if (existsSync(lockPath)) {
    const lock = loadJson(lockPath);
    if (lock.runtimeCutoverAllowed !== false) blockers.push("source-lock.runtimeCutoverAllowed must be false");
  } else {
    blockers.push("missing source-lock.v1.json");
  }

  if (existsSync(pkgPath)) {
    const pkg = loadJson(pkgPath);
    if (pkg.workspaces) blockers.push("root package.json must not enable npm workspaces");
  }

  const orchFiles = walkFiles(join(root, "services/orchestrator"));
  for (const file of orchFiles) {
    const text = readFileSync(file, "utf8");
    if (text.includes("control.db") && text.includes("DatabaseSync") && !nearbyIncludes(text, "DatabaseSync", "readOnly")) {
      blockers.push(`orchestrator opens control.db without readOnly: ${file}`);
      findings.push({ id: "orch-no-write-control-db", file, ok: false });
    }
  }

  for (const rel of ["packages/control-client", "packages/cli", "packages/agent-gateway"]) {
    for (const file of walkFiles(join(root, rel))) {
      const text = readFileSync(file, "utf8");
      if (text.includes("control.db") || text.includes("DatabaseSync") || text.includes(":22222") || text.includes("adb ")) {
        blockers.push(`upper layer must not touch control.db/ADB/22222: ${file}`);
      }
    }
  }

  const cpFiles = walkFiles(join(root, "services/control-plane"));
  for (const file of cpFiles) {
    const text = readFileSync(file, "utf8");
    if (text.includes("registry.db")) {
      blockers.push(`control-plane references registry.db: ${file}`);
      findings.push({ id: "cp-no-registry-db", file, ok: false });
    }
  }

  return {
    status: blockers.length ? "BLOCK" : "PASS",
    runtimeCutoverAllowed: false,
    sourceFusionGate: "OPEN",
    runtimeCutoverGate: "CLOSED",
    stateCount: (boundary.states || []).length,
    uniqueOwners: [...new Set(owners.values())],
    blockers,
    findings,
  };
}
