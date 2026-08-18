param(
    [string]$ConfigPath = "$PSScriptRoot\..\config\local.psd1",
    [switch]$SkipLark
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dataDir = Join-Path $projectRoot "data"
$rawDir = Join-Path $dataDir "device_inventory"
$assetCsv = Join-Path $dataDir "phone-assets.csv"

if (!(Test-Path -LiteralPath $ConfigPath)) {
    throw "找不到本地配置。请复制 config/devices.example.psd1 为 config/local.psd1 后填写。"
}
$config = Import-PowerShellDataFile -LiteralPath $ConfigPath
if (!$config.AdbPath) { throw "配置缺少 AdbPath" }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Collect-PhoneAssets.ps1") -AdbPath $config.AdbPath -OutputDir $rawDir -OpenXhsProfile
if ($LASTEXITCODE -ne 0) { throw "手机资产采集失败" }

Import-Csv -LiteralPath (Join-Path $rawDir "devices.csv") -Encoding UTF8 | ForEach-Object {
    $deviceNumber = $config.Devices[$_.serial]
    if (!$deviceNumber) { $deviceNumber = $_.serial }
    [pscustomobject][ordered]@{
        "设备编号" = $deviceNumber
        "ADB序列号" = $_.serial
        "手机型号" = $_.model
        "品牌" = $_.brand
        "Android版本" = $_.androidVersion
        "安全补丁" = $_.securityPatch
        "分辨率" = $_.resolution
        "屏幕密度" = $_.density
        "电量" = $_.batteryLevel
        "WLAN地址" = $_.wlanIp
        "小红书版本" = $_.xhsVersion
        "小红书昵称" = $_.xhsNickname
        "小红书号" = $_.xhsPublicId
        "IP属地" = $_.xhsIpRegion
        "关注数" = $_.xhsFollowing
        "粉丝数" = $_.xhsFollowers
        "获赞与收藏" = $_.xhsLikesFavorites
        "公开笔记" = $_.xhsPublicPosts
        "私密笔记" = $_.xhsPrivatePosts
        "合集数" = $_.xhsCollections
        "主页资料" = $_.xhsProfileDetails
        "页面结构已采集" = $_.profileDetected
        "采集时间" = $_.collectedAt
    }
} | Export-Csv -LiteralPath $assetCsv -NoTypeInformation -Encoding UTF8

if (!$SkipLark) {
    if (!$config.BaseToken -or !$config.TableId) { throw "同步飞书需要配置 BaseToken 和 TableId" }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Sync-LarkBase.ps1") -BaseToken $config.BaseToken -TableId $config.TableId -InventoryCsv $assetCsv
    if ($LASTEXITCODE -ne 0) { throw "飞书同步失败" }
}

Write-Host "完成：数据保存在 $dataDir"
