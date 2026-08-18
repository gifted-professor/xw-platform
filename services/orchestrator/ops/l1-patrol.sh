#!/bin/bash
# L1 只读巡探（Hermes cron --no-agent 托管，零 LLM 成本）——每 30min 对 ready 设备提交 snapshot（R0 免审批）
# 空闲才跑：01/02/04 任一有 lease 即整轮跳过（campaign/人工在用，不抢设备）。
# 静默即正常：全绿空输出（hermes 不发声）；异常才 stdout 发声（hermes 投递）+ 写知识库。
# 只读、零点击、lease 正道、机械白名单——绝不 recovery、绝不 R2 能力、绝不碰 03。
set -u
TOKEN=REDACTED_OLD_AGENT_TOKEN
REG=http://127.0.0.1:17930
REPO=/Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-device-agent-routing-v1-1
LOG=/Users/a1234/Desktop/Coding/xhs-registry/runtime/l1-patrol.log
RUNTIME_DIR=/Users/a1234/Desktop/Coding/xhs-registry/runtime
mkdir -p "$RUNTIME_DIR"
ALERTS=""

jf() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(($1)===undefined||($1)===null?'':(typeof ($1)==='object'?JSON.stringify($1):($1)))}catch{console.log('')}})"; }

# 1. 空闲守卫 + ready 设备清单（01/02/04，online 且未隔离 且无 lease）
DEVJSON=$(ssh -o ConnectTimeout=15 xhs-windows "curl.exe -s -m 10 -H \"x-registry-token: $TOKEN\" $REG/api/devices" 2>/dev/null)
if [ -z "$DEVJSON" ]; then echo "registry /api/devices 无响应——L1 巡探跳过"; exit 0; fi
BUSY=$(printf '%s' "$DEVJSON" | jf "j.devices.filter(x=>['01','02','04'].includes(x.alias)&&x.control.lease).length")
if [ "${BUSY:-0}" -gt 0 ]; then
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') fleet 忙（${BUSY} 台有 lease），L1 巡探整轮跳过" >> "$LOG"
  exit 0   # 静默退出，hermes 不发声
fi
READY=$(printf '%s' "$DEVJSON" | jf "j.devices.filter(x=>['01','02','04'].includes(x.alias)&&x.control.online&&!x.control.quarantined&&!x.control.lease).map(x=>x.alias+':'+x.control.deviceId).join('\n')")
if [ -z "$READY" ]; then
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') 无 ready 设备，L1 巡探跳过" >> "$LOG"
  exit 0
fi

cd "$REPO" || { echo "GPFS 未挂载，L1 巡探跳过"; exit 0; }
echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') L1 巡探开始 ready:$(echo "$READY" | tr '\n' ' ')" >> "$LOG"

for line in $READY; do
  ALIAS=${line%%:*}; UUID=${line#*:}
  TS=$(date +%s)
  IDEM="l1patrol-$ALIAS-$TS"
  OUT=$(node control-plane/devicectl.mjs --ssh xhs-windows job submit --actor hermes-l1-patrol --capability xianyu.observe.snapshot --device "$UUID" --idempotency-key "$IDEM" --params '{}' 2>&1)
  JOB=$(printf '%s' "$OUT" | jf "j.job&&j.job.jobId")
  if [ -z "$JOB" ]; then ALERTS="${ALERTS}${ALIAS} submit失败:$(printf '%s' "$OUT" | head -c 160)
"; echo "$(date -u '+%FT%TZ') $ALIAS submit失败" >> "$LOG"; continue; fi
  START=$(date +%s); STATUS=""
  while [ $(( $(date +%s) - START )) -lt 120 ]; do
    ST=$(node control-plane/devicectl.mjs --ssh xhs-windows job status --job "$JOB" 2>/dev/null)
    STATUS=$(printf '%s' "$ST" | jf "j.job&&j.job.status")
    case "$STATUS" in succeeded|failed|ambiguous|cancelled|recovery_required) break;; esac
    sleep 10
  done
  ELAPSED=$(( $(date +%s) - START ))
  case "$STATUS" in
    succeeded) echo "$(date -u '+%FT%TZ') $ALIAS snapshot GREEN job=$JOB dur=${ELAPSED}s" >> "$LOG" ;;
    "")        ALERTS="${ALERTS}${ALIAS} snapshot 超时(120s) job=$JOB 仍非终态
"; echo "$(date -u '+%FT%TZ') $ALIAS snapshot 超时 job=$JOB" >> "$LOG" ;;
    recovery_required) ALERTS="${ALERTS}${ALIAS} snapshot recovery_required job=$JOB（设备已隔离，需人工/主会话介入）
"; echo "$(date -u '+%FT%TZ') $ALIAS RECOVERY job=$JOB" >> "$LOG" ;;
    *) ALERTS="${ALERTS}${ALIAS} snapshot 异常 status=$STATUS job=$JOB
"; echo "$(date -u '+%FT%TZ') $ALIAS $STATUS job=$JOB" >> "$LOG" ;;
  esac
done

# 异常才发声 + 写知识库（scp 临时文件绕 PowerShell 引号地狱）
if [ -n "$ALERTS" ]; then
  printf 'L1 巡探异常：\n%b' "$ALERTS"
  TS=$(date +%Y%m%d%H%M)
  /usr/bin/python3 -c "import json,sys; print(json.dumps({'id':'l1-patrol-alert-$TS','app':'xianyu','category':'unknown','lifecycle':'probe_unknown','title':'L1 巡探异常 $TS','content':sys.stdin.read().strip()}))" <<< "$(printf '%b' "$ALERTS")" > "$RUNTIME_DIR/l1-alert-body.json"
  scp -o ConnectTimeout=10 "$RUNTIME_DIR/l1-alert-body.json" xhs-windows:'C:/Users/Public/xhs-registry/l1-alert-body.json' >/dev/null 2>&1
  ssh -o ConnectTimeout=10 xhs-windows "curl.exe -s -m 10 -X POST -H \"x-registry-token: $TOKEN\" -H \"content-type: application/json\" --data-binary \"@C:/Users/Public/xhs-registry/l1-alert-body.json\" $REG/api/knowledge" >/dev/null 2>&1
  rm -f "$RUNTIME_DIR/l1-alert-body.json"
fi
exit 0