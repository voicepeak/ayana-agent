@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo 请先运行 scripts\bootstrap.ps1 安装依赖。
  pause
  exit /b 1
)
set "AYANA_PYTHON=%~dp0.venv\Scripts\python.exe"
if not exist "apps\desktop\dist-electron\main.cjs" (
  call npm --prefix apps/desktop run build
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
call npm --prefix apps/desktop start
