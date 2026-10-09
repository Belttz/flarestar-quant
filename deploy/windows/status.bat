@echo off
REM 星闪量化 Gate CrossEx - show whether the terminal is running.
chcp 65001 >nul
setlocal
set "PS1=%~dp0deploy.ps1"
if not exist "%PS1%" (
  echo [ERROR] deploy.ps1 was not found next to this launcher.
  pause
  exit /b 1
)
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" status %*
echo.
pause
exit /b %ERRORLEVEL%
