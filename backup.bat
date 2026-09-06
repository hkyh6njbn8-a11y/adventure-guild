@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

rem 冒险公会数据备份脚本
rem 用法: backup.bat [目标目录] [保留份数]
rem   目标目录  可选，默认 %~dp0backups；也可用环境变量 GUILD_BACKUP_DIR
rem   保留份数  可选，默认 10，超出自动删最旧的
rem 备份 memory.db(+wal/shm) + config.json 到 <目标目录>\YYYYMMDD_HHMMSS\

set "DATA_DIR=%USERPROFILE%\.adventure-guild"
set "BACKUP_DIR=%~dp0backups"
if defined GUILD_BACKUP_DIR set "BACKUP_DIR=%GUILD_BACKUP_DIR%"
if not "%~1"=="" set "BACKUP_DIR=%~1"
set "KEEP=10"
if not "%~2"=="" set "KEEP=%~2"

if not exist "%DATA_DIR%\data\memory.db" (
  echo [错误] 未找到数据库: %DATA_DIR%\data\memory.db
  echo 请先运行 start.bat 启动一次系统以生成数据目录。
  pause
  exit /b 1
)

if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"

rem Win11 已移除 wmic，改用 PowerShell 取时间戳（旧 wmic 写法在 26200+ 必失败）
set "STAMP="
for /f %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "STAMP=%%a"
if not defined STAMP (
  echo [错误] 无法生成时间戳（PowerShell 不可用？）
  pause
  exit /b 1
)

set "DEST=%BACKUP_DIR%\%STAMP%"
mkdir "%DEST%"

copy /Y "%DATA_DIR%\data\memory.db" "%DEST%\memory.db" >nul
if exist "%DATA_DIR%\data\memory.db-wal" copy /Y "%DATA_DIR%\data\memory.db-wal" "%DEST%\" >nul
if exist "%DATA_DIR%\data\memory.db-shm" copy /Y "%DATA_DIR%\data\memory.db-shm" "%DEST%\" >nul
if exist "%DATA_DIR%\config.json" copy /Y "%DATA_DIR%\config.json" "%DEST%\config.json" >nul

echo [完成] 已备份到: %DEST%
dir /b "%DEST%"

rem ---- 保留最近 KEEP 份，删除更旧的备份目录 ----
set /a COUNT=0
for /f "delims=" %%d in ('dir /b /ad /o-n "%BACKUP_DIR%" 2^>nul') do (
  set /a COUNT+=1
  if !COUNT! GTR %KEEP% (
    echo [清理] 删除旧备份: %%d
    rd /s /q "%BACKUP_DIR%\%%d"
  )
)

echo.
echo 恢复方法: 关闭服务后，将备份目录中的文件复制回 %DATA_DIR%\ 对应位置。
pause
