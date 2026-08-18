#!/bin/bash
# 单步提交并等待终态（campaign 原语，只走 devicectl 正道）
# 用法: step.sh <alias> <device_uuid> <capability> <params_file> <timeout_s> <idem_key> <actor>
# 退出码: 0=绿(succeeded+verification+restoration) 2=红(failed/ambiguous/cancelled/verify不绿)
#         3=recovery_required 4=waiting_approval(不应出现) 5=wall-clock超时 6=基础设施错误
# stdout: 最终 job JSON（唯一一行大块输出）；进度全部走 stderr
set -u
ALIAS=$1; DEV=$2; CAP=$3; PARAMS_FILE=$4; TIMEOUT_S=$5; IDEM=$6; ACTOR=$7
REPO=/Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-device-agent-routing-v1-1
POLL_S=15

log() { echo "[step ${ALIAS} ${CAP}] $(date '+%T') $*" >&2; }

jfield() { # jfield <js-expr-on-j>  (stdin = JSON)
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const v=($1);console.log(v===undefined||v===null?'':(typeof v==='object'?JSON.stringify(v):v));}catch(e){console.log('');}})"
}

PARAMS=$(cat "$PARAMS_FILE") || { log "params 读取失败: $PARAMS_FILE"; exit 6; }
cd "$REPO" || { log "GPFS 未挂载？"; exit 6; }

SUBMIT_OUT=$(node control-plane/devicectl.mjs --ssh xhs-windows job submit \
  --actor "$ACTOR" --capability "$CAP" --device "$DEV" \
  --idempotency-key "$IDEM" --params "$PARAMS" 2>&1)
if [ $? -ne 0 ]; then log "submit 失败: $SUBMIT_OUT"; exit 6; fi
JOB=$(printf '%s' "$SUBMIT_OUT" | jfield "j.job&&j.job.jobId")
[ -n "$JOB" ] || { log "submit 输出无 jobId: $SUBMIT_OUT"; exit 6; }
log "submitted $JOB (idem=$IDEM)"

START=$(date +%s)
while :; do
  NOW=$(date +%s)
  if [ $((NOW - START)) -ge "$TIMEOUT_S" ]; then
    log "wall-clock 超时 ${TIMEOUT_S}s（job=$JOB 仍非终态，保留现场）"
    exit 5
  fi
  ST=$(node control-plane/devicectl.mjs --ssh xhs-windows job status --job "$JOB" 2>/dev/null)
  STATUS=$(printf '%s' "$ST" | jfield "j.job&&j.job.status")
  case "$STATUS" in
    succeeded)
      GREEN=$(printf '%s' "$ST" | jfield "(j.job.result&&j.job.result.verification&&j.job.result.verification.ok!==false)&&(j.job.result&&j.job.result.restoration?j.job.result.restoration.ok!==false:true)?1:0")
      printf '%s\n' "$ST"
      if [ "$GREEN" = "1" ]; then log "GREEN $JOB"; exit 0; else log "succeeded 但 verification/restoration 不绿"; exit 2; fi ;;
    failed|ambiguous|cancelled)
      printf '%s\n' "$ST"; log "RED $JOB status=$STATUS"; exit 2 ;;
    recovery_required)
      printf '%s\n' "$ST"; log "RECOVERY_REQUIRED ${JOB} (设备已隔离)"; exit 3 ;;
    waiting_approval)
      printf '%s\n' "$ST"; log "waiting_approval（不应出现于免审批能力）"; exit 4 ;;
    "")
      log "status 查询空响应，重试" ;;
    *)
      log "status=$STATUS elapsed=$((NOW - START))s" ;;
  esac
  sleep "$POLL_S"
done
