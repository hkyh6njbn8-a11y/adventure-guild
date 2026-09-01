@echo off
setlocal EnableDelayedExpansion
rem ============================================================
rem  Adventure Guild: Task Board — one-click launcher (自愈版)
rem  1) 看板已在运行 → 直接打开浏览器，不重复启动
rem  2) 未运行 → 清理僵尸进程 → 启动看门狗（自动守护+崩溃自愈）
rem  3) 开机自启看门狗后，日常无需再点本脚本
rem ============================================================
cd /d "%~dp0"

rem --- Locate node ---
set "NODE_CMD="
where node >nul 2>nul
if %errorlevel%==0 (
  set "NODE_CMD=node"
) else (
  echo [Adventure Guild] Node.js not found. Please install Node.js 20+: https://nodejs.org/
  pause
  exit /b 1
)

rem --- Verify better-sqlite3 ABI matches this Node; auto-repair if not ---
"%NODE_CMD%" -e "new (require('better-sqlite3'))(':memory:');process.exit(0)" >nul 2>&1
if errorlevel 1 (
  echo [Adventure Guild] better-sqlite3 does not match this Node version. Auto-reinstalling...
  call npm install better-sqlite3
  "%NODE_CMD%" -e "new (require('better-sqlite3'))(':memory:');process.exit(0)" >nul 2>&1
  if errorlevel 1 (
    echo [Adventure Guild] Auto-repair failed. Please run "npm install" manually, then retry.
    pause
    exit /b 1
  )
  echo [Adventure Guild] Dependencies repaired successfully.
)

rem --- Read current port from config (default 8765) ---
set "PORT=8765"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=Join-Path $env:USERPROFILE '.adventure-guild\config.json'; if(Test-Path $c){try{$j=Get-Content $c -Raw -Encoding UTF8|ConvertFrom-Json; if($j.server.port){$j.server.port}}catch{}}" > "%TEMP%\ag_port.txt" 2>nul
set /p PORT=<"%TEMP%\ag_port.txt"
if "%PORT%"=="" set "PORT=8765"
del "%TEMP%\ag_port.txt" >nul 2>nul

echo ============================================
echo   Adventure Guild: Task Board
echo ============================================
echo   URL: http://127.0.0.1:%PORT%

rem --- 1) Already running? Just open browser ---
powershell -NoProfile -ExecutionPolicy Bypass -Command "try{$r=Invoke-WebRequest -Uri 'http://127.0.0.1:%PORT%/api/state' -TimeoutSec 3 -UseBasicParsing; exit 0}catch{exit 1}" >nul 2>nul
if %errorlevel%==0 (
  echo   [OK] 看板已在运行，直接打开浏览器。
  start "" http://127.0.0.1:%PORT%
  exit /b 0
)

rem --- 2) Kill zombie dashboard_server processes (port may be held by dead process) ---
echo   [清理] 检查是否有残留的看板进程...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object { $_.CommandLine -like '*dashboard_server*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Output ('killed ' + $_.ProcessId) }" >nul 2>nul

rem --- 3) Start watchdog (auto-heal daemon) in background ---
echo   [启动] 看门狗已启动，将自动守护看板服务（每20秒巡检，挂了自动拉起）。
start "" /min cmd /c "cd /d %~dp0 && node watchdog.mjs"

rem --- 4) Wait for server to come up, then open browser ---
echo   [等待] 看板启动中...
for /l %%i in (1,1,30) do (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try{$r=Invoke-WebRequest -Uri 'http://127.0.0.1:%PORT%/api/state' -TimeoutSec 1 -UseBasicParsing; exit 0}catch{exit 1}" >nul 2>nul
  if !errorlevel!==0 goto up
  timeout /t 1 /nobreak >nul
)
echo   [警告] 30秒内未就绪，请查看 srv-err.log / watchdog.log。
pause
exit /b 1

:up
echo   [OK] 看板已就绪: http://127.0.0.1:%PORT%
start "" http://127.0.0.1:%PORT%
exit /b 0
