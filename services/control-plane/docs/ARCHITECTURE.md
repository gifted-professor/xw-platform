# Architecture

## Execution layers

1. **Deterministic ADB layer**: launches packages, dumps UI hierarchy, captures screenshots, taps semantic bounds and reads device properties.
2. **Per-device page map**: stores model, Android/app version, visible controls, bounds and the last verified page type.
3. **Cloud vision fallback**: classifies screenshots only when the UI hierarchy is insufficient. It proposes an action but never executes it.
4. **Agent orchestrator**: Hermes or Codex selects the next safe state transition, verifies the result and records failures.
5. **Asset sink**: local CSV/JSON and optional Feishu Base synchronization.

## Page state strategy

- `HOME_FEED`: verify bottom navigation before entering the profile.
- `PROFILE`: require both `小红书号` and profile metrics before accepting extraction.
- `IMAGE_NOTE`: scroll the content container; do not assume a video interaction model.
- `VIDEO_NOTE`: open the explicit comments control; scrolling the main surface may change videos.
- `COMMENT_PANEL`: browse only; close the panel before moving to another state.
- `UNKNOWN`: capture screenshot and hierarchy, call cloud vision once, then re-verify.
- `CHALLENGE_OR_LOGIN`: stop and request human handling.

All clicks should be derived from current node bounds. A normalized coordinate may be used only as a documented fallback for that specific device/version and must be followed by state verification.

## Failure policy

- First failure: refresh hierarchy and retry the semantic selector once.
- Second failure: capture evidence, stop that device and continue with other devices.
- Never loop blindly or continue from an unverified state.

