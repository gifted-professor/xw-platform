param(
    [string]$AdbPath = "D:\download\lvjian\tools\adb.exe",
    [string]$OutputDir = "$PSScriptRoot\..\data\device_inventory",
    [switch]$OpenXhsProfile
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Invoke-Adb {
    param(
        [string]$Serial,
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    $output = & $AdbPath -s $Serial @Arguments 2>$null
    $ErrorActionPreference = $previousPreference
    $output
}

function Get-Prop {
    param([string]$Serial, [string]$Name)
    (Invoke-Adb $Serial shell getprop $Name | Out-String).Trim()
}

function Get-FirstMatch {
    param([string]$Text, [string]$Pattern)
    $match = [regex]::Match($Text, $Pattern, [System.Text.RegularExpressions.RegexOptions]::Multiline)
    if ($match.Success) { return $match.Groups[1].Value.Trim() }
    return $null
}

function Get-UiSummary {
    param([string]$XmlPath)
    if (!(Test-Path -LiteralPath $XmlPath)) { return @() }
    try {
        [xml]$doc = Get-Content -Raw -Encoding UTF8 -LiteralPath $XmlPath
        $items = foreach ($node in $doc.SelectNodes("//node")) {
            $label = if ($node.text) { [string]$node.text } elseif ($node.'content-desc') { [string]$node.'content-desc' } else { $null }
            if ($label) {
                [PSCustomObject]@{
                    text      = $label
                    bounds    = [string]$node.bounds
                    clickable = [string]$node.clickable
                    class     = [string]$node.class
                }
            }
        }
        return @($items)
    } catch {
        return @()
    }
}

function Save-UiHierarchy {
    param([string]$Serial, [string]$LocalPath, [string]$RemotePath = "/sdcard/codex_inventory_window.xml")
    Invoke-Adb $Serial shell uiautomator dump $RemotePath | Out-Null
    Invoke-Adb $Serial pull $RemotePath $LocalPath | Out-Null
    Test-Path -LiteralPath $LocalPath
}

function Get-SemanticTapPoint {
    param([string]$XmlPath, [string]$Label)
    if (!(Test-Path -LiteralPath $XmlPath)) { return $null }
    try {
        [xml]$doc = Get-Content -Raw -Encoding UTF8 -LiteralPath $XmlPath
        $candidates = @($doc.SelectNodes("//node") | Where-Object {
            $_.text -eq $Label -or $_.'content-desc' -eq $Label
        } | Sort-Object { if ($_.'clickable' -eq 'true') { 0 } else { 1 } })
        foreach ($node in $candidates) {
            if ([string]$node.bounds -match '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$') {
                return [PSCustomObject]@{
                    x = [math]::Round(([int]$matches[1] + [int]$matches[3]) / 2)
                    y = [math]::Round(([int]$matches[2] + [int]$matches[4]) / 2)
                }
            }
        }
    } catch {}
    return $null
}

function Get-ProfileValue {
    param([string[]]$Texts, [string]$Pattern)
    foreach ($value in $Texts) {
        if ($value -match $Pattern) { return $matches[1] }
    }
    return $null
}

if (!(Test-Path -LiteralPath $AdbPath)) {
    throw "找不到 ADB：$AdbPath"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$deviceLines = & $AdbPath devices | Select-Object -Skip 1
$serials = @(
    foreach ($line in $deviceLines) {
        if ($line -match '^([^\s]+)\s+device$') { $matches[1] }
    }
)

if (!$serials.Count) { throw "没有发现在线 ADB 设备" }

$inventory = foreach ($serial in $serials) {
    Write-Host "采集设备 $serial ..."
    $deviceDir = Join-Path $OutputDir $serial
    New-Item -ItemType Directory -Force -Path $deviceDir | Out-Null

    $wmSizeText = (Invoke-Adb $serial shell wm size | Out-String).Trim()
    $wmDensityText = (Invoke-Adb $serial shell wm density | Out-String).Trim()
    $size = Get-FirstMatch $wmSizeText '(?:Physical|Override) size:\s*(\d+x\d+)'
    if (!$size) { $size = Get-FirstMatch $wmSizeText '(\d+x\d+)' }
    $density = Get-FirstMatch $wmDensityText '(?:Physical|Override) density:\s*(\d+)'
    if (!$density) { $density = Get-FirstMatch $wmDensityText '(\d+)' }

    $batteryText = Invoke-Adb $serial shell dumpsys battery | Out-String
    $ipText = Invoke-Adb $serial shell ip -f inet addr show wlan0 | Out-String
    $storageText = Invoke-Adb $serial shell df /data | Out-String
    $packageText = Invoke-Adb $serial shell dumpsys package com.xingin.xhs | Out-String
    $windowText = Invoke-Adb $serial shell dumpsys window windows | Out-String

    $xhsInstalled = $packageText -match 'Package \[com\.xingin\.xhs\]'
    $xhsVersion = Get-FirstMatch $packageText '^\s*versionName=([^\r\n]+)'

    if ($OpenXhsProfile -and $xhsInstalled) {
        Invoke-Adb $serial shell am start -n com.xingin.xhs/.index.v2.IndexActivityV2 | Out-Null
        Start-Sleep -Seconds 4

        # 每台手机和每个小红书版本布局可能不同：优先按控件语义定位“我”，坐标仅作兜底。
        $navigationXml = Join-Path $deviceDir "navigation.xml"
        Save-UiHierarchy $serial $navigationXml | Out-Null
        $tapPoint = Get-SemanticTapPoint $navigationXml '我'
        if ($tapPoint) {
            Invoke-Adb $serial shell input tap $tapPoint.x $tapPoint.y | Out-Null
        } else {
            $parts = $size -split 'x'
            if ($parts.Count -eq 2) {
                $tapX = [math]::Round([int]$parts[0] * 0.93)
                $tapY = [math]::Round([int]$parts[1] * 0.95)
                Invoke-Adb $serial shell input tap $tapX $tapY | Out-Null
            }
        }
        Start-Sleep -Seconds 3
        $windowText = Invoke-Adb $serial shell dumpsys window windows | Out-String
    }

    $remoteXml = "/sdcard/codex_inventory_window.xml"
    $remotePng = "/sdcard/codex_inventory_screen.png"
    $localXml = Join-Path $deviceDir "window.xml"
    $localPng = Join-Path $deviceDir "screen.png"

    Save-UiHierarchy $serial $localXml $remoteXml | Out-Null
    # 直接执行二进制截图与拉取，避免 PowerShell 包装函数吞掉文件输出。
    & $AdbPath -s $serial shell screencap -p $remotePng 2>$null | Out-Null
    & $AdbPath -s $serial pull $remotePng $localPng 2>$null | Out-Null

    $uiItems = Get-UiSummary $localXml
    $uiItems | Export-Csv -NoTypeInformation -Encoding UTF8 -LiteralPath (Join-Path $deviceDir "page_structure.csv")
    $visibleTexts = @($uiItems.text | Select-Object -Unique)
    $visibleTexts | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $deviceDir "visible_texts.txt")

    $xhsLabel = -join @(0x5C0F, 0x7EA2, 0x4E66, 0x53F7 | ForEach-Object { [char]$_ })
    $xhsId = @($visibleTexts | Where-Object { $_.StartsWith($xhsLabel) } | Select-Object -First 1)
    $ipRegion = @($visibleTexts | Where-Object { $_.StartsWith('IP') } | Select-Object -First 1)
    $profileDetected = [bool]$xhsId.Count
    $nickname = Get-ProfileValue $visibleTexts '^头像,(.+)$'
    $followingCount = Get-ProfileValue $visibleTexts '^(\d+)关注$'
    $followerCount = Get-ProfileValue $visibleTexts '^(\d+)粉丝$'
    $engagementCount = Get-ProfileValue $visibleTexts '^(\d+)获赞与收藏$'
    $publicPostCount = Get-ProfileValue $visibleTexts '^公开\s+(\d+)$'
    $privatePostCount = Get-ProfileValue $visibleTexts '^私密\s+(\d+)$'
    $collectionCount = Get-ProfileValue $visibleTexts '^合集\s+(\d+)$'

    $profileDetails = @()
    $metricEnd = [array]::IndexOf($visibleTexts, '获赞与收藏')
    if ($metricEnd -ge 0) {
        for ($i = $metricEnd + 1; $i -lt $visibleTexts.Count; $i++) {
            if ($visibleTexts[$i] -like '小组件*' -or $visibleTexts[$i] -eq '头图or头视频区容器') { break }
            if ($visibleTexts[$i] -ne '点击这里，填写简介') { $profileDetails += $visibleTexts[$i] }
        }
    }

    $result = [PSCustomObject]@{
        collectedAt       = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        serial            = $serial
        manufacturer      = Get-Prop $serial 'ro.product.manufacturer'
        brand             = Get-Prop $serial 'ro.product.brand'
        model             = Get-Prop $serial 'ro.product.model'
        product           = Get-Prop $serial 'ro.product.name'
        device            = Get-Prop $serial 'ro.product.device'
        androidVersion    = Get-Prop $serial 'ro.build.version.release'
        sdk               = Get-Prop $serial 'ro.build.version.sdk'
        securityPatch     = Get-Prop $serial 'ro.build.version.security_patch'
        buildFingerprint  = Get-Prop $serial 'ro.build.fingerprint'
        resolution        = $size
        density           = $density
        batteryLevel      = Get-FirstMatch $batteryText '^\s*level:\s*(\d+)'
        batteryTemperature= Get-FirstMatch $batteryText '^\s*temperature:\s*(\d+)'
        wlanIp            = Get-FirstMatch $ipText 'inet\s+([0-9.]+)'
        dataStorage       = ($storageText.Trim() -replace '\r?\n', ' | ')
        xhsInstalled      = $xhsInstalled
        xhsVersion        = $xhsVersion
        currentFocus      = Get-FirstMatch $windowText 'mCurrentFocus=.*?\s([A-Za-z0-9._]+/[A-Za-z0-9.$_]+)'
        profileDetected   = $profileDetected
        xhsNickname       = $nickname
        xhsPublicId       = if ($xhsId.Count) { $xhsId[0] -replace '^.*?[:：]\s*', '' } else { $null }
        xhsIpRegion       = if ($ipRegion.Count) { $ipRegion[0] -replace '^IP[:：]\s*', '' } else { $null }
        xhsFollowing      = $followingCount
        xhsFollowers      = $followerCount
        xhsLikesFavorites = $engagementCount
        xhsPublicPosts    = $publicPostCount
        xhsPrivatePosts   = $privatePostCount
        xhsCollections    = $collectionCount
        xhsProfileDetails = ($profileDetails | Select-Object -Unique) -join '；'
        visibleTextCount  = $visibleTexts.Count
        screenshotPath    = $localPng
        hierarchyPath     = $localXml
    }

    $result | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $deviceDir "inventory.json")
    $result
}

$inventory | Export-Csv -NoTypeInformation -Encoding UTF8 -LiteralPath (Join-Path $OutputDir "devices.csv")
$inventory | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $OutputDir "devices.json")

$inventory | Format-Table serial,model,androidVersion,resolution,xhsInstalled,xhsVersion,profileDetected,xhsPublicId -AutoSize
Write-Host "采集完成：$OutputDir"
