param(
    [string]$BaseToken = $env:LARK_BASE_TOKEN,
    [string]$TableId = $env:LARK_TABLE_ID,
    [string]$InventoryCsv = "$PSScriptRoot\..\data\phone-assets.csv"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $projectRoot
$payloadDir = Join-Path $projectRoot "data\lark_payloads"
$payloadFile = Join-Path $payloadDir "current.json"
$payloadArg = "@data/lark_payloads/current.json"
New-Item -ItemType Directory -Force -Path $payloadDir | Out-Null

if (!$BaseToken -or !$TableId) {
    throw "请通过参数或环境变量 LARK_BASE_TOKEN / LARK_TABLE_ID 提供飞书 Base Token 和 Table ID"
}

function Invoke-LarkJson {
    param([string[]]$Arguments)
    $raw = & lark-cli @Arguments 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw $raw }
    $start = $raw.IndexOf('{')
    if ($start -lt 0) { throw "lark-cli 未返回 JSON：$raw" }
    $raw.Substring($start) | ConvertFrom-Json
}

function Save-Payload {
    param($Value)
    $json = $Value | ConvertTo-Json -Depth 10 -Compress
    [System.IO.File]::WriteAllText($payloadFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

$fieldDefinitions = @(
    [ordered]@{ name = "ADB序列号"; type = "text"; description = "ADB 唯一设备标识，用于重复采集时匹配同一台手机" },
    [ordered]@{ name = "手机型号"; type = "text" },
    [ordered]@{ name = "品牌"; type = "text" },
    [ordered]@{ name = "Android版本"; type = "text" },
    [ordered]@{ name = "分辨率"; type = "text" },
    [ordered]@{ name = "屏幕密度"; type = "number"; style = [ordered]@{ type = "plain"; precision = 0; percentage = $false; thousands_separator = $false } },
    [ordered]@{ name = "WLAN地址"; type = "text"; description = "设备当前局域网地址，不包含公网 IP" },
    [ordered]@{ name = "小红书版本"; type = "text" },
    [ordered]@{ name = "小红书昵称"; type = "text" },
    [ordered]@{ name = "小红书号"; type = "text" },
    [ordered]@{ name = "IP属地"; type = "text" },
    [ordered]@{ name = "关注数"; type = "number"; style = [ordered]@{ type = "plain"; precision = 0; percentage = $false; thousands_separator = $true } },
    [ordered]@{ name = "粉丝数"; type = "number"; style = [ordered]@{ type = "plain"; precision = 0; percentage = $false; thousands_separator = $true } },
    [ordered]@{ name = "获赞与收藏"; type = "number"; style = [ordered]@{ type = "plain"; precision = 0; percentage = $false; thousands_separator = $true } },
    [ordered]@{ name = "公开笔记"; type = "number"; style = [ordered]@{ type = "plain"; precision = 0; percentage = $false; thousands_separator = $true } },
    [ordered]@{ name = "私密笔记"; type = "number"; style = [ordered]@{ type = "plain"; precision = 0; percentage = $false; thousands_separator = $true } },
    [ordered]@{ name = "合集数"; type = "number"; style = [ordered]@{ type = "plain"; precision = 0; percentage = $false; thousands_separator = $true } },
    [ordered]@{ name = "主页资料"; type = "text" },
    [ordered]@{ name = "页面结构已采集"; type = "checkbox" },
    [ordered]@{ name = "采集时间"; type = "datetime"; style = [ordered]@{ format = "yyyy-MM-dd HH:mm" } }
)

$fieldList = Invoke-LarkJson @("base", "+field-list", "--base-token", $BaseToken, "--table-id", $TableId, "--as", "user", "--format", "json")
$existingNames = @($fieldList.data.fields | ForEach-Object { $_.name })

foreach ($definition in $fieldDefinitions) {
    if ($existingNames -contains $definition.name) { continue }
    Save-Payload $definition
    $created = Invoke-LarkJson @("base", "+field-create", "--base-token", $BaseToken, "--table-id", $TableId, "--json", $payloadArg, "--as", "user", "--format", "json")
    Write-Host "已创建字段：$($created.data.field.name)"
}

$records = Invoke-LarkJson @("base", "+record-list", "--base-token", $BaseToken, "--table-id", $TableId, "--as", "user", "--limit", "100", "--format", "json")
$fieldNames = @($records.data.fields)
$recordRows = @()
for ($i = 0; $i -lt $records.data.record_id_list.Count; $i++) {
    $values = @($records.data.data[$i])
    $map = @{}
    for ($j = 0; $j -lt $fieldNames.Count; $j++) { $map[$fieldNames[$j]] = $values[$j] }
    $recordRows += [pscustomobject]@{ id = $records.data.record_id_list[$i]; values = $map; used = $false }
}

$inventory = Import-Csv -LiteralPath $InventoryCsv -Encoding UTF8
foreach ($device in $inventory) {
    $target = $recordRows | Where-Object {
        !$_.used -and ($_.values["ADB序列号"] -eq $device."ADB序列号" -or $_.values["设备编号"] -eq $device."设备编号")
    } | Select-Object -First 1
    if (!$target) {
        $target = $recordRows | Where-Object {
            !$_.used -and !$_.values["ADB序列号"] -and !$_.values["设备编号"]
        } | Select-Object -First 1
    }

    $payload = [ordered]@{
        "设备编号" = $device."设备编号"
        "ADB序列号" = $device."ADB序列号"
        "手机型号" = $device."手机型号"
        "品牌" = $device."品牌"
        "Android版本" = $device."Android版本"
        "分辨率" = $device."分辨率"
        "屏幕密度" = if ($device."屏幕密度") { [double]$device."屏幕密度" } else { $null }
        "WLAN地址" = $device."WLAN地址"
        "小红书版本" = $device."小红书版本"
        "小红书昵称" = $device."小红书昵称"
        "小红书号" = $device."小红书号"
        "IP属地" = $device."IP属地"
        "关注数" = if ($device."关注数") { [double]$device."关注数" } else { $null }
        "粉丝数" = if ($device."粉丝数") { [double]$device."粉丝数" } else { $null }
        "获赞与收藏" = if ($device."获赞与收藏") { [double]$device."获赞与收藏" } else { $null }
        "公开笔记" = if ($device."公开笔记") { [double]$device."公开笔记" } else { $null }
        "私密笔记" = if ($device."私密笔记") { [double]$device."私密笔记" } else { $null }
        "合集数" = if ($device."合集数") { [double]$device."合集数" } else { $null }
        "主页资料" = $device."主页资料"
        "页面结构已采集" = [System.Convert]::ToBoolean($device."页面结构已采集")
        "采集时间" = $device."采集时间"
    }
    Save-Payload $payload
    $args = @("base", "+record-upsert", "--base-token", $BaseToken, "--table-id", $TableId, "--json", $payloadArg, "--as", "user", "--format", "json")
    if ($target) {
        $args += @("--record-id", $target.id)
        $target.used = $true
    }
    $saved = Invoke-LarkJson $args
    Write-Host "已同步设备：$($device.'设备编号') / $($device.'小红书昵称')"
}

Write-Host "飞书多维表格同步完成"
