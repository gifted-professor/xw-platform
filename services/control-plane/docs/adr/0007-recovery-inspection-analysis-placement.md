# ADR-0007: Split Recovery Inspection Capture and Visual Analysis

## Status

Proposed

## Context

An alias-02 Xianyu `full_dry_run` exceeded its 360 second adapter timeout and
entered `recovery_required`. The audited recovery entry point worked as
designed, but the adapter returned only `ok: false`. The durable run therefore
cannot distinguish a publish composer, discard dialog, image picker, SKU sheet,
safe main page, or an unknown page.

Recovery inspection must improve diagnosis without weakening the existing
control-plane boundary:

- every phone request must use a public `kind=recovery` lease;
- inspection must not tap, navigate, save, publish, or clear quarantine;
- the screenshot hash, normalized observation, and analysis must be bound to
  the original run;
- a low-confidence or unavailable analyzer must fail closed;
- screenshot-to-classification p95 should remain at or below five seconds;
- page classification must be reproducible from a versioned JSON contract.

The existing Visual Grounding POC combines OmniParser with macOS Vision OCR.
On the validated Mac path, the alias-02 sample has a 1.281 second hot path and
the baseline sample has a 1.503 second hot path. The Windows authority currently
has Python 3.11 but does not have torch, ultralytics, PaddleOCR, or a validated
replacement for macOS Vision OCR.

## Decision

Use a split pipeline for the first production candidate:

1. The Windows control plane owns recovery-inspection authorization, capture,
   SHA-256 calculation, and durable evidence attachment to the original run.
2. The Mac Visual Grounding worker remains the default analyzer because it is
   the only backend with measured coordinate and OCR acceptance evidence.
3. Analyzer output uses a versioned, backend-neutral JSON envelope. It contains
   the source image SHA-256 and resolution, analyzer identity and timings,
   normalized elements, and a fail-closed Xianyu page classification.
4. Page classification is a deterministic local function over the normalized
   element table and optional semantic nodes. It never emits an executable tap.
5. A result is usable only when its image SHA-256 matches the Windows capture.
   Missing analysis, hash mismatch, multiple page candidates, or insufficient
   page fingerprint returns `unknown` and leaves the device quarantined.
6. The inspection API and CLI are read-only. Recovery actions remain a separate
   human-reviewed step and require a fresh pre-action screenshot.

Performance gates for the initial path:

- visual analysis hot-path p95: at most 3 seconds;
- capture, transfer, and analysis end-to-end p95: at most 5 seconds;
- classifier time: at most 50 milliseconds;
- required page fingerprints: no false `main-safe` on the acceptance corpus;
- image hash equality: mandatory, with no override.

The Windows authority may become the default analyzer later only if a Windows
backend runs the same versioned acceptance corpus with no accuracy regression
and a lower measured p95. Deployment convenience alone is not sufficient.

The normalized envelope is generated without embedding local filesystem paths:

```bash
node scripts/build-recovery-analysis.mjs \
  --image recovery-inspect.png \
  --elements recovery-inspect.elements.json \
  > recovery-analysis.json
```

The authority accepts the envelope only when `image.sha256` equals the audited
screenshot evidence hash. It recomputes the page classification from normalized
elements instead of trusting a caller-supplied page label.

## Consequences

### Positive

- The trusted Windows authority remains the sole device-operation and evidence
  authority.
- The first implementation reuses the only analyzer with measured accuracy.
- A backend-neutral contract allows later Windows, GPU, or service-side
  analyzers without changing recovery policy.
- Analyzer unavailability degrades to durable capture plus `unknown`, not an
  unsafe recovery attempt.

### Negative

- The initial path includes one screenshot transfer from Windows to Mac.
- The Mac analyzer must be available for full visual classification.
- Capture and analysis are separate stages and require image-hash binding.

### Neutral

- Semantic UI nodes may provide an immediate hint, but they are not sufficient
  to verify `main-safe` when the visual fingerprint is absent.
- The first inspection does not clear alias-02 quarantine even if it observes a
  safe-looking page.

## Alternatives Considered

### Run the current POC directly on Windows

Rejected for the initial path. Windows lacks the installed model stack and the
POC depends on macOS Vision OCR. Replacing OCR before measuring the same corpus
would optimize topology at the expense of accuracy.

### Return screenshots only and classify informally

Rejected. Human or model prose without a versioned element table, page type,
confidence, reasons, and source hash cannot be replayed or audited reliably.

### Let a vision model return raw coordinates and recover immediately

Rejected. The current acceptance contract prohibits raw model coordinates, and
the control layer has not reached the required consecutive-action sample size.

## Failure Modes

| Failure | Result |
|---|---|
| Capture fails | inspection fails, lease releases, quarantine remains |
| Evidence attachment fails | inspection fails, quarantine remains |
| Mac analyzer unavailable | screenshot remains durable; page=`unknown` |
| Source hash mismatch | analysis rejected; quarantine remains |
| Multiple/weak fingerprints | page=`unknown`; no action |
| Stale analysis before action | mandatory fresh screenshot prevents reuse |

## References

- `docs/adr/0001-windows-authority-and-ssh-cli.md`
- `docs/adr/0003-durable-state-and-evidence.md`
- `docs/plans/2026-07-26-xianyu-phase-b-business-acceptance.md`
- `/Users/a1234/Desktop/Coding/visual-grounding-poc/ACCEPTANCE.md`
- `/Users/a1234/Desktop/Coding/visual-grounding-poc/L1-FINDINGS.md`
