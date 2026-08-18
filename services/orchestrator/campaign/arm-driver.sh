#!/bin/bash
# arm-driver.sh — 主会话后台驱动一个臂的剩余步骤计划（替代横死子代理）
# 用法: arm-driver.sh <alias> <device_uuid> <plan_file>
# plan_file 每行: <round> <step> <capability> <fixture> <timeout_s>   (# 开头注释行跳过)
# 退出码: 0=计划全绿跑完  2=某步红(重试后仍红)  3=遇recovery需主会话介入  4=waiting_approval  5=超时  6=infra
# recovery/红/超时一律 fail-closed 停臂保留现场，不擅自恢复（恢复需主会话看截图分类）。
set -u
ALIAS=$1; UUID=$2; PLAN=$3
DIR=/Users/a1234/Desktop/Coding/xhs-registry
LOG=$DIR/campaign/logs/arm-$ALIAS.log
STEP_SH=$DIR/campaign/step.sh
ACTOR=claude-arm-$ALIAS

logf() { printf '%s [driver %s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$ALIAS" "$*" >> "$LOG"; echo "[$ALIAS] $*"; }

jobid() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log((j.job&&j.job.jobId)||'')}catch{console.log('')}})"; }

GREEN_STEPS=0
while read -r ROUND STEP CAP FIX TIMEOUT; do
  [ -z "${ROUND:-}" ] && continue
  case "$ROUND" in \#*) continue;; esac
  for ATTEMPT in 1 2; do
    TS=$(date +%s)
    IDEM="stab3-$ALIAS-$STEP-r${ROUND}-a${ATTEMPT}-${TS}"
    logf "r$ROUND $STEP attempt=$ATTEMPT cap=$CAP start"
    START=$(date +%s)
    JOBJSON=$(bash "$STEP_SH" "$ALIAS" "$UUID" "$CAP" "$FIX" "$TIMEOUT" "$IDEM" "$ACTOR" 2>>"$LOG")
    RC=$?
    ELAPSED=$(( $(date +%s) - START ))
    JID=$(printf '%s' "$JOBJSON" | jobid)
    case "$RC" in
      0) logf "r$ROUND $STEP GREEN job=$JID exit=0 dur=${ELAPSED}s"; GREEN_STEPS=$((GREEN_STEPS+1)); break;;   # break attempt loop -> next step
      2) if [ "$ATTEMPT" = "1" ]; then logf "r$ROUND $STEP RED job=$JID exit=2 dur=${ELAPSED}s — 同 fixture 换幂等键重试"; continue; fi
         logf "r$ROUND $STEP RED(重试仍红) job=$JID exit=2 dur=${ELAPSED}s — 臂终止"; echo "$ALIAS ABORTED_RED r$ROUND $STEP $JID" > "$DIR/campaign/logs/arm-$ALIAS.abort"; exit 2;;
      5) logf "r$ROUND $STEP TIMEOUT job=$JID exit=5 dur=${ELAPSED}s — 臂终止保留现场"; echo "$ALIAS ABORTED_TIMEOUT r$ROUND $STEP $JID" > "$DIR/campaign/logs/arm-$ALIAS.abort"; exit 5;;
      6) if [ "$ATTEMPT" = "1" ]; then logf "r$ROUND $STEP INFRA job=$JID exit=6 dur=${ELAPSED}s — 重试"; continue; fi
         logf "r$ROUND $STEP INFRA(重试仍错) job=$JID exit=6 — 臂终止"; echo "$ALIAS ABORTED_INFRA r$ROUND $STEP $JID" > "$DIR/campaign/logs/arm-$ALIAS.abort"; exit 6;;
      4) logf "r$ROUND $STEP WAITING_APPROVAL job=$JID exit=4 — 免审批能力不该出现，臂终止"; echo "$ALIAS ABORTED_APPROVAL r$ROUND $STEP $JID" > "$DIR/campaign/logs/arm-$ALIAS.abort"; exit 4;;
      3) logf "r$ROUND $STEP RECOVERY_REQUIRED job=$JID exit=3 dur=${ELAPSED}s — 设备已隔离，fail-closed 停臂等主会话看截图"; echo "$ALIAS ABORTED_RECOVERY r$ROUND $STEP $JID" > "$DIR/campaign/logs/arm-$ALIAS.abort"; exit 3;;
      *) logf "r$ROUND $STEP 未知退出码 rc=$RC job=$JID — 臂终止"; echo "$ALIAS ABORTED_UNKNOWN r$ROUND $STEP $JID rc=$RC" > "$DIR/campaign/logs/arm-$ALIAS.abort"; exit 6;;
    esac
  done
done < "$PLAN"

logf "计划全绿跑完 green_steps=$GREEN_STEPS — 臂 COMPLETE"
echo "$ALIAS COMPLETE green_steps=$GREEN_STEPS" > "$DIR/campaign/logs/arm-$ALIAS.done"
exit 0