$ErrorActionPreference = "Stop"
# NOTE: keep this file ASCII-only (PS 5.1 misreads UTF-8-no-BOM scripts).
# xw-runtime\current is a junction to releases\<id>; node realpaths the main module,
# so resolve the junction to the real release path before launching, otherwise
# import.meta.url != argv[1] and the server exits silently.
$rel = [string](Get-Item -LiteralPath 'C:\Users\Public\xw-runtime\current').Target
if ([string]::IsNullOrWhiteSpace($rel)) { throw "current junction unresolved" }
$env:XW_RELEASE_MANIFEST = Join-Path $rel 'release-manifest.v1.json'
$manifest = Get-Content -LiteralPath $env:XW_RELEASE_MANIFEST -Raw | ConvertFrom-Json
$env:CONTROL_PLANE_HOST = "127.0.0.1"
$env:CONTROL_PLANE_PORT = "17920"
$env:CONTROL_PLANE_DB = "C:\Users\Public\xw-runtime\state\control-plane\control.db"
$env:CONTROL_PLANE_RUNS_ROOT = "C:\Users\Public\xw-runtime\evidence"
$env:CONTROL_PLANE_DEVICES_FILE = "C:\Users\Public\xw-runtime\secrets\control-plane.devices.json"
$env:CONTROL_PLANE_EXPECTED_HOST = "DESKTOP-3I1EVHE"
$env:CONTROL_PLANE_NODE_ID = "DESKTOP-3I1EVHE"
$env:CONTROL_PLANE_NODE_VERSION = "24.11.1"
$env:CONTROL_PLANE_GIT_COMMIT = [string]$manifest.sourceCommit
$env:AUTONOMY_POLICY_MODE = "nonpayment_v1"
$env:EVIDENCE_MODE = "dual"
$env:CONTROL_PLANE_PILOT_ACTORS = '["claude-pilot-20260809"]'
$env:CONTROL_PLANE_PILOT_ALIASES = '["01","02","03","04"]'
$env:CONTROL_PLANE_LEGACY_MODE = "enforce"
$env:XHS_RECIPE_OVERLAY_MODE = "off"
$env:NODE_NO_WARNINGS = "1"
& "D:\Program Files\Node\node.exe" (Join-Path $rel 'services\control-plane\control-plane\server.mjs') serve *>> 'C:\Users\Public\xw-runtime\logs\control-plane.log'
