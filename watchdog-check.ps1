# watchdog-check.ps1 - outer keep-alive for Adventure Guild (fix-004)
# Called by scheduled task "AdventureGuildWatchdog" every 5 minutes:
#   - watchdog process dead   -> relaunch watchdog.mjs
#   - service port offline    -> relaunch watchdog.mjs (it boots the service)
# Idempotent: watchdog.mjs has a PID-file single-instance lock, so no double-spawn.
$ErrorActionPreference = 'SilentlyContinue'
# APP_DIR contains CJK chars; build from codepoints so this file stays pure ASCII
# (PowerShell 5.1 misreads UTF-8-no-BOM as GBK and garbles inline CJK literals)
$APP_DIR = -join ([char]0x5192, [char]0x9669, [char]0x516C, [char]0x4F1A)  # = D:\冒险公会
$APP_DIR = 'D:\' + $APP_DIR
$PORT_FILE = Join-Path $APP_DIR 'watchdog.pid'
$WATCH_LOG = Join-Path $APP_DIR 'watchdog.log'
# node absolute path (QClaw bundled node, same source as current watchdog)
$NODE = 'C:\Program Files\QClaw\v0.2.37.630\resources\node\node.exe'
if (-not (Test-Path $NODE)) { $NODE = 'node' }

# read configured port from config.json (strip BOM)
$cfgPath = Join-Path $env:USERPROFILE '.adventure-guild\config.json'
$port = 8765
if (Test-Path $cfgPath) {
    try {
        $raw = [System.IO.File]::ReadAllText($cfgPath).TrimStart([char]0xFEFF)
        $cfg = $raw | ConvertFrom-Json
        if ($cfg.server.port) { $port = [int]$cfg.server.port }
    } catch {}
}

function Write-Log($msg) {
    $t = Get-Date -Format 'yyyy/M/d HH:mm:ss'
    $line = "[$t] [keepalive] $msg"
    Add-Content -Path $WATCH_LOG -Value $line -Encoding UTF8
}

function Test-PortUp($p) {
    try {
        $c = New-Object Net.Sockets.TcpClient
        $iar = $c.BeginConnect('127.0.0.1', $p, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(2000, $false)
        if ($ok -and $c.Connected) { $c.Close(); return $true }
        $c.Close(); return $false
    } catch { return $false }
}

function Test-WatchdogAlive {
    if (-not (Test-Path $PORT_FILE)) { return $false }
    $wdPid = 0
    try { $wdPid = [int](Get-Content $PORT_FILE -Raw).Trim() } catch { return $false }
    if ($wdPid -le 0) { return $false }
    $proc = Get-Process -Id $wdPid -ErrorAction SilentlyContinue
    if (-not $proc) { return $false }
    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$wdPid").CommandLine
    return ($cmd -match 'watchdog')
}

$svcUp = Test-PortUp $port
$wdAlive = Test-WatchdogAlive

if ($svcUp) {
    # service up: only refill watchdog if it died (new watchdog probes and stays)
    if (-not $wdAlive) {
        Write-Log "service up (port $port) but watchdog missing - relaunching watchdog"
        Start-Process -FilePath $NODE -ArgumentList 'watchdog.mjs' -WorkingDirectory $APP_DIR -WindowStyle Hidden
    }
} else {
    # service down
    if ($wdAlive) {
        Write-Log "service down (port $port) but watchdog alive - watchdog will relaunch it"
    } else {
        Write-Log "service down (port $port) and watchdog missing - relaunching watchdog (it boots service)"
        Start-Process -FilePath $NODE -ArgumentList 'watchdog.mjs' -WorkingDirectory $APP_DIR -WindowStyle Hidden
    }
}
