# `/xw` 鍙俊闂幆鎺ㄨ繘鎵ц璁″垝

- 鏃ユ湡锛?026-08-05
- 鐘舵€侊細Ready for execution
- 鍩虹嚎璁″垝锛歚docs/plans/2026-08-04-xw-capability-compounding-and-model-routing.md`
- 浼樺厛绾э細**鎴愬姛鐜?> 璇佹嵁瀹屾暣鎬?> 鎴愭湰**
- 鎬荤洰鏍囷細鎶婂凡缁忓彲宸ヤ綔鐨?task-plan銆丷ecipe Catalog銆乻hadow overlay 鍜?stall 钀界洏楠ㄦ灦锛屾帹杩涗负鍙瘉鏄庛€佸彲鍥炴粴銆侀粯璁ょ粡 `/xw` 浣跨敤鐨勯棴鐜€?
## 0. 鎵ц缁撹涓庡叧閿矾寰?
鏈疆涓嶄互鈥滃姛鑳芥枃浠跺瓨鍦ㄢ€濅负瀹屾垚鏍囧噯锛屽彧璁ゆ湇鍔＄鍙獙璇佽瘉鎹拰 live 杩愯缁撴灉銆?
```text
G0 鍙俊鍙戝竷/main 鐪熸簮
  -> G1 stall 鐪熷垽瀹?+ L2 璇婃柇闂幆
  -> G2 Recipe attempt 鏈嶅姟绔獙鐪?+ 鑷姩 replay
  -> G3 Douyin 閲嶆柊鍙栧緱鍙俊鏅嬬骇璇佹嵁
  -> G4 overlay alias 01 canary
  -> G5 leased Recipe Interpreter
  -> G6 /xw L0-L3 榛樿璺敱

骞惰杩愮淮绾匡細G0 鍚庢仮澶?01 ready锛沇indows main-safe 瑙嗚鑳藉姏鍙笌 G2-G4 骞惰寮€鍙戙€?```

纭€т緷璧栵細

1. `G0` 鏈€氳繃鍓嶅彲浠ュ啓浠ｇ爜銆佽窇绂荤嚎娴嬭瘯锛屼絾涓嶅緱鎶婄湡鏈虹粨鏋滆涓烘寮忛獙鏀躲€?2. Recipe 鏅嬬骇楠岀湡鏈畬鎴愬墠锛宱verlay 淇濇寔 `shadow`锛屼笉寰楀垏 `canary/active`銆?3. stall 鍙湪鈥滄柊椴滆娴嬭繛缁笉鍙樷€濇椂绉颁负 UI stall锛涘彧鏈夋椂閽熸祦閫濇垨娌℃湁鏂?dump 鏃跺彧鑳界О涓?progress silence銆?4. L2 鍙骇鍑哄彈 schema 绾︽潫鐨勮瘖鏂笌寤鸿锛屼笉鎸佹湁 lease/token锛屼笉鐩存帴纰拌澶囷紝涓嶆壒鍑?R2/R3銆?5. 姣忎釜鐪熸満鍔ㄤ綔鍙兘璧版寮?`job submit` 鎴栧彲瑙?leased session锛涚姝?GatewayOperator/涓存椂鑴氭湰鏃佽矾銆?
## 1. 褰撳墠鍩虹嚎涓庨渶瑕佺籂姝ｇ殑鐘舵€?
鎵ц浜哄紑宸ユ椂蹇呴』閲嶆柊璇诲彇 live `agent-entry.md`锛屼笉寰楀鐢ㄦ湰鑺傝澶囩姸鎬併€傛湰璁″垝钀界洏鏃剁殑宸茬煡鍩虹嚎涓猴細

- 02/03/04 `ready=yes`锛?1 涓烘棫 `ADAPTER_FAILED`銆佹湭闅旂銆乣ready=no`銆?- active lease銆乺unning job銆乸ending approval 鍧囦负 0銆?- control-plane `recipeOverlayMode=shadow`銆?- Windows runtime 褰撳墠閽夊湪鏈湴 `f53eb95...`锛屼絾 checkout 涓嶅湪 `main`锛岃 SHA 鏈繘鍏?`origin/main`銆?- `douyin.observe.search.wrap` 鏁版嵁搴撶姸鎬佷负 `implemented`锛屼絾 attempt 鏈笌鎺у埗闈㈣瘉鎹己缁戝畾锛歴pec 鐨?`evidenceHashes=[]`锛屽瓨鍦ㄧ┖ evidence锛屼笖涓€鏉?runId 涓庣湡瀹?run 鐩綍涓嶄竴鑷达紱鍥涙鎵ц涔熸湭璺ㄤ袱涓?worker 绐楀彛銆傚洜姝よ鐘舵€佸彧鑳借涓哄姛鑳借瘯璺戠粨鏋滐紝涓嶈兘浣滀负鍙俊鏅嬬骇楠屾敹銆?- `douyin.observe.snapshot.wrap` 浠嶄负 `candidate`銆?- evolve worker 鐩墠鍙?claim/evaluate/write overlay锛屼笉浼氳嚜鍔ㄦ彁浜?replay job銆?- Recipe Interpreter 鍙湁 plan-only whitelist锛沗/xw` 灏氭湭榛樿浣跨敤鍥涚骇璺敱鎵ц銆?- 褰撳墠 stall 瀹炵幇鍙湪 supervisor 浜嬩欢鍙戠敓鏃跺垽鏂紝鍗曚釜 `await` 鍗′綇鏈熼棿涓嶄細鍦ㄩ槇鍊兼椂涓诲姩瀹ｅ憡 stall锛涙棤鏂?snapshot 鐨勪簨浠惰繕鍙兘澶嶇敤鏃ф寚绾归€犳垚鍋囬槼鎬с€?
## 2. 鍏ㄥ眬瀹夊叏涓庤瘉鎹绾?
### 2.1 寮€宸ヤ笁闂?
浠讳綍鐪熸満姝ラ寮€濮嬪墠锛屾墽琛屾姤鍛婂繀椤绘槑纭洖绛旓細

1. 鏈鏄?job 杩樻槸 session锛?2. lease 鑳藉惁鍦?`GET /control/v1/leases` 鎴栭潰鏉跨湅鍒帮紵
3. capability id 鎴?recipe id/revision/descriptorHash 鏄粈涔堬紵

### 2.2 鐘舵€佷笌璁惧瑙勫垯

- 鍙褰撴 live 涓?`ready=yes && lease=free` 鐨?eligible 璁惧鎻愪氦銆?- 鎶栭煶榛樿 alias 01锛?1 涓嶅仴搴锋椂鍏堟寮?recover 01锛屼笉闈欓粯鎹?02/04銆?- 鍚屼竴璁惧涓嶅緱骞跺彂涓や釜閲嶄笟鍔?job锛?2222 缁х画浣跨敤鍏ㄥ眬浼犺緭閿併€?- 楠岃瘉鐮併€侀鎺с€佺櫥褰曞銆佹敮浠樸€佹湭鐭ヤ笉鍙€嗛〉闈㈢珛鍗冲仠姝€?- `xianyu.publish.full_draft_dry_run` 濡備粛灞炰簬闇€纭绛夌骇锛屽彧鎻愪氦銆佷笉鑷鎵瑰噯锛涗汉宸ユ壒鍑嗗悗鎵嶈兘鎵ц銆?- 涓嶅啓 `control.db`锛屼笉鏃佽矾娓呴殧绂伙紝涓嶆妸 reload 褰撹澶囧叆鍙ｃ€?
### 2.3 缁熶竴璇佹嵁瀵硅薄

鏈鍒掓柊澧炵殑 durable artifacts 鍧囦娇鐢?canonical JSON銆丼HA-256 鍜岀浉瀵硅矾寰勫紩鐢細

| Artifact | 鏈€浣庡唴瀹?|
|---|---|
| `xhs.stall-progress.v2` | run/job銆乻tep銆佸崟璋冨簭鍙枫€佷簨浠舵椂闂淬€乫reshness銆佹寚绾广€乻creen hash銆乻ignal type |
| `xhs.stall-verdict.v1` | `ui_stall/progress_silence/contract_violation/slow_progress`銆佷緷鎹簨浠惰寖鍥淬€乭ash |
| `xhs.l2-diagnostic-packet.v1` | redacted screenshot/dump refs銆佸け璐?step銆乤dapter error銆乺estoration 鐘舵€併€乻tall verdict |
| `xhs.l2-decision.v1` | 璇婃柇鐮併€佺疆淇″害銆佸缓璁姩浣溿€佺姝㈠姩浣溿€佹ā鍨?鑰楁椂/token銆佽緭鍏ヨ瘉鎹?hash |
| `xhs.recipe-attempt-receipt.v2` | 鏈嶅姟绔鍙栫殑 job/run 缁堟€併€乺elease/commit銆侀獙璇?鎭㈠/evidence/debt/ambiguity銆亀orker window |
| `xhs.overlay-publish-receipt.v1` | staged hash銆乤ctive hash銆乵ode銆乪ligible aliases銆佸彂甯冭€呫€佸洖婊氱洰鏍?|
| `xhs.task-routing-receipt.v1` | task plan銆丩0-L3銆佸尮閰嶆潵婧愩€佹ā鍨嬭皟鐢ㄣ€佸崌绾у師鍥犮€佹渶缁?job/session/closeout |

浠讳綍 client POST 鐨勫竷灏斿€奸兘涓嶆槸楠屾敹璇佹嵁锛涚姸鎬佸繀椤荤敱鏈嶅姟绔粠鍙俊鏉ユ簮鎺ㄥ銆?
## 3. G0 鈥?鎭㈠鍙俊鍙戝竷鍩虹嚎锛堟墍鏈夌湡鏈洪獙鏀跺墠缃級

### 3.1 鐩爣

璁┾€済ates 缁库€濆悓鏃惰瘉鏄庯細浠ｇ爜鏉ヨ嚜 GitHub `main`銆乄indows HEAD 涓?task-launch 涓€鑷淬€佸伐浣滄爲骞插噣銆佹祴璇?receipt 涓庡綋鍓?SHA 缁戝畾锛岃€屼笉鏄彧璇佹槑鏈湴 HEAD 鑳藉惎鍔ㄣ€?
### 3.2 瀹炴柦椤?
#### 璺敱浠?`C:\Users\Public\xhs-routing-v1-1`

1. 灏嗗綋鍓?Phase 1-5銆乷verlay銆乻tall 鐩稿叧鎻愪氦閫氳繃姝ｅ父 PR/merge 鏀跺叆 GitHub `main`锛涗笉寰楃户缁互 `codex/windows-repair-inbox-v1` 浣滀负鐢熶骇鍒嗘敮銆?2. Windows 閮ㄧ讲鍙厑璁革細
   - `git fetch origin`
   - `git switch main`
   - `git pull --ff-only origin main`
   - 楠岃瘉 `HEAD == origin/main` 涓斿垎鏀悕涓?`main`銆?3. 鎵╁睍 `scripts/assert-release-gates.mjs`锛?   - 鏍￠獙 `main` 涓?`origin/main` 绮剧‘涓€鑷达紱fetch 涓嶅彲鐢ㄦ椂 fail closed锛屼笉鐢ㄧ紦瀛樼粨鏋滃啋鍏呫€?   - test receipt 蹇呴』鍖呭惈 `gitCommit`銆佹墽琛屽懡浠ゃ€侀€氳繃/澶辫触璁℃暟銆佸畬鎴愭椂闂村拰 receipt body hash锛涘彧鎺ュ彈涓庡綋鍓?HEAD 涓€鑷翠笖鏈繃鏈熺殑 receipt銆?   - tracked-content hash 瑕嗙洊鍏ㄩ儴鐢熶骇鎵ц浠ｇ爜鍜?schema锛岃嚦灏戝寘鍚?`apps/`銆乣control-plane/`銆乣scripts/`銆佺敓浜?contracts锛涙祴璇?鏂囨。鍙崟鍒楋紝涓嶅緱婕忔帀 operator 涓?stall 浠ｇ爜銆?4. 鎵╁睍 `scripts/control-plane-task.ps1` 鍜?`task-launch` schema锛氱敱瀹夎鍣ㄦ寮忓啓鍏ュ苟鏍￠獙浠ヤ笅瀛楁锛岀姝㈡墜鏀?JSON 浣滀负闀挎湡閮ㄧ讲鏂规硶锛?   - `recipeOverlayMode`
   - `recipeOverlayPath`
   - `recipeOverlaySha256`
   - `requireTestReceipt`
   - `allowDirtyWorktree=false`
5. 瑙ｅ喅鍏ㄩ噺娴嬭瘯涓殑纭畾鎬уけ璐ワ紱Windows 鏉冮檺鍨嬫祴璇曞彲鍦?canonical CI 鐜鎵ц锛屼絾 release receipt 蹇呴』鎸囧悜璇?HEAD 鐨勫叏閲?CI 缁撴灉銆俉indows 鏈満鍙﹁窇 runtime-critical suite銆?
#### Registry 涓庡疄鏂借褰?
1. 鏇存柊鏈鍒掑熀绾裤€佸師璁″垝瀹炴柦璁板綍鍜岀郴缁熻繘搴︽枃妗ｏ紝璁板綍鏂扮殑 main SHA銆乺eload 鏃堕棿銆乷verlay mode/hash銆佸洓鏈?ready/lease銆?2. 淇濈暀鐜版湁閿欒鏅嬬骇璁板綍浣滀负涓嶅彲鍙樺巻鍙诧紝涓嶇洿鏀规暟鎹簱鎶归櫎锛涘湪 G2 閫氳繃姝ｅ紡 transition 灏嗕笉鍙俊 revision 鏍囦负 `degraded`锛屾柊 revision 閲嶆柊鏅嬬骇銆?
### 3.3 娴嬭瘯

```powershell
npm run check
npm test
node scripts/assert-release-gates.mjs C:\Users\Public\xhs-routing-v1-1
git status --short
git branch --show-current
git rev-parse HEAD
git rev-parse origin/main
```

鏂板娴嬭瘯鑷冲皯瑕嗙洊锛氶潪 main銆丠EAD 鏈帹閫併€乺eceipt 灞炰簬鏃?SHA銆乺eceipt 杩囨湡銆乷perator 鏂囦欢琚鏀广€乷verlay SHA 缂哄け鏃跺叏閮ㄦ嫆鍚姩銆?
### 3.4 楠屾敹闂?G0

- GitHub `main`銆乄indows `main`銆乣task-launch.gitCommit` 涓夎€呭悓涓€瀹屾暣 40 SHA銆?- `allowDirtyWorktree=false`锛屽伐浣滄爲骞插噣銆?- 鍏ㄩ噺 CI 缁匡紱Windows runtime-critical suite 缁匡紱test receipt 涓?SHA/鍛戒护/hash 缁戝畾銆?- active leases/jobs/approvals 涓?0 鏃舵墠 reload銆?- reload 鍚?health銆乤gent-entry銆乺elease manifest 鍧囨樉绀烘柊 SHA 涓庢湡鏈?mode銆?
### 3.5 鍥炴粴

鍥炴粴鍙兘閫夋嫨涓€涓凡杩涘叆 `main` 涓斿凡鏈夋祴璇?receipt 鐨勫巻鍙?SHA锛岄噸鏂拌蛋 task installer 鍜?reload锛涚姝?checkout 鏈鏍告湰鍦板垎鏀儹鍥炴粴銆?
## 4. G1 鈥?Stall 鐪熷垽瀹氫笌 L2 璇婃柇闂幆锛堟渶楂樹笟鍔′紭鍏堢骇锛?
### 4.1 鐩爣

鍦?adapter 鎬昏秴鏃朵箣鍓嶇暀涓嬪彲瑙ｉ噴淇″彿锛涘け璐ュ悗鑷姩褰㈡垚 L2 璇婃柇鍖呭拰 schema-bound 鍐崇瓥锛屽尯鍒嗭細

- `ui_stall`锛氳嚦灏戜袱娆?*鏂伴矞** UI 瑙傛祴鎸囩汗鐩稿悓锛屾寔缁秴杩囬槇鍊笺€?- `progress_silence`锛歴tep 宸茶繍琛岃秴杩囬槇鍊间絾娌℃湁鏂伴矞 UI/涓氬姟杩涘害锛涗笉鑳藉０绉?UI 鍐荤粨銆?- `slow_progress`锛氳娴嬫寔缁彉鍖栵紝铏芥參浣嗗湪鎺ㄨ繘銆?- `contract_violation`锛歚ADAPTER_TIMEOUT` 涓?progress 鏂囦欢缂哄け銆佷负绌恒€佹崯鍧忔垨娌℃湁 step_start/heartbeat銆?
### 4.2 淇 progress supervisor

淇敼鍊欓€夋枃浠讹細

- routing锛歚scripts/lib/stall-progress.mjs`
- routing锛歚scripts/xianyu-operator.mjs`
- routing锛歚apps/xianyu/adapter.mjs`
- routing锛歚control-plane/lib/control-plane.mjs`
- routing锛氱浉鍏?schema 涓?tests

鍏蜂綋瑕佹眰锛?
1. `run()` 鍦ㄨ皟鐢ㄩ暱姝ラ鍓嶅惎鍔ㄧ嫭绔?heartbeat timer锛岀粨鏉?寮傚父/Abort 鏃跺繀椤绘竻鐞?timer銆?2. heartbeat 鍙瘉鏄庤繘绋嬩粛娲荤潃锛岃褰?`lastFreshObservationAt` 鍜?`silenceMs`锛涙病鏈夋柊 snapshot 鏃朵笉寰楀鐢ㄦ棫鎸囩汗瀹ｅ憡 `ui_stall`銆?3. 闀垮惊鐜笌宸茬煡鎱㈡楠ゅ鍔?cooperative progress hook锛涙瘡涓畨鍏ㄥ瓙姝ラ缁撴潫钀?`step_progress`銆?4. 鍙湁鍦?transport 褰撳墠鍙畨鍏ㄩ噰鏍锋椂鎵嶅仛 periodic snapshot锛涗笉寰椾笌鍚屼竴璁惧鐨?operator call 骞跺彂浜夋姠 22222銆備笉鑳介噰鏍锋椂璁?`progress_silence`銆?5. `progress.jsonl` 姣忔潯鏈夐€掑 sequence锛涘崟鏉″啓鍏ュけ璐ュ舰鎴?evidence debt锛屼絾涓嶅緱浼€犲悗缁簨浠躲€?6. adapter timeout/failed 鍚庯紝control-plane 鍦?restoration 鍓嶅悗鍚勮鍙栦竴娆?bounded progress 鏂囦欢锛屾牎楠屾渶澶уぇ灏忋€丣SONL銆乺un/job 褰掑睘鍜?sequence锛岀敓鎴?`stall-verdict.json` 骞跺姞鍏?run manifest銆?7. 鎴愬姛姝ラ涓嶈兘鍥犱负鑰楁椂瓒呰繃闃堝€艰嚜鍔ㄥ甫 `llmEscalationRecommended=true`锛涘彧鏈?terminal failure 鎴栨槑纭?`ui_stall/progress_silence` 鎵嶅彲杩涘叆鍗囩骇闃熷垪銆?
### 4.3 鎺ュ叆 L2 璇婃柇

Registry 鏂板鏄惧紡 `stall_queue`锛岀敱 terminal closeout/鎺у埗闈?receipt **鏄惧紡 enqueue**锛岀姝?worker 鎵?runs 鏍圭洰褰曠寽浠诲姟銆?
鏂板鍊欓€夋ā鍧楋細

- `scripts/lib/stall-triage.mjs`
- `ops/xw-stall-worker.mjs`
- `contracts/stall-progress.v2.schema.json`
- `contracts/stall-verdict.v1.schema.json`
- `contracts/l2-diagnostic-packet.v1.schema.json`
- `contracts/l2-decision.v1.schema.json`

L2 杈撳叆鍙寘鍚?redacted銆乭ash-bound 璇婃柇鍖咃紝涓嶅惈 lease token銆乺untime device id銆佽处鍙峰瘑閽ユ垨鏃犲叧椤甸潰鏂囨湰銆傝緭鍑哄浐瀹氫负锛?
```text
diagnosisCode
confidence
recommendedAction = retry_once | recover_then_retry_once | explorer | escalate_human | no_action
reasonCodes[]
requiredCapabilityIds[]
forbiddenActions[]
modelId / calls / inputTokens / outputTokens / latencyMs
evidenceHashes[]
```

鎵ц绾緥锛?
- 绗竴杞厛 `shadow decision`锛氫骇鍑哄缓璁絾涓嶈嚜鍔ㄦ墽琛岋紝瀹屾垚 3 涓湡瀹炲け璐ュ寘瀹℃煡鍚庡啀寮€ canary action銆?- canary 鑷姩鍔ㄤ綔鍙厑璁?R0/R1銆乣read_only/replay_safe`锛屾渶澶氫竴娆?retry锛涘繀椤婚噸鏂?route銆侀噸鏂板彇寰楁寮?lease銆?- `ambiguous_on_timeout`銆佸凡鍙戠敓澶栭儴鏁堟灉銆乺estoration 澶辫触銆丷2/R3銆侀獙璇佺爜/椋庢帶涓€寰?`escalate_human`銆?- L2 涓嶇洿鎺ヨ皟鐢?operator锛涘畠鍙骇鍑哄缓璁紝dispatcher 閲嶆柊缁忚繃 policy銆乺eady銆乴ease銆乮dempotency 闂搞€?
### 4.4 娴嬭瘯

绂荤嚎蹇呮祴锛?
1. never-resolving Promise锛氬湪 `stallMs` 鍓嶅悗鑳界湅鍒?heartbeat 鍜?`progress_silence`锛屾棤闇€绛?adapter 鎬昏秴鏃躲€?2. 鎱絾鎴愬姛锛氭湁 heartbeat锛宼erminal success 涓嶅崌绾?L2銆?3. 涓ゆ鏂伴矞鐩稿悓鎸囩汗锛氳揪鍒伴槇鍊兼墠鍑?`ui_stall`銆?4. 鎸囩汗鍙樺寲锛氭竻闄?stall锛岃褰?`stall_cleared/slow_progress`銆?5. timeout 鏃?progress锛氱敓鎴?`contract_violation`銆?6. progress 璺緞閫冮€搞€佽秴澶ф枃浠躲€侀敊 runId銆佷贡搴?sequence锛歠ail closed銆?7. L2 闈?schema JSON銆佽秴鏃躲€乸rovider 涓嶅彲鐢細涓嶉噸璇曡澶囷紝鍗囩骇浜恒€?
### 4.5 鐪熸満楠屾敹

1. 鍏堥噸璇?live锛岄€夋嫨 ready/free 鐨勯棽楸?eligible 璁惧锛涙寮?submit `xianyu.publish.full_draft_dry_run`銆傚闇€鎵瑰噯锛屽彧鐢变汉鎵瑰噯銆?2. 杩愯鏈熼棿浠?run 鐨勬槑纭矾寰勮鍙?`progress.jsonl`锛岀‘璁ゆ€昏秴鏃跺墠宸叉湁 `step_start + heartbeat`銆?3. 鑻ヨ嚜鐒跺鐜板崱浣忥細瑕佹眰鍦?adapter timeout 鍓嶅嚭鐜?`ui_stall` 鎴?`progress_silence`锛涚粓鎬佸繀椤诲甫 stall verdict 鍜?L2 packet銆?4. 鑻ユ湰杞垚鍔熸垨鏈嚜鐒跺鐜?stall锛氬彧楠屾敹鈥滃績璺虫寔缁?+ 鎴愬姛涓嶈鎶モ€濓紝涓嶈兘瀹ｇО鐪熸満 stall 宸插疄璇侊紱stall 鏁呴殰鍒嗘敮鐢ㄧ绾?fault injection 淇濆簳锛岀瓑寰呬笅娆¤嚜鐒舵晠闅滆ˉ鐪熸満璇佹嵁銆?5. restoration 蹇呴』瀹屾垚锛涘け璐ュ垯鎸夋寮?recover 娴佺▼闅旂澶勭悊銆?
### 4.6 楠屾敹闂?G1

- timeout 鍓嶅彲瑙?progress锛涙垚鍔熸參姝ラ闆跺亣鍗囩骇銆?- 姣忎釜 ADAPTER_TIMEOUT 鍧囨槑纭綊绫伙紝涓嶈兘鍙墿 wall-clock timeout銆?- L2 packet/decision 鍧囨湁 schema銆乭ash銆佹ā鍨嬫寚鏍囷紱L2 鏈幏寰椾换浣曡澶囧嚟鎹€?- 鑷冲皯 1 涓?shadow L2 鍐崇瓥缁忕嫭绔?reviewer 鍒ゆ柇涓庤瘉鎹竴鑷村悗锛屾墠鍏佽涓嬩竴闃舵鍚敤涓€娆℃€?canary retry銆?
## 5. G2 鈥?Recipe 鏅嬬骇鏈嶅姟绔獙鐪熶笌鏃犱汉鍊煎畧 Replay

### 5.1 鐩爣

璁?recipe 鐘舵€佸彧鑳界敱鐪熷疄 job銆侀獙璇併€佹仮澶嶅拰璇佹嵁鎺ㄥ锛涘洓涓吉 attempt銆佺┖ evidence 鎴栭敊璇?runId 姘歌繙涓嶈兘鏅嬬骇銆?
### 5.2 Attempt v2

淇敼鍊欓€夋枃浠讹細

- registry锛歚scripts/lib/recipe-catalog.mjs`
- registry锛歚registry.mjs`
- registry锛歚ops/xw-evolve.mjs`
- registry锛歚ops/xw-evolve-worker.mjs`
- routing锛歫ob status/evidence receipt 鍙鎺ュ彛鍙?tests

API 鏀逛负锛歝lient 鍙彁浜?`recipeId/revision/runId/jobId`锛汻egistry 鑷繁浠?loopback control-plane 璇诲彇骞舵牎楠?terminal job 涓?evidence锛屼笉鎺ユ敹 client 鑷姤鐨?`verificationOk/restorationOk/result` 浣滀负浜嬪疄銆?
`xhs.recipe-attempt-receipt.v2` 鑷冲皯鍖呭惈锛?
- exact runId/jobId/capabilityId/params hash
- recipeId/revision/descriptorHash
- terminal status=`succeeded`
- verification hash 涓?`ok=true`
- restoration hash锛況equired 鏃跺繀椤?`ok=true`
- capability 澹版槑鐨?evidence requirements 鍙婃瘡涓?evidence ID/hash
- git commit銆乺eleaseId銆乸olicy version銆乷verlay hash
- ambiguity=false銆佹棤楂樼瓑绾?evidence debt
- alias/device profile銆亀orkerWindowId銆乫resh observation/relaunch receipt
- canonical receipt hash

鏅嬬骇瑙勫垯锛?
1. 涓嶅瓨鍦ㄧ殑 run/job銆乺un/job 涓嶄簰鐩稿尮閰嶃€乧apability 涓嶅尮閰嶃€佺┖ evidence requirement銆乨escriptor/policy 婕傜Щ鍧囨嫆缁濄€?2. 鐙珛鎴愬姛瑕佹眰 runId 鍜?jobId 閮戒笉鍚屻€?3. 鍚岃澶囩殑涓ゆ鐙珛鎴愬姛杩樺繀椤伙細涓嶅悓 workerWindowId锛岃法鑷冲皯涓€涓?worker 鍛ㄦ湡锛屽苟鏈夋柊鐨?relaunch/observation receipt銆?4. 鍓嶄袱娆″埌 `canary_only`锛涘啀涓ゆ鍙俊鎴愬姛鍒?`implemented`銆?5. descriptor/policy drift銆佽瘉鎹?鎭㈠澶辫触銆佸閮ㄦ晥鏋滄涔夌珛鍗?`degraded`锛涜繛缁袱娆¤涔夋柇瑷€澶辫触鍚屾牱闄嶇骇銆?6. transition 蹇呴』甯?receiptHash锛涚姝?`receiptHash=null` 鐨勮嚜鍔ㄦ檵绾с€?7. 鍘嗗彶閿欒璁板綍涓嶅彲鏀瑰啓锛氭妸鐜版湁 `douyin.observe.search.wrap@1` 姝ｅ紡 transition 涓?`degraded`锛屼互 revision 2 閲嶅缓銆?
### 5.3 鐪熸鐨?evolve worker

鐜版湁 worker 浠庘€渆valuate + write overlay鈥濆崌绾т负姣忚疆鏈€澶氫竴涓€欓€夌殑姝ｅ紡 orchestrator锛?
1. claim `evolve_queue`锛屽啓 workerWindowId 鍜屽箓绛?key銆?2. 浠?immutable recipe spec 瑙ｆ瀽搴曞眰 capability 涓?params銆?3. 璋冪敤姝ｅ紡 devicectl/control-plane job API锛涚姝㈢洿鎺ヨ皟鐢?adapter/operator銆?4. 鎶栭煶浠诲姟鍥哄畾 alias 01锛?1 闈?ready 鏃跺皢闃熷垪椤规爣涓?environment retry锛屽厛璧扮嫭绔?recover锛屼笉鎹㈡満銆?5. poll 鍒?terminal锛涚敱 Registry 鏈嶅姟绔敓鎴?attempt receipt銆?6. environment failure 閫€閬块噸鎺掞紝涓嶆敼鍙?recipe 鐘舵€併€?7. 璐ㄩ噺澶辫触鎸夐檷绾ц鍒欏鐞嗭紱涓€娆?cycle 涓嶉噸澶嶆彁浜ゅ悓涓€ job銆?8. 鎴愬姛 evaluate 鍚庡彧鐢熸垚 **staged overlay**锛屼笉鐩存帴鏇挎崲 active overlay銆?
### 5.4 瀵规姉娴嬭瘯

- 鍥涙潯绌?evidence/绌?result attempt 涓嶈兘鏅嬬骇銆?- 閿欎竴浣嶇殑 runId銆佹纭?jobId 涔熷繀椤绘嫆缁濄€?- 閲嶅 run 鎴栭噸澶?job 涓嶈绗簩娆°€?- 鍥涙鍚屼竴 worker window 鏈€澶氳涓€娆＄嫭绔嬬獥鍙ｃ€?- terminal failed銆乤mbiguous銆乺estoration false銆乪vidence debt銆乺elease drift 鍧囦笉璁℃垚鍔熴€?- Registry/worker 閲嶅惎鍚庡箓绛夛紝涓嶉噸澶嶆彁浜ゃ€?- environment failure 淇濇寔鍘熺姸鎬佸苟閲嶆帓銆?
### 5.5 楠屾敹闂?G2

- API 涓嶅啀鍏佽璋冪敤鑰呴€氳繃甯冨皵鍊煎埗閫犳垚鍔熴€?- 鎵€鏈夎嚜鍔?transition 鏈夐潪绌?receiptHash锛屽彲浠?API 杩芥函鍒版帶鍒堕潰 manifest/evidence銆?- worker 鍦ㄦ棤浜烘墜璺?`recordAttempt/evaluate` 鐨勬儏鍐典笅瀹屾垚鑷冲皯涓や釜涓嶅悓绐楀彛鐨?replay銆?- overlay 浠嶄负 shadow/staged锛屼笉鑷姩鎵╁ぇ鎵ц鏉冦€?
## 6. G3 鈥?Douyin 璇曠偣閲嶆柊鍙栧緱鍙俊闂幆璇佹嵁

### 6.1 鍓嶇疆

- G0銆丟2 宸查€氳繃銆?- 01 蹇呴』 live `ready=yes && lease=free`锛涘惁鍒欏厛鎵ц绗?10 鑺傛仮澶嶇嚎銆?- 鎵€鏈?replay 鐢?evolve worker 姝ｅ紡鎻愪氦锛屼笉鎵嬪伐琛?attempt JSON銆?
### 6.2 鎵ц椤哄簭

1. 浠ユ柊 revision 閲嶅缓 `douyin.observe.search.wrap`锛涙棫 revision 淇濇寔 degraded 鍘嗗彶銆?2. 鎺ㄨ繘 `douyin.observe.snapshot.wrap`銆?3. 姣忎釜 recipe锛?   - 涓や釜鐙珛 worker window + 鏂?relaunch/observation -> `canary_only`
   - 鍐嶄袱涓嫭绔?window -> `implemented`
4. 姣忔鍧囨鏌?terminal銆乿erification銆乺estoration銆乪vidence銆乺elease/commit銆乤lias 01銆?5. search 鐨勫叧閿瘝鍙傛暟蹇呴』鐢?schema 楠岃瘉锛泂napshot 蹇呴』闆跺弬鏁颁笖鏈夋埅鍥?椤甸潰鐘舵€佽瘉鎹€?
### 6.3 楠屾敹闂?G3

- 涓や釜 recipe 鐨?4 娆″彲淇?attempt 鍧囪兘浠?receipt 杩藉埌鐪熷疄 job/run/evidence銆?- 鏃犱汉宸ヤ吉閫?attempt銆佹棤鍚岀獥鍙ｅ噾娆℃暟銆佹棤绌?evidence銆?- `GET /api/recipes/:id` 鏄剧ず鐙珛绐楀彛銆佽瘉鎹畬鏁存€у拰 transition receipt hash銆?- staged overlay 鍙寘鍚闄?alias/绛栫暐涓嶅浜庡簳灞?capability 鐨?wrapper銆?
## 7. G4 鈥?Overlay 浠?shadow 鎺ㄨ繘鍒?alias 01 Canary

### 7.1 鍙戝竷妯″瀷

鎶?overlay 鍒嗘垚涓ゅ眰锛?
- `staged/recipe-catalog.json`锛歟volve worker 鑷姩鐢熸垚锛屼笉鍙墽琛屻€?- `active/recipe-catalog.json`锛氱嫭绔?review 鍚庡師瀛愬彂甯冿紝task-launch 閽変綇 expected SHA銆?
鏂板 `xhs.overlay-publish-receipt.v1`锛岃褰?staged/active hash銆乪ligible aliases銆乵ode銆乺eviewer銆乻ource recipe receipts 鍜屼笂涓€涓彲鍥炴粴 hash銆?
### 7.2 鎺у埗闈慨鏀?
1. `control-plane-task.ps1` 灏?`recipeOverlayMode/path/sha256` 鍐欏叆 task-launch銆?2. worker 灏?expected SHA 浼犵粰 bootstrap锛沚ootstrap 璋冪敤 `loadGeneratedOverlay({ expectedSha256 })`銆?3. health 涓?agent-entry 鏆撮湶瀹夊叏瀛楁锛歮ode銆乴oadOk銆乻ha256銆乬eneratedAt銆乺ecipeCount銆乺eason锛涗笉鏆撮湶鍐呴儴璺緞銆?4. `canary` 鍙厑璁?alias 01锛況esolver 浠嶉渶楠岃瘉搴曞眰 capability銆乺isk銆乺eady/lease 鍜?blocker銆?5. job/run manifest 鍐欏叆 `resolverSource=recipe`銆乺ecipeId/revision/descriptorHash/overlayHash銆?6. hash/schema/缁ф壙鏍￠獙澶辫触鏃朵笉鍔犺浇 staged 鏂囦欢锛涘綋鍓嶈繘绋嬬户缁娇鐢ㄤ笂涓€涓?active catalog锛岄噸鍚椂鑷冲皯鍥為€€闈欐€?capability锛屼笉鎵ц鏈獙璇?overlay銆?
### 7.3 Canary 楠屾敹

1. 鐙珛 reviewer 鏍稿 active overlay receipt銆?2. active leases/jobs/approvals=0 鏃跺皢 mode 鍒?`canary`銆乪ligible alias 浠?01銆乺eload銆?3. 浣跨敤 `/xw run` 鑷劧璇█鍚勬墽琛屼竴娆?search.wrap 涓?snapshot.wrap銆?4. 璇佹嵁蹇呴』璇佹槑锛?   - task-plan 閫夋嫨 recipe 鑰岄潪鐩存帴 capability fallback
   - L0 闆舵ā鍨嬭皟鐢?   - alias=01
   - job manifest 甯﹀畬鏁?recipe/overlay provenance
   - verification/restoration 鎴愬姛
5. 鍐嶇敤闈?01 alias 鍋?route plan锛屽繀椤绘嫆缁?recipe canary锛屼笉闈欓粯鎵ц銆?
### 7.4 鍥炴粴

浠讳綍寮傚父绔嬪嵆锛?
1. `recipeOverlayMode=off`
2. 鎸夐浂 lease/job/approval 绾㈢嚎 reload
3. 楠岃瘉闈欐€?capability 浠嶅彲鐢?4. 淇濈暀澶辫触 overlay 涓?receipt锛宺ecipe transition 涓?degraded锛涗笉鍒犻櫎鍘嗗彶

## 8. G5 鈥?Recipe Interpreter 鐪熸満 leased execution

### 8.1 鐩爣

鎶婄幇鏈?plan-only whitelist 鎺ュ埌 control-plane owned leased session锛汻egistry/LLM 鍙粰璁″垝锛屾帶鍒堕潰鎸佹湁鍜岄獙璇佹墽琛屾潈銆?
### 8.2 鍒嗕笁鎵逛笂绾?
#### Batch A锛氬彧璇诲師璇?
```text
dump, focus, screenshot, launch
```

#### Batch B锛氬彲閫嗗鑸?
```text
tapSelector, swipe, back
```

#### Batch C锛氬彈鎺ц緭鍏ヤ笌缁勫悎

```text
input, callCapability
```

姣忔壒鐙珛 canary锛涘墠涓€鎵规湭閫氳繃涓嶅緱鍚敤鍚庝竴鎵广€?
### 8.3 Runtime 濂戠害

1. 鍙墽琛?active/pinned overlay 涓?`canary_only|implemented` recipe銆?2. 鑾峰彇涓?recipe/capability/alias 缁戝畾鐨?exclusive session锛沴ease 蹇呴』 live 鍙銆?3. 姣忔 typed params銆乼imeout銆乸recondition銆乸ostcondition銆乪vidence銆乺estoration銆?4. semantic selector 浼樺厛锛涘潗鏍?fallback 蹇呴』缁戝畾 alias銆佸睆骞曞昂瀵搞€丄pp/version/profile hash锛屽苟鍦ㄦ柊椴滈〉闈㈡寚绾归€氳繃鍚庝娇鐢ㄣ€?5. 涓€姝ラ獙璇佸け璐ュ嵆鍋滄锛涙渶澶氭寜 spec 鍋氫竴娆?bounded recover锛屼笉璁╂ā鍨嬪湪 session 涓嚜鐢辩偣銆?6. restoration 澶辫触杩涘叆 recovery_required/quarantine锛岀姝㈢户缁笅涓€涓?recipe銆?7. interpreter 涓嶅緱鎵╁ぇ搴曞眰 capability 鐨?risk銆乸olicy銆乤liases銆佸閮ㄦ晥鏋滄垨瀹℃壒瑕佹眰銆?8. R2/R3 浠嶅彧鎻愪氦涓嶆壒鍑嗭紱璧勯噾/鏀粯 primitive 姘镐笉杩涘叆閫氱敤 whitelist銆?
### 8.4 娴嬭瘯涓庨獙鏀?
- unit锛氭湭鐭?primitive銆侀澶栧瓧娈点€佽矾寰勯€冮€搞€佽秴鏃躲€佸潗鏍?profile 婕傜Щ銆侀闄╂墿澶у叏閮ㄦ嫆缁濄€?- integration锛歠ake session 楠岃瘉鍚?lease 涓茶銆佹瘡姝?evidence銆佸け璐?restoration銆?- 鐪熸満 Batch A锛歛lias 01 璺戜竴涓函瑙傚療 recipe锛宭ease 鍏ㄧ▼鍙锛岀粨鏉熼噴鏀俱€?- Batch B锛氬彧鍋氬彲閫嗛〉闈㈠鑸苟鍥炲埌鍘熺姸鎬併€?- Batch C锛氬彧鍋氳緭鍏?dry-run锛屼笉鍙戦€?鍙戝竷锛屾竻鐞嗗悗鍥為獙銆?
### 8.5 楠屾敹闂?G5

- 鐪熸満娌℃湁浠讳綍鏃?lease primitive銆?- 姣忔 receipt 鍙洖鏀撅紝selector/鍧愭爣鏉ユ簮娓呮銆?- session 閲婃斁銆乺estoration銆乺eady 鐘舵€佸潎鍙瘉鏄庛€?
## 9. G6 鈥?`/xw` L0-L3 榛樿璺敱

### 9.1 鏂板叆鍙?
瀹炵幇鎴栬ˉ榻?`ops/xw-run.mjs`锛岃 `/xw run <鑷劧璇█>` 浣跨敤缁熶竴 task plan锛涗繚鐣欐樉寮?`run/explore/recover/repair`銆?
鎵ц椤哄簭锛?
1. `xw-closeout begin --mode runner`锛屾寔鏈夊敮涓€ closeout runId銆?2. 璇诲彇 live agent-entry銆乧apabilities銆乮mplemented recipes銆乼ask packet銆?3. 缂栬瘧 `xhs.task-plan.v1`锛屾寜 capability -> implemented recipe -> capability composition -> Explorer -> Repair 鐨勯『搴忚В鏋愩€?4. 閲嶆柊璁＄畻鏉冮檺銆乺isk銆乺elease銆乪ligible alias銆乺eady/lease銆乥locker銆?5. route plan锛涙弧瓒虫潯浠跺悗姝ｅ紡 submit job/session銆?6. 鍏抽敭鑺傜偣 `step`锛岀粨鏉?`close`锛屽啓 routing receipt銆?
### 9.2 鍥涚骇璺敱

| 灞傜骇 | 鍏佽鍐呭 | 妯″瀷瑙勫垯 | 缁堢偣 |
|---|---|---|---|
| L0 | 绮剧‘ capability/recipe锛屽弬鏁板畬鏁?| 0 妯″瀷璋冪敤 | 绾剼鏈?job/session |
| L1 | 鎰忓浘鍒嗙被銆佸弬鏁版娊鍙栥€佹湁闄愭灇涓?| 渚垮疁妯″瀷锛屽彧鎺ュ彈 JSON Schema | 鍥炲埌 L0 鎵ц |
| L2 | stall銆佹湭鐭ラ〉銆佸畾浣嶆紓绉汇€佹柊娴佺▼銆佹簮鐮佽瘖鏂?| 寮烘ā鍨嬶紝璇佹嵁鍖呰緭鍏ワ紝schema 杈撳嚭 | bounded retry/Explorer/Repair/浜?|
| L3 | 璧勯噾銆佹斂绛栧彉鍖栥€佸閮ㄦ晥鏋滄涔夈€佷汉宸ラ獙鏀?| 涓嶈嚜鍔ㄥ喅绛?| 绛変汉纭 |

`/xw <鏈煡鐩爣>` 浠嶆寜 Explorer 璺敱锛汱2 鍙互杈呭姪 Explorer 璇婃柇锛屼絾涓嶈兘鎶婃湭鐭ョ洰鏍囩洿鎺ュ彉鎴愯嚜鐢辫澶囨帶鍒躲€?
### 9.3 姣忔蹇呴』钀界洏

`xhs.task-routing-receipt.v1`锛?
- normalized goal銆乸lan hash銆乻elected candidate 涓庡尮閰嶄緷鎹?- L0-L3銆佹ā鍨?id/calls/token/latency
- 鍗囩骇鍘熷洜涓庨檷绾у師鍥?- capability 鎴?recipe provenance
- route decision銆乯ob/session銆乿erification/restoration
- closeout runId/manifest hash銆佹渶缁堢粨鏋?
Token 鍙綔缁熻銆佹瘮杈冨拰涓嬫矇浼樺寲锛屼笉璁剧‖棰勭畻闂ㄦ銆?
### 9.4 楠屾敹鐭╅樀

- 宸茬煡闆跺弬鏁?capability -> L0銆侀浂妯″瀷銆?- 宸茬煡甯﹀弬鏁?recipe锛屽弬鏁伴綈 -> L0銆?- 鑷劧璇█缂轰竴涓弬鏁?-> L1 schema extraction -> L0銆?- 鏈煡椤甸潰 -> L2/Explorer锛屼笉鐚?capability銆?- stall verdict -> L2 packet锛屼笉甯告€佽皟鐢ㄥ己妯″瀷銆?- 鏀粯/鏀跨瓥/姝т箟 -> L3锛岃澶囧姩浣?0 鎴栫瓑寰呬汉銆?- 澶氫釜鐩歌繎鍊欓€?-> 鍙棶涓€涓渶灏忔緞娓呴棶棰樸€?
### 9.5 楠屾敹闂?G6

- `/xw skills` 榛樿鍙睍绀烘寮?capability + 鍙俊 implemented recipe銆?- `/xw run` 鐨勬瘡娆℃墽琛岄兘鏈?closeout 鍜?routing receipt銆?- L0 闆舵ā鍨嬨€丩1 schema-only銆丩2 鏈夊崌绾у師鍥犮€丩3 涓嶈嚜鍔ㄦ墽琛屽潎鏈夊疄璇併€?
## 10. 骞惰杩愮淮绾?
### 10.1 鎭㈠ 01 ready

鍙湪 G0 閮ㄧ讲瀹屾垚鍚庢墽琛岋細

1. 閲嶈 live锛涚‘璁?01 浠嶄负鏅€?failed/ready=no銆佹湭闅旂銆乴ease free銆?2. 鎸?`/xw recover 01` 瑙勫垯锛岄€夋嫨 01 涓婂彲鐢ㄧ殑鍙 R0 snapshot capability 鎻愪氦涓€鍗曘€?3. 涓嶇敤澶栧彂/闇€瀹℃壒 capability 鍒风豢锛屼笉鏀?control.db銆?4. 鎴愬姛鏍囧噯锛?1 `ready=yes`銆乣quarantined=no`銆佹棤 unresolved failure銆乴ease released銆?
杩欎竴姝ユ槸 G3 Douyin replay 鐨勫墠缃紝涓嶅緱鐢?02/04 缁曡繃銆?
### 10.2 Windows main-safe 瑙嗚鑳藉姏

閫夋嫨锛?*浼樺厛鎶婃渶灏?main-safe 楠岃瘉鑳藉姏绉绘鍒?Windows锛屼笉鎶?Mac 鍙樻垚鐢熶骇 recover 鐨勫湪绾夸緷璧栥€?*

瀹炵幇椤哄簭锛?
1. 鍏堢敤 package/activity + UI hierarchy 璇嗗埆瀵瑰簲 App 涓婚〉闈€?2. hierarchy 涓嶈冻鏃朵娇鐢?Windows 鏈湴杞婚噺 OCR/妯℃澘鎸囩汗锛屼粎璇嗗埆棰勫厛 allowlist 鐨勫簳鏍忔爣绛?甯冨眬锛涗笉鎶婃暣灞忔枃鏈氦缁欒繙绔ā鍨嬨€?3. 瑕佹眰杩炵画涓ゅ抚涓€鑷淬€佸畬鏁村簳鏍忋€佹纭?package/activity锛岃緭鍑?`main-safe` receipt 涓庢埅鍥?hash銆?4. 浣庣疆淇°€丱CR 涓嶅彲鐢ㄣ€佸竷灞€婕傜Щ涓€寰?fail closed锛沄GP 缂哄け涓嶈兘閫€鍖栨垚鈥滅湅璧锋潵鍍忎富椤碘€濄€?5. 灏?receipt 鎺ュ叆 `ops/recover-main-safe.mjs` 鐨勭洰妫€ envelope锛涗粛璧?`recover-inspect -> record -> job recover` 姝ｉ亾銆?
楠屾敹锛氳嚦灏戣鐩?main-safe銆侀潪涓婚〉銆佽亰澶?缂栬緫椤点€佸脊绐楄鐩栥€丱CR 涓嶅彲鐢ㄤ簲绫?fixture锛涚湡鏈哄彧鍋氫竴娆?read-only inspect锛屼笉娓呴殧绂讳綔涓洪杞?canary銆?
## 11. Commit / Review / Deploy 鍒囩墖

姣忎釜鍒囩墖鐙珛 commit銆佺嫭绔嬫祴璇?receipt銆佺嫭绔?review锛涗笉瑕佹妸鍏ㄩ儴宸ヤ綔鍫嗘垚涓€涓笉鍙洖婊氭彁浜ゃ€?
| 鍒囩墖 | 鍐呭 | 鐙珛楠屾敹 |
|---|---|---|
| C0 | main/remote/test-receipt/task-launch schema 闂?| CI + Windows deploy reviewer |
| C1 | stall progress v2 + verdict | 鍗曟祴 + fault integration reviewer |
| C2 | L2 packet/queue/worker shadow | schema/security reviewer |
| C3 | attempt receipt v2 + promotion/degrade | 瀵规姉娴嬭瘯 reviewer |
| C4 | unattended evolve replay | 涓?worker windows 鐪熸満 reviewer |
| C5 | staged/active overlay + expected SHA + health | deploy reviewer |
| C6 | alias 01 Douyin canary | 闈炴墽琛岃€呯嫭绔嬮獙鏀?|
| C7 | interpreter Batch A/B/C | 姣忔壒鐙珛瀹夊叏楠屾敹 |
| C8 | `/xw` 榛樿 L0-L3 + routing receipt | 绔埌绔?reviewer |
| C9 | Windows main-safe 鏈湴瑙嗚 | fixture + recover reviewer |

鎵ц鑰呬笉寰楄嚜璇勯€氳繃锛汳ac Governance/Kimi 鎴?watchdog 鍋氱嫭绔?diff/璇佹嵁楠屾敹锛孯2/R3 浠嶇敱浜哄喅瀹氥€?
## 12. 鏈€灏忓懡浠や笌璇佹嵁妫€鏌ユ竻鍗?
### 12.1 姣忎釜鐪熸満鎵规寮€濮?
```powershell
curl.exe -s http://127.0.0.1:17930/agent-entry.md
curl.exe -s http://127.0.0.1:17920/control/v1/leases
```

璁板綍 ready/lease/job/approval銆乧apability/recipe id銆乤ctor銆乮dempotency key銆備笟鍔℃彁浜ょ户缁娇鐢?live agent-entry 缁欏嚭鐨?approved devicectl skeleton銆?
### 12.2 姣忎釜鎵规缁撴潫

- job terminal 鐘舵€佷笌 runId
- verification/restoration
- lease released
- 璁惧 ready/quarantine/unresolved failure
- manifest/evidence/receipt hashes
- recipe/overlay transition receipt锛堝閫傜敤锛?- closeout bundle 涓?Mac review pending

### 12.3 绂佹鐢ㄤ綔瀹屾垚璇佹嵁

- 鍙湁鑱婂ぉ鎬荤粨銆乻tderr 鎴栨埅鍥炬枃浠跺悕锛屾病鏈?manifest/hash銆?- 鎵嬪～ `verificationOk=true`銆乣restorationOk=true`銆?- 鐩稿悓 worker window 杩炶窇鍥涙鍑戞暟銆?- task-launch 鎸囧悜鏈繘鍏?`origin/main` 鐨勬湰鍦?SHA銆?- shadow 鑳借鏂囦欢灏卞绉?canary 鍙墽琛屻€?- adapter timeout 鍚庢墠琛ュ啓涓€鏉♀€滄鍓嶅凡 stall鈥濈殑浜嬪悗璁板綍銆?
## 13. 鏁翠綋 Definition of Done

鍏ㄩ儴婊¤冻鎵嶅绉版湰璁″垝瀹屾垚锛?
1. Windows 鐢熶骇 checkout 涓?`main`锛孒EAD=origin/main=task-launch full SHA锛屾祴璇?receipt 寮虹粦瀹氥€?2. 闂查奔闀夸换鍔″湪 timeout 鍓嶆寔缁惤 progress锛涙垚鍔熸參姝ラ涓嶈鎶ワ紱姣忎釜 timeout 鏈夊彲淇?verdict銆?3. L2 鑳借鍙栨樉寮忛槦鍒椾腑鐨勮瘖鏂寘骞惰緭鍑?schema-bound 鍐崇瓥锛涘己妯″瀷鍙湪澶辫触/鏈煡璺緞浣跨敤銆?4. Recipe 鏅嬬骇鍙帴鍙楁湇鍔＄楠岃瘉 attempt锛涚┖ evidence銆侀敊 run銆佸悓绐楀彛閲嶅鏃犳硶鏅嬬骇銆?5. evolve worker 鏃犱汉鍊煎畧瀹屾垚姝ｅ紡 replay銆乺eceipt銆乪valuate锛涚幆澧冨け璐ヤ笉姹℃煋鐘舵€併€?6. Douyin search/snapshot 閫氳繃鍥涗釜鍙俊鐙珛绐楀彛鏅嬬骇銆?7. overlay active 鏂囦欢鏈夊閮?expected SHA 鍜?publish receipt锛沜anary 浠?alias 01锛屽洖婊氬凡婕旂粌銆?8. Interpreter 鑷冲皯瀹屾垚 Batch A 鐪熸満 leased canary锛涘悗缁壒娆℃寜闂ㄩ€愮骇寮€鍚€?9. `/xw` 榛樿杈撳嚭骞舵墽琛?L0-L3 task plan锛涙瘡娆℃湁 routing receipt銆乧loseout 鍜屾ā鍨嬫寚鏍囥€?10. 01 ready 宸叉仮澶嶏紱Windows main-safe 楠岃瘉涓嶅啀纭緷璧?Mac/VGP锛屼綆缃俊浠?fail closed銆?11. PROGRESS/鐭ヨ瘑搴?鍘熻鍒掑疄鏂借褰曞凡鏇存柊锛涜俯鍧戝拰楠岃瘉閰嶆柟甯?`appliesTo/verifyMode`銆?
## 14. 鎺ㄨ崘鐨勪笅涓€娆″疄闄呮淳宸?
鍙淳涓€涓?C0+C1 宸ョ▼鎵规锛屼笉鍚屾椂寮€鍚?canary锛?
```text
鐩爣锛氭妸 Windows 鍙戝竷鎭㈠鍒?GitHub main 鐪熸簮锛屽苟淇 stall supervisor锛屼娇 never-resolving step
鍦?adapter timeout 鍓嶄骇鐢?progress_silence锛屾參鎴愬姛涓嶈鎶ワ紱澶辫触鍚庣敓鎴?hash-bound stall verdict銆?
绂佹锛氱璁惧銆佸垏 overlay canary/active銆佹敼 control.db銆佹墜濉?recipe attempt銆佽皟鐢?LLM銆?楠屾敹锛歮ain/receipt gate tests + stall never-resolving/slow-success/path-integrity tests 鍏ㄧ豢锛?鐢辩嫭绔?reviewer 瀹℃牳鍚庡啀閮ㄧ讲 shadow銆?```

璇ユ壒閫氳繃鍚庯紝涓嬩竴鎵规墠鎺?L2 shadow 鍐崇瓥涓?Recipe attempt v2銆?
## 15. 实施进度（2026-08-05）

| 切片 | 状态 | 证据 |
|---|---|---|
| C0+C1 | **已 merge + Windows main 部署** | G0 gates 持续收紧（PR#31：minPassed≥15 + ≥2 runtime-critical 引用） |
| C2 L2 shadow | **本仓已落代码** | stall_queue / shadow decide；队列/worker 调度仍未闭环 |
| C3 attempt v2 | **已生效** | 拒收 client 布尔；search.wrap@1 degraded；attempt 走 control-plane 验真 |
| C4 replay | **编排已上；晋级可信度待重做** | search@2 / snapshot@1 库内 implemented，但是手工连跑窗口，非正式独立调度验收 |
| G3 snapshot | **设备修复已完成；晋级待重验** | dump/launch 修通（PR#26–29）；return-home soft-fail 修通（PR#30–31） |
| C5+ canary | **已退回 shadow（未闭环）** | 仅证明 overlay 加载 + 离线 alias 过滤；manifest 无 recipeId/resolverSource；待 resolver 后再开 |

**当前生产钉点**：Windows `main` == `origin/main` == `task-launch.gitCommit` == `3b11bd8c7f69a776ff345159bdad9d50b1452d6f`；`recipeOverlayMode=shadow`；`recipeOverlaySha256=bf25b0a227cd42500ea374b13804294ba709a32df746712f564b469021b708db`
