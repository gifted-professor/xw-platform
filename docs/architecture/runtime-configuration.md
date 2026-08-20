# XW runtime configuration boundary

`xw-platform` is the only source of code, configuration contracts, safe examples,
Codex skill content, and installation/check logic. `xw-runtime` is a machine-local
runtime data root, not a second source checkout.

## What belongs where

| Location | Contents |
| --- | --- |
| `xw-platform` | Source, tests, `config/runtime/xw-runtime.v1.json`, safe examples, task installers, launcher templates, and the canonical `/xw` skill |
| `xw-runtime/releases` | Immutable deployed release copies produced from reviewed source commits |
| `xw-runtime/current` | Junction to exactly one deployed release |
| `xw-runtime/secrets` | Real device identifiers, tokens, and secret-bearing launch configuration; never Git-tracked |
| `xw-runtime/state` | SQLite databases, generated launch bindings, and outbox state |
| `xw-runtime/evidence`, `logs`, `receipts`, `rollback` | Mutable operational artifacts |

The checked-in layout contract lists every required machine-local file by name but
contains no secret value. The real `control-plane.devices.json` is intentionally kept
under `xw-runtime/secrets`; its safe shape is documented by
`services/control-plane/config/control-plane.devices.example.json`.

## One check

Run `npm run xw:runtime:check` from the repository root. It verifies the current
release boundary and manifest, required state/private files, device aliases and serve
ports, managed launcher parity, new scheduled-task bindings, and that retired
FastOperator tasks remain disabled. It never reads secret values into its output.

`npm run xw:runtime:init` may be used on a new host to create only missing, non-secret
directories. It does not fabricate secrets, databases, releases, or scheduled tasks;
the check remains red until those are installed through the reviewed cutover/task
installers.
