#!/bin/bash
# 03 PnP 物理在位哨兵——人重插后系统自动感知（Hermes cron 托管，无 LLM 成本）
# 静默即正常：只有 absent→present 翻转（或翻回）才输出，Hermes cron 空输出不发声。
set -u
STATE=/Users/a1234/Desktop/Coding/xhs-registry/runtime/pnp-state.json
TOKEN=REDACTED_OLD_AGENT_TOKEN
SERIAL_03=211d0120
mkdir -p "$(dirname "$STATE")"
[ -f "$STATE" ] || echo '{"present":null}' > "$STATE"

prev=$(/usr/bin/python3 -c "import json;print(json.load(open('$STATE')).get('present'))" 2>/dev/null)

# 只读查 Windows PnP：03 的 serial 是否作为 present 设备枚举到
out=$(ssh -o ConnectTimeout=15 xhs-windows "powershell -NoProfile -NonInteractive -Command \"(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object InstanceId -like '*$SERIAL_03*' | Measure-Object).Count\"" 2>/dev/null | tr -d ' \r\n')
case "$out" in
  ''|*[!0-9]*) exit 0 ;;   # 查询失败：静默退出，不误报
esac
if [ "$out" -gt 0 ]; then cur=True; else cur=False; fi

/usr/bin/python3 -c "
import json
json.dump({'present': $cur}, open('$STATE','w'))
"

[ "$cur" = "$prev" ] && exit 0

if [ "$cur" = "True" ]; then
  echo "03 PnP 已枚举到（absent → present）：可以启动 03 恢复管线 campaign/recover-03.md"
  ssh -o ConnectTimeout=10 xhs-windows "curl.exe -s -m 10 -X POST -H \"x-registry-token: $TOKEN\" -H \"content-type: application/json\" -d \"{\\\"id\\\":\\\"xianyu-03-pnp-present-$(date +%Y%m%d%H%M)\\\",\\\"app\\\":\\\"xianyu\\\",\\\"category\\\":\\\"unknown\\\",\\\"lifecycle\\\":\\\"probe_unknown\\\",\\\"title\\\":\\\"03 PnP 重新枚举到，待跑恢复管线\\\",\\\"content\\\":\\\"哨兵检测到 03 从 absent 变 present，下一步：recovery inspect -> 视觉分类 -> main-safe 零动作 recover -> open/full dry-run\\\"}\" http://127.0.0.1:17930/api/knowledge" >/dev/null 2>&1
else
  [ "$prev" = "None" ] || echo "03 PnP 掉线（present → absent）：物理连接又断了"
fi
