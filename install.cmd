@echo off
setlocal
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js is not installed on this PC. Install the LTS build from
  echo   https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)
node "%~dp0install.js" %1
pause
