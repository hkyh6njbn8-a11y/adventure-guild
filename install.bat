@echo off
chcp 65001 >nul 2>&1
setlocal

rem 冒险公会一键安装脚本
rem 检查 Node.js → 安装依赖 → 创建数据目录 → 可选迁移旧库

echo ========================================
echo   冒险公会：任务看板 - 安装向导
echo ========================================
echo.

rem 1. 检查 Node.js
where node >nul 2>&1
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js 18+
  echo 下载地址: https://nodejs.org/
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo [1/4] Node.js 版本: %%v

rem 2. 安装依赖
echo [2/4] 安装依赖（better-sqlite3）...
if not exist "node_modules" (
  call npm install
  if errorlevel 1 (
    echo [错误] npm install 失败，请检查网络或手动运行 npm install
    pause
    exit /b 1
  )
) else (
  echo       node_modules 已存在，跳过
)

rem 3. 创建数据目录
set "DATA_DIR=%USERPROFILE%\.adventure-guild\data"
if not exist "%DATA_DIR%" (
  mkdir "%DATA_DIR%"
  echo [3/4] 数据目录已创建: %DATA_DIR%
) else (
  echo [3/4] 数据目录已存在: %DATA_DIR%
)

rem 4. 可选迁移旧库
echo [4/4] 数据迁移
set /p "DO_MIGRATE=是否从旧库迁移数据？(y/N): "
if /i "%DO_MIGRATE%"=="y" (
  echo       运行迁移工具...
  node migrate\migrate_legacy.cjs
) else (
  echo       跳过迁移（首次启动会自动创建空数据库）
)

echo.
echo ========================================
echo   安装完成！运行 start.bat 启动看板
echo ========================================
pause
