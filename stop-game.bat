@echo off
title DrawGuess Stop
echo Stopping DrawGuess server (port 3000)...
set "KILLED=0"
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":3000" ^| findstr "LISTENING"') do (
  taskkill /PID %%a /F >nul 2>&1
  if not errorlevel 1 set "KILLED=1"
)
if "%KILLED%"=="1" ( echo Stopped. ) else ( echo No running server found on port 3000. )
pause
