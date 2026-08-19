// M3-R1 统一 release identity：两个服务的 health 共用同一条加载链。
// 优先级：env XW_RELEASE_MANIFEST 指定的 manifest 文件
//   > 从 startDir 向上查找 release-manifest.v1.json
//   > 旧行为兜底（CONTROL_PLANE_RELEASE_ID）
//   > 全部 null。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";

import { RELEASE_MANIFEST_FILENAME, RELEASE_MANIFEST_SCHEMA_ID } from "./release-manifest.mjs";

function identityFromManifest(manifest) {
  return {
    sourceRepo: manifest.sourceRepo ?? null,
    sourceCommit: manifest.sourceCommit ?? null,
    releaseId: manifest.releaseId ?? null,
    runtimeProfile: manifest.runtimeProfile ?? null,
  };
}

function readManifest(file) {
  try {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    return manifest && manifest.schemaId === RELEASE_MANIFEST_SCHEMA_ID ? manifest : null;
  } catch {
    return null;
  }
}

function findUpward(startDir) {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, RELEASE_MANIFEST_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir || dir === parse(dir).root) return null;
    dir = parent;
  }
}

export function loadReleaseIdentity({ startDir = process.cwd(), env = process.env } = {}) {
  const fromEnv = env.XW_RELEASE_MANIFEST ? readManifest(env.XW_RELEASE_MANIFEST) : null;
  if (fromEnv) return identityFromManifest(fromEnv);
  if (startDir) {
    const found = findUpward(startDir);
    const manifest = found ? readManifest(found) : null;
    if (manifest) return identityFromManifest(manifest);
  }
  return {
    sourceRepo: null,
    sourceCommit: null,
    releaseId: env.CONTROL_PLANE_RELEASE_ID ?? null,
    runtimeProfile: null,
  };
}
