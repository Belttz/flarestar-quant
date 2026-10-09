@echo off
REM 星闪量化 Gate CrossEx - one-click deployment for Windows.
REM Double-click this file. It bootstraps a private Node.js runtime, installs
REM dependencies, builds the app, and starts the terminal in the background.
REM (Script bodies stay ASCII-only on purpose: cmd.exe mis-decodes non-ASCII
REM  batch files. All Chinese guidance is printed by deploy.ps1, which is UTF-8 BOM.)
chcp 65001 >nul
setlocal
set "PS1=%~dp0deploy.ps1"
if not exist "%PS1%" (
  echo [ERROR] deploy.ps1 was not found next to this launcher.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" install %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo [FAILED] exit code %CODE% - see the messages above.
  pause
)
exit /b %CODE%
