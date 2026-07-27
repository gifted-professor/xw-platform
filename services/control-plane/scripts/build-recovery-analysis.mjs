import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function option(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

export function buildRecoveryAnalysis({
  imagePath,
  elementsDocument,
  analyzerName = "visual-grounding-poc",
  analyzerVersion = "2026-07-26",
} = {}) {
  if (!imagePath) throw new TypeError("imagePath is required");
  if (!elementsDocument || !Array.isArray(elementsDocument.elements)) {
    throw new TypeError("elementsDocument.elements must be an array");
  }
  if (!Array.isArray(elementsDocument.resolution) || elementsDocument.resolution.length !== 2) {
    throw new TypeError("elementsDocument.resolution must be [width,height]");
  }
  const image = readFileSync(imagePath);
  return {
    schemaVersion: "xhs.visual-elements.v1",
    image: {
      sha256: createHash("sha256").update(image).digest("hex"),
      bytes: statSync(imagePath).size,
      resolution: elementsDocument.resolution.map(Number),
    },
    analyzer: {
      name: analyzerName,
      version: analyzerVersion,
      timings: elementsDocument.timings || {},
    },
    elements: elementsDocument.elements,
  };
}

async function main(argv = process.argv.slice(2)) {
  const imagePath = option(argv, "--image");
  const elementsPath = option(argv, "--elements");
  if (!imagePath || !elementsPath) {
    throw new Error("usage: node scripts/build-recovery-analysis.mjs --image screenshot.png --elements elements.json");
  }
  const elementsDocument = JSON.parse(readFileSync(elementsPath, "utf8"));
  const envelope = buildRecoveryAnalysis({
    imagePath,
    elementsDocument,
    analyzerName: option(argv, "--analyzer", "visual-grounding-poc"),
    analyzerVersion: option(argv, "--version", "2026-07-26"),
  });
  const serialized = `${JSON.stringify(envelope)}\n`;
  const outputPath = option(argv, "--output");
  if (outputPath) {
    writeFileSync(outputPath, serialized, { encoding: "utf8", mode: 0o600 });
  } else {
    process.stdout.write(serialized);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  });
}
