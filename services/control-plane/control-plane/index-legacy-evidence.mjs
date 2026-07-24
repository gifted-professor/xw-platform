import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ControlPlaneError, errorBody } from "./lib/errors.mjs";

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function filesUnder(root, maxFiles) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) stack.push(path);
      else if (info.isFile()) {
        files.push(path);
        if (files.length > maxFiles) {
          throw new ControlPlaneError("LEGACY_INDEX_TOO_LARGE", `source exceeds ${maxFiles} files`);
        }
      }
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

export async function indexLegacyEvidence({
  source,
  output,
  dryRun = false,
  maxFiles = 200000,
} = {}) {
  if (!source || !output) throw new ControlPlaneError("INDEX_PATH_REQUIRED", "source and output are required");
  if (!isAbsolute(source) || !isAbsolute(output)) {
    throw new ControlPlaneError("INDEX_PATH_NOT_ABSOLUTE", "source and output must be absolute paths");
  }
  const sourceRoot = resolve(source);
  const outputPath = resolve(output);
  if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
    throw new ControlPlaneError("INDEX_SOURCE_MISSING", "legacy evidence source is not a directory", { status: 404 });
  }
  const root = resolve(sourceRoot, "..");
  if (sourceRoot === root) throw new ControlPlaneError("INDEX_SOURCE_UNSAFE", "filesystem root cannot be indexed");
  if (outputPath === sourceRoot || outputPath.startsWith(`${sourceRoot}/`) || outputPath.startsWith(`${sourceRoot}\\`)) {
    throw new ControlPlaneError("INDEX_OUTPUT_INSIDE_SOURCE", "output must be outside the legacy source");
  }
  const files = filesUnder(sourceRoot, maxFiles);
  let totalBytes = 0;
  const records = [];
  for (const path of files) {
    const info = statSync(path);
    totalBytes += info.size;
    if (!dryRun) {
      records.push({
        relativePath: relative(sourceRoot, path),
        bytes: info.size,
        modifiedAt: info.mtime.toISOString(),
        sha256: await sha256File(path),
      });
    }
  }
  const summary = {
    schemaVersion: 1,
    sourceRoot,
    files: files.length,
    totalBytes,
    copiedFiles: 0,
    dryRun,
    indexedAt: new Date().toISOString(),
  };
  if (!dryRun) {
    mkdirSync(dirname(outputPath), { recursive: true });
    const temporary = `${outputPath}.${process.pid}.tmp`;
    const lines = [
      JSON.stringify({ type: "summary", ...summary }),
      ...records.map((record) => JSON.stringify({ type: "file", ...record })),
    ];
    writeFileSync(temporary, `${lines.join("\n")}\n`, { mode: 0o600 });
    renameSync(temporary, outputPath);
  }
  return summary;
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function main(argv = process.argv.slice(2)) {
  const result = await indexLegacyEvidence({
    source: option(argv, "--source"),
    output: option(argv, "--output"),
    dryRun: argv.includes("--dry-run"),
    maxFiles: Number(option(argv, "--max-files") || 200000),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify(errorBody(error), null, 2));
    process.exitCode = 1;
  });
}
