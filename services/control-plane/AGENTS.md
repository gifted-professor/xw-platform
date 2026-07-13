# Agent rules

- Read `skills/xhs-device-operator/SKILL.md` before operating devices.
- Prefer Android UI hierarchy and semantic selectors over fixed coordinates.
- Treat every phone as an independent layout and version profile.
- Allowed without extra confirmation: inventory, screenshots for diagnosis, UI dumps, opening the app, navigating to the local user's own profile, and syncing approved public/device fields.
- Require human confirmation for publishing, commenting, following, messaging, deleting, account changes, login challenges, payments, or external communication.
- Never bypass CAPTCHAs, platform restrictions, risk controls, or identity verification.
- Never commit `.env`, `config/local.psd1`, `data/`, screenshots, UI XML, OAuth tokens, or real device/account identifiers.
- Stop a device after two consecutive navigation failures and report the current screenshot and hierarchy paths.

