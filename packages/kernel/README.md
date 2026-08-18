# @xw-platform/kernel

Shared kernel for xw-platform. M2-B only adds **byte-identical copies** of contracts that already exist in both services.

- Not an npm workspace. Root `package.json` has no `workspaces` field.
- Service import paths are unchanged. Originals stay in:
  - `services/orchestrator/contracts/`
  - `services/control-plane/contracts/`
- First batch: the six `repair-*` schemas. Compared with LF-normalized SHA-256 so Windows `core.autocrlf` on service working trees does not false-fail Linux CI.

Check:

```bash
node tools/fusion/cli.mjs kernel
```
