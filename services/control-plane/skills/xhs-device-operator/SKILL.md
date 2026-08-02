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

## Deployed code is authoritative + policy doc debt (REX Phase 6)

Authority order: **deployed release code + live agent-entry/task packet** > top-level
AGENTS / modes / skills routing docs > not-yet-migrated app sub-skill Markdown.

- Read the **Release / runtime policy** block of the live entry before any device task:
  `ssh xhs-windows 'curl.exe -s http://127.0.0.1:17930/agent-entry.md'`
  (JSON: `GET http://127.0.0.1:17930/api/agent-entry` → `release`).
  Fields: `releaseId / runtimePolicyVersion / effectiveDecisionSource / policyMode /
  evidenceMode / policyDocDebt`.
- `policyDocDebt` only reminds which stale docs are not yet migrated; it never blocks a
  task. If a stale doc listed there says "requires approval" but the current release
  policy / task packet has superseded that rule, the release wins.
- Neither this contract nor any stale sub-skill text may widen the one hard gate: a real
  money final commit waits for human confirmation with transport held at 0.
