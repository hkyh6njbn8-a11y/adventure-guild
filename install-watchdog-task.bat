@echo off
rem ============================================================
rem install-watchdog-task.bat - register AdventureGuildWatchdog
rem scheduled task (opt-017: switch to VBS wrapper, no console flash)
rem
rem Runs watchdog-check.vbs every 5 minutes (and at logon):
rem   wscript.exe is a GUI-subsystem host -> no black console flash
rem   (previously powershell.exe flashed a window every 5 min)
rem The vbs internally launches powershell hidden (window style 0).
rem
rem Uninstall: schtasks /Delete /TN AdventureGuildWatchdog /F
rem Run once : schtasks /Run /TN AdventureGuildWatchdog
rem Query    : schtasks /Query /TN AdventureGuildWatchdog
rem ============================================================
setlocal
cd /d "%~dp0"

echo [1/3] Removing old task (if exists)...
schtasks /Delete /TN AdventureGuildWatchdog /F >nul 2>&1

echo [2/3] Creating task via wscript VBS wrapper (every 5 min + logon trigger)...
schtasks /Create /TN AdventureGuildWatchdog /TR "wscript.exe \"%~dp0watchdog-check.vbs\"" /SC MINUTE /MO 5 /F

echo [3/3] Triggering one check now...
schtasks /Run /TN AdventureGuildWatchdog

echo.
echo Done. Status: schtasks /Query /TN AdventureGuildWatchdog
echo Uninstall: schtasks /Delete /TN AdventureGuildWatchdog /F
endlocal
