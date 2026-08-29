# M6-4 P5 strict-fixed qualification and assembler entry

The production chain has three fixed entries. Run each command from the exact formal release that contains it:

```text
npm run m6-4:provision-secrets-fixed
npm run m6-4:qualification-execute-fixed
npm run m6-4:assemble-current-fixed
```

Secret provision accepts zero arguments. It binds to the executing operator's own formal-release manifest under
`C:\Users\Public\xw-runtime\releases`, not to the legacy `current` pointer. With no private files it generates the
account binding and internal authorities from the OS CSPRNG and consumes only the process `DEEPSEEK_API_KEY`.
With both private files present it verifies and adopts them for crash replay; a one-file partial state blocks. Its
child process receives only a minimal Windows environment plus the two required provisioning values. Public output
contains only `schemaId`, `status`, and `receiptHash`.

Qualification accepts exactly the fixed `execute-fixed` verb and no other argument. It resolves the exact current
release from `current`, then requires the runtime binding, the sole signed bootstrap package, and the sole matching
operator receipt to reproduce that same release/source identity and an exact zero-resource CLOSED state. It runs
target-environment qualification, runtime-dependency materialization, and sealed live-model qualification in that
order, revalidating the same identity between stages. All roots and hashes are derived from the fixed runtime and
content-addressed stores. The resulting operation receipt includes the exact `releaseId` and `sourceCommit` in its
`operationHash` domain and is published create-only below the source-pinned audit root.

Assembler accepts zero arguments. It loads the sole current-release qualification operation receipt and the private
account binding internally, then directly invokes the tracked fresh builder. No path, endpoint, token, model, alias,
account binding, or qualification hash crosses argv. Public output contains release/source plus receipt/authority
hashes only.

Release A and release B must each complete their own full qualification and assembler cycle. After B's package,
quiescence/rotation, launcher, and `current` transition are established, run qualification and assembler again from
B. An A receipt lives under A's source-pinned root and cannot satisfy B; current/binding/package/receipt drift fails
closed rather than silently reusing A evidence.

Each legacy-window prestate seals five fixed resource classes: control DB, registry DB, the qualification bootstrap
binding, secret environment, and digest keyring. Restore and every rollback path restore the exact captured binding
(or its exact absence) before restarting legacy. This keeps the restored DB fence and binding identity aligned, so a
second B rotation cannot observe the old fence with A's leftover binding.

The caller-parameterized `m6-4-production-assembler-input-builder.mjs`, the bare target/dependency/model CLIs, and
`m6-4-production-release-assembler.mjs --input ABS.json` remain offline/test compatibility surfaces. They are not P5
production runbook entries.

## Gate-F FINAL launcher validation

`prepare-target-fixed` is static preparation evidence, not the parent plan's
required launcher execution: it verifies the staged binding and returns
`active=false`, but it does not run the content-addressed PowerShell body or
the FINAL runtime-entry delegate. After legacy bootstrap activates A, and
after every authorized apply activates its target, run from that exact active
formal release:

```text
node services/control-plane/ops/gate-f-cutover-operator.mjs validate-final-fixed <releaseId> <sourceCommit>
```

The command accepts only release/source identity—never a launcher, binding,
root, path, endpoint, token, PID, or option. It derives the fixed target
reference and active tuple, re-verifies current plus active runtime bindings,
then executes exactly the tuple's `launchers/<sha256>/launch-control-plane.ps1`
with `-Mode FINAL -ValidateOnly`. Public output is a release-bound hash receipt
and excludes paths and private material.

Do not authorize the next transition until the active release returns
`status=VALIDATED`. The mechanical drill is therefore: legacy→A, validate A,
A→B, validate B, B→A, validate A, A→B, validate final B. This places an actual
FINAL validation before each subsequent task-owned restart and verifies the
final re-forward identity as well.
