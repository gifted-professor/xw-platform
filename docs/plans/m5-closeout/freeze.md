# M5 closeout freeze (F0)
frozenAt: 2026-08-20T23:12:35+08:00

## refs
- refs/heads/backup/m5-feat-6fc376a = 6fc376a57824ac64e724e3ae96765fa02628a7f3
- refs/heads/backup/m5-zero-eb106ff = eb106ff0a15fa97345cbc716968b1fe2894805d4
- feat/m5-zero-test-baseline (m5-m0 worktree) = eb106ff0a15fa97345cbc716968b1fe2894805d4
- feat/m5-orchestration-layer = 6fc376a57824ac64e724e3ae96765fa02628a7f3
- main = db8885eb00b50ba80677cebd865e4765e3d7929e

## git log db8885e..eb106ff
eb106ff test(orchestrator): stabilize Windows registry suite startup
56374e0 test(fusion): clear orchestrator known-failure allowlist and harden gates (M5-0)

## git log eb106ff..6fc376a
6fc376a docs(m5): record implementation and live acceptance evidence
6bbd1d9 fix(orchestration): bind M5 against control-plane integrity metadata
1b1c124 fix(orchestration): honor current live capability support contract
7165787 feat(orchestration): connect M5 graph runtime and dry-run entrypoints
bdd5d05 feat(orchestration): add local card-count validator
658d188 feat(trace): persist M5 orchestration event chains
3bd2fc1 feat(orchestration): add deterministic M5 task graph compiler

## patch-ids db8885e..eb106ff
56374e08cd02e4cd90ded570f87ce43270f875c3 72a5eebc456cb15ac9edc8a05be05144882d48ff
eb106ff0a15fa97345cbc716968b1fe2894805d4 b6c46de7963d0be4ac0a8c487000417ee7451a61

## patch-ids eb106ff..6fc376a
3bd2fc1a57d8de23c08ac6021156c5657af15c3e bf5ca835d838e966afb35ec1f068b92ec732fcb2
658d1888cc82a80f65e0f4114eaf7cacc16f7ecc a2baee6ff4bdd402df6ec31246570f21b242a45f
bdd5d0559a47a6264bc95ccd882a1888be26490c c30b88b39fd7d4d10fb9e73827e6758165adfcb4
7165787665e011a735e4a9198a06ccc968370de6 ec479be6a660d38c6cb35a4045b47cc2299a5e25
1b1c124207467c1c40f13aa0ea618dd13ebfbcb6 1b1a9e1414b7ddeeb8d00b0743ef90383e94401f
6bbd1d97b3d56c4992bed7daadb03e79135354a3 c90998fb24eb0e636f800af89f36ae5d6eef6689
6fc376a57824ac64e724e3ae96765fa02628a7f3 a4e4a073282c6e24ec9d6abcededc43fb9968224

## range-diff db8885e..eb106ff vs db8885e..backup/m5-zero-eb106ff
1:  56374e0 = 1:  56374e0 test(fusion): clear orchestrator known-failure allowlist and harden gates (M5-0)
2:  eb106ff = 2:  eb106ff test(orchestrator): stabilize Windows registry suite startup

## diff --stat db8885e..6fc376a
 tools/fusion/test-gate.mjs                         |  11 +-
 tools/xw-runtime-tools.test.mjs                    |   1 +
 48 files changed, 3187 insertions(+), 90 deletions(-)
