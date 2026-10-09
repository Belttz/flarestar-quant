@echo off
REM 星闪量化 Gate CrossEx - start the terminal in the background.
chcp 65001 >nul
setlocal
set "PS1=%~dp0deploy.ps1"
if not exist "%PS1%" (
  echo [ERROR] deploy.ps1 was not found next to this launcher.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" start %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo [FAILED] exit code %CODE% - see the messages above.
  pause
)
exit /b %CODE%
