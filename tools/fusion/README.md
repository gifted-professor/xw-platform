# tools/fusion

Offline Physical Fusion verifier. It reads frozen receipts and the current Git trees. It does not import history, rewrite files, or talk to devices.

```bash
node tools/fusion/cli.mjs verify
node --test tools/fusion/test/*.test.mjs
```

`verify` checks:

- `import-registry.v1.json` / `import-device-agent.v1.json` against `source-lock.v1.json`
- current `HEAD:services/{orchestrator,control-plane}` blob/mode/path parity
- fusion merge topology (two parents, rewritten tip is parent 2)
- `git log --follow` history probes
- `runtimeCutoverAllowed=false`
