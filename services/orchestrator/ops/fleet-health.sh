#!/bin/bash
# 舰队健康哨兵（Hermes cron 托管，无 LLM 成本）——静默即正常，只在异常时输出
set -u
TOKEN=REDACTED_OLD_AGENT_TOKEN
SYNC_LOG=/Users/a1234/Desktop/Coding/xhs-registry/sync-feishu.log

deep=$(ssh -o ConnectTimeout=15 xhs-windows "curl.exe -s -m 10 -H \"x-registry-token: $TOKEN\" \"http://127.0.0.1:17930/api/health?deep=1\"" 2>/dev/null)
if [ -z "$deep" ]; then
  echo "registry 17930 无响应（SSH 或服务异常）——检查 XhsDeviceRegistry 计划任务与 netstat :17930"
  exit 0
fi

printf '%s' "$deep" | /usr/bin/python3 -c "
import json,sys
try: h=json.load(sys.stdin)
except Exception: print('registry /api/health?deep=1 返回非 JSON——服务可能半死'); sys.exit(0)
msgs=[]
for d in h.get('degraded',[]):
    if '能力策略不变量告警' in d: continue   # 已知且已在面板显示，不重复刷
    msgs.append(d)
fleet=h.get('fleet',{})
# 不用 readyCount==0 blanket 告警——campaign/巡探期间设备被 lease 会让 readyCount=0 但并非掉线。
# 真问题（offline/quarantined）由下面 per-device 检查覆盖。
notready=[d for d in fleet.get('notReady',[]) if d.get('alias')!='03']
for d in notready:
    if d.get('reason') in ('quarantined','offline'): msgs.append('%s 处于 %s（03 之外的设备掉线/隔离）' % (d['alias'], d['reason']))
ap=h.get('approvals',{})
if not ap.get('humanTokenEnforced'): msgs.append('registry 跑在 LEGACY 鉴权模式——审批闸未生效，需带 --human-token 重装任务')
if ap.get('pendingCount',0)>0: msgs.append('有 %d 个待人工审批任务' % ap['pendingCount'])
for m in msgs: print(m)
"

# sync-feishu 最近轮次失败（尾部 40 行内出现 ROUND FAIL）
if [ -f "$SYNC_LOG" ] && tail -40 "$SYNC_LOG" | grep -q "ROUND FAIL"; then
  echo "sync-feishu 最近有 ROUND FAIL：$(tail -40 "$SYNC_LOG" | grep 'ROUND FAIL' | tail -1)"
fi
