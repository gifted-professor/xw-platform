$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

$powerShellFiles = Get-ChildItem -LiteralPath $PSScriptRoot -Filter "*.ps1"
foreach ($file in $powerShellFiles) {
    [void][scriptblock]::Create((Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8))
    Write-Host "PowerShell syntax OK: $($file.Name)"
}

Push-Location $projectRoot
try {
    npm run check
    if ($LASTEXITCODE -ne 0) { throw "Node syntax check failed" }
} finally {
    Pop-Location
}

Write-Host "Project checks passed"
