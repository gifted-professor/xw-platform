# @xw-platform/kernel

Shared kernel for xw-platform. M2-B only adds **byte-identical copies** of contracts that already exist in both services.

- Not an npm workspace. Root `package.json` has no `workspaces` field.
- Service import paths are unchanged. Originals stay in:
  - `services/orchestrator/contracts/`
  - `services/control-plane/contracts/`
- First batch: the six `repair-*` schemas. Compared with LF-normalized SHA-256 so Windows `core.autocrlf` on service working trees does not false-fail Linux CI.

M3-A adds **kernel-only** Open Action protocol (not copied into services):

- `contracts/open-action/`
- `event-protocol/`
- `error-codes/`
- `lib/open-action.mjs`

Check:

```bash
node tools/fusion/cli.mjs kernel
node --test packages/kernel/test
```
