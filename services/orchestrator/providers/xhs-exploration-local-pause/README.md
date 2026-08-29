# XHS exploration local navigation provider

This is the pinned local provider used by the V3 vision evidence path. For an
explicitly bound page/role request it may emit exactly one generic navigation
candidate. Its offline calibration capability is the closed set required by
the five-route corpus: content-card open, comment-panel open, video pause, and
back. It does not understand or emit social actions, OCR text, arbitrary
labels, raw action commands, or tap authority.

Provider capability is intentionally separate from live authority. The
runtime mission/navigator allowlist remains only
`VIDEO_NOTE/PAUSE_VIDEO_SAFE_ZONE` for the first canary; being able to evaluate
the other route/role pairs offline cannot make them dispatchable live.

The implementation uses only the Python standard library. The pinned model is
`pause-zone-model.v1.json`, a strict rules model containing the closed search
region, candidate grid, edge thresholds, ambiguity margin, and confidence
bounds. Both frame and model SHA-256 bindings are verified again inside the
child before analysis.

`provider-bundle.v1.json` is the canonical P4A bundle manifest. Its exact
canonical bytes hash to `providerBundleDigest`
`d89214b50c500809cae5818c1338d43592e2f5396b81ea6655eeb097effc58af`.
It contains no mutable absolute paths; it transitively binds the exact
interpreter plus its complete non-system runtime search closure (`DLLs/**`,
`Lib/**`, and runtime-root DLL/files), `analyze.py`, model, process/result
protocols, route matrix, and analysis limits. The child runs with `-I -S`, a
fresh private pycache prefix, and no site packages; every spawn reproduces the
bundle and exact runtime file set before use. A changed or newly injected
stdlib module, `.pyd`, DLL, auxiliary data file, retune, protocol, or
non-canonical manifest representation creates drift or a new digest.
The user-profile interpreter is source material only. `pin`/`provision`
copies the verified closure create-only into
`C:\Program Files\XW Platform\providers\<providerBundleDigest>`, applies and
verifies a protected SYSTEM/Administrators-only DACL over the complete tree,
and writes config paths only to that private content-addressed namespace.
`verify` and production spawn never fall back to the source installation.
Deployment-only authority such as `shadow` versus `canary1`, release paths,
and the live permit allowlist are intentionally outside the provider bundle;
they remain separately sealed by the runtime config/mission/Control Plane, so
R2 and R3 can assert the same provider bundle without conflating capability
with authority.

The tracked operator exposes the three explicit phases: `stage` creates the
canonical manifest, `pin` creates a config bound to that manifest, and
`verify` re-hashes the complete closure. P5 owns any actual runtime-config
write; the P4A source tree does not self-install or self-enable.

Runtime invocation is owned by
`xhs-exploration-vision-process.mjs`:

```text
<pinned-python> analyze.py <private-staged-frame.png> -o <same-private-dir>/elements.json
```

Required environment bindings are `XW_VISION_MODEL_PATH`,
`XW_VISION_MODEL_SHA256`, `XW_VISION_FRAME_SHA256`, `XW_VISION_PAGE`, and
`XW_VISION_REQUESTED_ROLE`. A valid result follows
`xw.xhs.exploration-vision-process-result.v1`; ambiguity produces an empty
`elements` array and therefore tap=0. The historical model filename is kept
for pin-path compatibility even though the sealed rules now cover the offline
navigation corpus.

This source tree is provisionable but not self-enabling. Gate E still requires
independent real-corpus calibration (at least three distinct frames per
required route), shadow tap=0, and the one-shot live canary. Until those gates
pass, no production runtime config should point at this provider.

The historical machine-local visual-tap/PaddleOCR tree was inspected but is
not reused here. Repository inventory records it as external, unpinned, and
license-unverified; it also needs a multi-file dependency/model closure that
the current single-model-file pin does not represent.
