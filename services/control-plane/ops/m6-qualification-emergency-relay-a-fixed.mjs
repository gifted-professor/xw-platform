import { executeM6QualificationFinalRelay } from "./m6-qualification-legacy-window-operator.mjs";

const RUNTIME_ROOT = "C:\\Users\\Public\\xw-runtime";
const RELEASE_ID = "xw-xhs-v3-r03-db6538dd9a50";
const SOURCE_COMMIT = "db6538dd9a50daa3fd42ee9141c258e10f6ec3d1";
const ASSEMBLER_RECEIPT_HASH =
  "112b96e3f997467200625b3fc7687601904bc3918d4d40e312a0b8a56342262f";
const RELEASE_OPERATOR_PATH = `${RUNTIME_ROOT}\\releases\\${RELEASE_ID}`
  + "\\services\\control-plane\\ops\\m6-qualification-legacy-window-operator.mjs";

// One-shot emergency bootstrap approved by the owner on 2026-08-31. The
// reviewed/pushed takeover implementation runs from commit a30385d while all
// target identity, topology, database, Gate-F, rollback and receipt checks stay
// bound to immutable Release A. Only the executable-location assertion is
// represented by Release A's exact operator path.
if (process.argv.length !== 2) {
  process.stderr.write("M6_QUALIFICATION_EMERGENCY_ARGUMENT_FORBIDDEN\n");
  process.exitCode = 2;
} else {
  executeM6QualificationFinalRelay({
    runtimeRoot: RUNTIME_ROOT,
    expectedReleaseId: RELEASE_ID,
    expectedSourceCommit: SOURCE_COMMIT,
    assemblerReceiptHash: ASSEMBLER_RECEIPT_HASH,
    executingOperatorPath: RELEASE_OPERATOR_PATH,
  }).then((receipt) => {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      code: error?.code || "M6_QUALIFICATION_EMERGENCY_RELAY_FAILED",
      message: error?.message || "emergency relay failed",
      causeCode: error?.causeCode || null,
      rollbackCode: error?.rollbackCode || null,
      receiptHash: error?.receiptHash || null,
      receiptRef: error?.receiptRef || null,
    })}\n`);
    process.exitCode = 1;
  });
}
