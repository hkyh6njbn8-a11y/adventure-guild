@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

rem 冒险公会数据备份脚本
rem 备份 memory.db + config.json 到 backups/ 目录，带时间戳

set "DATA_DIR=%USERPROFILE%\.adventure-guild"
set "BACKUP_DIR=%~dp0backups"

if not exist "%DATA_DIR%\data\memory.db" (
  echo [错误] 未找到数据库: %DATA_DIR%\data\memory.db
  echo 请先运行 start.bat 启动一次系统以生成数据目录。
  pause
  exit /b 1
)

if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"

for /f "tokens=2 delims==" %%a in ('wmic os get localdatetime /value') do set "DT=%%a"
set "STAMP=%DT:~0,8%_%DT:~8,6%"

set "DEST=%BACKUP_DIR%\%STAMP%"
mkdir "%DEST%"

copy /Y "%DATA_DIR%\data\memory.db" "%DEST%\memory.db" >nul
if exist "%DATA_DIR%\data\memory.db-wal" copy /Y "%DATA_DIR%\data\memory.db-wal" "%DEST%\" >nul
if exist "%DATA_DIR%\data\memory.db-shm" copy /Y "%DATA_DIR%\data\memory.db-shm" "%DEST%\" >nul
if exist "%DATA_DIR%\config.json" copy /Y "%DATA_DIR%\config.json" "%DEST%\config.json" >nul

echo [完成] 已备份到: %DEST%
dir /b "%DEST%"
echo.
echo 恢复方法: 关闭服务后，将备份目录中的文件复制回 %DATA_DIR%\ 对应位置。
pause
