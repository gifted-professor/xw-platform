# M0 Acceptance Report — xw-m0-20260817-r0

> This Markdown is a projection of the dossier JSONs. The JSONs are the source of truth; this report is not.

## Baseline Identity

- **baselineId**: `xw-m0-20260817-r0`
- **capturedAt**: `2026-08-17T12:16:55Z`
- **inputPair**: { deviceAgent={ commitSha=`43b09accba3364a23917f43224fc0772ef17a217`; ref=`refs/heads/main`; repoOrigin=`https://github.com/gifted-professor/xhs-device-agent.git` }; registry={ commitSha=`8c5682afd5aea2dda9d4a7f4f0fa3a1e4c81c21d`; ref=`refs/heads/main`; repoOrigin=`https://github.com/gifted-professor/xhs-registry.git` } }
- **repos**:

### [1]

- **deployment**: { argLineRedacted=`"C:\Users\Public\xhs-registry\registry.mjs" --port 17930 --host 0.0.0.0 --control http://127.0.0.1:17920 --db "C:\Users\Public\xhs-registry\registry.db" --agent-token <redacted> --human-token <redacted> --human-actor <redacted> --observer-token <redacted> --runs-root "C:\Users\Public\xhs-agent-runs"`; kind=`windowsScheduledTask`; portClaimed=17930; releaseClaim=`8c5682a`; runtimeReachable=true; taskName=`XhsDeviceRegistry` }
- **name**: `registry`
- **path**: `C:\Users\Public\xhs-registry`
- **source**: { commitSha=`8c5682afd5aea2dda9d4a7f4f0fa3a1e4c81c21d`; ref=`refs/heads/main`; repoOrigin=`https://github.com/gifted-professor/xhs-registry.git`; verifiedAgainstInputPair=true }
- **worktree**: { commitSha=`3495bdd3aff42b0f3d4a7658b8e769b13dba3459`; dirty=true; observedVia=`localWorktree`; stagedCount=0; unstagedCount=35; untrackedCount=73 }

### [2]

- **deployment**: { kind=`deviceFleet`; releaseClaim=`43b09ac`; runtimeReachable=false }
- **name**: `deviceAgent`
- **path**: `(no local checkout on this host; GPFS not mounted)`
- **source**: { commitSha=`43b09accba3364a23917f43224fc0772ef17a217`; ref=`refs/heads/main`; repoOrigin=`https://github.com/gifted-professor/xhs-device-agent.git`; verifiedAgainstInputPair=true }
- **worktree**: { commitSha=`43b09accba3364a23917f43224fc0772ef17a217`; dirty=false; observedVia=`originOnly`; stagedCount=0; unstagedCount=0; untrackedCount=0 }


- **schemaId**: `xhs.m0.baseline-identity.v1`
- **schemaVersion**: 1

## Dossier Manifest

- **baselineId**: `xw-m0-20260817-r0`
- **capturedAt**: `2026-08-17T13:00:00.000Z`
- **files**:

### [1]

- **path**: `baseline-identity.v1.json`
- **schemaId**: `xhs.m0.baseline-identity.v1`
- **sha256**: `e306bf2f143b21026be82a99b22faf9172f6c423611cdbe5d49dbca74820f118`

### [2]

- **path**: `runtime-attestation.v1.json`
- **schemaId**: `xhs.m0.runtime-attestation.v1`
- **sha256**: `9439675553cec1c134899e196dffe168780c0065e54150779aeb369451c5a47a`

### [3]

- **path**: `runtime-attestation.device-agent.v1.json`
- **schemaId**: `xhs.m0.runtime-attestation.v1`
- **sha256**: `fcb4918032864f97ea3193094b7f50418f8c708323b8bdccdd12bbda7446d6bb`

### [4]

- **path**: `inventory.v1.json`
- **schemaId**: `xhs.m0.inventory.v1`
- **sha256**: `caf7df9216afda294d2c95143624e2fc2c8c2bd1c0c56e9a551f7037657abe7f`

### [5]

- **path**: `state-ownership.v1.json`
- **schemaId**: `xhs.m0.state-ownership.v1`
- **sha256**: `f676e55dc549ac34c4a2e10bc5449678e7d1fe3d3667b5b104ea9c0144c9ec92`

### [6]

- **path**: `pr-assets.v1.json`
- **schemaId**: `xhs.m0.pr-assets.v1`
- **sha256**: `1b5f2d3d8deee5ba38976ae9cacccd31d2ec9ad94574e1e1a61473099ff30acd`

### [7]

- **path**: `known-debt.v1.json`
- **schemaId**: `xhs.m0.known-debt.v1`
- **sha256**: `76becba382632ed63480afb4966a09a74455d0661affe6d5cb8e0297bad7cf4b`

### [8]

- **path**: `test-baseline.v1.json`
- **schemaId**: `xhs.m0.test-baseline.v1`
- **sha256**: `86efc6530b2473d86d130b5b19da16086f10ce10ab8d84b908b3b8bca3cf4d51`

### [9]

- **path**: `private-evidence.v1.json`
- **schemaId**: `xhs.m0.private-evidence.v1`
- **sha256**: `b4bb18e48ed7b785534292ae9d1d5ac0d9dd393343cf3028b0b1b8c153d7ea94`
- **status**: `pending_age (hash back-filled at B1)`


- **schemaId**: `xhs.m0.dossier-manifest.v1`
- **schemaVersion**: 1

## Inventory

- **baselineId**: `xw-m0-20260817-r0`
- **capturedAt**: `2026-08-17T12:47:40.721Z`
- **coverageRef**: `inventory-coverage.v1.json`
- **repos**:

### [1]

- **dimensions**:

### [1]

- **dimension**: `crossRepoRefs`
- **items**:

### [1]

- **classification**: `crossRepoRef`
- **locator**: `AGENTS.md:1850`
- **note**: `gifted-professor`

### [2]

- **classification**: `crossRepoRef`
- **locator**: `AGENTS.md:1867`
- **note**: `xhs-device-agent`

### [3]

- **classification**: `crossRepoRef`
- **locator**: `AGENTS.md:5400`
- **note**: `/Volumes/GPFS`

### [4]

- **classification**: `crossRepoRef`
- **locator**: `AGENTS.md:5509`
- **note**: `/Volumes/GPFS`

### [5]

- **classification**: `crossRepoRef`
- **locator**: `CLAUDE.md:481`
- **note**: `/Volumes/GPFS`

### [6]

- **classification**: `crossRepoRef`
- **locator**: `CLAUDE.md:499`
- **note**: `xhs-device-agent`

### [7]

- **classification**: `crossRepoRef`
- **locator**: `CLAUDE.md:6645`
- **note**: `/Volumes/GPFS`

### [8]

- **classification**: `crossRepoRef`
- **locator**: `CLAUDE.md:6663`
- **note**: `xhs-device-agent`

### [9]

- **classification**: `crossRepoRef`
- **locator**: `HANDOFF-2026-08-05-xw-explorer-session-fencing.md:247`
- **note**: `xhs-device-agent`

### [10]

- **classification**: `crossRepoRef`
- **locator**: `HANDOFF-2026-08-05-xw-explorer-session-fencing.md:3573`
- **note**: `xhs-device-agent`

### [11]

- **classification**: `crossRepoRef`
- **locator**: `HANDOFF-2026-08-05-xw-explorer-session-fencing.md:3647`
- **note**: `gifted-professor`

### [12]

- **classification**: `crossRepoRef`
- **locator**: `HANDOFF-2026-08-05-xw-explorer-session-fencing.md:3664`
- **note**: `xhs-device-agent`

### [13]

- **classification**: `crossRepoRef`
- **locator**: `HANDOFF-2026-08-05-xw-explorer-session-fencing.md:5427`
- **note**: `xhs-device-agent`

### [14]

- **classification**: `crossRepoRef`
- **locator**: `PROGRESS.md:46889`
- **note**: `gifted-professor`

### [15]

- **classification**: `crossRepoRef`
- **locator**: `PROGRESS.md:68562`
- **note**: `xhs-device-agent`

### [16]

- **classification**: `crossRepoRef`
- **locator**: `PROGRESS.md:69875`
- **note**: `gifted-professor`

### [17]

- **classification**: `crossRepoRef`
- **locator**: `PROGRESS.md:69892`
- **note**: `xhs-device-agent`

### [18]

- **classification**: `crossRepoRef`
- **locator**: `PROGRESS.md:69961`
- **note**: `gifted-professor`

### [19]

- **classification**: `crossRepoRef`
- **locator**: `PROGRESS.md:69978`
- **note**: `xhs-device-agent`

### [20]

- **classification**: `crossRepoRef`
- **locator**: `PROGRESS.md:70068`
- **note**: `gifted-professor`

### [21]

- **classification**: `crossRepoRef`
- **locator**: `PROGRESS.md:70085`
- **note**: `xhs-device-agent`

### [22]

- **classification**: `crossRepoRef`
- **locator**: `PROGRESS.md:74840`
- **note**: `xhs-device-agent`

### [23]

- **classification**: `crossRepoRef`
- **locator**: `PROGRESS.md:74879`
- **note**: `gifted-professor`

### [24]

- **classification**: `crossRepoRef`
- **locator**: `PROGRESS.md:74896`
- **note**: `xhs-device-agent`

### [25]

- **classification**: `crossRepoRef`
- **locator**: `PROGRESS.md:74922`
- **note**: `gifted-professor`

### [26]

- **classification**: `crossRepoRef`
- **locator**: `PROGRESS.md:74939`
- **note**: `xhs-device-agent`

### [27]

- **classification**: `crossRepoRef`
- **locator**: `PROGRESS.md:76233`
- **note**: `xhs-device-agent`

### [28]

- **classification**: `crossRepoRef`
- **locator**: `PROGRESS.md:101489`
- **note**: `xhs-device-agent`

### [29]

- **classification**: `crossRepoRef`
- **locator**: `PROGRESS.md:117916`
- **note**: `/Volumes/GPFS`

### [30]

- **classification**: `crossRepoRef`
- **locator**: `PROGRESS.md:121792`
- **note**: `xhs-device-agent`

### [31]

- **classification**: `crossRepoRef`
- **locator**: `PROGRESS.md:129609`
- **note**: `/Volumes/GPFS`

### [32]

- **classification**: `crossRepoRef`
- **locator**: `README.md:126`
- **note**: `gifted-professor`

### [33]

- **classification**: `crossRepoRef`
- **locator**: `README.md:143`
- **note**: `xhs-device-agent`

### [34]

- **classification**: `crossRepoRef`
- **locator**: `README.md:605`
- **note**: `gifted-professor`

### [35]

- **classification**: `crossRepoRef`
- **locator**: `README.md:698`
- **note**: `gifted-professor`

### [36]

- **classification**: `crossRepoRef`
- **locator**: `README.md:715`
- **note**: `xhs-device-agent`

### [37]

- **classification**: `crossRepoRef`
- **locator**: `README.md:1541`
- **note**: `gifted-professor`

### [38]

- **classification**: `crossRepoRef`
- **locator**: `README.md:1558`
- **note**: `xhs-device-agent`

### [39]

- **classification**: `crossRepoRef`
- **locator**: `README.md:1643`
- **note**: `gifted-professor`

### [40]

- **classification**: `crossRepoRef`
- **locator**: `README.md:1660`
- **note**: `xhs-device-agent`

### [41]

- **classification**: `crossRepoRef`
- **locator**: `README.md:3208`
- **note**: `xhs-device-agent`

### [42]

- **classification**: `crossRepoRef`
- **locator**: `campaign/ARM-PROTOCOL.md:1452`
- **note**: `/Volumes/GPFS`

### [43]

- **classification**: `crossRepoRef`
- **locator**: `campaign/ARM-PROTOCOL.md:1493`
- **note**: `xhs-device-agent`

### [44]

- **classification**: `crossRepoRef`
- **locator**: `campaign/step.sh:453`
- **note**: `/Volumes/GPFS`

### [45]

- **classification**: `crossRepoRef`
- **locator**: `campaign/step.sh:494`
- **note**: `xhs-device-agent`

### [46]

- **classification**: `crossRepoRef`
- **locator**: `docs/handoffs/2026-08-02-windows-repair-consumer-contract.md:485`
- **note**: `gifted-professor`

### [47]

- **classification**: `crossRepoRef`
- **locator**: `docs/handoffs/2026-08-02-windows-repair-consumer-contract.md:502`
- **note**: `xhs-device-agent`

### [48]

- **classification**: `crossRepoRef`
- **locator**: `docs/handoffs/2026-08-02-xhs-observe-feed-repair-proposal.v1.json:1057`
- **note**: `gifted-professor`

### [49]

- **classification**: `crossRepoRef`
- **locator**: `docs/handoffs/2026-08-02-xhs-observe-feed-repair-proposal.v1.json:1074`
- **note**: `xhs-device-agent`

### [50]

- **classification**: `crossRepoRef`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:2213`
- **note**: `/Volumes/GPFS`

### [51]

- **classification**: `crossRepoRef`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:2254`
- **note**: `xhs-device-agent`

### [52]

- **classification**: `crossRepoRef`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:4281`
- **note**: `/Volumes/GPFS`

### [53]

- **classification**: `crossRepoRef`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:4322`
- **note**: `xhs-device-agent`

### [54]

- **classification**: `crossRepoRef`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:6186`
- **note**: `xhs-device-agent`

### [55]

- **classification**: `crossRepoRef`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:10145`
- **note**: `xhs-device-agent`

### [56]

- **classification**: `crossRepoRef`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:12281`
- **note**: `xhs-device-agent`

### [57]

- **classification**: `crossRepoRef`
- **locator**: `docs/observer-api-20260729.md:184`
- **note**: `xhs-device-agent`

### [58]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-07-28-silk-smooth-feishu-xianyu-codex-plan.md:502`
- **note**: `xhs-device-agent`

### [59]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-07-28-silk-smooth-feishu-xianyu-codex-plan.md:553`
- **note**: `gifted-professor`

### [60]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-07-28-silk-smooth-feishu-xianyu-codex-plan.md:570`
- **note**: `xhs-device-agent`

### [61]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-07-28-silk-smooth-feishu-xianyu-codex-plan.md:9851`
- **note**: `xhs-device-agent`

### [62]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-07-28-silk-smooth-feishu-xianyu-codex-plan.md:9943`
- **note**: `/Volumes/GPFS`

### [63]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-07-28-silk-smooth-feishu-xianyu-codex-plan.md:9984`
- **note**: `xhs-device-agent`

### [64]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-07-28-silk-smooth-feishu-xianyu-codex-plan.md:10060`
- **note**: `xhs-device-agent`

### [65]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-07-28-silk-smooth-feishu-xianyu-codex-plan.md:10103`
- **note**: `xhs-device-agent`

### [66]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-07-28-silk-smooth-feishu-xianyu-codex-plan.md:10857`
- **note**: `xhs-device-agent`

### [67]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-07-28-silk-smooth-feishu-xianyu-codex-plan.md:14137`
- **note**: `xhs-device-agent`

### [68]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.files.json:5651`
- **note**: `xhs-device-agent`

### [69]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.md:2029`
- **note**: `/Volumes/GPFS`

### [70]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.md:2070`
- **note**: `xhs-device-agent`

### [71]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.md:2238`
- **note**: `/Volumes/GPFS`

### [72]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.md:2279`
- **note**: `xhs-device-agent`

### [73]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.md:28079`
- **note**: `xhs-device-agent`

### [74]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-01-rex-phase2-to-8-handoff.md:1006`
- **note**: `/Volumes/GPFS`

### [75]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-01-rex-phase2-to-8-handoff.md:1047`
- **note**: `xhs-device-agent`

### [76]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-01-rex-phase2-to-8-handoff.md:1276`
- **note**: `/Volumes/GPFS`

### [77]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-01-rex-phase2-to-8-handoff.md:1317`
- **note**: `xhs-device-agent`

### [78]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-02-rex-phase5-takeover-handoff.md:807`
- **note**: `/Volumes/GPFS`

### [79]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-02-rex-phase5-takeover-handoff.md:848`
- **note**: `xhs-device-agent`

### [80]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-02-rex-phase5-takeover-handoff.md:1435`
- **note**: `/Volumes/GPFS`

### [81]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-02-rex-phase5-takeover-handoff.md:1476`
- **note**: `xhs-device-agent`

### [82]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-02-rex-phase5-takeover-handoff.md:13732`
- **note**: `/Volumes/GPFS`

### [83]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-02-rex-phase5-takeover-handoff.md:13773`
- **note**: `xhs-device-agent`

### [84]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-08-foundation-pr1-freeze.md:208`
- **note**: `xhs-device-agent`

### [85]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-08-foundation-pr1-freeze.md:411`
- **note**: `gifted-professor`

### [86]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-08-foundation-pr1-freeze.md:428`
- **note**: `xhs-device-agent`

### [87]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-08-foundation-pr1-freeze.md:487`
- **note**: `gifted-professor`

### [88]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-08-foundation-pr2-baseline.md:257`
- **note**: `xhs-device-agent`

### [89]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-08-foundation-pr2-progress.md:209`
- **note**: `gifted-professor`

### [90]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-08-foundation-pr2-progress.md:226`
- **note**: `xhs-device-agent`

### [91]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-08-foundation-pr2-progress.md:311`
- **note**: `gifted-professor`

### [92]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-08-foundation-pr2.files.json:1024`
- **note**: `xhs-device-agent`

### [93]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:328`
- **note**: `gifted-professor`

### [94]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:41725`
- **note**: `gifted-professor`

### [95]

- **classification**: `crossRepoRef`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:48222`
- **note**: `sibling`

### [96]

- **classification**: `crossRepoRef`
- **locator**: `docs/platform/m0/public/xw-m0-20260817-r0/baseline-identity.v1.json:316`
- **note**: `gifted-professor`

### [97]

- **classification**: `crossRepoRef`
- **locator**: `docs/platform/m0/public/xw-m0-20260817-r0/baseline-identity.v1.json:514`
- **note**: `gifted-professor`

### [98]

- **classification**: `crossRepoRef`
- **locator**: `docs/platform/m0/public/xw-m0-20260817-r0/baseline-identity.v1.json:531`
- **note**: `xhs-device-agent`

### [99]

- **classification**: `crossRepoRef`
- **locator**: `docs/platform/m0/public/xw-m0-20260817-r0/baseline-identity.v1.json:817`
- **note**: `gifted-professor`

### [100]

- **classification**: `crossRepoRef`
- **locator**: `docs/platform/m0/public/xw-m0-20260817-r0/baseline-identity.v1.json:1970`
- **note**: `gifted-professor`

### [101]

- **classification**: `crossRepoRef`
- **locator**: `docs/platform/m0/public/xw-m0-20260817-r0/baseline-identity.v1.json:1987`
- **note**: `xhs-device-agent`

### [102]

- **classification**: `crossRepoRef`
- **locator**: `docs/third-party-self-host-pack.md:174`
- **note**: `gifted-professor`

### [103]

- **classification**: `crossRepoRef`
- **locator**: `docs/third-party-self-host-pack.md:230`
- **note**: `gifted-professor`

### [104]

- **classification**: `crossRepoRef`
- **locator**: `docs/third-party-self-host-pack.md:247`
- **note**: `xhs-device-agent`

### [105]

- **classification**: `crossRepoRef`
- **locator**: `knowledge-seed-explorer-lease-hard-gate-20260805.json:903`
- **note**: `xhs-device-agent`

### [106]

- **classification**: `crossRepoRef`
- **locator**: `ops/SYNC-NOTE.md:102`
- **note**: `gifted-professor`

### [107]

- **classification**: `crossRepoRef`
- **locator**: `ops/SYNC-NOTE.md:398`
- **note**: `gifted-professor`

### [108]

- **classification**: `crossRepoRef`
- **locator**: `ops/conc4-full-dry-run.mjs:1976`
- **note**: `/Volumes/GPFS`

### [109]

- **classification**: `crossRepoRef`
- **locator**: `ops/conc4-full-dry-run.mjs:2017`
- **note**: `xhs-device-agent`

### [110]

- **classification**: `crossRepoRef`
- **locator**: `ops/feishu-to-xianyu.mjs:1973`
- **note**: `/Volumes/GPFS`

### [111]

- **classification**: `crossRepoRef`
- **locator**: `ops/feishu-to-xianyu.mjs:2014`
- **note**: `xhs-device-agent`

### [112]

- **classification**: `crossRepoRef`
- **locator**: `ops/l1-patrol.sh:340`
- **note**: `/Volumes/GPFS`

### [113]

- **classification**: `crossRepoRef`
- **locator**: `ops/l1-patrol.sh:381`
- **note**: `xhs-device-agent`

### [114]

- **classification**: `crossRepoRef`
- **locator**: `ops/recover-main-safe.mjs:1170`
- **note**: `/Volumes/GPFS`

### [115]

- **classification**: `crossRepoRef`
- **locator**: `ops/recover-main-safe.mjs:1211`
- **note**: `xhs-device-agent`

### [116]

- **classification**: `crossRepoRef`
- **locator**: `registry.mjs:54222`
- **note**: `/Volumes/GPFS`

### [117]

- **classification**: `crossRepoRef`
- **locator**: `registry.mjs:54263`
- **note**: `xhs-device-agent`

### [118]

- **classification**: `crossRepoRef`
- **locator**: `scripts/review-run-bundle.mjs:7427`
- **note**: `gifted-professor`

### [119]

- **classification**: `crossRepoRef`
- **locator**: `scripts/review-run-bundle.mjs:7444`
- **note**: `xhs-device-agent`

### [120]

- **classification**: `crossRepoRef`
- **locator**: `scripts/review-run-bundle.mjs:26089`
- **note**: `gifted-professor`

### [121]

- **classification**: `crossRepoRef`
- **locator**: `scripts/review-run-bundle.mjs:26106`
- **note**: `xhs-device-agent`

### [122]

- **classification**: `crossRepoRef`
- **locator**: `skills/.SYNCED-FROM.md:15`
- **note**: `gifted-professor`

### [123]

- **classification**: `crossRepoRef`
- **locator**: `skills/CONTRIBUTING.md:1760`
- **note**: `gifted-professor`

### [124]

- **classification**: `crossRepoRef`
- **locator**: `skills/xhs/xhs-comment/SKILL.md:699`
- **note**: `/Volumes/GPFS`

### [125]

- **classification**: `crossRepoRef`
- **locator**: `skills/xhs/xhs-comment/SKILL.md:740`
- **note**: `xhs-device-agent`

### [126]

- **classification**: `crossRepoRef`
- **locator**: `skills/xianyu/xianyu-publish/SKILL.md:441`
- **note**: `/Volumes/GPFS`

### [127]

- **classification**: `crossRepoRef`
- **locator**: `skills/xianyu/xianyu-publish/SKILL.md:482`
- **note**: `xhs-device-agent`

### [128]

- **classification**: `crossRepoRef`
- **locator**: `skills/xianyu/xianyu-snapshot/SKILL.md:298`
- **note**: `/Volumes/GPFS`

### [129]

- **classification**: `crossRepoRef`
- **locator**: `skills/xianyu/xianyu-snapshot/SKILL.md:339`
- **note**: `xhs-device-agent`

### [130]

- **classification**: `crossRepoRef`
- **locator**: `tests/repair-proposal.test.mjs:1373`
- **note**: `gifted-professor`

### [131]

- **classification**: `crossRepoRef`
- **locator**: `tests/repair-proposal.test.mjs:1390`
- **note**: `xhs-device-agent`

### [132]

- **classification**: `crossRepoRef`
- **locator**: `tools/m0/inventory.mjs:6211`
- **note**: `schema copy`

### [133]

- **classification**: `crossRepoRef`
- **locator**: `tools/m0/inventory.mjs:6225`
- **note**: `sibling`

### [134]

- **classification**: `crossRepoRef`
- **locator**: `tools/m0/inventory.mjs:6295`
- **note**: `sibling`

### [135]

- **classification**: `crossRepoRef`
- **locator**: `tools/m0/inventory.mjs:6373`
- **note**: `xhs-device-agent`

### [136]

- **classification**: `crossRepoRef`
- **locator**: `tools/m0/inventory.mjs:6406`
- **note**: `gifted-professor`

### [137]

- **classification**: `crossRepoRef`
- **locator**: `tools/m0/inventory.mjs:6423`
- **note**: `sibling`

### [138]

- **classification**: `crossRepoRef`
- **locator**: `tools/m0/inventory.mjs:6431`
- **note**: `schema copy`

### [139]

- **classification**: `crossRepoRef`
- **locator**: `tools/m0/test/inventory.test.mjs:6156`
- **note**: `sibling`

### [140]

- **classification**: `crossRepoRef`
- **locator**: `tools/m0/test/inventory.test.mjs:6287`
- **note**: `/Volumes/GPFS`

### [141]

- **classification**: `crossRepoRef`
- **locator**: `tools/m0/test/inventory.test.mjs:6305`
- **note**: `xhs-device-agent`

### [142]

- **classification**: `crossRepoRef`
- **locator**: `tools/m0/test/inventory.test.mjs:6408`
- **note**: `gifted-professor`

### [143]

- **classification**: `crossRepoRef`
- **locator**: `tools/m0/test/inventory.test.mjs:6635`
- **note**: `/Volumes/GPFS`

### [144]

- **classification**: `crossRepoRef`
- **locator**: `tools/m0/test/inventory.test.mjs:6697`
- **note**: `gifted-professor`

### [145]

- **classification**: `crossRepoRef`
- **locator**: `tools/m0/validate.mjs:2659`
- **note**: `sibling`

### [146]

- **classification**: `crossRepoRef`
- **locator**: `watchdog/SUPERVISOR.md:293`
- **note**: `/Volumes/GPFS`

### [147]

- **classification**: `crossRepoRef`
- **locator**: `watchdog/SUPERVISOR.md:334`
- **note**: `xhs-device-agent`

### [148]

- **classification**: `crossRepoRef`
- **locator**: `watchdog/watchdog.sh:194`
- **note**: `/Volumes/GPFS`

### [149]

- **classification**: `crossRepoRef`
- **locator**: `watchdog/watchdog.sh:235`
- **note**: `xhs-device-agent`

### [150]

- **classification**: `crossRepoRef`
- **locator**: `watchdog/watchdog.sh:2746`
- **note**: `/Volumes/GPFS`



### [2]

- **dimension**: `dbReferences`
- **items**:

### [1]

- **classification**: `dbRef`
- **locator**: `.claude/skills/registry-review/SKILL.md:3083`
- **note**: `control.db`

### [2]

- **classification**: `dbRef`
- **locator**: `.gitignore:56`
- **note**: `registry.db`

### [3]

- **classification**: `dbRef`
- **locator**: `.gitignore:69`
- **note**: `registry.db`

### [4]

- **classification**: `dbRef`
- **locator**: `.gitignore:90`
- **note**: `registry.db`

### [5]

- **classification**: `dbRef`
- **locator**: `.gitignore:107`
- **note**: `registry.db`

### [6]

- **classification**: `dbRef`
- **locator**: `AGENTS.md:6205`
- **note**: `control.db`

### [7]

- **classification**: `dbRef`
- **locator**: `AGENTS.md:6751`
- **note**: `control.db`

### [8]

- **classification**: `dbRef`
- **locator**: `CLAUDE.md:650`
- **note**: `sqlite`

### [9]

- **classification**: `dbRef`
- **locator**: `CLAUDE.md:1029`
- **note**: `registry.db`

### [10]

- **classification**: `dbRef`
- **locator**: `CLAUDE.md:1711`
- **note**: `control.db`

### [11]

- **classification**: `dbRef`
- **locator**: `CLAUDE.md:2406`
- **note**: `sqlite`

### [12]

- **classification**: `dbRef`
- **locator**: `CLAUDE.md:3049`
- **note**: `control.db`

### [13]

- **classification**: `dbRef`
- **locator**: `CLAUDE.md:3201`
- **note**: `registry.db`

### [14]

- **classification**: `dbRef`
- **locator**: `CLAUDE.md:4014`
- **note**: `control.db`

### [15]

- **classification**: `dbRef`
- **locator**: `CLAUDE.md:4052`
- **note**: `control.db`

### [16]

- **classification**: `dbRef`
- **locator**: `CLAUDE.md:4066`
- **note**: `queryControlDb`

### [17]

- **classification**: `dbRef`
- **locator**: `CLAUDE.md:4584`
- **note**: `CONTROL_DB_PATH`

### [18]

- **classification**: `dbRef`
- **locator**: `CLAUDE.md:4653`
- **note**: `control.db`

### [19]

- **classification**: `dbRef`
- **locator**: `CLAUDE.md:5434`
- **note**: `control.db`

### [20]

- **classification**: `dbRef`
- **locator**: `HANDOFF-2026-08-05-xw-explorer-session-fencing.md:6496`
- **note**: `control.db`

### [21]

- **classification**: `dbRef`
- **locator**: `PROGRESS.md:35337`
- **note**: `control.db`

### [22]

- **classification**: `dbRef`
- **locator**: `PROGRESS.md:45616`
- **note**: `control.db`

### [23]

- **classification**: `dbRef`
- **locator**: `PROGRESS.md:76648`
- **note**: `control.db`

### [24]

- **classification**: `dbRef`
- **locator**: `PROGRESS.md:83531`
- **note**: `control.db`

### [25]

- **classification**: `dbRef`
- **locator**: `PROGRESS.md:83580`
- **note**: `control.db`

### [26]

- **classification**: `dbRef`
- **locator**: `PROGRESS.md:84630`
- **note**: `control.db`

### [27]

- **classification**: `dbRef`
- **locator**: `PROGRESS.md:89281`
- **note**: `control.db`

### [28]

- **classification**: `dbRef`
- **locator**: `PROGRESS.md:92942`
- **note**: `control.db`

### [29]

- **classification**: `dbRef`
- **locator**: `PROGRESS.md:106679`
- **note**: `control.db`

### [30]

- **classification**: `dbRef`
- **locator**: `PROGRESS.md:107426`
- **note**: `queryControlDb`

### [31]

- **classification**: `dbRef`
- **locator**: `PROGRESS.md:121533`
- **note**: `sqlite`

### [32]

- **classification**: `dbRef`
- **locator**: `PROGRESS.md:121875`
- **note**: `control.db`

### [33]

- **classification**: `dbRef`
- **locator**: `PROGRESS.md:123387`
- **note**: `control.db`

### [34]

- **classification**: `dbRef`
- **locator**: `PROGRESS.md:123404`
- **note**: `queryControlDb`

### [35]

- **classification**: `dbRef`
- **locator**: `PROGRESS.md:125219`
- **note**: `sqlite`

### [36]

- **classification**: `dbRef`
- **locator**: `PROGRESS.md:125897`
- **note**: `control.db`

### [37]

- **classification**: `dbRef`
- **locator**: `PROGRESS.md:129258`
- **note**: `control.db`

### [38]

- **classification**: `dbRef`
- **locator**: `README.md:3040`
- **note**: `registry.db`

### [39]

- **classification**: `dbRef`
- **locator**: `campaign/ARM-PROTOCOL.md:2790`
- **note**: `control.db`

### [40]

- **classification**: `dbRef`
- **locator**: `docs/handoffs/2026-08-02-windows-repair-consumer-contract.md:4866`
- **note**: `control.db`

### [41]

- **classification**: `dbRef`
- **locator**: `docs/handoffs/2026-08-02-xhs-observe-feed-repair-proposal.v1.json:3960`
- **note**: `control.db`

### [42]

- **classification**: `dbRef`
- **locator**: `docs/handoffs/2026-08-02-xhs-observe-feed-repair-proposal.v1.json:3984`
- **note**: `control.db`

### [43]

- **classification**: `dbRef`
- **locator**: `docs/handoffs/2026-08-02-xhs-observe-feed-repair-proposal.v1.json:4984`
- **note**: `control.db`

### [44]

- **classification**: `dbRef`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:4166`
- **note**: `control.db`

### [45]

- **classification**: `dbRef`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:10397`
- **note**: `control.db`

### [46]

- **classification**: `dbRef`
- **locator**: `docs/observer-api-20260729.md:2641`
- **note**: `control.db`

### [47]

- **classification**: `dbRef`
- **locator**: `docs/observer-api-20260729.md:4173`
- **note**: `control.db`

### [48]

- **classification**: `dbRef`
- **locator**: `docs/observer-api-20260729.md:7334`
- **note**: `control.db`

### [49]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-07-28-silk-smooth-feishu-xianyu-codex-plan.md:2474`
- **note**: `control.db`

### [50]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-07-28-silk-smooth-feishu-xianyu-codex-plan.md:19156`
- **note**: `control.db`

### [51]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.files.json:12736`
- **note**: `control.db`

### [52]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.md:5880`
- **note**: `control.db`

### [53]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.md:13813`
- **note**: `control.db`

### [54]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.md:17216`
- **note**: `control.db`

### [55]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.md:39337`
- **note**: `control.db`

### [56]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-01-rex-phase2-to-8-handoff.md:1505`
- **note**: `control.db`

### [57]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-01-rex-phase2-to-8-handoff.md:29269`
- **note**: `control.db`

### [58]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-02-mac-repair-command.files.json:1884`
- **note**: `control.db`

### [59]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-05-xw-trusted-loop-execution-plan.md:2479`
- **note**: `control.db`

### [60]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-05-xw-trusted-loop-execution-plan.md:18177`
- **note**: `control.db`

### [61]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-05-xw-trusted-loop-execution-plan.md:21825`
- **note**: `control.db`

### [62]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-06-explorer-budget-cross-device-circuit-breaker-v1.md:3077`
- **note**: `control.db`

### [63]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:510`
- **note**: `control.db`

### [64]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:534`
- **note**: `registry.db`

### [65]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:3466`
- **note**: `sqlite`

### [66]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:4549`
- **note**: `registry.db`

### [67]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:4669`
- **note**: `control.db`

### [68]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:8630`
- **note**: `control.db`

### [69]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:9770`
- **note**: `registry.db`

### [70]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:11554`
- **note**: `registry.db`

### [71]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:20387`
- **note**: `readOnly: true`

### [72]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:31936`
- **note**: `registry.db`

### [73]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:32076`
- **note**: `registry.db`

### [74]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:35322`
- **note**: `registry.db`

### [75]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:43710`
- **note**: `registry.db`

### [76]

- **classification**: `dbRef`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:48700`
- **note**: `control.db`

### [77]

- **classification**: `dbRef`
- **locator**: `docs/platform/m0/public/xw-m0-20260817-r0/baseline-identity.v1.json:1426`
- **note**: `registry.db`

### [78]

- **classification**: `dbRef`
- **locator**: `docs/platform/m0/public/xw-m0-20260817-r0/runtime-attestation.v1.json:435`
- **note**: `registry.db`

### [79]

- **classification**: `dbRef`
- **locator**: `install-registry-task.ps1:1775`
- **note**: `registry.db`

### [80]

- **classification**: `dbRef`
- **locator**: `knowledge-seed-campaign-20260727.json:819`
- **note**: `control.db`

### [81]

- **classification**: `dbRef`
- **locator**: `modes/explorer.md:4041`
- **note**: `control.db`

### [82]

- **classification**: `dbRef`
- **locator**: `ops/SYNC-NOTE.md:2011`
- **note**: `control.db`

### [83]

- **classification**: `dbRef`
- **locator**: `ops/install-xw-evolve-worker.ps1:637`
- **note**: `registry.db`

### [84]

- **classification**: `dbRef`
- **locator**: `ops/xw-closeout.mjs:694`
- **note**: `control.db`

### [85]

- **classification**: `dbRef`
- **locator**: `ops/xw-evolve-replay-once.mjs:177`
- **note**: `registry.db`

### [86]

- **classification**: `dbRef`
- **locator**: `ops/xw-evolve-replay-once.mjs:819`
- **note**: `sqlite`

### [87]

- **classification**: `dbRef`
- **locator**: `ops/xw-evolve-replay-once.mjs:3660`
- **note**: `registry.db`

### [88]

- **classification**: `dbRef`
- **locator**: `ops/xw-evolve-worker.mjs:447`
- **note**: `sqlite`

### [89]

- **classification**: `dbRef`
- **locator**: `ops/xw-evolve-worker.mjs:867`
- **note**: `registry.db`

### [90]

- **classification**: `dbRef`
- **locator**: `ops/xw-evolve.mjs:730`
- **note**: `sqlite`

### [91]

- **classification**: `dbRef`
- **locator**: `ops/xw-evolve.mjs:1341`
- **note**: `registry.db`

### [92]

- **classification**: `dbRef`
- **locator**: `ops/xw-ops-health.mjs:212`
- **note**: `registry.db`

### [93]

- **classification**: `dbRef`
- **locator**: `ops/xw-ops-health.mjs:2298`
- **note**: `registry.db`

### [94]

- **classification**: `dbRef`
- **locator**: `ops/xw-skills.mjs:587`
- **note**: `control.db`

### [95]

- **classification**: `dbRef`
- **locator**: `ops/xw-stall-worker.mjs:204`
- **note**: `registry.db`

### [96]

- **classification**: `dbRef`
- **locator**: `ops/xw-stall-worker.mjs:265`
- **note**: `sqlite`

### [97]

- **classification**: `dbRef`
- **locator**: `ops/xw-stall-worker.mjs:683`
- **note**: `registry.db`

### [98]

- **classification**: `dbRef`
- **locator**: `ops/xw-start.mjs:485`
- **note**: `control.db`

### [99]

- **classification**: `dbRef`
- **locator**: `query-routing.mjs:35`
- **note**: `sqlite`

### [100]

- **classification**: `dbRef`
- **locator**: `query-routing.mjs:118`
- **note**: `control.db`

### [101]

- **classification**: `dbRef`
- **locator**: `query-routing.mjs:133`
- **note**: `readOnly: true`

### [102]

- **classification**: `dbRef`
- **locator**: `registry.mjs:100`
- **note**: `sqlite`

### [103]

- **classification**: `dbRef`
- **locator**: `registry.mjs:325`
- **note**: `control.db`

### [104]

- **classification**: `dbRef`
- **locator**: `registry.mjs:390`
- **note**: `control.db`

### [105]

- **classification**: `dbRef`
- **locator**: `registry.mjs:578`
- **note**: `registry.db`

### [106]

- **classification**: `dbRef`
- **locator**: `registry.mjs:1252`
- **note**: `sqlite`

### [107]

- **classification**: `dbRef`
- **locator**: `registry.mjs:2717`
- **note**: `registry.db`

### [108]

- **classification**: `dbRef`
- **locator**: `registry.mjs:2820`
- **note**: `CONTROL_DB_PATH`

### [109]

- **classification**: `dbRef`
- **locator**: `registry.mjs:2897`
- **note**: `control.db`

### [110]

- **classification**: `dbRef`
- **locator**: `registry.mjs:23140`
- **note**: `control.db`

### [111]

- **classification**: `dbRef`
- **locator**: `registry.mjs:23455`
- **note**: `CONTROL_DB_PATH`

### [112]

- **classification**: `dbRef`
- **locator**: `registry.mjs:23474`
- **note**: `readOnly: true`

### [113]

- **classification**: `dbRef`
- **locator**: `registry.mjs:23609`
- **note**: `control.db`

### [114]

- **classification**: `dbRef`
- **locator**: `registry.mjs:23885`
- **note**: `control.db`

### [115]

- **classification**: `dbRef`
- **locator**: `registry.mjs:23937`
- **note**: `queryControlDb`

### [116]

- **classification**: `dbRef`
- **locator**: `registry.mjs:24106`
- **note**: `control.db`

### [117]

- **classification**: `dbRef`
- **locator**: `registry.mjs:25461`
- **note**: `queryControlDb`

### [118]

- **classification**: `dbRef`
- **locator**: `registry.mjs:25899`
- **note**: `control.db`

### [119]

- **classification**: `dbRef`
- **locator**: `registry.mjs:26063`
- **note**: `queryControlDb`

### [120]

- **classification**: `dbRef`
- **locator**: `registry.mjs:26922`
- **note**: `control.db`

### [121]

- **classification**: `dbRef`
- **locator**: `registry.mjs:29446`
- **note**: `queryControlDb`

### [122]

- **classification**: `dbRef`
- **locator**: `registry.mjs:30589`
- **note**: `control.db`

### [123]

- **classification**: `dbRef`
- **locator**: `registry.mjs:31333`
- **note**: `queryControlDb`

### [124]

- **classification**: `dbRef`
- **locator**: `registry.mjs:33135`
- **note**: `control.db`

### [125]

- **classification**: `dbRef`
- **locator**: `registry.mjs:37439`
- **note**: `queryControlDb`

### [126]

- **classification**: `dbRef`
- **locator**: `registry.mjs:38406`
- **note**: `control.db`

### [127]

- **classification**: `dbRef`
- **locator**: `registry.mjs:56251`
- **note**: `control.db`

### [128]

- **classification**: `dbRef`
- **locator**: `registry.mjs:59143`
- **note**: `control.db`

### [129]

- **classification**: `dbRef`
- **locator**: `registry.mjs:69339`
- **note**: `control.db`

### [130]

- **classification**: `dbRef`
- **locator**: `registry.mjs:90268`
- **note**: `sqlite`

### [131]

- **classification**: `dbRef`
- **locator**: `registry.mjs:90700`
- **note**: `control.db`

### [132]

- **classification**: `dbRef`
- **locator**: `registry.mjs:90769`
- **note**: `control.db`

### [133]

- **classification**: `dbRef`
- **locator**: `registry.mjs:90847`
- **note**: `queryControlDb`

### [134]

- **classification**: `dbRef`
- **locator**: `registry.mjs:94983`
- **note**: `control.db`

### [135]

- **classification**: `dbRef`
- **locator**: `registry.mjs:97935`
- **note**: `queryControlDb`

### [136]

- **classification**: `dbRef`
- **locator**: `registry.mjs:105757`
- **note**: `control.db`

### [137]

- **classification**: `dbRef`
- **locator**: `scripts/lib/ops-health.mjs:286`
- **note**: `sqlite`

### [138]

- **classification**: `dbRef`
- **locator**: `scripts/lib/ops-health.mjs:18082`
- **note**: `registry.db`

### [139]

- **classification**: `dbRef`
- **locator**: `scripts/lib/ops-health.mjs:20097`
- **note**: `readOnly: true`

### [140]

- **classification**: `dbRef`
- **locator**: `scripts/lib/recipe-catalog.mjs:124`
- **note**: `sqlite`

### [141]

- **classification**: `dbRef`
- **locator**: `scripts/lib/repair-proposal.mjs:684`
- **note**: `control.db`

### [142]

- **classification**: `dbRef`
- **locator**: `scripts/lib/repair-proposal.mjs:703`
- **note**: `control.db`

### [143]

- **classification**: `dbRef`
- **locator**: `scripts/review-run-bundle.mjs:16980`
- **note**: `control.db`

### [144]

- **classification**: `dbRef`
- **locator**: `skills/SKILL.md:5559`
- **note**: `control.db`

### [145]

- **classification**: `dbRef`
- **locator**: `tests/nonpayment-liveness.test.mjs:4777`
- **note**: `control.db`

### [146]

- **classification**: `dbRef`
- **locator**: `tests/recipe-catalog.test.mjs:289`
- **note**: `sqlite`

### [147]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:488`
- **note**: `sqlite`

### [148]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:9999`
- **note**: `registry.db`

### [149]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:10092`
- **note**: `control.db`

### [150]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:11671`
- **note**: `registry.db`

### [151]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:11727`
- **note**: `control.db`

### [152]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:15969`
- **note**: `registry.db`

### [153]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:16021`
- **note**: `control.db`

### [154]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:25512`
- **note**: `registry.db`

### [155]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:25564`
- **note**: `control.db`

### [156]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:38314`
- **note**: `registry.db`

### [157]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:38366`
- **note**: `control.db`

### [158]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:39917`
- **note**: `registry.db`

### [159]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:39969`
- **note**: `control.db`

### [160]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:41478`
- **note**: `registry.db`

### [161]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:42113`
- **note**: `control.db`

### [162]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:43236`
- **note**: `registry.db`

### [163]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:43288`
- **note**: `control.db`

### [164]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:43358`
- **note**: `control.db`

### [165]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:44193`
- **note**: `control.db`

### [166]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:45878`
- **note**: `control.db`

### [167]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:46186`
- **note**: `registry.db`

### [168]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:46243`
- **note**: `control.db`

### [169]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:54289`
- **note**: `registry.db`

### [170]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:63295`
- **note**: `registry.db`

### [171]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:63347`
- **note**: `control.db`

### [172]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:69777`
- **note**: `registry.db`

### [173]

- **classification**: `dbRef`
- **locator**: `tests/registry.test.mjs:69829`
- **note**: `control.db`

### [174]

- **classification**: `dbRef`
- **locator**: `tests/run-context.test.mjs:3446`
- **note**: `sqlite`

### [175]

- **classification**: `dbRef`
- **locator**: `tests/stall-triage.test.mjs:106`
- **note**: `sqlite`

### [176]

- **classification**: `dbRef`
- **locator**: `tests/xw-start.test.mjs:3127`
- **note**: `control.db`

### [177]

- **classification**: `dbRef`
- **locator**: `tools/m0/a2-collect.mjs:2270`
- **note**: `registry.db`

### [178]

- **classification**: `dbRef`
- **locator**: `tools/m0/inventory.mjs:4769`
- **note**: `sqlite`

### [179]

- **classification**: `dbRef`
- **locator**: `tools/m0/inventory.mjs:4776`
- **note**: `registry.db`

### [180]

- **classification**: `dbRef`
- **locator**: `tools/m0/inventory.mjs:4788`
- **note**: `control.db`

### [181]

- **classification**: `dbRef`
- **locator**: `tools/m0/inventory.mjs:4805`
- **note**: `CONTROL_DB_PATH`

### [182]

- **classification**: `dbRef`
- **locator**: `tools/m0/inventory.mjs:4821`
- **note**: `queryControlDb`

### [183]

- **classification**: `dbRef`
- **locator**: `tools/m0/inventory.mjs:4845`
- **note**: `sqlite`

### [184]

- **classification**: `dbRef`
- **locator**: `tools/m0/inventory.mjs:4940`
- **note**: `CONTROL_DB_PATH`

### [185]

- **classification**: `dbRef`
- **locator**: `tools/m0/inventory.mjs:4956`
- **note**: `queryControlDb`

### [186]

- **classification**: `dbRef`
- **locator**: `tools/m0/inventory.mjs:4971`
- **note**: `sqlite`

### [187]

- **classification**: `dbRef`
- **locator**: `tools/m0/inventory.mjs:4980`
- **note**: `sqlite`

### [188]

- **classification**: `dbRef`
- **locator**: `tools/m0/inventory.mjs:5609`
- **note**: `CONTROL_DB_PATH`

### [189]

- **classification**: `dbRef`
- **locator**: `tools/m0/inventory.mjs:5898`
- **note**: `CONTROL_DB_PATH`

### [190]

- **classification**: `dbRef`
- **locator**: `tools/m0/test/inventory.test.mjs:3962`
- **note**: `sqlite`

### [191]

- **classification**: `dbRef`
- **locator**: `tools/m0/test/inventory.test.mjs:3969`
- **note**: `control.db`

### [192]

- **classification**: `dbRef`
- **locator**: `tools/m0/test/inventory.test.mjs:3980`
- **note**: `CONTROL_DB_PATH`

### [193]

- **classification**: `dbRef`
- **locator**: `tools/m0/test/inventory.test.mjs:4121`
- **note**: `CONTROL_DB_PATH`

### [194]

- **classification**: `dbRef`
- **locator**: `tools/m0/test/inventory.test.mjs:4186`
- **note**: `control.db`

### [195]

- **classification**: `dbRef`
- **locator**: `tools/m0/test/inventory.test.mjs:4295`
- **note**: `readOnly: true`

### [196]

- **classification**: `dbRef`
- **locator**: `tools/m0/test/inventory.test.mjs:4505`
- **note**: `CONTROL_DB_PATH`

### [197]

- **classification**: `dbRef`
- **locator**: `tools/m0/test/inventory.test.mjs:4569`
- **note**: `queryControlDb`

### [198]

- **classification**: `dbRef`
- **locator**: `tools/m0/test/validate.test.mjs:3299`
- **note**: `registry.db`



### [3]

- **dimension**: `deviceControlEntry`
- **items**:

### [1]

- **classification**: `docMention`
- **locator**: `AGENTS.md:643`
- **note**: `GatewayOperator`

### [2]

- **classification**: `docMention`
- **locator**: `AGENTS.md:2545`
- **note**: `22222`

### [3]

- **classification**: `docMention`
- **locator**: `AGENTS.md:6741`
- **note**: `22222`

### [4]

- **classification**: `docMention`
- **locator**: `AGENTS.md:6747`
- **note**: `ADB`

### [5]

- **classification**: `docMention`
- **locator**: `CLAUDE.md:3039`
- **note**: `22222`

### [6]

- **classification**: `docMention`
- **locator**: `CLAUDE.md:3045`
- **note**: `ADB`

### [7]

- **classification**: `docMention`
- **locator**: `HANDOFF-2026-08-05-xw-explorer-session-fencing.md:155`
- **note**: `22222`

### [8]

- **classification**: `docMention`
- **locator**: `HANDOFF-2026-08-05-xw-explorer-session-fencing.md:161`
- **note**: `ADB`

### [9]

- **classification**: `docMention`
- **locator**: `HANDOFF-2026-08-05-xw-explorer-session-fencing.md:2077`
- **note**: `22222`

### [10]

- **classification**: `docMention`
- **locator**: `HANDOFF-2026-08-05-xw-explorer-session-fencing.md:2261`
- **note**: `ADB`

### [11]

- **classification**: `docMention`
- **locator**: `HANDOFF-2026-08-05-xw-explorer-session-fencing.md:2629`
- **note**: `adb`

### [12]

- **classification**: `docMention`
- **locator**: `HANDOFF-2026-08-05-xw-explorer-session-fencing.md:2752`
- **note**: `22222`

### [13]

- **classification**: `docMention`
- **locator**: `HANDOFF-2026-08-05-xw-explorer-session-fencing.md:2760`
- **note**: `adb`

### [14]

- **classification**: `docMention`
- **locator**: `HANDOFF-2026-08-05-xw-explorer-session-fencing.md:4221`
- **note**: `22222`

### [15]

- **classification**: `docMention`
- **locator**: `HANDOFF-2026-08-05-xw-explorer-session-fencing.md:4227`
- **note**: `ADB`

### [16]

- **classification**: `docMention`
- **locator**: `HANDOFF-2026-08-05-xw-explorer-session-fencing.md:4656`
- **note**: `22222`

### [17]

- **classification**: `docMention`
- **locator**: `HANDOFF-2026-08-05-xw-explorer-session-fencing.md:4835`
- **note**: `ADB`

### [18]

- **classification**: `docMention`
- **locator**: `HANDOFF-2026-08-05-xw-explorer-session-fencing.md:6476`
- **note**: `22222`

### [19]

- **classification**: `docMention`
- **locator**: `HANDOFF-2026-08-05-xw-explorer-session-fencing.md:6482`
- **note**: `ADB`

### [20]

- **classification**: `childProcessRef`
- **locator**: `HANDOFF-2026-08-05-xw-explorer-session-fencing.md:4650`
- **note**: `spawn`

### [21]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:1752`
- **note**: `ADB`

### [22]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:1759`
- **note**: `22222`

### [23]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:10896`
- **note**: `ADB`

### [24]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:13348`
- **note**: `adb`

### [25]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:14027`
- **note**: `22222`

### [26]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:17913`
- **note**: `22222`

### [27]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:22229`
- **note**: `ADB`

### [28]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:23639`
- **note**: `ADB`

### [29]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:24165`
- **note**: `ADB`

### [30]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:24361`
- **note**: `ADB`

### [31]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:27248`
- **note**: `ADB`

### [32]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:29382`
- **note**: `ADB`

### [33]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:29909`
- **note**: `ADB`

### [34]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:30143`
- **note**: `adb`

### [35]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:33626`
- **note**: `ADB`

### [36]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:33702`
- **note**: `adb`

### [37]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:35711`
- **note**: `ADB`

### [38]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:42482`
- **note**: `ADB`

### [39]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:42980`
- **note**: `adb`

### [40]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:45657`
- **note**: `ADB`

### [41]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:45693`
- **note**: `ADB`

### [42]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:45824`
- **note**: `ADB`

### [43]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:45975`
- **note**: `ADB`

### [44]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:55986`
- **note**: `22222`

### [45]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:55992`
- **note**: `ADB`

### [46]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:56312`
- **note**: `22222`

### [47]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:56318`
- **note**: `ADB`

### [48]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:60375`
- **note**: `adb`

### [49]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:60486`
- **note**: `adb`

### [50]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:62226`
- **note**: `22222`

### [51]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:63497`
- **note**: `22222`

### [52]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:70564`
- **note**: `GatewayOperator`

### [53]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:71312`
- **note**: `22222`

### [54]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:71575`
- **note**: `22222`

### [55]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:71617`
- **note**: `22222`

### [56]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:72904`
- **note**: `22222`

### [57]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:78668`
- **note**: `FastOperator`

### [58]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:78746`
- **note**: `adb`

### [59]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:78912`
- **note**: `FastOperator`

### [60]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:78925`
- **note**: `ADB`

### [61]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:78999`
- **note**: `ADB`

### [62]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:80284`
- **note**: `adb`

### [63]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:81296`
- **note**: `adb`

### [64]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:82345`
- **note**: `ADB`

### [65]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:92229`
- **note**: `22222`

### [66]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:92645`
- **note**: `22222`

### [67]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:92888`
- **note**: `22222`

### [68]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:98111`
- **note**: `22222`

### [69]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:106669`
- **note**: `22222`

### [70]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:106675`
- **note**: `ADB`

### [71]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:109798`
- **note**: `ADB`

### [72]

- **classification**: `docMention`
- **locator**: `PROGRESS.md:110135`
- **note**: `ADB`

### [73]

- **classification**: `childProcessRef`
- **locator**: `PROGRESS.md:17694`
- **note**: `spawn`

### [74]

- **classification**: `childProcessRef`
- **locator**: `PROGRESS.md:30940`
- **note**: `spawn`

### [75]

- **classification**: `childProcessRef`
- **locator**: `PROGRESS.md:30997`
- **note**: `spawn`

### [76]

- **classification**: `childProcessRef`
- **locator**: `PROGRESS.md:72202`
- **note**: `spawn`

### [77]

- **classification**: `docMention`
- **locator**: `README.md:335`
- **note**: `FastOperator`

### [78]

- **classification**: `docMention`
- **locator**: `README.md:399`
- **note**: `ADB`

### [79]

- **classification**: `docMention`
- **locator**: `README.md:1213`
- **note**: `adb`

### [80]

- **classification**: `docMention`
- **locator**: `README.md:1755`
- **note**: `FastOperator`

### [81]

- **classification**: `docMention`
- **locator**: `campaign/ARM-PROTOCOL.md:2722`
- **note**: `GatewayOperator`

### [82]

- **classification**: `docMention`
- **locator**: `contracts/workflows.v1.json:610`
- **note**: `22222`

### [83]

- **classification**: `docMention`
- **locator**: `contracts/workflows.v1.json:2199`
- **note**: `22222`

### [84]

- **classification**: `docMention`
- **locator**: `contracts/workflows.v1.json:2781`
- **note**: `22222`

### [85]

- **classification**: `docMention`
- **locator**: `contracts/workflows.v1.json:4964`
- **note**: `22222`

### [86]

- **classification**: `docMention`
- **locator**: `docs/grok-recipes-2026-07-28.md:1292`
- **note**: `22222`

### [87]

- **classification**: `childProcessRef`
- **locator**: `docs/grok-recipes-2026-07-28.md:610`
- **note**: `spawn`

### [88]

- **classification**: `docMention`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:1903`
- **note**: `22222`

### [89]

- **classification**: `docMention`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:4688`
- **note**: `ADB`

### [90]

- **classification**: `docMention`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:5120`
- **note**: `GatewayOperator`

### [91]

- **classification**: `docMention`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:5181`
- **note**: `22222`

### [92]

- **classification**: `docMention`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:5471`
- **note**: `GatewayOperator`

### [93]

- **classification**: `docMention`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:5917`
- **note**: `ADB`

### [94]

- **classification**: `docMention`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:5934`
- **note**: `adb`

### [95]

- **classification**: `docMention`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:6075`
- **note**: `adb`

### [96]

- **classification**: `docMention`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:7826`
- **note**: `ADB`

### [97]

- **classification**: `docMention`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:7849`
- **note**: `adb`

### [98]

- **classification**: `docMention`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:7856`
- **note**: `adb`

### [99]

- **classification**: `docMention`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:8825`
- **note**: `ADB`

### [100]

- **classification**: `docMention`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:10250`
- **note**: `GatewayOperator`

### [101]

- **classification**: `docMention`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:10332`
- **note**: `adb`

### [102]

- **classification**: `docMention`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:11047`
- **note**: `GatewayOperator`

### [103]

- **classification**: `docMention`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:11522`
- **note**: `adb`

### [104]

- **classification**: `docMention`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:12189`
- **note**: `22222`

### [105]

- **classification**: `docMention`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:12215`
- **note**: `adb`

### [106]

- **classification**: `docMention`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:12246`
- **note**: `adb`

### [107]

- **classification**: `docMention`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:12573`
- **note**: `GatewayOperator`

### [108]

- **classification**: `docMention`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:13075`
- **note**: `adb`

### [109]

- **classification**: `docMention`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:15518`
- **note**: `22222`

### [110]

- **classification**: `docMention`
- **locator**: `docs/observer-api-20260729.md:2634`
- **note**: `ADB`

### [111]

- **classification**: `docMention`
- **locator**: `docs/observer-api-20260729.md:7320`
- **note**: `22222`

### [112]

- **classification**: `docMention`
- **locator**: `docs/observer-api-20260729.md:7328`
- **note**: `ADB`

### [113]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-07-28-silk-smooth-feishu-xianyu-codex-plan.md:2359`
- **note**: `GatewayOperator`

### [114]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-07-28-silk-smooth-feishu-xianyu-codex-plan.md:2911`
- **note**: `22222`

### [115]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-07-28-silk-smooth-feishu-xianyu-codex-plan.md:5876`
- **note**: `22222`

### [116]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-07-28-silk-smooth-feishu-xianyu-codex-plan.md:6532`
- **note**: `GatewayOperator`

### [117]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-07-28-silk-smooth-feishu-xianyu-codex-plan.md:6563`
- **note**: `adb`

### [118]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-07-28-silk-smooth-feishu-xianyu-codex-plan.md:9224`
- **note**: `adb`

### [119]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-07-28-silk-smooth-feishu-xianyu-codex-plan.md:18364`
- **note**: `22222`

### [120]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.md:3902`
- **note**: `22222`

### [121]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.md:12230`
- **note**: `22222`

### [122]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.md:12290`
- **note**: `22222`

### [123]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.md:13073`
- **note**: `22222`

### [124]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.md:14122`
- **note**: `22222`

### [125]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.md:23625`
- **note**: `22222`

### [126]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-01-review-explorer-payment-only-gate-plan.md:53243`
- **note**: `22222`

### [127]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-01-rex-phase2-to-8-handoff.md:7021`
- **note**: `FastOperator`

### [128]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-01-rex-phase2-to-8-handoff.md:7776`
- **note**: `22222`

### [129]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-02-rex-phase5-takeover-handoff.md:2316`
- **note**: `FastOperator`

### [130]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-02-rex-phase5-takeover-handoff.md:2487`
- **note**: `FastOperator`

### [131]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-02-rex-phase5-takeover-handoff.md:11875`
- **note**: `FastOperator`

### [132]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-05-xw-trusted-loop-execution-plan.md:1029`
- **note**: `GatewayOperator`

### [133]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-05-xw-trusted-loop-execution-plan.md:6754`
- **note**: `22222`

### [134]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-06-explorer-budget-cross-device-circuit-breaker-v1.md:7718`
- **note**: `ADB`

### [135]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-06-explorer-budget-cross-device-circuit-breaker-v1.md:7722`
- **note**: `22222`

### [136]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-06-explorer-budget-cross-device-circuit-breaker-v1.md:10518`
- **note**: `GatewayOperator`

### [137]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-06-explorer-budget-cross-device-circuit-breaker-v1.md:10534`
- **note**: `ADB`

### [138]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-06-explorer-budget-cross-device-circuit-breaker-v1.md:10538`
- **note**: `22222`

### [139]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-06-xw-multi-device-orchestration-v2.md:2808`
- **note**: `22222`

### [140]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-06-xw-multi-device-orchestration-v2.md:8864`
- **note**: `22222`

### [141]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-06-xw-multi-device-orchestration-v2.md:10609`
- **note**: `22222`

### [142]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-06-xw-multi-device-orchestration-v2.md:13510`
- **note**: `GatewayOperator`

### [143]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-06-xw-multi-device-orchestration-v2.md:14814`
- **note**: `22222`

### [144]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-06-xw-multi-device-orchestration-v2.md:16229`
- **note**: `FastOperator`

### [145]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-06-xw-multi-device-orchestration-v2.md:16384`
- **note**: `22222`

### [146]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-06-xw-task-design.md:469`
- **note**: `ADB`

### [147]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-06-xw-task-design.md:473`
- **note**: `GatewayOperator`

### [148]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-08-foundation-pr2-baseline.md:1516`
- **note**: `adb`

### [149]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-08-foundation-pr2.files.json:710`
- **note**: `FastOperator`

### [150]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-08-foundation-pr3-baseline.md:744`
- **note**: `FastOperator`

### [151]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:6464`
- **note**: `22222`

### [152]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:6470`
- **note**: `ADB`

### [153]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:21199`
- **note**: `ADB`

### [154]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:21204`
- **note**: `GatewayOperator`

### [155]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:29749`
- **note**: `22222`

### [156]

- **classification**: `docMention`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:30245`
- **note**: `22222`

### [157]

- **classification**: `childProcessRef`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:46786`
- **note**: `spawn`

### [158]

- **classification**: `childProcessRef`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:48082`
- **note**: `spawn`

### [159]

- **classification**: `docMention`
- **locator**: `docs/platform/m0/public/xw-m0-20260817-r0/runtime-attestation.device-agent.v1.json:358`
- **note**: `ADB`

### [160]

- **classification**: `docMention`
- **locator**: `docs/platform/m0/public/xw-m0-20260817-r0/runtime-attestation.device-agent.v1.json:362`
- **note**: `22222`

### [161]

- **classification**: `childProcessRef`
- **locator**: `import-knowledge.mjs:418`
- **note**: `execFileSync`

### [162]

- **classification**: `childProcessRef`
- **locator**: `import-knowledge.mjs:444`
- **note**: `child_process`

### [163]

- **classification**: `childProcessRef`
- **locator**: `import-knowledge.mjs:1002`
- **note**: `execFileSync`

### [164]

- **classification**: `docMention`
- **locator**: `knowledge-seed-campaign-20260727.json:280`
- **note**: `22222`

### [165]

- **classification**: `docMention`
- **locator**: `knowledge-seed-core.json:1636`
- **note**: `22222`

### [166]

- **classification**: `docMention`
- **locator**: `knowledge-seed-core.json:1696`
- **note**: `22222`

### [167]

- **classification**: `docMention`
- **locator**: `knowledge-seed-core.json:1800`
- **note**: `22222`

### [168]

- **classification**: `docMention`
- **locator**: `knowledge-seed-core.json:2092`
- **note**: `adb`

### [169]

- **classification**: `docMention`
- **locator**: `knowledge-seed-core.json:2278`
- **note**: `adb`

### [170]

- **classification**: `docMention`
- **locator**: `knowledge-seed-device-capabilities-20260728.json:1331`
- **note**: `22222`

### [171]

- **classification**: `docMention`
- **locator**: `knowledge-seed-device-capabilities-20260728.json:1653`
- **note**: `22222`

### [172]

- **classification**: `docMention`
- **locator**: `knowledge-seed-device-capabilities-20260728.json:1872`
- **note**: `22222`

### [173]

- **classification**: `docMention`
- **locator**: `knowledge-seed-explorer-lease-hard-gate-20260805.json:331`
- **note**: `22222`

### [174]

- **classification**: `docMention`
- **locator**: `knowledge-seed-explorer-lease-hard-gate-20260805.json:337`
- **note**: `ADB`

### [175]

- **classification**: `docMention`
- **locator**: `knowledge-seed-explorer-lease-hard-gate-20260805.json:563`
- **note**: `22222`

### [176]

- **classification**: `docMention`
- **locator**: `knowledge-seed-explorer-lease-hard-gate-20260805.json:569`
- **note**: `ADB`

### [177]

- **classification**: `childProcessRef`
- **locator**: `knowledge-seed-feishu-to-xianyu-20260728.json:2537`
- **note**: `execFileSync`

### [178]

- **classification**: `docMention`
- **locator**: `knowledge-seed-from-records.json:4464`
- **note**: `GatewayOperator`

### [179]

- **classification**: `childProcessRef`
- **locator**: `knowledge-seed-xhs-compose-20260813.json:1759`
- **note**: `spawn`

### [180]

- **classification**: `childProcessRef`
- **locator**: `knowledge-seed-xhs-compose-20260813.json:2236`
- **note**: `spawn`

### [181]

- **classification**: `docMention`
- **locator**: `knowledge-seed-xhs-compose-conc4-20260813.json:518`
- **note**: `22222`

### [182]

- **classification**: `docMention`
- **locator**: `knowledge-seed-xhs-compose-conc4-20260813.json:2001`
- **note**: `ADB`

### [183]

- **classification**: `docMention`
- **locator**: `knowledge-seed-xhs-compose-conc4-20260813.json:2339`
- **note**: `ADB`

### [184]

- **classification**: `docMention`
- **locator**: `knowledge-seed-xhs-compose-conc4-20260813.json:2632`
- **note**: `22222`

### [185]

- **classification**: `docMention`
- **locator**: `knowledge-seed-xhs-compose-conc4-20260813.json:2669`
- **note**: `ADB`

### [186]

- **classification**: `docMention`
- **locator**: `knowledge-seed-xhs-compose-conc4-20260813.json:2948`
- **note**: `ADB`

### [187]

- **classification**: `docMention`
- **locator**: `knowledge-seed-xhs-compose-conc4-20260813.json:5151`
- **note**: `ADB`

### [188]

- **classification**: `docMention`
- **locator**: `knowledge-seed-xhs-compose-conc4-20260813.json:5719`
- **note**: `22222`

### [189]

- **classification**: `docMention`
- **locator**: `knowledge-seed-xhs-compose-conc4-20260813.json:6565`
- **note**: `ADB`

### [190]

- **classification**: `docMention`
- **locator**: `modes/explorer.md:2270`
- **note**: `22222`

### [191]

- **classification**: `docMention`
- **locator**: `modes/explorer.md:3042`
- **note**: `adb`

### [192]

- **classification**: `docMention`
- **locator**: `modes/explorer.md:3962`
- **note**: `GatewayOperator`

### [193]

- **classification**: `docMention`
- **locator**: `modes/governance.md:5897`
- **note**: `22222`

### [194]

- **classification**: `docMention`
- **locator**: `ops/ACCEPTANCE-LOCAL-WIN.md:277`
- **note**: `22222`

### [195]

- **classification**: `docMention`
- **locator**: `ops/ACCEPTANCE-SKILL-SERIAL.md:458`
- **note**: `22222`

### [196]

- **classification**: `childProcessRef`
- **locator**: `ops/_biz-trace.mjs:339`
- **note**: `execFileSync`

### [197]

- **classification**: `childProcessRef`
- **locator**: `ops/_biz-trace.mjs:461`
- **note**: `execFileSync`

### [198]

- **classification**: `childProcessRef`
- **locator**: `ops/_biz-trace.mjs:682`
- **note**: `execFileSync`

### [199]

- **classification**: `childProcessRef`
- **locator**: `ops/_biz-trace.mjs:708`
- **note**: `child_process`

### [200]

- **classification**: `childProcessRef`
- **locator**: `ops/_biz-trace.mjs:3246`
- **note**: `execFileSync`

### [201]

- **classification**: `childProcessRef`
- **locator**: `ops/_biz-trace.mjs:3694`
- **note**: `execFileSync`

### [202]

- **classification**: `childProcessRef`
- **locator**: `ops/_explore-lease.mjs:302`
- **note**: `execFileSync`

### [203]

- **classification**: `childProcessRef`
- **locator**: `ops/_explore-lease.mjs:328`
- **note**: `child_process`

### [204]

- **classification**: `childProcessRef`
- **locator**: `ops/_explore-lease.mjs:7504`
- **note**: `execFileSync`

### [205]

- **classification**: `deviceControlRef`
- **locator**: `ops/_explore-lib.mjs:2766`
- **note**: `22222`

### [206]

- **classification**: `deviceControlRef`
- **locator**: `ops/_explore-lib.mjs:6205`
- **note**: `adb`

### [207]

- **classification**: `deviceControlRef`
- **locator**: `ops/_explore-lib.mjs:7789`
- **note**: `22222`

### [208]

- **classification**: `deviceControlRef`
- **locator**: `ops/_explore-lib.mjs:7795`
- **note**: `ADB`

### [209]

- **classification**: `deviceControlRef`
- **locator**: `ops/_explore-lib.mjs:7886`
- **note**: `adb`

### [210]

- **classification**: `deviceControlRef`
- **locator**: `ops/_explore-lib.mjs:9797`
- **note**: `22222`

### [211]

- **classification**: `childProcessRef`
- **locator**: `ops/_explore-lib.mjs:120`
- **note**: `execFileSync`

### [212]

- **classification**: `childProcessRef`
- **locator**: `ops/_explore-lib.mjs:146`
- **note**: `child_process`

### [213]

- **classification**: `childProcessRef`
- **locator**: `ops/_explore-lib.mjs:3133`
- **note**: `execFileSync`

### [214]

- **classification**: `childProcessRef`
- **locator**: `ops/_explore-lib.mjs:3373`
- **note**: `execFileSync`

### [215]

- **classification**: `childProcessRef`
- **locator**: `ops/_explore-lib.mjs:4121`
- **note**: `execFileSync`

### [216]

- **classification**: `childProcessRef`
- **locator**: `ops/_explore-lib.mjs:6940`
- **note**: `execFileSync`

### [217]

- **classification**: `childProcessRef`
- **locator**: `ops/_explore-lib.mjs:7268`
- **note**: `execFileSync`

### [218]

- **classification**: `childProcessRef`
- **locator**: `ops/_explore-lib.mjs:9415`
- **note**: `execFileSync`

### [219]

- **classification**: `deviceControlRef`
- **locator**: `ops/_explore-session-action.mjs:4316`
- **note**: `22222`

### [220]

- **classification**: `deviceControlRef`
- **locator**: `ops/_explore-session-action.mjs:4322`
- **note**: `ADB`

### [221]

- **classification**: `childProcessRef`
- **locator**: `ops/_llm-comment-gate.mjs:236`
- **note**: `child_process`

### [222]

- **classification**: `childProcessRef`
- **locator**: `ops/_trace-pitfall.mjs:967`
- **note**: `child_process`

### [223]

- **classification**: `childProcessRef`
- **locator**: `ops/_trace-pitfall.mjs:1116`
- **note**: `execFileSync`

### [224]

- **classification**: `childProcessRef`
- **locator**: `ops/_trace-pitfall.mjs:1142`
- **note**: `child_process`

### [225]

- **classification**: `childProcessRef`
- **locator**: `ops/_trace-pitfall.mjs:5831`
- **note**: `execFileSync`

### [226]

- **classification**: `childProcessRef`
- **locator**: `ops/_trace-pitfall.mjs:6292`
- **note**: `execFileSync`

### [227]

- **classification**: `deviceControlRef`
- **locator**: `ops/_win-screencap.mjs:29`
- **note**: `22222`

### [228]

- **classification**: `deviceControlRef`
- **locator**: `ops/_win-screencap.mjs:39`
- **note**: `adb`

### [229]

- **classification**: `deviceControlRef`
- **locator**: `ops/_win-screencap.mjs:2148`
- **note**: `22222`

### [230]

- **classification**: `deviceControlRef`
- **locator**: `ops/_win-screencap.mjs:3619`
- **note**: `adb`

### [231]

- **classification**: `deviceControlRef`
- **locator**: `ops/_win-screencap.mjs:3655`
- **note**: `adb`

### [232]

- **classification**: `deviceControlRef`
- **locator**: `ops/_win-screencap.mjs:3671`
- **note**: `adb`

### [233]

- **classification**: `deviceControlRef`
- **locator**: `ops/_win-screencap.mjs:3706`
- **note**: `adb`

### [234]

- **classification**: `deviceControlRef`
- **locator**: `ops/_win-screencap.mjs:3784`
- **note**: `adb`

### [235]

- **classification**: `deviceControlRef`
- **locator**: `ops/_win-screencap.mjs:3825`
- **note**: `adb`

### [236]

- **classification**: `deviceControlRef`
- **locator**: `ops/_win-screencap.mjs:3863`
- **note**: `adb`

### [237]

- **classification**: `deviceControlRef`
- **locator**: `ops/_win-screencap.mjs:3870`
- **note**: `adb`

### [238]

- **classification**: `deviceControlRef`
- **locator**: `ops/_win-screencap.mjs:3938`
- **note**: `adb`

### [239]

- **classification**: `deviceControlRef`
- **locator**: `ops/_win-screencap.mjs:4008`
- **note**: `adb`

### [240]

- **classification**: `deviceControlRef`
- **locator**: `ops/_win-screencap.mjs:4030`
- **note**: `adb`

### [241]

- **classification**: `deviceControlRef`
- **locator**: `ops/_win-screencap.mjs:4150`
- **note**: `adb`

### [242]

- **classification**: `deviceControlRef`
- **locator**: `ops/_win-screencap.mjs:4331`
- **note**: `adb`

### [243]

- **classification**: `deviceControlRef`
- **locator**: `ops/_win-screencap.mjs:4485`
- **note**: `adb`

### [244]

- **classification**: `deviceControlRef`
- **locator**: `ops/_win-screencap.mjs:4531`
- **note**: `adb`

### [245]

- **classification**: `deviceControlRef`
- **locator**: `ops/_win-screencap.mjs:4537`
- **note**: `adb`

### [246]

- **classification**: `deviceControlRef`
- **locator**: `ops/_win-screencap.mjs:4881`
- **note**: `adb`

### [247]

- **classification**: `childProcessRef`
- **locator**: `ops/_win-screencap.mjs:123`
- **note**: `execFileSync`

### [248]

- **classification**: `childProcessRef`
- **locator**: `ops/_win-screencap.mjs:149`
- **note**: `child_process`

### [249]

- **classification**: `childProcessRef`
- **locator**: `ops/_win-screencap.mjs:3801`
- **note**: `execFileSync`

### [250]

- **classification**: `childProcessRef`
- **locator**: `ops/_win-screencap.mjs:4137`
- **note**: `execFileSync`

### [251]

- **classification**: `childProcessRef`
- **locator**: `ops/_win-screencap.mjs:4318`
- **note**: `execFileSync`

### [252]

- **classification**: `deviceControlRef`
- **locator**: `ops/_win-xiaowei.mjs:42`
- **note**: `22222`

### [253]

- **classification**: `deviceControlRef`
- **locator**: `ops/_win-xiaowei.mjs:4873`
- **note**: `22222`

### [254]

- **classification**: `deviceControlRef`
- **locator**: `ops/conc2-full-dry-run.mjs:638`
- **note**: `22222`

### [255]

- **classification**: `childProcessRef`
- **locator**: `ops/conc2-full-dry-run.mjs:143`
- **note**: `child_process`

### [256]

- **classification**: `childProcessRef`
- **locator**: `ops/conc4-full-dry-run.mjs:481`
- **note**: `execFileSync`

### [257]

- **classification**: `childProcessRef`
- **locator**: `ops/conc4-full-dry-run.mjs:507`
- **note**: `child_process`

### [258]

- **classification**: `childProcessRef`
- **locator**: `ops/conc4-full-dry-run.mjs:3015`
- **note**: `execFileSync`

### [259]

- **classification**: `childProcessRef`
- **locator**: `ops/conc4-full-dry-run.mjs:3386`
- **note**: `execFileSync`

### [260]

- **classification**: `childProcessRef`
- **locator**: `ops/conc4-full-dry-run.mjs:8048`
- **note**: `execFileSync`

### [261]

- **classification**: `deviceControlRef`
- **locator**: `ops/douyin-collect-set.mjs:3868`
- **note**: `22222`

### [262]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-collect-set.mjs:446`
- **note**: `spawn`

### [263]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-collect-set.mjs:465`
- **note**: `child_process`

### [264]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-collect-set.mjs:1848`
- **note**: `spawn`

### [265]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-collect.mjs:496`
- **note**: `spawn`

### [266]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-collect.mjs:515`
- **note**: `child_process`

### [267]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-collect.mjs:1925`
- **note**: `spawn`

### [268]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-comment-copy-top.mjs:565`
- **note**: `spawn`

### [269]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-comment-copy-top.mjs:584`
- **note**: `child_process`

### [270]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-comment-copy-top.mjs:2077`
- **note**: `spawn`

### [271]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-explore-watch.mjs:410`
- **note**: `child_process`

### [272]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-follow-set.mjs:224`
- **note**: `spawn`

### [273]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-follow-set.mjs:243`
- **note**: `child_process`

### [274]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-follow-set.mjs:1553`
- **note**: `spawn`

### [275]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-follow.mjs:284`
- **note**: `spawn`

### [276]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-follow.mjs:303`
- **note**: `child_process`

### [277]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-follow.mjs:1662`
- **note**: `spawn`

### [278]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-free-explore-paced.mjs:381`
- **note**: `spawn`

### [279]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-free-explore-paced.mjs:400`
- **note**: `child_process`

### [280]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-free-explore-paced.mjs:2689`
- **note**: `spawn`

### [281]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-harvest-share-links.mjs:536`
- **note**: `child_process`

### [282]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-like-set.mjs:216`
- **note**: `spawn`

### [283]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-like-set.mjs:235`
- **note**: `child_process`

### [284]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-like-set.mjs:1541`
- **note**: `spawn`

### [285]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-like.mjs:631`
- **note**: `spawn`

### [286]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-like.mjs:650`
- **note**: `child_process`

### [287]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-like.mjs:2048`
- **note**: `spawn`

### [288]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-live-bulk-download.mjs:510`
- **note**: `child_process`

### [289]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-play-once.mjs:531`
- **note**: `spawn`

### [290]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-play-once.mjs:550`
- **note**: `child_process`

### [291]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-play-once.mjs:2022`
- **note**: `spawn`

### [292]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-rail-set.mjs:267`
- **note**: `spawn`

### [293]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-rail-set.mjs:286`
- **note**: `child_process`

### [294]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-rail-set.mjs:1894`
- **note**: `spawn`

### [295]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-search.mjs:485`
- **note**: `child_process`

### [296]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-search.mjs:769`
- **note**: `spawn`

### [297]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-search.mjs:788`
- **note**: `child_process`

### [298]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-search.mjs:2296`
- **note**: `spawn`

### [299]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-search.mjs:3305`
- **note**: `execFileSync`

### [300]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-share-friend-consec.mjs:253`
- **note**: `child_process`

### [301]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-share-friend-harvest.mjs:496`
- **note**: `child_process`

### [302]

- **classification**: `childProcessRef`
- **locator**: `ops/douyin-xj-live-pipeline-smoke.mjs:411`
- **note**: `child_process`

### [303]

- **classification**: `deviceControlRef`
- **locator**: `ops/explore-preflight.mjs:900`
- **note**: `22222`

### [304]

- **classification**: `deviceControlRef`
- **locator**: `ops/explore-preflight.mjs:1772`
- **note**: `22222`

### [305]

- **classification**: `deviceControlRef`
- **locator**: `ops/explore-preflight.mjs:1948`
- **note**: `22222`

### [306]

- **classification**: `deviceControlRef`
- **locator**: `ops/explore-preflight.mjs:5372`
- **note**: `22222`

### [307]

- **classification**: `deviceControlRef`
- **locator**: `ops/explore-preflight.mjs:5487`
- **note**: `22222`

### [308]

- **classification**: `deviceControlRef`
- **locator**: `ops/explore-preflight.mjs:5540`
- **note**: `22222`

### [309]

- **classification**: `deviceControlRef`
- **locator**: `ops/explore-preflight.mjs:5601`
- **note**: `22222`

### [310]

- **classification**: `deviceControlRef`
- **locator**: `ops/explore-preflight.mjs:5672`
- **note**: `22222`

### [311]

- **classification**: `childProcessRef`
- **locator**: `ops/explore-preflight.mjs:236`
- **note**: `execFileSync`

### [312]

- **classification**: `childProcessRef`
- **locator**: `ops/explore-preflight.mjs:262`
- **note**: `child_process`

### [313]

- **classification**: `childProcessRef`
- **locator**: `ops/explore-preflight.mjs:1721`
- **note**: `execFileSync`

### [314]

- **classification**: `childProcessRef`
- **locator**: `ops/explore-preflight.mjs:1874`
- **note**: `execFileSync`

### [315]

- **classification**: `childProcessRef`
- **locator**: `ops/feishu-mark-xianyu-published.mjs:599`
- **note**: `child_process`

### [316]

- **classification**: `deviceControlRef`
- **locator**: `ops/feishu-to-xhs-publish.mjs:53`
- **note**: `ADB`

### [317]

- **classification**: `deviceControlRef`
- **locator**: `ops/feishu-to-xhs-publish.mjs:1132`
- **note**: `ADB`

### [318]

- **classification**: `deviceControlRef`
- **locator**: `ops/feishu-to-xhs-publish.mjs:1212`
- **note**: `adb`

### [319]

- **classification**: `deviceControlRef`
- **locator**: `ops/feishu-to-xhs-publish.mjs:5922`
- **note**: `ADB`

### [320]

- **classification**: `deviceControlRef`
- **locator**: `ops/feishu-to-xhs-publish.mjs:6001`
- **note**: `adb`

### [321]

- **classification**: `deviceControlRef`
- **locator**: `ops/feishu-to-xhs-publish.mjs:6141`
- **note**: `ADB`

### [322]

- **classification**: `deviceControlRef`
- **locator**: `ops/feishu-to-xhs-publish.mjs:6218`
- **note**: `ADB`

### [323]

- **classification**: `deviceControlRef`
- **locator**: `ops/feishu-to-xhs-publish.mjs:6660`
- **note**: `ADB`

### [324]

- **classification**: `deviceControlRef`
- **locator**: `ops/feishu-to-xhs-publish.mjs:6737`
- **note**: `ADB`

### [325]

- **classification**: `childProcessRef`
- **locator**: `ops/feishu-to-xhs-publish.mjs:326`
- **note**: `execFileSync`

### [326]

- **classification**: `childProcessRef`
- **locator**: `ops/feishu-to-xhs-publish.mjs:352`
- **note**: `child_process`

### [327]

- **classification**: `childProcessRef`
- **locator**: `ops/feishu-to-xhs-publish.mjs:2949`
- **note**: `execFileSync`

### [328]

- **classification**: `childProcessRef`
- **locator**: `ops/feishu-to-xianyu-idle-batch.mjs:308`
- **note**: `execFileSync`

### [329]

- **classification**: `childProcessRef`
- **locator**: `ops/feishu-to-xianyu-idle-batch.mjs:334`
- **note**: `child_process`

### [330]

- **classification**: `childProcessRef`
- **locator**: `ops/feishu-to-xianyu-idle-batch.mjs:2828`
- **note**: `execFileSync`

### [331]

- **classification**: `childProcessRef`
- **locator**: `ops/feishu-to-xianyu-idle-batch.mjs:3303`
- **note**: `execFileSync`

### [332]

- **classification**: `childProcessRef`
- **locator**: `ops/feishu-to-xianyu-idle-lib.mjs:151`
- **note**: `child_process`

### [333]

- **classification**: `deviceControlRef`
- **locator**: `ops/feishu-to-xianyu-idle-publish.mjs:4343`
- **note**: `ADB`

### [334]

- **classification**: `deviceControlRef`
- **locator**: `ops/feishu-to-xianyu-idle-publish.mjs:4423`
- **note**: `adb`

### [335]

- **classification**: `deviceControlRef`
- **locator**: `ops/feishu-to-xianyu-idle-publish.mjs:5813`
- **note**: `ADB`

### [336]

- **classification**: `deviceControlRef`
- **locator**: `ops/feishu-to-xianyu-idle-publish.mjs:10856`
- **note**: `adb`

### [337]

- **classification**: `deviceControlRef`
- **locator**: `ops/feishu-to-xianyu-idle-publish.mjs:10927`
- **note**: `ADB`

### [338]

- **classification**: `deviceControlRef`
- **locator**: `ops/feishu-to-xianyu-idle-publish.mjs:12334`
- **note**: `ADB`

### [339]

- **classification**: `deviceControlRef`
- **locator**: `ops/feishu-to-xianyu-idle-publish.mjs:12756`
- **note**: `ADB`

### [340]

- **classification**: `deviceControlRef`
- **locator**: `ops/feishu-to-xianyu-idle-publish.mjs:24827`
- **note**: `adb`

### [341]

- **classification**: `deviceControlRef`
- **locator**: `ops/feishu-to-xianyu-idle-publish.mjs:32885`
- **note**: `ADB`

### [342]

- **classification**: `childProcessRef`
- **locator**: `ops/feishu-to-xianyu-idle-publish.mjs:591`
- **note**: `execFileSync`

### [343]

- **classification**: `childProcessRef`
- **locator**: `ops/feishu-to-xianyu-idle-publish.mjs:627`
- **note**: `child_process`

### [344]

- **classification**: `childProcessRef`
- **locator**: `ops/feishu-to-xianyu-idle-publish.mjs:11216`
- **note**: `execFileSync`

### [345]

- **classification**: `childProcessRef`
- **locator**: `ops/feishu-to-xianyu-idle-publish.mjs:11404`
- **note**: `execFileSync`

### [346]

- **classification**: `childProcessRef`
- **locator**: `ops/feishu-to-xianyu-idle-publish.mjs:11767`
- **note**: `execFileSync`

### [347]

- **classification**: `childProcessRef`
- **locator**: `ops/feishu-to-xianyu-idle-publish.mjs:12321`
- **note**: `execFileSync`

### [348]

- **classification**: `childProcessRef`
- **locator**: `ops/feishu-to-xianyu.mjs:997`
- **note**: `execFileSync`

### [349]

- **classification**: `childProcessRef`
- **locator**: `ops/feishu-to-xianyu.mjs:1023`
- **note**: `child_process`

### [350]

- **classification**: `childProcessRef`
- **locator**: `ops/feishu-to-xianyu.mjs:4932`
- **note**: `execFileSync`

### [351]

- **classification**: `childProcessRef`
- **locator**: `ops/feishu-to-xianyu.mjs:5926`
- **note**: `execFileSync`

### [352]

- **classification**: `childProcessRef`
- **locator**: `ops/feishu-to-xianyu.mjs:6314`
- **note**: `execFileSync`

### [353]

- **classification**: `childProcessRef`
- **locator**: `ops/feishu-to-xianyu.mjs:16641`
- **note**: `execFileSync`

### [354]

- **classification**: `deviceControlRef`
- **locator**: `ops/input-text.mjs:73`
- **note**: `22222`

### [355]

- **classification**: `deviceControlRef`
- **locator**: `ops/input-text.mjs:883`
- **note**: `adb`

### [356]

- **classification**: `childProcessRef`
- **locator**: `ops/recover-main-safe.mjs:632`
- **note**: `child_process`

### [357]

- **classification**: `deviceControlRef`
- **locator**: `ops/screenshot-and-analyze.mjs:1319`
- **note**: `22222`

### [358]

- **classification**: `deviceControlRef`
- **locator**: `ops/screenshot-and-analyze.mjs:1325`
- **note**: `ADB`

### [359]

- **classification**: `childProcessRef`
- **locator**: `ops/screenshot-and-analyze.mjs:321`
- **note**: `execFileSync`

### [360]

- **classification**: `childProcessRef`
- **locator**: `ops/screenshot-and-analyze.mjs:347`
- **note**: `child_process`

### [361]

- **classification**: `childProcessRef`
- **locator**: `ops/screenshot-and-analyze.mjs:2775`
- **note**: `execFileSync`

### [362]

- **classification**: `deviceControlRef`
- **locator**: `ops/shell.mjs:283`
- **note**: `adb`

### [363]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-collect-one.mjs:268`
- **note**: `spawn`

### [364]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-collect-one.mjs:287`
- **note**: `child_process`

### [365]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-collect-one.mjs:1666`
- **note**: `spawn`

### [366]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-collect-one.mjs:2696`
- **note**: `execFileSync`

### [367]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-comment-copy-top.mjs:438`
- **note**: `spawn`

### [368]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-comment-copy-top.mjs:457`
- **note**: `child_process`

### [369]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-comment-copy-top.mjs:684`
- **note**: `child_process`

### [370]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-comment-copy-top.mjs:2204`
- **note**: `spawn`

### [371]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-comment-one.mjs:356`
- **note**: `spawn`

### [372]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-comment-one.mjs:375`
- **note**: `child_process`

### [373]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-comment-one.mjs:1838`
- **note**: `spawn`

### [374]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-comment-one.mjs:2831`
- **note**: `execFileSync`

### [375]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-dm-open.mjs:596`
- **note**: `spawn`

### [376]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-dm-open.mjs:615`
- **note**: `child_process`

### [377]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-dm-open.mjs:2153`
- **note**: `spawn`

### [378]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-dm-open.mjs:3167`
- **note**: `execFileSync`

### [379]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-dm-user.mjs:290`
- **note**: `spawn`

### [380]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-dm-user.mjs:309`
- **note**: `child_process`

### [381]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-dm-user.mjs:1767`
- **note**: `spawn`

### [382]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-dm-user.mjs:2786`
- **note**: `execFileSync`

### [383]

- **classification**: `deviceControlRef`
- **locator**: `ops/xhs-engage-one.mjs:6974`
- **note**: `22222`

### [384]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-engage-one.mjs:636`
- **note**: `spawn`

### [385]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-engage-one.mjs:655`
- **note**: `child_process`

### [386]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-engage-one.mjs:2556`
- **note**: `spawn`

### [387]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-engage-one.mjs:3607`
- **note**: `execFileSync`

### [388]

- **classification**: `deviceControlRef`
- **locator**: `ops/xhs-follow-one.mjs:395`
- **note**: `22222`

### [389]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-follow-one.mjs:2042`
- **note**: `execFileSync`

### [390]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-free-explore-health.mjs:429`
- **note**: `child_process`

### [391]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-free-explore-paced.mjs:329`
- **note**: `spawn`

### [392]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-free-explore-paced.mjs:348`
- **note**: `child_process`

### [393]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-free-explore-paced.mjs:2029`
- **note**: `spawn`

### [394]

- **classification**: `deviceControlRef`
- **locator**: `ops/xhs-like-one.mjs:375`
- **note**: `22222`

### [395]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-like-one.mjs:2045`
- **note**: `execFileSync`

### [396]

- **classification**: `deviceControlRef`
- **locator**: `ops/xhs-publish-draft.mjs:8315`
- **note**: `22222`

### [397]

- **classification**: `deviceControlRef`
- **locator**: `ops/xhs-publish-draft.mjs:12690`
- **note**: `22222`

### [398]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-publish-draft.mjs:426`
- **note**: `spawn`

### [399]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-publish-draft.mjs:445`
- **note**: `child_process`

### [400]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-publish-draft.mjs:1835`
- **note**: `spawn`

### [401]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-publish-draft.mjs:2860`
- **note**: `execFileSync`

### [402]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-publish-entry.mjs:408`
- **note**: `spawn`

### [403]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-publish-entry.mjs:427`
- **note**: `child_process`

### [404]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-publish-entry.mjs:1757`
- **note**: `spawn`

### [405]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-publish-entry.mjs:2782`
- **note**: `execFileSync`

### [406]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-save-draft.mjs:329`
- **note**: `spawn`

### [407]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-save-draft.mjs:348`
- **note**: `child_process`

### [408]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-save-draft.mjs:1844`
- **note**: `spawn`

### [409]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-search.mjs:335`
- **note**: `spawn`

### [410]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-search.mjs:354`
- **note**: `child_process`

### [411]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-search.mjs:2049`
- **note**: `spawn`

### [412]

- **classification**: `childProcessRef`
- **locator**: `ops/xhs-search.mjs:2971`
- **note**: `execFileSync`

### [413]

- **classification**: `childProcessRef`
- **locator**: `ops/xianyu-discard-compose.mjs:304`
- **note**: `execFileSync`

### [414]

- **classification**: `childProcessRef`
- **locator**: `ops/xianyu-discard-compose.mjs:330`
- **note**: `child_process`

### [415]

- **classification**: `childProcessRef`
- **locator**: `ops/xianyu-discard-compose.mjs:2346`
- **note**: `execFileSync`

### [416]

- **classification**: `childProcessRef`
- **locator**: `ops/xianyu-discard-compose.mjs:10976`
- **note**: `execFileSync`

### [417]

- **classification**: `childProcessRef`
- **locator**: `ops/xianyu-dismiss-tuoguan.mjs:197`
- **note**: `execFileSync`

### [418]

- **classification**: `childProcessRef`
- **locator**: `ops/xianyu-dismiss-tuoguan.mjs:223`
- **note**: `child_process`

### [419]

- **classification**: `childProcessRef`
- **locator**: `ops/xianyu-dismiss-tuoguan.mjs:1426`
- **note**: `execFileSync`

### [420]

- **classification**: `childProcessRef`
- **locator**: `ops/xianyu-published-metrics.mjs:550`
- **note**: `child_process`

### [421]

- **classification**: `childProcessRef`
- **locator**: `ops/xw-closeout.mjs:1168`
- **note**: `execFileSync`

### [422]

- **classification**: `childProcessRef`
- **locator**: `ops/xw-closeout.mjs:1194`
- **note**: `child_process`

### [423]

- **classification**: `childProcessRef`
- **locator**: `ops/xw-closeout.mjs:19187`
- **note**: `execFileSync`

### [424]

- **classification**: `childProcessRef`
- **locator**: `ops/xw-closeout.mjs:72576`
- **note**: `execFileSync`

### [425]

- **classification**: `childProcessRef`
- **locator**: `ops/xw-closeout.mjs:105306`
- **note**: `execFileSync`

### [426]

- **classification**: `childProcessRef`
- **locator**: `ops/xw-closeout.mjs:106039`
- **note**: `execFileSync`

### [427]

- **classification**: `childProcessRef`
- **locator**: `ops/xw-closeout.mjs:133799`
- **note**: `execFileSync`

### [428]

- **classification**: `childProcessRef`
- **locator**: `ops/xw-evolve-replay-once.mjs:609`
- **note**: `child_process`

### [429]

- **classification**: `childProcessRef`
- **locator**: `ops/xw-locator.mjs:443`
- **note**: `child_process`

### [430]

- **classification**: `childProcessRef`
- **locator**: `ops/xw-ops-health.mjs:522`
- **note**: `child_process`

### [431]

- **classification**: `childProcessRef`
- **locator**: `ops/xw-session-canary-noop.mjs:510`
- **note**: `spawn`

### [432]

- **classification**: `childProcessRef`
- **locator**: `ops/xw-session-canary-noop.mjs:529`
- **note**: `child_process`

### [433]

- **classification**: `childProcessRef`
- **locator**: `ops/xw-session-canary-noop.mjs:1227`
- **note**: `spawn`

### [434]

- **classification**: `deviceControlRef`
- **locator**: `ops/xw-start.mjs:262`
- **note**: `ADB`

### [435]

- **classification**: `deviceControlRef`
- **locator**: `ops/xw-start.mjs:2290`
- **note**: `adb`

### [436]

- **classification**: `deviceControlRef`
- **locator**: `ops/xw-start.mjs:13648`
- **note**: `ADB`

### [437]

- **classification**: `deviceControlRef`
- **locator**: `ops/xw-start.mjs:16957`
- **note**: `ADB`

### [438]

- **classification**: `deviceControlRef`
- **locator**: `ops/xw-start.mjs:18701`
- **note**: `adb`

### [439]

- **classification**: `deviceControlRef`
- **locator**: `ops/xw-start.mjs:18713`
- **note**: `adb`

### [440]

- **classification**: `deviceControlRef`
- **locator**: `ops/xw-start.mjs:19590`
- **note**: `adb`

### [441]

- **classification**: `deviceControlRef`
- **locator**: `ops/xw-start.mjs:36356`
- **note**: `adb`

### [442]

- **classification**: `deviceControlRef`
- **locator**: `ops/xw-start.mjs:36390`
- **note**: `adb`

### [443]

- **classification**: `deviceControlRef`
- **locator**: `ops/xw-start.mjs:36672`
- **note**: `ADB`

### [444]

- **classification**: `deviceControlRef`
- **locator**: `ops/xw-start.mjs:36797`
- **note**: `adb`

### [445]

- **classification**: `deviceControlRef`
- **locator**: `ops/xw-start.mjs:36995`
- **note**: `adb`

### [446]

- **classification**: `deviceControlRef`
- **locator**: `ops/xw-start.mjs:38258`
- **note**: `adb`

### [447]

- **classification**: `deviceControlRef`
- **locator**: `ops/xw-start.mjs:38358`
- **note**: `adb`

### [448]

- **classification**: `deviceControlRef`
- **locator**: `ops/xw-start.mjs:38371`
- **note**: `adb`

### [449]

- **classification**: `deviceControlRef`
- **locator**: `ops/xw-start.mjs:39146`
- **note**: `ADB`

### [450]

- **classification**: `deviceControlRef`
- **locator**: `ops/xw-start.mjs:39918`
- **note**: `ADB`

### [451]

- **classification**: `deviceControlRef`
- **locator**: `ops/xw-start.mjs:40374`
- **note**: `ADB`

### [452]

- **classification**: `deviceControlRef`
- **locator**: `ops/xw-start.mjs:40704`
- **note**: `ADB`

### [453]

- **classification**: `deviceControlRef`
- **locator**: `ops/xw-start.mjs:43390`
- **note**: `adb`

### [454]

- **classification**: `deviceControlRef`
- **locator**: `ops/xw-start.mjs:43409`
- **note**: `adb`

### [455]

- **classification**: `childProcessRef`
- **locator**: `ops/xw-start.mjs:626`
- **note**: `child_process`

### [456]

- **classification**: `childProcessRef`
- **locator**: `ops/xw-task.mjs:52`
- **note**: `child_process`

### [457]

- **classification**: `childProcessRef`
- **locator**: `ops/xw-xhs-compose-canary-v2.mjs:509`
- **note**: `spawn`

### [458]

- **classification**: `childProcessRef`
- **locator**: `ops/xw-xhs-compose-canary-v2.mjs:539`
- **note**: `child_process`

### [459]

- **classification**: `childProcessRef`
- **locator**: `ops/xw-xhs-compose-canary-v2.mjs:22521`
- **note**: `spawn`

### [460]

- **classification**: `childProcessRef`
- **locator**: `ops/xw-xhs-compose-canary.mjs:470`
- **note**: `spawn`

### [461]

- **classification**: `childProcessRef`
- **locator**: `ops/xw-xhs-compose-canary.mjs:500`
- **note**: `child_process`

### [462]

- **classification**: `childProcessRef`
- **locator**: `ops/xw-xhs-compose-canary.mjs:14276`
- **note**: `spawn`

### [463]

- **classification**: `deviceControlRef`
- **locator**: `registry.mjs:56204`
- **note**: `GatewayOperator`

### [464]

- **classification**: `deviceControlRef`
- **locator**: `registry.mjs:56353`
- **note**: `ADB`

### [465]

- **classification**: `deviceControlRef`
- **locator**: `registry.mjs:90686`
- **note**: `22222`

### [466]

- **classification**: `deviceControlRef`
- **locator**: `registry.mjs:90694`
- **note**: `ADB`

### [467]

- **classification**: `childProcessRef`
- **locator**: `scripts/adopt-from-windows.mjs:672`
- **note**: `spawn`

### [468]

- **classification**: `childProcessRef`
- **locator**: `scripts/adopt-from-windows.mjs:691`
- **note**: `child_process`

### [469]

- **classification**: `childProcessRef`
- **locator**: `scripts/adopt-from-windows.mjs:1950`
- **note**: `spawn`

### [470]

- **classification**: `childProcessRef`
- **locator**: `scripts/lib/repair-authority-verifiers.mjs:247`
- **note**: `child_process`

### [471]

- **classification**: `childProcessRef`
- **locator**: `scripts/lib/wechat-balance-extract.mjs:32`
- **note**: `child_process`

### [472]

- **classification**: `childProcessRef`
- **locator**: `scripts/lib/xw-balance-shared.mjs:174`
- **note**: `child_process`

### [473]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:405`
- **note**: `ADB`

### [474]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:440`
- **note**: `adb`

### [475]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:1757`
- **note**: `adb`

### [476]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:2035`
- **note**: `ADB`

### [477]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:2260`
- **note**: `adb`

### [478]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:6412`
- **note**: `adb`

### [479]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:6428`
- **note**: `adb`

### [480]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:6451`
- **note**: `adb`

### [481]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:6484`
- **note**: `adb`

### [482]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:6609`
- **note**: `adb`

### [483]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:6633`
- **note**: `adb`

### [484]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:7131`
- **note**: `adb`

### [485]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:7379`
- **note**: `adb`

### [486]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:7404`
- **note**: `adb`

### [487]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:8335`
- **note**: `adb`

### [488]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:8379`
- **note**: `adb`

### [489]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:8441`
- **note**: `adb`

### [490]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:8502`
- **note**: `adb`

### [491]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:8517`
- **note**: `adb`

### [492]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:8620`
- **note**: `adb`

### [493]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:8644`
- **note**: `adb`

### [494]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:10861`
- **note**: `adb`

### [495]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:10877`
- **note**: `adb`

### [496]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:10900`
- **note**: `adb`

### [497]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:10933`
- **note**: `adb`

### [498]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:11030`
- **note**: `adb`

### [499]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:11098`
- **note**: `adb`

### [500]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:11143`
- **note**: `adb`

### [501]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:11183`
- **note**: `adb`

### [502]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:11230`
- **note**: `adb`

### [503]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:12570`
- **note**: `adb`

### [504]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:13864`
- **note**: `ADB`

### [505]

- **classification**: `deviceControlRef`
- **locator**: `scripts/lib/xw-start.mjs:15703`
- **note**: `adb`

### [506]

- **classification**: `childProcessRef`
- **locator**: `scripts/review-windows.mjs:918`
- **note**: `spawn`

### [507]

- **classification**: `childProcessRef`
- **locator**: `scripts/review-windows.mjs:937`
- **note**: `child_process`

### [508]

- **classification**: `childProcessRef`
- **locator**: `scripts/review-windows.mjs:2060`
- **note**: `spawn`

### [509]

- **classification**: `docMention`
- **locator**: `skills/SKILL.md:1684`
- **note**: `22222`

### [510]

- **classification**: `docMention`
- **locator**: `skills/SKILL.md:3902`
- **note**: `ADB`

### [511]

- **classification**: `docMention`
- **locator**: `skills/SKILL.md:5752`
- **note**: `22222`

### [512]

- **classification**: `docMention`
- **locator**: `skills/SKILL.md:5795`
- **note**: `22222`

### [513]

- **classification**: `docMention`
- **locator**: `skills/device/device-input/SKILL.md:62`
- **note**: `adb`

### [514]

- **classification**: `docMention`
- **locator**: `skills/device/device-input/SKILL.md:1391`
- **note**: `adb`

### [515]

- **classification**: `docMention`
- **locator**: `skills/device/device-screenshot/SKILL.md:81`
- **note**: `ADB`

### [516]

- **classification**: `docMention`
- **locator**: `skills/device/device-screenshot/SKILL.md:581`
- **note**: `22222`

### [517]

- **classification**: `docMention`
- **locator**: `skills/device/device-screenshot/SKILL.md:600`
- **note**: `ADB`

### [518]

- **classification**: `docMention`
- **locator**: `skills/device/device-shell/SKILL.md:45`
- **note**: `ADB`

### [519]

- **classification**: `docMention`
- **locator**: `skills/device/device-shell/SKILL.md:126`
- **note**: `adb`

### [520]

- **classification**: `docMention`
- **locator**: `skills/device/device-shell/SKILL.md:241`
- **note**: `ADB`

### [521]

- **classification**: `docMention`
- **locator**: `skills/device/device-shell/SKILL.md:694`
- **note**: `ADB`

### [522]

- **classification**: `docMention`
- **locator**: `skills/device/device-shell/SKILL.md:704`
- **note**: `ADB`

### [523]

- **classification**: `docMention`
- **locator**: `skills/device/device-tap/SKILL.md:52`
- **note**: `22222`

### [524]

- **classification**: `docMention`
- **locator**: `skills/douyin/SKILL.md:7998`
- **note**: `22222`

### [525]

- **classification**: `docMention`
- **locator**: `skills/shared/pitfalls.md:1082`
- **note**: `22222`

### [526]

- **classification**: `docMention`
- **locator**: `skills/shared/preflight.md:1047`
- **note**: `22222`

### [527]

- **classification**: `docMention`
- **locator**: `skills/shared/preflight.md:1101`
- **note**: `22222`

### [528]

- **classification**: `docMention`
- **locator**: `skills/shared/preflight.md:1402`
- **note**: `22222`

### [529]

- **classification**: `docMention`
- **locator**: `skills/shared/transport.md:110`
- **note**: `22222`

### [530]

- **classification**: `docMention`
- **locator**: `skills/shared/transport.md:291`
- **note**: `22222`

### [531]

- **classification**: `docMention`
- **locator**: `skills/shared/transport.md:490`
- **note**: `22222`

### [532]

- **classification**: `docMention`
- **locator**: `skills/shared/transport.md:838`
- **note**: `ADB`

### [533]

- **classification**: `docMention`
- **locator**: `skills/shared/transport.md:1336`
- **note**: `ADB`

### [534]

- **classification**: `docMention`
- **locator**: `skills/shared/transport.md:1371`
- **note**: `22222`

### [535]

- **classification**: `docMention`
- **locator**: `skills/xhs/xhs-observe-feed/SKILL.md:776`
- **note**: `22222`

### [536]

- **classification**: `docMention`
- **locator**: `skills/xhs/xhs-publish/SKILL.md:1206`
- **note**: `22222`

### [537]

- **classification**: `docMention`
- **locator**: `skills/xianyu/xianyu-publish/SKILL.md:1837`
- **note**: `22222`

### [538]

- **classification**: `deviceControlRef`
- **locator**: `sync-feishu.mjs:140`
- **note**: `ADB`

### [539]

- **classification**: `deviceControlRef`
- **locator**: `sync-feishu.mjs:997`
- **note**: `ADB`

### [540]

- **classification**: `childProcessRef`
- **locator**: `sync-feishu.mjs:526`
- **note**: `execFileSync`

### [541]

- **classification**: `childProcessRef`
- **locator**: `sync-feishu.mjs:552`
- **note**: `child_process`

### [542]

- **classification**: `childProcessRef`
- **locator**: `sync-feishu.mjs:1523`
- **note**: `execFileSync`

### [543]

- **classification**: `deviceControlRef`
- **locator**: `tests/explorer-lease-gate.test.mjs:16210`
- **note**: `ADB`

### [544]

- **classification**: `deviceControlRef`
- **locator**: `tests/explorer-lease-gate.test.mjs:18901`
- **note**: `22222`

### [545]

- **classification**: `childProcessRef`
- **locator**: `tests/explorer-lease-gate.test.mjs:284`
- **note**: `child_process`

### [546]

- **classification**: `childProcessRef`
- **locator**: `tests/feishu-to-xianyu-idle.test.mjs:105`
- **note**: `child_process`

### [547]

- **classification**: `childProcessRef`
- **locator**: `tests/nonpayment-liveness.test.mjs:158`
- **note**: `child_process`

### [548]

- **classification**: `deviceControlRef`
- **locator**: `tests/registry.test.mjs:13887`
- **note**: `22222`

### [549]

- **classification**: `childProcessRef`
- **locator**: `tests/registry.test.mjs:51`
- **note**: `spawn`

### [550]

- **classification**: `childProcessRef`
- **locator**: `tests/registry.test.mjs:70`
- **note**: `child_process`

### [551]

- **classification**: `childProcessRef`
- **locator**: `tests/registry.test.mjs:10343`
- **note**: `spawn`

### [552]

- **classification**: `childProcessRef`
- **locator**: `tests/repair-proposal.test.mjs:327`
- **note**: `child_process`

### [553]

- **classification**: `deviceControlRef`
- **locator**: `tests/workflow-catalog.test.mjs:3611`
- **note**: `22222`

### [554]

- **classification**: `childProcessRef`
- **locator**: `tests/xhs-compose.test.mjs:73`
- **note**: `child_process`

### [555]

- **classification**: `childProcessRef`
- **locator**: `tests/xw-mission-cli.test.mjs:51`
- **note**: `execFileSync`

### [556]

- **classification**: `childProcessRef`
- **locator**: `tests/xw-mission-cli.test.mjs:88`
- **note**: `child_process`

### [557]

- **classification**: `childProcessRef`
- **locator**: `tests/xw-mission-cli.test.mjs:620`
- **note**: `execFileSync`

### [558]

- **classification**: `childProcessRef`
- **locator**: `tests/xw-mission-cli.test.mjs:1002`
- **note**: `execFileSync`

### [559]

- **classification**: `childProcessRef`
- **locator**: `tests/xw-mission-cli.test.mjs:1474`
- **note**: `execFileSync`

### [560]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:1703`
- **note**: `adb`

### [561]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:11148`
- **note**: `ADB`

### [562]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:11285`
- **note**: `adb`

### [563]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:11697`
- **note**: `adb`

### [564]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:11749`
- **note**: `adb`

### [565]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:11815`
- **note**: `adb`

### [566]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:11856`
- **note**: `adb`

### [567]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:11909`
- **note**: `adb`

### [568]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:12499`
- **note**: `ADB`

### [569]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:12571`
- **note**: `adb`

### [570]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:12860`
- **note**: `adb`

### [571]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:12964`
- **note**: `adb`

### [572]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:13002`
- **note**: `ADB`

### [573]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:13104`
- **note**: `adb`

### [574]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:13337`
- **note**: `adb`

### [575]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:13369`
- **note**: `adb`

### [576]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:13432`
- **note**: `adb`

### [577]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:14132`
- **note**: `adb`

### [578]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:14207`
- **note**: `adb`

### [579]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:14242`
- **note**: `adb`

### [580]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:14274`
- **note**: `adb`

### [581]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:14320`
- **note**: `adb`

### [582]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:14381`
- **note**: `adb`

### [583]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:14445`
- **note**: `adb`

### [584]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:14529`
- **note**: `adb`

### [585]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:14535`
- **note**: `adb`

### [586]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:14632`
- **note**: `adb`

### [587]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:14676`
- **note**: `adb`

### [588]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:14732`
- **note**: `adb`

### [589]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:14916`
- **note**: `adb`

### [590]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:15253`
- **note**: `ADB`

### [591]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:15931`
- **note**: `adb`

### [592]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:16116`
- **note**: `adb`

### [593]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:16161`
- **note**: `adb`

### [594]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:16393`
- **note**: `adb`

### [595]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:16736`
- **note**: `adb`

### [596]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:16972`
- **note**: `adb`

### [597]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:17222`
- **note**: `adb`

### [598]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:17635`
- **note**: `adb`

### [599]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:17797`
- **note**: `adb`

### [600]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:17893`
- **note**: `adb`

### [601]

- **classification**: `deviceControlRef`
- **locator**: `tests/xw-start.test.mjs:18750`
- **note**: `ADB`

### [602]

- **classification**: `childProcessRef`
- **locator**: `tests/xw-task-cli.test.mjs:50`
- **note**: `spawn`

### [603]

- **classification**: `childProcessRef`
- **locator**: `tests/xw-task-cli.test.mjs:69`
- **note**: `child_process`

### [604]

- **classification**: `childProcessRef`
- **locator**: `tests/xw-task-cli.test.mjs:2336`
- **note**: `spawn`

### [605]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/a2-collect.mjs:1088`
- **note**: `execFileSync`

### [606]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/a2-collect.mjs:1114`
- **note**: `child_process`

### [607]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/a2-collect.mjs:3921`
- **note**: `execFileSync`

### [608]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/a2-collect.mjs:5250`
- **note**: `execFileSync`

### [609]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/cli.mjs:642`
- **note**: `child_process`

### [610]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/collect.mjs:500`
- **note**: `execFileSync`

### [611]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/collect.mjs:526`
- **note**: `child_process`

### [612]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/collect.mjs:809`
- **note**: `execFileSync`

### [613]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/collect.mjs:1990`
- **note**: `execFileSync`

### [614]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/collect.mjs:2210`
- **note**: `execFileSync`

### [615]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/collect.mjs:2397`
- **note**: `execFileSync`

### [616]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/collect.mjs:2633`
- **note**: `execFileSync`

### [617]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/collect.mjs:2884`
- **note**: `execFileSync`

### [618]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/collect.mjs:5534`
- **note**: `execFileSync`

### [619]

- **classification**: `deviceControlRef`
- **locator**: `tools/m0/inventory.mjs:535`
- **note**: `ADB`

### [620]

- **classification**: `deviceControlRef`
- **locator**: `tools/m0/inventory.mjs:539`
- **note**: `22222`

### [621]

- **classification**: `deviceControlRef`
- **locator**: `tools/m0/inventory.mjs:3513`
- **note**: `ADB`

### [622]

- **classification**: `deviceControlRef`
- **locator**: `tools/m0/inventory.mjs:3519`
- **note**: `22222`

### [623]

- **classification**: `deviceControlRef`
- **locator**: `tools/m0/inventory.mjs:3527`
- **note**: `FastOperator`

### [624]

- **classification**: `deviceControlRef`
- **locator**: `tools/m0/inventory.mjs:3542`
- **note**: `GatewayOperator`

### [625]

- **classification**: `deviceControlRef`
- **locator**: `tools/m0/inventory.mjs:4208`
- **note**: `22222`

### [626]

- **classification**: `deviceControlRef`
- **locator**: `tools/m0/inventory.mjs:4214`
- **note**: `ADB`

### [627]

- **classification**: `deviceControlRef`
- **locator**: `tools/m0/inventory.mjs:4218`
- **note**: `adb`

### [628]

- **classification**: `deviceControlRef`
- **locator**: `tools/m0/inventory.mjs:4222`
- **note**: `FastOperator`

### [629]

- **classification**: `deviceControlRef`
- **locator**: `tools/m0/inventory.mjs:4235`
- **note**: `GatewayOperator`

### [630]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/inventory.mjs:719`
- **note**: `execFileSync`

### [631]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/inventory.mjs:745`
- **note**: `child_process`

### [632]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/inventory.mjs:1859`
- **note**: `execFileSync`

### [633]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/inventory.mjs:3849`
- **note**: `child_process`

### [634]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/inventory.mjs:4485`
- **note**: `child_process`

### [635]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/inventory.mjs:4499`
- **note**: `execFileSync`

### [636]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/inventory.mjs:4512`
- **note**: `spawn`

### [637]

- **classification**: `docMention`
- **locator**: `tools/m0/schemas/inventory.v1.schema.json:450`
- **note**: `ADB`

### [638]

- **classification**: `docMention`
- **locator**: `tools/m0/schemas/inventory.v1.schema.json:454`
- **note**: `22222`

### [639]

- **classification**: `docMention`
- **locator**: `tools/m0/schemas/inventory.v1.schema.json:460`
- **note**: `FastOperator`

### [640]

- **classification**: `docMention`
- **locator**: `tools/m0/schemas/inventory.v1.schema.json:473`
- **note**: `GatewayOperator`

### [641]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/tag.mjs:1011`
- **note**: `execFileSync`

### [642]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/tag.mjs:1037`
- **note**: `child_process`

### [643]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/tag.mjs:1092`
- **note**: `execFileSync`

### [644]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/tag.mjs:1380`
- **note**: `execFileSync`

### [645]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/test/collect.test.mjs:80`
- **note**: `execFileSync`

### [646]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/test/collect.test.mjs:106`
- **note**: `child_process`

### [647]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/test/collect.test.mjs:459`
- **note**: `execFileSync`

### [648]

- **classification**: `deviceControlRef`
- **locator**: `tools/m0/test/inventory.test.mjs:745`
- **note**: `ADB`

### [649]

- **classification**: `deviceControlRef`
- **locator**: `tools/m0/test/inventory.test.mjs:832`
- **note**: `22222`

### [650]

- **classification**: `deviceControlRef`
- **locator**: `tools/m0/test/inventory.test.mjs:2477`
- **note**: `ADB`

### [651]

- **classification**: `deviceControlRef`
- **locator**: `tools/m0/test/inventory.test.mjs:2498`
- **note**: `22222`

### [652]

- **classification**: `deviceControlRef`
- **locator**: `tools/m0/test/inventory.test.mjs:2606`
- **note**: `ADB`

### [653]

- **classification**: `deviceControlRef`
- **locator**: `tools/m0/test/inventory.test.mjs:2655`
- **note**: `22222`

### [654]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/test/inventory.test.mjs:221`
- **note**: `execFileSync`

### [655]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/test/inventory.test.mjs:247`
- **note**: `child_process`

### [656]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/test/inventory.test.mjs:7008`
- **note**: `execFileSync`

### [657]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/test/inventory.test.mjs:7052`
- **note**: `execFileSync`

### [658]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/test/tag.test.mjs:80`
- **note**: `execFileSync`

### [659]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/test/tag.test.mjs:106`
- **note**: `child_process`

### [660]

- **classification**: `childProcessRef`
- **locator**: `tools/m0/test/tag.test.mjs:392`
- **note**: `execFileSync`



### [4]

- **dimension**: `launchConfig`
- **items**:

### [1]

- **classification**: `envExample`
- **locator**: `.env.example`
- **note**: ``

### [2]

- **classification**: `launchConfigRef`
- **locator**: `AGENTS.md:7239`
- **note**: `--runs-root`

### [3]

- **classification**: `launchConfigRef`
- **locator**: `CLAUDE.md:952`
- **note**: `--port`

### [4]

- **classification**: `launchConfigRef`
- **locator**: `CLAUDE.md:965`
- **note**: `--host`

### [5]

- **classification**: `launchConfigRef`
- **locator**: `CLAUDE.md:982`
- **note**: `--control`

### [6]

- **classification**: `launchConfigRef`
- **locator**: `CLAUDE.md:1022`
- **note**: `--db`

### [7]

- **classification**: `launchConfigRef`
- **locator**: `CLAUDE.md:4584`
- **note**: `CONTROL_DB_PATH`

### [8]

- **classification**: `launchConfigRef`
- **locator**: `PROGRESS.md:107703`
- **note**: `--runs-root`

### [9]

- **classification**: `launchConfigRef`
- **locator**: `PROGRESS.md:108447`
- **note**: `--runs-root`

### [10]

- **classification**: `launchConfigRef`
- **locator**: `docs/observer-api-20260729.md:6367`
- **note**: `--host`

### [11]

- **classification**: `launchConfigRef`
- **locator**: `docs/plans/2026-08-02-rex-phase5-takeover-handoff.md:13995`
- **note**: `--port`

### [12]

- **classification**: `launchConfigRef`
- **locator**: `docs/plans/2026-08-02-rex-phase5-takeover-handoff.md:14008`
- **note**: `--host`

### [13]

- **classification**: `launchConfigRef`
- **locator**: `docs/plans/2026-08-02-rex-phase5-takeover-handoff.md:14025`
- **note**: `--control`

### [14]

- **classification**: `launchConfigRef`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:29149`
- **note**: `--runs-root`

### [15]

- **classification**: `launchConfigRef`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:31930`
- **note**: `--db`

### [16]

- **classification**: `launchConfigRef`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:32070`
- **note**: `--db`

### [17]

- **classification**: `launchConfigRef`
- **locator**: `docs/plans/2026-08-13-xw-ops-health.md:47013`
- **note**: `--db`

### [18]

- **classification**: `launchConfigRef`
- **locator**: `docs/platform/m0/public/xw-m0-20260817-r0/baseline-identity.v1.json:1325`
- **note**: `--port`

### [19]

- **classification**: `launchConfigRef`
- **locator**: `docs/platform/m0/public/xw-m0-20260817-r0/baseline-identity.v1.json:1338`
- **note**: `--host`

### [20]

- **classification**: `launchConfigRef`
- **locator**: `docs/platform/m0/public/xw-m0-20260817-r0/baseline-identity.v1.json:1353`
- **note**: `--control`

### [21]

- **classification**: `launchConfigRef`
- **locator**: `docs/platform/m0/public/xw-m0-20260817-r0/baseline-identity.v1.json:1386`
- **note**: `--db`

### [22]

- **classification**: `launchConfigRef`
- **locator**: `docs/platform/m0/public/xw-m0-20260817-r0/baseline-identity.v1.json:1543`
- **note**: `--runs-root`

### [23]

- **classification**: `launchConfigRef`
- **locator**: `docs/platform/m0/public/xw-m0-20260817-r0/runtime-attestation.v1.json:334`
- **note**: `--port`

### [24]

- **classification**: `launchConfigRef`
- **locator**: `docs/platform/m0/public/xw-m0-20260817-r0/runtime-attestation.v1.json:347`
- **note**: `--host`

### [25]

- **classification**: `launchConfigRef`
- **locator**: `docs/platform/m0/public/xw-m0-20260817-r0/runtime-attestation.v1.json:362`
- **note**: `--control`

### [26]

- **classification**: `launchConfigRef`
- **locator**: `docs/platform/m0/public/xw-m0-20260817-r0/runtime-attestation.v1.json:395`
- **note**: `--db`

### [27]

- **classification**: `launchConfigRef`
- **locator**: `docs/platform/m0/public/xw-m0-20260817-r0/runtime-attestation.v1.json:552`
- **note**: `--runs-root`

### [28]

- **classification**: `launchConfigRef`
- **locator**: `install-registry-task.ps1:1691`
- **note**: `--port`

### [29]

- **classification**: `launchConfigRef`
- **locator**: `install-registry-task.ps1:1704`
- **note**: `--host`

### [30]

- **classification**: `launchConfigRef`
- **locator**: `install-registry-task.ps1:1719`
- **note**: `--control`

### [31]

- **classification**: `launchConfigRef`
- **locator**: `install-registry-task.ps1:1752`
- **note**: `--db`

### [32]

- **classification**: `launchConfigRef`
- **locator**: `install-registry-task.ps1:2131`
- **note**: `--runs-root`

### [33]

- **classification**: `launchConfigRef`
- **locator**: `ops/install-xw-evolve-worker.ps1:684`
- **note**: `--db`

### [34]

- **classification**: `launchConfigRef`
- **locator**: `ops/xw-evolve-replay-once.mjs:3641`
- **note**: `--db`

### [35]

- **classification**: `launchConfigRef`
- **locator**: `ops/xw-evolve.mjs:11166`
- **note**: `--db`

### [36]

- **classification**: `launchConfigRef`
- **locator**: `ops/xw-mission.mjs:10705`
- **note**: `--control`

### [37]

- **classification**: `launchConfigRef`
- **locator**: `ops/xw-ops-health.mjs:206`
- **note**: `--db`

### [38]

- **classification**: `launchConfigRef`
- **locator**: `ops/xw-ops-health.mjs:1275`
- **note**: `--db`

### [39]

- **classification**: `launchConfigRef`
- **locator**: `ops/xw-ops-health.mjs:2248`
- **note**: `--db`

### [40]

- **classification**: `launchConfigRef`
- **locator**: `ops/xw-ops-health.mjs:2434`
- **note**: `--runs-root`

### [41]

- **classification**: `launchConfigRef`
- **locator**: `ops/xw-stall-worker.mjs:197`
- **note**: `--db`

### [42]

- **classification**: `launchConfigRef`
- **locator**: `ops/xw-stall-worker.mjs:642`
- **note**: `--db`

### [43]

- **classification**: `launchConfigRef`
- **locator**: `registry.mjs:502`
- **note**: `--port`

### [44]

- **classification**: `launchConfigRef`
- **locator**: `registry.mjs:517`
- **note**: `--host`

### [45]

- **classification**: `launchConfigRef`
- **locator**: `registry.mjs:536`
- **note**: `--control`

### [46]

- **classification**: `launchConfigRef`
- **locator**: `registry.mjs:571`
- **note**: `--db`

### [47]

- **classification**: `launchConfigRef`
- **locator**: `registry.mjs:624`
- **note**: `--control`

### [48]

- **classification**: `launchConfigRef`
- **locator**: `registry.mjs:2820`
- **note**: `CONTROL_DB_PATH`

### [49]

- **classification**: `launchConfigRef`
- **locator**: `registry.mjs:23455`
- **note**: `CONTROL_DB_PATH`

### [50]

- **classification**: `launchConfigRef`
- **locator**: `tests/registry.test.mjs:9898`
- **note**: `--port`

### [51]

- **classification**: `launchConfigRef`
- **locator**: `tests/registry.test.mjs:9922`
- **note**: `--host`

### [52]

- **classification**: `launchConfigRef`
- **locator**: `tests/registry.test.mjs:9950`
- **note**: `--control`

### [53]

- **classification**: `launchConfigRef`
- **locator**: `tests/registry.test.mjs:9975`
- **note**: `--db`

### [54]

- **classification**: `launchConfigRef`
- **locator**: `tests/registry.test.mjs:10060`
- **note**: `--control`

### [55]

- **classification**: `launchConfigRef`
- **locator**: `tests/registry.test.mjs:12609`
- **note**: `--runs-root`

### [56]

- **classification**: `launchConfigRef`
- **locator**: `tests/registry.test.mjs:16666`
- **note**: `--control`

### [57]

- **classification**: `launchConfigRef`
- **locator**: `tests/registry.test.mjs:24517`
- **note**: `--runs-root`

### [58]

- **classification**: `launchConfigRef`
- **locator**: `tests/registry.test.mjs:47164`
- **note**: `--runs-root`

### [59]

- **classification**: `launchConfigRef`
- **locator**: `tests/registry.test.mjs:63624`
- **note**: `--runs-root`

### [60]

- **classification**: `launchConfigRef`
- **locator**: `tools/m0/inventory.mjs:2269`
- **note**: `--port`

### [61]

- **classification**: `launchConfigRef`
- **locator**: `tools/m0/inventory.mjs:4805`
- **note**: `CONTROL_DB_PATH`

### [62]

- **classification**: `launchConfigRef`
- **locator**: `tools/m0/inventory.mjs:4940`
- **note**: `CONTROL_DB_PATH`

### [63]

- **classification**: `launchConfigRef`
- **locator**: `tools/m0/inventory.mjs:5609`
- **note**: `CONTROL_DB_PATH`

### [64]

- **classification**: `launchConfigRef`
- **locator**: `tools/m0/inventory.mjs:5626`
- **note**: `--runs-root`

### [65]

- **classification**: `launchConfigRef`
- **locator**: `tools/m0/inventory.mjs:5639`
- **note**: `--db`

### [66]

- **classification**: `launchConfigRef`
- **locator**: `tools/m0/inventory.mjs:5645`
- **note**: `--port`

### [67]

- **classification**: `launchConfigRef`
- **locator**: `tools/m0/inventory.mjs:5653`
- **note**: `--host`

### [68]

- **classification**: `launchConfigRef`
- **locator**: `tools/m0/inventory.mjs:5661`
- **note**: `--control`

### [69]

- **classification**: `launchConfigRef`
- **locator**: `tools/m0/inventory.mjs:5898`
- **note**: `CONTROL_DB_PATH`

### [70]

- **classification**: `launchConfigRef`
- **locator**: `tools/m0/inventory.mjs:5914`
- **note**: `--runs-root`

### [71]

- **classification**: `launchConfigRef`
- **locator**: `tools/m0/inventory.mjs:5926`
- **note**: `--db`

### [72]

- **classification**: `launchConfigRef`
- **locator**: `tools/m0/inventory.mjs:5931`
- **note**: `--port`

### [73]

- **classification**: `launchConfigRef`
- **locator**: `tools/m0/inventory.mjs:5938`
- **note**: `--host`

### [74]

- **classification**: `launchConfigRef`
- **locator**: `tools/m0/inventory.mjs:5945`
- **note**: `--control`

### [75]

- **classification**: `launchConfigRef`
- **locator**: `tools/m0/test/collect.test.mjs:4125`
- **note**: `--port`

### [76]

- **classification**: `launchConfigRef`
- **locator**: `tools/m0/test/collect.test.mjs:4188`
- **note**: `--port`

### [77]

- **classification**: `launchConfigRef`
- **locator**: `tools/m0/test/inventory.test.mjs:3980`
- **note**: `CONTROL_DB_PATH`

### [78]

- **classification**: `launchConfigRef`
- **locator**: `tools/m0/test/inventory.test.mjs:4121`
- **note**: `CONTROL_DB_PATH`

### [79]

- **classification**: `launchConfigRef`
- **locator**: `tools/m0/test/inventory.test.mjs:4505`
- **note**: `CONTROL_DB_PATH`

### [80]

- **classification**: `launchConfigRef`
- **locator**: `tools/m0/test/inventory.test.mjs:5656`
- **note**: `--port`

### [81]

- **classification**: `launchConfigRef`
- **locator**: `tools/m0/test/inventory.test.mjs:5669`
- **note**: `--runs-root`

### [82]

- **classification**: `launchConfigRef`
- **locator**: `tools/m0/test/inventory.test.mjs:5962`
- **note**: `--port`

### [83]

- **classification**: `launchConfigRef`
- **locator**: `tools/m0/test/inventory.test.mjs:6017`
- **note**: `--runs-root`

### [84]

- **classification**: `launchConfigRef`
- **locator**: `tools/m0/test/validate.test.mjs:2706`
- **note**: `--port`



### [5]

- **dimension**: `launcherScripts`
- **items**:

### [1]

- **classification**: `launcherScript`
- **locator**: `campaign/arm-driver.sh`
- **note**: ``

### [2]

- **classification**: `launcherScript`
- **locator**: `campaign/step.sh`
- **note**: ``

### [3]

- **classification**: `launcherScript`
- **locator**: `install-registry-task.ps1`
- **note**: ``

### [4]

- **classification**: `launcherScript`
- **locator**: `ops/fleet-health.sh`
- **note**: ``

### [5]

- **classification**: `launcherScript`
- **locator**: `ops/install-xw-evolve-worker.ps1`
- **note**: ``

### [6]

- **classification**: `launcherScript`
- **locator**: `ops/l1-patrol.sh`
- **note**: ``

### [7]

- **classification**: `launcherScript`
- **locator**: `ops/pnp-sentry.sh`
- **note**: ``

### [8]

- **classification**: `launcherScript`
- **locator**: `restart-registry.ps1`
- **note**: ``

### [9]

- **classification**: `launcherScript`
- **locator**: `serve-restart-01.ps1`
- **note**: ``

### [10]

- **classification**: `launcherScript`
- **locator**: `serve-restart-02.ps1`
- **note**: ``

### [11]

- **classification**: `launcherScript`
- **locator**: `serve-restart-03.ps1`
- **note**: ``

### [12]

- **classification**: `launcherScript`
- **locator**: `serve-restart-04.ps1`
- **note**: ``

### [13]

- **classification**: `launcherScript`
- **locator**: `watchdog/watchdog.sh`
- **note**: ``



### [6]

- **dimension**: `opsDir`
- **items**:

### [1]

- **classification**: `opsModule`
- **locator**: `ops/_biz-trace.mjs`
- **note**: ``

### [2]

- **classification**: `opsModule`
- **locator**: `ops/_douyin-xj-live-lib.mjs`
- **note**: ``

### [3]

- **classification**: `opsModule`
- **locator**: `ops/_evidence-ledger.mjs`
- **note**: ``

### [4]

- **classification**: `opsModule`
- **locator**: `ops/_explore-lease.mjs`
- **note**: ``

### [5]

- **classification**: `opsModule`
- **locator**: `ops/_explore-lib.mjs`
- **note**: ``

### [6]

- **classification**: `opsModule`
- **locator**: `ops/_explore-session-action.mjs`
- **note**: ``

### [7]

- **classification**: `opsModule`
- **locator**: `ops/_llm-comment-gate.mjs`
- **note**: ``

### [8]

- **classification**: `opsModule`
- **locator**: `ops/_run-context.mjs`
- **note**: ``

### [9]

- **classification**: `opsModule`
- **locator**: `ops/_trace-pitfall.mjs`
- **note**: ``

### [10]

- **classification**: `opsModule`
- **locator**: `ops/_win-screencap.mjs`
- **note**: ``

### [11]

- **classification**: `opsModule`
- **locator**: `ops/_win-xiaowei.mjs`
- **note**: ``

### [12]

- **classification**: `opsModule`
- **locator**: `ops/_xhs-parse.mjs`
- **note**: ``

### [13]

- **classification**: `opsModule`
- **locator**: `ops/back.mjs`
- **note**: ``

### [14]

- **classification**: `opsModule`
- **locator**: `ops/conc2-full-dry-run.mjs`
- **note**: ``

### [15]

- **classification**: `opsModule`
- **locator**: `ops/conc4-full-dry-run.mjs`
- **note**: ``

### [16]

- **classification**: `opsModule`
- **locator**: `ops/douyin-collect-set.mjs`
- **note**: ``

### [17]

- **classification**: `opsModule`
- **locator**: `ops/douyin-collect.mjs`
- **note**: ``

### [18]

- **classification**: `opsModule`
- **locator**: `ops/douyin-comment-copy-top.mjs`
- **note**: ``

### [19]

- **classification**: `opsModule`
- **locator**: `ops/douyin-explore-watch.mjs`
- **note**: ``

### [20]

- **classification**: `opsModule`
- **locator**: `ops/douyin-follow-set.mjs`
- **note**: ``

### [21]

- **classification**: `opsModule`
- **locator**: `ops/douyin-follow.mjs`
- **note**: ``

### [22]

- **classification**: `opsModule`
- **locator**: `ops/douyin-free-explore-paced.mjs`
- **note**: ``

### [23]

- **classification**: `opsModule`
- **locator**: `ops/douyin-harvest-share-links.mjs`
- **note**: ``

### [24]

- **classification**: `opsModule`
- **locator**: `ops/douyin-like-set.mjs`
- **note**: ``

### [25]

- **classification**: `opsModule`
- **locator**: `ops/douyin-like.mjs`
- **note**: ``

### [26]

- **classification**: `opsModule`
- **locator**: `ops/douyin-live-bulk-download.mjs`
- **note**: ``

### [27]

- **classification**: `opsModule`
- **locator**: `ops/douyin-live-bulk-score.mjs`
- **note**: ``

### [28]

- **classification**: `opsModule`
- **locator**: `ops/douyin-play-once.mjs`
- **note**: ``

### [29]

- **classification**: `opsModule`
- **locator**: `ops/douyin-rail-set.mjs`
- **note**: ``

### [30]

- **classification**: `opsModule`
- **locator**: `ops/douyin-search.mjs`
- **note**: ``

### [31]

- **classification**: `opsModule`
- **locator**: `ops/douyin-share-friend-consec.mjs`
- **note**: ``

### [32]

- **classification**: `opsModule`
- **locator**: `ops/douyin-share-friend-harvest.mjs`
- **note**: ``

### [33]

- **classification**: `opsModule`
- **locator**: `ops/douyin-xj-live-pipeline-smoke.mjs`
- **note**: ``

### [34]

- **classification**: `opsModule`
- **locator**: `ops/dump-ui.mjs`
- **note**: ``

### [35]

- **classification**: `opsModule`
- **locator**: `ops/explore-preflight.mjs`
- **note**: ``

### [36]

- **classification**: `opsModule`
- **locator**: `ops/feishu-mark-xianyu-published.mjs`
- **note**: ``

### [37]

- **classification**: `opsModule`
- **locator**: `ops/feishu-to-xhs-lib.mjs`
- **note**: ``

### [38]

- **classification**: `opsModule`
- **locator**: `ops/feishu-to-xhs-publish.mjs`
- **note**: ``

### [39]

- **classification**: `opsModule`
- **locator**: `ops/feishu-to-xianyu-idle-batch.mjs`
- **note**: ``

### [40]

- **classification**: `opsModule`
- **locator**: `ops/feishu-to-xianyu-idle-lib.mjs`
- **note**: ``

### [41]

- **classification**: `opsModule`
- **locator**: `ops/feishu-to-xianyu-idle-publish.mjs`
- **note**: ``

### [42]

- **classification**: `opsModule`
- **locator**: `ops/feishu-to-xianyu-lib.mjs`
- **note**: ``

### [43]

- **classification**: `opsModule`
- **locator**: `ops/feishu-to-xianyu.mjs`
- **note**: ``

### [44]

- **classification**: `opsModule`
- **locator**: `ops/focus.mjs`
- **note**: ``

### [45]

- **classification**: `opsModule`
- **locator**: `ops/input-text.mjs`
- **note**: ``

### [46]

- **classification**: `opsModule`
- **locator**: `ops/launch-app.mjs`
- **note**: ``

### [47]

- **classification**: `opsModule`
- **locator**: `ops/recover-main-safe.mjs`
- **note**: ``

### [48]

- **classification**: `opsModule`
- **locator**: `ops/screenshot-and-analyze.mjs`
- **note**: ``

### [49]

- **classification**: `opsModule`
- **locator**: `ops/shell.mjs`
- **note**: ``

### [50]

- **classification**: `opsModule`
- **locator**: `ops/swipe.mjs`
- **note**: ``

### [51]

- **classification**: `opsModule`
- **locator**: `ops/tap.mjs`
- **note**: ``

### [52]

- **classification**: `opsModule`
- **locator**: `ops/xhs-collect-one.mjs`
- **note**: ``

### [53]

- **classification**: `opsModule`
- **locator**: `ops/xhs-comment-copy-top.mjs`
- **note**: ``

### [54]

- **classification**: `opsModule`
- **locator**: `ops/xhs-comment-one.mjs`
- **note**: ``

### [55]

- **classification**: `opsModule`
- **locator**: `ops/xhs-dm-open.mjs`
- **note**: ``

### [56]

- **classification**: `opsModule`
- **locator**: `ops/xhs-dm-user.mjs`
- **note**: ``

### [57]

- **classification**: `opsModule`
- **locator**: `ops/xhs-engage-one.mjs`
- **note**: ``

### [58]

- **classification**: `opsModule`
- **locator**: `ops/xhs-follow-one.mjs`
- **note**: ``

### [59]

- **classification**: `opsModule`
- **locator**: `ops/xhs-free-explore-health.mjs`
- **note**: ``

### [60]

- **classification**: `opsModule`
- **locator**: `ops/xhs-free-explore-paced.mjs`
- **note**: ``

### [61]

- **classification**: `opsModule`
- **locator**: `ops/xhs-like-one.mjs`
- **note**: ``

### [62]

- **classification**: `opsModule`
- **locator**: `ops/xhs-publish-draft.mjs`
- **note**: ``

### [63]

- **classification**: `opsModule`
- **locator**: `ops/xhs-publish-edit-dry-run-fanout.mjs`
- **note**: ``

### [64]

- **classification**: `opsModule`
- **locator**: `ops/xhs-publish-entry.mjs`
- **note**: ``

### [65]

- **classification**: `opsModule`
- **locator**: `ops/xhs-save-draft.mjs`
- **note**: ``

### [66]

- **classification**: `opsModule`
- **locator**: `ops/xhs-search.mjs`
- **note**: ``

### [67]

- **classification**: `opsModule`
- **locator**: `ops/xianyu-discard-compose.mjs`
- **note**: ``

### [68]

- **classification**: `opsModule`
- **locator**: `ops/xianyu-dismiss-tuoguan.mjs`
- **note**: ``

### [69]

- **classification**: `opsModule`
- **locator**: `ops/xianyu-published-metrics.mjs`
- **note**: ``

### [70]

- **classification**: `opsModule`
- **locator**: `ops/xw-auto-adopt.mjs`
- **note**: ``

### [71]

- **classification**: `opsModule`
- **locator**: `ops/xw-closeout.mjs`
- **note**: ``

### [72]

- **classification**: `opsModule`
- **locator**: `ops/xw-evolve-replay-once.mjs`
- **note**: ``

### [73]

- **classification**: `opsModule`
- **locator**: `ops/xw-evolve-worker.mjs`
- **note**: ``

### [74]

- **classification**: `opsModule`
- **locator**: `ops/xw-evolve.mjs`
- **note**: ``

### [75]

- **classification**: `opsModule`
- **locator**: `ops/xw-explore-session.mjs`
- **note**: ``

### [76]

- **classification**: `opsModule`
- **locator**: `ops/xw-locator.mjs`
- **note**: ``

### [77]

- **classification**: `opsModule`
- **locator**: `ops/xw-mission.mjs`
- **note**: ``

### [78]

- **classification**: `opsModule`
- **locator**: `ops/xw-ops-health.mjs`
- **note**: ``

### [79]

- **classification**: `opsModule`
- **locator**: `ops/xw-session-canary-noop.mjs`
- **note**: ``

### [80]

- **classification**: `opsModule`
- **locator**: `ops/xw-skills.mjs`
- **note**: ``

### [81]

- **classification**: `opsModule`
- **locator**: `ops/xw-stall-worker.mjs`
- **note**: ``

### [82]

- **classification**: `opsModule`
- **locator**: `ops/xw-start.mjs`
- **note**: ``

### [83]

- **classification**: `opsModule`
- **locator**: `ops/xw-task.mjs`
- **note**: ``

### [84]

- **classification**: `opsModule`
- **locator**: `ops/xw-xhs-compose-canary-v2.mjs`
- **note**: ``

### [85]

- **classification**: `opsModule`
- **locator**: `ops/xw-xhs-compose-canary.mjs`
- **note**: ``

### [86]

- **classification**: `opsModule`
- **locator**: `ops/xw-xhs-compose-report.mjs`
- **note**: ``

### [87]

- **classification**: `opsModule`
- **locator**: `ops/xw-xhs-compose.mjs`
- **note**: ``



### [7]

- **dimension**: `packageScripts`
- **items**:

### [1]

- **classification**: `npmScript`
- **locator**: `package.json:scripts.test`
- **note**: `node --test tests/*.test.mjs`

### [2]

- **classification**: `npmScript`
- **locator**: `package.json:scripts.check`
- **note**: `node --check registry.mjs && node --check sync-feishu.mjs && node --check import-knowledge.mjs && node --check scripts/review-run-bundle.mjs && node --check scripts/create-repair-proposal.mjs && node --check scripts/lib/repair-proposal.mjs && node --check scripts/lib/repair-authority-verifiers.mjs && node --check scripts/lib/xw-start.mjs && node --check ops/_explore-lease.mjs && node --check ops/_explore-lib.mjs && node --check ops/_explore-session-action.mjs && node --check ops/_win-xiaowei.mjs && node --check ops/_win-screencap.mjs && node --check ops/xw-start.mjs && node --check ops/xw-explore-session.mjs && node --check ops/explore-preflight.mjs && node --check ops/feishu-to-xianyu.mjs && node --check ops/feishu-to-xianyu-lib.mjs`



### [8]

- **dimension**: `ports`
- **items**:

### [1]

- **classification**: `listenOrPortRef`
- **locator**: `CLAUDE.md:954`
- **note**: `port 17930`

### [2]

- **classification**: `listenOrPortRef`
- **locator**: `PROGRESS.md:109806`
- **note**: `port 5038`

### [3]

- **classification**: `listenOrPortRef`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:6079`
- **note**: `port 5038`

### [4]

- **classification**: `listenOrPortRef`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:6103`
- **note**: `port 5037`

### [5]

- **classification**: `listenOrPortRef`
- **locator**: `docs/handoffs/HANDOFF-2026-07-26-agent-entry-xianyu-verify.md:6586`
- **note**: `port 5038`

### [6]

- **classification**: `listenOrPortRef`
- **locator**: `docs/plans/2026-08-02-rex-phase5-takeover-handoff.md:13997`
- **note**: `port 17930`

### [7]

- **classification**: `listenOrPortRef`
- **locator**: `docs/platform/m0/public/xw-m0-20260817-r0/baseline-identity.v1.json:1327`
- **note**: `port 17930`

### [8]

- **classification**: `listenOrPortRef`
- **locator**: `docs/platform/m0/public/xw-m0-20260817-r0/runtime-attestation.v1.json:336`
- **note**: `port 17930`

### [9]

- **classification**: `listenOrPortRef`
- **locator**: `docs/platform/m0/public/xw-m0-20260817-r0/runtime-attestation.v1.json:940`
- **note**: `port 17930`

### [10]

- **classification**: `listenOrPortRef`
- **locator**: `install-registry-task.ps1:1693`
- **note**: `port 17930`

### [11]

- **classification**: `listenOrPortRef`
- **locator**: `ops/explore-preflight.mjs:5423`
- **note**: `port 22222`

### [12]

- **classification**: `listenOrPortRef`
- **locator**: `ops/explore-preflight.mjs:5474`
- **note**: `port 22222`

### [13]

- **classification**: `listenOrPortRef`
- **locator**: `ops/explore-preflight.mjs:5499`
- **note**: `port 22222`

### [14]

- **classification**: `listenOrPortRef`
- **locator**: `ops/xw-start.mjs:326`
- **note**: `port 5038`

### [15]

- **classification**: `listenOrPortRef`
- **locator**: `ops/xw-start.mjs:15421`
- **note**: `port 5037`

### [16]

- **classification**: `listenOrPortRef`
- **locator**: `ops/xw-start.mjs:36833`
- **note**: `port 5037`

### [17]

- **classification**: `listenOrPortRef`
- **locator**: `ops/xw-start.mjs:37038`
- **note**: `port 5037`

### [18]

- **classification**: `listenOrPortRef`
- **locator**: `registry.mjs:504`
- **note**: `port 17930`

### [19]

- **classification**: `listenOrPortRef`
- **locator**: `registry.mjs:2504`
- **note**: `port 17930`

### [20]

- **classification**: `listenOrPortRef`
- **locator**: `registry.mjs:135023`
- **note**: `port 2000`

### [21]

- **classification**: `listenOrPortRef`
- **locator**: `skills/wechat/SKILL.md:2376`
- **note**: `port 1080`

### [22]

- **classification**: `listenOrPortRef`
- **locator**: `tests/xw-start.test.mjs:7107`
- **note**: `port 17890`

### [23]

- **classification**: `listenOrPortRef`
- **locator**: `tests/xw-start.test.mjs:13725`
- **note**: `port 5038`

### [24]

- **classification**: `listenOrPortRef`
- **locator**: `tests/xw-start.test.mjs:13974`
- **note**: `port 5037`

### [25]

- **classification**: `listenOrPortRef`
- **locator**: `tests/xw-start.test.mjs:14211`
- **note**: `port 5038`

### [26]

- **classification**: `listenOrPortRef`
- **locator**: `tests/xw-start.test.mjs:15482`
- **note**: `port 5038`

### [27]

- **classification**: `listenOrPortRef`
- **locator**: `tests/xw-start.test.mjs:15731`
- **note**: `port 5037`

### [28]

- **classification**: `listenOrPortRef`
- **locator**: `tests/xw-start.test.mjs:16772`
- **note**: `port 5037`

### [29]

- **classification**: `listenOrPortRef`
- **locator**: `tests/xw-start.test.mjs:23066`
- **note**: `port 17895`

### [30]

- **classification**: `listenOrPortRef`
- **locator**: `tools/m0/test/collect.test.mjs:4127`
- **note**: `port 17930`

### [31]

- **classification**: `listenOrPortRef`
- **locator**: `tools/m0/test/collect.test.mjs:4190`
- **note**: `port 17930`

### [32]

- **classification**: `listenOrPortRef`
- **locator**: `tools/m0/test/inventory.test.mjs:724`
- **note**: `port 17930`

### [33]

- **classification**: `listenOrPortRef`
- **locator**: `tools/m0/test/inventory.test.mjs:1950`
- **note**: `port 17930`

### [34]

- **classification**: `listenOrPortRef`
- **locator**: `tools/m0/test/inventory.test.mjs:5658`
- **note**: `port 17930`

### [35]

- **classification**: `listenOrPortRef`
- **locator**: `tools/m0/test/validate.test.mjs:2708`
- **note**: `port 17930`



### [9]

- **dimension**: `scheduledTask`
- **items**:

### [1]

- **classification**: `scheduledTaskSnapshot`
- **locator**: `schtasks:/tn/XhsDeviceRegistry`
- **note**: `LogonType S4U, node.exe, args redacted (tokens); details in baseline-identity deployment`



### [10]

- **dimension**: `shebangs`
- **items**:

### [1]

- **classification**: `shebangScript`
- **locator**: `campaign/arm-driver.sh`
- **note**: `#!/bin/bash`

### [2]

- **classification**: `shebangScript`
- **locator**: `campaign/step.sh`
- **note**: `#!/bin/bash`

### [3]

- **classification**: `shebangScript`
- **locator**: `import-knowledge.mjs`
- **note**: `#!/usr/bin/env node`

### [4]

- **classification**: `shebangScript`
- **locator**: `ops/_llm-comment-gate.mjs`
- **note**: `#!/usr/bin/env node`

### [5]

- **classification**: `shebangScript`
- **locator**: `ops/_trace-pitfall.mjs`
- **note**: `#!/usr/bin/env node`

### [6]

- **classification**: `shebangScript`
- **locator**: `ops/back.mjs`
- **note**: `#!/usr/bin/env node`

### [7]

- **classification**: `shebangScript`
- **locator**: `ops/conc2-full-dry-run.mjs`
- **note**: `#!/usr/bin/env node`

### [8]

- **classification**: `shebangScript`
- **locator**: `ops/conc4-full-dry-run.mjs`
- **note**: `#!/usr/bin/env node`

### [9]

- **classification**: `shebangScript`
- **locator**: `ops/douyin-collect-set.mjs`
- **note**: `#!/usr/bin/env node`

### [10]

- **classification**: `shebangScript`
- **locator**: `ops/douyin-collect.mjs`
- **note**: `#!/usr/bin/env node`

### [11]

- **classification**: `shebangScript`
- **locator**: `ops/douyin-comment-copy-top.mjs`
- **note**: `#!/usr/bin/env node`

### [12]

- **classification**: `shebangScript`
- **locator**: `ops/douyin-explore-watch.mjs`
- **note**: `#!/usr/bin/env node`

### [13]

- **classification**: `shebangScript`
- **locator**: `ops/douyin-follow-set.mjs`
- **note**: `#!/usr/bin/env node`

### [14]

- **classification**: `shebangScript`
- **locator**: `ops/douyin-follow.mjs`
- **note**: `#!/usr/bin/env node`

### [15]

- **classification**: `shebangScript`
- **locator**: `ops/douyin-free-explore-paced.mjs`
- **note**: `#!/usr/bin/env node`

### [16]

- **classification**: `shebangScript`
- **locator**: `ops/douyin-harvest-share-links.mjs`
- **note**: `#!/usr/bin/env node`

### [17]

- **classification**: `shebangScript`
- **locator**: `ops/douyin-like-set.mjs`
- **note**: `#!/usr/bin/env node`

### [18]

- **classification**: `shebangScript`
- **locator**: `ops/douyin-like.mjs`
- **note**: `#!/usr/bin/env node`

### [19]

- **classification**: `shebangScript`
- **locator**: `ops/douyin-live-bulk-download.mjs`
- **note**: `#!/usr/bin/env node`

### [20]

- **classification**: `shebangScript`
- **locator**: `ops/douyin-live-bulk-score.mjs`
- **note**: `#!/usr/bin/env node`

### [21]

- **classification**: `shebangScript`
- **locator**: `ops/douyin-play-once.mjs`
- **note**: `#!/usr/bin/env node`

### [22]

- **classification**: `shebangScript`
- **locator**: `ops/douyin-rail-set.mjs`
- **note**: `#!/usr/bin/env node`

### [23]

- **classification**: `shebangScript`
- **locator**: `ops/douyin-search.mjs`
- **note**: `#!/usr/bin/env node`

### [24]

- **classification**: `shebangScript`
- **locator**: `ops/douyin-share-friend-consec.mjs`
- **note**: `#!/usr/bin/env node`

### [25]

- **classification**: `shebangScript`
- **locator**: `ops/douyin-share-friend-harvest.mjs`
- **note**: `#!/usr/bin/env node`

### [26]

- **classification**: `shebangScript`
- **locator**: `ops/douyin-xj-live-pipeline-smoke.mjs`
- **note**: `#!/usr/bin/env node`

### [27]

- **classification**: `shebangScript`
- **locator**: `ops/dump-ui.mjs`
- **note**: `#!/usr/bin/env node`

### [28]

- **classification**: `shebangScript`
- **locator**: `ops/explore-preflight.mjs`
- **note**: `#!/usr/bin/env node`

### [29]

- **classification**: `shebangScript`
- **locator**: `ops/feishu-mark-xianyu-published.mjs`
- **note**: `#!/usr/bin/env node`

### [30]

- **classification**: `shebangScript`
- **locator**: `ops/feishu-to-xhs-publish.mjs`
- **note**: `#!/usr/bin/env node`

### [31]

- **classification**: `shebangScript`
- **locator**: `ops/feishu-to-xianyu-idle-batch.mjs`
- **note**: `#!/usr/bin/env node`

### [32]

- **classification**: `shebangScript`
- **locator**: `ops/feishu-to-xianyu-idle-publish.mjs`
- **note**: `#!/usr/bin/env node`

### [33]

- **classification**: `shebangScript`
- **locator**: `ops/feishu-to-xianyu.mjs`
- **note**: `#!/usr/bin/env node`

### [34]

- **classification**: `shebangScript`
- **locator**: `ops/fleet-health.sh`
- **note**: `#!/bin/bash`

### [35]

- **classification**: `shebangScript`
- **locator**: `ops/focus.mjs`
- **note**: `#!/usr/bin/env node`

### [36]

- **classification**: `shebangScript`
- **locator**: `ops/input-text.mjs`
- **note**: `#!/usr/bin/env node`

### [37]

- **classification**: `shebangScript`
- **locator**: `ops/l1-patrol.sh`
- **note**: `#!/bin/bash`

### [38]

- **classification**: `shebangScript`
- **locator**: `ops/launch-app.mjs`
- **note**: `#!/usr/bin/env node`

### [39]

- **classification**: `shebangScript`
- **locator**: `ops/pnp-sentry.sh`
- **note**: `#!/bin/bash`

### [40]

- **classification**: `shebangScript`
- **locator**: `ops/recover-main-safe.mjs`
- **note**: `#!/usr/bin/env node`

### [41]

- **classification**: `shebangScript`
- **locator**: `ops/screenshot-and-analyze.mjs`
- **note**: `#!/usr/bin/env node`

### [42]

- **classification**: `shebangScript`
- **locator**: `ops/shell.mjs`
- **note**: `#!/usr/bin/env node`

### [43]

- **classification**: `shebangScript`
- **locator**: `ops/swipe.mjs`
- **note**: `#!/usr/bin/env node`

### [44]

- **classification**: `shebangScript`
- **locator**: `ops/tap.mjs`
- **note**: `#!/usr/bin/env node`

### [45]

- **classification**: `shebangScript`
- **locator**: `ops/xhs-collect-one.mjs`
- **note**: `#!/usr/bin/env node`

### [46]

- **classification**: `shebangScript`
- **locator**: `ops/xhs-comment-copy-top.mjs`
- **note**: `#!/usr/bin/env node`

### [47]

- **classification**: `shebangScript`
- **locator**: `ops/xhs-comment-one.mjs`
- **note**: `#!/usr/bin/env node`

### [48]

- **classification**: `shebangScript`
- **locator**: `ops/xhs-dm-open.mjs`
- **note**: `#!/usr/bin/env node`

### [49]

- **classification**: `shebangScript`
- **locator**: `ops/xhs-dm-user.mjs`
- **note**: `#!/usr/bin/env node`

### [50]

- **classification**: `shebangScript`
- **locator**: `ops/xhs-engage-one.mjs`
- **note**: `#!/usr/bin/env node`

### [51]

- **classification**: `shebangScript`
- **locator**: `ops/xhs-follow-one.mjs`
- **note**: `#!/usr/bin/env node`

### [52]

- **classification**: `shebangScript`
- **locator**: `ops/xhs-free-explore-health.mjs`
- **note**: `#!/usr/bin/env node`

### [53]

- **classification**: `shebangScript`
- **locator**: `ops/xhs-free-explore-paced.mjs`
- **note**: `#!/usr/bin/env node`

### [54]

- **classification**: `shebangScript`
- **locator**: `ops/xhs-like-one.mjs`
- **note**: `#!/usr/bin/env node`

### [55]

- **classification**: `shebangScript`
- **locator**: `ops/xhs-publish-draft.mjs`
- **note**: `#!/usr/bin/env node`

### [56]

- **classification**: `shebangScript`
- **locator**: `ops/xhs-publish-edit-dry-run-fanout.mjs`
- **note**: `#!/usr/bin/env node`

### [57]

- **classification**: `shebangScript`
- **locator**: `ops/xhs-publish-entry.mjs`
- **note**: `#!/usr/bin/env node`

### [58]

- **classification**: `shebangScript`
- **locator**: `ops/xhs-save-draft.mjs`
- **note**: `#!/usr/bin/env node`

### [59]

- **classification**: `shebangScript`
- **locator**: `ops/xhs-search.mjs`
- **note**: `#!/usr/bin/env node`

### [60]

- **classification**: `shebangScript`
- **locator**: `ops/xianyu-discard-compose.mjs`
- **note**: `#!/usr/bin/env node`

### [61]

- **classification**: `shebangScript`
- **locator**: `ops/xianyu-dismiss-tuoguan.mjs`
- **note**: `#!/usr/bin/env node`

### [62]

- **classification**: `shebangScript`
- **locator**: `ops/xianyu-published-metrics.mjs`
- **note**: `#!/usr/bin/env node`

### [63]

- **classification**: `shebangScript`
- **locator**: `ops/xw-auto-adopt.mjs`
- **note**: `#!/usr/bin/env node`

### [64]

- **classification**: `shebangScript`
- **locator**: `ops/xw-closeout.mjs`
- **note**: `#!/usr/bin/env node`

### [65]

- **classification**: `shebangScript`
- **locator**: `ops/xw-evolve-replay-once.mjs`
- **note**: `#!/usr/bin/env node`

### [66]

- **classification**: `shebangScript`
- **locator**: `ops/xw-evolve-worker.mjs`
- **note**: `#!/usr/bin/env node`

### [67]

- **classification**: `shebangScript`
- **locator**: `ops/xw-evolve.mjs`
- **note**: `#!/usr/bin/env node`

### [68]

- **classification**: `shebangScript`
- **locator**: `ops/xw-explore-session.mjs`
- **note**: `#!/usr/bin/env node`

### [69]

- **classification**: `shebangScript`
- **locator**: `ops/xw-locator.mjs`
- **note**: `#!/usr/bin/env node`

### [70]

- **classification**: `shebangScript`
- **locator**: `ops/xw-mission.mjs`
- **note**: `#!/usr/bin/env node`

### [71]

- **classification**: `shebangScript`
- **locator**: `ops/xw-ops-health.mjs`
- **note**: `#!/usr/bin/env node`

### [72]

- **classification**: `shebangScript`
- **locator**: `ops/xw-session-canary-noop.mjs`
- **note**: `#!/usr/bin/env node`

### [73]

- **classification**: `shebangScript`
- **locator**: `ops/xw-skills.mjs`
- **note**: `#!/usr/bin/env node`

### [74]

- **classification**: `shebangScript`
- **locator**: `ops/xw-stall-worker.mjs`
- **note**: `#!/usr/bin/env node`

### [75]

- **classification**: `shebangScript`
- **locator**: `ops/xw-start.mjs`
- **note**: `#!/usr/bin/env node`

### [76]

- **classification**: `shebangScript`
- **locator**: `ops/xw-task.mjs`
- **note**: `#!/usr/bin/env node`

### [77]

- **classification**: `shebangScript`
- **locator**: `ops/xw-xhs-compose-canary-v2.mjs`
- **note**: `#!/usr/bin/env node`

### [78]

- **classification**: `shebangScript`
- **locator**: `ops/xw-xhs-compose-canary.mjs`
- **note**: `#!/usr/bin/env node`

### [79]

- **classification**: `shebangScript`
- **locator**: `ops/xw-xhs-compose-report.mjs`
- **note**: `#!/usr/bin/env node`

### [80]

- **classification**: `shebangScript`
- **locator**: `ops/xw-xhs-compose.mjs`
- **note**: `#!/usr/bin/env node`

### [81]

- **classification**: `shebangScript`
- **locator**: `registry.mjs`
- **note**: `#!/usr/bin/env node`

### [82]

- **classification**: `shebangScript`
- **locator**: `scripts/adopt-from-windows.mjs`
- **note**: `#!/usr/bin/env node`

### [83]

- **classification**: `shebangScript`
- **locator**: `scripts/create-repair-proposal.mjs`
- **note**: `#!/usr/bin/env node`

### [84]

- **classification**: `shebangScript`
- **locator**: `scripts/lib/wechat-balance-ocr.py`
- **note**: `#!/usr/bin/env python3`

### [85]

- **classification**: `shebangScript`
- **locator**: `scripts/lib/xw-balance-shared.mjs`
- **note**: `#!/usr/bin/env node`

### [86]

- **classification**: `shebangScript`
- **locator**: `scripts/render-acceptance.mjs`
- **note**: `#!/usr/bin/env node`

### [87]

- **classification**: `shebangScript`
- **locator**: `scripts/review-run-bundle.mjs`
- **note**: `#!/usr/bin/env node`

### [88]

- **classification**: `shebangScript`
- **locator**: `scripts/review-windows.mjs`
- **note**: `#!/usr/bin/env node`

### [89]

- **classification**: `shebangScript`
- **locator**: `scripts/validate-run-bundle.mjs`
- **note**: `#!/usr/bin/env node`

### [90]

- **classification**: `shebangScript`
- **locator**: `sync-feishu.mjs`
- **note**: `#!/usr/bin/env node`

### [91]

- **classification**: `shebangScript`
- **locator**: `tools/m0/cli.mjs`
- **note**: `#!/usr/bin/env node`

### [92]

- **classification**: `shebangScript`
- **locator**: `watchdog/watchdog.sh`
- **note**: `#!/bin/bash`



### [11]

- **dimension**: `sqliteForensics`
- **items**:

### [1]

- **classification**: `sqliteRoSnapshot`
- **locator**: `registry.db`
- **note**: `user_version=0, journal=delete, 9 tables, integrity ok, no WAL`

### [2]

- **classification**: `sqliteRoSnapshot`
- **locator**: `control.db`
- **note**: `user_version=15, journal=wal, 27 tables, integrity ok, WAL 6MB`



### [12]

- **dimension**: `taskTemplates`
- **items**:

### [1]

- **classification**: `taskTemplate`
- **locator**: `task-templates/task.douyin.keyword-material-collection@1.json`
- **note**: ``

### [2]

- **classification**: `taskTemplate`
- **locator**: `task-templates/task.douyin.keyword-material-collection@2.json`
- **note**: ``

### [3]

- **classification**: `taskTemplate`
- **locator**: `task-templates/task.douyin.keyword-material-collection@3.json`
- **note**: ``




- **name**: `registry`


- **schemaId**: `xhs.m0.inventory.v1`
- **schemaVersion**: 1
- **unclassifiedCount**: 0

## Known Debt Register

- **baselineId**: `xw-m0-20260817-r0`
- **capturedAt**: `2026-08-17T13:00:00.000Z`
- **entries**:

### [1]

- **allowsGates**: [`G1`]
- **blocksGates**: []
- **critical**: false
- **expiresAt**: `2026-09-30T00:00:00Z`
- **failureId**: `debt_control_17920_unreachable`
- **issue**: `gifted-professor/xhs-registry#14`
- **owner**: `user`
- **waiverReason**: `control plane 17920 not reachable from this host (curl 000); M0 only needs read-only observations, which degrade to identity cache — not a health certification`

### [2]

- **allowsGates**: [`G1`]
- **blocksGates**: []
- **critical**: false
- **expiresAt**: `2026-09-30T00:00:00Z`
- **failureId**: `debt_fleet_ready_lease_unknown`
- **issue**: `gifted-professor/xhs-registry#14`
- **owner**: `user`
- **waiverReason**: `fleet ready/lease status is unknown from this host; M0 does not render unknown as ready/healthy`

### [3]

- **allowsGates**: [`G1`]
- **blocksGates**: []
- **critical**: false
- **expiresAt**: `2026-09-30T00:00:00Z`
- **failureId**: `debt_release_claim_drift`
- **issue**: `gifted-professor/xhs-registry#14`
- **owner**: `user`
- **waiverReason**: `release claim (8c5682a) is a claim, not a verified loaded-bytes match; recorded as claim in runtime-attestation`

### [4]

- **allowsGates**: [`G1`]
- **blocksGates**: []
- **critical**: false
- **expiresAt**: `2026-09-30T00:00:00Z`
- **failureId**: `debt_process_loaded_bytes_unverifiable`
- **issue**: `gifted-professor/xhs-registry#14`
- **owner**: `user`
- **waiverReason**: `processLoadedBytes is fixed to UNVERIFIABLE — we never assert the running process has loaded the current on-disk WIP into memory`

### [5]

- **allowsGates**: []
- **blocksGates**: [`G4`]
- **critical**: false
- **expiresAt**: `2026-08-31T00:00:00Z`
- **failureId**: `debt_env_example_bitable_id_candidates`
- **issue**: `gifted-professor/xhs-registry#14`
- **owner**: `user`
- **waiverReason**: `tracked .env.example contains two real-looking Feishu bitable ID candidates (FEISHU_QINGDAO_TABLE_ID tblQ…, FEISHU_QINGDAO_VIEW_ID vewS…) instead of placeholders; M0 does not publish .env.example, but the candidates should be replaced before any public/third-party delivery`

### [6]

- **allowsGates**: [`G2`]
- **blocksGates**: []
- **critical**: false
- **expiresAt**: `2026-09-30T00:00:00Z`
- **failureId**: `debt_cursor_renewal_monitor_no_tracked_installer`
- **issue**: `gifted-professor/xhs-registry#14`
- **owner**: `user`
- **waiverReason**: `ops/cursor-renewal-monitor.mjs is untracked (WIP); archived in A2 private package, not part of frozen source`

### [7]

- **allowsGates**: [`G2`]
- **blocksGates**: []
- **critical**: false
- **expiresAt**: `2026-09-30T00:00:00Z`
- **failureId**: `debt_task_templates_candidates_legacy_untracked`
- **issue**: `gifted-professor/xhs-registry#14`
- **owner**: `user`
- **waiverReason**: `task-templates/candidates + legacy-invalid are untracked (WIP); archived in A2 private package, not part of frozen source`

### [8]

- **allowsGates**: [`G2`]
- **blocksGates**: []
- **critical**: false
- **expiresAt**: `2026-09-30T00:00:00Z`
- **failureId**: `debt_run_begin_ps1_local_gitignored`
- **issue**: `gifted-professor/xhs-registry#14`
- **owner**: `user`
- **waiverReason**: `run_begin.ps1 exists locally but is gitignored (ignored-private); archived in A2 private package`

### [9]

- **allowsGates**: [`G5`]
- **blocksGates**: []
- **critical**: false
- **expiresAt**: `2026-09-30T00:00:00Z`
- **failureId**: `debt_tools_m0_not_in_npm_check`
- **issue**: `gifted-professor/xhs-registry#14`
- **owner**: `m0`
- **waiverReason**: `tools/m0 self-tests run via node --test tools/m0/**/*.test.mjs, deliberately NOT added to npm run check (package.json must not change during M0)`

### [10]

- **allowsGates**: []
- **blocksGates**: [`B3`]
- **critical**: false
- **expiresAt**: `2026-08-31T00:00:00Z`
- **failureId**: `debt_npm_test_wip_failures`
- **issue**: `gifted-professor/xhs-registry#14`
- **owner**: `wip-author`
- **waiverReason**: `4 pre-existing npm test failures in tests/xw-task-cli.test.mjs (task template filename identity) — the test file and scripts/lib/task-template.mjs are modified in pre-M0 dirty WIP, NOT in the M0 commit; must be resolved before B3 three-round testing`


- **schemaId**: `xhs.m0.known-debt.v1`
- **schemaVersion**: 1

## PR Public Assets

- **baselineId**: `xw-m0-20260817-r0`
- **capturedAt**: `2026-08-17T12:58:16.409Z`
- **prArchiveRefsVerified**: 10
- **prs**:

### [1]

- **base**: `e4660372a97a4197067d6298cbed1496a1035814`
- **commits**: [`cfbf76186f7078420d75a34f25cd9eb21b7818c1`, `ebbbfb434fcc3d80c78bcef724fbda982daeffff`, `a85f1b1cbfaccb23a078a6f05db41f624e12b55c`, `bb48c5f8e49c5dd0d16d6e538f678f10ef14f397`, `1d1166c35ac9efa930ef4ccf38319e33bdd9eba2`, `a1041448ed3ef471795d8d15b12a016feb766295`, `fab4e49d909831cc90ec845d325eee6cf83ef2af`, `e36c9a718bc1982c67de81cb701403a9c5a28aad`, `95dd0be1349ffb401c6b7c3aa9240b37f406cda2`, `ed1049970982a69ee763a3652d2b3825680e1b60`, `a9260109d85a9e9d2ca921e41a9a82def2b2d811`, `5cde432facc68cf27735cdf99327e4605514c944`, `a8cd3138e67ac1e8e15490b83ac17b359d9c42d1`, `4011bf4a47e7609e7710253ba79ad745d3aa878e`, `d5f42047b664bf46b82a569eb6348d9b0e891996`, `ac39c8000f524134f7da227f63848cd851d7a2de`]
- **diffstat**: { deletions=13; filesChanged=10; insertions=1277 }
- **head**: `cfbf76186f7078420d75a34f25cd9eb21b7818c1`
- **mergeBase**: `3e6be1c49314d543fa17e44bee4486c2eb518d1c`
- **number**: 7
- **paths**: [`HANDOFF-2026-08-08-foundation-pr4-gate.md`, `PROGRESS.md`, `docs/plans/2026-08-08-foundation-pr2-progress.md`, `docs/plans/2026-08-08-foundation-pr2-wiring-closure.md`, `docs/plans/2026-08-08-foundation-pr4-baseline.md`, `docs/plans/2026-08-08-foundation-pr4-plan.md`, `docs/plans/2026-08-08-foundation-pr4-progress.md`, `docs/plans/2026-08-08-foundation-pr4-runbook.md`, `docs/plans/2026-08-08-foundation-pr4.files.json`, `docs/plans/2026-08-09-foundation-pr4-gate-b-activate-pilot-runbook.md`]
- **portIssue**: _(null)_
- **refRestoreVerified**: true
- **repo**: `registry`
- **stablePatchId**: `b2c0848cf472c4497dca1c1189e7ec2436a4c79d`
- **tree**: `dad4ac426190840de9b39a3afad7a5f52247b040`

### [2]

- **base**: `e4660372a97a4197067d6298cbed1496a1035814`
- **commits**: [`8493ff00611f0aedb887eb4f20d8a1612da1bf89`, `7cd2c2605cc90b24a81cf29e1c223765ed0e7500`, `1c24f0c74dbb9fce8f593b2fda1999d629545e91`, `cb558b75c9655571c2b280ee535d76572990a336`, `9a3984c51b3dc13cef6f64754fb1255ac710b96e`, `b0775ee82f6d5264d0cd07acc1e5695ad8b43a8d`, `d3a3559cbc18f5ed266da80d4de992ffe8aad928`, `fb8e35b4d475a8965f531590e8b417d4649fbc78`, `e9162b96d8e0d6784ff3f474ea59447f345d41e4`, `a9b9b52b83a197541360dc748d5c0264119dd9d4`, `9d7062505bb4bf0c4f8a144f6e05f6fd3d93d8e2`, `b494f6ff6bf8307df0c5727816db3df2d167d17e`, `0d619cb61720184c34854b23d11d022121d62263`, `bd243da9f3ddb0d6dc8b3d9e5e80df920648cc74`, `9a251c2825299e01929a62c0d832f078f4a97a7d`, `77ac1e4a0a52897aa89a1dc8ed04c109417983c0`, `000cf256b3af51c935345ae2f5299678b787e67d`, `12d7f068dbf8a6422aa9e898932e70aa955fef06`, `805da1cb6c8709361961029a0ef9311951572729`, `c4d6bd8fd8d9cf45986aac04128804b8a5479e7d`, `44a2fb17e1f574e06a428a7436b2de095fbd8b25`, `84216a82f73c73903d4ca59f1e7d5521cb611f4b`]
- **diffstat**: { deletions=0; filesChanged=15; insertions=4195 }
- **head**: `8493ff00611f0aedb887eb4f20d8a1612da1bf89`
- **mergeBase**: `abad59426834d3e2dc4ee18936928c7bf4cb7b4e`
- **number**: 9
- **paths**: [`.gitignore`, `docs/handoffs/HANDOFF-2026-08-06-visual-tap-resolver-demo.md`, `docs/plans/2026-08-06-visual-tap-resolver-demo-design.md`, `experiments/visual-tap-resolver/.gitignore`, `experiments/visual-tap-resolver/BASELINE.md`, `experiments/visual-tap-resolver/README.md`, `experiments/visual-tap-resolver/accept_benchmark.py`, `experiments/visual-tap-resolver/ocr_integration.py`, `experiments/visual-tap-resolver/requirements.txt`, `experiments/visual-tap-resolver/resolver.py`, `experiments/visual-tap-resolver/tests/test_accept_benchmark.py`, `experiments/visual-tap-resolver/tests/test_resolver.py`, `experiments/visual-tap-resolver/tests/test_vision_contract.py`, `experiments/visual-tap-resolver/vision_contract.py`, `experiments/visual-tap-resolver/visual_tap_demo.py`]
- **portIssue**: _(null)_
- **refRestoreVerified**: true
- **repo**: `registry`
- **stablePatchId**: `0b0674b146387d14852e763ff0806cb16e08de3f`
- **tree**: `1c97be84b4cd05f81eb8a916c950461f3d218524`

### [3]

- **base**: `e4660372a97a4197067d6298cbed1496a1035814`
- **commits**: [`349e01a62914ea54cd189a5443af0cd659db5d0c`, `67d13b0c2fc1e55fa066b6f0d5c435aece763cab`, `caf3a1349d55b6def02d3765aeda46cc77912cb0`, `fdddfdc1472246b7c79a76f46f2a5a195bd9c13c`, `b5fbbd941ad04cf8f06838cda0d7282bded54c25`]
- **diffstat**: { deletions=65; filesChanged=14; insertions=587 }
- **head**: `349e01a62914ea54cd189a5443af0cd659db5d0c`
- **mergeBase**: `abad59426834d3e2dc4ee18936928c7bf4cb7b4e`
- **number**: 10
- **paths**: [`PROGRESS.md`, `ops/_explore-lease.mjs`, `ops/xw-mission.mjs`, `ops/xw-skills.mjs`, `registry.mjs`, `scripts/lib/capability-runtime-eligibility.mjs`, `scripts/lib/session-workflow-worker.mjs`, `scripts/lib/task-orchestrator.mjs`, `scripts/lib/typed-job-worker.mjs`, `tests/capability-runtime-eligibility.test.mjs`, `tests/registry.test.mjs`, `tests/session-workflow-worker.test.mjs`, `tests/task-orchestrator.test.mjs`, `tests/typed-job-worker.test.mjs`]
- **portIssue**: _(null)_
- **refRestoreVerified**: true
- **repo**: `registry`
- **stablePatchId**: `4495995fa191d6a90763328b9f78854e8ad1cff5`
- **tree**: `e4b983aa938f9a209ed5f7a0288e3aae169c2925`

### [4]

- **base**: `e4660372a97a4197067d6298cbed1496a1035814`
- **commits**: [`5cedb67454f5d2473a6b79e2cc7c415af9a79106`]
- **diffstat**: { deletions=3; filesChanged=3; insertions=18 }
- **head**: `5cedb67454f5d2473a6b79e2cc7c415af9a79106`
- **mergeBase**: `63516bd4465f2e2595aeadbf63919ce67e575215`
- **number**: 12
- **paths**: [`PROGRESS.md`, `ops/xw-explore-session.mjs`, `ops/xw-start.mjs`]
- **portIssue**: _(null)_
- **refRestoreVerified**: true
- **repo**: `registry`
- **stablePatchId**: `efb148957d0e4e6727185f9c6d732b2f742201c5`
- **tree**: `a3128a931adbd457fc02298288a1918278aa12c3`

### [5]

- **base**: `d52cd0799a362fbfadc78f43e7a2a2b549d53b48`
- **commits**: [`8737575be101c3ab3f568730f774f0182738b7a3`, `0c4646471a36a8ea70c78ae844b9c057566f4c03`, `e69cc6c14dc39a88c235d01b4b8ff61e82385ef3`, `e5f3010043bb46ff087b5c7e4053ece5d29f26a8`, `42d04a9fbdcd9b1dc051bcda161d574be0b33c94`]
- **diffstat**: { deletions=352; filesChanged=103; insertions=23878 }
- **head**: `8737575be101c3ab3f568730f774f0182738b7a3`
- **mergeBase**: `72a7e04967e7fb6c6e418540c55dd5e9284b0e9a`
- **number**: 1
- **paths**: [`.env.example`, `.gitignore`, `AGENTS.md`, `README.md`, `config/account-ramp-profile.example.json`, `config/account-ramp-profile.schema.json`, `config/hermes-capability-acceptance.example.json`, `config/input-methods.example.psd1`, `config/matrix.example.psd1`, `config/research-result.schema.json`, `config/research-task.example.json`, `config/research-task.schema.json`, `config/xhs-page-rules.json`, `docs/ACCOUNT_RAMP_UP_AUTOMATION.md`, `docs/ARCHITECTURE.md`, `docs/FEED_RUNBOOK.md`, `docs/FEED_WORKFLOW.md`, `docs/INPUT_METHOD_WORKFLOW.md`, `docs/MACHINE_IDENTITY.md`, `docs/MAC_REMOTE_ACCESS_HANDOFF.md`, `docs/RESEARCH_AUTOMATION.md`, `docs/SAFETY.md`, `docs/TAILSCALE_REMOTE_CONTROL.md`, `docs/XIAOWEI_MATRIX.md`, `docs/trusted-runs/FEED_TRUSTED_10_20260714.md`, `package-lock.json`, `package.json`, `prompts/comment-draft.txt`, `prompts/research-analyst.txt`, `prompts/topic-planner.txt`, `prompts/xhs-page-classifier.txt`, `scripts/Capture-VisibleWindow.ps1`, `scripts/Collect-PhoneAssets.ps1`, `scripts/Device-Lock.ps1`, `scripts/Get-WindowsCaptureCompatibility.ps1`, `scripts/Import-Utf8PowerShellDataFile.ps1`, `scripts/Install-TailscaleOpenSsh.ps1`, `scripts/Invoke-MatrixAction.ps1`, `scripts/Invoke-XhsOverTailscale.ps1`, `scripts/Lark-InventoryPolicy.ps1`, `scripts/Machine-Identity.ps1`, `scripts/Manage-XiaoweiHost.ps1`, `scripts/Matrix-Preflight.ps1`, `scripts/Open-AccountRampCandidate.ps1`, `scripts/Open-ReviewCandidate.ps1`, `scripts/Run-AccountRamp.ps1`, `scripts/Run-FeedWorkflow.ps1`, `scripts/Run-Pipeline.ps1`, `scripts/Run-TopicResearch.ps1`, `scripts/Sync-LarkBase.ps1`, `scripts/Sync-ResearchReview.ps1`, `scripts/Test-Project.ps1`, `scripts/Test-TailscaleOpenSsh.ps1`, `scripts/account-ramp.mjs`, `scripts/adb-research-provider.mjs`, `scripts/ai-role-runner.mjs`, `scripts/cloud-vision.mjs`, `scripts/feed-device-runner.mjs`, `scripts/feed-workflow.mjs`, `scripts/greenarrow-api.mjs`, `scripts/local-ocr.mjs`, `scripts/navigate-review-candidate.mjs`, `scripts/research-core.mjs`, `scripts/research-session.mjs`, `scripts/run-topic-research.mjs`, `scripts/sync-research-review.mjs`, `scripts/windows-ocr.ps1`, `scripts/xhs-agent.mjs`, `scripts/xhs-page-engine.mjs`, `scripts/xiaowei-action-catalog.mjs`, `scripts/xiaowei-api.mjs`, `scripts/xiaowei-client.mjs`, `scripts/xiaowei-text-input.mjs`, `scripts/xiaowei-transport.mjs`, `skills/xhs-device-operator/SKILL.md`, `tests/account-ramp.test.mjs`, `tests/adb-research-provider.test.mjs`, `tests/ai-role-runner.test.mjs`, `tests/device-lock.test.mjs`, `tests/feed-device-runner.test.mjs`, `tests/feed-workflow.test.mjs`, `tests/fixtures/argv-probe.cjs`, `tests/json-schema-lite.mjs`, `tests/lark-inventory-privacy.test.mjs`, `tests/local-ocr.test.mjs`, `tests/machine-identity.test.mjs`, `tests/matrix-action-safety.test.mjs`, `tests/page-engine.test.mjs`, `tests/research-core.test.mjs`, `tests/research-session.test.mjs`, `tests/run-topic-research.test.mjs`, `tests/schema-contract.test.mjs`, `tests/screen-verification.test.mjs`, `tests/sync-research-review.test.mjs`, `tests/visible-window-capture.test.mjs`, `tests/windows-capture-compat.test.mjs`, `tests/xhs-agent-cli.test.mjs`, `tests/xhs-entry-wrapper.test.mjs`, `tests/xiaowei-action-catalog.test.mjs`, `tests/xiaowei-api.test.mjs`, `tests/xiaowei-client.test.mjs`, `xhs.cmd`, `xhs.ps1`]
- **portIssue**: _(null)_
- **refRestoreVerified**: true
- **repo**: `deviceAgent`
- **stablePatchId**: `eb834d6fb555e46d685f06a58dabde6f9c4d7812`
- **tree**: `b6466446c6ab1ae712ea0b3469fe78eb7846544a`

### [6]

- **base**: `d52cd0799a362fbfadc78f43e7a2a2b549d53b48`
- **commits**: [`de76feae4c9bab2232de2ca237454c0119f51180`, `18e123ac776ee646ee97b50c73b2befce8dd6981`, `3be94ae4edaab4a73fa040fc7e01afe0f3605728`, `0ff2fc82312fa2c8de25c29324366444fc6bda35`, `a6ae9eee11fe7cc820f6ef4ebe41575fcc49546b`, `b1adb667c603659737c28b13d3d4cafa675bfb13`, `ba84465b8a45b74acfcf62e9bb0fe9305671a67f`, `daf62a2cad68d974bd62d92fc4fd9d29c5c6f02f`, `36f1e5921ed0240756d88e3fda1c9d6e059acd15`, `6c232eedeee53c23dd635127eaee50ae8fcfa2b7`, `a2dbf496df724decc2394ad788c5af65e11b807b`, `5d5b5c727e6085ae877223fd279ca70160f1a81a`, `4784177e1f2b454df6f877970f7f0fa61028ffa3`, `118158407df2a5d06e3b300844b0bf450be0d5e7`, `9df6a45cc007c005faeb12416ab0ee14b3d3b274`, `a101a69a9d30102d799b48d5be8df51e08940675`, `d95154a10b3cf4c03bdca25ce2dc4374d316b39e`, `b8420a6e5604032aff768530a2b4a0f7e2e9a5bc`, `0c4646471a36a8ea70c78ae844b9c057566f4c03`, `e69cc6c14dc39a88c235d01b4b8ff61e82385ef3`, `e5f3010043bb46ff087b5c7e4053ece5d29f26a8`, `42d04a9fbdcd9b1dc051bcda161d574be0b33c94`]
- **diffstat**: { deletions=354; filesChanged=232; insertions=55771 }
- **head**: `de76feae4c9bab2232de2ca237454c0119f51180`
- **mergeBase**: `72a7e04967e7fb6c6e418540c55dd5e9284b0e9a`
- **number**: 2
- **paths**: [`.env.example`, `.gitignore`, `AGENTS.md`, `README.md`, `config/composite-approval.schema.json`, `config/composite-attempt.schema.json`, `config/composite-capability-acceptance.schema.json`, `config/composite-capability.initial-v1.json`, `config/composite-capability.schema.json`, `config/composite-plan.schema.json`, `config/composite-policy.schema.json`, `config/composite-policy.supervised-v1.json`, `config/composite-worker-ticket.schema.json`, `config/cpa-comment-count.schema.json`, `config/cpa-request.schema.json`, `config/device-control-incidents.json`, `config/device-control-playbook.json`, `config/hermes-capability-acceptance.example.json`, `config/input-methods.example.psd1`, `config/matrix.example.psd1`, `config/research-result.schema.json`, `config/research-task.example.json`, `config/research-task.schema.json`, `config/task-spec.schema.json`, `config/xhs-page-rules.json`, `docs/AGENT_DEVICE_CONTROL_PLAYBOOK.md`, `docs/ARCHITECTURE.md`, `docs/CAPABILITY_GAPS.md`, `docs/CODEBASE_AUDIT.md`, `docs/DEVELOPMENT_MODE.md`, `docs/FEED_RUNBOOK.md`, `docs/FEED_WORKFLOW.md`, `docs/HERMES_RUN_CONTRACT.md`, `docs/INPUT_METHOD_WORKFLOW.md`, `docs/MACHINE_IDENTITY.md`, `docs/MAC_REMOTE_ACCESS_HANDOFF.md`, `docs/RESEARCH_AUTOMATION.md`, `docs/SAFETY.md`, `docs/TAILSCALE_REMOTE_CONTROL.md`, `docs/XHS_CAPABILITY_ROADMAP.md`, `docs/XIAOWEI_DEVICE_OPERATOR_GUIDE.md`, `docs/XIAOWEI_MATRIX.md`, `docs/XIAOWEI_PRIVATE_API_CATALOG.md`, `docs/device-task-handoffs/2026-07-16-b-series-verification-hermes.md`, `docs/device-task-handoffs/2026-07-16-comment-emoji-submit-repair-codex.md`, `docs/device-task-handoffs/2026-07-16-comment-like-selector-fix-codex.md`, `docs/device-task-handoffs/2026-07-16-hermes-capability-gap-report.md`, `docs/device-task-handoffs/2026-07-16-hermes-comment-live-acceptance.md`, `docs/device-task-handoffs/2026-07-16-p0-capability-repair-codex.md`, `docs/device-task-handoffs/2026-07-16-sequential-open-scroll-repair-codex.md`, `docs/device-task-handoffs/2026-07-17-app-start-pointer-event-gap-report.md`, `docs/device-task-handoffs/2026-07-17-app-start-pointer-repair-codex.md`, `docs/device-task-handoffs/2026-07-17-comment-reply-input-scroll-live-codex.md`, `docs/device-task-handoffs/2026-07-17-comment-reply-verification-fail-01-hermes.md`, `docs/device-task-handoffs/2026-07-17-full-flow-performance-optimization-hermes.md`, `docs/device-task-handoffs/2026-07-17-gateway-hot-reload-proposal-hermes.md`, `docs/device-task-handoffs/2026-07-17-gateway-version-verified-reload-codex.md`, `docs/device-task-handoffs/2026-07-17-machine04-incomplete-hierarchy-gap-hermes.md`, `docs/device-task-handoffs/2026-07-17-per-device-gateway-concurrency-codex.md`, `docs/device-task-handoffs/2026-07-17-private-message-input-send-repair-codex.md`, `docs/device-task-handoffs/2026-07-17-video-detail-flow-performance-optimization-hermes.md`, `docs/device-task-handoffs/2026-07-18-open-gaps-report-for-repair.md`, `docs/device-task-handoffs/2026-07-18-p1-gaps-batch-fix-kimi.md`, `docs/device-task-handoffs/2026-07-18-reply-input-fullwidth-normalization-fix-kimi.md`, `docs/device-task-handoffs/2026-07-18-reply-target-suffix-blocked-by-translate-kimi.md`, `docs/observability-improvements/detail-visited-returned-to-list.md`, `"docs/\345\267\245\344\275\234\345\256\244\346\211\213\346\234\272\344\273\273\345\212\241\344\270\216\350\203\275\345\212\233\346\270\205\345\215\225-API\350\260\203\347\224\250\347\211\210.md"`, `"docs/\346\225\210\345\215\253API\346\211\213\346\234\272\346\216\247\345\210\266\350\203\275\345\212\233\351\252\214\346\224\266\350\256\260\345\275\225-2026-07-15.md"`, `package-lock.json`, `package.json`, `prompts/comment-draft.txt`, `prompts/research-analyst.txt`, `prompts/topic-planner.txt`, `prompts/xhs-page-classifier.txt`, `scripts/Capture-VisibleWindow.ps1`, `scripts/Collect-PhoneAssets.ps1`, `scripts/Crop-ImageArtifact.ps1`, `scripts/Device-Lock.ps1`, `scripts/Get-WindowsCaptureCompatibility.ps1`, `scripts/Import-Utf8PowerShellDataFile.ps1`, `scripts/Install-TailscaleOpenSsh.ps1`, `scripts/Invoke-MatrixAction.ps1`, `scripts/Invoke-XhsOverTailscale.ps1`, `scripts/Invoke-XiaoweiDev.ps1`, `scripts/Invoke-XiaoweiDeviceRead.ps1`, `scripts/Invoke-XiaoweiPrivateDev.ps1`, `scripts/Lark-InventoryPolicy.ps1`, `scripts/Machine-Identity.ps1`, `scripts/Manage-XhsRemoteGateway.ps1`, `scripts/Manage-XiaoweiHost.ps1`, `scripts/Matrix-Preflight.ps1`, `scripts/Open-AccountRampCandidate.ps1`, `scripts/Open-ReviewCandidate.ps1`, `scripts/PowerShell-Runtime.ps1`, `scripts/Run-Pipeline.ps1`, `scripts/Run-TaskCompatibility.ps1`, `scripts/Run-TaskWorkflow.ps1`, `scripts/Set-XiaoweiPrivateApi.ps1`, `scripts/Start-XhsRemoteStack.ps1`, `scripts/Sync-LarkBase.ps1`, `scripts/Sync-ResearchReview.ps1`, `scripts/Task-TextInputContext.ps1`, `scripts/Test-Project.ps1`, `scripts/Test-TailscaleOpenSsh.ps1`, `scripts/adb-research-provider.mjs`, `scripts/ai-role-runner.mjs`, `scripts/capability-cli.mjs`, `scripts/cloud-vision.mjs`, `scripts/composite-action-registry.mjs`, `scripts/composite-capability-activation.mjs`, `scripts/composite-device-adapter.mjs`, `scripts/composite-execution-coordinator.mjs`, `scripts/composite-operation-ledger.mjs`, `scripts/composite-plan-approval.mjs`, `scripts/composite-plan-core.mjs`, `scripts/composite-plan-prepare.mjs`, `scripts/composite-plan-render.mjs`, `scripts/composite-workflow.mjs`, `scripts/cpa-client.mjs`, `scripts/detail-perception.mjs`, `scripts/device-control-guide.mjs`, `scripts/device-node-engine.mjs`, `scripts/engagement-ensure.mjs`, `scripts/feed-device-runner.mjs`, `scripts/greenarrow-api.mjs`, `scripts/image-artifact.mjs`, `scripts/legacy-task-converter.mjs`, `scripts/local-environment.mjs`, `scripts/local-ocr.mjs`, `scripts/navigate-review-candidate.mjs`, `scripts/powershell-runtime.mjs`, `scripts/read-03-service-balance-simple.py`, `scripts/read-03-wallet-adapter-v2.py`, `scripts/read-03-wallet-adapter.py`, `scripts/repo-audit.mjs`, `scripts/repo-policy-scan.mjs`, `scripts/repo-status.mjs`, `scripts/research-core.mjs`, `scripts/research-session.mjs`, `scripts/sync-research-review.mjs`, `scripts/task-compiler.mjs`, `scripts/task-live-executor.mjs`, `scripts/task-live-runner.mjs`, `scripts/task-runner.mjs`, `scripts/task-source-device-adapter.mjs`, `scripts/test-ocr.ps1`, `scripts/test-windows-capability.ps1`, `scripts/windows-ocr.ps1`, `scripts/xhs-agent.mjs`, `scripts/xhs-page-engine.mjs`, `scripts/xhs-public-observation.mjs`, `scripts/xhs-remote-gateway.mjs`, `scripts/xiaowei-action-catalog.mjs`, `scripts/xiaowei-api.mjs`, `scripts/xiaowei-client.mjs`, `scripts/xiaowei-device-read.mjs`, `scripts/xiaowei-private-api.mjs`, `scripts/xiaowei-text-input.mjs`, `scripts/xiaowei-transport.mjs`, `skills/record-device-control-learning/SKILL.md`, `skills/record-device-control-learning/agents/openai.yaml`, `skills/record-device-control-learning/references/incident-contract.md`, `skills/record-device-control-learning/scripts/record-learning.mjs`, `skills/xhs-device-operator/SKILL.md`, `skills/xhs-device-operator/references/capability-roadmap.md`, `tests/adb-research-provider.test.mjs`, `tests/ai-role-runner.test.mjs`, `tests/capability-cli.test.mjs`, `tests/cloud-vision.test.mjs`, `tests/composite-action-registry.test.mjs`, `tests/composite-capability-activation.test.mjs`, `tests/composite-device-adapter.test.mjs`, `tests/composite-execution-coordinator.test.mjs`, `tests/composite-operation-ledger.test.mjs`, `tests/composite-plan-approval.test.mjs`, `tests/composite-plan-core.test.mjs`, `tests/composite-plan-prepare.test.mjs`, `tests/composite-plan-render.test.mjs`, `tests/composite-schema.test.mjs`, `tests/composite-workflow.test.mjs`, `tests/cpa-client.test.mjs`, `tests/detail-perception.test.mjs`, `tests/device-control-guide.test.mjs`, `tests/device-control-learning.test.mjs`, `tests/device-lock.test.mjs`, `tests/device-node-engine.test.mjs`, `tests/engagement-ensure.test.mjs`, `tests/feed-device-runner.test.mjs`, `tests/fixtures/argv-probe.cjs`, `tests/fixtures/composite-capability.synthetic-1.json`, `tests/fixtures/composite-capability.synthetic-2.json`, `tests/fixtures/composite-capability.synthetic-4.json`, `tests/fixtures/composite-capability.synthetic-8.json`, `tests/fixtures/fake-composite-adapter.mjs`, `tests/image-artifact.test.mjs`, `tests/json-schema-lite.mjs`, `tests/lark-inventory-privacy.test.mjs`, `tests/legacy-task-converter.test.mjs`, `tests/local-ocr.test.mjs`, `tests/machine-identity.test.mjs`, `tests/matrix-action-safety.test.mjs`, `tests/page-engine.test.mjs`, `tests/powershell-runtime.test.mjs`, `tests/repo-audit.test.mjs`, `tests/repo-policy-scan.test.mjs`, `tests/repo-status.test.mjs`, `tests/research-core.test.mjs`, `tests/research-session.test.mjs`, `tests/schema-contract.test.mjs`, `tests/screen-verification.test.mjs`, `tests/sync-research-review.test.mjs`, `tests/task-compatibility-wrapper.test.mjs`, `tests/task-compiler.test.mjs`, `tests/task-live-runner.test.mjs`, `tests/task-runner.test.mjs`, `tests/task-source-device-adapter.test.mjs`, `tests/task-text-input-context.test.mjs`, `tests/task-windows-wrapper.test.mjs`, `tests/video-advance.test.mjs`, `tests/visible-window-capture.test.mjs`, `tests/windows-capture-compat.test.mjs`, `tests/xhs-agent-cli.test.mjs`, `tests/xhs-entry-wrapper.test.mjs`, `tests/xhs-public-observation.test.mjs`, `tests/xhs-remote-gateway.test.mjs`, `tests/xiaowei-action-catalog.test.mjs`, `tests/xiaowei-api.test.mjs`, `tests/xiaowei-client.test.mjs`, `tests/xiaowei-device-read.test.mjs`, `tests/xiaowei-private-api.test.mjs`, `xhs.cmd`, `xhs.ps1`]
- **portIssue**: _(null)_
- **refRestoreVerified**: true
- **repo**: `deviceAgent`
- **stablePatchId**: `7cfa0b0b00408a745a2a47c8bd838be5f1a4a058`
- **tree**: `f7f5e50d34525ea86dcc68182dfc4c8f18e9b92a`

### [7]

- **base**: `de76feae4c9bab2232de2ca237454c0119f51180`
- **commits**: [`3be36586a43cabc31a0caa5ac75cd6335d477877`, `3f5c9027ac12b713a16274775eb4f9f4ea1595e3`, `5094f3ddd49d8257b2a4f67d2bbcfbefa9c5167f`]
- **diffstat**: { deletions=5; filesChanged=8; insertions=1266 }
- **head**: `3be36586a43cabc31a0caa5ac75cd6335d477877`
- **mergeBase**: `de76feae4c9bab2232de2ca237454c0119f51180`
- **number**: 3
- **paths**: [`package.json`, `scripts/xhs-comment-imitate.mjs`, `scripts/xhs-lark-notifier.mjs`, `scripts/xhs-remote-gateway.mjs`, `scripts/xhs-wechat-notifier.mjs`, `scripts/xiaowei-device-read.mjs`, `tests/xhs-comment-imitate.test.mjs`, `tests/xiaowei-device-read.test.mjs`]
- **portIssue**: _(null)_
- **refRestoreVerified**: true
- **repo**: `deviceAgent`
- **stablePatchId**: `5dfb7ef1ccfef5d767ed9f13ff308f5869ca0c75`
- **tree**: `a49ed36fe4414ff6ad45ac4768f8296ac3522456`

### [8]

- **base**: `d52cd0799a362fbfadc78f43e7a2a2b549d53b48`
- **commits**: [`247c92f8dfaa7cf7fce40cade503e3ee0a9f4760`]
- **diffstat**: { deletions=0; filesChanged=1; insertions=235 }
- **head**: `247c92f8dfaa7cf7fce40cade503e3ee0a9f4760`
- **mergeBase**: `1af96b3600937c9d2c473bb44c0ef019f2dbb6b7`
- **number**: 12
- **paths**: [`docs/control-plane/2026-07-24-capability-map-audit.md`]
- **portIssue**: _(null)_
- **refRestoreVerified**: true
- **repo**: `deviceAgent`
- **stablePatchId**: `08b051abe658fac4937bc408525128488953b68c`
- **tree**: `c6f322e8702c47aa2dce3b0791e61b3d5d506160`

### [9]

- **base**: `d52cd0799a362fbfadc78f43e7a2a2b549d53b48`
- **commits**: [`aa7077b6d9b8c8b877a492adc33e58b37c323027`]
- **diffstat**: { deletions=0; filesChanged=1; insertions=193 }
- **head**: `aa7077b6d9b8c8b877a492adc33e58b37c323027`
- **mergeBase**: `1af96b3600937c9d2c473bb44c0ef019f2dbb6b7`
- **number**: 13
- **paths**: [`"docs/app-explorations/2026-07-24-\345\276\256\344\277\241-\350\277\236\345\217\22110-1\344\270\211\346\234\272\345\205\250\345\217\221.md"`]
- **portIssue**: _(null)_
- **refRestoreVerified**: true
- **repo**: `deviceAgent`
- **stablePatchId**: `ba5e810211b553276d6489d956cc3a3667fe2bd6`
- **tree**: `a068919412fa215217fe5439c514d4c6ce5fd3af`

### [10]

- **base**: `d52cd0799a362fbfadc78f43e7a2a2b549d53b48`
- **commits**: [`07ba5ab0843499010ca2ccfe35aea7a20037be54`, `b09a8d5d1bf7cc7e6ae15f7ccbae2312aaceb76b`]
- **diffstat**: { deletions=10; filesChanged=8; insertions=873 }
- **head**: `07ba5ab0843499010ca2ccfe35aea7a20037be54`
- **mergeBase**: `218b32c88406402aac00d9fad881a1c6e73d8cb4`
- **number**: 23
- **paths**: [`apps/xhs/adapter.mjs`, `apps/xhs/capabilities.json`, `config/control-plane.devices.example.json`, `control-plane/lib/control-plane.mjs`, `scripts/fast-operator.mjs`, `tests/capability-registry.test.mjs`, `tests/control-plane-adapters.test.mjs`, `tests/fast-operator-follow.test.mjs`]
- **portIssue**: _(null)_
- **refRestoreVerified**: true
- **repo**: `deviceAgent`
- **stablePatchId**: `699106c52f513b2d03e11657203b043408073dd1`
- **tree**: `9c43f84547861fd7e156551f3fa5d2b1d9d794db`


- **schemaId**: `xhs.m0.pr-assets.v1`
- **schemaVersion**: 1

## Private Evidence

- **ageRecipientFingerprint**: _(null)_
- **baselineId**: `xw-m0-20260817-r0`
- **capturedAt**: `2026-08-17T13:00:00.000Z`
- **ciphertextSha256**: _(null)_
- **fileCount**: _(null)_
- **privatePackagePath**: _(null)_
- **restoreReceipt**: _(null)_
- **schemaId**: `xhs.m0.private-evidence.v1`
- **schemaVersion**: 1
- **status**: `pending_age`

## Runtime Attestation

- **baselineId**: `xw-m0-20260817-r0`
- **capturedAt**: `2026-08-17T12:16:55Z`
- **confidence**: `unreachable`
- **diskBytesAtObservation**: _(null)_
- **launchConfigClaim**: `device fleet; M0 forbids device/ADB/22222 access; not reachable from this host`
- **processCommandLineRedacted**: _(null)_
- **processLaunchPath**: _(null)_
- **processLoadedBytes**: `UNVERIFIABLE`
- **processStartTime**: _(null)_
- **releaseClaim**: `43b09ac`
- **repo**: `deviceAgent`
- **schemaId**: `xhs.m0.runtime-attestation.v1`
- **schemaVersion**: 1

## Runtime Attestation

- **baselineId**: `xw-m0-20260817-r0`
- **capturedAt**: `2026-08-17T12:16:55Z`
- **confidence**: `directlyObserved`
- **diskBytesAtObservation**: { entryPath=`C:\Users\Public\xhs-registry\registry.mjs`; mtimeIso=`2026-08-17T04:24:11.768Z`; sha256=`3e3e6a7aa52f966fd38e8d55f296a424693ab6b90f23093fd186cd28abab3ce8`; size=143367 }
- **launchConfigClaim**: `Windows scheduled task XhsDeviceRegistry (BootTrigger); node.exe; port 17930; host 0.0.0.0; control http://127.0.0.1:17920`
- **processCommandLineRedacted**: `"C:\Users\Public\xhs-registry\registry.mjs" --port 17930 --host 0.0.0.0 --control http://127.0.0.1:17920 --db "C:\Users\Public\xhs-registry\registry.db" --agent-token <redacted> --human-token <redacted> --human-actor <redacted> --observer-token <redacted> --runs-root "C:\Users\Public\xhs-agent-runs"`
- **processLaunchPath**: `node.exe`
- **processLoadedBytes**: `UNVERIFIABLE`
- **processStartTime**: `2026-08-17T04:26:45Z`
- **releaseClaim**: `8c5682a`
- **repo**: `registry`
- **schemaId**: `xhs.m0.runtime-attestation.v1`
- **schemaVersion**: 1

## State Ownership

- **baselineId**: `xw-m0-20260817-r0`
- **capturedAt**: `2026-08-17T12:50:00.000Z`
- **schemaId**: `xhs.m0.state-ownership.v1`
- **schemaVersion**: 1
- **states**:

### [1]

- **authoritativeOwner**: `Feishu bitable (sync-feishu.mjs)`
- **authoritativeStore**: `Feishu 多维表格 (identity table)`
- **canonicalState**: `device identities`
- **consistencyModel**: `eventual`
- **derivedCopies**: [`registry.db identities table (cache)`]
- **mutationEntrypoint**: `sync-feishu.mjs PUT /api/identities (registry caches; seed identities.seed.json is cold-start only)`
- **projectionWriters**:

### [1]

- **constraint**: `only via PUT /api/identities; serial is identity anchor (physical), alias is mutable slot`
- **writer**: `sync-feishu.mjs`


- **reconciliationDirection**: `ownerToDerived`

### [2]

- **authoritativeOwner**: `registry knowledge API`
- **authoritativeStore**: `registry.db knowledge table`
- **canonicalState**: `knowledge base`
- **consistencyModel**: `strong`
- **derivedCopies**: []
- **mutationEntrypoint**: `POST /api/knowledge + PATCH /api/knowledge/:id (no DELETE)`
- **projectionWriters**:

### [1]

- **constraint**: `only via POST/PATCH API; 409 on duplicate id unless --update`
- **writer**: `import-knowledge.mjs`


- **reconciliationDirection**: `none`

### [3]

- **authoritativeOwner**: `control plane`
- **authoritativeStore**: `control.db approvals`
- **canonicalState**: `approval decisions`
- **consistencyModel**: `strong`
- **derivedCopies**: [`registry.db approval_audit (registry-side audit log)`]
- **mutationEntrypoint**: `control plane /control/v1/approvals/:jobId`
- **projectionWriters**:

### [1]

- **constraint**: `only via control plane API; binding taken from control plane list, never from body; human token only`
- **writer**: `registry approve/deny proxy`


- **reconciliationDirection**: `none`

### [4]

- **authoritativeOwner**: `control plane`
- **authoritativeStore**: `control.db devices/leases`
- **canonicalState**: `fleet devices/leases`
- **consistencyModel**: `strong`
- **derivedCopies**: [`registry aggregate() view (read-only)`]
- **mutationEntrypoint**: `control plane (device agent reports)`
- **projectionWriters**:

### [1]

- **constraint**: `read-only projection of /control/v1/health|devices|leases; never writes control.db; degrades to identity cache when control plane unreachable`
- **writer**: `registry aggregate()`


- **reconciliationDirection**: `none`

### [5]

- **authoritativeOwner**: `device agent (screen capture)`
- **authoritativeStore**: `control.db evidence table + disk bytes`
- **canonicalState**: `fleet screenshots (evidence)`
- **consistencyModel**: `eventual`
- **derivedCopies**: [`registry screenCache (in-process cache)`]
- **mutationEntrypoint**: `device agent capture (registry never triggers)`
- **projectionWriters**:

### [1]

- **constraint**: `cache-only read of evidence table + disk bytes; realpath escape guard + SHA-256 + magic-number check; never triggers device Screen/job/lease`
- **writer**: `registry /api/fleet/screen`


- **reconciliationDirection**: `ownerToDerived`



## Test Baseline

- **baselineId**: `xw-m0-20260817-r0`
- **capturedAt**: `2026-08-17T13:00:00.000Z`
- **conclusion**: `PASS_PENDING`
- **gatedOn**: [`B2: three disposable Windows VMs + one B1 drill VM, all clonefile clones of one base snapshot (UTM/QEMU, Windows 10 Pro 19045 via autounattend index 4, UEFI ESP+MSR+NTFS, zh-CN/CST/cp936, m0test non-admin + m0admin admin; toolchain Node LTS 24.19.0/npm 11.x, Git 2.55.0.4, PowerShell 7.6.5, core.autocrlf=true; r-instances network-isolated, drill instance keeps host-isolated net)`, `B3: candidate C frozen (M0-A/B/C merged), one fresh VM + fresh clone per round`]
- **rounds**:

### [1]

- **resultSummary**: _(null)_
- **round**: 1
- **status**: `pending`
- **vmImage**: _(null)_

### [2]

- **resultSummary**: _(null)_
- **round**: 2
- **status**: `pending`
- **vmImage**: _(null)_

### [3]

- **resultSummary**: _(null)_
- **round**: 3
- **status**: `pending`
- **vmImage**: _(null)_


- **schemaId**: `xhs.m0.test-baseline.v1`
- **schemaVersion**: 1
- **scope**:

### [1]

- **command**: `npm run check`
- **purpose**: `syntax check of runtime + sync + import + ops entrypoints`
- **repo**: `registry`

### [2]

- **command**: `npm test`
- **purpose**: `integration tests (real registry subprocess + temp sqlite + fake control plane)`
- **repo**: `registry`

### [3]

- **command**: `npm run check`
- **purpose**: `syntax check of device-agent entrypoints`
- **repo**: `deviceAgent`

### [4]

- **command**: `npm test`
- **purpose**: `device-agent unit/integration tests`
- **repo**: `deviceAgent`

### [5]

- **command**: `npm run test:control`
- **distinctFrom**: `npm test`
- **purpose**: `control-plane tests (not double-counted with npm test)`
- **repo**: `deviceAgent`
