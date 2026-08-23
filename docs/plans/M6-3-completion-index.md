# M6-3 completion index for the M6-4 baseline

Status: `M6_3_CLOSED_READY_FOR_M6_4_PLANNING`  
Candidate commit: `0fa5ae7f366bf40da242bec824882658fc6596d4`  
Candidate tree: `b91619930acbfaea218a6d3319eb8da38ad04732`  
Candidate branch: `codex/m6-3-dsh-replay`

This index is the repository-side pointer to the final external evidence. It
supersedes `docs/plans/M6-3-handoff.md` only as the current completion-status
index. It does not rewrite, re-sign or alter any M6-3 receipt or historical
commit.

## Canonical external evidence

| Artifact | SHA-256 |
|---|---|
| `C:/Users/Public/xw-runtime/m6-audit/m6-3-completion-receipt.json` | `fa143729fb6e08cbce9c2082802b840efe4c1488662215b01b58ad9daeda3a3f` |
| `C:/Users/Public/xw-runtime/m6-audit/multi-model-execution-completion-m6-3.json` | `eca21f4c1b9c4c761ecba0871cf8894aef2239827e5a44ee71d88cfc12b40c27` |
| `C:/Users/Public/xw-runtime/m6-audit/m6-3-gate-manifest.json` | `5812c3608423c3a2665672188629f31dbe57dc74884888d61562c3e78fdbb4d1` |
| `C:/Users/Public/xw-runtime/m6-audit/m6-3-review-adjudication.json` | `21001eef1542e12d1741755714234fa40c7690d9fba4ca9b85aed3a34c727839` |
| `C:/Users/Public/xw-runtime/m6-audit/m6-2-w9-completion-4ea1fa60.json` | `7d6910c59656ba173869ff6454837c4bd0061eb6e24ebb50e165c01d6964bbbb` |

The M6-2 receipt above is the canonical W9 completion receipt. It supersedes
the prohibited-5038 receipt identified inside that receipt; consumers must not
select an older file by timestamp or filename order.

## Closed result

- Real DSH/Cordis child process, exact ten-tool replay and cross-process
  `ctx.agents.resume()` completed.
- 40 warm ACK samples, p95 `7.2731 ms`.
- 20 happy, 5 replan and 5 hard-stop routes passed.
- 13 fault cases passed; remaining owned process trees: 0.
- M6: 121/121; M6-2 offline: 108/108; epoch: 66 pass plus one narrow Windows
  symlink skip; orchestrator: 527/528 with one unrelated Windows symlink EPERM
  environment exception.
- Gate is `CLOSED`; live actions and runtime cutover are disabled; external
  effect is false and action count is zero.
- Review adjudication reports zero open blocking findings.

## M6-4 integration state

The local M6-4 integration branch preserves the candidate without squash in
merge commit `df16a0409a0997b01e378933d24ad737fde94e16`, whose parents are
`80355d341d854212045c6c1ec62daffbaf3de766` and
`0fa5ae7f366bf40da242bec824882658fc6596d4`.

Remote `origin/main` did not yet contain the M6-3 candidate when this index was
created. An attempted push was blocked before disclosure because the exact
GitHub destination had not received explicit external-disclosure approval. No
repository content was sent. M6-4 evidence must keep local integration and
remote merge status separate until that authorization is supplied.

Root `.m6-3-spike/`, root `profiles/`, sessions, logs, credentials, device
private state and other predecessor scratch remain excluded from this branch.

