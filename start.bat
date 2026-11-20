@echo off
title Physics Workbench
cd /d %~dp0

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js first.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: installing dependencies, please wait...
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. Check your network and retry.
    pause
    exit /b 1
  )
)

netstat -ano | findstr /c:":5173" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo Server is already running. Opening page...
  start http://localhost:5173
  exit /b 0
)

echo Starting dev server. Browser will open automatically...
start "" cmd /c "timeout /t 4 >nul & start http://localhost:5173"
call npm run dev
