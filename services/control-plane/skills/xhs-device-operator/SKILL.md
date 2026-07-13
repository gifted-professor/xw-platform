---
name: xhs-device-operator
description: Safely inventory and diagnose multiple Android devices through ADB, recognize per-device page layouts, and optionally sync approved fields to Feishu Base.
---

# XHS device operator

## Workflow

1. Load `config/local.psd1`; never display or commit its identifiers.
2. Run `scripts/Collect-PhoneAssets.ps1 -OpenXhsProfile`.
3. For each device, accept a profile only when the current UI contains both `小红书号` and profile metrics.
4. If semantic navigation fails, refresh the UI hierarchy once. If it still fails, classify the screenshot with `scripts/cloud-vision.mjs` and verify the proposed target against the new hierarchy.
5. Stop that device after two failures; continue the remaining devices.
6. Run `scripts/Sync-LarkBase.ps1` only when Base Token/Table ID are configured and the user has already authorized this table.
7. Report per-device success/failure without exposing credentials or unnecessary personal data.

## Hard boundaries

- No automatic likes, follows, comments, messages, publishing, deletion, login verification or payments.
- No CAPTCHA, risk-control or platform-limit bypass.
- Do not use one phone's coordinates for another phone.
- Do not send sensitive screenshots to cloud vision.
- Do not commit runtime data.

