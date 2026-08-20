import { win32 } from "node:path";

/** Pinned production Node on the Windows control-plane host. */
export const DEFAULT_NODE_EXE = "D:\\Program Files\\Node\\node.exe";

export function resolveNodeExe(env = process.env) {
  const configured = String(env.XHS_NODE_EXE || "").trim();
  return configured || DEFAULT_NODE_EXE;
}

/**
 * Child-process env with XHS_NODE_EXE set and the pinned Node directory first on PATH.
 * Avoids Cursor/IDE bundled Node (v22) shadowing the control-plane Node (v24.11.1).
 */
export function buildChildEnv(baseEnv = process.env) {
  const nodeExe = resolveNodeExe(baseEnv);
  // 生产目标是 Windows control-plane 主机，显式 win32 语义保证在 POSIX CI 上同样成立。
  const nodeDir = win32.dirname(nodeExe);
  const pathKey = Object.keys(baseEnv).find((key) => key.toLowerCase() === "path") || "PATH";
  const currentPath = String(baseEnv[pathKey] || "");
  const segments = currentPath.split(";").filter(Boolean);
  const filtered = segments.filter((segment) => segment.toLowerCase() !== nodeDir.toLowerCase());
  return {
    ...baseEnv,
    XHS_NODE_EXE: nodeExe,
    [pathKey]: [nodeDir, ...filtered].join(";"),
  };
}
