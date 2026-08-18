#!/bin/bash
# xhs scout watchdog — 检测变化，有变化才唤醒 kimi supervisor（零 LLM 成本的哨兵）
# launchd: com.xhs.scout-watchdog, 每 1800s
set -u

WD="/Users/a1234/Desktop/Coding/xhs-registry/watchdog"
REPO="/Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-device-agent-routing-v1-1"
BRANCH="main"
STATE="$WD/state.json"
LOG="$WD/watchdog.log"
COOLDOWN_S=2700   # 两次 kimi 唤醒最小间隔 45min
PATH="$HOME/.local/bin:$HOME/.mimocode/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export PATH

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

[ -f "$STATE" ] || echo '{"lastSha":"","flags":[],"lastKimiRun":0}' > "$STATE"
lastSha=$(/usr/bin/python3 -c "import json;print(json.load(open('$STATE')).get('lastSha',''))" 2>/dev/null)
lastKimiRun=$(/usr/bin/python3 -c "import json;print(json.load(open('$STATE')).get('lastKimiRun',0))" 2>/dev/null)
knownFlags=$(/usr/bin/python3 -c "import json;print(' '.join(json.load(open('$STATE')).get('flags',[])))" 2>/dev/null)

CHANGES=""

# --- 1. git 新 commit ---
if git -C "$REPO" fetch origin "$BRANCH" --quiet 2>>"$LOG"; then
  remoteSha=$(git -C "$REPO" rev-parse "origin/$BRANCH" 2>/dev/null)
  if [ -n "$remoteSha" ] && [ "$remoteSha" != "$lastSha" ]; then
    n=$(git -C "$REPO" rev-list --count "${lastSha:-HEAD~20}..origin/$BRANCH" 2>/dev/null || echo "?")
    CHANGES="${CHANGES}新 commit: ${lastSha:-none}..${remoteSha}（${n} 个）\n"
    NEW_SHA="$remoteSha"
  fi
else
  log "git fetch 失败（GPFS 未挂载？），跳过本轮"
  exit 0
fi

# --- 2. 知识库新 flag-engineer ---
KB=$(ssh -o ConnectTimeout=12 xhs-windows 'cmd /c "curl.exe -s -m 10 http://127.0.0.1:17930/api/knowledge"' 2>/dev/null)
if [ -n "$KB" ]; then
  flags=$(printf '%s' "$KB" | /usr/bin/python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  print(' '.join(k['id'] for k in d.get('knowledge',[]) if k.get('needsEngineer')))
except Exception: pass")
  for f in $flags; do
    case " $knownFlags " in
      *" $f "*) ;;
      *) CHANGES="${CHANGES}新 flag-engineer: ${f}\n" ;;
    esac
  done
  NEW_FLAGS="$flags"
fi

# --- 无变化：静默退出（零 LLM 成本）---
if [ -z "$CHANGES" ]; then
  exit 0
fi

# --- 冷却期检查 ---
# 注意：冷却期内不推进 state（否则被抑制的变更被永久吞掉、冷却结束后不会再触发验收）。
# 同一变更会被每轮重检测，直到冷却结束真正唤醒一次 kimi 才消费。
now=$(date +%s)
if [ $((now - lastKimiRun)) -lt $COOLDOWN_S ]; then
  log "有变化但在冷却期，跳过 kimi 唤醒（state 不推进，冷却结束后重试）：$(printf '%b' "$CHANGES" | tr '\n' ' ')"
  exit 0
fi

# --- 唤醒 kimi supervisor ---
log "唤醒 kimi：$(printf '%b' "$CHANGES" | tr '\n' ' ')"
PROMPT=$(/usr/bin/python3 -c "
import sys
tpl=open('$WD/SUPERVISOR.md').read()
print(tpl.replace('{{CHANGES}}', sys.argv[1]))" "$(printf '%b' "$CHANGES")")

kimi --print --quiet \
  -w /Users/a1234/Desktop/Coding/xhs-registry \
  --add-dir "$REPO" \
  --add-dir /Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-windows \
  -p "$PROMPT" >> "$LOG" 2>&1
rc=$?
log "kimi 退出 rc=$rc"

# 只有 kimi 实跑成功才消费变更；崩掉的运行不推进 sha/flags（只记 lastKimiRun 维持冷却，防崩溃循环烧钱）
if [ "$rc" -eq 0 ]; then
  /usr/bin/python3 - "$STATE" "${NEW_SHA:-$lastSha}" "${NEW_FLAGS:-$knownFlags}" "$now" <<'EOF'
import json,sys
p,sha,flags,now=sys.argv[1],sys.argv[2],sys.argv[3].split(),int(sys.argv[4])
s=json.load(open(p)); s['lastSha']=sha; s['flags']=flags; s['lastKimiRun']=now
json.dump(s,open(p,'w'),indent=1)
EOF
else
  /usr/bin/python3 - "$STATE" "$now" <<'EOF'
import json,sys
p,now=sys.argv[1],int(sys.argv[2])
s=json.load(open(p)); s['lastKimiRun']=now
json.dump(s,open(p,'w'),indent=1)
EOF
fi
