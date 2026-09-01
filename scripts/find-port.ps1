# find-port.ps1 — 冒险公会端口自动分配
# 读取配置端口（默认8765），被占则+1递增，找到后写回配置。输出端口号，失败输出ERROR。

$cfg = Join-Path $env:USERPROFILE '.adventure-guild\config.json'
$port = 8765

if (Test-Path $cfg) {
    try {
        $j = Get-Content $cfg -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($j.server.port) { $port = [int]$j.server.port }
    } catch {}
}

$max = $port + 20
while ($port -lt $max) {
    $inUse = $false
    try {
        $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
        if ($c) { $inUse = $true }
    } catch {}
    if (-not $inUse) { break }
    $port++
}

if ($port -ge $max) {
    Write-Output 'ERROR'
    exit 1
}

# 写回配置（最佳努力）
try {
    $dir = Split-Path $cfg
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    if (Test-Path $cfg) {
        $obj = Get-Content $cfg -Raw -Encoding UTF8 | ConvertFrom-Json
    } else {
        $obj = New-Object PSObject
    }
    if (-not ($obj.PSObject.Properties.Name -contains 'server')) {
        $obj | Add-Member -NotePropertyName server -NotePropertyValue (New-Object PSObject) -Force
    }
    if ($obj.server.PSObject.Properties.Name -contains 'port') {
        $obj.server.port = $port
    } else {
        $obj.server | Add-Member -NotePropertyName port -NotePropertyValue $port -Force
    }
    $obj | ConvertTo-Json -Depth 10 | Set-Content $cfg -Encoding UTF8
} catch {}

Write-Output $port
